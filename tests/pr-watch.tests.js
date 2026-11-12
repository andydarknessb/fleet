'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./temp-dir');
const test = require('node:test');

const { evaluateChecks, planRecord, runWatch, closingLinked, closingLinkage, hopsTo, escalatedHopsTo, WATCHER_MARK, cli, FLAGS, fleetGhRunner } = require('../bin/pr-watch');
const workState = require('../bin/work-state');
const exclusions = require('../bin/exclusions');
const { selectFrontier } = require('../bin/assignment');
const { CASES: CLOSING_CASES, ISSUE: CLOSING_ISSUE, REPO: CLOSING_REPO } = require('./closing-link.cases');

function rootDir() {
  return makeTempDir('fleet-pr-watch-');
}

const TENANT = {
  github: 'owner/repo', branchPrefix: 'fleet/', ownerLogin: 'cory',
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
function fetchers({ open = [pr()], viewResult = null, failList = false, failView = false, issueState = 'OPEN', failIssue = false, comments = () => [], closedAt = () => null } = {}) {
  return {
    issueComments: (n, since) => comments(n, since),
    issueClosedAt: (n) => closedAt(n),
    issueState: () => { if (failIssue) throw new Error('boom: issue view down'); return issueState; },
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

// #202: the shared parser cases (tests/closing-link.cases.js), the same table
// pr-ready-check.tests.js runs. Here: the watcher's verdict, and what a settled
// ci-wait tick then does with it (only `none` escalates).
for (const c of CLOSING_CASES) {
  test(`#202 shared closing-link case: ${c.name} is ${c.expect}`, () => {
    const viewPr = view({ body: c.body });
    assert.equal(closingLinkage(viewPr, CLOSING_ISSUE, CLOSING_REPO), c.expect);
    const rec = { id: 'endzone:issue-42', tenant: 'endzone', issue: CLOSING_ISSUE, state: 'ci-wait', revision: 3, github: { prNumber: 77 } };
    const plan = planRecord({ record: rec, openPr: pr({ statusCheckRollup: GREEN }), viewPr, policy: { ciGates: ['g1', 'g2'], watchedChecks: [], ignoredChecks: [] }, repo: CLOSING_REPO });
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].to, c.expect === 'none' ? 'escalated' : 'review');
  });
}

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

test('a pr-open first look with a gate already red wakes checks-failed once; the next identical tick adds nothing', () => {
  const root = rootDir();
  seed(root, { state: 'pr-open' });
  const red = fetchers({ open: [pr({ statusCheckRollup: [check('g1', 'COMPLETED', 'FAILURE'), check('g2', 'COMPLETED', 'SUCCESS')] })] });
  watch(root, red);
  assert.equal(record(root).state, 'ci-wait');
  const wakes = outbox(root);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].wake, 'checks-failed');
  const transition = events(root).find((e) => e.type === 'state-ci-wait');
  assert.match(transition.evidence, /^wake:checks-failed; /);
  assert.ok(transition.evidence.includes('g1=FAILURE'));
  const before = events(root).length;
  watch(root, red);
  assert.equal(outbox(root).length, 1);
  assert.equal(events(root).length, before);
});

test('a pr-open first look with one gate red and another pending wakes checks-failed and names only the failed gate', () => {
  const root = rootDir();
  seed(root, { state: 'pr-open' });
  watch(root, fetchers({ open: [pr({ statusCheckRollup: [check('g1', 'COMPLETED', 'FAILURE'), check('g2', 'IN_PROGRESS', '')] })] }));
  assert.deepEqual(outbox(root).map((w) => w.wake), ['checks-failed']);
  const transition = events(root).find((e) => e.type === 'state-ci-wait');
  assert.equal(transition.evidence, 'wake:checks-failed; gate failure on PR #77: g1=FAILURE');
});

test('a pr-open first look with every gate green moves to ci-wait with no wake', () => {
  const root = rootDir();
  seed(root, { state: 'pr-open' });
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })] }));
  assert.equal(record(root).state, 'ci-wait');
  assert.equal(outbox(root).length, 0);
  const transition = events(root).find((e) => e.type === 'state-ci-wait');
  assert.equal(transition.evidence, 'CI already settled');
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

function gateAttempt(startedAt) { return { ...check('g1', 'COMPLETED', 'FAILURE'), startedAt }; }
const G2_GREEN = check('g2', 'COMPLETED', 'SUCCESS');

test('#377: a rerun that fails again between two ticks writes a second checks-failed line', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers({ open: [pr({ statusCheckRollup: [gateAttempt('2026-11-05T21:10:00Z'), G2_GREEN] })] }));
  watch(root, fetchers({ open: [pr({ statusCheckRollup: [gateAttempt('2026-11-05T21:32:58Z'), G2_GREEN] })] }));
  assert.equal(record(root).state, 'ci-wait');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['checks-failed', 'checks-failed']);
});

test('#377: one attempt polled repeatedly adds no event', () => {
  const root = rootDir();
  seed(root);
  const f = fetchers({ open: [pr({ statusCheckRollup: [gateAttempt('2026-11-05T21:10:00Z'), G2_GREEN] })] });
  watch(root, f);
  const before = events(root).length;
  for (let i = 0; i < 5; i += 1) watch(root, f);
  assert.equal(events(root).length, before);
  assert.equal(outbox(root).length, 1);
});

test('#377: a StatusContext never moves the digest, even when it posts again', () => {
  const root = rootDir();
  seed(root);
  const status = (startedAt) => ({ __typename: 'StatusContext', context: 'netlify/deploy-preview', state: 'SUCCESS', startedAt });
  const tick = (startedAt) => watch(root, fetchers({ open: [pr({ statusCheckRollup: [gateAttempt('2026-11-05T21:10:00Z'), G2_GREEN, status(startedAt)] })] }));
  tick('2026-11-05T18:12:02Z');
  const before = events(root).length;
  tick('2026-11-05T18:12:02Z');
  tick('2026-11-05T18:12:42Z');
  assert.equal(events(root).length, before);
  assert.equal(outbox(root).length, 1);
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
  assert.equal(wakes[0].actor, 'pr-watch', 'fleet#141: an observe wake names its writer');
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
  // fleet#141: the watcher's own decision-needed carries its actor, so the frontier wake still delivers it to the lead.
  assert.equal(outbox(root)[0].actor, 'pr-watch');
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

// fleet #419: the owner's comment on an escalated record answers the ask. The watcher writes an owner-answer wake and
// never changes the record; the lead reads the comment and resolves the record itself.
const OWNER_COMMENT = { id: 9001, user: { login: 'cory' }, created_at: '2099-01-01T00:00:00Z', html_url: 'https://github.com/owner/repo/issues/42#issuecomment-9001' };
function escalateByLead(root) {
  const revision = seed(root);
  workState.transitionRecord({
    root, id: 'endzone:issue-42', to: 'escalated', expectedRevision: revision,
    idempotencyKey: 'lead-esc', actor: 'pl-endzone', evidence: 'scope question: keep the old API?', now: now(),
  });
}
function ownerAnswers(root) { return outbox(root).filter((w) => w.wake === 'owner-answer'); }

test('#419: an owner comment after the escalation writes one owner-answer line naming it; a second tick adds none and the record stands', () => {
  const root = rootDir();
  escalateByLead(root);
  const before = record(root);
  const eventCount = events(root).length;
  const calls = [];
  const f = fetchers({ comments: (n, since) => { calls.push({ n, since }); return n === 42 ? [OWNER_COMMENT] : []; } });
  watch(root, f);
  watch(root, f);
  const escalatedAt = workState.enteringEvent(events(root), 'endzone:issue-42', 'escalated').at;
  assert.ok(calls.some((c) => c.n === 42 && c.since === escalatedAt), `the issue is read since the escalation event: ${JSON.stringify(calls)}`);
  assert.equal(ownerAnswers(root).length, 1);
  assert.equal(ownerAnswers(root)[0].idempotencyKey, 'watch:endzone:issue-42:owner-answer:9001');
  assert.equal(ownerAnswers(root)[0].evidence, `owner comment ${OWNER_COMMENT.html_url} after the escalation`);
  assert.equal(record(root).state, 'escalated');
  assert.equal(record(root).revision, before.revision);
  assert.equal(events(root).length, eventCount, 'no ledger event for the wake');
});

test('#419: a comment by another login, or an owner comment from before the escalation, writes no owner-answer line', () => {
  const root = rootDir();
  escalateByLead(root);
  const other = { ...OWNER_COMMENT, id: 9002, user: { login: 'someone-else' } };
  const early = { ...OWNER_COMMENT, id: 9003, created_at: '2000-01-01T00:00:00Z' };
  watch(root, fetchers({ comments: () => [other, early] }));
  assert.deepEqual(ownerAnswers(root), []);
});

test('#419: an owner comment on the PR of an escalated record counts as the answer', () => {
  const root = rootDir();
  escalateByLead(root);
  const onPr = { ...OWNER_COMMENT, id: 9004, html_url: 'https://github.com/owner/repo/pull/77#issuecomment-9004' };
  watch(root, fetchers({ comments: (n) => (n === 77 ? [onPr] : []) }));
  assert.equal(ownerAnswers(root).length, 1);
  assert.match(ownerAnswers(root)[0].evidence, /pull\/77#issuecomment-9004/);
});

test('#419: a newer owner comment writes a second owner-answer line, and neither line carries an eventSequence (the watchdog keys a line on it)', () => {
  const root = rootDir();
  escalateByLead(root);
  watch(root, fetchers({ comments: () => [OWNER_COMMENT] }));
  const newer = { ...OWNER_COMMENT, id: 9005, created_at: '2099-02-01T00:00:00Z', html_url: 'https://github.com/owner/repo/issues/42#issuecomment-9005' };
  watch(root, fetchers({ comments: () => [OWNER_COMMENT, newer] }));
  const lines = ownerAnswers(root);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => !('eventSequence' in l)), JSON.stringify(lines));
  assert.ok(lines[1].evidence.includes(newer.html_url), lines[1].evidence);
});

test('#419: when one read returns two owner comments, the line names the newest', () => {
  const root = rootDir();
  escalateByLead(root);
  const newer = { ...OWNER_COMMENT, id: 9006, created_at: '2099-03-01T00:00:00Z', html_url: 'https://github.com/owner/repo/issues/42#issuecomment-9006' };
  watch(root, fetchers({ comments: (n) => (n === 42 ? [OWNER_COMMENT, newer] : []) }));
  assert.equal(ownerAnswers(root).length, 1);
  assert.ok(ownerAnswers(root)[0].evidence.includes(newer.html_url), ownerAnswers(root)[0].evidence);
});

test('#419: a failed PR-number read loses only that read; the owner comment on the issue is still written', () => {
  const root = rootDir();
  escalateByLead(root);
  const health = watch(root, fetchers({ comments: (n) => { if (n === 77) throw new Error('boom: pr comments down'); return [OWNER_COMMENT]; } }));
  assert.equal(ownerAnswers(root).length, 1);
  assert.equal(health.failures, 1);
  assert.ok(health.actions.some((a) => a.includes('owner-answer check failed on #77')), JSON.stringify(health.actions));
});

test('#419: the since is the escalation event in the ledger, not the outbox cache: a lost outbox line does not move it', () => {
  const root = rootDir();
  const revision = seed(root);
  workState.transitionRecord({
    root, id: 'endzone:issue-42', to: 'escalated', expectedRevision: revision,
    idempotencyKey: 'lead-esc', actor: 'pl-endzone', evidence: 'scope question: keep the old API?', now: '2030-01-01T00:00:00.000Z',
  });
  fs.rmSync(path.join(root, 'state', 'watch', 'wake-outbox.jsonl'), { force: true });
  workState.observeRecord({ root, id: 'endzone:issue-42', expectedRevision: revision + 1, idempotencyKey: 'obs-after-escalation', observation: { digest: 'after' }, now: '2030-01-01T00:02:00.000Z' });
  watch(root, fetchers({ comments: () => [{ ...OWNER_COMMENT, created_at: '2030-01-01T00:01:00Z' }] }));
  assert.equal(record(root).state, 'escalated');
  assert.equal(ownerAnswers(root).length, 1);
});

test('#419: a dry run names the owner-answer it would write and writes no outbox line', () => {
  const root = rootDir();
  escalateByLead(root);
  const health = watch(root, fetchers({ comments: (n) => (n === 42 ? [OWNER_COMMENT] : []) }), { dryRun: true });
  assert.deepEqual(ownerAnswers(root), []);
  assert.ok(health.actions.some((a) => a.startsWith('DRY endzone:issue-42: owner-answer wake')), JSON.stringify(health.actions));
});

test('#419: a record in hold is never read for an owner comment', () => {
  const root = rootDir();
  seed(root, { state: 'hold' });
  const asked = [];
  watch(root, fetchers({ open: [pr()], comments: (n) => { asked.push(n); return [OWNER_COMMENT]; } }));
  assert.deepEqual(asked, []);
  assert.deepEqual(ownerAnswers(root), []);
});

test('#419: a record that is not escalated never has its comments read', () => {
  const root = rootDir();
  seed(root);
  const asked = [];
  watch(root, fetchers({ comments: (n) => { asked.push(n); return [OWNER_COMMENT]; } }));
  assert.deepEqual(asked, []);
  assert.deepEqual(ownerAnswers(root), []);
});

test('#419: a tenant with no ownerLogin reads no comments and writes no owner-answer (fail closed)', () => {
  const root = rootDir();
  escalateByLead(root);
  const asked = [];
  runWatch({ root, tenantName: 'endzone', tenantConfig: { ...TENANT, ownerLogin: undefined }, fetchers: fetchers({ comments: (n) => { asked.push(n); return [OWNER_COMMENT]; } }), shadow: false });
  assert.deepEqual(asked, []);
  assert.deepEqual(ownerAnswers(root), []);
});

test('#419: a failed comment read is noted in the health actions, and the other records still tick', () => {
  const root = rootDir();
  escalateByLead(root);
  seed(root, { id: 'endzone:issue-43', issue: 43, prNumber: 78, state: 'pr-open' });
  const open = [pr(), pr({ number: 78, headRefName: 'fleet/43-thing' })];
  const health = watch(root, fetchers({ open, comments: () => { throw new Error('boom: comments down'); } }));
  assert.equal(record(root, 'endzone:issue-43').state, 'ci-wait');
  assert.equal(record(root).state, 'escalated');
  assert.equal(health.failures, 2, 'one per failed read: the issue and the PR');
  assert.ok(health.actions.some((a) => a.startsWith('endzone:issue-42: owner-answer check failed') && a.includes('boom: comments down')), JSON.stringify(health.actions));
});

// fleet #432: an escalation with no PR and no manifest has nothing else to end it, so its issue closing after the
// escalation abandons it. The abandoning tick writes no owner-answer: the record is gone.
function escalateWithoutPr(root, manifestPath = null) {
  workState.createRecord({
    root, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, state: 'implementing',
    github: { issueNumber: 42 }, manifestPath, actor: 'test', idempotencyKey: 'create-42', now: now(),
  });
  workState.transitionRecord({
    root, id: 'endzone:issue-42', to: 'escalated', expectedRevision: 1,
    idempotencyKey: 'lead-esc', actor: 'pl-endzone', evidence: 'scope question: keep the old API?', now: now(),
  });
}

test('#432: an escalation with no PR and no manifest is abandoned once its issue closes after the escalation: one resolution wake, no owner-answer, the abandon named', () => {
  const root = rootDir();
  escalateWithoutPr(root);
  const health = watch(root, fetchers({ closedAt: () => '2099-01-01T00:00:00Z', comments: () => [OWNER_COMMENT] }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8')).records['endzone:issue-42'], undefined);
  assert.equal(record(root).state, 'abandoned');
  assert.match(record(root).abandonment.reason, /issue #42 closed at 2099-01-01T00:00:00Z, after the escalation/);
  const resolutions = outbox(root).filter((w) => w.wake === 'resolution');
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].recordId, 'endzone:issue-42');
  assert.equal(resolutions[0].to, 'abandoned');
  // The lead must not be the actor of its own resolution wake: bin/dormancy.js and bin/watchdog.ps1 drop those.
  assert.equal(resolutions[0].actor, 'pr-watch');
  assert.equal(record(root).abandonment.actor, 'pr-watch');
  assert.equal(ownerAnswers(root).length, 0, 'the abandoning tick does not answer');
  assert.ok(health.actions.includes('endzone:issue-42: abandoned, issue #42 closed at 2099-01-01T00:00:00Z after the escalation'), JSON.stringify(health.actions));
});

test('#432: an escalation with no PR and no manifest stays escalated while its issue is open, and the owner answer still lands', () => {
  const root = rootDir();
  escalateWithoutPr(root);
  watch(root, fetchers({ closedAt: () => null, comments: () => [OWNER_COMMENT] }));
  assert.equal(record(root).state, 'escalated');
  assert.equal(ownerAnswers(root).length, 1);
});

test('#432: an issue closed at or before the escalation leaves the record escalated', () => {
  const root = rootDir();
  escalateWithoutPr(root);
  const at = workState.enteringEvent(events(root), 'endzone:issue-42', 'escalated').at;
  for (const closedAt of ['2000-01-01T00:00:00Z', at]) watch(root, fetchers({ closedAt: () => closedAt }));
  assert.equal(record(root).state, 'escalated');
  assert.equal(record(root).revision, 2);
});

test('#432: a record with a PR or a manifest is never read for its issue, and both stay escalated', () => {
  const asked = [];
  const closedAt = (n) => { asked.push(n); throw new Error('boom: a record with a PR or a manifest must not read its issue'); };
  const withPr = rootDir();
  escalateByLead(withPr);
  const withManifest = rootDir();
  escalateWithoutPr(withManifest, path.join(withManifest, 'manifests', 'issue-42.json'));
  for (const root of [withPr, withManifest]) {
    watch(root, fetchers({ closedAt }));
    assert.equal(record(root).state, 'escalated');
  }
  assert.deepEqual(asked, []);
});

test('#432: an unreadable issue retains the escalated record and counts a release failure, not a failed tick; the owner answer still runs', () => {
  const root = rootDir();
  escalateWithoutPr(root);
  const health = watch(root, fetchers({ closedAt: () => { throw new Error('boom: issue view down'); }, comments: () => [OWNER_COMMENT] }));
  assert.equal(record(root).state, 'escalated');
  assert.equal(health.releaseFailures, 1);
  assert.equal(health.failures, 0);
  assert.equal(health.ok, true);
  assert.ok(health.actions.some((a) => a.startsWith('endzone:issue-42: issue view failed, retained') && a.includes('boom: issue view down')), JSON.stringify(health.actions));
  assert.equal(ownerAnswers(root).length, 1);
});

test('#432: an unreadable ledger retains the escalated record and counts the failure; the tick does not throw', () => {
  const root = rootDir();
  escalateWithoutPr(root);
  const eventsDir = path.join(root, 'state', 'events');
  const file = fs.readdirSync(eventsDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()[0];
  fs.appendFileSync(path.join(eventsDir, file), 'not json\n');
  // No owner login: ownerAnswerWake reads the same ledger and would count its own failure, so the count here is the abandon's alone.
  const health = runWatch({ root, tenantName: 'endzone', tenantConfig: { ...TENANT, ownerLogin: undefined }, fetchers: fetchers({ closedAt: () => '2099-01-01T00:00:00Z' }), shadow: false });
  assert.equal(record(root).state, 'escalated');
  // Two counts from the one unreadable ledger: this abandon check, and releaseClosedIssueExclusions' exclusion ledger read (existing).
  assert.equal(health.failures, 2, JSON.stringify(health.actions));
  assert.ok(health.actions.some((a) => a.startsWith('endzone:issue-42: issue-closed check failed')), JSON.stringify(health.actions));
});

test('#432: a dry run names the abandon it would make, changes nothing, and writes no outbox line', () => {
  const root = rootDir();
  escalateWithoutPr(root);
  const before = record(root);
  const lines = outbox(root).length;
  const health = watch(root, fetchers({ closedAt: () => '2099-01-01T00:00:00Z', comments: () => [OWNER_COMMENT] }), { dryRun: true });
  assert.equal(record(root).state, 'escalated');
  assert.equal(record(root).revision, before.revision);
  assert.equal(outbox(root).length, lines);
  assert.ok(health.actions.includes('DRY endzone:issue-42: abandon (issue #42 closed at 2099-01-01T00:00:00Z)'), JSON.stringify(health.actions));
  assert.ok(!health.actions.some((a) => a.includes('owner-answer')), JSON.stringify(health.actions));
});

test('#432: a second tick after the abandon is a no-op: no second resolution wake', () => {
  const root = rootDir();
  escalateWithoutPr(root);
  const f = fetchers({ closedAt: () => '2099-01-01T00:00:00Z' });
  watch(root, f);
  const second = watch(root, f);
  assert.equal(outbox(root).filter((w) => w.wake === 'resolution').length, 1);
  assert.deepEqual(second.actions, []);
});

// fleet #432: a record escalated, answered back to implementing, and escalated again. The ask that is still open is the second one.
function escalateTwiceWithAnswer(root, observedAt) {
  const id = 'endzone:issue-42';
  workState.createRecord({ root, id, tenant: 'endzone', issue: 42, state: 'implementing', github: { issueNumber: 42 }, actor: 'test', idempotencyKey: 'create-42', now: '2026-11-11T10:00:00.000Z' });
  workState.transitionRecord({ root, id, to: 'escalated', expectedRevision: 1, idempotencyKey: 'lead-esc-1', actor: 'pl-endzone', evidence: 'first ask', now: '2026-11-11T10:05:00.000Z' });
  workState.transitionRecord({ root, id, to: 'implementing', expectedRevision: 2, idempotencyKey: 'answer-1', actor: 'cory', evidence: 'answered', now: '2026-11-11T10:20:00.000Z' });
  workState.transitionRecord({ root, id, to: 'escalated', expectedRevision: 3, idempotencyKey: 'lead-esc-2', actor: 'pl-endzone', evidence: 'second ask', now: '2026-11-11T11:00:00.000Z' });
  workState.observeRecord({ root, id, expectedRevision: 4, idempotencyKey: 'obs-after-second-escalation', observation: { digest: 'after' }, now: observedAt });
}

test('#432: the issue is judged against the latest escalation, not the first one or the last update', () => {
  const between = rootDir();
  escalateTwiceWithAnswer(between, '2026-11-11T11:30:00.000Z');
  watch(between, fetchers({ closedAt: () => '2026-11-11T10:50:00.000Z' }));   // after the first ask, before the second: answered then
  assert.equal(record(between).state, 'escalated');
  const after = rootDir();
  escalateTwiceWithAnswer(after, '2026-11-11T11:30:00.000Z');
  watch(after, fetchers({ closedAt: () => '2026-11-11T11:10:00.000Z' }));   // after the second ask, before the record's last update
  assert.equal(record(after).state, 'abandoned');
});

test('#432: a closedAt that is not a date leaves the record escalated and counts no failure', () => {
  const root = rootDir();
  escalateWithoutPr(root);
  const health = watch(root, fetchers({ closedAt: () => 'garbage' }));
  assert.equal(record(root).state, 'escalated');
  assert.equal(health.failures, 0);
  assert.equal(health.releaseFailures, 0);
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
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'resolution', 'checks-settled']);
  // #204: the watcher's own self-resolve line says it raised and resolved the decision (the lead is still woken for it).
  const selfResolved = outbox(root).find((w) => w.wake === 'resolution');
  assert.equal(selfResolved.raisedBy, selfResolved.actor);
  assert.equal(selfResolved.from, 'escalated');
  assert.equal(selfResolved.to, 'ci-wait');
});

test('close, reopen, close again escalates twice - no permanent replay wedge', () => {
  const root = rootDir();
  seed(root);
  watch(root, fetchers());   // establish ci-wait observation
  const closed = fetchers({ open: [], viewResult: view({ state: 'CLOSED' }) });
  watch(root, closed);
  assert.equal(record(root).state, 'escalated');
  // #221: a closed-without-merge escalation is not a linkage escalation, so a reopen with
  // linkage does not resolve it; the lead's resolution does, and the next close escalates again.
  watch(root, fetchers({ open: [pr()], viewResult: view({ body: 'Closes #42' }) }));   // reopened, linked -> still the lead's
  assert.equal(record(root).state, 'escalated');
  resolveAsLead(root, 'ci-wait', 'reopened on purpose; the closure was a mistake');
  assert.equal(record(root).state, 'ci-wait');
  watch(root, closed);
  assert.equal(record(root).state, 'escalated');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'resolution', 'decision-needed']);
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
// #202: an explained Refs is deliberate at the watcher, so the fleet#44 memory is for the
// bodies with neither a closing keyword nor an explained Refs (here a bare Refs line).
const REFS_BODY = 'Refs #42';

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
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'resolution'], 'one page and one resolution wake, not one of each per tick');
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
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'resolution', 'checks-settled']);
  const settledEvent = events(root).filter((e) => e.type === 'state-review').pop();
  assert.match(String(settledEvent.evidence), /ruled deliberate by the lead/);
});

test('fleet#44: an edited body is a new fact and escalates again; a closing keyword resolves it as before', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: REFS_BODY }) }));
  resolveAsLead(root, 'review');
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'See #42 for the rest' }) }));
  assert.equal(record(root).state, 'escalated', 'a different body was never ruled on');
  assert.equal(record(root).prior_state, 'review');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'resolution', 'decision-needed']);
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) }));
  assert.equal(record(root).state, 'review', 'linkage appearing still self-resolves the watcher own escalation');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['decision-needed', 'resolution', 'decision-needed', 'resolution']);
});

test('#202: an explained Refs is deliberate: settled gates go to review with checks-settled and no escalation, and later ticks stay silent', () => {
  const root = rootDir();
  seed(root);
  const f = fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Refs #42 (deliberate; AC1 ruling open)' }) });
  watch(root, f);
  const rec = record(root);
  assert.equal(rec.state, 'review');
  assert.equal(rec.github.observation.closingVerified, false, 'the observation still says the body carries no closing keyword');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['checks-settled']);
  assert.match(String(events(root).filter((e) => e.type === 'state-review').pop().evidence), /explained Refs for #42 on PR #77, deliberate/);
  assert.equal(events(root).filter((e) => e.type === 'state-escalated').length, 0);
  for (let tick = 0; tick < 3; tick += 1) assert.deepEqual(watch(root, f).actions, [], `tick ${tick}: steady state is silent`);
});

test('#202: an explained Refs in review stays put; the next-line explanation counts, and a bare Refs line still escalates', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  const green = [pr({ statusCheckRollup: GREEN })];
  watch(root, fetchers({ open: green, viewResult: view({ body: 'Refs #42\r\nThe migration stays with Cory.' }) }));
  assert.equal(record(root).state, 'review', 'no closing-linkage escalation for an explained Refs');
  watch(root, fetchers({ open: green, viewResult: view({ body: 'Refs #42' }) }));
  assert.equal(record(root).state, 'escalated', 'neither a keyword nor an explanation is still a defect');
  assert.match(String(record(root).decisionEvidence), /no closing linkage|disappeared/);
  watch(root, fetchers({ open: green, viewResult: view({ body: 'Refs #42: the migration stays with Cory' }) }));
  assert.equal(record(root).state, 'review', 'the body edited to an explained Refs resolves the watcher escalation');
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

test('fleet#63: a PR returned to draft at the reviewed head walks the record review -> revision so the IC can record its risk review before the next push', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) }));
  assert.equal(record(root).state, 'review');
  // The lead records its formal review and sends the PR back: gh pr ready --undo, same head.
  // The draft PR drops out of the open list; the view says OPEN + isDraft at the old head.
  const drafted = fetchers({ open: [], viewResult: view({ isDraft: true, statusCheckRollup: GREEN, body: 'Closes #42' }) });
  watch(root, drafted);
  const rec = record(root);
  assert.equal(rec.state, 'revision', 'a drafted PR at the reviewed head is back with the IC, not still under review');
  assert.equal(rec.github.prNumber, 77, 'the PR number survives the return');
  assert.deepEqual(outbox(root), [], 'the return is the lead own act; nobody is woken');
  // Idempotent: the same draft view on the next tick does nothing.
  watch(root, drafted);
  assert.equal(record(root).state, 'revision');
  // The IC pushes and re-readies: the record walks the ordinary revision -> pr-open -> ci-wait -> review path.
  const readied = fetchers({ open: [pr({ headRefOid: 'def456', statusCheckRollup: GREEN })], viewResult: view({ headRefOid: 'def456', statusCheckRollup: GREEN, body: 'Closes #42' }) });
  watch(root, readied);
  assert.equal(record(root).state, 'pr-open');
  watch(root, readied);
  assert.equal(record(root).state, 'ci-wait');
  watch(root, readied);
  assert.equal(record(root).state, 'review');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['checks-settled']);
});

test('fleet#63: a held PR set to draft stays in hold; only review returns to the IC', () => {
  const root = rootDir();
  seed(root, { state: 'hold' });
  watch(root, fetchers({ open: [], viewResult: view({ isDraft: true, statusCheckRollup: GREEN, body: 'Closes #42' }) }));
  assert.equal(record(root).state, 'hold');
  assert.equal(outbox(root).length, 1, 'only the seed hold page; the draft adds no wake');
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

const RED_G1 = [check('g1', 'COMPLETED', 'FAILURE'), check('g2', 'COMPLETED', 'SUCCESS')];
function reviewTick(root, rollup) {
  watch(root, fetchers({ open: [pr({ statusCheckRollup: rollup })], viewResult: view({ body: 'Closes #42' }) }));
}

test('#376: a gate going red at the same head while review wakes checks-failed once; the next identical tick adds nothing', () => {
  const root = rootDir();
  seed(root);
  reviewTick(root, GREEN);
  assert.equal(record(root).state, 'review');
  reviewTick(root, [check('g1', 'IN_PROGRESS', ''), check('g2', 'COMPLETED', 'SUCCESS')]);
  assert.deepEqual(outbox(root).map((w) => w.wake), ['checks-settled']);
  reviewTick(root, RED_G1);
  assert.equal(record(root).state, 'review');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['checks-settled', 'checks-failed']);
  const observed = events(root).filter((e) => e.type === 'pr-observed').pop();
  assert.equal(observed.changes.wake, 'checks-failed');
  assert.equal(observed.evidence, 'gate failure on PR #77 while review: g1=FAILURE');
  const before = events(root).length;
  reviewTick(root, RED_G1);
  assert.equal(outbox(root).length, 2);
  assert.equal(events(root).length, before);
});

test('#376: a gate that goes red between two ticks while review wakes checks-failed with no pending tick first', () => {
  const root = rootDir();
  seed(root);
  reviewTick(root, GREEN);
  reviewTick(root, RED_G1);
  assert.equal(record(root).state, 'review');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['checks-settled', 'checks-failed']);
});

test('#376: a change with no failed gate while review writes an observation and no wake', () => {
  const root = rootDir();
  seed(root);
  reviewTick(root, GREEN);
  const before = events(root).length;
  reviewTick(root, [...GREEN, { __typename: 'StatusContext', context: 'fleet-review', state: 'SUCCESS', startedAt: '2026-11-05T18:11:52Z' }]);
  assert.equal(events(root).length, before + 1);
  assert.equal(events(root).filter((e) => e.type === 'pr-observed').pop().evidence, 'PR #77 changed while review');
  assert.deepEqual(outbox(root).map((w) => w.wake), ['checks-settled']);
});

test('#376: a gate going red at the same head while hold is observed with no wake; the PR is parked for the merge', () => {
  const root = rootDir();
  seed(root, { state: 'hold' });
  const lines = outbox(root).length;
  reviewTick(root, RED_G1);
  assert.equal(record(root).state, 'hold');
  assert.equal(events(root).filter((e) => e.type === 'pr-observed').pop().evidence, 'PR #77 changed while hold');
  assert.equal(outbox(root).length, lines);
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

test('#118: a third return to draft escalates for a Ruling instead of failing every tick on SEND_BACK_LIMIT', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  let head = 'abc123';
  watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) }));
  for (const next of ['def456', 'fed789']) {
    watch(root, fetchers({ open: [], viewResult: view({ isDraft: true, headRefOid: head, statusCheckRollup: GREEN, body: 'Closes #42' }) }));
    assert.equal(record(root).state, 'revision');
    head = next;
    const readied = fetchers({ open: [pr({ headRefOid: head, statusCheckRollup: GREEN })], viewResult: view({ headRefOid: head, statusCheckRollup: GREEN, body: 'Closes #42' }) });
    for (let tick = 0; tick < 3; tick += 1) watch(root, readied);
    assert.equal(record(root).state, 'review');
  }
  const third = fetchers({ open: [], viewResult: view({ isDraft: true, headRefOid: head, statusCheckRollup: GREEN, body: 'Closes #42' }) });
  const health = watch(root, third);
  const rec = record(root);
  assert.equal(rec.state, 'escalated', `the third send-back is a decision, not another round: ${JSON.stringify(health && health.actions)}`);
  assert.equal(rec.prior_state, 'review');
  assert.match(rec.decisionEvidence, /third send-back/);
  assert.equal(outbox(root).filter((w) => w.wake === 'decision-needed').length, 1, 'one decision-needed wake');
  watch(root, third);
  assert.equal(record(root).state, 'escalated', 'the next tick does nothing more');
});

// #221: the escalated-state self-resolve was keyed on the bare watcher mark plus live
// linkage, so it also resolved escalations that are not about linkage. A third
// send-back is a Ruling for the lead: an IC re-readying the PR with linkage present
// must not clear it. Only the watcher's closing-linkage escalation (its tag) does.
test('#221: a third-send-back escalation is not resolved when the PR is re-readied with linkage', () => {
  for (const body of ['Closes #42', 'Refs #42\n\nDeliberate: the lead closes the issue at the merge.']) {
    const root = rootDir();
    seed(root, { state: 'review' });
    let head = 'abc123';
    watch(root, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Closes #42' }) }));
    for (const next of ['def456', 'fed789']) {
      watch(root, fetchers({ open: [], viewResult: view({ isDraft: true, headRefOid: head, statusCheckRollup: GREEN, body: 'Closes #42' }) }));
      head = next;
      const readied = fetchers({ open: [pr({ headRefOid: head, statusCheckRollup: GREEN })], viewResult: view({ headRefOid: head, statusCheckRollup: GREEN, body: 'Closes #42' }) });
      for (let tick = 0; tick < 3; tick += 1) watch(root, readied);
    }
    watch(root, fetchers({ open: [], viewResult: view({ isDraft: true, headRefOid: head, statusCheckRollup: GREEN, body: 'Closes #42' }) }));
    assert.equal(record(root).state, 'escalated');
    assert.match(record(root).decisionEvidence, /third send-back/);
    const wakesBefore = outbox(root).length;
    const eventsBefore = events(root).length;
    const reReadied = fetchers({ open: [pr({ headRefOid: 'aaa111', statusCheckRollup: GREEN })], viewResult: view({ headRefOid: 'aaa111', statusCheckRollup: GREEN, body }) });
    for (let tick = 0; tick < 3; tick += 1) watch(root, reReadied);
    assert.equal(record(root).state, 'escalated', `a Ruling escalation stays for the lead (body ${JSON.stringify(body.slice(0, 12))})`);
    assert.equal(events(root).length, eventsBefore, 'the watcher appends nothing for it');
    assert.equal(outbox(root).length, wakesBefore);
  }
});

// run-pr-watch.ps1 (the scheduled tick, the only production caller) passes no
// --tenant. The moment a second tenant file landed (nidus, 2026-09-24 20:10Z)
// every tick died on `--tenant required (2 tenants configured)`, so no PR was
// discovered and no checks-settled wake reached a project lead.
function twoTenantRoot() {
  const root = rootDir();
  seed(root, { id: 'endzone:issue-63', issue: 63, state: 'ci-wait', prNumber: 163 });
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'owner/endzone', branchPrefix: 'fleet/', ciGates: [] }));
  fs.writeFileSync(path.join(root, 'tenants', 'nidus.json'), JSON.stringify({ name: 'nidus', github: 'owner/nidus', branchPrefix: 'fleet/', ciGates: [] }));
  return root;
}

test('with no --tenant the watcher ticks every configured tenant', () => {
  const root = twoTenantRoot();
  const result = cli(['--root', root, '--gh', 'no-such-gh-binary', '--no-notifier', 'true']);
  assert.deepEqual(Object.keys(result.tenants).sort(), ['endzone', 'nidus']);
  assert.equal(result.tenants.endzone.records, 1, 'endzone\'s record was watched');
  assert.equal(result.tenants.nidus.records, 0);
  const health = JSON.parse(fs.readFileSync(path.join(root, 'state', 'watch', 'health.json'), 'utf8'));
  assert.deepEqual(Object.keys(health.tenants).sort(), ['endzone', 'nidus'], 'health.json reports every tenant, not the last one ticked');
  assert.equal(health.ok, result.ok);
});

test('one tenant\'s failure does not blind the watcher to the others', () => {
  const root = twoTenantRoot();
  fs.writeFileSync(path.join(root, 'tenants', 'aaa-broken.json'), '{ not json');
  const result = cli(['--root', root, '--gh', 'no-such-gh-binary', '--no-notifier', 'true']);
  assert.equal(result.ok, false);
  assert.match(result.tenants['aaa-broken'].error, /JSON/);
  assert.equal(result.tenants.endzone.records, 1, 'endzone is still watched after the broken tenant');
});

// fleet #136: the watchdog samples health.json every 15 min but the watcher ticks every 5,
// so the watcher itself counts its consecutive failed ticks, overall and per tenant, and a
// healthy tick resets the count. A single-tenant (--tenant) run carries the same count.
test('health.json counts consecutive failed ticks, per tenant too, and a healthy tick resets it', () => {
  const root = twoTenantRoot();
  fs.rmSync(path.join(root, 'tenants', 'endzone.json'));   // its record needs gh; a tenant with no records ticks healthy offline
  fs.writeFileSync(path.join(root, 'tenants', 'zeta.json'), JSON.stringify({ name: 'zeta', github: 'owner/zeta', branchPrefix: 'fleet/', ciGates: [] }));
  const tick = () => { cli(['--root', root, '--gh', 'no-such-gh-binary', '--no-notifier', 'true']); return JSON.parse(fs.readFileSync(path.join(root, 'state', 'watch', 'health.json'), 'utf8')); };
  const healthy = tick();
  assert.equal(healthy.consecutiveFailures, 0, 'a healthy tick reports no streak');
  fs.writeFileSync(path.join(root, 'tenants', 'aaa-broken.json'), '{ not json');
  assert.equal(tick().consecutiveFailures, 1);
  assert.equal(tick().consecutiveFailures, 2);
  const third = tick();
  assert.equal(third.consecutiveFailures, 3, 'three failed ticks in a row read 3');
  assert.equal(third.tenants['aaa-broken'].consecutiveFailures, 3, 'the failing tenant carries its own streak');
  assert.equal(third.tenants.zeta.consecutiveFailures, 0, 'a healthy tenant carries none');
  fs.rmSync(path.join(root, 'tenants', 'aaa-broken.json'));
  assert.equal(tick().consecutiveFailures, 0, 'a healthy tick resets the streak');
});

test('a single-tenant run continues the tenant streak from the aggregate health.json', () => {
  const root = rootDir();
  seed(root);
  fs.mkdirSync(path.join(root, 'state', 'watch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'watch', 'health.json'), JSON.stringify({ ok: false, consecutiveFailures: 2, tenants: { endzone: { ok: false, consecutiveFailures: 2 } } }));
  const failed = watch(root, fetchers({ failList: true }));
  assert.equal(failed.consecutiveFailures, 3, 'the endzone streak carries across the shape change');
  assert.equal(watch(root, fetchers()).consecutiveFailures, 0);
});

// Spec fleet #93 / #155: the merge names who merged. GitHub's mergedBy rides the
// reconciled observation onto the Work record (github.mergedBy) and the
// state-merged event (changes.mergedBy), for a fleet merge and an owner merge alike.
for (const [who, login] of [['a fleet merge', 'fleet-bot'], ['an owner merge', 'cory-owner']]) {
  test(`#155: ${who} records mergedBy on the Work record and on its merge event`, () => {
    const root = rootDir();
    seed(root, { id: 'endzone:issue-70', issue: 70, state: 'review', prNumber: 170 });
    watch(root, fetchers({ open: [], viewResult: view({ number: 170, state: 'MERGED', mergedAt: '2026-09-25T10:00:00Z', mergedBy: { login } }) }));
    const rec = record(root, 'endzone:issue-70');
    assert.equal(rec.state, 'merged');
    assert.equal(rec.github.mergedBy, login);
    const merge = events(root).filter((event) => event.type === 'state-merged').pop();
    assert.equal(merge.changes.mergedBy, login);
    assert.match(merge.evidence, new RegExp(`by ${login}; merged without a recorded formal review`), 'the unreviewed-merge evidence names the merger');
  });
}

test('#155: a view with no mergedBy records null rather than guessing a login', () => {
  const root = rootDir();
  seed(root, { id: 'endzone:issue-71', issue: 71, state: 'review', prNumber: 171 });
  watch(root, fetchers({ open: [], viewResult: view({ number: 171, state: 'MERGED', mergedAt: '2026-09-25T10:00:00Z' }) }));
  const merge = events(root).filter((event) => event.type === 'state-merged').pop();
  assert.equal(merge.changes.mergedBy, null);
  assert.equal(record(root, 'endzone:issue-71').github.mergedBy, undefined);
});

test('#155: the gh adapter asks GitHub for mergedBy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bin', 'pr-watch.js'), 'utf8');
  assert.match(source, /'--json', 'number,state,isDraft,mergedAt,mergedBy,/);
});

// #203 (spec #192): a merged explained Refs excludes its issue until the issue closes.
// The planner reads the exclusion ledger through selectFrontier, so these assert the
// ledger rows a tick writes and what the frontier then does with the issue.
const REFS_EXPLAINED = 'Refs #42: the migration stays with Cory';
const MERGED_REFS = () => view({ state: 'MERGED', mergedAt: '2026-09-29T10:00:00Z', mergedBy: { login: 'cory' }, body: REFS_EXPLAINED });
const ISSUE_42 = { number: 42, state: 'OPEN', labels: ['ready-for-agent'], createdAt: '2026-08-01T00:00:00.000Z' };
function frontier(root) {
  return selectFrontier({ issues: [ISSUE_42], readyLabel: 'ready-for-agent', exclusions: exclusions.activeExclusions({ root, tenant: 'endzone' }), tenant: 'endzone' });
}
function exclusionRows(root) { return exclusions.readExclusions(root, 'endzone'); }

test('#203: observing a merged explained Refs records one fleet-owned exclusion naming the PR, released by the issue closing', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [], viewResult: MERGED_REFS() }));
  assert.equal(record(root).state, 'merged');
  const rows = exclusionRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'exclusion-added');
  assert.equal(rows[0].tenant, 'endzone');
  assert.equal(rows[0].issue, 42);
  assert.equal(rows[0].owner, 'fleet');
  assert.equal(rows[0].actor, 'pr-watch');
  assert.match(rows[0].reason, /PR #77 merged/);
  assert.match(rows[0].evidence, /gh pr view 77/);
  assert.deepEqual(rows[0].recheck, { event: { type: 'issue-closed', issue: 42 } });
});

test('#203: the planner refuses the issue while the exclusion stands, and the issue closing releases it so a reopened issue is back on the frontier', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [], viewResult: MERGED_REFS() }));
  const refused = frontier(root);
  assert.deepEqual(refused.eligible, []);
  assert.deepEqual(refused.excluded[0].reasons.map((r) => r.code), ['frontier-exclusion']);
  assert.match(refused.excluded[0].reasons[0].detail, /PR #77 merged/);

  // The issue is still open: later ticks leave the exclusion standing (and record nothing).
  const stillOpen = watch(root, fetchers({ open: [], viewResult: MERGED_REFS(), issueState: 'OPEN' }));
  assert.equal(stillOpen.ok, true);
  assert.equal(exclusionRows(root).length, 1);
  assert.equal(frontier(root).eligible.length, 0);

  // The lead closes the issue by hand: the next tick lifts the exclusion.
  const closed = watch(root, fetchers({ open: [], viewResult: MERGED_REFS(), issueState: 'CLOSED' }));
  assert.ok(closed.actions.some((a) => /lifted/.test(a) && /endzone:excl-42/.test(a)), 'the tick reports the release');
  const rows = exclusionRows(root);
  assert.deepEqual(rows.map((r) => r.kind), ['exclusion-added', 'exclusion-lifted']);
  assert.equal(rows[1].actor, 'pr-watch');
  assert.match(rows[1].evidence, /issue #42 is CLOSED/);
  assert.equal(exclusions.projectTenant({ root, tenant: 'endzone' }).discharged[0].dischargedBy, 'lifted');
  // Reopened: GitHub lists it as open again, and nothing stands in its way.
  assert.deepEqual(frontier(root).eligible.map((i) => i.number), [42]);
  // A reopen after the release is not excluded again by later ticks.
  watch(root, fetchers({ open: [], viewResult: MERGED_REFS(), issueState: 'OPEN' }));
  assert.equal(exclusionRows(root).length, 2);
  assert.deepEqual(frontier(root).eligible.map((i) => i.number), [42]);
});

test('#203: a replay of the merge (the exclusion already written by a partial earlier tick, or already released) records no second exclusion', () => {
  for (const lifted of [false, true]) {
    const root = rootDir();
    seed(root, { state: 'review' });
    // A prior tick wrote the exclusion, then died before the merged transition committed.
    exclusions.addExclusion({
      root, tenant: 'endzone', issue: 42, owner: 'fleet', actor: 'pr-watch', id: 'endzone:excl-42-pr-77',
      reason: 'PR #77 merged with an explained Refs for #42', evidence: 'gh pr view 77',
      recheck: { event: { type: 'issue-closed', issue: 42 } },
    });
    if (lifted) exclusions.liftExclusion({ root, tenant: 'endzone', id: 'endzone:excl-42-pr-77', actor: 'pr-watch', evidence: 'issue #42 is CLOSED' });
    assert.equal(record(root).state, 'review', 'the record is still watched');
    const health = watch(root, fetchers({ open: [], viewResult: MERGED_REFS(), issueState: 'OPEN' }));
    assert.equal(health.ok, true);
    assert.equal(record(root).state, 'merged');
    assert.equal(exclusionRows(root).filter((r) => r.kind === 'exclusion-added').length, 1, `lifted=${lifted}: exactly one exclusion-added row`);
    assert.doesNotMatch(health.actions.join(' '), /not recorded/, 'a replay of the fleet own id is silent');
  }
});

test('#203: a replayed observation records no second exclusion', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  const f = fetchers({ open: [], viewResult: MERGED_REFS() });
  watch(root, f);
  const eventCount = events(root).length;
  for (let tick = 0; tick < 3; tick += 1) assert.deepEqual(watch(root, f).actions, [], `tick ${tick}: nothing new`);
  assert.equal(exclusionRows(root).length, 1);
  assert.equal(events(root).length, eventCount);
  // Even after the release, the merge is not observed again: still one exclusion ever added.
  watch(root, fetchers({ open: [], viewResult: MERGED_REFS(), issueState: 'CLOSED' }));
  watch(root, f);
  assert.equal(exclusionRows(root).filter((r) => r.kind === 'exclusion-added').length, 1);
});

test('#203: a different exclusion already standing says so in the health actions: the fleet records none and does not retry', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  exclusions.addExclusion({ root, tenant: 'endzone', issue: 42, reason: 'lead holds it by hand', evidence: 'e', owner: 'pl-endzone', actor: 'pl-endzone', recheck: { expiresAt: '2099-01-01T00:00:00.000Z' } });
  const health = watch(root, fetchers({ open: [], viewResult: MERGED_REFS() }));
  assert.ok(health.actions.includes('endzone:issue-42: fleet exclusion for PR #77 not recorded; endzone:excl-42-1 already stands and the fleet does not retry (if it lapses before #42 closes, exclude by hand)'), health.actions.join(' | '));
  assert.equal(exclusionRows(root).length, 1);
});

test('#203: a hand exclusion already standing for the issue is not doubled, and the merge still completes', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  exclusions.addExclusion({ root, tenant: 'endzone', issue: 42, reason: 'lead holds it by hand', evidence: 'e', owner: 'pl-endzone', actor: 'pl-endzone', recheck: { expiresAt: '2099-01-01T00:00:00.000Z' } });
  const health = watch(root, fetchers({ open: [], viewResult: MERGED_REFS() }));
  assert.equal(health.ok, true);
  assert.equal(record(root).state, 'merged');
  assert.equal(exclusionRows(root).length, 1);
});

test('#203: a merge whose linkage is a closing keyword, a bare Refs, or nothing records no exclusion', () => {
  for (const body of ['Closes #42', 'Refs #42', 'Just a body.']) {
    const root = rootDir();
    seed(root, { state: 'review' });
    watch(root, fetchers({ open: [], viewResult: view({ state: 'MERGED', mergedAt: '2026-09-29T10:00:00Z', body }) }));
    assert.equal(record(root).state, 'merged');
    assert.deepEqual(exclusionRows(root), [], `body ${JSON.stringify(body)}`);
  }
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [], viewResult: view({ state: 'MERGED', mergedAt: '2026-09-29T10:00:00Z', closingIssuesReferences: [{ number: 42 }], body: REFS_EXPLAINED }) }));
  assert.deepEqual(exclusionRows(root), [], 'a native closing reference closes the issue at the merge');
});

test('#203: a merge observed from an early state or from the watcher own escalation also records the exclusion; a dry run records nothing', () => {
  const early = rootDir();
  seed(early, { state: 'ci-wait' });
  watch(early, fetchers({ open: [], viewResult: MERGED_REFS() }));
  assert.equal(record(early).state, 'merged');
  assert.equal(exclusionRows(early).length, 1);

  const escalated = rootDir();
  seed(escalated, { state: 'review' });
  watch(escalated, fetchers({ open: [pr({ statusCheckRollup: GREEN })], viewResult: view({ body: 'Refs #42' }) }));
  assert.equal(record(escalated).state, 'escalated');
  watch(escalated, fetchers({ open: [], viewResult: MERGED_REFS() }));
  assert.equal(record(escalated).state, 'merged');
  assert.equal(exclusionRows(escalated).length, 1);

  const dry = rootDir();
  seed(dry, { state: 'review' });
  watch(dry, fetchers({ open: [], viewResult: MERGED_REFS() }), { dryRun: true });
  assert.equal(record(dry).state, 'review');
  assert.deepEqual(exclusionRows(dry), []);
});

test('#203: the release runs with no watched record, retains the exclusion when the issue view fails, and leaves other tenants and other exclusions alone', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [], viewResult: MERGED_REFS() }));
  exclusions.addExclusion({ root, tenant: 'endzone', issue: 50, reason: 'hand hold', evidence: 'e', owner: 'cory', actor: 'cory', recheck: { expiresAt: '2099-01-01T00:00:00.000Z' } });
  exclusions.addExclusion({ root, tenant: 'other', issue: 42, reason: 'other tenant', evidence: 'e', owner: 'fleet', actor: 'pr-watch', recheck: { event: { type: 'issue-closed', issue: 42 } } });
  // Nothing is watched now (the record merged); the tick still reaches the release step.
  const failing = watch(root, fetchers({ open: [], viewResult: MERGED_REFS(), failIssue: true }));
  assert.equal(failing.ok, true, 'a transient release read is not a record-action failure');
  assert.equal(failing.failures, 0);
  assert.equal(failing.releaseFailures, 1);
  assert.match(failing.actions.join(' '), /issue view failed, retained/);
  assert.equal(exclusions.activeExclusions({ root, tenant: 'endzone' }).length, 2, 'an unreadable issue is never read as closed');
  watch(root, fetchers({ open: [], viewResult: MERGED_REFS(), issueState: 'CLOSED' }));
  assert.deepEqual(exclusions.activeExclusions({ root, tenant: 'endzone' }).map((e) => e.issue), [50], 'only the issue-closed exclusion of this tenant was released');
  assert.equal(exclusions.activeExclusions({ root, tenant: 'other' }).length, 1);
});

test('#203: an issue that no longer resolves (deleted or transferred) releases its exclusion with that as the evidence, and counts no failure', () => {
  const root = rootDir();
  seed(root, { state: 'review' });
  watch(root, fetchers({ open: [], viewResult: MERGED_REFS() }));
  const gone = fetchers({ open: [], viewResult: MERGED_REFS() });
  gone.issueState = () => { throw new Error('GraphQL: Could not resolve to an issue or pull request with the number of 42. (repository.issue)'); };
  const health = watch(root, gone);
  assert.equal(health.ok, true);
  assert.equal(health.failures, 0);
  assert.equal(health.releaseFailures, 0);
  assert.match(health.actions.join(' '), /endzone:excl-42-pr-77: lifted, issue #42 no longer resolves/);
  const lift = exclusionRows(root).pop();
  assert.equal(lift.kind, 'exclusion-lifted');
  assert.match(lift.evidence, /^issue #42 no longer resolves \(gh issue view: .*Could not resolve to an issue/);
  assert.ok(lift.evidence.length < 250);
  assert.equal(exclusions.activeExclusions({ root, tenant: 'endzone' }).length, 0);
});

// fleet #406: an issue-closed hold names the issue it waits on (recheck.event.issue), which may not be the held one.
const HELD_10 = { number: 10, state: 'OPEN', labels: ['ready-for-agent'], createdAt: '2026-08-01T00:00:10.000Z', body: 'Change `src/10.js`.' };
function holdOn20(root) {
  exclusions.addExclusion({ root, tenant: 'endzone', issue: 10, reason: 'waits on #20 closing', evidence: 'e', owner: 'cory', actor: 'cory', recheck: { event: { type: 'issue-closed', issue: 20 } } });
}

test('#406: an issue-closed hold on issue 10 that names issue 20 is released when 20 closes, and the planner then offers 10 again', () => {
  const root = rootDir();
  holdOn20(root);
  const asked = [];
  const f = { ...fetchers({ open: [] }), issueState: (n) => { asked.push(n); return n === 20 ? 'CLOSED' : 'OPEN'; } };
  const health = watch(root, f);
  assert.deepEqual(asked, [20], 'the watched issue is the one read, never the held one');
  assert.match(health.actions.join(' '), /endzone:excl-10-1: lifted, issue #20 closed/);
  assert.deepEqual(exclusions.activeExclusions({ root, tenant: 'endzone' }), []);
  assert.deepEqual(selectFrontier({ issues: [HELD_10], readyLabel: 'ready-for-agent', exclusions: exclusions.activeExclusions({ root, tenant: 'endzone' }), tenant: 'endzone' }).eligible.map((i) => i.number), [10]);
});

test('#406: the same hold stays while issue 20 is open, and issue 10 is not read as closed', () => {
  const root = rootDir();
  holdOn20(root);
  const asked = [];
  const f = { ...fetchers({ open: [] }), issueState: (n) => { asked.push(n); return n === 20 ? 'OPEN' : 'CLOSED'; } };
  watch(root, f);
  assert.deepEqual(asked, [20]);
  assert.deepEqual(exclusions.activeExclusions({ root, tenant: 'endzone' }).map((e) => e.issue), [10]);
  assert.deepEqual(selectFrontier({ issues: [HELD_10], readyLabel: 'ready-for-agent', exclusions: exclusions.activeExclusions({ root, tenant: 'endzone' }), tenant: 'endzone' }).excluded[0].reasons.map((r) => r.code), ['frontier-exclusion']);
});

// --- fleet #390: the watcher merges a Reconcile PR (the tenant's main into its integration branch) as a
// merge commit when GitHub reports no conflicts and every ciGates check is green. Its Review gate passes
// through the standing exception in config/review-exceptions.json. Every GitHub call goes through a stubbed
// runner (`fetchers.gh`) that records each gh argv and answers the calls the pass makes.

const RECONCILE_HEAD = 'e'.repeat(40);
const RECONCILE_TENANT = { ...TENANT, name: 'endzone', github: 'owner/repo', defaultBranch: 'integration', releaseBranch: 'main', reviewStatus: 'fleet-review', ownerLogin: 'andydarknessb', fleetIdentity: 'andydarknessb-fleet' };
function reconcilePr(overrides = {}) {
  return {
    number: 2680, title: 'Reconcile main into integration', isDraft: false, headRefName: 'main', baseRefName: 'integration',
    headRefOid: RECONCILE_HEAD, isCrossRepository: false, mergeable: 'MERGEABLE',
    statusCheckRollup: [check('g1', 'COMPLETED', 'SUCCESS'), check('g2', 'COMPLETED', 'SUCCESS')],
    ...overrides,
  };
}
function reconcileRoot({ standing = true } = {}) {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const config = { schemaVersion: 1, exceptions: [], standing: standing ? [{ kind: 'reconcile', ruling: 'Cory 2026-11-06 (fleet #382 ruling 1)' }] : [] };
  fs.writeFileSync(path.join(root, 'config', 'review-exceptions.json'), JSON.stringify(config));
  return root;
}
function ghStub({ prs = [reconcilePr()], failList = false, failStatus = false, failMerge = false, actingLogin = 'andydarknessb-fleet' } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') { if (failList) throw new Error('gh: connection reset by peer'); return JSON.stringify(prs); }
    if (args[0] === 'api' && args[1] === 'user') return actingLogin;
    if (args[0] === 'api') {
      if (failStatus) throw Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: HTTP 502 Bad Gateway' });
      return JSON.stringify({ state: 'success', creator: { login: actingLogin } });
    }
    if (args[0] === 'pr' && args[1] === 'merge') { if (failMerge) throw new Error('Command failed: gh pr merge\nPull request is not mergeable'); return ''; }
    return '{}';
  };
  return { calls, gh };
}
function reconcileWatch(root, gh, opts = {}) {
  return runWatch({ root, tenantName: 'endzone', tenantConfig: RECONCILE_TENANT, fetchers: { ...fetchers(), fleetGh: gh }, shadow: false, ...opts });
}
const mergesOf = (calls) => calls.filter((args) => args[0] === 'pr' && args[1] === 'merge');
const statusPostsOf = (calls) => calls.filter((args) => args[0] === 'api' && args.includes('--method'));

test('#390: a conflict-free Reconcile PR with every gate green gets the standing status on its head, then merges as a merge commit', () => {
  const root = reconcileRoot();
  const { calls, gh } = ghStub();
  const health = reconcileWatch(root, gh);
  assert.deepEqual(calls[0].slice(0, 4), ['pr', 'list', '-R', 'owner/repo']);
  assert.deepEqual(calls[0].slice(4, 10), ['--base', 'integration', '--head', 'main', '--state', 'open']);
  const posts = statusPostsOf(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0][3], `repos/owner/repo/statuses/${RECONCILE_HEAD}`, 'the status lands on the PR head');
  assert.ok(posts[0].includes('state=success') && posts[0].includes('context=fleet-review'));
  assert.deepEqual(mergesOf(calls), [['pr', 'merge', '2680', '-R', 'owner/repo', '--merge', '--match-head-commit', RECONCILE_HEAD]]);
  assert.ok(calls.indexOf(posts[0]) < calls.indexOf(mergesOf(calls)[0]), 'the gate passes before the merge');
  assert.equal(calls.some((args) => args.includes('--delete-branch')), false, 'the head branch is main: it is never deleted');
  assert.equal(health.ok, true);
  assert.equal(health.failures, 0);
  assert.match(health.actions.join(' '), /endzone:reconcile-pr-2680: merged main into integration as a merge commit/);
});

test('#390: every run of a gate must be green: a red run on the head blocks the merge in either order, even when a rerun of that gate passed', () => {
  const root = reconcileRoot();
  for (const runs of [
    [check('g1', 'COMPLETED', 'FAILURE'), check('g1', 'COMPLETED', 'SUCCESS'), check('g2', 'COMPLETED', 'SUCCESS')],
    [check('g1', 'COMPLETED', 'SUCCESS'), check('g1', 'COMPLETED', 'FAILURE'), check('g2', 'COMPLETED', 'SUCCESS')],
  ]) {
    const { calls, gh } = ghStub({ prs: [reconcilePr({ statusCheckRollup: runs })] });
    const health = reconcileWatch(root, gh);
    assert.deepEqual(mergesOf(calls), [], 'a red run of a gate is not excused by a green one');
    assert.equal(health.ok, true);
  }
  const green = ghStub({ prs: [reconcilePr({ statusCheckRollup: [check('g1', 'COMPLETED', 'SUCCESS'), check('g1', 'COMPLETED', 'SUCCESS'), check('g2', 'COMPLETED', 'SUCCESS')] })] });
  reconcileWatch(root, green.gh);
  assert.equal(mergesOf(green.calls).length, 1, 'every run green: the merge goes ahead');
});

test('#390: a Reconcile PR with conflicts, or whose mergeability is not known yet, is not merged and not gated', () => {
  for (const mergeable of ['CONFLICTING', 'UNKNOWN']) {
    const root = reconcileRoot();
    const { calls, gh } = ghStub({ prs: [reconcilePr({ mergeable })] });
    const health = reconcileWatch(root, gh);
    assert.deepEqual(mergesOf(calls), [], `${mergeable}: no merge`);
    assert.deepEqual(statusPostsOf(calls), [], `${mergeable}: no status posted`);
    assert.equal(health.ok, true, `${mergeable}: a conflict is the escalation path, not a failed tick`);
  }
});

test('#390: a Reconcile PR whose required checks are pending, red or missing is not merged yet', () => {
  const rollups = {
    pending: [check('g1', 'COMPLETED', 'SUCCESS'), check('g2', 'IN_PROGRESS', '')],
    red: [check('g1', 'COMPLETED', 'FAILURE'), check('g2', 'COMPLETED', 'SUCCESS')],
    missing: [check('g1', 'COMPLETED', 'SUCCESS')],
  };
  for (const [name, statusCheckRollup] of Object.entries(rollups)) {
    const root = reconcileRoot();
    const { calls, gh } = ghStub({ prs: [reconcilePr({ statusCheckRollup })] });
    const health = reconcileWatch(root, gh);
    assert.deepEqual(mergesOf(calls), [], `${name}: no merge`);
    assert.deepEqual(statusPostsOf(calls), [], `${name}: no status posted`);
    assert.equal(health.ok, true, `${name}: waiting is not a failed tick`);
  }
});

test('#390: a PR titled Reconcile main into integration is not a Reconcile PR unless its head and base are main and integration from this repo', () => {
  const lookalikes = [
    reconcilePr({ headRefName: 'fleet/12-thing' }),
    reconcilePr({ headRefName: 'integration', baseRefName: 'main' }),
    reconcilePr({ baseRefName: 'master' }),
    reconcilePr({ isCrossRepository: true }),
    reconcilePr({ isDraft: true }),
  ];
  const root = reconcileRoot();
  const { calls, gh } = ghStub({ prs: lookalikes });
  const health = reconcileWatch(root, gh);
  assert.deepEqual(mergesOf(calls), []);
  assert.deepEqual(statusPostsOf(calls), []);
  assert.equal(health.ok, true);
});

test('#390: without a standing reconcile exception in config, a clean Reconcile PR is left to the escalation', () => {
  const root = reconcileRoot({ standing: false });
  const { calls, gh } = ghStub();
  const health = reconcileWatch(root, gh);
  assert.deepEqual(mergesOf(calls), []);
  assert.deepEqual(statusPostsOf(calls), []);
  assert.equal(health.ok, true);
});

test('#390: a status post GitHub refuses stops the merge and fails the tick; the next tick retries', () => {
  const root = reconcileRoot();
  const refused = ghStub({ failStatus: true });
  const failed = reconcileWatch(root, refused.gh);
  assert.deepEqual(mergesOf(refused.calls), []);
  assert.equal(failed.ok, false);
  assert.equal(failed.failures, 1);
  assert.match(failed.actions.join(' '), /endzone:reconcile-pr-2680: not merged/);
  const retry = ghStub();
  assert.equal(reconcileWatch(root, retry.gh).ok, true);
  assert.equal(mergesOf(retry.calls).length, 1);
});

test('#390: a merge GitHub refuses is a failed watcher action, and the next clean tick merges it', () => {
  const root = reconcileRoot();
  const refused = ghStub({ failMerge: true });
  const failed = reconcileWatch(root, refused.gh);
  assert.equal(failed.ok, false);
  assert.equal(failed.failures, 1);
  assert.match(failed.actions.join(' '), /endzone:reconcile-pr-2680: not merged/);
  const retry = ghStub();
  const healthy = reconcileWatch(root, retry.gh);
  assert.equal(healthy.ok, true);
  assert.equal(mergesOf(retry.calls).length, 1);
});

test('#390: a watcher whose gh acts as the tenant owner merges nothing and says why, the failure standing until the fleet identity is in use (ADR 0015)', () => {
  const root = reconcileRoot();
  const { calls, gh } = ghStub({ actingLogin: 'andydarknessb' });
  const health = reconcileWatch(root, gh);
  assert.deepEqual(statusPostsOf(calls), []);
  assert.deepEqual(mergesOf(calls), []);
  assert.equal(health.ok, false);
  assert.match(health.actions.join(' '), /endzone:reconcile-pr-2680: not merged \(.*tenant owner/);
});

test('#390: a dry run names the merge it would make and makes no write', () => {
  const root = reconcileRoot();
  const { calls, gh } = ghStub();
  const health = reconcileWatch(root, gh, { dryRun: true });
  assert.deepEqual(statusPostsOf(calls), []);
  assert.deepEqual(mergesOf(calls), []);
  assert.match(health.actions.join(' '), /DRY endzone:reconcile-pr-2680: merge main into integration/);
});

test('#390: an unreadable PR list fails the tick and merges nothing', () => {
  const root = reconcileRoot();
  const { calls, gh } = ghStub({ failList: true });
  const health = reconcileWatch(root, gh);
  assert.equal(health.ok, false);
  assert.match(health.actions.join(' '), /reconcile PR list failed/);
  assert.deepEqual(statusPostsOf(calls), []);
  assert.deepEqual(mergesOf(calls), []);
});

test('#390: a tenant whose main is its integration branch (nidus) never lists a Reconcile PR, and a tenant with no required gates never merges one', () => {
  const root = reconcileRoot();
  const one = ghStub();
  const health = runWatch({ root, tenantName: 'nidus', tenantConfig: { ...RECONCILE_TENANT, defaultBranch: 'master', releaseBranch: 'master' }, fetchers: { ...fetchers(), fleetGh: one.gh }, shadow: false });
  assert.deepEqual(one.calls, []);
  assert.equal(health.ok, true);
  const ungated = ghStub();
  runWatch({ root, tenantName: 'endzone', tenantConfig: { ...RECONCILE_TENANT, ciGates: [] }, fetchers: { ...fetchers(), fleetGh: ungated.gh }, shadow: false });
  assert.deepEqual(mergesOf(ungated.calls), [], 'with nothing required there is nothing that proves the merge safe');
});

test('#390: the Reconcile calls run under the fleet identity config dir, never an inherited token (ADR 0015)', () => {
  const dir = makeTempDir('fleet-identity-');
  const saved = { dir: process.env.FLEET_IDENTITY_DIR, token: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN };
  process.env.FLEET_IDENTITY_DIR = dir;
  process.env.GH_TOKEN = 'inherited-owner-token';
  process.env.GITHUB_TOKEN = 'inherited-owner-token';
  try {
    const seen = fleetGhRunner(process.execPath)(['-e', 'process.stdout.write([process.env.GH_CONFIG_DIR, process.env.GH_TOKEN || "", process.env.GITHUB_TOKEN || "", process.env.GH_PROMPT_DISABLED].join("|"))']);
    assert.equal(seen, `${dir}|||1`);
  } finally {
    for (const [key, value] of [['FLEET_IDENTITY_DIR', saved.dir], ['GH_TOKEN', saved.token], ['GITHUB_TOKEN', saved.github]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
