# Register the #218 weekly review-category notice (bin/review-categories.js via
# run-weekly-review-categories.ps1). Run manually; the fleet never self-registers tasks.
# Mondays at 07:40 local time, after the 07:30 scorecard. It reads the previous
# Monday-to-Sunday week in UTC, which a Monday-morning run on a Central host (12:40 or
# 13:40 UTC) always sees whole, and stamps a notice that expires a week later, the next
# Monday, when the next run replaces it.
[CmdletBinding()]
param([switch]$DryRun)

$taskName = 'Fleet weekly review categories'
$scriptPath = Join-Path $PSScriptRoot 'run-weekly-review-categories.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At ([datetime]::Today.AddHours(7).AddMinutes(40))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = 'weekly on Monday at 07:40 local time'
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Fleet #218: the previous week''s top review categories as a dated IC notice' -Force | Out-Null
Write-Output "Registered '$taskName' (weekly on Monday at 07:40 local time)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
