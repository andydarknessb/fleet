# fleet #253: an IC that got a roster row and died before `assignment-started` leaves an
# `assigned` Work record that only a hand `retire.ps1` frees. sentinel-check now recognises the
# dead-before-ack row (no heartbeat ever, no .acknowledged.json, past the grace, its job gone) and,
# only under -Apply AND state/flags/ic-cleanup-live, retires the row (retire.ps1) and releases the
# reservation (Invoke-ManifestRelease: work-state.js release + <manifest>.invalidated.json).
# Everything else keeps today's ic-vanished / respawn path. Real retire.ps1, a real git hub with an
# owned worktree and a real work-state.js reservation; only `claude` and `gh` are mocked.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Invoke-Git { param([string[]]$GitArgs) $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & git @GitArgs 2>&1 | Out-String } finally { $ErrorActionPreference = $eap } }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-deadack-test-" + [guid]::NewGuid().ToString('N'))
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
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'

  # A real git hub; each case adds its own owned worktree under .claude/worktrees/ic-<N>-fix.
  $hub = "$testRoot\hub"; $remote = "$testRoot\remote.git"
  Invoke-Git @('init', '--bare', '-q', $remote) | Out-Null
  Invoke-Git @('clone', '-q', $remote, $hub) | Out-Null
  Invoke-Git @('-C', $hub, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-Git @('-C', $hub, 'config', 'user.name', 'a') | Out-Null
  Invoke-Git @('-C', $hub, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-Git @('-C', $hub, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-Git @('-C', $hub, 'push', '-q', '-u', 'origin', 'main') | Out-Null
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","repo":' + ($hub | ConvertTo-Json) + ',"github":"owner/repo","defaultBranch":"main","branchPrefix":"fleet/"}')

  # claude: `agents` lists agents.json minus rm'd ids; stop/rm/respawn are logged to calls.txt.
  $mockClaude = @'
param([string]$Verb, [string]$Arg1)
$root = 'TESTROOT'
if ($Verb -eq 'agents') {
  $rows = @((Get-Content "$root\mock-bin\agents.json" -Raw | ConvertFrom-Json) | Where-Object { $_ } | Where-Object { -not (Test-Path "$root\mock-bin\removed-$($_.id).txt") })
  if ($rows.Count -eq 0) { Write-Output '[]' } else { Write-Output (ConvertTo-Json -InputObject $rows -Compress) }
  exit 0
}
[IO.File]::AppendAllText("$root\calls.txt", "claude $Verb $Arg1`r`n")
if ($Verb -eq 'rm') { Set-Content "$root\mock-bin\removed-$Arg1.txt" 'x' -Encoding ASCII }
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
  function Manifest-Path { param([int]$N) "$testRoot\state\manifests\assignment-test-$N.json" }
  function Write-Job { param([string]$Id, [string]$Name, [string]$State = 'working', $UpdatedMinutesAgo = $null, $Intent = $null)
    [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\$Id") | Out-Null
    $o = [ordered]@{ name = $Name; state = $State; detail = ''; waitingFor = ''; respawnFlags = @('--name', $Name, '--agent', 'ic') }
    if ($null -ne $UpdatedMinutesAgo) { $o.updatedAt = Iso-Ago $UpdatedMinutesAgo }
    if ($null -ne $Intent) { $o.intent = $Intent }
    Write-Utf8 "$testRoot\profile\.claude\jobs\$Id\state.json" (ConvertTo-Json ([pscustomobject]$o) -Compress)
  }
  function Set-Agents { param($Rows) Write-Utf8 "$testRoot\mock-bin\agents.json" (ConvertTo-Json -InputObject @($Rows | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.name; state = $(if ($_.state) { $_.state } else { 'working' }); status = 'idle'; pid = $_.pid; startedAt = $(if ($_.startedAt) { $_.startedAt } else { '2026-09-30T03:44:00Z' }) } }) -Compress) }
  function Reset-Fixture {
    foreach ($d in 'state\manifests', 'state\flags', 'state\heartbeats') { Get-ChildItem "$testRoot\$d" -ErrorAction SilentlyContinue | Remove-Item -Force }
    Get-ChildItem "$testRoot\mock-bin" -Filter 'removed-*.txt' -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem "$testRoot\profile\.claude\jobs" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    foreach ($p in "$testRoot\calls.txt", "$testRoot\state\PAUSE", "$testRoot\config\cycle.json") { Remove-Item $p -Force -ErrorAction SilentlyContinue }
    foreach ($p in "$testRoot\state\sentinel\applied", "$testRoot\state\work", "$testRoot\state\escalations") { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
    Set-Agents @()
  }
  # Reserve the way assignment.js does, including assignment.manifestId (the field Invoke-ManifestRelease checks).
  function Reserve-Record { param([int]$N, [string]$ManifestFile, [string]$ManifestId, [string]$Key, [string]$Tenant = 'test')
    $assignment = (@{ manifestId = $ManifestId } | ConvertTo-Json -Compress).Replace('"', '\"')
    $null = & node "$testRoot\bin\work-state.js" reserve --root $testRoot --id "${Tenant}:issue-$N" --tenant $Tenant --issue $N --manifest $ManifestFile --assignment $assignment --idempotency-key $Key
    if ($LASTEXITCODE -ne 0) { throw "fixture reservation for issue $N failed" }
  }
  function New-Reservation { param([int]$N, [string]$Tenant = 'test')
    $manifest = [ordered]@{ schemaVersion = 1; status = 'pending-ack'; id = "assignment-test-$N"; workRecordId = "${Tenant}:issue-$N"; workRecordRevision = 1; tenant = $Tenant; parent = 'pl-test' }
    Write-Utf8 (Manifest-Path $N) ($manifest | ConvertTo-Json -Depth 6)
    Reserve-Record $N (Manifest-Path $N) "assignment-test-$N" "reserve-$N" $Tenant
  }
  function Get-ActiveRecords { (Get-Content "$testRoot\state\work\active.json" -Raw | ConvertFrom-Json).records }
  # A roster row the way launch.ps1 writes it (manifest, workRecordId, launchedAt), its owned worktree, its
  # reservation and, unless told otherwise, nothing else: no heartbeat, no ack, no job, no daemon row.
  function New-Case { param([int]$N, $LaunchedMinutesAgo = 90, [string]$LaunchedRaw = '', [switch]$Legacy, [switch]$Append, [string]$Tenant = 'test')
    $rowsBefore = @()
    if ($Append) { $rowsBefore = @((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions) } else { Reset-Fixture }
    Invoke-Git @('-C', $hub, 'branch', "ic-$N-fix", 'main') | Out-Null
    Invoke-Git @('-C', $hub, 'worktree', 'add', '-q', "$hub\.claude\worktrees\ic-$N-fix", "ic-$N-fix") | Out-Null
    $row = [ordered]@{ name = "ic-$N"; role = 'ic'; tenant = $Tenant; parent = 'pl-test'; issue = $N; cwd = $hub; status = 'active'; jobId = "job-$N" }
    if (-not $Legacy) {
      New-Reservation $N $Tenant
      $row.manifest = Manifest-Path $N; $row.workRecordId = "${Tenant}:issue-$N"
      if ($LaunchedRaw) { $row.launchedAt = $LaunchedRaw } elseif ($null -ne $LaunchedMinutesAgo) { $row.launchedAt = Iso-Ago $LaunchedMinutesAgo }
    }
    Write-Utf8 "$testRoot\state\roster.json" (@{ sessions = @($rowsBefore) + @([pscustomobject]$row) } | ConvertTo-Json -Depth 6)
  }
  function Run-Check { param([switch]$Apply)
    # Production runs the check without Stop semantics: retire.ps1 drives git/claude whose stderr (a harmless
    # "is not locked") must not become a terminating error under this suite's Stop.
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $out = if ($Apply) { & "$testRoot\bin\sentinel-check.ps1" -Apply -ReportPath "$testRoot\state\sentinel\last-check.json" | Out-String } else { & "$testRoot\bin\sentinel-check.ps1" -ReportPath "$testRoot\state\sentinel\last-check.json" | Out-String }
    } finally { $ErrorActionPreference = $eap }
    $out | ConvertFrom-Json
  }
  function Kinds-For { param($Report, [string]$Name) @($Report.escalate | Where-Object { $_.name -eq $Name } | ForEach-Object { $_.kind }) }
  function Calls { if (Test-Path "$testRoot\calls.txt") { @(Get-Content "$testRoot\calls.txt") } else { @() } }
  function Roster-Status { param([string]$Name) "$((@((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions) | Where-Object { $_.name -eq $Name } | Select-Object -First 1).status)" }
  function Set-Flag { Write-Utf8 "$testRoot\state\flags\ic-cleanup-live" 'test' }
  function Assert-NotRetired { param($Report, [int]$N, [string]$Label)
    Assert-True ((Roster-Status "ic-$N") -eq 'active') "$Label`: the roster row must stay active"
    Assert-True (@($Report.retired) -notcontains "ic-$N") "$Label`: report.retired must not name ic-$N"
    Assert-True (@($Report.deadRetired).Count -eq 0) "$Label`: nothing is recorded as dead-retired"
    Assert-True ($null -ne (Get-ActiveRecords).PSObject.Properties["test:issue-$N"]) "$Label`: the Work record must stay reserved"
    Assert-True (-not (Test-Path ((Manifest-Path $N) + '.invalidated.json'))) "$Label`: no invalidation marker"
  }

  # ---- D1 red-tell (branch a): the row's job is nowhere (no daemon row, no jobs dir), no heartbeat ever,
  # never acked, launched 90 min ago. -Apply + the flag retires the row and releases the reservation.
  New-Case 900
  Set-Flag
  $wt900 = "$hub\.claude\worktrees\ic-900-fix"
  Assert-True (Test-Path $wt900) 'D1 fixture: the owned worktree exists'
  $d1 = Run-Check -Apply
  Assert-True ((Roster-Status 'ic-900') -eq 'retired') "D1: the dead-before-ack roster row is retired (status $(Roster-Status 'ic-900'))"
  Assert-True (-not (Test-Path $wt900)) 'D1: the owned worktree is gone'
  Assert-True ($null -eq (Get-ActiveRecords).PSObject.Properties['test:issue-900']) 'D1: the Work record is released (no longer active)'
  Assert-True (Test-Path ((Manifest-Path 900) + '.invalidated.json')) 'D1: the invalidation marker is written'
  $marker1 = Get-Content ((Manifest-Path 900) + '.invalidated.json') -Raw | ConvertFrom-Json
  Assert-True ($marker1.manifestId -eq 'assignment-test-900' -and $marker1.schemaVersion -eq 1 -and "$($marker1.reason)" -like 'dead before ack*') 'D1: the marker has the launch.ps1 shape and the reason'
  Assert-True (@($d1.retired) -contains 'ic-900') 'D1: report.retired names ic-900'
  Assert-True (@($d1.deadRetired).Count -eq 1 -and $d1.deadRetired[0].name -eq 'ic-900' -and $d1.deadRetired[0].jobId -eq 'job-900' -and $d1.deadRetired[0].workRecordId -eq 'test:issue-900') 'D1: report.deadRetired names the row'
  Assert-True ($d1.deadRetired[0].release.ok -eq $true) 'D1: deadRetired[0].release.ok'
  $k1 = Kinds-For $d1 'ic-900'
  Assert-True (($k1 -contains 'ic-dead-before-ack') -and ($k1 -notcontains 'ic-vanished')) "D1: escalates ic-dead-before-ack, not ic-vanished (got: $($k1 -join ','))"
  $ledger1 = @(Get-ChildItem "$testRoot\state\sentinel\applied" -Filter *.jsonl | ForEach-Object { Get-Content $_.FullName })
  Assert-True ($ledger1.Count -ge 1 -and (($ledger1[-1] | ConvertFrom-Json).deadRetired[0].workRecordId -eq 'test:issue-900')) 'D1: deadRetired reaches the applied ledger line'
  Write-Output 'sentinel-dead-before-ack D1 passed'

  # ---- D2 (branch b): the daemon row is this job, failed, no pid, job state 90 min old: retired + released, no respawn.
  New-Case 902
  Set-Flag
  Set-Agents @(@{ id = 'job-902'; name = 'ic-902'; state = 'failed'; pid = $null })
  Write-Job 'job-902' 'ic-902' 'failed' 90
  $d2 = Run-Check -Apply
  Assert-True ((Roster-Status 'ic-902') -eq 'retired') 'D2: the row is retired'
  Assert-True ($null -eq (Get-ActiveRecords).PSObject.Properties['test:issue-902'] -and (Test-Path ((Manifest-Path 902) + '.invalidated.json'))) 'D2: released, marker written'
  Assert-True (@(Calls | Where-Object { $_ -like 'claude respawn*' }).Count -eq 0) "D2: no claude respawn (calls: $((Calls) -join '; '))"
  Assert-True ((Kinds-For $d2 'ic-902') -contains 'ic-dead-before-ack') 'D2: escalates ic-dead-before-ack'
  Write-Output 'sentinel-dead-before-ack D2 passed'

  # ---- D3: the same row with a heartbeat on file: the recover/respawn path owns it, it is not retired.
  New-Case 903
  Set-Flag
  Write-Utf8 "$testRoot\state\heartbeats\ic-903.json" (ConvertTo-Json @{ at = Iso-Ago 80 } -Compress)
  Set-Agents @(@{ id = 'job-903'; name = 'ic-903'; state = 'failed'; pid = $null })
  Write-Job 'job-903' 'ic-903' 'failed' 90
  $d3 = Run-Check -Apply
  Assert-NotRetired $d3 903 'D3'
  Assert-True ((Calls) -contains 'claude respawn job-903') "D3: the existing respawn path ran (calls: $((Calls) -join '; '))"
  Assert-True ((Kinds-For $d3 'ic-903') -notcontains 'ic-dead-before-ack') 'D3: no dead-before-ack page'
  Write-Output 'sentinel-dead-before-ack D3 passed'

  # ---- D4: an acknowledged manifest is not dead-before-ack.
  New-Case 904
  Set-Flag
  Write-Utf8 ((Manifest-Path 904) + '.acknowledged.json') '{"schemaVersion":1}'
  $d4 = Run-Check -Apply
  Assert-NotRetired $d4 904 'D4'
  Assert-True ((Kinds-For $d4 'ic-904') -contains 'ic-vanished') 'D4: today ic-vanished'
  Write-Output 'sentinel-dead-before-ack D4 passed'

  # ---- D5 grace: launched 10 min ago (under the 60 min grace): ic-vanished, nothing retired.
  New-Case 905 -LaunchedMinutesAgo 10
  Set-Flag
  $d5 = Run-Check -Apply
  Assert-NotRetired $d5 905 'D5'
  Assert-True (((Kinds-For $d5 'ic-905') -contains 'ic-vanished') -and ((Kinds-For $d5 'ic-905') -notcontains 'ic-dead-before-ack')) 'D5: ic-vanished only'
  Write-Output 'sentinel-dead-before-ack D5 passed'

  # ---- D6 partial read: no daemon row but the job state is working and fresh (5 min): the job may be alive.
  New-Case 906
  Set-Flag
  Write-Job 'job-906' 'ic-906' 'working' 5
  $d6 = Run-Check -Apply
  Assert-NotRetired $d6 906 'D6'
  Assert-True ((Kinds-For $d6 'ic-906') -contains 'ic-vanished') 'D6: ic-vanished'
  # D6b: working with no updatedAt at all proves nothing either.
  New-Case 916
  Set-Flag
  Write-Job 'job-916' 'ic-916' 'working'
  Assert-NotRetired (Run-Check -Apply) 916 'D6b'
  # D6c: the same working state gone stale (60 min, past watchdog.staleMinutes 45) is a dead job.
  New-Case 926
  Set-Flag
  Write-Job 'job-926' 'ic-926' 'working' 60
  $d6c = Run-Check -Apply
  Assert-True ((Roster-Status 'ic-926') -eq 'retired' -and $d6c.deadRetired[0].release.ok) 'D6c: a stale working job state is gone'
  Write-Output 'sentinel-dead-before-ack D6 passed'

  # ---- D7: a terminal row whose job state moved 5 min ago: respawn path, nothing retired.
  New-Case 907
  Set-Flag
  Set-Agents @(@{ id = 'job-907'; name = 'ic-907'; state = 'failed'; pid = $null })
  Write-Job 'job-907' 'ic-907' 'failed' 5
  $d7 = Run-Check -Apply
  Assert-NotRetired $d7 907 'D7'
  Assert-True ((Calls) -contains 'claude respawn job-907') 'D7: the respawn path ran'
  # D7b: a live process (pid) with no heartbeat yet is a session mid first turn, never dead.
  New-Case 917
  Set-Flag
  Set-Agents @(@{ id = 'job-917'; name = 'ic-917'; state = 'working'; pid = 917 })
  Write-Job 'job-917' 'ic-917' 'working' 1
  Assert-NotRetired (Run-Check -Apply) 917 'D7b'
  Write-Output 'sentinel-dead-before-ack D7 passed'

  # ---- D8 shadow: no flag, -Apply: paged "would retire", falls through to ic-vanished, nothing touched.
  New-Case 908
  $d8 = Run-Check -Apply
  Assert-NotRetired $d8 908 'D8'
  $k8 = Kinds-For $d8 'ic-908'
  Assert-True (($k8 -contains 'ic-dead-before-ack') -and ($k8 -contains 'ic-vanished')) "D8: pages dead-before-ack and still falls through to ic-vanished (got: $($k8 -join ','))"
  $e8 = @($d8.escalate | Where-Object { $_.name -eq 'ic-908' -and $_.kind -eq 'ic-dead-before-ack' })[0]
  Assert-True ("$($e8.detail)" -like '*would retire*' -and "$($e8.detail)" -like '*test:issue-908*' -and "$($e8.detail)" -like '*ic-cleanup-live absent*' -and $e8.parent -eq 'pl-test') "D8: the detail says what it would do (got: $($e8.detail))"
  Assert-True ((Calls).Count -eq 0) 'D8: no process touched'
  # D8b: the flag stands but the run is read-only: the same shadow.
  Set-Flag
  $d8b = Run-Check
  Assert-NotRetired $d8b 908 'D8b'
  Assert-True (((Kinds-For $d8b 'ic-908') -contains 'ic-dead-before-ack') -and (Calls).Count -eq 0) 'D8b: read-only run pages and touches nothing'
  Write-Output 'sentinel-dead-before-ack D8 passed'

  # ---- D9 (QA #261): a missing ack sidecar alone is not proof of no ack - acknowledgeAssignment moves the record out of
  # `assigned` BEFORE it writes the sidecar. A record already implementing is the ledger saying the IC acked: the row is
  # not retired, today's path (ic-vanished) stands, and the record is untouched.
  New-Case 909
  Set-Flag
  $null = & node "$testRoot\bin\work-state.js" transition --root $testRoot --id test:issue-909 --to implementing --expected-revision 1 --idempotency-key t909 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'D9 fixture: transition to implementing failed' }
  $d9 = Run-Check -Apply
  Assert-NotRetired $d9 909 'D9'
  $k9 = Kinds-For $d9 'ic-909'
  Assert-True (($k9 -contains 'ic-vanished') -and ($k9 -notcontains 'ic-dead-before-ack')) "D9: today ic-vanished, no dead-before-ack page (got: $($k9 -join ','))"
  # D9a: a record that is gone from active.json proves nothing either.
  New-Case 919
  Set-Flag
  Remove-Item "$testRoot\state\work\active.json" -Force
  $d9a = Run-Check -Apply
  Assert-True ((Roster-Status 'ic-919') -eq 'active' -and @($d9a.deadRetired).Count -eq 0) 'D9a: no active Work record, no retire'
  # D9b: the release is refused by another route (an assigned record that is no longer untouched, so INVALID_RELEASE):
  # the retire stands, the failure is named, no marker.
  New-Case 929
  Set-Flag
  $null = & node "$testRoot\bin\work-state.js" budget --root $testRoot --id test:issue-929 --expected-revision 1 --phase warn --tokens 5 --idempotency-key b929 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'D9b fixture: budget warn failed' }
  $d9b = Run-Check -Apply
  Assert-True ((Roster-Status 'ic-929') -eq 'retired') 'D9b: the row is still retired'
  Assert-True ($d9b.deadRetired[0].release.ok -eq $false -and $d9b.deadRetired[0].release.code -eq 'INVALID_RELEASE') "D9b: release.code INVALID_RELEASE (got: $($d9b.deadRetired[0].release | ConvertTo-Json -Compress))"
  $e9 = @($d9b.escalate | Where-Object { $_.name -eq 'ic-929' -and $_.kind -eq 'ic-dead-before-ack' })[0]
  Assert-True ("$($e9.detail)" -like '*INVALID_RELEASE*') 'D9b: the page names the release failure'
  Assert-True (-not (Test-Path ((Manifest-Path 929) + '.invalidated.json'))) 'D9b: no marker when the release failed'
  Assert-True ($null -ne (Get-ActiveRecords).PSObject.Properties['test:issue-929']) 'D9b: the record is untouched'
  Write-Output 'sentinel-dead-before-ack D9 passed'

  # ---- D16 (QA #261): Invoke-ManifestRelease refuses a manifest that is not the record's current one. Reserve M1, hand
  # release, re-reserve M2 under the same Work record id: releasing "M1" must not release M2's reservation or mark M1.
  New-Case 940
  $m1 = Manifest-Path 940; $m2 = Manifest-Path 9401
  Write-Utf8 $m2 '{"schemaVersion":1,"id":"assignment-test-9401","workRecordId":"test:issue-940","tenant":"test","parent":"pl-test"}'
  $null = & node "$testRoot\bin\work-state.js" release --root $testRoot --id test:issue-940 --expected-revision 1 --idempotency-key hand-release-940 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'D16 fixture: hand release failed' }
  Reserve-Record 940 $m2 'assignment-test-9401' 'reserve-940-again'
  function Invoke-Release { param([string]$Manifest)
    $cmd = ". '$testRoot\bin\_common.ps1'; Invoke-ManifestRelease -Manifest '$Manifest' -WorkRecordId 'test:issue-940' -Reason 'qa' | ConvertTo-Json -Compress"
    (& powershell -NoProfile -ExecutionPolicy Bypass -Command $cmd | Out-String) | ConvertFrom-Json
  }
  $r16 = Invoke-Release $m1
  Assert-True ($r16.ok -eq $false -and $r16.code -eq 'MANIFEST_MISMATCH') "D16: the stale manifest is refused (got: $($r16 | ConvertTo-Json -Compress))"
  Assert-True ($null -ne (Get-ActiveRecords).PSObject.Properties['test:issue-940'] -and -not (Test-Path ($m1 + '.invalidated.json'))) 'D16: M2 stays reserved and M1 is not marked'
  $r16b = Invoke-Release $m2
  Assert-True ($r16b.ok -eq $true -and (Test-Path ($m2 + '.invalidated.json')) -and $null -eq (Get-ActiveRecords).PSObject.Properties['test:issue-940']) 'D16: the current manifest releases'
  Write-Output 'sentinel-dead-before-ack D16 passed'

  # ---- D10 PAUSE: nothing is acted; an ok entry says deferred; today's ic-vanished stands.
  New-Case 910
  Set-Flag
  Write-Utf8 "$testRoot\state\PAUSE" 'reason=manual'
  $d10 = Run-Check -Apply
  Assert-NotRetired $d10 910 'D10'
  Assert-True (@($d10.ok | Where-Object { $_.name -eq 'ic-910' -and "$($_.detail)" -like '*deferred*' }).Count -eq 1) 'D10: an ok entry says the retire was deferred'
  Assert-True ((Kinds-For $d10 'ic-910') -contains 'ic-vanished') 'D10: ic-vanished stands'
  Write-Output 'sentinel-dead-before-ack D10 passed'

  # ---- D11: a legacy row (no manifest, no workRecordId, no launchedAt) is today's ic-vanished.
  New-Case 911 -Legacy
  Set-Flag
  $d11 = Run-Check -Apply
  Assert-True ((Roster-Status 'ic-911') -eq 'active' -and @($d11.deadRetired).Count -eq 0 -and (Kinds-For $d11 'ic-911') -contains 'ic-vanished' -and (Kinds-For $d11 'ic-911') -notcontains 'ic-dead-before-ack') 'D11: a legacy row is not touched'
  Write-Output 'sentinel-dead-before-ack D11 passed'

  # ---- D12: config watchdog.deadBeforeAckMinutes moves the grace (45 min since launch passes a 30 min grace).
  New-Case 912 -LaunchedMinutesAgo 45
  Set-Flag
  Write-Utf8 "$testRoot\config\cycle.json" '{"watchdog":{"deadBeforeAckMinutes":30}}'
  $d12 = Run-Check -Apply
  Assert-True ((Roster-Status 'ic-912') -eq 'retired') 'D12: a 30 min configured grace retires a 45 min old row'
  Write-Output 'sentinel-dead-before-ack D12 passed'

  # ---- D13: a future-dated or unparseable launchedAt fails the predicate.
  New-Case 913 -LaunchedMinutesAgo -30
  Set-Flag
  Assert-NotRetired (Run-Check -Apply) 913 'D13 future'
  New-Case 923 -LaunchedRaw 'not-a-date'
  Set-Flag
  Assert-NotRetired (Run-Check -Apply) 923 'D13 unparseable'
  Write-Output 'sentinel-dead-before-ack D13 passed'

  # ---- D14 (#253 addition i): an orphan late session of the same name, started LATER, must not be taken
  # for the IC row by Latest-Row. The IC own row (job-914, failed, heartbeat on file) is respawned; the
  # orphan (job-914b, working, manifest invalidated) is paged as an orphan.
  New-Case 914
  Write-Utf8 "$testRoot\state\heartbeats\ic-914.json" (ConvertTo-Json @{ at = Iso-Ago 80 } -Compress)
  Write-Utf8 (Manifest-Path 9140) '{"id":"assignment-test-9140","parent":"pl-test"}'
  Write-Utf8 ((Manifest-Path 9140) + '.invalidated.json') (ConvertTo-Json @{ schemaVersion = 1; manifestId = 'assignment-test-9140'; invalidatedAt = Iso-Ago 100; reason = 'no session appeared within 15s' } -Compress)
  Write-Job 'job-914' 'ic-914' 'failed' 90
  Write-Job 'job-914b' 'ic-914' 'working' 1 (([string][char]0xFEFF) + 'Read the assignment manifest at ' + (Manifest-Path 9140) + ' and the GitHub issue body.')
  Set-Agents @(@{ id = 'job-914'; name = 'ic-914'; state = 'failed'; pid = $null; startedAt = '2026-09-30T03:44:00Z' }, @{ id = 'job-914b'; name = 'ic-914'; state = 'working'; pid = 99; startedAt = '2026-09-30T09:00:00Z' })
  $d14 = Run-Check -Apply
  Assert-True ((Kinds-For $d14 'ic-914') -contains 'orphan-late-session') 'D14: the newer same-named job is classified an orphan'
  Assert-True ((Calls) -contains 'claude respawn job-914') "D14: the IC own dead row was picked for the expected loop, not the orphan (calls: $((Calls) -join '; '))"
  Write-Output 'sentinel-dead-before-ack D14 passed'

  # ---- D14b: the fallback path. Get-ExpectedRow judges a rostered IC by the daemon row with its jobId, and falls back
  # to the newest row by name when there is none. The IC own job is gone (no row, no job state); a same-named orphan
  # (job-918b, invalidated manifest) is running. Without the orphan-id exclusion the orphan would stand in for the IC
  # row and hide the dead one: the IC row must still read dead before ack and be retired.
  New-Case 918
  Set-Flag
  Write-Utf8 (Manifest-Path 9180) '{"id":"assignment-test-9180","parent":"pl-test"}'
  Write-Utf8 ((Manifest-Path 9180) + '.invalidated.json') (ConvertTo-Json @{ schemaVersion = 1; manifestId = 'assignment-test-9180'; invalidatedAt = Iso-Ago 100; reason = 'no session appeared within 15s' } -Compress)
  Write-Job 'job-918b' 'ic-918' 'working' 1 (([string][char]0xFEFF) + 'Read the assignment manifest at ' + (Manifest-Path 9180) + ' and the GitHub issue body.')
  Set-Agents @(@{ id = 'job-918b'; name = 'ic-918'; state = 'working'; pid = 99; startedAt = '2026-09-30T09:00:00Z' })
  $d14b = Run-Check -Apply
  $k14b = Kinds-For $d14b 'ic-918'
  Assert-True ($k14b -contains 'orphan-late-session') 'D14b: the same-named job is classified an orphan'
  Assert-True ((Roster-Status 'ic-918') -eq 'retired' -and @($d14b.retired) -contains 'ic-918' -and $k14b -contains 'ic-dead-before-ack') "D14b: the IC dead row is retired, not masked by the orphan (kinds: $($k14b -join ','))"
  Write-Output 'sentinel-dead-before-ack D14b passed'

  # ---- D15 (#253 coordinator item): recover.ps1 must not bring back a row whose manifest was invalidated. The
  # sentinel retires the row and then invalidates the manifest; a recovery pass that read the roster before the
  # retire would respawn or relaunch it over a released record. Real recover.ps1; launch.ps1 is deliberately not
  # copied, so any relaunch attempt would show as a failed launch in its output.
  [IO.File]::Copy("$sourceRoot\bin\recover.ps1", "$testRoot\bin\recover.ps1", $true)
  function Run-Recover {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { @(& "$testRoot\bin\recover.ps1" 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $eap }
  }
  # (a) a stopped daemon row with an invalidated manifest: not respawned.
  New-Case 930
  Write-Utf8 ((Manifest-Path 930) + '.invalidated.json') '{"schemaVersion":1}'
  Set-Agents @(@{ id = 'job-930'; name = 'ic-930'; state = 'stopped'; pid = $null })
  $r15a = Run-Recover
  Assert-True (@(Calls | Where-Object { $_ -like 'claude respawn*' }).Count -eq 0) "D15a: no respawn of an invalidated manifest's row (calls: $((Calls) -join '; '))"
  Assert-True (@($r15a | Where-Object { $_ -like 'ic-930: skipped*invalidated*' }).Count -eq 1) "D15a: the skip is logged (output: $($r15a -join ' | '))"
  Assert-True ((Roster-Status 'ic-930') -eq 'active') 'D15a: recover does not touch the roster'
  # (b) no daemon row: no relaunch through launch.ps1 either.
  New-Case 931
  Write-Utf8 ((Manifest-Path 931) + '.invalidated.json') '{"schemaVersion":1}'
  $r15b = Run-Recover
  Assert-True (@($r15b | Where-Object { $_ -like 'ic-931: skipped*' }).Count -eq 1 -and @($r15b | Where-Object { $_ -like 'ic-931: relaunched*' }).Count -eq 0) "D15b: no relaunch (output: $($r15b -join ' | '))"
  Assert-True ((Get-Content "$testRoot\state\sentinel\last-recover.txt" -Raw) -like '*ic-931: skipped*') 'D15b: the skip reaches last-recover.txt'
  # (c) control: no marker, the same stopped row is respawned as before.
  New-Case 932
  Set-Agents @(@{ id = 'job-932'; name = 'ic-932'; state = 'stopped'; pid = $null })
  $null = Run-Recover
  Assert-True ((Calls) -contains 'claude respawn job-932') 'D15c: a row without the marker is still respawned'
  Write-Output 'sentinel-dead-before-ack D15 passed'

  # ---- D17 (QA #261): report.retired names the row only when retire.ps1 really retired it. A retire that fails (here a
  # stub that prints nothing and exits 1) leaves the row active, skips the release and says so.
  New-Case 950
  Set-Flag
  $realRetire = Get-Content "$testRoot\bin\retire.ps1" -Raw
  Write-Utf8 "$testRoot\bin\retire.ps1" 'exit 1'
  try { $d17 = Run-Check -Apply } finally { Write-Utf8 "$testRoot\bin\retire.ps1" $realRetire }
  Assert-True ((Roster-Status 'ic-950') -eq 'active' -and @($d17.retired) -notcontains 'ic-950') 'D17: a failed retire is not reported retired'
  Assert-True ($d17.deadRetired[0].release.code -eq 'RETIRE_FAILED' -and $null -ne (Get-ActiveRecords).PSObject.Properties['test:issue-950'] -and -not (Test-Path ((Manifest-Path 950) + '.invalidated.json'))) 'D17: the release is skipped and the record stays reserved'
  $e17 = @($d17.escalate | Where-Object { $_.name -eq 'ic-950' -and $_.kind -eq 'ic-dead-before-ack' })[0]
  Assert-True ("$($e17.detail)" -like '*retire FAILED*') 'D17: the page says the retire failed'
  Write-Output 'sentinel-dead-before-ack D17 passed'

  # ---- D18 (QA #261): at most watchdog.deadBeforeAckMaxPerTick (default 2) retires per tick; the rest roll to the next tick
  # with an ok entry and today's path, and the next tick takes them.
  New-Case 960
  New-Case 961 -Append
  New-Case 962 -Append -Tenant 'other'   # a third assignment in one tenant needs an independence proof; another tenant does not
  Set-Flag
  $d18 = Run-Check -Apply
  $retired18 = @(960, 961, 962 | Where-Object { (Roster-Status "ic-$_") -eq 'retired' })
  Assert-True ($retired18.Count -eq 2 -and @($d18.retired).Count -eq 2) "D18: exactly two rows retired on the first tick (retired: $($retired18 -join ','))"
  $left = @(960, 961, 962 | Where-Object { (Roster-Status "ic-$_") -eq 'active' })
  Assert-True ($left.Count -eq 1 -and @($d18.ok | Where-Object { $_.name -eq "ic-$($left[0])" -and "$($_.detail)" -like '*deferred to the next tick*' }).Count -eq 1) 'D18: the third row has an ok entry saying it rolled to the next tick'
  $d18b = Run-Check -Apply
  Assert-True ((Roster-Status "ic-$($left[0])") -eq 'retired' -and @($d18b.retired).Count -eq 1) 'D18: the next tick retires the remaining row'
  # the cap is configurable
  New-Case 970
  New-Case 971 -Append
  Set-Flag
  Write-Utf8 "$testRoot\config\cycle.json" '{"watchdog":{"deadBeforeAckMaxPerTick":1}}'
  $d18c = Run-Check -Apply
  Assert-True (@($d18c.retired).Count -eq 1) 'D18: watchdog.deadBeforeAckMaxPerTick moves the cap'
  Write-Output 'sentinel-dead-before-ack D18 passed'

  Write-Output 'sentinel-dead-before-ack: all cases passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $env:FLEET_RESPAWN_VERIFY_MS = $oldVerify
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = $oldPoll
  Remove-Item Env:MOCK_STOP_DROPS -ErrorAction SilentlyContinue
  if (Test-Path $testRoot) { Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
