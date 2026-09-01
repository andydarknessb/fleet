# Ticket 06: launch.ps1 writes the role's tool contract into the session settings
# and refuses a launch whose estimated first-turn context exceeds the role ceiling,
# reporting the contribution by source. Uses -DryRun so nothing launches.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-launch-settings-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH

function Run-Launch {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
}

try {
  foreach ($dir in 'bin','hooks','agents','tenants','config','state','state/sessions','state/notices','state/work','state/rotation','state/flags','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  foreach ($roleName in 'dispatcher','project-lead','ic') {
    Write-Utf8 "$testRoot\agents\$roleName.md" ("---`nname: $roleName`nmodel: sonnet`neffort: low`n---`nRole body for $roleName.")
  }
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $repoPath = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","maxIcs":2,"repo":' + ($repoPath | ConvertTo-Json) + '}')
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $repoFwd = $repoPath.Replace('\', '/')
  $rootFwd = $testRoot.Replace('\', '/')

  # Case 1: a control-plane role gets the state-door and tenant-repo denials.
  $r1 = Run-Launch @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start your duties.', '-DryRun')
  Assert-True ($r1.dryRun -eq $true) 'the dry run must report itself'
  $settings1 = Get-Content "$testRoot\state\sessions\dispatcher.settings.json" -Raw | ConvertFrom-Json
  $deny1 = @($settings1.permissions.deny)
  Assert-True ($deny1 -contains "Edit($rootFwd/state/work/**)") 'the dispatcher must lose direct Edit on state/work'
  Assert-True ($deny1 -contains "Write($rootFwd/state/events/**)") 'the dispatcher must lose direct Write on state/events'
  Assert-True ($deny1 -contains "NotebookEdit($rootFwd/state/archive/**)") 'the dispatcher must lose direct NotebookEdit on state/archive'
  Assert-True ($deny1 -contains "Edit($repoFwd/**)") 'a control-plane role must lose engineering edits in tenant repos'
  Assert-True ($settings1.permissions.defaultMode -eq 'auto') 'existing permission settings must survive the merge'
  Assert-True ($null -ne $r1.budget -and $r1.budget.estimatedTokens -gt 0) 'the dry run must report the first-turn budget'
  Assert-True ($r1.budget.ceiling -eq 12000) 'the dispatcher ceiling must come from config/cycle.json'

  # Case 2: an IC keeps tenant-repo tools but loses every direct fleet-state write.
  $r2 = Run-Launch @('-Role', 'ic', '-Name', 'ic-42', '-Tenant', 'test', '-Parent', 'pl-test', '-Issue', '42', '-Prompt', 'Implement issue 42.', '-DryRun')
  Assert-True ($r2.dryRun -eq $true) 'the IC dry run must report itself'
  $deny2 = @((Get-Content "$testRoot\state\sessions\ic-42.settings.json" -Raw | ConvertFrom-Json).permissions.deny)
  Assert-True ($deny2 -contains "Edit($rootFwd/state/**)") 'an IC must lose direct edits across fleet state'
  Assert-True (-not ($deny2 -contains "Edit($repoFwd/**)")) 'an IC must keep engineering tools in the tenant repo'

  # Case 2b: the tool-contract rollback flag skips the deny injection only.
  Write-Utf8 "$testRoot\state\flags\tool-contract-off" 'rollback'
  $r2b = Run-Launch @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start your duties.', '-DryRun')
  Assert-True ($r2b.dryRun -eq $true) 'the flagged dry run must still pass the gates'
  $settings2b = Get-Content "$testRoot\state\sessions\dispatcher.settings.json" -Raw | ConvertFrom-Json
  Assert-True (-not $settings2b.permissions.PSObject.Properties['deny']) 'tool-contract-off must skip the deny injection'
  Assert-True ($null -ne $r2b.budget) 'tool-contract-off must not disable the ceiling estimate'
  Remove-Item "$testRoot\state\flags\tool-contract-off"

  # Case 3: an over-ceiling launch fails before assignment with a source breakdown.
  # A 60K-char prompt (~15K tokens; dispatcher ceiling is 12K) exceeds the Windows
  # command line, so a runner reads it from a file inside the child process.
  Write-Utf8 "$testRoot\big-prompt.txt" ('x' * 60000)
  Write-Utf8 "$testRoot\bin\run-big.ps1" @'
param([switch]$WithForce, [switch]$WithFlag)
$p = Get-Content "$PSScriptRoot\..\big-prompt.txt" -Raw
if ($WithForce) { & "$PSScriptRoot\launch.ps1" -Role dispatcher -Name dispatcher -Parent cory -Prompt $p -DryRun -Force }
else { & "$PSScriptRoot\launch.ps1" -Role dispatcher -Name dispatcher -Parent cory -Prompt $p -DryRun }
exit $LASTEXITCODE
'@
  function Run-Big {
    param([string[]]$Arguments = @())
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\run-big.ps1" @Arguments 2>&1 | Out-String }
    finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
    try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
  }
  $r3 = Run-Big
  Assert-True ($script:lastExit -eq 6) 'an over-ceiling launch must exit 6'
  Assert-True ($r3.launched -eq $false -and "$($r3.reason)" -match 'ceiling') 'the refusal must name the ceiling'
  Assert-True ($r3.budget.sources.prompt -ge 15000) 'the breakdown must attribute the tokens to the prompt'
  Assert-True ($r3.budget.sources.roleFile -gt 0) 'the breakdown must list every source'
  Assert-True ($r3.budget.sources.sessionStartInjection -gt 0) 'the breakdown must count the hook injection'

  # Case 4: the rollback flag disables the gate; -Force overrides it too.
  Write-Utf8 "$testRoot\state\flags\launch-ceiling-off" 'rollback'
  $r4 = Run-Big
  Assert-True ($r4.dryRun -eq $true) 'the flag must disable the ceiling gate'
  Remove-Item "$testRoot\state\flags\launch-ceiling-off"
  $r4b = Run-Big @('-WithForce')
  Assert-True ($r4b.dryRun -eq $true) '-Force must override the ceiling gate'

  Write-Output 'launch settings tests passed'
} finally {
  $env:PATH = $oldPath
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-settings-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
