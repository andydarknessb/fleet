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

const path = require('node:path');
const workState = require('./work-state');
const { foldLedger } = require('./digest');
const { pageSender } = require('./notify');
const { headlineOf, latestScorecard } = require('./weekly-scorecard');

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

// null when nothing is waiting: the caller's job is to send nothing at all,
// not an empty page. Rows keep the ticket's plain "#issue state age" only
// while every waiting row belongs to one tenant; once they span more than
// one, each line is prefixed with its tenant (fleet#79 QA round 1, item 8) -
// decided from the FULL waiting set, before the cap, so the format never
// shifts depending on how many rows happen to be shown.
function buildSummary({ root, now } = {}) {
  const rows = waitingRows({ root, now });
  if (!rows.length) return null;
  const multiTenant = new Set(rows.map((row) => row.tenant)).size > 1;
  const shown = rows.slice(0, MAX_ROWS);
  const lines = shown.map((row) => (multiTenant
    ? `${row.tenant} #${row.issue} ${row.state} ${formatAge(row.ageMs)}`
    : `#${row.issue} ${row.state} ${formatAge(row.ageMs)}`));
  if (rows.length > MAX_ROWS) lines.push(`and ${rows.length - MAX_ROWS} more`);
  // #131: the latest weekly scorecard's headline (the week and its weakest row) rides
  // the page as its last line. No scorecard file, no line; and a scorecard alone never
  // turns a quiet day into a page (the early return above stands).
  const card = latestScorecard(root);
  if (card && card.week) lines.push(headlineOf(card));
  return {
    title: 'Fleet daily summary', body: lines.join('\n'), priority: 'normal', kind: 'daily-summary', count: rows.length,
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
function runDailySummary(options = {}) {
  const base = baseOf(options.root);
  const summary = buildSummary({ root: base, now: options.now });
  if (!summary) return { sent: false, attempted: false, count: 0 };
  if (options.dryRun) return { sent: false, attempted: false, count: summary.count, dryRun: true, summary };
  const send = options.send || pageSender({ root: base });
  let result;
  try { result = send(summary); } catch (error) { result = { ok: false, detail: `send threw: ${String(error.message || error).slice(0, 200)}` }; }
  const ok = Boolean(result && result.ok);
  return { sent: ok, attempted: true, count: summary.count, detail: (result && result.detail) || null };
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
  return (result.attempted && !result.sent) ? 1 : 0;
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
