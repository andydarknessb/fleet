# Fleet aggregate test runner (#112, ADR 0013): every tests/*.tests.js (node --test)
# and every tests/*.tests.ps1 (Windows PowerShell 5.1), SERIALLY, each in its own
# process. Suites never run in parallel (ADR 0013 Consequences; the mutex flake
# once blamed on parallel load was a Windows lock race, #234). One line per suite (outcome, exit code,
# seconds); exit 1 naming every failed suite, 0 when all passed, 2 when -Filter
# matched nothing. CI (.github/workflows/ci.yml, job `fleet-ci`) runs exactly this.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File bin\test-all.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File bin\test-all.ps1 -Filter 'review-*'
#
# -Filter is a wildcard against the suite file name (`budget*`, `*.tests.ps1`).
# -TestsDir points the runner at another directory (its own test uses a fixture).
# A suite that outlives -SuiteTimeoutMinutes is killed and counted as failed.
# Each suite's output goes to -LogDir\<suite>.log; a failed suite's tail is printed.
# Each suite runs with TEMP/TMP pointed at its own empty directory under -LogDir (#278).
# A suite that leaves a fleet-* entry there is FAIL even when it exits 0, and the directory
# is removed after every suite either way. A green run removes the default -LogDir too;
# a failed run keeps it and prints the path. An explicit -LogDir is never removed.
param(
  [string]$Filter = '*',
  [string]$TestsDir = '',
  [string]$LogDir = '',
  [int]$SuiteTimeoutMinutes = 60,
  [int]$FailureTailLines = 80
)
$ErrorActionPreference = 'Stop'

$fleetRoot = Split-Path -Parent $PSScriptRoot
if (-not $TestsDir) { $TestsDir = Join-Path $fleetRoot 'tests' }
$ownLogDir = -not $LogDir
# A short name: every suite's TEMP lives under it, and test-all.tests.ps1 nests a runner inside
# the runner, so each character here is paid twice against MAX_PATH (#278).
if (-not $LogDir) { $LogDir = Join-Path ([IO.Path]::GetTempPath()) ('fleet-test-all-' + [guid]::NewGuid().ToString('N').Substring(0, 12)) }
# Suites run from the fleet root with this as TEMP, so it must not stay relative.
$LogDir = [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location).ProviderPath, $LogDir))

$node = (Get-Command node -ErrorAction SilentlyContinue)
$powershell = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path $powershell)) { $powershell = 'powershell' }

$suites = @(Get-ChildItem -Path $TestsDir -File | Where-Object {
    ($_.Name -like '*.tests.js' -or $_.Name -like '*.tests.ps1') -and $_.Name -like $Filter
  } | Sort-Object Name)
if ($suites.Count -eq 0) {
  Write-Output "test-all: no suite in $TestsDir matches -Filter '$Filter'"
  exit 2
}
if (($suites | Where-Object { $_.Name -like '*.tests.js' }) -and -not $node) {
  Write-Output 'test-all: node is not on PATH; the .tests.js suites cannot run'
  exit 2
}

# Windows PowerShell 5.1 spins in Start-Process when the child's TEMP nears MAX_PATH, out of
# reach of -SuiteTimeoutMinutes; refuse up front instead (#278).
$maxTempPath = 200
if (($LogDir.Length + 4) -gt $maxTempPath) {
  Write-Output "test-all: -LogDir '$LogDir' is too long; each suite's TEMP under it must stay within $maxTempPath characters"
  exit 2
}
[IO.Directory]::CreateDirectory($LogDir) | Out-Null

$failed = New-Object System.Collections.Generic.List[string]
$started = Get-Date
$suiteIndex = 0
foreach ($suite in $suites) {
  $suiteIndex++
  $log = Join-Path $LogDir ($suite.Name + '.log')
  $errLog = Join-Path $LogDir ($suite.Name + '.err.log')
  if ($suite.Name -like '*.tests.js') {
    $exe = $node.Source
    $argList = '--test "' + $suite.FullName + '"'
  } else {
    $exe = $powershell
    $argList = '-NoProfile -ExecutionPolicy Bypass -File "' + $suite.FullName + '"'
  }
  # One directory per suite, so a leftover a suite could not delete is never blamed on the next one.
  $suiteTemp = Join-Path $LogDir ('t' + $suiteIndex)
  [IO.Directory]::CreateDirectory($suiteTemp) | Out-Null
  $savedTemp = $env:TEMP; $savedTmp = $env:TMP
  $env:TEMP = $suiteTemp; $env:TMP = $suiteTemp
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    $process = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $fleetRoot `
      -RedirectStandardOutput $log -RedirectStandardError $errLog -NoNewWindow -PassThru
  } finally { $env:TEMP = $savedTemp; $env:TMP = $savedTmp }
  # Windows PowerShell 5.1: ExitCode reads back null unless the handle was taken
  # while the process was alive.
  $null = $process.Handle
  $finished = $process.WaitForExit($SuiteTimeoutMinutes * 60 * 1000)
  if (-not $finished) {
    try { & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null } catch {}
    $code = 'timeout'
  } else {
    $process.WaitForExit()
    $code = $process.ExitCode
  }
  $clock.Stop()
  $seconds = [math]::Round($clock.Elapsed.TotalSeconds, 1)
  $leaked = @(Get-ChildItem -LiteralPath $suiteTemp -Force -Filter 'fleet-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object)
  # A detached child the suite started may still hold a file for a moment after the suite exits.
  for ($attempt = 1; $attempt -le 5 -and (Test-Path -LiteralPath $suiteTemp); $attempt++) {
    Remove-Item -LiteralPath $suiteTemp -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $suiteTemp) { Start-Sleep -Milliseconds 500 }
  }
  $ok = ($code -is [int]) -and $code -eq 0 -and $leaked.Count -eq 0
  $label = if ($ok) { 'PASS' } else { 'FAIL' }
  $leakNote = if ($leaked.Count -gt 0) { '  leaked {0} temp entr{1}: {2}' -f $leaked.Count, $(if ($leaked.Count -eq 1) { 'y' } else { 'ies' }), (($leaked | Select-Object -First 5) -join ', ') } else { '' }
  Write-Output ('{0}  {1}  exit={2}  {3}s{4}' -f $label, $suite.Name, $code, $seconds, $leakNote)
  if (-not $ok) {
    $failed.Add($suite.Name)
    foreach ($file in @($log, $errLog)) {
      if ((Test-Path $file) -and (Get-Item $file).Length -gt 0) {
        Write-Output "---- $($suite.Name): last $FailureTailLines lines of $(Split-Path -Leaf $file)"
        Get-Content -Path $file -Tail $FailureTailLines | ForEach-Object { Write-Output "  $_" }
      }
    }
  }
}
$total = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
if ($failed.Count -gt 0) {
  Write-Output ("test-all: {0} of {1} suites FAILED in {2} min: {3}" -f $failed.Count, $suites.Count, $total, ($failed -join ', '))
  Write-Output "test-all: logs in $LogDir"
  exit 1
}
Write-Output ("test-all: all {0} suites passed in {1} min" -f $suites.Count, $total)
if ($ownLogDir) { Remove-Item -LiteralPath $LogDir -Recurse -Force -ErrorAction SilentlyContinue }
exit 0
