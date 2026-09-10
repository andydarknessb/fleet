'use strict';
// 02/03 cutover: the parity gate between the Stop hook's legacy frontier and the
// assignment planner's frontier. The hook logs one evaluation per launch decision
// (state/assignment/shadow/); this tool classifies every difference and reports
// whether the most recent evaluations agree, with every difference approved in
// state/assignment/parity-approved.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  AssignmentParityError,
  ASSIGNMENT_PARITY_FLAGS,
  classifyEvaluation,
  cli,
  compareAssignmentParity,
  observeFrontier,
  readShadow,
} = require('../bin/assignment-parity');
const { spawnSync } = require('node:child_process');

const T0 = Date.parse('2026-09-04T00:00:00.000Z');
const MIN = 60 * 1000;

function rootDir(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-assignment-parity-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ assignment: { parityEvaluations: 4, parityDistinctFrontiers: 2, parityHours: 0, ...(config || {}) } }));
  return root;
}

test('classifyEvaluation keeps the planner head first while comparing as sets', () => {
  const result = classifyEvaluation({ hookFrontier: [12, 30], planner: planner([30, 12]) });
  assert.equal(result.agree, true);
  assert.deepEqual(result.plannerFrontier, [30, 12]);
});

test('compareAssignmentParity requires the evaluations to span the configured hours', () => {
  const root = rootDir({ parityHours: 1 });
  evaluate(root, T0, [1], planner([1]));
  evaluate(root, T0 + 10 * MIN, [2], planner([2]));
  evaluate(root, T0 + 20 * MIN, [3], planner([3]));
  evaluate(root, T0 + 30 * MIN, [4], planner([4]));
  const short = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(short.pass, false);
  assert.match(short.reasons.join(" "), /spans 0.5 h of the 1 h window/);
  evaluate(root, T0 + 70 * MIN, [5], planner([5]));
  const long = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(long.pass, true, long.reasons.join('; '));
  assert.equal(long.spanHours, 1);
});

function iso(ms) { return new Date(ms).toISOString(); }

function planner(frontier, excluded = [], error = null) {
  return { eligible: frontier.map((number) => ({ number })), excluded, error };
}

function evaluate(root, ms, hookFrontier, plannerResult, extra = {}) {
  return observeFrontier({ root, tenant: 'endzone', hookFrontier, hookReason: 'test', planner: plannerResult, now: iso(ms), ...extra });
}

test('classifyEvaluation: identical sets in any order are identical', () => {
  const result = classifyEvaluation({ hookFrontier: [3, 1, 2], planner: planner([1, 2, 3]) });
  assert.equal(result.agree, true);
  assert.deepEqual(result.differences, []);
  assert.equal(result.class, 'identical');
  assert.equal(classifyEvaluation({ hookFrontier: [1], planner: planner([]) }).class, null);
});

test('classifyEvaluation: an issue the planner excludes carries its exclusion codes', () => {
  const result = classifyEvaluation({ hookFrontier: [10, 11], planner: planner([10], [{ issue: 11, reasons: [{ code: 'spec-parent' }, { code: 'assigned' }] }]) });
  assert.equal(result.agree, false);
  assert.deepEqual(result.differences, [{ class: 'planner-excludes', issue: 11, codes: ['spec-parent', 'assigned'] }]);
});

test('classifyEvaluation: an issue only the planner would launch is planner-includes', () => {
  const result = classifyEvaluation({ hookFrontier: [10], planner: planner([10, 12]) });
  assert.deepEqual(result.differences, [{ class: 'planner-includes', issue: 12, codes: [] }]);
});

test('classifyEvaluation: a planner failure is one planner-failed difference, never an agreement', () => {
  const result = classifyEvaluation({ hookFrontier: [], planner: planner([], [], 'GITHUB_QUERY_FAILED: boom') });
  assert.equal(result.agree, false);
  assert.deepEqual(result.differences, [{ class: 'planner-failed', issue: null, codes: [], detail: 'GITHUB_QUERY_FAILED: boom' }]);
});

test('classifyEvaluation: an unknown excluded issue reads as code unknown, not as agreement', () => {
  const result = classifyEvaluation({ hookFrontier: [5], planner: planner([]) });
  assert.deepEqual(result.differences, [{ class: 'planner-excludes', issue: 5, codes: ['unknown'] }]);
});

test('observeFrontier appends one day-partitioned line with both sides and the mode from the flag', () => {
  const root = rootDir();
  const line = evaluate(root, T0, [7], planner([7]));
  assert.equal(line.mode, 'shadow');
  assert.equal(line.agree, true);
  assert.deepEqual(line.hook.frontier, [7]);
  assert.deepEqual(line.planner.frontier, [7]);
  fs.writeFileSync(path.join(root, 'state', 'flags', 'assignment-live'), 'live');
  const live = evaluate(root, T0 + MIN, [7], planner([7]));
  assert.equal(live.mode, 'live');
  const file = path.join(root, 'state', 'assignment', 'shadow', '20260904.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((entry) => JSON.parse(entry));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].mode, 'live');
  assert.equal(readShadow(root, 'endzone').length, 2);
  assert.equal(readShadow(root, 'other').length, 0);
});

test('compareAssignmentParity fails below the required evaluation count', () => {
  const root = rootDir();
  evaluate(root, T0, [1], planner([1]));
  evaluate(root, T0 + MIN, [2], planner([2]));
  const result = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /evaluations 2 < required 4/);
});

test('compareAssignmentParity passes on identical recent evaluations with enough distinct frontiers', () => {
  const root = rootDir();
  evaluate(root, T0, [1], planner([1]));
  evaluate(root, T0 + MIN, [1], planner([1]));
  evaluate(root, T0 + 2 * MIN, [], planner([]));
  evaluate(root, T0 + 3 * MIN, [1, 2], planner([2, 1]));
  const result = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(result.pass, true, result.reasons.join('; '));
  assert.equal(result.evaluations, 4);
  assert.equal(result.distinctFrontiers, 3);
  assert.equal(result.classes.identical, 4);
  assert.deepEqual(result.unapproved, []);
});

test('compareAssignmentParity fails when the recent evaluations are one frontier repeated', () => {
  const root = rootDir();
  for (let index = 0; index < 5; index += 1) evaluate(root, T0 + index * MIN, [1], planner([1]));
  const result = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /distinct frontiers 1 < required 2/);
});

// Window exclusion has its own case below; this one is about a difference gating at all.
test('compareAssignmentParity: an unapproved difference fails the gate', () => {
  const root = rootDir();
  evaluate(root, T0 - 10 * MIN, [9], planner([9]));
  evaluate(root, T0, [1], planner([1]));
  evaluate(root, T0 + MIN, [2], planner([2]));
  evaluate(root, T0 + 2 * MIN, [3], planner([3]));
  evaluate(root, T0 + 3 * MIN, [4], planner([4]));
  assert.equal(compareAssignmentParity({ root, tenant: 'endzone' }).pass, true);
  evaluate(root, T0 + 4 * MIN, [5, 6], planner([5], [{ issue: 6, reasons: [{ code: 'spec-parent' }] }]));
  const failed = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(failed.pass, false);
  assert.equal(failed.unapproved.length, 1);
  assert.equal(failed.unapproved[0].issue, 6);
  assert.equal(failed.unapproved[0].at, iso(T0 + 4 * MIN));
});

test('compareAssignmentParity: approvals match by class and code, and a planner failure is never approvable by code alone', () => {
  const root = rootDir();
  evaluate(root, T0, [1], planner([1]));
  evaluate(root, T0 + MIN, [2, 8], planner([2], [{ issue: 8, reasons: [{ code: 'spec-parent' }] }]));
  evaluate(root, T0 + 2 * MIN, [3], planner([3]));
  evaluate(root, T0 + 3 * MIN, [4], planner([4], [], 'boom'));
  fs.mkdirSync(path.join(root, 'state', 'assignment'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'assignment', 'parity-approved.json'), JSON.stringify([
    { class: 'planner-excludes', code: 'spec-parent', note: 'the planner reads sub-issues; the hook cannot', by: 'cory', at: iso(T0) },
  ]));
  const result = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(result.pass, false);
  assert.equal(result.unapproved.length, 1);
  assert.equal(result.unapproved[0].class, 'planner-failed');
  const approved = result.differences.find((diff) => diff.class === 'planner-excludes');
  assert.equal(approved.approved, true);
  assert.equal(approved.approvedBy, 'cory');
});

test('compareAssignmentParity ignores a torn line and a BOM in the approvals file', () => {
  const root = rootDir();
  evaluate(root, T0, [1], planner([1]));
  evaluate(root, T0 + MIN, [2], planner([2]));
  evaluate(root, T0 + 2 * MIN, [3], planner([3]));
  evaluate(root, T0 + 3 * MIN, [4], planner([4]));
  fs.appendFileSync(path.join(root, 'state', 'assignment', 'shadow', '20260904.jsonl'), '{"at":"2026-09-04T00:09:00.000Z","ten');
  fs.mkdirSync(path.join(root, 'state', 'assignment'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'assignment', 'parity-approved.json'), '﻿[]');
  const result = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(result.pass, true, result.reasons.join('; '));
  assert.equal(result.evaluations, 4);
});

test('approvals: `code` matches by membership, `codes` requires the exact set', () => {
  const root = rootDir({ parityEvaluations: 2, parityDistinctFrontiers: 1, parityHours: 0 });
  // Two differences on one evaluation: a bare `assigned`, and `assigned` compounded with a
  // dependency-read divergence, which is the difference the gate most needs to surface.
  evaluate(root, T0, [11, 12], planner([], [
    { issue: 11, reasons: [{ code: 'assigned' }] },
    { issue: 12, reasons: [{ code: 'assigned' }, { code: 'dependency-blocked' }] },
  ]));
  evaluate(root, T0 + MIN, [13], planner([13]));
  const approvalsPath = path.join(root, 'state', 'assignment', 'parity-approved.json');
  const write = (entries) => fs.writeFileSync(approvalsPath, JSON.stringify(entries));

  write([{ class: 'planner-excludes', code: 'assigned', note: 'loose', by: 'cory', at: iso(T0) }]);
  const loose = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(loose.unapproved.length, 0, 'the membership form blesses the compound difference too');

  write([{ class: 'planner-excludes', codes: ['assigned'], note: 'exact', by: 'cory', at: iso(T0) }]);
  const exact = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(exact.unapproved.length, 1);
  assert.equal(exact.unapproved[0].issue, 12);
  assert.deepEqual(exact.unapproved[0].codes, ['assigned', 'dependency-blocked']);

  write([{ class: 'planner-excludes', codes: ['dependency-blocked', 'assigned'], note: 'order does not matter', by: 'cory', at: iso(T0) }]);
  const reordered = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(reordered.unapproved.length, 1);
  assert.equal(reordered.unapproved[0].issue, 11);
});

// 02/03 review 2026-09-06: the window was the last N evaluations, required to span
// parityHours. A working lead appends evaluations faster than the span grows, so the
// trailing-N window kept shrinking back and the gate could not be reached by operating
// normally (measured: ~8 h under normal cadence, 30 h only after a 23 h idle stretch).
// The window is now the trailing parityHours of evaluations: new work no longer pushes
// the old evidence out, so the gate converges.
test('the window is the trailing parityHours, so a busy lead cannot shrink it back', () => {
  const root = rootDir({ parityHours: 10, parityEvaluations: 4, parityDistinctFrontiers: 2 });
  // Evidence spread across 12 hours, then a burst of agreeing evaluations in the last minutes.
  evaluate(root, T0, [1], planner([1]));
  evaluate(root, T0 + 4 * 60 * MIN, [2], planner([2]));
  evaluate(root, T0 + 8 * 60 * MIN, [3], planner([3]));
  for (let index = 0; index < 30; index += 1) evaluate(root, T0 + 12 * 60 * MIN + index * MIN, [4], planner([4]));
  const result = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(result.pass, true, result.reasons.join('; '));
  assert.equal(result.evaluations, 32, 'every evaluation inside the trailing window counts, not just the last N');
  assert.ok(result.spanHours >= 8, `the burst must not shrink the window (span ${result.spanHours} h)`);
});

test('a burst of evaluations inside one short stretch fails the span requirement', () => {
  const root = rootDir({ parityHours: 10, parityEvaluations: 4, parityDistinctFrontiers: 2 });
  for (let index = 0; index < 40; index += 1) evaluate(root, T0 + index * MIN, [index % 3], planner([index % 3]));
  const result = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /spans/);
});

test('evaluations older than the window neither count nor gate', () => {
  const root = rootDir({ parityHours: 10, parityEvaluations: 3, parityDistinctFrontiers: 2 });
  // An unapproved difference from before the window must not block a clean window.
  evaluate(root, T0, [8, 9], planner([8], [{ issue: 9, reasons: [{ code: 'spec-parent' }] }]));
  evaluate(root, T0 + 30 * 60 * MIN, [1], planner([1]));
  evaluate(root, T0 + 35 * 60 * MIN, [2], planner([2]));
  evaluate(root, T0 + 40 * 60 * MIN, [3], planner([3]));
  const result = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.equal(result.evaluations, 3, 'the stale evaluation is outside the trailing window');
  assert.deepEqual(result.unapproved, [], 'and its difference does not gate');
  assert.equal(result.pass, true, result.reasons.join('; '));
});

// --- fleet#4: the seven read-only reporters adopt the parseArgs flag schema --------
// Red-tell: with bin/assignment-parity.js reverted to its old hand-rolled parseArgs
// (no schema, no per-command dispatch guard), every case below either fails to throw
// or throws the wrong thing.

function refusesUsage(argv, fragment) {
  assert.throws(() => cli(argv), (error) => {
    assert.ok(error instanceof AssignmentParityError, `expected AssignmentParityError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.code, 'USAGE');
    if (fragment) assert.match(error.message, fragment);
    return true;
  });
}

test('cli: observe refuses --repo-path (the assignment.js name) as an unknown flag, naming the accepted set', () => {
  const root = rootDir();
  refusesUsage(['observe', '--root', root, '--tenant', 'endzone', '--repo-path', '/e/repo'], /unknown flag --repo-path/);
  assert.throws(() => cli(['observe', '--root', root, '--repo-path', '/e/repo']), (error) => {
    for (const flag of ASSIGNMENT_PARITY_FLAGS.observe) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('cli: report refuses --tenant-name as an unknown flag, naming the accepted set', () => {
  const root = rootDir();
  refusesUsage(['report', '--root', root, '--tenant-name', 'endzone'], /unknown flag --tenant-name/);
  assert.throws(() => cli(['report', '--root', root, '--tenant-name', 'endzone']), (error) => {
    for (const flag of ASSIGNMENT_PARITY_FLAGS.report) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('cli: an unknown command is a usage error naming the known commands', () => {
  refusesUsage(['obseve', '--root', 'x'], /unknown command 'obseve'; commands: observe, report/);
});

test('cli: a correct report invocation still works, matching the direct call', () => {
  const root = rootDir();
  evaluate(root, T0, [1], planner([1]));
  const viaCli = cli(['report', '--root', root, '--tenant', 'endzone', '--json', 'true']);
  const direct = compareAssignmentParity({ root, tenant: 'endzone' });
  assert.deepEqual(viaCli, direct);
});

test('spawnSync: a typo on `report` exits 64 (EX_USAGE) with nothing on stdout, distinct from a FAILED gate (exit 2)', () => {
  const bin = path.join(__dirname, '..', 'bin', 'assignment-parity.js');
  const root = rootDir();
  evaluate(root, T0, [1], planner([1]));

  const typo = spawnSync(process.execPath, [bin, 'report', '--root', root, '--tenant-name', 'endzone'], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 64);
  assert.equal(typo.stdout, '');
  assert.equal(JSON.parse(typo.stderr).code, 'USAGE');

  // A correct invocation over the same (necessarily thin) evidence fails the GATE, not
  // the flag schema: exit 2, distinct from the typo's exit 64.
  const ok = spawnSync(process.execPath, [bin, 'report', '--root', root, '--tenant', 'endzone', '--json', 'true'], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.status, 2);
  assert.equal(JSON.parse(ok.stdout).pass, false);
});
