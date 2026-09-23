# Ticket 89 (QA review): tests/launch-projection.tests.ps1 was deleted along with the
# retired legacy -Prompt IC path, but the code it covered is still alive - launch.ps1
# calls `work-state.js shadow` after every IC launch (manifest or not) and reports the
# result as `projected` in its JSON. Restored here, re-pointed at a real -Manifest
# launch (see tests/assignment-cutover.tests.ps1 and launch-body-hash for the manifest
# fixture pattern): a real local git repo (fetch + worktree add), a `gh` mock matching
# the manifest's body/criteria hashes, and a mock `claude` that produces a daemon row
# for the launched name, so the launch really succeeds end to end.
#
# The assertion itself had to change, not just its trigger. A LEGACY launch had no
# reservation until the projector made one (that race is exactly what ticket 89's
# predecessor closed: the projector's `shadow-projected` event WAS the reservation). A
# MANIFEST launch is reserved before launch.ps1 ever runs (assignment.js assign /
# work-state.js reserve), so by the time the projector looks, the record already exists -
# per its own code (bin/work-state.js shadowProject: `if (active.records[id]) { ...;
# continue; }`) and per the comment beside the call in launch.ps1 ("A manifest launch is
# already reserved by assignment.js assign, and the projection leaves that record
# alone"), it appends NO event for an already-reserved record. The real assertions kept
# from the original suite: the launch result reports `projected: true` (the projector
# really ran), the reservation is left intact with no double event, and a control-plane
# launch neither reports a projection nor appends any Work event.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Get-Sha256Hex { param([string]$Text) [BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant() }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-launch-projection-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Run-Launch {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $testRoot
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; Pop-Location }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}
function Get-ActiveRecords {
  $p = "$testRoot\state\work\active.json"
  if (-not (Test-Path $p)) { return $null }
  return ((Get-Content $p -Raw) | ConvertFrom-Json).records
}
function Get-EventCount { @(Get-ChildItem "$testRoot\state\events" -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ }).Count }

try {
  foreach ($dir in 'bin','hooks','agents','tenants','config','state','state/sessions','state/notices','state/work','state/events','state/flags','state/manifests','mock-bin','repo') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1','work-state.js','assignment.js','exclusions.js','notify.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: sonnet`neffort: low`n---`nRole body for ic."
  Write-Utf8 "$testRoot\agents\project-lead.md" "---`nname: project-lead`nmodel: sonnet`neffort: low`n---`nRole body for project-lead."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $repoPath = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","defaultBranch":"integration","branchPrefix":"fleet/","maxIcs":2,"repo":' + ($repoPath | ConvertTo-Json) + '}')

  # A real local git repo: a non-dry-run manifest launch fetches origin/<ref> and creates
  # the assignment worktree from the resolved SHA, for real.
  & git init -q -b integration $repoPath 2>&1 | Out-Null
  & git -C $repoPath config user.email 'test@example.com' 2>&1 | Out-Null
  & git -C $repoPath config user.name 'Fleet Test' 2>&1 | Out-Null
  Write-Utf8 "$repoPath\README.md" 'fixture'
  & git -C $repoPath add -A 2>&1 | Out-Null
  & git -C $repoPath commit -q -m init 2>&1 | Out-Null
  & git -C $repoPath remote add origin $repoPath 2>&1 | Out-Null
  $baseSha = (& git -C $repoPath rev-parse HEAD | Out-String).Trim()

  # A non-dry-run manifest launch reconciles against a real `gh issue view`, so the mock's
  # body must match the manifest's recorded hashes exactly.
  $body = 'Change `src/fixture.js`.'
  $bodyHash = Get-Sha256Hex $body
  Write-Utf8 "$testRoot\mock-bin\mock-gh.js" ('process.stdout.write(JSON.stringify({ state: ' + "'OPEN'" + ', body: ' + ($body | ConvertTo-Json) + ', comments: [] }));')
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'node "%~dp0mock-gh.js" %*' + "`r`n" + 'exit /b %errorlevel%' + "`r`n")

  # The manifest and its reservation, as `assignment.js assign` would leave them.
  $manifestPath = "$testRoot\state\manifests\assignment-test-101.json"
  $manifest = [ordered]@{
    schemaVersion = 1; status = 'pending-ack'; id = 'assignment-test-101'; workRecordId = 'test:issue-101'; workRecordRevision = 1
    issue = [ordered]@{ number = 101; bodyHash = $bodyHash; criteriaHash = $bodyHash; commentCount = 0 }
    base = [ordered]@{ remote = 'origin'; ref = 'integration'; sha = $baseSha }
    branch = 'fleet/101-fixture'; tenant = 'test'; parent = 'pl-test'; model = 'sonnet'
  }
  Write-Utf8 $manifestPath ($manifest | ConvertTo-Json -Depth 8)
  $null = & node "$testRoot\bin\work-state.js" reserve --root $testRoot --id test:issue-101 --tenant test --issue 101 --manifest $manifestPath --idempotency-key reserve-101
  if ($LASTEXITCODE -ne 0) { throw 'fixture reservation failed' }

  # The mock daemon: empty until a --bg call, then one row for ic-101 so the launch's
  # poll finds its session and the roster entry is written.
  Write-Utf8 "$testRoot\mock-agents.json" '[]'
  Write-Utf8 "$testRoot\mock-agents-after-launch.json" '[{"id":"job-101","name":"ic-101","state":"working","status":"idle","pid":21,"sessionId":"sess-101","startedAt":1756000000000}]'
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" +
    'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" +
    'if "%1"=="--bg" copy /y "' + $testRoot + '\mock-agents-after-launch.json" "' + $testRoot + '\mock-agents.json" >nul' + "`r`n" +
    'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs") | Out-Null

  # Case 1: a real manifest launch succeeds and runs the shadow projector.
  Assert-True ($null -ne (Get-ActiveRecords) -and $null -ne (Get-ActiveRecords).PSObject.Properties['test:issue-101']) 'the reservation must exist before the launch'
  $beforeLaunch = Get-EventCount
  $r1 = Run-Launch @('-Manifest', $manifestPath)
  Assert-True ($lastExit -eq 0 -and $r1.launched -eq $true) "the manifest launch must succeed: $lastOut"
  Assert-True ($r1.projected -eq $true) "the launch result must report that it ran the projector: $lastOut"
  $records = Get-ActiveRecords
  Assert-True ($null -ne $records -and $null -ne $records.PSObject.Properties['test:issue-101']) "the launch must leave the reserved Work record in place: $lastOut"

  # Case 2: the projector found the record already reserved and left it alone. A manifest
  # launch is already reserved (unlike the retired legacy path), so the real assertion here
  # is that the projector is a safe no-op for it, not a second reservation or a duplicate
  # event: exactly the one event `work-state.js reserve` wrote before the launch.
  $afterLaunch = Get-EventCount
  Assert-True ($afterLaunch -eq $beforeLaunch) "the projector must append no event for an already-reserved record: before=$beforeLaunch after=$afterLaunch"

  # Case 3: a control-plane launch projects nothing (the projection is about IC units).
  Write-Utf8 "$testRoot\mock-agents-after-launch.json" '[{"id":"job-101","name":"ic-101","state":"working","status":"idle","pid":21,"sessionId":"sess-101","startedAt":1756000000000},{"id":"job-pl","name":"pl-test","state":"working","status":"idle","pid":22,"sessionId":"sess-pl","startedAt":1756000002000}]'
  $before3 = Get-EventCount
  $r3 = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead')
  Assert-True ($lastExit -eq 0 -and $r3.launched -eq $true) "the lead launch must succeed: $lastOut"
  Assert-True ($null -eq $r3.projected -or $r3.projected -eq $false) 'a control-plane launch must not report a projection'
  $after3 = Get-EventCount
  Assert-True ($after3 -eq $before3) 'a control-plane launch must append no Work event'

  Write-Output 'launch projection tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-projection-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    # A real `git worktree add` leaves metadata under repo\.git\worktrees\<name> that can
    # hold the assignment worktree directory locked on Windows; ask git to drop it first.
    try { & git -C "$resolved\repo" worktree remove --force "$resolved\repo\.claude\worktrees\ic-101-assignment" 2>&1 | Out-Null } catch {}
    try { & git -C "$resolved\repo" worktree prune 2>&1 | Out-Null } catch {}
    try { [IO.Directory]::Delete($resolved, $true) } catch { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
