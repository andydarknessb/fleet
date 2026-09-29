'use strict';
// #202 (spec #192): the one closing-link parser. bin/pr-watch.js (the watcher's
// closing-linkage rule) and bin/pr-ready-check.js (the IC's pre-ready check) both read
// a PR body through this module, so a body that passes the check cannot escalate at
// the watcher. It decides among three cases for one issue:
//
//   closing  a closing keyword (close/fix/resolve) names the issue: the merge closes it.
//   refs     no closing keyword, but a `Refs #n` line with an explanation (words after it
//            on the line, or the next non-empty line): a deliberate partial PR
//            (ic.md step 6). The shape pr-ready-check accepted before this module.
//   none     neither.
//
// Code fences and code spans are stripped first, and a keyword must share its line with
// its reference, in both callers (the tenant's close-merged-issues.js #330 grammar).

const KINDS = Object.freeze(['closing', 'refs', 'none']);

function stripCode(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

// keyword, optional colon, same-line whitespace, then #n, owner/repo#n, or the full
// issue URL. Groups: 1 = URL slug, 2 = URL number, 3 = owner/repo prefix, 4 = number.
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[^\S\n]+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|(?:([\w.-]+\/[\w.-]+))?#(\d+))\b/gi;

// Every closing keyword in the body, with the issue it names and whether that issue
// is in `repo` (the tenant's owner/repo slug). A bare #n is this repository's.
function closingKeywords(body, repo = null) {
  const found = [];
  const text = stripCode(body);
  CLOSING.lastIndex = 0;
  for (let match = CLOSING.exec(text); match; match = CLOSING.exec(text)) {
    const slug = match[1] || match[3] || '';
    found.push({
      text: match[0].trim(),
      issue: Number(match[2] || match[4]),
      sameRepo: !slug || Boolean(repo && slug.toLowerCase() === String(repo).toLowerCase()),
    });
  }
  return found;
}

// `Refs #n` (or `Ref`, as a list item too) followed by the explanation: words after it
// on the line, or a non-empty next line. A bare `Refs #n` explains nothing.
function explainedRefs(body, issue) {
  const n = Number(issue);
  const lines = stripCode(body).split(/\r?\n/);
  const at = lines.findIndex((line) => new RegExp(`^\\s*(?:[-*]\\s*)?Refs?\\s+#${n}\\b`, 'i').test(line));
  if (at === -1) return false;
  const rest = lines[at].replace(new RegExp(`^.*?#${n}\\b`), '');
  return /[A-Za-z]{3,}.*\s.*[A-Za-z]{3,}/.test(rest) || (lines.slice(at + 1).find((line) => line.trim()) || '').trim().length > 0;
}

// The verdict for `issue`: 'closing', 'refs' or 'none'. `repo` is the tenant's
// owner/repo slug; without it only same-repository forms count as this repository.
function classify(body, issue, repo = null) {
  const n = Number(issue);
  if (closingKeywords(body, repo).some((keyword) => keyword.sameRepo && keyword.issue === n)) return 'closing';
  return explainedRefs(body, n) ? 'refs' : 'none';
}

module.exports = { KINDS, classify, closingKeywords, explainedRefs, stripCode };
