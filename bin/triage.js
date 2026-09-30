'use strict';
// ADR 0011: the Principal's frontier, ledger and projection. Three commands:
//
//   frontier  what the Principal should look at now, computed from GitHub facts
//             (or a fixture), the tenant's outbox and the triage ledger; fail closed
//             on an unreadable GitHub, an unset owner login, or an unknown flag.
//   record    append one typed entry to state/triage/<tenant>.jsonl (the only writer).
//   state     fold the ledger: pending proposals, approvals awaiting finalizing, the
//             14-day approved-unchanged ratio (the graduation metric) and the
//             consumed-up-to marker for decision-needed wakes.
//
// The ledger is append-only JSONL like state/exclusions/. Nothing here posts a
// comment or touches a label: the Principal does that with gh and records it here.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorkStateError, parseArgs } = require('./work-state');
const { sha256, VETO_RE } = require('./assignment');
const { readPremises } = require('./premises');

const DEFAULT_CONFIG = Object.freeze({
  markerLabel: 'triage-proposed',
  triageLabels: ['needs-triage', 'question'],
  routingLabels: ['ready-for-human', 'needs-info', 'wontfix', 'spec'],
  maxProposalsPerTurn: 5,
  windowDays: 14,
  graduation: { minProposals: 30, minDays: 14, minUnchangedRatio: 0.9 },
});

// Spec fleet #193 (#210, #211): the bounded kinds are written only by their doors
// (bin/bounded-authority.js: bounded-ready, veto, and the suspension scan), never by
// `record`, and none of them is an outcome the unchanged ratio counts.
const BOUNDED_KINDS = Object.freeze(['bounded-ready', 'veto', 'suspended']);
const LEDGER_KINDS = Object.freeze(['proposed', 'approved', 'approved-with-edits', 'rejected', 'superseded', 'finalized', 'consumed', ...BOUNDED_KINDS]);
const OUTCOME_KINDS = Object.freeze(['approved', 'approved-with-edits', 'rejected', 'superseded']);
const APPROVAL_RE = /^\s*approved(\s+with\s*:|\b)/i;
const APPROVAL_WITH_EDITS_RE = /^\s*approved\s+with\s*:/i;
// #207 (spec #193): the exact approval is the one word `Approved`, whitespace aside. Anything
// else that APPROVAL_RE admits ("Approved with: ...", "Approved, but skip X") is an approval
// WITH edits and stays with the Principal.
const EXACT_APPROVAL_RE = /^\s*approved\s*$/i;
function isExactApproval(body) { return EXACT_APPROVAL_RE.test(String(body || '')); }
// fleet#55: the fleet posts under the tenant's ownerLogin, so authorship cannot
// tell Cory from a session. A re-proposal ask is therefore a comment that BEGINS
// "Re-propose", a wording hooks/principal-guard.ps1 refuses to every fleet role
// exactly as it refuses "Approved"; the shape is what makes it the owner's.
const REPROPOSE_RE = /^\s*re-?propose\b/i;

function baseOf(root) { return path.resolve(root || path.resolve(__dirname, '..')); }

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

function isoOrThrow(value, field) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new WorkStateError('TRIAGE_INVALID', `${field} must be an ISO timestamp`);
  return date.toISOString();
}

function requireText(value, field) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) throw new WorkStateError('TRIAGE_INVALID', `${field} is required`);
  return text;
}

function requireIssue(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new WorkStateError('TRIAGE_INVALID', 'issue must be a positive integer');
  return number;
}

// ---------------------------------------------------------------- config ----

function readTriageConfig(root) {
  let cycle = {};
  try { cycle = readJsonFile(path.join(baseOf(root), 'config', 'cycle.json'), {}) || {}; } catch { cycle = {}; }
  const given = cycle.triage || {};
  return {
    markerLabel: String(given.markerLabel || DEFAULT_CONFIG.markerLabel),
    triageLabels: Array.isArray(given.triageLabels) ? given.triageLabels.map(String) : [...DEFAULT_CONFIG.triageLabels],
    routingLabels: Array.isArray(given.routingLabels) ? given.routingLabels.map(String) : [...DEFAULT_CONFIG.routingLabels],
    maxProposalsPerTurn: Number.isInteger(Number(given.maxProposalsPerTurn)) && Number(given.maxProposalsPerTurn) > 0 ? Number(given.maxProposalsPerTurn) : DEFAULT_CONFIG.maxProposalsPerTurn,
    windowDays: Number(given.windowDays) > 0 ? Number(given.windowDays) : DEFAULT_CONFIG.windowDays,
    graduation: { ...DEFAULT_CONFIG.graduation, ...(given.graduation || {}) },
  };
}

function readTenantConfig(root, tenant, file) {
  const tenantFile = file ? path.resolve(file) : path.join(baseOf(root), 'tenants', `${tenant}.json`);
  const config = readJsonFile(tenantFile, null);
  if (!config) throw new WorkStateError('TENANT_NOT_FOUND', `no tenant file at ${tenantFile}`);
  // #154 (ADR 0015): the owner-comment rule below rests on authorship, which a
  // tenant sharing one login between owner and fleet cannot supply.
  try { require('./identity').assertDistinctIdentity(config, tenant); } catch (error) {
    throw new WorkStateError(error.code, error.message);
  }
  return config;
}

// An approval is a comment from the tenant OWNER's login, never the fleet identity.
// Fail closed: a tenant without ownerLogin has no one who can approve, so it has no
// triage frontier either.
function ownerLoginOf(config) {
  const login = String(config.ownerLogin || '').trim();
  if (!login) throw new WorkStateError('TENANT_OWNER_UNSET', `tenant ${config.name || '?'} has no ownerLogin; approvals cannot be attributed`);
  return login;
}

// ---------------------------------------------------------------- ledger ----

function ledgerPath(root, tenant) {
  return path.join(baseOf(root), 'state', 'triage', `${tenant}.jsonl`);
}

function readLedger(root, tenant) {
  const file = ledgerPath(root, tenant);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try { entries.push(JSON.parse(lines[index])); } catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) break;   // torn final line, like the event ledger
      throw new WorkStateError('CORRUPT_TRIAGE_LEDGER', `invalid triage JSON in ${file} at line ${index + 1}`);
    }
  }
  return entries;
}

function appendEntry(root, tenant, entry) {
  const file = ledgerPath(root, tenant);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

function recordEntry({ root, tenant, kind, issue, bodyHash, commentUrl, model, by, edits, labels, through, recordId, actor, evidence, prUrl, premisesSha, reason, premise, fields, now } = {}) {
  if (!LEDGER_KINDS.includes(kind)) throw new WorkStateError('TRIAGE_INVALID', `kind must be one of ${LEDGER_KINDS.join(', ')}`);
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  const entry = { schemaVersion: 1, kind, tenant: requireText(tenant, 'tenant'), at, actor: actor ? String(actor) : 'principal' };
  if (kind === 'consumed') {
    entry.through = isoOrThrow(through, 'through');
    if (recordId) entry.recordId = String(recordId);
  } else {
    entry.issue = requireIssue(issue);
  }
  if (kind === 'proposed') {
    entry.bodyHash = requireText(bodyHash, 'body-hash');
    entry.commentUrl = requireText(commentUrl, 'comment-url');
    entry.model = requireText(model, 'model');
    if (recordId) entry.recordId = String(recordId);
    // Spec fleet #92 (#145): the sha the Principal re-read every cited premise at.
    if (premisesSha !== undefined && premisesSha !== null) {
      const sha = String(premisesSha).trim().toLowerCase();
      if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new WorkStateError('TRIAGE_INVALID', `--premises-sha must be 7 to 40 hex characters, got "${premisesSha}"`);
      entry.premisesSha = sha;
    }
  }
  if (kind === 'approved' || kind === 'approved-with-edits' || kind === 'rejected') {
    entry.by = requireText(by, 'by');
    if (commentUrl) entry.commentUrl = String(commentUrl);
    if (kind === 'approved-with-edits') entry.edits = requireText(edits, 'edits');
  }
  if (kind === 'superseded') entry.bodyHash = requireText(bodyHash, 'body-hash');
  if (kind === 'bounded-ready') {
    entry.bodyHash = requireText(bodyHash, 'body-hash');
    if (commentUrl) entry.commentUrl = String(commentUrl);
  }
  if (kind === 'veto') {
    entry.by = requireText(by, 'by');
    if (commentUrl) entry.commentUrl = String(commentUrl);
  }
  // `fields` is the door's own detail (scope, tier, cause...); it never overrides a core key.
  if (fields && BOUNDED_KINDS.includes(kind)) for (const [key, value] of Object.entries(fields)) if (!(key in entry)) entry[key] = value;
  if (kind === 'finalized') {
    const applied = String(labels || '').split(',').map((label) => label.trim()).filter(Boolean);
    entry.labels = applied;
    // fleet#49: a ruling that opened a docs PR (ADR or glossary text) names it here. The
    // lead reviews only branchPrefix PRs and pr-watch tracks only Work records, so the
    // digest is where the PR stays visible until Cory merges it (the merge is Cory's).
    if (prUrl) entry.prUrl = String(prUrl);
    // Spec fleet #92 (#145): a finalize that restated a false premise edited the
    // body; the restated body's hash is what the lead's manifest will pin.
    if (bodyHash) entry.bodyHash = String(bodyHash);
  }
  // Spec fleet #92 (#148): a proposal caused by a stale premise says so, with the
  // premise line, so its verdict can be counted before ADR 0011 is revisited.
  if (reason !== undefined || premise !== undefined) {
    if (kind !== 'proposed') throw new WorkStateError('TRIAGE_INVALID', '--reason and --premise belong to a proposal (--kind proposed)');
    if (!PROPOSAL_REASONS.includes(reason)) throw new WorkStateError('TRIAGE_INVALID', `--reason must be one of ${PROPOSAL_REASONS.join(', ')}${reason === undefined ? ' (--premise needs --reason stale-premise)' : ''}`);
    entry.reason = reason;
    entry.premise = requireText(premise, '--premise');
  }
  if (evidence) entry.evidence = String(evidence);
  const entries = readLedger(root, tenant);
  if (kind === 'proposed') {
    const open = projectTriage({ entries, now: at }).byIssue[entry.issue];
    if (open && open.proposed && !open.outcome) throw new WorkStateError('TRIAGE_PROPOSAL_OPEN', `issue #${entry.issue} already has an open proposal at ${open.proposed.at}; record its outcome first`);
  } else if (kind !== 'consumed' && kind !== 'suspended') {
    const open = projectTriage({ entries, now: at }).byIssue[entry.issue];
    if (!open || !open.proposed) throw new WorkStateError('TRIAGE_NO_PROPOSAL', `issue #${entry.issue} has no proposal to ${kind}`);
    // #207: the outcome row is a first-writer-wins claim (the finalize script and the Principal both take it before posting a Ruling).
    if ((OUTCOME_KINDS.includes(kind) || kind === 'bounded-ready') && open.outcome) throw new WorkStateError('TRIAGE_ALREADY_DECIDED', `issue #${entry.issue} already has outcome ${open.outcome.kind} at ${open.outcome.at} by ${open.outcome.actor || 'principal'}`, { decidedBy: open.outcome.actor || 'principal' });
    if (kind === 'veto' && !(open.outcome && open.outcome.kind === 'bounded-ready')) throw new WorkStateError('TRIAGE_NO_BOUNDED_READY', `issue #${entry.issue} has no standing bounded ready to veto`);
    if (kind === 'finalized' && !open.outcome) throw new WorkStateError('TRIAGE_NOT_APPROVED', `issue #${entry.issue} has no approval to finalize`);
  }
  appendEntry(root, tenant, entry);
  if (entry.reason === 'stale-premise') armStalePremiseNotice(root, entry);
  return entry;
}

// ------------------------------------------------ stale-premise notice ----
// Spec fleet #92 (#148): the first stale-premise restatement arms a dated notice
// that pages once, 30 days later, asking Cory to rule whether such restatements
// may skip Approval (ADR 0011), with the tally so far. The file is created once
// (wx) and marked fired only on a delivered page, so a replay never pages twice.

const STALE_NOTICE_DAYS = 30;
const PROPOSAL_REASONS = Object.freeze(['stale-premise']);

function staleNoticePath(root) {
  return path.join(baseOf(root), 'state', 'triage', 'stale-premise-notice.json');
}

function armStalePremiseNotice(root, entry) {
  const file = staleNoticePath(root);
  if (fs.existsSync(file)) return false;
  const dueAt = new Date(new Date(entry.at).getTime() + STALE_NOTICE_DAYS * 86400000).toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, armedAt: entry.at, dueAt, tenant: entry.tenant, issue: entry.issue, firedAt: null }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

function stalePremiseTally(root, since) {
  const dir = path.join(baseOf(root), 'state', 'triage');
  const counts = { approved: 0, 'approved-with-edits': 0, rejected: 0, superseded: 0, pending: 0 };
  const tenants = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -6)).sort() : [];
  for (const tenant of tenants) {
    for (const row of staleRows(readLedger(root, tenant))) {
      if (String(row.proposedAt) >= String(since)) counts[row.verdict] += 1;
    }
  }
  return counts;
}

function runStalePremiseNotice({ root, now, send, dryRun = false } = {}) {
  const file = staleNoticePath(root);
  const notice = readJsonFile(file, null);
  if (!notice) return { armed: false, due: false, sent: false };
  if (notice.firedAt) return { armed: true, due: true, sent: false, firedAt: notice.firedAt };
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  if (at < notice.dueAt) return { armed: true, due: false, sent: false, dueAt: notice.dueAt };
  const counts = stalePremiseTally(root, notice.armedAt);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const message = {
    kind: 'dated', priority: 'normal', title: 'Fleet: rule on stale-premise restatements',
    body: `${STALE_NOTICE_DAYS} days are up: rule whether stale-premise restatements may skip Approval (ADR 0011, spec fleet #92). ${total} stale-premise restatement(s) since ${String(notice.armedAt).slice(0, 10)}: ${counts.approved} approved, ${counts['approved-with-edits']} approved with edits, ${counts.rejected} rejected, ${counts.pending} pending${counts.superseded ? `, ${counts.superseded} superseded` : ''}. The rows are in the digest's Triage section.`,
  };
  if (dryRun) return { armed: true, due: true, sent: false, dryRun: true, message };
  let result;
  try { result = send(message); } catch (error) { result = { ok: false, detail: `send threw: ${String(error.message || error).slice(0, 200)}` }; }
  if (!result || !result.ok) return { armed: true, due: true, sent: false, attempted: true, detail: (result && result.detail) || null };
  const fired = { ...notice, firedAt: at, tally: counts };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(fired, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return { armed: true, due: true, sent: true, attempted: true, firedAt: at, tally: counts };
}

// One row per stale-premise proposal: the premise, when it was proposed, and
// the verdict it got (the outcome that followed it, or pending).
function staleRows(entries) {
  const sorted = [...entries].filter((entry) => entry && entry.kind && entry.kind !== 'consumed').sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const rows = [];
  const open = new Map();
  for (const entry of sorted) {
    const issue = Number(entry.issue);
    if (entry.kind === 'proposed') {
      open.delete(issue);
      if (entry.reason === 'stale-premise') { const row = { issue, premise: entry.premise, proposedAt: entry.at, verdict: 'pending' }; rows.push(row); open.set(issue, row); }
    } else if (OUTCOME_KINDS.includes(entry.kind) && open.has(issue)) {
      open.get(issue).verdict = entry.kind;
      open.delete(issue);
    }
  }
  return rows;
}

// ------------------------------------------------------------ projection ----

function projectTriage({ entries = [], now, windowDays, graduation } = {}) {
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  const window = Number(windowDays) > 0 ? Number(windowDays) : DEFAULT_CONFIG.windowDays;
  const rule = { ...DEFAULT_CONFIG.graduation, ...(graduation || {}) };
  const sorted = [...entries].filter((entry) => entry && entry.kind).sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const byIssue = {};
  let consumedThrough = null;
  let firstProposedAt = null;
  const outcomes = [];
  for (const entry of sorted) {
    if (entry.kind === 'consumed') {
      if (!consumedThrough || String(entry.through) > consumedThrough) consumedThrough = String(entry.through);
      continue;
    }
    const issue = Number(entry.issue);
    if (!byIssue[issue]) byIssue[issue] = { issue, proposed: null, outcome: null, finalized: null, history: [] };
    const row = byIssue[issue];
    row.history.push(entry);
    if (entry.kind === 'proposed') { row.proposed = entry; row.outcome = null; row.finalized = null; if (!firstProposedAt) firstProposedAt = entry.at; }
    else if (OUTCOME_KINDS.includes(entry.kind)) { if (row.proposed && !row.outcome) { row.outcome = entry; outcomes.push(entry); } }
    // Spec fleet #193: a bounded ready routes the proposal without an Approval, so it is
    // the row's outcome but never one of `outcomes`, which is what the ratio tallies; a veto
    // takes it back and the proposal is awaiting Approval again.
    else if (entry.kind === 'bounded-ready') { if (row.proposed && !row.outcome) row.outcome = entry; }
    else if (entry.kind === 'veto') { if (row.outcome && row.outcome.kind === 'bounded-ready') { row.outcome = null; row.finalized = null; } }
    else if (entry.kind === 'finalized') { if (row.outcome) row.finalized = entry; }
  }
  const rows = Object.values(byIssue).sort((left, right) => left.issue - right.issue);
  const pending = rows.filter((row) => row.proposed && !row.outcome).map((row) => ({ issue: row.issue, since: row.proposed.at, commentUrl: row.proposed.commentUrl, model: row.proposed.model }));
  const awaitingFinalize = rows.filter((row) => row.outcome && ['approved', 'approved-with-edits'].includes(row.outcome.kind) && !row.finalized).map((row) => ({ issue: row.issue, outcome: row.outcome.kind, since: row.outcome.at }));
  // Spec fleet #92 (#145): proposed at one hash, finalized at another. The finalize
  // edit is expected (a restated premise), not "body changed since the proposal".
  const restated = rows.filter((row) => row.finalized && row.finalized.bodyHash && row.proposed && row.finalized.bodyHash !== row.proposed.bodyHash).map((row) => ({ issue: row.issue, proposedBodyHash: row.proposed.bodyHash, finalizedBodyHash: row.finalized.bodyHash, finalizedAt: row.finalized.at }));
  const cutoff = new Date(new Date(at).getTime() - window * 86400000).toISOString();
  // fleet#49: docs PRs the Principal opened while finalizing, within the window; Cory merges them.
  const docsPrs = rows.filter((row) => row.finalized && row.finalized.prUrl && String(row.finalized.at) >= cutoff).map((row) => ({ issue: row.issue, prUrl: row.finalized.prUrl, since: row.finalized.at }));
  const tally = (list) => {
    const counts = { unchanged: 0, withEdits: 0, rejected: 0, superseded: 0, decided: 0 };
    for (const entry of list) {
      if (entry.kind === 'approved') counts.unchanged += 1;
      else if (entry.kind === 'approved-with-edits') counts.withEdits += 1;
      else if (entry.kind === 'rejected') counts.rejected += 1;
      else if (entry.kind === 'superseded') counts.superseded += 1;
    }
    counts.decided = counts.unchanged + counts.withEdits + counts.rejected;   // a superseded proposal was never judged
    counts.unchangedRatio = counts.decided ? Number((counts.unchanged / counts.decided).toFixed(3)) : null;
    return counts;
  };
  const windowStats = tally(outcomes.filter((entry) => String(entry.at) >= cutoff));
  // Spec fleet #92 (#148): the stale-premise restatements of the trailing 30 days.
  const staleCutoff = new Date(new Date(at).getTime() - STALE_NOTICE_DAYS * 86400000).toISOString();
  const staleCounts = { approved: 0, 'approved-with-edits': 0, rejected: 0, superseded: 0, pending: 0 };
  const staleWindow = staleRows(sorted).filter((row) => String(row.proposedAt) >= staleCutoff).map((row) => {
    staleCounts[row.verdict] += 1;
    return { ...row, ageDays: Number(((new Date(at).getTime() - new Date(row.proposedAt).getTime()) / 86400000).toFixed(1)) };
  });
  const allTime = tally(outcomes);
  const spanDays = firstProposedAt ? (new Date(at).getTime() - new Date(firstProposedAt).getTime()) / 86400000 : 0;
  const graduationState = {
    minProposals: rule.minProposals, minDays: rule.minDays, minUnchangedRatio: rule.minUnchangedRatio,
    decided: allTime.decided, spanDays: Number(spanDays.toFixed(1)), unchangedRatio: allTime.unchangedRatio,
    met: allTime.decided >= rule.minProposals && spanDays >= rule.minDays && allTime.unchangedRatio !== null && allTime.unchangedRatio >= rule.minUnchangedRatio,
  };
  return { at, windowDays: window, byIssue, pending, awaitingFinalize, restated, stalePremise: { days: STALE_NOTICE_DAYS, rows: staleWindow, counts: staleCounts }, docsPrs, window: windowStats, allTime, graduation: graduationState, consumedThrough, proposalsTotal: rows.filter((row) => row.proposed).length };
}

// --------------------------------------------------------------- GitHub ----

function normalizeLabels(labels) {
  const values = Array.isArray(labels) ? labels : labels?.nodes || [];
  return values.map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean).map(String);
}

function normalizeLogins(values) {
  const list = Array.isArray(values) ? values : values?.nodes || [];
  return list.map((value) => typeof value === 'string' ? value : value?.login || value?.name).filter(Boolean).map(String);
}

function normalizeComments(comments) {
  const values = Array.isArray(comments) ? comments : comments?.nodes || [];
  return values.map((comment) => ({
    id: String(comment.id || ''),
    url: String(comment.url || ''),
    createdAt: String(comment.createdAt || ''),
    lastEditedAt: String(comment.lastEditedAt || ''),
    author: String(typeof comment.author === 'string' ? comment.author : comment.author?.login || ''),
    body: String(comment.body || ''),
  })).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function normalizeIssue(issue) {
  const subIssues = Array.isArray(issue.subIssues) ? issue.subIssues : issue.subIssues?.nodes || [];
  const openSubIssues = subIssues.filter((sub) => String(sub.state || '').toUpperCase() !== 'CLOSED').length + (issue.subIssues?.pageInfo?.hasNextPage ? 1 : 0);
  return {
    number: Number(issue.number),
    title: String(issue.title || ''),
    url: String(issue.url || ''),
    body: String(issue.body || ''),
    bodyHash: issue.bodyHash ? String(issue.bodyHash) : sha256(issue.body || ''),
    createdAt: String(issue.createdAt || ''),
    lastEditedAt: String(issue.lastEditedAt || issue.createdAt || ''),
    author: String(typeof issue.author === 'string' ? issue.author : issue.author?.login || ''),
    labels: normalizeLabels(issue.labels),
    assignees: normalizeLogins(issue.assignees),
    openSubIssues,
    comments: normalizeComments(issue.comments),
    commentsTruncated: Boolean(issue.commentsTruncated || issue.comments?.pageInfo?.hasPreviousPage),
    // Spec fleet #193 (M4): GitHub's own blocked-by edges. The bounded door refuses an OPEN one; a
    // truncated list counts as one, since an edge it did not see may be open.
    blockedBy: (Array.isArray(issue.blockedBy) ? issue.blockedBy : issue.blockedBy?.nodes || []).map((node) => ({ number: Number(node.number), state: String(node.state || 'OPEN').toUpperCase() })),
    blockedByTruncated: Boolean(issue.blockedByTruncated || issue.blockedBy?.pageInfo?.hasNextPage),
  };
}

const ISSUE_QUERY = 'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number,title,url,body,createdAt,lastEditedAt,author{login},labels(first:20){nodes{name}},assignees(first:20){nodes{login}},subIssues(first:100){nodes{number,state} pageInfo{hasNextPage}},blockedBy(first:100){nodes{number,state} pageInfo{hasNextPage}},comments(last:100){nodes{id,url,body,createdAt,lastEditedAt,author{login}} pageInfo{hasPreviousPage}}} pageInfo{hasNextPage,endCursor}}}}';

function queryGithubIssues({ repo, executable = 'gh', runner = execFileSync } = {}) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new WorkStateError('INVALID_GITHUB_QUERY', `repo must be owner/name: ${repo}`);
  try {
    const nodes = [];
    let cursor = null;
    do {
      const queryArgs = ['api', 'graphql', '-f', `query=${ISSUE_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
      if (cursor) queryArgs.push('-f', `cursor=${cursor}`); else queryArgs.push('-F', 'cursor=null');
      const raw = runner(executable, queryArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 });
      const result = JSON.parse(raw);
      const page = result?.data?.repository?.issues;
      if (!Array.isArray(page?.nodes)) throw new Error('GitHub GraphQL issue query did not return nodes');
      nodes.push(...page.nodes);
      const next = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      if (page.pageInfo?.hasNextPage && !next) throw new Error('GitHub GraphQL issue query omitted its next cursor');
      if (next && next === cursor) throw new Error('GitHub GraphQL issue query repeated its cursor');
      cursor = next;
    } while (cursor);
    return nodes.map(normalizeIssue);
  } catch (error) {
    if (error instanceof WorkStateError) throw error;
    throw new WorkStateError('GITHUB_QUERY_FAILED', String(error.stderr || error.message || error));
  }
}

function readFixtureIssues(file) {
  const issues = readJsonFile(path.resolve(file), null);
  if (!Array.isArray(issues)) throw new WorkStateError('TRIAGE_INVALID', `fixture ${file} must hold an array of issues`);
  return issues.map(normalizeIssue);
}

// --------------------------------------------------------------- outbox ----

function readOutbox(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a torn line is not a wake */ }
  }
  return records;
}

function parseRecordIssue(recordId) {
  const match = /^([^:]+):issue-(\d+)$/.exec(String(recordId || ''));
  return match ? { tenant: match[1], issue: Number(match[2]) } : { tenant: null, issue: null };
}

// ------------------------------------------------------------- held sets ----

function readHeldIssues(root, tenant, now) {
  const held = new Map();
  try {
    const skip = readJsonFile(path.join(baseOf(root), 'state', 'skip', `${tenant}.json`), null);
    if (skip && skip.issues) for (const [number, reason] of Object.entries(skip.issues)) held.set(Number(number), `skip file: ${reason}`);
  } catch { /* an unreadable skip file holds nothing; exclusions below are the structured record */ }
  try {
    const { activeExclusions } = require('./exclusions');
    for (const entry of activeExclusions({ root, tenant, now }) || []) held.set(Number(entry.issue), `frontier exclusion ${entry.id}`);
  } catch { /* no exclusions ledger or module: nothing held there */ }
  return held;
}

// ------------------------------------------------------------- frontier ----

function selectTriageFrontier({ issues = [], ownerLogin, fleetIdentity = null, readyLabel = 'ready-for-agent', config = DEFAULT_CONFIG, entries = [], outbox = [], held = new Map(), tenant, now, escalationLabel = null, workIssues = null } = {}) {
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  const owner = requireText(ownerLogin, 'ownerLogin');
  // #154: authorship decides only when the owner and the fleet are two logins.
  const authorshipDecides = Boolean(fleetIdentity) && String(fleetIdentity).toLowerCase() !== owner.toLowerCase();
  const routing = new Set([readyLabel, ...config.routingLabels]);
  const triageLabels = new Set(config.triageLabels);
  const marker = config.markerLabel;
  const projection = projectTriage({ entries, now: at, windowDays: config.windowDays, graduation: config.graduation });
  const approvals = [];
  const vetoes = [];
  const repairs = [];
  const tickets = [];
  const skipped = [];

  const normalized = issues.map((raw) => raw.number !== undefined && raw.comments && Array.isArray(raw.labels) && raw.bodyHash ? raw : normalizeIssue(raw)).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.number - right.number);
  const issueByNumber = new Map(normalized.map((issue) => [Number(issue.number), issue]));
  for (const issue of normalized) {
    const labels = new Set(issue.labels);
    const row = projection.byIssue[issue.number] || null;
    const proposed = row && row.proposed && !row.outcome ? row.proposed : null;
    const ownerComments = issue.comments.filter((comment) => comment.author === owner);
    const newest = issue.comments[issue.comments.length - 1] || null;

    // 0. (#210) A standing bounded ready with the owner's Veto after it: withdraw the ready.
    const standing = row && row.outcome && row.outcome.kind === 'bounded-ready' ? row.outcome : null;
    if (standing) {
      const veto = ownerComments.filter((comment) => Date.parse(comment.createdAt) > Date.parse(standing.at) && VETO_RE.test(comment.body)).pop();
      if (veto) {
        vetoes.push({ kind: 'veto', number: issue.number, title: issue.title, url: issue.url, commentUrl: veto.url, at: veto.createdAt, by: veto.author, readyAt: standing.at, reason: 'owner Veto newer than the bounded ready' });
        continue;
      }
    }

    // 0. #207: an outcome (any actor's) with no finalized row is an unfinished claim. The finalize
    // script finishes its own on its next run; past CLAIM_EXPIRY_MINUTES it returns here for the
    // Principal, who resumes at step 1 of Approval and finalizing (a Ruling only if none is newer
    // than the approval). A Principal's claim counts only while the marker stands, so an issue ruled
    // by hand and never given a finalized row does not come back forever.
    if (row && row.outcome && ['approved', 'approved-with-edits'].includes(row.outcome.kind) && !row.finalized
      && (row.outcome.actor === FINALIZE_ACTOR || labels.has(marker))
      && new Date(at).getTime() - new Date(row.outcome.at).getTime() > CLAIM_EXPIRY_MINUTES * 60000) {
      const who = row.outcome.actor === FINALIZE_ACTOR ? 'finalize-script' : (row.outcome.actor || 'principal');
      approvals.push({ kind: 'approval', number: issue.number, title: issue.title, url: issue.url, commentUrl: row.outcome.commentUrl || null, at: row.outcome.at, withEdits: row.outcome.kind === 'approved-with-edits', edits: row.outcome.edits || null, by: row.outcome.by || owner, reason: `${who} claim older than ${CLAIM_EXPIRY_MINUTES} minutes without a finalized row` });
      continue;
    }

    // 0b. (#210, ruling m2) A standing bounded ready whose ready label is missing and that the owner
    // has not spoken on since: the label edit after the ledger row failed. Re-running
    // `bounded-ready --issue <n>` re-applies the label, records nothing and pages nothing.
    if (standing && !repairBlockers({ standing, issue, entries, owner, readyLabel, config, escalationLabel, held, workIssues }).length) {
      repairs.push({ kind: 'bounded-repair', number: issue.number, title: issue.title, url: issue.url, createdAt: issue.createdAt, readyAt: standing.at, reason: `bounded ready recorded at ${standing.at}, but ${readyLabel} is not on the issue` });
      continue;
    }

    // 1. An open proposal with the owner's Approved comment after it: finalize first.
    if (proposed) {
      const approval = ownerComments.filter((comment) => comment.createdAt > approvalFloor(row) && APPROVAL_RE.test(comment.body)).pop();
      if (approval) {
        approvals.push({ kind: 'approval', number: issue.number, title: issue.title, url: issue.url, commentUrl: approval.url, at: approval.createdAt, withEdits: !isExactApproval(approval.body), by: approval.author, reason: 'owner approval newer than the proposal' });
        continue;
      }
    }

    const hasTriageLabel = [...labels].some((label) => triageLabels.has(label));
    const isRouted = [...labels].some((label) => routing.has(label));
    if (isRouted) { skipped.push({ number: issue.number, reason: `routed (${[...labels].filter((label) => routing.has(label)).join(', ')})` }); continue; }

    // 2. Marker present: re-propose only on a body change or the owner's ask; otherwise it is waiting.
    const ownerAsksAgain = newest && newest.author === owner && REPROPOSE_RE.test(newest.body) && (!proposed || newest.createdAt > proposed.at);
    if (labels.has(marker)) {
      if (!row || !row.proposed) { skipped.push({ number: issue.number, reason: 'marker present with no ledger record; leave it to a human' }); continue; }
      if (proposed && issue.bodyHash !== proposed.bodyHash) { tickets.push({ kind: 'reproposal', number: issue.number, title: issue.title, url: issue.url, createdAt: issue.createdAt, bodyHash: issue.bodyHash, reason: 'body changed since the proposal' }); continue; }
      if (ownerAsksAgain) { tickets.push({ kind: 'reproposal', number: issue.number, title: issue.title, url: issue.url, createdAt: issue.createdAt, bodyHash: issue.bodyHash, reason: 'owner asked for a new proposal' }); continue; }
      skipped.push({ number: issue.number, reason: proposed ? `proposed ${proposed.at}, awaiting approval` : `outcome ${row.outcome.kind} recorded, marker not yet removed` });
      continue;
    }

    // 3. A fresh candidate: unrouted or carrying a triage label.
    if (!hasTriageLabel && labels.size > 0 && [...labels].every((label) => routing.has(label) || label === marker)) { skipped.push({ number: issue.number, reason: 'routed' }); continue; }
    if (issue.openSubIssues > 0) { skipped.push({ number: issue.number, reason: 'spec parent (open sub-issues); cutting is the owner\'s' }); continue; }
    if (issue.assignees.includes(owner)) { skipped.push({ number: issue.number, reason: 'assigned to the owner' }); continue; }
    if (held.has(issue.number)) { skipped.push({ number: issue.number, reason: `held (${held.get(issue.number)})` }); continue; }
    // #154 (ADR 0015): with the Fleet identity split from the owner's, the owner
    // having the newest comment means Cory is in conversation on it, and a fleet
    // session's cross-link comment no longer looks like him. A tenant that still
    // shares one login (refused by the loader since #154) never reaches this rule.
    if (authorshipDecides && newest && newest.author === owner) { skipped.push({ number: issue.number, reason: 'owner has the newest comment; a conversation, not a triage item' }); continue; }
    // fleet#55: before #154 there was no "owner has the newest comment" rule. Every fleet
    // session's comment carries the owner login, so that test dropped two
    // freshly filed companion tickets on the lead's own cross-links, with no
    // event that could ever put them back. With one login shared, nothing could
    // infer the owner's involvement from authorship; since #154 the rule above
    // does, and an Approval and a re-proposal ask still also carry a shape no
    // fleet role may write (the guard hook), a second lock beside the login.
    tickets.push({ kind: 'ticket', number: issue.number, title: issue.title, url: issue.url, createdAt: issue.createdAt, bodyHash: issue.bodyHash, reason: hasTriageLabel ? `labelled ${[...labels].filter((label) => triageLabels.has(label)).join(', ')}` : 'unrouted' });
  }

  // 4. decision-needed wakes newer than the consumed-up-to marker, newest per record.
  const escalations = new Map();
  for (const record of outbox) {
    if (!record || record.wake !== 'decision-needed' || !record.at) continue;
    const parsed = parseRecordIssue(record.recordId);
    if (tenant && parsed.tenant !== String(tenant)) continue;
    if (projection.consumedThrough && String(record.at) <= projection.consumedThrough) continue;
    const previous = escalations.get(record.recordId);
    // fleet#48: an escalation carries the issue's own bodyHash, title and url (null when
    // the issue is closed or absent) so the Principal copies the hash into
    // `record --kind proposed` instead of hashing the body by hand and mismatching.
    const issue = issueByNumber.get(Number(parsed.issue)) || null;
    if (!previous || String(record.at) > String(previous.at)) escalations.set(record.recordId, { kind: 'escalation', recordId: String(record.recordId), number: parsed.issue, at: String(record.at), evidence: String(record.evidence || ''), escalationReason: record.reason ? String(record.reason) : null, premise: record.premise ? String(record.premise) : null, bodyHash: issue ? issue.bodyHash : null, title: issue ? issue.title : null, url: issue ? issue.url : null, reason: 'decision-needed wake newer than the consumed marker' });
  }

  // Spec fleet #92 (#143): the backfill census. Open issues carrying the ready
  // label whose body has no `## Premises`, and those whose section does not parse.
  const premises = { readyLabel, ready: 0, missing: [], malformed: [] };
  for (const issue of normalized) {
    if (!issue.labels.includes(readyLabel)) continue;
    premises.ready += 1;
    const read = readPremises(issue.body);
    if (read.premisesError) premises.malformed.push(issue.number);
    else if (read.premises === null) premises.missing.push(issue.number);
  }

  approvals.sort((left, right) => left.at.localeCompare(right.at));
  vetoes.sort((left, right) => left.at.localeCompare(right.at));
  const escalationList = [...escalations.values()].sort((left, right) => left.at.localeCompare(right.at));
  const proposeNow = tickets.slice(0, config.maxProposalsPerTurn).map((ticket) => ticket.number);
  return {
    at, ownerLogin: owner, cap: config.maxProposalsPerTurn, consumedThrough: projection.consumedThrough,
    eligible: [...vetoes, ...repairs, ...approvals, ...escalationList, ...tickets],
    proposeNow,
    skipped,
    premises,
    counts: { issues: issues.length, eligible: vetoes.length + repairs.length + approvals.length + escalationList.length + tickets.length, approvals: approvals.length, escalations: escalationList.length, tickets: tickets.length, vetoes: vetoes.length, repairs: repairs.length },
  };
}

// #233: `issues` is an already-read (and, after a finalize, patched) open-issue set: the tick reads GitHub once
// and hands the same read to the finalize and the frontier. Standalone callers pass none and it is read here.
function computeFrontier({ root, tenant, tenantConfigPath, fixture, outboxPath, now, runner, issues: given = null } = {}) {
  const config = readTriageConfig(root);
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  const ownerLogin = ownerLoginOf(tenantConfig);
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  const issues = given || (fixture ? readFixtureIssues(fixture) : queryGithubIssues({ repo: tenantConfig.github, runner: runner || execFileSync }));
  const outbox = readOutbox(outboxPath ? path.resolve(outboxPath) : path.join(baseOf(root), 'state', 'watch', 'wake-outbox.jsonl'));
  const entries = readLedger(root, tenant);
  const held = readHeldIssues(root, tenant, at);
  const frontier = selectTriageFrontier({ issues, ownerLogin, fleetIdentity: tenantConfig.fleetIdentity || null, readyLabel: tenantConfig.readyLabel || 'ready-for-agent', config, entries, outbox, held, tenant, now: at, escalationLabel: tenantConfig.escalationLabel || null, workIssues: activeWorkIssues(root, tenant) });
  return { tenant: String(tenant), source: fixture ? 'fixture' : 'github', ...frontier };
}

// Spec fleet #92 (#145): the live body hash of one issue, hashed exactly as the
// frontier and the assignment manifest hash it, for `record --kind finalized
// --body-hash` after a finalize edited the body. Never hash a body by hand (fleet#48).
function issueBodyHash({ root, tenant, tenantConfigPath, issue, fixture, runner = execFileSync } = {}) {
  const number = requireIssue(issue);
  let body;
  if (fixture) {
    const found = readFixtureIssues(fixture).find((entry) => entry.number === number);
    if (!found) throw new WorkStateError('TRIAGE_INVALID', `issue #${number} is not in the fixture ${fixture}`);
    body = found.body;
  } else {
    const repo = readTenantConfig(root, tenant, tenantConfigPath).github;
    try {
      body = JSON.parse(runner('gh', ['issue', 'view', String(number), '-R', String(repo), '--json', 'body'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 })).body;
    } catch (error) {
      throw new WorkStateError('GITHUB_QUERY_FAILED', String(error.stderr || error.message || error));
    }
  }
  return { tenant: String(tenant), issue: number, bodyHash: sha256(body || '') };
}

// Spec fleet #193 (m4): an Approval counts only when newer than the proposal AND newer than the
// newest `veto` row of the issue. A Veto puts a proposal back to awaiting Approval, so an
// `Approved` that came before it (said of the bounded ready, or of the proposal it replaced)
// must not finalize what the owner then withdrew.
function approvalFloor(row) {
  const proposedAt = row && row.proposed ? String(row.proposed.at) : '';
  const veto = ((row && row.history) || []).filter((entry) => entry.kind === 'veto' && String(entry.at) >= proposedAt).reduce((newest, entry) => (String(entry.at) > newest ? String(entry.at) : newest), '');
  return veto > proposedAt ? veto : proposedAt;
}

// Spec fleet #193 (final QA, minor 6): ONE predicate for "this standing bounded ready may have its
// ready label re-applied". The frontier's bounded-repair item (an item exists only when this returns
// nothing) and the door's repair (bin/bounded-authority.js refuses on whatever it returns) both read it,
// so they cannot disagree. [{ code, detail }] in the order the checks bind: a newer proposal, a changed
// body, the ready label already on, a row that never paged Cory, an owner comment since (any case of
// the login), a barred label, a hold, a Work record.
function repairBlockers({ standing, issue, entries = [], owner, readyLabel, config = DEFAULT_CONFIG, escalationLabel = null, held = null, workIssues = null } = {}) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  if (entries.some((entry) => entry.kind === 'proposed' && Number(entry.issue) === issue.number && String(entry.at) > String(standing.at))) fail('bounded-once', `a newer proposal than the bounded ready at ${standing.at} exists; an issue is readied under Bounded authority once`);
  if (issue.bodyHash !== standing.bodyHash) fail('body-changed', `the issue body changed since the bounded ready at ${standing.at}`);
  if (issue.labels.includes(readyLabel)) fail('bounded-once', `issue #${issue.number} already has its bounded ready (${standing.at}) and carries ${readyLabel}`);
  if (standing.paged !== true) fail('unpaged-ready', `the bounded-ready row at ${standing.at} does not record that Cory was paged, so it is not repaired into a ready label`);
  const login = String(owner || '').toLowerCase();
  if (issue.comments.some((comment) => String(comment.author).toLowerCase() === login && Date.parse(comment.createdAt) > Date.parse(standing.at))) fail('owner-spoke', `${owner} commented after the bounded ready at ${standing.at}; the repair is left`);
  const barred = issue.labels.filter((label) => [...config.routingLabels, ...NEVER_FINALIZED_LABELS, escalationLabel].filter(Boolean).includes(label));
  if (barred.length) fail('labels', `issue #${issue.number} carries ${barred.join(', ')}, so the ready label is not re-applied`);
  const hold = heldIn(held, issue.number);
  if (hold) fail('held', hold);
  if (workIssues && workIssues.has(issue.number)) fail('live-work', `a Work record for issue #${issue.number} exists`);
  return failures;
}

// The issue numbers of a tenant's Work records (state/work/active.json), any state: what a bounded ready must not be made over.
function activeWorkIssues(root, tenant) {
  const file = path.join(baseOf(root), 'state', 'work', 'active.json');
  if (!fs.existsSync(file)) return new Set();
  const active = readJsonFile(file, {});
  const records = Array.isArray(active) ? active : Object.values((active && active.records) || active || {});
  const numbers = new Set();
  for (const record of records) {
    const parsed = record && parseRecordIssue(record.id);
    if (parsed && parsed.tenant === String(tenant)) numbers.add(parsed.issue);
  }
  return numbers;
}

// ------------------------------------------------------------- finalize ----
// #207 (spec #193, scope ruled 2026-09-29 after QA): an exact `Approved` from the owner
// turns a SELF-CONTAINED proposal into a Ruling and a ready ticket within one tick, with
// no Principal session. Self-contained means the proposal leaves the Principal nothing to
// fold in, edit, link or route by judgment; every clause below must hold, and a failing
// clause leaves the issue to the Principal with the clause name as its `reason` in `left`.
// No prose regex: every check is on a structured field, an exact word, a label or a ledger row.
//
//   1  ledger: an open proposal (proposed, no outcome, no standing bounded-ready row)
//   2  approval: the owner's newest approval-shaped comment after it is exactly `Approved`
//   3  no `## Ruling` and no owner comment newer than that approval
//   4  the proposal comment is the ledger's and the newest `## Triage proposal` before the approval
//   5  neither the proposal nor the approval comment was edited after the approval
//   6  the issue body hash is unchanged and the body has a `## Premises` heading
//   7  not an escalation ruling (fail closed, three independent checks)
//   8  proposal fields, each a whole FIELD (its line plus any continuation lines) that is
//      exactly the word: Classification bug|feature, Open for Cory none, Blocked_by none,
//      Tier haiku|sonnet; a Ruling field; and every premise line verified (none false)
//   9  labels: no routing or escalation label, `held` or `haiku-rehearsal`, and no hold;
//      the marker present
//   10 cap: at most FINALIZE_CAP new finalizes per run
//
// Clauses 1 and 4 to 9 are proposalGate(), one pure function the bounded-ready door
// (#209-#211) shares; 2, 3 and 10 belong to finalizeApprovals. A conversation between the
// proposal and the approval is ACCEPTED: the owner said `Approved` last, and clause 3
// refuses anything the owner said after it. A claim on an issue that is then closed before
// its finalized row is not chased (only open issues are read): the digest's "approved
// awaiting finalizing" count is its trace, and closing the issue was the owner's hand.

const PROPOSAL_HEADING_RE = /^\s*##\s*Triage proposal\b/i;
const RULING_HEADING_RE = /^\s*##\s*Ruling\b/i;
// `## Premises`, optionally `## Premises (...)`, on its own line (no newline inside the heading).
const PREMISES_HEADING_RE = /^[ \t]{0,3}##[ \t]+premises[ \t]*(?:\([^\n]*\))?[ \t]*#*[ \t]*\r?$/im;
// The verified-premise line as the Principal writes it (agents/principal.md, `Premises:`),
// matched after trimming the block's indent: `<path>: <claim> @<sha> verified @<sha>`, and
// nothing after the second sha.
const VERIFIED_PREMISE_RE = /^\S.*: .+ @[0-9a-f]{7,40} verified @[0-9a-f]{7,40}$/;
const FINALIZE_ACTOR = 'finalize-script';
const FINALIZE_CAP = 5;
const CLAIM_EXPIRY_MINUTES = 30;
const NEVER_FINALIZED_LABELS = Object.freeze(['held', 'haiku-rehearsal']);
const FIELD_KEY_RE = /^([A-Z][A-Za-z_ -]*?):[ \t]*(.*?)[ \t]*$/;   // the hyphen is for `Red-tell`

// The one proposal parser. A field is a `Name:` line at column 0; its value is the text after
// the colon plus every continuation line (indented, blank lines between them skipped), joined
// by newlines. A repeated name joins its values, so an exact-valued field stops being exact.
// `premises` is the trimmed continuation lines under a bare `Premises:` line, null for any
// other shape (`Premises: none stated`, a repeated block, no block).
function parseProposal(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const fields = {};
  let premises = null;
  let premisesSeen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const key = FIELD_KEY_RE.exec(lines[index]);
    if (!key) continue;
    const parts = key[2] ? [key[2]] : [];
    const continuation = [];
    for (;;) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && /^[ \t]+\S/.test(lines[next])) { continuation.push(lines[next].trim()); index = next; } else break;
    }
    const value = [...parts, ...continuation].join('\n');
    fields[key[1]] = Object.prototype.hasOwnProperty.call(fields, key[1]) ? `${fields[key[1]]}\n${value}` : value;
    if (key[1] === 'Premises') { premisesSeen += 1; premises = premisesSeen === 1 && !key[2] ? continuation : null; }
  }
  return { fields, premises };
}

// A field that must be exactly one word: the whole field, one trailing full stop allowed.
function exactField(parsed, name) {
  return Object.prototype.hasOwnProperty.call(parsed.fields, name) ? parsed.fields[name].replace(/\.$/, '') : null;
}

function proposalClassification(text) {
  return exactField(parseProposal(text), 'Classification');
}

// The Ruling: the proposal under its own heading (its first `## Triage proposal` line
// removed, otherwise verbatim, CRLF normalised), with the approval named above and the
// labels applied below.
function rulingBodyFor({ proposalBody, approvalUrl, labels, marker }) {
  const lines = String(proposalBody || '').replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first >= 0 && PROPOSAL_HEADING_RE.test(lines[first])) lines.splice(first, 1);
  const proposal = lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  const approved = approvalUrl ? `Approved without edits: ${approvalUrl}.` : 'Approved without edits.';
  return `## Ruling\n${approved} Finalized by script (fleet #207).\n\n${proposal}\n\nLabels: ${labels.join(', ')}; ${marker} removed.`;
}

// Clause 8: the codes of every proposal field that is not self-contained, in field order.
function proposalRefusals(text) {
  const parsed = parseProposal(text);
  const codes = [];
  const classification = exactField(parsed, 'Classification');
  if (classification !== 'bug' && classification !== 'feature') codes.push('classification');
  if (exactField(parsed, 'Open for Cory') !== 'none') codes.push('open-for-cory');
  if (exactField(parsed, 'Blocked_by') !== 'none') codes.push('blocked-by');
  const tier = exactField(parsed, 'Tier');
  if (tier !== 'haiku' && tier !== 'sonnet') codes.push('tier');
  if (!Object.prototype.hasOwnProperty.call(parsed.fields, 'Ruling')) codes.push('no-ruling-line');
  if (!parsed.premises || !parsed.premises.length || !parsed.premises.every((line) => !/ false:/.test(line) && VERIFIED_PREMISE_RE.test(line))) codes.push('premises');
  return codes;
}

// Clause 7, fail closed. An escalation ruling is one whose proposal carries a wake record
// id; or one a lead's `decision-needed` wake reached in the window before the proposal
// (after the issue's previous approved or finalized row, up to the proposal), consumed or
// not; or one whose wake is still past the consumed-up-to marker. The Principal not
// recording `--record-id` is why the second and third checks exist: the first is never the
// only one. A superseded or rejected proposal answered no wake, so it does not bound the window.
function escalationReason({ proposed, issueNumber, tenant, outbox, consumedThrough, history }) {
  if (proposed.recordId) return `proposal was recorded against wake ${proposed.recordId}`;
  const previous = history
    .filter((entry) => ['approved', 'approved-with-edits', 'finalized'].includes(entry.kind) && String(entry.at) < String(proposed.at))
    .reduce((newest, entry) => (String(entry.at) > newest ? String(entry.at) : newest), '');
  for (const record of outbox) {
    if (!record || record.wake !== 'decision-needed' || !record.at) continue;
    const parsed = parseRecordIssue(record.recordId);
    if (parsed.tenant !== String(tenant) || parsed.issue !== issueNumber) continue;
    const at = String(record.at);
    if (at > previous && at <= String(proposed.at)) return `decision-needed wake ${record.recordId} at ${at} preceded the proposal`;
    if (!consumedThrough || at > consumedThrough) return `decision-needed wake ${record.recordId} at ${at} is not consumed`;
  }
  return null;
}

function editedAfter(comment, moment) {
  return Boolean(comment.lastEditedAt) && String(comment.lastEditedAt) > String(moment);
}

function heldIn(holds, number) {
  if (!holds) return null;
  if (holds instanceof Map) return holds.has(number) ? String(holds.get(number)) : null;
  if (typeof holds.has === 'function') return holds.has(number) ? 'held' : null;
  return Array.isArray(holds) && holds.includes(number) ? 'held' : null;
}

// Clauses 1 and 4 to 9 as one pure predicate: [{ code, detail }] for every clause that fails,
// [] when the proposal is self-contained. `issue` is a normalized issue, `row` its projection
// row, `proposal` the ledger's proposal comment. `approval` (the owner's comment) anchors clauses
// 4 and 5; without one, the proposal must be the newest in the thread and never edited.
// `holds` (a Map, Set or array of issue numbers: skip-file and exclusion holds) is optional.
function proposalGate({ issue, row, proposal, approval = null, config = DEFAULT_CONFIG, tenantConfig = {}, tenant, outbox = [], consumedThrough = null, holds = null } = {}) {
  const failures = [];
  const fail = (code, detail) => failures.push(detail ? { code, detail } : { code });
  const proposed = row && row.proposed && !row.outcome ? row.proposed : null;
  if (!proposed) { fail('no-open-proposal', row && row.outcome ? `outcome ${row.outcome.kind} recorded` : 'no open proposal'); return failures; }
  const history = row.history || [];
  // A bounded-ready row stands until a later veto row (a vetoed proposal is back to awaiting Approval).
  const lastAt = (kind) => history.filter((entry) => entry.kind === kind && String(entry.at) >= String(proposed.at)).reduce((newest, entry) => (String(entry.at) > newest ? String(entry.at) : newest), '');
  if (lastAt('bounded-ready') && lastAt('bounded-ready') > lastAt('veto')) { fail('no-open-proposal', 'a bounded-ready row stands'); return failures; }
  const before = approval ? approval.createdAt : null;
  const headed = issue.comments.filter((comment) => PROPOSAL_HEADING_RE.test(comment.body) && (before === null || comment.createdAt < before));
  const newest = headed[headed.length - 1];   // clause 4
  const identified = Boolean(proposal) && Boolean(proposal.url) && proposal.url === proposed.commentUrl && PROPOSAL_HEADING_RE.test(proposal.body) && Boolean(newest) && newest.url === proposal.url;
  if (!identified) fail('stale-proposal', issue.commentsTruncated ? 'thread truncated' : undefined);
  if (identified) {   // clause 5
    const edited = approval ? editedAfter(proposal, approval.createdAt) || editedAfter(approval, approval.createdAt) : editedAfter(proposal, proposal.createdAt);
    if (edited) fail('edited-after-approval');
  }
  if (issue.bodyHash !== proposed.bodyHash) fail('body-changed');   // clause 6
  else if (!PREMISES_HEADING_RE.test(issue.body)) fail('no-premises-heading');
  const escalation = escalationReason({ proposed, issueNumber: issue.number, tenant: tenant || tenantConfig.name, outbox, consumedThrough, history });   // clause 7
  if (escalation) fail('escalation', escalation);
  if (identified) for (const code of proposalRefusals(proposal.body)) fail(code);   // clause 8
  const blocking = new Set([tenantConfig.readyLabel || 'ready-for-agent', ...config.routingLabels, ...NEVER_FINALIZED_LABELS, ...(tenantConfig.escalationLabel ? [tenantConfig.escalationLabel] : [])]);   // clause 9
  const labels = new Set(issue.labels);
  const blocked = [...labels].filter((label) => blocking.has(label));
  if (blocked.length) fail('labels', `carries ${blocked.join(', ')}`);
  else if (!labels.has(config.markerLabel)) fail('labels', `no ${config.markerLabel}`);
  const hold = heldIn(holds, issue.number);
  if (hold) fail('held', hold);
  return failures;
}

function ghIssueWriter({ repo, runner }) {
  const run = (args, input) => {
    try {
      runner('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 });
    } catch (error) {
      throw new WorkStateError('GITHUB_WRITE_FAILED', String(error.stderr || error.message || error).trim());
    }
  };
  return {
    comment(number, body) { run(['issue', 'comment', String(number), '-R', repo, '--body-file', '-'], body); },
    relabel(number, { add, remove }) {
      const args = ['issue', 'edit', String(number), '-R', repo];
      for (const label of add) args.push('--add-label', label);
      if (remove) args.push('--remove-label', remove);
      run(args);
    },
  };
}

// What a finalize write does to an issue's comments and labels, in one place: the fixture writer
// applies it to the fixture file, and applyFinalizeMutations (#233) to the tick's in-memory read,
// so the frontier computed after a finalize sees exactly what the writes did.
function appendFinalizeComment(target, { number, body, author, at }) {
  const comments = normalizeComments(target.comments);
  const id = `finalize-${number}-${comments.length + 1}`;
  comments.push({ id, url: `${target.url || ''}#issuecomment-${id}`, createdAt: at, author, body });
  target.comments = comments;
}

function relabelFinalize(target, { add, remove }) {
  const labels = normalizeLabels(target.labels).filter((label) => label !== remove);
  for (const label of add) if (!labels.includes(label)) labels.push(label);
  target.labels = labels;
}

// The fixture stands in for GitHub in tests and in the watchdog test: a finalize against
// it edits the fixture file, so the next frontier read sees what GitHub would show.
function fixtureIssueWriter({ file, author, at }) {
  const edit = (number, change) => {
    const issues = readJsonFile(path.resolve(file), null);
    const target = issues.find((entry) => Number(entry.number) === Number(number));
    if (!target) throw new WorkStateError('TRIAGE_INVALID', `issue #${number} is not in the fixture ${file}`);
    change(target);
    fs.writeFileSync(path.resolve(file), JSON.stringify(issues), 'utf8');
  };
  return {
    comment(number, body) { edit(number, (target) => appendFinalizeComment(target, { number, body, author, at })); },
    relabel(number, change) { edit(number, (target) => relabelFinalize(target, change)); },
  };
}

// Wraps a writer so each write that SUCCEEDED is also recorded in `mutations` (a write that throws is
// not: what GitHub refused must not reach the frontier).
function recordingWriter(writer, mutations) {
  return {
    comment(number, body) { writer.comment(number, body); mutations.push({ kind: 'comment', number, body }); },
    relabel(number, change) { writer.relabel(number, change); mutations.push({ kind: 'relabel', number, add: [...change.add], remove: change.remove || null }); },
  };
}

// Returns a copy of `issues` with the recorded finalize writes applied; the input is not touched.
function applyFinalizeMutations(issues, mutations, { author, at } = {}) {
  const patched = issues.map((issue) => ({ ...issue, labels: [...issue.labels], comments: issue.comments.map((comment) => ({ ...comment })) }));
  for (const mutation of mutations) {
    const target = patched.find((issue) => issue.number === Number(mutation.number));
    if (!target) continue;
    if (mutation.kind === 'comment') appendFinalizeComment(target, { number: mutation.number, body: mutation.body, author, at });
    else relabelFinalize(target, mutation);
  }
  return patched;
}

// `issues` (#233) is an already-read open-issue set and `mutations` an array that collects each write that
// succeeded; both are for triageTick. finalizeApprovals, the standalone command, passes neither.
function runFinalize({ root, tenant, tenantConfigPath, fixture, outboxPath, now, runner = execFileSync, issues: given = null, mutations = [] } = {}) {
  const config = readTriageConfig(root);
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  const owner = ownerLoginOf(tenantConfig);
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  // The ledger is read before GitHub, so a claim recorded while the issues load is what the
  // claim below collides with (TRIAGE_ALREADY_DECIDED), not something this run already saw.
  const entries = readLedger(root, tenant);
  const projection = projectTriage({ entries, now: at, windowDays: config.windowDays, graduation: config.graduation });
  const issues = given || (fixture ? readFixtureIssues(fixture) : queryGithubIssues({ repo: tenantConfig.github, runner }));
  const outbox = readOutbox(outboxPath ? path.resolve(outboxPath) : path.join(baseOf(root), 'state', 'watch', 'wake-outbox.jsonl'));
  const readyLabel = tenantConfig.readyLabel || 'ready-for-agent';
  const marker = config.markerLabel;
  const writer = recordingWriter(fixture
    ? fixtureIssueWriter({ file: fixture, author: tenantConfig.fleetIdentity || 'fleet', at })
    : ghIssueWriter({ repo: tenantConfig.github, runner }), mutations);
  const finalized = [];
  const left = [];
  const errors = [];
  const sorted = [...issues].sort((a, b) => a.number - b.number);

  // Steps b to d of the effect, all idempotent: the Ruling unless one newer than the approval
  // stands, the labels, then the finalized row. The claim (step a) is what made this run the owner of it.
  const complete = (issue, proposalComment, approvalUrl, approvalAt) => {
    const applied = proposalClassification(proposalComment.body) === 'bug' ? [readyLabel, 'bug'] : [readyLabel];
    const posted = issue.comments.some((comment) => comment.createdAt > approvalAt && RULING_HEADING_RE.test(comment.body));
    if (!posted) writer.comment(issue.number, rulingBodyFor({ proposalBody: proposalComment.body, approvalUrl, labels: applied, marker }));
    const have = new Set(issue.labels);
    if (applied.some((label) => !have.has(label)) || have.has(marker)) writer.relabel(issue.number, { add: applied.filter((label) => !have.has(label)), remove: have.has(marker) ? marker : null });
    recordEntry({ root, tenant, kind: 'finalized', issue: issue.number, labels: applied.join(','), actor: FINALIZE_ACTOR, now: at });
    finalized.push({ issue: issue.number, url: issue.url, commentUrl: approvalUrl, labels: applied });
  };

  // Recovery (section 5): a claim of ours with no finalized row is a run cut short. Finish it.
  for (const issue of sorted) {
    const row = projection.byIssue[issue.number] || null;
    if (!row || !row.proposed || !row.outcome || row.finalized) continue;
    if (row.outcome.kind !== 'approved' || row.outcome.actor !== FINALIZE_ACTOR) continue;
    try {
      const proposalComment = issue.comments.find((comment) => comment.url && comment.url === row.proposed.commentUrl);
      if (!proposalComment) { left.push({ issue: issue.number, reason: 'stale-proposal', detail: 'recovery: proposal comment not found' }); continue; }
      const approvalComment = issue.comments.find((comment) => comment.url && comment.url === row.outcome.commentUrl);
      complete(issue, proposalComment, row.outcome.commentUrl || '', approvalComment ? approvalComment.createdAt : row.outcome.at);
    } catch (error) {
      errors.push({ issue: issue.number, message: String(error.message || error) });
    }
  }

  let claims = 0;
  for (const issue of sorted) {
    const row = projection.byIssue[issue.number] || null;
    // Spec fleet #193: a standing bounded ready is a decision already taken; an Approval after it is left to the frontier's rules, never finalized here.
    if (row && row.proposed && row.outcome && row.outcome.kind === 'bounded-ready') {
      if (issue.comments.some((comment) => comment.author === owner && comment.createdAt > row.proposed.at && APPROVAL_RE.test(comment.body))) left.push({ issue: issue.number, reason: 'decided', detail: 'a bounded ready stands' });
      continue;
    }
    const proposed = row && row.proposed && !row.outcome ? row.proposed : null;
    if (!proposed) continue;
    // The same rule the frontier uses for "an approval": the owner's newest approval-shaped comment after the proposal.
    const approval = issue.comments.filter((comment) => comment.author === owner && comment.createdAt > approvalFloor(row) && APPROVAL_RE.test(comment.body)).pop();
    if (!approval) continue;
    const leave = (reason, detail) => left.push(detail ? { issue: issue.number, reason, detail } : { issue: issue.number, reason });

    if (!isExactApproval(approval.body)) { leave('not-exact-approval'); continue; }   // clause 2
    if (issue.comments.some((comment) => comment.createdAt > approval.createdAt && RULING_HEADING_RE.test(comment.body))) { leave('ruling-already-posted'); continue; }   // clause 3
    if (issue.comments.some((comment) => comment.author === owner && comment.createdAt > approval.createdAt)) { leave('owner-commented-after-approval'); continue; }
    const proposal = issue.comments.find((comment) => comment.url && comment.url === proposed.commentUrl);
    const failures = proposalGate({ issue, row, proposal, approval, config, tenantConfig, tenant, outbox, consumedThrough: projection.consumedThrough });   // clauses 1, 4-9
    if (failures.length) { leave(failures[0].code, failures[0].detail); continue; }
    if (claims >= FINALIZE_CAP) { leave('cap'); continue; }   // clause 10

    try {
      // a. CLAIM. The ledger's outcome row is a first-writer-wins claim (TRIAGE_ALREADY_DECIDED
      // for the second): the script claims before any GitHub write, and the Principal records its
      // own outcome before posting a Ruling by hand, so at most one of them posts. What stays is a
      // millisecond race between two reads of the ledger, accepted.
      try {
        recordEntry({ root, tenant, kind: 'approved', issue: issue.number, by: owner, commentUrl: approval.url, actor: FINALIZE_ACTOR, now: at });
      } catch (error) {
        if (error.code === 'TRIAGE_ALREADY_DECIDED') { leave(`claimed by ${error.decidedBy || 'another actor'}`); continue; }
        throw error;
      }
      claims += 1;
      complete(issue, proposal, approval.url, approval.createdAt);
    } catch (error) {
      errors.push({ issue: issue.number, message: String(error.message || error) });
    }
  }
  return { tenant: String(tenant), source: fixture ? 'fixture' : 'github', at, finalized, left, errors };
}

function finalizeApprovals(options = {}) {
  return runFinalize(options);
}

// #233: the watchdog's triage block in one process and ONE read of the tenant's open issues. The finalize
// runs over that read; the writes it made to GitHub are applied to it; the frontier is computed over the
// result, so it sees the marker gone and the ready label on (and no approval) exactly as a second read
// would have. A finalize that throws after the read is reported under finalize.error and the frontier
// still runs (over the read as the finalize's completed writes left it), as when the two were two commands.
// An unreadable GitHub or tenant throws: there is nothing to compute a frontier from.
function triageTick({ root, tenant, tenantConfigPath, fixture, outboxPath, now, runner = execFileSync, finalizeImpl = runFinalize } = {}) {
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  const read = fixture ? readFixtureIssues(fixture) : queryGithubIssues({ repo: tenantConfig.github, runner });
  const mutations = [];
  let finalize;
  try {
    finalize = finalizeImpl({ root, tenant, tenantConfigPath, fixture, outboxPath, now: at, runner, issues: read, mutations });
  } catch (error) {
    finalize = { error: String(error.message || error) };
  }
  const issues = applyFinalizeMutations(read, mutations, { author: tenantConfig.fleetIdentity || 'fleet', at });
  // The finalize's writes are already on GitHub and the ledger, so a frontier that throws here (local state
  // unreadable) must not take the finalize result with it: report it beside the finalize, exit 0, and the
  // caller records the finalize and treats the missing frontier as a frontier failure.
  try {
    return { tenant: String(tenant), finalize, frontier: computeFrontier({ root, tenant, tenantConfigPath, fixture, outboxPath, now: at, runner, issues }) };
  } catch (error) {
    return { tenant: String(tenant), finalize, frontierError: String(error.message || error) };
  }
}

// ------------------------------------------------------------------ CLI ----

const TRIAGE_FLAGS = Object.freeze({
  frontier: ['root', 'tenant', 'tenant-config', 'fixture', 'outbox', 'now'],
  record: ['root', 'tenant', 'kind', 'issue', 'body-hash', 'comment-url', 'model', 'by', 'edits', 'labels', 'through', 'record-id', 'actor', 'evidence', 'pr-url', 'premises-sha', 'reason', 'premise', 'now'],
  state: ['root', 'tenant', 'now', 'days'],
  hash: ['root', 'tenant', 'tenant-config', 'issue', 'fixture'],
  finalize: ['root', 'tenant', 'tenant-config', 'fixture', 'outbox', 'now'],
  // #233: finalize then frontier over one read of the issues; the flags are finalize's.
  tick: ['root', 'tenant', 'tenant-config', 'fixture', 'outbox', 'now'],
  // Spec fleet #193 (#210): the Bounded-authority doors (bin/bounded-authority.js).
  'bounded-ready': ['root', 'tenant', 'tenant-config', 'issue', 'fixture', 'now'],
  veto: ['root', 'tenant', 'tenant-config', 'issue', 'fixture', 'now'],
  'bounded-scan': ['root', 'tenant', 'tenant-config', 'fixture', 'now'],
});
const TRIAGE_USAGE = 'commands: frontier (--tenant [--fixture <issues.json>] [--outbox <jsonl>] [--now <iso>]), record (--tenant --kind proposed|approved|approved-with-edits|rejected|superseded|finalized|consumed ...), state (--tenant [--days n]), hash (--tenant --issue <n> [--fixture <issues.json>]), finalize (--tenant [--fixture <issues.json>] [--outbox <jsonl>] [--now <iso>]), tick (the flags of finalize: finalize then frontier over one read), bounded-ready (--tenant --issue <n> [--fixture <issues.json>] [--now <iso>]), veto (--tenant --issue <n> [--fixture <issues.json>] [--now <iso>]), bounded-scan (--tenant [--fixture <issues.json>] [--now <iso>])';

function cli(argv) {
  const [command, ...rest] = argv;
  const flags = TRIAGE_FLAGS[command];
  if (!flags) throw new WorkStateError('USAGE', TRIAGE_USAGE);
  const args = parseArgs(rest, flags);
  const tenant = requireText(args.tenant, '--tenant');
  if (command === 'frontier') return computeFrontier({ root: args.root, tenant, tenantConfigPath: args['tenant-config'], fixture: args.fixture, outboxPath: args.outbox, now: args.now });
  if ((command === 'bounded-scan' || command === 'bounded-ready' || command === 'veto') && args.now && !args.fixture) throw new WorkStateError('USAGE', `--now is for a fixture run only: the ledger's \`at\` and the Veto window are the wall clock in production (${command})`);
  if ((command === 'bounded-scan' || command === 'bounded-ready' || command === 'veto') && args.fixture && path.resolve(args.root || path.resolve(__dirname, '..')).toLowerCase() === path.resolve(__dirname, '..').toLowerCase()) throw new WorkStateError('USAGE', `--fixture is for a temp --root: on the fleet's own root a rehearsal would write state a live run acts on (${command})`);
  if (command === 'bounded-scan') return require('./bounded-authority').boundedScan({ root: args.root, tenant, tenantConfigPath: args['tenant-config'], fixture: args.fixture, now: args.now });
  if (command === 'bounded-ready' || command === 'veto') {
    const door = require('./bounded-authority');
    const options = { root: args.root, tenant, issue: args.issue, tenantConfigPath: args['tenant-config'], fixture: args.fixture, now: args.now, effects: !args.fixture };
    return command === 'veto' ? door.vetoReady(options) : door.boundedReady(options);
  }
  if (command === 'record') {
    if (args.now && Date.parse(args.now) > Date.now() + 5 * 60000) throw new WorkStateError('USAGE', 'record --now is in the future: the ledger\'s time is the wall clock, and a later time would put a proposal after the comments it should answer to');
    if (BOUNDED_KINDS.includes(args.kind)) throw new WorkStateError('USAGE', `record cannot write kind "${args.kind}"; it is written by its door (triage.js bounded-ready, veto, bounded-scan), which checks what it records`);
    return recordEntry({
      root: args.root, tenant, kind: args.kind, issue: args.issue, bodyHash: args['body-hash'], commentUrl: args['comment-url'], model: args.model,
      by: args.by, edits: args.edits, labels: args.labels, through: args.through, recordId: args['record-id'], actor: args.actor, evidence: args.evidence, prUrl: args['pr-url'], premisesSha: args['premises-sha'], reason: args.reason, premise: args.premise, now: args.now,
    });
  }
  if (command === 'tick') return triageTick({ root: args.root, tenant, tenantConfigPath: args['tenant-config'], fixture: args.fixture, outboxPath: args.outbox, now: args.now });
  if (command === 'finalize') return finalizeApprovals({ root: args.root, tenant, tenantConfigPath: args['tenant-config'], fixture: args.fixture, outboxPath: args.outbox, now: args.now });
  if (command === 'hash') return issueBodyHash({ root: args.root, tenant, tenantConfigPath: args['tenant-config'], issue: args.issue, fixture: args.fixture });
  const config = readTriageConfig(args.root);
  const projection = projectTriage({ entries: readLedger(args.root, tenant), now: args.now, windowDays: args.days ? Number(args.days) : config.windowDays, graduation: config.graduation });
  const { byIssue, ...summary } = projection;
  return { tenant, ...summary };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message })}\n`);
    // USAGE exits 2 (a refused invocation), everything else 1 (a failed one): a caller
    // reading only the status can never take a failure for an empty frontier.
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = {
  APPROVAL_RE,
  BOUNDED_KINDS,
  VERIFIED_PREMISE_RE,
  DEFAULT_CONFIG,
  LEDGER_KINDS,
  TRIAGE_FLAGS,
  cli,
  computeFrontier,
  exactField,
  finalizeApprovals,
  triageTick,
  applyFinalizeMutations,
  parseProposal,
  proposalGate,
  repairBlockers,
  activeWorkIssues,
  isExactApproval,
  issueBodyHash,
  ledgerPath,
  normalizeIssue,
  ownerLoginOf,
  projectTriage,
  queryGithubIssues,
  readFixtureIssues,
  readHeldIssues,
  readLedger,
  readOutbox,
  readTenantConfig,
  readTriageConfig,
  recordEntry,
  runStalePremiseNotice,
  staleNoticePath,
  selectTriageFrontier,
};
