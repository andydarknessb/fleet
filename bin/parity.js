'use strict';
// Ticket 08b: the parity gate between the two supervisors. The watchdog logs the
// mechanical check's PROPOSED action set every tick (state/sentinel/shadow/); the
// rostered Sentinel's ticks log what the same check APPLIED (state/sentinel/applied/,
// written by sentinel-check.ps1 -Apply). This tool pairs the two logs tick by tick,
// classifies every difference, and reports whether the most recent continuous run
// of paired ticks covers the required hours with every difference either expected
// by construction or approved in state/sentinel/parity-approved.json.
//
// The two observers never see the same instant: the Sentinel's cron fires first and
// its script acts; the watchdog runs ~90s later and sees the cured state. So the
// expected shape of an applied action is: the shadow tick BEFORE it proposed the same
// thing (the condition was already visible) and the shadow tick after it does not
// (cured). That is applied-next-tick when the proposing tick is paired, and
// applied-before-shadow when the proposing tick had no Sentinel partner. An applied
// action no shadow tick proposed is unproposed-action, and a proposal no Sentinel
// tick applied is proposed-not-applied: both gate until Cory approves them (a
// condition that arose inside the ~13-minute gap between the two observers is the
// usual honest reason). Escalations are standing reports compared symmetrically;
// one side reporting a tick early or late is timing.

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');

// fleet#4: refuse an unknown flag rather than silently ignore it.
class ParityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ParityError';
    this.code = code;
    Object.assign(this, details);
  }
}

const PARITY_FLAGS = ['root', 'since', 'until', 'now', 'hours', 'actor', 'json'];

const MIN = 60 * 1000;
const DEFAULTS = Object.freeze({ parityHours: 48, pairWindowMinutes: 10, maxGapMinutes: 35, tickMinutes: 15 });
// One descriptor per compared category: how an item is identified, and whether the
// check itself performs it (applying) or merely reports it (standing).
const CATEGORY_SPECS = Object.freeze({
  respawned: { applying: true, key: (item) => item.name, describe: (item) => ({ name: item.name, kind: null }) },
  launchNeeded: { applying: true, key: (item) => item.name, describe: (item) => ({ name: item.name, kind: null }) },
  retired: { applying: true, key: (item) => (typeof item === 'string' ? item : item.name), describe: (item) => ({ name: typeof item === 'string' ? item : item.name, kind: null }) },
  worktrees: { applying: true, key: (item) => item.path, describe: (item) => ({ name: item.path, kind: null }) },
  // sync-integration: an applied fast-forward (synced) or a read-only run that would fast-forward.
  sync: { applying: true, key: (item) => (item.synced === true || (item.dryRun && Number(item.wouldFastForward) > 0) ? item.tenant : null), describe: (item) => ({ name: item.tenant, kind: null }) },
  pause: { applying: true, scalar: true, key: (value) => (value === null || value === undefined ? null : String(value)), describe: (value) => ({ name: String(value), kind: null }) },
  escalate: { applying: false, key: (item) => `${item.name}:${item.kind}`, describe: (item) => ({ name: item.name, kind: item.kind }) },
});
const CATEGORIES = Object.freeze(Object.keys(CATEGORY_SPECS));
const EXPECTED_CLASSES = Object.freeze(['applied-before-shadow', 'applied-next-tick', 'timing']);

function readConfig(root) {
  let supervisor = {};
  try { supervisor = JSON.parse(fs.readFileSync(path.join(root, 'config', 'cycle.json'), 'utf8')).supervisor || {}; } catch {}
  return { ...DEFAULTS, ...supervisor };
}

function readJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* a torn line is not evidence either way */ }
    }
  }
  return entries;
}

function itemsOf(set, category) {
  const spec = CATEGORY_SPECS[category];
  const map = new Map();
  if (!set) return map;
  const value = set[category];
  const items = spec.scalar ? [value] : (Array.isArray(value) ? value : []);
  for (const item of items) {
    if (item === null || item === undefined) continue;
    let key = null;
    try { key = spec.key(item); } catch { key = null; }
    if (key === null || key === undefined || key === '') continue;
    map.set(String(key), spec.describe(item));
  }
  return map;
}

function loadTicks(root, opts) {
  const sinceMs = opts.since ? Date.parse(opts.since) : -Infinity;
  const untilMs = opts.until ? Date.parse(opts.until) : (opts.now ? Date.parse(opts.now) : Date.now());
  const within = (entry) => {
    const ms = Date.parse(entry.at);
    return Number.isFinite(ms) && ms >= sinceMs && ms <= untilMs ? ms : null;
  };
  const shadow = [];
  for (const entry of readJsonl(path.join(root, 'state', 'sentinel', 'shadow'))) {
    if (entry.verify === true) continue;
    if (entry.mode && entry.mode !== 'shadow') continue;   // a live supervisor tick has no Sentinel partner
    const ms = within(entry);
    if (ms === null) continue;
    const set = entry.proposed || null;
    shadow.push({ side: 'shadow', ms, at: entry.at, set, checkError: entry.checkError || '', readError: set && set.daemonReadError ? String(set.daemonReadError) : '' });
  }
  const applied = [];
  for (const entry of readJsonl(path.join(root, 'state', 'sentinel', 'applied'))) {
    if (entry.applied !== true) continue;
    if ((entry.actor || 'sentinel') !== (opts.actor || 'sentinel')) continue;
    const ms = within(entry);
    if (ms === null) continue;
    applied.push({ side: 'applied', ms, at: entry.at, set: entry, readError: entry.daemonReadError ? String(entry.daemonReadError) : '' });
  }
  shadow.sort((a, b) => a.ms - b.ms);
  applied.sort((a, b) => a.ms - b.ms);
  return { shadow, applied };
}

function pairTicks(shadow, applied, pairWindowMs) {
  const taken = new Set();
  const pairs = [];
  for (const s of shadow) {
    let best = null;
    for (let index = 0; index < applied.length; index += 1) {
      if (taken.has(index)) continue;
      const distance = Math.abs(applied[index].ms - s.ms);
      if (distance > pairWindowMs) { if (applied[index].ms > s.ms) break; continue; }
      if (!best || distance < best.distance) best = { index, distance };
    }
    if (best) { taken.add(best.index); pairs.push({ shadow: s, applied: applied[best.index] }); }
    else pairs.push({ shadow: s, applied: null });
  }
  const unpairedApplied = applied.filter((_, index) => !taken.has(index));
  return { pairs, unpairedApplied };
}

function mostRecentRun(pairedShadows, maxGapMs) {
  // The most recent run of paired ticks with no gap wider than maxGap; a gap restarts the clock.
  if (pairedShadows.length === 0) return null;
  let start = pairedShadows[0].ms;
  let prev = start;
  for (const tick of pairedShadows.slice(1)) {
    if (tick.ms - prev > maxGapMs) start = tick.ms;
    prev = tick.ms;
  }
  return { startMs: start, endMs: prev };
}

function approvalMatches(approval, diff) {
  if (approval.class !== diff.class) return false;
  for (const field of ['category', 'name', 'kind']) {
    if (approval[field] !== undefined && approval[field] !== null && approval[field] !== diff[field]) return false;
  }
  return true;
}

function compareParity(opts = {}) {
  const root = path.resolve(opts.root || path.resolve(__dirname, '..'));
  const config = readConfig(root);
  const parityHours = Number(opts.hours || config.parityHours);
  const pairWindowMs = Number(config.pairWindowMinutes) * MIN;
  const maxGapMs = Number(config.maxGapMinutes) * MIN;
  const adjacentMs = (Number(config.tickMinutes) + Number(config.pairWindowMinutes)) * MIN;
  const { shadow, applied } = loadTicks(root, opts);
  const { pairs, unpairedApplied } = pairTicks(shadow, applied, pairWindowMs);
  const has = (tick, category, key) => Boolean(tick && tick.set && itemsOf(tick.set, category).has(key));
  const nextApplied = (ms) => applied.find((a) => a.ms > ms && a.ms - ms <= adjacentMs) || null;
  const prevApplied = (ms) => [...applied].reverse().find((a) => a.ms < ms && ms - a.ms <= adjacentMs) || null;
  const nextShadow = (ms) => shadow.find((s) => s.ms > ms && s.ms - ms <= adjacentMs) || null;
  const prevShadow = (ms) => [...shadow].reverse().find((s) => s.ms < ms && ms - s.ms <= adjacentMs) || null;

  const differences = [];
  const classes = { identical: 0 };
  const consumed = new Set();   // applied items already explained as the application of a paired shadow proposal
  const count = (cls) => { classes[cls] = (classes[cls] || 0) + 1; };
  const push = (diff) => { differences.push(diff); count(diff.class); };
  const tickDiff = (tick, cls, detail) => push({ at: tick.at, class: cls, category: 'tick', name: null, kind: null, side: tick.side, detail });

  for (const { shadow: s, applied: a } of pairs) {
    if (!a) { tickDiff(s, 'sentinel-tick-missing', 'no Sentinel tick within the pairing window'); continue; }
    if (!s.set) { tickDiff(s, 'shadow-check-failed', s.checkError || 'shadow check produced no proposal'); continue; }
    // A fail-closed tick proposed nothing because it could not see the fleet; it is not clean evidence.
    if (s.readError) { tickDiff(s, 'shadow-read-failed', s.readError); continue; }
    if (a.readError) { tickDiff(a, 'sentinel-read-failed', a.readError); continue; }
    for (const category of CATEGORIES) {
      const spec = CATEGORY_SPECS[category];
      const proposed = itemsOf(s.set, category);
      const done = itemsOf(a.set, category);
      for (const [key, item] of proposed) {
        if (done.has(key)) { count('identical'); continue; }
        const base = { at: s.at, category, name: item.name, kind: item.kind, side: 'shadow' };
        if (spec.applying) {
          const next = nextApplied(s.ms);
          if (has(next, category, key)) { consumed.add(`${next.ms}|${category}|${key}`); push({ ...base, class: 'applied-next-tick', detail: `proposed by the shadow, applied by the Sentinel tick at ${next.at}` }); }
          else push({ ...base, class: 'proposed-not-applied', detail: 'proposed by the shadow; no Sentinel tick applied it within one cadence' });
        } else {
          const near = [prevApplied(s.ms), nextApplied(s.ms)].some((t) => has(t, category, key));
          push({ ...base, class: near ? 'timing' : 'report-drift', detail: near ? 'reported by the shadow; the Sentinel reported it one tick away' : 'reported by the shadow only' });
        }
      }
      for (const [key, item] of done) {
        if (proposed.has(key)) continue;
        if (consumed.has(`${a.ms}|${category}|${key}`)) continue;
        const base = { at: a.at, category, name: item.name, kind: item.kind, side: 'applied' };
        if (spec.applying) {
          if (has(prevShadow(a.ms), category, key)) push({ ...base, class: 'applied-before-shadow', detail: 'proposed by the previous (unpaired) shadow tick; applied at this Sentinel tick, cured before the next shadow tick' });
          else push({ ...base, class: 'unproposed-action', detail: 'applied by the Sentinel; no shadow tick before or at it proposed this' });
        } else {
          const near = [prevShadow(a.ms), nextShadow(a.ms)].some((t) => has(t, category, key));
          push({ ...base, class: near ? 'timing' : 'report-drift', detail: near ? 'reported by the Sentinel; the shadow reported it one tick away' : 'reported by the Sentinel only' });
        }
      }
    }
  }
  for (const a of unpairedApplied) tickDiff(a, 'shadow-tick-missing', 'no shadow tick within the pairing window');
  differences.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));

  const pairedShadows = pairs.filter((p) => p.applied).map((p) => p.shadow);
  const run = mostRecentRun(pairedShadows, maxGapMs);
  const continuousHours = run ? Math.round(((run.endMs - run.startMs) / (60 * MIN)) * 100) / 100 : 0;
  const window = run ? { start: new Date(run.startMs).toISOString(), end: new Date(run.endMs).toISOString(), ticks: pairedShadows.filter((s) => s.ms >= run.startMs && s.ms <= run.endMs).length } : null;

  let approvals = [];
  try {
    const raw = fs.readFileSync(path.join(root, 'state', 'sentinel', 'parity-approved.json'), 'utf8');
    approvals = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!Array.isArray(approvals)) approvals = [];
  } catch {}
  for (const diff of differences) {
    const ms = Date.parse(diff.at);
    diff.inWindow = Boolean(run) && ms >= run.startMs && ms <= run.endMs;
    diff.expected = EXPECTED_CLASSES.includes(diff.class);
    const approval = diff.expected ? null : approvals.find((entry) => approvalMatches(entry, diff));
    diff.approved = Boolean(approval);
    if (approval) { diff.approvalNote = approval.note || ''; diff.approvedBy = approval.by || null; }
  }
  const unapproved = differences.filter((diff) => diff.inWindow && !diff.expected && !diff.approved);
  const reasons = [];
  if (!run) reasons.push('no paired ticks: both logs must exist for the same period');
  else if (continuousHours < parityHours) reasons.push(`continuous paired hours ${continuousHours} < required ${parityHours}`);
  if (unapproved.length > 0) reasons.push(`${unapproved.length} unapproved difference(s) inside the window`);
  return {
    pass: reasons.length === 0,
    reasons,
    parityHours,
    continuousHours,
    window,
    totals: { shadowTicks: shadow.length, appliedTicks: applied.length, pairs: pairedShadows.length },
    classes,
    differences,
    unapproved,
    config: { pairWindowMinutes: config.pairWindowMinutes, maxGapMinutes: config.maxGapMinutes, tickMinutes: config.tickMinutes },
  };
}

function renderText(result) {
  const lines = [];
  lines.push(`PARITY: ${result.pass ? 'PASS' : 'FAIL'} (required ${result.parityHours} continuous hours)`);
  lines.push(`continuous hours: ${result.continuousHours}${result.window ? ` (${result.window.start} .. ${result.window.end}, ${result.window.ticks} paired ticks)` : ''}`);
  lines.push(`ticks: shadow ${result.totals.shadowTicks}, applied ${result.totals.appliedTicks}, paired ${result.totals.pairs}`);
  lines.push(`classes: ${Object.entries(result.classes).map(([cls, n]) => `${cls}=${n}`).join(', ')}`);
  for (const reason of result.reasons) lines.push(`reason: ${reason}`);
  const shown = result.differences.filter((diff) => !diff.expected);
  if (shown.length > 0) {
    lines.push('differences (excluding expected-by-construction):');
    for (const diff of shown) {
      const who = diff.name ? ` ${diff.name}${diff.kind ? `:${diff.kind}` : ''}` : '';
      const mark = diff.approved ? ' [approved]' : (diff.inWindow ? ' [UNAPPROVED]' : ' [outside window]');
      lines.push(`  ${diff.at} ${diff.class} ${diff.category}${who}${mark} - ${diff.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, PARITY_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new ParityError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  const result = compareParity({ root: args.root, since: args.since, until: args.until, now: args.now, hours: args.hours, actor: args.actor });
  return { result, json: args.json === 'true' };
}

if (require.main === module) {
  try {
    const { result, json } = cli(process.argv.slice(2));
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : renderText(result));
    process.exitCode = result.pass ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message })}\n`);
    // fleet#4: exit 2 already means "gate FAILED" for this binary (README: "exit 2 on
    // fail"), so a refused (typo'd) invocation must not share it - EX_USAGE (64) keeps
    // a gate failure and a usage error distinguishable by status alone.
    process.exitCode = error.code === 'USAGE' ? 64 : 1;
  }
}

module.exports = { compareParity, renderText, EXPECTED_CLASSES, CATEGORIES, cli, PARITY_FLAGS, ParityError };
