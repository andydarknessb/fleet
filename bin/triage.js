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
const { sha256 } = require('./assignment');
const { readPremises } = require('./premises');

const DEFAULT_CONFIG = Object.freeze({
  markerLabel: 'triage-proposed',
  triageLabels: ['needs-triage', 'question'],
  routingLabels: ['ready-for-human', 'needs-info', 'wontfix', 'spec'],
  maxProposalsPerTurn: 5,
  windowDays: 14,
  graduation: { minProposals: 30, minDays: 14, minUnchangedRatio: 0.9 },
});

const LEDGER_KINDS = Object.freeze(['proposed', 'approved', 'approved-with-edits', 'rejected', 'superseded', 'finalized', 'consumed']);
const OUTCOME_KINDS = Object.freeze(['approved', 'approved-with-edits', 'rejected', 'superseded']);
const APPROVAL_RE = /^\s*approved(\s+with\s*:|\b)/i;
const APPROVAL_WITH_EDITS_RE = /^\s*approved\s+with\s*:/i;
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

function recordEntry({ root, tenant, kind, issue, bodyHash, commentUrl, model, by, edits, labels, through, recordId, actor, evidence, prUrl, now } = {}) {
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
  }
  if (kind === 'approved' || kind === 'approved-with-edits' || kind === 'rejected') {
    entry.by = requireText(by, 'by');
    if (commentUrl) entry.commentUrl = String(commentUrl);
    if (kind === 'approved-with-edits') entry.edits = requireText(edits, 'edits');
  }
  if (kind === 'superseded') entry.bodyHash = requireText(bodyHash, 'body-hash');
  if (kind === 'finalized') {
    const applied = String(labels || '').split(',').map((label) => label.trim()).filter(Boolean);
    entry.labels = applied;
    // fleet#49: a ruling that opened a docs PR (ADR or glossary text) names it here. The
    // lead reviews only branchPrefix PRs and pr-watch tracks only Work records, so the
    // digest is where the PR stays visible until Cory merges it (the merge is Cory's).
    if (prUrl) entry.prUrl = String(prUrl);
  }
  if (evidence) entry.evidence = String(evidence);
  const entries = readLedger(root, tenant);
  if (kind === 'proposed') {
    const open = projectTriage({ entries, now: at }).byIssue[entry.issue];
    if (open && open.proposed && !open.outcome) throw new WorkStateError('TRIAGE_PROPOSAL_OPEN', `issue #${entry.issue} already has an open proposal at ${open.proposed.at}; record its outcome first`);
  } else if (kind !== 'consumed') {
    const open = projectTriage({ entries, now: at }).byIssue[entry.issue];
    if (!open || !open.proposed) throw new WorkStateError('TRIAGE_NO_PROPOSAL', `issue #${entry.issue} has no proposal to ${kind}`);
    if (OUTCOME_KINDS.includes(kind) && open.outcome) throw new WorkStateError('TRIAGE_OUTCOME_RECORDED', `issue #${entry.issue} already has outcome ${open.outcome.kind} at ${open.outcome.at}`);
    if (kind === 'finalized' && !open.outcome) throw new WorkStateError('TRIAGE_NOT_APPROVED', `issue #${entry.issue} has no approval to finalize`);
  }
  return appendEntry(root, tenant, entry);
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
    else if (entry.kind === 'finalized') { if (row.outcome) row.finalized = entry; }
  }
  const rows = Object.values(byIssue).sort((left, right) => left.issue - right.issue);
  const pending = rows.filter((row) => row.proposed && !row.outcome).map((row) => ({ issue: row.issue, since: row.proposed.at, commentUrl: row.proposed.commentUrl, model: row.proposed.model }));
  const awaitingFinalize = rows.filter((row) => row.outcome && ['approved', 'approved-with-edits'].includes(row.outcome.kind) && !row.finalized).map((row) => ({ issue: row.issue, outcome: row.outcome.kind, since: row.outcome.at }));
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
  const allTime = tally(outcomes);
  const spanDays = firstProposedAt ? (new Date(at).getTime() - new Date(firstProposedAt).getTime()) / 86400000 : 0;
  const graduationState = {
    minProposals: rule.minProposals, minDays: rule.minDays, minUnchangedRatio: rule.minUnchangedRatio,
    decided: allTime.decided, spanDays: Number(spanDays.toFixed(1)), unchangedRatio: allTime.unchangedRatio,
    met: allTime.decided >= rule.minProposals && spanDays >= rule.minDays && allTime.unchangedRatio !== null && allTime.unchangedRatio >= rule.minUnchangedRatio,
  };
  return { at, windowDays: window, byIssue, pending, awaitingFinalize, docsPrs, window: windowStats, allTime, graduation: graduationState, consumedThrough, proposalsTotal: rows.filter((row) => row.proposed).length };
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
  };
}

const ISSUE_QUERY = 'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number,title,url,body,createdAt,lastEditedAt,author{login},labels(first:20){nodes{name}},assignees(first:20){nodes{login}},subIssues(first:100){nodes{number,state} pageInfo{hasNextPage}},comments(last:100){nodes{id,url,body,createdAt,author{login}} pageInfo{hasPreviousPage}}} pageInfo{hasNextPage,endCursor}}}}';

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

function selectTriageFrontier({ issues = [], ownerLogin, readyLabel = 'ready-for-agent', config = DEFAULT_CONFIG, entries = [], outbox = [], held = new Map(), tenant, now } = {}) {
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  const owner = requireText(ownerLogin, 'ownerLogin');
  const routing = new Set([readyLabel, ...config.routingLabels]);
  const triageLabels = new Set(config.triageLabels);
  const marker = config.markerLabel;
  const projection = projectTriage({ entries, now: at, windowDays: config.windowDays, graduation: config.graduation });
  const approvals = [];
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

    // 1. An open proposal with the owner's Approved comment after it: finalize first.
    if (proposed) {
      const approval = ownerComments.filter((comment) => comment.createdAt > proposed.at && APPROVAL_RE.test(comment.body)).pop();
      if (approval) {
        approvals.push({ kind: 'approval', number: issue.number, title: issue.title, url: issue.url, commentUrl: approval.url, at: approval.createdAt, withEdits: APPROVAL_WITH_EDITS_RE.test(approval.body), by: approval.author, reason: 'owner approval newer than the proposal' });
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
    // fleet#55: there is no "owner has the newest comment" rule. Every fleet
    // session's comment carries the owner login, so that test dropped two
    // freshly filed companion tickets on the lead's own cross-links, with no
    // event that could ever put them back. Nothing here infers the owner's
    // involvement from authorship; an Approval and a re-proposal ask are
    // recognised by a shape no fleet role may write.
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

  // Spec fleet #92 (#143): the backfill census. Open tickets carrying the ready
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
  const escalationList = [...escalations.values()].sort((left, right) => left.at.localeCompare(right.at));
  const proposeNow = tickets.slice(0, config.maxProposalsPerTurn).map((ticket) => ticket.number);
  return {
    at, ownerLogin: owner, cap: config.maxProposalsPerTurn, consumedThrough: projection.consumedThrough,
    eligible: [...approvals, ...escalationList, ...tickets],
    proposeNow,
    skipped,
    premises,
    counts: { issues: issues.length, eligible: approvals.length + escalationList.length + tickets.length, approvals: approvals.length, escalations: escalationList.length, tickets: tickets.length },
  };
}

function computeFrontier({ root, tenant, tenantConfigPath, fixture, outboxPath, now, runner } = {}) {
  const config = readTriageConfig(root);
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  const ownerLogin = ownerLoginOf(tenantConfig);
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  const issues = fixture ? readFixtureIssues(fixture) : queryGithubIssues({ repo: tenantConfig.github, runner: runner || execFileSync });
  const outbox = readOutbox(outboxPath ? path.resolve(outboxPath) : path.join(baseOf(root), 'state', 'watch', 'wake-outbox.jsonl'));
  const entries = readLedger(root, tenant);
  const held = readHeldIssues(root, tenant, at);
  const frontier = selectTriageFrontier({ issues, ownerLogin, readyLabel: tenantConfig.readyLabel || 'ready-for-agent', config, entries, outbox, held, tenant, now: at });
  return { tenant: String(tenant), source: fixture ? 'fixture' : 'github', ...frontier };
}

// ------------------------------------------------------------------ CLI ----

const TRIAGE_FLAGS = Object.freeze({
  frontier: ['root', 'tenant', 'tenant-config', 'fixture', 'outbox', 'now'],
  record: ['root', 'tenant', 'kind', 'issue', 'body-hash', 'comment-url', 'model', 'by', 'edits', 'labels', 'through', 'record-id', 'actor', 'evidence', 'pr-url', 'now'],
  state: ['root', 'tenant', 'now', 'days'],
});
const TRIAGE_USAGE = 'commands: frontier (--tenant [--fixture <issues.json>] [--outbox <jsonl>] [--now <iso>]), record (--tenant --kind proposed|approved|approved-with-edits|rejected|superseded|finalized|consumed ...), state (--tenant [--days n])';

function cli(argv) {
  const [command, ...rest] = argv;
  const flags = TRIAGE_FLAGS[command];
  if (!flags) throw new WorkStateError('USAGE', TRIAGE_USAGE);
  const args = parseArgs(rest, flags);
  const tenant = requireText(args.tenant, '--tenant');
  if (command === 'frontier') return computeFrontier({ root: args.root, tenant, tenantConfigPath: args['tenant-config'], fixture: args.fixture, outboxPath: args.outbox, now: args.now });
  if (command === 'record') {
    return recordEntry({
      root: args.root, tenant, kind: args.kind, issue: args.issue, bodyHash: args['body-hash'], commentUrl: args['comment-url'], model: args.model,
      by: args.by, edits: args.edits, labels: args.labels, through: args.through, recordId: args['record-id'], actor: args.actor, evidence: args.evidence, prUrl: args['pr-url'], now: args.now,
    });
  }
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
  DEFAULT_CONFIG,
  LEDGER_KINDS,
  TRIAGE_FLAGS,
  cli,
  computeFrontier,
  ledgerPath,
  normalizeIssue,
  projectTriage,
  queryGithubIssues,
  readLedger,
  readTriageConfig,
  recordEntry,
  selectTriageFrontier,
};
