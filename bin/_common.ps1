# Shared helpers for fleet scripts (dot-source).
$script:FleetHome = Split-Path -Parent $PSScriptRoot
$script:Utf8 = New-Object System.Text.UTF8Encoding $false
function Read-Json { param($Path) if (Test-Path $Path) { Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } }
function Write-Json { param($Path, $Obj) [IO.File]::WriteAllText($Path, ($Obj | ConvertTo-Json -Depth 8), $script:Utf8) }
function Get-StaticRoster { Read-Json "$FleetHome\roster.json" }
function Test-SentinelOff { Test-Path "$FleetHome\state\flags\sentinel-off" }
# 02/03 cutover: while this flag stands the assignment planner (bin/assignment.js) is the
# authoritative frontier and launch path for ICs; the launch door refuses a legacy IC launch.
function Test-AssignmentLive { Test-Path "$FleetHome\state\flags\assignment-live" }
# ADR 0011 (fleet #38): while this flag stands the Principal (pe-<tenant>) is an expected
# static session (launched by launchNeeded, woken by the watchdog's triage wake). Absent
# the flag its roster entry is inert: nothing expects, launches, recovers or wakes it, and
# the watchdog only records the triage frontier it would have woken it for.
function Test-PrincipalLive { Test-Path "$FleetHome\state\flags\principal-live" }
# config/cycle.json cap.exemptNamePrefixes: standing control-plane names (the Principal,
# `pe-`) that neither count toward the cap nor are refused by it; the cap bounds concurrent
# worktrees and PR churn, which these sessions never produce. Absent config = nothing exempt.
function Get-CapExemptPrefixes {
  $prefixes = @()
  try { $prefixes = @((Read-Json "$FleetHome\config\cycle.json").cap.exemptNamePrefixes | Where-Object { "$_" } | ForEach-Object { "$_" }) } catch {}
  return $prefixes
}
function Test-CapExempt { param([string]$Name) foreach ($p in (Get-CapExemptPrefixes)) { if ("$Name".StartsWith($p)) { return $true } }; return $false }
# Ticket 76 (ADR 0012): the one page door. Every source that needs Cory - a decision
# event through the Notifier, or a Watchdog condition - goes through this function to
# one push service (Pushover), with a numeric priority per -Priority (emergency -> 2
# with retry/expire so Pushover keeps re-alerting until acknowledged, high -> 1,
# normal -> 0). The Windows toast stays as the on-host echo (-NoToast for tests);
# Pushover and the audit line in state/pages/pages.jsonl are the channels that always
# run. Credentials live in state/pages/pushover.json (state/ is not committed, so the
# token never lands in git) and Cory has not necessarily written that file yet: an
# unconfigured channel is a recorded result, never a throw - a condition-detecting run
# must not crash because Cory hasn't wired his phone up. FLEET_PUSHOVER_URL overrides
# the endpoint for tests (a local HttpListener).
$script:PagePriorityValues = @{ emergency = 2; high = 1; normal = 0 }
# Cory's ruling 2026-09-18 (fleet #76): Pushover's own guidance is one retry, after a
# short wait, on a 5xx, a failed connection, or a timeout with no reply at all - never
# on a 4xx (the request itself is wrong; retrying repeats the same rejection). Split
# out so Send-FleetPage can call it once, then once more, without duplicating the
# classify-and-post logic. $Response is $null for a connection failure or a timeout:
# neither ever reached an HTTP status, so both default to retryable.
function Invoke-FleetPagePost {
  param($Endpoint, $Payload, [int]$TimeoutSec = 15)
  try {
    $null = Invoke-RestMethod -Uri $Endpoint -Method Post -Body $Payload -TimeoutSec $TimeoutSec
    return [pscustomobject]@{ ok = $true; error = $null; retryable = $false }
  } catch {
    $statusCode = $null
    $response = $null
    try { $response = $_.Exception.Response } catch {}
    if ($response -and $response.PSObject.Properties['StatusCode']) { try { $statusCode = [int]$response.StatusCode } catch {} }
    $retryable = $true
    if ($statusCode -and $statusCode -ge 400 -and $statusCode -lt 500) { $retryable = $false }
    return [pscustomobject]@{ ok = $false; error = "$($_.Exception.Message)"; retryable = $retryable }
  }
}
# The 5s wait is injectable (env FLEET_PAGE_RETRY_DELAY_MS, or -RetryDelayMs) so
# tests/page.tests.ps1 does not pay the real delay for every retry case.
function Get-FleetPageRetryDelayMs {
  $ms = 5000
  if ($env:FLEET_PAGE_RETRY_DELAY_MS) { try { $ms = [int]$env:FLEET_PAGE_RETRY_DELAY_MS } catch {} }
  return $ms
}
function Send-FleetPage {
  param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Body,
    [Parameter(Mandatory = $true)][ValidateSet('emergency', 'high', 'normal')][string]$Priority,
    [string]$Url = $null,
    $Detail = $null,
    [switch]$NoToast,
    [int]$RetryDelayMs = -1   # -1 = use Get-FleetPageRetryDelayMs (env or the 5s default)
  )
  # 2026-09-17 review (fleet #76): Pushover rejects title > 250 or message > 1024
  # chars with a 400, and the page is lost. Ticket 77 routes real condition detail
  # through this door, so clamp both here - the one door - rather than at every
  # caller; an ellipsis marks a clamp, never a throw. Clamped values are what the
  # toast, the POST and the pages.jsonl audit line all see.
  $Title = "$Title"; if ($Title.Length -gt 250) { $Title = $Title.Substring(0, 247) + '...' }
  $Body = "$Body"; if ($Body.Length -gt 1024) { $Body = $Body.Substring(0, 1021) + '...' }
  $result = [ordered]@{ at = (Now-Iso); kind = $Kind; title = $Title; body = $Body; priority = $Priority; toast = $null; pushover = $null; pushoverError = $null; attempts = 0 }
  # -NoToast (tests) skips the toast only: Pushover and the audit line always run.
  if ($NoToast) { $result.toast = 'skipped' } else { try { $result.toast = Send-FleetToast $Title $Body } catch { $result.toast = $false } }
  # 2026-09-17 review (fleet #76): a malformed pushover.json (bad JSON) and a
  # half-filled one (token or user missing) both used to record the same
  # 'unconfigured' as a plain absent file - true for "never wired up", false
  # for "wired up wrong". Test-Path first distinguishes absent from present-but-
  # broken (Read-Json's own catch cannot: it returns $null for both an absent
  # file and a caught parse error). Never throws; never records token/user.
  $credsPath = "$FleetHome\state\pages\pushover.json"
  $credsExists = Test-Path $credsPath
  $creds = $null; $credsReadFailed = $false
  if ($credsExists) { try { $creds = Read-Json $credsPath } catch { $credsReadFailed = $true } }
  if (-not $credsExists) {
    $result.pushover = 'unconfigured'
  } elseif ($credsReadFailed -or -not $creds) {
    $result.pushover = 'creds-unreadable'
  } elseif (-not $creds.token -or -not $creds.user) {
    $result.pushover = 'creds-incomplete'
  } else {
    $endpoint = $env:FLEET_PUSHOVER_URL
    if (-not $endpoint) { $endpoint = 'https://api.pushover.net/1/messages.json' }
    $priorityValue = $script:PagePriorityValues[$Priority]
    $payload = @{ token = $creds.token; user = $creds.user; title = $Title; message = $Body; priority = $priorityValue }
    if ($Url) { $payload.url = $Url }
    # Pushover requires retry/expire only at priority 2 (emergency); any other
    # priority refuses the request if they are present at all.
    if ($priorityValue -eq 2) { $payload.retry = 120; $payload.expire = 7200 }
    # Cory's ruling 2026-09-18 (fleet #76): one retry, after a wait, on a 5xx, a
    # failed connection, or a timeout with no reply - never on a 4xx. A duplicate
    # Pushover delivery from a timed-out request that actually went through is
    # acceptable (Pushover's own guidance). `attempts` (1 or 2) and the final
    # result both land in the pages.jsonl audit line below unchanged.
    $post = Invoke-FleetPagePost -Endpoint $endpoint -Payload $payload
    $result.attempts = 1
    if (-not $post.ok -and $post.retryable) {
      $delayMs = if ($RetryDelayMs -ge 0) { $RetryDelayMs } else { Get-FleetPageRetryDelayMs }
      Start-Sleep -Milliseconds $delayMs
      $post = Invoke-FleetPagePost -Endpoint $endpoint -Payload $payload
      $result.attempts = 2
    }
    $result.pushover = $post.ok
    $result.pushoverError = $post.error
  }
  try {
    [IO.Directory]::CreateDirectory("$FleetHome\state\pages") | Out-Null
    $line = [ordered]@{}; foreach ($k in $result.Keys) { $line[$k] = $result[$k] }; $line.detail = $Detail
    [IO.File]::AppendAllText("$FleetHome\state\pages\pages.jsonl", (($line | ConvertTo-Json -Compress -Depth 6) + [Environment]::NewLine), $script:Utf8)
  } catch {}
  return [pscustomobject]$result
}

# Ticket 76 (ADR 0012): a wake of a session is logged and never paged (log-only kind).
# The frontier wake and the triage wake used to go through Send-FleetAlert (toast +
# webhook); that function is gone, but the audit trail state/alerts/alerts.jsonl
# already carried must stay unbroken, so this writes the same line shape with
# paged:false instead of POSTing anywhere.
function Write-FleetWakeAudit {
  param([string]$Kind, [string]$Title, [string]$Body, $Detail = $null)
  $line = [ordered]@{ at = (Now-Iso); kind = $Kind; title = $Title; body = $Body; toast = 'skipped'; webhook = 'skipped'; webhookError = $null; paged = $false; detail = $Detail }
  try {
    [IO.Directory]::CreateDirectory("$FleetHome\state\alerts") | Out-Null
    [IO.File]::AppendAllText("$FleetHome\state\alerts\alerts.jsonl", (($line | ConvertTo-Json -Compress -Depth 6) + [Environment]::NewLine), $script:Utf8)
  } catch {}
  return [pscustomobject]$line
}
function Get-ExpectedStaticSessions {
  # The static roster minus the rostered Sentinel while state/flags/sentinel-off stands
  # (ticket 08b cutover, permanent since ticket 89 retired its roster.json entry, role
  # file and rollback script): nothing expects, launches, or recovers a Sentinel session.
  param($Static)
  if (-not $Static) { $Static = Get-StaticRoster }
  $sessions = @(); if ($Static -and $Static.sessions) { $sessions = @($Static.sessions) }
  if (Test-SentinelOff) { $sessions = @($sessions | Where-Object { "$($_.role)" -ne 'sentinel' -and "$($_.name)" -ne 'sentinel' }) }
  # The inverse gate for the Principal: expected only while principal-live stands (ADR 0011).
  if (-not (Test-PrincipalLive)) { $sessions = @($sessions | Where-Object { "$($_.role)" -ne 'principal' -and "$($_.name)" -notmatch '^pe-' }) }
  return $sessions
}
function Get-LiveRoster {
  $p = "$FleetHome\state\roster.json"
  $r = Read-Json $p
  if (-not $r) { $r = [pscustomobject]@{ sessions = @() } }
  if ($null -eq $r.sessions) { $r | Add-Member -NotePropertyName sessions -NotePropertyValue @() -Force }
  $r.sessions = @($r.sessions)
  return $r
}
function Save-LiveRoster { param($R) Write-Json "$FleetHome\state\roster.json" $R }
function Get-DaemonSessions {
  # A failed read and an empty fleet are different facts. Without -Strict both still
  # collapse to @() (read-only callers tolerate it); with -Strict a nonzero exit,
  # empty output, or unparseable JSON throws so actuators can fail CLOSED. The
  # 2026-09-01 near-miss: one glitched read told the Sentinel every session was
  # missing while the same source disarmed launch.ps1's duplicate and cap guards.
  param([switch]$All, [switch]$Strict)
  $raw = if ($All) { & claude agents --json --all 2>$null } else { & claude agents --json 2>$null }
  $exit = $LASTEXITCODE
  $text = ($raw | Out-String).Trim()
  if ($exit -ne 0 -or -not $text) {
    if ($Strict) { $shape = if ($text) { 'nonempty' } else { 'empty' }; throw "daemon session list unreadable (claude agents exit $exit, output $shape)" }
    return @()
  }
  # PS 5.1 quirk: ConvertFrom-Json emits a JSON array as ONE object; assign first so @() doesn't nest it.
  try { $obj = ($text | ConvertFrom-Json) } catch {
    if ($Strict) { throw "daemon session list unparseable: $(($text -replace '\s+', ' ').Substring(0, [Math]::Min(120, $text.Length)))" }
    return @()
  }
  if ($null -eq $obj) { return @() }
  return @($obj)
}
function Get-JobState { param($Id) Read-Json "$env:USERPROFILE\.claude\jobs\$Id\state.json" }
# fleet #149: the daemon's `busy` covers two standings. Mid-turn: the model is working.
# Between turns: the model ended its turn, but a background task it started (a shell
# loop, a Monitor) is still in flight, and a leaked one never ends (pe-endzone,
# 2026-09-24: two `until` loops kept it busy for 8h, and every wake and respawn skipped
# it). The signal is the job's state.json: inFlight.kinds is only background kinds, and
# updatedAt, which the daemon moves with every state report and timeline line, is at
# least QuietMinutes old. Neither the state label nor the timeline's last entry marks a
# turn boundary: a lead routinely ends its turn on a `working` report. A subagent
# (local_agent) or any kind not listed ends in a turn of the model's own and stays busy.
# Standing: idle | background (busy, but between turns) | turn (busy, mid-turn) |
# unreadable (busy, job state missing or unparseable) | the raw status otherwise.
$script:BackgroundTaskKinds = @('local_bash', 'monitor', 'monitor_ws', 'session_cron')
function Get-BusyQuietMinutes {
  $q = 60
  try { $wd = (Read-Json "$FleetHome\config\cycle.json").watchdog; if ($wd -and $wd.PSObject.Properties['busyQuietMinutes']) { $q = [double]$wd.busyQuietMinutes } } catch {}
  return $q
}
function Get-BusyStanding {
  param($Row, [double]$QuietMinutes = 60, $Now = $null)
  if ($null -eq $Now) { $Now = (Get-Date).ToUniversalTime() }
  $status = "$($Row.status)"
  if ($status -ne 'busy') { return [pscustomobject]@{ standing = $status; reason = "status $status"; quietMin = $null } }
  $js = $null
  try { $js = Get-JobState $Row.id } catch { return [pscustomobject]@{ standing = 'unreadable'; reason = "busy; job state unreadable ($(("$($_.Exception.Message)" -replace '\s+', ' ').Trim()))"; quietMin = $null } }
  if (-not $js) { return [pscustomobject]@{ standing = 'unreadable'; reason = 'busy; job state missing'; quietMin = $null } }
  $quiet = $null
  $updated = $null; if ($js.PSObject.Properties['updatedAt']) { $updated = ConvertTo-UtcDateTime $js.updatedAt }
  if ($updated) { $quiet = [int][Math]::Floor(($Now - $updated).TotalMinutes) }
  $tasks = 0; $kinds = @()
  if ($js.PSObject.Properties['inFlight'] -and $js.inFlight) { try { $tasks = [int]$js.inFlight.tasks } catch {}; $kinds = @($js.inFlight.kinds | Where-Object { $_ } | ForEach-Object { "$_" }) }
  if ($tasks -lt 1 -or $kinds.Count -eq 0) { return [pscustomobject]@{ standing = 'turn'; reason = 'busy, nothing in flight: mid-turn'; quietMin = $quiet } }
  $foreground = @($kinds | Where-Object { $script:BackgroundTaskKinds -notcontains $_ } | Select-Object -Unique)
  if ($foreground.Count -gt 0) { return [pscustomobject]@{ standing = 'turn'; reason = "busy, $($foreground -join '+') in flight"; quietMin = $quiet } }
  if ($null -eq $quiet) { return [pscustomobject]@{ standing = 'unreadable'; reason = 'busy; job state has no readable updatedAt'; quietMin = $null } }
  if ($quiet -lt $QuietMinutes) { return [pscustomobject]@{ standing = 'turn'; reason = "busy, job reported $quiet min ago"; quietMin = $quiet } }
  return [pscustomobject]@{ standing = 'background'; reason = "busy only with background $(@($kinds | Select-Object -Unique) -join '+') x$tasks; job quiet $quiet min (threshold $QuietMinutes)"; quietMin = $quiet }
}
# Claude Code 2.1.281 refuses `claude --bg` in a workspace whose trust dialog was never
# accepted ("Workspace not trusted. Run `claude` in <dir> once and accept the trust
# prompt, then retry.") and creates no session; earlier builds skipped the dialog for
# background sessions. Trust lives in ~/.claude.json `projects.<path>.hasTrustDialogAccepted`
# and inherits from a trusted ancestor (verified 2026-09-23: a fresh subdirectory of the
# trusted C: repo launched, the untrusted E: repo root did not, and three #1579 launches
# into a fresh worktree under it produced no session). Paths compare with either slash
# and without case; a missing or unreadable config is untrusted (fail closed).
function Test-WorkspaceTrusted {
  param([string]$Path)
  # Node, not ConvertFrom-Json: the CLI writes project keys that differ only in case
  # ('C:/x' and 'c:/x'), which Windows PowerShell rejects as duplicate keys, and a
  # failed parse would read every workspace as untrusted.
  $cfgPath = "$env:USERPROFILE\.claude.json"
  if (-not (Test-Path -LiteralPath $cfgPath)) { return $false }
  $js = "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8').replace(/^\uFEFF/,''));for(const [k,v] of Object.entries(j.projects||{})){if(v&&v.hasTrustDialogAccepted===true)console.log(k)}"
  $lines = $null
  try { $lines = & (Get-NodeExe) -e $js $cfgPath 2>$null } catch { return $false }
  if ($LASTEXITCODE -ne 0) { return $false }
  $trusted = @($lines | Where-Object { $_ } | ForEach-Object { ("$_" -replace '\\', '/').TrimEnd('/') })
  $probe = ("$Path" -replace '\\', '/').TrimEnd('/')
  while ($probe) {
    foreach ($tp in $trusted) { if ([string]::Equals($tp, $probe, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
    $idx = $probe.LastIndexOf('/')
    if ($idx -le 0) { break }
    $probe = $probe.Substring(0, $idx)
    if ($probe -match '^[A-Za-z]:$') { break }
  }
  return $false
}
function Get-FleetNames {
  param($Live, $Static)
  $n = @((Get-ExpectedStaticSessions $Static) | ForEach-Object { $_.name })
  $n += @($Live.sessions | Where-Object { $_.status -eq 'active' } | ForEach-Object { $_.name })
  $n | Select-Object -Unique
}
function ConvertTo-UtcDateTime {
  # Daemon rows carry startedAt as Int64 epoch ms; heartbeats and reports carry ISO
  # strings. A stamp with no offset is taken as UTC (fail-safe: a local-time assumption
  # reads hours fresh); anything unparseable is $null, never a throw.
  param($Value)
  if ($null -eq $Value -or "$Value" -eq '') { return $null }
  try {
    if ("$Value" -match '^\d{12,14}$') { return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Value).UtcDateTime }
    return [DateTimeOffset]::Parse("$Value", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime
  } catch { return $null }
}
function Test-Paused { Test-Path "$FleetHome\state\PAUSE" }
function Now-Iso { (Get-Date).ToUniversalTime().ToString('o') }
function Get-NodeExe {
  # FLEET_NODE_PATH first (Task Scheduler runs without the login PATH), then PATH.
  $nodePath = $env:FLEET_NODE_PATH
  if ($nodePath) {
    if (Test-Path -LiteralPath $nodePath -PathType Leaf) { return $nodePath }
    throw "FLEET_NODE_PATH does not point to a Node executable: $nodePath"
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node was not found. Set FLEET_NODE_PATH to the node.exe used by the fleet.' }
  return $node.Source
}
# fleet #101: every read-only child a Watchdog tick starts (node, gh, git) runs
# through Invoke-BoundedExe - Start-Process + WaitForExit + Kill, output via temp
# files - and a timeout is recorded by name in $script:BoundedTimeouts, so a
# wedged call costs its own bound and the shadow line says which one it was,
# instead of the tick (or the check's 180s) absorbing it unnamed. Lifted from
# watchdog.ps1 (ticket 75 review) so sentinel-check.ps1 shares the one shape.
$script:BoundedTimeouts = New-Object System.Collections.ArrayList
function ConvertTo-ProcessArgument {
  param([string]$Arg)
  if ($Arg -and $Arg -notmatch '[\s"]') { return $Arg }
  $escaped = ($Arg -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}
function Invoke-BoundedExe {
  param([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSec, [string]$Name = '')
  $result = [pscustomobject]@{ timedOut = $false; exitCode = $null; stdout = ''; stderr = ''; startError = $null }
  $childOut = [IO.Path]::GetTempFileName(); $childErr = [IO.Path]::GetTempFileName()
  try {
    $argLine = (@($ArgumentList) | Where-Object { $null -ne $_ } | ForEach-Object { ConvertTo-ProcessArgument "$_" }) -join ' '
    $startArgs = @{ FilePath = $FilePath; NoNewWindow = $true; PassThru = $true; RedirectStandardOutput = $childOut; RedirectStandardError = $childErr }
    if ($argLine) { $startArgs.ArgumentList = $argLine }
    $p = Start-Process @startArgs
    # 2026-09-17 QA repro: .NET only latches the exit-code plumbing once something
    # touches the process handle; skip this and a fast-exiting child's .ExitCode
    # reads back $null even on a clean exit.
    $null = $p.Handle
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      try { $p.Kill() } catch {}
      $result.timedOut = $true
      $label = if ($Name) { $Name } else { [IO.Path]::GetFileName($FilePath) }
      [void]$script:BoundedTimeouts.Add([pscustomobject]@{ call = $label; timeoutSec = $TimeoutSec; at = (Now-Iso) })
    } else {
      $result.exitCode = $p.ExitCode
    }
  } catch { $result.startError = "$($_.Exception.Message)" }
  finally {
    try { $result.stdout = Get-Content $childOut -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
    try { $result.stderr = Get-Content $childErr -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
    # 2026-09-18 QA (review 2, NIT): on the timeout path the just-killed process
    # can still hold its redirect handles for a moment; one short-delay retry,
    # then give up silently (never fail the tick over two leaked temp files).
    try { Remove-Item $childOut, $childErr -ErrorAction Stop } catch {
      Start-Sleep -Milliseconds 200
      try { Remove-Item $childOut, $childErr -ErrorAction SilentlyContinue } catch {}
    }
  }
  return $result
}
# A command by name (gh, git) resolved to something Start-Process can run: an
# .exe/.cmd/.bat on PATH, never a .ps1 shim or an extensionless sh script.
function Resolve-ExePath {
  param([string]$Command)
  $hit = Get-Command $Command -CommandType Application -All -ErrorAction SilentlyContinue | Where-Object { @('.exe', '.cmd', '.bat') -contains [IO.Path]::GetExtension($_.Source).ToLowerInvariant() } | Select-Object -First 1
  if ($hit) { return $hit.Source }
  return $null
}
function Invoke-BoundedCommand {
  # Invoke-BoundedExe for a PATH command. A command that cannot be resolved is a
  # startError, which every caller already treats as a failed lookup.
  param([string]$Command, [string[]]$ArgumentList, [int]$TimeoutSec = 30, [string]$Name = '')
  $exe = Resolve-ExePath $Command
  if (-not $exe) { return [pscustomobject]@{ timedOut = $false; exitCode = $null; stdout = ''; stderr = ''; startError = "$Command not found on PATH" } }
  if (-not $Name) { $Name = "$Command $((@($ArgumentList) | Select-Object -First 2) -join ' ')" }
  return Invoke-BoundedExe -FilePath $exe -ArgumentList $ArgumentList -TimeoutSec $TimeoutSec -Name $Name
}
function ConvertFrom-LastJsonLine {
  param($Text)
  try { return ("$Text".Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}
function Write-Escalation {
  # -Name / -Parent (ticket 08b) name the session the escalation is about and who owns
  # it on the reporting line; older callers omit them. The file name carries the kind
  # and name so two escalations in one second do not collide.
  param($From, $Kind, $Detail, $Name = '', $Parent = '')
  [IO.Directory]::CreateDirectory("$FleetHome\state\escalations") | Out-Null
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $obj = [ordered]@{ at = (Now-Iso); from = $From; kind = $Kind; detail = $Detail }
  $suffix = ''
  if ($Name) { $obj.name = $Name; $suffix = "-$(($Name -replace '[^a-zA-Z0-9_.-]', '_'))" }
  if ($Parent) { $obj.parent = $Parent }
  if ($Name -and $Kind) { $suffix = "$suffix-$(($Kind -replace '[^a-zA-Z0-9_.-]', '_'))" }
  $file = "$FleetHome\state\escalations\$stamp-$From$suffix.json"
  Write-Json $file ([pscustomobject]$obj)
  # 2026-09-17 QA (fleet #77 review #6): returning the path lets a caller (the
  # Watchdog's page conditions) carry it as the condition's `url` without
  # recomputing the filename; existing callers all discard the return value.
  return $file
}
function Send-FleetToast {
  # Windows toast through the PowerShell AppUserModelId (no BurntToast dependency).
  # Returns $true only when Show() returned; a failed toast is recorded by the
  # caller, never retried here.
  param($Title, $Body)
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $t = [Security.SecurityElement]::Escape($Title)
    $b = [Security.SecurityElement]::Escape($Body)
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast scenario=`"urgent`"><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$b</text></binding></visual></toast>")
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
    return $true
  } catch { return $false }
}

# Spec fleet #93 / #153 (ADR 0015): the fleet acts on GitHub as its own login.
# bin/identity.js is the one reader of the secret gh config directory; these wrap
# it for the PowerShell doors (launch.ps1, watchdog.ps1). A plan that cannot be
# read at all is a refusal (FLEET_IDENTITY_UNREADABLE), never a silent keyring login.
# The node call is bounded (-TimeoutSec). -Cached (the Watchdog, every tick) first
# reuses state/identity/plan-cache.json while its key still matches: the identity
# overrides, each tenant file's and hosts.yml's write time. A normal tick then spawns
# no node at all, and a wedged node cannot wedge the tick (watchdog FD10).
function Get-FleetIdentityCacheKey {
  $dir = if ($env:FLEET_IDENTITY_DIR) { "$env:FLEET_IDENTITY_DIR" } else { Join-Path "$env:USERPROFILE" '.fleet-identity\gh' }
  $parts = @("dir=$dir")
  foreach ($f in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue | Sort-Object Name)) { $parts += "$($f.Name)=$($f.LastWriteTimeUtc.Ticks)" }
  foreach ($name in 'hosts.yml', 'gitconfig') { $p = Join-Path $dir $name; $parts += "$name=$(if (Test-Path -LiteralPath $p) { (Get-Item -LiteralPath $p).LastWriteTimeUtc.Ticks } else { 'absent' })" }
  return ($parts -join ';')
}
function Get-FleetIdentityPlan {
  param([switch]$Cached, [int]$TimeoutSec = 15)
  $cacheFile = "$FleetHome\state\identity\plan-cache.json"
  $key = $null
  if ($Cached) {
    $key = Get-FleetIdentityCacheKey
    $hit = $null; try { $hit = Read-Json $cacheFile } catch {}
    if ($hit -and "$($hit.key)" -eq $key -and $hit.plan) { return $hit.plan }
  }
  $out = $null
  try {
    $bounded = Invoke-BoundedExe -FilePath (Get-NodeExe) -ArgumentList @("$FleetHome\bin\identity.js", 'plan', '--root', "$FleetHome") -TimeoutSec $TimeoutSec -Name 'identity.js plan'
    $out = if ($bounded.timedOut) { "timed out after $TimeoutSec s" } elseif ($bounded.startError) { $bounded.startError } else { "$($bounded.stdout)$($bounded.stderr)" }
  } catch { $out = "$($_.Exception.Message)" }
  $plan = ConvertFrom-LastJsonLine $out
  if ($plan -and $plan.PSObject.Properties['required'] -and $Cached -and -not $plan.refusal) {
    # Key recomputed after the call: identity.js may have (re)written gitconfig.
    try { [IO.Directory]::CreateDirectory("$FleetHome\state\identity") | Out-Null; Write-Json $cacheFile ([pscustomobject]@{ key = (Get-FleetIdentityCacheKey); at = (Now-Iso); plan = $plan }) } catch {}
  }
  if (-not $plan -or -not $plan.PSObject.Properties['required']) {
    $why = ("$out" -replace '\s+', ' ').Trim(); if ($why.Length -gt 300) { $why = $why.Substring(0, 300) }
    return [pscustomobject]@{ required = $true; present = $false; login = $null; env = [pscustomobject]@{}; refusal = [pscustomobject]@{ code = 'FLEET_IDENTITY_UNREADABLE'; message = "bin\identity.js plan did not answer: $why" } }
  }
  return $plan
}
# One high-priority page per distinct refusal code; cleared once a plan has no
# refusal, so the next failure pages again. state/identity/paged.json is the marker.
function Send-FleetIdentityPageOnce {
  param($Plan, [string]$Source, [switch]$NoToast)
  if ($env:FLEET_NO_TOAST -eq '1') { $NoToast = [switch]::Present }   # tests: the audit line and Pushover, no desktop toast
  $markerDir = "$FleetHome\state\identity"
  $marker = "$markerDir\paged.json"
  if (-not $Plan.refusal) { Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue; return $false }
  $prior = $null; try { $prior = Read-Json $marker } catch {}
  if ($prior -and "$($prior.code)" -eq "$($Plan.refusal.code)") { return $false }
  [IO.Directory]::CreateDirectory($markerDir) | Out-Null
  Write-Json $marker ([pscustomobject]@{ code = "$($Plan.refusal.code)"; at = (Now-Iso); source = $Source })
  try { Send-FleetPage -Kind 'fleet-identity' -Title "Fleet identity: $($Plan.refusal.code)" -Body "$Source refused: $($Plan.refusal.message)" -Priority high -NoToast:$NoToast | Out-Null } catch {}
  return $true
}
# The Watchdog's own process (and every git/gh/node child it starts) carries the
# same environment a launched session does. Returns the plan so the caller can
# report a refusal. A refusal fails CLOSED for GitHub: gh gets a token that
# authenticates as nobody and git a system gitconfig whose helper list is empty,
# so a push or PR from this process fails instead of going out under the task's
# own (Cory's) login. Local supervision still runs (ADR 0015, spec review 09-25).
function Set-FleetIdentityProcessEnv {
  $plan = Get-FleetIdentityPlan -Cached
  if (-not $plan.refusal -and $plan.env) {
    foreach ($p in $plan.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, "$($p.Value)", 'Process') }
  } elseif ($plan.refusal) {
    $closedDir = "$FleetHome\state\identity"
    [IO.Directory]::CreateDirectory($closedDir) | Out-Null
    $closed = "$closedDir\refused.gitconfig"
    [IO.File]::WriteAllText($closed, "# fleet identity refused ($($plan.refusal.code)): no git credentials in this process`n[credential]`n`thelper =`n", $script:Utf8)
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_SYSTEM', $closed, 'Process')
    [Environment]::SetEnvironmentVariable('GH_TOKEN', "fleet-identity-refused-$($plan.refusal.code)", 'Process')
    [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT', '0', 'Process')
    [Environment]::SetEnvironmentVariable('GCM_INTERACTIVE', 'never', 'Process')
    [Environment]::SetEnvironmentVariable('GIT_ASKPASS', 'echo', 'Process')   # an inherited askpass (VS Code) would answer as Cory
  }
  return $plan
}
# #153 spec review: a present hosts.yml can hold an expired or revoked token. The
# launch asks GitHub once, with the fleet's own config, which login it is; a failure
# or another login is FLEET_IDENTITY_INVALID. Returns $null when the token is good.
function Test-FleetIdentityLive {
  param($Plan)
  if (-not $Plan.present -or $Plan.refusal) { return $null }
  $saved = @{}; foreach ($k in 'GH_CONFIG_DIR','GH_TOKEN','GITHUB_TOKEN','GH_PROMPT_DISABLED') { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
  try {
    [Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'Process'); [Environment]::SetEnvironmentVariable('GITHUB_TOKEN', $null, 'Process')
    [Environment]::SetEnvironmentVariable('GH_CONFIG_DIR', "$($Plan.dir)", 'Process'); [Environment]::SetEnvironmentVariable('GH_PROMPT_DISABLED', '1', 'Process')
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $out = (& gh api user --jq .login 2>&1 | Out-String).Trim(); $code = $LASTEXITCODE
    $ErrorActionPreference = $eap
  } catch { $out = "$($_.Exception.Message)"; $code = 1 }
  finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } }
  if ($code -eq 0 -and "$out".ToLowerInvariant() -eq "$($Plan.login)".ToLowerInvariant()) { return $null }
  $why = ("$out" -replace '\s+', ' '); if ($why.Length -gt 200) { $why = $why.Substring(0, 200) }
  return [pscustomobject]@{ code = 'FLEET_IDENTITY_INVALID'; message = "the token in $($Plan.dir) did not answer as $($Plan.login) (gh api user: $why); it may be expired or revoked: re-run bin/wizard-fleet-identity.sh (ADR 0015)" }
}
