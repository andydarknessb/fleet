# ADR 0010: the research-gate PreToolUse hook refuses a main-session sweep, history
# read, CI log read or web fetch for the gated roles, points at the haiku researcher,
# and passes everything else: targeted commands, sub-agent calls, ungated roles, the
# rollback flag. It never exits nonzero.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$hook = "$sourceRoot\hooks\research-gate.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-research-gate-test-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($v in 'FLEET_HOME','FLEET_ROLE') { $saved[$v] = [Environment]::GetEnvironmentVariable($v) }

function Run-Gate {
  param([string]$Role, [string]$Tool, [string]$Command = '', [string]$AgentId = '')
  $env:FLEET_HOME = $testRoot; $env:FLEET_ROLE = $Role
  $input = @{ session_id = 's1'; hook_event_name = 'PreToolUse'; tool_name = $Tool; tool_input = @{ command = $Command } }
  if ($AgentId) { $input.agent_id = $AgentId }
  $json = $input | ConvertTo-Json -Compress -Depth 4
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = ($json | & powershell -NoProfile -ExecutionPolicy Bypass -File $hook 2>&1 | Out-String) }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  Assert-True ($script:lastExit -eq 0) "the gate must never exit nonzero (role=$Role tool=$Tool cmd=$Command exit=$script:lastExit)"
  $out = $out.Trim()
  if (-not $out) { return $null }
  return ($out | ConvertFrom-Json).hookSpecificOutput
}
function Assert-Denied { param($Result, [string]$What)
  Assert-True ($null -ne $Result -and $Result.permissionDecision -eq 'deny') "$What must be refused"
  Assert-True ("$($Result.permissionDecisionReason)" -match 'subagent_type: researcher') "$What refusal must name the researcher"
  Assert-True ("$($Result.permissionDecisionReason)" -match 'ADR 0010') "$What refusal must cite ADR 0010"
}
function Assert-Allowed { param($Result, [string]$What) Assert-True ($null -eq $Result) "$What must pass silently" }

try {
  [IO.Directory]::CreateDirectory("$testRoot\state\flags") | Out-Null

  # --- refused for an IC ---
  Assert-Denied (Run-Gate -Role ic -Tool Bash -Command 'grep -rn "runInjurySync" server/ src/') 'a recursive grep'
  Assert-Denied (Run-Gate -Role ic -Tool Bash -Command 'grep -rln "syncInjuries" server/ | grep -v node_modules') 'a recursive grep with -rln'
  Assert-Denied (Run-Gate -Role ic -Tool Bash -Command 'cd /e/repo && rg "withTransaction" server') 'a ripgrep sweep after cd'
  Assert-Denied (Run-Gate -Role ic -Tool Bash -Command 'git log --oneline -20 -- server/modules') 'a git log'
  Assert-Denied (Run-Gate -Role ic -Tool Bash -Command 'gh run view 123456 --log-failed') 'a CI log read'
  Assert-Denied (Run-Gate -Role ic -Tool Bash -Command 'curl -s https://example.com/docs') 'a curl'
  Assert-Denied (Run-Gate -Role ic -Tool PowerShell -Command 'Get-ChildItem -Recurse src | Select-String "useLeague"') 'a recursive Select-String'
  Assert-Denied (Run-Gate -Role ic -Tool PowerShell -Command 'Invoke-WebRequest https://example.com') 'an Invoke-WebRequest'
  Assert-Denied (Run-Gate -Role ic -Tool WebFetch) 'WebFetch'
  Assert-Denied (Run-Gate -Role project-lead -Tool WebSearch) 'WebSearch for a lead'
  Assert-Denied (Run-Gate -Role dispatcher -Tool Bash -Command 'git blame bin/watchdog.ps1') 'git blame for the dispatcher'

  # --- allowed: what was handed to you, targeted reads, authoring, tests ---
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'gh issue view 1200 --comments') 'reading your own issue'
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'gh pr view 29 --json state') 'reading a PR'
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'grep -n "syncInjuries" server/modules/scheduler.js') 'a non-recursive grep on a named file'
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'node --test server/test/injury.test.js') 'running tests'
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'git status --short && git diff --stat') 'git status and diff'
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'git push -u origin fleet/1200-branch') 'git push'
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'npm run lint') 'npm scripts'
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'gh pr checks 29') 'pr checks (a status, not a log)'
  Assert-Allowed (Run-Gate -Role ic -Tool Read -Command '') 'the Read tool'
  Assert-Allowed (Run-Gate -Role ic -Tool Grep -Command '') 'the Grep tool'

  # --- allowed: sub-agent, ungated role, no fleet identity, rollback flag ---
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'grep -rn "x" src' -AgentId 'a1b2c3') 'the same sweep from inside a sub-agent'
  Assert-Allowed (Run-Gate -Role sentinel -Tool Bash -Command 'grep -rn "x" src') 'the sentinel'
  $env:FLEET_HOME = ''; $env:FLEET_ROLE = ''
  $json = @{ tool_name = 'Bash'; tool_input = @{ command = 'grep -rn x .' } } | ConvertTo-Json -Compress
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $outNoFleet = ($json | & powershell -NoProfile -ExecutionPolicy Bypass -File $hook 2>&1 | Out-String).Trim() } finally { $ErrorActionPreference = $eap }
  Assert-True (-not $outNoFleet) 'a session with no fleet identity is not gated'
  [IO.File]::WriteAllText("$testRoot\state\flags\research-gate-off", '')
  Assert-Allowed (Run-Gate -Role ic -Tool Bash -Command 'grep -rn "x" src') 'the rollback flag'
  Remove-Item "$testRoot\state\flags\research-gate-off" -Force
  Assert-Denied (Run-Gate -Role ic -Tool Bash -Command 'grep -rn "x" src') 'the gate after the flag is removed'

  # --- garbage input never blocks ---
  $env:FLEET_HOME = $testRoot; $env:FLEET_ROLE = 'ic'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $outGarbage = ('not json' | & powershell -NoProfile -ExecutionPolicy Bypass -File $hook 2>&1 | Out-String).Trim() } finally { $garbageExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  Assert-True ($garbageExit -eq 0 -and -not $outGarbage) 'unparseable hook input must pass silently'

  Write-Output 'research gate tests passed'
} finally {
  foreach ($v in $saved.Keys) { [Environment]::SetEnvironmentVariable($v, $saved[$v]) }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-research-gate-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
