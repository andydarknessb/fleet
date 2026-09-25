'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { execFileSync, spawnSync } = require('node:child_process');
const { buildPointerMessage, validatePointerMessage, findPendingDecisions, findPendingMergedWithoutReview, runNotifier, isLive, spawnNotifier, cli, NOTIFY_FLAGS, NotifyError, MERGE_REVIEW_WINDOW_HOURS } = require('../bin/notify');
const workState = require('../bin/work-state');

function rootDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-notify-'));
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'owner/repo', readyLabel: 'ready-for-agent', defaultBranch: 'integration', releaseBranch: 'main', carveOuts: ['server/db/migrations/**'] }));
  return root;
}

let tick = 0;
function at() { tick += 1; return new Date(Date.UTC(2026, 8, 1, 6, 0, tick)).toISOString(); }

// The real closing-linkage-missing template pr-watch.js ~302 emits (fleet#79
// QA round 1, major 4): `${closingLinkageTag(viewPr)}: checks settled but PR
// #${prNumber} carries no closing linkage for issue #${record.issue}; issue
// closure must belong to the merge`, where closingLinkageTag is
// `[pr-watch] closing-linkage body=<sha1-of-PR-body, 12 hex>`. `abc123def456`
// stands in for that hash - byte-accurate everywhere else, so the per-kind
// question rule in notify.js actually gets exercised the way it would for
// real evidence, not a hand-simplified paraphrase.
function closingLinkageEvidence({ issue = 42, prNumber = 77 } = {}) {
  return `wake:decision-needed; [pr-watch] closing-linkage body=abc123def456: checks settled but PR #${prNumber} carries no closing linkage for issue #${issue}; issue closure must belong to the merge`;
}

function seed(root, { issue = 42, prNumber = 77, to = 'escalated', evidence } = {}) {
  const id = `endzone:issue-${issue}`;
  workState.createRecord({ root, id, tenant: 'endzone', issue, state: 'implementing', github: { issueNumber: issue, prNumber }, actor: 'test', idempotencyKey: `c-${issue}`, now: at() });
  let revision = 1;
  const hops = to === 'hold' ? ['pr-open', 'ci-wait', 'review', 'hold'] : ['pr-open', 'ci-wait', 'escalated'];
  let last = null;
  for (const state of hops) {
    const isLast = state === hops[hops.length - 1];
    const finalEvidence = evidence || closingLinkageEvidence({ issue, prNumber });
    last = workState.transitionRecord({ root, id, to: state, expectedRevision: revision, idempotencyKey: `t-${issue}-${state}`, actor: 'pr-watch', evidence: isLast ? finalEvidence : `to ${state}`, now: at() });
    revision = last.revision;
  }
  return { id, revision, sequence: last.eventSequence };
}

// Walks a fresh record all the way to `merged` (pr-open -> ci-wait -> review ->
// merged), the way pr-watch.js's `mergedChain` really does, with a formal-
// review-missing evidence tail by default (fleet#79 QA round 1, blocker).
// `testOnly: true` + an explicit githubState/githubMergedAt is the same shape
// tests/work-state.tests.js uses to reach `merged` without a real `gh` call.
function seedMerged(root, { issue, prNumber, evidence, mergedAt, mergedBy, tenant = 'endzone' } = {}) {
  const id = `${tenant}:issue-${issue}`;
  workState.createRecord({ root, id, tenant, issue, state: 'implementing', github: { issueNumber: issue, prNumber }, actor: 'test', idempotencyKey: `c-${issue}`, now: at() });
  let revision = 1;
  for (const state of ['pr-open', 'ci-wait', 'review']) {
    const r = workState.transitionRecord({ root, id, to: state, expectedRevision: revision, idempotencyKey: `t-${issue}-${state}`, actor: 'pr-watch', evidence: `to ${state}`, now: at() });
    revision = r.revision;
  }
  const mergedTimestamp = mergedAt || at();
  const finalEvidence = evidence === undefined
    ? `observed merged at ${mergedTimestamp} (gh pr view ${prNumber}); merged without a recorded formal review (ticket 05 lower bound)`
    : evidence;
  const merged = workState.transitionRecord({
    root, id, to: 'merged', expectedRevision: revision, idempotencyKey: `t-${issue}-merged`, actor: 'pr-watch',
    evidence: finalEvidence, now: mergedTimestamp, prNumber, githubState: 'MERGED', githubMergedAt: mergedTimestamp, githubMergedBy: mergedBy, testOnly: true,
  });
  return { id, revision: merged.revision, sequence: merged.eventSequence, at: mergedTimestamp };
}

function sender(outcome = { ok: true, detail: 'toast shown' }) {
  const calls = [];
  const send = (message) => { calls.push(message); return typeof outcome === 'function' ? outcome(message) : outcome; };
  send.calls = calls;
  return send;
}

const COPIED_CRITERIA = [
  '## Acceptance criteria',
  '- [ ] Rebuilding status and digest from the same event offset is byte-stable.',
  '- [ ] One decision event produces one digest item and at most one successful notification event.',
].join('\n');

test('a pointer message names the record, revision, sequence, and artifact locations without copying issue text', () => {
  const root = rootDir();
  const { id, revision, sequence } = seed(root);
  const record = workState.getRecord({ root, id });
  const decision = workState.readEvents(root).find((event) => event.recordId === id && event.sequence === sequence);
  const message = buildPointerMessage({ root, record, event: decision, tenantConfig: { github: 'owner/repo' } });
  assert.equal(message.pointer.recordId, id);
  assert.equal(message.pointer.revision, revision);
  assert.equal(message.pointer.eventSequence, sequence);
  assert.ok(message.pointer.artifacts.some((artifact) => artifact.endsWith('active.json#endzone:issue-42')));
  assert.ok(message.pointer.artifacts.some((artifact) => /state[\\/]events[\\/]\d{4}-\d{2}-\d{2}\.jsonl#seq-\d+$/.test(artifact)));
  assert.ok(message.pointer.artifacts.includes('https://github.com/owner/repo/pull/77'));
  assert.match(message.title, /endzone #42/);
  assert.match(message.body, /endzone:issue-42 r\d+ seq\d+/);
  // Ticket 79 (fleet#79): the pointer line (locations only) still never repeats the
  // evidence prose, but the dedicated question line now deliberately surfaces the
  // ASK clause of it (QA round 1: pr-watch.js's closing-linkage-missing evidence
  // puts the ask, "issue closure must belong to the merge", in its LAST clause,
  // not its first) - that is the whole point of "says what it is asking".
  const [, evidenceLine, questionLine] = message.body.split('\n');
  assert.doesNotMatch(evidenceLine, /closing linkage/, 'the evidence pointer line names locations, not prose');
  assert.match(questionLine, /issue closure must belong to the merge/, 'the question line surfaces the ask clause of the evidence');
  assert.deepEqual(validatePointerMessage(message), { valid: true, reasons: [] });
});

test('a pointer message carries a question pointed at the decision evidence and a url to the PR, else the issue', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const record = workState.getRecord({ root, id });
  const decision = workState.readEvents(root).find((event) => event.recordId === id && event.sequence === sequence);
  const message = buildPointerMessage({ root, record, event: decision, tenantConfig: { github: 'owner/repo' } });
  // seed()'s escalation evidence is the real pr-watch.js closing-linkage-missing
  // template (QA round 1): the per-kind rule picks its LAST clause, the ask
  // ("issue closure must belong to the merge"), not the context clause before it.
  assert.equal(message.question, 'issue closure must belong to the merge');
  assert.equal(message.url, 'https://github.com/owner/repo/pull/77');
  assert.equal(message.priority, 'normal');
  assert.match(message.body, /question: issue closure must belong to the merge/);
  assert.match(message.body, /url: https:\/\/github\.com\/owner\/repo\/pull\/77/);
  assert.deepEqual(validatePointerMessage(message), { valid: true, reasons: [] });

  const noPr = workState.createRecord({
    root, id: 'endzone:issue-9', tenant: 'endzone', issue: 9, state: 'implementing',
    actor: 'test', idempotencyKey: 'c-9', now: at(),
  });
  const escalatedNoPr = workState.transitionRecord({
    root, id: 'endzone:issue-9', to: 'escalated', expectedRevision: noPr.revision,
    idempotencyKey: 't-9-escalated', actor: 'pr-watch', evidence: 'wake:decision-needed; no PR yet; needs a human call', now: at(),
  });
  const noPrRecord = workState.getRecord({ root, id: 'endzone:issue-9' });
  const noPrEvent = workState.readEvents(root).find((event) => event.recordId === 'endzone:issue-9' && event.sequence === escalatedNoPr.eventSequence);
  const noPrMessage = buildPointerMessage({ root, record: noPrRecord, event: noPrEvent, tenantConfig: { github: 'owner/repo' } });
  assert.equal(noPrMessage.url, 'https://github.com/owner/repo/issues/9', 'no PR: url falls back to the issue');
  assert.equal(noPrMessage.question, 'no PR yet');
});

test('priority is high only when the decision evidence says a merge landed without a recorded formal review', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const record = workState.getRecord({ root, id });
  const decision = workState.readEvents(root).find((event) => event.recordId === id && event.sequence === sequence);
  const normal = buildPointerMessage({ root, record, event: decision, tenantConfig: { github: 'owner/repo' } });
  assert.equal(normal.priority, 'normal');

  // The exact wording pr-watch.js `mergedChain` (and review-policy.js's equivalent)
  // append to a merge's evidence (fleet ticket 05 lower bound).
  const mergedNoReview = { ...decision, evidence: 'observed merged at 2026-09-14T12:35:00.000Z (gh pr view 77); merged without a recorded formal review (ticket 05 lower bound)' };
  const high = buildPointerMessage({ root, record, event: mergedNoReview, tenantConfig: { github: 'owner/repo' } });
  assert.equal(high.priority, 'high');
  // QA round 1: the question states the urgent fact directly, not pr-watch.js's
  // own "observed merged at <ts> (gh pr view N)" prose (which says how the
  // watcher knows, not what Cory needs to act on).
  assert.equal(high.question, 'PR #77 merged without a recorded formal review');
  assert.equal(high.url, 'https://github.com/owner/repo/pull/77');
});

// fleet#79 QA round 1 (minor 6): send-page.ps1's `-Priority` is a PowerShell
// ValidateSet of exactly emergency|high|normal; an out-of-set value there
// throws and the page never posts. A typo'd config edit must never reach it.
test('an out-of-set priority from config falls back to the built-in default for that kind, never an invalid value', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const record = workState.getRecord({ root, id });
  const decision = workState.readEvents(root).find((event) => event.recordId === id && event.sequence === sequence);

  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ pages: { priority: { 'state-escalated': 'urgent' }, defaultPriority: 'also-bogus' } }));
  const badMapValue = buildPointerMessage({ root, record, event: decision, tenantConfig: { github: 'owner/repo' } });
  assert.equal(badMapValue.priority, 'normal', 'falls back to state-escalated\'s own built-in default, not the also-invalid config default');

  const mergedNoReview = { ...decision, evidence: 'observed merged at 2026-09-14T12:35:00.000Z (gh pr view 77); merged without a recorded formal review (ticket 05 lower bound)' };
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ pages: { priority: { 'merge-review-wake': 'URGENT' } } }));
  const badMergeValue = buildPointerMessage({ root, record, event: mergedNoReview, tenantConfig: { github: 'owner/repo' } });
  assert.equal(badMergeValue.priority, 'high', 'falls back to merge-review-wake\'s own built-in default');

  // A valid override is still honoured.
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ pages: { priority: { 'state-escalated': 'high' } } }));
  const overridden = buildPointerMessage({ root, record, event: decision, tenantConfig: { github: 'owner/repo' } });
  assert.equal(overridden.priority, 'high');
});

// fleet#79 QA round 1: pr-watch.js and budget.js are outside ticket 79's scope,
// so notify.js keeps its own copies of the priority sentence and the literal
// evidence fragments its QUESTION_RULES table keys on. This is the guard: if
// any of these wordings ever moves at the source, this test goes red instead
// of the routing/question silently degrading (a priority silently dropping to
// normal, or a question silently degrading to the less useful first clause).
test('the merge-review sentence and every QUESTION_RULES fragment still match pr-watch.js and budget.js verbatim', () => {
  const prWatchSource = fs.readFileSync(path.join(__dirname, '..', 'bin', 'pr-watch.js'), 'utf8');
  const budgetSource = fs.readFileSync(path.join(__dirname, '..', 'bin', 'budget.js'), 'utf8');
  assert.ok(prWatchSource.includes("const WATCHER_MARK = '[pr-watch]';"), 'pr-watch.js WATCHER_MARK wording moved; update notify.js\'s copy');
  assert.ok(prWatchSource.includes('merged without a recorded formal review'), 'pr-watch.js\'s priority sentence moved; update notify.js MERGE_REVIEW_SENTENCE');
  assert.ok(prWatchSource.includes('without a merge; the record needs a human decision'), 'pr-watch.js ~276 evidence wording moved; update notify.js QUESTION_RULES');
  assert.ok(prWatchSource.includes('carries no closing linkage for issue #'), 'pr-watch.js ~302 evidence wording moved; update notify.js QUESTION_RULES');
  assert.ok(prWatchSource.includes('issue closure must belong to the merge'), 'pr-watch.js ~302 ask clause wording moved; update notify.js QUESTION_RULES expectations');
  assert.ok(prWatchSource.includes('closing linkage for issue #'), 'pr-watch.js ~336 evidence wording moved; update notify.js QUESTION_RULES');
  assert.ok(prWatchSource.includes('disappeared from PR #'), 'pr-watch.js ~336 evidence wording moved; update notify.js QUESTION_RULES');
  assert.ok(budgetSource.includes('job tokens >='), 'budget.js ~139 evidence wording moved; update notify.js QUESTION_RULES');
  assert.ok(budgetSource.includes('grant one with work-state.js budget --phase extend, then resolve the escalation'), 'budget.js ~139 ask clause wording moved; update notify.js QUESTION_RULES expectations');
});

// fleet#79 QA round 1 (major 4): the first semicolon clause is often context,
// not the ask. Every entry here is the launcher's REAL evidence shape (byte-
// accurate, sample values substituted), collected from budget.js and
// pr-watch.js; a caller with no fixed template (review-policy.js hold's free-
// text --reason, work-state.js's CLI --evidence) falls back to the first
// clause, same as before this table existed.
const REAL_EVIDENCE_TEMPLATES = [
  {
    name: 'budget escalate (budget.js ~139): the ask is the last clause',
    evidence: 'wake:decision-needed; budget: 350123 job tokens >= 350000; no extension; session ic-901; grant one with work-state.js budget --phase extend, then resolve the escalation',
    question: 'grant one with work-state.js budget --phase extend, then resolve the escalation',
  },
  {
    name: 'PR closed without a merge (pr-watch.js ~276): the ask is the last clause',
    evidence: 'wake:decision-needed; [pr-watch] PR #77 is CLOSED without a merge; the record needs a human decision',
    question: 'the record needs a human decision',
  },
  {
    name: 'closing linkage missing after checks settled (pr-watch.js ~302): the ask is the last clause',
    evidence: closingLinkageEvidence({ issue: 42, prNumber: 77 }),
    question: 'issue closure must belong to the merge',
  },
  {
    name: 'closing linkage disappeared (pr-watch.js ~336): one clause, no separate ask',
    evidence: 'wake:decision-needed; [pr-watch] closing-linkage body=abc123def456: closing linkage for issue #42 disappeared from PR #77 while review',
    question: '[pr-watch] closing-linkage body=abc123def456: closing linkage for issue #42 disappeared from PR #77 while review',
  },
  {
    name: "a hold's free-text reason (review-policy.js) falls back to the first (only) clause",
    evidence: "wake:decision-needed; PR #77 clean, parked for Cory's merge decision",
    question: "PR #77 clean, parked for Cory's merge decision",
  },
  {
    name: 'an empty first clause is skipped for the next non-empty one',
    evidence: 'wake:decision-needed; ; the real ask',
    question: 'the real ask',
  },
];

test('question extraction: the per-kind table for real launcher evidence, first clause for anything else', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const record = workState.getRecord({ root, id });
  const decision = workState.readEvents(root).find((event) => event.recordId === id && event.sequence === sequence);
  for (const { name, evidence, question } of REAL_EVIDENCE_TEMPLATES) {
    const message = buildPointerMessage({ root, record, event: { ...decision, evidence }, tenantConfig: { github: 'owner/repo' } });
    assert.equal(message.question, question, name);
  }
});

// fleet#79 QA round 1 (major 2 + 3): the pointer always sends. A question that
// would blow the body past MAX_BODY_LINES, or that trips a guard once
// prefixed with "question: " (the prefix defeats the anchored checklist/
// heading regexes - QA's exact probes), must be withheld and replaced, never
// let the whole page fail validation.
test('a question that would break validation is sanitised, withheld if needed, and the page still sends', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const record = workState.getRecord({ root, id });
  const decision = workState.readEvents(root).find((event) => event.recordId === id && event.sequence === sequence);

  // Probe 1: embedded newlines used to push the body past 6 lines outright.
  const newlineEvent = { ...decision, evidence: 'wake:decision-needed; line one\nline two\nline three\nline four' };
  const newlineMessage = buildPointerMessage({ root, record, event: newlineEvent, tenantConfig: { github: 'owner/repo' } });
  assert.equal(newlineMessage.body.split('\n').length, 4, 'newlines inside the question collapse to one line, not new ones');
  assert.equal(newlineMessage.question, 'line one line two line three line four');
  assert.deepEqual(validatePointerMessage(newlineMessage), { valid: true, reasons: [] });

  // Probe 2: a checklist marker, hidden behind "question: ", used to defeat the
  // anchored guard and pass validation with copied criteria intact.
  const checklistEvent = { ...decision, evidence: 'wake:decision-needed; - [ ] copied criterion' };
  const checklistMessage = buildPointerMessage({ root, record, event: checklistEvent, tenantConfig: { github: 'owner/repo' } });
  assert.equal(checklistMessage.questionWithheld, true);
  assert.match(checklistMessage.questionWithheldReason, /checklist/);
  assert.equal(checklistMessage.question, 'see the record');
  assert.deepEqual(validatePointerMessage(checklistMessage), { valid: true, reasons: [] });

  // Probe 3: a heading marker, same defeat, this time QA's own "## Findings" example.
  const headingEvent = { ...decision, evidence: 'wake:decision-needed; ## Findings from the review' };
  const headingMessage = buildPointerMessage({ root, record, event: headingEvent, tenantConfig: { github: 'owner/repo' } });
  assert.equal(headingMessage.questionWithheld, true);
  assert.match(headingMessage.questionWithheldReason, /heading/);
  assert.equal(headingMessage.question, 'see the record');
  assert.deepEqual(validatePointerMessage(headingMessage), { valid: true, reasons: [] });

  // Probe 4: the "acceptance criteria" phrase itself.
  const criteriaEvent = { ...decision, evidence: 'wake:decision-needed; copies Acceptance Criteria verbatim' };
  const criteriaMessage = buildPointerMessage({ root, record, event: criteriaEvent, tenantConfig: { github: 'owner/repo' } });
  assert.equal(criteriaMessage.questionWithheld, true);
  assert.equal(criteriaMessage.question, 'see the record');

  // Integration: runNotifier with an injected sender must still record `sent`,
  // never `failed`, for each adversarial evidence, and surface the withhold.
  for (const [label, evidence] of [['newline', newlineEvent.evidence], ['checklist', checklistEvent.evidence], ['heading', headingEvent.evidence]]) {
    const r = rootDir();
    const seeded = seed(r, { issue: 50, evidence });
    const send = sender();
    const run = runNotifier({ root: r, live: true, send, now: at() });
    assert.deepEqual(run.handled.map((h) => h.outcome), ['sent'], `${label}: the pointer always sends`);
    assert.equal(send.calls.length, 1, label);
    if (label !== 'newline') assert.equal(run.handled[0].questionWithheld, true, label);
    void seeded;
  }
});

test('the default sender is pageSender (never called in shadow) and the default channel label is page', () => {
  const { pageSender } = require('../bin/notify');
  assert.equal(typeof pageSender, 'function');
  assert.equal(typeof pageSender({ root: rootDir() }), 'function');
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender();
  runNotifier({ root, live: true, send, now: at() });
  const record = workState.getRecord({ root, id });
  assert.equal(record.notifications[String(sequence)].channel, 'page');
});

test('message fixtures: copied acceptance criteria are rejected, typed pointers accepted', () => {
  const typed = {
    title: 'Fleet decision: endzone #42', body: 'escalated - endzone:issue-42 r5 seq5 - PR #77',
    pointer: { recordId: 'endzone:issue-42', revision: 5, eventSequence: 5, artifacts: ['state/work/active.json#endzone:issue-42'] },
  };
  assert.equal(validatePointerMessage(typed).valid, true);
  const copied = validatePointerMessage({ ...typed, body: `${typed.body}\n${COPIED_CRITERIA}` });
  assert.equal(copied.valid, false);
  assert.ok(copied.reasons.some((reason) => /checklist/.test(reason)));
  assert.ok(copied.reasons.some((reason) => /acceptance criteria/i.test(reason)));
  assert.equal(validatePointerMessage({ ...typed, body: 'Acceptance Criteria copied here' }).valid, false);
  assert.equal(validatePointerMessage({ ...typed, body: `x\n${'y'.repeat(700)}` }).valid, false);
  assert.equal(validatePointerMessage({ ...typed, pointer: { ...typed.pointer, artifacts: [] } }).valid, false);
  assert.equal(validatePointerMessage({ ...typed, pointer: { recordId: 'endzone:issue-42' } }).valid, false);
  assert.equal(validatePointerMessage({ ...typed, body: 'see ```code``` block' }).valid, false);
});

test('live: one decision event pages once; repeated and concurrent notifier starts never page again', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender();
  const first = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(first.handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[id, sequence, 'sent']]);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].pointer.eventSequence, sequence);
  for (let index = 0; index < 5; index += 1) runNotifier({ root, live: true, send, now: at() });
  assert.equal(send.calls.length, 1);
  const record = workState.getRecord({ root, id });
  assert.equal(record.notifications[String(sequence)].status, 'sent');
  assert.equal(workState.readEvents(root).filter((event) => event.type === 'notification-sent').length, 1);
  // A reentrant start from inside the send (two notifiers racing) finds the claim and backs off.
  const root2 = rootDir();
  seed(root2);
  const reentrant = sender((message) => {
    const inner = runNotifier({ root: root2, live: true, send: reentrant, now: at() });
    assert.deepEqual(inner.handled, [], 'the claim is already on the record, so nothing is pending');
    return { ok: true, detail: 'ok' };
  });
  const outer = runNotifier({ root: root2, live: true, send: reentrant, now: at() });
  assert.deepEqual(outer.handled.map((h) => h.outcome), ['sent']);
  assert.equal(reentrant.calls.length, 1);
});

test('live: a failed delivery is recorded, visible, and inert until retry is authorized', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender({ ok: false, detail: 'toast api unavailable' });
  const first = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(first.handled.map((h) => h.outcome), ['failed']);
  runNotifier({ root, live: true, send, now: at() });
  runNotifier({ root, live: true, send, now: at() });
  assert.equal(send.calls.length, 1);
  let record = workState.getRecord({ root, id });
  assert.equal(record.notifications[String(sequence)].status, 'failed');
  assert.equal(record.notifications[String(sequence)].detail, 'toast api unavailable');
  workState.notifyRecord({ root, id, phase: 'authorize-retry', expectedRevision: record.revision, decisionSequence: sequence, idempotencyKey: 'auth-1', actor: 'cory', evidence: 'toast service restarted', now: at() });
  const ok = sender();
  const retried = runNotifier({ root, live: true, send: ok, now: at() });
  assert.deepEqual(retried.handled.map((h) => h.outcome), ['sent']);
  assert.equal(ok.calls.length, 1);
  record = workState.getRecord({ root, id });
  assert.equal(record.notifications[String(sequence)].attempt, 2);
  const types = workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).map((event) => event.type);
  assert.deepEqual(types, ['notification-attempted', 'notification-failed', 'notification-retry-authorized', 'notification-attempted', 'notification-sent']);
});

test('shadow (default): nothing is claimed or sent; the would-be page is logged once per decision', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender();
  assert.equal(isLive({ root }), false);
  const first = runNotifier({ root, send, now: at() });
  assert.deepEqual(first.handled.map((h) => h.outcome), ['shadow']);
  runNotifier({ root, send, now: at() });
  assert.equal(send.calls.length, 0);
  assert.equal(workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).length, 0);
  const shadow = fs.readFileSync(path.join(root, 'state', 'notify', 'shadow.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].recordId, id);
  assert.equal(shadow[0].sequence, sequence);
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'notifier-live'), '');
  assert.equal(isLive({ root }), true);
});

test('a decision resolved before the notifier ran is skipped; a hold pages like an escalation; targeting narrows the scan', () => {
  const root = rootDir();
  const resolved = seed(root, { issue: 1 });
  workState.transitionRecord({ root, id: resolved.id, to: 'ci-wait', expectedRevision: resolved.revision, idempotencyKey: 'resolve-1', actor: 'pr-watch', evidence: 'linkage restored', now: at() });
  const held = seed(root, { issue: 2, to: 'hold' });
  const other = seed(root, { issue: 3 });
  assert.deepEqual(findPendingDecisions({ root }).map((d) => [d.record.id, d.event.type]), [[held.id, 'state-hold'], [other.id, 'state-escalated']]);
  const send = sender();
  const targeted = runNotifier({ root, live: true, send, recordId: other.id, sequence: other.sequence, now: at() });
  assert.deepEqual(targeted.handled.map((h) => [h.recordId, h.outcome]), [[other.id, 'sent']]);
  const rest = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(rest.handled.map((h) => [h.recordId, h.outcome]), [[held.id, 'sent']]);
  assert.equal(send.calls.length, 2);
  assert.match(send.calls[1].body, /^hold/);
  const stale = runNotifier({ root, live: true, send, recordId: other.id, sequence: 2, now: at() });
  assert.deepEqual(stale.handled, []);
});

// fleet#79 QA round 1 (BLOCKER): `merged` is not a DECISION_STATE, so
// findPendingDecisions alone never sees pr-watch.js's merge-without-review
// wake - confirmed against the pre-fix bin/notify.js (fleet e9623b8) with a
// record driven to `merged` through real work-state transitions exactly like
// this: `runNotifier` returned `{ handled: [] }`, silently. This is that
// pending source's own suite; every fixture here reaches `merged` through
// seedMerged's real transitions, never a hand-made event.
test('findPendingMergedWithoutReview finds a real merged-without-review event that findPendingDecisions cannot', () => {
  const root = rootDir();
  const merged = seedMerged(root, { issue: 60, prNumber: 160 });
  assert.deepEqual(findPendingDecisions({ root }), [], 'the decision-state scan still finds nothing for a merged record');
  const pending = findPendingMergedWithoutReview({ root, now: at() });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].record.id, merged.id);
  assert.equal(pending[0].event.type, 'state-merged');
  assert.equal(pending[0].event.sequence, merged.sequence);
});

test('live: the merge-review wake pages once, at high priority, with the urgent question and the PR url', () => {
  const root = rootDir();
  const merged = seedMerged(root, { issue: 61, prNumber: 161 });
  const send = sender();
  const result = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(result.handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[merged.id, merged.sequence, 'sent']]);
  assert.equal(send.calls.length, 1);
  const message = send.calls[0];
  assert.equal(message.priority, 'high');
  assert.equal(message.question, 'PR #161 merged without a recorded formal review');
  assert.equal(message.url, 'https://github.com/owner/repo/pull/161');
  // fleet#99: recorded through the work-state door like any decision, never
  // in the old state/notify/merge-review-fallback.jsonl.
  const record = workState.getRecord({ root, id: merged.id });
  assert.equal(record.notifications[String(merged.sequence)].status, 'sent');
  assert.deepEqual(workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).map((event) => [event.type, event.changes.decisionType]), [['notification-attempted', 'state-merged'], ['notification-sent', 'state-merged']]);
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'merge-review-fallback.jsonl')), false);
  // Never repeats: a second run finds nothing pending.
  const again = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(again.handled, []);
  assert.equal(send.calls.length, 1);
});

test('shadow: the merge-review wake logs once and touches no record, same as a decision', () => {
  const root = rootDir();
  const merged = seedMerged(root, { issue: 62, prNumber: 162 });
  const send = sender();
  const result = runNotifier({ root, send, now: at() });
  assert.deepEqual(result.handled.map((h) => h.outcome), ['shadow']);
  const shadow = fs.readFileSync(path.join(root, 'state', 'notify', 'shadow.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].recordId, merged.id);
  assert.equal(shadow[0].decisionType, 'state-merged');
  assert.equal(workState.getRecord({ root, id: merged.id }).notifications, undefined, 'shadow touches no Work record');
  assert.equal(send.calls.length, 0);
});

test('an event older than the 48h window is never paged; going live does not page merge history', () => {
  const root = rootDir();
  const old = seedMerged(root, { issue: 63, prNumber: 163, mergedAt: '2026-08-01T00:00:00.000Z' });
  const now = '2026-09-01T00:00:00.000Z';
  assert.ok((new Date(now) - new Date(old.at)) / 3600000 > MERGE_REVIEW_WINDOW_HOURS, 'the fixture really is older than the window');
  assert.deepEqual(findPendingMergedWithoutReview({ root, now }), []);
  const send = sender();
  const result = runNotifier({ root, live: true, send, now });
  assert.deepEqual(result.handled, []);
  assert.equal(send.calls.length, 0);
});

test('a merge-review record that has already retired still records through the door, and dedupes there', () => {
  const root = rootDir();
  const merged = seedMerged(root, { issue: 64, prNumber: 164 });
  // The IC's roster row is gone by the time a delayed sweep runs: merged ->
  // retiring -> retired, fully archived, well before the notifier looks.
  const retiring = workState.transitionRecord({ root, id: merged.id, to: 'retiring', expectedRevision: merged.revision, idempotencyKey: 'retire-64', actor: 'test', evidence: 'roster row gone', now: at() });
  workState.transitionRecord({ root, id: merged.id, to: 'retired', expectedRevision: retiring.revision, idempotencyKey: 'retired-64', actor: 'test', evidence: 'retired', now: at() });
  const record = workState.getRecord({ root, id: merged.id }); // archived, but still resolvable
  assert.equal(record.state, 'retired');

  const pending = findPendingMergedWithoutReview({ root, now: at() });
  assert.equal(pending.length, 1, 'the source finds it whatever it has become since');

  const send = sender();
  const result = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(result.handled.map((h) => [h.recordId, h.outcome]), [[merged.id, 'sent']]);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].priority, 'high');

  const archived = workState.getRecord({ root, id: merged.id });
  assert.equal(archived.state, 'retired');
  assert.equal(archived.notifications[String(merged.sequence)].status, 'sent');
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'merge-review-fallback.jsonl')), false);
  // Never repeats: the archived record's own entry holds on a second sweep.
  const again = runNotifier({ root, live: true, send, now: at() });
  assert.deepEqual(again.handled, []);
  assert.equal(send.calls.length, 1);
});

test('fleet#99: a merged record later escalated and abandoned is skipped, not refused on every sweep', () => {
  const root = rootDir();
  const merged = seedMerged(root, { issue: 65, prNumber: 165 });
  const escalated = workState.transitionRecord({ root, id: merged.id, to: 'escalated', expectedRevision: merged.revision, idempotencyKey: 'esc-65', actor: 'test', evidence: 'retirement blocked', now: at() });
  workState.abandonRecord({ root, id: merged.id, expectedRevision: escalated.revision, idempotencyKey: 'abandon-65', actor: 'cory', reason: 'gone', now: at() });
  assert.deepEqual(findPendingMergedWithoutReview({ root, now: at() }), []);
  const send = sender();
  assert.deepEqual(runNotifier({ root, live: true, send, now: at() }).handled.filter((h) => h.recordId === merged.id), []);
  assert.equal(send.calls.length, 0);
});

test('a message that fails the pointer fixture is never sent and is recorded as a failed delivery', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const send = sender();
  const run = runNotifier({ root, live: true, send, now: at(), compose: () => ({ title: 't', body: COPIED_CRITERIA, pointer: { recordId: id, revision: 1, eventSequence: sequence, artifacts: ['x'] } }) });
  assert.deepEqual(run.handled.map((h) => h.outcome), ['failed']);
  assert.equal(send.calls.length, 0);
  assert.match(workState.getRecord({ root, id }).notifications[String(sequence)].detail, /message rejected/);
});

function waitForFile(file, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

test('spawnNotifier launches one detached notifier that handles exactly the named decision event (shadow)', () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const launch = spawnNotifier({ root, recordId: id, sequence });
  assert.equal(launch.spawned, true);
  const shadowFile = path.join(root, 'state', 'notify', 'shadow.jsonl');
  assert.ok(waitForFile(shadowFile), 'the detached notifier wrote its shadow line');
  const lines = fs.readFileSync(shadowFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.recordId, line.sequence]), [[id, sequence]]);
  assert.equal(workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).length, 0);
});

test('a hand-made escalation through the state CLI launches the notifier; --no-notifier does not', () => {
  const root = rootDir();
  const id = 'endzone:issue-7';
  workState.createRecord({ root, id, tenant: 'endzone', issue: 7, state: 'implementing', github: { issueNumber: 7, prNumber: 70 }, actor: 'test', idempotencyKey: 'c-7', now: at() });
  const cli = path.join(__dirname, '..', 'bin', 'work-state.js');
  const run = (extra) => execFileSync(process.execPath, [cli, 'transition', '--root', root, '--id', id, '--to', 'escalated', '--expected-revision', '1', '--idempotency-key', 'cli-esc', '--actor', 'pl-endzone', '--evidence', 'needs Cory', ...extra], { encoding: 'utf8' });
  const quiet = rootDir();
  workState.createRecord({ root: quiet, id, tenant: 'endzone', issue: 7, state: 'implementing', actor: 'test', idempotencyKey: 'c-7', now: at() });
  execFileSync(process.execPath, [cli, 'transition', '--root', quiet, '--id', id, '--to', 'escalated', '--expected-revision', '1', '--idempotency-key', 'cli-esc', '--actor', 'pl-endzone', '--evidence', 'needs Cory', '--no-notifier'], { encoding: 'utf8' });
  const out = JSON.parse(run([]));
  assert.equal(out.record.state, 'escalated');
  assert.equal(out.notifier?.spawned, true);
  assert.ok(waitForFile(path.join(root, 'state', 'notify', 'shadow.jsonl')), 'the CLI-made decision launched a notifier');
  assert.equal(fs.existsSync(path.join(quiet, 'state', 'notify', 'shadow.jsonl')), false);
});

test('a notifier that cannot be launched is a visible failed delivery, not silence', async () => {
  const root = rootDir();
  const { id, sequence } = seed(root);
  const launch = spawnNotifier({ root, recordId: id, sequence, node: path.join(root, 'no-such-node.exe') });
  assert.equal(launch.spawned, true, 'a missing executable only surfaces asynchronously');
  const started = Date.now();
  let record = workState.getRecord({ root, id });
  while (Date.now() - started < 8000 && record.notifications?.[String(sequence)]?.status !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, 50));   // the spawn error needs the event loop
    record = workState.getRecord({ root, id });
  }
  const entry = record.notifications[String(sequence)];
  assert.equal(entry.status, 'failed');
  assert.match(entry.detail, /notifier launch failed/);
  const types = workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).map((event) => event.type);
  assert.deepEqual(types, ['notification-attempted', 'notification-failed']);
});

// --- fleet#4: notify refuses unknown flags ---------------------------------
// notify.js has one command (`notify`, the whole binary - there is no
// subcommand word); before this a typo'd flag fell into a bucket nothing
// reads and the sweep silently ran with that option missing. `--id` and
// `--decision-sequence` are `work-state.js notify`'s names for the same two
// things this binary calls `--record`/`--sequence` - the confusable pair
// fleet#2 warned about, this time between two commands in the same repo
// rather than two repos.
//
// Red-tell: with the bin change stashed, every case below either fails to
// throw (the old parseArgs(argv) with no schema accepts anything) or throws
// a plain Error/WorkStateError instead of a NotifyError with code USAGE.
// Refs #4.

function notifyRoot() {
  const root = rootDir();
  return root;
}

function refusesUsage(argv, fragment) {
  assert.throws(() => cli(argv), (error) => {
    assert.ok(error instanceof NotifyError, `expected NotifyError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.code, 'USAGE');
    if (fragment) assert.match(error.message, fragment);
    return true;
  });
}

test('notify: --id (work-state.js notify command name) is refused as an unknown flag, not read as no target', () => {
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  const activeBefore = fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8');
  const eventsBefore = workState.readEvents(root);
  refusesUsage(['--root', root, '--id', id, '--sequence', String(sequence), '--live'], /unknown flag --id/);
  assert.equal(fs.readFileSync(path.join(root, 'state', 'work', 'active.json'), 'utf8'), activeBefore, 'the record file is untouched by a refused invocation');
  assert.deepEqual(workState.readEvents(root), eventsBefore, 'no event, including a notification-failed, is appended for a refusal');
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'shadow.jsonl')), false);
});

test('notify: --decision-sequence (work-state.js notify command name) is refused as an unknown flag', () => {
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  refusesUsage(['--root', root, '--record', id, '--decision-sequence', String(sequence)], /unknown flag --decision-sequence/);
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'shadow.jsonl')), false, 'a refused invocation never runs the shadow sweep either');
});

test('notify: the unknown-flag refusal names the accepted set', () => {
  assert.throws(() => cli(['--root', notifyRoot(), '--nope', 'x']), (error) => {
    for (const flag of NOTIFY_FLAGS.notify) assert.match(error.message, new RegExp(`--${flag}\\b`));
    assert.equal(error.flag, 'nope');
    assert.deepEqual(error.accepted, NOTIFY_FLAGS.notify);
    return true;
  });
});

test('notify: a correct invocation through cli() still runs the shadow sweep unchanged', () => {
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  const result = cli(['--root', root]);
  assert.deepEqual(result.handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[id, sequence, 'shadow']]);
  const shadow = fs.readFileSync(path.join(root, 'state', 'notify', 'shadow.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].recordId, id);
  assert.equal(workState.readEvents(root).filter((event) => event.type.startsWith('notification-')).length, 0);
});

test('notify: a targeted correct invocation through cli() passes --record/--sequence/--dry-run through to runNotifier unharmed', () => {
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  const result = cli(['--root', root, '--record', id, '--sequence', String(sequence), '--dry-run']);
  assert.deepEqual(result.handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[id, sequence, 'shadow']]);
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'notify.log.jsonl')), false, '--dry-run reached runNotifier: the sweep log was never written');
});

test('notify: the process exits 2 on a refusal and writes the refusal to stderr, no JSON answer on stdout', () => {
  const bin = path.join(__dirname, '..', 'bin', 'notify.js');
  const root = notifyRoot();
  const { id, sequence } = seed(root);
  const typo = spawnSync(process.execPath, [bin, '--root', root, '--id', id, '--sequence', String(sequence)], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 2);
  assert.equal(typo.stdout, '');
  const err = JSON.parse(typo.stderr);
  assert.equal(err.code, 'USAGE');
  assert.match(err.message, /unknown flag --id/);
  assert.equal(fs.existsSync(path.join(root, 'state', 'notify', 'shadow.jsonl')), false);
  const ok = execFileSync(process.execPath, [bin, '--root', root], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(ok).handled.map((h) => [h.recordId, h.sequence, h.outcome]), [[id, sequence, 'shadow']]);
});

// Spec fleet #93 / #155: the merge-without-review page names the merger.
test('#155: the merge-review page names the login that merged', () => {
  const root = rootDir();
  const merged = seedMerged(root, { issue: 81, prNumber: 181, mergedBy: 'fleet-bot' });
  const send = sender();
  runNotifier({ root, live: true, send, now: at() });
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].question, 'PR #181 merged by fleet-bot without a recorded formal review');
  assert.equal(send.calls[0].priority, 'high');
  assert.ok(merged.sequence > 0);
});
