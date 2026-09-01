# Fast-forward a tenant's defaultBranch to its releaseBranch (e.g. integration <- main) after Cory merges
# something straight to the release branch. Refuses anything that is not a pure fast-forward.
param([string]$Tenant = 'endzone', [switch]$Apply)
. "$PSScriptRoot\_common.ps1"
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
  Write-Output (@{ synced = $false; reason = "$def and $rel have diverged and $rel carries content changes absent from $def; needs a human merge ($behind commit(s) on the $def side)"; escalate = $true } | ConvertTo-Json -Compress); exit 2
}
if (-not $Apply) { Write-Output (@{ synced = $false; dryRun = $true; wouldFastForward = $ahead } | ConvertTo-Json -Compress); exit 0 }
& git -C $repo push -q origin "origin/${rel}:refs/heads/$def" 2>&1 | Out-Null
$ok = ($LASTEXITCODE -eq 0)
Write-Output (@{ synced = $ok; fastForwarded = $ahead; to = (& git -C $repo rev-parse --short "origin/$rel") } | ConvertTo-Json -Compress)
