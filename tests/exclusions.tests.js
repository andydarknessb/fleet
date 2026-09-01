'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { addExclusion, liftExclusion, readExclusions, projectExclusions, activeExclusions } = require('../bin/exclusions');
const { selectFrontier } = require('../bin/assignment');
const workState = require('../bin/work-state');

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-exclusions-'));
}

const BASE = {
  issue: 125, reason: 'manual acceptance pass; rotor and DevTools evidence are human-only',
  evidence: 'state/skip/endzone.json#issues.125', owner: 'cory', actor: 'test',
};

test('an exclusion needs reason, evidence, owner, and a recheck event or expiry', () => {
  const root = rootDir();
  for (const missing of ['reason', 'evidence', 'owner']) {
    assert.throws(() => addExclusion({ root, tenant: 'endzone', ...BASE, recheck: { expiresAt: '2026-10-01T00:00:00.000Z' }, [missing]: '' }), { code: 'EXCLUSION_INVALID' });
  }
  assert.throws(() => addExclusion({ root, tenant: 'endzone', ...BASE }), { code: 'EXCLUSION_INVALID' });
  assert.throws(() => addExclusion({ root, tenant: 'endzone', ...BASE, recheck: { manual: true } }), { code: 'EXCLUSION_INVALID' });
  assert.throws(() => addExclusion({ root, tenant: 'endzone', ...BASE, recheck: { expiresAt: 'someday' } }), { code: 'EXCLUSION_INVALID' });
  assert.throws(() => addExclusion({ root, tenant: 'endzone', ...BASE, recheck: { event: { recordId: 'endzone:issue-1' } } }), { code: 'EXCLUSION_INVALID' });
  assert.equal(fs.existsSync(path.join(root, 'state', 'exclusions', 'endzone.jsonl')), false);
});

test('adding appends a typed entry; a second active exclusion for the same issue is refused', () => {
  const root = rootDir();
  const added = addExclusion({ root, tenant: 'endzone', ...BASE, recheck: { event: { type: 'exclusion-lifted' } }, now: '2026-09-01T10:00:00.000Z' });
  assert.equal(added.kind, 'exclusion-added');
  assert.equal(added.id, 'endzone:excl-125-1');
  assert.deepEqual(added.recheck, { event: { type: 'exclusion-lifted' } });
  assert.throws(() => addExclusion({ root, tenant: 'endzone', ...BASE, recheck: { expiresAt: '2026-10-01T00:00:00.000Z' } }), { code: 'EXCLUSION_EXISTS' });
  const entries = readExclusions(root, 'endzone');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].owner, 'cory');
});

test('the projection discharges by lift, expiry, or a named ledger event, and keeps history', () => {
  const root = rootDir();
  const lifted = addExclusion({ root, tenant: 'endzone', issue: 1, reason: 'r1', evidence: 'e1', owner: 'cory', actor: 'test', recheck: { event: { type: 'exclusion-lifted' } }, now: '2026-09-01T10:00:00.000Z' });
  const expiring = addExclusion({ root, tenant: 'endzone', issue: 2, reason: 'r2', evidence: 'e2', owner: 'pl-endzone', actor: 'test', recheck: { expiresAt: '2026-09-02T00:00:00.000Z' }, now: '2026-09-01T10:00:00.000Z' });
  const eventBound = addExclusion({ root, tenant: 'endzone', issue: 3, reason: 'r3', evidence: 'e3', owner: 'pl-endzone', actor: 'test', recheck: { event: { type: 'state-merged', issue: 40 } }, now: '2026-09-01T10:00:00.000Z' });
  const standing = addExclusion({ root, tenant: 'endzone', issue: 4, reason: 'r4', evidence: 'e4', owner: 'cory', actor: 'test', recheck: { expiresAt: '2027-01-01T00:00:00.000Z' }, now: '2026-09-01T10:00:00.000Z' });

  let projection = projectExclusions({ entries: readExclusions(root, 'endzone'), events: [], now: '2026-09-01T12:00:00.000Z' });
  assert.deepEqual(projection.active.map((e) => e.issue), [1, 2, 3, 4]);
  assert.deepEqual(projection.discharged, []);

  liftExclusion({ root, tenant: 'endzone', id: lifted.id, actor: 'cory', evidence: 'pass done', now: '2026-09-01T13:00:00.000Z' });
  assert.throws(() => liftExclusion({ root, tenant: 'endzone', id: lifted.id, actor: 'cory', evidence: 'again' }), { code: 'EXCLUSION_NOT_ACTIVE' });
  assert.throws(() => liftExclusion({ root, tenant: 'endzone', id: 'endzone:excl-9-1', actor: 'cory', evidence: 'x' }), { code: 'EXCLUSION_NOT_FOUND' });

  const mergedBefore = { recordId: 'endzone:issue-40', type: 'state-merged', at: '2026-09-01T09:00:00.000Z', sequence: 3 };
  const mergedAfter = { recordId: 'endzone:issue-40', type: 'state-merged', at: '2026-09-01T14:00:00.000Z', sequence: 4 };
  projection = projectExclusions({ entries: readExclusions(root, 'endzone'), events: [mergedBefore], now: '2026-09-01T15:00:00.000Z' });
  assert.deepEqual(projection.active.map((e) => e.issue), [2, 3, 4], 'an event before the exclusion was recorded does not discharge it');

  projection = projectExclusions({ entries: readExclusions(root, 'endzone'), events: [mergedBefore, mergedAfter], now: '2026-09-03T00:00:00.000Z' });
  assert.deepEqual(projection.active.map((e) => e.issue), [4]);
  const by = Object.fromEntries(projection.discharged.map((e) => [e.issue, e.dischargedBy]));
  assert.equal(by[1], 'lifted');
  assert.equal(by[2], 'expired');
  assert.equal(by[3], 'event:state-merged');
  assert.equal(projection.discharged.find((e) => e.issue === 3).dischargedAt, mergedAfter.at);
  assert.equal(projection.discharged.find((e) => e.issue === 2).dischargedAt, expiring.recheck.expiresAt);
  assert.equal(readExclusions(root, 'endzone').length, 5, 'history is append-only: four adds and one lift');
  assert.equal(eventBound.id, 'endzone:excl-3-1');
  assert.equal(standing.id, 'endzone:excl-4-1');
});

test('the frontier excludes an active structured exclusion and ignores a discharged one', () => {
  const root = rootDir();
  addExclusion({ root, tenant: 'endzone', issue: 10, reason: 'held', evidence: 'e', owner: 'cory', actor: 'test', recheck: { expiresAt: '2026-09-02T00:00:00.000Z' }, now: '2026-09-01T10:00:00.000Z' });
  const issues = [
    { number: 10, state: 'OPEN', labels: ['ready-for-agent'], createdAt: '2026-08-01T00:00:00.000Z' },
    { number: 11, state: 'OPEN', labels: ['ready-for-agent'], createdAt: '2026-08-02T00:00:00.000Z' },
  ];
  const before = selectFrontier({ issues, readyLabel: 'ready-for-agent', exclusions: activeExclusions({ root, tenant: 'endzone', now: '2026-09-01T12:00:00.000Z' }) });
  assert.deepEqual(before.eligible.map((i) => i.number), [11]);
  assert.deepEqual(before.excluded[0].reasons.map((r) => r.code), ['frontier-exclusion']);
  assert.match(before.excluded[0].reasons[0].detail, /endzone:excl-10-1/);
  const after = selectFrontier({ issues, readyLabel: 'ready-for-agent', exclusions: activeExclusions({ root, tenant: 'endzone', now: '2026-09-03T00:00:00.000Z' }) });
  assert.deepEqual(after.eligible.map((i) => i.number), [10, 11]);
});

test('activeExclusions reads the live ledger so a recorded merge releases an event-bound exclusion', () => {
  const root = rootDir();
  workState.createRecord({ root, id: 'endzone:issue-40', tenant: 'endzone', issue: 40, state: 'implementing', actor: 'test', idempotencyKey: 'c', now: '2026-09-01T10:00:00.000Z' });
  addExclusion({ root, tenant: 'endzone', issue: 3, reason: 'waits on #40', evidence: 'e', owner: 'pl-endzone', actor: 'test', recheck: { event: { type: 'state-merged', recordId: 'endzone:issue-40' } }, now: '2026-09-01T10:30:00.000Z' });
  assert.equal(activeExclusions({ root, tenant: 'endzone' }).length, 1);
  let revision = 1;
  for (const to of ['pr-open', 'ci-wait', 'review']) {
    revision = workState.transitionRecord({ root, id: 'endzone:issue-40', to, expectedRevision: revision, idempotencyKey: `t-${to}`, actor: 'test', evidence: 'e', now: '2026-09-01T11:00:00.000Z' }).revision;
  }
  workState.transitionRecord({ root, id: 'endzone:issue-40', to: 'merged', expectedRevision: revision, idempotencyKey: 't-merged', actor: 'test', evidence: 'e', now: '2026-09-01T12:00:00.000Z', testOnly: true, githubState: 'MERGED', githubMergedAt: '2026-09-01T12:00:00.000Z', githubEvidence: 'test' });
  assert.equal(activeExclusions({ root, tenant: 'endzone' }).length, 0);
});

// Review round (2026-09-01): findings with executed repros.
test('a recheck issue is scoped to the exclusion tenant; another tenant merging the same number does nothing', () => {
  const root = rootDir();
  addExclusion({ root, tenant: 'endzone', issue: 7, reason: 'waits for #40', evidence: 'e', owner: 'pl-endzone', actor: 'test', recheck: { event: { type: 'state-merged', issue: 40 } }, now: '2026-09-01T10:00:00.000Z' });
  const foreign = { recordId: 'other:issue-40', type: 'state-merged', at: '2026-09-01T11:00:00.000Z', sequence: 5 };
  const own = { recordId: 'endzone:issue-40', type: 'state-merged', at: '2026-09-01T12:00:00.000Z', sequence: 5 };
  assert.equal(projectExclusions({ entries: readExclusions(root, 'endzone'), events: [foreign], now: '2026-09-02T00:00:00.000Z' }).active.length, 1);
  assert.equal(projectExclusions({ entries: readExclusions(root, 'endzone'), events: [foreign, own], now: '2026-09-02T00:00:00.000Z' }).active.length, 0);
});

test('a recheck event must be a type the ledger can carry', () => {
  const root = rootDir();
  assert.throws(() => addExclusion({ root, tenant: 'endzone', ...BASE, recheck: { event: { type: 'state-mergd' } } }), { code: 'EXCLUSION_INVALID' });
  for (const type of ['state-merged', 'state-retired', 'exclusion-lifted', 'shadow-retired', 'assignment-released']) {
    addExclusion({ root, tenant: 'endzone', issue: 1000 + type.length, reason: 'r', evidence: 'e', owner: 'o', actor: 'test', recheck: { event: { type } } });
  }
});

test('a torn trailing line does not block the frontier; a corrupt interior line does', () => {
  const root = rootDir();
  addExclusion({ root, tenant: 'endzone', ...BASE, recheck: { expiresAt: '2027-01-01T00:00:00.000Z' } });
  const file = path.join(root, 'state', 'exclusions', 'endzone.jsonl');
  const intact = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, '{"schemaVersion":1,"kind":"exclusion-added","id":"endz');
  assert.equal(readExclusions(root, 'endzone').length, 1, 'the torn tail is skipped');
  assert.equal(activeExclusions({ root, tenant: 'endzone' }).length, 1);
  fs.writeFileSync(file, `not json at all\n${intact}`);
  assert.throws(() => readExclusions(root, 'endzone'), { code: 'CORRUPT_EXCLUSION_LEDGER' });
});
