$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$dry = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$sourceRoot\bin\install-pr-watch-task.ps1" -DryRun | Out-String) | ConvertFrom-Json

Assert-True ($dry.taskName -eq 'Fleet PR watch') 'the task must be named Fleet PR watch'
Assert-True ($dry.schedule -match '5 minutes') 'the schedule must run every 5 minutes'
Assert-True ($dry.logonDelay -eq 'PT6M') 'the logon trigger must wait behind recovery (PT2M) and the watchdog (PT4M)'
Assert-True ($dry.arguments -match 'run-pr-watch\.ps1') 'the action must run the wrapper'
Assert-True (Test-Path $dry.script) 'the wrapper path must exist'

$src = Get-Content "$sourceRoot\bin\install-pr-watch-task.ps1" -Raw
Assert-True ($src -match 'MultipleInstances IgnoreNew') 'overlapping runs must be ignored, not queued'
Assert-True ($src -match 'AllowStartIfOnBatteries') 'the watcher must run on battery'

$wrapper = Get-Content "$sourceRoot\bin\run-pr-watch.ps1" -Raw
Assert-True ($wrapper -match 'FLEET_NODE_PATH') 'the wrapper must honor FLEET_NODE_PATH like the collector'
Assert-True ($wrapper -match 'pr-watch\.js') 'the wrapper must invoke pr-watch.js'
Assert-True ($wrapper -match 'digest\.js') 'the wrapper must rebuild the ticket-07 projections after the tick'
Assert-True ($wrapper -notmatch 'notify\.js') 'the wrapper never runs the notifier: a decision event launches it'

Write-Output 'pr-watch task tests passed'
