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
//                 A finding never carries its own `outcome`; the formal review
//                 resolves the risk artifact's open findings; `reviewedSha` is
//                 the tree the reviewer read (fleet#43). `--actor` defaults to
//                 FLEET_NAME (fleet#46). Every SHA it is given is resolved
//                 against the tenant repo before anything is written: an
//                 object git does not know is refused UNKNOWN_COMMIT (fleet#67).
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

// fleet#58: a pattern matches in the case the tenant wrote it. Compiled with
// the `i` flag, the SQL pattern `TRUNCATE` fired on the English word
// "truncated" in a comment (endzone PR #1344) and booked an opus risk review
// on a false trigger. `DROP TABLE`, `DELETE FROM`, `FOR UPDATE` are SQL and
// `JWT_SECRET` is a constant: their case is the signal. A tenant that wants a
// case-insensitive pattern writes the alternation itself (`[Tt]runcate`).
function patternRegExp(pattern) {
  try { return new RegExp(pattern); } catch {
    return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
  const git = (args) => gitInRepo(repoPath, args);
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

// fleet#43: a supplied finding never carries its own resolution. On endzone PR
// #1280 the IC wrote `outcome: "fixed"` beside the forced `status: "open"`,
// read the artifact as five resolved findings, and the machine read six open;
// `outcome` (ReportFindings' field) appeared nowhere in the resolution logic.
// The artifact says what the reviewer FOUND; what closed a finding is recorded
// by the review that verified the close, through --resolutions (ADR 0009, 5).
const RESOLUTION_LIKE_FIELDS = Object.freeze(['outcome', 'resolution']);

// #117: the audit counted 485 findings with 12+ severity spellings and 41 blank,
// so nothing downstream (the fleet-review status, the repeat escalation) could
// read a severity. Every supplied finding names one from the enum and a
// kebab-case category; carried findings are history and keep what they say.
const SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'nit']);
const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSuppliedFinding(finding, index) {
  const name = finding && finding.id ? `${finding.id} (#${index + 1})` : `#${index + 1}`;
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    throw new ReviewPolicyError('INVALID_FINDING', `finding ${name} is not an object`, { finding: index + 1 });
  }
  if (!SEVERITIES.includes(finding.severity)) {
    throw new ReviewPolicyError('INVALID_FINDING', `finding ${name} has severity ${finding.severity === undefined ? '(none)' : `'${finding.severity}'`}; severity is one of ${SEVERITIES.join(', ')} (#117)`, { finding: finding.id || index + 1, field: 'severity', allowed: SEVERITIES });
  }
  if (typeof finding.category !== 'string' || !CATEGORY_PATTERN.test(finding.category)) {
    throw new ReviewPolicyError('INVALID_FINDING', `finding ${name} has category ${finding.category === undefined ? '(none)' : `'${finding.category}'`}; category is a non-empty kebab-case string such as correctness, test-coverage or docs-drift (#117)`, { finding: finding.id || index + 1, field: 'category' });
  }
}

function buildFindings(stamp, suppliedFindings, priors, resolutions) {
  (suppliedFindings || []).forEach(validateSuppliedFinding);
  // Caller fields never override the forced-open status: openFindings gates the
  // unresolved-findings guard on it.
  const findings = (suppliedFindings || []).map((finding, index) => {
    const carried = RESOLUTION_LIKE_FIELDS.find((field) => finding[field] !== undefined);
    if (carried) {
      throw new ReviewPolicyError('FINDING_CARRIES_OUTCOME', `finding ${finding.id || `#${index + 1}`} carries \`${carried}\`; a recorded finding is open (the artifact says what the reviewer found), and what closed it is recorded through --resolutions on the review that verified the close: a risk finding by the lead's formal review, a formal finding by the linked re-review`, { finding: finding.id || index + 1, field: carried });
    }
    return { ...finding, id: finding.id || `${stamp}-f${index + 1}`, status: 'open' };
  });
  for (const { data, path: priorPath } of priors) {
    if (!data) continue;
    // Carry the still-open prior findings forward so the latest artifact is the
    // complete unresolved set; resolved and not-real material is settled.
    for (const finding of openFindings(data)) {
      if (resolutions[finding.id] === 'still-open') {
        findings.push({ ...finding, status: 'open', carriedFrom: priorPath });
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

// --- fleet#67: a recorded head is a commit ---------------------------------
// `record --kind risk` on endzone #1382 accepted headSha
// 0f2fb0064a7d4a0b5c1e2f3a4b5c6d7e8f9a0b1c: the branch head's real 8-character
// prefix followed by a padded pattern, and kept an idempotency key for it. The
// risk chain, plan-rereview ranges and the merge-time head check all key off
// these SHAs, so a typed or invented one made an artifact look as if it covered
// a head nobody read. Every SHA the record is given (`--head-sha`, and
// `--reviewed-sha` when it differs) is now resolved against the tenant repo
// after a fetch of the record's PR branch, so a head pushed a moment ago still
// resolves; a fetch that fails (offline, no such branch yet) is tolerated, a
// missing object never is. The repo is `--repo-path` or the tenant file's
// `repo`; with neither the record is refused, never skipped.

function tenantRepoPath({ root, recordId, record, repoPath }) {
  if (repoPath) return String(repoPath);
  const tenant = record?.tenant || String(recordId).split(':')[0];
  const file = path.join(root, 'tenants', `${tenant}.json`);
  let configured = null;
  if (fs.existsSync(file)) {
    try { configured = loadTenant(root, tenant).repo || null; } catch { configured = null; }
  }
  if (!configured) {
    throw new ReviewPolicyError('TENANT_REPO_UNKNOWN', `cannot resolve the head against a repository: pass --repo-path <tenant repo> or set "repo" in ${path.relative(root, file) || file} (fleet#67)`, { tenant, tenantFile: file });
  }
  return String(configured);
}

function gitInRepo(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
}

function verifyRecordedCommits({ root, recordId, record, shas, repoPath, git }) {
  const repo = tenantRepoPath({ root, recordId, record, repoPath });
  const run = git ? (args) => git(args, repo) : (args) => gitInRepo(repo, args);
  const branch = record?.assignment?.branch;
  if (branch) {
    try { run(['fetch', '--quiet', 'origin', String(branch)]); } catch { /* offline or not yet pushed: the object may still be local */ }
  }
  for (const { flag, sha } of shas) {
    try {
      run(['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      throw new ReviewPolicyError('UNKNOWN_COMMIT', `${flag} ${sha} is not a commit in ${repo}${branch ? ` (after fetching origin/${branch})` : ''}; a review is recorded at a head that exists, never at a typed or invented SHA (fleet#67)`, { flag, sha: String(sha), repoPath: repo, branch: branch || null });
    }
  }
  return repo;
}

// --- #115: the fleet-review commit status (ADR 0014) ------------------------
// "No merge without a recorded formal review" lived in the lead's role file,
// and pr-watch could only see a merge, never stop one: endzone #1241 and #1263
// merged on 2026-09-12 with no review. A formal record now posts a commit
// status on the head it reviewed, under the tenant's `reviewStatus` context,
// and the tenant's branch ruleset requires it (#120). The status is evidence
// that a review was recorded for that commit: `success` when no open finding
// is blocking, `failure` otherwise. A carried finding with a legacy severity
// is blocking unless it reads as minor or nit, so an unreadable severity
// fails closed. A failed post never undoes the record: the artifact and the
// `review-recorded` event stand, the result says `statusPosted: false`, the
// CLI exits 3, and `record --repost --id <id>` posts again. A tenant with no
// `reviewStatus` posts nothing. `reviewStatus` is not in `ciGates`: review
// waits for the gates, so a gate that waits for the review would deadlock.

const NON_BLOCKING_SEVERITIES = Object.freeze(['minor', 'nit', 'low', 'info', 'trivial', 'suggestion', 'cosmetic']);
const STATUS_DESCRIPTION_LIMIT = 140; // GitHub's cap on a commit status description

function isBlockingFinding(finding) {
  return !NON_BLOCKING_SEVERITIES.includes(String(finding?.severity || '').trim().toLowerCase());
}

function reviewStatusFor(artifact, artifactPath) {
  const open = openFindings(artifact || {});
  const blocking = open.filter(isBlockingFinding);
  const state = blocking.length ? 'failure' : 'success';
  const tally = open.length ? `${open.length} open, ${blocking.length} blocking` : 'no open findings';
  return { state, description: `${tally}; ${artifactPath}`.slice(0, STATUS_DESCRIPTION_LIMIT) };
}

function defaultGh(args) {
  // FLEET_GH names another executable (the tests use one that always fails).
  return execFileSync(process.env.FLEET_GH || 'gh', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
  });
}

function tenantFor(root, name) {
  if (!name) return null;
  const file = path.join(root, 'tenants', `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return loadTenant(root, name);
}

// The status API wants the full SHA; a head recorded before fleet#67 may be
// abbreviated, so it is expanded in the tenant repo when that repo answers.
function fullSha(sha, repoPath, git) {
  if (!repoPath) return String(sha);
  try {
    const run = git ? (args) => git(args, repoPath) : (args) => gitInRepo(repoPath, args);
    const resolved = String(run(['rev-parse', '--verify', `${sha}^{commit}`]) || '').trim();
    return /^[0-9a-f]{40}$/i.test(resolved) ? resolved : String(sha);
  } catch {
    return String(sha);
  }
}

function postReviewStatus({ tenant, headSha, artifact, artifactPath, gh }) {
  if (!tenant || typeof tenant.reviewStatus !== 'string' || !tenant.reviewStatus.trim()) return null;
  const context = tenant.reviewStatus.trim();
  const { state, description } = reviewStatusFor(artifact, artifactPath);
  const status = { context, state, sha: String(headSha), description };
  if (!tenant.github) return { statusPosted: false, status, statusError: `tenant ${tenant.name || ''} has no "github" slug to post ${context} to` };
  try {
    (gh || defaultGh)(['api', '--method', 'POST', `repos/${tenant.github}/statuses/${headSha}`,
      '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`]);
    return { statusPosted: true, status };
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim().slice(0, 500);
    return { statusPosted: false, status, statusError: detail || 'gh exited nonzero' };
  }
}

function repostReviewStatus(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const { recordId } = options;
  if (!recordId) throw new ReviewPolicyError('USAGE', '--repost needs --id <record>');
  const record = workState.getRecord({ root, id: recordId });
  const formal = record.review?.formal;
  if (!formal) throw new ReviewPolicyError('NO_PRIOR_REVIEW', `no formal review is recorded for ${recordId}; nothing to repost`);
  const artifact = readArtifact(root, formal.artifact);
  if (artifact === null) throw new ReviewPolicyError('ARTIFACT_MISSING', `the recorded formal artifact ${formal.artifact} is missing; its status cannot be derived`);
  const tenant = options.tenant || tenantFor(root, record.tenant || String(recordId).split(':')[0]);
  let repoPath = options.repoPath || null;
  if (!repoPath) { try { repoPath = tenantRepoPath({ root, recordId, record }); } catch { repoPath = null; } }
  const posted = postReviewStatus({ tenant, headSha: fullSha(formal.headSha, repoPath, options.git), artifact, artifactPath: formal.artifact, gh: options.gh });
  if (!posted) throw new ReviewPolicyError('NO_REVIEW_STATUS', `tenant ${tenant?.name || record.tenant} names no reviewStatus; nothing is posted`);
  return { artifact: formal.artifact, ...posted };
}

function recordReviewArtifact(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const { recordId, kind, headSha, actor } = options;
  if (!recordId || !headSha) throw new ReviewPolicyError('USAGE', 'recordId and headSha are required');
  if (!['formal', 'risk'].includes(kind)) throw new ReviewPolicyError('INVALID_REVIEW_KIND', `unknown review kind '${kind}'`);
  // fleet#43: `headSha` is the head the artifact is recorded against;
  // `reviewedSha` is the tree the reviewer actually read. An IC that fixes
  // findings after the risk reviewer read the tree records at the post-fix
  // head with the reviewer's tree named, and the uncovered delta becomes the
  // artifact's `range` instead of an implied "reviewed". A formal review is the
  // lead's own read at the head it records, so there the two must agree; a
  // moved head is a re-review, never a record at a tree nobody read.
  const reviewedSha = options.reviewedSha !== undefined && options.reviewedSha !== null ? String(options.reviewedSha) : String(headSha);
  if (kind === 'formal' && reviewedSha !== String(headSha)) {
    throw new ReviewPolicyError('REVIEWED_SHA_MISMATCH', `a formal review is recorded at the head it read: --reviewed-sha ${reviewedSha} differs from --head-sha ${headSha}; re-review at ${headSha} (plan-rereview scopes it) rather than record a review of a tree nobody read`, { reviewedSha, headSha: String(headSha) });
  }
  const classification = options.classification || {};
  // fleet#64: a formal record with no classification read `triggers: []` and
  // walked past every trigger guard, so a triggered head was formally recorded
  // with no risk review ever having existed (Endzone PR #1380, formal-002 at
  // c4e31d2c). The lead classifies the head before it reviews (project-lead.md,
  // Merge); the record now carries that answer, and a triggered head needs its
  // risk artifact (below) unless the lead rules the trigger on record.
  if (kind === 'formal' && typeof classification.tier !== 'string') {
    throw new ReviewPolicyError('CLASSIFICATION_REQUIRED', `a formal review records the head's classification: pass --classification '<json>' from review-policy.js classify at ${headSha}`, { headSha: String(headSha) });
  }
  const riskRuling = typeof options.riskRuling === 'string' && options.riskRuling.trim().length > 0 ? options.riskRuling.trim() : null;
  if (riskRuling && kind !== 'formal') throw new ReviewPolicyError('USAGE', '--risk-ruling belongs to a formal review: it is the lead ruling on a trigger');
  // Ticket 09: with state/flags/review-dedup-off every review pass is written down (the
  // legacy behaviour). The default replay key is kind:record:head, which would make a
  // second pass at the same head replay the first, so under the flag the default key
  // carries the moment too, and a same-head formal pass is not held to the re-review link.
  const dedupOff = fs.existsSync(path.join(root, 'state', 'flags', 'review-dedup-off'));
  // fleet#19: the replay key identifies the review, not the head. A formal
  // re-review that links its prior artifact is a new review even at an
  // unchanged head (a body-only revision: the PR body carries the measurement
  // claims and becomes the squash commit message), so the link is part of the
  // key; a retry of that same re-review still replays (ADR 0009, ruling 3).
  const linkedRereview = kind === 'formal' && typeof options.priorArtifact === 'string' && options.priorArtifact.length > 0;
  const key = options.idempotencyKey || `${kind}:${recordId}:${headSha}${linkedRereview ? `:rereview:${options.priorArtifact}` : ''}${dedupOff ? `:${new Date(options.now || Date.now()).toISOString()}` : ''}`;
  const pinnedRevision = options.expectedRevision !== undefined && Number.isInteger(Number(options.expectedRevision))
    ? Number(options.expectedRevision) : null;

  let written = null;
  let verifiedRepo = null;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const record = workState.getRecord({ root, id: recordId });

      // An identical retry replays: return the artifact the record references.
      if (record.idempotency?.[key]) {
        if (written) fs.rmSync(written.file, { force: true });
        const artifact = record.review?.[kind]?.artifact || null;
        // A replay writes nothing: say so, with what it did not write, so a
        // caller reading a formatted summary cannot take it for a record (fleet#19).
        const ignored = { findings: (options.findings || []).length, resolutions: Object.keys(options.resolutions || {}).length };
        return {
          artifact,
          ...(ignored.findings || ignored.resolutions ? { ignored } : {}),
          result: { replayed: true, revision: record.idempotency[key].revision, eventSequence: record.idempotency[key].eventSequence, record },
        };
      }

      const prior = record.review?.[kind] || null;
      if (prior && prior.headSha === String(headSha) && !dedupOff && !linkedRereview) {
        throw new ReviewPolicyError('ALREADY_REVIEWED', `a ${kind} review is already recorded for ${recordId} at ${headSha}`, { artifact: prior.artifact });
      }
      if (kind === 'risk' && !(classification.triggers || []).length) {
        throw new ReviewPolicyError('RISK_REVIEW_NOT_TRIGGERED', 'a risk review requires a configured trigger; a normal PR never launches the risk reviewer');
      }
      // fleet#64: a triggered head has its risk artifact before the formal review
      // records. A first formal at a head needs the risk artifact at that head;
      // a linked re-review (--prior-artifact) is scoped to the delta since the
      // prior formal, which already walked the risk chain (fleet#43), so an
      // earlier-head risk artifact stands there and the lead verifies the delta
      // by hand. --risk-ruling "<why>" is the lead ruling the trigger (a false
      // positive, or covered) and is written into the artifact.
      if (kind === 'formal' && (classification.triggers || []).length && !riskRuling) {
        const risk = record.review?.risk || null;
        const names = (classification.triggers || []).map((trigger) => trigger.class || trigger).join(', ');
        const staleForFreshReview = risk && risk.headSha !== String(headSha) && !linkedRereview;
        if (!risk || staleForFreshReview) {
          throw new ReviewPolicyError('RISK_REVIEW_MISSING', `classification at ${headSha} carries trigger(s) ${names} and ${risk ? `the recorded risk artifact ${risk.artifact} is at ${risk.headSha}, not this head` : 'no risk artifact is recorded'}; the IC hosts the risk reviewer pre-PR-ready and records it at this head (ic.md), or the lead rules the trigger on record with --risk-ruling "<why>"`, { headSha: String(headSha), triggers: names, riskArtifact: risk ? risk.artifact : null, riskHeadSha: risk ? risk.headSha : null });
        }
      }

      let priorArtifactData = null;
      let priorArtifactMissing = false;
      let range = kind === 'risk' && reviewedSha !== String(headSha) ? `${reviewedSha}..${headSha}` : null;
      const resolutions = options.resolutions || null;
      const sameHeadPassUnderFlag = dedupOff && prior && prior.headSha === String(headSha) && !options.priorArtifact;
      // Every artifact whose open findings this review must account for: the
      // linked formal prior, and (fleet#43) the risk artifact the formal
      // review consumes. Each open finding needs a resolution; still-open ones
      // are carried into this artifact so it stays the complete unresolved set.
      const priors = [];
      if (kind === 'formal' && prior && !sameHeadPassUnderFlag) {
        if (!options.priorArtifact || options.priorArtifact !== prior.artifact) {
          throw new ReviewPolicyError('REREVIEW_REQUIRES_PRIOR', `a revision re-review must link the prior findings artifact ${prior.artifact}`, { priorArtifact: prior.artifact });
        }
        priorArtifactData = readArtifact(root, prior.artifact);
        range = `${prior.headSha}..${headSha}`;
        // fleet#19: a re-review at an unchanged head exists to resolve prior
        // findings. With nothing open (or no readable prior) there is nothing
        // to re-review at this head, and a linked chain of clean same-head
        // artifacts would only look like N reviews; that is one review.
        if (prior.headSha === String(headSha) && (priorArtifactData === null || !openFindings(priorArtifactData).length)) {
          throw new ReviewPolicyError('ALREADY_REVIEWED', `a formal review is already recorded for ${recordId} at ${headSha} and ${prior.artifact} has nothing open to resolve; a re-review at an unchanged head needs an open prior finding`, { artifact: prior.artifact });
        }
        // The referenced file is gone (crash, hand cleanup, pruned tree):
        // degrade honestly instead of wedging the record forever.
        if (priorArtifactData === null) priorArtifactMissing = true;
        priors.push({ data: priorArtifactData, path: prior.artifact });
      }
      // fleet#43: nothing walked the risk chain. `prior` is scoped per kind, so
      // a formal review never saw risk findings and a risk artifact was
      // write-only: recorded once, resolved by nothing, unable to go stale.
      // The lead already verifies every risk finding by hand (project-lead.md,
      // Merge); the formal review that does so now records it: the risk
      // artifact's open findings need a resolution like any linked prior, and
      // the formal artifact names the risk artifact it consumed, so a later
      // re-review binds to the formal chain alone (ADR 0009, ruling 5).
      let riskArtifact = null;
      let riskArtifactMissing = false;
      if (kind === 'formal') {
        const risk = record.review?.risk || null;
        const consumedByPrior = risk && priorArtifactData && priorArtifactData.riskArtifact === risk.artifact;
        if (risk && !consumedByPrior) {
          riskArtifact = risk.artifact;
          const riskData = readArtifact(root, risk.artifact);
          if (riskData === null) riskArtifactMissing = true;
          priors.push({ data: riskData, path: risk.artifact });
        }
      }
      for (const { data, path: priorPath } of priors) {
        if (!data) continue;
        const open = openFindings(data);
        for (const finding of open) {
          const resolution = resolutions?.[finding.id];
          if (!resolution) {
            throw new ReviewPolicyError('UNRESOLVED_FINDINGS_UNACCOUNTED', `prior finding ${finding.id} in ${priorPath} has no resolution`, { unresolved: open.map((entry) => entry.id), artifact: priorPath });
          }
          if (!RESOLUTION_VALUES.includes(resolution)) {
            throw new ReviewPolicyError('INVALID_RESOLUTION', `resolution '${resolution}' for ${finding.id} is not one of ${RESOLUTION_VALUES.join(', ')}`);
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
      const preview = buildFindings('pending', supplied, priors, resolutions);
      if (noFindings !== undefined) {
        if (typeof noFindings !== 'string' || !noFindings.trim() || noFindings === 'true') {
          throw new ReviewPolicyError('USAGE', '--no-findings needs a one-sentence statement of what was examined and what was concluded');
        }
        if (preview.length) {
          const carried = preview.length - supplied.length;
          const carriedFrom = [...new Set(preview.filter((finding) => finding.carriedFrom).map((finding) => finding.carriedFrom))];
          throw new ReviewPolicyError('USAGE', `the artifact would carry ${preview.length} finding(s) (${supplied.length} new, ${carried} still open from ${carriedFrom.length ? carriedFrom.join(' and ') : 'the prior artifact'}); it is not a no-findings review, omit --no-findings`);
        }
      } else if (!preview.length) {
        throw new ReviewPolicyError('EMPTY_FINDINGS', `a ${kind} review with no findings must say so: pass --no-findings "<what was examined and what was concluded>" so the artifact is not read as lost content`);
      }

      // fleet#67: the last guard before the write. It runs git (a fetch of the
      // PR branch), so every cheaper refusal above keeps precedence over it;
      // an artifact is never written for a head the tenant repo does not hold.
      if (!written) {
        const shas = [{ flag: '--head-sha', sha: String(headSha) }];
        if (reviewedSha !== String(headSha)) shas.push({ flag: '--reviewed-sha', sha: reviewedSha });
        verifiedRepo = verifyRecordedCommits({ root, recordId, record, shas, repoPath: options.repoPath, git: options.git });
      }
      if (!written) {
        written = writeArtifactExclusive(root, recordId, kind, (stamp) => ({
          schemaVersion: 1,
          recordId,
          kind,
          headSha: String(headSha),
          // fleet#43: the tree the reviewer read. Equal to headSha unless the
          // caller said otherwise (risk only); `range` then names the delta
          // no reviewer at this angle has looked at.
          reviewedSha,
          range,
          // Descriptive only: under review-dedup-off a same-head pass skips the
          // linked re-review checks, so sameHead does not imply resolutions ran.
          sameHead: prior && prior.headSha === String(headSha) ? true : undefined,
          tier: classification.tier || null,
          triggers: classification.triggers || [],
          reviewer: actor || 'unknown',
          at: options.now ? new Date(options.now).toISOString() : new Date().toISOString(),
          priorArtifact: prior ? prior.artifact : null,
          priorArtifactMissing: priorArtifactMissing || undefined,
          // fleet#43 (formal only): the risk artifact whose open findings this
          // review accounted for; null when there was none or a prior formal
          // review already consumed it.
          ...(kind === 'formal' ? { riskArtifact, riskArtifactMissing: riskArtifactMissing || undefined, riskRuling: riskRuling || undefined } : {}),
          resolutions,
          noFindings: noFindings ? noFindings.trim() : null,
          findings: buildFindings(stamp, options.findings, priors, resolutions),
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
        // #115: a formal record posts the tenant's review status on the head it
        // reviewed. After the commit, outside the retry: a failed post never
        // undoes the record (the caller sees statusPosted: false, exit 3).
        if (kind === 'formal') {
          const tenant = options.tenant || tenantFor(root, record.tenant || String(recordId).split(':')[0]);
          const posted = postReviewStatus({
            tenant, headSha: fullSha(headSha, verifiedRepo, options.git),
            artifact: readArtifact(root, written.relative), artifactPath: written.relative, gh: options.gh,
          });
          if (posted) return { artifact: written.relative, result, ...posted };
        }
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
  // the outbox line is the delivery cache, written by the transition door itself
  // (work-state.js, fleet#56: every decision transition writes it, whoever
  // calls), and the ticket-07 notifier is launched when this call wrote the
  // line (it claims through the state command, so a second launch finds the
  // claim and sends nothing). A crash between the transition and the append is
  // repaired by any retry, which finds the committed transition (replay) but no
  // outbox line, writes it, and delivers the page.
  const paged = Boolean(result.paged);
  if (paged && options.notifier) options.notifier({ root, recordId, sequence: result.eventSequence });
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
const RECORD_FLAGS = ['root', 'id', 'expected-revision', 'kind', 'head-sha', 'reviewed-sha', 'repo-path', 'actor', 'now', 'idempotency-key', 'evidence', 'classification', 'findings', 'no-findings', 'resolutions', 'prior-artifact', 'risk-ruling', 'repost'];
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
  // fleet#46: the reviewer is the session. `record` wrote `reviewer: "unknown"`
  // whenever --actor was omitted (and the documented line omitted it), which a
  // replay can never repair; FLEET_NAME is in every fleet session's environment.
  const actor = args.actor || process.env.FLEET_NAME || undefined;
  if (command === 'record' && args.repost !== undefined) {
    // #115: post the status again for the latest formal artifact; no new review.
    if (args.repost !== 'true') throw new ReviewPolicyError('USAGE', '--repost takes no value');
    const content = ['kind', 'head-sha', 'reviewed-sha', 'findings', 'no-findings', 'resolutions', 'prior-artifact', 'risk-ruling', 'classification', 'expected-revision', 'idempotency-key'].filter((flag) => args[flag] !== undefined);
    if (content.length) {
      throw new ReviewPolicyError('USAGE', `--repost posts the recorded formal review's status again and takes no review content: drop ${content.map((flag) => `--${flag}`).join(', ')}`);
    }
    if (args['repo-path'] === 'true') throw new ReviewPolicyError('USAGE', '--repo-path needs a path (fleet#67)');
    return repostReviewStatus({ root, recordId: args.id, repoPath: args['repo-path'] });
  }
  if (command === 'record') {
    if (args['repo-path'] === 'true') throw new ReviewPolicyError('USAGE', '--repo-path needs a path (fleet#67)');
    return recordReviewArtifact({
      root, recordId: args.id,
      expectedRevision: args['expected-revision'] !== undefined ? Number(args['expected-revision']) : undefined,
      kind: args.kind, headSha: args['head-sha'], reviewedSha: args['reviewed-sha'], actor, now: args.now,
      // fleet#67: the repo the SHAs resolve against; the tenant file's `repo` otherwise.
      repoPath: args['repo-path'],
      idempotencyKey: args['idempotency-key'], evidence: args.evidence,
      classification: args.classification ? JSON.parse(fs.existsSync(args.classification) ? fs.readFileSync(args.classification, 'utf8') : args.classification) : {},
      findings: args.findings ? JSON.parse(fs.existsSync(args.findings) ? fs.readFileSync(args.findings, 'utf8') : args.findings) : [],
      noFindings: args['no-findings'],
      resolutions: args.resolutions ? JSON.parse(args.resolutions) : null,
      priorArtifact: args['prior-artifact'],
      riskRuling: args['risk-ruling'],
    });
  }
  if (command === 'plan-rereview') {
    return planRereview({ root, recordId: args.id, headSha: args['head-sha'] });
  }
  // command === 'hold'
  return holdRecord({
    root, recordId: args.id, expectedRevision: Number(args['expected-revision']),
    reason: args.reason, actor, now: args.now, idempotencyKey: args['idempotency-key'],
    notifier: args['no-notifier'] === 'true' ? null : require('./notify').spawnNotifier,
  });
}

if (require.main === module) {
  try {
    const answer = cli(process.argv.slice(2));
    if (answer && answer.ignored) {
      // Loud on stderr, exit 0: the call was a retry and nothing was written.
      process.stderr.write(`replayed: ${answer.ignored.findings} finding(s) and ${answer.ignored.resolutions} resolution(s) supplied were NOT written; the recorded artifact ${answer.artifact} stands (a re-review at the same head links --prior-artifact; fleet#19)\n`);
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    if (answer && answer.statusPosted === false) {
      // #115: the review is recorded and only its status is missing. Exit 3 so
      // the caller sees it, and name the one command that repairs it.
      const context = answer.status?.context || 'review';
      process.stderr.write(`${JSON.stringify({ code: 'STATUS_NOT_POSTED', message: `the review stands (${answer.artifact}) but the ${context} status was not posted: ${answer.statusError}; run review-policy.js record --repost --id <record> once gh answers` })}\n`);
      process.exitCode = 3;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message })}\n`);
    // A refused invocation exits 2 so a caller reading only the status cannot
    // take it for a failed one, let alone for an answer (fleet#2).
    // INVALID_REVIEW_STATE is a refused invocation too (fleet#20): nothing was
    // recorded, and the message names the door that opens the state.
    // FINDING_CARRIES_OUTCOME and REVIEWED_SHA_MISMATCH (fleet#43) are refused
    // invocations too: nothing was recorded, and the message names the door.
    // UNKNOWN_COMMIT and TENANT_REPO_UNKNOWN (fleet#67) likewise: nothing was
    // recorded, and the message names the repo and the SHA.
    // INVALID_FINDING (#117) likewise: the finding and the allowed values are named.
    process.exitCode = ['USAGE', 'EMPTY_TENANT', 'INVALID_REVIEW_STATE', 'EMPTY_FINDINGS', 'FINDING_CARRIES_OUTCOME', 'REVIEWED_SHA_MISMATCH', 'CLASSIFICATION_REQUIRED', 'RISK_REVIEW_MISSING', 'UNKNOWN_COMMIT', 'TENANT_REPO_UNKNOWN', 'INVALID_FINDING'].includes(error.code) ? 2 : 1;
  }
}

module.exports = {
  CLASSIFY_FLAGS,
  COMMAND_FLAGS,
  ReviewPolicyError,
  SEVERITIES,
  classifyChange,
  cli,
  classifyFromGit,
  holdRecord,
  matchGlob,
  planRereview,
  recordReviewArtifact,
  repostReviewStatus,
  reviewStatusFor,
  verifyRecordedCommits,
};
