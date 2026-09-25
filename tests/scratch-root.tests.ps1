# Spec #94 (#163): bin/scratch-root.ps1 builds a throwaway fleet root from the current
# tree: its own empty state, a cap-1 roster, one tenant file pointing at the real tenant
# repo, and settings whose hooks point at its own hooks. A dry-run IC launch from it
# writes only under it, and the live root's roster and sessions stay byte-identical.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Get-TreeHash {
  param([string]$Root)
  $lines = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName | ForEach-Object { "$($_.FullName.Substring($Root.Length))|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" })
  return ($lines -join "`n")
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-scratch-root-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE
$oldIdentity = $env:FLEET_IDENTITY_DIR

function Run-Script {
  param([string]$File, [string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $File @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $out }
}

try {
  [IO.Directory]::CreateDirectory($testRoot) | Out-Null
  # A stand-in live root with a roster and a session file, which nothing may touch.
  $liveRoot = "$testRoot\live"
  foreach ($dir in 'state', 'state\sessions') { [IO.Directory]::CreateDirectory("$liveRoot\$dir") | Out-Null }
  Write-Utf8 "$liveRoot\state\roster.json" '{"sessions":[{"name":"pl-endzone","role":"project-lead","status":"active"}]}'
  Write-Utf8 "$liveRoot\state\sessions\pl-endzone.settings.json" '{"env":{"FLEET_NAME":"pl-endzone"}}'
  $liveBefore = Get-TreeHash $liveRoot
  $sourceStateBefore = Get-TreeHash "$sourceRoot\state"
  $sourceTenant = Get-Content "$sourceRoot\tenants\endzone.json" -Raw | ConvertFrom-Json
  $builder = "$sourceRoot\bin\scratch-root.ps1"

  # Refusals: inside the live root, inside the source tree, inside a tenant repo.
  foreach ($bad in @("$liveRoot\scratch", "$sourceRoot\.scratch-root-test", (Join-Path $sourceTenant.repo 'scratch-fleet'))) {
    $r = Run-Script $builder @('-Path', $bad, '-LiveRoot', $liveRoot)
    Assert-True ($script:lastExit -ne 0 -and "$($r.reason)" -match 'inside') "a scratch root at '$bad' must be refused (exit $script:lastExit): $script:lastOut"
    Assert-True (-not (Test-Path -LiteralPath $bad)) "a refused path must not be created: $bad"
  }

  # Build.
  $scratch = "$testRoot\scratch"
  $built = Run-Script $builder @('-Path', $scratch, '-LiveRoot', $liveRoot, '-Tenant', 'endzone')
  Assert-True ($script:lastExit -eq 0 -and $built.root -eq $scratch) "the builder must succeed and name the root: $script:lastOut"
  foreach ($f in 'bin\launch.ps1', 'bin\_common.ps1', 'bin\assignment.js', 'hooks\session-start.ps1', 'config\cycle.json', 'config\permissions-allowlist.json', 'fleet-settings.json', 'CONTEXT.md') {
    Assert-True (Test-Path -LiteralPath "$scratch\$f") "the scratch root must carry $f"
  }
  $tenantFiles = @(Get-ChildItem "$scratch\tenants" -Filter *.json | ForEach-Object { $_.Name })
  Assert-True (($tenantFiles -join ',') -eq 'endzone.json') "the scratch root carries one tenant file (got $($tenantFiles -join ','))"
  $scratchTenant = Get-Content "$scratch\tenants\endzone.json" -Raw | ConvertFrom-Json
  Assert-True ($scratchTenant.repo -eq $sourceTenant.repo -and $scratchTenant.github -eq $sourceTenant.github) 'the tenant file names the real tenant checkout and repo'
  $staticRoster = Get-Content "$scratch\roster.json" -Raw | ConvertFrom-Json
  Assert-True ([int]$staticRoster.cap -eq 1 -and @($staticRoster.sessions).Count -eq 0) 'the scratch roster is capped at one session and lists none'
  $stateFiles = @(Get-ChildItem "$scratch\state" -Recurse -File -Force | Where-Object { $_.Name -ne '.gitkeep' -and $_.FullName -ne "$scratch\state\roster.json" })
  Assert-True ($stateFiles.Count -eq 0) "the scratch state holds no files beyond an empty live roster (got $(@($stateFiles | ForEach-Object { $_.FullName }) -join ', '))"
  foreach ($dir in 'sessions', 'work', 'events', 'manifests', 'flags', 'watch') { Assert-True (Test-Path -LiteralPath "$scratch\state\$dir" -PathType Container) "the scratch state has state\$dir" }
  Assert-True (-not (Test-Path -LiteralPath "$scratch\.scratch")) 'the source .scratch notes are not copied'
  # Spec #94 (#165): a scratch root is where a CLI re-test runs, so its profile carries no
  # recorded version and the launch door does not refuse the installed CLI there.
  $scratchProfile = Get-Content "$scratch\config\permissions-allowlist.json" -Raw | ConvertFrom-Json
  Assert-True ($scratchProfile.PSObject.Properties['verifiedCliVersion'] -and $null -eq $scratchProfile.verifiedCliVersion) 'the scratch profile clears verifiedCliVersion so a rehearsal runs on the installed CLI'
  Assert-True ([bool](Get-Content "$sourceRoot\config\permissions-allowlist.json" -Raw | ConvertFrom-Json).verifiedCliVersion) 'the source profile keeps its recorded version'
  $scratchFwd = $scratch.Replace('\', '/')
  $settingsText = Get-Content "$scratch\fleet-settings.json" -Raw
  $hookCommands = @(($settingsText | ConvertFrom-Json).hooks.PSObject.Properties | ForEach-Object { $_.Value } | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
  Assert-True ($hookCommands.Count -ge 3) 'the scratch settings keep the hooks'
  foreach ($command in $hookCommands) { Assert-True ("$command" -like "*$scratchFwd/hooks/*") "a scratch hook must run the scratch root's own hooks: $command" }
  $liveFwd = $liveRoot.Replace('\', '/')
  $scratchDeny = @(($settingsText | ConvertFrom-Json).permissions.deny)
  Assert-True ($scratchDeny -contains "Write($liveFwd/**)" -and $scratchDeny -contains "Edit($liveFwd/**)") 'the scratch settings fence off the live root'
  Assert-True ("$($built.next.assign)" -match 'assignment\.js assign' -and "$($built.next.assign)" -match '--permissions allowlist' -and "$($built.next.assign)" -match [regex]::Escape($scratchFwd)) "the builder prints the assign command against the scratch root: $($built.next.assign)"
  Assert-True ("$($built.next.launch)" -match 'assignment\.js launch') 'the builder prints the launch command'
  Assert-True ("$($built.next.watch)" -match 'state\.json') 'the builder prints the state.json path to watch'
  Assert-True ("$($built.remove)" -match [regex]::Escape($scratch)) 'the builder prints the one command that removes the root'
  $again = Run-Script $builder @('-Path', $scratch, '-LiveRoot', $liveRoot)
  Assert-True ($script:lastExit -ne 0 -and "$($again.reason)" -match 'not empty') 'building over a non-empty path is refused'

  # A dry-run IC launch from the scratch root: settings under it, no live fleet counted.
  [IO.Directory]::CreateDirectory("$testRoot\mock-bin") | Out-Null
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo [{"name":"pl-endzone","id":"j1","sessionId":"s1","state":"idle"}]' + "`r`n" + 'exit /b 0' + "`r`n")
  [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs") | Out-Null
  [IO.Directory]::CreateDirectory("$testRoot\identity") | Out-Null
  Write-Utf8 "$testRoot\identity\hosts.yml" ("github.com:`n    oauth_token: ghp_scratch_fixture`n    user: $($sourceTenant.fleetIdentity)`n")
  $env:FLEET_IDENTITY_DIR = "$testRoot\identity"
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $launched = Run-Script "$scratch\bin\launch.ps1" @('-Role', 'ic', '-Name', 'ic-4242', '-Tenant', 'endzone', '-Parent', 'pl-endzone', '-Issue', '4242', '-Prompt', 'Rehearse.', '-DryRun')
  Assert-True ($script:lastExit -eq 0 -and $launched.dryRun -eq $true) "a dry-run IC launch from the scratch root must pass: $script:lastOut"
  Assert-True ("$($launched.settings)".StartsWith($scratch, [StringComparison]::OrdinalIgnoreCase)) "the settings path must be under the scratch root: $($launched.settings)"
  Assert-True ([int]$launched.liveFleet -eq 0) "a live fleet session must not count toward the scratch cap (liveFleet $($launched.liveFleet))"
  $launchedSettings = Get-Content "$($launched.settings)" -Raw | ConvertFrom-Json
  Assert-True ($launchedSettings.env.FLEET_HOME -eq $scratch) 'the launched session names the scratch root as FLEET_HOME'
  foreach ($command in @($launchedSettings.hooks.PSObject.Properties | ForEach-Object { $_.Value } | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })) {
    Assert-True ("$command" -like "*$scratchFwd/hooks/*") "a launched session's hook must be the scratch root's own: $command"
  }

  Assert-True ((Get-TreeHash $liveRoot) -eq $liveBefore) 'the live root roster and sessions are byte-identical after build and launch'
  Assert-True ((Get-TreeHash "$sourceRoot\state") -eq $sourceStateBefore) 'the source tree state is untouched'

  # The printed removal leaves the live root as it was.
  Remove-Item -LiteralPath $scratch -Recurse -Force
  Assert-True ((Get-TreeHash $liveRoot) -eq $liveBefore) 'removing the scratch root leaves the live root as it was'

  Write-Output 'scratch root tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  if ($null -eq $oldIdentity) { Remove-Item Env:FLEET_IDENTITY_DIR -ErrorAction SilentlyContinue } else { $env:FLEET_IDENTITY_DIR = $oldIdentity }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-scratch-root-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
