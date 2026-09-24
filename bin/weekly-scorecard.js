'use strict';
// #131 (spec #91): the weekly scorecard. Each Monday (bin/install-weekly-scorecard-task.ps1
// via bin/run-weekly-scorecard.ps1) it writes the audit's eight rows for the previous
// Monday-to-Sunday UTC week (bin/report-week.js) to state/metrics/scorecard-<monday>.md
// and .json. Sources, each bounded:
//   - the event ledger: throughput, cycle time (reserve to merge), the issue-to-merge tail
//     (first ledger event to merge, with the hours spent in hold or escalated), units sent
//     back at least once, and the review gate (formal and risk reviews recorded, and merges
//     with no formal review at the merged head, the verify-events.js rule; acknowledged
//     ones from config/review-exceptions.json counted separately);
//   - GitHub: each tenant's `bug` issues opened that week, read for the bug form's
//     "### Escaped from PR #" heading (endzone, fleet #130), and the named PR's head branch
//     (a fleet PR's starts with the tenant's branchPrefix). A bug with no number there is
//     unclassified; before the form lands the row reads 0 classified with N unclassified,
//     which is a true reading. A GitHub failure makes the row `unknown`, never a zero;
//   - the watchdog shadow log (state/sentinel/shadow/*.jsonl): `fleet-dead` ticks over
//     total ticks;
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
  ['icCost', 'IC cost'],
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

function escapedRow(base, week, merged, settings, gh) {
  const tenants = Object.entries(workState.readTenantConfigs(base)).filter(([, config]) => config && config.github);
  const bugs = [];
  try {
    for (const [name, config] of tenants) {
      const listed = JSON.parse(gh(['issue', 'list', '-R', config.github, '--label', 'bug', '--state', 'all', '--search', `created:${week.monday}..${week.sunday}`, '--json', 'number,createdAt,body', '--limit', '200']));
      for (const issue of listed) bugs.push({ tenant: name, repo: config.github, prefix: config.branchPrefix || 'fleet/', number: issue.number, pr: parseEscapedFrom(issue.body) });
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
  const unclassified = bugs.filter((entry) => entry.pr === null).length;
  const rate = merged ? Math.round((escapedFromFleet.length / merged) * 1000) / 1000 : null;
  let status = 'good';
  if (escapedFromFleet.length && (rate === null || rate > settings.escapedRate.weak)) status = 'weak';
  else if (escapedFromFleet.length) status = 'watch';
  return {
    figures: { bugs: bugs.length, escapedFromFleet, namedNonFleet, unclassified, merged, rate },
    result: `${escapedFromFleet.length} escaped from a fleet PR${escapedFromFleet.length ? ` (${escapedFromFleet.map((e) => `#${e.issue} from PR #${e.pr}`).join(', ')})` : ''}, ${namedNonFleet.length} named another PR, ${unclassified} unclassified, of ${plural(bugs.length, 'bug')} opened${rate !== null ? `; ${pct(rate)} of ${merged} merged` : ''}`,
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

function verifyWeek(base, week) {
  const runs = readHistory(base).filter((line) => inWeek(week, line.at));
  return { runs: runs.length, pass: runs.filter((line) => line.pass === true).length, fail: runs.filter((line) => line.pass === false).length };
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
    icCost: icCostRow(base, events, week, collect, dryRun),
  };
  const rows = ROWS.map(([key, area]) => ({ key, area, ...computed[key] }));
  const weakest = rows.reduce((worst, row) => (SEVERITY[row.status] > SEVERITY[worst.status] ? row : worst), rows[0]);
  return {
    schemaVersion: 1,
    generatedAt: at,
    week,
    rows,
    verifyHistory: verifyWeek(base, week),
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
    '## IC cost (two measures)',
    '',
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

module.exports = { DEFAULTS, ROWS, WEEKLY_SCORECARD_FLAGS, WeeklyScorecardError, buildScorecard, cli, headlineOf, latestScorecard, parseEscapedFrom, renderScorecard, writeScorecard };
