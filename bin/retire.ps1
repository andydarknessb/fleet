# Mark a fleet session retired and stop it. Used by project leads after merge, and by the Sentinel.
param([Parameter(Mandatory)][string]$Name, [string]$Reason = 'done')
. "$PSScriptRoot\_common.ps1"
$live = Get-LiveRoster
$e = $live.sessions | Where-Object { $_.name -eq $Name }
if (-not $e) { Write-Error "no live roster entry named '$Name'"; exit 4 }
if ($e.jobId) { & claude stop $e.jobId 2>$null | Out-Null; & claude rm $e.jobId 2>$null | Out-Null }
$e.status = 'retired'
$e | Add-Member -NotePropertyName retiredAt -NotePropertyValue (Now-Iso) -Force
$e | Add-Member -NotePropertyName retiredBecause -NotePropertyValue $Reason -Force
Save-LiveRoster $live
Remove-Item "$FleetHome\state\heartbeats\$Name.json" -ErrorAction SilentlyContinue
Write-Output (@{ retired = $Name; reason = $Reason } | ConvertTo-Json -Compress)
