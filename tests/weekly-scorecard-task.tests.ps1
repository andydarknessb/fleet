# #131: the weekly scorecard's installer registers a Monday task and -DryRun prints the plan.
$ErrorActionPreference = 'Stop'
$fleetHome = Split-Path -Parent $PSScriptRoot
$runner = Get-Content "$fleetHome\bin\run-weekly-scorecard.ps1" -Raw
$installer = Get-Content "$fleetHome\bin\install-weekly-scorecard-task.ps1" -Raw

if ($runner -notmatch "weekly-scorecard\.js") { throw 'scorecard runner does not invoke weekly-scorecard.js' }
if ($runner -notmatch "state\\metrics") { throw 'scorecard runner must log under state/metrics' }
if ($installer -notmatch "Register-ScheduledTask") { throw 'scorecard installer must register a scheduled task' }
if ($installer -notmatch "-Weekly -DaysOfWeek Monday") { throw 'scorecard installer must register a Monday task' }

$dryRun = & powershell -NoProfile -ExecutionPolicy Bypass -File "$fleetHome\bin\install-weekly-scorecard-task.ps1" -DryRun | Out-String | ConvertFrom-Json
if ($dryRun.taskName -ne 'Fleet weekly scorecard') { throw "dry-run task name mismatch: $($dryRun.taskName)" }
if ($dryRun.schedule -ne 'weekly on Monday at 07:30 local time') { throw "scorecard schedule mismatch: $($dryRun.schedule)" }
if ($dryRun.arguments -notmatch 'run-weekly-scorecard\.ps1') { throw 'dry-run action does not run the scorecard runner' }
Write-Output 'weekly-scorecard task tests passed'
