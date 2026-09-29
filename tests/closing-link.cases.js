'use strict';
// #202: the shared closing-link parser cases. Both callers of bin/closing-link.js run
// this one table: tests/pr-watch.tests.js (the watcher's verdict and what a tick does)
// and tests/pr-ready-check.tests.js (the IC's pre-ready check), so a body can never be
// clean at one door and a defect at the other. Not a suite itself (test-all runs
// only *.tests.js and *.tests.ps1).
//
// expect: 'closing' (a closing keyword names the issue), 'refs' (a `Refs #n` line with
// an explanation), or 'none'. Every case is for issue 42 in owner/repo.
const ISSUE = 42;
const REPO = 'owner/repo';

const CASES = Object.freeze([
  { name: 'Closes #n', body: 'Closes #42', expect: 'closing' },
  { name: 'keyword with a colon', body: 'Closes: #42', expect: 'closing' },
  { name: 'keyword is case-insensitive', body: 'FIXED #42', expect: 'closing' },
  { name: 'the full issue URL', body: 'fixes https://github.com/owner/repo/issues/42', expect: 'closing' },
  { name: 'owner/repo#n for this repository', body: 'resolves owner/repo#42', expect: 'closing' },
  { name: 'CRLF body', body: 'Summary\r\n\r\nCloses #42\r\n', expect: 'closing' },
  { name: 'a closing keyword beats an explained Refs', body: 'Refs #42 because the rest waits on Cory\nCloses #42', expect: 'closing' },

  { name: 'Refs with the explanation on the line', body: 'Refs #42 (deliberate; AC1 ruling open)', expect: 'refs' },
  { name: 'Refs with a colon then words', body: 'Refs #42: the migration stays with Cory', expect: 'refs' },
  { name: 'Refs with the explanation on the next line', body: 'Refs #42\nLeaves the migration for Cory.', expect: 'refs' },
  { name: 'Refs with the explanation after blank lines and CRLF', body: 'Refs #42\r\n\r\n   \r\nWhat remains is the AC1 ruling.', expect: 'refs' },
  { name: 'Refs as a list item', body: '- Refs #42 keeps the ruling open', expect: 'refs' },
  { name: 'Refs, a blank line, then a prose sentence', body: 'Refs #42\n\nThe migration stays with Cory until the ruling lands.', expect: 'refs' },
  { name: 'Refs is case-insensitive and may be singular or plural', body: 'ref #42 the follow-up lands in the next ticket', expect: 'refs' },

  { name: 'an empty body', body: '', expect: 'none' },
  { name: 'a body with no linkage', body: 'Just a body.', expect: 'none' },
  { name: 'a bare Refs line explains nothing', body: 'Refs #42', expect: 'none' },
  { name: 'a bare Refs line then only blank lines', body: 'Refs #42\n\n   \n', expect: 'none' },
  { name: 'a keyword inside a code span', body: 'the bug `Closes #42` mentions', expect: 'none' },
  { name: 'a keyword inside a code fence', body: '```\nCloses #42\n```', expect: 'none' },
  { name: 'a Refs line inside a code span', body: '`Refs #42 for the rest of the work`', expect: 'none' },
  { name: 'a line break between the keyword and the reference', body: 'is now fixed\n#42 tracks the rest', expect: 'none' },
  { name: 'a line break right after the keyword', body: 'Closes\n#42', expect: 'none' },
  { name: 'a longer issue number', body: 'Closes #421', expect: 'none' },
  { name: 'a Refs line for a longer issue number', body: 'Refs #421 and the words that explain it', expect: 'none' },
  { name: 'a keyword for another issue', body: 'Closes #43', expect: 'none' },
  { name: 'a keyword into another repository', body: 'Closes other/repo#42', expect: 'none' },
  { name: 'a Refs line for another issue', body: 'Refs #43 with an explanation of what remains', expect: 'none' },
  // The next line explains only when it is prose: not a footer, heading, table row, rule,
  // linkage line or bare URL (fleet Ruling on #202: a bare Refs must not be rescued by
  // whatever the body happens to say next).
  { name: 'a bare Refs line then the Claude Code footer', body: 'Refs #42\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)', expect: 'none' },
  { name: 'a bare Refs line then a footer without the robot', body: 'Refs #42\nGenerated with [Claude Code](https://claude.com/claude-code)', expect: 'none' },
  { name: 'a bare Refs line then a heading', body: 'Refs #42\n## What changed', expect: 'none' },
  { name: 'a bare Refs line then a Refs line for another issue', body: 'Refs #42\nRefs #43 and the words that explain that one', expect: 'none' },
  { name: 'a bare Refs line then a closing line for another issue', body: 'Refs #42\nCloses #43 once the rest lands', expect: 'none' },
  { name: 'a bare Refs line then the criteria table', body: 'Refs #42\n| Criterion | Evidence |\n|---|---|', expect: 'none' },
  { name: 'a bare Refs line then a horizontal rule', body: 'Refs #42\n---', expect: 'none' },
  { name: 'a bare Refs line then a session URL', body: 'Refs #42\nhttps://claude.ai/code/session_x', expect: 'none' },
  { name: 'a bare Refs line then one word', body: 'Refs #42\nLater.', expect: 'none' },
]);

module.exports = { CASES, ISSUE, REPO };
