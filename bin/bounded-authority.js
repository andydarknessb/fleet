'use strict';
// Spec fleet #193 (ADR 0011, 2026-09-29 amendment): Bounded authority, the
// Principal's standing permission to ready one narrow class of bug itself. This
// module holds what the doors, the daily summary and the scorecard share:
//
//   - the two per-tenant flag files under state/flags/ (the repo's flag
//     convention: a flag is a file, its presence is the switch):
//       bounded-authority-<tenant>            Cory creates it; no door ever does.
//       bounded-authority-suspended-<tenant>  written by the suspension scan;
//                                             only removing the file lifts it.
//   - the daily cap and the named criteria mark.
//
// The Veto window itself (Central time, the ledger reading, the frontier reasons)
// is in bin/assignment.js, where the planner that enforces it lives; it is
// re-exported here so the rest reads one module. bin/triage.js owns the doors
// (`bounded-ready`, `veto`, `bounded-scan`) and requires this module lazily, since
// harnesses that carry triage.js for the frontier do not all carry this file.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assignment = require('./assignment');
const { WorkStateError, readEvents, readTenantConfigs } = require('./work-state');

// At most this many bounded readies per tenant per Central calendar day.
const DAILY_CAP = 5;

// The named reason and finding category that mark an escalation or a send-back as
// caused by the ticket's criteria (never free text). The escalation door
// (work-state.js `--reason`) and a findings artifact's `category` both carry it.
const CRITERIA_MARK = 'criteria-defect';

function baseOf(root) { return path.resolve(root || path.resolve(__dirname, '..')); }
function triage() { return require('./triage'); }
// A comment's identity across URL spellings: its issuecomment id.
const idOfComment = (url) => (/issuecomment-(\d+)/.exec(String(url || '')) || [])[1] || String(url || '');

// ------------------------------------------------------------------ flags ----

function safeTenant(tenant) { return String(tenant || '').replace(/[^a-zA-Z0-9_.-]/g, '_'); }
function flagsDir(root) { return path.join(baseOf(root), 'state', 'flags'); }
function boundedFlagPath(root, tenant) { return path.join(flagsDir(root), `bounded-authority-${safeTenant(tenant)}`); }
function suspensionFlagPath(root, tenant) { return path.join(flagsDir(root), `bounded-authority-suspended-${safeTenant(tenant)}`); }
function isBoundedEnabled(root, tenant) { return fs.existsSync(boundedFlagPath(root, tenant)); }
function isSuspended(root, tenant) { return fs.existsSync(suspensionFlagPath(root, tenant)); }

// Every standing suspension: [{ tenant, file, ...whatever the flag recorded }].
function standingSuspensions(root) {
  const dir = flagsDir(root);
  if (!fs.existsSync(dir)) return [];
  const prefix = 'bounded-authority-suspended-';
  const found = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.startsWith(prefix)).sort()) {
    let detail = {};
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      detail = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) || {};
    } catch { detail = {}; }
    found.push({ ...detail, tenant: name.slice(prefix.length), file: path.join(dir, name) });
  }
  return found;
}

// ------------------------------------------------------- the bounded-ready door ----
// Spec fleet #193 (#210). `triage.js bounded-ready` records a bounded ready only when
// every condition of the class holds, and otherwise refuses naming each one that does
// not. The class is ADR 0011's amendment: a bug with a reproducible Red-tell that needs
// no Ruling, has nothing open for Cory, touches no carve-out or risk-trigger path, has a
// haiku or sonnet Tier and verified premises; plus the tenant's flag, no suspension and
// fewer than DAILY_CAP readies that Central day. The door judges what a script can read
// off the proposal comment; that the Red-tell really is reproducible is the Principal's
// judgement, made before it calls the door (agents/principal.md).

const PROPOSAL_FIELDS = ['Classification', 'Root cause', 'Ruling', 'Red-tell', 'Repro', 'Scope', 'Premises', 'Blocked_by', 'Tier', 'Precedent', 'Open for Cory', 'Escaped from'];

function refused(conditions) {
  const first = conditions[0];
  const list = conditions.map((entry) => `${entry.code}: ${entry.detail}`).join('; ');
  return new WorkStateError('BOUNDED_REFUSED', `bounded ready refused (${list})`, { condition: first.code, conditions });
}

function isoOf(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new WorkStateError('TRIAGE_INVALID', 'now must be an ISO timestamp');
  return date.toISOString();
}

function issueNumberOf(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new WorkStateError('TRIAGE_INVALID', 'issue must be a positive integer');
  return number;
}

// The proposal comment's fields (principal.md's shape): { Classification: 'bug', ... },
// each value its own line and the lines under it, trimmed. null when the comment is no proposal.
function parseProposal(body) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*##\s*Triage proposal\b/i.test(line));
  if (start < 0) return null;
  const collected = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const match = /^([A-Za-z_][A-Za-z_ -]*?):[ \t]*(.*)$/.exec(line);
    const name = match && PROPOSAL_FIELDS.find((field) => field.toLowerCase() === match[1].trim().toLowerCase());
    if (name && !(name in collected)) { current = name; collected[name] = [match[2]]; continue; }
    if (current) collected[current].push(line);
  }
  return Object.fromEntries(Object.entries(collected).map(([name, values]) => [name, values.join('\n').trim()]));
}

// Files named by a Scope value: any token with a `/` or a `.`, stripped of the fences
// and punctuation prose puts around it. A directory or a glob is not a file the door can
// place against the carve-outs, so it is reported apart.
function scopeTokens(scope) {
  const tokens = String(scope || '').split(/[\s,;]+/)
    .map((token) => token.replace(/^[`"'(\[]+|[`"')\].,:;!?]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean);
  const files = [];
  const unplaceable = [];
  for (const token of tokens) {
    if (!/[/.]/.test(token)) continue;
    if (token.endsWith('/') || /[*?{}[\]]/.test(token)) unplaceable.push(token); else files.push(token);
  }
  return { tokens, files: [...new Set(files)], unplaceable: [...new Set(unplaceable)] };
}

const PLACEHOLDER = /^(?:none|n\/?a|tbd|todo|unknown|not (?:yet )?(?:known|reproducible))\b/i;

// The class conditions read off one proposal: [{ code, detail }] for each that fails.
function checkBoundedClass({ proposal, premisesSha, tenantConfig = {} } = {}) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  const first = (name) => String((proposal && proposal[name]) || '').split('\n')[0].trim();
  if (!/^bug\.?$/i.test(first('Classification'))) fail('not-a-bug', `Classification is "${first('Classification') || 'missing'}", not "bug"`);
  const redTell = String((proposal && proposal['Red-tell']) || '').trim();
  if (!redTell || PLACEHOLDER.test(redTell)) fail('no-red-tell', 'the proposal names no Red-tell, and a bounded bug needs a reproducible one');
  if (!/^none needed\.?$/i.test(first('Ruling'))) fail('ruling-needed', `Ruling is "${first('Ruling') || 'missing'}", not "none needed"`);
  if (!/^none\.?$/i.test(first('Open for Cory'))) fail('open-for-cory', `Open for Cory is "${first('Open for Cory') || 'missing'}", not "none"`);
  const tier = first('Tier');
  if (!/^(?:haiku|sonnet)\b/i.test(tier) || /\b(?:opus|fable)\b|\|/i.test(tier)) fail('tier', `Tier is "${tier || 'missing'}"; a bounded ready is haiku or sonnet`);

  // Premises: every line verified at the sha recorded with the proposal, none false.
  const premises = String((proposal && proposal.Premises) || '').trim();
  if (!premises) fail('premises-unverified', 'the proposal has no Premises field; write "none stated" or the verified lines');
  else if (!/^none(?: stated)?\.?$/i.test(premises)) {
    const recorded = premisesSha ? String(premisesSha).toLowerCase() : null;
    for (const line of premises.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const stamp = /\bverified @([0-9a-f]{7,40})\s*$/i.exec(line);
      if (/\bfalse:/i.test(line)) fail('premises-unverified', `a premise is marked false: ${line}`);
      else if (!stamp) fail('premises-unverified', `a premise is not stamped "verified @<sha>": ${line}`);
      else if (!recorded) fail('premises-unverified', `the proposal was recorded without --premises-sha, so "verified @${stamp[1]}" names no proposal sha`);
      else if (!(recorded.startsWith(stamp[1].toLowerCase()) || stamp[1].toLowerCase().startsWith(recorded))) fail('premises-unverified', `a premise is verified @${stamp[1]}, not at the recorded --premises-sha ${recorded}`);
    }
  }

  // Scope: named files only, none in a carve-out or a risk-trigger path.
  const { matchGlob } = require('./review-policy');
  const carveOuts = Array.isArray(tenantConfig.carveOuts) ? tenantConfig.carveOuts : [];
  const riskTriggers = tenantConfig.riskTriggers && typeof tenantConfig.riskTriggers === 'object' ? tenantConfig.riskTriggers : {};
  if (!carveOuts.length && !Object.keys(riskTriggers).length) {
    fail('tenant-no-carve-outs', `tenant ${tenantConfig.name || '?'} declares no carveOuts and no riskTriggers, so no Scope can be shown to be outside them`);
    return failures;
  }
  const scope = scopeTokens(proposal && proposal.Scope);
  if (scope.unplaceable.length) fail('scope-unresolved', `Scope names a directory or a pattern (${scope.unplaceable.join(', ')}); name the files, so each can be checked against the carve-outs`);
  else if (!scope.files.length) fail('scope-unresolved', 'Scope names no file the door can check against the carve-outs');
  for (const token of scope.tokens) {
    for (const glob of carveOuts) {
      if (matchGlob(glob, token)) fail('scope-carve-out', `Scope names ${token}, inside the carve-out ${glob}`);
    }
    for (const [name, spec] of Object.entries(riskTriggers)) {
      for (const glob of (spec && spec.paths) || []) {
        if (matchGlob(glob, token)) fail('scope-risk-path', `Scope names ${token}, inside the ${name} risk-trigger path ${glob}`);
      }
    }
  }
  return failures;
}

function loadIssues({ tenantConfig, fixture, issues, runner }) {
  const { readFixtureIssues, normalizeIssue, queryGithubIssues } = triage();
  if (issues) return issues.map((entry) => normalizeIssue(entry));
  if (fixture) return readFixtureIssues(fixture);
  return queryGithubIssues({ repo: tenantConfig.github, runner });
}

// edits: [['--add-label', name], ['--remove-label', name]], applied in one gh call.
function ghEdit({ runner, tenantConfig, number, edits }) {
  const args = ['issue', 'edit', String(number), '-R', String(tenantConfig.github)];
  for (const [flag, label] of edits) args.push(flag, label);
  runner('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 });
}

function centralClock(ms) {
  const p = assignment.chicagoParts(ms);
  return `${assignment.chicagoDay(ms)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} Central`;
}

function boundedReady({ root, tenant, issue: issueValue, tenantConfigPath, fixture, issues, now, runner = execFileSync, send, effects = true } = {}) {
  const { readLedger, projectTriage, recordEntry, readTenantConfig, ownerLoginOf, readTriageConfig } = triage();
  const number = issueNumberOf(issueValue);
  if (!tenant) throw new WorkStateError('TRIAGE_INVALID', 'tenant is required');
  const at = isoOf(now);
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  ownerLoginOf(tenantConfig);
  // Gate 1: Cory's flag. Read before any GitHub call, so an unenabled tenant (Nidus) costs nothing.
  if (!isBoundedEnabled(root, tenant)) {
    throw refused([{ code: 'flag-absent', detail: `Bounded authority is not enabled for ${tenant}: state/flags/bounded-authority-${safeTenant(tenant)} does not exist, and only Cory creates it` }]);
  }
  const all = loadIssues({ tenantConfig, fixture, issues, runner });
  const found = all.find((entry) => entry.number === number);
  if (!found) throw refused([{ code: 'issue-not-found', detail: `issue #${number} is not among ${tenant}'s open issues` }]);
  // Gate 2: a standing suspension, lifted only by removing its file. The scan comes first, so
  // failure evidence that arrived since the last one is on file before the ready is judged.
  scanSuspension({ root, tenant, issues: all, now: at });
  if (isSuspended(root, tenant)) {
    throw refused([{ code: 'suspended', detail: `Bounded authority is suspended for ${tenant} (state/flags/bounded-authority-suspended-${safeTenant(tenant)}); only removing that file lifts it` }]);
  }

  const config = readTriageConfig(root);
  const readyLabel = tenantConfig.readyLabel || 'ready-for-agent';
  const entries = readLedger(root, tenant);
  const row = projectTriage({ entries, now: at }).byIssue[number] || null;
  const open = row && row.proposed && !row.outcome ? row.proposed : null;
  if (!open) throw refused([{ code: 'no-open-proposal', detail: `issue #${number} has no open proposal in the ledger (none recorded, or its outcome is already recorded)` }]);

  const failures = [];
  const today = assignment.chicagoDay(new Date(at).getTime());
  const todays = entries.filter((entry) => entry.kind === 'bounded-ready' && assignment.chicagoDay(new Date(entry.at).getTime()) === today).length;
  if (todays >= DAILY_CAP) failures.push({ code: 'daily-cap', detail: `${todays} bounded readies are recorded for ${tenant} on ${today} (Central); the cap is ${DAILY_CAP}` });
  if (open.reason) failures.push({ code: 'needs-approval', detail: `the proposal is a ${open.reason} restatement, which still needs Approval (ADR 0011)` });
  if (open.recordId) failures.push({ code: 'needs-approval', detail: `the proposal answers an escalation (${open.recordId}), a ruling on live work, which still needs Approval` });
  if (found.labels.includes(readyLabel)) failures.push({ code: 'already-ready', detail: `issue #${number} already carries ${readyLabel}` });
  if (found.bodyHash !== open.bodyHash) failures.push({ code: 'proposal-stale', detail: 'the issue body changed since the proposal was written; propose again' });
  const comment = found.comments.find((entry) => idOfComment(entry.url) === idOfComment(open.commentUrl));
  const proposal = comment ? parseProposal(comment.body) : null;
  if (!proposal) failures.push({ code: 'proposal-not-found', detail: `the recorded proposal comment ${open.commentUrl} is not among issue #${number}'s comments, or is not a triage proposal` });
  else failures.push(...checkBoundedClass({ proposal, premisesSha: open.premisesSha, tenantConfig }));
  if (failures.length) throw refused(failures);

  const paths = scopeTokens(proposal.Scope).files;
  const window = assignment.vetoWindow(at);
  // Order: the ledger row first, then the label. The planner reads the row to hold the
  // ticket for its Veto window, so the row must exist before the label makes the ticket
  // ready; the other order leaves a moment in which a ready ticket has no window.
  const entry = recordEntry({ root, tenant, kind: 'bounded-ready', issue: number, bodyHash: found.bodyHash, commentUrl: open.commentUrl, fields: { scope: paths, tier: tierWord(proposal.Tier) }, now: at });
  const result = { tenant, issue: number, readied: true, at, windowUntil: window.until, windowRule: window.rule, source: fixture ? 'fixture' : 'github', labelApplied: false, paged: false, entry };
  if (!effects) return result;
  try {
    ghEdit({ runner, tenantConfig, number, edits: [['--add-label', readyLabel], ...(found.labels.includes(config.markerLabel) ? [['--remove-label', config.markerLabel]] : [])] });
  } catch (error) {
    throw new WorkStateError('GITHUB_WRITE_FAILED', `the bounded ready of #${number} is recorded in the ledger but applying ${readyLabel} failed (${String(error.stderr || error.message || error).slice(0, 200)}); apply it by hand, or leave the issue for an Approval (the recorded row counts toward today's cap)`, { issue: number, entry });
  }
  result.labelApplied = true;
  const page = {
    kind: 'bounded-ready',
    title: `Fleet: ${tenant} #${number} readied under Bounded authority`,
    body: `${found.title}. The Principal readied it itself, with no Approval. Nothing assigns it before ${centralClock(window.untilMs)}. Comment "Veto" on the issue to withdraw it.`,
    priority: 'normal',
    url: found.url,
  };
  const sender = send || require('./notify').pageSender({ root });
  let sent;
  try { sent = sender(page); } catch (error) { sent = { ok: false, detail: `send threw: ${String(error.message || error).slice(0, 200)}` }; }
  result.paged = Boolean(sent && sent.ok);
  result.pageDetail = (sent && sent.detail) || null;
  return result;
}

function tierWord(value) { return String(value || '').split('\n')[0].trim().split(/\s+/)[0].toLowerCase(); }

// The veto door: the owner's Veto on a standing bounded ready. The label comes off
// before the ledger row is written, the reverse of the ready: were the row first and
// the label edit to fail, the ledger would say "vetoed" (releasing the Veto window
// hold) while the ticket stayed ready and assignable.
function vetoReady({ root, tenant, issue: issueValue, tenantConfigPath, fixture, issues, now, runner = execFileSync, effects = true } = {}) {
  const { readLedger, recordEntry, readTenantConfig, ownerLoginOf, readTriageConfig } = triage();
  const number = issueNumberOf(issueValue);
  if (!tenant) throw new WorkStateError('TRIAGE_INVALID', 'tenant is required');
  const at = isoOf(now);
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  const owner = ownerLoginOf(tenantConfig);
  const standing = assignment.liveBoundedReadies(readLedger(root, tenant)).get(number);
  if (!standing) throw new WorkStateError('TRIAGE_NO_BOUNDED_READY', `issue #${number} has no standing bounded ready to veto`);
  const all = loadIssues({ tenantConfig, fixture, issues, runner });
  const found = all.find((entry) => entry.number === number);
  if (!found) throw new WorkStateError('TRIAGE_INVALID', `issue #${number} is not among ${tenant}'s open issues`);
  const veto = found.comments.filter((comment) => comment.author.toLowerCase() === owner.toLowerCase() && assignment.VETO_RE.test(comment.body) && comment.createdAt > standing.at).pop();
  if (!veto) throw new WorkStateError('TRIAGE_NO_VETO', `issue #${number} has no comment from ${owner} beginning "Veto" after the bounded ready at ${standing.at}`);
  const config = readTriageConfig(root);
  const readyLabel = tenantConfig.readyLabel || 'ready-for-agent';
  const result = { tenant, issue: number, vetoed: true, at, source: fixture ? 'fixture' : 'github', labelChanged: false };
  if (effects) {
    try {
      ghEdit({ runner, tenantConfig, number, edits: [['--remove-label', readyLabel], ['--add-label', config.markerLabel]] });
    } catch (error) {
      throw new WorkStateError('GITHUB_WRITE_FAILED', `removing ${readyLabel} from #${number} failed (${String(error.stderr || error.message || error).slice(0, 200)}); nothing was recorded, run the veto door again`, { issue: number });
    }
    result.labelChanged = true;
  }
  result.entry = recordEntry({ root, tenant, kind: 'veto', issue: number, by: owner, commentUrl: veto.url || undefined, now: at });
  return result;
}

// ------------------------------------------------------- the suspension scan ----
// Spec fleet #193 (#211, ADR 0011 amendment). Bounded authority suspends itself on
// evidence that the bounded class is failing, by writing
// state/flags/bounded-authority-suspended-<tenant>. Only Cory lifts it, by removing the
// file; nothing here ever deletes it. The evidence is one of:
//   - an escalation or a send-back on a bounded ticket, marked as caused by the ticket's
//     criteria: the escalation reason `criteria-defect` (work-state.js `--reason`) or a
//     finding whose kebab-case `category` is `criteria-defect` in the review artifact the
//     send-back followed. The mark is the name; free text is never read.
//   - a bug whose triage proposal says `Escaped from: #<PR>` (exactly that shape; ticket
//     #213 adds the line) where that PR delivered a bounded ticket.
// A Veto is not evidence: a vetoed ticket is no longer a bounded ticket at all.
//
// Where it runs, and why a scan: the evidence is written by three different doors (the
// escalation door in work-state.js, the review door in review-policy.js, and the Principal's
// proposal on a bug, which lives only as a GitHub comment), so no single door call sees all
// of it, and hooking the first two into the ledger would couple both to the triage ledger. A
// scan reads them all, and is idempotent, so it can run wherever it is cheap: the
// bounded-ready door runs it first (a ready is the only act suspension forbids, so no bounded
// ready can follow failure evidence, however late the scan otherwise ran), the daily summary
// runs it each morning so a standing suspension is on Cory's page, and `triage.js
// bounded-scan` runs it by hand. Evidence already ruled on is remembered in the `suspended`
// ledger rows (their evidenceIds), so removing the flag lifts the suspension for good and
// only new evidence suspends again.

function artifactHasCategory(root, relative, category) {
  if (!relative) return false;
  const base = path.resolve(root);
  const file = path.resolve(base, String(relative));
  if (file !== base && !file.startsWith(base + path.sep)) return false;
  try {
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (artifact.findings || []).some((finding) => finding && finding.category === category);
  } catch { return false; }
}

// Escalations and send-backs after the ready, on the record of a still-standing bounded ticket.
function criteriaEvidence({ root, tenant, live, events }) {
  const found = [];
  for (const [issue, ready] of live) {
    const recordId = `${tenant}:issue-${issue}`;
    const readyMs = new Date(ready.at).getTime();
    const own = events.filter((event) => event.recordId === recordId && new Date(event.at).getTime() > readyMs).sort((a, b) => a.sequence - b.sequence);
    let lastReview = null;
    for (const event of own) {
      if (event.type === 'review-recorded') lastReview = event;
      else if (event.type === 'state-escalated' && event.changes && event.changes.reason === CRITERIA_MARK) {
        found.push({ cause: 'escalation', id: `${recordId}#${event.sequence}`, at: event.at, issue, recordId, detail: `${recordId} escalated with reason ${CRITERIA_MARK}` });
      } else if (event.type === 'state-revision' && event.changes && event.changes.sendBack === true && lastReview && artifactHasCategory(root, lastReview.changes && lastReview.changes.artifact, CRITERIA_MARK)) {
        found.push({ cause: 'send-back', id: `${recordId}#${event.sequence}`, at: event.at, issue, recordId, detail: `${recordId} sent back after a finding of category ${CRITERIA_MARK} in ${lastReview.changes.artifact}` });
      }
    }
  }
  return found;
}

// Open bugs whose newest proposal names, as `Escaped from: #<PR>`, a PR that delivered a bounded ticket.
function escapeEvidence({ tenant, live, events, issues, entries }) {
  const prToIssue = new Map();
  for (const issue of live.keys()) {
    for (const event of events) {
      const pr = event.recordId === `${tenant}:issue-${issue}` && event.changes && event.changes.prNumber;
      if (pr) prToIssue.set(Number(pr), issue);
    }
  }
  const found = [];
  for (const bug of issues) {
    const proposal = entries.filter((entry) => entry.kind === 'proposed' && Number(entry.issue) === bug.number).pop();
    const comment = proposal && bug.comments.find((entry) => idOfComment(entry.url) === idOfComment(proposal.commentUrl));
    const fields = comment ? parseProposal(comment.body) : null;
    const line = fields && fields['Escaped from'] ? fields['Escaped from'].split('\n')[0].trim() : '';
    const match = /^#(\d+)\.?$/.exec(line);
    if (!match) continue;
    const pr = Number(match[1]);
    const boundedIssue = prToIssue.get(pr);
    if (!boundedIssue || boundedIssue === bug.number) continue;
    found.push({ cause: 'escape', id: `escape:${bug.number}:${pr}`, at: proposal.at, issue: boundedIssue, bug: bug.number, pr, detail: `bug #${bug.number} escaped from PR #${pr}, which delivered bounded ticket #${boundedIssue}` });
  }
  return found;
}

// Read the evidence, and suspend on any not already ruled on. `issues` is the tenant's open
// issues (the escape check reads their proposals); without it only the local evidence counts.
function scanSuspension({ root, tenant, issues, now, events } = {}) {
  const { readLedger, recordEntry, normalizeIssue } = triage();
  const at = isoOf(now);
  const entries = readLedger(root, tenant);
  const live = assignment.liveBoundedReadies(entries);
  const standing = isSuspended(root, tenant);
  const result = { tenant, at, suspended: standing, wrote: false, evidence: [] };
  if (!live.size) return result;
  const ruledOn = new Set(entries.filter((entry) => entry.kind === 'suspended').flatMap((entry) => entry.evidenceIds || []));
  const ledgerEvents = events || readEvents(root);
  const found = [
    ...criteriaEvidence({ root, tenant, live, events: ledgerEvents }),
    ...(issues ? escapeEvidence({ tenant, live, events: ledgerEvents, issues: issues.map((entry) => normalizeIssue(entry)), entries }) : []),
  ].filter((item) => !ruledOn.has(item.id)).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  if (!found.length) return result;
  const first = found[0];
  const evidenceIds = found.map((item) => item.id);
  // The flag first, then the row: a row without its flag would leave the evidence "ruled on"
  // and the authority armed; a flag without its row is repaired by the next scan.
  if (!standing) {
    const flag = { schemaVersion: 1, tenant, at, cause: first.cause, issue: first.issue, ...(first.recordId ? { recordId: first.recordId } : {}), ...(first.bug ? { bug: first.bug, pr: first.pr } : {}), evidenceIds, detail: first.detail };
    fs.mkdirSync(flagsDir(root), { recursive: true });
    try { fs.writeFileSync(suspensionFlagPath(root, tenant), `${JSON.stringify(flag, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  recordEntry({ root, tenant, kind: 'suspended', issue: first.issue, now: at, fields: { cause: first.cause, standing, evidenceIds, detail: first.detail } });
  return { ...result, suspended: true, wrote: !standing, evidence: found };
}

// The CLI door: load the tenant's open issues (a fixture, or GitHub) and scan.
function boundedScan({ root, tenant, tenantConfigPath, fixture, issues, now, runner = execFileSync } = {}) {
  const { readTenantConfig } = triage();
  if (!tenant) throw new WorkStateError('TRIAGE_INVALID', 'tenant is required');
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  return scanSuspension({ root, tenant, issues: loadIssues({ tenantConfig, fixture, issues, runner }), now });
}

// The daily summary's scan: every tenant that has Bounded authority enabled or suspended. A
// failed GitHub read falls back to the local evidence; a failed scan never stops the summary.
function scanTenants({ root, now, loadTenantIssues } = {}) {
  const configs = readTenantConfigs(root);
  const results = [];
  for (const [tenant, config] of Object.entries(configs)) {
    if (!isBoundedEnabled(root, tenant) && !isSuspended(root, tenant)) continue;
    let issues;
    let issuesError = null;
    try { issues = loadTenantIssues ? loadTenantIssues(tenant, config) : triage().queryGithubIssues({ repo: config.github }); } catch (error) { issuesError = String(error.message || error).split('\n')[0]; }
    try { results.push({ ...scanSuspension({ root, tenant, issues, now }), ...(issuesError ? { issuesError } : {}) }); } catch (error) { results.push({ tenant, error: String(error.message || error).split('\n')[0] }); }
  }
  return results;
}

module.exports = {
  CRITERIA_MARK,
  DAILY_CAP,
  VETO_RE: assignment.VETO_RE,
  boundedFlagPath,
  boundedReady,
  boundedScan,
  checkBoundedClass,
  parseProposal,
  chicagoDay: assignment.chicagoDay,
  isBoundedEnabled,
  isSuspended,
  liveBoundedReadies: assignment.liveBoundedReadies,
  scanSuspension,
  scanTenants,
  standingSuspensions,
  suspensionFlagPath,
  vetoReady,
  vetoWindow: assignment.vetoWindow,
};
