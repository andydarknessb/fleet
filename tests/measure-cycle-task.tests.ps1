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
# or when the UTC and local days differ (an evening logon). Without the switch the run is unchanged.
if ($dryRun.logonTrigger -notmatch 'at logon of') { throw 'collector installer must add a logon trigger' }
if ($dryRun.arguments -notmatch '-IfMissing') { throw 'collector action must pass -IfMissing so the logon trigger skips when today''s file exists' }
$utf8 = New-Object Text.UTF8Encoding $false
$todayUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$sameDay = $todayUtc -eq (Get-Date).ToString('yyyy-MM-dd')
$capRoot = Join-Path ([IO.Path]::GetTempPath()) ('collector-ifmissing-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$calls = "$capRoot\bin\node-calls.log"
$todayFile = "$capRoot\state\metrics\daily-$todayUtc.json"
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
  $env:FLEET_NODE_PATH = "$capRoot\bin\node-stub.cmd"

  [IO.File]::WriteAllText($todayFile, 'keep', $utf8)
  if ((Invoke-Collector -IfMissing) -ne 0) { throw '-IfMissing collector must exit 0 when today''s file exists' }
  if (Test-Path $calls) { throw '-IfMissing collector must not run when today''s file exists' }
  if ([IO.File]::ReadAllText($todayFile) -ne 'keep') { throw '-IfMissing collector must leave today''s file untouched' }
  if ((Get-Content "$capRoot\state\metrics\collector.log" -Raw) -notmatch 'skipped -IfMissing') { throw 'a -IfMissing skip must say why in collector.log' }

  Remove-Item -LiteralPath $todayFile
  if ((Invoke-Collector -IfMissing) -ne 0) { throw '-IfMissing collector must exit 0 whether it runs or skips' }
  if ($sameDay -ne (Test-Path $calls)) { throw "-IfMissing collector with today's file missing must run only when the UTC and local days agree (sameDay=$sameDay)" }

  [IO.File]::WriteAllText($todayFile, 'keep', $utf8)
  if ((Invoke-Collector) -ne 0) { throw 'a collector run without -IfMissing must exit 0' }
  if (-not (Test-Path $calls)) { throw 'a collector run without -IfMissing must run even when today''s file exists' }
} finally {
  Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $capRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'measure-cycle task tests passed'
