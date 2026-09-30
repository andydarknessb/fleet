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
    'echo %*>> "' + $testRoot + '\pr-create-calls.log"' + "`r`n" +
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
  # The live Watchdog escalated branch-diverged on every tick on 2026-09-29: Start-Process -ArgumentList
  # does not quote an element with spaces, so gh read the title as extra arguments and refused.
  Assert-True ((Get-Content "$testRoot\pr-create-calls.log" -Raw) -match '--title "Reconcile integration into main"') 'the reconciliation PR title must reach gh as one quoted argument'

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

  # --- Scenario C: `gh pr list` fails outright (simulated gh outage) on a real
  # --- divergence. The old code treated "list failed" the same as "no PR yet" and
  # --- created one on every tick (review finding 4); it must instead escalate naming
  # --- the failure and never call `pr create` at all. ---
  [IO.Directory]::CreateDirectory("$testRoot\mock-bin-outage") | Out-Null
  Write-Utf8 "$testRoot\mock-bin-outage\gh.cmd" (
    '@echo off' + "`r`n" +
    'if "%1"=="pr" if "%2"=="list" (echo gh: connection reset by peer 1>&2 & exit /b 1)' + "`r`n" +
    'if "%1"=="pr" if "%2"=="create" (echo x>> "' + $testRoot + '\pr-create-calls-outage.log" & echo https://github.com/owner/repo3/pull/999 & exit /b 0)' + "`r`n" +
    'exit /b 0' + "`r`n"
  )
  $remoteC = "$testRoot\remoteC.git"; $repoC = "$testRoot\repoC"
  Invoke-Git @('init', '--bare', '-q', $remoteC) | Out-Null
  Invoke-Git @('clone', '-q', $remoteC, $repoC) | Out-Null
  Invoke-Git @('-C', $repoC, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-Git @('-C', $repoC, 'config', 'user.name', 'a') | Out-Null
  Invoke-Git @('-C', $repoC, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-Git @('-C', $repoC, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-Git @('-C', $repoC, 'push', '-q', '-u', 'origin', 'main') | Out-Null
  Invoke-Git @('-C', $repoC, 'checkout', '-q', '-b', 'integration') | Out-Null
  Write-Utf8 "$repoC\release-only.txt" 'release content'
  Invoke-Git @('-C', $repoC, 'add', '-A') | Out-Null
  Invoke-Git @('-C', $repoC, 'commit', '-q', '-m', 'release-only change') | Out-Null
  Invoke-Git @('-C', $repoC, 'push', '-q', '-u', 'origin', 'integration') | Out-Null
  Invoke-Git @('-C', $repoC, 'checkout', '-q', 'main') | Out-Null
  Write-Utf8 "$repoC\main-only.txt" 'main content'
  Invoke-Git @('-C', $repoC, 'add', '-A') | Out-Null
  Invoke-Git @('-C', $repoC, 'commit', '-q', '-m', 'main-only change') | Out-Null
  Invoke-Git @('-C', $repoC, 'push', '-q', 'origin', 'main') | Out-Null
  Write-Utf8 "$testRoot\tenants\c.json" (@{ name = 'c'; repo = $repoC; github = 'owner/repo3'; defaultBranch = 'main'; releaseBranch = 'integration' } | ConvertTo-Json -Compress)

  $env:PATH = "$testRoot\mock-bin-outage;$oldPath"
  $c1 = Run-Sync @('-Tenant', 'c')
  Assert-True ($script:lastExit -eq 2) 'a divergence during a gh outage must still exit 2 (escalate)'
  Assert-True (-not (Test-Path "$testRoot\pr-create-calls-outage.log")) 'gh pr create must never be called when gh pr list itself failed'
  Assert-True ("$($c1.reason)" -match 'could not confirm whether a reconciliation PR already exists') 'the escalation must name why no PR was opened, not silently omit it'
  Assert-True (-not "$($c1.prUrl)") 'no PR URL can be reported when none was safely confirmed or created'

  $c2 = Run-Sync @('-Tenant', 'c')
  Assert-True ($script:lastExit -eq 2) 'the next tick during the same outage must still escalate'
  Assert-True (-not (Test-Path "$testRoot\pr-create-calls-outage.log")) 'a second tick during the same outage must still never create a PR (not "one per outage tick")'
  $env:PATH = "$testRoot\mock-bin;$oldPath"

  # --- Scenario D: `gh pr create` succeeds but writes to BOTH stdout and stderr, with
  # --- stderr chatter arriving after the real URL. The old parse merged the streams
  # --- with `2>&1` and took the merged stream's last line, which could grab the
  # --- trailing stderr text instead of the URL (review finding 14). ---
  [IO.Directory]::CreateDirectory("$testRoot\mock-bin-mixed") | Out-Null
  Write-Utf8 "$testRoot\mock-bin-mixed\gh.cmd" (
    '@echo off' + "`r`n" +
    'if "%1"=="pr" if "%2"=="list" (echo [] & exit /b 0)' + "`r`n" +
    'if "%1"=="pr" if "%2"=="create" (echo warning: a non-fatal notice 1>&2 & echo https://github.com/owner/repo4/pull/424 & echo trailing stderr chatter after success 1>&2 & exit /b 0)' + "`r`n" +
    'exit /b 0' + "`r`n"
  )
  $remoteD = "$testRoot\remoteD.git"; $repoD = "$testRoot\repoD"
  Invoke-Git @('init', '--bare', '-q', $remoteD) | Out-Null
  Invoke-Git @('clone', '-q', $remoteD, $repoD) | Out-Null
  Invoke-Git @('-C', $repoD, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-Git @('-C', $repoD, 'config', 'user.name', 'a') | Out-Null
  Invoke-Git @('-C', $repoD, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-Git @('-C', $repoD, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-Git @('-C', $repoD, 'push', '-q', '-u', 'origin', 'main') | Out-Null
  Invoke-Git @('-C', $repoD, 'checkout', '-q', '-b', 'integration') | Out-Null
  Write-Utf8 "$repoD\release-only.txt" 'release content'
  Invoke-Git @('-C', $repoD, 'add', '-A') | Out-Null
  Invoke-Git @('-C', $repoD, 'commit', '-q', '-m', 'release-only change') | Out-Null
  Invoke-Git @('-C', $repoD, 'push', '-q', '-u', 'origin', 'integration') | Out-Null
  Invoke-Git @('-C', $repoD, 'checkout', '-q', 'main') | Out-Null
  Write-Utf8 "$repoD\main-only.txt" 'main content'
  Invoke-Git @('-C', $repoD, 'add', '-A') | Out-Null
  Invoke-Git @('-C', $repoD, 'commit', '-q', '-m', 'main-only change') | Out-Null
  Invoke-Git @('-C', $repoD, 'push', '-q', 'origin', 'main') | Out-Null
  Write-Utf8 "$testRoot\tenants\d.json" (@{ name = 'd'; repo = $repoD; github = 'owner/repo4'; defaultBranch = 'main'; releaseBranch = 'integration' } | ConvertTo-Json -Compress)

  $env:PATH = "$testRoot\mock-bin-mixed;$oldPath"
  $d1 = Run-Sync @('-Tenant', 'd')
  Assert-True ("$($d1.prUrl)" -eq 'https://github.com/owner/repo4/pull/424') 'the URL must be read from stdout alone, never corrupted by interleaved stderr chatter'
  $env:PATH = "$testRoot\mock-bin;$oldPath"

  # ===== fleet #274: a pure fast-forward the ruleset gates. Scenarios F1-F9 use one gh mock that
  # ===== answers `gh api` from files under $env:MOCK_GH_DIR (an absent file = that call fails, the
  # ===== "unknown" lookup), and a pre-receive hook that logs every push attempt it sees. =====
  $ghDirRoot = Join-Path $testRoot 'gh-ff'
  [IO.Directory]::CreateDirectory("$testRoot\mock-bin-ff") | Out-Null
  Write-Utf8 "$testRoot\mock-bin-ff\gh.cmd" (
    '@echo off' + "`r`n" +
    'if "%1"=="pr" if "%2"=="list" goto :list' + "`r`n" +
    'if "%1"=="pr" if "%2"=="create" goto :create' + "`r`n" +
    'if "%1"=="api" goto :api' + "`r`n" +
    'exit /b 0' + "`r`n" +
    ':list' + "`r`n" +
    'if exist "%MOCK_GH_DIR%\pr-open.json" (type "%MOCK_GH_DIR%\pr-open.json") else (echo [])' + "`r`n" +
    'exit /b 0' + "`r`n" +
    ':create' + "`r`n" +
    'echo %*>> "%MOCK_GH_DIR%\pr-create-calls.log"' + "`r`n" +
    'echo [{"number":501,"url":"https://github.com/owner/repo/pull/501"}]> "%MOCK_GH_DIR%\pr-open.json"' + "`r`n" +
    'echo https://github.com/owner/repo/pull/501' + "`r`n" +
    'exit /b 0' + "`r`n" +
    ':api' + "`r`n" +
    'echo %*>> "%MOCK_GH_DIR%\api-calls.log"' + "`r`n" +
    'echo %* | findstr /c:"/rules/branches/" >nul && set "F=rules.json"' + "`r`n" +
    'echo %* | findstr /c:"/check-runs" >nul && set "F=checkruns.json"' + "`r`n" +
    'echo %* | findstr /c:"/status" >nul && set "F=status.json"' + "`r`n" +
    'if not defined F exit /b 1' + "`r`n" +
    'if not exist "%MOCK_GH_DIR%\%F%" (echo gh: HTTP 500 1>&2 & exit /b 1)' + "`r`n" +
    'type "%MOCK_GH_DIR%\%F%"' + "`r`n" +
    'exit /b 0' + "`r`n"
  )
  function New-FfFixture {
    # A pure fast-forward: `integration` (release) is ahead of `main` (default). The tenant names
    # owner/repo so the mock's PR url matches. $HookStderr, when given, is what the remote's
    # pre-receive says when it refuses; every push attempt it sees appends a line to
    # <dir>\hook-attempts.log.
    param([string]$Name, [string]$HookStderr)
    $dir = Join-Path $ghDirRoot $Name
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $remote = "$testRoot\remote-$Name.git"; $repo = "$testRoot\repo-$Name"
    Invoke-Git @('init', '--bare', '-q', $remote) | Out-Null
    Invoke-Git @('clone', '-q', $remote, $repo) | Out-Null
    Invoke-Git @('-C', $repo, 'config', 'user.email', 'a@b.com') | Out-Null
    Invoke-Git @('-C', $repo, 'config', 'user.name', 'a') | Out-Null
    Invoke-Git @('-C', $repo, 'checkout', '-q', '-b', 'main') | Out-Null
    Invoke-Git @('-C', $repo, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
    Invoke-Git @('-C', $repo, 'push', '-q', '-u', 'origin', 'main') | Out-Null
    Invoke-Git @('-C', $repo, 'checkout', '-q', '-b', 'integration') | Out-Null
    Invoke-Git @('-C', $repo, 'commit', '-q', '--allow-empty', '-m', 'release tip') | Out-Null
    Invoke-Git @('-C', $repo, 'push', '-q', '-u', 'origin', 'integration') | Out-Null
    if ($HookStderr) {
      [IO.Directory]::CreateDirectory("$remote\hooks") | Out-Null
      $logPath = ("$dir\hook-attempts.log").Replace('\', '/')
      Write-Utf8 "$remote\hooks\pre-receive" ("#!/bin/sh`necho attempt >> `"$logPath`"`necho `"remote: error: GH013: Repository rule violations found for refs/heads/main.`" 1>&2`necho `"remote: $HookStderr`" 1>&2`nexit 1`n")
    }
    Write-Utf8 "$testRoot\tenants\$Name.json" (@{ name = $Name; repo = $repo; github = 'owner/repo'; defaultBranch = 'main'; releaseBranch = 'integration' } | ConvertTo-Json -Compress)
    return [pscustomobject]@{ dir = $dir; repo = $repo; sha = (Invoke-Git @('-C', $repo, 'rev-parse', 'integration')).Trim() }
  }
  function Set-MockApi {
    param($Fx, [string]$Rules, [string]$Status, [string]$CheckRuns)
    foreach ($pair in @(@('rules.json', $Rules), @('status.json', $Status), @('checkruns.json', $CheckRuns))) {
      if ($pair[1]) { Write-Utf8 "$($Fx.dir)\$($pair[0])" $pair[1] } else { Remove-Item "$($Fx.dir)\$($pair[0])" -ErrorAction SilentlyContinue }
    }
  }
  $rulesTwo = '[{"type":"deletion"},{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,"required_status_checks":[{"context":"test-build"},{"context":"fleet-review"}]}}]'
  $rulesThree = '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test-build"},{"context":"guards"},{"context":"fleet-review"}]}}]'
  $noRuns = '{"total_count":0,"check_runs":[]}'
  function Get-LineCount { param([string]$Path) if (Test-Path $Path) { @(Get-Content $Path | Where-Object { "$_".Trim() }).Count } else { 0 } }
  $env:PATH = "$testRoot\mock-bin-ff;$oldPath"

  # --- F1 (RED A): the required test-build is pending on the tip. No push is attempted at all;
  # --- the run reports sync-waiting, does not escalate, and exits 0.
  $f1 = New-FfFixture 'f1' 'Required status check "fleet-review" is expected.'
  Set-MockApi $f1 $rulesTwo '{"state":"pending","total_count":1,"statuses":[{"context":"test-build","state":"pending"}]}' $noRuns
  $env:MOCK_GH_DIR = $f1.dir
  $ra = Run-Sync @('-Tenant', 'f1', '-Apply')
  Assert-True ($script:lastExit -eq 0) "a pending required check must exit 0 (got $($script:lastExit): $ra)"
  Assert-True (-not (Test-Path "$($f1.dir)\hook-attempts.log")) 'a pending required check must not attempt the push at all'
  Assert-True ($ra.synced -eq $false -and $ra.kind -eq 'sync-waiting' -and $ra.escalate -eq $false) "a pending required check must report sync-waiting without escalating (got $($ra | ConvertTo-Json -Compress))"
  Assert-True (@($ra.waitingOn) -contains 'test-build') 'the result must name the pending context'
  Assert-True ("$($ra.to)" -and $f1.sha.StartsWith("$($ra.to)")) 'the result must carry the target sha'

  # --- F2 (RED B): the rules and status lookups both fail (unknown); the push is tried, and the
  # --- remote says a check is in progress. Classified by text: sync-waiting, no escalation, exit 0.
  $f2 = New-FfFixture 'f2' 'Required status check "test-build" is in progress.'
  Set-MockApi $f2 $null $null $null
  $env:MOCK_GH_DIR = $f2.dir
  $rb = Run-Sync @('-Tenant', 'f2', '-Apply')
  Assert-True ($script:lastExit -eq 0) "an in-progress refusal must exit 0 (got $($script:lastExit): $rb)"
  Assert-True ((Get-LineCount "$($f2.dir)\hook-attempts.log") -eq 1) 'unknown lookups must still push as today (exactly one attempt)'
  Assert-True ($rb.synced -eq $false -and $rb.kind -eq 'sync-waiting' -and $rb.escalate -eq $false) "an in-progress refusal must classify as sync-waiting (got $($rb | ConvertTo-Json -Compress))"

  # --- F3 (RED C): every required context but fleet-review is green; the push is refused with
  # --- "is expected". One escalation, carrying the PR and the attest command; one PR created.
  $f3 = New-FfFixture 'f3' 'Required status check "fleet-review" is expected.'
  Set-MockApi $f3 $rulesTwo '{"state":"success","total_count":1,"statuses":[{"context":"test-build","state":"success"}]}' $noRuns
  $env:MOCK_GH_DIR = $f3.dir
  $rc = Run-Sync @('-Tenant', 'f3', '-Apply')
  Assert-True ($script:lastExit -eq 2) "an unattested tip must exit 2 (got $($script:lastExit): $rc)"
  Assert-True ($rc.synced -eq $false -and $rc.kind -eq 'sync-unattested' -and $rc.escalate -eq $true) "an is-expected refusal must classify as sync-unattested (got $($rc | ConvertTo-Json -Compress))"
  Assert-True ("$($rc.prUrl)" -eq 'https://github.com/owner/repo/pull/501') 'the escalation must carry the reconciliation PR url'
  Assert-True ("$($rc.reason)" -match ('review-policy\.js attest --tenant f3 --pr 501 --head ' + $f3.sha)) 'the reason must carry the attest command for the PR and the tip sha'
  Assert-True ("$($rc.reason)" -match 'MERGE COMMIT') 'the reason must name the merge-commit alternative'
  Assert-True ((Get-LineCount "$($f3.dir)\hook-attempts.log") -eq 1) 'the first tick pushes once'
  Assert-True ((Get-LineCount "$($f3.dir)\pr-create-calls.log") -eq 1) 'exactly one reconciliation PR is created'
  $memo = Get-Content "$testRoot\state\sentinel\sync-last.json" -Raw | ConvertFrom-Json
  Assert-True ("$($memo.sha)" -eq $f3.sha -and "$($memo.kind)" -eq 'sync-unattested' -and $memo.statusCount -eq 1 -and $memo.checkRunCount -eq 0 -and "$($memo.at)") "the evidence memo must record sha, kind, counts and time (got $($memo | ConvertTo-Json -Compress))"

  # --- F4 (RED D): the same sha with the same counts is not pushed again; same JSON, same PR,
  # --- still one `pr create`.
  $rd = Run-Sync @('-Tenant', 'f3', '-Apply')
  Assert-True ($script:lastExit -eq 2) 'the memoized unattested tip still exits 2'
  Assert-True ((Get-LineCount "$($f3.dir)\hook-attempts.log") -eq 1) 'the same sha and counts must not be pushed again'
  Assert-True (($rd | ConvertTo-Json -Compress) -eq ($rc | ConvertTo-Json -Compress)) "the memoized run must report the same JSON (got $($rd | ConvertTo-Json -Compress))"
  Assert-True ((Get-LineCount "$($f3.dir)\pr-create-calls.log") -eq 1) 'the memoized run must not create a second PR'
  # A new status on the tip (the attestation landing) changes the counts: the push is tried again.
  Set-MockApi $f3 $rulesTwo '{"state":"success","total_count":2,"statuses":[{"context":"test-build","state":"success"},{"context":"fleet-review","state":"success"}]}' $noRuns
  $null = Run-Sync @('-Tenant', 'f3', '-Apply')
  Assert-True ((Get-LineCount "$($f3.dir)\hook-attempts.log") -eq 2) 'a changed status count must push again'

  # --- F5 (RED E): guards failed on the tip: nothing is pushed; sync-blocked escalates, naming it.
  $f5 = New-FfFixture 'f5' 'Required status check "fleet-review" is expected.'
  Set-MockApi $f5 $rulesThree '{"state":"failure","total_count":2,"statuses":[{"context":"test-build","state":"success"},{"context":"guards","state":"failure"}]}' $noRuns
  $env:MOCK_GH_DIR = $f5.dir
  $re = Run-Sync @('-Tenant', 'f5', '-Apply')
  Assert-True ($script:lastExit -eq 2) "a failed required check must exit 2 (got $($script:lastExit): $re)"
  Assert-True (-not (Test-Path "$($f5.dir)\hook-attempts.log")) 'a failed required check must not attempt the push'
  Assert-True ($re.synced -eq $false -and $re.kind -eq 'sync-blocked' -and $re.escalate -eq $true) "a failed required check must report sync-blocked (got $($re | ConvertTo-Json -Compress))"
  Assert-True (@($re.failedChecks) -contains 'guards') 'the result must name the failed context'

  # --- F6: a failing check RUN (not a status) blocks too, a completed-success run counts as green,
  # --- and an ABSENT fleet-review with everything else green still pushes (never pre-refuse on absent).
  $f6 = New-FfFixture 'f6'
  Set-MockApi $f6 $rulesThree '{"state":"success","total_count":1,"statuses":[{"context":"test-build","state":"success"}]}' '{"total_count":1,"check_runs":[{"name":"guards","status":"completed","conclusion":"timed_out"}]}'
  $env:MOCK_GH_DIR = $f6.dir
  $rf = Run-Sync @('-Tenant', 'f6', '-Apply')
  Assert-True ($rf.kind -eq 'sync-blocked' -and @($rf.failedChecks) -contains 'guards') "a timed-out check run must block (got $($rf | ConvertTo-Json -Compress))"
  Set-MockApi $f6 $rulesThree '{"state":"success","total_count":1,"statuses":[{"context":"test-build","state":"success"}]}' '{"total_count":1,"check_runs":[{"name":"guards","status":"completed","conclusion":"success"}]}'
  $rg = Run-Sync @('-Tenant', 'f6', '-Apply')
  Assert-True ($script:lastExit -eq 0 -and $rg.synced -eq $true) "an absent fleet-review with the rest green must still push (got $($rg | ConvertTo-Json -Compress))"

  # --- F7: a refusal that is neither pending nor expected stays sync-refused (high, unchanged).
  $f7 = New-FfFixture 'f7' 'Cannot update this protected ref.'
  Set-MockApi $f7 $null $null $null
  $env:MOCK_GH_DIR = $f7.dir
  $rh = Run-Sync @('-Tenant', 'f7', '-Apply')
  Assert-True ($script:lastExit -eq 2 -and $rh.kind -eq 'sync-refused' -and $rh.escalate -eq $true -and "$($rh.pushError)" -match 'protected ref') "an unexplained refusal must stay sync-refused (got $($rh | ConvertTo-Json -Compress))"
  # F8/F9: a bare "have not succeeded" naming only an expected check is unattested, not waiting;
  # one that also names checks in progress waits (the pending check decides the next tick).
  $f8 = New-FfFixture 'f8' '1 of 7 required status checks have not succeeded: fleet-review is expected.'
  Set-MockApi $f8 $null $null $null
  $env:MOCK_GH_DIR = $f8.dir
  $ri = Run-Sync @('-Tenant', 'f8', '-Apply')
  Assert-True ($ri.kind -eq 'sync-unattested') "a have-not-succeeded refusal naming only an expected check is unattested (got $($ri | ConvertTo-Json -Compress))"
  $f9 = New-FfFixture 'f9' '3 of 7 required status checks have not succeeded: 2 are in progress and 1 is expected.'
  Set-MockApi $f9 $null $null $null
  $env:MOCK_GH_DIR = $f9.dir
  $rj = Run-Sync @('-Tenant', 'f9', '-Apply')
  Assert-True ($rj.kind -eq 'sync-waiting' -and $rj.escalate -eq $false -and $script:lastExit -eq 0) "a refusal with checks in progress waits (got $($rj | ConvertTo-Json -Compress))"
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  Remove-Item Env:MOCK_GH_DIR -ErrorAction SilentlyContinue

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
