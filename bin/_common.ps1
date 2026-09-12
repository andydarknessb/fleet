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
# Ticket 09: a high-priority alert for the actions Cory audits in real time (a watchdog
# frontier wake). Three channels, none of them fatal: the Windows toast, a webhook POST
# (Slack-compatible {"text": ...}) to the URL in FLEET_ALERT_WEBHOOK or
# state/alerts/webhook.url (state/ is not committed, so the URL never lands in git), and
# an append-only audit line in state/alerts/alerts.jsonl, which is the channel that
# always works. Returns what was delivered so the caller can record it.
function Send-FleetAlert {
  param([string]$Kind, [string]$Title, [string]$Body, $Detail = $null, [switch]$NoToast)
  $result = [ordered]@{ at = (Now-Iso); kind = $Kind; title = $Title; body = $Body; toast = $null; webhook = $null; webhookError = $null }
  # -NoToast (tests) skips the toast only: the webhook and the audit line always run.
  if ($NoToast) { $result.toast = 'skipped' } else { try { $result.toast = Send-FleetToast $Title $Body } catch { $result.toast = $false } }
  $url = $env:FLEET_ALERT_WEBHOOK
  if (-not $url) { try { $url = (Get-Content "$FleetHome\state\alerts\webhook.url" -Raw -ErrorAction Stop).Trim() } catch { $url = $null } }
  if ($url) {
    try {
      $payload = @{ text = "[$Kind] $Title`n$Body"; kind = $Kind; title = $Title; body = $Body; detail = $Detail; at = $result.at } | ConvertTo-Json -Compress -Depth 6
      $null = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 15
      $result.webhook = $true
    } catch { $result.webhook = $false; $result.webhookError = "$($_.Exception.Message)" }
  } else { $result.webhook = 'unconfigured' }
  try {
    [IO.Directory]::CreateDirectory("$FleetHome\state\alerts") | Out-Null
    $line = [ordered]@{}; foreach ($k in $result.Keys) { $line[$k] = $result[$k] }; $line.detail = $Detail
    [IO.File]::AppendAllText("$FleetHome\state\alerts\alerts.jsonl", (($line | ConvertTo-Json -Compress -Depth 6) + [Environment]::NewLine), $script:Utf8)
  } catch {}
  return [pscustomobject]$result
}
function Get-ExpectedStaticSessions {
  # The static roster minus the rostered Sentinel while state/flags/sentinel-off stands
  # (ticket 08b cutover): its roster.json entry stays as the rollback path, and nothing
  # expects, launches, or recovers it until rollback-sentinel.ps1 removes the flag.
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
