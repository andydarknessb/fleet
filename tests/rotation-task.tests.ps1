$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$dry = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$sourceRoot\bin\install-rotation-task.ps1" -DryRun | Out-String) | ConvertFrom-Json

Assert-True ($dry.taskName -eq 'Fleet rotation') 'the task must be named Fleet rotation'
Assert-True ($dry.schedule -match '15 minutes') 'the schedule must run every 15 minutes'
Assert-True ($dry.logonDelay -eq 'PT8M') 'the logon trigger must wait behind recovery, the watchdog, and pr-watch'
Assert-True ($dry.arguments -match 'run-rotation\.ps1') 'the action must run the wrapper'
Assert-True (Test-Path $dry.script) 'the wrapper path must exist'

$src = Get-Content "$sourceRoot\bin\install-rotation-task.ps1" -Raw
Assert-True ($src -match 'MultipleInstances IgnoreNew') 'overlapping runs must be ignored, not queued'
Assert-True ($src -match 'AllowStartIfOnBatteries') 'rotation must run on battery'

$wrapper = Get-Content "$sourceRoot\bin\run-rotation.ps1" -Raw
Assert-True ($wrapper -match 'rotate\.ps1') 'the wrapper must invoke rotate.ps1'
Assert-True ($wrapper -match '-Auto') 'the wrapper must run the auto policy'
Assert-True ($wrapper -match 'exit 3') 'the wrapper must treat a refusal (PAUSE, flag) as a quiet no-op'

Write-Output 'rotation task tests passed'
