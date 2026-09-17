# Register the ticket-80 daily summary (bin/daily-summary.js via
# run-daily-summary.ps1). Run manually; the fleet never self-registers tasks
# (same convention as every other install-*-task.ps1 in this directory).
[CmdletBinding()]
param([switch]$DryRun)

# ADR 0012 fixed the schedule at 08:00 Central (America/Chicago) wall time,
# DST included. A Task Scheduler `-Daily -At` trigger fires at that clock
# reading on the HOST's own local clock, and Windows keeps a host's local
# clock correct across a DST change by construction - so 08:00 stays 08:00
# Central for as long as, and only as long as, the host's own time zone IS
# Central. On any other host "08:00 local" is a different instant than
# Cory's actual morning, so this refuses to register rather than page at the
# wrong hour. (Consistent with ADR 0003: a paging task here runs as the
# interactive user, not unattended at boot, because the page - like every
# other page in this fleet - is aimed at Cory being at his desk.)
$zoneId = [System.TimeZoneInfo]::Local.Id
$zoneOk = $zoneId -eq 'Central Standard Time'

$taskName = 'Fleet daily summary'
$scriptPath = Join-Path $PSScriptRoot 'run-daily-summary.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At '08:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# fleet#79 QA round 1, item 11: the zone refusal used to throw BEFORE this
# branch, so `-DryRun` on the wrong host never showed the plan at all - the
# one case a dry run exists for. It always shows what would be registered now,
# and says plainly whether the zone check would refuse it.
if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = '08:00 Central daily'
    timeZone = $zoneId
    wouldRegister = $zoneOk
    refusalReason = if ($zoneOk) { $null } else { "host time zone is '$zoneId', not 'Central Standard Time'" }
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

if (-not $zoneOk) {
  throw "This host's time zone is '$zoneId', not 'Central Standard Time'. The daily summary is fixed at 08:00 Central (ADR 0012, ticket 80); registering it here would page at the wrong hour. Set the host to Central time before running this installer."
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Fleet ticket 80: one 08:00 Central page of what is waiting on Cory, with ages' -Force | Out-Null
Write-Output "Registered '$taskName' (daily at 08:00 Central)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
