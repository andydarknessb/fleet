$ErrorActionPreference = 'Stop'

# fleet #121 (2026-09-23 22:02Z to 09-24 14:06Z): a rotation's relaunch failed, and
# sentinel-check's Do-Respawn picked the newest daemon row named pl-endzone - job
# e505d7fb, created 2026-08-25 - and ran `claude respawn` on it. respawn replays the
# job's frozen respawnFlags (--model claude-opus-5 --effort xhigh), bypassing
# launch.ps1's pin map, the role file's effort and the roster. pl-endzone ran 16h on
# the wrong model with no roster row. A static session is now respawned only when its
# daemon job is the live roster's job and its frozen flags match what launch.ps1 passes
# today; otherwise it is stopped and relaunched through launch.ps1 -FromRoster.

$script:failures = @()
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { $script:failures += $Message; Write-Output "FAIL: $Message" } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-sentinel-static-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Set-Job { param([string]$Id, [string[]]$Flags)
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\$Id") | Out-Null
  Write-Utf8 "$testRoot\profile\.claude\jobs\$Id\state.json" (([ordered]@{ detail = ''; waitingFor = ''; createdAt = '2026-08-25T00:00:00Z'; respawnFlags = @($Flags) }) | ConvertTo-Json -Compress)
}
function Set-LiveRoster { param([string]$Json) Write-Utf8 "$testRoot\state\roster.json" $Json }
function Get-Calls { if (Test-Path "$testRoot\calls.txt") { @(Get-Content "$testRoot\calls.txt" | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) } else { @() } }
function Reset-Calls { Remove-Item "$testRoot\calls.txt", "$testRoot\pid-counter.txt" -ErrorAction SilentlyContinue }
function Run-Check { param([switch]$Apply) $out = if ($Apply) { & "$testRoot\bin\sentinel-check.ps1" -Apply | Out-String } else { & "$testRoot\bin\sentinel-check.ps1" | Out-String }; $out | ConvertFrom-Json }

try {
  foreach ($dir in 'bin','agents','tenants','state','state/heartbeats','state/sentinel','state/skip','profile/.claude/jobs','repo','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1', 'sentinel-check.ps1', 'pause.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\agents\project-lead.md" "---`nname: project-lead`nmodel: opus`neffort: high`n---`nLead."
  Write-Utf8 "$testRoot\roster.json" ('{"cap":6,"sessions":[{"name":"pl-test","role":"project-lead","tenant":"test","parent":"dispatcher","cwd":' + ("$testRoot\repo" | ConvertTo-Json) + ',"prompt":"lead"}]}')
  # The relaunch pre-flight asks the same trust question launch.ps1 does (fleet #104).
  [IO.Directory]::CreateDirectory("$testRoot\profile") | Out-Null
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","defaultBranch":"master","branchPrefix":"fleet/","repo":' + ("$testRoot\repo" | ConvertTo-Json) + '}')
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  Write-Utf8 "$testRoot\state\heartbeats\pl-test.json" (ConvertTo-Json @{ at = (Get-Date).ToUniversalTime().AddHours(-3).ToString('o') } -Compress)

  # claude: `agents` lists one pl-test row whose pid moves after a respawn (so the
  # ticket-85 verification sees a real restart); respawn and stop are logged.
  $mockClaude = @'
param([string]$Verb, [string]$Arg1)
$root = 'TESTROOT'
if ($Verb -eq 'agents') {
  $n = 0; if (Test-Path "$root\pid-counter.txt") { $n = [int]((Get-Content "$root\pid-counter.txt" -Raw).Trim()) }
  $state = if ($env:MOCK_ROW_STATE) { $env:MOCK_ROW_STATE } else { 'working' }
  $rowName = if ($env:MOCK_ROW_NAME) { $env:MOCK_ROW_NAME } else { 'pl-test' }
  Write-Output ('[{"id":"' + $env:MOCK_ROW_ID + '","name":"' + $rowName + '","state":"' + $state + '","status":"idle","pid":' + (500 + $n) + ',"startedAt":"2026-09-24T00:00:00Z"}]')
  exit 0
}
[IO.File]::AppendAllText("$root\calls.txt", "claude $Verb $Arg1`r`n")
if ($Verb -eq 'respawn') { $n = 0; if (Test-Path "$root\pid-counter.txt") { $n = [int]((Get-Content "$root\pid-counter.txt" -Raw).Trim()) }; Set-Content "$root\pid-counter.txt" ($n + 1) -Encoding ASCII }
exit 0
'@
  Write-Utf8 "$testRoot\mock-bin\mock-claude.ps1" ($mockClaude.Replace('TESTROOT', $testRoot))
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-claude.ps1" %1 %2' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  # launch.ps1 is the door the relaunch must go through; the mock logs the call.
  $mockLaunch = @'
param([string]$FromRoster, [string]$Model, [switch]$Force)
$modelMark = if ($Model) { "|$Model" } else { '' }
[IO.File]::AppendAllText('TESTROOT\calls.txt', "launch $FromRoster$modelMark`r`n")
if ($env:MOCK_LAUNCH_FAIL -eq '1') { Write-Output '{"launched":false,"reason":"workspace not trusted"}'; exit 7 }
Write-Output ('{"launched":true,"name":"' + $FromRoster + '","jobId":"job-new","sessionId":"sess-new"}')
exit 0
'@
  Write-Utf8 "$testRoot\bin\launch.ps1" ($mockLaunch.Replace('TESTROOT', $testRoot))

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:FLEET_RESPAWN_VERIFY_MS = '50'
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = '10'
  $currentFlags = @('--name', 'pl-test', '--agent', 'project-lead', '--settings', 'x', '--model', 'claude-opus-5-5', '--effort', 'high')
  $frozenFlags = @('--name', 'pl-test', '--agent', 'project-lead', '--settings', 'x', '--model', 'claude-opus-5', '--effort', 'xhigh')
  $activeRow = '{"sessions":[{"name":"pl-test","role":"project-lead","tenant":"test","status":"active","jobId":"job-p","model":"opus-5.5"}]}'

  # S1 (control): the roster's own job, flags as launch.ps1 passes them today: claude respawn keeps its history.
  $env:MOCK_ROW_ID = 'job-p'
  Set-Job 'job-p' $currentFlags
  Set-LiveRoster $activeRow
  Reset-Calls
  $s1 = Run-Check -Apply
  Assert-True (@($s1.respawned | Where-Object { $_.name -eq 'pl-test' }).Count -eq 1) "S1: a stale lead on current flags is respawned (got $($s1 | ConvertTo-Json -Compress -Depth 4))"
  Assert-True ((Get-Calls) -contains 'claude respawn job-p' -and -not (@(Get-Calls) -match '^launch')) "S1: through claude respawn, not the launch door (calls: $(@(Get-Calls) -join '; '))"

  # S2: the roster's job, but its frozen flags predate a model/effort ruling: stop it and relaunch through the door.
  Set-Job 'job-p' $frozenFlags
  Reset-Calls
  $s2 = Run-Check -Apply
  $calls2 = @(Get-Calls)
  Assert-True (-not ($calls2 -contains 'claude respawn job-p')) "S2: frozen flags must never be replayed (calls: $($calls2 -join '; '))"
  Assert-True ($calls2 -contains 'claude stop job-p' -and $calls2 -contains 'launch pl-test') "S2: the stale job is stopped and pl-test relaunched from the roster (calls: $($calls2 -join '; '))"
  Assert-True ([array]::IndexOf($calls2, 'claude stop job-p') -lt [array]::IndexOf($calls2, 'launch pl-test')) 'S2: stop comes before the launch'
  $r2 = @($s2.respawned | Where-Object { $_.name -eq 'pl-test' })[0]
  Assert-True ($r2 -and "$($r2.via)" -eq 'launch' -and "$($r2.jobId)" -eq 'job-new' -and "$($r2.reason)" -match 'claude-opus-5\b' -and "$($r2.reason)" -match 'claude-opus-5-5') "S2: the report says it relaunched, names the new job and both flag sets: $($r2 | ConvertTo-Json -Compress)"

  # S3 (the incident): no active live-roster row at all. The newest daemon row is a stale job; relaunch, never respawn.
  $env:MOCK_ROW_ID = 'job-old'
  Set-Job 'job-old' $currentFlags
  Set-LiveRoster '{"sessions":[{"name":"pl-test","role":"project-lead","tenant":"test","status":"retired","jobId":"job-p"}]}'
  Reset-Calls
  $s3 = Run-Check -Apply
  $calls3 = @(Get-Calls)
  Assert-True (-not ($calls3 -contains 'claude respawn job-old') -and $calls3 -contains 'launch pl-test') "S3: with no active roster row the launch door relaunches (calls: $($calls3 -join '; '))"
  Assert-True ("$(@($s3.respawned | Where-Object { $_.name -eq 'pl-test' })[0].reason)" -match 'no active live-roster row') 'S3: the reason names the missing roster row'

  # S4: the roster's active row names another job than the daemon's newest row.
  Set-LiveRoster $activeRow
  Reset-Calls
  $s4 = Run-Check -Apply
  Assert-True (-not (@(Get-Calls) -contains 'claude respawn job-old') -and (@(Get-Calls) -contains 'launch pl-test')) "S4: a daemon job that is not the roster's is relaunched, not respawned (calls: $(@(Get-Calls) -join '; '))"

  # S5: the launch door refuses: respawn-failed, which feeds the watchdog's launch-retry cap.
  $env:MOCK_LAUNCH_FAIL = '1'
  Reset-Calls
  $s5 = Run-Check -Apply
  Assert-True (@($s5.respawnFailed | Where-Object { $_.name -eq 'pl-test' -and "$($_.reason)" -match 'workspace not trusted' }).Count -eq 1) "S5: a refused relaunch is respawn-failed with the door's reason (got $($s5.respawnFailed | ConvertTo-Json -Compress))"
  Assert-True (@($s5.respawned | Where-Object { $_.name -eq 'pl-test' }).Count -eq 0) 'S5: a refused relaunch is not reported respawned'
  Remove-Item Env:MOCK_LAUNCH_FAIL

  # S6: shadow (no -Apply) proposes the relaunch and runs nothing.
  Reset-Calls
  $s6 = Run-Check
  Assert-True (@(Get-Calls).Count -eq 0) "S6: a read-only tick runs nothing (calls: $(@(Get-Calls) -join '; '))"
  Assert-True ("$(@($s6.respawned | Where-Object { $_.name -eq 'pl-test' })[0].via)" -eq 'launch') 'S6: the proposal says it would go through the launch door'

  # S7: a stopped static (no pid to stop) on frozen flags relaunches without a stop call.
  $env:MOCK_ROW_ID = 'job-p'
  $env:MOCK_ROW_STATE = 'stopped'
  Set-Job 'job-p' $frozenFlags
  Reset-Calls
  $s7 = Run-Check -Apply
  Assert-True ((@(Get-Calls) -contains 'launch pl-test') -and -not (@(Get-Calls) -contains 'claude respawn job-p')) "S7: a stopped static on frozen flags relaunches (calls: $(@(Get-Calls) -join '; '))"
  Remove-Item Env:MOCK_ROW_STATE

  # S8: a role launch.ps1 pins no model for (the dispatcher runs its role file's `model:
  # sonnet` alias). The CLI still records the resolved id in respawnFlags, so a frozen
  # claude-sonnet-5 is the role's own model and respawns; a frozen other family relaunches.
  Write-Utf8 "$testRoot\agents\dispatcher.md" "---`nname: dispatcher`nmodel: sonnet`neffort: low`n---`nDispatcher."
  Write-Utf8 "$testRoot\roster.json" ('{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory","cwd":' + ("$testRoot\repo" | ConvertTo-Json) + ',"prompt":"d"}]}')
  Write-Utf8 "$testRoot\state\heartbeats\dispatcher.json" (ConvertTo-Json @{ at = (Get-Date).ToUniversalTime().AddHours(-3).ToString('o') } -Compress)
  Set-LiveRoster '{"sessions":[{"name":"dispatcher","role":"dispatcher","status":"active","jobId":"job-d","model":""}]}'
  $env:MOCK_ROW_NAME = 'dispatcher'
  $env:MOCK_ROW_ID = 'job-d'
  Set-Job 'job-d' @('--name', 'dispatcher', '--agent', 'dispatcher', '--settings', 'x', '--model', 'claude-sonnet-5', '--effort', 'low')
  $s8 = Run-Check
  $d8 = @($s8.respawned | Where-Object { $_.name -eq 'dispatcher' })[0]
  Assert-True ($d8 -and "$($d8.via)" -ne 'launch') "S8: an unpinned role on its role-file model family respawns (got $($d8 | ConvertTo-Json -Compress))"
  Set-Job 'job-d' @('--name', 'dispatcher', '--agent', 'dispatcher', '--settings', 'x', '--model', 'claude-haiku-4-5', '--effort', 'low')
  $s8b = Run-Check
  Assert-True ("$(@($s8b.respawned | Where-Object { $_.name -eq 'dispatcher' })[0].via)" -eq 'launch') 'S8: an unpinned role frozen on another model family relaunches'

  # S9 (review): a hand-set model alias on the roster row (launch.ps1 -Model sonnet) froze
  # as claude-sonnet-5: that is the roster's own choice and respawns. When a relaunch is
  # needed, it carries the roster's -Model so the hand choice is not reverted.
  Set-LiveRoster '{"sessions":[{"name":"dispatcher","role":"dispatcher","status":"active","jobId":"job-d","model":"haiku"}]}'
  Set-Job 'job-d' @('--name', 'dispatcher', '--agent', 'dispatcher', '--settings', 'x', '--model', 'claude-haiku-4-5', '--effort', 'low')
  $s9 = Run-Check
  Assert-True ("$(@($s9.respawned | Where-Object { $_.name -eq 'dispatcher' })[0].via)" -ne 'launch') 'S9: a roster alias that froze as its family id respawns'
  Set-Job 'job-d' @('--name', 'dispatcher', '--agent', 'dispatcher', '--settings', 'x', '--model', 'claude-haiku-4-5', '--effort', 'xhigh')
  Reset-Calls
  $s9b = Run-Check -Apply
  Assert-True (@(Get-Calls) -contains 'launch dispatcher|haiku') "S9: the relaunch keeps the roster's -Model (calls: $(@(Get-Calls) -join '; '))"

  # S10 (review): a roster row with no jobId cannot prove the job is its own: relaunch.
  Set-LiveRoster '{"sessions":[{"name":"dispatcher","role":"dispatcher","status":"active","model":""}]}'
  Set-Job 'job-d' @('--name', 'dispatcher', '--agent', 'dispatcher', '--settings', 'x', '--model', 'claude-sonnet-5', '--effort', 'low')
  $s10 = Run-Check
  Assert-True ("$(@($s10.respawned | Where-Object { $_.name -eq 'dispatcher' })[0].via)" -eq 'launch') 'S10: a roster row without a jobId relaunches'

  # S11 (review): the relaunch never stops a running session the door would then refuse.
  # Under PAUSE (or an untrusted workspace) it is deferred with the reason, nothing stopped.
  Set-LiveRoster '{"sessions":[{"name":"dispatcher","role":"dispatcher","status":"active","jobId":"job-d","model":""}]}'
  Set-Job 'job-d' @('--name', 'dispatcher', '--agent', 'dispatcher', '--settings', 'x', '--model', 'claude-haiku-4-5', '--effort', 'low')
  Write-Utf8 "$testRoot\state\PAUSE" 'rate limit'
  Reset-Calls
  $s11 = Run-Check -Apply
  Assert-True (@(Get-Calls).Count -eq 0) "S11: nothing is stopped or launched under PAUSE (calls: $(@(Get-Calls) -join '; '))"
  Assert-True (@($s11.respawnDeferred | Where-Object { $_.name -eq 'dispatcher' -and "$($_.reason)" -match 'PAUSE' }).Count -eq 1) "S11: the relaunch is deferred naming PAUSE (got $($s11.respawnDeferred | ConvertTo-Json -Compress))"
  Remove-Item "$testRoot\state\PAUSE"
  Write-Utf8 "$testRoot\profile\.claude.json" '{"projects":{}}'
  Reset-Calls
  $s11b = Run-Check -Apply
  Assert-True (@(Get-Calls).Count -eq 0 -and @($s11b.respawnDeferred | Where-Object { "$($_.reason)" -match 'trust' }).Count -eq 1) "S11: an untrusted workspace defers the relaunch before any stop (calls: $(@(Get-Calls) -join '; '))"

  if ($script:failures.Count -gt 0) { throw "$($script:failures.Count) static-respawn assertion(s) failed" }
  Write-Output 'sentinel static respawn tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  foreach ($v in 'FLEET_RESPAWN_VERIFY_MS', 'FLEET_RESPAWN_VERIFY_POLL_MS', 'MOCK_ROW_ID', 'MOCK_ROW_STATE', 'MOCK_ROW_NAME', 'MOCK_LAUNCH_FAIL') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-sentinel-static-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
