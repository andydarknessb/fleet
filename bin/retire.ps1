# Mark a fleet session retired and stop it. Used by project leads after merge, and by the Sentinel.
param([Parameter(Mandatory)][string]$Name, [string]$Reason = 'done')
. "$PSScriptRoot\_common.ps1"
$live = Get-LiveRoster
$e = $live.sessions | Where-Object { $_.name -eq $Name }
if (-not $e) { Write-Error "no live roster entry named '$Name'"; exit 4 }
$removedWorktrees = @()
if ($e.jobId) {
  & claude stop $e.jobId 2>$null | Out-Null
  & claude rm $e.jobId 2>$null | Out-Null
  # claude rm refuses when the session's worktree has uncommitted changes. A retired IC's leftovers are
  # disposable (its work is in the PR), so force-remove any worktree it owns, then rm again.
  $stillThere = @(Get-DaemonSessions -All | Where-Object { $_.id -eq $e.jobId }).Count -gt 0
  if ($stillThere -and $e.cwd -and (Test-Path $e.cwd)) {
    $blocks = ((& git -C $e.cwd worktree list --porcelain 2>$null | Out-String) -replace "`r", '') -split "`n`n"
    foreach ($blk in $blocks) {
      if ($blk -notmatch 'worktree (.+)') { continue }
      $path = $Matches[1].Trim()
      if ($path -notmatch "[\\/]\.claude[\\/]worktrees[\\/]$([regex]::Escape($Name))(-|$)") { continue }
      $br = $null; if ($blk -match 'branch refs/heads/(.+)') { $br = $Matches[1].Trim() }
      & git -C $e.cwd worktree unlock $path 2>$null | Out-Null
      & git -C $e.cwd worktree remove --force --force $path 2>$null | Out-Null
      if ($br -and $br -like 'worktree-*') { & git -C $e.cwd branch -D $br 2>$null | Out-Null }
      $removedWorktrees += $path
    }
    & git -C $e.cwd worktree prune 2>$null | Out-Null
    & claude rm $e.jobId 2>$null | Out-Null
    $stillThere = @(Get-DaemonSessions -All | Where-Object { $_.id -eq $e.jobId }).Count -gt 0
  }
  if ($stillThere) { Write-Warning "job $($e.jobId) still exists after claude rm; inspect with: claude agents --json --all" }
}
$e.status = 'retired'
$e | Add-Member -NotePropertyName retiredAt -NotePropertyValue (Now-Iso) -Force
$e | Add-Member -NotePropertyName retiredBecause -NotePropertyValue $Reason -Force
Save-LiveRoster $live
Remove-Item "$FleetHome\state\heartbeats\$Name.json" -ErrorAction SilentlyContinue
Write-Output (@{ retired = $Name; reason = $Reason; jobRemoved = (-not $stillThere); worktreesRemoved = $removedWorktrees } | ConvertTo-Json -Compress)
