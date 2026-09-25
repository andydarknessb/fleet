'use strict';
// Spec fleet #92 (audit workstream 4): a ticket's `## Premises` section is data.
// #143 parses it and pins it in the manifest; #144 re-checks only the premises
// whose paths moved between their sha and the fetched base.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parsePremises, PremisesError } = require('../bin/premises');
const { reserveAssignment, validateManifest, deriveReservations, normalizeIssue } = require('../bin/assignment');
const { getRecord } = require('../bin/work-state');

const SHA = '0123456789abcdef0123456789abcdef01234567';

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-premises-'));
}

function issue(number, body) {
  return {
    number, title: `Issue ${number}`, url: `https://github.com/example/repo/issues/${number}`,
    body, createdAt: '2026-09-01T00:00:00.000Z', state: 'OPEN', labels: ['ready-for-agent'], assignees: [],
  };
}

function bodyWith(premises) {
  return ['## What to build', '', 'Change `src/feature.js`.', '', ...(premises === undefined ? [] : ['## Premises', '', ...premises, '']), '## Acceptance criteria', '', '- [ ] it works'].join('\n');
}

// ------------------------------------------------------------ #143 parser ----

test('#143: a valid section parses one premise per line, bullets and fenced paths allowed', () => {
  const parsed = parsePremises(bodyWith([
    `server/modules/advisoryLock.js:53: \`LOCK\` is taken before the read @${SHA}`,
    '- `src/feature.js`: exports `render` @abcdef1',
  ]));
  assert.deepEqual(parsed, [
    { path: 'server/modules/advisoryLock.js:53', claim: '`LOCK` is taken before the read', sha: SHA, line: `server/modules/advisoryLock.js:53: \`LOCK\` is taken before the read @${SHA}` },
    { path: 'src/feature.js', claim: 'exports `render`', sha: 'abcdef1', line: '- `src/feature.js`: exports `render` @abcdef1' },
  ]);
});

test('#143: `none` is an empty list and an absent section is null', () => {
  assert.deepEqual(parsePremises(bodyWith(['none'])), []);
  assert.deepEqual(parsePremises(bodyWith(['None'])), []);
  assert.equal(parsePremises(bodyWith(undefined)), null);
  assert.equal(parsePremises(''), null);
});

test('#143: a line matching neither shape refuses and quotes the line', () => {
  assert.throws(() => parsePremises(bodyWith([`src/a.js: fine @${SHA}`, 'the lock is taken first'])), (error) => error instanceof PremisesError && error.code === 'PREMISES_MALFORMED' && error.line === 'the lock is taken first' && /the lock is taken first/.test(error.message));
  assert.throws(() => parsePremises(bodyWith(['none', `src/a.js: fine @${SHA}`])), (error) => error.code === 'PREMISES_MALFORMED' && /none/.test(error.message));
  assert.throws(() => parsePremises(bodyWith([])), (error) => error.code === 'PREMISES_MALFORMED' && /empty/.test(error.message));
  assert.throws(() => parsePremises(`${bodyWith(['none'])}\n## Premises\n\nnone\n`), (error) => error.code === 'PREMISES_MALFORMED' && /more than one/.test(error.message));
});

test('#143: a sha shorter than seven hex characters (or not hex) refuses', () => {
  assert.throws(() => parsePremises(bodyWith(['src/a.js: exports render @abc123'])), (error) => error.code === 'PREMISES_MALFORMED' && error.line === 'src/a.js: exports render @abc123' && /7/.test(error.message));
  assert.throws(() => parsePremises(bodyWith(['src/a.js: exports render @zzzzzzz'])), (error) => error.code === 'PREMISES_MALFORMED');
  assert.throws(() => parsePremises(bodyWith(['src/a.js: exports render'])), (error) => error.code === 'PREMISES_MALFORMED');
});

test('#143: the section ends at the next level-one or level-two heading; a deeper heading inside it is malformed', () => {
  assert.deepEqual(parsePremises(`## Premises\nnone\n# Next\nnot a premise`), []);
  assert.throws(() => parsePremises(`## Premises\nnone\n### Notes\n`), (error) => error.code === 'PREMISES_MALFORMED' && error.line === '### Notes');
});

test('#143: a premise path is a citation, never a reservation', () => {
  const derived = deriveReservations({ body: bodyWith([`server/modules/lock.js: the lock is taken first @${SHA}`]), comments: [] });
  assert.deepEqual(derived.reservations.components, ['src/feature.js']);
});

// ------------------------------------------------------ #143 manifest pin ----

function assign(root, body, extra = {}) {
  return reserveAssignment({
    root, issue: issue(77, body), tenant: 'endzone', tenantConfig: { branchPrefix: 'fleet/' }, readyLabel: 'ready-for-agent',
    base: { remote: 'origin', ref: 'integration', sha: 'b'.repeat(40) }, now: '2026-09-24T00:00:00.000Z', ...extra,
  });
}

test('#143: assign pins null for an absent section and [] for none, on the manifest and the Work record', () => {
  const absent = assign(rootDir(), bodyWith(undefined));
  assert.equal(absent.manifest.premises, null);
  const root = rootDir();
  const none = assign(root, bodyWith(['none']));
  assert.deepEqual(none.manifest.premises, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(none.manifestPath, 'utf8')).premises, []);
  assert.deepEqual(getRecord({ root, id: 'endzone:issue-77' }).assignment.premises, []);
});

test('#143: a malformed section refuses at assign and writes no manifest and no Work record', () => {
  const root = rootDir();
  assert.throws(() => assign(root, bodyWith(['half a premise'])), (error) => error.code === 'PREMISES_MALFORMED' && error.issue === 77 && /half a premise/.test(error.message));
  assert.throws(() => getRecord({ root, id: 'endzone:issue-77' }), (error) => error.code === 'NOT_FOUND');
  const manifests = path.join(root, 'state', 'manifests');
  assert.equal(fs.existsSync(manifests) ? fs.readdirSync(manifests).length : 0, 0);
});

test('#143: premises are read from the body, never from comments', () => {
  const withComment = { ...issue(78, bodyWith(undefined)), comments: [{ id: 'c1', createdAt: '2026-09-02T00:00:00.000Z', body: `## Premises\n\nsrc/a.js: claim @${SHA}` }] };
  assert.equal(normalizeIssue(withComment).premises, null);
});

test('#143: a changed Premises section invalidates the manifest at launch like any body change', () => {
  const root = rootDir();
  const reserved = assign(root, bodyWith(['none']));
  const edited = issue(77, bodyWith([`src/feature.js: exports render @${SHA}`]));
  const validation = validateManifest({ manifest: reserved.manifest, issue: edited, base: { sha: 'b'.repeat(40) } });
  assert.equal(validation.valid, false);
  assert.ok(validation.mismatches.some((mismatch) => mismatch.field === 'issue.bodyHash'));
});

// ------------------------------------------------ #144 assign-time check ----

const { execFileSync } = require('node:child_process');
const workState = require('../bin/work-state');
const { checkPremises } = require('../bin/premises');
const { selectTriageFrontier, DEFAULT_CONFIG } = require('../bin/triage');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

// A tenant checkout with two commits: `first` writes src/a.js and src/lib/b.js,
// `head` changes only src/lib/b.js. `head` is the fetched base.
function tenantRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-premises-repo-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'lib', 'b.js'), 'module.exports = 2;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const first = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src', 'lib', 'b.js'), 'module.exports = 3;\n');
  git(repo, 'commit', '-q', '-am', 'second');
  return { repo, first, head: git(repo, 'rev-parse', 'HEAD') };
}

function assignAt(root, repo, head, premiseLines, extra = {}) {
  return reserveAssignment({
    root, issue: issue(90, bodyWith(premiseLines)), tenant: 'endzone', tenantConfig: { branchPrefix: 'fleet/' }, readyLabel: 'ready-for-agent',
    repoPath: repo, base: { remote: 'origin', ref: 'integration', sha: head }, now: '2026-09-24T00:00:00.000Z', ...extra,
  });
}

test('#144: checkPremises diffs each premise sha against the base with --name-only and matches files and directories', () => {
  const { repo, first, head } = tenantRepo();
  const premises = parsePremises(bodyWith([`src/a.js:1: exports 1 @${first}`, `src/lib: holds b @${first.slice(0, 7)}`, `src/lib/b.js: exports 2 @${first}`, `src/lib/b.js: exports 3 @${head}`]));
  const check = checkPremises({ premises, repoPath: repo, baseSha: head });
  assert.equal(check.head, head);
  assert.deepEqual(check.changed.map((entry) => entry.line), [`src/lib: holds b @${first.slice(0, 7)}`, `src/lib/b.js: exports 2 @${first}`]);
  assert.deepEqual(check.changed[1].changedFiles, ['src/lib/b.js']);
});

test('#144: nothing changed under any premise path: assignment proceeds and pins the check', () => {
  const root = rootDir();
  const { repo, first, head } = tenantRepo();
  const reserved = assignAt(root, repo, head, [`src/a.js: exports 1 @${first}`]);
  assert.deepEqual(reserved.manifest.premiseCheck, { head, changed: [] });
  assert.deepEqual(getRecord({ root, id: 'endzone:issue-90' }).assignment.premiseCheck, { head, changed: [] });
});

test('#144: a changed premise path refuses PREMISE_PATH_CHANGED naming each changed premise, and writes nothing', () => {
  const root = rootDir();
  const { repo, first, head } = tenantRepo();
  const line = `src/lib/b.js: exports 2 @${first}`;
  assert.throws(() => assignAt(root, repo, head, [`src/a.js: exports 1 @${first}`, line]), (error) => {
    assert.equal(error.code, 'PREMISE_PATH_CHANGED');
    assert.deepEqual(error.changed.map((entry) => ({ path: entry.path, claim: entry.claim, sha: entry.sha, head: entry.head, line: entry.line })), [{ path: 'src/lib/b.js', claim: 'exports 2', sha: first, head, line }]);
    assert.match(error.message, /--premises-rechecked/);
    return true;
  });
  assert.throws(() => getRecord({ root, id: 'endzone:issue-90' }), (error) => error.code === 'NOT_FOUND');
  const manifests = path.join(root, 'state', 'manifests');
  assert.equal(fs.existsSync(manifests) ? fs.readdirSync(manifests).length : 0, 0);
});

test('#144: re-run with the attestation at the manifest base succeeds and records which premises were re-checked', () => {
  const root = rootDir();
  const { repo, first, head } = tenantRepo();
  const line = `src/lib/b.js: exports 2 @${first}`;
  const reserved = assignAt(root, repo, head, [`src/a.js: exports 1 @${first}`, line], { premisesRechecked: head });
  assert.deepEqual(reserved.manifest.premiseCheck.changed.map((entry) => entry.line), [line]);
  assert.deepEqual(reserved.manifest.premiseCheck.attestation, { head, rechecked: [line] });
  assert.deepEqual(getRecord({ root, id: 'endzone:issue-90' }).assignment.premiseCheck.attestation, { head, rechecked: [line] });
});

test('#144: an attestation at any other head than the manifest base is refused', () => {
  const root = rootDir();
  const { repo, first, head } = tenantRepo();
  assert.throws(() => assignAt(root, repo, head, [`src/lib/b.js: exports 2 @${first}`], { premisesRechecked: first }), (error) => error.code === 'PREMISE_ATTESTATION_STALE' && error.base === head);
  assert.throws(() => getRecord({ root, id: 'endzone:issue-90' }), (error) => error.code === 'NOT_FOUND');
});

test('#144: a premise sha the tenant checkout never saw refuses with its own code', () => {
  const root = rootDir();
  const { repo, head } = tenantRepo();
  assert.throws(() => assignAt(root, repo, head, ['src/a.js: exports 1 @deadbeefdeadbeef']), (error) => error.code === 'PREMISE_SHA_UNKNOWN' && /deadbeefdeadbeef/.test(error.message));
  assert.throws(() => getRecord({ root, id: 'endzone:issue-90' }), (error) => error.code === 'NOT_FOUND');
});

test('#144: premises to check with no tenant checkout refuse instead of passing unchecked', () => {
  const root = rootDir();
  assert.throws(() => assignAt(root, undefined, 'b'.repeat(40), [`src/a.js: exports 1 @${SHA}`]), (error) => error.code === 'PREMISE_CHECK_UNAVAILABLE');
});

test('#144: escalating a stale premise puts reason stale-premise and the premise line on the decision-needed wake, and the Principal frontier carries both', () => {
  const root = rootDir();
  const id = 'endzone:issue-91';
  const line = 'src/lib/b.js: exports 2 @0123456';
  workState.createRecord({ root, id, tenant: 'endzone', issue: 91, state: 'assigned', idempotencyKey: 'create-91', now: '2026-09-24T00:00:00.000Z' });
  assert.throws(() => workState.transitionRecord({ root, id, to: 'escalated', expectedRevision: 1, evidence: 'moved', reason: 'drift', premise: line, idempotencyKey: 'esc-x' }), (error) => error.code === 'USAGE');
  assert.throws(() => workState.transitionRecord({ root, id, to: 'escalated', expectedRevision: 1, evidence: 'moved', reason: 'stale-premise', idempotencyKey: 'esc-y' }), (error) => error.code === 'USAGE' && /--premise/.test(error.message));
  workState.transitionRecord({ root, id, to: 'escalated', expectedRevision: 1, evidence: 'stale premise: b.js now exports 3', reason: 'stale-premise', premise: line, idempotencyKey: 'esc-91', now: '2026-09-24T00:01:00.000Z' });
  const outbox = fs.readFileSync(path.join(root, 'state', 'watch', 'wake-outbox.jsonl'), 'utf8').trim().split('\n').map((raw) => JSON.parse(raw));
  const wake = outbox.find((entry) => entry.recordId === id);
  assert.equal(wake.wake, 'decision-needed');
  assert.equal(wake.reason, 'stale-premise');
  assert.equal(wake.premise, line);
  const frontier = selectTriageFrontier({ issues: [], ownerLogin: 'cory', config: DEFAULT_CONFIG, outbox, tenant: 'endzone', now: '2026-09-24T01:00:00.000Z' });
  const escalation = frontier.eligible.find((entry) => entry.kind === 'escalation');
  assert.equal(escalation.escalationReason, 'stale-premise');
  assert.equal(escalation.premise, line);
});
