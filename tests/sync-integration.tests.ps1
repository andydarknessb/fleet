# Ticket 09 (fleet #87): real divergence opens the reconciliation PR itself (idempotent across
# ticks via `gh pr list`), the PR body says MERGE COMMIT and why, and a refused push records
# git's stderr and escalates. Uses two local bare repos (real git, no GitHub) and a gh.cmd mock.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Invoke-Git {
  # 2>&1 on a native command under EAP Stop turns child stderr into a terminating ErrorRecord
  # (PS 5.1); relax around every git call so refusal/porcelain text stays plain data.
  param([string[]]$GitArgs)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & git @GitArgs 2>&1 | Out-String } finally { $ErrorActionPreference = $eap }
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-sync-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH

function Run-Sync {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\sync-integration.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
}

try {
  foreach ($dir in 'bin','tenants','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  [IO.File]::Copy("$sourceRoot\bin\_common.ps1", "$testRoot\bin\_common.ps1")
  [IO.File]::Copy("$sourceRoot\bin\sync-integration.ps1", "$testRoot\bin\sync-integration.ps1")

  # --- gh.cmd mock: `gh pr list` reads a marker file a prior `gh pr create` call wrote, so the
  # --- second tick of the same divergence sees the PR the first tick opened (idempotency). Every
  # --- `pr create` call is logged so the test can assert there was exactly one across two runs.
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" (
    '@echo off' + "`r`n" +
    'if "%1"=="pr" if "%2"=="list" goto :list' + "`r`n" +
    'if "%1"=="pr" if "%2"=="create" goto :create' + "`r`n" +
    'exit /b 0' + "`r`n" +
    ':list' + "`r`n" +
    'if exist "' + $testRoot + '\pr-open.json" (type "' + $testRoot + '\pr-open.json") else (echo [])' + "`r`n" +
    'exit /b 0' + "`r`n" +
    ':create' + "`r`n" +
    'echo x>> "' + $testRoot + '\pr-create-calls.log"' + "`r`n" +
    'echo {"number":501,"url":"https://github.com/owner/repo/pull/501"}> "' + $testRoot + '\pr-open.json"' + "`r`n" +
    'echo https://github.com/owner/repo/pull/501' + "`r`n" +
    'exit /b 0' + "`r`n"
  )
  $env:PATH = "$testRoot\mock-bin;$oldPath"

  # --- Scenario A: default and release structurally diverge with real content on both sides. ---
  $remoteA = "$testRoot\remoteA.git"; $repoA = "$testRoot\repoA"
  Invoke-Git @('init', '--bare', '-q', $remoteA) | Out-Null
  Invoke-Git @('clone', '-q', $remoteA, $repoA) | Out-Null
  Invoke-Git @('-C', $repoA, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-Git @('-C', $repoA, 'config', 'user.name', 'a') | Out-Null
  Invoke-Git @('-C', $repoA, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-Git @('-C', $repoA, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-Git @('-C', $repoA, 'push', '-q', '-u', 'origin', 'main') | Out-Null
  Invoke-Git @('-C', $repoA, 'checkout', '-q', '-b', 'integration') | Out-Null
  Write-Utf8 "$repoA\release-only.txt" 'release content'
  Invoke-Git @('-C', $repoA, 'add', '-A') | Out-Null
  Invoke-Git @('-C', $repoA, 'commit', '-q', '-m', 'release-only change') | Out-Null
  Invoke-Git @('-C', $repoA, 'push', '-q', '-u', 'origin', 'integration') | Out-Null
  Invoke-Git @('-C', $repoA, 'checkout', '-q', 'main') | Out-Null
  Write-Utf8 "$repoA\main-only.txt" 'main content'
  Invoke-Git @('-C', $repoA, 'add', '-A') | Out-Null
  Invoke-Git @('-C', $repoA, 'commit', '-q', '-m', 'main-only change') | Out-Null
  Invoke-Git @('-C', $repoA, 'push', '-q', 'origin', 'main') | Out-Null

  Write-Utf8 "$testRoot\tenants\a.json" (@{ name = 'a'; repo = $repoA; github = 'owner/repo'; defaultBranch = 'main'; releaseBranch = 'integration' } | ConvertTo-Json -Compress)

  $r1 = Run-Sync @('-Tenant', 'a')
  Assert-True ($script:lastExit -eq 2) 'a content divergence must exit 2 (escalate)'
  Assert-True ($r1.escalate -eq $true -and $r1.kind -eq 'branch-diverged') 'divergence with content must escalate as branch-diverged'
  Assert-True ("$($r1.prUrl)" -eq 'https://github.com/owner/repo/pull/501') 'the escalation must carry the reconciliation PR URL'
  Assert-True ("$($r1.reason)" -match 'pull/501') 'the reason text must also link the PR so a page reading only reason still gets it'
  Assert-True ((Get-Content "$testRoot\pr-create-calls.log" -Raw).Trim().Length -gt 0) 'a real divergence must call gh pr create'
  $callsAfterFirst = @(Get-Content "$testRoot\pr-create-calls.log").Count

  $r2 = Run-Sync @('-Tenant', 'a')
  Assert-True ($script:lastExit -eq 2) 'the same divergence on the next tick must still escalate'
  Assert-True ("$($r2.prUrl)" -eq 'https://github.com/owner/repo/pull/501') 'the second tick must report the same PR'
  Assert-True (@(Get-Content "$testRoot\pr-create-calls.log").Count -eq $callsAfterFirst) 'idempotent: exactly one pr create call across two runs, not two'
  Assert-True (@(Get-Content "$testRoot\pr-create-calls.log").Count -eq 1) 'exactly one pr create call total'

  # --- Scenario B: a pure fast-forward that a pre-receive hook on the remote refuses. ---
  $remoteB = "$testRoot\remoteB.git"; $repoB = "$testRoot\repoB"
  Invoke-Git @('init', '--bare', '-q', $remoteB) | Out-Null
  Invoke-Git @('clone', '-q', $remoteB, $repoB) | Out-Null
  Invoke-Git @('-C', $repoB, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-Git @('-C', $repoB, 'config', 'user.name', 'a') | Out-Null
  Invoke-Git @('-C', $repoB, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-Git @('-C', $repoB, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-Git @('-C', $repoB, 'push', '-q', '-u', 'origin', 'main') | Out-Null
  Invoke-Git @('-C', $repoB, 'checkout', '-q', '-b', 'integration') | Out-Null
  Invoke-Git @('-C', $repoB, 'commit', '-q', '--allow-empty', '-m', 'ff-only change') | Out-Null
  Invoke-Git @('-C', $repoB, 'push', '-q', '-u', 'origin', 'integration') | Out-Null
  # The hook lands only after the fixture's own setup pushes succeed - it exists to
  # refuse sync-integration.ps1's OWN fast-forward push, not the fixture's setup.
  [IO.Directory]::CreateDirectory("$remoteB\hooks") | Out-Null
  Write-Utf8 "$remoteB\hooks\pre-receive" ("#!/bin/sh`necho `"refusing: branch protection active`" 1>&2`nexit 1`n")

  Write-Utf8 "$testRoot\tenants\b.json" (@{ name = 'b'; repo = $repoB; github = 'owner/repo2'; defaultBranch = 'main'; releaseBranch = 'integration' } | ConvertTo-Json -Compress)

  $r3 = Run-Sync @('-Tenant', 'b', '-Apply')
  Assert-True ($script:lastExit -eq 2) 'a push refused by a pre-receive hook must exit 2 (escalate)'
  Assert-True ($r3.synced -eq $false) 'a refused push must not report synced'
  Assert-True ("$($r3.pushError)" -match 'refusing: branch protection active') 'pushError must carry the hook stderr text'
  Assert-True ($r3.escalate -eq $true -and $r3.kind -eq 'sync-refused') 'a refused push must escalate as sync-refused'

  Write-Output 'sync-integration tests passed'
} finally {
  $env:PATH = $oldPath
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-sync-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    # git marks pack/idx files read-only; IO.Directory.Delete refuses those, so clear
    # attributes first and fall back to Remove-Item, which does its own clearing.
    try { Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Attributes = 'Normal' } catch {} } } catch {}
    try { [IO.Directory]::Delete($resolved, $true) } catch { try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
  }
}
