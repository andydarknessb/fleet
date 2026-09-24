'use strict';
// #119 (spec #90): the IC's pre-ready mechanical check. The 2026-09-17 audit found
// that about 104 of 296 send-back findings were mechanically checkable: a doc or
// comment still naming an identifier the diff removed or renamed, a closing
// keyword or PR-body defect, lint. Each one cost a review round (send-back rate
// 49 percent; target under 30). This runs them before the PR is readied, so the
// lead's review spends its round on judgment.
//
//   node bin/pr-ready-check.js --repo <worktree> --base <ref> --issue <n> --body <file>
//                              [--tenant <name>] [--head <ref>] [--root <fleet root>]
//
// Exit 0 clean; 1 with one `DEFECT <kind>: <detail>` line per defect; 2 on a
// refused invocation (unknown flag, missing input). It checks:
//   stale-reference  an identifier whose declaration the diff removes (removed, or
//                    renamed to a new name) that a doc (*.md, *.txt) or a comment
//                    in the tree at the head still names.
//   closing-keyword  the body carries exactly one closing keyword (close/fix/
//                    resolve), naming --issue; or none, with a `Refs #<issue>`
//                    line that says the PR does not close it (ic.md step 6). A
//                    closing keyword for any other issue is a defect.
//   criteria-table   a `| Criterion | Evidence |` table with one row per
//                    acceptance-criteria checkbox of the issue (`gh issue view`,
//                    bounded) and no empty evidence cell.
//   lint             the tenant's `lintCommand`, when the tenant file sets one.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const workState = require('./work-state');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const FLAGS = ['repo', 'base', 'head', 'issue', 'body', 'tenant', 'root'];
const USAGE = 'pr-ready-check.js --repo <worktree> --base <ref> --issue <n> --body <file> [--tenant <name>] [--head <ref>] [--root <fleet root>]';
const DOC_EXTENSIONS = Object.freeze(['.md', '.mdx', '.txt']);
const MIN_IDENTIFIER_LENGTH = 4;

class PrReadyCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrReadyCheckError';
    this.code = code;
  }
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60000,
  });
}

// --- stale references ---------------------------------------------------------

// Declarations only: a name a call site merely stops using is not a rename.
const DECLARATION_PATTERNS = Object.freeze([
  /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g, // JS function (PowerShell `function Verb-Noun` below)
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /^\s*function\s+([A-Za-z][\w-]*)/gim, // PowerShell
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/gm, // a method definition line
]);
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor']);

function declaredNames(lines) {
  const names = new Set();
  for (const line of lines) {
    for (const pattern of DECLARATION_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
        const name = match[1];
        if (name && name.length >= MIN_IDENTIFIER_LENGTH && !NOT_NAMES.has(name)) names.add(name);
      }
    }
  }
  return names;
}

function diffSides(diffText) {
  const removed = [];
  const added = [];
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return { removed, added };
}

// A name the diff stops declaring: declared on a removed line and on no added line.
function removedIdentifiers(diffText) {
  const { removed, added } = diffSides(diffText);
  const before = declaredNames(removed);
  const after = declaredNames(added);
  return [...before].filter((name) => !after.has(name)).sort();
}

function escapeRegExp(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The comment part of a code line: after `//`, `#`, or a block-comment opener,
// or the whole line when it continues a block comment (` * ...`).
function commentPart(line) {
  if (/^\s*(\*|\/\*|<!--|#)/.test(line)) return line;
  const slashes = line.indexOf('//');
  if (slashes !== -1) return line.slice(slashes);
  const block = line.indexOf('/*');
  if (block !== -1) return line.slice(block);
  const hash = line.search(/\s#\s/);
  if (hash !== -1) return line.slice(hash);
  return '';
}

function staleReferences({ repo, base, head, diffText, grep }) {
  const names = removedIdentifiers(diffText !== undefined ? diffText : git(repo, ['diff', `${base}...${head}`]));
  const defects = [];
  const search = grep || ((name) => {
    try {
      return git(repo, ['grep', '-n', '-w', '-I', '-F', name, head, '--']);
    } catch (error) {
      if (error.status === 1) return ''; // git grep: no match
      throw error;
    }
  });
  for (const name of names) {
    const word = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}([^\\w$]|$)`);
    const hits = new Map();
    for (const raw of String(search(name) || '').split(/\r?\n/).filter(Boolean)) {
      // `<head>:<path>:<line>:<text>`; the head prefix is absent under a stubbed grep.
      const match = /^(?:[^:]+:)?(.+?):(\d+):(.*)$/.exec(raw.startsWith(`${head}:`) ? raw.slice(head.length + 1) : raw);
      if (!match) continue;
      const [, file, lineNumber, text] = match;
      const isDoc = DOC_EXTENSIONS.includes(path.extname(file).toLowerCase());
      if (!(isDoc ? word.test(text) : word.test(commentPart(text)))) continue;
      if (!hits.has(file)) hits.set(file, []);
      hits.get(file).push(Number(lineNumber));
    }
    for (const [file, lines] of hits) {
      defects.push({ kind: 'stale-reference', detail: `${file}:${lines.join(',')} still names \`${name}\`, which this diff removes or renames; update the ${DOC_EXTENSIONS.includes(path.extname(file).toLowerCase()) ? 'doc' : 'comment'}` });
    }
  }
  return defects;
}

// --- closing keywords ---------------------------------------------------------

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#(\d+))/gi;

function closingDefects(body, issue) {
  const defects = [];
  const keywords = [];
  CLOSING.lastIndex = 0;
  for (let match = CLOSING.exec(body); match; match = CLOSING.exec(body)) keywords.push({ text: match[0].trim(), issue: Number(match[2]) });
  for (const keyword of keywords.filter((entry) => entry.issue !== Number(issue))) {
    defects.push({ kind: 'closing-keyword', detail: `"${keyword.text}" closes #${keyword.issue}, not #${issue}; a PR closes only its own issue` });
  }
  const own = keywords.filter((entry) => entry.issue === Number(issue));
  if (own.length > 1) defects.push({ kind: 'closing-keyword', detail: `the body closes #${issue} ${own.length} times; use exactly one closing keyword` });
  if (!keywords.length) {
    const refs = new RegExp(`^\\s*(?:[-*]\\s*)?Refs?\\s+#${Number(issue)}\\b`, 'im');
    if (!refs.test(body)) {
      defects.push({ kind: 'closing-keyword', detail: `no closing keyword: write "Closes #${issue}" when every criterion is met, or a "Refs #${issue}" line naming what remains (ic.md step 6)` });
    }
  }
  return defects;
}

// --- criteria evidence table --------------------------------------------------

function acceptanceCriteria(issueBody) {
  const lines = String(issueBody || '').split(/\r?\n/);
  const boxes = (from) => from.map((line) => /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/.exec(line)).filter(Boolean).map((match) => match[1]);
  // Prefer the checkboxes under an "Acceptance criteria" heading; else every checkbox.
  const start = lines.findIndex((line) => /^#{1,6}\s*acceptance criteria\b/i.test(line));
  if (start !== -1) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
    const section = boxes(end === -1 ? rest : rest.slice(0, end));
    if (section.length) return section;
  }
  return boxes(lines);
}

function tableRows(body) {
  const lines = String(body || '').split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*\|\s*Criterion\s*\|\s*Evidence\s*\|\s*$/i.test(line));
  if (header === -1) return null;
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!/^\s*\|/.test(line)) break;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    rows.push({ criterion: cells[0] || '', evidence: cells.slice(1).join('|').trim() });
  }
  return rows;
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// A row answers a criterion when its criterion cell names the criterion's number
// (`1`, `#1`, `AC1`) or shares its opening words, either way round.
function rowAnswers(row, criterion, index) {
  const cell = normalize(row.criterion);
  if (!cell) return false;
  if (new RegExp(`^(?:ac\\s*)?${index + 1}$`).test(cell)) return true;
  const wanted = normalize(criterion).split(' ').slice(0, 6).join(' ');
  const given = cell.split(' ').slice(0, 6).join(' ');
  return wanted.startsWith(given) || given.startsWith(wanted) || normalize(criterion).includes(cell);
}

function criteriaDefects(body, issueBody, issue) {
  const criteria = acceptanceCriteria(issueBody);
  const rows = tableRows(body);
  if (rows === null) {
    return [{ kind: 'criteria-table', detail: `no "| Criterion | Evidence |" table in the body; add one row per acceptance criterion of #${issue} (${criteria.length})` }];
  }
  const defects = [];
  criteria.forEach((criterion, index) => {
    if (!rows.some((row) => rowAnswers(row, criterion, index))) {
      defects.push({ kind: 'criteria-table', detail: `no row for criterion ${index + 1}: "${criterion.slice(0, 120)}"` });
    }
  });
  for (const row of rows) {
    if (!row.evidence || /^[-\s]*$/.test(row.evidence)) defects.push({ kind: 'criteria-table', detail: `the row "${row.criterion.slice(0, 80)}" has no evidence` });
  }
  if (rows.length !== criteria.length && !defects.length) {
    defects.push({ kind: 'criteria-table', detail: `the table has ${rows.length} rows for ${criteria.length} acceptance criteria; one row per criterion` });
  }
  return defects;
}

function defaultGh(args) {
  // FLEET_GH names another executable (tests), as in review-policy.js.
  return execFileSync(process.env.FLEET_GH || 'gh', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
  });
}

function issueBodyOf({ issue, tenant, repo, gh }) {
  const args = ['issue', 'view', String(issue), '--json', 'body'];
  if (tenant?.github) args.push('-R', tenant.github);
  try {
    return String(JSON.parse((gh || defaultGh)(args, { cwd: repo })).body || '');
  } catch (error) {
    throw new PrReadyCheckError('ISSUE_UNREADABLE', `could not read issue #${issue}: ${String(error.stderr || error.message || error).trim().slice(0, 300)}`);
  }
}

// --- lint -----------------------------------------------------------------------

function lintDefects({ repo, command, run }) {
  if (!command) return [];
  try {
    (run || ((cmd) => execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 })))(command);
    return [];
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim().split(/\r?\n/).slice(-5).join(' | ');
    return [{ kind: 'lint', detail: `\`${command}\` exited ${error.status ?? 'abnormally'}${output ? `: ${output.slice(0, 400)}` : ''}` }];
  }
}

// --- the check ----------------------------------------------------------------------

function loadTenant(root, name) {
  const file = path.join(path.resolve(root || DEFAULT_ROOT), 'tenants', `${name}.json`);
  if (!fs.existsSync(file)) throw new PrReadyCheckError('USAGE', `unknown tenant '${name}': ${file} does not exist`);
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function checkPullRequest(options = {}) {
  const { repo, base, issue, bodyText } = options;
  const head = options.head || 'HEAD';
  const tenant = options.tenant || null;
  const defects = [
    ...staleReferences({ repo, base, head, diffText: options.diffText, grep: options.grep }),
    ...closingDefects(bodyText, issue),
    ...criteriaDefects(bodyText, options.issueBody !== undefined ? options.issueBody : issueBodyOf({ issue, tenant, repo, gh: options.gh }), issue),
    ...lintDefects({ repo, command: tenant?.lintCommand, run: options.lintRunner }),
  ];
  return { ok: defects.length === 0, defects };
}

function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new PrReadyCheckError('USAGE', `${error.message}\nusage: ${USAGE}`);
    throw error;
  }
  for (const flag of ['repo', 'base', 'issue', 'body']) {
    if (!args[flag] || args[flag] === 'true') throw new PrReadyCheckError('USAGE', `--${flag} is required\nusage: ${USAGE}`);
  }
  if (!Number.isInteger(Number(args.issue)) || Number(args.issue) <= 0) throw new PrReadyCheckError('USAGE', '--issue is an issue number');
  if (!fs.existsSync(args.body)) throw new PrReadyCheckError('USAGE', `--body file not found: ${args.body}`);
  const tenant = args.tenant && args.tenant !== 'true' ? loadTenant(args.root, args.tenant) : null;
  return checkPullRequest({
    repo: args.repo, base: args.base, head: args.head, issue: Number(args.issue),
    bodyText: fs.readFileSync(args.body, 'utf8'), tenant,
  });
}

if (require.main === module) {
  try {
    const result = cli(process.argv.slice(2));
    for (const defect of result.defects) process.stdout.write(`DEFECT ${defect.kind}: ${defect.detail}\n`);
    if (result.ok) process.stdout.write('pr-ready-check: clean\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: error.message })}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 3;
  }
}

module.exports = {
  FLAGS,
  PrReadyCheckError,
  acceptanceCriteria,
  checkPullRequest,
  closingDefects,
  criteriaDefects,
  cli,
  removedIdentifiers,
  staleReferences,
};
