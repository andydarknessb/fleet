# Ticket 06: launch.ps1 writes the role's tool contract into the session settings
# and refuses a launch whose estimated first-turn context exceeds the role ceiling,
# reporting the contribution by source. Uses -DryRun so nothing launches.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-launch-settings-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Run-Launch {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
}

try {
  foreach ($dir in 'bin','hooks','agents','tenants','config','state','state/sessions','state/notices','state/work','state/rotation','state/flags','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1','identity.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  [IO.File]::Copy("$sourceRoot\config\permissions-allowlist.json", "$testRoot\config\permissions-allowlist.json")
  foreach ($roleName in 'dispatcher','project-lead','ic') {
    Write-Utf8 "$testRoot\agents\$roleName.md" ("---`nname: $roleName`nmodel: sonnet`neffort: low`n---`nRole body for $roleName.")
  }
  Write-Utf8 "$testRoot\agents\principal.md" "---`nname: principal`nmodel: fable`neffort: high`n---`nRole body for principal."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $repoPath = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","maxIcs":2,"defaultBranch":"integration","releaseBranch":"main","repo":' + ($repoPath | ConvertTo-Json) + '}')
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_CLAUDE_FAIL%"=="1" exit /b 9' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'if "%1"=="--version" echo %MOCK_CLAUDE_VERSION% (Claude Code)' + "`r`n" + 'exit /b 0' + "`r`n")
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\job-disp") | Out-Null
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  # Claude Code 2.1.281 trust pre-flight (launch.ps1 Test-WorkspaceTrusted): trust the test root so every path under it launches.
  [IO.Directory]::CreateDirectory("$testRoot\profile") | Out-Null
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
  $repoFwd = $repoPath.Replace('\', '/')
  $rootFwd = $testRoot.Replace('\', '/')

  # Case 1: a control-plane role gets the state-door and tenant-repo denials.
  $r1 = Run-Launch @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start your duties.', '-DryRun')
  Assert-True ($r1.dryRun -eq $true) 'the dry run must report itself'
  $settings1 = Get-Content "$testRoot\state\sessions\dispatcher.settings.json" -Raw | ConvertFrom-Json
  $deny1 = @($settings1.permissions.deny)
  Assert-True ($deny1 -contains "Edit($rootFwd/state/work/**)") 'the dispatcher must lose direct Edit on state/work'
  Assert-True ($deny1 -contains "Write($rootFwd/state/events/**)") 'the dispatcher must lose direct Write on state/events'
  Assert-True ($deny1 -contains "NotebookEdit($rootFwd/state/archive/**)") 'the dispatcher must lose direct NotebookEdit on state/archive'
  Assert-True ($deny1 -contains "Write($rootFwd/state/exclusions/**)") 'the dispatcher must lose direct Write on the ticket-07 exclusion ledger'
  Assert-True ($deny1 -contains "Edit($rootFwd/state/status/DIGEST.md)") 'the dispatcher must lose direct Edit on the digest projection'
  Assert-True ($deny1 -contains "Write($rootFwd/state/status/*-status.md)") 'the dispatcher must lose direct Write on tenant status projections'
  Assert-True ($deny1 -contains "Edit($repoFwd/**)") 'a control-plane role must lose engineering edits in tenant repos'
  Assert-True ($settings1.permissions.defaultMode -eq 'auto') 'existing permission settings must survive the merge'
  Assert-True ($null -ne $r1.budget -and $r1.budget.estimatedTokens -gt 0) 'the dry run must report the first-turn budget'
  Assert-True ($r1.budget.ceiling -eq ((Get-Content "$testRoot\config\cycle.json" -Raw | ConvertFrom-Json).firstTurnCeilings.dispatcher)) 'the dispatcher ceiling must come from config/cycle.json'

  # Case 2: an IC keeps tenant-repo tools but loses every direct fleet-state write.
  $r2 = Run-Launch @('-Role', 'ic', '-Name', 'ic-42', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '42', '-Prompt', 'Implement issue 42.', '-DryRun')
  Assert-True ($r2.dryRun -eq $true) 'the IC dry run must report itself'
  $deny2 = @((Get-Content "$testRoot\state\sessions\ic-42.settings.json" -Raw | ConvertFrom-Json).permissions.deny)
  Assert-True ($deny2 -contains "Edit($rootFwd/state/**)") 'an IC must lose direct edits across fleet state'
  Assert-True (-not ($deny2 -contains "Edit($repoFwd/**)")) 'an IC must keep engineering tools in the tenant repo'

  # Case 2b: the tool-contract rollback flag skips the deny injection only.
  Write-Utf8 "$testRoot\state\flags\tool-contract-off" 'rollback'
  $r2b = Run-Launch @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start your duties.', '-DryRun')
  Assert-True ($r2b.dryRun -eq $true) 'the flagged dry run must still pass the gates'
  $settings2b = Get-Content "$testRoot\state\sessions\dispatcher.settings.json" -Raw | ConvertFrom-Json
  Assert-True (-not $settings2b.permissions.PSObject.Properties['deny']) 'tool-contract-off must skip the deny injection'
  Assert-True ($null -ne $r2b.budget) 'tool-contract-off must not disable the ceiling estimate'
  Remove-Item "$testRoot\state\flags\tool-contract-off"

  # Case 3: an over-ceiling launch fails before assignment with a source breakdown.
  # A 60K-char prompt (~15K tokens; dispatcher ceiling is 12K) exceeds the Windows
  # command line, so a runner reads it from a file inside the child process.
  Write-Utf8 "$testRoot\big-prompt.txt" ('x' * 60000)
  Write-Utf8 "$testRoot\bin\run-big.ps1" @'
param([switch]$WithForce, [switch]$WithFlag)
$p = Get-Content "$PSScriptRoot\..\big-prompt.txt" -Raw
if ($WithForce) { & "$PSScriptRoot\launch.ps1" -Role dispatcher -Name dispatcher -Parent cory -Prompt $p -DryRun -Force }
else { & "$PSScriptRoot\launch.ps1" -Role dispatcher -Name dispatcher -Parent cory -Prompt $p -DryRun }
exit $LASTEXITCODE
'@
  function Run-Big {
    param([string[]]$Arguments = @())
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\run-big.ps1" @Arguments 2>&1 | Out-String }
    finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
    try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
  }
  $r3 = Run-Big
  Assert-True ($script:lastExit -eq 6) 'an over-ceiling launch must exit 6'
  Assert-True ($r3.launched -eq $false -and "$($r3.reason)" -match 'ceiling') 'the refusal must name the ceiling'
  Assert-True ($r3.budget.sources.prompt -ge 15000) 'the breakdown must attribute the tokens to the prompt'
  Assert-True ($r3.budget.sources.roleFile -gt 0) 'the breakdown must list every source'
  Assert-True ($r3.budget.sources.sessionStartInjection -gt 0) 'the breakdown must count the hook injection'

  # Case 4: the rollback flag disables the gate; -Force overrides it too.
  Write-Utf8 "$testRoot\state\flags\launch-ceiling-off" 'rollback'
  $r4 = Run-Big
  Assert-True ($r4.dryRun -eq $true) 'the flag must disable the ceiling gate'
  Remove-Item "$testRoot\state\flags\launch-ceiling-off"
  $r4b = Run-Big @('-WithForce')
  Assert-True ($r4b.dryRun -eq $true) '-Force must override the ceiling gate'

  # Case 5: an unreadable daemon list refuses the launch outright (fail closed).
  $env:MOCK_CLAUDE_FAIL = '1'
  $r5 = Run-Launch @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start.', '-DryRun')
  Assert-True ($script:lastExit -eq 3) 'an unreadable daemon list must refuse with exit 3'
  Assert-True ($r5.launched -eq $false -and "$($r5.reason)" -match 'fail closed') 'the refusal must say it failed closed'
  Remove-Item Env:MOCK_CLAUDE_FAIL

  # Case 6: the CLI list reads empty while the roster's on-disk job state says the
  # session is alive and fresh: the independent source wins, no duplicate launches.
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"dispatcher","role":"dispatcher","status":"active","jobId":"job-disp","sessionId":"sess-disp"}]}'
  $freshAt = (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('o')
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-disp\state.json" ('{"state":"working","updatedAt":"' + $freshAt + '"}')
  $r6 = Run-Launch @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start.', '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and "$($r6.reason)" -match 'suspected bad read') 'a fresh working job state must refuse the duplicate'

  # Case 6b: a stale or stopped job state stays launchable (crash recovery).
  $staleAt = (Get-Date).ToUniversalTime().AddHours(-3).ToString('o')
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-disp\state.json" ('{"state":"working","updatedAt":"' + $staleAt + '"}')
  $r6b = Run-Launch @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start.', '-DryRun')
  Assert-True ($r6b.dryRun -eq $true) 'a stale working job state must not block recovery'
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-disp\state.json" ('{"state":"stopped","updatedAt":"' + $freshAt + '"}')
  $r6c = Run-Launch @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start.', '-DryRun')
  Assert-True ($r6c.dryRun -eq $true) 'a stopped job state must not block a relaunch'

  # Fleet #28: the CLI has no auto mode for claude-haiku-4-5; the one door refuses haiku
  # even on a dry run, names the cause, and never reaches the claude command.
  $rh = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-Model', 'haiku', '-DryRun')
  Assert-True ($script:lastExit -eq 3) "a haiku launch must exit 3 (got $script:lastExit)"
  Assert-True ($rh.launched -eq $false -and -not $rh.dryRun) 'a haiku launch must be refused before the dry-run report'
  Assert-True ("$($rh.reason)" -match 'auto mode' -and "$($rh.reason)" -match 'fleet #28') 'the haiku refusal must name the CLI auto-mode cause'
  $rs = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-Model', 'sonnet', '-DryRun')
  Assert-True ($rs.dryRun -eq $true -and $rs.model -eq 'sonnet') 'a sonnet launch still dry-runs'
  Assert-True ($rs.permissions -eq 'auto' -and $rs.allowRules -eq 0) "a sonnet launch reports the auto profile with no allow rules (got $($rs.permissions)/$($rs.allowRules))"
  $sonnetSettings = Get-Content "$testRoot\state\sessions\ic-999.settings.json" -Raw | ConvertFrom-Json
  Assert-True ($sonnetSettings.permissions.defaultMode -eq 'auto') 'the sonnet settings keep defaultMode auto'
  Assert-True (-not $sonnetSettings.permissions.PSObject.Properties['allow'] -and -not $sonnetSettings.permissions.PSObject.Properties['additionalDirectories']) 'the sonnet settings carry no allow list and no additional directories'
  $rha = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-Model', 'haiku', '-Permissions', 'auto', '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and "$($rha.reason)" -match 'fleet #28') 'haiku under an explicit auto profile is still the fleet #28 refusal'

  # Spec #94 (#162, ADR 0016): an allowlist manifest launches haiku under acceptEdits with
  # the checked-in profile as its allow list, the fleet root as an additional directory,
  # and every tool-contract deny rule still written. No --permission-mode on the command.
  [IO.Directory]::CreateDirectory("$testRoot\state\manifests") | Out-Null
  $manifestPath = "$testRoot\state\manifests\assignment-test-issue-77.json"
  Write-Utf8 $manifestPath ('{"schemaVersion":1,"id":"assignment-test-issue-77","status":"pending-ack","workRecordId":"test:issue-77","workRecordRevision":1,"issue":{"number":77,"bodyHash":"x","criteriaHash":"y"},"base":{"remote":"origin","ref":"integration","sha":"' + ('a' * 40) + '"},"branch":"fleet/77-x","tenant":"test","parent":"pl-test","model":"haiku","permissions":"allowlist"}')
  Write-Utf8 "$testRoot\state\work\active.json" '{"records":{"test:issue-77":{"id":"test:issue-77","state":"assigned","issue":77,"manifestPath":"m77"}}}'
  $profile = Get-Content "$testRoot\config\permissions-allowlist.json" -Raw | ConvertFrom-Json
  # #165: the checked-in profile records no version until a rehearsal passes; this root
  # stands in for the fleet after a clean verdict on 2.1.282.
  $verifiedProfile = Get-Content "$testRoot\config\permissions-allowlist.json" -Raw | ConvertFrom-Json
  $verifiedProfile.verifiedCliVersion = '2.1.282'
  Write-Utf8 "$testRoot\config\permissions-allowlist.json" ($verifiedProfile | ConvertTo-Json -Depth 6)
  $env:MOCK_CLAUDE_VERSION = '2.1.282'
  $rm = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($rm.dryRun -eq $true -and $rm.model -eq 'haiku') "an allowlist haiku manifest dry-runs on the verified CLI (got: $rm)"
  Assert-True ($rm.permissions -eq 'allowlist' -and $rm.allowRules -eq @($profile.allow).Count) "the dry run names the profile and its allow rule count (got $($rm.permissions)/$($rm.allowRules))"
  Assert-True (-not ("$($rm.command)" -match '--permission-mode')) 'the permission mode is never passed on the command line'
  $haikuSettings = Get-Content "$testRoot\state\sessions\ic-77.settings.json" -Raw | ConvertFrom-Json
  Assert-True ($haikuSettings.permissions.defaultMode -eq 'acceptEdits') 'the allowlist settings run acceptEdits'
  $expectedAllow = @($profile.allow | ForEach-Object { "$($_.rule)".Replace('<fleet>', $rootFwd) })
  Assert-True ((@($haikuSettings.permissions.allow) -join "`n") -eq ($expectedAllow -join "`n")) 'permissions.allow is the checked-in profile verbatim, <fleet> resolved to this root'
  Assert-True (@($haikuSettings.permissions.additionalDirectories) -contains $rootFwd) 'additionalDirectories names the fleet root'
  $haikuDeny = @($haikuSettings.permissions.deny)
  foreach ($contractRule in @($deny2 | Where-Object { $_ -like "*$rootFwd/state*" })) {
    Assert-True ($haikuDeny -contains $contractRule) "the allowlist settings keep the tool-contract deny rule $contractRule"
  }
  Assert-True ($haikuDeny -contains "Edit($rootFwd/**)") 'the profile denies edits across the fleet root it adds as a directory'
  Assert-True ($haikuDeny -contains 'Bash(git push origin integration:*)') 'the profile deny resolves <defaultBranch> from the tenant file'
  Assert-True (-not (@(@($haikuSettings.permissions.allow) + $haikuDeny) | Where-Object { "$_" -match '<[a-zA-Z]+>' })) 'no unresolved token reaches the settings'
  # Spec #94 (#165): the profile records the CLI version the rehearsal passed on; a haiku
  # launch on any other `claude --version` is refused, naming both and the rehearsal.
  $env:MOCK_CLAUDE_VERSION = '9.9.999'
  $rmv = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and $rmv.launched -eq $false) "a haiku launch on an unverified CLI must refuse with exit 3 (got $script:lastExit): $rmv"
  Assert-True ("$($rmv.reason)" -match '9\.9\.999' -and "$($rmv.reason)" -match '2\.1\.282' -and "$($rmv.reason)" -match 'scratch-root\.ps1') "the version refusal names both versions and the rehearsal command: $($rmv.reason)"
  $rsv = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-Model', 'sonnet', '-DryRun')
  Assert-True ($rsv.dryRun -eq $true) 'a sonnet launch is unaffected by the recorded CLI version'
  # The checked-in profile (no version: no rehearsal has passed) keeps the tier closed, so
  # merging before a clean verdict opens nothing.
  Assert-True ($null -eq $profile.verifiedCliVersion) 'the checked-in profile records no version until a rehearsal passes'
  [IO.File]::Copy("$sourceRoot\config\permissions-allowlist.json", "$testRoot\config\permissions-allowlist.json", $true)
  $env:MOCK_CLAUDE_VERSION = '2.1.282'
  $rmn = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and "$($rmn.reason)" -match 'no haiku rehearsal has passed') "no recorded version refuses a haiku launch: $rmn"
  # A scratch root marks its copy rehearsalRoot: the rehearsal launch itself runs there.
  $rehearsal = Get-Content "$testRoot\config\permissions-allowlist.json" -Raw | ConvertFrom-Json
  $rehearsal | Add-Member -NotePropertyName rehearsalRoot -NotePropertyValue $true -Force
  Write-Utf8 "$testRoot\config\permissions-allowlist.json" ($rehearsal | ConvertTo-Json -Depth 6)
  $rmr = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($rmr.dryRun -eq $true) "a rehearsal root launches haiku on the installed CLI: $rmr"
  [IO.File]::Copy("$sourceRoot\config\permissions-allowlist.json", "$testRoot\config\permissions-allowlist.json", $true)
  Remove-Item Env:MOCK_CLAUDE_VERSION -ErrorAction SilentlyContinue
  # A sonnet manifest pinning allowlist is refused at the door too (the planner refuses it first).
  Write-Utf8 $manifestPath ((Get-Content $manifestPath -Raw).Replace('"model":"haiku"', '"model":"sonnet"'))
  $rms = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and "$($rms.reason)" -match 'allowlist') "a sonnet allowlist manifest is refused (got: $rms)"
  Remove-Item $manifestPath
  Write-Utf8 "$testRoot\state\work\active.json" '{"records":{}}'

  # ADR 0011 (fleet #37): the Principal comes through the door as pe-<tenant>, on the
  # pinned Fable id at effort high, with the control-plane tenant-repo denial and its
  # own ceiling; it is named by scheme and needs a tenant; it neither counts toward
  # nor is refused by the cap.
  $rp = Run-Launch @('-Role', 'principal', '-Name', 'pe-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'Propose triage.', '-DryRun')
  Assert-True ($rp.dryRun -eq $true) "a principal dry run must pass the gates (got: $rp)"
  Assert-True ("$($rp.command)" -match '--model claude-fable-5-1') 'a principal with no -Model must run the pinned Fable id'
  Assert-True ("$($rp.command)" -match '--effort high') 'a principal must run at the role file effort'
  Assert-True ($rp.budget.ceiling -eq 30000) 'the principal ceiling must come from config/cycle.json'
  $denyP = @((Get-Content "$testRoot\state\sessions\pe-test.settings.json" -Raw | ConvertFrom-Json).permissions.deny)
  Assert-True (-not ($denyP -contains "Edit($repoFwd/**)")) 'a principal must NOT carry the blanket tenant-repo denial: hooks/principal-guard.ps1 enforces its allowlist (fleet #39)'
  Assert-True ($denyP -contains "Edit($rootFwd/state/work/**)") 'a principal still loses the direct state-door writes'
  $rpf = Run-Launch @('-Role', 'principal', '-Name', 'pe-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'Propose triage.', '-Model', 'fable', '-DryRun')
  Assert-True ("$($rpf.command)" -match '--model claude-fable-5-1') 'an explicit -Model fable must resolve to the same pinned id'
  $rpl = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-DryRun')
  Assert-True ("$($rpl.command)" -match '--model claude-opus-5-5') 'a project lead with no -Model must run the pinned Opus 5.5 id'
  $rplo = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-Model', 'sonnet', '-DryRun')
  Assert-True ("$($rplo.command)" -match '--model sonnet') 'an explicit -Model must still override the project lead default'
  Run-Launch @('-Role', 'principal', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'x', '-DryRun') | Out-Null
  Assert-True ($script:lastExit -eq 4) 'a principal not named pe-<tenant> must be refused as a usage error'
  Run-Launch @('-Role', 'principal', '-Name', 'pe-test', '-Parent', 'dispatcher', '-Prompt', 'x', '-DryRun') | Out-Null
  Assert-True ($script:lastExit -eq 4) 'a principal without -Tenant must be refused as a usage error'
  # Cap: a full cap refuses a lead but not the principal, and the principal's own
  # session does not count toward it.
  Write-Utf8 "$testRoot\roster.json" '{"cap":1,"sessions":[{"name":"pe-test","role":"principal","tenant":"test","parent":"dispatcher","cwd":"x","prompt":"p"},{"name":"pl-test","role":"project-lead","tenant":"test","parent":"dispatcher","cwd":"x","prompt":"p"}]}'
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo [{"name":"pe-test","id":"j1","sessionId":"s1","state":"idle"}]' + "`r`n" + 'exit /b 0' + "`r`n")
  $rcap = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-DryRun')
  Assert-True ($rcap.dryRun -eq $true) "a running principal must not count toward the cap (got: $rcap)"
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo [{"name":"pl-test","id":"j2","sessionId":"s2","state":"idle"}]' + "`r`n" + 'exit /b 0' + "`r`n")
  $rcap2 = Run-Launch @('-Role', 'principal', '-Name', 'pe-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'p', '-DryRun')
  Assert-True ($rcap2.dryRun -eq $true) "a full cap must not refuse the principal (got: $rcap2)"

  Write-Output 'launch settings tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_CLAUDE_FAIL -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-settings-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
