'use strict';
// Ticket 09 telemetry: the unified budget summary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSummary, family, median } = require('../bin/budget-report');
const { createRecord, transitionRecord, recordBudget } = require('../bin/work-state');

function rootDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-budget-report-'));
  fs.mkdirSync(path.join(root, 'state', 'budget'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'roster.json'), JSON.stringify({ sessions: [
    { name: 'ic-1', role: 'ic', tenant: 'endzone', issue: 1, model: 'sonnet', launchedAt: '2026-09-08T00:00:00Z' },
    { name: 'ic-2', role: 'ic', tenant: 'endzone', issue: 2, model: 'claude-opus-4-8', launchedAt: '2026-09-08T00:00:00Z' },
    { name: 'ic-3', role: 'ic', tenant: 'endzone', issue: 3, model: 'haiku', launchedAt: '2026-09-09T00:00:00Z' },
  ] }));
  return root;
}
function unit(root, issue) {
  const id = `endzone:issue-${issue}`;
  createRecord({ root, id, tenant: 'endzone', issue, state: 'implementing', idempotencyKey: `c-${issue}`, now: '2026-09-08T01:00:00.000Z' });
  return id;
}

test('family and median', () => {
  assert.equal(family('claude-opus-4-8'), 'opus');
  assert.equal(family('Sonnet'), 'sonnet');
  assert.equal(family('haiku'), 'haiku');
  assert.equal(family(undefined), 'unknown');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([10, 20]), 15);
  assert.equal(median([]), null);
});

test('the summary folds crossings by day and model with the live and completed pictures', () => {
  const root = rootDir();
  const a = unit(root, 1); const b = unit(root, 2); unit(root, 3);
  recordBudget({ root, id: a, expectedRevision: 1, phase: 'warn', tokens: 61000, idempotencyKey: 'w-1', now: '2026-09-08T02:00:00.000Z' });
  recordBudget({ root, id: b, expectedRevision: 1, phase: 'warn', tokens: 70000, idempotencyKey: 'w-2', now: '2026-09-08T03:00:00.000Z' });
  recordBudget({ root, id: b, expectedRevision: 2, phase: 'extend', tokens: 120000, by: 'cory', reason: 'wide', idempotencyKey: 'x-2', now: '2026-09-09T01:00:00.000Z' });
  transitionRecord({ root, id: b, expectedRevision: 3, to: 'escalated', idempotencyKey: 'e-2', now: '2026-09-09T02:00:00.000Z', evidence: 'wake:decision-needed; budget: 130000 job tokens >= 120000' });
  fs.writeFileSync(path.join(root, 'state', 'budget', 'last.json'), JSON.stringify({ at: '2026-09-09T03:00:00.000Z', mode: 'live', config: { warnTokens: 50000, escalateTokens: null }, records: [
    { id: a, jobTokens: 61000, decision: 'warn' }, { id: 'endzone:issue-3', jobTokens: 20000, decision: 'none' }, { id: 'endzone:issue-9', jobTokens: null, decision: 'unmeasured' },
  ] }));
  fs.writeFileSync(path.join(root, 'state', 'metrics', 'seven-day-2026-09-09.json'), JSON.stringify({ period: { since: 's', until: 'u' }, units: [
    { model: 'sonnet', metrics: { jobTokens: 40000 } }, { model: 'sonnet', metrics: { jobTokens: 60000 } }, { model: 'claude-opus-4-8', metrics: { jobTokens: 200000 } },
  ] }));
  const s = buildSummary({ root, now: '2026-09-09T04:00:00.000Z' });
  assert.deepEqual(s.totals, { crossings: 4, warnings: 2, extensions: 1, escalations: 1 });
  assert.deepEqual(Object.keys(s.byDay).sort(), ['2026-09-08', '2026-09-09']);
  assert.equal(s.byDay['2026-09-08'].warnings, 2);
  assert.equal(s.byDay['2026-09-08'].byModel.sonnet.warnings, 1);
  assert.equal(s.byDay['2026-09-08'].byModel.opus.warnings, 1);
  assert.equal(s.byDay['2026-09-09'].escalations, 1);
  assert.equal(s.soak.warningOnly, true);
  assert.equal(s.live.byModel.sonnet.warn, 1);
  assert.equal(s.live.byModel.haiku.medianJobTokens, 20000);
  assert.equal(s.live.byModel.unknown.unmeasured, 1);
  assert.equal(s.completed.byModel.sonnet.units, 2);
  assert.equal(s.completed.byModel.sonnet.medianJobTokens, 50000);
  assert.equal(s.completed.byModel.opus.medianJobTokens, 200000);
  const md = fs.readFileSync(path.join(root, 'state', 'budget', 'summary.md'), 'utf8');
  assert.match(md, /escalate OFF \(warning-only soak\)/);
  assert.match(md, /- 2026-09-08: warnings 2, extensions 0, escalations 0 \(/);
  assert.match(md, /- sonnet: 2 unit\(s\); median job tokens 50000/);
  assert.equal(fs.existsSync(path.join(root, 'state', 'budget', 'summary.json')), true);
});

test('an empty fleet renders an honest empty summary', () => {
  const root = rootDir();
  const s = buildSummary({ root, now: '2026-09-09T04:00:00.000Z' });
  assert.equal(s.totals.crossings, 0);
  assert.equal(s.soak, null);
  const md = fs.readFileSync(path.join(root, 'state', 'budget', 'summary.md'), 'utf8');
  assert.match(md, /No crossings recorded/);
  assert.match(md, /No active IC measured/);
});
