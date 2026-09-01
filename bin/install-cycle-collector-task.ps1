# Register the daily read-only cycle collector. Run manually; the fleet never self-registers tasks.
[CmdletBinding()]
param([switch]$DryRun)

$fleetHome = Split-Path -Parent $PSScriptRoot
$taskName = 'Fleet cycle collector'
$scriptPath = Join-Path $PSScriptRoot 'run-cycle-collector.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(7).AddMinutes(45))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = 'daily at 07:45 local time'
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Collect read-only Fleet cycle efficiency metrics' -Force | Out-Null
Write-Output "Registered '$taskName' (daily at 07:45 local time)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
