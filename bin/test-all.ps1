# Fleet aggregate test runner (#112, ADR 0013): every tests/*.tests.js (node --test)
# and every tests/*.tests.ps1 (Windows PowerShell 5.1), SERIALLY, each in its own
# process. Suites never run in parallel: the work-state mutex test flakes under
# parallel load (ADR 0013 Consequences). One line per suite (outcome, exit code,
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
if (-not $LogDir) { $LogDir = Join-Path ([IO.Path]::GetTempPath()) ('fleet-test-all-' + [guid]::NewGuid().ToString('N')) }
[IO.Directory]::CreateDirectory($LogDir) | Out-Null

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

$failed = New-Object System.Collections.Generic.List[string]
$started = Get-Date
foreach ($suite in $suites) {
  $log = Join-Path $LogDir ($suite.Name + '.log')
  $errLog = Join-Path $LogDir ($suite.Name + '.err.log')
  if ($suite.Name -like '*.tests.js') {
    $exe = $node.Source
    $argList = '--test "' + $suite.FullName + '"'
  } else {
    $exe = $powershell
    $argList = '-NoProfile -ExecutionPolicy Bypass -File "' + $suite.FullName + '"'
  }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $fleetRoot `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -NoNewWindow -PassThru
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
  $ok = ($code -is [int]) -and $code -eq 0
  $label = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Output ('{0}  {1}  exit={2}  {3}s' -f $label, $suite.Name, $code, $seconds)
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
exit 0
