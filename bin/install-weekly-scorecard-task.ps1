# Register the #131 weekly scorecard (bin/weekly-scorecard.js via run-weekly-scorecard.ps1).
# Run manually; the fleet never self-registers tasks. Mondays at 07:30 local time, so the
# 08:00 daily summary that follows carries the new week's headline. The scorecard reads
# the previous Monday-to-Sunday week in UTC, which a Monday-morning run on a Central host
# (12:30 or 13:30 UTC) always sees whole.
[CmdletBinding()]
param([switch]$DryRun)

$taskName = 'Fleet weekly scorecard'
$scriptPath = Join-Path $PSScriptRoot 'run-weekly-scorecard.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At ([datetime]::Today.AddHours(7).AddMinutes(30))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = 'weekly on Monday at 07:30 local time'
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Fleet #131: the weekly scorecard for the previous Monday-to-Sunday week' -Force | Out-Null
Write-Output "Registered '$taskName' (weekly on Monday at 07:30 local time)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
