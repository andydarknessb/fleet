'use strict';
// Ticket 80 (ADR 0012): the daily summary page. One page a day (08:00 Central,
// bin/install-daily-summary-task.ps1 via bin/run-daily-summary.ps1) listing
// every decision row still waiting on Cory - a Work record sitting in `hold`
// or `escalated` - oldest first, with how long it has been waiting. Computed
// straight from the event ledger fold digest.js already exports (foldLedger):
// state/status/DIGEST.md is a rendering of that same fold for a human to read
// at any time, never the source of anything, so this reads the ledger, not
// the markdown. Nothing waiting sends nothing: a quiet day pages nobody, and
// a page every morning regardless would train Cory to stop reading it.
// Spec fleet #193 (#211): the one standing condition that does page on a quiet day is a
// Bounded-authority suspension, which only Cory lifts; the run scans for one first.

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');
const { foldLedger } = require('./digest');
const { pageSender } = require('./notify');
const { headlineOf, latestScorecard } = require('./weekly-scorecard');
const { runStalePremiseNotice, readLedger, projectTriage, ARBITER_KINDS } = require('./triage');
const { centralClock, scanTenants, standingSuspensions } = require('./bounded-authority');
const { plannerInputs, vetoWindow } = require('./assignment');

const { DECISION_STATES } = workState;
const MAX_ROWS = 10;

class DailySummaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DailySummaryError';
    this.code = code;
    Object.assign(this, details);
  }
}

// fleet#4: this binary's one command takes no subcommand word, same shape as
// notify.js; an unrecognised flag is refused rather than silently ignored.
const DAILY_SUMMARY_FLAGS = Object.freeze(['root', 'now', 'dry-run']);

function baseOf(root) {
  return path.resolve(root || path.resolve(__dirname, '..'));
}

// Age format: "1d 2h" once a row has stood a full day (the hour dropped only
// when it is exactly zero); "3h" or "3h 25m" under a day; "45m" (or "0m") for
// a row still under an hour. A summary that pages once a day has no use for
// seconds, but a row still under an hour reads as nothing at all without
// minutes - "0h" would look like a bug, not a fresh escalation. A row with no
// parseable `enteredStateAt` (fleet#79 QA round 1, minor 9) renders "unknown"
// instead of "NaNm" - a rendering bug that would otherwise hide a real,
// possibly very old, row behind a garbled line.
function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

// Tenants recognised for this fold: every tenant with a `tenants/<name>.json`
// config, unioned with every tenant actually present in the ledger (a legacy
// or orphaned record still gets to page) - the same union digest.js's own
// `projectDigest` scopes its sections to.
function scopedTenantNames(base, rows) {
  const configs = workState.readTenantConfigs(base);
  return new Set([...Object.keys(configs), ...rows.map((row) => row.tenant).filter(Boolean)]);
}

// The raw rows a summary is built from: every currently-waiting decision row
// in the ledger fold, each carrying how long (in ms) it has stood, as of `now`.
// A row whose `enteredStateAt` cannot be parsed sorts FIRST, not last: treating
// an unknown age as "newest" would let a broken timestamp hide the row past
// the cap instead of surfacing it as the most urgent unknown.
function waitingRows({ root, now } = {}) {
  const base = baseOf(root);
  const events = workState.readEvents(base);
  const rows = [...foldLedger(events).values()].filter((row) => DECISION_STATES.includes(row.state));
  const tenantNames = scopedTenantNames(base, rows);
  const nowMs = new Date(now || Date.now()).getTime();
  return rows
    .filter((row) => tenantNames.has(row.tenant))
    .map((row) => {
      const enteredMs = new Date(row.enteredStateAt).getTime();
      return { ...row, ageMs: Number.isFinite(enteredMs) ? nowMs - enteredMs : NaN };
    })
    .sort((a, b) => {
      const ageKey = (row) => (Number.isFinite(row.ageMs) ? row.ageMs : Infinity);
      return ageKey(b) - ageKey(a) || String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue;
    });
}

// Spec fleet #193 (#209): the bounded readies still inside their Veto window, which is what
// Cory can still withdraw. A ready made overnight keeps its window open until 09:00 Central,
// so the 08:00 page lists it (ADR 0011 amendment). One line each.
function windowedReadies({ root, now }) {
  const base = baseOf(root);
  const nowMs = new Date(now || Date.now()).getTime();
  const dir = path.join(base, 'state', 'triage');
  let tenants = [];
  try { tenants = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)).sort(); } catch { return []; }
  const lines = [];
  for (const tenant of tenants) {
    let ready = [];
    try { ready = plannerInputs({ root: base, tenant }).boundedReadies; } catch { continue; }
    for (const { issue, at } of ready) {
      const window = vetoWindow(at);
      if (window && nowMs < window.untilMs) lines.push(`Bounded ready in its Veto window: ${tenant} #${issue}, readied ${centralClock(new Date(at).getTime())}, assignable from ${centralClock(window.untilMs)}. A comment beginning "Veto" withdraws it.`);
    }
  }
  return lines;
}

// ADR 0017: the Arbiter's activity per tenant since the last SENT summary (24 hours when none has been sent), from the triage ledger: how many it endorsed, endorsed with
// edits, returned and escalated, each escalation with its class and question (the owner's to answer), and whether
// state/flags/arbiter-suspended-<tenant> stands (only Cory removes it). A tenant the Arbiter did nothing for, and
// is not suspended, adds no line. Endorsements reach the owner only here (ADR 0017, decision 4).
function sentStatePath(base) { return path.join(base, 'state', 'notify', 'daily-summary.json'); }

// The instant the last summary was actually SENT (null when none has been), so a quiet day's Arbiter activity, which
// does not page, appears in the next summary that does.
function lastSentAt(base) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sentStatePath(base), 'utf8'));
    const ms = new Date(parsed.lastSentAt).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

function recordSent(base, at) {
  try {
    fs.mkdirSync(path.dirname(sentStatePath(base)), { recursive: true });
    fs.writeFileSync(sentStatePath(base), `${JSON.stringify({ schemaVersion: 1, lastSentAt: new Date(at || Date.now()).toISOString() })}
`, 'utf8');
  } catch { /* the marker is a convenience: losing it widens the next window to 24 h, never loses a page */ }
}

function arbiterLines({ root, now }) {
  const base = baseOf(root);
  const sent = lastSentAt(base);
  const sinceMs = sent !== null ? sent : new Date(now || Date.now()).getTime() - 86400000;
  const names = new Set(Object.keys(workState.readTenantConfigs(base)));
  try { for (const name of fs.readdirSync(path.join(base, 'state', 'triage'))) if (name.endsWith('.jsonl')) names.add(name.slice(0, -'.jsonl'.length)); } catch { /* no ledger yet */ }
  const lines = [];
  let anySuspended = false;
  for (const tenant of [...names].sort()) {
    let entries = [];
    try { entries = readLedger(base, tenant); } catch { continue; }
    const recent = entries.filter((entry) => ARBITER_KINDS.includes(entry.kind) && new Date(entry.at).getTime() > sinceMs);
    const count = (kind) => recent.filter((entry) => entry.kind === kind).length;
    const suspended = fs.existsSync(path.join(base, 'state', 'flags', `arbiter-suspended-${tenant}`));
    if (!recent.length && !suspended) continue;
    if (suspended) anySuspended = true;
    lines.push(`Arbiter ${tenant}, ${sent !== null ? 'since the last summary' : 'last 24 h'}: ${count('endorsed')} endorsed, ${count('endorsed-with-edits')} endorsed with edits, ${count('returned')} returned, ${count('escalated')} escalated.`);
    for (const entry of recent.filter((row) => row.kind === 'escalated')) lines.push(`Arbiter escalated ${tenant} #${entry.issue} (${entry.reason}): ${String(entry.question || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    if (suspended) lines.push(`Arbiter is suspended for ${tenant}: it posts no verdict and proposals wait for an Approval. Removing state/flags/arbiter-suspended-${tenant} lifts it.`);
  }
  return { lines, suspended: anySuspended };
}

// bin/arbiter.js (fleet PR C) owns the suspension scan; this summary works without it. A scan that throws costs the
// scan, never the summary. Its return value is reported as given under `arbiterScan`.
function scanArbiters({ root, now, scan }) {
  let run = scan;
  if (!run) { try { run = require('./arbiter.js').arbiterScan; } catch { return []; } }
  if (typeof run !== 'function') return [];
  const base = baseOf(root);
  const names = new Set(Object.keys(workState.readTenantConfigs(base)));
  // A scan that returns null has nothing to report (tests inject one so the summary never reaches gh).
  return [...names].sort().map((tenant) => {
    try { const result = run({ root: base, tenant, now }); return result === null ? null : { tenant, result }; } catch (error) { return { tenant, error: String(error.message || error).split('\n')[0] }; }
  }).filter(Boolean);
}

// One line per standing suspension: since when, why, and the one way to lift it.
function suspensionLine(entry) {
  const since = entry.at ? ` since ${String(entry.at).slice(0, 10)}` : '';
  const why = entry.detail ? `: ${String(entry.detail).replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `Bounded authority is suspended for ${entry.tenant}${since}${why}. Removing state/flags/bounded-authority-suspended-${entry.tenant} lifts it.`;
}

// Spec fleet #194 (#299): per tenant, the triage proposals still awaiting an Approval or an Arbiter verdict, oldest first.
function proposalLines({ root, now }) {
  const base = baseOf(root);
  const nowMs = new Date(now || Date.now()).getTime();
  let names = [];
  try { names = fs.readdirSync(path.join(base, 'state', 'triage')).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)).sort(); } catch { return []; }
  const lines = [];
  for (const tenant of names) {
    try {
      const pending = projectTriage({ entries: readLedger(base, tenant), now: new Date(nowMs).toISOString() }).pending
        .sort((a, b) => String(a.since).localeCompare(String(b.since)));
      if (pending.length) lines.push(`Proposals awaiting a verdict or Approval, ${tenant}: ${pending.map((row) => `#${row.issue} (since ${formatAge(nowMs - new Date(row.since).getTime())})`).join(', ')}`);
    } catch { /* a torn ledger costs this tenant's line, never the summary */ }
  }
  return lines;
}

// Spec fleet #194 (#299): the Watchdog's standing human-wait:<session> conditions, with the ask from paged.json.
function waitLines({ root, now }) {
  const base = baseOf(root);
  const nowMs = new Date(now || Date.now()).getTime();
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(base, 'state', 'watchdog', name), 'utf8').replace(/^﻿/, ''));
  let conditions = [];
  try { conditions = readJson('last-run.json').conditions || []; } catch { return []; }
  let paged = {};
  try { paged = readJson('paged.json') || {}; } catch { /* no detail recorded */ }
  return conditions.filter((condition) => typeof condition === 'string' && condition.startsWith('human-wait:')).map((condition) => {
    const entry = paged[condition] || {};
    const firstMs = new Date(entry.firstSeen).getTime();
    return `Waiting on you: ${condition.slice('human-wait:'.length)} (${formatAge(Number.isFinite(firstMs) ? nowMs - firstMs : NaN)}): ${entry.detail ? String(entry.detail).replace(/\s+/g, ' ').slice(0, 300) : 'no detail recorded'}`;
  });
}

// Spec fleet #194 (#299): per tenant, records in flight and PRs merged in the last 24 h, from the same fold waitingRows reads.
const IN_FLIGHT_STATES = Object.freeze(['assigned', 'implementing', 'pr-open', 'ci-wait', 'review', 'revision']);
function countLines({ root, now }) {
  const base = baseOf(root);
  const nowMs = new Date(now || Date.now()).getTime();
  let rows;
  try { rows = [...foldLedger(workState.readEvents(base)).values()]; } catch { return []; }
  const tenantNames = scopedTenantNames(base, rows);
  const counts = {};
  for (const row of rows) {
    if (!row.tenant || !tenantNames.has(row.tenant)) continue;
    const tally = counts[row.tenant] || (counts[row.tenant] = { inFlight: 0, merged: 0 });
    if (IN_FLIGHT_STATES.includes(row.state)) tally.inFlight += 1;
    const mergedMs = new Date(row.mergedAt).getTime();
    if (row.state === 'merged' && Number.isFinite(mergedMs) && nowMs - mergedMs <= 86400000 && nowMs >= mergedMs) tally.merged += 1;
  }
  return Object.keys(counts).sort().filter((tenant) => counts[tenant].inFlight || counts[tenant].merged)
    .map((tenant) => `${tenant}: ${counts[tenant].inFlight} in flight, ${counts[tenant].merged} merged in the last 24 h`);
}

// null when nothing is waiting: the caller's job is to send nothing at all,
// not an empty page. Rows keep the ticket's plain "#issue state age" only
// while every waiting row belongs to one tenant; once they span more than
// one, each line is prefixed with its tenant (fleet#79 QA round 1, item 8) -
// decided from the FULL waiting set, before the cap, so the format never
// shifts depending on how many rows happen to be shown.
function buildSummary({ root, now } = {}) {
  const rows = waitingRows({ root, now });
  // Spec fleet #193 (#211): a standing Bounded-authority suspension is Cory's to lift, so it
  // heads the page and is reason enough to send one on a day nothing else waits.
  const suspensions = standingSuspensions(baseOf(root));
  const windowed = windowedReadies({ root, now });
  // ADR 0017: Arbiter activity is content, never a reason to page (the owner hears only high-level decisions, and an
  // escalation already paged through the door); a standing suspension is a decision only he can make, so it is.
  const { lines: arbiter, suspended: arbiterSuspended } = arbiterLines({ root, now });
  // Spec fleet #194 (#299): proposals and open waits are Cory's to answer, so they send; the counts are content only.
  const proposals = proposalLines({ root, now });
  const waits = waitLines({ root, now });
  if (!rows.length && !suspensions.length && !windowed.length && !arbiterSuspended && !proposals.length && !waits.length) return null;
  const multiTenant = new Set(rows.map((row) => row.tenant)).size > 1;
  const shown = rows.slice(0, MAX_ROWS);
  const lines = [...suspensions.map(suspensionLine), ...arbiter, ...windowed, ...proposals, ...waits, ...countLines({ root, now })];
  lines.push(...shown.map((row) => (multiTenant
    ? `${row.tenant} #${row.issue} ${row.state} ${formatAge(row.ageMs)}`
    : `#${row.issue} ${row.state} ${formatAge(row.ageMs)}`)));
  if (rows.length > MAX_ROWS) lines.push(`and ${rows.length - MAX_ROWS} more`);
  // #131: the latest weekly scorecard's headline (the week and its weakest row) rides
  // the page as its last line. No scorecard file, no line; and a scorecard alone never
  // turns a quiet day into a page (the early return above stands).
  const card = latestScorecard(root);
  if (card && card.week) lines.push(headlineOf(card));
  return {
    title: 'Fleet daily summary', body: lines.join('\n'), priority: 'normal', kind: 'daily-summary', count: rows.length, suspensions: suspensions.length, windowed: windowed.length, arbiter: arbiter.length,
  };
}

// fleet#79 QA round 1, item 7: a failed send used to report sent:true anyway
// (result.ok was never checked), and run-daily-summary.ps1 grades the wrapper
// call on the node process's exit code alone - a dead 08:00 page would log
// INFO exit=0 like a normal quiet day. `attempted` distinguishes "nothing was
// waiting" (always a clean, successful run) from "something was waiting and
// the send itself failed" (the only case `cli`/`main` below turn into a
// non-zero exit, so the wrapper's existing exit-code-based grading catches it
// exactly like every other bin/run-*.ps1 wrapper already does).
// Spec fleet #92 (#148): the daily run is also the clock for the stale-premise
// revisit notice (bin/triage.js), a page of its own that fires once when due,
// quiet day or not; once armed it reports under `staleNotice` beside the summary's result.
function runDailySummary(options = {}) {
  const base = baseOf(options.root);
  const send = options.send || pageSender({ root: base });
  const notice = runStalePremiseNotice({ root: base, now: options.now, send, dryRun: Boolean(options.dryRun) });
  const staleNotice = notice.armed ? { staleNotice: notice } : {};
  // Spec fleet #193 (#211): scan for Bounded-authority failure evidence before summarizing, so a
  // suspension the scan writes is on this morning's page. A dry run writes nothing, so it scans
  // nothing; a scan that fails costs the scan, never the summary.
  let scanned = [];
  if (!options.dryRun) {
    try { scanned = scanTenants({ root: base, now: options.now, loadTenantIssues: options.loadTenantIssues }); } catch (error) { scanned = [{ error: String(error.message || error).split('\n')[0] }]; }
  }
  const boundedScan = scanned.length ? { boundedScan: scanned } : {};
  // ADR 0017: the Arbiter's own suspension scan (bin/arbiter.js), if that module is in the tree.
  const arbiterScanned = options.dryRun ? [] : scanArbiters({ root: base, now: options.now, scan: options.arbiterScan });
  const arbiterScan = arbiterScanned.length ? { arbiterScan: arbiterScanned } : {};
  const summary = buildSummary({ root: base, now: options.now });
  if (!summary) return { sent: false, attempted: false, count: 0, ...staleNotice, ...boundedScan, ...arbiterScan };
  if (options.dryRun) return { sent: false, attempted: false, count: summary.count, dryRun: true, summary, ...staleNotice };
  let result;
  try { result = send(summary); } catch (error) { result = { ok: false, detail: `send threw: ${String(error.message || error).slice(0, 200)}` }; }
  const ok = Boolean(result && result.ok);
  if (ok) recordSent(base, options.now);
  return { sent: ok, attempted: true, count: summary.count, detail: (result && result.detail) || null, ...staleNotice, ...boundedScan, ...arbiterScan };
}

function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, DAILY_SUMMARY_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new DailySummaryError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  return runDailySummary({ root: args.root, now: args.now, dryRun: args['dry-run'] === 'true' });
}

// The one condition that turns this binary's own exit non-zero: something was
// waiting and the attempt to send it failed. "Nothing was waiting" and
// "--dry-run" both report attempted:false and are always a clean exit. A pure
// function so the exit-code decision is unit-testable without spawning the
// real process (which would need the real pageSender - no CLI hook injects a
// fake one, and shelling out for real in a test is exactly what this suite
// must never do).
function exitCodeFor(result) {
  const failedNotice = Boolean(result.staleNotice && result.staleNotice.attempted && !result.staleNotice.sent);
  return ((result.attempted && !result.sent) || failedNotice) ? 1 : 0;
}

function main(argv) {
  const result = cli(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const code = exitCodeFor(result);
  if (code) process.exitCode = code;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    if (error.code === 'USAGE') {
      process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message, flag: error.flag, accepted: error.accepted })}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  DAILY_SUMMARY_FLAGS,
  DailySummaryError,
  buildSummary,
  cli,
  exitCodeFor,
  formatAge,
  runDailySummary,
  waitingRows,
};
