'use strict';
// Fleet PR C (ADR 0017, decision 7): the Arbiter's suspension scan (bin/arbiter.js). Fixture-driven:
// no network, and every page goes to a recording `send`, never to the page channel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./temp-dir');

const { arbiterScan, cli } = require('../bin/arbiter');
const workState = require('../bin/work-state');

const REAL_TENANT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tenants', 'endzone.json'), 'utf8'));
const ENDORSED_AT = '2026-10-08T09:00:00.000Z';
const WORK_AT = '2026-10-08T10:00:00.000Z';
const NOW = '2026-10-08T12:00:00.000Z';
const ID = 'endzone:issue-7';

// A temp fleet root with the tenant file; `endorse` writes an endorsement row for issue 7 (and a Work record on PR 1007).
function world({ endorse = true, kind = 'endorsed' } = {}) {
  const root = makeTempDir('fleet-arbiter-');
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'triage'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ ...REAL_TENANT, github: 'owner/repo' }));
  if (endorse) {
    fs.appendFileSync(path.join(root, 'state', 'triage', 'endzone.jsonl'), `${JSON.stringify({ schemaVersion: 1, kind, tenant: 'endzone', at: ENDORSED_AT, actor: 'arbiter', issue: 7 })}\n`);
    workState.createRecord({ root, id: ID, tenant: 'endzone', issue: 7, state: 'implementing', github: { issueNumber: 7, prNumber: 1007 }, actor: 'test', idempotencyKey: 'c-7', now: WORK_AT });
  }
  const pages = [];
  const send = (message) => { pages.push(message); return { ok: true, detail: 'pushover delivered' }; };
  const scan = (extra = {}) => arbiterScan({ root, tenant: 'endzone', issues: [], now: NOW, send, ...extra });
  return { root, pages, send, scan, flag: path.join(root, 'state', 'flags', 'arbiter-suspended-endzone') };
}

function escalate(w, reason) {
  return workState.transitionRecord({ root: w.root, id: ID, to: 'escalated', expectedRevision: 1, evidence: 'wake:decision-needed; the criteria contradict each other', ...(reason ? { reason } : {}), idempotencyKey: 'esc-7', actor: 'pl-endzone', now: '2026-10-08T11:00:00.000Z' });
}

function bug(number, body, over = {}) {
  return { number, title: `Bug ${number}`, url: `https://github.com/owner/repo/issues/${number}`, body, createdAt: '2026-10-08T11:30:00.000Z', labels: ['bug'], comments: [], ...over };
}

test('no endorsed rows: no flag, no page, and the bug query is never made', () => {
  const w = world({ endorse: false });
  const runner = () => { throw new Error('gh must not be called'); };
  const result = arbiterScan({ root: w.root, tenant: 'endzone', now: NOW, send: w.send, runner });
  assert.deepEqual(result, { tenant: 'endzone', endorsed: 0, suspended: false, wrote: false, reason: null, issue: null });
  assert.ok(!fs.existsSync(w.flag));
  assert.equal(w.pages.length, 0);
});

test('an endorsed ticket with no evidence against it suspends nothing; an escalation without the named reason is not evidence', () => {
  const w = world({ kind: 'endorsed-with-edits' });
  escalate(w);
  const result = w.scan();
  assert.equal(result.endorsed, 1);
  assert.equal(result.suspended, false);
  assert.ok(!fs.existsSync(w.flag));
  assert.equal(w.pages.length, 0);
});

test('a criteria-defect escalation on an endorsed ticket writes the flag and pages once, with reason and issue link', () => {
  const w = world();
  escalate(w, 'criteria-defect');
  const result = w.scan();
  assert.equal(result.suspended, true);
  assert.equal(result.wrote, true);
  assert.equal(result.issue, 7);
  assert.match(result.reason, /endzone:issue-7 escalated with reason criteria-defect/);
  const flag = JSON.parse(fs.readFileSync(w.flag, 'utf8'));
  assert.equal(flag.at, NOW);
  assert.equal(flag.issue, 7);
  assert.equal(flag.reason, result.reason);
  assert.equal(w.pages.length, 1);
  assert.equal(w.pages[0].priority, 'normal');
  assert.equal(w.pages[0].url, 'https://github.com/owner/repo/issues/7');
  assert.ok(w.pages[0].body.includes(result.reason));
});

test('a send-back after a finding of category criteria-defect suspends; another category does not', () => {
  for (const [category, expected] of [['criteria-defect', true], ['correctness', false]]) {
    const w = world();
    let revision = 1;
    for (const [index, to] of ['pr-open', 'ci-wait', 'review'].entries()) {
      revision = workState.transitionRecord({ root: w.root, id: ID, to, expectedRevision: revision, idempotencyKey: `s-${to}`, actor: 'pr-watch', evidence: to, now: `2026-10-08T11:0${index}:00.000Z` }).revision;
    }
    const relative = 'state/reviews/endzone_issue-7/formal-001.json';
    fs.mkdirSync(path.join(w.root, 'state', 'reviews', 'endzone_issue-7'), { recursive: true });
    fs.writeFileSync(path.join(w.root, relative), JSON.stringify({ findings: [{ id: 'f1', severity: 'major', category, status: 'open', summary: 'x' }] }));
    revision = workState.recordReview({ root: w.root, id: ID, expectedRevision: revision, actor: 'pl-endzone', idempotencyKey: 'formal-7', now: '2026-10-08T11:10:00.000Z', review: { kind: 'formal', headSha: 'a'.repeat(40), artifact: relative } }).revision;
    workState.transitionRecord({ root: w.root, id: ID, to: 'revision', expectedRevision: revision, idempotencyKey: 'back-7', actor: 'pl-endzone', evidence: 'sent back with the findings artifact', now: '2026-10-08T11:20:00.000Z' });
    const result = w.scan();
    assert.equal(result.suspended, expected, category);
    assert.equal(fs.existsSync(w.flag), expected, category);
    assert.equal(w.pages.length, expected ? 1 : 0, category);
  }
});

test('a flag that already stands is not rewritten and pages nobody: wrote false, the old reason and issue come back', () => {
  const w = world();
  escalate(w, 'criteria-defect');
  w.scan();
  const before = fs.readFileSync(w.flag, 'utf8');
  const again = w.scan({ now: '2026-10-08T13:00:00.000Z' });
  assert.equal(again.suspended, true);
  assert.equal(again.wrote, false);
  assert.equal(again.issue, 7);
  assert.match(again.reason, /criteria-defect/);
  assert.equal(fs.readFileSync(w.flag, 'utf8'), before);
  assert.equal(w.pages.length, 1, 'one page in all');
});

test('a flag Cory put there by hand is honoured and the scan asks GitHub nothing', () => {
  const w = world();
  fs.mkdirSync(path.dirname(w.flag), { recursive: true });
  fs.writeFileSync(w.flag, '');
  const runner = () => { throw new Error('gh must not be called'); };
  const result = w.scan({ issues: undefined, runner });
  assert.equal(result.suspended, true);
  assert.equal(result.wrote, false);
  assert.equal(w.pages.length, 0);
});

test('a bug that escaped from the PR that delivered an endorsed ticket writes the flag, from the form field or the proposal line', () => {
  const form = world();
  const fromForm = form.scan({ issues: [bug(31, '### Escaped from PR #\n\n1007\n\n### Other\n\nx')] });
  assert.equal(fromForm.wrote, true);
  assert.equal(fromForm.issue, 7);
  assert.match(fromForm.reason, /bug #31 escaped from PR #1007, which delivered endorsed ticket #7/);
  assert.equal(form.pages.length, 1);

  const proposal = world();
  const comment = { id: 'c1', url: 'https://github.com/owner/repo/issues/32#issuecomment-1', author: 'andydarknessb-fleet', createdAt: '2026-10-08T11:31:00.000Z', body: '## Triage proposal (advisory)\nClassification: bug\nEscaped from: #1007' };
  assert.equal(proposal.scan({ issues: [bug(32, 'No form here.', { comments: [comment] })] }).wrote, true);
});

test('a bug from some other PR, a bug older than the endorsement, or a non-bug is not evidence; a fixture file is read like a live query', () => {
  const w = world();
  const result = w.scan({ issues: [
    bug(40, '### Escaped from PR #\n\n999'),
    bug(41, '### Escaped from PR #\n\n1007', { createdAt: '2026-10-07T00:00:00.000Z' }),
    bug(42, '### Escaped from PR #\n\n1007', { labels: ['enhancement'] }),
  ] });
  assert.equal(result.suspended, false);
  const fixture = path.join(w.root, 'issues.json');
  fs.writeFileSync(fixture, JSON.stringify([bug(43, '### Escaped from PR #\n\n1007')]));
  const viaFixture = w.scan({ issues: undefined, fixture });
  assert.equal(viaFixture.wrote, true);
  assert.equal(w.pages.length, 1);
});

test('removing the flag lifts the suspension for good: the same evidence does not suspend or page again', () => {
  const w = world();
  escalate(w, 'criteria-defect');
  w.scan();
  fs.rmSync(w.flag);
  const result = w.scan({ now: '2026-10-09T09:00:00.000Z' });
  assert.equal(result.suspended, false);
  assert.ok(!fs.existsSync(w.flag));
  assert.equal(w.pages.length, 1);
});

test('a page that fails still leaves the flag standing and says so', () => {
  const w = world();
  escalate(w, 'criteria-defect');
  const result = w.scan({ send: () => ({ ok: false, detail: 'page channel unconfigured' }) });
  assert.equal(result.wrote, true);
  assert.equal(result.paged, false);
  assert.equal(result.pageDetail, 'page channel unconfigured');
  assert.ok(fs.existsSync(w.flag));
});

test('the CLI refuses a fixture run on the fleet root and an unknown command', () => {
  assert.throws(() => cli(['scan', '--tenant', 'endzone', '--fixture', 'x.json']), (error) => error.code === 'USAGE');
  assert.throws(() => cli(['nope']), (error) => error.code === 'USAGE');
});

test('a failed bug query never throws: issuesError is reported and local criteria-defect evidence still suspends', () => {
  const w = world();
  escalate(w, 'criteria-defect');
  const runner = () => { throw new Error('HTTP 502'); };
  const result = w.scan({ issues: undefined, runner });
  assert.equal(result.suspended, true);
  assert.equal(result.wrote, true);
  assert.match(result.issuesError, /GITHUB_QUERY_FAILED|HTTP 502/);
  assert.equal(w.pages.length, 1);
  const clean = world();
  const quiet = clean.scan({ issues: undefined, runner });
  assert.equal(quiet.suspended, false);
  assert.match(quiet.issuesError, /HTTP 502/);
});

test('a standing flag returns early: the injected runner is never called', () => {
  const w = world();
  escalate(w, 'criteria-defect');
  w.scan();
  let calls = 0;
  const runner = () => { calls += 1; return '{}'; };
  const again = w.scan({ issues: undefined, runner });
  assert.equal(again.suspended, true);
  assert.equal(again.wrote, false);
  assert.equal(calls, 0);
});

test('the ruled-on ids live under state/flags, and a failed ruled-file write does not stop the page', () => {
  const w = world();
  escalate(w, 'criteria-defect');
  w.scan();
  const ruled = path.join(w.root, 'state', 'flags', 'arbiter-ruled-endzone.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(ruled, 'utf8')), ['escalation:endzone:issue-7:criteria-defect']);
  assert.ok(!fs.existsSync(path.join(w.root, 'state', 'arbiter')));
  const blocked = world();
  escalate(blocked, 'criteria-defect');
  fs.mkdirSync(path.join(blocked.root, 'state', 'flags', 'arbiter-ruled-endzone.json'), { recursive: true });
  const result = blocked.scan();
  assert.equal(result.wrote, true);
  assert.equal(result.paged, true);
  assert.match(result.issuesError, /ruled-on ids not written/);
});

test('Escaped from: PR #1007 and Escaped from: 1007 both name the PR', () => {
  for (const line of ['PR #1007', '1007', '#1007']) {
    const w = world();
    const comment = { id: 'c1', url: 'https://github.com/owner/repo/issues/33#issuecomment-1', author: 'andydarknessb-fleet', createdAt: '2026-10-08T11:31:00.000Z', body: `## Triage proposal (advisory)\nEscaped from: ${line}` };
    assert.equal(w.scan({ issues: [bug(33, 'x', { comments: [comment] })] }).wrote, true, line);
  }
});
