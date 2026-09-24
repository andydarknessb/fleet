<#
.SYNOPSIS  #113 (ADR 0013): advance the live checkout's `live` ref to a green master.
  The checkout the fleet executes from (C:\Users\Cory\fleet) sits on a `live` branch.
  One run, normally from the Watchdog after its dead-man ping:
    1. state/flags/deploy-hold present      -> held (nothing moves)
    2. the checkout is on `live`, with no tracked change (untracked files and the
       gitignored state/ never block a fast-forward)
    3. git fetch origin
    4. origin/master's head equals live      -> current
       live is not an ancestor of the head   -> refused:diverged (never a non-ff)
    5. the `fleet-ci` check run on that head (gh api .../commits/<sha>/check-runs):
       none or not completed -> master-pending; completed and not success -> master-red
    6. green -> git merge --ff-only origin/master -> advanced
  Prints one JSON line: {from, to, outcome, detail, at}. Outcomes: advanced, current,
  held, master-red, master-pending, refused:<reason>. It never moves `live` backwards
  and never does a non-fast-forward. Rollback is Cory's hand (README): reset `live`
  to the good commit AND set deploy-hold, or the next green tick moves it forward again.
  Exit 0 whatever the outcome; the outcome is the answer.
#>
[CmdletBinding()]
param(
  [string]$FleetHome = '',
  [string]$Remote = 'origin',
  [string]$Branch = 'master',
  [string]$LiveRef = 'live',
  [string]$CheckName = 'fleet-ci',
  [string]$Repo = '',        # owner/name on GitHub; derived from the remote URL when empty
  [string]$GhExe = 'gh'
)
$ErrorActionPreference = 'Continue'
if (-not $FleetHome) { $FleetHome = Split-Path -Parent $PSScriptRoot }

$result = [ordered]@{ from = $null; to = $null; outcome = $null; detail = $null; at = (Get-Date).ToUniversalTime().ToString('o') }
function Finish { param([string]$Outcome, [string]$Detail = $null)
  $result.outcome = $Outcome
  if ($Detail) { $result.detail = (($Detail -replace '\s+', ' ').Trim()) }
  if ($result.detail -and $result.detail.Length -gt 300) { $result.detail = $result.detail.Substring(0, 300) }
  Write-Output ([pscustomobject]$result | ConvertTo-Json -Compress)
  exit 0
}
function Invoke-Git {
  $output = & git -C $FleetHome @args 2>&1
  $script:gitExit = $LASTEXITCODE
  return (@($output | ForEach-Object { "$_" }) -join "`n").Trim()
}

if (-not (Test-Path (Join-Path $FleetHome '.git'))) { Finish 'refused:not-a-checkout' "$FleetHome is not a git checkout" }
$result.from = Invoke-Git rev-parse HEAD
if ($script:gitExit -ne 0) { $why = $result.from; $result.from = $null; Finish 'refused:not-a-checkout' $why }

if (Test-Path (Join-Path $FleetHome 'state\flags\deploy-hold')) { Finish 'held' 'state/flags/deploy-hold is set' }

$branchName = Invoke-Git symbolic-ref --quiet --short HEAD
if ($script:gitExit -ne 0 -or $branchName -ne $LiveRef) {
  $on = if ($branchName) { $branchName } else { 'a detached HEAD' }
  Finish 'refused:not-on-live' "the live checkout is on $on, not $LiveRef; cutover: git -C $FleetHome switch -c $LiveRef $Remote/$Branch"
}
$dirty = Invoke-Git status --porcelain --untracked-files=no
if ($script:gitExit -ne 0) { Finish 'refused:status-failed' $dirty }
if ($dirty) { Finish 'refused:dirty' "tracked changes in the live checkout: $(($dirty -split "`n" | Select-Object -First 5) -join '; ')" }

$fetch = Invoke-Git fetch --quiet $Remote $Branch
if ($script:gitExit -ne 0) { Finish 'refused:fetch-failed' $fetch }
$head = Invoke-Git rev-parse "$Remote/$Branch"
if ($script:gitExit -ne 0) { Finish 'refused:fetch-failed' $head }
$result.to = $head
if ($head -eq $result.from) { Finish 'current' }
$null = Invoke-Git merge-base --is-ancestor HEAD "$Remote/$Branch"
if ($script:gitExit -ne 0) { Finish 'refused:diverged' "$LiveRef ($($result.from)) is not an ancestor of $Remote/$Branch ($head); a non-fast-forward is Cory's call" }

if (-not $Repo) {
  $url = Invoke-Git remote get-url $Remote
  if ($url -match 'github\.com[:/]+([^/]+)/([^/\s]+?)(?:\.git)?$') { $Repo = "$($Matches[1])/$($Matches[2])" }
  else { Finish 'refused:ci-unreadable' "cannot derive the GitHub repo from $Remote ($url); pass -Repo owner/name" }
}
$checkJson = & $GhExe api -X GET "repos/$Repo/commits/$head/check-runs" -f "check_name=$CheckName" -f per_page=20 2>&1
$ghExit = $LASTEXITCODE
$checkText = (@($checkJson | ForEach-Object { "$_" }) -join "`n").Trim()
if ($ghExit -ne 0) { Finish 'refused:ci-unreadable' "gh api exited ${ghExit}: $checkText" }
$runs = $null
try { $runs = @(($checkText | ConvertFrom-Json).check_runs | Where-Object { $_.name -eq $CheckName }) } catch { Finish 'refused:ci-unreadable' "check-runs is not JSON: $checkText" }
if ($runs.Count -eq 0) { Finish 'master-pending' "no $CheckName check run on $head yet" }
# The newest run decides (a re-run supersedes a failure).
$latest = $runs | Sort-Object { [long]$_.id } | Select-Object -Last 1
if ("$($latest.status)" -ne 'completed') { Finish 'master-pending' "$CheckName is $($latest.status) on $head" }
if ("$($latest.conclusion)" -ne 'success') { Finish 'master-red' "$CheckName concluded $($latest.conclusion) on $head" }

$merge = Invoke-Git merge --ff-only --quiet "$Remote/$Branch"
if ($script:gitExit -ne 0) { Finish 'refused:merge-failed' $merge }
$now = Invoke-Git rev-parse HEAD
if ($now -ne $head) { Finish 'refused:merge-failed' "HEAD is $now after the merge, expected $head" }
Finish 'advanced' "$LiveRef fast-forwarded to $head ($CheckName green)"
