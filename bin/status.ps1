# One-screen view of the fleet.
. "$PSScriptRoot\_common.ps1"
$static = Get-StaticRoster; $live = Get-LiveRoster; $daemon = Get-DaemonSessions -All
if (Test-Path "$FleetHome\state\watchdog\banner.txt") { Write-Host (Get-Content "$FleetHome\state\watchdog\banner.txt" -Raw -Encoding UTF8) -ForegroundColor Red }
if (Test-Paused) { Write-Output "PAUSE: $(Get-Content "$FleetHome\state\PAUSE" -Raw)" }
# Who supervises (ticket 08b): the rostered Sentinel until cutover, the watchdog task after.
$lastRun = $null; try { $lastRun = Read-Json "$FleetHome\state\watchdog\last-run.json" } catch {}
$lastRunText = 'no watchdog run recorded'
$lastRunAt = if ($lastRun) { ConvertTo-UtcDateTime $lastRun.at } else { $null }
if ($lastRunAt) { $lastRunText = "last watchdog tick $([int]((Get-Date).ToUniversalTime() - $lastRunAt).TotalMinutes) min ago ($($lastRun.mode))" }
if (Test-SentinelOff) { Write-Output "supervisor: watchdog task (state/flags/sentinel-off; rollback: bin\rollback-sentinel.ps1); $lastRunText" }
else { Write-Output "supervisor: rostered sentinel session (watchdog in shadow); $lastRunText" }
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
