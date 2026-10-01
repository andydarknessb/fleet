'use strict';

// #279 (spec #196, ruling 2026-10-01): the Merge-fallback decision's instrument. Counts the
// auto-mode classifier's refusals by category from the harness's own tool-result text in
// fleet roster sessions' transcripts, and prices "Merge Without Review" as the session-hours
// between the first refusal of a PR's merge and that PR's actual merge.
//
// What a refusal is. The harness writes one as a `user` row tagged
// `toolDenialKind: "automode-blocked"` whose `tool_result` block (is_error true) reads
// "Permission for this action was denied by the Claude Code auto mode classifier. Reason:
// [Merge Without Review]. If you have other tasks ...". The tag identifies a refusal and the
// bracketed Reason categorizes it; a refusal with no bracketed Reason is `uncategorized`
// (flagged when the refused command was `gh pr merge`). A text-only hit (the wording without
// the tag) is listed as unconfirmed and never counted. Assistant messages, user prompts,
// non-error results and cross-session (`isMeta`) rows are never read, so a session quoting a
// refusal cannot move the count (spec #196 story 2). `automode-unavailable` rows (the
// classifier gave no verdict) are not refusals and are excluded by design.
//
// Scope. Only transcripts whose basename sessionId is in the session set bin/measure-cycle.js
// builds (live roster plus retired rows overlapping the window). Subagents
// (<session>/subagents/agent-*.jsonl and <session>/subagents/workflows/*/agent-*.jsonl)
// belong to their host session. Cory's own sessions only feed one count-only line.
//
// The wait. The refused command comes from the tool_use matching the refusal's tool_use_id;
// its PR and repo from `gh pr merge <n> -R <repo>` (else the roster tenant, else the session
// cwd). One interval per PR, from its first refusal to `mergedAt` (`gh pr view`, or the
// pr-watch `state-merged` event with --no-verify-github); a PR still open at --until runs to
// --until. Session-hours are the union of intervals per roster name, since rotation gives the
// same name a new sessionId.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const workState = require('./work-state');
const measureCycle = require('./measure-cycle');

const MERGE_CATEGORY = 'Merge Without Review';
const OUTSIDE_ROSTER_LABEL = "Merge Without Review, outside the roster (Cory's sessions)";
const UNCATEGORIZED = 'uncategorized';
const DENIAL_TEXT = /denied by the Claude Code auto mode classifier/;
const REASON = /Reason:\s*\[([^\]]*)\]/;
const BLOCKED_KIND = 'automode-blocked';
const UNAVAILABLE_KIND = 'automode-unavailable';
const REFUSAL_REPORT_FLAGS = ['transcripts', 'fleet-home', 'since', 'until', 'json', 'no-verify-github'];
const HOUR_MS = 3600000;

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

// `gh pr merge` flags that take a value, so the value is not mistaken for the PR number.
const MERGE_VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']);

// Quoted strings are swapped for placeholders (no whitespace, no shell separators) so a
// string literal can neither hold a command nor supply an argument.
function maskQuoted(command) {
  const quoted = [];
  const text = String(command || '').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (match) => {
    quoted.push(match.slice(1, -1));
    return `\u0000${quoted.length - 1}\u0000`;
  });
  return { text, quoted };
}

// `gh pr merge` as a command: at the start, or after a shell separator (; & | newline, a
// subshell or backtick), optionally after gh's own global flags (`gh -R o/r pr merge 5`).
const GH_MERGE = /(?:^|[;&|\n(`])\s*gh((?:\s+(?:-R|--repo)(?:\s+|=)\S+)*)\s+pr\s+merge\b([^;&|\n]*)/;

function findGhMerge(command) {
  const { text, quoted } = maskQuoted(command);
  const match = text.match(GH_MERGE);
  return match ? { tokens: `${match[1]} ${match[2]}`.trim().split(/\s+/).filter(Boolean), quoted } : null;
}

// The PR a refused `gh pr merge` named: { number, repo } (repo null when the command carries
// no -R / --repo / PR URL), or null when the command is not a merge of a named PR. Reads only
// the `gh pr merge` segment of a chained command, never a string literal.
function parseGhMerge(command) {
  const found = findGhMerge(command);
  if (!found) return null;
  const unmask = (token) => String(token || '').replace(/\u0000(\d+)\u0000/g, (_, index) => found.quoted[Number(index)]);
  const tokens = found.tokens;
  let repo = null;
  let number = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-R' || token === '--repo') { repo = unmask(tokens[i + 1]) || null; i += 1; continue; }
    if (token.startsWith('--repo=')) { repo = unmask(token.slice('--repo='.length)) || null; continue; }
    if (MERGE_VALUE_FLAGS.has(token)) { i += 1; continue; }
    if (token.startsWith('-')) continue;
    const url = unmask(token).match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
    if (url && number === null) { repo = repo || url[1]; number = Number(url[2]); continue; }
    if (/^#?\d+$/.test(token) && number === null) number = Number(token.replace('#', ''));
  }
  // `-R $REPO` and the like name a shell variable, not a repository: fall back to the tenant.
  if (repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(repo)) repo = null;
  return number === null ? null : { number, repo };
}

// One transcript's refusals (tagged), unconfirmed text-only hits, and unavailable-verdict
// rows. A refusal carries the refused command and the PR it named.
function scanTranscript(contents, { sessionId = null } = {}) {
  const commands = new Map();
  const refusals = [];
  const unconfirmed = [];
  const unavailableMs = [];
  let name = null;
  let role = null;
  let cwd = null;
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'agent-name') name = name || row.agentName || null;
    else if (row.type === 'custom-title') name = name || row.customTitle || null;
    else if (row.type === 'agent-setting') role = role || row.agentSetting || null;
    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (block && block.type === 'tool_use' && block.id) commands.set(block.id, String(block.input?.command || ''));
      }
      continue;
    }
    if (row.type !== 'user' || !row.message || row.isMeta === true) continue;
    const ms = row.timestamp ? new Date(row.timestamp).getTime() : NaN;
    if (!Number.isFinite(ms) || !Array.isArray(row.message.content)) continue;
    for (const block of row.message.content) {
      if (!block || block.type !== 'tool_result' || block.is_error !== true) continue;
      const text = textOf(block.content);
      if (row.toolDenialKind === UNAVAILABLE_KIND) {
        unavailableMs.push(ms);
      } else if (row.toolDenialKind === BLOCKED_KIND) {
        const command = commands.get(block.tool_use_id) || '';
        refusals.push({
          ms,
          timestamp: row.timestamp,
          category: categoryOf(text),
          toolUseId: block.tool_use_id || null,
          command,
          pr: parseGhMerge(command),
          refusedGhPrMerge: findGhMerge(command) !== null,
        });
      } else if (DENIAL_TEXT.test(text)) {
        unconfirmed.push({ ms, timestamp: row.timestamp, category: categoryOf(text) });
      }
    }
  }
  return { sessionId, name, role, cwd, refusals, unconfirmed, unavailable: unavailableMs.length, unavailableMs };
}

function parseTime(value, flag) {
  let text = String(value === undefined ? '' : value).trim();
  // An ISO timestamp with no offset is UTC, not the host's local time.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text = `${text.replace(' ', 'T')}Z`;
  const ms = new Date(text).getTime();
  if (!text || text === 'true' || !Number.isFinite(ms)) throw new RefusalReportError('USAGE', `--${flag} needs an ISO timestamp, got ${JSON.stringify(value)}`, { flag });
  return ms;
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch { return fallback; }
}

function readTenants(fleetHome) {
  const dir = path.join(fleetHome, 'tenants');
  const tenants = {};
  if (!fs.existsSync(dir)) return tenants;
  for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    tenants[path.basename(file, '.json')] = readJson(path.join(dir, file), {});
  }
  return tenants;
}

// The session set measure-cycle.js builds (live roster plus retired rows overlapping the
// window), as sessionId -> { name, role, tenant }.
function loadFleetSessions({ fleetHome, since, until } = {}) {
  const home = path.resolve(fleetHome || path.join(__dirname, '..'));
  const roster = readJson(path.join(home, 'state', 'roster.json'), []);
  const liveRows = Array.isArray(roster) ? roster : (roster && Array.isArray(roster.sessions) ? roster.sessions : []);
  const retired = measureCycle.loadRetiredRows(path.join(home, 'state', 'archive', 'roster-retired-full.jsonl'));
  const rows = measureCycle.mergeSessionRows(liveRows, retired.rows, { lower: since ? parseTime(since, 'since') : null, upper: until ? parseTime(until, 'until') : null });
  const sessions = new Map();
  for (const row of rows) {
    if (row.sessionId) sessions.set(row.sessionId, { name: row.name || null, role: row.role || null, tenant: row.tenant || null });
  }
  return sessions;
}

// <session>/subagents/agent-*.jsonl and <session>/subagents/workflows/*/agent-*.jsonl
function subagentFiles(sessionFile) {
  const dir = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents');
  if (!fs.existsSync(dir)) return [];
  const agentFiles = (directory) => fs.readdirSync(directory).filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl')).sort().map((name) => path.join(directory, name));
  const files = agentFiles(dir);
  const workflows = path.join(dir, 'workflows');
  if (fs.existsSync(workflows)) {
    for (const entry of fs.readdirSync(workflows, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      files.push(...agentFiles(path.join(workflows, entry.name)));
    }
  }
  return files;
}

const normalizePath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// The tenant's GitHub repo for a session: its roster tenant, else the tenant whose repo
// directory holds the session cwd (a worktree of it counts).
function repoForSession({ tenant, cwd }, tenants) {
  if (tenant && tenants[tenant]?.github) return tenants[tenant].github;
  const here = normalizePath(cwd);
  if (!here) return null;
  const hit = Object.values(tenants).find((config) => {
    const repo = normalizePath(config.repo);
    return repo && config.github && (here === repo || here.startsWith(`${repo}/`));
  });
  return hit ? hit.github : null;
}

// Every transcript under the root last written on or after `since` (an older file cannot
// hold a row inside the window), each read once, with its subagents attributed to the host.
function collectRefusals({ transcriptsDir, since, fleetSessions = new Map(), tenants = {} } = {}) {
  const root = path.resolve(transcriptsDir || measureCycle.defaultTranscriptsDir());
  const floor = since ? parseTime(since, 'since') : 0;
  const scans = [];
  let filesScanned = 0;
  if (!fs.existsSync(root)) return { scans, filesScanned };
  for (const file of measureCycle.listTranscriptFiles(root)) {
    const hostId = path.basename(file, '.jsonl');
    const member = fleetSessions.get(hostId) || null;
    for (const candidate of [file, ...subagentFiles(file)]) {
      let contents;
      try {
        if (fs.statSync(candidate).mtimeMs < floor) continue;
        contents = fs.readFileSync(candidate, 'utf8');
      } catch { continue; }
      filesScanned += 1;
      if (!contents.includes('auto mode classifier') && !contents.includes('automode-')) continue;
      const scan = scanTranscript(contents, { sessionId: hostId });
      const repo = repoForSession({ tenant: member?.tenant, cwd: scan.cwd }, tenants);
      for (const refusal of scan.refusals) {
        if (refusal.pr && !refusal.pr.repo) refusal.pr = { number: refusal.pr.number, repo };
      }
      scans.push({
        ...scan,
        sessionId: hostId,
        sourcePath: candidate,
        inRoster: Boolean(member),
        name: member?.name || scan.name,
        role: member?.role || scan.role,
      });
    }
  }
  return { scans, filesScanned };
}

const mergeKey = (repo, number) => `${String(repo).toLowerCase()}#${number}`;
const hours = (ms) => Math.round((ms / HOUR_MS) * 100) / 100;

function windowOf({ since, until }) {
  return { lower: parseTime(since, 'since'), upper: parseTime(until, 'until') };
}

function inWindow(ms, { lower, upper }) {
  return ms >= lower && ms <= upper;
}

// The distinct PRs (with a repo) the in-window roster Merge Without Review refusals named.
function prKeysToResolve(collected, window) {
  const bounds = windowOf(window);
  const seen = new Map();
  for (const scan of collected.scans || []) {
    if (!scan.inRoster) continue;
    for (const refusal of scan.refusals) {
      if (refusal.category !== MERGE_CATEGORY || !inWindow(refusal.ms, bounds) || !refusal.pr || !refusal.pr.repo) continue;
      seen.set(mergeKey(refusal.pr.repo, refusal.pr.number), { repo: refusal.pr.repo, number: refusal.pr.number });
    }
  }
  return [...seen.values()];
}

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000 });
}

const isoOrNull = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// Merge facts per PR key. With a `gh` runner: `gh pr view <n> -R <repo> --json
// mergedAt,mergedBy,state,closedAt`; a failed lookup is an error and the PR stays unresolved.
// With `gh: null` (--no-verify-github): the pr-watch `state-merged` event in the fleet
// ledger. The ledger has no closed-without-merge event, so a closed PR cannot be told apart
// there and stays unresolved.
function fetchMerges(keys, { gh = defaultGh, fleetHome = null, tenants = {} } = {}) {
  const merges = {};
  const errors = [];
  if (gh) {
    for (const { repo, number } of keys) {
      try {
        const view = JSON.parse(gh(['pr', 'view', String(number), '-R', repo, '--json', 'mergedAt,mergedBy,state,closedAt']));
        merges[mergeKey(repo, number)] = { state: view.state || null, mergedAt: isoOrNull(view.mergedAt), mergedBy: view.mergedBy?.login || (typeof view.mergedBy === 'string' ? view.mergedBy : null), closedAt: isoOrNull(view.closedAt) };
      } catch (error) {
        errors.push({ repo, number, error: String(error.message || error).split('\n')[0] });
      }
    }
    return { merges, errors };
  }
  const wanted = new Set(keys.map((key) => mergeKey(key.repo, key.number)));
  let events = [];
  try { events = workState.readEvents(path.resolve(fleetHome || path.join(__dirname, '..'))); } catch { events = []; }
  for (const event of events) {
    if (event.type !== 'state-merged' || !event.changes?.prNumber) continue;
    const repo = tenants[String(event.recordId || '').split(':')[0]]?.github;
    if (!repo) continue;
    const key = mergeKey(repo, event.changes.prNumber);
    if (!wanted.has(key)) continue;
    const observed = String(event.evidence || '').match(/observed merged at (\S+)/);
    merges[key] = { state: 'MERGED', mergedAt: isoOrNull(observed ? observed[1] : event.at), mergedBy: event.changes.mergedBy || null, closedAt: null };
  }
  return { merges, errors };
}

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

const sorted = (set) => [...set].sort();

function buildReport({ scans = [], filesScanned = 0 } = {}, { since, until, merges = {}, errors = [] } = {}) {
  const bounds = windowOf({ since, until });
  const windowMs = bounds.upper - bounds.lower;
  const byCategory = new Map([[MERGE_CATEGORY, { count: 0, sessions: new Set(), names: new Set(), refusedGhPrMerge: 0 }]]);
  const refusals = [];
  const mwrPrs = new Map();
  const unresolvedKeys = new Set();
  let unresolved = 0;
  let followOn = 0;
  let outside = 0;
  let unconfirmed = 0;
  let unavailable = 0;
  for (const scan of scans) {
    if (!scan.inRoster) {
      outside += scan.refusals.filter((r) => r.category === MERGE_CATEGORY && inWindow(r.ms, bounds)).length;
      continue;
    }
    unconfirmed += (scan.unconfirmed || []).filter((r) => inWindow(r.ms, bounds)).length;
    unavailable += (scan.unavailableMs || []).filter((ms) => inWindow(ms, bounds)).length;
    for (const refusal of scan.refusals) {
      if (!inWindow(refusal.ms, bounds)) continue;
      if (!byCategory.has(refusal.category)) byCategory.set(refusal.category, { count: 0, sessions: new Set(), names: new Set(), refusedGhPrMerge: 0 });
      const entry = byCategory.get(refusal.category);
      entry.count += 1;
      entry.sessions.add(scan.sessionId);
      if (scan.name) entry.names.add(scan.name);
      if (refusal.refusedGhPrMerge) entry.refusedGhPrMerge += 1;
      const listed = { at: refusal.timestamp, name: scan.name || null, role: scan.role || null, sessionId: scan.sessionId, category: refusal.category };
      if (refusal.pr) listed.pr = refusal.pr;
      // Marked on every non-merge category (a refused `gh pr merge` that the classifier gave
      // another name, e.g. Production Deploy), and never priced.
      if (refusal.category !== MERGE_CATEGORY && refusal.refusedGhPrMerge) listed.refusedGhPrMerge = true;
      const row = { ms: refusal.ms, listed, key: null };
      refusals.push(row);
      if (refusal.category !== MERGE_CATEGORY) continue;
      // The classifier also refuses the reads that follow a denied merge (memory files, `gh pr
      // view`), labelled the same: those name no PR to merge and are counted, not priced.
      if (!refusal.refusedGhPrMerge) { followOn += 1; continue; }
      if (!refusal.pr || !refusal.pr.repo) { unresolved += 1; listed.unresolved = true; continue; }
      const key = mergeKey(refusal.pr.repo, refusal.pr.number);
      row.key = key;
      const known = mwrPrs.get(key);
      if (!known) {
        mwrPrs.set(key, { key, repo: refusal.pr.repo, number: refusal.pr.number, name: scan.name || null, role: scan.role || null, sessionId: scan.sessionId, firstMs: refusal.ms, refusals: 1 });
      } else {
        known.refusals += 1;
        if (refusal.ms < known.firstMs) Object.assign(known, { name: scan.name || null, role: scan.role || null, sessionId: scan.sessionId, firstMs: refusal.ms });
      }
    }
  }

  const intervalsByName = new Map();
  const nameEntry = (label) => {
    if (!intervalsByName.has(label)) intervalsByName.set(label, { prs: 0, intervals: [] });
    return intervalsByName.get(label);
  };
  const prs = [...mwrPrs.values()].sort((a, b) => a.firstMs - b.firstMs).map((pr) => {
    const merge = merges[pr.key] || null;
    const entry = { repo: pr.repo, number: pr.number, name: pr.name, role: pr.role, sessionId: pr.sessionId, firstRefusedAt: new Date(pr.firstMs).toISOString(), state: merge?.state || null, mergedAt: merge?.mergedAt || null, mergedBy: merge?.mergedBy || null, closedAt: merge?.closedAt || null, refusals: pr.refusals, hours: 0, stillOpen: false, closedUnmerged: false, resolved: Boolean(merge) };
    const holder = nameEntry(pr.name || pr.sessionId);
    holder.prs += 1;
    // `unresolved` is one unit, refusals: every refusal of a PR with no merge data.
    if (!merge) { unresolved += pr.refusals; unresolvedKeys.add(pr.key); return entry; }
    // The wait ends at the merge, or for a PR closed unmerged at its closedAt; an open PR has
    // no end. Whatever the end, the window caps it: past --until the PR is still open at the
    // window end and bills only to --until.
    const mergedMs = merge.state === 'MERGED' && merge.mergedAt ? new Date(merge.mergedAt).getTime() : NaN;
    const closedMs = merge.state === 'CLOSED' && merge.closedAt ? new Date(merge.closedAt).getTime() : NaN;
    const endMs = Number.isFinite(mergedMs) ? mergedMs : (Number.isFinite(closedMs) ? closedMs : Infinity);
    entry.stillOpen = endMs > bounds.upper;
    entry.closedUnmerged = Number.isFinite(closedMs) && closedMs <= bounds.upper;
    const end = Math.max(pr.firstMs, Math.min(endMs, bounds.upper));
    entry.hours = hours(end - pr.firstMs);
    holder.intervals.push([pr.firstMs, end]);
    return entry;
  });
  for (const row of refusals) {
    if (row.key && unresolvedKeys.has(row.key)) row.listed.unresolved = true;
  }
  const perName = [...intervalsByName].map(([name, value]) => ({ name, prs: value.prs, waitMs: unionMs(value.intervals) }))
    .sort((a, b) => b.waitMs - a.waitMs || a.name.localeCompare(b.name));
  const waitMs = perName.reduce((sum, item) => sum + item.waitMs, 0);

  const merge = byCategory.get(MERGE_CATEGORY);
  const categories = [{ category: MERGE_CATEGORY, count: merge.count, sessions: merge.sessions.size, names: sorted(merge.names) }];
  const rank = (name) => (name === UNCATEGORIZED ? 1 : 0);
  for (const [category, entry] of [...byCategory].filter(([name]) => name !== MERGE_CATEGORY)
    .sort(([a, x], [b, y]) => rank(a) - rank(b) || y.count - x.count || a.localeCompare(b))) {
    const item = { category, count: entry.count, sessions: entry.sessions.size, names: sorted(entry.names) };
    if (category === UNCATEGORIZED || entry.refusedGhPrMerge > 0) item.refusedGhPrMerge = entry.refusedGhPrMerge;
    categories.push(item);
  }
  return {
    since: new Date(bounds.lower).toISOString(),
    until: new Date(bounds.upper).toISOString(),
    windowHours: hours(windowMs),
    filesScanned,
    categories,
    outsideRoster: { count: outside },
    mergeWithoutReview: {
      count: merge.count,
      sessions: merge.sessions.size,
      names: sorted(merge.names),
      prs,
      perName: perName.map(({ name, prs: count, waitMs: ms }) => ({ name, prs: count, waitHours: hours(ms) })),
      waitHours: hours(waitMs),
      waitHoursPer7Days: windowMs > 0 ? Math.round((waitMs / windowMs) * 7 * 24 * 100) / 100 : 0,
      stillOpen: prs.filter((pr) => pr.stillOpen).length,
      closedUnmerged: prs.filter((pr) => pr.closedUnmerged).length,
      unresolved,
      followOn,
    },
    unconfirmed,
    unavailable,
    lookupErrors: errors,
    refusals: refusals.sort((a, b) => a.ms - b.ms).map((item) => item.listed),
  };
}

function renderMarkdown(report) {
  const mwr = report.mergeWithoutReview;
  const out = [
    `Auto-mode classifier refusals, fleet roster sessions, ${report.since} to ${report.until} (${report.windowHours} h; ${report.filesScanned} transcript files read).`,
    '',
    '| Category | Refusals | Sessions | Roster names |',
    '| --- | ---: | ---: | --- |',
    ...report.categories.map((c) => `| ${c.category} | ${c.count} | ${c.sessions} | ${c.names.join(', ')} |`),
    `| ${OUTSIDE_ROSTER_LABEL} | ${report.outsideRoster.count} | | |`,
    '',
  ];
  const marked = report.categories.filter((c) => c.category !== MERGE_CATEGORY && c.refusedGhPrMerge > 0);
  if (marked.length > 0) {
    out.push(`Refused command was gh pr merge under another category (marked, not priced): ${marked.map((c) => `${c.category} ${c.refusedGhPrMerge} of ${c.count}`).join(', ')}.`, '');
  }
  out.push(
    `Merge Without Review wait, refusal to PR merge: ${mwr.waitHours} session-hours over ${report.windowHours} h (${mwr.waitHoursPer7Days} per 7 days); ${mwr.prs.length} PRs, ${mwr.stillOpen} still open at the window end, ${mwr.closedUnmerged} closed unmerged, ${mwr.unresolved} unresolved refusals; ${mwr.followOn} of the ${mwr.count} refusals were follow-on commands that were not a PR merge.`,
    '',
  );
  if (mwr.prs.length > 0) {
    out.push('| PR | Roster name | First refused | Merged at | Merged by | Hours |', '| --- | --- | --- | --- | --- | ---: |');
    for (const pr of mwr.prs) {
      let mergedAt = 'unresolved';
      if (pr.resolved) {
        if (pr.closedUnmerged) mergedAt = `closed unmerged ${pr.closedAt}`;
        else if (pr.stillOpen) mergedAt = pr.mergedAt ? `${pr.mergedAt} (after the window end)` : `open (${pr.state || 'unknown'})`;
        else mergedAt = pr.mergedAt;
      }
      out.push(`| ${pr.repo}#${pr.number} | ${pr.name || ''} | ${pr.firstRefusedAt} | ${mergedAt} | ${pr.mergedBy || ''} | ${pr.hours} |`);
    }
    out.push('');
  }
  if (mwr.perName.length > 0) {
    out.push('| Roster name | PRs | Session-hours (union) |', '| --- | ---: | ---: |', ...mwr.perName.map((item) => `| ${item.name} | ${item.prs} | ${item.waitHours} |`), '');
  }
  if (report.refusals.length > 0) {
    out.push('| At | Roster name | Role | Category | PR |', '| --- | --- | --- | --- | --- |');
    for (const item of report.refusals) {
      const notes = [item.refusedGhPrMerge ? 'refused command was gh pr merge' : '', item.unresolved ? 'unresolved' : ''].filter(Boolean);
      const category = notes.length > 0 ? `${item.category} (${notes.join('; ')})` : item.category;
      out.push(`| ${item.at} | ${item.name || ''} | ${item.role || ''} | ${category} | ${item.pr ? `${item.pr.repo || '?'}#${item.pr.number}` : ''} |`);
    }
    out.push('');
  }
  out.push(
    `Unconfirmed (classifier wording without the automode-blocked tag, not counted): ${report.unconfirmed}.`,
    `Excluded by design: ${report.unavailable} automode-unavailable rows (the classifier gave no verdict; not a refusal).`,
    'Wait: first refusal of a PR to its merge (mergedAt), to its closedAt if closed unmerged, or to the window end while still open or if the end falls after the window; session-hours are the union of intervals per roster name.',
    "Merged by shows the GitHub account; the lead's own successful merges also appear as andydarknessb.",
  );
  for (const item of report.lookupErrors) out.push(`Lookup failed for ${item.repo}#${item.number}: ${item.error}`);
  out.push('');
  return out.join('\n');
}

function cli(argv, { gh = defaultGh, now = () => new Date() } = {}) {
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
  const fleetHome = path.resolve(args['fleet-home'] || path.join(__dirname, '..'));
  const tenants = readTenants(fleetHome);
  const fleetSessions = loadFleetSessions({ fleetHome, ...window });
  const collected = collectRefusals({ transcriptsDir: args.transcripts, since: window.since, fleetSessions, tenants });
  const { merges, errors } = fetchMerges(prKeysToResolve(collected, window), { gh: args['no-verify-github'] === 'true' ? null : gh, fleetHome, tenants });
  const report = buildReport(collected, { ...window, merges, errors });
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
  OUTSIDE_ROSTER_LABEL,
  UNCATEGORIZED,
  REFUSAL_REPORT_FLAGS,
  RefusalReportError,
  parseGhMerge,
  scanTranscript,
  loadFleetSessions,
  collectRefusals,
  prKeysToResolve,
  mergeKey,
  fetchMerges,
  buildReport,
  renderMarkdown,
  cli,
};
