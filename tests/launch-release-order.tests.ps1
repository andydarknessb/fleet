# fleet#251: launch.ps1's ordering around the manifest release, pinned against its source.
#
# 1. The roster row is written by `Save-LiveRoster $live` after the session exists. Every
#    Invalidate-Manifest call (a release) must come before that write, because work-state's
#    release now refuses a record a live roster row claims (RELEASE_CLAIMED): a call after
#    the write would deadlock launch's own release.
# 2. In the no-session block the reservation is released BEFORE the assignment worktree is
#    removed, and a release that threw leaves the worktree alone. A late session that appears
#    after the failed launch used to find neither its worktree nor its reservation.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }

$launch = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\launch.ps1'
$lines = @(Get-Content -LiteralPath $launch)

$rosterWrite = -1
$lastInvalidate = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*Save-LiveRoster \$live\s*$') { $rosterWrite = $i }
  if ($lines[$i] -match 'Invalidate-Manifest\s+["''$]') { $lastInvalidate = $i }
}
Assert-True ($rosterWrite -ge 0) 'found the Save-LiveRoster $live line that writes the roster row'
Assert-True ($lastInvalidate -ge 0) 'found at least one Invalidate-Manifest call'
Assert-True ($lastInvalidate -lt $rosterWrite) "the last Invalidate-Manifest call (line $($lastInvalidate + 1)) must come before the roster row is written (line $($rosterWrite + 1)): a release after that write is refused as claimed"

$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^if \(-not \$row\) \{') { $start = $i; break } }
Assert-True ($start -ge 0) 'found the no-session block (if (-not $row) {)'
$end = -1
for ($i = $start; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '\bexit 5\b') { $end = $i; break } }
Assert-True ($end -gt $start) 'found the end of the no-session block (exit 5)'
$block = ($lines[$start..$end]) -join "`n"

$invalidateAt = $block.IndexOf('Invalidate-Manifest')
$removeAt = $block.IndexOf('Remove-FailedAssignmentWorktree')
Assert-True ($invalidateAt -ge 0 -and $removeAt -ge 0) 'the no-session block both releases the reservation and removes the worktree'
Assert-True ($invalidateAt -lt $removeAt) 'the no-session block releases the reservation before it removes the worktree'
Assert-True ($block -match 'if \(\$released[^)]*\)\s*\{\s*Remove-FailedAssignmentWorktree|if \(-not \$Manifest -or \$released\)\s*\{\s*Remove-FailedAssignmentWorktree') 'the worktree is removed only when the release succeeded (a thrown release leaves it alone)'

Write-Output 'launch-release-order: ok'
