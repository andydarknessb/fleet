# WS5 (fleet #82, spec #194): cutover-dispatcher.ps1 and rollback-dispatcher.ps1 against a
# fixture fleet with a mock `claude`, a mock daemon list, and the real retire.ps1 and
# launch.ps1, modeled on tests/sentinel-cutover.tests.ps1. The dispatcher is removed only past
# the notifier, daily-summary-task and watchdog gates and only at a turn boundary, and cutover
# touches no ledger. Rollback removes the flag and relaunches through the one door.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-dcutover-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Run-Script {
  param([string]$Script, [string[]]$Arguments = @())
  # Child processes run inside the fixture: with USERPROFILE redirected, PowerShell drops its
  # module analysis cache under the current directory, and that must not be the repo.
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $testRoot
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\$Script" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; Pop-Location }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}
function Get-ClaudeCalls { if (Test-Path "$testRoot\claude-calls.txt") { @(Get-Content "$testRoot\claude-calls.txt") } else { @() } }
function Get-LiveEntry { param([string]$Name) ((Get-Content "$testRoot\state\roster.json" -Raw) | ConvertFrom-Json).sessions | Where-Object { $_.name -eq $Name } | Select-Object -Last 1 }
function Get-Hash { param([string]$Path) (Get-FileHash $Path -Algorithm SHA256).Hash }

try {
  foreach ($dir in 'bin','agents','tenants','state','state/heartbeats','state/skip','state/watchdog','state/escalations','state/events','state/sessions','state/flags','profile/.claude/jobs/job-d','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','cutover-dispatcher.ps1','rollback-dispatcher.ps1','retire.ps1','launch.ps1','identity.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\agents\dispatcher.md" "---`nname: dispatcher`nmodel: sonnet`neffort: low`n---`nRole body."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" ('{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","tenant":null,"parent":"cory","cwd":"' + $testRoot.Replace('\', '\\') + '","prompt":"You are the dispatcher."},{"name":"pl-test","role":"project-lead","tenant":"test","parent":"dispatcher","cwd":"' + $testRoot.Replace('\', '\\') + '","prompt":"p"}]}')
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"dispatcher","role":"dispatcher","tenant":null,"parent":"cory","issue":null,"cwd":null,"jobId":"job-d","sessionId":"sess-d","prompt":"You are the dispatcher.","status":"active","launchedAt":"2026-09-01T00:00:00Z"}]}'
  Write-Utf8 "$testRoot\state\heartbeats\dispatcher.json" '{"name":"dispatcher","at":"2026-09-01T00:00:00Z"}'
  Write-Utf8 "$testRoot\state\flags\notifier-live" 'live'
  Write-Utf8 "$testRoot\state\watchdog\last-run.json" ('{"at":"' + (Get-Date).ToUniversalTime().AddMinutes(-3).ToString('o') + '","mode":"live","conditions":[]}')
  Write-Utf8 "$testRoot\state\events\2026-09-01.jsonl" ('{"sequence":1,"type":"work-created","recordId":"test:issue-1"}' + "`n")
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-d\state.json" '{"detail":"","waitingFor":""}'
  $rowsWithDispatcher = '[{"id":"job-d","name":"dispatcher","state":"working","status":"idle","pid":11,"sessionId":"sess-d","startedAt":1756000000000},{"id":"job-p","name":"pl-test","state":"working","status":"idle","pid":12,"sessionId":"sess-p","startedAt":1756000001000}]'
  $rowsBusyDispatcher = $rowsWithDispatcher.Replace('"status":"idle","pid":11', '"status":"busy","pid":11')
  $rowsAfterRm = '[{"id":"job-p","name":"pl-test","state":"working","status":"idle","pid":12,"sessionId":"sess-p","startedAt":1756000001000}]'
  $rowsAfterLaunch = '[{"id":"job-p","name":"pl-test","state":"working","status":"idle","pid":12,"sessionId":"sess-p","startedAt":1756000001000},{"id":"job-d2","name":"dispatcher","state":"working","status":"idle","pid":14,"sessionId":"sess-2","startedAt":1756000002000}]'
  Write-Utf8 "$testRoot\mock-agents.json" $rowsWithDispatcher
  Write-Utf8 "$testRoot\mock-agents-after-rm.json" $rowsAfterRm
  Write-Utf8 "$testRoot\mock-agents-after-launch.json" $rowsAfterLaunch
  $r = $testRoot
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" +
    'echo %* >> "' + $r + '\claude-calls.txt"' + "`r`n" +
    'if "%1"=="agents" type "' + $r + '\mock-agents.json"' + "`r`n" +
    'if "%1"=="rm" copy /y "' + $r + '\mock-agents-after-rm.json" "' + $r + '\mock-agents.json" >nul' + "`r`n" +
    'if "%1"=="--bg" (if not "%MOCK_LAUNCH_FAIL%"=="1" copy /y "' + $r + '\mock-agents-after-launch.json" "' + $r + '\mock-agents.json" >nul)' + "`r`n" +
    'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  # Claude Code 2.1.281 trust pre-flight (launch.ps1 Test-WorkspaceTrusted): trust the test root so every path under it launches.
  [IO.Directory]::CreateDirectory("$testRoot\profile") | Out-Null
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
  $eventsHash = Get-Hash "$testRoot\state\events\2026-09-01.jsonl"
  $flag = "$testRoot\state\flags\dispatcher-off"

  # Case 1: no notifier-live flag -> refused; nothing changes.
  Remove-Item "$testRoot\state\flags\notifier-live"
  $r1 = Run-Script 'cutover-dispatcher.ps1' @('-SkipTaskCheck')
  Assert-True ($lastExit -eq 3) "a failed gate must exit 3 (got $lastExit): $lastOut"
  Assert-True ($r1.cutover -eq $false -and (@($r1.reasons) -join ' ') -match 'notifier-live') 'the refusal must name the notifier-live gate'
  Assert-True (-not (Test-Path $flag)) 'a refused cutover must not write the flag'
  Assert-True ((Get-LiveEntry 'dispatcher').status -eq 'active') 'a refused cutover must not retire the dispatcher'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^(stop|rm) ' }).Count -eq 0) 'a refused cutover must not stop anything'
  Assert-True (-not (Test-Path "$testRoot\state\dispatcher\cutover.json")) 'a refused cutover must not record'

  # Case 1b: -Force overrides the failing notifier gate on a dry run and records the override.
  $r1f = Run-Script 'cutover-dispatcher.ps1' @('-SkipTaskCheck', '-Force', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r1f.dryRun -eq $true -and $r1f.cutover -eq $false -and $r1f.forced -eq $true) "-Force must override the failing notifier gate on a dry run: $lastOut"
  Assert-True ((@($r1f.overridden) -join ' ') -match 'notifier-live') 'a forced dry run must record what it would override'
  Assert-True (-not (Test-Path $flag)) 'a forced dry run must not write the flag'
  Write-Utf8 "$testRoot\state\flags\notifier-live" 'live'

  # Case 2: gates hold but the dispatcher is mid-turn -> refused, and -Force does not override the boundary.
  Write-Utf8 "$testRoot\mock-agents.json" $rowsBusyDispatcher
  $r2 = Run-Script 'cutover-dispatcher.ps1' @('-SkipTaskCheck', '-Force')
  Assert-True ($lastExit -eq 3 -and (@($r2.reasons) -join ' ') -match 'busy') 'a busy dispatcher must refuse cutover even under -Force'
  Assert-True (-not (Test-Path $flag)) 'the boundary refusal must not write the flag'
  Write-Utf8 "$testRoot\mock-agents.json" $rowsWithDispatcher

  # Case 3: a stale watchdog run -> refused.
  Write-Utf8 "$testRoot\state\watchdog\last-run.json" ('{"at":"' + (Get-Date).ToUniversalTime().AddMinutes(-90).ToString('o') + '","mode":"live","conditions":[]}')
  $r3 = Run-Script 'cutover-dispatcher.ps1' @('-SkipTaskCheck')
  Assert-True ($lastExit -eq 3 -and (@($r3.reasons) -join ' ') -match 'watchdog run') 'a stale watchdog run must refuse cutover'
  Assert-True (-not (Test-Path $flag)) 'the stale-run refusal must not write the flag'
  Write-Utf8 "$testRoot\state\watchdog\last-run.json" ('{"at":"' + (Get-Date).ToUniversalTime().AddMinutes(-3).ToString('o') + '","mode":"live","conditions":[]}')

  # Case 4: gates hold, -DryRun -> plan only.
  $r4 = Run-Script 'cutover-dispatcher.ps1' @('-SkipTaskCheck', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r4.dryRun -eq $true -and $r4.cutover -eq $false) 'a dry run must report the plan and exit 0'
  Assert-True ($r4.gates.notifierLive -eq $true) 'the dry run must show the passing notifier gate'
  Assert-True (-not (Test-Path $flag)) 'a dry run must not write the flag'
  Assert-True ((Get-LiveEntry 'dispatcher').status -eq 'active') 'a dry run must not retire'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^(stop|rm) ' }).Count -eq 0) 'a dry run must not stop anything'

  # Case 5: cutover.
  $r5 = Run-Script 'cutover-dispatcher.ps1' @('-SkipTaskCheck')
  Assert-True ($lastExit -eq 0 -and $r5.cutover -eq $true) "cutover must succeed past the gates: $lastOut"
  Assert-True (Test-Path $flag) 'cutover must write the flag'
  Assert-True ((Get-Content $flag -Raw) -match 'WS5, fleet #82') 'the flag must cite the ticket'
  Assert-True ((Get-LiveEntry 'dispatcher').status -eq 'retired') 'cutover must retire the live dispatcher entry'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^stop job-d' }).Count -eq 1) 'cutover must stop the dispatcher job'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^rm job-d' }).Count -ge 1) 'cutover must remove the dispatcher job'
  Assert-True (-not (Test-Path "$testRoot\state\heartbeats\dispatcher.json")) 'retirement removes the dispatcher heartbeat'
  $record = (Get-Content "$testRoot\state\dispatcher\cutover.json" -Raw) | ConvertFrom-Json
  Assert-True ($record.notifierLive -eq $true -and $record.forced -eq $false -and @($record.rollbacks).Count -eq 0) 'the cutover record must carry the gate evidence and no rollbacks'
  Assert-True ($lastOut -match 'rollback-dispatcher') 'cutover must say what stays for the rollback'
  $staticAfter = (Get-Content "$testRoot\roster.json" -Raw) | ConvertFrom-Json
  Assert-True (@($staticAfter.sessions | Where-Object { $_.name -eq 'dispatcher' }).Count -eq 1) 'the roster.json entry must survive as the rollback path'
  Assert-True ((Get-Hash "$testRoot\state\events\2026-09-01.jsonl") -eq $eventsHash) 'cutover must not touch the event ledger'

  # Case 6: cutover is idempotent.
  $callsBefore = @(Get-ClaudeCalls).Count
  $r6 = Run-Script 'cutover-dispatcher.ps1' @('-SkipTaskCheck')
  Assert-True ($lastExit -eq 0 -and $r6.alreadyCutOver -eq $true) 'a second cutover must report already cut over'
  Assert-True (@(Get-ClaudeCalls).Count -eq $callsBefore) 'a second cutover must call nothing'

  # Case 7: the launch door refuses the dispatcher while the flag stands; a dry run still evaluates.
  $r7 = Run-Script 'launch.ps1' @('-FromRoster', 'dispatcher')
  Assert-True ($lastExit -eq 3 -and $r7.launched -eq $false -and $r7.reason -match 'dispatcher-off') 'launch.ps1 must refuse the dispatcher under the flag'
  $r7b = Run-Script 'launch.ps1' @('-FromRoster', 'dispatcher', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r7b.dryRun -eq $true) "a dry run of the dispatcher launch must still evaluate under the flag: $lastOut"
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^--bg' }).Count -eq 0) 'nothing may have launched'

  # Case 8: rollback removes the flag, relaunches through the door, and records the rollback.
  $r8 = Run-Script 'rollback-dispatcher.ps1' @('-Reason', 'test rollback')
  Assert-True ($lastExit -eq 0 -and $r8.rolledBack -eq $true -and $r8.launched -eq $true) "rollback must relaunch: $lastOut"
  Assert-True (-not (Test-Path $flag)) 'rollback must remove the flag'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^--bg' }).Count -eq 1) 'rollback must launch exactly once'
  $record8 = (Get-Content "$testRoot\state\dispatcher\cutover.json" -Raw) | ConvertFrom-Json
  Assert-True (@($record8.rollbacks).Count -eq 1 -and $record8.rollbacks[0].launched -eq $true -and $record8.rollbacks[0].reason -eq 'test rollback' -and $record8.rollbacks[0].at) 'rollback must append one record'
  Assert-True ($record8.notifierLive -eq $true) 'rollback must keep the cutover record'

  # Case 9: rollback without the flag is refused.
  $callsBefore = @(Get-ClaudeCalls).Count
  $r9 = Run-Script 'rollback-dispatcher.ps1'
  Assert-True ($lastExit -eq 3 -and $r9.rolledBack -eq $false) 'rollback without the flag must exit 3'
  Assert-True (@(Get-ClaudeCalls).Count -eq $callsBefore) 'a refused rollback must call nothing'

  Write-Output 'dispatcher cutover tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_LAUNCH_FAIL -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-dcutover-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
