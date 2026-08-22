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
  [Console]::Error.WriteLine("[fleet stop hook] Keep working: $reason (continuation $script:count/30). If you judge an issue not launchable, add it to state/skip/$tenant.json with a reason and this hook will stop asking.")
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
$owner, $repoName = $t.github -split '/'

# --- PRs awaiting review (checked first: cheapest, highest value) ---
$prRaw = & gh pr list -R $t.github --state open --limit 100 --json number,isDraft,headRefName 2>$null
$awaiting = @(ConvertFrom-JsonArray $prRaw | Where-Object { (-not $_.isDraft) -and $_.headRefName.StartsWith($t.branchPrefix) } | ForEach-Object { [int]$_.number })
if ($awaiting.Count -gt 0) { Continue-With "PR(s) awaiting your review: #$($awaiting -join ', #')" }

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
if ($capFree -le 0 -or $icFree -le 0) { Stop-Now "no free slot (capFree=$capFree, icFree=$icFree); ICs will message you" }

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
  $aliases = ($candidates | ForEach-Object { "i$($_): issue(number:$_) { number blockedBy(first:20) { nodes { number state } } }" }) -join ' '
  $q = "query { repository(owner:""$owner"", name:""$repoName"") { $aliases } }"
  $gql = & gh api graphql -f query=$q 2>$null | Out-String
  $parsed = $null; try { $parsed = $gql | ConvertFrom-Json } catch {}
  if ($parsed -and $parsed.data.repository) {
    foreach ($n in $candidates) {
      $node = $parsed.data.repository."i$n"
      $openBlockers = @()
      if ($node -and $node.blockedBy -and $node.blockedBy.nodes) { $openBlockers = @($node.blockedBy.nodes | Where-Object { $_.state -eq 'OPEN' } | ForEach-Object { $_.number }) }
      if ($openBlockers.Count -eq 0) { $frontier += $n } else { $blocked += "#$n(by #$($openBlockers -join ',#'))" }
    }
  } else {
    # GraphQL unavailable: fall back to treating every candidate as frontier, but say so.
    $frontier = $candidates
  }
}

if ($frontier.Count -gt 0) { Continue-With "frontier issue(s) #$($frontier -join ', #') (ready, unblocked, unassigned, not skipped) with $capFree cap slot(s) and $icFree IC slot(s) free; launch the next IC" }
$why = "frontier empty (ready=$($ready.Count), assigned=$($assigned.Count), skipped=$($skip.Count), blocked=$($blocked.Count)"
if ($blocked.Count -gt 0) { $why += ": $($blocked -join ' ')" }
Stop-Now "$why); ICs will message you"
