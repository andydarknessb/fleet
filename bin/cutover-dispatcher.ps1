<#
.SYNOPSIS  WS5 (fleet #82, spec #194): retire the rostered dispatcher; pages and the daily summary carry its duties.
  Modeled on cutover-sentinel.ps1 (ticket 08b). Gates (all must hold, or -Force records that
  Cory overrode them):
    1. state/flags/notifier-live exists: pages reach Cory, so nothing he relied on the
       dispatcher to relay goes quiet.
    2. The 'Fleet daily summary' scheduled task is registered (-SkipTaskCheck in tests).
    3. state/watchdog/last-run.json is fresher than 30 minutes: the supervisor is ticking.
    4. The dispatcher session is at a turn boundary (daemon status not busy). Never overridden
       by -Force: retiring mid-turn is how state tears.
  Actions, in this order so no tick ever finds two actors:
    1. Create state/flags/dispatcher-off. From this instant every reader (check, recovery,
       launch door, watchdog, status) stops expecting the dispatcher.
    2. Retire the live dispatcher session through bin/retire.ps1 (roster marker, stop, rm).
    3. Record state/dispatcher/cutover.json and print the paperwork checklist.
  The roster.json entry and agents/dispatcher.md stay for one release so
  bin\rollback-dispatcher.ps1 can bring it back. Event ledgers are never touched.
.EXAMPLE   cutover-dispatcher.ps1 -DryRun          # evaluate the gates, change nothing
.EXAMPLE   cutover-dispatcher.ps1                  # cut over when the gates hold
.EXAMPLE   cutover-dispatcher.ps1 -Force           # Cory's hand: cut over past a failed gate (recorded)
#>
[CmdletBinding()]
param(
  [switch]$Force,           # override the notifier / task / watchdog gates; recorded in cutover.json
  [switch]$DryRun,          # evaluate and print; change nothing
  [switch]$SkipTaskCheck    # tests: no Task Scheduler in the fixture
)
. "$PSScriptRoot\_common.ps1"
$ErrorActionPreference = 'Continue'
$taskName = 'Fleet daily summary'
$freshRunMinutes = 30
$cutoverPath = "$FleetHome\state\dispatcher\cutover.json"
$flagPath = "$FleetHome\state\flags\dispatcher-off"

function Emit { param($Obj, [int]$Code) Write-Output ($Obj | ConvertTo-Json -Compress -Depth 8); exit $Code }

if (Test-DispatcherOff) {
  $existing = $null; try { $existing = Read-Json $cutoverPath } catch {}
  Emit ([ordered]@{ cutover = $false; alreadyCutOver = $true; flag = $flagPath; record = $existing; hint = 'bin\rollback-dispatcher.ps1 brings the dispatcher back' }) 0
}

# --- gates ---
$reasons = @()
$notifierLive = Test-Path "$FleetHome\state\flags\notifier-live"
if (-not $notifierLive) { $reasons += 'state/flags/notifier-live is absent: pages are not live, so nothing would reach Cory in the dispatcher''s place' }

$taskState = 'skipped'
if (-not $SkipTaskCheck) {
  $task = $null
  try { $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
  if (-not $task) { $taskState = 'missing'; $reasons += "scheduled task '$taskName' is not registered (bin\install-daily-summary-task.ps1)" }
  else { $taskState = "$($task.State)" }
}
$lastRun = $null; try { $lastRun = Read-Json "$FleetHome\state\watchdog\last-run.json" } catch {}
$lastRunAgeMin = $null
$lastRunAt = if ($lastRun) { ConvertTo-UtcDateTime $lastRun.at } else { $null }
if ($lastRunAt) { $lastRunAgeMin = [int]((Get-Date).ToUniversalTime() - $lastRunAt).TotalMinutes }
if ($null -eq $lastRunAgeMin) { $reasons += 'no watchdog run recorded (state/watchdog/last-run.json); the supervisor is not ticking' }
elseif ($lastRunAgeMin -gt $freshRunMinutes) { $reasons += "last watchdog run is $lastRunAgeMin min old (> $freshRunMinutes); the supervisor is not ticking" }

$daemon = @()
$daemonError = $null
try { $daemon = Get-DaemonSessions -All -Strict } catch { $daemonError = "daemon session list unreadable: $($_.Exception.Message)" }
$dispatcherRow = $daemon | Where-Object { "$($_.name)" -eq 'dispatcher' -and $_.pid } | Sort-Object startedAt -Descending | Select-Object -First 1
# An unreadable list is a boundary failure (the turn boundary cannot be seen), never one -Force overrides.
$boundaryReason = $daemonError
if ($dispatcherRow -and "$($dispatcherRow.status)" -eq 'busy') { $boundaryReason = "the dispatcher session (job $($dispatcherRow.id)) is busy mid-turn; retry at its next idle moment" }

$gateFailures = @($reasons)
if ($boundaryReason) { $gateFailures += $boundaryReason }   # never overridden: retiring mid-turn is how state tears
$overridden = @()
if ($Force) { $overridden = @($reasons); $reasons = @() }
if ($boundaryReason) { $reasons += $boundaryReason }

$plan = [ordered]@{
  cutover = $false; dryRun = [bool]$DryRun; forced = [bool]$Force
  gates = [ordered]@{ notifierLive = $notifierLive; task = $taskState; lastWatchdogRunAgeMin = $lastRunAgeMin; dispatcherJob = $(if ($dispatcherRow) { $dispatcherRow.id } else { $null }); dispatcherStatus = $(if ($dispatcherRow) { "$($dispatcherRow.status)" } else { 'absent' }) }
  gateFailures = $gateFailures; overridden = $overridden; reasons = $reasons
  steps = @('create state/flags/dispatcher-off', 'retire the live dispatcher session (bin\retire.ps1 -Name dispatcher)', 'record state/dispatcher/cutover.json')
}
if ($reasons.Count -gt 0) { Emit $plan 3 }
if ($DryRun) { Emit $plan 0 }

# --- act ---
[IO.Directory]::CreateDirectory("$FleetHome\state\flags") | Out-Null
[IO.File]::WriteAllText($flagPath, "cut over $(Now-Iso) by bin\cutover-dispatcher.ps1 (forced=$([bool]$Force)). The dispatcher is retired (WS5, fleet #82); pages and the 08:00 daily summary carry its duties; bin\rollback-dispatcher.ps1 brings it back for one release.$([Environment]::NewLine)", $Utf8)

$retired = [ordered]@{ path = 'none'; detail = 'no live dispatcher entry or session found' }
$live = Get-LiveRoster
$entry = $live.sessions | Where-Object { $_.name -eq 'dispatcher' -and $_.status -eq 'active' } | Select-Object -First 1
if ($entry) {
  $retireRaw = & "$PSScriptRoot\retire.ps1" -Name dispatcher -Reason 'WS5 cutover: pages and the daily summary carry its duties' 2>&1 | Out-String
  $retireResult = ConvertFrom-LastJsonLine $retireRaw
  $retired = [ordered]@{ path = 'retire.ps1'; jobId = $entry.jobId; result = $retireResult; raw = $(if ($retireResult) { $null } else { ($retireRaw -replace '\s+', ' ').Trim() }) }
} elseif ($dispatcherRow) {
  # fleet #265: through the resolver; a missing CLI is recorded, never reported as a clean removal.
  $directError = $null
  try { $null = Invoke-ClaudeCli -Arguments @('stop', "$($dispatcherRow.id)"); $null = Invoke-ClaudeCli -Arguments @('rm', "$($dispatcherRow.id)") } catch { $directError = "$($_.Exception.Message)" }
  Remove-Item "$FleetHome\state\heartbeats\dispatcher.json" -ErrorAction SilentlyContinue
  $retired = [ordered]@{ path = 'claude stop/rm'; jobId = $dispatcherRow.id; detail = $(if ($directError) { "session had no active live-roster entry; claude stop/rm did NOT run ($directError): stop job $($dispatcherRow.id) by hand" } else { 'session had no active live-roster entry; stopped and removed directly' }) }
}

$record = [ordered]@{
  at = (Now-Iso); forced = [bool]$Force; overridden = $overridden
  notifierLive = $notifierLive; task = $taskState; lastWatchdogRunAgeMin = $lastRunAgeMin; retired = $retired; flag = $flagPath; rollbacks = @()
}
[IO.Directory]::CreateDirectory("$FleetHome\state\dispatcher") | Out-Null
Write-Json $cutoverPath ([pscustomobject]$record)

Write-Output 'Cut over. Watch bin\status.ps1: no dispatcher row and no absent-session line at the next tick. The roster.json entry and agents/dispatcher.md stay one release for bin\rollback-dispatcher.ps1 (fleet #303 deletes them).'
Emit ([ordered]@{ cutover = $true; forced = [bool]$Force; flag = $flagPath; retired = $retired; record = $cutoverPath }) 0
