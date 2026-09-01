'use strict';
// Ticket 08b: the 48-hour parity gate between the watchdog's shadow proposals and
// the rostered Sentinel's applied ledger. Fixtures write both logs directly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compareParity, EXPECTED_CLASSES } = require('../bin/parity');

const T0 = Date.parse('2026-09-02T00:00:00.000Z');
const MIN = 60 * 1000;

function rootDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-parity-'));
  fs.mkdirSync(path.join(root, 'state', 'sentinel', 'shadow'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'sentinel', 'applied'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ supervisor: { parityHours: 48, pairWindowMinutes: 10, maxGapMinutes: 35 } }));
  return root;
}

function iso(ms) { return new Date(ms).toISOString(); }
function dayFile(ms) { return iso(ms).slice(0, 10).replace(/-/g, '') + '.jsonl'; }

function emptySet(overrides) {
  return { respawned: [], launchNeeded: [], escalate: [], retired: [], worktrees: [], pause: null, okCount: 3, ...overrides };
}

function shadowLine(root, ms, proposed, extra) {
  const line = { at: iso(ms), conditions: [], newlyPaged: [], checkError: '', proposed: proposed === null ? null : emptySet(proposed), verify: false, ...extra };
  fs.appendFileSync(path.join(root, 'state', 'sentinel', 'shadow', dayFile(ms)), `${JSON.stringify(line)}\n`);
}

function appliedLine(root, ms, report, extra) {
  const line = { at: iso(ms), actor: 'sentinel', applied: true, ...emptySet(report), ...extra };
  fs.appendFileSync(path.join(root, 'state', 'sentinel', 'applied', dayFile(ms)), `${JSON.stringify(line)}\n`);
}

// A clean run: the Sentinel ticks at :00/:15/:30/:45, the watchdog ninety seconds later.
function writeCleanRun(root, hours, opts = {}) {
  const ticks = hours * 4;
  for (let index = 0; index < ticks; index += 1) {
    const sentinelAt = T0 + index * 15 * MIN;
    if (!(opts.skipApplied && opts.skipApplied.includes(index))) appliedLine(root, sentinelAt, {});
    if (!(opts.skipShadow && opts.skipShadow.includes(index))) shadowLine(root, sentinelAt + 90 * 1000, {});
  }
  return T0 + ticks * 15 * MIN;
}

test('forty-nine identical hours pass the gate; the window and totals are reported', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49);
  const result = compareParity({ root, now: iso(end) });
  assert.equal(result.pass, true, JSON.stringify(result.reasons));
  assert.ok(result.continuousHours >= 48, `continuous hours ${result.continuousHours}`);
  assert.equal(result.totals.shadowTicks, 49 * 4);
  assert.equal(result.totals.appliedTicks, 49 * 4);
  assert.equal(result.totals.pairs, 49 * 4);
  assert.equal(result.unapproved.length, 0);
  assert.equal(result.parityHours, 48);
});

test('fewer than forty-eight continuous hours fail with a reason, even when identical', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 20);
  const result = compareParity({ root, now: iso(end) });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some((reason) => /continuous/.test(reason)), JSON.stringify(result.reasons));
});

test('a gap longer than maxGapMinutes restarts the continuity clock', () => {
  const root = rootDir();
  // 30 hours, a 3-tick hole on both sides (45 min > 35), then 30 more hours: neither run reaches 48.
  const hole = [120, 121, 122];
  const end = writeCleanRun(root, 60, { skipApplied: hole, skipShadow: hole });
  const result = compareParity({ root, now: iso(end) });
  assert.equal(result.pass, false);
  assert.ok(result.continuousHours < 48 && result.continuousHours >= 29, `continuous hours ${result.continuousHours}`);
});

test('an action proposed by an unpaired shadow tick and applied at the next Sentinel tick is applied-before-shadow', () => {
  const root = rootDir();
  // Tick 9: the Sentinel missed its tick (cron hiccup) but the shadow ran and proposed the respawn;
  // tick 10: the Sentinel respawned pl-test; the shadow at 10 saw it healthy.
  const end = writeCleanRun(root, 49, { skipApplied: [9, 10], skipShadow: [9] });
  shadowLine(root, T0 + 9 * 15 * MIN + 90 * 1000, { respawned: [{ name: 'pl-test', reason: 'state stopped' }] });
  appliedLine(root, T0 + 10 * 15 * MIN, { respawned: [{ name: 'pl-test', jobId: 'j', parent: 'dispatcher', reason: 'state stopped' }] });
  const result = compareParity({ root, now: iso(end) });
  const diffs = result.differences.filter((d) => d.category === 'respawned');
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].class, 'applied-before-shadow');
  assert.equal(diffs[0].name, 'pl-test');
  assert.ok(EXPECTED_CLASSES.includes('applied-before-shadow'));
  // The missed Sentinel tick itself is the only gating difference.
  assert.deepEqual(result.unapproved.map((d) => d.class), ['sentinel-tick-missing']);
});

test('a proposal the Sentinel applies at its next tick is timing; one it never applies is a real difference', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipShadow: [20, 40], skipApplied: [21] });
  // Tick 20: the shadow (at :01:30 after the :00 sentinel tick) proposes a respawn; the :15 sentinel tick applies it.
  const s20 = T0 + 20 * 15 * MIN;
  shadowLine(root, s20 + 90 * 1000, { respawned: [{ name: 'ic-5', reason: 'heartbeat stale' }] });
  appliedLine(root, s20 + 15 * MIN, { respawned: [{ name: 'ic-5', reason: 'heartbeat stale' }] });
  // Tick 40: the shadow proposes retiring ic-7; no Sentinel tick ever retires it.
  const s40 = T0 + 40 * 15 * MIN;
  shadowLine(root, s40 + 90 * 1000, { retired: ['ic-7'] });
  const result = compareParity({ root, now: iso(end) });
  const next = result.differences.find((d) => d.name === 'ic-5');
  assert.ok(next, 'the ic-5 proposal must be classified');
  assert.equal(next.class, 'applied-next-tick');
  const never = result.differences.find((d) => d.name === 'ic-7');
  assert.ok(never, 'the ic-7 proposal must be classified');
  assert.equal(never.class, 'proposed-not-applied');
  assert.equal(result.pass, false);
  assert.equal(result.unapproved.length, 1);
  assert.equal(result.unapproved[0].name, 'ic-7');
});

test('an action the Sentinel applied that no shadow tick proposed is unproposed and gates', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipApplied: [30] });
  const at = T0 + 30 * 15 * MIN;
  appliedLine(root, at, { worktrees: [{ tenant: 'test', path: 'C:/x/.claude/worktrees/ic-3-a', branch: 'worktree-a', ageDays: 9 }] });
  const result = compareParity({ root, now: iso(end) });
  const diff = result.differences.find((d) => d.category === 'worktrees');
  assert.ok(diff);
  assert.equal(diff.class, 'unproposed-action');
  assert.equal(diff.name, 'C:/x/.claude/worktrees/ic-3-a');
  assert.equal(result.pass, false);
  assert.deepEqual(result.unapproved.map((d) => d.class), ['unproposed-action']);
});

test('a Sentinel that acts every tick while the shadow proposes nothing cannot pass', () => {
  // The reviewer's experiment: a silent shadow must not be parity.
  const root = rootDir();
  for (let index = 0; index < 49 * 4; index += 1) {
    const at = T0 + index * 15 * MIN;
    appliedLine(root, at, { respawned: [{ name: 'pl-endzone', reason: 'state stopped' }], pause: 'set: rate-limit signal on pl-endzone' });
    shadowLine(root, at + 90 * 1000, {});
  }
  const result = compareParity({ root, now: iso(T0 + 49 * 60 * MIN) });
  assert.equal(result.pass, false);
  assert.ok(result.classes['unproposed-action'] >= 49 * 4 * 2, JSON.stringify(result.classes));
  assert.equal(result.classes['applied-before-shadow'] || 0, 0);
});

test('a fail-closed tick on either side is not clean evidence', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipShadow: [12], skipApplied: [20] });
  shadowLine(root, T0 + 12 * 15 * MIN + 90 * 1000, { daemonReadError: 'daemon session list unreadable (claude agents exit 1, output empty)', okCount: 1 });
  appliedLine(root, T0 + 20 * 15 * MIN, {}, { daemonReadError: 'daemon session list unreadable (claude agents exit 1, output empty)' });
  const result = compareParity({ root, now: iso(end) });
  assert.deepEqual(result.unapproved.map((d) => d.class).sort(), ['sentinel-read-failed', 'shadow-read-failed']);
  assert.equal(result.pass, false);
});

test('the sync category compares an applied fast-forward with a read-only would-fast-forward', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipShadow: [15, 16], skipApplied: [15, 16] });
  const idle = { tenant: 'test', synced: false, reason: 'integration already has everything on main', defAheadOfRel: 0 };
  // Tick 15: both sides see a pending fast-forward (the shadow would, the Sentinel did not yet... it did at 16).
  appliedLine(root, T0 + 15 * 15 * MIN, { sync: [idle] });
  shadowLine(root, T0 + 15 * 15 * MIN + 90 * 1000, { sync: [{ tenant: 'test', synced: false, dryRun: true, wouldFastForward: 2 }] });
  appliedLine(root, T0 + 16 * 15 * MIN, { sync: [{ tenant: 'test', synced: true, fastForwarded: 2, to: 'abc1234' }] });
  shadowLine(root, T0 + 16 * 15 * MIN + 90 * 1000, { sync: [idle] });
  const result = compareParity({ root, now: iso(end) });
  const sync = result.differences.filter((d) => d.category === 'sync');
  assert.equal(sync.length, 1, JSON.stringify(sync));
  assert.equal(sync[0].class, 'applied-next-tick');
  assert.equal(sync[0].name, 'test');
  assert.equal(result.pass, true, JSON.stringify(result.unapproved));
});

test('escalations present on both sides are identical; one side only within a tick is timing, otherwise drift', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipApplied: [50, 51, 52, 53, 54], skipShadow: [50, 51, 52, 53, 70] });
  const esc = { name: 'ic-9', kind: 'blocked', detail: 'waiting on input', parent: 'pl-test' };
  // Ticks 50..53: both sides report the same escalation.
  for (const index of [50, 51, 52, 53]) {
    const at = T0 + index * 15 * MIN;
    appliedLine(root, at, { escalate: [esc] });
    shadowLine(root, at + 90 * 1000, { escalate: [esc] });
  }
  // Tick 54: only the Sentinel still reports it (cleared between the two ticks): timing.
  appliedLine(root, T0 + 54 * 15 * MIN, { escalate: [esc] });
  // Tick 70: only the shadow reports a stray with no neighbour on the applied side: drift.
  shadowLine(root, T0 + 70 * 15 * MIN + 90 * 1000, { escalate: [{ name: 'ic-77', kind: 'stray', detail: 'x' }] });
  const result = compareParity({ root, now: iso(end) });
  assert.ok(result.classes.identical >= 4, JSON.stringify(result.classes));
  const timing = result.differences.filter((d) => d.name === 'ic-9' && d.class === 'timing');
  assert.equal(timing.length, 1);
  const drift = result.differences.find((d) => d.name === 'ic-77');
  assert.equal(drift.class, 'report-drift');
  assert.equal(result.pass, false);
  assert.deepEqual(result.unapproved.map((d) => d.name), ['ic-77']);
});

test('a missing Sentinel tick inside the window is a difference; an approval file makes it intentional', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipApplied: [100] });
  const unapproved = compareParity({ root, now: iso(end) });
  assert.equal(unapproved.pass, false);
  assert.equal(unapproved.unapproved[0].class, 'sentinel-tick-missing');
  fs.writeFileSync(path.join(root, 'state', 'sentinel', 'parity-approved.json'), JSON.stringify([
    { class: 'sentinel-tick-missing', note: 'Sentinel cron expired at day 7; recreated by hand', by: 'cory', at: '2026-09-03T00:00:00Z' },
  ]));
  const approved = compareParity({ root, now: iso(end) });
  assert.equal(approved.pass, true, JSON.stringify(approved.reasons));
  const diff = approved.differences.find((d) => d.class === 'sentinel-tick-missing');
  assert.equal(diff.approved, true);
  assert.match(diff.approvalNote, /cron expired/);
});

test('an approval scoped to a name does not cover another name', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipShadow: [40, 44] });
  shadowLine(root, T0 + 40 * 15 * MIN + 90 * 1000, { retired: ['ic-7'] });
  shadowLine(root, T0 + 44 * 15 * MIN + 90 * 1000, { retired: ['ic-8'] });
  fs.writeFileSync(path.join(root, 'state', 'sentinel', 'parity-approved.json'), JSON.stringify([
    { class: 'proposed-not-applied', name: 'ic-7', note: 'issue reopened by hand', by: 'cory', at: '2026-09-03T00:00:00Z' },
  ]));
  const result = compareParity({ root, now: iso(end) });
  assert.equal(result.pass, false);
  assert.deepEqual(result.unapproved.map((d) => d.name), ['ic-8']);
});

test('verify lines, live-mode lines, and non-sentinel actors are not parity evidence; a failed shadow check is a difference', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipShadow: [8] });
  shadowLine(root, T0 + 5 * 15 * MIN + 200 * 1000, { retired: ['ic-1'] }, { verify: true });
  shadowLine(root, T0 + 6 * 15 * MIN + 200 * 1000, { retired: ['ic-2'] }, { mode: 'live' });
  appliedLine(root, T0 + 7 * 15 * MIN + 200 * 1000, { retired: ['ic-3'] }, { actor: 'watchdog' });
  // Tick 8: the shadow check failed (no proposal).
  shadowLine(root, T0 + 8 * 15 * MIN + 90 * 1000, null, { checkError: 'exit=1; no readable report' });
  const result = compareParity({ root, now: iso(end) });
  assert.equal(result.differences.some((d) => ['ic-1', 'ic-2', 'ic-3'].includes(d.name)), false);
  assert.equal(result.totals.shadowTicks, 49 * 4);
  const failed = result.differences.find((d) => d.class === 'shadow-check-failed');
  assert.ok(failed);
  assert.equal(result.pass, false);
});

test('differences outside the continuous window are listed but do not gate', () => {
  const root = rootDir();
  // A bad first hour, then a 20-minute hole, then 49 clean hours.
  shadowLine(root, T0 - 3 * 60 * MIN, { retired: ['ic-old'] });
  const end = writeCleanRun(root, 49);
  const result = compareParity({ root, now: iso(end) });
  const old = result.differences.find((d) => d.class === 'sentinel-tick-missing');
  assert.ok(old, 'the unpaired early shadow tick must be classified');
  assert.equal(old.inWindow, false);
  assert.equal(result.pass, true, JSON.stringify(result.reasons));
});

test('the pause and launchNeeded categories compare by value and by name', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 49, { skipApplied: [60, 61], skipShadow: [60] });
  const at = T0 + 60 * 15 * MIN;
  // Tick 60: the shadow sees the rate-limit signal and would pause; tick 61: the Sentinel pauses.
  appliedLine(root, at, { launchNeeded: [{ name: 'pl-test', reason: 'no job known to the daemon' }] });
  shadowLine(root, at + 90 * 1000, { pause: 'set: rate-limit signal on pl-test', launchNeeded: [{ name: 'pl-test', reason: 'no job known to the daemon' }] });
  appliedLine(root, at + 15 * MIN, { pause: 'set: rate-limit signal on pl-test' });
  const result = compareParity({ root, now: iso(end) });
  const pause = result.differences.filter((d) => d.category === 'pause');
  assert.equal(pause.length, 1);
  assert.equal(pause[0].class, 'applied-next-tick');
  assert.equal(pause[0].name, 'set: rate-limit signal on pl-test');
  assert.equal(result.differences.some((d) => d.category === 'launchNeeded'), false);
  assert.equal(result.pass, true, JSON.stringify(result.unapproved));
});

test('--since and --until bound the evidence; text rendering names the verdict', () => {
  const root = rootDir();
  const end = writeCleanRun(root, 60);
  const { renderText } = require('../bin/parity');
  const bounded = compareParity({ root, since: iso(T0 + 2 * 60 * MIN), until: iso(T0 + 12 * 60 * MIN) });
  assert.equal(bounded.totals.shadowTicks, 40);
  assert.equal(bounded.pass, false);
  const text = renderText(compareParity({ root, now: iso(end) }));
  assert.match(text, /PARITY: PASS/);
  assert.match(text, /continuous hours/i);
});
