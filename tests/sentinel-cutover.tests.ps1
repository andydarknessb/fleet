# Ticket 08b: cutover-sentinel.ps1 against a fixture fleet with a mock `claude`, a mock
# daemon list, generated parity logs, and the real retire.ps1 and launch.ps1. The Sentinel
# is removed only past the parity gate, and cutover touches no ledger. Ticket 89 (after one
# release) retired bin/rollback-sentinel.ps1, agents/sentinel.md and the roster entry for
# good; this fixture's own inline roster.json still carries a sentinel entry so
# cutover-sentinel.ps1's own untouched behavior (it edits the live roster, never roster.json)
# stays exercised.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-cutover-test-" + [guid]::NewGuid().ToString('N'))
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
function Write-ParityLogs {
  # 49 clean hours: the Sentinel at :00/:15/:30/:45, the watchdog 90 s later.
  param([int]$Hours)
  Remove-Item "$testRoot\state\sentinel\shadow\*" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\sentinel\applied\*" -ErrorAction SilentlyContinue
  $start = (Get-Date).ToUniversalTime().AddHours(-$Hours)
  $sb = @{}; $ab = @{}
  for ($i = 0; $i -lt $Hours * 4; $i++) {
    $at = $start.AddMinutes(15 * $i)
    $day = $at.ToString('yyyyMMdd')
    $applied = '{"at":"' + $at.ToString('o') + '","actor":"sentinel","applied":true,"respawned":[],"launchNeeded":[],"escalate":[],"retired":[],"worktrees":[],"pause":null,"okCount":3}'
    $shadow = '{"at":"' + $at.AddSeconds(90).ToString('o') + '","mode":"shadow","conditions":[],"newlyPaged":[],"checkError":"","proposed":{"respawned":[],"launchNeeded":[],"escalate":[],"retired":[],"worktrees":[],"pause":null,"okCount":3},"verify":false}'
    if (-not $ab.ContainsKey($day)) { $ab[$day] = New-Object Text.StringBuilder; $sb[$day] = New-Object Text.StringBuilder }
    [void]$ab[$day].Append($applied + "`n"); [void]$sb[$day].Append($shadow + "`n")
  }
  foreach ($day in $ab.Keys) { Write-Utf8 "$testRoot\state\sentinel\applied\$day.jsonl" $ab[$day].ToString(); Write-Utf8 "$testRoot\state\sentinel\shadow\$day.jsonl" $sb[$day].ToString() }
}

try {
  foreach ($dir in 'bin','agents','tenants','state','state/heartbeats','state/sentinel','state/sentinel/shadow','state/sentinel/applied','state/skip','state/watchdog','state/escalations','state/events','state/sessions','state/flags','profile/.claude/jobs/job-s','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','cutover-sentinel.ps1','retire.ps1','launch.ps1','parity.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\agents\sentinel.md" "---`nname: sentinel`nmodel: sonnet`neffort: low`n---`nRole body."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" ('{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","tenant":null,"parent":"cory","cwd":"' + $testRoot.Replace('\', '\\') + '","prompt":"d"},{"name":"sentinel","role":"sentinel","tenant":null,"parent":"dispatcher","cwd":"' + $testRoot.Replace('\', '\\') + '","prompt":"You are the Sentinel."}]}')
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"sentinel","role":"sentinel","tenant":null,"parent":"dispatcher","issue":null,"cwd":null,"jobId":"job-s","sessionId":"sess-1","prompt":"You are the Sentinel.","status":"active","launchedAt":"2026-09-01T00:00:00Z"}]}'
  Write-Utf8 "$testRoot\state\heartbeats\sentinel.json" '{"name":"sentinel","at":"2026-09-01T00:00:00Z"}'
  Write-Utf8 "$testRoot\state\watchdog\last-run.json" ('{"at":"' + (Get-Date).ToUniversalTime().AddMinutes(-3).ToString('o') + '","mode":"shadow","conditions":[]}')
  Write-Utf8 "$testRoot\state\events\2026-09-01.jsonl" '{"sequence":1,"type":"work-created","recordId":"test:issue-1"}' + "`n"
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-s\state.json" '{"detail":"","waitingFor":""}'
  $rowsWithSentinel = '[{"id":"job-d","name":"dispatcher","state":"working","status":"idle","pid":11,"sessionId":"sess-d","startedAt":1756000000000},{"id":"job-s","name":"sentinel","state":"working","status":"idle","pid":12,"sessionId":"sess-1","startedAt":1756000001000}]'
  $rowsBusySentinel = $rowsWithSentinel.Replace('"status":"idle","pid":12', '"status":"busy","pid":12')
  $rowsAfterRm = '[{"id":"job-d","name":"dispatcher","state":"working","status":"idle","pid":11,"sessionId":"sess-d","startedAt":1756000000000}]'
  $rowsAfterLaunch = '[{"id":"job-d","name":"dispatcher","state":"working","status":"idle","pid":11,"sessionId":"sess-d","startedAt":1756000000000},{"id":"job-s2","name":"sentinel","state":"working","status":"idle","pid":14,"sessionId":"sess-2","startedAt":1756000002000}]'
  Write-Utf8 "$testRoot\mock-agents.json" $rowsWithSentinel
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
  $eventsHash = Get-Hash "$testRoot\state\events\2026-09-01.jsonl"

  # Case 1: no parity evidence -> refused; nothing changes.
  $r1 = Run-Script 'cutover-sentinel.ps1' @('-SkipTaskCheck')
  Assert-True ($lastExit -eq 3) "a failed gate must exit 3 (got $lastExit): $lastOut"
  Assert-True ($r1.cutover -eq $false -and (@($r1.reasons) -join ' ') -match 'parity') 'the refusal must name the parity gate'
  Assert-True (-not (Test-Path "$testRoot\state\flags\sentinel-off")) 'a refused cutover must not write the flag'
  Assert-True ((Get-LiveEntry 'sentinel').status -eq 'active') 'a refused cutover must not retire the Sentinel'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^(stop|rm) ' }).Count -eq 0) 'a refused cutover must not stop anything'

  # Case 1b: -Force overrides the failing parity gate and records the override. A dry run here
  # (this fixture can only go through one REAL cutover; ticket 89 removed the rollback path that
  # used to reset it for a second one) so the later plain cutover (Case 5) still has a clean flag
  # to write.
  $r1f = Run-Script 'cutover-sentinel.ps1' @('-SkipTaskCheck', '-Force', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r1f.dryRun -eq $true -and $r1f.cutover -eq $false -and $r1f.forced -eq $true) "-Force must override the failing parity gate on a dry run: $lastOut"
  Assert-True ((@($r1f.overridden) -join ' ') -match 'parity') 'a forced dry run must record what it would override'
  Assert-True (-not (Test-Path "$testRoot\state\flags\sentinel-off")) 'a forced dry run must not write the flag'

  # Case 2: parity holds but the Sentinel is mid-turn -> refused, and -Force does not override the boundary.
  Write-ParityLogs 49
  Write-Utf8 "$testRoot\mock-agents.json" $rowsBusySentinel
  $r2 = Run-Script 'cutover-sentinel.ps1' @('-SkipTaskCheck', '-Force')
  Assert-True ($lastExit -eq 3 -and (@($r2.reasons) -join ' ') -match 'busy') 'a busy Sentinel must refuse cutover even under -Force'
  Assert-True (-not (Test-Path "$testRoot\state\flags\sentinel-off")) 'the boundary refusal must not write the flag'
  Write-Utf8 "$testRoot\mock-agents.json" $rowsWithSentinel

  # Case 3: a stale watchdog run -> refused (the supervisor that would take over is not ticking).
  Write-Utf8 "$testRoot\state\watchdog\last-run.json" ('{"at":"' + (Get-Date).ToUniversalTime().AddMinutes(-90).ToString('o') + '","mode":"shadow","conditions":[]}')
  $r3 = Run-Script 'cutover-sentinel.ps1' @('-SkipTaskCheck')
  Assert-True ($lastExit -eq 3 -and (@($r3.reasons) -join ' ') -match 'watchdog run') 'a stale watchdog run must refuse cutover'
  Write-Utf8 "$testRoot\state\watchdog\last-run.json" ('{"at":"' + (Get-Date).ToUniversalTime().AddMinutes(-3).ToString('o') + '","mode":"shadow","conditions":[]}')

  # Case 4: gates hold, -DryRun -> plan only.
  $r4 = Run-Script 'cutover-sentinel.ps1' @('-SkipTaskCheck', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r4.dryRun -eq $true -and $r4.cutover -eq $false) 'a dry run must report the plan and exit 0'
  Assert-True ($r4.gates.parity.pass -eq $true -and $r4.gates.parity.continuousHours -ge 48) 'the dry run must show the passing parity gate'
  Assert-True (-not (Test-Path "$testRoot\state\flags\sentinel-off")) 'a dry run must not write the flag'
  Assert-True ((Get-LiveEntry 'sentinel').status -eq 'active') 'a dry run must not retire'

  # Case 5: cutover.
  $appliedFile = (Get-ChildItem "$testRoot\state\sentinel\applied" -Filter *.jsonl | Select-Object -First 1).FullName
  $appliedHash = Get-Hash $appliedFile
  $r5 = Run-Script 'cutover-sentinel.ps1' @('-SkipTaskCheck')
  Assert-True ($lastExit -eq 0 -and $r5.cutover -eq $true) "cutover must succeed past the gates: $lastOut"
  Assert-True (Test-Path "$testRoot\state\flags\sentinel-off") 'cutover must write the flag'
  Assert-True ((Get-Content "$testRoot\state\flags\sentinel-off" -Raw) -match 'rollback-sentinel') 'the flag must name the rollback path'
  Assert-True ((Get-LiveEntry 'sentinel').status -eq 'retired') 'cutover must retire the live Sentinel entry'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^stop job-s' }).Count -eq 1) 'cutover must stop the Sentinel job'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^rm job-s' }).Count -ge 1) 'cutover must remove the Sentinel job'
  Assert-True (-not (Test-Path "$testRoot\state\heartbeats\sentinel.json")) 'retirement removes the Sentinel heartbeat'
  $record = (Get-Content "$testRoot\state\sentinel\cutover.json" -Raw) | ConvertFrom-Json
  Assert-True ($record.parity.continuousHours -ge 48 -and $record.forced -eq $false) 'the cutover record must carry the parity evidence'
  Assert-True ($lastOut -match 'CONTEXT.md') 'cutover must print the paperwork checklist'
  $staticAfter = (Get-Content "$testRoot\roster.json" -Raw) | ConvertFrom-Json
  Assert-True (@($staticAfter.sessions | Where-Object { $_.name -eq 'sentinel' }).Count -eq 1) 'the roster.json entry must survive as the rollback path'
  Assert-True ((Get-Hash "$testRoot\state\events\2026-09-01.jsonl") -eq $eventsHash) 'cutover must not touch the event ledger'
  Assert-True ((Get-Hash $appliedFile) -eq $appliedHash) 'cutover must not touch the applied ledger'

  # Case 6: cutover is idempotent.
  $callsBefore = @(Get-ClaudeCalls).Count
  $r6 = Run-Script 'cutover-sentinel.ps1' @('-SkipTaskCheck')
  Assert-True ($lastExit -eq 0 -and $r6.alreadyCutOver -eq $true) 'a second cutover must report already cut over'
  Assert-True (@(Get-ClaudeCalls).Count -eq $callsBefore) 'a second cutover must call nothing'

  # Case 7: the launch door refuses the Sentinel while the flag stands; a dry run still evaluates.
  $r7 = Run-Script 'launch.ps1' @('-FromRoster', 'sentinel')
  Assert-True ($lastExit -eq 3 -and $r7.launched -eq $false -and $r7.reason -match 'sentinel-off') 'launch.ps1 must refuse the Sentinel under the flag'
  $r7b = Run-Script 'launch.ps1' @('-FromRoster', 'sentinel', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r7b.dryRun -eq $true) 'a dry run of the Sentinel launch must still evaluate under the flag'
  Assert-True (@(Get-ClaudeCalls | Where-Object { $_ -match '^--bg' }).Count -eq 0) 'nothing may have launched'

  # Ticket 89 (08b, after one release): bin/rollback-sentinel.ps1 is gone, so there is no
  # rollback case left to exercise here. -Force overriding a failing gate is covered by
  # Case 1b, on a dry run, before the fixture's one real cutover (Case 5).

  Write-Output 'sentinel cutover tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_LAUNCH_FAIL -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-cutover-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
