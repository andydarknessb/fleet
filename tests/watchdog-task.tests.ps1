$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$dry = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$sourceRoot\bin\install-watchdog-task.ps1" -DryRun | Out-String) | ConvertFrom-Json

Assert-True ($dry.taskName -eq 'Fleet watchdog') 'the task must be named Fleet watchdog'
Assert-True ($dry.schedule -match '15 minutes') 'the schedule must run every 15 minutes'
Assert-True ($dry.schedule -match 'logon') 'the schedule must include the post-logon trigger'
Assert-True ($dry.arguments -match 'watchdog\.ps1') 'the action must run watchdog.ps1'
Assert-True (Test-Path $dry.script) 'the script path must exist'

$src = Get-Content "$sourceRoot\bin\install-watchdog-task.ps1" -Raw
Assert-True ($src -match 'MultipleInstances IgnoreNew') 'overlapping runs must be ignored, not queued'
Assert-True ($src -match "Delay = 'PT4M'") 'the logon trigger must wait behind the recovery task (PT2M)'
Assert-True ($src -match 'Register-ScheduledTask') 'the non-dry path must register the task'

Write-Output 'watchdog task tests passed'
