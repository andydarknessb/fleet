'use strict';
// #279 (spec #196, ruling 2026-10-01): the instrument for the Merge-fallback decision. It
// counts the auto-mode classifier's refusals by category from the harness's own tool-result
// text in fleet roster sessions' transcripts, never from an assistant message describing
// one, and prices "Merge Without Review" as refusal-to-PR-merge session-hours. Red-tell:
// before bin/refusal-report.js nothing counts them, and the first cut read 0.18 h fleet-only
// over the audit week because a refused lead parks within seconds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  scanTranscript, parseGhMerge, loadFleetSessions, collectRefusals, prKeysToResolve, mergeKey, fetchMerges, buildReport, renderMarkdown, cli,
  MERGE_CATEGORY, OUTSIDE_ROSTER_LABEL, UNCATEGORIZED, REFUSAL_REPORT_FLAGS,
} = require('../bin/refusal-report');

const SINCE = '2026-09-29T23:32:13.000Z';
const UNTIL = '2026-10-06T23:32:13.000Z';
const REPO = 'andydarknessb/Endzone-Empire';

// The harness's real wording (verbatim from a live transcript, tail trimmed).
function denial(reason) {
  return `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. If you have other tasks that do not depend on this action, continue working on those. IMPORTANT: You *may* attempt to accomplish this action using other tools.`;
}

let counter = 0;
function row(type, timestamp, message, fields = {}) {
  counter += 1;
  return JSON.stringify({ uuid: `u${counter}`, type, timestamp, ...fields, message });
}
const at = (minutes) => new Date(Date.parse('2026-10-01T10:00:00.000Z') + minutes * 60000).toISOString();
const assistantCall = (ts, id, command) => row('assistant', ts, { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] });
const toolResult = (ts, id, text, isError, fields) => row('user', ts, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, fields);
// The harness's refusal: an is_error tool_result on a row tagged toolDenialKind "automode-blocked".
const refusedResult = (ts, id, reason, fields = {}) => toolResult(ts, id, denial(reason), true, { toolDenialKind: 'automode-blocked', ...fields });
// A refused command: the assistant's tool_use, then the refusal.
const attempt = (ts, id, command, reason = '[Merge Without Review]', fields) => [assistantCall(ts, id, command), refusedResult(ts, id, reason, fields)].join('\n');
const human = (ts, text) => row('user', ts, { role: 'user', content: text });
const lines = (...rows) => `${rows.join('\n')}\n`;

const scratchDirs = [];
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-refusal-report-'));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A fleet home with a live roster, a retired-rows archive, tenant configs and optional events.
function fleetHome({ live = [], retired = [], events = null } = {}) {
  const home = scratch();
  fs.mkdirSync(path.join(home, 'state', 'archive'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'roster.json'), JSON.stringify({ sessions: live }));
  fs.writeFileSync(path.join(home, 'state', 'archive', 'roster-retired-full.jsonl'), retired.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(home, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', repo: 'E:\\Endzone-Empire', github: REPO }));
  fs.writeFileSync(path.join(home, 'tenants', 'nidus.json'), JSON.stringify({ name: 'nidus', repo: 'E:\\Nidus', github: 'andydarknessb/Nidus' }));
  if (events) {
    fs.mkdirSync(path.join(home, 'state', 'events'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'events', '2026-10-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  }
  return home;
}
const rosterRow = (name, role, sessionId, tenant, extra = {}) => ({ name, role, tenant, sessionId, launchedAt: '2026-09-01T00:00:00.000Z', ...extra });

// -- scanTranscript ----------------------------------------------------------------

test('a refusal is the tagged is_error tool_result; the category is the bracketed Reason; the refused command comes from the matching tool_use', () => {
  const text = lines(attempt(at(0), 'a', `gh pr merge 1735 -R ${REPO} --squash --delete-branch 2>&1; gh pr view 1735 --json state`));
  const scan = scanTranscript(text, { sessionId: 's' });
  assert.equal(scan.refusals.length, 1);
  assert.equal(scan.refusals[0].category, MERGE_CATEGORY);
  assert.deepEqual(scan.refusals[0].pr, { number: 1735, repo: REPO });
  assert.equal(scan.refusals[0].timestamp, at(0));
});

test('tag required: a text-only hit is listed as unconfirmed, not counted', () => {
  const textOnly = toolResult(at(0), 'a', denial('[Merge Without Review]'), true); // no toolDenialKind
  const scan = scanTranscript(lines(textOnly), { sessionId: 's' });
  assert.deepEqual(scan.refusals, []);
  assert.equal(scan.unconfirmed.length, 1);
  assert.equal(scan.unconfirmed[0].category, MERGE_CATEGORY);
});

test('an assistant message that quotes a refusal, a user prompt that does, and a non-error result are not counted', () => {
  const quoted = row('assistant', at(0), { role: 'assistant', content: [{ type: 'text', text: denial('[Merge Without Review]') }] });
  const prompt = human(at(1), denial('[Merge Without Review]'));
  const nonError = toolResult(at(2), 'a', denial('[Merge Without Review]'), false, { toolDenialKind: 'automode-blocked' });
  const ruleDenial = toolResult(at(3), 'b', 'Permission to use Bash with command git status has been denied.', true, { toolDenialKind: 'permission-rule' });
  const scan = scanTranscript(lines(quoted, prompt, nonError, ruleDenial), { sessionId: 's' });
  assert.deepEqual(scan.refusals, []);
  assert.deepEqual(scan.unconfirmed, []);
});

test('a cross-session message (isMeta user row) is neither a refusal nor an unconfirmed hit, and does not disturb the scan', () => {
  const meta = row('user', at(5), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: denial('[Merge Without Review]'), is_error: true }] }, { isMeta: true, toolDenialKind: 'automode-blocked' });
  const metaText = row('user', at(6), { role: 'user', content: denial('[CI Bypass]') }, { isMeta: true });
  const scan = scanTranscript(lines(attempt(at(0), 'a', 'gh pr merge 7 -R o/r'), meta, metaText, attempt(at(10), 'b', 'gh pr merge 8 -R o/r')), { sessionId: 's' });
  assert.deepEqual(scan.refusals.map((r) => r.pr.number), [7, 8]);
  assert.deepEqual(scan.unconfirmed, []);
});

test('block-array tool-result content and an "Error: " prefix are still read', () => {
  const blocks = toolResult(at(0), 'a', [{ type: 'text', text: `Error: ${denial('[Self-Modification]')}` }], true, { toolDenialKind: 'automode-blocked' });
  assert.deepEqual(scanTranscript(lines(blocks), { sessionId: 's' }).refusals.map((r) => r.category), ['Self-Modification']);
});

test('a tagged refusal with no bracketed reason is uncategorized, flagged when the refused command was gh pr merge', () => {
  const text = lines(
    attempt(at(0), 'a', 'gh pr merge 9 -R o/r --squash', 'Blocked by classifier'),
    attempt(at(1), 'b', 'git push --force', 'Blocked by classifier'),
    toolResult(at(2), 'c', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation)', true, { toolDenialKind: 'automode-blocked' }),
    toolResult(at(3), 'd', denial('[]'), true, { toolDenialKind: 'automode-blocked' }),
  );
  const refusals = scanTranscript(text, { sessionId: 's' }).refusals;
  assert.deepEqual(refusals.map((r) => r.category), [UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED]);
  assert.deepEqual(refusals.map((r) => r.refusedGhPrMerge), [true, false, false, false]);
});

test('the unavailable-verdict rows (automode-unavailable) are excluded by design, and counted so the footnote can say how many', () => {
  const unavailable = toolResult(at(0), 'a', 'The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash.', true, { toolDenialKind: 'automode-unavailable' });
  const scan = scanTranscript(lines(unavailable), { sessionId: 's' });
  assert.deepEqual(scan.refusals, []);
  assert.deepEqual(scan.unconfirmed, []);
  assert.equal(scan.unavailable, 1);
});

test('category names are trimmed and whitespace-collapsed, keeping their own words', () => {
  const text = lines(refusedResult(at(0), 'a', '[  Irreversible   Local Destruction ]'));
  assert.equal(scanTranscript(text, { sessionId: 's' }).refusals[0].category, 'Irreversible Local Destruction');
});

test('the transcript names its session: agent-name, agent-setting and the first cwd', () => {
  const text = lines(
    JSON.stringify({ type: 'agent-name', agentName: 'pl-endzone' }), JSON.stringify({ type: 'agent-setting', agentSetting: 'project-lead' }),
    row('user', at(0), { role: 'user', content: 'hi' }, { cwd: 'E:\\Nidus' }), attempt(at(1), 'a', 'gh pr merge 3'),
  );
  const scan = scanTranscript(text, { sessionId: 's' });
  assert.equal(scan.name, 'pl-endzone');
  assert.equal(scan.role, 'project-lead');
  assert.equal(scan.cwd, 'E:\\Nidus');
});

test('malformed lines are skipped', () => {
  const text = `not json\n${attempt(at(0), 'a', 'gh pr merge 1')}\n{"type":\n`;
  assert.equal(scanTranscript(text, { sessionId: 's' }).refusals.length, 1);
});

test('parseGhMerge: number and repo from -R / --repo / --repo= / a URL; the merge inside a chained command; none for other commands', () => {
  assert.deepEqual(parseGhMerge('gh pr merge 33 -R andydarknessb/Nidus --squash'), { number: 33, repo: 'andydarknessb/Nidus' });
  assert.deepEqual(parseGhMerge('gh pr merge --squash --repo o/r 44'), { number: 44, repo: 'o/r' });
  assert.deepEqual(parseGhMerge('gh pr merge 5 --repo=o/r'), { number: 5, repo: 'o/r' });
  assert.deepEqual(parseGhMerge('cd x && gh pr merge 6 --squash; gh pr view 6 -R other/repo'), { number: 6, repo: null });
  assert.deepEqual(parseGhMerge('gh pr merge https://github.com/o/r/pull/12 --squash'), { number: 12, repo: 'o/r' });
  assert.deepEqual(parseGhMerge('gh pr merge 1644 -R $R --squash'), { number: 1644, repo: null }, 'a shell variable is not a repo');
  assert.equal(parseGhMerge('gh pr view 33 -R o/r'), null);
  assert.equal(parseGhMerge('gh pr merge --auto'), null);
  assert.equal(parseGhMerge(undefined), null);
});

// -- scope: the fleet roster -------------------------------------------------------

function writeTranscripts() {
  const dir = scratch();
  const project = path.join(dir, 'proj');
  fs.mkdirSync(path.join(project, 'sess-live', 'subagents', 'workflows', 'wf_1'), { recursive: true });
  const named = (name, role) => [JSON.stringify({ type: 'agent-name', agentName: name }), JSON.stringify({ type: 'agent-setting', agentSetting: role })];
  fs.writeFileSync(path.join(project, 'sess-live.jsonl'), lines(
    ...named('pl-endzone', 'project-lead'),
    attempt('2026-10-01T10:00:00.000Z', 'a', `gh pr merge 100 -R ${REPO}`),
    attempt('2026-10-01T10:30:00.000Z', 'a2', `gh pr merge 100 -R ${REPO}`),
    attempt('2026-10-02T09:00:00.000Z', 'c', 'psql prod', '[Production Reads]'),
    toolResult('2026-10-02T09:30:00.000Z', 'u', 'The server-side auto mode classifier gave no verdict (error)', true, { toolDenialKind: 'automode-unavailable' }),
    row('assistant', '2026-10-02T10:00:00.000Z', { role: 'assistant', content: [{ type: 'text', text: denial('[Merge Without Review]') }] }),
    attempt('2026-09-20T10:00:00.000Z', 'f', `gh pr merge 90 -R ${REPO}`), // before the window
    attempt('2026-10-07T10:00:00.000Z', 'g', `gh pr merge 91 -R ${REPO}`), // after the window
  ));
  fs.writeFileSync(path.join(project, 'sess-live', 'subagents', 'agent-x1.jsonl'), lines(attempt('2026-10-03T08:00:00.000Z', 'h', `gh pr merge 101 -R ${REPO}`)));
  fs.writeFileSync(path.join(project, 'sess-live', 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl'), lines(attempt('2026-10-03T09:00:00.000Z', 'i', `gh pr merge 102 -R ${REPO}`)));
  fs.writeFileSync(path.join(project, 'sess-rotated.jsonl'), lines(...named('pl-endzone', 'project-lead'), attempt('2026-10-01T10:45:00.000Z', 'j', `gh pr merge 103 -R ${REPO}`)));
  fs.writeFileSync(path.join(project, 'sess-cory.jsonl'), lines(...named('x', 'y'), attempt('2026-10-04T08:00:00.000Z', 'k', `gh pr merge 200 -R ${REPO}`), attempt('2026-10-04T08:05:00.000Z', 'l', 'rm -rf x', '[Irreversible Local Destruction]')));
  fs.writeFileSync(path.join(project, 'sess-ancient.jsonl'), lines(attempt('2026-10-04T09:00:00.000Z', 'm', `gh pr merge 201 -R ${REPO}`)));
  return dir;
}

function rosterFixture() {
  return fleetHome({
    live: [rosterRow('pl-endzone', 'project-lead', 'sess-live', 'endzone')],
    retired: [
      rosterRow('pl-endzone', 'project-lead', 'sess-rotated', 'endzone', { launchedAt: '2026-09-20T00:00:00.000Z', retiredAt: '2026-10-02T00:00:00.000Z' }),
      rosterRow('pl-old', 'project-lead', 'sess-ancient', 'endzone', { launchedAt: '2026-08-01T00:00:00.000Z', retiredAt: '2026-08-02T00:00:00.000Z' }),
    ],
  });
}

test('loadFleetSessions: live roster plus retired rows overlapping the window, keyed by sessionId', () => {
  const sessions = loadFleetSessions({ fleetHome: rosterFixture(), since: SINCE, until: UNTIL });
  assert.deepEqual([...sessions.keys()].sort(), ['sess-live', 'sess-rotated']);
  assert.deepEqual(sessions.get('sess-live'), { name: 'pl-endzone', role: 'project-lead', tenant: 'endzone' });
});

test('collect: only roster sessions count; subagents and workflow subagents belong to their host; others only feed the outside-roster line', () => {
  const dir = writeTranscripts();
  const sessions = loadFleetSessions({ fleetHome: rosterFixture(), since: SINCE, until: UNTIL });
  const collected = collectRefusals({ transcriptsDir: dir, since: SINCE, fleetSessions: sessions });
  assert.equal(collected.filesScanned, 6);
  const report = buildReport(collected, { since: SINCE, until: UNTIL, merges: {} });
  // in-window roster refusals: 100 (twice), 101 (subagent), 102 (workflow subagent), 103 (rotated session)
  assert.equal(report.mergeWithoutReview.count, 5);
  assert.equal(report.mergeWithoutReview.prs.length, 4);
  assert.deepEqual(report.mergeWithoutReview.names, ['pl-endzone']);
  assert.equal(report.mergeWithoutReview.sessions, 2);
  assert.deepEqual(report.outsideRoster, { count: 2 }); // sess-cory 200 and sess-ancient 201
  assert.equal(report.categories.find((c) => c.category === 'Production Reads').count, 1);
  assert.ok(!report.categories.some((c) => c.category === 'Irreversible Local Destruction'), 'a non-roster session adds no category row');
  assert.equal(report.unavailable, 1);
});

test('files last written before --since are not read', () => {
  const dir = scratch();
  const file = path.join(dir, 'sess-live.jsonl');
  fs.writeFileSync(file, lines(attempt('2026-10-01T10:00:00.000Z', 'a', 'gh pr merge 1 -R o/r')));
  const old = new Date('2026-09-01T00:00:00Z');
  fs.utimesSync(file, old, old);
  const sessions = new Map([['sess-live', { name: 'pl-endzone', role: 'project-lead', tenant: 'endzone' }]]);
  assert.equal(collectRefusals({ transcriptsDir: dir, since: SINCE, fleetSessions: sessions }).filesScanned, 0);
});

test('the refused repo falls back to the roster tenant, then to the session cwd', () => {
  const home = fleetHome({ live: [rosterRow('pl-nidus', 'project-lead', 'sess-n', 'nidus')] });
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'sess-n.jsonl'), lines(attempt('2026-10-01T10:00:00.000Z', 'a', 'gh pr merge 44 --squash')));
  fs.writeFileSync(path.join(dir, 'sess-c.jsonl'), lines(row('user', '2026-10-01T09:00:00.000Z', { role: 'user', content: 'hi' }, { cwd: 'e:/endzone-empire/.claude/worktrees/ic-1' }), attempt('2026-10-01T10:00:00.000Z', 'b', 'gh pr merge 45 --squash')));
  const sessions = new Map([...loadFleetSessions({ fleetHome: home, since: SINCE, until: UNTIL }), ['sess-c', { name: 'ic-9', role: 'ic', tenant: null }]]);
  const tenants = { nidus: { github: 'andydarknessb/Nidus', repo: 'E:\\Nidus' }, endzone: { github: REPO, repo: 'E:\\Endzone-Empire' } };
  const collected = collectRefusals({ transcriptsDir: dir, since: SINCE, fleetSessions: sessions, tenants });
  const keys = prKeysToResolve(collected, { since: SINCE, until: UNTIL }).map((k) => mergeKey(k.repo, k.number)).sort();
  assert.deepEqual(keys, ['andydarknessb/endzone-empire#45', 'andydarknessb/nidus#44']);
});

// -- the Merge Without Review wait: refusal to PR merge --------------------------------

function scansFor(entries) {
  // entries: [{ sessionId, name, role, refusals: [[timestamp, prNumber], ...] }]
  const scans = entries.map(({ sessionId, name, role = 'project-lead', refusals }) => ({
    ...scanTranscript(lines(...refusals.map(([ts, number], i) => attempt(ts, `${sessionId}-${i}`, `gh pr merge ${number} -R ${REPO}`))), { sessionId }),
    sessionId, name, role, inRoster: true,
  }));
  return { scans, filesScanned: scans.length };
}
const merged = (number, mergedAt, mergedBy = 'andydarknessb-fleet') => [mergeKey(REPO, number), { state: 'MERGED', mergedAt, mergedBy }];
const DAY = { since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' };

test('wait is refusal to mergedAt: one interval per PR from its first refusal, with mergedBy printed', () => {
  const collected = scansFor([{ sessionId: 's1', name: 'pl-endzone', refusals: [['2026-10-01T10:00:00.000Z', 7], ['2026-10-01T10:20:00.000Z', 7]] }]);
  const mwr = buildReport(collected, { ...DAY, merges: Object.fromEntries([merged(7, '2026-10-01T12:00:00.000Z', 'andydarknessb')]) }).mergeWithoutReview;
  assert.equal(mwr.count, 2);
  assert.equal(mwr.prs.length, 1);
  assert.equal(mwr.prs[0].hours, 2);
  assert.equal(mwr.prs[0].mergedBy, 'andydarknessb');
  assert.equal(mwr.prs[0].firstRefusedAt, '2026-10-01T10:00:00.000Z');
  assert.equal(mwr.waitHours, 2);
});

test('session-hours are the union per roster name across sessionIds, not a sum over PRs or sessions', () => {
  const collected = scansFor([
    { sessionId: 's1', name: 'pl-endzone', refusals: [['2026-10-01T10:00:00.000Z', 1]] },
    { sessionId: 's2', name: 'pl-endzone', refusals: [['2026-10-01T11:00:00.000Z', 2]] }, // rotated: same roster name
    { sessionId: 's3', name: 'pl-nidus', refusals: [['2026-10-01T10:00:00.000Z', 3]] },
  ]);
  const merges = Object.fromEntries([merged(1, '2026-10-01T12:00:00.000Z'), merged(2, '2026-10-01T13:00:00.000Z'), merged(3, '2026-10-01T11:00:00.000Z')]);
  const mwr = buildReport(collected, { ...DAY, merges }).mergeWithoutReview;
  assert.deepEqual(mwr.perName, [{ name: 'pl-endzone', prs: 2, waitHours: 3 }, { name: 'pl-nidus', prs: 1, waitHours: 1 }]);
  assert.equal(mwr.waitHours, 4);
});

test('a PR still open at --until ends at --until and is counted as still open; a PR with no merge data is unresolved and costs nothing', () => {
  const collected = scansFor([{ sessionId: 's1', name: 'pl-endzone', refusals: [['2026-10-01T10:00:00.000Z', 1], ['2026-10-01T10:00:00.000Z', 2], ['2026-10-01T10:00:00.000Z', 3]] }]);
  const merges = { [mergeKey(REPO, 1)]: { state: 'OPEN', mergedAt: null, mergedBy: null }, [mergeKey(REPO, 2)]: { state: 'CLOSED', mergedAt: null, mergedBy: null } };
  const mwr = buildReport(collected, { since: '2026-10-01T00:00:00Z', until: '2026-10-01T16:00:00Z', merges }).mergeWithoutReview;
  assert.equal(mwr.stillOpen, 2); // open and closed-unmerged both run to --until
  assert.equal(mwr.unresolved, 1);
  assert.equal(mwr.waitHours, 6);
  assert.equal(mwr.prs.find((p) => p.number === 3).hours, 0);
});

test('a refused merge whose PR cannot be read from the command is unresolved', () => {
  const text = lines(attempt('2026-10-01T10:00:00.000Z', 'a', 'gh pr merge --auto'));
  const collected = { scans: [{ ...scanTranscript(text, { sessionId: 's' }), sessionId: 's', name: 'pl-endzone', role: 'project-lead', inRoster: true }], filesScanned: 1 };
  const mwr = buildReport(collected, { ...DAY, merges: {} }).mergeWithoutReview;
  assert.equal(mwr.count, 1);
  assert.equal(mwr.prs.length, 0);
  assert.equal(mwr.unresolved, 1);
  assert.equal(mwr.waitHours, 0);
});

test('a Merge Without Review refusal of a command that is not a PR merge (the classifier taints the follow-up reads) is a follow-on, not an unresolved PR', () => {
  const text = lines(attempt('2026-10-01T10:00:00.000Z', 'a', 'gh pr merge 7 -R o/r'), attempt('2026-10-01T10:01:00.000Z', 'b', 'cat memory/feedback_a_denied_merge.md'));
  const collected = { scans: [{ ...scanTranscript(text, { sessionId: 's' }), sessionId: 's', name: 'pl-endzone', role: 'project-lead', inRoster: true }], filesScanned: 1 };
  const mwr = buildReport(collected, { ...DAY, merges: { [mergeKey('o/r', 7)]: { state: 'MERGED', mergedAt: '2026-10-01T11:00:00.000Z', mergedBy: 'x' } } }).mergeWithoutReview;
  assert.equal(mwr.count, 2);
  assert.equal(mwr.followOn, 1);
  assert.equal(mwr.unresolved, 0);
  assert.equal(mwr.waitHours, 1);
});

test('window length and the Merge Without Review rate per 7 days', () => {
  const collected = scansFor([{ sessionId: 's1', name: 'pl-endzone', refusals: [['2026-10-01T10:00:00.000Z', 1]] }]);
  const report = buildReport(collected, { since: '2026-10-01T00:00:00Z', until: '2026-10-04T00:00:00Z', merges: Object.fromEntries([merged(1, '2026-10-01T13:00:00.000Z')]) });
  assert.equal(report.windowHours, 72);
  assert.equal(report.mergeWithoutReview.waitHours, 3);
  assert.equal(report.mergeWithoutReview.waitHoursPer7Days, 7); // 3 h over 3 days
});

test('the window includes both ends', () => {
  const collected = scansFor([{ sessionId: 's1', name: 'pl-endzone', refusals: [[SINCE, 1], [UNTIL, 2], ['2026-10-06T23:32:13.001Z', 3]] }]);
  assert.equal(buildReport(collected, { since: SINCE, until: UNTIL, merges: {} }).mergeWithoutReview.count, 2);
});

test('other categories report count, sessions and roster names, no wait; uncategorized rows carry the gh pr merge marker', () => {
  const text = lines(attempt(at(0), 'a', 'psql', '[Production Reads]'), attempt(at(1), 'b', 'gh pr merge 5 -R o/r', 'Blocked by classifier'), attempt(at(2), 'c', 'ls', 'Blocked by classifier'));
  const collected = { scans: [{ ...scanTranscript(text, { sessionId: 's' }), sessionId: 's', name: 'ic-9', role: 'ic', inRoster: true }], filesScanned: 1 };
  const report = buildReport(collected, { ...DAY, merges: {} });
  assert.deepEqual(report.categories.map((c) => c.category), [MERGE_CATEGORY, 'Production Reads', UNCATEGORIZED]);
  assert.deepEqual(report.categories[1], { category: 'Production Reads', count: 1, sessions: 1, names: ['ic-9'] });
  assert.equal(report.categories[2].count, 2);
  assert.equal(report.categories[2].refusedGhPrMerge, 1);
  assert.ok(!('waitHours' in report.categories[1]));
});

test('every refusal is listed with its roster name and role', () => {
  const collected = scansFor([{ sessionId: 's1', name: 'pl-nidus', role: 'project-lead', refusals: [['2026-10-01T10:00:00.000Z', 33]] }]);
  const report = buildReport(collected, { ...DAY, merges: {} });
  assert.deepEqual(report.refusals[0], { at: '2026-10-01T10:00:00.000Z', name: 'pl-nidus', role: 'project-lead', sessionId: 's1', category: MERGE_CATEGORY, pr: { number: 33, repo: REPO } });
});

// -- fetching merges ------------------------------------------------------------------

test('fetchMerges asks gh pr view per PR (injected runner) and reports a failed lookup as unresolved', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args.includes('9')) throw new Error('not found');
    return JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-01T12:00:00Z', mergedBy: { login: 'andydarknessb-fleet' } });
  };
  const { merges, errors } = fetchMerges([{ repo: 'o/r', number: 8 }, { repo: 'o/r', number: 9 }], { gh });
  assert.deepEqual(calls, ['pr view 8 -R o/r --json mergedAt,mergedBy,state', 'pr view 9 -R o/r --json mergedAt,mergedBy,state']);
  assert.deepEqual(merges[mergeKey('o/r', 8)], { state: 'MERGED', mergedAt: '2026-10-01T12:00:00.000Z', mergedBy: 'andydarknessb-fleet' });
  assert.equal(merges[mergeKey('o/r', 9)], undefined);
  assert.equal(errors.length, 1);
});

test('without GitHub, the pr-watch state-merged event supplies the merge time and merger', () => {
  const home = fleetHome({
    events: [
      { type: 'state-merged', recordId: 'nidus:issue-30', at: '2026-10-01T11:44:00.000Z', evidence: 'observed merged at 2026-10-01T11:42:47Z (gh pr view 44) by andydarknessb-fleet', changes: { prNumber: 44, mergedBy: 'andydarknessb-fleet' } },
      { type: 'state-review', recordId: 'nidus:issue-31', at: '2026-10-01T11:45:00.000Z', changes: { prNumber: 45 } },
    ],
  });
  const tenants = { nidus: { github: 'andydarknessb/Nidus' } };
  const { merges } = fetchMerges([{ repo: 'andydarknessb/Nidus', number: 44 }, { repo: 'andydarknessb/Nidus', number: 45 }], { gh: null, fleetHome: home, tenants });
  assert.deepEqual(merges[mergeKey('andydarknessb/Nidus', 44)], { state: 'MERGED', mergedAt: '2026-10-01T11:42:47.000Z', mergedBy: 'andydarknessb-fleet' });
  assert.equal(merges[mergeKey('andydarknessb/Nidus', 45)], undefined);
});

// -- the CLI -------------------------------------------------------------------------

function cliFixture() {
  const home = rosterFixture();
  const dir = writeTranscripts();
  const gh = (args) => {
    const mergedAt = { 100: '2026-10-01T12:00:00Z', 101: '2026-10-03T09:00:00Z', 102: '2026-10-03T10:30:00Z' }[Number(args[2])];
    if (!mergedAt) return JSON.stringify({ state: 'OPEN', mergedAt: null, mergedBy: null });
    return JSON.stringify({ state: 'MERGED', mergedAt, mergedBy: { login: 'andydarknessb-fleet' } });
  };
  return { argv: ['--fleet-home', home, '--transcripts', dir, '--since', SINCE, '--until', UNTIL], gh };
}

test('default output is a Markdown report; --json prints the same figures as JSON', () => {
  const { argv, gh } = cliFixture();
  const markdown = cli(argv, { gh });
  assert.match(markdown, /\| Category \| Refusals \| Sessions \| Roster names \|/);
  assert.match(markdown, /\| Merge Without Review \| 5 \| 2 \| pl-endzone \|/);
  assert.match(markdown, /\| Production Reads \| 1 \| 1 \| pl-endzone \|/);
  assert.ok(markdown.includes(`| ${OUTSIDE_ROSTER_LABEL} | 2 |`), 'outside-roster line with a count only');
  assert.match(markdown, /andydarknessb-fleet/);
  assert.match(markdown, /#100/);
  assert.match(markdown, /automode-unavailable/);
  assert.ok(!markdown.includes('\u2014'), 'no em-dashes in output');
  const parsed = JSON.parse(cli([...argv, '--json'], { gh }));
  assert.equal(parsed.since, SINCE);
  assert.equal(parsed.mergeWithoutReview.count, 5);
  assert.equal(parsed.mergeWithoutReview.stillOpen, 1); // 103 is open at --until
  assert.equal(parsed.mergeWithoutReview.prs.find((p) => p.number === 100).hours, 2);
  assert.equal(renderMarkdown(parsed), markdown);
});

test('--no-verify-github never calls gh and falls back to the events ledger', () => {
  const home = fleetHome({
    live: [rosterRow('pl-endzone', 'project-lead', 'sess-live', 'endzone')],
    events: [{ type: 'state-merged', recordId: 'endzone:issue-1', at: '2026-10-01T12:02:00.000Z', evidence: 'observed merged at 2026-10-01T12:00:00Z (gh pr view 100) by andydarknessb-fleet', changes: { prNumber: 100, mergedBy: 'andydarknessb-fleet' } }],
  });
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'sess-live.jsonl'), lines(attempt('2026-10-01T10:00:00.000Z', 'a', `gh pr merge 100 -R ${REPO}`)));
  const parsed = JSON.parse(cli(['--fleet-home', home, '--transcripts', dir, '--since', SINCE, '--until', UNTIL, '--no-verify-github', '--json'], { gh: () => { throw new Error('gh must not run'); } }));
  assert.equal(parsed.mergeWithoutReview.waitHours, 2);
});

test('--since and --until without an offset are UTC', () => {
  const { argv, gh } = cliFixture();
  const bare = argv.map((value) => (value === SINCE ? '2026-09-29T23:32:13' : (value === UNTIL ? '2026-10-06T23:32:13' : value)));
  const parsed = JSON.parse(cli([...bare, '--json'], { gh }));
  assert.equal(parsed.since, '2026-09-29T23:32:13.000Z');
  assert.equal(parsed.until, '2026-10-06T23:32:13.000Z');
});

test('--until defaults to now', () => {
  const { argv, gh } = cliFixture();
  const open = argv.filter((value, i) => value !== '--until' && argv[i - 1] !== '--until');
  const parsed = JSON.parse(cli([...open, '--json'], { gh, now: () => new Date('2026-10-05T00:00:00Z') }));
  assert.equal(parsed.until, '2026-10-05T00:00:00.000Z');
});

test('usage errors: missing --since, unparseable dates, until before since, unknown flag', () => {
  for (const argv of [[], ['--since', 'yesterday'], ['--since', SINCE, '--until', 'x'], ['--since', SINCE, '--until', '2020-01-01T00:00:00Z'], ['--since', SINCE, '--bogus', '1']]) {
    assert.throws(() => cli(argv), (error) => error.code === 'USAGE', JSON.stringify(argv));
  }
  for (const flag of ['json', 'fleet-home', 'no-verify-github']) assert.ok(REFUSAL_REPORT_FLAGS.includes(flag), flag);
});
