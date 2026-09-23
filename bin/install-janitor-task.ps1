# Registers the ticket-09 weekly janitor (fleet #88). Run this yourself; the fleet never
# registers scheduled tasks. Also removes the dead "Fleet weekly-limit recheck" task
# (last ran 2026-09-08 with result 1; fleet audit 2026-09-17, recommendation K) - it is
# superseded by this weekly run, and an unregistered task that no longer exists is a
# no-op, not an error.
[CmdletBinding()]
param([switch]$DryRun)

$taskName = 'Fleet janitor'
$scriptPath = Join-Path $PSScriptRoot 'janitor.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -Apply"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '4:00am'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = 'weekly, Sunday 4:00am'
    action = $action.Execute
    arguments = $action.Arguments
    alsoRemoves = 'Fleet weekly-limit recheck'
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Ticket 09 weekly janitor: worktrees, state litter, settled escalations (fleet #88)' -Force | Out-Null
Write-Output "Registered '$taskName' (weekly, Sunday 4:00am)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"

try {
  if (Get-ScheduledTask -TaskName 'Fleet weekly-limit recheck' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'Fleet weekly-limit recheck' -Confirm:$false
    Write-Output "Removed the dead 'Fleet weekly-limit recheck' task (superseded by '$taskName')."
  } else {
    Write-Output "'Fleet weekly-limit recheck' was not registered; nothing to remove."
  }
} catch {
  Write-Output "Could not remove 'Fleet weekly-limit recheck': $($_.Exception.Message). Remove it by hand: Unregister-ScheduledTask -TaskName 'Fleet weekly-limit recheck' -Confirm:0"
}
