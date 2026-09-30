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
# command, and is memoized in state/sentinel/sync-last.json so the same sha and status counts are not
# pushed on every tick.
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
  try { $raw = & gh pr list -R $Repo --base $Base --head $Head --state open --json number,url 2>&1 }
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
      default { return 'pending' }
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
  foreach ($r in $runs) { & $add "$($r.name)" (ConvertTo-CheckClass -Kind 'run' -State "$($r.status)" -Conclusion "$($r.conclusion)") }
  return [pscustomobject]@{ status = 'ok'; classes = $seen; statusCount = $statuses.Count; checkRunCount = $runs.Count }
}

function Get-RefusalKind {
  # Classifies a refused push by git's text. Checks in progress or pending win (the next tick sees
  # the settled state); an expected context with nothing running is an unattested tip; a bare
  # "have not succeeded" is waiting; anything else is an unexplained refusal.
  param([string]$Text)
  if ($Text -match 'is in progress|are in progress|is pending|are pending') { return 'sync-waiting' }
  if ($Text -match 'is expected|are expected') { return 'sync-unattested' }
  if ($Text -match 'have not succeeded') { return 'sync-waiting' }
  return 'sync-refused'
}

function New-UnattestedResult {
  # The escalation for a tip that only lacks the fleet-review status: reuses the open reconciliation PR
  # (or opens one, once) so the page carries its URL and the command that clears it.
  param([string]$TenantName, $TenantJson, [string]$Def, [string]$Rel, [string]$Sha, [string]$ShortSha)
  $result = [ordered]@{ synced = $false; escalate = $true; kind = 'sync-unattested'; to = $ShortSha }
  $lookup = Get-OpenReconciliationPr -Repo $TenantJson.github -Base $Def -Head $Rel
  $pr = $null
  if ($lookup.status -eq 'found') {
    $pr = $lookup.pr
  } elseif ($lookup.status -eq 'none') {
    $created = New-ReconciliationPr -Repo $TenantJson.github -Base $Def -Head $Rel -DefAheadCount 0 -FastForward
    if ($created.ok) { $pr = [pscustomobject]@{ url = $created.url } } else { $result.prError = $created.error }
  } else {
    $result.prError = "could not confirm whether a reconciliation PR already exists ($($lookup.error))"
  }
  $lead = "$Rel tip $ShortSha carries no fleet-review status, which the ruleset on $Def requires"
  if ($pr -and $pr.url) {
    $prNumber = ''
    if ($pr.PSObject.Properties['number'] -and $pr.number) { $prNumber = "$($pr.number)" } elseif ("$($pr.url)" -match '/pull/(\d+)') { $prNumber = $Matches[1] }
    $result.prUrl = "$($pr.url)"
    $result.reason = "$lead; reconciliation PR: $($pr.url); attest it: node bin/review-policy.js attest --tenant $TenantName --pr $prNumber --head $Sha --artifact <review.json>, or merge it with a MERGE COMMIT"
  } else {
    $result.reason = "$lead; opening the reconciliation PR failed: $($result.prError); once it exists attest its head ($Sha) with node bin/review-policy.js attest --tenant $TenantName, or merge it with a MERGE COMMIT"
  }
  return $result
}

$t = Read-Json "$FleetHome\tenants\$Tenant.json"
if (-not $t -or -not $t.releaseBranch -or $t.releaseBranch -eq $t.defaultBranch) { Write-Output (@{ synced = $false; reason = 'tenant has no separate releaseBranch' } | ConvertTo-Json -Compress); exit 0 }
$repo = $t.repo; $def = $t.defaultBranch; $rel = $t.releaseBranch
& git -C $repo fetch -q origin $def $rel 2>$null
$ahead = [int](& git -C $repo rev-list --count "origin/$def..origin/$rel" 2>$null)
$behind = [int](& git -C $repo rev-list --count "origin/$rel..origin/$def" 2>$null)
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
  if ($lookup.status -eq 'found') {
    $pr = $lookup.pr
  } elseif ($lookup.status -eq 'none') {
    $created = New-ReconciliationPr -Repo $t.github -Base $def -Head $rel -DefAheadCount $behind
    if ($created.ok) { $pr = [pscustomobject]@{ url = $created.url } } else { $result.prError = $created.error }
  } else {
    # 'unknown': gh could not confirm whether a PR already exists. Creating one anyway
    # would risk a duplicate on every tick of an outage; escalate instead and let the
    # next tick try again once gh is readable.
    $result.prError = "could not confirm whether a reconciliation PR already exists ($($lookup.error))"
  }
  if ($pr -and $pr.url) {
    $result.prUrl = $pr.url
    $result.reason = "$def and $rel have diverged and $rel carries content changes absent from $def; needs a human MERGE COMMIT ($behind commit(s) on the $def side) - reconciliation PR: $($pr.url)"
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
$required = Get-RequiredContexts -Repo $t.github -Branch $def
$tipState = Get-CommitCheckState -Repo $t.github -Sha $tipSha
if ($required.status -eq 'ok' -and $tipState.status -eq 'ok') {
  $failedChecks = @($required.contexts | Where-Object { $tipState.classes[$_] -eq 'failed' })
  $waitingOn = @($required.contexts | Where-Object { $tipState.classes[$_] -eq 'pending' })
  if ($failedChecks.Count -gt 0) {
    # A red check will not heal by waiting; a pending one beside it does not change that.
    Write-Output ([ordered]@{ synced = $false; escalate = $true; kind = 'sync-blocked'; to = $tipShort; failedChecks = $failedChecks; reason = "$rel tip $tipShort cannot be fast-forwarded into ${def}: required check(s) failed on it: $($failedChecks -join ', ')" } | ConvertTo-Json -Compress)
    exit 2
  }
  if ($waitingOn.Count -gt 0) {
    Write-Output ([ordered]@{ synced = $false; escalate = $false; kind = 'sync-waiting'; to = $tipShort; waitingOn = $waitingOn; reason = "waiting on required check(s) still running on $rel tip ${tipShort}: $($waitingOn -join ', ')" } | ConvertTo-Json -Compress)
    exit 0
  }
}

# The evidence memo: an unattested tip stays unattested until something changes on it, so the same sha
# with the same status and check-run counts is reported again without another push (each refused push
# is a failed rule suite on the remote). Counts are only known when the status lookups worked; without
# them, and once the memo is older than the recheck window, the push is tried again.
$memoPath = "$FleetHome\state\sentinel\sync-last.json"
$memoRecheckMinutes = 360
$memo = $null; try { $memo = Read-Json $memoPath } catch {}
if ($memo -and "$($memo.tenant)" -eq $Tenant -and "$($memo.sha)" -eq $tipSha -and "$($memo.kind)" -eq 'sync-unattested' -and $null -ne $tipState.statusCount -and $null -ne $memo.statusCount -and $null -ne $memo.checkRunCount) {
  $memoAt = ConvertTo-UtcDateTime "$($memo.at)"
  $memoFresh = ($memoAt -and ((Get-Date).ToUniversalTime() - $memoAt).TotalMinutes -lt $memoRecheckMinutes -and ((Get-Date).ToUniversalTime() - $memoAt).TotalMinutes -ge 0)
  if ($memoFresh -and [int]$memo.statusCount -eq $tipState.statusCount -and [int]$memo.checkRunCount -eq $tipState.checkRunCount) {
    Write-Output ((New-UnattestedResult -TenantName $Tenant -TenantJson $t -Def $def -Rel $rel -Sha $tipSha -ShortSha $tipShort) | ConvertTo-Json -Compress)
    exit 2
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
  $refusal = Get-RefusalKind $pushError
  if ($refusal -eq 'sync-waiting') {
    # A check is still running on the tip: the ruleset will say yes on a later tick. Not a page.
    Write-Output ([ordered]@{ synced = $false; escalate = $false; kind = 'sync-waiting'; to = $tipShort; pushError = $pushError } | ConvertTo-Json -Compress)
    exit 0
  }
  if ($refusal -eq 'sync-unattested') {
    $unattested = New-UnattestedResult -TenantName $Tenant -TenantJson $t -Def $def -Rel $rel -Sha $tipSha -ShortSha $tipShort
    try {
      [IO.Directory]::CreateDirectory((Split-Path -Parent $memoPath)) | Out-Null
      Write-Json $memoPath ([ordered]@{ tenant = $Tenant; sha = $tipSha; kind = 'sync-unattested'; statusCount = $tipState.statusCount; checkRunCount = $tipState.checkRunCount; at = (Now-Iso) })
    } catch {}
    Write-Output ($unattested | ConvertTo-Json -Compress)
    exit 2
  }
  Write-Output (@{ synced = $false; pushError = $pushError; escalate = $true; kind = 'sync-refused' } | ConvertTo-Json -Compress)
  exit 2
}
