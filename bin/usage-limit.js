'use strict';
// #388 (spec #382, ruling 6): the Usage limit reading. The claude CLI's stream-json output carries
// a rate_limit_event for the account-wide five-hour and weekly windows. bin/usage-probe.ps1 runs one
// cheap call an hour and hands its stream here: parseUsageReading reads the event, probeDue says when
// the next probe is due, and pageDue says whether a weekly window pages Cory (once per window). The
// state lives in state/usage/: latest.json (loadLatestReading, for #389) and readings.jsonl (the
// history the weekly scorecard reads). Everything above the file section is pure.

const fs = require('node:fs');
const path = require('node:path');

const PAGE_AT = 0.8;                       // weekly utilization at or above which Cory is paged
const PAGE_ATTEMPTS = 3;                   // an undelivered page is retried this many times in all, then given up
const PROBE_MIN_AGE_MS = 55 * 60 * 1000;   // the hourly cadence on the 15-minute Watchdog tick

class UsageLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UsageLimitError';
    this.code = code;
  }
}

function usageWindow(value) {
  return Number.isFinite(value?.utilization) && Number.isFinite(value?.resetsAt)
    ? { utilization: value.utilization, resetsAt: value.resetsAt }
    : null;
}

// The last rate_limit_event of a stream-json stream that has both windows numeric: a later event
// missing one window does not hide the complete one before it. Lines that are not JSON (the CLI's
// own warnings, a torn line) are skipped.
function parseUsageReading(text, at) {
  let seen = false;
  let complete = null;
  for (const line of String(text).split(/\r?\n/)) {
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.type !== 'rate_limit_event') continue;
    seen = true;
    const windows = row.rate_limit_info?.unifiedWindows;
    const fiveHour = usageWindow(windows?.five_hour);
    const weekly = usageWindow(windows?.seven_day);
    if (fiveHour && weekly) complete = { fiveHour, weekly, status: row.rate_limit_info.status ?? null };
  }
  if (!seen) throw new UsageLimitError('NO_RATE_LIMIT_EVENT', 'the stream has no rate_limit_event line');
  if (!complete) throw new UsageLimitError('NO_WINDOWS', 'no rate_limit_event has a numeric five_hour and seven_day window');
  return { ...complete, at };
}

// Due with no reading, when the latest is PROBE_MIN_AGE_MS old or more, and when its time cannot be
// read or lies ahead of the clock (a clock set back costs one extra probe, not a stall).
function probeDue(latest, now) {
  if (!latest || !latest.at) return true;
  const age = Date.parse(now) - Date.parse(latest.at);
  return !(age >= 0 && age < PROBE_MIN_AGE_MS);
}

// The page-once decision. A weekly window at or above PAGE_AT pages once: `record` is the last
// window paged (see pageRecordAfter), and its own window pages again only while that page is
// undelivered and under the attempt cap. Any other window pages at once.
function pageDue(reading, record) {
  if (!reading || reading.weekly.utilization < PAGE_AT) return false;
  if (!record || record.weeklyResetsAt !== reading.weekly.resetsAt) return true;
  return !record.delivered && (record.attempts || 0) < PAGE_ATTEMPTS;
}

// The record after one page attempt for the window of `reading`: that window's attempts so far, plus this one.
function pageRecordAfter(record, reading, delivered, at) {
  const sameWindow = Boolean(record) && record.weeklyResetsAt === reading.weekly.resetsAt;
  return { weeklyResetsAt: reading.weekly.resetsAt, delivered: delivered === true, attempts: (sameWindow ? record.attempts || 0 : 0) + 1, at };
}

// #389 (ADR 0018): the weekly hold on a Tenant's new IC launches. At or above `lowerTenantsAt` every
// Tenant but the first in `tenantOrder` is held; at or above `allTenantsAt`, every Tenant. A reading whose
// weekly window has reset is stale and holds nothing, and so does a reading, limit or clock that cannot be
// read: a missing probe must not stop the fleet (fail open).
function usageThrottle({ reading, tenant, limit, now } = {}) {
  const weekly = reading?.weekly;
  const first = Array.isArray(limit?.tenantOrder) ? limit.tenantOrder[0] : undefined;
  if (!weekly || !Number.isFinite(weekly.utilization) || !first) return null;
  const reset = new Date(weekly.resetsAt * 1000);
  if (!(reset.getTime() > new Date(now || Date.now()).getTime())) return null;
  const hold = (threshold, scope) => ({
    code: 'usage-throttle',
    threshold,
    utilization: weekly.utilization,
    resetsAt: weekly.resetsAt,
    reason: `weekly utilization ${weekly.utilization} is at or above the ${Math.round(threshold * 100)}% threshold for ${scope}; new IC launches are held until the weekly reset at ${reset.toISOString()}`,
  });
  if (weekly.utilization >= limit.allTenantsAt) return hold(limit.allTenantsAt, 'every Tenant');
  if (weekly.utilization >= limit.lowerTenantsAt && tenant !== first) return hold(limit.lowerTenantsAt, `every Tenant but ${first}`);
  return null;
}

// File section. A missing or torn file reads as absent, never as a throw.
function usageFile(root, name) { return path.join(root, 'state', 'usage', name); }
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text, 'utf8');
  fs.renameSync(`${file}.tmp`, file); // a reader sees the old file or the new one, never a part
}
function loadLatestReading(root) {
  const reading = readJsonFile(usageFile(root, 'latest.json'));
  return reading && reading.weekly && Number.isFinite(reading.weekly.utilization) ? reading : null;
}
// config/cycle.json `usageLimit` (the Tenant order and the two thresholds), or null: nothing is held without it.
function loadUsageLimit(root) {
  const cycle = readJsonFile(path.join(root, 'config', 'cycle.json'));
  return (cycle && cycle.usageLimit) || null;
}
function loadPageRecord(root) { return readJsonFile(usageFile(root, 'paged.json')); }
// The last probe attempt, successful or not (attempt.json, or the latest reading's time). A failing
// probe waits out the hour like a good one, so it cannot spend the quota it measures on every tick.
function lastProbeAt(root) {
  const times = [loadLatestReading(root), readJsonFile(usageFile(root, 'attempt.json'))].map((record) => record?.at).filter(Boolean);
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}
function storeReading(root, reading) {
  writeFileAtomic(usageFile(root, 'latest.json'), `${JSON.stringify(reading, null, 2)}\n`);
  fs.appendFileSync(usageFile(root, 'readings.jsonl'), `${JSON.stringify(reading)}\n`, 'utf8');
  return reading;
}
function storePageRecord(root, record) {
  writeFileAtomic(usageFile(root, 'paged.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function storeAttempt(root, at) {
  writeFileAtomic(usageFile(root, 'attempt.json'), `${JSON.stringify({ at })}\n`);
  return { at };
}

// The calls the probe makes. Each returns an object, which the CLI prints as its one JSON line:
//   due <root> [now]                       -> { due }                 is a probe due (the last attempt an hour old)?
//   attempt <root> [at]                    -> { at }                  a probe ran and failed
//   record <root> [at]  (stream on stdin)  -> { reading, pageDue }    stores the reading
//   page-attempt <root> <true|false> [at]  -> the page record         after an attempt that reached Pushover
//   throttle <root> <tenant> [now]         -> { throttle }            the weekly hold on a new IC launch, or null (the launch door asks)
function cli(argv, readStdin = () => fs.readFileSync(0, 'utf8')) {
  const [command, root, ...rest] = argv;
  const now = new Date().toISOString();
  if (command === 'due') {
    const last = lastProbeAt(root);
    return { due: probeDue(last ? { at: last } : null, rest[0] || now) };
  }
  if (command === 'attempt') return storeAttempt(root, rest[0] || now);
  if (command === 'record') {
    const reading = storeReading(root, parseUsageReading(readStdin(), rest[0] || now));
    return { reading, pageDue: pageDue(reading, loadPageRecord(root)) };
  }
  if (command === 'page-attempt') {
    const latest = loadLatestReading(root);
    if (!latest) throw new UsageLimitError('NO_READING', 'there is no reading to record a page attempt against');
    return storePageRecord(root, pageRecordAfter(loadPageRecord(root), latest, rest[0] === 'true', rest[1] || now));
  }
  if (command === 'throttle') return { throttle: usageThrottle({ reading: loadLatestReading(root), tenant: rest[0], limit: loadUsageLimit(root), now: rest[1] || now }) };
  throw new UsageLimitError('USAGE', `usage-limit.js: expected due, record, page-attempt or throttle, got ${command || 'nothing'}`);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'ERROR', error: String(error.message || error) })}\n`);
    process.exitCode = 2;
  }
}

module.exports = { PAGE_AT, UsageLimitError, cli, loadLatestReading, loadUsageLimit, pageDue, pageRecordAfter, parseUsageReading, probeDue, usageThrottle };
