'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SuiteLockError,
  acquireSuiteLock,
  releaseSuiteLock,
  suiteStatus,
  runWithSuiteLock,
} = require('../bin/suite-lock');

const CLI = path.join(__dirname, '..', 'bin', 'suite-lock.js');

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-suite-lock-'));
}

test('acquire takes the semaphore and status exposes the owning Work record', () => {
  const root = rootDir();
  const result = acquireSuiteLock({ root, suite: 'test:server:sweep', record: 'endzone:issue-42' });
  assert.equal(result.acquired, true);
  const status = suiteStatus({ root, suite: 'test:server:sweep' });
  assert.equal(status.held, true);
  assert.equal(status.owner.record, 'endzone:issue-42');
  assert.equal(status.owner.pid, process.pid);
  assert.ok(status.owner.at);
});

test('a second attempt without wait reports the owning Work record and does not oversubscribe', () => {
  const root = rootDir();
  acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42' });
  assert.throws(
    () => acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-99' }),
    (error) => error instanceof SuiteLockError
      && error.code === 'SUITE_BUSY'
      && error.owner.record === 'endzone:issue-42',
  );
  // The held suite stays held by the first record.
  assert.equal(suiteStatus({ root, suite: 'sweep' }).owner.record, 'endzone:issue-42');
});

test('release frees the suite for the next attempt; a non-owner release is refused', () => {
  const root = rootDir();
  acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42' });
  assert.throws(
    () => releaseSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-99' }),
    (error) => error.code === 'NOT_OWNER' && error.owner.record === 'endzone:issue-42',
  );
  releaseSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42' });
  assert.equal(suiteStatus({ root, suite: 'sweep' }).held, false);
  const retaken = acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-99' });
  assert.equal(retaken.acquired, true);
});

test('a lock whose owning process is dead is broken and re-acquired', () => {
  const root = rootDir();
  const lockDir = path.join(root, 'state', 'suite');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'sweep.lock'), JSON.stringify({
    suite: 'sweep', record: 'endzone:issue-1', pid: 999999999, at: '2026-09-01T00:00:00.000Z',
  }), 'utf8');
  const result = acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42' });
  assert.equal(result.acquired, true);
  assert.equal(suiteStatus({ root, suite: 'sweep' }).owner.record, 'endzone:issue-42');
});

test('a corrupt lock file older than the grace window is broken, not a crash', () => {
  const root = rootDir();
  const lockDir = path.join(root, 'state', 'suite');
  fs.mkdirSync(lockDir, { recursive: true });
  const file = path.join(lockDir, 'sweep.lock');
  fs.writeFileSync(file, 'not json', 'utf8');
  const old = (Date.now() - 60 * 1000) / 1000;
  fs.utimesSync(file, old, old);
  const result = acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42' });
  assert.equal(result.acquired, true);
});

test('a fresh unreadable lock is treated as busy (a writer may be mid-write), never broken instantly', () => {
  const root = rootDir();
  const lockDir = path.join(root, 'state', 'suite');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'sweep.lock'), '', 'utf8');
  assert.throws(
    () => acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42', wait: true, timeoutMs: 400, pollMs: 100 }),
    (error) => error.code === 'SUITE_BUSY',
  );
});

test('runWithSuiteLock runs an npm command on this host (Windows .cmd shims resolve)', () => {
  const root = rootDir();
  const code = runWithSuiteLock({
    root, suite: 'unit', record: 'endzone:issue-42',
    command: 'npm', args: ['-v'], stdio: 'ignore',
  });
  assert.equal(code, 0);
  assert.equal(suiteStatus({ root, suite: 'unit' }).held, false);
});

test('a release refusal in the run cleanup never masks the suite result', () => {
  const root = rootDir();
  const lockPath = path.join(root, 'state', 'suite', 'sweep.lock');
  const script = 'const fs=require("node:fs");'
    + `fs.writeFileSync(${JSON.stringify(lockPath)},JSON.stringify({suite:"sweep",record:"endzone:issue-99",pid:process.pid,at:new Date().toISOString()}));`
    + 'process.exit(5);';
  const code = runWithSuiteLock({
    root, suite: 'sweep', record: 'endzone:issue-42',
    command: process.execPath, args: ['-e', script], stdio: 'ignore',
  });
  assert.equal(code, 5);
});

test('suite names with shell-ish characters map to safe lock files', () => {
  const root = rootDir();
  acquireSuiteLock({ root, suite: 'npm run test:server:all', record: 'endzone:issue-42' });
  const files = fs.readdirSync(path.join(root, 'state', 'suite'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-zA-Z0-9_.-]+\.lock$/);
});

test('runWithSuiteLock releases the semaphore even when the command fails', () => {
  const root = rootDir();
  const code = runWithSuiteLock({
    root, suite: 'sweep', record: 'endzone:issue-42',
    command: process.execPath, args: ['-e', 'process.exit(3)'],
  });
  assert.equal(code, 3);
  assert.equal(suiteStatus({ root, suite: 'sweep' }).held, false);
  const ok = runWithSuiteLock({
    root, suite: 'sweep', record: 'endzone:issue-42',
    command: process.execPath, args: ['-e', 'process.exit(0)'],
  });
  assert.equal(ok, 0);
});

test('two attempts serialize through the semaphore: the waiter blocks in the script, names the owner, and proceeds on release', async () => {
  const root = rootDir();
  acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42' });
  const waiter = spawn(process.execPath, [
    CLI, 'acquire', '--root', root, '--suite', 'sweep', '--record', 'endzone:issue-99',
    '--wait', '--timeout-ms', '15000', '--poll-ms', '100',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  waiter.stdout.on('data', (chunk) => { stdout += chunk; });
  waiter.stderr.on('data', (chunk) => { stderr += chunk; });
  // Give the waiter time to hit contention, then release.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.match(stderr, /endzone:issue-42/, 'the waiting attempt reports the owning Work record');
  releaseSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42' });
  const exitCode = await new Promise((resolve) => waiter.on('close', resolve));
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.acquired, true);
  assert.equal(parsed.waitedOn.record, 'endzone:issue-42');
  assert.equal(suiteStatus({ root, suite: 'sweep' }).owner.record, 'endzone:issue-99');
});

test('a waiter that times out exits nonzero and still names the owner', async () => {
  const root = rootDir();
  acquireSuiteLock({ root, suite: 'sweep', record: 'endzone:issue-42' });
  const waiter = spawn(process.execPath, [
    CLI, 'acquire', '--root', root, '--suite', 'sweep', '--record', 'endzone:issue-99',
    '--wait', '--timeout-ms', '400', '--poll-ms', '100',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  waiter.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => waiter.on('close', resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /SUITE_BUSY/);
  assert.match(stderr, /endzone:issue-42/);
  assert.equal(suiteStatus({ root, suite: 'sweep' }).owner.record, 'endzone:issue-42');
});
