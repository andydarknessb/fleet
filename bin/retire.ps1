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

# git's record of a removed worktree goes, but on Windows its directory can survive
# empty (a handle the stopped job still held), and launch.ps1 then refuses a relaunch of
# the same issue: "assignment worktree already exists" (fleet #171). The main checkout
# is where .claude/worktrees lives; a manifest IC's cwd is the worktree under it.
$repoRoot = $null
if ($e.cwd) { $repoRoot = if ("$($e.cwd)" -match '^(.+?)[\\/]\.claude[\\/]worktrees[\\/]') { $Matches[1] } else { "$($e.cwd)" } }
function Remove-EmptyOwnedWorktreeDirs {
  param([string[]]$RegisteredPaths)
  $result = [pscustomobject]@{ removed = @(); remaining = @() }
  if (-not $repoRoot) { return $result }
  $worktreesDir = Join-Path $repoRoot '.claude\worktrees'
  if (-not (Test-Path -LiteralPath $worktreesDir -PathType Container)) { return $result }
  $registered = @($RegisteredPaths | ForEach-Object { "$_".Replace('\', '/').TrimEnd('/').ToLowerInvariant() })
  foreach ($dir in @(Get-ChildItem -LiteralPath $worktreesDir -Directory -Force -ErrorAction SilentlyContinue)) {
    if ($dir.Name -notmatch "^$([regex]::Escape($Name))(-|$)") { continue }
    if ($registered -contains $dir.FullName.Replace('\', '/').TrimEnd('/').ToLowerInvariant()) { continue }
    # Empty only: a directory with content git no longer tracks is reported, never deleted.
    $gone = $false
    for ($attempt = 0; $attempt -lt 5 -and -not $gone; $attempt++) {
      if (@(Get-ChildItem -LiteralPath $dir.FullName -Force -ErrorAction SilentlyContinue).Count -gt 0) { break }
      try { [IO.Directory]::Delete($dir.FullName, $false); $gone = $true } catch { Start-Sleep -Milliseconds 500 }
    }
    if ($gone) { $result.removed += $dir.FullName } else { $result.remaining += $dir.FullName }
  }
  return $result
}

$ownedBefore = @(Get-OwnedWorktrees)
$stillThere = $false
$daemonListOk = $true
# fleet #265: resolve the claude CLI before touching the job. The CLI is briefly absent while
# its own npm auto-update reinstalls it (about twice an hour); Resolve-ClaudeCli waits that out.
# When it is still missing the roster side below still completes (a retired row releases the
# Work record's claim) but the job and its worktrees are left for the Sentinel's cleanup-pending
# pass: a live job may be writing in that directory, and nothing here could tell.
$cliMissing = $false
$cliError = $null
if ($e.jobId) {
  try { $null = Resolve-ClaudeCli } catch { $cliMissing = $true; $cliError = "$($_.Exception.Message)" }
}
$script:quietThrew = $null
function Invoke-ClaudeQuiet {
  # stop/rm: a nonzero exit is routine (rm refuses a dirty worktree) and the daemon list below
  # is what decides. A throw means the resolver lost the CLI mid-run (an npm reinstall between
  # two calls): that is the cli-missing path, not "unknown", so it is recorded for the caller
  # and $null comes back. Otherwise returns whether the call failed outright.
  param([string[]]$Arguments)
  try {
    $r = Invoke-ClaudeCli -Arguments $Arguments
    return [pscustomobject]@{ failed = [bool]($r.startError -or $r.timedOut -or $r.exitCode -ne 0) }
  } catch {
    if (-not $script:quietThrew) { $script:quietThrew = "claude $($Arguments -join ' ') did not run: $($_.Exception.Message)" }
    return $null
  }
}
$stopFailed = $false; $rmFailed = $false
if ($e.jobId -and $cliMissing) {
  Write-Warning "claude CLI missing; job $($e.jobId) left for the Sentinel's cleanup-pending pass: $cliError"
} elseif ($e.jobId) {
  $stopRun = Invoke-ClaudeQuiet @('stop', "$($e.jobId)")
  $rmRun = Invoke-ClaudeQuiet @('rm', "$($e.jobId)")
  $stopFailed = ($null -eq $stopRun) -or $stopRun.failed
  $rmFailed = ($null -eq $rmRun) -or $rmRun.failed
  if ($script:quietThrew) { $cliMissing = $true; $cliError = $script:quietThrew }
}
if ($e.jobId -and -not $cliMissing) {
  # claude rm refuses when the session's worktree has uncommitted changes, and when it succeeds it
  # still leaves a clean worktree registered. A retired IC's leftovers are disposable (its work is in
  # the PR), so force-remove any worktree it owns whether or not the job went, then rm again if needed.
  # -Strict, not the tolerant default: an unreadable daemon list must never look like "the job is
  # gone" - that reading force-removed a live, still-writing session's worktree (review finding 11).
  try { $stillThere = @(Get-DaemonSessions -All -Strict | Where-Object { $_.id -eq $e.jobId }).Count -gt 0 }
  catch { $daemonListOk = $false }
  if ($daemonListOk -and $e.cwd -and (Test-Path $e.cwd)) {
    foreach ($wt in @(Get-OwnedWorktrees)) {
      & git -C $e.cwd worktree unlock $wt.path 2>$null | Out-Null
      & git -C $e.cwd worktree remove --force --force $wt.path 2>$null | Out-Null
      $br = $wt.branch
      if ($br -and $br -like 'worktree-*') { & git -C $e.cwd branch -D $br 2>$null | Out-Null }
    }
    & git -C $e.cwd worktree prune 2>$null | Out-Null
    if ($stillThere) {
      $null = Invoke-ClaudeQuiet @('rm', "$($e.jobId)")
      if ($script:quietThrew) { $cliMissing = $true; $cliError = $script:quietThrew }
      try { $stillThere = @(Get-DaemonSessions -All -Strict | Where-Object { $_.id -eq $e.jobId }).Count -gt 0 }
      catch { $daemonListOk = $false }
    }
  }
  if (-not $daemonListOk -and $stopFailed -and $rmFailed) {
    # stop, rm and the strict list ALL failed: whatever resolved is not a working CLI (a broken install). That is a
    # missing CLI for this purpose, not a job of unknown state to report as retired with exit 0.
    $cliMissing = $true
    $cliError = "claude stop, claude rm and the daemon session list all failed through $($script:ClaudeCli)"
  }
  elseif (-not $daemonListOk) { Write-Warning "daemon session list unreadable for job $($e.jobId); worktree cleanup skipped rather than guessed" }
  elseif ($stillThere) { Write-Warning "job $($e.jobId) still exists after claude rm; inspect with: claude agents --json --all" }
}
if ($cliMissing -and -not $script:ClaudeCliMissing) { $script:ClaudeCliMissing = [pscustomobject]@{ tried = @("$($script:ClaudeCli)"); waitedSec = 0 } }
$e.status = 'retired'
$e | Add-Member -NotePropertyName retiredAt -NotePropertyValue (Now-Iso) -Force
if ($cliMissing) {
  $e | Add-Member -NotePropertyName jobRemoval -NotePropertyValue 'cli-missing' -Force
  $e | Add-Member -NotePropertyName cleanupPending -NotePropertyValue $true -Force
}
# A retired entry's prompt has no reader (recovery replays active ICs only); archive the full row, then drop it so the roster stays small.
# Strip only after the archive append succeeded; a re-retire (prompt already gone) appends nothing.
if ($e.PSObject.Properties['prompt']) {
  try {
    [IO.Directory]::CreateDirectory("$FleetHome\state\archive") | Out-Null
    [IO.File]::AppendAllText("$FleetHome\state\archive\roster-retired-full.jsonl", (($e | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine), $Utf8)
    $e.PSObject.Properties.Remove('prompt')
  } catch { Write-Warning "prompt archive failed ($_); prompt kept on the roster row" }
}
Save-LiveRoster $live
Remove-Item "$FleetHome\state\heartbeats\$Name.json" -ErrorAction SilentlyContinue
$ownedAfter = @(Get-OwnedWorktrees)
$afterPaths = @($ownedAfter | ForEach-Object { $_.path })
$removedWorktrees = @($ownedBefore | Where-Object { $afterPaths -notcontains $_.path } | ForEach-Object { $_.path })
$remainingWorktrees = @($ownedAfter | ForEach-Object { $_.path })
$worktreeCleanup = if ($ownedBefore.Count -eq 0 -and $ownedAfter.Count -eq 0) { 'none-owned' } elseif ($ownedAfter.Count -eq 0) { 'removed' } else { 'remaining' }
# Only once the job is confirmed gone (or none was recorded): a live job may still be in the directory.
$dirSweep = [pscustomobject]@{ removed = @(); remaining = @() }
if (-not $e.jobId -or (-not $cliMissing -and $daemonListOk -and -not $stillThere)) { $dirSweep = Remove-EmptyOwnedWorktreeDirs -RegisteredPaths $remainingWorktrees }
$jobRemoval = if (-not $e.jobId) { 'no-job-recorded' } elseif ($cliMissing) { 'cli-missing' } elseif (-not $daemonListOk) { 'unknown' } elseif ($stillThere) { 'still-present' } else { 'removed' }
if ($cliMissing) {
  # One line per job the Sentinel's cleanup-pending pass must stop/rm (and whose worktrees it
  # may remove once clean) when the CLI is back. The script still reports retired:<name>.
  $pendingLine = [ordered]@{ at = (Now-Iso); name = $Name; jobId = "$($e.jobId)"; cwd = $e.cwd; worktrees = @($remainingWorktrees); reason = 'claude-cli-missing'; tried = @($script:ClaudeCliMissing.tried); attempts = 0 }
  [IO.Directory]::CreateDirectory("$FleetHome\state\sentinel") | Out-Null
  [IO.File]::AppendAllText("$FleetHome\state\sentinel\cleanup-pending.jsonl", (($pendingLine | ConvertTo-Json -Compress -Depth 6) + [Environment]::NewLine), $Utf8)
}
Write-Output (@{
  retired = $Name
  reason = $Reason
  jobRemoval = $jobRemoval
  worktreeCleanup = $worktreeCleanup
  worktreesRemoved = $removedWorktrees
  worktreesRemaining = $remainingWorktrees
  worktreeDirsRemoved = @($dirSweep.removed)
  worktreeDirsRemaining = @($dirSweep.remaining)
  cleanupPending = [bool]$cliMissing
} | ConvertTo-Json -Compress)
# claude/git above leave their last exit code in $LASTEXITCODE, and a nonzero code on
# a successful retire is expected (claude rm refuses dirty worktrees). Callers read
# success from the JSON `retired` field; the exit code is 0, or 6 when the roster side
# completed but the claude CLI was missing (fleet #265: cleanupPending:true, job untouched).
if ($cliMissing) { exit 6 }
exit 0
