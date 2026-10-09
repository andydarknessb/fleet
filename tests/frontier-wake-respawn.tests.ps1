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
