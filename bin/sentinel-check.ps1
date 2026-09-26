<#
.SYNOPSIS  The Sentinel's mechanical check. Prints a JSON report; -Apply performs the mechanical actions.
  Applied with -Apply: respawn (failed / stopped / reaped-while-on-roster / stuck), retire (IC done + issue closed),
  worktree sweep (merged fleet branches, >7 days, unlocked), PAUSE on a rate-limit signal, clear a PAUSE it set once its window passes.
  Only reported: launchNeeded, escalate (blocked / stray / cap exceeded / vanished IC). The Sentinel session acts on those.
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
      respawned = @($Report.respawned); respawnFailed = @($Report.respawnFailed); respawnDeferred = @($Report.respawnDeferred); launchNeeded = @($Report.launchNeeded); escalate = @($Report.escalate)
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
    respawned = @(); respawnFailed = @(); respawnDeferred = @(); launchNeeded = @(); escalate = @(); retired = @(); worktrees = @(); sync = @(); pause = $null; ok = @()
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
    respawned = @(); respawnFailed = @(); respawnDeferred = @(); launchNeeded = @(); escalate = @(); retired = @(); worktrees = @(); sync = @(); pause = $null
    ok = @([pscustomobject]@{ name = 'daemon-read'; detail = 'session list unreadable; proposing nothing this tick (a bad read must not look like an empty fleet)' })
  }
  if (-not $ReportPath) { $ReportPath = "$FleetHome\state\sentinel\last-check.json" }
  Write-Json $ReportPath ([pscustomobject]$errorReport)
  Write-AppliedLedger $errorReport
  [pscustomobject]$errorReport | ConvertTo-Json -Depth 6
  exit 0
}
$report = [ordered]@{ at = (Now-Iso); applied = [bool]$Apply; respawned = @(); respawnFailed = @(); respawnDeferred = @(); launchNeeded = @(); escalate = @(); retired = @(); worktrees = @(); sync = @(); pause = $null; ok = @() }

function Latest-Row { param($name) $daemon | Where-Object { $_.name -eq $name } | Sort-Object startedAt -Descending | Select-Object -First 1 }
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
  param([string]$Name, $PreviousPid)
  $deadline = (Get-Date).AddMilliseconds($script:RespawnVerifyBoundMs)
  do {
    try {
      $after = Get-DaemonSessions -All -Strict
      $row = $after | Where-Object { $_.name -eq $Name } | Sort-Object startedAt -Descending | Select-Object -First 1
      if ($row -and $row.pid -and ("$($row.pid)" -ne "$PreviousPid")) { return $true }
    } catch {
      # unreadable this poll: fall through to the bound, never treated as success
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
function Do-Relaunch {
  param($row, $entry, $reason)
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
  if ($row.pid) { & claude stop $row.id 2>&1 | Out-Null }
  # Hashtable splat (rotate.ps1's lesson: PS 5.1 array splatting passes '-FromRoster' as a value).
  $launchArgs = @{ FromRoster = "$($entry.name)" }
  # A hand-set -Model on the roster row survives the relaunch (launch.ps1's ValidateSet tokens only).
  $rosterModel = "$(@((Get-LiveRoster).sessions | Where-Object { $_.name -eq $entry.name -and "$($_.status)" -eq 'active' } | Select-Object -Last 1).model)"
  if ($rosterModel -in @('sonnet', 'opus', 'haiku', 'fable', 'opus-5.5') -and $rosterModel -ne (Resolve-LaunchModel -Role "$($entry.role)" -Model '').token) { $launchArgs.Model = $rosterModel }
  $out = & "$PSScriptRoot\launch.ps1" @launchArgs 2>&1 | Out-String
  $launch = ConvertFrom-LastJsonLine $out
  if ($launch -and $launch.launched) {
    $script:report.respawned += [pscustomobject]@{ name = $row.name; jobId = "$($launch.jobId)"; previousJobId = $row.id; parent = $entry.parent; reason = $reason; via = 'launch' }
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
  & claude respawn $row.id 2>&1 | Out-Null
  if (Test-RespawnVerified -Name $row.name -PreviousPid $row.pid) {
    $script:report.respawned += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = $reason }
  } else {
    # Feeds the existing launch-retry cap exactly as a failed launch would: this
    # session's next daemon row is what the watchdog's retry-storm scan reads, and a
    # no-op respawn leaves that row exactly as it was - unmasked here, never reported
    # as an applied success.
    $script:report.respawnFailed += [pscustomobject]@{ name = $row.name; jobId = $row.id; parent = $entry.parent; reason = "respawn did not change the daemon pid (was $($row.pid)): $reason" }
  }
}

function Property-Names { param($obj) if ($null -eq $obj) { return @() }; return @($obj.PSObject.Properties.Name) }

# --- roster sessions: static (always expected) + active ICs ---
$expected = @()
foreach ($s in (Get-ExpectedStaticSessions $static)) { $expected += [pscustomobject]@{ name = $s.name; role = $s.role; parent = $s.parent; tenant = $s.tenant; issue = $null; static = $true } }
foreach ($e in ($live.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' })) { $expected += [pscustomobject]@{ name = $e.name; role = $e.role; parent = $e.parent; tenant = $e.tenant; issue = $e.issue; static = $false } }

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
    $row = Latest-Row $HealRespawn
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
  # Wordings seen live: "rate limit", "usage limit", "You've hit your session limit · resets 5:50pm"
  # (2026-09-01: the last one matched nothing, so no PAUSE was set and the watchdog paged
  # fleet-dead during a plain Max-plan window).
  if ($detail -match 'rate.?limit|usage limit|session limit|limit reached|resets? (at|\d)') {
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
    # fleet #149: a busy row is skipped only mid-turn. Busy with nothing but a (leaked)
    # background task in flight is between turns (Get-BusyStanding), and respawns like
    # any stale row; an unreadable job state stays skipped, and the watchdog pages it busy-stale.
    if ($null -ne $age -and $age -gt 120 -and ("$($row.status)" -ne 'busy' -or (Get-BusyStanding $row -QuietMinutes (Get-BusyQuietMinutes)).standing -eq 'background')) {
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
      Do-Respawn $row $x "heartbeat stale ($([int]$age) min), state=$state status=$($row.status), no open PR"
      continue
    }
    $report.ok += $x.name
    continue
  }
  $report.ok += $x.name
}

# --- strays and cap ---
$fleetPattern = '^(dispatcher|sentinel|pl-[a-z0-9-]+|pe-[a-z0-9-]+|ic-[0-9]+)$'
$known = @($expected | ForEach-Object { $_.name })
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
foreach ($row in ($daemon | Where-Object { $_.pid -and ("$($_.name)" -match $fleetPattern) -and ($known -notcontains $_.name) })) {
  $foreign = Get-ForeignRosterRoot $row
  if ($foreign) {
    $report.ok += [pscustomobject]@{ name = $row.name; detail = "another fleet root's session (job $($row.id), rostered by $foreign); not this root's to supervise" }
    continue
  }
  $report.escalate += [pscustomobject]@{ name = $row.name; kind = 'stray'; detail = "fleet-named session not on the roster (job $($row.id)); cause not measured: launched outside launch.ps1, or its roster entry was lost or retired while the process lived" }
}
$liveFleet = @($daemon | Where-Object { $_.pid -and ($known -contains $_.name) })
# The cap counts what the door counts: cap-exempt names (config/cycle.json cap.exemptNamePrefixes, the Principal) are outside it.
$capCounted = @($liveFleet | Where-Object { -not (Test-CapExempt "$($_.name)") })
if ($capCounted.Count -gt [int]$static.cap) { $report.escalate += [pscustomobject]@{ name = 'fleet'; kind = 'cap-exceeded'; detail = "$($capCounted.Count) live fleet sessions, cap $($static.cap)" } }

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
    }
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
