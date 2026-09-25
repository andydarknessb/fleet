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
  readTenantConfig,
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
    // fleet#33: a body with no reservable surface is refused at assign, so the
    // default fixture names one file of its own.
    body: `Change \`src/issue-${number}.js\`.`,
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
  assert.deepEqual(overlapPlan.thirdProof.conflicts, [{ left: 1146, right: 1150, fields: ['components'] }]);

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
  const frontier = { eligible: [issue(50, { body: 'Improve the experience.' }), issue(51), issue(52)] };
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
  assert.deepEqual(conflict.conflicts, [{ left: 40, right: 53, fields: ['components'] }]);
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

// fleet#32: the prohibition criterion that collided endzone #1242 with #1233, verbatim
// as it read before the 2026-09-11T22:05Z reword. The ticket edits scheduler.js and
// its test; criterion 3 forbids three other paths, and criterion 2 runs a test unedited.
test('fleet#32: a prohibition criterion reserves nothing; an unedited test run is not a surface', () => {
  const normalized = normalizeIssue(issue(1242, {
    body: [
      '## Acceptance criteria',
      '1. `node --test server/test/scheduler.test.js` is green, with these cases:',
      '   - A `schedule` job whose latest row is `ok: true` reports `syncRuns.schedule.latest.failedWeeks === 13`.',
      '2. `node --test server/test/healthPayloadShape.test.js` is green with both scheduler key-set assertions unedited.',
      '3. `git diff --name-only origin/integration...HEAD` lists no file under `server/modules/syncRun.js`, `server/services/` or `server/db/migrations/`. No change to how the run row is written, and no migration.',
      '4. `latestOk` keeps its `{ finishedAt }` shape.',
    ].join('\n'),
  }));
  assert.deepEqual(normalized.reservations, { components: [], migrationPrefixes: [], schemaAreas: [], testResources: ['server/test/scheduler.test.js'] });
});

test('fleet#32: an allowlist criterion is the whole reservation, so a directory named elsewhere is not reserved', () => {
  const normalized = normalizeIssue(issue(1242, {
    body: [
      'Surface the count on `getSchedulerStatus()` in `server/modules/scheduler.js`; the row is written by `server/modules/syncRun.js`.',
      '3. `git diff --name-only origin/integration...HEAD` lists exactly `server/modules/scheduler.js` and `server/test/scheduler.test.js`. No change to how the run row is written, and no migration.',
    ].join('\n'),
  }));
  assert.deepEqual(normalized.reservations, { components: ['server/modules/scheduler.js'], migrationPrefixes: [], schemaAreas: [], testResources: ['server/test/scheduler.test.js'] });
});

test('fleet#32: a negated sentence, an out-of-scope section, a cited ADR and a copula-cited premise reserve nothing; the same path in an edit sentence still does', () => {
  const normalized = normalizeIssue(issue(1200, {
    body: [
      'Add `server/modules/syncRun.js` and move `runInjurySync` (`server/services/scoring.service.js:946-1154`) onto it. Nothing else migrates in this ticket.',
      '**This ticket adds no migration**: `server/db/migrations/**` is a carve-out.',
      'Rulings: ADR 0036 at `docs/adr/0036-sync-runs.md`. Amend `docs/adr/0033-with-transaction.md` with the lock order.',
      '`PLAYERS_BULK_WRITE_LOCK` is `server/modules/advisoryLock.js:38` (`23004`). `server/modules/liveBox.js:79` stays outside, per the body.',
      'The `data_sync_runs` table gains one row per run; the `players` table is not touched.',
      '## Out of scope',
      '- `server/services/adp.service.js` moves in #1201.',
      '- The `leagues` table.',
      '## Checks',
      '`node --test server/test/injury.test.js` covers the rejects.',
    ].join('\n'),
  }));
  assert.deepEqual(normalized.reservations, {
    components: ['docs/adr/0033-with-transaction.md', 'server/modules/syncRun.js', 'server/services/scoring.service.js'],
    migrationPrefixes: [],
    schemaAreas: ['data_sync_runs'],
    testResources: ['server/test/injury.test.js'],
  });
});

test('fleet#32: a prohibition no longer collides a ticket with the directory owner it never touches', () => {
  const owner = { id: 'endzone:issue-1233', issue: 1233, state: 'implementing', manifestPath: 'm1233', reservations: { components: ['server/db/migrations/'] } };
  const candidate = issue(1242, { body: '`git diff --name-only origin/integration...HEAD` lists no file under `server/db/migrations/`. Edit `server/modules/scheduler.js`.' });
  const frontier = selectFrontier({ issues: [candidate], readyLabel: 'ready-for-agent', active: [owner], now: '2026-09-11T22:00:00.000Z' });
  assert.deepEqual(frontier.eligible.map((entry) => entry.number), [1242]);
  assert.deepEqual(frontier.excluded, []);
});


// fleet#52: endzone #1264's first criterion names `entities/matchup/entityImportBoundary.test.js`
// as the TEMPLATE the two new slices copy ("like `...`"); the ticket must never edit it. The
// derivation reserved it, and nothing else, so the record would have claimed one file the
// ticket never touches and none of the sixteen it writes. A path introduced by a citation
// cue (like, similar to, modelled on, as in, see, per, cf., e.g., such as) reserves nothing
// from that sentence; the same path in an edit sentence is still reserved.
test('fleet#52: a path cited as a template to imitate reserves nothing, so the assignment fails closed instead of claiming it', () => {
  const body = [
    '## Acceptance criteria',
    '1. Import-boundary test like `entities/matchup/entityImportBoundary.test.js` passes for both slices.',
    '2. `npm test -- src/components/LeaguePickem` is green.',
  ].join('\n');
  const normalized = normalizeIssue(issue(1264, { body }));
  assert.deepEqual(normalized.reservations, { components: ['src/components/LeaguePickem'], migrationPrefixes: [], schemaAreas: [], testResources: [] });

  const root = rootDir();
  const base = 'b'.repeat(40);
  assert.throws(
    () => reserveAssignment({ root, issue: issue(1264, { body: body.split('\n').slice(0, 2).join('\n') }), tenant: 'endzone', readyLabel: 'ready-for-agent', base }),
    (error) => error.code === 'EMPTY_RESERVATIONS' && error.issue === 1264,
  );
});

test('fleet#52: every citation cue is a citation; the written path beside it is still reserved, and an edit sentence still reserves a path cited elsewhere', () => {
  const normalized = normalizeIssue(issue(1265, {
    body: [
      'Add `src/entities/pickem-board/entityImportBoundary.test.js` modelled on `src/entities/matchup/entityImportBoundary.test.js`.',
      'Shape it similar to `src/entities/matchup/model/matchupModel.js`, as in `src/entities/roster/model/lineupModel.js`.',
      'See `src/shared/lib/kickoff.js`; per `src/shared/lib/formatCount.js`; cf. `src/shared/lib/parseInjury.js`; e.g. `src/shared/lib/positions.js`; such as `src/shared/lib/adp.js`.',
      'Create `src/entities/pickem-board/model/boardModel.js` like the existing `src/entities/pickem-slate/model/slateModel.js`.',
      'Update `src/entities/matchup/model/matchupModel.js` to export the shared helper.',
    ].join('\n'),
  }));
  assert.deepEqual(normalized.reservations, {
    components: ['src/entities/matchup/model/matchupModel.js', 'src/entities/pickem-board/model/boardModel.js'],
    migrationPrefixes: [],
    schemaAreas: [],
    testResources: ['src/entities/pickem-board/entityImportBoundary.test.js'],
  });
});


// fleet#54: endzone #1294's approved Ruling carried an allowlist Scope line naming four
// files; the recognizer needed a hardcoded directory prefix plus a separator, so the
// root file `CONTEXT.md` matched nothing, the derived set was three of four, and every
// guard was satisfied: non-empty, no conflict, `independent: true`. Partial and silent,
// failing open. A root-level file is a path in its own right (allowlist sentence or
// backtick-fenced, known extension or dotfile), and an allowlist sentence states its own
// cardinality: an item it lists that the recognizer did not turn into a reservation is
// reported as `unrecognizedPaths`, and `assign` refuses to reserve a short set.
test('fleet#54: a root-level file in an allowlist Scope line is reserved, verbatim from endzone #1294', () => {
  const normalized = normalizeIssue(issue(1294, {
    body: 'Scope: lists exactly CONTEXT.md and docs/adr/0038-pickem-joins-the-island.md and src/entities/line/model/lineModel.js and src/entities/pickem-game/model/gameDetailModel.js',
  }));
  assert.deepEqual(normalized.reservations, {
    components: ['CONTEXT.md', 'docs/adr/0038-pickem-joins-the-island.md', 'src/entities/line/model/lineModel.js', 'src/entities/pickem-game/model/gameDetailModel.js'],
    migrationPrefixes: [], schemaAreas: [], testResources: [],
  });
  assert.deepEqual(normalized.unrecognizedPaths, []);
});

test('fleet#54: a fenced known root file in an edit sentence is reserved; a runtime name and an unfenced prose token are not', () => {
  const normalized = normalizeIssue(issue(1295, {
    body: [
      'Add the `Decision card` entry to `CONTEXT.md` and bump `package.json`; `.eslintrc.json` gains one rule.',
      'The client runs on Node.js and renders with React.js; the config lives in netlify.toml which this ticket does not touch.',
      'Write `src/widgets/DecisionCard/DecisionCard.jsx`.',
    ].join('\n'),
  }));
  assert.deepEqual(normalized.reservations.components, ['.eslintrc.json', 'CONTEXT.md', 'package.json', 'src/widgets/DecisionCard/DecisionCard.jsx']);
  assert.deepEqual(normalized.unrecognizedPaths, []);
});

test('fleet#54: an allowlist item the recognizer cannot place is reported, and assign refuses the short set until the lead declares it', () => {
  const body = 'Scope: lists exactly `src/entities/line/model/lineModel.js` and `Procfile` and `assignment.js` and `weird~name` and the `players` table.';
  const normalized = normalizeIssue(issue(1296, { body }));
  assert.deepEqual(normalized.reservations.components, ['Procfile', 'src/entities/line/model/lineModel.js']);
  assert.deepEqual(normalized.unrecognizedPaths, ['assignment.js', 'weird~name']);

  const root = rootDir();
  const base = 'c'.repeat(40);
  assert.throws(
    () => reserveAssignment({ root, issue: issue(1296, { body }), tenant: 'endzone', readyLabel: 'ready-for-agent', base }),
    (error) => error.code === 'PARTIAL_RESERVATIONS' && error.issue === 1296 && /assignment.js/.test(error.message) && /--reservations/.test(error.message) && error.unrecognizedPaths.length === 2,
  );
  assert.ok(!fs.existsSync(path.join(root, 'state', 'work', 'active.json')) || !JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records['endzone:issue-1296'], 'a refused assignment reserves nothing');
  const explicit = reserveAssignment({ root, issue: issue(1296, { body }), tenant: 'endzone', readyLabel: 'ready-for-agent', base, reservations: '{"components":["src/entities/line/model/lineModel.js","Procfile"]}' });
  assert.deepEqual(explicit.manifest.reservations.components, ['Procfile', 'src/entities/line/model/lineModel.js']);
});

test('fleet#54: the frontier answer carries unrecognizedPaths so a lead reading it sees a short derivation', () => {
  const candidate = issue(1297, { body: 'Scope: lists exactly `src/a.js` and `assignment.js`.' });
  const frontier = selectFrontier({ issues: [candidate], readyLabel: 'ready-for-agent', active: [], now: '2026-09-12T17:00:00.000Z' });
  assert.deepEqual(frontier.eligible[0].unrecognizedPaths, ['assignment.js']);
});

// fleet#33: endzone #1234's six criteria name seams in prose and no path, so the
// derivation produced an empty set and the record silently blocked every later
// third assignment. Assign refuses that; the lead answers with --reservations.
test('fleet#33: assign refuses an assignment whose criteria derive no reservation, and accepts an explicit set', () => {
  const root = rootDir();
  const fileless = issue(1234, { body: 'An ESPN implementation of the existing odds provider seam reads each event\'s odds block. A new hourly Sync run (ADR 0036) fetches the slate once.' });
  const base = { remote: 'origin', ref: 'integration', sha: 'e'.repeat(40) };
  assert.throws(() => reserveAssignment({ root, issue: fileless, tenant: 'endzone', readyLabel: 'ready-for-agent', base }), (error) => error.code === 'EMPTY_RESERVATIONS' && error.issue === 1234 && /--reservations/.test(error.message));
  assert.throws(() => getRecord({ root, id: 'endzone:issue-1234' }), (error) => error.code === 'NOT_FOUND');

  assert.throws(() => reserveAssignment({ root, issue: fileless, tenant: 'endzone', readyLabel: 'ready-for-agent', base, reservations: '{"components":[]}' }), (error) => error.code === 'EMPTY_RESERVATIONS');
  assert.throws(() => reserveAssignment({ root, issue: fileless, tenant: 'endzone', readyLabel: 'ready-for-agent', base, reservations: '{"files":["server/modules/odds.js"]}' }), (error) => error.code === 'USAGE' && /unknown field/.test(error.message));

  const reserved = reserveAssignment({ root, issue: fileless, tenant: 'endzone', readyLabel: 'ready-for-agent', base, reservations: '{"components":["server/modules/oddsProvider.js","server/modules/espnOdds.js"],"testResources":["server/test/fixtures/espn-scoreboard-2025-w1.json"]}' });
  const expected = { components: ['server/modules/espnOdds.js', 'server/modules/oddsProvider.js'], migrationPrefixes: [], schemaAreas: [], testResources: ['server/test/fixtures/espn-scoreboard-2025-w1.json'] };
  assert.deepEqual(reserved.manifest.reservations, expected);
  assert.deepEqual(getRecord({ root, id: 'endzone:issue-1234' }).reservations, expected);
});

test('cli: assign accepts --reservations and refuses a bare flag', () => {
  assert.ok(FLAGS.assign.includes('reservations'));
  assert.throws(() => cli(['assign', '--root', rootDir(), '--reservations']), (error) => error.code === 'USAGE');
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
  assert.deepEqual(conflictPlan.thirdProof.conflicts, [{ left: 40, right: 51, fields: ['components'] }]);

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

// Spec #94 (#162): the permission profile is a launch-door choice per model. The
// planner pins it in the manifest beside the model so launch.ps1 writes the matching
// settings; haiku is reservable only under the allowlist profile (auto is fleet #28).
test('assign pins the permission profile: haiku only under allowlist, sonnet under auto', () => {
  const base = { remote: 'origin', ref: 'integration', sha: 'e'.repeat(40) };
  const reserve = (number, extra) => reserveAssignment({ root: rootDir(), issue: issue(number), tenant: 'endzone', readyLabel: 'ready-for-agent', base, ...extra });

  const haiku = reserve(80, { model: 'haiku', permissions: 'allowlist' });
  assert.equal(haiku.manifest.model, 'haiku');
  assert.equal(haiku.manifest.permissions, 'allowlist', 'the manifest pins the profile beside the model');

  for (const [number, extra, label] of [[81, { model: 'haiku' }, 'no flag'], [82, { model: 'haiku', permissions: 'auto' }, '--permissions auto']]) {
    assert.throws(
      () => reserve(number, extra),
      (error) => error.code === 'INVALID_IC_MODEL' && /auto mode/.test(error.message) && /fleet #28/.test(error.message),
      `haiku with ${label} is refused with the fleet #28 cause`,
    );
  }

  assert.equal(reserve(83, { model: 'sonnet' }).manifest.permissions, 'auto', 'sonnet with no flag pins the auto profile');
  assert.equal(reserve(84, {}).manifest.permissions, 'auto', 'the default model pins auto too');
  assert.throws(
    () => reserve(85, { model: 'sonnet', permissions: 'allowlist' }),
    (error) => error.code === 'INVALID_PERMISSION_PROFILE' && /sonnet/.test(error.message),
    'sonnet stays on auto: the allowlist profile is the haiku profile',
  );
  assert.throws(
    () => reserve(86, { model: 'haiku', permissions: 'bypass' }),
    (error) => error.code === 'INVALID_PERMISSION_PROFILE' && /allowlist/.test(error.message),
    'an unknown profile is refused, naming the known ones',
  );
});

test('assign CLI takes --permissions and the written manifest pins it', () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', readyLabel: 'ready-for-agent', maxIcs: 3, defaultBranch: 'integration' }));
  const fixture = path.join(root, 'issues.json');
  fs.writeFileSync(fixture, JSON.stringify([issue(90)]));
  const result = cli(['assign', '--root', root, '--tenant', 'endzone', '--fixture', fixture, '--base-sha', 'f'.repeat(40), '--model', 'haiku', '--permissions', 'allowlist']);
  const written = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(written.model, 'haiku');
  assert.equal(written.permissions, 'allowlist');
});

// Spec #94 (#163/#164): a rehearsal reserves one chosen ticket, not the frontier head.
test('assign --issue reserves that frontier issue, and refuses one that is not eligible', () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', readyLabel: 'ready-for-agent', maxIcs: 3, defaultBranch: 'integration' }));
  const fixture = path.join(root, 'issues.json');
  fs.writeFileSync(fixture, JSON.stringify([issue(91), issue(92), issue(93, { labels: [] })]));
  const common = ['assign', '--root', root, '--tenant', 'endzone', '--fixture', fixture, '--base-sha', 'f'.repeat(40)];
  assert.equal(cli([...common, '--issue', '92']).manifest.issue.number, 92, 'the named issue is reserved, not the head (#91)');
  assert.throws(
    () => cli([...common, '--issue', '93']),
    (error) => error.code === 'NO_FRONTIER' && /#93/.test(error.message),
    'an issue off the frontier is refused by number',
  );
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

// fleet#62: `proof` took no --reservations, so a candidate whose criteria name
// their seams in prose printed `missingReservations: [<it>]` while `assign`
// checked a proof computed over the explicit set. The documented path (pass the
// printed proof verbatim) could never satisfy the third-assignment gate for a
// prose-seam ticket; the lead's only exits were a hand-authored proof or an
// indefinite wait (endzone #1376, 2026-09-14).
function proseSeamFixture() {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  const tenantFile = path.join(root, 'tenants', 'endzone.json');
  fs.writeFileSync(tenantFile, JSON.stringify({ name: 'endzone', readyLabel: 'ready-for-agent', defaultBranch: 'integration' }));
  const issues = [
    issue(1272, { body: 'Change `src/a.js`.' }),
    issue(1375, { body: 'Change `src/b.js`.' }),
    issue(1376, { body: 'The kickoff waivers writer records a row at kickoff; the reader answers from it.' }),
  ];
  const active = [
    { id: 'endzone:issue-1272', issue: 1272, state: 'implementing', manifestPath: 'm1272', reservations: { components: ['src/a.js'] } },
    { id: 'endzone:issue-1375', issue: 1375, state: 'implementing', manifestPath: 'm1375', reservations: { components: ['src/b.js'] } },
  ];
  const fixture = path.join(root, 'issues.json');
  const activeFile = path.join(root, 'active.json');
  fs.writeFileSync(fixture, JSON.stringify(issues));
  fs.writeFileSync(activeFile, JSON.stringify(active));
  const common = ['--root', root, '--tenant', 'endzone', '--tenant-config', tenantFile, '--fixture', fixture, '--active', activeFile];
  return { root, common };
}

test('fleet#62: proof --reservations applies the explicit set to the candidate and prints the proof assign expects', () => {
  const { common } = proseSeamFixture();
  const explicit = '{"components":["server/services/kickoffWaivers.js"],"testResources":["server/test/kickoffWaivers.test.js"]}';

  const bare = cli(['proof', ...common, '--issue', '1376']);
  assert.equal(bare.proof.independent, false);
  assert.deepEqual(bare.proof.missingReservations, [1376], 'without the flag the prose-seam candidate reserves nothing, as before');

  const answered = cli(['proof', ...common, '--issue', '1376', '--reservations', explicit]);
  assert.equal(answered.issue, 1376);
  assert.deepEqual(answered.activeAssignments, ['endzone:issue-1272', 'endzone:issue-1375']);
  assert.equal(answered.proof.independent, true);
  assert.deepEqual(answered.proof.missingReservations, []);
  assert.deepEqual(answered.proof.conflicts, []);
  assert.deepEqual(answered.proof.candidates, [1272, 1375, 1376]);
  assert.deepEqual(answered.reservations, { components: ['server/services/kickoffWaivers.js'], migrationPrefixes: [], schemaAreas: [], testResources: ['server/test/kickoffWaivers.test.js'] }, 'the candidate\'s reservations are drawn from the flag');

  const conflicting = cli(['proof', ...common, '--issue', '1376', '--reservations', '{"components":["src/a.js"]}']);
  assert.equal(conflicting.proof.independent, false);
  assert.deepEqual(conflicting.proof.conflicts, [{ left: 1272, right: 1376, fields: ['components'] }], 'an explicit set is checked for conflicts like a derived one');
});

test('fleet#62: the printed proof passed verbatim satisfies assign with the same --reservations and is refused with a different set', () => {
  const { root, common } = proseSeamFixture();
  const explicit = '{"components":["server/services/kickoffWaivers.js"],"testResources":["server/test/kickoffWaivers.test.js"]}';
  const printed = cli(['proof', ...common, '--issue', '1376', '--reservations', explicit]).proof;
  const assign = (reservations) => cli(['assign', ...common, '--base-sha', 'd'.repeat(40), '--independence-proof', JSON.stringify(printed), '--reservations', reservations]);

  // A different, non-conflicting set under the same proof: the proof was not
  // computed over what is being reserved, so it is not that assignment's proof.
  assert.throws(() => assign('{"components":["server/services/somethingElse.js"]}'), (error) => error.code === 'THIRD_ASSIGNMENT_REQUIRES_PROOF');
  assert.throws(() => getRecord({ root, id: 'endzone:issue-1376' }), (error) => error.code === 'NOT_FOUND', 'a refused assign writes nothing');

  const reserved = assign(explicit);
  assert.equal(reserved.manifest.issue.number, 1376);
  assert.deepEqual(reserved.manifest.reservations, { components: ['server/services/kickoffWaivers.js'], migrationPrefixes: [], schemaAreas: [], testResources: ['server/test/kickoffWaivers.test.js'] });
  assert.deepEqual(reserved.manifest.independenceProof, printed);
  assert.deepEqual(getRecord({ root, id: 'endzone:issue-1376' }).reservations, reserved.manifest.reservations);
});

test('fleet#62: proof refuses a bare --reservations and an unknown flag as USAGE', () => {
  assert.ok(FLAGS.proof.includes('reservations'));
  const { common } = proseSeamFixture();
  assert.throws(() => cli(['proof', ...common, '--reservations']), (error) => error.code === 'USAGE' && /--reservations needs a JSON object/.test(error.message));
  assert.throws(() => cli(['proof', ...common, '--reservation', '{}']), (error) => error.code === 'USAGE' && /unknown flag --reservation/.test(error.message));
  assert.throws(() => cli(['proof', ...common, '--reservations', '{"files":["a.js"]}']), (error) => error.code === 'USAGE' && /unknown field/.test(error.message));
});

// One Work record ledger serves every tenant. Unscoped, endzone's three ICs on
// src/ paths refused nidus's walking skeleton (#2) at every door: the frontier
// marked it `reserved` by endzone's own #2 and conflicted its src/ paths with
// endzone's, and assign counted endzone's three toward nidus's third
// (2026-09-24, nidus excl-2-1).
function crossTenantFixture() {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'nidus.json'), JSON.stringify({ name: 'nidus', readyLabel: 'ready-for-agent', maxIcs: 2, defaultBranch: 'main' }));
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', readyLabel: 'ready-for-agent', maxIcs: 3, defaultBranch: 'integration' }));
  const endzone = [[1610, 'src/widgets/player-pool'], [1611, 'src/entities/waiver-bid'], [2, 'src/app']]
    .map(([number, component]) => ({ issue: number, reservations: { components: [component] } }));
  for (const [index, record] of endzone.entries()) {
    reserveRecord({ root, id: `endzone:issue-${record.issue}`, tenant: 'endzone', issue: record.issue, manifestPath: `m${record.issue}`, reservations: record.reservations, independenceProof: index === 2 ? independenceProof(endzone) : undefined, idempotencyKey: `reserve-${record.issue}`, now: '2026-09-24T00:00:00.000Z' });
  }
  const fixture = path.join(root, 'issues.json');
  fs.writeFileSync(fixture, JSON.stringify([issue(2, { body: 'Create `src/app/index.ts`.' })]));
  return { root, fixture };
}

test('a tenant frontier ignores another tenant\'s records: same issue number and same src path', () => {
  const { root, fixture } = crossTenantFixture();
  const nidus = cli(['frontier', '--root', root, '--tenant', 'nidus', '--fixture', fixture]);
  assert.deepEqual(nidus.eligible.map((entry) => entry.number), [2]);
  const endzone = cli(['frontier', '--root', root, '--tenant', 'endzone', '--fixture', fixture]);
  assert.deepEqual(endzone.excluded[0].reasons.map((reason) => reason.code), ['reserved', 'reservation-conflict'], 'the owning tenant still sees its own records');
});

test('a tenant\'s proof and assign do not count another tenant\'s assignments', () => {
  const { root, fixture } = crossTenantFixture();
  const common = ['--root', root, '--tenant', 'nidus', '--fixture', fixture];
  const printed = cli(['proof', ...common]);
  assert.deepEqual(printed.activeAssignments, []);
  assert.deepEqual(printed.proof.candidates, [2]);
  const assigned = cli(['assign', ...common, '--base-sha', 'a'.repeat(40), '--now', '2026-09-24T01:00:00.000Z']);
  assert.equal(assigned.reservation.record.id, 'nidus:issue-2');
  assert.equal(getRecord({ root, id: 'endzone:issue-2' }).tenant, 'endzone', 'the other tenant\'s same-numbered record is untouched');
});

test('an active record naming no tenant still conflicts, so scoping cannot fail open', () => {
  const active = [{ id: 'legacy:issue-8', issue: 8, state: 'implementing', reservations: { components: ['src/shared'] } }];
  const frontier = selectFrontier({ issues: [issue(3, { body: 'Change `src/shared/x.js`.' })], readyLabel: 'ready-for-agent', active, tenant: 'nidus', now: '2026-09-24T00:00:00.000Z' });
  assert.equal(frontier.excluded[0].reasons[0].code, 'reservation-conflict');
});

// #154 (ADR 0015): with the Fleet identity distinct from the owner's, an issue
// assigned to the owner is foreign and stays off the frontier; one assigned to the
// fleet is the fleet's own; an unassigned one is unchanged.
test('#154: assigned-to-owner is foreign, assigned-to-fleet is kept, unassigned unchanged', () => {
  const ownerHas = issue(70, { assignees: [{ login: 'cory-owner' }] });
  const fleetHas = issue(71, { assignees: [{ login: 'fleet-bot' }] });
  const nobody = issue(72);
  const result = selectFrontier({ issues: [ownerHas, fleetHas, nobody], readyLabel: 'ready-for-agent', fleetIdentity: 'fleet-bot' });
  assert.deepEqual(result.eligible.map((entry) => entry.number), [71, 72]);
  const excluded = result.excluded.find((entry) => entry.issue === 70);
  assert.deepEqual(excluded.reasons.map((reason) => reason.code), ['assigned']);
  assert.match(excluded.reasons[0].detail, /cory-owner/);
});

test('#154: the assignment loader refuses a tenant whose fleetIdentity is its ownerLogin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-154-'));
  fs.mkdirSync(path.join(root, 'tenants'));
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', fleetIdentity: 'andydarknessb', ownerLogin: 'andydarknessb' }));
  assert.throws(() => readTenantConfig(root, 'endzone'), { code: 'TENANT_IDENTITY_NOT_DISTINCT' });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', fleetIdentity: 'fleet-bot', ownerLogin: 'andydarknessb' }));
  assert.equal(readTenantConfig(root, 'endzone').fleetIdentity, 'fleet-bot');
});
