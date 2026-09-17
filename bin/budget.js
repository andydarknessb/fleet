'use strict';
// Ticket 09: IC token budgets. Every active IC unit (implementing, revision, pr-open,
// ci-wait, review) is measured from its session transcript: job tokens = input + output,
// the same definition rotation-policy.js and measure-cycle.js use, so one number means one
// thing across the fleet. Cache fields are never folded in.
//
// At config/cycle.json `ic.warnTokens` (50,000) the record gets ONE budget-warning event
// carrying the measured count. At `ic.escalateTokens` (350,000) the record is escalated
// with decision evidence, unless an approved extension (work-state.js budget --phase
// extend) covers the spend; then the extension amount is the line. Escalation is a
// human decision: the transition is a decision event and pages through the notifier.
//
// Shadow unless state/flags/budget-live exists: the same decisions are computed and
// written to state/budget/shadow.jsonl, no record moves, so the fleet can see what the
// budget WOULD do before it is armed. Either way state/budget/last.json carries every
// measured figure for status and the digest. A unit without a roster session or a
// transcript is reported `unmeasured` and never escalated: an unknown spend is not
// evidence of an overspend.

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');
const { findTranscript, sumTranscriptTokens } = require('./rotation-policy');
const { parseArgs } = workState;

const DEFAULTS = Object.freeze({ warnTokens: 50000, escalateTokens: 350000 });
// hold is Cory's state and escalated is already a decision; merged and later are done.
const BUDGET_STATES = Object.freeze(['implementing', 'revision', 'pr-open', 'ci-wait', 'review']);

class BudgetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
    Object.assign(this, details);
  }
}

// fleet#4: budget.js is a single-command binary - run-pr-watch.ps1 and status.ps1
// (the only callers) invoke it as `node budget.js --root <path>`, with no subcommand
// word - so FLAGS has exactly one entry, kept as a command-keyed object per the
// fleet#4 convention the other binaries share. Before this a typo'd flag (e.g.
// --tenent, --leave instead of --live, --claude_home) fell into
// workState.parseArgs's unschema'd bucket and was silently ignored: applyBudgets
// ran anyway against the defaults, measuring and - under budget-live - escalating
// real Work records on a mistyped invocation. Dangerous in exactly one direction
// on the watch tick, so a wrong flag must refuse before any measurement or write.
const FLAGS = Object.freeze({
  tick: Object.freeze(['root', 'tenant', 'claude-home', 'now', 'live', 'no-notifier']),
});

function baseOf(root) { return path.resolve(root || path.join(__dirname, '..')); }
function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
function readJson(file, fallback) {
  try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))); } catch { return fallback; }
}

// `escalateTokens: null` is the warning-only mode (the soak Cory ruled 2026-09-09):
// warnings are recorded, nothing is ever escalated, and the summary says so.
function budgetConfig(root) {
  const ic = readJson(path.join(baseOf(root), 'config', 'cycle.json'), {}).ic || {};
  const escalate = ic.escalateTokens === null ? null : Number(ic.escalateTokens ?? DEFAULTS.escalateTokens);
  return { warnTokens: Number(ic.warnTokens ?? DEFAULTS.warnTokens), escalateTokens: escalate };
}

function isLive({ root, live } = {}) {
  if (live === true) return true;
  return fs.existsSync(path.join(baseOf(root), 'state', 'flags', 'budget-live'));
}

// The session that owns a unit: the roster row named ic-<issue> for the tenant. Manifest
// reservations carry no owner until the roster has the session, and a respawn keeps the
// session id, so the roster is the one source for both launch paths.
function rosterSession(root, tenant, issue) {
  const roster = readJson(path.join(baseOf(root), 'state', 'roster.json'), { sessions: [] });
  const rows = (Array.isArray(roster) ? roster : roster.sessions || [])
    .filter((row) => row.role === 'ic' && String(row.tenant) === String(tenant) && Number(row.issue) === Number(issue) && row.sessionId);
  const active = rows.filter((row) => row.status === 'active');
  const chosen = (active.length ? active : rows).sort((a, b) => String(b.launchedAt || '').localeCompare(String(a.launchedAt || '')))[0];
  return chosen ? { name: chosen.name, sessionId: chosen.sessionId } : null;
}

// An extension is the new ABSOLUTE escalation line, not an increment: a grant of 100,000
// means "escalate at 100,000". A grant at or below the configured line changes nothing and
// is reported as ineffective rather than silently honoured or silently ignored.
function decide({ jobTokens, record, config }) {
  const extension = record.budget?.extension;
  const warningOnly = config.escalateTokens === null || config.escalateTokens === undefined;
  const extensionIneffective = Boolean(extension) && !warningOnly && !(Number(extension.tokens) > config.escalateTokens);
  const line = warningOnly ? null : (extension && !extensionIneffective ? Number(extension.tokens) : config.escalateTokens);
  const base = { extension: extension || null, extensionIneffective, warningOnly };
  if (!warningOnly && jobTokens >= line) return { ...base, decision: 'escalate', threshold: line };
  if (jobTokens >= config.warnTokens) return { ...base, decision: 'warn', threshold: config.warnTokens };
  return { ...base, decision: 'none', threshold: null };
}

async function applyBudgets({ root, claudeHome, tenant, now, live, actor = 'budget', notifier = null } = {}) {
  const base = baseOf(root);
  const config = budgetConfig(base);
  const mode = isLive({ root: base, live }) ? 'live' : 'shadow';
  const at = now || new Date().toISOString();
  const active = readJson(path.join(base, 'state', 'work', 'active.json'), { records: {} });
  const records = Object.values(active.records || {})
    .filter((record) => (!tenant || record.tenant === tenant) && BUDGET_STATES.includes(record.state))
    .sort((a, b) => a.issue - b.issue);
  const results = [];
  for (const record of records) {
    const entry = { id: record.id, issue: record.issue, state: record.state, revision: record.revision, jobTokens: null, decision: 'unmeasured', threshold: null, applied: false, reason: null };
    const session = rosterSession(base, record.tenant, record.issue);
    if (!session) { entry.reason = 'no roster session for this unit'; results.push(entry); continue; }
    entry.session = session.name;
    const transcript = findTranscript(claudeHome, session.sessionId);
    if (!transcript) { entry.reason = `transcript not found for session ${session.sessionId}`; results.push(entry); continue; }
    let totals;
    try { totals = await sumTranscriptTokens(transcript); } catch (error) { entry.reason = `transcript unreadable: ${error.message}`; results.push(entry); continue; }
    entry.jobTokens = totals.jobTokens;
    const verdict = decide({ jobTokens: totals.jobTokens, record, config });
    entry.decision = verdict.decision;
    entry.threshold = verdict.threshold;
    entry.extension = verdict.extension ? { tokens: verdict.extension.tokens, by: verdict.extension.by } : null;
    entry.extensionIneffective = verdict.extensionIneffective;
    entry.warningOnly = verdict.warningOnly;
    entry.warnedAt = record.budget?.warnedAt || null;
    if (mode === 'live' && verdict.decision !== 'none') {
      try {
        let revision = record.revision;
        if (!record.budget?.warnedAt) {
          const warned = workState.recordBudget({ root: base, id: record.id, expectedRevision: revision, phase: 'warn', tokens: totals.jobTokens, threshold: config.warnTokens, idempotencyKey: `budget-warning:${record.id}`, actor, now: at, evidence: `budget: ${totals.jobTokens} job tokens >= ${config.warnTokens} (session ${session.name})` });
          revision = warned.revision;
          entry.applied = true;
        }
        if (verdict.decision === 'escalate') {
          const extensionText = verdict.extension
            ? `extension ${verdict.extension.tokens} by ${verdict.extension.by} (${verdict.extension.reason})${verdict.extensionIneffective ? ', ineffective: at or below the configured line' : ''}`
            : 'no extension';
          const moved = workState.transitionRecord({
            root: base, id: record.id, expectedRevision: revision, to: 'escalated', actor, now: at,
            idempotencyKey: `budget-escalated:${record.id}:${verdict.threshold}`,
            evidence: `wake:decision-needed; budget: ${totals.jobTokens} job tokens >= ${verdict.threshold}; ${extensionText}; session ${session.name}; grant one with work-state.js budget --phase extend, then resolve the escalation`,
          });
          if (!moved.replayed) {
            entry.applied = true;
            if (notifier) { try { notifier({ root: base, recordId: record.id, sequence: moved.eventSequence }); } catch (error) { entry.notifierError = String(error.message || error); } }
          }
        }
      } catch (error) {
        entry.error = `${error.code || 'ERROR'}: ${error.message}`;
      }
    }
    results.push(entry);
  }
  const dir = path.join(base, 'state', 'budget');
  fs.mkdirSync(dir, { recursive: true });
  const summary = { at, mode, tenant: tenant || null, config, records: results };
  fs.writeFileSync(path.join(dir, 'last.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  // The shadow log is day-partitioned like every other shadow surface, and a tick with
  // nothing to measure writes nothing: 288 empty lines a day are not evidence.
  if (mode === 'shadow' && results.length > 0) {
    const shadowDir = path.join(dir, 'shadow');
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.appendFileSync(path.join(shadowDir, `${at.slice(0, 10).replace(/-/g, '')}.jsonl`), `${JSON.stringify(summary)}\n`, 'utf8');
  }
  return summary;
}

function parseCliArgs(argv) {
  const command = 'tick';
  const flags = FLAGS[command];
  if (!flags) throw new BudgetError('USAGE', `unknown command '${command}'; commands: ${Object.keys(FLAGS).join(', ')}`);
  try {
    return parseArgs(argv, flags);
  } catch (error) {
    if (error.code === 'USAGE') throw new BudgetError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
}

async function cli(argv) {
  // Refuse before any measurement or write (fleet#4): parseCliArgs runs and
  // either throws or returns before applyBudgets does any I/O.
  const args = parseCliArgs(argv);
  const base = baseOf(args.root);
  let tenant = args.tenant || null;
  if (!tenant) {
    const files = fs.readdirSync(path.join(base, 'tenants')).filter((f) => f.endsWith('.json'));
    tenant = files.length === 1 ? path.basename(files[0], '.json') : null;
  }
  const home = args['claude-home'] || path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
  const summary = await applyBudgets({ root: base, claudeHome: home, tenant, now: args.now, live: args.live === 'true', notifier: args['no-notifier'] === 'true' ? null : require('./notify').spawnNotifier });
  return { at: summary.at, mode: summary.mode, measured: summary.records.filter((r) => r.jobTokens !== null).length, unmeasured: summary.records.filter((r) => r.decision === 'unmeasured').length, warn: summary.records.filter((r) => r.decision === 'warn').length, escalate: summary.records.filter((r) => r.decision === 'escalate').length, applied: summary.records.filter((r) => r.applied).length, errors: summary.records.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`) };
}

if (require.main === module) {
  cli(process.argv.slice(2)).then((digest) => {
    process.stdout.write(`${JSON.stringify(digest)}\n`);
  }).catch((error) => {
    if (error.code === 'USAGE') {
      // A refused invocation writes nothing to stdout and exits 2, so a caller
      // reading only the status cannot mistake it for a measured tick (fleet#4,
      // mirroring review-policy.js classify's fleet#2 fix).
      process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { BUDGET_STATES, BudgetError, FLAGS, applyBudgets, budgetConfig, cli, decide, isLive, rosterSession };
