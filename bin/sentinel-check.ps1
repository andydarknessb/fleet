<#
.SYNOPSIS  The Sentinel's mechanical check. Prints a JSON report; -Apply performs the mechanical actions.
  Applied with -Apply: respawn (failed / stopped / reaped-while-on-roster / stuck), retire (IC done + issue closed),
  worktree sweep (merged fleet branches, >7 days, unlocked), PAUSE on a rate-limit signal, clear a PAUSE it set once its window passes.
  Only reported: launchNeeded, escalate (blocked / stray / cap exceeded / vanished IC). The Sentinel session acts on those.
#>
param([switch]$Apply, [string]$ReportPath = '', [string]$Actor = 'sentinel')
. "$PSScriptRoot\_common.ps1"
function Write-AppliedLedger {
  # Ticket 08b parity evidence: every -Apply tick appends what it did to
  # state/sentinel/applied/<day>.jsonl, the legacy side bin/parity.js pairs with the
  # watchdog's shadow log. Read-only runs (no -Apply) leave no ledger line.
  param($Report)
  if (-not $Apply) { return }
  try {
    $dir = "$FleetHome\state\sentinel\applied"
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $okCount = 0; if ($Report.ok) { $okCount = @($Report.ok).Count }
    $line = [ordered]@{
      at = $Report.at; actor = $Actor; applied = $true
      respawned = @($Report.respawned); launchNeeded = @($Report.launchNeeded); escalate = @($Report.escalate)
      retired = @($Report.retired); worktrees = @($Report.worktrees); sync = @($Report.sync); pause = $Report.pause; okCount = $okCount
    }
    if ($Report.daemonReadError) { $line.daemonReadError = $Report.daemonReadError }
    $day = (ConvertTo-UtcDateTime $Report.at).ToString('yyyyMMdd')
    [IO.File]::AppendAllText("$dir\$day.jsonl", (([pscustomobject]$line | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine), $Utf8)
  } catch { Write-Warning "applied ledger append failed: $($_.Exception.Message)" }
}
$static = Get-StaticRoster; $live = Get-LiveRoster
$now = (Get-Date).ToUniversalTime()
# Ticket 08b: once the rostered Sentinel is cut over, its own -Apply is refused here, not
# in prose. A Sentinel cron that fires between the flag write and its retirement, or a
# rolled-forward session, applies nothing; the watchdog (Actor watchdog) is the actor.
if ($Apply -and $Actor -eq 'sentinel' -and (Test-SentinelOff)) {
  $refused = [ordered]@{
    at = (Now-Iso); applied = $false; refused = 'state/flags/sentinel-off stands: the rostered Sentinel is retired and the watchdog task supervises; nothing applied'
    respawned = @(); launchNeeded = @(); escalate = @(); retired = @(); worktrees = @(); sync = @(); pause = $null; ok = @()
  }
  [pscustomobject]$refused | ConvertTo-Json -Depth 6
  exit 0
}
# Fail closed on a bad daemon read: an unreadable session list is indistinguishable
# from an empty fleet, and reporting launchNeeded for every name off one glitched
# read is exactly the state that also disarms launch.ps1's guards (2026-09-01
# near-miss). Propose nothing this tick; the next cron sees a healthy read.
$daemon = $null
try { $daemon = Get-DaemonSessions -All -Strict } catch {
  $errorReport = [ordered]@{
    at = (Now-Iso); applied = [bool]$Apply; daemonReadError = "$($_.Exception.Message)"
    respawned = @(); launchNeeded = @(); escalate = @(); retired = @(); worktrees = @(); sync = @(); pause = $null
    ok = @([pscustomobject]@{ name = 'daemon-read'; detail = 'session list unreadable; proposing nothing this tick (a bad read must not look like an empty fleet)' })
  }
  if (-not $ReportPath) { $ReportPath = "$FleetHome\state\sentinel\last-check.json" }
  Write-Json $ReportPath ([pscustomobject]$errorReport)
  Write-AppliedLedger $errorReport
  [pscustomobject]$errorReport | ConvertTo-Json -Depth 6
  exit 0
}
$report = [ordered]@{ at = (Now-Iso); applied = [bool]$Apply; respawned = @(); launchNeeded = @(); escalate = @(); retired = @(); worktrees = @(); sync = @(); pause = $null; ok = @() }

function Latest-Row { param($name) $daemon | Where-Object { $_.name -eq $name } | Sort-Object startedAt -Descending | Select-Object -First 1 }
function Heartbeat-Age {
  param($name)
  $hb = Read-Json "$FleetHome\state\heartbeats\$name.json"
  if ($hb) { ($now - ([datetime]$hb.at).ToUniversalTime()).TotalMinutes } else { $null }
}
function Do-Respawn {
  param($row, $entry, $reason)
  if (-not $entry.static) {
    $current = Get-LiveRoster
    $currentEntry = $current.sessions | Where-Object { $_.name -eq $entry.name } | Select-Object -First 1
    if (-not $currentEntry -or "$($currentEntry.status)" -ne 'active') {
      $currentStatus = if ($currentEntry) { "$($currentEntry.status)" } else { 'absent' }
      $script:report.ok += [pscustomobject]@{ name = $row.name; detail = "respawn cancelled: live roster status is $currentStatus" }
      return
    }
  }
  if ($Apply) { & claude respawn $row.id 2>&1 | Out-Null }
  $script:report.respawned += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = $reason }
}

function Property-Names { param($obj) if ($null -eq $obj) { return @() }; return @($obj.PSObject.Properties.Name) }

# --- roster sessions: static (always expected) + active ICs ---
$expected = @()
foreach ($s in (Get-ExpectedStaticSessions $static)) { $expected += [pscustomobject]@{ name = $s.name; role = $s.role; parent = $s.parent; tenant = $s.tenant; issue = $null; static = $true } }
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
    # 'blocked' covers a permission prompt, an AskUserQuestion and a plain wait on a human alike, and the daemon
    # rows (`claude agents --json --all`, verified 2026-08-26: id,cwd,kind,startedAt,sessionId,name,state,pid,status)
    # carry no field that says which. Report it as input-wait of unknown kind with the job's own detail text;
    # never assert a cause this script did not measure. Never respawned: a respawn would discard the prompt.
    $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'blocked'; detail = "waiting on input, kind unknown (daemon rows carry no prompt kind); job detail: $($js.detail); not respawned by design"; parent = $x.parent }
    continue
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
    if ($null -ne $age -and $age -gt 120 -and "$($row.status)" -ne 'busy') {
      if ($x.role -eq 'ic' -and $x.tenant) {
        $t = Read-Json "$FleetHome\tenants\$($x.tenant).json"
        $skip = Read-Json "$FleetHome\state\skip\$($x.tenant).json"
        if ((Property-Names $skip.issues) -contains "$($x.issue)") {
          $report.ok += [pscustomobject]@{ name = $x.name; detail = "waiting on issue #$($x.issue) skip-list hold" }
          continue
        }

        $headPrefix = "$($t.branchPrefix)$($x.issue)-"
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
          $prRaw = @(& gh pr list -R $t.github --state open --search "head:$headPrefix" --json number,headRefName 2>&1)
          $ghExit = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousErrorAction
        }
        if ($ghExit -ne 0) {
          $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'pr-lookup-failed'; detail = "stale-heartbeat PR lookup failed for $($t.github): $($prRaw -join ' ')"; parent = $x.parent }
          continue
        }
        try { $prs = @(($prRaw -join "`n") | ConvertFrom-Json) } catch {
          $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'pr-lookup-failed'; detail = "stale-heartbeat PR lookup returned invalid JSON for $($t.github): $($_.Exception.Message)"; parent = $x.parent }
          continue
        }
        $pr = $prs | Where-Object { ("$($_.headRefName)").StartsWith($headPrefix, [System.StringComparison]::Ordinal) } | Select-Object -First 1
        if ($pr) {
          $held = (Property-Names $skip.prs) -contains "$($pr.number)"
          $suffix = if ($held) { ' (skip-list hold)' } else { '' }
          $report.ok += [pscustomobject]@{ name = $x.name; detail = "waiting on PR #$($pr.number)$suffix" }
          continue
        }
      }
      Do-Respawn $row $x "heartbeat stale ($([int]$age) min), state=$state status=$($row.status), no open PR"
      continue
    }
    $report.ok += $x.name
    continue
  }
  $report.ok += $x.name
}

# --- strays and cap ---
$fleetPattern = '^(dispatcher|sentinel|pl-[a-z0-9-]+|ic-[0-9]+)$'
$known = @($expected | ForEach-Object { $_.name })
foreach ($row in ($daemon | Where-Object { $_.pid -and ("$($_.name)" -match $fleetPattern) -and ($known -notcontains $_.name) })) {
  $report.escalate += [pscustomobject]@{ name = $row.name; kind = 'stray'; detail = "fleet-named session not on the roster (job $($row.id)); cause not measured: launched outside launch.ps1, or its roster entry was lost or retired while the process lived" }
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

# --- keep each tenant's defaultBranch fast-forwarded to its releaseBranch (pure ff only) ---
$report.sync = @()
foreach ($tf in (Get-ChildItem "$FleetHome\tenants" -Filter *.json)) {
  $t = Read-Json $tf.FullName
  if (-not $t.releaseBranch -or $t.releaseBranch -eq $t.defaultBranch -or -not (Test-Path $t.repo)) { continue }
  $raw = if ($Apply) { & "$PSScriptRoot\sync-integration.ps1" -Tenant $t.name -Apply | Out-String } else { & "$PSScriptRoot\sync-integration.ps1" -Tenant $t.name | Out-String }
  $res = $null; try { $res = $raw | ConvertFrom-Json } catch {}
  if ($res) {
    $res | Add-Member -NotePropertyName tenant -NotePropertyValue $t.name -Force
    $report.sync += $res
    if ($res.escalate) { $report.escalate += [pscustomobject]@{ name = "pl-$($t.name)"; kind = 'branch-diverged'; detail = $res.reason; parent = 'dispatcher' } }
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

if (-not $ReportPath) { $ReportPath = "$FleetHome\state\sentinel\last-check.json" }
Write-Json $ReportPath ([pscustomobject]$report)
Write-AppliedLedger $report
[pscustomobject]$report | ConvertTo-Json -Depth 6
