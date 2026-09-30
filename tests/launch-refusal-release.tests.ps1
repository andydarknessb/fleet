# fleet#256 AC1, behavioural: a launch refused AFTER its reservation exists releases the reservation
# (assigned record gone from `assigned`, invalidation marker written with the refusal's reason), and a
# release that itself fails never replaces the refusal the operator reads. The static exit table in
# launch-release-order.tests.ps1 covers every exit; this drives the ones that stranded nidus:issue-7:
# the gh reconcile failure, the base fetch failure, and (for the gates) PAUSE. Real git repo, manifests
# reserved through the real assignment.js, a mock `gh` that can fail and a mock `claude`.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-launch-refusal-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Run-Launch {
  param([string[]]$Arguments)
  # A wrapper runs launch.ps1 and prints each error record's bare message, so neither PS 5.1's
  # ErrorRecord decoration ("At <path>:..." lines, CategoryInfo) nor its console-width wrapping of
  # those lines can split or hide the text under test. Stdout lines (the JSON refusals) pass through.
  $wrapper = Join-Path $testRoot 'run-launch.ps1'
  $wrapperLines = @(
    'param([string]$Manifest, [string]$WorkRecordId, [switch]$DryRun)',
    '$ErrorActionPreference = "Continue"',
    '$splat = @{ Manifest = $Manifest; WorkRecordId = $WorkRecordId }; if ($DryRun) { $splat.DryRun = $true }',
    ('& "' + $testRoot + '\bin\launch.ps1" @splat 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "ERR: " + $_.Exception.Message } else { "$_" } }'),
    'exit $LASTEXITCODE'
  )
  Write-Utf8 $wrapper ($wrapperLines -join "`r`n")
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $testRoot
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; Pop-Location }
  $script:lastOut = $out
  # Long lines can still wrap in the captured text: compare with whitespace removed.
  $script:lastFlat = $out -replace '\s+', ''
  $jsonLine = ($out -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  try { return $jsonLine | ConvertFrom-Json } catch { return $null }
}
function Invoke-Git {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $o = & git.exe -C "$testRoot\repo" @Arguments 2>&1 | Out-String; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
  if ($code -ne 0) { throw "git $($Arguments -join ' ') failed: $o" }
  return $o.Trim()
}
function Reserve-Manifest {
  param([int]$Issue, [string]$Sha)
  $fixture = "$testRoot\issues-$Issue.json"
  Write-Utf8 $fixture ('[{"number":' + $Issue + ',"title":"Refusal fixture","url":"https://github.com/owner/repo/issues/' + $Issue + '","body":' + ("Change ``src/fixture-$Issue.js``." | ConvertTo-Json) + ',"createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]')
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & node "$testRoot\bin\assignment.js" assign --root $testRoot --tenant test --tenant-config "$testRoot\tenants\test.json" --fixture $fixture --base-sha $Sha --parent pl-test --model sonnet 2>&1 | Out-String; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $eap }
  $r = $null; try { $r = ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch {}
  if ($code -ne 0 -or -not $r -or -not $r.manifestPath) { throw "assign for issue $Issue failed: $out" }
  return $r.manifestPath
}
# The Work record's state, or $null when it is no longer in active state.
function Get-RecordState {
  param([int]$Issue)
  $active = (Get-Content "$testRoot\state\work\active.json" -Raw) | ConvertFrom-Json
  $prop = $active.records.PSObject.Properties["test:issue-$Issue"]
  if ($prop) { return "$($prop.Value.state)" }
  return $null
}
function Get-Marker { param([string]$Manifest) if (Test-Path "$Manifest.invalidated.json") { return ((Get-Content "$Manifest.invalidated.json" -Raw) | ConvertFrom-Json) } return $null }

try {
  foreach ($dir in 'bin','hooks','agents','tenants','config','state','state/sessions','state/notices','state/work','state/events','state/flags','state/manifests','mock-bin','profile','profile/.claude/jobs','repo') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1','identity.js','work-state.js','assignment.js','premises.js','assignment-parity.js','exclusions.js','notify.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: sonnet`neffort: low`n---`nRole body for ic."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $repoPath = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","defaultBranch":"integration","branchPrefix":"fleet/","maxIcs":2,"repo":' + ($repoPath | ConvertTo-Json) + '}')

  Invoke-Git @('init', '-q', '-b', 'integration')
  Invoke-Git @('config', 'user.email', 'fleet-test@example.invalid')
  Invoke-Git @('config', 'user.name', 'fleet test')
  Write-Utf8 "$repoPath\README.md" 'fixture'
  Invoke-Git @('add', 'README.md')
  Invoke-Git @('commit', '-q', '-m', 'base')
  $baseSha = Invoke-Git @('rev-parse', 'HEAD')
  Invoke-Git @('remote', 'add', 'origin', $repoPath)
  Invoke-Git @('fetch', '-q', 'origin', 'integration')

  # gh: the issue read returns the body the planner hashed, or fails when MOCK_GH_FAIL=1. Every call is
  # logged to gh-calls.log. fleet#264's window (a release landing while the launch has no job and no
  # roster row yet) is simulated by MOCK_GH_MUTATE, applied by mock-mutate.js from one of two places:
  # the gh issue read (before the base fetch and the worktree add) or, with MOCK_MUTATE_AT=agents, the
  # `claude agents --json --all` call that is the last step before `claude --bg` (after the worktree exists).
  #   marker       = write the invalidation marker at MOCK_GH_MARKER_PATH (what a stranded-reservation release leaves)
  #   state:<s>    = move the Work record MOCK_GH_RECORD_ID to state <s> in MOCK_GH_ACTIVE_PATH
  #   revision:<n> = keep it `assigned` but at revision <n>
  #   missing      = delete the record from active.json (the shape after a release that archived it)
  $mutateLines = @(
    "'use strict';",
    "const fs = require('fs');",
    "module.exports = function applyMutation() {",
    "  const mutate = process.env.MOCK_GH_MUTATE || '';",
    "  if (mutate === 'marker') fs.writeFileSync(process.env.MOCK_GH_MARKER_PATH, JSON.stringify({ schemaVersion: 1, manifestId: 'mock', invalidatedAt: '2026-09-30T00:00:00.000Z', reason: 'mock release in the window' }));",
    "  if (/^(state|revision):/.test(mutate) || mutate === 'missing') {",
    "    const file = process.env.MOCK_GH_ACTIVE_PATH;",
    "    const active = JSON.parse(fs.readFileSync(file, 'utf8'));",
    "    const id = process.env.MOCK_GH_RECORD_ID;",
    "    const [kind, value] = mutate.split(':');",
    "    if (kind === 'missing') delete active.records[id];",
    "    else if (kind === 'state') active.records[id].state = value;",
    "    else active.records[id].revision = Number(value);",
    "    fs.writeFileSync(file, JSON.stringify(active));",
    "  }",
    "};"
  )
  Write-Utf8 "$testRoot\mock-bin\mock-mutate.js" (($mutateLines -join "`n") + "`n")
  $ghLines = @(
    "'use strict';",
    "const fs = require('fs'); const path = require('path');",
    "fs.appendFileSync(path.join(__dirname, '..', 'gh-calls.log'), process.argv.slice(2).join(' ') + '\n');",
    "if ((process.env.MOCK_MUTATE_AT || 'gh') === 'gh') require('./mock-mutate.js')();",
    "if (process.env.MOCK_GH_FAIL === '1') { process.stderr.write('gh: HTTP 502'); process.exit(1); }",
    "const n = process.argv.find((a) => /^\d+$/.test(a)) || '0';",
    "process.stdout.write(JSON.stringify({ state: 'OPEN', body: 'Change ``src/fixture-' + n + '.js``.' }));"
  )
  Write-Utf8 "$testRoot\mock-bin\mock-gh.js" (($ghLines -join "`n") + "`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ("@echo off`r`nnode `"%~dp0mock-gh.js`" %*`r`nexit /b %errorlevel%`r`n")
  # claude logs every call to claude-calls.log (the #264 cases ask whether `--bg` was ever called). `agents` lists no
  # sessions. With MOCK_MUTATE_AT=agents the `agents --json --all` call applies the mutation and records whether the
  # assignment worktree (MOCK_WORKTREE_PATH) existed at that moment in mutate-saw-worktree.log.
  $claudeLines = @(
    "'use strict';",
    "const fs = require('fs'); const path = require('path');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(path.join(__dirname, '..', 'claude-calls.log'), args.join(' ') + '\n');",
    "if (args[0] === 'agents') {",
    "  if (process.env.MOCK_MUTATE_AT === 'agents' && args.includes('--all')) {",
    "    fs.appendFileSync(path.join(__dirname, '..', 'mutate-saw-worktree.log'), String(fs.existsSync(process.env.MOCK_WORKTREE_PATH)) + '\n');",
    "    require('./mock-mutate.js')();",
    "  }",
    "  process.stdout.write('[]');",
    "}"
  )
  Write-Utf8 "$testRoot\mock-bin\mock-claude.js" (($claudeLines -join "`n") + "`n")
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ("@echo off`r`nnode `"%~dp0mock-claude.js`" %*`r`nexit /b %errorlevel%`r`n")
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:MOCK_GH_FAIL = '0'
  $env:MOCK_GH_ACTIVE_PATH = "$testRoot\state\work\active.json"
  Write-Utf8 "$testRoot\profile\.claude.json" (@{ projects = @{ ($testRoot.Replace('\', '/')) = @{ hasTrustDialogAccepted = $true } } } | ConvertTo-Json -Depth 4)

  # Case 1 (the nidus:issue-7 shape): gh cannot reconcile the issue. The launch exits 4, the
  # reservation is released and the marker names why.
  $m21 = Reserve-Manifest 21 $baseSha
  Assert-True ((Get-RecordState 21) -eq 'assigned') 'fixture: the reservation exists'
  $env:MOCK_GH_FAIL = '1'
  [void](Run-Launch @('-Manifest', $m21, '-WorkRecordId', 'test:issue-21'))
  Assert-True ($lastExit -eq 4 -and $lastFlat -match 'couldnotreconcileissue#21beforelaunch') "a gh failure must refuse with the reconcile reason: exit $lastExit $lastOut"
  Assert-True ((Get-RecordState 21) -ne 'assigned') "a refused launch must not leave the record assigned: $(Get-RecordState 21)"
  $marker = Get-Marker $m21
  Assert-True ($marker -and "$($marker.reason)" -match 'could not reconcile issue #21') "the invalidation marker names the gh failure: $($marker | ConvertTo-Json -Compress)"
  Assert-True ($lastFlat -notmatch 'releasealsofailed') 'a release that worked adds no failure note'

  # Case 2: relaunching the released manifest is refused as invalidated (the marker), never a second release.
  $markerBefore = Get-Content "$m21.invalidated.json" -Raw
  [void](Run-Launch @('-Manifest', $m21, '-WorkRecordId', 'test:issue-21'))
  Assert-True ($lastExit -eq 4 -and $lastFlat -match 'wasinvalidated') "a released manifest is refused as invalidated: $lastOut"
  Assert-True ((Get-Content "$m21.invalidated.json" -Raw) -eq $markerBefore) 'a replayed launch must not overwrite the original invalidation marker'

  # Case 3: the release itself fails (the manifest's revision is stale), and the refusal still reads
  # as the gh failure with the release failure appended; the record stays assigned, no marker.
  $m22 = Reserve-Manifest 22 $baseSha
  # The record's revision moves after the early check (during the gh read), so the release from the manifest's
  # revision is refused as stale. (An already-moved revision is refused before gh; see the #264 early-check case.)
  $env:MOCK_GH_MUTATE = 'revision:99'; $env:MOCK_GH_RECORD_ID = 'test:issue-22'
  try { [void](Run-Launch @('-Manifest', $m22, '-WorkRecordId', 'test:issue-22')) } finally { Remove-Item Env:MOCK_GH_MUTATE, Env:MOCK_GH_RECORD_ID -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 4 -and $lastFlat -match 'couldnotreconcileissue#22beforelaunch') "a failed release must not mask the refusal reason: exit $lastExit $lastOut"
  Assert-True ($lastFlat -match 'reservationreleasealsofailed') "the failed release is appended to the refusal: $lastOut"
  Assert-True ((Get-RecordState 22) -eq 'assigned' -and -not (Get-Marker $m22)) 'a failed release leaves the record assigned and writes no marker'

  # Case 4: the base fetch fails (gh fine, trust fine). Exit 4, released, marker names the fetch.
  $env:MOCK_GH_FAIL = '0'
  $m23 = Reserve-Manifest 23 $baseSha
  Invoke-Git @('remote', 'set-url', 'origin', "$testRoot\no-such-remote")
  [void](Run-Launch @('-Manifest', $m23, '-WorkRecordId', 'test:issue-23'))
  Invoke-Git @('remote', 'set-url', 'origin', $repoPath)
  Assert-True ($lastExit -eq 4 -and $lastFlat -match 'couldnotfetchorigin/integration') "a fetch failure must refuse naming the fetch: exit $lastExit $lastOut"
  Assert-True ((Get-RecordState 23) -ne 'assigned') 'a fetch failure must release the reservation'
  $marker = Get-Marker $m23
  Assert-True ($marker -and "$($marker.reason)" -match 'could not fetch origin/integration') "the marker names the fetch failure: $($marker | ConvertTo-Json -Compress)"
  Assert-True (-not (Test-Path "$repoPath\.claude\worktrees\ic-23-assignment")) 'a fetch failure creates no worktree'

  # Case 5: a gate (PAUSE) refuses with exit 3 and the JSON says the reservation was released.
  $m24 = Reserve-Manifest 24 $baseSha
  Write-Utf8 "$testRoot\state\PAUSE" 'test pause'
  $r5 = Run-Launch @('-Manifest', $m24, '-WorkRecordId', 'test:issue-24')
  Remove-Item "$testRoot\state\PAUSE" -ErrorAction SilentlyContinue
  Assert-True ($lastExit -eq 3 -and $r5 -and $r5.launched -eq $false -and "$($r5.reason)" -match 'PAUSE set' -and $r5.reservationReleased -eq $true) "a PAUSE refusal releases the reservation: $lastOut"
  Assert-True ((Get-RecordState 24) -ne 'assigned' -and (Get-Marker $m24)) 'the PAUSE refusal left no assigned record'

  # Case 6: a dry run never releases, even when it refuses.
  $m25 = Reserve-Manifest 25 $baseSha
  Write-Utf8 "$testRoot\state\PAUSE" 'test pause'
  $r6 = Run-Launch @('-Manifest', $m25, '-WorkRecordId', 'test:issue-25', '-DryRun')
  Remove-Item "$testRoot\state\PAUSE" -ErrorAction SilentlyContinue
  Assert-True ($lastExit -eq 3 -and $r6 -and $r6.launched -eq $false -and "$($r6.reason)" -match 'PAUSE set') "the dry run must still be refused by PAUSE (exit 3, PAUSE reason), so the no-release check is not vacuous: exit $lastExit $lastOut"
  Assert-True ((Get-RecordState 25) -eq 'assigned' -and -not (Get-Marker $m25)) 'a dry run must not release the reservation'

  # fleet#264: the window between launch.ps1's early checks and `claude --bg` (gh, fetch, worktree add:
  # 10-40 s, no job and no roster row) must not start an IC on a reservation that is already gone. The
  # mock gh reconcile step changes the world mid-launch; the launch must refuse, never call `claude --bg`,
  # remove the worktree it created (and its branch), and leave the record and marker as it found them.
  function Get-BgCalls { if (Test-Path "$testRoot\claude-calls.log") { return @(Get-Content "$testRoot\claude-calls.log" | Where-Object { $_ -match '--bg' }).Count } return 0 }
  function Get-Record { param([int]$Issue) $active = (Get-Content "$testRoot\state\work\active.json" -Raw) | ConvertFrom-Json; return $active.records.PSObject.Properties["test:issue-$Issue"].Value }
  # The earlier cases leave assigned records behind, and a fourth or third concurrent assignment needs
  # the planner's independence proof; these cases are about the window, so start each from an empty table.
  function Clear-ActiveRecords {
    $path = "$testRoot\state\work\active.json"
    $active = (Get-Content $path -Raw) | ConvertFrom-Json
    $active.records = [pscustomobject]@{}
    Write-Utf8 $path ($active | ConvertTo-Json -Depth 20)
  }
  # -At gh: the change lands during the gh issue read, before the base fetch and the worktree add.
  # -At agents: it lands in the `claude agents --json --all` call that is the last step before `claude --bg`,
  # after the worktree exists. The agents cases pin the PLACEMENT of the late re-check: a re-check hoisted above
  # the worktree add (or removed) would not see the change, and they prove the worktree was really created first.
  function Test-LateRefusal {
    param([int]$Issue, [string]$Mutate, [string]$At, [string]$ReasonPattern, [string]$Label)
    Clear-ActiveRecords
    $manifest = Reserve-Manifest $Issue $baseSha
    $recordBefore = Get-Record $Issue
    Remove-Item "$testRoot\claude-calls.log", "$testRoot\mutate-saw-worktree.log" -ErrorAction SilentlyContinue
    $env:MOCK_GH_MUTATE = $Mutate
    $env:MOCK_MUTATE_AT = $At
    $env:MOCK_GH_MARKER_PATH = "$manifest.invalidated.json"
    $env:MOCK_GH_RECORD_ID = "test:issue-$Issue"
    $env:MOCK_WORKTREE_PATH = "$repoPath\.claude\worktrees\ic-$Issue-assignment"
    try { [void](Run-Launch @('-Manifest', $manifest, '-WorkRecordId', "test:issue-$Issue")) }
    finally { Remove-Item Env:MOCK_GH_MUTATE, Env:MOCK_MUTATE_AT, Env:MOCK_GH_MARKER_PATH, Env:MOCK_GH_RECORD_ID, Env:MOCK_WORKTREE_PATH -ErrorAction SilentlyContinue }
    Assert-True ($lastExit -eq 4 -and $lastFlat -match $ReasonPattern) "${Label}: the launch refuses (exit 4) naming the failed re-check: exit $lastExit $lastOut"
    Assert-True ((Get-BgCalls) -eq 0) "${Label}: no claude --bg call may happen after the reservation is gone"
    if ($At -eq 'agents') {
      $sawWorktree = if (Test-Path "$testRoot\mutate-saw-worktree.log") { (Get-Content "$testRoot\mutate-saw-worktree.log" -Raw).Trim() } else { 'the agents call never ran' }
      Assert-True ($sawWorktree -eq 'true') "${Label}: the change landed after the worktree was created (saw: $sawWorktree), so the re-check sits after the worktree add"
    }
    Assert-True (-not (Test-Path "$repoPath\.claude\worktrees\ic-$Issue-assignment")) "${Label}: the worktree this launch created is removed"
    Assert-True (-not (Invoke-Git @('branch', '--list', "fleet/*$Issue*"))) "${Label}: the assignment branch this launch created is removed"
    return @{ Manifest = $manifest; Before = $recordBefore }
  }

  # Case 7: a release marker lands just before claude --bg (a stranded-reservation release wrote it). Nothing
  # is left to release: the marker the release wrote is not overwritten and the record is untouched.
  $c7 = Test-LateRefusal 26 'marker' 'agents' 'invalidated' 'marker case'
  $m7 = Get-Marker $c7.Manifest
  Assert-True ($m7 -and "$($m7.reason)" -eq 'mock release in the window') "marker case: the marker written in the window is left exactly as it was: $($m7 | ConvertTo-Json -Compress)"
  Assert-True ((Get-RecordState 26) -eq 'assigned' -and (Get-Record 26).revision -eq $c7.Before.revision) 'marker case: the launch itself releases nothing (record untouched)'
  # The same marker written earlier (during the gh read) is caught by the same re-check.
  $c7g = Test-LateRefusal 32 'marker' 'gh' 'invalidated' 'marker case (gh read)'

  # Case 8: the record was released during the gh read (no marker on disk). Refused on the record check;
  # the launch writes no marker of its own and does not touch the record.
  $c8 = Test-LateRefusal 27 'state:released' 'gh' 'isreleased' 'released case'
  Assert-True ((Get-RecordState 27) -eq 'released' -and -not (Get-Marker $c8.Manifest) -and (Get-Record 27).revision -eq $c8.Before.revision) 'released case: the launch wrote no marker and left the record alone'

  # Case 8b: the record is missing from active.json just before claude --bg (the shape after a release that
  # archived it).
  $c8b = Test-LateRefusal 33 'missing' 'agents' 'isnolongeractive' 'missing-record case'
  Assert-True (-not (Get-RecordState 33) -and -not (Get-Marker $c8b.Manifest)) 'missing-record case: the launch wrote no marker and put nothing back'

  # Case 9: the record moved to another state during the gh read.
  $c9 = Test-LateRefusal 28 'state:implementing' 'gh' 'isimplementing' 'other-state case'
  Assert-True ((Get-RecordState 28) -eq 'implementing' -and -not (Get-Marker $c9.Manifest)) 'other-state case: record untouched, no marker written by the launch'

  # Case 10: still `assigned` but at a different revision than the manifest reserved (a release and a
  # re-reservation landed just before claude --bg): this manifest no longer owns it.
  $c10 = Test-LateRefusal 29 'revision:7' 'agents' 'movedtorevision7' 'revision case'
  Assert-True ((Get-RecordState 29) -eq 'assigned' -and (Get-Record 29).revision -eq 7 -and -not (Get-Marker $c10.Manifest)) 'revision case: record untouched, no marker written by the launch'

  # Case 12 (the early check): the record is already `assigned` at another revision than the manifest reserved
  # (a lead's escalate -> assigned round trip bumps it on the same manifest). Refused before any gh call, fetch or
  # worktree work, with no release.
  Clear-ActiveRecords
  $m34 = Reserve-Manifest 34 $baseSha
  $manifestRevision = [int]((Get-Content $m34 -Raw) | ConvertFrom-Json).workRecordRevision
  $activePath = "$testRoot\state\work\active.json"
  $activeDoc = (Get-Content $activePath -Raw) | ConvertFrom-Json
  $activeDoc.records.PSObject.Properties['test:issue-34'].Value.revision = $manifestRevision + 2
  Write-Utf8 $activePath ($activeDoc | ConvertTo-Json -Depth 20)
  Remove-Item "$testRoot\claude-calls.log", "$testRoot\gh-calls.log" -ErrorAction SilentlyContinue
  [void](Run-Launch @('-Manifest', $m34, '-WorkRecordId', 'test:issue-34'))
  Assert-True ($lastExit -eq 4 -and $lastFlat -match "isatrevision$($manifestRevision + 2),butthemanifestreservedrevision$manifestRevision") "a record at another revision is refused early, naming both revisions: exit $lastExit $lastOut"
  Assert-True (-not (Test-Path "$testRoot\gh-calls.log")) 'the early revision check refuses before any gh call'
  Assert-True ((Get-BgCalls) -eq 0 -and -not (Test-Path "$repoPath\.claude\worktrees\ic-34-assignment") -and -not (Invoke-Git @('branch', '--list', 'fleet/*34*'))) 'the early revision check creates no worktree and calls no claude --bg'
  Assert-True ((Get-RecordState 34) -eq 'assigned' -and (Get-Record 34).revision -eq ($manifestRevision + 2) -and -not (Get-Marker $m34)) 'the early revision check releases nothing and writes no marker'

  # Case 11: the control. With nothing changed in the window the same launch reaches `claude --bg` (the
  # mock claude starts no session, so it then fails as it always did): the re-check does not refuse every launch.
  Clear-ActiveRecords
  $m30 = Reserve-Manifest 30 $baseSha
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  [void](Run-Launch @('-Manifest', $m30, '-WorkRecordId', 'test:issue-30'))
  Assert-True ((Get-BgCalls) -eq 1) "control: an untouched reservation still reaches claude --bg: $lastOut"

  Write-Output 'launch refusal release tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_GH_FAIL, Env:MOCK_GH_ACTIVE_PATH, Env:MOCK_GH_MUTATE, Env:MOCK_GH_MARKER_PATH, Env:MOCK_GH_RECORD_ID, Env:MOCK_MUTATE_AT, Env:MOCK_WORKTREE_PATH -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-refusal-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500; try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
  }
}
