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
//                 lead is the context under budget). Patterns fire on added
//                 lines only, attributed per file, and never from files under
//                 the configured prose excludes.
//   record        store ONE findings artifact per review under state/reviews/
//                 and reference it from the record and event ledger through
//                 work-state's `review` door. Guards make "exactly one" a
//                 machine fact: a duplicate formal review at the same head and
//                 a risk review without a trigger are refused; an identical
//                 retry replays. A revision bumped by a routine observation
//                 (pr-watch) retries internally rather than losing the review.
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
const DEFAULT_REVIEW_CONFIG = Object.freeze({
  trivialMaxChangedLines: 25,
  trivialMaxFiles: 3,
  patternExcludePaths: Object.freeze(['**/*.md', '**/*.txt', 'docs/**']),
});
const RESOLUTION_VALUES = Object.freeze(['resolved', 'still-open', 'not-real']);
const STALE_RETRY_LIMIT = 5;

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
  const addedByFile = new Map();
  let currentFile = null;
  let changedLines = 0;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const named = line.slice(4).trim();
      currentFile = named === '/dev/null' ? null : named.replace(/^b\//, '');
      if (currentFile && !addedByFile.has(currentFile)) addedByFile.set(currentFile, []);
      continue;
    }
    if (line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      changedLines += 1;
      if (currentFile) addedByFile.get(currentFile).push(line.slice(1));
      else {
        if (!addedByFile.has(null)) addedByFile.set(null, []);
        addedByFile.get(null).push(line.slice(1));
      }
    } else if (line.startsWith('-')) changedLines += 1;
  }
  return { addedByFile, changedLines };
}

function patternRegExp(pattern) {
  try { return new RegExp(pattern, 'i'); } catch {
    return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

function evaluateTrigger(name, { paths: pathGlobs = [], patterns = [] }, files, addedByFile, excludeGlobs) {
  const matches = [];
  for (const glob of pathGlobs) {
    for (const file of files) {
      if (matchGlob(glob, file)) matches.push({ file, glob });
    }
  }
  const excluded = (file) => file !== null && excludeGlobs.some((glob) => matchGlob(glob, file));
  for (const pattern of patterns) {
    const regexp = patternRegExp(pattern);
    let hit = null;
    for (const [file, lines] of addedByFile) {
      if (excluded(file)) continue;
      for (const line of lines) {
        if (regexp.test(line)) { hit = { pattern, file: file || undefined, line: line.trim().slice(0, 200) }; break; }
      }
      if (hit) break;
    }
    if (hit) matches.push(hit); // one match per pattern is evidence enough
  }
  return matches.length ? { class: name, matches } : null;
}

function classifyChange(options = {}) {
  const tenant = options.tenant || {};
  const config = { ...DEFAULT_REVIEW_CONFIG, ...(options.config?.review || options.config || {}) };
  const excludeGlobs = config.patternExcludePaths || [];
  const files = (options.files || []).map((file) => String(file).replace(/\\/g, '/'));
  const parsed = options.diffText !== undefined ? parseDiff(options.diffText) : null;
  let addedByFile = parsed ? parsed.addedByFile : new Map();
  if (options.addedLines) {
    // Flat added lines with no per-file attribution: usable only when the file
    // list itself is not entirely excluded prose.
    addedByFile = new Map();
    if (!files.length || files.some((file) => !excludeGlobs.some((glob) => matchGlob(glob, file)))) {
      addedByFile.set(null, options.addedLines);
    }
  }
  const changedLines = Number.isFinite(options.changedLines) ? options.changedLines : (parsed ? parsed.changedLines : null);

  const triggers = [];
  const carveOut = evaluateTrigger('carve-out', { paths: tenant.carveOuts || [] }, files, new Map(), excludeGlobs);
  if (carveOut) triggers.push(carveOut);
  for (const [name, spec] of Object.entries(tenant.riskTriggers || {})) {
    const hit = evaluateTrigger(name, spec || {}, files, addedByFile, excludeGlobs);
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
        ? { host: 'ic', role: 'qa-reviewer', model: 'opus', readOnly: true, timing: 'pre-pr-ready' }
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

function readArtifact(root, relativePath) {
  const file = path.join(path.resolve(root || DEFAULT_ROOT), relativePath);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function openFindings(artifact) {
  return (artifact.findings || []).filter((finding) => finding.status === 'open');
}

function writeArtifactExclusive(root, recordId, kind, buildContent) {
  // Allocate the next free sequence with an exclusive create, so two concurrent
  // writers can never share a filename (and never delete each other's file).
  const directory = reviewsDir(root, recordId);
  fs.mkdirSync(directory, { recursive: true });
  const pattern = new RegExp(`^${kind}-(\\d{3})\\.json$`);
  let sequence = 1;
  for (const name of fs.readdirSync(directory)) {
    const match = pattern.exec(name);
    if (match) sequence = Math.max(sequence, Number(match[1]) + 1);
  }
  for (;;) {
    const stamp = `${kind}-${String(sequence).padStart(3, '0')}`;
    const relative = path.posix.join('state', 'reviews', safeRecordName(recordId), `${stamp}.json`);
    const file = path.join(path.resolve(root || DEFAULT_ROOT), relative);
    let handle;
    try {
      handle = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') { sequence += 1; continue; }
      throw error;
    }
    let content;
    try {
      content = buildContent(stamp, sequence, relative);
    } catch (error) {
      // The name is ours (exclusive create) but nothing was written: never
      // leave a 0-byte artifact behind for a later reader to find.
      fs.closeSync(handle);
      fs.rmSync(file, { force: true });
      throw error;
    }
    fs.writeFileSync(handle, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    fs.closeSync(handle);
    return { relative, file, stamp, sequence };
  }
}

function buildFindings(stamp, suppliedFindings, priorArtifactData, priorArtifactPath, resolutions) {
  // Caller fields never override the forced-open status: openFindings gates the
  // unresolved-findings guard on it.
  const findings = (suppliedFindings || []).map((finding, index) => ({
    ...finding,
    id: finding.id || `${stamp}-f${index + 1}`,
    status: 'open',
  }));
  if (priorArtifactData) {
    // Carry the still-open prior findings forward so the latest artifact is the
    // complete unresolved set; resolved and not-real material is settled.
    for (const finding of openFindings(priorArtifactData)) {
      if (resolutions[finding.id] === 'still-open') {
        findings.push({ ...finding, status: 'open', carriedFrom: priorArtifactPath });
      }
    }
  }
  const seen = new Set();
  for (const finding of findings) {
    if (seen.has(finding.id)) throw new ReviewPolicyError('DUPLICATE_FINDING_ID', `finding id '${finding.id}' appears more than once`);
    seen.add(finding.id);
  }
  return findings;
}

function recordReviewArtifact(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const { recordId, kind, headSha, actor } = options;
  if (!recordId || !headSha) throw new ReviewPolicyError('USAGE', 'recordId and headSha are required');
  if (!['formal', 'risk'].includes(kind)) throw new ReviewPolicyError('INVALID_REVIEW_KIND', `unknown review kind '${kind}'`);
  const classification = options.classification || {};
  // Ticket 09: with state/flags/review-dedup-off every review pass is written down (the
  // legacy behaviour). The default replay key is kind:record:head, which would make a
  // second pass at the same head replay the first, so under the flag the default key
  // carries the moment too, and a same-head formal pass is not held to the re-review link.
  const dedupOff = fs.existsSync(path.join(root, 'state', 'flags', 'review-dedup-off'));
  const key = options.idempotencyKey || `${kind}:${recordId}:${headSha}${dedupOff ? `:${new Date(options.now || Date.now()).toISOString()}` : ''}`;
  const pinnedRevision = options.expectedRevision !== undefined && Number.isInteger(Number(options.expectedRevision))
    ? Number(options.expectedRevision) : null;

  let written = null;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const record = workState.getRecord({ root, id: recordId });

      // An identical retry replays: return the artifact the record references.
      if (record.idempotency?.[key]) {
        if (written) fs.rmSync(written.file, { force: true });
        const artifact = record.review?.[kind]?.artifact || null;
        return {
          artifact,
          result: { replayed: true, revision: record.idempotency[key].revision, eventSequence: record.idempotency[key].eventSequence, record },
        };
      }

      const prior = record.review?.[kind] || null;
      if (prior && prior.headSha === String(headSha) && !dedupOff) {
        throw new ReviewPolicyError('ALREADY_REVIEWED', `a ${kind} review is already recorded for ${recordId} at ${headSha}`, { artifact: prior.artifact });
      }
      if (kind === 'risk' && !(classification.triggers || []).length) {
        throw new ReviewPolicyError('RISK_REVIEW_NOT_TRIGGERED', 'a risk review requires a configured trigger; a normal PR never launches the risk reviewer');
      }

      let priorArtifactData = null;
      let priorArtifactMissing = false;
      let range = null;
      const resolutions = options.resolutions || null;
      const sameHeadPassUnderFlag = dedupOff && prior && prior.headSha === String(headSha) && !options.priorArtifact;
      if (kind === 'formal' && prior && !sameHeadPassUnderFlag) {
        if (!options.priorArtifact || options.priorArtifact !== prior.artifact) {
          throw new ReviewPolicyError('REREVIEW_REQUIRES_PRIOR', `a revision re-review must link the prior findings artifact ${prior.artifact}`, { priorArtifact: prior.artifact });
        }
        priorArtifactData = readArtifact(root, prior.artifact);
        range = `${prior.headSha}..${headSha}`;
        if (priorArtifactData === null) {
          // The referenced file is gone (crash, hand cleanup, pruned tree):
          // degrade honestly instead of wedging the record forever.
          priorArtifactMissing = true;
        } else {
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
      }

      // fleet#18: the artifact is never silent about its own result. A reviewer
      // who found nothing is a real outcome, so it is recorded as a statement
      // (`--no-findings "<sentence>"`), never as an empty list a later reader
      // cannot tell from lost content. Last guard before the write, so the
      // refusals above keep their precedence (ADR 0009, ruling 2).
      // The guard reads what the artifact WILL hold (new findings plus the
      // still-open prior findings carried forward), not only what the caller
      // typed: a statement beside a carried blocker would be a lie. The dry
      // build also raises DUPLICATE_FINDING_ID before any file exists.
      const supplied = options.findings || [];
      const noFindings = options.noFindings;
      const preview = buildFindings('pending', supplied, priorArtifactData, prior ? prior.artifact : null, resolutions);
      if (noFindings !== undefined) {
        if (typeof noFindings !== 'string' || !noFindings.trim() || noFindings === 'true') {
          throw new ReviewPolicyError('USAGE', '--no-findings needs a one-sentence statement of what was examined and what was concluded');
        }
        if (preview.length) {
          const carried = preview.length - supplied.length;
          throw new ReviewPolicyError('USAGE', `the artifact would carry ${preview.length} finding(s) (${supplied.length} new, ${carried} still open from ${prior ? prior.artifact : 'the prior artifact'}); it is not a no-findings review, omit --no-findings`);
        }
      } else if (!preview.length) {
        throw new ReviewPolicyError('EMPTY_FINDINGS', `a ${kind} review with no findings must say so: pass --no-findings "<what was examined and what was concluded>" so the artifact is not read as lost content`);
      }

      if (!written) {
        written = writeArtifactExclusive(root, recordId, kind, (stamp) => ({
          schemaVersion: 1,
          recordId,
          kind,
          headSha: String(headSha),
          range,
          tier: classification.tier || null,
          triggers: classification.triggers || [],
          reviewer: actor || 'unknown',
          at: options.now ? new Date(options.now).toISOString() : new Date().toISOString(),
          priorArtifact: prior ? prior.artifact : null,
          priorArtifactMissing: priorArtifactMissing || undefined,
          resolutions,
          noFindings: noFindings ? noFindings.trim() : null,
          findings: buildFindings(stamp, options.findings, priorArtifactData, prior ? prior.artifact : null, resolutions),
        }));
      }

      try {
        const result = workState.recordReview({
          root, id: recordId, expectedRevision: pinnedRevision ?? record.revision,
          idempotencyKey: key, actor, now: options.now, evidence: options.evidence,
          review: {
            kind, headSha, artifact: written.relative,
            tier: classification.tier || null,
            triggers: (classification.triggers || []).map((trigger) => trigger.class || trigger),
            priorArtifact: prior ? prior.artifact : null,
          },
        });
        return { artifact: written.relative, result };
      } catch (error) {
        // A routine concurrent bump (pr-watch observing the PR) is retried when
        // the caller did not pin a revision; everything else is terminal.
        if (error.code === 'STALE_REVISION' && pinnedRevision === null && attempt < STALE_RETRY_LIMIT) continue;
        if (error.code === 'INVALID_REVIEW_STATE') {
          // fleet#20: the door is closed on purpose (a formal review lands on a
          // settled PR; a risk review is IC-hosted pre-PR-ready). Name what
          // opens it, so a lead who reviewed early knows to wait rather than
          // park the findings somewhere non-canonical (ADR 0009).
          const opens = kind === 'formal'
            ? 'the PR watcher records checks-settled when the gates finish and moves the record to `review`; review then, not before'
            : 'a risk review is recorded by the IC pre-PR-ready (implementing, revision, pr-open), never from the lead\'s review';
          throw new ReviewPolicyError('INVALID_REVIEW_STATE', `${error.message}; ${opens}`, { state: record.state });
        }
        throw error;
      }
    }
  } catch (error) {
    // Terminal failure: remove only the file this call created (exclusive name).
    if (written) fs.rmSync(written.file, { force: true });
    throw error;
  }
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
    unresolved: artifact ? openFindings(artifact) : [],
    ...(artifact === null ? { priorArtifactMissing: true } : {}),
  };
}

// --- hold: park a reviewed-clean PR for Cory, page once ---

function outboxHasWake(outboxFile, recordId, idempotencyKey) {
  if (!fs.existsSync(outboxFile)) return false;
  return fs.readFileSync(outboxFile, 'utf8').split(/\r?\n/).some((line) => {
    if (!line.trim()) return false;
    try {
      const entry = JSON.parse(line);
      return entry.recordId === recordId && entry.idempotencyKey === idempotencyKey;
    } catch { return false; }
  });
}

function holdRecord(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const { recordId, reason, actor } = options;
  if (!recordId || !reason) throw new ReviewPolicyError('USAGE', 'recordId and reason are required');
  const key = options.idempotencyKey || `hold:${recordId}`;
  const result = workState.transitionRecord({
    root, id: recordId, to: 'hold',
    expectedRevision: options.expectedRevision,
    idempotencyKey: key,
    actor, now: options.now,
    evidence: `wake:decision-needed; ${reason}`,
  });
  // Page once, at-least-once: the state-hold event is the authoritative record;
  // the outbox line is the delivery cache (pr-watch shape) and the ticket-07
  // notifier is launched for the event (it claims through the state command, so
  // a second launch finds the claim and sends nothing). A crash between the
  // transition and this append is repaired by any retry, which finds the
  // committed transition (replay) but no outbox line, and delivers the page.
  const watchDir = path.join(root, 'state', 'watch');
  const outboxFile = path.join(watchDir, 'wake-outbox.jsonl');
  let paged = false;
  if (!result.replayed || !outboxHasWake(outboxFile, recordId, key)) {
    fs.mkdirSync(watchDir, { recursive: true });
    const wakeLine = {
      at: new Date(options.now || Date.now()).toISOString(), recordId, revision: result.revision,
      eventSequence: result.eventSequence, wake: 'decision-needed',
      idempotencyKey: key, evidence: reason,
    };
    fs.appendFileSync(outboxFile, `${JSON.stringify(wakeLine)}\n`, 'utf8');
    paged = true;
    if (options.notifier) options.notifier({ root, recordId, sequence: result.eventSequence });
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

// The flags `classify` accepts. It is the one command here whose wrong answer is
// dangerous in exactly one direction (a false "no risk review"), so it parses
// against a schema and refuses to answer anything it was not clearly asked
// (fleet#2). `--repo-path` and `--tenant-config` are assignment.js's names
// for the same two concepts; before this they fell into a bucket nothing read
// and classify answered riskReview:false over an empty diff, exit 0.
const CLASSIFY_FLAGS = ['root', 'tenant', 'repo', 'base', 'head', 'files', 'diff', 'changed-lines'];
const CLASSIFY_USAGE = 'classify --tenant <name> (--repo <path> --base <ref> [--head <ref>] | --files <json array> [--diff <file>] | --diff <file>) [--root <fleet root>]';

function usage(message) {
  return new ReviewPolicyError('USAGE', `${message}\nusage: ${CLASSIFY_USAGE}`);
}

function classifyCli(rest) {
  let args;
  try {
    args = workState.parseArgs(rest, CLASSIFY_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw usage(error.message);
    throw error;
  }
  const root = args.root;
  // A classification is always tenant-scoped: carve-outs and risk triggers
  // are the tenant's. Against an empty tenant nothing can match, so the only
  // answer it could give is riskReview:false, which is a false negative by
  // construction, not an answer.
  if (!args.tenant || args.tenant === 'true') throw usage('--tenant <name> is required');
  const tenant = loadTenant(root, args.tenant);
  const carveOuts = Array.isArray(tenant.carveOuts) ? tenant.carveOuts.length : 0;
  const triggers = tenant.riskTriggers && typeof tenant.riskTriggers === 'object' ? Object.keys(tenant.riskTriggers).length : 0;
  if (carveOuts === 0 && triggers === 0) {
    throw new ReviewPolicyError('EMPTY_TENANT', `tenant "${args.tenant}" declares no carveOuts and no riskTriggers; a classification against it could only ever answer riskReview:false`);
  }
  const config = loadConfig(root);
  if (args.repo) {
    if (args.repo === 'true') throw usage('--repo needs a path');
    if (!args.base || args.base === 'true') throw usage('--repo needs --base <ref>');
    return classifyFromGit({ repoPath: args.repo, baseRef: args.base, headRef: args.head, tenant, config });
  }
  if (args.base) throw usage('--base needs --repo <path>');
  // No source of files is a usage error, never an empty diff: an empty
  // classification must be impossible to obtain by accident.
  if (!args.files && !args.diff) throw usage('nothing to classify: give --repo <path> --base <ref>, --files <json array>, or --diff <file>');
  const files = args.files ? JSON.parse(args.files) : [];
  if (args.files && (!Array.isArray(files) || files.length === 0)) throw usage('--files must be a non-empty JSON array of paths');
  if (args.diff && !fs.existsSync(args.diff)) throw usage(`--diff file not found: ${args.diff}`);
  return classifyChange({
    files,
    diffText: args.diff ? fs.readFileSync(args.diff, 'utf8') : undefined,
    changedLines: args['changed-lines'] ? Number(args['changed-lines']) : undefined,
    tenant, config,
  });
}

// fleet#4's contract for the other three commands (fleet#18 added
// `--no-findings`, and a typo'd `--no-finding` must not be a silent no-op):
// each list is every flag its handler consumes; an unknown flag or command is
// USAGE, exit 2, nothing on stdout.
const RECORD_FLAGS = ['root', 'id', 'expected-revision', 'kind', 'head-sha', 'actor', 'now', 'idempotency-key', 'evidence', 'classification', 'findings', 'no-findings', 'resolutions', 'prior-artifact'];
const COMMAND_FLAGS = Object.freeze({
  classify: CLASSIFY_FLAGS,
  record: RECORD_FLAGS,
  'plan-rereview': ['root', 'id', 'head-sha'],
  hold: ['root', 'id', 'expected-revision', 'reason', 'actor', 'now', 'idempotency-key', 'no-notifier'],
});

function cli(argv) {
  const [command, ...rest] = argv;
  if (command === 'classify') return classifyCli(rest);
  if (!Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, command)) {
    throw new ReviewPolicyError('USAGE', `unknown command '${command}'; commands: ${Object.keys(COMMAND_FLAGS).join(', ')}`);
  }
  let args;
  try {
    args = workState.parseArgs(rest, COMMAND_FLAGS[command]);
  } catch (error) {
    if (error.code === 'USAGE') throw new ReviewPolicyError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  const root = args.root;
  if (command === 'record') {
    return recordReviewArtifact({
      root, recordId: args.id,
      expectedRevision: args['expected-revision'] !== undefined ? Number(args['expected-revision']) : undefined,
      kind: args.kind, headSha: args['head-sha'], actor: args.actor, now: args.now,
      idempotencyKey: args['idempotency-key'], evidence: args.evidence,
      classification: args.classification ? JSON.parse(fs.existsSync(args.classification) ? fs.readFileSync(args.classification, 'utf8') : args.classification) : {},
      findings: args.findings ? JSON.parse(fs.existsSync(args.findings) ? fs.readFileSync(args.findings, 'utf8') : args.findings) : [],
      noFindings: args['no-findings'],
      resolutions: args.resolutions ? JSON.parse(args.resolutions) : null,
      priorArtifact: args['prior-artifact'],
    });
  }
  if (command === 'plan-rereview') {
    return planRereview({ root, recordId: args.id, headSha: args['head-sha'] });
  }
  // command === 'hold'
  return holdRecord({
    root, recordId: args.id, expectedRevision: Number(args['expected-revision']),
    reason: args.reason, actor: args.actor, now: args.now, idempotencyKey: args['idempotency-key'],
    notifier: args['no-notifier'] === 'true' ? null : require('./notify').spawnNotifier,
  });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message })}\n`);
    // A refused invocation exits 2 so a caller reading only the status cannot
    // take it for a failed one, let alone for an answer (fleet#2).
    // INVALID_REVIEW_STATE is a refused invocation too (fleet#20): nothing was
    // recorded, and the message names the door that opens the state.
    process.exitCode = ['USAGE', 'EMPTY_TENANT', 'INVALID_REVIEW_STATE', 'EMPTY_FINDINGS'].includes(error.code) ? 2 : 1;
  }
}

module.exports = {
  CLASSIFY_FLAGS,
  COMMAND_FLAGS,
  ReviewPolicyError,
  classifyChange,
  cli,
  classifyFromGit,
  holdRecord,
  matchGlob,
  planRereview,
  recordReviewArtifact,
};
