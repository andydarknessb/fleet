'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CONTROL_PLANE_ROLES = new Set(['dispatcher', 'project-lead', 'sentinel', 'notifier']);
const POLLING_COMMAND = /(?:\bgh\s+(?:pr\s+(?:view|checks|list)|issue\s+(?:view|list))\b|\b(?:git\s+(?:status|log|diff|show)|Get-Content|Get-Item|Test-Path|ListAgents|claude\s+agents)\b)/i;
const PR_REFERENCE = /\bPR\s*#?(\d+)\b|\bpull request\s*#?(\d+)\b/gi;
const GH_PR_REFERENCE = /\bgh\s+pr\s+(?:view|checks|merge|create)\s+#?(\d+)\b/gi;

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block && typeof block.text === 'string') return block.text;
    if (block && typeof block.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join('\n');
}

function toolCallsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block && block.type === 'tool_use').map((block) => ({
    id: block.id || null,
    name: block.name || '',
    input: block.input || {},
  }));
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function commandClass(tool) {
  const name = String(tool.name || '').toLowerCase();
  const input = tool.input || {};
  const command = String(input.command || input.cmd || input.description || '').toLowerCase();
  if (name === 'sendmessage') return 'send-message';
  if (name === 'skill') return 'skill';
  if (name === 'task' || name === 'taskcreate') return 'worker';
  if (command.includes('gh pr checks')) return 'github-pr-checks';
  if (command.includes('gh pr view')) return 'github-pr-view';
  if (command.includes('gh pr ')) return 'github-pr-mutation';
  if (command.includes('gh issue view')) return 'github-issue-view';
  if (command.includes('gh issue')) return 'github-issue';
  if (command.includes('gh ')) return 'github-other';
  if (command.includes('git status')) return 'git-status';
  if (command.includes('git log')) return 'git-log';
  if (command.includes('git diff')) return 'git-diff';
  if (command.includes('git ')) return 'git-other';
  if (command.includes('npm test') || command.includes('npm run')) return 'test-or-build';
  if (command.includes('powershell') || command.includes('.ps1')) return 'script';
  if (name === 'bash') return 'shell';
  return 'other';
}

function addCount(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function isFormalReviewTurn(text, toolCalls) {
  const toolReview = toolCalls.some((tool) => {
    const input = JSON.stringify(tool.input || {});
    return tool.name === 'Skill' && /code-review|standards?.*spec/i.test(input);
  });
  const completedReview = /(?:standards?\s+and\s+spec(?:ification)?|formal|risk)\s+review\s+(?:passed|complete|finished)/i.test(text);
  return toolReview || completedReview;
}

function isUsefulTurn(turn) {
  if (turn.toolCalls.length > 0) return true;
  return /(?:implemented|changed|fixed|tested|review|finding|decision|commit|pull request|PR\s*#?\d+)/i.test(turn.text);
}

function countReviewPasses(turns) {
  let passes = 0;
  let inPass = false;
  for (const turn of turns) {
    if (turn.formalReview && !inPass) passes += 1;
    inPass = turn.formalReview;
  }
  return passes;
}

function addReferences(target, text) {
  for (const match of String(text || '').matchAll(PR_REFERENCE)) {
    const number = Number(match[1] || match[2]);
    if (Number.isInteger(number)) target.add(number);
  }
  for (const match of String(text || '').matchAll(GH_PR_REFERENCE)) {
    const number = Number(match[1]);
    if (Number.isInteger(number)) target.add(number);
  }
}

function parseTranscript(contents, sourcePath) {
  const rows = [];
  let malformedLines = 0;
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      malformedLines += 1;
    }
  }

  let sessionId = null;
  let name = null;
  let role = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let assistantMessages = 0;
  let userMessages = 0;
  let forcedContinuationTurns = 0;
  let durationMs = 0;
  let model = null;
  let effort = null;
  const pullRequests = new Set();
  const turns = [];
  const toolResults = new Map();
  const searchParts = [];
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  for (const row of rows) {
    sessionId = sessionId || row.sessionId || row.session_id || null;
    const timestamp = row.timestamp ? new Date(row.timestamp).getTime() : NaN;
    if (Number.isFinite(timestamp)) {
      if (firstTimestamp === null || timestamp < firstTimestamp) firstTimestamp = timestamp;
      if (lastTimestamp === null || timestamp > lastTimestamp) lastTimestamp = timestamp;
    }
    if (row.type === 'custom-title') name = name || row.customTitle || null;
    if (row.type === 'agent-name') name = name || row.agentName || null;
    if (row.type === 'agent-setting') role = role || row.agentSetting || null;
    if (row.type === 'system' && row.subtype === 'stop_hook_summary' && row.preventedContinuation === true) {
      forcedContinuationTurns += 1;
    }
    if (row.type === 'system' && row.subtype === 'turn_duration') durationMs += asNumber(row.durationMs);
    if (row.type === 'user' && row.message) {
      const content = row.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_result' && block.tool_use_id) {
            toolResults.set(block.tool_use_id, textFromContent(block.content));
          }
        }
        if (!content.some((block) => block && block.type === 'tool_result')) {
          userMessages += 1;
          const text = textFromContent(content);
          searchParts.push(text);
          addReferences(pullRequests, text);
        }
      } else if (typeof content === 'string') {
        userMessages += 1;
        searchParts.push(content);
        addReferences(pullRequests, content);
      }
    }
  }

  for (const row of rows) {
    if (row.type !== 'assistant' || !row.message) continue;
    assistantMessages += 1;
    model = model || row.message.model || row.model || null;
    effort = effort || row.effort || null;
    const rowUsage = row.message.usage || {};
    const inputTokens = asNumber(rowUsage.input_tokens);
    const outputTokens = asNumber(rowUsage.output_tokens);
    const cacheCreationInputTokens = asNumber(rowUsage.cache_creation_input_tokens);
    const cacheReadInputTokens = asNumber(rowUsage.cache_read_input_tokens);
    usage.inputTokens += inputTokens;
    usage.outputTokens += outputTokens;
    usage.cacheCreationInputTokens += cacheCreationInputTokens;
    usage.cacheReadInputTokens += cacheReadInputTokens;
    const content = row.message.content || [];
    const text = textFromContent(content);
    const toolCalls = toolCallsFromContent(content).map((tool) => ({
      ...tool,
      commandClass: commandClass(tool),
      resultText: tool.id ? (toolResults.get(tool.id) || '') : '',
    }));
    const toolText = toolCalls.map((tool) => `${tool.name} ${JSON.stringify(tool.input)} ${tool.resultText}`).join('\n');
    searchParts.push(text, toolText);
    addReferences(pullRequests, `${text}\n${toolText}`);
    turns.push({
      id: row.uuid || row.requestId || `turn-${assistantMessages}`,
      timestamp: row.timestamp || null,
      text,
      toolCalls,
      usage: { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens },
      formalReview: isFormalReviewTurn(text, toolCalls),
    });
  }

  const allText = searchParts.filter(Boolean).join('\n');
  const nameIssue = String(name || '').match(/(?:^|\b)ic-(\d+)(?:\b|$)/i);
  const branchIssue = allText.match(/\bfleet\/(\d+)-/i);
  const issue = nameIssue ? Number(nameIssue[1]) : (branchIssue ? Number(branchIssue[1]) : null);
  const mergeEvidence = turns.filter((turn) => {
    const turnText = `${turn.text}\n${turn.toolCalls.map((tool) => `${JSON.stringify(tool.input)}\n${tool.resultText}`).join('\n')}`;
    const commandMerge = turn.toolCalls.some((tool) => /\bgh\s+pr\s+merge\b/i.test(String(tool.input?.command || '')))
      && /(?:merged|squash|success)/i.test(turnText);
    const explicitMerge = /(?:PR|pull request)\s*#?\d+\s+(?:was\s+)?(?:squash-)?merged\b/i.test(turnText);
    return commandMerge || explicitMerge;
  });
  const mergeEvents = mergeEvidence.flatMap((turn) => {
    const references = new Set();
    addReferences(references, `${turn.text}\n${turn.toolCalls.map((tool) => `${JSON.stringify(tool.input)}\n${tool.resultText}`).join('\n')}`);
    return [...references].map((number) => ({ number, timestamp: turn.timestamp, source: 'transcript', turnId: turn.id }));
  });
  const merged = mergeEvidence.length > 0;
  const classifiedTurns = classifyTurns(turns);
  const toolCallsByCommandClass = {};
  for (const turn of turns) for (const tool of turn.toolCalls) addCount(toolCallsByCommandClass, commandClass(tool));
  const firstUsefulTurn = turns.find(isUsefulTurn) || turns[0] || null;

  return {
    sourcePath: sourcePath || null,
    sessionId,
    name,
    role,
    issue,
    model,
    effort,
    firstTimestamp: firstTimestamp === null ? null : new Date(firstTimestamp).toISOString(),
    lastTimestamp: lastTimestamp === null ? null : new Date(lastTimestamp).toISOString(),
    wallTimeMs: firstTimestamp !== null && lastTimestamp !== null ? Math.max(0, lastTimestamp - firstTimestamp) : null,
    durationMs,
    malformedLines,
    assistantMessages,
    userMessages,
    usage,
    firstUsefulTurnCacheCreationInputTokens: firstUsefulTurn?.usage.cacheCreationInputTokens || 0,
    turns: classifiedTurns,
    pullRequests: [...pullRequests].sort((a, b) => a - b),
    merged,
    mergeEvidence: mergeEvidence.map((turn) => turn.id),
    mergeEvents,
    forcedContinuationTurns,
    formalReviewPasses: countReviewPasses(turns),
    crossSessionMessages: turns.reduce((count, turn) => count + turn.toolCalls.filter((tool) => tool.name === 'SendMessage').length, 0),
    toolCalls: turns.reduce((count, turn) => count + turn.toolCalls.length, 0),
    toolCallsByCommandClass: { other: 0, ...toolCallsByCommandClass },
  };
}

function classifyTurns(turns) {
  const seen = new Map();
  return turns.map((turn) => {
    const pollingTools = turn.toolCalls.filter((tool) => {
      const command = tool.input && (tool.input.command || tool.input.cmd || tool.input.description);
      return POLLING_COMMAND.test(`${tool.name} ${command || ''}`);
    });
    if (pollingTools.length === 0 || pollingTools.length !== turn.toolCalls.length) {
      return { ...turn, pollingOnly: false };
    }
    const fingerprint = pollingTools.map((tool) => normalize([
      tool.name,
      JSON.stringify(tool.input),
      normalize(tool.resultText),
    ].join('|'))).join('||');
    const repeated = seen.has(fingerprint);
    seen.set(fingerprint, true);
    const explicitFact = /(?:changed|new fact|finding|decision|settled|failed|passed|transition|opened|merged)/i.test(
      pollingTools.map((tool) => tool.resultText).join('\n'),
    );
    return { ...turn, pollingOnly: repeated && !explicitFact };
  });
}

function metricsForTranscript(transcript) {
  const usage = transcript.usage;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    freshTokens: usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens,
    jobTokens: usage.inputTokens + usage.outputTokens,
    firstUsefulTurnCacheCreationInputTokens: transcript.firstUsefulTurnCacheCreationInputTokens || 0,
    assistantMessages: transcript.assistantMessages,
    userMessages: transcript.userMessages,
    toolCalls: transcript.toolCalls,
    toolCallsByCommandClass: { ...transcript.toolCallsByCommandClass },
    crossSessionMessages: transcript.crossSessionMessages,
    pollingOnlyTurns: transcript.turns.filter((turn) => turn.pollingOnly).length,
    forcedContinuationTurns: transcript.forcedContinuationTurns,
    formalReviewPasses: transcript.formalReviewPasses,
    wallTimeMs: transcript.wallTimeMs,
    durationMs: transcript.durationMs,
  };
}

function sessionMetricForTranscript(transcript) {
  return {
    sessionId: transcript.sessionId,
    name: transcript.name,
    role: transcript.role,
    issue: transcript.issue,
    model: transcript.model,
    effort: transcript.effort,
    firstTimestamp: transcript.firstTimestamp,
    lastTimestamp: transcript.lastTimestamp,
    metrics: metricsForTranscript(transcript),
    evidence: { transcript: transcript.sourcePath, transcriptSessionId: transcript.sessionId },
  };
}

function buildCycleRecords({ roster, transcripts, pullRequestStates = null, allowTranscriptEvidence = false, verificationErrors = {} }) {
  const rows = Array.isArray(roster) ? roster : (roster && Array.isArray(roster.sessions) ? roster.sessions : []);
  const bySessionId = new Map();
  const byName = new Map();
  for (const transcript of transcripts || []) {
    if (transcript.sessionId) bySessionId.set(transcript.sessionId, transcript);
    if (transcript.name) {
      const matches = byName.get(transcript.name) || [];
      matches.push(transcript);
      byName.set(transcript.name, matches);
    }
  }
  const sessionMetrics = (transcripts || []).map(sessionMetricForTranscript);
  const records = [];
  const excluded = [];
  for (const row of rows) {
    if (String(row.role || '').toLowerCase() !== 'ic' || !Number.isInteger(Number(row.issue)) || Number(row.issue) <= 0) continue;
    const identity = { name: row.name || null, tenant: row.tenant || null, issue: Number(row.issue) };
    if (!row.retiredAt || String(row.status || '').toLowerCase() !== 'retired') {
      excluded.push({ ...identity, retiredAt: row.retiredAt || null, startedAt: row.launchedAt || row.startedAt || null, reason: 'not-retired', evidence: 'state/roster.json' });
      continue;
    }
    const namedMatches = byName.get(row.name) || [];
    const transcript = (row.sessionId && bySessionId.get(row.sessionId)) || (namedMatches.length === 1 ? namedMatches[0] : null);
    if (!transcript) {
      excluded.push({ ...identity, retiredAt: row.retiredAt || null, startedAt: row.launchedAt || row.startedAt || null, reason: 'missing-transcript', evidence: 'transcript directory' });
      continue;
    }
    if (transcript.issue !== null && transcript.issue !== identity.issue) {
      excluded.push({ ...identity, retiredAt: row.retiredAt || null, startedAt: row.launchedAt || row.startedAt || null, reason: 'issue-mismatch', evidence: transcript.sourcePath });
      continue;
    }
    if (transcript.pullRequests.length === 0) {
      excluded.push({ ...identity, retiredAt: row.retiredAt || null, startedAt: row.startedAt || null, reason: 'missing-pull-request', evidence: transcript.sourcePath });
      continue;
    }
    const verifiedMerge = transcript.pullRequests.some((number) => {
      const state = pullRequestStates?.[`${identity.tenant}:${number}`];
      return state && String(state.state).toUpperCase() === 'MERGED' && state.mergedAt;
    });
    if (pullRequestStates && !verifiedMerge) {
      const errors = transcript.pullRequests
        .map((number) => verificationErrors[`${identity.tenant}:${number}`])
        .filter(Boolean);
      excluded.push({ ...identity, retiredAt: row.retiredAt || null, startedAt: row.startedAt || null, reason: 'github-merge-unverified', verificationErrors: errors, evidence: transcript.sourcePath });
      continue;
    }
    if (!pullRequestStates && !allowTranscriptEvidence) {
      excluded.push({ ...identity, retiredAt: row.retiredAt || null, startedAt: row.startedAt || null, reason: 'github-merge-unverified', evidence: transcript.sourcePath });
      continue;
    }
    if (!pullRequestStates && !transcript.merged) {
      excluded.push({ ...identity, retiredAt: row.retiredAt || null, startedAt: row.startedAt || null, reason: 'missing-merge-evidence', evidence: transcript.sourcePath });
      continue;
    }
    const mergeEvents = pullRequestStates
      ? transcript.pullRequests
        .map((number) => ({ number, ...pullRequestStates[`${identity.tenant}:${number}`], source: 'github' }))
        .filter((event) => String(event.state).toUpperCase() === 'MERGED' && event.mergedAt)
      : transcript.mergeEvents;
    records.push({
      tenant: row.tenant || null,
      issue: identity.issue,
      session: row.name || transcript.name || null,
      sessionId: row.sessionId || transcript.sessionId || null,
      role: 'ic',
      model: row.model || transcript.model || null,
      effort: row.effort || transcript.effort || null,
      pullRequests: transcript.pullRequests,
      merged: true,
      mergeVerification: pullRequestStates ? 'github' : 'transcript',
      mergeEvents,
      retiredAt: row.retiredAt,
      completedAt: row.retiredAt,
      outcome: 'merged-and-retired',
      metrics: metricsForTranscript(transcript),
      evidence: {
        roster: 'state/roster.json',
        transcript: transcript.sourcePath,
        transcriptSessionId: transcript.sessionId,
      },
    });
  }
  records.sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue);
  excluded.sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue);
  return { records, excluded, sessionMetrics };
}

function sum(records, selector) {
  return records.reduce((total, record) => total + asNumber(selector(record)), 0);
}

function buildReport(records, excluded, { generatedAt, since, until, sessionMetrics = [], verificationErrors = [] } = {}) {
  const units = records || [];
  const controlPlaneSessions = (sessionMetrics || []).filter((session) => CONTROL_PLANE_ROLES.has(session.role));
  const observed = [
    ...units.map((record) => record.metrics),
    ...controlPlaneSessions.map((session) => session.metrics),
  ];
  const observedSum = (selector) => observed.reduce((total, metric) => total + asNumber(selector(metric)), 0);
  const toolCallsByCommandClass = {};
  for (const metric of observed) {
    for (const [key, value] of Object.entries(metric.toolCallsByCommandClass || {})) {
      toolCallsByCommandClass[key] = (toolCallsByCommandClass[key] || 0) + value;
    }
  }
  const metrics = {
    freshTokens: observedSum((metric) => metric.freshTokens),
    cacheReadTokens: observedSum((metric) => metric.cacheReadInputTokens),
    jobTokens: observedSum((metric) => metric.jobTokens),
    controlPlaneFreshTokens: sum(controlPlaneSessions, (session) => session.metrics.freshTokens),
    controlPlaneCacheReadTokens: sum(controlPlaneSessions, (session) => session.metrics.cacheReadInputTokens),
    icFreshTokens: sum(units, (record) => record.role === 'ic' || record.session?.startsWith('ic-') ? record.metrics.freshTokens : 0),
    assistantMessages: observedSum((metric) => metric.assistantMessages),
    userMessages: observedSum((metric) => metric.userMessages),
    toolCalls: observedSum((metric) => metric.toolCalls),
    crossSessionMessages: observedSum((metric) => metric.crossSessionMessages),
    pollingOnlyModelTurns: observedSum((metric) => metric.pollingOnlyTurns),
    forcedContinuationTurns: observedSum((metric) => metric.forcedContinuationTurns),
    formalReviewPasses: observedSum((metric) => metric.formalReviewPasses),
    wallTimeMs: observedSum((metric) => metric.wallTimeMs),
    toolCallsByCommandClass: Object.fromEntries(Object.entries({ other: 0, ...toolCallsByCommandClass }).sort(([a], [b]) => a.localeCompare(b))),
  };
  const roles = {};
  for (const session of sessionMetrics || []) {
    const role = session.role || 'unknown';
    if (!roles[role]) roles[role] = { sessions: 0, metrics: {}, toolCallsByCommandClass: { other: 0 } };
    roles[role].sessions += 1;
    for (const [key, value] of Object.entries(session.metrics || {})) {
      if (typeof value === 'number') roles[role].metrics[key] = (roles[role].metrics[key] || 0) + value;
    }
    for (const [key, value] of Object.entries(session.metrics?.toolCallsByCommandClass || {})) {
      roles[role].toolCallsByCommandClass[key] = (roles[role].toolCallsByCommandClass[key] || 0) + value;
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: generatedAt || new Date().toISOString(),
    period: { since: since || null, until: until || null },
    metricDefinitions: {
      freshTokens: 'input + output + cache-creation tokens; cache-read tokens are excluded',
      jobTokens: 'input + output tokens only; cache fields are reported separately',
      controlPlaneFreshTokens: 'fresh tokens from Dispatcher, project-lead, Sentinel, and notifier sessions',
    },
    sample: { completedUnits: units.length, excludedUnits: (excluded || []).length },
    metrics,
    sessions: sessionMetrics || [],
    roles,
    units,
    excluded: excluded || [],
    verificationErrors: verificationErrors || [],
  };
}

function renderSummary(report) {
  const lines = [
    `# Fleet cycle efficiency — ${String(report.period.until || report.generatedAt).slice(0, 10)}`,
    '',
    `period: ${report.period.since || 'unbounded'} → ${report.period.until || 'unbounded'}`,
    `completed units: ${report.sample.completedUnits}`,
    `excluded units: ${report.sample.excludedUnits}`,
    '',
    `fresh tokens: ${report.metrics.freshTokens}`,
    `cache-read tokens: ${report.metrics.cacheReadTokens}`,
    `control-plane fresh tokens: ${report.metrics.controlPlaneFreshTokens}`,
    `control-plane cache-read tokens: ${report.metrics.controlPlaneCacheReadTokens}`,
    `IC fresh tokens: ${report.metrics.icFreshTokens}`,
    `polling-only model turns: ${report.metrics.pollingOnlyModelTurns}`,
    `forced-continuation turns: ${report.metrics.forcedContinuationTurns}`,
    `formal review passes: ${report.metrics.formalReviewPasses}`,
    `tool calls: ${report.metrics.toolCalls}`,
    `tool calls by command class: ${JSON.stringify(report.metrics.toolCallsByCommandClass)}`,
    `cross-session messages: ${report.metrics.crossSessionMessages}`,
    `wall time (ms): ${report.metrics.wallTimeMs}`,
    '',
    '## Exclusions',
    '',
  ];
  if (report.excluded.length === 0) lines.push('None.');
  else for (const item of report.excluded) lines.push(`- ${item.tenant || 'unknown'} #${item.issue} — ${item.reason} (${item.evidence})`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const equal = token.indexOf('=');
    const key = equal === -1 ? token.slice(2) : token.slice(2, equal);
    const next = argv[index + 1];
    const value = equal === -1
      ? (next && !next.startsWith('--') ? argv[++index] : 'true')
      : token.slice(equal + 1);
    args[key] = value;
  }
  return args;
}

function defaultTranscriptsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.claude', 'projects');
}

function listTranscriptFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(candidate);
    }
  }
  return files.sort();
}

function loadTenantConfigs(tenantConfigsDir) {
  if (!tenantConfigsDir || !fs.existsSync(tenantConfigsDir)) return new Map();
  const configs = new Map();
  for (const file of fs.readdirSync(tenantConfigsDir).filter((name) => name.endsWith('.json')).sort()) {
    const config = JSON.parse(fs.readFileSync(path.join(tenantConfigsDir, file), 'utf8'));
    if (config.name && config.github) configs.set(config.name, config);
  }
  return configs;
}

function verifyPullRequests(records, tenantConfigs) {
  const states = {};
  const errors = [];
  const requestedByTenant = new Map();
  for (const record of records) {
    const numbers = requestedByTenant.get(record.tenant) || new Set();
    for (const number of record.pullRequests) numbers.add(number);
    requestedByTenant.set(record.tenant, numbers);
  }
  for (const [tenant, numbers] of requestedByTenant) {
    const config = tenantConfigs.get(tenant);
    if (!config) {
      for (const number of numbers) {
        const key = `${tenant}:${number}`;
        states[key] = { state: 'UNKNOWN', mergedAt: null, error: `missing GitHub config for tenant ${tenant}` };
        errors.push({ key, error: states[key].error });
      }
      continue;
    }
    try {
      const raw = execFileSync('gh', ['pr', 'list', '-R', config.github, '--state', 'all', '--limit', '1000', '--json', 'number,state,mergedAt'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000,
      });
      const listed = JSON.parse(raw);
      const byNumber = new Map(listed.map((item) => [Number(item.number), item]));
      for (const number of numbers) {
        const key = `${tenant}:${number}`;
        states[key] = byNumber.get(number) || { state: 'UNKNOWN', mergedAt: null, error: 'PR not returned by GitHub' };
        const state = String(states[key].state || 'UNKNOWN').toUpperCase();
        if (state !== 'MERGED' || !states[key].mergedAt) {
          errors.push({ key, error: states[key].error || `GitHub PR state is ${state}; mergedAt is required` });
        }
      }
    } catch (error) {
      const message = normalize(error.stderr || error.message);
      for (const number of numbers) {
        const key = `${tenant}:${number}`;
        states[key] = { state: 'UNKNOWN', mergedAt: null, error: message };
        errors.push({ key, error: message });
      }
    }
  }
  return { states, errors };
}

function collectFromFiles({ transcriptsDir, rosterPath, outputDir, tenantConfigsDir, since, until, generatedAt, verifyGithub = true } = {}) {
  const resolvedRoster = path.resolve(rosterPath || path.join(__dirname, '..', 'state', 'roster.json'));
  const resolvedTranscripts = path.resolve(transcriptsDir || defaultTranscriptsDir());
  const resolvedOutput = path.resolve(outputDir || path.join(__dirname, '..', 'state', 'metrics'));
  const roster = JSON.parse(fs.readFileSync(resolvedRoster, 'utf8'));
  const rosterRows = Array.isArray(roster) ? roster : (roster && Array.isArray(roster.sessions) ? roster.sessions : []);
  const wantedSessionIds = new Set(rosterRows.map((row) => row.sessionId).filter(Boolean));
  const allTranscriptFiles = listTranscriptFiles(resolvedTranscripts);
  let transcriptFiles = allTranscriptFiles.filter((file) => {
    return wantedSessionIds.size === 0 || wantedSessionIds.has(path.basename(file, '.jsonl'));
  });
  const transcripts = transcriptFiles.map((file) => parseTranscript(fs.readFileSync(file, 'utf8'), file));
  let cycles = buildCycleRecords({ roster, transcripts, allowTranscriptEvidence: true });
  let verificationErrors = [];
  if (verifyGithub) {
    const tenantConfigs = loadTenantConfigs(tenantConfigsDir || path.join(__dirname, '..', 'tenants'));
    const verification = verifyPullRequests(cycles.records, tenantConfigs);
    verificationErrors = verification.errors;
    const errorsByKey = Object.fromEntries(verification.errors.map((item) => [item.key, item.error]));
    cycles = buildCycleRecords({ roster, transcripts, pullRequestStates: verification.states, verificationErrors: errorsByKey });
  }
  const latestEvidence = transcripts.reduce((latest, transcript) => {
    const timestamp = transcript.lastTimestamp ? new Date(transcript.lastTimestamp).getTime() : NaN;
    return Number.isFinite(timestamp) && timestamp > latest ? timestamp : latest;
  }, rosterRows.reduce((latest, row) => {
    const timestamp = row.retiredAt || row.startedAt || row.launchedAt;
    const value = timestamp ? new Date(timestamp).getTime() : NaN;
    return Number.isFinite(value) && value > latest ? value : latest;
  }, 0));
  const effectiveUntil = until || (latestEvidence ? new Date(latestEvidence + 1).toISOString() : '1970-01-01T00:00:00.000Z');
  const upper = new Date(effectiveUntil).getTime();
  const requestedLower = since ? new Date(since).getTime() : null;
  const dailyLower = requestedLower === null ? upper - 24 * 60 * 60 * 1000 : requestedLower;
  const summaryLower = upper - 7 * 24 * 60 * 60 * 1000;
  const filterWindow = (lower) => {
    const filtered = cycles.records.filter((record) => {
      const completed = new Date(record.completedAt).getTime();
      return Number.isFinite(completed) && completed >= lower && completed < upper;
    });
    const filteredSessions = cycles.sessionMetrics.filter((session) => {
      const start = session.firstTimestamp ? new Date(session.firstTimestamp).getTime() : NaN;
      const end = session.lastTimestamp ? new Date(session.lastTimestamp).getTime() : start;
      return Number.isFinite(start) && end >= lower && start < upper;
    });
    const filteredExcluded = cycles.excluded.filter((item) => {
      const timestamp = item.retiredAt || item.startedAt;
      if (!timestamp) return true;
      const value = new Date(timestamp).getTime();
      return Number.isFinite(value) && value >= lower && value < upper;
    });
    return { filtered, filteredSessions, filteredExcluded };
  };
  const dailyWindow = filterWindow(dailyLower);
  const summaryWindow = filterWindow(summaryLower);
  const reportOptions = (window, lower) => ({
    generatedAt: generatedAt || effectiveUntil,
    since: since || new Date(lower).toISOString(),
    until: until || effectiveUntil,
    sessionMetrics: window.filteredSessions,
    verificationErrors,
  });
  const dailyReport = buildReport(dailyWindow.filtered, dailyWindow.filteredExcluded, reportOptions(dailyWindow, dailyLower));
  const summaryReport = buildReport(summaryWindow.filtered, summaryWindow.filteredExcluded, reportOptions(summaryWindow, summaryLower));
  fs.mkdirSync(resolvedOutput, { recursive: true });
  const date = String(effectiveUntil).slice(0, 10);
  const dailyArtifact = path.join(resolvedOutput, `daily-${date}.json`);
  const summaryArtifact = path.join(resolvedOutput, `seven-day-${date}.md`);
  fs.writeFileSync(dailyArtifact, `${JSON.stringify(dailyReport, null, 2)}\n`, 'utf8');
  fs.writeFileSync(summaryArtifact, renderSummary(summaryReport), 'utf8');
  return { report: summaryReport, dailyReport, summaryReport, dailyArtifact, summaryArtifact };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = collectFromFiles({
      transcriptsDir: args.transcripts,
      rosterPath: args.roster,
      outputDir: args.out,
      since: args.since,
      until: args.until,
      generatedAt: args.now,
      verifyGithub: args['no-verify-github'] !== 'true',
    });
    process.stdout.write(`${JSON.stringify({
      dailyArtifact: result.dailyArtifact,
      summaryArtifact: result.summaryArtifact,
      completedUnits: result.report.sample.completedUnits,
      excludedUnits: result.report.sample.excludedUnits,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildCycleRecords,
  buildReport,
  classifyTurns,
  collectFromFiles,
  parseArgs,
  parseTranscript,
  renderSummary,
};
