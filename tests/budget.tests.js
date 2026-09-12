'use strict';
// Ticket 09: IC token budgets. The actor measures every active IC's transcript (job
// tokens = input + output, the rotation/collector definition) and, at the configured
// thresholds, records ONE budget-warning event and then ONE escalation unless an approved
// extension covers the spend. Shadow unless state/flags/budget-live exists: the same
// decisions land in state/budget/shadow.jsonl and no record moves. Nothing is written
// between crossings; the live per-record figure is a projection in state/budget/last.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { applyBudgets, budgetConfig, isLive, BUDGET_STATES, cli, FLAGS, BudgetError } = require('../bin/budget');
const { createRecord, transitionRecord, getRecord, readEvents, recordBudget } = require('../bin/work-state');

function rootDir(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-budget-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.mkdirSync(path.join(root, 'claude-home', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ ic: { warnTokens: 50000, escalateTokens: 75000, ...(config || {}) } }));
  fs.writeFileSync(path.join(root, 'state', 'roster.json'), JSON.stringify({ sessions: [] }));
  return root;
}
function claudeHome(root) { return path.join(root, 'claude-home'); }
function rosterIc(root, issue, sessionId, status = 'active') {
  const p = path.join(root, 'state', 'roster.json');
  const roster = JSON.parse(fs.readFileSync(p, 'utf8'));
  roster.sessions.push({ name: `ic-${issue}`, role: 'ic', tenant: 'endzone', issue, sessionId, status });
  fs.writeFileSync(p, JSON.stringify(roster));
}
function transcript(root, sessionId, usages) {
  const rows = usages.map(([input, output]) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 5000000 } } }));
  fs.writeFileSync(path.join(claudeHome(root), 'projects', 'p', `${sessionId}.jsonl`), `${rows.join('\n')}\n`);
}
function unit(root, issue, state = 'implementing') {
  const id = `endzone:issue-${issue}`;
  createRecord({ root, id, tenant: 'endzone', issue, state: 'implementing', idempotencyKey: `c-${issue}`, now: '2026-09-09T00:00:00.000Z' });
  let revision = 1;
  const chain = { implementing: [], 'pr-open': ['pr-open'], review: ['pr-open', 'review'], hold: ['pr-open', 'review', 'hold'] }[state] || [];
  for (const to of chain) { transitionRecord({ root, id, expectedRevision: revision, to, idempotencyKey: `t-${issue}-${to}`, prNumber: 900 + issue, now: '2026-09-09T00:00:01.000Z' }); revision += 1; }
  return id;
}
function shadowLines(root) {
  const dir = path.join(root, 'state', 'budget', 'shadow');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
async function run(root, extra = {}) {
  return applyBudgets({ root, claudeHome: claudeHome(root), tenant: 'endzone', now: '2026-09-09T01:00:00.000Z', ...extra });
}

test('budgetConfig reads the ic block with defaults and isLive reads the flag', () => {
  const root = rootDir();
  assert.deepEqual(budgetConfig(root), { warnTokens: 50000, escalateTokens: 75000 });
  assert.equal(isLive({ root }), false);
  fs.writeFileSync(path.join(root, 'state', 'flags', 'budget-live'), 'x');
  assert.equal(isLive({ root }), true);
  assert.deepEqual(BUDGET_STATES, ['implementing', 'revision', 'pr-open', 'ci-wait', 'review']);
});

test('below the warning threshold nothing is recorded, but the measurement is projected', async () => {
  const root = rootDir();
  rosterIc(root, 42, 's42'); transcript(root, 's42', [[10000, 5000], [20000, 5000]]);
  const id = unit(root, 42);
  const result = await run(root);
  assert.equal(result.mode, 'shadow');
  assert.deepEqual(result.records.map((r) => [r.id, r.jobTokens, r.decision]), [[id, 40000, 'none']]);
  assert.equal(getRecord({ root, id }).budget.cumulativeTokens, 0, 'no record mutation below a threshold');
  assert.equal(shadowLines(root).length, 1);
  const last = JSON.parse(fs.readFileSync(path.join(root, 'state', 'budget', 'last.json'), 'utf8'));
  assert.equal(last.records[0].jobTokens, 40000);
  assert.equal(readEvents(root).filter((e) => e.type.startsWith('budget')).length, 0);
});

test('shadow: a warning and an escalation are proposed, logged, and never applied', async () => {
  const root = rootDir();
  rosterIc(root, 43, 's43'); transcript(root, 's43', [[50000, 10000]]);
  rosterIc(root, 44, 's44'); transcript(root, 's44', [[70000, 10000]]);
  const warn = unit(root, 43); const esc = unit(root, 44, 'review');
  const result = await run(root);
  const byId = Object.fromEntries(result.records.map((r) => [r.id, r.decision]));
  assert.equal(byId[warn], 'warn');
  assert.equal(byId[esc], 'escalate');
  assert.equal(getRecord({ root, id: warn }).state, 'implementing');
  assert.equal(getRecord({ root, id: esc }).state, 'review');
  assert.equal(getRecord({ root, id: esc }).budget.cumulativeTokens, 0);
  assert.equal(readEvents(root).filter((e) => e.type.startsWith('budget') || e.type === 'state-escalated').length, 0);
  assert.equal(shadowLines(root)[0].mode, 'shadow');
});

test('live: the warning is recorded once with the measured tokens, and a replay writes nothing', async () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'state', 'flags', 'budget-live'), 'x');
  rosterIc(root, 45, 's45'); transcript(root, 's45', [[50000, 10000]]);
  const id = unit(root, 45);
  const first = await run(root);
  assert.equal(first.mode, 'live');
  assert.equal(first.records[0].decision, 'warn');
  assert.equal(first.records[0].applied, true);
  const record = getRecord({ root, id });
  assert.equal(record.budget.cumulativeTokens, 60000);
  assert.ok(record.budget.warnedAt);
  assert.equal(record.state, 'implementing');
  transcript(root, 's45', [[50000, 10000], [1000, 1000]]);
  const second = await run(root, { now: '2026-09-09T01:05:00.000Z' });
  assert.equal(second.records[0].decision, 'warn');
  assert.equal(second.records[0].applied, false, 'already warned: nothing new to record');
  const warnings = readEvents(root).filter((e) => e.type === 'budget-warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].changes.cumulativeTokens, 60000);
});

test('live: over the escalation threshold the record is escalated once with prior_state and evidence', async () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'state', 'flags', 'budget-live'), 'x');
  rosterIc(root, 46, 's46'); transcript(root, 's46', [[70000, 10000]]);
  const id = unit(root, 46, 'review');
  const first = await run(root);
  assert.equal(first.records[0].decision, 'escalate');
  assert.equal(first.records[0].applied, true);
  const record = getRecord({ root, id });
  assert.equal(record.state, 'escalated');
  assert.equal(record.prior_state, 'review');
  assert.match(record.decisionEvidence, /budget: 80000 job tokens >= 75000/);
  assert.equal(record.budget.cumulativeTokens, 80000);
  // fleet#56: the transition door wrote the decision-needed line the Principal's frontier reads.
  const outbox = fs.readFileSync(path.join(root, 'state', 'watch', 'wake-outbox.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].wake, 'decision-needed');
  assert.equal(outbox[0].recordId, id);
  assert.match(outbox[0].evidence, /^budget: 80000/, 'the wake prefix is stripped from the outbox evidence');
  const second = await run(root, { now: '2026-09-09T01:05:00.000Z' });
  assert.equal(second.records.length, 0, 'an escalated record is outside the budget states and is not re-measured');
  assert.equal(readEvents(root).filter((e) => e.type === 'state-escalated').length, 1);
  assert.equal(readEvents(root).filter((e) => e.type === 'budget-warning').length, 1, 'crossing both thresholds at once still records the warning first');
});

test('an approved extension covers the spend up to its amount, then the escalation fires', async () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'state', 'flags', 'budget-live'), 'x');
  rosterIc(root, 47, 's47'); transcript(root, 's47', [[70000, 10000]]);
  const id = unit(root, 47);
  const extended = recordBudget({ root, id, expectedRevision: 1, phase: 'extend', tokens: 100000, by: 'cory', reason: 'wide migration', idempotencyKey: 'ext-47', now: '2026-09-09T00:30:00.000Z' });
  assert.equal(extended.record.budget.extension.tokens, 100000);
  assert.equal(readEvents(root).filter((e) => e.type === 'budget-extended').length, 1);
  const first = await run(root);
  assert.equal(first.records[0].decision, 'warn', 'still over the warning line');
  assert.equal(getRecord({ root, id }).state, 'implementing', 'covered by the extension');
  transcript(root, 's47', [[90000, 20000]]);
  const second = await run(root, { now: '2026-09-09T01:05:00.000Z' });
  assert.equal(second.records[0].decision, 'escalate');
  const record = getRecord({ root, id });
  assert.equal(record.state, 'escalated');
  assert.match(record.decisionEvidence, /extension 100000 by cory/);
});

test('an extension at or below the configured line is reported ineffective and does not stop the escalation', async () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'state', 'flags', 'budget-live'), 'x');
  rosterIc(root, 52, 's52'); transcript(root, 's52', [[70000, 10000]]);
  const id = unit(root, 52);
  recordBudget({ root, id, expectedRevision: 1, phase: 'extend', tokens: 25000, by: 'cory', reason: 'meant as an increment', idempotencyKey: 'ext-52', now: '2026-09-09T00:30:00.000Z' });
  const result = await run(root);
  assert.equal(result.records[0].decision, 'escalate');
  assert.equal(result.records[0].extensionIneffective, true);
  const record = getRecord({ root, id });
  assert.equal(record.state, 'escalated');
  assert.match(record.decisionEvidence, /ineffective: at or below the configured line/);
});

test('a tick with nothing to measure writes no shadow line', async () => {
  const root = rootDir();
  const result = await run(root);
  assert.equal(result.records.length, 0);
  assert.equal(shadowLines(root).length, 0);
  assert.equal(fs.existsSync(path.join(root, 'state', 'budget', 'last.json')), true, 'the projection is still written');
});

test('recordBudget refuses an extension without an amount, a grantor and a reason', () => {
  const root = rootDir();
  const id = unit(root, 48);
  assert.throws(() => recordBudget({ root, id, expectedRevision: 1, phase: 'extend', tokens: 0, by: 'cory', reason: 'r', idempotencyKey: 'x1' }), (e) => e.code === 'INVALID_BUDGET');
  assert.throws(() => recordBudget({ root, id, expectedRevision: 1, phase: 'extend', tokens: 90000, reason: 'r', idempotencyKey: 'x2' }), (e) => e.code === 'INVALID_BUDGET');
  assert.throws(() => recordBudget({ root, id, expectedRevision: 1, phase: 'extend', tokens: 90000, by: 'cory', idempotencyKey: 'x3' }), (e) => e.code === 'INVALID_BUDGET');
  assert.throws(() => recordBudget({ root, id, expectedRevision: 1, phase: 'bogus', idempotencyKey: 'x4' }), (e) => e.code === 'INVALID_BUDGET');
});

test('records outside the budget states, without a roster session, or without a transcript are reported and never escalated', async () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'state', 'flags', 'budget-live'), 'x');
  const held = unit(root, 49, 'hold');
  rosterIc(root, 49, 's49'); transcript(root, 's49', [[200000, 10000]]);
  const noRoster = unit(root, 50);
  const noTranscript = unit(root, 51); rosterIc(root, 51, 's51');
  const result = await run(root);
  const byId = Object.fromEntries(result.records.map((r) => [r.id, r]));
  assert.equal(byId[held], undefined, 'hold is Cory-s state, never budgeted');
  assert.equal(byId[noRoster].decision, 'unmeasured');
  assert.match(byId[noRoster].reason, /roster/);
  assert.equal(byId[noTranscript].decision, 'unmeasured');
  assert.match(byId[noTranscript].reason, /transcript/);
  assert.equal(getRecord({ root, id: noRoster }).state, 'implementing');
  assert.equal(getRecord({ root, id: noTranscript }).state, 'implementing');
  assert.equal(readEvents(root).filter((e) => e.type === 'state-escalated').length, 0);
});

// The warning-only soak: escalateTokens null records warnings and escalates nothing.
// --- fleet#4: budget.js refuses unknown flags with a per-command schema ----
// budget.js is a single-command binary (FLAGS.tick is its one entry - the
// binary runs unconditionally off the watch tick, with no subcommand word).
// Before this a typo'd flag (e.g. --tenant-name for --tenant, --live-mode for
// --live) fell into workState.parseArgs's unschema'd bucket and applyBudgets
// ran anyway against the defaults, on the tick that escalates real Work
// records under budget-live. Every case goes through `cli`, the same door
// require.main uses.
//
// Red-tell: revert bin/budget.js and `cli`/`FLAGS`/`BudgetError` are no
// longer exported, so every case below fails instead of asserting USAGE.

function budgetCliRoot() {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone' }));
  return root;
}

test('cli: an unknown flag is refused as USAGE naming the flag and the accepted set, nothing written', async () => {
  const root = budgetCliRoot();
  await assert.rejects(
    cli(['--root', root, '--tenant', 'endzone', '--tenant-name', 'endzone']),
    (error) => {
      assert.ok(error instanceof BudgetError, `expected BudgetError, got ${error && error.name}: ${error && error.message}`);
      assert.equal(error.code, 'USAGE');
      assert.match(error.message, /unknown flag --tenant-name/);
      assert.equal(error.flag, 'tenant-name');
      assert.deepEqual(error.accepted, FLAGS.tick);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(root, 'state', 'budget', 'last.json')), false, 'a refused invocation writes nothing, not even the projection');
  assert.equal(readEvents(root).length, 0, 'a refused invocation writes no events');
});

test('cli: a second confusable flag (--live-mode for --live) is also refused', async () => {
  const root = budgetCliRoot();
  await assert.rejects(cli(['--root', root, '--tenant', 'endzone', '--live-mode', 'true']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /unknown flag --live-mode/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, 'state', 'budget', 'last.json')), false);
});

test('cli: the refusal names every flag in FLAGS.tick', async () => {
  const root = budgetCliRoot();
  await assert.rejects(cli(['--root', root, '--nope', 'x']), (error) => {
    for (const flag of FLAGS.tick) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('cli: a correct invocation still runs the tick and returns the same digest shape as before', async () => {
  const root = budgetCliRoot();
  rosterIc(root, 60, 's60'); transcript(root, 's60', [[10000, 5000]]);
  const id = unit(root, 60);
  const digest = await cli(['--root', root, '--tenant', 'endzone', '--claude-home', claudeHome(root), '--now', '2026-09-09T01:00:00.000Z']);
  assert.equal(digest.mode, 'shadow');
  assert.equal(digest.measured, 1);
  assert.equal(digest.unmeasured, 0);
  assert.equal(digest.warn, 0);
  assert.equal(digest.escalate, 0);
  assert.equal(digest.applied, 0);
  assert.deepEqual(digest.errors, []);
  const last = JSON.parse(fs.readFileSync(path.join(root, 'state', 'budget', 'last.json'), 'utf8'));
  assert.equal(last.records[0].id, id);
});

test('cli: the process exits 2 on a typo and writes the refusal to stderr, nothing on stdout', () => {
  const root = budgetCliRoot();
  const bin = path.join(__dirname, '..', 'bin', 'budget.js');
  const typo = spawnSync(process.execPath, [bin, '--root', root, '--tenant', 'endzone', '--tenant-name', 'endzone'], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 2);
  assert.equal(typo.stdout, '');
  const parsed = JSON.parse(typo.stderr);
  assert.equal(parsed.code, 'USAGE');
  assert.match(parsed.message, /unknown flag --tenant-name/);
  const ok = spawnSync(process.execPath, [bin, '--root', root, '--tenant', 'endzone'], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).mode, 'shadow');
});

test('warning-only: escalateTokens null warns, never escalates, and reports the mode', async () => {
  const root = rootDir({ escalateTokens: null });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'budget-live'), 'x');
  rosterIc(root, 53, 's53'); transcript(root, 's53', [[200000, 50000]]);
  const id = unit(root, 53, 'review');
  assert.equal(budgetConfig(root).escalateTokens, null);
  const result = await run(root);
  assert.equal(result.records[0].decision, 'warn');
  assert.equal(result.records[0].warningOnly, true);
  assert.equal(result.records[0].applied, true);
  const record = getRecord({ root, id });
  assert.equal(record.state, 'review', '250000 job tokens and still not escalated');
  assert.equal(record.budget.cumulativeTokens, 250000);
  assert.equal(readEvents(root).filter((e) => e.type === 'state-escalated').length, 0);
  assert.equal(readEvents(root).filter((e) => e.type === 'budget-warning').length, 1);
});
