$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Match { param([string]$Text, [string]$Pattern, [string]$Message) if ($Text -notmatch $Pattern) { throw $Message } }

$root = Split-Path -Parent $PSScriptRoot
$ic = Get-Content "$root\agents\ic.md" -Raw -Encoding UTF8
$sentinelRole = Get-Content "$root\agents\sentinel.md" -Raw -Encoding UTF8
$sentinel = Get-Content "$root\bin\sentinel-check.ps1" -Raw -Encoding UTF8
$retire = Get-Content "$root\bin\retire.ps1" -Raw -Encoding UTF8

Assert-Match $ic 'Closes #n.*only when.*every issue criterion' 'IC closing keywords must be conditional on complete issue satisfaction'
Assert-Match $ic 'otherwise use `Refs #n`' 'IC instructions must provide the non-closing reference path'

Assert-Match $sentinelRole 'open PR.*never respawned for a stale heartbeat' 'Sentinel role must state the open-PR stale-heartbeat exemption'
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
Assert-True ($retire -notmatch 'if \(\$stillThere -and [^\r\n]*\r?\n\s*foreach \(\$wt in') 'Owned-worktree removal must not depend on claude rm failing (a clean worktree survives a successful rm)'
Assert-Match $retire 'worktreesRemaining' 'Retirement output must report still-registered owned worktrees'
Assert-Match $retire "worktreeCleanup = if .*'none-owned'.*'removed'.*'remaining'" 'Retirement output must distinguish no worktree, removed worktree, and remaining worktree'

$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile("$root\bin\sentinel-check.ps1", [ref]$tokens, [ref]$errors) | Out-Null
[System.Management.Automation.Language.Parser]::ParseFile("$root\bin\retire.ps1", [ref]$tokens, [ref]$errors) | Out-Null
Assert-True ($errors.Count -eq 0) "fleet lifecycle scripts must parse: $($errors.Message -join '; ')"

Write-Output 'lifecycle policy tests passed'
