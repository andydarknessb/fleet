$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-sentinel-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

try {
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','profile/.claude/jobs/job-900','repo','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  [IO.File]::Copy("$sourceRoot\bin\_common.ps1", "$testRoot\bin\_common.ps1")
  [IO.File]::Copy("$sourceRoot\bin\sentinel-check.ps1", "$testRoot\bin\sentinel-check.ps1")

  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-900","role":"ic","tenant":"test","parent":"pl-test","issue":900,"cwd":"REPO","status":"active","jobId":"job-900"}]}'
  (Get-Content "$testRoot\state\roster.json" -Raw).Replace('REPO', ($testRoot + '\repo').Replace('\', '\\')) | Set-Content "$testRoot\state\roster.json" -Encoding UTF8
  Write-Utf8 "$testRoot\tenants\test.json" '{"name":"test","repo":"REPO","github":"owner/repo","defaultBranch":"master","releaseBranch":"master","branchPrefix":"fleet/"}'
  (Get-Content "$testRoot\tenants\test.json" -Raw).Replace('REPO', ($testRoot + '\repo').Replace('\', '\\')) | Set-Content "$testRoot\tenants\test.json" -Encoding UTF8
  Write-Utf8 "$testRoot\state\heartbeats\ic-900.json" (ConvertTo-Json @{ at = (Get-Date).ToUniversalTime().AddHours(-3).ToString('o') } -Compress)
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" '{"detail":"","waitingFor":""}'
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  & git -C "$testRoot\repo" init --quiet

  Write-Utf8 "$testRoot\mock-bin\claude.cmd" '@echo off
if "%1"=="agents" echo [{"id":"job-900","name":"ic-900","state":"working","status":"idle","pid":900,"startedAt":"2026-08-28T00:00:00Z"}]
exit /b 0
'
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" '@echo off
if "%MOCK_GH_FAIL%"=="1" (echo simulated gh failure 1>&2 & exit /b 7)
if "%MOCK_PR%"=="1" (echo [{"number":777,"headRefName":"fleet/900-fix"}] & exit /b 0)
echo []
exit /b 0
'

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"

  $env:MOCK_PR = '1'; $env:MOCK_GH_FAIL = '0'
  $withPr = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($withPr.respawned).Count -eq 0) 'an IC with an open issue PR must not be stale-heartbeat respawned'
  Assert-True (@($withPr.ok | Where-Object { $_.name -eq 'ic-900' -and $_.detail -eq 'waiting on PR #777' }).Count -eq 1) 'the open PR exemption must name the PR under ok'

  $env:MOCK_PR = '0'
  $withoutPr = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($withoutPr.respawned).Count -eq 1) 'a stale idle IC with no PR or hold must remain respawnable'
  Assert-True ($withoutPr.respawned[0].reason -match 'state=working status=idle, no open PR') 'the respawn reason must report measured state and status'

  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{"900":"held"},"prs":{}}'
  $env:MOCK_GH_FAIL = '1'
  $held = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($held.respawned).Count -eq 0) 'an issue skip-list hold must exempt stale-heartbeat respawn'
  Assert-True (@($held.escalate).Count -eq 0) 'an issue hold must not depend on the PR lookup'

  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  $failed = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($failed.respawned).Count -eq 0) 'a failed PR lookup must fail safe without respawning'
  Assert-True (@($failed.escalate | Where-Object { $_.kind -eq 'pr-lookup-failed' }).Count -eq 1) 'a failed PR lookup must escalate'

  Write-Output 'sentinel respawn tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_PR -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_GH_FAIL -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-sentinel-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
