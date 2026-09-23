# Stop hook for fleet sessions.
# 1) Every fleet session: write a heartbeat.
# 2) Project leads only: exit 2 (keep going) while there is actionable work and no PAUSE.
#    "Actionable" = a non-draft fleet PR awaiting review, or an assignment-planner frontier issue
#    (bin/assignment.js: ready, open, unassigned, unblocked, no spec parent, not ready-for-human,
#    not excluded, not reserved) with a free cap + IC slot.
$ErrorActionPreference = 'SilentlyContinue'
. "$PSScriptRoot\..\bin\check-policy.ps1"
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

if ($role -notin @('project-lead', 'principal')) { exit 0 }

# --- project lead and principal continuation ---
function ConvertFrom-JsonArray { param($Raw) try { $o = ($Raw | Out-String | ConvertFrom-Json); if ($null -eq $o) { return @() }; return @($o) } catch { return @() } }
$counterPath = "$home_\state\continue\$name.json"
$count = 0; $lastReason = ''; $total = 0
if (Test-Path $counterPath) {
  try { $c = Get-Content $counterPath -Raw -Encoding UTF8 | ConvertFrom-Json; $count = [int]$c.count; $lastReason = "$($c.continuedBecause)"; $total = [int]$c.total } catch {}
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
  $hint = if ($role -eq 'principal') { "If a ticket should not be triaged by you, say so in your status file; the frontier drops it once it is routed, held, or assigned to the owner." } else { "If you judge an issue not launchable, add it to state/skip/$tenant.json with a reason and this hook will stop asking." }
  [Console]::Error.WriteLine("[fleet stop hook] Keep working: $reason (same-reason continuation $script:count/30, total $script:total/100 since last natural stop). $hint")
  exit 2
}
$script:lastKey = $lastReason

if (Test-Path "$home_\state\PAUSE") { Stop-Now 'PAUSE set' }
if ($count -ge 30 -or $total -ge 100) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $esc = @{ at = $now; from = $name; kind = 'loop-guard'; detail = "$role continued $count times for the same reason ('$lastReason'), $total in total, without a natural stop; possible loop" }
  [IO.File]::WriteAllText("$home_\state\escalations\$stamp-$name.json", ($esc | ConvertTo-Json -Compress), $utf8)
  Stop-Now "loop guard tripped (same-reason $count, total $total); escalation filed"
}
$t = $null
try { $t = Get-Content "$home_\tenants\$tenant.json" -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
if (-not $t) { Stop-Now 'no tenant file' }

# --- principal (ADR 0011, fleet #38): continue while the triage frontier is non-empty.
# --- bin/triage.js computes it from GitHub facts, the outbox and the triage ledger; an
# --- unreadable frontier stops the session (fail closed), never "frontier empty".
if ($role -eq 'principal') {
  $triageNode = $null
  if ($env:FLEET_NODE_PATH) { if (Test-Path -LiteralPath $env:FLEET_NODE_PATH -PathType Leaf) { $triageNode = $env:FLEET_NODE_PATH } }
  else { $triageCmd = Get-Command node -ErrorAction SilentlyContinue; if ($triageCmd) { $triageNode = $triageCmd.Source } }
  if (-not $triageNode) { Stop-Now 'node not found; the triage frontier cannot be computed, proposing nothing' }
  $triageArgs = @('frontier', '--root', $home_, '--tenant', $tenant)
  if ($env:FLEET_TRIAGE_ISSUES_FIXTURE) { $triageArgs += @('--fixture', $env:FLEET_TRIAGE_ISSUES_FIXTURE) }
  $triageRaw = ''; $triageExit = 1; $frontierOut = $null
  try { $triageRaw = & $triageNode "$home_\bin\triage.js" @triageArgs 2>&1 | Out-String; $triageExit = $LASTEXITCODE } catch { $triageRaw = "$($_.Exception.Message)" }
  if ($triageExit -eq 0) { try { $frontierOut = ("$triageRaw".Trim() -split "`n")[-1] | ConvertFrom-Json } catch { $frontierOut = $null } }
  if ($triageExit -ne 0 -or -not $frontierOut) {
    $triageSnippet = ("$triageRaw" -replace '\s+', ' ').Trim()
    if ($triageSnippet.Length -gt 200) { $triageSnippet = $triageSnippet.Substring(0, 200) }
    Stop-Now "triage frontier unreadable (triage.js exit ${triageExit}; $triageSnippet); proposing nothing"
  }
  $eligible = @($frontierOut.eligible)
  if ($eligible.Count -gt 0) {
    $approvals = @($eligible | Where-Object { $_.kind -eq 'approval' } | ForEach-Object { "#$($_.number)" })
    $escalations = @($eligible | Where-Object { $_.kind -eq 'escalation' } | ForEach-Object { "#$($_.number)" })
    $proposeNow = @($frontierOut.proposeNow | ForEach-Object { "#$_" })
    $parts = @()
    if ($approvals.Count -gt 0) { $parts += "finalize approved $($approvals -join ', ')" }
    if ($escalations.Count -gt 0) { $parts += "rule on escalation(s) $($escalations -join ', ')" }
    if ($proposeNow.Count -gt 0) { $parts += "propose triage for $($proposeNow -join ', ') (at most $($frontierOut.cap) this turn of $($frontierOut.counts.tickets) waiting)" }
    Continue-With "triage frontier: $($parts -join '; '). Post on the issue first, record it with 'node $home_\bin\triage.js record', then stop; the next turn re-reads the frontier"
  }
  Stop-Now "triage frontier empty (issues=$($frontierOut.counts.issues), skipped=$(@($frontierOut.skipped).Count), consumed through $($frontierOut.consumedThrough)); the watchdog wakes you"
}

try { $checkPolicy = Get-TenantCheckPolicy $t } catch { Stop-Now "invalid tenant check policy: $($_.Exception.Message)" }
$owner, $repoName = $t.github -split '/'

# --- PRs awaiting review (checked first: cheapest, highest value) ---
# Actionable = open, non-draft, fleet-prefixed, NOT held by the lead (state/skip/<tenant>.json "prs"), with no
# ciGates check still pending, AND (fleet#51) whose Work record is in `review`. `review-policy.js record --kind
# formal` reads the record, which the PR watcher advances on its tick, so a PR that is green on live GitHub while
# its record is still `ci-wait` is one the gate refuses (INVALID_REVIEW_STATE); the hook and the gate now share
# one clock. Such a PR is named as lagging, never offered. Under state/flags/pr-watch-off the records do not
# advance and the live verdict decides; a PR with no Work record keeps the live verdict, labelled.
$skipAll = $null
$skipPath = "$home_\state\skip\$tenant.json"
if (Test-Path $skipPath) { try { $skipAll = Get-Content $skipPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
$heldPrs = @{}
if ($skipAll -and $skipAll.prs) { foreach ($p in $skipAll.prs.PSObject.Properties) { $heldPrs[[int]$p.Name] = $p.Value } }
$watchOff = Test-Path "$home_\state\flags\pr-watch-off"
$recordsByPr = @{}
if (-not $watchOff) {
  try {
    $activeWork = Get-Content "$home_\state\work\active.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($r in $activeWork.records.PSObject.Properties) {
      $rec = $r.Value
      if ($rec.github -and $rec.github.prNumber) { $recordsByPr[[int]$rec.github.prNumber] = $rec }
    }
  } catch {}
}
$prRaw = & gh pr list -R $t.github --state open --limit 100 --json number,isDraft,headRefName,statusCheckRollup 2>$null
$awaiting = @(); $waitingOnCi = @(); $held = @(); $watchedFindings = @(); $recordLag = @(); $noRecord = @()
foreach ($pr in (ConvertFrom-JsonArray $prRaw)) {
  if ($pr.isDraft -or -not $pr.headRefName.StartsWith($t.branchPrefix)) { continue }
  $n = [int]$pr.number
  if ($heldPrs.ContainsKey($n)) { $held += $n; continue }
  $checkState = Get-CheckPolicyEvaluation $checkPolicy @($pr.statusCheckRollup)
  foreach ($finding in $checkState.WatchedFindings) { $watchedFindings += "#$n/$($finding.Name)=$($finding.Conclusion)" }
  if ($checkState.GatePending.Count -gt 0) { $waitingOnCi += $n; continue }
  if (-not $watchOff) {
    if ($recordsByPr.ContainsKey($n)) {
      $recordState = "$($recordsByPr[$n].state)"
      if ($recordState -ne 'review') { $recordLag += "#$n (record still $recordState)"; continue }
    } else { $noRecord += $n }
  }
  $awaiting += $n
}
$lagNote = ''
if ($recordLag.Count -gt 0) { $lagNote = "; PR(s) settled on GitHub whose Work record is not yet in review, not reviewable until the watcher's next tick moves it: $($recordLag -join ', ')" }
if ($awaiting.Count -gt 0) {
  $reason = "PR(s) awaiting your review with CI settled: #$($awaiting -join ', #')"
  if ($noRecord.Count -gt 0) { $reason += " (no Work record for #$($noRecord -join ', #'): live GitHub verdict, record --kind formal will not find it)" }
  if ($watchedFindings.Count -gt 0) { $reason += "; watched finding(s), not gates: $($watchedFindings -join ', ')" }
  Continue-With "$reason$lagNote"
}

# --- capacity ---
$roster = $null
try { $roster = Get-Content "$home_\state\roster.json" -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
$activeIcs = @()
if ($roster) { $activeIcs = @($roster.sessions | Where-Object { $_.status -eq 'active' -and $_.role -eq 'ic' -and $_.tenant -eq $tenant }) }
$static = Get-Content "$home_\roster.json" -Raw -Encoding UTF8 | ConvertFrom-Json
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
  if ($waitingOnCi.Count -gt 0) { $msg += "; PR(s) waiting on CI gates: #$($waitingOnCi -join ', #') (the watcher records checks-settled and the watchdog wakes you; never poll)" }
  $msg += $lagNote
  if ($held.Count -gt 0) { $msg += "; held PR(s): #$($held -join ', #')" }
  Stop-Now "$msg; ICs will message you"
}

# --- frontier: the assignment planner (bin/assignment.js), the sole decision since ticket 89
# --- retired the Stop hook's own legacy frontier and the parity observation it recorded beside
# --- it (state/assignment/shadow/, ADR 0006). A planner failure launches nothing (fail closed);
# --- it never falls back to a hand-computed frontier.
# Same resolution as _common.ps1 Get-NodeExe: FLEET_NODE_PATH wins, and a wrong one is no node (never a silent PATH fallback).
$nodeExe = $null
if ($env:FLEET_NODE_PATH) { if (Test-Path -LiteralPath $env:FLEET_NODE_PATH -PathType Leaf) { $nodeExe = $env:FLEET_NODE_PATH } }
else { $nodeCmd = Get-Command node -ErrorAction SilentlyContinue; if ($nodeCmd) { $nodeExe = $nodeCmd.Source } }
$plannerFailure = $null
$plannerFrontier = @()
if (-not $nodeExe) {
  $plannerFailure = 'node not found; the assignment planner cannot be computed'
} else {
  $frontierArgs = @('frontier', '--root', $home_, '--tenant', $tenant)
  if ($env:FLEET_GITHUB_ISSUES_FIXTURE) { $frontierArgs += @('--fixture', $env:FLEET_GITHUB_ISSUES_FIXTURE) }
  try {
    $frontierRaw = & $nodeExe "$home_\bin\assignment.js" @frontierArgs 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { $plannerFailure = ($frontierRaw -replace '\s+', ' ').Trim() }
    else {
      $planner = $null
      try { $planner = ("$frontierRaw".Trim() -split "`n")[-1] | ConvertFrom-Json } catch { $planner = $null }
      if (-not $planner -or $null -eq $planner.PSObject.Properties['eligible']) { $plannerFailure = 'bin/assignment.js frontier produced no report' }
      else { $plannerFrontier = @($planner.eligible | ForEach-Object { [int]$_.number }) }
    }
  } catch { $plannerFailure = "$($_.Exception.Message)" }
}
if ($plannerFailure) {
  # Fail closed AND visible: the lead stops looking launchable, so the supervisor line
  # must hear it. One open escalation of this kind per lead; the digest and dispatcher
  # read state/escalations/.
  $escDir = "$home_\state\escalations"
  $already = @(Get-ChildItem $escDir -Filter "*-$name.json" -ErrorAction SilentlyContinue | Where-Object { try { ((Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).kind -eq 'assignment-planner-failed') } catch { $false } })
  if ($already.Count -eq 0) {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $esc = @{ at = $now; from = $name; kind = 'assignment-planner-failed'; tenant = $tenant; detail = "the assignment planner failed ($plannerFailure); the project lead launches nothing until it answers" }
    [IO.Directory]::CreateDirectory($escDir) | Out-Null
    [IO.File]::WriteAllText("$escDir\$stamp-$name.json", ($esc | ConvertTo-Json -Compress), $utf8)
  }
  Stop-Now "assignment planner failed ($plannerFailure); launching nothing, escalation filed"
}
if ($plannerFrontier.Count -gt 0) { Continue-With "assignment frontier #$($plannerFrontier -join ', #') (planner: ready, open, unassigned, unblocked, no spec parent, not ready-for-human, not excluded, not reserved) with $capFree cap slot(s) and $icFree IC slot(s) free; reserve the head with 'node $home_\bin\assignment.js assign' and launch it with 'assignment.js launch'$lagNote" }
$why = "assignment frontier empty"
if ($waitingOnCi.Count -gt 0) { $why += "; PR(s) waiting on CI gates, nothing to do yet: #$($waitingOnCi -join ', #') (the watcher records checks-settled and the watchdog wakes you; never poll)" }
$why += $lagNote
if ($held.Count -gt 0) { $why += "; held PR(s): #$($held -join ', #')" }
Stop-Now "$why; ICs will message you"
