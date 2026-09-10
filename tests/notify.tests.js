'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { execFileSync, spawnSync } = require('node:child_process');
const { buildPointerMessage, validatePointerMessage, findPendingDecisions, runNotifier, isLive, spawnNotifier, cli, NOTIFY_FLAGS, NotifyError } = require('../bin/notify');
const workState = require('../bin/work-state');

function rootDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-notify-'));
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'owner/repo', readyLabel: 'ready-for-agent', defaultBranch: 'integration', releaseBranch: 'main', carveOuts: ['server/db/migrations/**'] }));
  return root;
}

let tick = 0;
function at() { tick += 1; return new Date(Date.UTC(2026, 8, 1, 6, 0, tick)).toISOString(); }

function seed(root, { issue = 42, prNumber = 77, to = 'escalated' } = {}) {
  const id = `endzone:issue-${issue}`;
  workState.createRecord({ root, id, tenant: 'endzone', issue, state: 'implementing', github: { issueNumber: issue, prNumber }, actor: 'test', idempotencyKey: `c-${issue}`, now: at() });
  let revision = 1;
  const hops = to === 'hold' ? ['pr-open', 'ci-wait', 'review', 'hold'] : ['pr-open', 'ci-wait', 'escalated'];
  let last = null;
  for (const state of hops) {
    last = workState.transitionRecord({ root, id, to: state, expectedRevision: revision, idempotencyKey: `t-${issue}-${state}`, actor: 'pr-watch', evidence: state === 'escalated' ? 'wake:decision-needed; [pr-watch] checks settled but PR #77 carries no closing linkage for issue #42' : `to ${state}`, now: at() });
    revision = last.revision;
  }
  return { id, revision, sequence: last.eventSequence };
}

function sender(outcome = { ok: true, detail: 'toast shown' }) {
  const calls = [];
  const send = (message) => { calls.push(message); return typeof outcome === 'function' ? outcome(message) : outcome; };
  send.calls = calls;
  return send;
}

const COPIED_CRITERIA = [
  '## Acceptance criteria',
  '- [ ] Rebuilding status and digest from the same event offset is byte-stable.',
  '- [ ] One decision event produces one digest item and at most one successful notification event.',
].join('\n');

test('a pointer message names the record, revision, sequence, and artifact locations without copying issue text', () => {
  const root = rootDir();
  const { id, revision, sequence } = seed(root);
  const record = workState.getRecord({ root, id });
  const decision = workState.readEvents(root).find((event) => event.recordId === id && event.sequence === sequence);
  const message = buildPointerMessage({ root, record, event: decision, tenantConfig: { github: 'owner/repo' } });
  assert.equal(message.pointer.recordId, id);
  assert.equal(message.pointer.revision, revision);
  assert.equal(message.pointer.eventSequence, sequence);
  assert.ok(message.pointer.artifacts.some((artifact) => artifact.endsWith('active.json#endzone:issue-42')));
  assert.ok(message.pointer.artifacts.some((artifact) => /state[\\/]events[\\/]\d{4}-\d{2}-\d{2}\.jsonl#seq-\d+$/.test(artifact)));
  assert.ok(message.pointer.artifacts.includes('https://github.com/owner/repo/pull/77'));
  assert.match(message.title, /endzone #42/);
  assert.match(message.body, /endzone:issue-42 r\d+ seq\d+/);
  assert.doesNotMatch(message.body, /closing linkage/, 'the evidence prose is pointed at, not copied');
  assert.deepEqual(validatePointerMessage(message), { valid: true, reasons: [] });
});

test('message fixtures: copied acceptance criteria are rejected, typed pointers accepted', () => {
  const typed = {
    title: 'Fleet decision: endzone #42', body: 'escalated - endzone:issue-42 r5 seq5 - PR #77',
    pointer: { recordId: 'endzone:issue-42', revision: 5, eventSequence: 5, artifacts: ['state/work/active.json#endzone:issue-42'] },
  };
  assert.equal(validatePointerMessage(typed).valid, true);
  const copied = validatePointerMessage({ ...typed, body: `${typed.body}\n${COPIED_CRITERIA}` });
  assert.equal(copied.valid, false);
  assert.ok(copied.reasons.some((reason) => /checklist/.test(reason)));
  assert.ok(copied.reasons.some((reason) => /acceptance criteria/i.test(reason)));
  assert.equal(validatePointerMessage({ ...typed, body: 'Acceptance Criteria copied here' }).valid, false);
  assert.equal(validatePointerMessage({ ...typed, body: `x\n${'y'.repeat(700)}` }).valid, false);
  assert.equal(validatePointerMessage({ ...typed, pointer: { ...typed.pointer, artifacts: [] } }).valid, false);
  assert.equal(validatePointerMessage({ ...typed, pointer: { recordId: 'endzone:issue-42' } }).valid, false);
  assert.equal(validatePointerMessage({ ...typed, body: 'see ```code``` block' }).valid, false);
});

test('live: one decision event pages once; repeated and concurrent notifier starts never page again', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender();
  const first = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(first.handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[id, sequence, 'sent']]);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].pointer.eventSequence, sequence);
  for (let index = 0; index < 5; index += 1) runNotifier({ root, live: true, send, now: at() });
  assert.equal(send.calls.length, 1);
  const record = workState.getRecord({ root, id });
  assert.equal(record.notifications[String(sequence)].status, 'sent');
  assert.equal(workState.readEvents(root).filter((event) => event.type === 'notification-sent').length, 1);
  // A reentrant start from inside the send (two notifiers racing) finds the claim and backs off.
  const root2 = rootDir();
  seed(root2);
  const reentrant = sender((message) => {
    const inner = runNotifier({ root: root2, live: true, send: reentrant, now: at() });
    assert.deepEqual(inner.handled, [], 'the claim is already on the record, so nothing is pending');
    return { ok: true, detail: 'ok' };
  });
  const outer = runNotifier({ root: root2, live: true, send: reentrant, now: at() });
  assert.deepEqual(outer.handled.map((h) => h.outcome), ['sent']);
  assert.equal(reentrant.calls.length, 1);
});

test('live: a failed delivery is recorded, visible, and inert until retry is authorized', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender({ ok: false, detail: 'toast api unavailable' });
  const first = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(first.handled.map((h) => h.outcome), ['failed']);
  runNotifier({ root, live: true, send, now: at() });
  runNotifier({ root, live: true, send, now: at() });
  assert.equal(send.calls.length, 1);
  let record = workState.getRecord({ root, id });
  assert.equal(record.notifications[String(sequence)].status, 'failed');
  assert.equal(record.notifications[String(sequence)].detail, 'toast api unavailable');
  workState.notifyRecord({ root, id, phase: 'authorize-retry', expectedRevision: record.revision, decisionSequence: sequence, idempotencyKey: 'auth-1', actor: 'cory', evidence: 'toast service restarted', now: at() });
  const ok = sender();
  const retried = runNotifier({ root, live: true, send: ok, now: at() });
  assert.deepEqual(retried.handled.map((h) => h.outcome), ['sent']);
  assert.equal(ok.calls.length, 1);
  record = workState.getRecord({ root, id });
  assert.equal(record.notifications[String(sequence)].attempt, 2);
  const types = workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).map((event) => event.type);
  assert.deepEqual(types, ['notification-attempted', 'notification-failed', 'notification-retry-authorized', 'notification-attempted', 'notification-sent']);
});

test('shadow (default): nothing is claimed or sent; the would-be page is logged once per decision', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender();
  assert.equal(isLive({ root }), false);
  const first = runNotifier({ root, send, now: at() });
  assert.deepEqual(first.handled.map((h) => h.outcome), ['shadow']);
  runNotifier({ root, send, now: at() });
  assert.equal(send.calls.length, 0);
  assert.equal(workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).length, 0);
  const shadow = fs.readFileSync(path.join(root, 'state', 'notify', 'shadow.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].recordId, id);
  assert.equal(shadow[0].sequence, sequence);
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'notifier-live'), '');
  assert.equal(isLive({ root }), true);
});

test('a decision resolved before the notifier ran is skipped; a hold pages like an escalation; targeting narrows the scan', () => {
  const root = rootDir();
  const resolved = seed(root, { issue: 1 });
  workState.transitionRecord({ root, id: resolved.id, to: 'ci-wait', expectedRevision: resolved.revision, idempotencyKey: 'resolve-1', actor: 'pr-watch', evidence: 'linkage restored', now: at() });
  const held = seed(root, { issue: 2, to: 'hold' });
  const other = seed(root, { issue: 3 });
  assert.deepEqual(findPendingDecisions({ root }).map((d) => [d.record.id, d.event.type]), [[held.id, 'state-hold'], [other.id, 'state-escalated']]);
  const send = sender();
  const targeted = runNotifier({ root, live: true, send, recordId: other.id, sequence: other.sequence, now: at() });
  assert.deepEqual(targeted.handled.map((h) => [h.recordId, h.outcome]), [[other.id, 'sent']]);
  const rest = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(rest.handled.map((h) => [h.recordId, h.outcome]), [[held.id, 'sent']]);
  assert.equal(send.calls.length, 2);
  assert.match(send.calls[1].body, /^hold/);
  const stale = runNotifier({ root, live: true, send, recordId: other.id, sequence: 2, now: at() });
  assert.deepEqual(stale.handled, []);
});

test('a message that fails the pointer fixture is never sent and is recorded as a failed delivery', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender();
  const run = runNotifier({ root, live: true, send, now: at(), compose: () => ({ title: 't', body: COPIED_CRITERIA, pointer: { recordId: id, revision: 1, eventSequence: sequence, artifacts: ['x'] } }) });
  assert.deepEqual(run.handled.map((h) => h.outcome), ['failed']);
  assert.equal(send.calls.length, 0);
  assert.match(workState.getRecord({ root, id }).notifications[String(sequence)].detail, /message rejected/);
});

function waitForFile(file, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

test('spawnNotifier launches one detached notifier that handles exactly the named decision event (shadow)', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const launch = spawnNotifier({ root, recordId: id, sequence });
  assert.equal(launch.spawned, true);
  const shadowFile = path.join(root, 'state', 'notify', 'shadow.jsonl');
  assert.ok(waitForFile(shadowFile), 'the detached notifier wrote its shadow line');
  const lines = fs.readFileSync(shadowFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.recordId, line.sequence]), [[id, sequence]]);
  assert.equal(workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).length, 0);
});

test('a hand-made escalation through the state CLI launches the notifier; --no-notifier does not', () => {
  const root = rootDir();
  const id = 'endzone:issue-7';
  workState.createRecord({ root, id, tenant: 'endzone', issue: 7, state: 'implementing', github: { issueNumber: 7, prNumber: 70 }, actor: 'test', idempotencyKey: 'c-7', now: at() });
  const cli = path.join(__dirname, '..', 'bin', 'work-state.js');
  const run = (extra) => execFileSync(process.execPath, [cli, 'transition', '--root', root, '--id', id, '--to', 'escalated', '--expected-revision', '1', '--idempotency-key', 'cli-esc', '--actor', 'pl-endzone', '--evidence', 'needs Cory', ...extra], { encoding: 'utf8' });
  const quiet = rootDir();
  workState.createRecord({ root: quiet, id, tenant: 'endzone', issue: 7, state: 'implementing', actor: 'test', idempotencyKey: 'c-7', now: at() });
  execFileSync(process.execPath, [cli, 'transition', '--root', quiet, '--id', id, '--to', 'escalated', '--expected-revision', '1', '--idempotency-key', 'cli-esc', '--actor', 'pl-endzone', '--evidence', 'needs Cory', '--no-notifier'], { encoding: 'utf8' });
  const out = JSON.parse(run([]));
  assert.equal(out.record.state, 'escalated');
  assert.equal(out.notifier?.spawned, true);
  assert.ok(waitForFile(path.join(root, 'state', 'notify', 'shadow.jsonl')), 'the CLI-made decision launched a notifier');
  assert.equal(fs.existsSync(path.join(quiet, 'state', 'notify', 'shadow.jsonl')), false);
});

test('a notifier that cannot be launched is a visible failed delivery, not silence', async () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const launch = spawnNotifier({ root, recordId: id, sequence, node: path.join(root, 'no-such-node.exe') });
  assert.equal(launch.spawned, true, 'a missing executable only surfaces asynchronously');
  const started = Date.now();
  let record = workState.getRecord({ root, id });
  while (Date.now() - started < 8000 && record.notifications?.[String(sequence)]?.status !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, 50));   // the spawn error needs the event loop
    record = workState.getRecord({ root, id });
  }
  const entry = record.notifications[String(sequence)];
  assert.equal(entry.status, 'failed');
  assert.match(entry.detail, /notifier launch failed/);
  const types = workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).map((event) => event.type);
  assert.deepEqual(types, ['notification-attempted', 'notification-failed']);
});

// --- fleet#4: notify refuses unknown flags ---------------------------------
// notify.js has one command (`notify`, the whole binary - there is no
// subcommand word); before this a typo'd flag fell into a bucket nothing
// reads and the sweep silently ran with that option missing. `--id` and
// `--decision-sequence` are `work-state.js notify`'s names for the same two
// things this binary calls `--record`/`--sequence` - the confusable pair
// fleet#2 warned about, this time between two commands in the same repo
// rather than two repos.
//
// Red-tell: with the bin change stashed, every case below either fails to
// throw (the old parseArgs(argv) with no schema accepts anything) or throws
// a plain Error/WorkStateError instead of a NotifyError with code USAGE.
// Refs #4.

function notifyRoot() {
  const root = rootDir();
  return root;
}

function refusesUsage(argv, fragment) {
  assert.throws(() => cli(argv), (error) => {
    assert.ok(error instanceof NotifyError, `expected NotifyError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.code, 'USAGE');
    if (fragment) assert.match(error.message, fragment);
    return true;
  });
}

test('notify: --id (work-state.js notify command name) is refused as an unknown flag, not read as no target', () => {
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  const activeBefore = fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8');
  const eventsBefore = workState.readEvents(root);
  refusesUsage(['--root', root, '--id', id, '--sequence', String(sequence), '--live'], /unknown flag --id/);
  assert.equal(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8'), activeBefore, 'the record file is untouched by a refused invocation');
  assert.deepEqual(workState.readEvents(root), eventsBefore, 'no event, including a notification-failed, is appended for a refusal');
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'shadow.jsonl')), false);
});

test('notify: --decision-sequence (work-state.js notify command name) is refused as an unknown flag', () => {
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  refusesUsage(['--root', root, '--record', id, '--decision-sequence', String(sequence)], /unknown flag --decision-sequence/);
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'shadow.jsonl')), false, 'a refused invocation never runs the shadow sweep either');
});

test('notify: the unknown-flag refusal names the accepted set', () => {
  assert.throws(() => cli(['--root', notifyRoot(), '--nope', 'x']), (error) => {
    for (const flag of NOTIFY_FLAGS.notify) assert.match(error.message, new RegExp(`--${flag}\\b`));
    assert.equal(error.flag, 'nope');
    assert.deepEqual(error.accepted, NOTIFY_FLAGS.notify);
    return true;
  });
});

test('notify: a correct invocation through cli() still runs the shadow sweep unchanged', () => {
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  const result = cli(['--root', root]);
  assert.deepEqual(result.handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[id, sequence, 'shadow']]);
  const shadow = fs.readFileSync(path.join(root, 'state', 'notify', 'shadow.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].recordId, id);
  assert.equal(workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).length, 0);
});

test('notify: a targeted correct invocation through cli() passes --record/--sequence/--dry-run through to runNotifier unharmed', () => {
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  const result = cli(['--root', root, '--record', id, '--sequence', String(sequence), '--dry-run']);
  assert.deepEqual(result.handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[id, sequence, 'shadow']]);
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'notify.log.jsonl')), false, '--dry-run reached runNotifier: the sweep log was never written');
});

test('notify: the process exits 2 on a refusal and writes the refusal to stderr, no JSON answer on stdout', () => {
  const bin = path.join(__dirname, '..', 'bin', 'notify.js');
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  const typo = spawnSync(process.execPath, [bin, '--root', root, '--id', id, '--sequence', String(sequence)], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 2);
  assert.equal(typo.stdout, '');
  const err = JSON.parse(typo.stderr);
  assert.equal(err.code, 'USAGE');
  assert.match(err.message, /unknown flag --id/);
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'shadow.jsonl')), false);
  const ok = execFileSync(process.execPath, [bin, '--root', root], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(ok).handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[id, sequence, 'shadow']]);
});
