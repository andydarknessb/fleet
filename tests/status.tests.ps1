# Ticket 89 (ADR 0006 / 08b, after one release): bin/status.ps1 against a fixture fleet.
# Red-tell: before this ticket, status.ps1 named both retired rollback scripts
# (`bin\rollback-assignment.ps1`, `bin\rollback-sentinel.ps1`) in its assignment and
# supervisor lines; both scripts are deleted, so the hint must be gone too.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-status-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH

function Run-Status {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $testRoot
  try { $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\status.ps1" 2>&1 | Out-String) }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; Pop-Location }
  return $out
}

try {
  foreach ($dir in 'bin','state','state/flags','state/heartbeats','state/escalations','state/manifests','state/watchdog','state/budget','state/verify','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','status.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","tenant":null,"parent":"cory","cwd":"C:\\nowhere","prompt":"d"}]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"

  # Case 1: no flags set (a fresh fixture, never cut over): still no rollback script named.
  $out1 = Run-Status
  Assert-True ($lastExit -eq 0) "status.ps1 must run clean: $out1"
  Assert-True ($out1 -notmatch 'rollback-assignment' -and $out1 -notmatch 'rollback-sentinel') "status.ps1 must not print a rollback hint: $out1"

  # Case 2: both cutover flags stand (the live production state since 2026-09-09/09-04):
  # still no rollback script named, because neither script exists any more (fleet #89).
  Write-Utf8 "$testRoot\state\flags\assignment-live" 'cut over'
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'cut over'
  $out2 = Run-Status
  Assert-True ($lastExit -eq 0) "status.ps1 must run clean under both cutover flags: $out2"
  Assert-True ($out2 -match 'assignment: planner authoritative') "status.ps1 must report the planner authoritative: $out2"
  Assert-True ($out2 -match 'supervisor: watchdog task') "status.ps1 must report the watchdog task as supervisor: $out2"
  Assert-True ($out2 -notmatch 'rollback-assignment' -and $out2 -notmatch 'rollback-sentinel') "status.ps1 must not print a rollback hint under either cutover flag: $out2"

  # Case 3 (WS5, fleet #82): under dispatcher-off the retired dispatcher is not expected, so
  # a roster.json row with no live session prints no dispatcher line (it was "absent" before).
  Assert-True ($out2 -match 'dispatcher') "control: without the flag the missing dispatcher is listed: $out2"
  Write-Utf8 "$testRoot\state\flags\dispatcher-off" 'cut over'
  $out3 = Run-Status
  Assert-True ($lastExit -eq 0) "status.ps1 must run clean under dispatcher-off: $out3"
  Assert-True ($out3 -notmatch 'dispatcher') "status.ps1 must not list the retired dispatcher as a missing session: $out3"
  Assert-True ($out3 -match 'live fleet sessions: 0 / cap 6') "status.ps1 must still report the fleet: $out3"

  # Case 4 (spec #382 ruling 7): the budget line names Haiku's own warn and escalate lines beside
  # the default ones, so the status never shows only a line no IC runs on.
  Write-Utf8 "$testRoot\state\budget\last.json" '{"at":"2026-11-06T12:00:00.000Z","mode":"shadow","config":{"warnTokens":25000,"escalateTokens":175000,"byModel":{"haiku":{"warnTokens":120000,"escalateTokens":350000}}},"records":[]}'
  $out4 = Run-Status
  Assert-True ($lastExit -eq 0) "status.ps1 must run clean with a budget run recorded: $out4"
  Assert-True ($out4 -match 'budget: shadow \(warn 25000 / escalate 175000 job tokens; haiku warn 120000 / escalate 350000;') "status.ps1 must name the Haiku budget line: $out4"

  # Case 5: a budget run written before the per-model lines (no config.byModel) prints the default line alone.
  Write-Utf8 "$testRoot\state\budget\last.json" '{"at":"2026-11-06T12:00:00.000Z","mode":"live","config":{"warnTokens":50000,"escalateTokens":null},"records":[]}'
  $out5 = Run-Status
  Assert-True ($lastExit -eq 0) "status.ps1 must run clean with a budget run that has no per-model lines: $out5"
  Assert-True ($out5 -match 'budget: live \(warn 50000 / escalate OFF \(warning-only soak\) job tokens; flag ') "status.ps1 must print the default line alone when no model has its own: $out5"

  Write-Output 'status tests passed'
} finally {
  $env:PATH = $oldPath
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-status-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
