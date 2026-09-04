# 02/03 cutover: the project lead's Stop hook against a fixture fleet with mock `gh` and
# `claude`. Without the flag the hook decides from its legacy frontier and records the
# planner beside it; with the flag it decides from the planner, and a planner failure
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
function Get-ShadowLines { @(Get-ChildItem "$testRoot\state\assignment\shadow" -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) }

try {
  foreach ($dir in 'bin','hooks','tenants','config','state','state/heartbeats','state/continue','state/skip','state/escalations','state/work','state/events','state/flags','state/notices','state/exclusions','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','check-policy.ps1','assignment.js','assignment-parity.js','work-state.js','exclusions.js','notify.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  foreach ($f in 'stop.ps1','session-start.ps1') { [IO.File]::Copy("$sourceRoot\hooks\$f", "$testRoot\hooks\$f") }
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Write-Utf8 "$testRoot\tenants\test.json" '{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","defaultBranch":"integration","branchPrefix":"fleet/","maxIcs":2,"ciGates":["test-build"],"watchedChecks":[],"ignoredChecks":[],"repo":"C:/nowhere"}'
  Write-Utf8 "$testRoot\gh-pr.json" '[]'
  Write-Utf8 "$testRoot\gh-issue.json" '[{"number":101}]'
  Write-Utf8 "$testRoot\gh-deps.json" '[{"number":101,"issue_dependencies_summary":{"blocked_by":0}}]'
  Write-Utf8 "$testRoot\gh-graphql.json" '{"data":{"repository":{"issues":{"nodes":[{"number":101,"title":"Fixture","url":"https://github.com/owner/repo/issues/101","body":"criteria","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":{"nodes":[{"name":"ready-for-agent"}]},"assignees":{"nodes":[]},"blockedBy":{"nodes":[],"pageInfo":{"hasNextPage":false}},"subIssues":{"nodes":[],"pageInfo":{"hasNextPage":false}}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}'
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" +
    'if "%1"=="pr" type "' + $testRoot + '\gh-pr.json"' + "`r`n" +
    'if "%1"=="issue" type "' + $testRoot + '\gh-issue.json"' + "`r`n" +
    'if "%1"=="api" (if "%2"=="graphql" (type "' + $testRoot + '\gh-graphql.json") else (type "' + $testRoot + '\gh-deps.json"))' + "`r`n" +
    'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue
  # The planner runs under Node, which cannot execute the gh.cmd mock; it reads the same issue as a fixture.
  Write-Utf8 "$testRoot\issues-fixture.json" '[{"number":101,"title":"Fixture","url":"https://github.com/owner/repo/issues/101","body":"criteria","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  $env:FLEET_GITHUB_ISSUES_FIXTURE = "$testRoot\issues-fixture.json"

  # Case 1: no flag -> the legacy frontier decides; the planner is recorded beside it, agreeing.
  $out1 = Run-Stop
  Assert-True ($lastExit -eq 2 -and $out1 -match 'frontier issue\(s\) #101') "without the flag the hook must continue on the legacy frontier: exit $lastExit :: $out1"
  $lines1 = @(Get-ShadowLines)
  Assert-True ($lines1.Count -eq 1 -and $lines1[0].mode -eq 'shadow' -and $lines1[0].agree -eq $true -and @($lines1[0].hook.frontier) -contains 101 -and @($lines1[0].planner.frontier) -contains 101) "the hook must record one agreeing shadow evaluation: $($lines1 | ConvertTo-Json -Compress)"

  # Case 2: the flag stands -> the planner's frontier decides and the lead is pointed at assignment.js.
  Write-Utf8 "$testRoot\state\flags\assignment-live" 'test'
  $out2 = Run-Stop
  Assert-True ($lastExit -eq 2 -and $out2 -match 'assignment frontier #101' -and $out2 -match 'assignment\.js assign') "under the flag the hook must continue on the planner frontier: exit $lastExit :: $out2"
  $lines2 = @(Get-ShadowLines)
  Assert-True ($lines2.Count -eq 2 -and $lines2[1].mode -eq 'live') 'the live evaluation must be recorded as live'

  # Case 3: the flag stands and the planner cannot run -> nothing launches, one escalation is filed, once.
  $env:FLEET_NODE_PATH = "$testRoot\no-such-node.exe"
  $out3 = Run-Stop
  Assert-True ($lastExit -eq 0) "a planner failure under the flag must stop the lead (exit $lastExit): $out3"
  Assert-True ((Get-Continue).stoppedBecause -match 'planner') 'the stop reason must name the planner'
  $esc = @(Get-ChildItem "$testRoot\state\escalations" -Filter *.json)
  Assert-True ($esc.Count -eq 1 -and ((Get-Content $esc[0].FullName -Raw) | ConvertFrom-Json).kind -eq 'assignment-planner-failed') 'a planner failure under the flag must file one escalation'
  $null = Run-Stop
  Assert-True (@(Get-ChildItem "$testRoot\state\escalations" -Filter *.json).Count -eq 1) 'a repeated planner failure must not file a second escalation'
  Assert-True (@(Get-ShadowLines).Count -eq 2) 'a planner that could not run records no evaluation'

  # Case 4: no flag and no planner -> the legacy frontier still decides (the shadow observation is best effort).
  Remove-Item "$testRoot\state\flags\assignment-live"
  $out4 = Run-Stop
  Assert-True ($lastExit -eq 2 -and $out4 -match 'frontier issue\(s\) #101') "without the flag a missing planner must not block the legacy frontier: exit $lastExit :: $out4"
  Remove-Item Env:FLEET_NODE_PATH

  # Case 5: the session-start hook prints the acknowledgment command with the record's current revision.
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"test:issue-101":{"id":"test:issue-101","state":"assigned","revision":3}}}'
  Write-Utf8 "$testRoot\state\manifests-x.json" '{}'
  $env:FLEET_NAME = 'ic-101'; $env:FLEET_ROLE = 'ic'; $env:FLEET_ISSUE = '101'; $env:FLEET_ASSIGNMENT_MANIFEST = "$testRoot\state\manifests-x.json"; $env:FLEET_WORK_RECORD_ID = 'test:issue-101'; $env:FLEET_BASE_SHA = ('a' * 40); $env:FLEET_ASSIGNMENT_BRANCH = 'fleet/101-fixture'
  $start = ('' | & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\hooks\session-start.ps1" 2>&1 | Out-String)
  Assert-True ($start -match 'Assignment manifest:' -and $start -match 'assignment\.js ack --root' -and $start -match '--expected-revision 3') "the session-start hook must print the acknowledgment with revision 3: $start"

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
