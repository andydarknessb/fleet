$ErrorActionPreference = 'Stop'

# fleet #265: the Sentinel's cleanup-pending pass. retire.ps1 queues a line in
# state/sentinel/cleanup-pending.jsonl when the claude CLI was missing (the npm
# auto-update window). Under -Apply AND state/flags/ic-cleanup-live the pass stops and
# removes the job (strict re-read verified), removes each listed worktree only when
# `git status --porcelain` is empty, and drops the line; a failure keeps the line with
# attempts+1 and, from the third, escalates kind cleanup-pending. A read-only run
# reports what it would do and writes nothing.

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-cleanup-pending-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($n in 'PATH', 'APPDATA', 'USERPROFILE', 'FLEET_CLAUDE_CLI', 'MOCK_CLAUDE_FAIL', 'FLEET_RESPAWN_VERIFY_MS', 'FLEET_RESPAWN_VERIFY_POLL_MS') { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$pendingPath = "$testRoot\state\sentinel\cleanup-pending.jsonl"

function Run-Check {
  param([switch]$Apply)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = if ($Apply) { (& powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\sentinel-check.ps1" -Apply -ReportPath "$testRoot\report.json" 2>&1 | Out-String) }
           else { (& powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\sentinel-check.ps1" -ReportPath "$testRoot\report.json" 2>&1 | Out-String) }
  } finally { $ErrorActionPreference = $eap }
  $start = $out.IndexOf('{')
  try { return ($out.Substring($start) | ConvertFrom-Json) } catch { throw "sentinel-check did not print JSON: $out" }
}
function Reset-Fixture {
  # a clean, owned worktree plus a pending line naming job-1 and that worktree
  Remove-Item "$testRoot\mock-state" -Recurse -Force -ErrorAction SilentlyContinue
  [IO.Directory]::CreateDirectory("$testRoot\mock-state") | Out-Null
  Remove-Item "$testRoot\repo\.claude\worktrees\ic-9" -Recurse -Force -ErrorAction SilentlyContinue
  $eapGit = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & git -C "$testRoot\repo" worktree prune
  & git -C "$testRoot\repo" branch -D worktree-ic-9 2>$null | Out-Null
  & git -C "$testRoot\repo" worktree add "$testRoot\repo\.claude\worktrees\ic-9" -b worktree-ic-9 --quiet 2>$null
  $ErrorActionPreference = $eapGit
  Assert-True (Test-Path "$testRoot\repo\.claude\worktrees\ic-9") 'fixture: the owned worktree must exist'
  $line = [ordered]@{ at = '2026-09-30T19:17:13Z'; name = 'ic-9'; jobId = 'job-1'; cwd = "$testRoot\repo"; worktrees = @("$testRoot\repo\.claude\worktrees\ic-9"); reason = 'claude-cli-missing'; tried = @('PATH'); attempts = 0 }
  Write-Utf8 $pendingPath ((($line | ConvertTo-Json -Compress -Depth 4)) + [Environment]::NewLine)
}

try {
  foreach ($dir in 'bin', 'tenants', 'state', 'state/heartbeats', 'state/sentinel', 'state/skip', 'state/flags', 'profile/.claude/jobs', 'repo', 'mock-bin', 'mock-state') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1', 'sentinel-check.ps1', 'pause.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  $repoJson = ($testRoot + '\repo').Replace('\', '\\')
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","repo":"' + $repoJson + '","github":"owner/repo","defaultBranch":"master","releaseBranch":"master","branchPrefix":"fleet/"}')
  & git -C "$testRoot\repo" init --quiet
  & git -C "$testRoot\repo" -c user.email=t@t -c user.name=t commit --allow-empty -m init --quiet

  # A stateful mock: job-1 has a pid until `stop`, then a row with no pid until `rm`, then no row.
  # MOCK_CLAUDE_FAIL=1 makes stop and rm exit 9 without doing anything (the job stays up); agents still reads.
  $ms = "$testRoot\mock-state"
  $row = '{"id":"job-1","name":"ic-9","state":"working","status":"idle","pid":77,"startedAt":"2026-09-30T00:00:00Z"}'
  $rowStopped = '{"id":"job-1","name":"ic-9","state":"stopped","status":"idle","startedAt":"2026-09-30T00:00:00Z"}'
  $cmd = '@echo off' + "`r`n" +
    'if "%1"=="agents" goto agents' + "`r`n" +
    'if "%MOCK_CLAUDE_FAIL%"=="1" exit /b 9' + "`r`n" +
    'if "%1"=="stop" (echo stop %2>>"' + $testRoot + '\claude-calls.log" & echo x>"' + $ms + '\stopped" & exit /b 0)' + "`r`n" +
    'if "%1"=="rm" (echo rm %2>>"' + $testRoot + '\claude-calls.log" & echo x>"' + $ms + '\removed" & exit /b 0)' + "`r`n" +
    'exit /b 0' + "`r`n" +
    ':agents' + "`r`n" +
    'if exist "' + $ms + '\removed" (echo [] & exit /b 0)' + "`r`n" +
    'if exist "' + $ms + '\stopped" (echo [' + $rowStopped + '] & exit /b 0)' + "`r`n" +
    'echo [' + $row + ']' + "`r`n" +
    'exit /b 0' + "`r`n"
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" $cmd

  $gitDir = Split-Path -Parent (Get-Command git).Source
  $env:PATH = "$testRoot\mock-bin;$PSHOME;$gitDir"
  $env:APPDATA = "$testRoot\appdata"
  $env:USERPROFILE = "$testRoot\profile"
  Remove-Item Env:\FLEET_CLAUDE_CLI -ErrorAction SilentlyContinue
  $env:FLEET_RESPAWN_VERIFY_MS = '50'
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = '10'
  $env:MOCK_CLAUDE_FAIL = '0'
  $calls = "$testRoot\claude-calls.log"

  # Case 1: a read-only run reports what it would do and writes nothing.
  Reset-Fixture
  Write-Utf8 "$testRoot\state\flags\ic-cleanup-live" 'on'
  $before = [IO.File]::ReadAllText($pendingPath)
  $r = Run-Check
  Assert-True ($null -ne $r.cleanupPending -and @($r.cleanupPending).Count -eq 1) 'the read-only run must report the pending line'
  Assert-True (@($r.cleanupPending)[0].outcome -match '^would ' -and @($r.cleanupPending)[0].outcome -match 'read-only run') "the read-only outcome must say it would act: $(@($r.cleanupPending)[0].outcome)"
  Assert-True ([IO.File]::ReadAllText($pendingPath) -eq $before) 'a read-only run must not rewrite cleanup-pending.jsonl'
  Assert-True (-not (Test-Path $calls)) 'a read-only run must not stop or rm anything'
  Assert-True (Test-Path "$testRoot\repo\.claude\worktrees\ic-9") 'a read-only run must not remove a worktree'

  # Case 2: -Apply without the flag is shadow too.
  Remove-Item "$testRoot\state\flags\ic-cleanup-live"
  $r = Run-Check -Apply
  Assert-True (@($r.cleanupPending)[0].outcome -match 'ic-cleanup-live absent') "without the flag the pass only reports: $(@($r.cleanupPending)[0].outcome)"
  Assert-True ([IO.File]::ReadAllText($pendingPath) -eq $before -and -not (Test-Path $calls)) 'without the flag nothing is written or run'

  # Case 3: flag + -Apply: stop, rm (each verified), worktree removed (clean), line dropped, outcome reported.
  Write-Utf8 "$testRoot\state\flags\ic-cleanup-live" 'on'
  $r = Run-Check -Apply
  $logged = Get-Content $calls -Raw
  Assert-True ($logged -match 'stop job-1' -and $logged -match 'rm job-1') "stop and rm must both run: $logged"
  Assert-True (@($r.cleanupPending).Count -eq 1 -and @($r.cleanupPending)[0].outcome -match '^cleaned') "the pass must report the cleanup: $(@($r.cleanupPending)[0].outcome)"
  Assert-True (-not (Test-Path $pendingPath)) 'the finished line must be dropped (file removed when empty)'
  Assert-True (-not (Test-Path "$testRoot\repo\.claude\worktrees\ic-9")) 'a clean worktree must be removed'
  Assert-True (@($r.escalate | Where-Object { $_.kind -eq 'cleanup-pending' }).Count -eq 0) 'a success must not escalate'

  # Case 4: a dirty worktree is kept (attempts+1, reason recorded) though the job went.
  Remove-Item $calls -ErrorAction SilentlyContinue
  Reset-Fixture
  Write-Utf8 "$testRoot\repo\.claude\worktrees\ic-9\unsaved.txt" 'work in progress'
  $r = Run-Check -Apply
  $kept = @(Get-Content $pendingPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-True ($kept.Count -eq 1 -and $kept[0].attempts -eq 1 -and "$($kept[0].lastError)" -match 'uncommitted') "a dirty worktree must keep the line with attempts=1: $($kept | ConvertTo-Json -Compress)"
  Assert-True (Test-Path "$testRoot\repo\.claude\worktrees\ic-9\unsaved.txt") 'a dirty worktree must never be removed'
  Assert-True (@($r.escalate | Where-Object { $_.kind -eq 'cleanup-pending' }).Count -eq 0) 'no escalation before the third attempt'

  # Case 5: a job that will not stop (MOCK_CLAUDE_FAIL=1) over three ticks: attempts=3 and the escalation.
  Remove-Item $calls -ErrorAction SilentlyContinue
  Reset-Fixture
  $env:MOCK_CLAUDE_FAIL = '1'
  $r1 = Run-Check -Apply
  $r2 = Run-Check -Apply
  Assert-True (@($r1.escalate | Where-Object { $_.kind -eq 'cleanup-pending' }).Count -eq 0 -and @($r2.escalate | Where-Object { $_.kind -eq 'cleanup-pending' }).Count -eq 0) 'no escalation on attempts 1 and 2'
  $r3 = Run-Check -Apply
  $kept = @(Get-Content $pendingPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-True ($kept.Count -eq 1 -and $kept[0].attempts -eq 3) "the line must be kept with attempts=3, got $($kept | ConvertTo-Json -Compress)"
  $esc = @($r3.escalate | Where-Object { $_.kind -eq 'cleanup-pending' })
  Assert-True ($esc.Count -eq 1 -and $esc[0].name -eq 'ic-9' -and "$($esc[0].detail)" -match 'job-1') 'the third failed attempt must escalate kind cleanup-pending naming the job'
  Assert-True (Test-Path "$testRoot\repo\.claude\worktrees\ic-9") 'worktrees stay while the job is still up'
  $env:MOCK_CLAUDE_FAIL = '0'

  Write-Output 'sentinel-cleanup-pending tests passed'
} finally {
  foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
