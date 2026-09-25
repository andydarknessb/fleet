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
