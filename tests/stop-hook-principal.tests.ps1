# ADR 0011 (fleet #38): the Principal's Stop hook continues the session while the triage
# frontier (bin/triage.js against a fixture) is non-empty, stops it when the frontier is
# empty, and stops it when the frontier cannot be read (fail closed, never "empty").
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-stop-hook-principal-test-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($k in 'FLEET_HOME','FLEET_NAME','FLEET_ROLE','FLEET_TENANT','FLEET_PARENT','FLEET_NODE_PATH','FLEET_TRIAGE_ISSUES_FIXTURE') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }

function Run-Stop {
  $env:FLEET_HOME = $testRoot; $env:FLEET_NAME = 'pe-test'; $env:FLEET_ROLE = 'principal'; $env:FLEET_TENANT = 'test'; $env:FLEET_PARENT = 'dispatcher'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $testRoot
  try { $out = ('{"session_id":"s-test"}' | & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\hooks\stop.ps1" 2>&1 | Out-String) }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; Pop-Location }
  $out = ($out -replace '\s+', ' ')
  $script:lastOut = $out
  return $out
}
function Get-Continue { (Get-Content "$testRoot\state\continue\pe-test.json" -Raw) | ConvertFrom-Json }

try {
  foreach ($dir in 'bin','hooks','tenants','config','state','state/heartbeats','state/continue','state/skip','state/escalations','state/work','state/events','state/flags','state/triage','state/watch','state/exclusions') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','check-policy.ps1','triage.js','assignment.js','premises.js','work-state.js','exclusions.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\stop.ps1", "$testRoot\hooks\stop.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Write-Utf8 "$testRoot\tenants\test.json" '{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","ownerLogin":"cory-owner","fleetIdentity":"fleet-bot","defaultBranch":"integration","branchPrefix":"fleet/","maxIcs":2,"ciGates":["test-build"],"watchedChecks":[],"ignoredChecks":[],"repo":"C:/nowhere"}'
  Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue
  $fixture = "$testRoot\issues-fixture.json"
  $env:FLEET_TRIAGE_ISSUES_FIXTURE = $fixture

  # Case 1: an unrouted issue and a decision-needed wake -> continue, naming both.
  Write-Utf8 $fixture '[{"number":701,"title":"Unrouted","url":"https://github.com/owner/repo/issues/701","body":"Broken.","createdAt":"2026-09-02T00:00:00.000Z","labels":["bug"],"assignees":[],"comments":[]},{"number":702,"title":"Routed","url":"https://github.com/owner/repo/issues/702","body":"x","createdAt":"2026-09-03T00:00:00.000Z","labels":["ready-for-agent"],"assignees":[],"comments":[]}]'
  Write-Utf8 "$testRoot\state\watch\wake-outbox.jsonl" ('{"at":"2026-09-11T00:00:00.000Z","recordId":"test:issue-650","revision":3,"eventSequence":3,"wake":"decision-needed","evidence":"needs a ruling"}' + "`n")
  $out1 = Run-Stop
  Assert-True ($lastExit -eq 2) "a non-empty triage frontier must continue the principal: exit $lastExit :: $out1"
  Assert-True ($out1 -match 'triage frontier:' -and $out1 -match 'escalation\(s\) #650' -and $out1 -match 'propose triage for #701') "the continuation must name the escalation and the ticket :: $out1"
  Assert-True ($out1 -notmatch '#702') 'a routed issue must not be proposed'
  Assert-True ((Get-Continue).count -eq 1) 'the loop guard must count the continuation'
  Assert-True ((Test-Path "$testRoot\state\heartbeats\pe-test.json")) 'the heartbeat must still be written'

  # Case 2: everything routed and the wake consumed -> stop, frontier empty.
  Write-Utf8 $fixture '[{"number":702,"title":"Routed","url":"https://github.com/owner/repo/issues/702","body":"x","createdAt":"2026-09-03T00:00:00.000Z","labels":["ready-for-agent"],"assignees":[],"comments":[]}]'
  & node "$testRoot\bin\triage.js" record --root $testRoot --tenant test --kind consumed --through 2026-09-11T00:00:00.000Z | Out-Null
  Assert-True ($LASTEXITCODE -eq 0) 'recording the consumed marker must succeed'
  $out2 = Run-Stop
  Assert-True ($lastExit -eq 0 -and $out2 -notmatch 'Keep working') "an empty triage frontier must stop the principal: exit $lastExit :: $out2"
  Assert-True ((Get-Continue).stoppedBecause -match 'triage frontier empty') "the stop reason must say the frontier is empty (got $((Get-Continue).stoppedBecause))"

  # Case 3: an unreadable frontier (missing fixture) -> stop, fail closed, never "empty".
  $env:FLEET_TRIAGE_ISSUES_FIXTURE = "$testRoot\missing.json"
  $out3 = Run-Stop
  Assert-True ($lastExit -eq 0) "an unreadable frontier must stop: exit $lastExit :: $out3"
  $stopped3 = (Get-Continue).stoppedBecause
  Assert-True ($stopped3 -match 'unreadable' -and $stopped3 -notmatch 'empty') "an unreadable frontier must be reported as unreadable, not empty (got $stopped3)"

  # Case 4: PAUSE stops before any frontier read.
  $env:FLEET_TRIAGE_ISSUES_FIXTURE = $fixture
  Write-Utf8 "$testRoot\state\PAUSE" 'x'
  Run-Stop | Out-Null
  Assert-True ($lastExit -eq 0 -and (Get-Continue).stoppedBecause -eq 'PAUSE set') 'PAUSE must stop the principal'
  Remove-Item "$testRoot\state\PAUSE"

  Write-Output 'stop hook principal tests passed'
} finally {
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-stop-hook-principal-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
