$ErrorActionPreference = 'Stop'

# fleet #265: Resolve-ClaudeCli / Invoke-ClaudeCli / Get-DaemonSessions. The claude CLI
# auto-updates through `npm install -g`, which leaves no `claude` anywhere for some
# seconds; a bare `& claude` then read as an empty fleet. The resolver finds the CLI
# (override, PATH, known npm paths), waits out a reinstall, and otherwise throws a
# message that names every place it looked.

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-claude-cli-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($n in 'PATH', 'APPDATA', 'USERPROFILE', 'FLEET_CLAUDE_CLI', 'FLEET_CLAUDE_RESOLVE_TRIES', 'FLEET_CLAUDE_RESOLVE_POLL_MS') { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }

function Get-Thrown { param([scriptblock]$Block) try { & $Block | Out-Null; return $null } catch { return "$($_.Exception.Message)" } }

try {
  foreach ($dir in 'mock-bin', 'elsewhere', 'appdata', 'profile') { [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null }
  . "$sourceRoot\bin\_common.ps1"

  $rows = '[{"id":"job-1","name":"ic-1","state":"working","status":"idle","pid":11,"startedAt":"2026-09-30T00:00:00Z"}]'
  $mockBody = '@echo off' + "`r`n" + 'if "%1"=="agents" echo ' + $rows + "`r`n" + 'exit /b 0' + "`r`n"
  $env:PATH = "$testRoot\mock-bin;$PSHOME"
  $env:APPDATA = "$testRoot\appdata"
  $env:USERPROFILE = "$testRoot\profile"
  Remove-Item Env:\FLEET_CLAUDE_CLI -ErrorAction SilentlyContinue
  $env:FLEET_CLAUDE_RESOLVE_TRIES = '3'
  $env:FLEET_CLAUDE_RESOLVE_POLL_MS = '100'

  # Case 1: no claude anywhere -> throws, naming the PATH search, all three known paths, and FLEET_CLAUDE_CLI=unset.
  $script:ClaudeCli = $null
  $msg = Get-Thrown { Resolve-ClaudeCli -NoRetry }
  Assert-True ($null -ne $msg) 'Resolve-ClaudeCli must throw when no claude exists anywhere'
  Assert-True ($msg -match 'claude CLI not found') "the throw must say 'claude CLI not found': $msg"
  Assert-True ($msg.Contains("$testRoot\appdata\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe")) "the throw must name the npm package path: $msg"
  Assert-True ($msg.Contains("$testRoot\appdata\npm\claude.cmd")) "the throw must name the npm shim path: $msg"
  Assert-True ($msg.Contains("$testRoot\profile\.local\bin\claude.exe")) "the throw must name the native install path: $msg"
  Assert-True ($msg -match 'FLEET_CLAUDE_CLI=unset') "the throw must say FLEET_CLAUDE_CLI=unset: $msg"
  Assert-True ($null -ne $script:ClaudeCliMissing -and @($script:ClaudeCliMissing.tried).Count -eq 4) 'the miss must be recorded for the scripts that give up (JSON, exit 6)'
  $json = (Get-ClaudeCliMissingJson) | ConvertFrom-Json
  Assert-True ($json.ok -eq $false -and $json.error -eq 'claude-cli-missing' -and @($json.tried).Count -eq 4 -and $null -eq $json.envOverride) 'Get-ClaudeCliMissingJson must carry ok/error/tried/envOverride/waitedSec'

  # Case 2: Get-DaemonSessions -Strict with no CLI carries the resolver text, never a bare exit code.
  $script:ClaudeCli = $null
  $msg = Get-Thrown { Get-DaemonSessions -Strict }
  Assert-True ($null -ne $msg -and $msg -match 'claude CLI not found') "Get-DaemonSessions -Strict must throw the resolver text, got: $msg"
  Assert-True ($msg -match 'daemon session list unreadable') "the strict throw must keep the unreadable prefix: $msg"
  # ... and the tolerant read still returns @() (a read-only caller), with the cause on the warning stream.
  $warn = @(); $tolerant = @()
  $captured = @(Get-DaemonSessions -All 3>&1)
  $warn = @($captured | Where-Object { $_ -is [Management.Automation.WarningRecord] })
  $tolerant = @($captured | Where-Object { $_ -isnot [Management.Automation.WarningRecord] })
  Assert-True ($tolerant.Count -eq 0) 'the tolerant read still returns an empty list when the CLI is missing'
  Assert-True (("$warn") -match 'claude CLI not found') "the tolerant read must say why on the warning stream: $warn"

  # Case 3: FLEET_CLAUDE_CLI -> a claude.cmd that is not on PATH resolves to it and feeds Get-DaemonSessions.
  Write-Utf8 "$testRoot\elsewhere\claude.cmd" $mockBody
  $env:FLEET_CLAUDE_CLI = "$testRoot\elsewhere\claude.cmd"
  $script:ClaudeCli = $null
  Assert-True ((Resolve-ClaudeCli -NoRetry) -eq "$testRoot\elsewhere\claude.cmd") 'FLEET_CLAUDE_CLI must resolve to the override'
  $sessions = @(Get-DaemonSessions -All -Strict)
  Assert-True ($sessions.Count -eq 1 -and $sessions[0].id -eq 'job-1') 'Get-DaemonSessions -All -Strict must return the mock rows through the override'
  $run = Invoke-ClaudeCli -Arguments @('agents', '--json')
  Assert-True ($run.exitCode -eq 0 -and $run.cli -eq "$testRoot\elsewhere\claude.cmd" -and $run.stdout -match 'job-1') 'Invoke-ClaudeCli must return cli/exitCode/stdout'

  # Case 4: FLEET_CLAUDE_CLI -> a missing file while a claude.cmd IS on PATH: throws naming the override, no fallback.
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" $mockBody
  $env:FLEET_CLAUDE_CLI = "$testRoot\does-not-exist\claude.cmd"
  $script:ClaudeCli = $null
  $msg = Get-Thrown { Resolve-ClaudeCli }
  Assert-True ($null -ne $msg -and $msg -match 'FLEET_CLAUDE_CLI does not point to a claude executable' -and $msg.Contains("$testRoot\does-not-exist\claude.cmd")) "a wrong override must throw naming it: $msg"
  $msg = Get-Thrown { Invoke-ClaudeCli -Arguments @('agents', '--json') }
  Assert-True ($null -ne $msg -and $msg -match 'FLEET_CLAUDE_CLI does not point') 'Invoke-ClaudeCli must not fall back to PATH past a wrong override'
  Remove-Item Env:\FLEET_CLAUDE_CLI

  # Case 5: no override -> the PATH mock is found; a change of override drops the per-process cache.
  $script:ClaudeCli = $null
  Assert-True ((Resolve-ClaudeCli -NoRetry) -eq "$testRoot\mock-bin\claude.cmd") 'claude.cmd on PATH must resolve'
  Assert-True (@(Get-DaemonSessions -Strict).Count -eq 1) 'a strict read through the PATH mock must work'

  # Case 6: known path. No PATH hit, claude.exe under node_modules counts only with its package.json.
  Remove-Item "$testRoot\mock-bin\claude.cmd"
  $script:ClaudeCli = $null
  $pkgDir = "$testRoot\appdata\npm\node_modules\@anthropic-ai\claude-code"
  [IO.Directory]::CreateDirectory("$pkgDir\bin") | Out-Null
  Copy-Item "$env:SystemRoot\System32\whoami.exe" "$pkgDir\bin\claude.exe"
  $msg = Get-Thrown { Resolve-ClaudeCli -NoRetry }
  Assert-True ($null -ne $msg -and $msg -match 'claude CLI not found') 'a claude.exe with no package.json (npm mid-write) must not count'
  Write-Utf8 "$pkgDir\package.json" '{"name":"@anthropic-ai/claude-code"}'
  Assert-True ((Resolve-ClaudeCli -NoRetry) -eq "$pkgDir\bin\claude.exe") 'claude.exe plus package.json under APPDATA\npm must resolve'
  Remove-Item $pkgDir -Recurse -Force

  # Case 7: the reinstall window. mock-bin starts empty; a background job writes claude.cmd after ~2-4 s.
  $script:ClaudeCli = $null
  $env:FLEET_CLAUDE_RESOLVE_TRIES = '40'
  $env:FLEET_CLAUDE_RESOLVE_POLL_MS = '250'
  $job = Start-Job -ScriptBlock {
    param($Path, $Body)
    Start-Sleep -Milliseconds 2500
    [IO.File]::WriteAllText($Path, $Body, (New-Object Text.UTF8Encoding $false))
  } -ArgumentList "$testRoot\mock-bin\claude.cmd", $mockBody
  try {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $found = Resolve-ClaudeCli
    $clock.Stop()
  } finally { Wait-Job $job -Timeout 30 | Out-Null; Remove-Job $job -Force -ErrorAction SilentlyContinue }
  Assert-True ($found -eq "$testRoot\mock-bin\claude.cmd") 'Resolve-ClaudeCli must wait out a reinstall and return the CLI that reappeared'
  Assert-True ($clock.Elapsed.TotalSeconds -ge 1.5) "the resolver must actually have waited (took $($clock.Elapsed.TotalSeconds)s)"

  Write-Output 'claude-cli-resolver tests passed'
} finally {
  foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
