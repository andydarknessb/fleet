<#
.SYNOPSIS  Ticket 08b: restore the rostered Sentinel as the supervisor (rollback within one release).
  Removes state/flags/sentinel-off (the watchdog returns to shadow at its next tick and
  every reader expects the Sentinel again), then launches the Sentinel through the one
  door (launch.ps1 -FromRoster sentinel, ADR 0002) from its retained roster.json entry.
  If the launch is refused or fails, the flag is put back: a fleet with no supervisor is
  worse than one supervised by the watchdog. Nothing else moves: event ledgers, the
  applied ledger, the shadow log, and Work records are untouched, so no offset is lost.
.EXAMPLE   rollback-sentinel.ps1 -DryRun      # show the plan; launch.ps1 -DryRun checks its gates
.EXAMPLE   rollback-sentinel.ps1
#>
[CmdletBinding()]
param([switch]$DryRun)
. "$PSScriptRoot\_common.ps1"
$ErrorActionPreference = 'Continue'
$flagPath = "$FleetHome\state\flags\sentinel-off"
$cutoverPath = "$FleetHome\state\sentinel\cutover.json"

function Emit { param($Obj, [int]$Code) Write-Output ($Obj | ConvertTo-Json -Compress -Depth 8); exit $Code }

if (-not (Test-SentinelOff)) {
  Emit ([ordered]@{ rolledBack = $false; reason = 'state/flags/sentinel-off is absent: the rostered Sentinel is already the supervisor (launch it with launch.ps1 -FromRoster sentinel if it is missing)' }) 0
}
$static = Get-StaticRoster
if (-not ($static.sessions | Where-Object { $_.name -eq 'sentinel' })) {
  Emit ([ordered]@{ rolledBack = $false; reason = 'roster.json has no sentinel entry: the rollback path was removed; restore the entry (and agents/sentinel.md) first' }) 4
}
$flagText = ''; try { $flagText = Get-Content $flagPath -Raw } catch {}

if ($DryRun) {
  $dry = ConvertFrom-LastJsonLine (& "$PSScriptRoot\launch.ps1" -FromRoster sentinel -DryRun 2>&1 | Out-String)
  Emit ([ordered]@{ rolledBack = $false; dryRun = $true; steps = @('remove state/flags/sentinel-off', 'launch.ps1 -FromRoster sentinel', 'append a rollback record to state/sentinel/cutover.json'); launchPlan = $dry }) 0
}

Remove-Item $flagPath -ErrorAction SilentlyContinue
$launchRaw = & "$PSScriptRoot\launch.ps1" -FromRoster sentinel 2>&1 | Out-String
$launchExit = $LASTEXITCODE
$launch = ConvertFrom-LastJsonLine $launchRaw
$launched = [bool]($launch -and $launch.launched)
if (-not $launched) {
  # Put the supervisor back: the watchdog resumes live supervision at its next tick.
  [IO.Directory]::CreateDirectory("$FleetHome\state\flags") | Out-Null
  [IO.File]::WriteAllText($flagPath, $flagText, $Utf8)
  $reason = if ($launch -and $launch.reason) { "$($launch.reason)" } else { ($launchRaw -replace '\s+', ' ').Trim() }
  Emit ([ordered]@{ rolledBack = $false; flagRestored = $true; launchExit = $launchExit; reason = "Sentinel launch did not succeed ($reason); state/flags/sentinel-off restored so the watchdog keeps supervising" }) 5
}

$record = $null; try { $record = Read-Json $cutoverPath } catch {}
if (-not $record) { $record = [pscustomobject]@{ at = $null; rollbacks = @() } }
if ($null -eq $record.PSObject.Properties['rollbacks']) { $record | Add-Member -NotePropertyName rollbacks -NotePropertyValue @() -Force }
$record.rollbacks = @($record.rollbacks) + @([pscustomobject]@{ at = (Now-Iso); jobId = $launch.jobId; sessionId = $launch.sessionId })
[IO.Directory]::CreateDirectory("$FleetHome\state\sentinel") | Out-Null
Write-Json $cutoverPath $record
Emit ([ordered]@{ rolledBack = $true; jobId = $launch.jobId; sessionId = $launch.sessionId; record = $cutoverPath; note = 'the watchdog returns to shadow at its next tick; the Sentinel recreates its 15-minute cron from its SessionStart context' }) 0
