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
  # The arguments go to launch.ps1 unchanged, so a case can pass -Force or -Recover as well.
  $wrapper = Join-Path $testRoot 'run-launch.ps1'
  $wrapperLines = @(
    '$ErrorActionPreference = "Continue"',
    ('& "' + $testRoot + '\bin\launch.ps1" @args 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "ERR: " + $_.Exception.Message } else { "$_" } }'),
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
  param([int]$Issue, [string]$Sha, [string]$Tenant = 'test', [string]$Permissions = '')
  $fixture = "$testRoot\issues-$Issue.json"
  Write-Utf8 $fixture ('[{"number":' + $Issue + ',"title":"Refusal fixture","url":"https://github.com/owner/repo/issues/' + $Issue + '","body":' + ("Change ``src/fixture-$Issue.js``." | ConvertTo-Json) + ',"createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]')
  $permArgs = if ($Permissions) { @('--permissions', $Permissions) } else { @() }
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & node "$testRoot\bin\assignment.js" assign --root $testRoot --tenant $Tenant --tenant-config "$testRoot\tenants\$Tenant.json" --fixture $fixture --base-sha $Sha --parent pl-test --model haiku @permArgs 2>&1 | Out-String; $code = $LASTEXITCODE }
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
  foreach ($f in '_common.ps1','launch.ps1','identity.js','work-state.js','assignment.js','premises.js','assignment-parity.js','exclusions.js','notify.js','usage-limit.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: claude-haiku-5-5`neffort: xhigh`n---`nRole body for ic."
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
  # fleet #434: `agents` prints mock-agents.json (always '[]' unless a case writes rows), and MOCK_BG_ROW=1 gives a
  # --bg launch its daemon row, so a launch can complete (launched = true). Without it a --bg starts no session.
  $claudeLines = @(
    "'use strict';",
    "const fs = require('fs'); const path = require('path');",
    "const args = process.argv.slice(2);",
    "const daemonFile = path.join(__dirname, '..', 'mock-agents.json');",
    "fs.appendFileSync(path.join(__dirname, '..', 'claude-calls.log'), args.join(' ') + '\n');",
    "if (args[0] === 'agents') {",
    "  if (process.env.MOCK_MUTATE_AT === 'agents' && args.includes('--all')) {",
    "    fs.appendFileSync(path.join(__dirname, '..', 'mutate-saw-worktree.log'), String(fs.existsSync(process.env.MOCK_WORKTREE_PATH)) + '\n');",
    "    require('./mock-mutate.js')();",
    "  }",
    "  process.stdout.write(fs.readFileSync(daemonFile, 'utf8'));",
    "}",
    "if (args[0] === '--bg' && process.env.MOCK_BG_ROW === '1') {",
    "  const name = args[args.indexOf('--name') + 1];",
    "  const rows = JSON.parse(fs.readFileSync(daemonFile, 'utf8'));",
    "  rows.push({ id: 'job-' + name + '-' + Date.now(), name, state: 'working', status: 'idle', pid: 21, sessionId: 'sess-' + name + '-' + Date.now(), startedAt: Date.now() });",
    "  fs.writeFileSync(daemonFile, JSON.stringify(rows));",
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
  # fleet #384: the real background launch carries --no-chrome (the mock claude logs its argv).
  Assert-True (@(Get-Content "$testRoot\claude-calls.log" | Where-Object { $_ -match '^--bg ' -and $_ -match ' --no-chrome(\s|$)' }).Count -eq 1) 'the claude --bg call must carry --no-chrome'

  # Fleet #350 (ruling 12): a manifest naming the retired deepseek tier is refused at the door and its
  # reservation released. The -Model ValidateSet has no deepseek, so the manifest's model must not go through it.
  Clear-ActiveRecords
  $m35 = Reserve-Manifest 35 $baseSha
  $doc35 = (Get-Content $m35 -Raw) | ConvertFrom-Json
  $doc35.model = 'deepseek'
  Write-Utf8 $m35 ($doc35 | ConvertTo-Json -Depth 20)
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $r35 = Run-Launch @('-Manifest', $m35, '-WorkRecordId', 'test:issue-35')
  Assert-True ($lastExit -eq 3 -and $r35 -and $r35.launched -eq $false -and "$($r35.reason)" -match "'deepseek' is refused" -and $r35.reservationReleased -eq $true) "a deepseek manifest is refused at the door with its reservation released: exit $lastExit $lastOut"
  Assert-True ((Get-RecordState 35) -ne 'assigned' -and (Get-Marker $m35) -and "$((Get-Marker $m35).reason)" -match "'deepseek' is refused") 'the deepseek refusal leaves no assigned record and writes the invalidation marker with its reason'
  Assert-True ((Get-BgCalls) -eq 0) 'a deepseek manifest never reaches claude --bg'

  # fleet #434: bin\recover.ps1 relaunches a dead IC with -Recover and no -Manifest. A validated recovery is the same
  # unit as the manifest launch it restarts, so it carries that launch's roster row over (manifest, Work record id,
  # cwd, permissions) and reads the branch and base from the manifest file. The allowlist profile is pinned here
  # because it is the one non-default permissions value; its rehearsalRoot marker is the scratch-root bypass of the CLI gate.
  Clear-ActiveRecords
  Write-Utf8 "$testRoot\config\permissions-allowlist.json" '{"rehearsalRoot":true,"defaultMode":"acceptEdits","allow":[{"rule":"Bash(git status)"}]}'
  $m40 = Reserve-Manifest 40 $baseSha 'test' 'allowlist'
  $manifest40 = (Get-Content $m40 -Raw) | ConvertFrom-Json
  $env:MOCK_BG_ROW = '1'
  try {
    Write-Utf8 "$testRoot\mock-agents.json" '[]'
    $r40 = Run-Launch @('-Manifest', $m40, '-WorkRecordId', 'test:issue-40')
  } finally { Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 0 -and $r40.launched -eq $true) "fixture: a real manifest launch completes against the mock daemon: exit $lastExit $lastOut"
  $oldRow = @((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'ic-40' -and $_.status -eq 'active' })[0]
  Assert-True ($oldRow -and "$($oldRow.manifest)" -and "$($oldRow.workRecordId)" -eq 'test:issue-40' -and "$($oldRow.permissions)" -eq 'allowlist') "fixture: the manifest launch's roster row records its manifest, Work record and permissions: $(($oldRow | ConvertTo-Json -Compress))"
  Assert-True ("$($oldRow.cwd)" -eq "$repoPath\.claude\worktrees\ic-40-assignment") "fixture: the manifest launch's row names its assignment worktree: $($oldRow.cwd)"
  $recordBefore = Get-Record 40
  $worktreesBefore = Invoke-Git @('worktree', 'list', '--porcelain')
  $recoverArgs = @('-Role', 'ic', '-Name', 'ic-40', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '40', '-Prompt', "$($oldRow.prompt)", '-Recover', '-Reason', 'recover')

  # fleet #434: no manifest precondition runs on a recovery (no gh read, no fetch). The controls come first: the mock gh
  # log records the manifest launch's reconciliation, and a fetch recreates origin/integration, so both probes see a call.
  function Get-GhCount { if (Test-Path "$testRoot\gh-calls.log") { return @(Get-Content "$testRoot\gh-calls.log").Count } return 0 }
  function Test-OriginRef { $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & git.exe -C "$testRoot\repo" rev-parse --verify --quiet refs/remotes/origin/integration 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $eap } }
  Assert-True ((Get-GhCount) -gt 0) 'control: the mock gh log records the manifest launch, so a gh call during a recovery would show'
  Invoke-Git @('fetch', '-q', 'origin', 'integration')
  Assert-True (Test-OriginRef) 'control: a fetch creates origin/integration, so its absence after a recovery shows that no fetch ran'
  Invoke-Git @('update-ref', '-d', 'refs/remotes/origin/integration')
  $ghBeforeRecover = Get-GhCount

  # The daemon lost the job: no session row for ic-40 when the recovery runs.
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $env:MOCK_BG_ROW = '1'
  try { $rec1 = Run-Launch $recoverArgs } finally { Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 0 -and $rec1 -and $rec1.launched -eq $true) "a validated -Recover of a dead IC launches: exit $lastExit $lastOut"
  Assert-True ((Get-GhCount) -eq $ghBeforeRecover -and -not (Test-OriginRef)) 'fleet #434: a recovery runs no manifest precondition: no gh call and no fetch (origin/integration stays absent)'
  Assert-True ("$($rec1.cwd)" -eq "$($oldRow.cwd)") "fleet #434: the recovered IC starts in its assignment worktree ($($oldRow.cwd)), not the repo root: $($rec1.cwd)"
  $rows1 = @((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'ic-40' -and $_.status -eq 'active' })
  Assert-True ($rows1.Count -eq 1) "the recovery replaces the roster row (active ic-40 rows: $($rows1.Count))"
  $newRow = $rows1[0]
  Assert-True ("$($newRow.manifest)" -eq "$($oldRow.manifest)" -and "$($newRow.workRecordId)" -eq "$($oldRow.workRecordId)" -and "$($newRow.cwd)" -eq "$($oldRow.cwd)" -and "$($newRow.permissions)" -eq "$($oldRow.permissions)" -and "$($newRow.launchReason)" -eq 'recover') "fleet #434: the recovered roster row keeps the manifest, Work record, cwd and permissions of the row it replaces: $(($newRow | ConvertTo-Json -Compress))"
  $sessionEnv = (Get-Content "$testRoot\state\sessions\ic-40.settings.json" -Raw | ConvertFrom-Json).env
  Assert-True ("$($sessionEnv.FLEET_ASSIGNMENT_MANIFEST)" -eq "$($oldRow.manifest)" -and "$($sessionEnv.FLEET_WORK_RECORD_ID)" -eq 'test:issue-40' -and "$($sessionEnv.FLEET_BASE_SHA)" -eq "$($manifest40.base.sha)" -and "$($sessionEnv.FLEET_ASSIGNMENT_BRANCH)" -eq "$($manifest40.branch)" -and "$($sessionEnv.FLEET_PERMISSIONS)" -eq 'allowlist') "fleet #434: the recovered session's settings carry its assignment env (manifest, Work record, base, branch, permissions): $(($sessionEnv | ConvertTo-Json -Compress))"
  Assert-True ((Invoke-Git @('worktree', 'list', '--porcelain')) -eq $worktreesBefore) 'fleet #434: a recovery creates no worktree (git worktree list is unchanged)'
  $recordAfter = Get-Record 40
  Assert-True ("$($recordAfter.state)" -eq "$($recordBefore.state)" -and [string]$recordAfter.revision -eq [string]$recordBefore.revision) "fleet #434: a recovery leaves the Work record's state and revision unchanged: $($recordBefore.state) r$($recordBefore.revision) -> $($recordAfter.state) r$($recordAfter.revision)"

  # A second recovery of the same IC is not refused: the first one wrote the row that a later recovery checks.
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $env:MOCK_BG_ROW = '1'
  try { $rec2 = Run-Launch $recoverArgs } finally { Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 0 -and $rec2 -and $rec2.launched -eq $true -and $lastFlat -notmatch 'Recoverfoundnoactive') "fleet #434: a second recovery of the same IC is not refused: exit $lastExit $lastOut"

  # fleet #434: the roster row is the credential, so a caller's -WorkRecordId and -Permissions do not override it.
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $env:MOCK_BG_ROW = '1'
  try { $rec3 = Run-Launch ($recoverArgs + @('-WorkRecordId', 'test:issue-99', '-Permissions', 'auto')) } finally { Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 0 -and $rec3 -and $rec3.launched -eq $true) "fleet #434: a recovery with a caller's -WorkRecordId and -Permissions still launches: exit $lastExit $lastOut"
  $sessionEnv3 = (Get-Content "$testRoot\state\sessions\ic-40.settings.json" -Raw | ConvertFrom-Json).env
  Assert-True ("$($sessionEnv3.FLEET_WORK_RECORD_ID)" -eq 'test:issue-40' -and "$($sessionEnv3.FLEET_PERMISSIONS)" -eq 'allowlist') "fleet #434: the settings keep the roster row's Work record and permissions over the caller's: $(($sessionEnv3 | ConvertTo-Json -Compress))"
  $row3 = @((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'ic-40' -and $_.status -eq 'active' })[0]
  Assert-True ("$($row3.workRecordId)" -eq 'test:issue-40' -and "$($row3.permissions)" -eq 'allowlist') "fleet #434: the new roster row keeps the row's Work record and permissions: $(($row3 | ConvertTo-Json -Compress))"

  # fleet #434: a recovery whose manifest file is gone still launches. It has the row's manifest path and Work record id,
  # and no branch or base to read from the file, so the base and branch keys are absent.
  $m40Aside = "$($m40).aside"
  Move-Item -LiteralPath $m40 -Destination $m40Aside
  try {
    Write-Utf8 "$testRoot\mock-agents.json" '[]'
    $env:MOCK_BG_ROW = '1'
    $rec4 = Run-Launch $recoverArgs
  } finally { Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue; Move-Item -LiteralPath $m40Aside -Destination $m40 }
  Assert-True ($lastExit -eq 0 -and $rec4 -and $rec4.launched -eq $true) "fleet #434: a recovery whose manifest file is missing still launches: exit $lastExit $lastOut"
  $sessionEnv4 = (Get-Content "$testRoot\state\sessions\ic-40.settings.json" -Raw | ConvertFrom-Json).env
  Assert-True ("$($sessionEnv4.FLEET_ASSIGNMENT_MANIFEST)" -eq "$($oldRow.manifest)" -and "$($sessionEnv4.FLEET_WORK_RECORD_ID)" -eq 'test:issue-40' -and -not $sessionEnv4.PSObject.Properties['FLEET_BASE_SHA'] -and -not $sessionEnv4.PSObject.Properties['FLEET_ASSIGNMENT_BRANCH']) "fleet #434: with no manifest file the recovery keeps the row's manifest and Work record id and sets no base or branch: $(($sessionEnv4 | ConvertTo-Json -Compress))"

  # fleet #434: a recovery whose assignment worktree is gone is refused before anything is written: no release, no marker,
  # and the roster row and the Work record keep their state. An empty leftover directory at the path is no worktree either.
  $goneRowBefore = (@((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'ic-40' -and $_.status -eq 'active' })[0] | ConvertTo-Json -Compress)
  $goneRecordBefore = Get-Record 40
  Invoke-Git @('worktree', 'remove', '--force', "$($oldRow.cwd)")
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $env:MOCK_BG_ROW = '1'
  try { $gone1 = Run-Launch $recoverArgs } finally { Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 3 -and $gone1 -and $gone1.launched -eq $false -and "$($gone1.reason)" -match "assignment worktree of 'ic-40' gone") "fleet #434: a recovery whose worktree is gone is refused with exit 3 naming it: exit $lastExit $lastOut"
  [IO.Directory]::CreateDirectory("$($oldRow.cwd)") | Out-Null
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $env:MOCK_BG_ROW = '1'
  try { $gone2 = Run-Launch $recoverArgs } finally { Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 3 -and $gone2 -and $gone2.launched -eq $false -and "$($gone2.reason)" -match "assignment worktree of 'ic-40' gone") "fleet #434: an empty leftover directory at the worktree path is refused the same way: exit $lastExit $lastOut"
  Assert-True (-not (Test-Path "$($oldRow.manifest).invalidated.json")) 'fleet #434: the refused recovery writes no invalidation marker beside its manifest'
  $goneRowAfter = (@((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'ic-40' -and $_.status -eq 'active' })[0] | ConvertTo-Json -Compress)
  Assert-True ($goneRowAfter -eq $goneRowBefore) "fleet #434: the refused recovery leaves the roster row unchanged: $goneRowAfter"
  $goneRecordAfter = Get-Record 40
  Assert-True ("$($goneRecordAfter.state)" -eq "$($goneRecordBefore.state)" -and [string]$goneRecordAfter.revision -eq [string]$goneRecordBefore.revision) 'fleet #434: the refused recovery leaves the Work record state and revision unchanged'

  Write-Output 'launch refusal release tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_GH_FAIL, Env:MOCK_GH_ACTIVE_PATH, Env:MOCK_GH_MUTATE, Env:MOCK_GH_MARKER_PATH, Env:MOCK_GH_RECORD_ID, Env:MOCK_MUTATE_AT, Env:MOCK_WORKTREE_PATH, Env:MOCK_BG_ROW -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-refusal-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500; try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
  }
}
