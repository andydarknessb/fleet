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
Assert-True ($block -match 'if \(-not \$keepWorktree\)\s*\{\s*Remove-FailedAssignmentWorktree') 'the worktree is removed unless the keep decision (a failed release on a live assignment) says otherwise'

# fleet#251 QA: a failed release must not strand the worktree forever (a kept worktree makes
# every relaunch exit 4 "assignment worktree already exists" before it can release), and the
# release error must reach the operator (it names bin\retire.ps1 when the record is claimed).
Assert-True ($block -match 'work-state\.js"\s+get\b') 'after a failed release the no-session block re-reads the Work record'
Assert-True ($block -match "-notin @\('assigned', 'released'\)") 'the worktree is kept only when the record is no longer assigned (a late session acknowledged)'
Assert-True ($block -match 'Get-DaemonSessions') 'the no-session block re-reads the session list before giving up on the worktree'
$keepAt = $block.IndexOf('$keepWorktree')
$removeCallAt = $block.IndexOf('Remove-FailedAssignmentWorktree')
Assert-True ($keepAt -ge 0 -and $keepAt -lt $removeCallAt) 'the keep decision is made before the worktree removal'

$invalidateFn = ($lines | Select-String -Pattern '^function Invalidate-Manifest' -Context 0,8 | Select-Object -First 1).Context.PostContext -join "`n"
Assert-True ($invalidateFn -notmatch 'release[^\n]*Out-Null') 'Invalidate-Manifest must not discard the release command output'
Assert-True ($invalidateFn -match 'release failed[^\n]*\$releaseOutput|\$releaseOutput[^\n]*release failed') 'the thrown release failure carries the node error text'

Write-Output 'launch-release-order (QA): ok'

# fleet#251 QA follow-ups: the roster row records the resolved manifest path (release matches it
# against the record's manifest), the release error is stripped of PS 5.1 NativeCommandError
# noise, and the keep-worktree default is documented.
$entryLine = ($lines | Where-Object { $_ -match 'settings = \$settingsPath; manifest =' } | Select-Object -First 1)
Assert-True ($entryLine -match 'manifest = \(Resolve-Path -LiteralPath \$Manifest\)\.Path' -or ($entryLine -match 'manifest = \$rosterManifest' -and ($lines -join "`n") -match '\$rosterManifest = .*Resolve-Path -LiteralPath \$Manifest')) 'the roster row records the resolved manifest path'
Assert-True (($invalidateFn -replace "`r", '') -match 'ForEach-Object \{ "\$_" \} \| Out-String') 'the captured release error is stringified per line, dropping NativeCommandError decoration'
Assert-True ($block -match 'unreadable record and daemon list default to removing') 'the keep-worktree default is documented'

Write-Output 'launch-release-order (follow-ups): ok'
