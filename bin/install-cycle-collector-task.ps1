# Register the daily read-only cycle collector. Run manually; the fleet never self-registers tasks.
[CmdletBinding()]
param([switch]$DryRun)

$fleetHome = Split-Path -Parent $PSScriptRoot
$taskName = 'Fleet cycle collector'
$scriptPath = Join-Path $PSScriptRoot 'run-cycle-collector.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -IfMissing"
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(7).AddMinutes(45))
# Ticket 443: one action for both triggers, so -IfMissing also guards the morning run: a day gets one run.
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT10M'   # after the four logon tasks (PT2M to PT8M): the network may not be up at a cold boot
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = 'daily at 07:45 local time'
    logonTrigger = "at logon of $($logon.UserId)"
    logonDelay = "$($logon.Delay)"
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger, $logon) -Settings $settings -Description 'Collect read-only Fleet cycle efficiency metrics' -Force | Out-Null
Write-Output "Registered '$taskName' (daily at 07:45 local time, and at logon)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName' does nothing on a day whose file already exists (the action passes -IfMissing)."
Write-Output "Force a run now: powershell -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
