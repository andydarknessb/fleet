# #218: the weekly review-category notice's installer registers a Monday task and -DryRun prints the plan.
$ErrorActionPreference = 'Stop'
$fleetHome = Split-Path -Parent $PSScriptRoot
$runner = Get-Content "$fleetHome\bin\run-weekly-review-categories.ps1" -Raw
$installer = Get-Content "$fleetHome\bin\install-weekly-review-categories-task.ps1" -Raw

if ($runner -notmatch "review-categories\.js") { throw 'review-categories runner does not invoke review-categories.js' }
if ($runner -notmatch "state\\metrics") { throw 'review-categories runner must log under state/metrics' }
if ($installer -notmatch "Register-ScheduledTask") { throw 'review-categories installer must register a scheduled task' }
if ($installer -notmatch "-Weekly -DaysOfWeek Monday") { throw 'review-categories installer must register a Monday task' }

$dryRun = & powershell -NoProfile -ExecutionPolicy Bypass -File "$fleetHome\bin\install-weekly-review-categories-task.ps1" -DryRun | Out-String | ConvertFrom-Json
if ($dryRun.taskName -ne 'Fleet weekly review categories') { throw "dry-run task name mismatch: $($dryRun.taskName)" }
if ($dryRun.schedule -ne 'weekly on Monday at 07:40 local time') { throw "review-categories schedule mismatch: $($dryRun.schedule)" }
if ($dryRun.arguments -notmatch 'run-weekly-review-categories\.ps1') { throw 'dry-run action does not run the review-categories runner' }
Write-Output 'review-categories task tests passed'
