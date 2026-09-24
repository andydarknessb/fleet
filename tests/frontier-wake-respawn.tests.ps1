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
  foreach ($f in '_common.ps1','sentinel-check.ps1','watchdog.ps1','assignment.js','work-state.js','exclusions.js','notify.js','assignment-parity.js','triage.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }

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
