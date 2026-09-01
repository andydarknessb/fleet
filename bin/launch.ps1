<#
.SYNOPSIS  The only door for starting a fleet session (ADR 0002).
.EXAMPLE   launch.ps1 -Role ic -Name ic-118 -Tenant endzone -Parent pl-endzone -Issue 118 -Prompt "..."
.EXAMPLE   launch.ps1 -FromRoster dispatcher
.EXAMPLE   launch.ps1 -FromRoster sentinel -DryRun
#>
[CmdletBinding()]
param(
  [string]$Role, [string]$Name, [string]$Tenant, [string]$Parent, [string]$Prompt, [int]$Issue,
  [string]$FromRoster, [string]$Manifest, [string]$WorkRecordId,
  [ValidateSet('', 'sonnet', 'opus', 'haiku', 'fable')]
  [string]$Model,   # per-launch override of the role file's model (project leads use it per ticket); 'opus' pins to Opus 4.8, see $modelArgs below
  [switch]$Force,   # bypass the cap (Cory only)
  [switch]$DryRun   # do everything except start the session
)
. "$PSScriptRoot\_common.ps1"
$static = Get-StaticRoster
$live = Get-LiveRoster
$cwd = $null
$t = $null
$worktreePath = $null
if ($Manifest) {
  if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { Write-Error "manifest '$Manifest' was not found"; exit 4 }
  $assignment = Read-Json $Manifest
  if (-not $assignment -or $assignment.status -ne 'pending-ack') { Write-Error "manifest '$Manifest' is not pending acknowledgment"; exit 4 }
  if ($WorkRecordId -and $assignment.workRecordId -ne $WorkRecordId) { Write-Error "manifest Work record does not match -WorkRecordId"; exit 4 }
  $WorkRecordId = $assignment.workRecordId
  $Role = 'ic'
  $Name = "ic-$($assignment.issue.number)"
  $Tenant = $assignment.tenant
  $Parent = $assignment.parent
  $Issue = [int]$assignment.issue.number
  $Model = [string]$assignment.model
  $Prompt = "Read the assignment manifest at $Manifest. Emit assignment-started for Work record $WorkRecordId in your first useful turn, then follow the manifest pointers without restating the issue criteria."
  $tenantConfig = Read-Json "$FleetHome\tenants\$Tenant.json"
  if (-not $tenantConfig) { Write-Error "no tenant file for '$Tenant'"; exit 4 }
  $cwd = $tenantConfig.repo
  if (Test-Path -LiteralPath "$Manifest.invalidated.json") { Write-Error "manifest '$Manifest' was invalidated"; exit 4 }
}
if ($FromRoster) {
  $e = $static.sessions | Where-Object { $_.name -eq $FromRoster }
  if (-not $e) { Write-Error "no static roster entry named '$FromRoster'"; exit 4 }
  $Role = $e.role; $Name = $e.name; $Tenant = $e.tenant; $Parent = $e.parent; $Prompt = $e.prompt; $cwd = $e.cwd
}
foreach ($req in 'Role','Name','Parent','Prompt') { if (-not (Get-Variable $req -ValueOnly)) { Write-Error "missing -$req"; exit 4 } }
if ($Name -notmatch '^(dispatcher|sentinel|pl-[a-z0-9-]+|ic-[0-9]+)$') { Write-Error "name '$Name' does not match the fleet naming scheme"; exit 4 }
# Ticket 08b: while the rostered Sentinel is cut over, the one door refuses to start a
# second supervisor (not even with -Force: two actors is the failure cutover exists to
# prevent). rollback-sentinel.ps1 removes the flag first, then comes through here. A
# dry run still evaluates the other gates so rollback can be rehearsed.
if (($Role -eq 'sentinel' -or $Name -eq 'sentinel') -and (Test-SentinelOff) -and -not $DryRun) {
  Write-Output (@{ launched = $false; reason = 'the rostered Sentinel is disabled by state/flags/sentinel-off (scheduled supervision is live); use bin\rollback-sentinel.ps1 to restore it' } | ConvertTo-Json -Compress); exit 3
}
if ($Tenant) {
  $t = Read-Json "$FleetHome\tenants\$Tenant.json"
  if (-not $t) { Write-Error "no tenant file for '$Tenant'"; exit 4 }
  if (-not $cwd) { $cwd = $t.repo }
}
if (-not $cwd) { $cwd = $FleetHome }

if ($Manifest) {
  $activeState = Read-Json "$FleetHome\state\work\active.json"
  $recordProperty = if ($activeState) { $activeState.records.PSObject.Properties[$WorkRecordId] } else { $null }
  if (-not $recordProperty -or $recordProperty.Value.state -ne 'assigned') { Write-Error "Work record '$WorkRecordId' is not assigned"; exit 4 }
  $activeAssignments = @($activeState.records.PSObject.Properties | ForEach-Object { $_.Value } | Where-Object { $_.manifestPath -and $_.state -ne 'retired' -and $_.id -ne $WorkRecordId })
  if ($activeAssignments.Count -ge 3) { Write-Error 'a fourth assignment is not permitted'; exit 4 }
  if ($activeAssignments.Count -ge 2) {
    $proof = $assignment.independenceProof
    $expectedCandidates = @($activeAssignments | ForEach-Object { [int]$_.issue }) + @([int]$Issue) | Sort-Object
    $actualCandidates = @($proof.candidates | ForEach-Object { [int]$_ }) | Sort-Object
    $expectedFields = @('components', 'migrationPrefixes', 'schemaAreas', 'testResources')
    $actualFields = @($proof.checkedFields | ForEach-Object { [string]$_ }) | Sort-Object
    $proofValid = $proof -and $proof.independent -and @($proof.conflicts).Count -eq 0 -and (($actualCandidates -join ',') -eq ($expectedCandidates -join ',')) -and (($actualFields -join ',') -eq (($expectedFields | Sort-Object) -join ','))
    if (-not $proofValid) { Write-Error 'a third assignment requires a verified independent machine-readable proof'; exit 4 }
  }
}

function Invalidate-Manifest {
  param([string]$Reason)
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'node is required to release the assignment reservation' }
  & $node.Source "$FleetHome\bin\work-state.js" release --root $FleetHome --id $WorkRecordId --expected-revision $assignment.workRecordRevision --idempotency-key "assignment-invalidated:$($assignment.id)" --evidence $Reason 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "assignment reservation release failed for Work record '$WorkRecordId'" }
  Write-Json "$Manifest.invalidated.json" ([pscustomobject]@{ schemaVersion = 1; manifestId = $assignment.id; invalidatedAt = (Now-Iso); reason = $Reason })
}

if ($Manifest -and -not $DryRun) {
  $issueRaw = (& gh issue view $Issue -R $t.github --json state,body 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { Write-Error "could not reconcile issue #$Issue before launch"; exit 4 }
  try { $currentIssue = $issueRaw | ConvertFrom-Json } catch { Write-Error "GitHub issue reconciliation returned invalid JSON"; exit 4 }
  if ([string]$currentIssue.state -ne 'OPEN') { Invalidate-Manifest "issue #$Issue is no longer open"; Write-Error "issue #$Issue is no longer open"; exit 4 }
  $hash = [Security.Cryptography.SHA256]::Create()
  $actualBodyHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$currentIssue.body))).Replace('-', '').ToLowerInvariant()
  if ($actualBodyHash -ne [string]$assignment.issue.bodyHash) {
    Invalidate-Manifest 'issue body hash changed before acknowledgment'
    Write-Error "issue #$Issue changed after the manifest was created; assignment invalidated"
    exit 4
  }
}

# --- gates ---
if ((Test-Paused) -and -not $Force) {
  $p = Get-Content "$FleetHome\state\PAUSE" -Raw
  Write-Output (@{ launched = $false; reason = "PAUSE set: $p" } | ConvertTo-Json -Compress); exit 3
}
# The duplicate-name guard and the cap read the same daemon list the caller may have
# acted on; a glitched read must refuse the launch, never pass the guards empty.
$daemon = $null
try { $daemon = Get-DaemonSessions -Strict } catch {
  Write-Output (@{ launched = $false; reason = "refusing to launch, fail closed: $($_.Exception.Message)" } | ConvertTo-Json -Compress); exit 3
}
$fleetNames = Get-FleetNames -Live $live -Static $static
$liveFleet = @($daemon | Where-Object { $fleetNames -contains $_.name })
if (@($liveFleet | ForEach-Object { $_.name }) -contains $Name) {
  Write-Output (@{ launched = $false; reason = "a session named '$Name' is already running; use claude respawn" } | ConvertTo-Json -Compress); exit 3
}
# The list can also read WRONG (empty or partial) while the CLI exits 0. The roster's
# job record is an independent on-disk source: if it says this name's job is still
# working and recently updated (45 min = the fleet staleness threshold), refuse the
# duplicate rather than trust the list that omitted it. A stale or stopped job state
# stays launchable, so crash recovery is not blocked.
$rosterEntry = $live.sessions | Where-Object { $_.name -eq $Name -and $_.status -eq 'active' } | Select-Object -First 1
if ($rosterEntry -and $rosterEntry.jobId) {
  $jobState = $null
  try { $jobState = Get-JobState $rosterEntry.jobId } catch {}
  if ($jobState -and "$($jobState.state)" -eq 'working') {
    $updatedAge = $null
    try { $updatedAge = ((Get-Date).ToUniversalTime() - ([DateTimeOffset]::Parse("$($jobState.updatedAt)", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)).UtcDateTime).TotalMinutes } catch {}
    if ($null -ne $updatedAge -and $updatedAge -le 45) {
      Write-Output (@{ launched = $false; reason = "job $($rosterEntry.jobId) for '$Name' is working per its on-disk state (updated $([int]$updatedAge) min ago) though the daemon list omits it; suspected bad read, refusing a duplicate launch" } | ConvertTo-Json -Compress); exit 3
    }
  }
}
if (-not $Force -and $liveFleet.Count -ge [int]$static.cap) {
  Write-Output (@{ launched = $false; reason = "cap reached ($($liveFleet.Count)/$($static.cap))" } | ConvertTo-Json -Compress); exit 3
}
if ($Role -eq 'ic') {
  if (-not $Issue) { Write-Error "ICs need -Issue"; exit 4 }
  $liveNames = @($liveFleet | ForEach-Object { $_.name })
  $icsHere = @($live.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' -and $_.tenant -eq $Tenant -and ($liveNames -contains $_.name) })
  if (-not $Force -and $icsHere.Count -ge [int]$t.maxIcs) {
    Write-Output (@{ launched = $false; reason = "tenant maxIcs reached ($($icsHere.Count)/$($t.maxIcs))" } | ConvertTo-Json -Compress); exit 3
  }
}

# --- per-session settings: fleet-settings + env identity ---
$settings = Read-Json "$FleetHome\fleet-settings.json"
$envBlock = [ordered]@{ FLEET_HOME = $FleetHome; FLEET_NAME = $Name; FLEET_ROLE = $Role; FLEET_TENANT = "$Tenant"; FLEET_PARENT = $Parent }
if ($Issue) { $envBlock.FLEET_ISSUE = "$Issue" }
if ($Manifest) {
  $envBlock.FLEET_ASSIGNMENT_MANIFEST = (Resolve-Path -LiteralPath $Manifest).Path
  $envBlock.FLEET_WORK_RECORD_ID = $WorkRecordId
  $envBlock.FLEET_BASE_SHA = [string]$assignment.base.sha
  $envBlock.FLEET_ASSIGNMENT_BRANCH = [string]$assignment.branch
}
$settings | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]$envBlock) -Force

# --- role tool contract (ticket 06). work-state.js stays the one validated door to
# --- durable coordination state, so every role loses direct file-editing tools on
# --- state/work|events|archive (and, since ticket 07, state/exclusions - bin/exclusions.js
# --- is that ledger's door - plus the digest projections, which only bin/digest.js
# --- writes); control-plane roles additionally lose engineering
# --- edits in tenant repos (they review and merge, ICs write); ICs lose direct
# --- edits anywhere in fleet state. Rollback: state/flags/tool-contract-off skips
# --- the injection without touching any launch gate.
$fleetFwd = $FleetHome.Replace('\', '/')
$denyRules = @()
$toolContractOn = -not (Test-Path "$FleetHome\state\flags\tool-contract-off")
if ($toolContractOn) {
  foreach ($deniedTool in 'Edit', 'Write', 'NotebookEdit') {
    foreach ($statePath in 'state/work/**', 'state/events/**', 'state/archive/**', 'state/exclusions/**', 'state/status/DIGEST.md', 'state/status/*-status.md') { $denyRules += "$deniedTool($fleetFwd/$statePath)" }
    if ($Role -eq 'ic') { $denyRules += "$deniedTool($fleetFwd/state/**)" }
  }
  if ($Role -in @('dispatcher', 'project-lead', 'sentinel')) {
    foreach ($tenantFile in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)) {
      $tenantRepo = $null
      try { $tenantRepo = (Read-Json $tenantFile.FullName).repo } catch {}
      if ($tenantRepo) { foreach ($deniedTool in 'Edit', 'Write', 'NotebookEdit') { $denyRules += "$deniedTool($($tenantRepo.Replace('\', '/'))/**)" } }
    }
  }
}
if ($denyRules.Count -gt 0) {
  if (-not $settings.PSObject.Properties['permissions']) { $settings | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{}) -Force }
  $existingDeny = @()
  if ($settings.permissions.PSObject.Properties['deny']) { $existingDeny = @($settings.permissions.deny) }
  $settings.permissions | Add-Member -NotePropertyName deny -NotePropertyValue (@(@($existingDeny + $denyRules) | Select-Object -Unique)) -Force
}

$settingsPath = "$FleetHome\state\sessions\$Name.settings.json"
Write-Json $settingsPath $settings

# The friendly -Model token is passed to `claude --model`, but the bare 'opus'
# alias tracks the latest Opus (currently Opus 5). ICs must run Opus 4.8, so pin
# 'opus' to the concrete id; other tokens keep their CLI aliases (latest).
$modelArgs = @()
if ($Model) {
  $resolvedModel = if ($Model -eq 'opus') { 'claude-opus-4-8' } else { $Model }
  $modelArgs = @('--model', $resolvedModel)
}

# The role file frontmatter declares `effort:`, but `claude --agent` does NOT read
# it for a top-level background session (it defaults every such session to high;
# e.g. sentinel.md says low yet ran at high). So parse the role file ourselves and
# pass the declared effort with --effort, the only lever that sticks for --bg.
$effort = ''
$roleFile = "$FleetHome\agents\$Role.md"
if (Test-Path $roleFile) {
  $m = Select-String -Path $roleFile -Pattern '^\s*effort:\s*(\S+)' | Select-Object -First 1
  if ($m) { $effort = $m.Matches[0].Groups[1].Value }
}
$effortArgs = @()
if ($effort -in @('low','medium','high','xhigh','max')) { $effortArgs = @('--effort', $effort) }

# --- first-turn ceiling (ticket 06): a launch that would start over its role's
# --- config/cycle.json budget fails before assignment and reports the token
# --- contribution by source. The estimate counts the fleet-injected sources
# --- (prompt, role file, simulated session-start injection, settings) at ~4
# --- chars/token plus the configured baselineTokens; calibrating baselineTokens
# --- against measured cache creation is ticket 09's verification. Rollback:
# --- state/flags/launch-ceiling-off, or -Force.
$budget = $null
$ceiling = 0
$ceilings = $null
try { $ceilings = (Read-Json "$FleetHome\config\cycle.json").firstTurnCeilings } catch {}
if ($ceilings -and $ceilings.PSObject.Properties[$Role]) { $ceiling = [int]$ceilings.$Role }
if ($ceiling -gt 0 -and -not (Test-Path "$FleetHome\state\flags\launch-ceiling-off")) {
  $hookChars = 0
  $hookPath = "$FleetHome\hooks\session-start.ps1"
  if (Test-Path $hookPath) {
    $savedEnv = @{}
    foreach ($pair in $envBlock.GetEnumerator()) { $savedEnv[$pair.Key] = [Environment]::GetEnvironmentVariable($pair.Key) }
    try {
      foreach ($pair in $envBlock.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, "$($pair.Value)") }
      $hookChars = ('' | & powershell -NoProfile -ExecutionPolicy Bypass -File $hookPath 2>$null | Out-String).Length
    } catch {} finally {
      foreach ($savedKey in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($savedKey, $savedEnv[$savedKey]) }
    }
  }
  $roleChars = 0
  if (Test-Path $roleFile) { $roleChars = (Get-Content $roleFile -Raw).Length }
  $baseline = 0
  if ($ceilings.PSObject.Properties['baselineTokens']) { $baseline = [int]$ceilings.baselineTokens }
  $sources = [ordered]@{
    baseline = $baseline
    prompt = [int][Math]::Ceiling("$Prompt".Length / 4)
    roleFile = [int][Math]::Ceiling($roleChars / 4)
    sessionStartInjection = [int][Math]::Ceiling($hookChars / 4)
    settings = [int][Math]::Ceiling((Get-Content $settingsPath -Raw).Length / 4)
  }
  $estimate = 0
  foreach ($sourceTokens in $sources.Values) { $estimate += $sourceTokens }
  $budget = [pscustomobject]@{ role = $Role; ceiling = $ceiling; estimatedTokens = $estimate; sources = [pscustomobject]$sources }
  if ($estimate -gt $ceiling -and -not $Force) {
    Write-Output (@{ launched = $false; reason = "first-turn ceiling exceeded for role '$Role': $estimate estimated tokens > $ceiling (see budget.sources)"; budget = $budget } | ConvertTo-Json -Compress -Depth 6); exit 6
  }
}

if ($DryRun) {
  Write-Output (@{ launched = $false; dryRun = $true; name = $Name; role = $Role; tenant = $Tenant; parent = $Parent; model = $Model; effort = $effort; cwd = $cwd; settings = $settingsPath; budget = $budget; liveFleet = $liveFleet.Count; cap = $static.cap; command = "claude --bg --name $Name --agent $Role $($modelArgs -join ' ') $($effortArgs -join ' ') --settings $settingsPath <prompt>".Replace('  ', ' ') } | ConvertTo-Json -Compress -Depth 6)
  exit 0
}

$worktreePath = $null
if ($Manifest) {
  $baseRemote = [string]$assignment.base.remote
  $baseRef = [string]$assignment.base.ref
  $expectedBase = [string]$assignment.base.sha
  if (-not $baseRemote -or -not $baseRef -or $expectedBase -notmatch '^[0-9a-fA-F]{40}$') { Write-Error "manifest '$Manifest' has an invalid base precondition"; exit 4 }
  & git -C $cwd fetch $baseRemote $baseRef --prune 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Error "could not fetch $baseRemote/$baseRef for manifest '$Manifest'"; exit 4 }
  $resolvedBase = (& git -C $cwd rev-parse "refs/remotes/$baseRemote/$baseRef" 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $resolvedBase -ne $expectedBase) { Invalidate-Manifest "manifest base precondition changed (expected $expectedBase, found $resolvedBase)"; Write-Error "manifest base precondition changed (expected $expectedBase, found $resolvedBase)"; exit 4 }
  $worktreeParent = Join-Path $cwd '.claude\worktrees'
  $worktreePath = Join-Path $worktreeParent "$Name-assignment"
  if (Test-Path -LiteralPath $worktreePath) { Write-Error "assignment worktree already exists: $worktreePath"; exit 4 }
  New-Item -ItemType Directory -Force $worktreeParent | Out-Null
  & git -C $cwd worktree add -b $assignment.branch $worktreePath $expectedBase 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Error "could not create assignment worktree from $expectedBase"; exit 4 }
  $cwd = $worktreePath
}

# --- launch ---
$before = @($daemon | ForEach-Object { $_.sessionId })
$beforeJobIds = @(Get-DaemonSessions -All | ForEach-Object { $_.id })
$locationPushed = $false
try {
  Push-Location $cwd
  $locationPushed = $true
  # Windows PowerShell 5.1 re-parses embedded double quotes in a string passed
  # as a native positional argument. Fleet briefs contain quoted issue titles,
  # so argv delivery silently truncated every measured IC prompt. stdin is the
  # CLI's prompt input as well, and preserves the exact string without another
  # command-line parse.
  $out = $Prompt | & claude --bg --name $Name --agent $Role @modelArgs @effortArgs --settings $settingsPath 2>&1 | Out-String
} catch {
  if ($locationPushed) { Pop-Location; $locationPushed = $false }
  if ($worktreePath -and (Test-Path -LiteralPath $worktreePath)) {
    & git -C $t.repo worktree remove --force $worktreePath 2>$null | Out-Null
    & git -C $t.repo worktree prune 2>$null | Out-Null
  }
  throw
} finally {
  if ($locationPushed) { Pop-Location }
}
$row = $null
for ($i = 0; $i -lt 20 -and -not $row; $i++) {
  Start-Sleep -Milliseconds 750
  $row = Get-DaemonSessions | Where-Object { $_.name -eq $Name -and ($before -notcontains $_.sessionId) } | Select-Object -First 1
}
if (-not $row) {
  if ($worktreePath -and (Test-Path -LiteralPath $worktreePath)) {
    & git -C $t.repo worktree remove --force $worktreePath 2>$null | Out-Null
    & git -C $t.repo worktree prune 2>$null | Out-Null
  }
  $failedRow = Get-DaemonSessions -All |
    Where-Object { $_.name -eq $Name -and ($beforeJobIds -notcontains $_.id) } |
    Select-Object -First 1
  $jobState = if ($failedRow) { Get-JobState $failedRow.id } else { $null }
  $detail = if ($jobState -and $jobState.detail) { "$($jobState.detail)" } else { $null }
  Write-Output (@{ launched = $false; reason = "claude --bg did not produce a session named '$Name'"; detail = $detail; output = $out } | ConvertTo-Json -Compress); exit 5
}

# --- record ---
$entry = [pscustomobject]@{
  name = $Name; role = $Role; tenant = $Tenant; parent = $Parent; issue = $Issue; cwd = $cwd
  model = $Model; effort = $effort
  jobId = $row.id; sessionId = $row.sessionId; prompt = $Prompt; settings = $settingsPath; manifest = $Manifest; workRecordId = $WorkRecordId
  status = 'active'; launchedAt = (Now-Iso); retiredAt = $null
}
$live.sessions = @($live.sessions | Where-Object { $_.name -ne $Name }) + @($entry)
Save-LiveRoster $live
Write-Output (@{ launched = $true; name = $Name; jobId = $row.id; sessionId = $row.sessionId; cwd = $cwd } | ConvertTo-Json -Compress)
exit 0
