# Register the fleet watchdog (ticket 08a): shadow supervision + external page path.
# Run manually; the fleet never self-registers tasks. Runs only while the user is
# logged on (interactive session; toasts need it), consistent with ADR-0003.
[CmdletBinding()]
param([switch]$DryRun)

$taskName = 'Fleet watchdog'
$scriptPath = Join-Path $PSScriptRoot 'watchdog.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT4M'   # after the recovery task's PT2M, so it observes the recovered fleet
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = 'every 15 minutes while logged on; also 4 min after logon'
    repetitionInterval = "$($repeat.Repetition.Interval)"
    logonDelay = "$($logon.Delay)"
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($repeat, $logon) -Settings $settings -Description 'Fleet 08a shadow supervisor: parity log + page path (toast/banner) + launch retry cap' -Force | Out-Null
Write-Output "Registered '$taskName' (every 15 minutes; 4 min after logon)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
