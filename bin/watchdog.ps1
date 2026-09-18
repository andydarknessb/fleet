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
  label is a summary of a session's last line, not a measured wait. The exception (fleet
  #28) is a permission wait: a job whose state.json `needs` starts with "approve " and
  whose updatedAt is older than $permissionWaitMinutes is a session stuck on a
  permission prompt nobody will answer; it pages once per job and files an escalation
  naming the parent, in shadow and live alike (no Sentinel handles it). A Sentinel session
  running under the flag is the double-actor condition: page, stay in shadow.
#>
[CmdletBinding()]
param(
  [switch]$Verify,   # compute and print only: no fleet-state writes, no toast (the shadowed check still fetches)
  [switch]$NoToast,  # write state but never toast (tests)
  [int]$PermissionWaitMinutes = 5   # fleet #28: minutes a --bg session may sit on a permission prompt before it pages (tests lower it)
)

try {
  . "$PSScriptRoot\_common.ps1"
  # Entry point: never inherit a caller's Stop preference - PS 5.1 wraps native stderr
  # in ErrorRecords, and under Stop a mere gh/git stderr line would terminate the run.
  $ErrorActionPreference = 'Continue'
  $now = (Get-Date).ToUniversalTime()
  $staleMinutes = 45        # three missed 15-min Sentinel crons; the dispatcher uses the same threshold
  $watchdogConfig = $null; try { $watchdogConfig = (Read-Json "$FleetHome\config\cycle.json").watchdog } catch {}
  if ($watchdogConfig -and $watchdogConfig.PSObject.Properties['staleMinutes']) { $staleMinutes = [int]$watchdogConfig.staleMinutes }   # ticket 75: config/cycle.json watchdog.staleMinutes, default 45
  $healStaleMinutes = 60    # ticket 84: config/cycle.json watchdog.healStaleMinutes, default 60
  if ($watchdogConfig -and $watchdogConfig.PSObject.Properties['healStaleMinutes']) { $healStaleMinutes = [int]$watchdogConfig.healStaleMinutes }
  $healCap = 2              # ticket 84: config/cycle.json watchdog.healCap, default 2 (per session, per 24h)
  if ($watchdogConfig -and $watchdogConfig.PSObject.Properties['healCap']) { $healCap = [int]$watchdogConfig.healCap }
  $healWindowHours = 24
  $pagesConfig = $null; try { $pagesConfig = (Read-Json "$FleetHome\config\cycle.json").pages } catch {}   # ticket 77: pages.priority / pages.defaultPriority
  $fleetDeadRepeatMinutes = 120   # ticket 78: pages.fleetDeadRepeatMinutes, default 120 (two hours)
  if ($pagesConfig -and $pagesConfig.PSObject.Properties['fleetDeadRepeatMinutes'] -and $pagesConfig.fleetDeadRepeatMinutes) { $fleetDeadRepeatMinutes = [int]$pagesConfig.fleetDeadRepeatMinutes }
  $fullCycleConfig = $null; try { $fullCycleConfig = Read-Json "$FleetHome\config\cycle.json" } catch {}   # ticket 81: recursive scan for keys ending in Until
  $retryCap = 2
  $retryWindowHours = 24    # daemon job history is forever; only recent failures are a storm
  $checkTimeoutSec = 180    # live check measures ~4s; gh/git slowness gets margin, a wedge gets a page
  $frontierTimeoutSec = 15  # ticket 75 review: assignment.js frontier normally answers in ~1-2s; bounded so a wedged gh call cannot wedge the tick
  $permissionWaitMinutes = $PermissionWaitMinutes  # fleet #28: a permission prompt in a --bg session has no approver; ic-1208 sat 12 min unseen

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

  # --- ticket 77 (ADR 0012): resolve a condition's page priority. The ruling
  # --- (issue-74.md) is hardcoded as the default so a bare fixture with no
  # --- config/cycle.json still routes correctly; config/cycle.json pages.priority
  # --- (ticket 76) overrides or adds entries, pages.defaultPriority overrides the
  # --- normal fallback. Matched the way Test-CapExempt already matches
  # --- cap.exemptNamePrefixes: a map key is a match when it is a PREFIX of the
  # --- kind string (permission-wait:<name>:<job> starts with permission-wait).
  # --- For an `escalation:<name>:<kind>` condition the caller passes the
  # --- escalation's own kind (branch-diverged, stray, ...), never the dedupe
  # --- key with its `escalation:` prefix, or a ruled kind riding inside that
  # --- prefix would silently miss its own map entry. Longest prefix wins so a
  # --- specific kind is never shadowed by a shorter one.
  # ---
  # --- Every kind the Watchdog can build today, on purpose (tests/watchdog.tests.ps1
  # --- walks this list): fleet-dead=emergency, permission-wait=high, launch-retry=high,
  # --- branch-diverged=high (all ADR 0012-ruled); sentinel-stale, check-failed,
  # --- state-unreadable, double-actor, and the check-escalation kinds stray,
  # --- cap-exceeded, ic-vanished, pr-lookup-failed, blocked default to normal - none
  # --- of these is a Cory decision the ADR names, so falling to pages.defaultPriority
  # --- is the reasoned choice, not a silent gap. state-escalated, state-hold and
  # --- merge-review-wake belong to the Notifier (#79) and never reach this function
  # --- from here.
  $script:DefaultPagePriority = @{ 'fleet-dead' = 'emergency'; 'permission-wait' = 'high'; 'launch-retry' = 'high'; 'branch-diverged' = 'high' }
  function Get-PagePriority {
    param([string]$Kind, $PagesConfig)
    $map = @{}
    foreach ($k in $script:DefaultPagePriority.Keys) { $map[$k] = $script:DefaultPagePriority[$k] }
    $default = 'normal'
    if ($PagesConfig) {
      if ($PagesConfig.PSObject.Properties['priority'] -and $PagesConfig.priority) {
        foreach ($p in $PagesConfig.priority.PSObject.Properties) { $map[$p.Name] = "$($p.Value)" }
      }
      if ($PagesConfig.PSObject.Properties['defaultPriority'] -and $PagesConfig.defaultPriority) { $default = "$($PagesConfig.defaultPriority)" }
    }
    $best = $null; $bestLen = -1
    foreach ($k in $map.Keys) {
      if ($k -and "$Kind".StartsWith($k) -and $k.Length -gt $bestLen) { $best = $map[$k]; $bestLen = $k.Length }
    }
    if ($best) { return $best }
    return $default
  }

  # --- ticket 81 (ADR 0012): a passed date, in config or on a Notice, pages once
  # --- (normal priority) and clears when the key or paragraph goes.
  function Find-ExpiredUntilKeys {
    # Walks a parsed JSON object (config/cycle.json) recursively for any property
    # whose name ends in "Until" (case-sensitive: camelCase config keys) and whose
    # string value parses as a UTC date strictly before today - the same
    # date-only "passed" rule hooks/session-start.ps1 already uses for
    # `[until YYYY-MM-DD]` notice paragraphs. $Path accumulates the dotted key
    # path the condition names as its `where`. A value that is not a string, or
    # does not parse as a date, is not a date field: skipped, not an error.
    param($Obj, [string]$Path)
    $found = @()
    if ($null -eq $Obj) { return $found }
    if ($Obj -is [System.Management.Automation.PSCustomObject]) {
      foreach ($prop in $Obj.PSObject.Properties) {
        $childPath = if ($Path) { "$Path.$($prop.Name)" } else { "$($prop.Name)" }
        # 2026-09-17 QA (fleet #81 review #9): [datetime]::TryParse accepts far more
        # than a date - "1.5" parses as a valid (if bizarre) date/time and false-paged.
        # An ISO date shape gate before ever trying to parse keeps this to what
        # `*Until` config values are actually meant to hold.
        if ("$($prop.Name)".EndsWith('Until') -and ($prop.Value -is [string]) -and ("$($prop.Value)" -match '^\d{4}-\d{2}-\d{2}')) {
          $parsed = [datetime]::MinValue
          if ([datetime]::TryParse("$($prop.Value)", [Globalization.CultureInfo]::InvariantCulture, ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$parsed)) {
            if ($now.Date -gt $parsed.ToUniversalTime().Date) { $found += [pscustomobject]@{ where = $childPath; value = "$($prop.Value)" } }
          }
        }
        $found += (Find-ExpiredUntilKeys -Obj $prop.Value -Path $childPath)
      }
    } elseif ($Obj -is [array] -or ($Obj -is [Collections.IList])) {
      for ($i = 0; $i -lt $Obj.Count; $i++) { $found += (Find-ExpiredUntilKeys -Obj $Obj[$i] -Path "$Path[$i]") }
    }
    return $found
  }
  function Find-ExpiredNoticeDates {
    # state/notices/*.md paragraphs whose [until YYYY-MM-DD] has passed and is
    # still in the file - the identical regex and past-date rule
    # hooks/session-start.ps1 uses to drop an expired paragraph from context.
    # This function only READS; it never edits or clears the notice itself.
    #
    # 2026-09-17 QA (fleet #81 review #3): keying on a hash of the WHOLE paragraph
    # meant editing one character of a still-expired paragraph (a typo fix, a
    # clarifying sentence) changed its key, so the old key read as "cleared" and
    # the new one paged again - live state/notices/project-lead.md already carries
    # two expired paragraphs today, both one edit away from a false page. Key on
    # the file, the [until] date itself, and this paragraph's ordinal among
    # paragraphs sharing that same date in that file: stable across edits that
    # leave the date and the paragraph's position alone, still distinct from a
    # same-file, same-date paragraph the file doesn't reorder relative to it.
    $found = @()
    foreach ($noticeFile in @(Get-ChildItem "$FleetHome\state\notices" -Filter *.md -ErrorAction SilentlyContinue)) {
      $raw = ''; try { $raw = Get-Content $noticeFile.FullName -Raw -Encoding UTF8 } catch { continue }
      if (-not $raw -or -not $raw.Trim()) { continue }
      $ordinalByDate = @{}
      foreach ($para in (($raw -replace "`r`n", "`n") -split '\n\s*\n')) {
        $p = $para.Trim(); if (-not $p) { continue }
        if ($p -notmatch '\[until (\d{4}-\d{2}-\d{2})\]') { continue }
        $dateStr = $Matches[1]
        $limit = [datetime]::MinValue
        if (-not [datetime]::TryParseExact($dateStr, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$limit)) { continue }
        $ordinal = 0; if ($ordinalByDate.ContainsKey($dateStr)) { $ordinal = $ordinalByDate[$dateStr] }
        $ordinalByDate[$dateStr] = $ordinal + 1
        if ($now.Date -gt $limit.Date) { $found += [pscustomobject]@{ where = "notice:$($noticeFile.Name):$dateStr#$ordinal"; value = $dateStr } }
      }
    }
    return $found
  }
  function Send-DeadManPing {
    # Ticket 81 (ADR 0012): the off-host dead-man service pages Cory when these
    # pings stop, so this must run at the end of EVERY tick - PAUSE or not - and
    # never fail the tick. state/pages/deadman.url is not committed and Cory has
    # not necessarily written it yet: absent file, empty content, or a failed GET
    # are all recorded here and never thrown. Read fresh every tick (not cached)
    # in case Cory rotates the URL. 5s timeout: this must never be the thing that
    # makes a tick slow.
    $result = [pscustomobject]@{ configured = $false; ok = $null; error = $null }
    $urlPath = "$FleetHome\state\pages\deadman.url"
    if (-not (Test-Path $urlPath)) { return $result }
    $url = ''
    try { $url = (Get-Content $urlPath -Raw -Encoding UTF8).Trim() } catch { $result.error = "deadman.url unreadable: $(Get-OneLine $_.Exception.Message 150)"; return $result }
    if (-not $url) { return $result }
    $result.configured = $true
    try { $null = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 5; $result.ok = $true }
    catch { $result.ok = $false; $result.error = Get-OneLine $_.Exception.Message 150 }
    return $result
  }

  # --- ticket 75 (ADR 0012): the two predicates the frontier wake already asked,
  # --- lifted so fleet-dead's Test-WorkWaiting can ask the same questions without
  # --- duplicating them. Behavior for the frontier-wake loop's own callers is
  # --- unchanged: same inputs, same silence-on-error shape (evidence/reason).
  # --- The .error field is new and exists only for Test-WorkWaiting, which - unlike
  # --- the wake loop - must fail CLOSED (toward paging) when the planner itself
  # --- could not answer, since a swallowed error there would look like "nothing
  # --- waiting".
  # 2026-09-17 review (fleet #75): a per-tick cache keyed by tenant - Test-WorkWaiting
  # (fleet-dead) and the frontier wake block can both ask this in the same tick, and
  # the answer cannot change mid-tick (LiveRoster/LiveCount/Cap are fixed snapshots
  # taken once above), so the second ask reuses the first's answer instead of
  # spending another assignment.js invocation (QA measured three serial calls
  # ballooning a tick to 61s against a 20s-blocking node shim).
  # 2026-09-17 QA (fleet #81 review #2): the shared bound the planner call already
  # used, extracted so the triage call below can reuse it instead of being a second,
  # unbounded copy of the same Start-Process/WaitForExit/Kill shape.
  function Invoke-BoundedExe {
    param([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSec)
    $result = [pscustomobject]@{ timedOut = $false; exitCode = $null; stdout = ''; stderr = ''; startError = $null }
    $childOut = [IO.Path]::GetTempFileName(); $childErr = [IO.Path]::GetTempFileName()
    try {
      $p = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -NoNewWindow -PassThru -RedirectStandardOutput $childOut -RedirectStandardError $childErr
      # 2026-09-17 QA repro: .NET only latches the exit-code plumbing once something
      # touches the process handle; skip this and a fast-exiting child's .ExitCode
      # reads back $null even on a clean exit (triage.js exits well under a second
      # against a fixture, and this cost the triage wake test its evidence entirely).
      $null = $p.Handle
      if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        try { $p.Kill() } catch {}
        $result.timedOut = $true
      } else {
        $result.exitCode = $p.ExitCode
      }
    } catch { $result.startError = "$($_.Exception.Message)" }
    finally {
      try { $result.stdout = Get-Content $childOut -Raw -ErrorAction SilentlyContinue } catch {}
      try { $result.stderr = Get-Content $childErr -Raw -ErrorAction SilentlyContinue } catch {}
      Remove-Item $childOut, $childErr -ErrorAction SilentlyContinue
    }
    return $result
  }
  $script:frontierWaitingCache = @{}
  function Test-FrontierWaiting {
    param($TenantName, $Tenant, $NodeExe, $LiveRoster, $LiveCount, $Cap)
    if ($script:frontierWaitingCache.ContainsKey($TenantName)) { return $script:frontierWaitingCache[$TenantName] }
    $result = [pscustomobject]@{ evidence = @(); reason = ''; error = $null }
    if (-not $NodeExe) { $result.error = 'node not found'; $script:frontierWaitingCache[$TenantName] = $result; return $result }
    $activeIcs = 0; if ($LiveRoster) { $activeIcs = @($LiveRoster.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' -and $_.tenant -eq $TenantName }).Count }
    $maxIcs = 0; try { $maxIcs = [int]$Tenant.maxIcs } catch {}
    if ($activeIcs -ge $maxIcs -or $LiveCount -ge $Cap) { $result.reason = "no slot (ICs $activeIcs/$maxIcs, cap $LiveCount/$Cap)"; $script:frontierWaitingCache[$TenantName] = $result; return $result }
    # Bounded (Invoke-BoundedExe: Start-Process + WaitForExit + Kill): a wedged
    # assignment.js (a hung gh call inside it) must not wedge the whole tick. A
    # timeout is recorded as a planner failure - Test-WorkWaiting already fails
    # CLOSED (toward paging) on $result.error, so a hung planner still pages
    # rather than reading as a silent idle tick.
    $frontierArgs = @('frontier', '--root', $FleetHome, '--tenant', $TenantName)
    if ($env:FLEET_GITHUB_ISSUES_FIXTURE) { $frontierArgs += @('--fixture', $env:FLEET_GITHUB_ISSUES_FIXTURE) }
    $bounded = Invoke-BoundedExe -FilePath $NodeExe -ArgumentList (@("$PSScriptRoot\assignment.js") + $frontierArgs) -TimeoutSec $frontierTimeoutSec
    if ($bounded.startError) { $result.error = "assignment.js could not start: $(Get-OneLine $bounded.startError 200)" }
    elseif ($bounded.timedOut) { $result.error = "assignment.js timed out after ${frontierTimeoutSec}s and was killed" }
    else {
      $frontier = ConvertFrom-LastJsonLine $bounded.stdout
      if (-not $frontier) { $result.error = "assignment.js returned no JSON: $(Get-OneLine $bounded.stdout 200)" }
      else {
        $eligible = @(); if ($frontier.PSObject.Properties['eligible']) { $eligible = @($frontier.eligible | ForEach-Object { [int]$_.number }) }
        if ($eligible.Count -gt 0) { $result.evidence += "frontier #$($eligible -join ', #')" }
      }
    }
    $script:frontierWaitingCache[$TenantName] = $result
    return $result
  }

  function Get-UnconsumedWakes {
    # $Since bounds "before this lead's current session started" (the frontier
    # wake's own use); fleet-dead has no lead session to bound by and passes
    # $null. $ConsumedThrough is the frontier wake's delivery watermark for the
    # tenant, shared so a wake that already woke the lead is not double-counted
    # as fresh work waiting.
    param($TenantName, [Nullable[datetime]]$Since = $null, [Nullable[datetime]]$ConsumedThrough = $null)
    $kinds = @{}
    $outboxPath = "$FleetHome\state\watch\wake-outbox.jsonl"
    if (-not (Test-Path $outboxPath)) { return $kinds }
    foreach ($rawLine in (Get-Content $outboxPath -ErrorAction SilentlyContinue)) {
      if (-not $rawLine) { continue }
      $o = $null; try { $o = $rawLine | ConvertFrom-Json } catch { continue }
      if (-not $o -or -not $o.at -or "$($o.recordId)" -notlike "$TenantName`:*") { continue }
      $atUtc = ConvertTo-UtcDateTime $o.at
      if (-not $atUtc) { continue }
      if ($Since -and $atUtc -le $Since) { continue }
      if ($ConsumedThrough -and $atUtc -le $ConsumedThrough) { continue }
      if (@('checks-settled', 'checks-failed', 'decision-needed') -notcontains "$($o.wake)") { continue }
      $kinds["$($o.wake)"] = [int]$kinds["$($o.wake)"] + 1
    }
    return $kinds
  }

  # 2026-09-17 review (fleet #75): the ruled six waiting states were a
  # hardcoded PowerShell list duplicating bin/work-state.js STATES, so a record
  # in a state that list had never heard of (QA used "quarantined") silently
  # read as no work. This asks work-state.js what it actually knows, once per
  # tick (not once per record), so Test-WorkWaiting can invert the unknown
  # case: a state work-state.js does not recognize at all cannot be trusted as
  # "known, not waiting" and fails CLOSED. $null (node missing, or the query
  # itself failed) means "cannot verify any state" - every caller below treats
  # that the same as an unknown state.
  $script:knownWorkStatesCache = $null; $script:knownWorkStatesFetched = $false
  function Get-KnownWorkStates {
    param($NodeExe)
    if ($script:knownWorkStatesFetched) { return $script:knownWorkStatesCache }
    $script:knownWorkStatesFetched = $true
    if (-not $NodeExe) { return $null }
    try {
      $raw = & $NodeExe -e "process.stdout.write(JSON.stringify(require(process.argv[1]).STATES))" "$PSScriptRoot\work-state.js" 2>$null | Out-String
      $states = ("$raw".Trim()) | ConvertFrom-Json
      if ($states) { $script:knownWorkStatesCache = @($states | ForEach-Object { "$_" }) }
    } catch {}
    return $script:knownWorkStatesCache
  }

  function Test-WorkWaiting {
    # Ticket 75 (ADR 0012): is there work waiting for $TenantName - the second
    # half of fleet-dead ("every static heartbeat stale AND work waiting"). Any
    # one of a waiting frontier candidate, an in-flight active record, or an
    # unconsumed wake is enough. hold and escalated (work-state.js
    # DECISION_STATES) never count: a human, not the fleet, owns what happens
    # next for those, and neither do the other known-terminal states (merged,
    # retiring, retired, released, abandoned) - the ruled six are exactly the
    # waiting set AMONG KNOWN states. A record in a state work-state.js does
    # not know at all is unclassifiable, not proof of nothing waiting, and
    # fails CLOSED exactly like an unreadable active.json or a failed planner
    # call already do.
    param($TenantName, $Tenant, $NodeExe, $LiveRoster, $LiveCount, $Cap, $WakeState)
    $activeWaitStates = @('assigned', 'implementing', 'pr-open', 'ci-wait', 'review', 'revision')
    $active = $null
    try { $active = Read-Json "$FleetHome\state\work\active.json" } catch { return $true }   # exists but unreadable: fail toward paging
    if ($active -and $active.PSObject.Properties['records'] -and $active.records) {
      foreach ($prop in $active.records.PSObject.Properties) {
        $record = $prop.Value
        if ("$($record.tenant)" -ne $TenantName) { continue }
        $state = "$($record.state)"
        if ($activeWaitStates -contains $state) { return $true }
        $known = Get-KnownWorkStates -NodeExe $NodeExe
        if (-not $known -or ($known -notcontains $state)) { return $true }   # unrecognized (or unverifiable): fail toward paging
      }
    }
    $fw = Test-FrontierWaiting -TenantName $TenantName -Tenant $Tenant -NodeExe $NodeExe -LiveRoster $LiveRoster -LiveCount $LiveCount -Cap $Cap
    if ($fw.error) { return $true }   # a failed planner call cannot prove there is nothing waiting
    if ($fw.evidence.Count -gt 0) { return $true }
    $tenantState = $null; if ($WakeState -and $WakeState.PSObject.Properties['tenants'] -and $WakeState.tenants.PSObject.Properties[$TenantName]) { $tenantState = $WakeState.tenants.$TenantName }
    $consumedThrough = $null; if ($tenantState -and $tenantState.outboxConsumedThrough) { $consumedThrough = ConvertTo-UtcDateTime $tenantState.outboxConsumedThrough }
    $kinds = Get-UnconsumedWakes -TenantName $TenantName -ConsumedThrough $consumedThrough
    return ($kinds.Count -gt 0)
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
  # --- pause (59 min) outlasts the staleness threshold.
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
  $allStaticsStale = (-not $paused) -and ($staticNames.Count -gt 0) -and ($staleStatics.Count -ge $staticNames.Count)

  # --- fleet-dead (ticket 75, ADR 0012): every static heartbeat stale is
  # --- necessary but not sufficient - a session with nothing to do takes no
  # --- turns and its heartbeat goes stale too, and that is not an outage.
  # --- fleet-dead also requires work waiting for at least one tenant.
  # --- Test-WorkWaiting reuses the same frontier and unconsumed-wake predicates
  # --- the frontier wake asks below, so "there is a frontier wake pending" and
  # --- "fleet-dead is pending" never disagree. Computed only when the staleness
  # --- predicate already holds: a healthy fleet must not pay for a planner call
  # --- every tick.
  $nodeExe = $null; try { $nodeExe = Get-NodeExe } catch {}
  $liveRoster = $null; try { $liveRoster = Get-LiveRoster } catch {}
  $cap = 0; try { $cap = [int]$static.cap } catch {}
  $liveCount = @($daemon | Where-Object { $_.pid -and ($staticNames -contains "$($_.name)" -or "$($_.name)" -match '^ic-') -and -not (Test-CapExempt "$($_.name)") }).Count
  $fleetDead = $false
  $idleTick = $false
  if ($allStaticsStale) {
    $wakeStateForDead = $null; try { $wakeStateForDead = Read-Json "$FleetHome\state\watchdog\frontier-wake.json" } catch {}
    $anyWorkWaiting = $false
    $readableTenants = 0
    foreach ($tenantFile in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)) {
      $tenant = $null; try { $tenant = Read-Json $tenantFile.FullName } catch { continue }
      if (-not $tenant) { continue }
      $readableTenants++
      $tenantName = "$($tenant.name)"; if (-not $tenantName) { $tenantName = $tenantFile.BaseName }
      if (Test-WorkWaiting -TenantName $tenantName -Tenant $tenant -NodeExe $nodeExe -LiveRoster $liveRoster -LiveCount $liveCount -Cap $cap -WakeState $wakeStateForDead) { $anyWorkWaiting = $true; break }
    }
    # 2026-09-17 review (fleet #75): an unreadable tenant config (the only tenant
    # file corrupt) or zero tenant files at all left this loop with nothing to
    # check and $anyWorkWaiting false by default - recording idle and paging
    # nothing even with real work in flight. Zero READABLE tenants (whichever
    # reason) cannot prove nothing is waiting, so it fails CLOSED the same way an
    # unreadable active.json already does in Test-WorkWaiting. A tenant file that
    # IS readable and genuinely has no work waiting is unaffected: this only
    # fires when nothing could be checked at all.
    if (-not $anyWorkWaiting -and $readableTenants -eq 0) { $anyWorkWaiting = $true }
    if ($anyWorkWaiting) { $fleetDead = $true } else { $idleTick = $true }
  }

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

  # --- permission waits (fleet #28): a running fleet session whose job state `needs`
  # --- an approval ("approve Read: ...") has hit a permission prompt, and a --bg session
  # --- has no one at the prompt. The wait is measured, not read off the tempo label:
  # --- the daemon stops touching state.json while the prompt stands, so updatedAt is
  # --- the start of the wait. The cause today is a model the CLI cannot run in auto
  # --- mode (haiku), refused at launch; this catches the next cause.
  $permissionWaits = @()
  foreach ($row in @($daemon | Where-Object { "$($_.name)" -match $fleetPattern -and "$($_.state)" -notin @('stopped','failed','done') })) {
    $js = $null; try { $js = Get-JobState $row.id } catch {}
    if (-not $js -or -not $js.PSObject.Properties['needs'] -or "$($js.needs)" -notmatch '^approve ') { continue }
    $since = $null; if ($js.PSObject.Properties['updatedAt']) { $since = ConvertTo-UtcDateTime $js.updatedAt }
    if (-not $since) { continue }
    $waitMin = [Math]::Floor((New-TimeSpan -Start $since -End $now).TotalMinutes)
    if ($waitMin -lt $permissionWaitMinutes) { continue }
    $parentName = ''
    try { $rr = (Get-LiveRoster).sessions | Where-Object { $_.name -eq $row.name } | Select-Object -Last 1; if ($rr) { $parentName = "$($rr.parent)" } } catch {}
    $permissionWaits += [pscustomobject]@{ name = "$($row.name)"; job = "$($row.id)"; parent = $parentName; waitMin = $waitMin; needs = (Get-OneLine "$($js.needs)" 200) }
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
  $launches = @(); $notified = @(); $waiting = @(); $healed = @()
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
      Write-Escalation -From 'supervisor' -Kind 'respawned' -Detail $detail -Name "$($r.name)" -Parent "$($r.parent)" | Out-Null
      # Ticket 77 (ADR 0012): a fault the fleet healed by itself is not a page - the
      # dispatcher-respawn toast that used to fire here is gone. The escalation file
      # and this notified entry are the record; nothing is delivered off-host for it.
      $notified += [pscustomobject]@{ name = "$($r.name)"; kind = 'respawned'; parent = "$($r.parent)"; toastDelivered = $null }
    }
    foreach ($e in @($check.escalate)) {
      if ($pageKinds -notcontains "$($e.kind)") { $waiting += [pscustomobject]@{ name = "$($e.name)"; kind = "$($e.kind)"; detail = Get-OneLine $e.detail 200 } }
    }
  }

  # --- 2026-09-17 QA (fleet #85 review BLOCKER): a no-op respawn (respawnFailed)
  # --- must feed the launch-retry cap exactly as a genuinely failed launch does.
  # --- The daemon-row storm scan below can never see it (a wedged 'working' row
  # --- never becomes a 'failed' daemon row), so it is tracked independently, keyed
  # --- by name, in state/watchdog/respawn-failed.json. The first failure is
  # --- recorded as waiting (the base behavior before ticket 85 at least surfaced
  # --- something); the second inside retryWindowHours trips launch-retry:<name>,
  # --- the same key and priority the daemon-row storm already uses. A later
  # --- successful respawn for the same name clears its count.
  $respawnFailTrips = @()
  if ($mode -eq 'live' -and $check) {
    $respawnFailPath = "$FleetHome\state\watchdog\respawn-failed.json"
    $respawnFailState = $null; try { $respawnFailState = Read-Json $respawnFailPath } catch {}
    if (-not $respawnFailState) { $respawnFailState = [pscustomobject]@{} }
    $respawnFailChanged = $false
    foreach ($r in @($check.respawned)) {
      $rn = "$($r.name)"
      if ($rn -and $respawnFailState.PSObject.Properties[$rn]) { $respawnFailState.PSObject.Properties.Remove($rn); $respawnFailChanged = $true }
    }
    $respawnFailWindowStart = $now.AddHours(-$retryWindowHours)
    foreach ($rf in @($check.respawnFailed)) {
      $rn = "$($rf.name)"; if (-not $rn) { continue }
      $rfPrior = $null; if ($respawnFailState.PSObject.Properties[$rn]) { $rfPrior = $respawnFailState.$rn }
      $rfAttempts = @(); if ($rfPrior -and $rfPrior.PSObject.Properties['attempts']) { $rfAttempts = @($rfPrior.attempts | Where-Object { $_ }) }
      $rfRecent = @($rfAttempts | Where-Object { $ts = ConvertTo-UtcDateTime $_; $ts -and $ts -ge $respawnFailWindowStart })
      $rfRecent += (Now-Iso)
      $respawnFailState | Add-Member -NotePropertyName $rn -NotePropertyValue ([pscustomobject]@{ attempts = @($rfRecent); lastReason = "$($rf.reason)" }) -Force
      $respawnFailChanged = $true
      if ($rfRecent.Count -ge $retryCap) { $respawnFailTrips += [pscustomobject]@{ name = $rn; failures = $rfRecent.Count; reason = "$($rf.reason)" } }
      else { $waiting += [pscustomobject]@{ name = $rn; kind = 'respawn-failed'; detail = "no-op respawn ($($rf.reason)); attempt $($rfRecent.Count)/$retryCap before this trips launch-retry" } }
    }
    if ($respawnFailChanged) {
      try { $rfTmp = "$respawnFailPath.tmp"; Write-Json $rfTmp $respawnFailState; Move-Item -Force $rfTmp $respawnFailPath } catch {}
    }
  }

  # --- ticket 84 (ADR 0012): heal a blocked, stale session when work is waiting for
  # --- its tenant. sentinel-check's mechanical check still only ever records 'blocked'
  # --- (a daemon row cannot tell a permission prompt from any other wait, unchanged
  # --- above); healing decides on top of that report, here, where Test-WorkWaiting
  # --- (ticket 75) already lives and $nodeExe/$liveRoster/$cap/$liveCount are already
  # --- this tick's snapshot - sentinel-check runs as a separate process and cannot call
  # --- it without a second copy. Control-plane roles (dispatcher, sentinel,
  # --- project-lead, principal) are rotated here, directly; an IC is healed through
  # --- the ticket 85 Do-Respawn path, called back into sentinel-check.ps1 by name so a
  # --- no-op still counts as failed. The fleet's real failure this closes: two
  # --- multi-hour outages where every session sat blocked and nothing ever tried again.
  # --- 2026-09-17 QA review #13: the decision runs in shadow too (proposed, never
  # --- acted on) so parity has visibility into what live would have done.
  $controlPlaneHealRoles = @('dispatcher', 'sentinel', 'project-lead', 'principal')
  $healStatePath = "$FleetHome\state\watchdog\heal.json"
  $healState = $null; $healStateUnreadable = $false
  try { $healState = Read-Json $healStatePath } catch { $healStateUnreadable = $true }
  # review #8: a corrupt/unreadable heal.json must fail toward NOT healing (never
  # toward a reset cap that quietly re-arms unlimited retries) - skip the whole
  # decision this tick rather than start from an empty (and wrong) attempt history.
  if (-not $healStateUnreadable -and -not $healState) { $healState = [pscustomobject]@{} }
  $healWindowStart = $now.AddHours(-$healWindowHours)
  $healed = @()
  $healChanged = $false
  $healRespawnInvocations = 0
  $healRespawnInvocationCap = 2   # review #2: same per-tick cap as sentinel-check's own verify cap
  if (-not $healStateUnreadable -and $check) {
    foreach ($e in @($check.escalate | Where-Object { "$($_.kind)" -eq 'blocked' })) {
      $healName = "$($e.name)"
      if (-not $healName) { continue }
      $healRow = $daemon | Where-Object { "$($_.name)" -eq $healName } | Sort-Object { ConvertTo-UtcDateTime $_.startedAt } -Descending | Select-Object -First 1
      # review #5 (Cory's ruling pending): `^approve ` alone does not cover
      # AskUserQuestion or a plain human wait (sentinel-check's own comment says
      # so). Until ruled, heal ONLY when the job state read cleanly AND `needs` is
      # a present, empty (or whitespace) string; any non-empty needs, a missing
      # key, or an unreadable job state is NOT healed, recorded with why.
      $healJs = $null; $healJsReadOk = $false
      if ($healRow) { try { $healJs = Get-JobState $healRow.id; $healJsReadOk = $true } catch { $healJsReadOk = $false } }
      $healNeedsOk = $false; $healNeedsReason = ''
      if (-not $healRow) { $healNeedsReason = 'no daemon row to read job state from' }
      elseif (-not $healJsReadOk -or $null -eq $healJs) { $healNeedsReason = 'job state unreadable' }
      elseif (-not $healJs.PSObject.Properties['needs']) { $healNeedsReason = 'job state has no needs key' }
      elseif ("$($healJs.needs)".Trim() -ne '') { $healNeedsReason = "needs is not empty: $(Get-OneLine "$($healJs.needs)" 100)" }
      else { $healNeedsOk = $true }
      if (-not $healNeedsOk) {
        $healed += [pscustomobject]@{ name = $healName; role = "$($e.role)"; tenant = "$($e.tenant)"; action = 'none'; ok = $false; proposed = ($mode -ne 'live'); reason = "not healed: $healNeedsReason" }
        continue
      }
      # review #7: a MISSING heartbeat file must read as stale for healing too,
      # exactly as fleet-dead's own staleStatics already treats it (Get-
      # HeartbeatAgeMinutes returns $null for "never seen"; only a real,
      # non-stale age skips healing).
      $healAge = Get-HeartbeatAgeMinutes $healName
      if ($null -ne $healAge -and $healAge -le $healStaleMinutes) { continue }
      $healPrior = $null
      if ($healState.PSObject.Properties[$healName]) { $healPrior = $healState.$healName }
      $healPriorAttempts = @()
      if ($healPrior -and $healPrior.PSObject.Properties['attempts']) { $healPriorAttempts = @($healPrior.attempts | Where-Object { $_ }) }
      $healRecentAttempts = @($healPriorAttempts | Where-Object { $ts = ConvertTo-UtcDateTime $_; $ts -and $ts -ge $healWindowStart })
      if ($healRecentAttempts.Count -ge $healCap) { continue }   # past the cap: the stale heartbeat stands for fleet-dead, not retried in silence
      # Test-WorkWaiting (ticket 75): computed here, lazily, only for a candidate that
      # already cleared needs/heartbeat - a healthy fleet never pays for the extra
      # planner call. A session with no single tenant (dispatcher, sentinel) is
      # healed when ANY tenant has work waiting; a scoped role (project-lead,
      # principal, an IC) checks only its own.
      $healTenantName = "$($e.tenant)"
      $healWorkWaiting = $false
      $healWakeState = $null; try { $healWakeState = Read-Json "$FleetHome\state\watchdog\frontier-wake.json" } catch {}
      $healTenantFiles = if ($healTenantName) { @(Get-ChildItem "$FleetHome\tenants" -Filter "$healTenantName.json" -ErrorAction SilentlyContinue) } else { @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue) }
      foreach ($healTenantFile in $healTenantFiles) {
        $healTenantObj = $null; try { $healTenantObj = Read-Json $healTenantFile.FullName } catch { continue }
        if (-not $healTenantObj) { continue }
        $healTName = "$($healTenantObj.name)"; if (-not $healTName) { $healTName = $healTenantFile.BaseName }
        if (Test-WorkWaiting -TenantName $healTName -Tenant $healTenantObj -NodeExe $nodeExe -LiveRoster $liveRoster -LiveCount $liveCount -Cap $cap -WakeState $healWakeState) { $healWorkWaiting = $true; break }
      }
      if (-not $healWorkWaiting) { continue }
      $healRole = "$($e.role)"
      $healAction = if ($controlPlaneHealRoles -contains $healRole) { 'rotate' } else { 'respawn' }
      $healReason = "heal: blocked, heartbeat $(if ($null -eq $healAge) { 'never seen' } else { "$([int]$healAge)m" }) stale (threshold $healStaleMinutes), work waiting"

      if ($mode -ne 'live') {
        # review #13: proposed only - no rotate.ps1/sentinel-check.ps1 call, no
        # heal.json write, so shadow ticks never burn the live cap.
        $healed += [pscustomobject]@{ name = $healName; role = $healRole; tenant = $healTenantName; action = $healAction; ok = $null; proposed = $true; reason = $healReason; attempt = $healRecentAttempts.Count + 1 }
        continue
      }
      $healOk = $false
      $healOutcome = $null
      $healActuallyRan = $false
      if ($healAction -eq 'rotate') {
        $healRaw = ''; $healOut = $null
        try { $healRaw = & "$PSScriptRoot\rotate.ps1" -Name $healName -Wake $healReason 2>&1 | Out-String; $healOut = ConvertFrom-LastJsonLine $healRaw } catch {}
        $healOk = [bool]($healOut -and $healOut.PSObject.Properties['rotated'] -and (@($healOut.rotated) -contains $healName))
        $healOutcomeStatus = $null
        if ($healOut -and $healOut.PSObject.Properties['outcomes']) { $healOutcomeStatus = "$((@($healOut.outcomes | Where-Object { $_.name -eq $healName }) | Select-Object -First 1).status)" }
        # review #4: rotate.ps1 answers rotated=@() for PAUSE, rotation-off AND a
        # deferred safe boundary alike - none of those touched any state, so none
        # may burn the 24h attempt budget. A 'failed' outcome DID act (it stopped
        # the old session before the relaunch failed) and still counts.
        $healActuallyRan = $healOk -or ($healOutcomeStatus -eq 'failed')
        $healOutcome = if ($healOut) { $healOut } else { Get-OneLine $healRaw 200 }
      } else {
        if ($healRespawnInvocations -ge $healRespawnInvocationCap) {
          $healed += [pscustomobject]@{ name = $healName; role = $healRole; tenant = $healTenantName; action = $healAction; ok = $false; deferred = $true; reason = "$healReason (deferred: $healRespawnInvocationCap heal-respawn calls already made this tick)" }
          continue
        }
        $healRespawnInvocations++
        $healRespawnReportPath = "$FleetHome\state\watchdog\last-heal-respawn.json"
        $healRaw = ''; $healOut = $null
        # sentinel-check.ps1 prints its report with ConvertTo-Json -Depth 6 (no
        # -Compress) - a multi-line pretty JSON that ConvertFrom-LastJsonLine
        # (which reads only the LAST line) cannot parse. -ReportPath is the
        # canonical source (Read-Json parses the whole file), matching how
        # watchdog.ps1 already reads the main check's own report; stdout is
        # captured only for the failure-message fallback below.
        try { $healRaw = & "$PSScriptRoot\sentinel-check.ps1" -Apply -Actor watchdog -HealRespawn $healName -ReportPath $healRespawnReportPath 2>&1 | Out-String } catch {}
        try { $healOut = Read-Json $healRespawnReportPath } catch {}
        $healOk = [bool]($healOut -and @($healOut.respawned | Where-Object { "$($_.name)" -eq $healName }).Count -gt 0)
        $healOutcome = if ($healOut) { $healOut } else { Get-OneLine $healRaw 200 }
        $healActuallyRan = $true   # the call was issued regardless of outcome (a no-op still counts, ticket 85)
      }
      if (-not $healActuallyRan) {
        # review #4: a refusal is recorded, with its reason, and never counted.
        $healed += [pscustomobject]@{ name = $healName; role = $healRole; tenant = $healTenantName; action = $healAction; ok = $false; refused = $true; reason = $healReason; outcome = $healOutcome; attempt = $healRecentAttempts.Count }
        continue
      }
      $healPriorAttempts += (Now-Iso)
      # review #11: prune to the 24h window on write - heal.json must not grow
      # forever for a session that heals occasionally over months.
      $healPrunedAttempts = @($healPriorAttempts | Where-Object { $ts = ConvertTo-UtcDateTime $_; $ts -and $ts -ge $healWindowStart })
      $healState | Add-Member -NotePropertyName $healName -NotePropertyValue ([pscustomobject]@{ attempts = @($healPrunedAttempts); lastAction = $healAction; lastOk = $healOk; lastAt = (Now-Iso) }) -Force
      $healChanged = $true
      $healed += [pscustomobject]@{ name = $healName; role = $healRole; tenant = $healTenantName; action = $healAction; ok = $healOk; reason = $healReason; outcome = $healOutcome; attempt = $healRecentAttempts.Count + 1 }
    }
  }
  if ($healChanged) {
    # review #9: atomic (temp file + move), never a torn write a crash mid-write
    # could leave, and always a merge (this tick's changes over the full prior
    # object) rather than a wholesale replace.
    try { $healTmpPath = "$healStatePath.tmp"; Write-Json $healTmpPath $healState; Move-Item -Force $healTmpPath $healStatePath } catch {}
  }

  # --- frontier wake (ticket 09, ruling 2, Cory 2026-09-09). No script can message a
  # --- session, so the only wake a script can deliver is a relaunch: when a tenant's lead
  # --- is idle at a turn boundary and there is work it cannot see (the planner's frontier
  # --- is non-empty with a free IC slot, or the PR watcher recorded a checks-settled /
  # --- checks-failed / decision-needed wake since the lead's current session started), the
  # --- lead is rotated NOW through rotate.ps1 -Wake: stop at the boundary, reconcile,
  # --- relaunch through the one door, so the replacement reconstructs from state exactly as
  # --- a rotated lead does. This retires the lead's hourly polling cron. Loop guards: one
  # --- wake per tenant per tick; never twice for the same evidence inside
  # --- frontierWake.cooldownMinutes; the boundary, PAUSE and rotation-off still apply
  # --- inside rotate.ps1; state/flags/frontier-wake-off disables it. Every executed wake is
  # --- a log-only entry in state/alerts/alerts.jsonl (ticket 76, ADR 0012: a wake of a
  # --- session is logged and never paged); Write-FleetWakeAudit keeps the same line
  # --- shape Send-FleetAlert used to write, with paged:false.
  $frontierWakes = @()
  $wakeConfig = $null; try { $wakeConfig = (Read-Json "$FleetHome\config\cycle.json").frontierWake } catch {}
  $wakeCooldown = 60; if ($wakeConfig -and $wakeConfig.PSObject.Properties['cooldownMinutes']) { $wakeCooldown = [int]$wakeConfig.cooldownMinutes }
  $wakeSources = @('frontier', 'outbox'); if ($wakeConfig -and $wakeConfig.PSObject.Properties['sources']) { $wakeSources = @($wakeConfig.sources | ForEach-Object { "$_" }) }
  $wakeStatePath = "$FleetHome\state\watchdog\frontier-wake.json"
  $wakeState = $null; try { $wakeState = Read-Json $wakeStatePath } catch {}
  if (-not $wakeState) { $wakeState = [pscustomobject]@{ tenants = [pscustomobject]@{} } }
  if ($null -eq $wakeState.PSObject.Properties['tenants']) { $wakeState | Add-Member -NotePropertyName tenants -NotePropertyValue ([pscustomobject]@{}) -Force }
  $wakeOff = Test-Path "$FleetHome\state\flags\frontier-wake-off"
  if ($mode -eq 'live' -and -not $Verify -and -not $paused -and -not $wakeOff) {
    # nodeExe, liveRoster, cap and liveCount are computed once above (ticket 75:
    # fleet-dead's Test-WorkWaiting needs them too, before this block even runs).
    foreach ($tenantFile in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)) {
      $tenant = $null; try { $tenant = Read-Json $tenantFile.FullName } catch {}
      if (-not $tenant) { continue }
      $tenantName = "$($tenant.name)"; if (-not $tenantName) { $tenantName = $tenantFile.BaseName }
      $leadName = "pl-$tenantName"
      $wake = [ordered]@{ tenant = $tenantName; lead = $leadName; evidence = @(); decision = 'none'; reason = ''; outcome = $null; alert = $null }
      $leadRow = $daemon | Where-Object { "$($_.name)" -eq $leadName -and $_.pid } | Sort-Object { ConvertTo-UtcDateTime $_.startedAt } -Descending | Select-Object -First 1
      if (-not $leadRow) { $wake.reason = 'no running lead session (launchNeeded covers a missing one)'; $frontierWakes += [pscustomobject]$wake; continue }
      if ("$($leadRow.status)" -ne 'idle') { $wake.reason = "lead is $($leadRow.status), not idle"; $frontierWakes += [pscustomobject]$wake; continue }
      $leadStartedAt = ConvertTo-UtcDateTime $leadRow.startedAt
      # Source 1: the planner's frontier, with an IC slot and a cap slot to launch into.
      if ($wakeSources -contains 'frontier' -and $nodeExe) {
        $fw = Test-FrontierWaiting -TenantName $tenantName -Tenant $tenant -NodeExe $nodeExe -LiveRoster $liveRoster -LiveCount $liveCount -Cap $cap
        if ($fw.evidence.Count -gt 0) { $wake.evidence += $fw.evidence } elseif ($fw.reason) { $wake.reason = $fw.reason }
      }
      # Source 2: PR-watcher wakes recorded since this lead session started and not yet delivered.
      if ($wakeSources -contains 'outbox') {
        $tenantState = $null; if ($wakeState.tenants.PSObject.Properties[$tenantName]) { $tenantState = $wakeState.tenants.$tenantName }
        $consumedThrough = $null; if ($tenantState -and $tenantState.outboxConsumedThrough) { $consumedThrough = ConvertTo-UtcDateTime $tenantState.outboxConsumedThrough }
        $kinds = Get-UnconsumedWakes -TenantName $tenantName -Since $leadStartedAt -ConsumedThrough $consumedThrough
        if ($kinds.Count -gt 0) { $wake.evidence += "outbox $(@($kinds.GetEnumerator() | ForEach-Object { "$($_.Key) x$($_.Value)" }) -join ', ')" }
      }
      if ($wake.evidence.Count -eq 0) { if (-not $wake.reason) { $wake.reason = 'nothing to wake for' }; $frontierWakes += [pscustomobject]$wake; continue }
      # Cooldown: the same evidence within the window means the last wake did not clear it; do not loop.
      $digest = ($wake.evidence -join '; ')
      $tenantState = $null; if ($wakeState.tenants.PSObject.Properties[$tenantName]) { $tenantState = $wakeState.tenants.$tenantName }
      if ($tenantState -and "$($tenantState.digest)" -eq $digest -and $tenantState.lastAt) {
        $lastAt = ConvertTo-UtcDateTime $tenantState.lastAt
        if ($lastAt -and ($now - $lastAt).TotalMinutes -lt $wakeCooldown) {
          $wake.decision = 'cooldown'; $wake.reason = "same evidence woken at $($tenantState.lastAt); cooldown $wakeCooldown min"
          $frontierWakes += [pscustomobject]$wake; continue
        }
      }
      $wake.decision = 'wake'
      $rotateRaw = ''; $rotateOut = $null
      try { $rotateRaw = & "$PSScriptRoot\rotate.ps1" -Name $leadName -Wake $digest 2>&1 | Out-String; $rotateOut = ConvertFrom-LastJsonLine $rotateRaw } catch { $wake.reason = "rotate.ps1 threw: $(Get-OneLine $_.Exception.Message 200)" }
      $rotated = $false
      if ($rotateOut -and $rotateOut.PSObject.Properties['rotated']) { $rotated = (@($rotateOut.rotated) -contains $leadName) }
      $wake.outcome = if ($rotateOut -and $rotateOut.PSObject.Properties['outcomes']) { @($rotateOut.outcomes | Where-Object { $_.name -eq $leadName } | Select-Object -First 1) | Select-Object -First 1 } else { Get-OneLine $rotateRaw 200 }
      if ($rotated) {
        $wake.decision = 'woken'
        $wakeState.tenants | Add-Member -NotePropertyName $tenantName -NotePropertyValue ([pscustomobject]@{ lastAt = (Now-Iso); digest = $digest; outboxConsumedThrough = (Now-Iso) }) -Force
        # Ticket 76: a wake never toasts or POSTs; the alerts.jsonl line is the record.
        try { $wake.alert = Write-FleetWakeAudit -Kind 'frontier-wake' -Title 'Fleet watchdog: frontier wake' -Body "$leadName relaunched for $digest" -Detail ([pscustomobject]@{ tenant = $tenantName; lead = $leadName; evidence = $wake.evidence; outcome = $wake.outcome }) } catch { $wake.alert = "alert failed: $(Get-OneLine $_.Exception.Message 120)" }
      } else { $wake.decision = 'deferred'; if (-not $wake.reason) { $wake.reason = "rotate.ps1 did not rotate: $(Get-OneLine ($rotateOut | ConvertTo-Json -Compress -Depth 6) 200)" } }
      $frontierWakes += [pscustomobject]$wake
    }
    try { Write-Json $wakeStatePath $wakeState } catch {}
  }

  # --- triage wake (ADR 0011, fleet #38). The Principal's frontier (bin/triage.js) is
  # --- computed every tick and written to state/watchdog/triage-frontier.json: that file
  # --- is the shadow record Cory reads before setting the flag. Only while
  # --- state/flags/principal-live stands, in live mode, is an idle pe-<tenant> rotated for
  # --- a non-empty frontier, under the lead wake's guards: one per tenant per tick, the
  # --- same cooldown on identical evidence (state/watchdog/triage-wake.json), PAUSE, the
  # --- boundary inside rotate.ps1, and state/flags/triage-wake-off as the rollback. A
  # --- missing principal under the live flag is launchNeeded's job, not this block's. An
  # --- unreadable frontier wakes nothing (fail closed) and says so in the shadow file.
  $triageWakes = @()
  $triageOff = Test-Path "$FleetHome\state\flags\triage-wake-off"
  if (-not $Verify -and -not $triageOff) {
    $principalLive = Test-PrincipalLive
    $triageShadow = [ordered]@{ at = (Now-Iso); live = [bool]$principalLive; mode = $mode; tenants = @() }
    $triageNode = $null; try { $triageNode = Get-NodeExe } catch {}
    $triageStatePath = "$FleetHome\state\watchdog\triage-wake.json"
    $triageState = $null; try { $triageState = Read-Json $triageStatePath } catch {}
    if (-not $triageState) { $triageState = [pscustomobject]@{ tenants = [pscustomobject]@{} } }
    if ($null -eq $triageState.PSObject.Properties['tenants']) { $triageState | Add-Member -NotePropertyName tenants -NotePropertyValue ([pscustomobject]@{}) -Force }
    foreach ($tenantFile in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)) {
      $tenant = $null; try { $tenant = Read-Json $tenantFile.FullName } catch {}
      if (-not $tenant) { continue }
      $tenantName = "$($tenant.name)"; if (-not $tenantName) { $tenantName = $tenantFile.BaseName }
      $principalName = "pe-$tenantName"
      $twake = [ordered]@{ tenant = $tenantName; principal = $principalName; evidence = @(); decision = 'none'; reason = ''; outcome = $null; alert = $null; frontierError = $null; counts = $null }
      $frontier = $null
      if (-not $triageNode) { $twake.frontierError = 'node not found (FLEET_NODE_PATH or PATH)' }
      else {
        # 2026-09-17 QA (fleet #81 review #2): this call used to be unbounded and ran
        # BEFORE the PAUSE check below, so a wedged gh call stalled even a paused
        # tick. Bounded the same way the assignment.js planner call is (shared
        # Invoke-BoundedExe). The PAUSE check stays after it on purpose: this
        # frontier feeds state/watchdog/triage-frontier.json, the shadow record Cory
        # reads every tick (paused or not) to decide when to flip principal-live: it
        # must stay fresh regardless of PAUSE. Bounding is what actually fixes the
        # stall; reordering would just stop refreshing the shadow file while paused.
        $triageArgs = @('frontier', '--root', $FleetHome, '--tenant', $tenantName)
        if ($env:FLEET_TRIAGE_ISSUES_FIXTURE) { $triageArgs += @('--fixture', $env:FLEET_TRIAGE_ISSUES_FIXTURE) }
        $triageBounded = Invoke-BoundedExe -FilePath $triageNode -ArgumentList (@("$PSScriptRoot\triage.js") + $triageArgs) -TimeoutSec $frontierTimeoutSec
        if ($triageBounded.startError) { $twake.frontierError = "triage.js could not start: $(Get-OneLine $triageBounded.startError 200)" }
        elseif ($triageBounded.timedOut) { $twake.frontierError = "triage.js timed out after ${frontierTimeoutSec}s and was killed" }
        elseif ($triageBounded.exitCode -ne 0) { $twake.frontierError = "triage.js exited $($triageBounded.exitCode)`: $(Get-OneLine (($triageBounded.stdout + ' ' + $triageBounded.stderr)) 200)" }
        else { $frontier = ConvertFrom-LastJsonLine $triageBounded.stdout; if (-not $frontier) { $twake.frontierError = "triage.js returned no JSON: $(Get-OneLine $triageBounded.stdout 200)" } }
      }
      if ($frontier) {
        $twake.counts = $frontier.counts
        foreach ($item in @($frontier.eligible)) { $twake.evidence += "$($item.kind) #$($item.number)" }
        $triageShadow.tenants += [pscustomobject]@{ tenant = $tenantName; counts = $frontier.counts; proposeNow = @($frontier.proposeNow); consumedThrough = $frontier.consumedThrough; eligible = @($frontier.eligible | ForEach-Object { [pscustomobject]@{ kind = "$($_.kind)"; number = $_.number; reason = "$($_.reason)" } }); skipped = @($frontier.skipped) }
      } else { $triageShadow.tenants += [pscustomobject]@{ tenant = $tenantName; error = $twake.frontierError } }
      if (-not $principalLive) { $twake.decision = 'shadow'; $twake.reason = 'state/flags/principal-live absent: frontier recorded, nothing launched'; $triageWakes += [pscustomobject]$twake; continue }
      if ($mode -ne 'live') { $twake.reason = "supervision mode is $mode, not live"; $triageWakes += [pscustomobject]$twake; continue }
      if ($paused) { $twake.reason = 'PAUSE set'; $triageWakes += [pscustomobject]$twake; continue }
      if ($twake.frontierError) { $twake.reason = 'frontier unreadable; waking nothing (fail closed)'; $triageWakes += [pscustomobject]$twake; continue }
      if ($twake.evidence.Count -eq 0) { $twake.reason = 'nothing to wake for'; $triageWakes += [pscustomobject]$twake; continue }
      $principalRow = $daemon | Where-Object { "$($_.name)" -eq $principalName -and $_.pid } | Sort-Object { ConvertTo-UtcDateTime $_.startedAt } -Descending | Select-Object -First 1
      if (-not $principalRow) { $twake.reason = 'no running principal session (launchNeeded covers a missing one)'; $triageWakes += [pscustomobject]$twake; continue }
      if ("$($principalRow.status)" -ne 'idle') { $twake.reason = "principal is $($principalRow.status), not idle"; $triageWakes += [pscustomobject]$twake; continue }
      $tdigest = ($twake.evidence -join '; ')
      $tState = $null; if ($triageState.tenants.PSObject.Properties[$tenantName]) { $tState = $triageState.tenants.$tenantName }
      if ($tState -and "$($tState.digest)" -eq $tdigest -and $tState.lastAt) {
        $tLast = ConvertTo-UtcDateTime $tState.lastAt
        if ($tLast -and ($now - $tLast).TotalMinutes -lt $wakeCooldown) { $twake.decision = 'cooldown'; $twake.reason = "same evidence woken at $($tState.lastAt); cooldown $wakeCooldown min"; $triageWakes += [pscustomobject]$twake; continue }
      }
      $twake.decision = 'wake'
      $tRotateRaw = ''; $tRotateOut = $null
      try { $tRotateRaw = & "$PSScriptRoot\rotate.ps1" -Name $principalName -Wake $tdigest 2>&1 | Out-String; $tRotateOut = ConvertFrom-LastJsonLine $tRotateRaw } catch { $twake.reason = "rotate.ps1 threw: $(Get-OneLine $_.Exception.Message 200)" }
      $tRotated = $false
      if ($tRotateOut -and $tRotateOut.PSObject.Properties['rotated']) { $tRotated = (@($tRotateOut.rotated) -contains $principalName) }
      $twake.outcome = if ($tRotateOut -and $tRotateOut.PSObject.Properties['outcomes']) { @($tRotateOut.outcomes | Where-Object { $_.name -eq $principalName } | Select-Object -First 1) | Select-Object -First 1 } else { Get-OneLine $tRotateRaw 200 }
      if ($tRotated) {
        $twake.decision = 'woken'
        $triageState.tenants | Add-Member -NotePropertyName $tenantName -NotePropertyValue ([pscustomobject]@{ lastAt = (Now-Iso); digest = $tdigest }) -Force
        try { $twake.alert = Write-FleetWakeAudit -Kind 'triage-wake' -Title 'Fleet watchdog: triage wake' -Body "$principalName relaunched for $tdigest" -Detail ([pscustomobject]@{ tenant = $tenantName; principal = $principalName; evidence = $twake.evidence; outcome = $twake.outcome }) } catch { $twake.alert = "alert failed: $(Get-OneLine $_.Exception.Message 120)" }
      } else { $twake.decision = 'deferred'; if (-not $twake.reason) { $twake.reason = "rotate.ps1 did not rotate: $(Get-OneLine ($tRotateOut | ConvertTo-Json -Compress -Depth 6) 200)" } }
      $triageWakes += [pscustomobject]$twake
    }
    try { [IO.Directory]::CreateDirectory("$FleetHome\state\watchdog") | Out-Null; Write-Json "$FleetHome\state\watchdog\triage-frontier.json" ([pscustomobject]$triageShadow) } catch {}
    try { Write-Json $triageStatePath $triageState } catch {}
  }

  # --- page conditions ---
  # Ticket 77 (ADR 0012): every condition now carries a `kind` (for Get-PagePriority)
  # separate from its dedupe `key`, and an optional `url` (escalation file path or PR
  # URL) for Send-FleetPage - populated only once a condition actually has one to give.
  $conditions = @()
  if ($checkError) { $conditions += [pscustomobject]@{ key = 'check-failed'; kind = 'check-failed'; detail = "sentinel-check could not run or report: $(Get-OneLine $checkError 300)"; url = $null } }
  foreach ($se in $stateErrors) { $conditions += [pscustomobject]@{ key = 'state-unreadable'; kind = 'state-unreadable'; detail = $se; url = $null } }
  if ($sentinelOff -and $sentinelRow) {
    $conditions += [pscustomobject]@{ key = 'double-actor'; kind = 'double-actor'; detail = "state/flags/sentinel-off stands but a Sentinel session is running (job $($sentinelRow.id)); the supervisor stays in shadow so nothing acts twice. Stop that session (claude stop $($sentinelRow.id)) or run bin\rollback-sentinel.ps1"; url = $null }
  }
  if ($mode -eq 'live' -and $check) {
    foreach ($e in @($check.escalate)) {
      if ($pageKinds -notcontains "$($e.kind)") { continue }
      $conditions += [pscustomobject]@{ key = "escalation:$($e.name):$($e.kind)"; kind = "$($e.kind)"; detail = (Get-OneLine $e.detail 300); escalation = $e; url = $null }
    }
  }
  foreach ($pw in $permissionWaits) {
    $pwDetail = "$($pw.name) (job $($pw.job)) has waited $($pw.waitMin) min on a permission prompt no one can answer in a --bg session: $($pw.needs). Stop it (claude stop $($pw.job)) and relaunch on a model the CLI runs in auto mode, or attach and answer (claude attach $($pw.job))"
    # Keyed by job, not name: a stale daemon row and its relaunch can share a name, and one
    # key per job is also what lets a retired job's page clear while its successor's stands.
    $conditions += [pscustomobject]@{ key = "permission-wait:$($pw.name):$($pw.job)"; kind = 'permission-wait'; detail = $pwDetail; escalation = [pscustomobject]@{ name = $pw.name; kind = 'permission-wait'; detail = $pwDetail; parent = $pw.parent }; url = $null }
  }
  $escCount = @(Get-ChildItem "$FleetHome\state\escalations" -Filter *.json -ErrorAction SilentlyContinue).Count
  $checkEsc = 0; if ($check) { $checkEsc = @($check.escalate).Count }
  $pendingNote = "; $escCount escalation file(s) and $checkEsc check-reported escalation(s) have no live relay"
  # 2026-09-17 QA (fleet #84 review #3): a heal that actually succeeded THIS tick
  # counts as fresh for THIS tick's staleness - without this, a session rotated or
  # respawned moments ago (its daemon row not yet reflecting the fix) still reads
  # as stale and pages fleet-dead in the very tick self-healing acted, saying "the
  # fleet is not self-healing" while it just did. A tick where healing was
  # attempted but capped/refused (no ok:true entries) still pages normally.
  $healedOkThisTick = @($healed | Where-Object { $_.ok -eq $true }).Count -gt 0
  if ($fleetDead -and -not $healedOkThisTick) {
    $names = (@($staleStatics | ForEach-Object { "$($_.name):$($_.ageMin)m" }) -join ', ')
    $conditions += [pscustomobject]@{ key = 'fleet-dead'; kind = 'fleet-dead'; detail = "every static heartbeat is stale ($names; threshold $staleMinutes m) and work is waiting; the fleet is not self-healing$pendingNote"; url = $null }
  } elseif ($idleTick) {
    # Ticket 75: every static heartbeat is stale but nothing is waiting for any
    # tenant - a session with nothing to do takes no turns too. Recorded via the
    # shadow line's idle flag below, never a condition.
  } elseif ($sentinelStale) {
    $age = @($staleStatics | Where-Object { $_.name -eq 'sentinel' })[0].ageMin
    $conditions += [pscustomobject]@{ key = 'sentinel-stale'; kind = 'sentinel-stale'; detail = "sentinel heartbeat is $age min old (threshold $staleMinutes); respawns and escalation relay are not happening$pendingNote"; url = $null }
  }
  foreach ($ev in ($tripEvals | Where-Object { $_.page })) {
    $conditions += [pscustomobject]@{ key = "launch-retry:$($ev.name)"; kind = 'launch-retry'; detail = "$($ev.failures) consecutive failed launches of $($ev.name) (latest job $($ev.latestJob): $($ev.detail)); $($ev.disposition)"; url = $null }
  }
  # 2026-09-17 QA (fleet #85 review BLOCKER): a no-op respawn trips the same
  # launch-retry condition a genuinely failed launch does - see the
  # respawn-failed.json tracking above, since a wedged 'working' daemon row never
  # shows up in the retryTrips scan this loop reads.
  foreach ($rft in $respawnFailTrips) {
    $conditions += [pscustomobject]@{ key = "launch-retry:$($rft.name)"; kind = 'launch-retry'; detail = "$($rft.failures) consecutive respawn-failed results for $($rft.name) (latest: $($rft.reason)); a no-op respawn never changed the daemon pid"; url = $null }
  }
  # Ticket 81 (ADR 0012): a date that has passed, in config or on a Notice, is
  # a condition of its own - normal priority, one page per key, cleared the
  # moment the key or the paragraph is gone.
  $datedItems = @()
  if ($fullCycleConfig) { $datedItems += (Find-ExpiredUntilKeys -Obj $fullCycleConfig -Path 'config') }
  $datedItems += (Find-ExpiredNoticeDates)
  foreach ($d in $datedItems) {
    $conditions += [pscustomobject]@{ key = "dated:$($d.where)"; kind = 'dated'; detail = "$($d.where) passed ($($d.value)) and is still in place"; url = $null }
  }
  # 2026-09-18 QA (review 2, NIT): one name can raise launch-retry:<name> twice in
  # a tick (the daemon-row storm scan and the respawn-failed trip both key on the
  # same name) - the duplicate Add-Member below discarded silently, but a single
  # failed delivery attempt still burned two entries' worth of retry budget for
  # one condition. Dedupe by key, first-wins, before anything downstream sees them.
  $seenConditionKeys = @{}
  $conditions = @($conditions | Where-Object {
    if ($seenConditionKeys.ContainsKey($_.key)) { return $false }
    $seenConditionKeys[$_.key] = $true
    return $true
  })

  # --- page-once-DELIVERED dedupe (2026-09-17 QA, fleet #77 review BLOCKER): a key
  # --- is not "paged" (and so exempt from re-attempt) until Send-FleetPage actually
  # --- confirms delivery (pushover:true, recorded as deliveredAt). Before this fix,
  # --- paged.json was written for every condition BEFORE the send, so a page whose
  # --- delivery failed - unconfigured, a 4xx/5xx, refused, timed out - was marked
  # --- paged and never retried; with pushover.json not yet written, every standing
  # --- condition would have been permanently "paged" without ever reaching Cory.
  # --- A failed attempt (a real pushover:false, never unconfigured/creds-*) counts
  # --- toward `attempts`; past 3 the entry gives up (gaveUpAt) and a log-only line
  # --- records it, so a truly undeliverable page does not retry forever either.
  # --- `unconfigured`/`creds-unreadable`/`creds-incomplete` count as no attempt at
  # --- all and never set deliveredAt: the entry stays exactly as it was, so the
  # --- first tick after Cory wires his phone up delivers it. A corrupt paged.json
  # --- is quarantined, never fatal: the pager must not die of its own state while a
  # --- real condition stands.
  $pagedPath = "$FleetHome\state\watchdog\paged.json"
  $paged = $null
  try { $paged = Read-Json $pagedPath } catch {
    if (-not $Verify) { try { Move-Item $pagedPath "$pagedPath.corrupt-$($now.ToString('yyyyMMddTHHmmssZ'))" -Force } catch {} }
  }
  $oldKeys = @(); if ($paged) { $oldKeys = @($paged.PSObject.Properties.Name) }
  # 2026-09-18 QA (fleet #77 review 2, MAJOR): gaveUpAt was permanent until the
  # condition cleared - a wrong token in pushover.json meant 3 failed ticks, then
  # silence forever (no POST, no toast beyond the log-only page-gave-up line, no
  # fleet-dead repeat) even once Cory fixed it. A given-up entry is eligible
  # again after pages.retryAfterMinutes (default 60), or immediately once
  # state/pages/pushover.json is newer than gaveUpAt (Cory just fixed it).
  $pageMaxAttempts = 3
  if ($pagesConfig -and $pagesConfig.PSObject.Properties['maxAttempts'] -and $pagesConfig.maxAttempts) { $pageMaxAttempts = [int]$pagesConfig.maxAttempts }
  $pageRetryAfterMinutes = 60
  if ($pagesConfig -and $pagesConfig.PSObject.Properties['retryAfterMinutes'] -and $pagesConfig.retryAfterMinutes) { $pageRetryAfterMinutes = [int]$pagesConfig.retryAfterMinutes }
  $pushoverCredsPath = "$FleetHome\state\pages\pushover.json"
  $pushoverCredsMtime = $null
  if (Test-Path $pushoverCredsPath) { try { $pushoverCredsMtime = (Get-Item $pushoverCredsPath).LastWriteTimeUtc } catch {} }
  $nextPaged = [pscustomobject]@{}
  # First pass: pure state carry-forward, no side effects (safe under -Verify too).
  # A pre-this-fix entry (only firstSeen/lastSeen/detail: none of deliveredAt/
  # attempts/gaveUpAt exist) predates delivery tracking; the old code already
  # attempted every newly-seen condition the tick it appeared, so it is treated as
  # delivered at firstSeen here - this fix must not flood re-deliveries for
  # conditions the old code already paged.
  foreach ($c in $conditions) {
    $isNew = ($oldKeys -notcontains $c.key)
    $prevEntry = if ($isNew) { $null } else { $paged.($c.key) }
    $first = if ($prevEntry -and $prevEntry.PSObject.Properties['firstSeen']) { "$($prevEntry.firstSeen)" } else { (Now-Iso) }
    $deliveredAt = if ($prevEntry -and $prevEntry.PSObject.Properties['deliveredAt']) { $prevEntry.deliveredAt } else { $null }
    $attempts = 0; if ($prevEntry -and $prevEntry.PSObject.Properties['attempts']) { try { $attempts = [int]$prevEntry.attempts } catch {} }
    $lastAttemptAt = if ($prevEntry -and $prevEntry.PSObject.Properties['lastAttemptAt']) { $prevEntry.lastAttemptAt } else { $null }
    $lastError = if ($prevEntry -and $prevEntry.PSObject.Properties['lastError']) { $prevEntry.lastError } else { $null }
    $gaveUpAt = if ($prevEntry -and $prevEntry.PSObject.Properties['gaveUpAt']) { $prevEntry.gaveUpAt } else { $null }
    $repeatedAt = if ($prevEntry -and $prevEntry.PSObject.Properties['repeatedAt']) { $prevEntry.repeatedAt } else { $null }
    $url = if ($prevEntry -and $prevEntry.PSObject.Properties['url']) { $prevEntry.url } else { $null }
    if ($prevEntry -and -not ($prevEntry.PSObject.Properties['deliveredAt'] -or $prevEntry.PSObject.Properties['attempts'] -or $prevEntry.PSObject.Properties['gaveUpAt'])) {
      $deliveredAt = $first
    }
    $entryObj = [pscustomobject]@{
      firstSeen = $first; lastSeen = (Now-Iso); detail = $c.detail
      deliveredAt = $deliveredAt; attempts = $attempts; lastAttemptAt = $lastAttemptAt; lastError = $lastError; gaveUpAt = $gaveUpAt
      url = $url
    }
    if ($c.key -eq 'fleet-dead') { $entryObj | Add-Member -NotePropertyName repeatedAt -NotePropertyValue $repeatedAt -Force }
    $nextPaged | Add-Member -NotePropertyName $c.key -NotePropertyValue $entryObj
  }

  # --- banner: rebuilt every run from current conditions; absent when healthy ---
  $bannerPath = "$FleetHome\state\watchdog\banner.txt"
  $newlyPagedResults = @()
  $repeatPaged = $null
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
    $nextNotified = [pscustomobject]@{}
    foreach ($k in $currentRespawnKeys) { $nextNotified | Add-Member -NotePropertyName $k -NotePropertyValue (Now-Iso) -Force }
    Write-Json $notifiedPath $nextNotified

    # Second pass: side effects. A NEW escalation-carrying condition files its one
    # escalation file here (never re-filed while it stands) and its path becomes the
    # condition's `url`; every condition not yet delivered and not given up gets one
    # Send-FleetPage attempt this tick, at the priority its kind resolves to
    # (Get-PagePriority), carrying its link when it has one - an escalation file
    # path, or a PR URL where a condition carries one, else omitted. -NoToast (tests)
    # only skips Send-FleetPage's own toast; the Pushover POST and the pages.jsonl
    # audit line always run. The banner above is the always-on host echo and is
    # unaffected by delivery success or failure.
    foreach ($c in $conditions) {
      $isNew = ($oldKeys -notcontains $c.key)
      $entry = $nextPaged.($c.key)

      if ($isNew -and $c.PSObject.Properties['escalation'] -and $c.escalation) {
        $e = $c.escalation
        $parentName = ''; if ($e.PSObject.Properties['parent']) { $parentName = "$($e.parent)" }
        $escFile = Write-Escalation -From 'supervisor' -Kind "$($e.kind)" -Detail "$($e.detail)" -Name "$($e.name)" -Parent $parentName
        if ($escFile) { $entry.url = "$escFile" }
        $notified += [pscustomobject]@{ name = "$($e.name)"; kind = "$($e.kind)"; parent = $parentName; toastDelivered = $null }
      }
      if (-not $entry.url -and $c.PSObject.Properties['url'] -and $c.url) { $entry.url = "$($c.url)" }

      # review 2: a given-up entry gets one more chance once the retry window has
      # passed, or right away once pushover.json was touched after the give-up
      # (fail toward retrying on an unparseable gaveUpAt too). Otherwise the toast
      # still fires every tick (it is free; the on-host echo of "this is still
      # broken" should not stop just because Pushover delivery gave up).
      if ($entry.gaveUpAt) {
        $gaveUpAtUtc = ConvertTo-UtcDateTime $entry.gaveUpAt
        $eligibleAgain = (-not $gaveUpAtUtc) -or ($pushoverCredsMtime -and $pushoverCredsMtime -gt $gaveUpAtUtc) -or ((New-TimeSpan -Start $gaveUpAtUtc -End $now).TotalMinutes -ge $pageRetryAfterMinutes)
        if ($eligibleAgain) {
          $entry.gaveUpAt = $null
          $entry.attempts = 0
        } elseif (-not $NoToast) {
          try { Send-FleetToast 'Fleet watchdog' "$($c.detail) (still failing delivery; last error: $($entry.lastError))" | Out-Null } catch {}
        }
      }

      if (-not $entry.deliveredAt -and -not $entry.gaveUpAt) {
        $priority = Get-PagePriority -Kind "$($c.kind)" -PagesConfig $pagesConfig
        $pageResult = Send-FleetPage -Kind "$($c.kind)" -Title 'Fleet watchdog' -Body "$($c.detail)" -Priority $priority -Url $entry.url -Detail ([pscustomobject]@{ key = $c.key }) -NoToast:$NoToast
        # `-contains`/`-eq` against a boolean literal on the LEFT coerces any
        # non-empty string (e.g. 'unconfigured') to $true - `-is [bool]` is the
        # only type-exact way to tell a real true/false outcome from a string one.
        $countsAsAttempt = ($pageResult.pushover -is [bool])
        if ($pageResult.pushover -eq $true) {
          $entry.deliveredAt = Now-Iso
        } elseif ($countsAsAttempt) {
          $entry.attempts++
          $entry.lastAttemptAt = Now-Iso
          $entry.lastError = "$($pageResult.pushoverError)"
          if ($entry.attempts -ge $pageMaxAttempts) {
            $entry.gaveUpAt = Now-Iso
            try { Write-FleetWakeAudit -Kind 'page-gave-up' -Title 'Fleet watchdog: page delivery gave up' -Body "$($c.key) failed $($entry.attempts) delivery attempts; giving up (last error: $($entry.lastError))" -Detail ([pscustomobject]@{ key = $c.key; attempts = $entry.attempts; lastError = $entry.lastError }) | Out-Null } catch {}
          }
        }
        # A brand-new condition always reports (whatever the outcome, matching
        # "the first sighting must page"); a standing condition only reports a REAL
        # attempt (delivered or a genuine failure) - a standing unconfigured retry
        # is silent every tick until configured, never re-announced as "newly paged".
        if ($isNew -or $countsAsAttempt) { $newlyPagedResults += [pscustomobject]@{ key = $c.key; priority = $priority; page = $pageResult } }
      }

      # Ticket 78 (ADR 0012, 2026-09-17 QA review #7/#8): fleet-dead alone repeats
      # once, at +fleetDeadRepeatMinutes past its DELIVERY time (an undelivered page
      # has no repeat clock to run), never a third time. An unparseable or
      # future-dated deliveredAt fails toward repeating NOW rather than silently
      # losing the one repeat the ADR grants.
      if ($c.key -eq 'fleet-dead' -and $entry.deliveredAt -and -not $entry.repeatedAt) {
        $deliveredAtUtc = ConvertTo-UtcDateTime $entry.deliveredAt
        $dueNow = (-not $deliveredAtUtc) -or ($deliveredAtUtc -gt $now) -or ((New-TimeSpan -Start $deliveredAtUtc -End $now).TotalMinutes -ge $fleetDeadRepeatMinutes)
        if ($dueNow) {
          $entry.repeatedAt = Now-Iso
          $repeatBody = "$($c.detail) (repeat: fleet-dead has stood over $fleetDeadRepeatMinutes min with no third page to follow)"
          $repeatResult = Send-FleetPage -Kind 'fleet-dead' -Title 'Fleet watchdog' -Body $repeatBody -Priority 'emergency' -Detail ([pscustomobject]@{ key = $c.key; repeat = $true }) -NoToast:$NoToast
          $repeatPaged = [pscustomobject]@{ key = $c.key; priority = 'emergency'; page = $repeatResult }
        }
      }
    }
    Write-Json $pagedPath $nextPaged
  }

  # Ticket 81 (ADR 0012): the dead-man ping runs at the end of every tick that
  # reaches this point - PAUSE, -Verify, a live or a shadow run, all alike - and
  # is unconditional here: no `if (-not $Verify)` guard. It deliberately does NOT
  # run from the crash handler below: a Watchdog that is itself crash-looping
  # never gets here, its pings stop, and that silence is exactly what the
  # off-host dead-man service exists to catch. It never fails a tick that does
  # reach it (Send-DeadManPing never throws).
  $deadMan = Send-DeadManPing

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
    conditions = @($conditions | ForEach-Object { $_.key }); newlyPaged = $newlyPagedResults; repeatPaged = $repeatPaged
    checkError = $checkError; proposed = $proposed
    launches = $launches; notified = $notified; waiting = $waiting; healed = $healed; frontierWakes = $frontierWakes; triageWakes = $triageWakes
    staleStatics = $staleStatics; retryTrips = $tripEvals; skipWrites = $skipWrites; permissionWaits = $permissionWaits; paused = [bool]$paused; verify = [bool]$Verify; idle = [bool]$idleTick
    healStateUnreadable = [bool]$healStateUnreadable
    deadMan = $deadMan
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
