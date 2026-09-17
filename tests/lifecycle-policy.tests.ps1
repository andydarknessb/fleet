$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Match { param([string]$Text, [string]$Pattern, [string]$Message) if ($Text -notmatch $Pattern) { throw $Message } }

$root = Split-Path -Parent $PSScriptRoot
$ic = Get-Content "$root\agents\ic.md" -Raw -Encoding UTF8
$sentinel = Get-Content "$root\bin\sentinel-check.ps1" -Raw -Encoding UTF8
$retire = Get-Content "$root\bin\retire.ps1" -Raw -Encoding UTF8

Assert-Match $ic 'Closes #n.*only when.*every issue criterion' 'IC closing keywords must be conditional on complete issue satisfaction'
Assert-Match $ic 'otherwise use `Refs #n`' 'IC instructions must provide the non-closing reference path'

# The Sentinel role file (agents/sentinel.md) that once stated the open-PR stale-heartbeat
# exemption in prose was retired by ticket 89 (after one release); the exemption is a
# mechanical property of bin/sentinel-check.ps1, asserted below, and no longer duplicated
# in a role file the Watchdog does not read.
Assert-Match $sentinel 'gh pr list.*--state open.*head:' 'Sentinel must query open PRs by the issue branch prefix'
Assert-Match $sentinel 'skip\.issues' 'Sentinel must honor issue holds before stale-heartbeat respawn'
Assert-Match $sentinel 'skip\.prs' 'Sentinel must annotate PR holds before stale-heartbeat respawn'
Assert-Match $sentinel 'pr-lookup-failed' 'Sentinel must fail safe when the PR lookup fails'
Assert-Match $sentinel 'state=\$state status=\$\(\$row\.status\), no open PR' 'Stale-heartbeat reasons must report measured state and status'

$reread = $sentinel.IndexOf('$current = Get-LiveRoster')
$respawn = $sentinel.IndexOf('claude respawn')
Assert-True ($reread -ge 0 -and $respawn -gt $reread) 'Sentinel must re-read the live roster before an IC respawn'

$retiring = $retire.IndexOf("`$e.status = 'retiring'")
$stop = $retire.IndexOf('claude stop')
Assert-True ($retiring -ge 0 -and $stop -gt $retiring) 'Retirement must publish the retiring marker before stopping the job'
Assert-Match $retire 'worktreesRemaining' 'Retirement output must report still-registered owned worktrees'
Assert-Match $retire "worktreeCleanup = if .*'none-owned'.*'removed'.*'remaining'" 'Retirement output must distinguish no worktree, removed worktree, and remaining worktree'
Assert-Match $retire 'Get-DaemonSessions -All -Strict' 'Owned-worktree removal must depend on a daemon read that fails CLOSED (-Strict), never a tolerant read that reads a failure as "the job is gone"'

# --- behavioral case (review finding 11/12): a real retire.ps1 run, not just source text.
# --- Success: the daemon list is readable and shows the job gone -> the worktree is
# --- actually unregistered and the JSON says removed. Failure: the daemon list itself
# --- is unreadable -> the worktree must survive and the JSON must say so, never guess. ---
function Assert-TrueB { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8B { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Invoke-GitB {
  param([string[]]$GitArgs)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & git @GitArgs 2>&1 | Out-String } finally { $ErrorActionPreference = $eap }
}
$retireTestRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-retire-test-" + [guid]::NewGuid().ToString('N'))
try {
  foreach ($dir in 'bin', 'state', 'state/heartbeats', 'mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $retireTestRoot $dir)) | Out-Null
  }
  [IO.File]::Copy("$root\bin\_common.ps1", "$retireTestRoot\bin\_common.ps1")
  [IO.File]::Copy("$root\bin\retire.ps1", "$retireTestRoot\bin\retire.ps1")

  $hub = "$retireTestRoot\hub"; $remote = "$retireTestRoot\remote.git"
  Invoke-GitB @('init', '--bare', '-q', $remote) | Out-Null
  Invoke-GitB @('clone', '-q', $remote, $hub) | Out-Null
  Invoke-GitB @('-C', $hub, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-GitB @('-C', $hub, 'config', 'user.name', 'a') | Out-Null
  Invoke-GitB @('-C', $hub, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-GitB @('-C', $hub, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-GitB @('-C', $hub, 'push', '-q', '-u', 'origin', 'main') | Out-Null
  Invoke-GitB @('-C', $hub, 'branch', 'ic-900-fix', 'main') | Out-Null
  $ownedWt = "$hub\.claude\worktrees\ic-900-fix"
  Invoke-GitB @('-C', $hub, 'worktree', 'add', '-q', $ownedWt, 'ic-900-fix') | Out-Null

  Write-Utf8B "$retireTestRoot\state\roster.json" (@{ sessions = @(@{ name = 'ic-900'; role = 'ic'; tenant = 'test'; issue = 900; cwd = $hub; status = 'active'; jobId = 'job-900' }) } | ConvertTo-Json -Depth 6)
  Write-Utf8B "$retireTestRoot\mock-bin\claude.cmd" (
    '@echo off' + "`r`n" +
    'if "%1"=="stop" exit /b 0' + "`r`n" +
    'if "%1"=="rm" exit /b 0' + "`r`n" +
    'if "%1"=="agents" (if "%MOCK_AGENTS_FAIL%"=="1" (exit /b 9) else (echo [])) ' + "`r`n" +
    'exit /b 0' + "`r`n"
  )
  $oldPathB = $env:PATH
  $env:PATH = "$retireTestRoot\mock-bin;$oldPathB"

  # Case: daemon list readable, job confirmed gone -> the worktree is really removed.
  $eapB = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $outB = & powershell -NoProfile -ExecutionPolicy Bypass -File "$retireTestRoot\bin\retire.ps1" -Name 'ic-900' -Reason 'done' 2>&1 | Out-String
  $ErrorActionPreference = $eapB
  $resultB = ($outB.Trim() -split "`n")[-1] | ConvertFrom-Json
  Assert-TrueB (-not (Test-Path $ownedWt)) 'a successful retire with a readable, empty daemon list must actually unregister the owned worktree'
  Assert-TrueB ($resultB.worktreeCleanup -eq 'removed') 'the JSON must report worktreeCleanup removed'
  Assert-TrueB ($resultB.jobRemoval -eq 'removed') 'the JSON must report jobRemoval removed'

  # Case: daemon list unreadable -> nothing is touched, and the JSON says so.
  Invoke-GitB @('-C', $hub, 'branch', 'ic-901-fix', 'main') | Out-Null
  $ownedWt2 = "$hub\.claude\worktrees\ic-901-fix"
  Invoke-GitB @('-C', $hub, 'worktree', 'add', '-q', $ownedWt2, 'ic-901-fix') | Out-Null
  Write-Utf8B "$retireTestRoot\state\roster.json" (@{ sessions = @(@{ name = 'ic-901'; role = 'ic'; tenant = 'test'; issue = 901; cwd = $hub; status = 'active'; jobId = 'job-901' }) } | ConvertTo-Json -Depth 6)
  $env:MOCK_AGENTS_FAIL = '1'
  $eapB2 = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $outB2 = & powershell -NoProfile -ExecutionPolicy Bypass -File "$retireTestRoot\bin\retire.ps1" -Name 'ic-901' -Reason 'done' 2>&1 | Out-String
  $ErrorActionPreference = $eapB2
  Remove-Item Env:MOCK_AGENTS_FAIL -ErrorAction SilentlyContinue
  $resultB2 = ($outB2.Trim() -split "`n")[-1] | ConvertFrom-Json
  Assert-TrueB (Test-Path $ownedWt2) 'an unreadable daemon list must leave the owned worktree untouched, not force-remove it'
  Assert-TrueB ($resultB2.worktreeCleanup -eq 'remaining') 'the JSON must report worktreeCleanup remaining when the daemon list could not be read'
  Assert-TrueB ($resultB2.jobRemoval -eq 'unknown') 'the JSON must report jobRemoval unknown, never guess removed or still-present'

  $env:PATH = $oldPathB
} finally {
  $resolvedB = [IO.Path]::GetFullPath($retireTestRoot)
  $expectedPrefixB = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-retire-test-'
  if ($resolvedB.StartsWith($expectedPrefixB, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolvedB)) {
    try { Get-ChildItem -LiteralPath $resolvedB -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Attributes = 'Normal' } catch {} } } catch {}
    try { [IO.Directory]::Delete($resolvedB, $true) } catch { try { Remove-Item -LiteralPath $resolvedB -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
  }
}

$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile("$root\bin\sentinel-check.ps1", [ref]$tokens, [ref]$errors) | Out-Null
[System.Management.Automation.Language.Parser]::ParseFile("$root\bin\retire.ps1", [ref]$tokens, [ref]$errors) | Out-Null
Assert-True ($errors.Count -eq 0) "fleet lifecycle scripts must parse: $($errors.Message -join '; ')"

Write-Output 'lifecycle policy tests passed'
