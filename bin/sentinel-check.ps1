<#
.SYNOPSIS  The Sentinel's mechanical check. Prints a JSON report; -Apply performs the mechanical actions.
  Applied with -Apply: respawn (failed / stopped / reaped-while-on-roster / stuck), retire (IC done + issue closed),
  worktree sweep (merged fleet branches, >7 days, unlocked), PAUSE on a rate-limit signal, clear a PAUSE it set once its window passes.
  Also applied, only under state/flags/ic-cleanup-live (fleet #252): stop + rm an orphan late IC session (its manifest was invalidated, no roster row claims it).
  Same flag (fleet #253): retire an IC roster row that died before ack (no heartbeat, no ack, job gone) and release its reservation.
  Same flag (fleet #256 AC2): release an assigned reservation stranded with no roster row, no job and no marker.
  Same flag (fleet #257 Gap A): respawn an IC whose first turn never completed (alive, no heartbeat ever, job state silent, job never reached a terminal state); the page is raised in every mode.
  Bounded (fleet #257 Gap B): a verified respawn (or launched relaunch) is counted in state/sentinel/respawn-streak.json; the (watchdog.respawnLoopCap+1)th for one job inside
  watchdog.respawnLoopWindowHours, with no heartbeat in between, is held (respawnHeld) and escalated as respawn-loop when the row has a live pid; a row
  with no pid is always respawned (and counted), with respawn-loop-down raised beside it once the cap is reached.
  Only reported: launchNeeded, escalate (blocked / stray / cap exceeded / vanished IC / orphan-late-session / ic-dead-before-ack / reservation-stranded / respawn-loop). The Sentinel session acts on those.
#>
param([switch]$Apply, [string]$ReportPath = '', [string]$Actor = 'sentinel', [string]$HealRespawn = '')
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
      respawned = @($Report.respawned); respawnFailed = @($Report.respawnFailed); respawnDeferred = @($Report.respawnDeferred); respawnHeld = @($Report.respawnHeld); launchNeeded = @($Report.launchNeeded); escalate = @($Report.escalate)
      retired = @($Report.retired); stopped = @($Report.stopped); stopFailed = @($Report.stopFailed); deadRetired = @($Report.deadRetired); strandedReleased = @($Report.strandedReleased); strandedReleaseFailed = @($Report.strandedReleaseFailed); worktrees = @($Report.worktrees); sync = @($Report.sync); pause = $Report.pause; okCount = $okCount
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
    respawned = @(); respawnFailed = @(); respawnDeferred = @(); respawnHeld = @(); launchNeeded = @(); escalate = @(); retired = @(); stopped = @(); stopFailed = @(); deadRetired = @(); strandedReleased = @(); strandedReleaseFailed = @(); worktrees = @(); sync = @(); pause = $null; ok = @()
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
    respawned = @(); respawnFailed = @(); respawnDeferred = @(); respawnHeld = @(); launchNeeded = @(); escalate = @(); retired = @(); stopped = @(); stopFailed = @(); deadRetired = @(); strandedReleased = @(); strandedReleaseFailed = @(); worktrees = @(); sync = @(); pause = $null
    ok = @([pscustomobject]@{ name = 'daemon-read'; detail = 'session list unreadable; proposing nothing this tick (a bad read must not look like an empty fleet)' })
  }
  if (-not $ReportPath) { $ReportPath = "$FleetHome\state\sentinel\last-check.json" }
  Write-Json $ReportPath ([pscustomobject]$errorReport)
  Write-AppliedLedger $errorReport
  [pscustomobject]$errorReport | ConvertTo-Json -Depth 6
  exit 0
}
$report = [ordered]@{ at = (Now-Iso); applied = [bool]$Apply; respawned = @(); respawnFailed = @(); respawnDeferred = @(); respawnHeld = @(); launchNeeded = @(); escalate = @(); retired = @(); stopped = @(); stopFailed = @(); deadRetired = @(); strandedReleased = @(); strandedReleaseFailed = @(); worktrees = @(); sync = @(); pause = $null; ok = @() }

# fleet #252: one strict read of state/roster.json for the orphan pass. Get-LiveRoster above folds an
# unparseable file into an empty roster, and "no row claims this job" off an empty roster would let
# a healthy session read as an orphan; an unreadable roster classifies nothing this tick.
$rosterRows = @(); $rosterUnreadable = $false; $rosterPath = Join-Path $FleetHome "state/roster.json"
if (Test-Path -LiteralPath $rosterPath) {
  try {
    $strictRoster = Get-Content -LiteralPath $rosterPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $strictRoster) { throw 'empty roster file' }
    if ($strictRoster.PSObject.Properties['sessions'] -and $null -ne $strictRoster.sessions) { $rosterRows = @($strictRoster.sessions) }
  } catch { $rosterUnreadable = $true }
}
if ($rosterUnreadable) { $report.ok += [pscustomobject]@{ name = 'roster-read'; detail = 'state/roster.json unreadable; orphan and dead-row checks skipped' } }

# fleet #253: job ids the orphan-late-session pass classified (filled before the expected loop). An orphan
# is not any roster row's session, so a same-named orphan that started later must never be picked as the
# IC's row by name (it would read as a healthy "working" IC and hide the real, dead one).
$script:orphanJobIds = @{}
$script:DeadRetireCount = 0
function Latest-Row { param($name) $daemon | Where-Object { $_.name -eq $name -and -not $script:orphanJobIds.ContainsKey("$($_.id)") } | Sort-Object startedAt -Descending | Select-Object -First 1 }
# fleet #253 / #256: config/cycle.json watchdog knobs, read once. deadBeforeAckMinutes (default 60) is the
# grace before a launched row with no ack and no heartbeat can read as dead; staleMinutes (default 45, the
# watchdog's own) is how fresh a job state must be to count as a live job; strandedReservationHours
# (default 6) is how long an assigned reservation may sit with nothing behind it; deadBeforeAckMaxPerTick (default 2)
# caps the dead-before-ack retires one tick performs, the rest roll to the next tick.
$script:DeadBeforeAckMinutes = 60; $script:DeadBeforeAckMaxPerTick = 2; $script:JobStaleMinutes = 45; $script:StrandedReservationHours = 6
# fleet #257 Gap B: respawnLoopCap (default 3) verified respawns of one job inside respawnLoopWindowHours (default 24)
# are allowed; the next is held (Test-RespawnStreakHold).
$script:RespawnLoopCap = 3; $script:RespawnLoopWindowHours = 24
# fleet #257 Gap A: minutes since launch before an IC with no heartbeat ever and a silent job state reads as a hung first turn
# (healthy first turns: p50 8 min, p90 32 min).
$script:FirstTurnStaleMinutes = 120
try {
  $wdCfg = (Read-Json "$FleetHome\config\cycle.json").watchdog
  if ($wdCfg -and $wdCfg.PSObject.Properties['deadBeforeAckMinutes']) { $script:DeadBeforeAckMinutes = [double]$wdCfg.deadBeforeAckMinutes }
  if ($wdCfg -and $wdCfg.PSObject.Properties['deadBeforeAckMaxPerTick']) { $script:DeadBeforeAckMaxPerTick = [int]$wdCfg.deadBeforeAckMaxPerTick }
  if ($wdCfg -and $wdCfg.PSObject.Properties['staleMinutes']) { $script:JobStaleMinutes = [double]$wdCfg.staleMinutes }
  if ($wdCfg -and $wdCfg.PSObject.Properties['strandedReservationHours']) { $script:StrandedReservationHours = [double]$wdCfg.strandedReservationHours }
  if ($wdCfg -and $wdCfg.PSObject.Properties['respawnLoopCap']) { $script:RespawnLoopCap = [int]$wdCfg.respawnLoopCap }
  if ($wdCfg -and $wdCfg.PSObject.Properties['respawnLoopWindowHours']) { $script:RespawnLoopWindowHours = [double]$wdCfg.respawnLoopWindowHours }
  if ($wdCfg -and $wdCfg.PSObject.Properties['firstTurnStaleMinutes']) { $script:FirstTurnStaleMinutes = [double]$wdCfg.firstTurnStaleMinutes }
} catch {}
# fleet #257 Gap B: state/sentinel/respawn-streak.json, { "<name>": { "jobId", "attempts": [iso...], "downAttempts": [iso...], "lastReason" } }, one
# strict read per tick. downAttempts is the subset of attempts made when the row had NO pid (a death); an entry without it (an older file) has
# none. Corrupt is unreadable and never reset: Test-RespawnStreakHold then defers every respawn and relaunch of a row that still has a pid
# (a row with no pid is always respawned, uncounted while the file is unreadable).
$script:RespawnStreakPath = Join-Path $FleetHome 'state\sentinel\respawn-streak.json'
$script:RespawnStreak = @{}
$script:RespawnStreakUnreadable = $false
$script:RespawnStreakError = ''
$script:RespawnStreakReported = $false
$script:RespawnStreakTouched = @{}
if (Test-Path -LiteralPath $script:RespawnStreakPath) {
  try {
    $rsRaw = Get-Content -LiteralPath $script:RespawnStreakPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $rsRaw -or $rsRaw -isnot [pscustomobject]) { throw 'not a JSON object' }
    foreach ($rsProp in $rsRaw.PSObject.Properties) {
      $rsEntry = $rsProp.Value
      if ($rsEntry -isnot [pscustomobject] -or -not $rsEntry.PSObject.Properties['jobId'] -or -not $rsEntry.PSObject.Properties['attempts'] -or $rsEntry.attempts -isnot [array]) { throw "entry '$($rsProp.Name)' has no jobId and attempts list" }
      $rsAttempts = @()
      foreach ($rsAt in $rsEntry.attempts) {
        $rsWhen = if ($rsAt -is [datetime]) { $rsAt.ToUniversalTime() } else { ConvertTo-UtcDateTime $rsAt }
        if ($null -eq $rsWhen) { throw "entry '$($rsProp.Name)' has an unparseable attempt '$rsAt'" }
        $rsAttempts += $rsWhen.ToString('o')
      }
      $rsDowns = @()
      if ($rsEntry.PSObject.Properties['downAttempts']) {
        if ($rsEntry.downAttempts -isnot [array]) { throw "entry '$($rsProp.Name)' has a downAttempts that is not a list" }
        foreach ($rsDown in $rsEntry.downAttempts) {
          $rsDownWhen = if ($rsDown -is [datetime]) { $rsDown.ToUniversalTime() } else { ConvertTo-UtcDateTime $rsDown }
          if ($null -eq $rsDownWhen) { throw "entry '$($rsProp.Name)' has an unparseable downAttempt '$rsDown'" }
          $rsDowns += $rsDownWhen.ToString('o')
        }
      }
      $rsReason = ''; if ($rsEntry.PSObject.Properties['lastReason']) { $rsReason = "$($rsEntry.lastReason)" }
      $script:RespawnStreak[$rsProp.Name] = @{ jobId = "$($rsEntry.jobId)"; attempts = @($rsAttempts); downAttempts = @($rsDowns); lastReason = $rsReason }
    }
  } catch {
    $script:RespawnStreakUnreadable = $true; $script:RespawnStreakError = ("$($_.Exception.Message)" -replace '\s+', ' ').Trim(); $script:RespawnStreak = @{}
    # Raised on the read itself, every tick the file stays corrupt, whether or not a respawn is pending.
    $report.ok += [pscustomobject]@{ name = 'respawn-streak-read'; detail = "state/sentinel/respawn-streak.json unreadable ($($script:RespawnStreakError)); a respawn or relaunch of a session that still has a process is deferred until the file is deleted or fixed" }
    $report.escalate += [pscustomobject]@{ name = 'fleet'; kind = 'respawn-loop'; detail = "state/sentinel/respawn-streak.json unreadable ($($script:RespawnStreakError)); the bound on repeated respawns cannot be checked, so respawns of sessions that still have a process are held. Fix: delete state/sentinel/respawn-streak.json (safe: it only resets the counts)" }
  }
}
# (Get-ForeignRosterRoot is defined here, above Get-ExpectedRow and the -HealRespawn call site, because the stand-in rules use it.)
# `claude agents --all` lists every job on the machine, not only this root's. A scratch
# root (bin/scratch-root.ps1) launches through its own doors under the same fleet names,
# so its IC read here as a stray (ic-1686, job cf1d0d8e, 2026-09-26 03:46:57Z). A job's
# frozen --settings is <root>\state\sessions\<name>.settings.json; when that names
# another root whose live roster holds this very job, the session is that root's. Anything
# short of that proof (no settings, this root's settings, a root that does not roster
# the job) stays a stray.
function Get-ForeignRosterRoot {
  param($row)
  $js = $null; try { $js = Get-JobState $row.id } catch {}
  if (-not $js -or -not $js.PSObject.Properties['respawnFlags']) { return $null }
  $flags = @($js.respawnFlags | ForEach-Object { "$_" })
  $i = [array]::IndexOf($flags, '--settings')
  if ($i -lt 0 -or ($i + 1) -ge $flags.Count) { return $null }
  try {
    $sessionsDir = Split-Path -Parent $flags[$i + 1]
    $stateDir = Split-Path -Parent $sessionsDir
    if ((Split-Path -Leaf $sessionsDir) -ne 'sessions' -or (Split-Path -Leaf $stateDir) -ne 'state') { return $null }
    $root = [IO.Path]::GetFullPath((Split-Path -Parent $stateDir)).TrimEnd('\', '/')
    $own = [IO.Path]::GetFullPath($FleetHome).TrimEnd('\', '/')
  } catch { return $null }
  if ($root.Equals($own, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  # Another root's roster is not this root's to trust: unreadable means not proven.
  $roster = $null; try { $roster = Read-Json "$root\state\roster.json" } catch {}
  if (-not $roster) { return $null }
  $held = @($roster.sessions | Where-Object { $_.name -eq $row.name -and "$($_.jobId)" -eq "$($row.id)" -and "$($_.status)" -eq 'active' })
  if ($held.Count -eq 0) { return $null }
  return $root
}
# fleet #252 QA: Latest-Row is newest-by-name, which picks a stopped or orphaned same-name row over the
# rostered job when it is newer (Do-Respawn would then respawn the orphan). An IC whose active live-roster
# row records a jobId is judged by the daemon row with that id. Latest-Row stays the fallback only when the
# roster has no jobId. Statics keep Latest-Row. Two follow-ups from the #252 re-QA:
#  - the roster's jobId is not in the daemon list: a same-name row with a DIFFERENT id and no pid is the stopped
#    orphan whose rm failed, and respawning it would revive the orphan, so it is treated as no row (ic-vanished or
#    the dead-before-ack path). Only a same-name row that is running (a pid, not a classified orphan) stands in.
#  - the rostered job's row has no pid but a NEWER same-name row with a pid exists (not a classified orphan):
#    launch.ps1 -Recover is between `claude --bg` and its roster write, so the newer running row is the one judged,
#    not a respawn of the old one.
# Neither stand-in may be a row another fleet root rosters (Get-ForeignRosterRoot): a scratch root's session with the
# same name is not this root's job.
function Get-ExpectedRow {
  param($x)
  if (-not $x.static) {
    $rr = @($live.sessions | Where-Object { "$($_.name)" -eq "$($x.name)" -and "$($_.status)" -eq 'active' }) | Select-Object -Last 1
    if ($rr -and $rr.PSObject.Properties['jobId'] -and $rr.jobId) {
      $byId = $daemon | Where-Object { "$($_.id)" -eq "$($rr.jobId)" } | Select-Object -First 1
      if ($byId) {
        if (-not $byId.pid) {
          $byIdStart = ConvertTo-UtcDateTime $byId.startedAt
          $newer = @($daemon | Where-Object {
            "$($_.name)" -eq "$($x.name)" -and $_.pid -and "$($_.id)" -ne "$($byId.id)" -and -not $script:orphanJobIds.ContainsKey("$($_.id)") -and -not (Get-ForeignRosterRoot $_) -and
            $null -ne $byIdStart -and $null -ne (ConvertTo-UtcDateTime $_.startedAt) -and (ConvertTo-UtcDateTime $_.startedAt) -gt $byIdStart
          } | Sort-Object startedAt -Descending | Select-Object -First 1)
          if ($newer.Count -gt 0) { return $newer[0] }
        }
        return $byId
      }
      $fallback = Latest-Row $x.name
      if ($fallback -and $fallback.pid -and -not (Get-ForeignRosterRoot $fallback)) { return $fallback }
      return $null
    }
  }
  return (Latest-Row $x.name)
}
function Heartbeat-Age {
  param($name)
  $hb = Read-Json "$FleetHome\state\heartbeats\$name.json"
  if ($hb) { ($now - ([datetime]$hb.at).ToUniversalTime()).TotalMinutes } else { $null }
}
# Ticket 85 (2026-09-05 incident: ~120 consecutive "applied" respawns of a wedged
# dispatcher were logged applied and did nothing): the respawn command's own exit
# code says nothing about whether a new process actually replaced the old one. Bounded so
# a wedged daemon read cannot hang a tick; injectable so the test suite never sleeps
# the real 20s.
# 2026-09-17 QA (fleet #85 review #2): the verify wait is serial per session -
# three wedged statics used to cost 60s of the 180s check bound at the old 20s
# default; nine would kill the whole check (check-failed, masking the real
# cause). Default cut to 10s/1s polls, and at most RespawnVerifyCap
# verifications run per tick; anything past the cap is deferred to the next
# tick rather than paying for another wait.
$script:RespawnVerifyBoundMs = 10000
if ($env:FLEET_RESPAWN_VERIFY_MS) { try { $script:RespawnVerifyBoundMs = [int]$env:FLEET_RESPAWN_VERIFY_MS } catch {} }
$script:RespawnVerifyPollMs = 1000
if ($env:FLEET_RESPAWN_VERIFY_POLL_MS) { try { $script:RespawnVerifyPollMs = [int]$env:FLEET_RESPAWN_VERIFY_POLL_MS } catch {} }
$script:RespawnVerifyCap = 2
if ($env:FLEET_RESPAWN_VERIFY_CAP) { try { $script:RespawnVerifyCap = [int]$env:FLEET_RESPAWN_VERIFY_CAP } catch {} }
$script:RespawnVerifyCount = 0
function Test-RespawnVerified {
  # Strict re-read of the daemon row for $Name, bounded: a pid that is present and
  # differs from $PreviousPid (or appears where there was none) proves a new process
  # replaced the old one. An unreadable listing during the wait is NOT "pid changed" -
  # it is respawn-failed, the same as a genuine no-op; it must never be read as success.
  # With -JobId (an IC: a daemon respawn keeps the job id) the row is the one with that id, never newest-by-name: a
  # running same-name row would make a no-op respawn of the rostered job look verified.
  param([string]$Name, $PreviousPid, [string]$JobId = '')
  $deadline = (Get-Date).AddMilliseconds($script:RespawnVerifyBoundMs)
  do {
    try {
      $after = Get-DaemonSessions -All -Strict
      if ($JobId) { $row = $after | Where-Object { "$($_.id)" -eq $JobId } | Select-Object -First 1 }
      else { $row = $after | Where-Object { $_.name -eq $Name -and -not $script:orphanJobIds.ContainsKey("$($_.id)") } | Sort-Object startedAt -Descending | Select-Object -First 1 }
      if ($row -and $row.pid -and ("$($row.pid)" -ne "$PreviousPid")) { return $true }
    } catch {
      # unreadable this poll: fall through to the bound, never treated as success
    }
    if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $script:RespawnVerifyPollMs }
  } while ((Get-Date) -lt $deadline)
  return $false
}
function Test-JobStopped {
  # fleet #252, shaped like Test-RespawnVerified: a strict re-read of the daemon list, bounded by the
  # same FLEET_RESPAWN_VERIFY_MS / _POLL_MS knobs. The job is stopped when its row is gone or carries
  # no pid. An unreadable listing during the wait proves nothing and is never read as stopped.
  param([string]$Id)
  $deadline = (Get-Date).AddMilliseconds($script:RespawnVerifyBoundMs)
  do {
    try {
      $after = Get-DaemonSessions -All -Strict
      $row = $after | Where-Object { "$($_.id)" -eq $Id } | Select-Object -First 1
      if (-not $row -or -not $row.pid) { return $true }
    } catch {
      # unreadable this poll: fall through to the bound, never treated as stopped
    }
    if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $script:RespawnVerifyPollMs }
  } while ((Get-Date) -lt $deadline)
  return $false
}
function Test-JobRemoved {
  # fleet #252 QA: after `claude rm`, a bounded strict re-read must show no row with this id. An
  # unreadable listing proves nothing and is never read as removed.
  param([string]$Id)
  $deadline = (Get-Date).AddMilliseconds($script:RespawnVerifyBoundMs)
  do {
    try {
      $after = Get-DaemonSessions -All -Strict
      if (-not ($after | Where-Object { "$($_.id)" -eq $Id } | Select-Object -First 1)) { return $true }
    } catch {
      # unreadable this poll: fall through to the bound, never treated as removed
    }
    if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $script:RespawnVerifyPollMs }
  } while ((Get-Date) -lt $deadline)
  return $false
}
# fleet #121 (2026-09-23/24): the daemon respawn command replays the job's respawnFlags as they were
# frozen when the job was created, bypassing launch.ps1 (the pin map, the role file's
# effort, the trust gate, the roster row). Latest-Row picked a 2026-08-25 pl-endzone
# job with no roster row behind it and ran it on --model claude-opus-5 --effort xhigh
# for 16h. A static session is respawned only when the daemon row is the live
# roster's own active job AND its frozen --model/--effort equal what launch.ps1 passes
# today (_common.ps1 Resolve-LaunchModel / Get-RoleEffort). Otherwise this returns why,
# and Do-Respawn stops the job and relaunches through launch.ps1 -FromRoster instead.
# ICs keep the daemon respawn: their flags are per-assignment and short-lived.
function Get-StaticRespawnRefusal {
  param($row, $entry)
  $rosterRow = (Get-LiveRoster).sessions | Where-Object { $_.name -eq $entry.name -and "$($_.status)" -eq 'active' } | Select-Object -Last 1
  if (-not $rosterRow) { return "no active live-roster row names $($entry.name), so job $($row.id) is not a session launch.ps1 started" }
  if (-not $rosterRow.jobId) { return "the live-roster row for $($entry.name) records no jobId, so job $($row.id) cannot be shown to be the session launch.ps1 started" }
  if ("$($rosterRow.jobId)" -ne "$($row.id)") { return "job $($row.id) is not the live roster's job $($rosterRow.jobId)" }
  $js = $null; try { $js = Get-JobState $row.id } catch {}
  if (-not $js -or -not $js.PSObject.Properties['respawnFlags']) { return "job $($row.id) has no readable respawnFlags to compare" }
  $flags = @($js.respawnFlags | ForEach-Object { "$_" })
  $frozen = @{}
  foreach ($flag in '--model', '--effort') {
    $at = [array]::IndexOf($flags, $flag)
    $frozen[$flag] = if ($at -ge 0 -and $at + 1 -lt $flags.Count) { $flags[$at + 1] } else { '' }
  }
  $expectedModel = (Resolve-LaunchModel -Role "$($entry.role)" -Model "$($rosterRow.model)").id
  $roleEffort = Get-RoleEffort "$($entry.role)"
  $expectedEffort = if (Test-LaunchEffort $roleEffort) { $roleEffort } else { '' }
  # A pinned model (a claude-* id) must match exactly. An alias (a roster -Model such as
  # sonnet or haiku, or, with no model at all, the role file's `model:`) is resolved by
  # the CLI, which records the id it chose (the dispatcher's sonnet froze as
  # claude-sonnet-5): there the frozen id must belong to the alias's family.
  $alias = if ($expectedModel -and $expectedModel -notmatch '^claude-') { $expectedModel } elseif (-not $expectedModel) { Get-RoleModel "$($entry.role)" } else { $null }
  $modelMatches = if ($null -eq $alias) { $frozen['--model'] -eq $expectedModel } else {
    (-not $alias) -or (-not $frozen['--model']) -or ($frozen['--model'] -eq $alias) -or ($frozen['--model'] -match "(^|-)$([regex]::Escape($alias))(-|$)")
  }
  $effortMatches = (-not $expectedEffort) -or $frozen['--effort'] -eq $expectedEffort
  if (-not $modelMatches -or -not $effortMatches) {
    if (-not $expectedModel) { $expectedModel = "the role alias $(Get-RoleModel "$($entry.role)")" }
    return "job $($row.id) would replay --model '$($frozen['--model'])' --effort '$($frozen['--effort'])', but launch.ps1 passes --model '$expectedModel' --effort '$expectedEffort' today"
  }
  return $null
}
# fleet #257 Gap B (live 2026-09-30: pl-nidus respawned 72 times in a day, each one verified by a pid change, none followed by a
# turn): respawn-failed.json and the retry-storm scan only count failures, and a verified respawn clears the failure count, so
# nothing bounded a respawn that "worked" and woke nothing. Every verified respawn (Do-Respawn) and launched relaunch
# (Do-Relaunch) is counted per name in state/sentinel/respawn-streak.json; the (cap+1)th inside the window is held.
function Get-HeartbeatAt {
  param($name)
  try { $hb = Read-Json "$FleetHome\state\heartbeats\$name.json"; if ($hb -and $hb.PSObject.Properties['at']) { return (ConvertTo-UtcDateTime $hb.at) } } catch {}
  return $null
}
function Get-LiveRespawnAttempts {
  # The entry's attempts that still count: the entry is for this job id, the attempt is inside the window, and no heartbeat
  # is newer than it (a heartbeat after a respawn proves the respawned session ended a turn, so the loop is over).
  param([string]$name, [string]$jobId, [switch]$DownOnly)
  $e = $script:RespawnStreak[$name]
  if ($null -eq $e -or "$($e.jobId)" -ne $jobId) { return @() }
  $windowStart = $now.AddHours(-$script:RespawnLoopWindowHours)
  $hbAt = Get-HeartbeatAt $name
  # -DownOnly: only the attempts made when the row had no pid (a death), for respawn-loop-down.
  $list = if ($DownOnly) { @($e.downAttempts) } else { @($e.attempts) }
  return @($list | Where-Object { $t = ConvertTo-UtcDateTime $_; $null -ne $t -and $t -ge $windowStart -and ($null -eq $hbAt -or $t -gt $hbAt) } | Sort-Object { ConvertTo-UtcDateTime $_ })
}
function Save-RespawnStreak {
  # Written only by an applying run, pruned by the callers; a hand read-only run never changes the file.
  if (-not $Apply -or $script:RespawnStreakUnreadable) { return }
  try {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $script:RespawnStreakPath)) | Out-Null
    $out = [ordered]@{}
    foreach ($k in @($script:RespawnStreak.Keys | Sort-Object)) {
      $e = $script:RespawnStreak[$k]
      $out[$k] = [ordered]@{ jobId = "$($e.jobId)"; attempts = @($e.attempts); downAttempts = @($e.downAttempts); lastReason = "$($e.lastReason)" }
    }
    $tmp = "$($script:RespawnStreakPath).tmp"
    Write-Json $tmp ([pscustomobject]$out)
    Move-Item -LiteralPath $tmp -Destination $script:RespawnStreakPath -Force
  } catch { Write-Warning "respawn-streak write failed: $($_.Exception.Message)" }
}
function Add-RespawnStreakAttempt {
  # Count one verified respawn / launched relaunch. -FromJobId is the job id the running attempts were recorded under (the
  # row this tick saw); -JobId is the id the next tick will see (the same id for a respawn, the new job for a relaunch).
  # -Down marks the attempt as a death (the row had no pid), which is what respawn-loop-down counts.
  param([string]$name, [string]$FromJobId, [string]$JobId, [string]$reason, [switch]$Down)
  $at = Now-Iso
  $attempts = @(Get-LiveRespawnAttempts $name $FromJobId) + @($at)
  $downs = @(Get-LiveRespawnAttempts $name $FromJobId -DownOnly)
  if ($Down) { $downs += $at }
  $script:RespawnStreak[$name] = @{ jobId = $JobId; attempts = @($attempts); downAttempts = @($downs); lastReason = (("$reason" -replace '\s+', ' ').Trim()) }
  $script:RespawnStreakTouched[$name] = $true
  Save-RespawnStreak
}
function Test-RespawnStreakHold {
  # $true when this respawn / relaunch must not run. Evaluated in read-only runs too; it writes nothing.
  param($row, $entry, [string]$reason, [string]$via = '')
  # Liveness first: only a row WITH a live pid can be in the "respawn verified, no turn follows" loop this bound exists for.
  # A row with no pid (reaped, stopped, failed) is always respawned / relaunched as before, and still counted; once it has
  # gone down cap times with no heartbeat in between, respawn-loop-down says the session keeps going down.
  $hasPid = [bool]$row.pid
  if ($script:RespawnStreakUnreadable) {
    if (-not $hasPid) { return $false }   # the file is left as found and this respawn is not counted; the read already escalated
    $deferred = [ordered]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "state/sentinel/respawn-streak.json unreadable; respawns held until it is fixed or removed: $reason" }
    if ($via) { $deferred.via = $via }
    $script:report.respawnDeferred += [pscustomobject]$deferred
    return $true
  }
  $live = @(Get-LiveRespawnAttempts "$($entry.name)" "$($row.id)")
  if ($live.Count -lt $script:RespawnLoopCap) { return $false }
  $firstAt = "$($live[0])"; $lastAt = "$($live[$live.Count - 1])"
  $hbAt = Get-HeartbeatAt "$($entry.name)"
  $hbText = if ($null -eq $hbAt) { 'never' } else { "last at $($hbAt.ToString('o')), before the first respawn" }
  if (-not $hasPid) {
    # respawn-loop-down counts DEATHS (attempts made with no pid), not idle live-pid respawns: a session respawned live-idle three times that
    # then dies once has died once.
    $liveDown = @(Get-LiveRespawnAttempts "$($entry.name)" "$($row.id)" -DownOnly)
    if ($liveDown.Count -lt $script:RespawnLoopCap) { return $false }
    $firstAt = "$($liveDown[0])"
    $script:report.escalate += [pscustomobject]@{ name = $row.name; kind = 'respawn-loop-down'; detail = "job $($row.id) has died and been respawned $($liveDown.Count) times since $firstAt with no turn completed after any of them (heartbeat: $hbText) and has no process again: the session keeps going down; respawning anyway because a session with no process is always respawned. Check why it dies (claude agents --all; bin\status.ps1; the job's state.json), relaunch it by hand (rotate.ps1 / launch.ps1), or retire it; $reason"; parent = $entry.parent }
    return $false
  }
  $held = [ordered]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; attempts = $live.Count; firstAt = $firstAt; lastAt = $lastAt; reason = $reason }
  if ($via) { $held.via = $via }
  $script:report.respawnHeld += [pscustomobject]$held
  $script:report.escalate += [pscustomobject]@{ name = $row.name; kind = 'respawn-loop'; detail = "job $($row.id) respawned $($live.Count) times since $firstAt (pid changed each time) and no turn completed after any of them (heartbeat: $hbText); respawn held until a heartbeat newer than $lastAt, a new job id, or the window ($($script:RespawnLoopWindowHours) h) passes: check the session (claude agents --all; bin\status.ps1), relaunch it by hand (rotate.ps1 / launch.ps1), or delete state/sentinel/respawn-streak.json (safe: it only resets the counts); $reason"; parent = $entry.parent }
  return $true
}
function Do-Relaunch {
  param($row, $entry, $reason)
  # fleet #257 Gap B: bounded like a respawn. Checked first so a read-only run reports the hold too.
  if (Test-RespawnStreakHold $row $entry $reason 'launch') { return }
  if (-not $Apply) {
    $script:report.respawned += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = $reason; via = 'launch' }
    return
  }
  if ($script:RespawnVerifyCount -ge $script:RespawnVerifyCap) {
    $script:report.respawnDeferred += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "verify cap ($($script:RespawnVerifyCap)) reached this tick; deferred to the next tick: $reason"; via = 'launch' }
    return
  }
  # Never stop a running session the door is about to refuse (review of #121): PAUSE and
  # an untrusted workspace refuse a launch, and the stopped session would stay down.
  $refuseWhy = $null
  if (Test-Paused) { $refuseWhy = 'PAUSE is set, and launch.ps1 would refuse the relaunch' }
  else {
    $staticEntry = @($static.sessions | Where-Object { "$($_.name)" -eq "$($entry.name)" })[0]
    $launchCwd = if ($staticEntry -and $staticEntry.cwd) { "$($staticEntry.cwd)" } elseif ($entry.tenant) { "$((Read-Json "$FleetHome\tenants\$($entry.tenant).json").repo)" } else { $FleetHome }
    if (-not (Test-Path "$FleetHome\state\flags\launch-trust-check-off") -and -not (Test-WorkspaceTrusted $launchCwd)) { $refuseWhy = "workspace '$launchCwd' is not trusted, and launch.ps1 would refuse the relaunch" }
  }
  if ($refuseWhy) {
    $script:report.respawnDeferred += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "relaunch deferred, nothing stopped: $refuseWhy; $reason"; via = 'launch' }
    return
  }
  $script:RespawnVerifyCount++
  if ($row.pid) {
    # fleet #265: the CLI is resolved, not assumed; a miss is a named failure, not a silent no-op stop.
    try { $null = Invoke-ClaudeCli -Arguments @('stop', "$($row.id)") } catch {
      $script:report.respawnFailed += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "relaunch not attempted, claude stop could not run: $(Get-OneLineText "$($_.Exception.Message)"): $reason"; via = 'launch' }
      return
    }
  }
  # Hashtable splat (rotate.ps1's lesson: PS 5.1 array splatting passes '-FromRoster' as a value).
  $launchArgs = @{ FromRoster = "$($entry.name)" }
  # A hand-set -Model on the roster row survives the relaunch (launch.ps1's ValidateSet tokens only).
  $rosterModel = "$(@((Get-LiveRoster).sessions | Where-Object { $_.name -eq $entry.name -and "$($_.status)" -eq 'active' } | Select-Object -Last 1).model)"
  if ($rosterModel -in @('sonnet', 'opus', 'haiku', 'fable', 'opus-5.5') -and $rosterModel -ne (Resolve-LaunchModel -Role "$($entry.role)" -Model '').token) { $launchArgs.Model = $rosterModel }
  $out = & "$PSScriptRoot\launch.ps1" @launchArgs 2>&1 | Out-String
  $launch = ConvertFrom-LastJsonLine $out
  if ($launch -and $launch.launched) {
    Add-RespawnStreakAttempt "$($entry.name)" "$($row.id)" "$($launch.jobId)" $reason -Down:(-not $row.pid)
    $script:report.respawned +=[pscustomobject]@{ name = $row.name; jobId = "$($launch.jobId)"; previousJobId = $row.id; parent = $entry.parent; reason = $reason; via = 'launch' }
  } else {
    $why = if ($launch -and $launch.reason) { "$($launch.reason)" } else { Get-OneLineText $out }
    $script:report.respawnFailed += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "relaunch through launch.ps1 -FromRoster failed ($why): $reason"; via = 'launch' }
  }
}
function Get-OneLineText { param([string]$Text) $t = ("$Text" -replace '\s+', ' ').Trim(); if ($t.Length -gt 200) { $t = $t.Substring(0, 200) }; return $t }
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
  } else {
    $refusal = Get-StaticRespawnRefusal $row $entry
    if ($refusal) { Do-Relaunch $row $entry "$reason; not respawned because $refusal"; return }
  }
  # fleet #257 Gap B: the (cap+1)th verified respawn of one job with no heartbeat in between is held (read-only runs report it too).
  if (Test-RespawnStreakHold $row $entry $reason) { return }
  if (-not $Apply) {
    # Shadow: nothing to verify against, since nothing was run.
    $script:report.respawned += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = $reason }
    return
  }
  if ($script:RespawnVerifyCount -ge $script:RespawnVerifyCap) {
    # 2026-09-17 QA (fleet #85 review #2): the verify wait is what makes each
    # respawn costly, not the respawn command itself - past the cap this tick,
    # skip both rather than pay for a wait this tick cannot afford.
    $script:report.respawnDeferred += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "verify cap ($($script:RespawnVerifyCap)) reached this tick; deferred to the next tick: $reason" }
    return
  }
  $script:RespawnVerifyCount++
  try { $null = Invoke-ClaudeCli -Arguments @('respawn', "$($row.id)") } catch {
    $script:report.respawnFailed += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "claude respawn could not run: $(Get-OneLineText "$($_.Exception.Message)"): $reason" }
    return
  }
  $verifyId = if ($entry.static) { '' } else { "$($row.id)" }
  if (Test-RespawnVerified -Name $row.name -PreviousPid $row.pid -JobId $verifyId) {
    Add-RespawnStreakAttempt "$($entry.name)" "$($row.id)" "$($row.id)" $reason -Down:(-not $row.pid)
    $script:report.respawned +=[pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = $reason }
  } else {
    # Feeds the existing launch-retry cap exactly as a failed launch would: this
    # session's next daemon row is what the watchdog's retry-storm scan reads, and a
    # no-op respawn leaves that row exactly as it was - unmasked here, never reported
    # as an applied success.
    $script:report.respawnFailed += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "respawn did not change the daemon pid (was $($row.pid)): $reason" }
  }
}

function Property-Names { param($obj) if ($null -eq $obj) { return @() }; return @($obj.PSObject.Properties.Name) }

# fleet #253: an IC that got a roster row and died before `assignment-started`. launch.ps1 writes the row
# (manifest, workRecordId, launchedAt) only after it saw the session, and the session's first turn writes
# the ack sidecar and, at the end of the turn, a heartbeat; a row with neither, past the grace, whose job
# is gone will never do either. Returns the one-line why, or $null when any leg of the proof is missing
# (a legacy row without a manifest, any heartbeat - the recover/respawn path owns that row -, an ack, the
# grace not yet over, an unparseable or future launchedAt, a job that could still be running, a roster
# that did not read cleanly). Branch (a): no daemon row for the name AND the job state is terminal, or
# not fresh (updatedAt older than watchdog.staleMinutes); a working state with no updatedAt is not proof.
# Branch (b): the daemon row is this row's own job, has no pid, is stopped|failed|done, and the job state
# is older than the grace (absent updatedAt counts as old).
function Test-DeadBeforeAck {
  param($x, $row)
  if ($x.static -or $rosterUnreadable -or $null -eq $x.rosterRow) { return $null }
  $r = $x.rosterRow
  foreach ($f in 'manifest', 'workRecordId', 'launchedAt', 'jobId') {
    if (-not $r.PSObject.Properties[$f] -or -not "$($r.$f)") { return $null }
  }
  if (Test-Path -LiteralPath "$FleetHome\state\heartbeats\$($x.name).json") { return $null }
  if (Test-Path -LiteralPath "$($r.manifest).acknowledged.json") { return $null }
  # The ledger's own proof of no ack: acknowledgeAssignment moves the Work record out of `assigned` BEFORE it writes
  # the sidecar, so a missing sidecar alone is not proof. Anything but an `assigned` record (implementing, released,
  # absent, an unreadable active.json) falls through to today's path.
  try {
    $activeForAck = Get-Content -LiteralPath "$FleetHome\state\work\active.json" -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $recProp = $activeForAck.records.PSObject.Properties["$($r.workRecordId)"]
    if ($null -eq $recProp -or "$($recProp.Value.state)" -ne 'assigned') { return $null }
  } catch { return $null }
  $launched = ConvertTo-UtcDateTime $r.launchedAt
  if ($null -eq $launched) { return $null }
  $sinceLaunch = ($now - $launched).TotalMinutes
  if ($sinceLaunch -lt $script:DeadBeforeAckMinutes) { return $null }
  $js = $null
  try { $js = Get-JobState "$($r.jobId)" } catch { return $null }
  $jobUpdated = $null; if ($js -and $js.PSObject.Properties['updatedAt']) { $jobUpdated = ConvertTo-UtcDateTime $js.updatedAt }
  $lead = "no heartbeat was ever written for $($x.name) and its manifest was never acknowledged ($([int]$sinceLaunch) min since launch); "
  if (-not $row) {
    if (-not $js) { return $lead + "job $($r.jobId) has no daemon row and no job state" }
    $jobState = "$($js.state)"
    if ($jobState -in @('stopped', 'failed', 'done')) { return $lead + "job $($r.jobId) has no daemon row and its job state is $jobState" }
    if ($null -ne $jobUpdated -and ($now - $jobUpdated).TotalMinutes -gt $script:JobStaleMinutes) { return $lead + "job $($r.jobId) has no daemon row and its job state ($jobState) has not moved for $([int]($now - $jobUpdated).TotalMinutes) min" }
    return $null
  }
  if ($row.pid -or "$($row.id)" -ne "$($r.jobId)" -or "$($row.state)" -notin @('stopped', 'failed', 'done')) { return $null }
  if ($null -ne $jobUpdated -and ($now - $jobUpdated).TotalMinutes -lt $script:DeadBeforeAckMinutes) { return $null }
  return $lead + "job $($r.jobId) is $($row.state) with no process"
}

# fleet #257 Gap A: an IC whose FIRST turn never ended. The session is alive, but the stop hook (which writes state/heartbeats/<name>.json
# at the end of a turn) never fired, so Heartbeat-Age is $null and the stale-heartbeat respawn (`$null -ne $age -and $age -gt 120`) never
# considered it. The job state is the other witness: the daemon moves its `updatedAt` about every 20-30 s while the model works, and stamps
# `firstTerminalAt` the first time the job reaches a terminal state (done). Returns the one-line why, or $null when any leg of the proof is missing:
#  - a non-static row whose daemon row has a pid and state working; no heartbeat value AND no heartbeat file;
#  - not busy, or busy with only a leaked background task in flight (Get-BusyStanding, the same gate as the stale-heartbeat branch: a hung
#    busy first turn is mid-turn by that measure and stays with the watchdog's busy-stale page);
#  - at least watchdog.firstTurnStaleMinutes (default 120) since launchedAt (startedAt when the roster has none), both unparseable -> $null;
#  - the job state is readable with a parseable updatedAt that has not moved for watchdog.staleMinutes (default 45);
#  - no firstTerminalAt. A firstTerminalAt marks the job's first TERMINAL STATE (done), not the end of a first turn: a job that has been done is
#    not a hung first turn, so it is not respawned and is named under ok. The diagnosis there is narrow: it only covers a stop hook that failed
#    after the job went done (a hook that never ran in a turn that ended while the job stayed working is exactly what the predicate above catches).
function Get-FirstTurnStaleReason {
  param($x, $row)
  if ($x.static -or $null -eq $row -or -not $row.pid -or "$($row.state)" -ne 'working') { return $null }
  if ($null -ne (Heartbeat-Age $x.name) -or (Test-Path -LiteralPath "$FleetHome\state\heartbeats\$($x.name).json")) { return $null }
  if ("$($row.status)" -eq 'busy' -and (Get-BusyStanding $row -QuietMinutes (Get-BusyQuietMinutes)).standing -ne 'background') { return $null }
  $launched = $null
  if ($x.rosterRow -and $x.rosterRow.PSObject.Properties['launchedAt']) { $launched = ConvertTo-UtcDateTime $x.rosterRow.launchedAt }
  if ($null -eq $launched) { $launched = ConvertTo-UtcDateTime $row.startedAt }
  if ($null -eq $launched) { return $null }
  $sinceLaunch = ($now - $launched).TotalMinutes
  if ($sinceLaunch -lt $script:FirstTurnStaleMinutes) { return $null }
  $js = $null; try { $js = Get-JobState "$($row.id)" } catch { return $null }
  if (-not $js -or -not $js.PSObject.Properties['updatedAt']) { return $null }
  $updated = ConvertTo-UtcDateTime $js.updatedAt
  if ($null -eq $updated) { return $null }
  $quiet = ($now - $updated).TotalMinutes
  if ($quiet -lt $script:JobStaleMinutes) { return $null }
  if ($js.PSObject.Properties['firstTerminalAt'] -and "$($js.firstTerminalAt)") {
    $script:report.ok += [pscustomobject]@{ name = "$($x.name)"; detail = "job reached its first terminal state (done) at $($js.firstTerminalAt) but no heartbeat was ever written; not a hung first turn, not respawned; the only hook fault this can indicate is a stop hook failed after done" }
    return $null
  }
  $ackText = 'manifest never acknowledged'
  if ($x.rosterRow -and $x.rosterRow.PSObject.Properties['manifest'] -and "$($x.rosterRow.manifest)") {
    try { $ack = Read-Json "$($x.rosterRow.manifest).acknowledged.json"; if ($ack -and $ack.PSObject.Properties['acknowledgedAt']) { $ackText = "manifest acknowledged at $($ack.acknowledgedAt)" } } catch {}
  }
  return "first turn never completed: no heartbeat ever written, $([int]$sinceLaunch) min since launch, job state silent $([int]$quiet) min (updatedAt $($updated.ToString('o'))), $ackText; state=$($row.state) status=$($row.status)"
}

# --- roster sessions: static (always expected) + active ICs ---
$expected = @()
foreach ($s in (Get-ExpectedStaticSessions $static)) { $expected += [pscustomobject]@{ name = $s.name; role = $s.role; parent = $s.parent; tenant = $s.tenant; issue = $null; static = $true; rosterRow = $null } }
foreach ($e in ($live.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' })) { $expected += [pscustomobject]@{ name = $e.name; role = $e.role; parent = $e.parent; tenant = $e.tenant; issue = $e.issue; static = $false; rosterRow = $e } }

# Ticket 84: heal a blocked, stale IC through the ticket 85 Do-Respawn path (a
# no-op still counts as respawn-failed). The Watchdog decides WHETHER to heal
# (needs, heartbeat age, and Test-WorkWaiting all live there, ticket 75) and
# calls this script back with the one name to act on - reusing Do-Respawn here
# rather than a second copy of it. Control-plane roles are healed by the
# Watchdog itself, through rotate.ps1, never through this path.
if ($HealRespawn) {
  # 2026-09-17 QA (fleet #85 review #10): a defense-in-depth refusal, independent
  # of $expected membership (sentinel-off, say, drops 'sentinel' from $expected
  # entirely, which must never read as "safe to respawn" here) - a control-plane
  # name is healed only through rotate.ps1, by the Watchdog, never this path.
  $healRespawnControlPlaneNames = ($HealRespawn -eq 'dispatcher') -or ($HealRespawn -eq 'sentinel') -or ($HealRespawn -match '^pl-') -or ($HealRespawn -match '^pe-')
  $target = $expected | Where-Object { $_.name -eq $HealRespawn } | Select-Object -First 1
  if ($healRespawnControlPlaneNames -or ($target -and (@('dispatcher', 'project-lead', 'principal', 'sentinel') -contains "$($target.role)"))) {
    $report.respawnFailed += [pscustomobject]@{ name = $HealRespawn; jobId = $null; parent = $(if ($target) { $target.parent } else { '' }); reason = "heal-respawn refused: '$HealRespawn' is a control-plane name/role, healed only through rotate.ps1" }
  } elseif (-not $target) {
    $report.respawnFailed += [pscustomobject]@{ name = $HealRespawn; jobId = $null; parent = ''; reason = 'heal-respawn: not an expected session (roster changed underfoot)' }
  } else {
    $row = Get-ExpectedRow $target
    if (-not $row) {
      $report.respawnFailed += [pscustomobject]@{ name = $HealRespawn; jobId = $null; parent = $target.parent; reason = 'heal-respawn: no job known to the daemon' }
    } else {
      Do-Respawn $row $target 'heal: blocked, stale, work waiting'
    }
  }
  if (-not $ReportPath) { $ReportPath = "$FleetHome\state\sentinel\last-check.json" }
  $report.timeouts = @($script:BoundedTimeouts)   # fleet #101: named timeouts reach the watchdog's shadow line
  Write-Json $ReportPath ([pscustomobject]$report)
  Write-AppliedLedger $report
  [pscustomobject]$report | ConvertTo-Json -Depth 6
  exit 0
}

# fleet #253: the orphan pass runs BEFORE the expected loop (it used to follow it) so the loop's Latest-Row can leave
# the job ids it classified out.
# fleet #252: an orphan late session. launch.ps1's no-session path releases the reservation, writes
# <manifest>.invalidated.json and exits before it writes a roster row, so a job ic-N that starts
# AFTER that has no roster row, cannot ack (the manifest is invalidated) and is invisible to the
# roster-driven paths. Proof required, all of it: this root's job (a pid, an ic-<N> name, not held
# by another root), no active|retiring roster row claims it BY JOB ID (a duplicate name does not
# vouch for it), the manifest its launch prompt names carries an .invalidated.json marker and was
# never acknowledged, and the roster read cleanly. Anything short of that falls through to `stray`.
# Acting (claude stop, verified, then claude rm) needs -Apply AND state/flags/ic-cleanup-live:
# shadow-first, Cory creates the flag after a clean shadow week. The page is raised in every mode.
$cleanupLive = ([bool]$Apply) -and (Test-Path -LiteralPath "$FleetHome\state\flags\ic-cleanup-live")
if (-not $rosterUnreadable) {
  foreach ($row in @($daemon | Where-Object { $_.pid -and ("$($_.name)" -match '^ic-[0-9]+$') })) {
    $jobId = "$($row.id)"
    if (-not $jobId) { continue }
    $claimed = @($rosterRows | Where-Object { "$($_.status)" -in @('active', 'retiring') -and "$($_.jobId)" -eq $jobId })
    if ($claimed.Count -gt 0) { continue }
    if (Get-ForeignRosterRoot $row) { continue }
    $js = $null; try { $js = Get-JobState $jobId } catch {}
    if (-not $js -or -not $js.PSObject.Properties['intent']) { continue }
    $intent = ("$($js.intent)").TrimStart([char]0xFEFF)
    if ($intent -notmatch 'assignment manifest at (\S+?\.json)(\s|$)') { continue }
    $manifestPath = $Matches[1]
    $markerPath = "$manifestPath.invalidated.json"
    if (-not (Test-Path -LiteralPath $markerPath)) { continue }
    if (Test-Path -LiteralPath "$manifestPath.acknowledged.json") { continue }
    $script:orphanJobIds[$jobId] = $true
    $markerReason = ''
    try { $marker = Read-Json $markerPath; if ($marker -and $marker.PSObject.Properties['reason']) { $markerReason = Get-OneLineText "$($marker.reason)" } } catch {}
    $manifestParent = ''
    try { $mf = Read-Json $manifestPath; if ($mf -and $mf.PSObject.Properties['parent'] -and $mf.parent) { $manifestParent = "$($mf.parent)" } } catch {}
    $outcome = 'would stop (state/flags/ic-cleanup-live absent)'
    if ($cleanupLive) {
      $stopRunError = ''
      try { $null = Invoke-ClaudeCli -Arguments @('stop', "$jobId") } catch { $stopRunError = " (claude stop could not run: $(Get-OneLineText "$($_.Exception.Message)"))" }
      if (-not $stopRunError -and (Test-JobStopped -Id $jobId)) {
        # rm's own result is not trusted: a refused rm leaves the stopped row listed, and a stopped row
        # newer than the rostered job of the same name is what Latest-Row used to respawn. Confirm by a
        # strict re-read that the row is gone, and say so when it is not.
        # Continue while rm runs: a native stderr line under a Stop preference would throw before the exit code is read.
        $rmEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $rmOut = ''; $rmExit = $null
        try { $rmRun = Invoke-ClaudeCli -Arguments @('rm', "$jobId"); $rmOut = "$($rmRun.stdout)$($rmRun.stderr)"; $rmExit = if ($rmRun.timedOut -or $rmRun.startError) { -1 } else { $rmRun.exitCode } } catch { $rmOut = "$($_.Exception.Message)"; $rmExit = -1 } finally { $ErrorActionPreference = $rmEap }
        $removed = Test-JobRemoved -Id $jobId
        $rmError = ''
        if (-not $removed) {
          $rmError = if ($rmExit -ne 0) { "claude rm exit ${rmExit}: $(Get-OneLineText $rmOut)" } else { "row $jobId still listed after claude rm (exit 0)" }
        }
        $outcome = if ($removed) { 'stopped' } else { "stopped, not removed: $rmError" }
        $report.stopped += [pscustomobject]@{ name = $row.name; jobId = $jobId; manifest = $manifestPath; reason = "orphan late session: manifest invalidated ($markerReason)"; verified = $true; removed = $removed; rmError = $rmError }
      } else {
        $failReason = "job $jobId still had a pid after claude stop (waited $($script:RespawnVerifyBoundMs) ms)$stopRunError"
        $outcome = "stop failed: $failReason"
        $report.stopFailed += [pscustomobject]@{ name = $row.name; jobId = $jobId; manifest = $manifestPath; reason = $failReason }
      }
    }
    $report.escalate += [pscustomobject]@{ name = $row.name; kind = 'orphan-late-session'; detail = "job $jobId started after launch.ps1 released its manifest ($markerPath, reason: $markerReason); no roster row claims it; $outcome"; parent = $manifestParent }
  }
}
foreach ($x in $expected) {
  $row = Get-ExpectedRow $x
  # fleet #253: shadow-first like #252. Acting needs -Apply AND state/flags/ic-cleanup-live; the page is raised in
  # every mode and the shadow falls through to today's ic-vanished / respawn branch.
  $deadWhy = Test-DeadBeforeAck $x $row
  if ($deadWhy) {
    $rr = $x.rosterRow
    if (-not $cleanupLive) {
      $whyNot = if (Test-Path -LiteralPath "$FleetHome\state\flags\ic-cleanup-live") { 'read-only run' } else { 'state/flags/ic-cleanup-live absent' }
      $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'ic-dead-before-ack'; detail = "$deadWhy; would retire the row and release Work record $($rr.workRecordId) ($whyNot)"; parent = $x.parent }
    } elseif (Test-Paused) {
      $report.ok += [pscustomobject]@{ name = $x.name; detail = "dead-before-ack retire and release deferred: PAUSE is set; $deadWhy" }
    } elseif ($script:DeadRetireCount -ge $script:DeadBeforeAckMaxPerTick) {
      $report.ok += [pscustomobject]@{ name = $x.name; detail = "dead-before-ack retire deferred to the next tick: $($script:DeadBeforeAckMaxPerTick) retires already done this tick (watchdog.deadBeforeAckMaxPerTick); $deadWhy" }
    } else {
      # Re-read the live roster right before acting (the Do-Respawn rule): the row must still be this active job's.
      $fresh = @((Get-LiveRoster).sessions | Where-Object { "$($_.name)" -eq "$($x.name)" -and "$($_.status)" -eq 'active' -and "$($_.jobId)" -eq "$($rr.jobId)" })
      if ($fresh.Count -eq 0) {
        $report.ok += [pscustomobject]@{ name = $x.name; detail = 'dead-before-ack retire cancelled: the live roster row is no longer this active job' }
        continue
      }
      $retireOut = & "$PSScriptRoot\retire.ps1" -Name $x.name -Reason "dead before ack: $deadWhy" 2>&1 | Out-String
      $retireJson = ConvertFrom-LastJsonLine $retireOut
      $script:DeadRetireCount++
      # Count the row retired only when retire.ps1 said so (its JSON line names it) and the roster agrees.
      $retiredRow = @((Get-LiveRoster).sessions | Where-Object { "$($_.name)" -eq "$($x.name)" -and "$($_.jobId)" -eq "$($rr.jobId)" } | Select-Object -Last 1)[0]
      $retireOk = ($null -ne $retireJson) -and ("$($retireJson.retired)" -eq "$($x.name)") -and ($null -ne $retiredRow) -and ("$($retiredRow.status)" -eq 'retired')
      if ($retireOk) { $report.retired += $x.name }
      # Release AFTER the retire: a claimed reservation (an active|retiring roster row) refuses release.
      if (-not $retireOk) {
        $release = [pscustomobject]@{ ok = $false; code = 'RETIRE_FAILED'; detail = (Get-OneLineText $retireOut); revision = $null; marker = $false }
      } else {
        $release = Invoke-ManifestRelease -Manifest "$($rr.manifest)" -WorkRecordId "$($rr.workRecordId)" -Reason "dead before ack: $deadWhy"
      }
      $report.deadRetired += [pscustomobject]@{ name = $x.name; jobId = "$($rr.jobId)"; workRecordId = "$($rr.workRecordId)"; manifest = "$($rr.manifest)"; reason = $deadWhy; retire = $retireJson; release = $release }
      $releaseNote = if ($release.ok) { "released Work record $($rr.workRecordId)" } else { "release of Work record $($rr.workRecordId) failed: $($release.code) ($($release.detail))" }
      $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'ic-dead-before-ack'; detail = "$deadWhy; $(if ($retireOk) { 'retired the row' } else { 'retire FAILED, the row stays on the roster and the release was skipped' }); $releaseNote"; parent = $x.parent }
      continue
    }
  }
  if (-not $row) {
    if ($x.static) { $report.launchNeeded += [pscustomobject]@{ name = $x.name; reason = 'no job known to the daemon' } }
    else { $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'ic-vanished'; detail = "active IC for issue #$($x.issue) has no job; parent $($x.parent) must relaunch or retire"; parent = $x.parent } }
    continue
  }
  $js = Get-JobState $row.id
  $detail = ''
  if ($js) { $detail = "$($js.detail) $($js.waitingFor)" }
  # Wordings seen live: "rate limit", "usage limit", "You've hit your session limit · resets 5:50pm"
  # (2026-09-01: the last one matched nothing, so no PAUSE was set and the watchdog paged
  # fleet-dead during a plain Max-plan window). The detail is the session's own free-text
  # summary, so a bare keyword is work being described, not a limit: on 2026-09-28 "session
  # limit 6/6" (pl-endzone's IC cap) and "pairing rate limit" (pe-nidus naming Nidus #21)
  # each paused the fleet for an hour. Match only the CLI's limit sentence: "hit your ...
  # limit", "limit will reset", or a reset clock time.
  if ($detail -match 'hit your \w+ limit|limit will reset|resets?( at)? \d{1,2}(:\d{2})?\s?(am|pm)') {
    if (-not (Test-Paused)) {
      # The detail line is a LEVEL, not an event: it is the session's own last status summary and
      # stands long after the limit it names has reset (live 2026-09-10: "resets 1:20am" still stood
      # at 13:16Z and re-armed a PAUSE within one tick of each manual clear, three times in 14h). One
      # PAUSE per wording per session: state/sentinel/rate-limit-signal.json remembers the wording
      # each name was last paused on, and the same wording never pauses twice. A new limit writes a
      # new reset time, which is a new wording, which pauses again.
      $signalPath = "$FleetHome\state\sentinel\rate-limit-signal.json"
      $seen = Read-Json $signalPath
      $prior = $null; if ($seen) { $prior = $seen.PSObject.Properties[$x.name] }
      if ($prior -and "$($prior.Value.detail)" -eq $detail) {
        $report.ok += [pscustomobject]@{ name = $x.name; detail = "rate-limit wording unchanged since the PAUSE set at $($prior.Value.pausedAt); not re-armed" }
      } else {
        if ($Apply) {
          # 59, not 60: the watchdog ticks every 15 min and phase-locks to itself, so a 60-min
          # window ends ~100 ms AFTER the +60 tick's frozen $now and only the +75 tick clears it
          # (measured 2026-09-10: until minus that tick's start = +64 ms, every occurrence). One
          # minute short lands the end inside the +60 tick.
          & "$PSScriptRoot\pause.ps1" -Reason "rate-limit seen on $($x.name)" -Minutes 59 | Out-Null
          $record = [ordered]@{}
          if ($seen) { foreach ($p in $seen.PSObject.Properties) { $record[$p.Name] = $p.Value } }
          $record[$x.name] = [pscustomobject]@{ detail = $detail; pausedAt = (Now-Iso) }
          [IO.Directory]::CreateDirectory("$FleetHome\state\sentinel") | Out-Null
          Write-Json $signalPath ([pscustomobject]$record)
        }
        $report.pause = "set: rate-limit signal on $($x.name)"
      }
    }
  }
  $state = "$($row.state)"
  if ($state -eq 'blocked') {
    # 'blocked' covers a permission prompt, an AskUserQuestion and a plain wait on a human alike, and the daemon
    # rows (`claude agents --json --all`, verified 2026-08-26: id,cwd,kind,startedAt,sessionId,name,state,pid,status)
    # carry no field that says which. Report it as input-wait of unknown kind with the job's own detail text;
    # never assert a cause this script did not measure. Never respawned: a respawn would discard the prompt.
    # Ticket 84: tenant/role ride along so the Watchdog can decide whether to heal
    # this blocked, possibly-stale session without a second daemon/job-state read
    # for the same row - the mechanical check here still never acts on it itself.
    $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'blocked'; detail = "waiting on input, kind unknown (daemon rows carry no prompt kind); job detail: $($js.detail); not respawned by design"; parent = $x.parent; tenant = $x.tenant; role = $x.role }
    continue
  }
  if ($state -eq 'failed') { Do-Respawn $row $x 'state failed'; continue }
  if ($state -eq 'stopped') { Do-Respawn $row $x 'state stopped'; continue }
  if ($state -eq 'done') {
    if ($x.role -eq 'ic' -and $x.tenant) {
      $t = Read-Json "$FleetHome\tenants\$($x.tenant).json"
      $st = "$((Invoke-BoundedCommand -Command 'gh' -ArgumentList @('issue', 'view', "$($x.issue)", '-R', $t.github, '--json', 'state') -TimeoutSec 30 -Name "gh issue view $($x.issue)").stdout)"   # fleet #101: bounded; a timeout reads as not CLOSED
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
    # fleet #257 Gap A: no heartbeat at all is the one case the age test below cannot see. An IC whose first turn never ended
    # (Get-FirstTurnStaleReason) goes down the same exemption path (skip-list hold, open PR) and then Do-Respawn.
    $firstTurnWhy = $null
    if ($null -eq $age) { $firstTurnWhy = Get-FirstTurnStaleReason $x $row }
    # fleet #149: a busy row is skipped only mid-turn. Busy with nothing but a (leaked)
    # background task in flight is between turns (Get-BusyStanding), and respawns like
    # any stale row; an unreadable job state stays skipped, and the watchdog pages it busy-stale.
    if (($null -ne $age -and $age -gt 120 -and ("$($row.status)" -ne 'busy' -or (Get-BusyStanding $row -QuietMinutes (Get-BusyQuietMinutes)).standing -eq 'background')) -or ($null -ne $firstTurnWhy)) {
      if ($x.role -eq 'ic' -and $x.tenant) {
        $t = Read-Json "$FleetHome\tenants\$($x.tenant).json"
        $skip = Read-Json "$FleetHome\state\skip\$($x.tenant).json"
        if ((Property-Names $skip.issues) -contains "$($x.issue)") {
          $report.ok += [pscustomobject]@{ name = $x.name; detail = "waiting on issue #$($x.issue) skip-list hold" }
          continue
        }

        $headPrefix = "$($t.branchPrefix)$($x.issue)-"
        # fleet #101: bounded and named; a timeout is a failed lookup that says so.
        $prRun = Invoke-BoundedCommand -Command 'gh' -ArgumentList @('pr', 'list', '-R', $t.github, '--state', 'open', '--search', "head:$headPrefix", '--json', 'number,headRefName') -TimeoutSec 30 -Name "gh pr list $($t.github) head:$headPrefix"
        $ghExit = $prRun.exitCode
        $prRaw = @("$($prRun.stdout)".Trim())
        if ($prRun.timedOut) { $prRaw = @('gh pr list timed out after 30s and was killed') }
        elseif ($prRun.startError) { $prRaw = @("gh pr list could not start: $($prRun.startError)") }
        elseif ($ghExit -ne 0) { $prRaw = @("$($prRun.stderr)".Trim(), "$($prRun.stdout)".Trim()) | Where-Object { $_ } }
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
      if ($null -ne $firstTurnWhy) {
        # Shadow-first like #252/#253/#256: the page is raised in every mode; the respawn (through Do-Respawn, so the Gap B bound
        # applies) needs -Apply AND state/flags/ic-cleanup-live. PAUSE does not stop it, as it does not stop the stale-heartbeat respawn.
        $flagPresent = Test-Path -LiteralPath "$FleetHome\state\flags\ic-cleanup-live"
        if (-not $cleanupLive) {
          $outcome = if ($flagPresent) { 'would respawn (read-only run)' } else { 'would respawn (state/flags/ic-cleanup-live absent)' }
        } else {
          $beforeCounts = @(@($report.respawned).Count, @($report.respawnFailed).Count, @($report.respawnDeferred).Count, @($report.respawnHeld).Count)
          Do-Respawn $row $x $firstTurnWhy
          $outcome = if (@($report.respawned).Count -gt $beforeCounts[0]) { 'respawned' }
            elseif (@($report.respawnFailed).Count -gt $beforeCounts[1]) { "respawn failed: $(@($report.respawnFailed)[-1].reason)" }
            elseif (@($report.respawnDeferred).Count -gt $beforeCounts[2]) { "respawn deferred: $(@($report.respawnDeferred)[-1].reason)" }
            elseif (@($report.respawnHeld).Count -gt $beforeCounts[3]) { 'respawn held by the respawn-loop bound' }
            else { 'respawn cancelled (the live roster no longer shows this IC active)' }
        }
        $report.escalate += [pscustomobject]@{ name = $x.name; kind = 'ic-first-turn-stale'; detail = "$firstTurnWhy; $outcome"; parent = $x.parent }
        continue
      }
      Do-Respawn $row $x "heartbeat stale ($([int]$age) min), state=$state status=$($row.status), no open PR"
      continue
    }
    $report.ok += $x.name
    continue
  }
  $report.ok += $x.name
}

# --- fleet #257 Gap B: clear the respawn streak of a name that has recovered or moved on (applying runs only) ---
# An entry goes when the name has no active expected row, its current row is a different job than the entry's (relaunched
# by hand), a heartbeat is newer than its last attempt, or every attempt is outside the window. A name that recorded an
# attempt this tick is left alone (its Get-ExpectedRow still reads the pre-relaunch snapshot). Written only if changed.
if ($Apply -and -not $script:RespawnStreakUnreadable -and $script:RespawnStreak.Count -gt 0) {
  $streakChanged = $false
  foreach ($streakName in @($script:RespawnStreak.Keys)) {
    if ($script:RespawnStreakTouched.ContainsKey($streakName)) { continue }
    $streakEntry = $script:RespawnStreak[$streakName]
    $streakLive = @()
    $streakX = @($expected | Where-Object { $_.name -eq $streakName })[0]
    if ($null -ne $streakX) {
      $streakRow = Get-ExpectedRow $streakX
      if ($streakRow -and "$($streakRow.id)" -eq "$($streakEntry.jobId)") { $streakLive = @(Get-LiveRespawnAttempts $streakName "$($streakEntry.jobId)") }
    }
    if ($streakLive.Count -eq 0) { $script:RespawnStreak.Remove($streakName); $streakChanged = $true }
    elseif ($streakLive.Count -ne @($streakEntry.attempts).Count) { $streakEntry.attempts = @($streakLive); $streakEntry.downAttempts = @(@($streakEntry.downAttempts) | Where-Object { $streakLive -contains $_ }); $streakChanged = $true }
  }
  if ($streakChanged) { Save-RespawnStreak }
}

# --- strays and cap ---
$fleetPattern = '^(dispatcher|sentinel|pl-[a-z0-9-]+|pe-[a-z0-9-]+|ic-[0-9]+)$'
$script:cleanupPendingAt = @{}
try {
  foreach ($cpLine in @(Get-Content -LiteralPath "$FleetHome\state\sentinel\cleanup-pending.jsonl" -Encoding UTF8 -ErrorAction Stop)) {
    $cpObj = $null; try { $cpObj = "$cpLine" | ConvertFrom-Json } catch {}
    if ($cpObj -and $cpObj.PSObject.Properties['jobId'] -and "$($cpObj.jobId)") { $script:cleanupPendingAt["$($cpObj.jobId)"] = "$($cpObj.at)" }
  }
} catch {}
$known = @($expected | ForEach-Object { $_.name })
foreach ($row in ($daemon | Where-Object { $_.pid -and ("$($_.name)" -match $fleetPattern) -and ($known -notcontains $_.name) -and -not $script:orphanJobIds.ContainsKey("$($_.id)") })) {
  $foreign = Get-ForeignRosterRoot $row
  if ($foreign) {
    $report.ok += [pscustomobject]@{ name = $row.name; detail = "another fleet root's session (job $($row.id), rostered by $foreign); not this root's to supervise" }
    continue
  }
  # fleet #265: a job retire.ps1 queued in cleanup-pending.jsonl (the claude CLI was missing when it retired the row) is a known cause.
  $strayCause = if ($script:cleanupPendingAt.ContainsKey("$($row.id)")) { "retire could not remove it (claude CLI missing at $($script:cleanupPendingAt["$($row.id)"])); cleanup pending" } else { 'cause not measured: launched outside launch.ps1, or its roster entry was lost or retired while the process lived' }
  $report.escalate += [pscustomobject]@{ name = $row.name; kind = 'stray'; detail = "fleet-named session not on the roster (job $($row.id)); $strayCause" }
}
$liveFleet = @($daemon | Where-Object { $_.pid -and ($known -contains $_.name) })
# The cap counts what the door counts: cap-exempt names (config/cycle.json cap.exemptNamePrefixes, the Principal) are outside it.
$capCounted = @($liveFleet | Where-Object { -not (Test-CapExempt "$($_.name)") })
if ($capCounted.Count -gt [int]$static.cap) { $report.escalate += [pscustomobject]@{ name = 'fleet'; kind = 'cap-exceeded'; detail = "$($capCounted.Count) live fleet sessions, cap $($static.cap)" } }

# --- fleet #256 AC2: a stranded reservation ---
# launch.ps1 leaves an `assigned` Work record behind on several pre-launch refusals (a gh failure, a fetch failure,
# an assignment-count refusal): no roster row, no job, no invalidation marker, and the planner keeps excluding
# the issue as reserved (live 2026-09-30: nidus:issue-7, assigned rev 1 since 09-29T18:55Z). A record is stranded
# when ALL of these hold: state assigned with a manifestPath; its reservation is older than
# watchdog.strandedReservationHours (default 6), measured from the record's updatedAt (an assigned record is only
# written at reserve time, and unlike createdAt it is restamped when a released unit is reserved again); no
# active|retiring roster row names its tenant and issue; no job (a daemon row or any job state under
# ~/.claude/jobs) has an intent naming its manifest file; and neither <manifest>.invalidated.json nor
# <manifest>.acknowledged.json exists. The page is raised in every mode and reads as information (a lead may be
# holding the unit behind its cap). Releasing (Invoke-ManifestRelease, the helper the dead-before-ack retire uses)
# needs -Apply AND state/flags/ic-cleanup-live, is deferred under PAUSE, and is guarded against a launch in flight:
# the record must have been classified stranded on the PREVIOUS tick too (state/sentinel/stranded-seen.json keeps
# first/last-seen per record id; a gap over an hour restarts the count), and every leg is re-read fresh (roster,
# daemon list, job intents, markers, the record's state and revision) right before the release.
# An unreadable state/work/active.json or roster classifies nothing.
function Get-AllJobIntents {
  # Lower-cased intents of every job the daemon lists or ~/.claude/jobs holds; a state that will not read is skipped.
  param($DaemonRows)
  $intents = @()
  $jobIds = @($DaemonRows | ForEach-Object { "$($_.id)" } | Where-Object { $_ })
  $jobsDir = Join-Path $env:USERPROFILE '.claude\jobs'
  if (Test-Path -LiteralPath $jobsDir) { $jobIds += @(Get-ChildItem -LiteralPath $jobsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }
  foreach ($jid in @($jobIds | Select-Object -Unique)) {
    try { $jst = Get-JobState $jid; if ($jst -and $jst.PSObject.Properties['intent'] -and $jst.intent) { $intents += ("$($jst.intent)").ToLowerInvariant() } } catch {}
  }
  return ,@($intents)
}
function Test-StrandedLegs {
  # The marker / roster / job legs of the stranded predicate against the given roster rows and job intents.
  param($Rec, $RosterRows, $JobIntents)
  $mp = "$($Rec.manifestPath)"
  if ((Test-Path -LiteralPath "$mp.invalidated.json") -or (Test-Path -LiteralPath "$mp.acknowledged.json")) { return $false }
  $claimed = @($RosterRows | Where-Object { "$($_.status)" -in @('active', 'retiring') -and "$($_.tenant)" -eq "$($Rec.tenant)" -and "$($_.issue)" -eq "$($Rec.issue)" })
  if ($claimed.Count -gt 0) { return $false }
  $leaf = (Split-Path -Leaf $mp).ToLowerInvariant()
  if (@($JobIntents | Where-Object { $_.Contains($leaf) }).Count -gt 0) { return $false }
  return $true
}
function Read-ActiveWorkStrict {
  $path = Join-Path $FleetHome 'state\work\active.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $a = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if ($null -eq $a) { throw 'empty active.json' }
  return $a
}
$strandedSeenPath = Join-Path $FleetHome 'state\sentinel\stranded-seen.json'
$activeWork = $null; $activeWorkUnreadable = $false
try { $activeWork = Read-ActiveWorkStrict } catch { $activeWorkUnreadable = $true; $activeWork = $null }
if ($activeWorkUnreadable) { $report.ok += [pscustomobject]@{ name = 'work-state-read'; detail = 'state/work/active.json unreadable; stranded-reservation check skipped' } }
elseif (-not $rosterUnreadable -and $null -ne $activeWork -and $activeWork.PSObject.Properties['records'] -and $null -ne $activeWork.records) {
  $seenBefore = @{}
  try { $sf = Read-Json $strandedSeenPath; if ($sf) { foreach ($p in $sf.PSObject.Properties) { $seenBefore[$p.Name] = $p.Value } } } catch {}
  $seenNow = [ordered]@{}
  $jobIntents = $null   # loaded once, only when a record gets past the cheap tests
  foreach ($prop in @($activeWork.records.PSObject.Properties)) {
    $rec = $prop.Value
    if ("$($rec.state)" -ne 'assigned' -or -not "$($rec.manifestPath)") { continue }
    $reservedAt = ConvertTo-UtcDateTime $(if ($rec.PSObject.Properties['updatedAt'] -and $rec.updatedAt) { $rec.updatedAt } else { $rec.createdAt })
    if ($null -eq $reservedAt) { continue }
    $ageHours = ($now - $reservedAt).TotalHours
    if ($ageHours -le $script:StrandedReservationHours) { continue }
    $manifestPath = "$($rec.manifestPath)"
    if ($null -eq $jobIntents) { $jobIntents = Get-AllJobIntents $daemon }
    if (-not (Test-StrandedLegs $rec $rosterRows $jobIntents)) { continue }
    # Stranded this tick. Has the PREVIOUS tick classified it stranded too (same manifest and revision, within the last hour)?
    $prior = $seenBefore["$($rec.id)"]
    # A prior sighting counts only when it is at least 10 minutes old (measured from the FIRST sighting, which is
    # kept while the sightings stay unbroken), so two runs seconds apart cannot arm a release.
    $priorValid = $false; $seenPrev = $false
    if ($prior -and "$($prior.manifest)" -eq $manifestPath -and "$($prior.revision)" -eq "$($rec.revision)") {
      $lastSeen = ConvertTo-UtcDateTime $prior.lastSeen
      if ($null -ne $lastSeen -and ($now - $lastSeen).TotalMinutes -le 60) { $priorValid = $true }
    }
    $firstSeen = if ($priorValid -and $prior.firstSeen) { "$($prior.firstSeen)" } else { $now.ToString('o') }
    if ($priorValid) {
      $firstSeenUtc = ConvertTo-UtcDateTime $firstSeen
      if ($null -ne $firstSeenUtc -and ($now - $firstSeenUtc).TotalMinutes -ge 10) { $seenPrev = $true }
    }
    $seenNow["$($rec.id)"] = [ordered]@{ firstSeen = $firstSeen; lastSeen = $now.ToString('o'); manifest = $manifestPath; revision = $rec.revision }
    $strandedParent = ''
    try { $mf = Read-Json $manifestPath; if ($mf -and $mf.PSObject.Properties['parent'] -and $mf.parent) { $strandedParent = "$($mf.parent)" } } catch {}
    $reason = "stranded reservation: assigned since $($reservedAt.ToString('o')) with no roster row, no job and no marker"
    $outcome = 'would release (state/flags/ic-cleanup-live absent)'
    if (-not $Apply -and (Test-Path -LiteralPath "$FleetHome\state\flags\ic-cleanup-live")) { $outcome = 'would release (read-only run)' }
    if ($cleanupLive) {
      if (Test-Paused) {
        $outcome = 'release deferred: PAUSE is set'
      } elseif (-not $seenPrev) {
        $outcome = 'first sighting; releases on a later tick (once the first sighting is 10 minutes old) if it is still stranded'
      } else {
        # Fresh re-read of every leg right before acting (the dead-before-ack rule): a launch in flight must win.
        $still = $false
        try {
          $freshRoster = @((Get-Content -LiteralPath $rosterPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop).sessions)
          $freshDaemon = Get-DaemonSessions -All -Strict
          $freshActive = Read-ActiveWorkStrict
          $freshRecProp = $freshActive.records.PSObject.Properties["$($rec.id)"]
          if ($null -ne $freshRecProp -and "$($freshRecProp.Value.state)" -eq 'assigned' -and "$($freshRecProp.Value.revision)" -eq "$($rec.revision)" -and "$($freshRecProp.Value.manifestPath)" -eq $manifestPath) {
            $still = Test-StrandedLegs $freshRecProp.Value $freshRoster (Get-AllJobIntents $freshDaemon)
          }
        } catch { $still = $false }
        if (-not $still) {
          $outcome = 'release cancelled: the fresh re-read no longer shows it stranded'
        } else {
          $release = Invoke-ManifestRelease -Manifest $manifestPath -WorkRecordId "$($rec.id)" -Reason $reason
          $entry = [pscustomobject]@{ recordId = "$($rec.id)"; tenant = "$($rec.tenant)"; issue = $rec.issue; manifest = $manifestPath; reservedAt = $reservedAt.ToString('o'); firstSeenStranded = $firstSeen; ageHours = [math]::Round($ageHours, 1); release = $release }
          if ($release.ok) { $outcome = 'released'; $report.strandedReleased += $entry; $seenNow.Remove("$($rec.id)") }
          else { $outcome = "release failed: $($release.code) ($($release.detail))"; $report.strandedReleaseFailed += $entry }
        }
      }
    }
    $report.escalate += [pscustomobject]@{ name = "$($rec.id)"; kind = 'reservation-stranded'; detail = "Work record $($rec.id) reserved $([int]$ageHours) h with no session (a lead may be holding it behind the cap): no roster row for $($rec.tenant) issue #$($rec.issue), no job naming $((Split-Path -Leaf $manifestPath)) and no invalidation or ack marker (assigned since $($reservedAt.ToString('o')), limit $($script:StrandedReservationHours) h); $outcome"; parent = $strandedParent }
  }
  # Remembered only by an applying run: a hand read-only run must not arm a release for the next applying tick.
  if ($Apply) { try {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $strandedSeenPath)) | Out-Null
    Write-Json $strandedSeenPath ([pscustomobject]$seenNow)
  } catch { Write-Warning "stranded-seen write failed: $($_.Exception.Message)" } }
}

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
    if ($res.escalate) {
      # 2026-09-18 QA (merge seam #87/#77): sync-integration.ps1 emits kind
      # 'sync-refused' (with pushError, no reason) for a refused push, distinct
      # from 'branch-diverged' (reason, no pushError) - hardcoding 'branch-
      # diverged' here made config/cycle.json pages.priority["sync-refused"]
      # dead, dropped it from supervisor.pageKinds, AND emptied the page body
      # (Get-OneLine $null) for a refused push, which Pushover rejects with a
      # 400 - a push refused by branch protection paged nothing at all.
      $syncKind = if ($res.PSObject.Properties['kind'] -and $res.kind) { "$($res.kind)" } else { 'branch-diverged' }
      $syncDetail = if ($res.PSObject.Properties['reason'] -and $res.reason) { "$($res.reason)" }
        elseif ($res.PSObject.Properties['pushError'] -and $res.pushError) { "push refused: $($res.pushError)" }
        elseif ($res.PSObject.Properties['prUrl'] -and $res.prUrl) { "$($res.prUrl)" }
        else { "$syncKind for tenant $($t.name) (no further detail reported)" }
      $report.escalate += [pscustomobject]@{ name = "pl-$($t.name)"; kind = $syncKind; detail = $syncDetail; parent = 'dispatcher' }
      # fleet #274: an unattested tip's page links its reconciliation PR (the Watchdog reads `url`).
      if ($syncKind -eq 'sync-unattested' -and $res.PSObject.Properties['prUrl'] -and $res.prUrl) { $report.escalate[-1] | Add-Member -NotePropertyName url -NotePropertyValue "$($res.prUrl)" -Force }
    }
  }
}

# --- fleet #265: cleanup-pending ---
# retire.ps1 writes one line here when the claude CLI was missing (an npm auto-update window) and so could
# not stop/rm the job: the roster already says retired, the job and its worktrees were left untouched.
# Acting needs -Apply AND state/flags/ic-cleanup-live, like the other cleanup passes (shadow-first): the job is
# stopped and removed (each verified by a strict re-read), then each listed worktree is removed only when
# `git status --porcelain` is empty. A line that finishes is dropped; any other keeps its line with attempts+1,
# and from the third attempt the kind `cleanup-pending` (normal priority) is escalated. A read-only run
# reports what it would do and writes nothing.
$cleanupPendingPath = "$FleetHome\state\sentinel\cleanup-pending.jsonl"
$report.cleanupPending = @()
if (Test-Path -LiteralPath $cleanupPendingPath) {
  $cpRawLines = @(Get-Content -LiteralPath $cleanupPendingPath -Encoding UTF8 | Where-Object { "$_".Trim() })
  $cpKept = New-Object System.Collections.ArrayList
  $cpChanged = $false
  foreach ($cpRaw in $cpRawLines) {
    $cp = $null; try { $cp = $cpRaw | ConvertFrom-Json } catch {}
    if (-not $cp) {
      [void]$cpKept.Add($cpRaw)
      $report.ok += [pscustomobject]@{ name = 'cleanup-pending'; detail = 'a line in state/sentinel/cleanup-pending.jsonl did not parse and was kept untouched' }
      continue
    }
    $cpAttempts = if ($cp.PSObject.Properties['attempts'] -and "$($cp.attempts)" -match '^\d+$') { [int]$cp.attempts } else { 0 }
    $cpWorktrees = @(@($cp.worktrees) | Where-Object { $_ })
    # A line older than 7 days is not acted on: the job or its worktree may long since belong to something else.
    # It is kept and escalated (in every mode: a page is not an action) until a human drops it.
    $cpAt = ConvertTo-UtcDateTime $cp.at
    if ($cpAt -and ($now - $cpAt).TotalDays -gt 7) {
      [void]$cpKept.Add($cpRaw)
      $report.cleanupPending += [pscustomobject]@{ name = "$($cp.name)"; jobId = "$($cp.jobId)"; attempts = $cpAttempts; outcome = "stale: queued $($cp.at), more than 7 days ago; not acted on" }
      $report.escalate += [pscustomobject]@{ name = "$($cp.name)"; kind = 'cleanup-pending'; detail = "stale entry, check by hand: retire of $($cp.name) queued job $($cp.jobId) (and worktrees: $($cpWorktrees -join ', ')) for cleanup at $($cp.at), more than 7 days ago; not acted on. Verify what still exists, finish by hand, then drop its line from state/sentinel/cleanup-pending.jsonl"; parent = 'dispatcher' }
      continue
    }
    if (-not $cleanupLive) {
      $cpWhyNot = if (Test-Path -LiteralPath "$FleetHome\state\flags\ic-cleanup-live") { 'read-only run' } else { 'state/flags/ic-cleanup-live absent' }
      $report.cleanupPending += [pscustomobject]@{ name = "$($cp.name)"; jobId = "$($cp.jobId)"; attempts = $cpAttempts; outcome = "would stop and remove job $($cp.jobId) and $($cpWorktrees.Count) worktree(s) when clean ($cpWhyNot)" }
      [void]$cpKept.Add($cpRaw)
      # The flag is off in production, so a line nobody acts on would never reach a human. With the flag absent the pass escalates it,
      # without acting (the report only; the watchdog dedupes by name + kind, so once per line). A read-only run with the flag on is
      # about to be acted on by the next -Apply and stays quiet.
      if (-not (Test-Path -LiteralPath "$FleetHome\state\flags\ic-cleanup-live")) {
        $report.escalate += [pscustomobject]@{ name = "$($cp.name)"; kind = 'cleanup-pending'; detail = "retire of $($cp.name) left job $($cp.jobId) for cleanup (the claude CLI was missing) and state/flags/ic-cleanup-live is off, so nothing will act on it: finish by hand (claude stop/rm $($cp.jobId), then its worktrees: $($cpWorktrees -join ', ')) and drop its line from state/sentinel/cleanup-pending.jsonl, or turn the flag on"; parent = 'dispatcher' }
      }
      continue
    }
    $cpFailure = $null
    try {
      $cpJob = "$($cp.jobId)"
      if ($cpJob) {
        try { $null = Invoke-ClaudeCli -Arguments @('stop', $cpJob) } catch { throw "claude stop could not run: $($_.Exception.Message)" }
        if (-not (Test-JobStopped -Id $cpJob)) { throw "job $cpJob still had a pid after claude stop" }
        try { $null = Invoke-ClaudeCli -Arguments @('rm', $cpJob) } catch { throw "claude rm could not run: $($_.Exception.Message)" }
        if (-not (Test-JobRemoved -Id $cpJob)) { throw "job $cpJob still listed after claude rm" }
      }
      # A worktree another session now owns is left alone (the same path is relaunched for the next attempt at an issue):
      # an active|retiring roster row of the same name, or naming that worktree as its cwd, or a live daemon row whose cwd is it.
      $cpNorm = { param($x) ("$x" -replace '/', '\').TrimEnd('\').ToLowerInvariant() }
      # A strict read, janitor's rule: a roster that is missing, empty (mid-write) or unparseable shows no claims at all, and
      # "nobody claims it" off that reading would remove a live session's worktree. It blocks every removal instead.
      $cpRosterNow = @()
      if ($cpWorktrees.Count -gt 0) {
        $cpRosterRaw = $null
        try { $cpRosterRaw = Get-Content -LiteralPath $rosterPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch {}
        if ($null -eq $cpRosterRaw -or -not $cpRosterRaw.PSObject.Properties['sessions']) { throw 'state/roster.json is missing, empty or unreadable; worktree removal blocked because no claim can be seen' }
        $cpRosterNow = @($cpRosterRaw.sessions | Where-Object { "$($_.status)" -in @('active', 'retiring') })
      }
      $cpDaemonNow = @(Get-DaemonSessions -All -Strict | Where-Object { $_.pid -and "$($_.id)" -ne $cpJob })
      $cpClaimedBy = {
        param($wtPath)
        $w = & $cpNorm $wtPath
        $under = { param($c) $n = & $cpNorm $c; $n -and ($n -eq $w -or $n.StartsWith($w + '\')) }
        foreach ($rr in $cpRosterNow) {
          if ("$($rr.name)" -eq "$($cp.name)") { return "active roster row $($rr.name) (job $($rr.jobId))" }
          if (& $under $rr.cwd) { return "active roster row $($rr.name) (cwd is the worktree)" }
        }
        foreach ($dr in $cpDaemonNow) { if ($dr.PSObject.Properties['cwd'] -and (& $under $dr.cwd)) { return "live session $($dr.name) (job $($dr.id), cwd is the worktree)" } }
        return $null
      }
      $cpLeftAlone = @()
      $cpRepoRoot = $null
      if ($cp.cwd) { $cpRepoRoot = if ("$($cp.cwd)" -match '^(.+?)[\\/]\.claude[\\/]worktrees[\\/]') { $Matches[1] } else { "$($cp.cwd)" } }
      foreach ($cpWt in $cpWorktrees) {
        if (-not (Test-Path -LiteralPath $cpWt)) { continue }
        $cpClaim = & $cpClaimedBy $cpWt
        if ($cpClaim) { $cpLeftAlone += "worktree $cpWt claimed by $cpClaim, left alone"; continue }
        $cpStatus = Invoke-BoundedCommand -Command 'git' -ArgumentList @('-C', "$cpWt", 'status', '--porcelain') -TimeoutSec 30 -Name "git status $cpWt"
        if ($cpStatus.startError -or $cpStatus.timedOut -or $cpStatus.exitCode -ne 0) { throw "worktree $cpWt status unreadable: $(Get-OneLineText "$($cpStatus.startError)$($cpStatus.stderr)")" }
        if ("$($cpStatus.stdout)".Trim()) { throw "worktree $cpWt has uncommitted changes; kept" }
        if (-not $cpRepoRoot) { throw "worktree $cpWt cannot be removed: the pending line has no cwd" }
        $cpBranch = "$((Invoke-BoundedCommand -Command 'git' -ArgumentList @('-C', "$cpWt", 'rev-parse', '--abbrev-ref', 'HEAD') -TimeoutSec 30 -Name "git rev-parse $cpWt").stdout)".Trim()
        [void](Invoke-BoundedCommand -Command 'git' -ArgumentList @('-C', $cpRepoRoot, 'worktree', 'unlock', "$cpWt") -TimeoutSec 30 -Name "git worktree unlock $cpWt")
        [void](Invoke-BoundedCommand -Command 'git' -ArgumentList @('-C', $cpRepoRoot, 'worktree', 'remove', '--force', "$cpWt") -TimeoutSec 60 -Name "git worktree remove $cpWt")
        if (Test-Path -LiteralPath $cpWt) { throw "worktree $cpWt still present after git worktree remove" }
        if ($cpBranch -like 'worktree-*') { [void](Invoke-BoundedCommand -Command 'git' -ArgumentList @('-C', $cpRepoRoot, 'branch', '-D', $cpBranch) -TimeoutSec 30 -Name "git branch -D $cpBranch") }
      }
    } catch { $cpFailure = Get-OneLineText "$($_.Exception.Message)" }
    if (-not $cpFailure) {
      $cpChanged = $true
      $report.cleanupPending += [pscustomobject]@{ name = "$($cp.name)"; jobId = "$($cp.jobId)"; attempts = $cpAttempts; outcome = "cleaned: job $($cp.jobId) stopped and removed, $($cpWorktrees.Count) worktree(s) handled$(if ($cpLeftAlone.Count -gt 0) { '; ' + ($cpLeftAlone -join '; ') })" }
      continue
    }
    $cpAttempts++
    $cp | Add-Member -NotePropertyName attempts -NotePropertyValue $cpAttempts -Force
    $cp | Add-Member -NotePropertyName lastAttemptAt -NotePropertyValue (Now-Iso) -Force
    $cp | Add-Member -NotePropertyName lastError -NotePropertyValue $cpFailure -Force
    [void]$cpKept.Add(($cp | ConvertTo-Json -Compress -Depth 6))
    $cpChanged = $true
    $report.cleanupPending += [pscustomobject]@{ name = "$($cp.name)"; jobId = "$($cp.jobId)"; attempts = $cpAttempts; outcome = "failed: $cpFailure" }
    if ($cpAttempts -ge 3) {
      $report.escalate += [pscustomobject]@{ name = "$($cp.name)"; kind = 'cleanup-pending'; detail = "retire of $($cp.name) left job $($cp.jobId) for cleanup (the claude CLI was missing) and $cpAttempts attempts have not finished it: $cpFailure; finish by hand (claude stop/rm $($cp.jobId), then its worktrees: $($cpWorktrees -join ', ')), then drop its line from state/sentinel/cleanup-pending.jsonl"; parent = 'dispatcher' }
    }
  }
  if ($cpChanged) {
    # retire.ps1 appends to this file at any time: re-read it just before writing and keep every line this pass never saw.
    try { foreach ($cpNow in @(Get-Content -LiteralPath $cleanupPendingPath -Encoding UTF8 | Where-Object { "$_".Trim() })) { if ($cpRawLines -notcontains $cpNow) { [void]$cpKept.Add($cpNow) } } } catch {}
    if ($cpKept.Count -gt 0) { [IO.File]::WriteAllText($cleanupPendingPath, (($cpKept -join [Environment]::NewLine) + [Environment]::NewLine), $Utf8) }
    else { Remove-Item -LiteralPath $cleanupPendingPath -Force -ErrorAction SilentlyContinue }
  }
}

# --- worktree sweep: merged fleet branches older than 7 days ---
foreach ($tf in (Get-ChildItem "$FleetHome\tenants" -Filter *.json)) {
  $t = Read-Json $tf.FullName
  if (-not (Test-Path $t.repo)) { continue }
  # fleet #101: the sweep's git reads are bounded and named (the removals under -Apply are a mutating door and are not killed mid-way).
  $wt = ("$((Invoke-BoundedCommand -Command 'git' -ArgumentList @('-C', $t.repo, 'worktree', 'list', '--porcelain') -TimeoutSec 30 -Name "git worktree list $($t.name)").stdout)" -replace "`r", '') -split "`n`n"
  foreach ($blk in $wt) {
    if ($blk -notmatch 'worktree (.+)') { continue }
    $path = $Matches[1].Trim()
    if ($path -notmatch '[\\/]\.claude[\\/]worktrees[\\/]') { continue }
    if ($blk -notmatch 'branch refs/heads/(.+)') { continue }
    $br = $Matches[1].Trim()
    $mergedList = "$((Invoke-BoundedCommand -Command 'git' -ArgumentList @('-C', $t.repo, 'branch', '--merged', $t.defaultBranch) -TimeoutSec 30 -Name "git branch --merged $($t.name)").stdout)"
    $merged = $mergedList -match [regex]::Escape($br)
    $lastTs = "$((Invoke-BoundedCommand -Command 'git' -ArgumentList @('-C', $t.repo, 'log', '-1', '--format=%ct', $br) -TimeoutSec 30 -Name "git log $br").stdout)".Trim()
    $ageDays = 0
    if ($lastTs) { $ageDays = ($now - [DateTimeOffset]::FromUnixTimeSeconds([long]$lastTs).UtcDateTime).TotalDays }
    if ($merged -and $ageDays -gt 7 -and ($blk -notmatch 'locked')) {
      if ($Apply) { & git -C $t.repo worktree remove --force $path 2>$null; & git -C $t.repo branch -D $br 2>$null }
      $report.worktrees += [pscustomobject]@{ tenant = $t.name; path = $path; branch = $br; ageDays = [int]$ageDays }
    }
  }
}

if (-not $ReportPath) { $ReportPath = "$FleetHome\state\sentinel\last-check.json" }
$report.timeouts = @($script:BoundedTimeouts)   # fleet #101: named timeouts reach the watchdog's shadow line
Write-Json $ReportPath ([pscustomobject]$report)
Write-AppliedLedger $report
[pscustomobject]$report | ConvertTo-Json -Depth 6
