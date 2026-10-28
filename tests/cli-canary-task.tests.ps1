$ErrorActionPreference = 'Stop'
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$dry = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$sourceRoot\bin\install-cli-canary-task.ps1" -DryRun | Out-String) | ConvertFrom-Json

Assert-True ($dry.taskName -eq 'Fleet CLI canary') 'the task must be named Fleet CLI canary'
Assert-True ($dry.schedule -match 'daily') 'the schedule must run once a day'
Assert-True ($dry.arguments -match 'run-cli-canary\.ps1') 'the action must run the wrapper'
Assert-True (Test-Path $dry.script) 'the wrapper path must exist'

$src = Get-Content "$sourceRoot\bin\install-cli-canary-task.ps1" -Raw
Assert-True ($src -match 'MultipleInstances IgnoreNew') 'overlapping runs must be ignored, not queued'
$wrapper = Get-Content "$sourceRoot\bin\run-cli-canary.ps1" -Raw
Assert-True ($wrapper -match 'cli-canary\.ps1') 'the wrapper must invoke cli-canary.ps1'

Write-Output 'cli-canary task tests passed'
