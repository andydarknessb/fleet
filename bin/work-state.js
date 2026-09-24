'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STATES = Object.freeze([
  'assigned', 'implementing', 'pr-open', 'ci-wait', 'review', 'revision',
  'hold', 'merged', 'retiring', 'retired', 'released', 'abandoned', 'escalated',
]);

const TRANSITIONS = Object.freeze({
  assigned: ['implementing', 'escalated'],
  implementing: ['pr-open', 'escalated'],
  'pr-open': ['ci-wait', 'review', 'escalated'],
  'ci-wait': ['review', 'revision', 'escalated'],
  review: ['revision', 'hold', 'merged', 'escalated'],
  revision: ['implementing', 'pr-open', 'escalated'],
  hold: ['merged', 'escalated'],
  merged: ['retiring', 'escalated'],
  retiring: ['retired', 'escalated'],
  escalated: STATES.filter((state) => !['escalated', 'abandoned'].includes(state)),
  retired: [],
  released: [],
  abandoned: [],
});

// Ticket 07: the events that mean "a human decision is needed". escalated is the
// spec's decision state; hold is a reviewed PR parked for Cory's merge, which the
// spec says pages once.
const DECISION_EVENT_TYPES = Object.freeze(['state-escalated', 'state-hold']);
const DECISION_STATES = Object.freeze(DECISION_EVENT_TYPES.map((type) => type.slice('state-'.length)));
const NOTIFICATION_PHASES = Object.freeze(['claim', 'sent', 'failed', 'authorize-retry']);

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const LOCK_WAIT_MS = 10;
const LOCK_STALE_MS = 60 * 1000;

class WorkStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkStateError';
    this.code = code;
    Object.assign(this, details);
  }
}

function isoNow(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new WorkStateError('INVALID_TIME', `invalid timestamp: ${value}`);
  return date.toISOString();
}

function asRoot(root) {
  return path.resolve(root || DEFAULT_ROOT);
}

function paths(root) {
  const base = asRoot(root);
  return {
    base,
    state: path.join(base, 'state'),
    work: path.join(base, 'state', 'work'),
    active: path.join(base, 'state', 'work', 'active.json'),
    pending: path.join(base, 'state', 'work', 'pending'),
    lock: path.join(base, 'state', 'work', '.lock'),
    events: path.join(base, 'state', 'events'),
    archive: path.join(base, 'state', 'archive'),
    releases: path.join(base, 'state', 'releases'),
    abandons: path.join(base, 'state', 'abandons'),
    status: path.join(base, 'state', 'status'),
  };
}

function ensureLayout(root) {
  const p = paths(root);
  for (const directory of [p.state, p.work, p.pending, p.events, p.archive, p.releases, p.abandons, p.status]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  if (!fs.existsSync(p.active)) writeAtomicJson(p.active, { schemaVersion: 1, records: {} });
  return p;
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeAtomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function writeAtomicText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, 'utf8');
  fs.renameSync(temporary, file);
}

function sleepBriefly() {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, LOCK_WAIT_MS);
}

function withLock(root, callback) {
  const p = ensureLayout(root);
  let handle;
  for (;;) {
    try {
      handle = fs.openSync(p.lock, 'wx');
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(p.lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          const owner = readJson(p.lock, {});
          let alive = true;
          try { process.kill(Number(owner.pid), 0); } catch { alive = false; }
          if (!owner.pid || !alive) fs.rmSync(p.lock, { force: true });
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      sleepBriefly();
    }
  }
  try {
    recoverPendingUnlocked(p);
    archiveExpiredEvents(p, new Date().toISOString());
    return callback(p);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(p.lock, { force: true });
  }
}

function activeState(p) {
  return readJson(p.active, { schemaVersion: 1, records: {} });
}

function saveActive(p, state) {
  writeAtomicJson(p.active, state);
}

function eventFile(p, timestamp) {
  return path.join(p.events, `${String(timestamp).slice(0, 10)}.jsonl`);
}

function eventLines(p) {
  if (!fs.existsSync(p.events)) return [];
  const files = [];
  for (const directory of [p.events, path.join(p.events, 'archive')]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter((entry) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))) {
      files.push(path.join(directory, name));
    }
  }
  files.sort();
  const events = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      try {
        events.push(JSON.parse(lines[index]));
      } catch {
        if (index !== lines.length - 1 || text.endsWith('\n')) throw new WorkStateError('CORRUPT_EVENT_LOG', `invalid event JSON in ${file}`);
        const lastNewline = text.lastIndexOf('\n');
        fs.writeFileSync(file, text.slice(0, lastNewline + 1), 'utf8');
        break;
      }
    }
  }
  return events;
}

// Ticket 09: archival runs only after the ledger has been verified whole (bin/verify-events.js
// writes state/verify/last.json). No verdict, a failing verdict, or a verdict older than
// the newest event file all mean "leave the online ledger alone": moving a file the
// verifier has not blessed is how a gap becomes permanent.
function archivalPermitted(p, now) {
  let verdict;
  try { verdict = JSON.parse(fs.readFileSync(path.join(p.state, 'verify', 'last.json'), 'utf8')); } catch { return false; }
  if (!verdict || verdict.pass !== true) return false;
  const verdictMs = Date.parse(verdict.at);
  if (Number.isNaN(verdictMs)) return false;
  // The verdict must post-date the newest WRITE to the online ledger, not the newest
  // file's date: a verdict at 00:05 must not bless a whole day of later events.
  let newestWriteMs = 0;
  for (const name of fs.readdirSync(p.events).filter((entry) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))) {
    try { newestWriteMs = Math.max(newestWriteMs, fs.statSync(path.join(p.events, name)).mtimeMs); } catch { return false; }
  }
  return verdictMs >= newestWriteMs;
}

function archiveExpiredEvents(p, now) {
  const cutoff = new Date(isoNow(now)).getTime() - 30 * 24 * 60 * 60 * 1000;
  const archiveDir = path.join(p.events, 'archive');
  if (!archivalPermitted(p, now)) return;
  for (const file of fs.readdirSync(p.events).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))) {
    const date = new Date(`${file.slice(0, 10)}T23:59:59.999Z`).getTime();
    if (date >= cutoff) continue;
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(path.join(p.events, file), path.join(archiveDir, file));
  }
}

function hasEvent(p, recordId, sequence, idempotencyKey) {
  return eventLines(p).some((event) => event.recordId === recordId
    && (event.sequence === sequence || (idempotencyKey && event.idempotencyKey === idempotencyKey)));
}

function appendEvent(p, event) {
  if (hasEvent(p, event.recordId, event.sequence, event.idempotencyKey)) return;
  fs.mkdirSync(path.dirname(eventFile(p, event.at)), { recursive: true });
  fs.appendFileSync(eventFile(p, event.at), `${JSON.stringify(event)}\n`, 'utf8');
}

function pendingFile(p, recordId, idempotencyKey) {
  const safe = `${recordId}-${idempotencyKey}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(p.pending, `${safe}.json`);
}

function archiveFile(p, recordId) {
  const safe = String(recordId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(p.archive, `work-${safe}.json`);
}

function releaseFile(p, recordId) {
  const safe = String(recordId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(p.releases, `work-${safe}.json`);
}

function releaseHistoryFile(p, record) {
  const safe = String(record.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(p.releases, 'history', `work-${safe}-through-${record.eventSequence}.json`);
}

function abandonFile(p, recordId) {
  const safe = String(recordId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(p.abandons, `work-${safe}.json`);
}

function abandonHistoryFile(p, record) {
  const safe = String(record.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(p.abandons, 'history', `work-${safe}-through-${record.eventSequence}.json`);
}

function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function cleanupEphemeral(p, record) {
  const allowed = [path.join(p.state, 'sessions'), path.join(p.state, 'tmp')];
  for (const candidate of [record.settingsPath, record.briefPath]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (allowed.some((directory) => isWithin(resolved, directory)) && fs.existsSync(resolved)) fs.rmSync(resolved, { force: true });
  }
}

function recordEventFiles(p, record) {
  const events = eventLines(p).filter((event) => event.recordId === record.id);
  return [...new Set(events.flatMap((event) => {
    const name = `${String(event.at).slice(0, 10)}.jsonl`;
    const online = eventFile(p, event.at);
    const archived = path.join(p.events, 'archive', name);
    return [path.relative(p.base, online), path.relative(p.base, archived)];
  }))];
}

function archiveRecord(p, record) {
  writeAtomicJson(archiveFile(p, record.id), {
    schemaVersion: 1,
    archivedAt: record.updatedAt,
    record,
    eventFiles: recordEventFiles(p, record),
  });
  cleanupEphemeral(p, record);
}

function storeReleasedRecord(p, record) {
  writeAtomicJson(releaseFile(p, record.id), {
    schemaVersion: 1,
    releasedAt: record.updatedAt,
    record,
    eventFiles: recordEventFiles(p, record),
  });
  cleanupEphemeral(p, record);
}

function storeAbandonedRecord(p, record) {
  writeAtomicJson(abandonFile(p, record.id), {
    schemaVersion: 1,
    abandonedAt: record.updatedAt,
    record,
    eventFiles: recordEventFiles(p, record),
  });
  cleanupEphemeral(p, record);
}

function preserveReusableSnapshot(p, reusable) {
  if (!reusable) return;
  const source = reusable.kind === 'legacy-archive'
    ? archiveFile(p, reusable.record.id)
    : reusable.kind === 'abandonment' ? abandonFile(p, reusable.record.id) : releaseFile(p, reusable.record.id);
  const destination = reusable.kind === 'abandonment'
    ? abandonHistoryFile(p, reusable.record)
    : releaseHistoryFile(p, reusable.record);
  const missingCode = reusable.kind === 'abandonment' ? 'ABANDON_SNAPSHOT_MISSING' : 'RELEASE_SNAPSHOT_MISSING';
  const historyCode = reusable.kind === 'abandonment' ? 'ABANDON_HISTORY_EXISTS' : 'RELEASE_HISTORY_EXISTS';
  if (!fs.existsSync(source)) {
    if (fs.existsSync(destination)) return;
    throw new WorkStateError(missingCode, `reusable ${reusable.kind} snapshot for '${reusable.record.id}' disappeared`);
  }
  if (fs.existsSync(destination)) throw new WorkStateError(historyCode, `reusable ${reusable.kind} history already exists for '${reusable.record.id}' sequence ${reusable.record.eventSequence}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

function untouchedReservation(record, events, { legacy = false } = {}) {
  if (!record || !['released', ...(legacy ? ['retired'] : [])].includes(record.state)) return false;
  if (legacy && Number(record.eventSequence) > 2) return false;
  if (Number(record.budget?.cumulativeTokens || 0) !== 0 || record.budget?.extension) return false;
  if (record.github?.prNumber || record.github?.prUrl || record.github?.headSha) return false;
  if (record.review?.progress && record.review.progress !== 'not-started') return false;
  const lineage = events.filter((event) => event.recordId === record.id).sort((a, b) => a.sequence - b.sequence);
  if (lineage.length !== Number(record.eventSequence) || lineage.length < 2) return false;
  if (lineage.some((event) => !['assignment-reserved', 'assignment-released'].includes(event.type))) return false;
  return lineage[lineage.length - 1].type === 'assignment-released';
}

function reusableReleasedRecord(p, recordId) {
  const events = eventLines(p);
  const released = readJson(releaseFile(p, recordId));
  if (released?.record && untouchedReservation(released.record, events)) return { kind: 'release', record: released.record };
  const archived = readJson(archiveFile(p, recordId));
  if (archived?.record && untouchedReservation(archived.record, events, { legacy: true })) return { kind: 'legacy-archive', record: archived.record };
  return null;
}

function reusableAbandonedRecord(p, recordId) {
  const events = eventLines(p);
  const abandoned = readJson(abandonFile(p, recordId));
  const record = abandoned?.record;
  if (!record || record.state !== 'abandoned' || !record.abandonment?.reason) return null;
  const lineage = events.filter((event) => event.recordId === record.id).sort((a, b) => a.sequence - b.sequence);
  const last = lineage[lineage.length - 1];
  if (lineage.length !== Number(record.eventSequence)
    || last?.type !== 'assignment-abandoned'
    || Number(last.sequence) !== Number(record.eventSequence)
    || last.changes?.to !== 'abandoned') return null;
  return { kind: 'abandonment', record };
}

function reusableWorkRecord(p, recordId) {
  return reusableReleasedRecord(p, recordId) || reusableAbandonedRecord(p, recordId);
}

function recoverPendingUnlocked(p) {
  const files = fs.readdirSync(p.pending).filter((name) => name.endsWith('.json')).sort();
  for (const file of files) {
    const journalPath = path.join(p.pending, file);
    const journal = readJson(journalPath);
    if (!journal) continue;
    const active = activeState(p);
    const existing = active.records[journal.recordId];
    if (journal.afterRecord === null) {
      const current = active.records[journal.recordId];
      if (current && current.revision <= journal.event.revision) delete active.records[journal.recordId];
    }
    else if (!existing || existing.revision < journal.afterRecord.revision) active.records[journal.recordId] = journal.afterRecord;
    saveActive(p, active);
    appendEvent(p, journal.event);
    if (journal.supersedeReusable) preserveReusableSnapshot(p, journal.supersedeReusable);
    if (journal.releasedRecord) storeReleasedRecord(p, journal.releasedRecord);
    if (journal.abandonedRecord) storeAbandonedRecord(p, journal.abandonedRecord);
    if (journal.archiveRecord) archiveRecord(p, journal.archiveRecord);
    fs.rmSync(journalPath, { force: true });
  }
}

function commitMutation(p, { recordId, beforeRecord, afterRecord, event, archiveRecord: recordToArchive = null, releasedRecord = null, abandonedRecord = null, supersedeReusable = null, killPoint }) {
  const journalPath = pendingFile(p, recordId, event.idempotencyKey);
  writeAtomicJson(journalPath, { recordId, beforeRecord, afterRecord, event, archiveRecord: recordToArchive, releasedRecord, abandonedRecord, supersedeReusable });
  if (killPoint === 'after-journal') throw new WorkStateError('KILL_POINT', 'stopped after journal write');
  const active = activeState(p);
  if (afterRecord === null) delete active.records[recordId];
  else active.records[recordId] = afterRecord;
  saveActive(p, active);
  if (killPoint === 'after-record') throw new WorkStateError('KILL_POINT', 'stopped after record replacement');
  appendEvent(p, event);
  if (killPoint === 'after-event') throw new WorkStateError('KILL_POINT', 'stopped after event append');
  if (supersedeReusable) preserveReusableSnapshot(p, supersedeReusable);
  if (releasedRecord) storeReleasedRecord(p, releasedRecord);
  if (abandonedRecord) storeAbandonedRecord(p, abandonedRecord);
  if (recordToArchive) archiveRecord(p, recordToArchive);
  fs.rmSync(journalPath, { force: true });
  return afterRecord || releasedRecord || abandonedRecord || recordToArchive;
}

function requireIdempotency(value) {
  if (!value || !String(value).trim()) throw new WorkStateError('MISSING_IDEMPOTENCY_KEY', 'idempotency key is required');
  return String(value);
}

function eventFor(record, { type, actor, at, idempotencyKey, evidence, changes }) {
  return {
    schemaVersion: 1,
    recordId: record.id,
    sequence: record.eventSequence,
    revision: record.revision,
    type,
    actor: actor || 'unknown',
    at,
    evidence: evidence || null,
    idempotencyKey,
    changes: changes || {},
  };
}

function replayIfKnown(record, key) {
  const prior = record.idempotency?.[key];
  if (!prior) return null;
  return { replayed: true, revision: prior.revision, eventSequence: prior.eventSequence, record };
}

function sanitizeGithub(github, issue) {
  const source = github || {};
  const allowed = ['issueNumber', 'prNumber', 'issueUrl', 'prUrl', 'baseSha', 'bodyHash', 'criteriaHash', 'commentCount', 'headSha', 'lastObservedState', 'mergedAt', 'evidence'];
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]).concat(source.issueNumber === undefined ? [['issueNumber', Number(issue)]] : []));
}

function baseRecord({ id, tenant, issue, owner, state, github, reservations, evidence, settingsPath, briefPath, manifestPath, assignment, now }) {
  if (!id || !tenant || !Number.isInteger(Number(issue)) || Number(issue) <= 0) {
    throw new WorkStateError('INVALID_RECORD', 'id, tenant, and positive issue are required');
  }
  if (!STATES.includes(state)) throw new WorkStateError('INVALID_STATE', `unknown state '${state}'`);
  if (!['assigned', 'implementing', 'retiring'].includes(state)) throw new WorkStateError('INVALID_STATE', 'new records must start assigned, implementing, or retiring');
  return {
    schemaVersion: 1,
    id: String(id),
    tenant: String(tenant),
    issue: Number(issue),
    state,
    revision: 1,
    eventSequence: 1,
    owner: owner || null,
    github: sanitizeGithub(github, issue),
    reservations: {
      components: [], migrationPrefixes: [], schemaAreas: [], testResources: [],
      ...(reservations || {}),
    },
    budget: { cumulativeTokens: 0, extension: null },
    review: { progress: 'not-started' },
    evidence: evidence || null,
    settingsPath: settingsPath || null,
    briefPath: briefPath || null,
    manifestPath: manifestPath || null,
    assignment: assignment || null,
    createdAt: now,
    updatedAt: now,
    idempotency: {},
  };
}

const RESERVATION_FIELDS = Object.freeze(['components', 'migrationPrefixes', 'schemaAreas', 'testResources']);

function hasReservationEvidence(reservations) {
  return RESERVATION_FIELDS.some((field) => (reservations?.[field] || []).length > 0);
}

function reservationPathRoot(value) {
  let normalized = String(value).trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
  const wildcard = normalized.search(/[?*\[\]{}]/);
  if (wildcard >= 0) normalized = normalized.slice(0, wildcard);
  normalized = path.posix.normalize(normalized).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

// The two fields whose values are repository paths. A directory reserved in
// either claims every path beneath it in both (fleet #60): `components:
// src/widgets/x/` and `testResources: src/widgets/x/ui/X.test.jsx` are the
// same files in git, whichever field each unit derived them into.
const PATH_RESERVATION_FIELDS = Object.freeze(['components', 'testResources']);

function reservationValuesOverlap(field, left, right) {
  if (!PATH_RESERVATION_FIELDS.includes(field)) return String(left) === String(right);
  const leftPath = reservationPathRoot(left);
  const rightPath = reservationPathRoot(right);
  if (!leftPath || !rightPath) return true;
  return leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`);
}

// Which fields a value reserved under `field` is compared against: a path
// field against both path fields, any other field against itself only.
function comparableReservationFields(field) {
  return PATH_RESERVATION_FIELDS.includes(field) ? [...PATH_RESERVATION_FIELDS] : [field];
}

// Every overlapping pair between two reservation sets, in field order. The
// single authority the record reservation, the proof and the frontier read.
function reservationOverlaps(leftReservations, rightReservations) {
  const overlaps = [];
  for (const leftField of RESERVATION_FIELDS) {
    const leftValues = (leftReservations?.[leftField] || []).map(String);
    if (!leftValues.length) continue;
    for (const rightField of comparableReservationFields(leftField)) {
      const rightValues = (rightReservations?.[rightField] || []).map(String);
      for (const leftValue of leftValues) {
        for (const rightValue of rightValues) {
          if (reservationValuesOverlap(leftField, leftValue, rightValue)) overlaps.push({ leftField, leftValue, rightField, rightValue });
        }
      }
    }
  }
  return overlaps;
}

function overlapFields(overlaps) {
  return [...new Set(overlaps.flatMap((overlap) => [overlap.leftField, overlap.rightField]))].sort();
}

function reservationConflicts(records, reservations, ignoreRecordId = null) {
  const requested = reservations || {};
  const conflicts = [];
  for (const record of Object.values(records)) {
    if (record.id === ignoreRecordId) continue;
    // One conflict per requested value per record, as before: a path nested
    // under two of the record's reservations is one collision, not two.
    const seen = new Set();
    for (const overlap of reservationOverlaps(record.reservations, requested)) {
      const key = `${overlap.rightField} ${overlap.rightValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({
        recordId: record.id,
        issue: record.issue,
        field: overlap.rightField,
        value: overlap.rightValue,
        reservedField: overlap.leftField,
        reservedValue: overlap.leftValue,
      });
    }
  }
  return conflicts;
}

// fleet#62: a proof is bound to the reservations it was computed over. Without
// the digest, a proof printed for one explicit set satisfied `assign` under any
// other non-conflicting set (candidates, fields and the two empty lists were the
// whole comparison), so "pass the proof verbatim" bound nothing about WHAT was
// being reserved. The expected side always carries a digest (it is computed
// here, fresh); a supplied proof without one is a hand-authored proof and is
// not the verbatim one.
function reservationDigest(records) {
  const canonical = [...records]
    .map((record) => [Number(record.issue), Object.fromEntries(RESERVATION_FIELDS.map((field) => [field, [...new Set((record.reservations?.[field] || []).map(String))].sort()]))])
    .sort((left, right) => left[0] - right[0]);
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function proofMatches(expected, supplied) {
  return Boolean(expected?.independent)
    && Boolean(supplied?.independent)
    && typeof expected.reservationDigest === 'string'
    && supplied.reservationDigest === expected.reservationDigest
    && JSON.stringify([...(supplied.candidates || [])].map(Number).sort((a, b) => a - b)) === JSON.stringify([...expected.candidates].map(Number).sort((a, b) => a - b))
    && JSON.stringify([...(supplied.checkedFields || [])].map(String).sort()) === JSON.stringify([...expected.checkedFields].map(String).sort())
    && !(expected.conflicts || []).length
    && !(expected.missingReservations || []).length
    && !(supplied.missingReservations || []).length
    && !(supplied.conflicts || []).length;
}

function proofFor(records) {
  const conflicts = [];
  const missingReservations = records.filter((record) => !hasReservationEvidence(record.reservations)).map((record) => Number(record.issue));
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      const overlaps = reservationOverlaps(records[left].reservations, records[right].reservations);
      if (overlaps.length) conflicts.push({ left: Number(records[left].issue), right: Number(records[right].issue), fields: overlapFields(overlaps) });
    }
  }
  return {
    independent: conflicts.length === 0 && missingReservations.length === 0,
    candidates: records.map((record) => Number(record.issue)),
    checkedFields: [...RESERVATION_FIELDS],
    conflicts,
    missingReservations,
    reservationDigest: reservationDigest(records),
  };
}

function reservationBaseline(options = {}) {
  const root = asRoot(options.root);
  return withLock(root, (p) => {
    const id = String(options.id);
    const active = activeState(p);
    if (active.records[id]) throw new WorkStateError('RECORD_EXISTS', `record '${id}' already exists`);
    const reusable = reusableWorkRecord(p, id);
    if (fs.existsSync(archiveFile(p, id)) && !reusable) throw new WorkStateError('RECORD_ARCHIVED', `record '${id}' is terminally archived and cannot be reused`);
    if (fs.existsSync(releaseFile(p, id)) && !reusable) throw new WorkStateError('RELEASE_NOT_REUSABLE', `released record '${id}' does not prove an untouched reservation`);
    if (fs.existsSync(abandonFile(p, id)) && !reusable) throw new WorkStateError('ABANDON_NOT_REUSABLE', `abandoned record '${id}' does not have a valid audited abandonment`);
    return reusable
      ? { revision: reusable.record.revision + 1, eventSequence: reusable.record.eventSequence + 1, reused: true }
      : { revision: 1, eventSequence: 1, reused: false };
  });
}

function reserveRecord(options = {}) {
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey || `reserve-${options.id || ''}`);
  return withLock(root, (p) => {
    const active = activeState(p);
    const id = String(options.id);
    const existing = active.records[id];
    if (existing) {
      const replay = replayIfKnown(existing, key);
      if (replay) return replay;
      throw new WorkStateError('RECORD_EXISTS', `record '${id}' already exists`);
    }
    const reusable = reusableWorkRecord(p, id);
    if (fs.existsSync(archiveFile(p, id)) && !reusable) throw new WorkStateError('RECORD_ARCHIVED', `record '${id}' is terminally archived and cannot be reused`);
    if (fs.existsSync(releaseFile(p, id)) && !reusable) throw new WorkStateError('RELEASE_NOT_REUSABLE', `released record '${id}' does not prove an untouched reservation`);
    if (fs.existsSync(abandonFile(p, id)) && !reusable) throw new WorkStateError('ABANDON_NOT_REUSABLE', `abandoned record '${id}' does not have a valid audited abandonment`);
    const activeRecords = Object.values(active.records);
    const activeAssignments = activeRecords.filter((record) => record.manifestPath && record.state !== 'retired');
    const suppliedSubjects = new Map((Array.isArray(options.proofRecords) ? options.proofRecords : []).map((record) => [String(record.id), record]));
    const reservationSubjects = activeRecords.map((record) => {
      if (hasReservationEvidence(record.reservations)) return record;
      const supplied = suppliedSubjects.get(record.id);
      return supplied && Number(supplied.issue) === Number(record.issue) ? { ...record, reservations: supplied.reservations } : record;
    });
    const proofSubjects = reservationSubjects.filter((record) => record.manifestPath && record.state !== 'retired');
    const expectedProof = proofFor([...proofSubjects, { issue: Number(options.issue), reservations: options.reservations }]);
    if (activeAssignments.length >= 3 || (activeAssignments.length >= 2 && !proofMatches(expectedProof, options.independenceProof))) {
      throw new WorkStateError('THIRD_ASSIGNMENT_REQUIRES_PROOF', 'a third assignment requires an independent machine-readable proof');
    }
    const conflicts = reservationConflicts(Object.fromEntries(reservationSubjects.map((record) => [record.id, record])), options.reservations);
    if (conflicts.length) {
      throw new WorkStateError('RESERVATION_CONFLICT', `reservation conflicts with ${conflicts[0].recordId}`, { conflicts });
    }
    const now = isoNow(options.now);
    const record = baseRecord({ ...options, state: 'assigned', now });
    if (reusable) {
      record.revision = reusable.record.revision + 1;
      record.eventSequence = reusable.record.eventSequence + 1;
      record.createdAt = reusable.record.createdAt;
    }
    record.idempotency[key] = { revision: record.revision, eventSequence: record.eventSequence, type: 'assignment-reserved' };
    const event = eventFor(record, {
      type: 'assignment-reserved', actor: options.actor || 'assignment-planner', at: now,
      idempotencyKey: key, evidence: options.evidence,
      changes: { state: 'assigned', reservations: record.reservations, prNumber: record.github?.prNumber || null },
    });
    commitMutation(p, { recordId: id, beforeRecord: null, afterRecord: record, event, supersedeReusable: reusable, killPoint: options.killPoint });
    return { replayed: false, revision: record.revision, eventSequence: record.eventSequence, record };
  });
}

function releaseRecord(options = {}) {
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey);
  return withLock(root, (p) => {
    const active = activeState(p);
    const record = active.records[String(options.id)];
    if (!record) throw new WorkStateError('NOT_FOUND', `active record '${options.id}' was not found`);
    const replay = replayIfKnown(record, key);
    if (replay) return replay;
    if (record.state !== 'assigned') throw new WorkStateError('INVALID_RELEASE', `only assigned records can release reservations (was ${record.state})`);
    if (Number(options.expectedRevision) !== record.revision) throw new WorkStateError('STALE_REVISION', `expected revision ${options.expectedRevision}, current revision ${record.revision}`, { currentRevision: record.revision });
    const events = eventLines(p);
    const currentAttemptIsUntouched = Number(record.budget?.cumulativeTokens || 0) === 0
      && !record.budget?.extension
      && !record.github?.prNumber && !record.github?.prUrl && !record.github?.headSha
      && (!record.review?.progress || record.review.progress === 'not-started')
      && events.filter((event) => event.recordId === record.id).every((event) => ['assignment-reserved', 'assignment-released'].includes(event.type));
    if (!currentAttemptIsUntouched) throw new WorkStateError('INVALID_RELEASE', `record '${record.id}' does not prove an untouched reservation`);
    const now = isoNow(options.now);
    const next = { ...record, state: 'released', revision: record.revision + 1, eventSequence: record.eventSequence + 1, updatedAt: now, idempotency: { ...record.idempotency } };
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: 'assignment-released' };
    const event = eventFor(next, {
      type: 'assignment-released', actor: options.actor || 'assignment-planner', at: now,
      idempotencyKey: key, evidence: options.evidence, changes: { from: 'assigned', to: 'released' },
    });
    const resultRecord = commitMutation(p, { recordId: record.id, beforeRecord: record, afterRecord: null, releasedRecord: next, event, killPoint: options.killPoint });
    return { replayed: false, revision: next.revision, eventSequence: next.eventSequence, record: resultRecord };
  });
}

function abandonRecord(options = {}) {
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey);
  return withLock(root, (p) => {
    const active = activeState(p);
    const record = active.records[String(options.id)];
    if (!record) {
      const abandoned = readJson(abandonFile(p, options.id))?.record;
      const replay = abandoned && replayIfKnown(abandoned, key);
      if (replay) return replay;
      throw new WorkStateError('NOT_FOUND', `active record '${options.id}' was not found`);
    }
    const replay = replayIfKnown(record, key);
    if (replay) return replay;
    if (Number(options.expectedRevision) !== record.revision) throw new WorkStateError('STALE_REVISION', `expected revision ${options.expectedRevision}, current revision ${record.revision}`, { currentRevision: record.revision });
    const reason = String(options.reason || '').trim();
    if (!reason) throw new WorkStateError('MISSING_ABANDON_REASON', 'abandonment requires a reason');
    if (['merged', 'retiring'].includes(record.state)) throw new WorkStateError('INVALID_ABANDON', `record '${record.id}' is ${record.state} and must complete retirement`);
    const lineage = eventLines(p).filter((event) => event.recordId === record.id).sort((a, b) => a.sequence - b.sequence);
    const lastReservation = lineage.map((event) => event.type).lastIndexOf('assignment-reserved');
    const currentAttemptEvents = lastReservation < 0 ? lineage : lineage.slice(lastReservation + 1);
    if (currentAttemptEvents.length === 0) throw new WorkStateError('INVALID_ABANDON', `record '${record.id}' is an untouched reservation and must be released`);
    const now = isoNow(options.now);
    const actor = options.actor || 'fleet-operator';
    const next = {
      ...record,
      state: 'abandoned',
      revision: record.revision + 1,
      eventSequence: record.eventSequence + 1,
      updatedAt: now,
      abandonment: { from: record.state, reason, actor, at: now },
      idempotency: { ...record.idempotency },
    };
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: 'assignment-abandoned' };
    const event = eventFor(next, {
      type: 'assignment-abandoned', actor, at: now, idempotencyKey: key,
      evidence: options.evidence, changes: { from: record.state, to: 'abandoned', reason },
    });
    const resultRecord = commitMutation(p, { recordId: record.id, beforeRecord: record, afterRecord: null, abandonedRecord: next, event, killPoint: options.killPoint });
    return { replayed: false, revision: next.revision, eventSequence: next.eventSequence, record: resultRecord };
  });
}

function createRecord(options = {}) {
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey || `create-${options.id || ''}`);
  return withLock(root, (p) => {
    const active = activeState(p);
    const existing = active.records[String(options.id)];
    if (existing) {
      const replay = replayIfKnown(existing, key);
      if (replay) return replay;
      throw new WorkStateError('RECORD_EXISTS', `record '${options.id}' already exists`);
    }
    if (fs.existsSync(archiveFile(p, options.id))) throw new WorkStateError('RECORD_ARCHIVED', `record '${options.id}' is archived and cannot be reused`);
    if (fs.existsSync(releaseFile(p, options.id))) throw new WorkStateError('RECORD_RELEASED', `record '${options.id}' was released; only reserve can reuse it`);
    if (fs.existsSync(abandonFile(p, options.id))) throw new WorkStateError('RECORD_ABANDONED', `record '${options.id}' was abandoned; only reserve can reuse it`);
    const now = isoNow(options.now);
    const record = baseRecord({ ...options, now });
    record.idempotency[key] = { revision: 1, eventSequence: 1, type: options.shadow ? 'shadow-projected' : 'work-created' };
    const event = eventFor(record, {
      type: options.shadow ? 'shadow-projected' : 'work-created',
      actor: options.actor,
      at: now,
      idempotencyKey: key,
      evidence: options.evidence,
      changes: { state: record.state, prNumber: record.github?.prNumber || null },
    });
    commitMutation(p, { recordId: record.id, beforeRecord: null, afterRecord: record, event, killPoint: options.killPoint });
    return { replayed: false, revision: 1, eventSequence: 1, record };
  });
}

// #118 (ADR 0014 Consequences): a send-back is a `review -> revision` transition.
// On endzone #1240 one finding was re-raised five times at a cost of 569k tokens,
// and nothing counted. The count is derived from the record's own committed
// transitions (its idempotency map), so it covers records created before this
// rule and resets with a fresh reservation, which starts a new attempt. The
// door refuses the third; `hold` and `escalated` are unaffected.
const SEND_BACK_LIMIT = 3;

// Ruling 2026-09-24 (PR #122): an escalation raised from `review` and resolved
// back to `revision` is a send-back too, or a lead could resolve its own
// escalation and never meet the limit. Those entries carry `sendBack: true`;
// escalations raised elsewhere (ci-wait) are not review rounds.
function isSendBack(record, to) {
  return to === 'revision' && (record.state === 'review' || (record.state === 'escalated' && record.prior_state === 'review'));
}

function sendBackCount(record) {
  return Object.values(record?.idempotency || {}).filter((entry) => entry && (entry.type === 'transition:review->revision' || entry.sendBack === true)).length;
}

function validateTransition(record, to, options) {
  if (!STATES.includes(to)) throw new WorkStateError('INVALID_STATE', `unknown state '${to}'`);
  const allowed = TRANSITIONS[record.state] || [];
  const fromEscalated = record.state === 'escalated';
  if (!allowed.includes(to)) throw new WorkStateError('INVALID_TRANSITION', `${record.state} -> ${to} is not allowed`);
  if (isSendBack(record, to)) {
    const sendBacks = sendBackCount(record);
    if (sendBacks >= SEND_BACK_LIMIT - 1) {
      if (record.state === 'review') {
        throw new WorkStateError('SEND_BACK_LIMIT', `${record.id} has been sent back ${sendBacks} times; a third send-back is refused (#118). Escalate with the criterion restated (transition --to escalated) so the disagreement gets a Ruling instead of another round`, { sendBacks, limit: SEND_BACK_LIMIT });
      }
      // Past the limit only a Ruling sends work back, and it is named on the event.
      if (!options.ruling || !String(options.ruling).trim()) {
        throw new WorkStateError('SEND_BACK_LIMIT', `${record.id} has been sent back ${sendBacks} times; resolving this escalation to revision needs the Ruling that ordered it (--ruling "<link or reference>"), which is recorded on the event`, { sendBacks, limit: SEND_BACK_LIMIT });
      }
    }
  }
  if (to === 'hold' && !record.github?.prNumber) throw new WorkStateError('MISSING_PR_EVIDENCE', 'hold requires github.prNumber');
  if (to === 'merged') {
    const observation = options.githubObservation;
    if (!observation || String(observation.state).toUpperCase() !== 'MERGED' || !observation.mergedAt) {
      throw new WorkStateError('MISSING_GITHUB_RECONCILIATION', 'merged requires a reconciled GitHub state=MERGED and mergedAt');
    }
  }
  if (to === 'escalated' && !options.evidence) throw new WorkStateError('MISSING_DECISION_EVIDENCE', 'escalated requires decision evidence');
  if (fromEscalated && (!options.evidence || !record.prior_state)) {
    throw new WorkStateError('MISSING_DECISION_EVIDENCE', 'escalation resolution requires prior_state and decision evidence');
  }
  if (fromEscalated && to !== record.prior_state && !TRANSITIONS[record.prior_state]?.includes(to)) {
    throw new WorkStateError('INVALID_ESCALATION_RESOLUTION', `${to} is not a successor of prior_state ${record.prior_state}`);
  }
}

function reconcilePullRequest({ repo, prNumber, executable = 'gh' }) {
  if (!repo || !Number.isInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    throw new WorkStateError('INVALID_GITHUB_QUERY', 'repo and positive prNumber are required');
  }
  try {
    const raw = execFileSync(executable, ['pr', 'view', String(prNumber), '-R', String(repo), '--json', 'state,mergedAt,url,headRefOid'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000,
    });
    const result = JSON.parse(raw);
    return { ...result, evidence: `gh pr view ${prNumber} -R ${repo}` };
  } catch (error) {
    throw new WorkStateError('GITHUB_RECONCILIATION_FAILED', String(error.stderr || error.message || error));
  }
}

function transitionRecord(options = {}) {
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey);
  return withLock(root, (p) => {
    const active = activeState(p);
    const record = active.records[String(options.id)];
    if (!record) throw new WorkStateError('NOT_FOUND', `active record '${options.id}' was not found`);
    const to = String(options.to || '');
    // fleet#56: a decision transition writes the outbox line from the door that
    // commits it, whoever the caller is (the lead's CLI, budget.js, the watcher,
    // review-policy hold). The Principal's frontier and the watchdog's frontier
    // wake read that cache and nothing else, and a lead's escalation of a
    // PR-less record used to reach every ledger but that one. A replay repairs
    // a missing line (a crash between commit and append) and never duplicates.
    const pageDecision = (result) => (DECISION_STATES.includes(to)
      ? { ...result, paged: appendWakeOutbox({ root, recordId: record.id, revision: result.revision, eventSequence: result.eventSequence, wake: 'decision-needed', idempotencyKey: key, evidence: options.evidence, now: options.now }) }
      : result);
    const replay = replayIfKnown(record, key);
    if (replay) return pageDecision(replay);
    if (!Number.isInteger(Number(options.expectedRevision))) throw new WorkStateError('MISSING_REVISION', 'expected revision is required');
    if (Number(options.expectedRevision) !== record.revision) {
      throw new WorkStateError('STALE_REVISION', `expected revision ${options.expectedRevision}, current revision ${record.revision}`, { currentRevision: record.revision });
    }
    const prNumber = options.prNumber ? Number(options.prNumber) : record.github?.prNumber;
    const githubObservation = to === 'merged'
      ? (options.githubRepo ? reconcilePullRequest({ repo: options.githubRepo, prNumber, executable: options.githubExecutable })
        : (options.reconciledObservation && options.reconciledObservation.evidence ? options.reconciledObservation
          : (options.testOnly ? (options.githubObservation || (options.githubState ? { state: options.githubState, mergedAt: options.githubMergedAt, evidence: options.githubEvidence } : null)) : null)))
      : null;
    validateTransition(record, to, { ...options, githubObservation });
    const now = isoNow(options.now);
    const next = {
      ...record,
      state: to,
      revision: record.revision + 1,
      eventSequence: record.eventSequence + 1,
      updatedAt: now,
      idempotency: { ...record.idempotency },
    };
    if (prNumber) next.github = { ...record.github, prNumber };
    if (githubObservation) next.github = { ...next.github, lastObservedState: githubObservation.state, mergedAt: githubObservation.mergedAt, evidence: githubObservation.evidence || options.evidence, ...(githubObservation.headRefOid ? { mergedHeadSha: String(githubObservation.headRefOid) } : {}) };
    if (to === 'escalated') {
      next.prior_state = record.state;
      next.decisionEvidence = options.evidence;
    } else if (record.state === 'escalated') {
      // fleet#44: the resolved escalation's own evidence survives beside the
      // resolution, so a rule that re-derives the same fact from GitHub (the
      // watcher's closing-linkage check) can see it was already answered.
      next.prior_state = null;
      next.decisionEvidence = null;
      next.resolvedDecisionEvidence = record.decisionEvidence || null;
      next.resolutionEvidence = options.evidence;
    }
    const sendBack = isSendBack(record, to);
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: `transition:${record.state}->${to}`, ...(sendBack ? { sendBack: true } : {}) };
    const event = eventFor(next, {
      type: `state-${to}`,
      actor: options.actor,
      at: now,
      idempotencyKey: key,
      evidence: options.evidence,
      changes: {
        from: record.state, to, prior_state: next.prior_state || null, prNumber: next.github?.prNumber || null,
        ...(to === 'revision' ? { sendBack, ...(options.ruling ? { ruling: String(options.ruling) } : {}) } : {}),
      },
    });
    const retiring = to === 'retired';
    const resultRecord = commitMutation(p, {
      recordId: record.id,
      beforeRecord: record,
      afterRecord: retiring ? null : next,
      archiveRecord: retiring ? next : null,
      event,
      killPoint: options.killPoint,
    });
    return pageDecision({ replayed: false, revision: next.revision, eventSequence: next.eventSequence, record: resultRecord });
  });
}

function observeRecord(options = {}) {
  // Ticket 04: record a PR observation on an active record without a state change.
  // The caller (the PR watcher) compares digests first, so this runs only when the
  // observed value actually changed - an identical retry replays via its key.
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey);
  return withLock(root, (p) => {
    const active = activeState(p);
    const record = active.records[String(options.id)];
    if (!record) throw new WorkStateError('NOT_FOUND', `active record '${options.id}' was not found`);
    const replay = replayIfKnown(record, key);
    if (replay) return replay;
    if (!Number.isInteger(Number(options.expectedRevision))) throw new WorkStateError('MISSING_REVISION', 'expected revision is required');
    if (Number(options.expectedRevision) !== record.revision) {
      throw new WorkStateError('STALE_REVISION', `expected revision ${options.expectedRevision}, current revision ${record.revision}`, { currentRevision: record.revision });
    }
    const observation = options.observation;
    if (!observation || typeof observation !== 'object' || !observation.digest) {
      throw new WorkStateError('MISSING_OBSERVATION', 'observe requires an observation carrying a digest');
    }
    const now = isoNow(options.now);
    const next = {
      ...record,
      revision: record.revision + 1,
      eventSequence: record.eventSequence + 1,
      updatedAt: now,
      github: { ...record.github, ...(options.prNumber ? { prNumber: Number(options.prNumber) } : {}), observation },
      idempotency: { ...record.idempotency },
    };
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: 'pr-observed' };
    const event = eventFor(next, {
      type: 'pr-observed',
      actor: options.actor,
      at: now,
      idempotencyKey: key,
      evidence: options.evidence,
      changes: { digest: observation.digest, changed: options.changed || null, wake: options.wake || null, prNumber: next.github?.prNumber || null },
    });
    commitMutation(p, { recordId: record.id, beforeRecord: record, afterRecord: next, event, killPoint: options.killPoint });
    return { replayed: false, revision: next.revision, eventSequence: next.eventSequence, record: next };
  });
}

const REVIEW_KINDS = Object.freeze({
  // Ticket 05: the project lead's one independent Standards+Spec review lands
  // after gates settle; the IC-hosted risk review is pre-PR-ready ONLY
  // (amendment 5) - implementing, a revision cycle, or a still-draft pr-open.
  // ci-wait/review are excluded so the lead-hosted risk path stays closed.
  formal: ['review'],
  risk: ['implementing', 'revision', 'pr-open'],
});

function recordReview(options = {}) {
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey);
  return withLock(root, (p) => {
    const active = activeState(p);
    const record = active.records[String(options.id)];
    if (!record) throw new WorkStateError('NOT_FOUND', `active record '${options.id}' was not found`);
    const replay = replayIfKnown(record, key);
    if (replay) return replay;
    if (!Number.isInteger(Number(options.expectedRevision))) throw new WorkStateError('MISSING_REVISION', 'expected revision is required');
    if (Number(options.expectedRevision) !== record.revision) {
      throw new WorkStateError('STALE_REVISION', `expected revision ${options.expectedRevision}, current revision ${record.revision}`, { currentRevision: record.revision });
    }
    const review = options.review || {};
    const kind = String(review.kind || '');
    if (!REVIEW_KINDS[kind]) throw new WorkStateError('INVALID_REVIEW_KIND', `unknown review kind '${kind}'`);
    if (!review.headSha || !review.artifact) throw new WorkStateError('MISSING_REVIEW_EVIDENCE', 'a review requires headSha and artifact');
    if (!REVIEW_KINDS[kind].includes(record.state)) {
      throw new WorkStateError('INVALID_REVIEW_STATE', `a ${kind} review cannot be recorded while ${record.state}`);
    }
    const now = isoNow(options.now);
    const entry = {
      headSha: String(review.headSha),
      artifact: String(review.artifact),
      tier: review.tier || null,
      triggers: review.triggers || [],
      priorArtifact: review.priorArtifact || null,
      at: now,
      actor: options.actor || 'unknown',
    };
    const next = {
      ...record,
      revision: record.revision + 1,
      eventSequence: record.eventSequence + 1,
      updatedAt: now,
      review: { ...record.review, progress: `${kind}-recorded`, [kind]: entry },
      idempotency: { ...record.idempotency },
    };
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: 'review-recorded' };
    const event = eventFor(next, {
      type: 'review-recorded',
      actor: options.actor,
      at: now,
      idempotencyKey: key,
      evidence: options.evidence,
      changes: { kind, headSha: entry.headSha, artifact: entry.artifact, tier: entry.tier, triggers: entry.triggers, priorArtifact: entry.priorArtifact },
    });
    commitMutation(p, { recordId: record.id, beforeRecord: record, afterRecord: next, event, killPoint: options.killPoint });
    return { replayed: false, revision: next.revision, eventSequence: next.eventSequence, record: next };
  });
}

// --- wake outbox (state/watch/wake-outbox.jsonl) ---
// The event ledger is the authoritative wake record; the outbox is the delivery
// cache the Principal's frontier, the watchdog's frontier wake and the digest
// read. A decision transition appends one line, at-least-once and keyed by the
// transition's idempotency key: a retry that finds the line writes nothing, a
// retry that finds it missing (crash between commit and append) repairs it.
function wakeOutboxFile(root) {
  return path.join(asRoot(root), 'state', 'watch', 'wake-outbox.jsonl');
}

function outboxHasWake(root, recordId, idempotencyKey) {
  const file = wakeOutboxFile(root);
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).some((line) => {
    if (!line.trim()) return false;
    try {
      const entry = JSON.parse(line);
      return entry.recordId === recordId && entry.idempotencyKey === idempotencyKey;
    } catch { return false; }
  });
}

// Idempotent by (recordId, idempotencyKey): the door that commits a decision
// transition writes the line, so a caller that also writes one (the watcher,
// for its observe wakes) finds it and appends nothing. Returns whether a line
// was written, which is the caller's cue to launch the page.
function appendWakeOutbox({ root, recordId, revision, eventSequence, wake, idempotencyKey, evidence, now } = {}) {
  if (outboxHasWake(root, recordId, idempotencyKey)) return false;
  const file = wakeOutboxFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A transition's evidence carries a `wake:<kind>; ` prefix (the ledger's own
  // wake record); the outbox line names the wake in its own field.
  const text = String(evidence || '').replace(/^wake:[a-z-]+;\s*/, '');
  const line = { at: isoNow(now), recordId, revision, eventSequence, wake, idempotencyKey, evidence: text };
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
  return true;
}

// Read-only view of the whole ledger (online partitions then archive), in ledger order.
function readEvents(root) {
  return eventLines(paths(root));
}

// The event that moved a record into its current state (highest sequence wins);
// for a decision state this is the decision event the notifier and digest key on.
function enteringEvent(events, recordId, state) {
  return events
    .filter((event) => event.recordId === recordId && event.type === `state-${state}`)
    .sort((a, b) => b.sequence - a.sequence)[0] || null;
}

// tenants/<name>.json, keyed by name; a torn file only costs that tenant's config.
function readTenantConfigs(root) {
  const dir = path.join(asRoot(root), 'tenants');
  const configs = {};
  if (!fs.existsSync(dir)) return configs;
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    try { configs[path.basename(file, '.json')] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { configs[path.basename(file, '.json')] = {}; }
  }
  return configs;
}

// Ticket 09: the budget door. Two phases, each one event: `warn` records the measured
// cumulative job tokens at the moment the warning threshold was crossed (once per record;
// bin/budget.js decides when), and `extend` records an approved extension (amount,
// grantor, reason). Nothing is written between crossings: the live per-record figure is a
// projection (state/budget/last.json), so a 5-minute measurement cadence does not bloat
// the ledger. The escalation itself goes through transitionRecord like any other.
function recordBudget(options = {}) {
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey);
  return withLock(root, (p) => {
    const active = activeState(p);
    const record = active.records[String(options.id)];
    if (!record) throw new WorkStateError('NOT_FOUND', `active record '${options.id}' was not found`);
    const replay = replayIfKnown(record, key);
    if (replay) return replay;
    if (!Number.isInteger(Number(options.expectedRevision))) throw new WorkStateError('MISSING_REVISION', 'expected revision is required');
    if (Number(options.expectedRevision) !== record.revision) {
      throw new WorkStateError('STALE_REVISION', `expected revision ${options.expectedRevision}, current revision ${record.revision}`, { currentRevision: record.revision });
    }
    const phase = String(options.phase || '');
    const tokens = Number(options.tokens);
    const now = isoNow(options.now);
    const budget = { ...(record.budget || { cumulativeTokens: 0, extension: null }) };
    let type;
    let changes;
    if (phase === 'warn') {
      if (!Number.isFinite(tokens) || tokens < 0) throw new WorkStateError('INVALID_BUDGET', 'a warning needs the measured token count');
      budget.cumulativeTokens = tokens;
      budget.warnedAt = now;
      type = 'budget-warning';
      changes = { cumulativeTokens: tokens, threshold: options.threshold ?? null };
    } else if (phase === 'extend') {
      if (!Number.isFinite(tokens) || tokens <= 0) throw new WorkStateError('INVALID_BUDGET', 'an extension needs a positive token amount');
      if (!options.by) throw new WorkStateError('INVALID_BUDGET', 'an extension names who granted it');
      if (!options.reason) throw new WorkStateError('INVALID_BUDGET', 'an extension carries a reason');
      budget.extension = { tokens, by: String(options.by), reason: String(options.reason), at: now };
      type = 'budget-extended';
      changes = { extension: budget.extension };
    } else {
      throw new WorkStateError('INVALID_BUDGET', `unknown budget phase '${phase}' (warn | extend)`);
    }
    const next = {
      ...record,
      revision: record.revision + 1,
      eventSequence: record.eventSequence + 1,
      updatedAt: now,
      budget,
      idempotency: { ...record.idempotency },
    };
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type };
    const event = eventFor(next, { type, actor: options.actor || 'budget', at: now, idempotencyKey: key, evidence: options.evidence, changes });
    const resultRecord = commitMutation(p, { recordId: record.id, beforeRecord: record, afterRecord: next, event, killPoint: options.killPoint });
    return { replayed: false, revision: next.revision, eventSequence: next.eventSequence, record: resultRecord };
  });
}

function notifyRecord(options = {}) {
  // Ticket 07: delivery state for one decision event, keyed by that event's
  // sequence. claim -> sent | failed; a failed delivery is visible and inert until
  // authorize-retry (evidence required) re-arms exactly one more claim. The claim
  // is taken under the store lock BEFORE anything is sent, so concurrent notifier
  // starts cannot both page: one wins the revision, the rest read the claim.
  const root = asRoot(options.root);
  const key = requireIdempotency(options.idempotencyKey);
  const phase = String(options.phase || '');
  if (!NOTIFICATION_PHASES.includes(phase)) throw new WorkStateError('INVALID_NOTIFICATION_PHASE', `unknown notification phase '${phase}'`);
  const decisionSequence = Number(options.decisionSequence);
  if (!Number.isInteger(decisionSequence) || decisionSequence <= 0) throw new WorkStateError('MISSING_DECISION_SEQUENCE', 'decisionSequence is required');
  return withLock(root, (p) => {
    const active = activeState(p);
    const record = active.records[String(options.id)];
    if (!record) throw new WorkStateError('NOT_FOUND', `active record '${options.id}' was not found`);
    const replay = replayIfKnown(record, key);
    if (replay) return replay;
    if (!Number.isInteger(Number(options.expectedRevision))) throw new WorkStateError('MISSING_REVISION', 'expected revision is required');
    if (Number(options.expectedRevision) !== record.revision) {
      throw new WorkStateError('STALE_REVISION', `expected revision ${options.expectedRevision}, current revision ${record.revision}`, { currentRevision: record.revision });
    }
    const decision = eventLines(p).find((event) => event.recordId === record.id && Number(event.sequence) === decisionSequence);
    if (!decision || !DECISION_EVENT_TYPES.includes(decision.type)) {
      throw new WorkStateError('NOT_A_DECISION_EVENT', `event ${decisionSequence} on ${record.id} is not a decision event`);
    }
    const decisionState = decision.type.slice('state-'.length);
    const current = record.notifications?.[String(decisionSequence)] || null;
    const now = isoNow(options.now);
    let entry;
    let type;
    if (phase === 'claim') {
      if (record.state !== decisionState) throw new WorkStateError('DECISION_RESOLVED', `record is ${record.state}; decision ${decisionSequence} (${decisionState}) no longer stands`);
      if (current?.status === 'sent') throw new WorkStateError('NOTIFICATION_ALREADY_SENT', `decision ${decisionSequence} was already notified`);
      if (current?.status === 'claimed') throw new WorkStateError('NOTIFICATION_ALREADY_CLAIMED', `decision ${decisionSequence} has a notification in flight (claimed ${current.at})`);
      if (current?.status === 'failed' && !current.retryAuthorized) throw new WorkStateError('NOTIFICATION_RETRY_REQUIRES_AUTHORIZATION', `decision ${decisionSequence} failed delivery; a retry needs authorize-retry`);
      entry = { status: 'claimed', attempt: (current?.attempt || 0) + 1, channel: options.channel || null, at: now, detail: null, retryAuthorized: false, actor: options.actor || 'unknown' };
      type = 'notification-attempted';
    } else if (phase === 'sent' || phase === 'failed') {
      if (current?.status === 'sent') throw new WorkStateError('NOTIFICATION_ALREADY_SENT', `decision ${decisionSequence} was already notified`);
      if (current?.status !== 'claimed') throw new WorkStateError('NOTIFICATION_NOT_CLAIMED', `decision ${decisionSequence} has no claim to settle`);
      entry = { ...current, status: phase, at: now, detail: options.detail || null, actor: options.actor || current.actor };
      type = `notification-${phase}`;
    } else {
      if (!options.evidence) throw new WorkStateError('MISSING_DECISION_EVIDENCE', 'authorize-retry requires evidence');
      if (current?.status !== 'failed') throw new WorkStateError('NOTIFICATION_NOT_FAILED', `decision ${decisionSequence} is ${current?.status || 'unnotified'}, not failed`);
      entry = { ...current, retryAuthorized: true, retryEvidence: options.evidence, retryAuthorizedBy: options.actor || 'unknown', retryAuthorizedAt: now };
      type = 'notification-retry-authorized';
    }
    const next = {
      ...record,
      revision: record.revision + 1,
      eventSequence: record.eventSequence + 1,
      updatedAt: now,
      notifications: { ...(record.notifications || {}), [String(decisionSequence)]: entry },
      idempotency: { ...record.idempotency },
    };
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type };
    const event = eventFor(next, {
      type, actor: options.actor, at: now, idempotencyKey: key, evidence: options.evidence,
      changes: { decisionSequence, decisionType: decision.type, status: entry.status, attempt: entry.attempt, channel: entry.channel, detail: entry.detail || null, retryAuthorized: entry.retryAuthorized },
    });
    commitMutation(p, { recordId: record.id, beforeRecord: record, afterRecord: next, event, killPoint: options.killPoint });
    return { replayed: false, revision: next.revision, eventSequence: next.eventSequence, record: next };
  });
}

function getRecord(options = {}) {
  const root = asRoot(options.root);
  return withLock(root, (p) => {
    const active = activeState(p);
    const id = String(options.id);
    if (active.records[id]) return active.records[id];
    const archived = readJson(archiveFile(p, id));
    if (archived) return archived.record;
    const released = readJson(releaseFile(p, id));
    if (released) return released.record;
    const abandoned = readJson(abandonFile(p, id));
    if (abandoned) return abandoned.record;
    throw new WorkStateError('NOT_FOUND', `record '${id}' was not found`);
  });
}

const STATUS_MARKER = '# Fleet status';
const PROJECT_FLAGS = Object.freeze(['root', 'tenant', 'now', 'output']);

function projectStatus(options = {}) {
  const root = asRoot(options.root);
  return withLock(root, (p) => {
    const active = activeState(p);
    const tenant = options.tenant || null;
    const tenantsByRecord = new Map(Object.values(active.records).map((record) => [record.id, record.tenant]));
    if (fs.existsSync(p.archive)) {
      for (const file of fs.readdirSync(p.archive).filter((name) => name.endsWith('.json'))) {
        const archived = readJson(path.join(p.archive, file));
        if (archived?.record) tenantsByRecord.set(archived.record.id, archived.record.tenant);
      }
    }
    if (fs.existsSync(p.releases)) {
      for (const file of fs.readdirSync(p.releases).filter((name) => name.endsWith('.json'))) {
        const released = readJson(path.join(p.releases, file));
        if (released?.record) tenantsByRecord.set(released.record.id, released.record.tenant);
      }
    }
    if (fs.existsSync(p.abandons)) {
      for (const file of fs.readdirSync(p.abandons).filter((name) => name.endsWith('.json'))) {
        const abandoned = readJson(path.join(p.abandons, file));
        if (abandoned?.record) tenantsByRecord.set(abandoned.record.id, abandoned.record.tenant);
      }
    }
    const records = Object.values(active.records)
      .filter((record) => !tenant || record.tenant === tenant)
      .sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue);
    const events = eventLines(p)
      .filter((event) => !tenant || tenantsByRecord.get(event.recordId) === tenant)
      .slice(-20);
    const canonicalTimes = [...records.map((record) => record.updatedAt), ...events.map((event) => event.at)]
      .filter(Boolean).sort();
    const generatedAt = isoNow(options.now || canonicalTimes[canonicalTimes.length - 1] || '1970-01-01T00:00:00.000Z');
    const lines = [STATUS_MARKER, '', `generated: ${generatedAt}`, '', '## Active work', ''];
    if (records.length === 0) lines.push('None.');
    else for (const record of records) lines.push(`- ${record.tenant} #${record.issue} - ${record.state} - revision ${record.revision} - ${record.owner?.session || record.owner?.name || 'unassigned'}`);
    lines.push('', '## Recent events', '');
    if (events.length === 0) lines.push('None.');
    else for (const event of events) lines.push(`- ${event.at} - ${event.recordId} - ${event.type} - seq ${event.sequence}`);
    const content = `${lines.join('\n')}\n`;
    // The projection answers on stdout unless --output names a file. It used to default
    // to state/status/<tenant>.md, the same path the project lead hand-writes, and
    // clobbered that file eleven recorded times. A named file is only overwritten when
    // it is one this projector generated (or absent).
    const output = options.output ? path.resolve(options.output) : null;
    if (output) {
      if (fs.existsSync(output) && !fs.readFileSync(output, 'utf8').startsWith(STATUS_MARKER)) {
        throw new WorkStateError('OUTPUT_NOT_GENERATED', `refusing to overwrite ${output}: not a file this projection generated (it does not start with ${JSON.stringify(STATUS_MARKER)})`, { output });
      }
      writeAtomicText(output, content);
    }
    return { output, content };
  });
}

function shadowProject(options = {}) {
  const root = asRoot(options.root);
  return withLock(root, (p) => {
    const rosterPath = path.resolve(options.rosterPath || path.join(p.state, 'roster.json'));
    const roster = readJson(rosterPath, { sessions: [] });
    const rows = Array.isArray(roster) ? roster : (roster.sessions || []);
    const active = activeState(p);
    const rosterEvidence = path.relative(p.base, rosterPath);
    const desired = new Map();
    for (const row of rows) {
      const rosterStatus = String(row.status).toLowerCase();
      if (String(row.role).toLowerCase() !== 'ic' || !['active', 'retiring'].includes(rosterStatus) || !Number(row.issue)) continue;
      const id = `${row.tenant}:issue-${Number(row.issue)}`;
      desired.set(id, { row, rosterStatus });
    }
    for (const record of Object.values(active.records)) {
      if (desired.has(record.id)) continue;
      // 02/03 cutover: a record this projection did not create (a manifest reservation, or
      // one the lead created by hand) still has to be able to finish. Once its IC has left
      // the roster with the unit merged (or already retiring), the projection completes the
      // retirement whatever created it; otherwise such a record sits in active state forever
      // and pins its issue `reserved` in the planner's frontier. Any other record without a
      // roster row (assigned, implementing, pr-open, review, hold, escalated) is still the
      // lead's to judge; a projector never archives one of those.
      const terminalRetirement = ['merged', 'retiring'].includes(record.state);
      if (record.evidence?.roster !== rosterEvidence && !terminalRetirement) continue;
      const manifestRetirement = terminalRetirement && Boolean(record.manifestPath);
      const eventType = manifestRetirement ? 'assignment-retired' : 'shadow-retired';
      const now = isoNow(options.now);
      const next = {
        ...record,
        state: 'retired',
        revision: record.revision + 1,
        eventSequence: record.eventSequence + 1,
        updatedAt: now,
        idempotency: { ...record.idempotency },
      };
      const key = `${eventType}:${record.id}:${next.revision}`;
      next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: eventType };
      const event = eventFor(next, {
        type: eventType, actor: options.actor || 'shadow-projector', at: now,
        idempotencyKey: key, evidence: manifestRetirement ? { roster: rosterEvidence, rosterRowAbsent: true, manifest: record.manifestPath } : { roster: rosterEvidence },
        changes: { from: record.state, to: 'retired' },
      });
      commitMutation(p, { recordId: record.id, beforeRecord: record, afterRecord: null, event, archiveRecord: next });
      delete active.records[record.id];
    }
    const projected = [];
    for (const [id, { row, rosterStatus }] of desired) {
      if (active.records[id]) {
        if (rosterStatus === 'retiring' && active.records[id].state === 'implementing') {
          const record = active.records[id];
          const now = isoNow(options.now);
          const next = {
            ...record,
            state: 'retiring',
            revision: record.revision + 1,
            eventSequence: record.eventSequence + 1,
            updatedAt: now,
            idempotency: { ...record.idempotency },
          };
          const key = `shadow-retiring:${id}:${next.revision}`;
          next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: 'shadow-retiring' };
          const event = eventFor(next, {
            type: 'shadow-retiring', actor: options.actor || 'shadow-projector', at: now,
            idempotencyKey: key, evidence: { roster: rosterEvidence },
            changes: { from: record.state, to: 'retiring' },
          });
          commitMutation(p, { recordId: id, beforeRecord: record, afterRecord: next, event });
          active.records[id] = next;
        }
        projected.push(active.records[id]);
        continue;
      }
      // An abandoned attempt stays ended even if its dead IC's roster row is
      // stale. A later assignment re-enters through reserve first, so it has an
      // active record by the time the new session can appear here.
      if (fs.existsSync(abandonFile(p, id))) continue;
      const now = isoNow(options.now);
      const key = `shadow:${id}:${row.sessionId || row.name || 'unknown'}`;
      const record = baseRecord({
        id, tenant: row.tenant, issue: Number(row.issue), state: rosterStatus === 'retiring' ? 'retiring' : 'implementing',
        owner: { session: row.name, sessionId: row.sessionId, parent: row.parent },
        github: { issueNumber: Number(row.issue) },
        evidence: { roster: rosterEvidence, rosterSessionId: row.sessionId },
        now,
      });
      record.idempotency[key] = { revision: 1, eventSequence: 1, type: 'shadow-projected' };
      const event = eventFor(record, {
        type: 'shadow-projected', actor: options.actor || 'shadow-projector', at: now,
        idempotencyKey: key, evidence: record.evidence, changes: { state: record.state, prNumber: null },
      });
      commitMutation(p, { recordId: id, beforeRecord: null, afterRecord: record, event, killPoint: options.killPoint });
      projected.push(record);
      active.records[id] = record;
    }
    return { projected };
  });
}

/**
 * Parse `--flag value` pairs. With no schema every flag is accepted, as it
 * always was: a typo lands in a bucket nothing reads and the command answers
 * as if the flag had not been given. A command that must not answer by
 * accident passes `schema` (an array of accepted flag names, or
 * `{ flags: [...] }`), and then an unknown flag is a USAGE error naming the
 * flag and the accepted set (fleet#2: `review-policy.js classify` answered
 * riskReview:false over an empty diff when `--repo-path` or
 * `--tenant-config` was typed for `--repo` / `--tenant`). Adoption is one
 * binary at a time; a binary that has not adopted a schema is unchanged.
 */
function parseArgs(argv, schema = null) {
  const args = { _: [] };
  const accepted = schema ? new Set(Array.isArray(schema) ? schema : schema.flags || []) : null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') { args._ = argv.slice(i + 1); break; }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (accepted && !accepted.has(key)) {
      const list = [...accepted].map((flag) => `--${flag}`).join(', ');
      throw new WorkStateError('USAGE', `unknown flag --${key}; accepted: ${list}`, { flag: key, accepted: [...accepted] });
    }
    const next = argv[i + 1];
    args[key] = next && !next.startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

// fleet#4: this binary's own cli adopts the schema last (ruling 1), after the
// fourteen others. Declared per command: each list is every `args.xxx` /
// `args['xxx']` the handler consumes, directly or through `common`. Before
// this, `transition --state review` moved the record to `undefined`
// (INVALID_TRANSITION by luck), `review --head abc` recorded with no headSha
// (MISSING_REVIEW_EVIDENCE by luck), and `release --revision 3` released
// against NaN; a typo that happened to leave a required field unset was
// caught by the handler, one that named an optional field was not.
const COMMON_FLAGS = ['root', 'now', 'actor', 'evidence', 'idempotency-key'];
const FLAGS = Object.freeze({
  create: [...COMMON_FLAGS, 'id', 'tenant', 'issue', 'state', 'pr-number'],
  reserve: [...COMMON_FLAGS, 'id', 'tenant', 'issue', 'manifest', 'reservations', 'assignment', 'independence-proof', 'issue-url', 'body-hash'],
  release: [...COMMON_FLAGS, 'id', 'expected-revision'],
  abandon: [...COMMON_FLAGS, 'id', 'expected-revision', 'reason', 'kill-point'],
  transition: [...COMMON_FLAGS, 'id', 'to', 'expected-revision', 'kill-point', 'pr-number', 'repo', 'github-state', 'merged-at', 'github-evidence', 'no-notifier', 'ruling'],
  reconcile: ['repo', 'pr-number'],
  observe: [...COMMON_FLAGS, 'id', 'expected-revision', 'pr-number', 'observation', 'changed', 'wake'],
  review: [...COMMON_FLAGS, 'id', 'expected-revision', 'kind', 'head-sha', 'artifact', 'tier', 'triggers', 'prior-artifact'],
  notify: [...COMMON_FLAGS, 'id', 'phase', 'expected-revision', 'decision-sequence', 'channel', 'detail', 'no-notifier'],
  budget: [...COMMON_FLAGS, 'id', 'expected-revision', 'phase', 'tokens', 'by', 'reason', 'threshold'],
  get: ['root', 'id'],
  shadow: ['root', 'roster', 'now', 'actor', 'kill-point'],
  project: PROJECT_FLAGS,
});

function cli(argv) {
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(FLAGS, command)) {
    throw new WorkStateError('USAGE', `unknown command '${command}'; commands: ${Object.keys(FLAGS).join(', ')}`);
  }
  const args = parseArgs(rest, FLAGS[command]);
  const common = { root: args.root, now: args.now, actor: args.actor, evidence: args.evidence, idempotencyKey: args['idempotency-key'] };
  if (command === 'create') return createRecord({ ...common, id: args.id, tenant: args.tenant, issue: Number(args.issue), state: args.state || 'assigned', github: args['pr-number'] ? { issueNumber: Number(args.issue), prNumber: Number(args['pr-number']) } : undefined });
  if (command === 'reserve') return reserveRecord({
    ...common, id: args.id, tenant: args.tenant, issue: Number(args.issue), manifestPath: args.manifest,
    reservations: JSON.parse(args.reservations || '{}'), assignment: args.assignment ? JSON.parse(args.assignment) : undefined,
    independenceProof: args['independence-proof'] ? JSON.parse(args['independence-proof']) : undefined,
    github: args['issue-url'] ? { issueNumber: Number(args.issue), issueUrl: args['issue-url'], bodyHash: args['body-hash'] } : undefined,
  });
  if (command === 'release') return releaseRecord({ ...common, id: args.id, expectedRevision: Number(args['expected-revision']) });
  if (command === 'abandon') return abandonRecord({ ...common, id: args.id, expectedRevision: Number(args['expected-revision']), reason: args.reason, killPoint: args['kill-point'] });
  if (command === 'transition') {
    const result = transitionRecord({
      ...common, id: args.id, to: args.to, expectedRevision: Number(args['expected-revision']), killPoint: args['kill-point'],
      prNumber: args['pr-number'] ? Number(args['pr-number']) : undefined, githubRepo: args.repo,
      githubState: args['github-state'], githubMergedAt: args['merged-at'], githubEvidence: args['github-evidence'], ruling: args.ruling,
    });
    // Ticket 07: a decision event launches its notifier from the door that wrote it
    // (the watcher does the same for its own). `paged` is true when this call
    // wrote the outbox line (fleet#56): a replay that only found the line
    // launches nothing, a replay that repaired a missing line pages (the notify
    // door claims per event, so a second launch sends nothing).
    if (result.paged && args['no-notifier'] !== 'true') {
      result.notifier = require('./notify').spawnNotifier({ root: args.root, recordId: args.id, sequence: result.eventSequence });
    }
    return result;
  }
  if (command === 'reconcile') return reconcilePullRequest({ repo: args.repo, prNumber: Number(args['pr-number']) });
  if (command === 'observe') return observeRecord({
    ...common, id: args.id, expectedRevision: Number(args['expected-revision']),
    prNumber: args['pr-number'] ? Number(args['pr-number']) : undefined,
    observation: args.observation ? JSON.parse(args.observation) : undefined,
    changed: args.changed ? JSON.parse(args.changed) : undefined, wake: args.wake,
  });
  if (command === 'review') return recordReview({
    ...common, id: args.id, expectedRevision: Number(args['expected-revision']),
    review: {
      kind: args.kind, headSha: args['head-sha'], artifact: args.artifact, tier: args.tier,
      triggers: args.triggers ? JSON.parse(args.triggers) : [],
      priorArtifact: args['prior-artifact'],
    },
  });
  if (command === 'notify') {
    const result = notifyRecord({
      ...common, id: args.id, phase: args.phase, expectedRevision: Number(args['expected-revision']),
      decisionSequence: Number(args['decision-sequence']), channel: args.channel, detail: args.detail,
    });
    // A retry authorization re-arms exactly one attempt; the door that wrote it launches it.
    if (!result.replayed && args.phase === 'authorize-retry' && args['no-notifier'] !== 'true') {
      result.notifier = require('./notify').spawnNotifier({ root: args.root, recordId: args.id, sequence: Number(args['decision-sequence']) });
    }
    return result;
  }
  if (command === 'budget') return recordBudget({ ...common, id: args.id, expectedRevision: Number(args['expected-revision']), phase: args.phase, tokens: args.tokens !== undefined ? Number(args.tokens) : undefined, by: args.by, reason: args.reason, threshold: args.threshold !== undefined ? Number(args.threshold) : undefined });
  if (command === 'get') return getRecord({ root: args.root, id: args.id });
  if (command === 'shadow') return shadowProject({ root: args.root, rosterPath: args.roster, now: args.now, actor: args.actor, killPoint: args['kill-point'] });
  // command === 'project'
  return projectStatus({ root: args.root, tenant: args.tenant, now: args.now, output: args.output });
}

module.exports = {
  DECISION_EVENT_TYPES,
  DECISION_STATES,
  FLAGS,
  NOTIFICATION_PHASES,
  RESERVATION_FIELDS,
  STATES,
  TRANSITIONS,
  WorkStateError,
  abandonRecord,
  appendWakeOutbox,
  cli,
  createRecord,
  enteringEvent,
  getRecord,
  hasReservationEvidence,
  notifyRecord,
  observeRecord,
  outboxHasWake,
  parseArgs,
  proofFor,
  proofMatches,
  reservationDigest,
  projectStatus,
  readEvents,
  readTenantConfigs,
  reconcilePullRequest,
  recordBudget,
  recordReview,
  releaseRecord,
  reservationBaseline,
  reservationConflicts,
  reservationOverlaps,
  reservationValuesOverlap,
  reserveRecord,
  shadowProject,
  transitionRecord,
  sendBackCount,
  SEND_BACK_LIMIT,
};

// The CLI runs after the exports are set: bin/notify.js is required lazily from
// cli() and reads this module's exports while it is still the entry point.
if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message, currentRevision: error.currentRevision })}\n`);
    // A refused invocation exits 2 so a caller reading only the status cannot
    // take it for a failed mutation, let alone for an answer (fleet#2's rule);
    // every other error keeps exit 1 (STALE_REVISION, INVALID_TRANSITION,
    // NOT_FOUND...), which callers read as "the ledger said no", not "usage".
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}
