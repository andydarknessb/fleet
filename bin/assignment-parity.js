'use strict';
// 02/03 cutover: the parity gate between the two frontiers. The project lead's
// Stop hook computes the legacy frontier (ready label, unassigned per the roster,
// not on the skip file, no open blockers) every time it decides whether the lead
// should launch; the assignment planner (bin/assignment.js selectFrontier) computes
// its own from GitHub facts plus Work records and the exclusion ledger. The hook
// records one evaluation per decision here (observeFrontier), with both sides and
// every difference classified. compareAssignmentParity reads the most recent
// evaluations and passes only when there are enough of them, they span enough
// distinct frontiers (twenty looks at one idle frontier prove nothing), and every
// difference is approved in state/assignment/parity-approved.json.
//
// Classes: identical (same set, order aside - the hook's list is GitHub-ordered and
// the lead is told to launch the oldest); planner-excludes (the hook would launch an
// issue the planner refuses, carrying the planner's exclusion codes, e.g. spec-parent,
// ready-for-human, assigned, dependency-blocked, frontier-exclusion, reserved);
// planner-includes (the planner would launch something the hook would not);
// planner-failed (the planner could not answer: never evidence of agreement).
// Nothing is expected by construction: both observers read GitHub in the same
// hook run, so every difference is a real rule difference until Cory approves it.

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');

// fleet#4: refuse an unknown command or flag rather than silently ignore it (fleet#2
// found `review-policy.js classify` reading a typo'd flag as no argument at all and
// answering riskReview:false, exit 0; the observe/report split here has the same shape).
class AssignmentParityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AssignmentParityError';
    this.code = code;
    Object.assign(this, details);
  }
}

const ASSIGNMENT_PARITY_FLAGS = {
  observe: ['tenant', 'ready-label', 'fixture', 'repo', 'root', 'now', 'hook-frontier', 'hook-reason', 'mode'],
  report: ['root', 'tenant', 'json'],
};

const DEFAULTS = Object.freeze({ parityEvaluations: 20, parityDistinctFrontiers: 5, parityHours: 48 });
const MIN = 60 * 1000;
// The evidence must reach back across at least this fraction of the window. It is not
// higher because the lead evaluates in bursts separated by long idle stretches (a 23 h gap
// is normal overnight), so the oldest evaluation inside the window rarely sits near its
// edge. The point of the check is to reject a burst that looks like days of evidence, not
// to demand a regular cadence the lead does not have.
const COVERAGE = 0.75;
const CLASSES = Object.freeze(['identical', 'planner-excludes', 'planner-includes', 'planner-failed']);

function baseOf(root) {
  return path.resolve(root || path.join(__dirname, '..'));
}

function readConfig(root) {
  let assignment = {};
  try { assignment = JSON.parse(stripBom(fs.readFileSync(path.join(baseOf(root), 'config', 'cycle.json'), 'utf8'))).assignment || {}; } catch {}
  return { ...DEFAULTS, ...assignment };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isAssignmentLive({ root, live } = {}) {
  if (live === true) return true;
  return fs.existsSync(path.join(baseOf(root), 'state', 'flags', 'assignment-live'));
}

// Issue numbers, deduplicated. The hook's list is GitHub-ordered and compared as a set,
// so it is sorted; the planner's list keeps its own order (createdAt, then number),
// because its first element is the head the lead is told to reserve.
function numbers(list, { keepOrder = false } = {}) {
  const values = [...new Set((list || []).map((item) => Number(typeof item === 'object' && item !== null ? item.number ?? item.issue : item)).filter((n) => Number.isInteger(n) && n > 0))];
  return keepOrder ? values : values.sort((a, b) => a - b);
}

function classifyEvaluation({ hookFrontier, planner } = {}) {
  const hook = numbers(hookFrontier);
  if (planner?.error) {
    return { class: 'planner-failed', agree: false, hook, plannerFrontier: [], differences: [{ class: 'planner-failed', issue: null, codes: [], detail: String(planner.error) }] };
  }
  const plannerFrontier = numbers(planner?.eligible, { keepOrder: true });
  const excludedCodes = new Map();
  for (const entry of planner?.excluded || []) {
    excludedCodes.set(Number(entry.issue), [...new Set((entry.reasons || []).map((reason) => String(reason.code || 'unknown')))]);
  }
  const differences = [];
  for (const issue of hook) {
    if (plannerFrontier.includes(issue)) continue;
    differences.push({ class: 'planner-excludes', issue, codes: excludedCodes.get(issue)?.length ? excludedCodes.get(issue) : ['unknown'] });
  }
  for (const issue of plannerFrontier) {
    if (hook.includes(issue)) continue;
    differences.push({ class: 'planner-includes', issue, codes: [] });
  }
  return { class: differences.length ? null : 'identical', agree: differences.length === 0, hook, plannerFrontier, differences };
}

function shadowDir(root) {
  return path.join(baseOf(root), 'state', 'assignment', 'shadow');
}

function dayFile(at) {
  return `${at.slice(0, 10).replace(/-/g, '')}.jsonl`;
}

// One evaluation, appended to the day's shadow file. `planner` is the planner's
// selectFrontier result (or { error }) computed by the caller in the same hook run.
function observeFrontier({ root, tenant, hookFrontier, hookReason, planner, mode, now } = {}) {
  if (!tenant) throw new Error('tenant is required');
  const at = now || new Date().toISOString();
  const classified = classifyEvaluation({ hookFrontier, planner });
  const line = {
    at,
    tenant: String(tenant),
    mode: mode || (isAssignmentLive({ root }) ? 'live' : 'shadow'),
    hook: { frontier: classified.hook, reason: hookReason || null },
    planner: {
      frontier: classified.plannerFrontier,
      excluded: (planner?.excluded || []).map((entry) => ({ issue: Number(entry.issue), codes: [...new Set((entry.reasons || []).map((reason) => String(reason.code || 'unknown')))] })),
      error: planner?.error ? String(planner.error) : null,
    },
    agree: classified.agree,
    differences: classified.differences,
  };
  const dir = shadowDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, dayFile(at)), `${JSON.stringify(line)}\n`, 'utf8');
  return line;
}

function readShadow(root, tenant) {
  const dir = shadowDir(root);
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()) {
    for (const raw of stripBom(fs.readFileSync(path.join(dir, file), 'utf8')).split(/\r?\n/)) {
      if (!raw.trim()) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; /* a torn line is not evidence either way */ }
      if (tenant && line.tenant !== tenant) continue;
      if (!line.at || Number.isNaN(Date.parse(line.at))) continue;
      entries.push(line);
    }
  }
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return entries;
}

function readApprovals(root) {
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(path.join(baseOf(root), 'state', 'assignment', 'parity-approved.json'), 'utf8')));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// `code` matches when the difference's code set CONTAINS it, so `code: "assigned"` also
// covers ["assigned","dependency-blocked"] and would silently bless a dependency-read
// divergence that happens to land on an assigned issue. `codes` is the exact-set form:
// it matches only when the difference's codes are exactly those, which is what a reader
// of "approve the assignee rule" actually means. Prefer `codes`; `code` stays for a
// deliberate "any difference mentioning this code" approval.
function approvalMatches(approval, diff) {
  if (approval.class !== diff.class) return false;
  if (diff.class === 'planner-failed') return approval.issue === undefined && approval.code === undefined && approval.codes === undefined;
  if (approval.issue !== undefined && approval.issue !== null && Number(approval.issue) !== diff.issue) return false;
  if (approval.code !== undefined && approval.code !== null && !(diff.codes || []).includes(String(approval.code))) return false;
  if (approval.codes !== undefined && approval.codes !== null) {
    const wanted = [...new Set(approval.codes.map(String))].sort();
    const actual = [...new Set((diff.codes || []).map(String))].sort();
    if (wanted.length !== actual.length || wanted.some((code, index) => code !== actual[index])) return false;
  }
  return true;
}

function frontierKey(line) {
  return numbers(line.hook?.frontier).join(',');
}

function compareAssignmentParity({ root, tenant } = {}) {
  const config = readConfig(root);
  const required = Number(config.parityEvaluations);
  const requiredDistinct = Number(config.parityDistinctFrontiers);
  const requiredHours = Number(config.parityHours);
  const all = readShadow(root, tenant);
  // The window is the trailing parityHours of evaluations, anchored on the newest one, NOT
  // the last N. A trailing-N window shrinks whenever the lead is busy - each new evaluation
  // pushes an older one out - so its span could sit hours below the requirement forever and
  // the gate could not be reached by working normally (reviewed 2026-09-06, ADR 0006).
  // A time window only grows as evidence accumulates, so it converges.
  // parityHours <= 0 disables the time requirement entirely: every evaluation is in the
  // window and only the count, the distinct frontiers and the approvals gate.
  const newestMs = all.length ? Date.parse(all[all.length - 1].at) : null;
  const cutoffMs = newestMs === null || requiredHours <= 0 ? null : newestMs - requiredHours * 60 * MIN;
  const recent = cutoffMs === null ? all : all.filter((line) => Date.parse(line.at) >= cutoffMs);
  const approvals = readApprovals(root);
  const classes = Object.fromEntries(CLASSES.map((cls) => [cls, 0]));
  const differences = [];
  for (const line of recent) {
    const cls = line.planner?.error ? 'planner-failed' : (line.agree ? 'identical' : null);
    if (cls) classes[cls] += 1;
    for (const diff of line.differences || []) {
      if (!cls) classes[diff.class] = (classes[diff.class] || 0) + 1;
      const entry = { at: line.at, ...diff };
      const approval = approvals.find((candidate) => approvalMatches(candidate, entry));
      entry.approved = Boolean(approval);
      if (approval) { entry.approvalNote = approval.note || ''; entry.approvedBy = approval.by || null; }
      differences.push(entry);
    }
  }
  const unapproved = differences.filter((diff) => !diff.approved);
  const distinctFrontiers = new Set(recent.map(frontierKey)).size;
  // The evidence has to reach back across the window, not cluster in one busy hour of it.
  // The oldest evaluation in the window is by construction no older than parityHours, so
  // the requirement is that it sits in the window's first tenth.
  const spanHours = recent.length ? Math.round(((Date.parse(recent[recent.length - 1].at) - Date.parse(recent[0].at)) / (60 * MIN)) * 100) / 100 : 0;
  const requiredSpanHours = Math.round(requiredHours * COVERAGE * 100) / 100;
  const reasons = [];
  if (recent.length < required) reasons.push(`evaluations ${recent.length} < required ${required} in the last ${requiredHours} h`);
  if (requiredHours > 0 && recent.length > 0 && spanHours < requiredSpanHours) reasons.push(`evidence spans ${spanHours} h of the ${requiredHours} h window, under the required ${requiredSpanHours} h`);
  if (recent.length > 0 && distinctFrontiers < requiredDistinct) reasons.push(`distinct frontiers ${distinctFrontiers} < required ${requiredDistinct}`);
  if (unapproved.length > 0) reasons.push(`${unapproved.length} unapproved difference(s) inside the window`);
  return {
    pass: reasons.length === 0,
    reasons,
    tenant: tenant || null,
    evaluations: recent.length,
    required,
    distinctFrontiers,
    requiredDistinct,
    spanHours,
    requiredHours,
    requiredSpanHours,
    window: recent.length ? { start: recent[0].at, end: recent[recent.length - 1].at } : null,
    totals: { evaluations: all.length },
    classes,
    differences,
    unapproved,
  };
}

function renderText(result) {
  const lines = [];
  lines.push(`ASSIGNMENT PARITY: ${result.pass ? 'PASS' : 'FAIL'} (the last ${result.requiredHours} h must hold ${result.required} evaluations reaching back ${result.requiredSpanHours} h over ${result.requiredDistinct} distinct frontiers)`);
  lines.push(`evaluations in window: ${result.evaluations} of ${result.totals.evaluations} recorded${result.window ? ` (${result.window.start} .. ${result.window.end}, spanning ${result.spanHours} h)` : ''}; distinct frontiers: ${result.distinctFrontiers}`);
  lines.push(`classes: ${Object.entries(result.classes).map(([cls, n]) => `${cls}=${n}`).join(', ')}`);
  for (const reason of result.reasons) lines.push(`reason: ${reason}`);
  if (result.differences.length) {
    lines.push('differences:');
    for (const diff of result.differences) {
      const mark = diff.approved ? ' [approved]' : ' [UNAPPROVED]';
      lines.push(`  ${diff.at} ${diff.class}${diff.issue ? ` #${diff.issue}` : ''}${diff.codes?.length ? ` (${diff.codes.join(', ')})` : ''}${diff.detail ? ` - ${diff.detail}` : ''}${mark}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// The hook's frontier travels as "1,2,3" or the literal 'none' (PowerShell 5.1 drops an
// empty native argument). Anything else is a mangled call and must not read as an empty
// frontier, which against an empty planner frontier would count as agreement.
function parseList(value) {
  if (value === undefined || value === 'none') return [];
  const tokens = String(value).split(/[\s,]+/).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !/^\d+$/.test(token))) throw new Error(`invalid --hook-frontier '${value}': expected issue numbers or 'none'`);
  return tokens.map(Number);
}

// `observe` runs the planner's frontier in the same process the hook is in, so the
// two frontiers read GitHub seconds apart, and records the pair.
function cli(argv) {
  const [command, ...rest] = argv;
  if (!ASSIGNMENT_PARITY_FLAGS[command]) {
    throw new AssignmentParityError('USAGE', `unknown command '${command}'; commands: ${Object.keys(ASSIGNMENT_PARITY_FLAGS).join(', ')}`);
  }
  let args;
  try {
    args = workState.parseArgs(rest, ASSIGNMENT_PARITY_FLAGS[command]);
  } catch (error) {
    if (error.code === 'USAGE') throw new AssignmentParityError('USAGE', error.message, { flag: error.flag, accepted: error.accepted, command });
    throw error;
  }
  if (command === 'observe') {
    const assignment = require('./assignment');
    const exclusions = require('./exclusions');
    const tenant = args.tenant || 'endzone';
    const readyLabel = args['ready-label'] || 'ready-for-agent';
    let planner;
    try {
      // FLEET_GITHUB_ISSUES_FIXTURE is the test seam: Node's execFileSync cannot run a
      // .cmd mock on Windows, so a fixture fleet supplies the GraphQL answer as a file.
      const fixture = args.fixture || process.env.FLEET_GITHUB_ISSUES_FIXTURE;
      const issues = fixture
        ? JSON.parse(stripBom(fs.readFileSync(path.resolve(fixture), 'utf8')))
        : assignment.queryGithubIssues({ repo: args.repo, readyLabel, fetchDetails: true });
      const base = baseOf(args.root);
      const readState = (relative, fallback) => {
        const file = path.join(base, relative);
        return fs.existsSync(file) ? JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) : fallback;
      };
      planner = assignment.selectFrontier({
        issues, readyLabel,
        active: readState(path.join('state', 'work', 'active.json'), []),
        skipIssues: readState(path.join('state', 'skip', `${tenant}.json`), {}),
        exclusions: exclusions.activeExclusions({ root: args.root, tenant, now: args.now }),
        // The observer must apply exactly the rules the planner will apply when it is
        // authoritative, or the ledger records a difference the live path would not make.
        fleetIdentity: assignment.readTenantConfig(args.root, tenant).fleetIdentity,
        tenant,
        now: args.now,
      });
    } catch (error) {
      planner = { eligible: [], excluded: [], error: `${error.code || 'ERROR'}: ${error.message}` };
    }
    const line = observeFrontier({ root: args.root, tenant, hookFrontier: parseList(args['hook-frontier']), hookReason: args['hook-reason'], planner, mode: args.mode, now: args.now });
    return { at: line.at, mode: line.mode, agree: line.agree, hookFrontier: line.hook.frontier, plannerFrontier: line.planner.frontier, plannerError: line.planner.error, differences: line.differences, live: line.mode === 'live' };
  }
  // command === 'report' (the only other key ASSIGNMENT_PARITY_FLAGS carries)
  const result = compareAssignmentParity({ root: args.root, tenant: args.tenant || 'endzone' });
  if (args.json === 'true') return result;
  process.stdout.write(renderText(result));
  process.exitCode = result.pass ? 0 : 2;
  return null;
}

if (require.main === module) {
  try {
    const result = cli(process.argv.slice(2));
    if (result !== null) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.pass === false) process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message })}\n`);
    // fleet#4: exit 2 already means "gate FAILED" for `report` (README: "exit 2 on
    // fail"), so a refused (typo'd) invocation must not share it - EX_USAGE (64) keeps
    // a gate failure and a usage error distinguishable by status alone.
    process.exitCode = error.code === 'USAGE' ? 64 : 1;
  }
}

module.exports = {
  ASSIGNMENT_PARITY_FLAGS,
  AssignmentParityError,
  CLASSES,
  classifyEvaluation,
  cli,
  compareAssignmentParity,
  isAssignmentLive,
  observeFrontier,
  readShadow,
  renderText,
};
