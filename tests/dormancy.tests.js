'use strict';
// Ticket 386: is a Tenant dormant (CONTEXT.md). The pure evaluation, the gather that feeds it from the existing
// frontiers, PRs, Work records and wake outbox, and the snapshot that Rotation and the Sentinel's respawn read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./temp-dir');

const dormancy = require('../bin/dormancy');

const NOW = '2026-11-06T12:00:00.000Z';
const WATERMARK = '2026-11-06T11:00:00.000Z';
const QUIET = Object.freeze({ frontier: 0, triage: 0, verdicts: 0, openPrs: 0, escalations: 0, inFlight: 0, wakes: 0, legacyHolds: 0 });
const KEYS = ['frontier', 'triage', 'verdicts', 'openPrs', 'escalations', 'inFlight', 'wakes', 'legacyHolds'];

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function writeJson(root, relative, value) {
  return write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

// One tenant file, and empty fixtures so the planner and the triage frontiers read no GitHub.
function tenantRoot() {
  const root = makeTempDir('fleet-dormancy-');
  writeJson(root, 'tenants/endzone.json', {
    name: 'endzone', github: 'owner/endzone', readyLabel: 'ready-for-agent', ownerLogin: 'owner',
    fleetIdentity: 'fleet-login', branchPrefix: 'fleet/', maxIcs: 2,
  });
  write(root, 'fixtures/empty.json', '[]\n');
  return root;
}

function withFixtures(root, fn) {
  const names = ['FLEET_GITHUB_ISSUES_FIXTURE', 'FLEET_TRIAGE_ISSUES_FIXTURE', 'FLEET_GITHUB_PRS_FIXTURE'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.FLEET_GITHUB_ISSUES_FIXTURE = path.join(root, 'fixtures', 'empty.json');
    process.env.FLEET_TRIAGE_ISSUES_FIXTURE = path.join(root, 'fixtures', 'empty.json');
    delete process.env.FLEET_GITHUB_PRS_FIXTURE;
    return fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

// Gather one tenant with the fixtures on and a stub runner for gh, so a test never reaches GitHub.
function gatherFor(root, runner = () => '[]') {
  return withFixtures(root, () => dormancy.gatherTenantFacts({ root, tenant: 'endzone', now: NOW, runner }));
}

// The consumed watermark the frontier wake keeps for the tenant; a missing one reads awake.
function setWatermark(root, consumedThrough) {
  writeJson(root, 'state/watchdog/frontier-wake.json', { tenants: { endzone: { outboxConsumedThrough: consumedThrough } } });
}

function setOutbox(root, lines) {
  write(root, 'state/watch/wake-outbox.jsonl', lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

// --- the pure evaluation -----------------------------------------------------------------------

test('all quiet is dormant, with no reasons to stay awake', () => {
  assert.deepEqual(dormancy.evaluateDormancy(QUIET), { dormant: true, reasons: [] });
});

for (const key of KEYS) {
  test(`${key} keeps a tenant awake, and an unreadable ${key} does too`, () => {
    const busy = dormancy.evaluateDormancy({ ...QUIET, [key]: 1 });
    assert.equal(busy.dormant, false);
    assert.equal(busy.reasons.length, 1);
    const unreadable = dormancy.evaluateDormancy({ ...QUIET, [key]: null }, { [key]: 'gh timed out' });
    assert.equal(unreadable.dormant, false);
    assert.match(unreadable.reasons[0], /unreadable: gh timed out/);
  });
}

test('a fact that is missing reads as unreadable, never as quiet', () => {
  assert.equal(dormancy.evaluateDormancy({}).dormant, false);
});

test('a ready ticket held only by a skip-file string keeps the tenant awake, with its reason (fleet #406)', () => {
  assert.deepEqual(dormancy.evaluateDormancy({ ...QUIET, legacyHolds: 1 }), { dormant: false, reasons: ['1 ready Unit(s) held by a skip-file entry with no exclusion'] });
});

// --- the gather (existing frontiers, open PRs, Work records, wake outbox) -------------------

test('the gather counts escalations and in-flight Work records of its own tenant only', () => {
  const root = tenantRoot();
  setWatermark(root, WATERMARK);
  writeJson(root, 'state/work/active.json', {
    schemaVersion: 1,
    records: {
      'endzone:issue-7': { tenant: 'endzone', state: 'escalated' },
      'endzone:issue-8': { tenant: 'endzone', state: 'implementing' },
      'endzone:issue-9': { tenant: 'endzone', state: 'merged' },
      'other:issue-3': { tenant: 'other', state: 'escalated' },
    },
  });
  const prs = [
    { number: 1, isDraft: false, headRefName: 'fleet/8-fix' },
    { number: 2, isDraft: false, headRefName: 'hotfix/3' },
  ];
  const runner = (file, args) => {
    assert.equal(file, 'gh');
    assert.deepEqual(args.slice(0, 3), ['pr', 'list', '-R']);
    return JSON.stringify(prs);
  };
  const gathered = gatherFor(root, runner);
  assert.deepEqual(gathered.errors, {});
  assert.deepEqual(gathered.facts, { frontier: 0, triage: 0, verdicts: 0, openPrs: 1, escalations: 1, inFlight: 1, wakes: 0, legacyHolds: 0 });
  assert.equal(dormancy.evaluateDormancy(gathered.facts).dormant, false);
});

test('the gather of a quiet tenant is all zeros, so the tenant is dormant', () => {
  const root = tenantRoot();
  setWatermark(root, WATERMARK);
  const gathered = gatherFor(root);
  assert.deepEqual(gathered.facts, QUIET);
  assert.equal(dormancy.evaluateDormancy(gathered.facts).dormant, true);
});

// fleet #406: a ready ticket that only a skip-file string holds has no release, so it keeps the tenant awake until an exclusion stands for it.
test('a ready ticket held by a skip-file string keeps the tenant awake until an exclusion stands for it (fleet #406)', () => {
  const root = tenantRoot();
  setWatermark(root, WATERMARK);
  writeJson(root, 'state/skip/endzone.json', { issues: { '7': 'human-only evidence' } });
  writeJson(root, 'fixtures/ready.json', [{ number: 7, title: 'Issue 7', url: 'https://github.com/owner/endzone/issues/7', body: 'Change `src/7.js`.', createdAt: '2026-09-01T00:00:07.000Z', state: 'OPEN', labels: ['ready-for-agent'], assignees: [] }]);
  const gatherReady = () => withFixtures(root, () => {
    process.env.FLEET_GITHUB_ISSUES_FIXTURE = path.join(root, 'fixtures', 'ready.json');
    return dormancy.gatherTenantFacts({ root, tenant: 'endzone', now: NOW, runner: () => '[]' });
  });
  const held = gatherReady();
  assert.deepEqual(held.errors, {});
  assert.equal(held.facts.frontier, 0);
  assert.equal(held.facts.legacyHolds, 1);
  assert.equal(dormancy.evaluateDormancy(held.facts).dormant, false);

  require('../bin/exclusions').addExclusion({ root, tenant: 'endzone', issue: 7, reason: 'lead holds it by hand', evidence: 'e', owner: 'cory', actor: 'cory', recheck: { event: { type: 'exclusion-lifted' } }, now: NOW });
  const excluded = gatherReady();
  assert.equal(excluded.facts.legacyHolds, 0);
  assert.equal(excluded.facts.frontier, 0);
});

// fleet #406 (QA): a skip-file string on a ticket that is not otherwise ready holds nothing a lead alone could release, so it is not a legacy hold.
test('a skip-file string on a ticket not otherwise ready is not a legacy hold (fleet #406)', () => {
  const root = tenantRoot();
  setWatermark(root, WATERMARK);
  writeJson(root, 'state/skip/endzone.json', { issues: { '7': 'human-only evidence', '8': 'human-only evidence' } });
  writeJson(root, 'fixtures/unready.json', [
    { number: 7, title: 'Issue 7', url: 'https://github.com/owner/endzone/issues/7', body: 'Change `src/7.js`.', createdAt: '2026-09-01T00:00:07.000Z', state: 'OPEN', labels: [], assignees: [] },
    { number: 8, title: 'Issue 8', url: 'https://github.com/owner/endzone/issues/8', body: 'Change `src/8.js`.', createdAt: '2026-09-01T00:00:08.000Z', state: 'OPEN', labels: ['ready-for-agent'], assignees: [], dependencies: [{ number: 9, state: 'OPEN' }] },
  ]);
  const gathered = withFixtures(root, () => {
    process.env.FLEET_GITHUB_ISSUES_FIXTURE = path.join(root, 'fixtures', 'unready.json');
    return dormancy.gatherTenantFacts({ root, tenant: 'endzone', now: NOW, runner: () => '[]' });
  });
  assert.deepEqual(gathered.errors, {});
  assert.equal(gathered.facts.frontier, 0);
  assert.equal(gathered.facts.legacyHolds, 0);
});

test('a tenant it cannot read gathers as unreadable facts, and stays awake', () => {
  const root = tenantRoot();
  const gathered = withFixtures(root, () => dormancy.gatherTenantFacts({ root, tenant: 'ghost', now: NOW, runner: () => '[]' }));
  assert.equal(gathered.facts.frontier, null);
  assert.ok(gathered.errors.frontier, 'the planner failure is named');
  assert.equal(dormancy.evaluateDormancy(gathered.facts, gathered.errors).dormant, false);
});

// --- the wake outbox, read the way Test-WorkWaiting reads it (bin/watchdog.ps1) --------------

const RESOLUTION = { at: '2026-11-06T11:30:00.000Z', recordId: 'endzone:issue-7', wake: 'resolution', from: 'escalated', to: 'implementing', raisedBy: 'ic-7', actor: 'cory' };

test('an unconsumed resolution keeps the tenant awake', () => {
  const root = tenantRoot();
  setWatermark(root, WATERMARK);
  setOutbox(root, [RESOLUTION]);
  const gathered = gatherFor(root);
  assert.equal(gathered.facts.wakes, 1);
  assert.equal(dormancy.evaluateDormancy(gathered.facts, gathered.errors).dormant, false);
});

test('a resolution the lead has consumed does not keep the tenant awake', () => {
  const root = tenantRoot();
  setWatermark(root, '2026-11-06T11:45:00.000Z');
  setOutbox(root, [RESOLUTION]);
  const gathered = gatherFor(root);
  assert.equal(gathered.facts.wakes, 0);
  assert.equal(dormancy.evaluateDormancy(gathered.facts, gathered.errors).dormant, true);
});

test('an unreadable outbox is awake', () => {
  const root = tenantRoot();
  setWatermark(root, WATERMARK);
  fs.mkdirSync(path.join(root, 'state', 'watch', 'wake-outbox.jsonl'), { recursive: true });   // a directory where the file belongs
  const gathered = gatherFor(root);
  assert.equal(gathered.facts.wakes, null);
  assert.ok(gathered.errors.wakes, 'the read failure is named');
  assert.equal(dormancy.evaluateDormancy(gathered.facts, gathered.errors).dormant, false);
});

test('a tenant with no consumed watermark is awake, whatever the outbox holds', () => {
  const root = tenantRoot();
  const gathered = gatherFor(root);
  assert.equal(gathered.facts.wakes, null);
  assert.equal(dormancy.evaluateDormancy(gathered.facts, gathered.errors).dormant, false);
});

// --- malformed ledgers and PR lists fail toward awake --------------------------------------

test('an active.json with no records object is unreadable, never an empty fleet', () => {
  for (const body of ['{}', 'null', '[]', '{"record":{"endzone:issue-7":{"tenant":"endzone","state":"escalated"}}}']) {
    const root = tenantRoot();
    setWatermark(root, WATERMARK);
    write(root, 'state/work/active.json', `${body}\n`);
    const gathered = gatherFor(root);
    assert.equal(gathered.facts.escalations, null, body);
    assert.equal(gathered.facts.inFlight, null, body);
    assert.equal(dormancy.evaluateDormancy(gathered.facts, gathered.errors).dormant, false, body);
  }
});

test('a Work record with no tenant counts for every tenant', () => {
  const root = tenantRoot();
  setWatermark(root, WATERMARK);
  writeJson(root, 'state/work/active.json', { schemaVersion: 1, records: { 'fleet-note-1': { state: 'escalated' } } });
  const gathered = gatherFor(root);
  assert.equal(gathered.facts.escalations, 1);
  assert.equal(dormancy.evaluateDormancy(gathered.facts, gathered.errors).dormant, false);
});

test('a full gh pr list with no fleet PR cannot prove there is none', () => {
  const root = tenantRoot();
  setWatermark(root, WATERMARK);
  const full = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, isDraft: false, headRefName: `hotfix/${index + 1}` }));
  const capped = gatherFor(root, () => JSON.stringify(full));
  assert.equal(capped.facts.openPrs, null);
  assert.match(capped.errors.openPrs, /gh pr list hit its limit; cannot prove no fleet PR/);
  full[99] = { number: 100, isDraft: false, headRefName: 'fleet/9-fix' };
  assert.equal(gatherFor(root, () => JSON.stringify(full)).facts.openPrs, 1, 'a fleet PR in a full list is counted, not refused');
});

// --- the snapshot the watchdog writes and Rotation and the Sentinel read ------------------------

function quietGather() { return { facts: { ...QUIET }, errors: {} }; }

test('writeSnapshot stamps a 25-minute validity window and records each tenant with its facts', () => {
  const root = tenantRoot();
  const snapshot = dormancy.writeSnapshot({ root, now: NOW, gather: quietGather });
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'state', 'watchdog', 'dormancy.json'), 'utf8'));
  assert.deepEqual(onDisk, snapshot);
  assert.equal(onDisk.at, NOW);
  assert.equal(onDisk.validUntil, '2026-11-06T12:25:00.000Z');
  assert.equal(onDisk.tenants.endzone.dormant, true);
  assert.deepEqual(onDisk.tenants.endzone.facts, QUIET);
});

test('dormantTenants names only a fresh, dormant tenant', () => {
  const root = tenantRoot();
  dormancy.writeSnapshot({ root, now: NOW, gather: quietGather });
  assert.deepEqual(dormancy.dormantTenants({ root, now: '2026-11-06T12:20:00.000Z' }), ['endzone']);
  assert.deepEqual(dormancy.dormantTenants({ root, now: '2026-11-06T12:26:00.000Z' }), [], 'a verdict past its window names nothing');

  dormancy.writeSnapshot({ root, now: NOW, gather: () => ({ facts: { ...QUIET, openPrs: 2 }, errors: {} }) });
  assert.deepEqual(dormancy.dormantTenants({ root, now: NOW }), [], 'an awake tenant is not dormant');

  dormancy.writeSnapshot({ root, now: NOW, gather: quietGather });
  write(root, 'state/flags/dormancy-off', 'rolled back\n');
  assert.deepEqual(dormancy.dormantTenants({ root, now: NOW }), [], 'the dormancy-off flag makes the verdict inert');

  assert.deepEqual(dormancy.dormantTenants({ root: makeTempDir('fleet-dormancy-empty-'), now: NOW }), [], 'no snapshot names nothing');
});

test('cli: snapshot refuses an unknown flag like every fleet command', async () => {
  await assert.rejects(() => dormancy.cli(['snapshot', '--roots', 'x']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /--roots/);
    return true;
  });
});
