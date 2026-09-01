'use strict';
// Ticket 04: deterministic PR watcher. Reconciles active Work records against GitHub,
// writes a Fleet event ONLY when an observed value changes, and records an eligible
// project-lead wake (checks-settled | checks-failed | decision-needed). The EVENT
// LEDGER is the authoritative wake record (changes.wake on observations, a
// `wake:<kind>; ` evidence prefix on transitions); state/watch/wake-outbox.jsonl is a
// best-effort convenience cache written after commit. A decision-needed wake also
// launches the ticket-07 notifier (bin/notify.js: one detached process per decision
// event, shadow unless state/flags/notifier-live) - nothing here messages a session. Shadow: the legacy Stop-hook loop
// stays authoritative; this maintains the shadow records and parity evidence. Zero
// model turns. Two deliberate spec-over-legacy choices: a required gate MISSING from
// the rollup is incomplete (never settled), and closure linkage counts a body
// closing keyword because this tenant closes issues through the #330 workflow.
//
// Design rules from the 2026-09-01 review: idempotency keys are retry-dedupe only,
// so every key is scoped to the record revision it acts on (novelty detection is
// digest-vs-stored-observation); multi-hop paths are computed from the store's own
// TRANSITIONS, never hand-coded; the watcher resolves only escalations it raised
// (its decisionEvidence starts with the [pr-watch] mark).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const workState = require('./work-state');

const WATCH_STATES = Object.freeze(['implementing', 'revision', 'pr-open', 'ci-wait', 'review', 'hold', 'escalated']);
const WATCHER_MARK = '[pr-watch]';

function checkName(check) {
  return String(check?.name || check?.context || '');
}

// Port of Get-CheckPolicyEvaluation (bin/check-policy.ps1) plus the ticket-04 rule:
// a gate absent from the rollup counts as pending. Gate semantics: pending until
// COMPLETED; any completed conclusion other than SUCCESS is a failure (SKIPPED and
// CANCELLED included - a gate that did not succeed did not pass).
function evaluateChecks(policy, rollup) {
  const observed = new Map();
  for (const check of rollup || []) {
    const name = checkName(check);
    if (name) observed.set(name, check);
  }
  const gatePending = [];
  const gateFailures = [];
  const gateMissing = [];
  for (const name of policy.ciGates || []) {
    if (!observed.has(name)) { gateMissing.push(name); gatePending.push(name); continue; }
    const check = observed.get(name);
    const status = String(check.status || '');
    const conclusion = String(check.conclusion || '');
    if ((status && status !== 'COMPLETED') || (!conclusion && status !== 'COMPLETED')) gatePending.push(name);
    else if (conclusion !== 'SUCCESS') gateFailures.push({ name, conclusion });
  }
  const watchedFindings = [];
  for (const name of policy.watchedChecks || []) {
    if (!observed.has(name)) continue;
    const check = observed.get(name);
    const status = String(check.status || '');
    const conclusion = String(check.conclusion || '');
    if (status && status !== 'COMPLETED') continue;
    if (conclusion && conclusion !== 'SUCCESS' && conclusion !== 'SKIPPED') watchedFindings.push({ name, conclusion });
  }
  const owned = new Set([...(policy.ciGates || []), ...(policy.watchedChecks || []), ...(policy.ignoredChecks || [])]);
  const unclassified = [...observed.keys()].filter((name) => !owned.has(name)).sort();
  return {
    gatePending, gateFailures, gateMissing, watchedFindings, unclassified,
    settled: gatePending.length === 0 && gateFailures.length === 0,
    failed: gateFailures.length > 0,
  };
}

// Closure linkage, ported from the tenant's close-merged-issues.js (#330) grammar:
// strip code fences and spans first; keyword with optional colon, same-line
// whitespace, then #n, owner/repo#n, or the full issue URL. Native
// closingIssuesReferences also counts (it under-reports on this tenant, never over).
function stripCode(text) {
  return String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

function closingLinked(viewPr, issue, repo) {
  const refs = viewPr?.closingIssuesReferences || [];
  if (refs.some((ref) => Number(ref.number) === Number(issue))) return true;
  const body = stripCode(viewPr?.body || '');
  const n = Number(issue);
  const forms = [`#${n}\\b`];
  if (repo) {
    const repoPattern = String(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    forms.push(`${repoPattern}#${n}\\b`, `https://github\\.com/${repoPattern}/issues/${n}\\b`);
  }
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[^\\S\\n]+(?:${forms.join('|')})`, 'i').test(body);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildObservation(pr, evaluation, closing) {
  const checks = (pr.statusCheckRollup || []).map((c) => `${checkName(c)}:${c.status || ''}:${c.conclusion || ''}`).sort();
  const body = {
    prNumber: pr.number, prState: String(pr.state || 'OPEN'), headSha: pr.headRefOid || null,
    mergedAt: pr.mergedAt || null, checks, closingVerified: closing === null ? null : Boolean(closing),
  };
  return {
    ...body,
    digest: crypto.createHash('sha1').update(stableStringify(body)).digest('hex'),
    gates: {
      pending: evaluation.gatePending, failures: evaluation.gateFailures,
      missing: evaluation.gateMissing, settled: evaluation.settled,
    },
    watchedFindings: evaluation.watchedFindings,
    unclassified: evaluation.unclassified,
  };
}

// Shortest path between states over the store's own TRANSITIONS (escalated and the
// retirement tail excluded as through-states). Returns the hops AFTER `from`.
function hopsTo(from, target) {
  if (from === target) return [];
  const blocked = new Set(['escalated', 'retiring', 'retired']);
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const pathSoFar = queue.shift();
    for (const next of workState.TRANSITIONS[pathSoFar[pathSoFar.length - 1]] || []) {
      if (seen.has(next) || (blocked.has(next) && next !== target)) continue;
      if (next === target) return [...pathSoFar.slice(1), next];
      seen.add(next);
      queue.push([...pathSoFar, next]);
    }
  }
  return null;
}

// From escalated, the first hop must be prior_state or one of its successors.
function escalatedHopsTo(priorState, target) {
  const prior = priorState && priorState !== 'escalated' ? priorState : 'ci-wait';
  const firstHops = [prior, ...(workState.TRANSITIONS[prior] || [])].filter((s) => s !== 'escalated');
  let best = null;
  for (const first of firstHops) {
    const rest = first === target ? [] : hopsTo(first, target);
    if (rest === null) continue;
    const candidate = [first, ...rest];
    if (!best || candidate.length < best.length) best = candidate;
  }
  return best;
}

function mergedChain(hops, viewPr, prNumber, evidencePrefix) {
  return (hops || []).map((to, index) => ({
    kind: 'transition', to,
    evidence: `${evidencePrefix} at ${viewPr.mergedAt} (gh pr view ${prNumber})`, wake: null,
    reconciled: to === 'merged' ? { state: viewPr.state, mergedAt: viewPr.mergedAt, evidence: `gh pr view ${prNumber}` } : null,
    observe: index === hops.length - 1 ? { pr: viewPr, evaluation: evaluateChecks({ ciGates: [], watchedChecks: [], ignoredChecks: [] }, viewPr.statusCheckRollup), closing: null } : null,
  }));
}

// Pure planner. One step per run per record, except merged fast-forwards, which
// complete in one run so a record never trails a finished reality.
function planRecord({ record, openPr, viewPr, policy, branchPrefix, repo }) {
  const state = record.state;
  const prNumber = record.github?.prNumber || null;
  const prevDigest = record.github?.observation?.digest || null;
  const viewIsOpen = viewPr && String(viewPr.state).toUpperCase() === 'OPEN';
  // A PR can be live yet absent from the draft-filtered, 100-capped open list:
  // an OPEN non-draft view is treated exactly like a listed PR.
  const livePr = openPr || (viewIsOpen && !viewPr.isDraft ? viewPr : null);

  if (state === 'escalated') {
    // Only the watcher's own escalations are its to resolve; a human's hold stands.
    // (Containment, not prefix: transition evidence carries a `wake:<kind>; ` prefix.)
    if (!String(record.decisionEvidence || '').includes(WATCHER_MARK)) return { actions: [] };
    if (!prNumber) return { actions: [] };
    if (!viewPr) return { actions: [], ghNeeds: 'view' };
    if (!openPr && String(viewPr.state).toUpperCase() === 'MERGED') {
      return { actions: mergedChain(escalatedHopsTo(record.prior_state, 'merged'), viewPr, prNumber, 'escalation resolved by an observed merge') };
    }
    if (livePr && closingLinked(viewPr, record.issue, repo)) {
      const back = record.prior_state && record.prior_state !== 'escalated' ? record.prior_state : 'ci-wait';
      return {
        actions: [{
          kind: 'transition', to: back,
          evidence: `closing linkage for #${record.issue} now present on PR #${prNumber}; resolving the escalation`, wake: null,
        }],
      };
    }
    return { actions: [] };
  }

  if (state === 'implementing' || state === 'revision') {
    // Discovery: the record's own PR if it is live, else a live PR on the branch
    // prefix (rework replaces a dead PR with a new number through the same door).
    const discovered = livePr && (!prNumber || Number(livePr.number) === Number(prNumber))
      ? livePr
      : null;
    if (discovered) {
      return {
        actions: [{
          kind: 'transition', to: 'pr-open', prNumber: discovered.number,
          evidence: `discovered PR #${discovered.number} (${discovered.headRefName || 'branch match'})`, wake: null,
        }],
      };
    }
    if (!prNumber) return { actions: [] };
    if (!viewPr) return { actions: [], ghNeeds: 'view' };
    if (String(viewPr.state).toUpperCase() === 'MERGED') {
      return { actions: mergedChain(hopsTo(state, 'merged'), viewPr, prNumber, 'observed merged') };
    }
    return { actions: [] };   // closed (await a replacement PR) or draft (paused work)
  }

  if (!prNumber) return { actions: [] };

  if (!livePr) {
    if (!viewPr) return { actions: [], ghNeeds: 'view' };
    if (String(viewPr.state).toUpperCase() === 'MERGED') {
      return { actions: mergedChain(hopsTo(state, 'merged'), viewPr, prNumber, 'observed merged') };
    }
    if (viewIsOpen && viewPr.isDraft) return { actions: [] };   // paused work, not a decision
    return {
      actions: [{
        kind: 'transition', to: 'escalated',
        evidence: `${WATCHER_MARK} PR #${prNumber} is ${viewPr.state} without a merge; the record needs a human decision`,
        wake: 'decision-needed',
      }],
    };
  }

  const evaluation = evaluateChecks(policy, livePr.statusCheckRollup);

  if (state === 'pr-open') {
    return {
      actions: [{
        kind: 'transition', to: 'ci-wait', observe: { pr: livePr, evaluation, closing: null },
        evidence: `CI ${evaluation.settled ? 'already settled' : `incomplete: ${[...evaluation.gatePending, ...evaluation.gateFailures.map((f) => f.name)].join(', ') || 'no gates observed'}`}`,
        wake: null,
      }],
    };
  }

  if (state === 'ci-wait') {
    if (evaluation.settled) {
      if (!viewPr) return { actions: [], ghNeeds: 'view' };   // linkage needs the body
      if (!closingLinked(viewPr, record.issue, repo)) {
        return {
          actions: [{
            kind: 'transition', to: 'escalated', observe: { pr: livePr, evaluation, closing: false },
            evidence: `${WATCHER_MARK} checks settled but PR #${prNumber} carries no closing linkage for issue #${record.issue}; issue closure must belong to the merge`,
            wake: 'decision-needed',
          }],
        };
      }
      return {
        actions: [{
          kind: 'transition', to: 'review', observe: { pr: livePr, evaluation, closing: true },
          evidence: `every gate green on PR #${prNumber}; closing linkage verified for #${record.issue}`,
          wake: 'checks-settled',
        }],
      };
    }
    const observation = buildObservation(livePr, evaluation, null);
    if (observation.digest === prevDigest) return { actions: [] };
    return {
      actions: [{
        kind: 'observe', observation,
        evidence: evaluation.failed
          ? `gate failure on PR #${prNumber}: ${evaluation.gateFailures.map((f) => `${f.name}=${f.conclusion}`).join(', ')}`
          : `CI progressing on PR #${prNumber}: pending ${evaluation.gatePending.join(', ')}`,
        wake: evaluation.failed ? 'checks-failed' : null,
      }],
    };
  }

  // review/hold: the lead owns the outcome, but linkage is re-verified every tick -
  // a body edit that drops the closing keyword must escalate before the merge.
  if (!viewPr) return { actions: [], ghNeeds: 'view' };
  const linked = closingLinked(viewPr, record.issue, repo);
  if (!linked) {
    return {
      actions: [{
        kind: 'transition', to: 'escalated', observe: { pr: livePr, evaluation, closing: false },
        evidence: `${WATCHER_MARK} closing linkage for issue #${record.issue} disappeared from PR #${prNumber} while ${state}`,
        wake: 'decision-needed',
      }],
    };
  }
  const observation = buildObservation(livePr, evaluation, true);
  if (observation.digest === prevDigest) return { actions: [] };
  return { actions: [{ kind: 'observe', observation, evidence: `PR #${prNumber} changed while ${state}`, wake: null }] };
}

function ghJson(executable, args) {
  const raw = execFileSync(executable, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
  });
  return JSON.parse(raw);
}

function makeFetchers(repo, executable = 'gh') {
  return {
    listOpenPrs: () => ghJson(executable, ['pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,isDraft,headRefName,headRefOid,statusCheckRollup']),
    viewPr: (n) => ghJson(executable, ['pr', 'view', String(n), '-R', repo, '--json', 'number,state,isDraft,mergedAt,headRefOid,statusCheckRollup,closingIssuesReferences,headRefName,body']),
  };
}

function runWatch({ root, tenantName, tenantConfig, fetchers, actor = 'pr-watch', dryRun = false, shadow = true, notifier = null } = {}) {
  const started = Date.now();
  const base = path.resolve(root || path.resolve(__dirname, '..'));
  const watchDir = path.join(base, 'state', 'watch');
  const policy = {
    ciGates: tenantConfig.ciGates || [], watchedChecks: tenantConfig.watchedChecks || [],
    ignoredChecks: tenantConfig.ignoredChecks || [],
  };
  const health = { at: new Date().toISOString(), ok: true, error: null, tenant: tenantName, records: 0, ghCalls: 0, failures: 0, actions: [], dryRun };
  const finish = () => {
    // The shadow projection runs LAST: retiring a roster-dropped IC before its
    // record was advanced would archive an in-flight PR unwatched (review F3).
    if (shadow && !dryRun) {
      try { workState.shadowProject({ root: base, actor }); } catch (error) { health.actions.push(`shadow-project-failed: ${error.message}`); }
    }
    if (health.failures > 0) { health.ok = false; if (!health.error) health.error = `${health.failures} record action(s) failed; see actions`; }
    health.durationMs = Date.now() - started;
    if (!dryRun) {
      fs.mkdirSync(watchDir, { recursive: true });
      fs.writeFileSync(path.join(watchDir, 'health.json'), `${JSON.stringify(health, null, 2)}\n`, 'utf8');
    }
    return health;
  };

  let active;
  try { active = JSON.parse(fs.readFileSync(path.join(base, 'state', 'work', 'active.json'), 'utf8')); } catch { active = { records: {} }; }
  const records = Object.values(active.records || {})
    .filter((r) => r.tenant === tenantName && WATCH_STATES.includes(r.state))
    .sort((a, b) => a.issue - b.issue);
  health.records = records.length;
  if (records.length === 0) return finish();

  let openPrs;
  try {
    openPrs = fetchers.listOpenPrs();
    health.ghCalls += 1;
  } catch (error) {
    // Fail safe: GitHub unavailable means retain every prior observation untouched.
    health.ok = false;
    health.error = `listOpenPrs failed: ${String(error.message || error).slice(0, 300)}`;
    return finish();
  }
  const byNumber = new Map(openPrs.filter((pr) => !pr.isDraft).map((pr) => [Number(pr.number), pr]));
  const prefix = tenantConfig.branchPrefix || '';
  const repo = tenantConfig.github || null;

  for (const record of records) {
    const prNumber = record.github?.prNumber || null;
    let openPr = prNumber ? byNumber.get(Number(prNumber)) || null : null;
    if (!openPr && (record.state === 'implementing' || record.state === 'revision')) {
      openPr = openPrs.find((pr) => !pr.isDraft && String(pr.headRefName || '').startsWith(`${prefix}${record.issue}-`)) || null;
    }
    let viewPr = null;
    let plan = planRecord({ record, openPr, viewPr, policy, branchPrefix: prefix, repo });
    if (plan.ghNeeds === 'view') {
      try {
        viewPr = fetchers.viewPr(prNumber);
        health.ghCalls += 1;
      } catch (error) {
        health.failures += 1;
        health.actions.push(`${record.id}: view failed, retained (${String(error.message || error).slice(0, 120)})`);
        continue;
      }
      plan = planRecord({ record, openPr, viewPr, policy, branchPrefix: prefix, repo });
    }
    if (!plan.actions.length) continue;

    let revision = record.revision;
    for (const action of plan.actions) {
      const observation = action.observation || (action.observe ? buildObservation(action.observe.pr, action.observe.evaluation, action.observe.closing) : null);
      const suffix = observation ? observation.digest.slice(0, 12) : 'view';
      // Keys are retry-dedupe only: scoping to the acting revision means a
      // recurrence of the same digest after ANY intervening change gets a fresh key.
      const key = action.kind === 'observe' ? `watch:${record.id}:r${revision}:${suffix}` : `watch:${record.id}:r${revision}:${suffix}:${action.to}`;
      const summary = `${record.id}: ${action.kind === 'observe' ? 'observe' : `-> ${action.to}`}${action.wake ? ` wake=${action.wake}` : ''}`;
      if (dryRun) { health.actions.push(`DRY ${summary}`); continue; }
      try {
        let acted;
        if (action.kind === 'observe') {
          acted = workState.observeRecord({
            root: base, id: record.id, expectedRevision: revision, idempotencyKey: key, actor,
            observation, wake: action.wake, evidence: action.evidence,
          });
        } else {
          acted = workState.transitionRecord({
            root: base, id: record.id, to: action.to, expectedRevision: revision, idempotencyKey: key, actor,
            prNumber: action.prNumber, evidence: `${action.wake ? `wake:${action.wake}; ` : ''}${action.evidence}`,
            reconciledObservation: action.reconciled || undefined,
          });
        }
        revision = acted.revision;
        health.actions.push(`${summary}${acted.replayed ? ' (replayed)' : ''}`);
        if (action.wake && !acted.replayed) {
          fs.mkdirSync(watchDir, { recursive: true });
          const wakeLine = {
            at: new Date().toISOString(), recordId: record.id, revision: acted.revision,
            eventSequence: acted.eventSequence, wake: action.wake, idempotencyKey: key, evidence: action.evidence,
          };
          fs.appendFileSync(path.join(watchDir, 'wake-outbox.jsonl'), `${JSON.stringify(wakeLine)}\n`, 'utf8');
          if (action.wake === 'decision-needed' && notifier) {
            try { notifier({ root: base, recordId: record.id, sequence: acted.eventSequence }); } catch (error) { health.actions.push(`${record.id}: notifier launch failed (${String(error.message || error).slice(0, 120)})`); }
          }
        }
        if (action.kind === 'transition' && observation && !acted.replayed) {
          // Cache the observation on the moved record so identical polls short-circuit
          // and the archived record does not contradict its own final state.
          try {
            revision = workState.observeRecord({
              root: base, id: record.id, expectedRevision: revision, idempotencyKey: `${key}:obs`, actor,
              observation, evidence: action.evidence,
            }).revision;
          } catch { /* cache only; the transition already committed */ }
        }
      } catch (error) {
        health.failures += 1;
        health.actions.push(`${record.id}: ${action.kind} failed (${error.code || ''} ${String(error.message).slice(0, 120)})`);
        break;
      }
    }
  }
  return finish();
}

function main(argv) {
  const args = workState.parseArgs(argv);
  const base = path.resolve(args.root || path.resolve(__dirname, '..'));
  const tenantDir = path.join(base, 'tenants');
  let tenantName = args.tenant || null;
  if (!tenantName) {
    const files = fs.readdirSync(tenantDir).filter((f) => f.endsWith('.json'));
    if (files.length !== 1) throw new Error(`--tenant required (${files.length} tenants configured)`);
    tenantName = path.basename(files[0], '.json');
  }
  const tenantConfig = JSON.parse(fs.readFileSync(path.join(tenantDir, `${tenantName}.json`), 'utf8'));
  const health = runWatch({
    root: base, tenantName, tenantConfig,
    fetchers: makeFetchers(tenantConfig.github, args.gh || 'gh'),
    dryRun: args['dry-run'] === 'true',
    notifier: args['no-notifier'] === 'true' ? null : require('./notify').spawnNotifier,
  });
  process.stdout.write(`${JSON.stringify(health)}\n`);
  if (!health.ok) process.exitCode = 1;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  evaluateChecks, buildObservation, planRecord, runWatch, makeFetchers,
  stableStringify, closingLinked, hopsTo, escalatedHopsTo, WATCH_STATES, WATCHER_MARK,
};
