# One-screen view of the fleet.
. "$PSScriptRoot\_common.ps1"
$static = Get-StaticRoster; $live = Get-LiveRoster; $daemon = Get-DaemonSessions -All
if (Test-Path "$FleetHome\state\watchdog\banner.txt") { Write-Host (Get-Content "$FleetHome\state\watchdog\banner.txt" -Raw -Encoding UTF8) -ForegroundColor Red }
if (Test-Paused) { Write-Output "PAUSE: $(Get-Content "$FleetHome\state\PAUSE" -Raw)" }
# Who supervises (ticket 08b, permanent since ticket 89): the watchdog task; the rostered
# Sentinel's roster entry and role file are retired, so the shadow branch below is now vestigial.
$lastRun = $null; try { $lastRun = Read-Json "$FleetHome\state\watchdog\last-run.json" } catch {}
$lastRunText = 'no watchdog run recorded'
$lastRunAt = if ($lastRun) { ConvertTo-UtcDateTime $lastRun.at } else { $null }
if ($lastRunAt) { $lastRunText = "last watchdog tick $([int]((Get-Date).ToUniversalTime() - $lastRunAt).TotalMinutes) min ago ($($lastRun.mode))" }
if (Test-SentinelOff) { Write-Output "supervisor: watchdog task (state/flags/sentinel-off); $lastRunText" }
else { Write-Output "supervisor: rostered sentinel session (watchdog in shadow); $lastRunText" }
# Who assigns (02/03 cutover, permanent since ticket 89): the assignment planner
# (manifests + Work-record reservations); the legacy Stop-hook frontier is retired.
$pendingManifests = 0
try { $pendingManifests = @(Get-ChildItem "$FleetHome\state\manifests" -Filter *.json -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\.(invalidated|acknowledged)\.json$' -and -not (Test-Path "$($_.FullName).acknowledged.json") -and -not (Test-Path "$($_.FullName).invalidated.json") }).Count } catch {}
$assignmentText = "$pendingManifests manifest(s) pending acknowledgment"
Write-Output "assignment: planner authoritative; $assignmentText"
# Ticket 09: IC budgets (bin/budget.js, shadow until state/flags/budget-live) and the ledger verdict.
$budgetLast = $null; try { $budgetLast = Read-Json "$FleetHome\state\budget\last.json" } catch {}
if ($budgetLast) {
  $rows = @($budgetLast.records)
  $counts = "measured $(@($rows | Where-Object { $null -ne $_.jobTokens }).Count), warn $(@($rows | Where-Object { $_.decision -eq 'warn' }).Count), escalate $(@($rows | Where-Object { $_.decision -eq 'escalate' }).Count), unmeasured $(@($rows | Where-Object { $_.decision -eq 'unmeasured' }).Count)"
  $escalateText = if ($null -eq $budgetLast.config.escalateTokens) { 'OFF (warning-only soak)' } else { "$($budgetLast.config.escalateTokens)" }
  Write-Output "budget: $($budgetLast.mode) (warn $($budgetLast.config.warnTokens) / escalate $escalateText job tokens; flag state/flags/budget-live; summary state/budget/summary.md); $counts; last $($budgetLast.at)"
} else { Write-Output 'budget: no run recorded (state/budget/last.json)' }
$verifyLast = $null; try { $verifyLast = Read-Json "$FleetHome\state\verify\last.json" } catch {}
if ($verifyLast) { Write-Output "ledger: $(if ($verifyLast.pass) { 'verified' } else { 'FINDINGS' }) ($($verifyLast.totals.events) events, $($verifyLast.totals.records) records; archival $(if ($verifyLast.pass) { 'permitted' } else { 'held' })); last $($verifyLast.at)" }
else { Write-Output 'ledger: never verified (bin\verify-events.js); 30-day archival held' }
$names = Get-FleetNames -Live $live -Static $static
$rows = foreach ($n in $names) {
  $d = $daemon | Where-Object { $_.name -eq $n } | Sort-Object startedAt -Descending | Select-Object -First 1
  $hb = Read-Json "$FleetHome\state\heartbeats\$n.json"
  $e = $live.sessions | Where-Object { $_.name -eq $n } | Select-Object -Last 1
  $role = if ($e) { $e.role } else { ($static.sessions | Where-Object { $_.name -eq $n }).role }
  $issue = ''; if ($e -and $e.issue) { $issue = $e.issue }
  $job = '-'; $state = 'absent'; $status = ''
  if ($d) { $job = $d.id; $state = $d.state; if ($d.status) { $status = $d.status } }
  $hbText = '-'; if ($hb) { $hbText = ([datetime]$hb.at).ToLocalTime().ToString('MM-dd HH:mm') }
  [pscustomobject]@{ name = $n; role = $role; issue = $issue; job = $job; state = $state; status = $status; heartbeat = $hbText }
}
$rows | Format-Table -AutoSize | Out-String -Width 160
$liveCount = @($daemon | Where-Object { ($names -contains $_.name) -and $_.pid }).Count
Write-Output "live fleet sessions: $liveCount / cap $($static.cap)"
$esc = Get-ChildItem "$FleetHome\state\escalations" -Filter *.json -ErrorAction SilentlyContinue
if ($esc) { Write-Output "open escalations: $($esc.Count) (state\escalations\)" }
