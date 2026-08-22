# Registers a per-user Task Scheduler job that runs recover.ps1 two minutes after logon. Run this yourself; the fleet never does.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Users\Cory\fleet\bin\recover.ps1'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT2M'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'Fleet recover at logon' -Action $action -Trigger $trigger -Settings $settings -Description 'Relaunch the Claude Code fleet roster after login' -Force
Write-Output "Registered 'Fleet recover at logon' (2 min after logon)."
Write-Output "Remove with: Unregister-ScheduledTask -TaskName 'Fleet recover at logon' -Confirm:0"
