# #112 (ADR 0013): bin/test-all.ps1 against a fixture tests directory.
# Red-tell: a fixture holding one failing node suite and one throwing PowerShell suite
# makes the runner exit nonzero and name both; the same fixture filtered to the
# passing suites exits 0. Before #112 there was no runner at all.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$runner = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\test-all.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('fleet-test-all-fixture-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null

function Run-Runner {
  param([string[]]$Extra)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File $runner -TestsDir $fixture @Extra 2>&1 | Out-String) }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  return $out
}

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

  $none = Run-Runner @('-Filter', 'zzz*')
  Assert-True ($script:lastExit -eq 2) "a filter matching nothing exits 2, got $($script:lastExit): $none"

  Write-Output 'test-all.tests.ps1: all assertions passed'
} finally {
  Remove-Item -Recurse -Force $fixture -ErrorAction SilentlyContinue
}
