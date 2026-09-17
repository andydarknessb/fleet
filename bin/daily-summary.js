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
// minutes - "0h" would look like a bug, not a fresh escalation.
function formatAge(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

// The raw rows a summary is built from: every currently-waiting decision row
// in the ledger fold, each carrying how long (in ms) it has stood, as of `now`.
function waitingRows({ root, now } = {}) {
  const base = baseOf(root);
  const events = workState.readEvents(base);
  const rows = foldLedger(events);
  const nowMs = new Date(now || Date.now()).getTime();
  return [...rows.values()]
    .filter((row) => DECISION_STATES.includes(row.state))
    .map((row) => ({ ...row, ageMs: nowMs - new Date(row.enteredStateAt).getTime() }))
    .sort((a, b) => b.ageMs - a.ageMs || String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue);
}

// null when nothing is waiting: the caller's job is to send nothing at all,
// not an empty page.
function buildSummary({ root, now } = {}) {
  const rows = waitingRows({ root, now });
  if (!rows.length) return null;
  const shown = rows.slice(0, MAX_ROWS);
  const lines = shown.map((row) => `#${row.issue} ${row.state} ${formatAge(row.ageMs)}`);
  if (rows.length > MAX_ROWS) lines.push(`and ${rows.length - MAX_ROWS} more`);
  return {
    title: 'Fleet daily summary', body: lines.join('\n'), priority: 'normal', kind: 'daily-summary', count: rows.length,
  };
}

function runDailySummary(options = {}) {
  const base = baseOf(options.root);
  const summary = buildSummary({ root: base, now: options.now });
  if (!summary) return { sent: false, count: 0 };
  if (options.dryRun) return { sent: false, count: summary.count, dryRun: true, summary };
  const send = options.send || pageSender({ root: base });
  const result = send(summary);
  return { sent: true, count: summary.count, result };
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

function main(argv) {
  const result = cli(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
  formatAge,
  runDailySummary,
  waitingRows,
};
