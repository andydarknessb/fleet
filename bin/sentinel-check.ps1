<#
.SYNOPSIS  The Sentinel's mechanical check. Prints a JSON report; -Apply performs the mechanical actions.
  Applied with -Apply: respawn (failed / stopped / reaped-while-on-roster / stuck), retire (IC done + issue closed),
  worktree sweep (merged fleet branches, >7 days, unlocked), PAUSE on a rate-limit signal, clear a PAUSE it set once its window passes.
  Only reported: launchNeeded, escalate (blocked / stray / cap exceeded / vanished IC). The Sentinel session acts on those.
#>
param([switch]$Apply)
. "$PSScriptRoot\_common.ps1"
$static = Get-StaticRoster; $live = Get-LiveRoster; $daemon = Get-DaemonSessions -All
$now = (Get-Date).ToUniversalTime()
$report = [ordered]@{ at = (Now-Iso); applied = [bool]$Apply; respawned = @(); launchNeeded = @(); escalate = @(); retired = @(); worktrees = @(); pause = $null; ok = @() }

function Latest-Row { param($name) $daemon | Where-Object { $_.name -eq $name } | Sort-Object startedAt -Descending | Select-Object -First 1 }
function Heartbeat-Age {
  param($name)
  $hb = Read-Json "$FleetHome\state\heartbeats\$name.json"
  if ($hb) { ($now - ([datetime]$hb.at).ToUniversalTime()).TotalMinutes } else { $null }
}
function Do-Respawn {
  param($row, $entry, $reason)
  if ($Apply) { & claude respawn $row.id 2>&1 | Out-Null }
  $script:report.respawned += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = $reason }
}

# --- roster sessions: static (always expected) + active ICs ---
$expected = @()
foreach ($s in $static.sessions) { $expected += [pscustomobject]@{ name = $s.name; role = $s.role; parent = $s.parent; tenant = $s.tenant; issue = $null; static = $true } }
foreach ($e in ($live.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' })) { $expected += [pscustomobject]@{ name = $e.name; role = $e.role; parent = $e.parent; tenant = $e.tenant; issue = $e.issue; static = $false } }

foreach ($x in $expected) {
  $row = Latest-Row $x.name
  if (-not $row) {
    if ($x.static) { $report.launchNeeded += [pscustomobject]@{ name = $x.name; reason = 'no job known to the daemon' } }
    else { $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'ic-vanished'; detail = "active IC for issue #$($x.issue) has no job; parent $($x.parent) must relaunch or retire"; parent = $x.parent } }
    continue
  }
  $js = Get-JobState $row.id
  $detail = ''
  if ($js) { $detail = "$($js.detail) $($js.waitingFor)" }
  if ($detail -match 'rate.?limit|usage limit|limit reached|resets? at') {
    if (-not (Test-Paused)) {
      if ($Apply) { & "$PSScriptRoot\pause.ps1" -Reason "rate-limit seen on $($x.name)" -Minutes 60 | Out-Null }
      $report.pause = "set: rate-limit signal on $($x.name)"
    }
  }
  $state = "$($row.state)"
  if ($state -eq 'blocked') {
    # 'blocked' is also what a session reports when it is merely waiting on a human decision. Only a real
    # dialog (the daemon's waitingFor) is a permission prompt worth escalating; otherwise treat as working.
    if ("$($row.waitingFor)" -ne '') {
      $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'blocked'; detail = "waiting on a prompt ($($row.waitingFor)); not respawned by design"; parent = $x.parent }
      continue
    }
    $state = 'working'
  }
  if ($state -eq 'failed') { Do-Respawn $row $x 'state failed'; continue }
  if ($state -eq 'stopped') { Do-Respawn $row $x 'state stopped'; continue }
  if ($state -eq 'done') {
    if ($x.role -eq 'ic' -and $x.tenant) {
      $t = Read-Json "$FleetHome\tenants\$($x.tenant).json"
      $st = (& gh issue view $x.issue -R $t.github --json state 2>$null | Out-String)
      if ($st -match '"CLOSED"') {
        if ($Apply) { & "$PSScriptRoot\retire.ps1" -Name $x.name -Reason 'issue closed' | Out-Null }
        $report.retired += $x.name
        continue
      }
    }
    if (-not $row.pid) { Do-Respawn $row $x 'process reaped while still on roster'; continue }
    $report.ok += $x.name
    continue
  }
  if ($state -eq 'working') {
    $age = Heartbeat-Age $x.name
    if ($null -ne $age -and $age -gt 120 -and "$($row.status)" -ne 'busy') { Do-Respawn $row $x "heartbeat stale ($([int]$age) min) while state=working"; continue }
    $report.ok += $x.name
    continue
  }
  $report.ok += $x.name
}

# --- strays and cap ---
$fleetPattern = '^(dispatcher|sentinel|pl-[a-z0-9-]+|ic-[0-9]+)$'
$known = @($expected | ForEach-Object { $_.name })
foreach ($row in ($daemon | Where-Object { $_.pid -and ("$($_.name)" -match $fleetPattern) -and ($known -notcontains $_.name) })) {
  $report.escalate += [pscustomobject]@{ name = $row.name; kind = 'stray'; detail = "fleet-named session not on the roster (job $($row.id)); bypassed launch.ps1" }
}
$liveFleet = @($daemon | Where-Object { $_.pid -and ($known -contains $_.name) })
if ($liveFleet.Count -gt [int]$static.cap) { $report.escalate += [pscustomobject]@{ name = 'fleet'; kind = 'cap-exceeded'; detail = "$($liveFleet.Count) live fleet sessions, cap $($static.cap)" } }

# --- clear a PAUSE we set once its window passed ---
if (Test-Paused) {
  $txt = Get-Content "$FleetHome\state\PAUSE" -Raw
  if ($txt -match 'reason=rate-limit' -and $txt -match 'until=(\S+)') {
    $until = [datetime]::Parse($Matches[1]).ToUniversalTime()
    if ($now -gt $until) {
      if ($Apply) { & "$PSScriptRoot\pause.ps1" -Off | Out-Null }
      $report.pause = 'cleared: rate-limit window passed'
    }
  }
}

# --- worktree sweep: merged fleet branches older than 7 days ---
foreach ($tf in (Get-ChildItem "$FleetHome\tenants" -Filter *.json)) {
  $t = Read-Json $tf.FullName
  if (-not (Test-Path $t.repo)) { continue }
  $wt = ((& git -C $t.repo worktree list --porcelain 2>$null | Out-String) -replace "`r", '') -split "`n`n"
  foreach ($blk in $wt) {
    if ($blk -notmatch 'worktree (.+)') { continue }
    $path = $Matches[1].Trim()
    if ($path -notmatch '[\\/]\.claude[\\/]worktrees[\\/]') { continue }
    if ($blk -notmatch 'branch refs/heads/(.+)') { continue }
    $br = $Matches[1].Trim()
    $mergedList = (& git -C $t.repo branch --merged $t.defaultBranch 2>$null | Out-String)
    $merged = $mergedList -match [regex]::Escape($br)
    $lastTs = & git -C $t.repo log -1 --format=%ct $br 2>$null
    $ageDays = 0
    if ($lastTs) { $ageDays = ($now - [DateTimeOffset]::FromUnixTimeSeconds([long]$lastTs).UtcDateTime).TotalDays }
    if ($merged -and $ageDays -gt 7 -and ($blk -notmatch 'locked')) {
      if ($Apply) { & git -C $t.repo worktree remove --force $path 2>$null; & git -C $t.repo branch -D $br 2>$null }
      $report.worktrees += [pscustomobject]@{ tenant = $t.name; path = $path; branch = $br; ageDays = [int]$ageDays }
    }
  }
}

Write-Json "$FleetHome\state\sentinel\last-check.json" ([pscustomobject]$report)
[pscustomobject]$report | ConvertTo-Json -Depth 6
