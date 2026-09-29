'use strict';
// #131 (spec #91): the weekly scorecard. Each Monday (bin/install-weekly-scorecard-task.ps1
// via bin/run-weekly-scorecard.ps1) it writes the audit's rows for the previous
// Monday-to-Sunday UTC week (bin/report-week.js) to state/metrics/scorecard-<monday>.md
// and .json. Sources, each bounded:
//   - the event ledger: throughput, cycle time (reserve to merge), the issue-to-merge tail
//     (first ledger event to merge, with the hours spent in hold or escalated), units sent
//     back at least once, and the review gate (formal and risk reviews recorded, and merges
//     with no formal review at the merged head, the verify-events.js rule; acknowledged
//     ones from config/review-exceptions.json counted separately);
//   - GitHub: each tenant's `bug` issues opened that week, read for the bug form's
//     "### Escaped from PR #" heading (endzone, fleet #130), and the named PR's head branch
//     (a fleet PR's starts with the tenant's branchPrefix). A bug whose form field is empty
//     (every Nidus bug) is read from its newest `## Ruling` or `## Triage proposal` comment's `Escaped from:` line (#213:
//     `#<PR>`, `none` or `unknown`). A bug with neither, or marked unknown, is
//     unclassified, and the row says how many; before the form lands the row reads 0 classified with N unclassified,
//     which is a true reading. A GitHub failure makes the row `unknown`, never a zero;
//   - the watchdog shadow log (state/sentinel/shadow/*.jsonl): `fleet-dead` ticks over
//     total ticks;
//   - #214: the page log's human-wait rows (state/pages/pages.jsonl) with the same watchdog
//     ticks, for "Waiting on Cory" (project lead and Principal session-hours and episodes,
//     the dispatcher's relays left out); the roster and its retired-row archive for "IC idle
//     share" (no IC running, fleet-wide and per tenant, and at the IC cap). Both are reported,
//     not judged, until a threshold is ruled: their status is n/a;
//   - #215: the event ledger again, for "Review pickup latency" (per unit, the record
//     entering review to the first formal review recorded, median and p90 for the week the
//     review landed in; reported, not judged);
//   - the cycle collector (bin/measure-cycle.js run for exactly this week): whole-life IC
//     job tokens per model family and the risk reviewer, printed beside bin/budget.js's
//     warnings and escalations for the week as a separate measure (#127).
// The week's ledger verification history (state/verify/history.jsonl, #129) is printed
// under the table. Each row carries a status (good, watch, weak, unknown, n/a) from the
// thresholds in config/cycle.json `scorecard`; the headline is the week and its weakest
// row, which bin/daily-summary.js adds to its page.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const workState = require('./work-state');
const { inWeek, previousWeek } = require('./report-week');
const { readHistory, reviewFinding, stateAfter } = require('./verify-events');
const { meterChange } = require('./transcript-usage');

class WeeklyScorecardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WeeklyScorecardError';
    this.code = code;
    Object.assign(this, details);
  }
}

const WEEKLY_SCORECARD_FLAGS = ['root', 'now', 'dry-run'];
const HOUR_MS = 60 * 60 * 1000;
const DEFAULTS = Object.freeze({
  cycleTimeMedianHours: { watch: 2, weak: 6 },
  tailHours: 12,
  waitTickMinutes: 15,
  waitGapMinutes: 35,
  icCap: 3,
  sentBackRate: { watch: 0.3, weak: 0.45 },
  escapedRate: { weak: 0.05 },
  fleetDeadRate: { watch: 0.02, weak: 0.1 },
  maxPrLookups: 50,
});
const ROWS = [
  ['throughput', 'Throughput'],
  ['cycleTime', 'Cycle time'],
  ['issueToMergeTail', 'Issue-to-merge tail'],
  ['sentBack', 'Sent back at least once'],
  ['reviewGate', 'Review gate'],
  ['escapedDefects', 'Escaped defects'],
  ['availability', 'Availability'],
  ['waitingOnCory', 'Waiting on Cory'],
  ['icIdleShare', 'IC idle share'],
  ['reviewPickup', 'Review pickup latency'],
  ['icCost', 'IC cost'],
  ['boundedAuthority', 'Bounded authority'],
];
const SEVERITY = { weak: 4, unknown: 3, watch: 2, good: 1, 'n/a': 0 };

function baseOf(root) { return path.resolve(root || path.join(__dirname, '..')); }
function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch { return fallback; }
}
function hours(ms) { return Math.round((ms / HOUR_MS) * 10) / 10; }
function pct(rate) { return `${Math.round(rate * 1000) / 10}%`; }
function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }
function issueOf(recordId) { const match = String(recordId).match(/issue-(\d+)$/); return match ? Number(match[1]) : null; }

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (fraction === 0.5 && sorted.length % 2 === 0) return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function settingsOf(base) {
  const cycle = readJson(path.join(base, 'config', 'cycle.json'), {});
  return { ...DEFAULTS, ...(cycle.scorecard || {}) };
}

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000 });
}

// A dry run writes nothing under state/: its collector output goes to a temp directory.
// measure-cycle.js is required here, not at the top, so bin/daily-summary.js (which reads
// this module for the headline) never loads the collector.
function defaultCollect({ base, week, dryRun = false }) {
  const { collectFromFiles } = require('./measure-cycle');
  const os = require('node:os');
  return collectFromFiles({
    rosterPath: path.join(base, 'state', 'roster.json'),
    outputDir: dryRun ? fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-scorecard-collector-')) : path.join(base, 'state', 'metrics', 'scorecard', 'collector'),
    tenantConfigsDir: path.join(base, 'tenants'),
    configPath: path.join(base, 'config', 'cycle.json'),
    since: week.start,
    until: week.end,
    generatedAt: week.end,
  }).summaryReport;
}

// Every record snapshot the ledger knows: active, archived, released, abandoned.
function recordSnapshots(base) {
  const records = new Map();
  const active = readJson(path.join(base, 'state', 'work', 'active.json'), { records: {} });
  for (const record of Object.values(active.records || {})) records.set(record.id, record);
  for (const dir of ['archive', 'releases', 'abandons']) {
    const full = path.join(base, 'state', dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full).filter((entry) => /^work-.*\.json$/.test(entry))) {
      const record = readJson(path.join(full, name), null)?.record;
      if (record?.id && !records.has(record.id)) records.set(record.id, record);
    }
  }
  return records;
}

function reviewExceptions(base) {
  const listed = readJson(path.join(base, 'config', 'review-exceptions.json'), { exceptions: [] }).exceptions || [];
  return listed.filter((entry) => entry && typeof entry.recordId === 'string' && typeof entry.head === 'string' && typeof entry.ruling === 'string' && entry.ruling.trim());
}

function isSendBack(event) {
  if (event.type !== 'state-revision') return false;
  if (event.changes?.sendBack !== undefined) return event.changes.sendBack === true;
  return event.changes?.from === 'review';
}

// One entry per record merged in the week: its merge, reservation, first event, the
// hours it spent in a decision state before the merge, and its send-backs.
function mergedUnits(events, week) {
  const byRecord = new Map();
  for (const event of events) {
    if (!byRecord.has(event.recordId)) byRecord.set(event.recordId, []);
    byRecord.get(event.recordId).push(event);
  }
  const units = [];
  for (const [recordId, list] of byRecord) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sequence - b.sequence);
    const merge = list.filter((event) => event.type === 'state-merged' && inWeek(week, event.at)).pop();
    if (!merge) continue;
    const mergeMs = Date.parse(merge.at);
    const before = list.filter((event) => Date.parse(event.at) <= mergeMs);
    const reserved = before.filter((event) => event.type === 'assignment-reserved').pop()
      || before.find((event) => ['work-created', 'shadow-projected'].includes(event.type)) || before[0];
    let state = null;
    let enteredMs = null;
    let decisionMs = 0;
    for (const event of before) {
      const next = stateAfter(event);
      if (!next) continue;
      const atMs = Date.parse(event.at);
      if (workState.DECISION_STATES.includes(state) && enteredMs !== null) decisionMs += atMs - enteredMs;
      state = next;
      enteredMs = atMs;
    }
    const sendBacks = before.filter(isSendBack).length;
    units.push({
      recordId,
      issue: issueOf(recordId),
      events: list,
      mergeAt: merge.at,
      mergedBy: merge.changes?.mergedBy || null,
      cycleMs: mergeMs - Date.parse(reserved.at),
      endToEndMs: mergeMs - Date.parse(before[0].at),
      decisionMs,
      sendBacks,
    });
  }
  return units.sort((a, b) => a.issue - b.issue);
}

function statusByThreshold(value, { watch, weak }) {
  if (value === null || value === undefined) return 'n/a';
  if (weak !== undefined && value >= weak) return 'weak';
  if (watch !== undefined && value > watch) return 'watch';
  return 'good';
}

function ledgerRows(base, events, week, settings) {
  const units = mergedUnits(events, week);
  const merged = units.length;
  const rows = {};
  rows.throughput = {
    figures: { merged, perDay: Math.round((merged / 7) * 10) / 10 },
    result: `${plural(merged, 'unit')} merged, ${Math.round((merged / 7) * 10) / 10} a day`,
    status: merged === 0 ? 'weak' : 'good',
  };
  const cycles = units.map((unit) => hours(unit.cycleMs));
  const slowest = units.slice().sort((a, b) => b.cycleMs - a.cycleMs)[0] || null;
  const median = percentile(cycles, 0.5);
  rows.cycleTime = {
    figures: { units: merged, medianHours: median === null ? null : Math.round(median * 10) / 10, p90Hours: percentile(cycles, 0.9), maxHours: slowest ? hours(slowest.cycleMs) : null, maxIssue: slowest ? slowest.issue : null },
    result: merged ? `reserve to merge (n=${merged}): median ${Math.round(median * 10) / 10} h, p90 ${percentile(cycles, 0.9)} h, max ${hours(slowest.cycleMs)} h (#${slowest.issue})` : 'no unit merged',
    status: merged ? (median > settings.cycleTimeMedianHours.weak ? 'weak' : (median > settings.cycleTimeMedianHours.watch ? 'watch' : 'good')) : 'n/a',
  };
  const tail = units.filter((unit) => unit.endToEndMs > settings.tailHours * HOUR_MS)
    .map((unit) => ({ issue: unit.issue, hours: hours(unit.endToEndMs), decisionHours: hours(unit.decisionMs) }));
  rows.issueToMergeTail = {
    figures: { thresholdHours: settings.tailHours, units: tail },
    result: tail.length
      ? `${plural(tail.length, 'unit')} over ${settings.tailHours} h from first ledger event to merge: ${tail.map((u) => `#${u.issue} ${u.hours} h, ${u.decisionHours} h waiting on a decision`).join('; ')}`
      : `none over ${settings.tailHours} h from first ledger event to merge`,
    status: tail.length ? 'watch' : 'good',
  };
  const sentBack = units.filter((unit) => unit.sendBacks > 0);
  const most = sentBack.slice().sort((a, b) => b.sendBacks - a.sendBacks || a.issue - b.issue)[0] || null;
  const rate = merged ? Math.round((sentBack.length / merged) * 1000) / 1000 : null;
  rows.sentBack = {
    figures: { units: sentBack.length, of: merged, rate, maxSendBacks: most ? most.sendBacks : 0, maxIssue: most ? most.issue : null },
    result: merged ? `${sentBack.length} of ${merged} units (${pct(rate)})${most ? `; most send-backs ${most.sendBacks} (#${most.issue})` : ''}` : 'no unit merged',
    status: statusByThreshold(rate, settings.sentBackRate),
  };
  const reviews = events.filter((event) => event.type === 'review-recorded' && inWeek(week, event.at));
  const formal = reviews.filter((event) => event.changes?.kind === 'formal').length;
  const risk = reviews.filter((event) => event.changes?.kind === 'risk').length;
  const snapshots = recordSnapshots(base);
  const exceptions = reviewExceptions(base);
  const without = [];
  const acknowledged = [];
  for (const unit of units) {
    const outcome = reviewFinding(snapshots.get(unit.recordId) || { id: unit.recordId }, unit.events, exceptions);
    if (outcome?.finding) without.push(unit.issue);
    if (outcome?.acknowledged) acknowledged.push(unit.issue);
  }
  rows.reviewGate = {
    figures: { formal, risk, mergedWithoutReview: without, acknowledged },
    result: `${formal} formal + ${risk} risk reviews; merged without a formal review at the merged head: ${without.length ? without.map((n) => `#${n}`).join(', ') : 'none'}${acknowledged.length ? `; acknowledged by a ruling: ${acknowledged.map((n) => `#${n}`).join(', ')}` : ''}`,
    status: without.length ? 'weak' : 'good',
  };
  return { rows, merged };
}

// The bug form's "Escaped from PR #" field: the first number under that heading, up to
// the next heading. `_No response_` (the form's blank) or no heading at all is null.
function parseEscapedFrom(body) {
  const match = String(body || '').match(/^###\s*Escaped from PR #[ \t]*\r?\n([\s\S]*?)(?=^###\s|(?![\s\S]))/m);
  if (!match) return null;
  const number = match[1].match(/#?(\d+)/);
  return number ? Number(number[1]) : null;
}

// #213 (spec #193): a bug's Triage proposal (agents/principal.md) carries an `Escaped from:`
// line whose value is exactly `#<PR number>`, `none` or `unknown`. It is read for bugs whose
// form field is empty, which is every Nidus bug (no form). Only the newest comment headed
// `## Ruling` or `## Triage proposal` counts (a Ruling restates the proposal, and a later
// one is the last word), and only an exact value: a comment without the line, or with
// anything after the value, classifies nothing. #211 parses the same `Escaped from: #<n>` shape.
const PROPOSAL_HEADING_RE = /^\s*##\s*(?:Triage proposal|Ruling)\b/i;
const PROPOSAL_ESCAPED_RE = /^Escaped from:[ \t]*(?:#(\d+)|(none|unknown))[ \t]*\r?$/im;
function parseProposalEscapedFrom(comments) {
  const proposals = (Array.isArray(comments) ? comments : [])
    .filter((comment) => comment && PROPOSAL_HEADING_RE.test(String(comment.body || '')))
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  const newest = proposals[proposals.length - 1];
  if (!newest) return null;
  const match = String(newest.body).match(PROPOSAL_ESCAPED_RE);
  if (!match) return null;
  return match[1] ? { kind: 'pr', pr: Number(match[1]) } : { kind: match[2].toLowerCase() };
}

// The form's number wins; with none, the proposal's line. { pr, kind, source } where kind is
// 'none' or 'unknown' when there is no PR to name and null when nothing classifies the bug.
function classifyEscape(issue) {
  const form = parseEscapedFrom(issue.body);
  if (form !== null) return { pr: form, kind: null, source: 'form' };
  const proposal = parseProposalEscapedFrom(issue.comments);
  if (!proposal) return { pr: null, kind: null, source: null };
  return { pr: proposal.kind === 'pr' ? proposal.pr : null, kind: proposal.kind === 'pr' ? null : proposal.kind, source: 'proposal' };
}

function escapedRow(base, week, merged, settings, gh) {
  const tenants = Object.entries(workState.readTenantConfigs(base)).filter(([, config]) => config && config.github);
  const bugs = [];
  try {
    for (const [name, config] of tenants) {
      const listed = JSON.parse(gh(['issue', 'list', '-R', config.github, '--label', 'bug', '--state', 'all', '--search', `created:${week.monday}..${week.sunday}`, '--json', 'number,createdAt,body,comments', '--limit', '200']));
      for (const issue of listed) bugs.push({ tenant: name, repo: config.github, prefix: config.branchPrefix || 'fleet/', number: issue.number, ...classifyEscape(issue) });
    }
  } catch (error) {
    return { figures: { error: String(error.message || error).split('\n')[0] }, result: `unavailable: ${String(error.message || error).split('\n')[0]}`, status: 'unknown' };
  }
  const escapedFromFleet = [];
  const namedNonFleet = [];
  let lookups = 0;
  for (const bug of bugs.filter((entry) => entry.pr !== null)) {
    let head = null;
    if (lookups < settings.maxPrLookups) {
      lookups += 1;
      try { head = JSON.parse(gh(['pr', 'view', String(bug.pr), '-R', bug.repo, '--json', 'number,headRefName'])).headRefName || null; } catch { head = null; }
    }
    if (head && head.startsWith(bug.prefix)) escapedFromFleet.push({ issue: bug.number, pr: bug.pr });
    else namedNonFleet.push(head ? { issue: bug.number, pr: bug.pr } : { issue: bug.number, pr: bug.pr, unverified: true });
  }
  // #213: `none` is a classification (no PR introduced the bug); `unknown` and a bug nothing classifies are not.
  const none = bugs.filter((entry) => entry.kind === 'none').map((entry) => entry.number);
  const unknown = bugs.filter((entry) => entry.kind === 'unknown').length;
  const unclassified = bugs.filter((entry) => entry.pr === null && entry.kind !== 'none').length;
  const fromProposal = bugs.filter((entry) => entry.source === 'proposal' && (entry.pr !== null || entry.kind === 'none')).length;
  const rate = merged ? Math.round((escapedFromFleet.length / merged) * 1000) / 1000 : null;
  let status = 'good';
  if (escapedFromFleet.length && (rate === null || rate > settings.escapedRate.weak)) status = 'weak';
  else if (escapedFromFleet.length) status = 'watch';
  return {
    figures: { bugs: bugs.length, escapedFromFleet, namedNonFleet, none, unknown, fromProposal, unclassified, merged, rate },
    result: `${escapedFromFleet.length} escaped from a fleet PR${escapedFromFleet.length ? ` (${escapedFromFleet.map((e) => `#${e.issue} from PR #${e.pr}`).join(', ')})` : ''}, ${namedNonFleet.length} named another PR, ${none.length} traced to no PR, ${unclassified} unclassified${unknown ? ` (${unknown} marked unknown)` : ''}, of ${plural(bugs.length, 'bug')} opened${rate !== null ? `; ${pct(rate)} of ${merged} merged` : ''}`,
    status,
  };
}

function availabilityRow(base, week, settings) {
  const dir = path.join(base, 'state', 'sentinel', 'shadow');
  let ticks = 0;
  let dead = 0;
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.jsonl')).sort()) {
      for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let tick;
        try { tick = JSON.parse(line); } catch { continue; }
        if (!inWeek(week, tick.at)) continue;
        ticks += 1;
        if (Array.isArray(tick.conditions) && tick.conditions.includes('fleet-dead')) dead += 1;
      }
    }
  }
  if (!ticks) return { figures: { ticks: 0, fleetDeadTicks: 0, rate: null }, result: 'no watchdog tick recorded in the week', status: 'unknown' };
  const rate = Math.round((dead / ticks) * 1000) / 1000;
  return {
    figures: { ticks, fleetDeadTicks: dead, rate },
    result: `fleet-dead on ${dead} of ${ticks} watchdog ticks (${pct(rate)})`,
    status: rate > settings.fleetDeadRate.weak ? 'weak' : (rate > settings.fleetDeadRate.watch ? 'watch' : 'good'),
  };
}

// #214 (spec #195): how long the fleet waits on Cory. The source is the page log's
// human-wait rows (state/pages/pages.jsonl), which the Watchdog writes once per tick
// while a session's `needs` stands and Pushover is unconfigured or failing, and ONCE
// when a page is delivered (a delivered page is deduped, so the row stops repeating and
// the page log alone would read a delivered wait as one tick). So a wait's extent also
// reads the Watchdog's own ticks (state/sentinel/shadow/*.jsonl: the directory name is
// historical, the log is written on every tick in live mode too), which list every standing
// `human-wait:<session>` condition on every tick. An episode is a run of ticks of one session
// with no gap over waitGapMinutes; it runs from its first tick to its last tick plus one
// tick, clipped to the week. The ask text does not split an episode: a delivered page
// writes no new row while its key stands, so a reworded ask would split episodes in the
// weeks before Pushover and not after. The first row's text is kept as the episode's body.
// These are DETECTED waits: human-wait fires only once a session has been stale past the
// watchdog threshold, so a wait is measured from its first tick, not from when the ask began.
// The row is unknown when no Watchdog tick falls in the week. Only the shadow files named
// for the days around the week, and the rows within a day of it, are read.
// The dispatcher relays the project leads' asks upward in its own words, and adds asks of
// its own (audit F2). Its waits are counted apart, in dispatcherWaits, and left out of the row:
// on the audit's window (2026-09-23T21:17Z to 09-29) leaving them out reads 57% of the time
// with a project lead or Principal waiting, and counting them reads 71%, the audit's two
// figures. Only project leads and Principals are counted.
const DAY_MS = 24 * HOUR_MS;
const WAITING_ROLES = ['project-lead', 'principal'];

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const rows = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return rows;
}

function roleOfSession(name, rosterRoles) {
  if (rosterRoles.has(name)) return rosterRoles.get(name);
  if (name === 'dispatcher') return 'dispatcher';
  if (name.startsWith('pl-')) return 'project-lead';
  if (name.startsWith('pe-')) return 'principal';
  if (name.startsWith('ic-')) return 'ic';
  return null;
}

function waitEpisodes(observations, { tickMs, gapMs }) {
  const episodes = [];
  for (const [name, list] of observations) {
    list.sort((a, b) => a.ms - b.ms);
    let current = null;
    for (const seen of list) {
      const body = seen.body === null ? null : String(seen.body).trim();
      if (!current || seen.ms - current.last > gapMs) { current = { name, start: seen.ms, last: seen.ms, body }; episodes.push(current); continue; }
      current.last = Math.max(current.last, seen.ms);
      if (current.body === null) current.body = body;
    }
  }
  // An episode ends one tick after its last tick, or where the same session's next one starts,
  // so one session never overlaps itself even with a tick length above the gap.
  return episodes.map((episode, index) => {
    const next = episodes[index + 1];
    const end = episode.last + tickMs;
    return { name: episode.name, start: episode.start, end: next && next.name === episode.name ? Math.min(end, next.start) : end, body: episode.body || '' };
  });
}

function unionMs(intervals) {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of intervals.slice().sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

function waitingOnCoryRow(base, week, settings) {
  const pageRows = readJsonl(path.join(base, 'state', 'pages', 'pages.jsonl'));
  const starts = (pageRows || []).map((row) => Date.parse(row?.at || '')).filter(Number.isFinite);
  if (!starts.length) return { figures: { logStart: null }, result: 'no page log (state/pages/pages.jsonl) to read waits from', status: 'unknown' };
  const logStart = Math.min(...starts);
  const logStartText = (pageRows.find((row) => Date.parse(row?.at || '') === logStart) || {}).at;
  if (logStart >= Date.parse(week.end)) return { figures: { logStart: logStartText }, result: `page log starts ${String(logStartText).slice(0, 16)}, after the week`, status: 'unknown' };
  const observations = new Map();
  const observe = (name, ms, body) => { if (!observations.has(name)) observations.set(name, []); observations.get(name).push({ ms, body }); };
  for (const row of pageRows) {
    const key = String(row?.detail?.key || '');
    const at = Date.parse(row?.at || '');
    if (row?.kind === 'human-wait' && key.startsWith('human-wait:') && at >= Date.parse(week.start) - DAY_MS && at < Date.parse(week.end) + DAY_MS) observe(key.slice('human-wait:'.length), at, row.body ?? '');
  }
  const weekStart = Date.parse(week.start);
  const weekEnd = Date.parse(week.end);
  const readFrom = weekStart - DAY_MS;
  const readTo = weekEnd + DAY_MS;
  const shadowDir = path.join(base, 'state', 'sentinel', 'shadow');
  let ticksInWeek = 0;
  for (const name of fs.existsSync(shadowDir) ? fs.readdirSync(shadowDir).filter((entry) => /^\d{8}\.jsonl$/.test(entry)).sort() : []) {
    const day = Date.parse(`${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T00:00:00Z`);
    if (!Number.isFinite(day) || day + DAY_MS <= readFrom || day >= readTo) continue;
    for (const tick of readJsonl(path.join(shadowDir, name)) || []) {
      const ms = Date.parse(tick?.at || '');
      if (!Number.isFinite(ms)) continue;
      if (ms >= weekStart && ms < weekEnd) ticksInWeek += 1;
      if (!Array.isArray(tick.conditions)) continue;
      for (const condition of tick.conditions) if (String(condition).startsWith('human-wait:')) observe(String(condition).slice('human-wait:'.length), ms, null);
    }
  }
  if (!ticksInWeek) return { figures: { logStart: logStartText, ticks: 0 }, result: 'no Watchdog tick recorded in the week, so the waits cannot be measured', status: 'unknown' };
  const rosterRoles = new Map();
  for (const row of readJson(path.join(base, 'state', 'roster.json'), { sessions: [] }).sessions || []) if (row?.name && row.role) rosterRoles.set(row.name, String(row.role));
  const tickMs = settings.waitTickMinutes * 60000;
  const episodes = waitEpisodes(observations, { tickMs, gapMs: settings.waitGapMinutes * 60000 })
    .map((episode) => ({ ...episode, role: roleOfSession(episode.name, rosterRoles) }));
  const clipped = (episode) => Math.max(0, Math.min(episode.end, weekEnd) - Math.max(episode.start, weekStart));
  const counted = [];
  const dispatcher = { episodes: 0, ms: 0 };
  for (const episode of episodes.filter((entry) => clipped(entry) > 0)) {
    if (episode.role === 'dispatcher') {
      if (episode.start >= weekStart) dispatcher.episodes += 1;
      dispatcher.ms += clipped(episode);
    } else if (WAITING_ROLES.includes(episode.role)) counted.push(episode);
  }
  const bySession = {};
  for (const episode of counted) {
    const entry = bySession[episode.name] || (bySession[episode.name] = { role: episode.role, ms: 0, episodes: 0 });
    entry.ms += clipped(episode);
    if (episode.start >= weekStart) entry.episodes += 1;
  }
  const sessionMs = counted.reduce((sum, episode) => sum + clipped(episode), 0);
  const anyMs = unionMs(counted.map((episode) => [Math.max(episode.start, weekStart), Math.min(episode.end, weekEnd)]));
  const weekHours = (weekEnd - weekStart) / HOUR_MS;
  const total = Object.values(bySession).reduce((sum, entry) => sum + entry.episodes, 0);
  const share = Math.round((anyMs / HOUR_MS / weekHours) * 1000) / 1000;
  const partial = logStart > weekStart ? `; page log starts ${String(logStartText).slice(0, 16)}, the hours before it are unrecorded` : '';
  return {
    figures: {
      sessionHours: hours(sessionMs),
      episodes: total,
      bySession: Object.fromEntries(Object.entries(bySession).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, { role: entry.role, hours: hours(entry.ms), episodes: entry.episodes }])),
      dispatcherWaits: { episodes: dispatcher.episodes, hours: hours(dispatcher.ms) },
      anyWaitingHours: hours(anyMs),
      anyWaitingShare: share,
      weekHours,
      logStart: logStartText,
    },
    result: `at least one project lead or Principal waiting ${hours(anyMs)} of ${weekHours} h (${pct(share)}); ${hours(sessionMs)} session-hours in ${plural(total, 'episode')}, excluding the dispatcher's ${plural(dispatcher.episodes, 'episode')} (${hours(dispatcher.ms)} h)${partial}`,
    status: 'n/a',
  };
}

// #214 (spec #195): how often ICs sit idle, from the roster and its retired-row archive
// (the sessions a rotation or retirement replaced), the same merge the cycle collector
// makes (measure-cycle.js mergeSessionRows: a session in both counts once, as its live
// row). An IC runs from launchedAt to retiredAt, and to the week's end while its row is
// still live. Everything is clipped to THIS week's window and measured against the whole
// week (168 h), not against the span the archive happens to cover: the archive reaches
// back to the first launch, so an unclipped run or a whole-history denominator reads a
// week that opened with ICs already running, or one the archive barely covers, wrong.
// The IC cap is what the launch door leaves for ICs: the static roster's (<root>/roster.json)
// `cap` less the static sessions the cap counts (cap.exemptNamePrefixes in config/cycle.json,
// the Principal's `pe-`, neither count toward it nor are refused by it; absent config exempts
// nothing). Only when that roster is unreadable does `scorecard.icCap` stand in.
function icCapOf(base, settings) {
  const staticRoster = readJson(path.join(base, 'roster.json'), null);
  const cap = Number(staticRoster?.cap);
  if (Number.isFinite(cap) && Array.isArray(staticRoster.sessions)) {
    const exempt = ((readJson(path.join(base, 'config', 'cycle.json'), {}) || {}).cap || {}).exemptNamePrefixes;
    const prefixes = Array.isArray(exempt) ? exempt.map(String).filter(Boolean) : [];
    const counted = staticRoster.sessions.filter((row) => row?.name && !prefixes.some((prefix) => String(row.name).startsWith(prefix))).length;
    if (cap - counted >= 1) return { cap: cap - counted, source: 'roster', label: `roster cap ${cap} less ${plural(counted, 'static session')}` };
  }
  return { cap: settings.icCap, source: 'config', label: 'config scorecard.icCap' };
}

function icIdleRow(base, week, settings) {
  const { loadRetiredRows, mergeSessionRows } = require('./measure-cycle');
  const roster = readJson(path.join(base, 'state', 'roster.json'), null);
  const retired = loadRetiredRows(path.join(base, 'state', 'archive', 'roster-retired-full.jsonl'));
  // The archive only holds retired rows: without the live roster the ICs running now are unknown.
  const liveRows = Array.isArray(roster) ? roster : (Array.isArray(roster?.sessions) ? roster.sessions : null);
  if (!liveRows) return { figures: { sources: 0 }, result: 'no readable state/roster.json to read the running ICs from', status: 'unknown' };
  const icCap = icCapOf(base, settings);
  const weekStart = Date.parse(week.start);
  const weekEnd = Date.parse(week.end);
  const runs = [];
  for (const row of mergeSessionRows(liveRows, retired.rows)) {
    if (String(row.role || '').toLowerCase() !== 'ic') continue;
    const from = Date.parse(row.launchedAt || row.startedAt || '');
    const ended = Date.parse(row.retiredAt || '');
    const to = Number.isFinite(ended) ? ended : (String(row.status || '').toLowerCase() === 'retired' ? NaN : weekEnd);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const clippedFrom = Math.max(from, weekStart);
    const clippedTo = Math.min(to, weekEnd);
    if (clippedTo > clippedFrom) runs.push({ tenant: row.tenant || null, from: clippedFrom, to: clippedTo });
  }
  const tenants = [...new Set([...Object.keys(workState.readTenantConfigs(base)), ...runs.map((run) => run.tenant).filter(Boolean)])].sort();
  // Sweep the run edges: the time in the week with at least `atLeast` ICs running.
  const sweep = (list, atLeast) => {
    const edges = list.flatMap((run) => [[run.from, 1], [run.to, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let running = 0;
    let cursor = weekStart;
    let ms = 0;
    for (const [at, delta] of edges) {
      if (running >= atLeast) ms += at - cursor;
      cursor = at;
      running += delta;
    }
    if (running >= atLeast) ms += weekEnd - cursor;
    return ms;
  };
  const weekMs = weekEnd - weekStart;
  const weekHours = weekMs / HOUR_MS;
  const share = (ms) => Math.round((ms / weekMs) * 1000) / 1000;
  const idleMs = weekMs - sweep(runs, 1);
  const atCapMs = sweep(runs, icCap.cap);
  const byTenant = {};
  for (const tenant of tenants) {
    const tenantIdle = weekMs - sweep(runs.filter((run) => run.tenant === tenant), 1);
    byTenant[tenant] = { noIcHours: hours(tenantIdle), noIcShare: share(tenantIdle) };
  }
  return {
    figures: { weekHours, noIcHours: hours(idleMs), noIcShare: share(idleMs), byTenant, icCap: icCap.cap, icCapSource: icCap.source, atCapHours: hours(atCapMs), atCapShare: share(atCapMs), runs: runs.length },
    result: `no IC running ${pct(share(idleMs))} of the week${tenants.length ? ` (${tenants.map((tenant) => `${tenant} ${pct(byTenant[tenant].noIcShare)}`).join(', ')})` : ''}; at the cap of ${icCap.cap} (${icCap.label}) for ${pct(share(atCapMs))}`,
    status: 'n/a',
  };
}

// #215 (spec #195): review pickup latency, per unit: from the Work record entering `review`
// to the first formal review recorded in that stay, the wait for a lead to pick a settled PR
// up. Both come from the ledger (a `state-review` event, then a `review-recorded` formal;
// the door records a formal review only while the record is in review). A stay that ends in
// a send-back or a merge with no formal review is not a sample; a unit's sample is its first
// stay that got one. The week is the week the formal review landed in, so a unit that
// entered review on a Sunday night is measured in the week its review came. The wake outbox
// line for the settled PR is written in the same pr-watch pass as the `state-review` event,
// so the entry time here is also the wake line's time; the one-time split between that line
// and the Watchdog tick that delivered it (#215's note) is a measurement, not a row.
function reviewPickups(events) {
  const byRecord = new Map();
  for (const event of events) {
    if (!byRecord.has(event.recordId)) byRecord.set(event.recordId, []);
    byRecord.get(event.recordId).push(event);
  }
  const samples = [];
  const enteredReview = [];
  for (const [recordId, list] of byRecord) {
    list.sort((a, b) => a.sequence - b.sequence);
    let stayStart = null;
    let answered = false;
    let sample = null;
    for (const event of list) {
      const next = stateAfter(event);
      if (event.type === 'review-recorded' && event.changes?.kind === 'formal' && stayStart !== null && !answered) {
        answered = true;
        if (!sample) sample = { recordId, issue: issueOf(recordId), enteredAt: stayStart, reviewedAt: event.at, ms: Date.parse(event.at) - Date.parse(stayStart) };
      }
      if (!next) continue;
      if (next === 'review') { if (stayStart === null) { stayStart = event.at; answered = false; enteredReview.push({ recordId, at: event.at }); } } else { stayStart = null; answered = false; }
    }
    if (sample) samples.push(sample);
  }
  return { samples, enteredReview };
}

function reviewPickupRow(events, week) {
  const { samples, enteredReview } = reviewPickups(events);
  const answeredRecords = new Set(samples.map((sample) => sample.recordId));
  const inWeekSamples = samples.filter((sample) => inWeek(week, sample.reviewedAt)).sort((a, b) => a.issue - b.issue);
  const noFormal = new Set(enteredReview.filter((entry) => inWeek(week, entry.at) && !answeredRecords.has(entry.recordId)).map((entry) => entry.recordId)).size;
  const minutes = inWeekSamples.map((sample) => Math.round((sample.ms / 60000) * 10) / 10);
  const median = percentile(minutes, 0.5);
  const p90 = percentile(minutes, 0.9);
  const slowest = inWeekSamples.slice().sort((a, b) => b.ms - a.ms || a.issue - b.issue)[0] || null;
  const figures = {
    units: inWeekSamples.length,
    medianMinutes: median === null ? null : Math.round(median * 10) / 10,
    p90Minutes: p90,
    maxMinutes: slowest ? Math.round((slowest.ms / 60000) * 10) / 10 : null,
    maxIssue: slowest ? slowest.issue : null,
    noFormal,
    samples: inWeekSamples.map((sample, index) => ({ issue: sample.issue, minutes: minutes[index] })),
  };
  return {
    figures,
    result: inWeekSamples.length
      ? `n=${inWeekSamples.length} units with a formal review in the week: median ${figures.medianMinutes} min, p90 ${p90} min, max ${figures.maxMinutes} min (#${slowest.issue}); ${plural(noFormal, 'unit')} entered review and got none`
      : `no formal review recorded in the week; ${plural(noFormal, 'unit')} entered review and got none`,
    status: 'n/a',
  };
}

function icCostRow(base, events, week, collect, dryRun) {
  const budget = {
    warnings: events.filter((event) => event.type === 'budget-warning' && inWeek(week, event.at)).length,
    escalations: events.filter((event) => event.type === 'state-escalated' && /budget:/.test(String(event.evidence || '')) && inWeek(week, event.at)).length,
  };
  let report;
  try { report = collect({ base, week, dryRun }); } catch (error) {
    return { figures: { collector: { error: String(error.message || error).split('\n')[0] }, budget }, result: `collector unavailable: ${String(error.message || error).split('\n')[0]}; budget.js ${budget.warnings} warning(s), ${budget.escalations} escalation(s)`, status: 'unknown' };
  }
  const u = report?.unitMetrics || {};
  const byModel = u.icByModel || {};
  const collector = { units: u.completedUnits ?? null, medianJobTokens: u.icJobTokensMedian ?? null, p90JobTokens: u.icJobTokensP90 ?? null, byModel, riskReviewer: report?.riskReviewer || null };
  const judged = Object.values(byModel).filter((entry) => entry.pass !== null && entry.pass !== undefined);
  const status = judged.some((entry) => entry.pass === false) ? 'weak' : (judged.length ? 'good' : 'n/a');
  return {
    figures: { collector, budget },
    result: `whole-life: ${Object.keys(byModel).length ? Object.entries(byModel).map(([key, entry]) => `${key} median ${entry.jobTokensMedian ?? 'n/a'} (${plural(entry.units, 'unit')})`).join(', ') : 'no completed unit'}, reported not judged; budget.js ${budget.warnings} warning(s), ${budget.escalations} escalation(s)`,
    status,
  };
}

// Spec fleet #193 (#211): how Bounded authority was used, from the triage ledger's own
// kinds: bounded readies, vetoes and suspensions recorded in the week (a scan that found
// evidence while a suspension already stood is logged with standing: true and is not a
// second suspension), plus any suspension flag still standing. A suspension, in the week or
// still standing, is weak: it is the authority's own failure evidence. A veto is watch: it
// can be about timing, and suspends nothing. Used with neither is good; not used is n/a.
function boundedAuthorityRow(base, week) {
  const dir = path.join(base, 'state', 'triage');
  const byTenant = {};
  if (fs.existsSync(dir)) {
    const { readLedger } = require('./triage');
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.jsonl')).sort()) {
      const tenant = name.slice(0, -'.jsonl'.length);
      const counts = { readied: 0, vetoed: 0, suspended: 0 };
      for (const entry of readLedger(base, tenant)) {
        if (!inWeek(week, entry.at)) continue;
        if (entry.kind === 'bounded-ready') counts.readied += 1;
        else if (entry.kind === 'veto') counts.vetoed += 1;
        else if (entry.kind === 'suspended' && entry.standing !== true) counts.suspended += 1;
      }
      if (counts.readied || counts.vetoed || counts.suspended) byTenant[tenant] = counts;
    }
  }
  const total = Object.values(byTenant).reduce((sum, counts) => ({ readied: sum.readied + counts.readied, vetoed: sum.vetoed + counts.vetoed, suspended: sum.suspended + counts.suspended }), { readied: 0, vetoed: 0, suspended: 0 });
  const standing = require('./bounded-authority').standingSuspensions(base).map((entry) => entry.tenant);
  const used = total.readied || total.vetoed || total.suspended || standing.length;
  let status = 'n/a';
  if (standing.length || total.suspended) status = 'weak';
  else if (total.vetoed) status = 'watch';
  else if (used) status = 'good';
  return {
    figures: { ...total, standing, byTenant },
    result: `${total.readied} readied under Bounded authority, ${total.vetoed} vetoed, ${plural(total.suspended, 'suspension')}${standing.length ? `; suspension standing: ${standing.join(', ')}` : ''}`,
    status,
  };
}

function verifyWeek(base, week) {
  const runs = readHistory(base).filter((line) => inWeek(week, line.at));
  return { runs: runs.length, pass: runs.filter((line) => line.pass === true).length, fail: runs.filter((line) => line.pass === false).length };
}

// Spec fleet #93 / #155: who merged into the default branch this week, the owner
// or the fleet (ADR 0015). A merge whose login is both (a tenant that still names
// the owner as its fleetIdentity) is counted as shared, since it cannot say which;
// a merge event with no mergedBy (recorded before #155) is unrecorded.
function tenantLogins(base) {
  const logins = {};
  let names = [];
  try { names = fs.readdirSync(path.join(base, 'tenants')).filter((name) => name.endsWith('.json')); } catch { names = []; }
  for (const name of names) {
    const config = readJson(path.join(base, 'tenants', name), {}) || {};
    logins[path.basename(name, '.json')] = { owner: String(config.ownerLogin || '').toLowerCase(), fleet: String(config.fleetIdentity || '').toLowerCase() };
  }
  return logins;
}

function mergesBy(base, units) {
  const logins = tenantLogins(base);
  const counts = { owner: 0, fleet: 0, shared: 0, other: 0, unrecorded: 0 };
  const others = [];
  for (const unit of units) {
    const login = String(unit.mergedBy || '').toLowerCase();
    const tenant = logins[String(unit.recordId).split(':')[0]] || { owner: '', fleet: '' };
    if (!login) counts.unrecorded += 1;
    else if (login === tenant.owner && login === tenant.fleet) counts.shared += 1;
    else if (login === tenant.owner) counts.owner += 1;
    else if (login === tenant.fleet) counts.fleet += 1;
    else { counts.other += 1; others.push(unit.mergedBy); }
  }
  return { ...counts, merged: units.length, otherLogins: [...new Set(others)] };
}

function mergesByLine(figures) {
  if (!figures) return null;
  const parts = [`${figures.owner} by the owner`, `${figures.fleet} by the fleet`];
  if (figures.shared) parts.push(`${figures.shared} by a login the owner and the fleet share`);
  if (figures.other) parts.push(`${figures.other} by another login (${figures.otherLogins.join(', ')})`);
  if (figures.unrecorded) parts.push(`${figures.unrecorded} with no merger recorded`);
  return `Merges into the default branch this week: ${parts.join(', ')}.`;
}

function buildScorecard({ root, now, gh = defaultGh, collect = defaultCollect, dryRun = false } = {}) {
  const base = baseOf(root);
  const at = now || new Date().toISOString();
  const week = previousWeek(at);
  const settings = settingsOf(base);
  const events = workState.readEvents(base);
  const { rows: ledger, merged } = ledgerRows(base, events, week, settings);
  const computed = {
    ...ledger,
    escapedDefects: escapedRow(base, week, merged, settings, gh),
    availability: availabilityRow(base, week, settings),
    waitingOnCory: waitingOnCoryRow(base, week, settings),
    icIdleShare: icIdleRow(base, week, settings),
    reviewPickup: reviewPickupRow(events, week),
    icCost: icCostRow(base, events, week, collect, dryRun),
    boundedAuthority: (() => {
      // A corrupt triage ledger makes this row unknown, never the whole scorecard.
      try { return boundedAuthorityRow(base, week); } catch (error) {
        return { figures: { error: String(error.message || error).split('\n')[0] }, result: `unavailable: ${String(error.message || error).split('\n')[0]}`, status: 'unknown' };
      }
    })(),
  };
  const rows = ROWS.map(([key, area]) => ({ key, area, ...computed[key] }));
  const weakest = rows.reduce((worst, row) => (SEVERITY[row.status] > SEVERITY[worst.status] ? row : worst), rows[0]);
  return {
    schemaVersion: 1,
    generatedAt: at,
    week,
    // #201: figures before this date count each model response once per transcript row.
    meterChange: meterChange(readJson(path.join(base, 'config', 'cycle.json'), {})),
    rows,
    verifyHistory: verifyWeek(base, week),
    mergesBy: mergesBy(base, mergedUnits(events, week)),
    headline: SEVERITY[weakest.status] > SEVERITY.good ? { key: weakest.key, area: weakest.area, status: weakest.status, result: weakest.result } : null,
  };
}

function headlineOf(card) {
  if (!card) return null;
  if (!card.headline) return `Scorecard ${card.week.label}: no row weaker than good`;
  return `Scorecard ${card.week.label}: weakest row ${card.headline.area} (${card.headline.status}): ${card.headline.result}`;
}

function icCostLines(row) {
  const collector = row.figures.collector || {};
  const budget = row.figures.budget || {};
  const families = Object.entries(collector.byModel || {}).map(([key, entry]) => `${key} median ${entry.jobTokensMedian ?? 'n/a'}, p90 ${entry.jobTokensP90 ?? 'n/a'} (${plural(entry.units, 'unit')})${entry.pass === true ? ' PASS' : entry.pass === false ? ' FAIL' : ''}`);
  const risk = collector.riskReviewer;
  const whole = collector.error
    ? `unavailable: ${collector.error}`
    : `${families.length ? families.join('; ') : 'no completed unit'}${risk ? `; risk reviewer ${risk.runs} run(s), ${risk.jobTokens} job tokens` : ''}`;
  return [
    `- Whole-life (cycle collector): ${whole}`,
    `- budget.js (enforcement, spending states only): ${budget.warnings ?? 0} warning(s), ${budget.escalations ?? 0} escalation(s)`,
  ];
}

function renderScorecard(card) {
  const cell = (text) => String(text).replace(/\|/g, '/').replace(/\r?\n/g, ' ');
  const lines = [
    `# Fleet weekly scorecard: ${card.week.label}`,
    '',
    `Generated ${card.generatedAt}. The week is Monday to Sunday in UTC (${card.week.start} to ${card.week.end}).`,
    '',
    '| Area | Result | Status |',
    '|---|---|---|',
    ...card.rows.map((row) => `| ${row.area} | ${cell(row.result)} | ${row.status} |`),
    '',
    `Ledger verification this week: ${card.verifyHistory.runs} run(s), ${card.verifyHistory.pass} pass, ${card.verifyHistory.fail} fail.`,
    '',
    ...(card.mergesBy ? [mergesByLine(card.mergesBy), ''] : []),
    '## IC cost (two measures)',
    '',
    ...(card.meterChange ? [card.meterChange.note, ''] : []),
    ...icCostLines(card.rows.find((row) => row.key === 'icCost')),
    '',
    `Headline: ${headlineOf(card)}`,
  ];
  return `${lines.join('\n')}\n`;
}

function scorecardPaths(base, week) {
  const dir = path.join(base, 'state', 'metrics');
  return { dir, json: path.join(dir, `scorecard-${week.monday}.json`), md: path.join(dir, `scorecard-${week.monday}.md`) };
}

function writeScorecard(options = {}) {
  const base = baseOf(options.root);
  const card = buildScorecard({ ...options, root: base });
  if (options.dryRun) return card;
  const paths = scorecardPaths(base, card.week);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.json, `${JSON.stringify(card, null, 2)}\n`, 'utf8');
  fs.writeFileSync(paths.md, renderScorecard(card), 'utf8');
  return { ...card, artifacts: paths };
}

// The newest scorecard file by name (scorecard-<monday>.json sorts by date), or null.
function latestScorecard(root) {
  const dir = path.join(baseOf(root), 'state', 'metrics');
  if (!fs.existsSync(dir)) return null;
  const newest = fs.readdirSync(dir).filter((name) => /^scorecard-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().pop();
  return newest ? readJson(path.join(dir, newest), null) : null;
}

function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, WEEKLY_SCORECARD_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new WeeklyScorecardError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  return writeScorecard({ root: args.root, now: args.now, dryRun: args['dry-run'] === 'true' });
}

if (require.main === module) {
  try {
    const card = cli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ week: card.week.label, headline: headlineOf(card), statuses: Object.fromEntries(card.rows.map((row) => [row.key, row.status])), artifacts: card.artifacts || null })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: String(error.message || error) })}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = { DEFAULTS, ROWS, WEEKLY_SCORECARD_FLAGS, WeeklyScorecardError, buildScorecard, cli, headlineOf, latestScorecard, parseEscapedFrom, parseProposalEscapedFrom, renderScorecard, writeScorecard };
