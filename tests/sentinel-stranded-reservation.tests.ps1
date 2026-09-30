# fleet #256 AC2: a launch refused before its session leaves an `assigned` reservation nothing sees
# (live 2026-09-30: nidus:issue-7, assigned rev 1 since 09-29, no ic-7 roster row, no job, no marker).
# sentinel-check now reports it as `reservation-stranded` (every mode) when the record has been assigned
# longer than watchdog.strandedReservationHours (default 6) and ALL of: no active|retiring roster row for its
# tenant+issue, no job (daemon row or job state) whose intent names its manifest, no .invalidated.json and no
# .acknowledged.json beside the manifest. Under -Apply AND state/flags/ic-cleanup-live it releases the
# reservation (Invoke-ManifestRelease) and records strandedReleased. PAUSE defers; an unreadable active.json
# or roster classifies nothing. Real work-state.js; only `claude` and `gh` are mocked.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-stranded-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE
$oldVerify = $env:FLEET_RESPAWN_VERIFY_MS
$oldPoll = $env:FLEET_RESPAWN_VERIFY_POLL_MS

try {
  foreach ($dir in 'bin','config','tenants','state','state/heartbeats','state/sentinel','state/skip','state/flags','state/manifests','profile/.claude/jobs','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','sentinel-check.ps1','pause.ps1','retire.ps1','work-state.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'

  $mockClaude = @'
param([string]$Verb, [string]$Arg1)
$root = 'TESTROOT'
if ($Verb -eq 'agents') {
  $n = 0; if (Test-Path "$root\mock-bin\agents-count.txt") { $n = [int](Get-Content "$root\mock-bin\agents-count.txt" -Raw) }
  $n++; Set-Content "$root\mock-bin\agents-count.txt" $n -Encoding ASCII
  if ($n -ge 2 -and (Test-Path "$root\mock-bin\late-job-intent.txt")) {
    New-Item -ItemType Directory -Force "$root\profile\.claude\jobs\job-late" | Out-Null
    $late = @{ name = 'ic-late'; state = 'working'; intent = (Get-Content "$root\mock-bin\late-job-intent.txt" -Raw) } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText("$root\profile\.claude\jobs\job-late\state.json", $late)
  }
  $rows = @((Get-Content "$root\mock-bin\agents.json" -Raw | ConvertFrom-Json) | Where-Object { $_ })
  if ($rows.Count -eq 0) { Write-Output '[]' } else { Write-Output (ConvertTo-Json -InputObject $rows -Compress) }
  exit 0
}
[IO.File]::AppendAllText("$root\calls.txt", "claude $Verb $Arg1`r`n")
exit 0
'@
  Write-Utf8 "$testRoot\mock-bin\mock-claude.ps1" ($mockClaude.Replace('TESTROOT', $testRoot))
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-claude.ps1" %1 %2' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:FLEET_RESPAWN_VERIFY_MS = '50'
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = '10'

  function Iso-Ago { param([double]$Minutes) (Get-Date).ToUniversalTime().AddMinutes(-$Minutes).ToString('o') }
  function Manifest-Path { param([string]$Tenant, [int]$N) "$testRoot\state\manifests\assignment-$Tenant-issue-$N-e3ee808918ff.json" }
  function Set-Agents { param($Rows) Write-Utf8 "$testRoot\mock-bin\agents.json" (ConvertTo-Json -InputObject @($Rows | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.name; state = 'working'; status = 'idle'; pid = $_.pid; startedAt = '2026-09-30T03:44:00Z' } }) -Compress) }
  function Reset-Fixture {
    foreach ($d in 'state\manifests', 'state\flags', 'state\heartbeats') { Get-ChildItem "$testRoot\$d" -ErrorAction SilentlyContinue | Remove-Item -Force }
    Get-ChildItem "$testRoot\profile\.claude\jobs" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    foreach ($p in "$testRoot\calls.txt", "$testRoot\state\PAUSE", "$testRoot\config\cycle.json", "$testRoot\state\sentinel\stranded-seen.json", "$testRoot\mock-bin\agents-count.txt", "$testRoot\mock-bin\late-job-intent.txt") { Remove-Item $p -Force -ErrorAction SilentlyContinue }
    foreach ($p in "$testRoot\state\sentinel\applied", "$testRoot\state\work", "$testRoot\state\escalations", "$testRoot\state\releases", "$testRoot\state\events", "$testRoot\state\archive", "$testRoot\state\abandons") { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
    Set-Agents @()
  }
  # The live nidus:issue-7 shape: assigned, rev 1, pending-ack manifest, reserved $HoursAgo ago.
  function New-Stranded { param([string]$Tenant = 'nidus', [int]$N = 7, [double]$HoursAgo = 7)
    Reset-Fixture
    $mp = Manifest-Path $Tenant $N
    $manifest = [ordered]@{ schemaVersion = 1; status = 'pending-ack'; id = "assignment-$Tenant-issue-$N-e3ee808918ff"; workRecordId = "${Tenant}:issue-$N"; workRecordRevision = 1; tenant = $Tenant; parent = "pl-$Tenant" }
    Write-Utf8 $mp ($manifest | ConvertTo-Json -Depth 6)
    $when = (Get-Date).ToUniversalTime().AddHours(-$HoursAgo).ToString('o')
    $assignment = (@{ manifestId = "assignment-$Tenant-issue-$N-e3ee808918ff" } | ConvertTo-Json -Compress).Replace('"', '\"')
    $null = & node "$testRoot\bin\work-state.js" reserve --root $testRoot --id "${Tenant}:issue-$N" --tenant $Tenant --issue $N --manifest $mp --assignment $assignment --idempotency-key "reserve-$Tenant-$N" --now $when
    if ($LASTEXITCODE -ne 0) { throw "fixture reservation for ${Tenant}:issue-$N failed" }
  }
  function Get-ActiveRecords { (Get-Content "$testRoot\state\work\active.json" -Raw | ConvertFrom-Json).records }
  function Is-Reserved { param([string]$Id) $null -ne (Get-ActiveRecords).PSObject.Properties[$Id] }
  function Run-Check { param([switch]$Apply)
    # The check runs without Stop semantics in production (an unparseable file reports on the error stream).
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $out = if ($Apply) { & "$testRoot\bin\sentinel-check.ps1" -Apply -ReportPath "$testRoot\state\sentinel\last-check.json" 2>$null | Out-String } else { & "$testRoot\bin\sentinel-check.ps1" -ReportPath "$testRoot\state\sentinel\last-check.json" 2>$null | Out-String }
    } finally { $ErrorActionPreference = $eap }
    $out | ConvertFrom-Json
  }
  # A release needs the record stranded on the PREVIOUS tick too: run the arming tick (asserting it released nothing and
  # says so) and return the second tick's report.
  # Move the remembered first/last sighting back in time (the tick cadence is 15 min; a test cannot wait).
  function Age-Seen { param([double]$Minutes = 15)
    $seen = Get-Content "$testRoot\state\sentinel\stranded-seen.json" -Raw | ConvertFrom-Json
    foreach ($prop in $seen.PSObject.Properties) {
      $prop.Value.firstSeen = (Get-Date).ToUniversalTime().AddMinutes(-$Minutes).ToString('o')
      $prop.Value.lastSeen = (Get-Date).ToUniversalTime().AddMinutes(-$Minutes).ToString('o')
    }
    Write-Utf8 "$testRoot\state\sentinel\stranded-seen.json" ($seen | ConvertTo-Json -Depth 4)
  }
  function Run-Armed { param([string]$Id = 'nidus:issue-7')
    $first = Run-Check -Apply
    Assert-True (@($first.strandedReleased).Count -eq 0 -and (Is-Reserved $Id)) 'the arming tick must not release'
    Age-Seen 15
    Run-Check -Apply
  }
  function Stranded-For { param($Report, [string]$Id) ,@($Report.escalate | Where-Object { $_.name -eq $Id -and $_.kind -eq 'reservation-stranded' }) }
  function Calls { if (Test-Path "$testRoot\calls.txt") { @(Get-Content "$testRoot\calls.txt") } else { @() } }
  function Set-Flag { Write-Utf8 "$testRoot\state\flags\ic-cleanup-live" 'test' }
  function Assert-Untouched { param($Report, [string]$Id, [string]$Tenant, [int]$N, [string]$Label)
    Assert-True ((Stranded-For $Report $Id).Count -eq 0) "$Label`: must not be reported reservation-stranded"
    Assert-True (@($Report.strandedReleased).Count -eq 0) "$Label`: nothing released"
    Assert-True (Is-Reserved $Id) "$Label`: the record stays reserved"
    Assert-True (-not (Test-Path ((Manifest-Path $Tenant $N) + '.invalidated.json'))) "$Label`: no marker written"
  }

  # ---- S1 red-tell: the live nidus:issue-7 shape (assigned rev 1, pending-ack, reserved 7h ago, no roster row, no job,
  # no markers). Read-only: escalate reservation-stranded and touch nothing. With -Apply and the flag: released + marker.
  New-Stranded
  $s1 = Run-Check
  $e1 = Stranded-For $s1 'nidus:issue-7'
  Assert-True ($e1.Count -eq 1) "S1: exactly one reservation-stranded escalate for nidus:issue-7 (escalate: $(($s1.escalate | ConvertTo-Json -Compress)))"
  Assert-True ($e1[0].parent -eq 'pl-nidus') 'S1: the page names the manifest parent'
  Assert-True ("$($e1[0].detail)" -like '*nidus:issue-7*' -and "$($e1[0].detail)" -like '*would release*') "S1: the detail names the record and what it would do (got: $($e1[0].detail))"
  Assert-True ((Is-Reserved 'nidus:issue-7') -and (Calls).Count -eq 0) 'S1: a read-only run touches nothing'
  Assert-True ("$($e1[0].detail)" -like '*reserved 7 h with no session*' -and "$($e1[0].detail)" -like '*a lead may be holding it behind the cap*') "S1: the page reads as information (got: $($e1[0].detail))"
  New-Stranded
  Set-Flag
  $s1a = Run-Check -Apply
  $e1a = Stranded-For $s1a 'nidus:issue-7'
  Assert-True ($e1a.Count -eq 1 -and "$($e1a[0].detail)" -like '*first sighting*' -and @($s1a.strandedReleased).Count -eq 0 -and (Is-Reserved 'nidus:issue-7')) 'S1: the first sighting pages and releases nothing'
  Assert-True (Test-Path "$testRoot\state\sentinel\stranded-seen.json") 'S1: the first sighting is remembered'
  Age-Seen 15
  $s1b = Run-Check -Apply
  Assert-True (-not (Is-Reserved 'nidus:issue-7')) 'S1: with -Apply and the flag the reservation is released'
  $mk = (Manifest-Path 'nidus' 7) + '.invalidated.json'
  Assert-True (Test-Path $mk) 'S1: the invalidation marker is written'
  $marker = Get-Content $mk -Raw | ConvertFrom-Json
  Assert-True ($marker.manifestId -eq 'assignment-nidus-issue-7-e3ee808918ff' -and $marker.schemaVersion -eq 1 -and "$($marker.reason)" -like 'stranded reservation*') 'S1: the marker has the launch.ps1 shape and a stranded reason'
  Assert-True (@($s1b.strandedReleased).Count -eq 1 -and $s1b.strandedReleased[0].recordId -eq 'nidus:issue-7' -and $s1b.strandedReleased[0].release.ok -eq $true) 'S1: report.strandedReleased names the record'
  Assert-True (@($s1b.strandedReleaseFailed).Count -eq 0) 'S1: nothing failed'
  $e1b = Stranded-For $s1b 'nidus:issue-7'
  Assert-True ($e1b.Count -eq 1 -and "$($e1b[0].detail)" -like '*released*') 'S1: the page still fires in every mode and says released'
  $ledger = @(Get-ChildItem "$testRoot\state\sentinel\applied" -Filter *.jsonl | ForEach-Object { Get-Content $_.FullName })
  Assert-True ($ledger.Count -ge 1 -and (($ledger[-1] | ConvertFrom-Json).strandedReleased[0].recordId -eq 'nidus:issue-7')) 'S1: strandedReleased reaches the applied ledger line'
  # idempotent: the next tick sees no record and pages nothing
  $s1c = Run-Check -Apply
  Assert-True ((Stranded-For $s1c 'nidus:issue-7').Count -eq 0 -and @($s1c.strandedReleased).Count -eq 0) 'S1: once released the next tick reports nothing'
  Write-Output 'sentinel-stranded-reservation S1 passed'

  # ---- S2: under the age, nothing (5h < 6h); the configured watchdog.strandedReservationHours moves it.
  New-Stranded -HoursAgo 5
  Set-Flag
  Assert-Untouched (Run-Check -Apply) 'nidus:issue-7' 'nidus' 7 'S2 (5h)'
  Assert-Untouched (Run-Check -Apply) 'nidus:issue-7' 'nidus' 7 'S2 (5h, second tick)'
  Write-Utf8 "$testRoot\config\cycle.json" '{"watchdog":{"strandedReservationHours":4}}'
  $s2b = Run-Armed
  Assert-True ((Stranded-For $s2b 'nidus:issue-7').Count -eq 1 -and -not (Is-Reserved 'nidus:issue-7')) 'S2: a 4h configured limit catches a 5h old reservation'
  Write-Output 'sentinel-stranded-reservation S2 passed'

  # ---- S3: a roster row for the same tenant+issue (active or retiring) means a session owns it: nothing.
  foreach ($status in 'active', 'retiring') {
    New-Stranded
    Set-Flag
    Write-Utf8 "$testRoot\state\roster.json" (@{ sessions = @([pscustomobject]@{ name = 'ic-7'; role = 'ic'; tenant = 'nidus'; issue = 7; status = $status; jobId = 'job-7' }) } | ConvertTo-Json -Depth 5)
    Assert-Untouched (Run-Check -Apply) 'nidus:issue-7' 'nidus' 7 "S3 ($status row)"
  }
  # the same issue number under another tenant does not vouch for it, and a retired row is not a session.
  New-Stranded
  Set-Flag
  Write-Utf8 "$testRoot\state\roster.json" (@{ sessions = @([pscustomobject]@{ name = 'ic-7'; role = 'ic'; tenant = 'endzone'; issue = 7; status = 'active'; jobId = 'job-x' }, [pscustomobject]@{ name = 'ic-7'; role = 'ic'; tenant = 'nidus'; issue = 7; status = 'retired'; jobId = 'job-y' }) } | ConvertTo-Json -Depth 5)
  $s3c = Run-Armed
  Assert-True ((Stranded-For $s3c 'nidus:issue-7').Count -eq 1 -and -not (Is-Reserved 'nidus:issue-7')) 'S3: another tenant row and a retired row do not protect the reservation'
  Write-Output 'sentinel-stranded-reservation S3 passed'

  # ---- S4: a job whose intent names the manifest (a daemon row, or only its job state) means a launch is in flight.
  New-Stranded
  Set-Flag
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-7a") | Out-Null
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-7a\state.json" (ConvertTo-Json @{ name = 'ic-7'; state = 'working'; intent = (([string][char]0xFEFF) + 'Read the assignment manifest at ' + (Manifest-Path 'nidus' 7) + ' and the GitHub issue body.') } -Compress)
  Assert-Untouched (Run-Check -Apply) 'nidus:issue-7' 'nidus' 7 'S4 (job state only)'
  Set-Agents @(@{ id = 'job-7a'; name = 'ic-7'; pid = 77 })
  Assert-Untouched (Run-Check -Apply) 'nidus:issue-7' 'nidus' 7 'S4 (daemon row)'
  # an unrelated job does not protect it
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-7a\state.json" (ConvertTo-Json @{ name = 'ic-9'; state = 'working'; intent = 'Read the assignment manifest at C:\elsewhere\assignment-nidus-issue-9-aaaaaaaaaaaa.json and go.' } -Compress)
  Set-Agents @()
  $s4c = Run-Armed
  Assert-True ((Stranded-For $s4c 'nidus:issue-7').Count -eq 1 -and -not (Is-Reserved 'nidus:issue-7')) 'S4: an unrelated job intent does not protect the reservation'
  Write-Output 'sentinel-stranded-reservation S4 passed'

  # ---- S5: a marker beside the manifest (invalidated, or acknowledged) means it is settled or in use: nothing.
  foreach ($suffix in '.invalidated.json', '.acknowledged.json') {
    New-Stranded
    Set-Flag
    Write-Utf8 ((Manifest-Path 'nidus' 7) + $suffix) '{"schemaVersion":1}'
    $s5 = Run-Check -Apply
    Assert-True ((Stranded-For $s5 'nidus:issue-7').Count -eq 0 -and @($s5.strandedReleased).Count -eq 0 -and (Is-Reserved 'nidus:issue-7')) "S5 ($suffix): nothing"
  }
  Write-Output 'sentinel-stranded-reservation S5 passed'

  # ---- S6 shadow: -Apply without the flag pages "would release" and touches nothing.
  New-Stranded
  $s6 = Run-Check -Apply
  $e6 = Stranded-For $s6 'nidus:issue-7'
  Assert-True ($e6.Count -eq 1 -and "$($e6[0].detail)" -like '*would release*' -and "$($e6[0].detail)" -like '*ic-cleanup-live absent*') "S6: pages would release (got: $($e6 | ConvertTo-Json -Compress))"
  Assert-True ((Is-Reserved 'nidus:issue-7') -and @($s6.strandedReleased).Count -eq 0 -and -not (Test-Path ((Manifest-Path 'nidus' 7) + '.invalidated.json'))) 'S6: nothing released'
  Write-Output 'sentinel-stranded-reservation S6 passed'

  # ---- S7: PAUSE defers the release; the page still fires and says so.
  New-Stranded
  Set-Flag
  Write-Utf8 "$testRoot\state\PAUSE" 'reason=manual'
  $s7 = Run-Check -Apply
  $e7 = Stranded-For $s7 'nidus:issue-7'
  Assert-True ($e7.Count -eq 1 -and "$($e7[0].detail)" -like '*deferred*' -and (Is-Reserved 'nidus:issue-7') -and @($s7.strandedReleased).Count -eq 0) 'S7: PAUSE defers the release'
  Write-Output 'sentinel-stranded-reservation S7 passed'

  # ---- S8: an unreadable active.json or roster classifies nothing.
  New-Stranded
  Set-Flag
  $activeJson = Get-Content "$testRoot\state\work\active.json" -Raw
  Write-Utf8 "$testRoot\state\work\active.json" '{"records": {oops'
  $s8 = Run-Check -Apply
  Assert-True ((Stranded-For $s8 'nidus:issue-7').Count -eq 0 -and @($s8.strandedReleased).Count -eq 0) 'S8: an unreadable active.json classifies nothing'
  Assert-True (@($s8.ok | Where-Object { $_.name -eq 'work-state-read' -and "$($_.detail)" -like '*unreadable*' }).Count -eq 1) 'S8: one work-state-read ok entry says so'
  Write-Utf8 "$testRoot\state\work\active.json" $activeJson
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions": [ {oops'
  # Get-LiveRoster (unchanged) reports the parse failure on the error stream; this one run is a child process
  # with its own default preference, the way the watchdog runs the check.
  $out8b = & cmd /c ('powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\bin\sentinel-check.ps1" -Apply -ReportPath "' + $testRoot + '\state\sentinel\last-check.json" 2>nul') | Out-String
  $s8b = $out8b | ConvertFrom-Json
  Assert-True ((Stranded-For $s8b 'nidus:issue-7').Count -eq 0 -and @($s8b.strandedReleased).Count -eq 0 -and (Is-Reserved 'nidus:issue-7')) 'S8: an unreadable roster classifies nothing'
  Write-Output 'sentinel-stranded-reservation S8 passed'

  # ---- S9: a release the ledger refuses (record already implementing, so not a stranded reservation by state) and
  # a record with no manifest are not candidates; a failing release is recorded, not hidden.
  New-Stranded
  Set-Flag
  Remove-Item ((Manifest-Path 'nidus' 7)) -Force
  $s9 = Run-Armed
  Assert-True ((Stranded-For $s9 'nidus:issue-7').Count -eq 1 -and @($s9.strandedReleaseFailed).Count -eq 1 -and $s9.strandedReleaseFailed[0].release.code -eq 'MANIFEST_UNREADABLE' -and (Is-Reserved 'nidus:issue-7')) "S9: a missing manifest cannot be released; the failure is recorded (got: $(($s9.strandedReleaseFailed | ConvertTo-Json -Compress -Depth 4)))"
  Assert-True ("$((Stranded-For $s9 'nidus:issue-7')[0].detail)" -like '*MANIFEST_UNREADABLE*') 'S9: the page names the failure'
  New-Stranded
  Set-Flag
  $null = & node "$testRoot\bin\work-state.js" transition --root $testRoot --id nidus:issue-7 --to implementing --expected-revision 1 --idempotency-key t7 2>&1
  $s9b = Run-Check -Apply
  Assert-True ((Stranded-For $s9b 'nidus:issue-7').Count -eq 0 -and (Is-Reserved 'nidus:issue-7')) 'S9: a record that is no longer assigned is not a stranded reservation'
  Write-Output 'sentinel-stranded-reservation S9 passed'

  # ---- S10 (QA #261): a launch in flight between the two ticks wins. Tick 1 arms the record; before tick 2 a roster row
  # (or a job naming the manifest) appears: tick 2 pages nothing, releases nothing, and the armed state is dropped, so a
  # later genuine strand has to be seen on two ticks again.
  New-Stranded
  Set-Flag
  $null = Run-Check -Apply
  Write-Utf8 "$testRoot\state\roster.json" (@{ sessions = @([pscustomobject]@{ name = 'ic-7'; role = 'ic'; tenant = 'nidus'; issue = 7; status = 'active'; jobId = 'job-7' }) } | ConvertTo-Json -Depth 5)
  Assert-Untouched (Run-Check -Apply) 'nidus:issue-7' 'nidus' 7 'S10 (roster row appeared)'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $s10b = Run-Check -Apply
  Assert-True (@($s10b.strandedReleased).Count -eq 0 -and (Is-Reserved 'nidus:issue-7')) 'S10: the armed state was dropped when the record stopped looking stranded'
  # a gap of more than an hour between sightings restarts the count
  New-Stranded
  Set-Flag
  $null = Run-Check -Apply
  $seen = Get-Content "$testRoot\state\sentinel\stranded-seen.json" -Raw | ConvertFrom-Json
  $seen.'nidus:issue-7'.lastSeen = (Get-Date).ToUniversalTime().AddHours(-3).ToString('o')
  Write-Utf8 "$testRoot\state\sentinel\stranded-seen.json" ($seen | ConvertTo-Json -Depth 4)
  $s10c = Run-Check -Apply
  Assert-True (@($s10c.strandedReleased).Count -eq 0 -and (Is-Reserved 'nidus:issue-7')) 'S10: a stale first sighting does not count as the previous tick'
  Write-Output 'sentinel-stranded-reservation S10 passed'

  # ---- S11 (QA #261): the fresh re-read right before the release. The record is armed and still stranded at the top of
  # the tick, but a job naming the manifest appears between the classification and the release (the mock plants it on
  # the second `claude agents` call, the re-read): the release is cancelled.
  New-Stranded
  Set-Flag
  $null = Run-Check -Apply
  Age-Seen 15
  Write-Utf8 "$testRoot\mock-bin\late-job-intent.txt" ('Read the assignment manifest at ' + (Manifest-Path 'nidus' 7) + ' and the GitHub issue body.')
  Remove-Item "$testRoot\mock-bin\agents-count.txt" -Force -ErrorAction SilentlyContinue
  $s11 = Run-Check -Apply
  $e11 = Stranded-For $s11 'nidus:issue-7'
  Assert-True (@($s11.strandedReleased).Count -eq 0 -and (Is-Reserved 'nidus:issue-7') -and -not (Test-Path ((Manifest-Path 'nidus' 7) + '.invalidated.json'))) 'S11: nothing released when a job appears before the release'
  Assert-True ($e11.Count -eq 1 -and "$($e11[0].detail)" -like '*release cancelled*') "S11: the page says the release was cancelled (got: $($e11 | ConvertTo-Json -Compress))"
  Write-Output 'sentinel-stranded-reservation S11 passed'

  # ---- S12 (#261 re-QA): two -Apply runs a minute apart cannot arm a release; a prior sighting 15 min old does; and a
  # read-only run leaves no remembered sighting (so a hand read-only run cannot arm anything).
  New-Stranded
  Set-Flag
  $null = Run-Check
  Assert-True (-not (Test-Path "$testRoot\state\sentinel\stranded-seen.json")) 'S12: a read-only run writes no stranded-seen.json'
  $null = Run-Check -Apply
  $first12 = (Get-Content "$testRoot\state\sentinel\stranded-seen.json" -Raw | ConvertFrom-Json).'nidus:issue-7'.firstSeen
  Age-Seen 1
  $s12 = Run-Check -Apply
  $e12 = Stranded-For $s12 'nidus:issue-7'
  Assert-True (@($s12.strandedReleased).Count -eq 0 -and (Is-Reserved 'nidus:issue-7') -and $e12.Count -eq 1 -and "$($e12[0].detail)" -like '*first sighting*') 'S12: a prior sighting one minute old does not arm the release'
  Age-Seen 15
  $s12b = Run-Check -Apply
  Assert-True (@($s12b.strandedReleased).Count -eq 1 -and -not (Is-Reserved 'nidus:issue-7')) 'S12: with the prior sighting 15 min old the release goes ahead'
  Write-Output 'sentinel-stranded-reservation S12 passed'

  Write-Output 'sentinel-stranded-reservation: all cases passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $env:FLEET_RESPAWN_VERIFY_MS = $oldVerify
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = $oldPoll
  if (Test-Path $testRoot) { Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
