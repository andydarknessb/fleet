# Ticket 80 / #443: the summary's installer registers a logon trigger that runs the wrapper with -IfMissing,
# which skips when the sent marker says a page went out today. Runs against a temp root with a stub node.
$ErrorActionPreference = 'Stop'
$fleetHome = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object Text.UTF8Encoding $false

$dry = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$fleetHome\bin\install-daily-summary-task.ps1" -DryRun | Out-String) | ConvertFrom-Json
if ($dry.taskName -ne 'Fleet daily summary') { throw 'summary dry-run task metadata mismatch' }
if ($dry.logonTrigger -notmatch 'at logon of') { throw 'summary installer must add a logon trigger' }
if ($dry.arguments -notmatch '-IfMissing') { throw 'summary action must pass -IfMissing so the logon trigger skips when a page went out today' }
# Review item 5: the logon trigger waits PT12M, behind the four logon tasks and the collector's PT10M.
if ($dry.logonDelay -ne 'PT12M') { throw 'summary logon trigger must wait PT12M behind the four logon tasks and the collector (PT10M)' }
# Review item 6: the printed hints say a plain start does nothing once a page went out today, and give the forced run.
$installer = Get-Content "$fleetHome\bin\install-daily-summary-task.ps1" -Raw
if ($installer -notmatch 'does nothing when a page already went out today') { throw 'summary installer hint must say a plain start does nothing once a page went out today' }
if ($installer -notmatch 'Force a run now') { throw 'summary installer must print the forced-run command' }

$capRoot = Join-Path ([IO.Path]::GetTempPath()) ('summary-ifmissing-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$calls = "$capRoot\bin\node-calls.log"
$marker = "$capRoot\state\notify\daily-summary.json"
function Set-Marker { param([string]$LastSentAt) [IO.File]::WriteAllText($marker, (@{ schemaVersion = 1; lastSentAt = $LastSentAt } | ConvertTo-Json -Compress), $utf8) }
function Invoke-Summary {
  param([switch]$IfMissing)
  Remove-Item -LiteralPath $calls -ErrorAction SilentlyContinue
  $runArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$capRoot\bin\run-daily-summary.ps1")
  if ($IfMissing) { $runArgs += '-IfMissing' }
  & powershell @runArgs | Out-Null
  return $LASTEXITCODE
}
try {
  New-Item -ItemType Directory -Force "$capRoot\bin", "$capRoot\state\notify" | Out-Null
  Copy-Item "$fleetHome\bin\_common.ps1", "$fleetHome\bin\run-daily-summary.ps1" -Destination "$capRoot\bin"
  [IO.File]::WriteAllText("$capRoot\bin\node-stub.cmd", "@echo off`r`necho %*>>""%~dp0node-calls.log""`r`nexit /b 0`r`n", $utf8)
  $env:FLEET_NODE_PATH = "$capRoot\bin\node-stub.cmd"

  Set-Marker (Get-Date).ToUniversalTime().ToString('o')
  if ((Invoke-Summary -IfMissing) -ne 0) { throw '-IfMissing summary must exit 0 when a page went out today' }
  if (Test-Path $calls) { throw '-IfMissing summary must not run when a page went out today' }
  if ((Get-Content "$capRoot\state\notify\daily-summary.log" -Raw) -notmatch 'skipped -IfMissing') { throw 'a -IfMissing skip must say why in daily-summary.log' }

  Set-Marker (Get-Date).AddDays(-1).ToUniversalTime().ToString('o')
  if ((Invoke-Summary -IfMissing) -ne 0) { throw '-IfMissing summary must exit 0 when it runs' }
  if (-not (Test-Path $calls)) { throw '-IfMissing summary must run when the last page went out yesterday' }

  Remove-Item -LiteralPath $marker
  Invoke-Summary -IfMissing | Out-Null
  if (-not (Test-Path $calls)) { throw '-IfMissing summary must run when the sent marker is missing' }

  Set-Marker (Get-Date).ToUniversalTime().ToString('o')
  [IO.File]::WriteAllText($marker, '{not json', $utf8)
  Invoke-Summary -IfMissing | Out-Null
  if (-not (Test-Path $calls)) { throw '-IfMissing summary must run when the sent marker is unreadable' }

  if ((Invoke-Summary) -ne 0) { throw 'a summary run without -IfMissing must exit 0' }
  if (-not (Test-Path $calls)) { throw 'a summary run without -IfMissing must run even when a page went out today' }
} finally {
  Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $capRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'daily-summary task tests passed'
