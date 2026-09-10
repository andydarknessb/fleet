'use strict';
// Ticket 06: deterministic rotation policy for control-plane sessions.
// Reads only canonical state (roster, event ledger, transcript usage fields,
// config/cycle.json) and never touches a session: rotate.ps1 acts on the report.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const workState = require('./work-state');

// fleet#4: refuse an unknown command or flag rather than silently ignore it.
class RotationPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RotationPolicyError';
    this.code = code;
    Object.assign(this, details);
  }
}

const ROTATION_POLICY_FLAGS = {
  evaluate: ['root', 'claude-home', 'now'],
  offset: ['root', 'now'],
};

// Spec fallbacks ("Outcomes and budgets"); config/cycle.json overrides.
const DEFAULT_ROTATION = Object.freeze({
  dispatcher: { maxAgeHours: 24 },
  'project-lead': { maxAgeHours: 24, maxMerges: 5, maxJobTokens: 250000 },
});

function asRoot(root) {
  return path.resolve(root || path.resolve(__dirname, '..'));
}

function readJson(file, fallback = null) {
  // Fail-soft: a torn or half-written state file makes this tick a no-op, not a crash.
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function isoNow(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp: ${value}`);
  return date.toISOString();
}

function rotationConfig(root) {
  // Per-role merge: a config entry that names only some thresholds keeps the spec
  // fallbacks for the rest (set a threshold to null to disable it deliberately).
  const config = readJson(path.join(asRoot(root), 'config', 'cycle.json'), {}) || {};
  const merged = {};
  for (const role of new Set([...Object.keys(DEFAULT_ROTATION), ...Object.keys(config.rotation || {})])) {
    merged[role] = { ...(DEFAULT_ROTATION[role] || {}), ...((config.rotation || {})[role] || {}) };
  }
  return merged;
}

function listEventFiles(root) {
  const eventsDir = path.join(asRoot(root), 'state', 'events');
  const files = [];
  for (const directory of [eventsDir, path.join(eventsDir, 'archive')]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter((entry) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))) {
      files.push(path.join(directory, name));
    }
  }
  return files.sort();
}

function readEvents(root) {
  const events = [];
  const files = [];
  for (const file of listEventFiles(root)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let count = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      // A writer may be mid-append; a torn trailing line is not yet an event.
      try { events.push(JSON.parse(line)); count += 1; } catch { /* skip */ }
    }
    files.push({ file: path.relative(asRoot(root), file), events: count });
  }
  return { events, files };
}

function captureOffset({ root, now } = {}) {
  const { events, files } = readEvents(root);
  const perRecord = {};
  for (const event of events) {
    const sequence = Number(event.sequence) || 0;
    if (!event.recordId) continue;
    if (!(event.recordId in perRecord) || perRecord[event.recordId] < sequence) perRecord[event.recordId] = sequence;
  }
  return { schemaVersion: 1, capturedAt: isoNow(now), totalEvents: events.length, files, perRecord };
}

function findTranscript(claudeHome, sessionId) {
  if (!sessionId || !claudeHome) return null;
  const projects = path.join(claudeHome, 'projects');
  if (!fs.existsSync(projects)) return null;
  const wanted = `${sessionId}.jsonl`;
  const pending = [projects];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === wanted) return candidate;
    }
  }
  return null;
}

async function sumTranscriptTokens(file) {
  // Streamed: a long-lived project lead's transcript runs to tens of MB.
  const totals = { inputTokens: 0, outputTokens: 0, jobTokens: 0, usageRows: 0 };
  const reader = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.includes('"usage"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const usage = row && row.message && row.message.usage;
    if (!usage) continue;
    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.usageRows += 1;
  }
  // Job tokens per the measured-baseline definition (measure-cycle.js): input + output.
  totals.jobTokens = totals.inputTokens + totals.outputTokens;
  return totals;
}

function countMerges(events, { tenant, since }) {
  const sinceMs = new Date(since).getTime();
  let merges = 0;
  for (const event of events) {
    if (event.type !== 'state-merged') continue;
    const at = new Date(event.at || 0).getTime();
    if (!Number.isFinite(at) || at < sinceMs) continue;
    if (tenant && !String(event.recordId || '').startsWith(`${tenant}:`)) continue;
    merges += 1;
  }
  return merges;
}

async function evaluate({ root, claudeHome, now } = {}) {
  const base = asRoot(root);
  const evaluatedAt = isoNow(now);
  const rotation = rotationConfig(base);
  const home = claudeHome || path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
  const staticRoster = readJson(path.join(base, 'roster.json'), { sessions: [] });
  const staticNames = new Set((staticRoster.sessions || []).map((row) => String(row.name)));
  const live = readJson(path.join(base, 'state', 'roster.json'), { sessions: [] });
  const { events } = readEvents(base);

  const sessions = [];
  for (const row of live.sessions || []) {
    const role = String(row.role || '');
    if (row.status !== 'active' || !(role in rotation) || !staticNames.has(String(row.name))) continue;
    const thresholds = rotation[role];
    const entry = {
      name: String(row.name), role, tenant: row.tenant || null, sessionId: row.sessionId || null,
      launchedAt: row.launchedAt || null, thresholds,
      metrics: { ageHours: null, merges: null, jobTokens: null },
      due: false, reasons: [], metricsError: null,
    };
    const launchedMs = new Date(row.launchedAt || NaN).getTime();
    if (!Number.isFinite(launchedMs)) {
      // Rotation is maintenance: an unreadable launchedAt is surfaced, never guessed due.
      entry.metricsError = `launchedAt is unreadable: ${row.launchedAt}`;
      sessions.push(entry);
      continue;
    }
    entry.metrics.ageHours = (new Date(evaluatedAt).getTime() - launchedMs) / 3600000;
    if (Number.isFinite(thresholds.maxAgeHours) && entry.metrics.ageHours >= thresholds.maxAgeHours) {
      entry.reasons.push(`age ${entry.metrics.ageHours.toFixed(1)}h >= ${thresholds.maxAgeHours}h`);
    }
    if (Number.isFinite(thresholds.maxMerges)) {
      entry.metrics.merges = countMerges(events, { tenant: entry.tenant, since: row.launchedAt });
      if (entry.metrics.merges >= thresholds.maxMerges) {
        entry.reasons.push(`merges ${entry.metrics.merges} >= ${thresholds.maxMerges}`);
      }
    }
    if (Number.isFinite(thresholds.maxJobTokens)) {
      const transcript = findTranscript(home, entry.sessionId);
      if (!transcript) {
        // Surfaced, never fatal: age and merges still rotate a session whose
        // transcript cannot be located, but the gap must be visible.
        entry.metricsError = `transcript not found for sessionId ${entry.sessionId}`;
      } else {
        try {
          const totals = await sumTranscriptTokens(transcript);
          entry.metrics.jobTokens = totals.jobTokens;
          if (totals.jobTokens >= thresholds.maxJobTokens) {
            entry.reasons.push(`job tokens ${totals.jobTokens} >= ${thresholds.maxJobTokens}`);
          }
        } catch (error) {
          entry.metricsError = `transcript unreadable: ${String(error.message || error)}`;
        }
      }
    }
    entry.due = entry.reasons.length > 0;
    sessions.push(entry);
  }
  return { schemaVersion: 1, evaluatedAt, sessions };
}

async function cli(argv) {
  const [command, ...rest] = argv;
  const commands = Object.keys(ROTATION_POLICY_FLAGS);
  if (!ROTATION_POLICY_FLAGS[command]) {
    throw new RotationPolicyError('USAGE', `unknown command '${command}'; commands: ${commands.join(', ')}`);
  }
  let args;
  try {
    args = workState.parseArgs(rest, ROTATION_POLICY_FLAGS[command]);
  } catch (error) {
    if (error.code === 'USAGE') throw new RotationPolicyError('USAGE', error.message, { flag: error.flag, accepted: error.accepted, command });
    throw error;
  }
  if (command === 'evaluate') return evaluate({ root: args.root, claudeHome: args['claude-home'], now: args.now });
  return captureOffset({ root: args.root, now: args.now });
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      if (error.code === 'USAGE') {
        process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
        process.exitCode = 2;
      } else {
        process.stderr.write(`${JSON.stringify({ error: String(error.message || error) })}\n`);
        process.exitCode = 1;
      }
    });
}

module.exports = { captureOffset, evaluate, findTranscript, sumTranscriptTokens, countMerges, rotationConfig, cli, ROTATION_POLICY_FLAGS, RotationPolicyError };
