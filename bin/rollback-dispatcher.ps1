<#
.SYNOPSIS  WS5 (fleet #82, spec #194): bring the retired dispatcher back (rollback within one release).
  Refuses (exit 3) when state/flags/dispatcher-off is absent. Otherwise removes the flag (every
  reader expects the dispatcher again), relaunches it through the one door
  (launch.ps1 -FromRoster dispatcher, ADR 0002) from its retained roster.json entry, and
  appends {at, reason, launched, result} to state/dispatcher/cutover.json's rollbacks.
  The role texts and glossary changes of the sibling ticket (#300) are NOT restored here:
  they come back by git revert.
.EXAMPLE   rollback-dispatcher.ps1
.EXAMPLE   rollback-dispatcher.ps1 -Reason 'pages missed the 02:00 stall'
#>
[CmdletBinding()]
param([string]$Reason = 'manual rollback')
. "$PSScriptRoot\_common.ps1"
$ErrorActionPreference = 'Continue'
$flagPath = "$FleetHome\state\flags\dispatcher-off"
$cutoverPath = "$FleetHome\state\dispatcher\cutover.json"

function Emit { param($Obj, [int]$Code) Write-Output ($Obj | ConvertTo-Json -Compress -Depth 8); exit $Code }

if (-not (Test-DispatcherOff)) {
  Emit ([ordered]@{ rolledBack = $false; reason = 'state/flags/dispatcher-off is absent: the dispatcher is not retired (launch it with launch.ps1 -FromRoster dispatcher if it is missing)' }) 3
}

Remove-Item $flagPath -ErrorAction SilentlyContinue
$launchRaw = & "$PSScriptRoot\launch.ps1" -FromRoster dispatcher 2>&1 | Out-String
$launch = ConvertFrom-LastJsonLine $launchRaw
$launched = [bool]($launch -and $launch.launched)

$record = $null; try { $record = Read-Json $cutoverPath } catch {}
if (-not $record) { $record = [pscustomobject]@{ at = $null; rollbacks = @() } }
if ($null -eq $record.PSObject.Properties['rollbacks']) { $record | Add-Member -NotePropertyName rollbacks -NotePropertyValue @() -Force }
$result = if ($launch) { $launch } else { ($launchRaw -replace '\s+', ' ').Trim() }
$record.rollbacks = @($record.rollbacks) + @([pscustomobject]@{ at = (Now-Iso); reason = $Reason; launched = $launched; result = $result })
[IO.Directory]::CreateDirectory("$FleetHome\state\dispatcher") | Out-Null
Write-Json $cutoverPath $record
Emit ([ordered]@{ rolledBack = $true; launched = $launched; flagRemoved = $true; result = $result; record = $cutoverPath }) $(if ($launched) { 0 } else { 5 })
