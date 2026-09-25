# Ticket 89 (ADR 0006, after one release): the project lead's Stop hook against a fixture
# fleet with mock `gh` and `claude`. The hook decides from the assignment planner alone,
# unconditionally - the legacy frontier and the parity observation it used to record
# beside the planner's answer are retired for good, no flag involved. A planner failure
# launches nothing and files one escalation. The session-start hook prints the
# acknowledgment command with the record's current revision for a manifest-launched IC.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-stop-hook-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$saved = @{}
foreach ($k in 'FLEET_HOME','FLEET_NAME','FLEET_ROLE','FLEET_TENANT','FLEET_PARENT','FLEET_NODE_PATH','FLEET_ISSUE','FLEET_ASSIGNMENT_MANIFEST','FLEET_WORK_RECORD_ID','FLEET_BASE_SHA','FLEET_ASSIGNMENT_BRANCH','FLEET_GITHUB_ISSUES_FIXTURE') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }

function Run-Stop {
  $env:FLEET_HOME = $testRoot; $env:FLEET_NAME = 'pl-test'; $env:FLEET_ROLE = 'project-lead'; $env:FLEET_TENANT = 'test'; $env:FLEET_PARENT = 'dispatcher'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $testRoot
  try { $out = ('{"session_id":"s-test"}' | & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\hooks\stop.ps1" 2>&1 | Out-String) }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; Pop-Location }
  # Out-String wraps long stderr lines at console width; compare on one line.
  $out = ($out -replace '\s+', ' ')
  $script:lastOut = $out
  return $out
}
function Get-Continue { (Get-Content "$testRoot\state\continue\pl-test.json" -Raw) | ConvertFrom-Json }

try {
  foreach ($dir in 'bin','hooks','tenants','config','state','state/heartbeats','state/continue','state/skip','state/escalations','state/work','state/events','state/flags','state/notices','state/exclusions','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','identity.js','check-policy.ps1','assignment.js','premises.js','work-state.js','exclusions.js','notify.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  foreach ($f in 'stop.ps1','session-start.ps1') { [IO.File]::Copy("$sourceRoot\hooks\$f", "$testRoot\hooks\$f") }
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Write-Utf8 "$testRoot\tenants\test.json" '{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","defaultBranch":"integration","branchPrefix":"fleet/","maxIcs":2,"ciGates":["test-build"],"watchedChecks":[],"ignoredChecks":[],"repo":"C:/nowhere"}'
  Write-Utf8 "$testRoot\gh-pr.json" '[]'
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" +
    'if "%1"=="pr" type "' + $testRoot + '\gh-pr.json"' + "`r`n" +
    'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue
  # The planner runs under Node, which cannot execute the gh.cmd mock; it reads the same issue as a fixture.
  Write-Utf8 "$testRoot\issues-fixture.json" '[{"number":101,"title":"Fixture","url":"https://github.com/owner/repo/issues/101","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  $env:FLEET_GITHUB_ISSUES_FIXTURE = "$testRoot\issues-fixture.json"

  # Case 1: the hook continues on the assignment frontier unconditionally, no flag needed.
  $out1 = Run-Stop
  Assert-True ($lastExit -eq 2 -and $out1 -match 'assignment frontier #101' -and $out1 -match 'assignment\.js assign') "the hook must continue on the assignment frontier: exit $lastExit :: $out1"

  # Case 2: the planner cannot run -> nothing launches, one escalation is filed, once (fail closed;
  # there is no legacy frontier left to fall back to).
  $env:FLEET_NODE_PATH = "$testRoot\no-such-node.exe"
  $out2 = Run-Stop
  Assert-True ($lastExit -eq 0) "a planner failure must stop the lead (exit $lastExit): $out2"
  Assert-True ((Get-Continue).stoppedBecause -match 'planner') 'the stop reason must name the planner'
  $esc = @(Get-ChildItem "$testRoot\state\escalations" -Filter *.json)
  Assert-True ($esc.Count -eq 1 -and ((Get-Content $esc[0].FullName -Raw) | ConvertFrom-Json).kind -eq 'assignment-planner-failed') 'a planner failure must file one escalation'
  $null = Run-Stop
  Assert-True (@(Get-ChildItem "$testRoot\state\escalations" -Filter *.json).Count -eq 1) 'a repeated planner failure must not file a second escalation'
  Remove-Item Env:FLEET_NODE_PATH

  # Case 3: the planner is reachable again -> the assignment frontier decides as in Case 1.
  $out3 = Run-Stop
  Assert-True ($lastExit -eq 2 -and $out3 -match 'assignment frontier #101') "recovery: the hook must continue on the assignment frontier again: exit $lastExit :: $out3"

  # fleet#51: "CI settled" used to be read from live GitHub while `record --kind formal` reads
  # the Work record, which the watcher advances on a five-minute tick; the hook continued the
  # lead onto a PR the review gate then refused (INVALID_REVIEW_STATE). A PR awaits review only
  # when its Work record is in `review`; a green PR whose record lags is named, not actioned.
  Write-Utf8 "$testRoot\gh-pr.json" '[{"number":7,"isDraft":false,"headRefName":"fleet/101-fixture","statusCheckRollup":[{"name":"test-build","status":"COMPLETED","conclusion":"SUCCESS"}]}]'
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test:issue-101":{"id":"test:issue-101","state":"ci-wait","revision":6,"github":{"issueNumber":101,"prNumber":7}}}}'
  $out51a = Run-Stop
  Assert-True ($out51a -notmatch 'awaiting your review') "a green PR whose Work record is still ci-wait must not be offered for review: $out51a"
  Assert-True ($out51a -match 'record still ci-wait' -and $out51a -match '#7') "the hook must name the lagging PR and its record state: $out51a"
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test:issue-101":{"id":"test:issue-101","state":"review","revision":8,"github":{"issueNumber":101,"prNumber":7}}}}'
  $out51b = Run-Stop
  Assert-True ($lastExit -eq 2 -and $out51b -match 'awaiting your review with CI settled: #7') "a PR whose Work record is in review is awaiting review: exit $lastExit :: $out51b"
  # Under state/flags/pr-watch-off the records do not advance, so the live GitHub verdict decides again.
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test:issue-101":{"id":"test:issue-101","state":"ci-wait","revision":6,"github":{"issueNumber":101,"prNumber":7}}}}'
  Write-Utf8 "$testRoot\state\flags\pr-watch-off" 'test'
  $out51c = Run-Stop
  Assert-True ($lastExit -eq 2 -and $out51c -match 'awaiting your review with CI settled: #7') "under pr-watch-off the live verdict must decide: exit $lastExit :: $out51c"
  Remove-Item "$testRoot\state\flags\pr-watch-off"
  # A PR with no Work record at all keeps the live verdict, labelled, so it is never invisible.
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{}}'
  $out51d = Run-Stop
  Assert-True ($lastExit -eq 2 -and $out51d -match 'awaiting your review with CI settled: #7' -and $out51d -match 'no Work record') "a PR without a Work record keeps the live verdict and says so: exit $lastExit :: $out51d"
  Write-Utf8 "$testRoot\gh-pr.json" '[]'

  # Case 5: the session-start hook prints the acknowledgment command with the record's current revision.
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test:issue-101":{"id":"test:issue-101","state":"assigned","revision":3}}}'
  Write-Utf8 "$testRoot\state\manifests-x.json" '{}'
  $env:FLEET_NAME = 'ic-101'; $env:FLEET_ROLE = 'ic'; $env:FLEET_ISSUE = '101'; $env:FLEET_ASSIGNMENT_MANIFEST = "$testRoot\state\manifests-x.json"; $env:FLEET_WORK_RECORD_ID = 'test:issue-101'; $env:FLEET_BASE_SHA = ('a' * 40); $env:FLEET_ASSIGNMENT_BRANCH = 'fleet/101-fixture'
  $start = ('' | & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\hooks\session-start.ps1" 2>&1 | Out-String)
  Assert-True ($start -match 'Assignment manifest:' -and $start -match 'assignment\.js ack --root' -and $start -match '--expected-revision 3') "the session-start hook must print the acknowledgment with revision 3: $start"
  # Regression (2026-09-11): ICs paste the printed command into the Bash tool (Git Bash), where an
  # unquoted backslash path collapses to C:UsersCory... and node fails with MODULE_NOT_FOUND. The
  # printed command must survive the shell it is pasted into: run it through bash against a stub.
  $ackCmd = ([regex]::Match($start, 'acknowledge it: (node \S+assignment\.js ack[^\r\n]*)')).Groups[1].Value
  Assert-True ([bool]$ackCmd) "the ack command must be extractable from the session-start line: $start"
  Assert-True ($ackCmd -notmatch '\\') "the ack command must not carry backslashes (they are eaten by the Bash tool): $ackCmd"
  Write-Utf8 "$testRoot\bin\assignment.js" 'console.log("ACK-STUB " + process.argv.slice(2).join(" "))'
  $bashExe = (Get-Command bash -ErrorAction SilentlyContinue).Source
  if ($bashExe) {
    $viaBash = (& $bashExe -c $ackCmd 2>&1 | Out-String)
    Assert-True ($viaBash -match 'ACK-STUB ack --root') "the ack command must run unchanged through bash: $viaBash"
  }

  Write-Output 'stop hook assignment tests passed'
} finally {
  $env:PATH = $oldPath
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-stop-hook-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
