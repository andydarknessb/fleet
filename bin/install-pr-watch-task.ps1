# Register the ticket-04 PR watcher. Run manually; the fleet never self-registers tasks.
[CmdletBinding()]
param([switch]$DryRun)

$taskName = 'Fleet PR watch'
$scriptPath = Join-Path $PSScriptRoot 'run-pr-watch.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT6M'   # after recovery (PT2M) and the watchdog (PT4M): watch a recovered fleet
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = 'every 5 minutes while logged on; also 6 min after logon'
    repetitionInterval = "$($repeat.Repetition.Interval)"
    logonDelay = "$($logon.Delay)"
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($repeat, $logon) -Settings $settings -Description 'Fleet 04 PR watcher: reconcile Work records, event on change, eligible wakes to the outbox' -Force | Out-Null
Write-Output "Registered '$taskName' (every 5 minutes; 6 min after logon)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
