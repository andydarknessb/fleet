const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FLAGS,
  WorkStateError,
  abandonRecord,
  cli,
  createRecord,
  getRecord,
  notifyRecord,
  projectStatus,
  proofFor,
  readEvents,
  releaseRecord,
  reservationBaseline,
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
  // fleet#44: the resolved escalation's evidence survives beside the resolution.
  assert.equal(resolved.record.decisionEvidence, null);
  assert.equal(resolved.record.resolvedDecisionEvidence, 'Cory decision required');
  assert.equal(resolved.record.resolutionEvidence, 'Cory approved review');
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

test('a direct third reservation cannot forge independence over empty active reservations', () => {
  const root = rootDir();
  reserveRecord({ root, id: 'endzone:issue-40', tenant: 'endzone', issue: 40, manifestPath: 'm40', reservations: {}, idempotencyKey: 'reserve-40', now: '2026-09-01T00:00:00.000Z' });
  reserveRecord({ root, id: 'endzone:issue-41', tenant: 'endzone', issue: 41, manifestPath: 'm41', reservations: {}, idempotencyKey: 'reserve-41', now: '2026-09-01T00:00:01.000Z' });
  const forged = { independent: true, candidates: [40, 41, 42], checkedFields: ['components', 'migrationPrefixes', 'schemaAreas', 'testResources'], conflicts: [], missingReservations: [] };

  assert.throws(
    () => reserveRecord({ root, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, manifestPath: 'm42', reservations: { components: ['src/c.js'] }, independenceProof: forged, idempotencyKey: 'reserve-42', now: '2026-09-01T00:00:02.000Z' }),
    (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF',
  );
});

test('reservation conflicts are path-aware on component segment boundaries', () => {
  const root = rootDir();
  reserveRecord({ root, id: 'endzone:issue-1146', tenant: 'endzone', issue: 1146, reservations: { components: ['src/widgets/my-team-summary/ui/MyTeamSummary.jsx'] }, idempotencyKey: 'reserve-1146', now: '2026-09-10T00:00:00.000Z' });
  assert.throws(
    () => reserveRecord({ root, id: 'endzone:issue-1150', tenant: 'endzone', issue: 1150, reservations: { components: ['src/widgets/my-team-summary'] }, idempotencyKey: 'reserve-1150', now: '2026-09-10T00:00:01.000Z' }),
    (error) => error.code === 'RESERVATION_CONFLICT' && error.conflicts[0].value === 'src/widgets/my-team-summary',
  );
  const sibling = reserveRecord({ root, id: 'endzone:issue-1151', tenant: 'endzone', issue: 1151, reservations: { components: ['src/widgets/my-team-summary-v2'] }, idempotencyKey: 'reserve-1151', now: '2026-09-10T00:00:02.000Z' });
  assert.equal(sibling.record.issue, 1151);
});

test('a third reservation accepts verified legacy reservation subjects and rejects their conflicts', () => {
  const root = rootDir();
  reserveRecord({ root, id: 'endzone:issue-40', tenant: 'endzone', issue: 40, manifestPath: 'm40', reservations: {}, idempotencyKey: 'reserve-40', now: '2026-09-01T00:00:00.000Z' });
  reserveRecord({ root, id: 'endzone:issue-41', tenant: 'endzone', issue: 41, manifestPath: 'm41', reservations: {}, idempotencyKey: 'reserve-41', now: '2026-09-01T00:00:01.000Z' });
  const proofRecords = [
    { id: 'endzone:issue-40', issue: 40, reservations: { components: ['src/a.js'] } },
    { id: 'endzone:issue-41', issue: 41, reservations: { components: ['src/b.js'] } },
  ];
  // fleet#62: the proof is bound to the reservations it was computed over, so it
  // is built by proofFor over the subjects and the candidate, never typed by hand.
  const proof = proofFor([...proofRecords, { issue: 42, reservations: { components: ['src/c.js'] } }]);
  const third = reserveRecord({ root, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, manifestPath: 'm42', reservations: { components: ['src/c.js'] }, proofRecords, independenceProof: proof, idempotencyKey: 'reserve-42', now: '2026-09-01T00:00:02.000Z' });
  assert.equal(third.record.issue, 42);

  const otherRoot = rootDir();
  reserveRecord({ root: otherRoot, id: 'endzone:issue-40', tenant: 'endzone', issue: 40, manifestPath: 'm40', reservations: {}, idempotencyKey: 'reserve-40', now: '2026-09-01T00:00:00.000Z' });
  reserveRecord({ root: otherRoot, id: 'endzone:issue-41', tenant: 'endzone', issue: 41, manifestPath: 'm41', reservations: {}, idempotencyKey: 'reserve-41', now: '2026-09-01T00:00:01.000Z' });
  assert.throws(
    () => reserveRecord({ root: otherRoot, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, manifestPath: 'm42', reservations: { components: ['src/a.js'] }, proofRecords, independenceProof: proof, idempotencyKey: 'reserve-42', now: '2026-09-01T00:00:02.000Z' }),
    (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF' || error.code === 'RESERVATION_CONFLICT',
  );
});

test('a third reservation accepts populated non-overlapping evidence', () => {
  const root = rootDir();
  reserveRecord({ root, id: 'endzone:issue-40', tenant: 'endzone', issue: 40, manifestPath: 'm40', reservations: { components: ['bin/a.js'] }, idempotencyKey: 'reserve-40', now: '2026-09-01T00:00:00.000Z' });
  reserveRecord({ root, id: 'endzone:issue-41', tenant: 'endzone', issue: 41, manifestPath: 'm41', reservations: { components: ['bin/b.js'] }, idempotencyKey: 'reserve-41', now: '2026-09-01T00:00:01.000Z' });
  const proof = proofFor([
    { issue: 40, reservations: { components: ['bin/a.js'] } },
    { issue: 41, reservations: { components: ['bin/b.js'] } },
    { issue: 42, reservations: { components: ['bin/c.js'] } },
  ]);
  const third = reserveRecord({ root, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, manifestPath: 'm42', reservations: { components: ['bin/c.js'] }, independenceProof: proof, idempotencyKey: 'reserve-42', now: '2026-09-01T00:00:02.000Z' });
  assert.equal(third.record.issue, 42);

  // fleet#62: the same proof under a different (still non-overlapping) set is
  // not that reservation's proof: the digest binds the set.
  const otherRoot = rootDir();
  reserveRecord({ root: otherRoot, id: 'endzone:issue-40', tenant: 'endzone', issue: 40, manifestPath: 'm40', reservations: { components: ['bin/a.js'] }, idempotencyKey: 'reserve-40', now: '2026-09-01T00:00:00.000Z' });
  reserveRecord({ root: otherRoot, id: 'endzone:issue-41', tenant: 'endzone', issue: 41, manifestPath: 'm41', reservations: { components: ['bin/b.js'] }, idempotencyKey: 'reserve-41', now: '2026-09-01T00:00:01.000Z' });
  assert.throws(
    () => reserveRecord({ root: otherRoot, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, manifestPath: 'm42', reservations: { components: ['bin/d.js'] }, independenceProof: proof, idempotencyKey: 'reserve-42', now: '2026-09-01T00:00:02.000Z' }),
    (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF',
  );
  const unbound = { ...proof };
  delete unbound.reservationDigest;
  assert.throws(
    () => reserveRecord({ root: otherRoot, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, manifestPath: 'm42', reservations: { components: ['bin/c.js'] }, independenceProof: unbound, idempotencyKey: 'reserve-42', now: '2026-09-01T00:00:02.000Z' }),
    (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF',
    'a proof with no digest is a hand-authored proof, not the printed one',
  );
  const bound = reserveRecord({ root: otherRoot, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, manifestPath: 'm42', reservations: { components: ['bin/c.js'] }, independenceProof: proof, idempotencyKey: 'reserve-42', now: '2026-09-01T00:00:02.000Z' });
  assert.equal(bound.record.issue, 42);
});

test('an untouched assignment release is reusable and continues the record lineage', () => {
  const root = rootDir();
  const options = {
    root, id: 'endzone:issue-43', tenant: 'endzone', issue: 43,
    manifestPath: path.join(root, 'state', 'manifests', 'assignment-43.json'),
    github: { issueNumber: 43, bodyHash: 'a'.repeat(64) },
    reservations: { components: ['docs/adr'] },
    idempotencyKey: 'reserve-43-a', now: '2026-09-01T00:00:00.000Z',
  };
  const first = reserveRecord(options);
  const released = releaseRecord({ root, id: options.id, expectedRevision: first.revision, idempotencyKey: 'release-43-a', now: '2026-09-01T00:00:01.000Z' });
  assert.equal(released.record.state, 'released');
  assert.equal(fs.existsSync(path.join(root, 'state', 'archive', 'work-endzone_issue-43.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'releases', 'work-endzone_issue-43.json')), true);
  assert.deepEqual(reservationBaseline({ root, id: options.id }), { revision: 3, eventSequence: 3, reused: true });

  const second = reserveRecord({ ...options, manifestPath: path.join(root, 'state', 'manifests', 'assignment-43-r3.json'), idempotencyKey: 'reserve-43-b', now: '2026-09-01T00:00:02.000Z' });
  assert.equal(second.revision, 3);
  assert.equal(second.eventSequence, 3);
  assert.equal(second.record.state, 'assigned');
  assert.equal(second.record.createdAt, first.record.createdAt);
  assert.equal(fs.existsSync(path.join(root, 'state', 'releases', 'work-endzone_issue-43.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'releases', 'history', 'work-endzone_issue-43-through-2.json')), true);
  assert.deepEqual(readEvents(root).filter((event) => event.recordId === options.id).map((event) => event.sequence), [1, 2, 3]);
});

test('pending journals recover release storage and reusable-snapshot supersession', () => {
  const root = rootDir();
  const id = 'endzone:issue-46';
  reserveRecord({ root, id, tenant: 'endzone', issue: 46, idempotencyKey: 'reserve-46-a', now: '2026-09-01T00:00:00.000Z' });
  assert.throws(
    () => releaseRecord({ root, id, expectedRevision: 1, idempotencyKey: 'release-46-a', now: '2026-09-01T00:00:01.000Z', killPoint: 'after-event' }),
    (error) => error.code === 'KILL_POINT',
  );
  assert.equal(getRecord({ root, id }).state, 'released');
  assert.equal(fs.existsSync(path.join(root, 'state', 'releases', 'work-endzone_issue-46.json')), true);

  assert.throws(
    () => reserveRecord({ root, id, tenant: 'endzone', issue: 46, idempotencyKey: 'reserve-46-b', now: '2026-09-01T00:00:02.000Z', killPoint: 'after-event' }),
    (error) => error.code === 'KILL_POINT',
  );
  const recovered = getRecord({ root, id });
  assert.equal(recovered.state, 'assigned');
  assert.equal(recovered.revision, 3);
  assert.equal(fs.existsSync(path.join(root, 'state', 'releases', 'work-endzone_issue-46.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'releases', 'history', 'work-endzone_issue-46-through-2.json')), true);
});

test('a legacy sequence-two archive is recoverable only when it proves no work ran', () => {
  const root = rootDir();
  const id = 'endzone:issue-45';
  reserveRecord({ root, id, tenant: 'endzone', issue: 45, idempotencyKey: 'reserve-45-a', now: '2026-09-01T00:00:00.000Z' });
  releaseRecord({ root, id, expectedRevision: 1, idempotencyKey: 'release-45-a', now: '2026-09-01T00:00:01.000Z' });
  const releasedPath = path.join(root, 'state', 'releases', 'work-endzone_issue-45.json');
  const archivePath = path.join(root, 'state', 'archive', 'work-endzone_issue-45.json');
  const legacy = JSON.parse(fs.readFileSync(releasedPath, 'utf8'));
  legacy.record.state = 'retired';
  legacy.archivedAt = legacy.releasedAt;
  delete legacy.releasedAt;
  fs.writeFileSync(archivePath, `${JSON.stringify(legacy, null, 2)}\n`);
  fs.rmSync(releasedPath);

  const recovered = reserveRecord({ root, id, tenant: 'endzone', issue: 45, idempotencyKey: 'reserve-45-b', now: '2026-09-01T00:00:02.000Z' });
  assert.equal(recovered.revision, 3);
  assert.equal(fs.existsSync(archivePath), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'releases', 'history', 'work-endzone_issue-45-through-2.json')), true);
});

test('release refuses an assigned record that is not an untouched assignment reservation', () => {
  const root = rootDir();
  createRecord({ root, id: 'endzone:issue-44', tenant: 'endzone', issue: 44, state: 'assigned', idempotencyKey: 'create-44', now: '2026-09-01T00:00:00.000Z' });
  assert.throws(
    () => releaseRecord({ root, id: 'endzone:issue-44', expectedRevision: 1, idempotencyKey: 'release-44' }),
    (error) => error.code === 'INVALID_RELEASE' && /untouched reservation/.test(error.message),
  );
});

test('an escalated touched assignment can be abandoned and reserved again with a fresh lineage step', () => {
  const root = rootDir();
  const id = 'endzone:issue-1136';
  const first = reserveRecord({
    root, id, tenant: 'endzone', issue: 1136, manifestPath: 'assignment-1136-a.json',
    reservations: { components: ['src/game-center'] }, idempotencyKey: 'reserve-1136-a', now: '2026-09-10T04:58:36.000Z',
  });
  move(root, id, first.revision, 'implementing', 'ack-1136', 'assignment acknowledged', '2026-09-10T04:58:52.000Z');
  move(root, id, 2, 'escalated', 'escalate-1136', 'account usage limit', '2026-09-10T04:59:54.000Z');

  const abandoned = abandonRecord({
    root, id, expectedRevision: 3, idempotencyKey: 'abandon-1136', actor: 'cory',
    reason: 'IC stopped on an account usage limit before writing code', evidence: 'endzone#1136 ruling', now: '2026-09-10T14:07:41.000Z',
  });

  assert.equal(abandoned.record.state, 'abandoned');
  assert.equal(abandoned.record.abandonment.from, 'escalated');
  assert.equal(abandoned.record.abandonment.reason, 'IC stopped on an account usage limit before writing code');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records), []);
  assert.equal(fs.existsSync(path.join(root, 'state', 'abandons', 'work-endzone_issue-1136.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'state', 'archive', 'work-endzone_issue-1136.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'releases', 'work-endzone_issue-1136.json')), false);
  assert.equal(getRecord({ root, id }).state, 'abandoned');
  assert.deepEqual(reservationBaseline({ root, id }), { revision: 5, eventSequence: 5, reused: true });

  const second = reserveRecord({
    root, id, tenant: 'endzone', issue: 1136, manifestPath: 'assignment-1136-r5.json',
    reservations: { components: ['src/game-center'] }, idempotencyKey: 'reserve-1136-b', now: '2026-09-10T14:10:00.000Z',
  });
  assert.equal(second.revision, 5);
  assert.equal(second.eventSequence, 5);
  assert.equal(second.record.state, 'assigned');
  assert.equal(second.record.createdAt, first.record.createdAt);
  assert.equal(fs.existsSync(path.join(root, 'state', 'abandons', 'work-endzone_issue-1136.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 'abandons', 'history', 'work-endzone_issue-1136-through-4.json')), true);
  const events = readEvents(root).filter((event) => event.recordId === id);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal(events[3].type, 'assignment-abandoned');
  assert.equal(events[3].changes.reason, 'IC stopped on an account usage limit before writing code');
});

test('abandon requires a touched attempt and a reason, while the abandoned attempt consumes no assignment slot', () => {
  const root = rootDir();
  const id = 'endzone:issue-40';
  reserveRecord({ root, id, tenant: 'endzone', issue: 40, manifestPath: 'm40', reservations: { components: ['a'] }, idempotencyKey: 'reserve-40', now: '2026-09-10T00:00:00.000Z' });
  assert.throws(
    () => abandonRecord({ root, id, expectedRevision: 1, idempotencyKey: 'abandon-untouched', reason: 'no work ran' }),
    (error) => error.code === 'INVALID_ABANDON' && /must be released/.test(error.message),
  );
  move(root, id, 1, 'implementing', 'ack-40', 'ack', '2026-09-10T00:00:01.000Z');
  assert.throws(
    () => move(root, id, 2, 'abandoned', 'transition-abandon-40', 'bypass', '2026-09-10T00:00:01.500Z'),
    (error) => error.code === 'INVALID_TRANSITION',
  );
  assert.throws(
    () => abandonRecord({ root, id, expectedRevision: 2, idempotencyKey: 'abandon-no-reason' }),
    (error) => error.code === 'MISSING_ABANDON_REASON',
  );
  abandonRecord({ root, id, expectedRevision: 2, idempotencyKey: 'abandon-40', reason: 'worker ended', now: '2026-09-10T00:00:02.000Z' });

  reserveRecord({ root, id: 'endzone:issue-41', tenant: 'endzone', issue: 41, manifestPath: 'm41', reservations: { components: ['b'] }, idempotencyKey: 'reserve-41', now: '2026-09-10T00:00:03.000Z' });
  reserveRecord({ root, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, manifestPath: 'm42', reservations: { components: ['c'] }, idempotencyKey: 'reserve-42', now: '2026-09-10T00:00:04.000Z' });
  const active = JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8'));
  assert.deepEqual(Object.keys(active.records).sort(), ['endzone:issue-41', 'endzone:issue-42']);
});

test('abandonment journal recovery stores one reusable snapshot and replays the same command', () => {
  const root = rootDir();
  const id = 'endzone:issue-46';
  reserveRecord({ root, id, tenant: 'endzone', issue: 46, manifestPath: 'm46', idempotencyKey: 'reserve-46', now: '2026-09-10T00:00:00.000Z' });
  move(root, id, 1, 'implementing', 'ack-46', 'ack', '2026-09-10T00:00:01.000Z');
  assert.throws(
    () => abandonRecord({ root, id, expectedRevision: 2, idempotencyKey: 'abandon-46', reason: 'worker stopped', now: '2026-09-10T00:00:02.000Z', killPoint: 'after-event' }),
    (error) => error.code === 'KILL_POINT',
  );
  assert.equal(getRecord({ root, id }).state, 'abandoned');
  const replay = abandonRecord({ root, id, expectedRevision: 2, idempotencyKey: 'abandon-46', reason: 'worker stopped' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventSequence, 3);
  assert.equal(readEvents(root).filter((event) => event.recordId === id && event.type === 'assignment-abandoned').length, 1);
});

test('the CLI abandon door records the reason and permits a fresh reservation', () => {
  const root = rootDir();
  const script = path.resolve(__dirname, '..', 'bin', 'work-state.js');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }));
  const first = run('reserve', '--root', root, '--id', 'endzone:issue-47', '--tenant', 'endzone', '--issue', '47', '--manifest', 'm47', '--idempotency-key', 'reserve-47');
  const started = run('transition', '--root', root, '--id', 'endzone:issue-47', '--to', 'implementing', '--expected-revision', String(first.revision), '--idempotency-key', 'ack-47');
  const abandoned = run('abandon', '--root', root, '--id', 'endzone:issue-47', '--expected-revision', String(started.revision), '--idempotency-key', 'abandon-47', '--actor', 'cory', '--reason', 'session ended', '--evidence', 'fleet#11');
  const second = run('reserve', '--root', root, '--id', 'endzone:issue-47', '--tenant', 'endzone', '--issue', '47', '--manifest', 'm47-r4', '--idempotency-key', 'reserve-47-b');
  assert.equal(abandoned.record.state, 'abandoned');
  assert.equal(abandoned.record.abandonment.reason, 'session ended');
  assert.equal(second.record.state, 'assigned');
  assert.equal(second.revision, 4);
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

test('status projection without --output answers on stdout and leaves state/status untouched', () => {
  // fleet: eleven recorded clobbers of the lead's hand-written state/status/<tenant>.md.
  const root = rootDir();
  makeRecord(root);
  const statusDir = path.join(root, 'state', 'status');
  const handWritten = path.join(statusDir, 'endzone.md');
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(handWritten, '# endzone - project lead status\nhand-written, must survive\n');
  const result = projectStatus({ root, tenant: 'endzone', now: '2026-09-01T12:00:00.000Z' });
  assert.equal(result.output, null);
  assert.match(result.content, /^# Fleet status/);
  assert.equal(fs.readFileSync(handWritten, 'utf8'), '# endzone - project lead status\nhand-written, must survive\n');
  assert.deepEqual(fs.readdirSync(statusDir), ['endzone.md']);
  const script = path.resolve(__dirname, '..', 'bin', 'work-state.js');
  const viaCli = JSON.parse(execFileSync(process.execPath, [script, 'project', '--root', root, '--tenant', 'endzone', '--now', '2026-09-01T12:00:00.000Z'], { encoding: 'utf8' }));
  assert.equal(viaCli.output, null);
  assert.equal(viaCli.content, result.content);
  assert.equal(fs.readFileSync(handWritten, 'utf8'), '# endzone - project lead status\nhand-written, must survive\n');
  const untenanted = projectStatus({ root, now: '2026-09-01T12:00:00.000Z' });
  assert.equal(untenanted.output, null);
  assert.deepEqual(fs.readdirSync(statusDir), ['endzone.md']);
});

test('status projection refuses to overwrite a file it did not generate', () => {
  const root = rootDir();
  makeRecord(root);
  const handWritten = path.join(root, 'state', 'status', 'endzone.md');
  fs.mkdirSync(path.dirname(handWritten), { recursive: true });
  fs.writeFileSync(handWritten, '# endzone - project lead status\nhand-written, must survive\n');
  assert.throws(
    () => projectStatus({ root, tenant: 'endzone', output: handWritten, now: '2026-09-01T12:00:00.000Z' }),
    (error) => error instanceof WorkStateError && error.code === 'OUTPUT_NOT_GENERATED',
  );
  assert.equal(fs.readFileSync(handWritten, 'utf8'), '# endzone - project lead status\nhand-written, must survive\n');
  const generated = path.join(root, 'state', 'status', 'STATUS.md');
  const first = projectStatus({ root, output: generated, now: '2026-09-01T12:00:00.000Z' });
  assert.equal(first.output, generated);
  const second = projectStatus({ root, output: generated, now: '2026-09-01T12:00:00.000Z' });
  assert.equal(fs.readFileSync(generated, 'utf8'), second.content);
});

test('status projection rejects a misspelled output flag instead of falling through', () => {
  const root = rootDir();
  makeRecord(root);
  const script = path.resolve(__dirname, '..', 'bin', 'work-state.js');
  let failure;
  try {
    execFileSync(process.execPath, [script, 'project', '--root', root, '--tenant', 'endzone', '--out', path.join(root, 'x.md')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { failure = error; }
  assert.ok(failure, 'expected a USAGE failure');
  assert.equal(JSON.parse(failure.stderr).code, 'USAGE');
  assert.match(JSON.parse(failure.stderr).message, /--out;/);
  assert.equal(fs.existsSync(path.join(root, 'state', 'status', 'endzone.md')), false);
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

// fleet#99: the merge-without-review page (ADR 0012, high priority) rides the
// `state-merged` event pr-watch writes, so it records through this door like a
// decision, not in a notifier-side fallback file. Unlike a decision it is a fact
// that never resolves: it stays claimable after the record moves on, even once
// retired and archived.
function mergeUnreviewed(root) {
  makeRecord(root);
  move(root, 'endzone:issue-42', 1, 'implementing', 'm-1', 'ack', '2026-09-01T05:00:01.000Z');
  move(root, 'endzone:issue-42', 2, 'pr-open', 'm-2', 'PR #77', '2026-09-01T05:00:02.000Z');
  move(root, 'endzone:issue-42', 3, 'ci-wait', 'm-3', 'CI', '2026-09-01T05:00:03.000Z');
  move(root, 'endzone:issue-42', 4, 'review', 'm-4', 'settled', '2026-09-01T05:00:04.000Z');
  return move(root, 'endzone:issue-42', 5, 'merged', 'm-5', 'observed merged at 2026-09-01T05:00:05.000Z (gh pr view 77); merged without a recorded formal review (ticket 05 lower bound)', '2026-09-01T05:00:05.000Z');
}

test('fleet#99: a merged-without-review event is claimed and settled through the door', () => {
  const root = rootDir();
  const merged = mergeUnreviewed(root);
  assert.equal(merged.eventSequence, 6);
  const claimed = notify(root, 'claim', merged.revision, 6);
  assert.equal(claimed.record.notifications['6'].status, 'claimed');
  const sent = notify(root, 'sent', claimed.revision, 6, { detail: 'pushover delivered' });
  assert.equal(sent.record.notifications['6'].status, 'sent');
  assert.throws(() => notify(root, 'claim', sent.revision, 6), { code: 'NOTIFICATION_ALREADY_SENT' });
  const events = readEvents(root).filter((event) => event.type.startsWith('notification-'));
  assert.deepEqual(events.map((event) => [event.type, event.changes.decisionType]), [['notification-attempted', 'state-merged'], ['notification-sent', 'state-merged']]);
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'merge-review-fallback.jsonl')), false);
});

test('fleet#99: a plain merged event (a reviewed merge) is still not notifiable', () => {
  const root = rootDir();
  makeRecord(root);
  move(root, 'endzone:issue-42', 1, 'implementing', 'p-1', 'ack', '2026-09-01T05:00:01.000Z');
  move(root, 'endzone:issue-42', 2, 'pr-open', 'p-2', 'PR #77', '2026-09-01T05:00:02.000Z');
  move(root, 'endzone:issue-42', 3, 'ci-wait', 'p-3', 'CI', '2026-09-01T05:00:03.000Z');
  move(root, 'endzone:issue-42', 4, 'review', 'p-4', 'settled', '2026-09-01T05:00:04.000Z');
  const merged = move(root, 'endzone:issue-42', 5, 'merged', 'p-5', 'observed merged at 2026-09-01T05:00:05.000Z (gh pr view 77)', '2026-09-01T05:00:05.000Z');
  assert.throws(() => notify(root, 'claim', merged.revision, 6), { code: 'NOT_A_DECISION_EVENT' });
});

test('fleet#99: the merge-review fact stays claimable after the record retires and is archived, and the ledger still verifies', () => {
  const root = rootDir();
  const merged = mergeUnreviewed(root);
  const retiring = move(root, 'endzone:issue-42', merged.revision, 'retiring', 'm-6', 'roster row gone', '2026-09-01T05:00:06.000Z');
  move(root, 'endzone:issue-42', retiring.revision, 'retired', 'm-7', 'retired', '2026-09-01T05:00:07.000Z');
  const archived = getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(archived.state, 'retired');
  const later = (second) => ({ now: `2026-09-01T06:00:${String(second).padStart(2, '0')}.000Z` });
  const claimed = notify(root, 'claim', archived.revision, 6, later(10));
  assert.equal(claimed.record.notifications['6'].status, 'claimed');
  const failed = notify(root, 'failed', claimed.revision, 6, { detail: 'page channel unconfigured', ...later(11) });
  const authorized = notify(root, 'authorize-retry', failed.revision, 6, { actor: 'cory', evidence: 'pushover wired up', ...later(12) });
  const again = notify(root, 'claim', authorized.revision, 6, later(13));
  assert.equal(again.record.notifications['6'].attempt, 2);
  const stored = getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(stored.state, 'retired');
  assert.equal(stored.notifications['6'].status, 'claimed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records['endzone:issue-42'], undefined);
  const verified = require('../bin/verify-events').verifyLedger({ root });
  assert.deepEqual(verified.records.flatMap((record) => record.findings), []);
});

test('fleet#99: a claim on an archived record recovers from every kill point to exactly one event', () => {
  for (const killPoint of ['after-journal', 'after-record', 'after-event']) {
    const root = rootDir();
    const merged = mergeUnreviewed(root);
    const retiring = move(root, 'endzone:issue-42', merged.revision, 'retiring', 'k-6', 'roster row gone', '2026-09-01T05:00:06.000Z');
    const retired = move(root, 'endzone:issue-42', retiring.revision, 'retired', 'k-7', 'retired', '2026-09-01T05:00:07.000Z');
    assert.throws(() => notify(root, 'claim', retired.revision, 6, { killPoint }), { code: 'KILL_POINT' });
    const stored = getRecord({ root, id: 'endzone:issue-42' });
    assert.equal(stored.state, 'retired', killPoint);
    assert.equal(stored.notifications['6'].status, 'claimed', killPoint);
    assert.equal(readEvents(root).filter((event) => event.type === 'notification-attempted').length, 1, killPoint);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records['endzone:issue-42'], undefined, killPoint);
    assert.deepEqual(require('../bin/verify-events').verifyLedger({ root }).records.flatMap((record) => record.findings), [], killPoint);
  }
});

test('fleet#99: a decision event on an archived record is still NOT_FOUND', () => {
  const root = rootDir();
  const merged = mergeUnreviewed(root);
  const escalated = move(root, 'endzone:issue-42', merged.revision, 'escalated', 'd-6', 'retirement blocked', '2026-09-01T05:00:06.000Z');
  const retiring = move(root, 'endzone:issue-42', escalated.revision, 'retiring', 'd-7', 'unblocked', '2026-09-01T05:00:07.000Z');
  const retired = move(root, 'endzone:issue-42', retiring.revision, 'retired', 'd-8', 'retired', '2026-09-01T05:00:08.000Z');
  assert.throws(() => notify(root, 'claim', retired.revision, escalated.eventSequence), { code: 'NOT_FOUND' });
  // The merge-review fact on the same archived record is still claimable.
  assert.equal(notify(root, 'claim', retired.revision, 6).record.notifications['6'].status, 'claimed');
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

test('shadow projection cannot resurrect an abandoned attempt from its stale roster row', () => {
  const root = rootDir();
  const id = 'endzone:issue-1136';
  const rosterPath = path.join(root, 'state', 'roster.json');
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  fs.writeFileSync(rosterPath, JSON.stringify({ sessions: [
    { name: 'ic-1136', role: 'ic', tenant: 'endzone', issue: 1136, status: 'active', sessionId: 'dead-session' },
  ] }));
  reserveRecord({ root, id, tenant: 'endzone', issue: 1136, manifestPath: 'm1136', idempotencyKey: 'reserve-1136', now: '2026-09-10T00:00:00.000Z' });
  move(root, id, 1, 'implementing', 'ack-1136', 'ack', '2026-09-10T00:00:01.000Z');
  abandonRecord({ root, id, expectedRevision: 2, idempotencyKey: 'abandon-1136', reason: 'session died', now: '2026-09-10T00:00:02.000Z' });

  const result = shadowProject({ root, rosterPath, now: '2026-09-10T00:00:03.000Z' });
  assert.deepEqual(result.projected, []);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records), []);
  assert.equal(getRecord({ root, id }).state, 'abandoned');
  assert.equal(readEvents(root).filter((event) => event.recordId === id).length, 3);
});

// --- fleet#4: work-state.js's own cli adopts the parseArgs flag schema --------
// The ledger's door went last (ruling 1). Before this, cli() parsed every
// command without a schema: a typo'd flag fell into a bucket nothing read, and
// whether the command noticed depended on which field the typo left unset.
// `transition --state review` hit INVALID_TRANSITION only because `to` was
// undefined; `release --revision 3` compared NaN to the revision and got
// STALE_REVISION; `transition --no-notify` (for --no-notifier) launched the
// notifier anyway, and `budget --token 5000` recorded a budget phase with no
// tokens. Every case below goes through `cli`, the door launch.ps1 and the
// role files use.
//
// Red-tell: with bin/work-state.js stashed back to parseArgs(rest) and no
// FLAGS, every USAGE case below fails (the typo resolves to undefined instead
// of throwing) and `require('../bin/work-state')` exports neither cli nor FLAGS.

function usageError(argv, fragment) {
  assert.throws(() => cli(argv), (error) => {
    assert.ok(error instanceof WorkStateError, `expected WorkStateError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.code, 'USAGE');
    if (fragment) assert.match(error.message, fragment);
    return true;
  });
}

test('cli: every command declares its accepted flags, and an unknown command is a usage error', () => {
  assert.deepEqual(Object.keys(FLAGS).sort(), ['abandon', 'budget', 'create', 'get', 'notify', 'observe', 'project', 'reconcile', 'release', 'reserve', 'review', 'shadow', 'transition']);
  usageError(['ack', '--root', rootDir(), '--id', 'endzone:issue-42'], /unknown command 'ack'/);
  usageError([], /unknown command/);
});

test('cli: transition refuses --state for --to and --no-notify for --no-notifier', () => {
  const root = rootDir();
  makeRecord(root);
  usageError(['transition', '--root', root, '--id', 'endzone:issue-42', '--state', 'implementing', '--expected-revision', '1', '--idempotency-key', 'k'], /unknown flag --state/);
  usageError(['transition', '--root', root, '--id', 'endzone:issue-42', '--to', 'implementing', '--expected-revision', '1', '--idempotency-key', 'k', '--no-notify'], /unknown flag --no-notify/);
  assert.equal(getRecord({ root, id: 'endzone:issue-42' }).state, 'assigned');
});

test('cli: release and abandon refuse --revision for --expected-revision, naming the accepted set', () => {
  const root = rootDir();
  makeRecord(root);
  assert.throws(() => cli(['release', '--root', root, '--id', 'endzone:issue-42', '--revision', '1', '--idempotency-key', 'k']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.equal(error.flag, 'revision');
    assert.deepEqual(error.accepted, FLAGS.release);
    assert.match(error.message, /--expected-revision/);
    return true;
  });
  usageError(['abandon', '--root', root, '--id', 'endzone:issue-42', '--revision', '1', '--idempotency-key', 'k', '--reason', 'x'], /unknown flag --revision/);
  assert.equal(getRecord({ root, id: 'endzone:issue-42' }).state, 'assigned');
});

test('cli: create and reserve refuse --pr for --pr-number and --proof for --independence-proof', () => {
  const root = rootDir();
  usageError(['create', '--root', root, '--id', 'endzone:issue-42', '--tenant', 'endzone', '--issue', '42', '--pr', '77', '--idempotency-key', 'k'], /unknown flag --pr/);
  usageError(['reserve', '--root', root, '--id', 'endzone:issue-42', '--tenant', 'endzone', '--issue', '42', '--manifest', 'm', '--proof', '{}', '--idempotency-key', 'k'], /unknown flag --proof/);
  assert.equal(fs.existsSync(path.join(root, 'state', 'work', 'active.json')), false);
});

test('cli: review refuses --head for --head-sha and --artifact-path for --artifact', () => {
  const root = rootDir();
  usageError(['review', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', '1', '--kind', 'formal', '--head', 'abc', '--artifact', 'a.json', '--idempotency-key', 'k'], /unknown flag --head/);
  usageError(['review', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', '1', '--kind', 'formal', '--head-sha', 'abc', '--artifact-path', 'a.json', '--idempotency-key', 'k'], /unknown flag --artifact-path/);
});

test('cli: observe, notify and budget refuse their confusable names', () => {
  const root = rootDir();
  usageError(['observe', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', '1', '--pr', '77', '--idempotency-key', 'k'], /unknown flag --pr/);
  usageError(['notify', '--root', root, '--id', 'endzone:issue-42', '--phase', 'claim', '--expected-revision', '1', '--sequence', '3', '--idempotency-key', 'k'], /unknown flag --sequence/);
  usageError(['budget', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', '1', '--phase', 'warning', '--token', '5000', '--idempotency-key', 'k'], /unknown flag --token/);
});

test('cli: get, shadow and reconcile refuse --record, --roster-path and --pr', () => {
  const root = rootDir();
  usageError(['get', '--root', root, '--record', 'endzone:issue-42'], /unknown flag --record/);
  usageError(['shadow', '--root', root, '--roster-path', 'roster.json'], /unknown flag --roster-path/);
  usageError(['reconcile', '--repo', 'owner/name', '--pr', '77'], /unknown flag --pr/);
});

test('cli: a correct get invocation still answers', () => {
  const root = rootDir();
  makeRecord(root);
  assert.equal(cli(['get', '--root', root, '--id', 'endzone:issue-42']).state, 'assigned');
});

test('cli: the process exits 2 on a refusal and writes it to stderr, no JSON answer on stdout', () => {
  const root = rootDir();
  makeRecord(root);
  const script = path.resolve(__dirname, '..', 'bin', 'work-state.js');
  let failure;
  try {
    execFileSync(process.execPath, [script, 'transition', '--root', root, '--id', 'endzone:issue-42', '--state', 'implementing', '--expected-revision', '1', '--idempotency-key', 'k'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { failure = error; }
  assert.ok(failure, 'expected a USAGE failure');
  assert.equal(failure.status, 2);
  assert.equal(failure.stdout, '');
  assert.equal(JSON.parse(failure.stderr).code, 'USAGE');
  assert.equal(getRecord({ root, id: 'endzone:issue-42' }).state, 'assigned');
});


// fleet#56: `transition --to escalated` on a PR-less record wrote the state-escalated
// event and launched the notifier but appended no wake-outbox line, and the Principal's
// frontier reads decision-needed wakes from the outbox alone. `hold` was the only lead
// door that wrote one, and it is a PR-only state. A decision transition through the CLI
// now appends the outbox line the way `hold` does, idempotently, so a mis-specified
// ticket can reach the Principal before an IC is launched.
test('fleet#56: a CLI transition to escalated appends a decision-needed wake once; a retry repairs a missing line and never duplicates one', () => {
  const root = rootDir();
  makeRecord(root, { github: { issueNumber: 42 } });
  const bin = path.join(__dirname, '..', 'bin', 'work-state.js');
  const argv = [bin, 'transition', '--root', root, '--id', 'endzone:issue-42', '--to', 'escalated', '--expected-revision', '1', '--idempotency-key', 'esc-1', '--actor', 'pl-endzone', '--evidence', 'criterion 1 is unsatisfiable; restate it', '--no-notifier'];
  const first = JSON.parse(execFileSync(process.execPath, argv, { encoding: 'utf8' }));
  assert.equal(first.record.state, 'escalated');
  const outboxFile = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  const lines = () => fs.readFileSync(outboxFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines().length, 1);
  assert.equal(lines()[0].wake, 'decision-needed');
  assert.equal(lines()[0].recordId, 'endzone:issue-42');
  assert.equal(lines()[0].eventSequence, first.eventSequence);
  assert.equal(lines()[0].idempotencyKey, 'esc-1');
  assert.equal(lines()[0].evidence, 'criterion 1 is unsatisfiable; restate it');

  const retry = JSON.parse(execFileSync(process.execPath, argv, { encoding: 'utf8' }));
  assert.equal(retry.replayed, true);
  assert.equal(lines().length, 1, 'a replay appends nothing');

  fs.rmSync(outboxFile);
  const repaired = JSON.parse(execFileSync(process.execPath, argv, { encoding: 'utf8' }));
  assert.equal(repaired.replayed, true);
  assert.equal(lines().length, 1, 'a replay that finds no line repairs the cache');

  // A non-decision transition writes no line.
  move(root, 'endzone:issue-42', repaired.revision, 'implementing', 'back', 'restated by Cory', '2026-09-12T18:00:00.000Z');
  assert.equal(lines().length, 1);
});

test('fleet#56: the Principal sees a lead escalation on a PR-less record', () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'owner/repo', readyLabel: 'ready-for-agent', ownerLogin: 'cory', fleetIdentity: 'cory' }));
  const fixture = path.join(root, 'issues.json');
  fs.writeFileSync(fixture, JSON.stringify([{ number: 1267, title: 'Ticket', url: 'https://github.com/owner/repo/issues/1267', body: 'x', createdAt: '2026-09-11T00:00:00.000Z', labels: ['ready-for-agent'], assignees: [], comments: [] }]));
  makeRecord(root, { id: 'endzone:issue-1267', issue: 1267, github: { issueNumber: 1267 }, idempotencyKey: 'create-1267' });
  const bin = path.join(__dirname, '..', 'bin', 'work-state.js');
  execFileSync(process.execPath, [bin, 'transition', '--root', root, '--id', 'endzone:issue-1267', '--to', 'escalated', '--expected-revision', '1', '--idempotency-key', 'esc-1267', '--actor', 'pl-endzone', '--evidence', 'acceptance criteria wrong', '--no-notifier'], { encoding: 'utf8' });
  const frontier = require('../bin/triage').computeFrontier({ root, tenant: 'endzone', fixture, now: '2026-09-12T18:00:00.000Z' });
  assert.equal(frontier.counts.escalations, 1);
  assert.equal(frontier.eligible[0].kind, 'escalation');
  assert.equal(frontier.eligible[0].number, 1267);
  assert.equal(frontier.eligible[0].evidence, 'acceptance criteria wrong');
});
