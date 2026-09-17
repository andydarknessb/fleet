# Ticket 76 (ADR 0012): the one page door, callable directly. Called by the
# Notifier and by Watchdog condition routing (later tickets); never loops, never
# retries.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [Parameter(Mandatory = $true)][ValidateSet('emergency', 'high', 'normal')][string]$Priority,
  [string]$Url,
  [string]$Detail,
  [switch]$NoToast
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

$result = Send-FleetPage -Kind $Kind -Title $Title -Body $Body -Priority $Priority -Url $Url -Detail $Detail -NoToast:$NoToast
Write-Output ($result | ConvertTo-Json -Compress -Depth 6)
exit 0
