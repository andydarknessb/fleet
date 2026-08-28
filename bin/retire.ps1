# Mark a fleet session retired and stop it. Used by project leads after merge, and by the Sentinel.
param([Parameter(Mandatory)][string]$Name, [string]$Reason = 'done')
. "$PSScriptRoot\_common.ps1"
$live = Get-LiveRoster
$e = $live.sessions | Where-Object { $_.name -eq $Name }
if (-not $e) { Write-Error "no live roster entry named '$Name'"; exit 4 }

function Get-OwnedWorktrees {
  if (-not $e.cwd -or -not (Test-Path $e.cwd)) { return @() }
  $blocks = ((& git -C $e.cwd worktree list --porcelain 2>$null | Out-String) -replace "`r", '') -split "`n`n"
  $owned = @()
  foreach ($blk in $blocks) {
    if ($blk -notmatch 'worktree (.+)') { continue }
    $path = $Matches[1].Trim()
    if ($path -notmatch "[\\/]\.claude[\\/]worktrees[\\/]$([regex]::Escape($Name))(-|$)") { continue }
    $br = $null
    if ($blk -match 'branch refs/heads/(.+)') { $br = $Matches[1].Trim() }
    $owned += [pscustomobject]@{ path = $path; branch = $br }
  }
  return @($owned)
}

# Close the active -> stopped race before touching the daemon. A Sentinel check
# that already snapshotted this IC re-reads the live roster immediately before
# respawning and observes this marker.
$e.status = 'retiring'
$e | Add-Member -NotePropertyName retiringAt -NotePropertyValue (Now-Iso) -Force
$e | Add-Member -NotePropertyName retiredBecause -NotePropertyValue $Reason -Force
Save-LiveRoster $live

$ownedBefore = @(Get-OwnedWorktrees)
$stillThere = $false
if ($e.jobId) {
  & claude stop $e.jobId 2>$null | Out-Null
  & claude rm $e.jobId 2>$null | Out-Null
  # claude rm refuses when the session's worktree has uncommitted changes. A retired IC's leftovers are
  # disposable (its work is in the PR), so force-remove any worktree it owns, then rm again.
  $stillThere = @(Get-DaemonSessions -All | Where-Object { $_.id -eq $e.jobId }).Count -gt 0
  if ($stillThere -and $e.cwd -and (Test-Path $e.cwd)) {
    foreach ($wt in @(Get-OwnedWorktrees)) {
      & git -C $e.cwd worktree unlock $wt.path 2>$null | Out-Null
      & git -C $e.cwd worktree remove --force --force $wt.path 2>$null | Out-Null
      $br = $wt.branch
      if ($br -and $br -like 'worktree-*') { & git -C $e.cwd branch -D $br 2>$null | Out-Null }
    }
    & git -C $e.cwd worktree prune 2>$null | Out-Null
    & claude rm $e.jobId 2>$null | Out-Null
    $stillThere = @(Get-DaemonSessions -All | Where-Object { $_.id -eq $e.jobId }).Count -gt 0
  }
  if ($stillThere) { Write-Warning "job $($e.jobId) still exists after claude rm; inspect with: claude agents --json --all" }
}
$e.status = 'retired'
$e | Add-Member -NotePropertyName retiredAt -NotePropertyValue (Now-Iso) -Force
Save-LiveRoster $live
Remove-Item "$FleetHome\state\heartbeats\$Name.json" -ErrorAction SilentlyContinue
$ownedAfter = @(Get-OwnedWorktrees)
$afterPaths = @($ownedAfter | ForEach-Object { $_.path })
$removedWorktrees = @($ownedBefore | Where-Object { $afterPaths -notcontains $_.path } | ForEach-Object { $_.path })
$remainingWorktrees = @($ownedAfter | ForEach-Object { $_.path })
$worktreeCleanup = if ($ownedBefore.Count -eq 0 -and $ownedAfter.Count -eq 0) { 'none-owned' } elseif ($ownedAfter.Count -eq 0) { 'removed' } else { 'remaining' }
$jobRemoval = if (-not $e.jobId) { 'no-job-recorded' } elseif ($stillThere) { 'still-present' } else { 'removed' }
Write-Output (@{
  retired = $Name
  reason = $Reason
  jobRemoval = $jobRemoval
  worktreeCleanup = $worktreeCleanup
  worktreesRemoved = $removedWorktrees
  worktreesRemaining = $remainingWorktrees
} | ConvertTo-Json -Compress)
