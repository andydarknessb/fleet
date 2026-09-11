const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { spawnSync } = require('node:child_process');

const {
  FLAGS,
  acknowledgeAssignment,
  cli,
  buildManifest,
  buildLaunchPlan,
  independenceProof,
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
const { WorkStateError, getRecord, reserveRecord } = require('../bin/work-state');

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

test('a directory reservation conflicts with a file inside it, but not a sibling prefix', () => {
  const active = [
    { id: 'endzone:issue-1146', issue: 1146, state: 'implementing', manifestPath: 'm1146', reservations: { components: ['src/widgets/my-team-summary/ui/MyTeamSummary.jsx'] } },
    { id: 'endzone:issue-1149', issue: 1149, state: 'implementing', manifestPath: 'm1149', reservations: { components: ['src/entities/matchup/model/play.js'] } },
  ];
  const overlap = issue(1150, { components: ['src/widgets/my-team-summary'] });
  const overlapPlan = buildLaunchPlan({ frontier: { eligible: [overlap] }, active, maxIcs: 3 });
  assert.equal(overlapPlan.assignments.length, 0);
  assert.equal(overlapPlan.thirdProof.independent, false);
  assert.deepEqual(overlapPlan.thirdProof.conflicts, [{ left: 1146, right: 1150 }]);

  const sibling = issue(1151, { components: ['src/widgets/my-team-summary-v2'] });
  const siblingPlan = buildLaunchPlan({ frontier: { eligible: [sibling] }, active, maxIcs: 3 });
  assert.equal(siblingPlan.assignments.length, 1);
  assert.equal(siblingPlan.thirdProof.independent, true);
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

test('a third assignment fails closed without reservation evidence', () => {
  const frontier = { eligible: [issue(50), issue(51), issue(52)] };
  const active = [
    { id: 'endzone:issue-40', issue: 40, state: 'implementing', manifestPath: 'm40', reservations: {} },
    { id: 'endzone:issue-41', issue: 41, state: 'implementing', manifestPath: 'm41', reservations: {} },
  ];
  const plan = buildLaunchPlan({ frontier, active, maxIcs: 3 });
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.thirdProof.independent, false);
  assert.deepEqual(plan.thirdProof.missingReservations, [40, 41, 50]);
  assert.throws(() => reserveAssignment({ root: rootDir(), issue: issue(53), tenant: 'endzone', active, readyLabel: 'ready-for-agent', base: { remote: 'origin', ref: 'integration', sha: 'd'.repeat(40) } }), (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF');
  const forged = { independent: true, candidates: [40, 41, 53], checkedFields: ['components', 'migrationPrefixes', 'schemaAreas', 'testResources'], conflicts: [] };
  assert.throws(() => reserveAssignment({ root: rootDir(), issue: issue(53), tenant: 'endzone', active, readyLabel: 'ready-for-agent', base: { remote: 'origin', ref: 'integration', sha: 'd'.repeat(40) }, independenceProof: forged }), (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF');
});

test('a third assignment is proven only by populated non-overlapping reservations', () => {
  const active = [
    { id: 'endzone:issue-40', issue: 40, state: 'implementing', manifestPath: 'm40', reservations: { components: ['bin/a.js'] } },
    { id: 'endzone:issue-41', issue: 41, state: 'implementing', manifestPath: 'm41', reservations: { components: ['bin/b.js'] } },
  ];
  const plan = buildLaunchPlan({ frontier: { eligible: [issue(52, { components: ['bin/c.js'] })] }, active, maxIcs: 3 });
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.thirdProof.independent, true);
  assert.deepEqual(plan.thirdProof.missingReservations, []);

  const conflict = independenceProof([...active, normalizeIssue(issue(53, { components: ['bin/a.js'] }))]);
  assert.equal(conflict.independent, false);
  assert.deepEqual(conflict.conflicts, [{ left: 40, right: 53 }]);
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
// Fleet #28 (2026-09-11): the CLI has no auto mode for claude-haiku-4-5, so the haiku
// tier is suspended at the planner (the refusal names the cause, not just the list).
test('assignment refuses an IC model outside sonnet, refuses haiku by name, and defaults to sonnet', () => {
  const base = { remote: 'origin', ref: 'integration', sha: 'e'.repeat(40) };
  assert.throws(
    () => reserveAssignment({ root: rootDir(), issue: issue(70), tenant: 'endzone', readyLabel: 'ready-for-agent', base, model: 'opus' }),
    (error) => error.code === 'INVALID_IC_MODEL' && /haiku|sonnet/.test(error.message),
  );
  assert.throws(
    () => reserveAssignment({ root: rootDir(), issue: issue(71), tenant: 'endzone', readyLabel: 'ready-for-agent', base, model: 'haiku' }),
    (error) => error.code === 'INVALID_IC_MODEL' && /auto mode/.test(error.message) && /fleet #28/.test(error.message),
    'haiku is refused with the CLI auto-mode cause named',
  );
  const defaulted = reserveAssignment({ root: rootDir(), issue: issue(72), tenant: 'endzone', readyLabel: 'ready-for-agent', base });
  assert.equal(defaulted.manifest.model, 'sonnet');
  assert.equal(reserveAssignment({ root: rootDir(), issue: issue(73), tenant: 'endzone', readyLabel: 'ready-for-agent', base, model: 'Sonnet' }).manifest.model, 'sonnet', 'case is not a distinction');
});

// --- fleet#4: assignment.js adopts the parseArgs flag schema -----------------
// Before this, `cli()` used its own permissive parser: a typo'd flag fell into a
// bucket nothing read and the command answered as if it had not been given.
// `assign --base <sha>` reserved from the remote as if no base were pinned,
// `launch --repo owner/name` launched with no GitHub repo, `ack --revision 3`
// acknowledged with expectedRevision NaN. This binary shares the confusable
// names with review-policy.js classify (`--repo` here is the GitHub owner/name,
// `--repo-path` the checkout, `--tenant-config` the tenant file), which is why
// it went last (ruling 1). Every case below goes through `cli`, the door the
// lead's role file and the hooks use.
//
// Red-tell: with bin/assignment.js stashed back to its own parseArgs and no
// FLAGS, every USAGE case below fails (the typo resolves to undefined instead
// of throwing) and `require('../bin/assignment')` exports neither cli nor FLAGS.

function usageError(argv, fragment) {
  assert.throws(() => cli(argv), (error) => {
    assert.ok(error instanceof WorkStateError, `expected WorkStateError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.code, 'USAGE');
    if (fragment) assert.match(error.message, fragment);
    return true;
  });
}

test('cli: every command declares its accepted flags, and an unknown command is a usage error', () => {
  assert.deepEqual(Object.keys(FLAGS).sort(), ['ack', 'assign', 'frontier', 'launch', 'proof', 'validate']);
  usageError(['reserve', '--root', rootDir()], /unknown command 'reserve'/);
  usageError([], /unknown command/);
});

test('cli: frontier refuses --repo-path (the checkout) where --repo (owner/name) is meant', () => {
  usageError(['frontier', '--root', rootDir(), '--tenant', 'endzone', '--repo-path', 'E:/Endzone-Empire'], /unknown flag --repo-path/);
});

test('cli: frontier refuses --tenant-file for --tenant-config, naming the accepted set', () => {
  assert.throws(() => cli(['frontier', '--root', rootDir(), '--tenant-file', 'x.json']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.equal(error.flag, 'tenant-file');
    assert.deepEqual(error.accepted, FLAGS.frontier);
    assert.match(error.message, /--tenant-config/);
    return true;
  });
});

test('cli: assign refuses --base for --base-sha instead of reserving from the remote as if unpinned', () => {
  usageError(['assign', '--root', rootDir(), '--tenant', 'endzone', '--base', 'a'.repeat(40)], /unknown flag --base/);
});

test('cli: assign refuses --proof for --independence-proof and the singular list names', () => {
  const root = rootDir();
  usageError(['assign', '--root', root, '--tenant', 'endzone', '--proof', '{}'], /unknown flag --proof/);
  usageError(['assign', '--root', root, '--tenant', 'endzone', '--ci-gate', 'ci'], /unknown flag --ci-gate/);
  usageError(['assign', '--root', root, '--tenant', 'endzone', '--adr-path', 'docs/adr/0006.md'], /unknown flag --adr-path/);
  usageError(['assign', '--root', root, '--tenant', 'endzone', '--context-heading', 'Rosters'], /unknown flag --context-heading/);
});

test('cli: proof refuses --issue-number for --issue', () => {
  usageError(['proof', '--root', rootDir(), '--tenant', 'endzone', '--issue-number', '42'], /unknown flag --issue-number/);
});

test('cli: validate refuses --base for --base-sha and --issue-file for --issue', () => {
  usageError(['validate', '--manifest', 'm.json', '--issue', 'i.json', '--base', 'a'.repeat(40)], /unknown flag --base/);
  usageError(['validate', '--manifest', 'm.json', '--issue-file', 'i.json'], /unknown flag --issue-file/);
});

test('cli: launch refuses --repo (owner/name belongs to --github-repo) and --work-record', () => {
  usageError(['launch', '--root', rootDir(), '--manifest', 'm.json', '--work-record-id', 'endzone:issue-42', '--repo', 'owner/name'], /unknown flag --repo/);
  usageError(['launch', '--root', rootDir(), '--manifest', 'm.json', '--work-record', 'endzone:issue-42'], /unknown flag --work-record/);
});

test('cli: ack refuses --revision for --expected-revision and --record-id for --work-record-id', () => {
  usageError(['ack', '--root', rootDir(), '--work-record-id', 'endzone:issue-42', '--revision', '3'], /unknown flag --revision/);
  usageError(['ack', '--root', rootDir(), '--record-id', 'endzone:issue-42', '--expected-revision', '3'], /unknown flag --record-id/);
});

test('cli: a correct validate invocation still answers', () => {
  const root = rootDir();
  const original = issue(60);
  const reserved = reserveAssignment({
    root, issue: original, tenant: 'endzone', tenantConfig: { branchPrefix: 'fleet/' }, readyLabel: 'ready-for-agent',
    base: { remote: 'origin', ref: 'integration', sha: 'c'.repeat(40) }, now: '2026-09-01T00:00:00.000Z',
  });
  const manifestFile = path.join(root, 'manifest.json');
  const issueFile = path.join(root, 'issue.json');
  fs.writeFileSync(manifestFile, JSON.stringify(reserved.manifest));
  fs.writeFileSync(issueFile, JSON.stringify(original));
  assert.equal(cli(['validate', '--manifest', manifestFile, '--issue', issueFile, '--base-sha', 'c'.repeat(40)]).valid, true);
  fs.writeFileSync(issueFile, JSON.stringify(issue(60, { body: 'changed' })));
  assert.equal(cli(['validate', '--manifest', manifestFile, '--issue', issueFile]).valid, false);
});

test('cli: a correct frontier invocation against a fixture still answers', () => {
  const root = rootDir();
  const fixture = path.join(root, 'issues.json');
  fs.writeFileSync(fixture, JSON.stringify([issue(61), issue(62, { assignees: ['cory'] })]));
  const frontier = cli(['frontier', '--root', root, '--tenant', 'endzone', '--fixture', fixture, '--ready-label', 'ready-for-agent', '--now', '2026-09-01T12:00:00.000Z']);
  assert.deepEqual(frontier.eligible.map((entry) => entry.number), [61]);
});

test('cli: the process exits 2 on a refusal and writes it to stderr, no JSON answer on stdout', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'assignment.js'), 'assign', '--root', rootDir(), '--tenant', 'endzone', '--base', 'a'.repeat(40),
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  const refusal = JSON.parse(result.stderr.trim());
  assert.equal(refusal.code, 'USAGE');
  assert.match(refusal.message, /unknown flag --base/);
});
