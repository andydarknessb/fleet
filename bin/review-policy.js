'use strict';
// Ticket 05: risk-aware review policy for one settled PR.
//
// Deterministic pieces only - sessions make the judgments, this module answers:
//   classify      which risk tier a change is in, from configured triggers
//                 (tenant carveOuts + tenant riskTriggers paths/patterns), and
//                 therefore who reviews what: every PR gets the project lead's
//                 ONE independent Standards+Spec review; only a configured
//                 trigger books the IC-hosted, read-only, Opus risk reviewer
//                 (amendment 5: the risk reviewer is spawned by the IC,
//                 pre-PR-ready, because a worker bills to its spawner and the
//                 lead is the context under budget).
//   record        store ONE findings artifact per review under state/reviews/
//                 and reference it from the record and event ledger through
//                 work-state's `review` door. Guards make "exactly one" a
//                 machine fact: a duplicate formal review at the same head and
//                 a risk review without a trigger are refused.
//   plan-rereview a revision re-review inspects the changed range and the
//                 unresolved findings, never the settled material.
//   hold          a clean carve-out (or any PR requiring Cory) parks in the
//                 PR-only `hold` state and pages once; merged remains
//                 reachable only through an observed GitHub merge, so no
//                 automated or project-lead path can complete it.
//
// The record, not the artifact directory, is the guard authority: an orphaned
// artifact file (crash between artifact write and state commit) is harmless.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const workState = require('./work-state');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_REVIEW_CONFIG = Object.freeze({ trivialMaxChangedLines: 25, trivialMaxFiles: 3 });
const RESOLUTION_VALUES = Object.freeze(['resolved', 'still-open', 'not-real']);

class ReviewPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReviewPolicyError';
    this.code = code;
    Object.assign(this, details);
  }
}

// --- glob matching (tenant carveOuts / riskTriggers.paths) ---

function globToRegExp(glob) {
  let pattern = '';
  const segments = String(glob).replace(/\\/g, '/').split('/');
  segments.forEach((segment, index) => {
    if (segment === '**') {
      // `**/` matches zero or more whole segments.
      pattern += index === segments.length - 1 ? '.*' : '(?:[^/]+/)*';
      return;
    }
    let piece = '';
    for (const char of segment) {
      if (char === '*') piece += '[^/]*';
      else if (char === '?') piece += '[^/]';
      else piece += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    pattern += piece + (index === segments.length - 1 ? '' : '/');
  });
  return new RegExp(`^${pattern}$`);
}

function matchGlob(glob, filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const cleaned = String(glob).replace(/\\/g, '/');
  if (!cleaned.includes('/')) {
    // A bare-name glob matches by basename anywhere: a carve-out class must
    // over-match rather than under-match (`.env*` protects nested .env files).
    return globToRegExp(cleaned).test(path.posix.basename(normalized));
  }
  return globToRegExp(cleaned).test(normalized);
}

// --- classification ---

function parseDiff(diffText) {
  const addedLines = [];
  let changedLines = 0;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { addedLines.push(line.slice(1)); changedLines += 1; }
    else if (line.startsWith('-')) changedLines += 1;
  }
  return { addedLines, changedLines };
}

function patternRegExp(pattern) {
  try { return new RegExp(pattern, 'i'); } catch {
    return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

function evaluateTrigger(name, { paths: pathGlobs = [], patterns = [] }, files, addedLines) {
  const matches = [];
  for (const glob of pathGlobs) {
    for (const file of files) {
      if (matchGlob(glob, file)) matches.push({ file, glob });
    }
  }
  for (const pattern of patterns) {
    const regexp = patternRegExp(pattern);
    for (const line of addedLines) {
      if (regexp.test(line)) {
        matches.push({ pattern, line: line.trim().slice(0, 200) });
        break; // one match per pattern is evidence enough
      }
    }
  }
  return matches.length ? { class: name, matches } : null;
}

function classifyChange(options = {}) {
  const tenant = options.tenant || {};
  const config = { ...DEFAULT_REVIEW_CONFIG, ...(options.config?.review || options.config || {}) };
  const files = (options.files || []).map((file) => String(file).replace(/\\/g, '/'));
  const parsed = options.diffText !== undefined ? parseDiff(options.diffText) : null;
  const addedLines = options.addedLines || parsed?.addedLines || [];
  const changedLines = Number.isFinite(options.changedLines) ? options.changedLines : (parsed ? parsed.changedLines : null);

  const triggers = [];
  const carveOut = evaluateTrigger('carve-out', { paths: tenant.carveOuts || [] }, files, []);
  if (carveOut) triggers.push(carveOut);
  for (const [name, spec] of Object.entries(tenant.riskTriggers || {})) {
    const hit = evaluateTrigger(name, spec || {}, files, addedLines);
    if (hit) triggers.push(hit);
  }

  let tier = 'normal';
  if (triggers.length) tier = 'high-risk';
  else if (changedLines !== null && changedLines <= config.trivialMaxChangedLines && files.length <= config.trivialMaxFiles) tier = 'trivial';

  const riskReview = tier === 'high-risk';
  return {
    tier,
    triggers,
    files,
    changedLines,
    riskReview,
    merge: carveOut ? 'cory-only' : 'lead',
    reviewPlan: {
      formal: { owner: 'project-lead', count: 1 },
      risk: riskReview
        ? { host: 'ic', agent: 'qa-reviewer', model: 'opus', readOnly: true, timing: 'pre-pr-ready' }
        : null,
    },
  };
}

function classifyFromGit(options = {}) {
  const { repoPath, baseRef, tenant, config } = options;
  const headRef = options.headRef || 'HEAD';
  if (!repoPath || !baseRef) throw new ReviewPolicyError('USAGE', 'repoPath and baseRef are required');
  const git = (args) => execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  // --name-only, never --stat: --stat left-truncates long paths (ruled 2026-09-01).
  const files = git(['diff', '--name-only', `${baseRef}...${headRef}`]).split(/\r?\n/).filter(Boolean);
  const diffText = git(['diff', `${baseRef}...${headRef}`]);
  const headSha = git(['rev-parse', headRef]).trim();
  return { headSha, classification: classifyChange({ files, diffText, tenant, config }) };
}

// --- findings artifacts ---

function safeRecordName(recordId) {
  return String(recordId).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function reviewsDir(root, recordId) {
  return path.join(path.resolve(root || DEFAULT_ROOT), 'state', 'reviews', safeRecordName(recordId));
}

function nextArtifactSequence(directory, kind) {
  if (!fs.existsSync(directory)) return 1;
  const pattern = new RegExp(`^${kind}-(\\d{3})\\.json$`);
  const taken = fs.readdirSync(directory)
    .map((name) => pattern.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return taken.length ? Math.max(...taken) + 1 : 1;
}

function readArtifact(root, relativePath) {
  const file = path.join(path.resolve(root || DEFAULT_ROOT), relativePath);
  if (!fs.existsSync(file)) throw new ReviewPolicyError('ARTIFACT_MISSING', `review artifact not found: ${relativePath}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function openFindings(artifact) {
  return (artifact.findings || []).filter((finding) => finding.status === 'open');
}

function recordReviewArtifact(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const { recordId, kind, headSha, actor } = options;
  if (!recordId || !headSha) throw new ReviewPolicyError('USAGE', 'recordId and headSha are required');
  if (!['formal', 'risk'].includes(kind)) throw new ReviewPolicyError('INVALID_REVIEW_KIND', `unknown review kind '${kind}'`);
  const classification = options.classification || {};
  const record = workState.getRecord({ root, id: recordId });
  const prior = record.review?.[kind] || null;

  if (prior && prior.headSha === String(headSha)) {
    throw new ReviewPolicyError('ALREADY_REVIEWED', `a ${kind} review is already recorded for ${recordId} at ${headSha}`, { artifact: prior.artifact });
  }
  if (kind === 'risk' && !(classification.triggers || []).length) {
    throw new ReviewPolicyError('RISK_REVIEW_NOT_TRIGGERED', 'a risk review requires a configured trigger; a normal PR never launches the risk reviewer');
  }

  let priorArtifactData = null;
  let range = null;
  const resolutions = options.resolutions || null;
  if (kind === 'formal' && prior) {
    if (!options.priorArtifact || options.priorArtifact !== prior.artifact) {
      throw new ReviewPolicyError('REREVIEW_REQUIRES_PRIOR', `a revision re-review must link the prior findings artifact ${prior.artifact}`, { priorArtifact: prior.artifact });
    }
    priorArtifactData = readArtifact(root, prior.artifact);
    range = `${prior.headSha}..${headSha}`;
    const open = openFindings(priorArtifactData);
    for (const finding of open) {
      const resolution = resolutions?.[finding.id];
      if (!resolution) {
        throw new ReviewPolicyError('UNRESOLVED_FINDINGS_UNACCOUNTED', `prior finding ${finding.id} has no resolution`, { unresolved: open.map((entry) => entry.id) });
      }
      if (!RESOLUTION_VALUES.includes(resolution)) {
        throw new ReviewPolicyError('INVALID_RESOLUTION', `resolution '${resolution}' for ${finding.id} is not one of ${RESOLUTION_VALUES.join(', ')}`);
      }
    }
  }

  const directory = reviewsDir(root, recordId);
  const sequence = nextArtifactSequence(directory, kind);
  const stamp = `${kind}-${String(sequence).padStart(3, '0')}`;
  const artifactRelative = path.posix.join('state', 'reviews', safeRecordName(recordId), `${stamp}.json`);

  const findings = (options.findings || []).map((finding, index) => ({
    id: finding.id || `${stamp}-f${index + 1}`,
    status: 'open',
    ...finding,
  }));
  if (priorArtifactData) {
    // Carry the still-open prior findings forward so the latest artifact is the
    // complete unresolved set; resolved and not-real material is settled.
    for (const finding of openFindings(priorArtifactData)) {
      if (resolutions[finding.id] === 'still-open') {
        findings.push({ ...finding, status: 'open', carriedFrom: prior.artifact });
      }
    }
  }

  const artifact = {
    schemaVersion: 1,
    recordId,
    kind,
    sequence,
    headSha: String(headSha),
    range,
    tier: classification.tier || null,
    triggers: classification.triggers || [],
    reviewer: actor || 'unknown',
    at: options.now ? new Date(options.now).toISOString() : new Date().toISOString(),
    priorArtifact: prior ? prior.artifact : null,
    resolutions,
    findings,
  };

  fs.mkdirSync(directory, { recursive: true });
  const artifactFile = path.join(root, artifactRelative);
  fs.writeFileSync(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  let result;
  try {
    result = workState.recordReview({
      root, id: recordId, expectedRevision: options.expectedRevision,
      idempotencyKey: options.idempotencyKey || `${stamp}:${recordId}:${headSha}`,
      actor, now: options.now, evidence: options.evidence,
      review: {
        kind, headSha, artifact: artifactRelative,
        tier: classification.tier || null,
        triggers: (classification.triggers || []).map((trigger) => trigger.class || trigger),
        priorArtifact: prior ? prior.artifact : null,
      },
    });
  } catch (error) {
    fs.rmSync(artifactFile, { force: true });
    throw error;
  }
  if (result.replayed) fs.rmSync(artifactFile, { force: true });
  return { artifact: result.replayed ? result.record.review[kind].artifact : artifactRelative, result };
}

function planRereview(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const { recordId, headSha } = options;
  if (!recordId || !headSha) throw new ReviewPolicyError('USAGE', 'recordId and headSha are required');
  const record = workState.getRecord({ root, id: recordId });
  const prior = record.review?.formal;
  if (!prior) throw new ReviewPolicyError('NO_PRIOR_REVIEW', `no formal review is recorded for ${recordId}`);
  const artifact = readArtifact(root, prior.artifact);
  return {
    recordId,
    priorArtifact: prior.artifact,
    priorHeadSha: prior.headSha,
    range: `${prior.headSha}..${headSha}`,
    unresolved: openFindings(artifact),
  };
}

// --- hold: park a reviewed-clean PR for Cory, page once ---

function holdRecord(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const { recordId, reason, actor } = options;
  if (!recordId || !reason) throw new ReviewPolicyError('USAGE', 'recordId and reason are required');
  const result = workState.transitionRecord({
    root, id: recordId, to: 'hold',
    expectedRevision: options.expectedRevision,
    idempotencyKey: options.idempotencyKey || `hold:${recordId}`,
    actor, now: options.now,
    evidence: `wake:decision-needed; ${reason}`,
  });
  let paged = false;
  if (!result.replayed) {
    // Page once: the state-hold event is the authoritative record, the outbox
    // line is the delivery cache ticket 07's notifier consumes (pr-watch shape).
    const watchDir = path.join(root, 'state', 'watch');
    fs.mkdirSync(watchDir, { recursive: true });
    const wakeLine = {
      at: new Date(options.now || Date.now()).toISOString(), recordId, revision: result.revision,
      eventSequence: result.eventSequence, wake: 'decision-needed',
      idempotencyKey: options.idempotencyKey || `hold:${recordId}`, evidence: reason,
    };
    fs.appendFileSync(path.join(watchDir, 'wake-outbox.jsonl'), `${JSON.stringify(wakeLine)}\n`, 'utf8');
    paged = true;
  }
  return { result, paged };
}

// --- CLI ---

function loadTenant(root, name) {
  const file = path.join(path.resolve(root || DEFAULT_ROOT), 'tenants', `${name}.json`);
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function loadConfig(root) {
  const file = path.join(path.resolve(root || DEFAULT_ROOT), 'config', 'cycle.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cli(argv) {
  const [command, ...rest] = argv;
  const args = workState.parseArgs(rest);
  const root = args.root;
  if (command === 'classify') {
    const tenant = args.tenant ? loadTenant(root, args.tenant) : {};
    const config = loadConfig(root);
    if (args.repo && args.base) {
      return classifyFromGit({ repoPath: args.repo, baseRef: args.base, headRef: args.head, tenant, config });
    }
    return classifyChange({
      files: args.files ? JSON.parse(args.files) : [],
      diffText: args.diff ? fs.readFileSync(args.diff, 'utf8') : undefined,
      changedLines: args['changed-lines'] ? Number(args['changed-lines']) : undefined,
      tenant, config,
    });
  }
  if (command === 'record') {
    return recordReviewArtifact({
      root, recordId: args.id, expectedRevision: Number(args['expected-revision']),
      kind: args.kind, headSha: args['head-sha'], actor: args.actor, now: args.now,
      idempotencyKey: args['idempotency-key'], evidence: args.evidence,
      classification: args.classification ? JSON.parse(fs.existsSync(args.classification) ? fs.readFileSync(args.classification, 'utf8') : args.classification) : {},
      findings: args.findings ? JSON.parse(fs.existsSync(args.findings) ? fs.readFileSync(args.findings, 'utf8') : args.findings) : [],
      resolutions: args.resolutions ? JSON.parse(args.resolutions) : null,
      priorArtifact: args['prior-artifact'],
    });
  }
  if (command === 'plan-rereview') {
    return planRereview({ root, recordId: args.id, headSha: args['head-sha'] });
  }
  if (command === 'hold') {
    return holdRecord({
      root, recordId: args.id, expectedRevision: Number(args['expected-revision']),
      reason: args.reason, actor: args.actor, now: args.now, idempotencyKey: args['idempotency-key'],
    });
  }
  throw new ReviewPolicyError('USAGE', 'commands: classify, record, plan-rereview, hold');
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ReviewPolicyError,
  classifyChange,
  classifyFromGit,
  holdRecord,
  matchGlob,
  planRereview,
  recordReviewArtifact,
};
