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
  function New-Reservation { param([int]$N)
    $manifest = [ordered]@{ schemaVersion = 1; status = 'pending-ack'; id = "assignment-test-$N"; workRecordId = "test:issue-$N"; workRecordRevision = 1; tenant = 'test'; parent = 'pl-test' }
    Write-Utf8 (Manifest-Path $N) ($manifest | ConvertTo-Json -Depth 6)
    $null = & node "$testRoot\bin\work-state.js" reserve --root $testRoot --id "test:issue-$N" --tenant test --issue $N --manifest (Manifest-Path $N) --idempotency-key "reserve-$N"
    if ($LASTEXITCODE -ne 0) { throw "fixture reservation for issue $N failed" }
  }
  function Get-ActiveRecords { (Get-Content "$testRoot\state\work\active.json" -Raw | ConvertFrom-Json).records }
  # A roster row the way launch.ps1 writes it (manifest, workRecordId, launchedAt), its owned worktree, its
  # reservation and, unless told otherwise, nothing else: no heartbeat, no ack, no job, no daemon row.
  function New-Case { param([int]$N, $LaunchedMinutesAgo = 90, [string]$LaunchedRaw = '', [switch]$Legacy)
    Reset-Fixture
    Invoke-Git @('-C', $hub, 'branch', "ic-$N-fix", 'main') | Out-Null
    Invoke-Git @('-C', $hub, 'worktree', 'add', '-q', "$hub\.claude\worktrees\ic-$N-fix", "ic-$N-fix") | Out-Null
    $row = [ordered]@{ name = "ic-$N"; role = 'ic'; tenant = 'test'; parent = 'pl-test'; issue = $N; cwd = $hub; status = 'active'; jobId = "job-$N" }
    if (-not $Legacy) {
      New-Reservation $N
      $row.manifest = Manifest-Path $N; $row.workRecordId = "test:issue-$N"
      if ($LaunchedRaw) { $row.launchedAt = $LaunchedRaw } elseif ($null -ne $LaunchedMinutesAgo) { $row.launchedAt = Iso-Ago $LaunchedMinutesAgo }
    }
    Write-Utf8 "$testRoot\state\roster.json" (@{ sessions = @([pscustomobject]$row) } | ConvertTo-Json -Depth 6)
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

  # ---- D9: the record cannot be released (already implementing): the retire stands, the failure is named, no marker.
  New-Case 909
  Set-Flag
  $null = & node "$testRoot\bin\work-state.js" transition --root $testRoot --id test:issue-909 --to implementing --expected-revision 1 --idempotency-key t909 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'D9 fixture: transition to implementing failed' }
  $d9 = Run-Check -Apply
  Assert-True ((Roster-Status 'ic-909') -eq 'retired') 'D9: the row is still retired'
  Assert-True ($d9.deadRetired[0].release.ok -eq $false -and $d9.deadRetired[0].release.code -eq 'INVALID_RELEASE') "D9: release.code INVALID_RELEASE (got: $($d9.deadRetired[0].release | ConvertTo-Json -Compress))"
  $e9 = @($d9.escalate | Where-Object { $_.name -eq 'ic-909' -and $_.kind -eq 'ic-dead-before-ack' })[0]
  Assert-True ("$($e9.detail)" -like '*INVALID_RELEASE*') 'D9: the page names the release failure'
  Assert-True (-not (Test-Path ((Manifest-Path 909) + '.invalidated.json'))) 'D9: no marker when the release failed'
  Assert-True ($null -ne (Get-ActiveRecords).PSObject.Properties['test:issue-909']) 'D9: the record is untouched'
  Write-Output 'sentinel-dead-before-ack D9 passed'

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

  Write-Output 'sentinel-dead-before-ack: all cases passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $env:FLEET_RESPAWN_VERIFY_MS = $oldVerify
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = $oldPoll
  Remove-Item Env:MOCK_STOP_DROPS -ErrorAction SilentlyContinue
  if (Test-Path $testRoot) { Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
