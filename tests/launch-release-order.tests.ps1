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

# fleet#256 AC1: every launch.ps1 refusal after the reservation exists either releases it or says why it
# must not. `assignment.js assign` reserves the Work record before launch.ps1 runs, so from the moment
# a -Manifest is read every nonzero `exit` is a refusal with a reservation behind it: a refusal that
# neither releases nor explains strands an `assigned` record with no roster row, no job and no marker
# (nidus:issue-7, 2026-09-29), which the planner keeps excluding as reserved.
#
# The table is the classification of every nonzero exit. `release` = the block calls
# Invalidate-Manifest (directly or through Release-ReservationOnRefusal, which never throws so the
# refusal reason still reaches the operator); `keep` = the block carries a `# no release:` comment
# giving the reason. A new exit that is not in the table fails here, so it must be classified.
#   Anchor: a regex matched against the exit line and the two lines above it
#   Rows are consumed in file order, so two exits sharing an anchor take their rows in turn.
$exitRows = @(
  @{ Anchor = 'was not found'; Decision = 'keep' }                              # manifest unreadable: no record id to release
  @{ Anchor = 'is not pending acknowledgment'; Decision = 'keep' }              # acknowledged, invalidated or unreadable: not ours
  @{ Anchor = 'does not match -WorkRecordId'; Decision = 'keep' }               # caller named another record
  @{ Anchor = 'was invalidated'; Decision = 'keep' }                            # already released (checked first so a replayed release never overwrites the marker)
  @{ Anchor = 'no tenant file for'; Nth = 1; Decision = 'release' }             # the manifest's tenant has no file
  @{ Anchor = 'no static roster entry'; Decision = 'keep' }                     # -FromRoster is not a manifest launch
  @{ Anchor = 'missing -\$req'; Decision = 'release' }
  @{ Anchor = 'does not match the fleet naming scheme'; Decision = 'release' }
  @{ Anchor = 'a principal session is named'; Decision = 'keep' }
  @{ Anchor = 'a principal needs -Tenant'; Decision = 'keep' }
  @{ Anchor = 'rostered Sentinel is disabled'; Decision = 'keep' }
  @{ Anchor = 'reason = \$legacyRefusal'; Decision = 'keep' }                   # no manifest on this path
  @{ Anchor = 'no tenant file for'; Nth = 2; Decision = 'release' }
  @{ Anchor = 'is not assigned'; Decision = 'keep' }                            # the record is not ours to release
  @{ Anchor = 'a fourth assignment'; Decision = 'release' }
  @{ Anchor = 'third assignment requires'; Decision = 'release' }
  @{ Anchor = 'reason = \$haikuReason'; Decision = 'release' }
  @{ Anchor = 'reason = \$profileReason'; Decision = 'release' }
  @{ Anchor = 'reason = \$versionReason'; Decision = 'release' }
  @{ Anchor = 'could not reconcile issue'; Decision = 'release' }
  @{ Anchor = 'returned invalid JSON'; Decision = 'release' }
  @{ Anchor = 'is no longer open'; Decision = 'release' }
  @{ Anchor = 'issue #\$Issue changed after'; Decision = 'release' }
  @{ Anchor = 'criteria changed after'; Decision = 'release' }
  @{ Anchor = 'PAUSE set'; Decision = 'release' }
  @{ Anchor = 'refusing to launch, fail closed'; Decision = 'keep' }            # a failed daemon read cannot tell whether a session exists
  @{ Anchor = 'is already running; use claude respawn'; Decision = 'keep' }     # a live session may own this reservation
  @{ Anchor = 'suspected bad read'; Decision = 'keep' }
  @{ Anchor = 'cap reached'; Decision = 'release' }
  @{ Anchor = 'ICs need -Issue'; Decision = 'release' }
  @{ Anchor = 'tenant maxIcs reached'; Decision = 'release' }
  @{ Anchor = 'code = .*refusal\.code'; Decision = 'release' }
  @{ Anchor = "permission profile '.*is missing or unreadable"; Decision = 'release' }
  @{ Anchor = 'profileMessage\$\(\$r\.note\)'; Decision = 'release' }
  @{ Anchor = 'first-turn ceiling exceeded'; Decision = 'release' }
  @{ Anchor = 'reason = \$trustReason'; Decision = 'release' }
  @{ Anchor = 'invalid base precondition'; Decision = 'release' }
  @{ Anchor = 'could not fetch'; Decision = 'release' }
  @{ Anchor = 'manifest base precondition changed'; Decision = 'release' }
  @{ Anchor = 'assignment worktree already exists'; Decision = 'keep' }         # an earlier launch's session may be late; releasing loops assign -> launch -> refuse
  @{ Anchor = 'could not create assignment worktree'; Decision = 'release' }
  @{ Anchor = 'did not produce a session'; Decision = 'release'; Window = 30 }   # the release sits at the top of a long block
)
$releasePattern = 'Invalidate-Manifest|Release-ReservationOnRefusal'

$exitLines = @()
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -notmatch '^\s*#' -and $lines[$i] -match '\bexit [1-9]\b') { $exitLines += $i } }
Assert-True ($exitLines.Count -ge 30) "found the nonzero exits of launch.ps1 (found $($exitLines.Count))"
Assert-True ($exitLines.Count -eq $exitRows.Count) "the exit table classifies every nonzero exit: launch.ps1 has $($exitLines.Count), the table has $($exitRows.Count); classify the new exit (release it or comment '# no release: <why>')"

$used = @{}
$previousExit = -1
$failures = @()
foreach ($exitAt in $exitLines) {
  $tail = ($lines[[Math]::Max(0, $exitAt - 2)..$exitAt]) -join "`n"
  $matchedRow = $null
  for ($r = 0; $r -lt $exitRows.Count; $r++) {
    if ($used.ContainsKey($r) -or $tail -notmatch $exitRows[$r].Anchor) { continue }
    $matchedRow = $exitRows[$r]; $used[$r] = $true; break
  }
  if (-not $matchedRow) { $failures += "line $($exitAt + 1): exit is not in the classification table: $($lines[$exitAt].Trim())"; $previousExit = $exitAt; continue }
  $window = if ($matchedRow.Window) { [int]$matchedRow.Window } else { 8 }
  $blockStart = [Math]::Max($previousExit + 1, $exitAt - $window)
  $blockText = ($lines[$blockStart..$exitAt]) -join "`n"
  $hasRelease = $blockText -match $releasePattern
  $hasKeep = $blockText -match '#\s*no release:'
  if ($matchedRow.Decision -eq 'release' -and (-not $hasRelease -or $hasKeep)) { $failures += "line $($exitAt + 1) [$($matchedRow.Anchor)]: must release the reservation (Invalidate-Manifest) before it exits" }
  if ($matchedRow.Decision -eq 'keep' -and (-not $hasKeep -or $hasRelease)) { $failures += "line $($exitAt + 1) [$($matchedRow.Anchor)]: must carry '# no release: <why>' and must not release" }
  $previousExit = $exitAt
}
Assert-True ($failures.Count -eq 0) ("launch refusals that neither release nor say why:`n" + ($failures -join "`n"))
Assert-True ($used.Count -eq $exitRows.Count) 'every row of the exit table matched an exit'

# A release that throws must never replace the refusal: every call is either inside the never-throwing
# helper or wrapped in its own try (the reason the operator sees stays the refusal's).
$defAt = -1; $helperAt = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^function Invalidate-Manifest') { $defAt = $i }
  if ($lines[$i] -match '^function Release-ReservationOnRefusal') { $helperAt = $i }
}
Assert-True ($defAt -ge 0 -and $helperAt -gt $defAt) 'Release-ReservationOnRefusal is defined after Invalidate-Manifest'
$helperEnd = $helperAt; while ($helperEnd -lt $lines.Count -and $lines[$helperEnd] -notmatch '^\}') { $helperEnd++ }
$helperText = ($lines[$helperAt..$helperEnd]) -join "`n"
Assert-True ($helperText -match 'try\s*\{[^}]*Invalidate-Manifest' -and $helperText -match 'catch') 'the helper wraps Invalidate-Manifest in try/catch so the refusal reason survives a failed release'
Assert-True ($helperText -match '\$DryRun') 'the helper never releases in a dry run'
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*#' -or $lines[$i] -match '^function ') { continue }
  if ($i -ge $helperAt -and $i -le $helperEnd) { continue }
  if ($lines[$i] -match 'Invalidate-Manifest\s+["''$]') {
    Assert-True ($lines[$i] -match '\btry\b') "line $($i + 1): Invalidate-Manifest is called bare, so a failed release would replace the refusal; use Release-ReservationOnRefusal or wrap it in try"
  }
}
$firstUse = -1
for ($i = $helperEnd + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -match 'Release-ReservationOnRefusal\s+["''$]') { $firstUse = $i; break } }
$firstManifestRefusal = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match 'no tenant file for') { $firstManifestRefusal = $i; break } }
Assert-True ($firstUse -ge 0 -and $helperEnd -lt $firstManifestRefusal) "the release helpers are defined (line $($helperEnd + 1)) before the first refusal that calls them (line $($firstManifestRefusal + 1)); PowerShell binds functions in order"

# claude itself throwing after the worktree exists is a refusal too: release first, then remove.
$catchAt = -1
for ($i = 0; $i -lt $lines.Count - 6; $i++) { if ($lines[$i] -match '^\} catch \{' -and (($lines[($i + 1)..($i + 4)] -join "`n") -match 'Remove-FailedAssignmentWorktree') -and (($lines[($i + 1)..($i + 6)] -join "`n") -match '\bthrow\b')) { $catchAt = $i; break } }
Assert-True ($catchAt -ge 0) 'found the catch that removes the worktree and rethrows when claude itself fails'
$catchText = ($lines[$catchAt..($catchAt + 7)]) -join "`n"
$catchRelease = $catchText.IndexOf('Release-ReservationOnRefusal'); if ($catchRelease -lt 0) { $catchRelease = $catchText.IndexOf('Invalidate-Manifest') }
Assert-True ($catchRelease -ge 0 -and $catchRelease -lt $catchText.IndexOf('Remove-FailedAssignmentWorktree')) 'a thrown claude launch releases the reservation before it removes the worktree'

# PowerShell 5.1 reads a BOM-less script as ANSI: keep launch.ps1 ASCII.
$nonAscii = @([IO.File]::ReadAllBytes($launch) | Where-Object { $_ -gt 127 })
Assert-True ($nonAscii.Count -eq 0) 'launch.ps1 stays ASCII-only'

Write-Output 'launch-release-order (#256 exit table): ok'
