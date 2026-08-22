# Start the pilot: sentinel, dispatcher, pl-endzone. ICs are launched by pl-endzone.
param([switch]$DryRun)
. "$PSScriptRoot\_common.ps1"
foreach ($n in 'sentinel','dispatcher','pl-endzone') {
  Write-Output "launching $n ..."
  if ($DryRun) { & "$PSScriptRoot\launch.ps1" -FromRoster $n -DryRun } else { & "$PSScriptRoot\launch.ps1" -FromRoster $n }
}
if (-not $DryRun) { & "$PSScriptRoot\status.ps1" }
