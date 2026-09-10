'use strict';
// Ticket 07: structured Frontier exclusions. The store is an append-only JSONL
// ledger per tenant (state/exclusions/<tenant>.jsonl): `exclusion-added` and
// `exclusion-lifted` entries, never rewritten. The projection folds the ledger
// against the Fleet event ledger and a clock, so an exclusion leaves the frontier
// by lift, by expiry, or by a named recheck event without losing its history.
// The legacy prose file (state/skip/<tenant>.json) stays the Stop hook's reader
// during shadow; assignment.js reads both and labels the legacy path.

const fs = require('node:fs');
const path = require('node:path');
const { STATES, WorkStateError, readEvents, parseArgs } = require('./work-state');

// A recheck event of this type is never looked up in the Fleet ledger: it means
// "only the owner's lift releases this exclusion".
const LIFT_ONLY_RECHECK_EVENTS = Object.freeze(['exclusion-lifted']);
// Every event type the ledger can carry for a record; anything else is a typo
// that would make an exclusion undischargeable by accident.
const LEDGER_EVENT_TYPES = Object.freeze([
  ...STATES.map((state) => `state-${state}`),
  'assignment-reserved', 'assignment-released', 'work-created', 'shadow-projected', 'shadow-retiring', 'shadow-retired',
  'pr-observed', 'review-recorded', 'notification-attempted', 'notification-sent', 'notification-failed', 'notification-retry-authorized',
]);
const RECHECK_EVENT_TYPES = Object.freeze([...LIFT_ONLY_RECHECK_EVENTS, ...LEDGER_EVENT_TYPES]);

function ledgerPath(root, tenant) {
  return path.join(path.resolve(root || path.resolve(__dirname, '..')), 'state', 'exclusions', `${tenant}.jsonl`);
}

function readExclusions(root, tenant) {
  const file = ledgerPath(root, tenant);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;   // BOM-tolerant, like assignment.js
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try { entries.push(JSON.parse(lines[index])); } catch {
      // A torn final line (crash mid-append, no newline yet) is skipped like the
      // event ledger does; anything else is corruption and must stop the reader.
      if (index === lines.length - 1 && !text.endsWith('\n')) break;
      throw new WorkStateError('CORRUPT_EXCLUSION_LEDGER', `invalid exclusion JSON in ${file} at line ${index + 1}`);
    }
  }
  return entries;
}

function appendEntry(root, tenant, entry) {
  const file = ledgerPath(root, tenant);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

function isoOrThrow(value, field) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new WorkStateError('EXCLUSION_INVALID', `${field} must be an ISO timestamp`);
  return date.toISOString();
}

function validateRecheck(recheck) {
  if (!recheck || typeof recheck !== 'object') throw new WorkStateError('EXCLUSION_INVALID', 'recheck must name an expiry or an event');
  const hasExpiry = recheck.expiresAt !== undefined;
  const hasEvent = recheck.event !== undefined;
  if (hasExpiry === hasEvent) throw new WorkStateError('EXCLUSION_INVALID', 'recheck must carry exactly one of expiresAt or event');
  if (hasExpiry) return { expiresAt: isoOrThrow(recheck.expiresAt, 'recheck.expiresAt') };
  const event = recheck.event;
  if (!event || typeof event !== 'object' || !event.type || !String(event.type).trim()) {
    throw new WorkStateError('EXCLUSION_INVALID', 'recheck.event must name an event type');
  }
  if (!RECHECK_EVENT_TYPES.includes(String(event.type))) throw new WorkStateError('EXCLUSION_INVALID', `recheck.event.type '${event.type}' is not a Fleet event type`);
  const named = { type: String(event.type) };
  if (event.recordId !== undefined) named.recordId = String(event.recordId);
  if (event.issue !== undefined) {
    if (!Number.isInteger(Number(event.issue)) || Number(event.issue) <= 0) throw new WorkStateError('EXCLUSION_INVALID', 'recheck.event.issue must be a positive integer');
    named.issue = Number(event.issue);
  }
  return { event: named };
}

function requireText(value, field) {
  if (!value || !String(value).trim()) throw new WorkStateError('EXCLUSION_INVALID', `${field} is required`);
  return String(value).trim();
}

// Fold: one state per exclusion id. Discharge precedence follows time - the
// earliest of lift, expiry, or matching event wins, and history stays intact.
function projectExclusions({ entries = [], events = [], now } = {}) {
  const clock = new Date(now || Date.now()).getTime();
  const byId = new Map();
  const lifts = new Map();
  for (const entry of entries) {
    if (entry.kind === 'exclusion-added') byId.set(entry.id, entry);
    else if (entry.kind === 'exclusion-lifted' && !lifts.has(entry.id)) lifts.set(entry.id, entry);
  }
  const active = [];
  const discharged = [];
  for (const entry of byId.values()) {
    const candidates = [];
    const lift = lifts.get(entry.id);
    if (lift) candidates.push({ by: 'lifted', at: lift.at, evidence: lift.evidence || null, actor: lift.actor || null });
    if (entry.recheck.expiresAt && new Date(entry.recheck.expiresAt).getTime() <= clock) {
      candidates.push({ by: 'expired', at: entry.recheck.expiresAt, evidence: null, actor: null });
    }
    if (entry.recheck.event && !LIFT_ONLY_RECHECK_EVENTS.includes(entry.recheck.event.type)) {
      const wanted = entry.recheck.event;
      // An issue number is scoped to the exclusion's own tenant: another tenant's
      // #40 merging must not release this tenant's hold.
      const match = events.find((event) => event.type === wanted.type
        && String(event.at) > String(entry.at)
        && (wanted.recordId === undefined || event.recordId === wanted.recordId)
        && (wanted.issue === undefined || event.recordId === `${entry.tenant}:issue-${wanted.issue}`));
      if (match) candidates.push({ by: `event:${wanted.type}`, at: match.at, evidence: `${match.recordId} seq ${match.sequence}`, actor: match.actor || null });
    }
    candidates.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (candidates.length) {
      const first = candidates[0];
      discharged.push({ ...entry, dischargedBy: first.by, dischargedAt: first.at, dischargeEvidence: first.evidence, dischargedActor: first.actor });
    } else active.push(entry);
  }
  const order = (a, b) => a.issue - b.issue || String(a.id).localeCompare(String(b.id));
  active.sort(order);
  discharged.sort(order);
  return { active, discharged };
}

function projectTenant({ root, tenant, now } = {}) {
  return projectExclusions({ entries: readExclusions(root, tenant), events: readEvents(root), now });
}

function activeExclusions(options = {}) {
  return projectTenant(options).active;
}

function addExclusion({ root, tenant, issue, reason, evidence, owner, recheck, actor, now, id } = {}) {
  if (!tenant || !String(tenant).trim()) throw new WorkStateError('EXCLUSION_INVALID', 'tenant is required');
  if (!Number.isInteger(Number(issue)) || Number(issue) <= 0) throw new WorkStateError('EXCLUSION_INVALID', 'issue must be a positive integer');
  const entry = {
    schemaVersion: 1,
    kind: 'exclusion-added',
    id: null,
    tenant: String(tenant),
    issue: Number(issue),
    reason: requireText(reason, 'reason'),
    evidence: requireText(evidence, 'evidence'),
    owner: requireText(owner, 'owner'),
    recheck: validateRecheck(recheck),
    actor: actor || 'unknown',
    at: isoOrThrow(now || new Date().toISOString(), 'now'),
  };
  const entries = readExclusions(root, tenant);
  const projection = projectExclusions({ entries, events: readEvents(root), now: entry.at });
  const standing = projection.active.find((existing) => existing.issue === entry.issue);
  if (standing) throw new WorkStateError('EXCLUSION_EXISTS', `issue #${entry.issue} already carries active exclusion ${standing.id}`, { id: standing.id });
  const priorCount = entries.filter((existing) => existing.kind === 'exclusion-added' && existing.issue === entry.issue).length;
  entry.id = id ? String(id) : `${tenant}:excl-${entry.issue}-${priorCount + 1}`;
  if (entries.some((existing) => existing.id === entry.id)) throw new WorkStateError('EXCLUSION_EXISTS', `exclusion id ${entry.id} already exists`);
  return appendEntry(root, tenant, entry);
}

function liftExclusion({ root, tenant, id, actor, evidence, now } = {}) {
  const entries = readExclusions(root, tenant);
  if (!entries.some((entry) => entry.kind === 'exclusion-added' && entry.id === id)) throw new WorkStateError('EXCLUSION_NOT_FOUND', `exclusion ${id} was not found`);
  const at = isoOrThrow(now || new Date().toISOString(), 'now');
  const projection = projectExclusions({ entries, events: readEvents(root), now: at });
  if (!projection.active.some((entry) => entry.id === id)) throw new WorkStateError('EXCLUSION_NOT_ACTIVE', `exclusion ${id} is not active`);
  return appendEntry(root, tenant, {
    schemaVersion: 1, kind: 'exclusion-lifted', id: String(id), tenant: String(tenant),
    actor: actor || 'unknown', evidence: requireText(evidence, 'evidence'), at,
  });
}

// The flags each command accepts, declared per command (fleet#4, following
// review-policy.js's CLASSIFY_FLAGS / fleet#2): before this, a typo'd flag
// (`--recheck-envent`, `--reasan`, ...) fell into a bucket nothing read and
// the command carried on as if it had not been given - `add` would silently
// drop the recheck (or the reason/evidence/owner) and either refuse for a
// different reason than the one typed, or in the worst case still write an
// exclusion the caller did not mean to write. Now an unknown flag is a USAGE
// error naming the flag and the accepted set, before any command runs.
const EXCLUSIONS_FLAGS = Object.freeze({
  add: ['root', 'tenant', 'issue', 'reason', 'evidence', 'owner', 'expires', 'recheck-event', 'recheck-record', 'recheck-issue', 'actor', 'now', 'id'],
  lift: ['root', 'tenant', 'id', 'actor', 'evidence', 'now'],
  project: ['root', 'tenant', 'now'],
});

const EXCLUSIONS_USAGE = 'commands: add (--issue --reason --evidence --owner and --expires <iso> | --recheck-event <type> [--recheck-record id | --recheck-issue n]), lift (--id --evidence), project';

function cli(argv) {
  const [command, ...rest] = argv;
  const flags = EXCLUSIONS_FLAGS[command];
  if (!flags) throw new WorkStateError('USAGE', EXCLUSIONS_USAGE);
  const args = parseArgs(rest, flags);
  const tenant = args.tenant || 'endzone';
  if (command === 'add') {
    const recheck = args.expires ? { expiresAt: args.expires }
      : args['recheck-event'] ? { event: { type: args['recheck-event'], ...(args['recheck-record'] ? { recordId: args['recheck-record'] } : {}), ...(args['recheck-issue'] ? { issue: Number(args['recheck-issue']) } : {}) } }
        : undefined;
    return addExclusion({ root: args.root, tenant, issue: Number(args.issue), reason: args.reason, evidence: args.evidence, owner: args.owner, recheck, actor: args.actor, now: args.now, id: args.id });
  }
  if (command === 'lift') return liftExclusion({ root: args.root, tenant, id: args.id, actor: args.actor, evidence: args.evidence, now: args.now });
  return projectTenant({ root: args.root, tenant, now: args.now });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message })}\n`);
    // A refused invocation exits 2 so a caller reading only the status cannot
    // take it for a failed one, let alone for an answer (fleet#2/fleet#4).
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = {
  EXCLUSIONS_FLAGS,
  LIFT_ONLY_RECHECK_EVENTS,
  RECHECK_EVENT_TYPES,
  activeExclusions,
  addExclusion,
  cli,
  ledgerPath,
  liftExclusion,
  parseArgs,
  projectExclusions,
  projectTenant,
  readExclusions,
};
