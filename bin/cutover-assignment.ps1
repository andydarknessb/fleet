<#
.SYNOPSIS  02/03 cutover: make the assignment planner (bin/assignment.js) the authoritative
  frontier and launch path for ICs, gated on frontier parity.
  Gates (all must hold, or -Force records that Cory overrode them):
    1. bin/assignment-parity.js passes: the most recent config/cycle.json assignment.parityEvaluations
       hook evaluations agree with the planner across assignment.parityDistinctFrontiers distinct
       frontiers, with every difference approved in state/assignment/parity-approved.json.
    2. Node is reachable (FLEET_NODE_PATH or PATH): the planner cannot run without it.
  Action: create state/flags/assignment-live and record state/assignment/cutover.json. From that
  instant the project lead's Stop hook decides from the planner's frontier and tells the lead to
  reserve and launch through assignment.js, and launch.ps1 refuses a legacy IC prompt launch
  (-Force and -DryRun still pass). Nothing running is touched: active ICs, Work records, event
  ledgers, and manifests are all left as they are. The rollback window closed with fleet #89
  (bin/rollback-assignment.ps1 is deleted); rollback now means a git revert.
.EXAMPLE   cutover-assignment.ps1 -DryRun          # evaluate the gates, change nothing
.EXAMPLE   cutover-assignment.ps1                  # cut over when the gates hold
.EXAMPLE   cutover-assignment.ps1 -Force           # Cory's hand: cut over past a failed gate (recorded)
#>
[CmdletBinding()]
param(
  [switch]$Force,           # override the parity gate; recorded in cutover.json
  [switch]$DryRun,          # evaluate and print; change nothing
  [string]$Tenant = 'endzone'
)
. "$PSScriptRoot\_common.ps1"
$ErrorActionPreference = 'Continue'
$cutoverPath = "$FleetHome\state\assignment\cutover.json"
$flagPath = "$FleetHome\state\flags\assignment-live"

function Emit { param($Obj, [int]$Code) Write-Output ($Obj | ConvertTo-Json -Compress -Depth 8); exit $Code }

if (Test-AssignmentLive) {
  $existing = $null; try { $existing = Read-Json $cutoverPath } catch {}
  Emit ([ordered]@{ cutover = $false; alreadyCutOver = $true; flag = $flagPath; record = $existing; hint = 'the rollback window closed with fleet #89; rollback is now a git revert' }) 0
}

# --- gates ---
$reasons = @()
$parity = $null
$node = $null
try { $node = Get-NodeExe } catch { $reasons += "node unavailable: $($_.Exception.Message)" }
if ($node) {
  try {
    $parityRaw = & $node "$PSScriptRoot\assignment-parity.js" report --root $FleetHome --tenant $Tenant --json 2>&1 | Out-String
    $parity = ConvertFrom-LastJsonLine $parityRaw
    if (-not $parity -or $null -eq $parity.PSObject.Properties['pass']) { $reasons += "parity report unreadable: $(($parityRaw -replace '\s+', ' ').Trim())" }
    elseif (-not $parity.pass) { $reasons += "parity gate failed: $(@($parity.reasons) -join '; ')" }
  } catch { $reasons += "parity gate could not run: $($_.Exception.Message)" }
}

$gateFailures = @($reasons)
$overridden = @()
if ($Force) {
  # Node is never overridden: without it the planner the flag hands authority to cannot run.
  $overridden = @($gateFailures | Where-Object { $_ -notmatch '^node unavailable' })
  $reasons = @($gateFailures | Where-Object { $_ -match '^node unavailable' })
}

$paritySummary = $null
if ($parity) { $paritySummary = [ordered]@{ pass = $parity.pass; evaluations = $parity.evaluations; required = $parity.required; distinctFrontiers = $parity.distinctFrontiers; requiredDistinct = $parity.requiredDistinct; window = $parity.window; classes = $parity.classes; unapproved = @($parity.unapproved).Count } }
$plan = [ordered]@{
  cutover = $false; dryRun = [bool]$DryRun; forced = [bool]$Force; tenant = $Tenant
  gates = [ordered]@{ parity = $paritySummary; node = $(if ($node) { $node } else { 'missing' }) }
  gateFailures = $gateFailures; overridden = $overridden; reasons = $reasons
  steps = @('create state/flags/assignment-live', 'record state/assignment/cutover.json')
}
if ($reasons.Count -gt 0) { Emit $plan 3 }
if ($DryRun) { Emit $plan 0 }

# --- act ---
[IO.Directory]::CreateDirectory("$FleetHome\state\flags") | Out-Null
[IO.File]::WriteAllText($flagPath, "cut over $(Now-Iso) by bin\cutover-assignment.ps1 (forced=$([bool]$Force)). The assignment planner (bin\assignment.js) is the authoritative frontier and IC launch path; launch.ps1 refuses a legacy IC prompt launch. The rollback window closed with fleet #89; rollback is now a git revert.$([Environment]::NewLine)", $Utf8)
$record = [ordered]@{ at = (Now-Iso); tenant = $Tenant; forced = [bool]$Force; overridden = $overridden; parity = $paritySummary; flag = $flagPath; rollbacks = @() }
[IO.Directory]::CreateDirectory("$FleetHome\state\assignment") | Out-Null
Write-Json $cutoverPath ([pscustomobject]$record)

Write-Output 'Cut over. Paperwork for this release (by hand, see docs/adr/0006):'
Write-Output '  - The project lead picks the planner path up at its next Stop-hook evaluation; no relaunch needed.'
Write-Output '  - Watch bin\status.ps1: "assignment: planner authoritative" and manifests pending acknowledgment.'
Write-Output '  - After one release: retire the legacy launch block from agents/project-lead.md and the legacy frontier from hooks/stop.ps1.'
Emit ([ordered]@{ cutover = $true; forced = [bool]$Force; flag = $flagPath; parity = $paritySummary; record = $cutoverPath }) 0
