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
    findings: [], priorArtifact: first.artifact,
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
