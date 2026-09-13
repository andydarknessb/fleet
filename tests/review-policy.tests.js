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
  // but the process died before the outbox append. Since fleet#56 the transition
  // door writes the line itself, so the crash window is inside that call: the
  // committed transition with its line removed is the state a retry finds.
  workState.transitionRecord({
    root, id: 'endzone:issue-42', to: 'hold', expectedRevision: revision,
    idempotencyKey: 'hold-1', actor: 'project-lead',
    evidence: 'wake:decision-needed; carve-out PR #77 waits for Cory', now: '2026-09-01T03:00:00.000Z',
  });
  const outbox = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  assert.equal(fs.existsSync(outbox), true, 'the door wrote the line');
  fs.rmSync(outbox);
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
      idempotencyKey: 'formal-c', now: '2026-09-09T02:02:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'ALREADY_REVIEWED',
    'the flag removed, deduplication is back (an unlinked same-head pass; a linked one is a re-review, fleet#19)',
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

// --- fleet#19: a body-only revision can be re-recorded at an unchanged head ---
// The replay key was kind:record:head, so a second formal pass at the same
// head always replayed the first, exit 0, discarding the findings and the
// resolutions it was given. A PR body changes without a commit (measurement
// claims, the risk-artifact pointer, the squash commit message), so a formal
// re-review that links its prior artifact is a new review even at the same
// head (ADR 0009, ruling 3); a retry of that same re-review still replays,
// and any replay says what it did not write.

test('a linked formal re-review at an unchanged head records a new artifact, resolving the prior findings', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'f91ba70', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'PR body', claim: 'asserts a command result that is false', severity: 'blocker' }],
    now: '2026-09-10T19:00:00.000Z',
  });
  // The prior link must name the recorded artifact, and every open finding needs a resolution.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'formal', headSha: 'f91ba70', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: 'state/reviews/endzone_issue-42/formal-009.json', resolutions: { 'formal-001-f1': 'resolved' },
      noFindings: 'body corrected', now: '2026-09-10T19:30:00.000Z',
    }),
    (error) => error.code === 'REREVIEW_REQUIRES_PRIOR',
  );
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'formal', headSha: 'f91ba70', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: first.artifact, noFindings: 'body corrected', now: '2026-09-10T19:30:00.000Z',
    }),
    (error) => error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED',
  );
  const plan = planRereview({ root, recordId: 'endzone:issue-42', headSha: 'f91ba70' });
  assert.equal(plan.range, 'f91ba70..f91ba70');
  assert.deepEqual(plan.unresolved.map((finding) => finding.id), ['formal-001-f1']);

  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
    kind: 'formal', headSha: 'f91ba70', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
    noFindings: 'PR body now states the measured result; nothing else changed at f91ba70.',
    now: '2026-09-10T19:31:00.000Z',
  });
  assert.equal(second.result.replayed, false, 'a linked re-review at the same head is a new review, not a replay');
  assert.notEqual(second.artifact, first.artifact);
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.priorArtifact, first.artifact);
  assert.equal(stored.range, 'f91ba70..f91ba70');
  assert.equal(stored.sameHead, true);
  assert.deepEqual(stored.resolutions, { 'formal-001-f1': 'resolved' });
  assert.deepEqual(stored.findings, []);
  assert.equal(second.result.record.review.formal.artifact, second.artifact);
  assert.deepEqual(planRereview({ root, recordId: 'endzone:issue-42', headSha: 'f91ba70' }).unresolved, []);

  // A linked third pass at the same head has nothing open to resolve: it is not a re-review.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: second.result.revision,
      kind: 'formal', headSha: 'f91ba70', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [], noFindings: 'still clean',
      priorArtifact: second.artifact, idempotencyKey: 'formal-3-linked', now: '2026-09-10T19:32:30.000Z',
    }),
    (error) => error.code === 'ALREADY_REVIEWED' && /nothing open to resolve/.test(error.message),
  );
  assert.equal(fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')).length, 2, 'no same-head pileup');

  // A retry of the same re-review replays it; an unlinked third pass is still refused.
  const retry = recordReviewArtifact({
    root, recordId: 'endzone:issue-42',
    kind: 'formal', headSha: 'f91ba70', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
    noFindings: 'PR body now states the measured result; nothing else changed at f91ba70.',
    now: '2026-09-10T19:32:00.000Z',
  });
  assert.equal(retry.result.replayed, true);
  assert.equal(retry.artifact, second.artifact);
  assert.equal(fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')).length, 2);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: second.result.revision,
      kind: 'formal', headSha: 'f91ba70', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [], noFindings: 'again',
      idempotencyKey: 'formal-3-unlinked', now: '2026-09-10T19:33:00.000Z',
    }),
    (error) => error.code === 'ALREADY_REVIEWED',
  );
});

test('a risk review at the same head is still exactly one review: the link is a formal-only door', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const classification = { tier: 'high-risk', triggers: [{ class: 'concurrency', matches: [{ pattern: 'FOR UPDATE', file: 'server/x.js', line: 'FOR UPDATE' }] }] };
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: 'ddd4444', actor: 'ic-42', classification,
    findings: [{ file: 'server/x.js', claim: 'lock order', severity: 'should-fix' }], now: '2026-09-10T19:00:00.000Z',
  });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'risk', headSha: 'ddd4444', actor: 'ic-42', classification,
      findings: [], noFindings: 'fixed', priorArtifact: first.artifact, resolutions: { 'risk-001-f1': 'resolved' },
      idempotencyKey: 'risk-2-linked', now: '2026-09-10T19:01:00.000Z',
    }),
    (error) => error.code === 'ALREADY_REVIEWED',
  );
});

test('a replay says what it did not write: the result names the ignored findings and resolutions', () => {
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
  assert.equal(first.ignored, undefined);
  const retry = recordReviewArtifact({
    ...args,
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit' }, { file: 'src/b.js', claim: 'y', severity: 'nit' }],
    resolutions: { 'formal-001-f1': 'resolved' },
  });
  assert.equal(retry.result.replayed, true);
  assert.deepEqual(retry.ignored, { findings: 2, resolutions: 1 });
  assert.equal(retry.artifact, first.artifact);
});

test('record cli: a replay exits 0 with the JSON answer on stdout and the not-written warning on stderr', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const argv = [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'formal', '--head-sha', 'aaa1111', '--actor', 'project-lead',
    '--findings', '[{"file":"src/a.js","claim":"x","severity":"nit"}]',
  ];
  const first = spawnSync(process.execPath, argv, { encoding: 'utf8', windowsHide: true });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const retry = spawnSync(process.execPath, argv, { encoding: 'utf8', windowsHide: true });
  assert.equal(retry.status, 0, retry.stderr);
  const answer = JSON.parse(retry.stdout);
  assert.equal(answer.result.replayed, true);
  assert.deepEqual(answer.ignored, { findings: 1, resolutions: 0 });
  assert.match(retry.stderr, /NOT written/);
  assert.match(retry.stderr, /--prior-artifact/);
});

// --- fleet#46: reviewer provenance defaults to the session's own name -------
// `record` wrote `reviewer: "unknown"` whenever --actor was omitted, and the
// documented invocation omitted it, so one record's chain carried both
// spellings. FLEET_NAME is in every fleet session's environment and is the
// name the field wants.

function withFleetName(value, body) {
  const saved = process.env.FLEET_NAME;
  if (value === undefined) delete process.env.FLEET_NAME; else process.env.FLEET_NAME = value;
  try { return body(); } finally {
    if (saved === undefined) delete process.env.FLEET_NAME; else process.env.FLEET_NAME = saved;
  }
}

test('fleet#46: record and hold take the reviewer from FLEET_NAME when --actor is omitted; --actor still wins', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  withFleetName('pl-endzone', () => {
    const recorded = cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
      '--kind', 'formal', '--head-sha', 'aaa1111', '--findings', '[{"file":"src/a.js","claim":"x","severity":"nit"}]']);
    const stored = JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8'));
    assert.equal(stored.reviewer, 'pl-endzone');
    assert.equal(recorded.result.record.review.formal.actor, 'pl-endzone');

    const held = cli(['hold', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(recorded.result.revision),
      '--reason', 'carve-out waits for Cory', '--no-notifier']);
    const holdEvent = workState.readEvents(root).find((event) => event.recordId === 'endzone:issue-42' && event.type === 'state-hold');
    assert.equal(held.result.record.state, 'hold');
    assert.equal(holdEvent.actor, 'pl-endzone');
  });

  const root2 = rootDir();
  const revision2 = seedRecord(root2);
  withFleetName('pl-endzone', () => {
    const explicit = cli(['record', '--root', root2, '--id', 'endzone:issue-42', '--expected-revision', String(revision2),
      '--kind', 'formal', '--head-sha', 'aaa1111', '--actor', 'cory', '--findings', '[{"file":"src/a.js","claim":"x","severity":"nit"}]']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root2, explicit.artifact), 'utf8')).reviewer, 'cory');
  });
});

test('fleet#46: with neither --actor nor FLEET_NAME the reviewer is still "unknown", never blank', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  withFleetName(undefined, () => {
    const recorded = cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
      '--kind', 'formal', '--head-sha', 'aaa1111', '--findings', '[{"file":"src/a.js","claim":"x","severity":"nit"}]']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8')).reviewer, 'unknown');
  });
});

// --- fleet#43: risk artifacts are no longer write-only ----------------------
// On endzone PR #1280 the IC wrote six findings with `outcome: "fixed"` beside
// `status: "open"`; nothing read `outcome`, nothing walked the risk chain, and
// `headSha` named a head the reviewer never read. Three rulings (ADR 0009, 5):
// a supplied finding cannot carry its own resolution; the tree the reviewer
// read is `reviewedSha`, distinct from the head the artifact is recorded at;
// and the lead's formal review resolves the risk artifact's open findings.

const RISK_FINDINGS = [
  { file: 'src/a.jsx', line: 10, claim: 'focus not restored on close', severity: 'should-fix' },
  { file: 'src/a.jsx', line: 22, claim: 'aria-expanded never flips', severity: 'should-fix' },
  { file: 'src/b.jsx', line: 5, claim: 'icon button has no name', severity: 'blocker' },
];

test('fleet#43: a supplied finding carrying outcome (or resolution) is refused before any file exists', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  for (const field of ['outcome', 'resolution']) {
    assert.throws(
      () => recordReviewArtifact({
        root, recordId: 'endzone:issue-42', expectedRevision: revision,
        kind: 'risk', headSha: 'ce19d6a', actor: 'ic-42', classification: RISK,
        findings: [{ ...RISK_FINDINGS[0], [field]: 'fixed' }, RISK_FINDINGS[1]],
        idempotencyKey: `risk-${field}`, now: '2026-09-12T10:00:00.000Z',
      }),
      (error) => error instanceof ReviewPolicyError && error.code === 'FINDING_CARRIES_OUTCOME' && error.message.includes(`\`${field}\``) && /--resolutions/.test(error.message),
    );
  }
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')));
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).review.risk, undefined);
});

test('fleet#43: FINDING_CARRIES_OUTCOME is a refused invocation: exit 2, refusal on stderr, nothing on stdout', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const refused = spawnSync(process.execPath, [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'risk', '--head-sha', 'ce19d6a', '--actor', 'ic-42', '--classification', JSON.stringify(RISK),
    '--findings', JSON.stringify([{ ...RISK_FINDINGS[0], outcome: 'fixed', status: 'open' }]),
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
  assert.equal(JSON.parse(refused.stderr).code, 'FINDING_CARRIES_OUTCOME');
});

test('fleet#43: a risk artifact records the tree the reviewer read as reviewedSha, and the uncovered delta as range', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const recorded = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: '17fa3c48', reviewedSha: '000c07b9', actor: 'ic-42', classification: RISK,
    findings: RISK_FINDINGS, idempotencyKey: 'risk-1', now: '2026-09-12T10:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8'));
  assert.equal(stored.headSha, '17fa3c48');
  assert.equal(stored.reviewedSha, '000c07b9');
  assert.equal(stored.range, '000c07b9..17fa3c48');
  assert.equal(recorded.result.record.review.risk.headSha, '17fa3c48');

  // Same tree read and recorded: reviewedSha equals headSha and range stays null.
  const root2 = rootDir();
  const revision2 = seedRecord(root2, { state: 'implementing' });
  const same = recordReviewArtifact({
    root: root2, recordId: 'endzone:issue-42', expectedRevision: revision2,
    kind: 'risk', headSha: 'ce19d6a', actor: 'ic-42', classification: RISK,
    findings: RISK_FINDINGS, idempotencyKey: 'risk-1', now: '2026-09-12T10:00:00.000Z',
  });
  const storedSame = JSON.parse(fs.readFileSync(path.join(root2, same.artifact), 'utf8'));
  assert.equal(storedSame.reviewedSha, 'ce19d6a');
  assert.equal(storedSame.range, null);
});

test('fleet#43: a formal review is recorded at the head it read; a differing --reviewed-sha is refused', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: 'aaa1111', reviewedSha: 'aaa0000', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] },
      findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit' }],
      idempotencyKey: 'formal-1', now: '2026-09-12T10:00:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'REVIEWED_SHA_MISMATCH' && /re-review/.test(error.message),
  );
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')));
  const ok = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: 'aaa1111', reviewedSha: 'aaa1111', actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit' }],
    idempotencyKey: 'formal-1', now: '2026-09-12T10:00:00.000Z',
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ok.artifact), 'utf8')).reviewedSha, 'aaa1111');
});

function seedRiskThenReview(root, { headSha = '17fa3c48', findings = RISK_FINDINGS } = {}) {
  const revision = seedRecord(root, { state: 'implementing' });
  const risk = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha, reviewedSha: '000c07b9', actor: 'ic-42', classification: RISK,
    findings, idempotencyKey: 'risk-1', now: '2026-09-12T10:00:00.000Z',
  });
  let current = risk.result.revision;
  ['pr-open', 'ci-wait', 'review'].forEach((to, index) => {
    current = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: current, idempotencyKey: `seed-${to}`,
      actor: 'test', evidence: 'seed', now: `2026-09-12T10:1${index}:00.000Z`,
    }).revision;
  });
  return { risk, revision: current };
}

test('fleet#43: the first formal review walks the risk chain: every open risk finding needs a resolution', () => {
  const root = rootDir();
  const { risk, revision } = seedRiskThenReview(root);
  const riskArtifact = JSON.parse(fs.readFileSync(path.join(root, risk.artifact), 'utf8'));
  assert.deepEqual(riskArtifact.findings.map((finding) => finding.status), ['open', 'open', 'open']);

  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: '17fa3c48', actor: 'project-lead', classification: RISK,
      findings: [{ file: 'src/c.js', claim: 'formal-only', severity: 'nit' }],
      idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED' && error.message.includes(risk.artifact) && error.unresolved.length === 3,
  );
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews', 'endzone_issue-42', 'formal-001.json')));

  const formal = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: '17fa3c48', actor: 'project-lead', classification: RISK,
    findings: [{ file: 'src/c.js', claim: 'formal-only', severity: 'nit' }],
    resolutions: { 'risk-001-f1': 'resolved', 'risk-001-f2': 'resolved', 'risk-001-f3': 'still-open' },
    idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, formal.artifact), 'utf8'));
  assert.equal(stored.riskArtifact, risk.artifact);
  assert.equal(stored.priorArtifact, null);
  assert.deepEqual(stored.findings.map((finding) => [finding.id, finding.status, finding.carriedFrom || null]), [
    ['formal-001-f1', 'open', null],
    ['risk-001-f3', 'open', risk.artifact],
  ]);

  // The re-review scopes from the formal artifact, which now carries the still-open risk finding.
  const plan = planRereview({ root, recordId: 'endzone:issue-42', headSha: '28ab0000' });
  assert.deepEqual(plan.unresolved.map((finding) => finding.id), ['formal-001-f1', 'risk-001-f3']);

  // A later formal re-review does not walk the risk artifact twice: only the formal prior binds.
  let current = formal.result.revision;
  ['revision', 'pr-open', 'ci-wait', 'review'].forEach((to, index) => {
    current = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: current, idempotencyKey: `cycle-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-12T12:1${index}:00.000Z`,
    }).revision;
  });
  const rereview = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: current,
    kind: 'formal', headSha: '28ab0000', actor: 'project-lead', classification: RISK,
    priorArtifact: formal.artifact,
    resolutions: { 'formal-001-f1': 'resolved', 'risk-001-f3': 'resolved' },
    noFindings: 'Re-read the changed range; the icon button is now named and nothing new was found.',
    idempotencyKey: 'formal-2', now: '2026-09-12T13:00:00.000Z',
  });
  const storedRereview = JSON.parse(fs.readFileSync(path.join(root, rereview.artifact), 'utf8'));
  assert.deepEqual(storedRereview.findings, []);
  assert.equal(storedRereview.riskArtifact, null);
});

test('fleet#43: a formal no-findings statement beside a still-open risk finding is refused, and a resolved chain can say so', () => {
  const root = rootDir();
  const { risk, revision } = seedRiskThenReview(root, { findings: [RISK_FINDINGS[0]] });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: '17fa3c48', actor: 'project-lead', classification: RISK,
      resolutions: { 'risk-001-f1': 'still-open' }, noFindings: 'Looked; nothing.',
      idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
    }),
    (error) => error.code === 'USAGE' && /0 new, 1 still open/.test(error.message) && error.message.includes(risk.artifact),
  );
  const clean = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: '17fa3c48', actor: 'project-lead', classification: RISK,
    resolutions: { 'risk-001-f1': 'resolved' }, noFindings: 'Verified the focus fix at 17fa3c48; Standards and Spec angles found nothing.',
    idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, clean.artifact), 'utf8'));
  assert.deepEqual(stored.findings, []);
  assert.deepEqual(stored.resolutions, { 'risk-001-f1': 'resolved' });
  assert.equal(stored.riskArtifact, risk.artifact);
});

test('fleet#43: a risk artifact whose file is gone degrades honestly instead of wedging the formal review', () => {
  const root = rootDir();
  const { risk, revision } = seedRiskThenReview(root);
  fs.rmSync(path.join(root, risk.artifact));
  const formal = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: '17fa3c48', actor: 'project-lead', classification: RISK,
    findings: [{ file: 'src/c.js', claim: 'formal-only', severity: 'nit' }],
    idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, formal.artifact), 'utf8'));
  assert.equal(stored.riskArtifact, risk.artifact);
  assert.equal(stored.riskArtifactMissing, true);
});

test('fleet#43: record cli accepts --reviewed-sha and refuses --reviewed (a typo is never a silent no-op)', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  assert.throws(
    () => cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--head-sha', '17fa3c48',
      '--reviewed', '000c07b9', '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--findings', JSON.stringify(RISK_FINDINGS)]),
    (error) => error.code === 'USAGE' && /unknown flag --reviewed/.test(error.message),
  );
  const recorded = cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--head-sha', '17fa3c48',
    '--reviewed-sha', '000c07b9', '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--findings', JSON.stringify(RISK_FINDINGS)]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8')).reviewedSha, '000c07b9');
});

// --- fleet#58: trigger patterns match in the case the tenant wrote them ------
// `patternRegExp` compiled every pattern with the `i` flag, so the SQL pattern
// `TRUNCATE` fired on the English word "truncated" in a comment (endzone PR
// #1344, risk-003.json) and the IC hosted an opus risk review on a false
// trigger. Tenant patterns are written in the case of the thing they detect.
test('fleet#58: a prose word in the wrong case does not fire a risk pattern; the SQL form still does', () => {
  const prose = classifyChange({
    files: ['src/widgets/player-decision-card/ui/PlayerDecisionCard.jsx'], changedLines: 40,
    addedLines: ['// long, truncated name reports `scrollWidth > clientWidth` despite nothing', 'const rows = list.slice(0, 3); // delete from the list, for update later'],
    tenant: TENANT,
  });
  assert.deepEqual(prose.triggers, [], 'prose in a comment is not a destructive or concurrency operation');
  const sql = classifyChange({
    files: ['server/services/cleanup.js'], changedLines: 12,
    addedLines: ['  await knex.raw("TRUNCATE stale_rows");', '  await trx("leagues").forUpdate(); // FOR UPDATE'],
    tenant: TENANT,
  });
  assert.deepEqual(sql.triggers.map((trigger) => trigger.class), ['destructive', 'concurrency']);
  // An unparseable pattern still falls back to a literal match, in the tenant's case.
  const literal = classifyChange({
    files: ['src/a.js'], changedLines: 3, addedLines: ['x = a[1'],
    tenant: { riskTriggers: { odd: { paths: [], patterns: ['a[1'] } } },
  });
  assert.deepEqual(literal.triggers.map((trigger) => trigger.class), ['odd']);
  const literalCase = classifyChange({
    files: ['src/a.js'], changedLines: 3, addedLines: ['x = A[1'],
    tenant: { riskTriggers: { odd: { paths: [], patterns: ['a[1'] } } },
  });
  assert.deepEqual(literalCase.triggers, []);
});
