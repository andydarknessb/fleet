'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STATES = Object.freeze([
  'assigned', 'implementing', 'pr-open', 'ci-wait', 'review', 'revision',
  'hold', 'merged', 'retiring', 'retired', 'released', 'escalated',
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
  escalated: STATES.filter((state) => state !== 'escalated'),
  retired: [],
  released: [],
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
    status: path.join(base, 'state', 'status'),
  };
}

function ensureLayout(root) {
  const p = paths(root);
  for (const directory of [p.state, p.work, p.pending, p.events, p.archive, p.releases, p.status]) {
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

function preserveReusableSnapshot(p, reusable) {
  if (!reusable) return;
  const source = reusable.kind === 'legacy-archive' ? archiveFile(p, reusable.record.id) : releaseFile(p, reusable.record.id);
  const destination = releaseHistoryFile(p, reusable.record);
  if (!fs.existsSync(source)) {
    if (fs.existsSync(destination)) return;
    throw new WorkStateError('RELEASE_SNAPSHOT_MISSING', `reusable release snapshot for '${reusable.record.id}' disappeared`);
  }
  if (fs.existsSync(destination)) throw new WorkStateError('RELEASE_HISTORY_EXISTS', `release history already exists for '${reusable.record.id}' sequence ${reusable.record.eventSequence}`);
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
    if (journal.archiveRecord) archiveRecord(p, journal.archiveRecord);
    fs.rmSync(journalPath, { force: true });
  }
}

function commitMutation(p, { recordId, beforeRecord, afterRecord, event, archiveRecord: recordToArchive = null, releasedRecord = null, supersedeReusable = null, killPoint }) {
  const journalPath = pendingFile(p, recordId, event.idempotencyKey);
  writeAtomicJson(journalPath, { recordId, beforeRecord, afterRecord, event, archiveRecord: recordToArchive, releasedRecord, supersedeReusable });
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
  if (recordToArchive) archiveRecord(p, recordToArchive);
  fs.rmSync(journalPath, { force: true });
  return afterRecord || releasedRecord || recordToArchive;
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
  const allowed = ['issueNumber', 'prNumber', 'issueUrl', 'prUrl', 'baseSha', 'bodyHash', 'headSha', 'lastObservedState', 'mergedAt', 'evidence'];
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

function reservationConflicts(records, reservations, ignoreRecordId = null) {
  const requested = reservations || {};
  const conflicts = [];
  for (const record of Object.values(records)) {
    if (record.id === ignoreRecordId) continue;
    for (const field of RESERVATION_FIELDS) {
      const values = new Set((record.reservations?.[field] || []).map(String));
      for (const value of (requested[field] || []).map(String)) {
        if (values.has(value)) conflicts.push({ recordId: record.id, issue: record.issue, field, value });
      }
    }
  }
  return conflicts;
}

function proofMatches(expected, supplied) {
  return Boolean(supplied?.independent)
    && JSON.stringify([...(supplied.candidates || [])].map(Number).sort((a, b) => a - b)) === JSON.stringify([...expected.candidates].map(Number).sort((a, b) => a - b))
    && JSON.stringify([...(supplied.checkedFields || [])].map(String).sort()) === JSON.stringify([...expected.checkedFields].map(String).sort())
    && !(supplied.conflicts || []).length;
}

function reservationBaseline(options = {}) {
  const root = asRoot(options.root);
  return withLock(root, (p) => {
    const id = String(options.id);
    const active = activeState(p);
    if (active.records[id]) throw new WorkStateError('RECORD_EXISTS', `record '${id}' already exists`);
    const reusable = reusableReleasedRecord(p, id);
    if (fs.existsSync(archiveFile(p, id)) && !reusable) throw new WorkStateError('RECORD_ARCHIVED', `record '${id}' is terminally archived and cannot be reused`);
    if (fs.existsSync(releaseFile(p, id)) && !reusable) throw new WorkStateError('RELEASE_NOT_REUSABLE', `released record '${id}' does not prove an untouched reservation`);
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
    const reusable = reusableReleasedRecord(p, id);
    if (fs.existsSync(archiveFile(p, id)) && !reusable) throw new WorkStateError('RECORD_ARCHIVED', `record '${id}' is terminally archived and cannot be reused`);
    if (fs.existsSync(releaseFile(p, id)) && !reusable) throw new WorkStateError('RELEASE_NOT_REUSABLE', `released record '${id}' does not prove an untouched reservation`);
    const activeAssignments = Object.values(active.records).filter((record) => record.manifestPath && record.state !== 'retired');
    const expectedProof = {
      independent: true,
      candidates: [...activeAssignments.map((record) => Number(record.issue)), Number(options.issue)],
      checkedFields: [...RESERVATION_FIELDS],
      conflicts: [],
    };
    if (activeAssignments.length >= 3 || (activeAssignments.length >= 2 && !proofMatches(expectedProof, options.independenceProof))) {
      throw new WorkStateError('THIRD_ASSIGNMENT_REQUIRES_PROOF', 'a third assignment requires an independent machine-readable proof');
    }
    const conflicts = reservationConflicts(active.records, options.reservations);
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

function validateTransition(record, to, options) {
  if (!STATES.includes(to)) throw new WorkStateError('INVALID_STATE', `unknown state '${to}'`);
  const allowed = TRANSITIONS[record.state] || [];
  const fromEscalated = record.state === 'escalated';
  if (!allowed.includes(to)) throw new WorkStateError('INVALID_TRANSITION', `${record.state} -> ${to} is not allowed`);
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
    const replay = replayIfKnown(record, key);
    if (replay) return replay;
    if (!Number.isInteger(Number(options.expectedRevision))) throw new WorkStateError('MISSING_REVISION', 'expected revision is required');
    if (Number(options.expectedRevision) !== record.revision) {
      throw new WorkStateError('STALE_REVISION', `expected revision ${options.expectedRevision}, current revision ${record.revision}`, { currentRevision: record.revision });
    }
    const to = String(options.to || '');
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
    if (githubObservation) next.github = { ...next.github, lastObservedState: githubObservation.state, mergedAt: githubObservation.mergedAt, evidence: githubObservation.evidence || options.evidence };
    if (to === 'escalated') {
      next.prior_state = record.state;
      next.decisionEvidence = options.evidence;
    } else if (record.state === 'escalated') {
      next.prior_state = null;
      next.decisionEvidence = null;
      next.resolutionEvidence = options.evidence;
    }
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: `transition:${record.state}->${to}` };
    const event = eventFor(next, {
      type: `state-${to}`,
      actor: options.actor,
      at: now,
      idempotencyKey: key,
      evidence: options.evidence,
      changes: { from: record.state, to, prior_state: next.prior_state || null, prNumber: next.github?.prNumber || null },
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
    return { replayed: false, revision: next.revision, eventSequence: next.eventSequence, record: resultRecord };
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
    throw new WorkStateError('NOT_FOUND', `record '${id}' was not found`);
  });
}

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
    const records = Object.values(active.records)
      .filter((record) => !tenant || record.tenant === tenant)
      .sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue);
    const events = eventLines(p)
      .filter((event) => !tenant || tenantsByRecord.get(event.recordId) === tenant)
      .slice(-20);
    const canonicalTimes = [...records.map((record) => record.updatedAt), ...events.map((event) => event.at)]
      .filter(Boolean).sort();
    const generatedAt = isoNow(options.now || canonicalTimes[canonicalTimes.length - 1] || '1970-01-01T00:00:00.000Z');
    const lines = [`# Fleet status`, '', `generated: ${generatedAt}`, '', '## Active work', ''];
    if (records.length === 0) lines.push('None.');
    else for (const record of records) lines.push(`- ${record.tenant} #${record.issue} - ${record.state} - revision ${record.revision} - ${record.owner?.session || record.owner?.name || 'unassigned'}`);
    lines.push('', '## Recent events', '');
    if (events.length === 0) lines.push('None.');
    else for (const event of events) lines.push(`- ${event.at} - ${event.recordId} - ${event.type} - seq ${event.sequence}`);
    const output = options.output || path.join(p.status, tenant ? `${tenant}.md` : 'STATUS.md');
    writeAtomicText(output, `${lines.join('\n')}\n`);
    return { output, content: `${lines.join('\n')}\n` };
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

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') { args._ = argv.slice(i + 1); break; }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function cli(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const common = { root: args.root, now: args.now, actor: args.actor, evidence: args.evidence, idempotencyKey: args['idempotency-key'] };
  if (command === 'create') return createRecord({ ...common, id: args.id, tenant: args.tenant, issue: Number(args.issue), state: args.state || 'assigned', github: args['pr-number'] ? { issueNumber: Number(args.issue), prNumber: Number(args['pr-number']) } : undefined });
  if (command === 'reserve') return reserveRecord({
    ...common, id: args.id, tenant: args.tenant, issue: Number(args.issue), manifestPath: args.manifest,
    reservations: JSON.parse(args.reservations || '{}'), assignment: args.assignment ? JSON.parse(args.assignment) : undefined,
    independenceProof: args['independence-proof'] ? JSON.parse(args['independence-proof']) : undefined,
    github: args['issue-url'] ? { issueNumber: Number(args.issue), issueUrl: args['issue-url'], bodyHash: args['body-hash'] } : undefined,
  });
  if (command === 'release') return releaseRecord({ ...common, id: args.id, expectedRevision: Number(args['expected-revision']) });
  if (command === 'transition') {
    const result = transitionRecord({
      ...common, id: args.id, to: args.to, expectedRevision: Number(args['expected-revision']), killPoint: args['kill-point'],
      prNumber: args['pr-number'] ? Number(args['pr-number']) : undefined, githubRepo: args.repo,
      githubState: args['github-state'], githubMergedAt: args['merged-at'], githubEvidence: args['github-evidence'],
    });
    // Ticket 07: a decision event launches its notifier from the door that wrote it
    // (the watcher does the same for its own); a replay wrote nothing, so it launches nothing.
    if (!result.replayed && DECISION_EVENT_TYPES.includes(`state-${args.to}`) && args['no-notifier'] !== 'true') {
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
  if (command === 'project') return projectStatus({ root: args.root, tenant: args.tenant, now: args.now, output: args.output });
  throw new WorkStateError('USAGE', 'commands: create, reserve, release, transition, reconcile, observe, review, notify, get, shadow, project');
}

module.exports = {
  DECISION_EVENT_TYPES,
  DECISION_STATES,
  NOTIFICATION_PHASES,
  RESERVATION_FIELDS,
  STATES,
  TRANSITIONS,
  WorkStateError,
  createRecord,
  enteringEvent,
  getRecord,
  notifyRecord,
  observeRecord,
  parseArgs,
  proofMatches,
  projectStatus,
  readEvents,
  readTenantConfigs,
  reconcilePullRequest,
  recordBudget,
  recordReview,
  releaseRecord,
  reservationBaseline,
  reservationConflicts,
  reserveRecord,
  shadowProject,
  transitionRecord,
};

// The CLI runs after the exports are set: bin/notify.js is required lazily from
// cli() and reads this module's exports while it is still the entry point.
if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message, currentRevision: error.currentRevision })}\n`);
    process.exitCode = 1;
  }
}
