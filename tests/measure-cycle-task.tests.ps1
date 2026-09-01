$ErrorActionPreference = 'Stop'
$fleetHome = Split-Path -Parent $PSScriptRoot
$runner = Get-Content "$fleetHome\bin\run-cycle-collector.ps1" -Raw
$installer = Get-Content "$fleetHome\bin\install-cycle-collector-task.ps1" -Raw

if ($runner -notmatch "measure-cycle\.js") { throw 'collector runner does not invoke measure-cycle.js' }
if ($runner -notmatch "--since|--until|--now") { throw 'collector runner must use a bounded deterministic window' }
if ($runner -notmatch "state\\metrics") { throw 'collector runner must write under state/metrics' }
if ($installer -notmatch "Register-ScheduledTask") { throw 'collector installer must register a scheduled task' }
if ($installer -notmatch "Fleet cycle collector") { throw 'collector task name changed unexpectedly' }

$dryRun = & powershell -NoProfile -ExecutionPolicy Bypass -File "$fleetHome\bin\install-cycle-collector-task.ps1" -DryRun | Out-String | ConvertFrom-Json
if ($dryRun.taskName -ne 'Fleet cycle collector') { throw 'dry-run task metadata mismatch' }
if ($dryRun.schedule -ne 'daily at 07:45 local time') { throw 'collector schedule mismatch' }
Write-Output 'measure-cycle task tests passed'
