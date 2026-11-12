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
  #   manifestPath:<p> = point the record's manifestPath at <p> (a manifest it was not reserved with) (fleet #437)
  $mutateLines = @(
    "'use strict';",
    "const fs = require('fs');",
    "module.exports = function applyMutation() {",
    "  const mutate = process.env.MOCK_GH_MUTATE || '';",
    "  if (mutate === 'marker') fs.writeFileSync(process.env.MOCK_GH_MARKER_PATH, JSON.stringify({ schemaVersion: 1, manifestId: 'mock', invalidatedAt: '2026-09-30T00:00:00.000Z', reason: 'mock release in the window' }));",
    "  if (/^(state|revision|manifestPath):/.test(mutate) || mutate === 'missing') {",
    "    const file = process.env.MOCK_GH_ACTIVE_PATH;",
    "    const active = JSON.parse(fs.readFileSync(file, 'utf8'));",
    "    const id = process.env.MOCK_GH_RECORD_ID;",
    "    const [kind, value] = mutate.split(':');",
    "    if (kind === 'missing') delete active.records[id];",
    "    else if (kind === 'state') active.records[id].state = value;",
    "    else if (kind === 'manifestPath') active.records[id].manifestPath = value;",
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
    "if (args[0] === 'stop' && process.env.MOCK_STOP_FAIL === '1') process.exit(9);",
    "const lateFile = path.join(__dirname, '..', 'late-row.json');",
    "if (args[0] === '--bg' && process.env.MOCK_LATE_ROW) fs.writeFileSync(lateFile, JSON.stringify({ name: args[args.indexOf('--name') + 1], calls: 0 }));",
    "if (args[0] === 'agents' && !args.includes('--all') && process.env.MOCK_LATE_ROW && fs.existsSync(lateFile)) {",
    "  // ticket 455: the 21st list read after --bg is the launch's late read (the poll loop makes 20 and sees nothing); MOCK_LATE_ROW=fail makes that read fail",
    "  const late = JSON.parse(fs.readFileSync(lateFile, 'utf8'));",
    "  late.calls += 1; fs.writeFileSync(lateFile, JSON.stringify(late));",
    "  if (late.calls === 21 && process.env.MOCK_LATE_ROW === 'fail') { process.stderr.write('mock: the list read failed'); process.exit(9); }",
    "  if (late.calls === 21) { const rows = JSON.parse(fs.readFileSync(daemonFile, 'utf8')); rows.push({ id: 'job-late-' + late.name, name: late.name, state: 'working', status: 'idle', pid: 22, sessionId: 'sess-late-' + late.name, startedAt: Date.now() }); fs.writeFileSync(daemonFile, JSON.stringify(rows)); }",
    "}",
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

  # fleet #437: still `assigned` at the manifest's revision but now naming another manifest (a re-reservation landed
  # just before claude --bg): the late re-check refuses it, and the launch releases and writes nothing.
  $c31 = Test-LateRefusal 31 'manifestPath:other.json' 'agents' 'nolongernamesthismanifest' 'manifest-path case'
  Assert-True ((Get-RecordState 31) -eq 'assigned' -and (Get-Record 31).revision -eq $c31.Before.revision -and (Get-Record 31).manifestPath -eq 'other.json' -and -not (Get-Marker $c31.Manifest)) 'manifest-path case: record untouched, no marker written by the launch'

  # ticket 455: two launches of one name are serialised. This test takes the name's launch mutex (keyed like the roster lock:
  # the SHA-1 of the fleet root, then the name) while a second launch of the same name runs. The second must wait and touch
  # nothing; once the test lets go it reaches the name check, sees the first launch's session, and is refused, leaving the
  # first launch's worktree, roster row and reservation as they were.
  Clear-ActiveRecords
  $m48 = Reserve-Manifest 48 $baseSha
  $lockKey = [BitConverter]::ToString([System.Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($testRoot.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant()
  $nameMutex = New-Object System.Threading.Mutex $false, "Global\fleet-launch-$lockKey-ic-48"
  Assert-True ($nameMutex.WaitOne(0)) 'the test takes the name mutex first'
  $firstWorktree = "$repoPath\.claude\worktrees\ic-48-assignment"
  [IO.Directory]::CreateDirectory($firstWorktree) | Out-Null
  Write-Utf8 "$firstWorktree\first.txt" 'the first launch'
  Write-Utf8 "$testRoot\mock-agents.json" '[{"id":"job-first","name":"ic-48","state":"working","status":"idle","pid":21,"sessionId":"sess-first","startedAt":1756000000000}]'
  Write-Utf8 "$testRoot\state\roster.json" ('{"sessions":[{"name":"ic-48","role":"ic","tenant":"test","parent":"pl-test","issue":48,"cwd":' + ($firstWorktree | ConvertTo-Json) + ',"status":"active","jobId":"job-first","sessionId":"sess-first","manifest":' + ($m48 | ConvertTo-Json) + ',"workRecordId":"test:issue-48"}]}')
  $rosterBefore48 = Get-Content "$testRoot\state\roster.json" -Raw
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $waitOut = "$testRoot\second-launch.out"
  $second = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$testRoot\run-launch.ps1", '-Manifest', $m48, '-WorkRecordId', 'test:issue-48') -PassThru -WindowStyle Hidden -RedirectStandardOutput $waitOut
  $null = $second.Handle   # caches the handle so ExitCode survives the exit
  Start-Sleep -Seconds 8
  Assert-True (-not $second.HasExited) 'a second launch of the name waits while the first holds the name mutex'
  Assert-True ((Get-BgCalls) -eq 0 -and (Get-RecordState 48) -eq 'assigned' -and (Get-Content "$testRoot\state\roster.json" -Raw) -eq $rosterBefore48 -and (Test-Path "$firstWorktree\first.txt")) 'while it waits, the second launch has touched nothing'
  $nameMutex.ReleaseMutex(); $nameMutex.Dispose()
  Assert-True ($second.WaitForExit(60000)) 'the second launch finishes once the name mutex is released'
  $secondText = Get-Content $waitOut -Raw
  Assert-True ($second.ExitCode -eq 3 -and "$secondText" -match 'already running') "the second launch is refused at the name check (exit $($second.ExitCode)): $secondText"
  Assert-True ((Get-BgCalls) -eq 0 -and (Get-RecordState 48) -eq 'assigned' -and (Get-Content "$testRoot\state\roster.json" -Raw) -eq $rosterBefore48 -and (Test-Path "$firstWorktree\first.txt") -and -not (Get-Marker $m48)) 'the refused second launch removes nothing the first launch made and releases nothing'
  Remove-Item -LiteralPath $firstWorktree -Recurse -Force
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # ticket 455 review: the lock wait is 10 s. A launch that holds the name longer than that is not waited for: the second
  # launch is refused with exit 8 (launchInFlight) and touches nothing. The test holds the name's mutex until that refusal lands.
  Clear-ActiveRecords
  $m53 = Reserve-Manifest 53 $baseSha
  $nameMutex53 = New-Object System.Threading.Mutex $false, "Global\fleet-launch-$lockKey-ic-53"
  Assert-True ($nameMutex53.WaitOne(0)) 'the test takes the ic-53 name mutex first'
  $first53 = "$repoPath\.claude\worktrees\ic-53-assignment"
  [IO.Directory]::CreateDirectory($first53) | Out-Null
  Write-Utf8 "$first53\first.txt" 'the first launch'
  Write-Utf8 "$testRoot\state\roster.json" ('{"sessions":[{"name":"ic-53","role":"ic","tenant":"test","parent":"pl-test","issue":53,"cwd":' + ($first53 | ConvertTo-Json) + ',"status":"active","jobId":"job-first-53","sessionId":"sess-first-53","manifest":' + ($m53 | ConvertTo-Json) + ',"workRecordId":"test:issue-53"}]}')
  $roster53 = Get-Content "$testRoot\state\roster.json" -Raw
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $out53 = "$testRoot\held-launch.out"
  $waiter53 = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$testRoot\run-launch.ps1", '-Manifest', $m53, '-WorkRecordId', 'test:issue-53') -PassThru -WindowStyle Hidden -RedirectStandardOutput $out53
  $null = $waiter53.Handle
  $clock53 = [Diagnostics.Stopwatch]::StartNew()
  $exited53 = $waiter53.WaitForExit(40000)
  $clock53.Stop()
  $nameMutex53.ReleaseMutex(); $nameMutex53.Dispose()
  $text53 = "$(Get-Content $out53 -Raw)"
  Assert-True ($exited53 -and $waiter53.ExitCode -eq 8 -and $text53 -match '"launchInFlight":true' -and $text53 -match 'in flight') "a launch that waits out the 10 s bound is refused with exit 8, launchInFlight and the in-flight reason (exit $($waiter53.ExitCode)): $text53"
  Assert-True ($clock53.Elapsed.TotalSeconds -ge 9.5) "the refusal comes after the 10 s bound, not before it (after $($clock53.Elapsed.TotalSeconds) s)"
  Assert-True ((Get-BgCalls) -eq 0 -and (Get-RecordState 53) -eq 'assigned' -and (Get-Content "$testRoot\state\roster.json" -Raw) -eq $roster53 -and (Test-Path "$first53\first.txt") -and -not (Get-Marker $m53)) 'the refused waiter touched nothing: no claude call, the reservation, the roster and the first worktree as they were, no marker'
  Remove-Item -LiteralPath $first53 -Recurse -Force
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # ticket 455 review: a launch lock that cannot be created or taken (here a mutex whose ACL denies this user) refuses with its
  # own JSON (exit 9) and keeps the reservation: nothing was touched.
  Clear-ActiveRecords
  $m55 = Reserve-Manifest 55 $baseSha
  $denySec55 = New-Object System.Security.AccessControl.MutexSecurity
  $denySec55.AddAccessRule((New-Object System.Security.AccessControl.MutexAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, [System.Security.AccessControl.MutexRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Deny)))
  $created55 = $false
  $denied55 = New-Object System.Threading.Mutex -ArgumentList $false, "Global\fleet-launch-$lockKey-ic-55", ([ref]$created55), $denySec55
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $r55 = Run-Launch @('-Manifest', $m55, '-WorkRecordId', 'test:issue-55')
  $denied55.Dispose()
  Assert-True ($lastExit -eq 9 -and $r55 -and $r55.launchLockFailed -eq $true -and $r55.launched -eq $false -and (Get-RecordState 55) -eq 'assigned' -and -not (Get-Marker $m55) -and (Get-BgCalls) -eq 0 -and -not (Test-Path "$repoPath\.claude\worktrees\ic-55-assignment")) "a launch lock that cannot be taken refuses with its own JSON (exit 9), keeps the reservation and touches nothing (exit $lastExit): $lastOut"

  # ticket 455 review: the roster is read again once the launch lock is held. A row another launch wrote while this one
  # waited, with a fresh working job behind it, is what the in-lock guard must see: the launch refuses as a suspected bad read.
  Clear-ActiveRecords
  $m57 = Reserve-Manifest 57 $baseSha
  $nameMutex57 = New-Object System.Threading.Mutex $false, "Global\fleet-launch-$lockKey-ic-57"
  Assert-True ($nameMutex57.WaitOne(0)) 'the test takes the ic-57 name mutex first'
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $job57 = "$testRoot\profile\.claude\jobs\job-57"
  [IO.Directory]::CreateDirectory($job57) | Out-Null
  Write-Utf8 "$job57\state.json" ('{"state":"working","updatedAt":"' + (Get-Date).ToUniversalTime().ToString('o') + '"}')
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $out57 = "$testRoot\waited-57.out"
  $waiter57 = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$testRoot\run-launch.ps1", '-Manifest', $m57, '-WorkRecordId', 'test:issue-57') -PassThru -WindowStyle Hidden -RedirectStandardOutput $out57
  $null = $waiter57.Handle
  Start-Sleep -Seconds 4
  Write-Utf8 "$testRoot\state\roster.json" ('{"sessions":[{"name":"ic-57","role":"ic","tenant":"test","parent":"pl-test","issue":57,"status":"active","jobId":"job-57","sessionId":"sess-57","manifest":' + ($m57 | ConvertTo-Json) + ',"workRecordId":"test:issue-57"}]}')
  $nameMutex57.ReleaseMutex(); $nameMutex57.Dispose()
  Assert-True ($waiter57.WaitForExit(60000)) 'the waiter finishes once the ic-57 lock is released'
  $text57 = "$(Get-Content $out57 -Raw)"
  Assert-True ($waiter57.ExitCode -eq 3 -and $text57 -match 'suspected bad read') "a row written while the launch waited is seen by the in-lock guard (exit $($waiter57.ExitCode)): $text57"
  Assert-True ((Get-BgCalls) -eq 0 -and (Get-RecordState 57) -eq 'assigned') 'the guarded launch starts no claude session and releases nothing'
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Remove-Item -LiteralPath $job57 -Recurse -Force

  # ticket 455 review: a -Recover waits for the launch lock like any launch. When the roster row it recovers changes while
  # it waits, it is refused rather than restarted on the row it read before the wait.
  $wt58 = "$testRoot\recover-58"
  [IO.Directory]::CreateDirectory($wt58) | Out-Null
  Write-Utf8 "$wt58\.git" 'gitdir: fixture'
  Clear-ActiveRecords
  $m58 = Reserve-Manifest 58 $baseSha
  $row58 = '{"sessions":[{"name":"ic-58","role":"ic","tenant":"test","parent":"pl-test","issue":58,"cwd":' + ($wt58 | ConvertTo-Json) + ',"status":"active","jobId":"JOB","sessionId":"sess-58","manifest":' + ($m58 | ConvertTo-Json) + ',"workRecordId":"test:issue-58","permissions":"auto","effort":"xhigh","prompt":"Implement issue 58."}]}'
  Write-Utf8 "$testRoot\state\roster.json" $row58.Replace('JOB', 'job-58-old')
  $nameMutex58 = New-Object System.Threading.Mutex $false, "Global\fleet-launch-$lockKey-ic-58"
  Assert-True ($nameMutex58.WaitOne(0)) 'the test takes the ic-58 name mutex first'
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $out58 = "$testRoot\recover-58.out"
  $waiter58 = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$testRoot\run-launch.ps1", '-Role', 'ic', '-Name', 'ic-58', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '58', '-Prompt', 'implement-58', '-Recover', '-Reason', 'recover') -PassThru -WindowStyle Hidden -RedirectStandardOutput $out58
  $null = $waiter58.Handle
  Start-Sleep -Seconds 4
  Write-Utf8 "$testRoot\state\roster.json" $row58.Replace('JOB', 'job-58-new')
  $nameMutex58.ReleaseMutex(); $nameMutex58.Dispose()
  Assert-True ($waiter58.WaitForExit(60000)) 'the recovery finishes once the ic-58 lock is released'
  $text58 = "$(Get-Content $out58 -Raw)"
  Assert-True ($waiter58.ExitCode -eq 3 -and $text58 -match 'changed while this recovery waited for the launch lock' -and (Get-BgCalls) -eq 0) "a recovery whose roster row changed while it waited is refused, not restarted on the old row (exit $($waiter58.ExitCode)): $text58"
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Remove-Item -LiteralPath $wt58 -Recurse -Force

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

  # ticket 455: a manifest with an invalid value is refused by assign before any reservation exists: no Work record and no
  # manifest file, so there is nothing for a launch to release. (assign builds and checks the manifest before it reserves.)
  Clear-ActiveRecords
  $fixture49 = "$testRoot\issues-49.json"
  Write-Utf8 $fixture49 ('[{"number":49,"title":"Refusal fixture","url":"https://github.com/owner/repo/issues/49","body":' + ("Change ``src/fixture-49.js``." | ConvertTo-Json) + ',"createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]')
  # ticket 455 (ruling): every value launch.ps1 refuses from the manifest alone is refused by assign too. The base cases
  # (launch.ps1's invalid base precondition: a remote, a ref and a 40-hex sha) pass --fixture, which takes the base as given.
  $noDefault = "$testRoot\tenants\nodefault.json"
  Write-Utf8 $noDefault ('{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","branchPrefix":"fleet/","maxIcs":2,"repo":' + ($repoPath | ConvertTo-Json) + '}')
  $testTenant = "$testRoot\tenants\test.json"
  foreach ($bad in @(
      @{ Label = '--model deepseek'; Expect = 'Haiku 5\.5 only'; Args = @('--tenant-config', $testTenant, '--base-sha', $baseSha, '--model', 'deepseek') },
      @{ Label = '--effort high'; Expect = 'xhigh or max'; Args = @('--tenant-config', $testTenant, '--base-sha', $baseSha, '--effort', 'high') },
      @{ Label = '--permissions bogus'; Expect = 'unknown permission profile'; Args = @('--tenant-config', $testTenant, '--base-sha', $baseSha, '--permissions', 'bogus') },
      @{ Label = '--base-sha bbb (not 40 hex)'; Expect = 'invalid base precondition'; Args = @('--tenant-config', $testTenant, '--base-sha', 'bbb') },
      @{ Label = 'a tenant with no defaultBranch (no ref)'; Expect = 'invalid base precondition'; Args = @('--tenant-config', $noDefault, '--base-sha', $baseSha) }
    )) {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $badOut = & node "$testRoot\bin\assignment.js" assign --root $testRoot --tenant test --fixture $fixture49 --parent pl-test @($bad.Args) 2>&1 | Out-String; $badCode = $LASTEXITCODE }
    finally { $ErrorActionPreference = $eap }
    Assert-True ($badCode -ne 0 -and $badOut -match $bad.Expect -and $null -eq (Get-RecordState 49) -and @(Get-ChildItem "$testRoot\state\manifests" -Filter '*issue-49*' -ErrorAction SilentlyContinue).Count -eq 0) "assign refuses $($bad.Label) before any reservation exists, naming it (exit $badCode): $badOut"
  }

  # ticket 455: a worktree that existed before this launch is not this launch's to remove: the launch refuses at its
  # existence check (exit 4) and removes nothing.
  Clear-ActiveRecords
  $m50 = Reserve-Manifest 50 $baseSha
  $existing50 = "$repoPath\.claude\worktrees\ic-50-assignment"
  [IO.Directory]::CreateDirectory($existing50) | Out-Null
  Write-Utf8 "$existing50\earlier.txt" 'an earlier launch'
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  [void](Run-Launch @('-Manifest', $m50, '-WorkRecordId', 'test:issue-50'))
  Assert-True ($lastExit -eq 4 -and $lastFlat -match 'assignmentworktreealreadyexists' -and (Test-Path "$existing50\earlier.txt") -and (Get-RecordState 50) -eq 'assigned' -and -not (Get-Marker $m50) -and (Get-BgCalls) -eq 0) "a worktree that existed before the launch is refused and left alone (exit $lastExit): $lastOut"
  Remove-Item -LiteralPath $existing50 -Recurse -Force

  # ticket 455 review: a worktree add that exits non-zero but leaves the worktree and its branch behind (a failing post-checkout
  # hook) is cleaned up: the worktree and the branch are gone and the reservation is released. A fresh reservation for the
  # issue is then not refused for an existing worktree.
  Clear-ActiveRecords
  $m51 = Reserve-Manifest 51 $baseSha
  $hook51 = "$repoPath\.git\hooks\post-checkout"
  Write-Utf8 $hook51 "#!/bin/sh`nexit 1`n"
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  [void](Run-Launch @('-Manifest', $m51, '-WorkRecordId', 'test:issue-51'))
  $wt51 = "$repoPath\.claude\worktrees\ic-51-assignment"
  $branches51 = Invoke-Git @('branch', '--list', 'fleet/*51*')
  $worktrees51 = Invoke-Git @('worktree', 'list', '--porcelain')
  Assert-True ($lastExit -eq 4 -and -not (Test-Path $wt51) -and -not $branches51 -and $worktrees51 -notmatch 'ic-51-assignment' -and (Get-RecordState 51) -ne 'assigned' -and [bool](Get-Marker $m51)) "a worktree add that fails after creating the worktree leaves neither the worktree nor the branch behind (exit $lastExit): $lastOut"
  Remove-Item $hook51 -ErrorAction SilentlyContinue
  $m51b = Reserve-Manifest 51 $baseSha
  $env:MOCK_BG_ROW = '1'
  try { $r51 = Run-Launch @('-Manifest', $m51b, '-WorkRecordId', 'test:issue-51') } finally { Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 0 -and $r51 -and $r51.launched -eq $true -and $lastFlat -notmatch 'assignmentworktreealreadyexists') "a fresh reservation for the issue is not refused for an existing worktree (exit $lastExit): $lastOut"
  Invoke-Git @('worktree', 'remove', '--force', $wt51)
  foreach ($leftover in @(Invoke-Git @('branch', '--list', 'fleet/*51*') -split [char]10 | ForEach-Object { $_.Trim().TrimStart('*').Trim() } | Where-Object { $_ })) { Invoke-Git @('branch', '-D', $leftover) }
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # fleet #437: the launch door starts only the manifest its Work record was reserved with. A byte copy of a reserved
  # manifest at another path is refused by the early check (no release, no marker, no claude --bg), and the real
  # manifest for the same record still passes the record checks (a dry run reaches its success output).
  Clear-ActiveRecords
  $m36 = Reserve-Manifest 36 $baseSha
  $copy36 = "$testRoot\copy-36.json"
  Copy-Item $m36 $copy36
  $revision36 = (Get-Record 36).revision
  Remove-Item "$testRoot\claude-calls.log", "$testRoot\gh-calls.log" -ErrorAction SilentlyContinue
  [void](Run-Launch @('-Manifest', $copy36, '-WorkRecordId', 'test:issue-36'))
  Assert-True ($lastExit -eq 4 -and $lastFlat -match 'wasnotreservedwithmanifest') "a copy of a reserved manifest is refused by the early check (exit 4, naming the reservation): exit $lastExit $lastOut"
  Assert-True ((Get-RecordState 36) -eq 'assigned' -and (Get-Record 36).revision -eq $revision36 -and -not (Get-Marker $copy36) -and -not (Get-Marker $m36)) 'the copy refusal leaves the record assigned at its revision, with no marker on either file'
  Assert-True ((Get-BgCalls) -eq 0) 'a copy of a reserved manifest never reaches claude --bg'
  Assert-True (-not (Test-Path "$testRoot\gh-calls.log")) 'the early check refuses before any gh call'
  Assert-True (-not (Test-Path "$repoPath\.claude\worktrees\ic-36-assignment") -and -not (Invoke-Git @('branch', '--list', 'fleet/*36*'))) 'the early check creates no worktree and no branch'
  $r36 = Run-Launch @('-Manifest', $m36, '-WorkRecordId', 'test:issue-36', '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r36 -and $r36.dryRun -eq $true) "the real manifest for the same record passes the record checks: exit $lastExit $lastOut"

  # fleet #437: a hand-written manifest for a record reserved with NO manifest, carrying no tenant, parent or issue, is
  # refused at the door by the record check, not by the tenant check: no release, the record stays assigned, no marker, no claude --bg.
  Clear-ActiveRecords
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $bareOut = & node "$testRoot\bin\work-state.js" reserve --root $testRoot --id test:issue-37 --tenant test --issue 37 --idempotency-key reserve-37 2>&1 | Out-String; $bareCode = $LASTEXITCODE }
  finally { $ErrorActionPreference = $eap }
  Assert-True ($bareCode -eq 0) "fixture: the record for issue 37 is reserved with no manifest: $bareOut"
  $rev37 = (Get-Record 37).revision
  Assert-True (-not (Get-Record 37).manifestPath) 'fixture: the record names no manifest'
  $hand37 = "$testRoot\state\manifests\hand-37.json"
  Write-Utf8 $hand37 ('{"schemaVersion":1,"id":"hand-37","status":"pending-ack","workRecordId":"test:issue-37","workRecordRevision":' + $rev37 + '}')
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  [void](Run-Launch @('-Manifest', $hand37, '-WorkRecordId', 'test:issue-37'))
  Assert-True ($lastExit -eq 4 -and $lastFlat -match 'wasnotreservedwithmanifest') "a hand-written manifest for a record reserved with no manifest is refused naming the reservation: exit $lastExit $lastOut"
  Assert-True ((Get-RecordState 37) -eq 'assigned' -and (Get-Record 37).revision -eq $rev37 -and -not (Get-Marker $hand37)) 'the hand-written refusal releases nothing and writes no marker'
  Assert-True ((Get-BgCalls) -eq 0) 'a hand-written manifest never reaches claude --bg'

  # Case 11: the control. With nothing changed in the window the same launch reaches `claude --bg` (the
  # mock claude starts no session, so it then fails as it always did): the re-check does not refuse every launch.
  Clear-ActiveRecords
  $m30 = Reserve-Manifest 30 $baseSha
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  [void](Run-Launch @('-Manifest', $m30, '-WorkRecordId', 'test:issue-30'))
  Assert-True ((Get-BgCalls) -eq 1) "control: an untouched reservation still reaches claude --bg: $lastOut"
  # fleet #384: the real background launch carries --no-chrome (the mock claude logs its argv).
  Assert-True (@(Get-Content "$testRoot\claude-calls.log" | Where-Object { $_ -match '^--bg ' -and $_ -match ' --no-chrome(\s|$)' }).Count -eq 1) 'the claude --bg call must carry --no-chrome'
  # ticket 455: no session appears within the wait and the one read of the list after it finds none, so the launch
  # releases the reservation and removes the worktree it created, as it always has.
  Assert-True ($lastExit -eq 5 -and (Get-RecordState 30) -ne 'assigned' -and [bool](Get-Marker $m30) -and -not (Test-Path "$repoPath\.claude\worktrees\ic-30-assignment")) "a launch whose session never registers is released and its worktree removed (exit $lastExit): $lastOut"

  # ticket 455: a session that registers after the wait (only the launch's late read sees it) is adopted: the launch
  # rosters it and keeps the reservation and the worktree, exactly as if it had appeared in time.
  Clear-ActiveRecords
  $m45 = Reserve-Manifest 45 $baseSha
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $env:MOCK_LATE_ROW = '1'
  try { $r45 = Run-Launch @('-Manifest', $m45, '-WorkRecordId', 'test:issue-45') } finally { Remove-Item Env:MOCK_LATE_ROW -ErrorAction SilentlyContinue }
  $rows45 = @((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'ic-45' -and $_.status -eq 'active' })
  Assert-True ($lastExit -eq 0 -and $r45 -and $r45.launched -eq $true -and $rows45.Count -eq 1 -and "$($rows45[0].jobId)" -eq 'job-late-ic-45') "a session that registers after the wait is adopted and rostered (exit $lastExit): $lastOut"
  Assert-True ((Get-RecordState 45) -eq 'assigned' -and -not (Get-Marker $m45) -and (Test-Path "$repoPath\.claude\worktrees\ic-45-assignment")) 'the adopted launch keeps its reservation and its worktree, and writes no marker'

  # ticket 455: an adopted session whose roster row cannot be written is stopped, then released like a launch with no session.
  Clear-ActiveRecords
  $m46 = Reserve-Manifest 46 $baseSha
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $rosterFile = "$testRoot\state\roster.json"
  $rosterBefore = Get-Content $rosterFile -Raw
  $env:MOCK_LATE_ROW = '1'
  [IO.File]::SetAttributes($rosterFile, [IO.FileAttributes]::ReadOnly)
  try { [void](Run-Launch @('-Manifest', $m46, '-WorkRecordId', 'test:issue-46')) }
  finally { Remove-Item Env:MOCK_LATE_ROW -ErrorAction SilentlyContinue; [IO.File]::SetAttributes($rosterFile, [IO.FileAttributes]::Normal) }
  Assert-True ($lastExit -eq 5 -and $lastFlat -match 'therosterwritefortheadoptedsession') "an adopted session whose roster write fails exits 5 naming it: exit $lastExit $lastOut"
  Assert-True (@(Get-Content "$testRoot\claude-calls.log" | Where-Object { $_ -eq 'stop job-late-ic-46' }).Count -eq 1) 'an adopted session that cannot be rostered is stopped (claude stop <job>)'
  Assert-True ((Get-RecordState 46) -ne 'assigned' -and "$((Get-Marker $m46).reason)" -match 'roster write') "the adopted session's reservation is released, the marker naming the roster write: $(Get-Marker $m46 | ConvertTo-Json -Compress)"
  Assert-True (-not (Test-Path "$repoPath\.claude\worktrees\ic-46-assignment") -and (Get-Content $rosterFile -Raw) -eq $rosterBefore) 'the released adopted launch removes its worktree and leaves the roster as it was'

  # ticket 455 review: a claude stop that does not succeed keeps the adopted session's reservation and worktree, since the
  # session may still run in that worktree. Nothing is released, and the JSON and the refusal text say so.
  Clear-ActiveRecords
  $m56 = Reserve-Manifest 56 $baseSha
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $rosterBefore56 = Get-Content $rosterFile -Raw
  $env:MOCK_LATE_ROW = '1'
  $env:MOCK_STOP_FAIL = '1'
  [IO.File]::SetAttributes($rosterFile, [IO.FileAttributes]::ReadOnly)
  try { $r56 = Run-Launch @('-Manifest', $m56, '-WorkRecordId', 'test:issue-56') }
  finally { Remove-Item Env:MOCK_LATE_ROW, Env:MOCK_STOP_FAIL -ErrorAction SilentlyContinue; [IO.File]::SetAttributes($rosterFile, [IO.FileAttributes]::Normal) }
  Assert-True ($lastExit -eq 5 -and $r56 -and $r56.sessionStopFailed -eq $true -and "$($r56.jobId)" -eq 'job-late-ic-56' -and $r56.reservationReleased -eq $false -and $r56.worktreeKept -eq $true) "a stop that does not succeed is named and keeps the reservation and the worktree (exit $lastExit): $lastOut"
  Assert-True ($lastFlat -match 'claudestopjob-late-ic-56didnotsucceed') "the refusal text names the failed stop and its job: $lastOut"
  Assert-True ((Get-RecordState 56) -eq 'assigned' -and -not (Get-Marker $m56) -and (Test-Path "$repoPath\.claude\worktrees\ic-56-assignment") -and (Get-Content $rosterFile -Raw) -eq $rosterBefore56) 'the kept launch writes no marker, releases nothing, and leaves the roster as it was'
  Invoke-Git @('worktree', 'remove', '--force', "$repoPath\.claude\worktrees\ic-56-assignment")
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # ticket 455: a list read after the wait that fails cannot show that no session exists, so the launch keeps the
  # reservation and the worktree and releases nothing; the stranded-reservation sweep owns it from here.
  Clear-ActiveRecords
  $m47 = Reserve-Manifest 47 $baseSha
  Remove-Item "$testRoot\claude-calls.log" -ErrorAction SilentlyContinue
  $env:MOCK_LATE_ROW = 'fail'
  try { $r47 = Run-Launch @('-Manifest', $m47, '-WorkRecordId', 'test:issue-47') } finally { Remove-Item Env:MOCK_LATE_ROW -ErrorAction SilentlyContinue }
  Assert-True ($lastExit -eq 5 -and $r47 -and $r47.sessionListUnreadable -eq $true -and $r47.reservationReleased -eq $false) "an unreadable list after the wait is named and releases nothing (exit $lastExit): $lastOut"
  Assert-True ((Get-RecordState 47) -eq 'assigned' -and -not (Get-Marker $m47) -and (Test-Path "$repoPath\.claude\worktrees\ic-47-assignment")) 'the unreadable launch keeps the record assigned, its worktree, and writes no marker'
  # The adopted and unreadable launches above leave daemon rows and roster rows that later cases must not count.
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Remove-Item "$testRoot\late-row.json" -ErrorAction SilentlyContinue


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

  # fleet #434 (ruling 3): a recovered allowlist IC goes through the CLI rehearsal gate, and a refusal there releases nothing.
  # The fixture's rehearsalRoot skips the gate, so this step drops it and names a verified CLI version the mock does not report.
  $gateRowBefore = (@((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'ic-40' -and $_.status -eq 'active' })[0] | ConvertTo-Json -Compress)
  $gateRecordBefore = Get-Record 40
  Write-Utf8 "$testRoot\config\permissions-allowlist.json" '{"verifiedCliVersion":"2.1.312","defaultMode":"acceptEdits","allow":[{"rule":"Bash(git status)"}]}'
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $env:MOCK_BG_ROW = '1'
  try { $gate1 = Run-Launch $recoverArgs } finally {
    Remove-Item Env:MOCK_BG_ROW -ErrorAction SilentlyContinue
    Write-Utf8 "$testRoot\config\permissions-allowlist.json" '{"rehearsalRoot":true,"defaultMode":"acceptEdits","allow":[{"rule":"Bash(git status)"}]}'
  }
  Assert-True ($lastExit -eq 3 -and $gate1 -and $gate1.launched -eq $false -and "$($gate1.reason)" -match 'allowlist profile was verified on Claude Code 2.1.312' -and $gate1.reservationReleased -eq $false) "fleet #434: a recovery of an allowlist IC is refused by the CLI rehearsal gate with nothing released: exit $lastExit $lastOut"
  Assert-True (-not (Test-Path "$($oldRow.manifest).invalidated.json")) 'fleet #434: the gate refusal writes no invalidation marker beside the manifest'
  $gateRowAfter = (@((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions | Where-Object { $_.name -eq 'ic-40' -and $_.status -eq 'active' })[0] | ConvertTo-Json -Compress)
  Assert-True ($gateRowAfter -eq $gateRowBefore) "fleet #434: the gate refusal leaves the roster row unchanged: $gateRowAfter"
  $gateRecordAfter = Get-Record 40
  Assert-True ("$($gateRecordAfter.state)" -eq "$($gateRecordBefore.state)" -and [string]$gateRecordAfter.revision -eq [string]$gateRecordBefore.revision) 'fleet #434: the gate refusal leaves the Work record state and revision unchanged'

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
