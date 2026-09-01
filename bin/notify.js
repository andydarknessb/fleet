'use strict';
// Ticket 07: the minimal ephemeral notifier. It is a process, not a session: it
// receives (or scans for) a decision event, claims it through the state command,
// sends ONE push over the configured channel, records notification-sent or
// notification-failed, and exits. It never waits, polls, or re-pages: a failed
// delivery stays visible in the digest until `work-state.js notify --phase
// authorize-retry` or a materially new decision event. Zero model turns.
//
// Delivery is gated: without state/flags/notifier-live (or --live) the notifier
// runs in shadow, logging the page it would have sent to state/notify/shadow.jsonl
// and touching no Work record. The legacy Dispatcher relay stays authoritative
// until cutover, exactly as the pr-watch wakes did at ticket 04.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const workState = require('./work-state');

const { DECISION_STATES } = workState;
const MAX_BODY_CHARS = 600;
const MAX_BODY_LINES = 6;

function baseOf(root) {
  return path.resolve(root || path.resolve(__dirname, '..'));
}

function isLive({ root, live } = {}) {
  if (live === true) return true;
  return fs.existsSync(path.join(baseOf(root), 'state', 'flags', 'notifier-live'));
}

// Pointer message: what a page is allowed to carry. Locations, never content.
function buildPointerMessage({ root, record, event, tenantConfig = {} } = {}) {
  const base = baseOf(root);
  const state = event.type.slice('state-'.length);
  const prNumber = record.github?.prNumber || event.changes?.prNumber || null;
  const repo = tenantConfig.github || null;
  const artifacts = [
    `${path.join('state', 'work', 'active.json')}#${record.id}`,
    `${path.join('state', 'events', `${String(event.at).slice(0, 10)}.jsonl`)}#seq-${event.sequence}`,
    path.join('state', 'status', 'DIGEST.md'),
  ];
  if (repo && prNumber) artifacts.push(`https://github.com/${repo}/pull/${prNumber}`);
  if (repo && record.issue) artifacts.push(`https://github.com/${repo}/issues/${record.issue}`);
  const pointer = { recordId: record.id, revision: record.revision, eventSequence: event.sequence, decisionType: event.type, artifacts };
  const title = `Fleet decision: ${record.tenant} #${record.issue}`;
  const body = [
    `${state} - ${record.id} r${record.revision} seq${event.sequence}${prNumber ? ` - PR #${prNumber}` : ''}`,
    `evidence: ${artifacts[1]} - digest: ${artifacts[2]} - run bin\\status.ps1`,
  ].join('\n');
  return { title, body, pointer, base };
}

// The fixture: a page is a typed pointer, not a copy of the issue, criteria,
// findings, or a prior message.
function validatePointerMessage(message) {
  const reasons = [];
  const pointer = message?.pointer;
  if (!pointer || typeof pointer !== 'object') reasons.push('pointer is missing');
  else {
    if (!pointer.recordId) reasons.push('pointer.recordId is missing');
    if (!Number.isInteger(Number(pointer.revision)) || Number(pointer.revision) <= 0) reasons.push('pointer.revision is missing');
    if (!Number.isInteger(Number(pointer.eventSequence)) || Number(pointer.eventSequence) <= 0) reasons.push('pointer.eventSequence is missing');
    if (!Array.isArray(pointer.artifacts) || pointer.artifacts.length === 0) reasons.push('pointer.artifacts is empty');
  }
  const text = `${message?.title || ''}\n${message?.body || ''}`;
  if (!String(message?.title || '').trim()) reasons.push('title is empty');
  if (/^\s*[-*]\s*\[[ xX]\]/m.test(text)) reasons.push('body carries a checklist (copied criteria)');
  if (/acceptance criteria/i.test(text)) reasons.push('body names acceptance criteria');
  if (/^\s*#{1,6}\s/m.test(text)) reasons.push('body carries markdown headings (copied document)');
  if (/```/.test(text)) reasons.push('body carries a code fence');
  if (String(message?.body || '').length > MAX_BODY_CHARS) reasons.push(`body exceeds ${MAX_BODY_CHARS} characters`);
  if (String(message?.body || '').split(/\r?\n/).length > MAX_BODY_LINES) reasons.push(`body exceeds ${MAX_BODY_LINES} lines`);
  return { valid: reasons.length === 0, reasons };
}

// Pending = an active record sitting in a decision state whose entering event has
// no notification entry, or a failed one re-armed by authorize-retry. Claimed and
// sent entries are not pending: a stale claim is visible delivery state, not a
// reason to page again.
function findPendingDecisions({ root, tenant, recordId, sequence } = {}) {
  const base = baseOf(root);
  let active;
  try { active = JSON.parse(fs.readFileSync(path.join(base, 'state', 'work', 'active.json'), 'utf8')); } catch { active = { records: {} }; }
  const events = workState.readEvents(base);
  const pending = [];
  const records = Object.values(active.records || {})
    .filter((record) => DECISION_STATES.includes(record.state))
    .filter((record) => !tenant || record.tenant === tenant)
    .filter((record) => !recordId || record.id === recordId)
    .sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue);
  for (const record of records) {
    const entering = workState.enteringEvent(events, record.id, record.state);
    if (!entering) continue;
    if (sequence !== undefined && Number(entering.sequence) !== Number(sequence)) continue;
    const entry = record.notifications?.[String(entering.sequence)] || null;
    if (entry && !(entry.status === 'failed' && entry.retryAuthorized)) continue;
    pending.push({ record, event: entering, entry });
  }
  return pending;
}

function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function shadowSeen(file, recordId, sequence, attempt) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
    try { const entry = JSON.parse(line); return entry.recordId === recordId && entry.sequence === sequence && entry.attempt === attempt; } catch { return false; }
  });
}

function toastSender({ root, powershell = 'powershell.exe' } = {}) {
  const script = path.join(baseOf(root), 'bin', 'send-toast.ps1');
  return (message) => {
    try {
      const raw = execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', message.title, '-Body', message.body], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
      });
      const last = String(raw).trim().split(/\r?\n/).pop() || '{}';
      const result = JSON.parse(last);
      return { ok: result.delivered === true, detail: result.detail || (result.delivered ? 'toast shown' : 'toast not delivered') };
    } catch (error) {
      return { ok: false, detail: `toast channel failed: ${String(error.stderr || error.message || error).slice(0, 200)}` };
    }
  };
}

function refreshDigest(root, tenants) {
  // Projections, not state: a failure here loses nothing the ledger does not hold.
  try {
    const { projectDigest } = require('./digest');
    projectDigest({ root });
    for (const tenant of tenants) projectDigest({ root, tenant });
  } catch { /* the next watch tick rebuilds them */ }
}

function runNotifier(options = {}) {
  const base = baseOf(options.root);
  const live = isLive({ root: base, live: options.live });
  const actor = options.actor || 'notifier';
  const channel = options.channel || 'toast';
  const send = options.send || toastSender({ root: base });
  const compose = options.compose || buildPointerMessage;
  const configs = options.tenantConfigs || workState.readTenantConfigs(base);
  const now = options.now;
  const shadowFile = path.join(base, 'state', 'notify', 'shadow.jsonl');
  const result = { at: new Date(now || Date.now()).toISOString(), live, handled: [] };
  const touchedTenants = new Set();

  for (const { record, event, entry } of findPendingDecisions({ root: base, tenant: options.tenant, recordId: options.recordId, sequence: options.sequence })) {
    const tenantConfig = configs[record.tenant] || {};
    const handled = { recordId: record.id, sequence: event.sequence, decisionType: event.type, outcome: null };
    result.handled.push(handled);
    const attempt = (entry?.attempt || 0) + 1;
    if (!live) {
      handled.outcome = 'shadow';
      if (!shadowSeen(shadowFile, record.id, event.sequence, attempt)) {
        const message = compose({ root: base, record, event, tenantConfig });
        appendLine(shadowFile, { at: result.at, recordId: record.id, sequence: event.sequence, attempt, decisionType: event.type, pointer: message.pointer, title: message.title });
      }
      continue;
    }
    let claimed;
    try {
      claimed = workState.notifyRecord({ root: base, id: record.id, phase: 'claim', expectedRevision: record.revision, decisionSequence: event.sequence, idempotencyKey: `notify:${record.id}:s${event.sequence}:a${attempt}:claim`, actor, channel, now });
    } catch (error) {
      // STALE_REVISION means another actor moved first; every other refusal names
      // the standing delivery state. Neither is ours to force.
      handled.outcome = `skipped:${error.code === 'NOTIFICATION_ALREADY_CLAIMED' || error.code === 'STALE_REVISION' ? 'claimed' : String(error.code || 'error').toLowerCase()}`;
      handled.detail = error.message;
      continue;
    }
    touchedTenants.add(record.tenant);
    const message = compose({ root: base, record: claimed.record, event, tenantConfig });
    const fixture = validatePointerMessage(message);
    let delivery;
    if (!fixture.valid) delivery = { ok: false, detail: `message rejected: ${fixture.reasons.join('; ')}` };
    else {
      try { delivery = send(message); } catch (error) { delivery = { ok: false, detail: `send threw: ${String(error.message || error).slice(0, 200)}` }; }
      if (!delivery || typeof delivery !== 'object') delivery = { ok: false, detail: 'channel returned no result' };
    }
    const phase = delivery.ok ? 'sent' : 'failed';
    try {
      workState.notifyRecord({ root: base, id: record.id, phase, expectedRevision: claimed.revision, decisionSequence: event.sequence, idempotencyKey: `notify:${record.id}:s${event.sequence}:a${attempt}:${phase}`, actor, channel, detail: delivery.detail || null, now });
      handled.outcome = phase;
    } catch (error) {
      // The claim stands (visible as in-flight) and the page, if it went out, went
      // out once. Recording the settle again would be a second write, not a fix.
      handled.outcome = `unsettled:${String(error.code || 'error').toLowerCase()}`;
      handled.detail = error.message;
    }
    handled.detail = handled.detail || delivery.detail || null;
  }
  if (!options.dryRun) {
    appendLine(path.join(base, 'state', 'notify', 'notify.log.jsonl'), result);
    if (touchedTenants.size) refreshDigest(base, [...touchedTenants]);
  }
  return result;
}

// A launch that never produced a process is a failed delivery like any other:
// record it through the door so the digest shows it and authorize-retry can re-arm.
function recordLaunchFailure(base, recordId, sequence, detail) {
  if (!recordId || sequence === undefined || sequence === null) return false;
  try {
    const record = workState.getRecord({ root: base, id: recordId });
    const attempt = (record.notifications?.[String(sequence)]?.attempt || 0) + 1;
    const claimed = workState.notifyRecord({ root: base, id: recordId, phase: 'claim', expectedRevision: record.revision, decisionSequence: Number(sequence), idempotencyKey: `notify:${recordId}:s${sequence}:a${attempt}:claim`, actor: 'notifier-launch', channel: 'toast' });
    workState.notifyRecord({ root: base, id: recordId, phase: 'failed', expectedRevision: claimed.revision, decisionSequence: Number(sequence), idempotencyKey: `notify:${recordId}:s${sequence}:a${attempt}:failed`, actor: 'notifier-launch', channel: 'toast', detail });
    return true;
  } catch { return false; }   // a standing claim or a resolved decision already tells the story
}

// Detached launch of one notifier for one decision event. Callers are the event
// producers (pr-watch, review-policy hold, the state CLI): a decision event is
// what launches a notifier, nothing else does.
function spawnNotifier({ root, recordId, sequence, node = process.execPath } = {}) {
  const base = baseOf(root);
  const args = [path.join(__dirname, 'notify.js'), '--root', base];
  if (recordId) args.push('--record', String(recordId));
  if (sequence !== undefined && sequence !== null) args.push('--sequence', String(sequence));
  const fail = (error) => {
    const detail = `notifier launch failed: ${String(error.message || error).slice(0, 200)}`;
    return { spawned: false, error: detail, recorded: recordLaunchFailure(base, recordId, sequence, detail), args };
  };
  try {
    const child = spawn(node, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: base });
    // A missing executable surfaces as an asynchronous 'error', never a throw:
    // record it the same way, and never let it become an uncaught exception in
    // the producer (the watcher tick or the state CLI) that asked for the launch.
    child.on('error', (error) => { fail(error); });
    child.unref();
    return { spawned: true, pid: child.pid, args };
  } catch (error) {
    return fail(error);
  }
}

function main(argv) {
  const args = workState.parseArgs(argv);
  const result = runNotifier({
    root: args.root, tenant: args.tenant, recordId: args.record,
    sequence: args.sequence ? Number(args.sequence) : undefined,
    live: args.live === 'true' ? true : undefined, dryRun: args['dry-run'] === 'true', now: args.now,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DECISION_STATES,
  buildPointerMessage,
  findPendingDecisions,
  isLive,
  runNotifier,
  spawnNotifier,
  toastSender,
  validatePointerMessage,
};
