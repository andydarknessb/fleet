# PreToolUse hook (ADR 0011 decision 6, fleet #39): the Principal's boundary is a hook,
# not prose. Two rule sets:
#
#   1. role principal (main session AND its sub-agents; a worker it spawns is still it):
#      - Edit/Write/NotebookEdit/MultiEdit only under: the tenant repo's docs/adr/ and
#        CONTEXT.md (also inside .claude/worktrees/<x>/ for a docs PR), the fleet's
#        docs/adr/ and CONTEXT.md, its own status file state/status/pe-<tenant>.md,
#        state/triage/ (bin/triage.js is the writer; the door's state denials still
#        apply), the user's ~/.claude (memory, plans) and the temp directory.
#      - Bash/PowerShell: no bare test suite (npm test / npx jest / node --test with no
#        file; test:server:all / :sweep ever), no sync-* script, no gh issue close,
#        no gh pr merge, no wontfix/duplicate label, no git push to a branch outside
#        docs/. One named test file passes.
#      - No Supabase or Netlify-writing MCP tool.
#   2. every fleet role: no comment whose body begins "Approved" or "Re-propose" on any
#      issue. The machine's gh login is the tenant owner's login (fleetIdentity ==
#      ownerLogin), so the owner-login gate in bin/triage.js cannot tell Cory's Approved
#      from one a session posts; this rule is what makes an Approval, and (fleet#55) a
#      re-proposal ask, Cory's alone.
#
# Rollback: state/flags/principal-guard-off. Output contract: a deny is JSON on stdout
# with permissionDecision "deny"; anything else is silence + exit 0. Never exit nonzero.
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
$inp = $null
try { $inp = "$raw" | ConvertFrom-Json } catch {}
if (-not $inp) { exit 0 }
$home_ = $env:FLEET_HOME; $role = $env:FLEET_ROLE; $tenant = $env:FLEET_TENANT
if (-not $home_ -or -not $role) { exit 0 }                                   # not a fleet session
if (Test-Path "$home_\state\flags\principal-guard-off") { exit 0 }

$tool = "$($inp.tool_name)"
$reason = $null
$cite = "(ADR 0011; rollback flag state/flags/principal-guard-off)"

function Normalize-Path {
  param([string]$Path, [string]$Cwd)
  if (-not $Path) { return '' }
  $p = $Path
  if ($p -match '^~[\\/]') { $p = $env:USERPROFILE + $p.Substring(1) }
  if (-not [IO.Path]::IsPathRooted($p) -and $Cwd) { $p = Join-Path $Cwd $p }
  try { $p = [IO.Path]::GetFullPath($p) } catch {}
  return ($p -replace '\\', '/').ToLowerInvariant().TrimEnd('/')
}
function Escape-Rx { param([string]$Text) [regex]::Escape($Text) }

# --- rule set 2: no session posts an Approval (every fleet role, sub-agents included) ---
if ($tool -in @('Bash', 'PowerShell')) {
  $cmd = "$($inp.tool_input.command)"
  $flat = $cmd -replace '\s+', ' '
  if ($flat -match '(^|[\s;&|(])gh\s+(issue|pr)\s+comment\b' -or $flat -match '(^|[\s;&|(])gh\s+api\b.*\bcomments\b') {
    $bodies = @()
    foreach ($m in [regex]::Matches($cmd, '(?:-b|--body|(?:-f|-F|--field|--raw-field)\s+body=)\s*(?:"((?:[^"\\]|\\.)*)"|''([^'']*)''|(\S+))')) {
      $bodies += @($m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value) | Where-Object { $_ } | Select-Object -First 1
    }
    foreach ($m in [regex]::Matches($cmd, '(?:--body-file|-F\s+body=@)\s*(?:"([^"]+)"|''([^'']+)''|(\S+))')) {
      $file = @($m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value) | Where-Object { $_ } | Select-Object -First 1
      $filePath = Normalize-Path $file "$($inp.cwd)"
      if ($file -eq '-') { $bodies += 'stdin (unreadable; treated as an approval attempt)' ; $bodies += 'Approved' }
      elseif ($filePath -and (Test-Path -LiteralPath $filePath)) { try { $bodies += ((Get-Content -LiteralPath $filePath -Raw) -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1) } catch {} }
    }
    foreach ($body in $bodies) {
      if ("$body" -match '^\s*(\\n|\s)*approved\b') {
        $reason = "a comment that begins 'Approved' is the tenant owner's Approval of a Triage proposal (CONTEXT.md **Approval**) and no fleet session may post one under any role: the fleet acts under the owner's own GitHub login, so bin/triage.js could not tell them apart. Say what you mean in other words ('the lead agrees', 'ruled: ...') or leave the decision to Cory $cite"
        break
      }
      if ("$body" -match '^\s*(\\n|\s)*re-?propose\b') {
        $reason = "a comment that begins 'Re-propose' is the tenant owner's ask for a new Triage proposal and no fleet session may post one under any role (fleet#55): the fleet acts under the owner's own GitHub login, so bin/triage.js reads the shape, not the author. Say what you mean in other words ('the scope changed; the Principal should look again') or leave the ask to Cory $cite"
        break
      }
    }
  }
}

# --- rule set 1: the Principal's write and action boundary ---
if (-not $reason -and $role -eq 'principal') {
  $repo = ''
  try { if ($tenant) { $repo = (Get-Content "$home_\tenants\$tenant.json" -Raw -Encoding UTF8 | ConvertFrom-Json).repo } } catch {}
  $repoN = Normalize-Path $repo ''
  $homeN = Normalize-Path $home_ ''
  $profileN = Normalize-Path $env:USERPROFILE ''
  $tempN = Normalize-Path ([IO.Path]::GetTempPath()) ''
  # Inside the tenant repo or the fleet only the named files are writable; the
  # memory and temp allowances apply only OUTSIDE both (a repo that happens to live
  # under the temp directory, as the test fixture does, gets no blanket pass).
  $insideRules = @()
  if ($repoN) {
    $insideRules += "^$(Escape-Rx $repoN)/(\.claude/worktrees/[^/]+/)?docs/adr/[^/]+\.md$"
    $insideRules += "^$(Escape-Rx $repoN)/(\.claude/worktrees/[^/]+/)?context\.md$"
  }
  $insideRules += "^$(Escape-Rx $homeN)/docs/adr/[^/]+\.md$"
  $insideRules += "^$(Escape-Rx $homeN)/context\.md$"
  if ($tenant) { $insideRules += "^$(Escape-Rx $homeN)/state/status/pe-$(Escape-Rx $tenant.ToLowerInvariant())\.md$" }
  $insideRules += "^$(Escape-Rx $homeN)/state/triage/"
  $outsideRules = @()
  if ($profileN) { $outsideRules += "^$(Escape-Rx $profileN)/\.claude/" }
  if ($tempN) { $outsideRules += "^$(Escape-Rx $tempN)/" }

  if ($tool -in @('Edit', 'Write', 'NotebookEdit', 'MultiEdit')) {
    $target = "$($inp.tool_input.file_path)"; if (-not $target) { $target = "$($inp.tool_input.notebook_path)" }
    $targetN = Normalize-Path $target "$($inp.cwd)"
    $inside = ($repoN -and $targetN.StartsWith("$repoN/")) -or $targetN.StartsWith("$homeN/")
    $ok = $false
    # Its own memory first (user-scope, ~/.claude): never inside a repo or the fleet by layout.
    if ($profileN -and $targetN -match "^$(Escape-Rx $profileN)/\.claude/") { $ok = $true }
    $allowed = if ($inside) { $insideRules } else { $outsideRules }
    foreach ($rx in $allowed) { if ($ok) { break }; if ($targetN -match $rx) { $ok = $true; break } }
    if (-not $ok) {
      $reason = "the Principal writes only ADR and glossary proposals (docs/adr/*.md, CONTEXT.md in the tenant repo or the fleet), its own status file (state/status/pe-<tenant>.md), the triage ledger through bin/triage.js, and its own memory; '$target' is none of those. Product code is an IC's: put the change in the proposal's Scope and Red-tell for the IC $cite"
    }
  } elseif ($tool -in @('Bash', 'PowerShell')) {
    $cmd = "$($inp.tool_input.command)"
    $flat = $cmd -replace '\s+', ' '
    # A test run is "bare" when no argument after the runner names a file (a path
    # separator or a .js/.ts extension); flags alone do not narrow a suite.
    $bareRunner = $null
    foreach ($runner in @(
      @{ re = '(^|[\s;&|(])npm\s+(test|t|run\s+test(:server)?)\b(?<rest>[^;&|]*)';  what = 'the bare test suite (npm test with no file)' },
      @{ re = '(^|[\s;&|(])npx\s+jest\b(?<rest>[^;&|]*)';                           what = 'the bare jest suite (npx jest with no path)' },
      @{ re = '(^|[\s;&|(])node\s+--test\b(?<rest>[^;&|]*)';                        what = 'the bare node test runner (node --test with no file)' }
    )) {
      if ($flat -match $runner.re) {
        $rest = "$($Matches['rest'])"
        $namesFile = $false
        foreach ($token in ($rest -split '\s+' | Where-Object { $_ -and $_ -ne '--' })) { if ($token -match '[/\\]' -or $token -match '\.[jt]sx?$') { $namesFile = $true; break } }
        if (-not $namesFile) { $bareRunner = $runner.what; break }
      }
    }
    $rules = @(
      @{ re = '(^|[\s;&|(])npm\s+(run\s+)?test:server:(all|sweep)\b';                                             what = 'the long server suite (test:server:all / :sweep, 35 to 42 minutes)' },
      @{ re = '(^|[\s;&|(])(node|npm\s+run|npx)\s+\S*sync-[a-z]';                                                what = 'a sync-* script (production data, API quota)' },
      @{ re = '(^|[\s;&|(])gh\s+issue\s+(close|delete|reopen)\b';                                                 what = 'closing, deleting or reopening an issue' },
      @{ re = '(^|[\s;&|(])gh\s+pr\s+(merge|close)\b';                                                            what = 'merging or closing a pull request' },
      @{ re = '(^|[\s;&|(])gh\s+(issue|pr)\s+edit\b.*--(add|remove)-label\s+\S*\b(wontfix|duplicate)\b';          what = 'the wontfix or duplicate label (a verdict, never the Principal''s)' },
      @{ re = '(^|[\s;&|(])gh\s+issue\s+edit\b.*--add-label\s+\S*\b(ready-for-agent|ready-for-human|needs-info)\b'; what = $null; approvalGated = $true },
      @{ re = '(^|[\s;&|(])git\s+push\b(?![^;&|]*\bdocs/)';                                                       what = 'a git push to a branch outside docs/ (the Principal opens docs PRs only)' }
    )
    if ($bareRunner) { $reason = "$bareRunner is outside the Principal's boundary: it may run ONE named test file (npm test -- <path>, node --test <file>) to confirm a red-tell and write everything else into the proposal's Repro: line for the IC; closing, merging, wontfix and duplicate are Cory's $cite" }
    foreach ($r in $rules) {
      if ($reason) { break }
      if ($r.approvalGated) { continue }   # routing labels are allowed here; the Approval that permits them is checked by the Principal against the ledger (triage.js record refuses a finalize with no approval)
      if ($flat -match $r.re) {
        $reason = "$($r.what) is outside the Principal's boundary: it may run ONE named test file (npm test -- <path>, node --test <file>) to confirm a red-tell and write everything else into the proposal's Repro: line for the IC; closing, merging, wontfix and duplicate are Cory's $cite"
        break
      }
    }
  } elseif ($tool -like 'mcp__claude_ai_Supabase__*' -or $tool -like 'mcp__claude_ai_Netlify__*updater*' -or $tool -like 'mcp__claude_ai_Netlify__*deploy*' -or $tool -like 'mcp__claude_ai_Netlify__import*') {
    $reason = "'$tool' reaches production data or a deploy; the Principal reads code and tickets, never the shared Supabase database or Netlify. Name the query or check in the proposal's Repro: line for the IC $cite"
  }
}

if (-not $reason) { exit 0 }
$out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } }
[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 4))
exit 0
