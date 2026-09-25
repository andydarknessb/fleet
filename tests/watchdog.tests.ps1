$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Get-EpochMs { param([datetime]$D) ([DateTimeOffset][datetime]::SpecifyKind($D.ToUniversalTime(), [DateTimeKind]::Utc)).ToUnixTimeMilliseconds() }
# Ticket 77: newlyPaged entries are now { key, priority, page } objects (the
# delivery result per condition), not bare key strings; existing assertions
# read the keys back out through this helper.
function Get-PagedKeys { param($NewlyPaged) @($NewlyPaged | ForEach-Object { $_.key }) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-watchdog-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE
$oldRetryDelayMs = $env:FLEET_PAGE_RETRY_DELAY_MS
# Cory's ruling 2026-09-18 (fleet #76): Send-FleetPage now waits 5s before its
# one retry on a 5xx, a failed connection or a timeout - injectable so a
# dead-port paging case in this suite does not pay that delay for real.
$env:FLEET_PAGE_RETRY_DELAY_MS = '50'

function Set-Heartbeat { param([string]$Name, [double]$AgeMinutes)
  $at = (Get-Date).ToUniversalTime().AddMinutes(-$AgeMinutes).ToString('o')
  Write-Utf8 "$testRoot\state\heartbeats\$Name.json" (ConvertTo-Json @{ name = $Name; at = $at } -Compress)
}
function Set-AgentsRows { param([string]$Json) Write-Utf8 "$testRoot\mock-agents.json" $Json }
function Run-Watchdog {
  param([switch]$Verify)
  $out = ''
  if ($Verify) { $out = & "$testRoot\bin\watchdog.ps1" -NoToast -Verify | Out-String }
  else { $out = & "$testRoot\bin\watchdog.ps1" -NoToast | Out-String }
  ($out.Trim() -split "`n")[-1] | ConvertFrom-Json
}
function New-StormRows { param([string]$Name, [datetime]$FirstFail)
  # Two consecutive failed rows for one name, appended to the healthy statics.
  $f1 = Get-EpochMs $FirstFail
  $f2 = Get-EpochMs $FirstFail.AddMinutes(5)
  $script:healthyRows.TrimEnd(']') + ",{`"id`":`"job-$Name-1`",`"name`":`"$Name`",`"state`":`"failed`",`"pid`":null,`"startedAt`":$f1},{`"id`":`"job-$Name-2`",`"name`":`"$Name`",`"state`":`"failed`",`"pid`":null,`"startedAt`":$f2}]"
}

try {
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','state/watchdog','state/escalations','state/work','state/watch','profile/.claude/jobs/job-ic-901-2','repo','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','sentinel-check.ps1','watchdog.ps1','identity.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }

  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"sentinel","role":"sentinel","parent":"dispatcher"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"}]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Write-Utf8 "$testRoot\tenants\test.json" '{"name":"test","repo":"REPO","github":"owner/repo","defaultBranch":"master","releaseBranch":"master","branchPrefix":"fleet/"}'
  (Get-Content "$testRoot\tenants\test.json" -Raw).Replace('REPO', ($testRoot + '\repo').Replace('\', '\\')) | Set-Content "$testRoot\tenants\test.json" -Encoding UTF8
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  Write-Utf8 "$testRoot\state\sentinel\last-check.json" '{"marker":"live-sentinel-untouched"}'
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-ic-901-2\state.json" '{"detail":"spawn boom","waitingFor":""}'
  & git -C "$testRoot\repo" init --quiet

  # Production daemon rows carry startedAt as Int64 epoch ms; fixtures match that shape.
  $oldStart = (Get-Date).AddHours(-16)
  $healthyRows = '[{"id":"job-d","name":"dispatcher","state":"working","status":"idle","pid":11,"startedAt":' + (Get-EpochMs $oldStart) + '},{"id":"job-s","name":"sentinel","state":"working","status":"idle","pid":12,"startedAt":' + (Get-EpochMs $oldStart.AddSeconds(1)) + '},{"id":"job-p","name":"pl-test","state":"working","status":"busy","pid":13,"startedAt":' + (Get-EpochMs $oldStart.AddSeconds(2)) + '}]'
  Set-AgentsRows $healthyRows
  # Ticket 85: `claude respawn` in production either replaces the pid or it does not;
  # the mock must be able to show both. mock-respawn.ps1 bumps the matching row's pid
  # (a real respawn) unless MOCK_RESPAWN_NOOP=1 (the wedged-dispatcher no-op case).
  $mockRespawnPs1 = @'
param([string]$JobId)
if ($env:MOCK_RESPAWN_NOOP -eq '1') { exit 0 }
$agentsPath = 'TESTROOT\mock-agents.json'
$counterPath = 'TESTROOT\mock-respawn-counter.txt'
$n = 1
if (Test-Path $counterPath) { try { $n = [int]((Get-Content $counterPath -Raw).Trim()) + 1 } catch { $n = 1 } }
Set-Content -Path $counterPath -Value $n -Encoding ASCII
$parsed = (Get-Content $agentsPath -Raw) | ConvertFrom-Json
$rows = @($parsed)
foreach ($r in $rows) { if ("$($r.id)" -eq $JobId) { $r.pid = 70000 + $n } }
$json = '[' + (($rows | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 6 }) -join ',') + ']'
[IO.File]::WriteAllText($agentsPath, $json, (New-Object Text.UTF8Encoding $false))
'@
  Write-Utf8 "$testRoot\mock-bin\mock-respawn.ps1" ($mockRespawnPs1.Replace('TESTROOT', $testRoot))
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'if "%1"=="respawn" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-respawn.ps1" %2' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_GH_FAIL%"=="1" (echo gh down 1>&2 & exit /b 9)' + "`r`n" + 'if "%3"=="902" (echo {"state":"CLOSED"}) else if "%2"=="view" (echo {"state":"OPEN"}) else echo []' + "`r`n" + 'exit /b 0' + "`r`n")

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  # Claude Code 2.1.281 trust pre-flight (launch.ps1 Test-WorkspaceTrusted): trust the test root so every path under it launches.
  [IO.Directory]::CreateDirectory("$testRoot\profile") | Out-Null
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
  # Ticket 85: Do-Respawn's bounded re-read defaults to 20s; the suite scales it down
  # so a genuine no-op respawn-failed case never actually sleeps for real.
  $env:FLEET_RESPAWN_VERIFY_MS = '50'
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = '10'

  # Case 1: healthy fleet -> no conditions, no banner, shadow line written, live last-check untouched.
  foreach ($n in 'dispatcher','sentinel','pl-test') { Set-Heartbeat $n 5 }
  $r1 = Run-Watchdog
  Assert-True (@($r1.conditions).Count -eq 0) 'healthy fleet must produce zero conditions'
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\banner.txt")) 'healthy fleet must leave no banner'
  Assert-True ($null -eq $r1.checkError -or $r1.checkError -eq '') 'the shadow check must run cleanly'
  Assert-True ($r1.proposed.okCount -ge 3) 'the shadow report must carry the check results'
  $shadow = Get-ChildItem "$testRoot\state\sentinel\shadow" -Filter *.jsonl
  Assert-True (@($shadow).Count -eq 1) 'one shadow log file must exist'
  Assert-True ((Get-Content "$testRoot\state\sentinel\last-check.json" -Raw) -match 'live-sentinel-untouched') 'shadow runs must not clobber the live last-check.json'
  Assert-True ((Get-Content "$testRoot\state\watchdog\last-shadow-check.json" -Raw) -match '"applied"') 'the shadow check report must land in state/watchdog'

  # Case 2: stale sentinel -> one page, banner present; second run pages nothing new.
  Set-Heartbeat 'sentinel' 90
  $r2 = Run-Watchdog
  Assert-True (@($r2.conditions) -contains 'sentinel-stale') 'a 90-min sentinel heartbeat must raise sentinel-stale'
  Assert-True ((Get-PagedKeys $r2.newlyPaged) -contains 'sentinel-stale') 'the first sighting must page'
  Assert-True (Test-Path "$testRoot\state\watchdog\banner.txt") 'a condition must write the banner'
  Assert-True ((Get-Content "$testRoot\state\watchdog\banner.txt" -Raw) -match 'sentinel-stale') 'the banner must name the condition'
  Assert-True ((Get-Content "$testRoot\state\watchdog\banner.txt" -Raw) -match 'threshold 45') 'the banner detail must carry the threshold'
  $r2b = Run-Watchdog
  Assert-True (@($r2b.conditions) -contains 'sentinel-stale') 'the condition persists while stale'
  Assert-True (@($r2b.newlyPaged).Count -eq 0) 'an unchanged condition must not page again'

  # Case 2c: an unparseable heartbeat is stale, never fatal.
  Write-Utf8 "$testRoot\state\heartbeats\sentinel.json" '{"name":"sentinel","at":"yesterday"}'
  $r2c = Run-Watchdog
  Assert-True (@($r2c.conditions) -contains 'sentinel-stale') 'a garbage heartbeat must read as stale, not crash'

  # Case 3: recovery clears the banner and the paged state.
  Set-Heartbeat 'sentinel' 5
  $r3 = Run-Watchdog
  Assert-True (@($r3.conditions).Count -eq 0) 'a fresh heartbeat must clear the condition'
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\banner.txt")) 'recovery must remove the banner'
  $paged = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json
  # .Name on an empty properties collection is $null and @($null).Count is 1; count the collection itself.
  Assert-True (@($paged.PSObject.Properties).Count -eq 0) 'recovery must clear the paged keys'

  # Case 3b: stale heartbeat but freshly (re)launched daemon job -> relaunch grace, no page.
  Set-Heartbeat 'sentinel' 90
  $freshIso = (Get-Date).ToUniversalTime().AddMinutes(-5).ToString('o')
  Set-AgentsRows ($healthyRows.Replace('"id":"job-s","name":"sentinel","state":"working","status":"idle","pid":12,"startedAt":' + (Get-EpochMs $oldStart.AddSeconds(1)), '"id":"job-s","name":"sentinel","state":"working","status":"idle","pid":12,"startedAt":"' + $freshIso + '"'))
  $r3b = Run-Watchdog
  Assert-True (@($r3b.conditions).Count -eq 0) 'a fresh daemon startedAt must be grace for a stale heartbeat'
  Set-AgentsRows $healthyRows
  Set-Heartbeat 'sentinel' 5

  # Case 3c: PAUSE suppresses staleness paging (paused sessions idle by design).
  foreach ($n in 'dispatcher','sentinel','pl-test') { Set-Heartbeat $n 200 }
  Write-Utf8 "$testRoot\state\PAUSE" 'reason=test; setAt=now; until='
  $r3c = Run-Watchdog
  Assert-True (@($r3c.conditions).Count -eq 0) 'PAUSE must suppress staleness conditions'
  Assert-True ($r3c.paused -eq $true) 'the shadow log must record the pause'
  Remove-Item "$testRoot\state\PAUSE"

  # Ticket 75: fleet-dead now also requires work waiting. An implementing record
  # for the sole tenant gives every "all statics stale" case below real work to
  # find, matching the original intent (self-healing is down while something is
  # in flight); the "nothing to do" idle case ticket 75 carves out is tested in
  # its own block near the end of this file.
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-777":{"tenant":"test","issue":777,"state":"implementing"}}}'

  # Case 3d: a corrupt paged.json is quarantined, and a live condition still pages.
  Write-Utf8 "$testRoot\state\watchdog\paged.json" '{oops'
  $r3d = Run-Watchdog
  Assert-True (@($r3d.conditions) -contains 'fleet-dead') 'a corrupt paged.json must not stop condition detection'
  Assert-True ((Get-PagedKeys $r3d.newlyPaged) -contains 'fleet-dead') 'after quarantine the condition pages'
  Assert-True (@(Get-ChildItem "$testRoot\state\watchdog" -Filter 'paged.json.corrupt-*').Count -eq 1) 'the corrupt paged state must be quarantined'
  $null = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json   # valid again

  # Case 4: all static heartbeats stale -> fleet-dead (not sentinel-stale).
  $r4 = Run-Watchdog
  Assert-True (@($r4.conditions) -contains 'fleet-dead') 'all-stale statics must raise fleet-dead'
  Assert-True (-not (@($r4.conditions) -contains 'sentinel-stale')) 'fleet-dead supersedes sentinel-stale'
  foreach ($n in 'dispatcher','sentinel','pl-test') { Set-Heartbeat $n 5 }
  $null = Run-Watchdog

  # Case 5: launch retry storm on an OPEN issue -> skip-hold written once, page once.
  $stormRows = New-StormRows 'ic-901' (Get-Date).AddHours(-2)
  Set-AgentsRows $stormRows
  $r5 = Run-Watchdog
  Assert-True (@($r5.conditions) -contains 'launch-retry:ic-901') 'two consecutive failed launches must trip the retry cap'
  Assert-True ((Get-PagedKeys $r5.newlyPaged) -contains 'launch-retry:ic-901') 'a retry trip must page'
  $skip = (Get-Content "$testRoot\state\skip\test.json" -Raw) | ConvertFrom-Json
  Assert-True ("$($skip.issues.'901')" -match 'launch-failed: 2 consecutive') 'the trip must write a launch-failed skip-hold'
  Assert-True ("$($skip.issues.'901')" -match 'spawn boom') 'the hold must carry the recorded failure detail'
  $r5b = Run-Watchdog
  Assert-True (@($r5b.newlyPaged).Count -eq 0) 'a standing trip must not page again'
  Assert-True (@($r5b.skipWrites).Count -eq 0) 'an existing hold must not be rewritten'
  Assert-True (-not (@($r5b.conditions) -contains 'launch-retry:ic-901')) 'a written hold means handled: the condition clears'
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\banner.txt")) 'a fully handled trip must clear the banner'
  Assert-True (@($r5b.retryTrips | Where-Object { $_.name -eq 'ic-901' -and $_.disposition -eq 'already-held' }).Count -eq 1) 'the shadow log must record the already-held disposition'

  # Case 5w: outside the 24h window, old failures are history - a lifted hold stays lifted.
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'   # Cory lifts the hold
  Set-AgentsRows (New-StormRows 'ic-901' (Get-Date).AddHours(-30))
  $r5w = Run-Watchdog
  Assert-True (@($r5w.conditions).Count -eq 0) 'failures outside the window must not trip'
  $skipW = (Get-Content "$testRoot\state\skip\test.json" -Raw) | ConvertFrom-Json
  Assert-True (@($skipW.issues.PSObject.Properties).Count -eq 0) 'a lifted hold must not be resurrected from old failures'

  # Case 5c: a storm on a CLOSED issue is history - no page, no hold.
  Set-AgentsRows (New-StormRows 'ic-902' (Get-Date).AddHours(-2))
  $r5c = Run-Watchdog
  Assert-True (-not (@($r5c.conditions) -contains 'launch-retry:ic-902')) 'a closed issue must not raise a condition'
  $skipC = (Get-Content "$testRoot\state\skip\test.json" -Raw) | ConvertFrom-Json
  Assert-True (-not (@($skipC.issues.PSObject.Properties.Name) -contains '902')) 'a closed issue must not gain a hold'
  Assert-True (@($r5c.retryTrips | Where-Object { $_.name -eq 'ic-902' -and $_.disposition -eq 'closed-stale' }).Count -eq 1) 'the shadow log must record the closed-stale disposition'

  # Case 5d: a failed GitHub read fails safe - page, but never hold on unverified state.
  Set-AgentsRows (New-StormRows 'ic-903' (Get-Date).AddHours(-2))
  $env:MOCK_GH_FAIL = '1'
  $r5d = Run-Watchdog
  $env:MOCK_GH_FAIL = '0'
  Assert-True (@($r5d.conditions) -contains 'launch-retry:ic-903') 'a gh failure must still page the trip'
  Assert-True (@($r5d.retryTrips | Where-Object { $_.name -eq 'ic-903' -and $_.disposition -eq 'gh-failed-paged' }).Count -eq 1) 'the disposition must record the gh failure'
  $skipGh = (Get-Content "$testRoot\state\skip\test.json" -Raw) | ConvertFrom-Json
  Assert-True (-not (@($skipGh.issues.PSObject.Properties.Name) -contains '903')) 'no hold may be written on unverified issue state'

  # Case 5e: a human's unrelated hold is paged through, never treated as handled or overwritten.
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{"904":"SPEC PARENT - not fleet work"},"prs":{}}'
  Set-AgentsRows (New-StormRows 'ic-904' (Get-Date).AddHours(-2))
  $r5e = Run-Watchdog
  Assert-True (@($r5e.conditions) -contains 'launch-retry:ic-904') 'an unrelated hold must not suppress a real storm'
  Assert-True (@($r5e.retryTrips | Where-Object { $_.name -eq 'ic-904' -and $_.disposition -eq 'held-other-paged' }).Count -eq 1) 'the disposition must mark the foreign hold'
  $skipE = (Get-Content "$testRoot\state\skip\test.json" -Raw) | ConvertFrom-Json
  Assert-True ("$($skipE.issues.'904')" -eq 'SPEC PARENT - not fleet work') "a human's hold must never be overwritten"
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'

  # Case 6: a successful launch after failures ends the streak.
  $successRow = ',{"id":"job-ic-901-3","name":"ic-901","state":"working","status":"busy","pid":14,"startedAt":' + (Get-EpochMs (Get-Date).AddHours(-1)) + '}]'
  Set-AgentsRows ((New-StormRows 'ic-901' (Get-Date).AddHours(-2)).TrimEnd(']') + $successRow)
  $r6 = Run-Watchdog
  Assert-True (-not (@($r6.conditions) -contains 'launch-retry:ic-901')) 'a newer successful row must end the failure streak'
  Set-AgentsRows $healthyRows

  # Case 7: the check itself failing to run is a page condition.
  Rename-Item "$testRoot\bin\sentinel-check.ps1" 'sentinel-check.ps1.bak'
  $r7 = Run-Watchdog
  Rename-Item "$testRoot\bin\sentinel-check.ps1.bak" 'sentinel-check.ps1'
  Assert-True (@($r7.conditions) -contains 'check-failed') 'an unrunnable check must raise check-failed'

  # Case 7b: child stderr noise must not fail a healthy run or cost the parity data.
  $origCheck = Get-Content "$testRoot\bin\sentinel-check.ps1" -Raw
  $anchor = '. "$PSScriptRoot\_common.ps1"'
  Write-Utf8 "$testRoot\bin\sentinel-check.ps1" ($origCheck.Replace($anchor, $anchor + "`r`n[Console]::Error.WriteLine('mock stderr noise')"))
  $r7b = Run-Watchdog
  Write-Utf8 "$testRoot\bin\sentinel-check.ps1" $origCheck
  Assert-True ($null -eq $r7b.checkError -or $r7b.checkError -eq '') 'stderr noise must not read as a failed check'
  Assert-True ($r7b.proposed.okCount -ge 3) 'stderr noise must not cost the parity data'
  Assert-True (@($r7b.conditions).Count -eq 0) 'stderr noise must not page'

  # Case 8: -Verify computes conditions but writes nothing.
  $cleanup = Run-Watchdog
  Assert-True (@($cleanup.conditions).Count -eq 0) 'the pre-verify pass must be clean'
  $shadowFile = (Get-ChildItem "$testRoot\state\sentinel\shadow" -Filter *.jsonl)[0].FullName
  $linesBefore = @(Get-Content $shadowFile).Count
  $pagedBefore = Get-Content "$testRoot\state\watchdog\paged.json" -Raw
  Set-Heartbeat 'sentinel' 90
  $r8 = Run-Watchdog -Verify
  Assert-True ($r8.verify -eq $true) '-Verify must mark its output'
  Assert-True (@($r8.conditions) -contains 'sentinel-stale') '-Verify must still compute conditions'
  Assert-True (@(Get-Content $shadowFile).Count -eq $linesBefore) '-Verify must not append to the shadow log'
  Assert-True ((Get-Content "$testRoot\state\watchdog\paged.json" -Raw) -eq $pagedBefore) '-Verify must not touch paged state'
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\banner.txt")) '-Verify must not write the banner'

  # Case 8b (fleet #100): the -Verify report path is per run, so two ticks started
  # together both exit 0 and neither leaves its report behind. Against the old
  # shared $env:TEMP path one run could delete the other's report mid-read. That
  # window is too narrow to hit on demand, so the deterministic half: a wrapping
  # check logs the -ReportPath each tick hands it, and every path is distinct.
  $origCheck8b = Get-Content "$testRoot\bin\sentinel-check.ps1" -Raw
  Write-Utf8 "$testRoot\bin\sentinel-check-real.ps1" $origCheck8b
  Write-Utf8 "$testRoot\bin\sentinel-check.ps1" ('param([switch]$Apply, [string]$ReportPath = "", [string]$Actor = "sentinel", [string]$HealRespawn = "")' + "`r`n" + '[IO.File]::WriteAllText("' + $testRoot.Replace('\', '\\') + '\verify-report-path-$PID.txt", $ReportPath)' + "`r`n" + '& "$PSScriptRoot\sentinel-check-real.ps1" -ReportPath $ReportPath' + "`r`n" + 'exit $LASTEXITCODE' + "`r`n")
  $verifyRuns = @(1..4 | ForEach-Object {
    $o = Join-Path $testRoot "verify-$_.out"; $e = Join-Path $testRoot "verify-$_.err"
    Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$testRoot\bin\watchdog.ps1`" -NoToast -Verify" -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
  })
  foreach ($vr in $verifyRuns) { $null = $vr.Handle }
  foreach ($vr in $verifyRuns) { $vr.WaitForExit() }
  foreach ($i in 0..($verifyRuns.Count - 1)) {
    $vr = $verifyRuns[$i]
    Assert-True ($vr.ExitCode -eq 0) "concurrent -Verify tick $($i + 1) must exit 0 (exit $($vr.ExitCode)): $(Get-Content (Join-Path $testRoot "verify-$($i + 1).err") -Raw)"
    $vrLine = ((Get-Content (Join-Path $testRoot "verify-$($i + 1).out") -Raw).Trim() -split "`n")[-1] | ConvertFrom-Json
    Assert-True (-not $vrLine.checkError) "concurrent -Verify tick $($i + 1) must read its own report (checkError: $($vrLine.checkError))"
  }
  $verifyPathFiles = @(Get-ChildItem $testRoot -Filter 'verify-report-path-*.txt')
  $verifyPaths = @($verifyPathFiles | ForEach-Object { (Get-Content $_.FullName -Raw).Trim() } | Where-Object { $_ })
  Write-Utf8 "$testRoot\bin\sentinel-check.ps1" $origCheck8b
  Remove-Item "$testRoot\bin\sentinel-check-real.ps1"; $verifyPathFiles | Remove-Item; Remove-Item "$testRoot\verify-*.out", "$testRoot\verify-*.err"
  Assert-True ($verifyPaths.Count -eq 4) "each -Verify tick must run the check once (got $($verifyPaths.Count))"
  Assert-True (@($verifyPaths | Sort-Object -Unique).Count -eq 4) "each -Verify tick must hand the check its own report path (got: $($verifyPaths -join ', '))"
  foreach ($vp in $verifyPaths) { Assert-True (-not (Test-Path $vp)) "a -Verify tick must remove its report after reading it ($vp)" }
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue

  # ===== Ticket 08b: live supervision under state/flags/sentinel-off =====
  # A mock launch door records every call and answers like launch.ps1.
  Write-Utf8 "$testRoot\bin\launch.ps1" ('param([string]$FromRoster)' + "`r`n" + '[IO.File]::AppendAllText("' + $testRoot.Replace('\', '\\') + '\launch-calls.txt", "FromRoster=$FromRoster`n")' + "`r`n" + 'Write-Output (@{ launched = $true; name = $FromRoster; jobId = "job-new-$FromRoster" } | ConvertTo-Json -Compress)' + "`r`n" + 'exit 0' + "`r`n")
  function Get-LaunchCalls { if (Test-Path "$testRoot\launch-calls.txt") { @(Get-Content "$testRoot\launch-calls.txt") } else { @() } }
  function Get-EscalationFiles { param([string]$Pattern) @(Get-ChildItem "$testRoot\state\escalations" -Filter $Pattern -ErrorAction SilentlyContinue) }
  function Get-AppliedLines { $f = Get-ChildItem "$testRoot\state\sentinel\applied" -Filter *.jsonl -ErrorAction SilentlyContinue; if ($f) { @(Get-Content $f.FullName) } else { @() } }
  $dispRow = '{"id":"job-d","name":"dispatcher","state":"working","status":"idle","pid":11,"startedAt":' + (Get-EpochMs $oldStart) + '}'
  $plRow = '{"id":"job-p","name":"pl-test","state":"working","status":"busy","pid":13,"startedAt":' + (Get-EpochMs $oldStart.AddSeconds(2)) + '}'
  $noSentinelRows = "[$dispRow,$plRow]"
  foreach ($n in 'dispatcher','sentinel','pl-test') { Set-Heartbeat $n 5 }
  Set-AgentsRows $healthyRows
  $null = Run-Watchdog

  # Case 9: the flag with a Sentinel session still running -> double-actor page, shadow, nothing applied.
  [IO.Directory]::CreateDirectory("$testRoot\state\flags") | Out-Null
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'cutover test'
  $r9 = Run-Watchdog
  Assert-True ($r9.mode -eq 'shadow') 'a running Sentinel under the flag must keep the run in shadow'
  Assert-True (@($r9.conditions) -contains 'double-actor') 'a running Sentinel under the flag is the double-actor condition'
  Assert-True ((Get-PagedKeys $r9.newlyPaged) -contains 'double-actor') 'double-actor must page'
  Assert-True (@(Get-AppliedLines).Count -eq 0) 'shadow must apply nothing'
  Assert-True ((Get-Content "$testRoot\state\sentinel\last-check.json" -Raw) -match 'live-sentinel-untouched') 'shadow must not own the canonical report'

  # Case 10: the flag with no Sentinel session -> live: the check applies, owns the canonical
  # report, and no sentinel-stale is raised for the retired actor.
  Remove-Item "$testRoot\state\heartbeats\sentinel.json"
  Set-AgentsRows $noSentinelRows
  $r10 = Run-Watchdog
  Assert-True ($r10.mode -eq 'live') 'the flag with no Sentinel session must go live'
  Assert-True (@($r10.conditions).Count -eq 0) "live with a healthy fleet must raise nothing (got: $(@($r10.conditions) -join ','))"
  $applied10 = @(Get-AppliedLines)
  Assert-True ($applied10.Count -eq 1) 'a live tick must append one applied ledger line'
  Assert-True (($applied10[0] | ConvertFrom-Json).actor -eq 'watchdog') 'the live ledger line must name the watchdog as actor'
  Assert-True ((Get-Content "$testRoot\state\sentinel\last-check.json" -Raw) -match '"applied":\s*true') 'live must own state/sentinel/last-check.json'
  $lastRun = (Get-Content "$testRoot\state\watchdog\last-run.json" -Raw) | ConvertFrom-Json
  Assert-True ($lastRun.mode -eq 'live') 'last-run.json must record the mode'

  # Case 10b: a missing static session is launched through the one door.
  Set-AgentsRows "[$dispRow]"
  $r10b = Run-Watchdog
  Assert-True (@($r10b.launches | Where-Object { $_.name -eq 'pl-test' -and $_.launched -eq $true }).Count -eq 1) 'launchNeeded must launch through launch.ps1'
  Assert-True (@(Get-LaunchCalls) -contains 'FromRoster=pl-test') 'the launch must go through -FromRoster'
  Assert-True (@($r10b.launches | Where-Object { $_.name -eq 'sentinel' }).Count -eq 0) 'the retired Sentinel must never be launched'

  # Case 10c: PAUSE launches nothing, and the run still applies (how a rate-limit PAUSE clears).
  Write-Utf8 "$testRoot\state\PAUSE" 'reason=test; setAt=now; until='
  $callsBefore = @(Get-LaunchCalls).Count
  $r10c = Run-Watchdog
  Remove-Item "$testRoot\state\PAUSE"
  Assert-True (@($r10c.launches | Where-Object { $_.name -eq 'pl-test' -and $_.launched -eq $false -and $_.reason -match 'PAUSE' }).Count -eq 1) 'PAUSE must record the un-launch with its reason'
  Assert-True (@(Get-LaunchCalls).Count -eq $callsBefore) 'PAUSE must not call the launch door'
  Assert-True ($r10c.mode -eq 'live') 'PAUSE does not demote the supervisor to shadow'

  # Case 10d: a check escalation of a paging kind pages once and files one escalation; a standing one is quiet; clearing clears.
  $strayRow = '{"id":"job-x","name":"ic-777","state":"working","status":"idle","pid":77,"startedAt":' + (Get-EpochMs $oldStart) + '}'
  Set-AgentsRows "[$dispRow,$plRow,$strayRow]"
  $r10d = Run-Watchdog
  Assert-True (@($r10d.conditions) -contains 'escalation:ic-777:stray') 'a stray must become an escalation condition'
  Assert-True ((Get-PagedKeys $r10d.newlyPaged) -contains 'escalation:ic-777:stray') 'a new escalation pages'
  Assert-True (@(Get-EscalationFiles '*-supervisor-ic-777-stray.json').Count -eq 1) 'a new escalation leaves one escalation file'
  Assert-True ((Get-Content "$testRoot\state\watchdog\banner.txt" -Raw) -match 'ic-777') 'the banner carries the escalation'
  $r10d2 = Run-Watchdog
  Assert-True (@($r10d2.newlyPaged).Count -eq 0) 'a standing escalation must not page again'
  Assert-True (@(Get-EscalationFiles '*-supervisor-ic-777-stray.json').Count -eq 1) 'a standing escalation must not be re-filed'
  Set-AgentsRows $noSentinelRows
  $r10d3 = Run-Watchdog
  Assert-True (-not (@($r10d3.conditions) -contains 'escalation:ic-777:stray')) 'a cleared escalation leaves the conditions'
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\banner.txt")) 'a cleared escalation clears the banner'

  # Case 10e: `blocked` is recorded as waiting, never paged, never filed.
  $blockedDisp = $dispRow.Replace('"state":"working"', '"state":"blocked"')
  Set-AgentsRows "[$blockedDisp,$plRow]"
  $r10e = Run-Watchdog
  Assert-True (@($r10e.waiting | Where-Object { $_.name -eq 'dispatcher' -and $_.kind -eq 'blocked' }).Count -eq 1) 'blocked must be recorded under waiting'
  Assert-True (@($r10e.conditions).Count -eq 0) 'blocked must not page'
  Assert-True (@(Get-EscalationFiles '*-supervisor-dispatcher-blocked.json').Count -eq 0) 'blocked must not be filed'

  # Case 10f: pageKinds is configurable; naming blocked makes it page.
  [IO.Directory]::CreateDirectory("$testRoot\config") | Out-Null
  Write-Utf8 "$testRoot\config\cycle.json" '{"supervisor":{"pageKinds":["stray","blocked"]}}'
  $r10f = Run-Watchdog
  Assert-True (@($r10f.conditions) -contains 'escalation:dispatcher:blocked') 'a configured kind must page'
  Remove-Item "$testRoot\config\cycle.json"
  Set-AgentsRows $noSentinelRows
  $null = Run-Watchdog

  # Case 10g: a respawn files an escalation naming the parent (the re-send nudge the Sentinel used to message).
  $stoppedPl = $plRow.Replace('"state":"working"', '"state":"stopped"')
  # fleet #121: a static is respawned (not relaunched through launch.ps1) only when its job
  # is the live roster's own and its frozen flags match what launch.ps1 passes today.
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"pl-test","role":"project-lead","tenant":"test","status":"active","jobId":"job-p","model":"opus-5.5"}]}'
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-p") | Out-Null
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-p\state.json" '{"state":"stopped","respawnFlags":["--name","pl-test","--agent","project-lead","--model","claude-opus-5-5"]}'
  Set-AgentsRows "[$dispRow,$stoppedPl]"
  $r10g = Run-Watchdog
  Assert-True (@($r10g.proposed.respawned | Where-Object { $_.name -eq 'pl-test' }).Count -eq 1) 'a stopped static session is respawned by the applied check'
  Assert-True (@($r10g.notified | Where-Object { $_.name -eq 'pl-test' -and $_.kind -eq 'respawned' -and $_.parent -eq 'dispatcher' }).Count -eq 1) 'the respawn must be recorded as notified to the parent'
  $respawnFiles = @(Get-EscalationFiles '*-supervisor-pl-test-respawned.json')
  Assert-True ($respawnFiles.Count -eq 1) 'a respawn must leave one escalation file'
  $respawnEsc = (Get-Content $respawnFiles[0].FullName -Raw) | ConvertFrom-Json
  Assert-True ($respawnEsc.parent -eq 'dispatcher' -and $respawnEsc.detail -match 're-send') 'the respawn escalation must name the parent and the nudge'
  # A session that will not stay up is respawned again next tick: one condition, no second file.
  $r10g2 = Run-Watchdog
  Assert-True (@($r10g2.proposed.respawned | Where-Object { $_.name -eq 'pl-test' }).Count -eq 1) 'the check still respawns the stopped session'
  Assert-True (@($r10g2.notified).Count -eq 0) 'an unchanged respawn must not be re-notified'
  Assert-True (@($r10g2.waiting | Where-Object { $_.name -eq 'pl-test' -and $_.kind -eq 'respawned-again' }).Count -eq 1) 'the repeat must be recorded as waiting'
  Assert-True (@(Get-EscalationFiles '*-supervisor-pl-test-respawned.json').Count -eq 1) 'a repeated respawn must not file again'
  Set-AgentsRows $noSentinelRows
  $null = Run-Watchdog
  Set-AgentsRows "[$dispRow,$stoppedPl]"
  $r10g3 = Run-Watchdog
  Assert-True (@($r10g3.notified | Where-Object { $_.name -eq 'pl-test' }).Count -eq 1) 'a respawn after a clean tick is a new event and notifies again'
  Set-AgentsRows $noSentinelRows
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Remove-Item "$testRoot\profile\.claude\jobs\job-p\state.json" -ErrorAction SilentlyContinue

  # Case 10g-strict: an unreadable daemon list under the flag must not read as "no Sentinel running".
  $env:MOCK_CLAUDE_FAIL = '1'
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_CLAUDE_FAIL%"=="1" exit /b 9' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'if "%1"=="respawn" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-respawn.ps1" %2' + "`r`n" + 'exit /b 0' + "`r`n")
  $appliedBefore = @(Get-AppliedLines).Count
  $r10s = Run-Watchdog
  Remove-Item Env:MOCK_CLAUDE_FAIL
  Assert-True ($r10s.mode -eq 'shadow' -and $r10s.modeReason -match 'unreadable') 'a failed daemon read must keep the run in shadow'
  Assert-True (@(Get-AppliedLines).Count -eq $appliedBefore) 'a failed daemon read must apply nothing'

  # Case 10h: -Verify under the flag never applies.
  $appliedBefore = @(Get-AppliedLines).Count
  $r10h = Run-Watchdog -Verify
  Assert-True ($r10h.mode -eq 'shadow') '-Verify must not go live'
  Assert-True (@(Get-AppliedLines).Count -eq $appliedBefore) '-Verify must apply nothing'

  # Case 10i: removing the flag returns the run to shadow and re-expects the Sentinel.
  Remove-Item "$testRoot\state\flags\sentinel-off"
  $appliedBefore = @(Get-AppliedLines).Count
  $r10i = Run-Watchdog
  Assert-True ($r10i.mode -eq 'shadow') 'without the flag the run is shadow again'
  Assert-True (@($r10i.proposed.launchNeeded | Where-Object { $_.name -eq 'sentinel' }).Count -eq 1) 'without the flag the missing Sentinel is launchNeeded again'
  Assert-True (@(Get-AppliedLines).Count -eq $appliedBefore) 'shadow applies nothing'
  Assert-True (@($r10i.launches).Count -eq 0) 'shadow launches nothing'


  # ===== Ticket 09 ruling 2: the frontier wake =====
  # A mock rotate.ps1 records every -Wake call and answers like the real one; the planner
  # runs for real against a fixture issue file (FLEET_GITHUB_ISSUES_FIXTURE).
  foreach ($f in 'assignment.js','premises.js','work-state.js','exclusions.js','notify.js','assignment-parity.js','triage.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f", $true) }
  [IO.Directory]::CreateDirectory("$testRoot\state\work") | Out-Null
  [IO.Directory]::CreateDirectory("$testRoot\state\watch") | Out-Null
  [IO.Directory]::CreateDirectory("$testRoot\config") | Out-Null
  Write-Utf8 "$testRoot\config\cycle.json" '{"supervisor":{"pageKinds":["stray"]},"frontierWake":{"cooldownMinutes":60,"sources":["frontier","outbox"]}}'
  Write-Utf8 "$testRoot\bin\rotate.ps1" ('param([string]$Name,[string]$Wake,[switch]$Force,[switch]$DryRun)' + "`r`n" + '[IO.File]::AppendAllText("' + $testRoot.Replace('\', '\\') + '\rotate-calls.txt", "$Name|$Wake`n")' + "`r`n" + 'if ($env:MOCK_ROTATE_DEFER -eq "1") { Write-Output (@{ rotated = @(); deferred = @("$Name`: session is mid-turn (status busy)"); outcomes = @(@{ name = $Name; status = "deferred"; reason = "session is mid-turn (status busy)" }) } | ConvertTo-Json -Compress -Depth 6); exit 0 }' + "`r`n" + 'Write-Output (@{ rotated = @($Name); deferred = @(); outcomes = @(@{ name = $Name; status = "rotated"; reason = $null }) } | ConvertTo-Json -Compress -Depth 6)' + "`r`n" + 'exit 0' + "`r`n")
  function Get-RotateCalls { if (Test-Path "$testRoot\rotate-calls.txt") { @(Get-Content "$testRoot\rotate-calls.txt") } else { @() } }
  function Get-AlertLines { if (Test-Path "$testRoot\state\alerts\alerts.jsonl") { @(Get-Content "$testRoot\state\alerts\alerts.jsonl" | Where-Object { $_ }) } else { @() } }
  $wakeFixture = "$testRoot\issues-fixture.json"
  Write-Utf8 $wakeFixture '[{"number":501,"title":"Ready","url":"https://github.com/owner/repo/issues/501","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  $env:FLEET_GITHUB_ISSUES_FIXTURE = $wakeFixture
  # Live supervision is the precondition (a rollback case above removed the flag).
  Write-Utf8 (Join-Path $testRoot 'state\flags\sentinel-off') 'wake test'
  Remove-Item (Join-Path $testRoot 'state\heartbeats\sentinel.json') -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $testRoot 'state\watchdog\paged.json') -ErrorAction SilentlyContinue
  (Get-Content "$testRoot\tenants\test.json" -Raw | ConvertFrom-Json) | ForEach-Object { $_ | Add-Member -NotePropertyName readyLabel -NotePropertyValue 'ready-for-agent' -Force; $_ | Add-Member -NotePropertyName maxIcs -NotePropertyValue 2 -Force; $_ | Add-Member -NotePropertyName ownerLogin -NotePropertyValue 'cory-owner' -Force; $_ | ConvertTo-Json -Compress } | Set-Content "$testRoot\tenants\test.json" -Encoding UTF8
  $leadStart = Get-EpochMs (Get-Date).AddHours(-2)
  $idleLeadRows = '[' + $dispRow + ',{"id":"job-p","name":"pl-test","state":"working","status":"idle","pid":13,"startedAt":' + $leadStart + '}]'
  $busyLeadRows = $idleLeadRows.Replace('"status":"idle","pid":13', '"status":"busy","pid":13')
  Remove-Item "$testRoot\state\PAUSE" -ErrorAction SilentlyContinue
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 5 }

  # Case W1: idle lead + non-empty frontier + a free slot -> one wake through rotate.ps1 -Wake, one alert line.
  Set-AgentsRows $idleLeadRows
  $w1 = Run-Watchdog
  $wake1 = @($w1.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake1.decision -eq 'woken') "an idle lead with a frontier must be woken (got $($wake1.decision): $($wake1.reason)) mode=$($w1.mode) why=$($w1.modeReason) wakes=$(($w1.frontierWakes | ConvertTo-Json -Compress -Depth 5)) conditions=$(@($w1.conditions) -join ',')"
  Assert-True ((@($wake1.evidence) -join ' ') -match 'frontier #501') 'the wake evidence must name the frontier'
  Assert-True (@(Get-RotateCalls) -contains 'pl-test|frontier #501') 'the wake must go through rotate.ps1 -Wake with the evidence'
  $alerts1 = @(Get-AlertLines)
  Assert-True ($alerts1.Count -eq 1 -and ($alerts1[0] | ConvertFrom-Json).kind -eq 'frontier-wake') 'every executed wake must write one alert audit line'
  Assert-True ((Test-Path "$testRoot\state\watchdog\frontier-wake.json")) 'the wake state must be recorded'

  # Case W2: same evidence again inside the cooldown -> no second wake, no second alert.
  $w2 = Run-Watchdog
  $wake2 = @($w2.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake2.decision -eq 'cooldown') "the same evidence inside the cooldown must not wake again (got $($wake2.decision))"
  Assert-True (@(Get-RotateCalls).Count -eq 1) 'no second rotate call inside the cooldown'
  Assert-True (@(Get-AlertLines).Count -eq 1) 'no second alert inside the cooldown'

  # Case W3: a busy lead is never woken; the boundary belongs to rotate.ps1 and the watchdog does not even ask.
  Remove-Item "$testRoot\state\watchdog\frontier-wake.json" -ErrorAction SilentlyContinue
  Set-AgentsRows $busyLeadRows
  $w3 = Run-Watchdog
  $wake3 = @($w3.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake3.decision -eq 'none' -and $wake3.reason -match 'busy') 'a busy lead must not be woken'
  Assert-True (@(Get-RotateCalls).Count -eq 1) 'a busy lead must not reach rotate.ps1'

  # Case W4: rotate.ps1 deferring (its own boundary check) is recorded as deferred, no alert, no state.
  Set-AgentsRows $idleLeadRows
  $env:MOCK_ROTATE_DEFER = '1'
  $w4 = Run-Watchdog
  Remove-Item Env:MOCK_ROTATE_DEFER
  $wake4 = @($w4.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake4.decision -eq 'deferred') "a deferred rotation must be recorded as deferred (got $($wake4.decision))"
  Assert-True (@(Get-AlertLines).Count -eq 1) 'a deferred wake must not alert'

  # Case W5: no slot -> no wake even with a frontier.
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-1","role":"ic","tenant":"test","status":"active"},{"name":"ic-2","role":"ic","tenant":"test","status":"active"}]}'
  $w5 = Run-Watchdog
  $wake5 = @($w5.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake5.decision -eq 'none' -and $wake5.reason -match 'no slot') "without an IC slot the frontier must not wake (got $($wake5.decision): $($wake5.reason))"
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # Case W6: an empty frontier but an undelivered outbox wake newer than the lead's session -> wake on the outbox.
  # fleet #141: "the lead's session" is its door launch (live roster launchedAt), which a respawn never moves.
  Write-Utf8 $wakeFixture '[]'
  Write-Utf8 "$testRoot\state\roster.json" ('{"sessions":[{"name":"pl-test","role":"project-lead","tenant":"test","status":"active","launchedAt":"' + (Get-Date).ToUniversalTime().AddHours(-2).ToString('o') + '"}]}')
  Write-Utf8 "$testRoot\state\watch\wake-outbox.jsonl" ('{"at":"' + (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('o') + '","recordId":"test:issue-7","wake":"checks-settled"}' + "`n" + '{"at":"' + (Get-Date).ToUniversalTime().AddHours(-5).ToString('o') + '","recordId":"test:issue-8","wake":"checks-settled"}' + "`n")
  Remove-Item "$testRoot\state\watchdog\frontier-wake.json" -ErrorAction SilentlyContinue
  $w6 = Run-Watchdog
  $wake6 = @($w6.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake6.decision -eq 'woken' -and ((@($wake6.evidence) -join ' ') -match 'outbox checks-settled x1')) "an undelivered outbox wake must wake the lead, and only the one newer than the session counts (got $($wake6.decision): $(@($wake6.evidence) -join ' '))"
  $w6b = Run-Watchdog
  $wake6b = @($w6b.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake6b.decision -eq 'none') 'a consumed outbox wake must not wake again'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # Case W7: state/flags/frontier-wake-off disables the wake entirely.
  Write-Utf8 $wakeFixture '[{"number":502,"title":"Ready","url":"https://github.com/owner/repo/issues/502","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  Remove-Item "$testRoot\state\watchdog\frontier-wake.json" -ErrorAction SilentlyContinue
  Write-Utf8 "$testRoot\state\flags\frontier-wake-off" 'x'
  $callsBefore = @(Get-RotateCalls).Count
  $w7 = Run-Watchdog
  Assert-True (@($w7.frontierWakes).Count -eq 0 -and @(Get-RotateCalls).Count -eq $callsBefore) 'the flag must disable the wake'
  Remove-Item "$testRoot\state\flags\frontier-wake-off"

  # Case W8 (ticket 76, ADR 0012): a frontier wake writes one alerts.jsonl line
  # and makes ZERO network calls, even with FLEET_ALERT_WEBHOOK configured
  # (Send-FleetAlert is gone; before this ticket the wake POSTed to it).
  Remove-Item "$testRoot\state\watchdog\frontier-wake.json" -ErrorAction SilentlyContinue
  $webhookLog = Join-Path $testRoot 'webhook-requests.log'
  [IO.File]::WriteAllText($webhookLog, '')
  $webhookPort = Get-Random -Minimum 20000 -Maximum 40000
  $webhookPrefix = "http://127.0.0.1:$webhookPort/"
  $webhookJob = Start-Job -ScriptBlock {
    param($Prefix, $LogPath, $TimeoutMs)
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add($Prefix)
    $listener.Start()
    $asyncResult = $listener.BeginGetContext($null, $null)
    if ($asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs)) {
      $context = $listener.EndGetContext($asyncResult)
      Add-Content -Path $LogPath -Value 'received a request'
      $context.Response.OutputStream.Close()
    }
    $listener.Stop()
  } -ArgumentList $webhookPrefix, $webhookLog, 1500
  Start-Sleep -Milliseconds 400
  $env:FLEET_ALERT_WEBHOOK = $webhookPrefix
  Write-Utf8 $wakeFixture '[{"number":503,"title":"Ready","url":"https://github.com/owner/repo/issues/503","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  $alertsBeforeZeroPost = @(Get-AlertLines).Count
  $wZero = Run-Watchdog
  $wakeZero = @($wZero.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wakeZero.decision -eq 'woken') "this case needs a real wake to prove zero POSTs (got $($wakeZero.decision): $($wakeZero.reason))"
  Assert-True (@(Get-AlertLines).Count -eq $alertsBeforeZeroPost + 1) 'a frontier wake must still write one alerts.jsonl line'
  Wait-Job $webhookJob -Timeout 5 | Out-Null
  Assert-True (-not (Get-Content $webhookLog -Raw)) 'a frontier wake must make zero POSTs even with a webhook configured'
  Remove-Job $webhookJob -Force -ErrorAction SilentlyContinue
  Remove-Item Env:FLEET_ALERT_WEBHOOK
  Remove-Item "$testRoot\state\watchdog\frontier-wake.json" -ErrorAction SilentlyContinue

  # ===== Ticket 75 (ADR 0012): fleet-dead requires stale heartbeats AND work waiting =====
  # A session with nothing to do takes no turns and its heartbeat goes stale too;
  # that is not an outage. Reuses the frontier/wake fixtures already wired above
  # (assignment.js, the tenant's maxIcs/readyLabel, the empty live roster).
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Remove-Item "$testRoot\state\work\active.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watch\wake-outbox.jsonl" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\frontier-wake.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  Write-Utf8 $wakeFixture '[]'
  $env:FLEET_GITHUB_ISSUES_FIXTURE = $wakeFixture
  Set-AgentsRows $idleLeadRows
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 90 }

  # Case FD1 (red-tell): all statics stale, empty frontier, no active records, no
  # outbox lines -> today this raises fleet-dead; after, nothing, and the shadow
  # line records idle.
  $fd1 = Run-Watchdog
  Assert-True (-not (@($fd1.conditions) -contains 'fleet-dead')) 'staleness alone must not raise fleet-dead when nothing is waiting'
  Assert-True (@($fd1.conditions).Count -eq 0) 'an idle tick must raise no condition'
  Assert-True ($fd1.idle -eq $true) 'an idle tick must record idle:true on the shadow line'

  # Case FD2 (control a): a frontier candidate with a free slot must still page.
  Write-Utf8 $wakeFixture '[{"number":701,"title":"Ready","url":"https://github.com/owner/repo/issues/701","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  $fd2 = Run-Watchdog
  Assert-True (@($fd2.conditions) -contains 'fleet-dead') 'a waiting frontier candidate must still raise fleet-dead'
  Assert-True ($fd2.idle -ne $true) 'a paging tick must not record idle'
  Write-Utf8 $wakeFixture '[]'
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # Case FD3 (control b): one implementing active record must still page.
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-801":{"tenant":"test","issue":801,"state":"implementing"}}}'
  $fd3 = Run-Watchdog
  Assert-True (@($fd3.conditions) -contains 'fleet-dead') 'an implementing record must still raise fleet-dead'
  Remove-Item "$testRoot\state\work\active.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # Case FD3b: a record in hold alone must not page.
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-802":{"tenant":"test","issue":802,"state":"hold"}}}'
  $fd3b = Run-Watchdog
  Assert-True (-not (@($fd3b.conditions) -contains 'fleet-dead')) 'a hold record alone must not raise fleet-dead'
  Assert-True ($fd3b.idle -eq $true) 'hold-only work must still read as idle'
  Remove-Item "$testRoot\state\work\active.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # Case FD4 (control c): one unconsumed checks-settled outbox line must still page.
  Write-Utf8 "$testRoot\state\watch\wake-outbox.jsonl" ('{"at":"' + (Get-Date).ToUniversalTime().ToString('o') + '","recordId":"test:issue-9","wake":"checks-settled"}' + "`n")
  $fd4 = Run-Watchdog
  Assert-True (@($fd4.conditions) -contains 'fleet-dead') 'an unconsumed wake must still raise fleet-dead'
  Remove-Item "$testRoot\state\watch\wake-outbox.jsonl"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # Case FD5 (control d): an unreadable active.json fails toward paging.
  Write-Utf8 "$testRoot\state\work\active.json" '{oops'
  $fd5 = Run-Watchdog
  Assert-True (@($fd5.conditions) -contains 'fleet-dead') 'an unreadable active.json must fail toward paging'
  Remove-Item "$testRoot\state\work\active.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # Case FD6: staleMinutes is configurable via config/cycle.json watchdog.staleMinutes.
  Write-Utf8 "$testRoot\config\cycle.json" '{"watchdog":{"staleMinutes":30}}'
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-803":{"tenant":"test","issue":803,"state":"implementing"}}}'
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 40 }
  $fd6 = Run-Watchdog
  Assert-True (@($fd6.conditions) -contains 'fleet-dead') 'a 40-min heartbeat must trip a 30-min configured threshold'
  Assert-True ((Get-Content "$testRoot\state\watchdog\banner.txt" -Raw) -match 'threshold 30') 'the configured staleMinutes must appear in the condition detail'
  Remove-Item "$testRoot\config\cycle.json"
  Remove-Item "$testRoot\state\work\active.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 90 }   # FD6 left them at 40 min, under the default 45-min threshold restored above

  # ===== 2026-09-17 review (fleet #75-1): an unreadable tenant config, or zero =====
  # ===== readable tenants, counts as work waiting (fails CLOSED) =====
  $goodTenantJson = Get-Content "$testRoot\tenants\test.json" -Raw

  # Case FD7 (red-tell): the only tenant file is corrupt, with a real implementing
  # record in flight -> must fail toward paging, never read as idle.
  Write-Utf8 "$testRoot\tenants\test.json" '{oops'
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-804":{"tenant":"test","issue":804,"state":"implementing"}}}'
  $fd7 = Run-Watchdog
  Assert-True (@($fd7.conditions) -contains 'fleet-dead') 'an unreadable tenant config must fail toward paging'
  Assert-True ($fd7.idle -ne $true) 'an unreadable tenant config must not record idle'
  Write-Utf8 "$testRoot\tenants\test.json" $goodTenantJson
  Remove-Item "$testRoot\state\work\active.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # Case FD8 (red-tell): zero tenant files at all -> fails toward paging even with
  # nothing else to go on.
  Remove-Item "$testRoot\tenants\test.json"
  $fd8 = Run-Watchdog
  Assert-True (@($fd8.conditions) -contains 'fleet-dead') 'zero tenant files must fail toward paging'
  Write-Utf8 "$testRoot\tenants\test.json" $goodTenantJson
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # ===== 2026-09-17 review (fleet #75-3): a record's state that work-state.js does =====
  # ===== not recognize at all counts as waiting; the ruled six stay the waiting =====
  # ===== set among KNOWN states. Walks the real STATES enum so a new state turns =====
  # ===== this suite red until someone decides it. =====
  $statesRaw = & node -e "process.stdout.write(JSON.stringify(require(process.argv[1]).STATES))" "$testRoot\bin\work-state.js" | Out-String
  $allKnownStates = @(($statesRaw.Trim() | ConvertFrom-Json) | ForEach-Object { "$_" })
  Assert-True ($allKnownStates.Count -gt 0) 'the real work-state.js STATES enum must be readable for this test to mean anything'
  $ruledWaitingStates = @('assigned', 'implementing', 'pr-open', 'ci-wait', 'review', 'revision')
  foreach ($state in $allKnownStates) {
    Write-Utf8 "$testRoot\state\work\active.json" ('{"schemaVersion":1,"records":{"test-900":{"tenant":"test","issue":900,"state":"' + $state + '"}}}')
    $rState = Run-Watchdog
    $expectWaiting = $ruledWaitingStates -contains $state
    $isDead = (@($rState.conditions) -contains 'fleet-dead')
    Assert-True ($isDead -eq $expectWaiting) "state '$state' must classify as $(if ($expectWaiting) { 'waiting' } else { 'not waiting' }) (got fleet-dead=$isDead)"
    Remove-Item "$testRoot\state\work\active.json"
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  }
  # Case FD9 (red-tell): a state work-state.js has never heard of must fail toward
  # paging, not read as no work (QA used "quarantined").
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-901":{"tenant":"test","issue":901,"state":"quarantined"}}}'
  $fd9 = Run-Watchdog
  Assert-True (@($fd9.conditions) -contains 'fleet-dead') 'an unrecognized state must fail toward paging'
  Remove-Item "$testRoot\state\work\active.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # ===== 2026-09-17 review (fleet #75-4): the assignment.js frontier call is bounded =====
  # ===== and made at most once per tenant per tick =====
  # A "node" that logs every invocation and then blocks for ~20s before answering -
  # the shape of QA's repro (a 20s-blocking node shim making a 61s tick).
  # state/flags/triage-wake-off is set here so the Principal's SEPARATE, unbounded
  # triage.js call (a different script, a different ticket) does not also hit this
  # same shim and confound the "at most once" count this case exists to prove.
  Write-Utf8 "$testRoot\state\flags\triage-wake-off" 'x'
  Write-Utf8 "$testRoot\mock-bin\slow-node.cmd" ('@echo off' + "`r`n" + 'echo called >> "%~dp0slow-node-calls.log"' + "`r`n" + 'ping -n 21 127.0.0.1 >nul' + "`r`n" + 'echo {}' + "`r`n")
  Remove-Item "$testRoot\mock-bin\slow-node-calls.log" -ErrorAction SilentlyContinue
  $oldNodePath = $env:FLEET_NODE_PATH
  $env:FLEET_NODE_PATH = "$testRoot\mock-bin\slow-node.cmd"
  try {
    $fd10Start = Get-Date
    $fd10 = Run-Watchdog
    $fd10Elapsed = ((Get-Date) - $fd10Start).TotalSeconds
    Assert-True ($fd10Elapsed -lt 20) "a wedged planner call must not wedge the tick (took $([int]$fd10Elapsed)s)"
    Assert-True (@($fd10.conditions) -contains 'fleet-dead') 'a timed-out planner call is a planner failure and must fail toward paging'
    $slowNodeCalls = @(Get-Content "$testRoot\mock-bin\slow-node-calls.log" -ErrorAction SilentlyContinue | Where-Object { $_ })
    Assert-True ($slowNodeCalls.Count -eq 1) "at most one planner invocation per tenant per tick (got $($slowNodeCalls.Count))"
  } finally {
    if ($oldNodePath) { $env:FLEET_NODE_PATH = $oldNodePath } else { Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue }
  }
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue

  # Case FD11 (fleet #101 red-tell): every child the tick starts is bounded and
  # named on timeout. A known, non-waiting record makes Test-WorkWaiting ask
  # work-state.js for its STATES; against a 60s-blocking node that read was
  # unbounded and held the tick for the full minute, recorded nowhere.
  Write-Utf8 "$testRoot\mock-bin\slower-node.cmd" ('@echo off' + "`r`n" + 'ping -n 61 127.0.0.1 >nul' + "`r`n" + 'echo []' + "`r`n")
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-905":{"tenant":"test","issue":905,"state":"merged"}}}'
  $env:FLEET_NODE_PATH = "$testRoot\mock-bin\slower-node.cmd"
  try {
    $fd11Start = Get-Date
    $fd11 = Run-Watchdog
    $fd11Elapsed = ((Get-Date) - $fd11Start).TotalSeconds
    Assert-True ($fd11Elapsed -lt 45) "a wedged work-state.js read must not hold the tick (took $([int]$fd11Elapsed)s)"
    Assert-True (@($fd11.timeouts | Where-Object { "$($_.call)" -match 'work-state\.js' }).Count -eq 1) "the shadow line must name the call that timed out (timeouts: $($fd11.timeouts | ConvertTo-Json -Compress))"
    Assert-True (@($fd11.conditions) -contains 'fleet-dead') 'an unverifiable state still fails toward paging'
  } finally {
    if ($oldNodePath) { $env:FLEET_NODE_PATH = $oldNodePath } else { Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue }
  }
  Remove-Item "$testRoot\state\work\active.json"
  Remove-Item "$testRoot\state\flags\triage-wake-off"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue

  Remove-Item Env:FLEET_GITHUB_ISSUES_FIXTURE
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 5 }

  # ===== Ticket 84: heal a blocked, stale session when work is waiting =====
  # Reuses the fixtures wired above: assignment.js runs for real against
  # $wakeFixture, rotate.ps1 is the same recording mock, tenant "test" already
  # carries readyLabel/maxIcs/ownerLogin, and live supervision (sentinel-off) still
  # stands.
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-p") | Out-Null
  $jobPStatePath = "$testRoot\profile\.claude\jobs\job-p\state.json"
  $blockedPlRow = $plRow.Replace('"state":"working"', '"state":"blocked"')
  $env:FLEET_GITHUB_ISSUES_FIXTURE = $wakeFixture
  Write-Utf8 $wakeFixture '[{"number":901,"title":"Ready","url":"https://github.com/owner/repo/issues/901","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Set-AgentsRows "[$dispRow,$blockedPlRow]"

  # Case H1 (red-tell): pl-endzone-equivalent (pl-test) blocked, needs empty,
  # heartbeat 61 min, one frontier issue. Today: one blocked escalation, no action.
  # After: one rotate.ps1 -Name pl-test -Wake call on the mock.
  Write-Utf8 $jobPStatePath '{"needs":"","updatedAt":"2026-01-01T00:00:00Z"}'
  Set-Heartbeat 'pl-test' 61
  $h1 = Run-Watchdog
  Assert-True (@($h1.waiting | Where-Object { $_.name -eq 'pl-test' -and $_.kind -eq 'blocked' }).Count -eq 1) 'blocked must still be recorded under waiting'
  Assert-True (@($h1.conditions).Count -eq 0) 'a heal action must still never page'
  Assert-True (@(Get-RotateCalls | Where-Object { $_ -like 'pl-test|heal:*' }).Count -eq 1) 'a healed control-plane session must go through rotate.ps1 -Wake'
  $h1Heal = @($h1.healed | Where-Object { $_.name -eq 'pl-test' })
  Assert-True ($h1Heal.Count -eq 1 -and $h1Heal[0].action -eq 'rotate' -and $h1Heal[0].ok -eq $true) 'the shadow line must record a successful rotate heal'
  $healState1 = (Get-Content "$testRoot\state\watchdog\heal.json" -Raw) | ConvertFrom-Json
  Assert-True (@($healState1.'pl-test'.attempts).Count -eq 1) 'the heal attempt must be counted for the session'

  # Case H2 (control): needs "approve Bash" (a real permission prompt) must never heal.
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Write-Utf8 $jobPStatePath '{"needs":"approve Bash","updatedAt":"2026-01-01T00:00:00Z"}'
  $rotateCountBeforeH2 = @(Get-RotateCalls).Count
  $h2 = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH2) 'a permission prompt must never be healed'
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\heal.json")) 'a permission prompt must not even count as a heal attempt'
  # 2026-09-17 QA (fleet #84 review #5): a non-empty `needs` is recorded on the
  # shadow line WHY it was not healed (ok:false, action:none), not silently
  # dropped.
  $h2Entry = @($h2.healed | Where-Object { $_.name -eq 'pl-test' })
  Assert-True ($h2Entry.Count -eq 1 -and $h2Entry[0].ok -eq $false -and $h2Entry[0].action -eq 'none' -and "$($h2Entry[0].reason)" -match 'needs is not empty') 'a permission prompt must be recorded as not healed, with the reason, never actually healed'
  # Case H2b (control, Cory's ruling 2026-09-18, fleet #84): `^approve ` still
  # only raises permission-wait (unchanged, tested in the paging section below)
  # and must never also raise human-wait - a permission prompt is never doubled.
  Assert-True (-not (@($h2.conditions) -contains 'human-wait:pl-test')) 'a permission prompt must never raise human-wait'

  # Case H3 (control): heartbeat 59 min (under the 60-min threshold) must not heal.
  Write-Utf8 $jobPStatePath '{"needs":"","updatedAt":"2026-01-01T00:00:00Z"}'
  Set-Heartbeat 'pl-test' 59
  $rotateCountBeforeH3 = @(Get-RotateCalls).Count
  $h3 = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH3) 'a heartbeat under the threshold must not heal'
  Assert-True (@($h3.healed).Count -eq 0) 'an unstale heartbeat must not appear as healed'

  # Case H4 (control): empty frontier and no active records -> nothing waiting -> must not heal.
  Set-Heartbeat 'pl-test' 61
  Write-Utf8 $wakeFixture '[]'
  $rotateCountBeforeH4 = @(Get-RotateCalls).Count
  $h4 = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH4) 'nothing waiting must not heal'
  Assert-True (@($h4.healed).Count -eq 0) 'nothing waiting must not appear as healed'
  Write-Utf8 $wakeFixture '[{"number":901,"title":"Ready","url":"https://github.com/owner/repo/issues/901","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'

  # Case H5 (control): a third attempt within 24h must not heal past the cap (2).
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  $healNowIso = (Get-Date).ToUniversalTime().ToString('o')
  Write-Utf8 "$testRoot\state\watchdog\heal.json" ('{"pl-test":{"attempts":["' + $healNowIso + '","' + $healNowIso + '"]}}')
  $rotateCountBeforeH5 = @(Get-RotateCalls).Count
  $h5 = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH5) 'a third attempt within 24h must not heal past the cap'
  Assert-True (@($h5.healed).Count -eq 0) 'a capped session must not appear as healed'
  Assert-True (@($h5.waiting | Where-Object { $_.name -eq 'pl-test' -and $_.kind -eq 'blocked' }).Count -eq 1) 'a capped session must still be recorded as blocked'

  # Case H6: an IC's heal goes through the ticket 85 Do-Respawn path, not rotate.ps1.
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-950","role":"ic","tenant":"test","parent":"pl-test","issue":950,"status":"active"}]}'
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-ic950") | Out-Null
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-ic950\state.json" '{"needs":"","updatedAt":"2026-01-01T00:00:00Z"}'
  $icRow = '{"id":"job-ic950","name":"ic-950","state":"blocked","status":"idle","pid":950,"startedAt":' + (Get-EpochMs (Get-Date).AddHours(-3)) + '}'
  Set-AgentsRows "[$dispRow,$plRow,$icRow]"
  Set-Heartbeat 'ic-950' 61
  $rotateCountBeforeH6 = @(Get-RotateCalls).Count
  $h6 = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH6) 'an IC heal must never go through rotate.ps1'
  $h6Heal = @($h6.healed | Where-Object { $_.name -eq 'ic-950' })
  # 2026-09-17 QA (fleet #85 review #6): the mock respawn always succeeding is
  # not enough proof by itself (QA broke it and the suite stayed green because
  # nothing asserted `ok`) - also read last-heal-respawn.json (the -HealRespawn
  # call's own report) to prove the mock was actually invoked, and with ic-950's
  # name specifically.
  Assert-True ($h6Heal.Count -eq 1 -and $h6Heal[0].action -eq 'respawn' -and $h6Heal[0].ok -eq $true) 'an IC heal must be reported as a successful respawn action'
  $h6RespawnReport = Get-Content "$testRoot\state\watchdog\last-heal-respawn.json" -Raw | ConvertFrom-Json
  Assert-True (@($h6RespawnReport.respawned | Where-Object { $_.name -eq 'ic-950' }).Count -eq 1) 'the heal-respawn call must have actually respawned ic-950'

  # Case H6b (2026-09-18 QA, review 2, MINOR, red-tell): the report path was not
  # cleared before the call, so a child that dies before writing anything left
  # LAST TICK's report (a stale success, from H6 just above) to be read as this
  # tick's result. Replace sentinel-check.ps1 with a wrapper whose -HealRespawn
  # branch writes nothing at all and exits non-zero (the regular check still
  # delegates to the real script); the stale success from H6 must not survive.
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Set-AgentsRows "[$dispRow,$plRow,$icRow]"
  Set-Heartbeat 'ic-950' 61
  $sentinelCheckReal = Get-Content "$testRoot\bin\sentinel-check.ps1" -Raw
  Write-Utf8 "$testRoot\bin\sentinel-check.real.ps1" $sentinelCheckReal
  Write-Utf8 "$testRoot\bin\sentinel-check.ps1" ('param([switch]$Apply,[string]$ReportPath="",[string]$Actor="sentinel",[string]$HealRespawn="")' + "`r`n" + 'if ($HealRespawn) { exit 1 }' + "`r`n" + '& "$PSScriptRoot\sentinel-check.real.ps1" @PSBoundParameters')
  $h6b = Run-Watchdog
  Write-Utf8 "$testRoot\bin\sentinel-check.ps1" $sentinelCheckReal
  Remove-Item "$testRoot\bin\sentinel-check.real.ps1" -ErrorAction SilentlyContinue
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\last-heal-respawn.json")) 'the stale report must be removed before the call, and never rewritten by a child that writes nothing'
  $h6bHeal = @($h6b.healed | Where-Object { $_.name -eq 'ic-950' })
  Assert-True ($h6bHeal.Count -eq 1 -and $h6bHeal[0].ok -eq $false) 'a heal-respawn child that writes nothing must be read as failed, never a stale success'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # ===== Cory's ruling 2026-09-18 (fleet #84): the daemon DELETES `needs` =====
  # ===== rather than ever writing an empty string, so "present, empty" (the =====
  # ===== old rule) never actually fired. Heal when the job state read cleanly =====
  # ===== AND `needs` is absent or whitespace-only; any other non-empty needs =====
  # ===== is a session asking a human and pages human-wait instead of healing. =====
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  $blockedPlRowH7 = $plRow.Replace('"state":"working"', '"state":"blocked"')
  Set-AgentsRows "[$dispRow,$blockedPlRowH7]"
  Set-Heartbeat 'pl-test' 61

  # Case H7a (red-tell, ruling 2): a MISSING needs key - the real shape of 51 of
  # 52 job states on disk, including a working dispatcher - must now heal.
  Write-Utf8 $jobPStatePath '{"updatedAt":"2026-01-01T00:00:00Z"}'
  $rotateHealCountBeforeH7a = @(Get-RotateCalls | Where-Object { $_ -like 'pl-test|heal:*' }).Count
  $h7a = Run-Watchdog
  Assert-True (@(Get-RotateCalls | Where-Object { $_ -like 'pl-test|heal:*' }).Count -eq $rotateHealCountBeforeH7a + 1) 'a missing needs key must now be healed'
  $h7aEntry = @($h7a.healed | Where-Object { $_.name -eq 'pl-test' })
  Assert-True ($h7aEntry.Count -eq 1 -and $h7aEntry[0].ok -eq $true) 'a missing needs key must be recorded as a successful heal'

  # Case H7b (red-tell, ruling 2): whitespace-only needs must heal too.
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Set-AgentsRows "[$dispRow,$blockedPlRowH7]"
  Set-Heartbeat 'pl-test' 61
  Write-Utf8 $jobPStatePath '{"needs":"   ","updatedAt":"2026-01-01T00:00:00Z"}'
  $rotateHealCountBeforeH7b = @(Get-RotateCalls | Where-Object { $_ -like 'pl-test|heal:*' }).Count
  $h7b = Run-Watchdog
  Assert-True (@(Get-RotateCalls | Where-Object { $_ -like 'pl-test|heal:*' }).Count -eq $rotateHealCountBeforeH7b + 1) 'whitespace-only needs must be healed'
  $h7bEntry = @($h7b.healed | Where-Object { $_.name -eq 'pl-test' })
  Assert-True ($h7bEntry.Count -eq 1 -and $h7bEntry[0].ok -eq $true) 'whitespace-only needs must be recorded as a successful heal'

  # Case H7c (red-tell, ruling 2): a plain ask to a human ("reply go to merge
  # PR #41" - the one real blocked row on disk) must NOT heal, and must page a
  # new human-wait:<name> condition once, at normal priority, carrying the
  # needs text as its detail; a standing human-wait must not page again.
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Set-AgentsRows "[$dispRow,$blockedPlRowH7]"
  Set-Heartbeat 'pl-test' 61
  Write-Utf8 $jobPStatePath '{"needs":"reply go to merge PR #41","updatedAt":"2026-01-01T00:00:00Z"}'
  $rotateCountBeforeH7c = @(Get-RotateCalls).Count
  $h7c = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH7c) 'a plain human ask must not be healed'
  $h7cEntry = @($h7c.healed | Where-Object { $_.name -eq 'pl-test' })
  Assert-True ($h7cEntry.Count -eq 1 -and $h7cEntry[0].ok -eq $false -and "$($h7cEntry[0].reason)" -match 'needs is not empty') 'the reason must name the non-empty needs'
  Assert-True (@($h7c.conditions) -contains 'human-wait:pl-test') 'a plain human ask must raise human-wait'
  $h7cPaged = @($h7c.newlyPaged | Where-Object { $_.key -eq 'human-wait:pl-test' })
  Assert-True ($h7cPaged.Count -eq 1 -and $h7cPaged[0].priority -eq 'normal') 'human-wait must page once, at normal priority'
  Assert-True ("$($h7cPaged[0].page.body)" -eq 'reply go to merge PR #41') 'the page body must carry the needs text through Get-OneLine'
  $h7c2 = Run-Watchdog
  Assert-True (@($h7c2.newlyPaged | Where-Object { $_.key -eq 'human-wait:pl-test' }).Count -eq 0) 'a standing human-wait must not page again next tick'
  Assert-True (@($h7c2.conditions) -contains 'human-wait:pl-test') 'the standing human-wait condition itself must still be recorded'

  # Case H7d (red-tell, ruling 2): an unreadable job state must not heal and
  # must page nothing - there is no needs text to relay.
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Set-AgentsRows "[$dispRow,$blockedPlRowH7]"
  Set-Heartbeat 'pl-test' 61
  Write-Utf8 $jobPStatePath '{oops'
  $rotateCountBeforeH7d = @(Get-RotateCalls).Count
  $h7d = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH7d) 'an unreadable job state must not be healed'
  $h7dEntry = @($h7d.healed | Where-Object { $_.name -eq 'pl-test' })
  Assert-True ($h7dEntry.Count -eq 1 -and $h7dEntry[0].ok -eq $false -and "$($h7dEntry[0].reason)" -match 'unreadable') 'the reason must name the unreadable job state'
  Assert-True (@($h7d.conditions).Count -eq 0) 'an unreadable job state must page nothing'

  # Case H8 (fleet #84 review #7): a session with NO heartbeat file at all reads
  # as stale for healing too (matching fleet-dead's own treatment of "never
  # seen"), not skipped.
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Write-Utf8 $jobPStatePath '{"needs":"","updatedAt":"2026-01-01T00:00:00Z"}'
  Remove-Item "$testRoot\state\heartbeats\pl-test.json" -ErrorAction SilentlyContinue
  $rotateHealCountBeforeH8 = @(Get-RotateCalls | Where-Object { $_ -like 'pl-test|heal:*' }).Count
  $h8 = Run-Watchdog
  Assert-True (@(Get-RotateCalls | Where-Object { $_ -like 'pl-test|heal:*' }).Count -eq $rotateHealCountBeforeH8 + 1) 'a missing heartbeat must be healed as stale'
  Set-Heartbeat 'pl-test' 61

  # Case H9 (fleet #84 review #8): a corrupt heal.json must fail toward NOT
  # healing (never a silently reset cap) and be recorded on the shadow line.
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Write-Utf8 "$testRoot\state\watchdog\heal.json" '{oops'
  $rotateCountBeforeH9 = @(Get-RotateCalls).Count
  $h9 = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH9) 'a corrupt heal.json must heal nothing this tick'
  Assert-True ($h9.healStateUnreadable -eq $true) 'a corrupt heal.json must be recorded as unreadable on the shadow line'
  Assert-True ((Get-Content "$testRoot\state\watchdog\heal.json" -Raw) -eq '{oops') 'a corrupt heal.json must not be silently reset or overwritten'
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue

  # Case H10 (fleet #84 review #4): rotate.ps1 refusing (PAUSE, rotation-off, or
  # a deferred safe boundary - MOCK_ROTATE_DEFER stands in for all three) must
  # not count as an attempt; it is recorded, with its reason, and never counted.
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  $env:MOCK_ROTATE_DEFER = '1'
  $h10 = Run-Watchdog
  Remove-Item Env:MOCK_ROTATE_DEFER
  $h10Entry = @($h10.healed | Where-Object { $_.name -eq 'pl-test' })
  Assert-True ($h10Entry.Count -eq 1 -and $h10Entry[0].refused -eq $true) 'a deferred rotate must be recorded as refused'
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\heal.json")) 'a refused rotate must not count as an attempt'

  # Case H11 (fleet #84 review #3): a heal that succeeds THIS tick must not also
  # raise fleet-dead in the same tick - counts as fresh. Pre-seeded with one
  # prior attempt each (healCap is 2) so this tick is their LAST allowed heal;
  # the next tick is capped and the same staleness pages fleet-dead normally.
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-d") | Out-Null
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-d\state.json" '{"needs":"","updatedAt":"2026-01-01T00:00:00Z"}'
  Write-Utf8 $jobPStatePath '{"needs":"","updatedAt":"2026-01-01T00:00:00Z"}'
  $blockedDispH11 = $dispRow.Replace('"state":"working"', '"state":"blocked"')
  $blockedPlH11 = $plRow.Replace('"state":"working"', '"state":"blocked"')
  Set-AgentsRows "[$blockedDispH11,$blockedPlH11]"
  foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 61 }
  $healSeedAt = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('o')
  Write-Utf8 "$testRoot\state\watchdog\heal.json" ('{"dispatcher":{"attempts":["' + $healSeedAt + '"],"lastAction":"rotate","lastOk":true,"lastAt":"' + $healSeedAt + '"},"pl-test":{"attempts":["' + $healSeedAt + '"],"lastAction":"rotate","lastOk":true,"lastAt":"' + $healSeedAt + '"}}')
  $h11a = Run-Watchdog
  Assert-True (@($h11a.healed | Where-Object { $_.ok -eq $true }).Count -eq 2) 'both blocked+stale statics must heal this tick (their last allowed attempt)'
  Assert-True (-not (@($h11a.conditions) -contains 'fleet-dead')) 'a tick that healed must not also page fleet-dead'
  $h11b = Run-Watchdog
  Assert-True (@($h11b.healed | Where-Object { $_.ok -eq $true }).Count -eq 0) 'a capped session must heal no more'
  Assert-True (@($h11b.conditions) -contains 'fleet-dead') 'once healing is capped, the same staleness must page fleet-dead'
  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue

  # Case H12 (fleet #84 review #13): in shadow mode, the heal decision is
  # PROPOSED (recorded on the shadow line) without acting - rotate.ps1 is never
  # called and heal.json is never written.
  Remove-Item "$testRoot\state\flags\sentinel-off" -ErrorAction SilentlyContinue
  $blockedPlH12 = $plRow.Replace('"state":"working"', '"state":"blocked"')
  Set-AgentsRows "[$dispRow,$blockedPlH12]"
  Set-Heartbeat 'pl-test' 61
  $rotateCountBeforeH12 = @(Get-RotateCalls).Count
  $h12 = Run-Watchdog
  Assert-True ($h12.mode -eq 'shadow') 'this case must run in shadow to test proposal-only healing'
  Assert-True (@(Get-RotateCalls).Count -eq $rotateCountBeforeH12) 'shadow must never call rotate.ps1'
  Assert-True (-not (Test-Path "$testRoot\state\watchdog\heal.json")) 'shadow must never write heal.json'
  $h12Entry = @($h12.healed | Where-Object { $_.name -eq 'pl-test' })
  Assert-True ($h12Entry.Count -eq 1 -and $h12Entry[0].proposed -eq $true -and $h12Entry[0].action -eq 'rotate') 'shadow must propose the heal action on the shadow line'
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'restored after the shadow heal-proposal case'

  Remove-Item "$testRoot\state\watchdog\heal.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\last-heal-respawn.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\respawn-failed.json" -ErrorAction SilentlyContinue
  Set-AgentsRows $healthyRows
  foreach ($n in 'dispatcher','sentinel','pl-test') { Set-Heartbeat $n 5 }
  $null = Run-Watchdog

  # ===== 2026-09-17 QA (fleet #85 review BLOCKER): a no-op respawn must feed =====
  # ===== the launch-retry cap exactly as a genuinely failed launch does =====
  Set-AgentsRows $noSentinelRows
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 5 }
  $null = Run-Watchdog
  Set-Heartbeat 'dispatcher' 130   # past the 120-min stale-heartbeat-respawn threshold
  $env:MOCK_RESPAWN_NOOP = '1'
  $h13a = Run-Watchdog
  Assert-True (-not (@($h13a.conditions) -contains 'launch-retry:dispatcher')) 'the first no-op respawn must not yet trip launch-retry'
  Assert-True (@($h13a.waiting | Where-Object { $_.name -eq 'dispatcher' -and $_.kind -eq 'respawn-failed' }).Count -eq 1) 'the first failure must be recorded as waiting'
  $h13b = Run-Watchdog
  Remove-Item Env:MOCK_RESPAWN_NOOP
  Assert-True (@($h13b.conditions) -contains 'launch-retry:dispatcher') 'the second no-op respawn must trip launch-retry:dispatcher'
  $h13Entry = @($h13b.newlyPaged | Where-Object { $_.key -eq 'launch-retry:dispatcher' })[0]
  Assert-True ($null -ne $h13Entry -and $h13Entry.priority -eq 'high') 'launch-retry must resolve to high priority and page once'

  # Case H13c (2026-09-18 QA, review 2, MINOR, red-tell): a corrupt
  # respawn-failed.json must fail CLOSED (consistent with heal.json/H9) - never
  # reset to empty and overwritten, which would silently drop the attempt
  # history just recorded above and re-arm an unlimited retry.
  Write-Utf8 "$testRoot\state\watchdog\respawn-failed.json" '{oops'
  $env:MOCK_RESPAWN_NOOP = '1'
  $h13c = Run-Watchdog
  Remove-Item Env:MOCK_RESPAWN_NOOP
  Assert-True ($h13c.respawnFailStateUnreadable -eq $true) 'a corrupt respawn-failed.json must be recorded as unreadable on the shadow line'
  Assert-True ((Get-Content "$testRoot\state\watchdog\respawn-failed.json" -Raw) -eq '{oops') 'a corrupt respawn-failed.json must not be silently reset or overwritten'

  Remove-Item "$testRoot\state\watchdog\respawn-failed.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  Set-Heartbeat 'dispatcher' 5
  $null = Run-Watchdog

  # ===== 2026-09-17 QA (fleet #85 review #2): the verify wait is bounded per =====
  # ===== session AND capped per tick - three wedged statics must not cost 3x =====
  # ===== the wait, and only the cap (2) are actually attempted this tick =====
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"sentinel","role":"sentinel","parent":"dispatcher"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"},{"name":"pl-extra","role":"project-lead","parent":"dispatcher","tenant":"test"}]}'
  $wedgeStart = (Get-Date).AddHours(-3)
  $wedgedRows = '[' + $dispRow + ',{"id":"job-p","name":"pl-test","state":"working","status":"idle","pid":13,"startedAt":' + (Get-EpochMs $wedgeStart) + '},{"id":"job-pe2","name":"pl-extra","state":"working","status":"idle","pid":15,"startedAt":' + (Get-EpochMs $wedgeStart) + '}]'
  Set-AgentsRows $wedgedRows
  foreach ($n in 'dispatcher','pl-test','pl-extra') { Set-Heartbeat $n 130 }
  $env:MOCK_RESPAWN_NOOP = '1'
  $oldVerifyMs14 = $env:FLEET_RESPAWN_VERIFY_MS
  $env:FLEET_RESPAWN_VERIFY_MS = '300'
  $h14Start = Get-Date
  $h14 = Run-Watchdog
  $h14Elapsed = ((Get-Date) - $h14Start).TotalSeconds
  $env:FLEET_RESPAWN_VERIFY_MS = $oldVerifyMs14
  Remove-Item Env:MOCK_RESPAWN_NOOP
  Assert-True ($h14Elapsed -lt 15) "three wedged statics must not cost 3x the verify wait (took $([int]$h14Elapsed)s)"
  $h14Report = Get-Content "$testRoot\state\sentinel\last-check.json" -Raw | ConvertFrom-Json
  Assert-True (@($h14Report.respawnFailed).Count -eq 2) 'only the verify cap (2) may actually attempt respawn this tick'
  Assert-True (@($h14Report.respawnDeferred).Count -eq 1) 'the third wedged static must be deferred, not attempted'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"sentinel","role":"sentinel","parent":"dispatcher"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"}]}'
  Set-AgentsRows $healthyRows
  foreach ($n in 'dispatcher','sentinel','pl-test') { Set-Heartbeat $n 5 }
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\respawn-failed.json" -ErrorAction SilentlyContinue
  Remove-Item Env:FLEET_GITHUB_ISSUES_FIXTURE

  # ===== ADR 0011 (fleet #38): the triage wake =====
  # bin/triage.js runs for real against a fixture (FLEET_TRIAGE_ISSUES_FIXTURE); the mock
  # rotate.ps1 above records the wake. Without principal-live the frontier is only recorded.
  $triageFixture = "$testRoot\triage-fixture.json"
  Write-Utf8 $triageFixture '[{"number":601,"title":"Unrouted","url":"https://github.com/owner/repo/issues/601","body":"Something is off.","createdAt":"2026-09-02T00:00:00.000Z","labels":[],"assignees":[],"comments":[]}]'
  $env:FLEET_TRIAGE_ISSUES_FIXTURE = $triageFixture
  Remove-Item "$testRoot\state\watchdog\triage-wake.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\triage-frontier.json" -ErrorAction SilentlyContinue
  function Get-TriageRotateCalls { @(Get-RotateCalls | Where-Object { $_ -like 'pe-test|*' }) }

  # Case T1: flag absent -> shadow: the frontier is recorded to the shadow file, nothing is rotated.
  Set-AgentsRows $idleLeadRows
  $t1 = Run-Watchdog
  $tw1 = @($t1.triageWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($null -ne $tw1 -and $tw1.decision -eq 'shadow') "without principal-live the triage wake must be shadow (got $($tw1 | ConvertTo-Json -Compress -Depth 5))"
  Assert-True ((@($tw1.evidence) -join ' ') -match 'ticket #601') 'the shadow record must name the ticket'
  Assert-True (Test-Path "$testRoot\state\watchdog\triage-frontier.json") 'the shadow file must be written'
  $shadow1 = Get-Content "$testRoot\state\watchdog\triage-frontier.json" -Raw | ConvertFrom-Json
  Assert-True ($shadow1.live -eq $false -and (@(@($shadow1.tenants)[0].proposeNow) -contains 601)) 'the shadow file must carry the frontier'
  Assert-True (@(Get-TriageRotateCalls).Count -eq 0) 'shadow must not rotate the principal'

  # Case T2: flag present, principal rostered and idle, frontier non-empty -> one wake through rotate.ps1 -Wake, one triage-wake alert.
  Write-Utf8 "$testRoot\state\flags\principal-live" 'x'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"sentinel","role":"sentinel","parent":"dispatcher"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"},{"name":"pe-test","role":"principal","parent":"dispatcher","tenant":"test"}]}'
  $principalRows = $idleLeadRows.TrimEnd(']') + ',{"id":"job-pe","name":"pe-test","state":"working","status":"idle","pid":14,"startedAt":' + $leadStart + '}]'
  Set-AgentsRows $principalRows
  Set-Heartbeat 'pe-test' 5
  $alertsBefore = @(Get-AlertLines).Count
  $t2 = Run-Watchdog
  $tw2 = @($t2.triageWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($tw2.decision -eq 'woken') "an idle principal with a frontier must be woken (got $($tw2.decision): $($tw2.reason); error=$($tw2.frontierError))"
  Assert-True (@(Get-TriageRotateCalls) -contains 'pe-test|ticket #601') 'the triage wake must go through rotate.ps1 -Wake with the evidence'
  $alerts2 = @(Get-AlertLines)
  Assert-True ($alerts2.Count -eq $alertsBefore + 1 -and ($alerts2[-1] | ConvertFrom-Json).kind -eq 'triage-wake') 'every executed triage wake must write one alert audit line'
  Assert-True (Test-Path "$testRoot\state\watchdog\triage-wake.json") 'the triage wake state must be recorded'

  # Case T3: the same evidence inside the cooldown -> no second wake.
  $t3 = Run-Watchdog
  $tw3 = @($t3.triageWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($tw3.decision -eq 'cooldown') "identical evidence inside the cooldown must not wake again (got $($tw3.decision))"

  # Case T4: a busy principal is not woken.
  Remove-Item "$testRoot\state\watchdog\triage-wake.json" -ErrorAction SilentlyContinue
  Set-AgentsRows ($principalRows.Replace('"status":"idle","pid":14', '"status":"busy","pid":14'))
  $t4 = Run-Watchdog
  $tw4 = @($t4.triageWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($tw4.decision -eq 'none' -and $tw4.reason -match 'not idle') "a busy principal must not be woken (got $($tw4.decision): $($tw4.reason))"

  # Case T5: every issue routed -> nothing to wake for.
  Set-AgentsRows $principalRows
  Write-Utf8 $triageFixture '[{"number":602,"title":"Ready","url":"https://github.com/owner/repo/issues/602","body":"x","createdAt":"2026-09-02T00:00:00.000Z","labels":["ready-for-agent"],"assignees":[],"comments":[]}]'
  $t5 = Run-Watchdog
  $tw5 = @($t5.triageWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($tw5.decision -eq 'none' -and $tw5.reason -match 'nothing to wake for') "a routed-only board must not wake (got $($tw5.decision): $($tw5.reason))"

  # Case T6: an unreadable frontier wakes nothing and says so (fail closed).
  $env:FLEET_TRIAGE_ISSUES_FIXTURE = "$testRoot\missing-fixture.json"
  $callsBefore6 = @(Get-TriageRotateCalls).Count
  $t6 = Run-Watchdog
  $tw6 = @($t6.triageWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ("$($tw6.frontierError)" -ne '' -and $tw6.decision -eq 'none' -and $tw6.reason -match 'fail closed') "an unreadable frontier must fail closed (got $($tw6.decision): $($tw6.reason); error=$($tw6.frontierError))"
  Assert-True (@(Get-TriageRotateCalls).Count -eq $callsBefore6) 'an unreadable frontier must not rotate'
  $env:FLEET_TRIAGE_ISSUES_FIXTURE = $triageFixture

  # Case T6b (2026-09-17 QA, fleet #81 review #2): the triage frontier call is
  # bounded - previously unbounded and run BEFORE the PAUSE check below it, so a
  # wedged gh call inside triage.js stalled even a PAUSED tick. Reuses the
  # blocking node shim from the ticket 75-4 planner-boundedness case.
  Write-Utf8 "$testRoot\state\PAUSE" 'reason=test; setAt=now; until='
  Remove-Item "$testRoot\mock-bin\slow-node-calls.log" -ErrorAction SilentlyContinue
  $oldNodePathT6b = $env:FLEET_NODE_PATH
  $env:FLEET_NODE_PATH = "$testRoot\mock-bin\slow-node.cmd"
  try {
    $t6bStart = Get-Date
    $t6b = Run-Watchdog
    $t6bElapsed = ((Get-Date) - $t6bStart).TotalSeconds
    Assert-True ($t6bElapsed -lt 20) "a wedged triage call must not stall a paused tick (took $([int]$t6bElapsed)s)"
    $tw6b = @($t6b.triageWakes | Where-Object { $_.tenant -eq 'test' })[0]
    Assert-True ("$($tw6b.frontierError)" -match 'timed out') "a timed-out triage call must be recorded as a frontier failure (got $($tw6b.frontierError))"
  } finally {
    if ($oldNodePathT6b) { $env:FLEET_NODE_PATH = $oldNodePathT6b } else { Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue }
  }
  Remove-Item "$testRoot\state\PAUSE" -ErrorAction SilentlyContinue

  # Case T7: state/flags/triage-wake-off disables the block entirely.
  Write-Utf8 "$testRoot\state\flags\triage-wake-off" 'x'
  $t7 = Run-Watchdog
  Assert-True (@($t7.triageWakes).Count -eq 0) 'the flag must disable the triage wake'
  Remove-Item "$testRoot\state\flags\triage-wake-off"
  Remove-Item "$testRoot\state\flags\principal-live"
  Remove-Item Env:FLEET_TRIAGE_ISSUES_FIXTURE

  # ===== Ticket 77 (ADR 0012): conditions page through the door, by priority =====
  # Reuses the local-HttpListener mock-Pushover pattern from tests/page.tests.ps1
  # (a separate background job standing in for Pushover, since it must block on
  # GetContext() while this script posts to it).
  function Start-MockPushover {
    param([string]$LogPath, [int]$Count = 10)
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $prefix = "http://127.0.0.1:$port/"
    $job = Start-Job -ScriptBlock {
      param($Prefix, $LogPath, $RequestCount)
      $listener = New-Object System.Net.HttpListener
      $listener.Prefixes.Add($Prefix)
      $listener.Start()
      for ($i = 0; $i -lt $RequestCount; $i++) {
        $context = $listener.GetContext()
        $reader = New-Object IO.StreamReader($context.Request.InputStream, $context.Request.ContentEncoding)
        $body = $reader.ReadToEnd()
        $reader.Close()
        Add-Content -Path $LogPath -Value $body
        $buffer = [Text.Encoding]::UTF8.GetBytes('{"status":1,"request":"test"}')
        $context.Response.ContentLength64 = $buffer.Length
        $context.Response.OutputStream.Write($buffer, 0, $buffer.Length)
        $context.Response.OutputStream.Close()
      }
      $listener.Stop()
    } -ArgumentList $prefix, $LogPath, $Count
    Start-Sleep -Milliseconds 400
    return [pscustomobject]@{ Job = $job; Prefix = $prefix }
  }
  function Get-PostedBodies { param([string]$LogPath) if (Test-Path $LogPath) { @(Get-Content $LogPath | Where-Object { $_ }) } else { @() } }
  function ConvertFrom-FormBody {
    param([string]$Body)
    $result = @{}
    foreach ($pair in ($Body -split '&')) {
      if (-not $pair) { continue }
      $parts = $pair -split '=', 2
      $key = [Uri]::UnescapeDataString($parts[0])
      $value = if ($parts.Count -gt 1) { [Uri]::UnescapeDataString($parts[1]) } else { '' }
      $result[$key] = $value
    }
    return $result
  }

  # Clean baseline: static roster back to dispatcher/sentinel/pl-test, live roster
  # carries one active IC (ic-950) so it is expected and never read as a stray.
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"sentinel","role":"sentinel","parent":"dispatcher"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"}]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-950","role":"ic","tenant":"test","parent":"pl-test","issue":950,"status":"active"}]}'
  Remove-Item "$testRoot\config\cycle.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\heartbeats\sentinel.json" -ErrorAction SilentlyContinue
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'page test'
  foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 5 }
  Set-AgentsRows $noSentinelRows
  $null = Run-Watchdog   # settle the reset before asserting on a clean baseline
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue

  $pushLog = Join-Path $testRoot 'pushover-requests.log'
  [IO.File]::WriteAllText($pushLog, '')
  $pushMock = Start-MockPushover -LogPath $pushLog -Count 10
  $oldPushoverUrl77 = $env:FLEET_PUSHOVER_URL
  $env:FLEET_PUSHOVER_URL = $pushMock.Prefix
  [IO.Directory]::CreateDirectory("$testRoot\state\pages") | Out-Null
  Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-77","user":"usr-77"}'

  try {
    # Fixture: ic-950 has waited 10 minutes on a permission prompt (default threshold 5 min).
    [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-ic-950") | Out-Null
    Write-Utf8 "$testRoot\profile\.claude\jobs\job-ic-950\state.json" ('{"needs":"approve Read: something","updatedAt":"' + (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('o') + '"}')
    $pwRow = '{"id":"job-ic-950","name":"ic-950","state":"working","status":"idle","pid":88,"startedAt":' + (Get-EpochMs (Get-Date).AddHours(-1)) + '}'
    $jobStatePath77 = "$testRoot\profile\.claude\jobs\job-ic-950\state.json"
    # ic-950's daemon row stays present for the whole section: dropping it would
    # also raise (and page) ic-vanished, contaminating the POST counts below. Only
    # its job-state `needs` field toggles between stuck and answered.
    Set-AgentsRows ($noSentinelRows.TrimEnd(']') + ',' + $pwRow + ']')

    # Case PG1 (red-tell): a permission-wait condition pages once through Send-FleetPage
    # at high priority (Pushover priority 1).
    $pg1 = Run-Watchdog
    Assert-True ((Get-PagedKeys $pg1.newlyPaged) -contains 'permission-wait:ic-950:job-ic-950') 'a stuck permission prompt must page'
    $pg1Entry = @($pg1.newlyPaged | Where-Object { $_.key -eq 'permission-wait:ic-950:job-ic-950' })[0]
    Assert-True ($pg1Entry.priority -eq 'high') 'permission-wait must resolve to high priority'
    $pgBodies1 = @(Get-PostedBodies $pushLog)
    Assert-True ($pgBodies1.Count -eq 1) 'exactly one page must reach Pushover'
    $pgForm1 = ConvertFrom-FormBody $pgBodies1[0]
    Assert-True ($pgForm1.priority -eq '1') 'high must map to Pushover priority 1'

    # Case PG2: the same standing condition pages nothing on a second tick.
    $pg2 = Run-Watchdog
    Assert-True (@($pg2.newlyPaged).Count -eq 0) 'a standing permission-wait must not page again'
    Assert-True (@(Get-PostedBodies $pushLog).Count -eq 1) 'a standing permission-wait must post nothing new'

    # Case PG3: the prompt is answered (condition clears), then a new one appears - pages once more.
    Write-Utf8 $jobStatePath77 ('{"needs":"","updatedAt":"' + (Get-Date).ToUniversalTime().ToString('o') + '"}')
    $null = Run-Watchdog   # settle: the condition clears; no page for clearing
    Write-Utf8 $jobStatePath77 ('{"needs":"approve Read: something","updatedAt":"' + (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('o') + '"}')
    $pg3 = Run-Watchdog
    Assert-True ((Get-PagedKeys $pg3.newlyPaged) -contains 'permission-wait:ic-950:job-ic-950') 'a cleared-then-returned condition must page again'
    Assert-True (@(Get-PostedBodies $pushLog).Count -eq 2) 'the second sighting must post again'

    # Case PG4 (2026-09-17 QA hardened): a dispatcher respawn (a fault the fleet
    # healed by itself) produces zero POSTs, zero pages.jsonl lines, and is
    # recorded log-only (one escalation file, one `notified` entry). The old
    # (ticket-76-removed) code toasted a respawned dispatcher directly, outside
    # Send-FleetPage - -NoToast on THIS test's Run-Watchdog call would not have
    # caught that, since it only suppresses Send-FleetPage's own toast; this case
    # is the control the review asked for that a reintroduced bare toast call
    # would actually surface (verified by hand: temporarily restoring the old
    # `Send-FleetToast` call here pops a real toast when this case runs).
    # The permission-wait condition is left standing (already paged, deduped) so
    # the whole delta below is attributable to the respawn alone.
    $postsBeforeRespawn = @(Get-PostedBodies $pushLog).Count
    $pagesLinesBeforeRespawn = @(Get-Content "$testRoot\state\pages\pages.jsonl" -ErrorAction SilentlyContinue | Where-Object { $_ }).Count
    $escFilesBeforeRespawn = @(Get-EscalationFiles '*-supervisor-dispatcher-respawned.json').Count
    $stoppedDisp77 = $dispRow.Replace('"state":"working"', '"state":"stopped"')
    Set-AgentsRows "[$stoppedDisp77,$plRow,$pwRow]"
    $pg4 = Run-Watchdog
    Assert-True (@($pg4.proposed.respawned | Where-Object { $_.name -eq 'dispatcher' }).Count -eq 1) 'the check must respawn the stopped dispatcher'
    Assert-True (@(Get-PostedBodies $pushLog).Count -eq $postsBeforeRespawn) 'a dispatcher respawn must produce zero POSTs'
    Assert-True (@(Get-Content "$testRoot\state\pages\pages.jsonl" -ErrorAction SilentlyContinue | Where-Object { $_ }).Count -eq $pagesLinesBeforeRespawn) 'a dispatcher respawn must add no Send-FleetPage audit line to pages.jsonl'
    Assert-True (@($pg4.notified | Where-Object { $_.name -eq 'dispatcher' -and $_.kind -eq 'respawned' -and $_.toastDelivered -eq $null }).Count -eq 1) 'a healed respawn is recorded log-only, never toasted'
    Assert-True (@(Get-EscalationFiles '*-supervisor-dispatcher-respawned.json').Count -eq $escFilesBeforeRespawn + 1) 'a healed respawn leaves exactly one new escalation file, the log-only record'
  } finally {
    if ($pushMock -and $pushMock.Job) { Stop-Job $pushMock.Job -ErrorAction SilentlyContinue; Remove-Job $pushMock.Job -Force -ErrorAction SilentlyContinue }
    if ($oldPushoverUrl77) { $env:FLEET_PUSHOVER_URL = $oldPushoverUrl77 } else { Remove-Item Env:FLEET_PUSHOVER_URL -ErrorAction SilentlyContinue }
  }
  Set-AgentsRows $noSentinelRows
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'   # drop ic-950 so it never reads as ic-vanished later
  Remove-Item "$testRoot\state\pages\pushover.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # ===== 2026-09-17 QA (fleet #77 review BLOCKER): a page is not "paged" (and so =====
  # ===== exempt from re-attempt) until Send-FleetPage confirms delivery =====
  $oldPushoverUrlDr = $env:FLEET_PUSHOVER_URL
  $retryPushLog = Join-Path $testRoot 'pushover-retry.log'
  [IO.File]::WriteAllText($retryPushLog, '')
  # Back to shadow (sentinel expected again) for a plain, mode-independent
  # sentinel-stale condition to retry against; paging fires in shadow too
  # (never gated on mode), and restored to live at the end of this block.
  Remove-Item "$testRoot\state\flags\sentinel-off" -ErrorAction SilentlyContinue
  try {
    Set-Heartbeat 'sentinel' 90

    # Case DR1 (red-tell): a dead port (nothing listening) on tick 1 -> attempted
    # (the first sighting always reports), not delivered, attempts=1.
    $deadPort = Get-Random -Minimum 20000 -Maximum 40000
    $env:FLEET_PUSHOVER_URL = "http://127.0.0.1:$deadPort/"
    Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-dr","user":"usr-dr"}'
    $dr1 = Run-Watchdog
    Assert-True ((Get-PagedKeys $dr1.newlyPaged) -contains 'sentinel-stale') 'a first attempt, even a failed one, must report as newly paged'
    $pagedDr1 = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json
    Assert-True ($null -eq $pagedDr1.'sentinel-stale'.deliveredAt -and $pagedDr1.'sentinel-stale'.attempts -eq 1) 'a connection-refused attempt must not be marked delivered, and must count'

    # Case DR2: the listener comes up -> tick 2 delivers, exactly one real POST.
    $drMock = Start-MockPushover -LogPath $retryPushLog -Count 5
    $env:FLEET_PUSHOVER_URL = $drMock.Prefix
    $dr2 = Run-Watchdog
    $pagedDr2 = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json
    Assert-True ($null -ne $pagedDr2.'sentinel-stale'.deliveredAt) 'a successful retry must set deliveredAt'
    Assert-True (@(Get-PostedBodies $retryPushLog).Count -eq 1) 'exactly one real POST must reach Pushover once it answers'
    Stop-Job $drMock.Job -ErrorAction SilentlyContinue; Remove-Job $drMock.Job -Force -ErrorAction SilentlyContinue

    # Case DR3: standing, already delivered -> tick 3 attempts and posts nothing more.
    $postsBeforeDr3 = @(Get-PostedBodies $retryPushLog).Count
    $dr3 = Run-Watchdog
    Assert-True (@($dr3.newlyPaged).Count -eq 0) 'a delivered condition must not attempt again'
    Assert-True (@(Get-PostedBodies $retryPushLog).Count -eq $postsBeforeDr3) 'a delivered condition must post nothing more'
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue

    # Case DR4: unconfigured on ticks 1-2 (never counts as an attempt, never
    # blocks a retry), then configured on tick 3 -> exactly one POST, on tick 3.
    Remove-Item "$testRoot\state\pages\pushover.json" -ErrorAction SilentlyContinue
    Set-Heartbeat 'sentinel' 90
    $dr4a = Run-Watchdog
    Assert-True ((Get-PagedKeys $dr4a.newlyPaged) -contains 'sentinel-stale') 'a first sighting must report even while unconfigured'
    $dr4b = Run-Watchdog
    Assert-True (@($dr4b.newlyPaged).Count -eq 0) 'a standing unconfigured retry must not report again'
    $drMock2 = Start-MockPushover -LogPath $retryPushLog -Count 5
    $env:FLEET_PUSHOVER_URL = $drMock2.Prefix
    Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-dr2","user":"usr-dr2"}'
    $postsBeforeDr4c = @(Get-PostedBodies $retryPushLog).Count
    $dr4c = Run-Watchdog
    Assert-True (@(Get-PostedBodies $retryPushLog).Count -eq $postsBeforeDr4c + 1) 'the tick after credentials appear must deliver, with exactly one POST'
    Stop-Job $drMock2.Job -ErrorAction SilentlyContinue; Remove-Job $drMock2.Job -Force -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\pages\pushover.json" -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue

    # Case DR5: three real failed attempts -> gaveUpAt is set and a fourth tick,
    # still inside pages.retryAfterMinutes, attempts and posts nothing more.
    Set-Heartbeat 'sentinel' 90
    Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-giveup","user":"usr-giveup"}'
    $refusedPortGiveUp = Get-Random -Minimum 20000 -Maximum 40000
    $env:FLEET_PUSHOVER_URL = "http://127.0.0.1:$refusedPortGiveUp/"
    $null = Run-Watchdog; $null = Run-Watchdog; $null = Run-Watchdog
    $pagedGiveUp = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json
    Assert-True ($pagedGiveUp.'sentinel-stale'.attempts -eq 3 -and $null -ne $pagedGiveUp.'sentinel-stale'.gaveUpAt) 'three failed attempts must give up'
    $dr5d = Run-Watchdog
    Assert-True (@($dr5d.newlyPaged).Count -eq 0) 'a given-up condition must not attempt a fourth time within retryAfterMinutes'

    # Case DR6 (2026-09-18 QA, fleet #77 review 2 MAJOR, red-tell): gaveUpAt used
    # to be permanent until the condition cleared - a wrong token meant silence
    # forever even once fixed. 61 minutes after giving up (past the default
    # 60-minute pages.retryAfterMinutes), the next tick gets one more real
    # attempt.
    $drMock6 = Start-MockPushover -LogPath $retryPushLog -Count 5
    $env:FLEET_PUSHOVER_URL = $drMock6.Prefix
    $giveUpAt61 = (Get-Date).ToUniversalTime().AddMinutes(-61).ToString('o')
    $pagedGiveUp.'sentinel-stale'.gaveUpAt = $giveUpAt61
    ($pagedGiveUp | ConvertTo-Json -Depth 8 -Compress) | Set-Content "$testRoot\state\watchdog\paged.json" -Encoding UTF8
    $postsBeforeDr6 = @(Get-PostedBodies $retryPushLog).Count
    $dr6 = Run-Watchdog
    Assert-True (@(Get-PostedBodies $retryPushLog).Count -eq $postsBeforeDr6 + 1) 'a given-up condition must retry once retryAfterMinutes has passed'
    $pagedDr6 = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json
    Assert-True ($null -ne $pagedDr6.'sentinel-stale'.deliveredAt -and $null -eq $pagedDr6.'sentinel-stale'.gaveUpAt) 'a successful retry after the window must clear gaveUpAt and set deliveredAt'
    Stop-Job $drMock6.Job -ErrorAction SilentlyContinue; Remove-Job $drMock6.Job -Force -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue

    # Case DR7: give up again, then touch pushover.json (Cory fixed the token) -
    # the very next tick retries immediately, without waiting out retryAfterMinutes.
    Set-Heartbeat 'sentinel' 90
    $env:FLEET_PUSHOVER_URL = "http://127.0.0.1:$refusedPortGiveUp/"
    $null = Run-Watchdog; $null = Run-Watchdog; $null = Run-Watchdog
    $pagedGiveUp2 = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json
    Assert-True ($null -ne $pagedGiveUp2.'sentinel-stale'.gaveUpAt) 'three failed attempts must give up (again, for this case)'
    Start-Sleep -Milliseconds 50   # ensure the touched mtime is measurably later
    Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-fixed","user":"usr-fixed"}'
    $drMock7 = Start-MockPushover -LogPath $retryPushLog -Count 5
    $env:FLEET_PUSHOVER_URL = $drMock7.Prefix
    $postsBeforeDr7 = @(Get-PostedBodies $retryPushLog).Count
    $dr7 = Run-Watchdog
    Assert-True (@(Get-PostedBodies $retryPushLog).Count -eq $postsBeforeDr7 + 1) 'touching pushover.json after a give-up must retry immediately, not wait out retryAfterMinutes'
    Stop-Job $drMock7.Job -ErrorAction SilentlyContinue; Remove-Job $drMock7.Job -Force -ErrorAction SilentlyContinue
  } finally {
    if ($drMock -and $drMock.Job) { Stop-Job $drMock.Job -ErrorAction SilentlyContinue; Remove-Job $drMock.Job -Force -ErrorAction SilentlyContinue }
    if ($drMock2 -and $drMock2.Job) { Stop-Job $drMock2.Job -ErrorAction SilentlyContinue; Remove-Job $drMock2.Job -Force -ErrorAction SilentlyContinue }
    if ($drMock6 -and $drMock6.Job) { Stop-Job $drMock6.Job -ErrorAction SilentlyContinue; Remove-Job $drMock6.Job -Force -ErrorAction SilentlyContinue }
    if ($drMock7 -and $drMock7.Job) { Stop-Job $drMock7.Job -ErrorAction SilentlyContinue; Remove-Job $drMock7.Job -Force -ErrorAction SilentlyContinue }
    if ($oldPushoverUrlDr) { $env:FLEET_PUSHOVER_URL = $oldPushoverUrlDr } else { Remove-Item Env:FLEET_PUSHOVER_URL -ErrorAction SilentlyContinue }
  }
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'restored after the delivery-retry block'
  Remove-Item "$testRoot\state\pages\pushover.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\heartbeats\sentinel.json" -ErrorAction SilentlyContinue
  foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 5 }
  $null = Run-Watchdog

  # ===== 2026-09-17 QA (fleet #77 review #5): a configured pages block is honoured: =====
  # ===== a per-kind priority override, and fleetDeadRepeatMinutes governing the =====
  # ===== repeat clock, not the 120-minute default =====
  $oldPushoverUrlCfg = $env:FLEET_PUSHOVER_URL
  $cfgPushLog = Join-Path $testRoot 'pushover-cfg.log'
  [IO.File]::WriteAllText($cfgPushLog, '')
  $cfgMock = $null
  Remove-Item "$testRoot\state\flags\sentinel-off" -ErrorAction SilentlyContinue   # shadow: sentinel expected again
  try {
    Write-Utf8 "$testRoot\config\cycle.json" '{"pages":{"priority":{"sentinel-stale":"high"},"defaultPriority":"normal","fleetDeadRepeatMinutes":10}}'
    Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-cfg","user":"usr-cfg"}'
    $cfgMock = Start-MockPushover -LogPath $cfgPushLog -Count 5
    $env:FLEET_PUSHOVER_URL = $cfgMock.Prefix
    Set-Heartbeat 'sentinel' 90
    $cfg1 = Run-Watchdog
    $cfgEntry = @($cfg1.newlyPaged | Where-Object { $_.key -eq 'sentinel-stale' })[0]
    Assert-True ($null -ne $cfgEntry -and $cfgEntry.priority -eq 'high') "a configured pages.priority override must be honoured (got $($cfgEntry.priority))"
    Stop-Job $cfgMock.Job -ErrorAction SilentlyContinue; Remove-Job $cfgMock.Job -Force -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\heartbeats\sentinel.json" -ErrorAction SilentlyContinue
    Write-Utf8 "$testRoot\state\flags\sentinel-off" 'restored for the fleet-dead half of this case'

    # A fleet-dead delivered 11 minutes ago is due under the configured 10-minute
    # window (the hardcoded 120-minute default would not have fired here).
    $cfgMock = Start-MockPushover -LogPath $cfgPushLog -Count 5
    $env:FLEET_PUSHOVER_URL = $cfgMock.Prefix
    $deliveredAt11 = (Get-Date).ToUniversalTime().AddMinutes(-11).ToString('o')
    Write-Utf8 "$testRoot\state\watchdog\paged.json" ('{"fleet-dead":{"firstSeen":"' + $deliveredAt11 + '","lastSeen":"' + $deliveredAt11 + '","detail":"stale","deliveredAt":"' + $deliveredAt11 + '","attempts":0,"lastAttemptAt":null,"lastError":null,"gaveUpAt":null,"url":null,"repeatedAt":null}}')
    foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 90 }
    Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-951":{"tenant":"test","issue":951,"state":"implementing"}}}'
    $cfg2 = Run-Watchdog
    Assert-True ($null -ne $cfg2.repeatPaged -and $cfg2.repeatPaged.key -eq 'fleet-dead') "an 11-minute-old delivery must repeat under a configured 10-minute window (got $($cfg2.repeatPaged | ConvertTo-Json -Compress))"
  } finally {
    if ($cfgMock -and $cfgMock.Job) { Stop-Job $cfgMock.Job -ErrorAction SilentlyContinue; Remove-Job $cfgMock.Job -Force -ErrorAction SilentlyContinue }
    if ($oldPushoverUrlCfg) { $env:FLEET_PUSHOVER_URL = $oldPushoverUrlCfg } else { Remove-Item Env:FLEET_PUSHOVER_URL -ErrorAction SilentlyContinue }
  }
  Remove-Item "$testRoot\config\cycle.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\pages\pushover.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\work\active.json" -ErrorAction SilentlyContinue
  foreach ($n in 'dispatcher', 'sentinel', 'pl-test') { Set-Heartbeat $n 5 }
  $null = Run-Watchdog

  # ===== 2026-09-17 QA (fleet #77 review #6): a condition's escalation file path =====
  # ===== becomes its `url`, and that url reaches the actual Pushover POST =====
  $oldPushoverUrlLink = $env:FLEET_PUSHOVER_URL
  $urlPushLog = Join-Path $testRoot 'pushover-url.log'
  [IO.File]::WriteAllText($urlPushLog, '')
  $urlMock = $null
  try {
    Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-url","user":"usr-url"}'
    $urlMock = Start-MockPushover -LogPath $urlPushLog -Count 5
    $env:FLEET_PUSHOVER_URL = $urlMock.Prefix
    $strayRowUrl = '{"id":"job-url-stray","name":"ic-888","state":"working","status":"idle","pid":88,"startedAt":' + (Get-EpochMs $oldStart) + '}'
    Set-AgentsRows "[$dispRow,$plRow,$strayRowUrl]"
    $null = Run-Watchdog
    $urlEntry = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw | ConvertFrom-Json).'escalation:ic-888:stray'
    Assert-True ($null -ne $urlEntry.url -and (Test-Path $urlEntry.url)) 'an escalation condition''s url must be its escalation file path'
    $urlBodies = @(Get-PostedBodies $urlPushLog)
    Assert-True ($urlBodies.Count -eq 1) 'exactly one POST for the stray condition'
    $urlForm = ConvertFrom-FormBody $urlBodies[0]
    Assert-True ($urlForm.url -eq $urlEntry.url) 'the escalation file path must reach the actual Pushover POST'
  } finally {
    if ($urlMock -and $urlMock.Job) { Stop-Job $urlMock.Job -ErrorAction SilentlyContinue; Remove-Job $urlMock.Job -Force -ErrorAction SilentlyContinue }
    if ($oldPushoverUrlLink) { $env:FLEET_PUSHOVER_URL = $oldPushoverUrlLink } else { Remove-Item Env:FLEET_PUSHOVER_URL -ErrorAction SilentlyContinue }
  }
  Set-AgentsRows $noSentinelRows
  Remove-Item "$testRoot\state\pages\pushover.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # ===== Ticket 78 (ADR 0012): fleet-dead repeats once, two hours on, at emergency =====
  Remove-Item "$testRoot\state\work\active.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watch\wake-outbox.jsonl" -ErrorAction SilentlyContinue
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-901":{"tenant":"test","issue":901,"state":"implementing"}}}'
  foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 90 }   # stale past the default 45-min threshold

  # 2026-09-17 QA (fleet #78 review): this is a TEST-script-local constant matching
  # the real default (config/cycle.json is absent in this fixture) - the watchdog's
  # own $fleetDeadRepeatMinutes lives in its own process and was never in scope
  # here, so interpolating it below silently printed an empty string.
  $fleetDeadRepeatMinutes = 120
  $pushLog78 = Join-Path $testRoot 'pushover-requests-78.log'
  [IO.File]::WriteAllText($pushLog78, '')
  $pushMock78 = Start-MockPushover -LogPath $pushLog78 -Count 10
  $oldPushoverUrl78 = $env:FLEET_PUSHOVER_URL
  $env:FLEET_PUSHOVER_URL = $pushMock78.Prefix
  Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-78","user":"usr-78"}'

  try {
    # Case RP1 (red-tell): a fixture paged.json with fleet-dead first paged 121
    # minutes ago pages once more at emergency, and repeatedAt is recorded.
    $firstPagedAt121 = (Get-Date).ToUniversalTime().AddMinutes(-121).ToString('o')
    Write-Utf8 "$testRoot\state\watchdog\paged.json" ('{"fleet-dead":{"firstSeen":"' + $firstPagedAt121 + '","lastSeen":"' + $firstPagedAt121 + '","detail":"stale"}}')
    $rp1 = Run-Watchdog
    Assert-True (@($rp1.conditions) -contains 'fleet-dead') 'fleet-dead must still be the active condition'
    Assert-True ($null -ne $rp1.repeatPaged -and $rp1.repeatPaged.key -eq 'fleet-dead' -and $rp1.repeatPaged.priority -eq 'emergency') "a fleet-dead standing over $fleetDeadRepeatMinutes min must repeat-page at emergency (got $($rp1.repeatPaged | ConvertTo-Json -Compress))"
    $rpBodies = @(Get-PostedBodies $pushLog78)
    Assert-True ($rpBodies.Count -eq 1) 'exactly one repeat page must reach Pushover'
    $rpForm = ConvertFrom-FormBody $rpBodies[0]
    Assert-True ($rpForm.priority -eq '2') 'emergency must map to Pushover priority 2'
    $pagedAfterRp1 = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json
    Assert-True ($null -ne $pagedAfterRp1.'fleet-dead'.repeatedAt -and "$($pagedAfterRp1.'fleet-dead'.repeatedAt)" -ne '') 'repeatedAt must be recorded after the repeat page'

    # Case RP2: the next tick, still standing, repeats nothing (no third page).
    $rp2 = Run-Watchdog
    Assert-True ($null -eq $rp2.repeatPaged) 'a fleet-dead that already repeated must not repeat again'
    Assert-True (@(Get-PostedBodies $pushLog78).Count -eq 1) 'no third page may reach Pushover'

    # Case RP3: at 119 minutes (never yet repeated), no repeat page.
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($pushLog78, '')
    $firstPagedAt119 = (Get-Date).ToUniversalTime().AddMinutes(-119).ToString('o')
    Write-Utf8 "$testRoot\state\watchdog\paged.json" ('{"fleet-dead":{"firstSeen":"' + $firstPagedAt119 + '","lastSeen":"' + $firstPagedAt119 + '","detail":"stale"}}')
    $rp3 = Run-Watchdog
    Assert-True ($null -eq $rp3.repeatPaged) 'a fleet-dead standing under the repeat threshold must not repeat-page'
    Assert-True (@(Get-PostedBodies $pushLog78).Count -eq 0) 'no repeat page at 119 minutes'

    # Case RP4: only fleet-dead repeats - a permission-wait standing 300 minutes never does.
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\work\active.json" -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($pushLog78, '')
    foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 5 }   # heal staleness so only permission-wait remains
    [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-ic-960") | Out-Null
    Write-Utf8 "$testRoot\profile\.claude\jobs\job-ic-960\state.json" ('{"needs":"approve Read: something","updatedAt":"' + (Get-Date).ToUniversalTime().AddMinutes(-15).ToString('o') + '"}')
    $pwRow78 = '{"id":"job-ic-960","name":"ic-960","state":"working","status":"idle","pid":89,"startedAt":' + (Get-EpochMs (Get-Date).AddHours(-1)) + '}'
    Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-960","role":"ic","tenant":"test","parent":"pl-test","issue":960,"status":"active"}]}'
    Set-AgentsRows ($noSentinelRows.TrimEnd(']') + ',' + $pwRow78 + ']')
    $oldPwAt = (Get-Date).ToUniversalTime().AddMinutes(-300).ToString('o')
    Write-Utf8 "$testRoot\state\watchdog\paged.json" ('{"permission-wait:ic-960:job-ic-960":{"firstSeen":"' + $oldPwAt + '","lastSeen":"' + $oldPwAt + '","detail":"stuck"}}')
    $rp4 = Run-Watchdog
    Assert-True ($null -eq $rp4.repeatPaged) 'only fleet-dead repeats; a 300-minute permission-wait must not'
    Assert-True (@(Get-PostedBodies $pushLog78).Count -eq 0) 'an old standing permission-wait must not post a repeat'

    # Case RP5 (fleet #78 review #7, red-tell): an unparseable deliveredAt must
    # fail toward repeating NOW rather than silently losing the one repeat the
    # ADR grants.
    Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
    Set-AgentsRows $noSentinelRows
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($pushLog78, '')
    Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test-952":{"tenant":"test","issue":952,"state":"implementing"}}}'
    foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 90 }
    Write-Utf8 "$testRoot\state\watchdog\paged.json" '{"fleet-dead":{"firstSeen":"garbage","lastSeen":"garbage","detail":"stale","deliveredAt":"garbage","attempts":0,"lastAttemptAt":null,"lastError":null,"gaveUpAt":null,"url":null,"repeatedAt":null}}'
    $rp5 = Run-Watchdog
    Assert-True ($null -ne $rp5.repeatPaged -and $rp5.repeatPaged.key -eq 'fleet-dead') 'an unparseable deliveredAt must repeat now, not lose the repeat silently'

    # Case RP6: a future-dated deliveredAt (clock skew) must also repeat now.
    Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($pushLog78, '')
    $futureAt = (Get-Date).ToUniversalTime().AddHours(1).ToString('o')
    Write-Utf8 "$testRoot\state\watchdog\paged.json" ('{"fleet-dead":{"firstSeen":"' + $futureAt + '","lastSeen":"' + $futureAt + '","detail":"stale","deliveredAt":"' + $futureAt + '","attempts":0,"lastAttemptAt":null,"lastError":null,"gaveUpAt":null,"url":null,"repeatedAt":null}}')
    $rp6 = Run-Watchdog
    Assert-True ($null -ne $rp6.repeatPaged -and $rp6.repeatPaged.key -eq 'fleet-dead') 'a future-dated deliveredAt must repeat now, not lose the repeat silently'
    Remove-Item "$testRoot\state\work\active.json" -ErrorAction SilentlyContinue
  } finally {
    if ($pushMock78 -and $pushMock78.Job) { Stop-Job $pushMock78.Job -ErrorAction SilentlyContinue; Remove-Job $pushMock78.Job -Force -ErrorAction SilentlyContinue }
    if ($oldPushoverUrl78) { $env:FLEET_PUSHOVER_URL = $oldPushoverUrl78 } else { Remove-Item Env:FLEET_PUSHOVER_URL -ErrorAction SilentlyContinue }
  }
  Set-AgentsRows $noSentinelRows
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Remove-Item "$testRoot\state\pages\pushover.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\work\active.json" -ErrorAction SilentlyContinue
  foreach ($n in 'dispatcher', 'pl-test') { Set-Heartbeat $n 5 }
  $null = Run-Watchdog

  # ===== 2026-09-17 QA fact for #77: every condition kind the Watchdog can build =====
  # ===== resolves to a page priority on purpose (Get-PagePriority), never by =====
  # ===== silent fallthrough. Kinds already exercised above are asserted here by =====
  # ===== re-reading their captured results; ic-vanished, cap-exceeded, =====
  # ===== pr-lookup-failed and branch-diverged are new since nothing earlier =====
  # ===== in this suite builds them.
  Assert-True ((@($r2.newlyPaged | Where-Object { $_.key -eq 'sentinel-stale' })[0]).priority -eq 'normal') 'sentinel-stale is deliberately normal (no ADR-ruled elevation)'
  Assert-True ((@($r5.newlyPaged | Where-Object { $_.key -eq 'launch-retry:ic-901' })[0]).priority -eq 'high') 'launch-retry is ADR-ruled high'
  Assert-True ((@($r7.newlyPaged | Where-Object { $_.key -eq 'check-failed' })[0]).priority -eq 'normal') 'check-failed is deliberately normal'
  Assert-True ((@($r9.newlyPaged | Where-Object { $_.key -eq 'double-actor' })[0]).priority -eq 'normal') 'double-actor is deliberately normal'
  Assert-True ((@($r10d.newlyPaged | Where-Object { $_.key -eq 'escalation:ic-777:stray' })[0]).priority -eq 'normal') 'stray is deliberately normal'
  Assert-True ((@($r10f.newlyPaged | Where-Object { $_.key -eq 'escalation:dispatcher:blocked' })[0]).priority -eq 'normal') 'a configured blocked page is deliberately normal'
  Assert-True ((@($pg1.newlyPaged | Where-Object { $_.key -eq 'permission-wait:ic-950:job-ic-950' })[0]).priority -eq 'high') 'permission-wait is ADR-ruled high'
  Assert-True ((@($h7c.newlyPaged | Where-Object { $_.key -eq 'human-wait:pl-test' })[0]).priority -eq 'normal') 'human-wait is Cory-ruled normal (2026-09-18)'
  Assert-True ($rp1.repeatPaged.priority -eq 'emergency') 'the fleet-dead repeat is ADR-ruled emergency'

  # --- ic-vanished: an active IC on the live roster with no matching daemon row.
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-971","role":"ic","tenant":"test","parent":"pl-test","issue":971,"status":"active"}]}'
  $kpIv = Run-Watchdog
  Assert-True (@($kpIv.conditions) -contains 'escalation:ic-971:ic-vanished') 'a vanished IC must raise ic-vanished'
  $kpIvEntry = @($kpIv.newlyPaged | Where-Object { $_.key -eq 'escalation:ic-971:ic-vanished' })[0]
  Assert-True ($null -ne $kpIvEntry -and $kpIvEntry.priority -eq 'normal') 'ic-vanished is deliberately normal'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # --- cap-exceeded: lower the cap below the live fleet's current size.
  Write-Utf8 "$testRoot\roster.json" '{"cap":1,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"sentinel","role":"sentinel","parent":"dispatcher"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"}]}'
  $kpCap = Run-Watchdog
  Assert-True (@($kpCap.conditions) -contains 'escalation:fleet:cap-exceeded') 'exceeding the cap must raise cap-exceeded'
  $kpCapEntry = @($kpCap.newlyPaged | Where-Object { $_.key -eq 'escalation:fleet:cap-exceeded' })[0]
  Assert-True ($null -ne $kpCapEntry -and $kpCapEntry.priority -eq 'normal') 'cap-exceeded is deliberately normal'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"sentinel","role":"sentinel","parent":"dispatcher"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"}]}'
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # --- pr-lookup-failed: a stale-heartbeat IC (not busy, no open-PR/skip cover) whose PR lookup fails.
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-972","role":"ic","tenant":"test","parent":"pl-test","issue":972,"status":"active"}]}'
  $icRow972 = '{"id":"job-ic-972","name":"ic-972","state":"working","status":"idle","pid":90,"startedAt":' + (Get-EpochMs (Get-Date).AddHours(-4)) + '}'
  Set-AgentsRows ($noSentinelRows.TrimEnd(']') + ',' + $icRow972 + ']')
  Set-Heartbeat 'ic-972' 150
  $env:MOCK_GH_FAIL = '1'
  $kpPr = Run-Watchdog
  Remove-Item Env:MOCK_GH_FAIL
  Assert-True (@($kpPr.conditions) -contains 'escalation:ic-972:pr-lookup-failed') 'a failed PR lookup on a stale IC must raise pr-lookup-failed'
  $kpPrEntry = @($kpPr.newlyPaged | Where-Object { $_.key -eq 'escalation:ic-972:pr-lookup-failed' })[0]
  Assert-True ($null -ne $kpPrEntry -and $kpPrEntry.priority -eq 'normal') 'pr-lookup-failed is deliberately normal'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Remove-Item "$testRoot\state\heartbeats\ic-972.json" -ErrorAction SilentlyContinue
  Set-AgentsRows $noSentinelRows
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # --- branch-diverged: the release/default branch sync reports content needing a human merge.
  Write-Utf8 "$testRoot\bin\sync-integration.ps1" ('param([string]$Tenant,[switch]$Apply)' + "`r`n" + 'Write-Output (@{ escalate = $true; reason = "content on release not on default; a human merge is needed" } | ConvertTo-Json -Compress)' + "`r`n" + 'exit 0' + "`r`n")
  (Get-Content "$testRoot\tenants\test.json" -Raw | ConvertFrom-Json) | ForEach-Object { $_ | Add-Member -NotePropertyName releaseBranch -NotePropertyValue 'release' -Force; $_ | ConvertTo-Json -Compress } | Set-Content "$testRoot\tenants\test.json" -Encoding UTF8
  $kpBd = Run-Watchdog
  Assert-True (@($kpBd.conditions) -contains 'escalation:pl-test:branch-diverged') 'a diverged release branch must raise branch-diverged'
  $kpBdEntry = @($kpBd.newlyPaged | Where-Object { $_.key -eq 'escalation:pl-test:branch-diverged' })[0]
  Assert-True ($null -ne $kpBdEntry -and $kpBdEntry.priority -eq 'high') 'branch-diverged is ADR-ruled high'
  (Get-Content "$testRoot\tenants\test.json" -Raw | ConvertFrom-Json) | ForEach-Object { $_ | Add-Member -NotePropertyName releaseBranch -NotePropertyValue 'master' -Force; $_ | ConvertTo-Json -Compress } | Set-Content "$testRoot\tenants\test.json" -Encoding UTF8
  Remove-Item "$testRoot\bin\sync-integration.ps1" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # --- 2026-09-18 QA (merge seam #87/#77, red-tell): a push refused mid-apply
  # --- (kind sync-refused, pushError, no reason - #87's own shape, distinct from
  # --- branch-diverged's reason/no-pushError) must page as sync-refused with a
  # --- non-empty body, not fall through to a hardcoded 'branch-diverged' with an
  # --- empty detail (Get-OneLine $null), which Pushover would reject with a 400.
  Write-Utf8 "$testRoot\bin\sync-integration.ps1" ('param([string]$Tenant,[switch]$Apply)' + "`r`n" + 'Write-Output (@{ escalate = $true; kind = "sync-refused"; pushError = "! [remote rejected] (protected branch hook declined)" } | ConvertTo-Json -Compress)' + "`r`n" + 'exit 0' + "`r`n")
  (Get-Content "$testRoot\tenants\test.json" -Raw | ConvertFrom-Json) | ForEach-Object { $_ | Add-Member -NotePropertyName releaseBranch -NotePropertyValue 'release' -Force; $_ | ConvertTo-Json -Compress } | Set-Content "$testRoot\tenants\test.json" -Encoding UTF8
  $kpSr = Run-Watchdog
  Assert-True (@($kpSr.conditions) -contains 'escalation:pl-test:sync-refused') 'a refused push must raise sync-refused, not branch-diverged'
  $kpSrEntry = @($kpSr.newlyPaged | Where-Object { $_.key -eq 'escalation:pl-test:sync-refused' })[0]
  Assert-True ($null -ne $kpSrEntry -and $kpSrEntry.priority -eq 'high') 'sync-refused must resolve to high priority (config/cycle.json pages.priority is not dead)'
  $kpSrPaged = (Get-Content "$testRoot\state\watchdog\paged.json" -Raw) | ConvertFrom-Json
  Assert-True ("$($kpSrPaged.'escalation:pl-test:sync-refused'.detail)".Trim() -ne '' -and "$($kpSrPaged.'escalation:pl-test:sync-refused'.detail)" -match 'protected branch hook declined') 'the pushError must reach the condition detail, never an empty body'
  (Get-Content "$testRoot\tenants\test.json" -Raw | ConvertFrom-Json) | ForEach-Object { $_ | Add-Member -NotePropertyName releaseBranch -NotePropertyValue 'master' -Force; $_ | ConvertTo-Json -Compress } | Set-Content "$testRoot\tenants\test.json" -Encoding UTF8
  Remove-Item "$testRoot\bin\sync-integration.ps1" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # ===== Ticket 81 (ADR 0012): dead-man ping every tick; passed dates page once =====
  function Start-MockDeadMan {
    # A local HttpListener standing in for the off-host dead-man service,
    # answering every GET with 200 (the shape Start-MockPushover already uses
    # for POSTs in tests/page.tests.ps1, adapted to a plain GET).
    param([string]$LogPath, [int]$Count = 20)
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $prefix = "http://127.0.0.1:$port/"
    $job = Start-Job -ScriptBlock {
      param($Prefix, $LogPath, $RequestCount)
      $listener = New-Object System.Net.HttpListener
      $listener.Prefixes.Add($Prefix)
      $listener.Start()
      for ($i = 0; $i -lt $RequestCount; $i++) {
        $context = $listener.GetContext()
        Add-Content -Path $LogPath -Value $context.Request.HttpMethod
        $buffer = [Text.Encoding]::UTF8.GetBytes('ok')
        $context.Response.ContentLength64 = $buffer.Length
        $context.Response.OutputStream.Write($buffer, 0, $buffer.Length)
        $context.Response.OutputStream.Close()
      }
      $listener.Stop()
    } -ArgumentList $prefix, $LogPath, $Count
    Start-Sleep -Milliseconds 400
    return [pscustomobject]@{ Job = $job; Prefix = $prefix }
  }

  $dmLog = Join-Path $testRoot 'deadman-requests.log'
  [IO.File]::WriteAllText($dmLog, '')
  $dmMock = Start-MockDeadMan -LogPath $dmLog -Count 20
  [IO.Directory]::CreateDirectory("$testRoot\state\pages") | Out-Null
  Write-Utf8 "$testRoot\state\pages\deadman.url" $dmMock.Prefix

  try {
    # Case DM1 (red-tell): a normal tick pings the dead-man exactly once.
    $dm1 = Run-Watchdog
    Assert-True ($dm1.deadMan.configured -eq $true -and $dm1.deadMan.ok -eq $true) "a configured deadman.url must ping successfully (got $($dm1.deadMan | ConvertTo-Json -Compress))"
    Assert-True (@(Get-Content $dmLog | Where-Object { $_ }).Count -eq 1) 'exactly one GET must reach the dead-man per tick'

    # Case DM2 (red-tell): PAUSE does not suppress the ping - one more GET.
    Write-Utf8 "$testRoot\state\PAUSE" 'reason=test; setAt=now; until='
    $dm2 = Run-Watchdog
    Remove-Item "$testRoot\state\PAUSE"
    Assert-True ($dm2.deadMan.ok -eq $true) 'the ping must still succeed under PAUSE'
    Assert-True (@(Get-Content $dmLog | Where-Object { $_ }).Count -eq 2) 'PAUSE must not suppress the dead-man ping'

    # Case DM3: -Verify still pings; only fleet-state writes and toasts are skipped under -Verify.
    $dm3 = Run-Watchdog -Verify
    Assert-True ($dm3.deadMan.ok -eq $true) '-Verify must still ping the dead-man'
    Assert-True (@(Get-Content $dmLog | Where-Object { $_ }).Count -eq 3) '-Verify pings too'

    # Case DM4: an absent deadman.url is recorded, never thrown, and attempts no GET.
    Remove-Item "$testRoot\state\pages\deadman.url"
    $dm4 = Run-Watchdog
    Assert-True ($dm4.deadMan.configured -eq $false -and $null -eq $dm4.deadMan.ok) 'an absent deadman.url must be recorded, not thrown'
    Assert-True (@(Get-Content $dmLog | Where-Object { $_ }).Count -eq 3) 'no GET is attempted when unconfigured'
    Write-Utf8 "$testRoot\state\pages\deadman.url" $dmMock.Prefix
  } finally {
    if ($dmMock -and $dmMock.Job) { Stop-Job $dmMock.Job -ErrorAction SilentlyContinue; Remove-Job $dmMock.Job -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item "$testRoot\state\pages\deadman.url" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # --- dated:<where>: a passed date in config/cycle.json under a key ending in "Until".
  # Case DT1 (red-tell): a soakUntil that passed raises dated:config.ic.soakUntil once.
  Write-Utf8 "$testRoot\config\cycle.json" '{"ic":{"soakUntil":"2026-09-16T00:00:00Z"}}'
  $dt1 = Run-Watchdog
  Assert-True (@($dt1.conditions) -contains 'dated:config.ic.soakUntil') 'an expired *Until config key must raise a dated condition'
  $dt1Entry = @($dt1.newlyPaged | Where-Object { $_.key -eq 'dated:config.ic.soakUntil' })[0]
  Assert-True ($null -ne $dt1Entry -and $dt1Entry.priority -eq 'normal') 'a dated condition is normal priority'

  # Case DT2: standing, no repeat page (dated is not fleet-dead; it never repeats).
  $dt2 = Run-Watchdog
  Assert-True (@($dt2.newlyPaged).Count -eq 0) 'a standing dated condition must not page again'
  Assert-True (@($dt2.conditions) -contains 'dated:config.ic.soakUntil') 'it stays a condition while the key stands'

  # Case DT3 (red-tell): removing just the key (not the whole config file) clears
  # the condition - proving the key-removal path itself, not merely "config
  # unreadable" as a side effect of deleting the file outright.
  Write-Utf8 "$testRoot\config\cycle.json" '{"ic":{}}'
  $dt3 = Run-Watchdog
  Assert-True (-not (@($dt3.conditions) -contains 'dated:config.ic.soakUntil')) 'removing the key must clear the dated condition'
  Remove-Item "$testRoot\config\cycle.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # Case DT4: a future *Until (not yet passed) must not raise a condition.
  Write-Utf8 "$testRoot\config\cycle.json" '{"ic":{"soakUntil":"2099-01-01T00:00:00Z"}}'
  $dt4 = Run-Watchdog
  Assert-True (@(@($dt4.conditions) | Where-Object { $_ -like 'dated:*' }).Count -eq 0) 'a future *Until must not raise dated'
  Remove-Item "$testRoot\config\cycle.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # Case DT4b (2026-09-17 QA #9, red-tell): a non-date string in a *Until key
  # (`[datetime]::TryParse` accepts far more than a date - "1.5" parses as a
  # bizarre but "valid" date/time) must not raise dated.
  Write-Utf8 "$testRoot\config\cycle.json" '{"ic":{"soakUntil":"1.5"}}'
  $dt4b = Run-Watchdog
  Assert-True (@(@($dt4b.conditions) | Where-Object { $_ -like 'dated:*' }).Count -eq 0) '"1.5" must not be read as a passed date'
  Remove-Item "$testRoot\config\cycle.json"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # Case DT5: an expired [until YYYY-MM-DD] paragraph on a Notice board also raises dated,
  # and clears when the file (or the paragraph) is gone.
  [IO.Directory]::CreateDirectory("$testRoot\state\notices") | Out-Null
  Write-Utf8 "$testRoot\state\notices\all.md" 'Old policy retired. [until 2020-01-01]'
  $dt5 = Run-Watchdog
  Assert-True (@(@($dt5.conditions) | Where-Object { $_ -like 'dated:notice:all.md:*' }).Count -eq 1) 'an expired notice paragraph must raise a dated condition'
  Remove-Item "$testRoot\state\notices\all.md"
  $dt6 = Run-Watchdog
  Assert-True (@(@($dt6.conditions) | Where-Object { $_ -like 'dated:notice:*' }).Count -eq 0) 'removing the notice file must clear its dated condition'
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # Case DT6b (2026-09-17 QA #3, red-tell): editing a word inside a still-expired
  # notice paragraph must NOT read as a new condition (the old content-hash key
  # changed on any edit, so the "old" key looked cleared and a wording fix paged
  # again). Also proves two same-date paragraphs in one file get distinct keys.
  Write-Utf8 "$testRoot\state\notices\all.md" ("Old policy retired. [until 2020-01-01]" + "`n`n" + "Another old note. [until 2020-01-01]")
  $dt6b1 = Run-Watchdog
  $dt6bKeys = @(@($dt6b1.conditions) | Where-Object { $_ -like 'dated:notice:all.md:*' })
  Assert-True ($dt6bKeys.Count -eq 2) 'two same-date paragraphs in one file must raise two distinct dated conditions'
  Write-Utf8 "$testRoot\state\notices\all.md" ("Old policy retired, now with a typo fixed. [until 2020-01-01]" + "`n`n" + "Another old note. [until 2020-01-01]")
  $dt6b2 = Run-Watchdog
  Assert-True (@($dt6b2.newlyPaged).Count -eq 0) 'editing a word in a still-expired paragraph must not read as a new condition'
  $dt6bKeys2 = @(@($dt6b2.conditions) | Where-Object { $_ -like 'dated:notice:all.md:*' })
  Assert-True ((($dt6bKeys2 | Sort-Object) -join ',') -eq (($dt6bKeys | Sort-Object) -join ',')) 'the same two keys must still stand after the edit'
  Remove-Item "$testRoot\state\notices\all.md"
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  $null = Run-Watchdog

  # Case DT7: the real config/cycle.json names `dated` (ticket 81 renamed the
  # `passed-date` placeholder #76 keyed before this kind existed) at normal
  # priority, and no longer carries the dead placeholder.
  $realConfig = Get-Content "$sourceRoot\config\cycle.json" -Raw | ConvertFrom-Json
  Assert-True (@($realConfig.pages.priority.PSObject.Properties.Name) -contains 'dated') "config/cycle.json pages.priority must name 'dated'"
  Assert-True (-not (@($realConfig.pages.priority.PSObject.Properties.Name) -contains 'passed-date')) 'the passed-date placeholder must not remain now that dated: is real'
  Assert-True ("$($realConfig.pages.priority.dated)" -eq 'normal') "the real config's dated priority must be normal"

  # ===== #113 (ADR 0013): the deploy step =====
  # The fixture home is not a git checkout, so the step is `unmanaged` and spawns
  # nothing; the shadow line carries it. A refusal recorded by a tick pages on the
  # next one, once, at normal priority, and clears when the refusal ends.
  # Red-tell: before #113 the shadow line has no `deploy` and a refused deploy.json
  # raises nothing.
  $dp0 = Run-Watchdog
  Assert-True ($dp0.deploy.outcome -eq 'unmanaged') "a FleetHome that is not a checkout is unmanaged, got '$($dp0.deploy.outcome)'"
  Assert-True (-not (@($dp0.conditions) | Where-Object { $_ -like 'deploy-refused:*' })) 'unmanaged raises nothing'
  Write-Utf8 "$testRoot\state\watchdog\deploy.json" '{"at":"2026-09-24T00:00:00Z","from":"aaa","to":"bbb","outcome":"refused:not-on-live","detail":"the live checkout is on master, not live"}'
  $dp1 = Run-Watchdog
  Assert-True (@($dp1.conditions) -contains 'deploy-refused:not-on-live') 'a refused deploy raises deploy-refused:<reason>'
  $dp1Entry = @($dp1.newlyPaged | Where-Object { $_.key -eq 'deploy-refused:not-on-live' })[0]
  Assert-True ($null -ne $dp1Entry -and $dp1Entry.priority -eq 'normal') 'a deploy refusal pages at normal priority'
  $dp2 = Run-Watchdog
  Assert-True (-not (@($dp2.conditions) -contains 'deploy-refused:not-on-live')) 'the condition clears once the refusal ends'
  Write-Utf8 "$testRoot\state\watchdog\deploy.json" '{"outcome":"master-red","detail":"fleet-ci concluded failure"}'
  $dp3 = Run-Watchdog
  Assert-True (-not (@($dp3.conditions) | Where-Object { $_ -like 'deploy-*' })) 'a red master stops deploys and pages nothing'
  $dpVerify = Run-Watchdog -Verify
  Assert-True ($null -eq $dpVerify.deploy) '-Verify moves no code'
  Remove-Item "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\banner.txt" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\watchdog\deploy.json" -ErrorAction SilentlyContinue

  # ===== Ticket 85: Do-Respawn verifies the pid actually changed =====
  # The 2026-09-05 incident: ~120 consecutive "applied" respawns of a wedged
  # dispatcher were logged applied and did nothing, because Do-Respawn trusted
  # `claude respawn`'s own exit code instead of re-reading the daemon. A custom
  # -ReportPath keeps this direct check from disturbing state/sentinel/last-check.json
  # (the canonical-report marker earlier cases assert on).
  $wedgedDispRow = '{"id":"job-d-wedge","name":"dispatcher","state":"failed","pid":11,"startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-30)) + '}'
  $ticket85ReportPath = Join-Path $testRoot 'ticket85-check.json'
  Remove-Item "$testRoot\state\sentinel\applied" -Recurse -Force -ErrorAction SilentlyContinue

  # Red-tell: the mock's respawn leaves mock-agents.json unchanged (the wedge
  # persists). Today this is logged "respawned"; after the fix it is
  # "respawn-failed" and the applied ledger never claims a success that did not happen.
  Set-AgentsRows "[$wedgedDispRow]"
  $env:MOCK_RESPAWN_NOOP = '1'
  $noOp = (& "$testRoot\bin\sentinel-check.ps1" -Apply -Actor watchdog -ReportPath $ticket85ReportPath | Out-String) | ConvertFrom-Json
  Remove-Item Env:MOCK_RESPAWN_NOOP
  Assert-True (@($noOp.respawned | Where-Object { $_.name -eq 'dispatcher' }).Count -eq 0) 'a no-op respawn must not be reported as respawned'
  Assert-True (@($noOp.respawnFailed | Where-Object { $_.name -eq 'dispatcher' }).Count -eq 1) 'a no-op respawn must be classified respawn-failed'
  $ticket85LedgerFile = Get-ChildItem "$testRoot\state\sentinel\applied" -Filter *.jsonl | Select-Object -First 1
  $ticket85Ledger = @(Get-Content $ticket85LedgerFile.FullName | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-True (@($ticket85Ledger[-1].respawnFailed | Where-Object { $_.name -eq 'dispatcher' }).Count -eq 1) 'the applied ledger must record respawn-failed, never a false "respawned"'
  Assert-True (@($ticket85Ledger[-1].respawned).Count -eq 0) 'the applied ledger must not also claim the same tick respawned'

  # A genuine respawn (the mock actually replaces the pid, matching a real relaunch)
  # is still reported respawned - the fix only catches the no-op case.
  Set-AgentsRows "[$wedgedDispRow]"
  $ok = (& "$testRoot\bin\sentinel-check.ps1" -Apply -Actor watchdog -ReportPath $ticket85ReportPath | Out-String) | ConvertFrom-Json
  Assert-True (@($ok.respawned | Where-Object { $_.name -eq 'dispatcher' }).Count -eq 1) 'a respawn that actually changes the pid must still be reported respawned'
  Assert-True (@($ok.respawnFailed).Count -eq 0) 'a genuine respawn must not be classified respawn-failed'

  # This direct check's ledger/report/daemon-fixture side effects must not leak past
  # this block (state/sentinel/applied's line count is asserted on by earlier,
  # order-sensitive live-mode cases).
  Remove-Item "$testRoot\state\sentinel\applied" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ticket85ReportPath -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\mock-respawn-counter.txt" -ErrorAction SilentlyContinue
  Set-AgentsRows $noSentinelRows

  Write-Output 'watchdog tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  if ($oldRetryDelayMs) { $env:FLEET_PAGE_RETRY_DELAY_MS = $oldRetryDelayMs } else { Remove-Item Env:FLEET_PAGE_RETRY_DELAY_MS -ErrorAction SilentlyContinue }
  Remove-Item Env:MOCK_GH_FAIL -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_CLAUDE_FAIL -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_RESPAWN_NOOP -ErrorAction SilentlyContinue
  Remove-Item Env:FLEET_RESPAWN_VERIFY_MS -ErrorAction SilentlyContinue
  Remove-Item Env:FLEET_RESPAWN_VERIFY_POLL_MS -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-watchdog-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
