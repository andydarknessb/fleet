# Stop hook for fleet sessions.
# 1) Every fleet session: write a heartbeat.
# 2) Project leads only: exit 2 (keep going) while there is actionable work and no PAUSE.
#    "Actionable" = a non-draft fleet PR awaiting review, or a FRONTIER issue (ready label, no open
#    blockers per GitHub issue dependencies, not on the tenant's skip list) with a free cap + IC slot.
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
function ConvertFrom-JsonArray { param($Raw) try { $o = ($Raw | Out-String | ConvertFrom-Json); if ($null -eq $o) { return @() }; return @($o) } catch { return @() } }
$counterPath = "$home_\state\continue\$name.json"
$count = 0; $lastReason = ''; $total = 0
if (Test-Path $counterPath) {
  try { $c = Get-Content $counterPath -Raw | ConvertFrom-Json; $count = [int]$c.count; $lastReason = "$($c.continuedBecause)"; $total = [int]$c.total } catch {}
}
function Stop-Now {
  param($reason)
  [IO.File]::WriteAllText($counterPath, (@{ count = 0; total = 0; lastAt = $now; stoppedBecause = $reason } | ConvertTo-Json -Compress), $utf8)
  exit 0
}
function Continue-With {
  param($reason)
  # The loop guard counts CONSECUTIVE continuations for the SAME reason (a review that takes 12 turns is fine;
  # 30 turns of "launch #111" without launching it is a loop). An absolute ceiling catches reason-hopping.
  $key = ($reason -replace '\d+ cap slot.*$', '')
  if ($key -eq $script:lastKey) { $script:count++ } else { $script:count = 1 }
  $script:total++
  [IO.File]::WriteAllText($counterPath, (@{ count = $script:count; total = $script:total; lastAt = $now; continuedBecause = $key } | ConvertTo-Json -Compress), $utf8)
  [Console]::Error.WriteLine("[fleet stop hook] Keep working: $reason (same-reason continuation $script:count/30, total $script:total/100 since last natural stop). If you judge an issue not launchable, add it to state/skip/$tenant.json with a reason and this hook will stop asking.")
  exit 2
}
$script:lastKey = $lastReason

if (Test-Path "$home_\state\PAUSE") { Stop-Now 'PAUSE set' }
if ($count -ge 30 -or $total -ge 100) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $esc = @{ at = $now; from = $name; kind = 'loop-guard'; detail = "project lead continued $count times for the same reason ('$lastReason'), $total in total, without a natural stop; possible loop" }
  [IO.File]::WriteAllText("$home_\state\escalations\$stamp-$name.json", ($esc | ConvertTo-Json -Compress), $utf8)
  Stop-Now "loop guard tripped (same-reason $count, total $total); escalation filed"
}
$t = $null
try { $t = Get-Content "$home_\tenants\$tenant.json" -Raw | ConvertFrom-Json } catch {}
if (-not $t) { Stop-Now 'no tenant file' }
$owner, $repoName = $t.github -split '/'

# --- PRs awaiting review (checked first: cheapest, highest value) ---
# Actionable = open, non-draft, fleet-prefixed, NOT held by the lead (state/skip/<tenant>.json "prs"), and with no
# ciGates check still pending (a PR waiting on CI has nothing to act on; the lead schedules its own re-check).
$skipAll = $null
$skipPath = "$home_\state\skip\$tenant.json"
if (Test-Path $skipPath) { try { $skipAll = Get-Content $skipPath -Raw | ConvertFrom-Json } catch {} }
$heldPrs = @{}
if ($skipAll -and $skipAll.prs) { foreach ($p in $skipAll.prs.PSObject.Properties) { $heldPrs[[int]$p.Name] = $p.Value } }
$gates = @(); if ($t.ciGates) { $gates = @($t.ciGates) }
$prRaw = & gh pr list -R $t.github --state open --limit 100 --json number,isDraft,headRefName,statusCheckRollup 2>$null
$awaiting = @(); $waitingOnCi = @(); $held = @()
foreach ($pr in (ConvertFrom-JsonArray $prRaw)) {
  if ($pr.isDraft -or -not $pr.headRefName.StartsWith($t.branchPrefix)) { continue }
  $n = [int]$pr.number
  if ($heldPrs.ContainsKey($n)) { $held += $n; continue }
  $pending = $false
  foreach ($c in @($pr.statusCheckRollup)) {
    $cname = "$($c.name)"; if (-not $cname) { $cname = "$($c.context)" }
    if ($gates -contains $cname) {
      $st = "$($c.status)"; $concl = "$($c.conclusion)"
      if (($st -and $st -ne 'COMPLETED') -or ($concl -eq '' -and $st -ne 'COMPLETED')) { $pending = $true }
    }
  }
  if ($pending) { $waitingOnCi += $n; continue }
  $awaiting += $n
}
if ($awaiting.Count -gt 0) { Continue-With "PR(s) awaiting your review with CI settled: #$($awaiting -join ', #')" }

# --- capacity ---
$roster = $null
try { $roster = Get-Content "$home_\state\roster.json" -Raw | ConvertFrom-Json } catch {}
$activeIcs = @()
if ($roster) { $activeIcs = @($roster.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' -and $_.tenant -eq $tenant }) }
$static = Get-Content "$home_\roster.json" -Raw | ConvertFrom-Json
$cap = [int]$static.cap
$liveRaw = & claude agents --json 2>$null
$liveNames = @(ConvertFrom-JsonArray $liveRaw | ForEach-Object { $_.name })
$rosterNames = @($static.sessions | ForEach-Object { $_.name })
if ($roster) { $rosterNames += @($roster.sessions | Where-Object { $_.status -eq 'active' } | ForEach-Object { $_.name }) }
$liveFleet = @($liveNames | Where-Object { $rosterNames -contains $_ })
$capFree = $cap - $liveFleet.Count
$icFree = [int]$t.maxIcs - $activeIcs.Count
if ($capFree -le 0 -or $icFree -le 0) {
  $msg = "no free slot (capFree=$capFree, icFree=$icFree)"
  if ($waitingOnCi.Count -gt 0) { $msg += "; PR(s) waiting on CI gates: #$($waitingOnCi -join ', #') (schedule a one-shot CronCreate re-check if you have none)" }
  if ($held.Count -gt 0) { $msg += "; held PR(s): #$($held -join ', #')" }
  Stop-Now "$msg; ICs will message you"
}

# --- frontier: ready, unassigned, not skipped, no open blockers ---
$readyRaw = & gh issue list -R $t.github --label $t.readyLabel --state open --limit 100 --json number 2>$null
$ready = @(ConvertFrom-JsonArray $readyRaw | ForEach-Object { [int]$_.number })
$assigned = @($activeIcs | ForEach-Object { [int]$_.issue })
$skip = @{}
$skipPath = "$home_\state\skip\$tenant.json"
if (Test-Path $skipPath) { try { $sk = Get-Content $skipPath -Raw | ConvertFrom-Json; foreach ($p in $sk.issues.PSObject.Properties) { $skip[[int]$p.Name] = $p.Value } } catch {} }
$candidates = @($ready | Where-Object { ($assigned -notcontains $_) -and (-not $skip.ContainsKey($_)) })
$frontier = @()
$blocked = @()
if ($candidates.Count -gt 0) {
  # One REST call, no embedded quotes (PowerShell 5.1 strips them from native args, which broke the GraphQL form).
  # issue_dependencies_summary.blocked_by counts OPEN blockers only.
  $depRaw = & gh api "repos/$($t.github)/issues?labels=$($t.readyLabel)&state=open&per_page=100" 2>$null
  $deps = @{}
  $depOk = $false
  foreach ($it in (ConvertFrom-JsonArray $depRaw)) {
    if ($it.pull_request) { continue }
    $depOk = $true
    $bb = 0
    if ($it.issue_dependencies_summary -and $null -ne $it.issue_dependencies_summary.blocked_by) { $bb = [int]$it.issue_dependencies_summary.blocked_by }
    $deps[[int]$it.number] = $bb
  }
  if ($depOk) {
    foreach ($n in $candidates) {
      $bb = 0; if ($deps.ContainsKey($n)) { $bb = $deps[$n] }
      if ($bb -eq 0) { $frontier += $n } else { $blocked += "#$n(blocked_by=$bb)" }
    }
  } else {
    # Dependency data unavailable: the SAFE direction is to launch nothing, not everything.
    Stop-Now "could not read issue dependencies from GitHub; not launching (candidates: #$($candidates -join ', #'))"
  }
}

if ($frontier.Count -gt 0) { Continue-With "frontier issue(s) #$($frontier -join ', #') (ready, unblocked, unassigned, not skipped) with $capFree cap slot(s) and $icFree IC slot(s) free; launch the next IC" }
$why = "frontier empty (ready=$($ready.Count), assigned=$($assigned.Count), skipped=$($skip.Count), blocked=$($blocked.Count)"
if ($blocked.Count -gt 0) { $why += ": $($blocked -join ' ')" }
$why += ")"
if ($waitingOnCi.Count -gt 0) { $why += "; PR(s) waiting on CI gates, nothing to do yet: #$($waitingOnCi -join ', #') (schedule a one-shot CronCreate re-check if you have none)" }
if ($held.Count -gt 0) { $why += "; held PR(s): #$($held -join ', #')" }
Stop-Now "$why; ICs will message you"
