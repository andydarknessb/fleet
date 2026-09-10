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
  normalizeIssue,
  queryGithubIssues,
  resolveRemoteBase,
  reserveAssignment,
  selectFrontier,
  sha256,
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
  assert.equal(manifest.issue.criteriaHash.length, 64);
  assert.equal(manifest.issue.commentCount, 0);
  assert.equal(manifest.workRecordId, 'endzone:issue-42');
  assert.equal(manifest.base.sha, 'a'.repeat(40));
  const record = getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(record.state, 'assigned');
  assert.equal(record.github.criteriaHash, manifest.issue.criteriaHash);
  assert.equal(record.github.commentCount, 0);
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

test('a comment-only correction invalidates the manifest criteria', () => {
  const root = rootDir();
  const original = issue(44, { comments: [{ id: 'comment-1', createdAt: '2026-09-01T00:00:00Z', body: 'Use the original ruling.' }] });
  const result = reserveAssignment({
    root, issue: original, tenant: 'endzone', tenantConfig: { branchPrefix: 'fleet/' }, readyLabel: 'ready-for-agent',
    base: { remote: 'origin', ref: 'integration', sha: 'b'.repeat(40) }, now: '2026-09-01T00:00:00.000Z',
  });
  const corrected = issue(44, { comments: [{ id: 'comment-1', createdAt: '2026-09-01T00:00:00Z', body: 'CORRECTION: use the replacement ruling.' }] });
  const validation = validateManifest({ manifest: result.manifest, issue: corrected, base: { sha: 'b'.repeat(40) } });
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.mismatches.map((mismatch) => mismatch.field), ['issue.criteriaHash']);
});

test('GitHub detail query carries dependency and sub-issue signals into selection', () => {
  const runner = (executable, args) => {
    assert.equal(args[0], 'api');
    assert.match(args.find((arg) => String(arg).startsWith('query=')), /comments\(first:100\)/);
    return JSON.stringify({ data: { repository: { issues: { nodes: [{
      number: 44, title: 'Issue 44', url: 'https://github.com/example/repo/issues/44', body: 'criteria', createdAt: '2026-09-01T00:00:00Z', state: 'OPEN',
      labels: { nodes: [{ name: 'ready-for-agent' }] }, assignees: { nodes: [] }, blockedBy: { nodes: [{ number: 12, state: 'OPEN' }] }, subIssues: { nodes: [] },
      comments: { nodes: [{ id: 'comment-1', createdAt: '2026-09-01T01:00:00Z', body: 'Correction' }], pageInfo: { hasNextPage: false } },
    }] } } } });
  };
  const issues = queryGithubIssues({ repo: 'example/repo', readyLabel: 'ready-for-agent', runner, fetchDetails: true });
  assert.equal(issues[0].dependencies[0].number, 12);
  assert.equal(issues[0].bodyHash.length, 64);
  assert.equal(issues[0].criteriaHash.length, 64);
  assert.equal(issues[0].comments[0].body, 'Correction');
});

test('frontier fails closed when the issue comment thread is truncated', () => {
  const result = selectFrontier({ issues: [issue(45, { commentsTruncated: true })], readyLabel: 'ready-for-agent' });
  assert.equal(result.eligible.length, 0);
  assert.deepEqual(result.excluded[0].reasons.map((reason) => reason.code), ['issue-comments-truncated']);
});

test('a third assignment requires and records an independence proof', () => {
  const frontier = { eligible: [issue(50, { components: ['src/50.js'] }), issue(51, { components: ['src/51.js'] }), issue(52, { components: ['src/52.js'] })] };
  const active = [
    { id: 'endzone:issue-40', issue: 40, state: 'implementing', manifestPath: 'm40', reservations: { components: ['src/40.js'] } },
    { id: 'endzone:issue-41', issue: 41, state: 'implementing', manifestPath: 'm41', reservations: { components: ['src/41.js'] } },
  ];
  const plan = buildLaunchPlan({ frontier, active, maxIcs: 3 });
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.thirdProof.independent, true);
  assert.throws(() => reserveAssignment({ root: rootDir(), issue: issue(53), tenant: 'endzone', active, readyLabel: 'ready-for-agent', base: { remote: 'origin', ref: 'integration', sha: 'd'.repeat(40) } }), (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF');
});

test('issue criteria derive typed reservations from body and comment paths', () => {
  const normalized = normalizeIssue(issue(54, {
    body: 'Change `src/entities/roster/model/lineupModel.js` and migration `server/db/migrations/20260910000001_roster.js`.',
    comments: [{ body: 'Export it from `shared/ui`, pin it in `src/entities/roster/model/lineupModel.test.js`, and update the `players` table. Findings artifact: `state/reviews/endzone_issue-54/formal-001.json`.' }],
  }));

  assert.deepEqual(normalized.reservations, {
    components: ['src/entities/roster/model/lineupModel.js', 'src/shared/ui'],
    migrationPrefixes: ['20260910000001'],
    schemaAreas: ['players'],
    testResources: ['src/entities/roster/model/lineupModel.test.js'],
  });
});

test('legacy active records use matching GitHub criteria for third-assignment proof and conflicts', () => {
  const activeIssues = [
    issue(40, { body: 'Owns `src/entities/activity/model/activityModel.js`.' }),
    issue(41, { body: 'Owns `src/components/common/AbbreviationTooltip.jsx`.' }),
  ];
  const active = [
    { id: 'endzone:issue-40', issue: 40, state: 'implementing', manifestPath: 'm40', github: { bodyHash: sha256(activeIssues[0].body) }, reservations: {} },
    { id: 'endzone:issue-41', issue: 41, state: 'implementing', manifestPath: 'm41', github: { bodyHash: sha256(activeIssues[1].body) }, reservations: {} },
  ];
  const independent = issue(50, { body: 'Owns `docs/adr/0031-island.md`.' });
  const conflict = issue(51, { body: 'Also changes `src/entities/activity/model/activityModel.js`.' });

  const independentPlan = buildLaunchPlan({ frontier: { eligible: [independent] }, active, issues: [...activeIssues, independent], maxIcs: 3 });
  assert.equal(independentPlan.assignments.length, 1);
  assert.equal(independentPlan.thirdProof.independent, true);
  assert.deepEqual(independentPlan.thirdProof.missingReservations, []);

  const conflictPlan = buildLaunchPlan({ frontier: { eligible: [conflict] }, active, issues: [...activeIssues, conflict], maxIcs: 3 });
  assert.equal(conflictPlan.assignments.length, 0);
  assert.equal(conflictPlan.thirdProof.independent, false);
  assert.deepEqual(conflictPlan.thirdProof.conflicts, [{ left: 40, right: 51 }]);

  const staleActive = [{ ...active[0], github: { bodyHash: '0'.repeat(64) } }, active[1]];
  const stalePlan = buildLaunchPlan({ frontier: { eligible: [independent] }, active: staleActive, issues: [...activeIssues, independent], maxIcs: 3 });
  assert.equal(stalePlan.assignments.length, 0);
  assert.deepEqual(stalePlan.thirdProof.missingReservations, [40]);
});

test('third-assignment proof still fails closed when criteria name no reservable surface', () => {
  const issues = [issue(40, { body: 'Change `src/a.js`.' }), issue(41, { body: 'Change `src/b.js`.' }), issue(52, { body: 'Improve the experience.' })];
  const active = [
    { id: 'endzone:issue-40', issue: 40, state: 'implementing', manifestPath: 'm40', github: { bodyHash: sha256(issues[0].body) }, reservations: {} },
    { id: 'endzone:issue-41', issue: 41, state: 'implementing', manifestPath: 'm41', github: { bodyHash: sha256(issues[1].body) }, reservations: {} },
  ];
  const plan = buildLaunchPlan({ frontier: { eligible: [issues[2]] }, active, issues, maxIcs: 3 });

  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.thirdProof.independent, false);
  assert.deepEqual(plan.thirdProof.missingReservations, [52]);
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
