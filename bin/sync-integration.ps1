# Fast-forward a tenant's defaultBranch to its releaseBranch (e.g. integration <- main) after Cory merges
# something straight to the release branch. Refuses anything that is not a pure fast-forward.
# Ticket 09 (fleet #87): real divergence (content on the release side the default branch lacks) opens
# the reconciliation PR itself instead of only escalating text - idempotent across ticks via `gh pr
# list` first. The PR must merge as a MERGE COMMIT, never squash: squashing a release-into-default PR
# rewrites the release branch's history out of the default branch, which re-diverges it on the next
# release. A push refused mid-apply (e.g. a pre-receive hook) records git's stderr and escalates.
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
  param([string]$Repo, [string]$Base, [string]$Head, [int]$DefAheadCount)
  $body = "This PR reconciles $Head into $Base. $Head carries content changes $Base lacks, and the fast-forward the fleet normally performs is not possible ($DefAheadCount commit(s) on the $Base side that $Head does not have).`n`n" +
    "Merge this with a MERGE COMMIT. Do not squash: a squash merge of the release branch into the default branch rewrites the release branch's history out of the default branch, which re-diverges the two on the next release."
  $bodyFile = [IO.Path]::GetTempFileName()
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($bodyFile, $body, $script:Utf8)
    $ghArgs = @('pr', 'create', '-R', $Repo, '--base', $Base, '--head', $Head, '--title', "Reconcile $Head into $Base", '--body-file', $bodyFile)
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
  Write-Output (@{ synced = $true; fastForwarded = $ahead; to = (& git -C $repo rev-parse --short "origin/$rel") } | ConvertTo-Json -Compress)
} else {
  Write-Output (@{ synced = $false; pushError = (("$pushErrText" -replace '\s+', ' ').Trim()); escalate = $true; kind = 'sync-refused' } | ConvertTo-Json -Compress)
  exit 2
}
