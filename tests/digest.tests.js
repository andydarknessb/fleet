'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { projectDigest, foldLedger } = require('../bin/digest');
const { addExclusion, liftExclusion } = require('../bin/exclusions');
const { runNotifier } = require('../bin/notify');
const workState = require('../bin/work-state');

function rootDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-digest-'));
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({
    name: 'endzone', github: 'owner/repo', readyLabel: 'ready-for-agent', defaultBranch: 'integration', releaseBranch: 'main',
    carveOuts: ['server/db/migrations/**', '.github/workflows/**'],
  }));
  return root;
}

let tick = 0;
function at() { tick += 1; return new Date(Date.UTC(2026, 8, 1, 7, 0, 0, tick)).toISOString(); }

function walk(root, issue, states, { prNumber = 100 + issue } = {}) {
  const id = `endzone:issue-${issue}`;
  workState.createRecord({ root, id, tenant: 'endzone', issue, state: 'implementing', github: { issueNumber: issue, prNumber }, actor: 'test', idempotencyKey: `c-${issue}`, now: at() });
  let revision = 1;
  let last = null;
  for (const to of states) {
    last = workState.transitionRecord({
      root, id, to, expectedRevision: revision, idempotencyKey: `t-${issue}-${to}`, actor: 'test', now: at(),
      evidence: to === 'escalated' ? 'wake:decision-needed; [pr-watch] needs a human' : `to ${to}`,
      testOnly: to === 'merged', githubState: to === 'merged' ? 'MERGED' : undefined, githubMergedAt: to === 'merged' ? at() : undefined, githubEvidence: 'test',
    });
    revision = last.revision;
  }
  return { id, revision, sequence: last ? last.eventSequence : 1 };
}

function section(content, heading) {
  const start = content.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `section ${heading} present`);
  const next = content.indexOf('\n## ', start + 1);
  return content.slice(start, next < 0 ? undefined : next);
}

test('the digest rebuilt from the same event offset is byte-stable, even after the ledger grows', () => {
  const root = rootDir();
  walk(root, 1, ['pr-open', 'ci-wait', 'escalated']);
  walk(root, 2, ['pr-open', 'ci-wait', 'review', 'merged']);
  addExclusion({ root, tenant: 'endzone', issue: 9, reason: 'human pass', evidence: 'skip#9', owner: 'cory', actor: 'test', recheck: { event: { type: 'exclusion-lifted' } }, now: at() });
  const first = projectDigest({ root, now: '2026-09-01T08:00:00.000Z' });
  const offset = first.offset;
  assert.ok(offset.events > 0);
  const again = projectDigest({ root, offset: offset.events, exclusionsOffset: offset.exclusions, now: '2026-09-01T08:00:00.000Z' });
  assert.equal(again.content, first.content);
  assert.equal(fs.readFileSync(path.join(root, 'state', 'status', 'DIGEST.md'), 'utf8'), first.content);
  walk(root, 3, ['pr-open']);
  liftExclusion({ root, tenant: 'endzone', id: 'endzone:excl-9-1', actor: 'cory', evidence: 'done', now: at() });
  const grown = projectDigest({ root, now: '2026-09-01T08:00:00.000Z' });
  assert.notEqual(grown.content, first.content);
  const replayed = projectDigest({ root, offset: offset.events, exclusionsOffset: offset.exclusions, now: '2026-09-01T08:00:00.000Z' });
  assert.equal(replayed.content, first.content);
  assert.doesNotMatch(first.content, /\d{4}-\d{2}-\d{2}T08:00:00/, 'the clock is not printed; only ledger offsets and event times are');
});

test('one decision event is one digest item, with its delivery state, before and after notification', () => {
  const root = rootDir();
  const { id, sequence } = walk(root, 1, ['pr-open', 'ci-wait', 'escalated']);
  walk(root, 2, ['pr-open', 'ci-wait', 'review', 'hold']);
  let digest = projectDigest({ root, now: '2026-09-01T08:00:00.000Z' });
  let needs = section(digest.content, 'Needs Cory');
  assert.equal((needs.match(/endzone #1 /g) || []).length, 1);
  assert.match(needs, new RegExp(`${id} r\\d+ seq${sequence}`));
  assert.match(needs, /notification: not yet sent/);
  assert.match(needs, /endzone #2 - hold/);
  assert.match(needs, /PR #102/);
  const authorityBefore = section(digest.content, "Cory's authority");

  runNotifier({ root, live: true, send: () => ({ ok: true, detail: 'toast shown' }), now: '2026-09-01T07:30:00.000Z' });
  digest = projectDigest({ root, now: '2026-09-01T08:00:00.000Z' });
  needs = section(digest.content, 'Needs Cory');
  assert.equal((needs.match(/endzone #1 /g) || []).length, 1, 'delivery adds state to the item, never a second item');
  assert.match(needs, /notification: sent 2026-09-01T07:30:00\.000Z via toast \(attempt 1\)/);
  assert.equal(section(digest.content, "Cory's authority"), authorityBefore);
  assert.match(authorityBefore, /applies `ready-for-agent`/);
  assert.match(authorityBefore, /server\/db\/migrations\/\*\*/);
  assert.match(authorityBefore, /promotes `integration` to `main`/);
});

test('a failed delivery is visible as delivery state and names the retry door', () => {
  const root = rootDir();
  const { id, sequence } = walk(root, 1, ['pr-open', 'ci-wait', 'escalated']);
  runNotifier({ root, live: true, send: () => ({ ok: false, detail: 'toast api unavailable' }), now: '2026-09-01T07:30:00.000Z' });
  let needs = section(projectDigest({ root, now: '2026-09-01T08:00:00.000Z' }).content, 'Needs Cory');
  assert.match(needs, /notification: FAILED 2026-09-01T07:30:00\.000Z \(attempt 1\): toast api unavailable - retry needs `work-state\.js notify --phase authorize-retry`/);
  const record = workState.getRecord({ root, id });
  workState.notifyRecord({ root, id, phase: 'authorize-retry', expectedRevision: record.revision, decisionSequence: sequence, idempotencyKey: 'a', actor: 'cory', evidence: 'ok' });
  needs = section(projectDigest({ root, now: '2026-09-01T08:00:00.000Z' }).content, 'Needs Cory');
  assert.match(needs, /retry authorized by cory/);
});

test('frontier exclusions project as active or discharged with their reason, owner, recheck, and evidence', () => {
  const root = rootDir();
  walk(root, 40, ['pr-open', 'ci-wait', 'review', 'merged']);
  addExclusion({ root, tenant: 'endzone', issue: 5, reason: 'human-only evidence', evidence: 'state/skip/endzone.json#issues.5', owner: 'cory', actor: 'test', recheck: { event: { type: 'exclusion-lifted' } }, now: '2026-09-01T06:00:00.000Z' });
  addExclusion({ root, tenant: 'endzone', issue: 6, reason: 'short hold', evidence: 'e6', owner: 'pl-endzone', actor: 'test', recheck: { expiresAt: '2026-09-01T07:30:00.000Z' }, now: '2026-09-01T06:00:00.000Z' });
  addExclusion({ root, tenant: 'endzone', issue: 7, reason: 'waits for #40', evidence: 'e7', owner: 'pl-endzone', actor: 'test', recheck: { event: { type: 'state-merged', issue: 40 } }, now: '2026-09-01T06:00:00.000Z' });
  const content = projectDigest({ root, now: '2026-09-01T08:00:00.000Z' }).content;
  const exclusions = section(content, 'Frontier exclusions');
  assert.match(exclusions, /### Active\n- endzone #5 - owner cory - recheck: event exclusion-lifted - evidence state\/skip\/endzone\.json#issues\.5 - endzone:excl-5-1\n  reason: human-only evidence/);
  assert.match(exclusions, /### Discharged\n/);
  assert.match(exclusions, /- endzone #6 - expired 2026-09-01T07:30:00\.000Z/);
  assert.match(exclusions, /- endzone #7 - event:state-merged .* endzone:issue-40 seq \d+/);
  const earlier = projectDigest({ root, now: '2026-09-01T07:00:00.000Z' }).content;
  assert.match(section(earlier, 'Frontier exclusions'), /### Active\n(?:.*\n)*- endzone #6 /);
});

test('tenant status is the same projection scoped to one tenant; the fold reads state from events alone', () => {
  const root = rootDir();
  walk(root, 1, ['pr-open', 'ci-wait']);
  fs.writeFileSync(path.join(root, 'tenants', 'other.json'), JSON.stringify({ name: 'other', github: 'o/r', readyLabel: 'ready', defaultBranch: 'main', releaseBranch: 'release', carveOuts: [] }));
  workState.createRecord({ root, id: 'other:issue-9', tenant: 'other', issue: 9, state: 'implementing', actor: 'test', idempotencyKey: 'c-o', now: at() });
  const tenant = projectDigest({ root, tenant: 'endzone', now: '2026-09-01T08:00:00.000Z' });
  assert.equal(tenant.output, path.join(root, 'state', 'status', 'endzone-status.md'));
  assert.match(tenant.content, /^# endzone status/);
  assert.match(section(tenant.content, 'Active work'), /endzone #1 - ci-wait/);
  assert.doesNotMatch(tenant.content, /other #9/);
  const fleet = projectDigest({ root, now: '2026-09-01T08:00:00.000Z' });
  assert.match(section(fleet.content, 'Active work'), /other #9 - implementing/);
  const folded = foldLedger(workState.readEvents(root));
  assert.equal(folded.get('endzone:issue-1').state, 'ci-wait');
  assert.equal(folded.get('endzone:issue-1').prNumber, 101);
  assert.equal(folded.get('other:issue-9').tenant, 'other');
});

// Review round (2026-09-01): the fold must not read present-day state into a past offset.
test('a PR number learned after the offset does not leak into a replay of that offset', () => {
  const root = rootDir();
  workState.createRecord({ root, id: 'endzone:issue-1', tenant: 'endzone', issue: 1, state: 'implementing', actor: 'test', idempotencyKey: 'c-1', now: at() });
  const before = projectDigest({ root, now: '2026-09-01T08:00:00.000Z' });
  assert.doesNotMatch(before.content, /PR #/);
  workState.transitionRecord({ root, id: 'endzone:issue-1', to: 'pr-open', prNumber: 777, expectedRevision: 1, idempotencyKey: 't-1', actor: 'test', evidence: 'e', now: at() });
  const replay = projectDigest({ root, offset: before.offset.events, exclusionsOffset: before.offset.exclusions, now: '2026-09-01T08:00:00.000Z' });
  assert.equal(replay.content, before.content);
  assert.match(projectDigest({ root, now: '2026-09-01T08:00:00.000Z' }).content, /PR #777/);
});

test('a legacy record whose creation event predates prNumber on the ledger still shows its PR from the archive', () => {
  const root = rootDir();
  const { id } = walk(root, 5, ['pr-open', 'ci-wait', 'review', 'merged', 'retiring', 'retired']);
  // Strip the prNumber keys the ledger gained at ticket 07 to reproduce a pre-07 ledger.
  const file = path.join(root, 'state', 'events', fs.readdirSync(path.join(root, 'state', 'events')).find((name) => name.endsWith('.jsonl')));
  const stripped = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const event = JSON.parse(line);
    if (event.changes && 'prNumber' in event.changes) delete event.changes.prNumber;
    return JSON.stringify(event);
  }).join('\n');
  fs.writeFileSync(file, `${stripped}\n`);
  const content = projectDigest({ root, now: '2026-09-01T08:00:00.000Z' }).content;
  assert.match(section(content, 'Merged (last 10 in the ledger window)'), new RegExp(`endzone #5 - PR #105`));
  assert.ok(fs.existsSync(path.join(root, 'state', 'archive', `work-${id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`)));
});
