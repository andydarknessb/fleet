# fleet #252: launch.ps1's no-session path releases the reservation, writes
# <manifest>.invalidated.json and exits without a roster row. A daemon job ic-N that
# starts AFTER that runs with no roster row and no way to ack: nothing killed it, and
# the sentinel read it as a plain `stray`. The check now classifies it as an
# `orphan-late-session` (proof: this root's job, no roster row claims it by job id, its
# manifest is invalidated and was never acknowledged) and, only under -Apply AND
# state/flags/ic-cleanup-live, stops it (verified) and removes the row.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Json-Path { param([string]$Path) $Path.Replace('\', '\\') }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$base = Join-Path ([IO.Path]::GetTempPath()) ("fleet-orphan-test-" + [guid]::NewGuid().ToString('N'))
$testRoot = Join-Path $base 'live'
$foreignRoot = Join-Path $base 'scratch'
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE
$oldVerify = $env:FLEET_RESPAWN_VERIFY_MS
$oldPoll = $env:FLEET_RESPAWN_VERIFY_POLL_MS
$oldDrops = $env:MOCK_STOP_DROPS

try {
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','state/flags','state/manifests','profile/.claude/jobs','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  [IO.Directory]::CreateDirectory((Join-Path $foreignRoot 'state\sessions')) | Out-Null
  foreach ($f in '_common.ps1','sentinel-check.ps1','pause.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'

  # claude: `agents` lists agents.json, minus the pid of any job a `stop` dropped (when
  # MOCK_STOP_DROPS=1); stop/rm/respawn are logged to calls.txt.
  $mockClaude = @'
param([string]$Verb, [string]$Arg1)
$root = 'TESTROOT'
if ($Verb -eq 'agents') {
  $obj = Get-Content "$root\mock-bin\agents.json" -Raw | ConvertFrom-Json
  $rows = @($obj)
  foreach ($r in $rows) { if (Test-Path "$root\mock-bin\stopped-$($r.id).txt") { $r.pid = $null; $r.state = 'stopped' } }
  ConvertTo-Json -InputObject @($rows) -Compress
  exit 0
}
[IO.File]::AppendAllText("$root\calls.txt", "claude $Verb $Arg1`r`n")
if ($Verb -eq 'stop' -and $env:MOCK_STOP_DROPS -eq '1') { Set-Content "$root\mock-bin\stopped-$Arg1.txt" 'x' -Encoding ASCII }
exit 0
'@
  Write-Utf8 "$testRoot\mock-bin\mock-claude.ps1" ($mockClaude.Replace('TESTROOT', $testRoot))
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-claude.ps1" %1 %2' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:FLEET_RESPAWN_VERIFY_MS = '50'
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = '10'

  function Manifest-Path { param([string]$Issue) "$testRoot\state\manifests\assignment-test-$Issue.json" }
  function Write-Job { param([string]$Id, [string]$Name, $Intent, [string]$Settings = '')
    [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\$Id") | Out-Null
    $flags = @('--name', $Name, '--agent', 'ic'); if ($Settings) { $flags += @('--settings', $Settings) }
    $o = [ordered]@{ name = $Name; detail = ''; waitingFor = ''; respawnFlags = $flags }
    if ($null -ne $Intent) { $o.intent = $Intent }
    Write-Utf8 "$testRoot\profile\.claude\jobs\$Id\state.json" (ConvertTo-Json ([pscustomobject]$o) -Compress)
  }
  # The production intent is BOM-prefixed (launch.ps1:62).
  function Manifest-Intent { param([string]$Issue) ([string][char]0xFEFF) + '/mattpocock-skills:implement Read the assignment manifest at ' + (Manifest-Path $Issue) + ' and the GitHub issue body and comments.' }
  function Write-Marker { param([string]$Issue, [string]$Reason = 'no session appeared within 15s')
    Write-Utf8 ((Manifest-Path $Issue) + '.invalidated.json') (ConvertTo-Json @{ schemaVersion = 1; manifestId = "assignment-test-$Issue"; invalidatedAt = (Get-Date).ToUniversalTime().ToString('o'); reason = $Reason } -Compress)
  }
  function Write-Ack { param([string]$Issue) Write-Utf8 ((Manifest-Path $Issue) + '.acknowledged.json') '{"schemaVersion":1}' }
  function Set-Agents { param($Rows) Write-Utf8 "$testRoot\mock-bin\agents.json" (ConvertTo-Json -InputObject @($Rows | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.name; state = 'working'; status = 'idle'; pid = $_.pid; startedAt = $(if ($_.startedAt) { $_.startedAt } else { '2026-09-30T03:44:00Z' }) } }) -Compress) }
  function Reset-Fixture {
    Get-ChildItem "$testRoot\state\manifests" -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem "$testRoot\state\flags" -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem "$testRoot\mock-bin" -Filter 'stopped-*.txt' -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem "$testRoot\profile\.claude\jobs" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Remove-Item "$testRoot\calls.txt" -Force -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\sentinel\applied" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
    $env:MOCK_STOP_DROPS = '0'
  }
  function Run-Check { param([switch]$Apply)
    $out = if ($Apply) { & "$testRoot\bin\sentinel-check.ps1" -Apply -ReportPath "$testRoot\state\sentinel\last-check.json" | Out-String } else { & "$testRoot\bin\sentinel-check.ps1" -ReportPath "$testRoot\state\sentinel\last-check.json" | Out-String }
    $out | ConvertFrom-Json
  }
  function Kinds-For { param($Report, [string]$Name) @($Report.escalate | Where-Object { $_.name -eq $Name } | ForEach-Object { $_.kind }) }
  function Calls { if (Test-Path "$testRoot\calls.txt") { @(Get-Content "$testRoot\calls.txt") } else { @() } }

  # ---- O1 red-tell: a late IC whose manifest was invalidated is an orphan-late-session, not a stray.
  Reset-Fixture
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001')
  Write-Marker '1001'
  Set-Agents @(@{ id = 'job-1001'; name = 'ic-1001'; pid = 1001 })
  $o1 = Run-Check
  $k = Kinds-For $o1 'ic-1001'
  Assert-True (($k -contains 'orphan-late-session') -and ($k.Count -eq 1)) "O1: exactly one escalate for ic-1001, kind orphan-late-session (got: $($k -join ','))"
  Assert-True ($k -notcontains 'stray') 'O1: an orphan late session must not also read as a stray'
  Assert-True ((Calls).Count -eq 0) 'O1: a read-only run touches no process'
  Write-Output 'sentinel-orphan-late-session O1 passed'

  # ---- O2: -Apply without state/flags/ic-cleanup-live is shadow: paged as an orphan, no process touched.
  Reset-Fixture
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001')
  Write-Marker '1001'
  Set-Agents @(@{ id = 'job-1001'; name = 'ic-1001'; pid = 1001 })
  $o2 = Run-Check -Apply
  $e2 = @($o2.escalate | Where-Object { $_.name -eq 'ic-1001' -and $_.kind -eq 'orphan-late-session' })
  Assert-True ($e2.Count -eq 1) 'O2: -Apply without the flag still raises the orphan-late-session page'
  Assert-True ("$($e2[0].detail)" -like '*would stop*') "O2: the detail says it would stop (got: $($e2[0].detail))"
  Assert-True ("$($e2[0].detail)" -like '*ic-cleanup-live*') 'O2: the detail names the flag'
  Assert-True (@($o2.stopped).Count -eq 0) 'O2: nothing is recorded as stopped'
  Assert-True ((Calls).Count -eq 0) "O2: no claude stop/rm without the flag (calls: $((Calls) -join '; '))"
  Write-Output 'sentinel-orphan-late-session O2 passed'

  # ---- O3: -Apply with the flag stops the job (verified by the pid dropping), removes the row, and records it.
  Reset-Fixture
  Write-Utf8 "$testRoot\state\flags\ic-cleanup-live" 'test'
  $env:MOCK_STOP_DROPS = '1'
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001')
  Write-Marker '1001' 'no session appeared within 15s'
  Write-Utf8 (Manifest-Path '1001') '{"id":"assignment-test-1001","parent":"pl-test"}'
  Set-Agents @(@{ id = 'job-1001'; name = 'ic-1001'; pid = 1001 })
  $o3 = Run-Check -Apply
  $calls3 = Calls
  Assert-True ($calls3 -contains 'claude stop job-1001') "O3: claude stop job-1001 was called (calls: $($calls3 -join '; '))"
  Assert-True ($calls3 -contains 'claude rm job-1001') 'O3: the verified stop is followed by claude rm'
  Assert-True (@($o3.stopped).Count -eq 1 -and $o3.stopped[0].jobId -eq 'job-1001' -and $o3.stopped[0].name -eq 'ic-1001' -and $o3.stopped[0].verified -eq $true) 'O3: report.stopped names the job'
  Assert-True (@($o3.stopFailed).Count -eq 0) 'O3: nothing failed'
  $e3 = @($o3.escalate | Where-Object { $_.name -eq 'ic-1001' -and $_.kind -eq 'orphan-late-session' })
  Assert-True ($e3.Count -eq 1 -and "$($e3[0].detail)" -like '*stopped') 'O3: the page still fires and says stopped'
  Assert-True ($e3[0].parent -eq 'pl-test') 'O3: the page names the manifest parent'
  Assert-True ("$($e3[0].detail)" -like '*no session appeared within 15s*') 'O3: the page carries the marker reason'
  $ledger3 = @(Get-ChildItem "$testRoot\state\sentinel\applied" -Filter *.jsonl | ForEach-Object { Get-Content $_.FullName })
  Assert-True ($ledger3.Count -ge 1 -and (($ledger3[-1] | ConvertFrom-Json).stopped[0].jobId -eq 'job-1001')) 'O3: stopped reaches the applied ledger line'
  Write-Output 'sentinel-orphan-late-session O3 passed'

  # ---- O4: false positives. With -Apply and the flag standing, none of these is an orphan and nothing is stopped.
  function Assert-NoOrphan { param($Report, [string]$Label)
    $bad = @($Report.escalate | Where-Object { $_.kind -eq 'orphan-late-session' })
    Assert-True ($bad.Count -eq 0) "$Label must not be an orphan-late-session"
    Assert-True (@($Report.stopped).Count -eq 0 -and @($Report.stopFailed).Count -eq 0) "$Label must record no stop"
    Assert-True (@(Calls | Where-Object { $_ -like 'claude stop*' -or $_ -like 'claude rm*' }).Count -eq 0) "$Label must call no claude stop/rm (calls: $((Calls) -join '; '))"
  }
  function Start-FalsePositive {
    Reset-Fixture
    Write-Utf8 "$testRoot\state\flags\ic-cleanup-live" 'test'
    $env:MOCK_STOP_DROPS = '1'
    Set-Agents @(@{ id = 'job-1001'; name = 'ic-1001'; pid = 1001 })
  }
  $rosterRow1001 = '{"sessions":[{"name":"ic-1001","role":"ic","tenant":"test","parent":"pl-test","issue":1001,"status":"active","jobId":"job-1001"}]}'
  # (a) a roster row claims the job by id
  Start-FalsePositive
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001'); Write-Marker '1001'
  Write-Utf8 "$testRoot\state\roster.json" $rosterRow1001
  Assert-NoOrphan (Run-Check -Apply) 'O4a (roster row active with this jobId)'
  # (a2) a retiring row still claims it
  Start-FalsePositive
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001'); Write-Marker '1001'
  Write-Utf8 "$testRoot\state\roster.json" $rosterRow1001.Replace('"active"', '"retiring"')
  Assert-NoOrphan (Run-Check -Apply) 'O4a2 (roster row retiring with this jobId)'
  # (b) marker absent: a plain stray
  Start-FalsePositive
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001')
  $o4b = Run-Check -Apply
  Assert-NoOrphan $o4b 'O4b (no marker)'
  Assert-True ((Kinds-For $o4b 'ic-1001') -contains 'stray') 'O4b: with no marker it stays a stray'
  # (c) acknowledged AND invalidated
  Start-FalsePositive
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001'); Write-Marker '1001'; Write-Ack '1001'
  $o4c = Run-Check -Apply
  Assert-NoOrphan $o4c 'O4c (acknowledged)'
  Assert-True ((Kinds-For $o4c 'ic-1001') -contains 'stray') 'O4c: an acknowledged manifest stays a stray'
  # (d) another root's roster holds the job
  Start-FalsePositive
  $foreignSettings = "$foreignRoot\state\sessions\ic-1001.settings.json"
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001') $foreignSettings; Write-Marker '1001'
  Write-Utf8 "$foreignRoot\state\roster.json" ('{"sessions":[{"name":"ic-1001","role":"ic","tenant":"test","parent":"cory","issue":1001,"status":"active","jobId":"job-1001","settings":"' + (Json-Path $foreignSettings) + '"}]}')
  $o4d = Run-Check -Apply
  Assert-NoOrphan $o4d 'O4d (another root rosters the job)'
  Assert-True (@($o4d.ok | Where-Object { $_.name -eq 'ic-1001' -and "$($_.detail)" -like "*$foreignRoot*" }).Count -eq 1) 'O4d: reported under ok as the other root session'
  Remove-Item "$foreignRoot\state\roster.json" -Force
  # (e) intent with no manifest phrase
  Start-FalsePositive
  Write-Job 'job-1001' 'ic-1001' 'Fix the flaky test in the parser'; Write-Marker '1001'
  $o4e = Run-Check -Apply
  Assert-NoOrphan $o4e 'O4e (intent names no manifest)'
  Assert-True ((Kinds-For $o4e 'ic-1001') -contains 'stray') 'O4e: falls through to stray'
  # (e2) no job state at all
  Start-FalsePositive
  Write-Marker '1001'
  $o4e2 = Run-Check -Apply
  Assert-NoOrphan $o4e2 'O4e2 (no job state)'
  Assert-True ((Kinds-For $o4e2 'ic-1001') -contains 'stray') 'O4e2: falls through to stray'
  # (f) unparseable roster: nothing classified, nothing stopped
  Start-FalsePositive
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001'); Write-Marker '1001'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions": [ {oops'
  # Get-LiveRoster (unchanged) reports the parse failure on the error stream and carries on with an
  # empty roster, which is how the watchdog's child sees it. This suite runs under Stop, which would
  # turn that noise into a throw, so this one run is a child process with its own default preference.
  $out4f = & cmd /c ('powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\bin\sentinel-check.ps1" -Apply -ReportPath "' + $testRoot + '\state\sentinel\last-check.json" 2>nul') | Out-String
  $o4f = $out4f | ConvertFrom-Json
  Assert-NoOrphan $o4f 'O4f (roster unparseable)'
  $ok4f = @($o4f.ok | Where-Object { $_.name -eq 'roster-read' })
  Assert-True ($ok4f.Count -eq 1 -and "$($ok4f[0].detail)" -like '*unreadable*') "O4f: one roster-read ok entry (ok: $(($o4f.ok | ConvertTo-Json -Compress)))"
  Write-Output 'sentinel-orphan-late-session O4 passed'

  # ---- O5: a duplicate name does not vouch for the orphan. ic-1001 is on the roster as job-A; job-B is not.
  Reset-Fixture
  Write-Utf8 "$testRoot\state\flags\ic-cleanup-live" 'test'
  $env:MOCK_STOP_DROPS = '1'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-1001","role":"ic","tenant":"test","parent":"pl-test","issue":1001,"status":"active","jobId":"job-A"}]}'
  Write-Job 'job-A' 'ic-1001' (Manifest-Intent '1001')
  Write-Job 'job-B' 'ic-1001' (Manifest-Intent '1002')
  Write-Marker '1002'
  Set-Agents @(@{ id = 'job-A'; name = 'ic-1001'; pid = 11; startedAt = '2026-09-30T04:00:00Z' }, @{ id = 'job-B'; name = 'ic-1001'; pid = 22; startedAt = '2026-09-30T03:00:00Z' })
  $o5 = Run-Check -Apply
  $e5 = @($o5.escalate | Where-Object { $_.kind -eq 'orphan-late-session' })
  Assert-True ($e5.Count -eq 1 -and "$($e5[0].detail)" -like '*job-B*') "O5: only job-B is an orphan (escalate: $(($o5.escalate | ConvertTo-Json -Compress)))"
  $calls5 = Calls
  Assert-True (($calls5 -contains 'claude stop job-B') -and ($calls5 -notcontains 'claude stop job-A')) "O5: job-B is stopped, job-A is not (calls: $($calls5 -join '; '))"
  Assert-True (@($o5.stopped).Count -eq 1 -and $o5.stopped[0].jobId -eq 'job-B') 'O5: report.stopped names job-B only'
  Write-Output 'sentinel-orphan-late-session O5 passed'

  # ---- O6: the stop never drops the pid: stopFailed names the job, the page says so, no claude rm.
  Reset-Fixture
  Write-Utf8 "$testRoot\state\flags\ic-cleanup-live" 'test'
  $env:MOCK_STOP_DROPS = '0'
  Write-Job 'job-1001' 'ic-1001' (Manifest-Intent '1001'); Write-Marker '1001'
  Set-Agents @(@{ id = 'job-1001'; name = 'ic-1001'; pid = 1001 })
  $o6 = Run-Check -Apply
  Assert-True (@($o6.stopFailed).Count -eq 1 -and $o6.stopFailed[0].jobId -eq 'job-1001') "O6: stopFailed names job-1001 (got: $(($o6.stopFailed | ConvertTo-Json -Compress)))"
  Assert-True (@($o6.stopped).Count -eq 0) 'O6: nothing is recorded as stopped'
  $e6 = @($o6.escalate | Where-Object { $_.name -eq 'ic-1001' -and $_.kind -eq 'orphan-late-session' })
  Assert-True ($e6.Count -eq 1 -and "$($e6[0].detail)" -like '*stop failed*') 'O6: the page says the stop failed'
  $calls6 = Calls
  Assert-True (($calls6 -contains 'claude stop job-1001') -and ($calls6 -notcontains 'claude rm job-1001')) "O6: stop attempted, row not removed (calls: $($calls6 -join '; '))"
  Write-Output 'sentinel-orphan-late-session O6 passed'

  Write-Output 'sentinel-orphan-late-session tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $env:FLEET_RESPAWN_VERIFY_MS = $oldVerify
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = $oldPoll
  $env:MOCK_STOP_DROPS = $oldDrops
  Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}
