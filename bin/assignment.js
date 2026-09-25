'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  RESERVATION_FIELDS,
  WorkStateError,
  getRecord,
  hasReservationEvidence,
  isForeignRecord,
  parseArgs,
  proofFor,
  proofMatches,
  releaseRecord,
  reservationBaseline,
  reservationConflicts: workReservationConflicts,
  reserveRecord,
  transitionRecord,
} = require('./work-state');
const { PREMISES_HEADING, PremisesError, checkPremises, fencedLines, readPremises } = require('./premises');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeLabels(labels) {
  return (labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean).map(String);
}

function normalizeComments(comments) {
  const values = Array.isArray(comments) ? comments : comments?.nodes || [];
  return values.map((comment) => ({
    id: String(comment.id || ''),
    createdAt: String(comment.createdAt || ''),
    body: String(comment.body || ''),
  })).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function criteriaHash(issue) {
  const parts = [String(issue.body || '')];
  for (const comment of normalizeComments(issue.comments)) parts.push(comment.id, comment.createdAt, comment.body);
  return sha256(parts.join('\u0000'));
}

// fleet#32: a path is reserved for the polarity of the sentence that names it. A
// criterion of the form "lists no file under `server/db/migrations/`" forbids the
// path; reserving it collided the ticket with the directory's real owner. Three
// rules, applied per sentence (a line, split again at `. `, `; `, `! ` and `? `):
//   1. An allowlist sentence ("lists exactly A and B", "touches only A") is the
//      whole reservation: nothing outside it is reserved.
//   2. A sentence carrying a negation reserves nothing. A path also named in a
//      positive sentence is still reserved from that sentence.
//   3. Paths under `docs/` are citations unless the sentence carries an edit verb;
//      criteria cite ADRs far more often than they change them.
//   4. A line-numbered path introduced by a copula ("`LOCK` is `server/modules/
//      advisoryLock.js:53`") in a sentence with no edit verb is a premise citation.
//   5. (fleet#52) A path introduced by a citation cue ("like `X`", "similar to",
//      "modelled on", "as in", "see", "per", "cf.", "e.g.", "such as") is a
//      template to imitate or a reference to read, never a write target. The
//      cue must stand immediately before the path (an article or "existing"
//      may sit between), so the written path earlier in the same sentence
//      ("Add `A` modelled on `B`") is still reserved.
// Sections headed "Out of scope" (or "Non-goals") count as negated throughout. A
// path one sentence only cites is still reserved from any sentence that edits it.
const CITATION_BEFORE_PATH = /\b(?:like|unlike|similar to|modell?ed (?:on|after)|patterned (?:on|after)|as in|see|per|cf\.?|e\.g\.?|such as|mirror(?:s|ing)|akin to|in the (?:shape|style|manner) of|the (?:same )?shape (?:of|as))\s+(?:(?:the|an?|existing|current|its|our)\s+)*`?$/i;
const COPULA_BEFORE_PATH = /\b(?:is|are|was|were)\b(?:\s+(?:now|still|already))?(?:\s+`[^`]{1,40}`)?(?:\s+(?:at|in|on))?\s+`?$/i;
const NEGATION = /(?:\b(?:no|not|never|nothing|none|nor|neither|without|unchanged|untouched|unedited|forbidden|prohibited|cannot|can't|won't|don't|doesn't|isn't|aren't|mustn't|shouldn't)\b|\bcarve-outs?\b|\bout of scope\b|\bstays? (?:outside|as is|untouched)\b|\bdoes not\b|\bdo not\b|\bmust not\b|\bshould not\b|\bwill not\b)/i;
const ALLOWLIST = /\b(?:lists?|touch(?:es)?|edits?|changes?|modif(?:y|ies)|writes?)\s+(?:exactly|only)\b|\bexactly\s+(?:these|the following)\s+files?\b|\bonly\s+(?:these|the following)\s+files?\b/i;
const EDIT_VERB = /\b(?:add|adds|added|amend|amends|amended|append|appends|appended|write|writes|written|edit|edits|edited|update|updates|updated|change|changes|changed|create|creates|created|rewrite|rewrites|rewritten|extend|extends|extended|revise|revises|revised|own|owns|touch|touches|move|moves|delete|deletes|remove|removes|rename|renames|new)\b/i;
const NEGATED_HEADING = /^\s{0,3}#{1,6}\s+.*\b(?:out of scope|non-goals?|not in scope|do not touch|must not touch)\b|^\s*\*\*(?:out of scope|non-goals?)\.?\*\*/i;

// Spec fleet #92: a `## Premises` section cites the code an issue depends on; its
// paths are read, never written, so the section contributes no sentence at all.

function criteriaSentences(text) {
  const sentences = [];
  let negatedSection = false;
  let premisesSection = false;
  for (const { line, fenced } of fencedLines(text)) {
    if (!fenced && /^\s{0,3}#{1,2}\s/.test(line)) premisesSection = PREMISES_HEADING.test(line);
    if (premisesSection) continue;
    if (/^\s{0,3}#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*/.test(line)) negatedSection = NEGATED_HEADING.test(line);
    // An abbreviation's period ends no sentence: "cf. `path`" and "e.g. `path`"
    // keep their cue beside the path they cite (fleet#52).
    for (const sentence of line.split(/(?<=[.;!?])(?<!\b(?:cf|e\.g|i\.e|vs|etc)\.)\s+(?=\S)/i)) {
      if (sentence.trim()) sentences.push({ text: sentence, negated: negatedSection || NEGATION.test(sentence), allowlist: ALLOWLIST.test(sentence), edit: EDIT_VERB.test(sentence) });
    }
  }
  return sentences;
}

// fleet#54: a repo-root file is a path in its own right. The prefixed recognizer
// below needs a directory name and a separator, so `CONTEXT.md` in endzone
// #1294's allowlist Scope line matched nothing and the derived set was three of
// four: non-empty, conflict-free, `independent: true`, and short. A bare token
// counts when it is a KNOWN root name (the repo's documents, package manifests,
// tool configs, deploy files and dotfiles) and is fenced in backticks or sits
// in an allowlist sentence. A bare basename that is not a known root name
// (`assignment.js`, which lives in `bin/`) is never guessed to be at the root:
// in an allowlist sentence it is reported as unrecognized and the assignment
// is refused; elsewhere it is prose. It never matches inside a longer path.
const ROOT_FILE = /(?<![A-Za-z0-9_/.\-])(?:\.(?:env|eslintrc|prettierrc|babelrc|npmrc|nvmrc|gitignore|gitattributes|editorconfig|node-version|dockerignore)(?:\.[A-Za-z0-9_-]+)*|(?:README|CONTEXT|CLAUDE|AGENTS|CHANGELOG|CONTRIBUTING|LICENSE|SECURITY|CODEOWNERS)(?:\.md)?|package(?:-lock)?\.json|netlify\.toml|render\.ya?ml|vercel\.json|knexfile\.[cm]?js|(?:jest|vite|vitest|babel|eslint|prettier|tailwind|postcss|playwright|next|nuxt|svelte|webpack|rollup)\.config\.[cm]?[jt]s|(?:tsconfig|jsconfig)(?:\.[A-Za-z0-9_-]+)?\.json|Dockerfile|docker-compose\.ya?ml|Procfile|index\.html)(?![A-Za-z0-9_/.\-])/g;
const ALLOWLIST_STOPWORDS = new Set(['the', 'this', 'that', 'its', 'own', 'file', 'files', 'itself', 'nothing', 'none', 'these', 'those', 'following', 'plus', 'test', 'tests']);

// The items an allowlist sentence enumerates after its cue ("lists exactly A and
// B, C"): single tokens, stripped of fences and punctuation. Anything with
// whitespace ("the `players` table") is not an item the recognizer was asked
// to place.
function allowlistItems(sentenceText) {
  const cue = ALLOWLIST.exec(sentenceText);
  if (!cue) return [];
  const rest = sentenceText.slice(cue.index + cue[0].length).replace(/^\s*(?:these|the following)?\s*files?\b/i, '').replace(/^[\s:]+/, '');
  return rest.split(/\s*(?:,|;|\band\b|\bor\b)\s*/i)
    .map((item) => item.trim().replace(/^[`'"(]+|[`'".,;:!?)]+$/g, ''))
    .filter((item) => item.length > 1 && !/\s/.test(item) && !ALLOWLIST_STOPWORDS.has(item.toLowerCase()));
}

function deriveReservations(issue) {
  const reservations = Object.fromEntries(RESERVATION_FIELDS.map((field) => [field, []]));
  const unrecognized = [];
  const text = [issue.body, ...normalizeComments(issue.comments).map((comment) => comment.body)].filter(Boolean).join('\n');
  const pathPattern = /(?:\.github|src|server|docs|bin|hooks|tests|config|tenants|state|scripts|entities|features|widgets|pages|shared)[\\/][A-Za-z0-9_.\-/*{}\[\]\\]+/gi;
  const sentences = criteriaSentences(text);
  const allowlists = sentences.filter((sentence) => sentence.allowlist && !sentence.negated);
  const sources = allowlists.length ? allowlists : sentences.filter((sentence) => !sentence.negated);
  for (const sentence of sources) {
    const seen = new Set();
    const matches = [...sentence.text.matchAll(pathPattern)];
    for (const match of sentence.text.matchAll(ROOT_FILE)) {
      const fenced = sentence.text[match.index - 1] === '`' && sentence.text[match.index + match[0].length] === '`';
      if (fenced || sentence.allowlist) matches.push(match);
    }
    for (const match of matches) {
      const rawValue = match[0].replaceAll('\\', '/').replace(/[.,;:!?]+$/, '');
      seen.add(rawValue.toLowerCase());
      const value = /^(?:entities|features|widgets|pages|shared)\//i.test(rawValue) ? `src/${rawValue}` : rawValue;
      if (/^state\/reviews\//i.test(value)) continue;
      if (/^docs\//i.test(value) && !sentence.edit && !sentence.allowlist) continue;
      const before = sentence.text.slice(Math.max(0, match.index - 64), match.index);
      const after = sentence.text.slice(match.index + match[0].length, match.index + match[0].length + 24);
      // fleet#52: "like `path`" cites a template; the path is not this ticket's.
      if (CITATION_BEFORE_PATH.test(before)) continue;
      const lineCited = /^:\d/.test(after);
      const copula = COPULA_BEFORE_PATH.test(before) || /^:\d+(?:-\d+)?`?\s+(?:is|are|was|were)\b/i.test(after);
      if (lineCited && copula && !sentence.edit && !sentence.allowlist) continue;
      const migration = value.match(/^server\/db\/migrations\/(\d+)/i);
      if (migration) reservations.migrationPrefixes.push(migration[1]);
      else if (/(?:^|\/)(?:tests?\/|[^/]*\.tests?\.)/i.test(value)) reservations.testResources.push(value);
      else reservations.components.push(value);
    }
    // fleet#54: an allowlist sentence states its own cardinality. An item it
    // lists that neither recognizer saw is a short derivation, and a short set
    // satisfies every other guard (non-empty, no conflict, independent), so it
    // is reported here and refused at assign rather than reserved as if whole.
    if (sentence.allowlist) {
      for (const item of allowlistItems(sentence.text)) {
        if (!seen.has(item.replaceAll('\\', '/').toLowerCase())) unrecognized.push(item);
      }
    }
  }
  const tablePatterns = [/(?:the\s+)?`([A-Za-z_][A-Za-z0-9_]*)`\s+table\b/gi, /\btable\s+`([A-Za-z_][A-Za-z0-9_]*)`/gi];
  for (const pattern of tablePatterns) {
    for (const sentence of sources) {
      for (const match of sentence.text.matchAll(pattern)) reservations.schemaAreas.push(match[1]);
    }
  }
  return {
    reservations: Object.fromEntries(RESERVATION_FIELDS.map((field) => [field, [...new Set(reservations[field])].sort()])),
    unrecognized: [...new Set(unrecognized)],
  };
}

function normalizeReservations(issue) {
  const explicit = issue.reservations !== undefined || RESERVATION_FIELDS.some((field) => (issue[field] || []).length);
  if (!explicit) {
    const derived = deriveReservations(issue);
    return { reservations: derived.reservations, unrecognizedPaths: derived.unrecognized };
  }
  const source = issue.reservations || issue;
  return { reservations: Object.fromEntries(RESERVATION_FIELDS.map((field) => [field, [...new Set((source[field] || []).map(String))].sort()])), unrecognizedPaths: [] };
}

function normalizeIssue(issue) {
  const labels = normalizeLabels(issue.labels);
  const dependencies = issue.dependencies || issue.blockedBy || [];
  const comments = normalizeComments(issue.comments);
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
    criteriaHash: issue.criteriaHash || criteriaHash({ ...issue, comments }),
    comments,
    commentsTruncated: Boolean(issue.commentsTruncated || issue.comments?.pageInfo?.hasNextPage),
    ...normalizeReservations({ ...issue, comments }),
    // Spec fleet #92: from the body only; a malformed section is carried, not thrown,
    // so the frontier still reads every other ticket and assign refuses this one.
    ...readPremises(issue.body),
    createdAt: issue.createdAt || '9999-12-31T23:59:59.999Z',
  };
}

// Given a tenant, another tenant's records drop out (work-state isForeignRecord).
function activeRecords(records, tenant) {
  const all = Array.isArray(records) ? records : Object.values(records?.records || records || {});
  return all.filter((record) => !isForeignRecord(record, tenant));
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
    .map((conflict) => ({
      code: 'reservation-conflict',
      // A cross-field hit (fleet #60) names the reservation it collided with,
      // since the field alone would read as a same-field clash.
      detail: conflict.reservedField === conflict.field
        ? `${conflict.field}:${conflict.value}`
        : `${conflict.field}:${conflict.value} (${conflict.reservedField}:${conflict.reservedValue} reserved)`,
      owner: conflict.recordId,
      ownerIssue: conflict.issue,
    }));
}

// The proof over a mix of active Work records and frontier issues is the Work
// record proof (work-state's proofFor) over the pair each carries: an issue
// number and its reservations. One builder, one conflict shape (fleet #60).
function independenceProof(issues) {
  return proofFor(issues.map((issue) => ({ issue: issue.number ?? issue.issue, reservations: issue.reservations })));
}

function hydrateActiveReservations(active, issues = [], tenant) {
  const byIssue = new Map(issues.map(normalizeIssue).map((issue) => [issue.number, issue]));
  return activeRecords(active, tenant).map((record) => {
    if (hasReservationEvidence(record.reservations)) return record;
    const issue = byIssue.get(Number(record.issue));
    if (!issue || issue.commentsTruncated || !hasReservationEvidence(issue.reservations)) return record;
    const matchesPin = record.github?.criteriaHash
      ? record.github.criteriaHash === issue.criteriaHash
      : record.github?.bodyHash && record.github.bodyHash === issue.bodyHash;
    return matchesPin ? { ...record, reservations: issue.reservations } : record;
  });
}

function buildLaunchPlan({ frontier, active = [], issues = [], maxIcs = 3, tenant } = {}) {
  const candidates = (frontier?.eligible || []).map(normalizeIssue);
  const activeAssignments = hydrateActiveReservations(active, issues, tenant).filter((record) => record.manifestPath && record.state !== 'retired');
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

// `fleetIdentity` is the GitHub login the fleet itself acts as. An assignee equal to it is
// not evidence that someone else owns the issue: in a single-account tenant the fleet and
// the human are the same login, nothing in either repo ever removes an assignee, and
// excluding on it made an issue permanently invisible to the frontier (reviewed 2026-09-06,
// ADR 0006). A genuinely foreign assignee still excludes. Leave it unset for a tenant whose
// issues are really owned by several accounts.
function selectFrontier({ issues, readyLabel, skipIssues = {}, exclusions = [], active = [], fleetIdentity, tenant, now } = {}) {
  const foreign = (assignee) => !fleetIdentity || String(assignee).toLowerCase() !== String(fleetIdentity).toLowerCase();
  if (!Array.isArray(issues)) throw new WorkStateError('INVALID_GITHUB_FIXTURE', 'issues must be an array');
  const normalized = issues.map(normalizeIssue);
  const scoped = activeRecords(active, tenant);
  const activeByIssue = new Map(scoped.filter((record) => record.state !== 'retired').map((record) => [Number(record.issue), record]));
  const eligible = [];
  const excluded = [];
  for (const issue of normalized) {
    const reasons = [];
    if (issue.state !== 'OPEN') reasons.push({ code: 'not-open', detail: `GitHub state is ${issue.state}` });
    if (readyLabel && !issue.labels.includes(readyLabel)) reasons.push({ code: 'not-ready', detail: `missing ${readyLabel}` });
    const foreignAssignees = issue.assignees.filter(foreign);
    if (foreignAssignees.length) reasons.push({ code: 'assigned', detail: foreignAssignees.join(', ') });
    if (issue.unresolvedDependencies.length) reasons.push({ code: 'dependency-blocked', detail: issue.unresolvedDependencies.map((dependency) => dependency.number || dependency.id || dependency).join(', ') });
    if (issue.isSpecParent) reasons.push({ code: 'spec-parent', detail: 'sub-issues remain or issue is marked as a spec parent' });
    if (issue.commentsTruncated) reasons.push({ code: 'issue-comments-truncated', detail: 'the complete issue comment thread could not be pinned' });
    if (issue.labels.includes('ready-for-human')) reasons.push({ code: 'ready-for-human', detail: 'ready-for-human label is present' });
    reasons.push(...localExclusionReasons(issue, skipIssues, exclusions));
    if (activeByIssue.has(issue.number)) reasons.push({ code: 'reserved', detail: `active Work record ${activeByIssue.get(issue.number).id}` });
    reasons.push(...reservationConflicts(issue, scoped));
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
      const query = 'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number,title,url,body,createdAt,state,labels(first:20){nodes{name}},assignees(first:20){nodes{login}},blockedBy(first:100){nodes{number,state} pageInfo{hasNextPage}},subIssues(first:100){nodes{number,state} pageInfo{hasNextPage}},comments(first:100){nodes{id,body,createdAt} pageInfo{hasNextPage}}} pageInfo{hasNextPage,endCursor}}}}';
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
      return nodes.map((issue) => normalizeIssue({
        ...issue,
        labels: issue.labels?.nodes || issue.labels,
        assignees: issue.assignees?.nodes || issue.assignees,
        dependencies: [...(issue.blockedBy?.nodes || []), ...(issue.blockedBy?.pageInfo?.hasNextPage ? [{ number: 'additional dependencies', state: 'OPEN' }] : [])],
        subIssuesSummary: { total: (issue.subIssues?.nodes?.length || 0) + (issue.subIssues?.pageInfo?.hasNextPage ? 1 : 0), completed: (issue.subIssues?.nodes || []).filter((subIssue) => String(subIssue.state).toUpperCase() === 'CLOSED').length, truncated: Boolean(issue.subIssues?.pageInfo?.hasNextPage) },
        comments: issue.comments?.nodes || [],
        commentsTruncated: Boolean(issue.comments?.pageInfo?.hasNextPage),
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

// Amendment 14 (2026-09-09): an IC is haiku or sonnet, never opus. The only opus worker in
// an IC's world is the risk reviewer it hosts on a trigger. Enforced where the manifest is
// made, because the manifest is what the launch door starts.
// Fleet #28 (2026-09-11): the Claude Code CLI keeps a per-model auto-mode list and
// claude-haiku-4-5 is not on it (2.1.267 and 2.1.268 verified; an explicit
// --permission-mode auto is downgraded too). A haiku --bg session therefore runs in
// permission-mode default and blocks on its first out-of-cwd Read with nobody to
// approve it. Spec #94 (#162, ADR 0016) goes around the CLI list instead of waiting
// for it: the permission mode is a launch-door profile chosen per model. Sonnet runs
// the auto profile; haiku runs only the allowlist profile (acceptEdits plus the
// checked-in config/permissions-allowlist.json), and haiku under auto is still the
// fleet #28 refusal. The manifest pins the profile beside the model.
const IC_MODELS = Object.freeze(['sonnet', 'haiku']);
const IC_PERMISSION_PROFILES = Object.freeze({ sonnet: Object.freeze(['auto']), haiku: Object.freeze(['allowlist']) });
const PERMISSION_PROFILES = Object.freeze(['auto', 'allowlist']);
const HAIKU_REFUSAL = "the installed Claude Code CLI has no auto mode for claude-haiku-4-5 (fleet #28): a haiku --bg session runs in permission-mode default and blocks on its first out-of-cwd Read; launch it on sonnet";

function icModel(model) {
  const value = String(model === undefined || model === null || model === '' ? 'sonnet' : model).toLowerCase();
  if (!IC_MODELS.includes(value)) throw new WorkStateError('INVALID_IC_MODEL', `an IC runs as sonnet or haiku, not '${model}' (amendment 14; haiku only under the allowlist profile, fleet #28; the risk reviewer is the only opus worker)`);
  return value;
}

// An absent profile is the model's first (sonnet: auto). Haiku under auto, asked for
// or defaulted, is the fleet #28 refusal: the CLI would downgrade it to default mode.
function icPermissions(model, permissions) {
  const given = permissions === undefined || permissions === null || permissions === '' ? null : String(permissions).toLowerCase();
  if (given !== null && !PERMISSION_PROFILES.includes(given)) throw new WorkStateError('INVALID_PERMISSION_PROFILE', `unknown permission profile '${permissions}'; known: ${PERMISSION_PROFILES.join(', ')} (ADR 0016)`);
  if (model === 'haiku' && given !== 'allowlist') throw new WorkStateError('INVALID_IC_MODEL', HAIKU_REFUSAL);
  const allowed = IC_PERMISSION_PROFILES[model];
  const value = given === null ? allowed[0] : given;
  if (!allowed.includes(value)) throw new WorkStateError('INVALID_PERMISSION_PROFILE', `a ${model} IC runs the ${allowed.join(' or ')} profile, not '${value}' (ADR 0016: the allowlist profile is the haiku profile)`);
  return value;
}

function buildManifest({ issue, tenant, tenantConfig = {}, readyLabel, parent = 'pl-endzone', model = 'sonnet', permissions, risk = 'standard', tokenBudget = 25000, base, contextHeadings = [], adrPaths = [], testPlan = [], ciGates = [], independenceProof, premiseCheck = null, now, workRecordId, workRecordRevision = 1 } = {}) {
  model = icModel(model);
  permissions = icPermissions(model, permissions);
  const normalized = normalizeIssue(issue);
  if (normalized.commentsTruncated) throw new WorkStateError('INCOMPLETE_ISSUE_CRITERIA', `issue #${normalized.number} has more comments than the assignment query can pin`);
  const createdAt = now || new Date().toISOString();
  const retrySuffix = workRecordRevision > 1 ? `-r${workRecordRevision}` : '';
  const id = `assignment-${tenant}-issue-${normalized.number}-${normalized.criteriaHash.slice(0, 12)}${retrySuffix}`;
  const branch = `${tenantConfig.branchPrefix || 'fleet/'}${normalized.number}-${slug(normalized.title)}`;
  return {
    schemaVersion: 1,
    id,
    status: 'pending-ack',
    createdAt,
    workRecordId: workRecordId || `${tenant}:issue-${normalized.number}`,
    workRecordRevision,
    readyLabel: readyLabel || tenantConfig.readyLabel || null,
    issue: { number: normalized.number, url: normalized.url || null, bodyHash: normalized.bodyHash, criteriaHash: normalized.criteriaHash, commentCount: normalized.comments.length },
    base: { remote: base.remote, ref: base.ref, sha: base.sha },
    branch,
    tenant,
    parent,
    model,
    permissions,
    risk,
    tokenBudget,
    contextHeadings: [...contextHeadings],
    adrPaths: [...adrPaths],
    testPlan: [...testPlan],
    ciGates: [...ciGates],
    reservations: normalized.reservations,
    independenceProof: independenceProof || null,
    // Spec fleet #92: null while the issue has no section (the backfill window), [] for `none`.
    premises: pinnedPremises(normalized.premises),
    premiseCheck,
  };
}

function pinnedPremises(premises) {
  return Array.isArray(premises) ? premises.map(({ path: premisePath, claim, sha }) => ({ path: premisePath, claim, sha })) : null;
}

// fleet#33: lead-supplied reservations replace the derived set. The shape is the
// Work record's own (components, migrationPrefixes, schemaAreas, testResources);
// an unknown field is a usage error, not a silently dropped one.
function explicitReservations(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WorkStateError('USAGE', `--reservations must be a JSON object with the fields ${RESERVATION_FIELDS.join(', ')}`);
  const unknown = Object.keys(parsed).filter((field) => !RESERVATION_FIELDS.includes(field));
  if (unknown.length) throw new WorkStateError('USAGE', `--reservations has unknown field(s) ${unknown.join(', ')}; accepted: ${RESERVATION_FIELDS.join(', ')}`);
  return Object.fromEntries(RESERVATION_FIELDS.map((field) => [field, [...new Set((parsed[field] || []).map(String))].sort()]));
}

// Spec fleet #92 (#144): the lead re-reads only the premises whose paths moved.
// A changed path refuses PREMISE_PATH_CHANGED and writes nothing; the lead
// re-reads those lines and re-runs with --premises-rechecked <head> (the base it
// re-checked at, which must be this manifest's base), or escalates a premise that
// is now false with reason stale-premise. No section (the backfill window) is
// not checked; `none` checks nothing and pins an empty check.
function assignPremiseCheck({ issue, repoPath, base, premisesRechecked, runner }) {
  if (!Array.isArray(issue.premises)) return null;
  let check;
  try { check = checkPremises({ premises: issue.premises, repoPath, baseSha: base.sha, ...(runner ? { runner } : {}) }); } catch (error) {
    if (error instanceof PremisesError) throw new WorkStateError(error.code, `issue #${issue.number}: ${error.message}`, { issue: issue.number, sha: error.sha });
    throw error;
  }
  if (premisesRechecked !== undefined && premisesRechecked !== null) {
    const attested = String(premisesRechecked).trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(attested) || !String(base.sha).toLowerCase().startsWith(attested)) {
      throw new WorkStateError('PREMISE_ATTESTATION_STALE', `--premises-rechecked ${premisesRechecked} is not this assignment's base ${base.sha}; re-read the changed premises at ${base.sha} and attest that head`, { issue: issue.number, base: base.sha, attested: premisesRechecked });
    }
    return { ...check, attestation: { head: base.sha, rechecked: check.changed.map((entry) => entry.line) } };
  }
  if (check.changed.length) {
    const list = check.changed.map((entry) => `"${entry.line}" (${entry.changedFiles.join(', ')} changed since ${entry.sha})`).join('; ');
    throw new WorkStateError('PREMISE_PATH_CHANGED', `issue #${issue.number}: ${check.changed.length} premise path(s) changed between the premise sha and the base ${base.sha}: ${list}. Re-read each at ${base.sha}; if it still holds, re-run assign with --premises-rechecked ${base.sha}; if it is now false, escalate the Work record with --reason stale-premise --premise "<line>"`, { issue: issue.number, base: base.sha, changed: check.changed });
  }
  return check;
}

function reserveAssignment({ root, issue, issues = [issue], tenant, tenantConfig = {}, active = [], skipIssues = {}, exclusions = [], readyLabel, repoPath, base, remote = 'origin', ref, parent, model, permissions, risk, tokenBudget, contextHeadings, adrPaths, testPlan, ciGates, independenceProof: proof, reservations, premisesRechecked, now, actor = 'assignment-planner', runner } = {}) {
  const proofRecords = hydrateActiveReservations(active, issues, tenant);
  const explicit = explicitReservations(reservations);
  const frontier = selectFrontier({ issues: [explicit ? { ...issue, reservations: explicit } : issue], readyLabel, active: proofRecords, skipIssues, exclusions, fleetIdentity: tenantConfig.fleetIdentity, tenant, now });
  if (!frontier.eligible.length) throw new WorkStateError('NO_FRONTIER', 'issue is not eligible for assignment', { excluded: frontier.excluded });
  const normalized = frontier.eligible[0];
  // Spec fleet #92: a section that exists and does not parse is refused before
  // anything is written, quoting the line, so a half-written premise never
  // reaches an IC. An absent section is still assignable during the backfill.
  if (normalized.premisesError) {
    throw new WorkStateError(normalized.premisesError.code, `issue #${normalized.number}: ${normalized.premisesError.message}`, { issue: normalized.number, line: normalized.premisesError.line });
  }
  // fleet#33: an assignment with no reservation at all is a derivation failure far
  // more often than a file-less ticket, and it is invisible until the next third
  // assignment fails closed on `missingReservations`. Refuse it here, where the
  // lead can answer with the surface the criteria describe.
  if (!hasReservationEvidence(normalized.reservations)) {
    throw new WorkStateError('EMPTY_RESERVATIONS', `issue #${normalized.number} derives no reservation from its criteria${explicit ? ' and the explicit set is empty' : ''}; pass --reservations '{"components":[...],"testResources":[...]}' naming the seams the ticket edits`, { issue: normalized.number, criteriaHash: normalized.criteriaHash, reservations: normalized.reservations });
  }
  // fleet#54: a derived set that is short of what an allowlist criterion lists
  // is refused the same way an empty one is; a partial reservation fails open
  // everywhere else (the proof reads `independent: true` over a missing file).
  if (!explicit && (normalized.unrecognizedPaths || []).length) {
    throw new WorkStateError('PARTIAL_RESERVATIONS', `issue #${normalized.number} lists ${normalized.unrecognizedPaths.map((item) => `\`${item}\``).join(', ')} in an allowlist criterion that the reservation builder could not place, so the derived set is short; pass --reservations '{"components":[...],"testResources":[...]}' naming the whole set`, { issue: normalized.number, criteriaHash: normalized.criteriaHash, reservations: normalized.reservations, unrecognizedPaths: normalized.unrecognizedPaths });
  }
  const resolvedBase = base || resolveRemoteBase({ repoPath, remote, ref: ref || tenantConfig.defaultBranch || 'integration', runner });
  const premiseCheck = assignPremiseCheck({ issue: normalized, repoPath, base: resolvedBase, premisesRechecked, runner });
  const workRecordId = `${tenant}:issue-${normalized.number}`;
  const baseline = reservationBaseline({ root, id: workRecordId });
  const activeAssignments = proofRecords.filter((record) => record.manifestPath && record.state !== 'retired');
  const expectedProof = independenceProof([...activeAssignments, normalized]);
  if (activeAssignments.length >= 3 || (activeAssignments.length >= 2 && !proofMatches(expectedProof, proof))) throw new WorkStateError('THIRD_ASSIGNMENT_REQUIRES_PROOF', 'a third assignment requires a verified independent machine-readable proof');
  const manifest = buildManifest({ issue: normalized, tenant, tenantConfig, readyLabel, parent, model, permissions, risk, tokenBudget, base: resolvedBase, contextHeadings, adrPaths, testPlan, ciGates, independenceProof: proof, premiseCheck, now, workRecordId, workRecordRevision: baseline.revision });
  const manifestPath = writeManifest(root, manifest);
  try {
    const reserved = reserveRecord({
      root, id: workRecordId, tenant, issue: normalized.number, manifestPath, assignment: { manifestId: manifest.id, branch: manifest.branch, baseSha: manifest.base.sha, independenceProof: proof || null, premises: manifest.premises, premiseCheck: manifest.premiseCheck },
      github: { issueNumber: normalized.number, issueUrl: normalized.url, bodyHash: normalized.bodyHash, criteriaHash: normalized.criteriaHash, commentCount: normalized.comments.length }, reservations: normalized.reservations, proofRecords: activeAssignments, independenceProof: proof,
      evidence: { github: `gh issue view ${normalized.number}`, manifest: path.relative(path.resolve(root), manifestPath) },
      idempotencyKey: `assignment-reserved:${manifest.id}`, actor, now,
    });
    if (reserved.revision !== manifest.workRecordRevision) throw new WorkStateError('RESERVATION_BASELINE_CHANGED', `manifest expected Work record revision ${manifest.workRecordRevision}, reserved ${reserved.revision}`);
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
  if (current.criteriaHash !== manifest.issue.criteriaHash) mismatches.push({ field: 'issue.criteriaHash', expected: manifest.issue.criteriaHash, actual: current.criteriaHash });
  if (current.commentsTruncated) mismatches.push({ field: 'issue.commentsComplete', expected: true, actual: false });
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

// fleet#4: adopt work-state's parseArgs flag schema (fleet#2's fix), one binary
// per change, so a typo'd flag is refused instead of falling into a bucket
// nothing reads. This binary went last (ruling 1) because it shares the
// confusable names: `--repo` is the GitHub owner/name, `--repo-path` the local
// checkout, `--tenant-config` the tenant file; review-policy.js classify spells
// the first two `--repo` and `--tenant`. Declared per command: each list is
// every `args.xxx` / `args['xxx']` that command's handler actually consumes.
// The old local parser accepted anything, so `assign --base bbb` reserved from
// the remote as if no base had been given and `launch --repo owner/name`
// launched with no GitHub repo at all.
const FRONTIER_FLAGS = ['root', 'tenant', 'tenant-config', 'ready-label', 'fixture', 'repo', 'active', 'skip', 'now'];
const FLAGS = Object.freeze({
  frontier: FRONTIER_FLAGS,
  proof: [...FRONTIER_FLAGS, 'issue', 'reservations'],
  assign: [
    ...FRONTIER_FLAGS, 'issue', 'base-sha', 'remote', 'ref', 'repo-path', 'parent', 'model', 'permissions', 'risk', 'token-budget',
    'test-plan', 'ci-gates', 'context-headings', 'adr-paths', 'independence-proof', 'reservations', 'premises-rechecked',
  ],
  validate: ['manifest', 'issue', 'base-sha'],
  launch: ['root', 'manifest', 'work-record-id', 'launch-script', 'repo-path', 'github-repo', 'dry-run'],
  ack: ['root', 'work-record-id', 'expected-revision', 'now', 'evidence'],
});

function usage(message) {
  return new WorkStateError('USAGE', `${message}\ncommands: ${Object.keys(FLAGS).join(', ')}`);
}

function readFixture(file, fallback) {
  return file ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, '')) : fallback;
}

function readStateFixture(file, fallback, root, relative) {
  if (file) return readFixture(file, fallback);
  const candidate = path.join(path.resolve(root || path.join(__dirname, '..')), relative);
  return fs.existsSync(candidate) ? readFixture(candidate, fallback) : fallback;
}

// The tenant file is the source of truth for readyLabel, repo and fleetIdentity; every door
// that computes a frontier reads it so the rules cannot drift between them.
function readTenantConfig(root, tenant, file) {
  const config = file ? readFixture(file, {}) : readStateFixture(null, {}, root, path.join('tenants', `${tenant || 'endzone'}.json`));
  // #154 (ADR 0015): a tenant whose fleetIdentity is its ownerLogin is refused,
  // or the foreign-assignee rule below would silently mean nothing again.
  try { require('./identity').assertDistinctIdentity(config, tenant); } catch (error) {
    throw new WorkStateError(error.code, error.message);
  }
  return config;
}

function cli(argv) {
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(FLAGS, command)) {
    throw usage(`unknown command '${command}'`);
  }
  // parseArgs throws work-state's error class, which is also this binary's, so
  // a USAGE built there and one built here are the same to every caller.
  const args = parseArgs(rest, FLAGS[command]);
  if ((command === 'assign' || command === 'proof') && args.reservations === 'true') throw new WorkStateError('USAGE', '--reservations needs a JSON object value (fleet#33)');
  if (command === 'frontier') {
    const config = readTenantConfig(args.root, args.tenant, args['tenant-config']);
    const tenant = args.tenant || 'endzone';
    const readyLabel = args['ready-label'] || config.readyLabel || 'ready-for-agent';
    const issues = args.fixture ? readFixture(args.fixture, []) : queryGithubIssues({ repo: args.repo || config.github, readyLabel, fetchDetails: true });
    const exclusions = require('./exclusions').activeExclusions({ root: args.root, tenant, now: args.now });
    return selectFrontier({ issues, readyLabel, active: readStateFixture(args.active, [], args.root, path.join('state', 'work', 'active.json')), skipIssues: readStateFixture(args.skip, {}, args.root, path.join('state', 'skip', `${tenant}.json`)), exclusions, fleetIdentity: config.fleetIdentity, tenant, now: args.now });
  }
  if (command === 'assign' || command === 'proof') {
    // One loader for both doors: the tenant file names the repo and ready label, the
    // fleet state supplies active records, the skip file, and the exclusion ledger.
    const config = readTenantConfig(args.root, args.tenant, args['tenant-config']);
    const tenant = args.tenant || config.name || 'endzone';
    const readyLabel = config.readyLabel || args['ready-label'] || 'ready-for-agent';
    const issues = args.fixture ? readFixture(args.fixture, []) : queryGithubIssues({ repo: config.github || args.repo, readyLabel, fetchDetails: true });
    const active = readStateFixture(args.active, [], args.root, path.join('state', 'work', 'active.json'));
    const reservationRecords = hydrateActiveReservations(active, issues, tenant);
    const skipIssues = readStateFixture(args.skip, {}, args.root, path.join('state', 'skip', `${tenant}.json`));
    const exclusions = require('./exclusions').activeExclusions({ root: args.root, tenant, now: args.now });
    const frontier = selectFrontier({ issues, readyLabel, active: reservationRecords, skipIssues, exclusions, fleetIdentity: config.fleetIdentity, tenant, now: args.now });
    if (!frontier.eligible.length) throw new WorkStateError('NO_FRONTIER', 'no eligible issue', { excluded: frontier.excluded });
    if (command === 'proof') {
      // The machine-readable independence proof a third assignment must carry: the
      // frontier head checked against every active assignment's reservations. It is
      // computed here and passed back verbatim to `assign --independence-proof`; a
      // proof that reports conflicts is refused by reserve, never trimmed.
      const activeAssignments = reservationRecords.filter((record) => record.manifestPath && record.state !== 'retired');
      const found = args.issue ? frontier.eligible.find((issue) => issue.number === Number(args.issue)) : frontier.eligible[0];
      if (!found) throw new WorkStateError('NO_FRONTIER', `issue #${args.issue} is not on the frontier`, { excluded: frontier.excluded });
      // fleet#62: the same explicit set `assign --reservations` applies, applied
      // the same way (the candidate re-normalized over it), so the printed proof
      // IS the expectedProof reserve checks. Without it a prose-seam candidate
      // could only ever print `missingReservations: [<itself>]`.
      const explicit = explicitReservations(args.reservations);
      const head = explicit ? normalizeIssue({ ...found, reservations: explicit }) : found;
      return { issue: head.number, activeAssignments: activeAssignments.map((record) => record.id), reservations: head.reservations, proof: independenceProof([...activeAssignments, head]) };
    }
    if (args['base-sha'] && !args.fixture) throw new WorkStateError('BASE_RECONCILIATION_REQUIRED', 'production assignment must resolve base SHA from the fetched remote ref');
    const base = args['base-sha'] ? { remote: args.remote || 'origin', ref: args.ref || config.defaultBranch, sha: args['base-sha'] } : undefined;
    // 02/03 cutover: the manifest's test plan and CI gates come from the tenant file
    // (checks and ciGates), so the IC's pointers match what the lead's review requires;
    // context headings and ADR paths are the lead's per-ticket call. A bare flag with no
    // value is a mistake, not an empty list.
    const given = (key) => args[key] !== undefined && args[key] !== 'true';
    const list = (key) => (given(key) ? String(args[key]).split(',').map((item) => item.trim()).filter(Boolean) : []);
    for (const key of ['test-plan', 'ci-gates', 'context-headings', 'adr-paths']) { if (args[key] === 'true') throw new WorkStateError('USAGE', `--${key} needs a comma-separated value`); }
    const testPlan = given('test-plan') ? list('test-plan') : Object.entries(config.checks || {}).map(([name, command]) => `${name}: ${command}`);
    const ciGates = given('ci-gates') ? list('ci-gates') : [...(config.ciGates || [])];
    // Spec #94: --issue reserves that frontier issue (a rehearsal's chosen ticket), not the head.
    const chosen = args.issue ? frontier.eligible.find((entry) => entry.number === Number(args.issue)) : frontier.eligible[0];
    if (!chosen) throw new WorkStateError('NO_FRONTIER', `issue #${args.issue} is not on the frontier`, { excluded: frontier.excluded });
    return reserveAssignment({ root: args.root, issue: chosen, issues, tenant, tenantConfig: config, readyLabel, active, skipIssues, exclusions, repoPath: args['repo-path'], base, ref: args.ref, parent: args.parent, model: args.model, permissions: args.permissions, risk: args.risk, tokenBudget: args['token-budget'] ? Number(args['token-budget']) : undefined, contextHeadings: list('context-headings'), adrPaths: list('adr-paths'), testPlan, ciGates, independenceProof: args['independence-proof'] ? JSON.parse(args['independence-proof']) : undefined, reservations: args.reservations, premisesRechecked: args['premises-rechecked'], now: args.now });
  }
  if (command === 'validate') return validateManifest({ manifest: readFixture(args.manifest), issue: readFixture(args.issue), base: args['base-sha'] ? { sha: args['base-sha'] } : undefined });
  if (command === 'launch') return launchReservedAssignment({ manifestPath: args.manifest, workRecordId: args['work-record-id'], root: args.root, launchScript: args['launch-script'], repoPath: args['repo-path'], githubRepo: args['github-repo'], dryRun: args['dry-run'] === 'true' });
  if (command === 'ack') return acknowledgeAssignment({ root: args.root, workRecordId: args['work-record-id'], expectedRevision: Number(args['expected-revision']), now: args.now, evidence: args.evidence });
  throw new WorkStateError('USAGE', 'commands: frontier, assign, proof, validate, launch, ack');
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message, excluded: error.excluded })}\n`);
    // A refused invocation exits 2 so a caller reading only the status cannot
    // take it for a failed reservation, let alone for an answer (fleet#2's
    // rule); every other error keeps exit 1 (NO_FRONTIER, RESERVATION_CONFLICT,
    // THIRD_ASSIGNMENT_REQUIRES_PROOF, MANIFEST_PRECONDITION_CHANGED...).
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = {
  FLAGS,
  IC_MODELS,
  IC_PERMISSION_PROFILES,
  acknowledgeAssignment,
  buildManifest,
  buildLaunchPlan,
  cli,
  criteriaHash,
  criteriaSentences,
  deriveReservations,
  hydrateActiveReservations,
  invalidateManifest,
  independenceProof,
  launchReservedAssignment,
  parseArgs,
  normalizeIssue,
  readTenantConfig,
  queryGithubIssues,
  resolveRemoteBase,
  explicitReservations,
  reserveAssignment,
  selectFrontier,
  sha256,
  validateManifest,
};
