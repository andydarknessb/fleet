$ErrorActionPreference = 'Stop'

# fleet #257 Gap B (2026-09-30: pl-nidus was respawned 72 times in a day, every one verified by a pid
# change, none followed by a turn). respawn-failed.json and the retry-storm scan only count failures, and
# a verified respawn clears the failure count, so nothing bounded a respawn that "worked" but woke nothing.
# sentinel-check.ps1 now keeps state/sentinel/respawn-streak.json: the (respawnLoopCap+1)th verified
# respawn of one job inside respawnLoopWindowHours is held and escalated as respawn-loop.
# Harness cloned from tests/sentinel-respawn.tests.ps1.

$script:failures = @()
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { $script:failures += $Message; Write-Output "FAIL: $Message" } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-sentinel-loop-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE
$streakPath = "$testRoot\state\sentinel\respawn-streak.json"

function Get-Calls { if (Test-Path "$testRoot\calls.txt") { @(Get-Content "$testRoot\calls.txt" | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) } else { @() } }
function Set-Heartbeat { param([double]$HoursAgo) Write-Utf8 "$testRoot\state\heartbeats\ic-900.json" (ConvertTo-Json @{ at = (Get-Date).ToUniversalTime().AddHours(-$HoursAgo).ToString('o') } -Compress) }
function Set-Roster { param([string]$JobId) Write-Utf8 "$testRoot\state\roster.json" ('{"sessions":[{"name":"ic-900","role":"ic","tenant":"test","parent":"pl-test","issue":900,"cwd":' + ("$testRoot\repo" | ConvertTo-Json) + ',"status":"active","jobId":"' + $JobId + '"}]}') }
function Reset-Case {
  Remove-Item $streakPath, "$testRoot\calls.txt", "$testRoot\mock-respawn-counter.txt" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\sentinel\applied" -Recurse -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_RESPAWN_NOOP -ErrorAction SilentlyContinue
  $env:MOCK_ROW_ID = 'job-900'
  Set-Heartbeat 3
  Set-Roster 'job-900'
}
function Run-Check { param([switch]$Apply, [string]$Actor = '', [string]$Heal = '')
  # Hashtable splat: PS 5.1 array splatting passes '-Apply' as a positional value.
  $a = @{}; if ($Apply) { $a.Apply = $true }; if ($Actor) { $a.Actor = $Actor }; if ($Heal) { $a.HealRespawn = $Heal }
  (& "$testRoot\bin\sentinel-check.ps1" @a | Out-String) | ConvertFrom-Json
}
function Write-Streak { param([string]$JobId, [double[]]$MinutesAgo)
  $attempts = @($MinutesAgo | ForEach-Object { (Get-Date).ToUniversalTime().AddMinutes(-$_).ToString('o') })
  Write-Utf8 $streakPath (([ordered]@{ 'ic-900' = [ordered]@{ jobId = $JobId; attempts = @($attempts); lastReason = 'seeded' } }) | ConvertTo-Json -Depth 6)
}
function Read-Streak { if (Test-Path $streakPath) { Get-Content $streakPath -Raw | ConvertFrom-Json } else { $null } }

try {
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','profile/.claude/jobs/job-900','profile/.claude/jobs/job-901','repo','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1', 'sentinel-check.ps1', 'pause.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","defaultBranch":"master","releaseBranch":"master","branchPrefix":"fleet/","repo":' + ("$testRoot\repo" | ConvertTo-Json) + '}')
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-900\state.json" '{"detail":"","waitingFor":""}'
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-901\state.json" '{"detail":"","waitingFor":""}'
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  & git -C "$testRoot\repo" init --quiet

  # `claude agents` lists job MOCK_ROW_ID with a pid that moves after every respawn (so the verification sees a
  # real restart); MOCK_RESPAWN_NOOP=1 makes the respawn a no-op. Every respawn is logged to calls.txt.
  $mockClaude = @'
param([string]$Mode, [string]$JobId = '')
$root = 'TESTROOT'
$counterPath = "$root\mock-respawn-counter.txt"
$n = 0
if (Test-Path $counterPath) { try { $n = [int]((Get-Content $counterPath -Raw).Trim()) } catch { $n = 0 } }
if ($Mode -eq 'respawn') {
  [IO.File]::AppendAllText("$root\calls.txt", "claude respawn $JobId`r`n")
  if ($env:MOCK_RESPAWN_NOOP -ne '1') { Set-Content -Path $counterPath -Value ($n + 1) -Encoding ASCII }
  exit 0
}
$id = if ($env:MOCK_ROW_ID) { $env:MOCK_ROW_ID } else { 'job-900' }
Write-Output ('[{"id":"' + $id + '","name":"ic-900","state":"working","status":"idle","pid":' + (900 + $n) + ',"startedAt":"2026-08-28T00:00:00Z"}]')
'@
  Write-Utf8 "$testRoot\mock-bin\mock-claude.ps1" ($mockClaude.Replace('TESTROOT', $testRoot))
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="respawn" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-claude.ps1" respawn %2' + "`r`n" + 'if "%1"=="agents" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\mock-bin\mock-claude.ps1" agents' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:FLEET_RESPAWN_VERIFY_MS = '50'
  $env:FLEET_RESPAWN_VERIFY_POLL_MS = '10'

  # B1 (red-tell): four applying ticks on a session that never writes a heartbeat. Ticks 1-3 respawn (each verified by
  # a pid change); tick 4 is held, escalated, and not run.
  Reset-Case
  $b1 = @(1..4 | ForEach-Object { Run-Check -Apply })
  Assert-True (@($b1[0].respawned).Count -eq 1 -and @($b1[1].respawned).Count -eq 1 -and @($b1[2].respawned).Count -eq 1) 'B1: the first three verified respawns run'
  Assert-True (@($b1[3].respawned).Count -eq 0) "B1: the fourth respawn of the same job inside 24 h must be held, not run (respawned: $(@($b1[3].respawned).Count))"
  $h1 = @($b1[3].respawnHeld)[0]
  Assert-True ($null -ne $h1 -and $h1.name -eq 'ic-900' -and $h1.jobId -eq 'job-900' -and [int]$h1.attempts -eq 3 -and $h1.parent -eq 'pl-test') "B1: respawnHeld names ic-900 with attempts 3 (got $($b1[3].respawnHeld | ConvertTo-Json -Compress))"
  $e1 = @($b1[3].escalate | Where-Object { $_.name -eq 'ic-900' -and $_.kind -eq 'respawn-loop' })
  Assert-True ($e1.Count -eq 1) 'B1: one respawn-loop escalation for ic-900'
  if ($e1.Count -eq 1) {
    Assert-True ($e1[0].parent -eq 'pl-test') 'B1: the escalation carries the parent'
    Assert-True ($e1[0].detail -match 'job job-900 respawned 3 times since' -and $e1[0].detail -match 'heartbeat: last at' -and $e1[0].detail -match 'respawn held until a heartbeat newer than' -and $e1[0].detail -match 'rotate\.ps1' -and $e1[0].detail -match 'respawn-streak\.json' -and $e1[0].detail -match 'heartbeat stale') "B1: the escalation explains the loop and the ways out (got: $($e1[0].detail))"
  }
  $c1 = @(Get-Calls)
  Assert-True ($c1.Count -eq 3 -and @($c1 | Where-Object { $_ -eq 'claude respawn job-900' }).Count -eq 3) "B1: exactly three claude respawn job-900 calls (calls: $($c1 -join '; '))"
  $ledgerFile = @(Get-ChildItem "$testRoot\state\sentinel\applied" -Filter *.jsonl -ErrorAction SilentlyContinue)
  $ledger = if ($ledgerFile.Count -eq 1) { @(Get-Content $ledgerFile[0].FullName | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() }
  Assert-True ($ledger.Count -eq 4 -and @($ledger[3].respawnHeld).Count -eq 1 -and @($ledger[3].respawnHeld)[0].name -eq 'ic-900') 'B1: the fourth applied ledger line carries respawnHeld'
  Assert-True ($ledger.Count -eq 4 -and @($ledger[0].respawnHeld).Count -eq 0) 'B1: an ordinary ledger line carries an empty respawnHeld'
  $s1 = Read-Streak
  Assert-True ($null -ne $s1 -and @($s1.'ic-900'.attempts).Count -eq 3 -and $s1.'ic-900'.jobId -eq 'job-900' -and "$($s1.'ic-900'.lastReason)" -match 'heartbeat stale') 'B1: the streak file holds the three attempts, the job id and the last reason'

  # B2 clear by heartbeat: a heartbeat newer than the last attempt proves the respawned session ended a turn.
  Reset-Case
  Write-Streak 'job-900' @(30, 20, 10)
  Set-Heartbeat 0
  $b2 = Run-Check -Apply
  Assert-True (@($b2.respawned).Count -eq 0 -and @($b2.respawnHeld).Count -eq 0) 'B2: a fresh heartbeat neither respawns nor holds'
  Assert-True ($null -eq (Read-Streak) -or $null -eq (Read-Streak).PSObject.Properties['ic-900']) 'B2: the clear pass drops the entry once a heartbeat is newer than the last attempt'
  Set-Heartbeat 3
  $b2b = Run-Check -Apply
  Assert-True (@($b2b.respawned).Count -eq 1 -and @($b2b.respawnHeld).Count -eq 0) 'B2: after the heartbeat ages out, the stale session respawns again'
  Assert-True (@((Read-Streak).'ic-900'.attempts).Count -eq 1) 'B2: and the streak restarts at one attempt'

  # B3 clear by job id: a different job id is a relaunched session, not the same loop.
  Reset-Case
  Write-Streak 'job-900' @(30, 20, 10)
  $b3held = Run-Check -Apply
  Assert-True (@($b3held.respawnHeld).Count -eq 1 -and @($b3held.respawned).Count -eq 0) 'B3: control, the old job id is held'
  Set-Roster 'job-901'
  $env:MOCK_ROW_ID = 'job-901'
  $b3 = Run-Check -Apply
  Assert-True (@($b3.respawned).Count -eq 1 -and $b3.respawned[0].jobId -eq 'job-901' -and @($b3.respawnHeld).Count -eq 0) 'B3: a new job id is allowed'
  $s3 = Read-Streak
  Assert-True ($s3.'ic-900'.jobId -eq 'job-901' -and @($s3.'ic-900'.attempts).Count -eq 1) 'B3: the entry follows the new job id with one attempt'

  # B4 window: attempts older than respawnLoopWindowHours do not count and are pruned on write.
  Reset-Case
  Write-Streak 'job-900' @((25 * 60 + 30), (25 * 60 + 20), (25 * 60 + 10))
  $b4 = Run-Check -Apply
  Assert-True (@($b4.respawned).Count -eq 1 -and @($b4.respawnHeld).Count -eq 0) 'B4: three attempts 25 h ago do not hold a respawn'
  Assert-True (@((Read-Streak).'ic-900'.attempts).Count -eq 1) 'B4: the stale attempts are pruned when the entry is written'

  # B5 read-only: held name reports respawnHeld and the escalation; the file is untouched and no ledger line is written.
  Reset-Case
  Write-Streak 'job-900' @(30, 20, 10)
  $before5 = Get-Content $streakPath -Raw
  $b5 = Run-Check
  Assert-True (@($b5.respawnHeld).Count -eq 1 -and @($b5.respawned).Count -eq 0) 'B5: a read-only run reports the hold and proposes no respawn'
  Assert-True (@($b5.escalate | Where-Object { $_.kind -eq 'respawn-loop' -and $_.name -eq 'ic-900' }).Count -eq 1) 'B5: a read-only run escalates respawn-loop'
  Assert-True ((Get-Content $streakPath -Raw) -eq $before5 -and (Get-Calls).Count -eq 0) 'B5: a read-only run writes nothing and runs nothing'

  # B6 corrupt file: fail closed. Every respawn is deferred naming the file; the file is never reset.
  Reset-Case
  Write-Utf8 $streakPath '{oops'
  $b6 = Run-Check -Apply
  Assert-True (@($b6.respawned).Count -eq 0 -and (Get-Calls).Count -eq 0) 'B6: an unreadable streak file respawns nothing'
  Assert-True (@($b6.respawnDeferred | Where-Object { $_.name -eq 'ic-900' -and "$($_.reason)" -match 'respawn-streak\.json unreadable; respawns held until it is fixed or removed' }).Count -eq 1) "B6: the respawn is deferred naming the file (got $($b6.respawnDeferred | ConvertTo-Json -Compress))"
  Assert-True ((Get-Content $streakPath -Raw) -eq '{oops') 'B6: the corrupt file is left exactly as found'
  Assert-True (@($b6.escalate | Where-Object { $_.name -eq 'fleet' -and $_.kind -eq 'respawn-loop' }).Count -eq 1) 'B6: one respawn-loop escalation for fleet'
  Assert-True (@($b6.ok | Where-Object { $_.name -eq 'respawn-streak-read' }).Count -eq 1) 'B6: the read failure is named under ok'
  $b6b = Run-Check
  Assert-True (@($b6b.respawned).Count -eq 0 -and @($b6b.respawnDeferred).Count -eq 1) 'B6: a read-only run defers too'
  # A structurally wrong file (an array, an entry with no attempts list) is unreadable as well.
  foreach ($bad in '[]', 'null', '{"ic-900":{"jobId":"job-900"}}', '{"ic-900":{"jobId":"job-900","attempts":["not a date"]}}') {
    Write-Utf8 $streakPath $bad
    $b6c = Run-Check -Apply
    Assert-True (@($b6c.respawned).Count -eq 0 -and @($b6c.respawnDeferred).Count -eq 1 -and (Get-Content $streakPath -Raw) -eq $bad) "B6: '$bad' is unreadable, fails closed and stays untouched"
  }

  # B7 no-op respawn: respawnFailed (the watchdog's launch-retry feed), never counted as an attempt.
  Reset-Case
  Write-Streak 'job-900' @(30, 20)
  $before7 = Get-Content $streakPath -Raw
  $env:MOCK_RESPAWN_NOOP = '1'
  $b7 = Run-Check -Apply
  Remove-Item Env:MOCK_RESPAWN_NOOP
  Assert-True (@($b7.respawnFailed).Count -eq 1 -and @($b7.respawned).Count -eq 0) 'B7: a no-op respawn is respawn-failed'
  Assert-True ((Get-Content $streakPath -Raw) -eq $before7) 'B7: a failed respawn does not touch the streak file'

  # B8 heal path: -HealRespawn goes through Do-Respawn, so a held name is held there too.
  Reset-Case
  Write-Streak 'job-900' @(30, 20, 10)
  $b8 = Run-Check -Apply -Actor watchdog -Heal 'ic-900'
  Assert-True (@($b8.respawnHeld).Count -eq 1 -and @($b8.respawnHeld)[0].name -eq 'ic-900' -and @($b8.respawned).Count -eq 0 -and (Get-Calls).Count -eq 0) 'B8: a heal respawn of a held name is held, no respawn call'

  if ($script:failures.Count -gt 0) { throw "$($script:failures.Count) respawn-loop assertion(s) failed" }
  Write-Output 'sentinel respawn-loop tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  foreach ($v in 'FLEET_RESPAWN_VERIFY_MS', 'FLEET_RESPAWN_VERIFY_POLL_MS', 'MOCK_ROW_ID', 'MOCK_RESPAWN_NOOP') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-sentinel-loop-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
