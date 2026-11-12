'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./temp-dir');
const test = require('node:test');

const {
  ReviewPolicyError,
  classifyChange,
  classifyFromGit,
  matchGlob,
  recordReviewArtifact: recordAgainstRepo,
  planRereview,
  holdRecord,
  repostReviewStatus,
  attestPullRequest,
  standingException,
  postStandingStatus,
} = require('../bin/review-policy');
const workState = require('../bin/work-state');
const { spawnSync: runGit } = require('node:child_process');

// fleet#67: `record` resolves every SHA it is given against the tenant repo.
// The tests below that are about the record's other guards run against a stub
// repo in which every object exists; the fleet#67 tests at the end use a real
// one. `git` is the injected runner: (args, repoPath) -> stdout, throws on a
// non-zero exit like execFileSync does.
function recordReviewArtifact(options) {
  return recordAgainstRepo({ repoPath: 'E:/stub-repo', git: everyObjectExists, ...options });
}

// The injected git runner for a repository where every object exists, whose head changed one ordinary file: `rev-parse
// --verify <sha>^{commit}` answers the sha itself, as it does for a commit (#445: the record door checks that a head is
// its own commit), and the diff names that file, which is no Carve-out and no trigger.
function everyObjectExists(args) {
  if (args[0] === 'rev-parse') return `${args[args.length - 1].replace(/\^\{commit\}$/, '')}\n`;
  if (args[0] === 'diff') return changedFiles(['src/a.js'])(args);
  return '';
}

// The injected git runner for a head that changed these files: the name listing
// (NUL-separated, as classifyFromGit asks for it) and their diff, each adding one line.
function changedFiles(files, addedLine = 'x') {
  return (args) => {
    if (args[0] === 'rev-parse') return everyObjectExists(args);
    if (args[0] !== 'diff') return '';
    if (args.includes('--name-only')) return files.map((file) => `${file}\0`).join('');
    return files.map((file) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${addedLine}\n`).join('');
  };
}

// A runner for a real repository, throwing on a non-zero exit like execFileSync.
function gitIn(repo) {
  return (...args) => {
    const result = runGit('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
}

// A repository with a base commit of `baseFiles` and one more commit made by `change(repo)`.
function twoCommitRepo(root, baseFiles, change) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = gitIn(repo);
  git('init', '-q');
  git('config', 'user.email', 'fleet@example.invalid');
  git('config', 'user.name', 'fleet');
  for (const file of baseFiles) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), 'exports.up = 1;\n');
  }
  git('add', '.');
  git('commit', '-q', '-m', 'base', '--no-gpg-sign');
  const base = git('rev-parse', 'HEAD');
  change(repo);
  git('add', '.');
  git('commit', '-q', '-m', 'change', '--no-gpg-sign');
  return { repo, base };
}

// A real repository with one commit, for the CLI tests (the binary runs git for
// real) and the fleet#67 tests. Returns the repo path and its head SHA.
function commitIn(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => {
    const result = runGit('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'fleet@example.invalid');
  git('config', 'user.name', 'fleet');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one', '--no-gpg-sign');
  const prior = git('rev-parse', 'HEAD');
  // The formal record classifies its head against origin/<defaultBranch> (#445): the prior commit stands for it.
  git('update-ref', 'refs/remotes/origin/integration', prior);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'b');
  git('commit', '-q', '-a', '-m', 'two', '--no-gpg-sign');
  return { repo, head: git('rev-parse', 'HEAD'), prior };
}

function rootDir() {
  return makeTempDir('fleet-review-policy-');
}

// A head is recorded as a full 40-character sha (#445): a readable prefix padded out.
const sha40 = (prefix) => prefix.padEnd(40, '0');

const TENANT = {
  name: 'endzone',
  defaultBranch: 'integration',
  carveOuts: ['server/db/migrations/**', '**/knexfile*', '.github/workflows/**', '.env*', 'netlify.toml'],
  riskTriggers: {
    auth: { paths: ['server/middleware/**', 'server/services/leagueRole*'], patterns: [] },
    destructive: { paths: [], patterns: ['DROP TABLE', 'TRUNCATE', 'DELETE FROM'] },
    concurrency: { paths: [], patterns: ['FOR UPDATE'] },
    accessibility: { paths: [], patterns: ['aria-'] },
  },
};

function seedRecord(root, { state = 'review', prNumber = 77 } = {}) {
  // The tenant file a formal record classifies its head against (#445: defaultBranch is the base); a test's own tenant file stands.
  if (!fs.existsSync(path.join(root, 'tenants', 'endzone.json'))) {
    fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify(TENANT));
  }
  workState.createRecord({
    root, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, state: 'implementing',
    github: { issueNumber: 42, prNumber },
    actor: 'test', idempotencyKey: 'create-42', now: '2026-09-01T00:00:00.000Z',
  });
  const hops = {
    implementing: [], 'pr-open': ['pr-open'], 'ci-wait': ['pr-open', 'ci-wait'],
    review: ['pr-open', 'ci-wait', 'review'],
  }[state] || [];
  let revision = 1;
  let tick = 0;
  for (const to of hops) {
    tick += 1;
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `seed-${to}`,
      actor: 'test', evidence: 'seed', now: `2026-09-01T00:00:0${tick}.000Z`,
    }).revision;
  }
  return revision;
}

// --- glob semantics ---

test('glob matching covers the tenant carve-out shapes', () => {
  assert.equal(matchGlob('server/db/migrations/**', 'server/db/migrations/20260901_x.js'), true);
  assert.equal(matchGlob('server/db/migrations/**', 'server/db/migrations/sub/deep.js'), true);
  assert.equal(matchGlob('server/db/migrations/**', 'server/db/seeds/x.js'), false);
  assert.equal(matchGlob('**/knexfile*', 'server/knexfile.js'), true);
  assert.equal(matchGlob('**/knexfile*', 'knexfile.production.js'), true);
  assert.equal(matchGlob('.github/workflows/**', '.github/workflows/ci.yml'), true);
  assert.equal(matchGlob('.env*', '.env.local'), true);
  // A bare-name glob matches by basename anywhere: carve-outs over-match rather than under-match.
  assert.equal(matchGlob('.env*', 'client/.env.production'), true);
  assert.equal(matchGlob('netlify.toml', 'netlify.toml'), true);
  assert.equal(matchGlob('netlify.toml', 'docs/netlify.toml.md'), false);
  assert.equal(matchGlob('src/**/*.jsx', 'src/components/App.jsx'), true);
  assert.equal(matchGlob('src/**/*.jsx', 'src/App.jsx'), true);
  assert.equal(matchGlob('src/**/*.jsx', 'server/App.jsx'), false);
});

// --- classification tiers ---

test('a small diff with no triggers is trivial: the lead reviews, no risk reviewer', () => {
  const classification = classifyChange({
    files: ['src/components/Badge.jsx'],
    changedLines: 8,
    addedLines: ['const label = receptionFormatLabel(preset);'],
    tenant: TENANT,
  });
  assert.equal(classification.tier, 'trivial');
  assert.equal(classification.riskReview, false);
  assert.equal(classification.triggers.length, 0);
  assert.equal(classification.merge, 'lead');
  assert.equal(classification.reviewPlan.formal.owner, 'project-lead');
  assert.equal(classification.reviewPlan.risk, null);
});

test('a larger diff with no triggers is normal and still gets no risk reviewer', () => {
  const classification = classifyChange({
    files: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'],
    changedLines: 240,
    addedLines: [],
    tenant: TENANT,
  });
  assert.equal(classification.tier, 'normal');
  assert.equal(classification.riskReview, false);
  assert.equal(classification.reviewPlan.risk, null);
});

test('a carve-out path is high-risk, cory-only to merge, and books the IC-hosted sonnet risk reviewer', () => {
  const classification = classifyChange({
    files: ['server/db/migrations/20260901_add_thing.js', 'server/services/thing.js'],
    changedLines: 40,
    addedLines: [],
    tenant: TENANT,
  });
  assert.equal(classification.tier, 'high-risk');
  assert.equal(classification.riskReview, true);
  assert.equal(classification.merge, 'cory-only');
  const carveOut = classification.triggers.find((trigger) => trigger.class === 'carve-out');
  assert.ok(carveOut);
  assert.equal(carveOut.matches[0].file, 'server/db/migrations/20260901_add_thing.js');
  assert.deepEqual(classification.reviewPlan.risk, {
    host: 'ic', role: 'qa-reviewer', model: 'sonnet', readOnly: true, timing: 'pre-pr-ready',
  });
});

test('configured trigger paths and diff patterns fire; patterns look at added lines only', () => {
  const authOnly = classifyChange({
    files: ['server/middleware/requireMember.js'], changedLines: 12, addedLines: [], tenant: TENANT,
  });
  assert.deepEqual(authOnly.triggers.map((trigger) => trigger.class), ['auth']);
  assert.equal(authOnly.tier, 'high-risk');
  assert.equal(authOnly.merge, 'lead');

  const withPattern = classifyChange({
    files: ['server/services/cleanup.js'], changedLines: 12,
    addedLines: ['  await knex.raw("DELETE FROM stale_rows where 1=1");'],
    tenant: TENANT,
  });
  assert.deepEqual(withPattern.triggers.map((trigger) => trigger.class), ['destructive']);

  // The same text only removed does not fire.
  const removedOnly = classifyChange({
    files: ['server/services/cleanup.js'], changedLines: 12, addedLines: [], tenant: TENANT,
  });
  assert.equal(removedOnly.triggers.length, 0);
});

test('classification parses added lines and changed-line counts from a unified diff', () => {
  const diffText = [
    'diff --git a/server/services/cleanup.js b/server/services/cleanup.js',
    '--- a/server/services/cleanup.js',
    '+++ b/server/services/cleanup.js',
    '@@ -1,4 +1,5 @@',
    ' const knex = require("./db");',
    '-const old = 1;',
    '+const fresh = 1;',
    '+await knex.raw("SELECT 1 FOR UPDATE");',
    ' module.exports = {};',
  ].join('\n');
  const classification = classifyChange({
    files: ['server/services/cleanup.js'], diffText, tenant: TENANT,
  });
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['concurrency']);
  assert.equal(classification.changedLines, 3);
});

test('#445: a classification from a diff alone takes its paths from the diff, and a diff touching a carve-out is never trivial', () => {
  const newMigration = [
    'diff --git a/server/db/migrations/20260901_add_thing.js b/server/db/migrations/20260901_add_thing.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/server/db/migrations/20260901_add_thing.js',
    '@@ -0,0 +1 @@',
    '+exports.up = () => {};',
  ].join('\n');
  const classification = classifyChange({ diffText: newMigration, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/20260901_add_thing.js']);
  assert.equal(classification.tier, 'high-risk');
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445: a move out of a carve-out folder is a carve-out, and a rename diff lists both paths', () => {
  const moved = [
    'diff --git a/server/db/migrations/x.js b/server/services/x.js',
    'similarity index 90%',
    'rename from server/db/migrations/x.js',
    'rename to server/services/x.js',
    '@@ -1 +1 @@',
    '-exports.up = 1;',
    '+exports.up = 2;',
  ].join('\n');
  const classification = classifyChange({ diffText: moved, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/x.js', 'server/services/x.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445: a non-ASCII carve-out file in git\'s quoted diff header is a carve-out, and its name is decoded', () => {
  const quoted = [
    'diff --git "a/server/db/migrations/caf\\303\\251.js" "b/server/db/migrations/caf\\303\\251.js"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/server/db/migrations/caf\\303\\251.js"',
    '@@ -0,0 +1 @@',
    '+exports.up = () => {};',
  ].join('\n');
  const classification = classifyChange({ diffText: quoted, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/café.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445: a pull request that moves a carve-out file out of its folder is a carve-out, and both paths are listed', () => {
  const { repo, base } = twoCommitRepo(rootDir(), ['server/db/migrations/20260901_a.js'], (dir) => {
    fs.mkdirSync(path.join(dir, 'server', 'services'), { recursive: true });
    fs.renameSync(path.join(dir, 'server', 'db', 'migrations', '20260901_a.js'), path.join(dir, 'server', 'services', 'a.js'));
  });
  const { classification } = classifyFromGit({ repoPath: repo, baseRef: base, tenant: TENANT });
  assert.ok(classification.files.includes('server/db/migrations/20260901_a.js'), 'the old path is listed');
  assert.ok(classification.files.includes('server/services/a.js'), 'the new path is listed');
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445: a pull request that adds a carve-out file with a non-ASCII name is a carve-out', () => {
  const { repo, base } = twoCommitRepo(rootDir(), ['README.md'], (dir) => {
    fs.mkdirSync(path.join(dir, 'server', 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'db', 'migrations', 'café.js'), 'exports.up = () => {};\n');
  });
  const { classification } = classifyFromGit({ repoPath: repo, baseRef: base, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/café.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

// --- #445 review: a diff alone, a listing, or a glob cannot fail open -----------

test('#445 review: a diff made with --no-prefix (or diff.noprefix) names its paths, so a Carve-out it touches is never trivial', () => {
  const diffText = [
    'diff --git server/db/migrations/20260901_add.js server/db/migrations/20260901_add.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ server/db/migrations/20260901_add.js',
    '@@ -0,0 +1 @@',
    '+exports.up = () => {};',
  ].join('\n');
  const classification = classifyChange({ diffText, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/20260901_add.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445 review: a diff with mnemonic prefixes (c/ and w/, diff.mnemonicPrefix) names its paths without them', () => {
  const diffText = [
    'diff --git c/server/db/migrations/x.js w/server/db/migrations/x.js',
    '--- c/server/db/migrations/x.js',
    '+++ w/server/db/migrations/x.js',
    '@@ -1 +1 @@',
    '-exports.up = 1;',
    '+exports.up = 2;',
  ].join('\n');
  const classification = classifyChange({ diffText, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/x.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445 review: a diff with only --- and +++ lines, and no diff --git header, names its paths', () => {
  const diffText = [
    '--- a/server/db/migrations/x.js',
    '+++ b/server/db/migrations/x.js',
    '@@ -0,0 +1 @@',
    '+exports.up = () => {};',
  ].join('\n');
  const classification = classifyChange({ diffText, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/x.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445 review: a combined diff --cc names its path, so a Carve-out in a merge diff is never trivial', () => {
  const diffText = [
    'diff --cc server/db/migrations/x.js',
    'index 1111111,2222222..3333333',
    '--- a/server/db/migrations/x.js',
    '+++ b/server/db/migrations/x.js',
    '@@@ -1,1 -1,1 +1,2 @@@',
    '  exports.up = 1;',
    ' +exports.up = 2;',
  ].join('\n');
  const classification = classifyChange({ diffText, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/x.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445 review: a hunk whose added content opens with ++ b/ is not a file header: a destructive line after it still trips the real file', () => {
  const diffText = [
    'diff --git a/src/p.sql b/src/p.sql',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/p.sql',
    '@@ -0,0 +1,2 @@',
    '+++ b/docs/x.md',
    '+DROP TABLE t;',
  ].join('\n');
  const classification = classifyChange({ diffText, tenant: TENANT });
  assert.deepEqual(classification.files, ['src/p.sql']);
  const destructive = classification.triggers.find((trigger) => trigger.class === 'destructive');
  assert.ok(destructive, 'the destructive pattern fires');
  assert.equal(destructive.matches[0].file, 'src/p.sql', 'attributed to the real file, not the prose path');
});

test('#445 review: a prose file renamed to a code file that holds DROP TABLE trips the destructive trigger: the diff is made without renames', () => {
  const root = rootDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  const git = gitIn(repo);
  git('init', '-q');
  git('config', 'user.email', 'fleet@example.invalid');
  git('config', 'user.name', 'fleet');
  fs.writeFileSync(path.join(repo, 'docs', 'notes.md'), 'DROP TABLE is what this page warns about\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base', '--no-gpg-sign');
  const base = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.renameSync(path.join(repo, 'docs', 'notes.md'), path.join(repo, 'src', 'p.js'));
  git('add', '.');
  git('commit', '-q', '-m', 'move', '--no-gpg-sign');
  const { classification } = classifyFromGit({ repoPath: repo, baseRef: base, tenant: TENANT });
  assert.ok(classification.files.includes('src/p.js'));
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['destructive']);
});

test('#445 review: a file marked -diff in .gitattributes still has its added lines read: the diff is made as text', () => {
  const root = rootDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = gitIn(repo);
  git('init', '-q');
  git('config', 'user.email', 'fleet@example.invalid');
  git('config', 'user.name', 'fleet');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.dat -diff\n');
  fs.writeFileSync(path.join(repo, 'src', 'keep.dat'), 'kept\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base', '--no-gpg-sign');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src', 'y.dat'), 'DROP TABLE t;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'change', '--no-gpg-sign');
  const { classification } = classifyFromGit({ repoPath: repo, baseRef: base, tenant: TENANT });
  const destructive = classification.triggers.find((trigger) => trigger.class === 'destructive');
  assert.ok(destructive, 'the destructive pattern fires on a -diff file');
  assert.equal(destructive.matches[0].file, 'src/y.dat');
});

test('#445 review: a head equal to its base changes nothing: classifyFromGit classifies no files and no trigger, and does not refuse it', () => {
  const { repo, head } = commitIn(rootDir());
  const { classification } = classifyFromGit({ repoPath: repo, baseRef: head, tenant: TENANT });
  assert.deepEqual(classification.files, []);
  assert.deepEqual(classification.triggers, []);
  assert.equal(classification.tier, 'trivial');
});

test('#445 review: a --files entry in git\'s quoted form is unquoted before it is matched', () => {
  const classification = classifyChange({ files: ['"server/db/migrations/caf\\303\\251.js"'], tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/café.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445 review: a quoted diff name that holds raw non-ASCII (core.quotePath=false) is decoded as UTF-8, not byte by byte', () => {
  const diffText = [
    'diff --git "a/server/db/migrations/café.js" "b/server/db/migrations/café.js"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/server/db/migrations/café.js"',
    '@@ -0,0 +1 @@',
    '+exports.up = () => {};',
  ].join('\n');
  const classification = classifyChange({ diffText, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/café.js']);
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445 review: Carve-out and risk-trigger paths match case-insensitively: Server/DB/Migrations and .GitHub/Workflows are Carve-outs', () => {
  const classification = classifyChange({ files: ['Server/DB/Migrations/a.js', '.GitHub/Workflows/x.yml'], tenant: TENANT });
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
  assert.deepEqual(classification.triggers[0].matches.map((match) => match.file), ['Server/DB/Migrations/a.js', '.GitHub/Workflows/x.yml']);
});

test('#445 review: a diff text with a UTF-8 byte-order mark still names its paths', () => {
  const diffText = '﻿diff --git a/server/db/migrations/x.js b/server/db/migrations/x.js\nnew file mode 100644\n--- /dev/null\n+++ b/server/db/migrations/x.js\n@@ -0,0 +1 @@\n+x\n';
  const classification = classifyChange({ diffText, tenant: TENANT });
  assert.deepEqual(classification.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445 review: a diff that names no path is refused USAGE, never classified trivial', () => {
  for (const diffText of ['', 'this is not a diff\n', 'Binary-looking nothing\n']) {
    assert.throws(() => classifyChange({ diffText, tenant: TENANT }), (error) => error.code === 'USAGE' && /names no file path/.test(error.message));
  }
});

// The CLI reads a --diff file: a BOM, UTF-16 as PowerShell's `>` writes it, an empty file and a garbage file.
function diffFileRun(root, bytes) {
  const file = path.join(root, `diff-${Math.random().toString(16).slice(2)}.diff`);
  fs.writeFileSync(file, bytes);
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'review-policy.js'), 'classify', '--root', root, '--tenant', 'endzone', '--diff', file], { encoding: 'utf8', windowsHide: true });
}

const MIGRATION_DIFF = 'diff --git a/server/db/migrations/x.js b/server/db/migrations/x.js\nnew file mode 100644\n--- /dev/null\n+++ b/server/db/migrations/x.js\n@@ -0,0 +1 @@\n+x\n';

test('#445 review: classify reads a --diff file written with a UTF-8 byte-order mark', () => {
  const run = diffFileRun(classifyRoot(), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MIGRATION_DIFF, 'utf8')]));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).riskReview, true);
});

test('#445 review: classify reads a --diff file in UTF-16LE with its byte-order mark, as PowerShell redirection writes it', () => {
  const run = diffFileRun(classifyRoot(), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(MIGRATION_DIFF, 'utf16le')]));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).riskReview, true);
});

test('#445 review: classify refuses an empty --diff file with USAGE, exit 2, and no answer on stdout', () => {
  const run = diffFileRun(classifyRoot(), '');
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(JSON.parse(run.stderr).code, 'USAGE');
});

test('#445 review: classify refuses a garbage --diff file with USAGE, exit 2, and no answer on stdout', () => {
  const run = diffFileRun(classifyRoot(), 'not a diff at all\n');
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(JSON.parse(run.stderr).code, 'USAGE');
});

test('#445 review: a header and its --- and +++ lines name one file once: the prefixes come off, nothing is added', () => {
  const diffText = [
    'diff --git a/server/db/migrations/x.js b/server/db/migrations/x.js',
    '--- a/server/db/migrations/x.js',
    '+++ b/server/db/migrations/x.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');
  const classification = classifyChange({ diffText, tenant: TENANT });
  assert.deepEqual(classification.files, ['server/db/migrations/x.js']);
});

// --- exactly one formal review ---

test('a normal PR records exactly one formal review; a second attempt at the same head is refused', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'major', category: 'correctness' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  assert.ok(fs.existsSync(path.join(root, first.artifact)));
  const stored = JSON.parse(fs.readFileSync(path.join(root, first.artifact), 'utf8'));
  assert.equal(stored.kind, 'formal');
  assert.equal(stored.findings[0].id, 'formal-001-f1');
  assert.equal(stored.findings[0].status, 'open');
  assert.equal(first.result.record.review.formal.artifact, first.artifact);

  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'formal-dup', now: '2026-09-01T02:01:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'ALREADY_REVIEWED',
  );
});

// --- risk review only on a trigger ---

test('a normal PR never gets a risk review recorded; a triggered one gets exactly one', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'risk', headSha: sha40('bbb2222'), actor: 'ic-42',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'risk-none', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => error.code === 'RISK_REVIEW_NOT_TRIGGERED',
  );
  const triggered = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: sha40('bbb2222'), actor: 'ic-42',
    classification: { tier: 'high-risk', triggers: [{ class: 'carve-out', matches: [{ file: 'server/db/migrations/x.js', glob: 'server/db/migrations/**' }] }] },
    findings: [{ file: 'server/db/migrations/x.js', line: 1, claim: 'missing down()', severity: 'blocker', category: 'correctness' }],
    idempotencyKey: 'risk-1', now: '2026-09-01T02:01:00.000Z',
  });
  assert.equal(triggered.result.record.review.risk.artifact, triggered.artifact);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: triggered.result.revision,
      kind: 'risk', headSha: sha40('bbb2222'), actor: 'ic-42',
      classification: { tier: 'high-risk', triggers: [{ class: 'carve-out', matches: [] }] }, findings: [],
      idempotencyKey: 'risk-dup', now: '2026-09-01T02:02:00.000Z',
    }),
    (error) => error.code === 'ALREADY_REVIEWED',
  );
});

// --- revision re-review ---

test('a revision re-review links the prior findings and carries only unresolved or new material', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [
      { file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'major', category: 'correctness' },
      { file: 'src/b.js', line: 9, claim: 'dead branch', severity: 'nit', category: 'style' },
    ],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  revision = first.result.revision;

  // The IC revised: record moves revision -> pr-open -> ci-wait -> review again.
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `again-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-01T02:1${index}:00.000Z`,
    }).revision;
  }

  const plan = planRereview({ root, recordId: 'endzone:issue-42', headSha: sha40('ccc3333') });
  assert.equal(plan.priorArtifact, first.artifact);
  assert.equal(plan.priorHeadSha, sha40('aaa1111'));
  assert.equal(plan.range, `${sha40('aaa1111')}..${sha40('ccc3333')}`);
  assert.deepEqual(plan.unresolved.map((finding) => finding.id), ['formal-001-f1', 'formal-001-f2']);

  // A second formal at a new head without linking the prior artifact is refused.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('ccc3333'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'formal-2-bad', now: '2026-09-01T02:20:00.000Z',
    }),
    (error) => error.code === 'REREVIEW_REQUIRES_PRIOR',
  );

  // Resolutions must cover every open prior finding.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('ccc3333'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
      idempotencyKey: 'formal-2-partial', now: '2026-09-01T02:21:00.000Z',
    }),
    (error) => error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED',
  );

  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('ccc3333'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/c.js', line: 1, claim: 'new regression', severity: 'blocker', category: 'correctness' }],
    priorArtifact: first.artifact,
    resolutions: { 'formal-001-f1': 'resolved', 'formal-001-f2': 'still-open' },
    idempotencyKey: 'formal-2', now: '2026-09-01T02:22:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.priorArtifact, first.artifact);
  assert.equal(stored.range, `${sha40('aaa1111')}..${sha40('ccc3333')}`);
  const ids = stored.findings.map((finding) => finding.id).sort();
  // Only the still-open carry-over and the newly introduced finding; the resolved one is settled material.
  assert.deepEqual(ids, ['formal-001-f2', 'formal-002-f1']);
  const carried = stored.findings.find((finding) => finding.id === 'formal-001-f2');
  assert.equal(carried.carriedFrom, first.artifact);
  assert.equal(carried.status, 'open');
});

// --- hold pages once ---

test('a clean carve-out reaches hold, pages exactly once, and cannot merge without an observed GitHub merge', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const launches = [];
  const held = holdRecord({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    reason: 'carve-out PR #77 reviewed clean; waits for Cory', actor: 'project-lead',
    idempotencyKey: 'hold-1', now: '2026-09-01T03:00:00.000Z', notifier: (launch) => launches.push(launch),
  });
  assert.equal(held.result.record.state, 'hold');
  assert.equal(held.paged, true);
  assert.deepEqual(launches, [{ root, recordId: 'endzone:issue-42', sequence: held.result.eventSequence }], 'the hold launches the ticket-07 notifier for its decision event');
  const outbox = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  const lines = fs.readFileSync(outbox, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).wake, 'decision-needed');

  // Page once: a replay does not append a second wake line.
  const replay = holdRecord({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    reason: 'carve-out PR #77 reviewed clean; waits for Cory', actor: 'project-lead',
    idempotencyKey: 'hold-1', now: '2026-09-01T03:01:00.000Z', notifier: (launch) => launches.push(launch),
  });
  assert.equal(replay.paged, false);
  assert.equal(launches.length, 1, 'a replay launches no second notifier');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1);

  // No automated or lead path to merged: the transition demands a reconciled GitHub MERGED observation.
  assert.throws(
    () => workState.transitionRecord({
      root, id: 'endzone:issue-42', to: 'merged', expectedRevision: held.result.revision,
      idempotencyKey: 'merge-attempt', actor: 'project-lead', evidence: 'lead tried to merge',
    }),
    (error) => error.code === 'MISSING_GITHUB_RECONCILIATION',
  );
});

test('hold requires a PR on the record: an issue-only record cannot be parked', () => {
  const root = rootDir();
  workState.createRecord({
    root, id: 'endzone:issue-9', tenant: 'endzone', issue: 9, state: 'implementing',
    actor: 'test', idempotencyKey: 'create-9', now: '2026-09-01T00:00:00.000Z',
  });
  assert.throws(
    () => holdRecord({
      root, recordId: 'endzone:issue-9', expectedRevision: 1,
      reason: 'no PR yet', actor: 'project-lead', idempotencyKey: 'hold-9',
    }),
    (error) => error.code === 'INVALID_TRANSITION' || error.code === 'MISSING_PR_EVIDENCE',
  );
});

// --- review-round hardening (same-day adversarial QA + spec review) ---

test('pattern triggers never fire from excluded prose files; per-file diff attribution holds', () => {
  const docsOnly = [
    'diff --git a/docs/guide.md b/docs/guide.md',
    '--- a/docs/guide.md',
    '+++ b/docs/guide.md',
    '@@ -1,1 +1,2 @@',
    ' # Guide',
    '+Use aria-label on icon buttons.',
  ].join('\n');
  const none = classifyChange({ files: ['docs/guide.md'], diffText: docsOnly, tenant: TENANT });
  assert.equal(none.triggers.length, 0);

  // The same risky text added in an excluded file does not fire once attributed.
  const mixed = [
    'diff --git a/docs/guide.md b/docs/guide.md',
    '+++ b/docs/guide.md',
    '@@ -1,1 +1,2 @@',
    '+DELETE FROM notes about cleanup.',
    'diff --git a/src/Icon.jsx b/src/Icon.jsx',
    '+++ b/src/Icon.jsx',
    '@@ -1,1 +1,2 @@',
    '+export const x = 1;',
  ].join('\n');
  const attributed = classifyChange({ files: ['docs/guide.md', 'src/Icon.jsx'], diffText: mixed, tenant: TENANT });
  assert.equal(attributed.triggers.length, 0, 'destructive text in an excluded file does not fire');
  const inCode = classifyChange({
    files: ['src/cleanup.js'],
    diffText: ['diff --git a/src/cleanup.js b/src/cleanup.js', '+++ b/src/cleanup.js', '@@ -1,1 +1,2 @@', '+await knex.raw("DELETE FROM stale");'].join('\n'),
    tenant: TENANT,
  });
  assert.deepEqual(inCode.triggers.map((trigger) => trigger.class), ['destructive']);
});

test('caller-supplied finding fields cannot smuggle a non-open status, and duplicate ids are refused', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const recorded = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'sneaky', severity: 'nit', category: 'style', status: 'resolved' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8'));
  assert.equal(stored.findings[0].status, 'open');

  const root2 = rootDir();
  const revision2 = seedRecord(root2);
  assert.throws(
    () => recordReviewArtifact({
      root: root2, recordId: 'endzone:issue-42', expectedRevision: revision2,
      kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] },
      findings: [
        { id: 'formal-001-f1', file: 'a', claim: 'x', severity: 'nit', category: 'style' },
        { id: 'formal-001-f1', file: 'b', claim: 'y', severity: 'nit', category: 'style' },
      ],
      idempotencyKey: 'formal-dup-id', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => error.code === 'DUPLICATE_FINDING_ID',
  );
});

test('a retried record call replays instead of raising ALREADY_REVIEWED, and leaves one artifact', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const args = {
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }],
    now: '2026-09-01T02:00:00.000Z',
  };
  const first = recordReviewArtifact(args);
  const retry = recordReviewArtifact(args);
  assert.equal(retry.result.replayed, true);
  assert.equal(retry.artifact, first.artifact);
  const directory = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.readdirSync(directory).length, 1);
});

test('a routine concurrent observation does not destroy a review: record retries past a bumped revision', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  // pr-watch observes the PR between the reviewer reading the record and recording.
  workState.observeRecord({
    root, id: 'endzone:issue-42', expectedRevision: revision, idempotencyKey: 'obs-1',
    actor: 'pr-watch', observation: { digest: 'd1' }, now: '2026-09-01T02:00:00.000Z',
  });
  const recorded = recordReviewArtifact({
    root, recordId: 'endzone:issue-42',
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:01:00.000Z',
  });
  assert.equal(recorded.result.replayed, false);
  assert.ok(fs.existsSync(path.join(root, recorded.artifact)));
});

test('a missing prior artifact degrades to an honest re-review instead of wedging the record', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  revision = first.result.revision;
  fs.rmSync(path.join(root, first.artifact));
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `again-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-01T02:1${index}:00.000Z`,
    }).revision;
  }
  const plan = planRereview({ root, recordId: 'endzone:issue-42', headSha: sha40('ccc3333') });
  assert.equal(plan.priorArtifactMissing, true);
  assert.deepEqual(plan.unresolved, []);
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('ccc3333'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [], noFindings: 'prior artifact gone; nothing new at ccc3333', priorArtifact: first.artifact,
    idempotencyKey: 'formal-2', now: '2026-09-01T02:20:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.priorArtifactMissing, true);
});

test('a crash between the hold transition and the page is repaired by the retry', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  // Simulate the crash: the transition committed (same key holdRecord would use)
  // but the process died before the outbox append. Since fleet#56 the transition
  // door writes the line itself, so the crash window is inside that call: the
  // committed transition with its line removed is the state a retry finds.
  workState.transitionRecord({
    root, id: 'endzone:issue-42', to: 'hold', expectedRevision: revision,
    idempotencyKey: 'hold-1', actor: 'project-lead',
    evidence: 'wake:decision-needed; carve-out PR #77 waits for Cory', now: '2026-09-01T03:00:00.000Z',
  });
  const outbox = path.join(root, 'state', 'watch', 'wake-outbox.jsonl');
  assert.equal(fs.existsSync(outbox), true, 'the door wrote the line');
  fs.rmSync(outbox);
  const retry = holdRecord({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    reason: 'carve-out PR #77 waits for Cory', actor: 'project-lead',
    idempotencyKey: 'hold-1', now: '2026-09-01T03:01:00.000Z',
  });
  assert.equal(retry.paged, true, 'the retry notices the missing page and delivers it');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1);
});

// Ticket 09: review deduplication has its own rollback flag.
test('#446: under review-dedup-off a risk review that replaces one at the same head accounts for its open findings', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const classification = { tier: 'high-risk', triggers: [{ class: 'concurrency', matches: [{ pattern: 'FOR UPDATE', file: 'server/x.js', line: 'FOR UPDATE' }] }] };
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: sha40('ddd4444'), actor: 'ic-42', classification,
    findings: [{ file: 'server/x.js', claim: 'lock order', severity: 'blocker', category: 'correctness' }], now: '2026-09-10T19:00:00.000Z',
  });
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'review-dedup-off'), 'x');
  const replace = (extra) => recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
    kind: 'risk', headSha: sha40('ddd4444'), actor: 'ic-42', classification, now: '2026-09-10T19:01:00.000Z', ...extra,
  });
  assert.throws(
    () => replace({ findings: [], noFindings: 'fixed', idempotencyKey: 'risk-replace-1' }),
    (error) => error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED' && error.message.includes('risk-001-f1'),
  );
  assert.equal(fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')).length, 1, 'the refused replacement keeps no copy');

  // Still open, carried into the replacement with the new minor finding.
  const carried = replace({
    findings: [{ file: 'server/x.js', claim: 'still racy', severity: 'minor', category: 'correctness' }],
    resolutions: { 'risk-001-f1': 'still-open' }, idempotencyKey: 'risk-replace-2',
  });
  const carriedStored = JSON.parse(fs.readFileSync(path.join(root, carried.artifact), 'utf8'));
  assert.equal(carriedStored.priorArtifact, first.artifact);
  assert.equal(carriedStored.findings.find((finding) => finding.id === 'risk-001-f1').carriedFrom, first.artifact);

  const settled = replace({
    findings: [], noFindings: 'both fixed', resolutions: { 'risk-001-f1': 'resolved', 'risk-002-f1': 'resolved' },
    expectedRevision: carried.result.revision, idempotencyKey: 'risk-replace-3',
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, settled.artifact), 'utf8')).priorArtifact, carried.artifact);
});

test('#446 review: under review-dedup-off a risk record with --prior-artifact still accounts for the open blocker it replaces', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const classification = { tier: 'high-risk', triggers: [{ class: 'concurrency', matches: [{ pattern: 'FOR UPDATE', file: 'server/x.js', line: 'FOR UPDATE' }] }] };
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: sha40('ddd4444'), actor: 'ic-42', classification,
    findings: [{ file: 'server/x.js', claim: 'lock order', severity: 'blocker', category: 'correctness' }], now: '2026-09-10T19:00:00.000Z',
  });
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'review-dedup-off'), 'x');
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'risk', headSha: sha40('ddd4444'), actor: 'ic-42', classification,
      findings: [], noFindings: 'fixed', priorArtifact: 'anything', idempotencyKey: 'risk-linked-replace', now: '2026-09-10T19:01:00.000Z',
    }),
    (error) => error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED' && error.message.includes('risk-001-f1'),
  );
  assert.deepEqual(fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')), ['risk-001.json'], 'the refused replacement keeps no copy');
});

test('state/flags/review-dedup-off records a second formal review at the same head instead of refusing it', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('bbb2222'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [], noFindings: 'nothing at bbb2222',
    idempotencyKey: 'formal-a', now: '2026-09-09T02:00:00.000Z',
  });
  fs.mkdirSync(path.join(root, 'state', 'flags'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'flags', 'review-dedup-off'), 'x');
  // No explicit key and no prior link: exactly what a legacy second pass looks like.
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
    kind: 'formal', headSha: sha40('bbb2222'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [], noFindings: 'nothing at bbb2222, second pass',
    now: '2026-09-09T02:01:00.000Z',
  });
  assert.equal(second.result.replayed, false, 'the flag must beat the default replay key');
  assert.notEqual(second.artifact, first.artifact, 'the duplicate is written, not refused');
  fs.rmSync(path.join(root, 'state', 'flags', 'review-dedup-off'));
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: second.result.revision,
      kind: 'formal', headSha: sha40('bbb2222'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'formal-c', now: '2026-09-09T02:02:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'ALREADY_REVIEWED',
    'the flag removed, deduplication is back (an unlinked same-head pass; a linked one is a re-review, fleet#19)',
  );
});

// --- fleet#2: classify fails closed ---------------------------------------
// classify answers "does this diff need a risk reviewer?", so it is dangerous
// in exactly one direction: a wrong "no". Before fleet#2 a typo'd flag name
// (`--repo-path`, `--tenant-config`: assignment.js's names for the same two
// concepts) fell into a bucket nothing read, and classify answered
// riskReview:false over an empty diff, exit 0, byte-identical to the answer for
// no arguments at all. The interface is the test surface here: every case goes
// through `cli`, the same door the IC and the lead use.
//
// Red-tell: revert `classifyCli` to the old `if (args.repo && args.base)`
// fall-through and the typo cases below go green on riskReview:false instead of
// throwing; revert the schema in `parseArgs` and only the unknown-flag cases
// fail. Each guard has a case that only it turns.

const { cli, CLASSIFY_FLAGS } = require('../bin/review-policy');
const { execFileSync, spawnSync } = require('node:child_process');

function classifyRoot() {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify(TENANT));
  fs.writeFileSync(path.join(root, 'tenants', 'blank.json'), JSON.stringify({ name: 'blank' }));
  return root;
}

function refuses(argv, code, fragment) {
  assert.throws(() => cli(argv), (error) => {
    assert.ok(error instanceof ReviewPolicyError, `expected ReviewPolicyError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.code, code);
    if (fragment) assert.match(error.message, fragment);
    return true;
  });
}

test('classify: --tenant-config (assignment.js name) is refused as an unknown flag, not read as no tenant', () => {
  const root = classifyRoot();
  refuses(['classify', '--root', root, '--tenant-config', 'tenants/endzone.json', '--files', '["server/middleware/auth.js"]'], 'USAGE', /unknown flag --tenant-config/);
});

test('classify: --repo-path (assignment.js name) is refused as an unknown flag, never classified as an empty diff', () => {
  const root = classifyRoot();
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--repo-path', '/e/repo', '--base', 'abc', '--head', 'def'], 'USAGE', /unknown flag --repo-path; accepted: .*--repo\b/);
});

test('classify: the unknown-flag refusal names the accepted set', () => {
  const root = classifyRoot();
  assert.throws(() => cli(['classify', '--root', root, '--tenant', 'endzone', '--nope', 'x', '--files', '["a.js"]']), (error) => {
    for (const flag of CLASSIFY_FLAGS) assert.match(error.message, new RegExp(`--${flag}\\b`));
    return true;
  });
});

test('classify: no arguments at all is a usage error, not an answer', () => {
  refuses(['classify'], 'USAGE', /--tenant <name> is required/);
});

test('classify: a tenant with no source of files is a usage error, never an empty diff', () => {
  const root = classifyRoot();
  refuses(['classify', '--root', root, '--tenant', 'endzone'], 'USAGE', /nothing to classify/);
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--files', '[]'], 'USAGE', /non-empty JSON array/);
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--repo', '/e/repo'], 'USAGE', /--repo needs --base/);
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--base', 'abc'], 'USAGE', /--base needs --repo/);
  refuses(['classify', '--root', root, '--tenant', 'endzone', '--diff', path.join(root, 'missing.diff')], 'USAGE', /--diff file not found/);
});

test('classify: a tenant that declares neither carve-outs nor risk triggers is refused', () => {
  const root = classifyRoot();
  refuses(['classify', '--root', root, '--tenant', 'blank', '--files', '["server/middleware/auth.js"]'], 'EMPTY_TENANT', /could only ever answer riskReview:false/);
});

test('classify: a correct invocation still answers, with the files it classified', () => {
  const root = classifyRoot();
  const answer = cli(['classify', '--root', root, '--tenant', 'endzone', '--files', '["server/middleware/auth.js"]']);
  assert.equal(answer.riskReview, true);
  assert.deepEqual(answer.files, ['server/middleware/auth.js']);
  const docs = cli(['classify', '--root', root, '--tenant', 'endzone', '--files', '["docs/guide.md"]']);
  assert.equal(docs.riskReview, false);
  assert.deepEqual(docs.files, ['docs/guide.md']);
});

test('classify: the process exits 2 on a refusal and writes the refusal to stderr, no JSON answer on stdout', () => {
  const root = classifyRoot();
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const typo = spawnSync(process.execPath, [bin, 'classify', '--root', root, '--repo-path', '/e/repo', '--base', 'a', '--head', 'b', '--tenant-config', 'tenants/endzone.json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 2);
  assert.equal(typo.stdout, '');
  assert.equal(JSON.parse(typo.stderr).code, 'USAGE');
  const bare = spawnSync(process.execPath, [bin, 'classify'], { encoding: 'utf8', windowsHide: true });
  assert.equal(bare.status, 2);
  assert.equal(bare.stdout, '');
  const ok = execFileSync(process.execPath, [bin, 'classify', '--root', root, '--tenant', 'endzone', '--files', '["docs/guide.md"]'], { encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(ok).riskReview, false);
});

test('parseArgs: without a schema every flag is still accepted (the other binaries are unchanged)', () => {
  const args = workState.parseArgs(['--repo-path', '/x', '--flag', '--', 'rest']);
  assert.equal(args['repo-path'], '/x');
  assert.equal(args.flag, 'true');
  assert.deepEqual(args._, ['rest']);
});

test('parseArgs: with a schema an unknown flag is a USAGE error carrying the flag and the accepted set', () => {
  assert.throws(() => workState.parseArgs(['--repo-path', '/x'], ['repo', 'base']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.equal(error.flag, 'repo-path');
    assert.deepEqual(error.accepted, ['repo', 'base']);
    return true;
  });
  const args = workState.parseArgs(['--repo', '/x', '--', '--repo-path'], { flags: ['repo'] });
  assert.equal(args.repo, '/x');
  assert.deepEqual(args._, ['--repo-path'], 'tokens after -- are never flags, schema or not');
});

// --- fleet#20: a formal review cannot be recorded in ci-wait, and the refusal is unmistakable ---
// The lead role file says a PR whose gates are still running is not yet
// reviewable; two leads read the diff anyway, hit INVALID_REVIEW_STATE from
// the work-state door, and parked their findings in a PR comment and a temp
// file. The door stays closed (ADR 0009, ruling 1): the refusal now names the
// state that opens it, leaves no artifact behind, and exits 2 as a refused
// invocation rather than 1 as a failed one.

test('record --kind formal in ci-wait is refused with the door named, and leaves no artifact behind', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'ci-wait' });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] },
      findings: [{ file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'major', category: 'correctness' }],
      idempotencyKey: 'formal-early', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => {
      assert.ok(error instanceof ReviewPolicyError, `expected ReviewPolicyError, got ${error && error.name}`);
      assert.equal(error.code, 'INVALID_REVIEW_STATE');
      assert.equal(error.state, 'ci-wait');
      assert.match(error.message, /cannot be recorded while ci-wait/);
      assert.match(error.message, /checks-settled/);
      assert.match(error.message, /`review`/);
      return true;
    },
  );
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'a refused review leaves no artifact');
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).review?.formal, undefined);
});

test('record: INVALID_REVIEW_STATE exits 2 with the refusal on stderr and nothing on stdout', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'ci-wait' });
  const { repo, head } = commitIn(root);
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const early = spawnSync(process.execPath, [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--actor', 'project-lead', '--classification', '{"tier":"normal","triggers":[]}',
    '--findings', '[{"file":"src/a.js","line":3,"claim":"off-by-one","severity":"major","category":"correctness"}]',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(early.status, 2);
  assert.equal(early.stdout, '');
  const refusal = JSON.parse(early.stderr);
  assert.equal(refusal.code, 'INVALID_REVIEW_STATE');
  assert.match(refusal.message, /checks-settled/);
});

// --- fleet#18: an artifact is never silent about its own result -------------
// `record --kind risk` accepted `findings: []` on endzone PR #1168 at the one
// moment it could still be corrected; the artifact then read as a clean review
// to anyone who opened it, indistinguishable from "the file lost its content".
// A reviewer who found nothing is a real outcome, so the refusal is
// satisfiable without lying: `--no-findings "<one sentence>"` writes the
// statement into the artifact. What is no longer possible is an artifact that
// says nothing (ADR 0009, ruling 2). The guard sits last, at the write, so the
// earlier refusals (ALREADY_REVIEWED, RISK_REVIEW_NOT_TRIGGERED,
// REREVIEW_REQUIRES_PRIOR, UNRESOLVED_FINDINGS_UNACCOUNTED) keep their cases.

const RISK = { tier: 'high-risk', triggers: [{ class: 'accessibility', matches: [{ pattern: 'aria-', file: 'src/a.jsx', line: 'aria-label' }] }] };
// A formal record's head whose diff trips the accessibility trigger (#445: the record classifies its head itself).
const ACCESSIBILITY_HEAD = changedFiles(['src/a.jsx'], 'aria-label');

test('record --kind risk with an empty findings array is refused, leaves no artifact, and touches no state', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'risk', headSha: sha40('ce19d6a'), actor: 'ic-42', classification: RISK, findings: [],
      idempotencyKey: 'risk-empty', now: '2026-09-10T18:56:28.000Z',
    }),
    (error) => {
      assert.ok(error instanceof ReviewPolicyError);
      assert.equal(error.code, 'EMPTY_FINDINGS');
      assert.match(error.message, /--no-findings/);
      return true;
    },
  );
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
  const record = workState.getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(record.revision, revision);
  assert.equal(record.review?.risk, undefined);
});

test('record --kind risk with an explicit no-findings statement writes the statement into the artifact', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const clean = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: sha40('ce19d6a'), actor: 'ic-42', classification: RISK, findings: [],
    noFindings: 'Examined the Badge link for focus ring, hover and cursor; ButtonBase is reached via clickable, nothing to fix.',
    idempotencyKey: 'risk-clean', now: '2026-09-10T18:56:28.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, clean.artifact), 'utf8'));
  assert.deepEqual(stored.findings, []);
  assert.match(stored.noFindings, /^Examined the Badge link/);
  assert.equal(clean.result.record.review.risk.artifact, clean.artifact);
});

test('a formal review with no findings needs the same statement; a re-review that resolves everything can say so', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      idempotencyKey: 'formal-empty', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => error.code === 'EMPTY_FINDINGS',
  );
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'major', category: 'correctness' }],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:01:00.000Z',
  });
  revision = first.result.revision;
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `again-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-01T02:1${index}:00.000Z`,
    }).revision;
  }
  // Every prior finding resolved and nothing new: the artifact still has to say so.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('ccc3333'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
      idempotencyKey: 'formal-2-empty', now: '2026-09-01T02:20:00.000Z',
    }),
    (error) => error.code === 'EMPTY_FINDINGS',
  );
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('ccc3333'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
    noFindings: `Range ${sha40('aaa1111')}..${sha40('ccc3333')} fixes the off-by-one; nothing new in the changed lines.`,
    idempotencyKey: 'formal-2', now: '2026-09-01T02:21:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.deepEqual(stored.findings, []);
  assert.deepEqual(stored.resolutions, { 'formal-001-f1': 'resolved' });
  assert.match(stored.noFindings, /nothing new/);
});

test('a no-findings statement cannot accompany findings, and cannot be blank or a bare flag', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const base = {
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: sha40('ce19d6a'), actor: 'ic-42', classification: RISK, now: '2026-09-10T18:56:28.000Z',
  };
  assert.throws(
    () => recordReviewArtifact({ ...base, findings: [{ file: 'src/a.jsx', claim: 'x', severity: 'nit', category: 'style' }], noFindings: 'nothing', idempotencyKey: 'k1' }),
    (error) => error.code === 'USAGE' && /1 new, 0 still open/.test(error.message),
  );
  assert.throws(() => recordReviewArtifact({ ...base, findings: [], noFindings: '   ', idempotencyKey: 'k2' }), (error) => error.code === 'USAGE');
  assert.throws(() => recordReviewArtifact({ ...base, findings: [], noFindings: 'true', idempotencyKey: 'k3' }), (error) => error.code === 'USAGE');
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
});

test('record cli: --no-findings reaches the artifact; --no-finding and --findings-file are refused as unknown flags', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const { repo, head } = commitIn(root);
  for (const [flag, value] of [['--no-finding', 'nothing'], ['--findings-file', 'f.json']]) {
    assert.throws(
      () => cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--head-sha', head, '--repo-path', repo,
        '--classification', JSON.stringify(RISK), flag, value]),
      (error) => error instanceof ReviewPolicyError && error.code === 'USAGE' && new RegExp(`unknown flag ${flag}`).test(error.message),
    );
  }
  const clean = cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--head-sha', head, '--repo-path', repo,
    '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--no-findings', 'Examined the accessibility angle; nothing to fix.']);
  const stored = JSON.parse(fs.readFileSync(path.join(root, clean.artifact), 'utf8'));
  assert.equal(stored.noFindings, 'Examined the accessibility angle; nothing to fix.');
  assert.deepEqual(stored.findings, []);
});

test('record: EMPTY_FINDINGS exits 2 with the refusal on stderr and nothing on stdout', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const { repo, head } = commitIn(root);
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const empty = spawnSync(process.execPath, [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'risk', '--head-sha', head, '--repo-path', repo, '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--findings', '[]',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(empty.status, 2);
  assert.equal(empty.stdout, '');
  assert.equal(JSON.parse(empty.stderr).code, 'EMPTY_FINDINGS');
});

test('plan-rereview and hold refuse their confusable flag names too', () => {
  const root = rootDir();
  seedRecord(root);
  assert.throws(() => cli(['plan-rereview', '--root', root, '--id', 'endzone:issue-42', '--head', sha40('ccc3333')]), (error) => error.code === 'USAGE' && /unknown flag --head/.test(error.message));
  assert.throws(() => cli(['hold', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', '4', '--why', 'carve-out']), (error) => error.code === 'USAGE' && /unknown flag --why/.test(error.message));
  assert.throws(() => cli(['unhold', '--root', root]), (error) => error.code === 'USAGE' && /unknown command/.test(error.message));
});

test('a no-findings statement is refused beside a carried-forward still-open finding; the carry itself needs no statement', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [
      { file: 'src/a.js', line: 3, claim: 'off-by-one', severity: 'major', category: 'correctness' },
      { file: 'src/b.js', line: 9, claim: 'lost focus ring', severity: 'blocker', category: 'correctness' },
    ],
    idempotencyKey: 'formal-1', now: '2026-09-01T02:00:00.000Z',
  });
  revision = first.result.revision;
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `again-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-01T02:1${index}:00.000Z`,
    }).revision;
  }
  const resolutions = { 'formal-001-f1': 'resolved', 'formal-001-f2': 'still-open' };
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('ccc3333'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: first.artifact, resolutions, noFindings: 'nothing new in the range',
      idempotencyKey: 'formal-2-lie', now: '2026-09-01T02:20:00.000Z',
    }),
    (error) => error.code === 'USAGE' && /1 still open/.test(error.message),
  );
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('ccc3333'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions,
    idempotencyKey: 'formal-2', now: '2026-09-01T02:21:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.noFindings, null);
  assert.deepEqual(stored.findings.map((finding) => finding.id), ['formal-001-f2']);
  assert.equal(stored.findings[0].carriedFrom, first.artifact);
});

test('a duplicate finding id is refused before any artifact file exists', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] },
      findings: [{ id: 'same', file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }, { id: 'same', file: 'src/b.js', claim: 'y', severity: 'nit', category: 'style' }],
      idempotencyKey: 'formal-dupid', now: '2026-09-01T02:00:00.000Z',
    }),
    (error) => error.code === 'DUPLICATE_FINDING_ID',
  );
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no 0-byte orphan artifact');
});

// --- fleet#19: a body-only revision can be re-recorded at an unchanged head ---
// The replay key was kind:record:head, so a second formal pass at the same
// head always replayed the first, exit 0, discarding the findings and the
// resolutions it was given. A PR body changes without a commit (measurement
// claims, the risk-artifact pointer, the squash commit message), so a formal
// re-review that links its prior artifact is a new review even at the same
// head (ADR 0009, ruling 3); a retry of that same re-review still replays,
// and any replay says what it did not write.

test('a linked formal re-review at an unchanged head records a new artifact, resolving the prior findings', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('f91ba70'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'PR body', claim: 'asserts a command result that is false', severity: 'blocker', category: 'correctness' }],
    now: '2026-09-10T19:00:00.000Z',
  });
  // The prior link must name the recorded artifact, and every open finding needs a resolution.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'formal', headSha: sha40('f91ba70'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: 'state/reviews/endzone_issue-42/formal-009.json', resolutions: { 'formal-001-f1': 'resolved' },
      noFindings: 'body corrected', now: '2026-09-10T19:30:00.000Z',
    }),
    (error) => error.code === 'REREVIEW_REQUIRES_PRIOR',
  );
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'formal', headSha: sha40('f91ba70'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [],
      priorArtifact: first.artifact, noFindings: 'body corrected', now: '2026-09-10T19:30:00.000Z',
    }),
    (error) => error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED',
  );
  const plan = planRereview({ root, recordId: 'endzone:issue-42', headSha: sha40('f91ba70') });
  assert.equal(plan.range, `${sha40('f91ba70')}..${sha40('f91ba70')}`);
  assert.deepEqual(plan.unresolved.map((finding) => finding.id), ['formal-001-f1']);

  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
    kind: 'formal', headSha: sha40('f91ba70'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
    noFindings: 'PR body now states the measured result; nothing else changed at f91ba70.',
    now: '2026-09-10T19:31:00.000Z',
  });
  assert.equal(second.result.replayed, false, 'a linked re-review at the same head is a new review, not a replay');
  assert.notEqual(second.artifact, first.artifact);
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.priorArtifact, first.artifact);
  assert.equal(stored.range, `${sha40('f91ba70')}..${sha40('f91ba70')}`);
  assert.equal(stored.sameHead, true);
  assert.deepEqual(stored.resolutions, { 'formal-001-f1': 'resolved' });
  assert.deepEqual(stored.findings, []);
  assert.equal(second.result.record.review.formal.artifact, second.artifact);
  assert.deepEqual(planRereview({ root, recordId: 'endzone:issue-42', headSha: sha40('f91ba70') }).unresolved, []);

  // A linked third pass at the same head has nothing open to resolve: it is not a re-review.
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: second.result.revision,
      kind: 'formal', headSha: sha40('f91ba70'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [], noFindings: 'still clean',
      priorArtifact: second.artifact, idempotencyKey: 'formal-3-linked', now: '2026-09-10T19:32:30.000Z',
    }),
    (error) => error.code === 'ALREADY_REVIEWED' && /nothing open to resolve/.test(error.message),
  );
  assert.equal(fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')).length, 2, 'no same-head pileup');

  // A retry of the same re-review replays it; an unlinked third pass is still refused.
  const retry = recordReviewArtifact({
    root, recordId: 'endzone:issue-42',
    kind: 'formal', headSha: sha40('f91ba70'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' },
    noFindings: 'PR body now states the measured result; nothing else changed at f91ba70.',
    now: '2026-09-10T19:32:00.000Z',
  });
  assert.equal(retry.result.replayed, true);
  assert.equal(retry.artifact, second.artifact);
  assert.equal(fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')).length, 2);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: second.result.revision,
      kind: 'formal', headSha: sha40('f91ba70'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [], noFindings: 'again',
      idempotencyKey: 'formal-3-unlinked', now: '2026-09-10T19:33:00.000Z',
    }),
    (error) => error.code === 'ALREADY_REVIEWED',
  );
});

test('a risk review at the same head is still exactly one review: the link is a formal-only door', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const classification = { tier: 'high-risk', triggers: [{ class: 'concurrency', matches: [{ pattern: 'FOR UPDATE', file: 'server/x.js', line: 'FOR UPDATE' }] }] };
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: sha40('ddd4444'), actor: 'ic-42', classification,
    findings: [{ file: 'server/x.js', claim: 'lock order', severity: 'major', category: 'correctness' }], now: '2026-09-10T19:00:00.000Z',
  });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: first.result.revision,
      kind: 'risk', headSha: sha40('ddd4444'), actor: 'ic-42', classification,
      findings: [], noFindings: 'fixed', priorArtifact: first.artifact, resolutions: { 'risk-001-f1': 'resolved' },
      idempotencyKey: 'risk-2-linked', now: '2026-09-10T19:01:00.000Z',
    }),
    (error) => error.code === 'ALREADY_REVIEWED',
  );
});

test('a replay says what it did not write: the result names the ignored findings and resolutions', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const args = {
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }],
    now: '2026-09-01T02:00:00.000Z',
  };
  const first = recordReviewArtifact(args);
  assert.equal(first.ignored, undefined);
  const retry = recordReviewArtifact({
    ...args,
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }, { file: 'src/b.js', claim: 'y', severity: 'nit', category: 'style' }],
    resolutions: { 'formal-001-f1': 'resolved' },
  });
  assert.equal(retry.result.replayed, true);
  assert.deepEqual(retry.ignored, { findings: 2, resolutions: 1 });
  assert.equal(retry.artifact, first.artifact);
});

test('record cli: a replay exits 0 with the JSON answer on stdout and the not-written warning on stderr', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const { repo, head } = commitIn(root);
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const argv = [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--actor', 'project-lead', '--classification', '{"tier":"normal","triggers":[]}',
    '--findings', '[{"file":"src/a.js","claim":"x","severity":"nit","category":"style"}]',
  ];
  const first = spawnSync(process.execPath, argv, { encoding: 'utf8', windowsHide: true });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const retry = spawnSync(process.execPath, argv, { encoding: 'utf8', windowsHide: true });
  assert.equal(retry.status, 0, retry.stderr);
  const answer = JSON.parse(retry.stdout);
  assert.equal(answer.result.replayed, true);
  assert.deepEqual(answer.ignored, { findings: 1, resolutions: 0 });
  assert.match(retry.stderr, /NOT written/);
  assert.match(retry.stderr, /--prior-artifact/);
});

// --- fleet#46: reviewer provenance defaults to the session's own name -------
// `record` wrote `reviewer: "unknown"` whenever --actor was omitted, and the
// documented invocation omitted it, so one record's chain carried both
// spellings. FLEET_NAME is in every fleet session's environment and is the
// name the field wants.

function withFleetName(value, body) {
  const saved = process.env.FLEET_NAME;
  if (value === undefined) delete process.env.FLEET_NAME; else process.env.FLEET_NAME = value;
  try { return body(); } finally {
    if (saved === undefined) delete process.env.FLEET_NAME; else process.env.FLEET_NAME = saved;
  }
}

test('fleet#46: record and hold take the reviewer from FLEET_NAME when --actor is omitted; --actor still wins', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const { repo, head } = commitIn(root);
  withFleetName('pl-endzone', () => {
    const recorded = cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
      '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--classification', '{"tier":"normal","triggers":[]}', '--findings', '[{"file":"src/a.js","claim":"x","severity":"nit","category":"style"}]']);
    const stored = JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8'));
    assert.equal(stored.reviewer, 'pl-endzone');
    assert.equal(recorded.result.record.review.formal.actor, 'pl-endzone');

    const held = cli(['hold', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(recorded.result.revision),
      '--reason', 'carve-out waits for Cory', '--no-notifier']);
    const holdEvent = workState.readEvents(root).find((event) => event.recordId === 'endzone:issue-42' && event.type === 'state-hold');
    assert.equal(held.result.record.state, 'hold');
    assert.equal(holdEvent.actor, 'pl-endzone');
  });

  const root2 = rootDir();
  const revision2 = seedRecord(root2);
  const { repo: repo2, head: head2 } = commitIn(root2);
  withFleetName('pl-endzone', () => {
    const explicit = cli(['record', '--root', root2, '--id', 'endzone:issue-42', '--expected-revision', String(revision2),
      '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--actor', 'cory', '--classification', '{"tier":"normal","triggers":[]}', '--findings', '[{"file":"src/a.js","claim":"x","severity":"nit","category":"style"}]']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root2, explicit.artifact), 'utf8')).reviewer, 'cory');
  });
});

test('fleet#46: with neither --actor nor FLEET_NAME the reviewer is still "unknown", never blank', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const { repo, head } = commitIn(root);
  withFleetName(undefined, () => {
    const recorded = cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
      '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--classification', '{"tier":"normal","triggers":[]}', '--findings', '[{"file":"src/a.js","claim":"x","severity":"nit","category":"style"}]']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8')).reviewer, 'unknown');
  });
});

// --- fleet#43: risk artifacts are no longer write-only ----------------------
// On endzone PR #1280 the IC wrote six findings with `outcome: "fixed"` beside
// `status: "open"`; nothing read `outcome`, nothing walked the risk chain, and
// `headSha` named a head the reviewer never read. Three rulings (ADR 0009, 5):
// a supplied finding cannot carry its own resolution; the tree the reviewer
// read is `reviewedSha`, distinct from the head the artifact is recorded at;
// and the lead's formal review resolves the risk artifact's open findings.

const RISK_FINDINGS = [
  { file: 'src/a.jsx', line: 10, claim: 'focus not restored on close', severity: 'major', category: 'correctness' },
  { file: 'src/a.jsx', line: 22, claim: 'aria-expanded never flips', severity: 'major', category: 'correctness' },
  { file: 'src/b.jsx', line: 5, claim: 'icon button has no name', severity: 'blocker', category: 'correctness' },
];

test('fleet#43: a supplied finding carrying outcome (or resolution) is refused before any file exists', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  for (const field of ['outcome', 'resolution']) {
    assert.throws(
      () => recordReviewArtifact({
        root, recordId: 'endzone:issue-42', expectedRevision: revision,
        kind: 'risk', headSha: sha40('ce19d6a'), actor: 'ic-42', classification: RISK,
        findings: [{ ...RISK_FINDINGS[0], [field]: 'fixed' }, RISK_FINDINGS[1]],
        idempotencyKey: `risk-${field}`, now: '2026-09-12T10:00:00.000Z',
      }),
      (error) => error instanceof ReviewPolicyError && error.code === 'FINDING_CARRIES_OUTCOME' && error.message.includes(`\`${field}\``) && /--resolutions/.test(error.message),
    );
  }
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')));
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).review.risk, undefined);
});

test('fleet#43: FINDING_CARRIES_OUTCOME is a refused invocation: exit 2, refusal on stderr, nothing on stdout', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const { repo, head } = commitIn(root);
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const refused = spawnSync(process.execPath, [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'risk', '--head-sha', head, '--repo-path', repo, '--actor', 'ic-42', '--classification', JSON.stringify(RISK),
    '--findings', JSON.stringify([{ ...RISK_FINDINGS[0], outcome: 'fixed', status: 'open' }]),
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
  assert.equal(JSON.parse(refused.stderr).code, 'FINDING_CARRIES_OUTCOME');
});

test('fleet#43: a risk artifact records the tree the reviewer read as reviewedSha, and the uncovered delta as range', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const recorded = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha: sha40('17fa3c48'), reviewedSha: sha40('000c07b9'), actor: 'ic-42', classification: RISK,
    findings: RISK_FINDINGS, idempotencyKey: 'risk-1', now: '2026-09-12T10:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8'));
  assert.equal(stored.headSha, sha40('17fa3c48'));
  assert.equal(stored.reviewedSha, sha40('000c07b9'));
  assert.equal(stored.range, `${sha40('000c07b9')}..${sha40('17fa3c48')}`);
  assert.equal(recorded.result.record.review.risk.headSha, sha40('17fa3c48'));

  // Same tree read and recorded: reviewedSha equals headSha and range stays null.
  const root2 = rootDir();
  const revision2 = seedRecord(root2, { state: 'implementing' });
  const same = recordReviewArtifact({
    root: root2, recordId: 'endzone:issue-42', expectedRevision: revision2,
    kind: 'risk', headSha: sha40('ce19d6a'), actor: 'ic-42', classification: RISK,
    findings: RISK_FINDINGS, idempotencyKey: 'risk-1', now: '2026-09-12T10:00:00.000Z',
  });
  const storedSame = JSON.parse(fs.readFileSync(path.join(root2, same.artifact), 'utf8'));
  assert.equal(storedSame.reviewedSha, sha40('ce19d6a'));
  assert.equal(storedSame.range, null);
});

test('fleet#43: a formal review is recorded at the head it read; a differing --reviewed-sha is refused', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('aaa1111'), reviewedSha: sha40('aaa0000'), actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] },
      findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }],
      idempotencyKey: 'formal-1', now: '2026-09-12T10:00:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'REVIEWED_SHA_MISMATCH' && /re-review/.test(error.message),
  );
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')));
  const ok = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), reviewedSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }],
    idempotencyKey: 'formal-1', now: '2026-09-12T10:00:00.000Z',
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ok.artifact), 'utf8')).reviewedSha, sha40('aaa1111'));
});

function seedRiskThenReview(root, { headSha = sha40('17fa3c48'), findings = RISK_FINDINGS } = {}) {
  const revision = seedRecord(root, { state: 'implementing' });
  const risk = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'risk', headSha, reviewedSha: sha40('000c07b9'), actor: 'ic-42', classification: RISK,
    findings, idempotencyKey: 'risk-1', now: '2026-09-12T10:00:00.000Z',
  });
  let current = risk.result.revision;
  ['pr-open', 'ci-wait', 'review'].forEach((to, index) => {
    current = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: current, idempotencyKey: `seed-${to}`,
      actor: 'test', evidence: 'seed', now: `2026-09-12T10:1${index}:00.000Z`,
    }).revision;
  });
  return { risk, revision: current };
}

test('fleet#43: the first formal review walks the risk chain: every open risk finding needs a resolution', () => {
  const root = rootDir();
  const { risk, revision } = seedRiskThenReview(root);
  const riskArtifact = JSON.parse(fs.readFileSync(path.join(root, risk.artifact), 'utf8'));
  assert.deepEqual(riskArtifact.findings.map((finding) => finding.status), ['open', 'open', 'open']);

  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('17fa3c48'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
      findings: [{ file: 'src/c.js', claim: 'formal-only', severity: 'nit', category: 'style' }],
      idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED' && error.message.includes(risk.artifact) && error.unresolved.length === 3,
  );
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews', 'endzone_issue-42', 'formal-001.json')));

  const formal = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('17fa3c48'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
    findings: [{ file: 'src/c.js', claim: 'formal-only', severity: 'nit', category: 'style' }],
    resolutions: { 'risk-001-f1': 'resolved', 'risk-001-f2': 'resolved', 'risk-001-f3': 'still-open' },
    idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, formal.artifact), 'utf8'));
  assert.equal(stored.riskArtifact, risk.artifact);
  assert.equal(stored.priorArtifact, null);
  assert.deepEqual(stored.findings.map((finding) => [finding.id, finding.status, finding.carriedFrom || null]), [
    ['formal-001-f1', 'open', null],
    ['risk-001-f3', 'open', risk.artifact],
  ]);

  // The re-review scopes from the formal artifact, which now carries the still-open risk finding.
  const plan = planRereview({ root, recordId: 'endzone:issue-42', headSha: sha40('28ab0000') });
  assert.deepEqual(plan.unresolved.map((finding) => finding.id), ['formal-001-f1', 'risk-001-f3']);

  // A later formal re-review does not walk the risk artifact twice: only the formal prior binds.
  let current = formal.result.revision;
  ['revision', 'pr-open', 'ci-wait', 'review'].forEach((to, index) => {
    current = workState.transitionRecord({
      root, id: 'endzone:issue-42', to, expectedRevision: current, idempotencyKey: `cycle-${to}`,
      actor: 'test', evidence: 'revision cycle', now: `2026-09-12T12:1${index}:00.000Z`,
    }).revision;
  });
  const rereview = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: current,
    kind: 'formal', headSha: sha40('28ab0000'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
    priorArtifact: formal.artifact,
    resolutions: { 'formal-001-f1': 'resolved', 'risk-001-f3': 'resolved' },
    noFindings: 'Re-read the changed range; the icon button is now named and nothing new was found.',
    idempotencyKey: 'formal-2', now: '2026-09-12T13:00:00.000Z',
  });
  const storedRereview = JSON.parse(fs.readFileSync(path.join(root, rereview.artifact), 'utf8'));
  assert.deepEqual(storedRereview.findings, []);
  assert.equal(storedRereview.riskArtifact, null);
});

test('fleet#103: a third formal link does not re-walk a risk artifact an earlier link in the chain consumed', () => {
  const root = rootDir();
  const { revision } = seedRiskThenReview(root);
  const cycle = (from, tag, hour) => {
    let current = from;
    ['revision', 'pr-open', 'ci-wait', 'review'].forEach((to, index) => {
      current = workState.transitionRecord({
        root, id: 'endzone:issue-42', to, expectedRevision: current, idempotencyKey: `${tag}-${to}`,
        actor: 'test', evidence: 'revision cycle', now: `2026-09-12T${hour}:1${index}:00.000Z`,
      }).revision;
    });
    return current;
  };
  // formal-001 consumes risk-001 and carries risk-001-f3 still-open (deploy ordering: only the Hold resolves it).
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('17fa3c48'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
    resolutions: { 'risk-001-f1': 'resolved', 'risk-001-f2': 'resolved', 'risk-001-f3': 'still-open' },
    findings: [{ file: 'src/c.js', claim: 'formal-only', severity: 'nit', category: 'correctness' }],
    idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
  });
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: cycle(first.result.revision, 'c1', '12'),
    kind: 'formal', headSha: sha40('28ab0000'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
    priorArtifact: first.artifact,
    resolutions: { 'formal-001-f1': 'resolved', 'risk-001-f3': 'still-open' },
    idempotencyKey: 'formal-2', now: '2026-09-12T13:00:00.000Z',
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8')).riskArtifact, null);

  // The third link binds to the formal chain alone: only formal-002's open findings need resolutions.
  const third = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: cycle(second.result.revision, 'c2', '14'),
    kind: 'formal', headSha: sha40('39bc0000'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
    priorArtifact: second.artifact,
    resolutions: { 'risk-001-f3': 'still-open' },
    idempotencyKey: 'formal-3', now: '2026-09-12T15:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, third.artifact), 'utf8'));
  assert.equal(stored.riskArtifact, null);
  assert.deepEqual(stored.findings.map((finding) => [finding.id, finding.status]), [['risk-001-f3', 'open']]);
});

test('fleet#43: a formal no-findings statement beside a still-open risk finding is refused, and a resolved chain can say so', () => {
  const root = rootDir();
  const { risk, revision } = seedRiskThenReview(root, { findings: [RISK_FINDINGS[0]] });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('17fa3c48'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
      resolutions: { 'risk-001-f1': 'still-open' }, noFindings: 'Looked; nothing.',
      idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
    }),
    (error) => error.code === 'USAGE' && /0 new, 1 still open/.test(error.message) && error.message.includes(risk.artifact),
  );
  const clean = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('17fa3c48'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
    resolutions: { 'risk-001-f1': 'resolved' }, noFindings: 'Verified the focus fix at 17fa3c48; Standards and Spec angles found nothing.',
    idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, clean.artifact), 'utf8'));
  assert.deepEqual(stored.findings, []);
  assert.deepEqual(stored.resolutions, { 'risk-001-f1': 'resolved' });
  assert.equal(stored.riskArtifact, risk.artifact);
});

test('fleet#43: a risk artifact whose file is gone degrades honestly instead of wedging the formal review', () => {
  const root = rootDir();
  const { risk, revision } = seedRiskThenReview(root);
  fs.rmSync(path.join(root, risk.artifact));
  const formal = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('17fa3c48'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
    findings: [{ file: 'src/c.js', claim: 'formal-only', severity: 'nit', category: 'style' }],
    idempotencyKey: 'formal-1', now: '2026-09-12T11:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, formal.artifact), 'utf8'));
  assert.equal(stored.riskArtifact, risk.artifact);
  assert.equal(stored.riskArtifactMissing, true);
});

test('fleet#43: record cli accepts --reviewed-sha and refuses --reviewed (a typo is never a silent no-op)', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const { repo, head, prior } = commitIn(root);
  assert.throws(
    () => cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--head-sha', head, '--repo-path', repo,
      '--reviewed', prior, '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--findings', JSON.stringify(RISK_FINDINGS)]),
    (error) => error.code === 'USAGE' && /unknown flag --reviewed/.test(error.message),
  );
  const recorded = cli(['record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--head-sha', head, '--repo-path', repo,
    '--reviewed-sha', prior, '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--findings', JSON.stringify(RISK_FINDINGS)]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8')).reviewedSha, prior);
});

// --- fleet#58: trigger patterns match in the case the tenant wrote them ------
// `patternRegExp` compiled every pattern with the `i` flag, so the SQL pattern
// `TRUNCATE` fired on the English word "truncated" in a comment (endzone PR
// #1344, risk-003.json) and the IC hosted an opus risk review on a false
// trigger. Tenant patterns are written in the case of the thing they detect.
test('fleet#58: a prose word in the wrong case does not fire a risk pattern; the SQL form still does', () => {
  const prose = classifyChange({
    files: ['src/widgets/player-decision-card/ui/PlayerDecisionCard.jsx'], changedLines: 40,
    addedLines: ['// long, truncated name reports `scrollWidth > clientWidth` despite nothing', 'const rows = list.slice(0, 3); // delete from the list, for update later'],
    tenant: TENANT,
  });
  assert.deepEqual(prose.triggers, [], 'prose in a comment is not a destructive or concurrency operation');
  const sql = classifyChange({
    files: ['server/services/cleanup.js'], changedLines: 12,
    addedLines: ['  await knex.raw("TRUNCATE stale_rows");', '  await trx("leagues").forUpdate(); // FOR UPDATE'],
    tenant: TENANT,
  });
  assert.deepEqual(sql.triggers.map((trigger) => trigger.class), ['destructive', 'concurrency']);
  // An unparseable pattern still falls back to a literal match, in the tenant's case.
  const literal = classifyChange({
    files: ['src/a.js'], changedLines: 3, addedLines: ['x = a[1'],
    tenant: { riskTriggers: { odd: { paths: [], patterns: ['a[1'] } } },
  });
  assert.deepEqual(literal.triggers.map((trigger) => trigger.class), ['odd']);
  const literalCase = classifyChange({
    files: ['src/a.js'], changedLines: 3, addedLines: ['x = A[1'],
    tenant: { riskTriggers: { odd: { paths: [], patterns: ['a[1'] } } },
  });
  assert.deepEqual(literalCase.triggers, []);
});

// --- fleet#64: a triggered head needs its risk review before the formal ---

test('fleet#64: a formal review at a triggered head with no risk artifact is refused, writes nothing, and touches no state', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
      noFindings: 'clean at both angles', idempotencyKey: 'formal-1', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'RISK_REVIEW_MISSING'
      && error.message.includes('accessibility') && error.message.includes('no risk artifact is recorded') && error.message.includes('--risk-ruling'),
  );
  const record = workState.getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(record.revision, revision);
  assert.equal(record.review.formal, undefined);
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no artifact was written');
});

test('fleet#64: a first formal review at a new head does not lean on a risk artifact recorded at an earlier head', () => {
  const root = rootDir();
  const { risk, revision } = seedRiskThenReview(root, { findings: [{ file: 'src/a.jsx', claim: 'aria', severity: 'nit', category: 'style' }] });
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'formal', headSha: sha40('bbb2222'), actor: 'project-lead', git: ACCESSIBILITY_HEAD,
      noFindings: 'clean', idempotencyKey: 'formal-1', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'RISK_REVIEW_MISSING'
      && error.message.includes(risk.artifact) && error.message.includes(sha40('17fa3c48')) && error.riskHeadSha === sha40('17fa3c48'),
  );
});

test('#445 review: a --prior-artifact that names no prior formal review of the record is refused, and the migration at the new head still needs its risk review', () => {
  const root = rootDir();
  const { revision } = seedRiskThenReview(root, { findings: [{ file: 'src/a.jsx', claim: 'aria', severity: 'nit', category: 'style' }] });
  const migration = changedFiles(['server/db/migrations/20260901_x.js']);
  const base = { root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('bbb2222'), actor: 'project-lead', git: migration, noFindings: 'clean' };
  assert.throws(
    () => recordReviewArtifact({ ...base, idempotencyKey: 'formal-no-link', now: '2026-09-14T18:00:00.000Z' }),
    (error) => error.code === 'RISK_REVIEW_MISSING',
  );
  assert.throws(
    () => recordReviewArtifact({ ...base, priorArtifact: 'state/reviews/nope.json', idempotencyKey: 'formal-link', now: '2026-09-14T18:00:00.000Z' }),
    (error) => error.code === 'USAGE' && /names no prior formal review/.test(error.message),
  );
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).review.formal, undefined, 'no formal review was recorded');
});

test('fleet#64: --risk-ruling records the lead ruling in the artifact in place of the missing risk review', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const ruling = 'destructive pattern is cleanup on a throwaway CI test database; no live table is touched';
  const formal = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead', git: ACCESSIBILITY_HEAD, riskRuling: ruling,
    noFindings: 'clean at both angles', idempotencyKey: 'formal-1', now: '2026-09-14T18:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, formal.artifact), 'utf8'));
  assert.equal(stored.riskRuling, ruling);
  assert.equal(stored.tier, 'high-risk');
  assert.equal(stored.riskArtifact, null);
  // A normal head carries no ruling field at all.
  const root2 = rootDir();
  const revision2 = seedRecord(root2);
  const plain = recordReviewArtifact({
    root: root2, recordId: 'endzone:issue-42', expectedRevision: revision2,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead', classification: { tier: 'normal', triggers: [] },
    noFindings: 'clean', idempotencyKey: 'formal-1', now: '2026-09-14T18:00:00.000Z',
  });
  assert.ok(!('riskRuling' in JSON.parse(fs.readFileSync(path.join(root2, plain.artifact), 'utf8'))));
});

test('fleet#64: a risk review never takes a ruling: the IC hosts it, the lead rules', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision,
      kind: 'risk', headSha: sha40('aaa1111'), actor: 'ic-42', classification: RISK, riskRuling: 'no',
      noFindings: 'clean', idempotencyKey: 'risk-1', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error instanceof ReviewPolicyError && error.code === 'USAGE',
  );
});

test('fleet#64: record --kind formal exits 2 on RISK_REVIEW_MISSING, and --risk-ruling opens the door', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const { repo } = commitIn(root);
  // The head adds a carve-out file: the formal record classifies the head itself, with no --classification (#445).
  fs.mkdirSync(path.join(repo, 'server', 'db', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'server', 'db', 'migrations', '20260901_x.js'), 'exports.up = () => {};\n');
  const git = gitIn(repo);
  git('add', '.');
  git('commit', '-q', '-m', 'carve-out', '--no-gpg-sign');
  const head = git('rev-parse', 'HEAD');
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const base = [bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--actor', 'project-lead', '--no-findings', 'clean'];
  const refused = spawnSync(process.execPath, base, { encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(refused.stdout, '');
  assert.equal(JSON.parse(refused.stderr).code, 'RISK_REVIEW_MISSING');
  const ruled = spawnSync(process.execPath, [...base, '--risk-ruling', 'cleanup on a throwaway CI database'], { encoding: 'utf8', windowsHide: true });
  assert.equal(ruled.status, 0, ruled.stderr);
  const record = workState.getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(record.review.formal.headSha, head);
  const stored = JSON.parse(fs.readFileSync(path.join(root, record.review.formal.artifact), 'utf8'));
  assert.equal(stored.riskRuling, 'cleanup on a throwaway CI database');
  assert.deepEqual(stored.triggers.map((trigger) => trigger.class), ['carve-out']);
});

test('#445: a formal record computes the classification at its own head: a clean one passed in cannot hide a carve-out', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const findings = [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }];
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('aaa1111'),
      actor: 'project-lead', git: changedFiles(['server/db/migrations/20260901_x.js']),
      classification: { tier: 'normal', triggers: [] }, findings, idempotencyKey: 'formal-other-head', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error.code === 'RISK_REVIEW_MISSING' && error.triggers === 'carve-out',
  );
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).revision, revision);
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews')), 'no artifact was written');

  // A triggered classification passed in is ignored when the head itself is clean.
  const clean = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('aaa1111'),
    actor: 'project-lead', git: changedFiles(['src/a.js']),
    classification: { tier: 'high-risk', triggers: [{ class: 'carve-out', matches: [] }] }, findings,
    idempotencyKey: 'formal-clean-head', now: '2026-09-14T18:00:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, clean.artifact), 'utf8'));
  assert.deepEqual(stored.triggers, []);
  assert.notEqual(stored.tier, 'high-risk');

  // A tenant that names no defaultBranch has no base to classify the head against: refused, nothing written.
  const root2 = rootDir();
  const revision2 = seedRecord(root2);
  assert.throws(
    () => recordReviewArtifact({
      root: root2, recordId: 'endzone:issue-42', expectedRevision: revision2, kind: 'formal', headSha: sha40('aaa1111'),
      actor: 'project-lead', tenant: { ...TENANT, defaultBranch: undefined }, findings, idempotencyKey: 'formal-no-base',
      now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error.code === 'TENANT_BASE_UNKNOWN',
  );
  assert.ok(!fs.existsSync(path.join(root2, 'state', 'reviews')), 'no artifact was written');
});

// --- fleet#67: a recorded head is a commit ----------------------------------
// `record --kind risk` on endzone #1382 accepted headSha
// 0f2fb0064a7d4a0b5c1e2f3a4b5c6d7e8f9a0b1c: the branch head's real 8-character
// prefix followed by a padded pattern. Nothing had asked the tenant repo whether
// the object existed, so the risk chain, plan-rereview ranges and the merge-time
// head check all keyed off a SHA nobody could ever have read.

test('fleet#67: record refuses a headSha that is not a commit in the tenant repo, and writes nothing', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const { repo, head } = commitIn(root);
  const fake = `${head.slice(0, 8)}4a7d4a0b5c1e2f3a4b5c6d7e8f9a0b1c`;
  assert.throws(
    () => recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'risk', headSha: fake, actor: 'ic-42', classification: RISK, findings: RISK_FINDINGS }),
    (error) => error instanceof ReviewPolicyError && error.code === 'UNKNOWN_COMMIT' && error.sha === fake && error.repoPath === repo && new RegExp(fake).test(error.message),
  );
  const record = workState.getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(record.revision, revision, 'a refused record bumps nothing');
  assert.equal(Object.keys(record.idempotency).some((key) => key.includes(fake)), false, 'and keeps no idempotency key for the invented head');
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no artifact is written');

  const real = recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'risk', headSha: head, actor: 'ic-42', classification: RISK, findings: RISK_FINDINGS });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, real.artifact), 'utf8')).headSha, head);

  const otherRoot = rootDir();
  const otherRevision = seedRecord(otherRoot, { state: 'implementing' });
  // #445: an abbreviated sha that names a commit is refused too; a full sha is what the record stores.
  assert.throws(
    () => recordAgainstRepo({ root: otherRoot, recordId: 'endzone:issue-42', expectedRevision: otherRevision, repoPath: repo, kind: 'risk', headSha: head.slice(0, 12), actor: 'ic-42', classification: RISK, findings: RISK_FINDINGS }),
    (error) => error.code === 'FULL_SHA_REQUIRED',
  );
});

test('fleet#67: reviewedSha is resolved too, so a range cannot start at a tree nobody could read', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const { repo, head } = commitIn(root);
  const fake = 'e'.repeat(40);
  assert.throws(
    () => recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'risk', headSha: head, reviewedSha: fake, actor: 'ic-42', classification: RISK, findings: RISK_FINDINGS }),
    (error) => error.code === 'UNKNOWN_COMMIT' && error.sha === fake && /--reviewed-sha/.test(error.message),
  );
});

test('fleet#67: the check fetches the record\'s PR branch first and tolerates a fetch that fails, but not a missing object', () => {
  const root = rootDir();
  workState.createRecord({
    root, id: 'endzone:issue-42', tenant: 'endzone', issue: 42, state: 'implementing',
    github: { issueNumber: 42, prNumber: 77 }, assignment: { branch: 'fleet/42-thing', baseSha: 'b'.repeat(40) },
    actor: 'test', idempotencyKey: 'create-42', now: '2026-09-01T00:00:00.000Z',
  });
  const revision = workState.getRecord({ root, id: 'endzone:issue-42' }).revision;
  const calls = [];
  const git = (args, repoPath) => { calls.push([repoPath, ...args]); if (args[0] === 'fetch') throw new Error('offline'); return everyObjectExists(args); };
  const recorded = recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: 'E:/tenant', git, kind: 'risk', headSha: 'c'.repeat(40), actor: 'ic-42', classification: RISK, findings: RISK_FINDINGS });
  assert.ok(recorded.artifact);
  assert.deepEqual(calls[0], ['E:/tenant', 'fetch', '--quiet', 'origin', 'fleet/42-thing'], 'the PR branch is fetched so a just-pushed head resolves');
  // #445: the commit is checked by its own sha: rev-parse --verify <sha>^{commit} must answer the sha.
  assert.deepEqual(calls[1], ['E:/tenant', 'rev-parse', '--verify', `${'c'.repeat(40)}^{commit}`]);
  assert.equal(calls.length, 2, 'reviewedSha equal to headSha is resolved once');

  const missing = (args) => { if (args[0] === 'rev-parse') { const error = new Error('fatal: Not a valid object name'); error.status = 1; throw error; } return ''; };
  assert.throws(
    () => recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: recorded.result.revision, repoPath: 'E:/tenant', git: missing, kind: 'risk', headSha: 'd'.repeat(40), actor: 'ic-42', classification: RISK, findings: RISK_FINDINGS, idempotencyKey: 'second' }),
    (error) => error.code === 'UNKNOWN_COMMIT',
  );
});

test('fleet#67: the repo comes from --repo-path or the tenant file; with neither the record is refused, never skipped', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  assert.throws(
    () => recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, git: () => '', kind: 'risk', headSha: 'c'.repeat(40), actor: 'ic-42', classification: RISK, findings: RISK_FINDINGS }),
    (error) => error.code === 'TENANT_REPO_UNKNOWN' && /endzone\.json/.test(error.message),
  );
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ ...TENANT, repo: 'E:\\Tenant-Repo' }));
  const calls = [];
  const recorded = recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, git: (args, repoPath) => { calls.push(repoPath); return everyObjectExists(args); }, kind: 'risk', headSha: 'c'.repeat(40), actor: 'ic-42', classification: RISK, findings: RISK_FINDINGS });
  assert.ok(recorded.artifact);
  assert.deepEqual([...new Set(calls)], ['E:\\Tenant-Repo'], 'the tenant file\'s repo is the default');
});

test('fleet#67: the binary refuses an invented head with exit 2 and takes --repo-path; an unknown flag is still USAGE', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const { repo, head } = commitIn(root);
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const fake = `${head.slice(0, 8)}4a7d4a0b5c1e2f3a4b5c6d7e8f9a0b1c`;
  const base = [bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'risk', '--actor', 'ic-42', '--classification', JSON.stringify(RISK), '--findings', JSON.stringify(RISK_FINDINGS)];
  const invented = spawnSync(process.execPath, [...base, '--repo-path', repo, '--head-sha', fake], { encoding: 'utf8', windowsHide: true });
  assert.equal(invented.status, 2, invented.stderr);
  assert.equal(invented.stdout, '');
  assert.equal(JSON.parse(invented.stderr).code, 'UNKNOWN_COMMIT');
  const typo = spawnSync(process.execPath, [...base, '--repo', repo, '--head-sha', head], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 2);
  assert.match(JSON.parse(typo.stderr).message, /unknown flag --repo\b/);
  const bare = spawnSync(process.execPath, [...base, '--head-sha', head, '--repo-path'], { encoding: 'utf8', windowsHide: true });
  assert.equal(bare.status, 2);
  assert.match(JSON.parse(bare.stderr).message, /--repo-path needs a path/);
  const real = spawnSync(process.execPath, [...base, '--repo-path', repo, '--head-sha', head], { encoding: 'utf8', windowsHide: true });
  assert.equal(real.status, 0, real.stderr);
  assert.equal(JSON.parse(real.stdout).result.record.review.risk.headSha, head);
});

test('#445: a recorded head is a full 40-character sha: a branch name, a relative ref or a short sha is refused, and nothing is written', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const findings = [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }];
  for (const headSha of ['fleet/445-review-gate', 'HEAD', 'HEAD~1', sha40('aaa1111').slice(0, 7)]) {
    assert.throws(
      () => recordReviewArtifact({
        root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha, actor: 'project-lead',
        classification: { tier: 'normal', triggers: [] }, findings, idempotencyKey: `head-${headSha}`, now: '2026-09-14T18:00:00.000Z',
      }),
      (error) => error.code === 'FULL_SHA_REQUIRED' && /a full 40-character sha is needed/.test(error.message),
    );
  }
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'risk', headSha: sha40('aaa1111'), reviewedSha: 'HEAD~1',
      actor: 'ic-42', classification: RISK, findings, idempotencyKey: 'risk-reviewed-head', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error.code === 'FULL_SHA_REQUIRED',
  );
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).revision, revision);
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews')), 'no artifact was written');

  const recorded = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings, idempotencyKey: 'head-full', now: '2026-09-14T18:00:00.000Z',
  });
  assert.equal(recorded.result.record.review.formal.headSha, sha40('aaa1111'));
});

// --- #117: every recorded finding carries a severity from the enum and a category ---
// The audit counted 485 findings with 12+ severity spellings and 41 blank; nothing
// at the door checked either. Red-tell: with bin/review-policy.js reverted, the
// `"severity":"high"` finding below writes an artifact.

test('#445 review: a formal record at a head whose commit the tenant checkout does not hold is UNKNOWN_COMMIT, and writes nothing', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const { repo } = commitIn(root);
  const fake = 'e'.repeat(40);
  assert.throws(
    () => recordAgainstRepo({
      root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'formal', headSha: fake, actor: 'project-lead',
      findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }], idempotencyKey: 'formal-unknown', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error.code === 'UNKNOWN_COMMIT' && error.sha === fake,
  );
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).revision, revision, 'no event was written');
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews')), 'no artifact was written');
});

test('#445 review: a git failure while a formal record classifies its head writes nothing: no artifact, no event, no status', () => {
  const root = rootDir();
  reviewTenant(root);
  const revision = seedRecord(root);
  const { calls, gh } = stubGh();
  const broken = (args) => {
    if (args[0] === 'diff') throw new Error('fatal: simulated diff failure');
    return everyObjectExists(args);
  };
  assert.throws(
    () => recordAgainstRepo({
      root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: 'E:/stub-repo', git: broken, gh,
      kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
      findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }], idempotencyKey: 'formal-broken', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => /simulated diff failure/.test(error.message),
  );
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).revision, revision, 'no event was written');
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews')), 'no artifact was written');
  assert.equal(calls.length, 0, 'no status was posted');
});

test('#445 review: a formal record at a head its base already holds is not refused for that: the change is empty and nothing triggers', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const { repo, head } = commitIn(root);
  gitIn(repo)('update-ref', 'refs/remotes/origin/integration', head);
  const recorded = recordAgainstRepo({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'formal', headSha: head, actor: 'project-lead',
    findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }], idempotencyKey: 'formal-empty-change', now: '2026-09-14T18:00:00.000Z',
  });
  assert.equal(recorded.result.record.review.formal.headSha, head);
  assert.deepEqual(recorded.result.record.review.formal.triggers, []);
});

test('#445 review: the base is origin/<defaultBranch>: a fixture where another base would classify the head differently decides on the named one', () => {
  const root = rootDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = gitIn(repo);
  git('init', '-q');
  git('config', 'user.email', 'fleet@example.invalid');
  git('config', 'user.name', 'fleet');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'one', '--no-gpg-sign');
  const first = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(repo, 'server', 'db', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'server', 'db', 'migrations', '20260901_x.js'), 'exports.up = () => {};\n');
  git('add', '.');
  git('commit', '-q', '-m', 'two', '--no-gpg-sign');
  const second = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'b');
  git('commit', '-q', '-a', '-m', 'three', '--no-gpg-sign');
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/integration', first);
  git('update-ref', 'refs/remotes/origin/main', second);
  const revision = seedRecord(root);
  const findings = [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }];
  // Against integration the head adds a migration: a Carve-out, so the formal record needs its risk review.
  assert.throws(
    () => recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'formal', headSha: head, actor: 'project-lead', findings, idempotencyKey: 'formal-integration', now: '2026-09-14T18:00:00.000Z' }),
    (error) => error.code === 'RISK_REVIEW_MISSING' && error.triggers === 'carve-out',
  );
  // Against main the migration is already there: the same head classifies normal and records.
  const recorded = recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'formal', headSha: head, actor: 'project-lead', findings, tenant: { ...TENANT, defaultBranch: 'main' }, idempotencyKey: 'formal-main', now: '2026-09-14T18:00:00.000Z' });
  assert.equal(recorded.result.record.review.formal.headSha, head);
  assert.deepEqual(recorded.result.record.review.formal.triggers, []);
});

test('#445 review: a missing base ref is TENANT_BASE_MISSING, naming the ref and the repo: exit 2, and nothing is written', () => {
  const root = rootDir();
  const { repo, head } = commitIn(root);
  gitIn(repo)('update-ref', '-d', 'refs/remotes/origin/integration');
  const revision = seedRecord(root);
  const findings = [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }];
  assert.throws(
    () => recordAgainstRepo({ root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'formal', headSha: head, actor: 'project-lead', findings, idempotencyKey: 'formal-no-base', now: '2026-09-14T18:00:00.000Z' }),
    (error) => error.code === 'TENANT_BASE_MISSING' && error.base === 'origin/integration' && error.message.includes('origin/integration') && error.message.includes(repo),
  );
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).revision, revision);
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews')), 'no artifact was written');
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const run = spawnSync(process.execPath, [bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision), '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--actor', 'project-lead', '--no-findings', 'clean'], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(JSON.parse(run.stderr).code, 'TENANT_BASE_MISSING');
});

test('#445 review: an annotated tag object sha is refused FULL_SHA_REQUIRED at the record door: one commit has one accepted spelling', () => {
  const root = rootDir();
  const revision = seedRecord(root, { state: 'implementing' });
  const { repo, head } = commitIn(root);
  gitIn(repo)('tag', '-a', 'v1', '-m', 'release', head);
  const tag = gitIn(repo)('rev-parse', 'v1');
  assert.notEqual(tag, head);
  assert.throws(
    () => recordAgainstRepo({
      root, recordId: 'endzone:issue-42', expectedRevision: revision, repoPath: repo, kind: 'risk', headSha: tag, actor: 'ic-42',
      classification: RISK, findings: RISK_FINDINGS, idempotencyKey: 'risk-tag', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error.code === 'FULL_SHA_REQUIRED' && error.sha === tag && /not the commit's own sha/.test(error.message),
  );
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).revision, revision);
  assert.ok(!fs.existsSync(path.join(root, 'state', 'reviews')), 'no artifact was written');
});

test('#445 review: FULL_SHA_REQUIRED names the remedy: git rev-parse HEAD in the PR worktree, or gh pr view --json headRefOid', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: 'HEAD', actor: 'project-lead',
      classification: { tier: 'normal', triggers: [] }, findings: [{ file: 'src/a.js', claim: 'x', severity: 'nit', category: 'style' }],
      idempotencyKey: 'head-remedy', now: '2026-09-14T18:00:00.000Z',
    }),
    (error) => error.code === 'FULL_SHA_REQUIRED' && error.message.includes('git rev-parse HEAD') && error.message.includes('gh pr view') && error.message.includes('headRefOid'),
  );
});

function formalAt(root, revision, findings, extra = {}) {
  return recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('aaa1111'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings,
    idempotencyKey: `formal-${JSON.stringify(findings).length}`, now: '2026-09-24T02:00:00.000Z', ...extra,
  });
}

function assertNothingWritten(root) {
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'a refused finding leaves no artifact');
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).review?.formal, undefined, 'and no review on the record');
}

test('#117: a severity outside blocker|major|minor|nit is refused INVALID_FINDING, naming the finding and the allowed values', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  assert.throws(
    () => formalAt(root, revision, [{ file: 'a.js', claim: 'x', severity: 'high', category: 'correctness' }]),
    (error) => {
      assert.equal(error.code, 'INVALID_FINDING');
      assert.match(error.message, /#1/);
      assert.match(error.message, /'high'/);
      assert.match(error.message, /blocker, major, minor, nit/);
      return true;
    },
  );
  assertNothingWritten(root);
});

test('#117: a legacy capitalised severity and a missing severity are refused too', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  for (const severity of ['Major', 'should-fix', undefined, '']) {
    assert.throws(
      () => formalAt(root, revision, [{ id: 'mine', file: 'a.js', claim: 'x', severity, category: 'correctness' }]),
      (error) => error.code === 'INVALID_FINDING' && /mine/.test(error.message),
      `severity ${JSON.stringify(severity)}`,
    );
  }
  assertNothingWritten(root);
});

test('#117: a finding with no category, or a category that is not kebab-case, is refused', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  for (const category of [undefined, '', 'Test Coverage', 'docs_drift', '-lead']) {
    assert.throws(
      () => formalAt(root, revision, [{ file: 'a.js', claim: 'x', severity: 'minor', category }]),
      (error) => error.code === 'INVALID_FINDING' && /category/.test(error.message) && /kebab-case/.test(error.message),
      `category ${JSON.stringify(category)}`,
    );
  }
  assertNothingWritten(root);
});

test('#117: a valid finding records with its severity and category', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const recorded = formalAt(root, revision, [{ file: 'a.js', claim: 'x', severity: 'minor', category: 'test-coverage' }]);
  const stored = JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8'));
  assert.equal(stored.findings[0].severity, 'minor');
  assert.equal(stored.findings[0].category, 'test-coverage');
});

test('#117: a carried legacy "Major" finding is still carried as written', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  const first = formalAt(root, revision, [{ file: 'a.js', claim: 'x', severity: 'major', category: 'correctness' }]);
  // History predates the enum: rewrite the prior artifact's finding to a legacy spelling.
  const priorFile = path.join(root, first.artifact);
  const prior = JSON.parse(fs.readFileSync(priorFile, 'utf8'));
  prior.findings[0].severity = 'Major';
  delete prior.findings[0].category;
  fs.writeFileSync(priorFile, JSON.stringify(prior));
  revision = first.result.revision;
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({ root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `c117-${to}`, actor: 'test', evidence: 'cycle', now: `2026-09-24T02:1${index}:00.000Z` }).revision;
  }
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: sha40('bbb2222'), actor: 'project-lead',
    classification: { tier: 'normal', triggers: [] }, findings: [],
    priorArtifact: first.artifact, resolutions: { [prior.findings[0].id]: 'still-open' },
    idempotencyKey: 'formal-117-2', now: '2026-09-24T02:30:00.000Z',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.findings.length, 1);
  assert.equal(stored.findings[0].severity, 'Major', 'a carried finding keeps its legacy spelling');
  assert.equal(stored.findings[0].carriedFrom, first.artifact);
});

test('#117: the binary refuses an off-enum severity with exit 2 and writes nothing', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const { repo, head } = commitIn(root);
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const run = spawnSync(process.execPath, [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--actor', 'project-lead', '--classification', '{"tier":"normal","triggers":[]}',
    '--findings', '[{"file":"a.js","claim":"x","severity":"high"}]',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(JSON.parse(run.stderr).code, 'INVALID_FINDING');
  assertNothingWritten(root);
});

// --- #115: `record --kind formal` posts the fleet-review commit status (ADR 0014) ---
// A review lived in the lead's role file and a script "cannot block" a merge; on
// 2026-09-12 endzone #1241 and #1263 merged with none. The formal record now posts
// `fleet-review` on the reviewed head, which the tenant ruleset requires (#120).
// Red-tell: with bin/review-policy.js reverted, the stub gh records no call.

const FULL_HEAD = 'f'.repeat(40);

function reviewTenant(root, extra = {}) {
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify({ ...TENANT, github: 'owner/Endzone', reviewStatus: 'fleet-review', ...extra }));
}

function stubGh({ fail = false } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (fail) { const error = new Error('HTTP 502'); error.stderr = 'gh: HTTP 502 Bad Gateway'; throw error; }
    return '{}';
  };
  return { calls, gh };
}

function statusField(call, name) {
  const index = call.findIndex((arg, i) => call[i - 1] === '-f' && arg.startsWith(`${name}=`));
  return index === -1 ? undefined : call[index].slice(name.length + 1);
}

function formalRecord(root, revision, gh, extra = {}) {
  return recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision,
    kind: 'formal', headSha: FULL_HEAD, actor: 'pl-endzone',
    classification: { tier: 'normal', triggers: [] }, gh,
    idempotencyKey: 'formal-115', now: '2026-09-24T03:00:00.000Z', ...extra,
  });
}

test('#115: a clean formal record posts one success fleet-review status on the reviewed head', () => {
  const root = rootDir();
  reviewTenant(root);
  const revision = seedRecord(root);
  const { calls, gh } = stubGh();
  const recorded = formalRecord(root, revision, gh, { noFindings: 'read the whole diff; nothing wrong' });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.deepEqual(call.slice(0, 4), ['api', '--method', 'POST', `repos/owner/Endzone/statuses/${FULL_HEAD}`]);
  assert.equal(statusField(call, 'state'), 'success');
  assert.equal(statusField(call, 'context'), 'fleet-review');
  assert.match(statusField(call, 'description'), new RegExp(recorded.artifact.replace(/[.]/g, '\\.')));
  assert.equal(recorded.statusPosted, true);
  assert.equal(recorded.status.state, 'success');
});

test('#115: a formal record with an open major posts failure; only minor and nit findings post success', () => {
  const root = rootDir();
  reviewTenant(root);
  const revision = seedRecord(root);
  const { calls, gh } = stubGh();
  formalRecord(root, revision, gh, { findings: [{ file: 'a.js', claim: 'x', severity: 'major', category: 'correctness' }, { file: 'b.js', claim: 'y', severity: 'nit', category: 'style' }] });
  assert.equal(statusField(calls[0], 'state'), 'failure');
  assert.match(statusField(calls[0], 'description'), /1 blocking/);

  const root2 = rootDir();
  reviewTenant(root2);
  const revision2 = seedRecord(root2);
  const second = stubGh();
  formalRecord(root2, revision2, second.gh, { findings: [{ file: 'a.js', claim: 'x', severity: 'minor', category: 'correctness' }, { file: 'b.js', claim: 'y', severity: 'nit', category: 'style' }] });
  assert.equal(statusField(second.calls[0], 'state'), 'success');
});

test('#115: a risk record posts nothing', () => {
  const root = rootDir();
  reviewTenant(root);
  const revision = seedRecord(root, { state: 'implementing' });
  const { calls, gh } = stubGh();
  const recorded = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'risk', headSha: FULL_HEAD, actor: 'ic-42',
    classification: RISK, findings: RISK_FINDINGS, gh, idempotencyKey: 'risk-115',
  });
  assert.equal(calls.length, 0);
  assert.equal(recorded.statusPosted, undefined);
});

test('#115: a tenant with no reviewStatus posts nothing', () => {
  const root = rootDir();
  reviewTenant(root, { reviewStatus: undefined });
  const revision = seedRecord(root);
  const { calls, gh } = stubGh();
  const recorded = formalRecord(root, revision, gh, { noFindings: 'clean' });
  assert.equal(calls.length, 0);
  assert.equal(recorded.statusPosted, undefined);
});

test('#115: a failed post leaves the artifact and the review-recorded event, and says so', () => {
  const root = rootDir();
  reviewTenant(root);
  const revision = seedRecord(root);
  const { calls, gh } = stubGh({ fail: true });
  const recorded = formalRecord(root, revision, gh, { noFindings: 'clean' });
  assert.equal(calls.length, 1);
  assert.equal(recorded.statusPosted, false);
  assert.match(recorded.statusError, /502/);
  assert.ok(fs.existsSync(path.join(root, recorded.artifact)), 'the artifact stands');
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).review.formal.artifact, recorded.artifact, 'the record stands');
  assert.ok(workState.readEvents(root).some((event) => event.type === 'review-recorded' && event.changes.kind === 'formal'));
});

test('#115: --repost posts again for the latest formal artifact without a new review', () => {
  const root = rootDir();
  reviewTenant(root);
  const revision = seedRecord(root);
  const failed = stubGh({ fail: true });
  const recorded = formalRecord(root, revision, failed.gh, { findings: [{ file: 'a.js', claim: 'x', severity: 'blocker', category: 'security' }] });
  const before = workState.getRecord({ root, id: 'endzone:issue-42' }).revision;
  const { calls, gh } = stubGh();
  const reposted = repostReviewStatus({ root, recordId: 'endzone:issue-42', gh });
  assert.equal(reposted.statusPosted, true);
  assert.equal(reposted.artifact, recorded.artifact);
  assert.equal(calls.length, 1);
  assert.equal(statusField(calls[0], 'state'), 'failure');
  assert.equal(calls[0][3], `repos/owner/Endzone/statuses/${FULL_HEAD}`);
  assert.equal(workState.getRecord({ root, id: 'endzone:issue-42' }).revision, before, 'a repost records nothing');
  assert.throws(() => repostReviewStatus({ root: rootDir(), recordId: 'endzone:issue-42', gh }), (error) => ['NOT_FOUND', 'NO_PRIOR_REVIEW'].includes(error.code));
});

test('#115: the binary exits 3 when the status post fails, with the artifact recorded', () => {
  const root = rootDir();
  const { repo, head } = commitIn(root);
  reviewTenant(root, { repo });
  const revision = seedRecord(root);
  // A gh that always fails: node itself, which reads `api` as a script path it cannot find.
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const run = spawnSync(process.execPath, [
    bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'formal', '--head-sha', head, '--actor', 'pl-endzone', '--classification', '{"tier":"normal","triggers":[]}',
    '--no-findings', 'clean',
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, FLEET_GH: process.execPath } });
  assert.equal(run.status, 3, run.stderr);
  const answer = JSON.parse(run.stdout);
  assert.equal(answer.statusPosted, false);
  assert.ok(fs.existsSync(path.join(root, answer.artifact)));
  assert.match(run.stderr, /--repost/);
  const repost = spawnSync(process.execPath, [bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--repost', '--findings', '[]'], { encoding: 'utf8', windowsHide: true });
  assert.equal(repost.status, 2, 'a repost takes no review content');
});

// --- #116: `attest` posts fleet-review for a PR with no Work record (ADR 0014) ---
// Cory's interactive PRs and Dependabot's have no Work record, so `record` (which
// needs --id) cannot serve them; 54 interactive PRs merged into endzone
// `integration` in the audited week. `attest` takes the PR, its head and a findings
// artifact, keeps a copy under state/reviews/<tenant>_pr-<n>/, and posts the same
// status. Red-tell: with bin/review-policy.js reverted, `attest` is an unknown command.

function attestFixture({ prHead } = {}) {
  const root = rootDir();
  const { repo, head, prior } = commitIn(root);
  reviewTenant(root, { repo });
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: prHead || head });
    return '{}';
  };
  const artifact = (content) => {
    const file = path.join(root, `review-${calls.length}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  };
  return { root, repo, head, prior, calls, gh, artifact };
}

const statusCalls = (calls) => calls.filter((call) => call[0] === 'api');

test('#116: an attest at the PR head with a clean artifact posts success and keeps a copy', () => {
  const { root, head, calls, gh, artifact } = attestFixture();
  const attested = attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: head, artifactPath: artifact({ noFindings: 'read the whole diff; nothing wrong' }), actor: 'cory', gh });
  assert.deepEqual(calls[0].slice(0, 3), ['pr', 'view', '1601']);
  assert.ok(calls[0].includes('owner/Endzone'), 'the PR is read from the tenant repo');
  const posts = statusCalls(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0][3], `repos/owner/Endzone/statuses/${head}`);
  assert.equal(statusField(posts[0], 'state'), 'success');
  assert.equal(statusField(posts[0], 'context'), 'fleet-review');
  assert.equal(attested.statusPosted, true);
  assert.equal(attested.artifact, 'state/reviews/endzone_pr-1601/attest-001.json');
  const stored = JSON.parse(fs.readFileSync(path.join(root, attested.artifact), 'utf8'));
  assert.equal(stored.kind, 'attest');
  assert.equal(stored.pr, 1601);
  assert.equal(stored.headSha, head);
  assert.equal(stored.reviewer, 'cory');
  assert.equal(stored.noFindings, 'read the whole diff; nothing wrong');
  const second = attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: head, artifactPath: artifact({ findings: [{ file: 'a.js', claim: 'x', severity: 'major', category: 'correctness' }] }), actor: 'cory', gh });
  assert.equal(second.artifact, 'state/reviews/endzone_pr-1601/attest-002.json', 'a second attestation is its own file');
  assert.equal(second.status.state, 'failure', 'an open major posts failure, exactly as a formal record would');
});

test('#116: an attest at an older head is refused, naming the new head', () => {
  const { root, prior, head, calls, gh, artifact } = attestFixture();
  assert.throws(
    () => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: prior, artifactPath: artifact({ noFindings: 'clean' }), gh }),
    (error) => error.code === 'STALE_HEAD' && error.message.includes(head) && error.currentHead === head,
  );
  assert.equal(statusCalls(calls).length, 0, 'nothing is posted');
  assert.equal(fs.existsSync(path.join(root, 'state', 'reviews', 'endzone_pr-1601')), false, 'nothing is kept');
});

test('#116: a head the tenant repo does not hold is refused UNKNOWN_COMMIT', () => {
  const invented = '0123456'.padEnd(40, 'a');
  const { root, gh, artifact } = attestFixture({ prHead: invented });
  assert.throws(
    () => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: invented, artifactPath: artifact({ noFindings: 'clean' }), gh }),
    (error) => error.code === 'UNKNOWN_COMMIT',
  );
});

test('#445: an attestation names a full sha too: a branch name or a short sha is refused FULL_SHA_REQUIRED before the PR is read', () => {
  const { root, head, calls, gh, artifact } = attestFixture();
  for (const headSha of ['fleet/445-review-gate', head.slice(0, 8)]) {
    assert.throws(
      () => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha, artifactPath: artifact({ noFindings: 'clean' }), gh }),
      (error) => error.code === 'FULL_SHA_REQUIRED',
    );
  }
  assert.equal(calls.length, 0, 'the PR is not read');
  assert.equal(fs.existsSync(path.join(root, 'state', 'reviews')), false, 'nothing is kept');
});

test('#116: an artifact whose finding says status resolved is refused, by the record guard', () => {
  const { root, head, calls, gh, artifact } = attestFixture();
  for (const finding of [
    { file: 'a.js', claim: 'x', severity: 'nit', category: 'style', status: 'resolved' },
    { file: 'a.js', claim: 'x', severity: 'nit', category: 'style', outcome: 'fixed' },
  ]) {
    assert.throws(
      () => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: head, artifactPath: artifact({ findings: [finding] }), gh }),
      (error) => error.code === 'FINDING_CARRIES_OUTCOME',
    );
  }
  assert.equal(statusCalls(calls).length, 0);
});

test('#116: the artifact is held to the record door: severity enum, category, and never silent', () => {
  const { root, head, gh, artifact } = attestFixture();
  const refuse = (content, code) => assert.throws(
    () => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: head, artifactPath: artifact(content), gh }),
    (error) => error.code === code,
    JSON.stringify(content),
  );
  refuse({ findings: [{ file: 'a.js', claim: 'x', severity: 'high', category: 'correctness' }] }, 'INVALID_FINDING');
  refuse({ findings: [{ file: 'a.js', claim: 'x', severity: 'nit' }] }, 'INVALID_FINDING');
  refuse({ findings: [] }, 'EMPTY_FINDINGS');
  refuse({ noFindings: '   ' }, 'INVALID_ARTIFACT');
  refuse({ findings: [{ file: 'a.js', claim: 'x', severity: 'nit', category: 'style' }], noFindings: 'clean' }, 'INVALID_ARTIFACT');
  refuse([1, 2], 'INVALID_ARTIFACT');
  const missing = path.join(root, 'nope.json');
  assert.throws(() => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: head, artifactPath: missing, gh }), (error) => error.code === 'INVALID_ARTIFACT');
});

test('#445 review: an attestation at an annotated tag sha is refused FULL_SHA_REQUIRED: the tag names the commit the earlier attestation names', () => {
  const { root, repo, head, calls, gh, artifact } = attestFixture();
  gitIn(repo)('tag', '-a', 'v1', '-m', 'release', head);
  const tag = gitIn(repo)('rev-parse', 'v1');
  attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: head, artifactPath: artifact({ findings: [{ file: 'a.js', claim: 'x', severity: 'blocker', category: 'correctness' }] }), actor: 'cory', gh });
  assert.throws(
    () => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: tag, artifactPath: artifact({ noFindings: 'clean at the tag' }), actor: 'cory', gh }),
    (error) => error.code === 'FULL_SHA_REQUIRED' && error.sha === tag,
  );
  assert.equal(statusCalls(calls).length, 1, 'the refused attestation posts no status');
});

test('#446: a second attestation at a head is refused while the earlier one has an open blocker, and accounted for once it does', () => {
  const { root, head, calls, gh, artifact } = attestFixture();
  const attest = (content, extra = {}) => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: head, artifactPath: artifact(content), actor: 'cory', gh, ...extra });
  const attestations = () => fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_pr-1601')).filter((name) => /^attest-\d{3}\.json$/.test(name)).length;
  const first = attest({ findings: [{ file: 'a.js', claim: 'x', severity: 'blocker', category: 'correctness' }] });
  assert.equal(first.status.state, 'failure');
  assert.throws(
    () => attest({ noFindings: 'read it again; nothing new' }),
    (error) => error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED' && error.message.includes('attest-001-f1'),
  );
  assert.equal(attestations(), 1, 'the refused attestation keeps no copy');
  assert.equal(statusCalls(calls).length, 1, 'and posts no status');

  // Still open, carried into the second attestation with the new minor finding: the blocker keeps the status failed.
  const carried = attest({ findings: [{ file: 'b.js', claim: 'y', severity: 'minor', category: 'style' }] }, { resolutions: { 'attest-001-f1': 'still-open' } });
  assert.equal(carried.status.state, 'failure');
  const carriedStored = JSON.parse(fs.readFileSync(path.join(root, carried.artifact), 'utf8'));
  assert.equal(carriedStored.priorArtifact, first.artifact);
  assert.deepEqual(carriedStored.findings.map((finding) => finding.id).sort(), ['attest-001-f1', 'attest-002-f1']);
  assert.equal(carriedStored.findings.find((finding) => finding.id === 'attest-001-f1').carriedFrom, first.artifact);
  // A statement cannot sit beside a carried finding.
  assert.throws(
    () => attest({ noFindings: 'nothing new' }, { resolutions: { 'attest-001-f1': 'still-open', 'attest-002-f1': 'resolved' } }),
    (error) => error.code === 'USAGE' && /omit|statement|open finding/.test(error.message),
  );

  // Every open finding of the second attestation resolved: the third is accounted for and posts success.
  const settled = attest({ noFindings: 'both fixed at this head' }, { resolutions: { 'attest-001-f1': 'resolved', 'attest-002-f1': 'resolved' } });
  assert.equal(settled.artifact, 'state/reviews/endzone_pr-1601/attest-003.json');
  assert.equal(settled.status.state, 'success');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, settled.artifact), 'utf8')).priorArtifact, carried.artifact);
});

test('#446: an earlier attestation with nothing open does not hold a second one back, and a bad resolution is refused', () => {
  const { root, head, gh, artifact } = attestFixture();
  const attest = (content, extra = {}) => attestPullRequest({ root, tenantName: 'endzone', prNumber: 1601, headSha: head, artifactPath: artifact(content), actor: 'cory', gh, ...extra });
  const first = attest({ noFindings: 'read the whole diff; nothing wrong' });
  const second = attest({ noFindings: 'read it again' });
  assert.equal(second.artifact, 'state/reviews/endzone_pr-1601/attest-002.json', 'as before: a second attestation with nothing open is its own file');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8')).priorArtifact, first.artifact);

  const blocked = attest({ findings: [{ file: 'a.js', claim: 'x', severity: 'major', category: 'correctness' }] });
  assert.equal(blocked.status.state, 'failure');
  assert.throws(
    () => attest({ noFindings: 'again' }, { resolutions: { 'attest-003-f1': 'maybe' } }),
    (error) => error.code === 'INVALID_RESOLUTION',
  );
  assert.throws(
    () => attest({ noFindings: 'again' }, { resolutions: { 'attest-003-f1': 'ruled' } }),
    (error) => error.code === 'RULING_REQUIRED',
  );
  // The binary takes the same --resolutions and --ruling as record; gh that always fails stops it after the artifact checks.
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const offline = spawnSync(process.execPath, [bin, 'attest', '--root', root, '--tenant', 'endzone', '--pr', '1601', '--head', head, '--artifact', artifact({ noFindings: 'clean' }), '--resolutions', '{"attest-003-f1":"ruled"}', '--ruling', 'https://example.invalid/ruling/1'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, FLEET_GH: process.execPath } });
  assert.equal(JSON.parse(offline.stderr).code, 'PR_HEAD_UNREADABLE', offline.stderr);
});

test('#446 review: a second attestation of the same sha under another pull request number is held to the first: the newest at that head across the tenant', () => {
  const { root, head, gh, artifact } = attestFixture();
  const attest = (prNumber, content, extra = {}) => attestPullRequest({ root, tenantName: 'endzone', prNumber, headSha: head, artifactPath: artifact(content), actor: 'cory', gh, ...extra });
  const blocked = attest(7, { findings: [{ file: 'a.js', claim: 'x', severity: 'blocker', category: 'correctness' }] }, { now: '2026-11-12T10:00:00.000Z' });
  assert.equal(blocked.status.state, 'failure');
  assert.throws(
    () => attest(8, { noFindings: 'clean on PR 8' }, { now: '2026-11-12T10:05:00.000Z' }),
    (error) => error.code === 'UNRESOLVED_FINDINGS_UNACCOUNTED' && error.message.includes('attest-001-f1'),
  );
  assert.equal(fs.existsSync(path.join(root, 'state', 'reviews', 'endzone_pr-8')), false, 'the refused attestation keeps no copy under PR 8');
  const settled = attest(8, { noFindings: 'the blocker is fixed at this head' }, { resolutions: { 'attest-001-f1': 'resolved' }, now: '2026-11-12T10:06:00.000Z' });
  assert.equal(settled.status.state, 'success', 'the open blocker is settled, so the status follows the new artifact');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, settled.artifact), 'utf8')).priorArtifact, blocked.artifact);
});

test('#116: the binary attests, refuses unknown flags as USAGE, and exits 3 when the post fails', () => {
  const { root, head, artifact } = attestFixture();
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const clean = artifact({ noFindings: 'clean' });
  const typo = spawnSync(process.execPath, [bin, 'attest', '--root', root, '--tenant', 'endzone', '--pr', '1601', '--head', head, '--artifact', clean, '--head-sha', head], { encoding: 'utf8', windowsHide: true });
  assert.equal(typo.status, 2);
  assert.equal(typo.stdout, '');
  assert.match(JSON.parse(typo.stderr).message, /unknown flag --head-sha\b/);
  for (const drop of ['--tenant', '--pr', '--head', '--artifact']) {
    const args = ['--root', root, '--tenant', 'endzone', '--pr', '1601', '--head', head, '--artifact', clean];
    const at = args.indexOf(drop);
    args.splice(at, 2);
    const run = spawnSync(process.execPath, [bin, 'attest', ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 2, `missing ${drop}`);
    assert.equal(JSON.parse(run.stderr).code, 'USAGE');
  }
  // gh that always fails (node reading `pr` as a script path): the PR head cannot be read, so nothing is attested.
  const offline = spawnSync(process.execPath, [bin, 'attest', '--root', root, '--tenant', 'endzone', '--pr', '1601', '--head', head, '--artifact', clean], { encoding: 'utf8', windowsHide: true, env: { ...process.env, FLEET_GH: process.execPath } });
  assert.equal(offline.status, 1, offline.stderr);
  assert.equal(JSON.parse(offline.stderr).code, 'PR_HEAD_UNREADABLE');
});

// --- #118: a finding raised again after it was settled escalates for a Ruling ------
// On endzone #1240 one finding was re-raised five times (569k tokens). A finding may
// now say `repeats: <prior finding id>`, naming a finding in the record's chain that
// was resolved as `resolved` or `not-real`; the review still records, and the record
// goes to `escalated` (not back to the IC) with a decision-needed wake.
// Red-tell: with bin/review-policy.js reverted, the record stays in `review`.

function cycleBackToReview(root, revision, round) {
  for (const [index, to] of ['revision', 'pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({ root, id: 'endzone:issue-42', to, expectedRevision: revision, idempotencyKey: `c118-${round}-${to}`, actor: 'test', evidence: 'cycle', now: `2026-09-24T04:${round}${index}:00.000Z` }).revision;
  }
  return revision;
}

function settledChain(root) {
  let revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('aaa1111'), actor: 'pl-endzone',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'a.js', claim: 'null deref', severity: 'major', category: 'correctness' }, { file: 'b.js', claim: 'phantom', severity: 'minor', category: 'correctness' }],
    idempotencyKey: 'f118-1', now: '2026-09-24T04:00:00.000Z',
  });
  revision = cycleBackToReview(root, first.result.revision, 1);
  const second = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('bbb2222'), actor: 'pl-endzone',
    classification: { tier: 'normal', triggers: [] }, priorArtifact: first.artifact,
    resolutions: { 'formal-001-f1': 'resolved', 'formal-001-f2': 'not-real' },
    noFindings: 'the changed range fixes the null deref; nothing new',
    idempotencyKey: 'f118-2', now: '2026-09-24T04:20:00.000Z',
  });
  revision = cycleBackToReview(root, second.result.revision, 3);
  return { revision, first, second };
}

test('#118: a formal review carrying a repeats finding records and moves the record to escalated, not revision', () => {
  const root = rootDir();
  const { revision, second } = settledChain(root);
  const third = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('ccc3333'), actor: 'pl-endzone',
    classification: { tier: 'normal', triggers: [] }, priorArtifact: second.artifact,
    findings: [{ file: 'a.js', claim: 'null deref is back', severity: 'major', category: 'correctness', repeats: 'formal-001-f1' }],
    idempotencyKey: 'f118-3', now: '2026-09-24T04:40:00.000Z',
  });
  assert.ok(fs.existsSync(path.join(root, third.artifact)), 'the review still records');
  const stored = JSON.parse(fs.readFileSync(path.join(root, third.artifact), 'utf8'));
  assert.equal(stored.findings[0].repeats, 'formal-001-f1');
  const rec = workState.getRecord({ root, id: 'endzone:issue-42' });
  assert.equal(rec.review.formal.artifact, third.artifact);
  assert.equal(rec.state, 'escalated');
  assert.equal(rec.prior_state, 'review');
  assert.match(rec.decisionEvidence, /same finding raised twice, needs a Ruling/);
  assert.match(rec.decisionEvidence, /formal-003-f1 repeats formal-001-f1/);
  assert.equal(third.escalated.state, 'escalated');
  const wakes = fs.readFileSync(path.join(root, 'state', 'watch', 'wake-outbox.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(wakes.filter((w) => w.wake === 'decision-needed').length, 1);
});

test('#118: repeats may name a not-real finding too; a repeats naming nothing settled is refused and writes nothing', () => {
  const root = rootDir();
  const { revision, second } = settledChain(root);
  const base = {
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('ccc3333'), actor: 'pl-endzone',
    classification: { tier: 'normal', triggers: [] }, priorArtifact: second.artifact, now: '2026-09-24T04:40:00.000Z',
  };
  for (const repeats of ['formal-009-f1', '', 42]) {
    assert.throws(
      () => recordReviewArtifact({ ...base, idempotencyKey: `bad-${repeats}`, findings: [{ file: 'a.js', claim: 'x', severity: 'major', category: 'correctness', repeats }] }),
      (error) => error.code === 'INVALID_FINDING' && /repeats/.test(error.message),
      `repeats ${JSON.stringify(repeats)}`,
    );
  }
  const dir = path.join(root, 'state', 'reviews', 'endzone_issue-42');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['formal-001.json', 'formal-002.json'], 'a refused repeats writes nothing');
  const notReal = recordReviewArtifact({ ...base, idempotencyKey: 'ok', findings: [{ file: 'b.js', claim: 'phantom again', severity: 'minor', category: 'correctness', repeats: 'formal-001-f2' }] });
  assert.equal(notReal.escalated.state, 'escalated');
});

test('#118: a finding still open in the chain is not a repeat; repeats belongs to a formal review', () => {
  const root = rootDir();
  let revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('aaa1111'), actor: 'pl-endzone',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'a.js', claim: 'x', severity: 'major', category: 'correctness' }],
    idempotencyKey: 'o118-1', now: '2026-09-24T05:00:00.000Z',
  });
  revision = cycleBackToReview(root, first.result.revision, 5);
  assert.throws(
    () => recordReviewArtifact({
      root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('bbb2222'), actor: 'pl-endzone',
      classification: { tier: 'normal', triggers: [] }, priorArtifact: first.artifact,
      resolutions: { 'formal-001-f1': 'still-open' },
      findings: [{ file: 'a.js', claim: 'x again', severity: 'major', category: 'correctness', repeats: 'formal-001-f1' }],
      idempotencyKey: 'o118-2', now: '2026-09-24T05:30:00.000Z',
    }),
    (error) => error.code === 'INVALID_FINDING' && /resolved, not-real or ruled/.test(error.message),
  );
  const root2 = rootDir();
  const revision2 = seedRecord(root2, { state: 'implementing' });
  assert.throws(
    () => recordReviewArtifact({ root: root2, recordId: 'endzone:issue-42', expectedRevision: revision2, kind: 'risk', headSha: sha40('ddd4444'), actor: 'ic-42', classification: RISK, findings: [{ ...RISK_FINDINGS[0], repeats: 'risk-001-f1' }] }),
    (error) => error.code === 'INVALID_FINDING' && /formal/.test(error.message),
  );
});

test('#118 review: a repeats finding blocks the review status whatever its severity', () => {
  const root = rootDir();
  reviewTenant(root);
  const { revision, second } = settledChain(root);
  const { calls, gh } = stubGh();
  recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('ccc3333'), actor: 'pl-endzone',
    classification: { tier: 'normal', triggers: [] }, priorArtifact: second.artifact, gh,
    findings: [{ file: 'b.js', claim: 'phantom again', severity: 'minor', category: 'correctness', repeats: 'formal-001-f2' }],
    idempotencyKey: 'rb118', now: '2026-09-24T04:50:00.000Z',
  });
  assert.equal(statusField(calls[0], 'state'), 'failure', 'a record escalated for a Ruling must not carry a green status');
});

// Spec fleet #93 / #155: record and attest write the login that posted the
// fleet-review status next to the head sha it vouches for.
function creatorGh(login, calls = []) {
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: gh.head });
    if (args[0] === 'api') return JSON.stringify({ id: 1, state: 'success', creator: { login } });
    return '{}';
  };
  gh.calls = calls;
  return gh;
}

test('#155: record writes the posting login next to the reviewed head', () => {
  const root = rootDir();
  reviewTenant(root);
  const revision = seedRecord(root);
  const recorded = formalRecord(root, revision, creatorGh('fleet-bot'), { noFindings: 'read the whole diff; nothing wrong' });
  assert.equal(recorded.status.postedBy, 'fleet-bot');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, recorded.statusReceipt), 'utf8'));
  assert.equal(receipt.postedBy, 'fleet-bot');
  assert.equal(receipt.headSha, FULL_HEAD);
  assert.equal(receipt.artifact, recorded.artifact);
  assert.equal(recorded.statusReceipt, recorded.artifact.replace(/\.json$/, '.status.json'));
});

test('#155: attest writes the posting login next to the attested head', () => {
  const { root, head, gh: fixtureGh, artifact } = attestFixture();
  const gh = creatorGh('cory-owner');
  gh.head = head;
  const attested = attestPullRequest({ root, tenantName: 'endzone', prNumber: 1602, headSha: head, artifactPath: artifact({ noFindings: 'read it all' }), actor: 'cory', gh });
  assert.ok(fixtureGh);
  assert.equal(attested.status.postedBy, 'cory-owner');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, attested.statusReceipt), 'utf8'));
  assert.deepEqual([receipt.postedBy, receipt.headSha, receipt.context], ['cory-owner', head, 'fleet-review']);
});

test('#155: a status answer with no creator records postedBy null, never a guess', () => {
  const root = rootDir();
  reviewTenant(root);
  const revision = seedRecord(root);
  const { gh } = stubGh();
  const recorded = formalRecord(root, revision, gh, { noFindings: 'read the whole diff; nothing wrong' });
  assert.equal(recorded.status.postedBy, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, recorded.statusReceipt), 'utf8')).postedBy, null);
});

test('#154: the review-policy loader refuses a tenant whose fleetIdentity is its ownerLogin', () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', 'shared.json'), JSON.stringify({ name: 'shared', github: 'owner/repo', reviewStatus: 'fleet-review', fleetIdentity: 'andydarknessb', ownerLogin: 'andydarknessb' }));
  assert.throws(() => attestPullRequest({ root, tenantName: 'shared', prNumber: 1, headSha: 'a'.repeat(40), artifactPath: __filename, gh: () => '{}' }), { code: 'TENANT_IDENTITY_NOT_DISTINCT' });
});

test('#211: criteria-defect is a named finding category: it records as written, and the refusal for a bad category names it', () => {
  assert.equal(require('../bin/review-policy').CRITERIA_CATEGORY, 'criteria-defect');
  const root = rootDir();
  const revision = seedRecord(root);
  const recorded = formalAt(root, revision, [{ file: 'a.js', claim: 'the criterion cannot be met as written', severity: 'major', category: 'criteria-defect' }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, recorded.artifact), 'utf8')).findings[0].category, 'criteria-defect');
  const other = rootDir();
  assert.throws(
    () => formalAt(other, seedRecord(other), [{ file: 'a.js', claim: 'x', severity: 'minor', category: 'Criteria Defect' }]),
    (error) => error.code === 'INVALID_FINDING' && /criteria-defect/.test(error.message),
  );
});

// --- #324: a `ruled` resolution settles a finding a Ruling keeps --------------
// A finding a Ruling accepts as it stands is real and unfixed; `still-open` carried
// it and held `fleet-review` red until Cory posted the status by hand. `ruled`
// settles it, and the Ruling's reference rides on the artifact as `ruling`.
// Red-tell: with bin/review-policy.js reverted, `ruled` is INVALID_RESOLUTION.

const RULING = 'https://github.com/owner/Endzone/issues/2491#issuecomment-1';

function blockerChain(root) {
  reviewTenant(root);
  const revision = seedRecord(root);
  const first = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('aaa1111'), actor: 'pl-endzone',
    classification: { tier: 'normal', triggers: [] },
    findings: [{ file: 'a.js', claim: 'spec sets the hex', severity: 'major', category: 'correctness' }],
    idempotencyKey: 'r324-1', now: '2026-09-24T04:00:00.000Z',
  });
  return { revision: cycleBackToReview(root, first.result.revision, 1), first };
}

test('#324: a formal re-review whose only blocker is resolved ruled posts success, carries nothing, and records the ruling', () => {
  const root = rootDir();
  const { revision, first } = blockerChain(root);
  const { calls, gh } = stubGh();
  const second = formalRecord(root, revision, gh, {
    headSha: sha40('bbb2222'), priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'ruled' },
    ruling: `  ${RULING}  `, noFindings: 'the Ruling keeps the finding; nothing new', idempotencyKey: 'r324-2',
  });
  assert.equal(statusField(calls[0], 'state'), 'success');
  const stored = JSON.parse(fs.readFileSync(path.join(root, second.artifact), 'utf8'));
  assert.equal(stored.ruling, RULING);
  assert.deepEqual(stored.findings, []);
});

test('#324: ruled without --ruling (missing or blank) is refused RULING_REQUIRED and writes nothing new', () => {
  const root = rootDir();
  const { revision, first } = blockerChain(root);
  const { gh } = stubGh();
  for (const ruling of [undefined, '', '   ', 'true']) {
    assert.throws(
      () => formalRecord(root, revision, gh, { headSha: 'b'.repeat(40), priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'ruled' }, ruling, noFindings: 'x', idempotencyKey: 'r324-3' }),
      (error) => error.code === 'RULING_REQUIRED',
      `ruling ${JSON.stringify(ruling)}`,
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')), ['formal-001.json']);
});

test('#324: --ruling with no ruled resolution is refused USAGE and writes nothing new', () => {
  const root = rootDir();
  const { revision, first } = blockerChain(root);
  const { gh } = stubGh();
  assert.throws(
    () => formalRecord(root, revision, gh, { headSha: 'b'.repeat(40), priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'resolved' }, ruling: RULING, noFindings: 'x', idempotencyKey: 'r324-4' }),
    (error) => error.code === 'USAGE' && /--ruling/.test(error.message),
  );
  assert.deepEqual(fs.readdirSync(path.join(root, 'state', 'reviews', 'endzone_issue-42')), ['formal-001.json']);
});

test('#324: a finding that repeats a ruled finding is accepted and escalates, like a repeat of a resolved one', () => {
  const root = rootDir();
  const { revision, first } = blockerChain(root);
  const { gh } = stubGh();
  const second = formalRecord(root, revision, gh, {
    headSha: 'b'.repeat(40), priorArtifact: first.artifact, resolutions: { 'formal-001-f1': 'ruled' },
    ruling: RULING, noFindings: 'ruled', idempotencyKey: 'r324-5',
  });
  const next = cycleBackToReview(root, second.result.revision, 3);
  const third = formalRecord(root, next, gh, {
    headSha: 'c'.repeat(40), priorArtifact: second.artifact, idempotencyKey: 'r324-6',
    findings: [{ file: 'a.js', claim: 'the hex again', severity: 'major', category: 'correctness', repeats: 'formal-001-f1' }],
  });
  assert.equal(third.escalated.state, 'escalated');
});

test('#324: RULING_REQUIRED exits 2 through the CLI and writes nothing', () => {
  const root = rootDir();
  const revision = seedRecord(root);
  const { repo, head } = commitIn(root);
  const bin = path.join(__dirname, '..', 'bin', 'review-policy.js');
  const run = spawnSync(process.execPath, [bin, 'record', '--root', root, '--id', 'endzone:issue-42', '--expected-revision', String(revision),
    '--kind', 'formal', '--head-sha', head, '--repo-path', repo, '--actor', 'project-lead', '--no-findings', 'clean',
    '--classification', JSON.stringify({ tier: 'normal', triggers: [] }), '--resolutions', JSON.stringify({ 'formal-001-f1': 'ruled' }), '--ruling'], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(JSON.parse(run.stderr).code, 'RULING_REQUIRED');
  assertNothingWritten(root);
});

test('#324: a risk finding can be ruled; the formal review posts success and plan-rereview lists nothing unresolved', () => {
  const root = rootDir();
  reviewTenant(root);
  const { revision } = seedRiskThenReview(root);
  const { calls, gh } = stubGh();
  const formal = recordReviewArtifact({
    root, recordId: 'endzone:issue-42', expectedRevision: revision, kind: 'formal', headSha: sha40('17fa3c48'), actor: 'project-lead', git: ACCESSIBILITY_HEAD, gh,
    resolutions: { 'risk-001-f1': 'ruled', 'risk-001-f2': 'resolved', 'risk-001-f3': 'resolved' }, ruling: RULING,
    noFindings: 'the Ruling keeps the risk finding; nothing new', idempotencyKey: 'r324-risk', now: '2026-09-12T11:00:00.000Z',
  });
  assert.equal(statusField(calls[0], 'state'), 'success');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, formal.artifact), 'utf8')).ruling, RULING);
  assert.deepEqual(planRereview({ root, recordId: 'endzone:issue-42', headSha: sha40('28ab0000') }).unresolved, []);
});

// --- fleet #390: a standing exception passes the Review gate for a Reconcile PR (the tenant's main merged into
// its integration branch) with no formal review. The ruling lives in config/review-exceptions.json under
// `standing`; review-policy recognizes the PR by its head and base and posts fleet-review success on its head.

const RECONCILE_TENANT = { name: 'endzone', github: 'owner/Endzone', defaultBranch: 'integration', releaseBranch: 'main', reviewStatus: 'fleet-review', ownerLogin: 'andydarknessb' };
const RECONCILE_PR = { headRefName: 'main', baseRefName: 'integration', isCrossRepository: false };
// gh answers `api user` with the login it acts as (the fleet's, unless a test says otherwise) and the status POST with the status it created.
const actingAs = (login) => (args) => (args[1] === 'user' ? login : JSON.stringify({ state: 'success', creator: { login } }));
const postsOf = (calls) => calls.filter((args) => args.includes('--method'));

function standingRoot({ standing = [{ kind: 'reconcile', ruling: 'Cory 2026-11-06 (fleet #382 ruling 1)' }] } = {}) {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'review-exceptions.json'), JSON.stringify({ schemaVersion: 1, exceptions: [], standing }));
  return root;
}

test('#390: the standing reconcile exception recognizes main into integration and posts success on the head, naming its ruling', () => {
  const root = standingRoot();
  const exception = standingException(root, RECONCILE_TENANT, RECONCILE_PR);
  assert.equal(exception.kind, 'reconcile');
  const calls = [];
  const gh = (args) => { calls.push(args); return actingAs('andydarknessb-fleet')(args); };
  const posted = postStandingStatus({ tenant: RECONCILE_TENANT, exception, headSha: FULL_HEAD, headRefName: 'main', baseRefName: 'integration', gh });
  const posts = postsOf(calls);
  assert.equal(posts.length, 1, 'one status post, no artifact and no receipt');
  assert.deepEqual(posts[0].slice(0, 4), ['api', '--method', 'POST', `repos/owner/Endzone/statuses/${FULL_HEAD}`]);
  assert.equal(statusField(posts[0], 'state'), 'success');
  assert.equal(statusField(posts[0], 'context'), 'fleet-review');
  assert.match(statusField(posts[0], 'description'), /^standing exception reconcile: main into integration/);
  assert.equal(posted.statusPosted, true);
  assert.equal(posted.status.postedBy, 'andydarknessb-fleet');
});

test('#390: a watcher that acts as the tenant owner posts no standing status, the owner never gates the fleet (ADR 0015)', () => {
  const root = standingRoot();
  const exception = standingException(root, RECONCILE_TENANT, RECONCILE_PR);
  const calls = [];
  const gh = (args) => { calls.push(args); return actingAs('andydarknessb')(args); };
  const posted = postStandingStatus({ tenant: RECONCILE_TENANT, exception, headSha: FULL_HEAD, headRefName: 'main', baseRefName: 'integration', gh });
  assert.equal(posted.statusPosted, false);
  assert.match(posted.statusError, /tenant owner/);
  assert.equal(postsOf(calls).length, 0);
});

test('#390: a PR that is not main into integration from this repo is not recognized, and nothing is posted for it', () => {
  const root = standingRoot();
  assert.equal(standingException(root, RECONCILE_TENANT, { ...RECONCILE_PR, headRefName: 'fleet/12-thing' }), null);
  assert.equal(standingException(root, RECONCILE_TENANT, { ...RECONCILE_PR, baseRefName: 'master' }), null);
  assert.equal(standingException(root, RECONCILE_TENANT, { ...RECONCILE_PR, isCrossRepository: true }), null);
  assert.equal(standingException(root, { ...RECONCILE_TENANT, defaultBranch: 'master', releaseBranch: 'master' }, { headRefName: 'master', baseRefName: 'master' }), null, 'a tenant with one branch has no Reconcile PR');
  assert.equal(standingException(standingRoot({ standing: [] }), RECONCILE_TENANT, RECONCILE_PR), null, 'no standing entry, no exception');
  assert.equal(standingException(standingRoot({ standing: [{ kind: 'reconcile', ruling: '  ' }] }), RECONCILE_TENANT, RECONCILE_PR), null, 'an entry with no ruling acknowledges nothing');
  const calls = [];
  const gh = (args) => { calls.push(args); return '{}'; };
  assert.equal(postStandingStatus({ tenant: RECONCILE_TENANT, exception: null, headSha: FULL_HEAD, headRefName: 'fleet/12-thing', baseRefName: 'integration', gh }).statusPosted, false);
  assert.equal(calls.length, 0, 'an unrecognized PR gets no status');
});

test('#390: an unreadable or missing review-exceptions config fails closed with its own code', () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'review-exceptions.json'), '{ not json');
  assert.throws(() => standingException(root, RECONCILE_TENANT, RECONCILE_PR), (error) => error.code === 'EXCEPTIONS_UNREADABLE');
  assert.throws(() => standingException(rootDir(), RECONCILE_TENANT, RECONCILE_PR), (error) => error.code === 'EXCEPTIONS_UNREADABLE', 'a missing file is unreadable too');
});

test('#390: a status GitHub refuses is reported on the result, not thrown; a tenant with no reviewStatus posts nothing', () => {
  const root = standingRoot();
  const exception = standingException(root, RECONCILE_TENANT, RECONCILE_PR);
  const refusing = () => { const error = new Error('HTTP 502'); error.stderr = 'gh: HTTP 502 Bad Gateway'; throw error; };
  const posted = postStandingStatus({ tenant: RECONCILE_TENANT, exception, headSha: FULL_HEAD, headRefName: 'main', baseRefName: 'integration', gh: refusing });
  assert.equal(posted.statusPosted, false);
  assert.match(posted.statusError, /HTTP 502/);
  const calls = [];
  const noStatus = postStandingStatus({ tenant: { ...RECONCILE_TENANT, reviewStatus: undefined }, exception, headSha: FULL_HEAD, headRefName: 'main', baseRefName: 'integration', gh: (args) => { calls.push(args); return '{}'; } });
  assert.equal(noStatus.statusPosted, false);
  assert.equal(calls.length, 0);
});

test('#390: the shipped review-exceptions config recognizes the Reconcile PR of a release-branch tenant, with its ruling', () => {
  const exception = standingException(path.join(__dirname, '..'), RECONCILE_TENANT, RECONCILE_PR);
  assert.equal(exception.kind, 'reconcile');
  assert.match(exception.ruling, /2026-11-06/);
});
