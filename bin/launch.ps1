<#
.SYNOPSIS  The only door for starting a fleet session (ADR 0002).
.EXAMPLE   launch.ps1 -Role ic -Name ic-118 -Tenant endzone -Parent pl-endzone -Issue 118 -Prompt "..."
.EXAMPLE   launch.ps1 -FromRoster dispatcher
.EXAMPLE   launch.ps1 -FromRoster pl-endzone -DryRun
#>
[CmdletBinding()]
param(
  [string]$Role, [string]$Name, [string]$Tenant, [string]$Parent, [string]$Prompt, [int]$Issue,
  [string]$FromRoster, [string]$Manifest, [string]$WorkRecordId,
  [ValidateSet('', 'auto', 'allowlist')]
  [string]$Permissions, # the permission profile (ADR 0016); an assignment manifest's own `permissions` wins. Empty = auto.
  [ValidateSet('', 'sonnet', 'opus', 'haiku', 'fable', 'opus-5.5')]
  [string]$Model,   # per-launch override of the role file's model (project leads use it per ticket); 'opus' pins to Opus 4.8, 'opus-5.5' to Opus 5.5 (the project-lead default), see $modelArgs below
  [switch]$Force,   # bypass the cap (Cory only); does not restore the legacy IC prompt path (fleet #89: retired for good)
  [switch]$Recover, # bin\recover.ps1's reboot-recovery relaunch of an IC ONLY: honoured only when
                    # the live roster already holds a row of that exact -Name, role ic, status
                    # active, carrying a recorded manifest path (the credential proving it is a
                    # genuinely reserved unit, not a fresh one) - that row's manifest field is
                    # what is checked, never a -Manifest the caller passed alongside -Recover.
                    # bin\recover.ps1 itself never passes -Manifest, only the IC's ORIGINAL
                    # -Prompt (read from that same roster row): recovery restarts the crashed
                    # process with its own history, it does not re-run manifest preconditions or
                    # create a new worktree, so a validated -Recover does not set -Manifest here
                    # either - it only lifts the no-manifest IC refusal below. A -Recover for any
                    # other name (or one with no manifest on its row) gets no exemption at all
                    # (QA fix, fleet #89: it used to accept any name unconditionally). Cap, PAUSE
                    # and maxIcs still apply regardless.
  [switch]$DryRun   # do everything except start the session
)
. "$PSScriptRoot\_common.ps1"
$static = Get-StaticRoster
$live = Get-LiveRoster
function Invalidate-Manifest {
  param([string]$Reason)
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'node is required to release the assignment reservation' }
  $releaseOutput = & $node.Source "$FleetHome\bin\work-state.js" release --root $FleetHome --id $WorkRecordId --expected-revision $assignment.workRecordRevision --idempotency-key "assignment-invalidated:$($assignment.id)" --evidence $Reason 2>&1 | ForEach-Object { "$_" } | Out-String
  # fleet#251: the door's error text (RELEASE_CLAIMED names bin\retire.ps1) reaches the operator.
  $releaseExit = $LASTEXITCODE
  if ($releaseExit -ne 0) { throw "assignment reservation release failed for Work record '$WorkRecordId': $(($releaseOutput | Out-String).Trim())" }
  Write-Json "$Manifest.invalidated.json" ([pscustomobject]@{ schemaVersion = 1; manifestId = $assignment.id; invalidatedAt = (Now-Iso); reason = $Reason })
}
# fleet#256: a refusal after the reservation exists must not leave it `assigned` with no session (the
# planner keeps excluding the issue as reserved and nothing else sees it). This releases it for a
# refusal and NEVER throws, so the refusal the operator reads stays the refusal even when the release
# itself fails (Invalidate-Manifest throws the node error, fleet#251). A dry run and a launch with no
# -Manifest release nothing. released/error feed the JSON refusals; note is appended to Write-Error text.
function Release-ReservationOnRefusal {
  param([string]$Reason)
  $result = [pscustomobject]@{ released = $false; error = $null; note = '' }
  if (-not $Manifest -or $DryRun) { return $result }
  try { $null = Invalidate-Manifest $Reason; $result.released = $true }
  catch { $result.error = "$($_.Exception.Message)"; $result.note = " (the reservation release also failed: $($result.error))" }
  return $result
}
$cwd = $null
$t = $null
$worktreePath = $null
$recoverValidated = $false
if ($Recover -and -not $Manifest -and ($Role -eq 'ic' -or ($Name -and $Name -match '^ic-'))) {
  $recoverableRow = $live.sessions | Where-Object { $_.name -eq $Name -and $_.role -eq 'ic' -and $_.status -eq 'active' -and $_.manifest } | Select-Object -Last 1
  $recoverValidated = [bool]$recoverableRow
}
if ($Manifest) {
  # no release: a manifest that cannot be read names no Work record, so there is nothing this script can release.
  if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { Write-Error "manifest '$Manifest' was not found"; exit 4 }
  $assignment = Read-Json $Manifest
  # no release: the manifest's status is immutable 'pending-ack' (acknowledgment and invalidation are sidecar files, checked below), so this only catches an unreadable or malformed manifest, which names no record we could release.
  if (-not $assignment -or $assignment.status -ne 'pending-ack') { Write-Error "manifest '$Manifest' is not pending acknowledgment"; exit 4 }
  # no release: -WorkRecordId names a different record than this manifest reserved. That is the caller's mistake, a release on it would be a guess, and the reservation stays valid for a correct launch.
  if ($WorkRecordId -and $assignment.workRecordId -ne $WorkRecordId) { Write-Error "manifest Work record does not match -WorkRecordId"; exit 4 }
  $WorkRecordId = $assignment.workRecordId
  $Role = 'ic'
  $Name = "ic-$($assignment.issue.number)"
  $Tenant = $assignment.tenant
  $Parent = $assignment.parent
  $Issue = [int]$assignment.issue.number
  $Model = [string]$assignment.model
  # A manifest written before spec #94 has no `permissions`; it launches auto as it always did.
  $Permissions = [string]$assignment.permissions
  # A slash command at the head of a launch prompt is a user invocation in the new
  # session, so the IC runs the real /implement (the same convention as a legacy brief).
  # Forward slashes on purpose: the IC pastes this into the Bash tool (Git Bash), where an unquoted
  # backslash path collapses to C:UsersCory... (every IC since the cutover lost its first turn to
  # MODULE_NOT_FOUND and retried through PowerShell). node accepts either separator on Windows.
  $fleetHomeFwd = $FleetHome -replace '\\', '/'
  $Prompt = "/mattpocock-skills:implement Read the assignment manifest at $Manifest and the GitHub issue body and comments. Emit assignment-started for Work record $WorkRecordId in your first useful turn (node $fleetHomeFwd/bin/assignment.js ack), then follow the manifest pointers without restating the issue criteria."
  # no release: the invalidation marker is the record of an earlier release; there is nothing left to release. Checked before the tenant file so a replayed release never overwrites the original marker.
  if (Test-Path -LiteralPath "$Manifest.invalidated.json") { Write-Error "manifest '$Manifest' was invalidated"; exit 4 }
  $tenantConfig = Read-Json "$FleetHome\tenants\$Tenant.json"
  if (-not $tenantConfig) { $r = Release-ReservationOnRefusal "launch refused: no tenant file for '$Tenant'"; Write-Error "no tenant file for '$Tenant'$($r.note)"; exit 4 }
  $cwd = $tenantConfig.repo
}
if ($FromRoster) {
  $e = $static.sessions | Where-Object { $_.name -eq $FromRoster }
  # no release: -FromRoster is not a manifest launch; a caller mixing it into one made a mistake and the reservation stays valid for a correct launch.
  if (-not $e) { Write-Error "no static roster entry named '$FromRoster'"; exit 4 }
  $Role = $e.role; $Name = $e.name; $Tenant = $e.tenant; $Parent = $e.parent; $Prompt = $e.prompt; $cwd = $e.cwd
}
foreach ($req in 'Role','Name','Parent','Prompt') { if (-not (Get-Variable $req -ValueOnly)) { $r = Release-ReservationOnRefusal "launch refused: the manifest gives no $req"; Write-Error "missing -$req$($r.note)"; exit 4 } }
if ($Name -notmatch '^(dispatcher|sentinel|pl-[a-z0-9-]+|pe-[a-z0-9-]+|ar-[a-z0-9-]+|ic-[0-9]+)$') { $r = Release-ReservationOnRefusal "launch refused: name '$Name' does not match the fleet naming scheme"; Write-Error "name '$Name' does not match the fleet naming scheme$($r.note)"; exit 4 }
# no release: a manifest launch is always Role ic, so the principal and arbiter checks below are reachable only by mixing -FromRoster into a manifest launch (caller mistake; the reservation stays valid for a correct launch).
if ($Role -eq 'principal' -and $Name -notmatch '^pe-') { Write-Error "a principal session is named pe-<tenant> (ADR 0011)"; exit 4 }
# no release: same -FromRoster mix-up as the principal name check above.
if ($Role -eq 'arbiter' -and $Name -notmatch '^ar-') { Write-Error "an arbiter session is named ar-<tenant> (ADR 0017)"; exit 4 }
# no release: same -FromRoster mix-up as the principal name check above.
if ($Role -eq 'principal' -and -not $Tenant) { Write-Error "a principal needs -Tenant (one per tenant, ADR 0011)"; exit 4 }
# no release: same -FromRoster mix-up as the principal name check above.
if ($Role -eq 'arbiter' -and -not $Tenant) { Write-Error "an arbiter needs -Tenant (one per tenant, ADR 0017)"; exit 4 }
# Ticket 08b: while the rostered Sentinel is cut over (permanent since ticket 89 retired
# its roster entry, role file and rollback script), the one door refuses to start a
# second supervisor (not even with -Force: two actors is the failure cutover exists to
# prevent). A dry run still evaluates the other gates.
if (($Role -eq 'sentinel' -or $Name -eq 'sentinel') -and (Test-SentinelOff) -and -not $DryRun) {
  # no release: the same -FromRoster mix-up as the principal and arbiter checks above; a manifest launch is Role ic and never reaches this.
  Write-Output (@{ launched = $false; reason = 'the rostered Sentinel is disabled by state/flags/sentinel-off (scheduled supervision is live): bin\watchdog.ps1 is the supervisor now' } | ConvertTo-Json -Compress); exit 3
}
# Ticket 89 (ADR 0006 paperwork after one release): an IC starts only from a reserved
# manifest (assignment.js assign, then launch). The legacy -Prompt launch of an IC is
# retired for good, not merely gated: there is no flag and no -Force to bring it back
# (bin\rollback-assignment.ps1 is gone). A dry run still passes so the settings and
# budget gates below stay reachable for every other IC test and rehearsal. $recoverValidated
# (above) is the ONLY exemption left, and only once the name is proven genuinely recoverable:
# a -Recover for a name that is not an active IC on the live roster with a manifest is
# refused exactly like a bare -Prompt launch (QA fix, fleet #89: -Recover used to exempt
# any name unconditionally).
if (($Role -eq 'ic' -or $Name -match '^ic-') -and -not $Manifest -and -not $recoverValidated -and -not $DryRun) {
  # no release: this refusal is for a launch with no -Manifest, so no reservation stands behind it.
  $legacyRefusal = 'IC sessions launch only from a reserved manifest: reserve one with bin\assignment.js assign and launch it with assignment.js launch; the legacy prompt path was retired for good (fleet #89) and there is no flag to bring it back'
  if ($Recover) { $legacyRefusal = "-Recover found no active IC named '$Name' with a recorded manifest on the live roster; there is nothing to recover, and -Recover carries no exemption of its own (fleet #89)" }
  Write-Output (@{ launched = $false; reason = $legacyRefusal } | ConvertTo-Json -Compress); exit 3
}
if ($Tenant) {
  $t = Read-Json "$FleetHome\tenants\$Tenant.json"
  if (-not $t) { $r = Release-ReservationOnRefusal "launch refused: no tenant file for '$Tenant'"; Write-Error "no tenant file for '$Tenant'$($r.note)"; exit 4 }
  if (-not $cwd) { $cwd = $t.repo }
}
if (-not $cwd) { $cwd = $FleetHome }

if ($Manifest) {
  $activeState = Read-Json "$FleetHome\state\work\active.json"
  $recordProperty = if ($activeState) { $activeState.records.PSObject.Properties[$WorkRecordId] } else { $null }
  # no release: the record is not `assigned` (absent, claimed by a live IC, released, or already past the reservation), so it is no longer this manifest's reservation. A release from this manifest's revision would be refused, or would pull a claim a session holds.
  if (-not $recordProperty -or $recordProperty.Value.state -ne 'assigned') { Write-Error "Work record '$WorkRecordId' is not assigned"; exit 4 }
  # no release: the record is `assigned` but at another revision than this manifest reserved (fleet#264: a lead's escalate -> assigned round trip bumps it on the same manifest). The reservation is no longer this manifest's, and a release from its revision would be refused as stale. Refused here, before the gh check, fetch and worktree work.
  if ([string]$recordProperty.Value.revision -ne [string]$assignment.workRecordRevision) { Write-Error "Work record '$WorkRecordId' is at revision $($recordProperty.Value.revision), but the manifest reserved revision $($assignment.workRecordRevision)"; exit 4 }
  # Per tenant, the way work-state.js's isForeignRecord scopes it: another tenant's ICs are
  # not this tenant's assignments (nidus #2 sat blocked behind endzone's two ICs, 2026-09-25).
  # A record with no tenant is legacy and still counts, matching isForeignRecord.
  $activeAssignments = @($activeState.records.PSObject.Properties | ForEach-Object { $_.Value } | Where-Object { $_.manifestPath -and $_.state -ne 'retired' -and $_.id -ne $WorkRecordId -and (-not $_.tenant -or [string]$_.tenant -eq [string]$Tenant) })
  if ($activeAssignments.Count -ge 3) { $r = Release-ReservationOnRefusal 'launch refused: a fourth assignment is not permitted'; Write-Error "a fourth assignment is not permitted$($r.note)"; exit 4 }
  if ($activeAssignments.Count -ge 2) {
    $proof = $assignment.independenceProof
    $expectedFields = @('components', 'migrationPrefixes', 'schemaAreas', 'testResources')
    $expectedCandidates = @($activeAssignments | ForEach-Object { [int]$_.issue }) + @([int]$Issue) | Sort-Object
    $actualCandidates = @($proof.candidates | ForEach-Object { [int]$_ }) | Sort-Object
    $actualFields = @($proof.checkedFields | ForEach-Object { [string]$_ }) | Sort-Object
    $missingReservationIssues = @($proof.missingReservations)
    $proofHasMissingReservations = $proof -and $proof.PSObject.Properties.Name -contains 'missingReservations'
    $proofValid = $proof -and $proofHasMissingReservations -and $proof.independent -and @($proof.conflicts).Count -eq 0 -and $missingReservationIssues.Count -eq 0 -and (($actualCandidates -join ',') -eq ($expectedCandidates -join ',')) -and (($actualFields -join ',') -eq (($expectedFields | Sort-Object) -join ','))
    if (-not $proofValid) { $r = Release-ReservationOnRefusal 'launch refused: a third assignment requires a verified independent machine-readable proof'; Write-Error "a third assignment requires a verified independent machine-readable proof$($r.note)"; exit 4 }
  }
}

# Fleet #28 (2026-09-11): the installed Claude Code CLI keeps a per-model auto-mode
# list and claude-haiku-4-5 is not on it (verified on 2.1.267, both 2.1.268 builds and
# 2.1.282; an explicit --permission-mode auto is downgraded the same way). A haiku --bg
# session under auto therefore runs in permission-mode default and blocks on its first
# out-of-cwd Read with nobody to approve it. Spec #94 (#162, ADR 0016): the permission
# mode is a launch-door profile per model, so haiku launches only under the allowlist
# profile (acceptEdits plus config/permissions-allowlist.json, applied below) and haiku
# under auto is still refused here, even under -Force (the CLI cannot be forced) and even
# for a dry run, so a rehearsal reports the truth. assignment.js refuses the same pair at
# reservation time.
if (-not $Permissions) { $Permissions = 'auto' }
if ($Model -eq 'haiku' -and $Permissions -ne 'allowlist') {
  $haikuReason = "the installed Claude Code CLI ($(try { "$((Invoke-ClaudeCli -Arguments @('--version') -TimeoutSec 30).stdout)".Trim() } catch { 'version unknown' })) has no auto mode for claude-haiku-4-5 (fleet #28): a haiku --bg session runs in permission-mode default and blocks on its first out-of-cwd Read; launch it on sonnet"
  $released = $false
  if ($Manifest -and -not $DryRun) { try { Invalidate-Manifest $haikuReason; $released = $true } catch {} }
  Write-Output (@{ launched = $false; reason = $haikuReason; model = $Model; reservationReleased = $released } | ConvertTo-Json -Compress); exit 3
}
# The allowlist profile is the haiku IC profile and nothing else: sonnet keeps auto, and a
# control-plane role never trades its classifier for a fixed list.
if ($Permissions -eq 'allowlist' -and ($Role -ne 'ic' -or $Model -ne 'haiku')) {
  $profileReason = "the allowlist permission profile is the haiku IC profile (ADR 0016); a $Role on '$(if ($Model) { $Model } else { 'its role model' })' runs the auto profile"
  $released = $false
  if ($Manifest -and -not $DryRun) { try { Invalidate-Manifest $profileReason; $released = $true } catch {} }
  Write-Output (@{ launched = $false; reason = $profileReason; model = $Model; permissions = $Permissions; reservationReleased = $released } | ConvertTo-Json -Compress); exit 3
}
# Spec #94 (#165): the haiku tier is open only on the CLI the rehearsal passed on. The
# profile records that version; any other `claude --version` refuses a haiku launch
# (dry runs included) until the rehearsal passes again and bumps the field. No recorded
# version means no rehearsal has passed yet, which refuses too: the tier opens only when a
# clean verdict writes the field. A scratch root (bin\scratch-root.ps1) marks its copy
# `rehearsalRoot: true`, the one place a haiku launch runs on an unverified CLI, because
# that launch IS the rehearsal. Sonnet never reads the field.
if ($Model -eq 'haiku' -and $Permissions -eq 'allowlist') {
  $haikuProfile = $null
  try { $haikuProfile = Read-Json "$FleetHome\config\permissions-allowlist.json" } catch {}
  if (-not ($haikuProfile -and $haikuProfile.rehearsalRoot -eq $true)) {
    $verifiedCli = if ($haikuProfile) { "$($haikuProfile.verifiedCliVersion)".Trim() } else { '' }
    $installedCli = ''
    try { $installedCli = "$((Invoke-ClaudeCli -Arguments @('--version') -TimeoutSec 30).stdout)".Trim() } catch {}
    $installedVersion = if ($installedCli -match '(\d+\.\d+\.\d+)') { $Matches[1] } else { $installedCli }
    $rehearsalHow = "(bin\scratch-root.ps1 -Path <dir> -Issue <n>, then its printed assign and launch); a clean verdict writes verifiedCliVersion in config\permissions-allowlist.json. Launch this ticket on sonnet meanwhile"
    $versionReason = $null
    if (-not $verifiedCli) { $versionReason = "no haiku rehearsal has passed yet (config\permissions-allowlist.json records no verifiedCliVersion; spec #94, ADR 0016): run the rehearsal first $rehearsalHow" }
    elseif ($installedVersion -ne $verifiedCli) { $versionReason = "the haiku tier was verified on Claude Code $verifiedCli, but the installed CLI is $(if ($installedVersion) { $installedVersion } else { 'unknown' }) (spec #94, ADR 0016): re-run the rehearsal before a haiku launch $rehearsalHow" }
    if ($versionReason) {
      $released = $false
      if ($Manifest -and -not $DryRun) { try { Invalidate-Manifest $versionReason; $released = $true } catch {} }
      Write-Output (@{ launched = $false; reason = $versionReason; model = $Model; permissions = $Permissions; verifiedCliVersion = $verifiedCli; installedCliVersion = $installedVersion; reservationReleased = $released } | ConvertTo-Json -Compress); exit 3
    }
  }
}

if ($Manifest -and -not $DryRun) {
  $previousOutputEncoding = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $issueRaw = (& gh issue view $Issue -R $t.github --json state,body,comments 2>&1 | Out-String)
  } finally {
    [Console]::OutputEncoding = $previousOutputEncoding
  }
  if ($LASTEXITCODE -ne 0) { $r = Release-ReservationOnRefusal "launch refused: could not reconcile issue #$Issue with GitHub before launch"; Write-Error "could not reconcile issue #$Issue before launch$($r.note)"; exit 4 }
  try { $currentIssue = $issueRaw | ConvertFrom-Json } catch { $r = Release-ReservationOnRefusal "launch refused: GitHub issue reconciliation for #$Issue returned invalid JSON"; Write-Error "GitHub issue reconciliation returned invalid JSON$($r.note)"; exit 4 }
  if ([string]$currentIssue.state -ne 'OPEN') { $r = Release-ReservationOnRefusal "issue #$Issue is no longer open"; Write-Error "issue #$Issue is no longer open$($r.note)"; exit 4 }
  $hash = [Security.Cryptography.SHA256]::Create()
  $actualBodyHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$currentIssue.body))).Replace('-', '').ToLowerInvariant()
  if ($actualBodyHash -ne [string]$assignment.issue.bodyHash) {
    $r = Release-ReservationOnRefusal 'issue body hash changed before acknowledgment'
    Write-Error "issue #$Issue changed after the manifest was created; assignment invalidated$($r.note)"
    exit 4
  }
  $criteriaParts = @([string]$currentIssue.body)
  foreach ($comment in @($currentIssue.comments | Sort-Object createdAt,id)) {
    $criteriaParts += @([string]$comment.id, [string]$comment.createdAt, [string]$comment.body)
  }
  $criteriaText = $criteriaParts -join [char]0
  $criteriaHash = [Security.Cryptography.SHA256]::Create()
  $actualCriteriaHash = [BitConverter]::ToString($criteriaHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($criteriaText))).Replace('-', '').ToLowerInvariant()
  if (-not $assignment.issue.criteriaHash -or $actualCriteriaHash -ne [string]$assignment.issue.criteriaHash) {
    $r = Release-ReservationOnRefusal 'issue criteria changed before acknowledgment'
    Write-Error "issue #$Issue criteria changed after the manifest was created; assignment invalidated$($r.note)"
    exit 4
  }
}

# --- gates ---
if ((Test-Paused) -and -not $Force) {
  $p = Get-Content "$FleetHome\state\PAUSE" -Raw
  $r = Release-ReservationOnRefusal "launch refused: PAUSE set: $("$p".Trim())"
  Write-Output (@{ launched = $false; reason = "PAUSE set: $p"; reservationReleased = $r.released; releaseError = $r.error } | ConvertTo-Json -Compress); exit 3
}
# The duplicate-name guard and the cap read the same daemon list the caller may have
# acted on; a glitched read must refuse the launch, never pass the guards empty.
$daemon = $null
# A short ladder (3 x 3 s, like the --bg resolve below): a kill between --bg and the roster write leaves an unrostered session, so the whole launch must stay well inside assignment.js's 90 s.
try { $daemon = Get-DaemonSessions -Strict -Tries 3 -PollMs 3000 } catch {
  $failClosedReason = "refusing to launch, fail closed: $($_.Exception.Message)"
  # no release: a failed daemon read cannot tell whether a session named for this reservation exists, so it is the same unknown as the suspected-bad-read guard below and keeps the reservation; the stranded-reservation sweep (fleet#253) releases it later if no session ever acknowledges.
  Write-Output (@{ launched = $false; reason = $failClosedReason } | ConvertTo-Json -Compress); exit 3
}
$fleetNames = Get-FleetNames -Live $live -Static $static
$liveFleet = @($daemon | Where-Object { $fleetNames -contains $_.name })
if (@($liveFleet | ForEach-Object { $_.name }) -contains $Name) {
  # no release: a live session already holds this name and may be the one that acknowledges this very reservation in its first turn; a release would pull the assignment from under it. If no session ever acknowledges, the stranded-reservation sweep (fleet#253) finds it.
  Write-Output (@{ launched = $false; reason = "a session named '$Name' is already running; use claude respawn" } | ConvertTo-Json -Compress); exit 3
}
# The list can also read WRONG (empty or partial) while the CLI exits 0. The roster's
# job record is an independent on-disk source: if it says this name's job is still
# working and recently updated (45 min = the fleet staleness threshold), refuse the
# duplicate rather than trust the list that omitted it. A stale or stopped job state
# stays launchable, so crash recovery is not blocked.
$rosterEntry = $live.sessions | Where-Object { $_.name -eq $Name -and $_.status -eq 'active' } | Select-Object -First 1
if ($rosterEntry -and $rosterEntry.jobId) {
  $jobState = $null
  try { $jobState = Get-JobState $rosterEntry.jobId } catch {}
  if ($jobState -and "$($jobState.state)" -eq 'working') {
    $updatedAge = $null
    try { $updatedAge = ((Get-Date).ToUniversalTime() - ([DateTimeOffset]::Parse("$($jobState.updatedAt)", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)).UtcDateTime).TotalMinutes } catch {}
    if ($null -ne $updatedAge -and $updatedAge -le 45) {
      # no release: the job for this name is working per its on-disk state, so a live session may own this reservation (same reasoning as the duplicate-name refusal above).
      Write-Output (@{ launched = $false; reason = "job $($rosterEntry.jobId) for '$Name' is working per its on-disk state (updated $([int]$updatedAge) min ago) though the daemon list omits it; suspected bad read, refusing a duplicate launch" } | ConvertTo-Json -Compress); exit 3
    }
  }
}
# The cap bounds concurrent worktrees and PR churn, so it counts the sessions that
# produce them. config/cycle.json `cap.exemptNamePrefixes` (the Principal, `pe-`, and
# the Arbiter, `ar-`; ADR 0011 / grill Q28, ADR 0017) lists the standing control-plane names that neither count
# toward the cap nor are refused by it. Absent config = nothing is exempt.
$capCounted = @($liveFleet | Where-Object { -not (Test-CapExempt "$($_.name)") })
if (-not $Force -and -not (Test-CapExempt $Name) -and $capCounted.Count -ge [int]$static.cap) {
  $capReason = "cap reached ($($capCounted.Count)/$($static.cap))"
  $r = Release-ReservationOnRefusal "launch refused: $capReason"
  Write-Output (@{ launched = $false; reason = $capReason; reservationReleased = $r.released; releaseError = $r.error } | ConvertTo-Json -Compress); exit 3
}
if ($Role -eq 'ic') {
  if (-not $Issue) { $r = Release-ReservationOnRefusal 'launch refused: the manifest gives no issue number'; Write-Error "ICs need -Issue$($r.note)"; exit 4 }
  $liveNames = @($liveFleet | ForEach-Object { $_.name })
  $icsHere = @($live.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' -and $_.tenant -eq $Tenant -and ($liveNames -contains $_.name) })
  if (-not $Force -and $icsHere.Count -ge [int]$t.maxIcs) {
    $maxIcsReason = "tenant maxIcs reached ($($icsHere.Count)/$($t.maxIcs))"
    $r = Release-ReservationOnRefusal "launch refused: $maxIcsReason"
    Write-Output (@{ launched = $false; reason = $maxIcsReason; reservationReleased = $r.released; releaseError = $r.error } | ConvertTo-Json -Compress); exit 3
  }
}

# --- fleet identity (#153, ADR 0015): every session acts on GitHub as the fleet's
# --- own login. bin/identity.js reads the secret gh config directory; its env keys
# --- (GH_CONFIG_DIR plus git's credential reset) go into the settings env block below,
# --- which every Bash call, hook and child binary inherits. No token lands in state/.
# --- Once any tenant names a fleetIdentity distinct from its ownerLogin the directory
# --- is required: missing or naming another login refuses the launch (exit 3, one
# --- high page per code), writes no settings and no session, never falls back to
# --- Cory's keyring login. A dry run reports the refusal but never pages.
$identityPlan = Get-FleetIdentityPlan
# A present token is asked of GitHub once (not in a dry run, which stays offline):
# an expired or revoked one refuses as FLEET_IDENTITY_INVALID instead of launching a
# session whose every gh call would fail unpaged.
if (-not $identityPlan.refusal -and -not $DryRun) {
  $liveRefusal = Test-FleetIdentityLive $identityPlan
  if ($liveRefusal) { $identityPlan | Add-Member -NotePropertyName refusal -NotePropertyValue $liveRefusal -Force }
}
if ($identityPlan.refusal) {
  $identityReason = "$($identityPlan.refusal.code): $($identityPlan.refusal.message)"
  $released = $false; $paged = $false
  if (-not $DryRun) {
    if ($Manifest) { try { Invalidate-Manifest "launch refused: $identityReason"; $released = $true } catch {} }
    $paged = Send-FleetIdentityPageOnce -Plan $identityPlan -Source "launch.ps1 ($Name)"
  }
  Write-Output (@{ launched = $false; code = "$($identityPlan.refusal.code)"; reason = $identityReason; reservationReleased = $released; paged = $paged; dryRun = [bool]$DryRun } | ConvertTo-Json -Compress); exit 3
}
if (-not $DryRun) { [void](Send-FleetIdentityPageOnce -Plan $identityPlan -Source 'launch.ps1') }

# --- per-session settings: fleet-settings + env identity ---
$settings = Read-Json "$FleetHome\fleet-settings.json"
$envBlock = [ordered]@{ FLEET_HOME = $FleetHome; FLEET_NAME = $Name; FLEET_ROLE = $Role; FLEET_TENANT = "$Tenant"; FLEET_PARENT = $Parent }
if ($Issue) { $envBlock.FLEET_ISSUE = "$Issue" }
# fleet #282: ponytail's always-on hooks stay off in every role and its subagents
# ('(?!)' matches no agent type); the IC loads the skill explicitly instead.
$envBlock.PONYTAIL_DEFAULT_MODE = 'off'
$envBlock.PONYTAIL_SUBAGENT_MATCHER = '(?!)'
# fleet #181: hooks/allowlist-gate.js gates only the sessions launched under the allowlist profile.
if ($Permissions) { $envBlock.FLEET_PERMISSIONS = "$Permissions" }
if ($identityPlan.env) { foreach ($identityVar in $identityPlan.env.PSObject.Properties) { $envBlock[$identityVar.Name] = "$($identityVar.Value)" } }
if ($Manifest) {
  $envBlock.FLEET_ASSIGNMENT_MANIFEST = (Resolve-Path -LiteralPath $Manifest).Path
  $envBlock.FLEET_WORK_RECORD_ID = $WorkRecordId
  $envBlock.FLEET_BASE_SHA = [string]$assignment.base.sha
  $envBlock.FLEET_ASSIGNMENT_BRANCH = [string]$assignment.branch
}
$settings | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]$envBlock) -Force

# --- role tool contract (ticket 06). work-state.js stays the one validated door to
# --- durable coordination state, so every role loses direct file-editing tools on
# --- state/work|events|archive (and, since ticket 07, state/exclusions - bin/exclusions.js
# --- is that ledger's door - plus the digest projections, which only bin/digest.js
# --- writes); control-plane roles additionally lose engineering
# --- edits in tenant repos (they review and merge, ICs write); ICs lose direct
# --- edits anywhere in fleet state. Rollback: state/flags/tool-contract-off skips
# --- the injection without touching any launch gate.
$fleetFwd = $FleetHome.Replace('\', '/')
$denyRules = @()
$toolContractOn = -not (Test-Path "$FleetHome\state\flags\tool-contract-off")
if ($toolContractOn) {
  foreach ($deniedTool in 'Edit', 'Write', 'NotebookEdit') {
    foreach ($statePath in 'state/work/**', 'state/events/**', 'state/archive/**', 'state/exclusions/**', 'state/status/DIGEST.md', 'state/status/*-status.md') { $denyRules += "$deniedTool($fleetFwd/$statePath)" }
    if ($Role -eq 'ic') { $denyRules += "$deniedTool($fleetFwd/state/**)" }
  }
  # The Principal (ADR 0011) and the Arbiter (ADR 0017) are NOT on this list: settings deny rules cannot express an
  # allowlist, so its write boundary (docs/adr/*.md and CONTEXT.md in the tenant repo,
  # its status file, the triage ledger, its memory; the Arbiter's bounds mirror it) is enforced by hooks/principal-guard.ps1
  # (fleet #39), registered in fleet-settings.json for every fleet session.
  if ($Role -in @('dispatcher', 'project-lead', 'sentinel', 'arbiter')) {
    foreach ($tenantFile in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)) {
      $tenantRepo = $null
      try { $tenantRepo = (Read-Json $tenantFile.FullName).repo } catch {}
      if ($tenantRepo) { foreach ($deniedTool in 'Edit', 'Write', 'NotebookEdit') { $denyRules += "$deniedTool($($tenantRepo.Replace('\', '/'))/**)" } }
    }
  }
}
if ($denyRules.Count -gt 0) {
  if (-not $settings.PSObject.Properties['permissions']) { $settings | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{}) -Force }
  $existingDeny = @()
  if ($settings.permissions.PSObject.Properties['deny']) { $existingDeny = @($settings.permissions.deny) }
  $settings.permissions | Add-Member -NotePropertyName deny -NotePropertyValue (@(@($existingDeny + $denyRules) | Select-Object -Unique)) -Force
}

# --- permission profile (spec #94, ADR 0016). auto is fleet-settings.json as written.
# --- allowlist runs acceptEdits with the checked-in config/permissions-allowlist.json:
# --- its allow rules verbatim (tokens resolved), the fleet root as an additional
# --- directory, and its deny rules appended after the tool contract's (deny beats
# --- allow, so the contract is unchanged). The mode lives in the settings only; no
# --- --permission-mode goes on the command line.
# The profile adds the tenant repo as a directory (fleet #171: a haiku IC reads the
# ticket's paths in the main checkout), which acceptEdits then makes editable. A deny
# list cannot say "everything but .claude/worktrees", so the rules are generated here
# from the checkout as it stands: every entry beside each segment of the kept path is
# denied, the kept path itself is not. An entry created after launch is not covered.
function Get-RepoDenyRules {
  param([string]$Repo, [string]$Keep, [string[]]$Tools)
  if (-not $Repo -or -not (Test-Path -LiteralPath $Repo -PathType Container)) { throw "the allowlist profile denies edits across the tenant repo '$Repo', which does not exist; refusing a launch that would leave it editable" }
  $prefix = $Repo.Replace('\', '/').TrimEnd('/')
  $dir = $Repo
  $rules = @()
  foreach ($segment in @($Keep.Replace('\', '/').Split('/') | Where-Object { $_ })) {
    foreach ($entry in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
      if ($entry.Name -eq $segment) { continue }
      $target = if ($entry.PSIsContainer) { "$prefix/$($entry.Name)/**" } else { "$prefix/$($entry.Name)" }
      foreach ($tool in $Tools) { $rules += "$tool($target)" }
    }
    $dir = Join-Path $dir $segment
    $prefix = "$prefix/$segment"
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { break }
  }
  return $rules
}
$allowRuleCount = 0
if ($Permissions -eq 'allowlist') {
  $profilePath = "$FleetHome\config\permissions-allowlist.json"
  $permissionProfile = $null
  try { $permissionProfile = Read-Json $profilePath } catch {}
  if (-not $permissionProfile -or -not $permissionProfile.allow -or -not $permissionProfile.defaultMode) { $r = Release-ReservationOnRefusal "launch refused: the allowlist permission profile '$profilePath' is missing or unreadable"; Write-Error "the allowlist permission profile '$profilePath' is missing or unreadable$($r.note)"; exit 4 }
  $profileTokens = @{ '<fleet>' = $fleetFwd; '<repo>' = "$($t.repo)".Replace('\', '/').TrimEnd('/'); '<defaultBranch>' = "$($t.defaultBranch)"; '<releaseBranch>' = "$($t.releaseBranch)" }
  $resolveProfileRule = {
    param([string]$Text)
    foreach ($token in $profileTokens.Keys) { if ($profileTokens[$token]) { $Text = $Text.Replace($token, $profileTokens[$token]) } }
    if ($Text -match '<[A-Za-z]+>') { throw "permission profile rule '$Text' names $($Matches[0]), which this launch cannot resolve (the tenant file lacks it)" }
    return $Text
  }
  try {
    $profileAllow = @($permissionProfile.allow | ForEach-Object { & $resolveProfileRule "$($_.rule)" })
    $profileDeny = @($permissionProfile.deny | Where-Object { $_ } | ForEach-Object { & $resolveProfileRule "$($_.rule)" })
    $profileDirs = @($permissionProfile.additionalDirectories | Where-Object { $_ } | ForEach-Object { if ($_ -is [string]) { & $resolveProfileRule $_ } else { & $resolveProfileRule "$($_.dir)" } })
    if ($permissionProfile.PSObject.Properties['repoDeny'] -and $permissionProfile.repoDeny) {
      $profileDeny += @(Get-RepoDenyRules -Repo "$($t.repo)" -Keep "$($permissionProfile.repoDeny.keep)" -Tools @($permissionProfile.repoDeny.tools))
    }
  } catch { $profileMessage = "$($_.Exception.Message)"; $r = Release-ReservationOnRefusal "launch refused: $profileMessage"; Write-Error "$profileMessage$($r.note)"; exit 4 }
  if (-not $settings.PSObject.Properties['permissions']) { $settings | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{}) -Force }
  $existingDeny = @()
  if ($settings.permissions.PSObject.Properties['deny']) { $existingDeny = @($settings.permissions.deny) }
  $settings.permissions | Add-Member -NotePropertyName defaultMode -NotePropertyValue "$($permissionProfile.defaultMode)" -Force
  $settings.permissions | Add-Member -NotePropertyName allow -NotePropertyValue $profileAllow -Force
  $settings.permissions | Add-Member -NotePropertyName additionalDirectories -NotePropertyValue $profileDirs -Force
  $settings.permissions | Add-Member -NotePropertyName deny -NotePropertyValue (@(@($existingDeny + $profileDeny) | Select-Object -Unique)) -Force
  $allowRuleCount = $profileAllow.Count
}

$settingsPath = "$FleetHome\state\sessions\$Name.settings.json"
Write-Json $settingsPath $settings

# The friendly -Model token is passed to `claude --model`, but the bare 'opus'
# alias tracks the latest Opus (currently Opus 5). ICs must run Opus 4.8, so pin
# 'opus' to the concrete id. 'fable' is pinned too (ADR 0011, moved to the Arbiter by
# ADR 0017: it is the one Fable seat and a default-Fable bump must not move it silently; the installed
# CLI 2.1.269 admits claude-fable-5-1 to auto mode, verified in its model predicate
# 2026-09-11, so no fleet #28-style refusal). Other tokens keep their CLI aliases.
# An arbiter launched with no -Model runs the role file's `model: fable` alias (a
# principal, since ADR 0017, runs Opus 5.5 like a lead); pin that path too so the two
# spellings resolve to the same id.
# A project lead launched with no -Model runs Opus 5.5 (owner ruling 2026-09-23),
# pinned for the same reason; CLI 2.1.280 admits claude-opus-5-5 to auto mode.
# An IC on sonnet runs pinned Sonnet 5.5 (owner ruling 2026-09-28): CLI 2.1.284's
# sonnet alias already resolves to claude-sonnet-5-5; the pin stops a silent bump.
# The pins and role defaults live in _common.ps1 (Resolve-LaunchModel) since fleet
# #121: sentinel-check compares a daemon job's frozen respawnFlags against them.
$launchModel = Resolve-LaunchModel -Role $Role -Model $Model
$Model = $launchModel.token
$modelArgs = @()
if ($launchModel.id) { $modelArgs = @('--model', $launchModel.id) }

# The role file frontmatter declares `effort:`, but `claude --agent` does NOT read
# it for a top-level background session (it defaults every such session to high;
# e.g. sentinel.md says low yet ran at high). So parse the role file ourselves and
# pass the declared effort with --effort, the only lever that sticks for --bg.
$roleFile = "$FleetHome\agents\$Role.md"
$effort = Get-RoleEffort $Role
$effortArgs = @()
if (Test-LaunchEffort $effort) { $effortArgs = @('--effort', $effort) }

# --- first-turn ceiling (ticket 06): a launch that would start over its role's
# --- config/cycle.json budget fails before assignment and reports the token
# --- contribution by source. The estimate counts the fleet-injected sources
# --- (prompt, role file, simulated session-start injection, settings) at ~4
# --- chars/token plus the configured baselineTokens; calibrating baselineTokens
# --- against measured cache creation is ticket 09's verification. Rollback:
# --- state/flags/launch-ceiling-off, or -Force.
$budget = $null
$ceiling = 0
$ceilings = $null
try { $ceilings = (Read-Json "$FleetHome\config\cycle.json").firstTurnCeilings } catch {}
if ($ceilings -and $ceilings.PSObject.Properties[$Role]) { $ceiling = [int]$ceilings.$Role }
if ($ceiling -gt 0 -and -not (Test-Path "$FleetHome\state\flags\launch-ceiling-off")) {
  $hookChars = 0
  $hookPath = "$FleetHome\hooks\session-start.ps1"
  if (Test-Path $hookPath) {
    $savedEnv = @{}
    foreach ($pair in $envBlock.GetEnumerator()) { $savedEnv[$pair.Key] = [Environment]::GetEnvironmentVariable($pair.Key) }
    try {
      foreach ($pair in $envBlock.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, "$($pair.Value)") }
      $hookChars = ('' | & powershell -NoProfile -ExecutionPolicy Bypass -File $hookPath 2>$null | Out-String).Length
    } catch {} finally {
      foreach ($savedKey in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($savedKey, $savedEnv[$savedKey]) }
    }
  }
  $roleChars = 0
  if (Test-Path $roleFile) { $roleChars = (Get-Content $roleFile -Raw).Length }
  $baseline = 0
  if ($ceilings.PSObject.Properties['baselineTokens']) { $baseline = [int]$ceilings.baselineTokens }
  $sources = [ordered]@{
    baseline = $baseline
    prompt = [int][Math]::Ceiling("$Prompt".Length / 4)
    roleFile = [int][Math]::Ceiling($roleChars / 4)
    sessionStartInjection = [int][Math]::Ceiling($hookChars / 4)
    settings = [int][Math]::Ceiling((Get-Content $settingsPath -Raw).Length / 4)
  }
  $estimate = 0
  foreach ($sourceTokens in $sources.Values) { $estimate += $sourceTokens }
  $budget = [pscustomobject]@{ role = $Role; ceiling = $ceiling; estimatedTokens = $estimate; sources = [pscustomobject]$sources }
  if ($estimate -gt $ceiling -and -not $Force) {
    $ceilingReason = "first-turn ceiling exceeded for role '$Role': $estimate estimated tokens > $ceiling (see budget.sources)"
    $r = Release-ReservationOnRefusal "launch refused: $ceilingReason"
    Write-Output (@{ launched = $false; reason = $ceilingReason; budget = $budget; reservationReleased = $r.released; releaseError = $r.error } | ConvertTo-Json -Compress -Depth 6); exit 6
  }
}

if ($DryRun) {
  Write-Output (@{ launched = $false; dryRun = $true; name = $Name; role = $Role; tenant = $Tenant; parent = $Parent; model = $Model; permissions = $Permissions; allowRules = $allowRuleCount; effort = $effort; cwd = $cwd; settings = $settingsPath; prompt = $Prompt; budget = $budget; liveFleet = $liveFleet.Count; cap = $static.cap; command = "claude --bg --name $Name --agent $Role $($modelArgs -join ' ') $($effortArgs -join ' ') --settings $settingsPath <prompt>".Replace('  ', ' ') } | ConvertTo-Json -Compress -Depth 6)
  exit 0
}

# Trust pre-flight (fleet #104): since Claude Code 2.1.281 `claude --bg` refuses an
# untrusted workspace and creates no session. Checked here, after every other gate and
# before the worktree and branch exist, so an untrusted tenant fails closed with the fix
# named instead of an empty "produced no session". An assignment worktree inherits the
# tenant repo's trust, so the repo path is what has to be trusted.
# state/flags/launch-trust-check-off is the rollback if a later CLI changes the rule.
if (-not (Test-Path "$FleetHome\state\flags\launch-trust-check-off") -and -not (Test-WorkspaceTrusted $cwd)) {
  $trustReason = "workspace not trusted: Claude Code 2.1.281+ refuses ``claude --bg`` in '$cwd' until its trust prompt is accepted; run ``claude`` there once as Cory, accept the prompt, and relaunch (state/flags/launch-trust-check-off skips this check)"
  $released = $false
  if ($Manifest) { try { Invalidate-Manifest "launch refused: $trustReason"; $released = $true } catch {} }
  Write-Output (@{ launched = $false; reason = $trustReason; cwd = $cwd; reservationReleased = $released } | ConvertTo-Json -Compress); exit 7
}

$worktreePath = $null
$expectedBase = $null
# A failed launch must leave neither the assignment worktree nor its branch: `worktree add
# -b` created both, and the orphan fleet/<issue>-... branch made every retry's worktree add
# fail (2026-09-23, #1579 x3, pl-endzone deleted each by hand). The branch goes only while
# its tip is still the manifest base, so a branch that gained a commit is never discarded.
function Remove-FailedAssignmentWorktree {
  if (-not $Manifest) { return }
  if ($worktreePath -and (Test-Path -LiteralPath $worktreePath)) { & git -C $t.repo worktree remove --force $worktreePath 2>$null | Out-Null }
  & git -C $t.repo worktree prune 2>$null | Out-Null
  $branch = [string]$assignment.branch
  if (-not $branch) { return }
  $tip = (& git -C $t.repo rev-parse --verify --quiet "refs/heads/$branch" 2>$null | Out-String).Trim()
  if ($tip -and $expectedBase -and $tip -eq $expectedBase) { & git -C $t.repo branch -D $branch 2>$null | Out-Null }
}
# fleet#264: is this manifest still the owner of its reservation? Returns the reason it is not, or $null.
# Reads the marker and the Work record the way the early checks near the top do (the .invalidated.json
# sidecar, state\work\active.json), and also requires the record's revision to be the one the manifest
# reserved: a release followed by a fresh reservation leaves the record `assigned` at a later revision.
function Get-ReservationRecheckFailure {
  if (Test-Path -LiteralPath "$Manifest.invalidated.json") { return "the manifest was invalidated while this launch was preparing" }
  try { $freshState = Read-Json "$FleetHome\state\work\active.json" } catch { return "the Work record could not be re-read ($($_.Exception.Message))" }
  $freshProperty = if ($freshState) { $freshState.records.PSObject.Properties[$WorkRecordId] } else { $null }
  if (-not $freshProperty) { return "Work record '$WorkRecordId' is no longer active" }
  if ($freshProperty.Value.state -ne 'assigned') { return "Work record '$WorkRecordId' is $($freshProperty.Value.state), not assigned" }
  if ([string]$freshProperty.Value.revision -ne [string]$assignment.workRecordRevision) { return "Work record '$WorkRecordId' moved to revision $($freshProperty.Value.revision) (the manifest reserved revision $($assignment.workRecordRevision))" }
  return $null
}
if ($Manifest) {
  $baseRemote = [string]$assignment.base.remote
  $baseRef = [string]$assignment.base.ref
  $expectedBase = [string]$assignment.base.sha
  if (-not $baseRemote -or -not $baseRef -or $expectedBase -notmatch '^[0-9a-fA-F]{40}$') { $r = Release-ReservationOnRefusal "launch refused: manifest has an invalid base precondition"; Write-Error "manifest '$Manifest' has an invalid base precondition$($r.note)"; exit 4 }
  & git -C $cwd fetch $baseRemote $baseRef --prune 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $r = Release-ReservationOnRefusal "launch refused: could not fetch $baseRemote/$baseRef"; Write-Error "could not fetch $baseRemote/$baseRef for manifest '$Manifest'$($r.note)"; exit 4 }
  $resolvedBase = (& git -C $cwd rev-parse "refs/remotes/$baseRemote/$baseRef" 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $resolvedBase -ne $expectedBase) { $r = Release-ReservationOnRefusal "manifest base precondition changed (expected $expectedBase, found $resolvedBase)"; Write-Error "manifest base precondition changed (expected $expectedBase, found $resolvedBase)$($r.note)"; exit 4 }
  $worktreeParent = Join-Path $cwd '.claude\worktrees'
  $worktreePath = Join-Path $worktreeParent "$Name-assignment"
  # no release: a worktree already at this path is an earlier launch's. The duplicate-name and job-state guards above already said no ic-N session is live, so nothing is about to acknowledge and nothing here removes it: the janitor never removes the worktree of an open issue whose record is assigned or absent, so an operator must remove it. Releasing here would only re-offer the issue into an assign, launch, refuse loop that fails at this line every time (the reservation is what keeps the planner from doing that).
  if (Test-Path -LiteralPath $worktreePath) { Write-Error "assignment worktree already exists: $worktreePath"; exit 4 }
  New-Item -ItemType Directory -Force $worktreeParent | Out-Null
  & git -C $cwd worktree add -b $assignment.branch $worktreePath $expectedBase 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $r = Release-ReservationOnRefusal "launch failed: could not create the assignment worktree from $expectedBase"; Remove-FailedAssignmentWorktree; Write-Error "could not create assignment worktree from $expectedBase$($r.note)"; exit 4 }
  # ic.md step 6: the PR body file is .fleet-pr-body.md in the worktree root, written with
  # the Write tool, not a heredoc into a temp directory outside the allowed directories
  # (fleet #171, rehearsal wait 4). The repo's info/exclude, shared by every worktree,
  # keeps it out of every commit. Best effort: a missing line only risks a stray file.
  $commonDir = (& git -C $worktreePath rev-parse --path-format=absolute --git-common-dir 2>$null | Out-String).Trim()
  if ($commonDir) {
    try {
      $excludePath = Join-Path $commonDir 'info\exclude'
      $excludeLines = @()
      if (Test-Path -LiteralPath $excludePath) { $excludeLines = @(Get-Content -LiteralPath $excludePath) }
      if ($excludeLines -notcontains '/.fleet-pr-body.md') {
        [IO.Directory]::CreateDirectory((Split-Path -Parent $excludePath)) | Out-Null
        [IO.File]::AppendAllText($excludePath, "`n/.fleet-pr-body.md`n")
      }
    } catch { Write-Warning "could not add the PR body file to $excludePath ($_)" }
  }
  $cwd = $worktreePath
}

# --- launch ---
$before = @($daemon | ForEach-Object { $_.sessionId })
$beforeJobIds = @(Get-DaemonSessions -All -NoRetry | ForEach-Object { $_.id })
$locationPushed = $false
# fleet#264: the gh check, fetch and worktree add above take 10-40 s with no job and no roster row, so a
# release that lands in that window (the stranded-reservation sweep, #261) cannot see this launch. Look
# again immediately before claude --bg; an IC started on a released record only fails its ack.
if ($Manifest) {
  $lateRefusal = Get-ReservationRecheckFailure
  if ($lateRefusal) {
    # no release: the reservation is already gone or no longer this manifest's; there is nothing to release. The worktree and branch are this launch's own and nothing can use them.
    Remove-FailedAssignmentWorktree
    Write-Error "launch refused right before claude --bg: $lateRefusal"; exit 4
  }
}
try {
  Push-Location $cwd
  $locationPushed = $true
  # Windows PowerShell 5.1 re-parses embedded double quotes in a string passed
  # as a native positional argument. Fleet briefs contain quoted issue titles,
  # so argv delivery silently truncated every measured IC prompt. stdin is the
  # CLI's prompt input as well, and preserves the exact string without another
  # command-line parse.
  # fleet #265: resolved once (waiting out an npm reinstall); the prompt still goes over stdin.
  $claudeCli = Resolve-ClaudeCli -Tries 3 -PollMs 3000   # a short ladder: the strict read above already resolved once, and the launch must stay inside assignment.js's 90 s
  $out = $Prompt | & $claudeCli --bg --name $Name --agent $Role @modelArgs @effortArgs --settings $settingsPath 2>&1 | Out-String
} catch {
  if ($locationPushed) { Pop-Location; $locationPushed = $false }
  # fleet#256: claude itself failing to run (not on PATH, spawn error) is a refusal too. Release first, then remove the worktree (fleet#251 order); the helper never throws, so the original error is what surfaces.
  [void](Release-ReservationOnRefusal "launch failed: claude --bg threw: $($_.Exception.Message)")
  Remove-FailedAssignmentWorktree
  if ("$($_.Exception.Message)" -match '^(claude CLI not found|FLEET_CLAUDE_CLI does not point)') { Write-Output (Get-ClaudeCliMissingJson @{ launched = $false; reason = "$($_.Exception.Message)" }); exit 6 }   # fleet #265: a CLI still missing after the bounded wait is reported as such, not as a bare exception
  throw
} finally {
  if ($locationPushed) { Pop-Location }
}
$row = $null
for ($i = 0; $i -lt 20 -and -not $row; $i++) {
  Start-Sleep -Milliseconds 750
  $row = Get-DaemonSessions -NoRetry | Where-Object { $_.name -eq $Name -and ($before -notcontains $_.sessionId) } | Select-Object -First 1
}
if (-not $row) {
  $failedRow = Get-DaemonSessions -All -NoRetry |
    Where-Object { $_.name -eq $Name -and ($beforeJobIds -notcontains $_.id) } |
    Select-Object -First 1
  $jobState = if ($failedRow) { Get-JobState $failedRow.id } else { $null }
  $detail = if ($jobState -and $jobState.detail) { "$($jobState.detail)" } else { $null }
  # When the CLI created no job at all, its own output is the only evidence (2.1.281's
  # "Workspace not trusted" refusal reached the manifest as "produced no session ()").
  $why = if ($detail) { $detail } else { ("$out" -replace '\s+', ' ').Trim() }
  if ($why.Length -gt 300) { $why = $why.Substring(0, 300) }
  # A manifest whose launch produced no session must not keep its reservation: the
  # planner would exclude the issue as `reserved` and a fresh assign would hit
  # RESERVATION_CONFLICT. Release it so the next decision can reserve again.
  $released = $false
  $releaseError = $null
  if ($Manifest) { try { Invalidate-Manifest "launch failed: claude --bg produced no session ($why)"; $released = $true } catch { $releaseError = "$($_.Exception.Message)" } }
  # fleet#251: the worktree goes after the release. A session that appears late still finds its
  # assignment worktree until the reservation is actually released; the invalidated manifest
  # then tells its ack to stop (MANIFEST_INVALIDATED). When the release failed, the worktree
  # stays only if the assignment is demonstrably live: the record left `assigned` (a late
  # session acknowledged) or the session list now shows the job. Otherwise it goes as before:
  # a stranded worktree makes every relaunch exit 4 ("already exists") before it can release.
  # An unreadable record and daemon list default to removing the worktree (the pre-#251
  # behaviour): keeping it on no evidence is what strands every relaunch.
  $keepWorktree = $false
  if ($Manifest -and -not $released) {
    try {
      $node = Get-NodeExe
      $currentRecord = (& $node "$PSScriptRoot\work-state.js" get --root $FleetHome --id $WorkRecordId 2>$null | Out-String | ConvertFrom-Json)
      if ($currentRecord -and $currentRecord.state -and "$($currentRecord.state)" -notin @('assigned', 'released')) { $keepWorktree = $true }
    } catch {}
    try {
      $lateRow = Get-DaemonSessions -NoRetry | Where-Object { $_.name -eq $Name -and ($before -notcontains $_.sessionId) } | Select-Object -First 1
      if ($lateRow) { $keepWorktree = $true }
    } catch {}
  }
  if (-not $keepWorktree) { Remove-FailedAssignmentWorktree }
  Write-Output (@{ launched = $false; reason = "claude --bg did not produce a session named '$Name'"; detail = $detail; output = $out; reservationReleased = $released; releaseError = $releaseError; worktreeKept = $keepWorktree } | ConvertTo-Json -Compress); exit 5
}

# --- record ---
# The row carries the resolved manifest path (as FLEET_ASSIGNMENT_MANIFEST does), which
# work-state release matches against the record's manifest to tell a live claim from a stale row.
$rosterManifest = if ($Manifest) { (Resolve-Path -LiteralPath $Manifest).Path } else { $Manifest }
$entry = [pscustomobject]@{
  name = $Name; role = $Role; tenant = $Tenant; parent = $Parent; issue = $Issue; cwd = $cwd
  model = $Model; permissions = $Permissions; effort = $effort
  jobId = $row.id; sessionId = $row.sessionId; prompt = $Prompt; settings = $settingsPath; manifest = $rosterManifest; workRecordId = $WorkRecordId
  status = 'active'; launchedAt = (Now-Iso); retiredAt = $null
}
$live.sessions = @($live.sessions | Where-Object { $_.name -ne $Name }) + @($entry)
Save-LiveRoster $live

# 02/03: reserve the unit before returning. The roster entry now exists, so the projection
# derives the Work record from it immediately instead of leaving it to the next pr-watch
# tick up to five minutes later. In that gap the Stop hook had already dropped the issue
# (it reads the roster) while the planner had not (it reads Work records), so every legacy
# launch manufactured a planner-includes parity difference - and, worse, left a window in
# which the planner would offer an issue an IC was already working. A manifest launch is
# already reserved by `assignment.js assign`, and the projection leaves that record alone.
# Never fatal: the unit is launched either way, and the next tick still projects it.
$projected = $false
if ($Role -eq 'ic') {
  try {
    $node = Get-NodeExe
    & $node "$PSScriptRoot\work-state.js" shadow --root $FleetHome --actor launch 2>&1 | Out-Null
    $projected = ($LASTEXITCODE -eq 0)
  } catch { $projected = $false }
}
Write-Output (@{ launched = $true; name = $Name; jobId = $row.id; sessionId = $row.sessionId; cwd = $cwd; projected = $projected } | ConvertTo-Json -Compress)
exit 0
