$ErrorActionPreference = 'Stop'

# fleet #136: every PR-watch tick failed for 2h20m on 2026-09-24 and nothing paged; the
# only symptoms were ERROR lines in state/watch/watch.log and a frozen health.json, and
# the watchdog read neither. These cases run the real watchdog against a health.json
# that is fresh, stale, missing, unparseable or failing, and the pr-watch-off flag.

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
function Run-Watchdog { $out = & "$testRoot\bin\watchdog.ps1" -NoToast | Out-String; ($out.Trim() -split "`n")[-1] | ConvertFrom-Json }
function New-Row { param([string]$Id, [string]$Name, [int]$ProcessId)
  '{"id":"' + $Id + '","name":"' + $Name + '","state":"idle","status":"idle","pid":' + $ProcessId + ',"startedAt":' + (Get-EpochMs (Get-Date).AddHours(-10)) + '}'
}
function Set-Health { param([double]$AgeMinutes, [string]$Extra = '"ok":true')
  Write-Utf8 "$testRoot\state\watch\health.json" ('{"at":"' + (Get-Iso $AgeMinutes) + '",' + $Extra + '}')
}
function Get-WatcherKeys { param($Run) @($Run.conditions | Where-Object { "$_" -like 'watcher-stale*' }) }
function Get-WatcherPages { if (Test-Path "$testRoot\state\pages\pages.jsonl") { @(Get-Content "$testRoot\state\pages\pages.jsonl" | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.kind -eq 'watcher-stale' }) } else { @() } }

try {
  foreach ($dir in 'bin','tenants','config','state','state/heartbeats','state/sentinel','state/skip','state/watchdog','state/work','state/watch','state/flags','repo','mock-bin','profile','profile/.claude/jobs') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','identity.js','sentinel-check.ps1','watchdog.ps1','assignment.js','premises.js','work-state.js','exclusions.js','notify.js','assignment-parity.js','triage.js','rotation-policy.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"},{"name":"pl-test","role":"project-lead","parent":"dispatcher","tenant":"test"}]}'
  $tenant = [ordered]@{ name = 'test'; repo = "$testRoot\repo"; github = 'owner/repo'; defaultBranch = 'master'; releaseBranch = 'master'; branchPrefix = 'fleet/'; readyLabel = 'ready-for-agent'; maxIcs = 2; ownerLogin = 'cory-owner' }
  Write-Utf8 "$testRoot\tenants\test.json" ($tenant | ConvertTo-Json -Compress)
  Write-Utf8 "$testRoot\state\skip\test.json" '{"issues":{},"prs":{}}'
  Write-Utf8 "$testRoot\config\cycle.json" '{"supervisor":{"pageKinds":["stray"]},"watchdog":{"watchStaleMinutes":20,"watchFailTicks":3}}'
  Write-Utf8 "$testRoot\state\flags\sentinel-off" 'fleet #136 fixture'
  Write-Utf8 "$testRoot\state\roster.json" ('{"sessions":[{"name":"pl-test","role":"project-lead","tenant":"test","status":"active","launchedAt":"' + (Get-Iso 600) + '"}]}')
  # One active Work record the watcher is responsible for advancing.
  Write-Utf8 "$testRoot\state\work\active.json" '{"records":{"test:issue-10":{"id":"test:issue-10","tenant":"test","issue":10,"state":"implementing","revision":2}}}'
  & git -C "$testRoot\repo" init --quiet
  $env:FLEET_GITHUB_ISSUES_FIXTURE = "$testRoot\issues-fixture.json"
  Write-Utf8 $env:FLEET_GITHUB_ISSUES_FIXTURE '[]'
  $env:FLEET_TRIAGE_ISSUES_FIXTURE = "$testRoot\triage-fixture.json"
  Write-Utf8 $env:FLEET_TRIAGE_ISSUES_FIXTURE '[]'
  Write-Utf8 "$testRoot\mock-agents.json" ('[' + (New-Row 'job-d' 'dispatcher' 11) + ',' + (New-Row 'job-p' 'pl-test' 13) + ']')
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
  Set-Heartbeat 'dispatcher' 2
  Set-Heartbeat 'pl-test' 2

  # W1: a health file 19 minutes old (threshold 20) is not stale.
  Set-Health 19
  $w1 = Run-Watchdog
  Assert-True ($w1.mode -eq 'live') "the fixture must run live (got $($w1.mode): $($w1.modeReason))"
  Assert-True ((Get-WatcherKeys $w1).Count -eq 0) "W1: 19 minutes is under the threshold (got $(@($w1.conditions) -join ','))"

  # W2: 21 minutes old with an active record pages watcher-stale, once, at high priority.
  Set-Health 21
  $w2 = Run-Watchdog
  Assert-True (@($w2.conditions) -contains 'watcher-stale') "W2: a 21-minute-old health.json must raise watcher-stale (got $(@($w2.conditions) -join ','))"
  $p2 = @(Get-WatcherPages)
  Assert-True ($p2.Count -eq 1 -and "$($p2[0].priority)" -eq 'high') "W2: one high-priority watcher-stale page (got $($p2.Count): $(@($p2 | ForEach-Object { $_.priority }) -join ','))"
  Assert-True ("$($p2[0].body)" -match '21 min' -and "$($p2[0].body)" -match 'watch\.log') "W2: the page says how old the file is and where to look: $($p2[0].body)"
  $w2b = Run-Watchdog
  # Pushover is unconfigured here, so the shared pager re-attempts each tick by design;
  # a standing condition is simply not newly paged again.
  Assert-True (@($w2.newlyPaged | ForEach-Object { $_.key }) -contains 'watcher-stale') 'W2: the first tick pages the new condition'
  Assert-True (@($w2b.conditions) -contains 'watcher-stale' -and -not (@($w2b.newlyPaged | ForEach-Object { $_.key }) -contains 'watcher-stale')) 'W2: a standing condition is not newly paged again'

  # W3: a healthy tick clears it.
  Set-Health 1
  $w3 = Run-Watchdog
  Assert-True ((Get-WatcherKeys $w3).Count -eq 0) "W3: a fresh healthy tick clears the condition (got $(@($w3.conditions) -join ','))"

  # W4: pr-watch-off stands: the watcher skips by design, so a stale file never pages.
  Set-Health 90
  Write-Utf8 "$testRoot\state\flags\pr-watch-off" 'fixture'
  $w4 = Run-Watchdog
  Assert-True ((Get-WatcherKeys $w4).Count -eq 0) "W4: pr-watch-off suppresses watcher-stale (got $(@($w4.conditions) -join ','))"
  Remove-Item "$testRoot\state\flags\pr-watch-off"

  # W5: PAUSE does not stop the PR watcher, so it does not suppress this check either.
  Write-Utf8 "$testRoot\state\PAUSE" 'fixture pause'
  $w5 = Run-Watchdog
  Assert-True (@($w5.conditions) -contains 'watcher-stale') "W5: PAUSE must not hide a dead watcher (got $(@($w5.conditions) -join ','))"
  Remove-Item "$testRoot\state\PAUSE"

  # W6: missing or unparseable health is stale, never fatal. Missing with no active record is quiet.
  Remove-Item "$testRoot\state\watch\health.json"
  $w6 = Run-Watchdog
  Assert-True (@($w6.conditions) -contains 'watcher-stale') "W6: no health.json while a record is active must raise watcher-stale (got $(@($w6.conditions) -join ','))"
  Write-Utf8 "$testRoot\state\watch\health.json" '{ not json'
  $w6b = Run-Watchdog
  Assert-True (@($w6b.conditions) -contains 'watcher-stale') "W6: an unparseable health.json is stale (got $(@($w6b.conditions) -join ','))"
  Remove-Item "$testRoot\state\watch\health.json"
  Write-Utf8 "$testRoot\state\work\active.json" '{"records":{}}'
  $w6c = Run-Watchdog
  Assert-True ((Get-WatcherKeys $w6c).Count -eq 0) "W6: no health.json and nothing active (a fresh root) is quiet (got $(@($w6c.conditions) -join ','))"
  Write-Utf8 "$testRoot\state\work\active.json" '{"records":{"test:issue-10":{"id":"test:issue-10","tenant":"test","issue":10,"state":"implementing","revision":2}}}'

  # W7: failing. One ok:false tick does not page; three consecutive (aggregate shape) do, naming the tenant.
  Set-Health 1 '"ok":false,"error":"tenant(s) failed: nidus","consecutiveFailures":1,"tenants":{"test":{"ok":true,"consecutiveFailures":0},"nidus":{"ok":false,"error":"boom","consecutiveFailures":1}}'
  $w7 = Run-Watchdog
  Assert-True ((Get-WatcherKeys $w7).Count -eq 0) "W7: one failed tick does not page (got $(@($w7.conditions) -join ','))"
  Set-Health 1 '"ok":false,"error":"tenant(s) failed: nidus","consecutiveFailures":3,"tenants":{"test":{"ok":true,"consecutiveFailures":0},"nidus":{"ok":false,"error":"boom","consecutiveFailures":3}}'
  $w7b = Run-Watchdog
  Assert-True (@($w7b.conditions) -contains 'watcher-stale:failing') "W7: three consecutive failed ticks raise watcher-stale:failing (got $(@($w7b.conditions) -join ','))"
  $p7 = @(Get-WatcherPages | Where-Object { "$($_.body)" -match 'failed' })
  Assert-True ($p7.Count -ge 1 -and "$($p7[-1].body)" -match 'nidus' -and "$($p7[-1].body)" -notmatch '\btest\b:') "W7: the failing page names the failing tenant only: $($p7[-1].body)"
  # The single-tenant shape (a --tenant run such as rotate.ps1's) is read too.
  Set-Health 1 '"ok":false,"tenant":"test","error":"listOpenPrs failed","consecutiveFailures":4'
  $w7c = Run-Watchdog
  Assert-True (@($w7c.conditions) -contains 'watcher-stale:failing') "W7: the single-tenant shape is read (got $(@($w7c.conditions) -join ','))"
  Set-Health 1
  $w7d = Run-Watchdog
  Assert-True ((Get-WatcherKeys $w7d).Count -eq 0) "W7: a healthy tick clears the failing condition (got $(@($w7d.conditions) -join ','))"

  if ($script:failures.Count -gt 0) { throw "$($script:failures.Count) watcher-stale assertion(s) failed" }
  Write-Output 'watcher-stale tests passed'
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
