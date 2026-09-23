# Ticket 06: rotation happens only at a safe boundary, records one offset, launches
# through launch.ps1, and recovers from a crash between stop and launch. retire.ps1,
# launch.ps1, and pr-watch.js are stubbed; rotation-policy.js and rotate.ps1 are real.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-rotation-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Set-LiveRoster { param([string]$LaunchedAt, [string]$Status = 'active')
  Write-Utf8 "$testRoot\state\roster.json" (@{ sessions = @(@{ name = 'dispatcher'; role = 'dispatcher'; tenant = $null; sessionId = 'sess-old'; jobId = 'job-old'; status = $Status; launchedAt = $LaunchedAt }) } | ConvertTo-Json -Depth 8)
}
function Set-AgentsRows { param([string]$Json) Write-Utf8 "$testRoot\mock-agents.json" $Json }
function Reset-Markers {
  Remove-Item "$testRoot\retire-calls.log", "$testRoot\launch-calls.log", "$testRoot\reconcile-calls.log" -ErrorAction SilentlyContinue
  Remove-Item "$testRoot\state\rotation\*.json" -ErrorAction SilentlyContinue
}
function Run-Rotate {
  param([string[]]$Arguments)
  # 2>&1 on a native command under EAP Stop turns child stderr into a terminating
  # ErrorRecord (PS 5.1); relax around the call so refusal messages stay data.
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\rotate.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
}
$idleRow = '[{"id":"job-old","name":"dispatcher","state":"working","status":"idle","pid":11,"sessionId":"sess-old","startedAt":1786115823884}]'
$busyRow = $idleRow.Replace('"status":"idle"', '"status":"busy"')

try {
  foreach ($dir in 'bin','tenants','config','state','state/work','state/work/pending','state/events','state/rotation','state/flags','state/heartbeats','mock-bin','profile') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','rotate.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\bin\rotation-policy.js", "$testRoot\bin\rotation-policy.js")
  # rotation-policy.js has required ./work-state since 359dc20 (fleet #4's shared
  # parseArgs); without this copy the whole suite died at module load with "Cannot
  # find module './work-state'" before a single case ran (review finding 6).
  [IO.File]::Copy("$sourceRoot\bin\work-state.js", "$testRoot\bin\work-state.js")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")

  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[{"name":"dispatcher","role":"dispatcher","parent":"cory"}]}'
  Write-Utf8 "$testRoot\tenants\test.json" '{"name":"test","github":"owner/repo"}'
  Write-Utf8 "$testRoot\state\events\2026-09-01.jsonl" ('{"recordId":"test:issue-1","sequence":1,"type":"work-created","at":"2026-09-01T10:00:00.000Z"}' + "`n" + '{"recordId":"test:issue-1","sequence":2,"type":"state-merged","at":"2026-09-01T11:00:00.000Z"}' + "`n")

  # Stubs: retire marks the roster row retired and removes the daemon row; launch appends
  # a fresh entry and daemon row; pr-watch logs the reconcile call.
  # The retire stub reproduces the real script's exit-code shape: claude/git inside
  # retire.ps1 leave a nonzero $LASTEXITCODE on a SUCCESSFUL retire (claude rm refuses
  # dirty worktrees), so rotate must read success from the JSON line, never the code.
  Write-Utf8 "$testRoot\bin\retire.ps1" @'
param([Parameter(Mandatory)][string]$Name, [string]$Reason = 'done')
$root = Split-Path -Parent $PSScriptRoot
Add-Content "$root\retire-calls.log" "$Name|$Reason"
if ($env:MOCK_RETIRE_FAIL -eq '1') { Write-Error 'no live roster entry'; exit 4 }
$r = Get-Content "$root\state\roster.json" -Raw | ConvertFrom-Json
foreach ($s in $r.sessions) { if ($s.name -eq $Name) { $s.status = 'retired' } }
[IO.File]::WriteAllText("$root\state\roster.json", ($r | ConvertTo-Json -Depth 8))
$rows = @((Get-Content "$root\mock-agents.json" -Raw | ConvertFrom-Json) | Where-Object { $_.name -ne $Name })
$json = if ($rows.Count -eq 0) { '[]' } else { ConvertTo-Json $rows -Depth 5 }
if ($rows.Count -eq 1) { $json = "[$json]" }
[IO.File]::WriteAllText("$root\mock-agents.json", $json)
& cmd /c exit 9
Write-Output ('{"retired":"' + $Name + '","jobRemoval":"removed"}')
'@
  Write-Utf8 "$testRoot\bin\launch.ps1" @'
param([string]$FromRoster, [switch]$Force)
$root = Split-Path -Parent $PSScriptRoot
$forceMark = if ($Force) { '|force' } else { '' }
Add-Content "$root\launch-calls.log" "$FromRoster$forceMark"
if ($env:MOCK_LAUNCH_FAIL -eq '1') { Write-Output '{"launched":false,"reason":"cap reached (6/6)"}'; exit 3 }
Write-Output ('{"launched":true,"name":"' + $FromRoster + '","jobId":"job-new","sessionId":"sess-new"}')
exit 0
'@
  Write-Utf8 "$testRoot\bin\pr-watch.js" @'
const fs = require('node:fs'), path = require('node:path');
fs.appendFileSync(path.join(__dirname, '..', 'reconcile-calls.log'), process.argv.slice(2).join(' ') + '\n');
console.log(JSON.stringify({ ok: true }));
'@
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_CLAUDE_FAIL%"=="1" exit /b 9' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"

  $young = (Get-Date).ToUniversalTime().AddHours(-2).ToString('o')
  $old = (Get-Date).ToUniversalTime().AddHours(-30).ToString('o')

  # Case 1: young session -> -Auto rotates nothing.
  Set-LiveRoster $young; Set-AgentsRows $idleRow; Reset-Markers
  $r1 = Run-Rotate @('-Auto')
  Assert-True ($script:lastExit -eq 0) 'a no-op auto run must exit 0'
  Assert-True (@($r1.rotated).Count -eq 0) 'a young session must not rotate'
  Assert-True (-not (Test-Path "$testRoot\launch-calls.log")) 'no launch may happen below threshold'

  # Case 2: age-due session at an idle boundary -> one offset, retire, reconcile, launch.
  Set-LiveRoster $old; Set-AgentsRows $idleRow; Reset-Markers
  $r2 = Run-Rotate @('-Auto')
  Assert-True (@($r2.rotated) -contains 'dispatcher') 'an age-due idle session must rotate'
  $intent = Get-Content "$testRoot\state\rotation\dispatcher.json" -Raw | ConvertFrom-Json
  Assert-True ($intent.phase -eq 'launched') 'the completed rotation must record phase launched'
  Assert-True ($intent.offset.totalEvents -eq 2) 'the intent must carry the event offset'
  Assert-True (@($intent.reasons) -join ' ' -match 'age') 'the intent must record the threshold reason'
  Assert-True ((Get-Content "$testRoot\retire-calls.log" -Raw) -match 'dispatcher\|rotation: age') 'retire.ps1 must be called with the rotation reason'
  Assert-True ((Get-Content "$testRoot\launch-calls.log" -Raw).Trim() -eq 'dispatcher') 'the replacement must launch through launch.ps1 -FromRoster'
  Assert-True (Test-Path "$testRoot\reconcile-calls.log") 'active Work records must be reconciled before the replacement acts'
  Assert-True ($intent.newSessionId -eq 'sess-new') 'the intent must record the replacement session'

  # Case 2b: an age-due idle session with a pending permission prompt (job state
  # `needs` matching "approve ...") must defer, not rotate - the boundary check did
  # not read `needs` before this fix, so it rotated a blocked-on-a-prompt session.
  # -Force does not override this boundary (same standing as busy).
  Set-LiveRoster $old; Set-AgentsRows $idleRow; Reset-Markers
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-old") | Out-Null
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-old\state.json" '{"needs":"approve Read: some/secret.env","updatedAt":"2026-09-06T12:00:00.000Z"}'
  $r2b = Run-Rotate @('-Auto')
  Assert-True (@($r2b.rotated).Count -eq 0) 'a session with a pending permission prompt must not rotate'
  Assert-True (@($r2b.deferred).Count -eq 1 -and "$($r2b.deferred)" -match 'approve') 'the deferral must name the pending permission prompt'
  Assert-True (-not (Test-Path "$testRoot\state\rotation\dispatcher.json")) 'a deferred rotation must write no intent'
  Assert-True (-not (Test-Path "$testRoot\retire-calls.log")) 'a deferred rotation must not stop the session'
  $r2c = Run-Rotate @('-Name', 'dispatcher', '-Force')
  Assert-True (@($r2c.rotated).Count -eq 0) '-Force must not override a pending permission prompt'
  Assert-True (@($r2c.outcomes | Where-Object { $_.status -eq 'deferred' }).Count -eq 1) '-Force still defers on a pending prompt, same standing as busy'
  Remove-Item "$testRoot\profile\.claude\jobs\job-old" -Recurse -Force

  # Case 3: mid-turn session -> deferred, no intent, no stop.
  Set-LiveRoster $old; Set-AgentsRows $busyRow; Reset-Markers
  $r3 = Run-Rotate @('-Auto')
  Assert-True (@($r3.rotated).Count -eq 0) 'a busy session must not rotate'
  Assert-True (@($r3.deferred).Count -eq 1) 'a busy session must be deferred'
  Assert-True (-not (Test-Path "$testRoot\state\rotation\dispatcher.json")) 'a deferred rotation must write no intent'
  Assert-True (-not (Test-Path "$testRoot\retire-calls.log")) 'a deferred rotation must not stop the session'

  # Case 4: a held work-state lock defers; so does a pending journal.
  Set-LiveRoster $old; Set-AgentsRows $idleRow; Reset-Markers
  Write-Utf8 "$testRoot\state\work\.lock" '{"pid":1}'
  $r4 = Run-Rotate @('-Auto')
  Assert-True (@($r4.deferred).Count -eq 1 -and "$($r4.deferred)" -match 'lock') 'a held work-state lock must defer rotation'
  Remove-Item "$testRoot\state\work\.lock"
  Write-Utf8 "$testRoot\state\work\pending\x.json" '{"recordId":"r"}'
  $r4b = Run-Rotate @('-Auto')
  Assert-True (@($r4b.deferred).Count -eq 1 -and "$($r4b.deferred)" -match 'journal') 'a pending journal must defer rotation'
  Remove-Item "$testRoot\state\work\pending\x.json"

  # Case 5: PAUSE and the rotation-off flag are gates; -Force -Name overrides the flag only.
  Set-LiveRoster $old; Set-AgentsRows $idleRow; Reset-Markers
  Write-Utf8 "$testRoot\state\PAUSE" 'rate limit'
  $r5 = Run-Rotate @('-Auto')
  Assert-True ($script:lastExit -eq 3 -and "$($r5.reason)" -match 'PAUSE') 'PAUSE must refuse rotation'
  Remove-Item "$testRoot\state\PAUSE"
  Write-Utf8 "$testRoot\state\flags\rotation-off" 'rollback 2026-09-01'
  $r5b = Run-Rotate @('-Auto')
  Assert-True ($script:lastExit -eq 3 -and "$($r5b.reason)" -match 'rotation-off') 'the rotation-off flag must disable auto rotation'
  Assert-True (-not (Test-Path "$testRoot\retire-calls.log")) 'a disabled rotation must not stop anything'
  $r5c = Run-Rotate @('-Name', 'dispatcher', '-Force')
  Assert-True (@($r5c.rotated) -contains 'dispatcher') '-Force -Name must rotate despite the flag'
  Assert-True ((Get-Content "$testRoot\state\rotation\dispatcher.json" -Raw | ConvertFrom-Json).reasons -join ' ' -match 'forced') 'a forced rotation must record its reason'
  Assert-True ((Get-Content "$testRoot\launch-calls.log" -Raw) -match 'dispatcher\|force') 'a forced rotation must pass -Force through to launch.ps1'
  Remove-Item "$testRoot\state\flags\rotation-off"

  # Case 5d: -Force under PAUSE must not strand the role: the replacement launch
  # carries -Force too, so the gate the operator overrode cannot half-apply.
  Set-LiveRoster $old; Set-AgentsRows $idleRow; Reset-Markers
  Write-Utf8 "$testRoot\state\PAUSE" 'maintenance'
  $r5d = Run-Rotate @('-Name', 'dispatcher', '-Force')
  Assert-True (@($r5d.rotated) -contains 'dispatcher') '-Force must rotate under PAUSE'
  Assert-True ((Get-Content "$testRoot\launch-calls.log" -Raw) -match 'dispatcher\|force') 'the forced replacement must launch with -Force'
  Remove-Item "$testRoot\state\PAUSE"

  # Case 5e: a young -Name without -Force is skipped; adding -Auto still sweeps.
  Set-LiveRoster $young; Set-AgentsRows $idleRow; Reset-Markers
  $r5e = Run-Rotate @('-Name', 'dispatcher', '-Auto')
  Assert-True ($script:lastExit -eq 0) 'a skipped named rotation must not fail the run'
  Assert-True (@($r5e.rotated).Count -eq 0) 'a young named session must be skipped'
  Assert-True (@($r5e.outcomes | Where-Object { $_.status -eq 'skipped' }).Count -eq 1) 'the skip must be a typed outcome'
  Assert-True (-not (Test-Path "$testRoot\launch-calls.log")) 'a skipped name with an empty sweep must launch nothing'

  # Case 6: crash between stop and launch -> resume completes from intent + offset.
  Set-LiveRoster $old 'retired'; Set-AgentsRows '[]'; Reset-Markers
  Write-Utf8 "$testRoot\state\rotation\dispatcher.json" (@{ schemaVersion = 1; name = 'dispatcher'; phase = 'stopped'; reasons = @('age 30.0h >= 24h'); savedAt = (Get-Date).ToUniversalTime().ToString('o'); oldSessionId = 'sess-old'; oldJobId = 'job-old'; offset = @{ totalEvents = 2 } } | ConvertTo-Json -Depth 8)
  $r6 = Run-Rotate @('-Resume')
  Assert-True (@($r6.rotated) -contains 'dispatcher') 'a stopped intent with no live session must resume to launched'
  Assert-True ((Get-Content "$testRoot\launch-calls.log" -Raw).Trim() -eq 'dispatcher') 'resume must launch through launch.ps1'
  $intent6 = Get-Content "$testRoot\state\rotation\dispatcher.json" -Raw | ConvertFrom-Json
  Assert-True ($intent6.phase -eq 'launched') 'resume must complete the intent'
  Assert-True ($intent6.offset.totalEvents -eq 2) 'resume must keep the saved offset'

  # Case 6b: crash mid-stop (predecessor still alive) -> resume retires it first.
  Set-LiveRoster $old 'active'; Set-AgentsRows $idleRow; Reset-Markers
  Write-Utf8 "$testRoot\state\rotation\dispatcher.json" (@{ schemaVersion = 1; name = 'dispatcher'; phase = 'stopping'; reasons = @('age'); savedAt = (Get-Date).ToUniversalTime().ToString('o'); oldSessionId = 'sess-old'; oldJobId = 'job-old'; offset = @{ totalEvents = 2 } } | ConvertTo-Json -Depth 8)
  $r6b = Run-Rotate @('-Resume')
  Assert-True (@($r6b.rotated) -contains 'dispatcher') 'a stopping intent must resume to launched'
  Assert-True ((Get-Content "$testRoot\retire-calls.log" -Raw) -match 'resumed') 'resume must finish retiring the live predecessor'

  # Case 7: launch failure keeps the intent recoverable; the next run completes it.
  Set-LiveRoster $old 'active'; Set-AgentsRows $idleRow; Reset-Markers
  $env:MOCK_LAUNCH_FAIL = '1'
  $r7 = Run-Rotate @('-Auto')
  Assert-True ($script:lastExit -eq 5) 'a failed replacement launch must exit nonzero'
  $intent7 = Get-Content "$testRoot\state\rotation\dispatcher.json" -Raw | ConvertFrom-Json
  Assert-True ($intent7.phase -eq 'stopped') 'a failed launch must leave the intent stopped'
  Assert-True ("$($intent7.launchError.reason)" -match 'cap') 'the launch error must be recorded'
  Remove-Item Env:MOCK_LAUNCH_FAIL
  $r7b = Run-Rotate @('-Auto')
  Assert-True (@($r7b.rotated) -contains 'dispatcher') 'the next auto run must complete the interrupted rotation'

  # Case 7b: an unreadable daemon list defers the rotation (a bad read must not
  # look like an idle boundary).
  Set-LiveRoster $old 'active'; Set-AgentsRows $idleRow; Reset-Markers
  $env:MOCK_CLAUDE_FAIL = '1'
  $r7c = Run-Rotate @('-Auto')
  Assert-True ($script:lastExit -eq 0) 'an unreadable-list deferral is not a failure'
  Assert-True (@($r7c.deferred).Count -eq 1 -and "$($r7c.deferred)" -match 'unreadable') 'an unreadable daemon list must defer, naming the cause'
  Assert-True (-not (Test-Path "$testRoot\retire-calls.log")) 'nothing may be stopped off an unreadable list'
  Remove-Item Env:MOCK_CLAUDE_FAIL

  # Case 8: -DryRun reports and writes nothing; unknown names are refused.
  Set-LiveRoster $old 'active'; Set-AgentsRows $idleRow; Reset-Markers
  $r8 = Run-Rotate @('-Auto', '-DryRun')
  Assert-True ($r8.outcomes[0].wouldRotate -eq $true) '-DryRun must report the due rotation'
  Assert-True (-not (Test-Path "$testRoot\state\rotation\dispatcher.json")) '-DryRun must write no intent'
  Assert-True (-not (Test-Path "$testRoot\retire-calls.log")) '-DryRun must not stop anything'
  $null = Run-Rotate @('-Name', 'nobody', '-Force')
  Assert-True ($script:lastExit -eq 4) 'a name off the static roster must be refused'


  # Ticket 09 ruling 2: -Wake rotates now for the given reason, at the boundary only, without -Force.
  Set-LiveRoster $young; Set-AgentsRows $idleRow; Reset-Markers
  $rw = Run-Rotate @('-Name', 'dispatcher', '-Wake', 'frontier #501', '-NoReconcile')
  Assert-True (@($rw.rotated) -contains 'dispatcher') "a -Wake must rotate a young idle session: $lastOut"
  Assert-True ((Get-Content "$testRoot\launch-calls.log" -Raw).Trim() -eq 'dispatcher') 'a wake must relaunch through launch.ps1 without -Force'
  $intentW = (Get-Content "$testRoot\state\rotation\dispatcher.json" -Raw) | ConvertFrom-Json
  Assert-True ((@($intentW.reasons) -join ' ') -match 'frontier-wake: frontier #501') 'the intent must carry the wake reason'
  Set-LiveRoster $young; Set-AgentsRows $busyRow; Reset-Markers
  $rwb = Run-Rotate @('-Name', 'dispatcher', '-Wake', 'frontier #501', '-NoReconcile')
  Assert-True ((@($rwb.deferred) -join ' ') -match 'busy') 'a wake must defer at a busy boundary like any rotation'
  Write-Utf8 "$testRoot\state\flags\rotation-off" 'x'
  Set-LiveRoster $young; Set-AgentsRows $idleRow; Reset-Markers
  $eap2 = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $rwc = Run-Rotate @('-Name', 'dispatcher', '-Wake', 'frontier #501', '-NoReconcile')
  $ErrorActionPreference = $eap2
  Assert-True (-not (Test-Path "$testRoot\launch-calls.log") -or (Get-Content "$testRoot\launch-calls.log" -Raw).Trim() -eq '') 'rotation-off must stop a wake too'
  Remove-Item "$testRoot\state\flags\rotation-off"

  Write-Output 'rotation tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_LAUNCH_FAIL, Env:MOCK_RETIRE_FAIL, Env:MOCK_CLAUDE_FAIL -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-rotation-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
