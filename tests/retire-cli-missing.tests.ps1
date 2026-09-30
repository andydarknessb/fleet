$ErrorActionPreference = 'Stop'

# fleet #265: retire.ps1 when the claude CLI is missing (the npm auto-update window).
# Before: `& claude rm` threw under 2>$null, the job stayed alive, the roster said
# retired, and the exit was 0 with jobRemoval 'unknown'. Now: the roster side completes
# (a retired row releases the Work record's claim), the job and its worktrees are NOT
# touched, the job is queued in state/sentinel/cleanup-pending.jsonl, and the exit is 6.

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-retire-cli-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($n in 'PATH', 'APPDATA', 'USERPROFILE', 'FLEET_CLAUDE_CLI', 'FLEET_CLAUDE_RESOLVE_TRIES', 'FLEET_CLAUDE_RESOLVE_POLL_MS') { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }

function Run-Retire {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\retire.ps1" -Name ic-9 -Reason 'test' 2>&1 | Out-String) }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  $line = ($out.Trim() -split "`n" | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
  return [pscustomobject]@{ out = $out; json = $(if ($line) { $line | ConvertFrom-Json } else { $null }) }
}
function Set-Roster {
  $cwd = ($testRoot + '\repo').Replace('\', '\\')
  Write-Utf8 "$testRoot\state\roster.json" ('{"sessions":[{"name":"ic-9","role":"ic","tenant":"test","parent":"pl-test","issue":9,"cwd":"' + $cwd + '","status":"active","jobId":"job-1","prompt":"p"}]}')
}

try {
  foreach ($dir in 'bin', 'state', 'state/heartbeats', 'state/sentinel', 'mock-bin', 'elsewhere', 'appdata', 'profile', 'repo') { [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null }
  foreach ($f in '_common.ps1', 'retire.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\heartbeats\ic-9.json" '{"at":"2026-09-30T00:00:00Z"}'
  Set-Roster

  # A real repo with the IC's owned worktree: a missing CLI must leave it alone.
  & git -C "$testRoot\repo" init --quiet
  & git -C "$testRoot\repo" -c user.email=t@t -c user.name=t commit --allow-empty -m init --quiet
  & git -C "$testRoot\repo" worktree add "$testRoot\repo\.claude\worktrees\ic-9" -b worktree-ic-9 --quiet 2>$null
  Assert-True (Test-Path "$testRoot\repo\.claude\worktrees\ic-9") 'fixture: the owned worktree must exist'

  $mockLog = "$testRoot\claude-calls.log"
  Write-Utf8 "$testRoot\elsewhere\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="stop" echo stop %2>>"' + $mockLog + '"' + "`r`n" + 'if "%1"=="rm" echo rm %2>>"' + $mockLog + '"' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")

  $gitDir = Split-Path -Parent (Get-Command git).Source
  $env:PATH = "$testRoot\mock-bin;$PSHOME;$gitDir"
  $env:APPDATA = "$testRoot\appdata"
  $env:USERPROFILE = "$testRoot\profile"
  Remove-Item Env:\FLEET_CLAUDE_CLI -ErrorAction SilentlyContinue
  $env:FLEET_CLAUDE_RESOLVE_TRIES = '2'
  $env:FLEET_CLAUDE_RESOLVE_POLL_MS = '50'

  # Case 1: no claude anywhere.
  $r = Run-Retire
  Assert-True ($null -ne $r.json) "retire.ps1 must still print its JSON: $($r.out)"
  Assert-True ($script:lastExit -eq 6) "a retire that could not reach the CLI must exit 6, got $script:lastExit"
  Assert-True ("$($r.json.retired)" -eq 'ic-9') 'the JSON must still say retired:ic-9 (callers read success from it)'
  Assert-True ("$($r.json.jobRemoval)" -eq 'cli-missing') "jobRemoval must be cli-missing, got '$($r.json.jobRemoval)'"
  Assert-True ($r.json.cleanupPending -eq $true) 'the JSON must carry cleanupPending:true'
  $row = @((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions)[0]
  Assert-True ($row.status -eq 'retired') "the roster must say retired (it releases the Work record's claim), got '$($row.status)'"
  Assert-True ($row.jobRemoval -eq 'cli-missing' -and $row.cleanupPending -eq $true) 'the roster row must record jobRemoval and cleanupPending'
  Assert-True (-not (Test-Path "$testRoot\state\heartbeats\ic-9.json")) 'the heartbeat must be removed'
  $archive = Get-Content "$testRoot\state\archive\roster-retired-full.jsonl" -Raw | ConvertFrom-Json
  Assert-True ($archive.jobRemoval -eq 'cli-missing' -and $archive.cleanupPending -eq $true) 'the archive line must record jobRemoval and cleanupPending'
  $pending = @(Get-Content "$testRoot\state\sentinel\cleanup-pending.jsonl" | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-True ($pending.Count -eq 1) "exactly one cleanup-pending line expected, got $($pending.Count)"
  Assert-True ($pending[0].jobId -eq 'job-1' -and $pending[0].name -eq 'ic-9' -and $pending[0].reason -eq 'claude-cli-missing') 'the pending line must name the job and the reason'
  Assert-True (@($pending[0].worktrees).Count -eq 1 -and "$($pending[0].worktrees[0])".Replace('/', '\') -like '*\.claude\worktrees\ic-9') "the pending line must list the owned worktree: $($pending[0].worktrees -join ',')"
  Assert-True (@($pending[0].tried).Count -ge 1 -and $pending[0].at) 'the pending line must carry at and tried'
  Assert-True (-not (Test-Path $mockLog)) 'no stop/rm may run without a CLI'
  Assert-True (Test-Path "$testRoot\repo\.claude\worktrees\ic-9") 'the worktree must NOT be touched while job liveness is unknown'

  # Case 2: the CLI is back (override -> a mock): a full retire, no pending line, exit 0.
  Remove-Item "$testRoot\state\sentinel\cleanup-pending.jsonl"
  Set-Roster
  $env:FLEET_CLAUDE_CLI = "$testRoot\elsewhere\claude.cmd"
  $r = Run-Retire
  Assert-True ($script:lastExit -eq 0) "a retire with a working CLI must exit 0, got $script:lastExit ($($r.out))"
  Assert-True ("$($r.json.retired)" -eq 'ic-9' -and "$($r.json.jobRemoval)" -eq 'removed') "jobRemoval must be removed, got '$($r.json.jobRemoval)'"
  Assert-True ($r.json.cleanupPending -eq $false) 'cleanupPending must be false'
  Assert-True (-not (Test-Path "$testRoot\state\sentinel\cleanup-pending.jsonl")) 'no pending line when the CLI worked'
  $calls = Get-Content $mockLog -Raw
  Assert-True ($calls -match 'stop job-1' -and $calls -match 'rm job-1') "stop and rm must both run through the override: $calls"
  Assert-True (-not (Test-Path "$testRoot\repo\.claude\worktrees\ic-9")) 'the owned worktree is removed once the job is confirmed gone'

  Write-Output 'retire-cli-missing tests passed'
} finally {
  foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
