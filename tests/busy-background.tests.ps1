$ErrorActionPreference = 'Stop'

# fleet #149: a session the daemon reports `busy` only because a leaked background
# task (an `until` loop, a Monitor) is still in flight has ended its turn. Every
# guard used to read `busy` as mid-turn, so pe-endzone sat 8h (2026-09-24/25)
# with no triage wake, no stale-heartbeat respawn and no page. These cases run the
# real watchdog, sentinel-check and rotate.ps1 boundary against both kinds of busy.

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
$oldTriageFixture = $env:FLEET_TRIAGE_ISSUES_FIXTURE

function Set-Heartbeat { param([string]$Name, [double]$AgeMinutes)
  Write-Utf8 "$testRoot\state\heartbeats\$Name.json" (ConvertTo-Json @{ name = $Name; at = (Get-Iso $AgeMinutes) } -Compress)
}
function Set-AgentsRows { param([string]$Json) Write-Utf8 "$testRoot\mock-agents.json" $Json }
function Run-Watchdog { $out = & "$testRoot\bin\watchdog.ps1" -NoToast | Out-String; ($out.Trim() -split "`n")[-1] | ConvertFrom-Json }
function Run-Check { & "$testRoot\bin\sentinel-check.ps1" -ReportPath "$testRoot\check-report.json" | Out-Null; Get-Content "$testRoot\check-report.json" -Raw | ConvertFrom-Json }
function Run-RotateDry { $out = & "$testRoot\bin\rotate-real.ps1" -Name 'pe-test' -Wake 'fixture' -DryRun -NoReconcile | Out-String; @(((($out.Trim() -split "`n")[-1]) | ConvertFrom-Json).outcomes | Where-Object { $_.name -eq 'pe-test' })[0] }
function Get-RotateCalls { if (Test-Path "$testRoot\rotate-calls.txt") { @(Get-Content "$testRoot\rotate-calls.txt") } else { @() } }
function Reset-Wake { Remove-Item "$testRoot\state\watchdog\frontier-wake.json", "$testRoot\state\watchdog\triage-wake.json", "$testRoot\rotate-calls.txt" -ErrorAction SilentlyContinue }
# A job as the daemon keeps it: state.json (the model's last state report, when the
# job last changed, what is in flight) and timeline.jsonl (one line per report).
# $QuietMinutes is how long ago the job last reported anything.
function New-Job { param([string]$Id, [string]$State, [double]$QuietMinutes, [int]$Tasks, [string[]]$Kinds)
  $dir = "$testRoot\profile\.claude\jobs\$Id"
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  $at = Get-Iso $QuietMinutes
  $js = [ordered]@{ state = $State; detail = 'fixture'; tempo = 'idle'; inFlight = [ordered]@{ tasks = $Tasks; queued = 0; kinds = @($Kinds) }; updatedAt = $at }
  if ($State -eq 'done') { $js.lastTerminalAt = $at }
  Write-Utf8 "$dir\state.json" ($js | ConvertTo-Json -Depth 5 -Compress)
  Write-Utf8 "$dir\timeline.jsonl" ((([ordered]@{ at = $at; state = $State; detail = 'fixture'; text = '' }) | ConvertTo-Json -Compress) + "`n")
}
function New-Row { param([string]$Id, [string]$Name, [string]$Status, [int]$ProcessId, [string]$State = 'working')
  '{"id":"' + $Id + '","name":"' + $Name + '","state":"' + $State + '","status":"' + $Status + '","pid":' + $ProcessId + ',"startedAt":' + (Get-EpochMs (Get-Date).AddHours(-10)) + '}'
}
function Get-TenantEntry { param($List) @($List | Where-Object { $_.tenant -eq 'test' })[0] }

try {
  foreach ($dir in 'bin','tenants','config','state','state/heartbeats','state/sentinel','state/skip','state/watchdog','state/work','state/watch','state/flags','repo','mock-bin','profile','profile/.claude/jobs') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','identity.js','sentinel-check.ps1','watchdog.ps1','assignment.js','premises.js','work-state.js','exclusions.js','notify.js','assignment-parity.js','triage.js','rotation-policy.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  # The real rotate.ps1 under another name, for its boundary check alone (-DryRun);
  # bin/rotate.ps1 below is the mock the watchdog's wakes call.
  [IO.File]::Copy("$sourceRoot\bin\rotate.ps1", "$testRoot\bin\rotate-real.ps1")

  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"},{"name":"pe-test","role":"principal","parent":"dispatcher","tenant":"test"}]}'
  $tenant = [ordered]@{ name = 'test'; repo = "$testRoot\repo"; github = 'owner/repo'; defaultBranch = 'master'; releaseBranch = 'master'; branchPrefix = 'fleet/'; readyLabel = 'ready-for-agent'; maxIcs = 2; ownerLogin = 'cory-owner' }
  Write-Utf8 "$testRoot\tenants\test.json" ($tenant | ConvertTo-Json -Compress)
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  Write-Utf8 "$testRoot\config\cycle.json" '{"supervisor":{"pageKinds":["stray"]},"frontierWake":{"cooldownMinutes":60,"sources":["outbox"]}}'
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'fleet #149 fixture'
  Write-Utf8 "$testRoot\state\flags\principal-live" 'fleet #149 fixture'
  Write-Utf8 "$testRoot\state\roster.json" ('{"sessions":[{"name":"pl-test","role":"project-lead","tenant":"test","status":"active","launchedAt":"' + (Get-Iso 600) + '"},{"name":"pe-test","role":"principal","tenant":"test","parent":"dispatcher","status":"active","launchedAt":"' + (Get-Iso 600) + '"}]}')
  & git -C "$testRoot\repo" init --quiet
  $env:FLEET_GITHUB_ISSUES_FIXTURE = "$testRoot\issues-fixture.json"
  Write-Utf8 $env:FLEET_GITHUB_ISSUES_FIXTURE '[]'
  $env:FLEET_TRIAGE_ISSUES_FIXTURE = "$testRoot\triage-fixture.json"
  Write-Utf8 $env:FLEET_TRIAGE_ISSUES_FIXTURE '[{"number":601,"title":"Unrouted","url":"https://github.com/owner/repo/issues/601","body":"Something is off.","createdAt":"2026-09-02T00:00:00.000Z","labels":[],"assignees":[],"comments":[]}]'
  # A checks-settled wake the watcher recorded for the lead 30 min ago.
  Write-Utf8 "$testRoot\state\watch\wake-outbox.jsonl" ((([ordered]@{ at = (Get-Iso 30); recordId = 'test:issue-10'; revision = 3; eventSequence = 3; wake = 'checks-settled'; idempotencyKey = 'watch:test:issue-10:r2:aa:review'; evidence = 'fixture'; actor = 'pr-watch' }) | ConvertTo-Json -Compress) + "`n")

  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\bin\rotate.ps1" ('param([string]$Name,[string]$Wake,[switch]$Force,[switch]$DryRun)' + "`r`n" + '[IO.File]::AppendAllText("' + $testRoot.Replace('\', '\\') + '\rotate-calls.txt", "$Name|$Wake`n")' + "`r`n" + 'Write-Output (@{ rotated = @($Name); deferred = @(); outcomes = @(@{ name = $Name; status = "rotated"; reason = $null }) } | ConvertTo-Json -Compress -Depth 6)' + "`r`n" + 'exit 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
  Set-Heartbeat 'dispatcher' 2
  New-Job 'job-d' 'done' 2 0 @()
  $dispRow = New-Row 'job-d' 'dispatcher' 'idle' 11
  Set-AgentsRows ('[' + $dispRow + ',' + (New-Row 'job-p' 'pl-test' 'busy' 13) + ',' + (New-Row 'job-pe' 'pe-test' 'busy' 14) + ']')

  # Case B1 (the 2026-09-24 18:53Z shape): the principal and the lead each ended
  # their turn 8h ago with shell loops still in flight. The daemon says busy, the
  # heartbeat is 8h stale, and there is work for both. Both are woken.
  Reset-Wake
  New-Job 'job-pe' 'done' 480 2 @('local_bash', 'local_bash')
  New-Job 'job-p' 'working' 480 1 @('local_bash')
  Set-Heartbeat 'pe-test' 480
  Set-Heartbeat 'pl-test' 480
  $b1 = Run-Watchdog
  $t1 = Get-TenantEntry $b1.triageWakes
  $f1 = Get-TenantEntry $b1.frontierWakes
  Assert-True ($b1.mode -eq 'live') "the fixture must run live (got $($b1.mode): $($b1.modeReason))"
  Assert-True ($t1.decision -eq 'woken') "B1: a principal busy only with background tasks must get the triage wake (got $($t1.decision): $($t1.reason); frontierError=$($t1.frontierError))"
  Assert-True ($f1.decision -eq 'woken') "B1: a lead busy only with background tasks must get the frontier wake (got $($f1.decision): $($f1.reason))"
  Assert-True (@(Get-RotateCalls | Where-Object { $_ -like 'pe-test|*' }).Count -eq 1 -and @(Get-RotateCalls | Where-Object { $_ -like 'pl-test|*' }).Count -eq 1) "B1: one rotate.ps1 -Wake each (got $(@(Get-RotateCalls) -join '; '))"
  Assert-True (@($b1.conditions | Where-Object { "$_" -like 'busy-stale:*' }).Count -eq 0) "B1: a session woken this tick is being healed, not busy-stale (got $(@($b1.conditions) -join ','))"

  # Case B2: the stale-heartbeat respawn must not skip that row as busy either.
  $c2 = Run-Check
  Assert-True (@($c2.respawned | Where-Object { $_.name -eq 'pl-test' }).Count -eq 1) "B2: sentinel-check must respawn a stale lead that is busy only with background tasks (respawned: $(@($c2.respawned | ForEach-Object { $_.name }) -join ','))"

  # Case B3: rotate.ps1's safe boundary accepts it (every wake goes through rotate.ps1).
  $r3 = Run-RotateDry
  Assert-True ($r3.status -eq 'dry-run') "B3: rotate.ps1 must treat busy-with-background-only as a safe boundary (got $($r3.status): $($r3.reason))"

  # Case B4 (control, genuinely mid-turn): the same kind of task in flight, but the
  # job reported a minute ago. Nothing wakes, respawns, rotates or pages it.
  Reset-Wake
  New-Job 'job-pe' 'working' 1 1 @('local_bash')
  New-Job 'job-p' 'working' 1 1 @('local_bash')
  $b4 = Run-Watchdog
  $t4 = Get-TenantEntry $b4.triageWakes
  $f4 = Get-TenantEntry $b4.frontierWakes
  Assert-True ($t4.decision -eq 'none' -and "$($t4.reason)" -match 'busy') "B4: a principal mid-turn must not be woken (got $($t4.decision): $($t4.reason))"
  Assert-True ($f4.decision -eq 'none' -and "$($f4.reason)" -match 'busy') "B4: a lead mid-turn must not be woken (got $($f4.decision): $($f4.reason))"
  Assert-True (@(Get-RotateCalls).Count -eq 0) 'B4: no rotate.ps1 call for a session mid-turn'
  Assert-True (@($b4.conditions | Where-Object { "$_" -like 'busy-stale:*' }).Count -eq 0) "B4: a session mid-turn raises no busy-stale condition (got $(@($b4.conditions) -join ','))"
  $c4 = Run-Check
  Assert-True (@($c4.respawned | Where-Object { $_.name -eq 'pl-test' }).Count -eq 0) 'B4: sentinel-check must not respawn a lead mid-turn'
  $r4 = Run-RotateDry
  Assert-True ($r4.status -eq 'deferred' -and "$($r4.reason)" -match 'mid-turn') "B4: rotate.ps1 must defer a session mid-turn (got $($r4.status): $($r4.reason))"

  # Case B5 (control, a subagent in flight): a task kind that ends in a turn of its
  # own is not a leak by this rule, however quiet. Still busy.
  Reset-Wake
  New-Job 'job-pe' 'done' 480 1 @('local_agent')
  New-Job 'job-p' 'done' 480 2 @('local_bash', 'local_agent')
  $b5 = Run-Watchdog
  Assert-True ((Get-TenantEntry $b5.triageWakes).decision -eq 'none') "B5: a principal with a subagent in flight is still busy (got $((Get-TenantEntry $b5.triageWakes).decision))"
  Assert-True ((Get-TenantEntry $b5.frontierWakes).decision -eq 'none') "B5: a lead with a subagent in flight is still busy (got $((Get-TenantEntry $b5.frontierWakes).decision))"
  # ... but silent 8h mid-turn with a stale heartbeat, nothing can act on it: it pages.
  Assert-True ((@($b5.conditions) -contains 'busy-stale:pe-test') -and (@($b5.conditions) -contains 'busy-stale:pl-test')) "B5: a session silent 8h mid-turn must raise busy-stale (got $(@($b5.conditions) -join ','))"
  $c5 = Run-Check
  Assert-True (@($c5.respawned | Where-Object { $_.name -eq 'pl-test' }).Count -eq 0) 'B5: sentinel-check must not respawn a lead with a subagent in flight'

  # Case B6 (control, unreadable job state): nothing wakes, but once the heartbeat
  # is stale past the respawn threshold a named condition says so.
  Reset-Wake
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-pe\state.json" '{ not json'
  New-Job 'job-p' 'working' 1 1 @('local_bash')
  $b6 = Run-Watchdog
  $t6 = Get-TenantEntry $b6.triageWakes
  Assert-True ($t6.decision -eq 'none' -and "$($t6.reason)" -match 'busy; job state') "B6: an unreadable job state must not wake (got $($t6.decision): $($t6.reason))"
  Assert-True (@(Get-RotateCalls | Where-Object { $_ -like 'pe-test|*' }).Count -eq 0) 'B6: no rotate.ps1 call off an unreadable job state'
  Assert-True (@($b6.conditions) -contains 'busy-stale:pe-test') "B6: a stale busy session whose job state is unreadable must raise busy-stale:pe-test (got $(@($b6.conditions) -join ','))"
  Assert-True (@($b6.conditions) -notcontains 'busy-stale:pl-test') 'B6: a mid-turn session raises no busy-stale'
  # ... and not while the heartbeat is still fresh.
  Set-Heartbeat 'pe-test' 30
  $b6b = Run-Watchdog
  Assert-True (@($b6b.conditions) -notcontains 'busy-stale:pe-test') "B6: busy-stale waits for the stale threshold (got $(@($b6b.conditions) -join ','))"

  # Case B7 (review of #149): between turns, but no heal path reaches it. The principal's
  # daemon row is `done` (sentinel-check only respawns `working`) and its frontier is
  # empty (no triage wake). A leaked loop there must not be silent either.
  Reset-Wake
  Write-Utf8 $env:FLEET_TRIAGE_ISSUES_FIXTURE '[]'
  New-Job 'job-pe' 'done' 480 1 @('local_bash')
  Set-Heartbeat 'pe-test' 480
  Set-AgentsRows ('[' + $dispRow + ',' + (New-Row 'job-p' 'pl-test' 'busy' 13) + ',' + (New-Row 'job-pe' 'pe-test' 'busy' 14 'done') + ']')
  $b7 = Run-Watchdog
  Assert-True ((Get-TenantEntry $b7.triageWakes).decision -eq 'none') "B7: nothing to wake the principal for (got $((Get-TenantEntry $b7.triageWakes).decision))"
  Assert-True (@($b7.conditions) -contains 'busy-stale:pe-test') "B7: a stale session between turns that nothing acted on must raise busy-stale (got $(@($b7.conditions) -join ','))"

  if ($script:failures.Count -gt 0) { throw "$($script:failures.Count) busy-background assertion(s) failed" }
  Write-Output 'busy-background tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  if ($null -eq $oldFixture) { Remove-Item Env:FLEET_GITHUB_ISSUES_FIXTURE -ErrorAction SilentlyContinue } else { $env:FLEET_GITHUB_ISSUES_FIXTURE = $oldFixture }
  if ($null -eq $oldTriageFixture) { Remove-Item Env:FLEET_TRIAGE_ISSUES_FIXTURE -ErrorAction SilentlyContinue } else { $env:FLEET_TRIAGE_ISSUES_FIXTURE = $oldTriageFixture }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-watchdog-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
