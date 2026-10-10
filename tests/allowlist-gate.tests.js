'use strict';
// fleet #181: under the allowlist profile a Bash call outside the allow list became a
// permission prompt nobody could answer (rehearsal 2026-09-28, `gh ... | python3 ...`).
// The gate refuses it with a reason instead. The passing cases are commands the same
// rehearsal ran unprompted, so the gate never refuses what the CLI already allows.
// Red-tell: before #181 there is no hooks/allowlist-gate.js, and the python3 pipeline
// below reaches the CLI as a prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./temp-dir');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { decide, run, splitSegments } = require('../hooks/allowlist-gate');

const HOOK = path.join(__dirname, '..', 'hooks', 'allowlist-gate.js');
const PROFILE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'permissions-allowlist.json'), 'utf8'));
const FLEET = 'E:/fleet-scratch';
const REPO = 'E:/Endzone-Empire';
const WORKTREE = 'E:/Endzone-Empire/.claude/worktrees/ic-1730-assignment';
const RULES = PROFILE.allow.map((r) => r.rule.replace(/<fleet>/g, FLEET).replace(/<repo>/g, REPO));
const CONTEXT = { rules: RULES, directories: [WORKTREE, FLEET, REPO], cwd: WORKTREE };

const ALLOWED = [
  // run unprompted in the 2026-09-28 rehearsal (transcript 4d70b4c8)
  'pwd; ls -la server/test/feedSyncRuns.service.test.js server/services/feedSyncRuns.service.js 2>&1 | head -20',
  'node --test server/test/feedSyncRuns.service.test.js 2>&1 | tail -100',
  "git add -A && git commit -m \"$(cat <<'EOF'\ntest(#1562): pin identity guard database arm anchors\n\nBody with a | pipe; and \"quotes\".\nEOF\n)\"",
  "gh issue view 1730 --json body,bodyText | jq -r '.body' | head -60",
  'npm run test:server 2>&1 | tail -100',
  `node ${FLEET}/bin/pr-ready-check.js --repo /e/Endzone-Empire/.claude/worktrees/ic-1730-assignment --base origin/integration --issue 1730 --body /e/Endzone-Empire/.claude/worktrees/ic-1730-assignment/.fleet-pr-body.md --tenant endzone`,
  'gh pr create --base integration --title "test: x" --body-file .fleet-pr-body.md',
  `git -C ${WORKTREE} status`,
  'npm test -- --watchAll=false > test-output.txt',
  // run unprompted on CLI 2.1.296 in the 2026-10-10 rehearsal (job be73d2b8)
  'npm test 2>&1 | grep -E "Test Files|Tests |FAIL" | head -20',
  'git status --short; git branch --show-current',
  "grep -n 'DTSTART:0' tests/ics-expand.test.ts | head -30",
];

// Prompted on CLI 2.1.296 although every command is covered (2026-10-10 rehearsal,
// job be73d2b8, four waits). A `cd <dir> && ...` chain ran unprompted on 2.1.28x.
const PROMPTED_ON_2_1_296 = [
  ['npm run typecheck 2>&1 | tail -5; echo "TYPECHECK_EXIT=$?"; npm run lint 2>&1 | tail -8', /variable expansion/],
  [`cd ${WORKTREE} && ls node_modules/ical.js/dist; gh issue view 139 --json title,body`, /`cd` chained/],
  [`cd ${WORKTREE} && ls -d node_modules 2>&1; node --version`, /`cd` chained/],
  [`cd "${WORKTREE.replace(/\//g, '\\')}" && git diff origin/integration...HEAD`, /`cd` chained/],
  ['echo $HOME', /variable expansion/],
  ['echo "${PWD}"', /variable expansion/],
];

const REFUSED = [
  ['gh issue view 1730 --json body | python3 -c "import sys, json; print(json.load(sys.stdin))" | head -100', /`python3`/],
  ["cat > /tmp/pr_body.md << 'EOF'\n## Summary\nEOF", /redirect to `\/tmp\/pr_body.md`/],
  ['git diff @{upstream}...HEAD 2>/dev/null || git diff integration...HEAD', /redirect to `\/dev\/null`/],
  ['rg identityAnchors server', /`rg`/],
  ['ls -la C:/Users/Cory/Documents', /path outside/],
  ['cd $(git rev-parse --show-toplevel)', /command substitution/],
  ['FOO=1 python3 x.py', /`python3`/],
];

test('the rehearsal\'s unprompted commands pass the gate', () => {
  for (const command of ALLOWED) assert.equal(decide(command, CONTEXT), null, `refused: ${command}`);
});

test('an off-list command, an outside redirect or path, and unquoted substitution are refused with a reason', () => {
  for (const [command, reason] of REFUSED) {
    const got = decide(command, CONTEXT);
    assert.ok(got, `passed: ${command}`);
    assert.match(got, reason, `wrong reason for ${command}: ${got}`);
    assert.match(got, /fleet #181/);
  }
});

test('a variable expansion or a chained cd, which CLI 2.1.296 prompts on, is refused with a reason', () => {
  for (const [command, reason] of PROMPTED_ON_2_1_296) {
    const got = decide(command, CONTEXT);
    assert.ok(got, `passed: ${command}`);
    assert.match(got, reason, `wrong reason for ${command}: ${got}`);
  }
});

test('a lone cd, a $ in single quotes, a regex anchor and $( in double quotes still pass', () => {
  for (const command of [`cd ${WORKTREE}`, "grep -n 'x$HOME' f", 'grep -E "end$" f', 'grep -E "a$|b" f']) {
    assert.equal(decide(command, CONTEXT), null, `refused: ${command}`);
  }
});

test('the python3 refusal names the commands the IC may use instead', () => {
  const got = decide(REFUSED[0][0], CONTEXT);
  for (const name of ['gh', 'git', 'jq', 'node', 'npm']) assert.match(got, new RegExp(`\\b${name}\\b`));
});

test('heredoc bodies and quoted text never split a call into segments', () => {
  const { segments } = splitSegments(ALLOWED[2]);
  assert.deepEqual(segments.map((s) => s.split(' ')[0]), ['git', 'git']);
});

function sandbox(settings) {
  const home = makeTempDir('fleet-allowlist-gate-');
  fs.mkdirSync(path.join(home, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'state', 'flags'), { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(home, 'state', 'sessions', 'ic-1.settings.json'), settings);
  return home;
}

function hook(env, input) {
  const result = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, 'the gate never exits nonzero');
  return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
}

test('the hook denies through the PreToolUse contract only for an allowlist session', () => {
  const home = sandbox(JSON.stringify({ permissions: { allow: RULES, additionalDirectories: [FLEET, REPO] } }));
  try {
    const bash = { tool_name: 'Bash', tool_input: { command: REFUSED[0][0] }, cwd: WORKTREE };
    const denied = hook({ FLEET_HOME: home, FLEET_NAME: 'ic-1', FLEET_PERMISSIONS: 'allowlist' }, bash);
    assert.equal(denied.permissionDecision, 'deny');
    assert.equal(denied.hookEventName, 'PreToolUse');
    assert.match(denied.permissionDecisionReason, /python3/);
    assert.equal(hook({ FLEET_HOME: home, FLEET_NAME: 'ic-1', FLEET_PERMISSIONS: 'allowlist' }, { ...bash, tool_input: { command: ALLOWED[1] } }), null, 'an allowed call passes');
    assert.equal(hook({ FLEET_HOME: home, FLEET_NAME: 'ic-1', FLEET_PERMISSIONS: 'auto' }, bash), null, 'a sonnet (auto) session is never gated');
    assert.equal(hook({ FLEET_HOME: home, FLEET_NAME: 'ic-1', FLEET_PERMISSIONS: 'allowlist' }, { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem' } }).permissionDecision, 'deny', 'PowerShell is refused under the profile');
    fs.writeFileSync(path.join(home, 'state', 'flags', 'allowlist-gate-off'), '');
    assert.equal(hook({ FLEET_HOME: home, FLEET_NAME: 'ic-1', FLEET_PERMISSIONS: 'allowlist' }, bash), null, 'the rollback flag disables the gate');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the hook fails open on unreadable input or settings', () => {
  const home = sandbox(undefined);
  try {
    const env = { FLEET_HOME: home, FLEET_NAME: 'ic-1', FLEET_PERMISSIONS: 'allowlist' };
    assert.equal(hook(env, 'not json'), null);
    assert.equal(hook(env, { tool_name: 'Bash', tool_input: { command: 'python3 x' }, cwd: WORKTREE }), null, 'a missing settings file passes rather than blocks');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  assert.equal(run({}, '{}'), null, 'a non-fleet session is untouched');
});
