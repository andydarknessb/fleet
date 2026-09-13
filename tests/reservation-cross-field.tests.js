// Fleet #60: a directory reserved under `components` claims every path
// beneath it in `testResources` too, and the reverse. Before this, proof and
// the frontier compared reservations field by field, so an active
// `components: src/widgets/player-decision-card/` let a candidate deriving
// `testResources: src/widgets/player-decision-card/ui/PlayerDecisionCard.test.jsx`
// through as independent while both units edited that file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildLaunchPlan, independenceProof, selectFrontier } = require('../bin/assignment');
const { proofFor, reservationConflicts, reservationOverlaps, reserveRecord } = require('../bin/work-state');

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cross-field-'));
}

function issue(number, reservations) {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    labels: ['ready-for-agent'],
    state: 'open',
    comments: [],
    reservations: { components: [], migrationPrefixes: [], schemaAreas: [], testResources: [], ...reservations },
    blockedBy: [],
    subIssues: [],
  };
}

const DIR = 'src/widgets/player-decision-card/';
const FILE = 'src/widgets/player-decision-card/ui/PlayerDecisionCard.test.jsx';

test('reservationOverlaps names both fields when a components directory contains a testResources file', () => {
  const overlaps = reservationOverlaps({ components: [DIR] }, { testResources: [FILE] });
  assert.deepEqual(overlaps, [{ leftField: 'components', leftValue: DIR, rightField: 'testResources', rightValue: FILE }]);
  const reverse = reservationOverlaps({ testResources: [DIR] }, { components: [FILE] });
  assert.deepEqual(reverse, [{ leftField: 'testResources', leftValue: DIR, rightField: 'components', rightValue: FILE }]);
});

test('reservationOverlaps still compares non-path fields only against themselves', () => {
  assert.deepEqual(reservationOverlaps({ migrationPrefixes: ['20260913'] }, { schemaAreas: ['20260913'] }), []);
  assert.deepEqual(reservationOverlaps({ migrationPrefixes: ['20260913'] }, { migrationPrefixes: ['20260913'] }), [
    { leftField: 'migrationPrefixes', leftValue: '20260913', rightField: 'migrationPrefixes', rightValue: '20260913' },
  ]);
  assert.deepEqual(reservationOverlaps({ components: ['src/widgets/a'] }, { testResources: ['src/widgets/a-v2/x.test.js'] }), []);
});

test('proofFor reports a cross-field conflict naming both fields, in either direction', () => {
  const records = (leftField, rightField) => [
    { issue: 1313, reservations: { [leftField]: [DIR] } },
    { issue: 1369, reservations: { [rightField]: [FILE] } },
  ];
  const forward = proofFor(records('components', 'testResources'));
  assert.equal(forward.independent, false);
  assert.deepEqual(forward.conflicts, [{ left: 1313, right: 1369, fields: ['components', 'testResources'] }]);
  const reverse = proofFor(records('testResources', 'components'));
  assert.equal(reverse.independent, false);
  assert.deepEqual(reverse.conflicts, [{ left: 1313, right: 1369, fields: ['components', 'testResources'] }]);
});

test('proofFor same-field conflicts are unchanged apart from naming the one field', () => {
  const proof = proofFor([
    { issue: 1146, reservations: { components: ['src/widgets/my-team-summary/ui/MyTeamSummary.jsx'] } },
    { issue: 1150, reservations: { components: ['src/widgets/my-team-summary'] } },
  ]);
  assert.deepEqual(proof.conflicts, [{ left: 1146, right: 1150, fields: ['components'] }]);
});

test('reservationConflicts and reserveRecord refuse a testResources file under an active components directory', () => {
  const records = { 'endzone:issue-1313': { id: 'endzone:issue-1313', issue: 1313, reservations: { components: [DIR] } } };
  assert.deepEqual(reservationConflicts(records, { testResources: [FILE] }), [
    { recordId: 'endzone:issue-1313', issue: 1313, field: 'testResources', value: FILE, reservedField: 'components', reservedValue: DIR },
  ]);

  const root = rootDir();
  reserveRecord({ root, id: 'endzone:issue-1313', tenant: 'endzone', issue: 1313, reservations: { components: [DIR] }, idempotencyKey: 'reserve-1313', now: '2026-09-13T00:00:00.000Z' });
  assert.throws(
    () => reserveRecord({ root, id: 'endzone:issue-1369', tenant: 'endzone', issue: 1369, reservations: { testResources: [FILE] }, idempotencyKey: 'reserve-1369', now: '2026-09-13T00:00:01.000Z' }),
    (error) => error.code === 'RESERVATION_CONFLICT' && error.conflicts[0].field === 'testResources' && error.conflicts[0].reservedField === 'components',
  );
});

test('reserveRecord refuses a components file under an active testResources directory', () => {
  const root = rootDir();
  reserveRecord({ root, id: 'endzone:issue-1', tenant: 'endzone', issue: 1, reservations: { testResources: [DIR] }, idempotencyKey: 'reserve-1', now: '2026-09-13T00:00:00.000Z' });
  assert.throws(
    () => reserveRecord({ root, id: 'endzone:issue-2', tenant: 'endzone', issue: 2, reservations: { components: [FILE] }, idempotencyKey: 'reserve-2', now: '2026-09-13T00:00:01.000Z' }),
    (error) => error.code === 'RESERVATION_CONFLICT' && error.conflicts[0].field === 'components' && error.conflicts[0].reservedField === 'testResources',
  );
});

test('the frontier excludes a candidate whose testResources file sits under an active components directory', () => {
  const active = [{ id: 'endzone:issue-1313', issue: 1313, state: 'implementing', manifestPath: 'm1313', reservations: { components: [DIR] } }];
  const frontier = selectFrontier({ issues: [issue(1369, { testResources: [FILE] })], readyLabel: 'ready-for-agent', active, now: '2026-09-13T12:00:00.000Z' });
  assert.deepEqual(frontier.eligible.map((entry) => entry.number), []);
  const reasons = frontier.excluded.find((entry) => entry.issue === 1369).reasons;
  const conflict = reasons.find((reason) => reason.code === 'reservation-conflict');
  assert.ok(conflict, 'expected a reservation-conflict reason');
  assert.equal(conflict.detail, `testResources:${FILE} (components:${DIR} reserved)`);
  assert.equal(conflict.ownerIssue, 1313);
});

test('the launch plan and the proof CLI shape report the cross-field pair', () => {
  const active = [{ id: 'endzone:issue-1313', issue: 1313, state: 'implementing', manifestPath: 'm1313', reservations: { components: [DIR] } }];
  const plan = buildLaunchPlan({ frontier: { eligible: [issue(1369, { testResources: [FILE] })] }, active, maxIcs: 3 });
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.thirdProof.independent, false);
  assert.deepEqual(plan.thirdProof.conflicts, [{ left: 1313, right: 1369, fields: ['components', 'testResources'] }]);

  const proof = independenceProof([...active, issue(1369, { testResources: [FILE] })]);
  assert.equal(proof.independent, false);
  assert.deepEqual(proof.conflicts, [{ left: 1313, right: 1369, fields: ['components', 'testResources'] }]);
});
