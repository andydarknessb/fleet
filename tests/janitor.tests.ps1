# Ticket 09 (fleet #88): the weekly janitor removes a worktree only when its Work record
# is settled AND git status is clean AND the branch is merged or gone on the remote; else
# it lists the worktree with the reason and never touches it. -DryRun (the default) writes
# nothing. Also covers the tmp-litter sweep, escalation archiving, and stale IC heartbeats.
# All paths (tenant repo, state root, TEMP) are fixture-local; the real TEMP is never touched.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Invoke-Git {
  # 2>&1 on a native command under EAP Stop turns child stderr into a terminating
  # ErrorRecord (PS 5.1); relax around every git call so porcelain text stays plain data.
  param([string[]]$GitArgs)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & git @GitArgs 2>&1 | Out-String } finally { $ErrorActionPreference = $eap }
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-janitor-test-" + [guid]::NewGuid().ToString('N'))

function Run-Janitor {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\janitor.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
}
function Find-Worktree { param($Report, [string]$Name) @($Report.worktrees | Where-Object { $_.path -match [regex]::Escape($Name) })[0] }
function Set-OldTimestamp { param([string]$Path, [int]$DaysAgo) (Get-Item -LiteralPath $Path).LastWriteTime = (Get-Date).AddDays(-$DaysAgo) }

# Small, independent fixtures for the review-round safety checks below: each gets its
# own mini fleet root so corrupting one input (active.json, roster.json, a tenant's
# defaultBranch) cannot contaminate the main fixture's later assertions.
function New-MiniRoot {
  param([string]$Name)
  $root = "$testRoot\mini-$Name"
  foreach ($dir in 'bin', 'tenants', 'state', 'state/work', 'state/heartbeats', 'state/escalations', 'mini-temp') {
    [IO.Directory]::CreateDirectory((Join-Path $root $dir)) | Out-Null
  }
  [IO.File]::Copy("$sourceRoot\bin\_common.ps1", "$root\bin\_common.ps1")
  [IO.File]::Copy("$sourceRoot\bin\janitor.ps1", "$root\bin\janitor.ps1")
  return $root
}
function Run-JanitorAt {
  param([string]$Root, [string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\bin\janitor.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
}
function New-MiniTenantRepo {
  # A minimal tenant repo with one merged, clean, pushed branch - every AND-condition
  # already satisfied, so the ONLY thing that can still block removal is whatever the
  # calling scenario deliberately breaks.
  param([string]$Root, [string]$TenantName, [int]$Issue, [string]$BranchSlug)
  $remote = "$Root\remote-$TenantName.git"; $repo = "$Root\repo-$TenantName"
  Invoke-Git @('init', '--bare', '-q', $remote) | Out-Null
  Invoke-Git @('clone', '-q', $remote, $repo) | Out-Null
  Invoke-Git @('-C', $repo, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-Git @('-C', $repo, 'config', 'user.name', 'a') | Out-Null
  Invoke-Git @('-C', $repo, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-Git @('-C', $repo, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-Git @('-C', $repo, 'push', '-q', '-u', 'origin', 'main') | Out-Null
  $branch = "$Issue-$BranchSlug"
  Invoke-Git @('-C', $repo, 'branch', $branch, 'main') | Out-Null
  Invoke-Git @('-C', $repo, 'checkout', '-q', $branch) | Out-Null
  Write-Utf8 "$repo\f.txt" 'x'
  Invoke-Git @('-C', $repo, 'add', '-A') | Out-Null
  Invoke-Git @('-C', $repo, 'commit', '-q', '-m', 'work') | Out-Null
  Invoke-Git @('-C', $repo, 'checkout', '-q', 'main') | Out-Null
  Invoke-Git @('-C', $repo, 'merge', '-q', '--no-ff', '-m', 'merge', $branch) | Out-Null
  Invoke-Git @('-C', $repo, 'push', '-q', 'origin', 'main', $branch) | Out-Null
  $wt = "$Root\.claude\worktrees\$branch"
  Invoke-Git @('-C', $repo, 'worktree', 'add', '-q', $wt, $branch) | Out-Null
  return [pscustomobject]@{ repo = $repo; branch = $branch; worktree = $wt }
}

try {
  foreach ($dir in 'bin', 'tenants', 'state', 'state/work', 'state/heartbeats', 'state/escalations', 'os-temp') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  [IO.File]::Copy("$sourceRoot\bin\_common.ps1", "$testRoot\bin\_common.ps1")
  [IO.File]::Copy("$sourceRoot\bin\janitor.ps1", "$testRoot\bin\janitor.ps1")

  # --- tenant repo: a bare remote + a clone the fixture builds five worktree scenarios from ---
  $remote = "$testRoot\remote.git"; $repo = "$testRoot\repo"
  Invoke-Git @('init', '--bare', '-q', $remote) | Out-Null
  Invoke-Git @('clone', '-q', $remote, $repo) | Out-Null
  Invoke-Git @('-C', $repo, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-Git @('-C', $repo, 'config', 'user.name', 'a') | Out-Null
  Invoke-Git @('-C', $repo, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-Git @('-C', $repo, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-Git @('-C', $repo, 'push', '-q', '-u', 'origin', 'main') | Out-Null

  function New-Branch { param([string]$Name) Invoke-Git @('-C', $repo, 'branch', $Name, 'main') | Out-Null; Invoke-Git @('-C', $repo, 'checkout', '-q', $Name) | Out-Null; Write-Utf8 "$repo\$Name.txt" 'x'; Invoke-Git @('-C', $repo, 'add', '-A') | Out-Null; Invoke-Git @('-C', $repo, 'commit', '-q', '-m', $Name) | Out-Null; Invoke-Git @('-C', $repo, 'checkout', '-q', 'main') | Out-Null }
  function Merge-IntoMain { param([string]$Name) Invoke-Git @('-C', $repo, 'merge', '-q', '--no-ff', '-m', "merge $Name", $Name) | Out-Null }
  function Add-Worktree { param([string]$Name) $p = "$testRoot\.claude\worktrees\$Name"; Invoke-Git @('-C', $repo, 'worktree', 'add', '-q', $p, $Name) | Out-Null; return $p }

  # (a) issue 88: merged branch, clean tree, Work record merged -> removed under -Apply.
  # Pushed to origin (and left there) so the branch is NOT also vacuously "gone on the
  # remote" - this isolates the ancestry leg of condition 3 for real.
  New-Branch '88-clean-merged'; Merge-IntoMain '88-clean-merged'
  Invoke-Git @('-C', $repo, 'push', '-q', 'origin', '88-clean-merged') | Out-Null
  $wtA = Add-Worktree '88-clean-merged'

  # (b) issue 89: merged branch too (isolates the dirtiness), but an untracked file makes
  # git status non-empty -> listed, kept.
  New-Branch '89-dirty'; Merge-IntoMain '89-dirty'
  Invoke-Git @('-C', $repo, 'push', '-q', 'origin', '89-dirty') | Out-Null
  $wtB = Add-Worktree '89-dirty'
  Write-Utf8 "$wtB\untracked.txt" 'uncommitted'

  # (c) issue 90: clean tree, but the branch is neither merged nor deleted on the remote
  # -> listed, kept (the plain "unmerged" case).
  New-Branch '90-clean-unmerged'
  Invoke-Git @('-C', $repo, 'push', '-q', '-u', 'origin', '90-clean-unmerged') | Out-Null
  $wtC = Add-Worktree '90-clean-unmerged'

  # (d) issue 91: clean tree, never merged by ancestry (the tenant squash-merges, so this
  # is the realistic "finished" shape), but its remote branch is gone -> removed via the
  # OR leg of condition 3.
  New-Branch '91-clean-squashed'
  Invoke-Git @('-C', $repo, 'push', '-q', '-u', 'origin', '91-clean-squashed') | Out-Null
  $wtD = Add-Worktree '91-clean-squashed'
  Invoke-Git @('-C', $repo, 'push', '-q', 'origin', '--delete', '91-clean-squashed') | Out-Null

  # (e) issue 92: merged branch, clean tree, but the Work record is still 'implementing'
  # (condition 1 fails on its own) -> listed, kept.
  New-Branch '92-clean-open-record'; Merge-IntoMain '92-clean-open-record'
  Invoke-Git @('-C', $repo, 'push', '-q', 'origin', '92-clean-open-record') | Out-Null
  $wtE = Add-Worktree '92-clean-open-record'

  # (f) issue 97: merged branch (so only condition 2 is under test), but the worktree's
  # own .git link file is corrupted -> `git status --porcelain` fails outright. A failed
  # read must be UNKNOWN, never "clean" (review finding 2) -> listed, kept.
  New-Branch '97-broken-gitlink'; Merge-IntoMain '97-broken-gitlink'
  Invoke-Git @('-C', $repo, 'push', '-q', 'origin', '97-broken-gitlink') | Out-Null
  $wtF = Add-Worktree '97-broken-gitlink'
  try { [IO.File]::SetAttributes("$wtF\.git", [IO.FileAttributes]::Normal) } catch {}
  Write-Utf8 "$wtF\.git" 'gitdir: /nonexistent/path/that/does/not/exist'

  Invoke-Git @('-C', $repo, 'push', '-q', 'origin', 'main') | Out-Null

  Write-Utf8 "$testRoot\tenants\t.json" (@{ name = 't'; repo = $repo; github = 'owner/repo'; defaultBranch = 'main' } | ConvertTo-Json -Compress)
  Write-Utf8 "$testRoot\state\work\active.json" (@{
      schemaVersion = 1
      records       = [ordered]@{
        't:issue-88' = @{ state = 'merged' }
        't:issue-89' = @{ state = 'merged' }
        't:issue-90' = @{ state = 'merged' }
        't:issue-91' = @{ state = 'retired' }
        't:issue-92' = @{ state = 'implementing' }
        't:issue-93' = @{ state = 'hold' }
        't:issue-97' = @{ state = 'merged' }
        'u:issue-95' = @{ state = 'merged' }
      }
    } | ConvertTo-Json -Depth 8)

  # (g) tenant "u": issue 95, clean tree, unmerged branch, but origin itself is
  # unreachable once set up -> `git ls-remote` fails (nonzero exit, not empty stdout).
  # A failed remote lookup must be UNKNOWN, never "gone" (review finding 1, the
  # blocker) -> listed, kept, even though the Work record and tree are both fine.
  $remoteU = "$testRoot\remoteU.git"; $repoU = "$testRoot\repoU"
  Invoke-Git @('init', '--bare', '-q', $remoteU) | Out-Null
  Invoke-Git @('clone', '-q', $remoteU, $repoU) | Out-Null
  Invoke-Git @('-C', $repoU, 'config', 'user.email', 'a@b.com') | Out-Null
  Invoke-Git @('-C', $repoU, 'config', 'user.name', 'a') | Out-Null
  Invoke-Git @('-C', $repoU, 'checkout', '-q', '-b', 'main') | Out-Null
  Invoke-Git @('-C', $repoU, 'commit', '-q', '--allow-empty', '-m', 'init') | Out-Null
  Invoke-Git @('-C', $repoU, 'push', '-q', '-u', 'origin', 'main') | Out-Null
  Invoke-Git @('-C', $repoU, 'branch', '95-remote-down', 'main') | Out-Null
  Invoke-Git @('-C', $repoU, 'checkout', '-q', '95-remote-down') | Out-Null
  Write-Utf8 "$repoU\95.txt" 'x'
  Invoke-Git @('-C', $repoU, 'add', '-A') | Out-Null
  Invoke-Git @('-C', $repoU, 'commit', '-q', '-m', '95') | Out-Null
  Invoke-Git @('-C', $repoU, 'checkout', '-q', 'main') | Out-Null
  $wtU = "$testRoot\.claude\worktrees\95-remote-down"
  Invoke-Git @('-C', $repoU, 'worktree', 'add', '-q', $wtU, '95-remote-down') | Out-Null
  Invoke-Git @('-C', $repoU, 'remote', 'set-url', 'origin', "$testRoot\does-not-exist.git") | Out-Null
  Write-Utf8 "$testRoot\tenants\u.json" (@{ name = 'u'; repo = $repoU; github = 'owner/repou'; defaultBranch = 'main' } | ConvertTo-Json -Compress)

  # --- state/tmp-* and TEMP/fleet-work-state-* litter, old and young ---
  [IO.Directory]::CreateDirectory("$testRoot\state\tmp-old") | Out-Null
  Set-OldTimestamp "$testRoot\state\tmp-old" 10
  [IO.Directory]::CreateDirectory("$testRoot\state\tmp-young") | Out-Null
  Set-OldTimestamp "$testRoot\state\tmp-young" 2
  [IO.Directory]::CreateDirectory("$testRoot\os-temp\fleet-work-state-old") | Out-Null
  Set-OldTimestamp "$testRoot\os-temp\fleet-work-state-old" 10
  [IO.Directory]::CreateDirectory("$testRoot\os-temp\fleet-work-state-young") | Out-Null
  Set-OldTimestamp "$testRoot\os-temp\fleet-work-state-young" 2

  # --- escalations: settled (archived), still a decision state (kept), old with no
  # --- record (archived), young with no record (kept) ---
  Write-Utf8 "$testRoot\state\escalations\esc-settled.json" (@{ at = (Get-Date).ToUniversalTime().AddDays(-20).ToString('o'); from = 'supervisor'; kind = 'blocked'; name = 'ic-88' } | ConvertTo-Json -Compress)
  Write-Utf8 "$testRoot\state\escalations\esc-decision.json" (@{ at = (Get-Date).ToUniversalTime().AddDays(-20).ToString('o'); from = 'supervisor'; kind = 'hold'; name = 'ic-93' } | ConvertTo-Json -Compress)
  Write-Utf8 "$testRoot\state\escalations\esc-old-norecord.json" (@{ at = (Get-Date).ToUniversalTime().AddDays(-20).ToString('o'); from = 'supervisor'; kind = 'stray'; name = 'ic-999' } | ConvertTo-Json -Compress)
  Write-Utf8 "$testRoot\state\escalations\esc-young-norecord.json" (@{ at = (Get-Date).ToUniversalTime().AddDays(-2).ToString('o'); from = 'supervisor'; kind = 'stray'; name = 'ic-998' } | ConvertTo-Json -Compress)

  # --- heartbeats: ic-77 is on the live roster (kept), ic-88 is not (removed) ---
  Write-Utf8 "$testRoot\state\roster.json" (@{ sessions = @(@{ name = 'ic-77'; role = 'ic'; tenant = 't'; issue = 77; status = 'active' }) } | ConvertTo-Json -Depth 6)
  Write-Utf8 "$testRoot\state\heartbeats\ic-77.json" (@{ at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)
  Write-Utf8 "$testRoot\state\heartbeats\ic-88.json" (@{ at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)

  # ================= -DryRun (the default): report only, touch nothing =================
  # -TempRoot is passed even in dry run: the real %TEMP% must never be enumerated by this suite.
  $dry = Run-Janitor @('-TempRoot', "$testRoot\os-temp")
  Assert-True ((Find-Worktree $dry '88-clean-merged').action -eq 'would-remove') 'a settled, clean, merged worktree must be reported would-remove in dry run'
  Assert-True ((Find-Worktree $dry '89-dirty').action -eq 'listed' -and "$((Find-Worktree $dry '89-dirty').reason)" -match 'porcelain') 'a dirty worktree must be listed with the git-status reason'
  Assert-True ((Find-Worktree $dry '90-clean-unmerged').action -eq 'listed' -and "$((Find-Worktree $dry '90-clean-unmerged').reason)" -match 'neither merged') 'an unmerged worktree with its remote branch intact must be listed'
  Assert-True ((Find-Worktree $dry '91-clean-squashed').action -eq 'would-remove') 'a worktree whose branch is only gone on the remote (squash-merge shape) must still be removable'
  Assert-True ((Find-Worktree $dry '92-clean-open-record').action -eq 'listed' -and "$((Find-Worktree $dry '92-clean-open-record').reason)" -match 'implementing') 'a worktree whose Work record is still open must be listed even if the branch and tree are fine'
  Assert-True ((Find-Worktree $dry '97-broken-gitlink').action -eq 'listed' -and "$((Find-Worktree $dry '97-broken-gitlink').reason)" -match 'git status --porcelain failed') 'a worktree whose git status cannot even be read must be listed, never read as clean'
  Assert-True ((Find-Worktree $dry '95-remote-down').action -eq 'listed' -and "$((Find-Worktree $dry '95-remote-down').reason)" -match 'remote lookup failed') 'a worktree whose remote lookup fails must be listed, never read as "gone on the remote"'
  foreach ($p in @($wtA, $wtB, $wtC, $wtD, $wtE, $wtF, $wtU)) { Assert-True (Test-Path $p) "dry run must not remove $p" }
  Assert-True (Test-Path "$testRoot\state\tmp-old") 'dry run must not delete state/tmp-* litter'
  Assert-True (Test-Path "$testRoot\os-temp\fleet-work-state-old") 'dry run must not delete TEMP/fleet-work-state-* litter'
  Assert-True (Test-Path "$testRoot\state\escalations\esc-settled.json") 'dry run must not archive escalations'
  Assert-True (Test-Path "$testRoot\state\heartbeats\ic-88.json") 'dry run must not remove stale heartbeats'
  Assert-True (-not (Test-Path "$testRoot\state\escalations\archive")) 'dry run must not even create the archive directory'

  # ================= -Apply: act on exactly what the AND-conditions allow =================
  $applyArgs = @('-Apply', '-TempRoot', "$testRoot\os-temp")
  $applied = Run-Janitor $applyArgs
  Assert-True ((Find-Worktree $applied '88-clean-merged').action -eq 'removed') 'a settled, clean, merged worktree must be removed under -Apply'
  Assert-True (-not (Test-Path $wtA)) 'the removed worktree path must actually be gone'
  Assert-True ((Find-Worktree $applied '89-dirty').action -eq 'listed') 'a dirty worktree must stay listed under -Apply too'
  Assert-True (Test-Path $wtB) 'a dirty worktree must not be removed'
  Assert-True ((Find-Worktree $applied '90-clean-unmerged').action -eq 'listed') 'an unmerged worktree with an intact remote branch must stay listed'
  Assert-True (Test-Path $wtC) 'an unmerged worktree must not be removed'
  Assert-True ((Find-Worktree $applied '91-clean-squashed').action -eq 'removed') 'a worktree whose branch is gone on the remote must be removed even though ancestry says unmerged'
  Assert-True (-not (Test-Path $wtD)) 'the OR-condition removal must actually remove the worktree'
  Assert-True ((Find-Worktree $applied '92-clean-open-record').action -eq 'listed') 'a worktree with an open Work record must never be removed regardless of the branch/tree'
  Assert-True (Test-Path $wtE) 'the open-record worktree must survive'
  Assert-True ((Find-Worktree $applied '97-broken-gitlink').action -eq 'listed') 'a worktree with an unreadable git status must never be removed under -Apply either'
  Assert-True (Test-Path $wtF) 'the broken-gitlink worktree must survive'
  Assert-True ((Find-Worktree $applied '95-remote-down').action -eq 'listed') 'a worktree whose remote lookup fails must never be removed under -Apply either'
  Assert-True (Test-Path $wtU) 'the remote-down worktree must survive'

  Assert-True (@($applied.tmpLitter | Where-Object { $_.path -match 'tmp-old$' -and $_.action -eq 'removed' }).Count -eq 1) 'aged state/tmp-* litter must be removed'
  Assert-True (-not (Test-Path "$testRoot\state\tmp-old")) 'the aged tmp dir must actually be gone'
  Assert-True (Test-Path "$testRoot\state\tmp-young") 'young state/tmp-* litter must survive'
  Assert-True (@($applied.tmpLitter | Where-Object { $_.path -match 'fleet-work-state-old$' -and $_.action -eq 'removed' }).Count -eq 1) 'aged TEMP/fleet-work-state-* litter must be removed'
  Assert-True (-not (Test-Path "$testRoot\os-temp\fleet-work-state-old")) 'the aged TEMP litter dir must actually be gone'
  Assert-True (Test-Path "$testRoot\os-temp\fleet-work-state-young") 'young TEMP litter must survive'

  Assert-True (-not (Test-Path "$testRoot\state\escalations\esc-settled.json")) 'a settled escalation must be archived (moved out)'
  Assert-True (Test-Path "$testRoot\state\escalations\archive\esc-settled.json") 'a settled escalation must land in the archive'
  Assert-True (Test-Path "$testRoot\state\escalations\esc-decision.json") 'an escalation whose record is still in a decision state must stay put'
  Assert-True (-not (Test-Path "$testRoot\state\escalations\esc-old-norecord.json")) 'an escalation with no record older than 14 days must be archived'
  Assert-True (Test-Path "$testRoot\state\escalations\esc-young-norecord.json") 'an escalation with no record younger than 14 days must stay put'

  Assert-True (-not (Test-Path "$testRoot\state\heartbeats\ic-88.json")) 'a heartbeat for a name off the live roster must be removed'
  Assert-True (Test-Path "$testRoot\state\heartbeats\ic-77.json") 'a heartbeat for a name on the live roster must survive'

  Assert-True (Test-Path $applied.reportPath) 'the run must write its report file'
  Assert-True ((Get-Content $applied.reportPath -Raw) -match 'Janitor run') 'the report must be readable prose, not just the JSON line'

  # ================= review-round safety checks: a failed/unreadable input must be =================
  # ================= UNKNOWN, listed, and never license a removal or a deletion    =================

  # --- corrupt state/work/active.json: the settled-looking worktree must NOT be removed ---
  # This is a faithful replay of the exact hazard QA measured: the record's real state
  # is 'implementing' (still being worked on), but active.json is torn so the lookup
  # cannot see that; the issue is ALSO closed on GitHub (independent of the record - a
  # human can close an issue directly). The old code read the torn file as "no record",
  # asked GitHub, got CLOSED, and removed an in-progress worktree.
  $rootAC = New-MiniRoot 'active-corrupt'
  $tenAC = New-MiniTenantRepo -Root $rootAC -TenantName 'ac' -Issue 200 -BranchSlug 'settled'
  Write-Utf8 "$rootAC\tenants\ac.json" (@{ name = 'ac'; repo = $tenAC.repo; github = 'owner/repo'; defaultBranch = 'main' } | ConvertTo-Json -Compress)
  Write-Utf8 "$rootAC\state\work\active.json" '{not valid json at all'
  [IO.Directory]::CreateDirectory("$rootAC\mock-bin") | Out-Null
  Write-Utf8 "$rootAC\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo {"state":"CLOSED"}' + "`r`n" + 'exit /b 0' + "`r`n")
  $oldPathAC = $env:PATH; $env:PATH = "$rootAC\mock-bin;$oldPathAC"
  $repAC = Run-JanitorAt -Root $rootAC -Arguments @('-Apply', '-TempRoot', "$rootAC\mini-temp")
  $env:PATH = $oldPathAC
  $wtAC = Find-Worktree $repAC '200-settled'
  Assert-True ($wtAC.action -eq 'listed' -and "$($wtAC.reason)" -match 'active\.json could not be read') 'a torn active.json must list every worktree as unknown, not fall through to a GitHub closed-issue check that would remove an in-progress record'
  Assert-True (Test-Path $tenAC.worktree) 'a worktree must survive a torn active.json even when GitHub separately reports the issue closed'

  # --- missing state/work/active.json entirely (no gh configured either): still safe ---
  $rootAM = New-MiniRoot 'active-missing'
  $tenAM = New-MiniTenantRepo -Root $rootAM -TenantName 'am' -Issue 201 -BranchSlug 'settled'
  Write-Utf8 "$rootAM\tenants\am.json" (@{ name = 'am'; repo = $tenAM.repo; github = ''; defaultBranch = 'main' } | ConvertTo-Json -Compress)
  # No active.json written at all.
  $repAM = Run-JanitorAt -Root $rootAM -Arguments @('-Apply', '-TempRoot', "$rootAM\mini-temp")
  $wtAM = Find-Worktree $repAM '201-settled'
  Assert-True ($wtAM.action -eq 'listed') 'with no active.json and no github configured, the issue state is genuinely unknown - it must stay listed, not be removed by default'
  Assert-True (Test-Path $tenAM.worktree) 'a worktree must survive when neither active.json nor GitHub can confirm it is settled'

  # --- corrupt state/roster.json: heartbeats must be left alone, not wiped ---
  $rootRC = New-MiniRoot 'roster-corrupt'
  Write-Utf8 "$rootRC\state\roster.json" '{"sessions": [ this is not json'
  Write-Utf8 "$rootRC\state\heartbeats\ic-1.json" (@{ at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)
  $repRC = Run-JanitorAt -Root $rootRC -Arguments @('-Apply', '-TempRoot', "$rootRC\mini-temp")
  Assert-True (Test-Path "$rootRC\state\heartbeats\ic-1.json") 'a corrupt roster.json must never be read as "nobody is live"; heartbeats must survive'
  Assert-True (@($repRC.heartbeats | Where-Object { $_.file -eq 'ic-1.json' -and $_.action -eq 'listed' -and "$($_.reason)" -match 'roster.json unreadable' }).Count -eq 1) 'the report must say the roster was unreadable, not silently do nothing'

  # --- missing state/roster.json entirely: same conservative outcome ---
  $rootRM = New-MiniRoot 'roster-missing'
  Write-Utf8 "$rootRM\state\heartbeats\ic-2.json" (@{ at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)
  $repRM = Run-JanitorAt -Root $rootRM -Arguments @('-Apply', '-TempRoot', "$rootRM\mini-temp")
  Assert-True (Test-Path "$rootRM\state\heartbeats\ic-2.json") 'a missing roster.json must not be read as an empty (nobody live) roster either; heartbeats must survive'

  # --- a tenant with no defaultBranch configured: never evaluate ancestry against $null ---
  $rootDB = New-MiniRoot 'no-default-branch'
  $tenDB = New-MiniTenantRepo -Root $rootDB -TenantName 'db' -Issue 202 -BranchSlug 'settled'
  Write-Utf8 "$rootDB\tenants\db.json" (@{ name = 'db'; repo = $tenDB.repo; github = '' } | ConvertTo-Json -Compress)   # defaultBranch omitted
  Write-Utf8 "$rootDB\state\work\active.json" (@{ schemaVersion = 1; records = @{ 'db:issue-202' = @{ state = 'merged' } } } | ConvertTo-Json -Depth 6)
  $repDB = Run-JanitorAt -Root $rootDB -Arguments @('-Apply', '-TempRoot', "$rootDB\mini-temp")
  $wtDB = Find-Worktree $repDB '202-settled'
  Assert-True ($wtDB.action -eq 'listed' -and "$($wtDB.reason)" -match 'no defaultBranch') 'a tenant with no defaultBranch must list its worktrees, never evaluate `git branch --merged` against nothing'
  Assert-True (Test-Path $tenDB.worktree) 'a worktree must survive when its tenant has no defaultBranch configured'

  # --- escalations: an issue number that exists under TWO tenants must resolve to
  # --- neither (left alone), but a genuinely unambiguous one still archives normally ---
  $rootEC = New-MiniRoot 'esc-collision'
  Write-Utf8 "$rootEC\tenants\p.json" (@{ name = 'p'; repo = "$rootEC\nope-p"; github = '' } | ConvertTo-Json -Compress)
  Write-Utf8 "$rootEC\tenants\q.json" (@{ name = 'q'; repo = "$rootEC\nope-q"; github = '' } | ConvertTo-Json -Compress)
  Write-Utf8 "$rootEC\state\work\active.json" (@{
      schemaVersion = 1
      records       = [ordered]@{
        'p:issue-50' = @{ state = 'merged' }   # ambiguous: two tenants both claim issue 50
        'q:issue-50' = @{ state = 'merged' }
        'q:issue-51' = @{ state = 'merged' }   # unambiguous: only q has issue 51
      }
    } | ConvertTo-Json -Depth 8)
  Write-Utf8 "$rootEC\state\escalations\esc-collision.json" (@{ at = (Get-Date).ToUniversalTime().AddDays(-20).ToString('o'); from = 'supervisor'; kind = 'blocked'; name = 'ic-50' } | ConvertTo-Json -Compress)
  Write-Utf8 "$rootEC\state\escalations\esc-resolved.json" (@{ at = (Get-Date).ToUniversalTime().AddDays(-20).ToString('o'); from = 'supervisor'; kind = 'blocked'; name = 'ic-51' } | ConvertTo-Json -Compress)
  $repEC = Run-JanitorAt -Root $rootEC -Arguments @('-Apply', '-TempRoot', "$rootEC\mini-temp")
  Assert-True (Test-Path "$rootEC\state\escalations\esc-collision.json") 'an issue number ambiguous across tenants must be left alone, not archived off a guess'
  Assert-True (-not (Test-Path "$rootEC\state\escalations\esc-resolved.json")) 'an unambiguous issue (only one tenant has it) must still archive normally'
  Assert-True (Test-Path "$rootEC\state\escalations\archive\esc-resolved.json") 'the unambiguous escalation must land in the archive'

  # --- archiving must never clobber a same-named file already in the archive ---
  $rootAR = New-MiniRoot 'archive-collision'
  Write-Utf8 "$rootAR\tenants\p.json" (@{ name = 'p'; repo = "$rootAR\nope"; github = '' } | ConvertTo-Json -Compress)
  Write-Utf8 "$rootAR\state\work\active.json" (@{ schemaVersion = 1; records = @{ 'p:issue-60' = @{ state = 'merged' } } } | ConvertTo-Json -Depth 6)
  [IO.Directory]::CreateDirectory("$rootAR\state\escalations\archive") | Out-Null
  Write-Utf8 "$rootAR\state\escalations\archive\esc-x.json" 'ORIGINAL ARCHIVED CONTENT - must not be overwritten'
  Write-Utf8 "$rootAR\state\escalations\esc-x.json" (@{ at = (Get-Date).ToUniversalTime().AddDays(-20).ToString('o'); from = 'supervisor'; kind = 'blocked'; name = 'ic-60' } | ConvertTo-Json -Compress)
  $repAR = Run-JanitorAt -Root $rootAR -Arguments @('-Apply', '-TempRoot', "$rootAR\mini-temp")
  Assert-True ((Get-Content "$rootAR\state\escalations\archive\esc-x.json" -Raw) -eq 'ORIGINAL ARCHIVED CONTENT - must not be overwritten') 'an earlier archived file must never be clobbered by a new one of the same name'
  Assert-True (-not (Test-Path "$rootAR\state\escalations\esc-x.json")) 'the newly settled escalation must still be moved out of the live directory'
  $archivedNow = @(Get-ChildItem "$rootAR\state\escalations\archive" -Filter 'esc-x*.json')
  Assert-True ($archivedNow.Count -eq 2) 'the collision must produce a second, disambiguated archive file rather than dropping the new one'

  # --- two runs on the same day must not overwrite each other's report ---
  $rootRP = New-MiniRoot 'report-unique'
  $rep1 = Run-JanitorAt -Root $rootRP -Arguments @('-TempRoot', "$rootRP\mini-temp")
  $rep2 = Run-JanitorAt -Root $rootRP -Arguments @('-TempRoot', "$rootRP\mini-temp")
  Assert-True ("$($rep1.reportPath)" -ne "$($rep2.reportPath)") 'two runs must not compute the same report path'
  Assert-True ((Test-Path $rep1.reportPath) -and (Test-Path $rep2.reportPath)) 'both runs'' report files must exist, neither overwritten by the other'

  Write-Output 'janitor tests passed'
} finally {
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-janitor-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    try { Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Attributes = 'Normal' } catch {} } } catch {}
    try { [IO.Directory]::Delete($resolved, $true) } catch { try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
  }
}
