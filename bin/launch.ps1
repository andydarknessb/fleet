<#
.SYNOPSIS  The only door for starting a fleet session (ADR 0002).
.EXAMPLE   launch.ps1 -Role ic -Name ic-118 -Tenant endzone -Parent pl-endzone -Issue 118 -Prompt "..."
.EXAMPLE   launch.ps1 -FromRoster dispatcher
.EXAMPLE   launch.ps1 -FromRoster sentinel -DryRun
#>
[CmdletBinding()]
param(
  [string]$Role, [string]$Name, [string]$Tenant, [string]$Parent, [string]$Prompt, [int]$Issue,
  [string]$FromRoster,
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
if ($FromRoster) {
  $e = $static.sessions | Where-Object { $_.name -eq $FromRoster }
  if (-not $e) { Write-Error "no static roster entry named '$FromRoster'"; exit 4 }
  $Role = $e.role; $Name = $e.name; $Tenant = $e.tenant; $Parent = $e.parent; $Prompt = $e.prompt; $cwd = $e.cwd
}
foreach ($req in 'Role','Name','Parent','Prompt') { if (-not (Get-Variable $req -ValueOnly)) { Write-Error "missing -$req"; exit 4 } }
if ($Name -notmatch '^(dispatcher|sentinel|pl-[a-z0-9-]+|ic-[0-9]+)$') { Write-Error "name '$Name' does not match the fleet naming scheme"; exit 4 }
if ($Tenant) {
  $t = Read-Json "$FleetHome\tenants\$Tenant.json"
  if (-not $t) { Write-Error "no tenant file for '$Tenant'"; exit 4 }
  if (-not $cwd) { $cwd = $t.repo }
}
if (-not $cwd) { $cwd = $FleetHome }

# --- gates ---
if ((Test-Paused) -and -not $Force) {
  $p = Get-Content "$FleetHome\state\PAUSE" -Raw
  Write-Output (@{ launched = $false; reason = "PAUSE set: $p" } | ConvertTo-Json -Compress); exit 3
}
$daemon = Get-DaemonSessions
$fleetNames = Get-FleetNames -Live $live -Static $static
$liveFleet = @($daemon | Where-Object { $fleetNames -contains $_.name })
if (@($liveFleet | ForEach-Object { $_.name }) -contains $Name) {
  Write-Output (@{ launched = $false; reason = "a session named '$Name' is already running; use claude respawn" } | ConvertTo-Json -Compress); exit 3
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
$settings | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]$envBlock) -Force
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

if ($DryRun) {
  Write-Output (@{ launched = $false; dryRun = $true; name = $Name; role = $Role; tenant = $Tenant; parent = $Parent; model = $Model; effort = $effort; cwd = $cwd; settings = $settingsPath; liveFleet = $liveFleet.Count; cap = $static.cap; command = "claude --bg --name $Name --agent $Role $($modelArgs -join ' ') $($effortArgs -join ' ') --settings $settingsPath <prompt>".Replace('  ', ' ') } | ConvertTo-Json -Compress)
  exit 0
}

# --- launch ---
$before = @($daemon | ForEach-Object { $_.sessionId })
$beforeJobIds = @(Get-DaemonSessions -All | ForEach-Object { $_.id })
Push-Location $cwd
try {
  # Windows PowerShell 5.1 re-parses embedded double quotes in a string passed
  # as a native positional argument. Fleet briefs contain quoted issue titles,
  # so argv delivery silently truncated every measured IC prompt. stdin is the
  # CLI's prompt input as well, and preserves the exact string without another
  # command-line parse.
  $out = $Prompt | & claude --bg --name $Name --agent $Role @modelArgs @effortArgs --settings $settingsPath 2>&1 | Out-String
} finally { Pop-Location }
$row = $null
for ($i = 0; $i -lt 20 -and -not $row; $i++) {
  Start-Sleep -Milliseconds 750
  $row = Get-DaemonSessions | Where-Object { $_.name -eq $Name -and ($before -notcontains $_.sessionId) } | Select-Object -First 1
}
if (-not $row) {
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
  jobId = $row.id; sessionId = $row.sessionId; prompt = $Prompt; settings = $settingsPath
  status = 'active'; launchedAt = (Now-Iso); retiredAt = $null
}
$live.sessions = @($live.sessions | Where-Object { $_.name -ne $Name }) + @($entry)
Save-LiveRoster $live
Write-Output (@{ launched = $true; name = $Name; jobId = $row.id; sessionId = $row.sessionId; cwd = $cwd } | ConvertTo-Json -Compress)
exit 0
