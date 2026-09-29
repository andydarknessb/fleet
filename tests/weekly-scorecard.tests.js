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

test('#131: a fixture week produces every row in markdown and JSON', () => {
  const root = fixtureWeek();
  const card = writeScorecard({ root, now: NOW, gh: ghStub().gh, collect: () => collectorReport() });
  assert.equal(card.week.label, '2026-09-21..2026-09-27');
  const json = JSON.parse(fs.readFileSync(path.join(root, 'state', 'metrics', 'scorecard-2026-09-21.json'), 'utf8'));
  assert.deepEqual(json.rows.map((r) => r.key), ['throughput', 'cycleTime', 'issueToMergeTail', 'sentBack', 'reviewGate', 'escapedDefects', 'availability', 'waitingOnCory', 'icIdleShare', 'reviewPickup', 'icCost']);
  const md = fs.readFileSync(path.join(root, 'state', 'metrics', 'scorecard-2026-09-21.md'), 'utf8');
  for (const area of ['Throughput', 'Cycle time', 'Issue-to-merge tail', 'Sent back at least once', 'Review gate', 'Escaped defects', 'Availability', 'Waiting on Cory', 'IC idle share', 'Review pickup latency', 'IC cost']) {
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
  assert.deepEqual(row.figures, { bugs: 4, escapedFromFleet: [{ issue: 900, pr: 112 }], namedNonFleet: [{ issue: 903, pr: 77 }], unclassified: 2, merged: 4, rate: 0.25 });
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

// #214 (spec #195): the "Waiting on Cory" and "IC idle share" rows. Both are reported, not
// judged: no threshold has been ruled for either, so their status stays n/a.
const page = (at, name, body, extra = {}) => JSON.stringify({ at, kind: 'human-wait', title: 'Fleet watchdog', body, priority: 'normal', toast: true, pushover: 'unconfigured', pushoverError: null, attempts: 0, detail: { key: `human-wait:${name}` }, ...extra });
const otherPage = (at) => JSON.stringify({ at, kind: 'dated', title: 'Fleet watchdog', body: 'x', priority: 'normal', pushover: 'unconfigured', attempts: 0, detail: { key: 'dated:x' } });
const shadowTick = (at, conditions) => JSON.stringify({ at, mode: 'live', conditions });
const ticks = (from, count, stepMinutes = 15) => Array.from({ length: count }, (_, i) => new Date(Date.parse(from) + i * stepMinutes * 60000).toISOString());

function waitFixture() {
  const root = fixtureWeek();
  fs.mkdirSync(path.join(root, 'state', 'pages'), { recursive: true });
  const rows = [otherPage('2026-09-20T00:00:00Z')];
  // pl-endzone: one ask for 3 ticks (45 min), then a gap of over 35 minutes and a new ask for 2 ticks (30 min).
  for (const at of ticks('2026-09-22T10:00:00Z', 3)) rows.push(page(at, 'pl-endzone', 'merge PR #1690 and #1691'));
  for (const at of ticks('2026-09-22T14:00:00Z', 2)) rows.push(page(at, 'pl-endzone', 'squash-merge #1695'));
  // The dispatcher relays asks upward: its rows are never counted, whether or not a lead asks the same.
  for (const at of ticks('2026-09-22T10:15:00Z', 2)) rows.push(page(at, 'dispatcher', 'run `gh pr merge 1690` and 1691, then release'));
  rows.push(page('2026-09-23T08:00:00Z', 'dispatcher', 'release integration to main'));
  rows.push(page('2026-09-22T14:15:00Z', 'dispatcher', 'release integration to main'));
  // A Principal's ask inside the lead's 14:00-14:30 wait: the session-hours add, the hours someone waits do not.
  rows.push(page('2026-09-22T14:15:00Z', 'pe-endzone', 'approve #1695'));
  // An IC's wait is never counted.
  for (const at of ticks('2026-09-22T10:00:00Z', 4)) rows.push(page(at, 'ic-3', 'project lead to review'));
  // A wait that opened before the week: only the part inside the week counts, and it is not an episode of this week.
  for (const at of ticks('2026-09-20T23:45:00Z', 3)) rows.push(page(at, 'pl-nidus', 'merge PR #16'));
  // After the week: never counted.
  rows.push(page('2026-09-28T00:00:00Z', 'pl-endzone', 'later'));
  // pe-nidus: one delivered page (a delivered page is never written again); the standing wait shows in the watchdog ticks.
  rows.push(page('2026-09-24T12:00:00Z', 'pe-nidus', 'Approved on #17', { pushover: true, attempts: 1 }));
  fs.writeFileSync(path.join(root, 'state', 'pages', 'pages.jsonl'), `${rows.join('\n')}\n`);
  const shadowFile = path.join(root, 'state', 'sentinel', 'shadow', '20260924.jsonl');
  fs.writeFileSync(shadowFile, `${ticks('2026-09-24T12:00:00Z', 4).map((at) => shadowTick(at, ['human-wait:pe-nidus'])).join('\n')}\n${shadowTick('2026-09-24T13:00:00Z', [])}\n`);
  return root;
}

test('#214: Waiting on Cory counts project lead and Principal session-hours and episodes, without the dispatcher or ICs', () => {
  const row = build(waitFixture()).rows.find((r) => r.key === 'waitingOnCory');
  assert.equal(row.area, 'Waiting on Cory');
  // pl-endzone 45 + 30 min, pe-endzone 15 min, pe-nidus 60 min (four watchdog ticks), pl-nidus 30 min inside the week.
  assert.equal(row.figures.sessionHours, 3);
  assert.equal(row.figures.episodes, 4, 'the pl-nidus wait opened before the week and is not an episode of it');
  assert.deepEqual(row.figures.bySession, {
    'pe-endzone': { role: 'principal', hours: 0.3, episodes: 1 },
    'pe-nidus': { role: 'principal', hours: 1, episodes: 1 },
    'pl-endzone': { role: 'project-lead', hours: 1.3, episodes: 2 },
    'pl-nidus': { role: 'project-lead', hours: 0.5, episodes: 0 },
  });
  assert.deepEqual(row.figures.dispatcherRepeats, { episodes: 3, hours: 1 }, 'the dispatcher: 30 + 15 + 15 min, reported and left out');
  assert.equal(row.status, 'n/a');
  assert.match(row.result, /3 session-hours in 4 episodes/);
  assert.match(row.result, /excluding the dispatcher's 3 episodes \(1 h\)/);
});

test('#214: Waiting on Cory reports the hours at least one project lead or Principal was waiting, counted once', () => {
  const row = build(waitFixture()).rows.find((r) => r.key === 'waitingOnCory');
  // 3 session-hours, 2.75 hours with someone waiting: pe-endzone's 14:15 ask sits inside pl-endzone's wait.
  assert.equal(row.figures.anyWaitingHours, 2.8);
  assert.equal(row.figures.weekHours, 168);
  assert.equal(row.figures.anyWaitingShare, 0.016);
});

test('#214: Waiting on Cory is unknown when the page log is missing or does not reach the week', () => {
  const root = waitFixture();
  fs.writeFileSync(path.join(root, 'state', 'pages', 'pages.jsonl'), `${page('2026-09-30T00:00:00Z', 'pl-endzone', 'later')}\n`);
  const row = build(root).rows.find((r) => r.key === 'waitingOnCory');
  assert.equal(row.status, 'unknown');
  assert.match(row.result, /page log starts 2026-09-30/);
  fs.rmSync(path.join(root, 'state', 'pages'), { recursive: true });
  assert.equal(build(root).rows.find((r) => r.key === 'waitingOnCory').status, 'unknown');
});

test('#214: a week the page log only partly covers says so', () => {
  const root = waitFixture();
  const file = path.join(root, 'state', 'pages', 'pages.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((line) => !line.includes('"dated:x"') && !line.includes('pl-nidus')).join('\n'));
  const row = build(root).rows.find((r) => r.key === 'waitingOnCory');
  assert.match(row.result, /page log starts 2026-09-22T10:00/);
});

function icFixture() {
  const root = fixtureWeek();
  fs.writeFileSync(path.join(root, 'tenants', 'nidus.json'), JSON.stringify({ name: 'nidus', maxIcs: 2 }));
  const ic = (name, tenant, launchedAt, retiredAt) => ({ name, role: 'ic', tenant, status: retiredAt ? 'retired' : 'active', launchedAt, ...(retiredAt ? { retiredAt } : {}) });
  const rosterRows = [
    ic('ic-1', 'endzone', '2026-09-20T22:00:00Z', '2026-09-21T02:00:00Z'), // launched the week before: 2 h are in the week
    ic('ic-3', 'endzone', '2026-09-21T01:30:00Z', '2026-09-21T04:00:00Z'), // also archived: counted once
    ic('ic-4', 'endzone', '2026-09-27T20:00:00Z', null), // still running at the week's end: 4 h
    ic('ic-9', 'endzone', '2026-09-28T01:00:00Z', null), // launched after the week
    { name: 'pl-endzone', role: 'project-lead', tenant: 'endzone', status: 'active', launchedAt: '2026-09-20T00:00:00Z' },
  ];
  fs.writeFileSync(path.join(root, 'state', 'roster.json'), JSON.stringify({ sessions: rosterRows }));
  fs.mkdirSync(path.join(root, 'state', 'archive'), { recursive: true });
  const archived = [
    ic('ic-2', 'endzone', '2026-09-21T01:00:00Z', '2026-09-21T03:00:00Z'),
    ic('ic-3', 'endzone', '2026-09-21T01:30:00Z', '2026-09-21T04:00:00Z'),
    ic('ic-5', 'nidus', '2026-09-22T00:00:00Z', '2026-09-22T12:00:00Z'),
    ic('ic-0', 'endzone', '2026-09-01T00:00:00Z', '2026-09-01T05:00:00Z'), // long before the week
    { name: 'dispatcher', role: 'dispatcher', tenant: null, status: 'retired', launchedAt: '2026-09-21T00:00:00Z', retiredAt: '2026-09-27T00:00:00Z' },
  ];
  fs.writeFileSync(path.join(root, 'state', 'archive', 'roster-retired-full.jsonl'), `${archived.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return root;
}

test('#214: IC idle share is the share of the week with no IC running, fleet-wide and per tenant, clipped to the week', () => {
  const row = build(icFixture()).rows.find((r) => r.key === 'icIdleShare');
  assert.equal(row.area, 'IC idle share');
  // ICs run 09-21 00:00-04:00 (ic-1 clipped at the week start), 09-22 00:00-12:00 (nidus) and 09-27 20:00-24:00 (ic-4, open at the week's end): 20 of 168 h.
  assert.equal(row.figures.weekHours, 168);
  assert.equal(row.figures.noIcHours, 148);
  assert.equal(row.figures.noIcShare, 0.881);
  assert.deepEqual(row.figures.byTenant, { endzone: { noIcHours: 160, noIcShare: 0.952 }, nidus: { noIcHours: 156, noIcShare: 0.929 } });
  assert.equal(row.status, 'n/a');
});

test('#214: IC idle share also reports the share of the week at the IC cap', () => {
  const row = build(icFixture()).rows.find((r) => r.key === 'icIdleShare');
  // ic-1, ic-2 and ic-3 overlap 01:30-02:00 on 09-21: three at once for half an hour.
  assert.equal(row.figures.icCap, 3);
  assert.equal(row.figures.atCapHours, 0.5);
  assert.equal(row.figures.atCapShare, 0.003);
  assert.match(row.result, /no IC running 88\.1% of the week/);
  assert.match(row.result, /at the cap of 3 for 0\.3%/);
  assert.match(row.result, /endzone 95\.2%, nidus 92\.9%/);
});

test('#214: IC idle share is unknown with no roster at all, and reads 100% for a week the roster covers with no IC', () => {
  const root = fixtureWeek();
  assert.equal(build(root).rows.find((r) => r.key === 'icIdleShare').status, 'unknown');
  fs.writeFileSync(path.join(root, 'state', 'roster.json'), JSON.stringify({ sessions: [{ name: 'dispatcher', role: 'dispatcher', status: 'active', launchedAt: '2026-09-01T00:00:00Z' }] }));
  const row = build(root).rows.find((r) => r.key === 'icIdleShare');
  assert.equal(row.figures.noIcShare, 1);
  assert.equal(row.figures.atCapShare, 0);
});

test('#214: an ask that changes inside a tick is two episodes that never overlap', () => {
  const root = fixtureWeek();
  fs.mkdirSync(path.join(root, 'state', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'pages', 'pages.jsonl'), `${[otherPage('2026-09-20T00:00:00Z'), page('2026-09-22T12:00:05Z', 'pe-endzone', 'rule on #1'), page('2026-09-22T12:30:05Z', 'pe-endzone', 'rule on #2')].join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'state', 'sentinel', 'shadow', '20260922.jsonl'), `${ticks('2026-09-22T12:00:00Z', 4).map((at) => shadowTick(at, ['human-wait:pe-endzone'])).join('\n')}\n`);
  const row = build(root).rows.find((r) => r.key === 'waitingOnCory');
  assert.deepEqual(row.figures.bySession, { 'pe-endzone': { role: 'principal', hours: 1, episodes: 2 } });
});

// #215 (spec #195): review pickup latency per unit, from the record entering review to the
// first formal review recorded, as median and p90 for the week the review landed in.
test('#215: review pickup latency is the median and p90 from entering review to the first formal review, per unit', () => {
  const row = build().rows.find((r) => r.key === 'reviewPickup');
  assert.equal(row.area, 'Review pickup latency');
  // #11: review 00:40, formal 01:00 (20 min). #12: its first stay ended in a send-back with no formal review,
  // its second stay opened at 02:30 and the formal review came at 03:00 (30 min). #13 and #14 merged with none.
  assert.deepEqual(row.figures, { units: 2, medianMinutes: 25, p90Minutes: 30, maxMinutes: 30, maxIssue: 12, noFormal: 2, samples: [{ issue: 11, minutes: 20 }, { issue: 12, minutes: 30 }] });
  assert.equal(row.status, 'n/a');
  assert.match(row.result, /^n=2 units with a formal review in the week: median 25 min, p90 30 min, max 30 min \(#12\); 2 units entered review and got none$/);
});

test('#215: a unit counts in the week its formal review landed', () => {
  const root = fixtureWeek();
  // #15: in review 00:30, formal review 00:50 (20 min), in the week.
  unit(root, 15, '2026-09-26T00:00:00.000Z', [['implementing', '2026-09-26T00:10:00.000Z'], ['pr-open', '2026-09-26T00:20:00.000Z'], ['review', '2026-09-26T00:30:00.000Z'], ['merged', '2026-09-26T02:00:00.000Z']], { formal: '2026-09-26T00:50:00.000Z' });
  // #16: entered review the week before, its formal review landed in this week (20 min).
  unit(root, 16, '2026-09-20T22:00:00.000Z', [['implementing', '2026-09-20T22:10:00.000Z'], ['pr-open', '2026-09-20T23:40:00.000Z'], ['review', '2026-09-20T23:50:00.000Z'], ['merged', '2026-09-21T00:30:00.000Z']], { formal: '2026-09-21T00:10:00.000Z' });
  const row = build(root).rows.find((r) => r.key === 'reviewPickup');
  assert.deepEqual(row.figures.samples, [{ issue: 11, minutes: 20 }, { issue: 12, minutes: 30 }, { issue: 15, minutes: 20 }, { issue: 16, minutes: 20 }]);
  assert.equal(row.figures.units, 4);
  assert.equal(row.figures.noFormal, 2, '#16 entered review before the week and is not one of the units that got none');
});

test('#215: the first of two formal reviews in a stay is the pickup', () => {
  const root = fixtureWeek();
  const { id, revision } = unit(root, 17, '2026-09-26T00:00:00.000Z', [['implementing', '2026-09-26T00:10:00.000Z'], ['pr-open', '2026-09-26T00:20:00.000Z'], ['review', '2026-09-26T00:30:00.000Z']], { formal: '2026-09-26T00:50:00.000Z' });
  workState.recordReview({ root, id, expectedRevision: revision, actor: 'pl-endzone', idempotencyKey: 'formal-17-again', now: '2026-09-26T01:30:00.000Z', review: { kind: 'formal', headSha: H(7), artifact: 'state/reviews/endzone_issue-17/formal-002.json' } });
  assert.equal(workState.readEvents(root).filter((event) => event.recordId === id && event.type === 'review-recorded').length, 2);
  const row = build(root).rows.find((r) => r.key === 'reviewPickup');
  assert.deepEqual(row.figures.samples.filter((sample) => sample.issue === 17), [{ issue: 17, minutes: 20 }]);
});

test('#215: a week with no formal review reads n/a, not a zero', () => {
  const root = rootDir();
  const row = build(root).rows.find((r) => r.key === 'reviewPickup');
  assert.equal(row.status, 'n/a');
  assert.equal(row.figures.units, 0);
  assert.equal(row.figures.medianMinutes, null);
  assert.match(row.result, /^no formal review recorded in the week/);
});

test('#215: the markdown carries the Review pickup latency row', () => {
  const root = fixtureWeek();
  writeScorecard({ root, now: NOW, gh: ghStub().gh, collect: () => collectorReport() });
  assert.match(fs.readFileSync(path.join(root, 'state', 'metrics', 'scorecard-2026-09-21.md'), 'utf8'), /^\| Review pickup latency \| n=2 units with a formal review in the week: median 25 min/m);
});
