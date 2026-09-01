# Register the ticket-06 rotation runner. Run manually; the fleet never self-registers tasks.
[CmdletBinding()]
param([switch]$DryRun)

$taskName = 'Fleet rotation'
$scriptPath = Join-Path $PSScriptRoot 'run-rotation.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT8M'   # after recovery (PT2M), the watchdog (PT4M), and pr-watch (PT6M): rotate a settled fleet
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = 'every 15 minutes while logged on; also 8 min after logon'
    repetitionInterval = "$($repeat.Repetition.Interval)"
    logonDelay = "$($logon.Delay)"
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($repeat, $logon) -Settings $settings -Description 'Fleet 06 rotation: resume interrupted rotations, rotate control-plane sessions past their thresholds' -Force | Out-Null
Write-Output "Registered '$taskName' (every 15 minutes; 8 min after logon)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
