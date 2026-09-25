# 02/03 cutover: cutover-assignment.ps1 against a fixture fleet with a mock `claude`,
# generated frontier-parity evidence, and the real launch.ps1, assignment.js and
# work-state.js. The planner becomes authoritative only past the parity gate. Ticket 89
# (ADR 0006, after one release) retired bin/rollback-assignment.ps1 and the launch door's
# flag-gated legacy IC refusal: a `-Prompt` IC launch is refused unconditionally now, with
# no flag or -Force to bring it back.
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
  foreach ($f in '_common.ps1','launch.ps1','recover.ps1','cutover-assignment.ps1','assignment.js','premises.js','assignment-parity.js','work-state.js','exclusions.js','notify.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
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
  # Claude Code 2.1.281 trust pre-flight (launch.ps1 Test-WorkspaceTrusted): trust the test root so every path under it launches.
  [IO.Directory]::CreateDirectory("$testRoot\profile") | Out-Null
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
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

  # Case 2b: -Force overrides the failing gate and records the override. A dry run here (the
  # fixture can only go through one REAL cutover; ticket 89 removed the rollback path that used
  # to reset it for a second one) so the later plain cutover (Case 5) still has a clean flag to write.
  $r2f = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test', '-Force', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r2f.dryRun -eq $true -and $r2f.cutover -eq $false -and $r2f.forced -eq $true) "-Force must override the failing gate on a dry run: $lastOut"
  Assert-True ((@($r2f.overridden) -join ' ') -match 'distinct frontiers') 'a forced dry run must record what it would override'
  Assert-True (-not (Test-Path "$testRoot\state\flags\assignment-live")) 'a forced dry run must not write the flag'

  # Case 3: gates hold, -DryRun -> plan only.
  Write-Evaluations
  $r3 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r3.dryRun -eq $true -and $r3.cutover -eq $false) "a dry run must report the plan and exit 0: $lastOut"
  Assert-True ($r3.gates.parity.pass -eq $true -and $r3.gates.parity.evaluations -eq 24 -and $r3.gates.parity.distinctFrontiers -eq 5) 'the dry run must show the passing parity gate'
  Assert-True (-not (Test-Path "$testRoot\state\flags\assignment-live")) 'a dry run must not write the flag'

  # Case 5: cutover.
  $r5 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test')
  Assert-True ($lastExit -eq 0 -and $r5.cutover -eq $true) "cutover must succeed past the gates: $lastOut"
  Assert-True (Test-Path "$testRoot\state\flags\assignment-live") 'cutover must write the flag'
  Assert-True ((Get-Content "$testRoot\state\flags\assignment-live" -Raw) -match 'rollback window closed with fleet #89') 'the flag must say the rollback window is closed'
  $record = (Get-Content "$testRoot\state\assignment\cutover.json" -Raw) | ConvertFrom-Json
  Assert-True ($record.parity.evaluations -eq 24 -and $record.forced -eq $false) 'the cutover record must carry the parity evidence'
  Assert-True ($lastOut -match 'status.ps1') 'cutover must print the paperwork checklist'
  Assert-True ((Get-Hash $eventsFile) -eq $eventsHash) 'cutover must not touch the event ledger'

  # Case 6: cutover is idempotent.
  $r6 = Run-Script 'cutover-assignment.ps1' @('-Tenant', 'test')
  Assert-True ($lastExit -eq 0 -and $r6.alreadyCutOver -eq $true) 'a second cutover must report already cut over'

  # Case 7 (ticket 89): the launch door refuses a `-Prompt` IC launch unconditionally, cutover
  # or not, with no flag or -Force to bring it back; a dry run still evaluates the other gates.
  $r7 = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', '/mattpocock-skills:implement legacy brief')
  Assert-True ($lastExit -eq 3 -and $r7.launched -eq $false -and $r7.reason -match 'reserved manifest' -and $r7.reason -match 'fleet #89') "launch.ps1 must refuse a `-Prompt` IC launch unconditionally: $lastOut"
  $r7bForce = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', '/mattpocock-skills:implement legacy brief', '-Force')
  Assert-True ($lastExit -eq 3 -and $r7bForce.launched -eq $false) '-Force must not restore the retired legacy path either'
  $r7b = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', '/mattpocock-skills:implement legacy brief', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r7b.dryRun -eq $true) 'a dry run of a legacy IC launch must still evaluate the other gates'
  $r7c = Run-Script 'launch.ps1' @('-Role', 'pl-test', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r7c.dryRun -eq $true) 'a control-plane launch is not the guard''s business'
  # The refusal keys on the name as well as the role, the way the sibling Sentinel gate does.
  $r7d = Run-Script 'launch.ps1' @('-Role', 'sonnet-ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', 'legacy')
  Assert-True ($lastExit -eq 3 -and $r7d.reason -match 'reserved manifest') "an ic-named launch must be refused whatever its -Role: $lastOut"

  # QA review of fleet #89: -Recover used to exempt ANY name from the guard, whether or not
  # it was really on the live roster. ic-101 is NOT on the live roster here (state/roster.json
  # is still '{"sessions":[]}' from setup), so this must be refused like any other -Prompt IC
  # launch - a real launch, no PAUSE, no manifest: nothing but -Recover claims an exemption.
  $r7qa = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', 'legacy brief', '-Recover')
  Assert-True ($lastExit -eq 3 -and $r7qa.launched -eq $false) "-Recover must not exempt a name that is not genuinely recoverable: $lastOut"
  $liveAfterQa = (Get-Content "$testRoot\state\roster.json" -Raw) | ConvertFrom-Json
  Assert-True (@($liveAfterQa.sessions | Where-Object { $_.name -eq 'ic-101' }).Count -eq 0) '-Recover must not have added ic-101 to the live roster'
  $activeAfterQa = $null; try { $activeAfterQa = (Get-Content "$testRoot\state\work\active.json" -Raw) | ConvertFrom-Json } catch {}
  Assert-True (-not $activeAfterQa -or $null -eq $activeAfterQa.records.PSObject.Properties['test:issue-101']) '-Recover must not have fabricated a Work record'

  # Reboot recovery relaunches an IC that is genuinely on the live roster: bin/recover.ps1
  # (read to build this fix) passes -Role/-Name/-Tenant/-Parent/-Issue/-Prompt straight from
  # that archived roster row, never -Manifest; it restarts the crashed process with its own
  # history, it does not re-run manifest preconditions or create a new worktree. The row's
  # `manifest` field is the credential checked, not something re-launched from.
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"ic-101","role":"ic","tenant":"test","parent":"pl-test","issue":101,"status":"active","manifest":"state/manifests/assignment-101.json","workRecordId":"test:issue-101"}]}'
  $r7e = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', 'legacy', '-Recover', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r7e.dryRun -eq $true -and $r7e.name -eq 'ic-101') "a genuine -Recover relaunch must pass the no-manifest guard: $lastOut"
  Assert-True ($r7e.prompt -eq 'legacy') "-Recover must relaunch with the roster's own original -Prompt, unchanged, not a manifest-derived one: $lastOut"
  Assert-True ((Get-Content "$testRoot\bin\recover.ps1" -Raw) -match '-Prompt \$e\.prompt -Recover') 'recover.ps1 must pass -Recover when it relaunches an IC'
  # -Recover exempts ONLY this guard: PAUSE still stops it, even for a genuine recovery.
  Write-Utf8 "$testRoot\state\PAUSE" 'testing'
  $r7f = Run-Script 'launch.ps1' @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', 'legacy', '-Recover')
  Assert-True ($lastExit -eq 3 -and $r7f.reason -match 'PAUSE') "-Recover must not bypass PAUSE: $lastOut"
  Remove-Item "$testRoot\state\PAUSE"
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # Case 8: a manifest reserved by the planner launches through the door (dry run),
  # and the manifest carries the tenant's checks and CI gates as pointers.
  $fixture = "$testRoot\issues.json"
  Write-Utf8 $fixture '[{"number":101,"title":"Fixture issue","url":"https://github.com/owner/repo/issues/101","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  $r8 = Run-Node @("$testRoot\bin\assignment.js", 'assign', '--root', $testRoot, '--tenant', 'test', '--tenant-config', "$testRoot\tenants\test.json", '--fixture', $fixture, '--base-sha', ('a' * 40), '--parent', 'pl-test', '--model', 'sonnet', '--adr-paths', 'docs/adr/0002-one-launch-door.md')
  Assert-True ($lastExit -eq 0 -and $r8.manifestPath) "assign must reserve a manifest: $lastOut"
  $manifest = (Get-Content $r8.manifestPath -Raw) | ConvertFrom-Json
  Assert-True ($manifest.status -eq 'pending-ack' -and $manifest.workRecordId -eq 'test:issue-101') 'the manifest must be pending acknowledgment for its Work record'
  Assert-True (@($manifest.ciGates) -contains 'test-build' -and (@($manifest.testPlan) -join ' ') -match 'unit: npm test' -and @($manifest.adrPaths) -contains 'docs/adr/0002-one-launch-door.md') 'the manifest must carry the tenant checks, CI gates, and the ADR pointer'
  $r8b = Run-Script 'launch.ps1' @('-Manifest', $r8.manifestPath, '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r8b.dryRun -eq $true -and $r8b.name -eq 'ic-101') "a manifest launch must pass the door: $lastOut"
  Assert-True ((Get-Content "$testRoot\state\sessions\ic-101.settings.json" -Raw) -match 'FLEET_WORK_RECORD_ID') 'the manifest launch must carry the Work record identity into the session'
  # Regression (2026-09-11): the prompt's ack command is pasted into the Bash tool; backslash paths
  # collapse there (C:UsersCory...). The dry run reports the prompt so this can be checked.
  Assert-True ([bool]$r8b.prompt -and $r8b.prompt -match 'assignment\.js ack') "the dry run must report the manifest prompt: $lastOut"
  $promptCmd = ([regex]::Match($r8b.prompt, '\((node \S+assignment\.js ack)\)')).Groups[1].Value
  Assert-True ([bool]$promptCmd -and $promptCmd -notmatch '\\') "the prompt's ack command must carry no backslashes: $($r8b.prompt)"

  # Ticket 89 (ADR 0006, after one release): bin/rollback-assignment.ps1 is gone, so there is no
  # rollback case left to exercise here; the legacy `-Prompt` IC launch stays refused (Case 7)
  # whether or not a manifest is pending, cutover or not. -Force overriding a failing gate is
  # covered by Case 2b, on a dry run, before the fixture's one real cutover (Case 5).

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
