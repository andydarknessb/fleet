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
      }
    } | ConvertTo-Json -Depth 8)

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
  $dry = Run-Janitor @()
  Assert-True ((Find-Worktree $dry '88-clean-merged').action -eq 'would-remove') 'a settled, clean, merged worktree must be reported would-remove in dry run'
  Assert-True ((Find-Worktree $dry '89-dirty').action -eq 'listed' -and "$((Find-Worktree $dry '89-dirty').reason)" -match 'porcelain') 'a dirty worktree must be listed with the git-status reason'
  Assert-True ((Find-Worktree $dry '90-clean-unmerged').action -eq 'listed' -and "$((Find-Worktree $dry '90-clean-unmerged').reason)" -match 'neither merged') 'an unmerged worktree with its remote branch intact must be listed'
  Assert-True ((Find-Worktree $dry '91-clean-squashed').action -eq 'would-remove') 'a worktree whose branch is only gone on the remote (squash-merge shape) must still be removable'
  Assert-True ((Find-Worktree $dry '92-clean-open-record').action -eq 'listed' -and "$((Find-Worktree $dry '92-clean-open-record').reason)" -match 'implementing') 'a worktree whose Work record is still open must be listed even if the branch and tree are fine'
  foreach ($p in @($wtA, $wtB, $wtC, $wtD, $wtE)) { Assert-True (Test-Path $p) "dry run must not remove $p" }
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

  Write-Output 'janitor tests passed'
} finally {
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-janitor-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    try { Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Attributes = 'Normal' } catch {} } } catch {}
    try { [IO.Directory]::Delete($resolved, $true) } catch { try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
  }
}
