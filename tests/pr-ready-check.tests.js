'use strict';
// #119: the IC pre-ready mechanical check. About 104 of 296 send-back findings in the
// 2026-09-17 audit were mechanically checkable (stale docs naming a renamed identifier,
// closing-keyword and PR-body defects, lint). Red-tell: before #119 there is no
// bin/pr-ready-check.js, so the renamed-identifier fixture below passes unnoticed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  checkPullRequest, closingDefects, criteriaDefects, acceptanceCriteria, removedIdentifiers, cli, PrReadyCheckError,
} = require('../bin/pr-ready-check');

const BIN = path.join(__dirname, '..', 'bin', 'pr-ready-check.js');

const ISSUE = [
  '## What', 'Rename the helper.', '',
  '## Acceptance criteria',
  '- [ ] `fooBaz` replaces `fooBar` everywhere',
  '- [ ] the README names the new helper',
  '', '## Notes', '- [ ] not a criterion (outside the section)',
].join('\n');

const CLEAN_BODY = [
  'Renames the helper.', '', 'Closes #11', '',
  '| Criterion | Evidence |', '|---|---|',
  '| `fooBaz` replaces `fooBar` everywhere | src/a.js, tests green |',
  '| the README names the new helper | README.md line 3 |',
].join('\n');

function fixtureRepo({ readmeUpdated }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-pr-ready-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'fleet@example.invalid');
  git('config', 'user.name', 'fleet');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'function fooBar(x) {\n  return x + 1;\n}\nmodule.exports = { fooBar };\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Thing\n\nCall `fooBar` to add one.\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.js'), '// keeps working\nconst fooBarCount = 2;\nmodule.exports = { fooBarCount };\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base', '--no-gpg-sign');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'function fooBaz(x) {\n  return x + 1;\n}\nmodule.exports = { fooBaz };\n');
  if (readmeUpdated) fs.writeFileSync(path.join(repo, 'README.md'), '# Thing\n\nCall `fooBaz` to add one.\n');
  git('commit', '-q', '-a', '-m', 'rename', '--no-gpg-sign');
  return { root, repo, base };
}

function bodyFile(root, text) {
  const file = path.join(root, `body-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(file, text);
  return file;
}

test('#119: a diff renaming fooBar to fooBaz with a README still naming fooBar is one defect naming README.md', () => {
  const { repo, base } = fixtureRepo({ readmeUpdated: false });
  const result = checkPullRequest({ repo, base, issue: 11, bodyText: CLEAN_BODY, issueBody: ISSUE });
  assert.equal(result.ok, false);
  assert.equal(result.defects.length, 1, JSON.stringify(result.defects));
  assert.equal(result.defects[0].kind, 'stale-reference');
  assert.match(result.defects[0].detail, /^README\.md:3 still names `fooBar`/);
});

test('#119: a clean fixture has no defect', () => {
  const { repo, base } = fixtureRepo({ readmeUpdated: true });
  let asked = null;
  const gh = (args) => { asked = args; return JSON.stringify({ body: ISSUE }); };
  const result = checkPullRequest({ repo, base, issue: 11, bodyText: CLEAN_BODY, gh, tenant: { github: 'owner/Endzone' } });
  assert.deepEqual(result, { ok: true, defects: [] });
  assert.deepEqual(asked, ['issue', 'view', '11', '--json', 'body', '-R', 'owner/Endzone'], 'the criteria come from the issue, in the tenant repo');
});

test('#119: an unreadable issue is not a pass: the binary exits 3', () => {
  const { root, repo, base } = fixtureRepo({ readmeUpdated: true });
  // FLEET_GH=node reads `issue` as a script path it cannot find, so gh "fails".
  const run = spawnSync(process.execPath, [BIN, '--repo', repo, '--base', base, '--issue', '11', '--body', bodyFile(root, CLEAN_BODY)], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, FLEET_GH: process.execPath },
  });
  assert.equal(run.status, 3, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stderr).code, 'ISSUE_UNREADABLE');
});

test('#119: the binary prints one DEFECT line per defect and exits 1; unknown flags are USAGE, exit 2', () => {
  const { root, repo, base } = fixtureRepo({ readmeUpdated: false });
  const typo = spawnSync(process.execPath, [BIN, '--repo', repo, '--base', base, '--issue', '11', '--body', bodyFile(root, CLEAN_BODY), '--issues', '11'], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 2);
  assert.match(JSON.parse(typo.stderr).message, /unknown flag --issues\b/);
  const missing = spawnSync(process.execPath, [BIN, '--repo', repo, '--base', base, '--body', bodyFile(root, CLEAN_BODY)], { encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 2);
  assert.throws(() => cli(['--repo', repo, '--base', base, '--issue', '11', '--body', path.join(root, 'nope.md')]), (error) => error instanceof PrReadyCheckError && error.code === 'USAGE');
});

test('#119: removedIdentifiers sees renamed and removed declarations, not call sites or kept names', () => {
  const diff = [
    '--- a/x.js', '+++ b/x.js',
    '-function fooBar(a) {', '+function fooBaz(a) {',
    '-const oldThing = 1;',
    '-  helper(fooBar);', '+  helper(fooBaz);',
    '-class Keeper {', '+class Keeper {',
    '-function Get-FleetThing {', '+function Get-FleetThings {',
  ].join('\n');
  assert.deepEqual(removedIdentifiers(diff), ['Get-FleetThing', 'fooBar', 'oldThing']);
});

test('#119: a comment in code naming a removed identifier is a defect; the same word in code, or a longer word, is not', () => {
  const { repo, base } = fixtureRepo({ readmeUpdated: true });
  fs.writeFileSync(path.join(repo, 'src', 'c.js'), '// fooBar used to live here\nconst x = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '.'], { windowsHide: true });
  spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'c', '--no-gpg-sign'], { windowsHide: true });
  const result = checkPullRequest({ repo, base, issue: 11, bodyText: CLEAN_BODY, issueBody: ISSUE });
  assert.deepEqual(result.defects.map((d) => d.detail.split(' ')[0]), ['src/c.js:1'], 'fooBarCount in src/b.js is a different word');
});

test('#119: closing keywords: Closes #12 for issue 11 is a defect; one Closes #11 or a Refs #11 line is clean', () => {
  assert.equal(closingDefects('Closes #12', 11).length, 1);
  assert.match(closingDefects('Closes #12', 11)[0].detail, /closes #12, not #11/);
  assert.deepEqual(closingDefects('Fixes #11', 11), []);
  assert.deepEqual(closingDefects('fixes: owner/repo#11', 11, 'owner/repo'), []);
  assert.deepEqual(closingDefects('Refs #11\nLeaves the migration for Cory.', 11), []);
  assert.equal(closingDefects('Closes #11\nResolves #11', 11).length, 1);
  assert.equal(closingDefects('Closes #11 and closes #13', 11).length, 1);
  assert.match(closingDefects('Just a body.', 11)[0].detail, /no closing keyword/);
});

test('#119: the criteria table needs one row per acceptance criterion, and evidence in every row', () => {
  assert.deepEqual(acceptanceCriteria(ISSUE), ['`fooBaz` replaces `fooBar` everywhere', 'the README names the new helper']);
  assert.deepEqual(criteriaDefects(CLEAN_BODY, ISSUE, 11), []);
  const missingRow = CLEAN_BODY.split('\n').filter((line) => !line.includes('README names')).join('\n');
  const defects = criteriaDefects(missingRow, ISSUE, 11);
  assert.equal(defects.length, 1);
  assert.match(defects[0].detail, /no row for criterion 2: "the README names the new helper"/);
  const empty = CLEAN_BODY.replace('| README.md line 3 |', '|  |');
  assert.match(criteriaDefects(empty, ISSUE, 11)[0].detail, /has no evidence/);
  assert.match(criteriaDefects('Closes #11', ISSUE, 11)[0].detail, /no "\| Criterion \| Evidence \|" table/);
  const numbered = ['| Criterion | Evidence |', '|---|---|', '| 1 | a.js |', '| AC2 | README |'].join('\n');
  assert.deepEqual(criteriaDefects(numbered, ISSUE, 11), [], 'a row may name its criterion by number');
});

test('#119: the tenant lintCommand runs when set, and a nonzero exit is a defect', () => {
  const { repo, base } = fixtureRepo({ readmeUpdated: true });
  const ran = [];
  const clean = checkPullRequest({ repo, base, issue: 11, bodyText: CLEAN_BODY, issueBody: ISSUE, tenant: { lintCommand: 'npm run lint' }, lintRunner: (cmd) => { ran.push(cmd); } });
  assert.deepEqual(ran, ['npm run lint']);
  assert.equal(clean.ok, true);
  const failing = checkPullRequest({ repo, base, issue: 11, bodyText: CLEAN_BODY, issueBody: ISSUE, tenant: { lintCommand: 'npm run lint' }, lintRunner: () => { const error = new Error('x'); error.status = 1; error.stdout = 'a.js: 1 problem'; throw error; } });
  assert.equal(failing.defects.length, 1);
  assert.equal(failing.defects[0].kind, 'lint');
  assert.match(failing.defects[0].detail, /exited 1: a\.js: 1 problem/);
  const none = checkPullRequest({ repo, base, issue: 11, bodyText: CLEAN_BODY, issueBody: ISSUE, tenant: {}, lintRunner: () => { throw new Error('must not run'); } });
  assert.equal(none.ok, true);
});

// --- #119 review follow-ups -------------------------------------------------------

test('#119 review: a bare Refs line explains nothing; a closing keyword into another repo is not this issue', () => {
  assert.equal(closingDefects('Refs #11', 11).length, 1, 'a bare Refs line is a defect');
  assert.deepEqual(closingDefects('Refs #11: the migration stays with Cory', 11), []);
  assert.equal(closingDefects('Closes other/repo#11', 11, 'owner/Endzone').length, 1);
  assert.match(closingDefects('Closes other/repo#11', 11, 'owner/Endzone')[0].detail, /another repository/);
  assert.deepEqual(closingDefects('Closes owner/Endzone#11', 11, 'owner/Endzone'), []);
});

test('#119 review: a filler cell answers nothing; an issue with no checkboxes has no table to check', () => {
  const filler = ['| Criterion | Evidence |', '|---|---|', '| the | x |', '| ok | y |'].join('\n');
  assert.equal(criteriaDefects(filler, ISSUE, 11).filter((d) => /no row for criterion/.test(d.detail)).length, 2);
  assert.deepEqual(criteriaDefects('Closes #11', '## What\nProse only, no checkboxes.', 11), []);
});

test('#119 review: a removed common-word local, or a name code still uses, is not a stale reference', () => {
  const diff = ['--- a/x.js', '+++ b/x.js', '-const result = 1;', '-function keepMe() {', '+function other() {'].join('\n');
  const grep = (name) => (name === 'keepMe' ? 'src/y.js:4:  keepMe(); // keepMe is still called here\nREADME.md:2:keepMe docs' : 'README.md:9:the result is fine');
  assert.deepEqual(checkPullRequest({ repo: '.', base: 'x', issue: 11, bodyText: CLEAN_BODY, issueBody: ISSUE, diffText: diff, grep }).defects, []);
});
