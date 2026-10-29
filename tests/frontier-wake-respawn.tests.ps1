$ErrorActionPreference = 'Stop'

# fleet #141: the frontier wake must not treat a respawn as delivery, and must
# not wake a lead for a decision-needed line that lead wrote itself. A focused
# fixture next to watchdog.tests.ps1's W1-W8 so the two failure modes of the
# 2026-09-24 22:32Z tick run in seconds rather than inside the full suite.

# Every case reports in one run: a failure is collected, and the suite throws once at the end.
$script:failures = @()
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { $script:failures += $Message; Write-Output "FAIL: $Message" } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Get-EpochMs { param([datetime]$D) ([DateTimeOffset][datetime]::SpecifyKind($D.ToUniversalTime(), [DateTimeKind]::Utc)).ToUnixTimeMilliseconds() }
function Get-Iso { param([double]$MinutesAgo) (Get-Date).ToUniversalTime().AddMinutes(-$MinutesAgo).ToString('o') }
function ConvertTo-UtcDateTimeTest { param([string]$Iso) [datetime]::Parse($Iso, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-watchdog-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE
$oldFixture = $env:FLEET_GITHUB_ISSUES_FIXTURE

function Set-Heartbeat { param([string]$Name, [double]$AgeMinutes)
  Write-Utf8 "$testRoot\state\heartbeats\$Name.json" (ConvertTo-Json @{ name = $Name; at = (Get-Iso $AgeMinutes) } -Compress)
}
function Set-AgentsRows { param([string]$Json) Write-Utf8 "$testRoot\mock-agents.json" $Json }
function Run-Watchdog { $out = & "$testRoot\bin\watchdog.ps1" -NoToast | Out-String; ($out.Trim() -split "`n")[-1] | ConvertFrom-Json }
function Get-RotateCalls { if (Test-Path "$testRoot\rotate-calls.txt") { @(Get-Content "$testRoot\rotate-calls.txt") } else { @() } }
function Get-TestWake { param($Result) @($Result.frontierWakes | Where-Object { $_.tenant -eq 'test' })[0] }
# Outbox lines in the shape work-state.js appendWakeOutbox writes; $Actor is omitted for a pre-#141 line.
function New-OutboxLine { param([double]$MinutesAgo, [string]$Record, [string]$Wake, [string]$Key, [string]$Actor)
  $line = [ordered]@{ at = (Get-Iso $MinutesAgo); recordId = "test:$Record"; revision = 3; eventSequence = 3; wake = $Wake; idempotencyKey = $Key; evidence = 'fixture' }
  if ($Actor) { $line.actor = $Actor }
  ($line | ConvertTo-Json -Compress)
}
function Set-Outbox { param([string[]]$Lines) Write-Utf8 "$testRoot\state\watch\wake-outbox.jsonl" (($Lines -join "`n") + "`n") }
# The live roster: the lead's door launch (launchedAt) plus $Ics active ICs for the tenant.
function Set-LiveRoster { param([double]$LeadLaunchedMinutesAgo, [int]$Ics)
  $sessions = @([ordered]@{ name = 'pl-test'; role = 'project-lead'; tenant = 'test'; status = 'active'; launchedAt = (Get-Iso $LeadLaunchedMinutesAgo) })
  for ($i = 1; $i -le $Ics; $i++) { $sessions += [ordered]@{ name = "ic-$i"; role = 'ic'; tenant = 'test'; status = 'active'; launchedAt = (Get-Iso 30) } }
  Write-Utf8 "$testRoot\state\roster.json" (([ordered]@{ sessions = $sessions }) | ConvertTo-Json -Depth 5 -Compress)
}
function Reset-Wake { Remove-Item "$testRoot\state\watchdog\frontier-wake.json", "$testRoot\rotate-calls.txt" -ErrorAction SilentlyContinue }

try {
  foreach ($dir in 'bin','tenants','config','state','state/heartbeats','state/sentinel','state/skip','state/watchdog','state/work','state/watch','state/flags','repo','mock-bin','profile') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','identity.js','sentinel-check.ps1','watchdog.ps1','assignment.js','premises.js','work-state.js','exclusions.js','notify.js','assignment-parity.js','triage.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }

  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"sentinel","role":"sentinel","parent":"dispatcher"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"}]}'
  $tenant = [ordered]@{ name = 'test'; repo = "$testRoot\repo"; github = 'owner/repo'; defaultBranch = 'master'; releaseBranch = 'master'; branchPrefix = 'fleet/'; readyLabel = 'ready-for-agent'; maxIcs = 2; ownerLogin = 'cory-owner' }
  Write-Utf8 "$testRoot\tenants\test.json" ($tenant | ConvertTo-Json -Compress)
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  Write-Utf8 "$testRoot\config\cycle.json" '{"supervisor":{"pageKinds":["stray"]},"frontierWake":{"cooldownMinutes":60,"sources":["frontier","outbox"]}}'
  # Live supervision: sentinel-off stands and no Sentinel row runs.
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'fleet #141 fixture'
  & git -C "$testRoot\repo" init --quiet
  $env:FLEET_GITHUB_ISSUES_FIXTURE = "$testRoot\issues-fixture.json"
  Write-Utf8 $env:FLEET_GITHUB_ISSUES_FIXTURE '[]'

  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\bin\rotate.ps1" ('param([string]$Name,[string]$Wake,[switch]$Force,[switch]$DryRun)' + "`r`n" + '[IO.File]::AppendAllText("' + $testRoot.Replace('\', '\\') + '\rotate-calls.txt", "$Name|$Wake`n")' + "`r`n" + 'Write-Output (@{ rotated = @($Name); deferred = @(); outcomes = @(@{ name = $Name; status = "rotated"; reason = $null }) } | ConvertTo-Json -Compress -Depth 6)' + "`r`n" + 'exit 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 2 }

  $dispRow = '{"id":"job-d","name":"dispatcher","state":"working","status":"idle","pid":11,"startedAt":' + (Get-EpochMs (Get-Date).AddHours(-16)) + '}'
  function Set-LeadRow { param([double]$StartedMinutesAgo)
    Set-AgentsRows ('[' + $dispRow + ',{"id":"job-p","name":"pl-test","state":"working","status":"idle","pid":13,"startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-$StartedMinutesAgo)) + '}]')
  }

  # Case R1 (the 22:32Z tick): wakes recorded at T-5m by the watcher, then a
  # `claude respawn` of the idle lead: same job, fresh daemon startedAt (now),
  # launchedAt from the door unchanged at T-4h. IC slots and the cap are full.
  # The respawned process never re-runs its role prompt, so the wakes are still
  # undelivered: the tick must wake it with all three, not report `no slot`.
  Reset-Wake
  Set-LiveRoster -LeadLaunchedMinutesAgo 240 -Ics 2
  Set-LeadRow -StartedMinutesAgo 0
  Set-Outbox @(
    (New-OutboxLine 5 'issue-10' 'checks-settled' 'watch:test:issue-10:r2:aa:review' 'pr-watch'),
    (New-OutboxLine 5 'issue-12' 'checks-settled' 'watch:test:issue-12:r2:bb:review' 'pr-watch'),
    (New-OutboxLine 5 'issue-11' 'decision-needed' 'watch:test:issue-11:r2:cc:escalated' 'pr-watch'))
  $r1 = Run-Watchdog
  $w1 = Get-TestWake $r1
  $ev1 = (@($w1.evidence) -join '; ')
  Assert-True ($r1.mode -eq 'live') "the fixture must run live (got $($r1.mode): $($r1.modeReason))"
  Assert-True ($w1.decision -eq 'woken') "R1: a respawn must not consume undelivered wakes (got $($w1.decision): reason '$($w1.reason)', evidence '$ev1')"
  Assert-True ($ev1 -match 'checks-settled x2' -and $ev1 -match 'decision-needed x1') "R1: the wake must carry every undelivered line (got '$ev1')"
  Assert-True (@(Get-RotateCalls).Count -eq 1) 'R1: exactly one rotate.ps1 -Wake call'

  # Case R2 (control, first launch): a lead launched through the door AFTER the
  # wakes reconstructs from state on its own; the same lines do not wake it.
  Reset-Wake
  Set-LiveRoster -LeadLaunchedMinutesAgo 1 -Ics 2
  Set-LeadRow -StartedMinutesAgo 1
  $r2 = Run-Watchdog
  $w2 = Get-TestWake $r2
  Assert-True ($w2.decision -eq 'none') "R2: a lead launched after the wakes must not be woken for them (got $($w2.decision): $(@($w2.evidence) -join '; '))"

  # Case R3 (no self-wakes): only decision-needed lines the lead itself wrote
  # since the watermark, nothing else waiting. The lead raised them for Cory.
  Reset-Wake
  Set-LiveRoster -LeadLaunchedMinutesAgo 240 -Ics 2
  Set-LeadRow -StartedMinutesAgo 240
  Write-Utf8 "$testRoot\state\watchdog\frontier-wake.json" ('{"tenants":{"test":{"lastAt":"' + (Get-Iso 30) + '","digest":"older","outboxConsumedThrough":"' + (Get-Iso 30) + '"}}}')
  Set-Outbox @(
    (New-OutboxLine 5 'issue-11' 'decision-needed' 'hold:test:issue-11' 'pl-test'),
    (New-OutboxLine 4 'issue-12' 'decision-needed' 'pl-test:12:week-source' 'pl-test'))
  $r3 = Run-Watchdog
  $w3 = Get-TestWake $r3
  Assert-True ($w3.decision -eq 'none') "R3: a lead's own decision-needed lines must not wake it (got $($w3.decision): $(@($w3.evidence) -join '; '))"
  Assert-True (@(Get-RotateCalls).Count -eq 0) 'R3: no rotate.ps1 call for self-wakes'

  # Case R4 (control): the watcher's own decision-needed (closing linkage) still wakes the lead.
  Set-Outbox @(
    (New-OutboxLine 5 'issue-11' 'decision-needed' 'hold:test:issue-11' 'pl-test'),
    (New-OutboxLine 4 'issue-13' 'decision-needed' 'watch:test:issue-13:r2:dd:escalated' 'pr-watch'))
  $r4 = Run-Watchdog
  $w4 = Get-TestWake $r4
  Assert-True ($w4.decision -eq 'woken' -and ((@($w4.evidence) -join '; ') -match 'decision-needed x1')) "R4: the watcher's decision-needed must still wake, and only it counts (got $($w4.decision): $(@($w4.evidence) -join '; '))"

  # Case R5 (control): a pre-#141 line carries no actor; unknown provenance still wakes (fail toward delivery).
  Reset-Wake
  Write-Utf8 "$testRoot\state\watchdog\frontier-wake.json" ('{"tenants":{"test":{"lastAt":"' + (Get-Iso 30) + '","digest":"older","outboxConsumedThrough":"' + (Get-Iso 30) + '"}}}')
  Set-Outbox @((New-OutboxLine 5 'issue-14' 'decision-needed' 'escalate-14-misspec' ''))
  $r5 = Run-Watchdog
  $w5 = Get-TestWake $r5
  Assert-True ($w5.decision -eq 'woken') "R5: a decision-needed line with no actor must still wake (got $($w5.decision): $($w5.reason))"

  # ===== fleet #231: the cooldown is keyed on the digest TEXT, so a second PR settling
  # inside the hour reads as "already woken". Every case below runs with full IC slots
  # (the frontier source reports `no slot` and contributes nothing) unless it says otherwise,
  # so the digest is exactly the outbox kind counts.
  function Get-WakeState { (Get-Content "$testRoot\state\watchdog\frontier-wake.json" -Raw | ConvertFrom-Json).tenants.test }
  function Set-WakeState { param([string]$Json) Write-Utf8 "$testRoot\state\watchdog\frontier-wake.json" ('{"tenants":{"test":' + $Json + '}}') }
  function Get-WakeStateJson { param([double]$LastAtMinutesAgo, [string]$Digest, [double]$ConsumedMinutesAgo, [string]$Extra = '')
    '{"lastAt":"' + (Get-Iso $LastAtMinutesAgo) + '","digest":' + ($Digest | ConvertTo-Json) + ',"outboxConsumedThrough":"' + (Get-Iso $ConsumedMinutesAgo) + '"' + $Extra + '}'
  }

  # Case C1 (#231 AC1, red today): PR A's checks-settled wakes the lead; PR B's checks-settled line,
  # recorded 10 minutes after that wake, must wake the lead on the next tick. The digest text is the
  # same (`outbox checks-settled x1`) but the line is new by identity (record id + event sequence),
  # and by construction newer than outboxConsumedThrough.
  Reset-Wake
  Set-LiveRoster -LeadLaunchedMinutesAgo 240 -Ics 2
  Set-LeadRow -StartedMinutesAgo 240
  Set-Outbox @((New-OutboxLine 30 'issue-20' 'checks-settled' 'watch:test:issue-20:r2:aa:review' 'pr-watch'))
  $c1a = Run-Watchdog
  $w1a = Get-TestWake $c1a
  Assert-True ($w1a.decision -eq 'woken' -and ((@($w1a.evidence) -join '; ') -eq 'outbox checks-settled x1')) "C1a: PR A's checks-settled must wake the lead (got $($w1a.decision): $(@($w1a.evidence) -join '; '))"
  $s1a = Get-WakeState
  Assert-True ("$($s1a.digest)" -eq 'outbox checks-settled x1' -and $s1a.lastAt -and $s1a.outboxConsumedThrough) "C1a: the wake state must record the wake (got $($s1a | ConvertTo-Json -Compress))"
  # Move the clock: that wake was 10 minutes ago (inside the 60-minute window). The digest is the one
  # the wake itself stored; only the two stamps are shifted. Then PR B settles 5 minutes ago.
  Set-WakeState ((($s1a | ConvertTo-Json -Compress) | ConvertFrom-Json | ForEach-Object { $_.lastAt = (Get-Iso 10); $_.outboxConsumedThrough = (Get-Iso 10); $_ } | ConvertTo-Json -Compress))
  Set-Outbox @(
    (New-OutboxLine 30 'issue-20' 'checks-settled' 'watch:test:issue-20:r2:aa:review' 'pr-watch'),
    (New-OutboxLine 5 'issue-21' 'checks-settled' 'watch:test:issue-21:r2:bb:review' 'pr-watch'))
  $callsBeforeC1 = @(Get-RotateCalls).Count
  $c1b = Run-Watchdog
  $w1b = Get-TestWake $c1b
  Assert-True ($w1b.decision -eq 'woken') "C1b: a checks-settled line for PR B, 10 minutes after PR A's wake, must wake the lead (got $($w1b.decision): '$($w1b.reason)')"
  Assert-True (@(Get-RotateCalls).Count -eq $callsBeforeC1 + 1) "C1b: exactly one more rotate.ps1 -Wake call (got $(@(Get-RotateCalls).Count - $callsBeforeC1))"
  $s1b = Get-WakeState
  Assert-True ($s1b.outboxConsumedThrough -and ((ConvertTo-UtcDateTimeTest $s1b.outboxConsumedThrough) -gt (Get-Date).ToUniversalTime().AddMinutes(-6))) "C1b: the watermark must advance past PR B's line at T-5m (got $($s1b.outboxConsumedThrough))"

  # Case C2 (#231 AC2, control, green today and after): the SAME unconsumed line seen again inside the
  # window (the last wake did not clear it: the watermark predates the line) stays deferred as `cooldown`.
  # C2a is a pre-#231 state (lastAt/digest/outboxConsumedThrough only): the fix must read it as before.
  Reset-Wake
  Set-Outbox @((New-OutboxLine 20 'issue-20' 'checks-settled' 'watch:test:issue-20:r2:aa:review' 'pr-watch'))
  Set-WakeState (Get-WakeStateJson -LastAtMinutesAgo 10 -Digest 'outbox checks-settled x1' -ConsumedMinutesAgo 30)
  $callsBeforeC2 = @(Get-RotateCalls).Count
  $c2a = Run-Watchdog
  $w2a = Get-TestWake $c2a
  Assert-True ($w2a.decision -eq 'cooldown') "C2a: the same unconsumed line inside the window stays deferred under a pre-#231 state (got $($w2a.decision): '$($w2a.reason)')"
  Assert-True (@(Get-RotateCalls).Count -eq $callsBeforeC2) 'C2a: no rotate.ps1 call inside the cooldown'
  # C2b: the same line, with the state also naming what the last wake delivered by identity
  # (the #231 shape: `delivered` = record id + event sequence of every outbox line it carried).
  Set-WakeState (Get-WakeStateJson -LastAtMinutesAgo 10 -Digest 'outbox checks-settled x1' -ConsumedMinutesAgo 30 -Extra ',"delivered":["test:issue-20#3"],"frontierIssues":[]')
  $c2b = Run-Watchdog
  $w2b = Get-TestWake $c2b
  Assert-True ($w2b.decision -eq 'cooldown') "C2b: a line the last wake delivered by identity stays deferred (got $($w2b.decision): '$($w2b.reason)')"
  Assert-True (@(Get-RotateCalls).Count -eq $callsBeforeC2) 'C2b: no rotate.ps1 call inside the cooldown'

  # Case C3 (#231, the live 2026-09-30T00:32Z shape, red today): a wake carried
  # `frontier #501; outbox checks-settled x1`. The frontier issue is still eligible (the lead has not
  # assigned it yet) and a DIFFERENT PR settles: same text, new evidence -> must wake.
  Reset-Wake
  Set-LiveRoster -LeadLaunchedMinutesAgo 240 -Ics 1
  Write-Utf8 $env:FLEET_GITHUB_ISSUES_FIXTURE '[{"number":501,"title":"Ready","url":"https://github.com/owner/repo/issues/501","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  Set-Outbox @((New-OutboxLine 30 'issue-20' 'checks-settled' 'watch:test:issue-20:r2:aa:review' 'pr-watch'))
  $c3a = Run-Watchdog
  $w3a = Get-TestWake $c3a
  Assert-True ($w3a.decision -eq 'woken' -and ((@($w3a.evidence) -join '; ') -eq 'frontier #501; outbox checks-settled x1')) "C3a: the mixed wake must fire (got $($w3a.decision): $(@($w3a.evidence) -join '; '))"
  $s3a = Get-WakeState
  Set-WakeState ((($s3a | ConvertTo-Json -Compress) | ConvertFrom-Json | ForEach-Object { $_.lastAt = (Get-Iso 10); $_.outboxConsumedThrough = (Get-Iso 10); $_ } | ConvertTo-Json -Compress))
  Set-Outbox @(
    (New-OutboxLine 30 'issue-20' 'checks-settled' 'watch:test:issue-20:r2:aa:review' 'pr-watch'),
    (New-OutboxLine 5 'issue-21' 'checks-settled' 'watch:test:issue-21:r2:bb:review' 'pr-watch'))
  $callsBeforeC3 = @(Get-RotateCalls).Count
  $c3b = Run-Watchdog
  $w3b = Get-TestWake $c3b
  Assert-True ($w3b.decision -eq 'woken') "C3b: a new PR's line beside an unchanged frontier issue must wake (got $($w3b.decision): '$($w3b.reason)')"
  Assert-True (@(Get-RotateCalls).Count -eq $callsBeforeC3 + 1) 'C3b: exactly one more rotate.ps1 -Wake call'

  # Case C4 (#231 ruling, the reverse of C3, red today): after that mixed wake the outbox part is
  # consumed and the frontier part is unchanged. The digest text now differs (`frontier #501` alone),
  # but every item of evidence was already carried by the last wake -> cooldown, not a second rotation.
  Set-WakeState ((($s3a | ConvertTo-Json -Compress) | ConvertFrom-Json | ForEach-Object { $_.lastAt = (Get-Iso 10); $_.outboxConsumedThrough = (Get-Iso 10); $_ } | ConvertTo-Json -Compress))
  Set-Outbox @((New-OutboxLine 30 'issue-20' 'checks-settled' 'watch:test:issue-20:r2:aa:review' 'pr-watch'))
  $callsBeforeC4 = @(Get-RotateCalls).Count
  $c4 = Run-Watchdog
  $w4c = Get-TestWake $c4
  Assert-True ($w4c.decision -eq 'cooldown') "C4: a frontier issue the last wake already carried must not wake again inside the window (got $($w4c.decision): evidence '$(@($w4c.evidence) -join '; ')')"
  Assert-True (@(Get-RotateCalls).Count -eq $callsBeforeC4) 'C4: no rotate.ps1 call for already-carried frontier evidence'
  Write-Utf8 $env:FLEET_GITHUB_ISSUES_FIXTURE '[]'

  # Case C5 (#231 QA): a frontier-only wake leaves the watermark where it was, so an outbox line written before
  # the lead's launch (which the wake's -Since excludes) stays "unconsumed" for fleet-dead's Test-WorkWaiting.
  # The watermark must also advance to the lead's launch: with all heartbeats stale and nothing else waiting,
  # the tick reads idle, not fleet-dead.
  Reset-Wake
  Set-LiveRoster -LeadLaunchedMinutesAgo 60 -Ics 1
  Set-LeadRow -StartedMinutesAgo 60
  Write-Utf8 $env:FLEET_GITHUB_ISSUES_FIXTURE '[{"number":501,"title":"Ready","url":"https://github.com/owner/repo/issues/501","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  Set-Outbox @((New-OutboxLine 120 'issue-20' 'checks-settled' 'watch:test:issue-20:r2:aa:review' 'pr-watch'))
  Set-WakeState (Get-WakeStateJson -LastAtMinutesAgo 240 -Digest 'older' -ConsumedMinutesAgo 180)
  $c5a = Run-Watchdog
  $w5a = Get-TestWake $c5a
  Assert-True ($w5a.decision -eq 'woken' -and ((@($w5a.evidence) -join '; ') -eq 'frontier #501')) "C5a: the frontier-only wake must fire (got $($w5a.decision): $(@($w5a.evidence) -join '; '))"
  Write-Utf8 $env:FLEET_GITHUB_ISSUES_FIXTURE '[]'
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 300 }
  $c5b = Run-Watchdog
  Assert-True ($c5b.idle -eq $true -and -not (@($c5b.conditions) -contains 'fleet-dead')) "C5b: a pre-launch outbox line must not read as work waiting after a frontier-only wake (idle=$($c5b.idle) conditions=$(@($c5b.conditions) -join ','))"
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 2 }

  # ===== fleet #311: an outbox line the lead cannot act on is not a wake. checks-settled counts only while its
  # record is in `review`; any checks-* line whose record has left a readable active.json is dropped; checks-failed
  # is otherwise never filtered; an unreadable or missing active.json filters nothing; resolution and
  # decision-needed are never filtered. The same predicate feeds fleet-dead's work-waiting (case N7).
  function Set-Active { param([string]$Json) Write-Utf8 "$testRoot\state\work\active.json" $Json }
  function Get-ActiveJson { param([string]$Id, [int]$Issue, [string]$State) '{"schemaVersion":1,"records":{"test:' + $Id + '":{"tenant":"test","issue":' + $Issue + ',"state":"' + $State + '"}}}' }
  function Start-WakeCase { param([int]$Ics = 2, [double]$LeadMinutes = 240)
    Reset-Wake
    Set-LiveRoster -LeadLaunchedMinutesAgo $LeadMinutes -Ics $Ics
    Set-LeadRow -StartedMinutesAgo $LeadMinutes
  }

  # N1: checks-settled while the record is in ci-wait (a newer head walked it back) -> no wake.
  Start-WakeCase
  Set-Active (Get-ActiveJson 'issue-30' 30 'ci-wait')
  Set-Outbox @((New-OutboxLine 5 'issue-30' 'checks-settled' 'watch:test:issue-30:r2:aa:review' 'pr-watch'))
  $n1 = Run-Watchdog; $wn1 = Get-TestWake $n1
  Assert-True ($wn1.decision -eq 'none') "N1: a checks-settled line whose record is in ci-wait must not wake (got $($wn1.decision): $(@($wn1.evidence) -join '; '))"
  Assert-True (@(Get-RotateCalls).Count -eq 0) 'N1: no rotate.ps1 call'

  # N2: the same line with the record in review -> woken, and the rotate call names the record.
  Start-WakeCase
  Set-Active (Get-ActiveJson 'issue-30' 30 'review')
  $n2 = Run-Watchdog; $wn2 = Get-TestWake $n2
  Assert-True ($wn2.decision -eq 'woken' -and ((@($wn2.evidence) -join '; ') -eq 'outbox checks-settled x1')) "N2: a checks-settled line whose record is in review must wake (got $($wn2.decision): $(@($wn2.evidence) -join '; '))"
  $calls2 = @(Get-RotateCalls)
  Assert-True ($calls2.Count -eq 1 -and ($calls2[0] -match '\[records: checks-settled test:issue-30\]$')) "N2: the rotate call must carry '[records: checks-settled test:issue-30]' (got '$($calls2 -join ' / ')')"
  Assert-True ((Get-WakeState).digest -eq 'outbox checks-settled x1') "N2: the stored digest (and so the cooldown) stays counts-only (got '$((Get-WakeState).digest)')"

  # N3: checks-failed is never filtered: an idle IC does not watch its own CI, so the lead's wake is what reaches it.
  # Even with an active ic-<issue> row for the record's issue (ic-1, rostered by Start-WakeCase), it wakes.
  Start-WakeCase
  Set-Active (Get-ActiveJson 'issue-1' 1 'ci-wait')
  Set-Outbox @((New-OutboxLine 5 'issue-1' 'checks-failed' 'watch:test:issue-1:r2:cc:implementing' 'pr-watch'))
  $n3 = Run-Watchdog; $wn3 = Get-TestWake $n3
  Assert-True ($wn3.decision -eq 'woken' -and ((@($wn3.evidence) -join '; ') -eq 'outbox checks-failed x1')) "N3: checks-failed must wake even with an active IC on the issue (got $($wn3.decision): $(@($wn3.evidence) -join '; '))"
  $calls3 = @(Get-RotateCalls)
  Assert-True ($calls3.Count -eq 1 -and ($calls3[0] -match '\[records: checks-failed test:issue-1\]$')) "N3: the rotate call must carry '[records: checks-failed test:issue-1]' (got '$($calls3 -join ' / ')')"

  # N4: checks-failed with no IC on the issue (ic-5 not rostered) -> woken, record named.
  Start-WakeCase
  Set-Active (Get-ActiveJson 'issue-5' 5 'ci-wait')
  Set-Outbox @((New-OutboxLine 5 'issue-5' 'checks-failed' 'watch:test:issue-5:r2:dd:implementing' 'pr-watch'))
  $n4 = Run-Watchdog; $wn4 = Get-TestWake $n4
  Assert-True ($wn4.decision -eq 'woken' -and ((@($wn4.evidence) -join '; ') -eq 'outbox checks-failed x1')) "N4: checks-failed with no active IC must wake (got $($wn4.decision): $(@($wn4.evidence) -join '; '))"
  $calls4 = @(Get-RotateCalls)
  Assert-True ($calls4.Count -eq 1 -and ($calls4[0] -match '\[records: checks-failed test:issue-5\]$')) "N4: the rotate call must carry '[records: checks-failed test:issue-5]' (got '$($calls4 -join ' / ')')"

  # N5: a checks-* line whose record is absent from a READABLE active.json (merged or abandoned) is not a wake,
  # whether the file holds other records (N5) or none (N5b).
  Start-WakeCase
  Set-Active (Get-ActiveJson 'issue-99' 99 'review')
  Set-Outbox @(
    (New-OutboxLine 5 'issue-40' 'checks-settled' 'watch:test:issue-40:r2:ee:review' 'pr-watch'),
    (New-OutboxLine 4 'issue-41' 'checks-failed' 'watch:test:issue-41:r2:ff:implementing' 'pr-watch'))
  $n5 = Run-Watchdog; $wn5 = Get-TestWake $n5
  Assert-True ($wn5.decision -eq 'none') "N5: checks-settled and checks-failed lines for records absent from active.json must not wake (got $($wn5.decision): $(@($wn5.evidence) -join '; '))"
  Assert-True (@(Get-RotateCalls).Count -eq 0) 'N5: no rotate.ps1 call'
  Start-WakeCase
  Set-Active '{"schemaVersion":1,"records":{}}'
  $n5b = Run-Watchdog; $wn5b = Get-TestWake $n5b
  Assert-True ($wn5b.decision -eq 'none') "N5b: the same lines against an empty (readable) active.json must not wake (got $($wn5b.decision): $(@($wn5b.evidence) -join '; '))"

  # N5c: resolution and decision-needed lines are never filtered by record presence: both wake for absent records,
  # and only they are counted and named beside the dropped checks-* lines.
  Start-WakeCase
  Set-Active (Get-ActiveJson 'issue-99' 99 'review')
  $resolutionLine = ([ordered]@{ at = (Get-Iso 3); recordId = 'test:issue-42'; revision = 6; eventSequence = 6; wake = 'resolution'; idempotencyKey = 'k-issue-42:resolution'; actor = 'cory'; from = 'escalated'; to = 'revision'; raisedBy = 'pl-test'; evidence = 'Cory ruled' } | ConvertTo-Json -Compress)
  Set-Outbox @(
    (New-OutboxLine 5 'issue-40' 'checks-settled' 'watch:test:issue-40:r2:ee:review' 'pr-watch'),
    (New-OutboxLine 4 'issue-41' 'checks-failed' 'watch:test:issue-41:r2:ff:implementing' 'pr-watch'),
    $resolutionLine,
    (New-OutboxLine 2 'issue-43' 'decision-needed' 'watch:test:issue-43:r2:gg:escalated' 'pr-watch'))
  $n5c = Run-Watchdog; $wn5c = Get-TestWake $n5c
  $ev5c = (@($wn5c.evidence) -join '; ')
  Assert-True ($wn5c.decision -eq 'woken' -and $ev5c -match 'outbox decision-needed x1, resolution x1|outbox resolution x1, decision-needed x1' -and $ev5c -notmatch 'checks-') "N5c: resolution and decision-needed lines for absent records must wake, without the checks-* lines (got $($wn5c.decision): $ev5c)"
  $calls5c = @(Get-RotateCalls)
  Assert-True ($calls5c.Count -eq 1 -and ($calls5c[0] -match '\[records: resolution test:issue-42; decision-needed test:issue-43\]$')) "N5c: the rotate call must name only the resolution and decision-needed records (got '$($calls5c -join ' / ')')"

  # N6: no active.json at all filters nothing (fail toward delivering).
  Start-WakeCase
  Remove-Item "$testRoot\state\work\active.json" -ErrorAction SilentlyContinue
  Set-Outbox @((New-OutboxLine 5 'issue-30' 'checks-settled' 'watch:test:issue-30:r2:aa:review' 'pr-watch'))
  $n6 = Run-Watchdog; $wn6 = Get-TestWake $n6
  Assert-True ($wn6.decision -eq 'woken') "N6: a missing active.json must not filter the line (got $($wn6.decision): $($wn6.reason))"

  # N7 (fleet-dead): every static heartbeat stale, a `hold` record (never waiting by itself) in active.json, and a
  # checks-failed line for a record that has left active.json. The line is not work waiting -> an idle tick. N7b is
  # the control: the same line for the `hold` record that IS in active.json still counts -> fleet-dead.
  # The lead was launched after the line, so the frontier wake (bounded by that launch) stays out of it.
  Start-WakeCase -Ics 1 -LeadMinutes 1; Set-LeadRow -StartedMinutesAgo 240   # door launch recent, daemon row old: not "freshly launched" for staleness
  Set-Active (Get-ActiveJson 'issue-1' 1 'hold')
  Set-Outbox @((New-OutboxLine 5 'issue-50' 'checks-failed' 'watch:test:issue-50:r2:cc:implementing' 'pr-watch'))
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 300 }
  # A hold record is an active record, so the PR watcher's health file must be fresh; earlier stale-heartbeat ticks
  # left respawn attempts that would trip launch-retry, so clear them before each tick.
  Write-Utf8 "$testRoot\state\watch\health.json" ('{"at":"' + (Get-Iso 0) + '","ok":true}')
  Remove-Item "$testRoot\state\watchdog\paged.json", "$testRoot\state\watchdog\respawn-failed.json" -ErrorAction SilentlyContinue
  $n7 = Run-Watchdog
  Assert-True ($n7.idle -eq $true -and -not (@($n7.conditions) -contains 'fleet-dead')) "N7: a checks-failed line for a record absent from active.json must not read as work waiting (idle=$($n7.idle) conditions=$(@($n7.conditions) -join ','))"
  Start-WakeCase -Ics 1 -LeadMinutes 1; Set-LeadRow -StartedMinutesAgo 240
  Set-Outbox @((New-OutboxLine 5 'issue-1' 'checks-failed' 'watch:test:issue-1:r2:cc:implementing' 'pr-watch'))
  Write-Utf8 "$testRoot\state\watch\health.json" ('{"at":"' + (Get-Iso 0) + '","ok":true}')
  Remove-Item "$testRoot\state\watchdog\paged.json", "$testRoot\state\watchdog\respawn-failed.json" -ErrorAction SilentlyContinue
  $n7b = Run-Watchdog
  Assert-True (@($n7b.conditions) -contains 'fleet-dead') "N7b: the same line for a record still in active.json is work waiting (idle=$($n7b.idle) conditions=$(@($n7b.conditions) -join ','))"
  Remove-Item "$testRoot\state\work\active.json", "$testRoot\state\watch\health.json", "$testRoot\state\watchdog\paged.json", "$testRoot\state\watchdog\respawn-failed.json" -ErrorAction SilentlyContinue
  foreach ($n in 'dispatcher','pl-test') { Set-Heartbeat $n 2 }

  # ===== fleet #341: a lead that ended blocked on Cory and whose process was reaped (daemon row kept: state
  # blocked, status blank, no pid). Cory answers through the door and a resolution line lands. The respawn
  # escalates blocked, the heal refuses on needs and launchNeeded sees the job, so the wake must rotate it.
  function Set-ReapedLeadRow { param([string]$State)
    Set-AgentsRows ('[' + $dispRow + ',{"id":"job-p","name":"pl-test","state":"' + $State + '","status":"","startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-240)) + '}]')
    [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-p") | Out-Null
    Write-Utf8 "$testRoot\profile\.claude\jobs\job-p\state.json" '{"needs":"Cory: grant the budget extension for #2604"}'
  }
  $resolution341 = ([ordered]@{ at = (Get-Iso 3); recordId = 'test:issue-2604'; revision = 7; eventSequence = 7; wake = 'resolution'; idempotencyKey = 'cory-2604-r7:resolution'; actor = 'cory'; from = 'escalated'; to = 'implementing'; raisedBy = 'pl-test'; evidence = 'budget extended' } | ConvertTo-Json -Compress)

  # B1: the resolution wakes the reaped blocked lead.
  Start-WakeCase
  Set-ReapedLeadRow 'blocked'
  Set-Outbox @($resolution341)
  $b1 = Run-Watchdog; $wb1 = Get-TestWake $b1
  Assert-True ($wb1.decision -eq 'woken') "B1: a resolution must wake a blocked lead whose process was reaped (got $($wb1.decision): reason '$($wb1.reason)', evidence '$(@($wb1.evidence) -join '; ')')"
  Assert-True (@(Get-RotateCalls).Count -eq 1) "B1: exactly one rotate.ps1 -Wake call (got $(@(Get-RotateCalls).Count))"

  # B2 (control): nothing to wake for leaves the reaped blocked lead alone; it is still waiting on Cory.
  Start-WakeCase
  Set-ReapedLeadRow 'blocked'
  Set-Outbox @()
  $b2 = Run-Watchdog; $wb2 = Get-TestWake $b2
  Assert-True ($wb2.decision -eq 'none' -and @(Get-RotateCalls).Count -eq 0) "B2: a reaped blocked lead with no evidence must not be woken (got $($wb2.decision): $($wb2.reason))"

  # B3 (control): any other pid-less state is sentinel-check's respawn, not a wake target.
  Start-WakeCase
  Set-ReapedLeadRow 'done'
  Set-Outbox @($resolution341)
  $b3 = Run-Watchdog; $wb3 = Get-TestWake $b3
  Assert-True ($wb3.decision -eq 'none' -and "$($wb3.reason)" -match 'no running lead session' -and @(Get-RotateCalls).Count -eq 0) "B3: a pid-less done lead is respawned, never rotated by the wake (got $($wb3.decision): $($wb3.reason))"

  # B4 (control): the newest pid-less row decides, as sentinel-check's Latest-Row does. An older leftover blocked
  # row behind a newer pid-less done row is the respawn's, never a wake target.
  Start-WakeCase
  Set-ReapedLeadRow 'blocked'
  Set-AgentsRows ('[' + $dispRow + ',{"id":"job-p","name":"pl-test","state":"blocked","status":"","startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-240)) + '},{"id":"job-p2","name":"pl-test","state":"done","status":"","startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-60)) + '}]')
  Set-Outbox @($resolution341)
  $b4 = Run-Watchdog; $wb4 = Get-TestWake $b4
  Assert-True ($wb4.decision -eq 'none' -and @(Get-RotateCalls).Count -eq 0) "B4: an older blocked row behind a newer pid-less done row must not be woken (got $($wb4.decision): $($wb4.reason))"
  Remove-Item "$testRoot\profile\.claude\jobs\job-p" -Recurse -ErrorAction SilentlyContinue

  # ===== fleet #346: a Stall (an IC owed work, at a turn boundary, no turn for 2 h) wakes the lead; one that
  # outlasts the wake by 2 h more files one `stall` escalation (and page). Config defaults: 120 / 120.
  function Get-StallEscalations { @(Get-ChildItem "$testRoot\state\escalations" -Filter *-stall.json -ErrorAction SilentlyContinue) }
  function Set-StallCase { param([double]$HbMin = 130, [double]$UpdatedMin = 200, [string]$State = 'implementing', [string]$IcStatus = 'idle', [string]$IcState = 'working', [int]$IcPid = 14)
    Start-WakeCase
    Set-Outbox @()
    Remove-Item "$testRoot\state\PAUSE", "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
    Remove-Item "$testRoot\state\escalations\*" -ErrorAction SilentlyContinue
    $pidField = if ($IcPid) { ',"pid":' + $IcPid } else { '' }
    Set-AgentsRows ('[' + $dispRow + ',{"id":"job-p","name":"pl-test","state":"working","status":"idle","pid":13,"startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-240)) + '},{"id":"job-i","name":"ic-1","state":"' + $IcState + '","status":"' + $IcStatus + '"' + $pidField + ',"startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-300)) + '}]')
    [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-i") | Out-Null
    Write-Utf8 "$testRoot\profile\.claude\jobs\job-i\state.json" '{}'
    Set-Heartbeat 'ic-1' $HbMin
    Set-Active ('{"schemaVersion":1,"records":{"test:issue-1":{"tenant":"test","issue":1,"state":"' + $State + '","updatedAt":"' + (Get-Iso $UpdatedMin) + '"}}}')
  }
  # The identity the watchdog derives: the record id plus the later of the heartbeat and the record's updatedAt (here the heartbeat).
  function Get-StallId { 'stall:test:issue-1:' + (ConvertTo-UtcDateTimeTest (Get-Content "$testRoot\state\heartbeats\ic-1.json" -Raw | ConvertFrom-Json).at).ToString('o') }
  function Set-StallDelivered { param([double]$MinutesAgo) Write-Utf8 "$testRoot\state\watchdog\frontier-wake.json" ('{"tenants":{},"stalls":{"' + (Get-StallId) + '":{"deliveredAt":"' + (Get-Iso $MinutesAgo) + '"}}}') }
  $stallRecord = 'test:issue-1'

  # T1: heartbeat 130 min old, record unchanged for 200: wakes the idle lead with the stall evidence, one rotate call.
  Set-StallCase
  $t1 = Run-Watchdog; $wt1 = Get-TestWake $t1
  Assert-True ($wt1.decision -eq 'woken' -and ((@($wt1.evidence) -join '; ') -match "stall ic-1 \($stallRecord implementing, no turn since ")) "T1: a stalled IC must wake the lead with stall evidence (got $($wt1.decision): '$($wt1.reason)' '$(@($wt1.evidence) -join '; ')')"
  Assert-True (@(Get-RotateCalls).Count -eq 1) "T1: exactly one rotate.ps1 call (got $(@(Get-RotateCalls).Count))"
  $st1 = @($t1.stalls)[0]
  Assert-True ($st1.ic -eq 'ic-1' -and $st1.recordId -eq $stallRecord -and $st1.state -eq 'implementing' -and $st1.since -and $st1.outcome -eq 'woken') "T1: the tick line must carry the stall with outcome woken (got $($t1.stalls | ConvertTo-Json -Compress))"
  Assert-True ((Get-StallEscalations).Count -eq 0) 'T1: no escalation yet'
  $t1b = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq 1 -and @($t1b.stalls)[0].outcome -ne 'woken') 'T1: the same identity is not woken twice'

  # T2: not stalled.
  foreach ($case in @(
    @{ n = 'heartbeat 100 min old'; a = @{ HbMin = 100 } },
    @{ n = 'record changed 30 min ago'; a = @{ UpdatedMin = 30 } },
    @{ n = 'record in escalated'; a = @{ State = 'escalated' } },
    @{ n = 'record in hold'; a = @{ State = 'hold' } },
    @{ n = 'record in ci-wait'; a = @{ State = 'ci-wait' } },
    @{ n = 'record in review'; a = @{ State = 'review' } },
    @{ n = 'IC mid-turn'; a = @{ IcStatus = 'busy' } })) {
    $splat = $case.a; Set-StallCase @splat
    $t2 = Run-Watchdog; $wt2 = Get-TestWake $t2
    Assert-True ($wt2.decision -eq 'none' -and @($t2.stalls).Count -eq 0 -and @(Get-RotateCalls).Count -eq 0) "T2: $($case.n) is not a stall (got $($wt2.decision): '$(@($wt2.evidence) -join '; ')')"
  }
  Set-StallCase
  Write-Utf8 "$testRoot\state\PAUSE" 'fixture'
  $t2p = Run-Watchdog
  Assert-True (@($t2p.stalls).Count -eq 0 -and @(Get-RotateCalls).Count -eq 0 -and (Get-StallEscalations).Count -eq 0) 'T2: no stall is evaluated while paused'
  Remove-Item "$testRoot\state\PAUSE"

  # T2b: a reaped IC (no pid, state done) is at a turn boundary.
  Set-StallCase -IcStatus '' -IcState 'done' -IcPid 0
  $t2b = Run-Watchdog; $wt2b = Get-TestWake $t2b
  Assert-True ($wt2b.decision -eq 'woken' -and ((@($wt2b.evidence) -join '; ') -match 'stall ic-1')) "T2b: a reaped IC on an implementing record is a stall (got $($wt2b.decision): '$($wt2b.reason)')"

  # T3: a wake delivered 121 min ago for this identity: one stall escalation, none on the next tick, no second wake.
  Set-StallCase
  Set-StallDelivered 121
  $t3b = Run-Watchdog
  Assert-True ((Get-StallEscalations).Count -eq 1) "T3: 121 min after the wake, exactly one stall escalation (got $((Get-StallEscalations).Count))"
  Assert-True (@($t3b.stalls)[0].outcome -eq 'escalated' -and @(Get-RotateCalls).Count -eq 0) "T3: outcome escalated and no second wake (got $(@($t3b.stalls)[0].outcome), $(@(Get-RotateCalls).Count) rotates)"
  $esc = Get-Content (Get-StallEscalations)[0].FullName -Raw | ConvertFrom-Json
  Assert-True ($esc.name -eq 'ic-1' -and $esc.detail -match 'ic-1' -and $esc.detail -match $stallRecord -and $esc.detail -match '\d+ min') "T3: the escalation names the IC, the record and the idle time (got $($esc.detail))"
  $null = Run-Watchdog
  Assert-True ((Get-StallEscalations).Count -eq 1) 'T3: the next tick files none'

  # T3c: 119 min after the wake is too early.
  Set-StallCase
  Set-StallDelivered 119
  $null = Run-Watchdog
  Assert-True ((Get-StallEscalations).Count -eq 0) 'T3c: 119 min after the wake files no escalation'

  # T4: the lead was never idle (mid-turn): a stall 241 min old files the escalation; 200 min does not.
  function Set-BusyLead { Set-AgentsRows ('[' + $dispRow + ',{"id":"job-p","name":"pl-test","state":"working","status":"busy","pid":13,"startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-240)) + '},{"id":"job-i","name":"ic-1","state":"working","status":"idle","pid":14,"startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-300)) + '}]')
    [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-p") | Out-Null
    Write-Utf8 "$testRoot\profile\.claude\jobs\job-p\state.json" '{}' }
  Set-StallCase -HbMin 241 -UpdatedMin 300
  Set-BusyLead
  $null = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq 0 -and (Get-StallEscalations).Count -eq 1) "T4: a never-woken stall 241 min old files one escalation (got $((Get-StallEscalations).Count))"
  Set-StallCase -HbMin 200 -UpdatedMin 300
  Set-BusyLead
  $null = Run-Watchdog
  Assert-True ((Get-StallEscalations).Count -eq 0) 'T4: a never-woken stall 200 min old files none'
  Remove-Item "$testRoot\profile\.claude\jobs\job-p" -Recurse -ErrorAction SilentlyContinue

  # T5: a newer heartbeat clears the stall: no evidence, no escalation (even with an old delivery recorded).
  Set-StallCase
  Set-StallDelivered 300
  Set-Heartbeat 'ic-1' 5
  $t5 = Run-Watchdog; $wt5 = Get-TestWake $t5
  Assert-True (@($t5.stalls).Count -eq 0 -and $wt5.decision -eq 'none' -and (Get-StallEscalations).Count -eq 0) "T5: a newer heartbeat must clear the stall (got $($wt5.decision), $(@($t5.stalls).Count) stalls)"
  Assert-True (-not ((Get-Content "$testRoot\state\watchdog\frontier-wake.json" -Raw) -match 'stall:')) 'T5: the cleared stall entry is pruned from frontier-wake.json'

  # T6: frontier-wake-off stops the wake but not the safety net: no rotate, exactly one stall escalation at threshold + delay.
  Set-StallCase -HbMin 241 -UpdatedMin 300
  Write-Utf8 "$testRoot\state\flags\frontier-wake-off" 'fixture'
  $t6 = Run-Watchdog
  Assert-True (@(Get-RotateCalls).Count -eq 0 -and (Get-StallEscalations).Count -eq 1 -and @($t6.stalls).Count -eq 1) "T6: frontier-wake-off, stall 241 min old: no rotate and one escalation (got $(@(Get-RotateCalls).Count) rotates, $((Get-StallEscalations).Count) escalations)"
  $null = Run-Watchdog
  Assert-True ((Get-StallEscalations).Count -eq 1) 'T6: the next tick files none'
  Remove-Item "$testRoot\state\flags\frontier-wake-off"

  # T7 (QA): one escalation and one page per identity over ANY sequence of ticks.
  function Get-StallPages { @(Get-Content "$testRoot\state\pages\pages.jsonl" -ErrorAction SilentlyContinue | Where-Object { $_ -match '"kind":"stall"' }) }
  function Set-IcRow { param([string]$Status) Set-AgentsRows ('[' + $dispRow + ',{"id":"job-p","name":"pl-test","state":"working","status":"idle","pid":13,"startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-240)) + '},{"id":"job-i","name":"ic-1","state":"working","status":"' + $Status + '","pid":14,"startedAt":' + (Get-EpochMs (Get-Date).AddMinutes(-300)) + '}]') }
  # A local Pushover stand-in so a page counts as delivered (an undelivered page is retried, and logged, every tick).
  $pushPort = Get-Random -Minimum 20000 -Maximum 40000; $oldPushUrl = $env:FLEET_PUSHOVER_URL; $env:FLEET_PUSHOVER_URL = "http://127.0.0.1:$pushPort/"
  [IO.Directory]::CreateDirectory("$testRoot\state\pages") | Out-Null
  Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-346","user":"usr-346"}'
  $pushJob = Start-Job -ScriptBlock { param($Prefix) $l = New-Object System.Net.HttpListener; $l.Prefixes.Add($Prefix); $l.Start(); for ($i = 0; $i -lt 20; $i++) { $c = $l.GetContext(); $b = [Text.Encoding]::UTF8.GetBytes('{"status":1}'); $c.Response.ContentLength64 = $b.Length; $c.Response.OutputStream.Write($b, 0, $b.Length); $c.Response.OutputStream.Close() }; $l.Stop() } -ArgumentList $env:FLEET_PUSHOVER_URL
  Start-Sleep -Milliseconds 500
  Set-StallCase; Remove-Item "$testRoot\state\pages\pages.jsonl" -ErrorAction SilentlyContinue; Set-StallDelivered 121
  $null = Run-Watchdog
  Assert-True ((Get-StallEscalations).Count -eq 1 -and (Get-StallPages).Count -eq 1) "T7: escalation filed once with one page (got $((Get-StallEscalations).Count) files, $((Get-StallPages).Count) pages)"
  $pg = @(Get-StallPages)[0] | ConvertFrom-Json
  Assert-True ($pg.kind -eq 'stall' -and $pg.priority -eq 'normal') "T7: the page has kind stall and priority normal (got $(@(Get-StallPages)[0]))"
  Write-Utf8 "$testRoot\state\PAUSE" 'fixture'; $null = Run-Watchdog; Remove-Item "$testRoot\state\PAUSE"
  $null = Run-Watchdog
  Assert-True ((Get-StallEscalations).Count -eq 1 -and (Get-StallPages).Count -eq 1) "T7: escalate, PAUSE tick, unpause: still one escalation and one page (got $((Get-StallEscalations).Count), $((Get-StallPages).Count))"
  Set-IcRow 'busy'; $null = Run-Watchdog; Set-IcRow 'idle'; $null = Run-Watchdog
  Assert-True ((Get-StallEscalations).Count -eq 1 -and (Get-StallPages).Count -eq 1) "T7: escalate, IC busy one tick, idle again: still one escalation and one page (got $((Get-StallEscalations).Count), $((Get-StallPages).Count))"
  # T7b: a cleared stall (newer heartbeat) is truly gone: pruned, and a later stall is a new identity.
  Set-Heartbeat 'ic-1' 5; $null = Run-Watchdog
  Assert-True (-not ((Get-Content "$testRoot\state\watchdog\frontier-wake.json" -Raw) -match 'stall:')) 'T7b: a cleared escalated stall is pruned'
  Stop-Job $pushJob -ErrorAction SilentlyContinue; Remove-Job $pushJob -Force -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\pages\pushover.json" -ErrorAction SilentlyContinue
  if ($null -eq $oldPushUrl) { Remove-Item Env:FLEET_PUSHOVER_URL -ErrorAction SilentlyContinue } else { $env:FLEET_PUSHOVER_URL = $oldPushUrl }

  # T8: after delivery, a quiet tick logs outcome none (not the frontier wake's reason).
  Set-StallCase; Set-StallDelivered 60
  $t8 = Run-Watchdog
  Assert-True (@($t8.stalls).Count -eq 1 -and @($t8.stalls)[0].outcome -eq 'none') "T8: an already-delivered, non-escalating stall logs none (got $($t8.stalls | ConvertTo-Json -Compress))"

  # T9: an unreadable heartbeat skips the IC: no stall, no wake, entry kept.
  Set-StallCase; Set-StallDelivered 121
  $null = Run-Watchdog
  Write-Utf8 "$testRoot\state\heartbeats\ic-1.json" '{not json'
  $t9 = Run-Watchdog
  Assert-True (@($t9.stalls).Count -eq 0 -and (Get-StallEscalations).Count -eq 1 -and ((Get-Content "$testRoot\state\watchdog\frontier-wake.json" -Raw) -match 'stall:')) 'T9: an unparseable heartbeat keeps the existing entry and files nothing new'
  Set-StallCase
  Write-Utf8 "$testRoot\state\heartbeats\ic-1.json" '{not json'
  $t9b = Run-Watchdog
  Assert-True (@($t9b.stalls).Count -eq 0 -and @(Get-RotateCalls).Count -eq 0) 'T9: an unparseable heartbeat makes no stall and no wake'
  Remove-Item "$testRoot\state\work\active.json", "$testRoot\state\watchdog\paged.json", "$testRoot\state\pages\pages.jsonl" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\escalations\*" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\profile\.claude\jobs\job-i" -Recurse -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\work\active.json", "$testRoot\state\watchdog\paged.json" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\escalations\*" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\profile\.claude\jobs\job-i" -Recurse -ErrorAction SilentlyContinue

  if ($script:failures.Count -gt 0) { throw "$($script:failures.Count) frontier-wake-respawn assertion(s) failed" }
  Write-Output 'frontier-wake-respawn tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  if ($null -eq $oldFixture) { Remove-Item Env:FLEET_GITHUB_ISSUES_FIXTURE -ErrorAction SilentlyContinue } else { $env:FLEET_GITHUB_ISSUES_FIXTURE = $oldFixture }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-watchdog-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
