'use strict';
// #131 (spec #91): a weekly scorecard, the audit's eight rows, written each Monday for the
// previous Monday-to-Sunday week, with its headline riding the daily summary.
// Red-tell: before bin/weekly-scorecard.js nothing weekly exists.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const workState = require('../bin/work-state');
const { buildScorecard, writeScorecard, parseEscapedFrom, renderScorecard, latestScorecard, headlineOf, cli, WEEKLY_SCORECARD_FLAGS, WeeklyScorecardError } = require('../bin/weekly-scorecard');

const NOW = '2026-09-28T12:40:00.000Z'; // Monday: the week is 2026-09-21..2026-09-27
const H = (n) => String(n).repeat(40).slice(0, 40);

function rootDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-scorecard-'));
  for (const dir of ['tenants', 'config', 'state/sentinel/shadow', 'state/verify']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'andydarknessb/Endzone-Empire', branchPrefix: 'fleet/' }));
  return root;
}

// One unit through the ledger. `steps` are [state, at] pairs after the reservation;
// `formal` records a formal review at that time (while in review).
function unit(root, issue, reservedAt, steps, { formal = null, risk = null, budget = null } = {}) {
  const id = `endzone:issue-${issue}`;
  let revision = workState.reserveRecord({ root, id, tenant: 'endzone', issue, idempotencyKey: `res-${issue}`, now: reservedAt }).revision;
  let riskDone = false;
  steps.forEach(([to, at, extra = {}], index) => {
    if (risk && !riskDone && to === 'pr-open') {
      riskDone = true;
      revision = workState.recordReview({ root, id, expectedRevision: revision, actor: `ic-${issue}`, idempotencyKey: `risk-${issue}`, now: risk, review: { kind: 'risk', headSha: H(issue), artifact: `state/reviews/endzone_issue-${issue}/risk-001.json` } }).revision;
    }
    revision = workState.transitionRecord({ root, id, expectedRevision: revision, to, idempotencyKey: `t-${issue}-${index}`, now: at, prNumber: 100 + issue, githubState: 'MERGED', githubMergedAt: at, testOnly: true, ...extra }).revision;
    if (budget && to === 'implementing') {
      revision = workState.recordBudget({ root, id, expectedRevision: revision, phase: 'warn', tokens: 61000, idempotencyKey: `w-${issue}`, now: budget }).revision;
    }
    if (formal && to === 'review' && !steps.slice(index + 1).some(([next]) => next === 'review')) {
      revision = workState.recordReview({ root, id, expectedRevision: revision, actor: 'pl-endzone', idempotencyKey: `formal-${issue}`, now: formal, review: { kind: 'formal', headSha: H(issue), artifact: `state/reviews/endzone_issue-${issue}/formal-001.json` } }).revision;
    }
  });
  return { id, revision };
}

function fixtureWeek() {
  const root = rootDir();
  // #11: 2 h reserve to merge, one formal review, a budget warning.
  unit(root, 11, '2026-09-22T00:00:00.000Z', [['implementing', '2026-09-22T00:10:00.000Z'], ['pr-open', '2026-09-22T00:30:00.000Z'], ['review', '2026-09-22T00:40:00.000Z'], ['merged', '2026-09-22T02:00:00.000Z']], { formal: '2026-09-22T01:00:00.000Z', budget: '2026-09-22T00:20:00.000Z' });
  // #12: sent back once, then merged 4 h after reservation, with a risk review.
  unit(root, 12, '2026-09-23T00:00:00.000Z', [['implementing', '2026-09-23T00:10:00.000Z'], ['pr-open', '2026-09-23T00:30:00.000Z'], ['review', '2026-09-23T00:40:00.000Z'], ['revision', '2026-09-23T01:00:00.000Z'], ['pr-open', '2026-09-23T02:00:00.000Z'], ['review', '2026-09-23T02:30:00.000Z'], ['merged', '2026-09-23T04:00:00.000Z']], { formal: '2026-09-23T03:00:00.000Z', risk: '2026-09-23T00:20:00.000Z' });
  // #13: reserved the week before, escalated on a budget for 72 h, merged with NO formal review.
  unit(root, 13, '2026-09-20T00:00:00.000Z', [['implementing', '2026-09-20T00:30:00.000Z'], ['escalated', '2026-09-21T01:00:00.000Z', { evidence: 'budget: 400000 job tokens >= 350000' }], ['implementing', '2026-09-24T01:00:00.000Z', { evidence: 'ruling: resume' }], ['pr-open', '2026-09-24T01:30:00.000Z'], ['review', '2026-09-24T02:00:00.000Z'], ['merged', '2026-09-24T03:00:00.000Z']]);
  // #14: merged without a formal review, acknowledged by a ruling.
  unit(root, 14, '2026-09-25T00:00:00.000Z', [['implementing', '2026-09-25T00:10:00.000Z'], ['pr-open', '2026-09-25T00:20:00.000Z'], ['review', '2026-09-25T00:30:00.000Z'], ['merged', '2026-09-25T01:00:00.000Z']]);
  fs.writeFileSync(path.join(root, 'config', 'review-exceptions.json'), JSON.stringify({ exceptions: [{ recordId: 'endzone:issue-14', head: 'unrecorded', ruling: 'test ruling' }] }));
  // #10: merged the week before; never counted.
  unit(root, 10, '2026-09-15T00:00:00.000Z', [['implementing', '2026-09-15T00:10:00.000Z'], ['pr-open', '2026-09-15T00:20:00.000Z'], ['review', '2026-09-15T00:30:00.000Z'], ['merged', '2026-09-15T01:00:00.000Z']], { formal: '2026-09-15T00:40:00.000Z' });
  // Watchdog shadow: 4 ticks in the week, 1 fleet-dead; the week before is ignored.
  const tick = (at, conditions) => JSON.stringify({ at, mode: 'live', conditions });
  fs.writeFileSync(path.join(root, 'state', 'sentinel', 'shadow', '20260922.jsonl'), [tick('2026-09-22T00:00:00Z', []), tick('2026-09-22T00:15:00Z', ['fleet-dead']), tick('2026-09-22T00:30:00Z', ['dated:x']), tick('2026-09-22T00:45:00Z', [])].join('\n'));
  fs.writeFileSync(path.join(root, 'state', 'sentinel', 'shadow', '20260915.jsonl'), [tick('2026-09-15T00:00:00Z', ['fleet-dead']), tick('2026-09-15T00:15:00Z', ['fleet-dead'])].join('\n'));
  // Ledger verification history: one fail and one pass in the week.
  fs.writeFileSync(path.join(root, 'state', 'verify', 'history.jsonl'), [
    { at: '2026-09-10T00:00:00Z', pass: true }, { at: '2026-09-22T00:00:00Z', pass: false, findingsByKind: { 'merged-without-review': 1 } }, { at: '2026-09-23T00:00:00Z', pass: true },
  ].map((l) => JSON.stringify(l)).join('\n'));
  return root;
}

function ghStub({ failIssues = false } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') {
      if (failIssues) throw new Error('HTTP 502');
      return JSON.stringify([
        { number: 900, createdAt: '2026-09-24T00:00:00Z', body: '### What happened\n\nboom\n\n### Escaped from PR #\n\n112\n' },
        { number: 901, createdAt: '2026-09-24T00:00:00Z', body: '### What happened\n\nx\n\n### Escaped from PR #\n\n_No response_\n' },
        { number: 902, createdAt: '2026-09-25T00:00:00Z', body: 'filed by hand, no form' },
        { number: 903, createdAt: '2026-09-26T00:00:00Z', body: '### Escaped from PR #\n#77' },
      ]);
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const heads = { 112: 'fleet/12-thing', 77: 'feature/by-hand' };
      return JSON.stringify({ number: Number(args[2]), headRefName: heads[Number(args[2])] });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

const collectorReport = () => ({
  period: { since: '2026-09-21T00:00:00.000Z', until: '2026-09-28T00:00:00.000Z' },
  unitMetrics: { completedUnits: 4, icJobTokensMedian: 50000, icJobTokensP90: 90000, icByModel: { haiku: { units: 1, jobTokensMedian: 30000, jobTokensP90: 30000, target: null, pass: null }, sonnet: { units: 3, jobTokensMedian: 60000, jobTokensP90: 90000, target: null, pass: null } } },
  riskReviewer: { runs: 2, jobTokens: 8000, freshTokens: 9000, byModel: { opus: { runs: 2, jobTokens: 8000 } } },
});

function build(root = fixtureWeek(), stub = ghStub()) {
  return buildScorecard({ root, now: NOW, gh: stub.gh, collect: () => collectorReport() });
}

test('#131: a fixture week produces all eight rows in markdown and JSON', () => {
  const root = fixtureWeek();
  const card = writeScorecard({ root, now: NOW, gh: ghStub().gh, collect: () => collectorReport() });
  assert.equal(card.week.label, '2026-09-21..2026-09-27');
  const json = JSON.parse(fs.readFileSync(path.join(root, 'state', 'metrics', 'scorecard-2026-09-21.json'), 'utf8'));
  assert.deepEqual(json.rows.map((r) => r.key).slice(0, 8), ['throughput', 'cycleTime', 'issueToMergeTail', 'sentBack', 'reviewGate', 'escapedDefects', 'availability', 'icCost']);
  assert.equal(json.rows[8].key, 'boundedAuthority', 'spec #193 adds the ninth row');
  const md = fs.readFileSync(path.join(root, 'state', 'metrics', 'scorecard-2026-09-21.md'), 'utf8');
  for (const area of ['Throughput', 'Cycle time', 'Issue-to-merge tail', 'Sent back at least once', 'Review gate', 'Escaped defects', 'Availability', 'IC cost']) {
    assert.match(md, new RegExp(`^\\| ${area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`, 'm'), area);
  }
});

test('#131: the ledger rows: throughput, cycle time, tail and sent back', () => {
  const card = build();
  const row = (key) => card.rows.find((r) => r.key === key);
  assert.equal(row('throughput').figures.merged, 4, '#10 merged the week before and is not counted');
  assert.deepEqual(row('cycleTime').figures, { units: 4, medianHours: 3, p90Hours: 99, maxHours: 99, maxIssue: 13 });
  assert.equal(row('cycleTime').status, 'watch');
  assert.deepEqual(row('issueToMergeTail').figures.units.map((u) => [u.issue, u.hours, u.decisionHours]), [[13, 99, 72]]);
  assert.deepEqual(row('sentBack').figures, { units: 1, of: 4, rate: 0.25, maxSendBacks: 1, maxIssue: 12 });
});

test('#131: the review gate counts formal and risk reviews and separates acknowledged merges', () => {
  const card = build();
  const gate = card.rows.find((r) => r.key === 'reviewGate');
  assert.equal(gate.figures.formal, 2);
  assert.equal(gate.figures.risk, 1);
  assert.deepEqual(gate.figures.mergedWithoutReview, [13]);
  assert.deepEqual(gate.figures.acknowledged, [14]);
  assert.equal(gate.status, 'weak');
});

test('#131: the escaped-defects row prints the classified and the unclassified count', () => {
  const card = build();
  const row = card.rows.find((r) => r.key === 'escapedDefects');
  assert.deepEqual(row.figures, { bugs: 4, escapedFromFleet: [{ issue: 900, pr: 112 }], namedNonFleet: [{ issue: 903, pr: 77 }], none: [], unknown: 0, fromProposal: 0, unclassified: 2, merged: 4, rate: 0.25 });
  assert.match(row.result, /1 escaped from a fleet PR/);
  assert.match(row.result, /2 unclassified/);
});

test('#131: before the template lands the escaped row reads 0 classified with N unclassified', () => {
  const root = fixtureWeek();
  const stub = { gh: (args) => (args[1] === 'list' ? JSON.stringify([{ number: 1, body: 'plain' }, { number: 2, body: '' }]) : '{}') };
  const card = buildScorecard({ root, now: NOW, gh: stub.gh, collect: () => collectorReport() });
  const row = card.rows.find((r) => r.key === 'escapedDefects');
  assert.equal(row.figures.escapedFromFleet.length, 0);
  assert.equal(row.figures.unclassified, 2);
  assert.match(row.result, /0 escaped from a fleet PR.*2 unclassified/);
});

test('#131: a GitHub failure makes the escaped row unknown, never a fake zero', () => {
  const card = build(fixtureWeek(), ghStub({ failIssues: true }));
  const row = card.rows.find((r) => r.key === 'escapedDefects');
  assert.equal(row.status, 'unknown');
  assert.match(row.result, /unavailable: HTTP 502/);
});

test('#131: availability is fleet-dead ticks over total ticks in the week', () => {
  const row = build().rows.find((r) => r.key === 'availability');
  assert.deepEqual(row.figures, { ticks: 4, fleetDeadTicks: 1, rate: 0.25 });
  assert.equal(row.status, 'weak');
});

test('#131: IC cost shows the collector whole-life figures and the budget.js escalations as two separate lines', () => {
  const root = fixtureWeek();
  const card = writeScorecard({ root, now: NOW, gh: ghStub().gh, collect: () => collectorReport() });
  const row = card.rows.find((r) => r.key === 'icCost');
  assert.equal(row.figures.collector.byModel.sonnet.jobTokensMedian, 60000);
  assert.deepEqual(row.figures.budget, { warnings: 1, escalations: 1 });
  assert.equal(row.status, 'n/a', 'reported, not judged (#128)');
  const md = fs.readFileSync(path.join(root, 'state', 'metrics', 'scorecard-2026-09-21.md'), 'utf8');
  assert.match(md, /^- Whole-life \(cycle collector\): haiku median 30000, p90 30000 \(1 unit\); sonnet median 60000, p90 90000 \(3 units\); risk reviewer 2 run\(s\), 8000 job tokens$/m);
  assert.match(md, /^- budget\.js \(enforcement, spending states only\): 1 warning\(s\), 1 escalation\(s\)$/m);
});

test('#131: the week verification history is printed under the table', () => {
  const root = fixtureWeek();
  const card = writeScorecard({ root, now: NOW, gh: ghStub().gh, collect: () => collectorReport() });
  assert.deepEqual(card.verifyHistory, { runs: 2, pass: 1, fail: 1 });
  assert.match(fs.readFileSync(path.join(root, 'state', 'metrics', 'scorecard-2026-09-21.md'), 'utf8'), /^Ledger verification this week: 2 run\(s\), 1 pass, 1 fail\.$/m);
});

test('#131: the headline is the week and its weakest row', () => {
  const card = build();
  assert.equal(card.headline.area, 'Review gate');
  assert.equal(card.headline.status, 'weak');
  assert.match(headlineOf(card), /^Scorecard 2026-09-21\.\.2026-09-27: weakest row Review gate \(weak\): /);
});

test('#131: parseEscapedFrom reads the form heading and nothing else', () => {
  assert.equal(parseEscapedFrom('### Escaped from PR #\n\n1545\n\n### Other\n\n9'), 1545);
  assert.equal(parseEscapedFrom('### Escaped from PR #\n\n#1545'), 1545);
  assert.equal(parseEscapedFrom('### Escaped from PR #\n\n_No response_\n'), null);
  assert.equal(parseEscapedFrom('PR #1545 broke it'), null);
  assert.equal(parseEscapedFrom(null), null);
});

test('#131: latestScorecard returns the newest file, or null when none exists', () => {
  const root = rootDir();
  assert.equal(latestScorecard(root), null);
  const dir = path.join(root, 'state', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scorecard-2026-09-14.json'), JSON.stringify({ week: { label: 'old' } }));
  fs.writeFileSync(path.join(dir, 'scorecard-2026-09-21.json'), JSON.stringify({ week: { label: 'new' } }));
  assert.equal(latestScorecard(root).week.label, 'new');
});

test('#131: rendering is deterministic', () => {
  const card = build();
  assert.equal(renderScorecard(card), renderScorecard(JSON.parse(JSON.stringify(card))));
});

test('#131: cli refuses an unknown flag', () => {
  assert.throws(() => cli(['--week', 'x']), (error) => {
    assert.ok(error instanceof WeeklyScorecardError);
    assert.equal(error.code, 'USAGE');
    for (const flag of WEEKLY_SCORECARD_FLAGS) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('#131: a dry run writes nothing under state/ and tells the collector so', () => {
  const root = fixtureWeek();
  const seen = [];
  const card = writeScorecard({ root, now: NOW, gh: ghStub().gh, collect: (options) => { seen.push(options.dryRun); return collectorReport(); }, dryRun: true });
  assert.deepEqual(seen, [true]);
  assert.equal(card.artifacts, undefined);
  assert.equal(fs.existsSync(path.join(root, 'state', 'metrics')), false);
});

test('#131 review: the IC cost table cell carries the per-family medians', () => {
  const row = build().rows.find((r) => r.key === 'icCost');
  assert.match(row.result, /whole-life: haiku median 30000 \(1 unit\), sonnet median 60000 \(3 units\)/);
  assert.match(row.result, /budget\.js 1 warning\(s\), 1 escalation\(s\)/);
});

// Spec fleet #93 / #155: the scorecard says who merged into the default branch.
test('#155: the scorecard prints merges by the owner and by the fleet for the week', () => {
  const root = fixtureWeek();
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'andydarknessb/Endzone-Empire', branchPrefix: 'fleet/', ownerLogin: 'cory-owner', fleetIdentity: 'fleet-bot' }));
  const merger = { 'endzone:issue-11': 'fleet-bot', 'endzone:issue-12': 'fleet-bot', 'endzone:issue-13': 'Cory-Owner' };
  const dir = path.join(root, 'state', 'events');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    for (const event of lines) if (event.type === 'state-merged' && merger[event.recordId]) event.changes.mergedBy = merger[event.recordId];
    fs.writeFileSync(path.join(dir, file), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  }
  const card = writeScorecard({ root, now: NOW, gh: ghStub().gh, collect: () => collectorReport() });
  assert.deepEqual(card.mergesBy, { owner: 1, fleet: 2, shared: 0, other: 0, unrecorded: 1, merged: 4, otherLogins: [] });
  const md = fs.readFileSync(path.join(root, 'state', 'metrics', 'scorecard-2026-09-21.md'), 'utf8');
  assert.match(md, /^Merges into the default branch this week: 1 by the owner, 2 by the fleet, 1 with no merger recorded\.$/m);
});

test('#155: a tenant whose owner and fleet share a login counts its merges as shared', () => {
  const root = fixtureWeek();
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', ownerLogin: 'andydarknessb', fleetIdentity: 'andydarknessb' }));
  const dir = path.join(root, 'state', 'events');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    for (const event of lines) if (event.type === 'state-merged') event.changes.mergedBy = 'andydarknessb';
    fs.writeFileSync(path.join(dir, file), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  }
  assert.equal(build(root).mergesBy.shared, 4);
});

// #213 (spec #193): a bug's Triage proposal carries `Escaped from: #<PR> | none | unknown`.
// The collector reads it for bugs whose issue form field is empty (every Nidus bug has no form).
const proposalComment = (escaped, createdAt = '2026-09-25T00:00:00Z') => ({ createdAt, body: `## Triage proposal (advisory)\nClassification: bug\nRoot cause: x\n${escaped === null ? '' : `Escaped from: ${escaped}\n`}Ruling: none needed` });
const chatter = (body, createdAt = '2026-09-25T01:00:00Z') => ({ createdAt, body });

function proposalGhStub() {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') {
      return JSON.stringify([
        { number: 910, createdAt: '2026-09-24T00:00:00Z', body: 'no form', comments: [proposalComment('#112')] },
        { number: 911, createdAt: '2026-09-24T00:00:00Z', body: 'no form', comments: [proposalComment('none')] },
        { number: 912, createdAt: '2026-09-24T00:00:00Z', body: 'no form', comments: [proposalComment('unknown')] },
        { number: 913, createdAt: '2026-09-24T00:00:00Z', body: 'no form', comments: [chatter('looking at this')] },
        { number: 914, createdAt: '2026-09-24T00:00:00Z', body: 'no form', comments: [proposalComment('#77', '2026-09-24T01:00:00Z'), proposalComment('none', '2026-09-25T01:00:00Z')] },
        { number: 915, createdAt: '2026-09-24T00:00:00Z', body: '### Escaped from PR #\n\n77\n', comments: [proposalComment('none')] },
        { number: 916, createdAt: '2026-09-24T00:00:00Z', body: 'no form', comments: [proposalComment('maybe #12')] },
        { number: 917, createdAt: '2026-09-24T00:00:00Z', body: 'no form', comments: [chatter('Escaped from: #112')] },
        { number: 918, createdAt: '2026-09-24T00:00:00Z', body: 'no form' },
      ]);
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const heads = { 112: 'fleet/12-thing', 77: 'feature/by-hand' };
      return JSON.stringify({ number: Number(args[2]), headRefName: heads[Number(args[2])] });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

test('#213: the escaped row counts the proposal\'s Escaped from line for bugs with no form value, and says how many stay unclassified', () => {
  const stub = proposalGhStub();
  const card = build(fixtureWeek(), stub);
  const row = card.rows.find((r) => r.key === 'escapedDefects');
  assert.deepEqual(row.figures.escapedFromFleet, [{ issue: 910, pr: 112 }]);
  assert.deepEqual(row.figures.namedNonFleet, [{ issue: 915, pr: 77 }], 'the form field wins over the proposal');
  assert.deepEqual(row.figures.none, [911, 914], 'the newest proposal wins, and none is a classification');
  assert.equal(row.figures.unknown, 1);
  assert.equal(row.figures.fromProposal, 3, 'bugs 910, 911 and 914 were classified from their proposals');
  // 912 unknown, 913 no proposal, 916 malformed value, 917 not a proposal comment, 918 no comments at all.
  assert.equal(row.figures.unclassified, 5);
  assert.equal(row.figures.bugs, 9);
  assert.match(row.result, /1 escaped from a fleet PR \(#910 from PR #112\)/);
  assert.match(row.result, /2 traced to no PR/);
  assert.match(row.result, /5 unclassified \(1 marked unknown\)/);
  assert.equal(row.status, 'weak', 'an escape from a fleet PR is still counted against the merged units');
  const list = stub.calls.find((args) => args[0] === 'issue' && args[1] === 'list');
  assert.match(list[list.indexOf('--json') + 1], /comments/, 'the collector asks GitHub for the comments');
});

test('#213: parseProposalEscapedFrom reads only the newest Triage proposal and only an exact value', () => {
  const { parseProposalEscapedFrom } = require('../bin/weekly-scorecard');
  assert.deepEqual(parseProposalEscapedFrom([proposalComment('#1545')]), { kind: 'pr', pr: 1545 });
  assert.deepEqual(parseProposalEscapedFrom([proposalComment('none')]), { kind: 'none' });
  assert.deepEqual(parseProposalEscapedFrom([proposalComment('  UNKNOWN  ')]), { kind: 'unknown' });
  assert.deepEqual(parseProposalEscapedFrom([proposalComment('#5', '2026-09-01T00:00:00Z'), proposalComment('none', '2026-09-02T00:00:00Z')]), { kind: 'none' });
  assert.deepEqual(parseProposalEscapedFrom([proposalComment('none', '2026-09-01T00:00:00Z'), proposalComment(null, '2026-09-02T00:00:00Z')]), null, 'a newer proposal without the line is not silently the older one');
  assert.equal(parseProposalEscapedFrom([proposalComment('#5 (probably)')]), null);
  assert.equal(parseProposalEscapedFrom([proposalComment('5')]), null);
  assert.equal(parseProposalEscapedFrom([chatter('Escaped from: #5')]), null);
  assert.equal(parseProposalEscapedFrom([]), null);
  assert.equal(parseProposalEscapedFrom(undefined), null);
});

test('#213: the newest comment headed Ruling or Triage proposal decides: a later Ruling overrides the proposal, and a later proposal overrides the Ruling', () => {
  const { parseProposalEscapedFrom } = require('../bin/weekly-scorecard');
  const ruling = (escaped, createdAt) => ({ createdAt, body: `## Ruling\nApproved without edits: https://x/1. Finalized by script (fleet #207).\n\nClassification: bug\nEscaped from: ${escaped}\nRuling: none needed\n\nLabels: ready-for-agent, bug; triage-proposed removed.` });
  assert.deepEqual(parseProposalEscapedFrom([proposalComment('unknown', '2026-09-24T00:00:00Z'), ruling('#12', '2026-09-25T00:00:00Z')]), { kind: 'pr', pr: 12 });
  assert.deepEqual(parseProposalEscapedFrom([ruling('#12', '2026-09-25T00:00:00Z'), proposalComment('none', '2026-09-26T00:00:00Z')]), { kind: 'none' });
  assert.deepEqual(parseProposalEscapedFrom([proposalComment('#5', '2026-09-24T00:00:00Z'), { createdAt: '2026-09-25T00:00:00Z', body: '## Ruling\nrestated without the line' }]), null);
});

// Spec fleet #193 (#211): the scorecard gains a row for how Bounded authority was used:
// bounded readies, vetoes and suspensions in the week, and any suspension still standing.
function triageRows(root, tenant, rows) {
  fs.mkdirSync(path.join(root, 'state', 'triage'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'triage', `${tenant}.jsonl`), rows.map((row) => `${JSON.stringify({ schemaVersion: 1, tenant, actor: 'principal', ...row })}\n`).join(''));
}

test('#211: the Bounded authority row counts the week\'s bounded readies, vetoes and suspensions, and names a standing suspension', () => {
  const root = fixtureWeek();
  triageRows(root, 'endzone', [
    { kind: 'bounded-ready', issue: 21, at: '2026-09-15T10:00:00.000Z', bodyHash: 'a' },      // the week before
    { kind: 'bounded-ready', issue: 22, at: '2026-09-22T10:00:00.000Z', bodyHash: 'b' },
    { kind: 'bounded-ready', issue: 23, at: '2026-09-23T10:00:00.000Z', bodyHash: 'c' },
    { kind: 'bounded-ready', issue: 24, at: '2026-09-27T23:59:00.000Z', bodyHash: 'd' },
    { kind: 'veto', issue: 23, at: '2026-09-23T12:00:00.000Z', by: 'owner' },
    { kind: 'suspended', issue: 22, at: '2026-09-25T10:00:00.000Z', cause: 'escalation', standing: false, evidenceIds: ['endzone:issue-22#4'] },
    { kind: 'suspended', issue: 24, at: '2026-09-26T10:00:00.000Z', cause: 'escape', standing: true, evidenceIds: ['escape:30:1024'] },   // evidence while one already stood
    { kind: 'proposed', issue: 25, at: '2026-09-24T10:00:00.000Z', bodyHash: 'e', commentUrl: 'https://x/25', model: 'fable' },
  ]);
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'bounded-authority-suspended-endzone'), JSON.stringify({ tenant: 'endzone', at: '2026-09-25T10:00:00.000Z', cause: 'escalation', issue: 22, detail: 'endzone:issue-22 escalated with reason criteria-defect' }));
  const card = build(root);
  const row = card.rows.find((r) => r.key === 'boundedAuthority');
  assert.equal(row.area, 'Bounded authority');
  assert.deepEqual(row.figures, { readied: 3, vetoed: 1, suspended: 1, standing: ['endzone'], byTenant: { endzone: { readied: 3, vetoed: 1, suspended: 1 } } });
  assert.match(row.result, /3 readied under Bounded authority, 1 vetoed, 1 suspension/);
  assert.match(row.result, /suspension standing: endzone/);
  assert.equal(row.status, 'weak');
  assert.match(renderScorecard(card), /^\| Bounded authority \|/m);
});

test('#211: the Bounded authority row is good when used without a veto or a suspension, watch after a veto, and n/a when unused', () => {
  const at = (day) => `2026-09-${day}T10:00:00.000Z`;
  const rowFor = (rows) => { const root = fixtureWeek(); if (rows) triageRows(root, 'endzone', rows); return build(root).rows.find((r) => r.key === 'boundedAuthority'); };
  const unused = rowFor(null);
  assert.equal(unused.status, 'n/a');
  assert.match(unused.result, /0 readied under Bounded authority, 0 vetoed, 0 suspensions/);
  assert.equal(rowFor([{ kind: 'bounded-ready', issue: 22, at: at(22), bodyHash: 'b' }]).status, 'good');
  const vetoed = rowFor([{ kind: 'bounded-ready', issue: 22, at: at(22), bodyHash: 'b' }, { kind: 'veto', issue: 22, at: at(22), by: 'owner' }]);
  assert.equal(vetoed.status, 'watch');
  assert.equal(vetoed.figures.suspended, 0);
});
