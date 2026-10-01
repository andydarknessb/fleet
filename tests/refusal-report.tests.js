'use strict';
// #279 (spec #196): the instrument for the Merge-fallback decision. It counts the auto-mode
// classifier's refusals by category from the harness's own tool-result text in session
// transcripts, never from an assistant message describing one. Red-tell: before
// bin/refusal-report.js nothing counts them, and the 27.8 h figure stays a hand estimate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanTranscript, collectRefusals, buildReport, renderMarkdown, cli, MERGE_CATEGORY, UNCATEGORIZED, REFUSAL_REPORT_FLAGS } = require('../bin/refusal-report');

const SINCE = '2026-09-29T23:32:13.000Z';
const UNTIL = '2026-10-06T23:32:13.000Z';

// The harness's real wording (verbatim from a live transcript, tail trimmed).
function denial(reason) {
  return `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. If you have other tasks that do not depend on this action, continue working on those. IMPORTANT: You *may* attempt to accomplish this action using other tools.`;
}

let counter = 0;
function row(type, timestamp, message, extra = {}) {
  counter += 1;
  return JSON.stringify({ uuid: `u${counter}`, type, timestamp, sessionId: extra.sessionId || 'sess-a', message, ...extra.fields });
}
const at = (minutes) => new Date(Date.parse('2026-10-01T10:00:00.000Z') + minutes * 60000).toISOString();
const assistantCall = (ts, id) => row('assistant', ts, { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'gh pr merge 1' } }] });
const toolResult = (ts, id, text, isError) => row('user', ts, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] });
const refused = (ts, id, reason, extra) => row('user', ts, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: denial(reason), is_error: true }] }, extra);
const human = (ts, text) => row('user', ts, { role: 'user', content: text });
const lines = (...rows) => `${rows.join('\n')}\n`;
const single = (text, sessionId = 's') => ({ scans: [{ ...scanTranscript(text, { sessionId }), sessionId }], filesScanned: 1 });

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-refusal-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the category is the bracketed Reason in the tool-result text; wait runs to the next successful tool call', () => {
  const text = lines(
    assistantCall(at(0), 'a'), refused(at(1), 'a', '[Merge Without Review]'),
    assistantCall(at(2), 'b'), toolResult(at(61), 'b', 'ok', false),
  );
  const scan = scanTranscript(text, { sessionId: 'sess-a' });
  assert.equal(scan.refusals.length, 1);
  assert.equal(scan.refusals[0].category, MERGE_CATEGORY);
  assert.equal(scan.refusals[0].waitMs, 60 * 60000);
});

test('a human turn ends the wait; the cap is the session end', () => {
  const text = lines(
    refused(at(0), 'a', '[Merge Without Review]'), human(at(30), 'go ahead'),
    refused(at(40), 'b', '[Sealed Path]'), toolResult(at(45), 'c', 'boom', true),
  );
  const [first, second] = scanTranscript(text, { sessionId: 's' }).refusals;
  assert.equal(first.waitMs, 30 * 60000);
  // no successful call or human turn after the second: capped at the last row of the session (5 min later)
  assert.equal(second.waitMs, 5 * 60000);
});

test('a later refusal does not end an earlier wait', () => {
  const text = lines(refused(at(0), 'a', '[CI Bypass]'), refused(at(10), 'b', '[CI Bypass]'), toolResult(at(20), 'c', 'ok', false));
  const [first, second] = scanTranscript(text, { sessionId: 's' }).refusals;
  assert.equal(first.waitMs, 20 * 60000);
  assert.equal(second.waitMs, 10 * 60000);
});

test('an assistant message that quotes a refusal is not counted; nor is a user prompt that does', () => {
  const quoted = row('assistant', at(0), { role: 'assistant', content: [{ type: 'text', text: denial('[Merge Without Review]') }] });
  const prompt = human(at(1), denial('[Merge Without Review]'));
  const nonError = toolResult(at(2), 'a', denial('[Merge Without Review]'), false);
  const ruleDenial = toolResult(at(3), 'b', 'Permission to use Bash with command git status has been denied.', true);
  const scan = scanTranscript(lines(quoted, prompt, nonError, ruleDenial), { sessionId: 's' });
  assert.deepEqual(scan.refusals, []);
});

test('block-array tool-result content and an "Error: " prefix are still read; the hook field also marks a refusal', () => {
  const blocks = toolResult(at(0), 'a', [{ type: 'text', text: `Error: ${denial('[Self-Modification]')}` }], true);
  const tagged = row('user', at(5), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Blocked.', is_error: true }] }, { fields: { toolDenialKind: 'automode-blocked' } });
  const refusals = scanTranscript(lines(blocks, tagged), { sessionId: 's' }).refusals;
  assert.deepEqual(refusals.map((r) => r.category), ['Self-Modification', UNCATEGORIZED]);
});

test('anything without a bracketed reason is uncategorized', () => {
  const text = lines(
    toolResult(at(0), 'a', denial('Blocked by classifier'), true),
    toolResult(at(1), 'b', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation)', true),
    toolResult(at(2), 'c', 'Permission for this action was denied by the Claude Code auto mode classifier.', true),
    toolResult(at(3), 'd', denial('[]'), true),
  );
  const cats = scanTranscript(text, { sessionId: 's' }).refusals.map((r) => r.category);
  assert.deepEqual(cats, [UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED]);
});

test('category names are trimmed and whitespace-collapsed, keeping their own words', () => {
  const text = lines(refused(at(0), 'a', '[  Irreversible   Local Destruction ]'));
  assert.equal(scanTranscript(text, { sessionId: 's' }).refusals[0].category, 'Irreversible Local Destruction');
});

test('malformed lines are skipped', () => {
  const text = `not json\n${refused(at(0), 'a', '[CI Bypass]')}\n{"type":\n`;
  assert.equal(scanTranscript(text, { sessionId: 's' }).refusals.length, 1);
});

function writeFixtureTree(dir) {
  const project = path.join(dir, 'proj');
  fs.mkdirSync(path.join(project, 'sess-a', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(project, 'sess-b'), { recursive: true });
  fs.writeFileSync(path.join(project, 'sess-a.jsonl'), lines(
    refused('2026-10-01T10:00:00.000Z', 'a', '[Merge Without Review]'), toolResult('2026-10-01T11:00:00.000Z', 'b', 'ok', false),
    refused('2026-10-01T12:00:00.000Z', 'c', '[Merge Without Review]'), human('2026-10-01T12:30:00.000Z', 'ok'),
    refused('2026-10-02T09:00:00.000Z', 'd', '[Modify Shared Resources]'), toolResult('2026-10-02T09:15:00.000Z', 'e', 'ok', false),
    // an assistant message that merely quotes a refusal
    row('assistant', '2026-10-02T10:00:00.000Z', { role: 'assistant', content: [{ type: 'text', text: denial('[Merge Without Review]') }] }),
    // outside the window (before and after)
    refused('2026-09-20T10:00:00.000Z', 'f', '[Merge Without Review]'),
    refused('2026-10-07T10:00:00.000Z', 'g', '[Merge Without Review]'),
  ));
  // a subagent of sess-a: counts against the host session
  fs.writeFileSync(path.join(project, 'sess-a', 'subagents', 'agent-x1.jsonl'), lines(
    refused('2026-10-03T08:00:00.000Z', 'h', '[Merge Without Review]'), toolResult('2026-10-03T08:10:00.000Z', 'i', 'ok', false),
    refused('2026-10-03T09:00:00.000Z', 'j', 'Blocked by classifier'), toolResult('2026-10-03T09:05:00.000Z', 'k', 'ok', false),
  ));
  fs.writeFileSync(path.join(project, 'sess-b', 'placeholder.txt'), 'not a transcript');
  fs.writeFileSync(path.join(project, 'sess-b.jsonl'), lines(
    refused('2026-10-04T08:00:00.000Z', 'l', '[Merge Without Review]', { sessionId: 'sess-b' }), toolResult('2026-10-04T08:30:00.000Z', 'm', 'ok', false),
  ));
  return dir;
}

test('collect walks main sessions and subagents; the report counts per category with sessions and wait hours', (t) => {
  const dir = writeFixtureTree(scratch(t));
  const collected = collectRefusals({ transcriptsDir: dir, since: SINCE, until: UNTIL });
  assert.equal(collected.filesScanned, 3);
  const report = buildReport(collected, { since: SINCE, until: UNTIL });
  const merge = report.categories.find((c) => c.category === MERGE_CATEGORY);
  // sess-a: 10:00 (60 min) + 12:00 (30 min); subagent of sess-a: 08:00 (10 min); sess-b: 30 min
  assert.equal(merge.count, 4);
  assert.equal(merge.sessions, 2);
  assert.equal(merge.waitHours, 2.17); // 130 min
  const shared = report.categories.find((c) => c.category === 'Modify Shared Resources');
  assert.deepEqual([shared.count, shared.sessions, shared.waitHours], [1, 1, 0.25]);
  const uncategorized = report.categories.find((c) => c.category === UNCATEGORIZED);
  assert.deepEqual([uncategorized.count, uncategorized.sessions, uncategorized.waitHours], [1, 1, 0.08]);
  assert.equal(report.total.count, 6);
  assert.equal(report.total.sessions, 2);
  assert.equal(report.categories[0].category, MERGE_CATEGORY, 'Merge Without Review is listed first');
});

test('Merge Without Review is reported on its own line even at zero', (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 's.jsonl'), lines(refused('2026-10-01T10:00:00.000Z', 'a', '[CI Bypass]')));
  const report = buildReport(collectRefusals({ transcriptsDir: dir, since: SINCE, until: UNTIL }), { since: SINCE, until: UNTIL });
  assert.deepEqual(report.categories.map((c) => c.category), [MERGE_CATEGORY, 'CI Bypass']);
  assert.equal(report.categories[0].count, 0);
});

test('the window includes both ends', () => {
  const text = lines(refused(SINCE, 'a', '[CI Bypass]'), refused(UNTIL, 'b', '[CI Bypass]'), refused('2026-10-06T23:32:13.001Z', 'c', '[CI Bypass]'));
  assert.equal(buildReport(single(text), { since: SINCE, until: UNTIL }).total.count, 2);
});

test('overlapping waits in one session are counted once in the total but fully per category', () => {
  const text = lines(refused(at(0), 'a', '[Merge Without Review]'), refused(at(10), 'b', '[CI Bypass]'), toolResult(at(60), 'c', 'ok', false));
  const report = buildReport(single(text), { since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' });
  assert.equal(report.categories.find((c) => c.category === MERGE_CATEGORY).waitHours, 1);
  assert.equal(report.categories.find((c) => c.category === 'CI Bypass').waitHours, 0.83);
  assert.equal(report.total.waitHours, 1);
});

test('default output is a Markdown table; --json prints the same figures as JSON', (t) => {
  const dir = writeFixtureTree(scratch(t));
  const base = ['--transcripts', dir, '--since', SINCE, '--until', UNTIL];
  const markdown = cli(base);
  assert.match(markdown, /\| Category \| Refusals \| Sessions \| Wait hours \|/);
  assert.match(markdown, /\| Merge Without Review \| 4 \| 2 \| 2\.17 \|/);
  assert.match(markdown, /\| Modify Shared Resources \| 1 \| 1 \| 0\.25 \|/);
  assert.match(markdown, /\| uncategorized \| 1 \| 1 \| 0\.08 \|/);
  assert.match(markdown, /\| Total \| 6 \| 2 \| /);
  assert.ok(!markdown.includes('—'), 'no em-dashes in output');
  const parsed = JSON.parse(cli([...base, '--json']));
  assert.equal(parsed.since, SINCE);
  assert.equal(parsed.until, UNTIL);
  assert.deepEqual(parsed, buildReport(collectRefusals({ transcriptsDir: dir, since: SINCE, until: UNTIL }), { since: SINCE, until: UNTIL }));
  assert.equal(renderMarkdown(parsed), markdown);
});

test('usage errors: missing --since, unparseable dates, until before since, unknown flag', () => {
  for (const argv of [[], ['--since', 'yesterday'], ['--since', SINCE, '--until', 'x'], ['--since', SINCE, '--until', '2020-01-01T00:00:00Z'], ['--since', SINCE, '--bogus', '1']]) {
    assert.throws(() => cli(argv), (error) => error.code === 'USAGE', JSON.stringify(argv));
  }
  assert.ok(REFUSAL_REPORT_FLAGS.includes('json'));
});

test('files last written before --since are not read', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'old.jsonl');
  fs.writeFileSync(file, lines(refused('2026-10-01T10:00:00.000Z', 'a', '[CI Bypass]')));
  const old = new Date('2026-09-01T00:00:00Z');
  fs.utimesSync(file, old, old);
  const collected = collectRefusals({ transcriptsDir: dir, since: SINCE, until: UNTIL });
  assert.equal(collected.filesScanned, 0);
  assert.equal(buildReport(collected, { since: SINCE, until: UNTIL }).total.count, 0);
});
