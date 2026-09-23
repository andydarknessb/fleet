'use strict';
// Ticket 07: the minimal ephemeral notifier. It is a process, not a session: it
// receives (or scans for) a decision event, claims it through the state command,
// sends ONE push over the configured channel, records notification-sent or
// notification-failed, and exits. It never waits, polls, or re-pages: a failed
// delivery stays visible in the digest until `work-state.js notify --phase
// authorize-retry` or a materially new decision event. Zero model turns.
//
// Delivery is gated: without state/flags/notifier-live (or --live) the notifier
// runs in shadow, logging the page it would have sent to state/notify/shadow.jsonl
// and touching no Work record. The legacy Dispatcher relay stays authoritative
// until cutover, exactly as the pr-watch wakes did at ticket 04.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const workState = require('./work-state');

const { DECISION_STATES } = workState;
const MAX_BODY_CHARS = 600;
const MAX_BODY_LINES = 6;
// The question line is one truncated clause, not a paragraph: 200 chars leaves
// the fixed-cost lines (record pointer, evidence pointer, url) comfortable room
// under MAX_BODY_CHARS with the body still four lines, well under MAX_BODY_LINES.
const MAX_QUESTION_CHARS = 200;
// A withheld question still sends: a fixed, known-safe line that can never
// trip a guard, used only when the real question would (fleet#79 QA round 1).
const WITHHELD_QUESTION = 'see the record';

// Mirrors bin/pr-watch.js's own WATCHER_MARK constant (`[pr-watch]`). pr-watch.js
// is outside ticket 79's scope, so this is a second copy, not an import; the
// verbatim-source test below reads pr-watch.js's text and fails the suite if
// this ever drifts from it instead of silently degrading to the default
// (first-clause) question rule.
const WATCHER_MARK = '[pr-watch]';

// The exact sentence pr-watch.js's `mergedChain` (ticket 05 lower bound) and
// review-policy.js's equivalent append to a merge's evidence when no formal
// review was recorded. Both files are outside ticket 79's scope, so this is a
// second copy of the literal text, not an import; a test below reads
// pr-watch.js's source and fails the suite if the wording ever moves, since a
// silent drift here would silently downgrade every such page to normal.
const MERGE_REVIEW_SENTENCE = 'merged without a recorded formal review';

function evidenceCarriesMergeReviewSentence(evidence) {
  return String(evidence || '').includes(MERGE_REVIEW_SENTENCE);
}

// ADR 0012 / fleet#76: `config/cycle.json` `pages.priority` is the one map every
// page kind reads, Watchdog conditions and Notifier decisions alike (fleet#76
// seeded it with this binary's own two decision kinds, `state-escalated` and
// `state-hold`, both normal, plus the Watchdog's `merge-review-wake`, high).
// These are the same three keys, read only, never written here (config/cycle.json
// is outside ticket 79's scope): if the file is missing or a key is absent the
// built-in defaults below stand in, so an unconfigured host still prioritizes a
// merge-without-review page correctly instead of silently falling back to normal.
const DEFAULT_PAGE_PRIORITY = Object.freeze({
  'merge-review-wake': 'high',
  'state-escalated': 'normal',
  'state-hold': 'normal',
});
const DEFAULT_PAGE_PRIORITY_FALLBACK = 'normal';
// send-page.ps1's `-Priority` is a PowerShell ValidateSet of exactly these
// three; anything else throws there and the page is lost before it is ever
// posted (fleet#79 QA round 1, minor 6).
const VALID_PRIORITIES = new Set(['emergency', 'high', 'normal']);

class NotifyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NotifyError';
    this.code = code;
    Object.assign(this, details);
  }
}

// notify.js is a single-purpose binary (one process per decision event, or a
// manual/scripted sweep): unlike review-policy.js or exclusions.js it takes no
// command word in argv, so there is exactly one command, `notify`, and it
// declares its flags the same way a per-command schema would (fleet#4).
// --root/--record/--sequence are the three spawnNotifier ever builds (called
// from pr-watch's decision-needed wake, review-policy.js hold, work-state.js
// transition, and budget.js's escalation path - grepped: none pass anything
// else); --tenant/--live/--dry-run/--now are read by main() for a manual or
// scripted full sweep and by the tests that drive runNotifier's options
// through the same names.
const NOTIFY_FLAGS = Object.freeze({
  notify: ['root', 'tenant', 'record', 'sequence', 'live', 'dry-run', 'now'],
});

function baseOf(root) {
  return path.resolve(root || path.resolve(__dirname, '..'));
}

function isLive({ root, live } = {}) {
  if (live === true) return true;
  return fs.existsSync(path.join(baseOf(root), 'state', 'flags', 'notifier-live'));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// The one merge-without-review sentence pr-watch.js `mergedChain` and
// review-policy.js's equivalent append is the sole reason a decision page
// outranks the ordinary "Cory owns this" normal: everything else this binary
// ever sees (an escalated linkage gap, a budget escalation, a hold) is normal.
function decisionKind(event) {
  return evidenceCarriesMergeReviewSentence(event?.evidence) ? 'merge-review-wake' : event.type;
}

function pagePriorityFor(base, kind) {
  const config = readJson(path.join(base, 'config', 'cycle.json'), {}) || {};
  const table = { ...DEFAULT_PAGE_PRIORITY, ...(config.pages?.priority || {}) };
  const candidate = table[kind] || config.pages?.defaultPriority || DEFAULT_PAGE_PRIORITY_FALLBACK;
  if (VALID_PRIORITIES.has(candidate)) return candidate;
  // A typo'd config value (or a bad `defaultPriority`) must never reach
  // send-page.ps1's ValidateSet, which would throw and lose the page outright;
  // fall back to this kind's OWN built-in default, not the config's, since the
  // config's default might be just as broken.
  return DEFAULT_PAGE_PRIORITY[kind] || DEFAULT_PAGE_PRIORITY_FALLBACK;
}

function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The evidence a decision transition carries can itself open with a
// `wake:<kind>; ` prefix (work-state.js's own outbox strips the same prefix for
// the same reason). What is left is clause-delimited by semicolons, not periods:
// a mergedAt timestamp's fractional seconds, a token count, and `(gh pr view N)`
// all carry dots that a naive sentence split would cut mid-word. Empty clauses
// (a stray `; ;`) are dropped so an accidentally-empty first clause never wins
// by default - the next non-empty one does.
function evidenceClauses(evidence) {
  const stripped = String(evidence || '').replace(/^wake:[a-z-]+;\s*/, '').trim();
  if (!stripped) return { stripped: '', clauses: [] };
  return { stripped, clauses: stripped.split(';').map((part) => part.trim()).filter(Boolean) };
}

// fleet#79 QA round 1: the first clause is often context, not the ask -
// pr-watch.js ~276 drops "the record needs a human decision" (clause 2),
// budget.js ~139's ask is its last clause. Rather than a cleverer generic
// splitter, each launcher's REAL, fixed evidence shape gets its own rule here
// (a stable prefix of the wake-stripped text -> which clause states the ask,
// negative counting from the end so a template growing a clause does not
// silently break the index); anything unrecognised - a human's free-text hold
// reason or CLI --evidence, which have no fixed shape to key on - falls back to
// the first clause, exactly as before this table existed. tests/notify.tests.js
// reads pr-watch.js's and budget.js's source and asserts every literal
// fragment a rule below depends on is still there verbatim, so a rewording at
// the source turns the suite red instead of silently degrading to the fallback.
const QUESTION_RULES = Object.freeze([
  // budget.js ~139: "budget: <tokens> job tokens >= <threshold>; <extension>;
  // session <name>; grant one with work-state.js budget --phase extend, then
  // resolve the escalation" - the ask is the last clause.
  { test: (text) => /^budget: \d+ job tokens >=/.test(text), clause: -1 },
  // pr-watch.js ~276: "[pr-watch] PR #<n> is <state> without a merge; the
  // record needs a human decision" - the ask is the last clause.
  { test: (text) => new RegExp(`^${escapeRegExp(WATCHER_MARK)} PR #\\d+ is \\S+ without a merge;`).test(text), clause: -1 },
  // pr-watch.js ~302: "[pr-watch] closing-linkage body=<hash>: checks settled
  // but PR #<n> carries no closing linkage for issue #<n>; issue closure must
  // belong to the merge" - the ask is the last clause.
  { test: (text) => new RegExp(`^${escapeRegExp(WATCHER_MARK)} closing-linkage body=[0-9a-f]+: checks settled but PR #\\d+ carries no closing linkage`).test(text), clause: -1 },
  // pr-watch.js ~336: "[pr-watch] closing-linkage body=<hash>: closing linkage
  // for issue #<n> disappeared from PR #<n> while <state>" - one clause, no
  // separate ask; it IS the fact Cory needs. Redundant with the fallback
  // (index 0 either way) but named here so the table documents every shape.
  { test: (text) => new RegExp(`^${escapeRegExp(WATCHER_MARK)} closing-linkage body=[0-9a-f]+: closing linkage for issue #\\d+ disappeared`).test(text), clause: 0 },
]);

function pickClause(evidence) {
  const { stripped, clauses } = evidenceClauses(evidence);
  if (!clauses.length) return '';
  const rule = QUESTION_RULES.find((candidate) => candidate.test(stripped));
  const index = rule ? (rule.clause < 0 ? clauses.length + rule.clause : rule.clause) : 0;
  return clauses[index] ?? clauses[0];
}

// A hold reason or an escalation evidence can itself carry newlines (a
// multi-line CLI --evidence, a pasted reason); collapsing them to single
// spaces is what makes the question always fit as ONE body line - before
// this, three or more embedded newlines pushed the body past MAX_BODY_LINES
// and the whole page failed validation (fleet#79 QA round 1, major 2).
function collapseWhitespace(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

function truncateQuestion(text) {
  return text.length > MAX_QUESTION_CHARS ? `${text.slice(0, MAX_QUESTION_CHARS - 3)}...` : text;
}

// Shared by validatePointerMessage (the whole title+body) and buildPointerMessage
// (the raw question clause, BEFORE it gets a `question: ` prefix). Checking only
// the full prefixed body used to let a copied checklist or heading right through:
// every one of these patterns is anchored to the START of a line
// (`^\s*[-*]\s*\[`, `^\s*#{1,6}\s`), so "question: - [ ] copied criterion" or
// "question: ## Findings from the review" never matched - the "question: "
// text itself defeated the anchor (fleet#79 QA round 1, major 3).
function bodyGuardReasons(text) {
  const reasons = [];
  if (/^\s*[-*]\s*\[[ xX]\]/m.test(text)) reasons.push('carries a checklist (copied criteria)');
  if (/acceptance criteria/i.test(text)) reasons.push('names acceptance criteria');
  if (/^\s*#{1,6}\s/m.test(text)) reasons.push('carries markdown headings (copied document)');
  if (/```/.test(text)) reasons.push('carries a code fence');
  return reasons;
}

// Pointer message: what a page is allowed to carry. Locations, never content -
// `question` is the record's own escalation or hold evidence pointed at in one
// truncated clause, not the evidence copied in full, and `url` is the one link
// worth tapping (the PR when there is one, else the issue).
//
// The pointer always sends (fleet#79 QA round 1, major 2): the question is
// sanitised (whitespace/newlines collapsed to one line, capped) and checked
// against the same guards validatePointerMessage runs, standalone, BEFORE it is
// ever embedded in the body. A question that would fail either check is
// replaced with WITHHELD_QUESTION and `questionWithheld`/`questionWithheldReason`
// say so - a withheld question can never be why a page fails to go out.
function buildPointerMessage({ root, record, event, tenantConfig = {} } = {}) {
  const base = baseOf(root);
  const state = event.type.slice('state-'.length);
  const prNumber = record.github?.prNumber || event.changes?.prNumber || null;
  const repo = tenantConfig.github || null;
  const artifacts = [
    `${path.join('state', 'work', 'active.json')}#${record.id}`,
    `${path.join('state', 'events', `${String(event.at).slice(0, 10)}.jsonl`)}#seq-${event.sequence}`,
    path.join('state', 'status', 'DIGEST.md'),
  ];
  const prUrl = repo && prNumber ? `https://github.com/${repo}/pull/${prNumber}` : null;
  const issueUrl = repo && record.issue ? `https://github.com/${repo}/issues/${record.issue}` : null;
  if (prUrl) artifacts.push(prUrl);
  if (issueUrl) artifacts.push(issueUrl);
  const url = prUrl || issueUrl || null;
  const kind = decisionKind(event);
  const priority = pagePriorityFor(base, kind);
  // The merge-without-review page states the urgent fact directly rather than
  // pointing at pr-watch.js's own "observed merged at <ts> (gh pr view N)"
  // prose, which names how the watcher knows, not what Cory needs to act on.
  const rawQuestion = (kind === 'merge-review-wake' && prNumber)
    ? `PR #${prNumber} merged without a recorded formal review`
    : pickClause(event.evidence);
  const candidateQuestion = truncateQuestion(collapseWhitespace(rawQuestion));
  let question = candidateQuestion;
  let questionWithheld = false;
  let questionWithheldReason = null;
  if (candidateQuestion) {
    const guardReasons = bodyGuardReasons(candidateQuestion);
    if (guardReasons.length) {
      questionWithheld = true;
      questionWithheldReason = guardReasons.join('; ');
      question = WITHHELD_QUESTION;
    }
  }
  const pointer = { recordId: record.id, revision: record.revision, eventSequence: event.sequence, decisionType: event.type, artifacts };
  const title = `Fleet decision: ${record.tenant} #${record.issue}`;
  const body = [
    `${state} - ${record.id} r${record.revision} seq${event.sequence}${prNumber ? ` - PR #${prNumber}` : ''}`,
    `evidence: ${artifacts[1]} - digest: ${artifacts[2]} - run bin\\status.ps1`,
    `question: ${question || '(none recorded)'}`,
    `url: ${url || 'none'}`,
  ].join('\n');
  return { title, body, pointer, base, question, url, priority, kind, questionWithheld, questionWithheldReason };
}

// The fixture: a page is a typed pointer, not a copy of the issue, criteria,
// findings, or a prior message.
function validatePointerMessage(message) {
  const reasons = [];
  const pointer = message?.pointer;
  if (!pointer || typeof pointer !== 'object') reasons.push('pointer is missing');
  else {
    if (!pointer.recordId) reasons.push('pointer.recordId is missing');
    if (!Number.isInteger(Number(pointer.revision)) || Number(pointer.revision) <= 0) reasons.push('pointer.revision is missing');
    if (!Number.isInteger(Number(pointer.eventSequence)) || Number(pointer.eventSequence) <= 0) reasons.push('pointer.eventSequence is missing');
    if (!Array.isArray(pointer.artifacts) || pointer.artifacts.length === 0) reasons.push('pointer.artifacts is empty');
  }
  const text = `${message?.title || ''}\n${message?.body || ''}`;
  if (!String(message?.title || '').trim()) reasons.push('title is empty');
  reasons.push(...bodyGuardReasons(text).map((reason) => `body ${reason}`));
  if (String(message?.body || '').length > MAX_BODY_CHARS) reasons.push(`body exceeds ${MAX_BODY_CHARS} characters`);
  if (String(message?.body || '').split(/\r?\n/).length > MAX_BODY_LINES) reasons.push(`body exceeds ${MAX_BODY_LINES} lines`);
  return { valid: reasons.length === 0, reasons };
}

// Pending = an active record sitting in a decision state whose entering event has
// no notification entry, or a failed one re-armed by authorize-retry. Claimed and
// sent entries are not pending: a stale claim is visible delivery state, not a
// reason to page again.
function findPendingDecisions({ root, tenant, recordId, sequence } = {}) {
  const base = baseOf(root);
  let active;
  try { active = JSON.parse(fs.readFileSync(path.join(base, 'state', 'work', 'active.json'), 'utf8')); } catch { active = { records: {} }; }
  const events = workState.readEvents(base);
  const pending = [];
  const records = Object.values(active.records || {})
    .filter((record) => DECISION_STATES.includes(record.state))
    .filter((record) => !tenant || record.tenant === tenant)
    .filter((record) => !recordId || record.id === recordId)
    .sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue);
  for (const record of records) {
    const entering = workState.enteringEvent(events, record.id, record.state);
    if (!entering) continue;
    if (sequence !== undefined && Number(entering.sequence) !== Number(sequence)) continue;
    const entry = record.notifications?.[String(entering.sequence)] || null;
    if (entry && !(entry.status === 'failed' && entry.retryAuthorized)) continue;
    pending.push({ record, event: entering, entry });
  }
  return pending;
}

function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

// ADR 0012 / fleet#79 QA round 1 (blocker): `merged` is not one of
// DECISION_STATES (work-state.js's own decision states are only `escalated`
// and `hold`), so findPendingDecisions above can never see a merge-without-
// review wake - pr-watch.js's `mergedChain` still fires wake:decision-needed
// and still spawns a notifier for it (ticket 05 lower bound), but that
// notifier found nothing pending and exited having done nothing. This is that
// wake's own pending source: it scans the raw ledger for `state-merged`
// events carrying MERGE_REVIEW_SENTENCE, bounded to the last
// MERGE_REVIEW_WINDOW_HOURS (a first live cutover must not page merge
// history), and resolves the record through workState.getRecord - active,
// archived/retired, released, or abandoned - rather than requiring it still
// be literally `merged`: a merged record retires quickly once its IC leaves
// the roster (work-state.js `shadowProject`), well within the time a delayed
// or full-sweep notifier run might take to reach it.
const MERGE_REVIEW_WINDOW_HOURS = 48;

function withinMergeReviewWindow(eventAt, now) {
  const at = new Date(eventAt).getTime();
  const reference = new Date(now || Date.now()).getTime();
  return Number.isFinite(at) && Number.isFinite(reference) && (reference - at) <= MERGE_REVIEW_WINDOW_HOURS * 60 * 60 * 1000;
}

// Delivery/dedupe for this source, full stop - not a rare-case fallback.
// workState.notifyRecord's claim phase requires the referenced event's type to
// be one of its own DECISION_EVENT_TYPES (`state-escalated`/`state-hold`
// only); a `state-merged` event throws NOT_A_DECISION_EVENT there EVERY time,
// whether or not the record is still active and literally `merged`, and a
// record that has since moved on entirely (retiring/retired/released/
// abandoned) separately throws DECISION_RESOLVED or NOT_FOUND. Widening
// DECISION_EVENT_TYPES is a work-state.js change and out of ticket 79's scope,
// so this source never touches the ledger's own notification door at all -
// this file is the whole of its delivery record. Same shape as a ledger
// notification entry (status, attempt, detail) so the same failed/
// retryAuthorized rule applies uninterrupted; there is no CLI door to set
// retryAuthorized here, so a failed delivery needs a hand edit to this file to
// retry (a work-state.js change to accept `merged` as a decision type would be
// the real fix, and is out of ticket 79's scope).
function mergeFallbackFile(base) { return path.join(base, 'state', 'notify', 'merge-review-fallback.jsonl'); }

function readMergeFallback(base) {
  const file = mergeFallbackFile(base);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function latestFallbackEntry(entries, recordId, sequence) {
  const matches = entries.filter((entry) => entry.recordId === recordId && Number(entry.sequence) === Number(sequence));
  return matches.length ? matches[matches.length - 1] : null;
}

function appendMergeFallback(base, entry) { appendLine(mergeFallbackFile(base), entry); }

function findPendingMergedWithoutReview({ root, tenant, recordId, sequence, now } = {}) {
  const base = baseOf(root);
  const fallback = readMergeFallback(base);
  const events = workState.readEvents(base)
    .filter((event) => event.type === 'state-merged' && evidenceCarriesMergeReviewSentence(event.evidence))
    .filter((event) => !recordId || event.recordId === recordId)
    .filter((event) => sequence === undefined || Number(event.sequence) === Number(sequence))
    .filter((event) => withinMergeReviewWindow(event.at, now));
  const pending = [];
  for (const event of events) {
    let record;
    try { record = workState.getRecord({ root: base, id: event.recordId }); } catch { continue; }
    if (tenant && record.tenant !== tenant) continue;
    const ledgerEntry = record.notifications?.[String(event.sequence)] || null;
    if (ledgerEntry && !(ledgerEntry.status === 'failed' && ledgerEntry.retryAuthorized)) continue;
    const fallbackEntry = latestFallbackEntry(fallback, event.recordId, event.sequence);
    if (fallbackEntry && !(fallbackEntry.status === 'failed' && fallbackEntry.retryAuthorized)) continue;
    const attempt = Math.max(ledgerEntry?.attempt || 0, fallbackEntry?.attempt || 0);
    const entry = (ledgerEntry || fallbackEntry) ? { ...(ledgerEntry || fallbackEntry), attempt } : null;
    pending.push({ record, event, entry });
  }
  return pending.sort((a, b) => String(a.record.tenant).localeCompare(String(b.record.tenant)) || a.record.issue - b.record.issue);
}

function shadowSeen(file, recordId, sequence, attempt) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
    try { const entry = JSON.parse(line); return entry.recordId === recordId && entry.sequence === sequence && entry.attempt === attempt; } catch { return false; }
  });
}

function toastSender({ root, powershell = 'powershell.exe' } = {}) {
  const script = path.join(baseOf(root), 'bin', 'send-toast.ps1');
  return (message) => {
    try {
      const raw = execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', message.title, '-Body', message.body], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
      });
      const last = String(raw).trim().split(/\r?\n/).pop() || '{}';
      const result = JSON.parse(last);
      return { ok: result.delivered === true, detail: result.detail || (result.delivered ? 'toast shown' : 'toast not delivered') };
    } catch (error) {
      return { ok: false, detail: `toast channel failed: ${String(error.stderr || error.message || error).slice(0, 200)}` };
    }
  };
}

// Ticket 79 (ADR 0012): the Notifier's default sender, through the one page door
// (bin/send-page.ps1 -> Send-FleetPage) instead of the toast-only bin/send-toast.ps1.
// Pushover and the pages.jsonl audit line always run there; the toast stays as the
// on-host echo. Delivery is "ok" only on an actual Pushover post: an unconfigured
// pushover.json (Cory has not wired his phone up yet) is a recorded, visible,
// retryable failure here, same as a network error - never a silent success.
function pageSender({ root, powershell = 'powershell.exe' } = {}) {
  const script = path.join(baseOf(root), 'bin', 'send-page.ps1');
  return (message) => {
    try {
      const args = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Kind', message.kind || 'state-decision',
        '-Title', message.title,
        '-Body', message.body,
        '-Priority', message.priority || 'normal',
      ];
      if (message.url) args.push('-Url', message.url);
      const raw = execFileSync(powershell, args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
      });
      const last = String(raw).trim().split(/\r?\n/).pop() || '{}';
      const result = JSON.parse(last);
      if (result.pushover === true) return { ok: true, detail: 'pushover delivered' };
      if (result.pushover === 'unconfigured') return { ok: false, detail: 'page channel unconfigured: state/pages/pushover.json is missing' };
      return { ok: false, detail: `page channel failed: ${result.pushoverError || 'pushover not delivered'}` };
    } catch (error) {
      return { ok: false, detail: `page channel failed: ${String(error.stderr || error.message || error).slice(0, 200)}` };
    }
  };
}

function refreshDigest(root, tenants) {
  // Projections, not state: a failure here loses nothing the ledger does not hold.
  try {
    const { projectDigest } = require('./digest');
    projectDigest({ root });
    for (const tenant of tenants) projectDigest({ root, tenant });
  } catch { /* the next watch tick rebuilds them */ }
}

function runNotifier(options = {}) {
  const base = baseOf(options.root);
  const live = isLive({ root: base, live: options.live });
  const actor = options.actor || 'notifier';
  const channel = options.channel || 'page';
  const send = options.send || pageSender({ root: base });
  const compose = options.compose || buildPointerMessage;
  const configs = options.tenantConfigs || workState.readTenantConfigs(base);
  const now = options.now;
  const shadowFile = path.join(base, 'state', 'notify', 'shadow.jsonl');
  const result = { at: new Date(now || Date.now()).toISOString(), live, handled: [] };
  const touchedTenants = new Set();

  const pendingDecisions = findPendingDecisions({ root: base, tenant: options.tenant, recordId: options.recordId, sequence: options.sequence })
    .map((item) => ({ ...item, source: 'decision' }));
  // fleet#79 QA round 1 (blocker): the merge-without-review wake's own pending
  // source - `merged` is not a DECISION_STATE, so findPendingDecisions alone
  // never sees it.
  const pendingMergeReviews = findPendingMergedWithoutReview({ root: base, tenant: options.tenant, recordId: options.recordId, sequence: options.sequence, now })
    .map((item) => ({ ...item, source: 'merge-review' }));

  for (const { record, event, entry, source } of [...pendingDecisions, ...pendingMergeReviews]) {
    const tenantConfig = configs[record.tenant] || {};
    const handled = { recordId: record.id, sequence: event.sequence, decisionType: event.type, outcome: null };
    result.handled.push(handled);
    const attempt = (entry?.attempt || 0) + 1;
    if (!live) {
      handled.outcome = 'shadow';
      if (!shadowSeen(shadowFile, record.id, event.sequence, attempt)) {
        const message = compose({ root: base, record, event, tenantConfig });
        appendLine(shadowFile, { at: result.at, recordId: record.id, sequence: event.sequence, attempt, decisionType: event.type, pointer: message.pointer, title: message.title });
      }
      continue;
    }
    let claimed;
    let viaFallback = false;
    try {
      claimed = workState.notifyRecord({ root: base, id: record.id, phase: 'claim', expectedRevision: record.revision, decisionSequence: event.sequence, idempotencyKey: `notify:${record.id}:s${event.sequence}:a${attempt}:claim`, actor, channel, now });
    } catch (error) {
      // The real ledger door refuses EVERY merge-review claim, always:
      // workState.notifyRecord's own DECISION_EVENT_TYPES is exactly
      // ['state-escalated', 'state-hold'] (work-state.js is out of #79's
      // scope to widen), so a `state-merged` event throws NOT_A_DECISION_EVENT
      // there even while the record is still active and literally `merged`.
      // A record that has since moved past `merged` entirely (retiring,
      // retired, released, abandoned) would separately throw DECISION_RESOLVED
      // or NOT_FOUND. The fact still stands and Cory still needs it either
      // way, so this source always falls back to its own file.
      if (source === 'merge-review' && ['NOT_A_DECISION_EVENT', 'DECISION_RESOLVED', 'NOT_FOUND'].includes(error.code)) {
        viaFallback = true;
        claimed = { record, revision: record.revision };
      } else {
        // STALE_REVISION means another actor moved first; every other refusal
        // names the standing delivery state. Neither is ours to force.
        handled.outcome = `skipped:${error.code === 'NOTIFICATION_ALREADY_CLAIMED' || error.code === 'STALE_REVISION' ? 'claimed' : String(error.code || 'error').toLowerCase()}`;
        handled.detail = error.message;
        continue;
      }
    }
    touchedTenants.add(record.tenant);
    const message = compose({ root: base, record: claimed.record, event, tenantConfig });
    const fixture = validatePointerMessage(message);
    let delivery;
    if (!fixture.valid) delivery = { ok: false, detail: `message rejected: ${fixture.reasons.join('; ')}` };
    else {
      try { delivery = send(message); } catch (error) { delivery = { ok: false, detail: `send threw: ${String(error.message || error).slice(0, 200)}` }; }
      if (!delivery || typeof delivery !== 'object') delivery = { ok: false, detail: 'channel returned no result' };
    }
    const phase = delivery.ok ? 'sent' : 'failed';
    if (viaFallback) {
      appendMergeFallback(base, { at: result.at, recordId: record.id, sequence: event.sequence, attempt, status: phase, detail: delivery.detail || null });
      handled.outcome = phase;
      handled.via = 'fallback';
    } else {
      try {
        workState.notifyRecord({ root: base, id: record.id, phase, expectedRevision: claimed.revision, decisionSequence: event.sequence, idempotencyKey: `notify:${record.id}:s${event.sequence}:a${attempt}:${phase}`, actor, channel, detail: delivery.detail || null, now });
        handled.outcome = phase;
      } catch (error) {
        // The claim stands (visible as in-flight) and the page, if it went out, went
        // out once. Recording the settle again would be a second write, not a fix.
        handled.outcome = `unsettled:${String(error.code || 'error').toLowerCase()}`;
        handled.detail = error.message;
      }
    }
    if (message.questionWithheld) { handled.questionWithheld = true; handled.questionWithheldReason = message.questionWithheldReason; }
    handled.detail = handled.detail || delivery.detail || null;
  }
  if (!options.dryRun) {
    appendLine(path.join(base, 'state', 'notify', 'notify.log.jsonl'), result);
    if (touchedTenants.size) refreshDigest(base, [...touchedTenants]);
  }
  return result;
}

// A launch that never produced a process is a failed delivery like any other:
// record it through the door so the digest shows it and authorize-retry can re-arm.
function recordLaunchFailure(base, recordId, sequence, detail) {
  if (!recordId || sequence === undefined || sequence === null) return false;
  try {
    const record = workState.getRecord({ root: base, id: recordId });
    const attempt = (record.notifications?.[String(sequence)]?.attempt || 0) + 1;
    const claimed = workState.notifyRecord({ root: base, id: recordId, phase: 'claim', expectedRevision: record.revision, decisionSequence: Number(sequence), idempotencyKey: `notify:${recordId}:s${sequence}:a${attempt}:claim`, actor: 'notifier-launch', channel: 'toast' });
    workState.notifyRecord({ root: base, id: recordId, phase: 'failed', expectedRevision: claimed.revision, decisionSequence: Number(sequence), idempotencyKey: `notify:${recordId}:s${sequence}:a${attempt}:failed`, actor: 'notifier-launch', channel: 'toast', detail });
    return true;
  } catch { return false; }   // a standing claim or a resolved decision already tells the story
}

// Detached launch of one notifier for one decision event. Callers are the event
// producers (pr-watch, review-policy hold, the state CLI): a decision event is
// what launches a notifier, nothing else does.
function spawnNotifier({ root, recordId, sequence, node = process.execPath } = {}) {
  const base = baseOf(root);
  const args = [path.join(__dirname, 'notify.js'), '--root', base];
  if (recordId) args.push('--record', String(recordId));
  if (sequence !== undefined && sequence !== null) args.push('--sequence', String(sequence));
  const fail = (error) => {
    const detail = `notifier launch failed: ${String(error.message || error).slice(0, 200)}`;
    return { spawned: false, error: detail, recorded: recordLaunchFailure(base, recordId, sequence, detail), args };
  };
  try {
    const child = spawn(node, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: base });
    // A missing executable surfaces as an asynchronous 'error', never a throw:
    // record it the same way, and never let it become an uncaught exception in
    // the producer (the watcher tick or the state CLI) that asked for the launch.
    child.on('error', (error) => { fail(error); });
    child.unref();
    return { spawned: true, pid: child.pid, args };
  } catch (error) {
    return fail(error);
  }
}

// `notify` is the only command this binary has; a typo'd flag is refused
// before anything is touched (findPendingDecisions/notifyRecord run only once
// parseArgs has returned), so a refusal can never surface as a recorded
// failed delivery.
function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, NOTIFY_FLAGS.notify);
  } catch (error) {
    if (error.code === 'USAGE') throw new NotifyError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  return runNotifier({
    root: args.root, tenant: args.tenant, recordId: args.record,
    sequence: args.sequence ? Number(args.sequence) : undefined,
    live: args.live === 'true' ? true : undefined, dryRun: args['dry-run'] === 'true', now: args.now,
  });
}

function main(argv) {
  const result = cli(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    if (error.code === 'USAGE') {
      // A refused invocation exits 2 so a caller reading only the status
      // cannot take it for a failed delivery, let alone a completed one
      // (fleet#2's rule, adopted here per fleet#4).
      process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message, flag: error.flag, accepted: error.accepted })}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  DECISION_STATES,
  NOTIFY_FLAGS,
  NotifyError,
  buildPointerMessage,
  cli,
  findPendingDecisions,
  findPendingMergedWithoutReview,
  isLive,
  MERGE_REVIEW_SENTENCE,
  MERGE_REVIEW_WINDOW_HOURS,
  pageSender,
  runNotifier,
  spawnNotifier,
  toastSender,
  validatePointerMessage,
};
