const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildCycleRecords,
  classifyTurns,
  parseTranscript,
  renderSummary,
  buildReport,
  cli,
  collectFromFiles,
  MEASURE_CYCLE_FLAGS,
  MeasureCycleError,
} = require('../bin/measure-cycle');

function line(value) {
  return JSON.stringify(value);
}

function assistant({ uuid, timestamp, content, usage, model = 'claude-sonnet-5' }) {
  return {
    type: 'assistant',
    uuid,
    timestamp,
    sessionId: 'session-1',
    message: {
      model,
      role: 'assistant',
      content,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_creation_input_tokens: usage.creation || 0,
        cache_read_input_tokens: usage.read || 0,
      },
    },
  };
}

function toolUse(id, command) {
  return { type: 'tool_use', id, name: 'Bash', input: { command } };
}

function toolResult(id, content) {
  return {
    type: 'user',
    sessionId: 'session-1',
    timestamp: '2026-09-01T00:00:01.500Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  };
}

function fixtureTranscript() {
  return [
    { type: 'custom-title', customTitle: 'ic-42', sessionId: 'session-1' },
    { type: 'agent-setting', agentSetting: 'ic', sessionId: 'session-1' },
    { type: 'user', sessionId: 'session-1', message: { role: 'user', content: 'Implement issue #42.' } },
    assistant({
      uuid: 'a1',
      timestamp: '2026-09-01T00:00:00.000Z',
      content: [toolUse('t1', 'gh pr view 77 --json state')],
      usage: { input: 10, output: 5, creation: 100 },
    }),
    toolResult('t1', 'OPEN'),
    assistant({
      uuid: 'a2',
      timestamp: '2026-09-01T00:00:01.000Z',
      content: [toolUse('t2', 'gh pr view 77 --json state')],
      usage: { input: 11, output: 4, read: 50 },
    }),
    toolResult('t2', 'OPEN'),
    assistant({
      uuid: 'a3',
      timestamp: '2026-09-01T00:00:02.000Z',
      content: [toolUse('t3', 'gh pr checks 77')],
      usage: { input: 12, output: 6 },
    }),
    toolResult('t3', 'test-build SUCCESS (changed)'),
    assistant({
      uuid: 'a4',
      timestamp: '2026-09-01T00:00:03.000Z',
      content: [{ type: 'text', text: 'Standards and Spec review passed. PR #77 merged.' }],
      usage: { input: 13, output: 7 },
    }),
    {
      type: 'system',
      subtype: 'stop_hook_summary',
      preventedContinuation: true,
      timestamp: '2026-09-01T00:00:04.000Z',
    },
    { type: 'system', subtype: 'turn_duration', durationMs: 4000 },
  ].map(line).join('\n');
}

test('parseTranscript records usage, model, messages, review, PR, and stop-hook evidence', () => {
  const parsed = parseTranscript(fixtureTranscript(), 'fixture/session-1.jsonl');

  assert.equal(parsed.name, 'ic-42');
  assert.equal(parsed.role, 'ic');
  assert.equal(parsed.model, 'claude-sonnet-5');
  assert.equal(parsed.assistantMessages, 4);
  assert.equal(parsed.userMessages, 1);
  assert.equal(parsed.usage.inputTokens, 46);
  assert.equal(parsed.usage.outputTokens, 22);
  assert.equal(parsed.usage.cacheCreationInputTokens, 100);
  assert.equal(parsed.usage.cacheReadInputTokens, 50);
  assert.equal(parsed.firstUsefulTurnCacheCreationInputTokens, 100);
  assert.equal(parsed.toolCallsByCommandClass['github-pr-view'], 2);
  assert.equal(parsed.toolCallsByCommandClass['github-pr-checks'], 1);
  assert.equal(parsed.pullRequests[0], 77);
  assert.equal(parsed.merged, true);
  assert.deepEqual(parsed.mergeEvents, [{ number: 77, timestamp: '2026-09-01T00:00:03.000Z', source: 'transcript', turnId: 'a4' }]);
  assert.equal(parsed.forcedContinuationTurns, 1);
  assert.equal(parsed.formalReviewPasses, 1);
  assert.equal(parsed.wallTimeMs, 4000);
});

test('first useful turn skips an empty startup acknowledgement', () => {
  const parsed = parseTranscript([
    { type: 'custom-title', customTitle: 'ic-9', sessionId: 'session-9' },
    assistant({
      uuid: 'greeting', timestamp: '2026-09-01T00:00:00.000Z',
      content: [{ type: 'text', text: 'I am ready.' }],
      usage: { input: 1, output: 1, creation: 999 },
    }),
    assistant({
      uuid: 'useful', timestamp: '2026-09-01T00:00:01.000Z',
      content: [toolUse('useful-tool', 'gh pr view 9')],
      usage: { input: 2, output: 1, creation: 100 },
    }),
    toolResult('useful-tool', 'OPEN'),
  ].map(line).join('\n'), 'fixture/session-9.jsonl');

  assert.equal(parsed.firstUsefulTurnCacheCreationInputTokens, 100);
});

test('command classes cover workflow categories and retain an explicit fallback', () => {
  const parsed = parseTranscript([
    { type: 'custom-title', customTitle: 'ic-9', sessionId: 'session-9' },
    { type: 'agent-setting', agentSetting: 'ic', sessionId: 'session-9' },
    assistant({
      uuid: 'classes', timestamp: '2026-09-01T00:00:00.000Z',
      content: [
        { type: 'tool_use', id: 'a', name: 'SendMessage', input: {} },
        { type: 'tool_use', id: 'b', name: 'Skill', input: {} },
        { type: 'tool_use', id: 'c', name: 'Task', input: {} },
        { type: 'tool_use', id: 'd', name: 'Bash', input: { command: 'gh pr merge 77' } },
        { type: 'tool_use', id: 'e', name: 'Bash', input: { command: 'git status --short' } },
        { type: 'tool_use', id: 'f', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 'g', name: 'Bash', input: { command: 'powershell -File check.ps1' } },
        { type: 'tool_use', id: 'h', name: 'Write', input: { file_path: 'artifact.md' } },
      ],
      usage: { input: 1, output: 1 },
    }),
  ].map(line).join('\n'), 'fixture/classes.jsonl');

  assert.equal(parsed.toolCallsByCommandClass['send-message'], 1);
  assert.equal(parsed.toolCallsByCommandClass.skill, 1);
  assert.equal(parsed.toolCallsByCommandClass.worker, 1);
  assert.equal(parsed.toolCallsByCommandClass['github-pr-mutation'], 1);
  assert.equal(parsed.toolCallsByCommandClass['git-status'], 1);
  assert.equal(parsed.toolCallsByCommandClass['test-or-build'], 1);
  assert.equal(parsed.toolCallsByCommandClass.script, 1);
  assert.equal(parsed.toolCallsByCommandClass.other, 1);
});

test('classifyTurns distinguishes repeated polling from a changed GitHub fact', () => {
  const parsed = parseTranscript(fixtureTranscript(), 'fixture/session-1.jsonl');
  const turns = classifyTurns(parsed.turns);

  assert.equal(turns[0].pollingOnly, false);
  assert.equal(turns[1].pollingOnly, true);
  assert.equal(turns[2].pollingOnly, false);
  assert.equal(turns.filter((turn) => turn.pollingOnly).length, 1);
});

test('classifyTurns does not hide review, event, transition, or artifact signals', () => {
  const poll = (id, result, extraTools = []) => ({
    id,
    text: '',
    toolCalls: [{ name: 'Bash', input: { command: 'gh pr view 77' }, resultText: result }, ...extraTools],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  });
  const turns = classifyTurns([
    poll('first', 'OPEN'),
    poll('repeat', 'OPEN'),
    poll('review', 'OPEN; new finding'),
    poll('event', 'OPEN; Fleet event seq 2'),
    poll('transition', 'OPEN; state transition'),
    poll('artifact', 'OPEN', [{ name: 'Write', input: { file_path: 'report.md' }, resultText: 'written' }]),
  ]);

  assert.deepEqual(turns.map((turn) => turn.pollingOnly), [false, true, false, false, false, false]);
});

test('buildCycleRecords emits only complete retired units and reports exclusions', () => {
  const transcript = parseTranscript(fixtureTranscript(), 'fixture/session-1.jsonl');
  const roster = {
    sessions: [
      {
        name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42, model: 'sonnet',
        status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1',
      },
      {
        name: 'ic-43', role: 'ic', tenant: 'endzone', issue: 43,
        status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'missing',
      },
    ],
  };
  const result = buildCycleRecords({
    roster,
    transcripts: [transcript],
    pullRequestStates: { 'endzone:77': { state: 'MERGED', mergedAt: '2026-09-01T00:00:04.000Z' } },
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.records[0].issue, 42);
  assert.equal(result.records[0].tenant, 'endzone');
  assert.deepEqual(result.records[0].pullRequests, [77]);
  assert.equal(result.records[0].retiredAt, '2026-09-01T00:01:00.000Z');
  assert.equal(result.records[0].metrics.pollingOnlyTurns, 1);
});

test('buildCycleRecords requires an authoritative merged PR state when supplied', () => {
  const transcript = parseTranscript(fixtureTranscript(), 'fixture/session-1.jsonl');
  const roster = {
    sessions: [{
      name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42,
      status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1',
    }],
  };
  const merged = buildCycleRecords({
    roster,
    transcripts: [transcript],
    pullRequestStates: { 'endzone:77': { state: 'MERGED', mergedAt: '2026-09-01T00:00:04.000Z' } },
  });
  const open = buildCycleRecords({
    roster,
    transcripts: [transcript],
    pullRequestStates: { 'endzone:77': { state: 'OPEN', mergedAt: null } },
    verificationErrors: { 'endzone:77': 'GitHub PR state is OPEN; mergedAt is required' },
  });
  const githubOnly = buildCycleRecords({
    roster,
    transcripts: [{ ...transcript, merged: false, mergeEvents: [] }],
    pullRequestStates: { 'endzone:77': { state: 'MERGED', mergedAt: '2026-09-01T00:00:04.000Z' } },
  });
  const unverified = buildCycleRecords({ roster, transcripts: [transcript] });

  assert.equal(merged.records[0].mergeVerification, 'github');
  assert.deepEqual(merged.records[0].mergeEvents, [{ number: 77, state: 'MERGED', mergedAt: '2026-09-01T00:00:04.000Z', source: 'github' }]);
  assert.equal(open.records.length, 0);
  assert.equal(open.excluded[0].reason, 'github-merge-unverified');
  assert.deepEqual(open.excluded[0].verificationErrors, ['GitHub PR state is OPEN; mergedAt is required']);
  assert.equal(githubOnly.records.length, 1);
  assert.equal(unverified.records.length, 0);
  assert.equal(unverified.excluded[0].reason, 'github-merge-unverified');
});

test('buildReport and renderSummary keep cache-read tokens separate and are deterministic', () => {
  const parsed = parseTranscript(fixtureTranscript(), 'fixture/session-1.jsonl');
  const roster = {
    sessions: [{
      name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42,
      status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1',
    }],
  };
  const { records } = buildCycleRecords({
    roster,
    transcripts: [parsed],
    pullRequestStates: { 'endzone:77': { state: 'MERGED', mergedAt: '2026-09-01T00:00:04.000Z' } },
  });
  const options = { generatedAt: '2026-09-01T12:00:00.000Z', since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z' };
  const first = buildReport(records, [], options);
  const second = buildReport(records, [], options);

  assert.deepEqual(first, second);
  assert.equal(first.metrics.freshTokens, 168);
  assert.equal(first.metrics.cacheReadTokens, 50);
  assert.equal(first.metrics.controlPlaneFreshTokens, 0);
  assert.equal(first.metrics.icFreshTokens, 168);
  assert.equal(first.metrics.toolCallsByCommandClass['github-pr-view'], 2);
  assert.equal(first.metrics.freshTokens + first.metrics.cacheReadTokens, 218);
  assert.match(renderSummary(first), /cache-read tokens: 50/);
  assert.match(renderSummary(first), /polling-only model turns: 1/);
});

test('buildCycleRecords and buildReport retain control-plane session metrics separately', () => {
  const ic = parseTranscript(fixtureTranscript(), 'fixture/ic-42.jsonl');
  const dispatcher = parseTranscript([
    { type: 'custom-title', customTitle: 'dispatcher', sessionId: 'dispatcher-1' },
    { type: 'agent-setting', agentSetting: 'dispatcher', sessionId: 'dispatcher-1' },
    assistant({
      uuid: 'd1', timestamp: '2026-09-01T00:00:00.000Z',
      content: [{ type: 'text', text: 'Daily digest complete.' }],
      usage: { input: 20, output: 2, creation: 3, read: 4 }, model: 'claude-sonnet-5',
    }),
  ].map(line).join('\n'), 'fixture/dispatcher-1.jsonl');
  const roster = {
    sessions: [{
      name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42,
      status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1',
    }],
  };
  const cycles = buildCycleRecords({
    roster,
    transcripts: [ic, dispatcher],
    pullRequestStates: { 'endzone:77': { state: 'MERGED', mergedAt: '2026-09-01T00:00:04.000Z' } },
  });
  const report = buildReport(cycles.records, cycles.excluded, {
    generatedAt: '2026-09-01T12:00:00.000Z',
    since: '2026-09-01T00:00:00.000Z',
    until: '2026-09-02T00:00:00.000Z',
    sessionMetrics: cycles.sessionMetrics,
  });

  assert.equal(cycles.sessionMetrics.length, 2);
  assert.equal(report.metrics.controlPlaneFreshTokens, 25);
  assert.equal(report.metrics.controlPlaneCacheReadTokens, 4);
  assert.equal(report.metrics.freshTokens, 193);
  assert.equal(report.metrics.cacheReadTokens, 54);
  assert.equal(report.roles.dispatcher.sessions, 1);
  assert.equal(report.roles.dispatcher.metrics.freshTokens, 25);
});

test('collectFromFiles writes stable daily JSON and summary artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cycle-'));
  const transcripts = path.join(root, 'transcripts');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(transcripts, 'project-worktree'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roster.json'), JSON.stringify({ sessions: [{
    name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42,
    status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1',
  }] }));
  fs.writeFileSync(path.join(transcripts, 'project-worktree', 'session-1.jsonl'), fixtureTranscript());
  const options = {
    transcriptsDir: transcripts,
    rosterPath: path.join(root, 'roster.json'),
    outputDir: output,
    since: '2026-09-01T00:00:00.000Z',
    until: '2026-09-02T00:00:00.000Z',
    generatedAt: '2026-09-01T12:00:00.000Z',
    verifyGithub: false,
  };
  const first = collectFromFiles(options);
  const jsonFirst = fs.readFileSync(first.dailyArtifact, 'utf8');
  const summaryFirst = fs.readFileSync(first.summaryArtifact, 'utf8');
  const second = collectFromFiles(options);

  assert.equal(first.report.sample.completedUnits, 1);
  assert.equal(path.basename(first.dailyArtifact), 'daily-2026-09-02.json');
  assert.equal(path.basename(first.summaryArtifact), 'seven-day-2026-09-02.md');
  assert.equal(jsonFirst, fs.readFileSync(second.dailyArtifact, 'utf8'));
  assert.equal(summaryFirst, fs.readFileSync(second.summaryArtifact, 'utf8'));

  const inferred = collectFromFiles({
    transcriptsDir: transcripts,
    rosterPath: path.join(root, 'roster.json'),
    outputDir: output,
    verifyGithub: false,
  });
  const inferredDaily = JSON.parse(fs.readFileSync(inferred.dailyArtifact, 'utf8'));
  assert.equal(inferredDaily.sample.completedUnits, 1);
  assert.equal(inferredDaily.period.since, '2026-08-31T00:01:00.001Z');
  assert.equal(inferred.report.period.since, '2026-08-25T00:01:00.001Z');
});

// Ticket 09: the per-unit figures the spec's budgets are stated in, and their verdicts.
test('buildReport computes per-unit ratios, the IC median, and budget verdicts', () => {
  const unitOf = (issue, job, fresh) => ({ tenant: 'endzone', issue, session: `ic-${issue}`, role: 'ic', merged: true, completedAt: '2026-09-09T00:00:00.000Z', metrics: { freshTokens: fresh, jobTokens: job, cacheReadInputTokens: 0 } });
  const units = [unitOf(1, 40000, 100000), unitOf(2, 55000, 120000), unitOf(3, 70000, 200000)];
  const sessions = [
    { sessionId: 'pl', name: 'pl-endzone', role: 'project-lead', metrics: { freshTokens: 60000, cacheReadInputTokens: 5 } },
    { sessionId: 'd', name: 'dispatcher', role: 'dispatcher', metrics: { freshTokens: 30000, cacheReadInputTokens: 5 } },
  ];
  const report = buildReport(units, [{ reason: 'abandoned' }, { reason: 'abandoned' }, { reason: 'no-pr' }], {
    sessionMetrics: sessions,
    budgets: { baselineControlPlaneFreshPerCompletedUnit: 200000, controlPlaneFreshReduction: 0.7, projectLeadFreshPerMergedPr: 25000, icJobTokensMedian: 60000 },
  });
  const u = report.unitMetrics;
  assert.equal(u.completedUnits, 3);
  assert.equal(u.controlPlaneFreshPerCompletedUnit, 30000, '(60000 + 30000) / 3');
  assert.equal(u.projectLeadFreshPerMergedPr, 20000);
  assert.equal(u.icJobTokensMedian, 55000);
  assert.equal(u.icJobTokensP90, 70000);
  assert.equal(u.icFreshTokensMedian, 120000);
  assert.equal(u.controlPlaneFreshReductionVsBaseline, 0.85);
  assert.equal(u.budgets.controlPlaneFreshReduction.pass, true);
  assert.equal(u.budgets.projectLeadFreshPerMergedPr.pass, true);
  assert.equal(u.budgets.icJobTokensMedian.pass, null, '#128: the IC median is reported, not judged');
  assert.equal(u.budgets.icJobTokensMedian.reference, 60000);
  assert.deepEqual(report.sample.excludedByReason, { abandoned: 2, 'no-pr': 1 });
  const empty = buildReport([], [], { sessionMetrics: sessions, budgets: { icJobTokensMedian: 60000 } });
  assert.equal(empty.unitMetrics.controlPlaneFreshPerCompletedUnit, null, 'no units: no ratio, no verdict');
  assert.equal(empty.unitMetrics.budgets.icJobTokensMedian.pass, null);
  const text = renderSummary(report);
  assert.match(text, /^IC job tokens median: 55000 \(p90 70000; reference 60000, not a verdict\)$/m);
  assert.match(text, /project-lead fresh per merged PR: 20000 over 3 merged PR\(s\) \(limit 25000; per completed unit 20000\) PASS/);
  assert.match(text, /reduction vs baseline 85%, target 70%/);
  // Merged PRs are counted from merge events, and the median is a true median on an even count.
  const withPrs = [
    { ...unitOf(4, 10, 10), mergeEvents: [{ number: 900, mergedAt: 'x' }, { number: 901, mergedAt: 'x' }] },
    { ...unitOf(5, 90, 10), mergeEvents: [{ number: 902, mergedAt: 'x' }] },
  ];
  const counted = buildReport(withPrs, [], { sessionMetrics: sessions, budgets: {} });
  assert.equal(counted.unitMetrics.mergedPullRequests, 3);
  assert.equal(counted.unitMetrics.projectLeadFreshPerMergedPr, 20000, '60000 / 3 PRs');
  assert.equal(counted.unitMetrics.projectLeadFreshPerCompletedUnit, 30000, '60000 / 2 units');
  assert.equal(counted.unitMetrics.icJobTokensMedian, 50, 'mean of the two middle values');
});

// Amendment 9: terminal classifications instead of a permanent "unverified" bucket.
test('buildCycleRecords classifies a closed-unmerged unit as abandoned and an unreturned PR as no-pr', () => {
  const transcript = parseTranscript(fixtureTranscript(), 'C:/t/session-1.jsonl');
  const [prNumber] = transcript.pullRequests;
  assert.ok(prNumber, 'the fixture transcript names a pull request');
  const roster = { sessions: [
    { name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42, status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1' },
  ] };
  const key = `endzone:${prNumber}`;
  const closed = buildCycleRecords({ roster, transcripts: [transcript], pullRequestStates: { [key]: { state: 'CLOSED', mergedAt: null } }, verificationErrors: { [key]: 'GitHub PR state is CLOSED; mergedAt is required' } });
  assert.equal(closed.records.length, 0);
  assert.equal(closed.excluded[0].reason, 'abandoned');
  assert.equal(closed.excluded[0].terminal, true);
  assert.deepEqual(closed.excluded[0].verificationErrors, []);
  const missing = buildCycleRecords({ roster, transcripts: [transcript], pullRequestStates: { [key]: { state: 'UNKNOWN', mergedAt: null, error: 'PR not returned by GitHub' } }, verificationErrors: { [key]: 'PR not returned by GitHub' } });
  assert.equal(missing.excluded[0].reason, 'no-pr');
  const readFailed = buildCycleRecords({ roster, transcripts: [transcript], pullRequestStates: { [key]: { state: 'UNKNOWN', mergedAt: null, error: 'gh exited 1' } }, verificationErrors: { [key]: 'gh exited 1' } });
  assert.equal(readFailed.excluded[0].reason, 'github-merge-unverified', 'a read failure is retried, not classified');
  assert.equal(readFailed.excluded[0].terminal, false);
});

test('the seven-day report names its own window and is persisted as JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cycle-'));
  const transcripts = path.join(root, 'transcripts');
  fs.mkdirSync(path.join(transcripts, 'p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roster.json'), JSON.stringify({ sessions: [{ name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42, status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1' }] }));
  fs.writeFileSync(path.join(transcripts, 'p', 'session-1.jsonl'), fixtureTranscript());
  fs.writeFileSync(path.join(root, 'cycle.json'), JSON.stringify({ budgets: { icJobTokensMedian: 60000 } }));
  const result = collectFromFiles({ transcriptsDir: transcripts, rosterPath: path.join(root, 'roster.json'), outputDir: path.join(root, 'out'), since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z', generatedAt: '2026-09-01T12:00:00.000Z', verifyGithub: false, configPath: path.join(root, 'cycle.json') });
  assert.equal(result.dailyReport.period.since, '2026-09-01T00:00:00.000Z', 'the daily report keeps the requested since');
  assert.equal(result.report.period.since, '2026-08-26T00:00:00.000Z', 'the seven-day report names its real seven-day window');
  assert.equal(path.basename(result.summaryJsonArtifact), 'seven-day-2026-09-02.json');
  const json = JSON.parse(fs.readFileSync(result.summaryJsonArtifact, 'utf8'));
  assert.equal(json.unitMetrics.completedUnits, 1);
  assert.equal(json.unitMetrics.budgets.icJobTokensMedian.reference, 60000);
});

// --- fleet#4: adopt the parseArgs flag schema ---------------------------------------
// Red-tell: with bin/measure-cycle.js reverted to its old hand-rolled parseArgs (no
// schema), --transcript (singular, confusable with --transcripts) is silently ignored
// instead of throwing.

test('cli: refuses --transcript (confusable with --transcripts) as an unknown flag', () => {
  assert.throws(() => cli(['--transcript', 'x', '--no-verify-github', 'true']), (error) => {
    assert.ok(error instanceof MeasureCycleError, `expected MeasureCycleError, got ${error && error.name}`);
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /unknown flag --transcript\b/);
    for (const flag of MEASURE_CYCLE_FLAGS) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('cli: a correct invocation still works, matching the direct call', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cycle-'));
  const transcripts = path.join(root, 'transcripts');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(transcripts, 'project-worktree'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roster.json'), JSON.stringify({ sessions: [{
    name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42,
    status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1',
  }] }));
  fs.writeFileSync(path.join(transcripts, 'project-worktree', 'session-1.jsonl'), fixtureTranscript());
  const argv = [
    '--transcripts', transcripts,
    '--roster', path.join(root, 'roster.json'),
    '--out', output,
    '--since', '2026-09-01T00:00:00.000Z',
    '--until', '2026-09-02T00:00:00.000Z',
    '--now', '2026-09-01T12:00:00.000Z',
    '--no-verify-github', 'true',
  ];
  const viaCli = cli(argv);
  assert.equal(viaCli.report.sample.completedUnits, 1);
  assert.equal(path.basename(viaCli.dailyArtifact), 'daily-2026-09-02.json');
  assert.equal(path.basename(viaCli.summaryArtifact), 'seven-day-2026-09-02.md');
});

// --- WS5 (#91) fixtures: one transcript per session, parameterised -------------------
// A session transcript named `name` with role `role`, one assistant turn at `at` on
// `model` that merges `pr` (so an IC session reads as a merged unit).
function sessionTranscript({ sessionId, name, role = 'ic', model = 'claude-sonnet-5', at = '2026-09-01T00:00:00.000Z', input = 100, output = 10, creation = 0, pr = null }) {
  return [
    { type: 'custom-title', customTitle: name, sessionId },
    { type: 'agent-setting', agentSetting: role, sessionId },
    { ...assistant({ uuid: `${sessionId}-a1`, timestamp: at, content: [{ type: 'text', text: pr ? `Standards and Spec review passed. PR #${pr} merged.` : 'Turn complete.' }], usage: { input, output, creation }, model }), sessionId },
  ].map(line).join('\n');
}

function icRow(issue, sessionId, extra = {}) {
  return { name: `ic-${issue}`, role: 'ic', tenant: 'endzone', issue, status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId, ...extra };
}

// --- #124: one model key per model family --------------------------------------------
// Red-tell: before the change a unit on `sonnet` and one on `claude-sonnet-5` report
// two rows.
const { modelFamily } = require('../bin/measure-cycle');

test('#124: modelFamily folds aliases and full ids onto one family key and keeps unknowns as written', () => {
  assert.deepEqual(modelFamily('sonnet'), { key: 'sonnet', recognized: true });
  assert.deepEqual(modelFamily('claude-sonnet-5'), { key: 'sonnet', recognized: true });
  assert.deepEqual(modelFamily('claude-opus-5-5[1m]'), { key: 'opus', recognized: true });
  assert.deepEqual(modelFamily('Opus'), { key: 'opus', recognized: true });
  assert.deepEqual(modelFamily('claude-haiku-4-5-20251001'), { key: 'haiku', recognized: true });
  assert.deepEqual(modelFamily('fable'), { key: 'fable', recognized: true });
  assert.deepEqual(modelFamily('claude-fable-5-1'), { key: 'fable', recognized: true });
  assert.deepEqual(modelFamily('gpt-9-turbo'), { key: 'gpt-9-turbo', recognized: false });
  assert.deepEqual(modelFamily(null), { key: 'unknown', recognized: false });
  assert.deepEqual(modelFamily(''), { key: 'unknown', recognized: false });
});

test('#124: a unit on `sonnet` and one on `claude-sonnet-5` report one sonnet row carrying both', () => {
  const a = parseTranscript(sessionTranscript({ sessionId: 's-a', name: 'ic-1', model: 'sonnet', pr: 101 }), 'fixture/s-a.jsonl');
  const b = parseTranscript(sessionTranscript({ sessionId: 's-b', name: 'ic-2', model: 'claude-sonnet-5', pr: 102 }), 'fixture/s-b.jsonl');
  const cycles = buildCycleRecords({
    roster: { sessions: [icRow(1, 's-a'), icRow(2, 's-b')] },
    transcripts: [a, b],
    pullRequestStates: { 'endzone:101': { state: 'MERGED', mergedAt: '2026-09-01T00:00:30.000Z' }, 'endzone:102': { state: 'MERGED', mergedAt: '2026-09-01T00:00:30.000Z' } },
  });
  const report = buildReport(cycles.records, cycles.excluded, { sessionMetrics: cycles.sessionMetrics });
  assert.deepEqual(Object.keys(report.byModel), ['sonnet']);
  assert.equal(report.byModel.sonnet.units, 2);
  assert.equal(report.byModel.sonnet.sessions, 2);
  assert.deepEqual(report.units.map((u) => [u.model, u.modelRaw]), [['sonnet', 'sonnet'], ['sonnet', 'claude-sonnet-5']]);
  assert.deepEqual(report.sessions.map((s) => s.model), ['sonnet', 'sonnet']);
  assert.deepEqual(report.unrecognizedModels, []);
});

test('#124: an unknown model string is kept as written and listed under unrecognized with its unit count', () => {
  const a = parseTranscript(sessionTranscript({ sessionId: 's-a', name: 'ic-1', model: 'gpt-9-turbo', pr: 101 }), 'fixture/s-a.jsonl');
  const cycles = buildCycleRecords({
    roster: { sessions: [icRow(1, 's-a')] },
    transcripts: [a],
    pullRequestStates: { 'endzone:101': { state: 'MERGED', mergedAt: '2026-09-01T00:00:30.000Z' } },
  });
  const report = buildReport(cycles.records, cycles.excluded, { sessionMetrics: cycles.sessionMetrics });
  assert.equal(report.byModel['gpt-9-turbo'].units, 1);
  assert.deepEqual(report.unrecognizedModels, [{ model: 'gpt-9-turbo', units: 1, sessions: 1 }]);
  assert.match(renderSummary(report), /unrecognized models: gpt-9-turbo \(1 unit/);
});

test('#124: a synthetic assistant row does not name the session model', () => {
  const parsed = parseTranscript([
    { type: 'custom-title', customTitle: 'ic-1', sessionId: 's-1' },
    assistant({ uuid: 'syn', timestamp: '2026-09-01T00:00:00.000Z', content: [{ type: 'text', text: 'No response requested.' }], usage: { input: 0, output: 0 }, model: '<synthetic>' }),
    assistant({ uuid: 'real', timestamp: '2026-09-01T00:00:01.000Z', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 }, model: 'claude-sonnet-5' }),
  ].map(line).join('\n'), 'fixture/s-1.jsonl');
  assert.equal(parsed.model, 'claude-sonnet-5');
});

// --- #125: the collector counts sessions that rotation retired ----------------------
// Red-tell: the rotated-lead fixture counts only the live lead session before the change.
function rotationFixture({ retiredLines, rosterSessions, transcripts, subagents = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cycle-retired-'));
  const dir = path.join(root, 'transcripts', 'p');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roster.json'), JSON.stringify({ sessions: rosterSessions }));
  fs.writeFileSync(path.join(root, 'archive', 'roster-retired-full.jsonl'), `${retiredLines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  for (const [sessionId, text] of Object.entries(transcripts)) fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), text);
  for (const [sessionId, agents] of Object.entries(subagents)) {
    const agentDir = path.join(dir, sessionId, 'subagents');
    fs.mkdirSync(agentDir, { recursive: true });
    for (const agent of agents) {
      fs.writeFileSync(path.join(agentDir, `agent-${agent.id}.jsonl`), agent.text);
      if (agent.meta) fs.writeFileSync(path.join(agentDir, `agent-${agent.id}.meta.json`), JSON.stringify(agent.meta));
    }
  }
  return collectFromFiles({
    transcriptsDir: path.join(root, 'transcripts'), rosterPath: path.join(root, 'roster.json'), outputDir: path.join(root, 'out'),
    since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z', generatedAt: '2026-09-02T00:00:00.000Z', verifyGithub: false,
    configPath: path.join(root, 'no-config.json'),
  });
}
const leadRow = (sessionId, extra = {}) => ({ name: 'pl-endzone', role: 'project-lead', tenant: 'endzone', sessionId, ...extra });

test('#125: a lead rotated mid-window counts both the retired and the live session in the control-plane total', () => {
  const result = rotationFixture({
    rosterSessions: [leadRow('pl-new', { status: 'active', launchedAt: '2026-09-01T12:00:00.000Z' })],
    retiredLines: [leadRow('pl-old', { status: 'retired', launchedAt: '2026-08-31T12:00:00.000Z', retiredAt: '2026-09-01T11:59:00.000Z' })],
    transcripts: {
      'pl-old': sessionTranscript({ sessionId: 'pl-old', name: 'pl-endzone', role: 'project-lead', at: '2026-09-01T06:00:00.000Z', input: 1000, output: 0 }),
      'pl-new': sessionTranscript({ sessionId: 'pl-new', name: 'pl-endzone', role: 'project-lead', at: '2026-09-01T13:00:00.000Z', input: 300, output: 0 }),
    },
  });
  const daily = result.dailyReport;
  assert.equal(daily.roles['project-lead'].sessions, 2);
  assert.equal(daily.metrics.controlPlaneFreshTokens, 1300);
  assert.deepEqual(daily.sample.sessionSources, { live: 1, retired: 1 });
});

test('#125: a retired session whose transcript has no role still counts under its roster role', () => {
  const text = [assistant({ uuid: 'x', timestamp: '2026-09-01T06:00:00.000Z', content: [{ type: 'text', text: 'ok' }], usage: { input: 50, output: 0 } })].map((r) => line({ ...r, sessionId: 'd-old' })).join('\n');
  const result = rotationFixture({
    rosterSessions: [],
    retiredLines: [{ name: 'dispatcher', role: 'dispatcher', sessionId: 'd-old', status: 'retired', launchedAt: '2026-09-01T00:00:00.000Z', retiredAt: '2026-09-01T07:00:00.000Z' }],
    transcripts: { 'd-old': text },
  });
  assert.equal(result.dailyReport.roles.dispatcher.sessions, 1);
  assert.equal(result.dailyReport.metrics.controlPlaneFreshTokens, 50);
});

test('#125: a session present in both the roster and the retired log counts once', () => {
  const result = rotationFixture({
    rosterSessions: [icRow(7, 's-7'), leadRow('pl-1', { status: 'active' })],
    retiredLines: [icRow(7, 's-7'), leadRow('pl-1', { status: 'retired', retiredAt: '2026-09-01T20:00:00.000Z' })],
    transcripts: {
      's-7': sessionTranscript({ sessionId: 's-7', name: 'ic-7', at: '2026-09-01T00:00:10.000Z', pr: 707 }),
      'pl-1': sessionTranscript({ sessionId: 'pl-1', name: 'pl-endzone', role: 'project-lead', at: '2026-09-01T01:00:00.000Z' }),
    },
  });
  const daily = result.dailyReport;
  assert.equal(daily.sample.completedUnits, 1);
  assert.equal(daily.sessions.length, 2);
  assert.equal(daily.roles['project-lead'].sessions, 1);
  assert.deepEqual(daily.sample.sessionSources, { live: 2, retired: 0 });
});

test('#125: an IC respawned for the same issue is one unit whose tokens are both sessions', () => {
  const result = rotationFixture({
    rosterSessions: [icRow(8, 's-8b')],
    retiredLines: [icRow(8, 's-8a', { retiredAt: '2026-09-01T00:00:30.000Z', retiredBecause: 'respawn' })],
    transcripts: {
      's-8a': sessionTranscript({ sessionId: 's-8a', name: 'ic-8', at: '2026-09-01T00:00:05.000Z', input: 400, output: 40 }),
      's-8b': sessionTranscript({ sessionId: 's-8b', name: 'ic-8', at: '2026-09-01T00:00:40.000Z', input: 100, output: 10, pr: 808 }),
    },
  });
  const daily = result.dailyReport;
  assert.equal(daily.sample.completedUnits, 1);
  assert.equal(daily.units[0].metrics.jobTokens, 550);
  assert.equal(daily.units[0].sessions, 2);
  assert.deepEqual(daily.units[0].pullRequests, [808]);
});

test('#125: the summary names the live and retired session counts', () => {
  const result = rotationFixture({
    rosterSessions: [leadRow('pl-new', { status: 'active' })],
    retiredLines: [leadRow('pl-old', { status: 'retired', launchedAt: '2026-09-01T00:00:00.000Z', retiredAt: '2026-09-01T11:59:00.000Z' })],
    transcripts: {
      'pl-old': sessionTranscript({ sessionId: 'pl-old', name: 'pl-endzone', role: 'project-lead', at: '2026-09-01T06:00:00.000Z' }),
      'pl-new': sessionTranscript({ sessionId: 'pl-new', name: 'pl-endzone', role: 'project-lead', at: '2026-09-01T13:00:00.000Z' }),
    },
  });
  assert.match(fs.readFileSync(result.summaryArtifact, 'utf8'), /sessions: 1 live, 1 retired \(rotated out\)/);
});

test('#125: a torn line in the retired log is listed as skipped and the run completes', () => {
  const result = rotationFixture({
    rosterSessions: [leadRow('pl-new', { status: 'active' })],
    retiredLines: [leadRow('pl-old', { status: 'retired', launchedAt: '2026-09-01T00:00:00.000Z', retiredAt: '2026-09-01T11:59:00.000Z' }), '{"name":"pl-endzone","role":"proj'],
    transcripts: {
      'pl-old': sessionTranscript({ sessionId: 'pl-old', name: 'pl-endzone', role: 'project-lead', at: '2026-09-01T06:00:00.000Z' }),
      'pl-new': sessionTranscript({ sessionId: 'pl-new', name: 'pl-endzone', role: 'project-lead', at: '2026-09-01T13:00:00.000Z' }),
    },
  });
  assert.equal(result.dailyReport.roles['project-lead'].sessions, 2);
  assert.deepEqual(result.dailyReport.retiredLog.skipped, [{ line: 2, reason: 'unparseable' }]);
  assert.match(fs.readFileSync(result.summaryArtifact, 'utf8'), /retired log: 1 torn line\(s\) skipped/);
});

test('#125: a retired row that ended before the window is not read', () => {
  const result = rotationFixture({
    rosterSessions: [],
    retiredLines: [leadRow('pl-ancient', { status: 'retired', launchedAt: '2026-08-01T00:00:00.000Z', retiredAt: '2026-08-02T00:00:00.000Z' })],
    transcripts: { 'pl-ancient': sessionTranscript({ sessionId: 'pl-ancient', name: 'pl-endzone', role: 'project-lead', at: '2026-08-01T06:00:00.000Z' }) },
  });
  assert.equal(result.dailyReport.sessions.length, 0);
  assert.equal(result.report.sessions.length, 0);
});

// --- #126: the risk reviewer's spend is attributed to the unit that hosted it --------
// Red-tell: before the change a qa-reviewer subagent's tokens appear nowhere.
function agentTranscript({ sessionId, agentId, model = 'claude-opus-5-5', input, output, at = '2026-09-01T00:00:20.000Z' }) {
  return [{ ...assistant({ uuid: `${agentId}-1`, timestamp: at, content: [{ type: 'text', text: 'Review complete: no findings.' }], usage: { input, output }, model }), sessionId, agentId, isSidechain: true }].map(line).join('\n');
}
const icSession = (sessionId, pr) => sessionTranscript({ sessionId, name: 'ic-9', at: '2026-09-01T00:00:10.000Z', input: 100, output: 10, pr });

test('#126: a qa-reviewer subagent is a risk-reviewer line and is inside the hosting unit total', () => {
  const result = rotationFixture({
    rosterSessions: [icRow(9, 's-9')],
    retiredLines: [],
    transcripts: { 's-9': icSession('s-9', 909) },
    subagents: { 's-9': [{ id: 'q1', text: agentTranscript({ sessionId: 's-9', agentId: 'q1', input: 1000, output: 100 }), meta: { agentType: 'qa-reviewer', model: 'opus' } }] },
  });
  const report = result.dailyReport;
  const [unit] = report.units;
  assert.equal(unit.metrics.ownJobTokens, 110);
  assert.equal(unit.metrics.riskReviewerJobTokens, 1100);
  assert.equal(unit.metrics.jobTokens, 1210, 'the unit total includes the reviewer');
  assert.deepEqual(report.riskReviewer, { runs: 1, jobTokens: 1100, freshTokens: 1100, byModel: { opus: { runs: 1, jobTokens: 1100 } } });
  assert.match(fs.readFileSync(result.summaryArtifact, 'utf8'), /risk reviewer \(qa-reviewer\): 1 run\(s\), 1100 job tokens \(opus 1\)/);
});

test('#126: a subagent with no meta file counts in the unit total under unknown and is listed', () => {
  const result = rotationFixture({
    rosterSessions: [icRow(9, 's-9')],
    retiredLines: [],
    transcripts: { 's-9': icSession('s-9', 909) },
    subagents: { 's-9': [{ id: 'm1', text: agentTranscript({ sessionId: 's-9', agentId: 'm1', model: 'claude-sonnet-5', input: 40, output: 2 }) }] },
  });
  const report = result.dailyReport;
  assert.equal(report.units[0].metrics.jobTokens, 152);
  assert.equal(report.subagents.byAgentType.unknown.runs, 1);
  assert.equal(report.subagents.byAgentType.unknown.jobTokens, 42);
  assert.equal(report.subagentsWithoutMeta.length, 1);
  assert.equal(report.subagentsWithoutMeta[0].agentId, 'm1');
  assert.equal(report.subagentsWithoutMeta[0].session, 's-9');
  assert.equal(report.riskReviewer.runs, 0);
});

test('#126: the unit total equals the session plus all its subagents, summarized by agent type', () => {
  const result = rotationFixture({
    rosterSessions: [icRow(9, 's-9')],
    retiredLines: [],
    transcripts: { 's-9': icSession('s-9', 909) },
    subagents: { 's-9': [
      { id: 'q1', text: agentTranscript({ sessionId: 's-9', agentId: 'q1', input: 1000, output: 100 }), meta: { agentType: 'qa-reviewer', model: 'opus' } },
      { id: 'r1', text: agentTranscript({ sessionId: 's-9', agentId: 'r1', model: 'claude-haiku-4-5-20251001', input: 30, output: 3 }), meta: { agentType: 'researcher', model: 'haiku' } },
      { id: 'r2', text: agentTranscript({ sessionId: 's-9', agentId: 'r2', model: 'claude-haiku-4-5-20251001', input: 20, output: 2 }), meta: { agentType: 'researcher', model: 'haiku' } },
    ] },
  });
  const report = result.dailyReport;
  const metrics = report.units[0].metrics;
  assert.equal(metrics.subagentRuns, 3);
  assert.equal(metrics.jobTokens, metrics.ownJobTokens + metrics.subagentJobTokens);
  assert.equal(metrics.jobTokens, 110 + 1100 + 33 + 22);
  assert.deepEqual(report.subagents.byAgentType.researcher, { runs: 2, jobTokens: 55, freshTokens: 55, byModel: { haiku: { runs: 2, jobTokens: 55 } } });
  assert.equal(report.subagents.runs, 3);
  assert.equal(report.sessions.length, 1, 'a subagent transcript is never read as a session of its own');
});

test('#126: with an empty roster, subagent transcripts are still not read as sessions', () => {
  const result = rotationFixture({
    rosterSessions: [],
    retiredLines: [],
    transcripts: { 'pl-x': sessionTranscript({ sessionId: 'pl-x', name: 'pl-endzone', role: 'project-lead', at: '2026-09-01T01:00:00.000Z', input: 10, output: 0 }) },
    subagents: { 'pl-x': [{ id: 'r1', text: agentTranscript({ sessionId: 'pl-x', agentId: 'r1', input: 5, output: 0, at: '2026-09-01T01:00:05.000Z' }), meta: { agentType: 'researcher', model: 'haiku' } }] },
  });
  assert.equal(result.dailyReport.sessions.length, 1);
  assert.equal(result.dailyReport.roles['project-lead'].metrics.jobTokens, 15, 'the lead carries its researcher');
});

// --- #128: the IC token median is reported, not judged ------------------------------
// Red-tell: before the change the median carries PASS/FAIL against 60000 and there is
// no per-family figure.
const familyUnit = (issue, model, job) => ({ tenant: 'endzone', issue, session: `ic-${issue}`, role: 'ic', model, merged: true, completedAt: '2026-09-09T00:00:00.000Z', metrics: { freshTokens: job, jobTokens: job, cacheReadInputTokens: 0 } });
const familyUnits = [familyUnit(1, 'sonnet', 100000), familyUnit(2, 'sonnet', 140000), familyUnit(3, 'sonnet', 300000), familyUnit(4, 'haiku', 20000), familyUnit(5, 'haiku', 40000)];
const nullTargets = { haiku: null, sonnet: null, opus: null, fable: null };

test('#128: with every per-model target null, the median and p90 print per family with no verdict', () => {
  const report = buildReport(familyUnits, [], { budgets: { icJobTokensMedianReference: 60000, icJobTokensTargets: nullTargets } });
  const byModel = report.unitMetrics.icByModel;
  assert.deepEqual(byModel.sonnet, { units: 3, jobTokensMedian: 140000, jobTokensP90: 300000, target: null, pass: null });
  assert.deepEqual(byModel.haiku, { units: 2, jobTokensMedian: 30000, jobTokensP90: 40000, target: null, pass: null });
  assert.equal(report.unitMetrics.budgets.icJobTokensMedian.pass, null);
  const text = renderSummary(report);
  assert.match(text, /^IC job tokens median: 100000 \(p90 300000; reference 60000, not a verdict\)$/m);
  assert.match(text, /^- sonnet: median 140000, p90 300000 over 3 unit\(s\) \(no target\)$/m);
  assert.match(text, /^- haiku: median 30000, p90 40000 over 2 unit\(s\) \(no target\)$/m);
  const icLines = text.split('\n').filter((l) => /^IC job tokens median|^- (sonnet|haiku):/.test(l));
  assert.ok(icLines.every((l) => !/PASS|FAIL/.test(l)), 'no verdict on any IC median line');
});

test('#128: setting one family target judges that family only', () => {
  const report = buildReport(familyUnits, [], { budgets: { icJobTokensMedianReference: 60000, icJobTokensTargets: { ...nullTargets, haiku: 35000 } } });
  const byModel = report.unitMetrics.icByModel;
  assert.equal(byModel.haiku.target, 35000);
  assert.equal(byModel.haiku.pass, true);
  assert.equal(byModel.sonnet.pass, null);
  const text = renderSummary(report);
  assert.match(text, /^- haiku: median 30000, p90 40000 over 2 unit\(s\) \(target 35000\) PASS$/m);
  assert.match(text, /^- sonnet: .*\(no target\)$/m);
  const failing = buildReport(familyUnits, [], { budgets: { icJobTokensTargets: { ...nullTargets, haiku: 25000 } } });
  assert.equal(failing.unitMetrics.icByModel.haiku.pass, false);
  assert.match(renderSummary(failing), /^- haiku: .*\(target 25000\) FAIL$/m);
});

test('#128: the legacy icJobTokensMedian key is read as the reference, never a verdict', () => {
  const report = buildReport(familyUnits, [], { budgets: { icJobTokensMedian: 60000 } });
  assert.equal(report.unitMetrics.budgets.icJobTokensMedian.reference, 60000);
  assert.equal(report.unitMetrics.budgets.icJobTokensMedian.pass, null);
});

test('#128: the seven-day JSON carries the per-family figures, and the shipped config has null targets', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'cycle.json'), 'utf8'));
  assert.deepEqual(shipped.budgets.icJobTokensTargets, nullTargets);
  assert.equal(shipped.budgets.icJobTokensMedianReference, 60000);
  assert.equal(shipped.budgets.icJobTokensMedian, undefined, 'the judged key is gone');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cycle-'));
  const transcripts = path.join(root, 'transcripts');
  fs.mkdirSync(path.join(transcripts, 'p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roster.json'), JSON.stringify({ sessions: [{ name: 'ic-42', role: 'ic', tenant: 'endzone', issue: 42, status: 'retired', retiredAt: '2026-09-01T00:01:00.000Z', sessionId: 'session-1' }] }));
  fs.writeFileSync(path.join(transcripts, 'p', 'session-1.jsonl'), fixtureTranscript());
  const result = collectFromFiles({ transcriptsDir: transcripts, rosterPath: path.join(root, 'roster.json'), outputDir: path.join(root, 'out'), since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z', generatedAt: '2026-09-01T12:00:00.000Z', verifyGithub: false, configPath: path.join(__dirname, '..', 'config', 'cycle.json') });
  const json = JSON.parse(fs.readFileSync(result.summaryJsonArtifact, 'utf8'));
  assert.deepEqual(json.unitMetrics.icByModel.sonnet, { units: 1, jobTokensMedian: 68, jobTokensP90: 68, target: null, pass: null });
});
