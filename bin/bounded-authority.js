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
// Spec fleet #193 (#210). The door acts with no word from Cory, so it is never looser than
// #207's finalize predicate on any clause (ruling on the QA of #209 to #211, 2026-09-29):
//
//   bounded = triage.js proposalGate() failures  +  the bounded-only clauses below
//
// proposalGate is #207's clauses 1 and 4 to 9, one function: open proposal, proposal identity,
// not edited, body hash and \`## Premises\` heading, not an escalation ruling (fail closed),
// whole-field Classification/Open for Cory/Blocked_by/Tier, a Ruling field, labels, holds.
// The bounded-only clauses, each a whole field (trimmed, one trailing full stop allowed):
//   Classification exactly bug; Ruling exactly \`none needed\`; a Red-tell and a Repro that are
//   not placeholders (the mechanical proxy for "reproducible"; the Principal's judgement is
//   the rest); Scope naming only repo paths (that exist, outside every carve-out and
//   risk-trigger path, in no file whose content matches a risk-trigger pattern); premises
//   that match the ticket body's own; no owner comment after the proposal; no earlier
//   bounded-ready or veto row for the issue, ever (one bounded attempt per issue); no Work
//   record for the issue; no open blocked-by edge; the tenant flag; no suspension; the cap.
// Every failure carries a code; the door refuses on the whole list and never fails open.

const PLACEHOLDER = /^(?:none|n\/?a|tbd|todo|unknown|not (?:yet )?(?:known|reproducible))\.?$/i;
// Whole-field words the ruling asks for, compared after a trailing full stop is dropped.
const exact = (parsed, name) => triage().exactField(parsed, name);

function refused(conditions) {
  const plain = [...conditions].map((entry) => ({ code: entry.code, detail: entry.detail }));
  const list = plain.map((entry) => `${entry.code}: ${entry.detail || entry.code}`).join('; ');
  return new WorkStateError('BOUNDED_REFUSED', `bounded ready refused (${list})`, { condition: plain[0].code, conditions: plain });
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

// --- the tenant checkout at origin/<defaultBranch>: what a Scope path must exist in ---

// { has(dir) -> bool, read(file) -> string|null } over the tenant checkout's local ref (staleness
// accepted, ruling M5). A directory that git cannot show does not exist; a file it cannot show has
// no content to test against the risk patterns (a Scope may name a file the fix will create).
function gitRepo(tenantConfig) {
  const dir = tenantConfig && tenantConfig.repo;
  if (!dir) return null;
  const branch = tenantConfig.defaultBranch || 'integration';
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 });
  return {
    has(directory) { try { git(['cat-file', '-e', `origin/${branch}:${directory}`]); return true; } catch { return false; } },
    read(file) { try { return git(['show', `origin/${branch}:${file}`]); } catch { return null; } },
    list(directory) { try { return git(['ls-tree', '--name-only', `origin/${branch}:${directory}`]).split(/\r?\n/).filter(Boolean); } catch { return []; } },
  };
}

// A fixture file is an issues array, or { issues, tree: [dirs], files: { path: content } }: the
// `tree` and `files` stand in for the tenant checkout in a test or a rehearsal.
function readFixture(file) {
  const { readFixtureIssues, normalizeIssue } = triage();
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^﻿/, ''));
  if (Array.isArray(parsed)) return { issues: readFixtureIssues(file), repo: null };
  const tree = new Set((parsed.tree || []).map((dir) => String(dir).replace(/\/+$/, '')));
  const files = parsed.files || {};
  return {
    issues: (parsed.issues || []).map((entry) => normalizeIssue(entry)),
    repo: parsed.tree || parsed.files ? { has: (dir) => tree.has(dir), read: (name) => (Object.prototype.hasOwnProperty.call(files, name) ? String(files[name]) : null), list: (dir) => Object.keys(files).filter((name) => name.slice(0, name.lastIndexOf('/')) === dir).map((name) => name.slice(name.lastIndexOf('/') + 1)) } : null,
  };
}

function loadIssues({ tenantConfig, fixture, issues, runner }) {
  const { normalizeIssue, queryGithubIssues } = triage();
  if (issues) return { issues: issues.map((entry) => normalizeIssue(entry)), repo: null };
  if (fixture) return readFixture(fixture);
  return { issues: queryGithubIssues({ repo: tenantConfig.github, runner }), repo: null };
}

// --- Scope (ruling M5, M6) ---

// The tokens of a Scope field: the field's words after an optional leading "lists exactly" (or
// "lists only", "touches only"), with the joining words "and" and "or" dropped, split on
// whitespace, commas and semicolons, and stripped of the fences prose puts around a path. Every
// token that is left must be a repo path, so any other prose (`etc`, `...`, "and the pool
// module") is not a path and refuses (ruling on the re-QA, M-A and its minor 2).
function scopeTokens(scope) {
  const text = String(scope || '').replace(/^\s*(?:lists|touches|edits|changes)\s+(?:exactly|only)\b/i, '');
  return text.split(/[\s,;]+/)
    .filter(Boolean)
    .map((raw) => ({ raw, token: raw.replace(/^[`"'(\[]+|[`"')\].,:;!?]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '') }))
    .filter(({ raw, token }) => token || raw)
    .filter(({ token }) => !/^(?:and|or)$/i.test(token));
}

function patternRegExp(pattern) {
  try { return new RegExp(pattern); } catch { return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
}

// A Scope token is a repo path only when, after its line anchor is dropped (`#L12`, `:12`,
// `:12:5`, `:L12`, `:12-30`), it is made of [A-Za-z0-9._/-] alone with a directory in it and no
// empty, `.` or `..` segment, and its directory exists at origin/<defaultBranch>. Anything
// else is scope-unresolved, never guessed at. Globs are matched case-insensitively, and a
// token that differs only in case from a file that exists is refused, so `Auth.js` is not a way
// around `auth.js`.
function checkScope({ scope, tenantConfig, repo }) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  const { matchGlob } = require('./review-policy');
  const carveOuts = Array.isArray(tenantConfig.carveOuts) ? tenantConfig.carveOuts : [];
  const riskTriggers = tenantConfig.riskTriggers && typeof tenantConfig.riskTriggers === 'object' ? tenantConfig.riskTriggers : {};
  if (!carveOuts.length && !Object.keys(riskTriggers).length) { fail('tenant-no-carve-outs', `tenant ${tenantConfig.name || '?'} declares no carveOuts and no riskTriggers, so no Scope can be shown to be outside them`); return { failures, files: [] }; }
  const branch = tenantConfig.defaultBranch || 'integration';
  const files = [];
  for (const { raw, token } of scopeTokens(scope)) {
    const shown = raw;
    const bare = token.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/(?::L?\d+)+(?:-L?\d+)?$/i, '');
    if (bare.endsWith('/') || /[*?{}[\]]/.test(bare)) { fail('scope-unresolved', `${shown} is a directory or a pattern; name the files`); continue; }
    if (!bare || !/^[A-Za-z0-9._/-]+$/.test(bare)) { fail('scope-unresolved', `${shown} is not a path (it holds something other than letters, digits and . _ / -)`); continue; }
    if (!bare.includes('/')) { fail('scope-unresolved', /\./.test(bare) && /[A-Za-z0-9]/.test(bare) ? `${shown} names no directory, so no path in the repository; write the full path` : `${shown} is not a path`); continue; }
    const segments = bare.split('/');
    if (bare.startsWith('/') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) { fail('scope-unresolved', `${shown} is not a clean repo-relative path (no leading /, empty, . or .. segment)`); continue; }
    if (!repo) { fail('scope-unresolved', `no tenant checkout to confirm ${shown} against`); continue; }
    const directory = segments.slice(0, -1).join('/');
    if (!repo.has(directory)) { fail('scope-unresolved', `${shown}: its directory does not exist at origin/${branch}`); continue; }
    const twin = typeof repo.list === 'function' ? (repo.list(directory) || []).find((name) => name.toLowerCase() === segments[segments.length - 1].toLowerCase() && name !== segments[segments.length - 1]) : null;
    if (twin) { fail('scope-unresolved', `${shown} differs only in case from the existing ${directory}/${twin}`); continue; }
    files.push(bare);
  }
  if (!files.length && !failures.length) fail('scope-unresolved', 'Scope names no file the door can check against the carve-outs');
  for (const file of [...new Set(files)]) {
    const folded = file.toLowerCase();
    for (const glob of carveOuts) if (matchGlob(String(glob).toLowerCase(), folded)) fail('scope-carve-out', `Scope names ${file}, inside the carve-out ${glob}`);
    for (const [name, spec] of Object.entries(riskTriggers)) {
      for (const glob of (spec && spec.paths) || []) if (matchGlob(String(glob).toLowerCase(), folded)) fail('scope-risk-path', `Scope names ${file}, inside the ${name} risk-trigger path ${glob}`);
    }
    // For the bounded door a file whose current content matches a risk-trigger pattern is a risk-trigger path.
    const content = repo ? repo.read(file) : null;
    if (content !== null && content !== undefined) {
      for (const [name, spec] of Object.entries(riskTriggers)) {
        const hit = ((spec && spec.patterns) || []).find((pattern) => patternRegExp(pattern).test(content));
        if (hit) fail('scope-risk-pattern', `Scope names ${file}, whose content matches the ${name} risk-trigger pattern ${hit}`);
      }
    }
  }
  return { failures, files: [...new Set(files)] };
}

// --- premises (ruling M7): the proposal's block restates the ticket body's own, verified ---

function checkPremises({ proposal, issue, premisesSha }) {
  const { VERIFIED_PREMISE_RE } = triage();
  const { readPremises } = require('./premises');
  const fail = (detail) => [{ code: 'premises-unverified', detail }];
  const body = readPremises(issue.body);
  if (body.premisesError) return fail(`the ticket body's ## Premises section does not parse: ${body.premisesError.message}`);
  if (body.premises === null) return [];   // no heading: proposalGate's no-premises-heading says so
  const lines = proposal.premises;
  if (body.premises.length === 0) {
    return lines === null && /^none(?: stated)?\.?$/i.test(String(proposal.fields.Premises || '').trim()) ? [] : fail('the ticket body states no premises, and the proposal must say "none stated"');
  }
  if (!lines || lines.length !== body.premises.length) return fail(`the ticket body states ${body.premises.length} premise(s) and the proposal's Premises block must hold exactly that many verified lines, holding ${lines ? lines.length : 0}`);
  const recorded = premisesSha ? String(premisesSha).toLowerCase() : null;
  if (!recorded) return fail('the proposal was recorded without --premises-sha, so "verified @<sha>" names no proposal sha');
  const unmatched = new Set(body.premises.map((premise) => premise.path));
  for (const line of lines) {
    if (/ false:/.test(line)) return fail(`a premise is marked false: ${line}`);
    if (!VERIFIED_PREMISE_RE.test(line)) return fail(`a premise is not stamped "verified @<sha>": ${line}`);
    const sha = (/ verified @([0-9a-f]{7,40})$/.exec(line) || [])[1];
    if (!(recorded.startsWith(sha.toLowerCase()) || sha.toLowerCase().startsWith(recorded))) return fail(`a premise is verified @${sha}, not at the recorded --premises-sha ${recorded}`);
    const own = [...unmatched].find((premisePath) => line.startsWith(`${premisePath}:`));
    if (!own) return fail(`a proposal premise matches no premise of the ticket body: ${line}`);
    unmatched.delete(own);
  }
  return [];
}

// --- the door's full predicate ---

function hasWorkRecord(root, tenant, number) {
  try {
    const raw = fs.readFileSync(path.join(baseOf(root), 'state', 'work', 'active.json'), 'utf8');
    const active = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    const records = Array.isArray(active) ? active : Object.values((active && active.records) || active || {});
    return records.some((record) => record && String(record.id) === `${tenant}:issue-${number}`);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function boundedFailures({ root, tenant, number, issue, row, open, entries, projection, config, tenantConfig, repo, at, outboxPath }) {
  const { proposalGate, parseProposal, readHeldIssues, readOutbox, ownerLoginOf } = triage();
  const failures = [];
  const push = (code, detail) => { if (!failures.some((entry) => entry.code === code && entry.detail === detail)) failures.push({ code, detail }); };
  const owner = ownerLoginOf(tenantConfig);
  const proposalComment = issue.comments.find((comment) => comment.url && comment.url === open.commentUrl) || null;
  const outbox = readOutbox(outboxPath ? path.resolve(outboxPath) : path.join(baseOf(root), 'state', 'watch', 'wake-outbox.jsonl'));
  const gate = proposalGate({ issue, row, proposal: proposalComment, approval: null, config, tenantConfig, tenant, outbox, consumedThrough: projection.consumedThrough, holds: readHeldIssues(root, tenant, at) });
  for (const failure of gate) {
    // The gate's own "premises" (a block of at least one verified line) is replaced by the stricter
    // body-matching check below. Its edited-after-approval code stays (with no approval it means the comment was edited
    // after it was posted), beside the bounded proposal-edited (edited after it was recorded).
    if (failure.code === 'premises') continue;
    push(failure.code, failure.detail);
  }
  if (gate.some((failure) => failure.code === 'no-open-proposal')) return failures;
  if (open.reason) push('needs-approval', `the proposal is a ${open.reason} restatement, which still needs Approval (ADR 0011)`);
  const today = assignment.chicagoDay(new Date(at).getTime());
  const todays = entries.filter((entry) => entry.kind === 'bounded-ready' && assignment.chicagoDay(new Date(entry.at).getTime()) === today).length;
  if (todays >= DAILY_CAP) push('daily-cap', `${todays} bounded readies are recorded for ${tenant} on ${today} (Central); the cap is ${DAILY_CAP}`);
  if (entries.some((entry) => Number(entry.issue) === number && (entry.kind === 'bounded-ready' || entry.kind === 'veto'))) push('bounded-once', `issue #${number} already had a bounded ready or a Veto; a bounded attempt is made once per issue, and after it the issue is Cory's`);
  // The floor is the earlier of the ledger's time and the comment's own, so a proposal recorded with a later --now cannot hide an owner comment.
  const spokeFloor = Math.min(Date.parse(open.at), proposalComment ? Date.parse(proposalComment.createdAt) : Infinity);
  if (Date.parse(open.at) > Date.parse(at) + 60000) push('proposal-in-future', `the ledger says the proposal was recorded at ${open.at}, after now (${at})`);
  if (issue.comments.some((comment) => String(comment.author).toLowerCase() === owner.toLowerCase() && Date.parse(comment.createdAt) > spokeFloor)) push('owner-spoke', `${owner} commented after the proposal, and what he said is his to answer (an Approval, a question, a change), not the door's`);
  if (hasWorkRecord(root, tenant, number)) push('live-work', `a Work record ${tenant}:issue-${number} exists; a bounded ready is for a ticket nothing has worked on`);
  const openEdges = issue.blockedBy.filter((edge) => edge.state !== 'CLOSED');
  if (openEdges.length || issue.blockedByTruncated) push('blocked', openEdges.length ? `blocked by open ${openEdges.map((edge) => `#${edge.number}`).join(', ')}` : 'the blocked-by list is truncated');
  if (!proposalComment) return failures;
  if (proposalComment.lastEditedAt && Date.parse(proposalComment.lastEditedAt) > Date.parse(open.at)) push('proposal-edited', `the proposal comment was edited at ${proposalComment.lastEditedAt}, after it was recorded at ${open.at}`);
  const parsed = parseProposal(proposalComment.body);
  if (exact(parsed, 'Classification') !== 'bug') push('classification', `Classification is "${(parsed.fields.Classification || 'missing').split('\n').join(' / ')}", not exactly "bug"`);
  if (exact(parsed, 'Ruling') !== 'none needed') push('ruling-needed', `Ruling is "${(parsed.fields.Ruling || 'missing').split('\n').join(' / ')}", not exactly "none needed" (the fix goes under Root cause and Scope)`);
  for (const [name, code] of [['Red-tell', 'no-red-tell'], ['Repro', 'no-repro']]) {
    const value = String(parsed.fields[name] || '').trim();
    if (!value || PLACEHOLDER.test(value)) push(code, `${name} is ${value ? `"${value}"` : 'missing'}; a bounded bug names a reproducible Red-tell and the Repro steps`);
  }
  for (const failure of checkPremises({ proposal: parsed, issue, premisesSha: open.premisesSha })) push(failure.code, failure.detail);
  const scope = checkScope({ scope: parsed.fields.Scope, tenantConfig, repo });
  for (const failure of scope.failures) push(failure.code, failure.detail);
  return Object.assign(failures, { proposal: parsed, proposalComment, scopeFiles: scope.files });
}

// edits: [['--add-label', name], ['--remove-label', name]], applied in one gh call.
function ghEdit({ runner, tenantConfig, number, edits }) {
  const args = ['issue', 'edit', String(number), '-R', String(tenantConfig.github)];
  for (const [flag, label] of edits) args.push(flag, label);
  runner('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 });
}

// The Central wall clock of an instant, for pages and the summary: 2026-09-29 12:00 Central.
function centralClock(ms) {
  const p = assignment.chicagoParts(ms);
  return `${assignment.chicagoDay(ms)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} Central`;
}

function tierWord(value) { return String(value || '').split('\n')[0].trim().split(/\s+/)[0].toLowerCase(); }

// Order (rulings m2, m3): page, then the ledger row, then the label. A page that fails records
// nothing and the next tick retries (a ready Cory was never told of is no Veto window at all).
// The row must exist before the label, since the planner reads it to hold the ticket. A label
// that fails leaves a standing row with no ready label: the frontier lists it as `bounded-repair`,
// and running this door again re-applies the label, records nothing and pages nothing.
function boundedReady({ root, tenant, issue: issueValue, tenantConfigPath, fixture, issues, now, runner = execFileSync, send, effects = true, repo, outboxPath } = {}) {
  const { readLedger, projectTriage, recordEntry, readTenantConfig, ownerLoginOf, readTriageConfig } = triage();
  const number = issueNumberOf(issueValue);
  if (!tenant) throw new WorkStateError('TRIAGE_INVALID', 'tenant is required');
  const at = isoOf(now);
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  const owner = ownerLoginOf(tenantConfig);
  // Gate 1: Cory's flag. Read before any GitHub call, so an unenabled tenant (Nidus) costs nothing.
  if (!isBoundedEnabled(root, tenant)) {
    throw refused([{ code: 'flag-absent', detail: `Bounded authority is not enabled for ${tenant}: state/flags/bounded-authority-${safeTenant(tenant)} does not exist, and only Cory creates it` }]);
  }
  const loaded = loadIssues({ tenantConfig, fixture, issues, runner });
  const all = loaded.issues;
  const found = all.find((entry) => entry.number === number);
  if (!found) throw refused([{ code: 'issue-not-found', detail: `issue #${number} is not among ${tenant}'s open issues` }]);
  // Gate 2: a standing suspension, lifted only by removing its file. The scan comes first, so
  // failure evidence that arrived since the last one is on file before the ready is judged.
  const scanned = scanSuspension({ root, tenant, issues: loadEscapeBugs({ tenantConfig, fixture, issues: fixture || issues ? all : undefined, runner }), now: at, dryRun: !effects });
  if (isSuspended(root, tenant) || scanned.suspended) {
    throw refused([{ code: 'suspended', detail: `Bounded authority is suspended for ${tenant} (state/flags/bounded-authority-suspended-${safeTenant(tenant)}); only removing that file lifts it` }]);
  }

  const config = readTriageConfig(root);
  const readyLabel = tenantConfig.readyLabel || 'ready-for-agent';
  const entries = readLedger(root, tenant);
  const standing = assignment.liveBoundedReadies(entries).get(number);
  if (standing) {
    // A bounded ready is already recorded. Only its missing label is repaired, and only while the owner has said nothing since.
    // The repair is of this ticket as it was when it was readied: a body changed since, or a newer proposal, is not it.
    if (entries.some((entry) => entry.kind === 'proposed' && Number(entry.issue) === number && String(entry.at) > String(standing.at))) throw refused([{ code: 'bounded-once', detail: `a newer proposal than the bounded ready at ${standing.at} exists; an issue is readied under Bounded authority once` }]);
    if (found.bodyHash !== standing.bodyHash) throw refused([{ code: 'body-changed', detail: `the issue body changed since the bounded ready at ${standing.at}` }]);
    if (found.labels.includes(readyLabel)) throw refused([{ code: 'bounded-once', detail: `issue #${number} already has its bounded ready (${standing.at}) and carries ${readyLabel}` }]);
    // Only a row that records Cory was paged is repaired: a row without that is not a ready he was told of.
    if (standing.paged !== true) throw refused([{ code: 'unpaged-ready', detail: `the bounded-ready row at ${standing.at} does not record that Cory was paged, so it is not repaired into a ready label` }]);
    if (found.comments.some((comment) => String(comment.author).toLowerCase() === owner.toLowerCase() && Date.parse(comment.createdAt) > Date.parse(standing.at))) throw refused([{ code: 'owner-spoke', detail: `${owner} commented after the bounded ready at ${standing.at}; the repair is left` }]);
    const barred = found.labels.filter((label) => [...config.routingLabels, 'held', 'haiku-rehearsal', tenantConfig.escalationLabel].filter(Boolean).includes(label));
    if (barred.length) throw refused([{ code: 'labels', detail: `issue #${number} carries ${barred.join(', ')}, so the ready label is not re-applied` }]);
    const hold = triage().readHeldIssues(root, tenant, at).get(number);
    if (hold) throw refused([{ code: 'held', detail: hold }]);
    if (hasWorkRecord(root, tenant, number)) throw refused([{ code: 'live-work', detail: `a Work record ${tenant}:issue-${number} exists` }]);
    const result = { tenant, issue: number, repaired: true, readied: false, at, source: fixture ? 'fixture' : 'github', labelApplied: false, paged: false };
    if (!effects) return result;
    try { ghEdit({ runner, tenantConfig, number, edits: [['--add-label', readyLabel], ...(found.labels.includes(config.markerLabel) ? [['--remove-label', config.markerLabel]] : [])] }); } catch (error) {
      throw new WorkStateError('GITHUB_WRITE_FAILED', `re-applying ${readyLabel} to #${number} failed (${String(error.stderr || error.message || error).slice(0, 200)}); run the door again`, { issue: number });
    }
    return { ...result, labelApplied: true };
  }

  const projection = projectTriage({ entries, now: at, windowDays: config.windowDays, graduation: config.graduation });
  const row = projection.byIssue[number] || null;
  const open = row && row.proposed && !row.outcome ? row.proposed : null;
  if (!open) throw refused([{ code: 'no-open-proposal', detail: `issue #${number} has no open proposal in the ledger (none recorded, or its outcome is already recorded)` }]);
  const failures = boundedFailures({ root, tenant, number, issue: found, row, open, entries, projection, config, tenantConfig, repo: repo || loaded.repo || gitRepo(tenantConfig), at, outboxPath });
  if (failures.length) throw refused(failures);

  const window = assignment.vetoWindow(at);
  const proposalHash = assignment.sha256(failures.proposalComment.body);
  const paths = failures.scopeFiles;
  const result = { tenant, issue: number, readied: true, at, windowUntil: window.until, windowRule: window.rule, source: fixture ? 'fixture' : 'github', labelApplied: false, paged: false };
  const detail = { scope: paths, tier: tierWord(failures.proposal.fields.Tier), proposalHash };
  // With effects off (a fixture run) NOTHING is recorded: a row written by a rehearsal is a row a live run could act on (QA B-1). The entry it would have written is returned.
  if (!effects) return { ...result, recorded: false, entry: { schemaVersion: 1, kind: 'bounded-ready', tenant, at, actor: 'principal', issue: number, bodyHash: found.bodyHash, commentUrl: open.commentUrl, ...detail, paged: false } };
  const page = {
    kind: 'bounded-ready',
    title: `Fleet: ${tenant} #${number} readied under Bounded authority`,
    body: `${found.title}. The Principal readied it itself, with no Approval. Nothing assigns it before ${centralClock(window.untilMs)}. A comment beginning "Veto" on the issue withdraws it; removing the label by hand does not.`,
    priority: 'normal',
    url: found.url,
  };
  const sender = send || require('./notify').pageSender({ root });
  let sent;
  try { sent = sender(page); } catch (error) { sent = { ok: false, detail: `send threw: ${String(error.message || error).slice(0, 200)}` }; }
  if (!sent || !sent.ok) throw refused([{ code: 'page-failed', detail: `the page to Cory was not delivered (${(sent && sent.detail) || 'no detail'}); nothing was recorded, and the next tick tries again` }]);
  result.paged = true;
  result.pageDetail = sent.detail || null;
  result.entry = recordEntry({ root, tenant, kind: 'bounded-ready', issue: number, bodyHash: found.bodyHash, commentUrl: open.commentUrl, fields: { ...detail, paged: true, pageDetail: sent.detail || null }, now: at });
  result.recorded = true;
  try {
    ghEdit({ runner, tenantConfig, number, edits: [['--add-label', readyLabel], ...(found.labels.includes(config.markerLabel) ? [['--remove-label', config.markerLabel]] : [])] });
  } catch (error) {
    throw new WorkStateError('GITHUB_WRITE_FAILED', `the bounded ready of #${number} is recorded and Cory was paged, but applying ${readyLabel} failed (${String(error.stderr || error.message || error).slice(0, 200)}); the frontier lists it as bounded-repair, and running this door again re-applies the label`, { issue: number, entry: result.entry });
  }
  result.labelApplied = true;
  return result;
}

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
  const found = loadIssues({ tenantConfig, fixture, issues, runner }).issues.find((entry) => entry.number === number);
  if (!found) throw new WorkStateError('TRIAGE_INVALID', `issue #${number} is not among ${tenant}'s open issues`);
  const veto = found.comments.filter((comment) => comment.author.toLowerCase() === owner.toLowerCase() && assignment.VETO_RE.test(comment.body) && Date.parse(comment.createdAt) > Date.parse(standing.at)).pop();
  if (!veto) throw new WorkStateError('TRIAGE_NO_VETO', `issue #${number} has no comment from ${owner} beginning "Veto" after the bounded ready at ${standing.at}`);
  const config = readTriageConfig(root);
  const readyLabel = tenantConfig.readyLabel || 'ready-for-agent';
  const result = { tenant, issue: number, vetoed: true, at, source: fixture ? 'fixture' : 'github', labelChanged: false, recorded: false };
  if (!effects) return { ...result, entry: { schemaVersion: 1, kind: 'veto', tenant, at, actor: 'principal', issue: number, by: owner, ...(veto.url ? { commentUrl: veto.url } : {}) } };
  {
    try {
      ghEdit({ runner, tenantConfig, number, edits: [['--remove-label', readyLabel], ['--add-label', config.markerLabel]] });
    } catch (error) {
      throw new WorkStateError('GITHUB_WRITE_FAILED', `removing ${readyLabel} from #${number} failed (${String(error.stderr || error.message || error).slice(0, 200)}); nothing was recorded, run the veto door again`, { issue: number });
    }
    result.labelChanged = true;
  }
  result.entry = recordEntry({ root, tenant, kind: 'veto', issue: number, by: owner, commentUrl: veto.url || undefined, now: at });
  result.recorded = true;
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
//   - a bug (open or closed, created since the first live bounded ready) whose escape names
//     a PR that delivered a bounded ticket: the issue form's "Escaped from PR #" field, else
//     the newest Ruling or proposal's `Escaped from:` line, read leniently (ruling M9).
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
// ledger rows (their evidenceIds), which are stable per cause (ruling m5), so removing the flag
// lifts the suspension for good and only new evidence suspends again.

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
// The ids name the cause, not the event: a pr-watch walk-back that re-emits a send-back for the
// same artifact re-emits the same id, which is already ruled on.
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
        found.push({ cause: 'escalation', id: `escalation:${recordId}:${CRITERIA_MARK}`, at: event.at, issue, recordId, detail: `${recordId} escalated with reason ${CRITERIA_MARK}` });
      } else if (event.type === 'state-revision' && event.changes && event.changes.sendBack === true && lastReview && artifactHasCategory(root, lastReview.changes && lastReview.changes.artifact, CRITERIA_MARK)) {
        found.push({ cause: 'send-back', id: `send-back:${recordId}:${lastReview.changes.artifact}`, at: event.at, issue, recordId, detail: `${recordId} sent back after a finding of category ${CRITERIA_MARK} in ${lastReview.changes.artifact}` });
      }
    }
  }
  return found;
}

// The PR a bug says it escaped from: the form field first, else the newest Ruling or proposal.
function escapedPrOf(issue) {
  const { parseEscapedFrom } = require('./weekly-scorecard');
  const form = parseEscapedFrom(issue.body);
  if (form !== null) return form;
  const headed = issue.comments.filter((comment) => /^\s*##\s*(?:Triage proposal|Ruling)\b/i.test(comment.body)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const newest = headed[headed.length - 1];
  const line = newest && /^Escaped from:[ \t]*(.*?)[ \t]*\r?$/im.exec(newest.body);
  const number = line && /(?:PR\s*)?#?(\d+)/i.exec(line[1]);
  return number ? Number(number[1]) : null;
}

function escapeEvidence({ tenant, live, events, issues }) {
  const prToIssue = new Map();
  for (const issue of live.keys()) {
    for (const event of events) {
      const pr = event.recordId === `${tenant}:issue-${issue}` && event.changes && event.changes.prNumber;
      if (pr) prToIssue.set(Number(pr), issue);
    }
  }
  const oldest = [...live.values()].map((entry) => new Date(entry.at).getTime()).sort((a, b) => a - b)[0];
  const found = [];
  for (const bug of issues) {
    if (!bug.labels.includes('bug') || Date.parse(bug.createdAt) < oldest) continue;
    const pr = escapedPrOf(bug);
    const boundedIssue = pr === null ? null : prToIssue.get(pr);
    if (!boundedIssue || boundedIssue === bug.number) continue;
    found.push({ cause: 'escape', id: `escape:${bug.number}:${pr}`, at: bug.createdAt, issue: boundedIssue, bug: bug.number, pr, detail: `bug #${bug.number} escaped from PR #${pr}, which delivered bounded ticket #${boundedIssue}` });
  }
  return found;
}

// Bugs, open or closed, newest first (the ones created since a bounded ready are the ones that can have escaped from it).
const ESCAPE_QUERY = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(first:100,states:[OPEN,CLOSED],labels:["bug"],orderBy:{field:CREATED_AT,direction:DESC}){nodes{number,title,url,body,createdAt,state,labels(first:20){nodes{name}},comments(last:100){nodes{id,url,body,createdAt,author{login}}}}}}}';

function queryEscapeBugs({ repo, runner = execFileSync } = {}) {
  const { normalizeIssue } = triage();
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new WorkStateError('INVALID_GITHUB_QUERY', `repo must be owner/name: ${repo}`);
  let result;
  try { result = JSON.parse(runner('gh', ['api', 'graphql', '-f', `query=${ESCAPE_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 })); } catch (error) {
    throw new WorkStateError('GITHUB_QUERY_FAILED', String(error.stderr || error.message || error));
  }
  const nodes = result && result.data && result.data.repository && result.data.repository.issues && result.data.repository.issues.nodes;
  if (!Array.isArray(nodes)) throw new WorkStateError('GITHUB_QUERY_FAILED', 'GitHub GraphQL bug query did not return nodes');
  return nodes.map((node) => normalizeIssue(node));
}

// The bugs the scan reads: a fixture's or a caller's issues as given, else GitHub's bugs, open and closed.
function loadEscapeBugs({ tenantConfig, fixture, issues, runner }) {
  if (issues) return issues;
  if (fixture) return loadIssues({ tenantConfig, fixture, runner }).issues;
  return queryEscapeBugs({ repo: tenantConfig.github, runner });
}

// Read the evidence, and suspend on any not already ruled on. `issues` are the tenant's bugs
// (the escape check reads them); without them only the local evidence counts.
function scanSuspension({ root, tenant, issues, now, events, dryRun = false } = {}) {
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
    ...(issues ? escapeEvidence({ tenant, live, events: ledgerEvents, issues: issues.map((entry) => normalizeIssue(entry)) }) : []),
  ].filter((item) => !ruledOn.has(item.id)).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  if (!found.length) return result;
  // A dry run (a fixture) reports what it would suspend on and writes neither the flag nor the row.
  if (dryRun) return { ...result, suspended: true, wrote: false, dryRun: true, evidence: found };
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

// The CLI door: load the tenant's bugs (a fixture, or GitHub) and scan.
function boundedScan({ root, tenant, tenantConfigPath, fixture, issues, now, runner = execFileSync } = {}) {
  const { readTenantConfig } = triage();
  if (!tenant) throw new WorkStateError('TRIAGE_INVALID', 'tenant is required');
  const tenantConfig = readTenantConfig(root, tenant, tenantConfigPath);
  return scanSuspension({ root, tenant, issues: loadEscapeBugs({ tenantConfig, fixture, issues, runner }), now, dryRun: Boolean(fixture) });
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
    try { issues = loadTenantIssues ? loadTenantIssues(tenant, config) : queryEscapeBugs({ repo: config.github }); } catch (error) { issuesError = String(error.message || error).split('\n')[0]; }
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
  centralClock,
  checkScope,
  chicagoDay: assignment.chicagoDay,
  gitRepo,
  isBoundedEnabled,
  isSuspended,
  liveBoundedReadies: assignment.liveBoundedReadies,
  queryEscapeBugs,
  scanSuspension,
  scanTenants,
  standingSuspensions,
  suspensionFlagPath,
  vetoReady,
  vetoWindow: assignment.vetoWindow,
};
