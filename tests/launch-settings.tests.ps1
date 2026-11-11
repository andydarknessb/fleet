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
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" @Arguments 2>&1 | Out-String; $script:lastOut = $out }
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
  Write-Utf8 "$testRoot\agents\project-lead.md" "---`nname: project-lead`nmodel: sonnet`neffort: low`n---`nRole body for project-lead."
  # Fleet #350: the IC role file names Haiku 5.5 at xhigh, the effort the planner defaults to.
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: claude-haiku-5-5`neffort: xhigh`n---`nRole body for ic."
  Write-Utf8 "$testRoot\agents\principal.md" "---`nname: principal`nmodel: sonnet-5.5`neffort: high`n---`nRole body for principal."
  Write-Utf8 "$testRoot\agents\arbiter.md" "---`nname: arbiter`nmodel: claude-opus-5-5`neffort: xhigh`n---`nRole body for arbiter."
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
  $r1 = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'cory', '-Prompt', 'Start your duties.', '-DryRun')
  Assert-True ($r1.dryRun -eq $true) 'the dry run must report itself'
  $settings1 = Get-Content "$testRoot\state\sessions\pl-test.settings.json" -Raw | ConvertFrom-Json
  $deny1 = @($settings1.permissions.deny)
  Assert-True ($deny1 -contains "Edit($rootFwd/state/work/**)") 'a project lead must lose direct Edit on state/work'
  Assert-True ($deny1 -contains "Write($rootFwd/state/events/**)") 'a project lead must lose direct Write on state/events'
  Assert-True ($deny1 -contains "NotebookEdit($rootFwd/state/archive/**)") 'a project lead must lose direct NotebookEdit on state/archive'
  Assert-True ($deny1 -contains "Write($rootFwd/state/exclusions/**)") 'a project lead must lose direct Write on the ticket-07 exclusion ledger'
  Assert-True ($deny1 -contains "Edit($rootFwd/state/status/DIGEST.md)") 'a project lead must lose direct Edit on the digest projection'
  Assert-True ($deny1 -contains "Write($rootFwd/state/status/*-status.md)") 'a project lead must lose direct Write on tenant status projections'
  Assert-True ($deny1 -contains "Edit($repoFwd/**)") 'a control-plane role must lose engineering edits in tenant repos'
  Assert-True ($settings1.permissions.defaultMode -eq 'auto') 'existing permission settings must survive the merge'
  Assert-True ($null -ne $r1.budget -and $r1.budget.estimatedTokens -gt 0) 'the dry run must report the first-turn budget'
  Assert-True ($r1.budget.ceiling -eq ((Get-Content "$testRoot\config\cycle.json" -Raw | ConvertFrom-Json).firstTurnCeilings.'project-lead')) 'the project-lead ceiling must come from config/cycle.json'

  # Case 2: an IC keeps tenant-repo tools but loses every direct fleet-state write.
  $r2 = Run-Launch @('-Role', 'ic', '-Name', 'ic-42', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '42', '-Prompt', 'Implement issue 42.', '-DryRun')
  Assert-True ($r2.dryRun -eq $true) 'the IC dry run must report itself'
  $deny2 = @((Get-Content "$testRoot\state\sessions\ic-42.settings.json" -Raw | ConvertFrom-Json).permissions.deny)
  Assert-True ($deny2 -contains "Edit($rootFwd/state/**)") 'an IC must lose direct edits across fleet state'
  Assert-True (-not ($deny2 -contains "Edit($repoFwd/**)")) 'an IC must keep engineering tools in the tenant repo'

  # Case 2b: the tool-contract rollback flag skips the deny injection only.
  Write-Utf8 "$testRoot\state\flags\tool-contract-off" 'rollback'
  $r2b = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'cory', '-Prompt', 'Start your duties.', '-DryRun')
  Assert-True ($r2b.dryRun -eq $true) 'the flagged dry run must still pass the gates'
  $settings2b = Get-Content "$testRoot\state\sessions\pl-test.settings.json" -Raw | ConvertFrom-Json
  Assert-True (-not $settings2b.permissions.PSObject.Properties['deny']) 'tool-contract-off must skip the deny injection'
  Assert-True ($null -ne $r2b.budget) 'tool-contract-off must not disable the ceiling estimate'
  Remove-Item "$testRoot\state\flags\tool-contract-off"

  # #200 (spec #190): the real fleet-settings.json carries the auto-mode environment
  # statement (Cory's merge authorization, Nidus migrations local-only), and every
  # role's per-session settings carry it verbatim after "$defaults". (No sentinel case:
  # the door copies the settings object the same way for every role.)
  $srcEnv = @((Get-Content "$sourceRoot\fleet-settings.json" -Raw | ConvertFrom-Json).autoMode.environment)
  Assert-True ($srcEnv.Count -ge 3 -and $srcEnv[0] -eq '$defaults') 'fleet-settings.json autoMode.environment must inherit the built-in entries first'
  Assert-True (@($srcEnv | Where-Object { $_ -match 'authorizes a fleet session' -and $_ -match 'not Merge Without Review' -and $_ -match 'fleet-review' -and $_ -match 'every required check' -and $_ -match 'Endzone-Empire main' -and $_ -match 'Carve-out paths:' }).Count -eq 1) 'the owner merge authorization must be stated once, with its conditions, its exclusions and the carve-out paths'
  Assert-True (@($srcEnv | Where-Object { $_ -match 'Nidus #14' -and $_ -match 'local stack' -and $_ -match 'supabase db push' -and $_ -match 'Cory''s' }).Count -eq 1) 'Nidus migrations must be stated local-only, with the remote commands left to Cory, once'
  # fleet #423: an IC's commit, push and gh pr ready on its own branch are its assigned work, after a send-back too.
  Assert-True (@($srcEnv | Where-Object { $_ -match 'FLEET_ROLE=ic' -and $_ -match 'authorizes each fleet session running as an IC' -and $_ -match 'FLEET_ASSIGNMENT_BRANCH' -and $_ -match 'Committing to that branch' -and $_ -match 'pushing it' -and $_ -match 'title and body' -and $_ -match 'gh pr ready --undo' -and $_ -match 'send-back' -and $_ -match 'not Unrequested Commits' -and $_ -match 'relayed by another session' -and $_ -match 'never covers a push to a tenant''s default or release branch' -and $_ -match 'force push' -and $_ -match 'gh pr merge' -and $_ -match 'other than the IC''s own' }).Count -eq 1) 'the IC own-branch statement must say an IC''s commit, push and gh pr ready on its own branch are the assigned work, after a send-back too, with the never-covered actions, once'
  $srcAllow = @((Get-Content "$sourceRoot\fleet-settings.json" -Raw | ConvertFrom-Json).autoMode.allow)
  Assert-True (@($srcAllow | Where-Object { $_ -match 'FLEET_ROLE=ic' -and $_ -match 'FLEET_ASSIGNMENT_BRANCH' -and $_ -match 'title and body' -and $_ -match 'not an Unrequested Commit in a Connected App' -and $_ -match 'relayed by another session' -and $_ -match 'never covers a push to a default or release branch' -and $_ -match 'force push' -and $_ -match 'gh pr merge' -and $_ -match 'another branch' }).Count -eq 1) 'autoMode.allow must carry the IC own-branch line once, with its exclusions'
  [IO.File]::Copy("$sourceRoot\fleet-settings.json", "$testRoot\fleet-settings.json", $true)
  $envCases = @(
    @{ Name = 'pl-test'; Role = 'project-lead'; Args = @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-DryRun') },
    @{ Name = 'pe-test'; Role = 'principal'; Args = @('-Role', 'principal', '-Name', 'pe-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'Propose triage.', '-DryRun') },
    @{ Name = 'ic-42'; Role = 'ic'; Args = @('-Role', 'ic', '-Name', 'ic-42', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '42', '-Prompt', 'Implement issue 42.', '-DryRun') },
    @{ Name = 'ar-test'; Role = 'arbiter'; Args = @('-Role', 'arbiter', '-Name', 'ar-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'Decide triage.', '-DryRun') }
  )
  foreach ($case in $envCases) {
    $re = Run-Launch $case.Args
    Assert-True ($re.dryRun -eq $true) "the $($case.Name) dry run under the real fleet settings must pass the gates (got: $re)"
    $gotEnv = @((Get-Content "$testRoot\state\sessions\$($case.Name).settings.json" -Raw | ConvertFrom-Json).autoMode.environment)
    Assert-True (($gotEnv.Count -eq $srcEnv.Count) -and (@(for ($i = 0; $i -lt $srcEnv.Count; $i++) { $gotEnv[$i] -ceq $srcEnv[$i] }) -notcontains $false)) "$($case.Name) per-session settings must carry the environment statement verbatim"
    $gotAllow = @((Get-Content "$testRoot\state\sessions\$($case.Name).settings.json" -Raw | ConvertFrom-Json).autoMode.allow)
    Assert-True (($gotAllow.Count -eq $srcAllow.Count) -and (@(for ($i = 0; $i -lt $srcAllow.Count; $i++) { $gotAllow[$i] -ceq $srcAllow[$i] }) -notcontains $false)) "$($case.Name) per-session settings must carry the allow rules verbatim"
    # Ponytail is enabled by the fleet's own settings, not only by Cory's user settings.
    $gotPlugins = (Get-Content "$testRoot\state\sessions\$($case.Name).settings.json" -Raw | ConvertFrom-Json).enabledPlugins
    Assert-True ($gotPlugins.'ponytail@ponytail' -eq $true) "$($case.Name) per-session settings must enable ponytail@ponytail"
    # fleet #384 (owner ruling 5): Cory's personal plugins are off by id, the fleet's two stay on, plugin sync is off and
    # Remote Control is on, and only the project lead keeps the claude.ai connectors (its Supabase connector).
    $gotSettings = Get-Content "$testRoot\state\sessions\$($case.Name).settings.json" -Raw | ConvertFrom-Json
    $wantPlugins = @{ 'ponytail@ponytail' = $true; 'mattpocock-skills@claude-plugins-official' = $true; 'i-have-adhd@i-have-adhd' = $false; 'humanizer@humanizer' = $false; 'impeccable@impeccable' = $false }
    Assert-True (@($gotSettings.enabledPlugins.PSObject.Properties).Count -eq $wantPlugins.Count) "$($case.Name) per-session settings must name exactly the fleet's plugins (got $($gotSettings.enabledPlugins | ConvertTo-Json -Compress))"
    foreach ($plugin in $wantPlugins.Keys) { Assert-True ($gotSettings.enabledPlugins.PSObject.Properties[$plugin].Value -eq $wantPlugins[$plugin]) "$($case.Name) per-session settings must set $plugin to $($wantPlugins[$plugin])" }
    Assert-True ($gotSettings.syncClaudeAiPlugins -eq $false) "$($case.Name) per-session settings must turn claude.ai plugin sync off"
    Assert-True ($gotSettings.remoteControlAtStartup -eq $true) "$($case.Name) per-session settings must turn Remote Control on (#407)"
    if ($case.Role -eq 'project-lead') { Assert-True ($gotSettings.disableClaudeAiConnectors -eq $false) "$($case.Name) must keep the claude.ai connectors" } else { Assert-True ($gotSettings.disableClaudeAiConnectors -eq $true) "$($case.Name) must run without the claude.ai connectors" }
    Assert-True ("$($re.command)" -match '--no-chrome') "$($case.Name) must launch with --no-chrome (got: $($re.command))"
    # Its hooks stay off: only the IC loads it, by invoking the skill (fleet #282).
    $gotSessionEnv = (Get-Content "$testRoot\state\sessions\$($case.Name).settings.json" -Raw | ConvertFrom-Json).env
    Assert-True ($gotSessionEnv.PONYTAIL_DEFAULT_MODE -eq 'off') "$($case.Name) must start with ponytail's always-on hook off"
    Assert-True ($gotSessionEnv.PONYTAIL_SUBAGENT_MATCHER -eq '(?!)') "$($case.Name) must keep ponytail's hook out of its subagents"
  }
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'

  # Case 3: an over-ceiling launch fails before assignment with a source breakdown.
  # A 60K-char prompt (~40K tokens; project-lead ceiling is 30K) exceeds the Windows
  # command line, so a runner reads it from a file inside the child process.
  Write-Utf8 "$testRoot\big-prompt.txt" ('x' * 160000)
  Write-Utf8 "$testRoot\bin\run-big.ps1" @'
param([switch]$WithForce, [switch]$WithFlag)
$p = Get-Content "$PSScriptRoot\..\big-prompt.txt" -Raw
if ($WithForce) { & "$PSScriptRoot\launch.ps1" -Role project-lead -Name pl-test -Tenant test -Parent cory -Prompt $p -DryRun -Force }
else { & "$PSScriptRoot\launch.ps1" -Role project-lead -Name pl-test -Tenant test -Parent cory -Prompt $p -DryRun }
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
  Assert-True ($r3.budget.sources.prompt -ge 30000) 'the breakdown must attribute the tokens to the prompt'
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
  $r5 = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'cory', '-Prompt', 'Start.', '-DryRun')
  Assert-True ($script:lastExit -eq 3) 'an unreadable daemon list must refuse with exit 3'
  Assert-True ($r5.launched -eq $false -and "$($r5.reason)" -match 'fail closed') 'the refusal must say it failed closed'
  Remove-Item Env:MOCK_CLAUDE_FAIL

  # Case 6: the CLI list reads empty while the roster's on-disk job state says the
  # session is alive and fresh: the independent source wins, no duplicate launches.
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"pl-test","role":"project-lead","status":"active","jobId":"job-disp","sessionId":"sess-disp"}]}'
  $freshAt = (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('o')
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-disp\state.json" ('{"state":"working","updatedAt":"' + $freshAt + '"}')
  $r6 = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'cory', '-Prompt', 'Start.', '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and "$($r6.reason)" -match 'suspected bad read') 'a fresh working job state must refuse the duplicate'

  # Case 6b: a stale or stopped job state stays launchable (crash recovery).
  $staleAt = (Get-Date).ToUniversalTime().AddHours(-3).ToString('o')
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-disp\state.json" ('{"state":"working","updatedAt":"' + $staleAt + '"}')
  $r6b = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'cory', '-Prompt', 'Start.', '-DryRun')
  Assert-True ($r6b.dryRun -eq $true) 'a stale working job state must not block recovery'
  Write-Utf8 "$testRoot\profile\.claude\jobs\job-disp\state.json" ('{"state":"stopped","updatedAt":"' + $freshAt + '"}')
  $r6c = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'cory', '-Prompt', 'Start.', '-DryRun')
  Assert-True ($r6c.dryRun -eq $true) 'a stopped job state must not block a relaunch'

  # Fleet #350 (owner ruling 2026-10-30): every IC runs Claude Haiku 5.5. An IC with no -Model
  # resolves to the pinned id under the auto profile, at the role file's effort.
  $rh = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-DryRun')
  Assert-True ($rh.dryRun -eq $true -and $rh.model -eq 'haiku' -and $rh.permissions -eq 'auto' -and $rh.allowRules -eq 0) "an IC with no -Model dry-runs on Haiku under auto (got: $rh)"
  Assert-True ("$($rh.command)" -match '--model claude-haiku-5-5 --effort xhigh ') "an IC runs pinned claude-haiku-5-5 at the role file effort (got: $($rh.command))"
  $haikuAutoSettings = Get-Content "$testRoot\state\sessions\ic-999.settings.json" -Raw | ConvertFrom-Json
  Assert-True ($haikuAutoSettings.permissions.defaultMode -eq 'auto' -and $haikuAutoSettings.env.FLEET_PERMISSIONS -eq 'auto') 'a haiku IC under auto runs defaultMode auto, marked auto so the allowlist gate passes it (fleet #181)'
  Assert-True (-not $haikuAutoSettings.permissions.PSObject.Properties['allow'] -and -not $haikuAutoSettings.permissions.PSObject.Properties['additionalDirectories']) 'the haiku IC under auto carries no allow list and no additional directories'
  Assert-True (-not $haikuAutoSettings.PSObject.Properties['apiKeyHelper'] -and -not $haikuAutoSettings.env.PSObject.Properties['ANTHROPIC_BASE_URL']) 'an IC keeps the Anthropic API: no base URL and no apiKeyHelper'
  $rhx = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-Model', 'haiku', '-Permissions', 'auto', '-DryRun')
  Assert-True ($rhx.dryRun -eq $true -and $rhx.permissions -eq 'auto') "an explicit -Permissions auto on a haiku IC dry-runs (got: $rhx)"
  # Any other model is refused at the door on an IC, dry runs included, before the claude command.
  foreach ($otherModel in 'sonnet', 'opus') {
    $ro = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-Model', $otherModel, '-DryRun')
    Assert-True ($script:lastExit -eq 3 -and $ro.launched -eq $false -and -not $ro.dryRun -and "$($ro.reason)" -match 'Haiku 5\.5 only') "an IC on $otherModel is refused (got: $ro)"
  }
  # The role file's effort is the IC's fallback, and only xhigh or max launches.
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: claude-haiku-5-5`neffort: high`n---`nRole body for ic."
  $rhe = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and $rhe.launched -eq $false -and "$($rhe.reason)" -match 'xhigh or max') "an IC whose role file says high is refused (got: $rhe)"
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: claude-haiku-5-5`neffort: xhigh`n---`nRole body for ic."

  # Spec #94 (#162, ADR 0016): an allowlist manifest launches haiku under acceptEdits with
  # the checked-in profile as its allow list, the fleet root as an additional directory,
  # and every tool-contract deny rule still written. No --permission-mode on the command.
  [IO.Directory]::CreateDirectory("$testRoot\state\manifests") | Out-Null
  $manifestPath = "$testRoot\state\manifests\assignment-test-issue-77.json"
  Write-Utf8 $manifestPath ('{"schemaVersion":1,"id":"assignment-test-issue-77","status":"pending-ack","workRecordId":"test:issue-77","workRecordRevision":1,"issue":{"number":77,"bodyHash":"x","criteriaHash":"y"},"base":{"remote":"origin","ref":"integration","sha":"' + ('a' * 40) + '"},"branch":"fleet/77-x","tenant":"test","parent":"pl-test","model":"haiku","permissions":"allowlist"}')
  Write-Utf8 "$testRoot\state\work\active.json" '{"records":{"test:issue-77":{"id":"test:issue-77","state":"assigned","revision":1,"issue":77,"manifestPath":"m77"}}}'
  $profile = Get-Content "$sourceRoot\config\permissions-allowlist.json" -Raw | ConvertFrom-Json
  # #165: this root stands in for the fleet after a clean verdict on 2.1.282, whatever
  # version the checked-in profile records.
  $verifiedProfile = Get-Content "$testRoot\config\permissions-allowlist.json" -Raw | ConvertFrom-Json
  $verifiedProfile.verifiedCliVersion = '2.1.282'
  Write-Utf8 "$testRoot\config\permissions-allowlist.json" ($verifiedProfile | ConvertTo-Json -Depth 6)
  $env:MOCK_CLAUDE_VERSION = '2.1.282'
  # Fleet #171: the tenant repo's main checkout, whose entries the profile denies around .claude/worktrees.
  $rmMissing = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($script:lastExit -eq 4 -and ("$rmMissing" -replace '\s+', '') -match 'whichdoesnotexist')"an allowlist launch against a missing tenant repo must refuse rather than leave it editable (got: $rmMissing)"
  foreach ($d in 'src', '.git', '.claude\worktrees\ic-77-assignment\src') { [IO.Directory]::CreateDirectory("$repoPath\$d") | Out-Null }
  Write-Utf8 "$repoPath\package.json" '{}'
  Write-Utf8 "$repoPath\.claude\settings.json" '{}'
  $rm = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($rm.dryRun -eq $true -and $rm.model -eq 'haiku') "an allowlist haiku manifest dry-runs on the verified CLI (got: $rm)"
  Assert-True ($rm.permissions -eq 'allowlist' -and $rm.allowRules -eq @($profile.allow).Count) "the dry run names the profile and its allow rule count (got $($rm.permissions)/$($rm.allowRules))"
  Assert-True (-not ("$($rm.command)" -match '--permission-mode')) 'the permission mode is never passed on the command line'
  $haikuSettings = Get-Content "$testRoot\state\sessions\ic-77.settings.json" -Raw | ConvertFrom-Json
  Assert-True ($haikuSettings.permissions.defaultMode -eq 'acceptEdits') 'the allowlist settings run acceptEdits'
  Assert-True ($haikuSettings.env.FLEET_PERMISSIONS -eq 'allowlist') 'the env names the profile, which hooks/allowlist-gate.js keys on (fleet #181)'
  $expectedAllow = @($profile.allow | ForEach-Object { "$($_.rule)".Replace('<fleet>', $rootFwd).Replace('<repo>', $repoFwd) })
  Assert-True ((@($haikuSettings.permissions.allow) -join "`n") -eq ($expectedAllow -join "`n")) 'permissions.allow is the checked-in profile verbatim, <fleet> and <repo> resolved'
  Assert-True (@($haikuSettings.permissions.additionalDirectories) -contains $rootFwd) 'additionalDirectories names the fleet root'
  Assert-True (@($haikuSettings.permissions.allow) -contains "Read($repoFwd/**)") 'the <repo> token resolves in allow to the tenant main checkout (rehearsal wait 1)'
  Assert-True (@($haikuSettings.permissions.additionalDirectories) -contains $repoFwd) 'additionalDirectories names the tenant repo (rehearsal wait 2)'
  foreach ($entry in @($profile.additionalDirectories) + @($profile.allow) + @($profile.deny) + @($profile.repoDeny)) {
    Assert-True ("$($entry.for)" -match 'ic\.md|soft_deny|additionalDirectories') "every profile entry carries its for note (missing on $($entry.rule)$($entry.dir))"
  }
  $haikuDeny = @($haikuSettings.permissions.deny)
  foreach ($contractRule in @($deny2 | Where-Object { $_ -like "*$rootFwd/state*" })) {
    Assert-True ($haikuDeny -contains $contractRule) "the allowlist settings keep the tool-contract deny rule $contractRule"
  }
  Assert-True ($haikuDeny -contains "Edit($rootFwd/**)") 'the profile denies edits across the fleet root it adds as a directory'
  Assert-True ($haikuDeny -contains 'Bash(git push origin integration:*)') 'the profile deny resolves <defaultBranch> from the tenant file'
  Assert-True ($haikuDeny -contains 'Monitor') 'the profile denies the Monitor tool, whose shell loop bypasses the Bash gate and prompts under acceptEdits (rehearsal 2026-10-13)'
  Assert-True (-not (@(@($haikuSettings.permissions.allow) + $haikuDeny) | Where-Object { "$_" -match '<[a-zA-Z]+>' })) 'no unresolved token reaches the settings'
  foreach ($repoRule in "Edit($repoFwd/src/**)", "Write($repoFwd/package.json)", "NotebookEdit($repoFwd/.git/**)", "Edit($repoFwd/.claude/settings.json)", "Write($repoFwd/.claude/settings.json)") {
    Assert-True ($haikuDeny -contains $repoRule) "the <repo> denies cover the main checkout's entries: missing $repoRule"
  }
  # The worktree stays editable: no deny rule's glob over the repo matches a file in the
  # assignment worktree. (This fixture nests the repo inside the fleet root, which the
  # Edit(<fleet>/**) rules cover; a real tenant repo sits outside it, so only repo rules count.)
  $worktreeFile = "$repoFwd/.claude/worktrees/ic-77-assignment/src/a.js"
  $repoRules = @($haikuDeny | Where-Object { "$_" -match "^(Edit|Write|NotebookEdit)\($([regex]::Escape($repoFwd))/" })
  Assert-True ($repoRules.Count -eq 12) "the <repo> denies are one per tool for src, .git, package.json and .claude/settings.json (got $($repoRules.Count))"
  foreach ($rule in $repoRules) {
    if ("$rule" -notmatch '^(Edit|Write|NotebookEdit)\((.+)\)$') { continue }
    $glob = [regex]::Escape($Matches[2]).Replace('\*\*', '.*').Replace('\*', '[^/]*')
    Assert-True ($worktreeFile -notmatch "^$glob$") "deny rule $rule must leave the assignment worktree editable"
  }
  # Spec #94 (#165): the profile records the CLI version the rehearsal passed on; a haiku
  # launch on any other `claude --version` is refused, naming both and the rehearsal.
  $env:MOCK_CLAUDE_VERSION = '9.9.999'
  $rmv = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and $rmv.launched -eq $false) "a haiku launch on an unverified CLI must refuse with exit 3 (got $script:lastExit): $rmv"
  Assert-True ("$($rmv.reason)" -match '9\.9\.999' -and "$($rmv.reason)" -match '2\.1\.282' -and "$($rmv.reason)" -match 'scratch-root\.ps1') "the version refusal names both versions and the rehearsal command: $($rmv.reason)"
  # Fleet #350: the recorded CLI version gates the allowlist rollback only; haiku under auto is not gated.
  $rsv = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-DryRun')
  Assert-True ($rsv.dryRun -eq $true) "a haiku IC under auto is unaffected by the recorded CLI version (got: $rsv)"
  # The checked-in profile records the CLI the clean rehearsal ran on (spec #94: 2026-09-29,
  # Endzone #1773, .scratch/haiku-rehearsal-2026-09-29/).
  Assert-True ("$($profile.verifiedCliVersion)" -match '^\d+\.\d+\.\d+$') "the checked-in profile records the rehearsed CLI version (got $($profile.verifiedCliVersion))"
  # No recorded version (before any rehearsal passes) keeps the tier closed.
  $unverified = Get-Content "$sourceRoot\config\permissions-allowlist.json" -Raw | ConvertFrom-Json
  $unverified.verifiedCliVersion = $null
  Write-Utf8 "$testRoot\config\permissions-allowlist.json" ($unverified | ConvertTo-Json -Depth 6)
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
  # Fleet #350: a sonnet IC manifest is refused at the door (every IC is Haiku 5.5 now), and the
  # refusal names that rule before any allowlist or version gate runs.
  Write-Utf8 $manifestPath ((Get-Content $manifestPath -Raw).Replace('"model":"haiku"', '"model":"sonnet"'))
  $rms = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and "$($rms.reason)" -match 'Haiku 5\.5 only') "a sonnet IC manifest is refused at the door (got: $rms)"
  Write-Utf8 $manifestPath ((Get-Content $manifestPath -Raw).Replace('"model":"sonnet"', '"model":"haiku"'))
  # Fleet #350: a haiku manifest under auto launches on any CLI version: the recorded version
  # gates the allowlist rollback only. The IC keeps the Anthropic API, with no allow list.
  Write-Utf8 $manifestPath ((Get-Content $manifestPath -Raw).Replace('"permissions":"allowlist"', '"permissions":"auto"'))
  $env:MOCK_CLAUDE_VERSION = '2.1.999'
  $rda = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($rda.dryRun -eq $true -and $rda.model -eq 'haiku' -and $rda.permissions -eq 'auto') "a haiku manifest under auto dry-runs on any CLI (got: $rda)"
  Assert-True ("$($rda.command)" -match '--model claude-haiku-5-5 --effort xhigh ') "a manifest without an effort runs at the role file effort (got: $($rda.command))"
  $autoSettings = Get-Content "$testRoot\state\sessions\ic-77.settings.json" -Raw | ConvertFrom-Json
  Assert-True ($autoSettings.permissions.defaultMode -eq 'auto' -and $autoSettings.env.FLEET_PERMISSIONS -eq 'auto') 'a haiku IC under auto runs defaultMode auto'
  Assert-True ($rda.allowRules -eq 0 -and -not $autoSettings.permissions.PSObject.Properties['allow']) 'a haiku IC under auto carries no allow list'
  Assert-True (-not $autoSettings.PSObject.Properties['apiKeyHelper'] -and -not $autoSettings.env.PSObject.Properties['ANTHROPIC_BASE_URL']) 'a haiku IC keeps the Anthropic API'
  # Fleet #350: the manifest's effort is the IC's --effort; a value other than xhigh or max is refused.
  Write-Utf8 $manifestPath ((Get-Content $manifestPath -Raw).Replace('"permissions":"auto"', '"permissions":"auto","effort":"max"'))
  $rme = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($rme.dryRun -eq $true -and $rme.effort -eq 'max' -and "$($rme.command)" -match '--effort max ') "the manifest effort max is passed as --effort (got: $rme)"
  Write-Utf8 $manifestPath ((Get-Content $manifestPath -Raw).Replace('"effort":"max"', '"effort":"high"'))
  $rhi = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and "$($rhi.reason)" -match 'xhigh or max') "a manifest effort of high is refused (got: $rhi)"
  Write-Utf8 $manifestPath ((Get-Content $manifestPath -Raw).Replace('"effort":"high"', '"effort":"xhigh"'))
  # The rollback profile: a haiku manifest under allowlist still needs the recorded version, and the
  # allowlist settings are the ones written above. A rehearsal root stands aside that gate, as before.
  $rehearsal2 = Get-Content "$testRoot\config\permissions-allowlist.json" -Raw | ConvertFrom-Json
  $rehearsal2 | Add-Member -NotePropertyName rehearsalRoot -NotePropertyValue $true -Force
  Write-Utf8 "$testRoot\config\permissions-allowlist.json" ($rehearsal2 | ConvertTo-Json -Depth 6)
  Write-Utf8 $manifestPath ((Get-Content $manifestPath -Raw).Replace('"permissions":"auto"', '"permissions":"allowlist"'))
  $rdr = Run-Launch @('-Manifest', $manifestPath, '-DryRun')
  Assert-True ($rdr.dryRun -eq $true -and $rdr.permissions -eq 'allowlist') "a rehearsal root launches the allowlist rollback on a mismatched CLI (got: $rdr)"
  [IO.File]::Copy("$sourceRoot\config\permissions-allowlist.json", "$testRoot\config\permissions-allowlist.json", $true)
  Remove-Item Env:MOCK_CLAUDE_VERSION -ErrorAction SilentlyContinue
  Remove-Item $manifestPath
  Write-Utf8 "$testRoot\state\work\active.json" '{"records":{}}'

  # ADR 0011 (fleet #37): the Principal comes through the door as pe-<tenant>, on the
  # pinned Sonnet 5.5 id (owner ruling 2026-11-06, fleet #385; Opus 5.5 under ADR 0017 until then) at effort high, with the
  # control-plane tenant-repo denial and its own ceiling; it is named by scheme and needs a tenant; it neither counts toward
  # nor is refused by the cap.
  $rp = Run-Launch @('-Role', 'principal', '-Name', 'pe-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'Propose triage.', '-DryRun')
  Assert-True ($rp.dryRun -eq $true) "a principal dry run must pass the gates (got: $rp)"
  Assert-True ("$($rp.command)" -match '--model claude-sonnet-5-5 ') 'a principal with no -Model must run the pinned Sonnet 5.5 id (owner ruling 2026-11-06, fleet #385)'
  Assert-True ("$($rp.command)" -match '--effort high') 'a principal must run at the role file effort'
  Assert-True ($rp.budget.ceiling -eq 30000) 'the principal ceiling must come from config/cycle.json'
  $denyP = @((Get-Content "$testRoot\state\sessions\pe-test.settings.json" -Raw | ConvertFrom-Json).permissions.deny)
  Assert-True (-not ($denyP -contains "Edit($repoFwd/**)")) 'a principal must NOT carry the blanket tenant-repo denial: hooks/principal-guard.ps1 enforces its allowlist (fleet #39)'
  Assert-True ($denyP -contains "Edit($rootFwd/state/work/**)") 'a principal still loses the direct state-door writes'
  $rpf = Run-Launch @('-Role', 'principal', '-Name', 'pe-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'Propose triage.', '-Model', 'fable', '-DryRun')
  Assert-True ("$($rpf.command)" -match '--model claude-fable-5-1') 'an explicit -Model fable must resolve to the same pinned id'
  # ADR 0017: the Arbiter comes through the door as ar-<tenant> on the pinned Opus 5.5 id at
  # effort xhigh, with its own first-turn ceiling; it is named by scheme and needs a tenant.
  $rar = Run-Launch @('-Role', 'arbiter', '-Name', 'ar-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'Decide triage.', '-DryRun')
  Assert-True ($rar.dryRun -eq $true) "an arbiter dry run must pass the gates (got: $rar)"
  Assert-True ("$($rar.command)" -match '--model claude-opus-5-5') 'an arbiter with no -Model must run the pinned Opus 5.5 id (owner ruling 2026-10-20)'
  Assert-True ("$($rar.command)" -match '--effort xhigh') 'an arbiter must run at the role file effort'
  Assert-True ($rar.budget.ceiling -eq 30000) 'the arbiter ceiling must come from config/cycle.json'
  Run-Launch @('-Role', 'arbiter', '-Name', 'pe-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'x', '-DryRun') | Out-Null
  Assert-True ($script:lastExit -eq 4) 'an arbiter not named ar-<tenant> must be refused as a usage error'
  Run-Launch @('-Role', 'arbiter', '-Name', 'ar-test', '-Parent', 'dispatcher', '-Prompt', 'x', '-DryRun') | Out-Null
  Assert-True ($script:lastExit -eq 4) 'an arbiter without -Tenant must be refused as a usage error'
  $rpl = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-DryRun')
  Assert-True ("$($rpl.command)" -match '--model claude-sonnet-5-5 ') 'a project lead with no -Model must run the pinned Sonnet 5.5 id (owner ruling 2026-10-26)'
  # fleet #392: every launch records a reason. The dry run names the one it was given; a launch given none is a human's, so manual.
  $rrd = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-DryRun')
  Assert-True ($rrd.launchReason -eq 'manual') "a launch with no -Reason must record manual in its output (got: $rrd)"
  $rrw = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-Reason', 'wake:frontier #392', '-DryRun')
  Assert-True ($rrw.dryRun -eq $true -and $rrw.launchReason -eq 'wake:frontier #392') "the dry run must name the reason it was given (got: $rrw)"
  # Windows PowerShell drops a bare '' argument to a native exe, so pass a quoted empty to reach the validator itself.
  $rre = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-Reason', '""', '-DryRun')
  Assert-True ($script:lastExit -ne 0 -and "$rre" -match 'null or empty') "an empty -Reason must be refused by its validator, never recorded as an empty reason (got: $rre)"
  $rplo = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-Model', 'sonnet', '-DryRun')
  Assert-True ("$($rplo.command)" -match '--model sonnet\b') 'an explicit -Model must still override the project lead default (ICs take no sonnet: fleet #350)'
  # Fleet #350 (ruling 13): haiku is the IC's model alone. A control-plane role runs its role file's model,
  # so -Model haiku on one is refused at the door, dry runs included.
  $rplh = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-Model', 'haiku', '-DryRun')
  Assert-True ($script:lastExit -eq 3 -and $rplh.launched -eq $false -and "$($rplh.reason)" -match 'haiku is the IC model') "a project lead on -Model haiku must be refused (got: $rplh)"
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
  # ADR 0017: the Arbiter is cap-exempt the same way (ar- prefix).
  Write-Utf8 "$testRoot\roster.json" '{"cap":1,"sessions":[{"name":"ar-test","role":"arbiter","tenant":"test","parent":"dispatcher","cwd":"x","prompt":"p"},{"name":"pl-test","role":"project-lead","tenant":"test","parent":"dispatcher","cwd":"x","prompt":"p"}]}'
  $rcap3 = Run-Launch @('-Role', 'arbiter', '-Name', 'ar-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'p', '-DryRun')
  Assert-True ($rcap3.dryRun -eq $true) "a full cap must not refuse the arbiter (got: $rcap3)"

  # Fleet #394 (the effort trial): a tenant file's roleEffort sets a non-IC role's effort for that tenant alone. The role
  # files stay project-lead low, principal high, arbiter xhigh and ic xhigh; the tenant file is restored after these cases.
  $tenantFile = "$testRoot\tenants\test.json"
  $tenantOriginal = Get-Content $tenantFile -Raw
  function Set-TenantRoleEffort { param([string]$RoleEffortJson) Write-Utf8 $tenantFile ($tenantOriginal.Replace('"maxIcs":2,', '"maxIcs":2,"roleEffort":' + $RoleEffortJson + ',')) }
  # The lead's real claude --bg: the mock daemon is empty until --bg, then lists the lead, and logs the --bg arguments.
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  Write-Utf8 "$testRoot\mock-agents-after-launch.json" '[{"id":"job-pl","name":"pl-test","state":"working","status":"idle","pid":22,"sessionId":"sess-pl","startedAt":1756000000000}]'
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" + 'if "%1"=="--bg" (echo %* >> "' + $testRoot + '\claude-bg.log" & copy /y "' + $testRoot + '\mock-agents-after-launch.json" "' + $testRoot + '\mock-agents.json" >nul)' + "`r`n" + 'exit /b 0' + "`r`n")
  Set-TenantRoleEffort '{"project-lead":"medium"}'
  # Case 1: the lead runs claude --bg at medium, and its roster row records medium.
  $rl = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead')
  Assert-True ($script:lastExit -eq 0 -and $rl.launched -eq $true) "a lead launch under roleEffort medium must launch (got: $rl)"
  Assert-True ((Get-Content "$testRoot\claude-bg.log" -Raw -ErrorAction SilentlyContinue) -match '--effort medium ') 'a project lead named in roleEffort must run claude --bg at medium'
  $leadRow = @((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'pl-test' -and $_.status -eq 'active' })[0]
  Assert-True ("$($leadRow.effort)" -eq 'medium') "the roster row must record effort medium from roleEffort (got: '$($leadRow.effort)')"
  # The dry runs below start from an empty daemon and live roster, so the lead just launched is not a duplicate.
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  # Case 2: only the named role changes; the principal keeps its role file effort.
  $rpe = Run-Launch @('-Role', 'principal', '-Name', 'pe-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'Propose triage.', '-DryRun')
  Assert-True ("$($rpe.command)" -match '--effort high') "a principal under a roleEffort that names only the lead must keep its role file effort high (got: $($rpe.command))"
  # Case 3: an invalid value falls back to the role file's effort, silently: the launch result is the only output.
  Set-TenantRoleEffort '{"project-lead":"ultra"}'
  $rli = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead', '-DryRun')
  Assert-True ($script:lastExit -eq 0 -and $rli.effort -eq 'low' -and "$($rli.command)" -match '--effort low ') "an invalid roleEffort must fall back to the role file's low (got: $rli)"
  Assert-True (@($script:lastOut.Trim() -split "`n").Count -eq 1) "an invalid roleEffort must print nothing beyond the launch result (got: $($script:lastOut))"
  # Case 4: an IC never reads roleEffort; it runs its role file effort, xhigh.
  Set-TenantRoleEffort '{"ic":"medium"}'
  $rhr = Run-Launch @('-Role', 'ic', '-Name', 'ic-999', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '999', '-Prompt', 'Do the thing.', '-DryRun')
  Assert-True ($rhr.effort -eq 'xhigh' -and "$($rhr.command)" -match '--effort xhigh ') "an IC must ignore roleEffort and run the role file effort xhigh (got: $($rhr.command))"
  Write-Utf8 $tenantFile $tenantOriginal

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
