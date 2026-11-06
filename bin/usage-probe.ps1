<#
.SYNOPSIS  Fleet #388 (spec #382, ruling 6): the Usage limit probe. The Watchdog runs it every tick; it probes
  only when its last attempt is 55 minutes old or more (bin/usage-limit.js due), so the cadence is hourly.
  A probe runs one cheap call through the claude CLI, resolved as every script does (Invoke-ClaudeCli:
  FLEET_CLAUDE_CLI, else the resolver): `claude -p "Reply with the single word OK."` on claude-haiku-5-5,
  project settings only, no MCP servers, one turn. The stream's rate_limit_event is the reading
  (bin/usage-limit.js record): state/usage/latest.json, and a line in state/usage/readings.jsonl.
  A weekly window at or above 80% pages Cory once, through Send-FleetPage (the one page door, normal
  priority, kind usage-limit). An attempt that reached Pushover (delivered or refused) is recorded against
  that window's resetsAt in state/usage/paged.json; an undelivered page is retried by later probes, up to
  three attempts. Credentials that are absent or incomplete are not an attempt. Prints one JSON line and
  exits 0 whatever the outcome, so a failed probe is reported in that line and never breaks the tick.
  The hour runs from the last attempt, successful or not (state/usage/attempt.json), so a probe that keeps
  failing runs once an hour, not on every tick. -Force probes whatever the age of the last attempt.
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$NoToast,
  [int]$TimeoutSec = 120   # the claude call's bound; the Watchdog passes what its tick budget has left, at most this
)
$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\_common.ps1"
$usageJs = "$PSScriptRoot\usage-limit.js"
$now = Now-Iso

function Short { param([string]$Text, [int]$Max = 300) $s = ("$Text" -replace '\s+', ' ').Trim(); if ($s.Length -gt $Max) { $s = $s.Substring(0, $Max) + '...' }; return $s }
function Finish { param($Out) Write-Output ($Out | ConvertTo-Json -Compress -Depth 6); exit 0 }
function Fail { param([string]$Message)
  try { $null = Invoke-Node @('attempt', $FleetHome, $now) } catch {}   # a failed probe waits out the hour like a good one
  Finish ([pscustomobject]@{ ran = $true; ok = $false; error = (Short $Message); at = $now })
}
# One usage-limit.js call: its last JSON line, or an {ok:false} when it printed none (its own failures print ok:false).
function Invoke-Node { param([string[]]$Arguments, $StdinText = $null)
  $bounded = Invoke-BoundedExe -FilePath (Get-NodeExe) -ArgumentList (@($usageJs) + $Arguments) -TimeoutSec 30 -Name "node usage-limit.js $($Arguments[0])" -StdinText $StdinText
  if ($bounded.timedOut) { return [pscustomobject]@{ ok = $false; error = 'usage-limit.js timed out' } }
  $answer = ConvertFrom-LastJsonLine $bounded.stdout
  if (-not $answer) { return [pscustomobject]@{ ok = $false; error = "usage-limit.js printed no JSON: $(Short "$($bounded.stdout) $($bounded.stderr)")" } }
  return $answer
}

try {
  if (-not $Force) {
    $due = Invoke-Node @('due', $FleetHome, $now)
    if ($due.ok -eq $false) { Fail $due.error }
    if (-not $due.due) { Finish ([pscustomobject]@{ ran = $false; reason = 'fresh'; at = $now }) }
  }
  $cliArgs = @('-p', 'Reply with the single word OK.', '--model', 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config')
  # The call runs from a scratch directory, never a checkout: the claude process takes its project settings and CLAUDE.md
  # from its working directory, which would otherwise be whatever directory the Watchdog or a shell runs in (cli-canary's scratch cwd).
  $probeCwd = Join-Path ([IO.Path]::GetTempPath()) ('usage-probe-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($probeCwd) | Out-Null
  Push-Location -LiteralPath $probeCwd
  try {
    # The stream is read whatever the exit code: a rate-limited account can still print its window event.
    $cli = Invoke-ClaudeCli -Arguments $cliArgs -TimeoutSec $TimeoutSec -Name 'claude usage probe' -StdinText ''
  } finally {
    Pop-Location
    Remove-Item -LiteralPath $probeCwd -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($cli.timedOut) { Fail "claude did not answer within $TimeoutSec s" }
  $rec = Invoke-Node @('record', $FleetHome, $now) -StdinText $cli.stdout
  if ($rec.ok -eq $false) { Fail "$($rec.error) (claude exit $($cli.exitCode): $(Short $cli.stderr 120))" }
  $page = $null
  if ($rec.pageDue) {
    $weekly = $rec.reading.weekly
    $resets = [DateTimeOffset]::FromUnixTimeSeconds([long]$weekly.resetsAt).UtcDateTime.ToString('yyyy-MM-dd HH:mm')
    $percent = [int][Math]::Floor($weekly.utilization * 100 + 1e-9)
    $page = Send-FleetPage -Kind 'usage-limit' -Title 'Fleet usage limit' -Body "Weekly Usage limit at $percent%. The week resets $resets UTC." -Priority 'normal' -Detail ([pscustomobject]@{ weeklyResetsAt = $weekly.resetsAt }) -NoToast:$NoToast
    if ($page.pushover -is [bool]) { $null = Invoke-Node @('page-attempt', $FleetHome, $(if ($page.pushover) { 'true' } else { 'false' }), $now) }
  }
  Finish ([pscustomobject]@{ ran = $true; ok = $true; reading = $rec.reading; paged = $(if ($page) { $page.pushover } else { $null }); at = $now })
} catch {
  Fail "usage probe threw: $($_.Exception.Message)"
}
