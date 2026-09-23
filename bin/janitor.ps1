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

function Read-ActiveWork {
  # Tri-state, read ONCE: 'ok' (parsed, has a usable .records map - even an empty one,
  # including a MISSING file, see below), or 'unreadable' (malformed, unparseable, or
  # shaped wrong - a real reason not to trust it).
  # A MISSING file is read as 'ok' with an empty map: bin/work-state.js's own
  # ensureLayout creates state/work/active.json as {schemaVersion:1, records:{}} the
  # first time any script touches the fleet, so "the file is not there yet" is that
  # same empty shape, not corruption. A file that EXISTS but fails to parse, or parses
  # to something without a .records object, is never assumed empty - that is corruption
  # (a torn write, disk trouble) and must block every removal decision that depends on
  # it, not just the one for the record it happened to be checking (fleet #88 review
  # finding 3: reading absence off a broken file let a CLOSED-issue check license
  # removing an `implementing` record's worktree).
  $path = "$FleetHome\state\work\active.json"
  if (-not (Test-Path -LiteralPath $path)) { return [pscustomobject]@{ status = 'ok'; records = $null } }
  try {
    $rawText = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop
    $obj = $rawText | ConvertFrom-Json -ErrorAction Stop
  } catch { return [pscustomobject]@{ status = 'unreadable'; records = $null } }
  if ($null -eq $obj -or -not $obj.PSObject.Properties['records'] -or $null -eq $obj.records) { return [pscustomobject]@{ status = 'unreadable'; records = $null } }
  return [pscustomobject]@{ status = 'ok'; records = $obj.records }
}
function Find-WorkRecord {
  # status: 'unreadable' (active.json itself could not be trusted - caller must not
  # decide anything from "no record"), 'found', or 'absent' (no such key, file was fine).
  param($ActiveWork, [string]$Key)
  if ($ActiveWork.status -eq 'unreadable') { return [pscustomobject]@{ status = 'unreadable'; record = $null } }
  if ($ActiveWork.records -and (@($ActiveWork.records.PSObject.Properties.Name) -contains $Key)) { return [pscustomobject]@{ status = 'found'; record = $ActiveWork.records.$Key } }
  return [pscustomobject]@{ status = 'absent'; record = $null }
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

function Test-BranchMergedPr {
  # Ruling 3 (fleet #88, 2026-09-18): the tenant squash-merges, so a branch that is the
  # head of a MERGED pull request counts as merged even when ancestry and the remote
  # both say otherwise. Fail CLOSED like Test-IssueClosed: a non-zero gh exit or output
  # that does not parse to JSON is UNKNOWN ($null), never read as "not merged". Only a
  # parsed list counts - empty means a genuine, known no; one or more entries is a yes.
  param([string]$Github, [string]$Branch)
  if (-not $Github) { return $null }
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $raw = & gh pr list -R $Github --head $Branch --state merged --json number,mergedAt 2>&1 } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { return $null }   # unreadable: never read as merged
  # `@(...)` wrapped AROUND the ConvertFrom-Json pipeline collapses a genuinely empty
  # JSON array ("[]") into a one-element array holding that empty array, instead of a
  # zero-count array - assign first, then wrap, so an empty list reads as Count 0.
  try { $parsed = ($raw | Out-String).Trim() | ConvertFrom-Json } catch { return $null }
  $list = @($parsed)
  return ($list.Count -gt 0)
}

# --- worktree sweep: remove only when the Work record is settled AND the tree is
# --- clean AND the branch is merged or gone on the remote; else list with the reason. ---
$activeWork = Read-ActiveWork
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
    # issue is closed with no active record. A torn/unparseable active.json is neither
    # of those - it is UNKNOWN, and unknown never licenses removal (review finding 3).
    $recordOk = $false
    if ($null -eq $issue) {
      $reasons += 'could not determine an issue number from the worktree path or branch name'
    } else {
      $lookup = Find-WorkRecord -ActiveWork $activeWork -Key "${tenantName}:issue-$issue"
      if ($lookup.status -eq 'unreadable') {
        $reasons += 'state/work/active.json could not be read; issue record status unknown'
      } elseif ($lookup.status -eq 'found') {
        if (@('merged', 'retired', 'released') -contains "$($lookup.record.state)") { $recordOk = $true }
        else { $reasons += "issue #$issue`'s Work record is '$($lookup.record.state)', not merged/retired/released" }
      } else {
        $closed = Test-IssueClosed -Github $t.github -Issue $issue
        if ($closed -eq $true) { $recordOk = $true }
        elseif ($closed -eq $false) { $reasons += "issue #$issue has no active Work record and is still open on GitHub" }
        else { $reasons += "issue #$issue has no active Work record and its GitHub state could not be read" }
      }
    }

    # Condition 2: nothing uncommitted or untracked in the worktree. A failed status
    # read (broken worktree, missing .git link, git error) is UNKNOWN, not clean.
    $statusRaw = (& git -C $path status --porcelain 2>$null | Out-String)
    $statusExit = $LASTEXITCODE
    $clean = $false
    if ($statusExit -ne 0) { $reasons += "git status --porcelain failed (exit $statusExit); worktree not provably clean" }
    elseif ($statusRaw.Trim() -ne '') { $reasons += 'git status --porcelain is not empty' }
    else { $clean = $true }

    # Condition 3: the branch is merged into the default branch, OR it is gone on the
    # remote. Tenant PRs are squash-merged, so ancestry alone (`git branch --merged`)
    # reads "not merged" for nearly every finished branch; the remote-gone leg is what
    # actually catches those, and only when the tenant's GitHub repo deletes the head
    # branch on merge. See the ticket report for the fraction this literal OR leaves
    # listed when a repo keeps merged branches around.
    $ancestorMerged = $false
    $branchOk = $false
    $mergeLeg = $null   # which leg of condition 3 satisfied it: ancestor / remote-gone / merged-pr
    if (-not $def) {
      $reasons += 'tenant has no defaultBranch configured; cannot evaluate merge ancestry'
    } else {
      $mergedList = (& git -C $t.repo branch --merged $def 2>$null | Out-String)
      # git marks the branch line "* " for the checked-out branch in THIS worktree, or
      # "+ " when it is checked out in a LINKED worktree (exactly our case: every branch
      # here is checked out in the .claude/worktrees worktree we are judging) - a plain
      # \*? missed the "+ " rows entirely and read every one of them as unmerged.
      $ancestorMerged = ($mergedList -match "(?m)^[\*\+]?\s*$([regex]::Escape($br))\s*$")
      $remoteRaw = (& git -C $t.repo ls-remote --heads origin $br 2>$null | Out-String).Trim()
      $remoteExit = $LASTEXITCODE
      if ($ancestorMerged) {
        $branchOk = $true; $mergeLeg = 'ancestor'
      } elseif ($remoteExit -ne 0) {
        # The remote lookup itself failed (origin unreachable, network trouble, auth) -
        # that is UNKNOWN, not "gone". Reading a failed lookup as "gone" would remove
        # every unmerged worktree the instant the remote is unreachable (review
        # finding 1, the blocker).
        $reasons += "branch is not merged into the default branch and the remote lookup failed (git ls-remote exit $remoteExit); left listed rather than guessing"
      } elseif ($remoteRaw -eq '') {
        $branchOk = $true; $mergeLeg = 'remote-gone'
      } else {
        # Ruling 3 (fleet #88, 2026-09-18): the fleet squash-merges, so ancestry fails
        # on construction for nearly every finished branch, and the tenant routinely
        # leaves the remote branch in place too. A MERGED pull request whose head is
        # this branch is a third, independent leg - see Test-BranchMergedPr for the
        # fail-closed read.
        $prMerged = Test-BranchMergedPr -Github $t.github -Branch $br
        if ($prMerged -eq $true) {
          $branchOk = $true; $mergeLeg = 'merged-pr'
        } elseif ($prMerged -eq $false) {
          $reasons += 'branch is neither merged into the default branch, deleted on the remote, nor the head of a merged pull request'
        } else {
          $reasons += 'branch is not merged into the default branch, still present on the remote, and the merged-pull-request lookup could not be read (gh pr list failed or returned no parseable JSON); left listed rather than guessing'
        }
      }
    }

    $entry = [ordered]@{ tenant = $tenantName; path = $path; branch = $br; issue = $issue }
    if ($mergeLeg) { $entry.mergeLeg = $mergeLeg }
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
  # A bare ":issue-<n>" suffix match can hit the wrong tenant's record when two
  # tenants both have an issue #n (review finding 8); resolve the full "<tenant>:issue-<n>"
  # key against every known tenant name instead. An escalation whose issue matches more
  # than one tenant's active record is left alone too - there is no safe reading of it.
  $tenantNames = @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue | ForEach-Object {
      $tt = Read-Json $_.FullName
      if ($tt -and $tt.name) { "$($tt.name)" } else { [IO.Path]::GetFileNameWithoutExtension($_.Name) }
    })
  foreach ($f in @(Get-ChildItem $escDir -Filter *.json -ErrorAction SilentlyContinue)) {
    $esc = $null; try { $esc = Read-Json $f.FullName } catch {}
    $issue = $null
    if ($esc -and "$($esc.name)" -match '^ic-(\d+)$') { $issue = [int]$Matches[1] }
    $record = $null
    $unresolved = $false
    if ($null -ne $issue) {
      if ($activeWork.status -eq 'unreadable') {
        $unresolved = $true   # the whole map is untrustworthy; never guess from it
      } else {
        $hits = @()
        foreach ($tn in $tenantNames) {
          $lookup = Find-WorkRecord -ActiveWork $activeWork -Key "${tn}:issue-$issue"
          if ($lookup.status -eq 'found') { $hits += $lookup.record }
        }
        if ($hits.Count -gt 1) { $unresolved = $true }   # ambiguous across tenants
        elseif ($hits.Count -eq 1) { $record = $hits[0] }
      }
    }
    if ($unresolved) { continue }   # leave the file - see comment above
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
        # Collision-safe: never clobber an earlier archived file of the same name
        # (review finding 9). -Force alone would silently overwrite it.
        $destName = $f.Name
        $destPath = Join-Path $archiveDir $destName
        $suffix = 1
        while (Test-Path -LiteralPath $destPath) {
          $destName = "$([IO.Path]::GetFileNameWithoutExtension($f.Name))-$suffix$([IO.Path]::GetExtension($f.Name))"
          $destPath = Join-Path $archiveDir $destName
          $suffix++
        }
        Move-Item -LiteralPath $f.FullName -Destination $destPath -ErrorAction Stop
        $entry.action = 'archived'; $entry.archivedAs = $destName
      } catch { $entry.action = 'listed'; $entry.reason = "$why; move failed: $($_.Exception.Message)" }
    } else { $entry.action = 'would-archive' }
    $report.escalations += [pscustomobject]$entry
  }
}

# --- stale state/heartbeats/ic-*.json for names off the live roster ---
# Get-LiveRoster (bin/_common.ps1) substitutes an empty sessions list for a missing OR
# unreadable state/roster.json - a fine default for reporting, but a destructive
# decision here: it would read a broken roster as "nobody is live" and delete every
# IC heartbeat, which is exactly what the Watchdog reads to judge the fleet dead
# (review finding 5). Read the file ourselves and only act when it actually parsed.
$hbDir = "$FleetHome\state\heartbeats"
if (Test-Path $hbDir) {
  $rosterPath = "$FleetHome\state\roster.json"
  $rosterReadOk = $false
  $liveNames = @()
  if (Test-Path -LiteralPath $rosterPath) {
    try {
      $rosterRaw = Get-Content -LiteralPath $rosterPath -Raw -Encoding UTF8 -ErrorAction Stop
      $rosterObj = $rosterRaw | ConvertFrom-Json -ErrorAction Stop
      if ($rosterObj -and $rosterObj.PSObject.Properties['sessions']) {
        $liveNames = @($rosterObj.sessions | ForEach-Object { "$($_.name)" })
        $rosterReadOk = $true
      }
    } catch { $rosterReadOk = $false }
  }
  # A MISSING roster.json is ambiguous (unlike active.json, nothing here documents it as
  # "freshly initialized, no sessions yet") - when unsure, treat it the same as unreadable.
  foreach ($f in @(Get-ChildItem $hbDir -Filter 'ic-*.json' -ErrorAction SilentlyContinue)) {
    $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    if (-not $rosterReadOk) {
      $report.heartbeats += [pscustomobject]@{ file = $f.Name; name = $name; action = 'listed'; reason = 'state/roster.json unreadable; heartbeats left alone' }
      continue
    }
    if ($liveNames -contains $name) { continue }
    $entry = [ordered]@{ file = $f.Name; name = $name }
    if ($Apply) {
      try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $entry.action = 'removed' }
      catch { $entry.action = 'listed'; $entry.reason = "$($_.Exception.Message)" }
    } else { $entry.action = 'would-remove' }
    $report.heartbeats += [pscustomobject]$entry
  }
}

# --- report --- (the run's own timestamp, not just the date: two runs on one day must
# --- not overwrite each other's report)
[IO.Directory]::CreateDirectory("$FleetHome\state\janitor") | Out-Null
$reportPath = "$FleetHome\state\janitor\$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd-HHmmssfff')).md"
$lines = @("# Janitor run $($report.at)", '', "Mode: $(if ($Apply) { 'APPLY' } else { 'DRY RUN' })", '', '## Worktrees')
if ($report.worktrees.Count -eq 0) { $lines += '(none)' }
foreach ($w in $report.worktrees) {
  $issueTxt = if ($w.issue) { ", issue #$($w.issue)" } else { '' }
  $legTxt = if ($w.mergeLeg) { ", leg $($w.mergeLeg)" } else { '' }
  $reasonTxt = if ($w.reason) { ": $($w.reason)" } else { '' }
  $lines += "- [$($w.action)] $($w.tenant) $($w.path) (branch $($w.branch)$issueTxt$legTxt)$reasonTxt"
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
