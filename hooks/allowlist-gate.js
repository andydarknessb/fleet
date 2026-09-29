'use strict';
// PreToolUse hook for the allowlist permission profile (ADR 0016, fleet #181).
// Under acceptEdits, a Bash call that the session's allow list does not cover
// becomes a permission prompt, and a background IC has nobody there to answer
// it. The 2026-09-28 rehearsal blocked on `gh ... | python3 -c ... | head`.
// This gate refuses such a call with a reason instead, so the IC can rewrite it.
//
// The CLI does not prompt on a pipe or a chain as such: `node --test x 2>&1 | tail`
// and `git add -A && git commit ...` ran unprompted in that rehearsal. So the rule
// is per command. Every command in the call must be covered by a `Bash(...)` rule
// of the session's resolved allow list or be a listed read-only command. A redirect
// may only go to `&1`/`&2` or to a file inside the working directory or an
// additional directory, and a drive or /tmp path argument must be inside one.
//
// Only sessions launched with FLEET_PERMISSIONS=allowlist are gated. Sub-agent
// calls are gated too, because their prompts block the same way. A PowerShell call
// is refused outright: the profile allows none. Output contract, as in
// research-gate.ps1: a deny is JSON on stdout with permissionDecision "deny", and
// anything else is silence and exit 0. It never exits nonzero, since a broken gate
// must not block work. Rollback: state/flags/allowlist-gate-off.

const fs = require('node:fs');
const path = require('node:path');

// Read-only commands the gate passes beside the allow list's own commands.
const READ_ONLY = Object.freeze(['cat', 'cut', 'diff', 'echo', 'grep', 'head', 'jq', 'ls', 'pwd', 'sort', 'tail', 'tr', 'true', 'uniq', 'wc']);

// Drop every heredoc body: the delimiter line and the body are data, not commands.
function stripHeredocs(command) {
  const lines = String(command).split(/\r?\n/);
  const out = [];
  let delimiter = null;
  let dashed = false;
  for (const line of lines) {
    if (delimiter !== null) {
      const probe = dashed ? line.replace(/^\t+/, '') : line;
      if (probe.trim() === delimiter) delimiter = null;
      continue;
    }
    out.push(line);
    const match = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (match) { dashed = match[1] === '-'; delimiter = match[3]; }
  }
  return out.join('\n');
}

// Split into segments on unquoted ; && || | |& & and newlines. Quoted text, and a
// $( ... ) inside double quotes, is opaque. An unquoted $( or backtick is reported.
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let substitutionDepth = 0;
  let unquotedSubstitution = false;
  const text = stripHeredocs(command);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote === "'") { current += ch; if (ch === "'") quote = null; continue; }
    if (quote === '"') {
      current += ch;
      if (ch === '\\') { current += next || ''; i += 1; continue; }
      if (ch === '$' && next === '(') { substitutionDepth += 1; current += next; i += 1; continue; }
      if (ch === ')' && substitutionDepth > 0) { substitutionDepth -= 1; continue; }
      if (ch === '"' && substitutionDepth === 0) quote = null;
      continue;
    }
    if (ch === '\\') { current += ch + (next || ''); i += 1; continue; }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if ((ch === '$' && next === '(') || ch === '`') unquotedSubstitution = true;
    const two = ch + (next || '');
    if (two === '&&' || two === '||' || two === '|&') { segments.push(current); current = ''; i += 1; continue; }
    if (ch === ';' || ch === '\n' || ch === '|') { segments.push(current); current = ''; continue; }
    if (ch === '&' && next !== '>' && text[i - 1] !== '>' && text[i - 1] !== '<') { segments.push(current); current = ''; continue; }
    current += ch;
  }
  segments.push(current);
  return { segments: segments.map((s) => s.trim().replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '').trim()).filter(Boolean), unquotedSubstitution };
}

// Quote-aware word split; returns the unquoted words.
function words(segment) {
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // In double quotes bash treats a backslash as an escape only before $ ` " \ and a
      // newline, so a Windows path such as "E:\repo" keeps its backslashes.
      if (quote === '"' && ch === '\\' && '$`"\\\n'.includes(segment[i + 1] || 'x')) { current += segment[i + 1]; i += 1; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) { out.push(current); current = ''; started = false; } continue; }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

function normalizePath(p) {
  let s = String(p).replace(/\\/g, '/');
  const gitBashDrive = /^\/([a-zA-Z])(\/|$)/.exec(s);
  if (gitBashDrive) s = `${gitBashDrive[1]}:/${s.slice(3)}`;
  return s.replace(/\/+$/, '').toLowerCase();
}

function isAbsoluteish(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\/[a-zA-Z](\/|$)/.test(p) || /^\/(tmp|dev|var|usr|etc|home)(\/|$)/.test(p);
}

function insideAllowed(target, context) {
  const resolved = isAbsoluteish(target) ? normalizePath(target) : normalizePath(path.posix.join(normalizePath(context.cwd || '.'), String(target).replace(/\\/g, '/')));
  return (context.directories || []).map(normalizePath).some((dir) => dir && (resolved === dir || resolved.startsWith(`${dir}/`)));
}

// `Bash(x:*)` covers `x` and `x ...`; `Bash(x)` covers exactly `x`.
function coveredByRule(commandText, rules) {
  return rules.some((rule) => {
    const match = /^Bash\((.*)\)$/.exec(rule);
    if (!match) return false;
    const body = match[1];
    if (body.endsWith(':*')) {
      const prefix = body.slice(0, -2);
      return commandText === prefix || commandText.startsWith(`${prefix} `);
    }
    return commandText === body;
  });
}

function allowedNames(rules) {
  const names = new Set(READ_ONLY);
  for (const rule of rules) {
    const match = /^Bash\(([^\s:)]+)/.exec(rule);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

// Returns null when the call may run, or the reason it is refused.
function decide(command, context) {
  const rules = context.rules || [];
  const listed = `Allowed commands: ${allowedNames(rules).join(', ')}.`;
  const tail = 'One Bash call may chain allowed commands with |, &&, ; and 2>&1. Rewrite the call, or use the Read tool to read a file (ADR 0016, fleet #181; rollback flag state/flags/allowlist-gate-off).';
  const { segments, unquotedSubstitution } = splitSegments(command);
  if (unquotedSubstitution) return `the allowlist profile refuses command substitution outside quotes ($(...) or backticks): run the inner command as its own call. ${tail}`;
  for (const segment of segments) {
    const parts = words(segment);
    const commandWords = [];
    for (let i = 0; i < parts.length; i += 1) {
      const word = parts[i];
      if (commandWords.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      if (/^<<<?-?/.test(word)) { if (/^<<<?-?$/.test(word)) i += 1; continue; }
      const redirect = /^(\d*|&)(>>?|<)(&?)(.*)$/.exec(word);
      if (redirect) {
        let target = redirect[4];
        if (redirect[3] === '&' && /^[0-9-]$/.test(target)) continue;
        if (!target) { target = parts[i + 1] || ''; i += 1; }
        if (/^&[0-9-]$/.test(target)) continue;
        if (!insideAllowed(target, context)) return `the allowlist profile refuses a redirect to \`${target}\`, outside the working directory and the additional directories; drop it (2>&1 is fine) or write the file inside your worktree. ${tail}`;
        continue;
      }
      commandWords.push(word);
    }
    if (!commandWords.length) continue;
    for (const word of commandWords.slice(1)) {
      if (isAbsoluteish(word) && !insideAllowed(word, context)) return `the allowlist profile refuses \`${word}\`, a path outside the working directory and the additional directories. ${tail}`;
    }
    const text = commandWords.join(' ');
    if (READ_ONLY.includes(commandWords[0]) || coveredByRule(text, rules)) continue;
    return `the allowlist profile does not allow \`${commandWords[0]}\` (in: ${segment.slice(0, 120)}). ${listed} ${tail}`;
  }
  return null;
}

function sessionContext(env, input) {
  const home = env.FLEET_HOME;
  const settingsFile = path.join(home, 'state', 'sessions', `${env.FLEET_NAME}.settings.json`);
  let text = fs.readFileSync(settingsFile, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const permissions = JSON.parse(text).permissions || {};
  const cwd = input.cwd || process.cwd();
  return { rules: permissions.allow || [], directories: [cwd, ...(permissions.additionalDirectories || [])], cwd };
}

function run(env, stdinText) {
  if (env.FLEET_PERMISSIONS !== 'allowlist' || !env.FLEET_HOME || !env.FLEET_NAME) return null;
  if (fs.existsSync(path.join(env.FLEET_HOME, 'state', 'flags', 'allowlist-gate-off'))) return null;
  const input = JSON.parse(stdinText);
  if (input.tool_name === 'PowerShell') return 'the allowlist profile allows no PowerShell calls: use Bash with an allowed command (ADR 0016, fleet #181; rollback flag state/flags/allowlist-gate-off).';
  if (input.tool_name !== 'Bash') return null;
  return decide(String(input.tool_input?.command || ''), sessionContext(env, input));
}

if (require.main === module) {
  let stdinText = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdinText += chunk; });
  process.stdin.on('end', () => {
    try {
      const reason = run(process.env, stdinText);
      if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    } catch (error) {
      // fail open: an unreadable input or settings file never blocks work
    }
    process.exitCode = 0;
  });
}

module.exports = { READ_ONLY, decide, run, splitSegments, stripHeredocs, words };
