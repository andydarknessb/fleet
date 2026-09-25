'use strict';
// Spec fleet #92 (audit workstream 4): a ticket's `## Premises` section, read as
// data. The shape is fixed in CONTEXT.md under **Premise**: one line per premise,
// `<path>: <claim> @<sha>` (sha is 7 to 40 hex), or the single word `none`.
//
//   parsePremises  the section from an issue BODY (never a comment): null when
//                  absent, [] for `none`, else [{ path, claim, sha, line }]. A
//                  section that exists and does not parse throws PREMISES_MALFORMED
//                  quoting the offending line, so a half-written premise never
//                  reaches an IC.
//   checkPremises  (#144) which premises name a path that changed between their
//                  sha and the fetched base, read from the tenant checkout with
//                  `git diff --name-only` (never --stat, which truncates paths).

const { execFileSync } = require('node:child_process');

class PremisesError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PremisesError';
    this.code = code;
    Object.assign(this, details);
  }
}

const SECTION_HEADING = /^\s{0,3}##\s+premises\s*#*\s*$/i;
const SECTION_END = /^\s{0,3}#{1,2}\s/;
const NONE_LINE = /^(?:[-*]\s+)?none\.?$/i;
// An optional list bullet, an optionally fenced path with no whitespace (a line
// suffix such as `path.js:53` stays part of it), `: `, the claim, ` @<sha>`.
const PREMISE_LINE = /^(?:[-*]\s+)?`?([^\s`][^\s`]*?)`?:\s+(\S.*?)\s+@([0-9a-z]+)$/i;

function sectionLines(body) {
  const lines = String(body || '').split(/\r?\n/);
  const starts = lines.map((line, index) => (SECTION_HEADING.test(line) ? index : -1)).filter((index) => index >= 0);
  if (!starts.length) return null;
  if (starts.length > 1) throw new PremisesError('PREMISES_MALFORMED', 'the body has more than one `## Premises` section', { line: '## Premises' });
  const section = [];
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    if (SECTION_END.test(lines[index])) break;
    if (lines[index].trim()) section.push(lines[index].trim());
  }
  return section;
}

function parsePremises(body) {
  const lines = sectionLines(body);
  if (lines === null) return null;
  if (!lines.length) throw new PremisesError('PREMISES_MALFORMED', 'the `## Premises` section is empty; write `none` when the ticket has no code premise', { line: '' });
  if (lines.some((line) => NONE_LINE.test(line))) {
    if (lines.length === 1) return [];
    throw new PremisesError('PREMISES_MALFORMED', `\`none\` must stand alone in the \`## Premises\` section, but it has ${lines.length} lines: "${lines.find((line) => !NONE_LINE.test(line))}"`, { line: lines.find((line) => !NONE_LINE.test(line)) });
  }
  return lines.map((line) => {
    const match = PREMISE_LINE.exec(line);
    if (!match) throw new PremisesError('PREMISES_MALFORMED', `premise line matches neither \`<path>: <claim> @<sha>\` nor \`none\`: "${line}"`, { line });
    const sha = match[3].toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new PremisesError('PREMISES_MALFORMED', `premise sha must be 7 to 40 hex characters (a full sha or a 7+ prefix): "${line}"`, { line });
    return { path: match[1].replaceAll('\\', '/'), claim: match[2], sha, line };
  });
}

// The same parse, never throwing: what an issue carries through the frontier,
// where one malformed ticket must not stop the others from being read.
function readPremises(body) {
  try { return { premises: parsePremises(body), premisesError: null }; } catch (error) {
    if (!(error instanceof PremisesError)) throw error;
    return { premises: null, premisesError: { code: error.code, message: error.message, line: error.line } };
  }
}

module.exports = { PremisesError, parsePremises, readPremises };
