# Set or clear the fleet-wide PAUSE. With PAUSE set, nothing launches and project leads stop their loops.
param([switch]$Off, [string]$Reason = 'manual', [int]$Minutes = 0)
. "$PSScriptRoot\_common.ps1"
$p = "$FleetHome\state\PAUSE"
if ($Off) { Remove-Item $p -ErrorAction SilentlyContinue; Write-Output "PAUSE cleared"; exit 0 }
$until = ''
if ($Minutes -gt 0) { $until = (Get-Date).ToUniversalTime().AddMinutes($Minutes).ToString('o') }
[IO.File]::WriteAllText($p, "reason=$Reason; setAt=$(Now-Iso); until=$until", $Utf8)
$suffix = ''
if ($until) { $suffix = ", until $until" }
Write-Output "PAUSE set ($Reason)$suffix"
