'use strict';
// Ticket 05: host-wide semaphore for configured heavy local suites. Parallel ICs
// serialize here instead of oversubscribing the host; a blocked attempt names the
// owning Work record (in its error, its stderr wait line, and `status`) so nobody
// needs a polling model turn to find out who holds the suite. The lock is a JSON
// file under state/suite/ created atomically with its full payload (temp write +
// hard link), so no reader ever sees a half-written lock; liveness is the owning
// pid, never age, because a legitimate heavy suite runs for half an hour or more.
// An unreadable lock (a foreign writer) is broken only after a grace window.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workState = require('./work-state');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const CORRUPT_GRACE_MS = 5 * 1000;

class SuiteLockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SuiteLockError';
    this.code = code;
    Object.assign(this, details);
  }
}

function lockDir(root) {
  return path.join(path.resolve(root || DEFAULT_ROOT), 'state', 'suite');
}

function safeSuiteName(suite) {
  const safe = String(suite).replace(/[^a-zA-Z0-9_.-]/g, '_');
  if (!safe.replace(/[_.]/g, '')) throw new SuiteLockError('INVALID_SUITE', `unusable suite name '${suite}'`);
  return safe;
}

function lockFile(root, suite) {
  return path.join(lockDir(root), `${safeSuiteName(suite)}.lock`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM means the process exists but we may not signal it: alive.
    return error.code === 'EPERM';
  }
}

function readOwner(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM-tolerant, like assignment.js readFixture
  try { return JSON.parse(text); } catch { return { corrupt: true }; }
}

function sleepBriefly(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function tryTakeLock(root, suite, record, pid) {
  const file = lockFile(root, suite);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = { suite: String(suite), record: String(record), pid, at: new Date().toISOString() };
  const temporary = `${file}.${pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  try {
    // linkSync is atomic and fails EEXIST if the lock exists, so the lock file
    // appears with its full payload - no zero-byte window for a peer to misread.
    fs.linkSync(temporary, file);
    fs.rmSync(temporary, { force: true });
    return { lock };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (error.code !== 'EEXIST') throw error;
  }
  const owner = readOwner(file);
  if (owner === null) return null; // released between link attempt and read; retry
  if (owner.corrupt) {
    // A foreign or damaged lock. Give a slow writer a grace window before breaking it.
    let ageMs = 0;
    try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { return null; }
    if (ageMs > CORRUPT_GRACE_MS) {
      fs.rmSync(file, { force: true });
      return null;
    }
    return { busy: { record: 'unknown (unreadable lock)', pid: null, at: null } };
  }
  if (!pidAlive(Number(owner.pid))) {
    // Dead owner: break the lock and retry. rmSync tolerates a concurrent
    // breaker having won the race.
    fs.rmSync(file, { force: true });
    return null;
  }
  return { busy: owner };
}

function acquireSuiteLock(options = {}) {
  const { root, suite, record } = options;
  if (!suite || !record) throw new SuiteLockError('USAGE', 'suite and record are required');
  const pid = Number(options.pid) || process.pid;
  const wait = Boolean(options.wait);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && options.timeoutMs !== undefined
    ? Number(options.timeoutMs) : (options.timeoutMs === Infinity ? Infinity : DEFAULT_TIMEOUT_MS);
  const pollMs = Number(options.pollMs) || DEFAULT_POLL_MS;
  const startedAt = Date.now();
  let waitedOn = null;
  let announced = false;
  const timedOut = () => timeoutMs !== Infinity && Date.now() - startedAt >= timeoutMs;
  for (;;) {
    const attempt = tryTakeLock(root, suite, record, pid);
    if (attempt === null) {
      // Cleared a dead/vanished lock; retry soon, but stay bounded.
      if (timedOut()) throw new SuiteLockError('SUITE_BUSY', `timed out waiting for suite '${suite}'`, { owner: waitedOn, timedOut: true });
      sleepBriefly(10);
      continue;
    }
    if (attempt.lock) return { acquired: true, lock: attempt.lock, waitedOn };
    const owner = attempt.busy;
    if (!wait) {
      throw new SuiteLockError('SUITE_BUSY', `suite '${suite}' is held by ${owner.record}`, { owner });
    }
    if (!announced) {
      announced = true;
      waitedOn = { record: owner.record, pid: owner.pid, at: owner.at };
      if (options.onWait) options.onWait(owner);
    }
    if (timedOut()) {
      throw new SuiteLockError('SUITE_BUSY', `timed out waiting for suite '${suite}' held by ${owner.record}`, { owner, timedOut: true });
    }
    sleepBriefly(pollMs);
  }
}

function releaseSuiteLock(options = {}) {
  const { root, suite, record } = options;
  if (!suite) throw new SuiteLockError('USAGE', 'suite is required');
  const file = lockFile(root, suite);
  const owner = readOwner(file);
  if (owner === null) return { released: false, reason: 'not-held' };
  if (!options.force && !owner.corrupt && String(owner.record) !== String(record)) {
    throw new SuiteLockError('NOT_OWNER', `suite '${suite}' is held by ${owner.record}, not ${record}`, { owner });
  }
  fs.rmSync(file, { force: true });
  return { released: true, owner: owner.corrupt ? null : owner };
}

function suiteStatus(options = {}) {
  const { root, suite } = options;
  if (suite) {
    const owner = readOwner(lockFile(root, suite));
    if (owner === null) return { suite, held: false };
    if (owner.corrupt) return { suite, held: true, owner: null, corrupt: true };
    return { suite, held: true, owner: { record: owner.record, pid: owner.pid, at: owner.at }, ownerAlive: pidAlive(Number(owner.pid)) };
  }
  const directory = lockDir(root);
  if (!fs.existsSync(directory)) return { locks: [] };
  const locks = [];
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.lock'))) {
    const owner = readOwner(path.join(directory, name));
    if (owner && !owner.corrupt) locks.push({ suite: owner.suite, owner: { record: owner.record, pid: owner.pid, at: owner.at }, ownerAlive: pidAlive(Number(owner.pid)) });
  }
  return { locks };
}

function windowsQuote(argument) {
  if (!/[\s"]/.test(argument)) return argument;
  return `"${String(argument).replace(/"/g, '\\"')}"`;
}

function spawnSuite(command, args, options) {
  const spawnOptions = { stdio: options.stdio || 'inherit', shell: Boolean(options.shell), cwd: options.cwd };
  let result = spawnSync(command, args, spawnOptions);
  if (result.error && result.error.code === 'ENOENT' && process.platform === 'win32' && !spawnOptions.shell) {
    // npm/npx and friends are .cmd shims on Windows; CreateProcess does no
    // PATHEXT resolution, so fall back to the shell with conservative quoting.
    const line = [command, ...args].map(windowsQuote).join(' ');
    result = spawnSync(line, [], { ...spawnOptions, shell: true });
  }
  return result;
}

function runWithSuiteLock(options = {}) {
  const { root, suite, record, command } = options;
  if (!command) throw new SuiteLockError('USAGE', 'a command is required');
  acquireSuiteLock({
    root, suite, record,
    wait: options.wait !== false,
    // A run waits as long as the queue in front of it needs; two full sweeps is
    // longer than the fixed acquire default, so `run` has no timeout unless set.
    timeoutMs: options.timeoutMs === undefined ? Infinity : options.timeoutMs,
    pollMs: options.pollMs,
    onWait: options.onWait,
  });
  try {
    const result = spawnSuite(command, options.args || [], options);
    if (result.error) throw new SuiteLockError('COMMAND_FAILED', String(result.error.message || result.error));
    return result.status === null ? 1 : result.status;
  } finally {
    try {
      releaseSuiteLock({ root, suite, record });
    } catch (error) {
      // Never mask the suite result: a broken/retaken lock is reported, not thrown.
      process.stderr.write(`suite-lock release warning: ${error.code || ''} ${error.message}\n`);
    }
  }
}

function cli(argv) {
  const [command, ...rest] = argv;
  const args = workState.parseArgs(rest);
  const common = {
    root: args.root, suite: args.suite, record: args.record,
    pid: args.pid ? Number(args.pid) : undefined,
    wait: args.wait === 'true', timeoutMs: args['timeout-ms'] && Number(args['timeout-ms']),
    pollMs: args['poll-ms'] && Number(args['poll-ms']),
    onWait: (owner) => process.stderr.write(`waiting: suite '${args.suite}' is held by ${owner.record} (pid ${owner.pid}, since ${owner.at})\n`),
  };
  if (command === 'acquire') return acquireSuiteLock(common);
  if (command === 'release') return releaseSuiteLock({ root: args.root, suite: args.suite, record: args.record, force: args.force === 'true' });
  if (command === 'status') return suiteStatus({ root: args.root, suite: args.suite });
  if (command === 'run') {
    const [runCommand, ...runArgs] = args._;
    const code = runWithSuiteLock({ ...common, wait: args.wait !== 'false', command: runCommand, args: runArgs, shell: args.shell === 'true' });
    process.exitCode = code;
    return { exitCode: code };
  }
  throw new SuiteLockError('USAGE', 'commands: acquire, release, status, run -- <command...>');
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message, owner: error.owner || null })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SuiteLockError,
  acquireSuiteLock,
  releaseSuiteLock,
  runWithSuiteLock,
  suiteStatus,
};
