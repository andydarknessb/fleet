# Fast-forward a tenant's defaultBranch to its releaseBranch (e.g. integration <- main) after Cory merges
# something straight to the release branch. Refuses anything that is not a pure fast-forward.
# Ticket 09 (fleet #87): real divergence (content on the release side the default branch lacks) opens
# the reconciliation PR itself instead of only escalating text - idempotent across ticks via `gh pr
# list` first. The PR must merge as a MERGE COMMIT, never squash: squashing a release-into-default PR
# rewrites the release branch's history out of the default branch, which re-diverges it on the next
# release. A push refused mid-apply (e.g. a pre-receive hook) records git's stderr and escalates.
# fleet #274: a ruleset on the default branch requires status checks, fleet-review among them (a commit
# status only review-policy.js posts, on a reviewed PR head). Before pushing, the run reads the required
# contexts and their state on the tip: a PENDING one waits quietly (sync-waiting), a FAILED one is
# blocked (sync-blocked, high), an ABSENT one or an unreadable lookup pushes as before. A refusal is then
# classified by its text. An unattested tip (sync-unattested) carries the reconciliation PR and the attest
# command, and is memoized in state/sentinel/sync-last-<tenant>.json so the same sha and status counts are not
# pushed on every tick.
# fleet #390 (owner ruling 2026-11-06): only a conflict or a red gate comes to Cory. An open Reconcile PR (the release
# branch into the default branch) that the PR watcher will merge is held, not escalated: clean or pending, or unknown on
# its first run. So is one this run opened. A conflict, a red gate, a PR that is not a Reconcile PR, a hold past the
# stall limit, or unknown on a second run escalates, and so does a run that could not open one or whose watcher cannot
# merge it (Get-ReconcileWait, Get-OpenedReconcileWait).
param([string]$Tenant = 'endzone', [switch]$Apply)
. "$PSScriptRoot\_common.ps1"
# Entry point: never inherit a caller's Stop preference (PS 5.1 wraps native stderr).
$ErrorActionPreference = 'Continue'

function Get-OpenReconciliationPr {
  # Idempotency: a PR already open from $Head into $Base means a previous tick already
  # acted. Tri-state, not boolean: 'found' (reuse it), 'none' (confirmed clear to
  # create), or 'unknown' (gh itself failed or returned something that isn't the JSON
  # asked for). Collapsing 'none' and 'unknown' into one falsy answer opened a new PR
  # on every tick of a gh outage (review finding 4, measured: 3 creates in 3 ticks).
  param([string]$Repo, [string]$Base, [string]$Head)
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $raw = & gh pr list -R $Repo --base $Base --head $Head --state open --json number,url,isDraft,isCrossRepository,headRefName,baseRefName,headRefOid,mergeable,statusCheckRollup 2>&1 }
  finally { $ErrorActionPreference = $previous }
  $text = ($raw | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ status = 'unknown'; pr = $null; error = (("$text" -replace '\s+', ' ').Trim()) } }
  try { $prs = @($text | ConvertFrom-Json) } catch { return [pscustomobject]@{ status = 'unknown'; pr = $null; error = "gh pr list returned non-JSON output: $(("$text" -replace '\s+', ' ').Trim())" } }
  $first = $prs | Select-Object -First 1
  if ($first) { return [pscustomobject]@{ status = 'found'; pr = $first; error = $null } }
  return [pscustomobject]@{ status = 'none'; pr = $null; error = $null }
}

function New-ReconciliationPr {
  # Start-Process with SEPARATE stdout/stderr files, not `gh ... 2>&1`: merging the
  # streams meant the "take the last line" URL parse could grab a stderr warning
  # instead of the real URL (review finding 14). The URL is read from stdout alone and
  # validated to look like one before it is trusted.
  param([string]$Repo, [string]$Base, [string]$Head, [int]$DefAheadCount, [switch]$FastForward)
  $body = "This PR reconciles $Head into $Base. $Head carries content changes $Base lacks, and the fast-forward the fleet normally performs is not possible ($DefAheadCount commit(s) on the $Base side that $Head does not have).`n`n" +
    "Merge this with a MERGE COMMIT. Do not squash: a squash merge of the release branch into the default branch rewrites the release branch's history out of the default branch, which re-diverges the two on the next release."
  if ($FastForward) {
    # fleet #274: a pure fast-forward the ruleset refuses because the tip carries no fleet-review status.
    $body = "$Head is ahead of $Base and $Base has nothing $Head lacks, so the fleet would fast-forward it, but the ruleset on $Base requires a fleet-review status that $Head's tip does not carry (it was reached by a release merge, cherry-pick or direct push, never a reviewed PR head).`n`n" +
      "Attest this PR's head (node bin/review-policy.js attest --tenant <tenant> --pr <this PR> --head <the tip sha> --artifact <review.json>), or merge it with a MERGE COMMIT. Do not squash: a squash merge rewrites the release branch's history out of the default branch, which re-diverges the two on the next release."
  }
  $bodyFile = [IO.Path]::GetTempFileName()
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($bodyFile, $body, $script:Utf8)
    # Windows PowerShell's Start-Process joins -ArgumentList with spaces and quotes nothing, so an
    # element holding a space (the title; a body-file path under a spaced TEMP) must carry its own quotes.
    $ghArgs = @('pr', 'create', '-R', $Repo, '--base', $Base, '--head', $Head, '--title', "`"Reconcile $Head into $Base`"", '--body-file', "`"$bodyFile`"")
    $p = Start-Process -FilePath 'gh' -ArgumentList $ghArgs -NoNewWindow -PassThru -Wait -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $exit = $p.ExitCode
    $stdout = ''; try { $stdout = Get-Content $outFile -Raw -ErrorAction SilentlyContinue } catch {}
    $stderrText = ''; try { $stderrText = Get-Content $errFile -Raw -ErrorAction SilentlyContinue } catch {}
  } finally { Remove-Item $bodyFile, $outFile, $errFile -ErrorAction SilentlyContinue }
  if ($exit -ne 0) { return [pscustomobject]@{ ok = $false; url = $null; error = (("$stderrText" -replace '\s+', ' ').Trim()) } }
  # gh pr create prints the new PR's URL as its last line of stdout on success.
  $url = ("$stdout".Trim() -split "`n" | Select-Object -Last 1).Trim()
  if ($url -notmatch '^https?://\S+$') { return [pscustomobject]@{ ok = $false; url = $null; error = "gh pr create exited 0 but stdout did not look like a URL: $(("$stdout" -replace '\s+', ' ').Trim())" } }
  return [pscustomobject]@{ ok = $true; url = $url; error = $null }
}

function Invoke-GhApiJson {
  # Tri-state like Get-OpenReconciliationPr: 'ok' (exit 0 and JSON) or 'unknown' (gh failed, printed
  # nothing, or printed something that is not JSON). Never throws; stderr is not merged into the text.
  param([string]$Path)
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $raw = & gh api $Path 2>$null }
  finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ status = 'unknown'; data = $null } }
  $text = ($raw | Out-String).Trim()
  if (-not $text) { return [pscustomobject]@{ status = 'unknown'; data = $null } }
  try { $data = $text | ConvertFrom-Json } catch { return [pscustomobject]@{ status = 'unknown'; data = $null } }
  return [pscustomobject]@{ status = 'ok'; data = $data }
}

function Get-RequiredContexts {
  # fleet #274: the status-check contexts the ruleset on $Branch requires, from the rules that apply to
  # the branch. 'ok' (possibly with no contexts) or 'unknown'.
  param([string]$Repo, [string]$Branch)
  $r = Invoke-GhApiJson "repos/$Repo/rules/branches/$Branch"
  if ($r.status -ne 'ok') { return [pscustomobject]@{ status = 'unknown'; contexts = @() } }
  $contexts = @()
  foreach ($rule in @($r.data)) {
    if ($null -eq $rule -or "$($rule.type)" -ne 'required_status_checks' -or $null -eq $rule.parameters) { continue }
    foreach ($c in @($rule.parameters.required_status_checks)) { if ($null -ne $c -and "$($c.context)") { $contexts += "$($c.context)" } }
  }
  return [pscustomobject]@{ status = 'ok'; contexts = @($contexts | Select-Object -Unique) }
}

function ConvertTo-CheckClass {
  # One status or check run -> 'success' | 'pending' | 'failed' ($null for a state this does not know).
  param([string]$Kind, [string]$State, [string]$Conclusion)
  if ($Kind -eq 'status') {
    switch ($State) { 'success' { return 'success' } 'pending' { return 'pending' } 'failure' { return 'failed' } 'error' { return 'failed' } default { return $null } }
  }
  if ($State -eq 'completed') {
    switch ($Conclusion) {
      { $_ -in 'success', 'neutral', 'skipped' } { return 'success' }
      { $_ -in 'failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale' } { return 'failed' }
      # A conclusion this does not know is unknown (the context reads as absent and the ruleset decides),
      # never "still running": a pending reading would wait on a completed run indefinitely.
      default { return $null }
    }
  }
  if ($State -in 'queued', 'in_progress', 'waiting', 'requested', 'pending') { return 'pending' }
  return $null
}

function Get-CommitCheckState {
  # fleet #274: what the commit's statuses and check runs say, per context (worst of failed > pending >
  # success when a context appears as both), plus the counts the evidence memo compares. 'ok' or 'unknown'
  # (either lookup failing is unknown: a half picture would invent an "absent").
  param([string]$Repo, [string]$Sha)
  $st = Invoke-GhApiJson "repos/$Repo/commits/$Sha/status?per_page=100"
  $cr = Invoke-GhApiJson "repos/$Repo/commits/$Sha/check-runs?per_page=100"
  if ($st.status -ne 'ok' -or $cr.status -ne 'ok' -or $null -eq $st.data -or $null -eq $cr.data) { return [pscustomobject]@{ status = 'unknown'; classes = @{}; statusCount = $null; checkRunCount = $null } }
  $seen = @{}
  $add = {
    param($Name, $Class)
    if (-not $Name -or -not $Class) { return }
    $rank = @{ failed = 3; pending = 2; success = 1 }
    if (-not $seen.ContainsKey($Name) -or $rank[$Class] -gt $rank[$seen[$Name]]) { $seen[$Name] = $Class }
  }
  $statuses = @($st.data.statuses | Where-Object { $null -ne $_ })
  $runs = @($cr.data.check_runs | Where-Object { $null -ne $_ })
  foreach ($s in $statuses) { & $add "$($s.context)" (ConvertTo-CheckClass -Kind 'status' -State "$($s.state)") }
  # Reruns and superseded suites leave several runs under one name: only the newest speaks for it, or a
  # cancelled older run reads as a red check. The run id is monotonic, so the highest id is the newest
  # (started_at can order a rerun before the run it replaced). Worst-wins applies only between a status
  # context and the newest run that share a name.
  $newest = @{}
  foreach ($r in $runs) {
    $name = "$($r.name)"
    if (-not $name) { continue }
    $runId = 0L; try { $runId = [long]$r.id } catch {}
    $cur = $newest[$name]
    if ($null -eq $cur -or $runId -gt $cur.id) { $newest[$name] = [pscustomobject]@{ id = $runId; run = $r } }
  }
  foreach ($name in $newest.Keys) { $r = $newest[$name].run; & $add $name (ConvertTo-CheckClass -Kind 'run' -State "$($r.status)" -Conclusion "$($r.conclusion)") }
  return [pscustomobject]@{ status = 'ok'; classes = $seen; statusCount = $statuses.Count; checkRunCount = $runs.Count }
}

function Get-RefusalKind {
  # Classifies a refused push by git's text. Checks in progress or pending win (the next tick sees the
  # settled state). `Required status check "<name>" is expected` is an unattested tip only when <name> is
  # the tenant's review status context ($ReviewContext); any other expected context, or an unnamed one, is
  # an unexplained refusal. GitHub's `N of 7 required status checks have not succeeded: 1 expected.` names
  # nothing, so it reads as waiting (the stall ceiling catches one that never settles); anything else is
  # an unexplained refusal.
  param([string]$Text, [string]$ReviewContext = 'fleet-review')
  if ($Text -match 'is in progress|are in progress|is pending|are pending') { return 'sync-waiting' }
  $named = @([regex]::Matches($Text, 'Required status check "([^"]+)" is expected'))
  if ($named.Count -gt 0) {
    foreach ($m in $named) { if ($m.Groups[1].Value -ne $ReviewContext) { return 'sync-refused' } }
    return 'sync-unattested'
  }
  if ($Text -match 'is expected|are expected') { return 'sync-refused' }
  if ($Text -match 'have not succeeded') { return 'sync-waiting' }
  return 'sync-refused'
}

function Get-SyncStallMinutes {
  # config/cycle.json watchdog.syncStallMinutes: how long one sha may sit waiting on checks before it
  # becomes sync-stalled. Default 120; anything that is not a positive number reads as the default.
  $minutes = 120
  try {
    $w = (Read-Json "$FleetHome\config\cycle.json").watchdog
    if ($w -and $w.PSObject.Properties['syncStallMinutes']) {
      $v = $w.syncStallMinutes
      if (($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) -and $v -gt 0) { $minutes = [double]$v }
    }
  } catch {}
  return $minutes
}

function Write-SyncMemo {
  param([string]$Path, $Record)
  try {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    Write-Json $Path $Record
  } catch { [Console]::Error.WriteLine("sync-integration: could not write sync memo ${Path}: $($_.Exception.Message)") }
}

function New-WaitingOutcome {
  # fleet #274: waiting has a ceiling. The memo remembers when this sha first waited; once it has waited
  # the stall limit the result escalates as sync-stalled (normal) instead of staying silent for good.
  param([string]$TenantName, [string]$Def, [string]$Rel, [string]$Sha, [string]$ShortSha, [string[]]$WaitingOn, [string]$PushError, $Memo, [string]$MemoPath)
  $nowUtc = (Get-Date).ToUniversalTime()
  $since = $nowUtc
  # The clock carries only across consecutive ticks: the memo must have been touched within two ticks
  # (35 min). An older memo is a different wait (checks settled, a blocked or unattested stretch, or the
  # run did not reach this path for hours), so the clock restarts instead of stalling a fresh wait.
  if ($Memo -and "$($Memo.tenant)" -eq $TenantName -and "$($Memo.sha)" -eq $Sha -and "$($Memo.kind)" -eq 'sync-waiting') {
    $parsed = ConvertTo-UtcDateTime "$($Memo.since)"
    $touched = ConvertTo-UtcDateTime "$($Memo.at)"
    if ($parsed -and $parsed -le $nowUtc -and $touched -and $touched -le $nowUtc -and ($nowUtc - $touched).TotalMinutes -le 35) { $since = $parsed }
  }
  Write-SyncMemo $MemoPath ([ordered]@{ tenant = $TenantName; sha = $Sha; kind = 'sync-waiting'; since = $since.ToString('o'); at = (Now-Iso) })
  $ageMinutes = [int][Math]::Floor(($nowUtc - $since).TotalMinutes)
  $stall = Get-SyncStallMinutes
  $what = if (@($WaitingOn).Count -gt 0) { "required check(s) still running: $(@($WaitingOn) -join ', ')" } else { "the ruleset is still waiting on checks ($PushError)" }
  $result = [ordered]@{ synced = $false; escalate = $false; kind = 'sync-waiting'; to = $ShortSha }
  if (@($WaitingOn).Count -gt 0) { $result.waitingOn = @($WaitingOn) }
  if ($PushError) { $result.pushError = $PushError }
  if ($ageMinutes -ge $stall) {
    $result.escalate = $true; $result.kind = 'sync-stalled'
    $result.reason = "$Rel tip $ShortSha has waited $ageMinutes min (limit $stall) to fast-forward into ${Def}: $what"
    return [pscustomobject]@{ result = $result; exit = 2 }
  }
  $result.reason = "waiting on $Rel tip ${ShortSha}: $what"
  return [pscustomobject]@{ result = $result; exit = 0 }
}

function Get-ReconcileVerdict {
  # fleet #390 (owner ruling 2026-11-06): only a conflict or a red gate comes to Cory. The verdict on the open PR from
  # the tenant's releaseBranch into its defaultBranch: 'clean' (MERGEABLE, every ciGates gate green), 'pending'
  # (MERGEABLE, a gate still running or not reported yet), 'unknown' (GitHub has not computed mergeability), or
  # 'escalate' (a conflict, a red gate, no ciGates to judge by, a PR that is not this tenant's Reconcile PR, or
  # anything unreadable: fail closed, so today's escalation stands). A gate counts as the PR watcher counts it
  # (bin/pr-watch.js evaluateChecks): pending until completed, and any conclusion but SUCCESS fails.
  param($Pr, $TenantJson, [string]$Def, [string]$Rel)
  if (-not $Pr -or $Pr.isDraft -ne $false -or $Pr.isCrossRepository -ne $false) { return 'escalate' }
  if ("$($Pr.headRefName)" -ne $Rel -or "$($Pr.baseRefName)" -ne $Def) { return 'escalate' }
  $gates = @($TenantJson.ciGates | Where-Object { $_ })
  if ($gates.Count -eq 0) { return 'escalate' }
  $pending = $false
  foreach ($gate in $gates) {
    $runs = @($Pr.statusCheckRollup | Where-Object { $null -ne $_ -and ("$($_.name)" -eq "$gate" -or "$($_.context)" -eq "$gate") })
    if ($runs.Count -eq 0) { $pending = $true; continue }
    foreach ($run in $runs) {
      $status = "$($run.status)"; $conclusion = "$($run.conclusion)"
      if (($status -and $status -ne 'COMPLETED') -or (-not $conclusion -and $status -ne 'COMPLETED')) { $pending = $true; continue }
      if ($conclusion -ne 'SUCCESS') { return 'escalate' }
    }
  }
  switch ("$($Pr.mergeable)".ToUpperInvariant()) {
    'MERGEABLE' { if ($pending) { return 'pending' }; return 'clean' }
    'UNKNOWN' { return 'unknown' }
    default { return 'escalate' }
  }
}

function Test-WatcherWillMerge {
  # fleet #390: the PR watcher merges a Reconcile PR only while state/flags/pr-watch-off is absent and the config names
  # the standing reconcile exception (review-policy.standingException). A PR is held for the watcher only if it will act.
  if (Test-Path "$FleetHome\state\flags\pr-watch-off") { return $false }
  try {
    $cfg = Read-Json "$FleetHome\config\review-exceptions.json"
    return [bool](@($cfg.standing) | Where-Object { $_ -and "$($_.kind)" -eq 'reconcile' -and "$($_.ruling)".Trim() } | Select-Object -First 1)
  } catch { return $false }
}

function Get-ReconcileWait {
  # fleet #390: $null when the open PR is not one the PR watcher will merge (escalate as today). Otherwise
  # { number; hold; reason }. A clean, pending or unknown Reconcile PR is held while the watcher can merge it, and
  # released to today's escalation once it has outlived the stall limit (the sync-waiting clock: a wait counts only
  # while it is touched within two ticks), or, for unknown mergeability, once it is still unknown on the second run in
  # a row. $Verdict overrides the reading (a Reconcile PR this run opened is pending: see Get-OpenedReconcileWait).
  # Only an applying run writes the clock, as the other sync memos do: a shadow run must not arm an escalation.
  param([string]$TenantName, $TenantJson, $Pr, [string]$Def, [string]$Rel, [bool]$Apply, [string]$Verdict = '')
  $memoPath = "$FleetHome\state\sentinel\reconcile-hold-$TenantName.json"
  $verdict = if ($Verdict) { $Verdict } else { Get-ReconcileVerdict -Pr $Pr -TenantJson $TenantJson -Def $Def -Rel $Rel }
  if ($verdict -eq 'escalate' -or -not (Test-WatcherWillMerge)) {
    if ($Apply) { Remove-Item $memoPath -ErrorAction SilentlyContinue }
    return $null
  }
  $sha = "$($Pr.headRefOid)"
  $memo = $null; try { $memo = Read-Json $memoPath } catch {}
  $nowUtc = (Get-Date).ToUniversalTime()
  $sameWait = [bool]$memo -and "$($memo.pr)" -eq "$($Pr.number)"
  $touched = if ($sameWait) { ConvertTo-UtcDateTime "$($memo.at)" } else { $null }
  $continues = [bool]($touched -and $touched -le $nowUtc -and ($nowUtc - $touched).TotalMinutes -le 35)
  $since = $nowUtc
  if ($continues) { $parsed = ConvertTo-UtcDateTime "$($memo.since)"; if ($parsed -and $parsed -le $nowUtc) { $since = $parsed } }
  $unknownRuns = 0
  if ($verdict -eq 'unknown') { $unknownRuns = 1; if ($continues -and "$($memo.kind)" -eq 'unknown') { $unknownRuns = [int]$memo.unknownRuns + 1 } }
  if ($Apply) { Write-SyncMemo $memoPath ([ordered]@{ tenant = $TenantName; pr = $Pr.number; sha = $sha; kind = $verdict; since = $since.ToString('o'); unknownRuns = $unknownRuns; at = (Now-Iso) }) }
  $ageMinutes = [int][Math]::Floor(($nowUtc - $since).TotalMinutes)
  $stall = Get-SyncStallMinutes
  if ($verdict -eq 'unknown' -and $unknownRuns -ge 2) { return [pscustomobject]@{ number = $Pr.number; hold = $false; reason = "GitHub still reports no mergeability for reconciliation PR #$($Pr.number) on the second run in a row" } }
  if ($ageMinutes -ge $stall) { return [pscustomobject]@{ number = $Pr.number; hold = $false; reason = "reconciliation PR #$($Pr.number) has been $verdict for $ageMinutes min (limit $stall) and the PR watcher has not merged it" } }
  return [pscustomobject]@{ number = $Pr.number; hold = $true; reason = "reconciliation PR #$($Pr.number) is $verdict; the PR watcher merges it" }
}

function Get-OpenedReconcileWait {
  # fleet #390 (owner ruling 2026-11-06): a Reconcile PR this run opened is pending, not an escalation, so a routine
  # divergence does not page. The number is read from the URL gh printed, and the head is the release branch's tip,
  # which is what the PR was opened from. An applying run starts the clock. What cannot be read escalates as before,
  # and so does a run whose watcher cannot merge the PR (Get-ReconcileWait returns $null then).
  param([string]$TenantName, $TenantJson, [string]$Url, [string]$Def, [string]$Rel, [bool]$Apply)
  if ("$Url" -match '/pull/(\d+)$') { $number = [int]$Matches[1] } else { return $null }
  $sha = "$(& git -C "$($TenantJson.repo)" rev-parse "origin/$Rel" 2>$null)".Trim()
  if ($sha -notmatch '^[0-9a-f]{40}$') { return $null }
  return Get-ReconcileWait -TenantName $TenantName -TenantJson $TenantJson -Pr ([pscustomobject]@{ number = $number; headRefOid = $sha }) -Def $Def -Rel $Rel -Apply $Apply -Verdict 'pending'
}

function New-UnattestedResult {
  # The escalation for a tip that only lacks the fleet-review status: reuses the open reconciliation PR
  # (or opens one, once) so the page carries its URL and the command that clears it.
  param([string]$TenantName, $TenantJson, [string]$Def, [string]$Rel, [string]$Sha, [string]$ShortSha, [string]$ReviewContext)
  $result = [ordered]@{ synced = $false; escalate = $true; kind = 'sync-unattested'; to = $ShortSha }
  $lookup = Get-OpenReconciliationPr -Repo $TenantJson.github -Base $Def -Head $Rel
  $pr = $null
  $wait = $null
  if ($lookup.status -eq 'found') {
    $pr = $lookup.pr
    # fleet #390: the same Reconcile PR as the diverged case; its merge is what lands the fleet-review status on the tip.
    $wait = Get-ReconcileWait -TenantName $TenantName -TenantJson $TenantJson -Pr $pr -Def $Def -Rel $Rel -Apply ([bool]$Apply)
    if ($wait -and $wait.hold) { return [ordered]@{ synced = $false; escalate = $false; kind = 'reconcile-held'; to = $ShortSha; reconcilePr = $pr.number; reason = "$Rel tip $ShortSha lacks ${ReviewContext}; $($wait.reason)" } }
  } elseif ($lookup.status -eq 'none') {
    $created = New-ReconciliationPr -Repo $TenantJson.github -Base $Def -Head $Rel -DefAheadCount 0 -FastForward
    if ($created.ok) {
      $pr = [pscustomobject]@{ url = $created.url }
      # fleet #390 (owner ruling): opened this run, so pending, as in the diverged case.
      $wait = Get-OpenedReconcileWait -TenantName $TenantName -TenantJson $TenantJson -Url $created.url -Def $Def -Rel $Rel -Apply ([bool]$Apply)
      if ($wait -and $wait.hold) { return [ordered]@{ synced = $false; escalate = $false; kind = 'reconcile-held'; to = $ShortSha; reconcilePr = $wait.number; reason = "$Rel tip $ShortSha lacks ${ReviewContext}; $($wait.reason)" } }
    } else { $result.prError = $created.error }
  } else {
    $result.prError = "could not confirm whether a reconciliation PR already exists ($($lookup.error))"
  }
  # Short on purpose: the Watchdog's page body is cut at 300 characters, so the action comes first.
  if ($pr -and $pr.url) {
    $prNumber = ''
    if ($pr.PSObject.Properties['number'] -and $pr.number) { $prNumber = "$($pr.number)" } elseif ("$($pr.url)" -match '/pull/(\d+)') { $prNumber = $Matches[1] }
    $result.prUrl = "$($pr.url)"
    $result.reason = "$Rel tip $ShortSha lacks ${ReviewContext}: merge $($pr.url) with a MERGE COMMIT, or attest it: node bin/review-policy.js attest --tenant $TenantName --pr $prNumber --head $Sha --artifact <review.json>"
    if ($wait) { $result.reason += "; $($wait.reason)" }
  } else {
    $result.reason = "$Rel tip $ShortSha lacks ${ReviewContext}: open a PR $Rel into $Def and merge it with a MERGE COMMIT or attest its head (pr create failed: $($result.prError))"
  }
  return $result
}

$t = Read-Json "$FleetHome\tenants\$Tenant.json"
if (-not $t -or -not $t.releaseBranch -or $t.releaseBranch -eq $t.defaultBranch) { Write-Output (@{ synced = $false; reason = 'tenant has no separate releaseBranch' } | ConvertTo-Json -Compress); exit 0 }
$repo = $t.repo; $def = $t.defaultBranch; $rel = $t.releaseBranch
& git -C $repo fetch -q origin $def $rel 2>$null
$ahead = [int](& git -C $repo rev-list --count "origin/$def..origin/$rel" 2>$null)
$behind = [int](& git -C $repo rev-list --count "origin/$rel..origin/$def" 2>$null)
if ($Apply -and $ahead -eq 0) { Remove-Item "$FleetHome\state\sentinel\reconcile-hold-$Tenant.json" -ErrorAction SilentlyContinue }
if ($ahead -eq 0) { Write-Output (@{ synced = $false; reason = "$def already has everything on $rel"; defAheadOfRel = $behind } | ConvertTo-Json -Compress); exit 0 }
& git -C $repo merge-base --is-ancestor "origin/$def" "origin/$rel" 2>$null
if ($LASTEXITCODE -ne 0) {
  # Structurally diverged. After every release this is the normal state for a while: the release
  # merge commit sits on $rel while $def keeps moving, and the fast-forward window is minutes.
  # Escalate only when $rel carries CONTENT $def lacks; a merge commit adding no tree change
  # reconciles itself on the next release (ruled 2026-09-01, dispatcher board item 8).
  & git -C $repo diff --quiet "origin/$def...origin/$rel" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Output (@{ synced = $false; reason = "$def and $rel structurally diverged, but $rel adds no content $def lacks (release merge commit only); reconciles on the next release, no action needed"; escalate = $false } | ConvertTo-Json -Compress); exit 0
  }
  $result = [ordered]@{ synced = $false; escalate = $true; kind = 'branch-diverged' }
  $lookup = Get-OpenReconciliationPr -Repo $t.github -Base $def -Head $rel
  $pr = $null
  $wait = $null
  if ($lookup.status -eq 'found') {
    $pr = $lookup.pr
    # fleet #390: a Reconcile PR the PR watcher will merge is held, not escalated (see Get-ReconcileWait).
    $wait = Get-ReconcileWait -TenantName $Tenant -TenantJson $t -Pr $pr -Def $def -Rel $rel -Apply ([bool]$Apply)
    if ($wait -and $wait.hold) { Write-Output ([ordered]@{ synced = $false; escalate = $false; kind = 'reconcile-held'; reconcilePr = $pr.number; reason = "$def and $rel have diverged; $($wait.reason)" } | ConvertTo-Json -Compress); exit 0 }
  } elseif ($lookup.status -eq 'none') {
    $created = New-ReconciliationPr -Repo $t.github -Base $def -Head $rel -DefAheadCount $behind
    if ($created.ok) {
      $pr = [pscustomobject]@{ url = $created.url }
      # fleet #390 (owner ruling): the run that opens the Reconcile PR is pending, not an escalation.
      $wait = Get-OpenedReconcileWait -TenantName $Tenant -TenantJson $t -Url $created.url -Def $def -Rel $rel -Apply ([bool]$Apply)
      if ($wait -and $wait.hold) { Write-Output ([ordered]@{ synced = $false; escalate = $false; kind = 'reconcile-held'; reconcilePr = $wait.number; reason = "$def and $rel have diverged; $($wait.reason)" } | ConvertTo-Json -Compress); exit 0 }
    } else { $result.prError = $created.error }
  } else {
    # 'unknown': gh could not confirm whether a PR already exists. Creating one anyway
    # would risk a duplicate on every tick of an outage; escalate instead and let the
    # next tick try again once gh is readable.
    $result.prError = "could not confirm whether a reconciliation PR already exists ($($lookup.error))"
  }
  if ($pr -and $pr.url) {
    $result.prUrl = $pr.url
    $result.reason = "$def and $rel have diverged and $rel carries content changes absent from $def; needs a human MERGE COMMIT ($behind commit(s) on the $def side) - reconciliation PR: $($pr.url)"
    if ($wait) { $result.reason += "; $($wait.reason)" }
  } else {
    $result.reason = "$def and $rel have diverged and $rel carries content changes absent from $def; needs a human merge ($behind commit(s) on the $def side); opening the reconciliation PR failed: $($result.prError)"
  }
  Write-Output ($result | ConvertTo-Json -Compress); exit 2
}
if (-not $Apply) { Write-Output (@{ synced = $false; dryRun = $true; wouldFastForward = $ahead } | ConvertTo-Json -Compress); exit 0 }
# fleet #274: read what the ruleset will judge before pushing. The lookups are best-effort: an unreadable
# rules or status answer means push as today, and an ABSENT context (no status posted yet) is never a
# reason to pre-refuse - a tip has passed the ruleset without one before.
$tipSha = "$(& git -C $repo rev-parse "origin/$rel" 2>$null)".Trim()
$tipShort = "$(& git -C $repo rev-parse --short "origin/$rel" 2>$null)".Trim()
$reviewContext = 'fleet-review'
if ($t.PSObject.Properties['reviewStatus'] -and "$($t.reviewStatus)".Trim()) { $reviewContext = "$($t.reviewStatus)".Trim() }
# Per tenant: the release-branch tenants share FleetHome, so one file would let tenant B clear or overwrite A's memo.
$memoPath = "$FleetHome\state\sentinel\sync-last-$Tenant.json"
$memo = $null; try { $memo = Read-Json $memoPath } catch {}
$required = Get-RequiredContexts -Repo $t.github -Branch $def
$tipState = Get-CommitCheckState -Repo $t.github -Sha $tipSha
if ($required.status -eq 'ok' -and $tipState.status -eq 'ok') {
  $failedChecks = @($required.contexts | Where-Object { $tipState.classes[$_] -eq 'failed' })
  $waitingOn = @($required.contexts | Where-Object { $tipState.classes[$_] -eq 'pending' })
  if ($failedChecks.Count -gt 0) {
    # A red check will not heal by waiting; a pending one beside it does not change that.
    if ($memo -and "$($memo.kind)" -eq 'sync-waiting') { Remove-Item $memoPath -ErrorAction SilentlyContinue }
    Write-Output ([ordered]@{ synced = $false; escalate = $true; kind = 'sync-blocked'; to = $tipShort; failedChecks = $failedChecks; reason = "$rel tip $tipShort cannot be fast-forwarded into ${def}: required check(s) failed on it: $($failedChecks -join ', ')" } | ConvertTo-Json -Compress)
    exit 2
  }
  if ($waitingOn.Count -gt 0) {
    $waiting = New-WaitingOutcome -TenantName $Tenant -Def $def -Rel $rel -Sha $tipSha -ShortSha $tipShort -WaitingOn $waitingOn -PushError '' -Memo $memo -MemoPath $memoPath
    Write-Output ($waiting.result | ConvertTo-Json -Compress)
    exit $waiting.exit
  }
}

# The evidence memo: an unattested tip stays unattested until something changes on it, so the same sha
# with the same required contexts and the same status and check-run counts is reported again without
# another push (each refused push is a failed rule suite on the remote). Counts are only known when the
# status lookups worked; without them, and once the memo is older than the recheck window, the push is
# tried again. The same file remembers when a sha first waited (sync-waiting, see New-WaitingOutcome).
$memoRecheckMinutes = 360
$contextsKey = '?'; if ($required.status -eq 'ok') { $contextsKey = (@($required.contexts | Sort-Object) -join ',') }
if ($memo -and "$($memo.tenant)" -eq $Tenant -and "$($memo.sha)" -eq $tipSha -and "$($memo.kind)" -eq 'sync-unattested' -and "$($memo.contexts)" -eq $contextsKey -and $null -ne $tipState.statusCount -and $null -ne $memo.statusCount -and $null -ne $memo.checkRunCount) {
  $memoAt = ConvertTo-UtcDateTime "$($memo.at)"
  $memoFresh = ($memoAt -and ((Get-Date).ToUniversalTime() - $memoAt).TotalMinutes -lt $memoRecheckMinutes -and ((Get-Date).ToUniversalTime() - $memoAt).TotalMinutes -ge 0)
  if ($memoFresh -and [int]$memo.statusCount -eq $tipState.statusCount -and [int]$memo.checkRunCount -eq $tipState.checkRunCount) {
    $unattested = New-UnattestedResult -TenantName $Tenant -TenantJson $t -Def $def -Rel $rel -Sha $tipSha -ShortSha $tipShort -ReviewContext $reviewContext
    Write-Output ($unattested | ConvertTo-Json -Compress)
    if ($unattested.escalate) { exit 2 }
    exit 0
  }
}
# Start-Process + -RedirectStandardError, not `2>&1`: PS 5.1 wraps a native command's
# stderr lines in ErrorRecords when captured through the pipeline, which pollutes the
# refusal text with "At line:..."/CategoryInfo noise instead of git's own message.
$pushErrFile = [IO.Path]::GetTempFileName()
$pushOutFile = [IO.Path]::GetTempFileName()
try {
  $p = Start-Process -FilePath 'git' -ArgumentList @('-C', $repo, 'push', '-q', 'origin', "origin/${rel}:refs/heads/$def") -NoNewWindow -PassThru -Wait -RedirectStandardOutput $pushOutFile -RedirectStandardError $pushErrFile
  $ok = ($p.ExitCode -eq 0)
  $pushErrText = ''; try { $pushErrText = Get-Content $pushErrFile -Raw -ErrorAction SilentlyContinue } catch {}
} finally { Remove-Item $pushOutFile, $pushErrFile -ErrorAction SilentlyContinue }
if ($ok) {
  Remove-Item $memoPath -ErrorAction SilentlyContinue
  Write-Output (@{ synced = $true; fastForwarded = $ahead; to = (& git -C $repo rev-parse --short "origin/$rel") } | ConvertTo-Json -Compress)
} else {
  $pushError = (("$pushErrText" -replace '\s+', ' ').Trim())
  $refusal = Get-RefusalKind $pushError $reviewContext
  if ($refusal -eq 'sync-waiting') {
    # A check is still running on the tip: the ruleset will say yes on a later tick. Not a page, until
    # the same sha has waited past the stall limit.
    $waiting = New-WaitingOutcome -TenantName $Tenant -Def $def -Rel $rel -Sha $tipSha -ShortSha $tipShort -WaitingOn @() -PushError $pushError -Memo $memo -MemoPath $memoPath
    Write-Output ($waiting.result | ConvertTo-Json -Compress)
    exit $waiting.exit
  }
  if ($refusal -eq 'sync-unattested') {
    $unattested = New-UnattestedResult -TenantName $Tenant -TenantJson $t -Def $def -Rel $rel -Sha $tipSha -ShortSha $tipShort -ReviewContext $reviewContext
    Write-SyncMemo $memoPath ([ordered]@{ tenant = $Tenant; sha = $tipSha; kind = 'sync-unattested'; contexts = $contextsKey; statusCount = $tipState.statusCount; checkRunCount = $tipState.checkRunCount; at = (Now-Iso) })
    Write-Output ($unattested | ConvertTo-Json -Compress)
    if ($unattested.escalate) { exit 2 }
    exit 0
  }
  Write-Output (@{ synced = $false; pushError = $pushError; escalate = $true; kind = 'sync-refused' } | ConvertTo-Json -Compress)
  exit 2
}
