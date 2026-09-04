<#
.SYNOPSIS  02/03 cutover: restore the legacy assignment path (rollback within one release).
  Removes state/flags/assignment-live (the Stop hook decides from its own frontier again and
  launch.ps1 accepts a legacy IC prompt), then releases every manifest still pending
  acknowledgment: its Work record is in `assigned` with a manifest, so it leaves through the
  work-state `release` door (assignment-released event, record archived) and the manifest gets
  its invalidated sidecar; otherwise the legacy hook would launch the same issue on top of a
  standing reservation. Acknowledged assignments (implementing and beyond) are real ICs and
  keep running to completion. Event ledgers are appended to, never rewritten; nothing else moves.
.EXAMPLE   rollback-assignment.ps1 -DryRun      # show the plan and the manifests it would release
.EXAMPLE   rollback-assignment.ps1
#>
[CmdletBinding()]
param([switch]$DryRun)
. "$PSScriptRoot\_common.ps1"
$ErrorActionPreference = 'Continue'
$flagPath = "$FleetHome\state\flags\assignment-live"
$cutoverPath = "$FleetHome\state\assignment\cutover.json"

function Emit { param($Obj, [int]$Code) Write-Output ($Obj | ConvertTo-Json -Compress -Depth 8); exit $Code }

if (-not (Test-AssignmentLive)) {
  Emit ([ordered]@{ rolledBack = $false; reason = 'state/flags/assignment-live is absent: the legacy assignment path is already authoritative' }) 0
}

# Pending-acknowledgment assignments: assigned records carrying a manifest.
$pending = @()
$activeState = $null; try { $activeState = Read-Json "$FleetHome\state\work\active.json" } catch {}
if ($activeState -and $activeState.records) {
  foreach ($property in $activeState.records.PSObject.Properties) {
    $record = $property.Value
    if ("$($record.state)" -eq 'assigned' -and $record.manifestPath) {
      $manifestId = $null; try { $manifestId = (Read-Json $record.manifestPath).id } catch {}
      $pending += [pscustomobject]@{ id = $record.id; revision = [int]$record.revision; manifestPath = "$($record.manifestPath)"; manifestId = $manifestId }
    }
  }
}

if ($DryRun) {
  Emit ([ordered]@{ rolledBack = $false; dryRun = $true; steps = @('remove state/flags/assignment-live', 'release each pending-acknowledgment assignment through work-state.js release', 'append a rollback record to state/assignment/cutover.json'); pending = $pending }) 0
}

$flagText = ''; try { $flagText = Get-Content $flagPath -Raw } catch {}
Remove-Item $flagPath -ErrorAction SilentlyContinue

$released = @(); $failed = @()
$node = $null; try { $node = Get-NodeExe } catch {}
foreach ($entry in $pending) {
  $key = "assignment-rollback:$(if ($entry.manifestId) { $entry.manifestId } else { $entry.id })"
  $ok = $false; $detail = ''
  if ($node) {
    $raw = & $node "$PSScriptRoot\work-state.js" release --root $FleetHome --id $entry.id --expected-revision $entry.revision --idempotency-key $key --evidence 'rollback-assignment.ps1: legacy assignment path restored before acknowledgment' --actor rollback-assignment 2>&1 | Out-String
    $ok = ($LASTEXITCODE -eq 0); $detail = ($raw -replace '\s+', ' ').Trim()
  } else { $detail = 'node unavailable' }
  if ($ok) {
    $sidecar = "$($entry.manifestPath).invalidated.json"
    if (-not (Test-Path -LiteralPath $sidecar)) { Write-Json $sidecar ([pscustomobject]@{ schemaVersion = 1; manifestId = $entry.manifestId; invalidatedAt = (Now-Iso); reason = 'rollback-assignment.ps1: legacy assignment path restored before acknowledgment' }) }
    $released += $entry.id
  } else { $failed += [pscustomobject]@{ id = $entry.id; detail = $detail } }
}

$flagRestored = $false
if ($failed.Count -gt 0) {
  # Put the flag back: a standing reservation the legacy hook cannot see would be launched
  # on top of (the hook counts roster ICs, not Work records). Under the flag the hook fails
  # closed instead, which is the safer of the two.
  [IO.Directory]::CreateDirectory("$FleetHome\state\flags") | Out-Null
  [IO.File]::WriteAllText($flagPath, $flagText, $Utf8)
  $flagRestored = $true
}
$record = $null; try { $record = Read-Json $cutoverPath } catch {}
if (-not $record) { $record = [pscustomobject]@{ at = $null; rollbacks = @() } }
if ($null -eq $record.PSObject.Properties['rollbacks']) { $record | Add-Member -NotePropertyName rollbacks -NotePropertyValue @() -Force }
$record.rollbacks = @($record.rollbacks) + @([pscustomobject]@{ at = (Now-Iso); rolledBack = (-not $flagRestored); released = $released; failed = $failed; flagRestored = $flagRestored })
[IO.Directory]::CreateDirectory("$FleetHome\state\assignment") | Out-Null
Write-Json $cutoverPath $record
if ($flagRestored) {
  Emit ([ordered]@{ rolledBack = $false; flagRestored = $true; released = $released; failed = $failed; record = $cutoverPath; reason = 'one or more pending assignments could not be released; state/flags/assignment-live restored so the legacy hook does not launch on top of a standing reservation' }) 5
}
Emit ([ordered]@{ rolledBack = $true; released = $released; failed = $failed; record = $cutoverPath; note = 'the project lead decides from its legacy frontier at its next Stop-hook evaluation; acknowledged assignments keep running' }) 0
