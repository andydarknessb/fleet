<#
.SYNOPSIS  Build a scratch fleet root from the current tree (spec #94, #163).
.DESCRIPTION
  Copies the checked-out fleet tree (tracked and untracked-but-not-ignored files; never
  state/ or .scratch/) to -Path, then gives it an empty state tree, a roster capped at
  one session, the one tenant file named by -Tenant (unchanged: it points at the real
  tenant checkout and GitHub repo), and a fleet-settings.json whose hooks run the
  scratch root's own hooks and whose deny rules fence off the live root. Every door
  resolves its fleet home from its own location (_common.ps1), so anything launched
  from the scratch root reads and writes the scratch root.
  It is what the rehearsal (#164) and every later CLI re-test start from: one command
  here, one assign, one launch.
.EXAMPLE   bin\scratch-root.ps1 -Path E:\fleet-scratch
.EXAMPLE   bin\scratch-root.ps1 -Path E:\fleet-scratch -Tenant endzone -Issue 1650
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Tenant = 'endzone',
  [int]$Issue,          # the rehearsal's chosen ticket; only fills in the printed commands
  [string]$Parent,      # the IC's parent in the printed assign (default pl-<tenant>)
  [string]$LiveRoot     # the running fleet (default: the target of ~/.claude/agents, else ~/fleet)
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

function Refuse {
  param([string]$Reason)
  Write-Output (@{ ok = $false; reason = $Reason } | ConvertTo-Json -Compress)
  exit 2
}
function Test-Inside {
  param([string]$Child, [string]$Parent)
  if (-not $Parent) { return $false }
  $p = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $c = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
  return $c.Equals($p, [StringComparison]::OrdinalIgnoreCase) -or $c.StartsWith("$p\", [StringComparison]::OrdinalIgnoreCase)
}
function Write-Utf8 { param([string]$File, [string]$Text) [IO.File]::WriteAllText($File, $Text, (New-Object Text.UTF8Encoding $false)) }

if (-not $LiveRoot) {
  $agentsLink = Join-Path $env:USERPROFILE '.claude\agents'
  $linkTarget = $null
  try { $linkTarget = @((Get-Item -LiteralPath $agentsLink -Force -ErrorAction Stop).Target)[0] } catch {}
  $LiveRoot = if ($linkTarget) { Split-Path -Parent "$linkTarget" } else { Join-Path $env:USERPROFILE 'fleet' }
}
$root = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')

# --- refusals: the scratch root must be outside everything it must not touch ---
if (Test-Inside $root $LiveRoot) { Refuse "'$root' is inside the live fleet root '$LiveRoot'; a scratch root lives outside it" }
if (Test-Inside $root $sourceRoot) { Refuse "'$root' is inside the source tree '$sourceRoot'; a scratch root lives outside it" }
$tenantFiles = @(Get-ChildItem -LiteralPath "$sourceRoot\tenants" -Filter *.json -ErrorAction SilentlyContinue)
foreach ($tenantFile in $tenantFiles) {
  $repo = $null
  try { $repo = (Get-Content -LiteralPath $tenantFile.FullName -Raw | ConvertFrom-Json).repo } catch {}
  if ($repo -and (Test-Inside $root $repo)) { Refuse "'$root' is inside the tenant repo '$repo' ($($tenantFile.Name)); a scratch root lives outside every tenant checkout" }
}
$tenantSource = "$sourceRoot\tenants\$Tenant.json"
if (-not (Test-Path -LiteralPath $tenantSource -PathType Leaf)) { Refuse "no tenant file '$Tenant' in $sourceRoot\tenants" }
$tenantConfig = Get-Content -LiteralPath $tenantSource -Raw | ConvertFrom-Json
if ((Test-Path -LiteralPath $root) -and @(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) { Refuse "'$root' exists and is not empty; name a new path (remove the old scratch root first)" }

# --- copy the current tree: tracked plus untracked-not-ignored, never state/ or notes ---
$listed = & git -C $sourceRoot ls-files --cached --others --exclude-standard 2>$null
if ($LASTEXITCODE -ne 0 -or -not $listed) { Refuse "could not list the fleet tree at '$sourceRoot' (git ls-files failed)" }
[IO.Directory]::CreateDirectory($root) | Out-Null
$copied = 0
foreach ($relative in @($listed | Select-Object -Unique)) {
  if ($relative -match '^(state|\.scratch|\.claude)/') { continue }
  $from = Join-Path $sourceRoot $relative
  if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { continue }   # tracked but deleted in the working tree
  $to = Join-Path $root $relative
  [IO.Directory]::CreateDirectory((Split-Path -Parent $to)) | Out-Null
  [IO.File]::Copy($from, $to, $true)
  $copied++
}

# --- one tenant, one session, empty state ---
foreach ($other in @(Get-ChildItem -LiteralPath "$root\tenants" -Filter *.json -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "$Tenant.json" })) { Remove-Item -LiteralPath $other.FullName -Force }
Write-Utf8 "$root\roster.json" "{`n  `"cap`": 1,`n  `"sessions`": []`n}`n"
foreach ($dir in 'sessions', 'work', 'events', 'archive', 'exclusions', 'status', 'notices', 'flags', 'manifests', 'rotation', 'watch', 'triage', 'skip', 'reviews', 'pages') {
  [IO.Directory]::CreateDirectory("$root\state\$dir") | Out-Null
}
Write-Utf8 "$root\state\roster.json" "{`"sessions`":[]}`n"
# A scratch root is where the haiku rehearsal runs, on whatever CLI is installed now: its
# profile carries no recorded version, so launch.ps1's version guard (#165) stands aside.
$profileFile = "$root\config\permissions-allowlist.json"
if (Test-Path -LiteralPath $profileFile) {
  $scratchProfile = Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json
  $scratchProfile | Add-Member -NotePropertyName verifiedCliVersion -NotePropertyValue $null -Force
  Write-Utf8 $profileFile (($scratchProfile | ConvertTo-Json -Depth 10) + "`n")
}

# --- settings: the scratch root's own hooks, and a fence around the live root ---
$rootFwd = $root.Replace('\', '/')
$liveFull = [IO.Path]::GetFullPath($LiveRoot).TrimEnd('\', '/')
$liveFwd = $liveFull.Replace('\', '/')
$settingsFile = "$root\fleet-settings.json"
$settingsText = Get-Content -LiteralPath $settingsFile -Raw
$settingsText = $settingsText.Replace("$liveFwd/", "$rootFwd/").Replace($liveFull.Replace('\', '\\') + '\\', $root.Replace('\', '\\') + '\\')
$settings = $settingsText | ConvertFrom-Json
foreach ($event in @($settings.hooks.PSObject.Properties)) {
  foreach ($matcher in @($event.Value)) {
    foreach ($hook in @($matcher.hooks)) {
      $hook.command = [regex]::Replace("$($hook.command)", '[A-Za-z]:[\\/][^\s"]*?[\\/]hooks[\\/]', "$rootFwd/hooks/")
    }
  }
}
if (-not $settings.PSObject.Properties['permissions']) { $settings | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{}) -Force }
$existingDeny = @()
if ($settings.permissions.PSObject.Properties['deny']) { $existingDeny = @($settings.permissions.deny) }
# The role files come from ~/.claude/agents (the live tree) and name the live root in
# their commands; these rules keep a session launched from here off it.
$fence = @("Edit($liveFwd/**)", "Write($liveFwd/**)", "NotebookEdit($liveFwd/**)", "Read($liveFwd/state/**)", "Bash(node $liveFwd/bin/*)")
$settings.permissions | Add-Member -NotePropertyName deny -NotePropertyValue (@(@($existingDeny + $fence) | Select-Object -Unique)) -Force
Write-Utf8 $settingsFile (($settings | ConvertTo-Json -Depth 20) + "`n")

# --- what to run next ---
if (-not $Parent) { $Parent = "pl-$Tenant" }
$issueText = if ($Issue) { "$Issue" } else { '<n>' }
$repoFwd = "$($tenantConfig.repo)".Replace('\', '/')
$next = [ordered]@{
  assign = "node $rootFwd/bin/assignment.js assign --root $rootFwd --tenant $Tenant --repo-path $repoFwd --parent $Parent --model haiku --permissions allowlist --risk standard --issue $issueText"
  launch = "node $rootFwd/bin/assignment.js launch --root $rootFwd --manifest <manifestPath from assign> --work-record-id ${Tenant}:issue-$issueText --repo-path $repoFwd --github-repo $($tenantConfig.github)"
  watch = "$($env:USERPROFILE.Replace('\', '/'))/.claude/jobs/<jobId from launch>/state.json"
}
$remove = "Remove-Item -LiteralPath '$root' -Recurse -Force"
$notes = @(
  "The live fleet does not see this reservation: pick a ticket the live lead is not about to assign.",
  "A launch leaves a worktree and branch in the tenant repo: git -C $repoFwd worktree remove --force $repoFwd/.claude/worktrees/ic-$issueText-assignment",
  "The scratch root's own watchers run by hand: powershell -File $root\bin\run-pr-watch.ps1"
)
Write-Output "scratch fleet root built at $root ($copied files, tenant $Tenant, cap 1)"
Write-Output "  1. assign:  $($next.assign)"
Write-Output "  2. launch:  $($next.launch)"
Write-Output "  3. watch:   $($next.watch)  (every needs: approve ... is a missing allow rule)"
Write-Output "  remove:     $remove"
foreach ($note in $notes) { Write-Output "  note: $note" }
Write-Output (@{ ok = $true; root = $root; tenant = $Tenant; liveRoot = $liveFull; files = $copied; next = $next; remove = $remove; notes = $notes } | ConvertTo-Json -Compress -Depth 5)
exit 0
