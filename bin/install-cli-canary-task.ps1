# Register the fleet #337 CLI canary (bin/cli-canary.ps1 via run-cli-canary.ps1), once a day.
# Run manually; the fleet never self-registers tasks (same convention as every other install-*-task.ps1).
[CmdletBinding()]
param([switch]$DryRun)

$taskName = 'Fleet CLI canary'
$scriptPath = Join-Path $PSScriptRoot 'run-cli-canary.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At '03:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($DryRun) {
  [pscustomobject]@{
    taskName = $taskName
    script = $scriptPath
    schedule = '03:00 daily'
    action = $action.Execute
    arguments = $action.Arguments
  } | ConvertTo-Json -Compress
  exit 0
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Fleet #337: probe the newest Claude Code release against every tier; open a PR when every open tier passes, else file an issue' -Force | Out-Null
Write-Output "Registered '$taskName' (daily at 03:00)."
Write-Output "Run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Remove with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:0"
