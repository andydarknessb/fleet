'use strict';
// Ticket 09: the ledger verifier proves the event log is whole before archival trusts it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyLedger, verifyRecordEvents, stateAfter, cli, VERIFY_EVENTS_FLAGS, VerifyEventsError } = require('../bin/verify-events');
const { createRecord, releaseRecord, reserveRecord, transitionRecord, readEvents } = require('../bin/work-state');

function rootDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-verify-')); }
function unit(root, issue, chain = []) {
  const id = `endzone:issue-${issue}`;
  createRecord({ root, id, tenant: 'endzone', issue, state: 'implementing', idempotencyKey: `c-${issue}`, now: '2026-09-09T00:00:00.000Z' });
  let revision = 1;
  for (const to of chain) {
    transitionRecord({ root, id, expectedRevision: revision, to, idempotencyKey: `t-${issue}-${to}`, now: `2026-09-09T00:0${revision}:00.000Z`, prNumber: 500 + issue, githubState: 'MERGED', githubMergedAt: '2026-09-09T00:05:00.000Z', testOnly: true });
    revision += 1;
  }
  return id;
}
function eventFile(root) { return path.join(root, 'state', 'events', '2026-09-09.jsonl'); }
function rewriteEvents(root, mutate) {
  const lines = fs.readFileSync(eventFile(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  fs.writeFileSync(eventFile(root), `${mutate(lines).map((l) => JSON.stringify(l)).join('\n')}\n`);
}

test('stateAfter reads a state change from every event shape that makes one', () => {
  assert.equal(stateAfter({ type: 'state-review' }), 'review');
  assert.equal(stateAfter({ type: 'assignment-reserved', changes: { state: 'assigned' } }), 'assigned');
  assert.equal(stateAfter({ type: 'shadow-projected', changes: { state: 'implementing' } }), 'implementing');
  assert.equal(stateAfter({ type: 'shadow-retired' }), 'retired');
  assert.equal(stateAfter({ type: 'assignment-retired' }), 'retired');
  assert.equal(stateAfter({ type: 'assignment-released' }), 'released');
  assert.equal(stateAfter({ type: 'pr-observed' }), null);
  assert.equal(stateAfter({ type: 'budget-warning' }), null);
});

test('a released untouched reservation is verified separately from terminal archives', () => {
  const root = rootDir();
  reserveRecord({ root, id: 'endzone:issue-18', tenant: 'endzone', issue: 18, idempotencyKey: 'reserve-18', now: '2026-09-09T00:00:00.000Z' });
  releaseRecord({ root, id: 'endzone:issue-18', expectedRevision: 1, idempotencyKey: 'release-18', now: '2026-09-09T00:01:00.000Z' });
  const result = verifyLedger({ root });
  assert.equal(result.pass, true);
  assert.equal(result.totals.released, 1);
  assert.equal(result.totals.archived, 0);
  assert.equal(result.totals.orphanedRecordIds, 0);
});

test('a clean ledger with active and archived records passes and reconstructs every state', () => {
  const root = rootDir();
  unit(root, 1, ['pr-open', 'review']);
  unit(root, 2, ['pr-open', 'review', 'merged', 'retiring', 'retired']);
  const result = verifyLedger({ root, now: '2026-09-09T02:00:00.000Z' });
  assert.equal(result.pass, true, JSON.stringify(result.records));
  assert.equal(result.totals.active, 1);
  assert.equal(result.totals.archived, 1);
  assert.equal(result.totals.orphanedRecordIds, 0);
  assert.equal(result.records.length, 0, 'no record carries a finding');
  const verdict = JSON.parse(fs.readFileSync(path.join(root, 'state', 'verify', 'last.json'), 'utf8'));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.at, '2026-09-09T02:00:00.000Z');
});

test('a sequence gap, a duplicate, a reorder and a state mismatch are each found by kind', () => {
  const root = rootDir();
  const id = unit(root, 3, ['pr-open', 'review']);
  rewriteEvents(root, (lines) => lines.filter((l) => !(l.recordId === id && l.sequence === 2)));
  const gap = verifyLedger({ root });
  assert.equal(gap.pass, false);
  assert.equal(gap.findingsByKind['sequence-gap'], 1);

  const root2 = rootDir();
  const id2 = unit(root2, 4, ['pr-open']);
  rewriteEvents(root2, (lines) => [...lines, { ...lines.find((l) => l.recordId === id2 && l.sequence === 2) }]);
  const dup = verifyLedger({ root: root2 });
  assert.equal(dup.findingsByKind['duplicate-sequence'], 1);

  const root3 = rootDir();
  const id3 = unit(root3, 5, ['pr-open']);
  rewriteEvents(root3, (lines) => lines.map((l) => (l.recordId === id3 && l.sequence === 2 ? { ...l, at: '2026-09-08T00:00:00.000Z' } : l)));
  const reordered = verifyLedger({ root: root3 });
  assert.equal(reordered.findingsByKind.reordered, 1);

  const root4 = rootDir();
  const id4 = unit(root4, 6, ['pr-open']);
  const active = JSON.parse(fs.readFileSync(path.join(root4, 'state', 'work', 'active.json'), 'utf8'));
  active.records[id4].state = 'review';
  fs.writeFileSync(path.join(root4, 'state', 'work', 'active.json'), JSON.stringify(active));
  const mismatch = verifyLedger({ root: root4 });
  assert.equal(mismatch.findingsByKind['state-mismatch'], 1);
  assert.equal(mismatch.records[0].reconstructedState, 'pr-open');
});

test('an archived record whose evidence index points at a missing file fails', () => {
  const root = rootDir();
  const id = unit(root, 7, ['pr-open', 'review', 'merged', 'retiring', 'retired']);
  const archive = path.join(root, 'state', 'archive', 'work-endzone_issue-7.json');
  const entry = JSON.parse(fs.readFileSync(archive, 'utf8'));
  entry.eventFiles = ['state/events/1999-01-01.jsonl'];
  fs.writeFileSync(archive, JSON.stringify(entry));
  const result = verifyLedger({ root });
  assert.equal(result.pass, false);
  assert.equal(result.findingsByKind['evidence-files-missing'], 1);
  assert.equal(result.records[0].recordId, id);
});

test('events for a record that is neither active nor archived are reported as orphaned', () => {
  const root = rootDir();
  unit(root, 8, ['pr-open']);
  fs.appendFileSync(eventFile(root), `${JSON.stringify({ schemaVersion: 1, recordId: 'endzone:issue-999', sequence: 1, revision: 1, type: 'work-created', actor: 'x', at: '2026-09-09T00:00:00.000Z', changes: { state: 'implementing' } })}\n`);
  const result = verifyLedger({ root });
  assert.deepEqual(result.orphanedRecordIds, ['endzone:issue-999']);
  assert.equal(result.pass, false, 'lost state fails the verdict; archival must not compound it');
  assert.equal(result.findingsByKind['orphaned-record'], 1);
});

test('an unreadable active state fails closed instead of verifying nothing', () => {
  const root = rootDir();
  unit(root, 14, ['pr-open']);
  fs.writeFileSync(path.join(root, 'state', 'work', 'active.json'), '{ torn');
  const result = verifyLedger({ root });
  assert.equal(result.pass, false);
  assert.equal(result.findingsByKind['active-state-unreadable'], 1);
  const bom = rootDir();
  unit(bom, 15, ['pr-open']);
  const p = path.join(bom, 'state', 'work', 'active.json');
  fs.writeFileSync(p, `\uFEFF${fs.readFileSync(p, 'utf8')}`);
  assert.equal(verifyLedger({ root: bom }).pass, true, 'a BOM is tolerated');
});

test('--sample checks only the most recent records and says so', () => {
  const root = rootDir();
  const first = unit(root, 16, ['pr-open']);
  unit(root, 17, ['pr-open']);
  rewriteEvents(root, (lines) => lines.filter((l) => !(l.recordId === first && l.sequence === 2)));
  assert.equal(verifyLedger({ root }).pass, false, 'the full check sees the gap');
  const sampled = verifyLedger({ root, sample: 1 });
  assert.equal(sampled.totals.sampled, 1);
  assert.equal(sampled.pass, true, 'the sample of one (the newest record) is clean');
});

test('the 30-day archival moves nothing until a fresh passing verdict exists', () => {
  const root = rootDir();
  unit(root, 9, ['pr-open']);
  const old = path.join(root, 'state', 'events', '2026-07-01.jsonl');
  fs.writeFileSync(old, `${JSON.stringify({ schemaVersion: 1, recordId: 'endzone:issue-9', sequence: 99, revision: 99, type: 'pr-observed', actor: 'x', at: '2026-07-01T00:00:00.000Z' })}\n`);
  createRecord({ root, id: 'endzone:issue-10', tenant: 'endzone', issue: 10, state: 'implementing', idempotencyKey: 'c-10', now: '2026-09-09T00:00:00.000Z' });
  assert.equal(fs.existsSync(old), true, 'no verdict: the old file stays online');
  fs.mkdirSync(path.join(root, 'state', 'verify'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'verify', 'last.json'), JSON.stringify({ pass: false, at: '2026-09-09T03:00:00.000Z' }));
  createRecord({ root, id: 'endzone:issue-11', tenant: 'endzone', issue: 11, state: 'implementing', idempotencyKey: 'c-11', now: '2026-09-09T00:00:00.000Z' });
  assert.equal(fs.existsSync(old), true, 'a failing verdict: the old file stays online');
  fs.writeFileSync(path.join(root, 'state', 'verify', 'last.json'), JSON.stringify({ pass: true, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
  createRecord({ root, id: 'endzone:issue-12', tenant: 'endzone', issue: 12, state: 'implementing', idempotencyKey: 'c-12', now: '2026-09-09T00:00:00.000Z' });
  assert.equal(fs.existsSync(old), true, 'a verdict older than the newest event write: stays online');
  fs.writeFileSync(path.join(root, 'state', 'verify', 'last.json'), JSON.stringify({ pass: true, at: new Date(Date.now() + 60 * 1000).toISOString() }));
  createRecord({ root, id: 'endzone:issue-13', tenant: 'endzone', issue: 13, state: 'implementing', idempotencyKey: 'c-13', now: '2026-09-09T00:00:00.000Z' });
  assert.equal(fs.existsSync(old), false, 'a fresh passing verdict: the 30-day-old file is archived');
  assert.equal(fs.existsSync(path.join(root, 'state', 'events', 'archive', '2026-07-01.jsonl')), true);
  assert.equal(readEvents(root).some((e) => e.sequence === 99), true, 'archived events are still read');
});

// --- fleet#4: adopt the parseArgs flag schema ---------------------------------------
// Red-tell: with bin/verify-events.js reverted to its old hand-rolled parseArgs (no
// schema), --samples is silently ignored instead of throwing.

test('cli: refuses --samples (confusable with --sample) as an unknown flag, naming the accepted set', () => {
  const root = rootDir();
  assert.throws(() => cli(['--root', root, '--samples', '1']), (error) => {
    assert.ok(error instanceof VerifyEventsError, `expected VerifyEventsError, got ${error && error.name}`);
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /unknown flag --samples\b/);
    for (const flag of VERIFY_EVENTS_FLAGS) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('cli: a correct invocation still works, matching the direct call', () => {
  const root = rootDir();
  unit(root, 20, ['pr-open']);
  const now = '2026-09-09T05:00:00.000Z';
  const { result, json } = cli(['--root', root, '--now', now, '--json', 'true']);
  assert.equal(json, true);
  assert.deepEqual(result, verifyLedger({ root, now }));
});

test('verify-events: a refused invocation exits 64 (EX_USAGE), never the FAIL verdict status 2', () => {
  const { spawnSync } = require('node:child_process');
  const bin = path.join(__dirname, '..', 'bin', 'verify-events.js');
  const typo = spawnSync(process.execPath, [bin, '--root-dir', os.tmpdir()], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 64);
  assert.equal(typo.stdout, '');
  assert.equal(JSON.parse(typo.stderr).code, 'USAGE');
});
