# 02/03 cutover: cutover-assignment.ps1 / rollback-assignment.ps1 against a fixture fleet with
# a mock `claude`, generated frontier-parity evidence, and the real launch.ps1, assignment.js
# and work-state.js. The planner becomes authoritative only past the parity gate; the launch
# door refuses a legacy IC prompt under the flag; rollback releases pending-acknowledgment
# manifests through the state door (one appended event each) and never rewrites a ledger.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-assignment-cutover-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Run-Script {
  param([string]$Script, [string[]]$Arguments = @())
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $testRoot
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\$Script" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; Pop-Location }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}
function Run-Node {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & node @Arguments 2>&1 | Out-String } finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}
function Get-Hash { param([string]$Path) (Get-FileHash $Path -Algorithm SHA256).Hash }
# Events are written to a file named for the EVENT DATE, so a fixture that seeds one dated
# ledger and then counts real-now events in it only works on that calendar day. Count across
# every ledger file instead; the seeded file stays as the immutability check.
function Get-EventLines { @(Get-ChildItem (Join-Path $testRoot 'state\events') -Filter *.jsonl -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ }) }
function Write-Evaluations {
  # Agreeing evaluations over five distinct frontiers, inside the trailing 48 h window and
  # reaching back past the 36 h coverage requirement: 24 of them two hours apart spans 46 h.
  param([int]$Count = 24)
  $dir = "$testRoot\state\assignment\shadow"
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  Remove-Item "$dir\*" -ErrorAction SilentlyContinue
  $frontiers = @('[]', '[101]', '[101,102]', '[103]', '[104,105]')
  $lines = @()
  for ($i = 0; $i -lt $Count; $i++) {
    # Gaps of 120 minutes: 24 evaluations span 46 h, inside the 48 h window and past the 36 h floor.
    $at = (Get-Date).ToUniversalTime().AddMinutes(-(($Count - $i) * 120)).ToString('o')
    $f = $frontiers[$i % $frontiers.Count]
    $lines += ('{"at":"' + $at + '","tenant":"test","mode":"shadow","hook":{"frontier":' + $f + ',"reason":"fixture"},"planner":{"frontier":' + $f + ',"excluded":[],"error":null},"agree":true,"differences":[]}')
  }
  Write-Utf8 "$dir\fixture.jsonl" (($lines -join "`n") + "`n")
}

try {
  foreach ($dir in 'bin','hooks','agents','tenants','config','state','state/sessions','state/notices','state/work','state/events','state/rotation','state/flags','state/heartbeats','state/manifests','state/exclusions','mock-bin','repo') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1','recover.ps1','cutover-assignment.ps1','rollback-assignment.ps1','assignment.js','assignment-parity.js','work-state.js','exclusions.js','notify.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: sonnet`neffort: low`n---`nRole body for ic."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $repoPath = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","defaultBranch":"integration","branchPrefix":"fleet/","maxIcs":2,"checks":{"unit":"npm test"},"ciGates":["test-build"],"repo":' + ($repoPath | ConvertTo-Json) + '}')
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  $eventsFile = "$testRoot\state\events\2026-09-04.jsonl"
  Write-Utf8 $eventsFile ('{"schemaVersion":1,"recordId":"test:issue-1","sequence":1,"revision":1,"type":"work-created","actor":"fixture","at":"2026-09-04T00:00:00.000Z"}' + "`n")
  $eventsHash = Get-Hash $eventsFile
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs") | Out-Null

  # Case 1: no parity evidence -> refused; nothing changes.
  $r1 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test')
  Assert-True ($lastExit -eq 3) "a failed gate must exit 3 (got $lastExit): $lastOut"
  Assert-True ($r1.cutover -eq $false -and (@($r1.reasons) -join ' ') -match 'parity') 'the refusal must name the parity gate'
  Assert-True (-not (Test-Path "$testRoot\state\flags\assignment-live")) 'a refused cutover must not write the flag'

  # Case 2: one frontier repeated twenty times is not evidence.
  $dir = "$testRoot\state\assignment\shadow"; [IO.Directory]::CreateDirectory($dir) | Out-Null
  $same = @(); for ($i = 0; $i -lt 20; $i++) { $same += '{"at":"2026-09-04T00:' + ('{0:d2}' -f $i) + ':00.000Z","tenant":"test","mode":"shadow","hook":{"frontier":[7]},"planner":{"frontier":[7],"excluded":[],"error":null},"agree":true,"differences":[]}' }
  Write-Utf8 "$dir\fixture.jsonl" (($same -join "`n") + "`n")
  $r2 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test')
  Assert-True ($lastExit -eq 3 -and (@($r2.reasons) -join ' ') -match 'distinct frontiers') 'a single repeated frontier must fail the gate'

  # Case 3: gates hold, -DryRun -> plan only.
  Write-Evaluations
  $r3 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r3.dryRun -eq $true -and $r3.cutover -eq $false) "a dry run must report the plan and exit 0: $lastOut"
  Assert-True ($r3.gates.parity.pass -eq $true -and $r3.gates.parity.evaluations -eq 24 -and $r3.gates.parity.distinctFrontiers -eq 5) 'the dry run must show the passing parity gate'
  Assert-True (-not (Test-Path "$testRoot\state\flags\assignment-live")) 'a dry run must not write the flag'

  # Case 4: a legacy IC launch passes the door before cutover (dry run).
  $r4 = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', '/mattpocock-skills:implement legacy brief', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r4.dryRun -eq $true) "a legacy IC launch must pass before cutover: $lastOut"

  # Case 5: cutover.
  $r5 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test')
  Assert-True ($lastExit -eq 0 -and $r5.cutover -eq $true) "cutover must succeed past the gates: $lastOut"
  Assert-True (Test-Path "$testRoot\state\flags\assignment-live") 'cutover must write the flag'
  Assert-True ((Get-Content "$testRoot\state\flags\assignment-live" -Raw) -match 'rollback-assignment') 'the flag must name the rollback path'
  $record = (Get-Content "$testRoot\state\assignment\cutover.json" -Raw) | ConvertFrom-Json
  Assert-True ($record.parity.evaluations -eq 24 -and $record.forced -eq $false) 'the cutover record must carry the parity evidence'
  Assert-True ($lastOut -match 'status.ps1') 'cutover must print the paperwork checklist'
  Assert-True ((Get-Hash $eventsFile) -eq $eventsHash) 'cutover must not touch the event ledger'

  # Case 6: cutover is idempotent.
  $r6 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test')
  Assert-True ($lastExit -eq 0 -and $r6.alreadyCutOver -eq $true) 'a second cutover must report already cut over'

  # Case 7: the launch door refuses a legacy IC prompt under the flag; a dry run still evaluates.
  $r7 = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', '/mattpocock-skills:implement legacy brief')
  Assert-True ($lastExit -eq 3 -and $r7.launched -eq $false -and $r7.reason -match 'assignment-live') "launch.ps1 must refuse a legacy IC under the flag: $lastOut"
  $r7b = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', '/mattpocock-skills:implement legacy brief', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r7b.dryRun -eq $true) 'a dry run of a legacy IC launch must still evaluate under the flag'
  $r7c = Run-Script 'launch.ps1' @('-Role', 'pl-test', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r7c.dryRun -eq $true) 'a control-plane launch is not the flag''s business'
  # The refusal keys on the name as well as the role, the way the sibling Sentinel gate does.
  $r7d = Run-Script 'launch.ps1' @('-Role', 'sonnet-ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', 'legacy')
  Assert-True ($lastExit -eq 3 -and $r7d.reason -match 'assignment-live') "an ic-named launch must be refused whatever its -Role: $lastOut"
  # Reboot recovery relaunches an IC that is ALREADY on the live roster, so its unit is already
  # reserved: -Recover is exempt from this guard, or a reboot strands in-flight work.
  $r7e = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', 'legacy', '-Recover', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r7e.dryRun -eq $true) "a -Recover relaunch must pass the assignment-live guard: $lastOut"
  Assert-True ((Get-Content "$testRoot\bin\recover.ps1" -Raw) -match '-Prompt \$e\.prompt -Recover') 'recover.ps1 must pass -Recover when it relaunches an IC'
  # -Recover exempts ONLY this guard: PAUSE still stops it.
  Write-Utf8 "$testRoot\state\PAUSE" 'testing'
  $r7f = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', 'legacy', '-Recover')
  Assert-True ($lastExit -eq 3 -and $r7f.reason -match 'PAUSE') "-Recover must not bypass PAUSE: $lastOut"
  Remove-Item "$testRoot\state\PAUSE"

  # Case 8: a manifest reserved by the planner launches through the door under the flag (dry run),
  # and the manifest carries the tenant's checks and CI gates as pointers.
  $fixture = "$testRoot\issues.json"
  Write-Utf8 $fixture '[{"number":101,"title":"Fixture issue","url":"https://github.com/owner/repo/issues/101","body":"criteria","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  $r8 = Run-Node @("$testRoot\bin\assignment.js", 'assign', '--root', $testRoot, '--tenant', 'test', '--tenant-config', "$testRoot\tenants\test.json", '--fixture', $fixture, '--base-sha', ('a' * 40), '--parent', 'pl-test', '--model', 'sonnet', '--adr-paths', 'docs/adr/0002-one-launch-door.md')
  Assert-True ($lastExit -eq 0 -and $r8.manifestPath) "assign must reserve a manifest: $lastOut"
  $manifest = (Get-Content $r8.manifestPath -Raw) | ConvertFrom-Json
  Assert-True ($manifest.status -eq 'pending-ack' -and $manifest.workRecordId -eq 'test:issue-101') 'the manifest must be pending acknowledgment for its Work record'
  Assert-True (@($manifest.ciGates) -contains 'test-build' -and (@($manifest.testPlan) -join ' ') -match 'unit: npm test' -and @($manifest.adrPaths) -contains 'docs/adr/0002-one-launch-door.md') 'the manifest must carry the tenant checks, CI gates, and the ADR pointer'
  $r8b = Run-Script 'launch.ps1' @('-Manifest', $r8.manifestPath, '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r8b.dryRun -eq $true -and $r8b.name -eq 'ic-101') "a manifest launch must pass the door under the flag: $lastOut"
  Assert-True ((Get-Content "$testRoot\state\sessions\ic-101.settings.json" -Raw) -match 'FLEET_WORK_RECORD_ID') 'the manifest launch must carry the Work record identity into the session'
  $eventsAfterReserve = @(Get-EventLines).Count

  # Case 9: rollback -DryRun lists the pending manifest and changes nothing.
  $r9 = Run-Script 'rollback-assignment.ps1' @('-DryRun')
  Assert-True ($lastExit -eq 0 -and $r9.dryRun -eq $true -and @($r9.pending).Count -eq 1 -and $r9.pending[0].id -eq 'test:issue-101') "rollback dry run must list the pending manifest: $lastOut"
  Assert-True (Test-Path "$testRoot\state\flags\assignment-live") 'rollback dry run must keep the flag'

  # Case 9b: a rollback whose release fails restores the flag (a standing reservation the legacy
  # hook cannot see is worse than a fail-closed hook).
  $env:FLEET_NODE_PATH = "$testRoot\no-such-node.exe"
  $r9b = Run-Script 'rollback-assignment.ps1'
  Remove-Item Env:FLEET_NODE_PATH
  Assert-True ($lastExit -eq 5 -and $r9b.rolledBack -eq $false -and $r9b.flagRestored -eq $true -and @($r9b.failed).Count -eq 1) "a failed release must report and restore the flag: $lastOut"
  Assert-True (Test-Path "$testRoot\state\flags\assignment-live") 'the flag must be back after a failed release'
  Assert-True ((Get-Content "$testRoot\state\flags\assignment-live" -Raw) -match 'rollback-assignment') 'the restored flag keeps its text'
  Assert-True (-not (Test-Path "$($r8.manifestPath).invalidated.json")) 'a failed release must not invalidate the manifest'
  Assert-True (@(Get-EventLines).Count -eq $eventsAfterReserve) 'a failed release must append no event'

  # Case 10: rollback removes the flag and releases the pending manifest through the state door.
  $r10 = Run-Script 'rollback-assignment.ps1'
  Assert-True ($lastExit -eq 0 -and $r10.rolledBack -eq $true -and @($r10.released) -contains 'test:issue-101' -and @($r10.failed).Count -eq 0) "rollback must release the pending manifest: $lastOut"
  Assert-True (-not (Test-Path "$testRoot\state\flags\assignment-live")) 'rollback must remove the flag'
  Assert-True (Test-Path "$($r8.manifestPath).invalidated.json") 'rollback must invalidate the released manifest'
  $activeAfter = (Get-Content "$testRoot\state\work\active.json" -Raw) | ConvertFrom-Json
  Assert-True ($null -eq $activeAfter.records.PSObject.Properties['test:issue-101']) 'the released record must leave active state'
  Assert-True (Test-Path "$testRoot\state\releases\work-test_issue-101.json") 'the unused reservation must be stored as released, not terminally archived'
  Assert-True (-not (Test-Path "$testRoot\state\archive\work-test_issue-101.json")) 'an unused reservation must not consume the terminal archive key'
  $eventLines = @(Get-EventLines)
  Assert-True ($eventLines.Count -eq ($eventsAfterReserve + 1) -and $eventLines[-1] -match '"type":"assignment-released"') 'rollback must append exactly one assignment-released event'
  Assert-True ($eventLines[0] -match 'work-created' -and (Get-Hash $eventsFile) -eq $eventsHash) 'rollback must not rewrite earlier ledger lines'
  $record2 = (Get-Content "$testRoot\state\assignment\cutover.json" -Raw) | ConvertFrom-Json
  Assert-True (@($record2.rollbacks).Count -eq 2 -and $record2.rollbacks[0].flagRestored -eq $true -and @($record2.rollbacks[1].released) -contains 'test:issue-101') 'rollback must append a record for the failed attempt and the successful one'
  $r10b = Run-Script 'rollback-assignment.ps1'
  Assert-True ($lastExit -eq 0 -and $r10b.rolledBack -eq $false) 'rollback without the flag is a no-op'
  $r10c = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', '/mattpocock-skills:implement legacy brief', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r10c.dryRun -eq $true) 'after rollback the legacy IC launch passes the door again'

  # Case 11: -Force cuts over past a failed parity gate and records the override.
  Remove-Item "$testRoot\state\assignment\shadow\*"
  $r11 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test')
  Assert-True ($lastExit -eq 3) 'without evidence the gate fails again'
  $r11f = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test', '-Force')
  Assert-True ($lastExit -eq 0 -and $r11f.cutover -eq $true -and $r11f.forced -eq $true) "-Force must cut over past the parity gate: $lastOut"
  $record3 = (Get-Content "$testRoot\state\assignment\cutover.json" -Raw) | ConvertFrom-Json
  Assert-True ($record3.forced -eq $true -and (@($record3.overridden) -join ' ') -match 'parity') 'a forced cutover must record what it overrode'

  Write-Output 'assignment cutover tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-assignment-cutover-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
