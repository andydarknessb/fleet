'use strict';
// #218 (spec #195): once a week the top three finding categories in the previous
// week's formal reviews are written as one dated notice on the IC board, which session
// start already injects. Red-tell: before bin/review-categories.js nothing reads the
// recorded categories back to the IC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./temp-dir');
const test = require('node:test');
const { createRecord, transitionRecord, recordReview } = require('../bin/work-state');
const { writeReviewCategoryNotice, topCategories, cli, REVIEW_CATEGORY_FLAGS, ReviewCategoriesError } = require('../bin/review-categories');

const NOW = '2026-09-28T12:00:00.000Z'; // a Monday: the week read is 2026-09-21..27
const IN_WEEK = '2026-09-23T10:00:00.000Z';

function rootDir() {
  const root = makeTempDir('fleet-review-categories-');
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  return root;
}

let counter = 0;
const finding = (category, extra = {}) => { counter += 1; return { id: `f${counter}`, severity: 'minor', category, summary: 'x', status: 'open', ...extra }; };

// A unit reviewed once at `at`; `kind` is the review kind the artifact and event record.
function reviewed(root, issue, findings, { at = IN_WEEK, kind = 'formal', prior = null } = {}) {
  const id = `endzone:issue-${issue}`;
  createRecord({ root, id, tenant: 'endzone', issue, state: 'implementing', idempotencyKey: `c-${issue}`, now: '2026-09-21T00:00:00.000Z' });
  transitionRecord({ root, id, expectedRevision: 1, to: 'pr-open', prNumber: 100 + issue, idempotencyKey: `t-${issue}-open`, now: '2026-09-21T00:01:00.000Z', testOnly: true });
  // A risk review is recorded pre-PR-ready (pr-open); a formal one lands in review.
  if (kind === 'formal') transitionRecord({ root, id, expectedRevision: 2, to: 'review', idempotencyKey: `t-${issue}-review`, now: '2026-09-21T00:02:00.000Z', testOnly: true });
  const relative = `state/reviews/endzone_issue-${issue}/${kind}-001.json`;
  fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), JSON.stringify({ schemaVersion: 1, recordId: id, kind, headSha: `${issue}`.padEnd(40, 'a'), reviewer: 'pl-endzone', at, priorArtifact: prior, findings, noFindings: findings.length ? null : 'clean' }));
  recordReview({ root, id, expectedRevision: kind === 'formal' ? 3 : 2, actor: 'pl-endzone', idempotencyKey: `r-${issue}`, now: at, review: { kind, headSha: `${issue}`.padEnd(40, 'a'), artifact: relative, priorArtifact: prior } });
  return relative;
}

const board = (root) => path.join(root, 'state', 'notices', 'ic.md');
const boardText = (root) => fs.readFileSync(board(root), 'utf8');

function weekOfFindings(root) {
  reviewed(root, 1, [finding('correctness'), finding('correctness'), finding('test-coverage')]);
  reviewed(root, 2, [finding('correctness'), finding('docs-drift'), finding('test-coverage'), finding('naming')]);
  reviewed(root, 3, [finding('docs-drift'), finding('security')]);
}

test('#218: the top three categories of the week are written as one dated IC notice', () => {
  const root = rootDir();
  weekOfFindings(root);
  const result = writeReviewCategoryNotice({ root, now: NOW });
  assert.equal(result.outcome, 'written');
  assert.deepEqual(result.top, [
    { category: 'correctness', count: 3 },
    { category: 'docs-drift', count: 2 },
    { category: 'test-coverage', count: 2 },
  ]);
  const text = boardText(root).trim();
  assert.equal(text.split(/\n\s*\n/).length, 1, 'one paragraph, so session start filters it as one notice');
  assert.match(text, /2026-09-21\.\.2026-09-27/, 'dated with the week it read');
  assert.match(text, /correctness \(3\), docs-drift \(2\), test-coverage \(2\)/);
  assert.doesNotMatch(text, /naming|security/, 'only the top three');
  assert.match(text, /\[until 2026-10-05\]/, 'expires one week after the run');
  assert.doesNotMatch(text, /—/, 'no em-dash in notice prose');
});

test('#218: ties in count break by category name, alphabetically', () => {
  assert.deepEqual(
    topCategories([{ category: 'zeta' }, { category: 'beta' }, { category: 'alpha' }, { category: 'beta' }, { category: 'zeta' }, { category: 'gamma' }], 3),
    [{ category: 'beta', count: 2 }, { category: 'zeta', count: 2 }, { category: 'alpha', count: 1 }],
  );
  const root = rootDir();
  reviewed(root, 1, [finding('zeta'), finding('alpha'), finding('gamma'), finding('beta')]);
  const result = writeReviewCategoryNotice({ root, now: NOW });
  assert.deepEqual(result.top.map((t) => t.category), ['alpha', 'beta', 'gamma'], 'a four-way tie keeps the first three by name');
});

test('#218: only formal reviews in the previous week count, and carried findings are not counted twice', () => {
  const root = rootDir();
  reviewed(root, 1, [finding('correctness')]);
  reviewed(root, 2, [finding('risk-only'), finding('risk-only')], { kind: 'risk' });
  reviewed(root, 3, [finding('too-early'), finding('too-early')], { at: '2026-09-20T23:59:00.000Z' });
  reviewed(root, 4, [finding('too-late'), finding('too-late')], { at: '2026-09-28T00:00:00.000Z' });
  reviewed(root, 5, [finding('correctness', { carriedFrom: 'state/reviews/endzone_issue-1/formal-000.json' }), finding('naming')], { prior: 'state/reviews/endzone_issue-1/formal-000.json' });
  const result = writeReviewCategoryNotice({ root, now: NOW });
  assert.deepEqual(result.top, [{ category: 'correctness', count: 1 }, { category: 'naming', count: 1 }]);
  assert.match(boardText(root), /correctness \(1\), naming \(1\)/, 'fewer than three categories lists what there is');
  assert.equal(result.reviews, 2, 'two formal reviews were read');
});

test('#218: a rerun replaces the prior notice, keeps every other paragraph, and never stacks', () => {
  const root = rootDir();
  fs.mkdirSync(path.dirname(board(root)), { recursive: true });
  fs.writeFileSync(board(root), 'HAND-WRITTEN-IC-RULE stands.\n\nReview categories, week 2026-09-14..2026-09-20 (fleet #218): OLD-NOTICE. [until 2026-09-28]\n');
  weekOfFindings(root);
  writeReviewCategoryNotice({ root, now: NOW });
  writeReviewCategoryNotice({ root, now: '2026-09-28T13:00:00.000Z' });
  const text = boardText(root);
  assert.match(text, /HAND-WRITTEN-IC-RULE stands\./);
  assert.doesNotMatch(text, /OLD-NOTICE/);
  assert.equal((text.match(/correctness \(3\)/g) || []).length, 1, 'one notice, not two');
  assert.equal(text.trim().split(/\n\s*\n/).length, 2);
});

test('#218: the next weekly run replaces last week\'s categories with this week\'s', () => {
  const root = rootDir();
  reviewed(root, 1, [finding('correctness')], { at: '2026-09-16T10:00:00.000Z' });
  reviewed(root, 2, [finding('naming')], { at: '2026-09-23T10:00:00.000Z' });
  writeReviewCategoryNotice({ root, now: '2026-09-21T12:00:00.000Z' });
  assert.match(boardText(root), /correctness \(1\)/);
  writeReviewCategoryNotice({ root, now: NOW });
  const text = boardText(root);
  assert.match(text, /naming \(1\)/);
  assert.doesNotMatch(text, /correctness/, 'last week\'s categories are gone');
});

test('#218: a week with no findings writes no notice and clears the stale one', () => {
  const root = rootDir();
  reviewed(root, 1, [finding('correctness')], { at: '2026-09-16T10:00:00.000Z' });
  fs.mkdirSync(path.dirname(board(root)), { recursive: true });
  fs.writeFileSync(board(root), 'HAND-WRITTEN-IC-RULE stands.\n');
  writeReviewCategoryNotice({ root, now: '2026-09-21T12:00:00.000Z' });
  assert.match(boardText(root), /correctness \(1\)/);
  const result = writeReviewCategoryNotice({ root, now: NOW }); // nothing recorded 09-21..27
  assert.equal(result.outcome, 'no-findings');
  assert.match(result.message, /no findings in 2026-09-21\.\.2026-09-27/);
  assert.equal(boardText(root).trim(), 'HAND-WRITTEN-IC-RULE stands.');
  const fresh = rootDir();
  assert.equal(writeReviewCategoryNotice({ root: fresh, now: NOW }).outcome, 'no-findings');
  assert.equal(fs.existsSync(board(fresh)), false, 'no board is created when there is nothing to say');
});

test('#218: a finding with no readable category is skipped and an unreadable artifact is reported, neither fatal', () => {
  const root = rootDir();
  reviewed(root, 1, [finding('correctness'), { id: 'f-bad', severity: 'minor', summary: 'no category' }]);
  reviewed(root, 2, [finding('correctness')]);
  fs.rmSync(path.join(root, 'state/reviews/endzone_issue-2/formal-001.json'));
  const result = writeReviewCategoryNotice({ root, now: NOW });
  assert.deepEqual(result.top, [{ category: 'correctness', count: 1 }]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /endzone_issue-2/);
});

test('#218: --dry-run computes the notice without writing it', () => {
  const root = rootDir();
  weekOfFindings(root);
  const result = writeReviewCategoryNotice({ root, now: NOW, dryRun: true });
  assert.equal(result.outcome, 'would-write');
  assert.match(result.notice, /correctness \(3\)/);
  assert.equal(fs.existsSync(board(root)), false);
});

test('#218: the cli takes its own flags and refuses others', () => {
  assert.deepEqual(REVIEW_CATEGORY_FLAGS, ['root', 'now', 'dry-run']);
  const root = rootDir();
  weekOfFindings(root);
  assert.equal(cli(['--root', root, '--now', NOW]).outcome, 'written');
  assert.throws(() => cli(['--root', root, '--top', '5']), (error) => error instanceof ReviewCategoriesError && error.code === 'USAGE');
});

test('#218: a finding carried from an IC risk review is counted once, in the first formal review that carries it', () => {
  const root = rootDir();
  const riskSource = 'state/reviews/endzone_issue-9/risk-001.json';
  const formalSource = 'state/reviews/endzone_issue-9/formal-000.json';
  // Two formal reviews in the week carry the same risk finding (same source, same id);
  // the earlier one counts it, the later one does not.
  reviewed(root, 1, [finding('security', { id: 'risk-f1', carriedFrom: riskSource }), finding('naming')], { at: '2026-09-22T10:00:00.000Z', prior: riskSource });
  reviewed(root, 2, [finding('security', { id: 'risk-f1', carriedFrom: riskSource }), finding('naming')], { at: '2026-09-24T10:00:00.000Z', prior: riskSource });
  // A different risk finding from the same source is a different finding.
  reviewed(root, 3, [finding('security', { id: 'risk-f2', carriedFrom: riskSource })], { at: '2026-09-25T10:00:00.000Z', prior: riskSource });
  // A finding carried from an earlier formal review was counted when first found.
  reviewed(root, 4, [finding('correctness', { id: 'formal-f1', carriedFrom: formalSource })], { at: '2026-09-23T10:00:00.000Z', prior: formalSource });
  const result = writeReviewCategoryNotice({ root, now: NOW });
  assert.deepEqual(result.top, [{ category: 'naming', count: 2 }, { category: 'security', count: 2 }], 'risk-f1 once and risk-f2 once; the formal-carried finding not at all');
});

test('#218: a risk finding is counted in the first formal review by time, whatever order the events were written in', () => {
  const root = rootDir();
  const riskSource = 'state/reviews/endzone_issue-9/risk-001.json';
  reviewed(root, 1, [finding('security', { id: 'risk-f1', carriedFrom: riskSource })], { at: '2026-09-25T10:00:00.000Z', prior: riskSource });
  reviewed(root, 2, [finding('security', { id: 'risk-f1', carriedFrom: riskSource }), finding('naming')], { at: '2026-09-22T10:00:00.000Z', prior: riskSource });
  const result = writeReviewCategoryNotice({ root, now: NOW });
  assert.deepEqual(result.top, [{ category: 'naming', count: 1 }, { category: 'security', count: 1 }]);
});

test('#218: findings with no category are counted in `uncategorized`, in the result and the CLI line', () => {
  const root = rootDir();
  reviewed(root, 1, [finding('correctness'), { id: 'f-bad', severity: 'minor', summary: 'no category' }, { id: 'f-blank', severity: 'minor', category: '  ', summary: 'blank' }]);
  const result = writeReviewCategoryNotice({ root, now: NOW });
  assert.equal(result.uncategorized, 2);
  assert.deepEqual(result.top, [{ category: 'correctness', count: 1 }]);
  const cliOut = require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'review-categories.js'), '--root', root, '--now', NOW, '--dry-run'], { encoding: 'utf8' });
  assert.equal(JSON.parse(cliOut).uncategorized, 2);
  assert.equal(writeReviewCategoryNotice({ root: rootDir(), now: NOW }).uncategorized, 0);
});
