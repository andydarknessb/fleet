'use strict';
// #132 (spec #91): the weekly reviewer audit. Once a week, pick one formal review from the
// previous Monday-to-Sunday week (bin/report-week.js) whose artifact says `noFindings` and
// whose PR diff is over `config/cycle.json` `secondRead.minChangedLines` (150) changed
// lines, and file one fleet issue labelled `second-read` asking Cory's session to run the
// existing `qa-reviewer` definition on opus against that PR (ruled 2026-09-24: a request
// to Cory's session, no new role). The pick is deterministic for the week: the largest
// diff not already picked (ties: lowest PR number). A re-review (an artifact with a
// `priorArtifact`) is not a candidate: it read only the fix range after findings.
//
// Picks are recorded in state/second-read/picks.jsonl, so a second run in the same week
// files nothing and the same review is never picked twice. No candidate files nothing and
// says so. GitHub is read only for candidates (`gh pr view` for the diff size, bounded);
// a size it cannot return skips that candidate and is reported. `--dry-run` picks without
// filing or recording. Run beside the daily collector (bin/run-cycle-collector.ps1);
// `state/flags/second-read-off` stops it there.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const workState = require('./work-state');
const { inWeek, previousWeek } = require('./report-week');

class SecondReadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SecondReadError';
    this.code = code;
    Object.assign(this, details);
  }
}

const SECOND_READ_FLAGS = ['root', 'now', 'dry-run'];
const DEFAULTS = Object.freeze({ repo: 'andydarknessb/fleet', label: 'second-read', minChangedLines: 150, maxPrLookups: 50 });

function baseOf(root) { return path.resolve(root || path.join(__dirname, '..')); }
function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch { return fallback; }
}

function config(base) {
  const cycle = readJson(path.join(base, 'config', 'cycle.json'), {});
  return { ...DEFAULTS, ...(cycle.secondRead || {}) };
}

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000 });
}

function picksFile(base) { return path.join(base, 'state', 'second-read', 'picks.jsonl'); }

function readPicks(base) {
  const file = picksFile(base);
  if (!fs.existsSync(file)) return [];
  const picks = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { picks.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return picks;
}

// The PR each record last named on a state event (`changes.prNumber`).
function prNumbers(events) {
  const byRecord = new Map();
  for (const event of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const number = Number(event.changes?.prNumber);
    if (Number.isInteger(number) && number > 0) byRecord.set(event.recordId, number);
  }
  return byRecord;
}

function selectSecondRead({ root, now, gh = defaultGh } = {}) {
  const base = baseOf(root);
  const settings = config(base);
  const week = previousWeek(now);
  const events = workState.readEvents(base);
  const tenants = workState.readTenantConfigs(base);
  const prs = prNumbers(events);
  const picked = new Set(readPicks(base).map((pick) => pick.artifact));
  const candidates = [];
  const errors = [];
  const seen = new Set();
  let lookups = 0;
  let skippedForCap = 0;
  for (const event of events) {
    if (event.type !== 'review-recorded' || event.changes?.kind !== 'formal' || !inWeek(week, event.at)) continue;
    const relative = String(event.changes.artifact || '');
    if (!relative || seen.has(relative)) continue;
    seen.add(relative);
    const artifact = readJson(path.join(base, relative), null);
    if (!artifact || typeof artifact.noFindings !== 'string' || !artifact.noFindings.trim()) continue;
    if (artifact.priorArtifact || event.changes.priorArtifact) continue;
    const tenant = String(event.recordId).split(':')[0];
    const repo = tenants[tenant]?.github || null;
    const pr = prs.get(event.recordId) || null;
    const entry = { recordId: event.recordId, tenant, repo, pr, artifact: relative, reviewer: artifact.reviewer || event.actor || 'unknown', reviewedAt: event.at, headSha: event.changes.headSha || artifact.headSha || null, statement: artifact.noFindings.trim() };
    if (!repo || !pr) { errors.push({ ...entry, error: !repo ? `no GitHub repo for tenant ${tenant}` : 'no PR number on the record' }); continue; }
    // Each size is one bounded GitHub read; past secondRead.maxPrLookups the rest of the
    // week's zero-finding reviews are counted, not sized.
    if (lookups >= settings.maxPrLookups) { skippedForCap += 1; continue; }
    lookups += 1;
    let size;
    try { size = JSON.parse(gh(['pr', 'view', String(pr), '-R', repo, '--json', 'additions,deletions,changedFiles'])); } catch (error) {
      errors.push({ ...entry, error: String(error.message || error).split('\n')[0] });
      continue;
    }
    const additions = Number(size.additions) || 0;
    const deletions = Number(size.deletions) || 0;
    const changedLines = additions + deletions;
    if (changedLines <= settings.minChangedLines) continue;
    candidates.push({ ...entry, additions, deletions, changedFiles: Number(size.changedFiles) || 0, changedLines, alreadyPicked: picked.has(relative) });
  }
  candidates.sort((a, b) => b.changedLines - a.changedLines || a.pr - b.pr || a.artifact.localeCompare(b.artifact));
  const pick = candidates.find((candidate) => !candidate.alreadyPicked) || null;
  return { week, settings, candidates, pick, errors, skippedForCap };
}

function renderIssueBody(pick, week, settings = DEFAULTS) {
  const prUrl = `https://github.com/${pick.repo}/pull/${pick.pr}`;
  const prompt = `Second read of ${prUrl} at head ${pick.headSha}. Its formal review (${pick.artifact}) recorded no findings: "${pick.statement.replace(/"/g, "'")}". Review the whole diff from the angle: correctness and spec, the angle a formal review owns. Return findings with file:line, severity and category, or one line saying you agree.`;
  return [
    `Weekly reviewer audit (fleet #132, spec #91) for ${week.label}: one zero-finding formal review on a diff over ${settings.minChangedLines} changed lines, picked for an independent opus second read. The pick is the largest such diff not already read.`,
    '',
    `- PR: ${prUrl} (${pick.recordId})`,
    `- Diff size: ${pick.changedLines} changed lines (${pick.additions} additions, ${pick.deletions} deletions, ${pick.changedFiles} files)`,
    `- First reviewer: ${pick.reviewer}, at ${pick.reviewedAt}, head ${pick.headSha}`,
    `- Artifact: ${pick.artifact}`,
    `- The first review's statement: ${pick.statement}`,
    '',
    '## Run the read (Cory\'s session)',
    '',
    'Run the existing risk reviewer definition on opus against the PR:',
    '',
    '```',
    `Agent(subagent_type: "qa-reviewer", model: "opus", prompt: ${JSON.stringify(prompt)})`,
    '```',
    '',
    '## Record the outcome',
    '',
    'Comment on this issue: `Agree`, or the findings with severities (blocker, major, minor, nit). Close it once the outcome is recorded.',
  ].join('\n');
}

function appendPick(base, line) {
  const file = picksFile(base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
}

function fileSecondRead({ root, now, gh = defaultGh, dryRun = false } = {}) {
  const base = baseOf(root);
  const at = now || new Date().toISOString();
  const week = previousWeek(at);
  const already = readPicks(base).find((pick) => pick.week === week.label);
  if (already) return { outcome: 'already-picked', week, pick: already, message: `second read for ${week.label} already filed: ${already.issueUrl || already.artifact}` };
  const selection = selectSecondRead({ root: base, now: at, gh });
  if (!selection.pick) {
    return { outcome: 'no-candidate', week, candidates: selection.candidates, errors: selection.errors, skippedForCap: selection.skippedForCap, message: `no zero-finding formal review on a diff over ${selection.settings.minChangedLines} changed lines in ${week.label}; nothing filed` };
  }
  const { pick, settings } = selection;
  const title = `Second read: PR #${pick.pr} (${pick.tenant}), zero-finding review on ${pick.changedLines} changed lines, week ${week.label}`;
  const body = renderIssueBody(pick, week, settings);
  if (dryRun) return { outcome: 'would-file', week, pick, candidates: selection.candidates, errors: selection.errors, skippedForCap: selection.skippedForCap, title, body };
  gh(['label', 'create', settings.label, '-R', settings.repo, '--color', '5319E7', '--description', 'Weekly opus second read of a zero-finding review (fleet #132)', '--force']);
  const url = String(gh(['issue', 'create', '-R', settings.repo, '--title', title, '--label', settings.label, '--body', body])).trim().split(/\r?\n/).pop();
  const number = Number((url.match(/\/issues\/(\d+)$/) || [])[1]) || null;
  appendPick(base, { week: week.label, at, recordId: pick.recordId, tenant: pick.tenant, pr: pick.pr, changedLines: pick.changedLines, reviewer: pick.reviewer, artifact: pick.artifact, issueUrl: url, issueNumber: number });
  return { outcome: 'filed', week, pick, candidates: selection.candidates, errors: selection.errors, skippedForCap: selection.skippedForCap, issue: { url, number } };
}

function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, SECOND_READ_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new SecondReadError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  return fileSecondRead({ root: args.root, now: args.now, dryRun: args['dry-run'] === 'true' });
}

if (require.main === module) {
  try {
    const result = cli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome, week: result.week.label, pr: result.pick?.pr ?? null, changedLines: result.pick?.changedLines ?? null, issue: result.issue?.url || result.pick?.issueUrl || null, candidates: (result.candidates || []).length, skippedForCap: result.skippedForCap || 0, errors: (result.errors || []).map((e) => `${e.recordId} PR ${e.pr}: ${e.error}`), message: result.message || null })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: String(error.message || error) })}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = { DEFAULTS, SECOND_READ_FLAGS, SecondReadError, cli, fileSecondRead, readPicks, renderIssueBody, selectSecondRead };
