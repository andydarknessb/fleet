'use strict';
// #132: once a week one zero-finding formal review on a diff over 150 changed lines is
// picked for an independent opus second read, filed as a `second-read` fleet issue for
// Cory's session to run. Red-tell: before bin/second-read.js nothing samples them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRecord, transitionRecord, recordReview } = require('../bin/work-state');
const { previousWeek } = require('../bin/report-week');
const { fileSecondRead, selectSecondRead, renderIssueBody, cli, SECOND_READ_FLAGS, SecondReadError } = require('../bin/second-read');

const NOW = '2026-09-28T12:00:00.000Z'; // a Monday: the week read is 2026-09-21..27
const IN_WEEK = '2026-09-23T10:00:00.000Z';

function rootDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-second-read-'));
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ name: 'endzone', github: 'andydarknessb/Endzone-Empire' }));
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ secondRead: { repo: 'andydarknessb/fleet', label: 'second-read', minChangedLines: 150 } }));
  return root;
}

// A unit reviewed once, formally, at `at`, on PR `pr`; `artifact` is what the review wrote.
function reviewed(root, issue, pr, artifact, { at = IN_WEEK, prior = null } = {}) {
  const id = `endzone:issue-${issue}`;
  createRecord({ root, id, tenant: 'endzone', issue, state: 'implementing', idempotencyKey: `c-${issue}`, now: '2026-09-21T00:00:00.000Z' });
  transitionRecord({ root, id, expectedRevision: 1, to: 'pr-open', prNumber: pr, idempotencyKey: `t-${issue}-open`, now: '2026-09-21T00:01:00.000Z', testOnly: true });
  transitionRecord({ root, id, expectedRevision: 2, to: 'review', idempotencyKey: `t-${issue}-review`, now: '2026-09-21T00:02:00.000Z', testOnly: true });
  const relative = `state/reviews/endzone_issue-${issue}/formal-001.json`;
  fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), JSON.stringify({ schemaVersion: 1, recordId: id, kind: 'formal', headSha: `${issue}`.padEnd(40, 'a'), reviewer: 'pl-endzone', at, priorArtifact: prior, findings: [], noFindings: null, ...artifact }));
  recordReview({ root, id, expectedRevision: 3, actor: 'pl-endzone', idempotencyKey: `r-${issue}`, now: at, review: { kind: 'formal', headSha: `${issue}`.padEnd(40, 'a'), artifact: relative, priorArtifact: prior } });
  return relative;
}

function ghStub(sizes) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      const size = sizes[Number(args[2])];
      if (!size) throw new Error(`no PR ${args[2]}`);
      return JSON.stringify(size);
    }
    if (args[0] === 'label' && args[1] === 'create') return '';
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/andydarknessb/fleet/issues/500\n';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls, created: () => calls.filter((a) => a[0] === 'issue' && a[1] === 'create') };
}

const clean = (text = 'Read the whole diff; nothing wrong.') => ({ noFindings: text });
const size = (additions, deletions = 0) => ({ additions, deletions, changedFiles: 3 });

function threeQualifying(root) {
  reviewed(root, 1, 101, clean());
  reviewed(root, 2, 102, clean('Checked the routes and the tests; clean.'));
  reviewed(root, 3, 103, clean());
  reviewed(root, 4, 104, { findings: [{ id: 'f1', severity: 'major', category: 'correctness', summary: 'x' }] });
  reviewed(root, 5, 105, clean());
  return { 101: size(150, 50), 102: size(700, 200), 103: size(300, 100), 104: size(5000), 105: size(100, 50) };
}

test('#132: the reporting week is the previous Monday to Sunday in UTC', () => {
  assert.deepEqual(previousWeek(NOW), { start: '2026-09-21T00:00:00.000Z', end: '2026-09-28T00:00:00.000Z', monday: '2026-09-21', sunday: '2026-09-27', label: '2026-09-21..2026-09-27' });
  assert.equal(previousWeek('2026-09-27T23:59:00.000Z').label, '2026-09-14..2026-09-20', 'a Sunday still reads the week before');
});

test('#132: a week with three qualifying reviews files one issue for the largest diff', () => {
  const root = rootDir();
  const { gh, calls, created } = ghStub(threeQualifying(root));
  const result = fileSecondRead({ root, now: NOW, gh });
  assert.equal(result.outcome, 'filed');
  assert.equal(result.pick.pr, 102);
  assert.equal(result.pick.changedLines, 900);
  assert.deepEqual(result.candidates.map((c) => c.pr), [102, 103, 101], 'over 150 changed lines, largest first; 104 had findings, 105 is 150 exactly');
  assert.equal(created().length, 1);
  assert.ok(calls.some((a) => a[0] === 'label' && a[1] === 'create' && a[2] === 'second-read' && a.includes('--force')), 'the label is created if missing');
  const create = created()[0];
  assert.deepEqual(create.slice(0, 4), ['issue', 'create', '-R', 'andydarknessb/fleet']);
  assert.equal(create[create.indexOf('--label') + 1], 'second-read');
  assert.equal(result.issue.url, 'https://github.com/andydarknessb/fleet/issues/500');
  const ledger = fs.readFileSync(path.join(root, 'state', 'second-read', 'picks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].week, '2026-09-21..2026-09-27');
  assert.equal(ledger[0].artifact, 'state/reviews/endzone_issue-2/formal-001.json');
});

test('#132: a second run in the same week files nothing new', () => {
  const root = rootDir();
  const sizes = threeQualifying(root);
  fileSecondRead({ root, now: NOW, gh: ghStub(sizes).gh });
  const again = ghStub(sizes);
  const result = fileSecondRead({ root, now: '2026-09-30T08:00:00.000Z', gh: again.gh });
  assert.equal(result.outcome, 'already-picked');
  assert.equal(result.pick.pr, 102);
  assert.equal(again.calls.length, 0, 'no GitHub call at all');
});

test('#132: a week with no qualifying review files nothing and says so', () => {
  const root = rootDir();
  reviewed(root, 5, 105, clean());
  reviewed(root, 6, 106, clean(), { at: '2026-09-15T00:00:00.000Z' });
  reviewed(root, 7, 107, clean('Re-review of the fix range; clean.'), { prior: 'state/reviews/endzone_issue-7/formal-000.json' });
  const { gh, created } = ghStub({ 105: size(20), 106: size(5000), 107: size(5000) });
  const result = fileSecondRead({ root, now: NOW, gh });
  assert.equal(result.outcome, 'no-candidate');
  assert.match(result.message, /no zero-finding formal review on a diff over 150 changed lines in 2026-09-21\.\.2026-09-27/);
  assert.equal(created().length, 0);
  assert.equal(fs.existsSync(path.join(root, 'state', 'second-read', 'picks.jsonl')), false);
});

test('#132: a review already picked is never picked again; the next largest is', () => {
  const root = rootDir();
  const sizes = threeQualifying(root);
  fs.mkdirSync(path.join(root, 'state', 'second-read'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'second-read', 'picks.jsonl'), `${JSON.stringify({ week: 'earlier', artifact: 'state/reviews/endzone_issue-2/formal-001.json' })}\n`);
  const selection = selectSecondRead({ root, now: NOW, gh: ghStub(sizes).gh });
  assert.equal(selection.pick.pr, 103);
});

test('#132: the issue body names the PR, diff size, first reviewer, artifact and the qa-reviewer command', () => {
  const root = rootDir();
  const { gh } = ghStub(threeQualifying(root));
  const { pick, week } = selectSecondRead({ root, now: NOW, gh });
  const body = renderIssueBody(pick, week);
  assert.match(body, /https:\/\/github\.com\/andydarknessb\/Endzone-Empire\/pull\/102/);
  assert.match(body, /900 changed lines \(700 additions, 200 deletions, 3 files\)/);
  assert.match(body, /First reviewer: pl-endzone/);
  assert.match(body, /state\/reviews\/endzone_issue-2\/formal-001\.json/);
  assert.match(body, /Checked the routes and the tests; clean\./);
  assert.match(body, /subagent_type: "qa-reviewer"/);
  assert.match(body, /model: "opus"/);
  assert.match(body, /Agree|findings with severities/);
});

test('#132: a PR whose size GitHub cannot return is skipped and reported, not fatal', () => {
  const root = rootDir();
  const sizes = threeQualifying(root);
  delete sizes[102];
  const selection = selectSecondRead({ root, now: NOW, gh: ghStub(sizes).gh });
  assert.equal(selection.pick.pr, 103);
  assert.deepEqual(selection.errors.map((e) => e.pr), [102]);
});

test('#132: --dry-run picks but files and records nothing', () => {
  const root = rootDir();
  const stub = ghStub(threeQualifying(root));
  const result = fileSecondRead({ root, now: NOW, gh: stub.gh, dryRun: true });
  assert.equal(result.outcome, 'would-file');
  assert.equal(result.pick.pr, 102);
  assert.equal(stub.created().length, 0);
  assert.equal(fs.existsSync(path.join(root, 'state', 'second-read', 'picks.jsonl')), false);
});

test('#132: cli refuses an unknown flag', () => {
  assert.throws(() => cli(['--dryrun']), (error) => {
    assert.ok(error instanceof SecondReadError);
    assert.equal(error.code, 'USAGE');
    for (const flag of SECOND_READ_FLAGS) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});
