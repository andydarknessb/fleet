'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  RESERVATION_FIELDS,
  WorkStateError,
  getRecord,
  proofMatches,
  releaseRecord,
  reservationConflicts: workReservationConflicts,
  reserveRecord,
  transitionRecord,
} = require('./work-state');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeLabels(labels) {
  return (labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean).map(String);
}

function normalizeReservations(issue) {
  const source = issue.reservations || issue;
  return Object.fromEntries(RESERVATION_FIELDS.map((field) => [field, [...new Set((source[field] || []).map(String))].sort()]));
}

function normalizeIssue(issue) {
  const labels = normalizeLabels(issue.labels);
  const dependencies = issue.dependencies || issue.blockedBy || [];
  const unresolvedDependencies = dependencies.filter((dependency) => {
    if (dependency.resolved === true) return false;
    return !['CLOSED', 'MERGED', 'RESOLVED'].includes(String(dependency.state || '').toUpperCase());
  });
  const subIssues = issue.subIssuesSummary || issue.sub_issues_summary || {};
  const isSpecParent = Boolean(issue.isSpecParent || issue.specParent || (Number(subIssues.total) > Number(subIssues.completed || 0)));
  return {
    ...issue,
    number: Number(issue.number),
    state: String(issue.state || 'OPEN').toUpperCase(),
    labels,
    assignees: (issue.assignees || []).map((assignee) => typeof assignee === 'string' ? assignee : assignee.login || assignee.name).filter(Boolean),
    unresolvedDependencies,
    isSpecParent,
    bodyHash: issue.bodyHash || sha256(issue.body || ''),
    reservations: normalizeReservations(issue),
    createdAt: issue.createdAt || '9999-12-31T23:59:59.999Z',
  };
}

function activeRecords(records) {
  if (Array.isArray(records)) return records;
  if (records?.records) return Object.values(records.records);
  return Object.values(records || {});
}

// Ticket 07: structured Frontier exclusions (bin/exclusions.js projection) are the
// exclusion source; the legacy prose skip file is still honoured during shadow,
// with `source` telling the two apart for the parity comparison.
function localExclusionReasons(issue, skipIssues, exclusions) {
  const reasons = (exclusions || [])
    .filter((exclusion) => Number(exclusion.issue) === Number(issue.number))
    .map((exclusion) => ({ code: 'frontier-exclusion', source: 'exclusion-ledger', detail: `${exclusion.id}: ${exclusion.reason}`, id: exclusion.id, owner: exclusion.owner, evidence: exclusion.evidence, recheck: exclusion.recheck }));
  const value = skipIssues?.issues?.[String(issue.number)] ?? skipIssues?.[String(issue.number)];
  if (value === undefined) return reasons;
  if (typeof value === 'string') return [...reasons, { code: 'frontier-exclusion', source: 'legacy-skip', detail: value }];
  return [...reasons, ...Object.entries(value || {}).map(([code, detail]) => ({ code, detail }))];
}

function reservationConflicts(issue, records) {
  return workReservationConflicts(activeRecords(records), issue.reservations)
    .map((conflict) => ({ code: 'reservation-conflict', detail: `${conflict.field}:${conflict.value}`, owner: conflict.recordId, ownerIssue: conflict.issue }));
}

function independentPair(left, right) {
  return RESERVATION_FIELDS.every((field) => {
    const rightValues = new Set((right.reservations?.[field] || []).map(String));
    return !(left.reservations?.[field] || []).some((value) => rightValues.has(String(value)));
  });
}

function independenceProof(issues) {
  const conflicts = [];
  for (let left = 0; left < issues.length; left += 1) {
    for (let right = left + 1; right < issues.length; right += 1) {
      if (!independentPair(issues[left], issues[right])) conflicts.push({ left: issues[left].number, right: issues[right].number });
    }
  }
  return { independent: conflicts.length === 0, candidates: issues.map((issue) => issue.number), checkedFields: [...RESERVATION_FIELDS], conflicts };
}

function buildLaunchPlan({ frontier, active = [], maxIcs = 3 } = {}) {
  const candidates = (frontier?.eligible || []).map(normalizeIssue);
  const activeAssignments = activeRecords(active).filter((record) => record.manifestPath && record.state !== 'retired');
  const selected = [];
  for (const candidate of candidates) {
    if (activeAssignments.length + selected.length >= Math.min(2, maxIcs)) break;
    if (reservationConflicts(candidate, [...activeAssignments, ...selected]).length === 0) selected.push(candidate);
  }
  let thirdProof = null;
  if (maxIcs >= 3 && activeAssignments.length + selected.length < 3) {
    const third = candidates.find((candidate) => !selected.some((entry) => entry.number === candidate.number));
    if (third) {
      thirdProof = independenceProof([...activeAssignments, ...selected, third]);
      if (thirdProof.independent) selected.push(third);
    }
  }
  return { assignments: selected, thirdProof };
}

function selectFrontier({ issues, readyLabel, skipIssues = {}, exclusions = [], active = [], now } = {}) {
  if (!Array.isArray(issues)) throw new WorkStateError('INVALID_GITHUB_FIXTURE', 'issues must be an array');
  const normalized = issues.map(normalizeIssue);
  const activeByIssue = new Map(activeRecords(active).filter((record) => record.state !== 'retired').map((record) => [Number(record.issue), record]));
  const eligible = [];
  const excluded = [];
  for (const issue of normalized) {
    const reasons = [];
    if (issue.state !== 'OPEN') reasons.push({ code: 'not-open', detail: `GitHub state is ${issue.state}` });
    if (readyLabel && !issue.labels.includes(readyLabel)) reasons.push({ code: 'not-ready', detail: `missing ${readyLabel}` });
    if (issue.assignees.length) reasons.push({ code: 'assigned', detail: issue.assignees.join(', ') });
    if (issue.unresolvedDependencies.length) reasons.push({ code: 'dependency-blocked', detail: issue.unresolvedDependencies.map((dependency) => dependency.number || dependency.id || dependency).join(', ') });
    if (issue.isSpecParent) reasons.push({ code: 'spec-parent', detail: 'sub-issues remain or issue is marked as a spec parent' });
    if (issue.labels.includes('ready-for-human')) reasons.push({ code: 'ready-for-human', detail: 'ready-for-human label is present' });
    reasons.push(...localExclusionReasons(issue, skipIssues, exclusions));
    if (activeByIssue.has(issue.number)) reasons.push({ code: 'reserved', detail: `active Work record ${activeByIssue.get(issue.number).id}` });
    reasons.push(...reservationConflicts(issue, active));
    if (reasons.length) excluded.push({ issue: issue.number, reasons });
    else eligible.push(issue);
  }
  eligible.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.number - b.number);
  return { eligible, excluded, observedAt: now || new Date().toISOString() };
}

function queryGithubIssues({ repo, readyLabel, executable = 'gh', runner = execFileSync, fetchDetails = false } = {}) {
  if (!repo || !readyLabel) throw new WorkStateError('INVALID_GITHUB_QUERY', 'repo and readyLabel are required');
  try {
    if (fetchDetails) {
      const [owner, name] = String(repo).split('/');
      if (!owner || !name) throw new Error(`repo must be owner/name when fetching issue details: ${repo}`);
      const query = 'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number,title,url,body,createdAt,state,labels(first:20){nodes{name}},assignees(first:20){nodes{login}},blockedBy(first:100){nodes{number,state} pageInfo{hasNextPage}},subIssues(first:100){nodes{number,state} pageInfo{hasNextPage}}} pageInfo{hasNextPage,endCursor}}}}';
      const nodes = [];
      let cursor = null;
      do {
        const queryArgs = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
        if (cursor) queryArgs.push('-f', `cursor=${cursor}`); else queryArgs.push('-F', 'cursor=null');
        const raw = runner(executable, queryArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 });
        const result = JSON.parse(raw);
        const page = result?.data?.repository?.issues;
        if (!Array.isArray(page?.nodes)) throw new Error('GitHub GraphQL issue query did not return nodes');
        nodes.push(...page.nodes);
        const next = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
        if (page.pageInfo?.hasNextPage && !next) throw new Error('GitHub GraphQL issue query omitted its next cursor');
        if (next && next === cursor) throw new Error('GitHub GraphQL issue query repeated its cursor');
        cursor = next;
      } while (cursor);
      return nodes.map((issue) => ({
        ...issue,
        labels: issue.labels?.nodes || issue.labels,
        assignees: issue.assignees?.nodes || issue.assignees,
        dependencies: [...(issue.blockedBy?.nodes || []), ...(issue.blockedBy?.pageInfo?.hasNextPage ? [{ number: 'additional dependencies', state: 'OPEN' }] : [])],
        subIssuesSummary: { total: (issue.subIssues?.nodes?.length || 0) + (issue.subIssues?.pageInfo?.hasNextPage ? 1 : 0), completed: (issue.subIssues?.nodes || []).filter((subIssue) => String(subIssue.state).toUpperCase() === 'CLOSED').length, truncated: Boolean(issue.subIssues?.pageInfo?.hasNextPage) },
        bodyHash: sha256(issue.body || ''),
      }));
    }
    const raw = runner(executable, ['issue', 'list', '-R', String(repo), '--state', 'open', '--limit', '100', '--json', 'number,title,url,body,createdAt,state,labels,assignees'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 });
    const issues = JSON.parse(raw);
    if (!Array.isArray(issues)) throw new Error('GitHub issue list did not return an array');
    return issues.map((issue) => ({ ...issue, bodyHash: sha256(issue.body || '') }));
  } catch (error) {
    throw new WorkStateError('GITHUB_QUERY_FAILED', String(error.stderr || error.message || error));
  }
}

function resolveRemoteBase({ repoPath, remote = 'origin', ref = 'integration', executable = 'git', runner = execFileSync } = {}) {
  if (!repoPath) throw new WorkStateError('INVALID_BASE_QUERY', 'repoPath is required');
  try {
    runner(executable, ['-C', repoPath, 'fetch', remote, ref, '--prune'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000 });
    const raw = runner(executable, ['-C', repoPath, 'rev-parse', `refs/remotes/${remote}/${ref}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10000 });
    const sha = String(raw).trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`invalid remote base SHA: ${sha}`);
    return { remote, ref, sha };
  } catch (error) {
    throw new WorkStateError('BASE_RECONCILIATION_FAILED', String(error.stderr || error.message || error));
  }
}

function slug(value) {
  return String(value || 'issue').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'issue';
}

function manifestFile(root, id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(path.resolve(root), 'state', 'manifests', `${safe}.json`);
}

function writeManifest(root, manifest) {
  const file = manifestFile(root, manifest.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new WorkStateError('MANIFEST_EXISTS', `manifest '${manifest.id}' already exists`);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return file;
}

function buildManifest({ issue, tenant, tenantConfig = {}, readyLabel, parent = 'pl-endzone', model = 'sonnet', risk = 'standard', tokenBudget = 25000, base, contextHeadings = [], adrPaths = [], testPlan = [], ciGates = [], independenceProof, now, workRecordId } = {}) {
  const normalized = normalizeIssue(issue);
  const createdAt = now || new Date().toISOString();
  const id = `assignment-${tenant}-issue-${normalized.number}-${normalized.bodyHash.slice(0, 12)}`;
  const branch = `${tenantConfig.branchPrefix || 'fleet/'}${normalized.number}-${slug(normalized.title)}`;
  return {
    schemaVersion: 1,
    id,
    status: 'pending-ack',
    createdAt,
    workRecordId: workRecordId || `${tenant}:issue-${normalized.number}`,
    workRecordRevision: 1,
    readyLabel: readyLabel || tenantConfig.readyLabel || null,
    issue: { number: normalized.number, url: normalized.url || null, bodyHash: normalized.bodyHash },
    base: { remote: base.remote, ref: base.ref, sha: base.sha },
    branch,
    tenant,
    parent,
    model,
    risk,
    tokenBudget,
    contextHeadings: [...contextHeadings],
    adrPaths: [...adrPaths],
    testPlan: [...testPlan],
    ciGates: [...ciGates],
    reservations: normalized.reservations,
    independenceProof: independenceProof || null,
  };
}

function reserveAssignment({ root, issue, tenant, tenantConfig = {}, active = [], skipIssues = {}, exclusions = [], readyLabel, repoPath, base, remote = 'origin', ref, parent, model, risk, tokenBudget, contextHeadings, adrPaths, testPlan, ciGates, independenceProof: proof, now, actor = 'assignment-planner', runner } = {}) {
  const frontier = selectFrontier({ issues: [issue], readyLabel, active, skipIssues, exclusions, now });
  if (!frontier.eligible.length) throw new WorkStateError('NO_FRONTIER', 'issue is not eligible for assignment', { excluded: frontier.excluded });
  const normalized = frontier.eligible[0];
  const resolvedBase = base || resolveRemoteBase({ repoPath, remote, ref: ref || tenantConfig.defaultBranch || 'integration', runner });
  const workRecordId = `${tenant}:issue-${normalized.number}`;
  const activeAssignments = activeRecords(active).filter((record) => record.manifestPath && record.state !== 'retired');
  const expectedProof = independenceProof([...activeAssignments, normalized]);
  if (activeAssignments.length >= 3 || (activeAssignments.length >= 2 && !proofMatches(expectedProof, proof))) throw new WorkStateError('THIRD_ASSIGNMENT_REQUIRES_PROOF', 'a third assignment requires a verified independent machine-readable proof');
  const manifest = buildManifest({ issue: normalized, tenant, tenantConfig, readyLabel, parent, model, risk, tokenBudget, base: resolvedBase, contextHeadings, adrPaths, testPlan, ciGates, independenceProof: proof, now, workRecordId });
  const manifestPath = writeManifest(root, manifest);
  try {
    const reserved = reserveRecord({
      root, id: workRecordId, tenant, issue: normalized.number, manifestPath, assignment: { manifestId: manifest.id, branch: manifest.branch, baseSha: manifest.base.sha, independenceProof: proof || null },
      github: { issueNumber: normalized.number, issueUrl: normalized.url, bodyHash: normalized.bodyHash }, reservations: normalized.reservations, independenceProof: proof,
      evidence: { github: `gh issue view ${normalized.number}`, manifest: path.relative(path.resolve(root), manifestPath) },
      idempotencyKey: `assignment-reserved:${manifest.id}`, actor, now,
    });
    return { frontier, manifest, manifestPath, reservation: reserved };
  } catch (error) {
    fs.rmSync(manifestPath, { force: true });
    throw error;
  }
}

function validateManifest({ manifest, issue, base } = {}) {
  const current = normalizeIssue(issue);
  const mismatches = [];
  if (current.bodyHash !== manifest.issue.bodyHash) mismatches.push({ field: 'issue.bodyHash', expected: manifest.issue.bodyHash, actual: current.bodyHash });
  if (base && base.sha !== manifest.base.sha) mismatches.push({ field: 'base.sha', expected: manifest.base.sha, actual: base.sha });
  return { valid: mismatches.length === 0, mismatches };
}

function invalidateManifest({ root, manifest, currentRevision, reason, now, actor = 'assignment-planner' } = {}) {
  const released = releaseRecord({ root, id: manifest.workRecordId, expectedRevision: currentRevision, idempotencyKey: `assignment-invalidated:${manifest.id}`, evidence: { manifest: manifest.id, reason }, actor, now });
  const invalidation = { schemaVersion: 1, manifestId: manifest.id, invalidatedAt: now || new Date().toISOString(), reason };
  const file = `${manifestFile(root, manifest.id)}.invalidated.json`;
  fs.writeFileSync(file, `${JSON.stringify(invalidation, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { invalidation, invalidationPath: file, released };
}

function writeSidecar(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return file;
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return file;
}

function launchReservedAssignment({ manifestPath, workRecordId, root, launchScript, repoPath, githubRepo, powershell = 'powershell', dryRun = false, runner = execFileSync } = {}) {
  if (!manifestPath || !workRecordId) throw new WorkStateError('INVALID_LAUNCH', 'manifestPath and workRecordId are required');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.workRecordId !== workRecordId || manifest.status !== 'pending-ack') throw new WorkStateError('INVALID_LAUNCH', 'manifest identity or acknowledgment status is invalid');
  if (fs.existsSync(`${manifestPath}.invalidated.json`)) throw new WorkStateError('MANIFEST_INVALIDATED', `manifest '${manifest.id}' was invalidated`);
  if (fs.existsSync(`${manifestPath}.acknowledged.json`)) throw new WorkStateError('ASSIGNMENT_ALREADY_ACKNOWLEDGED', `manifest '${manifest.id}' was already acknowledged`);
  const invalidate = (reason) => {
    if (root) {
      const record = getRecord({ root, id: workRecordId });
      if (record.state === 'assigned') invalidateManifest({ root, manifest, currentRevision: record.revision, reason });
    }
  };
  if (root) {
    const record = getRecord({ root, id: workRecordId });
    if (record.state !== 'assigned') throw new WorkStateError('INVALID_LAUNCH', `Work record '${workRecordId}' is ${record.state}, not assigned`);
  }
  if (githubRepo) {
    const current = queryGithubIssues({ repo: githubRepo, readyLabel: manifest.readyLabel || 'ready-for-agent', runner, fetchDetails: true }).find((issue) => issue.number === manifest.issue.number);
    if (!current) { invalidate('issue is no longer returned by GitHub'); throw new WorkStateError('GITHUB_QUERY_FAILED', `issue #${manifest.issue.number} was not returned by GitHub`); }
    const currentBase = repoPath ? resolveRemoteBase({ repoPath, remote: manifest.base.remote, ref: manifest.base.ref, runner }) : null;
    const validation = validateManifest({ manifest, issue: current, base: currentBase });
    if (!validation.valid) { invalidate(validation.mismatches); throw new WorkStateError('MANIFEST_PRECONDITION_CHANGED', 'manifest precondition changed before launch', { mismatches: validation.mismatches }); }
  }
  if (repoPath && !dryRun) {
    const base = resolveRemoteBase({ repoPath, remote: manifest.base.remote, ref: manifest.base.ref, runner });
    if (base.sha !== manifest.base.sha) { invalidate([{ field: 'base.sha', expected: manifest.base.sha, actual: base.sha }]); throw new WorkStateError('BASE_PRECONDITION_CHANGED', `manifest base ${manifest.base.sha} is not current at ${base.sha}`); }
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchScript || path.join(__dirname, 'launch.ps1'), '-Manifest', manifestPath, '-WorkRecordId', workRecordId];
  if (dryRun) return { launched: false, dryRun: true, command: [powershell, ...args] };
  try {
    const output = runner(powershell, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000 });
    return { launched: true, output: String(output) };
  } catch (error) {
    throw new WorkStateError('LAUNCH_FAILED', String(error.stderr || error.message || error));
  }
}

function acknowledgeAssignment({ root, workRecordId, expectedRevision, now, actor = 'ic', evidence = 'assignment-started' } = {}) {
  const record = getRecord({ root, id: workRecordId });
  const result = transitionRecord({ root, id: workRecordId, expectedRevision, to: 'implementing', idempotencyKey: `assignment-started:${workRecordId}:${expectedRevision}`, evidence, actor, now });
  if (record.manifestPath) writeSidecar(`${record.manifestPath}.acknowledged.json`, { schemaVersion: 1, workRecordId, acknowledgedAt: now || new Date().toISOString(), actor, evidence });
  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith('--') ? argv[++index] : 'true';
  }
  return args;
}

function readFixture(file, fallback) {
  return file ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, '')) : fallback;
}

function readStateFixture(file, fallback, root, relative) {
  if (file) return readFixture(file, fallback);
  const candidate = path.join(path.resolve(root || path.join(__dirname, '..')), relative);
  return fs.existsSync(candidate) ? readFixture(candidate, fallback) : fallback;
}

function cli(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === 'frontier') {
    const issues = args.fixture ? readFixture(args.fixture, []) : queryGithubIssues({ repo: args.repo, readyLabel: args['ready-label'] || 'ready-for-agent', fetchDetails: true });
    const exclusions = require('./exclusions').activeExclusions({ root: args.root, tenant: args.tenant || 'endzone', now: args.now });
    return selectFrontier({ issues, readyLabel: args['ready-label'] || 'ready-for-agent', active: readStateFixture(args.active, [], args.root, path.join('state', 'work', 'active.json')), skipIssues: readStateFixture(args.skip, {}, args.root, path.join('state', 'skip', `${args.tenant || 'endzone'}.json`)), exclusions, now: args.now });
  }
  if (command === 'assign') {
    const config = readFixture(args['tenant-config'], {});
    const issues = args.fixture ? readFixture(args.fixture, []) : queryGithubIssues({ repo: config.github, readyLabel: config.readyLabel, fetchDetails: true });
    const active = readStateFixture(args.active, [], args.root, path.join('state', 'work', 'active.json'));
    const skipIssues = readStateFixture(args.skip, {}, args.root, path.join('state', 'skip', `${args.tenant}.json`));
    const exclusions = require('./exclusions').activeExclusions({ root: args.root, tenant: args.tenant, now: args.now });
    const frontier = selectFrontier({ issues, readyLabel: config.readyLabel, active, skipIssues, exclusions, now: args.now });
    if (!frontier.eligible.length) throw new WorkStateError('NO_FRONTIER', 'no eligible issue', { excluded: frontier.excluded });
    if (args['base-sha'] && !args.fixture) throw new WorkStateError('BASE_RECONCILIATION_REQUIRED', 'production assignment must resolve base SHA from the fetched remote ref');
    const base = args['base-sha'] ? { remote: args.remote || 'origin', ref: args.ref || config.defaultBranch, sha: args['base-sha'] } : undefined;
    return reserveAssignment({ root: args.root, issue: frontier.eligible[0], tenant: args.tenant, tenantConfig: config, readyLabel: config.readyLabel, active, skipIssues, exclusions, repoPath: args['repo-path'], base, ref: args.ref, parent: args.parent, model: args.model, risk: args.risk, tokenBudget: args['token-budget'] ? Number(args['token-budget']) : undefined, independenceProof: args['independence-proof'] ? JSON.parse(args['independence-proof']) : undefined, now: args.now });
  }
  if (command === 'validate') return validateManifest({ manifest: readFixture(args.manifest), issue: readFixture(args.issue), base: args['base-sha'] ? { sha: args['base-sha'] } : undefined });
  if (command === 'launch') return launchReservedAssignment({ manifestPath: args.manifest, workRecordId: args['work-record-id'], root: args.root, launchScript: args['launch-script'], repoPath: args['repo-path'], githubRepo: args['github-repo'], dryRun: args['dry-run'] === 'true' });
  if (command === 'ack') return acknowledgeAssignment({ root: args.root, workRecordId: args['work-record-id'], expectedRevision: Number(args['expected-revision']), now: args.now, evidence: args.evidence });
  throw new WorkStateError('USAGE', 'commands: frontier, assign, validate, launch, ack');
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message, excluded: error.excluded })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  acknowledgeAssignment,
  buildManifest,
  buildLaunchPlan,
  invalidateManifest,
  independenceProof,
  launchReservedAssignment,
  parseArgs,
  normalizeIssue,
  queryGithubIssues,
  resolveRemoteBase,
  reserveAssignment,
  selectFrontier,
  sha256,
  validateManifest,
};
