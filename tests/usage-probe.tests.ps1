$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

# fleet #388 (spec #382, ruling 6): the Usage limit probe end to end, with no quota spent. FLEET_CLAUDE_CLI names a
# mock claude that records its arguments and prints the stream file it is pointed at. The Pushover endpoint refuses
# connections, so a page that reaches the door fails (an attempt) and one with no credentials is unconfigured.
# The node decisions themselves are tested in tests/usage-limit.tests.js.
$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-usage-probe-test-" + [guid]::NewGuid().ToString('N'))
$oldCli = $env:FLEET_CLAUDE_CLI
$oldRetry = $env:FLEET_PAGE_RETRY_DELAY_MS
$oldPushover = $env:FLEET_PUSHOVER_URL
$sample = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793995200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.05,"resetsAt":1793995200,"status":"allowed"},"seven_day":{"utilization":0.32,"resetsAt":1794290400,"status":"allowed"}}}}'
function Stream-With { param([string]$Weekly) $sample.Replace('"utilization":0.32', "`"utilization`":$Weekly") }
function Run-Probe { param([string[]]$Extra = @())
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\usage-probe.ps1" -NoToast @Extra | Out-String
  return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json
}

try {
  foreach ($dir in 'bin', 'mock', 'state\usage', 'state\pages', 'state\secrets') { [IO.Directory]::CreateDirectory("$testRoot\$dir") | Out-Null }
  foreach ($f in '_common.ps1', 'usage-probe.ps1', 'usage-limit.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\mock\claude.cmd" ('@echo off' + "`r`n" + 'echo %* > "' + $testRoot + '\mock\args.txt"' + "`r`n" + 'echo %CD% > "' + $testRoot + '\mock\cwd.txt"' + "`r`n" + 'type "' + $testRoot + '\mock\stream.jsonl"' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:FLEET_CLAUDE_CLI = "$testRoot\mock\claude.cmd"
  $env:FLEET_PAGE_RETRY_DELAY_MS = '50'
  $env:FLEET_PUSHOVER_URL = 'http://127.0.0.1:1/'
  $latest = "$testRoot\state\usage\latest.json"
  $paged = "$testRoot\state\usage\paged.json"
  $argsLog = "$testRoot\mock\args.txt"
  $readings = "$testRoot\state\usage\readings.jsonl"

  # A: no reading yet: the probe runs the cheap call, stores the reading, and does not page at 32%.
  Write-Utf8 "$testRoot\mock\stream.jsonl" (Stream-With '0.32')
  $a = Run-Probe
  Assert-True ($a.ran -eq $true -and $a.ok -eq $true) "the first probe must run and succeed: $($a | ConvertTo-Json -Compress)"
  Assert-True ($a.reading.weekly.utilization -eq 0.32 -and $null -eq $a.paged) 'the reading is the weekly 32%, with no page'
  $cliArgs = (Get-Content -LiteralPath $argsLog -Raw)
  foreach ($token in '-p "Reply with the single word OK."', '--model claude-haiku-5-5', '--output-format stream-json', '--verbose', '--max-turns 1', '--no-session-persistence', '--setting-sources project', '--strict-mcp-config') {
    Assert-True ($cliArgs.Contains($token)) "the claude call must carry '$token': $cliArgs"
  }
  # The claude call runs in a scratch directory, not a checkout, and the directory is gone afterwards.
  $cwd = (Get-Content -LiteralPath "$testRoot\mock\cwd.txt" -Raw).Trim()
  Assert-True ($cwd -notlike "$testRoot*" -and $cwd -notlike "$sourceRoot*" -and -not (Test-Path -LiteralPath $cwd)) "the claude call runs in a scratch directory that is removed after: $cwd"
  Assert-True ((Get-Content -LiteralPath $latest -Raw | ConvertFrom-Json).weekly.utilization -eq 0.32) 'latest.json holds the reading'
  Assert-True (@(Get-Content -LiteralPath $readings).Count -eq 1) 'readings.jsonl gets one line'

  # B: the reading is fresh: nothing runs, so no claude call is made.
  Remove-Item -LiteralPath $argsLog
  $b = Run-Probe
  Assert-True ($b.ran -eq $false -and $b.reason -eq 'fresh') "a fresh reading must end the run: $($b | ConvertTo-Json -Compress)"
  Assert-True (-not (Test-Path -LiteralPath $argsLog)) 'a fresh reading makes no claude call'

  # C: -Force probes whatever the age of the reading.
  $c = Run-Probe @('-Force')
  Assert-True ($c.ran -eq $true -and (Test-Path -LiteralPath $argsLog)) '-Force runs the probe on a fresh reading'

  # D: a window at 85% pages; Pushover is configured but refused, so the attempt is recorded as undelivered.
  Remove-Item -LiteralPath $latest
  Write-Utf8 "$testRoot\state\secrets\pushover.json" '{"apiToken":"test-token","userKey":"test-user"}'
  Write-Utf8 "$testRoot\mock\stream.jsonl" (Stream-With '0.85')
  $d = Run-Probe
  Assert-True ($d.ok -eq $true -and $d.paged -eq $false) "a refused page is an attempt that was not delivered: $($d | ConvertTo-Json -Compress)"
  $pageRecord = Get-Content -LiteralPath $paged -Raw | ConvertFrom-Json
  Assert-True ($pageRecord.weeklyResetsAt -eq 1794290400 -and $pageRecord.delivered -eq $false -and $pageRecord.attempts -eq 1) "the attempt is recorded against its window: $(Get-Content -LiteralPath $paged -Raw)"
  Assert-True ((Get-Content -LiteralPath "$testRoot\state\pages\pages.jsonl" -Raw) -match '"kind":"usage-limit"') 'the page goes through Send-FleetPage, kind usage-limit'

  # E: the next hourly probe, same window, still undelivered: retried, a second attempt.
  Remove-Item -LiteralPath $latest
  $e = Run-Probe
  Assert-True ($e.paged -eq $false -and (Get-Content -LiteralPath $paged -Raw | ConvertFrom-Json).attempts -eq 2) 'an undelivered page is retried on the next probe'

  # F: no credentials: the page is unconfigured, which is not an attempt, so nothing is recorded against the window.
  Remove-Item -LiteralPath "$testRoot\state\secrets\pushover.json", $paged, $latest
  Write-Utf8 "$testRoot\mock\stream.jsonl" (Stream-With '0.9')
  $f = Run-Probe
  Assert-True ($f.paged -eq 'unconfigured' -and -not (Test-Path -LiteralPath $paged)) "an unconfigured page is not an attempt: $($f | ConvertTo-Json -Compress)"

  # G: a stream with no rate_limit_event fails inside the answer, stores nothing, and still exits 0.
  Remove-Item -LiteralPath $latest
  Write-Utf8 "$testRoot\mock\stream.jsonl" "{`"type`":`"result`",`"is_error`":true}`r`n"
  $g = Run-Probe
  Assert-True ($g.ran -eq $true -and $g.ok -eq $false -and $g.error -match 'rate_limit_event') "a probe with no event reports the error: $($g | ConvertTo-Json -Compress)"
  Assert-True (-not (Test-Path -LiteralPath $latest)) 'a failed probe stores no reading'

  # H: that failed probe was an attempt, so an ordinary run within the hour finds nothing due and makes no call.
  Remove-Item -LiteralPath $argsLog -ErrorAction SilentlyContinue
  $h = Run-Probe
  Assert-True ($h.ran -eq $false -and $h.reason -eq 'fresh' -and -not (Test-Path -LiteralPath $argsLog)) "a failed attempt paces the next probe: $($h | ConvertTo-Json -Compress)"

  Write-Output 'usage-probe tests passed'
} finally {
  $env:FLEET_CLAUDE_CLI = $oldCli
  $env:FLEET_PAGE_RETRY_DELAY_MS = $oldRetry
  $env:FLEET_PUSHOVER_URL = $oldPushover
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
