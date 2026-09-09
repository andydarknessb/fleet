const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  acknowledgeAssignment,
  buildManifest,
  buildLaunchPlan,
  invalidateManifest,
  launchReservedAssignment,
  queryGithubIssues,
  resolveRemoteBase,
  reserveAssignment,
  selectFrontier,
  validateManifest,
} = require('../bin/assignment');
const { getRecord, reserveRecord } = require('../bin/work-state');

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-assignment-'));
}

function issue(number, overrides = {}) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    body: `criteria for ${number}`,
    createdAt: `2026-09-01T00:00:${String(number).padStart(2, '0')}.000Z`,
    state: 'OPEN',
    labels: ['ready-for-agent'],
    assignees: [],
    ...overrides,
  };
}

test('frontier ordering and exclusion evidence are deterministic', () => {
  const issues = [
    issue(9), issue(3),
    issue(4, { assignees: ['cory'] }),
    issue(5, { dependencies: [{ number: 2, state: 'OPEN' }] }),
    issue(6, { subIssuesSummary: { completed: 0, total: 2 } }),
    issue(7, { labels: ['ready-for-agent', 'ready-for-human'] }),
    issue(8, { components: ['src/shared'] }),
    issue(10),
  ];
  const active = [{ id: 'endzone:issue-8', issue: 8, state: 'implementing', reservations: { components: ['src/shared'] } }];
  const skipIssues = { issues: { '10': 'human-only evidence' } };
  const first = selectFrontier({ issues, readyLabel: 'ready-for-agent', active, skipIssues, now: '2026-09-01T12:00:00.000Z' });
  const second = selectFrontier({ issues: [...issues].reverse(), readyLabel: 'ready-for-agent', active, skipIssues, now: '2026-09-01T12:00:00.000Z' });
  assert.deepEqual(first.eligible.map((entry) => entry.number), [3, 9]);
  assert.deepEqual(second.eligible.map((entry) => entry.number), [3, 9]);
  const excluded = new Map(first.excluded.map((entry) => [entry.issue, entry.reasons.map((reason) => reason.code)]));
  assert.ok(excluded.get(4).includes('assigned'));
  assert.ok(excluded.get(5).includes('dependency-blocked'));
  assert.ok(excluded.get(6).includes('spec-parent'));
  assert.ok(excluded.get(7).includes('ready-for-human'));
  assert.ok(excluded.get(8).includes('reserved'));
  assert.ok(excluded.get(8).includes('reservation-conflict'));
  assert.ok(excluded.get(10).includes('frontier-exclusion'));
});

test('reservation attempts cannot claim the same component', () => {
  const root = rootDir();
  reserveRecord({ root, id: 'endzone:issue-40', tenant: 'endzone', issue: 40, reservations: { components: ['src/shared'] }, idempotencyKey: 'reserve-0', now: '2026-09-01T00:00:00.000Z' });
  assert.throws(() => reserveRecord({ root, id: 'endzone:issue-41', tenant: 'endzone', issue: 41, reservations: { components: ['src/shared'] }, idempotencyKey: 'reserve-1', now: '2026-09-01T00:00:00.000Z' }), (error) => error.code === 'RESERVATION_CONFLICT' && error.conflicts[0].issue === 40);
});

test('assignment creates one immutable manifest and reserves a Work record', () => {
  const root = rootDir();
  const result = reserveAssignment({
    root,
    issue: issue(42),
    tenant: 'endzone',
    tenantConfig: { branchPrefix: 'fleet/', defaultBranch: 'integration' },
    readyLabel: 'ready-for-agent',
    base: { remote: 'origin', ref: 'integration', sha: 'a'.repeat(40) },
    parent: 'pl-endzone',
    model: 'sonnet',
    risk: 'standard',
    tokenBudget: 25000,
    contextHeadings: ['Draft workflow'],
    adrPaths: ['docs/adr/0002-one-launch-door.md'],
    testPlan: ['node --test tests/assignment.tests.js'],
    ciGates: ['test-build'],
    now: '2026-09-01T00:00:00.000Z',
  });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.issue.body, undefined);
  assert.equal(manifest.issue.bodyHash.length, 64);
  assert.equal(manifest.workRecordId, 'endzone:issue-42');
  assert.equal(manifest.base.sha, 'a'.repeat(40));
  assert.equal(getRecord({ root, id: 'endzone:issue-42' }).state, 'assigned');
  assert.throws(() => fs.writeFileSync(result.manifestPath, '{}', { flag: 'wx' }), /EEXIST/);
  const launch = launchReservedAssignment({ manifestPath: result.manifestPath, workRecordId: manifest.workRecordId, dryRun: true });
  assert.equal(launch.dryRun, true);
  assert.ok(launch.command.includes('-Manifest'));
  assert.ok(launch.command.includes('-WorkRecordId'));
  acknowledgeAssignment({ root, workRecordId: manifest.workRecordId, expectedRevision: 1, now: '2026-09-01T00:01:00.000Z' });
  assert.throws(() => launchReservedAssignment({ root, manifestPath: result.manifestPath, workRecordId: manifest.workRecordId, dryRun: true }), (error) => error.code === 'ASSIGNMENT_ALREADY_ACKNOWLEDGED');
});

test('changed criteria invalidate the manifest and release reservations', () => {
  const root = rootDir();
  const result = reserveAssignment({
    root, issue: issue(43), tenant: 'endzone', tenantConfig: { branchPrefix: 'fleet/' }, readyLabel: 'ready-for-agent',
    base: { remote: 'origin', ref: 'integration', sha: 'b'.repeat(40) }, now: '2026-09-01T00:00:00.000Z',
  });
  const invalid = validateManifest({ manifest: JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')), issue: issue(43, { body: 'changed criteria' }), base: { sha: 'b'.repeat(40) } });
  assert.equal(invalid.valid, false);
  const released = invalidateManifest({ root, manifest: JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')), currentRevision: 1, reason: invalid.mismatches, now: '2026-09-01T00:01:00.000Z' });
  assert.equal(released.released.record.state, 'released');
  assert.equal(fs.existsSync(released.invalidationPath), true);
  assert.throws(() => launchReservedAssignment({ root, manifestPath: result.manifestPath, workRecordId: 'endzone:issue-43', dryRun: true }), (error) => error.code === 'MANIFEST_INVALIDATED');

  const retry = reserveAssignment({
    root, issue: issue(43), tenant: 'endzone', tenantConfig: { branchPrefix: 'fleet/' }, readyLabel: 'ready-for-agent',
    base: { remote: 'origin', ref: 'integration', sha: 'b'.repeat(40) }, now: '2026-09-01T00:02:00.000Z',
  });
  assert.equal(retry.manifest.workRecordRevision, 3);
  assert.match(retry.manifest.id, /-r3$/);
  assert.equal(retry.reservation.revision, 3);
  assert.equal(getRecord({ root, id: 'endzone:issue-43' }).state, 'assigned');
});

test('base resolution fetches the remote ref before reading its SHA', () => {
  const calls = [];
  const runner = (executable, args) => {
    calls.push([executable, args]);
    return args[2] === 'rev-parse' ? `${'c'.repeat(40)}\n` : '';
  };
  const result = resolveRemoteBase({ repoPath: 'C:/repo', remote: 'origin', ref: 'integration', runner });
  assert.equal(result.sha, 'c'.repeat(40));
  assert.equal(calls[0][1][2], 'fetch');
  assert.equal(calls[1][1][2], 'rev-parse');
});

test('GitHub detail query carries dependency and sub-issue signals into selection', () => {
  const runner = (executable, args) => {
    assert.equal(args[0], 'api');
    return JSON.stringify({ data: { repository: { issues: { nodes: [{
      number: 44, title: 'Issue 44', url: 'https://github.com/example/repo/issues/44', body: 'criteria', createdAt: '2026-09-01T00:00:00Z', state: 'OPEN',
      labels: { nodes: [{ name: 'ready-for-agent' }] }, assignees: { nodes: [] }, blockedBy: { nodes: [{ number: 12, state: 'OPEN' }] }, subIssues: { nodes: [] },
    }] } } } });
  };
  const issues = queryGithubIssues({ repo: 'example/repo', readyLabel: 'ready-for-agent', runner, fetchDetails: true });
  assert.equal(issues[0].dependencies[0].number, 12);
  assert.equal(issues[0].bodyHash.length, 64);
});

test('a third assignment requires and records an independence proof', () => {
  const frontier = { eligible: [issue(50), issue(51), issue(52)] };
  const active = [
    { id: 'endzone:issue-40', issue: 40, state: 'implementing', manifestPath: 'm40', reservations: {} },
    { id: 'endzone:issue-41', issue: 41, state: 'implementing', manifestPath: 'm41', reservations: {} },
  ];
  const plan = buildLaunchPlan({ frontier, active, maxIcs: 3 });
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.thirdProof.independent, true);
  assert.throws(() => reserveAssignment({ root: rootDir(), issue: issue(53), tenant: 'endzone', active, readyLabel: 'ready-for-agent', base: { remote: 'origin', ref: 'integration', sha: 'd'.repeat(40) } }), (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF');
});

// 02/03 review 2026-09-06: this tenant runs the fleet under the same GitHub account that
// works it by hand, so an assignee cannot tell "a person claimed this" from "a fleet
// session claimed it", and nothing ever removes one. Excluding on a self-assignment made
// an issue permanently invisible to the frontier. `fleetIdentity` scopes the rule to a
// genuinely foreign assignee; a tenant with real multi-account ownership leaves it unset
// and keeps the original behaviour.
test('frontier excludes an issue assigned to someone else, not one the fleet assigned itself', () => {
  const mine = issue(60, { assignees: [{ login: 'andydarknessb' }] });
  const theirs = issue(61, { assignees: [{ login: 'someone-else' }] });
  const both = issue(62, { assignees: [{ login: 'andydarknessb' }, { login: 'someone-else' }] });

  const scoped = selectFrontier({ issues: [mine, theirs, both], readyLabel: 'ready-for-agent', fleetIdentity: 'AndyDarknessB' });
  assert.deepEqual(scoped.eligible.map((entry) => entry.number), [60], 'a self-assignment must not park an issue forever');
  const scopedCodes = Object.fromEntries(scoped.excluded.map((entry) => [entry.issue, entry.reasons.map((reason) => reason.code)]));
  assert.deepEqual(scopedCodes[61], ['assigned']);
  assert.deepEqual(scopedCodes[62], ['assigned'], 'a foreign assignee still excludes even alongside the fleet identity');
  assert.match(scoped.excluded.find((entry) => entry.issue === 62).reasons[0].detail, /someone-else/);
  assert.doesNotMatch(scoped.excluded.find((entry) => entry.issue === 62).reasons[0].detail, /andydarknessb/);

  const unscoped = selectFrontier({ issues: [mine, theirs], readyLabel: 'ready-for-agent' });
  assert.deepEqual(unscoped.eligible.map((entry) => entry.number), [], 'without a fleet identity every assignee still excludes');
});

// Amendment 14 (2026-09-09): an IC is haiku or sonnet at effort high, never opus. The
// planner is the live launch path, so the rule is enforced where the manifest is made.
test('assignment refuses an IC model outside haiku/sonnet and defaults to sonnet', () => {
  const base = { remote: 'origin', ref: 'integration', sha: 'e'.repeat(40) };
  assert.throws(
    () => reserveAssignment({ root: rootDir(), issue: issue(70), tenant: 'endzone', readyLabel: 'ready-for-agent', base, model: 'opus' }),
    (error) => error.code === 'INVALID_IC_MODEL' && /haiku|sonnet/.test(error.message),
  );
  const haiku = reserveAssignment({ root: rootDir(), issue: issue(71), tenant: 'endzone', readyLabel: 'ready-for-agent', base, model: 'haiku' });
  assert.equal(haiku.manifest.model, 'haiku');
  const defaulted = reserveAssignment({ root: rootDir(), issue: issue(72), tenant: 'endzone', readyLabel: 'ready-for-agent', base });
  assert.equal(defaulted.manifest.model, 'sonnet');
  assert.equal(reserveAssignment({ root: rootDir(), issue: issue(73), tenant: 'endzone', readyLabel: 'ready-for-agent', base, model: 'Sonnet' }).manifest.model, 'sonnet', 'case is not a distinction');
});
