$ErrorActionPreference = 'Stop'
$fleetHome = Split-Path -Parent $PSScriptRoot
$runner = Get-Content "$fleetHome\bin\run-cycle-collector.ps1" -Raw
$installer = Get-Content "$fleetHome\bin\install-cycle-collector-task.ps1" -Raw

if ($runner -notmatch "measure-cycle\.js") { throw 'collector runner does not invoke measure-cycle.js' }
if ($runner -notmatch "--since|--until|--now") { throw 'collector runner must use a bounded deterministic window' }
if ($runner -notmatch "state\\metrics") { throw 'collector runner must write under state/metrics' }
# #132: the weekly second read runs beside the collector, behind its rollback flag.
if ($runner -notmatch "second-read.js") { throw "collector runner does not invoke second-read.js" }
if ($runner -notmatch "second-read-off") { throw "collector runner must honour state/flags/second-read-off" }
if ($installer -notmatch "Register-ScheduledTask") { throw 'collector installer must register a scheduled task' }
if ($installer -notmatch "Fleet cycle collector") { throw 'collector task name changed unexpectedly' }

$dryRun = & powershell -NoProfile -ExecutionPolicy Bypass -File "$fleetHome\bin\install-cycle-collector-task.ps1" -DryRun | Out-String | ConvertFrom-Json
if ($dryRun.taskName -ne 'Fleet cycle collector') { throw 'dry-run task metadata mismatch' }
if ($dryRun.schedule -ne 'daily at 07:45 local time') { throw 'collector schedule mismatch' }

# Ticket 443: the logon trigger runs the collector with -IfMissing: it skips when today's file is there,
# or when the UTC date is later than the local date (an evening logon). Without the switch the run is unchanged.
if ($dryRun.logonTrigger -notmatch 'at logon of') { throw 'collector installer must add a logon trigger' }
if ($dryRun.arguments -notmatch '-IfMissing') { throw 'collector action must pass -IfMissing so the logon trigger skips when today''s file exists' }
# Review item 5: the logon trigger waits PT10M behind the four logon tasks (recovery PT2M to rotation PT8M).
if ($dryRun.logonDelay -ne 'PT10M') { throw 'collector logon trigger must wait PT10M behind the four logon tasks (PT2M to PT8M)' }
# Review item 6: the printed hints say a plain start does nothing on a day that has its file, and give the forced run.
if ($installer -notmatch 'does nothing on a day whose file already exists') { throw 'collector installer hint must say a plain start does nothing when today''s file exists' }
if ($installer -notmatch 'Force a run now') { throw 'collector installer must print the forced-run command' }

$utf8 = New-Object Text.UTF8Encoding $false
# Review item 7: the skip is for a UTC date later than the local date, so a host east of UTC is not skipped at its morning slot.
$todayUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$utcAhead = $todayUtc -gt (Get-Date).ToString('yyyy-MM-dd')
$capRoot = Join-Path ([IO.Path]::GetTempPath()) ('collector-ifmissing-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$calls = "$capRoot\bin\node-calls.log"
$todayFile = "$capRoot\state\metrics\daily-$todayUtc.json"
# Test seam: a prelude that reads the clock from FAKE_UTC and FAKE_LOCAL, so a run can stand east or west of UTC.
$fakeClock = @'
function Get-Date {
  $now = New-Object psobject
  Add-Member -InputObject $now -MemberType ScriptMethod -Name ToUniversalTime -Value { $this }
  Add-Member -InputObject $now -MemberType ScriptMethod -Name ToLocalTime -Value { [datetime]::Parse($env:FAKE_LOCAL) }
  Add-Member -InputObject $now -Force -MemberType ScriptMethod -Name ToString -Value { param($format) ([datetime]::Parse($env:FAKE_UTC)).ToString($format) }
  Add-Member -InputObject $now -MemberType ScriptMethod -Name AddDays -Value { param($days) ([datetime]::Parse($env:FAKE_UTC)).AddDays($days) }
  return $now
}
'@
$runWithClock = @'
. "$PSScriptRoot\fake-clock.ps1"
& "$PSScriptRoot\run-cycle-collector.ps1" -IfMissing
'@
function Invoke-Collector {
  param([switch]$IfMissing)
  Remove-Item -LiteralPath $calls -ErrorAction SilentlyContinue
  $runArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$capRoot\bin\run-cycle-collector.ps1")
  if ($IfMissing) { $runArgs += '-IfMissing' }
  & powershell @runArgs | Out-Null
  return $LASTEXITCODE
}
try {
  New-Item -ItemType Directory -Force "$capRoot\bin", "$capRoot\state\metrics" | Out-Null
  Copy-Item "$fleetHome\bin\_common.ps1", "$fleetHome\bin\run-cycle-collector.ps1" -Destination "$capRoot\bin"
  [IO.File]::WriteAllText("$capRoot\bin\node-stub.cmd", "@echo off`r`necho %*>>""%~dp0node-calls.log""`r`nexit /b 0`r`n", $utf8)
  [IO.File]::WriteAllText("$capRoot\bin\fake-clock.ps1", $fakeClock, $utf8)
  [IO.File]::WriteAllText("$capRoot\bin\run-with-clock.ps1", $runWithClock, $utf8)
  $env:FLEET_NODE_PATH = "$capRoot\bin\node-stub.cmd"

  [IO.File]::WriteAllText($todayFile, 'keep', $utf8)
  if ((Invoke-Collector -IfMissing) -ne 0) { throw '-IfMissing collector must exit 0 when today''s file exists' }
  if (Test-Path $calls) { throw '-IfMissing collector must not run when today''s file exists' }
  if ([IO.File]::ReadAllText($todayFile) -ne 'keep') { throw '-IfMissing collector must leave today''s file untouched' }
  if ((Get-Content "$capRoot\state\metrics\collector.log" -Raw) -notmatch 'skipped -IfMissing') { throw 'a -IfMissing skip must say why in collector.log' }

  Remove-Item -LiteralPath $todayFile
  if ((Invoke-Collector -IfMissing) -ne 0) { throw '-IfMissing collector must exit 0 whether it runs or skips' }
  if ((Test-Path $calls) -eq $utcAhead) { throw "-IfMissing collector with today's file missing must skip only when the UTC date is later than the local date (utcAhead=$utcAhead)" }

  # East of UTC the morning run's UTC date is the day before, so it goes ahead; west of UTC an evening
  # logon's UTC date is tomorrow, so it skips. Both use the faked clock.
  Remove-Item -LiteralPath $todayFile -ErrorAction SilentlyContinue
  $env:FAKE_UTC = '2026-11-12T22:30:00'; $env:FAKE_LOCAL = '2026-11-13T07:30:00'
  Remove-Item -LiteralPath $calls -ErrorAction SilentlyContinue
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$capRoot\bin\run-with-clock.ps1" | Out-Null
  if (-not (Test-Path $calls)) { throw 'an east-of-UTC morning run must go ahead: its UTC date is earlier than the local date' }
  $env:FAKE_UTC = '2026-11-13T02:00:00'; $env:FAKE_LOCAL = '2026-11-12T21:00:00'
  Remove-Item -LiteralPath $calls -ErrorAction SilentlyContinue
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$capRoot\bin\run-with-clock.ps1" | Out-Null
  if (Test-Path $calls) { throw 'an evening logon west of UTC must skip: its UTC date is later than the local date' }

  [IO.File]::WriteAllText($todayFile, 'keep', $utf8)
  if ((Invoke-Collector) -ne 0) { throw 'a collector run without -IfMissing must exit 0' }
  if (-not (Test-Path $calls)) { throw 'a collector run without -IfMissing must run even when today''s file exists' }
} finally {
  Remove-Item Env:FLEET_NODE_PATH, Env:FAKE_UTC, Env:FAKE_LOCAL -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $capRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'measure-cycle task tests passed'
