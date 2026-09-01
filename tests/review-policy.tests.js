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
    host: 'ic', agent: 'qa-reviewer', model: 'opus', readOnly: true, timing: 'pre-pr-ready',
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
  const held = holdRecord({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    reason: 'carve-out PR #77 reviewed clean; waits for Cory', actor: 'project-lead',
    idempotencyKey: 'hold-1', now: '2026-09-01T03:00:00.000Z',
  });
  assert.equal(held.result.record.state, 'hold');
  assert.equal(held.paged, true);
  const outbox = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  const lines = fs.readFileSync(outbox, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).wake, 'decision-needed');

  // Page once: a replay does not append a second wake line.
  const replay = holdRecord({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    reason: 'carve-out PR #77 reviewed clean; waits for Cory', actor: 'project-lead',
    idempotencyKey: 'hold-1', now: '2026-09-01T03:01:00.000Z',
  });
  assert.equal(replay.paged, false);
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
