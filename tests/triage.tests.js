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
  const tenant = { name: 'endzone', github: 'owner/repo', readyLabel: 'ready-for-agent', fleetIdentity: FLEET };
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
  assert.throws(() => recordEntry({ root, tenant: 'endzone', kind: 'rejected', issue: 1, by: OWNER, now: '2026-09-10T03:00:00.000Z' }), { code: 'TRIAGE_OUTCOME_RECORDED' });
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
  assert.deepEqual(Object.keys(TRIAGE_FLAGS), ['frontier', 'record', 'state', 'hash']);
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
