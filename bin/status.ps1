# One-screen view of the fleet.
. "$PSScriptRoot\_common.ps1"
$static = Get-StaticRoster; $live = Get-LiveRoster; $daemon = Get-DaemonSessions -All
if (Test-Paused) { Write-Output "PAUSE: $(Get-Content "$FleetHome\state\PAUSE" -Raw)" }
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
