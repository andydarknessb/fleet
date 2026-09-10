'use strict';
// Ticket 09 telemetry: one place to read the IC budget. Folds every budget crossing in
// the event ledger (budget-warning, budget-extended, a state-escalated whose evidence
// names the budget) with the latest measurement (state/budget/last.json) and, when the
// collector's seven-day JSON exists, the completed-unit medians, all broken down by day
// and by model family, so the sonnet and haiku floors can be read cleanly at the end of
// the soak. Output: state/budget/summary.md and state/budget/summary.json. Read-only
// apart from those two files.

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');

// fleet#4: refuse an unknown flag rather than silently ignore it.
class BudgetReportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BudgetReportError';
    this.code = code;
    Object.assign(this, details);
  }
}

const BUDGET_REPORT_FLAGS = ['root', 'now'];

function baseOf(root) { return path.resolve(root || path.join(__dirname, '..')); }
function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
function readJson(file, fallback) {
  try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))); } catch { return fallback; }
}

function family(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return m ? 'other' : 'unknown';
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
}

// The model an IC session ran as, from the roster row named ic-<issue> for the tenant.
function rosterModels(root) {
  const roster = readJson(path.join(baseOf(root), 'state', 'roster.json'), { sessions: [] });
  const rows = Array.isArray(roster) ? roster : roster.sessions || [];
  const byIssue = new Map();
  for (const row of rows) {
    if (row.role !== 'ic' || !Number(row.issue)) continue;
    const key = `${row.tenant}:issue-${Number(row.issue)}`;
    const prev = byIssue.get(key);
    if (!prev || String(row.launchedAt || '') > String(prev.launchedAt || '')) byIssue.set(key, row);
  }
  return byIssue;
}

function isBudgetEscalation(event) {
  return event.type === 'state-escalated' && /budget:/.test(String(event.evidence || ''));
}

function buildSummary({ root, now } = {}) {
  const base = baseOf(root);
  const at = now || new Date().toISOString();
  const models = rosterModels(base);
  const modelOf = (recordId) => family(models.get(recordId)?.model);
  const crossings = workState.readEvents(base)
    .filter((e) => e.type === 'budget-warning' || e.type === 'budget-extended' || isBudgetEscalation(e))
    .map((e) => ({
      at: e.at, day: String(e.at).slice(0, 10), recordId: e.recordId, model: modelOf(e.recordId),
      kind: e.type === 'state-escalated' ? 'budget-escalation' : e.type,
      tokens: e.changes?.cumulativeTokens ?? e.changes?.extension?.tokens ?? null,
      by: e.changes?.extension?.by ?? e.actor ?? null,
      evidence: e.evidence || null,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const byDay = {};
  for (const c of crossings) {
    const day = byDay[c.day] || (byDay[c.day] = { warnings: 0, extensions: 0, escalations: 0, byModel: {} });
    const bucket = c.kind === 'budget-warning' ? 'warnings' : c.kind === 'budget-extended' ? 'extensions' : 'escalations';
    day[bucket] += 1;
    const m = day.byModel[c.model] || (day.byModel[c.model] = { warnings: 0, extensions: 0, escalations: 0 });
    m[bucket] += 1;
  }
  const last = readJson(path.join(base, 'state', 'budget', 'last.json'), null);
  const live = { at: last?.at || null, mode: last?.mode || null, config: last?.config || null, byModel: {} };
  for (const r of last?.records || []) {
    const m = family(models.get(r.id)?.model);
    const bucket = live.byModel[m] || (live.byModel[m] = { measured: 0, unmeasured: 0, warn: 0, escalate: 0, jobTokens: [] });
    if (r.jobTokens === null || r.jobTokens === undefined) bucket.unmeasured += 1;
    else { bucket.measured += 1; bucket.jobTokens.push(r.jobTokens); }
    if (r.decision === 'warn') bucket.warn += 1;
    if (r.decision === 'escalate') bucket.escalate += 1;
  }
  for (const b of Object.values(live.byModel)) { b.medianJobTokens = median(b.jobTokens); b.maxJobTokens = b.jobTokens.length ? Math.max(...b.jobTokens) : null; delete b.jobTokens; }
  const metricsDir = path.join(base, 'state', 'metrics');
  const sevenDayFile = fs.existsSync(metricsDir) ? fs.readdirSync(metricsDir).filter((n) => /^seven-day-.*\.json$/.test(n)).sort().pop() : null;
  const sevenDay = sevenDayFile ? readJson(path.join(metricsDir, sevenDayFile), null) : null;
  const completed = { source: sevenDayFile || null, window: sevenDay?.period || null, byModel: {} };
  for (const u of sevenDay?.units || []) {
    const m = family(u.model);
    const bucket = completed.byModel[m] || (completed.byModel[m] = { units: 0, jobTokens: [] });
    bucket.units += 1;
    bucket.jobTokens.push(Number(u.metrics?.jobTokens));
  }
  for (const b of Object.values(completed.byModel)) { b.medianJobTokens = median(b.jobTokens); b.p90JobTokens = (() => { const s = b.jobTokens.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : null; })(); delete b.jobTokens; }
  const summary = {
    at,
    soak: last?.config ? { warnTokens: last.config.warnTokens, escalateTokens: last.config.escalateTokens, warningOnly: last.config.escalateTokens === null || last.config.escalateTokens === undefined } : null,
    totals: { crossings: crossings.length, warnings: crossings.filter((c) => c.kind === 'budget-warning').length, extensions: crossings.filter((c) => c.kind === 'budget-extended').length, escalations: crossings.filter((c) => c.kind === 'budget-escalation').length },
    byDay,
    live,
    completed,
    crossings,
  };
  const dir = path.join(base, 'state', 'budget');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'summary.md'), render(summary), 'utf8');
  return summary;
}

function render(s) {
  const lines = [`# IC budget summary - ${s.at}`, ''];
  if (s.soak) lines.push(`thresholds: warn ${s.soak.warnTokens}, escalate ${s.soak.escalateTokens === null || s.soak.escalateTokens === undefined ? 'OFF (warning-only soak)' : s.soak.escalateTokens} job tokens`);
  lines.push(`crossings: ${s.totals.crossings} (warnings ${s.totals.warnings}, extensions ${s.totals.extensions}, escalations ${s.totals.escalations})`, '');
  lines.push('## By day', '');
  const days = Object.keys(s.byDay).sort();
  if (!days.length) lines.push('No crossings recorded.');
  for (const day of days) {
    const d = s.byDay[day];
    const models = Object.entries(d.byModel).map(([m, v]) => `${m}: ${v.warnings}w/${v.extensions}x/${v.escalations}e`).join(', ');
    lines.push(`- ${day}: warnings ${d.warnings}, extensions ${d.extensions}, escalations ${d.escalations} (${models})`);
  }
  lines.push('', `## Live measurement (${s.live.at || 'no run'}, mode ${s.live.mode || 'n/a'})`, '');
  const liveModels = Object.keys(s.live.byModel).sort();
  if (!liveModels.length) lines.push('No active IC measured.');
  for (const m of liveModels) {
    const b = s.live.byModel[m];
    lines.push(`- ${m}: measured ${b.measured}, unmeasured ${b.unmeasured}, over warn ${b.warn}, over escalate ${b.escalate}; median job tokens ${b.medianJobTokens ?? 'n/a'}, max ${b.maxJobTokens ?? 'n/a'}`);
  }
  lines.push('', `## Completed units by model (${s.completed.source || 'no collector report'})`, '');
  const doneModels = Object.keys(s.completed.byModel).sort();
  if (!doneModels.length) lines.push('No completed units in the collector window.');
  for (const m of doneModels) {
    const b = s.completed.byModel[m];
    lines.push(`- ${m}: ${b.units} unit(s); median job tokens ${b.medianJobTokens ?? 'n/a'}, p90 ${b.p90JobTokens ?? 'n/a'}`);
  }
  lines.push('', '## Crossings', '');
  if (!s.crossings.length) lines.push('None.');
  for (const c of s.crossings.slice(-200)) lines.push(`- ${c.at} ${c.kind} ${c.recordId} [${c.model}]${c.tokens !== null ? ` ${c.tokens} tokens` : ''}${c.by ? ` by ${c.by}` : ''}`);
  return `${lines.join('\n')}\n`;
}

function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, BUDGET_REPORT_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new BudgetReportError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  return buildSummary({ root: args.root, now: args.now });
}

if (require.main === module) {
  try {
    const summary = cli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ at: summary.at, totals: summary.totals, live: Object.fromEntries(Object.entries(summary.live.byModel).map(([m, b]) => [m, { measured: b.measured, warn: b.warn, escalate: b.escalate, median: b.medianJobTokens }])) })}\n`);
  } catch (error) {
    if (error.code === 'USAGE') {
      process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { buildSummary, family, median, render, cli, BUDGET_REPORT_FLAGS, BudgetReportError };
