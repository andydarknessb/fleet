$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-sentinel-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

try {
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','profile/.claude/jobs/job-900','repo','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  [IO.File]::Copy("$sourceRoot\bin\_common.ps1", "$testRoot\bin\_common.ps1")
  [IO.File]::Copy("$sourceRoot\bin\sentinel-check.ps1", "$testRoot\bin\sentinel-check.ps1")
  [IO.File]::Copy("$sourceRoot\bin\pause.ps1", "$testRoot\bin\pause.ps1")

  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-900","role":"ic","tenant":"test","parent":"pl-test","issue":900,"cwd":"REPO","status":"active","jobId":"job-900"}]}'
  (Get-Content "$testRoot\state\roster.json" -Raw).Replace('REPO', ($testRoot + '\repo').Replace('\', '\\')) | Set-Content "$testRoot\state\roster.json" -Encoding UTF8
  Write-Utf8 "$testRoot\tenants\test.json" '{"name":"test","repo":"REPO","github":"owner/repo","defaultBranch":"master","releaseBranch":"master","branchPrefix":"fleet/"}'
  (Get-Content "$testRoot\tenants\test.json" -Raw).Replace('REPO', ($testRoot + '\repo').Replace('\', '\\')) | Set-Content "$testRoot\tenants\test.json" -Encoding UTF8
  Write-Utf8 "$testRoot\state\heartbeats\ic-900.json" (ConvertTo-Json @{ at = (Get-Date).ToUniversalTime().AddHours(-3).ToString('o') } -Compress)
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" '{"detail":"","waitingFor":""}'
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  & git -C "$testRoot\repo" init --quiet

  # Ticket 85: Do-Respawn now verifies the pid actually changed, so a mock respawn
  # that never moves ic-900's pid would wrongly read as respawn-failed here. This
  # helper bumps a counter on "respawn" and reports the daemon pid off it, so a
  # respawn attempt this file expects to succeed genuinely looks like one.
  $mockRespawnPs1 = @'
param([string]$Mode, [string]$SentinelRow = '0')
$counterPath = 'TESTROOT\mock-respawn-counter.txt'
$n = 0
if (Test-Path $counterPath) { try { $n = [int]((Get-Content $counterPath -Raw).Trim()) } catch { $n = 0 } }
if ($Mode -eq 'bump') {
  Set-Content -Path $counterPath -Value ($n + 1) -Encoding ASCII
  exit 0
}
$icPid = 900 + $n
if ($SentinelRow -eq '1') {
  Write-Output ('[{"id":"job-900","name":"ic-900","state":"working","status":"idle","pid":' + $icPid + ',"startedAt":"2026-08-28T00:00:00Z"},{"id":"job-s","name":"sentinel","state":"working","status":"idle","pid":12,"startedAt":"2026-08-28T00:00:00Z"}]')
} else {
  Write-Output ('[{"id":"job-900","name":"ic-900","state":"working","status":"idle","pid":' + $icPid + ',"startedAt":"2026-08-28T00:00:00Z"}]')
}
'@
  Write-Utf8 "$testRoot\mock-bin\mock-respawn.ps1" ($mockRespawnPs1.Replace('TESTROOT', $testRoot))
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_CLAUDE_FAIL%"=="1" exit /b 9' + "`r`n" + 'if "%1"=="respawn" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-respawn.ps1" bump' + "`r`n" + 'if "%1"=="agents" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-respawn.ps1" agents %MOCK_SENTINEL_ROW%' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" '@echo off
if "%MOCK_GH_FAIL%"=="1" (echo simulated gh failure 1>&2 & exit /b 7)
if "%MOCK_PR%"=="1" (echo [{"number":777,"headRefName":"fleet/900-fix"}] & exit /b 0)
echo []
exit /b 0
'

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  # Ticket 85: Do-Respawn's bounded re-read defaults to 20s; scaled down so this
  # suite never actually sleeps for it.
  $env:FLEET_RESPAWN_VERIFY_MS = '50'
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = '10'

  $env:MOCK_PR = '1'; $env:MOCK_GH_FAIL = '0'
  $withPr = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($withPr.respawned).Count -eq 0) 'an IC with an open issue PR must not be stale-heartbeat respawned'
  Assert-True (@($withPr.ok | Where-Object { $_.name -eq 'ic-900' -and $_.detail -eq 'waiting on PR #777' }).Count -eq 1) 'the open PR exemption must name the PR under ok'

  $env:MOCK_PR = '0'
  $withoutPr = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($withoutPr.respawned).Count -eq 1) 'a stale idle IC with no PR or hold must remain respawnable'
  Assert-True ($withoutPr.respawned[0].reason -match 'state=working status=idle, no open PR') 'the respawn reason must report measured state and status'

  # The Max-plan session-limit wording (seen live 2026-09-01) must read as a rate-limit signal.
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" '{"detail":"You''ve hit your session limit · resets 5:50pm (America/Chicago)","waitingFor":""}'
  $limited = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True ("$($limited.pause)" -match 'rate-limit signal on ic-900') 'a session-limit detail must propose the rate-limit PAUSE'
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" '{"detail":"","waitingFor":""}'

  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{"900":"held"},"prs":{}}'
  $env:MOCK_GH_FAIL = '1'
  $held = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($held.respawned).Count -eq 0) 'an issue skip-list hold must exempt stale-heartbeat respawn'
  Assert-True (@($held.escalate).Count -eq 0) 'an issue hold must not depend on the PR lookup'

  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  $failed = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($failed.respawned).Count -eq 0) 'a failed PR lookup must fail safe without respawning'
  Assert-True (@($failed.escalate | Where-Object { $_.kind -eq 'pr-lookup-failed' }).Count -eq 1) 'a failed PR lookup must escalate'

  # A launchNeeded/ic-vanished burst off one glitched daemon read was the 2026-09-01
  # near-miss: an unreadable list must propose nothing, not report everyone missing.
  $env:MOCK_GH_FAIL = '0'
  $env:MOCK_CLAUDE_FAIL = '1'
  $badRead = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True ("$($badRead.daemonReadError)" -match 'unreadable') 'a failed daemon read must be named in the report'
  Assert-True (@($badRead.launchNeeded).Count -eq 0) 'an unreadable list must produce no launchNeeded'
  Assert-True (@($badRead.escalate).Count -eq 0) 'an unreadable list must produce no vanished-IC escalations'
  Assert-True (@($badRead.respawned).Count -eq 0) 'an unreadable list must respawn nothing'
  Remove-Item Env:MOCK_CLAUDE_FAIL

  # Ticket 08b: read-only runs leave no applied ledger; -Apply ticks append one line each,
  # stamped with the actor, so bin/parity.js can pair the Sentinel's ticks with the shadow log.
  Assert-True (-not (Test-Path "$testRoot\state\sentinel\applied")) 'read-only checks must write no applied ledger'
  $env:MOCK_PR = '0'
  $applied1 = (& "$testRoot\bin\sentinel-check.ps1" -Apply | Out-String) | ConvertFrom-Json
  Assert-True (@($applied1.respawned).Count -eq 1) 'the -Apply run must still respawn the stale IC'
  $applied2 = (& "$testRoot\bin\sentinel-check.ps1" -Apply -Actor watchdog | Out-String) | ConvertFrom-Json
  $ledgerFiles = @(Get-ChildItem "$testRoot\state\sentinel\applied" -Filter *.jsonl)
  Assert-True ($ledgerFiles.Count -eq 1) 'one applied ledger file per day'
  $ledger = @(Get-Content $ledgerFiles[0].FullName | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-True ($ledger.Count -eq 2) 'each -Apply tick must append exactly one ledger line'
  Assert-True ($ledger[0].actor -eq 'sentinel' -and $ledger[0].applied -eq $true) 'the default actor is the rostered Sentinel'
  Assert-True (@($ledger[0].respawned)[0].name -eq 'ic-900') 'the ledger line must carry the applied action set'
  Assert-True ($ledger[0].okCount -ge 0 -and $null -ne $ledger[0].PSObject.Properties['okCount']) 'the ledger line must carry okCount'
  Assert-True ($ledger[1].actor -eq 'watchdog') '-Actor must stamp the line'
  $env:MOCK_CLAUDE_FAIL = '1'
  $null = (& "$testRoot\bin\sentinel-check.ps1" -Apply | Out-String)
  Remove-Item Env:MOCK_CLAUDE_FAIL
  $ledger = @(Get-Content $ledgerFiles[0].FullName | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-True ($ledger.Count -eq 3 -and "$($ledger[2].daemonReadError)" -match 'unreadable') 'a fail-closed tick still leaves a ledger line naming the read error'

  # Ticket 08b: while state/flags/sentinel-off stands, the rostered Sentinel is neither expected
  # nor launched (its roster.json entry stays as the rollback path); a Sentinel session that is
  # nevertheless running is a stray, the double-actor evidence.
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"sentinel","role":"sentinel","parent":"dispatcher","cwd":"C:\\fleet","prompt":"p"}]}'
  $expected = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($expected.launchNeeded | Where-Object { $_.name -eq 'sentinel' }).Count -eq 1) 'without the flag a missing rostered Sentinel is launchNeeded'
  [IO.Directory]::CreateDirectory("$testRoot\state\flags") | Out-Null
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'cut over by test'
  $off = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True (@($off.launchNeeded).Count -eq 0) 'with sentinel-off the rostered Sentinel is not expected'
  $env:MOCK_SENTINEL_ROW = '1'
  $stray = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Remove-Item Env:MOCK_SENTINEL_ROW
  Assert-True (@($stray.escalate | Where-Object { $_.name -eq 'sentinel' -and $_.kind -eq 'stray' }).Count -eq 1) 'a running Sentinel under sentinel-off is a stray'
  # The retired actor's own -Apply is refused mechanically; the watchdog's is not.
  $ledgerBefore = @(Get-Content $ledgerFiles[0].FullName).Count
  $refused = (& "$testRoot\bin\sentinel-check.ps1" -Apply | Out-String) | ConvertFrom-Json
  Assert-True ($refused.applied -eq $false -and "$($refused.refused)" -match 'sentinel-off') 'a Sentinel -Apply under the flag must be refused'
  Assert-True (@($refused.respawned).Count -eq 0) 'a refused apply must act on nothing'
  Assert-True (@(Get-Content $ledgerFiles[0].FullName).Count -eq $ledgerBefore) 'a refused apply leaves no ledger line'
  $watchdogApply = (& "$testRoot\bin\sentinel-check.ps1" -Apply -Actor watchdog | Out-String) | ConvertFrom-Json
  Assert-True ($watchdogApply.applied -eq $true) 'the watchdog actor still applies under the flag'
  Remove-Item "$testRoot\state\flags\sentinel-off"

  # Rate-limit PAUSE, 2026-09-10 (three re-arms in 14h). The detail line is a level, not an
  # event: the same wording stood for 12 hours and re-armed a PAUSE one tick after each manual
  # clear. And the 60-minute window phase-locked to the 15-minute tick: until landed ~100 ms
  # after the +60 tick's frozen clock, so only the +75 tick cleared it.
  $pauseFile = "$testRoot\state\PAUSE"
  $signalFile = "$testRoot\state\sentinel\rate-limit-signal.json"
  Write-Utf8 "$testRoot\state\heartbeats\ic-900.json" (ConvertTo-Json @{ at = (Get-Date).ToUniversalTime().ToString('o') } -Compress)
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" '{"detail":"You''ve hit your session limit · resets 1:20am (America/Chicago)","waitingFor":""}'
  $set1 = (& "$testRoot\bin\sentinel-check.ps1" -Apply -Actor watchdog | Out-String) | ConvertFrom-Json
  Assert-True ("$($set1.pause)" -match 'set: rate-limit signal on ic-900' -and (Test-Path $pauseFile)) 'a session-limit detail must set the PAUSE under -Apply'
  $null = (Get-Content $pauseFile -Raw) -match 'until=(\S+)'
  $until = [datetime]::Parse($Matches[1]).ToUniversalTime()
  $tickPlus60 = ([datetime]::Parse($set1.at)).ToUniversalTime().AddMinutes(60)
  Assert-True ($until -le $tickPlus60) "the window must end inside the tick one hour after the setting tick (until $($until.ToString('o')) vs tick+60m $($tickPlus60.ToString('o')))"
  Assert-True ($until -gt $tickPlus60.AddMinutes(-5)) 'the window must still be about an hour, not collapsed'
  Assert-True (Test-Path $signalFile) 'the setting tick must record the wording it paused on'
  Remove-Item $pauseFile
  $rearm = (& "$testRoot\bin\sentinel-check.ps1" -Apply -Actor watchdog | Out-String) | ConvertFrom-Json
  Assert-True (-not (Test-Path $pauseFile)) 'the same unchanged wording must not re-arm the PAUSE after a clear'
  Assert-True ($null -eq $rearm.pause) 'a held signal proposes no pause'
  Assert-True (@($rearm.ok | Where-Object { $_.name -eq 'ic-900' -and "$($_.detail)" -match 'wording unchanged' }).Count -eq 1) 'the hold must be named under ok'
  $readOnly = (& "$testRoot\bin\sentinel-check.ps1" | Out-String) | ConvertFrom-Json
  Assert-True ($null -eq $readOnly.pause) 'a read-only tick honours the recorded wording too'
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" '{"detail":"You''ve hit your session limit · resets 5:50pm (America/Chicago)","waitingFor":""}'
  $set2 = (& "$testRoot\bin\sentinel-check.ps1" -Apply -Actor watchdog | Out-String) | ConvertFrom-Json
  Assert-True ("$($set2.pause)" -match 'set: rate-limit signal on ic-900' -and (Test-Path $pauseFile)) 'a new limit wording (new reset time) must pause again'
  Write-Utf8 $pauseFile 'reason=rate-limit seen on ic-900; setAt=2026-01-01T00:00:00Z; until=2026-01-01T00:59:00Z'
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" '{"detail":"","waitingFor":""}'
  $swept = (& "$testRoot\bin\sentinel-check.ps1" -Apply -Actor watchdog | Out-String) | ConvertFrom-Json
  Assert-True ("$($swept.pause)" -match 'cleared: rate-limit window passed' -and -not (Test-Path $pauseFile)) 'a passed rate-limit window is still cleared'
  Remove-Item $signalFile

  Write-Output 'sentinel respawn tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_PR -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_GH_FAIL -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_CLAUDE_FAIL -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_SENTINEL_ROW -ErrorAction SilentlyContinue
  Remove-Item Env:FLEET_RESPAWN_VERIFY_MS -ErrorAction SilentlyContinue
  Remove-Item Env:FLEET_RESPAWN_VERIFY_POLL_MS -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-sentinel-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
