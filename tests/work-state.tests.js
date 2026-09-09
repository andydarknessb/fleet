const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WorkStateError,
  createRecord,
  getRecord,
  notifyRecord,
  projectStatus,
  readEvents,
  reserveRecord,
  shadowProject,
  transitionRecord,
} = require('../bin/work-state');

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-work-state-'));
}

function makeRecord(root, overrides = {}) {
  return createRecord({
    root,
    id: 'endzone:issue-42',
    tenant: 'endzone',
    issue: 42,
    state: 'assigned',
    github: { issueNumber: 42, prNumber: 77 },
    actor: 'test',
    idempotencyKey: 'create-42',
    now: '2026-09-01T00:00:00.000Z',
    ...overrides,
  });
}

function move(root, id, fromRevision, to, key, evidence, now, killPoint) {
  return transitionRecord({
    root, id, expectedRevision: fromRevision, to, idempotencyKey: key,
    evidence, actor: 'test', now, killPoint,
    githubState: to === 'merged' ? 'MERGED' : undefined,
    githubMergedAt: to === 'merged' ? now : undefined,
    testOnly: to === 'merged',
  });
}

test('state command validates the full lifecycle and escalation resolution', () => {
  const root = rootDir();
  makeRecord(root);
  move(root, 'endzone:issue-42', 1, 'implementing', 't-1', 'assignment acknowledged', '2026-09-01T00:00:01.000Z');
  move(root, 'endzone:issue-42', 2, 'pr-open', 't-2', 'PR #77 opened', '2026-09-01T00:00:02.000Z');
  move(root, 'endzone:issue-42', 3, 'ci-wait', 't-3', 'CI pending', '2026-09-01T00:00:03.000Z');
  move(root, 'endzone:issue-42', 4, 'review', 't-4', 'CI settled', '2026-09-01T00:00:04.000Z');
  move(root, 'endzone:issue-42', 5, 'escalated', 't-5', 'Cory decision required', '2026-09-01T00:00:05.000Z');
  const resolved = move(root, 'endzone:issue-42', 6, 'review', 't-6', 'Cory approved review', '2026-09-01T00:00:06.000Z');
  move(root, 'endzone:issue-42', 7, 'hold', 't-7', 'clean PR requires Cory merge', '2026-09-01T00:00:07.000Z');
  move(root, 'endzone:issue-42', 8, 'merged', 't-8', 'GitHub merge evidence', '2026-09-01T00:00:08.000Z');
  move(root, 'endzone:issue-42', 9, 'retiring', 't-9', 'retirement started', '2026-09-01T00:00:09.000Z');
  move(root, 'endzone:issue-42', 10, 'retired', 't-10', 'evidence archived', '2026-09-01T00:00:10.000Z');

  assert.equal(resolved.record.state, 'review');
  assert.throws(() => move(root, 'endzone:issue-42', 10, 'assigned', 'bad', 'invalid', '2026-09-01T00:00:11.000Z'), (error) => error.code === 'NOT_FOUND');
  assert.ok(fs.existsSync(path.join(root, 'state', 'archive', 'work-endzone_issue-42.json')));
  assert.equal(fs.existsSync(path.join(root, 'state', 'work', 'active.json')), true);
});

test('invalid transitions and stale revisions are explicit conflicts', () => {
  const root = rootDir();
  makeRecord(root);
  assert.throws(() => move(root, 'endzone:issue-42', 1, 'review', 'bad-transition', 'no', '2026-09-01T00:00:01.000Z'), (error) => error.code === 'INVALID_TRANSITION');
  move(root, 'endzone:issue-42', 1, 'implementing', 'good', 'ok', '2026-09-01T00:00:02.000Z');
  assert.throws(() => move(root, 'endzone:issue-42', 1, 'pr-open', 'stale', 'old', '2026-09-01T00:00:03.000Z'), (error) => error.code === 'STALE_REVISION');
});

test('PR identity can be attached at pr-open and merge requires reconciliation', () => {
  const root = rootDir();
  makeRecord(root, { github: { issueNumber: 42 } });
  const opened = transitionRecord({
    root, id: 'endzone:issue-42', expectedRevision: 1, to: 'implementing',
    idempotencyKey: 'start', evidence: 'ack', actor: 'test', now: '2026-09-01T00:00:01.000Z',
  });
  const pr = transitionRecord({
    root, id: 'endzone:issue-42', expectedRevision: opened.revision, to: 'pr-open',
    idempotencyKey: 'pr', evidence: 'PR opened', prNumber: 77, actor: 'test', now: '2026-09-01T00:00:02.000Z',
  });
  assert.equal(pr.record.github.prNumber, 77);
  const ci = move(root, 'endzone:issue-42', pr.revision, 'ci-wait', 'ci', 'pending', '2026-09-01T00:00:03.000Z');
  const review = move(root, 'endzone:issue-42', ci.revision, 'review', 'review', 'settled', '2026-09-01T00:00:04.000Z');
  assert.throws(() => transitionRecord({
    root, id: 'endzone:issue-42', expectedRevision: review.revision, to: 'merged',
    idempotencyKey: 'merge-without-github', evidence: 'merged', actor: 'test', now: '2026-09-01T00:00:03.000Z',
  }), (error) => error.code === 'MISSING_GITHUB_RECONCILIATION');
});

test('idempotency replay returns the original revision and event', () => {
  const root = rootDir();
  const first = makeRecord(root);
  const replay = makeRecord(root);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, first.revision);
  const moved = move(root, first.record.id, 1, 'implementing', 'same-transition', 'ack', '2026-09-01T00:00:01.000Z');
  const movedAgain = move(root, first.record.id, 1, 'implementing', 'same-transition', 'ack', '2026-09-01T00:01:00.000Z');
  assert.equal(movedAgain.replayed, true);
  assert.equal(movedAgain.eventSequence, moved.eventSequence);
  const events = fs.readFileSync(path.join(root, 'state', 'events', '2026-09-01.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.equal(events.length, 2);
});

test('twenty compare-and-swap attempts yield one winner and nineteen conflicts', () => {
  const root = rootDir();
  makeRecord(root);
  const results = [];
  for (let i = 0; i < 20; i += 1) {
    try {
      results.push(move(root, 'endzone:issue-42', 1, 'implementing', `attempt-${i}`, 'ack', `2026-09-01T00:00:${String(i + 1).padStart(2, '0')}.000Z`));
    } catch (error) {
      results.push(error);
    }
  }
  assert.equal(results.filter((result) => !(result instanceof Error)).length, 1);
  assert.equal(results.filter((result) => result instanceof WorkStateError && result.code === 'STALE_REVISION').length, 19);
  const events = fs.readFileSync(path.join(root, 'state', 'events', '2026-09-01.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.equal(events.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records['endzone:issue-42'].revision, 2);
});

test('cross-process mutex serializes concurrent compare-and-swap attempts', async () => {
  const root = rootDir();
  makeRecord(root);
  const modulePath = path.resolve(__dirname, '..', 'bin', 'work-state.js');
  const script = (index) => `const m=require(${JSON.stringify(modulePath)});try{m.transitionRecord({root:${JSON.stringify(root)},id:'endzone:issue-42',expectedRevision:1,to:'implementing',idempotencyKey:'proc-${index}',evidence:'ack',actor:'test',now:'2026-09-01T00:00:01.000Z'});process.stdout.write('ok')}catch(e){process.stdout.write(e.code||'error')}`;
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => new Promise((resolve) => {
    setTimeout(() => {
      const child = spawn(process.execPath, ['-e', script(index)], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('close', () => resolve(output));
    }, index * 2);
  })));
  assert.equal(results.filter((result) => result === 'ok').length, 1);
  assert.equal(results.filter((result) => result === 'STALE_REVISION').length, 19);
  const events = fs.readFileSync(path.join(root, 'state', 'events', '2026-09-01.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.equal(events.length, 2);
});

test('pending journals recover kill points between replacement and append', () => {
  const root = rootDir();
  assert.throws(() => makeRecord(root, { killPoint: 'after-journal' }), (error) => error.code === 'KILL_POINT');
  const journalRecovered = getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(journalRecovered.revision, 1);
  assert.equal(fs.readFileSync(path.join(root, 'state', 'events', '2026-09-01.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1);

  const replacementRoot = rootDir();
  assert.throws(() => makeRecord(replacementRoot, { killPoint: 'after-record' }), (error) => error.code === 'KILL_POINT');
  const recovered = getRecord({ root: replacementRoot, id: 'endzone:issue-42' });
  assert.equal(recovered.revision, 1);
  assert.equal(fs.readFileSync(path.join(replacementRoot, 'state', 'events', '2026-09-01.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1);

  assert.throws(() => move(replacementRoot, recovered.id, 1, 'implementing', 'kill-event', 'ack', '2026-09-01T00:00:01.000Z', 'after-event'), /stopped after event append/);
  const moved = getRecord({ root: replacementRoot, id: recovered.id });
  assert.equal(moved.state, 'implementing');
  assert.equal(fs.readdirSync(path.join(replacementRoot, 'state', 'work', 'pending')).length, 0);
});

test('shadow projection is idempotent and does not mutate the legacy roster', () => {
  const root = rootDir();
  const rosterPath = path.join(root, 'state', 'roster.json');
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  const roster = { sessions: [
    { name: 'ic-548', role: 'ic', tenant: 'endzone', issue: 548, status: 'active', sessionId: 's548', parent: 'pl-endzone' },
    { name: 'ic-550', role: 'ic', tenant: 'endzone', issue: 550, status: 'retiring', sessionId: 's550', parent: 'pl-endzone' },
    { name: 'dispatcher', role: 'dispatcher', status: 'active', issue: 0 },
  ] };
  fs.writeFileSync(rosterPath, JSON.stringify(roster));
  const first = shadowProject({ root, rosterPath, now: '2026-09-01T00:00:00.000Z' });
  const second = shadowProject({ root, rosterPath, now: '2026-09-01T00:01:00.000Z' });
  assert.equal(first.projected.length, 2);
  assert.equal(first.projected.find((record) => record.issue === 550).state, 'retiring');
  assert.equal(second.projected.length, 2);
  assert.equal(second.projected[0].revision, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(rosterPath, 'utf8')), roster);
});

test('shadow projection reconciles roster retirement and removal', () => {
  const root = rootDir();
  const rosterPath = path.join(root, 'state', 'roster.json');
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  fs.writeFileSync(rosterPath, JSON.stringify({ sessions: [
    { name: 'ic-548', role: 'ic', tenant: 'endzone', issue: 548, status: 'active', sessionId: 's548' },
    { name: 'ic-550', role: 'ic', tenant: 'endzone', issue: 550, status: 'active', sessionId: 's550' },
  ] }));
  shadowProject({ root, rosterPath, now: '2026-09-01T00:00:00.000Z' });
  fs.writeFileSync(rosterPath, JSON.stringify({ sessions: [
    { name: 'ic-548', role: 'ic', tenant: 'endzone', issue: 548, status: 'retiring', sessionId: 's548' },
  ] }));
  const result = shadowProject({ root, rosterPath, now: '2026-09-01T00:01:00.000Z' });
  assert.equal(result.projected.length, 1);
  assert.equal(result.projected[0].state, 'retiring');
  const active = JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8'));
  assert.deepEqual(Object.keys(active.records), ['endzone:issue-548']);
  assert.equal(fs.existsSync(path.join(root, 'state', 'archive', 'work-endzone_issue-550.json')), true);
});

test('status projection rebuilds deterministically and retirement cleans ephemeral material', () => {
  const root = rootDir();
  const settings = path.join(root, 'state', 'sessions', 'ic-42.settings.json');
  const brief = path.join(root, 'state', 'tmp', 'brief-42.txt');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(settings, '{}');
  fs.writeFileSync(brief, 'brief');
  makeRecord(root, { settingsPath: settings, briefPath: brief });
  move(root, 'endzone:issue-42', 1, 'implementing', 't-1', 'ack', '2026-09-01T00:00:01.000Z');
  const statusPath = path.join(root, 'state', 'status', 'endzone.md');
  const first = projectStatus({ root, tenant: 'endzone', output: statusPath, now: '2026-09-01T12:00:00.000Z' });
  fs.rmSync(statusPath);
  const second = projectStatus({ root, tenant: 'endzone', output: statusPath, now: '2026-09-01T12:00:00.000Z' });
  assert.equal(first.content, second.content);
  move(root, 'endzone:issue-42', 2, 'pr-open', 't-2', 'PR #77', '2026-09-01T00:00:02.000Z');
  move(root, 'endzone:issue-42', 3, 'ci-wait', 't-3', 'CI', '2026-09-01T00:00:03.000Z');
  move(root, 'endzone:issue-42', 4, 'review', 't-4', 'review', '2026-09-01T00:00:04.000Z');
  move(root, 'endzone:issue-42', 5, 'merged', 't-5', 'merged', '2026-09-01T00:00:05.000Z');
  move(root, 'endzone:issue-42', 6, 'retiring', 't-6', 'retiring', '2026-09-01T00:00:06.000Z');
  move(root, 'endzone:issue-42', 7, 'retired', 't-7', 'retired', '2026-09-01T00:00:07.000Z');
  assert.equal(fs.existsSync(settings), false);
  assert.equal(fs.existsSync(brief), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'archive', 'work-endzone_issue-42.json')), true);
});

test('old event partitions move to the archive after thirty days, once the ledger is verified', () => {
  const root = rootDir();
  makeRecord(root, { now: '2026-07-01T00:00:00.000Z' });
  const old = path.join(root, 'state', 'events', '2026-07-01.jsonl');
  assert.equal(fs.existsSync(old), true);
  getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(fs.existsSync(old), true, 'ticket 09: no verified ledger, no archival');
  // A fresh passing verdict from bin/verify-events.js permits the move.
  fs.mkdirSync(path.join(root, 'state', 'verify'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'verify', 'last.json'), JSON.stringify({ pass: true, at: new Date().toISOString() }));
  getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(fs.existsSync(path.join(root, 'state', 'events', 'archive', '2026-07-01.jsonl')), true);
});

// Ticket 05: review recording through the one state door.
const { recordReview } = require('../bin/work-state');

function seedToReview(root) {
  makeRecord(root);
  move(root, 'endzone:issue-42', 1, 'implementing', 'r-1', 'ack', '2026-09-01T01:00:01.000Z');
  move(root, 'endzone:issue-42', 2, 'pr-open', 'r-2', 'PR #77', '2026-09-01T01:00:02.000Z');
  move(root, 'endzone:issue-42', 3, 'ci-wait', 'r-3', 'CI pending', '2026-09-01T01:00:03.000Z');
  move(root, 'endzone:issue-42', 4, 'review', 'r-4', 'CI settled', '2026-09-01T01:00:04.000Z');
  return 5;
}

test('a formal review is recorded on a record in review state, with the artifact referenced from the event', () => {
  const root = rootDir();
  const revision = seedToReview(root);
  const result = recordReview({
    root, id: 'endzone:issue-42', expectedRevision: revision,
    idempotencyKey: 'rev-1', actor: 'project-lead', now: '2026-09-01T01:00:05.000Z',
    review: { kind: 'formal', headSha: 'abc1234', artifact: 'state/reviews/endzone_issue-42/formal-001.json', tier: 'normal', triggers: [] },
  });
  assert.equal(result.replayed, false);
  assert.equal(result.record.review.progress, 'formal-recorded');
  assert.equal(result.record.review.formal.headSha, 'abc1234');
  assert.equal(result.record.review.formal.artifact, 'state/reviews/endzone_issue-42/formal-001.json');
  const events = fs.readFileSync(path.join(root, 'state', 'events', '2026-09-01.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const reviewEvent = events.find((event) => event.type === 'review-recorded');
  assert.ok(reviewEvent, 'review-recorded event exists');
  assert.equal(reviewEvent.changes.artifact, 'state/reviews/endzone_issue-42/formal-001.json');
  assert.equal(reviewEvent.changes.kind, 'formal');
});

test('a formal review outside the review state is refused; a risk review is allowed pre-PR-ready', () => {
  const root = rootDir();
  makeRecord(root);
  move(root, 'endzone:issue-42', 1, 'implementing', 'r-1', 'ack', '2026-09-01T01:00:01.000Z');
  assert.throws(
    () => recordReview({
      root, id: 'endzone:issue-42', expectedRevision: 2, idempotencyKey: 'rev-x', actor: 'project-lead',
      review: { kind: 'formal', headSha: 'abc', artifact: 'state/reviews/x.json' },
    }),
    (error) => error.code === 'INVALID_REVIEW_STATE',
  );
  const risk = recordReview({
    root, id: 'endzone:issue-42', expectedRevision: 2, idempotencyKey: 'rev-risk', actor: 'ic-42',
    now: '2026-09-01T01:00:02.000Z',
    review: { kind: 'risk', headSha: 'abc', artifact: 'state/reviews/endzone_issue-42/risk-001.json', tier: 'high-risk', triggers: ['carve-out'] },
  });
  assert.equal(risk.record.review.risk.artifact, 'state/reviews/endzone_issue-42/risk-001.json');
  assert.equal(risk.record.review.progress, 'risk-recorded');
});

test('review recording is idempotent and revision-guarded', () => {
  const root = rootDir();
  const revision = seedToReview(root);
  const review = { kind: 'formal', headSha: 'abc1234', artifact: 'state/reviews/a.json' };
  const first = recordReview({ root, id: 'endzone:issue-42', expectedRevision: revision, idempotencyKey: 'rev-1', actor: 'pl', now: '2026-09-01T01:00:05.000Z', review });
  const replay = recordReview({ root, id: 'endzone:issue-42', expectedRevision: revision, idempotencyKey: 'rev-1', actor: 'pl', now: '2026-09-01T01:00:06.000Z', review });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, first.revision);
  assert.throws(
    () => recordReview({ root, id: 'endzone:issue-42', expectedRevision: revision, idempotencyKey: 'rev-2', actor: 'pl', review }),
    (error) => error.code === 'STALE_REVISION',
  );
  assert.throws(
    () => recordReview({ root, id: 'endzone:issue-42', expectedRevision: first.revision, idempotencyKey: 'rev-3', actor: 'pl', review: { kind: 'nonsense', headSha: 'a', artifact: 'b' } }),
    (error) => error.code === 'INVALID_REVIEW_KIND',
  );
  assert.throws(
    () => recordReview({ root, id: 'endzone:issue-42', expectedRevision: first.revision, idempotencyKey: 'rev-4', actor: 'pl', review: { kind: 'formal', headSha: '', artifact: '' } }),
    (error) => error.code === 'MISSING_REVIEW_EVIDENCE',
  );
});

test('a risk review records in the pre-PR-ready states (implementing, revision, pr-open) and nowhere later', () => {
  const root = rootDir();
  makeRecord(root);
  move(root, 'endzone:issue-42', 1, 'implementing', 'k-1', 'ack', '2026-09-01T04:00:01.000Z');
  move(root, 'endzone:issue-42', 2, 'pr-open', 'k-2', 'PR #77', '2026-09-01T04:00:02.000Z');
  move(root, 'endzone:issue-42', 3, 'ci-wait', 'k-3', 'CI', '2026-09-01T04:00:03.000Z');
  assert.throws(
    () => recordReview({
      root, id: 'endzone:issue-42', expectedRevision: 4, idempotencyKey: 'k-risk-ci', actor: 'ic-42',
      review: { kind: 'risk', headSha: 'abc', artifact: 'state/reviews/x.json' },
    }),
    (error) => error.code === 'INVALID_REVIEW_STATE',
  );
  move(root, 'endzone:issue-42', 4, 'review', 'k-4', 'settled', '2026-09-01T04:00:04.000Z');
  move(root, 'endzone:issue-42', 5, 'revision', 'k-5', 'returned', '2026-09-01T04:00:05.000Z');
  const inRevision = recordReview({
    root, id: 'endzone:issue-42', expectedRevision: 6, idempotencyKey: 'k-risk-rev', actor: 'ic-42',
    now: '2026-09-01T04:00:06.000Z',
    review: { kind: 'risk', headSha: 'abc', artifact: 'state/reviews/endzone_issue-42/risk-001.json', tier: 'high-risk', triggers: ['auth'] },
  });
  assert.equal(inRevision.record.review.risk.headSha, 'abc');
});

// Ticket 07: the notification door. Delivery state lives on the record and in
// typed events; claim-before-send is what makes "at most one page" hold across
// concurrent notifier starts.
function escalate(root) {
  makeRecord(root);
  move(root, 'endzone:issue-42', 1, 'implementing', 't-1', 'ack', '2026-09-01T05:00:01.000Z');
  move(root, 'endzone:issue-42', 2, 'pr-open', 't-2', 'PR #77', '2026-09-01T05:00:02.000Z');
  move(root, 'endzone:issue-42', 3, 'ci-wait', 't-3', 'CI', '2026-09-01T05:00:03.000Z');
  return move(root, 'endzone:issue-42', 4, 'escalated', 't-4', 'wake:decision-needed; [pr-watch] no closing linkage', '2026-09-01T05:00:04.000Z');
}

function notify(root, phase, revision, decisionSequence, extra = {}) {
  return notifyRecord({
    root, id: 'endzone:issue-42', phase, expectedRevision: revision, decisionSequence,
    idempotencyKey: `n-${phase}-${decisionSequence}-${revision}`, actor: 'notifier', channel: 'toast',
    now: `2026-09-01T06:00:0${revision}.000Z`, ...extra,
  });
}

test('one decision event yields one claim and one notification-sent; repeats and later claims are refused', () => {
  const root = rootDir();
  const escalated = escalate(root);
  assert.equal(escalated.eventSequence, 5);
  const claimed = notify(root, 'claim', escalated.revision, 5);
  assert.equal(claimed.record.notifications['5'].status, 'claimed');
  assert.equal(claimed.record.notifications['5'].attempt, 1);
  assert.throws(() => notify(root, 'claim', claimed.revision, 5), { code: 'NOTIFICATION_ALREADY_CLAIMED' });
  const sent = notify(root, 'sent', claimed.revision, 5, { detail: 'toast delivered' });
  assert.equal(sent.record.notifications['5'].status, 'sent');
  assert.throws(() => notify(root, 'sent', sent.revision, 5), { code: 'NOTIFICATION_ALREADY_SENT' });
  assert.throws(() => notify(root, 'claim', sent.revision, 5), { code: 'NOTIFICATION_ALREADY_SENT' });
  assert.throws(() => notify(root, 'authorize-retry', sent.revision, 5, { evidence: 'cory said so' }), { code: 'NOTIFICATION_NOT_FAILED' });
  const events = readEvents(root).filter((event) => event.recordId === 'endzone:issue-42' && event.type.startsWith('notification-'));
  assert.deepEqual(events.map((event) => event.type), ['notification-attempted', 'notification-sent']);
  assert.equal(events[1].changes.decisionSequence, 5);
  assert.equal(events[1].changes.channel, 'toast');
  const replay = notify(root, 'sent', claimed.revision, 5, { detail: 'toast delivered' });
  assert.equal(replay.replayed, true);
});

test('a failed notification stays visible and never re-pages without explicit retry authorization', () => {
  const root = rootDir();
  const escalated = escalate(root);
  const claimed = notify(root, 'claim', escalated.revision, 5);
  const failed = notify(root, 'failed', claimed.revision, 5, { detail: 'toast api unavailable' });
  assert.equal(failed.record.notifications['5'].status, 'failed');
  assert.equal(failed.record.notifications['5'].detail, 'toast api unavailable');
  assert.throws(() => notify(root, 'claim', failed.revision, 5), { code: 'NOTIFICATION_RETRY_REQUIRES_AUTHORIZATION' });
  assert.throws(() => notify(root, 'authorize-retry', failed.revision, 5), { code: 'MISSING_DECISION_EVIDENCE' });
  const authorized = notify(root, 'authorize-retry', failed.revision, 5, { actor: 'cory', evidence: 'retry after toast service restart' });
  assert.equal(authorized.record.notifications['5'].retryAuthorized, true);
  const second = notify(root, 'claim', authorized.revision, 5);
  assert.equal(second.record.notifications['5'].attempt, 2);
  assert.equal(second.record.notifications['5'].retryAuthorized, false);
  assert.throws(() => notify(root, 'claim', second.revision, 5), { code: 'NOTIFICATION_ALREADY_CLAIMED' });
  const types = readEvents(root).filter((event) => event.type.startsWith('notification-')).map((event) => event.type);
  assert.deepEqual(types, ['notification-attempted', 'notification-failed', 'notification-retry-authorized', 'notification-attempted']);
});

test('a claim needs a decision event whose state the record still occupies', () => {
  const root = rootDir();
  const escalated = escalate(root);
  assert.throws(() => notify(root, 'claim', escalated.revision, 4), { code: 'NOT_A_DECISION_EVENT' });
  assert.throws(() => notify(root, 'claim', escalated.revision, 99), { code: 'NOT_A_DECISION_EVENT' });
  assert.throws(() => notify(root, 'sent', escalated.revision, 5), { code: 'NOTIFICATION_NOT_CLAIMED' });
  const resolved = move(root, 'endzone:issue-42', escalated.revision, 'ci-wait', 't-5', 'linkage restored', '2026-09-01T05:00:05.000Z');
  assert.throws(() => notify(root, 'claim', resolved.revision, 5), { code: 'DECISION_RESOLVED' });
  const held = (() => {
    move(root, 'endzone:issue-42', resolved.revision, 'review', 't-6', 'settled', '2026-09-01T05:00:06.000Z');
    return move(root, 'endzone:issue-42', resolved.revision + 1, 'hold', 't-7', 'carve-out needs Cory', '2026-09-01T05:00:07.000Z');
  })();
  const claimed = notify(root, 'claim', held.revision, held.eventSequence);
  assert.equal(claimed.record.notifications[String(held.eventSequence)].status, 'claimed');
  assert.equal(claimed.record.notifications['5'], undefined);
});

test('twenty concurrent claims for one decision event produce exactly one claim', () => {
  const root = rootDir();
  const escalated = escalate(root);
  let wins = 0;
  const conflicts = new Set();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      notifyRecord({ root, id: 'endzone:issue-42', phase: 'claim', expectedRevision: escalated.revision, decisionSequence: 5, idempotencyKey: `claim-${attempt}`, actor: `notifier-${attempt}`, channel: 'toast' });
      wins += 1;
    } catch (error) { conflicts.add(error.code); }
  }
  assert.equal(wins, 1);
  assert.deepEqual([...conflicts].sort(), ['STALE_REVISION']);
  const record = getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(record.notifications['5'].attempt, 1);
  assert.equal(readEvents(root).filter((event) => event.type === 'notification-attempted').length, 1);
});

// Ticket 09 (amendment 10): retirement cleanup can only ever reach state/sessions and
// state/tmp. A record pointing its settings or brief at a user-owned file elsewhere
// (h.tmp, bin/memory-link-audit.js) leaves that file untouched.
test('retirement cleanup never removes a file outside state/sessions and state/tmp', () => {
  const root = rootDir();
  const userOwned = path.join(root, 'h.tmp');
  const stray = path.join(root, 'bin', 'memory-link-audit.js');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(userOwned, 'user-owned');
  fs.writeFileSync(stray, 'user-owned');
  makeRecord(root, { settingsPath: userOwned, briefPath: stray });
  move(root, 'endzone:issue-42', 1, 'implementing', 'u-1', 'ack', '2026-09-01T00:00:01.000Z');
  for (const [revision, to] of [[2, 'pr-open'], [3, 'review'], [4, 'merged'], [5, 'retiring'], [6, 'retired']]) {
    transitionRecord({ root, id: 'endzone:issue-42', expectedRevision: revision, to, idempotencyKey: `u-${to}`, now: '2026-09-01T00:00:02.000Z', prNumber: 77, githubState: 'MERGED', githubMergedAt: '2026-09-01T00:00:02.000Z', testOnly: true });
  }
  assert.equal(fs.existsSync(userOwned), true, 'h.tmp survives retirement');
  assert.equal(fs.existsSync(stray), true, 'bin/memory-link-audit.js survives retirement');
});

// 02/03 cutover: a manifest-reserved record is not the roster projector's (its
// evidence is the manifest), so the projector never retired it: after two or three
// merged assignments the planner's active-assignment count would refuse every
// launch. Once the IC has left the roster and the record is merged or retiring,
// the projector completes the retirement; an in-flight record without a roster
// row is left for the lead to judge.
test('shadow projection retires a merged manifest record once its IC has left the roster, and leaves an in-flight one alone', () => {
  const root = rootDir();
  const rosterPath = path.join(root, 'state', 'roster.json');
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  const manifestPath = path.join(root, 'state', 'manifests', 'assignment-endzone-issue-600.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, '{}');
  for (const issue of [600, 601]) {
    reserveRecord({ root, id: `endzone:issue-${issue}`, tenant: 'endzone', issue, manifestPath, reservations: {}, idempotencyKey: `reserve-${issue}`, now: '2026-09-04T00:00:00.000Z' });
    transitionRecord({ root, id: `endzone:issue-${issue}`, expectedRevision: 1, to: 'implementing', idempotencyKey: `ack-${issue}`, now: '2026-09-04T00:00:01.000Z' });
  }
  for (const [revision, to] of [[2, 'pr-open'], [3, 'review'], [4, 'merged']]) {
    transitionRecord({ root, id: 'endzone:issue-600', expectedRevision: revision, to, idempotencyKey: `m-600-${to}`, now: '2026-09-04T00:00:02.000Z', prNumber: 9000, githubState: 'MERGED', githubMergedAt: '2026-09-04T00:00:02.000Z', testOnly: true });
  }
  fs.writeFileSync(rosterPath, JSON.stringify({ sessions: [
    { name: 'ic-600', role: 'ic', tenant: 'endzone', issue: 600, status: 'active', sessionId: 's600' },
    { name: 'ic-601', role: 'ic', tenant: 'endzone', issue: 601, status: 'active', sessionId: 's601' },
  ] }));
  shadowProject({ root, rosterPath, now: '2026-09-04T00:01:00.000Z' });
  assert.equal(getRecord({ root, id: 'endzone:issue-600' }).state, 'merged');
  fs.writeFileSync(rosterPath, JSON.stringify({ sessions: [] }));
  const result = shadowProject({ root, rosterPath, now: '2026-09-04T00:02:00.000Z' });
  assert.equal(result.projected.length, 0);
  const active = JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8'));
  assert.deepEqual(Object.keys(active.records), ['endzone:issue-601']);
  const archived = JSON.parse(fs.readFileSync(path.join(root, 'state', 'archive', 'work-endzone_issue-600.json'), 'utf8'));
  assert.equal(archived.record.state, 'retired');
  const events = readEvents(root).filter((event) => event.recordId === 'endzone:issue-600');
  assert.equal(events[events.length - 1].type, 'assignment-retired');
  assert.equal(shadowProject({ root, rosterPath, now: '2026-09-04T00:03:00.000Z' }).projected.length, 0);
});

// A record the projection did not create (the lead's own `work-state.js create`, or a
// manifest reservation) used to be skipped forever: its evidence.roster never matches, so
// once merged it sat in active state and pinned its issue `reserved` in the planner's
// frontier. Four such records were found stranded in the live fleet on 2026-09-06.
test('shadow projection retires a merged record it did not create once no roster row claims it', () => {
  const root = rootDir();
  const rosterPath = path.join(root, 'state', 'roster.json');
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  fs.writeFileSync(rosterPath, JSON.stringify({ sessions: [] }));
  createRecord({ root, id: 'endzone:issue-838', tenant: 'endzone', issue: 838, state: 'implementing', idempotencyKey: 'c-838', now: '2026-09-04T00:00:00.000Z' });
  createRecord({ root, id: 'endzone:issue-799', tenant: 'endzone', issue: 799, state: 'implementing', idempotencyKey: 'c-799', now: '2026-09-04T00:00:00.000Z' });
  for (const [revision, to] of [[1, 'pr-open'], [2, 'review'], [3, 'merged']]) {
    transitionRecord({ root, id: 'endzone:issue-838', expectedRevision: revision, to, idempotencyKey: `t-838-${to}`, now: '2026-09-04T00:00:01.000Z', prNumber: 8380, githubState: 'MERGED', githubMergedAt: '2026-09-04T00:00:01.000Z', testOnly: true });
  }
  const result = shadowProject({ root, rosterPath, now: '2026-09-06T00:00:00.000Z' });
  assert.equal(result.projected.length, 0);
  const active = JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8'));
  assert.deepEqual(Object.keys(active.records), ['endzone:issue-799'], 'only the merged one is archived; the in-flight one is the lead-s to judge');
  const archived = JSON.parse(fs.readFileSync(path.join(root, 'state', 'archive', 'work-endzone_issue-838.json'), 'utf8'));
  assert.equal(archived.record.state, 'retired');
  const events = readEvents(root).filter((event) => event.recordId === 'endzone:issue-838');
  assert.equal(events[events.length - 1].type, 'shadow-retired');
});
