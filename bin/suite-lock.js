'use strict';
// Ticket 05: host-wide semaphore for configured heavy local suites. Parallel ICs
// serialize here instead of oversubscribing the host; a blocked attempt names the
// owning Work record (in its error, its stderr wait line, and `status`) so nobody
// needs a polling model turn to find out who holds the suite. The lock is a
// wx-created JSON file under state/suite/; liveness is the owning pid, never age,
// because a legitimate heavy suite runs for half an hour or more.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

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
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  let handle;
  try {
    handle = fs.openSync(file, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readOwner(file);
    if (owner === null) return null; // released between openSync and read; retry
    if (owner.corrupt || !pidAlive(Number(owner.pid))) {
      // Dead owner (or unreadable lock): break it and retry. rmSync tolerates a
      // concurrent breaker having won the race.
      fs.rmSync(file, { force: true });
      return null;
    }
    return { busy: owner };
  }
  const lock = { suite: String(suite), record: String(record), pid, at: new Date().toISOString() };
  fs.writeFileSync(handle, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  fs.closeSync(handle);
  return { lock };
}

function acquireSuiteLock(options = {}) {
  const { root, suite, record } = options;
  if (!suite || !record) throw new SuiteLockError('USAGE', 'suite and record are required');
  const pid = Number(options.pid) || process.pid;
  const wait = Boolean(options.wait);
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const pollMs = Number(options.pollMs) || DEFAULT_POLL_MS;
  const startedAt = Date.now();
  let waitedOn = null;
  let announced = false;
  for (;;) {
    const attempt = tryTakeLock(root, suite, record, pid);
    if (attempt === null) continue; // dead/corrupt/vanished lock cleared; retry now
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
    if (Date.now() - startedAt >= timeoutMs) {
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
  if (!fs.existsSync(directory)) return { held: [] };
  const held = [];
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.lock'))) {
    const owner = readOwner(path.join(directory, name));
    if (owner && !owner.corrupt) held.push({ suite: owner.suite, owner: { record: owner.record, pid: owner.pid, at: owner.at }, ownerAlive: pidAlive(Number(owner.pid)) });
  }
  return { held };
}

function runWithSuiteLock(options = {}) {
  const { root, suite, record, command } = options;
  if (!command) throw new SuiteLockError('USAGE', 'a command is required');
  acquireSuiteLock({
    root, suite, record,
    wait: options.wait !== false, timeoutMs: options.timeoutMs, pollMs: options.pollMs,
    onWait: options.onWait,
  });
  try {
    const result = spawnSync(command, options.args || [], {
      stdio: options.stdio || 'inherit', shell: Boolean(options.shell), cwd: options.cwd,
    });
    if (result.error) throw new SuiteLockError('COMMAND_FAILED', String(result.error.message || result.error));
    return result.status === null ? 1 : result.status;
  } finally {
    releaseSuiteLock({ root, suite, record });
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') { args._ = argv.slice(i + 1); break; }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    args[key] = next !== undefined && !next.startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function cli(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const common = {
    root: args.root, suite: args.suite, record: args.record,
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
