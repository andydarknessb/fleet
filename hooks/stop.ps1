# Stop hook for fleet sessions.
# 1) Every fleet session: write a heartbeat.
# 2) Project leads only: exit 2 (keep going) while there is actionable work and no PAUSE.
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
$inp = $null
try { $inp = $raw | ConvertFrom-Json } catch {}
$home_ = $env:FLEET_HOME; $name = $env:FLEET_NAME; $role = $env:FLEET_ROLE; $tenant = $env:FLEET_TENANT
if (-not $home_ -or -not $name) { exit 0 }
$utf8 = New-Object System.Text.UTF8Encoding $false
$now = (Get-Date).ToUniversalTime().ToString('o')

# --- heartbeat ---
$sid = $null; $sha = $false
if ($inp) { $sid = $inp.session_id; $sha = [bool]$inp.stop_hook_active }
$hb = @{ name = $name; role = $role; tenant = $tenant; sessionId = $sid; at = $now; stopHookActive = $sha }
[IO.File]::WriteAllText("$home_\state\heartbeats\$name.json", ($hb | ConvertTo-Json -Compress), $utf8)

if ($role -ne 'project-lead') { exit 0 }

# --- project lead continuation ---
$counterPath = "$home_\state\continue\$name.json"
$count = 0
if (Test-Path $counterPath) {
  try { $c = Get-Content $counterPath -Raw | ConvertFrom-Json; $count = [int]$c.count } catch {}
}

function Stop-Now {
  param($reason)
  [IO.File]::WriteAllText($counterPath, (@{ count = 0; lastAt = $now; stoppedBecause = $reason } | ConvertTo-Json -Compress), $utf8)
  exit 0
}
function Continue-With {
  param($reason)
  $script:count++
  [IO.File]::WriteAllText($counterPath, (@{ count = $script:count; lastAt = $now; continuedBecause = $reason } | ConvertTo-Json -Compress), $utf8)
  [Console]::Error.WriteLine("[fleet stop hook] Keep working: $reason (continuation $script:count/30). If you are only waiting on an IC, stop and let its message wake you instead.")
  exit 2
}

if (Test-Path "$home_\state\PAUSE") { Stop-Now 'PAUSE set' }
if ($count -ge 30) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $esc = @{ at = $now; from = $name; kind = 'loop-guard'; detail = 'project lead continued 30 times without stopping; possible loop' }
  [IO.File]::WriteAllText("$home_\state\escalations\$stamp-$name.json", ($esc | ConvertTo-Json -Compress), $utf8)
  Stop-Now 'loop guard tripped (30 continuations); escalation filed'
}
$t = $null
try { $t = Get-Content "$home_\tenants\$tenant.json" -Raw | ConvertFrom-Json } catch {}
if (-not $t) { Stop-Now 'no tenant file' }

$readyRaw = & gh issue list -R $t.github --label $t.readyLabel --state open --limit 100 --json number 2>$null
$ready = @()
try { $ready = @(($readyRaw | Out-String | ConvertFrom-Json) | ForEach-Object { [int]$_.number }) } catch {}
$roster = $null
try { $roster = Get-Content "$home_\state\roster.json" -Raw | ConvertFrom-Json } catch {}
$activeIcs = @()
if ($roster) { $activeIcs = @($roster.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' -and $_.tenant -eq $tenant }) }
$assigned = @($activeIcs | ForEach-Object { [int]$_.issue })
$unassigned = @($ready | Where-Object { $assigned -notcontains $_ })

$static = Get-Content "$home_\roster.json" -Raw | ConvertFrom-Json
$cap = [int]$static.cap
$liveRaw = & claude agents --json 2>$null
$liveNames = @()
try { $liveNames = @(($liveRaw | Out-String | ConvertFrom-Json) | ForEach-Object { $_.name }) } catch {}
$rosterNames = @($static.sessions | ForEach-Object { $_.name })
if ($roster) { $rosterNames += @($roster.sessions | Where-Object { $_.status -eq 'active' } | ForEach-Object { $_.name }) }
$liveFleet = @($liveNames | Where-Object { $rosterNames -contains $_ })
$capFree = $cap - $liveFleet.Count
$icFree = [int]$t.maxIcs - $activeIcs.Count

$prRaw = & gh pr list -R $t.github --state open --limit 100 --json number,isDraft,headRefName 2>$null
$awaiting = @()
try { $awaiting = @(($prRaw | Out-String | ConvertFrom-Json) | Where-Object { (-not $_.isDraft) -and $_.headRefName.StartsWith($t.branchPrefix) } | ForEach-Object { [int]$_.number }) } catch {}

if ($awaiting.Count -gt 0) { Continue-With "PR(s) awaiting your review: #$($awaiting -join ', #')" }
if ($unassigned.Count -gt 0 -and $capFree -gt 0 -and $icFree -gt 0) { Continue-With "unassigned ready issue(s) #$($unassigned -join ', #') with $capFree cap slot(s) and $icFree IC slot(s) free; launch the next IC" }
Stop-Now "nothing actionable (unassigned=$($unassigned.Count), capFree=$capFree, icFree=$icFree, awaitingPRs=0); ICs will message you"
