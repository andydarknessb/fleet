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
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','state/watchdog','state/escalations','profile/.claude/jobs/job-ic-901-2','repo','mock-bin') {
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

  Write-Output 'watchdog tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_GH_FAIL -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-watchdog-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
