'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./temp-dir');
const test = require('node:test');

const policy = require('../bin/rotation-policy');

function rootDir() {
  return makeTempDir('fleet-rotation-policy-');
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function writeJson(root, relative, value) {
  return write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function eventLine({ recordId, sequence = 1, type = 'state-merged', at }) {
  return `${JSON.stringify({ schemaVersion: 1, recordId, sequence, type, actor: 'test', at, idempotencyKey: `${recordId}:${sequence}`, changes: {} })}\n`;
}

function seedFleet(root, { launchedAt, name = 'pl-endzone', role = 'project-lead', tenant = 'endzone', sessionId = 'sess-pl-1' } = {}) {
  writeJson(root, 'roster.json', {
    cap: 6,
    sessions: [
      { name: 'dispatcher', role: 'dispatcher', tenant: null, parent: 'cory' },
      { name: 'pl-endzone', role: 'project-lead', tenant: 'endzone', parent: 'dispatcher' },
    ],
  });
  writeJson(root, 'state/roster.json', {
    sessions: [{ name, role, tenant, sessionId, status: 'active', launchedAt }],
  });
}

const NOW = '2026-09-02T12:00:00.000Z';

test('offset counts events across live and archived files and tracks per-record sequences', () => {
  const root = rootDir();
  write(root, 'state/events/2026-09-01.jsonl',
    eventLine({ recordId: 'endzone:issue-1', sequence: 1, at: '2026-09-01T10:00:00.000Z' })
    + eventLine({ recordId: 'endzone:issue-1', sequence: 2, at: '2026-09-01T11:00:00.000Z' }));
  write(root, 'state/events/archive/2026-08-01.jsonl',
    eventLine({ recordId: 'endzone:issue-9', sequence: 4, at: '2026-08-01T10:00:00.000Z' }));
  const offset = policy.captureOffset({ root, now: NOW });
  assert.equal(offset.totalEvents, 3);
  assert.equal(offset.perRecord['endzone:issue-1'], 2);
  assert.equal(offset.perRecord['endzone:issue-9'], 4);
  assert.equal(offset.capturedAt, NOW);
  assert.equal(offset.files.length, 2);
});

test('offset skips a torn trailing line instead of failing', () => {
  const root = rootDir();
  write(root, 'state/events/2026-09-01.jsonl',
    eventLine({ recordId: 'endzone:issue-1', sequence: 1, at: '2026-09-01T10:00:00.000Z' })
    + '{"recordId":"endzone:issue-1","seq');
  const offset = policy.captureOffset({ root, now: NOW });
  assert.equal(offset.totalEvents, 1);
});

test('evaluate marks a session due on age', async () => {
  const root = rootDir();
  seedFleet(root, { launchedAt: '2026-09-01T10:00:00.000Z' });
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  const lead = result.sessions.find((s) => s.name === 'pl-endzone');
  assert.equal(lead.due, true);
  assert.match(lead.reasons.join(' '), /age/);
});

test('evaluate leaves a young session alone', async () => {
  const root = rootDir();
  seedFleet(root, { launchedAt: '2026-09-02T02:00:00.000Z' });
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  const lead = result.sessions.find((s) => s.name === 'pl-endzone');
  assert.equal(lead.due, false);
  assert.deepEqual(lead.reasons, []);
});

test('evaluate counts only own-tenant merges after launch', async () => {
  const root = rootDir();
  seedFleet(root, { launchedAt: '2026-09-02T02:00:00.000Z' });
  let lines = '';
  // Before launch: never counts.
  lines += eventLine({ recordId: 'endzone:issue-1', at: '2026-09-01T01:00:00.000Z' });
  // Another tenant: never counts.
  lines += eventLine({ recordId: 'other:issue-2', at: '2026-09-02T03:00:00.000Z' });
  // Non-merge event: never counts.
  lines += eventLine({ recordId: 'endzone:issue-3', type: 'pr-observed', at: '2026-09-02T03:00:00.000Z' });
  for (let i = 0; i < 4; i += 1) {
    lines += eventLine({ recordId: `endzone:issue-${10 + i}`, at: `2026-09-02T0${4 + i}:00:00.000Z` });
  }
  write(root, 'state/events/2026-09-02.jsonl', lines);
  const four = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  assert.equal(four.sessions.find((s) => s.name === 'pl-endzone').due, false);
  assert.equal(four.sessions.find((s) => s.name === 'pl-endzone').metrics.merges, 4);

  fs.appendFileSync(path.join(root, 'state/events/2026-09-02.jsonl'),
    eventLine({ recordId: 'endzone:issue-14', at: '2026-09-02T08:00:00.000Z' }));
  const five = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  const lead = five.sessions.find((s) => s.name === 'pl-endzone');
  assert.equal(lead.due, true);
  assert.match(lead.reasons.join(' '), /merges/);
});

test('evaluate sums transcript job tokens and trips the token threshold', async () => {
  const root = rootDir();
  seedFleet(root, { launchedAt: '2026-09-02T02:00:00.000Z', sessionId: 'sess-tokens' });
  const claudeHome = path.join(root, 'claude-home');
  const rows = [
    { type: 'assistant', message: { usage: { input_tokens: 100000, output_tokens: 60000, cache_read_input_tokens: 999999 } } },
    { type: 'assistant', message: { usage: { input_tokens: 50000, output_tokens: 45000 } } },
    { type: 'user', message: { content: 'no usage row' } },
  ];
  write(root, 'claude-home/projects/some-project/sess-tokens.jsonl', rows.map((row) => JSON.stringify(row)).join('\n'));
  const result = await policy.evaluate({ root, claudeHome, now: NOW });
  const lead = result.sessions.find((s) => s.name === 'pl-endzone');
  assert.equal(lead.metrics.jobTokens, 255000);
  assert.equal(lead.due, true);
  assert.match(lead.reasons.join(' '), /tokens/);
});

test('evaluate treats a missing transcript as unknown tokens, not due', async () => {
  const root = rootDir();
  seedFleet(root, { launchedAt: '2026-09-02T02:00:00.000Z', sessionId: 'sess-missing' });
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'claude-home'), now: NOW });
  const lead = result.sessions.find((s) => s.name === 'pl-endzone');
  assert.equal(lead.metrics.jobTokens, null);
  assert.equal(lead.due, false);
  assert.match(lead.metricsError, /transcript not found/);
});

test('a partial config entry keeps the spec fallbacks for unnamed thresholds', () => {
  const root = rootDir();
  writeJson(root, 'config/cycle.json', { rotation: { 'project-lead': { maxAgeHours: 48 } } });
  const merged = policy.rotationConfig(root);
  assert.equal(merged['project-lead'].maxAgeHours, 48);
  assert.equal(merged['project-lead'].maxMerges, 5);
  assert.equal(merged['project-lead'].maxJobTokens, 125000);
  assert.equal(merged.dispatcher.maxAgeHours, 24);
});

test('a torn roster file makes evaluate a no-op instead of a crash', async () => {
  const root = rootDir();
  write(root, 'state/roster.json', '{"sessions":[{"name":"pl-en');
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  assert.deepEqual(result.sessions, []);
});

test('evaluate skips roles without a rotation policy and sessions off the static roster', async () => {
  const root = rootDir();
  writeJson(root, 'roster.json', { cap: 6, sessions: [{ name: 'sentinel', role: 'sentinel' }] });
  writeJson(root, 'state/roster.json', {
    sessions: [
      { name: 'sentinel', role: 'sentinel', sessionId: 's1', status: 'active', launchedAt: '2026-08-01T00:00:00.000Z' },
      { name: 'pl-endzone', role: 'project-lead', tenant: 'endzone', sessionId: 's2', status: 'active', launchedAt: '2026-08-01T00:00:00.000Z' },
      { name: 'ic-42', role: 'ic', tenant: 'endzone', sessionId: 's3', status: 'active', launchedAt: '2026-08-01T00:00:00.000Z' },
    ],
  });
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  assert.deepEqual(result.sessions, []);
});

test('evaluate skips retired sessions and flags an unreadable launchedAt without marking it due', async () => {
  const root = rootDir();
  writeJson(root, 'roster.json', { cap: 6, sessions: [{ name: 'dispatcher', role: 'dispatcher' }] });
  writeJson(root, 'state/roster.json', {
    sessions: [
      { name: 'dispatcher', role: 'dispatcher', sessionId: 'd1', status: 'retired', launchedAt: '2026-08-01T00:00:00.000Z' },
    ],
  });
  const none = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  assert.deepEqual(none.sessions, []);

  writeJson(root, 'state/roster.json', {
    sessions: [{ name: 'dispatcher', role: 'dispatcher', sessionId: 'd1', status: 'active', launchedAt: 'garbage' }],
  });
  const bad = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  assert.equal(bad.sessions[0].due, false);
  assert.ok(bad.sessions[0].metricsError);
});

test('evaluate falls back to spec thresholds when config/cycle.json is absent', async () => {
  const root = rootDir();
  seedFleet(root, { launchedAt: '2026-09-01T10:00:00.000Z', name: 'dispatcher', role: 'dispatcher', tenant: null, sessionId: 'd1' });
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  const dispatcher = result.sessions.find((s) => s.name === 'dispatcher');
  assert.equal(dispatcher.due, true);
  assert.equal(dispatcher.thresholds.maxAgeHours, 24);
});

// --- #311: the shipped config drops the project-lead age rotation ---------------------------
// The lead is relaunched by the watchdog wake with a brief, so age alone no longer rotates it;
// merges and job tokens still do. The dispatcher keeps its 24h age rule.
test('#311: with the shipped config/cycle.json a 30h project-lead with few merges and tokens is not due, a 30h dispatcher is', async () => {
  const root = rootDir();
  write(root, 'config/cycle.json', fs.readFileSync(path.join(__dirname, '..', 'config', 'cycle.json'), 'utf8'));
  const launchedAt = '2026-09-01T06:00:00.000Z'; // 30 h before NOW
  writeJson(root, 'roster.json', { cap: 6, sessions: [
    { name: 'dispatcher', role: 'dispatcher', tenant: null, parent: 'cory' },
    { name: 'pl-endzone', role: 'project-lead', tenant: 'endzone', parent: 'dispatcher' },
  ] });
  writeJson(root, 'state/roster.json', { sessions: [
    { name: 'dispatcher', role: 'dispatcher', tenant: null, sessionId: 'sess-d', status: 'active', launchedAt },
    { name: 'pl-endzone', role: 'project-lead', tenant: 'endzone', sessionId: 'sess-pl', status: 'active', launchedAt },
  ] });
  write(root, 'state/events/2026-09-02.jsonl', eventLine({ recordId: 'endzone:issue-1', at: '2026-09-02T08:00:00.000Z' }));
  write(root, 'claude-home/projects/p/sess-pl.jsonl', JSON.stringify({ type: 'assistant', message: { id: 'msg_A', usage: { input_tokens: 1000, output_tokens: 500 } } }));
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'claude-home'), now: NOW });
  const lead = result.sessions.find((s) => s.name === 'pl-endzone');
  assert.equal(lead.metrics.ageHours, 30);
  assert.equal(lead.thresholds.maxAgeHours, null, 'the shipped project-lead entry has no age threshold');
  assert.equal(lead.metrics.merges, 1);
  assert.equal(lead.metrics.jobTokens, 1500);
  assert.equal(lead.due, false, `a 30h lead is not due on age alone (reasons: ${lead.reasons.join('; ')})`);
  assert.deepEqual(lead.reasons, []);
  const dispatcher = result.sessions.find((s) => s.name === 'dispatcher');
  assert.equal(dispatcher.due, true, 'the dispatcher still rotates on age');
  assert.match(dispatcher.reasons[0], /^age 30\.0h >= 24h/);
});

test('#311: the shipped project-lead entry still rotates on merges', async () => {
  const root = rootDir();
  write(root, 'config/cycle.json', fs.readFileSync(path.join(__dirname, '..', 'config', 'cycle.json'), 'utf8'));
  seedFleet(root, { launchedAt: '2026-09-01T06:00:00.000Z' });
  write(root, 'state/events/2026-09-02.jsonl', [1, 2, 3, 4, 5].map((n) => eventLine({ recordId: `endzone:issue-${n}`, at: '2026-09-02T08:00:00.000Z' })).join(''));
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  const lead = result.sessions.find((s) => s.name === 'pl-endzone');
  assert.equal(lead.due, true);
  assert.match(lead.reasons.join(';'), /merges 5 >= 5/);
});

// --- fleet#4: adopt the parseArgs flag schema ---------------------------------------
// Red-tell: with bin/rotation-policy.js reverted to its old hand-rolled parseArgs (no
// schema, no per-command dispatch guard), the typo cases below stop throwing.

test('cli: evaluate refuses --claudehome (confusable with --claude-home) as an unknown flag', async () => {
  const root = rootDir();
  await assert.rejects(() => policy.cli(['evaluate', '--root', root, '--claudehome', 'x']), (error) => {
    assert.ok(error instanceof policy.RotationPolicyError, `expected RotationPolicyError, got ${error && error.name}`);
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /unknown flag --claudehome\b/);
    for (const flag of policy.ROTATION_POLICY_FLAGS.evaluate) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('cli: offset refuses --roots (confusable with --root) as an unknown flag', async () => {
  await assert.rejects(() => policy.cli(['offset', '--roots', 'x']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /unknown flag --roots\b/);
    for (const flag of policy.ROTATION_POLICY_FLAGS.offset) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('cli: an unknown command is a usage error naming the known commands', async () => {
  await assert.rejects(() => policy.cli(['evaluat', '--root', 'x']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /unknown command 'evaluat'; commands: evaluate, offset/);
    return true;
  });
});

test('cli: a correct invocation still works for both commands', async () => {
  const root = rootDir();
  seedFleet(root, { launchedAt: '2026-09-01T10:00:00.000Z', name: 'dispatcher', role: 'dispatcher', tenant: null, sessionId: 'd1' });
  const viaCli = await policy.cli(['evaluate', '--root', root, '--claude-home', path.join(root, 'no-claude'), '--now', NOW]);
  const direct = await policy.evaluate({ root, claudeHome: path.join(root, 'no-claude'), now: NOW });
  assert.deepEqual(viaCli, direct);

  const offsetViaCli = await policy.cli(['offset', '--root', root, '--now', NOW]);
  const offsetDirect = policy.captureOffset({ root, now: NOW });
  assert.deepEqual(offsetViaCli, offsetDirect);
});

// --- #201 (spec #191): count each model response once ---------------------------------
function tripledResponseRows() {
  const usage = { input_tokens: 40000, output_tokens: 20000, cache_read_input_tokens: 999999 };
  const row = (id, u) => ({ type: 'assistant', message: { id, usage: u } });
  return [
    row('msg_A', usage), row('msg_A', usage), row('msg_A', usage),
    row('msg_B', { input_tokens: 30000, output_tokens: 10000 }),
  ];
}

test('#201: one response written as three rows plus a second response sums exactly two responses', async () => {
  const root = rootDir();
  const file = write(root, 'claude-home/projects/p/sess.jsonl', tripledResponseRows().map((r) => JSON.stringify(r)).join('\n'));
  const totals = await policy.sumTranscriptTokens(file);
  assert.equal(totals.inputTokens, 70000);
  assert.equal(totals.outputTokens, 30000);
  assert.equal(totals.jobTokens, 100000);
  assert.equal(totals.usageResponses, 2);
  assert.equal(totals.usageRowsWithoutId, 0);
});

test('#201: rows with no response id are counted as before and flagged', async () => {
  const root = rootDir();
  const rows = [
    { type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 10 } } },
    { type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 10 } } },
    { type: 'assistant', message: { id: 'msg_A', usage: { input_tokens: 5, output_tokens: 1 } } },
  ];
  const file = write(root, 'claude-home/projects/p/sess.jsonl', rows.map((r) => JSON.stringify(r)).join('\n'));
  const totals = await policy.sumTranscriptTokens(file);
  assert.equal(totals.jobTokens, 226);
  assert.equal(totals.usageRowsWithoutId, 2);
  assert.equal(totals.usageResponses, 3);
});

test('#201: the Rotation policy trips on de-duplicated tokens, not on the repeated rows', async () => {
  const root = rootDir();
  seedFleet(root, { launchedAt: '2026-09-02T02:00:00.000Z', sessionId: 'sess-once' });
  writeJson(root, 'config/cycle.json', { rotation: { 'project-lead': { maxJobTokens: 125000 } } });
  write(root, 'claude-home/projects/p/sess-once.jsonl', tripledResponseRows().map((r) => JSON.stringify(r)).join('\n'));
  const result = await policy.evaluate({ root, claudeHome: path.join(root, 'claude-home'), now: NOW });
  const lead = result.sessions.find((s) => s.name === 'pl-endzone');
  assert.equal(lead.metrics.jobTokens, 100000, 'three repeated rows are one response: 100000, not the 220000 the rows sum to');
  assert.equal(lead.due, false);
});
