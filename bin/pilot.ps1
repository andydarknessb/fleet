# Start the pilot: sentinel, dispatcher, pl-endzone. ICs are launched by pl-endzone.
param([switch]$DryRun)
. "$PSScriptRoot\_common.ps1"
# Every static roster entry, minus a cut-over Sentinel (state/flags/sentinel-off: the watchdog task supervises).
if (Test-SentinelOff) { Write-Output 'sentinel: cut over (state/flags/sentinel-off); the watchdog task supervises, not launching' }
foreach ($n in @((Get-ExpectedStaticSessions) | ForEach-Object { $_.name })) {
  Write-Output "launching $n ..."
  if ($DryRun) { & "$PSScriptRoot\launch.ps1" -FromRoster $n -DryRun } else { & "$PSScriptRoot\launch.ps1" -FromRoster $n }
}
if (-not $DryRun) { & "$PSScriptRoot\status.ps1" }
