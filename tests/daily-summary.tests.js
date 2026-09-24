'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { formatAge, buildSummary, runDailySummary, waitingRows, cli, exitCodeFor, DAILY_SUMMARY_FLAGS, DailySummaryError } = require('../bin/daily-summary');
const workState = require('../bin/work-state');

function rootDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-daily-summary-'));
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'owner/repo', readyLabel: 'ready-for-agent', defaultBranch: 'integration', releaseBranch: 'main' }));
  return root;
}

// work-state.js's event ledger is partitioned by day (`state/events/<date>.jsonl`)
// and read back in filename (date) order, then append order within a file - not
// insertion order across files. So one record's own event timestamps must be
// non-decreasing, or a later hop dated on an earlier calendar day would be
// folded BEFORE an earlier hop dated later, and the fold would land on the
// wrong state. Every hop here is anchored to `enteredAt` itself (minutes
// earlier, one per hop before the last) so a chain always increases in step
// with real time, however far back `enteredAt` is from `NOW`.
function minutesBefore(iso, minutes) { return new Date(new Date(iso).getTime() - minutes * 60000).toISOString(); }

// Walks a fresh record to a decision state (escalated or hold). Only the LAST
// hop's `now` reaches `enteredStateAt` in the fold (every earlier state- event
// is overwritten by the next), so `enteredAt` pins exactly the timestamp the
// summary ages against; the hops before it just need to be legal and ordered.
function seedDecision(root, { issue, to = 'escalated', enteredAt, tenant = 'endzone' } = {}) {
  const id = `${tenant}:issue-${issue}`;
  const hops = to === 'hold' ? ['pr-open', 'ci-wait', 'review', 'hold'] : ['pr-open', 'ci-wait', 'escalated'];
  workState.createRecord({
    root, id, tenant, issue, state: 'implementing',
    github: { issueNumber: issue, prNumber: issue + 1000 },
    actor: 'test', idempotencyKey: `c-${issue}`, now: minutesBefore(enteredAt, hops.length + 1),
  });
  let revision = 1;
  let last = null;
  hops.forEach((state, index) => {
    const isLast = index === hops.length - 1;
    const evidence = (state === 'escalated' || state === 'hold') ? `wake:decision-needed; #${issue} needs a call` : `to ${state}`;
    last = workState.transitionRecord({
      root, id, to: state, expectedRevision: revision, idempotencyKey: `t-${issue}-${state}`,
      actor: 'pr-watch', evidence, now: isLast ? enteredAt : minutesBefore(enteredAt, hops.length - index),
    });
    revision = last.revision;
  });
  return { id, revision };
}

function sender() {
  const calls = [];
  const send = (message) => { calls.push(message); return { ok: true, detail: 'pushover delivered' }; };
  send.calls = calls;
  return send;
}

const NOW = '2026-09-17T20:00:00.000Z';
function hoursAgo(hours) { return new Date(new Date(NOW).getTime() - hours * 3600 * 1000).toISOString(); }
function minutesAgo(minutes) { return new Date(new Date(NOW).getTime() - minutes * 60 * 1000).toISOString(); }

test('formatAge: minutes under an hour, hours (with minutes) under a day, days (with hours) at or beyond a day', () => {
  assert.equal(formatAge(45 * 60 * 1000), '45m');
  assert.equal(formatAge(0), '0m');
  assert.equal(formatAge(3 * 3600 * 1000), '3h');
  assert.equal(formatAge((3 * 3600 + 25 * 60) * 1000), '3h 25m');
  assert.equal(formatAge(26 * 3600 * 1000), '1d 2h');
  assert.equal(formatAge(24 * 3600 * 1000), '1d');
});

// Red-tell: a fixture ledger with two decision records 3h and 26h old lists the
// 26h one first with "1d 2h". Before daily-summary.js exists this throws
// MODULE_NOT_FOUND; once it exists but ages nothing, the order/format assertions fail.
test('the summary lists decision rows oldest first, formatted with age, computed from the ledger fold', () => {
  const root = rootDir();
  seedDecision(root, { issue: 1, to: 'escalated', enteredAt: hoursAgo(3) });
  seedDecision(root, { issue: 2, to: 'hold', enteredAt: hoursAgo(26) });
  const summary = buildSummary({ root, now: NOW });
  assert.equal(summary.priority, 'normal');
  const lines = summary.body.split('\n');
  assert.deepEqual(lines, ['#2 hold 1d 2h', '#1 escalated 3h']);
  assert.equal(summary.count, 2);
});

test('nothing waiting sends nothing: no page, no toast', () => {
  const root = rootDir();
  assert.equal(buildSummary({ root, now: NOW }), null);
  const send = sender();
  const result = runDailySummary({ root, now: NOW, send });
  assert.deepEqual(result, { sent: false, attempted: false, count: 0 });
  assert.equal(send.calls.length, 0, 'an empty ledger must never call the sender');
  assert.equal(exitCodeFor(result), 0, 'nothing waiting is always a clean exit');
});

test('a resolved decision (no longer hold/escalated) does not page; only current decision rows count', () => {
  const root = rootDir();
  const { id, revision } = seedDecision(root, { issue: 3, to: 'escalated', enteredAt: hoursAgo(5) });
  workState.transitionRecord({ root, id, to: 'ci-wait', expectedRevision: revision, idempotencyKey: 'resolve-3', actor: 'pr-watch', evidence: 'linkage restored', now: hoursAgo(4) });
  assert.equal(buildSummary({ root, now: NOW }), null);
});

test('capped at 10 rows, oldest first, with "and N more" for the rest', () => {
  const root = rootDir();
  for (let i = 1; i <= 12; i += 1) {
    seedDecision(root, { issue: i, to: i % 2 === 0 ? 'hold' : 'escalated', enteredAt: hoursAgo(i) });
  }
  const summary = buildSummary({ root, now: NOW });
  const lines = summary.body.split('\n');
  assert.equal(lines.length, 11);
  // Oldest (largest hoursAgo) first: issue 12 was seeded hoursAgo(12), the oldest.
  assert.equal(lines[0], `#12 hold ${formatAge(12 * 3600 * 1000)}`);
  assert.equal(lines[9], `#3 escalated ${formatAge(3 * 3600 * 1000)}`);
  assert.equal(lines[10], 'and 2 more');
  assert.equal(summary.count, 12);
});

test('runDailySummary sends the summary through the injected sender at normal priority, never shelling out', () => {
  const root = rootDir();
  seedDecision(root, { issue: 5, to: 'hold', enteredAt: hoursAgo(1) });
  const send = sender();
  const result = runDailySummary({ root, now: NOW, send });
  assert.equal(result.sent, true);
  assert.equal(result.count, 1);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].priority, 'normal');
  assert.match(send.calls[0].body, /^#5 hold 1h$/);
});

test('the default sender is pageSender (never called when nothing is waiting)', () => {
  const { pageSender } = require('../bin/notify');
  const root = rootDir();
  // Nothing waiting: runDailySummary must return before ever building or calling
  // the default sender, so this never shells out even though no `send` is injected.
  const result = runDailySummary({ root, now: NOW });
  assert.deepEqual(result, { sent: false, attempted: false, count: 0 });
  assert.equal(typeof pageSender, 'function');
});

// fleet#79 QA round 1, item 7: a failed send used to report sent:true anyway
// (result.ok was never checked), so a dead 08:00 page would log INFO exit=0
// the way run-daily-summary.ps1 grades its wrapped node call.
test('a failed send reports sent:false with the detail, and the exit-code contract goes non-zero', () => {
  const root = rootDir();
  seedDecision(root, { issue: 30, to: 'escalated', enteredAt: hoursAgo(1) });
  const failingSend = () => ({ ok: false, detail: 'pushover unconfigured' });
  const result = runDailySummary({ root, now: NOW, send: failingSend });
  assert.deepEqual(result, { sent: false, attempted: true, count: 1, detail: 'pushover unconfigured' });
  assert.equal(exitCodeFor(result), 1, 'something was waiting and the send failed: main() must exit non-zero');
});

test('a sender that returns no result (or throws) is treated as a failed send, not a silent success', () => {
  const root = rootDir();
  seedDecision(root, { issue: 31, to: 'hold', enteredAt: hoursAgo(1) });
  const result = runDailySummary({ root, now: NOW, send: () => undefined });
  assert.equal(result.sent, false);
  assert.equal(exitCodeFor(result), 1);
});

// --- fleet#2/#4 schema: unknown flags are refused -------------------------
test('daily-summary: cli() refuses an unknown flag rather than silently ignoring it', () => {
  assert.throws(() => cli(['--root', rootDir(), '--nope', 'x']), (error) => {
    assert.ok(error instanceof DailySummaryError);
    assert.equal(error.code, 'USAGE');
    for (const flag of DAILY_SUMMARY_FLAGS) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('daily-summary: cli() --dry-run computes the summary and never sends', () => {
  const root = rootDir();
  seedDecision(root, { issue: 6, to: 'escalated', enteredAt: hoursAgo(2) });
  const result = cli(['--root', root, '--now', NOW, '--dry-run']);
  assert.equal(result.sent, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.count, 1);
});

test('waitingRows exposes the raw fold rows the summary is built from', () => {
  const root = rootDir();
  seedDecision(root, { issue: 7, to: 'escalated', enteredAt: hoursAgo(4) });
  const rows = waitingRows({ root, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, 7);
  assert.equal(rows[0].state, 'escalated');
  assert.equal(rows[0].ageMs, 4 * 3600 * 1000);
});

// fleet#79 QA round 1, item 8: the ticket's own "#issue state age" format
// holds only while every waiting row is one tenant; once the fold spans more
// than one, each row names its tenant, decided from the FULL waiting set
// (before the cap) so the format never shifts with how many rows are shown.
test('rows are prefixed with their tenant once the waiting set spans more than one', () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'tenants', 'otherco.json'), JSON.stringify({ name: 'otherco', github: 'owner/other' }));
  seedDecision(root, { issue: 10, to: 'escalated', enteredAt: hoursAgo(5), tenant: 'endzone' });
  seedDecision(root, { issue: 20, to: 'hold', enteredAt: hoursAgo(3), tenant: 'otherco' });
  const summary = buildSummary({ root, now: NOW });
  assert.deepEqual(summary.body.split('\n'), ['endzone #10 escalated 5h', 'otherco #20 hold 3h']);
});

test('a single-tenant ledger keeps the ticket\'s plain "#issue state age" format even with a second tenant configured but idle', () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'tenants', 'otherco.json'), JSON.stringify({ name: 'otherco', github: 'owner/other' }));
  seedDecision(root, { issue: 11, to: 'escalated', enteredAt: hoursAgo(5), tenant: 'endzone' });
  const summary = buildSummary({ root, now: NOW });
  assert.deepEqual(summary.body.split('\n'), ['#11 escalated 5h']);
});

// fleet#79 QA round 1, item 9: formatAge(NaN) used to render "NaNm". A row
// with an unparseable enteredStateAt (a corrupted or legacy ledger line -
// isoNow() itself refuses to write one through the normal API, so this is
// hand-appended, the only way to reach the case at all) must render "unknown"
// and sort FIRST, not be silently treated as "just happened" and buried past
// the cap by every genuinely-aged row.
test('a row with an unparseable enteredStateAt renders age "unknown" and sorts first', () => {
  assert.equal(formatAge(NaN), 'unknown');
  const root = rootDir();
  seedDecision(root, { issue: 8, to: 'escalated', enteredAt: hoursAgo(2) });
  const eventsDir = path.join(root, 'state', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.appendFileSync(path.join(eventsDir, '2026-01-01.jsonl'), `${JSON.stringify({
    recordId: 'endzone:issue-999', type: 'state-escalated', at: 'not-a-real-date', sequence: 1, revision: 1, actor: 'test', evidence: null, changes: {},
  })}\n`, 'utf8');
  const rows = waitingRows({ root, now: NOW });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].issue, 999, 'the unparseable row sorts FIRST, never hidden behind a genuinely-aged one');
  assert.ok(Number.isNaN(rows[0].ageMs));
  const summary = buildSummary({ root, now: NOW });
  assert.deepEqual(summary.body.split('\n'), ['#999 escalated unknown', '#8 escalated 2h']);
});

// --- #131: the weekly scorecard's headline rides the daily page ----------------------
// Red-tell: before the change the page carries the waiting rows only.
function writeCard(root, monday, headline) {
  const dir = path.join(root, 'state', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `scorecard-${monday}.json`), JSON.stringify({ week: { label: `${monday}..x` }, headline }));
}

test('#131: the page carries the latest scorecard headline when one exists', () => {
  const root = rootDir();
  seedDecision(root, { issue: 1, to: 'escalated', enteredAt: hoursAgo(3) });
  writeCard(root, '2026-09-07', { area: 'Throughput', status: 'weak', result: 'old' });
  writeCard(root, '2026-09-14', { area: 'Review gate', status: 'weak', result: '1 merge without a formal review' });
  const summary = buildSummary({ root, now: NOW });
  assert.deepEqual(summary.body.split('\n'), ['#1 escalated 3h', 'Scorecard 2026-09-14..x: weakest row Review gate (weak): 1 merge without a formal review']);
  assert.equal(summary.count, 1, 'the headline is not a waiting row');
});

test('#131: with no scorecard file the headline line is omitted, never faked', () => {
  const root = rootDir();
  seedDecision(root, { issue: 1, to: 'escalated', enteredAt: hoursAgo(3) });
  assert.deepEqual(buildSummary({ root, now: NOW }).body.split('\n'), ['#1 escalated 3h']);
});

test('#131: a scorecard alone never turns a quiet day into a page', () => {
  const root = rootDir();
  writeCard(root, '2026-09-14', { area: 'Review gate', status: 'weak', result: 'x' });
  assert.equal(buildSummary({ root, now: NOW }), null);
});
