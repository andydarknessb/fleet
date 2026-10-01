# #112 (ADR 0013): bin/test-all.ps1 against a fixture tests directory.
# Red-tell: a fixture holding one failing node suite and one throwing PowerShell suite
# makes the runner exit nonzero and name both; the same fixture filtered to the
# passing suites exits 0. Before #112 there was no runner at all.
# #278 red-tell: a suite that exits 0 but leaves a fleet-* directory in TEMP is FAIL and
# the directory is gone afterwards; a green run leaves no fleet-test-all-* log dir behind.
# Before #278 the leaky suites passed and every run left its LogDir in TEMP.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$runner = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\test-all.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('fleet-test-all-fixture-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null

# Each run gets its own TEMP so its leftovers can be counted without seeing other runs.
function Run-Runner {
  param([string[]]$Extra, [string]$Dir = $fixture)
  $script:runTemp = Join-Path $fixture ('temp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  [IO.Directory]::CreateDirectory($script:runTemp) | Out-Null
  $savedTemp = $env:TEMP; $savedTmp = $env:TMP
  $env:TEMP = $script:runTemp; $env:TMP = $script:runTemp
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File $runner -TestsDir $Dir @Extra 2>&1 | Out-String) }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; $env:TEMP = $savedTemp; $env:TMP = $savedTmp }
  return $out
}
function Get-LogDirs { @(Get-ChildItem -LiteralPath $script:runTemp -Directory -Filter 'fleet-test-all-*' -ErrorAction SilentlyContinue) }

try {
  Write-Utf8 "$fixture\alpha.tests.js" "const test = require('node:test'); const assert = require('node:assert'); test('ok', () => assert.equal(1, 1));`n"
  Write-Utf8 "$fixture\beta.tests.js" "const test = require('node:test'); const assert = require('node:assert'); test('deliberately red', () => assert.equal(1, 2, 'BETA-RED'));`n"
  Write-Utf8 "$fixture\gamma.tests.ps1" "`$ErrorActionPreference = 'Stop'`nWrite-Output 'gamma ok'`n"
  Write-Utf8 "$fixture\delta.tests.ps1" "`$ErrorActionPreference = 'Stop'`nthrow 'DELTA-RED'`n"
  Write-Utf8 "$fixture\helper.js" "// not a suite: never run`nprocess.exit(9);`n"

  $out = Run-Runner @()
  Assert-True ($script:lastExit -eq 1) "a failing suite exits 1, got $($script:lastExit): $out"
  Assert-True ($out -match '(?m)^PASS  alpha\.tests\.js  exit=0  [\d.]+s') "one line per suite with exit and seconds: $out"
  Assert-True ($out -match '(?m)^FAIL  beta\.tests\.js  exit=1') "the red node suite is FAIL: $out"
  Assert-True ($out -match '(?m)^PASS  gamma\.tests\.ps1  exit=0') "the green PowerShell suite is PASS: $out"
  Assert-True ($out -match '(?m)^FAIL  delta\.tests\.ps1  exit=1') "the throwing PowerShell suite is FAIL: $out"
  Assert-True ($out -match 'test-all: 2 of 4 suites FAILED in [\d.]+ min: beta\.tests\.js, delta\.tests\.ps1') "the summary names every failed suite: $out"
  Assert-True ($out -match 'BETA-RED') "a failed suite's output tail is printed: $out"
  Assert-True ($out -notmatch 'helper\.js') "a non-suite file is never run: $out"
  $order = @([regex]::Matches($out, '(?m)^(?:PASS|FAIL)  (\S+)') | ForEach-Object { $_.Groups[1].Value })
  Assert-True (($order -join ',') -eq 'alpha.tests.js,beta.tests.js,delta.tests.ps1,gamma.tests.ps1') "suites run one at a time in name order: $($order -join ',')"

  $green = Run-Runner @('-Filter', '[ag]*')
  Assert-True ($script:lastExit -eq 0) "the same fixture without the red suites exits 0, got $($script:lastExit): $green"
  Assert-True ($green -match 'test-all: all 2 suites passed') "the green summary counts the suites: $green"

  Assert-True ((Get-LogDirs).Count -eq 0) "a green run removes its own log dir from TEMP: $((Get-LogDirs) -join ', ')"

  $explicitLogs = Join-Path $fixture 'explicit-logs'
  $null = Run-Runner @('-Filter', '[ag]*', '-LogDir', $explicitLogs)
  Assert-True ($script:lastExit -eq 0) "the green run with -LogDir exits 0, got $($script:lastExit)"
  Assert-True (Test-Path -LiteralPath (Join-Path $explicitLogs 'alpha.tests.js.log')) 'an explicit -LogDir is kept after a green run'

  $leaky = Join-Path $fixture 'leaky'
  [IO.Directory]::CreateDirectory($leaky) | Out-Null
  Write-Utf8 "$leaky\epsilon.tests.js" "const test = require('node:test'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); test('leaks', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-leak-js-')); });`n"
  Write-Utf8 "$leaky\eta.tests.js" "const test = require('node:test'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); test('foreign litter is not ours', () => { fs.mkdirSync(path.join(os.tmpdir(), 'other-tool-litter')); });`n"
  Write-Utf8 "$leaky\zeta.tests.ps1" "`$ErrorActionPreference = 'Stop'`n[IO.Directory]::CreateDirectory((Join-Path ([IO.Path]::GetTempPath()) 'fleet-leak-ps')) | Out-Null`n"
  $leak = Run-Runner @() $leaky
  Assert-True ($script:lastExit -eq 1) "a suite that leaks a fleet-* temp dir fails the run, got $($script:lastExit): $leak"
  Assert-True ($leak -match '(?m)^FAIL  epsilon\.tests\.js  exit=0  [\d.]+s  leaked 1 temp entry: fleet-leak-js-') "the leaky node suite is FAIL and named: $leak"
  Assert-True ($leak -match '(?m)^FAIL  zeta\.tests\.ps1  exit=0  [\d.]+s  leaked 1 temp entry: fleet-leak-ps') "the leaky PowerShell suite is FAIL and named: $leak"
  Assert-True ($leak -match '(?m)^PASS  eta\.tests\.js  exit=0') "a non-fleet temp entry is not counted: $leak"
  Assert-True ($leak -match 'test-all: 2 of 3 suites FAILED') "the summary counts the leaky suites: $leak"
  $kept = Get-LogDirs
  Assert-True ($kept.Count -eq 1) "a failed run keeps its log dir: $leak"
  $litter = @(Get-ChildItem -LiteralPath $script:runTemp -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'fleet-leak-*' -or $_.Name -eq 'other-tool-litter' })
  Assert-True ($litter.Count -eq 0) "every suite's temp dir is removed even when it leaked: $(($litter | ForEach-Object FullName) -join ', ')"

  $none = Run-Runner @('-Filter', 'zzz*')
  Assert-True ($script:lastExit -eq 2) "a filter matching nothing exits 2, got $($script:lastExit): $none"

  Write-Output 'test-all.tests.ps1: all assertions passed'
} finally {
  Remove-Item -Recurse -Force $fixture -ErrorAction SilentlyContinue
}
