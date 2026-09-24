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

// fleet#44: the closing-linkage rule re-derives "no closing keyword" from GitHub on
// every tick, so without memory it re-escalated a deliberate `Refs` body three
// times in twenty-five minutes, each time blocking the review it interrupted.
// The memory is the body: a closing-linkage escalation tags its evidence with a
// digest of the PR body it judged, and when a lead resolves that escalation the
// store keeps the tag beside the resolution (resolvedDecisionEvidence). The same
// body is then a ruled fact and never re-escalates; any edit to the body is a new
// fact and escalates again. Scoped to the body, not the head: a push does not
// change what the body says about issue closure.
function bodyDigest(body) {
  return crypto.createHash('sha1').update(String(body || '')).digest('hex').slice(0, 12);
}

function closingLinkageTag(viewPr) {
  return `${WATCHER_MARK} closing-linkage body=${bodyDigest(viewPr?.body)}`;
}

function closingLinkageRuled(record, viewPr) {
  if (!record?.resolutionEvidence) return false;
  return String(record.resolvedDecisionEvidence || '').includes(closingLinkageTag(viewPr));
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

// Ticket 09 (the ticket-05 lower bound, due at the 02/03 cutover): "no merge without a
// recorded formal review" cannot be blocked by a script - the lead merges through gh -
// but it can be seen. A merge observed on a record with no formal review recorded
// completes as a fact (GitHub is authoritative) and carries a decision-needed wake, so it
// pages once and stands in the digest instead of passing silently.
// state/flags/merge-review-wake-off is its rollback: the merge still completes, silently.
function mergedChain(hops, viewPr, prNumber, evidencePrefix, { formalReviewMissing = false } = {}) {
  return (hops || []).map((to, index) => ({
    kind: 'transition', to,
    evidence: `${evidencePrefix} at ${viewPr.mergedAt} (gh pr view ${prNumber})${to === 'merged' && formalReviewMissing ? '; merged without a recorded formal review (ticket 05 lower bound)' : ''}`,
    wake: to === 'merged' && formalReviewMissing ? 'decision-needed' : null,
    reconciled: to === 'merged' ? { state: viewPr.state, mergedAt: viewPr.mergedAt, headRefOid: viewPr.headRefOid || undefined, evidence: `gh pr view ${prNumber}` } : null,
    observe: index === hops.length - 1 ? { pr: viewPr, evaluation: evaluateChecks({ ciGates: [], watchedChecks: [], ignoredChecks: [] }, viewPr.statusCheckRollup), closing: null } : null,
  }));
}

// Pure planner. One step per run per record, except merged fast-forwards, which
// complete in one run so a record never trails a finished reality.
function planRecord({ record, openPr, viewPr, policy, branchPrefix, repo, formalReviewWake = true }) {
  const state = record.state;
  const reviewMissing = formalReviewWake && !record.review?.formal;
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
      return { actions: mergedChain(escalatedHopsTo(record.prior_state, 'merged'), viewPr, prNumber, 'escalation resolved by an observed merge', { formalReviewMissing: reviewMissing }) };
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
      return { actions: mergedChain(hopsTo(state, 'merged'), viewPr, prNumber, 'observed merged', { formalReviewMissing: reviewMissing }) };
    }
    return { actions: [] };   // closed (await a replacement PR) or draft (paused work)
  }

  if (!prNumber) return { actions: [] };

  if (!livePr) {
    if (!viewPr) return { actions: [], ghNeeds: 'view' };
    if (String(viewPr.state).toUpperCase() === 'MERGED') {
      return { actions: mergedChain(hopsTo(state, 'merged'), viewPr, prNumber, 'observed merged', { formalReviewMissing: reviewMissing }) };
    }
    if (viewIsOpen && viewPr.isDraft) {
      // fleet#63: a lead returns a PR to its IC with `gh pr ready --undo` and the
      // head does not move, so the fleet#34 new-head walk below never fires and the
      // record reads review until the IC pushes. The IC-hosted risk review is
      // accepted only in implementing/revision/pr-open, so a fix that must be
      // recorded before the push deadlocks. A draft PR while review is the lead's
      // return: walk review -> revision here (a legal edge, no wake). The lead
      // records its formal review before drafting, since formal is review-only.
      // hold stays parked: a held PR is Cory's merge, not rework.
      if (state === 'review') {
        // #118: the state door refuses a third send-back (SEND_BACK_LIMIT). The
        // draft is the lead's third return, so it becomes the decision the door
        // asks for, once, rather than a transition that fails every tick.
        const sendBacks = workState.sendBackCount(record);
        if (sendBacks >= workState.SEND_BACK_LIMIT - 1) {
          return {
            actions: [{
              kind: 'transition', to: 'escalated',
              evidence: `${WATCHER_MARK} PR #${prNumber} returned to draft at ${String(viewPr.headRefOid).slice(0, 12)} for a third send-back after ${sendBacks}; the door refuses it (SEND_BACK_LIMIT, #118): the lead restates the criterion and the disagreement needs a Ruling`,
              wake: 'decision-needed',
            }],
          };
        }
        return {
          actions: [{
            kind: 'transition', to: 'revision',
            evidence: `PR #${prNumber} returned to draft at ${String(viewPr.headRefOid).slice(0, 12)} while review; back with the IC`,
            wake: null,
          }],
        };
      }
      return { actions: [] };   // paused work, not a decision
    }
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
      const linked = closingLinked(viewPr, record.issue, repo);
      if (!linked && !closingLinkageRuled(record, viewPr)) {
        return {
          actions: [{
            kind: 'transition', to: 'escalated', observe: { pr: livePr, evaluation, closing: false },
            evidence: `${closingLinkageTag(viewPr)}: checks settled but PR #${prNumber} carries no closing linkage for issue #${record.issue}; issue closure must belong to the merge`,
            wake: 'decision-needed',
          }],
        };
      }
      return {
        actions: [{
          kind: 'transition', to: 'review', observe: { pr: livePr, evaluation, closing: linked },
          evidence: `every gate green on PR #${prNumber}; ${linkagePhrase(linked, record.issue, prNumber)}`,
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
  if (!linked && !closingLinkageRuled(record, viewPr)) {
    return {
      actions: [{
        kind: 'transition', to: 'escalated', observe: { pr: livePr, evaluation, closing: false },
        evidence: `${closingLinkageTag(viewPr)}: closing linkage for issue #${record.issue} disappeared from PR #${prNumber} while ${state}`,
        wake: 'decision-needed',
      }],
    };
  }
  // fleet#34: a lead that returns a PR to its IC leaves the record in review. When
  // the IC re-readies the PR the head SHA moves, the gates go pending, and a
  // change-within-review observe would carry no wake - so a green re-ready never
  // woke anyone, and `record --kind formal` could not refuse a review of pending
  // gates because the state field still said review. A new head while in review
  // walks the store's own path back to ci-wait (revision, pr-open, ci-wait), which
  // restores the ci-wait -> review transition, its checks-settled wake, and the
  // formal-review guard in one stroke. Already-settled gates at the new head take
  // the last hop to review in the same tick, so no wake is ever a tick late.
  // hold is left alone: a held PR is parked for Cory's merge, not being reworked.
  const prevHead = record.github?.observation?.headSha || null;
  const headMoved = state === 'review' && prevHead && livePr.headRefOid && livePr.headRefOid !== prevHead;
  if (headMoved) {
    const hops = hopsTo('review', 'ci-wait');
    if (hops) {
      const settled = evaluation.settled;
      const chain = settled ? [...hops, 'review'] : hops;
      const wake = settled ? 'checks-settled' : (evaluation.failed ? 'checks-failed' : null);
      return {
        actions: chain.map((to, index) => ({
          kind: 'transition', to,
          observe: index === chain.length - 1 ? { pr: livePr, evaluation, closing: settled ? linked : null } : null,
          evidence: index === chain.length - 1
            ? `PR #${prNumber} re-readied at ${String(livePr.headRefOid).slice(0, 12)} while review (was ${String(prevHead).slice(0, 12)}); ${settled ? `every gate green; ${linkagePhrase(linked, record.issue, prNumber)}` : `gates ${evaluation.failed ? `failed: ${evaluation.gateFailures.map((f) => `${f.name}=${f.conclusion}`).join(', ')}` : `pending: ${evaluation.gatePending.join(', ') || 'none observed'}`}`}`
            : `PR #${prNumber} re-readied at ${String(livePr.headRefOid).slice(0, 12)} while review; walking back to ci-wait`,
          wake: index === chain.length - 1 ? wake : null,
        })),
      };
    }
  }
  const observation = buildObservation(livePr, evaluation, linked);
  if (observation.digest === prevDigest) return { actions: [] };
  return { actions: [{ kind: 'observe', observation, evidence: `PR #${prNumber} changed while ${state}`, wake: null }] };
}

function linkagePhrase(linked, issue, prNumber) {
  return linked
    ? `closing linkage verified for #${issue}`
    : `closing linkage absent on PR #${prNumber} for #${issue}, ruled deliberate by the lead (fleet#44); issue closure is the lead's at the merge`;
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

  const formalReviewWake = !fs.existsSync(path.join(base, 'state', 'flags', 'merge-review-wake-off'));
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
    let plan = planRecord({ record, openPr, viewPr, policy, branchPrefix: prefix, repo, formalReviewWake });
    if (plan.ghNeeds === 'view') {
      try {
        viewPr = fetchers.viewPr(prNumber);
        health.ghCalls += 1;
      } catch (error) {
        health.failures += 1;
        health.actions.push(`${record.id}: view failed, retained (${String(error.message || error).slice(0, 120)})`);
        continue;
      }
      plan = planRecord({ record, openPr, viewPr, policy, branchPrefix: prefix, repo, formalReviewWake });
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
          // A decision transition's line was written by the transition door
          // (fleet#56) under this same key; the helper finds it and appends
          // nothing. Observe wakes (checks-settled, checks-failed) are written here.
          workState.appendWakeOutbox({
            root: base, recordId: record.id, revision: acted.revision, eventSequence: acted.eventSequence,
            wake: action.wake, idempotencyKey: key, evidence: action.evidence,
          });
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

// Ticket 09: CI watching has its own rollback flag. With state/flags/pr-watch-off the tick
// touches nothing and says so; the lead falls back to its own gh reads.
function isWatchOff(root) {
  return fs.existsSync(path.join(path.resolve(root || path.resolve(__dirname, '..')), 'state', 'flags', 'pr-watch-off'));
}

class PrWatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrWatchError';
    this.code = code;
    Object.assign(this, details);
  }
}

// fleet#4: the flags each command accepts, so a typo'd flag is refused instead of
// falling into a bucket nothing reads. `watch` is the only command this binary has
// (it is invoked with flags only, never a subcommand word); it is still spelled out
// as a per-command map, matching review-policy.js's CLASSIFY_FLAGS shape, so a
// second command has somewhere to declare its own flags rather than widening this one.
const FLAGS = {
  watch: ['root', 'tenant', 'gh', 'dry-run', 'no-notifier'],
};

function commandList() {
  return Object.keys(FLAGS).join(', ');
}

function runWatchCommand(args) {
  const base = path.resolve(args.root || path.resolve(__dirname, '..'));
  if (isWatchOff(base)) {
    return { ok: true, skipped: true, reason: 'state/flags/pr-watch-off stands: CI watching is disabled; remove the flag to resume' };
  }
  const tenantDir = path.join(base, 'tenants');
  let tenantName = args.tenant || null;
  if (!tenantName) {
    const files = fs.readdirSync(tenantDir).filter((f) => f.endsWith('.json'));
    if (files.length !== 1) throw new Error(`--tenant required (${files.length} tenants configured)`);
    tenantName = path.basename(files[0], '.json');
  }
  const tenantConfig = JSON.parse(fs.readFileSync(path.join(tenantDir, `${tenantName}.json`), 'utf8'));
  return runWatch({
    root: base, tenantName, tenantConfig,
    fetchers: makeFetchers(tenantConfig.github, args.gh || 'gh'),
    dryRun: args['dry-run'] === 'true',
    notifier: args['no-notifier'] === 'true' ? null : require('./notify').spawnNotifier,
  });
}

// No caller ever passes a command word (every invocation is flags only), so a
// leading non-flag token is only ever a typo; anything else defaults to `watch`.
function cli(argv) {
  const first = argv[0];
  const hasCommand = typeof first === 'string' && first !== '' && !first.startsWith('--');
  const command = hasCommand ? first : 'watch';
  const rest = hasCommand ? argv.slice(1) : argv;
  const flags = FLAGS[command];
  if (!flags) throw new PrWatchError('USAGE', `unknown command '${command}'; commands: ${commandList()}`);
  let args;
  try {
    args = workState.parseArgs(rest, flags);
  } catch (error) {
    if (error.code === 'USAGE') throw new PrWatchError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  if (command === 'watch') return runWatchCommand(args);
  throw new PrWatchError('USAGE', `unknown command '${command}'; commands: ${commandList()}`);
}

if (require.main === module) {
  try {
    const health = cli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(health)}\n`);
    if (health && health.ok === false) process.exitCode = 1;
  } catch (error) {
    if (error.code === 'USAGE') {
      // A refused invocation exits 2 so the watcher (a scheduled tick) never mistakes
      // a usage refusal for a tick failure - the two must stay distinguishable (fleet#4).
      process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  evaluateChecks, buildObservation, planRecord, runWatch, makeFetchers,
  stableStringify, closingLinked, closingLinkageTag, closingLinkageRuled, hopsTo, escalatedHopsTo, WATCH_STATES, WATCHER_MARK, isWatchOff, mergedChain,
  cli, FLAGS, PrWatchError,
};
