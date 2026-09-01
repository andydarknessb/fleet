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
  projectStatus,
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

test('old event partitions move to the archive after thirty days', () => {
  const root = rootDir();
  makeRecord(root, { now: '2026-07-01T00:00:00.000Z' });
  const old = path.join(root, 'state', 'events', '2026-07-01.jsonl');
  assert.equal(fs.existsSync(old), true);
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
