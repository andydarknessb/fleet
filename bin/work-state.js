'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STATES = Object.freeze([
  'assigned', 'implementing', 'pr-open', 'ci-wait', 'review', 'revision',
  'hold', 'merged', 'retiring', 'retired', 'escalated',
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
});

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
    status: path.join(base, 'state', 'status'),
  };
}

function ensureLayout(root) {
  const p = paths(root);
  for (const directory of [p.state, p.work, p.pending, p.events, p.archive, p.status]) {
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

function archiveExpiredEvents(p, now) {
  const cutoff = new Date(isoNow(now)).getTime() - 30 * 24 * 60 * 60 * 1000;
  const archiveDir = path.join(p.events, 'archive');
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

function archiveRecord(p, record) {
  const events = eventLines(p).filter((event) => event.recordId === record.id);
  const eventFiles = [...new Set(events.flatMap((event) => {
    const name = `${String(event.at).slice(0, 10)}.jsonl`;
    const online = eventFile(p, event.at);
    const archived = path.join(p.events, 'archive', name);
    return [path.relative(p.base, online), path.relative(p.base, archived)];
  }))];
  writeAtomicJson(archiveFile(p, record.id), {
    schemaVersion: 1,
    archivedAt: record.updatedAt,
    record,
    eventFiles,
  });
  cleanupEphemeral(p, record);
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
    if (journal.archiveRecord) archiveRecord(p, journal.archiveRecord);
    fs.rmSync(journalPath, { force: true });
  }
}

function commitMutation(p, { recordId, beforeRecord, afterRecord, event, archiveRecord: recordToArchive = null, killPoint }) {
  const journalPath = pendingFile(p, recordId, event.idempotencyKey);
  writeAtomicJson(journalPath, { recordId, beforeRecord, afterRecord, event, archiveRecord: recordToArchive });
  if (killPoint === 'after-journal') throw new WorkStateError('KILL_POINT', 'stopped after journal write');
  const active = activeState(p);
  if (afterRecord === null) delete active.records[recordId];
  else active.records[recordId] = afterRecord;
  saveActive(p, active);
  if (killPoint === 'after-record') throw new WorkStateError('KILL_POINT', 'stopped after record replacement');
  appendEvent(p, event);
  if (killPoint === 'after-event') throw new WorkStateError('KILL_POINT', 'stopped after event append');
  if (recordToArchive) archiveRecord(p, recordToArchive);
  fs.rmSync(journalPath, { force: true });
  return afterRecord || recordToArchive;
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
    if (fs.existsSync(archiveFile(p, id))) throw new WorkStateError('RECORD_ARCHIVED', `record '${id}' is archived and cannot be reused`);
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
    record.idempotency[key] = { revision: 1, eventSequence: 1, type: 'assignment-reserved' };
    const event = eventFor(record, {
      type: 'assignment-reserved', actor: options.actor || 'assignment-planner', at: now,
      idempotencyKey: key, evidence: options.evidence,
      changes: { state: 'assigned', reservations: record.reservations },
    });
    commitMutation(p, { recordId: id, beforeRecord: null, afterRecord: record, event, killPoint: options.killPoint });
    return { replayed: false, revision: 1, eventSequence: 1, record };
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
    const now = isoNow(options.now);
    const next = { ...record, state: 'retired', revision: record.revision + 1, eventSequence: record.eventSequence + 1, updatedAt: now, idempotency: { ...record.idempotency } };
    next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: 'assignment-released' };
    const event = eventFor(next, {
      type: 'assignment-released', actor: options.actor || 'assignment-planner', at: now,
      idempotencyKey: key, evidence: options.evidence, changes: { from: 'assigned', to: 'retired' },
    });
    const resultRecord = commitMutation(p, { recordId: record.id, beforeRecord: record, afterRecord: null, archiveRecord: next, event, killPoint: options.killPoint });
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
    const now = isoNow(options.now);
    const record = baseRecord({ ...options, now });
    record.idempotency[key] = { revision: 1, eventSequence: 1, type: options.shadow ? 'shadow-projected' : 'work-created' };
    const event = eventFor(record, {
      type: options.shadow ? 'shadow-projected' : 'work-created',
      actor: options.actor,
      at: now,
      idempotencyKey: key,
      evidence: options.evidence,
      changes: { state: record.state },
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
      ? (options.githubRepo ? reconcilePullRequest({ repo: options.githubRepo, prNumber })
        : (options.testOnly ? (options.githubObservation || (options.githubState ? { state: options.githubState, mergedAt: options.githubMergedAt, evidence: options.githubEvidence } : null)) : null))
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
      changes: { from: record.state, to, prior_state: next.prior_state || null },
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

function getRecord(options = {}) {
  const root = asRoot(options.root);
  return withLock(root, (p) => {
    const active = activeState(p);
    const id = String(options.id);
    if (active.records[id]) return active.records[id];
    const archived = readJson(archiveFile(p, id));
    if (archived) return archived.record;
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
      if (record.evidence?.roster !== rosterEvidence || desired.has(record.id)) continue;
      const now = isoNow(options.now);
      const next = {
        ...record,
        state: 'retired',
        revision: record.revision + 1,
        eventSequence: record.eventSequence + 1,
        updatedAt: now,
        idempotency: { ...record.idempotency },
      };
      const key = `shadow-retired:${record.id}:${next.revision}`;
      next.idempotency[key] = { revision: next.revision, eventSequence: next.eventSequence, type: 'shadow-retired' };
      const event = eventFor(next, {
        type: 'shadow-retired', actor: options.actor || 'shadow-projector', at: now,
        idempotencyKey: key, evidence: { roster: rosterEvidence },
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
        idempotencyKey: key, evidence: record.evidence, changes: { state: record.state },
      });
      commitMutation(p, { recordId: id, beforeRecord: null, afterRecord: record, event, killPoint: options.killPoint });
      projected.push(record);
      active.records[id] = record;
    }
    return { projected };
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
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
  if (command === 'transition') return transitionRecord({
    ...common, id: args.id, to: args.to, expectedRevision: Number(args['expected-revision']), killPoint: args['kill-point'],
    prNumber: args['pr-number'] ? Number(args['pr-number']) : undefined, githubRepo: args.repo,
    githubState: args['github-state'], githubMergedAt: args['merged-at'], githubEvidence: args['github-evidence'],
  });
  if (command === 'reconcile') return reconcilePullRequest({ repo: args.repo, prNumber: Number(args['pr-number']) });
  if (command === 'get') return getRecord({ root: args.root, id: args.id });
  if (command === 'shadow') return shadowProject({ root: args.root, rosterPath: args.roster, now: args.now, actor: args.actor, killPoint: args['kill-point'] });
  if (command === 'project') return projectStatus({ root: args.root, tenant: args.tenant, now: args.now, output: args.output });
  throw new WorkStateError('USAGE', 'commands: create, reserve, release, transition, reconcile, get, shadow, project');
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message, currentRevision: error.currentRevision })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  RESERVATION_FIELDS,
  STATES,
  TRANSITIONS,
  WorkStateError,
  createRecord,
  getRecord,
  parseArgs,
  proofMatches,
  projectStatus,
  reconcilePullRequest,
  releaseRecord,
  reservationConflicts,
  reserveRecord,
  shadowProject,
  transitionRecord,
};
