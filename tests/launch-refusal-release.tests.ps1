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

  # gh: the issue read returns the body the planner hashed, or fails when MOCK_GH_FAIL=1.
  Write-Utf8 "$testRoot\mock-bin\mock-gh.js" ("'use strict';`nif (process.env.MOCK_GH_FAIL === '1') { process.stderr.write('gh: HTTP 502'); process.exit(1); }`nconst n = process.argv.find((a) => /^\d+$/.test(a)) || '0';`nprocess.stdout.write(JSON.stringify({ state: 'OPEN', body: 'Change ``src/fixture-' + n + '.js``.' }));`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ("@echo off`r`nnode `"%~dp0mock-gh.js`" %*`r`nexit /b %errorlevel%`r`n")
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:MOCK_GH_FAIL = '0'
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
  $doc = (Get-Content $m22 -Raw) | ConvertFrom-Json
  $doc.workRecordRevision = 99
  Write-Utf8 $m22 ($doc | ConvertTo-Json -Depth 20)
  [void](Run-Launch @('-Manifest', $m22, '-WorkRecordId', 'test:issue-22'))
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

  Write-Output 'launch refusal release tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_GH_FAIL -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-refusal-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500; try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
  }
}
