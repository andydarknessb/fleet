# fleet #274: sentinel-check forwards a sync-integration result to report.escalate only when it
# escalates. A sync-waiting result ({ escalate:false }) adds nothing; sync-unattested and sync-blocked
# are forwarded under their own kind with the reason as the detail, so the Watchdog prices them.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-sync-result-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

try {
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','profile/.claude/jobs','mock-bin','repo-a','repo-b','repo-c','repo-d') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','sentinel-check.ps1','pause.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  foreach ($n in 'a', 'b', 'c', 'd') {
    Write-Utf8 "$testRoot\tenants\$n.json" (@{ name = $n; repo = "$testRoot\repo-$n"; github = "owner/repo-$n"; defaultBranch = 'integration'; releaseBranch = 'main'; readyLabel = 'ready-for-agent' } | ConvertTo-Json -Compress)
  }
  # The sync script is a stub: tenant a waits, b is unattested, c is blocked.
  Write-Utf8 "$testRoot\bin\sync-integration.ps1" (@'
param([string]$Tenant, [switch]$Apply)
if ($Tenant -eq 'a') { Write-Output '{"synced":false,"kind":"sync-waiting","escalate":false,"to":"abc1234","waitingOn":["test-build"],"reason":"waiting on required check(s) still running"}'; exit 0 }
if ($Tenant -eq 'b') { Write-Output '{"synced":false,"escalate":true,"kind":"sync-unattested","to":"abc1234","prUrl":"https://github.com/owner/repo-b/pull/7","reason":"tip carries no fleet-review status; attest it: node bin/review-policy.js attest --tenant b --pr 7 --head abc"}'; exit 2 }
if ($Tenant -eq 'd') { Write-Output '{"synced":false,"escalate":true,"kind":"sync-stalled","to":"abc1234","reason":"tip abc1234 has waited 125 min (limit 120)"}'; exit 2 }
Write-Output '{"synced":false,"escalate":true,"kind":"sync-blocked","to":"abc1234","failedChecks":["guards"],"reason":"required check(s) failed on it: guards"}'; exit 2
'@)
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"

  $report = (& "$testRoot\bin\sentinel-check.ps1" -Apply -ReportPath "$testRoot\state\sentinel\last-check.json" | Out-String) | ConvertFrom-Json
  $syncEsc = @($report.escalate | Where-Object { "$($_.kind)" -like 'sync-*' })
  Assert-True (@($report.sync).Count -eq 4) "all four sync results must be reported (got $(@($report.sync).Count))"
  Assert-True (@($syncEsc | Where-Object { $_.name -eq 'pl-a' }).Count -eq 0) 'a sync-waiting result (escalate false) must add nothing to report.escalate'
  $unattested = @($syncEsc | Where-Object { $_.name -eq 'pl-b' })
  Assert-True ($unattested.Count -eq 1 -and $unattested[0].kind -eq 'sync-unattested' -and "$($unattested[0].detail)" -match 'review-policy\.js attest') 'sync-unattested must be forwarded under its own kind with the attest command as the detail'
  Assert-True ("$($unattested[0].url)" -eq 'https://github.com/owner/repo-b/pull/7') 'sync-unattested must forward its reconciliation PR as the escalation url'
  $blocked = @($syncEsc | Where-Object { $_.name -eq 'pl-c' })
  Assert-True ($blocked.Count -eq 1 -and $blocked[0].kind -eq 'sync-blocked' -and "$($blocked[0].detail)" -match 'guards') 'sync-blocked must be forwarded under its own kind with the failed check as the detail'
  $stalled = @($syncEsc | Where-Object { $_.name -eq 'pl-d' })
  Assert-True ($stalled.Count -eq 1 -and $stalled[0].kind -eq 'sync-stalled' -and "$($stalled[0].detail)" -match 'waited 125 min') 'sync-stalled must be forwarded under its own kind'
  Assert-True (@($syncEsc | Where-Object { $_.name -ne 'pl-b' -and $_.PSObject.Properties['url'] }).Count -eq 0) 'only sync-unattested forwards a url'
  Write-Output 'sentinel-sync-result tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
