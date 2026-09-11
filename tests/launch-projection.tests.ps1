# 02/03: a legacy IC launch must leave a Work record behind immediately, not up to one
# pr-watch tick (5 min) later. Until it did, every legacy launch manufactured a
# planner-includes parity difference: the roster had the IC so the Stop hook dropped the
# issue, while state/work/active.json did not, so the planner still offered it. That is
# also the double-launch window the reservation exists to close. Uses a mock `claude` that
# produces a daemon row for the launched name, so the launch really succeeds.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

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

try {
  foreach ($dir in 'bin','hooks','agents','tenants','config','state','state/sessions','state/notices','state/work','state/events','state/flags','mock-bin','repo') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1','work-state.js','assignment.js','assignment-parity.js','exclusions.js','notify.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: sonnet`neffort: low`n---`nRole body for ic."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","defaultBranch":"integration","branchPrefix":"fleet/","maxIcs":2,"repo":' + ("$testRoot\repo" | ConvertTo-Json) + '}')

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

  # Case 1: a successful legacy IC launch reserves its unit before it returns.
  Assert-True ($null -eq (Get-ActiveRecords)) 'no Work record exists before the launch'
  $r1 = Run-Launch @('-Role', 'ic', '-Name', 'ic-101', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '101', '-Prompt', '/mattpocock-skills:implement legacy brief')
  Assert-True ($lastExit -eq 0 -and $r1.launched -eq $true) "the launch must succeed: $lastOut"
  $records = Get-ActiveRecords
  Assert-True ($null -ne $records -and $null -ne $records.PSObject.Properties['test:issue-101']) "the launch must leave a Work record for its issue: $lastOut"
  $record = $records.PSObject.Properties['test:issue-101'].Value
  Assert-True ($record.state -eq 'implementing') "the record must be implementing, was $($record.state)"
  Assert-True ($record.owner.session -eq 'ic-101') 'the record must name the session that owns it'
  Assert-True ($r1.projected -eq $true) 'the launch result must report that it projected'

  # The planner must now refuse the issue as reserved, which is the whole point: the
  # Stop hook has already dropped it from its own frontier, so the two agree.
  $fixture = "$testRoot\issues.json"
  Write-Utf8 $fixture '[{"number":101,"title":"Fixture","url":"https://example/101","body":"Change `src/fixture.js`.","createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $frontierRaw = & node "$testRoot\bin\assignment.js" frontier --root $testRoot --tenant test --fixture $fixture --ready-label ready-for-agent 2>&1 | Out-String
  $ErrorActionPreference = $eap
  $frontier = ($frontierRaw.Trim() -split "`n")[-1] | ConvertFrom-Json
  Assert-True (@($frontier.eligible).Count -eq 0) "the planner must not offer an issue that was just launched: $frontierRaw"
  Assert-True ((@($frontier.excluded) | Where-Object { $_.issue -eq 101 }).reasons.code -contains 'reserved') 'and it must say why: reserved'

  # Case 2: an event was appended for it, exactly once.
  $eventLines = @(Get-ChildItem "$testRoot\state\events" -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ })
  $projected = @($eventLines | Where-Object { $_ -match '"recordId":"test:issue-101"' })
  Assert-True ($projected.Count -eq 1 -and $projected[0] -match '"type":"shadow-projected"') "exactly one projection event: $($projected -join ' | ')"

  # Case 3: a control-plane launch projects nothing (the projection is about IC units).
  Write-Utf8 "$testRoot\mock-agents-after-launch.json" '[{"id":"job-101","name":"ic-101","state":"working","status":"idle","pid":21,"sessionId":"sess-101","startedAt":1756000000000},{"id":"job-pl","name":"pl-test","state":"working","status":"idle","pid":22,"sessionId":"sess-pl","startedAt":1756000002000}]'
  $before = @(Get-ChildItem "$testRoot\state\events" -Filter *.jsonl | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ }).Count
  $r3 = Run-Launch @('-Role', 'project-lead', '-Name', 'pl-test', '-Tenant', 'test', '-Parent', 'dispatcher', '-Prompt', 'lead')
  Assert-True ($lastExit -eq 0 -and $r3.launched -eq $true) "the lead launch must succeed: $lastOut"
  Assert-True ($null -eq $r3.projected -or $r3.projected -eq $false) 'a control-plane launch must not report a projection'
  $after = @(Get-ChildItem "$testRoot\state\events" -Filter *.jsonl | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ }).Count
  Assert-True ($after -eq $before) 'a control-plane launch must append no Work event'

  Write-Output 'launch projection tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-projection-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
