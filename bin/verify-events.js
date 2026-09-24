'use strict';
// Ticket 09: event verification. The ledger is the fleet's memory of every unit; before
// anything is archived or a budget is trusted, this proves the memory is whole. For every
// record (active, archived, released, and abandoned) it replays that record's events and checks: the sequence
// is 1..n with no gap and no duplicate; timestamps never go backwards; every event's
// revision is monotonic; the state the events end in is the state the record claims; and
// every file an archived record's evidence index points at exists and actually holds that
// record's events. The verdict is written to state/verify/last.json, which the 30-day
// event archival consults before it moves anything (work-state.js archiveExpiredEvents):
// no verified ledger, no archival. Read-only apart from that verdict.

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');

const TERMINAL = 'retired';

// fleet#4: a typo'd flag must be refused, not silently ignored (the parity of this
// with a genuine FAIL verdict matters: both currently exit 2, so a caller reading only
// the status cannot yet tell a refused invocation from a real ledger finding - unlike
// parity.js/assignment-parity.js, this binary has no spare exit code carved out for it
// today, so it keeps exit 2 for both per the fleet#4 ruling; --json still tells them apart).
class VerifyEventsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VerifyEventsError';
    this.code = code;
    Object.assign(this, details);
  }
}

const VERIFY_EVENTS_FLAGS = ['root', 'now', 'sample', 'json'];

function baseOf(root) { return path.resolve(root || path.join(__dirname, '..')); }
function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
// Missing is one fact, unreadable is another: the verifier fails CLOSED on a file it
// cannot parse, because a verdict of "nothing to check" would open the archival gate.
function readJsonStrict(file) {
  if (!fs.existsSync(file)) return { value: null, missing: true };
  try { return { value: JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) }; } catch (error) { return { value: null, error: String(error.message) }; }
}

// The state an event moves its record into, or null when it is not a state change.
function stateAfter(event) {
  const type = String(event.type || '');
  if (type.startsWith('state-')) return type.slice('state-'.length);
  if (['assignment-reserved'].includes(type)) return event.changes?.state || 'assigned';
  if (['work-created', 'shadow-projected'].includes(type)) return event.changes?.state || null;
  if (type === 'assignment-released') return 'released';
  if (type === 'assignment-abandoned') return 'abandoned';
  if (['assignment-retired', 'shadow-retired'].includes(type)) return TERMINAL;
  if (type === 'shadow-retiring') return 'retiring';
  return null;
}

function verifyRecordEvents(recordId, events, claimedState) {
  const findings = [];
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const seen = new Set();
  let expected = 1;
  let lastMs = -Infinity;
  let lastRevision = 0;
  let state = null;
  for (const event of sorted) {
    if (seen.has(event.sequence)) findings.push({ kind: 'duplicate-sequence', sequence: event.sequence, type: event.type });
    seen.add(event.sequence);
    if (event.sequence !== expected) {
      if (event.sequence > expected) findings.push({ kind: 'sequence-gap', expected, found: event.sequence });
      expected = event.sequence;
    }
    expected += 1;
    const ms = Date.parse(event.at);
    if (Number.isNaN(ms)) findings.push({ kind: 'bad-timestamp', sequence: event.sequence, at: event.at });
    else if (ms < lastMs) findings.push({ kind: 'reordered', sequence: event.sequence, at: event.at, previous: new Date(lastMs).toISOString() });
    lastMs = Math.max(lastMs, Number.isNaN(ms) ? lastMs : ms);
    if (Number(event.revision) < lastRevision) findings.push({ kind: 'revision-regressed', sequence: event.sequence, revision: event.revision, previous: lastRevision });
    lastRevision = Math.max(lastRevision, Number(event.revision) || 0);
    const next = stateAfter(event);
    if (next) state = next;
  }
  if (sorted.length === 0) findings.push({ kind: 'no-events' });
  if (claimedState && state && state !== claimedState) findings.push({ kind: 'state-mismatch', reconstructed: state, claimed: claimedState });
  return { recordId, events: sorted.length, reconstructedState: state, claimedState, findings };
}

// #114 (ADR 0013): a Work record that reached `merged` must carry a formal
// `review-recorded` event for the head it merged at. Endzone #1241 and #1263
// merged on 2026-09-12 with no review on the record; the watcher saw it and
// the page reached nobody. The merged head is what pr-watch last observed on
// the record's PR (`github.observation.headSha`); a record merged before any
// observation carried a head has none, and then any formal review satisfies
// the invariant (there is nothing to compare, and no review at all is still a
// failure). Reviews recorded before fleet#67 sometimes named an abbreviated
// SHA, so two SHAs agree when the shorter (7+ characters) prefixes the longer.
function sameCommit(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  const length = Math.min(left.length, right.length);
  return length >= 7 && left.slice(0, length) === right.slice(0, length);
}

function mergedHeadOf(record) {
  // #114 review: the head reconciled at the merge itself (github.mergedHeadSha) is
  // authoritative; the last pr-watch observation is the fallback for older records.
  return record?.github?.mergedHeadSha || record?.github?.observation?.headSha || record?.github?.headSha || null;
}

// Acknowledged history (config/review-exceptions.json): `{recordId, head, ruling}`
// entries, each naming the Ruling that accepted the unreviewed merge. A listed
// record is reported as `merged-without-review-acknowledged` and does not fail
// the verdict, which is what keeps it archivable under ADR 0007. An entry with
// no ruling acknowledges nothing, and an unreadable file fails closed.
function loadReviewExceptions(base) {
  const read = readJsonStrict(path.join(base, 'config', 'review-exceptions.json'));
  const findings = [];
  if (read.error) return { entries: [], findings: [{ kind: 'review-exceptions-unreadable', detail: read.error }] };
  const listed = read.value && Array.isArray(read.value.exceptions) ? read.value.exceptions : [];
  const entries = [];
  for (const entry of listed) {
    const valid = entry && typeof entry.recordId === 'string' && typeof entry.head === 'string'
      && typeof entry.ruling === 'string' && entry.ruling.trim().length > 0;
    if (valid) entries.push(entry);
    else findings.push({ kind: 'review-exception-invalid', entry, detail: 'an exception names recordId, head and the ruling that accepted it' });
  }
  return { entries, findings };
}

function reviewFinding(record, events, exceptions) {
  if (!record || !events.some((event) => event.type === 'state-merged')) return null;
  const mergedHead = mergedHeadOf(record);
  const formalHeads = events
    .filter((event) => event.type === 'review-recorded' && event.changes?.kind === 'formal' && event.changes?.headSha)
    .map((event) => String(event.changes.headSha));
  const reviewed = mergedHead ? formalHeads.some((head) => sameCommit(head, mergedHead)) : formalHeads.length > 0;
  if (reviewed) return null;
  const exception = mergedHead && exceptions.find((entry) => entry.recordId === record.id && sameCommit(entry.head, mergedHead));
  if (exception) return { acknowledged: { kind: 'merged-without-review-acknowledged', recordId: record.id, mergedHead, ruling: exception.ruling } };
  return { finding: { kind: 'merged-without-review', mergedHead, formalHeads } };
}

function verifyLedger({ root, now, sample } = {}) {
  const base = baseOf(root);
  const at = now || new Date().toISOString();
  const events = workState.readEvents(base);
  const byRecord = new Map();
  for (const event of events) {
    if (!byRecord.has(event.recordId)) byRecord.set(event.recordId, []);
    byRecord.get(event.recordId).push(event);
  }
  const globalFindings = [];
  const activeRead = readJsonStrict(path.join(base, 'state', 'work', 'active.json'));
  if (activeRead.error) globalFindings.push({ kind: 'active-state-unreadable', detail: activeRead.error });
  const active = (activeRead.value && activeRead.value.records) || {};
  const archiveDir = path.join(base, 'state', 'archive');
  const archived = [];
  if (fs.existsSync(archiveDir)) {
    for (const name of fs.readdirSync(archiveDir).filter((entry) => /^work-.*\.json$/.test(entry))) {
      const read = readJsonStrict(path.join(archiveDir, name));
      if (read.error) { globalFindings.push({ kind: 'archive-entry-unreadable', file: name, detail: read.error }); continue; }
      archived.push({ file: path.join(archiveDir, name), ...read.value });
    }
  }
  const releaseDir = path.join(base, 'state', 'releases');
  const released = [];
  if (fs.existsSync(releaseDir)) {
    for (const name of fs.readdirSync(releaseDir).filter((entry) => /^work-.*\.json$/.test(entry))) {
      const read = readJsonStrict(path.join(releaseDir, name));
      if (read.error) { globalFindings.push({ kind: 'release-entry-unreadable', file: name, detail: read.error }); continue; }
      released.push({ file: path.join(releaseDir, name), ...read.value });
    }
  }
  const abandonDir = path.join(base, 'state', 'abandons');
  const abandoned = [];
  if (fs.existsSync(abandonDir)) {
    for (const name of fs.readdirSync(abandonDir).filter((entry) => /^work-.*\.json$/.test(entry))) {
      const read = readJsonStrict(path.join(abandonDir, name));
      if (read.error) { globalFindings.push({ kind: 'abandon-entry-unreadable', file: name, detail: read.error }); continue; }
      abandoned.push({ file: path.join(abandonDir, name), ...read.value });
    }
  }
  const exceptions = loadReviewExceptions(base);
  globalFindings.push(...exceptions.findings);
  const acknowledged = [];
  const checkReview = (result, record) => {
    const outcome = reviewFinding(record, byRecord.get(record.id) || [], exceptions.entries);
    if (outcome?.finding) result.findings.push(outcome.finding);
    if (outcome?.acknowledged) acknowledged.push({ ...outcome.acknowledged, where: result.where });
  };
  const records = [];
  for (const record of Object.values(active)) {
    const result = verifyRecordEvents(record.id, byRecord.get(record.id) || [], record.state);
    result.where = 'active';
    checkReview(result, record);
    records.push(result);
  }
  for (const entry of archived) {
    const record = entry.record || {};
    const result = verifyRecordEvents(record.id, byRecord.get(record.id) || [], record.state);
    result.where = 'archive';
    checkReview(result, record);
    // The evidence index: every listed file must exist and contain this record's events.
    const listed = Array.isArray(entry.eventFiles) ? entry.eventFiles : [];
    if (listed.length === 0) result.findings.push({ kind: 'evidence-index-empty' });
    const present = listed.map((relative) => path.join(base, relative)).filter((file) => fs.existsSync(file));
    if (present.length === 0 && listed.length > 0) result.findings.push({ kind: 'evidence-files-missing', listed });
    const holds = present.some((file) => fs.readFileSync(file, 'utf8').includes(`"recordId":"${record.id}"`));
    if (present.length > 0 && !holds) result.findings.push({ kind: 'evidence-files-do-not-hold-record', files: present.map((f) => path.relative(base, f)) });
    if (record.state !== TERMINAL) result.findings.push({ kind: 'archived-not-retired', state: record.state });
    records.push(result);
  }
  for (const entry of released) {
    const record = entry.record || {};
    const result = verifyRecordEvents(record.id, byRecord.get(record.id) || [], record.state);
    result.where = 'release';
    checkReview(result, record);
    const listed = Array.isArray(entry.eventFiles) ? entry.eventFiles : [];
    if (listed.length === 0) result.findings.push({ kind: 'evidence-index-empty' });
    const present = listed.map((relative) => path.join(base, relative)).filter((file) => fs.existsSync(file));
    if (present.length === 0 && listed.length > 0) result.findings.push({ kind: 'evidence-files-missing', listed });
    const holds = present.some((file) => fs.readFileSync(file, 'utf8').includes(`"recordId":"${record.id}"`));
    if (present.length > 0 && !holds) result.findings.push({ kind: 'evidence-files-do-not-hold-record', files: present.map((f) => path.relative(base, f)) });
    if (record.state !== 'released') result.findings.push({ kind: 'release-not-released', state: record.state });
    records.push(result);
  }
  for (const entry of abandoned) {
    const record = entry.record || {};
    const result = verifyRecordEvents(record.id, byRecord.get(record.id) || [], record.state);
    result.where = 'abandonment';
    checkReview(result, record);
    const listed = Array.isArray(entry.eventFiles) ? entry.eventFiles : [];
    if (listed.length === 0) result.findings.push({ kind: 'evidence-index-empty' });
    const present = listed.map((relative) => path.join(base, relative)).filter((file) => fs.existsSync(file));
    if (present.length === 0 && listed.length > 0) result.findings.push({ kind: 'evidence-files-missing', listed });
    const holds = present.some((file) => fs.readFileSync(file, 'utf8').includes(`"recordId":"${record.id}"`));
    if (present.length > 0 && !holds) result.findings.push({ kind: 'evidence-files-do-not-hold-record', files: present.map((f) => path.relative(base, f)) });
    if (record.state !== 'abandoned') result.findings.push({ kind: 'abandon-not-abandoned', state: record.state });
    records.push(result);
  }
  // Events for a record that is neither active nor archived mean state was lost: that is
  // exactly the corruption archival must not compound, so an orphan fails the verdict.
  const orphaned = [...byRecord.keys()].filter((id) => !active[id] && !archived.some((entry) => entry.record?.id === id) && !released.some((entry) => entry.record?.id === id) && !abandoned.some((entry) => entry.record?.id === id));
  // --sample N checks only the N most recently touched records (a spot check); the
  // verdict then speaks for that sample and says so in totals.sampled.
  const checked = Number.isInteger(sample) && sample > 0 ? records.slice(-sample) : records;
  const withFindings = checked.filter((r) => r.findings.length > 0);
  const allFindings = [...globalFindings, ...withFindings.flatMap((r) => r.findings), ...orphaned.map((id) => ({ kind: 'orphaned-record', recordId: id }))];
  const result = {
    at,
    pass: allFindings.length === 0,
    totals: { events: events.length, records: records.length, active: Object.keys(active).length, archived: archived.length, released: released.length, abandoned: abandoned.length, orphanedRecordIds: orphaned.length, sampled: checked.length },
    findingsByKind: allFindings.reduce((acc, f) => { acc[f.kind] = (acc[f.kind] || 0) + 1; return acc; }, {}),
    globalFindings,
    orphanedRecordIds: orphaned,
    // #114: reported, never failing: each names the ruling that accepted it.
    acknowledged,
    records: withFindings,
  };
  const dir = path.join(base, 'state', 'verify');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, VERIFY_EVENTS_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new VerifyEventsError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  const result = verifyLedger({ root: args.root, now: args.now, sample: args.sample ? Number(args.sample) : undefined });
  return { result, json: args.json === 'true' };
}

if (require.main === module) {
  try {
    const { result, json } = cli(process.argv.slice(2));
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`EVENT VERIFICATION: ${result.pass ? 'PASS' : 'FAIL'}\n`);
      process.stdout.write(`events ${result.totals.events}, records ${result.totals.records} (active ${result.totals.active}, archived ${result.totals.archived}, released ${result.totals.released}, abandoned ${result.totals.abandoned}), orphaned record ids ${result.totals.orphanedRecordIds}\n`);
      for (const entry of result.acknowledged || []) process.stdout.write(`acknowledged: ${entry.recordId} ${entry.kind} at ${String(entry.mergedHead).slice(0, 12)} (${entry.ruling})\n`);
      if (!result.pass) {
        process.stdout.write(`findings: ${Object.entries(result.findingsByKind).map(([k, n]) => `${k}=${n}`).join(', ')}\n`);
        for (const record of result.records.slice(0, 40)) process.stdout.write(`  ${record.recordId} (${record.where}): ${record.findings.map((f) => f.kind).join(', ')}\n`);
      }
    }
    process.exitCode = result.pass ? 0 : 2;
  } catch (error) {
    if (error.code === 'USAGE') {
      // fleet#4: this binary exits 2 for a genuine FAIL verdict ("exit 2 on findings"),
      // so a refused (typo) invocation must not share it - EX_USAGE (64) keeps a typo
      // and a real ledger finding distinguishable by status alone, the same carve-out
      // parity.js and assignment-parity.js make.
      process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
      process.exitCode = 64;
    } else {
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { reviewFinding, sameCommit, verifyLedger, verifyRecordEvents, stateAfter, cli, VERIFY_EVENTS_FLAGS, VerifyEventsError };
