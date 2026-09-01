// One-shot for the Stage-1 changes the implementing session was
// classifier-denied on 2026-09-01 (see amendments-2026-09-01.md, "Pending
// Cory's hand"). Hardened after adversarial QA the same day. Run by hand:
//   node C:\Users\Cory\fleet\.scratch\fleet-cycle-efficiency-2026-08-30\apply-stage1-pending.js
// Idempotent: every step skips itself when already applied. Steps are
// isolated: one failure never blocks the others; exit code is non-zero if
// anything failed or was refused.
//
// The roster step does a read-modify-write against the LIVE fleet's
// state/roster.json, so it refuses to run unless state/PAUSE exists:
//   powershell -File C:\Users\Cory\fleet\bin\pause.ps1 "stage-1 roster diet"
// then re-run this script (already-applied steps skip), then clear PAUSE.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
let failures = 0;

function attempt(label, fn) {
  try { fn(); } catch (err) {
    console.error('FAILED:', label, '-', err.message);
    failures++;
  }
}

// Replace `from` with `to` exactly once, tolerating CRLF or LF targets (and
// preferring whichever ending yields exactly one match).
function sub(file, from, to, label) {
  const p = path.join(root, file);
  const raw = fs.readFileSync(p, 'utf8');
  for (const eol of ['\r\n', '\n']) {
    const t = to.split('\n').join(eol);
    if (raw.includes(t)) { console.log('skip (already applied):', label); return; }
  }
  for (const eol of ['\r\n', '\n']) {
    const f = from.split('\n').join(eol);
    const parts = raw.split(f);
    if (parts.length === 2) {
      fs.writeFileSync(p, parts.join(to.split('\n').join(eol)), 'utf8');
      console.log('applied:', label);
      return;
    }
  }
  throw new Error(label + ': anchor not found exactly once under either line ending');
}

// --- Roster one-time diet (runs first: it is the payoff) -------------------
// Archives retired entries in full to state/archive/roster-retired-full.jsonl,
// then strips their prompt field (~928K of ~1MB; no reader touches a retired
// prompt - recover.ps1 replays active ICs only). retire.ps1 now does this per
// retirement; this covers the pre-existing rows.
attempt('roster diet', () => {
  if (!fs.existsSync(path.join(root, 'state', 'PAUSE'))) {
    throw new Error('refused - set state/PAUSE first (bin/pause.ps1), re-run, then clear it; a live launch/retire could race this write');
  }
  const p = path.join(root, 'state', 'roster.json');
  const raw = fs.readFileSync(p, 'utf8');
  const r = JSON.parse(raw);
  const lines = [];
  for (const e of r.sessions) {
    if (e.status === 'retired' && e.prompt !== undefined) {
      lines.push(JSON.stringify(e));
      delete e.prompt;
    }
  }
  if (!lines.length) { console.log('skip (already applied): roster diet'); return; }
  fs.mkdirSync(path.join(root, 'state', 'archive'), { recursive: true });
  // CRLF line ends to match retire.ps1's appends.
  fs.appendFileSync(path.join(root, 'state', 'archive', 'roster-retired-full.jsonl'), lines.join('\r\n') + '\r\n', 'utf8');
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n', 'utf8');
  console.log('applied: roster diet -', lines.length, 'entries archived+stripped,', raw.length, '->', fs.statSync(p).size, 'bytes');
});

// --- Trim state/NOTICE.md to the still-operative board ---------------------
// Idempotency is exact-content; whatever is being replaced is archived first
// to a timestamped file, every time, so a re-run can never destroy a notice
// written after a partial earlier run.
attempt('NOTICE.md trim', () => {
  const notice = path.join(root, 'state', 'NOTICE.md');
  const trimmed = [
    '2026-09-01, Cory. This board was 33KB of mostly resolved history; the full',
    'ledger is archived at state/archive/NOTICE-2026-09-01.md. Scoped per-role',
    'boards live at state/notices/<all|role>.md and the session-start hook now',
    'injects those; this file exists only for notices meant for every role at',
    'once and should normally be absent.',
    ''
  ].join('\n');
  if (!fs.existsSync(notice)) { console.log('skip (no state/NOTICE.md): NOTICE.md trim'); return; }
  const cur = fs.readFileSync(notice, 'utf8');
  if (cur === trimmed) { console.log('skip (already applied): NOTICE.md trim'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(root, 'state', 'archive', 'NOTICE-replaced-' + stamp + '.md');
  fs.mkdirSync(path.join(root, 'state', 'archive'), { recursive: true });
  fs.writeFileSync(backup, cur, 'utf8');
  fs.writeFileSync(notice, trimmed, 'utf8');
  console.log('applied: NOTICE.md trimmed', cur.length, '->', trimmed.length, 'bytes; previous content archived to', path.relative(root, backup));
});

// --- Text substitutions ----------------------------------------------------

// spec.md status line -> authorized (the session's other spec edits landed;
// without this the file contradicts its own closing paragraph).
attempt('spec.md Status line', () => sub(
  '.scratch/fleet-cycle-efficiency-2026-08-30/spec.md',
  'Status: design approved; runtime implementation not authorized',
  'Status: design approved; runtime implementation AUTHORIZED 2026-09-01 - amendments and sequencing in `amendments-2026-09-01.md`',
  'spec.md Status line'));

// Dispatcher interim tier (Q22): sonnet/low. Applies at the next
// stop + launch.ps1 -FromRoster dispatcher (respawn re-pins old flags).
attempt('dispatcher model', () => sub('agents/dispatcher.md', 'model: opus', 'model: sonnet', 'dispatcher model'));
attempt('dispatcher effort', () => sub('agents/dispatcher.md', 'effort: high', 'effort: low', 'dispatcher effort'));

// session-start hook: inject state/notices/{all,<role>}.md; a legacy
// state/NOTICE.md still prints, flagged as the retired path.
attempt('session-start scoped notices', () => sub(
  'hooks/session-start.ps1',
  ['if (Test-Path "$home_\\state\\NOTICE.md") {',
   '  Write-Output "--- NOTICE from Cory (state/NOTICE.md) ---"',
   '  Get-Content "$home_\\state\\NOTICE.md" -Raw',
   '  Write-Output "--- end notice ---"',
   '}'].join('\n'),
  ['if (Test-Path "$home_\\state\\NOTICE.md") {',
   '  Write-Output "--- NOTICE from Cory (state/NOTICE.md; RETIRED PATH - move this into state/notices/<all|role>.md) ---"',
   '  Get-Content "$home_\\state\\NOTICE.md" -Raw -Encoding UTF8',
   '  Write-Output "--- end notice ---"',
   '}',
   "foreach ($noticeScope in @('all', $role)) {",
   '  if (-not $noticeScope) { continue }',
   '  $noticePath = "$home_\\state\\notices\\$noticeScope.md"',
   '  if (Test-Path $noticePath) {',
   '    Write-Output "--- NOTICE from Cory (state/notices/$noticeScope.md) ---"',
   '    Get-Content $noticePath -Raw -Encoding UTF8',
   '    Write-Output "--- end notice ---"',
   '  }',
   '}'].join('\n'),
  'session-start scoped notices'));

// assignment.js: tolerate the skip file's UTF-8 BOM (state/skip/endzone.json
// starts with one; plain JSON.parse throws on it).
attempt('assignment.js BOM strip', () => sub(
  'bin/assignment.js',
  "  return file ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) : fallback;",
  "  return file ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\\uFEFF/, '')) : fallback;",
  'assignment.js BOM strip'));

if (failures) { console.error(failures + ' step(s) failed or were refused.'); process.exitCode = 1; }
else console.log('done.');
