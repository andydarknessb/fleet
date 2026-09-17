$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Get-EpochMs { param([datetime]$D) ([DateTimeOffset][datetime]::SpecifyKind($D.ToUniversalTime(), [DateTimeKind]::Utc)).ToUnixTimeMilliseconds() }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-watchdog-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

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
  foreach ($f in '_common.ps1','sentinel-check.ps1','watchdog.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }

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
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_GH_FAIL%"=="1" (echo gh down 1>&2 & exit /b 9)' + "`r`n" + 'if "%3"=="902" (echo {"state":"CLOSED"}) else if "%2"=="view" (echo {"state":"OPEN"}) else echo []' + "`r`n" + 'exit /b 0' + "`r`n")

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"

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
  Assert-True (@($r2.newlyPaged) -contains 'sentinel-stale') 'the first sighting must page'
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
  Assert-True (@($r3d.newlyPaged) -contains 'fleet-dead') 'after quarantine the condition pages'
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
  Assert-True (@($r5.newlyPaged) -contains 'launch-retry:ic-901') 'a retry trip must page'
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
  Assert-True (@($r9.newlyPaged) -contains 'double-actor') 'double-actor must page'
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
  Assert-True (@($r10d.newlyPaged) -contains 'escalation:ic-777:stray') 'a new escalation pages'
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

  # Case 10g-strict: an unreadable daemon list under the flag must not read as "no Sentinel running".
  $env:MOCK_CLAUDE_FAIL = '1'
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_CLAUDE_FAIL%"=="1" exit /b 9' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'exit /b 0' + "`r`n")
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
  foreach ($f in 'assignment.js','work-state.js','exclusions.js','notify.js','assignment-parity.js','triage.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f", $true) }
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
  Write-Utf8 $wakeFixture '[]'
  Write-Utf8 "$testRoot\state\watch\wake-outbox.jsonl" ('{"at":"' + (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('o') + '","recordId":"test:issue-7","wake":"checks-settled"}' + "`n" + '{"at":"' + (Get-Date).ToUniversalTime().AddHours(-5).ToString('o') + '","recordId":"test:issue-8","wake":"checks-settled"}' + "`n")
  Remove-Item "$testRoot\state\watchdog\frontier-wake.json" -ErrorAction SilentlyContinue
  $w6 = Run-Watchdog
  $wake6 = @($w6.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake6.decision -eq 'woken' -and ((@($wake6.evidence) -join ' ') -match 'outbox checks-settled x1')) "an undelivered outbox wake must wake the lead, and only the one newer than the session counts (got $($wake6.decision): $(@($wake6.evidence) -join ' '))"
  $w6b = Run-Watchdog
  $wake6b = @($w6b.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0]
  Assert-True ($wake6b.decision -eq 'none') 'a consumed outbox wake must not wake again'

  # Case W7: state/flags/frontier-wake-off disables the wake entirely.
  Write-Utf8 $wakeFixture '[{"number":502,"title":"Ready","url":"https://github.com/owner/repo/issues/502","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  Remove-Item "$testRoot\state\watchdog\frontier-wake.json" -ErrorAction SilentlyContinue
  Write-Utf8 "$testRoot\state\flags\frontier-wake-off" 'x'
  $callsBefore = @(Get-RotateCalls).Count
  $w7 = Run-Watchdog
  Assert-True (@($w7.frontierWakes).Count -eq 0 -and @(Get-RotateCalls).Count -eq $callsBefore) 'the flag must disable the wake'
  Remove-Item "$testRoot\state\flags\frontier-wake-off"

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
  Remove-Item Env:FLEET_GITHUB_ISSUES_FIXTURE
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 5 }

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

  # Case T7: state/flags/triage-wake-off disables the block entirely.
  Write-Utf8 "$testRoot\state\flags\triage-wake-off" 'x'
  $t7 = Run-Watchdog
  Assert-True (@($t7.triageWakes).Count -eq 0) 'the flag must disable the triage wake'
  Remove-Item "$testRoot\state\flags\triage-wake-off"
  Remove-Item "$testRoot\state\flags\principal-live"
  Remove-Item Env:FLEET_TRIAGE_ISSUES_FIXTURE

  Write-Output 'watchdog tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_GH_FAIL -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_CLAUDE_FAIL -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-watchdog-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
