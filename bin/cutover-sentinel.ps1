<#
.SYNOPSIS  Ticket 08b: cut the rostered Sentinel over to scheduled supervision, gated on parity.
  Gates (all must hold, or -Force records that Cory overrode them):
    1. bin/parity.js passes: the most recent continuous run of paired watchdog-shadow and
       Sentinel-applied ticks covers config/cycle.json supervisor.parityHours (48) with every
       difference expected by construction or approved in state/sentinel/parity-approved.json.
    2. The 'Fleet watchdog' scheduled task is registered and its last run is fresh, so the
       supervisor that takes over is actually running.
    3. The Sentinel session is at a turn boundary (daemon status not busy).
  Actions, in this order so no tick ever finds two actors:
    1. Create state/flags/sentinel-off. From this instant every reader (check, recovery,
       launch door, watchdog, status) stops expecting the rostered Sentinel; the watchdog
       goes live at its next tick once no Sentinel session is running.
    2. Retire the live Sentinel session through bin/retire.ps1 (roster marker, stop, rm).
    3. Record state/sentinel/cutover.json and print the paperwork checklist.
  The roster.json entry, agents/sentinel.md and bin/rollback-sentinel.ps1 were deleted by
  fleet #89 after one release: the rollback window is closed, and rollback now means a git
  revert. Event ledgers, the applied ledger, and the shadow log are never touched by cutover.
.EXAMPLE   cutover-sentinel.ps1 -DryRun          # evaluate the gates, change nothing
.EXAMPLE   cutover-sentinel.ps1                  # cut over when the gates hold
.EXAMPLE   cutover-sentinel.ps1 -Force           # Cory's hand: cut over past a failed gate (recorded)
#>
[CmdletBinding()]
param(
  [switch]$Force,           # override the parity / task gates; recorded in cutover.json
  [switch]$DryRun,          # evaluate and print; change nothing
  [switch]$SkipTaskCheck    # tests: no Task Scheduler in the fixture
)
. "$PSScriptRoot\_common.ps1"
$ErrorActionPreference = 'Continue'
$taskName = 'Fleet watchdog'
$freshRunMinutes = 30
$cutoverPath = "$FleetHome\state\sentinel\cutover.json"
$flagPath = "$FleetHome\state\flags\sentinel-off"

function Emit { param($Obj, [int]$Code) Write-Output ($Obj | ConvertTo-Json -Compress -Depth 8); exit $Code }

if (Test-SentinelOff) {
  $existing = $null; try { $existing = Read-Json $cutoverPath } catch {}
  Emit ([ordered]@{ cutover = $false; alreadyCutOver = $true; flag = $flagPath; record = $existing; hint = 'the rollback window closed with fleet #89; rollback is now a git revert' }) 0
}

# --- gates ---
$reasons = @()
$parity = $null
try {
  $node = Get-NodeExe
  $parityRaw = & $node "$PSScriptRoot\parity.js" --root $FleetHome --json 2>&1 | Out-String
  $parity = ConvertFrom-LastJsonLine $parityRaw
  if (-not $parity -or $null -eq $parity.PSObject.Properties['pass']) { $reasons += "parity report unreadable: $(($parityRaw -replace '\s+', ' ').Trim())" }
  elseif (-not $parity.pass) { $reasons += "parity gate failed: $(@($parity.reasons) -join '; ')" }
} catch { $reasons += "parity gate could not run: $($_.Exception.Message)" }

$taskState = 'skipped'
if (-not $SkipTaskCheck) {
  $task = $null
  try { $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
  if (-not $task) { $taskState = 'missing'; $reasons += "scheduled task '$taskName' is not registered (bin\install-watchdog-task.ps1)" }
  else { $taskState = "$($task.State)" }
}
$lastRun = $null; try { $lastRun = Read-Json "$FleetHome\state\watchdog\last-run.json" } catch {}
$lastRunAgeMin = $null
$lastRunAt = if ($lastRun) { ConvertTo-UtcDateTime $lastRun.at } else { $null }
if ($lastRunAt) { $lastRunAgeMin = [int]((Get-Date).ToUniversalTime() - $lastRunAt).TotalMinutes }
if ($null -eq $lastRunAgeMin) { $reasons += 'no watchdog run recorded (state/watchdog/last-run.json); the supervisor that would take over has not run' }
elseif ($lastRunAgeMin -gt $freshRunMinutes) { $reasons += "last watchdog run is $lastRunAgeMin min old (> $freshRunMinutes); the supervisor that would take over is not ticking" }

$daemon = @()
try { $daemon = Get-DaemonSessions -All -Strict } catch { $reasons += "daemon session list unreadable: $($_.Exception.Message)" }
$sentinelRow = $daemon | Where-Object { "$($_.name)" -eq 'sentinel' -and $_.pid } | Sort-Object startedAt -Descending | Select-Object -First 1
$boundaryReason = $null
if ($sentinelRow -and "$($sentinelRow.status)" -eq 'busy') { $boundaryReason = "the Sentinel session (job $($sentinelRow.id)) is busy mid-turn; retry at its next idle tick" }

$gateFailures = @($reasons)
if ($boundaryReason) { $gateFailures += $boundaryReason }   # never overridden: retiring mid-turn is how state tears
$overridden = @()
if ($Force) { $overridden = @($reasons); $reasons = @() }
if ($boundaryReason) { $reasons += $boundaryReason }

$paritySummary = $null
if ($parity) { $paritySummary = [ordered]@{ pass = $parity.pass; continuousHours = $parity.continuousHours; parityHours = $parity.parityHours; window = $parity.window; totals = $parity.totals; classes = $parity.classes; unapproved = @($parity.unapproved).Count } }
$plan = [ordered]@{
  cutover = $false; dryRun = [bool]$DryRun; forced = [bool]$Force
  gates = [ordered]@{ parity = $paritySummary; task = $taskState; lastWatchdogRunAgeMin = $lastRunAgeMin; sentinelJob = $(if ($sentinelRow) { $sentinelRow.id } else { $null }); sentinelStatus = $(if ($sentinelRow) { "$($sentinelRow.status)" } else { 'absent' }) }
  gateFailures = $gateFailures; overridden = $overridden; reasons = $reasons
  steps = @('create state/flags/sentinel-off', 'retire the live Sentinel session (bin\retire.ps1 -Name sentinel)', 'record state/sentinel/cutover.json')
}
if ($reasons.Count -gt 0) { Emit $plan 3 }
if ($DryRun) { Emit $plan 0 }

# --- act ---
[IO.Directory]::CreateDirectory("$FleetHome\state\flags") | Out-Null
[IO.File]::WriteAllText($flagPath, "cut over $(Now-Iso) by bin\cutover-sentinel.ps1 (forced=$([bool]$Force)). The rostered Sentinel is disabled; bin\watchdog.ps1 supervises. The rollback window closed with fleet #89; rollback is now a git revert.$([Environment]::NewLine)", $Utf8)

$retired = [ordered]@{ path = 'none'; detail = 'no live Sentinel entry or session found' }
$live = Get-LiveRoster
$entry = $live.sessions | Where-Object { $_.name -eq 'sentinel' -and $_.status -eq 'active' } | Select-Object -First 1
if ($entry) {
  $retireRaw = & "$PSScriptRoot\retire.ps1" -Name sentinel -Reason '08b cutover: scheduled supervision is live' 2>&1 | Out-String
  $retireResult = ConvertFrom-LastJsonLine $retireRaw
  $retired = [ordered]@{ path = 'retire.ps1'; jobId = $entry.jobId; result = $retireResult; raw = $(if ($retireResult) { $null } else { ($retireRaw -replace '\s+', ' ').Trim() }) }
} elseif ($sentinelRow) {
  & claude stop $sentinelRow.id 2>&1 | Out-Null
  & claude rm $sentinelRow.id 2>&1 | Out-Null
  Remove-Item "$FleetHome\state\heartbeats\sentinel.json" -ErrorAction SilentlyContinue
  $retired = [ordered]@{ path = 'claude stop/rm'; jobId = $sentinelRow.id; detail = 'session had no active live-roster entry; stopped and removed directly' }
}

$record = [ordered]@{
  at = (Now-Iso); forced = [bool]$Force; overridden = $overridden; parity = $paritySummary
  task = $taskState; lastWatchdogRunAgeMin = $lastRunAgeMin; retired = $retired; flag = $flagPath; rollbacks = @()
}
[IO.Directory]::CreateDirectory("$FleetHome\state\sentinel") | Out-Null
Write-Json $cutoverPath ([pscustomobject]$record)

Write-Output 'Cut over. Paperwork for this release (by hand, see docs/adr/0004 status note):'
Write-Output '  - CONTEXT.md: rewrite the Sentinel entry (retired actor; text in the ADR 0004 status note).'
Write-Output '  - README.md: the Shape diagram and the Sentinel rows now describe the rollback path.'
Write-Output '  - roster.json: keep the sentinel entry (rollback) for one release, then delete it with agents/sentinel.md (done by fleet #89; the rollback window is now closed).'
Write-Output '  - Watch bin\status.ps1: "supervisor: watchdog live" and no double-actor banner at the next tick.'
Emit ([ordered]@{ cutover = $true; forced = [bool]$Force; flag = $flagPath; retired = $retired; parity = $paritySummary; record = $cutoverPath }) 0
