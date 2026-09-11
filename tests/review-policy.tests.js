'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ReviewPolicyError,
  classifyChange,
  matchGlob,
  recordReviewArtifact,
  planRereview,
  holdRecord,
} = require('../bin/review-policy');
const workState = require('../bin/work-state');

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-review-policy-'));
}

const TENANT = {
  name: 'endzone',
  carveOuts: ['server/db/migrations/**', '**/knexfile*', '.github/workflows/**', '.env*', 'netlify.toml'],
  riskTriggers: {
    auth: { paths: ['server/middleware/**', 'server/services/leagueRole*'], patterns: [] },
    destructive: { paths: [], patterns: ['DROP TABLE', 'TRUNCATE', 'DELETE FROM'] },
    concurrency: { paths: [], patterns: ['FOR UPDATE'] },
  },
};

function seedRecord(root, { state = 'review', prNumber = 77 } = {}) {
  workState.createRecord({
    root, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, state: 'implementing',
    github: { issueNumber: 42, prNumber },
    actor: 'test', idempotencyKey: 'create-42', now: '2026-09-01T00:00:00.000Z',
  });
  const hops = {
    implementing: [], 'pr-open': ['pr-open'], 'ci-wait': ['pr-open', 'ci-wait'],
    review: ['pr-open', 'ci-wait', 'review'],
  }[state] || [];
  let revision = 1;
  let tick = 0;
  for (const to of hops) {
    tick += 1;
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `seed-${to}`,
      actor: 'test', evidence: 'seed', now: `2026-09-01T00:00:0${tick}.000Z`,
    }).revision;
  }
  return revision;
}

// --- glob semantics ---

test('glob matching covers the tenant carve-out shapes', () => {
  assert.equal(matchGlob('server/db/migrations/**', 'server/db/migrations/20260901_x.js'), true);
  assert.equal(matchGlob('server/db/migrations/**', 'server/db/migrations/sub/deep.js'), true);
  assert.equal(matchGlob('server/db/migrations/**', 'server/db/seeds/x.js'), false);
  assert.equal(matchGlob('**/knexfile*', 'server/knexfile.js'), true);
  assert.equal(matchGlob('**/knexfile*', 'knexfile.production.js'), true);
  assert.equal(matchGlob('.github/workflows/**', '.github/workflows/ci.yml'), true);
  assert.equal(matchGlob('.env*', '.env.local'), true);
  // A bare-name glob matches by basename anywhere: carve-outs over-match rather than under-match.
  assert.equal(matchGlob('.env*', 'client/.env.production'), true);
  assert.equal(matchGlob('netlify.toml', 'netlify.toml'), true);
  assert.equal(matchGlob('netlify.toml', 'docs/netlify.toml.md'), false);
  assert.equal(matchGlob('src/**/*.jsx', 'src/components/App.jsx'), true);
  assert.equal(matchGlob('src/**/*.jsx', 'src/App.jsx'), true);
  assert.equal(matchGlob('src/**/*.jsx', 'server/App.jsx'), false);
});

// --- classification tiers ---

test('a small diff with no triggers is trivial: the lead reviews, no risk reviewer', () => {
  const classification = classifyChange({
    files: ['src/components/Badge.jsx'],
    changedLines: 8,
    addedLines: ['const label = receptionFormatLabel(preset);'],
    tenant: TENANT,
  });
  assert.equal(classification.tier, 'trivial');
  assert.equal(classification.riskReview, false);
  assert.equal(classification.triggers.length, 0);
  assert.equal(classification.merge, 'lead');
  assert.equal(classification.reviewPlan.formal.owner, 'project-lead');
  assert.equal(classification.reviewPlan.risk, null);
});

test('a larger diff with no triggers is normal and still gets no risk reviewer', () => {
  const classification = classifyChange({
    files: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'],
    changedLines: 240,
    addedLines: [],
    tenant: TENANT,
  });
  assert.equal(classification.tier, 'normal');
  assert.equal(classification.riskReview, false);
  assert.equal(classification.reviewPlan.risk, null);
});

test('a carve-out path is high-risk, cory-only to merge, and books the IC-hosted opus risk reviewer', () => {
  const classification = classifyChange({
    files: ['server/db/migrations/20260901_add_thing.js', 'server/services/thing.js'],
    changedLines: 40,
    addedLines: [],
    tenant: TENANT,
  });
  assert.equal(classification.tier, 'high-risk');
  assert.equal(classification.riskReview, true);
  assert.equal(classification.merge, 'cory-only');
  const carveOut = classification.triggers.find((trigger) => trigger.class === 'carve-out');
  assert.ok(carveOut);
  assert.equal(carveOut.matches[0].file, 'server/db/migrations/20260901_add_thing.js');
  assert.deepEqual(classification.reviewPlan.risk, {
    host: 'ic', role: 'qa-reviewer', model: 'opus', readOnly: true, timing: 'pre-pr-ready',
  });
});

test('configured trigger paths and diff patterns fire; patterns look at added lines only', () => {
  const authOnly = classifyChange({
    files: ['server/middleware/requireMember.js'], changedLines: 12, addedLines: [], tenant: TENANT,
  });
  assert.deepEqual(authOnly.triggers.map((trigger) => trigger.class), ['auth']);
  assert.equal(authOnly.tier, 'high-risk');
  assert.equal(authOnly.merge, 'lead');

  const withPattern = classifyChange({
    files: ['server/services/cleanup.js'], changedLines: 12,
    addedLines: ['  await knex.raw("DELETE FROM stale_rows where 1=1");'],
    tenant: TENANT,
  });
  assert.deepEqual(withPattern.triggers.map((trigger) => trigger.class), ['destructive']);

  // The same text only removed does not fire.
  const removedOnly = classifyChange({
    files: ['server/services/cleanup.js'], changedLines: 12, addedLines: [], tenant: TENANT,
  });
  assert.equal(removedOnly.triggers.length, 0);
});

test('classification parses added lines and changed-line counts from a unified diff', () => {
  const diffText = [
    'diff --git a/server/services/cleanup.js b/server/services/cleanup.js',
    '--- a/server/services/cleanup.js',
    '+++ b/server/services/cleanup.js',
    '@@ -1,4 +1,5 @@',
    ' const knex = require("./db");',
    '-const old = 1;',
    '+const fresh = 1;',
    '+await knex.raw("SELECT 1 FOR UPDATE");',
    ' module.exports = {};',
  ].join('\n');
  const classification = classifyChange({
    files: ['server/services/cleanup.js'], diffText, tenant: TENANT,
  });
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['concurrency']);
  assert.equal(classification.changedLines, 3);
});

// --- exactly one formal review ---

test('a normal PR records exactly one formal review; a second attempt at the same head is refused', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'should-fix' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  assert.ok(fs.existsSync(path.join(root, first.artifact)));
  const stored = JSON.parse(fs.readFileSync(path.join(root, first.artifact), 'utf8'));
  assert.equal(stored.kind, 'formal');
  assert.equal(stored.findings[0].id, 'formal-001-f1');
  assert.equal(stored.findings[0].status, 'open');
  assert.equal(first.result.record.review.formal.artifact, first.artifact);

  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'formal-dup', now: '2026-09-01T02:01:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'ALREADY_REVIEWED',
  );
});

// --- risk review only on a trigger ---

test('a normal PR never gets a risk review recorded; a triggered one gets exactly one', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'risk', headSha: 'bbb2222', actor: 'ic-42',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'risk-none', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => error.code === 'RISK_REVIEW_NOT_TRIGGERED',
  );
  const triggered = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: 'bbb2222', actor: 'ic-42',
    classification: { tier: 'high-risk', triggers: [{ class: 'carve-out', matches: [{ file: 'server/db/migrations/x.js', glob: 'server/db/migrations/**' }] }] },
    findings: [{ file: 'server/db/migrations/x.js', line: 1, claim: 'missing down()', severity: 'blocker' }],
    idempotencyKey: 'risk-1', now: '2026-09-01T02:01:00.000Z',
  });
  assert.equal(triggered.result.record.review.risk.artifact, triggered.artifact);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: triggered.result.revision,
      kind: 'risk', headSha: 'bbb2222', actor: 'ic-42',
      classification: { tier: 'high-risk', triggers: [{ class: 'carve-out', matches: [] }] }, findings: [],
      idempotencyKey: 'risk-dup', now: '2026-09-01T02:02:00.000Z',
    }),
    (error) => error.code === 'ALREADY_REVIEWED',
  );
});

// --- revision re-review ---

test('a revision re-review links the prior findings and carries only unresolved or new material', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [
      { file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'should-fix' },
      { file: 'src/b.js', line: 9, claim: 'dead branch', severity: 'nit' },
    ],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  revision = first.result.revision;

  // The IC revised: record moves revision -> pr-open -> ci-wait -> review again.
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `again-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-01T02:1${index}:00.000Z`,
    }).revision;
  }

  const plan = planRereview({ root, recordId: 'endzone:issue-42', headSha: 'ccc3333' });
  assert.equal(plan.priorArtifact, first.artifact);
  assert.equal(plan.priorHeadSha, 'aaa1111');
  assert.equal(plan.range, 'aaa1111..ccc3333');
  assert.deepEqual(plan.unresolved.map((finding) => finding.id), ['formal-001-f1', 'formal-001-f2']);

  // A second formal at a new head without linking the prior artifact is refused.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: 'ccc3333', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'formal-2-bad', now: '2026-09-01T02:20:00.000Z',
    }),
    (error) => error.code === 'REREVIEW_REQUIRES_PRIOR',
  );

  // Resolutions must cover every open prior finding.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: 'ccc3333', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
      idempotencyKey: 'formal-2-partial', now: '2026-09-01T02:21:00.000Z',
    }),
    (error) => error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED',
  );

  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'ccc3333', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/c.js', line: 1, claim: 'new regression', severity: 'blocker' }],
    priorArtifact: first.artifact,
    resolutions: { 'formal-001-f1': 'resolved', 'formal-001-f2': 'still-open' },
    idempotencyKey: 'formal-2', now: '2026-09-01T02:22:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.priorArtifact, first.artifact);
  assert.equal(stored.range, 'aaa1111..ccc3333');
  const ids = stored.findings.map((finding) => finding.id).sort();
  // Only the still-open carry-over and the newly introduced finding; the resolved one is settled material.
  assert.deepEqual(ids, ['formal-001-f2', 'formal-002-f1']);
  const carried = stored.findings.find((finding) => finding.id === 'formal-001-f2');
  assert.equal(carried.carriedFrom, first.artifact);
  assert.equal(carried.status, 'open');
});

// --- hold pages once ---

test('a clean carve-out reaches hold, pages exactly once, and cannot merge without an observed GitHub merge', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const launches = [];
  const held = holdRecord({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    reason: 'carve-out PR #77 reviewed clean; waits for Cory', actor: 'project-lead',
    idempotencyKey: 'hold-1', now: '2026-09-01T03:00:00.000Z', notifier: (launch) => launches.push(launch),
  });
  assert.equal(held.result.record.state, 'hold');
  assert.equal(held.paged, true);
  assert.deepEqual(launches, [{ root, recordId: 'endzone:issue-42', sequence: held.result.eventSequence }], 'the hold launches the ticket-07 notifier for its decision event');
  const outbox = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  const lines = fs.readFileSync(outbox, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).wake, 'decision-needed');

  // Page once: a replay does not append a second wake line.
  const replay = holdRecord({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    reason: 'carve-out PR #77 reviewed clean; waits for Cory', actor: 'project-lead',
    idempotencyKey: 'hold-1', now: '2026-09-01T03:01:00.000Z', notifier: (launch) => launches.push(launch),
  });
  assert.equal(replay.paged, false);
  assert.equal(launches.length, 1, 'a replay launches no second notifier');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1);

  // No automated or lead path to merged: the transition demands a reconciled GitHub MERGED observation.
  assert.throws(
    () => workState.transitionRecord({
      root, id: 'endzone:issue-42', to: 'merged', expectedRevision: held.result.revision,
      idempotencyKey: 'merge-attempt', actor: 'project-lead', evidence: 'lead tried to merge',
    }),
    (error) => error.code === 'MISSING_GITHUB_RECONCILIATION',
  );
});

test('hold requires a PR on the record: an issue-only record cannot be parked', () => {
  const root = rootDir();
  workState.createRecord({
    root, id: 'endzone:issue-9', tenant: 'endzone', issue: 9, state: 'implementing',
    actor: 'test', idempotencyKey: 'create-9', now: '2026-09-01T00:00:00.000Z',
  });
  assert.throws(
    () => holdRecord({
      root, recordId: 'endzone:issue-9', expectedRevision: 1,
      reason: 'no PR yet', actor: 'project-lead', idempotencyKey: 'hold-9',
    }),
    (error) => error.code === 'INVALID_TRANSITION' || error.code === 'MISSING_PR_EVIDENCE',
  );
});

// --- review-round hardening (same-day adversarial QA + spec review) ---

test('pattern triggers never fire from excluded prose files; per-file diff attribution holds', () => {
  const docsOnly = [
    'diff --git a/docs/guide.md b/docs/guide.md',
    '--- a/docs/guide.md',
    '+++ b/docs/guide.md',
    '@@ -1,1 +1,2 @@',
    ' # Guide',
    '+Use aria-label on icon buttons.',
  ].join('\n');
  const none = classifyChange({ files: ['docs/guide.md'], diffText: docsOnly, tenant: TENANT });
  assert.equal(none.triggers.length, 0);

  // The same risky text added in an excluded file does not fire once attributed.
  const mixed = [
    'diff --git a/docs/guide.md b/docs/guide.md',
    '+++ b/docs/guide.md',
    '@@ -1,1 +1,2 @@',
    '+DELETE FROM notes about cleanup.',
    'diff --git a/src/Icon.jsx b/src/Icon.jsx',
    '+++ b/src/Icon.jsx',
    '@@ -1,1 +1,2 @@',
    '+export const x = 1;',
  ].join('\n');
  const attributed = classifyChange({ files: ['docs/guide.md', 'src/Icon.jsx'], diffText: mixed, tenant: TENANT });
  assert.equal(attributed.triggers.length, 0, 'destructive text in an excluded file does not fire');
  const inCode = classifyChange({
    files: ['src/cleanup.js'],
    diffText: ['diff --git a/src/cleanup.js b/src/cleanup.js', '+++ b/src/cleanup.js', '@@ -1,1 +1,2 @@', '+await knex.raw("DELETE FROM stale");'].join('\n'),
    tenant: TENANT,
  });
  assert.deepEqual(inCode.triggers.map((trigger) => trigger.class), ['destructive']);
});

test('caller-supplied finding fields cannot smuggle a non-open status, and duplicate ids are refused', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const recorded = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'sneaky', severity: 'nit', status: 'resolved' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8'));
  assert.equal(stored.findings[0].status, 'open');

  const root2 = rootDir();
  const revision2 = seedRecord(root2);
  assert.throws(
    () => recordReviewArtifact({
      root: root2, recordId: 'endzone:issue-42', expectedRevision: revision2,
      kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] },
      findings: [
        { id: 'formal-001-f1', file: 'a', claim: 'x', severity: 'nit' },
        { id: 'formal-001-f1', file: 'b', claim: 'y', severity: 'nit' },
      ],
      idempotencyKey: 'formal-dup-id', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => error.code === 'DUPLICATE_FINDING_ID',
  );
});

test('a retried record call replays instead of raising ALREADY_REVIEWED, and leaves one artifact', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const args = {
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit' }],
    now: '2026-09-01T02:00:00.000Z',
  };
  const first = recordReviewArtifact(args);
  const retry = recordReviewArtifact(args);
  assert.equal(retry.result.replayed, true);
  assert.equal(retry.artifact, first.artifact);
  const directory = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.readdirSync(directory).length, 1);
});

test('a routine concurrent observation does not destroy a review: record retries past a bumped revision', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  // pr-watch observes the PR between the reviewer reading the record and recording.
  workState.observeRecord({
    root, id: 'endzone:issue-42', expectedRevision: revision, idempotencyKey: 'obs-1',
    actor: 'pr-watch', observation: { digest: 'd1' }, now: '2026-09-01T02:00:00.000Z',
  });
  const recorded = recordReviewArtifact({
    root, recordId: 'endzone:issue-42',
    kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:01:00.000Z',
  });
  assert.equal(recorded.result.replayed, false);
  assert.ok(fs.existsSync(path.join(root, recorded.artifact)));
});

test('a missing prior artifact degrades to an honest re-review instead of wedging the record', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  revision = first.result.revision;
  fs.rmSync(path.join(root, first.artifact));
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `again-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-01T02:1${index}:00.000Z`,
    }).revision;
  }
  const plan = planRereview({ root, recordId: 'endzone:issue-42', headSha: 'ccc3333' });
  assert.equal(plan.priorArtifactMissing, true);
  assert.deepEqual(plan.unresolved, []);
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'ccc3333', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [], noFindings: 'prior artifact gone; nothing new at ccc3333', priorArtifact: first.artifact,
    idempotencyKey: 'formal-2', now: '2026-09-01T02:20:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.priorArtifactMissing, true);
});

test('a crash between the hold transition and the page is repaired by the retry', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  // Simulate the crash: the transition committed (same key holdRecord would use)
  // but the process died before the outbox append.
  workState.transitionRecord({
    root, id: 'endzone:issue-42', to: 'hold', expectedRevision: revision,
    idempotencyKey: 'hold-1', actor: 'project-lead',
    evidence: 'wake:decision-needed; carve-out PR #77 waits for Cory', now: '2026-09-01T03:00:00.000Z',
  });
  const outbox = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  assert.equal(fs.existsSync(outbox), false);
  const retry = holdRecord({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    reason: 'carve-out PR #77 waits for Cory', actor: 'project-lead',
    idempotencyKey: 'hold-1', now: '2026-09-01T03:01:00.000Z',
  });
  assert.equal(retry.paged, true, 'the retry notices the missing page and delivers it');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1);
});

// Ticket 09: review deduplication has its own rollback flag.
test('state/flags/review-dedup-off records a second formal review at the same head instead of refusing it', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'bbb2222', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [], noFindings: 'nothing at bbb2222',
    idempotencyKey: 'formal-a', now: '2026-09-09T02:00:00.000Z',
  });
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'review-dedup-off'), 'x');
  // No explicit key and no prior link: exactly what a legacy second pass looks like.
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
    kind: 'formal', headSha: 'bbb2222', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [], noFindings: 'nothing at bbb2222, second pass',
    now: '2026-09-09T02:01:00.000Z',
  });
  assert.equal(second.result.replayed, false, 'the flag must beat the default replay key');
  assert.notEqual(second.artifact, first.artifact, 'the duplicate is written, not refused');
  fs.rmSync(path.join(root, 'state', 'flags', 'review-dedup-off'));
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: second.result.revision,
      kind: 'formal', headSha: 'bbb2222', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'formal-c', now: '2026-09-09T02:02:00.000Z', priorArtifact: second.artifact,
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'ALREADY_REVIEWED',
    'the flag removed, deduplication is back',
  );
});

// --- fleet#2: classify fails closed ---------------------------------------
// classify answers "does this diff need a risk reviewer?", so it is dangerous
// in exactly one direction: a wrong "no". Before fleet#2 a typo'd flag name
// (`--repo-path`, `--tenant-config`: assignment.js's names for the same two
// concepts) fell into a bucket nothing read, and classify answered
// riskReview:false over an empty diff, exit 0, byte-identical to the answer for
// no arguments at all. The interface is the test surface here: every case goes
// through `cli`, the same door the IC and the lead use.
//
// Red-tell: revert `classifyCli` to the old `if (args.repo && args.base)`
// fall-through and the typo cases below go green on riskReview:false instead of
// throwing; revert the schema in `parseArgs` and only the unknown-flag cases
// fail. Each guard has a case that only it turns.

const { cli, CLASSIFY_FLAGS } = require('../bin/review-policy');
const { execFileSync, spawnSync } = require('node:child_process');

function classifyRoot() {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify(TENANT));
  fs.writeFileSync(path.join(root, 'tenants', 'blank.json'), JSON.stringify({ name: 'blank' }));
  return root;
}

function refuses(argv, code, fragment) {
  assert.throws(() => cli(argv), (error) => {
    assert.ok(error instanceof ReviewPolicyError, `expected ReviewPolicyError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.code, code);
    if (fragment) assert.match(error.message, fragment);
    return true;
  });
}

test('classify: --tenant-config (assignment.js name) is refused as an unknown flag, not read as no tenant', () => {
  const root = classifyRoot();
  refuses(['classify', '--root', root, '--tenant-config', 'tenants/endzone.json', '--files', '["server/middleware/auth.js"]'], 'USAGE', /unknown flag --tenant-config/);
});

test('classify: --repo-path (assignment.js name) is refused as an unknown flag, never classified as an empty diff', () => {
  const root = classifyRoot();
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--repo-path', '/e/repo', '--base', 'abc', '--head', 'def'], 'USAGE', /unknown flag --repo-path; accepted: .*--repo\b/);
});

test('classify: the unknown-flag refusal names the accepted set', () => {
  const root = classifyRoot();
  assert.throws(() => cli(['classify', '--root', root, '--tenant', 'endzone', '--nope', 'x', '--files', '["a.js"]']), (error) => {
    for (const flag of CLASSIFY_FLAGS) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('classify: no arguments at all is a usage error, not an answer', () => {
  refuses(['classify'], 'USAGE', /--tenant <name> is required/);
});

test('classify: a tenant with no source of files is a usage error, never an empty diff', () => {
  const root = classifyRoot();
  refuses(['classify', '--root', root, '--tenant', 'endzone'], 'USAGE', /nothing to classify/);
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--files', '[]'], 'USAGE', /non-empty JSON array/);
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--repo', '/e/repo'], 'USAGE', /--repo needs --base/);
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--base', 'abc'], 'USAGE', /--base needs --repo/);
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--diff', path.join(root, 'missing.diff')], 'USAGE', /--diff file not found/);
});

test('classify: a tenant that declares neither carve-outs nor risk triggers is refused', () => {
  const root = classifyRoot();
  refuses(['classify', '--root', root, '--tenant', 'blank', '--files', '["server/middleware/auth.js"]'], 'EMPTY_TENANT', /could only ever answer riskReview:false/);
});

test('classify: a correct invocation still answers, with the files it classified', () => {
  const root = classifyRoot();
  const answer = cli(['classify', '--root', root, '--tenant', 'endzone', '--files', '["server/middleware/auth.js"]']);
  assert.equal(answer.riskReview, true);
  assert.deepEqual(answer.files, ['server/middleware/auth.js']);
  const docs = cli(['classify', '--root', root, '--tenant', 'endzone', '--files', '["docs/guide.md"]']);
  assert.equal(docs.riskReview, false);
  assert.deepEqual(docs.files, ['docs/guide.md']);
});

test('classify: the process exits 2 on a refusal and writes the refusal to stderr, no JSON answer on stdout', () => {
  const root = classifyRoot();
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const typo = spawnSync(process.execPath, [bin, 'classify', '--root', root, '--repo-path', '/e/repo', '--base', 'a', '--head', 'b', '--tenant-config', 'tenants/endzone.json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 2);
  assert.equal(typo.stdout, '');
  assert.equal(JSON.parse(typo.stderr).code, 'USAGE');
  const bare = spawnSync(process.execPath, [bin, 'classify'], { encoding: 'utf8', windowsHide: true });
  assert.equal(bare.status, 2);
  assert.equal(bare.stdout, '');
  const ok = execFileSync(process.execPath, [bin, 'classify', '--root', root, '--tenant', 'endzone', '--files', '["docs/guide.md"]'], { encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(ok).riskReview, false);
});

test('parseArgs: without a schema every flag is still accepted (the other binaries are unchanged)', () => {
  const args = workState.parseArgs(['--repo-path', '/x', '--flag', '--', 'rest']);
  assert.equal(args['repo-path'], '/x');
  assert.equal(args.flag, 'true');
  assert.deepEqual(args._, ['rest']);
});

test('parseArgs: with a schema an unknown flag is a USAGE error carrying the flag and the accepted set', () => {
  assert.throws(() => workState.parseArgs(['--repo-path', '/x'], ['repo', 'base']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.equal(error.flag, 'repo-path');
    assert.deepEqual(error.accepted, ['repo', 'base']);
    return true;
  });
  const args = workState.parseArgs(['--repo', '/x', '--', '--repo-path'], { flags: ['repo'] });
  assert.equal(args.repo, '/x');
  assert.deepEqual(args._, ['--repo-path'], 'tokens after -- are never flags, schema or not');
});

// --- fleet#20: a formal review cannot be recorded in ci-wait, and the refusal is unmistakable ---
// The lead role file says a PR whose gates are still running is not yet
// reviewable; two leads read the diff anyway, hit INVALID_REVIEW_STATE from
// the work-state door, and parked their findings in a PR comment and a temp
// file. The door stays closed (ADR 0009, ruling 1): the refusal now names the
// state that opens it, leaves no artifact behind, and exits 2 as a refused
// invocation rather than 1 as a failed one.

test('record --kind formal in ci-wait is refused with the door named, and leaves no artifact behind', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'ci-wait' });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] },
      findings: [{ file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'should-fix' }],
      idempotencyKey: 'formal-early', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => {
      assert.ok(error instanceof ReviewPolicyError, `expected ReviewPolicyError, got ${error && error.name}`);
      assert.equal(error.code, 'INVALID_REVIEW_STATE');
      assert.equal(error.state, 'ci-wait');
      assert.match(error.message, /cannot be recorded while ci-wait/);
      assert.match(error.message, /checks-settled/);
      assert.match(error.message, /`review`/);
      return true;
    },
  );
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'a refused review leaves no artifact');
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).review?.formal, undefined);
});

test('record: INVALID_REVIEW_STATE exits 2 with the refusal on stderr and nothing on stdout', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'ci-wait' });
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const early = spawnSync(process.execPath, [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'formal', '--head-sha', 'aaa1111', '--actor', 'project-lead',
    '--findings', '[{"file":"src/a.js","line":3,"claim":"off-by-one","severity":"should-fix"}]',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(early.status, 2);
  assert.equal(early.stdout, '');
  const refusal = JSON.parse(early.stderr);
  assert.equal(refusal.code, 'INVALID_REVIEW_STATE');
  assert.match(refusal.message, /checks-settled/);
});

// --- fleet#18: an artifact is never silent about its own result -------------
// `record --kind risk` accepted `findings: []` on endzone PR #1168 at the one
// moment it could still be corrected; the artifact then read as a clean review
// to anyone who opened it, indistinguishable from "the file lost its content".
// A reviewer who found nothing is a real outcome, so the refusal is
// satisfiable without lying: `--no-findings "<one sentence>"` writes the
// statement into the artifact. What is no longer possible is an artifact that
// says nothing (ADR 0009, ruling 2). The guard sits last, at the write, so the
// earlier refusals (ALREADY_REVIEWED, RISK_REVIEW_NOT_TRIGGERED,
// REREVIEW_REQUIRES_PRIOR, UNRESOLVED_FINDINGS_UNACCOUNTED) keep their cases.

const RISK = { tier: 'high-risk', triggers: [{ class: 'accessibility', matches: [{ pattern: 'aria-', file: 'src/a.jsx', line: 'aria-label' }] }] };

test('record --kind risk with an empty findings array is refused, leaves no artifact, and touches no state', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'risk', headSha: 'ce19d6a', actor: 'ic-42', classification: RISK, findings: [],
      idempotencyKey: 'risk-empty', now: '2026-09-10T18:56:28.000Z',
    }),
    (error) => {
      assert.ok(error instanceof ReviewPolicyError);
      assert.equal(error.code, 'EMPTY_FINDINGS');
      assert.match(error.message, /--no-findings/);
      return true;
    },
  );
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
  const record = workState.getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(record.revision, revision);
  assert.equal(record.review?.risk, undefined);
});

test('record --kind risk with an explicit no-findings statement writes the statement into the artifact', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const clean = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: 'ce19d6a', actor: 'ic-42', classification: RISK, findings: [],
    noFindings: 'Examined the Badge link for focus ring, hover and cursor; ButtonBase is reached via clickable, nothing to fix.',
    idempotencyKey: 'risk-clean', now: '2026-09-10T18:56:28.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, clean.artifact), 'utf8'));
  assert.deepEqual(stored.findings, []);
  assert.match(stored.noFindings, /^Examined the Badge link/);
  assert.equal(clean.result.record.review.risk.artifact, clean.artifact);
});

test('a formal review with no findings needs the same statement; a re-review that resolves everything can say so', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'formal-empty', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => error.code === 'EMPTY_FINDINGS',
  );
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'should-fix' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:01:00.000Z',
  });
  revision = first.result.revision;
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `again-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-01T02:1${index}:00.000Z`,
    }).revision;
  }
  // Every prior finding resolved and nothing new: the artifact still has to say so.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: 'ccc3333', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
      idempotencyKey: 'formal-2-empty', now: '2026-09-01T02:20:00.000Z',
    }),
    (error) => error.code === 'EMPTY_FINDINGS',
  );
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'ccc3333', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
    noFindings: 'Range aaa1111..ccc3333 fixes the off-by-one; nothing new in the changed lines.',
    idempotencyKey: 'formal-2', now: '2026-09-01T02:21:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.deepEqual(stored.findings, []);
  assert.deepEqual(stored.resolutions, { 'formal-001-f1': 'resolved' });
  assert.match(stored.noFindings, /nothing new/);
});

test('a no-findings statement cannot accompany findings, and cannot be blank or a bare flag', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const base = {
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: 'ce19d6a', actor: 'ic-42', classification: RISK, now: '2026-09-10T18:56:28.000Z',
  };
  assert.throws(
    () => recordReviewArtifact({ ...base, findings: [{ file: 'src/a.jsx', claim: 'x', severity: 'nit' }], noFindings: 'nothing', idempotencyKey: 'k1' }),
    (error) => error.code === 'USAGE' && /1 new, 0 still open/.test(error.message),
  );
  assert.throws(() => recordReviewArtifact({ ...base, findings: [], noFindings: '   ', idempotencyKey: 'k2' }), (error) => error.code === 'USAGE');
  assert.throws(() => recordReviewArtifact({ ...base, findings: [], noFindings: 'true', idempotencyKey: 'k3' }), (error) => error.code === 'USAGE');
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
});

test('record cli: --no-findings reaches the artifact; --no-finding and --findings-file are refused as unknown flags', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  for (const [flag, value] of [['--no-finding', 'nothing'], ['--findings-file', 'f.json']]) {
    assert.throws(
      () => cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--head-sha', 'ce19d6a',
        '--classification', JSON.stringify(RISK), flag, value]),
      (error) => error instanceof ReviewPolicyError && error.code === 'USAGE' && new RegExp(`unknown flag ${flag}`).test(error.message),
    );
  }
  const clean = cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--head-sha', 'ce19d6a',
    '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--no-findings', 'Examined the accessibility angle; nothing to fix.']);
  const stored = JSON.parse(fs.readFileSync(path.join(root, clean.artifact), 'utf8'));
  assert.equal(stored.noFindings, 'Examined the accessibility angle; nothing to fix.');
  assert.deepEqual(stored.findings, []);
});

test('record: EMPTY_FINDINGS exits 2 with the refusal on stderr and nothing on stdout', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const empty = spawnSync(process.execPath, [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'risk', '--head-sha', 'ce19d6a', '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--findings', '[]',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(empty.status, 2);
  assert.equal(empty.stdout, '');
  assert.equal(JSON.parse(empty.stderr).code, 'EMPTY_FINDINGS');
});

test('plan-rereview and hold refuse their confusable flag names too', () => {
  const root = rootDir();
  seedRecord(root);
  assert.throws(() => cli(['plan-rereview', '--root', root, '--id', 'endzone:issue-42', '--head', 'ccc3333']), (error) => error.code === 'USAGE' && /unknown flag --head/.test(error.message));
  assert.throws(() => cli(['hold', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', '4', '--why', 'carve-out']), (error) => error.code === 'USAGE' && /unknown flag --why/.test(error.message));
  assert.throws(() => cli(['unhold', '--root', root]), (error) => error.code === 'USAGE' && /unknown command/.test(error.message));
});

test('a no-findings statement is refused beside a carried-forward still-open finding; the carry itself needs no statement', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [
      { file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'should-fix' },
      { file: 'src/b.js', line: 9, claim: 'lost focus ring', severity: 'blocker' },
    ],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  revision = first.result.revision;
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `again-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-01T02:1${index}:00.000Z`,
    }).revision;
  }
  const resolutions = { 'formal-001-f1': 'resolved', 'formal-001-f2': 'still-open' };
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: 'ccc3333', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: first.artifact, resolutions, noFindings: 'nothing new in the range',
      idempotencyKey: 'formal-2-lie', now: '2026-09-01T02:20:00.000Z',
    }),
    (error) => error.code === 'USAGE' && /1 still open/.test(error.message),
  );
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'ccc3333', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions,
    idempotencyKey: 'formal-2', now: '2026-09-01T02:21:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.noFindings, null);
  assert.deepEqual(stored.findings.map((finding) => finding.id), ['formal-001-f2']);
  assert.equal(stored.findings[0].carriedFrom, first.artifact);
});

test('a duplicate finding id is refused before any artifact file exists', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: 'aaa1111', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] },
      findings: [{ id: 'same', file: 'src/a.js', claim: 'x', severity: 'nit' }, { id: 'same', file: 'src/b.js', claim: 'y', severity: 'nit' }],
      idempotencyKey: 'formal-dupid', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => error.code === 'DUPLICATE_FINDING_ID',
  );
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no 0-byte orphan artifact');
});
