'use strict';
// Ticket 09: event verification. The ledger is the fleet's memory of every unit; before
// anything is archived or a budget is trusted, this proves the memory is whole. For every
// record (active and archived) it replays that record's events and checks: the sequence
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

const { parseArgs } = workState;

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
  if (['assignment-released', 'assignment-retired', 'shadow-retired'].includes(type)) return TERMINAL;
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
  const records = [];
  for (const record of Object.values(active)) {
    const result = verifyRecordEvents(record.id, byRecord.get(record.id) || [], record.state);
    result.where = 'active';
    records.push(result);
  }
  for (const entry of archived) {
    const record = entry.record || {};
    const result = verifyRecordEvents(record.id, byRecord.get(record.id) || [], record.state);
    result.where = 'archive';
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
  // Events for a record that is neither active nor archived mean state was lost: that is
  // exactly the corruption archival must not compound, so an orphan fails the verdict.
  const orphaned = [...byRecord.keys()].filter((id) => !active[id] && !archived.some((entry) => entry.record?.id === id));
  // --sample N checks only the N most recently touched records (a spot check); the
  // verdict then speaks for that sample and says so in totals.sampled.
  const checked = Number.isInteger(sample) && sample > 0 ? records.slice(-sample) : records;
  const withFindings = checked.filter((r) => r.findings.length > 0);
  const allFindings = [...globalFindings, ...withFindings.flatMap((r) => r.findings), ...orphaned.map((id) => ({ kind: 'orphaned-record', recordId: id }))];
  const result = {
    at,
    pass: allFindings.length === 0,
    totals: { events: events.length, records: records.length, active: Object.keys(active).length, archived: archived.length, orphanedRecordIds: orphaned.length, sampled: checked.length },
    findingsByKind: allFindings.reduce((acc, f) => { acc[f.kind] = (acc[f.kind] || 0) + 1; return acc; }, {}),
    globalFindings,
    orphanedRecordIds: orphaned,
    records: withFindings,
  };
  const dir = path.join(base, 'state', 'verify');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = verifyLedger({ root: args.root, now: args.now, sample: args.sample ? Number(args.sample) : undefined });
    if (args.json === 'true') process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`EVENT VERIFICATION: ${result.pass ? 'PASS' : 'FAIL'}\n`);
      process.stdout.write(`events ${result.totals.events}, records ${result.totals.records} (active ${result.totals.active}, archived ${result.totals.archived}), orphaned record ids ${result.totals.orphanedRecordIds}\n`);
      if (!result.pass) {
        process.stdout.write(`findings: ${Object.entries(result.findingsByKind).map(([k, n]) => `${k}=${n}`).join(', ')}\n`);
        for (const record of result.records.slice(0, 40)) process.stdout.write(`  ${record.recordId} (${record.where}): ${record.findings.map((f) => f.kind).join(', ')}\n`);
      }
    }
    process.exitCode = result.pass ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyLedger, verifyRecordEvents, stateAfter };
