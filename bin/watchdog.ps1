<#
.SYNOPSIS  Ticket 08a: scheduled shadow supervisor + external page path + launch retry cap.
  Runs the Sentinel's mechanical check WITHOUT -Apply, logs the proposed action set to
  state/sentinel/shadow/ for the 08b parity comparison, and pages Cory (Windows toast +
  a red banner status.ps1 prints first) ONLY when the fleet's self-healing is itself the
  casualty: the check cannot run or report, fleet state is unreadable, the Sentinel
  heartbeat is stale, every static heartbeat is stale, or a launch retry storm is
  detected (>= 2 consecutive failed launches of one name inside a 24h window ->
  skip-hold + one page). While the rostered Sentinel is enabled it never acts on the fleet
  and never pages what the live Sentinel will handle itself. Zero Claude turns.
  Registered by install-watchdog-task.ps1.

  Ticket 08b (live mode): once state/flags/sentinel-off stands (cutover-sentinel.ps1)
  and no Sentinel session is running, the same run IS the supervisor: the check runs
  with -Apply (respawns, retirements, sweeps, rate-limit PAUSE; ledger actor
  'watchdog'), missing static sessions are launched through launch.ps1 -FromRoster
  (never under a PAUSE), a respawn files an escalation
  naming the parent, and check escalations of the configured kinds
  (config/cycle.json supervisor.pageKinds) page once per new name:kind as a banner
  condition plus one escalation file. `blocked` is recorded, never paged: the daemon's
  label is a summary of a session's last line, not a measured wait. A Sentinel session
  running under the flag is the double-actor condition: page, stay in shadow.
#>
[CmdletBinding()]
param(
  [switch]$Verify,   # compute and print only: no fleet-state writes, no toast (the shadowed check still fetches)
  [switch]$NoToast   # write state but never toast (tests)
)

try {
  . "$PSScriptRoot\_common.ps1"
  # Entry point: never inherit a caller's Stop preference - PS 5.1 wraps native stderr
  # in ErrorRecords, and under Stop a mere gh/git stderr line would terminate the run.
  $ErrorActionPreference = 'Continue'
  $now = (Get-Date).ToUniversalTime()
  $staleMinutes = 45        # three missed 15-min Sentinel crons; the dispatcher uses the same threshold
  $retryCap = 2
  $retryWindowHours = 24    # daemon job history is forever; only recent failures are a storm
  $checkTimeoutSec = 180    # live check measures ~4s; gh/git slowness gets margin, a wedge gets a page

  function Get-HeartbeatAgeMinutes {
    # $null = no heartbeat recorded; unparseable or future-dated (skew) = stale, never fatal.
    param($Name)
    $hb = $null
    try { $hb = Read-Json "$FleetHome\state\heartbeats\$Name.json" } catch { return 99999 }
    if (-not $hb) { return $null }
    $at = ConvertTo-UtcDateTime $hb.at
    if ($null -eq $at) { return 99999 }
    $age = (New-TimeSpan -Start $at -End $now).TotalMinutes
    if ($age -lt -5) { return 99999 }
    return $age
  }

  function Get-OneLine { param($Text, $Max = 200)
    $s = ("$Text" -replace '\s+', ' ').Trim()
    if ($s.Length -gt $Max) { $s = $s.Substring(0, $Max) + '...' }
    return $s
  }

  # --- mode (ticket 08b). Shadow while the rostered Sentinel is enabled. Live only when
  # --- state/flags/sentinel-off stands AND no Sentinel session is running: two actors on
  # --- one fleet is the one thing cutover must never produce, so a running Sentinel under
  # --- the flag pages (double-actor) and this run stays in shadow. -Verify never applies.
  $supervisorConfig = $null
  try { $supervisorConfig = (Read-Json "$FleetHome\config\cycle.json").supervisor } catch {}
  $pageKinds = @('stray', 'cap-exceeded', 'ic-vanished', 'pr-lookup-failed', 'branch-diverged')
  if ($supervisorConfig -and $null -ne $supervisorConfig.PSObject.Properties['pageKinds']) { $pageKinds = @($supervisorConfig.pageKinds | ForEach-Object { "$_" }) }
  # The mode decision reads the daemon STRICTLY: a glitched (empty) read must not look
  # like "no Sentinel running" and hand the fleet a second actor. Staleness paging
  # below tolerates the empty list as 08a did.
  $daemon = @(); $daemonReadError = ''
  try { $daemon = Get-DaemonSessions -All -Strict } catch { $daemonReadError = "$($_.Exception.Message)" }
  $sentinelOff = Test-SentinelOff
  function Get-SentinelRow { $daemon | Where-Object { "$($_.name)" -eq 'sentinel' -and $_.pid } | Sort-Object { ConvertTo-UtcDateTime $_.startedAt } -Descending | Select-Object -First 1 }
  $sentinelRow = Get-SentinelRow
  $mode = 'shadow'; $modeReason = 'rostered Sentinel enabled'
  if ($sentinelOff) {
    if ($daemonReadError) { $modeReason = "sentinel-off stands but the daemon session list is unreadable ($daemonReadError); staying in shadow" }
    elseif ($sentinelRow) { $modeReason = "sentinel-off stands but a Sentinel session is running (job $($sentinelRow.id)); staying in shadow" }
    elseif ($Verify) { $modeReason = 'sentinel-off stands; -Verify never applies' }
    else { $mode = 'live'; $modeReason = 'sentinel-off stands and no Sentinel session is running' }
  }

  # --- run the mechanical check. In shadow the child writes its report to -ReportPath
  # --- (so the live Sentinel's state/sentinel/last-check.json stays untouched); live, it
  # --- applies and owns that canonical report. Either way the report FILE is the parse
  # --- source: stdout/stderr may carry warnings and must not fail a healthy run or cost
  # --- 08b its parity data. Deleting the file first makes its existence proof of a
  # --- fresh, completed check.
  $reportPath = if ($Verify) { Join-Path $env:TEMP 'fleet-watchdog-verify-check.json' } elseif ($mode -eq 'live') { "$FleetHome\state\sentinel\last-check.json" } else { "$FleetHome\state\watchdog\last-shadow-check.json" }
  if (-not $Verify) { [IO.Directory]::CreateDirectory("$FleetHome\state\watchdog") | Out-Null; [IO.Directory]::CreateDirectory("$FleetHome\state\sentinel") | Out-Null }
  Remove-Item $reportPath -ErrorAction SilentlyContinue
  $check = $null; $checkError = ''; $checkExit = $null
  $childOut = [IO.Path]::GetTempFileName(); $childErr = [IO.Path]::GetTempFileName()
  try {
    $applyArgs = if ($mode -eq 'live') { ' -Apply -Actor watchdog' } else { '' }
    $childArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\sentinel-check.ps1`" -ReportPath `"$reportPath`"$applyArgs"
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $childArgs -NoNewWindow -PassThru -RedirectStandardOutput $childOut -RedirectStandardError $childErr
    if (-not $p.WaitForExit($checkTimeoutSec * 1000)) {
      try { $p.Kill() } catch {}
      $checkError = "sentinel-check timed out after ${checkTimeoutSec}s and was killed"
    } else { $checkExit = $p.ExitCode }
  } catch { $checkError = "sentinel-check could not start: $($_.Exception.Message)" }
  if (-not $checkError) {
    if (Test-Path $reportPath) { try { $check = Read-Json $reportPath } catch {} }
    if (-not $check) {
      $errText = ''; try { $errText = Get-Content $childErr -Raw -ErrorAction SilentlyContinue } catch {}
      $checkError = "exit=$checkExit; no readable report at $reportPath; stderr: $(Get-OneLine $errText)"
    }
  }
  Remove-Item $childOut, $childErr -ErrorAction SilentlyContinue
  # A live check just respawned or retired sessions; the staleness grace below must read
  # the rows as they are now, not the pre-action snapshot, or the curing tick pages.
  if ($mode -eq 'live') { try { $daemon = Get-DaemonSessions -All -Strict } catch {} }

  # --- self-healing staleness: page only when the healer, not the patient, is down.
  # --- A fresh daemon startedAt is grace for a stale/absent heartbeat: a session just
  # --- relaunched (post-logon recovery, or a deliberate stop + launch) has no first-turn
  # --- heartbeat yet, and paging on the cure would be a false page. PAUSE suppresses
  # --- staleness paging entirely: paused sessions idle by design, and a rate-limit
  # --- pause (60 min) outlasts the staleness threshold.
  $stateErrors = @()
  $paused = Test-Paused
  $static = $null
  try { $static = Get-StaticRoster } catch { $stateErrors += "static roster unreadable: $(Get-OneLine $_.Exception.Message 120)" }
  $staticNames = @()
  # Under sentinel-off the rostered Sentinel is not expected: no sentinel-stale, and
  # fleet-dead is judged over the sessions that are.
  if ($static) { $staticNames = @((Get-ExpectedStaticSessions $static) | ForEach-Object { "$($_.name)" } | Where-Object { $_ }) }
  $staleStatics = @()
  foreach ($n in $staticNames) {
    $age = Get-HeartbeatAgeMinutes $n
    if ($null -ne $age -and $age -le $staleMinutes) { continue }
    $row = $daemon | Where-Object { $_.name -eq $n } | Sort-Object { ConvertTo-UtcDateTime $_.startedAt } -Descending | Select-Object -First 1
    if ($row) {
      $rowStart = ConvertTo-UtcDateTime $row.startedAt
      if ($rowStart -and ((New-TimeSpan -Start $rowStart -End $now).TotalMinutes -le $staleMinutes)) { continue }   # freshly (re)launched; first heartbeat pending
    }
    $shown = -1; if ($null -ne $age) { $shown = [int][Math]::Min($age, 99999) }
    $staleStatics += [pscustomobject]@{ name = $n; ageMin = $shown }
  }
  $sentinelStale = (-not $paused) -and (@($staleStatics | Where-Object { $_.name -eq 'sentinel' }).Count -gt 0)
  $fleetDead = (-not $paused) -and ($staticNames.Count -gt 0) -and ($staleStatics.Count -ge $staticNames.Count)

  # --- launch retry storms: newest-first consecutive 'failed' rows per fleet name,
  # --- counting only rows started inside the window (daemon history never expires,
  # --- and a week-old storm re-paging after Cory lifts its hold would fight the human).
  $windowStart = $now.AddHours(-$retryWindowHours)
  $fleetPattern = '^(dispatcher|sentinel|pl-[a-z0-9-]+|ic-[0-9]+)$'
  $retryTrips = @()
  foreach ($g in ($daemon | Where-Object { "$($_.name)" -match $fleetPattern } | Group-Object name)) {
    $rows = @($g.Group | ForEach-Object {
      $ts = ConvertTo-UtcDateTime $_.startedAt
      if ($ts -and $ts -ge $windowStart) { [pscustomobject]@{ row = $_; ts = $ts } }
    } | Sort-Object ts -Descending)
    $streak = 0
    foreach ($r in $rows) { if ("$($r.row.state)" -eq 'failed') { $streak++ } else { break } }
    if ($streak -ge $retryCap) {
      $latest = $rows[0].row
      $js = $null; try { $js = Get-JobState $latest.id } catch {}
      $detail = 'no detail recorded'; if ($js -and $js.detail) { $detail = Get-OneLine $js.detail }
      $retryTrips += [pscustomobject]@{ name = $g.Name; failures = $streak; latestJob = $latest.id; detail = $detail }
    }
  }

  # --- retry cap -> skip-hold for ICs (the third identical attempt never finds the cause).
  # --- Dispositions keep the page honest: our own launch-failed hold means handled (the
  # --- condition clears; a lifted hold whose failures recur inside the window re-pages);
  # --- a human's unrelated hold is never treated as ours and never overwritten; a CLOSED
  # --- issue's failures are history.
  $tenantFiles = @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)
  $soleTenant = $null; if ($tenantFiles.Count -eq 1) { $soleTenant = [IO.Path]::GetFileNameWithoutExtension($tenantFiles[0].Name) }
  $skipWrites = @()
  $tripEvals = @()
  foreach ($trip in $retryTrips) {
    $ev = [pscustomobject]@{ name = $trip.name; failures = $trip.failures; latestJob = $trip.latestJob; detail = $trip.detail; disposition = 'static-paged'; page = $true }
    if ($trip.name -match '^ic-([0-9]+)$') {
      $issue = $Matches[1]
      $tenant = $soleTenant
      if (-not $tenant) {
        $rosterRow = $null
        try { $rosterRow = (Get-LiveRoster).sessions | Where-Object { $_.name -eq $trip.name } | Select-Object -Last 1 } catch {}
        if ($rosterRow) { $tenant = $rosterRow.tenant }
      }
      if (-not $tenant) {
        $ev.disposition = 'no-tenant-paged'   # the page still carries the trip
      } else {
        $skipPath = "$FleetHome\state\skip\$tenant.json"
        $skip = $null; $skipReadable = $true
        try { $skip = Read-Json $skipPath } catch { $skipReadable = $false }
        if (-not $skipReadable) {
          $ev.disposition = 'skip-unreadable-paged'
        } else {
          if (-not $skip) { $skip = [pscustomobject]@{ issues = [pscustomobject]@{}; prs = [pscustomobject]@{} } }
          if ($null -eq $skip.issues) { $skip | Add-Member -NotePropertyName issues -NotePropertyValue ([pscustomobject]@{}) -Force }
          $existingHold = $null
          if (@($skip.issues.PSObject.Properties.Name) -contains $issue) { $existingHold = "$($skip.issues.$issue)" }
          if ($existingHold -and $existingHold -match '^launch-failed:') {
            $ev.disposition = 'already-held'; $ev.page = $false
          } elseif ($existingHold) {
            $ev.disposition = 'held-other-paged'   # a human's hold for another reason: page, never overwrite
          } else {
            $t = $null
            try { $t = Read-Json "$FleetHome\tenants\$tenant.json" } catch {}
            $ghState = ''
            if ($t -and $t.github) {
              try {
                $ghRaw = & gh issue view $issue -R $t.github --json state 2>$null | Out-String
                if ($LASTEXITCODE -eq 0) { try { $ghState = "$(($ghRaw | ConvertFrom-Json).state)" } catch {} }
              } catch {}
            }
            if ($ghState -eq 'CLOSED') {
              $ev.disposition = 'closed-stale'; $ev.page = $false
            } elseif ($ghState) {
              $reason = "launch-failed: $($trip.failures) consecutive failed launches (watchdog $(Now-Iso)); latest job $($trip.latestJob): $($trip.detail). Fix the cause, then lift this hold."
              $skip.issues | Add-Member -NotePropertyName $issue -NotePropertyValue $reason -Force
              if (-not $Verify) { Write-Json $skipPath $skip }
              $skipWrites += [pscustomobject]@{ tenant = $tenant; issue = $issue }
              $ev.disposition = 'held-paged'
            } else {
              $ev.disposition = 'gh-failed-paged'   # fail safe: visible, but no hold on unverified state
            }
          }
        }
      }
    }
    $tripEvals += $ev
  }

  # --- live supervision (ticket 08b): what the Sentinel session used to do with the
  # --- report. launchNeeded (a name the daemon has no job for) goes through the one
  # --- door; PAUSE launches nothing (the check itself still ran, which is how a
  # --- rate-limit PAUSE gets cleared). A failed launch leaves a failed daemon row, so
  # --- the retry-cap page above is the bound on repeats, as for the Sentinel. A
  # --- respawn files an escalation for the parent: a script cannot message a session,
  # --- so the "re-send its assignment" nudge is visible decision evidence until wake
  # --- delivery is authorized (ticket 09). A respawned dispatcher pages, as before. The
  # --- same job respawned tick after tick (a session that will not stay up) is ONE
  # --- condition: state/watchdog/notified.json holds the respawns of the previous tick,
  # --- and a name:job seen there is neither re-filed nor re-toasted.
  $launches = @(); $notified = @(); $waiting = @()
  $notifiedPath = "$FleetHome\state\watchdog\notified.json"
  $previouslyNotified = @()
  try { $prevNotified = Read-Json $notifiedPath; if ($prevNotified) { $previouslyNotified = @($prevNotified.PSObject.Properties.Name) } } catch {}
  $currentRespawnKeys = @()
  if ($mode -eq 'live' -and $check) {
    foreach ($need in @($check.launchNeeded)) {
      $name = "$($need.name)"; if (-not $name) { continue }
      $result = [pscustomobject]@{ name = $name; launched = $false; reason = ''; jobId = $null }
      if ($paused) { $result.reason = 'PAUSE set; not launched' }
      else {
        try {
          $raw = & "$PSScriptRoot\launch.ps1" -FromRoster $name 2>&1 | Out-String
          $parsed = ConvertFrom-LastJsonLine $raw
          if ($parsed -and $parsed.PSObject.Properties['launched']) {
            $result.launched = [bool]$parsed.launched
            $result.reason = if ($parsed.launched) { 'launched' } else { Get-OneLine $parsed.reason 200 }
            if ($parsed.jobId) { $result.jobId = $parsed.jobId }
          } else { $result.reason = "launch.ps1 returned no JSON: $(Get-OneLine $raw 200)" }
        } catch { $result.reason = "launch.ps1 threw: $(Get-OneLine $_.Exception.Message 200)" }
      }
      $launches += $result
    }
    foreach ($r in @($check.respawned)) {
      $key = "respawned:$($r.name):$($r.jobId)"
      $currentRespawnKeys += $key
      if ($previouslyNotified -contains $key) { $waiting += [pscustomobject]@{ name = "$($r.name)"; kind = 'respawned-again'; detail = "job $($r.jobId) respawned again ($($r.reason)); already notified" }; continue }
      $detail = "$($r.name) respawned ($($r.reason); job $($r.jobId)). Parent $($r.parent) must re-send its assignment if it was mid-task."
      Write-Escalation -From 'supervisor' -Kind 'respawned' -Detail $detail -Name "$($r.name)" -Parent "$($r.parent)"
      $toast = $null
      if ("$($r.name)" -eq 'dispatcher' -and -not $NoToast) { $toast = Send-FleetToast 'Fleet supervisor' "dispatcher respawned ($($r.reason)) - run bin\status.ps1" }
      $notified += [pscustomobject]@{ name = "$($r.name)"; kind = 'respawned'; parent = "$($r.parent)"; toastDelivered = $toast }
    }
    foreach ($e in @($check.escalate)) {
      if ($pageKinds -notcontains "$($e.kind)") { $waiting += [pscustomobject]@{ name = "$($e.name)"; kind = "$($e.kind)"; detail = Get-OneLine $e.detail 200 } }
    }
  }

  # --- page conditions ---
  $conditions = @()
  if ($checkError) { $conditions += [pscustomobject]@{ key = 'check-failed'; detail = "sentinel-check could not run or report: $(Get-OneLine $checkError 300)" } }
  foreach ($se in $stateErrors) { $conditions += [pscustomobject]@{ key = 'state-unreadable'; detail = $se } }
  if ($sentinelOff -and $sentinelRow) {
    $conditions += [pscustomobject]@{ key = 'double-actor'; detail = "state/flags/sentinel-off stands but a Sentinel session is running (job $($sentinelRow.id)); the supervisor stays in shadow so nothing acts twice. Stop that session (claude stop $($sentinelRow.id)) or run bin\rollback-sentinel.ps1" }
  }
  if ($mode -eq 'live' -and $check) {
    foreach ($e in @($check.escalate)) {
      if ($pageKinds -notcontains "$($e.kind)") { continue }
      $conditions += [pscustomobject]@{ key = "escalation:$($e.name):$($e.kind)"; detail = (Get-OneLine $e.detail 300); escalation = $e }
    }
  }
  $escCount = @(Get-ChildItem "$FleetHome\state\escalations" -Filter *.json -ErrorAction SilentlyContinue).Count
  $checkEsc = 0; if ($check) { $checkEsc = @($check.escalate).Count }
  $pendingNote = "; $escCount escalation file(s) and $checkEsc check-reported escalation(s) have no live relay"
  if ($fleetDead) {
    $names = (@($staleStatics | ForEach-Object { "$($_.name):$($_.ageMin)m" }) -join ', ')
    $conditions += [pscustomobject]@{ key = 'fleet-dead'; detail = "every static heartbeat is stale ($names; threshold $staleMinutes m); the fleet is not self-healing$pendingNote" }
  } elseif ($sentinelStale) {
    $age = @($staleStatics | Where-Object { $_.name -eq 'sentinel' })[0].ageMin
    $conditions += [pscustomobject]@{ key = 'sentinel-stale'; detail = "sentinel heartbeat is $age min old (threshold $staleMinutes); respawns and escalation relay are not happening$pendingNote" }
  }
  foreach ($ev in ($tripEvals | Where-Object { $_.page })) {
    $conditions += [pscustomobject]@{ key = "launch-retry:$($ev.name)"; detail = "$($ev.failures) consecutive failed launches of $($ev.name) (latest job $($ev.latestJob): $($ev.detail)); $($ev.disposition)" }
  }

  # --- page-once dedupe: a key pages when it appears; clearing and reappearing pages
  # --- again. A corrupt paged.json is quarantined, never fatal: the pager must not die
  # --- of its own state while a real condition stands.
  $pagedPath = "$FleetHome\state\watchdog\paged.json"
  $paged = $null
  try { $paged = Read-Json $pagedPath } catch {
    if (-not $Verify) { try { Move-Item $pagedPath "$pagedPath.corrupt-$($now.ToString('yyyyMMddTHHmmssZ'))" -Force } catch {} }
  }
  $oldKeys = @(); if ($paged) { $oldKeys = @($paged.PSObject.Properties.Name) }
  $newConditions = @($conditions | Where-Object { $oldKeys -notcontains $_.key })
  $nextPaged = [pscustomobject]@{}
  foreach ($c in $conditions) {
    $first = Now-Iso
    if ($oldKeys -contains $c.key) { $first = $paged.($c.key).firstSeen }
    $nextPaged | Add-Member -NotePropertyName $c.key -NotePropertyValue ([pscustomobject]@{ firstSeen = $first; lastSeen = (Now-Iso); detail = $c.detail })
  }

  # --- banner: rebuilt every run from current conditions; absent when healthy ---
  $bannerPath = "$FleetHome\state\watchdog\banner.txt"
  $toastDelivered = $null
  if (-not $Verify) {
    if (@($conditions).Count -gt 0) {
      $lines = @("!! FLEET WATCHDOG - $(@($conditions).Count) condition(s) - $(Now-Iso)")
      foreach ($c in $conditions) {
        $since = $nextPaged.($c.key).firstSeen
        $lines += "!! $($c.key): $($c.detail) (since $since)"
      }
      $lines += "!! Check: claude agents --all; bin\status.ps1; state\sentinel\shadow\; clear by fixing the cause (this file rewrites itself every run)."
      [IO.File]::WriteAllText($bannerPath, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), $Utf8)
    } else {
      Remove-Item $bannerPath -ErrorAction SilentlyContinue
    }
    Write-Json $pagedPath $nextPaged
    $nextNotified = [pscustomobject]@{}
    foreach ($k in $currentRespawnKeys) { $nextNotified | Add-Member -NotePropertyName $k -NotePropertyValue (Now-Iso) -Force }
    Write-Json $notifiedPath $nextNotified
    # A check escalation pages once per new name:kind and leaves one escalation file
    # (the evidence the Dispatcher role and status.ps1 already read); while it stands,
    # the banner carries it and nothing is re-filed or re-sent.
    foreach ($c in @($newConditions | Where-Object { $_.PSObject.Properties['escalation'] -and $_.escalation })) {
      $e = $c.escalation
      $parentName = ''; if ($e.PSObject.Properties['parent']) { $parentName = "$($e.parent)" }
      Write-Escalation -From 'supervisor' -Kind "$($e.kind)" -Detail "$($e.detail)" -Name "$($e.name)" -Parent $parentName
      $notified += [pscustomobject]@{ name = "$($e.name)"; kind = "$($e.kind)"; parent = $parentName; toastDelivered = $null }
    }
    if (@($newConditions).Count -gt 0 -and -not $NoToast) {
      $body = (@($newConditions | ForEach-Object { $_.key }) -join ', ')
      # Send-FleetToast (_common.ps1) is shared with the ticket-07 notifier; the banner is the guaranteed channel.
      $toastDelivered = Send-FleetToast 'Fleet watchdog' "$body - run bin\status.ps1"
    }
  }

  # --- shadow log for the 08b parity comparison ---
  $proposed = $null
  if ($check) {
    $proposed = [pscustomobject]@{
      respawned = $check.respawned; launchNeeded = $check.launchNeeded; escalate = $check.escalate
      retired = $check.retired; worktrees = $check.worktrees; sync = $check.sync; pause = $check.pause; okCount = @($check.ok).Count
    }
    # A fail-closed tick proposed nothing because it could not see the fleet; parity must not count it as clean.
    if ($check.PSObject.Properties['daemonReadError'] -and $check.daemonReadError) { $proposed | Add-Member -NotePropertyName daemonReadError -NotePropertyValue "$($check.daemonReadError)" }
  }
  $entry = [pscustomobject]@{
    at = (Now-Iso); mode = $mode; modeReason = $modeReason
    conditions = @($conditions | ForEach-Object { $_.key }); newlyPaged = @($newConditions | ForEach-Object { $_.key })
    toastDelivered = $toastDelivered; checkError = $checkError; proposed = $proposed
    launches = $launches; notified = $notified; waiting = $waiting
    staleStatics = $staleStatics; retryTrips = $tripEvals; skipWrites = $skipWrites; paused = [bool]$paused; verify = [bool]$Verify
  }
  $line = ($entry | ConvertTo-Json -Compress -Depth 8)
  if (-not $Verify) {
    $shadowDir = "$FleetHome\state\sentinel\shadow"
    [IO.Directory]::CreateDirectory($shadowDir) | Out-Null
    [IO.File]::AppendAllText("$shadowDir\$($now.ToString('yyyyMMdd')).jsonl", $line + [Environment]::NewLine, $Utf8)
    # The supervisor's own heartbeat: status.ps1 shows it, the Dispatcher's watch reads it.
    Write-Json "$FleetHome\state\watchdog\last-run.json" ([pscustomobject]@{ at = $entry.at; mode = $mode; modeReason = $modeReason; conditions = $entry.conditions; checkError = $checkError })
  }
  Write-Output $line
  exit 0
} catch {
  # The pager of last resort must not die silently - and its own crash must never mask a
  # condition banner an earlier run already raised: prepend, never replace.
  try {
    $fallbackHome = Split-Path -Parent $PSScriptRoot
    $fallbackBanner = "$fallbackHome\state\watchdog\banner.txt"
    [IO.Directory]::CreateDirectory("$fallbackHome\state\watchdog") | Out-Null
    $existing = ''
    try { if (Test-Path $fallbackBanner) { $existing = [IO.File]::ReadAllText($fallbackBanner) } } catch {}
    $crashLine = "!! FLEET WATCHDOG crashed at $((Get-Date).ToUniversalTime().ToString('o')): $($_.Exception.Message)$([Environment]::NewLine)"
    if ($existing -and $existing.StartsWith('!! FLEET WATCHDOG crashed')) { $existing = '' }   # keep one crash line, keep any condition banner
    [IO.File]::WriteAllText($fallbackBanner, $crashLine + $existing, (New-Object Text.UTF8Encoding $false))
  } catch {}
  Write-Error $_
  exit 1
}
