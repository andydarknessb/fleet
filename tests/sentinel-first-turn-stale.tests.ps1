$ErrorActionPreference = 'Stop'

# fleet #257 Gap A: an IC whose FIRST turn never ended. The session is alive (a pid, state working), but it never wrote
# a heartbeat (the stop hook writes it at the end of a turn), its job state has been silent for a while and the job has
# no firstTerminalAt. Every existing path skipped it: Heartbeat-Age is $null, and `$null -ne $age` gates the respawn.
# sentinel-check now reads that as stale, pages ic-first-turn-stale in every mode, and respawns only under -Apply AND
# state/flags/ic-cleanup-live (shadow-first, like #252/#253/#256). The respawn goes through Do-Respawn, so the Gap B bound
# (respawn-streak.json) applies to it. Harness cloned from tests/sentinel-respawn.tests.ps1.

$script:failures = @()
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { $script:failures += $Message; Write-Output "FAIL: $Message" } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-sentinel-firstturn-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE
$manifestPath = "$testRoot\state\manifests\assignment-test-900.json"

function Iso-Ago { param([double]$Minutes) (Get-Date).ToUniversalTime().AddMinutes(-$Minutes).ToString('o') }
function Get-Calls { if (Test-Path "$testRoot\calls.txt") { @(Get-Content "$testRoot\calls.txt" | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) } else { @() } }
function Write-Job { param([double]$UpdatedMinutesAgo = -1, [string]$FirstTerminalAt = '', $InFlight = $null)
  $o = [ordered]@{ name = 'ic-900'; state = 'working'; detail = ''; waitingFor = ''; respawnFlags = @('--name', 'ic-900', '--agent', 'ic') }
  if ($UpdatedMinutesAgo -ge 0) { $o.updatedAt = Iso-Ago $UpdatedMinutesAgo }
  if ($FirstTerminalAt) { $o.firstTerminalAt = $FirstTerminalAt }
  if ($null -ne $InFlight) { $o.inFlight = $InFlight }
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" (ConvertTo-Json ([pscustomobject]$o) -Compress -Depth 6)
}
function Write-Roster { param($LaunchedMinutesAgo = 180)
  $row = [ordered]@{ name = 'ic-900'; role = 'ic'; tenant = 'test'; parent = 'pl-test'; issue = 900; cwd = $testRoot + '\repo'; status = 'active'; jobId = 'job-900'; manifest = $manifestPath; workRecordId = 'test:issue-900' }
  if ($null -ne $LaunchedMinutesAgo) { $row.launchedAt = Iso-Ago $LaunchedMinutesAgo }
  Write-Utf8 "$testRoot\state\roster.json" (ConvertTo-Json ([pscustomobject]@{ sessions = @([pscustomobject]$row) }) -Compress -Depth 6)
}
function Reset-Case {
  Remove-Item "$testRoot\state\heartbeats\ic-900.json", "$testRoot\calls.txt", "$testRoot\mock-respawn-counter.txt", "$testRoot\state\PAUSE", "$testRoot\state\flags\ic-cleanup-live", "$testRoot\state\sentinel\respawn-streak.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\sentinel\applied" -Recurse -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_GH_FAIL, Env:MOCK_STARTED, Env:MOCK_STATUS -ErrorAction SilentlyContinue
  $env:MOCK_PR = '0'
  $env:MOCK_STARTED = Iso-Ago 180
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  Write-Roster 180
  Write-Utf8 "$manifestPath.acknowledged.json" (ConvertTo-Json @{ schemaVersion = 1; workRecordId = 'test:issue-900'; acknowledgedAt = (Get-Date).ToUniversalTime().AddMinutes(-180).AddSeconds(8).ToString('o') } -Compress)
  Write-Job -UpdatedMinutesAgo 90
}
function Run-Check { param([switch]$Apply)
  $a = @{}; if ($Apply) { $a.Apply = $true }
  (& "$testRoot\bin\sentinel-check.ps1" @a | Out-String) | ConvertFrom-Json
}
function First-Turn-Escalations { param($Report) , @($Report.escalate | Where-Object { $_.kind -eq 'ic-first-turn-stale' -and $_.name -eq 'ic-900' }) }
function Names-In-Ok { param($Report) , @($Report.ok | Where-Object { "$_" -match 'ic-900' }) }

try {
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','state/flags','state/manifests','profile/.claude/jobs/job-900','repo','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1', 'sentinel-check.ps1', 'pause.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","defaultBranch":"master","releaseBranch":"master","branchPrefix":"fleet/","repo":' + ("$testRoot\repo" | ConvertTo-Json) + '}')
  & git -C "$testRoot\repo" init --quiet

  # `claude agents` lists job-900 (working, status MOCK_STATUS or idle, startedAt MOCK_STARTED) with a pid that moves after
  # every respawn, so the respawn verifies; MOCK_ROW_ID picks the row's id. Every respawn is logged to calls.txt.
  $mockClaude = @'
param([string]$Mode, [string]$JobId = '')
$root = 'TESTROOT'
$counterPath = "$root\mock-respawn-counter.txt"
$n = 0
if (Test-Path $counterPath) { try { $n = [int]((Get-Content $counterPath -Raw).Trim()) } catch { $n = 0 } }
if ($Mode -eq 'respawn') {
  [IO.File]::AppendAllText("$root\calls.txt", "claude respawn $JobId`r`n")
  Set-Content -Path $counterPath -Value ($n + 1) -Encoding ASCII
  exit 0
}
$status = if ($env:MOCK_STATUS) { $env:MOCK_STATUS } else { 'idle' }
$started = if ($env:MOCK_STARTED) { $env:MOCK_STARTED } else { '' }
Write-Output ('[{"id":"job-900","name":"ic-900","state":"working","status":"' + $status + '","pid":' + (900 + $n) + ',"startedAt":"' + $started + '"}]')
'@
  Write-Utf8 "$testRoot\mock-bin\mock-claude.ps1" ($mockClaude.Replace('TESTROOT', $testRoot))
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="respawn" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-claude.ps1" respawn %2' + "`r`n" + 'if "%1"=="agents" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-claude.ps1" agents' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_GH_FAIL%"=="1" (echo simulated gh failure 1>&2 & exit /b 7)' + "`r`n" + 'if "%MOCK_PR%"=="1" (echo [{"number":777,"headRefName":"fleet/900-fix"}] & exit /b 0)' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:FLEET_RESPAWN_VERIFY_MS = '50'
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = '10'
  $flagPath = "$testRoot\state\flags\ic-cleanup-live"

  # A1 (red-tell): working/idle, pid, launched and started 3 h ago, no heartbeat ever, job state silent 90 min, no
  # firstTerminalAt, ack at launch + 8 s. A read-only run pages ic-first-turn-stale and proposes no respawn.
  Reset-Case
  $a1 = Run-Check
  $e1 = First-Turn-Escalations $a1
  Assert-True ($e1.Count -eq 1) 'A1: one ic-first-turn-stale escalation for ic-900'
  if ($e1.Count -eq 1) {
    Assert-True ($e1[0].parent -eq 'pl-test') 'A1: the escalation carries the parent'
    Assert-True ($e1[0].detail -match 'never completed' -and $e1[0].detail -match 'no heartbeat ever written' -and $e1[0].detail -match 'job state silent' -and $e1[0].detail -match 'manifest acknowledged at') "A1: the detail says what was measured (got: $($e1[0].detail))"
    Assert-True ($e1[0].detail -match [regex]::Escape('would respawn (state/flags/ic-cleanup-live absent)')) "A1: the flag-absent outcome (got: $($e1[0].detail))"
  }
  Assert-True (@($a1.respawned).Count -eq 0) 'A1: nothing is proposed for respawn while shadow'
  Assert-True ((Names-In-Ok $a1).Count -eq 0) "A1: ic-900 is not reported healthy under ok (got: $((Names-In-Ok $a1) -join '; '))"
  Assert-True ((Get-Calls).Count -eq 0) 'A1: nothing ran'

  # A1b: -Apply without the flag is still shadow (the page says so, the session is untouched).
  $a1b = Run-Check -Apply
  Assert-True ((First-Turn-Escalations $a1b).Count -eq 1 -and (First-Turn-Escalations $a1b)[0].detail -match [regex]::Escape('would respawn (state/flags/ic-cleanup-live absent)') -and @($a1b.respawned).Count -eq 0 -and (Get-Calls).Count -eq 0) 'A1b: -Apply without the flag pages and respawns nothing'

  # A1c: the flag present but a read-only run: still nothing runs.
  Write-Utf8 $flagPath 'shadow week passed'
  $a1c = Run-Check
  Assert-True ((First-Turn-Escalations $a1c).Count -eq 1 -and (First-Turn-Escalations $a1c)[0].detail -match [regex]::Escape('would respawn (read-only run)') -and @($a1c.respawned).Count -eq 0 -and (Get-Calls).Count -eq 0) 'A1c: the flag with a read-only run says read-only and respawns nothing'

  # A2: -Apply with the flag respawns through Do-Respawn.
  Reset-Case
  Write-Utf8 $flagPath 'shadow week passed'
  $a2 = Run-Check -Apply
  Assert-True (@($a2.respawned).Count -eq 1 -and $a2.respawned[0].name -eq 'ic-900' -and "$($a2.respawned[0].reason)" -match 'first turn never completed') "A2: the respawn carries the first-turn reason (got $($a2.respawned | ConvertTo-Json -Compress))"
  $c2 = @(Get-Calls)
  Assert-True ($c2.Count -eq 1 -and $c2[0] -eq 'claude respawn job-900') "A2: exactly one claude respawn job-900 (calls: $($c2 -join '; '))"
  $e2 = First-Turn-Escalations $a2
  Assert-True ($e2.Count -eq 1 -and $e2[0].detail -match 'respawned') "A2: the page says it respawned (got: $(@($e2 | ForEach-Object { $_.detail }) -join '; '))"

  # A3: the job state moved 10 min ago: the model is working, not hung.
  Reset-Case
  Write-Job -UpdatedMinutesAgo 10
  $a3 = Run-Check
  Assert-True ((First-Turn-Escalations $a3).Count -eq 0 -and @($a3.respawned).Count -eq 0 -and (Names-In-Ok $a3).Count -ge 1) 'A3: a job state updated 10 min ago is working, not stale'

  # A4: launched only 60 min ago (under firstTurnStaleMinutes, default 120): a slow first turn (p90 is 32 min).
  Reset-Case
  Write-Roster 60
  $a4 = Run-Check
  Assert-True ((First-Turn-Escalations $a4).Count -eq 0 -and @($a4.respawned).Count -eq 0) 'A4: 60 min since launch is under the first-turn threshold'

  # A5: an open PR for the issue: the IC delivered, it is waiting on the PR.
  Reset-Case
  $env:MOCK_PR = '1'
  $a5 = Run-Check
  Assert-True ((First-Turn-Escalations $a5).Count -eq 0 -and @($a5.respawned).Count -eq 0 -and @($a5.ok | Where-Object { $_.name -eq 'ic-900' -and $_.detail -eq 'waiting on PR #777' }).Count -eq 1) 'A5: an open PR exempts, named under ok'

  # A6: a skip-list hold exempts without a PR lookup (a failing gh must not matter).
  Reset-Case
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{"900":"held"},"prs":{}}'
  $env:MOCK_GH_FAIL = '1'
  $a6 = Run-Check
  Assert-True ((First-Turn-Escalations $a6).Count -eq 0 -and @($a6.respawned).Count -eq 0 -and @($a6.escalate | Where-Object { $_.kind -eq 'pr-lookup-failed' }).Count -eq 0 -and @($a6.ok | Where-Object { $_.name -eq 'ic-900' -and "$($_.detail)" -match 'skip-list hold' }).Count -eq 1) 'A6: a skip-list hold exempts with no PR lookup'

  # A7: status busy with nothing in flight is mid-turn: a hung busy first turn stays with the watchdog's busy-stale page.
  Reset-Case
  $env:MOCK_STATUS = 'busy'
  $a7 = Run-Check
  Assert-True ((First-Turn-Escalations $a7).Count -eq 0 -and @($a7.respawned).Count -eq 0) 'A7: busy with nothing in flight is left to the busy-stale page'
  # ... but busy with only a leaked background task (quiet past busyQuietMinutes) is between turns and reads as stale.
  Write-Job -UpdatedMinutesAgo 90 -InFlight ([pscustomobject]@{ tasks = 1; queued = 0; kinds = @('monitor') })
  $a7b = Run-Check
  Assert-True ((First-Turn-Escalations $a7b).Count -eq 1) 'A7b: busy with only a background task in flight and a quiet job reads as stale'
  Remove-Item Env:MOCK_STATUS

  # A8: a firstTerminalAt means the first turn DID end: not respawned; the stop hook is what is not writing.
  Reset-Case
  Write-Job -UpdatedMinutesAgo 90 -FirstTerminalAt (Iso-Ago 150)
  Write-Utf8 $flagPath 'shadow week passed'
  $a8 = Run-Check -Apply
  Assert-True ((First-Turn-Escalations $a8).Count -eq 0 -and @($a8.respawned).Count -eq 0 -and (Get-Calls).Count -eq 0) 'A8: a finished first turn is not respawned'
  Assert-True (@($a8.ok | Where-Object { $_.name -eq 'ic-900' -and "$($_.detail)" -match 'first turn ended at' -and "$($_.detail)" -match 'stop hook is not writing' }).Count -eq 1) "A8: ok names the stop hook (got: $((Names-In-Ok $a8) -join '; '))"

  # A9: no launchedAt on the row: startedAt stands in. Both unparseable: nothing.
  Reset-Case
  Write-Roster $null
  $a9 = Run-Check
  Assert-True ((First-Turn-Escalations $a9).Count -eq 1) 'A9: no launchedAt, startedAt 3 h ago: fires'
  $env:MOCK_STARTED = 'not-a-date'
  $a9b = Run-Check
  Assert-True ((First-Turn-Escalations $a9b).Count -eq 0 -and @($a9b.respawned).Count -eq 0) 'A9b: no launchedAt and an unparseable startedAt: nothing'
  $env:MOCK_STARTED = Iso-Ago 180
  Write-Roster 180
  $roster9 = Get-Content "$testRoot\state\roster.json" -Raw
  Write-Utf8 "$testRoot\state\roster.json" ($roster9.Replace('"launchedAt":"', '"launchedAt":"not-a-date-'))
  $a9c = Run-Check
  Assert-True ((First-Turn-Escalations $a9c).Count -eq 1) 'A9c: an unparseable launchedAt falls back to startedAt'

  # A10: a heartbeat on file (3 h old) is today's path, with today's reason, one respawn, and no first-turn page.
  Reset-Case
  Write-Utf8 "$testRoot\state\heartbeats\ic-900.json" (ConvertTo-Json @{ at = Iso-Ago 180 } -Compress)
  $a10 = Run-Check
  Assert-True (@($a10.respawned).Count -eq 1 -and "$($a10.respawned[0].reason)" -match 'heartbeat stale' -and (First-Turn-Escalations $a10).Count -eq 0) 'A10: a stale heartbeat respawns with the old reason, exactly once, and raises no first-turn page'

  # A11: PAUSE with the flag: the decision is that Do-Respawn still runs (the rate-limit PAUSE does not stop the existing
  # respawn paths either; only Do-Relaunch refuses under PAUSE, because it would stop a session the door then refuses).
  Reset-Case
  Write-Utf8 $flagPath 'shadow week passed'
  Write-Utf8 "$testRoot\state\PAUSE" 'reason=test; until=2099-01-01T00:00:00Z'
  $a11 = Run-Check -Apply
  Assert-True (@($a11.respawned).Count -eq 1 -and (Get-Calls).Count -eq 1) 'A11: under PAUSE the flagged respawn still runs (same as the heartbeat-stale respawn)'

  # A12: the Gap B bound applies: three recent attempts on this job hold the respawn, and the page says so.
  Reset-Case
  Write-Utf8 $flagPath 'shadow week passed'
  $streak = [ordered]@{ 'ic-900' = [ordered]@{ jobId = 'job-900'; attempts = @((Iso-Ago 30), (Iso-Ago 20), (Iso-Ago 10)); lastReason = 'seeded' } }
  Write-Utf8 "$testRoot\state\sentinel\respawn-streak.json" (ConvertTo-Json $streak -Depth 6)
  $a12 = Run-Check -Apply
  Assert-True (@($a12.respawned).Count -eq 0 -and @($a12.respawnHeld).Count -eq 1 -and (Get-Calls).Count -eq 0) 'A12: the respawn-loop bound holds a first-turn respawn too'
  Assert-True ((First-Turn-Escalations $a12).Count -eq 1 -and (First-Turn-Escalations $a12)[0].detail -match 'held' -and @($a12.escalate | Where-Object { $_.kind -eq 'respawn-loop' }).Count -eq 1) 'A12: the first-turn page says held and respawn-loop is raised'

  # A13: a static session is never read as first-turn stale (it has no assignment and no ack).
  Reset-Case
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"pl-static","role":"project-lead","tenant":"test","parent":"dispatcher","cwd":"x","prompt":"p"}]}'
  $a13 = Run-Check
  Assert-True (@($a13.escalate | Where-Object { $_.kind -eq 'ic-first-turn-stale' -and $_.name -eq 'pl-static' }).Count -eq 0) 'A13: a static session is never first-turn stale'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'

  if ($script:failures.Count -gt 0) { throw "$($script:failures.Count) first-turn-stale assertion(s) failed" }
  Write-Output 'sentinel first-turn-stale tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  foreach ($v in 'FLEET_RESPAWN_VERIFY_MS', 'FLEET_RESPAWN_VERIFY_POLL_MS', 'MOCK_PR', 'MOCK_GH_FAIL', 'MOCK_STARTED', 'MOCK_STATUS') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-sentinel-firstturn-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
