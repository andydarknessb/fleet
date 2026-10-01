'use strict';

// #279 (spec #196): the Merge-fallback decision's instrument. Counts the auto-mode
// classifier's refusals by category from the harness's own tool-result text in session
// transcripts (main sessions and their subagents, the roots bin/measure-cycle.js reads),
// and the session-hours each category cost.
//
// The harness writes a refusal as a `user` row whose `tool_result` block (is_error true)
// reads: "Permission for this action was denied by the Claude Code auto mode classifier.
// Reason: [Merge Without Review]. If you have other tasks ...". The category is the
// bracketed Reason. A Reason without brackets ("Blocked by classifier", the server-side
// "gave no explanation" form) or none at all is counted as `uncategorized`. Assistant
// messages, user prompts and non-error results are never read, so a session quoting a
// refusal cannot move the count (spec #196 story 2). The same denial is also tagged
// `toolDenialKind: "automode-blocked"` on the row; that tag counts it even if the text
// ever changes, with its category read from the text when present.

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');
const measureCycle = require('./measure-cycle');

const MERGE_CATEGORY = 'Merge Without Review';
const UNCATEGORIZED = 'uncategorized';
const DENIAL_TEXT = /denied by the Claude Code auto mode classifier/;
const REASON = /Reason:\s*\[([^\]]*)\]/;
const AUTOMODE_DENIAL_KIND = 'automode-blocked';
const REFUSAL_REPORT_FLAGS = ['transcripts', 'since', 'until', 'json'];

class RefusalReportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RefusalReportError';
    this.code = code;
    Object.assign(this, details);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (typeof block === 'string' ? block : (block && typeof block.text === 'string' ? block.text : ''))).join('\n');
}

function categoryOf(text) {
  const match = String(text).match(REASON);
  const name = match ? match[1].replace(/\s+/g, ' ').trim() : '';
  return name || UNCATEGORIZED;
}

// One transcript's refusals, each with how long the session waited on it. The wait runs
// from the refusal to the session's next successful tool call or next human turn (a user
// row that is not a tool result), capped at the transcript's last timestamp.
function scanTranscript(contents, { sessionId = null } = {}) {
  const events = [];
  const refusals = [];
  let endMs = null;
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const ms = row.timestamp ? new Date(row.timestamp).getTime() : NaN;
    if (!Number.isFinite(ms)) continue;
    if (endMs === null || ms > endMs) endMs = ms;
    if (row.type !== 'user' || !row.message) continue;
    const content = row.message.content;
    const results = Array.isArray(content) ? content.filter((block) => block && block.type === 'tool_result') : [];
    if (results.length === 0) {
      events.push({ ms, kind: 'human' });
      continue;
    }
    for (const block of results) {
      const text = textOf(block.content);
      if (block.is_error === true && (DENIAL_TEXT.test(text) || row.toolDenialKind === AUTOMODE_DENIAL_KIND)) {
        refusals.push({ ms, timestamp: row.timestamp, category: categoryOf(text), index: events.length });
        events.push({ ms, kind: 'refusal' });
      } else if (block.is_error !== true) {
        events.push({ ms, kind: 'ok' });
      }
    }
  }
  return {
    sessionId,
    endMs,
    refusals: refusals.map(({ index, ...refusal }) => {
      const next = events.slice(index + 1).find((event) => event.kind !== 'refusal' && event.ms >= refusal.ms);
      const stop = Math.min(next ? next.ms : endMs, endMs);
      return { ...refusal, waitMs: Math.max(0, stop - refusal.ms) };
    }),
  };
}

function subagentFiles(sessionFile) {
  const dir = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl')).sort().map((name) => path.join(dir, name));
}

function parseTime(value, flag) {
  const ms = new Date(value).getTime();
  if (!value || value === 'true' || !Number.isFinite(ms)) throw new RefusalReportError('USAGE', `--${flag} needs an ISO timestamp, got ${JSON.stringify(value)}`, { flag });
  return ms;
}

// Every transcript under the root that was written on or after `since` (an older file
// cannot hold a row inside the window), each parsed once. A subagent's refusals belong to
// its host session.
function collectRefusals({ transcriptsDir, since, until = null } = {}) {
  const root = transcriptsDir || measureCycle.defaultTranscriptsDir();
  const floor = since ? parseTime(since, 'since') : 0;
  const scans = [];
  let filesScanned = 0;
  if (!fs.existsSync(root)) return { scans, filesScanned };
  for (const file of measureCycle.listTranscriptFiles(root)) {
    const sessionId = path.basename(file, '.jsonl');
    for (const candidate of [file, ...subagentFiles(file)]) {
      let contents;
      try {
        if (fs.statSync(candidate).mtimeMs < floor) continue;
        contents = fs.readFileSync(candidate, 'utf8');
      } catch { continue; }
      filesScanned += 1;
      if (!contents.includes('auto mode classifier') && !contents.includes(AUTOMODE_DENIAL_KIND)) continue;
      scans.push({ ...scanTranscript(contents, { sessionId }), sessionId, sourcePath: candidate });
    }
  }
  return { scans, filesScanned };
}

const hours = (ms) => Math.round((ms / 3600000) * 100) / 100;

function unionMs(intervals) {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

function buildReport({ scans = [], filesScanned = 0 } = {}, { since, until } = {}) {
  const lower = parseTime(since, 'since');
  const upper = parseTime(until, 'until');
  const byCategory = new Map([[MERGE_CATEGORY, { count: 0, sessions: new Set(), waitMs: 0 }]]);
  const allSessions = new Set();
  const intervalsBySession = new Map();
  for (const scan of scans) {
    for (const refusal of scan.refusals) {
      if (refusal.ms < lower || refusal.ms > upper) continue;
      if (!byCategory.has(refusal.category)) byCategory.set(refusal.category, { count: 0, sessions: new Set(), waitMs: 0 });
      const entry = byCategory.get(refusal.category);
      entry.count += 1;
      entry.sessions.add(scan.sessionId);
      entry.waitMs += refusal.waitMs;
      allSessions.add(scan.sessionId);
      if (!intervalsBySession.has(scan.sessionId)) intervalsBySession.set(scan.sessionId, []);
      intervalsBySession.get(scan.sessionId).push([refusal.ms, refusal.ms + refusal.waitMs]);
    }
  }
  const rank = (name) => (name === MERGE_CATEGORY ? 0 : (name === UNCATEGORIZED ? 2 : 1));
  const categories = [...byCategory]
    .sort(([a, x], [b, y]) => rank(a) - rank(b) || y.count - x.count || a.localeCompare(b))
    .map(([category, entry]) => ({ category, count: entry.count, sessions: entry.sessions.size, waitHours: hours(entry.waitMs) }));
  // Waits that overlap inside one session are one stretch of waiting, so the total does not add them twice.
  const totalWaitMs = [...intervalsBySession.values()].reduce((sum, intervals) => sum + unionMs(intervals), 0);
  return {
    since: new Date(lower).toISOString(),
    until: new Date(upper).toISOString(),
    filesScanned,
    categories,
    total: { count: categories.reduce((sum, c) => sum + c.count, 0), sessions: allSessions.size, waitHours: hours(totalWaitMs) },
  };
}

function renderMarkdown(report) {
  const rows = [
    '| Category | Refusals | Sessions | Wait hours |',
    '| --- | ---: | ---: | ---: |',
    ...report.categories.map((c) => `| ${c.category} | ${c.count} | ${c.sessions} | ${c.waitHours} |`),
    `| Total | ${report.total.count} | ${report.total.sessions} | ${report.total.waitHours} |`,
  ];
  return [
    `Auto-mode classifier refusals, ${report.since} to ${report.until} (${report.filesScanned} transcript files read).`,
    '',
    ...rows,
    '',
    'Wait hours: refusal to the session\'s next successful tool call or human turn, capped at the transcript\'s end. The total counts overlapping waits in one session once.',
    '',
  ].join('\n');
}

function cli(argv, { now = () => new Date() } = {}) {
  let args;
  try {
    args = workState.parseArgs(argv, REFUSAL_REPORT_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new RefusalReportError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  const since = parseTime(args.since, 'since');
  const until = args.until ? parseTime(args.until, 'until') : now().getTime();
  if (until < since) throw new RefusalReportError('USAGE', '--until is before --since', { flag: 'until' });
  const window = { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
  const report = buildReport(collectRefusals({ transcriptsDir: args.transcripts, ...window }), window);
  return args.json === 'true' ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
}

if (require.main === module) {
  try {
    process.stdout.write(cli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: String(error.message || error) })}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = {
  MERGE_CATEGORY,
  UNCATEGORIZED,
  REFUSAL_REPORT_FLAGS,
  RefusalReportError,
  scanTranscript,
  collectRefusals,
  buildReport,
  renderMarkdown,
  cli,
};
