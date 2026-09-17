<#
.SYNOPSIS  Ticket 09 (fleet #88): weekly janitor - worktrees, state litter, settled escalations.
  -DryRun by default: report only, touch nothing. -Apply acts. Every action here is
  conservative and literal about its AND-conditions; anything not provably safe is
  listed with the reason and left alone. This never passes --force to git: a worktree
  or branch that git itself refuses to remove without --force stays listed, not forced.
  Writes a report to state/janitor/<date>.md. Registered by install-janitor-task.ps1.
.EXAMPLE   janitor.ps1              # dry run: report what would happen
.EXAMPLE   janitor.ps1 -Apply       # act
#>
[CmdletBinding()]
param(
  [switch]$Apply,                       # default is the safe dry run; this is the only way to act
  [string]$TempRoot = $env:TEMP,        # injectable for tests; production default is the real TEMP
  [int]$TempAgeDays = 7,
  [int]$EscalationAgeDays = 14
)
. "$PSScriptRoot\_common.ps1"
# Entry point: never inherit a caller's Stop preference (PS 5.1 wraps native stderr).
$ErrorActionPreference = 'Continue'

$report = [ordered]@{ at = (Now-Iso); applied = [bool]$Apply; worktrees = @(); tmpLitter = @(); escalations = @(); heartbeats = @() }

function Get-ActiveWorkRecord {
  # Record ids are "<tenant>:issue-<n>" (bin/work-state.js). A terminal record
  # (retired/released/abandoned) is removed from active.json entirely, so its
  # absence here can mean either "never existed" or "already settled" - callers
  # tell those apart by checking GitHub, not by treating absence as done.
  param([string]$Tenant, [int]$Issue)
  $active = Read-Json "$FleetHome\state\work\active.json"
  if (-not $active -or -not $active.records) { return $null }
  $key = "${Tenant}:issue-$Issue"
  if (@($active.records.PSObject.Properties.Name) -contains $key) { return $active.records.$key }
  return $null
}

function Test-IssueClosed {
  param([string]$Github, [int]$Issue)
  if (-not $Github) { return $null }
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $raw = & gh issue view $Issue -R $Github --json state 2>&1 } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { return $null }   # unreadable: never read as closed
  try { $obj = ($raw | Out-String).Trim() | ConvertFrom-Json } catch { return $null }
  return ("$($obj.state)" -eq 'CLOSED')
}

# --- worktree sweep: remove only when the Work record is settled AND the tree is
# --- clean AND the branch is merged or gone on the remote; else list with the reason. ---
foreach ($tf in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)) {
  $t = Read-Json $tf.FullName
  if (-not $t -or -not (Test-Path $t.repo)) { continue }
  $tenantName = if ($t.name) { "$($t.name)" } else { [IO.Path]::GetFileNameWithoutExtension($tf.Name) }
  $def = $t.defaultBranch
  $blocks = ((& git -C $t.repo worktree list --porcelain 2>$null | Out-String) -replace "`r", '') -split "`n`n"
  foreach ($blk in $blocks) {
    if ($blk -notmatch 'worktree (.+)') { continue }
    $path = $Matches[1].Trim()
    if ($path -notmatch '[\\/]\.claude[\\/]worktrees[\\/]') { continue }
    if ($blk -notmatch 'branch refs/heads/(.+)') { continue }   # a detached worktree names no branch to judge; leave it
    $br = $Matches[1].Trim()
    $leaf = Split-Path $path -Leaf
    $issue = $null
    if ($leaf -match '^(?:ic-)?(\d+)(-|$)') { $issue = [int]$Matches[1] }
    elseif ($br -match '(\d+)(-|$)') { $issue = [int]$Matches[1] }

    $reasons = @()

    # Condition 1: the issue's Work record is merged, retired or released, OR the
    # issue is closed with no active record.
    $recordOk = $false
    if ($null -eq $issue) {
      $reasons += 'could not determine an issue number from the worktree path or branch name'
    } else {
      $record = Get-ActiveWorkRecord -Tenant $tenantName -Issue $issue
      if ($record) {
        if (@('merged', 'retired', 'released') -contains "$($record.state)") { $recordOk = $true }
        else { $reasons += "issue #$issue`'s Work record is '$($record.state)', not merged/retired/released" }
      } else {
        $closed = Test-IssueClosed -Github $t.github -Issue $issue
        if ($closed -eq $true) { $recordOk = $true }
        elseif ($closed -eq $false) { $reasons += "issue #$issue has no active Work record and is still open on GitHub" }
        else { $reasons += "issue #$issue has no active Work record and its GitHub state could not be read" }
      }
    }

    # Condition 2: nothing uncommitted or untracked in the worktree.
    $statusRaw = (& git -C $path status --porcelain 2>$null | Out-String).Trim()
    $clean = ($statusRaw -eq '')
    if (-not $clean) { $reasons += 'git status --porcelain is not empty' }

    # Condition 3: the branch is merged into the default branch, OR it is gone on the
    # remote. Tenant PRs are squash-merged, so ancestry alone (`git branch --merged`)
    # reads "not merged" for nearly every finished branch; the remote-gone leg is what
    # actually catches those, and only when the tenant's GitHub repo deletes the head
    # branch on merge. See the ticket report for the fraction this literal OR leaves
    # listed when a repo keeps merged branches around.
    $mergedList = (& git -C $t.repo branch --merged $def 2>$null | Out-String)
    # git marks the branch line "* " for the checked-out branch in THIS worktree, or
    # "+ " when it is checked out in a LINKED worktree (exactly our case: every branch
    # here is checked out in the .claude/worktrees worktree we are judging) - a plain
    # \*? missed the "+ " rows entirely and read every one of them as unmerged.
    $ancestorMerged = ($mergedList -match "(?m)^[\*\+]?\s*$([regex]::Escape($br))\s*$")
    $remoteRaw = (& git -C $t.repo ls-remote --heads origin $br 2>$null | Out-String).Trim()
    $remoteGone = ($remoteRaw -eq '')
    $branchOk = ($ancestorMerged -or $remoteGone)
    if (-not $branchOk) { $reasons += 'branch is neither merged into the default branch nor deleted on the remote' }

    $entry = [ordered]@{ tenant = $tenantName; path = $path; branch = $br; issue = $issue }
    if ($recordOk -and $clean -and $branchOk) {
      if ($Apply) {
        & git -C $t.repo worktree remove $path 2>$null   # never --force: a refusal here means our own checks missed something
        if ($LASTEXITCODE -eq 0) {
          $entry.action = 'removed'
          if ($ancestorMerged) { & git -C $t.repo branch -d $br 2>$null | Out-Null }   # -d only: a non-ancestor branch is left alone, never -D
        } else {
          $entry.action = 'listed'; $entry.reason = 'git worktree remove refused it (left untouched, not forced)'
        }
      } else {
        $entry.action = 'would-remove'
      }
    } else {
      $entry.action = 'listed'
      $entry.reason = ($reasons -join '; ')
    }
    $report.worktrees += [pscustomobject]$entry
  }
}

# --- state/tmp-* and %TEMP%/fleet-work-state-* older than TempAgeDays ---
function Get-AgedLitter {
  param([string]$Root, [string]$Pattern, [datetime]$Cutoff)
  $hits = @()
  if (-not (Test-Path $Root)) { return $hits }
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Filter $Pattern -ErrorAction SilentlyContinue)) {
    if ($item.LastWriteTimeUtc -gt $Cutoff) { continue }
    $hits += $item
  }
  return $hits
}
$tmpCutoff = (Get-Date).ToUniversalTime().AddDays(-$TempAgeDays)
$litterItems = @(Get-AgedLitter -Root "$FleetHome\state" -Pattern 'tmp-*' -Cutoff $tmpCutoff) + @(Get-AgedLitter -Root $TempRoot -Pattern 'fleet-work-state-*' -Cutoff $tmpCutoff)
foreach ($item in $litterItems) {
  $ageDays = [int]((Get-Date).ToUniversalTime() - $item.LastWriteTimeUtc).TotalDays
  $entry = [ordered]@{ path = $item.FullName; ageDays = $ageDays }
  if ($Apply) {
    try {
      if ($item.PSIsContainer) { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop } else { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop }
      $entry.action = 'removed'
    } catch { $entry.action = 'listed'; $entry.reason = "$($_.Exception.Message)" }
  } else { $entry.action = 'would-remove' }
  $report.tmpLitter += [pscustomobject]$entry
}

# --- settled escalation files -> state/escalations/archive ---
$escDir = "$FleetHome\state\escalations"
if (Test-Path $escDir) {
  $archiveDir = "$escDir\archive"
  $active = Read-Json "$FleetHome\state\work\active.json"
  $activeProps = @(); if ($active -and $active.records) { $activeProps = @($active.records.PSObject.Properties) }
  foreach ($f in @(Get-ChildItem $escDir -Filter *.json -ErrorAction SilentlyContinue)) {
    $esc = $null; try { $esc = Read-Json $f.FullName } catch {}
    $issue = $null
    if ($esc -and "$($esc.name)" -match '^ic-(\d+)$') { $issue = [int]$Matches[1] }
    $record = $null
    if ($null -ne $issue) {
      $hit = $activeProps | Where-Object { $_.Name -match ":issue-$issue$" } | Select-Object -First 1
      if ($hit) { $record = $hit.Value }
    }
    $settle = $false; $why = ''
    if ($record) {
      if (@('escalated', 'hold') -notcontains "$($record.state)") { $settle = $true; $why = "issue #$issue`'s record is now '$($record.state)', no longer a decision state" }
    } else {
      $at = $null; if ($esc) { $at = ConvertTo-UtcDateTime $esc.at }
      if (-not $at) { $at = $f.LastWriteTimeUtc }
      $ageDays = [int]((Get-Date).ToUniversalTime() - $at).TotalDays
      if ($ageDays -ge $EscalationAgeDays) { $settle = $true; $why = "no active record and $ageDays day(s) old" }
    }
    if (-not $settle) { continue }
    $entry = [ordered]@{ file = $f.Name; reason = $why }
    if ($Apply) {
      try {
        [IO.Directory]::CreateDirectory($archiveDir) | Out-Null
        Move-Item -LiteralPath $f.FullName -Destination (Join-Path $archiveDir $f.Name) -Force -ErrorAction Stop
        $entry.action = 'archived'
      } catch { $entry.action = 'listed'; $entry.reason = "$why; move failed: $($_.Exception.Message)" }
    } else { $entry.action = 'would-archive' }
    $report.escalations += [pscustomobject]$entry
  }
}

# --- stale state/heartbeats/ic-*.json for names off the live roster ---
$hbDir = "$FleetHome\state\heartbeats"
if (Test-Path $hbDir) {
  $liveNames = @((Get-LiveRoster).sessions | ForEach-Object { "$($_.name)" })
  foreach ($f in @(Get-ChildItem $hbDir -Filter 'ic-*.json' -ErrorAction SilentlyContinue)) {
    $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    if ($liveNames -contains $name) { continue }
    $entry = [ordered]@{ file = $f.Name; name = $name }
    if ($Apply) {
      try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $entry.action = 'removed' }
      catch { $entry.action = 'listed'; $entry.reason = "$($_.Exception.Message)" }
    } else { $entry.action = 'would-remove' }
    $report.heartbeats += [pscustomobject]$entry
  }
}

# --- report ---
[IO.Directory]::CreateDirectory("$FleetHome\state\janitor") | Out-Null
$reportPath = "$FleetHome\state\janitor\$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')).md"
$lines = @("# Janitor run $($report.at)", '', "Mode: $(if ($Apply) { 'APPLY' } else { 'DRY RUN' })", '', '## Worktrees')
if ($report.worktrees.Count -eq 0) { $lines += '(none)' }
foreach ($w in $report.worktrees) {
  $issueTxt = if ($w.issue) { ", issue #$($w.issue)" } else { '' }
  $reasonTxt = if ($w.reason) { ": $($w.reason)" } else { '' }
  $lines += "- [$($w.action)] $($w.tenant) $($w.path) (branch $($w.branch)$issueTxt)$reasonTxt"
}
$lines += '', '## Temp litter (state/tmp-*, TEMP/fleet-work-state-*)'
if ($report.tmpLitter.Count -eq 0) { $lines += '(none)' }
foreach ($x in $report.tmpLitter) {
  $reasonTxt = if ($x.reason) { ": $($x.reason)" } else { '' }
  $lines += "- [$($x.action)] $($x.path) (age $($x.ageDays)d)$reasonTxt"
}
$lines += '', '## Escalations'
if ($report.escalations.Count -eq 0) { $lines += '(none)' }
foreach ($e in $report.escalations) { $lines += "- [$($e.action)] $($e.file): $($e.reason)" }
$lines += '', '## Stale IC heartbeats'
if ($report.heartbeats.Count -eq 0) { $lines += '(none)' }
foreach ($h in $report.heartbeats) { $lines += "- [$($h.action)] $($h.file)" }
[IO.File]::WriteAllText($reportPath, ($lines -join [Environment]::NewLine), $script:Utf8)
$report.reportPath = $reportPath

Write-Output ($report | ConvertTo-Json -Compress -Depth 8)
