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
  assert.deepEqual(Object.keys(TRIAGE_FLAGS), ['frontier', 'record', 'state', 'hash', 'finalize']);
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
  assert.equal(result.left[0].reason, 'no-open-proposal');
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
