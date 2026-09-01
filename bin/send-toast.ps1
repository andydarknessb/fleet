# Ticket 07 notifier channel: one Windows toast, one JSON result line. Called by
# bin/notify.js; never loops, never retries.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

$delivered = Send-FleetToast $Title $Body
$detail = if ($delivered) { 'toast shown' } else { 'toast API unavailable (ToastNotificationManager threw)' }
Write-Output (@{ delivered = [bool]$delivered; detail = $detail } | ConvertTo-Json -Compress)
exit 0
