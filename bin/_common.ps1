# Shared helpers for fleet scripts (dot-source).
$script:FleetHome = Split-Path -Parent $PSScriptRoot
$script:Utf8 = New-Object System.Text.UTF8Encoding $false
function Read-Json { param($Path) if (Test-Path $Path) { Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } }
function Write-Json { param($Path, $Obj) [IO.File]::WriteAllText($Path, ($Obj | ConvertTo-Json -Depth 8), $script:Utf8) }
function Get-StaticRoster { Read-Json "$FleetHome\roster.json" }
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
  $n = @($Static.sessions | ForEach-Object { $_.name })
  $n += @($Live.sessions | Where-Object { $_.status -eq 'active' } | ForEach-Object { $_.name })
  $n | Select-Object -Unique
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
  param($From, $Kind, $Detail)
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  Write-Json "$FleetHome\state\escalations\$stamp-$From.json" ([pscustomobject]@{ at = (Now-Iso); from = $From; kind = $Kind; detail = $Detail })
}
