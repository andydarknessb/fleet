'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { evaluateChecks, planRecord, runWatch, closingLinked, hopsTo, escalatedHopsTo, WATCHER_MARK, cli, FLAGS } = require('../bin/pr-watch');
const workState = require('../bin/work-state');

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-pr-watch-'));
}

const TENANT = {
  github: 'owner/repo', branchPrefix: 'fleet/',
  ciGates: ['g1', 'g2'], watchedChecks: ['w1'], ignoredChecks: ['ig1'],
};

let seedCounter = 0;
function now() { seedCounter += 1; return new Date(Date.now() + seedCounter).toISOString(); }

function seed(root, { id = 'endzone:issue-42', issue = 42, state = 'ci-wait', prNumber = 77 } = {}) {
  workState.createRecord({
    root, id, tenant: 'endzone', issue, state: 'implementing',
    github: prNumber ? { issueNumber: issue, prNumber } : { issueNumber: issue },
    actor: 'test', idempotencyKey: `create-${issue}`, now: now(),
  });
  const hops = {
    implementing: [], 'pr-open': ['pr-open'], 'ci-wait': ['pr-open', 'ci-wait'],
    review: ['pr-open', 'ci-wait', 'review'], hold: ['pr-open', 'ci-wait', 'review', 'hold'],
  }[state] || [];
  let revision = 1;
  for (const to of hops) {
    revision = workState.transitionRecord({
      root, id, to, expectedRevision: revision, idempotencyKey: `seed-${to}-${issue}`,
      actor: 'test', evidence: 'seed', now: now(),
    }).revision;
  }
  return revision;
}

function check(name, status, conclusion) { return { name, status, conclusion }; }
const GREEN = [check('g1', 'COMPLETED', 'SUCCESS'), check('g2', 'COMPLETED', 'SUCCESS')];
function pr(overrides = {}) {
  return {
    number: 77, isDraft: false, headRefName: 'fleet/42-thing', headRefOid: 'abc123',
    statusCheckRollup: [check('g1', 'COMPLETED', 'SUCCESS'), check('g2', 'IN_PROGRESS', '')],
    ...overrides,
  };
}
function view(overrides = {}) {
  return { number: 77, state: 'OPEN', isDraft: false, mergedAt: null, headRefOid: 'abc123', statusCheckRollup: [], closingIssuesReferences: [], body: '', ...overrides };
}
function fetchers({ open = [pr()], viewResult = null, failList = false, failView = false } = {}) {
  return {
    listOpenPrs: () => { if (failList) throw new Error('boom: api down'); return JSON.parse(JSON.stringify(open)); },
    viewPr: () => { if (failView) throw new Error('boom: view down'); return JSON.parse(JSON.stringify(viewResult)); },
  };
}
function watch(root, f, opts = {}) {
  return runWatch({ root, tenantName: 'endzone', tenantConfig: TENANT, fetchers: f, shadow: false, ...opts });
}
function events(root) {
  const dir = path.join(root, 'state', 'events');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort().flatMap((f) =>
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
function record(root, id = 'endzone:issue-42') { return workState.getRecord({ root, id }); }
function outbox(root) {
  const p = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('check classification covers pending, success, failure, skipped, cancelled, missing, watched, ignored, unclassified', () => {
  const policy = { ciGates: ['a', 'b', 'c', 'd', 'e'], watchedChecks: ['w-ok', 'w-bad', 'w-skip', 'w-pend', 'w-miss'], ignoredChecks: ['ig'] };
  const rollup = [
    check('a', 'COMPLETED', 'SUCCESS'), check('b', 'IN_PROGRESS', ''), check('c', 'COMPLETED', 'FAILURE'),
    check('d', 'COMPLETED', 'CANCELLED'),
    check('w-ok', 'COMPLETED', 'SUCCESS'), check('w-bad', 'COMPLETED', 'FAILURE'),
    check('w-skip', 'COMPLETED', 'SKIPPED'), check('w-pend', 'QUEUED', ''),
    check('ig', 'COMPLETED', 'FAILURE'), check('mystery', 'COMPLETED', 'SUCCESS'),
  ];
  const e = evaluateChecks(policy, rollup);
  assert.deepEqual(e.gatePending.sort(), ['b', 'e']);
  assert.deepEqual(e.gateFailures.map((f) => `${f.name}=${f.conclusion}`).sort(), ['c=FAILURE', 'd=CANCELLED']);
  assert.deepEqual(e.gateMissing, ['e']);
  assert.equal(e.settled, false);
  assert.deepEqual(e.watchedFindings, [{ name: 'w-bad', conclusion: 'FAILURE' }]);
  assert.deepEqual(e.unclassified, ['mystery']);
});

test('closingLinked follows the #330 grammar: colon and URL forms link, code spans and newline-crossing do not', () => {
  assert.equal(closingLinked(view({ body: 'Closes #42' }), 42, 'owner/repo'), true);
  assert.equal(closingLinked(view({ body: 'Closes: #42' }), 42, 'owner/repo'), true);
  assert.equal(closingLinked(view({ body: 'fixes https://github.com/owner/repo/issues/42' }), 42, 'owner/repo'), true);
  assert.equal(closingLinked(view({ body: 'resolves owner/repo#42' }), 42, 'owner/repo'), true);
  assert.equal(closingLinked(view({ body: 'the bug `Closes #42` mentions' }), 42, 'owner/repo'), false);
  assert.equal(closingLinked(view({ body: 'is now fixed\n#42 tracks the rest' }), 42, 'owner/repo'), false);
  assert.equal(closingLinked(view({ body: 'Closes #421' }), 42, 'owner/repo'), false);
  assert.equal(closingLinked(view({ closingIssuesReferences: [{ number: 42 }], body: '' }), 42, 'owner/repo'), true);
});

test('hop paths come from the store transitions, including escalated resolutions from any prior state', () => {
  assert.deepEqual(hopsTo('implementing', 'merged'), ['pr-open', 'review', 'merged']);
  assert.deepEqual(hopsTo('ci-wait', 'merged'), ['review', 'merged']);
  assert.deepEqual(hopsTo('hold', 'merged'), ['merged']);
  assert.deepEqual(escalatedHopsTo('hold', 'merged'), ['merged']);
  assert.deepEqual(escalatedHopsTo('ci-wait', 'merged'), ['review', 'merged']);
  assert.deepEqual(escalatedHopsTo('implementing', 'merged'), ['pr-open', 'review', 'merged']);
});

test('a missing required gate can never settle, even with every observed gate green', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers({ open: [pr({ statusCheckRollup: [check('g1', 'COMPLETED', 'SUCCESS')] })] }));
  assert.equal(record(root).state, 'ci-wait');
});

test('pr-open moves to ci-wait on first observation without a wake', () => {
  const root = rootDir();
  seed(root, { state: 'pr-open' });
  watch(root, fetchers());
  assert.equal(record(root).state, 'ci-wait');
  assert.equal(outbox(root).length, 0);
});

test('one hundred identical polls append no event and touch no record after the first', () => {
  const root = rootDir();
  seed(root);
  const f = fetchers();
  watch(root, f);
  const after = events(root).length;
  const rev = record(root).revision;
  for (let i = 0; i < 100; i += 1) watch(root, f);
  assert.equal(events(root).length, after);
  assert.equal(record(root).revision, rev);
});

test('a changed gate state appends exactly one ordered event; an identical retry appends none', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers());
  const baseline = events(root).length;
  const f2 = fetchers({ open: [pr({ statusCheckRollup: [check('g1', 'COMPLETED', 'SUCCESS'), check('g2', 'IN_PROGRESS', ''), check('w1', 'COMPLETED', 'SUCCESS')] })] });
  watch(root, f2);
  const added = events(root).slice(baseline);
  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'pr-observed');
  assert.equal(added[0].changes.wake, null);
  watch(root, f2);
  assert.equal(events(root).length, baseline + 1);
});

test('a recurring identical failure after an intervening change wakes again (keys are revision-scoped)', () => {
  const root = rootDir();
  seed(root);
  const fail = fetchers({ open: [pr({ statusCheckRollup: [check('g1', 'COMPLETED', 'FAILURE'), check('g2', 'COMPLETED', 'SUCCESS')] })] });
  const pending = fetchers({ open: [pr({ statusCheckRollup: [check('g1', 'IN_PROGRESS', ''), check('g2', 'COMPLETED', 'SUCCESS')] })] });
  watch(root, fail);
  assert.equal(outbox(root).length, 1);
  watch(root, pending);   // CI re-run in progress
  watch(root, fail);      // fails identically again
  const wakes = outbox(root);
  assert.equal(wakes.length, 2);
  assert.deepEqual(wakes.map((w) => w.wake), ['checks-failed', 'checks-failed']);
  assert.equal(record(root).state, 'ci-wait');
});

test('settled gates with linkage move to review, wake checks-settled once, and the outbox points at the wake event', () => {
  const root = rootDir();
  seed(root);
  const f = fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) });
  watch(root, f);
  assert.equal(record(root).state, 'review');
  const wakes = outbox(root);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].wake, 'checks-settled');
  const wakeEvent = events(root).find((e) => e.sequence === wakes[0].eventSequence && e.recordId === wakes[0].recordId);
  assert.match(wakeEvent.evidence, /^wake:checks-settled; /);
  const before = events(root).length;
  watch(root, f);
  assert.equal(events(root).length, before);
  assert.equal(outbox(root).length, 1);
});

test('settled gates without linkage reach decision-needed with the watcher mark, never review', () => {
  const root = rootDir();
  seed(root);
  const f = fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'refs #42 only' }) });
  const launches = [];
  watch(root, f, { notifier: (launch) => launches.push(launch) });
  const rec = record(root);
  assert.equal(rec.state, 'escalated');
  assert.equal(rec.prior_state, 'ci-wait');
  assert.ok(String(rec.decisionEvidence).includes(WATCHER_MARK));
  assert.equal(outbox(root)[0].wake, 'decision-needed');
  // Ticket 07: the decision event launches one notifier, pointed at that event.
  assert.deepEqual(launches, [{ root, recordId: 'endzone:issue-42', sequence: outbox(root)[0].eventSequence }]);
  watch(root, f, { notifier: (launch) => launches.push(launch) });
  assert.equal(launches.length, 1, 'a steady-state tick launches nothing');
});

test('a human escalation is never resolved or touched by the watcher', () => {
  const root = rootDir();
  const revision = seed(root);
  workState.transitionRecord({
    root, id: 'endzone:issue-42', to: 'escalated', expectedRevision: revision,
    idempotencyKey: 'human-esc', actor: 'pl-endzone', evidence: 'scope question, do not proceed until Cory rules', now: now(),
  });
  const f = fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) });
  const health = watch(root, f);
  const rec = record(root);
  assert.equal(rec.state, 'escalated');
  assert.equal(rec.decisionEvidence, 'scope question, do not proceed until Cory rules');
  assert.equal(health.actions.length, 0);
});

test('a watcher escalation self-resolves when linkage appears, then settles normally', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'no keyword' }) }));
  assert.equal(record(root).state, 'escalated');
  const fixed = fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) });
  watch(root, fixed);
  assert.equal(record(root).state, 'ci-wait');
  watch(root, fixed);
  assert.equal(record(root).state, 'review');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'checks-settled']);
});

test('close, reopen, close again escalates twice - no permanent replay wedge', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers());   // establish ci-wait observation
  const closed = fetchers({ open: [], viewResult: view({ state: 'CLOSED' }) });
  watch(root, closed);
  assert.equal(record(root).state, 'escalated');
  watch(root, fetchers({ open: [pr()], viewResult: view({ body: 'Closes #42' }) }));   // reopened, linked -> resolves
  assert.equal(record(root).state, 'ci-wait');
  watch(root, closed);
  assert.equal(record(root).state, 'escalated');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'decision-needed']);
});

test('an escalation with prior_state hold resolves to merged in a single legal hop', () => {
  const root = rootDir();
  seed(root, { state: 'hold' });
  watch(root, fetchers({ open: [], viewResult: view({ state: 'CLOSED' }) }));
  const esc = record(root);
  assert.equal(esc.state, 'escalated');
  assert.equal(esc.prior_state, 'hold');
  watch(root, fetchers({ open: [], viewResult: view({ state: 'MERGED', mergedAt: '2026-09-01T02:00:00Z' }) }));
  const rec = record(root);
  assert.equal(rec.state, 'merged');
  assert.equal(rec.github.mergedAt, '2026-09-01T02:00:00Z');
});

test('the watcher has no issue-close path of any kind', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bin', 'pr-watch.js'), 'utf8');
  assert.doesNotMatch(source, /issue\s+close|issues\/[^\s]*close|closeIssue/i);
});

test('a merged PR fast-forwards to merged and the final observation matches the merged reality', () => {
  const root = rootDir();
  seed(root);
  // Ticket 09: a merge on a record with no formal review recorded carries a decision-needed
  // wake (the ticket-05 lower bound). This case is the reviewed path, so record one first.
  const activePath = path.join(root, 'state', 'work', 'active.json');
  const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
  active.records['endzone:issue-42'].review = { ...(active.records['endzone:issue-42'].review || {}), formal: { headSha: 'abc', artifact: 'state/reviews/x.json' } };
  fs.writeFileSync(activePath, JSON.stringify(active));
  watch(root, fetchers({ open: [], viewResult: view({ state: 'MERGED', mergedAt: '2026-09-01T01:00:00Z' }) }));
  const rec = record(root);
  assert.equal(rec.state, 'merged');
  assert.equal(rec.github.mergedAt, '2026-09-01T01:00:00Z');
  assert.equal(rec.github.observation.prState, 'MERGED');
  assert.equal(outbox(root).length, 0);
});

test('an implementing record with a known merged PR fast-forwards instead of sticking', () => {
  const root = rootDir();
  seed(root, { state: 'implementing', prNumber: 77 });
  watch(root, fetchers({ open: [], viewResult: view({ state: 'MERGED', mergedAt: '2026-09-01T03:00:00Z' }) }));
  assert.equal(record(root).state, 'merged');
});

test('a revision record whose PR is live again re-enters pr-open', () => {
  const root = rootDir();
  const revision = seed(root);
  workState.transitionRecord({
    root, id: 'endzone:issue-42', to: 'revision', expectedRevision: revision,
    idempotencyKey: 'to-revision', actor: 'test', evidence: 'CI findings returned', now: now(),
  });
  watch(root, fetchers());
  assert.equal(record(root).state, 'pr-open');
});

test('a draft conversion is paused work: no action, no escalation, no wake', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers());
  const before = events(root).length;
  watch(root, fetchers({ open: [], viewResult: view({ isDraft: true, statusCheckRollup: GREEN }) }));
  assert.equal(record(root).state, 'ci-wait');
  assert.equal(events(root).length, before);
  assert.equal(outbox(root).length, 0);
});

test('an open PR beyond the list (overflow) is watched through the view, not treated as closed', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers());
  const f = fetchers({ open: [], viewResult: view({ statusCheckRollup: GREEN, body: 'Closes #42' }) });
  watch(root, f);
  assert.equal(record(root).state, 'review');
  assert.equal(outbox(root)[0].wake, 'checks-settled');
});

test('linkage disappearing during review escalates decision-needed before any merge', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  const f = fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'keyword removed by an edit' }) });
  watch(root, f);
  const rec = record(root);
  assert.equal(rec.state, 'escalated');
  assert.equal(rec.prior_state, 'review');
  assert.equal(outbox(root)[0].wake, 'decision-needed');
});

// fleet#44: the closing-linkage rule re-derived "no closing keyword" from GitHub on
// every tick and re-escalated a deliberate Refs body a lead had already resolved,
// each time blocking the formal review. A resolved closing-linkage escalation is a
// ruling on that body: the same body never re-escalates, an edited body does.
function resolveAsLead(root, to, evidence = 'Refs is deliberate: AC1 is escalated to Cory; closure is mine at the merge') {
  return workState.transitionRecord({
    root, id: 'endzone:issue-42', to, expectedRevision: record(root).revision,
    idempotencyKey: `pl-resolve-${record(root).revision}`, actor: 'pl-endzone', evidence, now: now(),
  });
}
const REFS_BODY = 'Refs #42 (deliberate; AC1 ruling open)';

test('fleet#44: a lead-resolved closing-linkage escalation is not re-raised while the body is unchanged', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  const f = fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: REFS_BODY }) });
  watch(root, f);
  assert.equal(record(root).state, 'escalated', 'the first escalation is legitimate');
  resolveAsLead(root, 'review');
  const resolved = record(root);
  assert.ok(String(resolved.resolvedDecisionEvidence).includes(`${WATCHER_MARK} closing-linkage body=`), 'the store keeps the answered fact beside the resolution');
  for (let tick = 0; tick < 5; tick += 1) {
    const health = watch(root, f);
    assert.equal(record(root).state, 'review', `tick ${tick}: an already-ruled Refs body must not re-escalate`);
    if (tick > 0) assert.deepEqual(health.actions, [], `tick ${tick}: steady state is silent`);
  }
  assert.equal(record(root).github.observation.closingVerified, false, 'the observation says what the body says');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed'], 'one page, not one per tick');
});

test('fleet#44: the ruling survives a re-ready: settled gates at a new head go to review with checks-settled, never back to escalated', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: REFS_BODY }) }));
  assert.equal(record(root).state, 'escalated');
  resolveAsLead(root, 'revision');   // the lead sends it back to the IC on the same ruling
  const rereadied = fetchers({ open: [pr({ headRefOid: 'def456', statusCheckRollup: GREEN })], viewResult: view({ headRefOid: 'def456', body: REFS_BODY }) });
  watch(root, rereadied);
  assert.equal(record(root).state, 'pr-open');
  watch(root, rereadied);
  assert.equal(record(root).state, 'ci-wait');
  watch(root, rereadied);
  const rec = record(root);
  assert.equal(rec.state, 'review', 'settled gates on a ruled body reach review');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'checks-settled']);
  const settledEvent = events(root).filter((e) => e.type === 'state-review').pop();
  assert.match(String(settledEvent.evidence), /ruled deliberate by the lead/);
});

test('fleet#44: an edited body is a new fact and escalates again; a closing keyword resolves it as before', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: REFS_BODY }) }));
  resolveAsLead(root, 'review');
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Refs #42 and the ruling paragraph was rewritten' }) }));
  assert.equal(record(root).state, 'escalated', 'a different body was never ruled on');
  assert.equal(record(root).prior_state, 'review');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'decision-needed']);
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) }));
  assert.equal(record(root).state, 'review', 'linkage appearing still self-resolves the watcher own escalation');
});

test('fleet#34: a re-readied PR whose record sits in review re-enters ci-wait on the new head, then wakes checks-settled when it settles', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  // Baseline: the lead reviewed head abc123 (green, linked) and returned it without moving the record.
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) }));
  assert.equal(record(root).state, 'review');
  assert.deepEqual(outbox(root), []);

  // The IC pushes fixes: new head, every gate pending. The record must stop reading `review`.
  const pending = [check('g1', 'IN_PROGRESS', ''), check('g2', 'QUEUED', '')];
  watch(root, fetchers({ open: [pr({ headRefOid: 'def456', statusCheckRollup: pending })], viewResult: view({ headRefOid: 'def456', body: 'Closes #42' }) }));
  assert.equal(record(root).state, 'ci-wait', 'a new head with pending gates is ci-wait, not review');
  assert.deepEqual(outbox(root), []);

  // Gates settle green at the new head: the lead gets exactly one checks-settled wake.
  const f = fetchers({ open: [pr({ headRefOid: 'def456', statusCheckRollup: GREEN })], viewResult: view({ headRefOid: 'def456', statusCheckRollup: GREEN, body: 'Closes #42' }) });
  watch(root, f);
  assert.equal(record(root).state, 'review');
  const wakes = outbox(root);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].wake, 'checks-settled');
  watch(root, f);
  assert.equal(outbox(root).length, 1);
});

test('fleet#34: a re-readied PR whose new head is already green wakes checks-settled in one tick', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) }));
  assert.deepEqual(outbox(root), []);
  watch(root, fetchers({ open: [pr({ headRefOid: 'def456', statusCheckRollup: GREEN })], viewResult: view({ headRefOid: 'def456', statusCheckRollup: GREEN, body: 'Closes #42' }) }));
  assert.equal(record(root).state, 'review');
  const wakes = outbox(root);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].wake, 'checks-settled');
});

test('fleet#34: a gate failure at a re-readied head wakes checks-failed instead of sitting silent in review', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) }));
  const red = [check('g1', 'COMPLETED', 'FAILURE'), check('g2', 'COMPLETED', 'SUCCESS')];
  watch(root, fetchers({ open: [pr({ headRefOid: 'def456', statusCheckRollup: red })], viewResult: view({ headRefOid: 'def456', body: 'Closes #42' }) }));
  assert.equal(record(root).state, 'ci-wait');
  const wakes = outbox(root);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].wake, 'checks-failed');
});

test('an implementing record discovers its PR by branch prefix and moves to pr-open', () => {
  const root = rootDir();
  seed(root, { state: 'implementing', prNumber: null });
  watch(root, fetchers({ open: [pr({ number: 88, headRefName: 'fleet/42-slug' })] }));
  const rec = record(root);
  assert.equal(rec.state, 'pr-open');
  assert.equal(rec.github.prNumber, 88);
});

test('a GitHub list failure retains every prior observation and reports watcher health', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers());
  const rev = record(root).revision;
  const evCount = events(root).length;
  const health = watch(root, fetchers({ failList: true }));
  assert.equal(health.ok, false);
  assert.match(health.error, /boom: api down/);
  assert.equal(record(root).revision, rev);
  assert.equal(events(root).length, evCount);
  const healthFile = JSON.parse(fs.readFileSync(path.join(root, 'state', 'watch', 'health.json'), 'utf8'));
  assert.equal(healthFile.ok, false);
});

test('a per-record view failure marks watcher health not-ok instead of hiding the wedge', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers());
  const health = watch(root, fetchers({ open: [], failView: true }));
  assert.equal(health.ok, false);
  assert.equal(health.failures, 1);
  assert.equal(record(root).state, 'ci-wait');
});

test('observe replays on its idempotency key and refuses a stale revision', () => {
  const root = rootDir();
  seed(root);
  const rev = record(root).revision;
  const first = workState.observeRecord({
    root, id: 'endzone:issue-42', expectedRevision: rev, idempotencyKey: 'obs-1',
    actor: 'test', observation: { digest: 'd1' },
  });
  assert.equal(first.replayed, false);
  const replay = workState.observeRecord({
    root, id: 'endzone:issue-42', expectedRevision: 99, idempotencyKey: 'obs-1',
    actor: 'test', observation: { digest: 'd1' },
  });
  assert.equal(replay.replayed, true);
  assert.throws(() => workState.observeRecord({
    root, id: 'endzone:issue-42', expectedRevision: rev, idempotencyKey: 'obs-2',
    actor: 'test', observation: { digest: 'd2' },
  }), /expected revision/);
});

test('the end-of-run shadow projection archives a record only after its merge was recorded', () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const rosterPath = path.join(root, 'state', 'roster.json');
  fs.writeFileSync(rosterPath, JSON.stringify({ sessions: [{ name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42, sessionId: 'sess-42', status: 'active' }] }), 'utf8');
  workState.shadowProject({ root, actor: 'test' });
  const projected = Object.values(JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records);
  assert.equal(projected.length, 1);
  const id = projected[0].id;
  // The IC retires: its roster row is gone, but the PR merged and must be recorded first.
  fs.writeFileSync(rosterPath, JSON.stringify({ sessions: [] }), 'utf8');
  const f = fetchers({ open: [pr({ number: 91, headRefName: 'fleet/42-slug' })] });
  watch(root, f, { shadow: true });
  // The projection runs LAST: the record advanced (and recorded PR #91) before the
  // roster-dropped retirement archived it - the in-flight work was not lost unseen.
  const rec = workState.getRecord({ root, id });
  assert.equal(rec.github.prNumber, 91);
  const evs = events(root).filter((e) => e.recordId === id).map((e) => e.type);
  assert.ok(evs.indexOf('state-pr-open') >= 0, 'the advance must be recorded');
  assert.ok(evs.indexOf('shadow-retired') >= 0, 'the roster-dropped record is archived');
  assert.ok(evs.indexOf('state-pr-open') < evs.indexOf('shadow-retired'), 'the advance must precede the archive');
});

// Ticket 09: the ticket-05 lower bound (no merge without a recorded formal review) cannot
// be blocked by a script, but an observed merge on a record with no formal review carries
// a decision-needed wake so it pages once instead of passing silently.
test('an observed merge without a recorded formal review carries a decision-needed wake; with one it is silent', () => {
  const root = rootDir();
  seed(root, { id: 'endzone:issue-60', issue: 60, state: 'review', prNumber: 160 });
  const record = JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records['endzone:issue-60'];
  const merged = view({ number: 160, state: 'MERGED', mergedAt: '2026-09-09T00:00:00.000Z', isDraft: false });
  const policy = { ciGates: [], watchedChecks: [], ignoredChecks: [] };
  const unreviewed = planRecord({ record, openPr: null, viewPr: merged, policy, branchPrefix: 'fleet/', repo: 'owner/repo' });
  const last = unreviewed.actions[unreviewed.actions.length - 1];
  assert.equal(last.to, 'merged');
  assert.equal(last.wake, 'decision-needed');
  assert.match(last.evidence, /without a recorded formal review/);
  assert.ok(unreviewed.actions.slice(0, -1).every((a) => a.wake === null), 'only the merged hop wakes');
  const withFormal = { ...record, review: { ...record.review, formal: { headSha: 'abc', artifact: 'state/reviews/x.json' } } };
  const reviewed = planRecord({ record: withFormal, openPr: null, viewPr: merged, policy, branchPrefix: 'fleet/', repo: 'owner/repo' });
  assert.equal(reviewed.actions[reviewed.actions.length - 1].wake, null);
  assert.doesNotMatch(reviewed.actions[reviewed.actions.length - 1].evidence, /without a recorded formal review/);
  // Its rollback flag: the merge completes silently.
  const off = planRecord({ record, openPr: null, viewPr: merged, policy, branchPrefix: 'fleet/', repo: 'owner/repo', formalReviewWake: false });
  assert.equal(off.actions[off.actions.length - 1].wake, null);
  const flagged = rootDir();
  seed(flagged, { id: 'endzone:issue-62', issue: 62, state: 'review', prNumber: 162 });
  fs.mkdirSync(path.join(flagged, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(flagged, 'state', 'flags', 'merge-review-wake-off'), 'x');
  watch(flagged, fetchers({ open: [], viewResult: view({ number: 162, state: 'MERGED', mergedAt: '2026-09-09T00:00:00Z', isDraft: false }) }));
  assert.equal(workState.getRecord({ root: flagged, id: 'endzone:issue-62' }).state, 'merged');
  assert.equal(outbox(flagged).length, 0, 'under the flag no wake is written');
});

test('state/flags/pr-watch-off makes the tick skip without touching state', () => {
  const { spawnSync } = require('node:child_process');
  const root = rootDir();
  seed(root, { id: 'endzone:issue-61', issue: 61, state: 'ci-wait', prNumber: 161 });
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'owner/repo', branchPrefix: 'fleet/', ciGates: [] }));
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'pr-watch-off'), 'x');
  const before = fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8');
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pr-watch.js'), '--root', root, '--tenant', 'endzone', '--gh', 'no-such-gh-binary'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.skipped, true);
  assert.match(out.reason, /pr-watch-off/);
  assert.equal(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8'), before, 'nothing moved');
  assert.equal(fs.existsSync(path.join(root, 'state', 'watch', 'health.json')), false, 'no tick ran');
});

// fleet#4: pr-watch.js is invoked with flags only (never a subcommand word) by every
// PowerShell caller (bin/rotate.ps1, bin/run-pr-watch.ps1) and by the tests above, so
// `watch` is the sole entry in FLAGS - but a typo'd flag must still be refused rather
// than falling into a bucket nothing reads (that used to mean e.g. --dryrun silently
// running for real, or --tenatn silently falling back to tenant auto-discovery).

test('cli refuses a typo\'d flag for the watch command, naming the flag and the accepted set', () => {
  assert.throws(() => cli(['--root', 'r', '--tenant', 'endzone', '--dryrun', 'true']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /--dryrun/);
    for (const flag of FLAGS.watch) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('cli refuses an unknown command, listing the known commands', () => {
  assert.throws(() => cli(['bogus-command']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /bogus-command/);
    assert.match(error.message, /watch/);
    return true;
  });
});

test('cli watch still runs a correct invocation exactly as before (the pr-watch-off skip)', () => {
  const root = rootDir();
  seed(root, { id: 'endzone:issue-63', issue: 63, state: 'ci-wait', prNumber: 163 });
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'owner/repo', branchPrefix: 'fleet/', ciGates: [] }));
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'pr-watch-off'), 'x');
  const result = cli(['--root', root, '--tenant', 'endzone', '--gh', 'no-such-gh-binary']);
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'state/flags/pr-watch-off stands: CI watching is disabled; remove the flag to resume' });
});

test('a typo\'d flag on the command line exits 2 with an empty stdout and USAGE JSON on stderr', () => {
  const { spawnSync } = require('node:child_process');
  const root = rootDir();
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pr-watch.js'), '--root', root, '--tenant', 'endzone', '--dryrun', 'true'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  const err = JSON.parse(run.stderr.trim());
  assert.equal(err.code, 'USAGE');
  assert.match(err.message, /--dryrun/);
});
