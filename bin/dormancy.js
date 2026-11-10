'use strict';
// Ticket 386: is a Tenant dormant (CONTEXT.md)? One pure evaluation over eight facts, a gather that reads the existing
// frontiers, open fleet PRs, Work records and wake outbox, and a snapshot the watchdog writes once per tick. Rotation
// (rotation-policy.js) and the Sentinel's respawn (sentinel-check.ps1) read the snapshot and never evaluate it.
// Scripts only, no model turns (ADR 0004).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SNAPSHOT = path.join('state', 'watchdog', 'dormancy.json');
const FLAG = path.join('state', 'flags', 'dormancy-off');
// A verdict is good for one 15-minute tick plus margin: an older one is no verdict, so it can never hold a session down
// or let one stay down.
const VALIDITY_MINUTES = 25;
// The gh pr list page size. A full page with no fleet PR in it proves nothing about the rest of the list.
const PR_LIST_LIMIT = 100;
// A Work record in one of these states is finished or waits on Cory's own decision, so it is not work for a role.
const NOT_IN_FLIGHT = ['merged', 'retiring', 'retired', 'released', 'abandoned', 'hold', 'escalated'];
// The wake kinds the lead's wake reads from the outbox (bin/watchdog.ps1, Get-UnconsumedWakes).
const WAKE_KINDS = ['checks-settled', 'checks-failed', 'decision-needed', 'resolution'];
const CONDITIONS = [
  ['frontier', 'ready Unit(s) on the Frontier'],
  ['legacyHolds', 'ready Unit(s) held by a skip-file entry with no exclusion'],
  ['triage', 'item(s) awaiting Triage'],
  ['verdicts', 'Triage proposal(s) awaiting a Verdict'],
  ['openPrs', 'open fleet pull request(s)'],
  ['escalations', 'pending Escalation(s)'],
  ['inFlight', 'Work record(s) in flight'],
  ['wakes', 'unconsumed wake line(s) for the lead'],
];

// The one evaluation. A fact that is null or missing is unreadable, and unreadable keeps the tenant awake.
function evaluateDormancy(facts = {}, errors = {}) {
  const reasons = [];
  for (const [key, label] of CONDITIONS) {
    const count = facts[key];
    if (!Number.isFinite(count)) reasons.push(`${label} unreadable${errors[key] ? `: ${errors[key]}` : ''}`);
    else if (count > 0) reasons.push(`${count} ${label}`);
  }
  return { dormant: reasons.length === 0, reasons };
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function errorText(error) {
  return String(error && error.message ? error.message : error).split('\n')[0].slice(0, 200);
}

// active.json, read once: its records object, or null when the file is absent. A file that parses without a records
// object is malformed and throws, so it reads as unreadable and never as an empty fleet.
function readActiveRecords(root) {
  const file = path.join(root, 'state', 'work', 'active.json');
  if (!fs.existsSync(file)) return null;
  const active = readJson(file);
  const records = active && typeof active === 'object' && !Array.isArray(active) ? active.records : null;
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('active.json has no records object');
  return records;
}

// The Work records a Tenant's facts count. A record with no tenant counts for every Tenant: when in doubt, awake.
function tenantRecords(records, tenant) {
  return Object.values(records || {}).filter((record) => record && (!record.tenant || String(record.tenant) === String(tenant)));
}

// The consumed watermark of one Tenant, from the frontier wake's state. A missing one is unknown, and unknown reads awake.
function consumedThrough(root, tenant) {
  const file = path.join(root, 'state', 'watchdog', 'frontier-wake.json');
  const state = fs.existsSync(file) ? readJson(file) : null;
  const mark = state && state.tenants && state.tenants[tenant] ? state.tenants[tenant].outboxConsumedThrough : null;
  const at = mark ? Date.parse(mark) : NaN;
  if (!Number.isFinite(at)) throw new Error('no consumed watermark for this tenant');
  return at;
}

// The unconsumed wake lines for one Tenant, counted the way Test-WorkWaiting counts them (bin/watchdog.ps1, Get-UnconsumedWakes,
// the lead as recipient): past the watermark, one of the four wake kinds, and still standing. A line the fleet does not treat as
// the lead's work is not counted here either. Without that, a line for a merged unit would keep its Tenant awake for good, since
// the watermark only moves when a wake is delivered.
function unconsumedWakes(root, tenant, records, watermark) {
  const file = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  if (!fs.existsSync(file)) return 0;
  let count = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }   // a torn trailing line is not yet a wake
    if (!entry || !entry.at || !String(entry.recordId || '').startsWith(`${tenant}:`)) continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || at <= watermark) continue;
    if (!WAKE_KINDS.includes(String(entry.wake))) continue;
    // A resolution of an escalation the Principal raised, or one into ci-wait, is not the lead's.
    if (entry.wake === 'resolution' && (String(entry.raisedBy || '').startsWith('pe-') || entry.to === 'ci-wait')) continue;
    // The lead's own decision-needed and resolution lines are Cory's to act on, not a wake for the lead.
    if ((entry.wake === 'decision-needed' || entry.wake === 'resolution') && entry.actor === `pl-${tenant}`) continue;
    // checks-* lines count only while their record is still in active.json, and checks-settled only while it is in review.
    if (records && String(entry.wake).startsWith('checks-')) {
      const record = Object.prototype.hasOwnProperty.call(records, entry.recordId) ? records[entry.recordId] : null;
      if (!record || (entry.wake === 'checks-settled' && record.state !== 'review')) continue;
    }
    count += 1;
  }
  return count;
}

// The facts for one Tenant, each read through the module that already decides it: the planner's Frontier (bin/assignment.js),
// the Principal's and the Arbiter's triage frontiers (bin/triage.js), the open PRs the Stop hook lists, active.json, and the
// wake outbox past the frontier wake's watermark. A fact that cannot be read is null with its error; nothing is guessed.
function gatherTenantFacts({ root, tenant, now, runner = execFileSync } = {}) {
  const base = path.resolve(root);
  const facts = {};
  const errors = {};
  const read = (key, compute) => {
    try { facts[key] = compute(); } catch (error) { facts[key] = null; errors[key] = errorText(error); }
  };
  // No readable tenant file means no repo to ask: every fact is unreadable, so the Tenant stays awake.
  let config = null;
  try { config = readJson(path.join(base, 'tenants', `${tenant}.json`)); } catch (error) {
    for (const [key] of CONDITIONS) { facts[key] = null; errors[key] = `tenant file unreadable: ${errorText(error)}`; }
    return { facts, errors };
  }
  const fixture = (name) => process.env[name] || undefined;
  // The planner is asked once; its failure is the failure of both facts read from its answer.
  let frontier = null;
  let frontierError = null;
  try {
    const argv = ['frontier', '--root', base, '--tenant', tenant];
    if (fixture('FLEET_GITHUB_ISSUES_FIXTURE')) argv.push('--fixture', fixture('FLEET_GITHUB_ISSUES_FIXTURE'));
    frontier = require('./assignment').cli(argv);
  } catch (error) { frontierError = errorText(error); }
  const needFrontier = () => { if (frontierError) throw new Error(frontierError); return frontier; };
  read('frontier', () => needFrontier().eligible.length);
  // fleet #406: a ready ticket behind a skip-file hold that nothing can release keeps the Tenant awake, so its lead is woken to deal with it.
  read('legacyHolds', () => (needFrontier().warnings || []).filter((warning) => warning.code === 'legacy-hold-unstructured' && warning.ready).length);
  read('triage', () => require('./triage').computeFrontier({ root: base, tenant, now, fixture: fixture('FLEET_TRIAGE_ISSUES_FIXTURE') }).eligible.length);
  read('verdicts', () => {
    const arbiter = require('./triage').computeArbiterFrontier({ root: base, tenant, now, fixture: fixture('FLEET_TRIAGE_ISSUES_FIXTURE') });
    // Paused or suspended, the Arbiter's frontier is empty by definition, not because nothing awaits a Verdict.
    if (arbiter.paused || arbiter.suspended) throw new Error(arbiter.reason || 'the Arbiter is paused or suspended');
    return arbiter.eligible.length;
  });
  read('openPrs', () => {
    // The fixture is the same seam the planner and triage use; a .cmd gh mock cannot run under execFileSync, so tests need it.
    const listed = fixture('FLEET_GITHUB_PRS_FIXTURE') ? readJson(fixture('FLEET_GITHUB_PRS_FIXTURE')) : JSON.parse(String(runner('gh',
      ['pr', 'list', '-R', String(config.github), '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'number,isDraft,headRefName'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 })));
    const prefix = config.branchPrefix || 'fleet/';
    const fleet = listed.filter((pr) => String(pr.headRefName || '').startsWith(prefix)).length;
    if (fleet === 0 && listed.length >= PR_LIST_LIMIT) throw new Error('gh pr list hit its limit; cannot prove no fleet PR');
    return fleet;
  });
  // active.json is read once for the Work-record facts; its failure is each of their failures.
  let records = null;
  let recordsError = null;
  try { records = readActiveRecords(base); } catch (error) { recordsError = errorText(error); }
  const needRecords = () => { if (recordsError) throw new Error(recordsError); return records; };
  read('escalations', () => tenantRecords(needRecords(), tenant).filter((record) => record.state === 'escalated').length);
  read('inFlight', () => tenantRecords(needRecords(), tenant).filter((record) => !NOT_IN_FLIGHT.includes(String(record.state))).length);
  read('wakes', () => unconsumedWakes(base, tenant, needRecords(), consumedThrough(base, tenant)));
  return { facts, errors };
}

function listTenants(root) {
  const dir = path.join(root, 'tenants');
  if (!fs.existsSync(dir)) return [];
  // An unreadable tenant file keeps its name and reads as awake through its own failed facts, never as a crash for the rest.
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => {
    let config = null;
    try { config = readJson(path.join(dir, name)); } catch { config = null; }
    return String((config && config.name) || path.basename(name, '.json'));
  }).sort();
}

// One verdict per Tenant, stamped and written in one piece (a torn write is never read as a verdict).
function writeSnapshot({ root, now, gather = gatherTenantFacts } = {}) {
  const base = path.resolve(root);
  const at = new Date(now || Date.now());
  const tenants = {};
  for (const tenant of listTenants(base)) {
    const { facts, errors } = gather({ root: base, tenant, now: at.toISOString() });
    const verdict = evaluateDormancy(facts, errors);
    tenants[tenant] = { dormant: verdict.dormant, reasons: verdict.reasons, facts };
  }
  const snapshot = {
    schemaVersion: 1,
    at: at.toISOString(),
    validUntil: new Date(at.getTime() + VALIDITY_MINUTES * 60000).toISOString(),
    tenants,
  };
  const file = path.join(base, SNAPSHOT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return snapshot;
}

// The Tenants a fresh verdict calls dormant. Nothing when the dormancy-off flag stands, or when the verdict is missing,
// unreadable or past its window: each of those keeps every session as it was.
function dormantTenants({ root, now } = {}) {
  const base = path.resolve(root);
  if (fs.existsSync(path.join(base, FLAG))) return [];
  let snapshot = null;
  try { snapshot = readJson(path.join(base, SNAPSHOT)); } catch { return []; }
  const at = now ? new Date(now) : new Date();
  if (!snapshot || !(new Date(snapshot.validUntil) > at)) return [];
  return Object.entries(snapshot.tenants || {}).filter(([, verdict]) => verdict && verdict.dormant === true).map(([name]) => name);
}

const FLAGS = { snapshot: ['root', 'now'] };

async function cli(argv) {
  const [command, ...rest] = argv;
  const workState = require('./work-state');
  if (!Object.prototype.hasOwnProperty.call(FLAGS, command)) {
    throw new workState.WorkStateError('USAGE', `unknown command '${command}'; commands: ${Object.keys(FLAGS).join(', ')}`);
  }
  const args = workState.parseArgs(rest, FLAGS[command]);
  return writeSnapshot({ root: args.root, now: args.now });
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ code: error.code || null, error: String(error.message || error) })}\n`);
      process.exitCode = error.code === 'USAGE' ? 2 : 1;
    });
}

module.exports = { evaluateDormancy, gatherTenantFacts, writeSnapshot, dormantTenants, cli };
