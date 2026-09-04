'use strict';
// Ticket 07: status and digest projections. Both are a pure fold of the Fleet
// event ledger (plus the exclusion ledgers) up to an offset, rendered as
// markdown. No wall-clock stamp is printed - the header names the offsets and
// the last event time - so rebuilding from the same offset is byte-identical and
// nothing model-authored can be appended: the next projection overwrites the
// file. The clock is used ONLY to evaluate exclusion expiries. Present-day state
// (active.json, the archive) is consulted for exactly one thing: the PR number of
// a record whose creation event predates ticket 07 (no `prNumber` key on the
// ledger), and that condition is itself a fact of the offset slice.

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');
const { readExclusions, projectExclusions } = require('./exclusions');

const CREATION_TYPES = Object.freeze(['assignment-reserved', 'work-created', 'shadow-projected']);
const RETIRED_TYPES = Object.freeze(['assignment-released', 'assignment-retired', 'shadow-retired']);
const { DECISION_STATES } = workState;
const ACTIVE_STATES = Object.freeze(workState.STATES.filter((state) => state !== 'retired'));
const MERGED_LIMIT = 10;

function baseOf(root) {
  return path.resolve(root || path.resolve(__dirname, '..'));
}

function parseId(recordId) {
  const match = /^([^:]+):issue-(\d+)$/.exec(String(recordId));
  return match ? { tenant: match[1], issue: Number(match[2]) } : { tenant: null, issue: null };
}

// One folded row per record id: current state, position, PR, decision and
// delivery facts. A supplement row (active.json / archive) fills the PR number
// ONLY for a legacy record - one whose creation event carries no `prNumber` key
// at all - so a replay of an offset can never learn something the slice did not.
function foldLedger(events, { supplement = {} } = {}) {
  const rows = new Map();
  for (const event of events) {
    const id = event.recordId;
    if (!id) continue;
    if (!rows.has(id)) {
      const parsed = parseId(id);
      const legacyShape = CREATION_TYPES.includes(event.type) && !('prNumber' in (event.changes || {}));
      const extra = legacyShape ? (supplement[id] || {}) : {};
      rows.set(id, {
        id, tenant: parsed.tenant || extra.tenant || null, issue: parsed.issue || extra.issue || null, state: null, revision: 0, sequence: 0,
        prNumber: extra.github?.prNumber || null, createdAt: event.at, updatedAt: event.at, enteredStateAt: event.at,
        mergedAt: null, notifications: {}, reviews: [],
      });
    }
    const row = rows.get(id);
    row.revision = Math.max(row.revision, Number(event.revision) || 0);
    row.sequence = Math.max(row.sequence, Number(event.sequence) || 0);
    row.updatedAt = event.at;
    const changes = event.changes || {};
    if (changes.prNumber) row.prNumber = changes.prNumber;
    if (CREATION_TYPES.includes(event.type)) { row.state = changes.state || row.state; row.enteredStateAt = event.at; }
    else if (RETIRED_TYPES.includes(event.type)) { row.state = 'retired'; row.enteredStateAt = event.at; }
    else if (event.type === 'shadow-retiring') { row.state = 'retiring'; row.enteredStateAt = event.at; }
    else if (event.type.startsWith('state-')) {
      row.state = event.type.slice('state-'.length);
      row.enteredStateAt = event.at;
      if (row.state === 'merged') row.mergedAt = event.at;
    } else if (event.type.startsWith('notification-')) {
      const key = String(changes.decisionSequence);
      const prior = row.notifications[key] || {};
      row.notifications[key] = {
        ...prior, status: changes.status, attempt: changes.attempt, channel: changes.channel || null, at: event.at,
        detail: changes.detail || null, retryAuthorized: Boolean(changes.retryAuthorized),
        ...(event.type === 'notification-retry-authorized' ? { retryAuthorizedBy: event.actor, retryAuthorizedAt: event.at } : {}),
      };
    } else if (event.type === 'review-recorded') row.reviews.push({ kind: changes.kind, artifact: changes.artifact, at: event.at });
  }
  return rows;
}

function readSupplement(base) {
  const supplement = {};
  const archiveDir = path.join(base, 'state', 'archive');
  if (fs.existsSync(archiveDir)) {
    for (const file of fs.readdirSync(archiveDir).filter((name) => /^work-.*\.json$/.test(name)).sort()) {
      try { const archived = JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8')); if (archived?.record?.id) supplement[archived.record.id] = archived.record; } catch { /* a torn index only costs its PR number */ }
    }
  }
  try {
    const active = JSON.parse(fs.readFileSync(path.join(base, 'state', 'work', 'active.json'), 'utf8'));
    for (const record of Object.values(active.records || {})) supplement[record.id] = record;
  } catch { /* the ledger alone is enough */ }
  return supplement;
}

function deliveryLine(entry) {
  if (!entry) return 'notification: not yet sent';
  if (entry.status === 'claimed') return `notification: claimed ${entry.at} (attempt ${entry.attempt}, in flight or stale - the ledger shows no settle)`;
  if (entry.status === 'sent') return `notification: sent ${entry.at} via ${entry.channel || 'unknown'} (attempt ${entry.attempt})`;
  const retry = entry.retryAuthorized
    ? `retry authorized by ${entry.retryAuthorizedBy || 'unknown'} ${entry.retryAuthorizedAt || ''}`.trim()
    : 'retry needs `work-state.js notify --phase authorize-retry`';
  return `notification: FAILED ${entry.at} (attempt ${entry.attempt}): ${entry.detail || 'no detail'} - ${retry}`;
}

function decisionSequence(events, row) {
  const entering = workState.enteringEvent(events, row.id, row.state);
  return entering ? entering.sequence : null;
}

function renderRow(row) {
  return `${row.tenant} #${row.issue}`;
}

function render({ scope, tenantNames, rows, events, exclusionsByTenant, offset, configs }) {
  const lastEvent = events[events.length - 1] || null;
  const lines = [];
  lines.push(scope === 'fleet' ? '# Fleet digest' : `# ${scope} status`);
  lines.push('');
  lines.push(`event offset: ${offset.events} (last event ${lastEvent ? `${lastEvent.at} ${lastEvent.recordId} seq ${lastEvent.sequence}` : 'none'}) - exclusions offset: ${offset.exclusions}`);
  lines.push('Projected from Work records and the event ledger. Do not edit: the next projection overwrites this file.');

  const scoped = [...rows.values()].filter((row) => tenantNames.includes(row.tenant)).sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)) || a.issue - b.issue);

  lines.push('', '## Needs Cory', '');
  const decisions = scoped.filter((row) => DECISION_STATES.includes(row.state));
  if (!decisions.length) lines.push('None.');
  for (const row of decisions) {
    const seq = decisionSequence(events, row);
    const repo = configs[row.tenant]?.github || null;
    const pointers = [`state/events/${String(row.enteredStateAt).slice(0, 10)}.jsonl#seq-${seq}`];
    if (repo && row.prNumber) pointers.push(`https://github.com/${repo}/pull/${row.prNumber}`);
    lines.push(`- ${renderRow(row)} - ${row.state} since ${row.enteredStateAt} - record ${row.id} r${row.revision} seq${seq}${row.prNumber ? ` - PR #${row.prNumber}` : ''}`);
    lines.push(`  evidence: ${pointers.join(' - ')}`);
    lines.push(`  ${deliveryLine(row.notifications[String(seq)] || null)}`);
  }

  lines.push('', '## Active work', '');
  const active = scoped.filter((row) => ACTIVE_STATES.includes(row.state) && !DECISION_STATES.includes(row.state));
  if (!active.length) lines.push('None.');
  for (const row of active) lines.push(`- ${renderRow(row)} - ${row.state} since ${row.enteredStateAt} - record ${row.id} r${row.revision} seq${row.sequence}${row.prNumber ? ` - PR #${row.prNumber}` : ''}`);

  lines.push('', `## Merged (last ${MERGED_LIMIT} in the ledger window)`, '');
  const merged = [...rows.values()].filter((row) => tenantNames.includes(row.tenant) && row.mergedAt).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt))).slice(0, MERGED_LIMIT);
  if (!merged.length) lines.push('None.');
  for (const row of merged) lines.push(`- ${renderRow(row)}${row.prNumber ? ` - PR #${row.prNumber}` : ''} - merged ${row.mergedAt} - now ${row.state}`);

  lines.push('', '## Frontier exclusions', '');
  const activeExclusions = [];
  const discharged = [];
  for (const tenant of tenantNames) {
    const projection = exclusionsByTenant[tenant] || { active: [], discharged: [] };
    activeExclusions.push(...projection.active);
    discharged.push(...projection.discharged);
  }
  lines.push('### Active');
  if (!activeExclusions.length) lines.push('None.');
  for (const entry of activeExclusions) {
    const recheck = entry.recheck.expiresAt ? `expires ${entry.recheck.expiresAt}` : `event ${entry.recheck.event.type}${entry.recheck.event.recordId ? ` ${entry.recheck.event.recordId}` : ''}${entry.recheck.event.issue ? ` #${entry.recheck.event.issue}` : ''}`;
    lines.push(`- ${entry.tenant} #${entry.issue} - owner ${entry.owner} - recheck: ${recheck} - evidence ${entry.evidence} - ${entry.id}`);
    lines.push(`  reason: ${entry.reason}`);
  }
  lines.push('### Discharged');
  if (!discharged.length) lines.push('None.');
  for (const entry of discharged) {
    lines.push(`- ${entry.tenant} #${entry.issue} - ${entry.dischargedBy} ${entry.dischargedAt}${entry.dischargedActor ? ` by ${entry.dischargedActor}` : ''}${entry.dischargeEvidence ? ` - ${entry.dischargeEvidence}` : ''} - ${entry.id}`);
    lines.push(`  reason was: ${entry.reason}`);
  }

  lines.push('', "## Cory's authority", '');
  for (const tenant of tenantNames) {
    const config = configs[tenant] || {};
    const carveOuts = (config.carveOuts || []).length ? (config.carveOuts || []).join(', ') : 'none configured';
    lines.push(`- ${tenant}: applies \`${config.readyLabel || 'ready-for-agent'}\`; merges carve-outs (${carveOuts}) and holds; promotes \`${config.defaultBranch || 'integration'}\` to \`${config.releaseBranch || 'main'}\`.`);
  }
  lines.push('A notification reports a decision; it never takes one. Delivery state above changes nothing here.');
  return `${lines.join('\n')}\n`;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function projectDigest(options = {}) {
  const base = baseOf(options.root);
  const configs = workState.readTenantConfigs(base);
  const allEvents = workState.readEvents(base);
  const eventsOffset = options.offset === undefined || options.offset === null ? allEvents.length : Math.min(Number(options.offset), allEvents.length);
  const events = allEvents.slice(0, eventsOffset);
  const supplement = readSupplement(base);
  const rows = foldLedger(events, { supplement });
  const tenantNames = options.tenant ? [String(options.tenant)] : [...new Set([...Object.keys(configs), ...[...rows.values()].map((row) => row.tenant).filter(Boolean)])].sort();
  const exclusionsByTenant = {};
  let exclusionsTotal = 0;
  for (const tenant of tenantNames) {
    const entries = readExclusions(base, tenant);
    exclusionsTotal += entries.length;
    exclusionsByTenant[tenant] = { entries };
  }
  const exclusionsOffset = options.exclusionsOffset === undefined || options.exclusionsOffset === null ? exclusionsTotal : Math.min(Number(options.exclusionsOffset), exclusionsTotal);
  // The exclusions offset counts entries in tenant order, so one number pins all ledgers.
  let remaining = exclusionsOffset;
  for (const tenant of tenantNames) {
    const entries = exclusionsByTenant[tenant].entries.slice(0, Math.max(0, remaining));
    remaining -= exclusionsByTenant[tenant].entries.length;
    exclusionsByTenant[tenant] = projectExclusions({ entries, events, now: options.now });
  }
  const offset = { events: eventsOffset, exclusions: exclusionsOffset };
  const content = render({ scope: options.tenant ? String(options.tenant) : 'fleet', tenantNames, rows, events, exclusionsByTenant, offset, configs });
  const output = options.output ? path.resolve(options.output) : path.join(base, 'state', 'status', options.tenant ? `${options.tenant}-status.md` : 'DIGEST.md');
  if (!options.dryRun) writeAtomic(output, content);
  return { output, content, offset };
}

function main(argv) {
  const args = workState.parseArgs(argv);
  const result = projectDigest({
    root: args.root, tenant: args.tenant, output: args.output, now: args.now,
    offset: args.offset ? Number(args.offset) : undefined, exclusionsOffset: args['exclusions-offset'] ? Number(args['exclusions-offset']) : undefined,
    dryRun: args['dry-run'] === 'true',
  });
  if (args.print === 'true') process.stdout.write(result.content);
  else process.stdout.write(`${JSON.stringify({ output: result.output, offset: result.offset, bytes: Buffer.byteLength(result.content, 'utf8') })}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { foldLedger, projectDigest, render };
