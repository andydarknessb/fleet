'use strict';
// ADR 0011: the Principal's frontier is computed from GitHub facts, the outbox and
// the triage ledger; the ledger is append-only and typed; the projection yields the
// graduation metric. Fail closed on an unset owner, an unreadable GitHub, a typo'd flag.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const triage = require('../bin/triage');
const { selectTriageFrontier, recordEntry, projectTriage, readLedger, cli, computeFrontier, DEFAULT_CONFIG, TRIAGE_FLAGS } = triage;

const OWNER = 'cory-owner';
const FLEET = 'fleet-bot';
const NOW = '2026-09-12T12:00:00.000Z';

function rootDir({ ownerLogin = OWNER } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-triage-'));
  fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'watch'), { recursive: true });
  const tenant = { name: 'endzone', github: 'owner/repo', readyLabel: 'ready-for-agent', fleetIdentity: FLEET, escalationLabel: 'fleet-escalation' };
  if (ownerLogin) tenant.ownerLogin = ownerLogin;
  fs.writeFileSync(path.join(root, 'tenants', 'endzone.json'), JSON.stringify(tenant));
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ triage: { maxProposalsPerTurn: 2 } }));
  return root;
}

function issue(number, { labels = [], assignees = [], comments = [], body = `Body of #${number}`, createdAt = `2026-09-0${Math.min(9, number % 9 + 1)}T00:00:00.000Z`, lastEditedAt, openSubIssues = 0 } = {}) {
  return {
    number, title: `Issue ${number}`, url: `https://github.com/owner/repo/issues/${number}`, body, createdAt, lastEditedAt: lastEditedAt || createdAt,
    labels, assignees, comments, subIssues: Array.from({ length: openSubIssues }, (_, index) => ({ number: 900 + index, state: 'OPEN' })),
  };
}

function comment(author, body, createdAt, id = `${author}-${createdAt}`) {
  return { id, url: `https://github.com/owner/repo/issues/1#issuecomment-${id}`, author, body, createdAt };
}

function frontier(issues, extra = {}) {
  return selectTriageFrontier({ issues, ownerLogin: OWNER, readyLabel: 'ready-for-agent', config: { ...DEFAULT_CONFIG, maxProposalsPerTurn: 2 }, tenant: 'endzone', now: NOW, ...extra });
}

test('unrouted and triage-labelled issues are tickets; routed, spec-parent, owner-assigned and held ones are skipped, oldest first', () => {
  const held = new Map([[7, 'skip file: parked']]);
  const result = frontier([
    issue(3, { createdAt: '2026-09-03T00:00:00.000Z' }),
    issue(1, { labels: ['needs-triage'], createdAt: '2026-09-01T00:00:00.000Z' }),
    issue(2, { labels: ['question', 'bug'], createdAt: '2026-09-02T00:00:00.000Z' }),
    issue(4, { labels: ['ready-for-agent'] }),
    issue(5, { labels: ['ready-for-human', 'question'] }),
    issue(6, { labels: ['spec'] }),
    issue(7, { labels: ['bug'] }),
    issue(8, { assignees: [OWNER] }),
    issue(9, { openSubIssues: 2 }),
    issue(10, { labels: ['bug', 'enhancement'], createdAt: '2026-09-10T00:00:00.000Z' }),
  ], { held });
  assert.deepEqual(result.eligible.map((entry) => entry.number), [1, 2, 3, 10]);
  assert.ok(result.eligible.every((entry) => entry.kind === 'ticket'));
  assert.equal(result.eligible[0].reason, 'labelled needs-triage');
  assert.equal(result.eligible[2].reason, 'unrouted');
  assert.deepEqual(result.proposeNow, [1, 2], 'the per-turn cap comes from config');
  const skippedReasons = Object.fromEntries(result.skipped.map((entry) => [entry.number, entry.reason]));
  assert.match(skippedReasons[4], /routed/);
  assert.match(skippedReasons[5], /routed/);
  assert.match(skippedReasons[6], /routed/);
  assert.match(skippedReasons[7], /held/);
  assert.match(skippedReasons[8], /assigned to the owner/);
  assert.match(skippedReasons[9], /spec parent/);
  assert.equal(result.counts.tickets, 4);
});

// fleet#55: every fleet session posts under the tenant's ownerLogin, so "the owner has
// the newest comment" was true of every fleet comment and could not mean "Cory is in
// conversation". Two companion tickets left the frontier on the strength of the lead's
// own cross-link comments, with no releasing event. Authorship never decides; structure
// does: an Approval and a re-proposal ask are comments no fleet role may write (the
// guard hook refuses both), so they are the owner's by construction.
test('fleet#55: a newest comment under the owner login keeps the issue on the frontier; nothing infers a conversation from authorship', () => {
  const crossLinked = frontier([issue(1298, { labels: ['needs-triage'], comments: [comment(OWNER, 'Companion: #1299.', '2026-09-12T17:01:05.000Z')] })]);
  assert.equal(crossLinked.eligible.length, 1);
  assert.deepEqual(crossLinked.skipped, []);
  const replied = frontier([issue(2, { labels: ['question'], comments: [comment('someone', 'why?', '2026-09-02T00:00:00.000Z'), comment(OWNER, 'because', '2026-09-03T00:00:00.000Z')] })]);
  assert.equal(replied.eligible.length, 1, 'a reply under the owner login is not a reason to drop a triage item');
  assert.ok(!JSON.stringify(replied.skipped).includes('conversation'));
});

test('fleet#55: a re-proposal ask is a comment that BEGINS "Re-propose"; the word mid-body from the owner login is not one', () => {
  const root = rootDir();
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 3, bodyHash: triage.normalizeIssue(issue(3)).bodyHash, commentUrl: 'https://github.com/owner/repo/issues/3#issuecomment-1', model: 'fable', now: '2026-09-10T00:00:00.000Z' });
  const entries = readLedger(root, 'endzone');
  const midBody = frontier([issue(3, { labels: ['needs-triage', 'triage-proposed'], comments: [comment(OWNER, 'The lead will re-propose the scope on #4 once #3 lands.', '2026-09-11T00:00:00.000Z')] })], { entries });
  assert.equal(midBody.eligible.length, 0);
  assert.match(midBody.skipped[0].reason, /awaiting approval/);
  const asked = frontier([issue(3, { labels: ['needs-triage', 'triage-proposed'], comments: [comment(OWNER, 'Re-propose: the caption is out of scope now.', '2026-09-11T00:00:00.000Z')] })], { entries });
  assert.equal(asked.eligible.length, 1);
  assert.equal(asked.eligible[0].kind, 'reproposal');
  assert.match(asked.eligible[0].reason, /asked for a new proposal/);
  const other = frontier([issue(3, { labels: ['needs-triage', 'triage-proposed'], comments: [comment('someone', 'Re-propose please', '2026-09-11T00:00:00.000Z')] })], { entries });
  assert.equal(other.eligible.length, 0, 'an ask from another account is not the owner\'s');
});

test('the marker waits unless the body changed or the owner asks again; a marker with no ledger record is left alone', () => {
  const root = rootDir();
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 1, bodyHash: 'hash-a', commentUrl: 'https://x/1', model: 'fable', now: '2026-09-10T00:00:00.000Z' });
  const entries = readLedger(root, 'endzone');
  const waiting = frontier([{ ...issue(1, { labels: ['needs-triage', 'triage-proposed'] }), bodyHash: 'hash-a' }], { entries });
  assert.equal(waiting.eligible.length, 0);
  assert.match(waiting.skipped[0].reason, /awaiting approval/);
  const changed = frontier([{ ...issue(1, { labels: ['needs-triage', 'triage-proposed'] }), bodyHash: 'hash-b' }], { entries });
  assert.equal(changed.eligible[0].kind, 'reproposal');
  assert.match(changed.eligible[0].reason, /body changed/);
  const asked = frontier([{ ...issue(1, { labels: ['triage-proposed'], comments: [comment(OWNER, 'Re-propose with the new constraint.', '2026-09-11T00:00:00.000Z')] }), bodyHash: 'hash-a' }], { entries });
  assert.equal(asked.eligible[0].kind, 'reproposal');
  assert.match(asked.eligible[0].reason, /owner asked/);
  const orphan = frontier([issue(2, { labels: ['triage-proposed'] })], { entries });
  assert.equal(orphan.eligible.length, 0);
  assert.match(orphan.skipped[0].reason, /no ledger record/);
});

test('an Approved comment from the owner after the proposal is an approval; the same word from the fleet identity or before the proposal is not', () => {
  const root = rootDir();
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 1, bodyHash: 'hash-a', commentUrl: 'https://x/1', model: 'fable', now: '2026-09-10T00:00:00.000Z' });
  const entries = readLedger(root, 'endzone');
  const base = { labels: ['triage-proposed'] };
  const byFleet = frontier([{ ...issue(1, { ...base, comments: [comment(FLEET, 'Approved', '2026-09-11T00:00:00.000Z')] }), bodyHash: 'hash-a' }], { entries });
  assert.equal(byFleet.counts.approvals, 0, 'the fleet identity cannot approve');
  const early = frontier([{ ...issue(1, { ...base, comments: [comment(OWNER, 'Approved', '2026-09-09T00:00:00.000Z')] }), bodyHash: 'hash-a' }], { entries });
  assert.equal(early.counts.approvals, 0, 'an approval older than the proposal does not count');
  const chatter = frontier([{ ...issue(1, { ...base, comments: [comment(OWNER, 'Not approved, rethink the scope', '2026-09-11T00:00:00.000Z')] }), bodyHash: 'hash-a' }], { entries });
  assert.equal(chatter.counts.approvals, 0, 'a reply that is not Approved is a conversation');
  const approved = frontier([{ ...issue(1, { ...base, comments: [comment(OWNER, 'Approved', '2026-09-11T00:00:00.000Z')] }), bodyHash: 'hash-a' }], { entries });
  assert.equal(approved.eligible[0].kind, 'approval');
  assert.equal(approved.eligible[0].withEdits, false);
  const edits = frontier([{ ...issue(1, { ...base, comments: [comment(OWNER, 'Approved with: tier sonnet, blocked_by #99', '2026-09-11T00:00:00.000Z')] }), bodyHash: 'hash-a' }], { entries });
  assert.equal(edits.eligible[0].withEdits, true);
  assert.equal(edits.eligible[0].by, OWNER);
});

test('decision-needed wakes are escalations only when newer than the consumed marker, newest per record, ordered after approvals and before tickets', () => {
  const root = rootDir();
  recordEntry({ root, tenant: 'endzone', kind: 'consumed', through: '2026-09-05T00:00:00.000Z', now: '2026-09-05T00:00:01.000Z' });
  const entries = readLedger(root, 'endzone');
  const outbox = [
    { at: '2026-09-04T00:00:00.000Z', recordId: 'endzone:issue-601', wake: 'decision-needed', evidence: 'old' },
    { at: '2026-09-06T00:00:00.000Z', recordId: 'endzone:issue-602', wake: 'decision-needed', evidence: 'first' },
    { at: '2026-09-07T00:00:00.000Z', recordId: 'endzone:issue-602', wake: 'decision-needed', evidence: 'second' },
    { at: '2026-09-08T00:00:00.000Z', recordId: 'endzone:issue-603', wake: 'checks-settled', evidence: 'not a decision' },
    { at: '2026-09-08T00:00:00.000Z', recordId: 'other:issue-1', wake: 'decision-needed', evidence: 'another tenant' },
  ];
  const open602 = issue(602, { labels: ['ready-for-agent'], body: 'Body of #602 with a trailing newline\n' });
  const result = frontier([issue(1), open602], { entries, outbox });
  assert.deepEqual(result.eligible.map((entry) => entry.kind), ['escalation', 'ticket']);
  assert.equal(result.eligible[0].number, 602);
  assert.equal(result.eligible[0].evidence, 'second');
  // fleet#48: the escalation carries the issue's own hash, title and url; the
  // Principal copies bodyHash, never computes it. Absent issue: nulls, not undefined.
  assert.equal(result.eligible[0].bodyHash, triage.normalizeIssue(open602).bodyHash);
  assert.equal(result.eligible[0].title, 'Issue 602');
  assert.equal(result.eligible[0].url, 'https://github.com/owner/repo/issues/602');
  const absent = frontier([issue(1)], { entries, outbox }).eligible[0];
  assert.deepEqual([absent.bodyHash, absent.title, absent.url], [null, null, null]);
  assert.equal(result.consumedThrough, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(result.proposeNow, [1], 'escalations do not spend the proposal cap');
});

test('the ledger is typed: proposals need hash, comment and model; outcomes need a proposal and are recorded once; finalizing needs an approval', () => {
  const root = rootDir();
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'ruled', issue: 1 }), { code: 'TRIAGE_INVALID' });
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 1, bodyHash: 'h', model: 'fable' }), { code: 'TRIAGE_INVALID' });
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 1, by: OWNER }), { code: 'TRIAGE_NO_PROPOSAL' });
  assert.equal(fs.existsSync(triage.ledgerPath(root, 'endzone')), false, 'a refused record writes nothing');
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 1, bodyHash: 'h', commentUrl: 'u', model: 'fable', now: '2026-09-10T00:00:00.000Z' });
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 1, bodyHash: 'h2', commentUrl: 'u2', model: 'fable', now: '2026-09-10T01:00:00.000Z' }), { code: 'TRIAGE_PROPOSAL_OPEN' });
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'finalized', issue: 1, labels: 'ready-for-agent', now: '2026-09-10T01:00:00.000Z' }), { code: 'TRIAGE_NOT_APPROVED' });
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'approved-with-edits', issue: 1, by: OWNER, now: '2026-09-10T02:00:00.000Z' }), { code: 'TRIAGE_INVALID' });
  recordEntry({ root, tenant: 'endzone', kind: 'approved-with-edits', issue: 1, by: OWNER, edits: 'tier sonnet', now: '2026-09-10T02:00:00.000Z' });
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'rejected', issue: 1, by: OWNER, now: '2026-09-10T03:00:00.000Z' }), { code: "TRIAGE_ALREADY_DECIDED" });
  const finalized = recordEntry({ root, tenant: 'endzone', kind: 'finalized', issue: 1, labels: 'ready-for-agent', prUrl: 'https://github.com/owner/repo/pull/9', now: '2026-09-10T04:00:00.000Z' });
  assert.deepEqual(finalized.labels, ['ready-for-agent']);
  // fleet#49: a finalize that opened a docs PR names it, and the projection lists it for Cory's merge.
  assert.equal(finalized.prUrl, 'https://github.com/owner/repo/pull/9');
  assert.deepEqual(projectTriage({ entries: readLedger(root, 'endzone'), now: '2026-09-11T00:00:00.000Z' }).docsPrs, [{ issue: 1, prUrl: 'https://github.com/owner/repo/pull/9', since: '2026-09-10T04:00:00.000Z' }]);
  assert.deepEqual(projectTriage({ entries: readLedger(root, 'endzone'), now: '2026-10-11T00:00:00.000Z' }).docsPrs, [], 'outside the window it leaves the digest');
  // A superseded proposal reopens the issue for a new proposal.
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 2, bodyHash: 'h', commentUrl: 'u', model: 'fable', now: '2026-09-10T05:00:00.000Z' });
  recordEntry({ root, tenant: 'endzone', kind: 'superseded', issue: 2, bodyHash: 'h3', now: '2026-09-10T06:00:00.000Z' });
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 2, bodyHash: 'h3', commentUrl: 'u3', model: 'fable', now: '2026-09-10T07:00:00.000Z' });
  assert.equal(readLedger(root, 'endzone').length, 6);
});

test('the projection reports pending, awaiting-finalize, the window ratio and the graduation gate', () => {
  const entries = [];
  let tick = 0;
  const at = (day, hour = 0) => new Date(Date.UTC(2026, 7, day, hour, 0, 0, tick += 1)).toISOString();
  for (let issueNumber = 1; issueNumber <= 32; issueNumber += 1) {
    entries.push({ kind: 'proposed', issue: issueNumber, at: at(1 + (issueNumber % 20)), bodyHash: 'h', commentUrl: 'u', model: 'fable' });
    if (issueNumber <= 29) entries.push({ kind: 'approved', issue: issueNumber, at: at(1 + (issueNumber % 20), 1), by: OWNER });
    else if (issueNumber === 30) entries.push({ kind: 'approved-with-edits', issue: issueNumber, at: at(25, 1), by: OWNER, edits: 'x' });
    else if (issueNumber === 31) entries.push({ kind: 'rejected', issue: issueNumber, at: at(25, 2), by: OWNER });
    // 32 stays pending
  }
  entries.push({ kind: 'finalized', issue: 1, at: at(26), labels: ['ready-for-agent'] });
  entries.push({ kind: 'consumed', through: '2026-08-20T00:00:00.000Z', at: at(20) });
  const projection = projectTriage({ entries, now: '2026-08-30T00:00:00.000Z', windowDays: 14 });
  assert.deepEqual(projection.pending.map((row) => row.issue), [32]);
  assert.equal(projection.awaitingFinalize.length, 29, 'approved but not finalized, minus the one finalized');
  assert.equal(projection.allTime.decided, 31);
  assert.equal(projection.allTime.unchanged, 29);
  assert.equal(projection.allTime.unchangedRatio, Number((29 / 31).toFixed(3)));
  assert.equal(projection.graduation.met, true, '31 decided over 29 days at 93.5%');
  assert.equal(projection.consumedThrough, '2026-08-20T00:00:00.000Z');
  assert.ok(projection.window.decided < projection.allTime.decided, 'the window is narrower than all time');
  const notYet = projectTriage({ entries: entries.slice(0, 10), now: '2026-08-30T00:00:00.000Z' });
  assert.equal(notYet.graduation.met, false);
});

test('computeFrontier fails closed on an unset owner login and on an unreadable GitHub; a fixture stands in for GitHub', () => {
  const noOwner = rootDir({ ownerLogin: '' });
  assert.throws(() => computeFrontier({ root: noOwner, tenant: 'endzone', fixture: writeFixture(noOwner, [issue(1)]), now: NOW }), { code: 'TENANT_OWNER_UNSET' });
  const root = rootDir();
  assert.throws(() => computeFrontier({ root, tenant: 'endzone', now: NOW, runner: () => { const error = new Error('gh: rate limited'); error.stderr = 'API rate limit exceeded'; throw error; } }), { code: 'GITHUB_QUERY_FAILED' });
  const result = computeFrontier({ root, tenant: 'endzone', fixture: writeFixture(root, [issue(1), issue(2, { labels: ['ready-for-agent'] })]), now: NOW });
  assert.equal(result.source, 'fixture');
  assert.deepEqual(result.eligible.map((entry) => entry.number), [1]);
  assert.equal(result.ownerLogin, OWNER);
  assert.equal(result.cap, 2);
});

test('the frontier reads the skip file and active exclusions as held', () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'state', 'skip'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'skip', 'endzone.json'), JSON.stringify({ issues: { 2: 'parked for Cory' }, prs: {} }));
  const result = computeFrontier({ root, tenant: 'endzone', fixture: writeFixture(root, [issue(1), issue(2)]), now: NOW });
  assert.deepEqual(result.eligible.map((entry) => entry.number), [1]);
  assert.match(result.skipped.find((entry) => entry.number === 2).reason, /skip file/);
});

test('the CLI refuses an unknown flag with exit 2 and a missing tenant as usage; a GitHub failure exits 1 with its code', () => {
  const root = rootDir();
  const bin = path.join(__dirname, '..', 'bin', 'triage.js');
  const run = (args) => {
    try { return { status: 0, stdout: execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (error) { return { status: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }; }
  };
  const typo = run(['frontier', '--root', root, '--tenant', 'endzone', '--fixtrue', 'x.json']);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown flag --fixtrue/);
  const noTenant = run(['state', '--root', root]);
  assert.equal(noTenant.status, 1);
  assert.match(noTenant.stderr, /--tenant is required/);
  const unknownCommand = run(['propose']);
  assert.equal(unknownCommand.status, 2);
  const fixture = writeFixture(root, [issue(1, { labels: ['needs-triage'] })]);
  const ok = run(['frontier', '--root', root, '--tenant', 'endzone', '--fixture', fixture, '--now', NOW]);
  assert.equal(ok.status, 0);
  const parsed = JSON.parse(ok.stdout.trim().split('\n').pop());
  assert.deepEqual(parsed.proposeNow, [1]);
  const recorded = run(['record', '--root', root, '--tenant', 'endzone', '--kind', 'proposed', '--issue', '1', '--body-hash', parsed.eligible[0].bodyHash, '--comment-url', 'https://x/1', '--model', 'fable', '--now', NOW]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const state = JSON.parse(run(['state', '--root', root, '--tenant', 'endzone', '--now', NOW]).stdout.trim());
  assert.deepEqual(state.pending.map((row) => row.issue), [1]);
  assert.equal('byIssue' in state, false, 'the state command prints the summary, not the per-issue fold');
  assert.deepEqual(Object.keys(TRIAGE_FLAGS).slice(0, 5), ['frontier', 'record', 'state', 'hash', 'finalize']);
  for (const door of ['bounded-ready', 'veto', 'bounded-scan']) assert.ok(door in TRIAGE_FLAGS, door);   // #210, #211
  assert.equal(typeof cli, 'function');
});

function writeFixture(root, issues) {
  const file = path.join(root, `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(issues));
  return file;
}

// Spec fleet #92 / #143: the frontier counts the open ready tickets whose body
// carries no `## Premises` section (and names malformed ones); the watchdog's
// shadow file carries the census to the digest.
test('#143: the frontier carries a premises census of the open ready tickets', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const result = frontier([
    issue(21, { labels: ['ready-for-agent'], body: 'No section here.' }),
    issue(22, { labels: ['ready-for-agent'], body: `## Premises\n\nsrc/a.js: exports a @${sha}\n` }),
    issue(23, { labels: ['ready-for-agent'], body: '## Premises\n\nnone\n' }),
    issue(24, { labels: ['ready-for-agent'], body: '## Premises\n\nhalf a premise\n' }),
    issue(25, { labels: ['needs-triage'], body: 'Not ready, not counted.' }),
  ]);
  assert.deepEqual(result.premises, { readyLabel: 'ready-for-agent', ready: 4, missing: [21], malformed: [24] });
});

// Spec fleet #92 / #145: the Principal stamps the sha it verified the premises at;
// a finalize that restates a false premise edits the body, and the ledger records
// the restated body's hash beside the proposal's.
test('#145: record --kind proposed --premises-sha stores premisesSha and refuses a malformed sha', () => {
  const root = rootDir();
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const base = { root, tenant: 'endzone', kind: 'proposed', bodyHash: 'hash-a', commentUrl: 'https://x/1', model: 'fable', now: '2026-09-24T00:00:00.000Z' };
  assert.throws(() => recordEntry({ ...base, issue: 1, premisesSha: 'abc12' }), (error) => error.code === 'TRIAGE_INVALID' && /premises-sha/.test(error.message));
  assert.throws(() => recordEntry({ ...base, issue: 1, premisesSha: 'not-a-sha' }), { code: 'TRIAGE_INVALID' });
  assert.equal(recordEntry({ ...base, issue: 1, premisesSha: sha.toUpperCase() }).premisesSha, sha);
  assert.equal(recordEntry({ ...base, issue: 2 }).premisesSha, undefined);
  assert.ok(TRIAGE_FLAGS.record.includes('premises-sha'));
  const viaCli = cli(['record', '--root', root, '--tenant', 'endzone', '--kind', 'proposed', '--issue', '3', '--body-hash', 'hash-c', '--comment-url', 'https://x/3', '--model', 'fable', '--premises-sha', sha.slice(0, 7), '--now', '2026-09-24T00:00:00.000Z']);
  assert.equal(viaCli.premisesSha, sha.slice(0, 7));
});

test('#145: a finalize that edits the body records the new hash; state shows both hashes and nothing is re-proposed', () => {
  const root = rootDir();
  const proposedBody = '## Premises\n\nsrc/a.js: exports a @abcdef1\n';
  const restatedBody = '## Premises\n\nsrc/a.js: exports b @1234567\n';
  const proposedHash = triage.normalizeIssue(issue(5, { body: proposedBody })).bodyHash;
  const restatedHash = triage.normalizeIssue(issue(5, { body: restatedBody })).bodyHash;
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 5, bodyHash: proposedHash, commentUrl: 'https://x/5', model: 'fable', premisesSha: '1234567', now: '2026-09-24T00:00:00.000Z' });
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 5, by: OWNER, now: '2026-09-24T01:00:00.000Z' });
  const finalized = cli(['record', '--root', root, '--tenant', 'endzone', '--kind', 'finalized', '--issue', '5', '--labels', 'ready-for-agent', '--body-hash', restatedHash, '--now', '2026-09-24T02:00:00.000Z']);
  assert.equal(finalized.bodyHash, restatedHash);
  const state = cli(['state', '--root', root, '--tenant', 'endzone', '--now', '2026-09-24T03:00:00.000Z']);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.awaitingFinalize, []);
  assert.deepEqual(state.restated, [{ issue: 5, proposedBodyHash: proposedHash, finalizedBodyHash: restatedHash, finalizedAt: '2026-09-24T02:00:00.000Z' }]);
  const entries = readLedger(root, 'endzone');
  // Marker not yet removed, and after the ready label lands: neither is a re-proposal.
  for (const labels of [['triage-proposed'], ['ready-for-agent']]) {
    const result = frontier([issue(5, { body: restatedBody, labels })], { entries, now: '2026-09-24T03:00:00.000Z' });
    assert.deepEqual(result.eligible, [], `labels ${labels}`);
  }
});

test('#145: hash prints the live body hash exactly as the frontier computes it', () => {
  const root = rootDir();
  const fixture = path.join(root, 'issues.json');
  const body = '## Premises' + String.fromCharCode(10) + 'none';
  fs.writeFileSync(fixture, JSON.stringify([issue(5, { body })]));
  const hashed = cli(['hash', '--root', root, '--tenant', 'endzone', '--issue', '5', '--fixture', fixture]);
  assert.equal(hashed.bodyHash, triage.normalizeIssue(issue(5, { body })).bodyHash);
  const viaGh = triage.issueBodyHash({ root, tenant: 'endzone', issue: 5, runner: (exe, args) => { assert.deepEqual(args.slice(0, 5), ['issue', 'view', '5', '-R', 'owner/repo']); return JSON.stringify({ body }); } });
  assert.equal(viaGh.bodyHash, hashed.bodyHash);
});

// Spec fleet #92 / #148: a stale-premise restatement is logged with Cory's verdict
// for a month, and a dated notice asks for the ruling on evidence.
const STALE_LINE = 'src/lib/b.js: exports 2 @0123456';

test('#148: record --kind proposed --reason stale-premise --premise stores both; any other reason is refused', () => {
  const root = rootDir();
  const base = { root, tenant: 'endzone', kind: 'proposed', bodyHash: 'hash-a', commentUrl: 'https://x/1', model: 'fable', now: '2026-09-24T00:00:00.000Z' };
  assert.throws(() => recordEntry({ ...base, issue: 1, reason: 'drift', premise: STALE_LINE }), (error) => error.code === 'TRIAGE_INVALID' && /stale-premise/.test(error.message));
  assert.throws(() => recordEntry({ ...base, issue: 1, reason: 'stale-premise' }), (error) => error.code === 'TRIAGE_INVALID' && /--premise/.test(error.message));
  assert.throws(() => recordEntry({ ...base, issue: 1, premise: STALE_LINE }), (error) => error.code === 'TRIAGE_INVALID' && /--reason/.test(error.message));
  const entry = cli(['record', '--root', root, '--tenant', 'endzone', '--kind', 'proposed', '--issue', '1', '--body-hash', 'hash-a', '--comment-url', 'https://x/1', '--model', 'fable', '--reason', 'stale-premise', '--premise', STALE_LINE, '--now', '2026-09-24T00:00:00.000Z']);
  assert.equal(entry.reason, 'stale-premise');
  assert.equal(entry.premise, STALE_LINE);
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 1, by: OWNER, reason: 'stale-premise', premise: STALE_LINE }), { code: 'TRIAGE_INVALID' });
});

test('#148: the projection lists 30 days of stale-premise restatements with verdict and age, counted by verdict', () => {
  const root = rootDir();
  const propose = (issue, at, extra = {}) => recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue, bodyHash: `h${issue}`, commentUrl: `https://x/${issue}`, model: 'fable', reason: 'stale-premise', premise: `${STALE_LINE} #${issue}`, now: at, ...extra });
  propose(1, '2026-08-01T00:00:00.000Z');   // outside the window
  propose(2, '2026-09-20T00:00:00.000Z');
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 2, by: OWNER, now: '2026-09-21T00:00:00.000Z' });
  propose(3, '2026-09-22T00:00:00.000Z');
  recordEntry({ root, tenant: 'endzone', kind: 'rejected', issue: 3, by: OWNER, now: '2026-09-22T12:00:00.000Z' });
  propose(4, '2026-09-23T12:00:00.000Z');
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 5, bodyHash: 'h5', commentUrl: 'https://x/5', model: 'fable', now: '2026-09-23T00:00:00.000Z' });   // not stale-premise
  const fold = projectTriage({ entries: readLedger(root, 'endzone'), now: '2026-09-24T00:00:00.000Z' });
  assert.deepEqual(fold.stalePremise.rows, [
    { issue: 2, premise: `${STALE_LINE} #2`, proposedAt: '2026-09-20T00:00:00.000Z', verdict: 'approved', ageDays: 4 },
    { issue: 3, premise: `${STALE_LINE} #3`, proposedAt: '2026-09-22T00:00:00.000Z', verdict: 'rejected', ageDays: 2 },
    { issue: 4, premise: `${STALE_LINE} #4`, proposedAt: '2026-09-23T12:00:00.000Z', verdict: 'pending', ageDays: 0.5 },
  ]);
  assert.deepEqual(fold.stalePremise.counts, { approved: 1, 'approved-with-edits': 0, rejected: 1, superseded: 0, pending: 1 });
});

test('#148: the dated notice arms on the first stale-premise entry, pages once at 30 days with the tally, and never twice', () => {
  const root = rootDir();
  const noticeFile = path.join(root, 'state', 'triage', 'stale-premise-notice.json');
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 7, bodyHash: 'h7', commentUrl: 'https://x/7', model: 'fable', now: '2026-09-24T00:00:00.000Z' });
  assert.equal(fs.existsSync(noticeFile), false, 'an ordinary proposal arms nothing');
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 8, bodyHash: 'h8', commentUrl: 'https://x/8', model: 'fable', reason: 'stale-premise', premise: STALE_LINE, now: '2026-09-25T00:00:00.000Z' });
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 8, by: OWNER, now: '2026-09-25T02:00:00.000Z' });
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 9, bodyHash: 'h9', commentUrl: 'https://x/9', model: 'fable', reason: 'stale-premise', premise: STALE_LINE, now: '2026-10-01T00:00:00.000Z' });
  const armed = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
  assert.equal(armed.armedAt, '2026-09-25T00:00:00.000Z', 'armed by the first stale-premise entry, not re-armed by the second');
  assert.equal(armed.dueAt, '2026-10-25T00:00:00.000Z');

  const sent = [];
  const send = (message) => { sent.push(message); return { ok: true }; };
  assert.deepEqual(triage.runStalePremiseNotice({ root, now: '2026-10-24T23:59:00.000Z', send }).due, false);
  const failing = triage.runStalePremiseNotice({ root, now: '2026-10-25T08:00:00.000Z', send: () => ({ ok: false, detail: 'down' }) });
  assert.equal(failing.sent, false, 'a failed send is not a page: it stays armed');
  const fired = triage.runStalePremiseNotice({ root, now: '2026-10-26T08:00:00.000Z', send });
  assert.equal(fired.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'dated');
  assert.equal(sent[0].priority, 'normal');
  assert.match(sent[0].body, /rule whether stale-premise restatements may skip Approval/);
  assert.match(sent[0].body, /2 stale-premise restatement\(s\) since 2026-09-25: 1 approved, 0 approved with edits, 0 rejected, 1 pending/);
  const replay = triage.runStalePremiseNotice({ root, now: '2026-10-27T08:00:00.000Z', send });
  assert.equal(replay.sent, false);
  assert.equal(replay.firedAt, '2026-10-26T08:00:00.000Z');
  assert.equal(sent.length, 1, 'a replay never pages twice');
});

// #154 (ADR 0015): with distinct logins the owner-comment rules rest on authorship.
test('#154: a newest comment by the fleet does not skip the issue; one by the owner does', () => {
  const byFleet = frontier([issue(1400, { labels: ['needs-triage'], comments: [comment(FLEET, 'Companion: #1401.', '2026-09-12T10:00:00.000Z')] })], { fleetIdentity: FLEET });
  assert.equal(byFleet.eligible.length, 1, 'a fleet cross-link must not drop a freshly filed issue (fleet #55 root cause)');
  const byOwner = frontier([issue(1402, { labels: ['needs-triage'], comments: [comment(FLEET, 'Companion: #1403.', '2026-09-12T09:00:00.000Z'), comment(OWNER, 'I will take this one.', '2026-09-12T10:00:00.000Z')] })], { fleetIdentity: FLEET });
  assert.equal(byOwner.eligible.length, 0);
  assert.match(byOwner.skipped[0].reason, /owner has the newest comment/);
});

test('#154: a fleet comment matching the re-propose pattern is not the owner asking again', () => {
  const root = rootDir();
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 1404, bodyHash: triage.normalizeIssue(issue(1404)).bodyHash, commentUrl: 'https://github.com/owner/repo/issues/1404#issuecomment-1', model: 'fable', now: '2026-09-10T00:00:00.000Z' });
  const entries = readLedger(root, 'endzone');
  const fleetAsk = frontier([issue(1404, { labels: ['needs-triage', 'triage-proposed'], comments: [comment(FLEET, 'Re-propose: scope moved.', '2026-09-11T00:00:00.000Z')] })], { entries, fleetIdentity: FLEET });
  assert.equal(fleetAsk.eligible.length, 0);
  assert.match(fleetAsk.skipped[0].reason, /awaiting approval/);
  const ownerAsk = frontier([issue(1404, { labels: ['needs-triage', 'triage-proposed'], comments: [comment(OWNER, 'Re-propose: scope moved.', '2026-09-11T00:00:00.000Z')] })], { entries, fleetIdentity: FLEET });
  assert.equal(ownerAsk.eligible[0].kind, 'reproposal');
});

test('#154: the triage loader refuses a tenant whose fleetIdentity is its ownerLogin', () => {
  const root = rootDir({ ownerLogin: FLEET });
  assert.throws(() => triage.computeFrontier({ root, tenant: 'endzone', fixture: writeFixture(root, []), now: NOW }), { code: 'TENANT_IDENTITY_NOT_DISTINCT' });
});

// #207 (spec #193, scope ruled 2026-09-29 after QA): an exact `Approved` from the owner
// finalizes by script ONLY a self-contained proposal. Every clause that fails leaves the
// issue to the Principal, named in `left`. Anything qualified is an approval WITH edits.
const PROPOSAL = [
  '## Triage proposal (advisory)',
  'Classification: bug',
  'Root cause: the list drops the last row (src/list.js:12).',
  'Ruling: none needed',
  'Red-tell: tests/list.test.js "keeps the last row" is red today',
  'Repro: none',
  'Scope: lists exactly src/list.js and tests/list.test.js',
  'Premises:',
  '  src/list.js: slices one short @abcdef1 verified @abcdef2',
  'Blocked_by: none',
  'Tier: sonnet',
  'Precedent: none',
  'Open for Cory: none',
].join('\n');
const BODY = 'Body of #40\n\n## Premises\n\nsrc/list.js: slices one short @abcdef1\n';
const PROPOSED_AT = '2026-09-10T00:00:00.000Z';
const APPROVED_AT = '2026-09-11T00:00:00.000Z';
const proposalUrl = (n) => `https://github.com/owner/repo/issues/${n}#issuecomment-proposal-${n}`;
const approvalUrl = (n) => `https://github.com/owner/repo/issues/${n}#issuecomment-approval-${n}`;

// The proposal-and-approval thread of issue `number`, as GitHub would show it.
function thread(number, { approval = 'Approved', proposal = PROPOSAL, proposalEditedAt, approvalEditedAt, extraComments = [] } = {}) {
  const comments = [{ id: `proposal-${number}`, url: proposalUrl(number), author: FLEET, body: proposal, createdAt: PROPOSED_AT, lastEditedAt: proposalEditedAt }];
  if (approval !== null) comments.push({ id: `approval-${number}`, url: approvalUrl(number), author: OWNER, body: approval, createdAt: APPROVED_AT, lastEditedAt: approvalEditedAt });
  return [...comments, ...extraComments];
}

// Open proposals on issues `numbers` (default #40); per-issue options via `each(number)`.
function finalizeWorld({ numbers = [40], each = () => ({}), history, afterPropose, outbox, recordId } = {}) {
  const root = rootDir();
  if (history) history(root);
  const issues = numbers.map((number) => {
    const options = each(number);
    const body = options.body || BODY;
    recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: number, bodyHash: triage.normalizeIssue(issue(number, { body: options.proposedBody || body })).bodyHash, commentUrl: proposalUrl(number), model: 'fable', recordId: options.recordId || recordId, now: PROPOSED_AT });
    return issue(number, { body, labels: options.labels || ['needs-triage', 'triage-proposed'], comments: options.comments || thread(number, options.thread) });
  });
  if (afterPropose) afterPropose(root);
  const fixture = writeFixture(root, issues);
  if (outbox) fs.writeFileSync(path.join(root, 'state', 'watch', 'wake-outbox.jsonl'), `${outbox.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const read = () => JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const fixtureIssue = (number = numbers[0]) => read().find((entry) => entry.number === number);
  const finalize = (extra = {}) => triage.finalizeApprovals({ root, tenant: 'endzone', fixture, now: NOW, ...extra });
  return { root, fixture, fixtureIssue, finalize, ledger: () => readLedger(root, 'endzone') };
}

const rulingsOn = (fixtureIssue) => fixtureIssue.comments.filter((c) => /^## Ruling/.test(c.body));

test('#207: an eligible exact Approved is claimed, ruled, labelled and finalized', () => {
  const world = finalizeWorld({ each: () => ({ thread: { approval: '  Approved \n' } }) });
  const result = world.finalize();
  assert.deepEqual(result.finalized.map((row) => row.issue), [40]);
  assert.deepEqual(result.left, []);
  const after = world.fixtureIssue();
  assert.equal(rulingsOn(after).length, 1);
  const ruling = rulingsOn(after)[0].body;
  assert.equal(ruling, `## Ruling\nApproved without edits: ${approvalUrl(40)}. Finalized by script (fleet #207).\n\n${PROPOSAL.split('\n').slice(1).join('\n')}\n\nLabels: ready-for-agent, bug; triage-proposed removed.`);
  assert.deepEqual([...after.labels].sort(), ['bug', 'needs-triage', 'ready-for-agent']);
  const ledger = world.ledger();
  assert.deepEqual(ledger.slice(1).map((row) => [row.kind, row.actor]), [['approved', 'finalize-script'], ['finalized', 'finalize-script']]);
  assert.equal(ledger[1].by, OWNER);
  assert.equal(ledger[1].commentUrl, approvalUrl(40));
  assert.deepEqual(ledger[2].labels, ['ready-for-agent', 'bug']);
  assert.equal(ledger[2].bodyHash, undefined, 'the script never edits a body, so it records no body hash');
  assert.equal(projectTriage({ entries: ledger, now: NOW }).allTime.unchanged, 1);
  assert.deepEqual(computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: NOW }).eligible, [], 'no Principal is woken for it');
  // A replay changes nothing: no second Ruling, no second ledger row.
  assert.deepEqual(world.finalize().finalized, []);
  assert.equal(rulingsOn(world.fixtureIssue()).length, 1);
  assert.equal(world.ledger().length, 3);
  // A feature is readied without the bug label.
  const feature = finalizeWorld({ each: () => ({ thread: { proposal: PROPOSAL.replace('Classification: bug', 'Classification: feature') } }) });
  feature.finalize();
  assert.deepEqual([...feature.fixtureIssue().labels].sort(), ['needs-triage', 'ready-for-agent']);
  assert.match(rulingsOn(feature.fixtureIssue())[0].body, /\nLabels: ready-for-agent; triage-proposed removed\.$/);
});

test('#207: a qualified approval is an approval with edits: the script leaves it and the frontier still shows it to the Principal', () => {
  for (const body of ['Approved with: tier sonnet', 'Approved, but skip the second premise', 'Approved. Also ping me first.', 'Approved!', 'Approved with']) {
    const world = finalizeWorld({ each: () => ({ thread: { approval: body } }) });
    const result = world.finalize();
    assert.deepEqual(result.finalized, [], body);
    assert.deepEqual(result.left, [{ issue: 40, reason: 'not-exact-approval' }], body);
    assert.equal(world.fixtureIssue().comments.length, 2, `${body}: nothing posted`);
    assert.equal(world.ledger().length, 1, `${body}: nothing recorded`);
    const item = computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: NOW }).eligible[0];
    assert.equal(item.kind, 'approval', body);
    assert.equal(item.withEdits, true, `${body}: a qualified approval is with edits, never unchanged`);
  }
  const exact = finalizeWorld();
  assert.equal(computeFrontier({ root: exact.root, tenant: 'endzone', fixture: exact.fixture, now: NOW }).eligible[0].withEdits, false);
  assert.equal(triage.isExactApproval('Approved'), true);
  assert.equal(triage.isExactApproval('\r\napproved\r\n'), true);
  assert.equal(triage.isExactApproval('Approved, but skip X'), false);
  assert.equal(triage.isExactApproval('Not approved'), false);
});

test('#207: each clause that fails leaves the issue to the Principal, named in left, with nothing posted, labelled or recorded', () => {
  const later = (createdAt, body = 'comment', author = OWNER) => ({ id: `x-${createdAt}`, url: 'https://x/x', author, body, createdAt });
  const otherProposal = { id: 'other', url: 'https://github.com/owner/repo/issues/40#issuecomment-other', author: FLEET, body: PROPOSAL, createdAt: '2026-09-10T12:00:00.000Z' };
  const cases = [
    // clause 2
    ['Approved with:', 'not-exact-approval', () => ({ thread: { approval: 'Approved with: tier haiku' } })],
    ['Approved, but', 'not-exact-approval', () => ({ thread: { approval: 'Approved, but skip X' } })],
    // clause 3
    ['a Ruling already posted after the approval', 'ruling-already-posted', () => ({ thread: { extraComments: [later('2026-09-11T00:01:00.000Z', '## Ruling\nby hand', FLEET)] } })],
    ['an owner comment after the approval', 'owner-commented-after-approval', () => ({ thread: { extraComments: [later('2026-09-11T01:00:00.000Z', 'Actually, hold on, what about the mobile view?')] } })],
    // clause 4
    ['a newer proposal than the ledger\'s', 'stale-proposal', () => ({ thread: { extraComments: [] }, comments: [thread(40)[0], otherProposal, thread(40)[1]] })],
    // clause 5
    ['a proposal edited after the approval', 'edited-after-approval', () => ({ thread: { proposalEditedAt: '2026-09-11T00:30:00.000Z' } })],
    ['an approval edited after it was made', 'edited-after-approval', () => ({ thread: { approvalEditedAt: '2026-09-11T00:30:00.000Z' } })],
    // clause 6
    ['a body hash changed since the proposal', 'body-changed', () => ({ body: `${BODY}Edited later.\n`, proposedBody: BODY })],
    ['a body lacking ## Premises', 'no-premises-heading', () => ({ body: 'Body of #40 with no section' })],
    // clause 7
    ['a proposal carrying a wake record id', 'escalation', () => ({ recordId: 'endzone:issue-40' })],
    // clause 8
    ['bug (ready-for-human: ...)', 'classification', () => ({ thread: { proposal: PROPOSAL.replace('Classification: bug', 'Classification: bug (ready-for-human: a human must run the migration)') } })],
    ['ready-for-human', 'classification', () => ({ thread: { proposal: PROPOSAL.replace('Classification: bug', 'Classification: ready-for-human') } })],
    ['question', 'classification', () => ({ thread: { proposal: PROPOSAL.replace('Classification: bug', 'Classification: question') } })],
    ['duplicate', 'classification', () => ({ thread: { proposal: PROPOSAL.replace('Classification: bug', 'Classification: duplicate of #12') } })],
    ['wontfix', 'classification', () => ({ thread: { proposal: PROPOSAL.replace('Classification: bug', 'Classification: wontfix') } })],
    ['no classification line', 'classification', () => ({ thread: { proposal: PROPOSAL.replace('Classification: bug\n', '') } })],
    ['Open for Cory: none. On Approval ...', 'open-for-cory', () => ({ thread: { proposal: PROPOSAL.replace('Open for Cory: none', 'Open for Cory: none. On Approval, please also decide the caption.') } })],
    ['Open for Cory with a question', 'open-for-cory', () => ({ thread: { proposal: PROPOSAL.replace('Open for Cory: none', 'Open for Cory: is the caption in scope?') } })],
    ['Blocked_by: #N', 'blocked-by', () => ({ thread: { proposal: PROPOSAL.replace('Blocked_by: none', 'Blocked_by: #12') } })],
    ['a Tier of opus', 'tier', () => ({ thread: { proposal: PROPOSAL.replace('Tier: sonnet', 'Tier: opus') } })],
    ['no Ruling line', 'no-ruling-line', () => ({ thread: { proposal: PROPOSAL.replace('Ruling: none needed\n', '') } })],
    ['an unverified premise', 'premises', () => ({ thread: { proposal: PROPOSAL.replace(' verified @abcdef2', '') } })],
    ['a false premise', 'premises', () => ({ thread: { proposal: PROPOSAL.replace('verified @abcdef2', 'false: the slice is already correct') } })],
    ['Premises: none stated', 'premises', () => ({ thread: { proposal: PROPOSAL.replace('Premises:\n  src/list.js: slices one short @abcdef1 verified @abcdef2', 'Premises: none stated') } })],
    ['an empty Premises block', 'premises', () => ({ thread: { proposal: PROPOSAL.replace('  src/list.js: slices one short @abcdef1 verified @abcdef2\n', '') } })],
    // clause 8, whole FIELD: a continuation line under an exact-valued field fails it
    ['Open for Cory: none with an indented question under it', 'open-for-cory', () => ({ thread: { proposal: PROPOSAL.replace('Open for Cory: none', 'Open for Cory: none\n  Is the caption in scope?') } })],
    ['Tier: sonnet with a continuation', 'tier', () => ({ thread: { proposal: PROPOSAL.replace('Tier: sonnet', 'Tier: sonnet\n  (opus if the migration is needed)') } })],
    ['Blocked_by: none with a continuation', 'blocked-by', () => ({ thread: { proposal: PROPOSAL.replace('Blocked_by: none', 'Blocked_by: none\n  once #12 lands') } })],
    ['Classification: bug with a continuation', 'classification', () => ({ thread: { proposal: PROPOSAL.replace('Classification: bug', 'Classification: bug\n  (ready-for-human: run the migration)') } })],
    ['a duplicated Tier line', 'tier', () => ({ thread: { proposal: PROPOSAL.replace('Tier: sonnet', 'Tier: sonnet\nTier: opus') } })],
    // clause 8, premises: every line, no false, not stopped by a blank line
    ['a false premise that also says verified', 'premises', () => ({ thread: { proposal: PROPOSAL.replace('slices one short @abcdef1 verified @abcdef2', 'slices one short @abcdef1 false: not so, verified @abcdef2') } })],
    ['two premises, one unverified', 'premises', () => ({ thread: { proposal: PROPOSAL.replace('  src/list.js: slices one short @abcdef1 verified @abcdef2', '  src/list.js: slices one short @abcdef1 verified @abcdef2\n  src/util.js: exports pad @abcdef1') } })],
    ['an unverified premise after a blank line', 'premises', () => ({ thread: { proposal: PROPOSAL.replace('  src/list.js: slices one short @abcdef1 verified @abcdef2', '  src/list.js: slices one short @abcdef1 verified @abcdef2\n\n  src/util.js: exports pad @abcdef1') } })],
    ['a premise with a trailing note after verified', 'premises', () => ({ thread: { proposal: PROPOSAL.replace('verified @abcdef2', 'verified @abcdef2 (re-read at head)') } })],
    // clause 6: the heading must be a heading on its own line
    ['a Premises heading split across lines', 'no-premises-heading', () => ({ body: 'Body of #40 ##\nPremises\n' })],
    // clause 9
    ['held', 'labels', () => ({ labels: ['needs-triage', 'triage-proposed', 'held'] })],
    ['haiku-rehearsal', 'labels', () => ({ labels: ['needs-triage', 'triage-proposed', 'haiku-rehearsal'] })],
    ['already routed', 'labels', () => ({ labels: ['needs-triage', 'triage-proposed', 'ready-for-human'] })],
    ['the marker gone', 'labels', () => ({ labels: ['needs-triage'] })],
    ['the tenant escalation label', 'labels', () => ({ labels: ['needs-triage', 'triage-proposed', 'fleet-escalation'] })],
  ];
  for (const [name, reason, options] of cases) {
    const world = finalizeWorld({ each: options });
    const before = JSON.stringify(world.fixtureIssue());
    const result = world.finalize();
    assert.deepEqual(result.finalized, [], name);
    assert.equal(result.left.length, 1, name);
    assert.equal(result.left[0].reason, reason, name);
    assert.equal(JSON.stringify(world.fixtureIssue()), before, `${name}: GitHub is untouched`);
    assert.equal(world.ledger().length, 1, `${name}: nothing recorded`);
  }
});

test('#207: only the owner login can approve, and an approval older than the proposal does not count', () => {
  const byFleet = finalizeWorld({ each: () => ({ comments: [thread(40, { approval: null })[0], { id: 'f', url: 'https://x/f', author: FLEET, body: 'Approved', createdAt: APPROVED_AT }] }) });
  assert.deepEqual(byFleet.finalize().finalized, []);
  const early = finalizeWorld({ each: () => ({ comments: [thread(40, { approval: null })[0], { id: 'e', url: 'https://x/e', author: OWNER, body: 'Approved', createdAt: '2026-09-09T00:00:00.000Z' }] }) });
  assert.deepEqual(early.finalize().finalized, []);
});

test('#207: an escalation is never finalized: a wake before the proposal (consumed or not), or one still unconsumed; a wake before the previous decision is not this one', () => {
  const wake = (issueNumber, at) => ({ at, recordId: `endzone:issue-${issueNumber}`, wake: 'decision-needed', evidence: 'stuck' });
  const before = finalizeWorld({ outbox: [wake(40, '2026-09-09T00:00:00.000Z')] });
  assert.equal(before.finalize().left[0].reason, 'escalation');
  const consumed = finalizeWorld({ outbox: [wake(40, '2026-09-09T00:00:00.000Z')], history: (root) => recordEntry({ root, tenant: 'endzone', kind: 'consumed', through: '2026-09-09T12:00:00.000Z', now: '2026-09-09T12:00:01.000Z' }) });
  const two = consumed.finalize();
  assert.deepEqual(two.finalized, [], 'a consumed wake in the window before the proposal is still an escalation');
  assert.equal(two.left[0].reason, 'escalation');
  const after = finalizeWorld({ outbox: [wake(40, '2026-09-10T06:00:00.000Z')] });
  assert.equal(after.finalize().left[0].reason, 'escalation', 'a wake past the consumed marker is an open escalation');
  const other = finalizeWorld({ outbox: [wake(41, '2026-09-09T00:00:00.000Z')] });
  assert.equal(other.finalize().finalized.length, 1, 'a wake on another issue is not this one');
  // #40 was decided once before (proposed, approved, finalized in early September) and its wake was consumed then.
  const decidedBefore = finalizeWorld({
    outbox: [wake(40, '2026-09-01T12:00:00.000Z')],
    history: (root) => {
      recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 40, bodyHash: 'old', commentUrl: 'https://x/old', model: 'fable', now: '2026-09-01T00:00:00.000Z' });
      recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 40, by: OWNER, now: '2026-09-02T00:00:00.000Z' });
      recordEntry({ root, tenant: 'endzone', kind: 'finalized', issue: 40, labels: 'ready-for-agent', now: '2026-09-03T00:00:00.000Z' });
      recordEntry({ root, tenant: 'endzone', kind: 'consumed', through: '2026-09-04T00:00:00.000Z', now: '2026-09-04T00:00:01.000Z' });
    },
  });
  assert.equal(decidedBefore.finalize().finalized.length, 1, 'a wake that predates the previous decision was answered by it');
});

test('#207: at most five are finalized per run; the sixth is left with the reason cap', () => {
  const world = finalizeWorld({ numbers: [51, 52, 53, 54, 55, 56] });
  const result = world.finalize();
  assert.deepEqual(result.finalized.map((row) => row.issue), [51, 52, 53, 54, 55]);
  assert.deepEqual(result.left, [{ issue: 56, reason: 'cap' }]);
  assert.equal(world.ledger().filter((row) => row.kind === 'finalized').length, 5);
  assert.deepEqual(world.finalize().finalized.map((row) => row.issue), [56], 'the next run takes the rest');
});

test('#207: the claim is first-writer-wins: record --kind approved on a decided row throws, and finalize leaves an issue the Principal claimed meanwhile', () => {
  const root = rootDir();
  recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 1, bodyHash: 'h', commentUrl: 'u', model: 'fable', now: PROPOSED_AT });
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 1, by: OWNER, actor: 'finalize-script', now: APPROVED_AT });
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'approved-with-edits', issue: 1, by: OWNER, edits: 'x', now: '2026-09-11T00:00:01.000Z' }), (error) => error.code === 'TRIAGE_ALREADY_DECIDED' && error.decidedBy === 'finalize-script');
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 1, by: OWNER, now: '2026-09-11T00:00:01.000Z' }), { code: 'TRIAGE_ALREADY_DECIDED' });
  assert.equal(readLedger(root, 'endzone').length, 2);
  // The Principal claims #40 while the script is loading GitHub: the script's claim collides.
  const world = finalizeWorld();
  const seed = JSON.parse(fs.readFileSync(world.fixture, 'utf8'));
  const writes = [];
  const result = triage.finalizeApprovals({ root: world.root, tenant: 'endzone', now: NOW, runner: ghRunner(seed, (exe, args) => { writes.push(args); return ''; }, () => recordEntry({ root: world.root, tenant: 'endzone', kind: 'approved', issue: 40, by: OWNER, now: '2026-09-11T00:00:02.000Z' })) });
  assert.deepEqual(result.finalized, []);
  assert.deepEqual(result.left, [{ issue: 40, reason: 'claimed by principal' }]);
  assert.deepEqual(writes, [], 'not one GitHub write');
});

// A runner that answers the issue query from `seed`, calling `onQuery` first, and hands every other gh call to `write`.
function ghRunner(seed, write, onQuery) {
  return (exe, args, options) => {
    if (args[0] === 'api') {
      if (onQuery) onQuery();
      return JSON.stringify({ data: { repository: { issues: { nodes: seed, pageInfo: { hasNextPage: false } } } } });
    }
    return write(exe, args, options);
  };
}

test('#207: a run cut short is finished by the next run: one Ruling, the labels, one finalized row', () => {
  const ruling = { id: 'ruling', url: 'https://github.com/owner/repo/issues/40#issuecomment-ruling', author: FLEET, body: '## Ruling\nApproved without edits.', createdAt: '2026-09-11T00:01:00.000Z' };
  for (const [name, extra, labels] of [
    ['claim with no Ruling', [], ['needs-triage', 'triage-proposed']],
    ['Ruling but no label', [ruling], ['needs-triage', 'triage-proposed']],
    ['labels but no finalized row', [ruling], ['needs-triage', 'ready-for-agent', 'bug']],
  ]) {
    const world = finalizeWorld({ each: () => ({ labels, comments: thread(40, { extraComments: extra }) }) });
    recordEntry({ root: world.root, tenant: 'endzone', kind: 'approved', issue: 40, by: OWNER, commentUrl: approvalUrl(40), actor: 'finalize-script', now: '2026-09-11T00:00:30.000Z' });
    const result = world.finalize();
    assert.deepEqual(result.finalized.map((row) => row.issue), [40], name);
    assert.equal(rulingsOn(world.fixtureIssue()).length, 1, `${name}: one Ruling`);
    assert.deepEqual([...world.fixtureIssue().labels].sort(), ['bug', 'needs-triage', 'ready-for-agent'], name);
    assert.deepEqual(world.ledger().slice(1).map((row) => [row.kind, row.actor]), [['approved', 'finalize-script'], ['finalized', 'finalize-script']], name);
    assert.deepEqual(world.finalize().finalized, [], `${name}: and a rerun does nothing`);
    assert.equal(world.ledger().length, 3, name);
  }
});

test('#207: a failed GitHub write after the claim is retried by the next run without a second Ruling', () => {
  const world = finalizeWorld();
  const seed = JSON.parse(fs.readFileSync(world.fixture, 'utf8'));
  const writes = [];
  let failOnce = true;
  const write = (exe, args) => {
    writes.push(args.slice(0, 2).join(' '));
    if (args[1] === 'edit' && failOnce) { failOnce = false; throw Object.assign(new Error('gh: 502'), { stderr: 'HTTP 502' }); }
    return '';
  };
  const first = triage.finalizeApprovals({ root: world.root, tenant: 'endzone', now: NOW, runner: ghRunner(seed, write) });
  assert.deepEqual(first.finalized, []);
  assert.match(first.errors[0].message, /502/);
  assert.deepEqual(writes, ['issue comment', 'issue edit']);
  assert.deepEqual(world.ledger().slice(1).map((row) => row.kind), ['approved'], 'the claim stands, so the Principal cannot also rule');
  seed[0].comments.push({ id: 'ruling', url: 'https://github.com/owner/repo/issues/40#issuecomment-ruling', author: FLEET, body: '## Ruling\nApproved without edits.', createdAt: '2026-09-11T00:01:00.000Z' });
  writes.length = 0;
  const second = triage.finalizeApprovals({ root: world.root, tenant: 'endzone', now: NOW, runner: ghRunner(seed, write) });
  assert.deepEqual(second.finalized.map((row) => row.issue), [40]);
  assert.deepEqual(writes, ['issue edit'], 'no second Ruling comment');
  assert.deepEqual(world.ledger().slice(1).map((row) => row.kind), ['approved', 'finalized']);
});

test('#207: against GitHub the writes are one gh comment (body on stdin) and one gh edit that adds ready-for-agent and bug and removes the marker', () => {
  const world = finalizeWorld();
  const seed = JSON.parse(fs.readFileSync(world.fixture, 'utf8'));
  const calls = [];
  const result = triage.finalizeApprovals({ root: world.root, tenant: 'endzone', now: NOW, runner: ghRunner(seed, (exe, args, options) => { calls.push({ exe, args, input: options && options.input }); return ''; }) });
  assert.equal(result.finalized.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['issue', 'comment', '40', '-R', 'owner/repo', '--body-file', '-']);
  assert.match(calls[0].input, /^## Ruling\n/);
  assert.doesNotMatch(calls[0].input, /^\s*veto/i);
  assert.deepEqual(calls[1].args, ['issue', 'edit', '40', '-R', 'owner/repo', '--add-label', 'ready-for-agent', '--add-label', 'bug', '--remove-label', 'triage-proposed']);
});

test('#207: the frontier lists a finalize-script claim older than 30 minutes with no finalized row, and not a younger one', () => {
  const root = rootDir();
  for (const number of [60, 61]) recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: number, bodyHash: triage.normalizeIssue(issue(number)).bodyHash, commentUrl: proposalUrl(number), model: 'fable', now: '2026-09-12T10:00:00.000Z' });
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 60, by: OWNER, commentUrl: approvalUrl(60), actor: 'finalize-script', now: '2026-09-12T11:20:00.000Z' });   // 40 minutes before NOW
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 61, by: OWNER, commentUrl: approvalUrl(61), actor: 'finalize-script', now: '2026-09-12T11:50:00.000Z' });   // 10 minutes before NOW
  const entries = readLedger(root, 'endzone');
  const result = frontier([issue(60, { labels: ['triage-proposed'] }), issue(61, { labels: ['triage-proposed'] })], { entries });
  assert.deepEqual(result.eligible.map((item) => [item.kind, item.number, item.reason]), [['approval', 60, 'finalize-script claim older than 30 minutes without a finalized row']]);
  recordEntry({ root, tenant: 'endzone', kind: 'finalized', issue: 60, labels: 'ready-for-agent', actor: 'finalize-script', now: '2026-09-12T11:55:00.000Z' });
  assert.deepEqual(frontier([issue(60, { labels: ['ready-for-agent'] })], { entries: readLedger(root, 'endzone') }).eligible, [], 'a finalized row clears it');
});

test('#207: the finalize CLI runs against a fixture and prints what it finalized and what it left', () => {
  const world = finalizeWorld({ numbers: [40, 41], each: (n) => (n === 41 ? { thread: { approval: 'Approved with: tier haiku' } } : {}) });
  const out = cli(['finalize', '--root', world.root, '--tenant', 'endzone', '--fixture', world.fixture, '--now', NOW]);
  assert.deepEqual(out.finalized.map((row) => row.issue), [40]);
  assert.deepEqual(out.finalized[0].labels, ['ready-for-agent', 'bug']);
  assert.deepEqual(out.left, [{ issue: 41, reason: 'not-exact-approval' }]);
  assert.ok(TRIAGE_FLAGS.finalize.includes('fixture'));
  assert.throws(() => cli(['finalize', '--root', world.root, '--tenant', 'endzone', '--fixtrue', 'x']), (error) => /unknown flag/.test(error.message));
});

test('#207: a trailing full stop is allowed on an exact field, and a Premises heading may carry a parenthesis and a blank-separated verified block', () => {
  const dotted = PROPOSAL.replace('Open for Cory: none', 'Open for Cory: none.').replace('Blocked_by: none', 'Blocked_by: none.').replace('Tier: sonnet', 'Tier: sonnet.').replace('Classification: bug', 'Classification: bug.')
    .replace('  src/list.js: slices one short @abcdef1 verified @abcdef2', '  src/list.js: slices one short @abcdef1 verified @abcdef2\n\n  src/util.js: exports pad @abcdef1 verified @abcdef2');
  const world = finalizeWorld({ each: () => ({ body: 'Body of #40\n\n## Premises (re-read 2026-09-25)\n\nsrc/list.js: slices one short @abcdef1\n', thread: { proposal: dotted } }) });
  assert.deepEqual(world.finalize().finalized.map((row) => row.issue), [40]);
});

test('#207: escalation window: a wake, proposal A with a record id, consumed, A superseded, B without one: B is still an escalation', () => {
  const world = finalizeWorld({
    outbox: [{ at: '2026-09-01T00:00:00.000Z', recordId: 'endzone:issue-40', wake: 'decision-needed', evidence: 'stuck' }],
    history: (root) => {
      recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: 40, bodyHash: 'a', commentUrl: 'https://x/a', model: 'fable', recordId: 'endzone:issue-40', now: '2026-09-02T00:00:00.000Z' });
      recordEntry({ root, tenant: 'endzone', kind: 'consumed', through: '2026-09-02T01:00:00.000Z', now: '2026-09-02T01:00:01.000Z' });
      recordEntry({ root, tenant: 'endzone', kind: 'superseded', issue: 40, bodyHash: 'b', now: '2026-09-03T00:00:00.000Z' });
    },
  });
  const result = world.finalize();
  assert.deepEqual(result.finalized, []);
  assert.equal(result.left[0].reason, 'escalation', 'a superseded proposal is not a decision that answers the wake');
});

test('#207: a standing bounded-ready row is not finalized by script (clause 1)', () => {
  const world = finalizeWorld({ afterPropose: (root) => fs.appendFileSync(triage.ledgerPath(root, 'endzone'), JSON.stringify({ schemaVersion: 1, kind: 'bounded-ready', tenant: 'endzone', at: '2026-09-10T06:00:00.000Z', actor: 'principal', issue: 40 }) + '\n') });
  const result = world.finalize();
  assert.deepEqual(result.finalized, []);
  assert.equal(result.left[0].reason, 'decided');
});

test('#207: recovery of a claim with no comment url does not render an empty approval link', () => {
  const world = finalizeWorld();
  recordEntry({ root: world.root, tenant: 'endzone', kind: 'approved', issue: 40, by: OWNER, actor: 'finalize-script', now: '2026-09-11T00:00:30.000Z' });
  assert.equal(world.finalize().finalized.length, 1);
  const ruling = rulingsOn(world.fixtureIssue())[0].body;
  assert.match(ruling, /^## Ruling\nApproved without edits\. Finalized by script \(fleet #207\)\.\n/);
});

test('#207: proposalGate is one pure predicate over clauses 1 and 4 to 9 and parseProposal is the one proposal parser', () => {
  const eligible = () => {
    const body = BODY;
    const proposed = { kind: 'proposed', at: PROPOSED_AT, commentUrl: proposalUrl(40), bodyHash: triage.normalizeIssue(issue(40, { body })).bodyHash };
    const normalized = triage.normalizeIssue(issue(40, { body, labels: ['needs-triage', 'triage-proposed'], comments: thread(40) }));
    return { issue: normalized, row: { proposed, outcome: null, history: [proposed] }, proposal: normalized.comments[0], approval: normalized.comments[1], config: DEFAULT_CONFIG, tenantConfig: { readyLabel: 'ready-for-agent', escalationLabel: 'fleet-escalation' }, outbox: [], consumedThrough: null, tenant: 'endzone' };
  };
  assert.equal(typeof triage.proposalGate, 'function');
  assert.deepEqual(triage.proposalGate(eligible()), []);
  const held = triage.proposalGate({ ...eligible(), holds: new Map([[40, 'skip file: parked']]) });
  assert.deepEqual(held.map((failure) => failure.code), ['held']);
  const noHold = triage.proposalGate({ ...eligible(), holds: new Map([[41, 'x']]) });
  assert.deepEqual(noHold, []);
  const failing = eligible();
  failing.proposal = { ...failing.proposal, body: PROPOSAL.replace('Tier: sonnet', 'Tier: opus').replace('Blocked_by: none', 'Blocked_by: #3') };
  assert.deepEqual(triage.proposalGate(failing).map((failure) => failure.code), ['blocked-by', 'tier']);
  const parsed = triage.parseProposal(PROPOSAL.replace('Open for Cory: none', 'Open for Cory: none\n  and a second thought\n\n  after a blank'));
  assert.equal(parsed.fields['Open for Cory'], 'none\nand a second thought\nafter a blank');
  assert.equal(parsed.fields.Classification, 'bug');
  assert.equal(parsed.fields.Tier, 'sonnet');
  assert.deepEqual(parsed.premises, ['src/list.js: slices one short @abcdef1 verified @abcdef2']);
  assert.equal(triage.parseProposal('## Triage proposal (advisory)\nPremises: none stated\n').premises, null);
});

// A principal or script claim with no finalized row comes back on the frontier after 30 minutes.
test('#207: the frontier lists any actor\'s unfinished claim older than 30 minutes, carrying withEdits and edits, while the marker stands', () => {
  const root = rootDir();
  for (const number of [70, 71, 72, 73]) recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: number, bodyHash: triage.normalizeIssue(issue(number)).bodyHash, commentUrl: proposalUrl(number), model: 'fable', now: '2026-09-12T10:00:00.000Z' });
  recordEntry({ root, tenant: 'endzone', kind: 'approved-with-edits', issue: 70, by: OWNER, edits: 'tier sonnet', commentUrl: approvalUrl(70), now: '2026-09-12T11:00:00.000Z' });   // 60 minutes old
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 71, by: OWNER, commentUrl: approvalUrl(71), now: '2026-09-12T11:10:00.000Z' });   // 50 minutes old
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 72, by: OWNER, now: '2026-09-12T11:50:00.000Z' });   // 10 minutes old
  recordEntry({ root, tenant: 'endzone', kind: 'approved', issue: 73, by: OWNER, now: '2026-09-12T11:00:00.000Z' });   // old, but ruled by hand: marker gone
  const entries = readLedger(root, 'endzone');
  const result = frontier([issue(70, { labels: ['triage-proposed'] }), issue(71, { labels: ['triage-proposed'] }), issue(72, { labels: ['triage-proposed'] }), issue(73, { labels: ['ready-for-agent'] })], { entries });
  assert.deepEqual(result.eligible.map((item) => [item.kind, item.number, item.withEdits]), [['approval', 70, true], ['approval', 71, false]]);
  assert.equal(result.eligible[0].edits, 'tier sonnet');
  assert.match(result.eligible[0].reason, /claim older than 30 minutes without a finalized row/);
  assert.equal(result.eligible[0].commentUrl, approvalUrl(70));
});

// ---------------------------------------------------------------------------
// Spec fleet #193 (#210): Bounded authority. The Principal readies a bug of the
// bounded class itself through one door, behind a per-tenant flag Cory creates.
// The door acts with no word from Cory, so it is #207's finalize predicate
// (proposalGate) plus bounded-only clauses, never looser (Fable ruling on the QA,
// 2026-09-29). Tests drive it with a fixture issue, a fake tenant checkout and fake
// gh and page seams, and assert what it produces: ledger rows, gh label commands,
// pages, refusals with their codes.
// ---------------------------------------------------------------------------
const bounded = require('../bin/bounded-authority');
const { addExclusion } = require('../bin/exclusions');

const BNOW = '2026-09-29T15:00:00.000Z';   // 10:00 CDT, a Tuesday
const PREMISE_SHA = 'def5678';
const PROPOSAL_URL = 'https://github.com/owner/repo/issues/7#issuecomment-5001';
const B_PROPOSED_AT = '2026-09-29T09:00:01.000Z';
const B_BODY = 'The foo page crashes.\n\n## Premises\n\nserver/services/foo.js:10: foo reads a null @abc1234\n';
const PREMISE_LINE = `  server/services/foo.js:10: foo reads a null @abc1234 verified @${PREMISE_SHA}`;
const TREE = ['server', 'server/services', 'server/test', 'server/modules', 'server/db/migrations', '.github/workflows'];

function proposalBody(over = {}) {
  const fields = {
    Classification: 'bug',
    'Root cause': 'server/services/foo.js:10 reads a null.',
    Ruling: 'none needed',
    'Red-tell': 'server/test/foo.test.js fails today on the null read and passes when guarded',
    Repro: 'run node --test server/test/foo.test.js against a row with a null score',
    Scope: 'lists exactly `server/services/foo.js` and `server/test/foo.test.js`',
    Premises: [PREMISE_LINE],
    Blocked_by: 'none',
    Tier: 'sonnet',
    Precedent: 'none',
    'Open for Cory': 'none',
    ...over,
  };
  const lines = ['## Triage proposal (advisory)'];
  for (const [name, value] of Object.entries(fields)) {
    if (value === null) continue;
    if (Array.isArray(value)) { lines.push(`${name}:`, ...value); } else lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}

const REAL_TENANT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tenants', 'endzone.json'), 'utf8'));

// A tenant root with the flag, an open proposal on issue 7 carrying the given fields, and a fake
// tenant checkout (`tree` directories, `files` contents) for the door to read Scope against.
function boundedRoot({ flag = true, suspended = false, tenant = 'endzone', tenantOver = {}, proposal = {}, recordOver = {}, issueOver = {}, extraComments = [], labels = ['bug', 'triage-proposed'], tree = TREE, files = {}, proposalOver = {}, seed, body = B_BODY } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-bounded-'));
  for (const dir of ['tenants', 'config', path.join('state', 'watch'), path.join('state', 'flags')]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'tenants', `${tenant}.json`), JSON.stringify({ ...REAL_TENANT, name: tenant, github: 'owner/repo', repo: null, fleetIdentity: FLEET, ownerLogin: OWNER, ...tenantOver }));
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ triage: { maxProposalsPerTurn: 2 } }));
  if (flag) fs.writeFileSync(path.join(root, 'state', 'flags', `bounded-authority-${tenant}`), '');
  if (suspended) fs.writeFileSync(path.join(root, 'state', 'flags', `bounded-authority-suspended-${tenant}`), JSON.stringify({ cause: 'test' }));
  const proposalComment = { id: 'p1', url: PROPOSAL_URL, author: FLEET, createdAt: '2026-09-29T09:00:00.000Z', body: proposalBody(proposal), ...proposalOver };
  const bug = { ...issue(7, { labels, comments: [proposalComment, ...extraComments], body, createdAt: '2026-09-28T00:00:00.000Z', ...issueOver }), ...(issueOver.blockedBy !== undefined ? { blockedBy: issueOver.blockedBy } : {}) };
  const bodyHash = triage.normalizeIssue(issue(7, { body })).bodyHash;   // the body the proposal was written against
  fs.mkdirSync(path.join(root, 'state', 'triage'), { recursive: true });
  if (seed) seed(root);
  recordEntry({ root, tenant, kind: 'proposed', issue: 7, bodyHash, commentUrl: PROPOSAL_URL, model: 'fable', premisesSha: PREMISE_SHA, now: B_PROPOSED_AT, ...recordOver });
  const fixture = path.join(root, 'issues.json');
  fs.writeFileSync(fixture, JSON.stringify([bug]));
  const calls = [];
  const pages = [];
  const order = [];
  const runner = (exe, args) => { calls.push([exe, ...args]); order.push(`label:${readLedger(root, tenant).some((entry) => entry.kind === 'bounded-ready') ? 'row' : 'norow'}`); return ''; };
  const send = (message) => { pages.push(message); order.push(`page:${readLedger(root, tenant).some((entry) => entry.kind === 'bounded-ready') ? 'row' : 'norow'}`); return { ok: true, detail: 'pushover delivered' }; };
  const repo = { has: (dir) => tree.includes(dir), read: (file) => (Object.prototype.hasOwnProperty.call(files, file) ? files[file] : null), list: (dir) => Object.keys(files).filter((name) => name.slice(0, name.lastIndexOf('/')) === dir).map((name) => name.slice(name.lastIndexOf('/') + 1)) };
  const door = (extra = {}) => bounded.boundedReady({ root, tenant, issue: 7, fixture, now: BNOW, runner, send, repo, ...extra });
  return { root, tenant, fixture, calls, pages, order, door, bug, bodyHash, runner, send, repo };
}

function boundedRows(world) { return readLedger(world.root, world.tenant).filter((entry) => entry.kind === 'bounded-ready').length; }

function refusal(world, condition, pattern, extra = {}) {
  const before = boundedRows(world);
  assert.throws(() => world.door(extra), (error) => {
    assert.equal(error.code, 'BOUNDED_REFUSED');
    assert.equal(error.condition, condition, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
  assert.equal(world.calls.length, 0, 'a refusal changes nothing on GitHub');
  assert.equal(world.pages.length, 0, 'a refusal pages nobody');
  assert.equal(boundedRows(world), before, 'a refusal records nothing');
}

const codesOf = (world) => { try { world.door(); return []; } catch (error) { return (error.conditions || []).map((entry) => entry.code); } };

test('#210: a bounded bug is readied: the page goes first, then the ledger row, then the label; one page at normal priority with the link; the marker comes off', () => {
  const world = boundedRoot();
  const result = world.door();
  assert.equal(result.readied, true);
  assert.deepEqual(world.order, ['page:norow', 'label:row'], 'page, then row, then label');
  assert.deepEqual(world.calls, [['gh', 'issue', 'edit', '7', '-R', 'owner/repo', '--add-label', 'ready-for-agent', '--remove-label', 'triage-proposed']]);
  assert.equal(world.pages.length, 1);
  assert.equal(world.pages[0].priority, 'normal');
  assert.equal(world.pages[0].url, 'https://github.com/owner/repo/issues/7');
  assert.match(world.pages[0].body, /Veto/);
  assert.match(world.pages[0].body, /2026-09-29 12:00 Central/, 'the page text and the row share the door\'s at: 10:00 plus 2 hours');
  assert.ok(!/\u2014/.test(world.pages[0].title + world.pages[0].body), 'no em-dash in page text');
  const rows = readLedger(world.root, 'endzone').filter((entry) => entry.kind === 'bounded-ready');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, 7);
  assert.equal(rows[0].at, BNOW);
  assert.equal(rows[0].bodyHash, world.bodyHash);
  assert.equal(rows[0].commentUrl, PROPOSAL_URL);
  assert.equal(rows[0].proposalHash, require('../bin/assignment').sha256(world.bug.comments[0].body), 'the row records the proposal comment\'s hash for audit');
  assert.deepEqual(rows[0].scope, ['server/services/foo.js', 'server/test/foo.test.js']);
  const state = projectTriage({ entries: readLedger(world.root, 'endzone'), now: BNOW });
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.awaitingFinalize, []);
  const planned = require('../bin/assignment').plannerInputs({ root: world.root, tenant: 'endzone', tenantConfig: { ownerLogin: OWNER } });
  assert.deepEqual(planned.boundedReadies, [{ issue: 7, at: BNOW }]);
});

test('#210 m3: a page that fails records nothing and changes no label, so the next tick tries again', () => {
  const world = boundedRoot();
  refusal(world, 'page-failed', /pushover down/, { send: () => ({ ok: false, detail: 'pushover down' }) });
  refusal(world, 'page-failed', /send threw/, { send: () => { throw new Error('boom'); } });
  assert.equal(world.door().readied, true, 'the retry finds a clean slate');
});

test('#210 m2: a label that fails leaves the row and the page; the frontier lists bounded-repair; re-running applies the label with no new row and no page; an owner comment in between leaves it', () => {
  const world = boundedRoot();
  assert.throws(() => world.door({ runner: () => { throw new Error('gh 502'); } }), (error) => error.code === 'GITHUB_WRITE_FAILED' && /bounded-repair/.test(error.message));
  assert.equal(boundedRows(world), 1);
  assert.equal(world.pages.length, 1);
  const frontier = computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:30:00.000Z' });
  assert.deepEqual(frontier.eligible.map((item) => [item.kind, item.number]), [['bounded-repair', 7]]);
  assert.equal(frontier.counts.repairs, 1);
  const repaired = world.door({ now: '2026-09-29T15:31:00.000Z' });
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.readied, false);
  assert.deepEqual(world.calls, [['gh', 'issue', 'edit', '7', '-R', 'owner/repo', '--add-label', 'ready-for-agent', '--remove-label', 'triage-proposed']]);
  assert.equal(boundedRows(world), 1, 'no second row');
  assert.equal(world.pages.length, 1, 'no second page');
  // The owner spoke after the row: the repair is left, and nothing on the frontier offers it.
  const spoke = boundedRoot();
  assert.throws(() => spoke.door({ runner: () => { throw new Error('gh 502'); } }), (error) => error.code === 'GITHUB_WRITE_FAILED');
  fs.writeFileSync(spoke.fixture, JSON.stringify([{ ...spoke.bug, comments: [...spoke.bug.comments, comment(OWNER, 'hold on, a question', '2026-09-29T15:10:00.000Z')] }]));
  assert.throws(() => spoke.door(), (error) => error.condition === 'owner-spoke');
  assert.deepEqual(computeFrontier({ root: spoke.root, tenant: 'endzone', fixture: spoke.fixture, now: '2026-09-29T15:30:00.000Z' }).eligible, []);
  // A repair is only ever of the same ticket: a body changed since the row refuses too.
  const edited = boundedRoot();
  assert.throws(() => edited.door({ runner: () => { throw new Error('gh 502'); } }), (error) => error.code === 'GITHUB_WRITE_FAILED');
  fs.writeFileSync(edited.fixture, JSON.stringify([{ ...edited.bug, body: 'a different ticket now' }]));
  assert.throws(() => edited.door(), (error) => error.condition === 'body-changed');
});

test('#210: the CLI reads a fixture issue and records the ready; the fixture source touches neither GitHub nor the pager, and --now needs a fixture', () => {
  const world = boundedRoot();
  fs.writeFileSync(world.fixture, JSON.stringify({ issues: [world.bug], tree: TREE, files: {} }));
  const out = cli(['bounded-ready', '--root', world.root, '--tenant', 'endzone', '--issue', '7', '--fixture', world.fixture, '--now', BNOW]);
  assert.equal(out.readied, true);
  assert.equal(out.source, 'fixture');
  assert.equal(out.labelApplied, false);
  assert.equal(out.paged, false);
  assert.equal(out.recorded, false, 'a fixture run records nothing (QA B-1)');
  assert.equal(out.entry.kind, 'bounded-ready', 'the entry it would have recorded is returned');
  assert.equal(boundedRows(world), 0);
  for (const door of ['bounded-ready', 'veto']) {
    assert.throws(() => cli([door, '--root', world.root, '--tenant', 'endzone', '--issue', '7', '--now', BNOW]), (error) => error.code === 'USAGE' && /fixture/.test(error.message), door);
  }
  assert.throws(() => cli(['bounded-scan', '--root', world.root, '--tenant', 'endzone', '--now', BNOW]), (error) => error.code === 'USAGE');
});

test('#210: a fixture with no tenant checkout (no tree, no repo) cannot show a Scope path exists, so it refuses', () => {
  const world = boundedRoot();
  fs.writeFileSync(world.fixture, JSON.stringify([world.bug]));
  assert.throws(() => bounded.boundedReady({ root: world.root, tenant: 'endzone', issue: 7, fixture: world.fixture, now: BNOW, runner: world.runner, send: world.send, repo: null }), (error) => error.condition === 'scope-unresolved' && /no tenant checkout/.test(error.message));
});

// One fixture per leaf of the ruling (section 5): each refuses with its code, changes nothing, pages nobody.
const SKIP = (root) => { fs.mkdirSync(path.join(root, 'state', 'skip'), { recursive: true }); fs.writeFileSync(path.join(root, 'state', 'skip', 'endzone.json'), JSON.stringify({ issues: { 7: 'parked by the lead' } })); };
const LEAVES = [
  ['Classification with a parenthesis', { proposal: { Classification: 'bug (ready-for-human: needs a call)' } }, 'classification'],
  ['Classification feature', { proposal: { Classification: 'feature' } }, 'classification'],
  ['Ruling holding a fix sentence', { proposal: { Ruling: 'Guard the null read in foo.js and keep the column' } }, 'ruling-needed'],
  ['Ruling with a continuation line', { proposal: { Ruling: 'none needed\n  but the IC must also drop the legacy column' } }, 'ruling-needed'],
  ['Tier with a suffix', { proposal: { Tier: 'sonnet (opus if the lock path is involved)' } }, 'tier'],
  ['Tier opus', { proposal: { Tier: 'opus' } }, 'tier'],
  ['Open for Cory continuation line', { proposal: { 'Open for Cory': 'none\n  On Approval I edit the body Premises to the three lines above.' } }, 'open-for-cory'],
  ['Open for Cory a question', { proposal: { 'Open for Cory': 'Should the foo page show ties?' } }, 'open-for-cory'],
  ['Blocked_by an issue', { proposal: { Blocked_by: '#1745' } }, 'blocked-by'],
  ['Repro a placeholder', { proposal: { Repro: 'none' } }, 'no-repro'],
  ['Repro missing', { proposal: { Repro: null } }, 'no-repro'],
  ['Red-tell a placeholder', { proposal: { 'Red-tell': 'n/a' } }, 'no-red-tell'],
  ['an owner comment after the proposal (an approval with edits)', { extraComments: [comment(OWNER, 'Approved with: tier haiku', '2026-09-29T10:00:00.000Z')] }, 'owner-spoke'],
  ['an owner comment after the proposal (a question)', { extraComments: [comment(OWNER, 'why sonnet?', '2026-09-29T10:00:00.000Z')] }, 'owner-spoke'],
  ['an open blocked-by edge', { issueOver: { blockedBy: [{ number: 1745, state: 'OPEN' }] } }, 'blocked'],
  ['a truncated blocked-by list', { issueOver: { blockedBy: { nodes: [], pageInfo: { hasNextPage: true } } } }, 'blocked'],
  ['the held label', { labels: ['bug', 'triage-proposed', 'held'] }, 'labels'],
  ['the haiku-rehearsal label', { labels: ['bug', 'triage-proposed', 'haiku-rehearsal'] }, 'labels'],
  ['a routing label', { labels: ['bug', 'triage-proposed', 'needs-info'] }, 'labels', /needs-info/],
  ['the ready label already on', { labels: ['bug', 'triage-proposed', 'ready-for-agent'] }, 'labels'],
  ['a skip-file entry', { seed: SKIP }, 'held', /parked/],
  ['an active exclusion', { seed: (root) => addExclusion({ root, tenant: 'endzone', issue: 7, reason: 'parked', evidence: 'lead note', owner: 'pl-endzone', recheck: { expiresAt: '2026-12-01T00:00:00.000Z' }, actor: 'pl-endzone', now: '2026-09-01T00:00:00.000Z' }) }, 'held'],
  ['a Work record of any state', { seed: (root) => { fs.mkdirSync(path.join(root, 'state', 'work'), { recursive: true }); fs.writeFileSync(path.join(root, 'state', 'work', 'active.json'), JSON.stringify({ records: { 'endzone:issue-7': { id: 'endzone:issue-7', state: 'retired' } } })); } }, 'live-work'],
  ['an earlier veto row under a newer proposal', { seed: (root) => fs.appendFileSync(triage.ledgerPath(root, 'endzone'), [{ kind: 'bounded-ready', issue: 7, at: '2026-09-20T10:00:00.000Z', bodyHash: 'old' }, { kind: 'veto', issue: 7, at: '2026-09-21T10:00:00.000Z', by: OWNER }].map((row) => `${JSON.stringify({ schemaVersion: 1, tenant: 'endzone', actor: 'principal', ...row })}\n`).join('')) }, 'bounded-once'],
  ['an earlier bounded-ready row under a newer proposal', { seed: (root) => fs.appendFileSync(triage.ledgerPath(root, 'endzone'), `${JSON.stringify({ schemaVersion: 1, tenant: 'endzone', actor: 'principal', kind: 'bounded-ready', issue: 7, at: '2026-09-20T10:00:00.000Z', bodyHash: 'old' })}\n`) }, 'bounded-once'],
  ['Scope in a directory that is not in the repository', { proposal: { Scope: 'lists exactly db/migrations/x.js' } }, 'scope-unresolved', /does not exist/],
  ['Scope an absolute path', { proposal: { Scope: 'lists exactly /etc/passwd.js' } }, 'scope-unresolved'],
  ['Scope a drive-letter path', { proposal: { Scope: 'lists exactly E:/Endzone-Empire/server/db/migrations/x.js' } }, 'scope-unresolved'],
  ['Scope a basename only', { proposal: { Scope: 'lists exactly `20260929000001_fix.js` and `foo.service.js`' } }, 'scope-unresolved', /names no directory/],
  ['Scope with a .. segment', { proposal: { Scope: 'lists exactly server/services/../db/migrations/x.js' } }, 'scope-unresolved'],
  ['Scope a directory', { proposal: { Scope: 'lists exactly `server/services/`' } }, 'scope-unresolved'],
  ['Scope with a line anchor (#L12) on a risk file', { proposal: { Scope: 'lists exactly `server/modules/auth.js#L12`' } }, 'scope-risk-path', /auth/],
  ['Scope with :12:5 on a risk file', { proposal: { Scope: 'lists exactly `server/modules/auth.js:12:5`' } }, 'scope-risk-path'],
  ['Scope with :L12 on a risk file', { proposal: { Scope: 'lists exactly `server/modules/auth.js:L12`' } }, 'scope-risk-path'],
  ['Scope with a line range on a risk file', { proposal: { Scope: 'lists exactly `server/modules/auth.js:12-30`' } }, 'scope-risk-path'],
  ['Scope with an @sha suffix', { proposal: { Scope: 'lists exactly `server/modules/auth.js@abc1234`' } }, 'scope-unresolved'],
  ['Scope with a doubled slash', { proposal: { Scope: 'lists exactly `server/modules//auth.js`' } }, 'scope-unresolved'],
  ['Scope with a dot segment', { proposal: { Scope: 'lists exactly `server/./modules/auth.js`' } }, 'scope-unresolved'],
  ['Scope a risk file in another case (Auth.js)', { proposal: { Scope: 'lists exactly `server/modules/Auth.js`' } }, 'scope-risk-path'],
  ['Scope a risk file in another case (auth.JS)', { proposal: { Scope: 'lists exactly `server/modules/auth.JS`' } }, 'scope-risk-path'],
  ['Scope a file that differs only in case from an existing one', { files: { 'server/services/Foo.js': 'x' }, proposal: { Scope: 'lists exactly `server/services/foo.js`' } }, 'scope-unresolved', /differs only in case/],
  ['Scope a markdown link', { proposal: { Scope: 'lists exactly [auth](server/services/foo.js)' } }, 'scope-unresolved'],
  ['Scope with a prose token (etc)', { proposal: { Scope: 'lists exactly `server/services/foo.js`, etc' } }, 'scope-unresolved', /not a path/],
  ['Scope with an ellipsis', { proposal: { Scope: 'lists exactly `server/services/foo.js` and ...' } }, 'scope-unresolved'],
  ['Scope with a trailing description', { proposal: { Scope: 'lists exactly `server/services/foo.js` and the pool module' } }, 'scope-unresolved'],
  ['Scope a pattern', { proposal: { Scope: 'lists exactly `server/services/*.js`' } }, 'scope-unresolved'],
  ['Scope no path at all', { proposal: { Scope: 'the foo service' } }, 'scope-unresolved'],
  ['Scope a migration (the real Endzone carve-out)', { proposal: { Scope: 'lists exactly `server/db/migrations/0099_fix.sql` and `server/test/foo.test.js`' } }, 'scope-carve-out', /server\/db\/migrations\/0099_fix\.sql/],
  ['Scope a knexfile', { proposal: { Scope: 'lists exactly `server/knexfile.js`' } }, 'scope-carve-out', /knexfile/],
  ['Scope a workflow', { proposal: { Scope: 'lists exactly `.github/workflows/ci.yml`' } }, 'scope-carve-out'],
  ['Scope the auth module (a real risk-trigger path)', { proposal: { Scope: 'lists exactly `server/modules/auth.js`' } }, 'scope-risk-path', /auth/],
  ['Scope the advisory lock (a real risk-trigger path)', { proposal: { Scope: 'lists exactly `server/modules/advisoryLock.js`' } }, 'scope-risk-path', /concurrency/],
  ['Scope the scoring engine (a real risk-trigger path)', { proposal: { Scope: 'lists exactly `server/services/matchupScoring.service.js`' } }, 'scope-risk-path', /data-integrity/],
  ['Scope a file whose content holds FOR UPDATE', { files: { 'server/services/foo.js': 'const rows = await db.raw("SELECT * FROM t FOR UPDATE");' } }, 'scope-risk-pattern', /FOR UPDATE/],
  ['a body with 2 premises and a proposal block with 1', { body: `${B_BODY}server/db/x.js:3: x is set @abc1234\n` }, 'premises-unverified', /states 2 premise/],
  ['a proposal block with 2 lines under a body with 1', { proposal: { Premises: [PREMISE_LINE, '  server/db/x.js:3: x is set @abc1234 verified @def5678'] } }, 'premises-unverified', /states 1 premise/],
  ['a body that lacks the Premises heading', { body: 'The foo page crashes.\n' }, 'no-premises-heading'],
  ['Premises none stated while the body states one', { proposal: { Premises: 'none stated' } }, 'premises-unverified', /states 1 premise/],
  ['a proposal premise the body never states', { proposal: { Premises: ['  server/services/bar.js:9: bar reads a null @abc1234 verified @def5678'] } }, 'premises-unverified', /matches no premise/],
  ['a false premise', { proposal: { Premises: ['  server/services/foo.js:10: foo reads a null @abc1234 false: the code guards it at line 9'] } }, 'premises-unverified'],
  ['an unstamped premise', { proposal: { Premises: ['  server/services/foo.js:10: foo reads a null @abc1234'] } }, 'premises-unverified'],
  ['a premise verified at another sha', { proposal: { Premises: ['  server/services/foo.js:10: foo reads a null @abc1234 verified @0123456'] } }, 'premises-unverified', /premises-sha/],
  ['a proposal recorded without --premises-sha', { recordOver: { premisesSha: undefined } }, 'premises-unverified', /premises-sha/],
  ['the proposal comment edited after it was recorded', { proposalOver: { lastEditedAt: '2026-09-29T09:30:00.000Z' } }, 'edited-after-approval', /proposal-edited/],
  ['the issue body changed since the proposal', { issueOver: { body: 'The body was edited after the proposal.' } }, 'body-changed'],
  ['the recorded proposal comment is not in the thread', { recordOver: { commentUrl: 'https://github.com/owner/repo/issues/7#issuecomment-9999' } }, 'stale-proposal'],
  ['a newer proposal in the thread than the ledger\'s', { extraComments: [{ ...comment(FLEET, '## Triage proposal (advisory)\nClassification: bug', '2026-09-29T09:10:00.000Z'), url: 'https://github.com/owner/repo/issues/7#issuecomment-5002' }] }, 'stale-proposal'],
  ['a proposal recorded against a wake (an escalation ruling)', { recordOver: { recordId: 'endzone:issue-7' } }, 'escalation', /wake/],
  ['a stale-premise restatement', { recordOver: { reason: 'stale-premise', premise: 'server/x.js:1: y @abc1234' } }, 'needs-approval', /stale-premise/],
  ['a tenant with no carve-outs and no risk triggers', { tenantOver: { carveOuts: [], riskTriggers: {} } }, 'tenant-no-carve-outs'],
];

test('#210: every leaf of the class is refused with its own code, and a refusal changes nothing', () => {
  for (const [name, options, code, pattern] of LEAVES) {
    const world = boundedRoot(options);
    try { refusal(world, code, pattern); } catch (error) { throw new Error(`${name}: ${error.message}`); }
  }
});

test('#210: a decision-needed wake that preceded the proposal, consumed or not, is an escalation ruling and is refused', () => {
  const world = boundedRoot();
  fs.writeFileSync(path.join(world.root, 'state', 'watch', 'wake-outbox.jsonl'), `${JSON.stringify({ at: '2026-09-29T08:00:00.000Z', recordId: 'endzone:issue-7', wake: 'decision-needed', evidence: 'x' })}\n`);
  refusal(world, 'escalation', /wake/);
});

test('#210: a ticket with a closed blocked-by edge, or a body whose Premises section says none, is readied', () => {
  const closed = boundedRoot({ issueOver: { blockedBy: [{ number: 1745, state: 'CLOSED' }] } });
  assert.equal(closed.door().readied, true);
  const none = boundedRoot({ body: 'The foo page crashes.\n\n## Premises\n\nnone\n', proposal: { Premises: 'none stated' } });
  assert.equal(none.door().readied, true);
  const withBlock = boundedRoot({ body: 'The foo page crashes.\n\n## Premises\n\nnone\n' });
  assert.throws(() => withBlock.door(), (error) => error.condition === 'premises-unverified' && /states no premises/.test(error.message));
});

test('#210: every refusal names all of its failing conditions, and the first is the machine-readable one', () => {
  const world = boundedRoot({ proposal: { Tier: 'opus', Repro: 'none' }, labels: ['bug', 'triage-proposed', 'held'] });
  const codes = codesOf(world);
  for (const code of ['labels', 'tier', 'no-repro']) assert.ok(codes.includes(code), code);
  assert.equal(new Set(codes).size, codes.length, 'each listed once');
});

test('#210: at most 5 bounded readies per tenant per Central day; the sixth is refused, and a vetoed one still counts', () => {
  const rowsAt = (times) => times.map((at, index) => ({ schemaVersion: 1, kind: 'bounded-ready', tenant: 'endzone', issue: 101 + index, at, actor: 'principal' }));
  const seedRows = (times, extra = []) => (root) => fs.appendFileSync(triage.ledgerPath(root, 'endzone'), [...rowsAt(times), ...extra].map((row) => `${JSON.stringify(row)}\n`).join(''));
  const five = ['2026-09-29T05:30:00.000Z', '2026-09-29T08:00:00.000Z', '2026-09-29T13:00:00.000Z', '2026-09-29T14:00:00.000Z', '2026-09-29T14:30:00.000Z'];
  refusal(boundedRoot({ seed: seedRows(five, [{ schemaVersion: 1, kind: 'veto', tenant: 'endzone', issue: 105, at: '2026-09-29T14:40:00.000Z', actor: 'principal', by: OWNER }]) }), 'daily-cap', /5/);
  // 04:30Z on 09-29 is 23:30 CDT the day before: four on this Central day leave room for a fifth.
  const world = boundedRoot({ seed: seedRows(['2026-09-29T04:30:00.000Z', ...five.slice(1)]) });
  assert.equal(world.door().readied, true);
});

test('#210: no tenant flag, no bounded ready: Nidus and any tenant Cory has not enabled are refused without a GitHub read; a standing suspension refuses too', () => {
  const unflagged = boundedRoot({ flag: false });
  assert.throws(() => unflagged.door({ fixture: undefined, issues: undefined, runner: () => { throw new Error('no GitHub read may happen'); } }), (error) => error.code === 'BOUNDED_REFUSED' && error.condition === 'flag-absent');
  assert.equal(unflagged.pages.length, 0);
  refusal(boundedRoot({ flag: false }), 'flag-absent', /bounded-authority-endzone/);
  refusal(boundedRoot({ tenant: 'nidus', flag: false }), 'flag-absent');
  refusal(boundedRoot({ suspended: true }), 'suspended', /removing/);
  const world = boundedRoot({ flag: false });
  fs.writeFileSync(path.join(world.root, 'state', 'flags', 'bounded-authority-nidus'), '');
  refusal(world, 'flag-absent');
});

test('#210: a second ready on the same proposal, or a ready on an issue with no proposal, is refused', () => {
  const world = boundedRoot();
  world.door();
  world.calls.length = 0;
  world.pages.length = 0;
  // The standing row with its label present: nothing more to do (and the label in the fixture is what the door sees).
  fs.writeFileSync(world.fixture, JSON.stringify([{ ...world.bug, labels: ['bug', 'ready-for-agent'] }]));
  refusal(world, 'bounded-once', /already has its bounded ready/);
  const none = boundedRoot();
  assert.throws(() => bounded.boundedReady({ root: none.root, tenant: 'endzone', issue: 8, issues: [issue(8, { labels: ['bug'] })], now: BNOW, runner: none.runner, send: none.send, repo: none.repo }), (error) => error.condition === 'no-open-proposal');
});

test('#210: record cannot write a bounded ready, a veto or a suspension; only the doors can', () => {
  const world = boundedRoot();
  for (const kind of ['bounded-ready', 'veto', 'suspended']) {
    assert.throws(() => cli(['record', '--root', world.root, '--tenant', 'endzone', '--kind', kind, '--issue', '7', '--now', BNOW]), (error) => error.code === 'USAGE' && /door/.test(error.message), kind);
  }
});

test('#210: a bounded ready never enters the unchanged ratio that earned the authority', () => {
  const root = rootDir();
  const at = (day) => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  for (let n = 1; n <= 10; n += 1) {
    recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: n, bodyHash: `h${n}`, commentUrl: `https://x/${n}`, model: 'fable', now: at(n) });
    recordEntry({ root, tenant: 'endzone', kind: n === 10 ? 'approved-with-edits' : 'approved', issue: n, by: OWNER, edits: n === 10 ? 'narrower scope' : undefined, now: `2026-09-${String(n).padStart(2, '0')}T11:00:00.000Z` });
  }
  const before = projectTriage({ entries: readLedger(root, 'endzone'), now: NOW });
  for (const n of [21, 22, 23]) {
    recordEntry({ root, tenant: 'endzone', kind: 'proposed', issue: n, bodyHash: `h${n}`, commentUrl: `https://x/${n}`, model: 'fable', now: '2026-09-11T10:00:00.000Z' });
    recordEntry({ root, tenant: 'endzone', kind: 'bounded-ready', issue: n, bodyHash: `h${n}`, now: '2026-09-11T10:05:00.000Z' });
  }
  recordEntry({ root, tenant: 'endzone', kind: 'veto', issue: 23, by: OWNER, now: '2026-09-11T11:00:00.000Z' });
  const after = projectTriage({ entries: readLedger(root, 'endzone'), now: NOW });
  assert.deepEqual(after.allTime, before.allTime);
  assert.deepEqual(after.window, before.window);
  assert.equal(after.graduation.decided, before.graduation.decided);
  assert.equal(after.graduation.unchangedRatio, 0.9);
  assert.deepEqual(after.pending.map((entry) => entry.issue), [23], 'the vetoed proposal is awaiting Approval again; the two standing bounded readies are not pending');
});

test('#210: an owner Veto is an item on the Principal\'s frontier; the veto door removes the ready label, records the veto and returns the proposal to awaiting Approval', () => {
  const world = boundedRoot();
  world.door();
  const readyLabelled = { ...world.bug, labels: ['bug', 'ready-for-agent'] };
  fs.writeFileSync(world.fixture, JSON.stringify([readyLabelled]));
  // Nothing to do while the owner has said nothing.
  assert.deepEqual(computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:30:00.000Z' }).eligible, []);
  const vetoComment = { id: 'v1', url: 'https://github.com/owner/repo/issues/7#issuecomment-6001', author: OWNER, createdAt: '2026-09-29T15:20:00.000Z', body: 'Veto: this needs a design call first.' };
  fs.writeFileSync(world.fixture, JSON.stringify([{ ...readyLabelled, comments: [...world.bug.comments, vetoComment] }]));
  const frontier = computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:30:00.000Z' });
  assert.equal(frontier.eligible.length, 1);
  assert.equal(frontier.eligible[0].kind, 'veto');
  assert.equal(frontier.eligible[0].number, 7);
  assert.equal(frontier.eligible[0].commentUrl, vetoComment.url);
  world.calls.length = 0;
  const vetoed = bounded.vetoReady({ root: world.root, tenant: 'endzone', issue: 7, fixture: world.fixture, now: '2026-09-29T15:31:00.000Z', runner: (exe, args) => { world.calls.push([exe, ...args]); return ''; } });
  assert.equal(vetoed.vetoed, true);
  assert.deepEqual(world.calls, [['gh', 'issue', 'edit', '7', '-R', 'owner/repo', '--remove-label', 'ready-for-agent', '--add-label', 'triage-proposed']]);
  const rows = readLedger(world.root, 'endzone');
  const veto = rows.find((entry) => entry.kind === 'veto');
  assert.equal(veto.issue, 7);
  assert.equal(veto.by, OWNER);
  assert.equal(veto.commentUrl, vetoComment.url);
  assert.deepEqual(projectTriage({ entries: rows, now: '2026-09-29T16:00:00.000Z' }).pending.map((entry) => entry.issue), [7], 'awaiting Approval again');
  assert.deepEqual(require('../bin/assignment').plannerInputs({ root: world.root, tenant: 'endzone', tenantConfig: {} }).boundedReadies, []);
  assert.ok(!fs.existsSync(path.join(world.root, 'state', 'flags', 'bounded-authority-suspended-endzone')), 'a Veto suspends nothing');
  // B1: the issue is Cory's now. The door will not ready it a second time, however the proposal reads.
  fs.writeFileSync(world.fixture, JSON.stringify([{ ...world.bug, comments: [...world.bug.comments, vetoComment] }]));
  assert.throws(() => world.door({ now: '2026-09-29T17:00:00.000Z' }), (error) => error.condition === 'bounded-once' || error.condition === 'owner-spoke');
});

test('#210 m4: an Approval said before a Veto does not finalize what the Veto withdrew; a newer one does', () => {
  const world = boundedRoot();
  world.door();
  const approved = comment(OWNER, 'Approved', '2026-09-29T15:10:00.000Z', 'appr1');
  const vetoComment = { id: 'v1', url: 'https://github.com/owner/repo/issues/7#issuecomment-6001', author: OWNER, createdAt: '2026-09-29T15:20:00.000Z', body: 'Veto' };
  const thread = (labels, more = []) => fs.writeFileSync(world.fixture, JSON.stringify([{ ...world.bug, labels, comments: [...world.bug.comments, approved, vetoComment, ...more] }]));
  // propose, bounded ready, Approved, Veto: the veto item is all there is.
  thread(['bug', 'ready-for-agent']);
  assert.deepEqual(computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:30:00.000Z' }).eligible.map((item) => item.kind), ['veto']);
  const dry = bounded.vetoReady({ root: world.root, tenant: 'endzone', issue: 7, fixture: world.fixture, now: '2026-09-29T15:31:00.000Z', effects: false });
  assert.equal(dry.recorded, false);
  assert.ok(!readLedger(world.root, 'endzone').some((entry) => entry.kind === 'veto'), 'a dry veto records nothing');
  bounded.vetoReady({ root: world.root, tenant: 'endzone', issue: 7, fixture: world.fixture, now: '2026-09-29T15:31:00.000Z', runner: world.runner });
  thread(['bug', 'triage-proposed']);
  const after = computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:40:00.000Z' });
  assert.deepEqual(after.eligible, [], 'the earlier Approved is older than the veto row');
  assert.deepEqual(triage.finalizeApprovals({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:40:00.000Z' }).finalized, []);
  // A fresh Approved after the veto is an ordinary Approval again.
  thread(['bug', 'triage-proposed'], [comment(OWNER, 'Approved', '2026-09-29T16:10:00.000Z', 'appr2')]);
  assert.deepEqual(computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T16:20:00.000Z' }).eligible.map((item) => item.kind), ['approval']);
});

test('#210 (#207 clause 1): a standing bounded ready plus a later Approved: finalize leaves it decided and the frontier\'s approval step lists nothing', () => {
  const world = boundedRoot();
  world.door();
  fs.writeFileSync(world.fixture, JSON.stringify([{ ...world.bug, labels: ['bug', 'ready-for-agent'], comments: [...world.bug.comments, comment(OWNER, 'Approved', '2026-09-29T15:10:00.000Z')] }]));
  const result = triage.finalizeApprovals({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:20:00.000Z' });
  assert.deepEqual(result.finalized, []);
  assert.deepEqual(result.left.map((entry) => [entry.issue, entry.reason]), [[7, 'decided']]);
  assert.deepEqual(computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:20:00.000Z' }).eligible, []);
});

test('#210: the veto door refuses when the owner has not vetoed, when only the fleet says Veto, and when there is no standing bounded ready', () => {
  const world = boundedRoot();
  world.door();
  const veto = (over = {}) => bounded.vetoReady({ root: world.root, tenant: 'endzone', issue: 7, fixture: world.fixture, now: '2026-09-29T15:31:00.000Z', runner: () => { throw new Error('no label change may happen'); }, ...over });
  assert.throws(() => veto(), (error) => error.code === 'TRIAGE_NO_VETO');
  const fleetOnly = { ...world.bug, labels: ['bug', 'ready-for-agent'], comments: [...world.bug.comments, { id: 'v1', url: 'https://x/v1', author: FLEET, createdAt: '2026-09-29T15:20:00.000Z', body: 'Veto: pretending to be the owner' }] };
  fs.writeFileSync(world.fixture, JSON.stringify([fleetOnly]));
  assert.throws(() => veto(), (error) => error.code === 'TRIAGE_NO_VETO');
  const early = { ...fleetOnly, comments: [{ id: 'v0', url: 'https://x/v0', author: OWNER, createdAt: '2026-09-29T14:00:00.000Z', body: 'Veto: before the ready' }, ...world.bug.comments] };
  fs.writeFileSync(world.fixture, JSON.stringify([early]));
  assert.throws(() => veto(), (error) => error.code === 'TRIAGE_NO_VETO', 'a Veto before the ready withdraws nothing');
  const unreadied = boundedRoot();
  assert.throws(() => bounded.vetoReady({ root: unreadied.root, tenant: 'endzone', issue: 7, fixture: unreadied.fixture, now: BNOW, runner: () => '' }), (error) => error.code === 'TRIAGE_NO_BOUNDED_READY');
});

// ---------------------------------------------------------------------------
// Spec fleet #193 (#211): Bounded authority suspends itself on failure evidence.
// The suspension scan (bin/bounded-authority.js, run by the bounded-ready door and by
// the daily summary) reads the triage ledger, the event ledger, the findings artifacts
// and the tenant's bugs, and writes the suspension flag on:
//   - an escalation or a send-back on a bounded ticket marked `criteria-defect`
//     (the escalation reason, or a finding category), never free text;
//   - a bug (open or closed) whose escape names a PR that delivered a bounded ticket.
// A Veto is not evidence. Only removing the flag lifts a suspension.
// ---------------------------------------------------------------------------
const workState = require('../bin/work-state');

const SUSPENDED_FLAG = (root) => path.join(root, 'state', 'flags', 'bounded-authority-suspended-endzone');
const AFTER_READY = '2026-09-29T17:05:00.000Z';   // past the 2 hour window that started at BNOW

// A bounded ready on issue 7 (through the door) and its Work record on PR 1007, implementing.
function readiedUnit(over = {}) {
  const world = boundedRoot(over);
  world.door();
  const id = 'endzone:issue-7';
  workState.createRecord({ root: world.root, id, tenant: 'endzone', issue: 7, state: 'implementing', github: { issueNumber: 7, prNumber: 1007 }, actor: 'test', idempotencyKey: 'c-7', now: AFTER_READY });
  return { ...world, id };
}

function escalate(world, { reason, now = '2026-09-29T18:00:00.000Z', id = world.id, key = 'esc-7', evidence = 'wake:decision-needed; the acceptance criteria contradict each other', revision = 1 } = {}) {
  return workState.transitionRecord({ root: world.root, id, to: 'escalated', expectedRevision: revision, evidence, ...(reason ? { reason } : {}), idempotencyKey: key, actor: 'pl-endzone', now });
}

// A record walked to review with a formal review whose artifact carries `category`, then sent back.
function sendBack(world, category, { now = '2026-09-29T19:00:00.000Z', from = 1, tag = '' } = {}) {
  const at = (minutes) => new Date(new Date(now).getTime() + minutes * 60000).toISOString();
  let revision = from;
  for (const [index, to] of ['pr-open', 'ci-wait', 'review'].entries()) {
    revision = workState.transitionRecord({ root: world.root, id: world.id, to, expectedRevision: revision, idempotencyKey: `s-${tag}${to}`, actor: 'pr-watch', evidence: to, now: at(index) }).revision;
  }
  const relative = 'state/reviews/endzone_issue-7/formal-001.json';
  fs.mkdirSync(path.join(world.root, 'state', 'reviews', 'endzone_issue-7'), { recursive: true });
  fs.writeFileSync(path.join(world.root, relative), JSON.stringify({ findings: [{ id: 'f1', severity: 'major', category, status: 'open', summary: 'the criterion cannot be met as written' }] }));
  revision = workState.recordReview({ root: world.root, id: world.id, expectedRevision: revision, actor: 'pl-endzone', idempotencyKey: `formal-${tag}7`, now: at(4), review: { kind: 'formal', headSha: (tag ? 'b' : 'a').repeat(40), artifact: relative } }).revision;
  return workState.transitionRecord({ root: world.root, id: world.id, to: 'revision', expectedRevision: revision, idempotencyKey: `back-${tag}7`, actor: 'pl-endzone', evidence: 'sent back with the findings artifact', now: at(6) });
}

function suspensionRows(world) { return readLedger(world.root, 'endzone').filter((entry) => entry.kind === 'suspended'); }

test('#211: an escalation marked criteria-defect on a bounded ticket writes the suspension flag and its ledger row; the door then refuses', () => {
  const world = readiedUnit();
  escalate(world, { reason: 'criteria-defect' });
  assert.ok(!fs.existsSync(SUSPENDED_FLAG(world.root)));
  const scan = bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-29T18:05:00.000Z' });
  assert.equal(scan.suspended, true);
  assert.equal(scan.wrote, true);
  const flag = JSON.parse(fs.readFileSync(SUSPENDED_FLAG(world.root), 'utf8'));
  assert.equal(flag.tenant, 'endzone');
  assert.equal(flag.cause, 'escalation');
  assert.equal(flag.issue, 7);
  assert.equal(flag.at, '2026-09-29T18:05:00.000Z');
  const rows = suspensionRows(world);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cause, 'escalation');
  assert.equal(rows[0].standing, false);
  assert.deepEqual(rows[0].evidenceIds, ['escalation:endzone:issue-7:criteria-defect'], 'ids name the cause, not the event');
  const another = boundedRoot();
  fs.copyFileSync(SUSPENDED_FLAG(world.root), SUSPENDED_FLAG(another.root));
  refusal(another, 'suspended');
  const again = bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-29T18:10:00.000Z' });
  assert.equal(again.wrote, false);
  assert.equal(suspensionRows(world).length, 1);
});

test('#211: the bounded-ready door scans first, so evidence that arrived since the last scan stops the very next ready', () => {
  const world = readiedUnit();
  escalate(world, { reason: 'criteria-defect' });
  const other = issue(8, { labels: ['bug', 'triage-proposed'], body: B_BODY, comments: [{ id: 'p8', url: 'https://github.com/owner/repo/issues/8#issuecomment-8001', author: FLEET, createdAt: '2026-09-29T09:30:00.000Z', body: proposalBody() }] });
  recordEntry({ root: world.root, tenant: 'endzone', kind: 'proposed', issue: 8, bodyHash: triage.normalizeIssue(other).bodyHash, commentUrl: 'https://github.com/owner/repo/issues/8#issuecomment-8001', model: 'fable', premisesSha: PREMISE_SHA, now: '2026-09-29T09:30:01.000Z' });
  fs.writeFileSync(world.fixture, JSON.stringify([world.bug, other]));
  assert.throws(() => bounded.boundedReady({ root: world.root, tenant: 'endzone', issue: 8, fixture: world.fixture, now: '2026-09-29T18:30:00.000Z', runner: world.runner, send: () => ({ ok: true }), repo: world.repo }), (error) => error.condition === 'suspended');
  assert.ok(fs.existsSync(SUSPENDED_FLAG(world.root)), 'the door wrote the flag it found evidence for');
});

test('#211: a send-back on a bounded ticket whose finding category is criteria-defect suspends; any other category does not', () => {
  const marked = readiedUnit();
  sendBack(marked, 'criteria-defect');
  assert.equal(bounded.scanSuspension({ root: marked.root, tenant: 'endzone', now: '2026-09-29T20:00:00.000Z' }).suspended, true);
  assert.equal(suspensionRows(marked)[0].cause, 'send-back');
  assert.match(suspensionRows(marked)[0].evidenceIds[0], /^send-back:endzone:issue-7:state\/reviews\/endzone_issue-7\/formal-001\.json$/);
  const ordinary = readiedUnit();
  sendBack(ordinary, 'correctness');
  const scan = bounded.scanSuspension({ root: ordinary.root, tenant: 'endzone', now: '2026-09-29T20:00:00.000Z' });
  assert.equal(scan.suspended, false);
  assert.ok(!fs.existsSync(SUSPENDED_FLAG(ordinary.root)));
});

test('#211 m5: a walk-back that re-emits a send-back for the same artifact is the same evidence and does not re-suspend after the flag is removed', () => {
  const world = readiedUnit();
  sendBack(world, 'criteria-defect');
  bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-29T20:00:00.000Z' });
  fs.rmSync(SUSPENDED_FLAG(world.root));
  // pr-watch walks the record back to review and the lead sends it back again over the same artifact.
  const record = workState.getRecord({ root: world.root, id: world.id });
  sendBack(world, 'criteria-defect', { now: '2026-09-30T09:00:00.000Z', from: record.revision, tag: 'r2-' });
  const scan = bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-30T10:00:00.000Z' });
  assert.equal(scan.suspended, false, 'the same cause Cory already ruled on');
  assert.equal(suspensionRows(world).length, 1);
});

test('#211: an escalation without the named reason is not a criteria mark, whatever its free text says, and another named reason is not one either', () => {
  const world = readiedUnit();
  escalate(world, { evidence: 'wake:decision-needed; criteria-defect: the criteria were wrong' });
  const scan = bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-29T18:05:00.000Z' });
  assert.equal(scan.suspended, false);
  assert.deepEqual(scan.evidence, []);
  const stale = readiedUnit();
  workState.transitionRecord({ root: stale.root, id: stale.id, to: 'escalated', expectedRevision: 1, evidence: 'wake:decision-needed; a premise moved', reason: 'stale-premise', premise: 'server/x.js:1: y @abc1234', idempotencyKey: 'esc-stale', actor: 'pl-endzone', now: '2026-09-29T18:00:00.000Z' });
  assert.equal(bounded.scanSuspension({ root: stale.root, tenant: 'endzone', now: '2026-09-29T18:05:00.000Z' }).suspended, false, 'stale-premise is not a criteria mark');
});

test('#211: a criteria mark on a ticket that was not readied under Bounded authority, or before its ready, suspends nothing', () => {
  const world = boundedRoot();
  workState.createRecord({ root: world.root, id: 'endzone:issue-7', tenant: 'endzone', issue: 7, state: 'implementing', github: { issueNumber: 7, prNumber: 1007 }, actor: 'test', idempotencyKey: 'c-7', now: AFTER_READY });
  escalate({ ...world, id: 'endzone:issue-7' }, { reason: 'criteria-defect' });
  assert.equal(bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-29T18:05:00.000Z' }).suspended, false);
  const early = boundedRoot();
  workState.createRecord({ root: early.root, id: 'endzone:issue-7', tenant: 'endzone', issue: 7, state: 'implementing', github: { issueNumber: 7, prNumber: 1007 }, actor: 'test', idempotencyKey: 'c-7', now: '2026-09-29T08:00:00.000Z' });
  escalate({ ...early, id: 'endzone:issue-7' }, { reason: 'criteria-defect', now: '2026-09-29T08:30:00.000Z' });
  // The ready is recorded after the mark (a raw row: the door itself would refuse a ticket with a Work record).
  fs.appendFileSync(triage.ledgerPath(early.root, 'endzone'), `${JSON.stringify({ schemaVersion: 1, kind: 'bounded-ready', tenant: 'endzone', issue: 7, at: BNOW, actor: 'principal', bodyHash: early.bodyHash })}
`);
  assert.equal(bounded.scanSuspension({ root: early.root, tenant: 'endzone', now: '2026-09-29T18:05:00.000Z' }).suspended, false);
});

function escapedBug({ number = 8, form = null, line = null, state = 'OPEN', createdAt = '2026-09-30T00:00:00.000Z', heading = '## Triage proposal (advisory)', comments } = {}) {
  const body = form === null ? 'Something broke after a fleet PR.' : `### What happened\n\nboom\n\n### Escaped from PR #\n\n${form}\n`;
  const proposal = line === null ? [] : [{ id: `p${number}`, url: `https://github.com/owner/repo/issues/${number}#issuecomment-${number}001`, author: FLEET, createdAt: '2026-09-30T09:00:00.000Z', body: `${heading}\nClassification: bug\nEscaped from: ${line}` }];
  return { ...issue(number, { labels: ['bug'], body, createdAt, comments: comments || proposal }), state };
}

test('#211: a bug, open or closed, whose escape names the PR that delivered a bounded ticket writes the suspension flag: the form field, or the proposal line read leniently', () => {
  for (const [label, bug] of [
    ['a closed bug with the form field 1007', escapedBug({ form: '1007', state: 'CLOSED' })],
    ['an open bug with the proposal line #1007', escapedBug({ line: '#1007' })],
    ['a proposal line "PR #1007"', escapedBug({ line: 'PR #1007' })],
    ['a proposal line "1007"', escapedBug({ line: '1007' })],
    ['a Ruling that restates it', escapedBug({ line: '#1007', heading: '## Ruling' })],
  ]) {
    const world = readiedUnit();
    const scan = bounded.scanSuspension({ root: world.root, tenant: 'endzone', issues: [world.bug, bug], now: '2026-09-30T10:00:00.000Z' });
    assert.equal(scan.suspended, true, label);
    const flag = JSON.parse(fs.readFileSync(SUSPENDED_FLAG(world.root), 'utf8'));
    assert.equal(flag.cause, 'escape');
    assert.equal(flag.issue, 7);
    assert.equal(flag.bug, 8);
    assert.equal(flag.pr, 1007);
    assert.deepEqual(suspensionRows(world)[0].evidenceIds, ['escape:8:1007']);
  }
});

test('#211: Escaped from another PR, none or unknown, a bug older than the ready, a non-bug, or bugs the scan was not shown, does not suspend', () => {
  for (const [label, bug] of [
    ['another PR', escapedBug({ line: '#999' })],
    ['none', escapedBug({ line: 'none' })],
    ['unknown', escapedBug({ line: 'unknown' })],
    ['a bug that predates the ready', escapedBug({ form: '1007', createdAt: '2026-09-20T00:00:00.000Z' })],
    ['an issue without the bug label', { ...escapedBug({ form: '1007' }), labels: ['question'] }],
  ]) {
    const world = readiedUnit();
    assert.equal(bounded.scanSuspension({ root: world.root, tenant: 'endzone', issues: [world.bug, bug], now: '2026-09-30T10:00:00.000Z' }).suspended, false, label);
  }
  const world = readiedUnit();
  assert.equal(bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-30T10:00:00.000Z' }).suspended, false, 'with no bugs to read the local evidence alone decides');
});

test('#211: a Veto does not suspend', () => {
  const world = readiedUnit();
  const vetoedIssue = { ...world.bug, labels: ['bug', 'ready-for-agent'], comments: [...world.bug.comments, { id: 'v1', url: 'https://github.com/owner/repo/issues/7#issuecomment-6001', author: OWNER, createdAt: '2026-09-29T15:20:00.000Z', body: 'Veto: not now.' }] };
  fs.writeFileSync(world.fixture, JSON.stringify([vetoedIssue]));
  bounded.vetoReady({ root: world.root, tenant: 'endzone', issue: 7, fixture: world.fixture, now: '2026-09-29T15:31:00.000Z', runner: world.runner });
  const scan = bounded.scanSuspension({ root: world.root, tenant: 'endzone', issues: [vetoedIssue], now: '2026-09-29T16:00:00.000Z' });
  assert.equal(scan.suspended, false);
  assert.ok(!fs.existsSync(SUSPENDED_FLAG(world.root)));
  assert.equal(suspensionRows(world).length, 0);
});

test('#211: only removing the flag lifts a suspension, and the same evidence never suspends twice; new evidence does', () => {
  const world = readiedUnit();
  escalate(world, { reason: 'criteria-defect' });
  bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-29T18:05:00.000Z' });
  assert.equal(bounded.isSuspended(world.root, 'endzone'), true);
  bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-10-05T00:00:00.000Z' });
  assert.equal(bounded.isSuspended(world.root, 'endzone'), true);
  fs.rmSync(SUSPENDED_FLAG(world.root));
  const lifted = bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-10-05T00:00:00.000Z' });
  assert.equal(lifted.suspended, false, 'the evidence Cory already ruled on does not re-suspend');
  assert.equal(suspensionRows(world).length, 1);
  fs.appendFileSync(triage.ledgerPath(world.root, 'endzone'), `${JSON.stringify({ schemaVersion: 1, kind: 'bounded-ready', tenant: 'endzone', issue: 12, at: '2026-10-05T01:00:00.000Z', actor: 'principal', bodyHash: 'h12' })}\n`);
  workState.createRecord({ root: world.root, id: 'endzone:issue-12', tenant: 'endzone', issue: 12, state: 'implementing', github: { issueNumber: 12, prNumber: 1012 }, actor: 'test', idempotencyKey: 'c-12', now: '2026-10-05T04:00:00.000Z' });
  escalate({ ...world, id: 'endzone:issue-12' }, { reason: 'criteria-defect', now: '2026-10-05T05:00:00.000Z', key: 'esc-12' });
  const again = bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-10-05T06:00:00.000Z' });
  assert.equal(again.suspended, true);
  assert.equal(suspensionRows(world).length, 2);
  assert.equal(suspensionRows(world)[1].issue, 12);
});

test('#211: evidence that arrives while a suspension stands is recorded once and does not re-suspend after the flag is removed', () => {
  const world = readiedUnit();
  escalate(world, { reason: 'criteria-defect' });
  bounded.scanSuspension({ root: world.root, tenant: 'endzone', now: '2026-09-29T18:05:00.000Z' });
  const bug = escapedBug({ line: '#1007' });
  const during = bounded.scanSuspension({ root: world.root, tenant: 'endzone', issues: [world.bug, bug], now: '2026-09-30T10:00:00.000Z' });
  assert.equal(during.wrote, false, 'the flag already stands');
  const rows = suspensionRows(world);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].standing, true, 'logged as evidence, not counted as a second suspension');
  fs.rmSync(SUSPENDED_FLAG(world.root));
  assert.equal(bounded.scanSuspension({ root: world.root, tenant: 'endzone', issues: [world.bug, bug], now: '2026-09-30T11:00:00.000Z' }).suspended, false);
});

test('#211: bounded-scan is a triage door: it runs the scan from the CLI against a fixture', () => {
  const world = readiedUnit();
  escalate(world, { reason: 'criteria-defect' });
  const out = cli(['bounded-scan', '--root', world.root, '--tenant', 'endzone', '--fixture', world.fixture, '--now', '2026-09-29T18:05:00.000Z']);
  assert.equal(out.suspended, true, 'it reports what it would suspend on');
  assert.equal(out.dryRun, true);
  assert.equal(out.wrote, false);
  assert.ok(!fs.existsSync(SUSPENDED_FLAG(world.root)), 'a fixture scan writes no flag (QA B-1)');
  assert.equal(suspensionRows(world).length, 0);
});

// ---------------------------------------------------------------------------
// Re-QA of the rework (2026-09-29): B-1, M-A and the minors.
// ---------------------------------------------------------------------------

test('#210 B-1: --fixture on the fleet\'s own root is refused before anything is read, on every bounded door', () => {
  const world = boundedRoot();
  for (const door of ['bounded-ready', 'veto']) {
    assert.throws(() => cli([door, '--tenant', 'endzone', '--issue', '7', '--fixture', world.fixture]), (error) => error.code === 'USAGE' && /own root/.test(error.message), `${door} with the default root`);
    assert.throws(() => cli([door, '--root', path.join(__dirname, '..'), '--tenant', 'endzone', '--issue', '7', '--fixture', world.fixture]), (error) => error.code === 'USAGE' && /own root/.test(error.message), `${door} with the root named`);
  }
  assert.throws(() => cli(['bounded-scan', '--tenant', 'endzone', '--fixture', world.fixture]), (error) => error.code === 'USAGE' && /own root/.test(error.message));
});

test('#210 B-1: the row records that Cory was paged; a repair refuses a row that did not page, and the frontier does not offer one', () => {
  const world = boundedRoot();
  world.door();
  const row = readLedger(world.root, 'endzone').find((entry) => entry.kind === 'bounded-ready');
  assert.equal(row.paged, true);
  assert.match(row.pageDetail, /pushover/);
  // A row with no paged flag (whatever wrote it) is never repaired into a ready label.
  const raw = boundedRoot();
  fs.appendFileSync(triage.ledgerPath(raw.root, 'endzone'), `${JSON.stringify({ schemaVersion: 1, kind: 'bounded-ready', tenant: 'endzone', issue: 7, at: BNOW, actor: 'principal', bodyHash: raw.bodyHash })}\n`);
  assert.deepEqual(computeFrontier({ root: raw.root, tenant: 'endzone', fixture: raw.fixture, now: '2026-09-29T15:30:00.000Z' }).eligible, []);
  assert.throws(() => raw.door({ now: '2026-09-29T15:31:00.000Z' }), (error) => error.condition === 'unpaged-ready');
  assert.equal(raw.calls.length, 0);
});

test('#210 B-1: a repair re-checks what the door checked: a held label, a hold, a Work record', () => {
  const failLabel = () => { const world = boundedRoot(); assert.throws(() => world.door({ runner: () => { throw new Error('gh 502'); } }), (error) => error.code === 'GITHUB_WRITE_FAILED'); return world; };
  const held = failLabel();
  fs.writeFileSync(held.fixture, JSON.stringify([{ ...held.bug, labels: ['bug', 'held'] }]));
  assert.throws(() => held.door(), (error) => error.condition === 'labels');
  assert.ok(!computeFrontier({ root: held.root, tenant: 'endzone', fixture: held.fixture, now: '2026-09-29T15:30:00.000Z' }).eligible.some((item) => item.kind === 'bounded-repair'), 'no repair is offered on a held issue');
  const skipped = failLabel();
  SKIP(skipped.root);
  assert.throws(() => skipped.door(), (error) => error.condition === 'held');
  const worked = failLabel();
  fs.mkdirSync(path.join(worked.root, 'state', 'work'), { recursive: true });
  fs.writeFileSync(path.join(worked.root, 'state', 'work', 'active.json'), JSON.stringify({ records: { 'endzone:issue-7': { id: 'endzone:issue-7', state: 'implementing' } } }));
  assert.throws(() => worked.door(), (error) => error.condition === 'live-work');
});

test('#210 minors: a proposal recorded in the door\'s future refuses, the owner-spoke floor is the earlier of the ledger time and the comment time, and the gate\'s edited code stays', () => {
  refusal(boundedRoot({ recordOver: { now: '2026-09-30T09:00:00.000Z' } }), 'proposal-in-future');
  // The ledger says the proposal was recorded tomorrow, but the comment is from this morning: the owner's later comment still counts.
  const spoke = boundedRoot({ recordOver: { now: '2026-09-30T09:00:00.000Z' }, extraComments: [comment(OWNER, 'No, do not ready this', '2026-09-29T10:00:00.000Z')] });
  assert.ok(codesOf(spoke).includes('owner-spoke'));
  const edited = boundedRoot({ proposalOver: { lastEditedAt: '2026-09-29T09:00:00.800Z' } });
  assert.ok(codesOf(edited).includes('edited-after-approval'), 'edited after it was posted, though before it was recorded');
  const world = boundedRoot();
  assert.throws(() => cli(['record', '--root', world.root, '--tenant', 'endzone', '--kind', 'proposed', '--issue', '9', '--body-hash', 'h', '--comment-url', 'https://x/9', '--model', 'fable', '--now', '2099-01-01T00:00:00.000Z']), (error) => error.code === 'USAGE' && /future/.test(error.message));
});

// ---------------------------------------------------------------------------
// Final QA pass: one repair predicate, the mutation survivors, the size cap.
// ---------------------------------------------------------------------------

test('#210 minor 6: the frontier\'s bounded-repair item and the door\'s repair are one predicate: whatever the door refuses, the frontier does not offer', () => {
  const failLabel = () => { const world = boundedRoot(); assert.throws(() => world.door({ runner: () => { throw new Error('gh 502'); } }), (error) => error.code === 'GITHUB_WRITE_FAILED'); return world; };
  const offered = (world) => computeFrontier({ root: world.root, tenant: 'endzone', fixture: world.fixture, now: '2026-09-29T15:30:00.000Z' }).eligible.some((item) => item.kind === 'bounded-repair');
  // Control: nothing wrong, so both agree the label may be re-applied.
  const control = failLabel();
  assert.equal(offered(control), true);
  assert.equal(control.door({ now: '2026-09-29T15:31:00.000Z' }).repaired, true);
  const variations = [
    ['an owner comment in another case of the login', (world) => fs.writeFileSync(world.fixture, JSON.stringify([{ ...world.bug, comments: [...world.bug.comments, comment(OWNER.toUpperCase(), 'wait', '2026-09-29T15:10:00.000Z')] }])), 'owner-spoke'],
    ['a changed body', (world) => fs.writeFileSync(world.fixture, JSON.stringify([{ ...world.bug, body: 'a different ticket now' }])), 'body-changed'],
    ['a newer proposal', (world) => recordEntry({ root: world.root, tenant: 'endzone', kind: 'proposed', issue: 7, bodyHash: world.bodyHash, commentUrl: PROPOSAL_URL, model: 'fable', now: '2026-09-29T16:00:00.000Z' }), 'bounded-once'],
    ['a held label', (world) => fs.writeFileSync(world.fixture, JSON.stringify([{ ...world.bug, labels: ['bug', 'held'] }])), 'labels'],
    ['a skip-file hold', (world) => SKIP(world.root), 'held'],
    ['a Work record', (world) => { fs.mkdirSync(path.join(world.root, 'state', 'work'), { recursive: true }); fs.writeFileSync(path.join(world.root, 'state', 'work', 'active.json'), JSON.stringify({ records: { 'endzone:issue-7': { id: 'endzone:issue-7', state: 'implementing' } } })); }, 'live-work'],
    ['the ready label already on', (world) => fs.writeFileSync(world.fixture, JSON.stringify([{ ...world.bug, labels: ['bug', 'ready-for-agent'] }])), 'bounded-once'],
  ];
  for (const [name, change, condition] of variations) {
    const world = failLabel();
    change(world);
    assert.equal(offered(world), false, 'the frontier offers no repair after ' + name);
    assert.throws(() => world.door({ now: '2026-09-29T15:31:00.000Z' }), (error) => error.condition === condition, 'the door refuses after ' + name);
  }
});

test('#210 minor 7: a fixture run that finds suspension evidence still refuses (a dry run reports what it would suspend on)', () => {
  const world = readiedUnit();
  escalate(world, { reason: 'criteria-defect' });
  // A second ticket's proposal, run as a dry fixture (effects off): no flag exists yet, the evidence alone refuses it.
  const other = issue(8, { labels: ['bug', 'triage-proposed'], body: B_BODY, comments: [{ id: 'p8', url: 'https://github.com/owner/repo/issues/8#issuecomment-8001', author: FLEET, createdAt: '2026-09-29T09:30:00.000Z', body: proposalBody() }] });
  recordEntry({ root: world.root, tenant: 'endzone', kind: 'proposed', issue: 8, bodyHash: triage.normalizeIssue(other).bodyHash, commentUrl: 'https://github.com/owner/repo/issues/8#issuecomment-8001', model: 'fable', premisesSha: PREMISE_SHA, now: '2026-09-29T09:30:01.000Z' });
  fs.writeFileSync(world.fixture, JSON.stringify([world.bug, other]));
  assert.ok(!fs.existsSync(SUSPENDED_FLAG(world.root)));
  assert.throws(() => bounded.boundedReady({ root: world.root, tenant: 'endzone', issue: 8, fixture: world.fixture, now: '2026-09-29T18:30:00.000Z', effects: false, repo: world.repo }), (error) => error.condition === 'suspended');
  assert.ok(!fs.existsSync(SUSPENDED_FLAG(world.root)), 'and the dry run wrote no flag');
});

test('#210 minor 7: a new file whose name differs only in case is judged against the carve-out and risk globs case-insensitively', () => {
  for (const [scope, code] of [
    ['lists exactly `server/modules/AUTH.js`', 'scope-risk-path'],
    ['lists exactly `server/db/migrations/0099_FIX.SQL`', 'scope-carve-out'],
    ['lists exactly `.GITHUB/workflows/ci.yml`', 'scope-unresolved'],
    ['lists exactly `server/services/WAIVER.service.js`', 'scope-risk-path'],
  ]) {
    refusal(boundedRoot({ proposal: { Scope: scope } }), code);
  }
});

test('#210 minor 8: a Scope of more than 25 paths refuses scope-unresolved, so a proposal cannot spend the door on git calls', () => {
  const many = Array.from({ length: 26 }, (_, index) => 'server/services/f' + index + '.js');
  refusal(boundedRoot({ proposal: { Scope: 'lists exactly ' + many.join(', ') } }), 'scope-unresolved', /more than 25/);
  const ok = Array.from({ length: 25 }, (_, index) => 'server/services/f' + index + '.js');
  const world = boundedRoot({ proposal: { Scope: 'lists exactly ' + ok.join(', ') } });
  assert.equal(world.door().readied, true);
});
