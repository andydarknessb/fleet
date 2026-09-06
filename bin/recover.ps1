# Reboot recovery: bring the roster back. Run at logon (install-recovery-task.ps1) or by hand.
. "$PSScriptRoot\_common.ps1"
& claude daemon status 2>$null | Out-Null
$static = Get-StaticRoster; $live = Get-LiveRoster; $daemon = Get-DaemonSessions -All
$out = @()
# Ticket 08b: a cut-over Sentinel (state/flags/sentinel-off) is not recovered; the watchdog task supervises.
$wanted = @((Get-ExpectedStaticSessions $static) | ForEach-Object { [pscustomobject]@{ name = $_.name; fromRoster = $true; entry = $null } })
$wanted += @($live.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' } | ForEach-Object { [pscustomobject]@{ name = $_.name; fromRoster = $false; entry = $_ } })
foreach ($w in $wanted) {
  $row = $daemon | Where-Object { $_.name -eq $w.name } | Sort-Object startedAt -Descending | Select-Object -First 1
  if ($row -and $row.pid) { $out += "$($w.name): already running ($($row.id))"; continue }
  if ($row) { & claude respawn $row.id 2>&1 | Out-Null; $out += "$($w.name): respawned $($row.id)"; continue }
  if ($w.fromRoster) {
    $r = (& "$PSScriptRoot\launch.ps1" -FromRoster $w.name | Out-String).Trim()
    $out += "$($w.name): launched -> $r"
    continue
  }
  $e = $w.entry
  # -Recover: this IC is already on the live roster, so its unit is already reserved. Without it
  # the 02/03 launch door refuses every IC relaunch while state/flags/assignment-live stands, and
  # a reboot silently strands in-flight work.
  $r = (& "$PSScriptRoot\launch.ps1" -Role $e.role -Name $e.name -Tenant $e.tenant -Parent $e.parent -Issue $e.issue -Prompt $e.prompt -Recover | Out-String).Trim()
  $out += "$($w.name): relaunched -> $r"
}
$out | ForEach-Object { Write-Output $_ }
[IO.File]::WriteAllText("$FleetHome\state\sentinel\last-recover.txt", ($out -join "`n"), $Utf8)
