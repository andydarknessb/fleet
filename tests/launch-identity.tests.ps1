# Spec fleet #93 / #153 (ADR 0015): every launched session acts on GitHub as the
# fleet's own login. launch.ps1 asks bin/identity.js for the plan and (a) puts
# GH_CONFIG_DIR and git's credential reset into the session's settings env when the
# secret gh config directory is present, (b) keeps the keyring when it is absent and
# no tenant yet names a distinct fleetIdentity, (c) refuses with a named code, writes
# no session, and pages ONCE at high priority when it is required but missing or
# names another login. No token ever lands in the settings file.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-launch-identity-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE
$oldIdentity = $env:FLEET_IDENTITY_DIR
$oldNoToast = $env:FLEET_NO_TOAST

function Run-Launch {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}
function Set-Tenant { param([string]$FleetIdentity) Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","maxIcs":2,"fleetIdentity":"' + $FleetIdentity + '","ownerLogin":"cory-owner","repo":' + ("$testRoot\repo" | ConvertTo-Json) + '}') }
function Set-Identity {
  param([string]$Login)
  if (-not $Login) { Remove-Item -Recurse -Force "$testRoot\identity" -ErrorAction SilentlyContinue; return }
  [IO.Directory]::CreateDirectory("$testRoot\identity") | Out-Null
  Write-Utf8 "$testRoot\identity\hosts.yml" ("github.com:`n    users:`n        ${Login}:`n            oauth_token: ghp_launch_fixture`n    git_protocol: https`n    oauth_token: ghp_launch_fixture`n    user: $Login`n")
}
function Get-PageLines { if (Test-Path "$testRoot\state\pages\pages.jsonl") { return @(Get-Content "$testRoot\state\pages\pages.jsonl" | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.kind -eq 'fleet-identity' }) }; return @() }
$dispatch = @('-Role', 'dispatcher', '-Name', 'dispatcher', '-Parent', 'cory', '-Prompt', 'Start your duties.')

try {
  foreach ($dir in 'bin','hooks','agents','tenants','config','state','state/sessions','state/notices','state/work','state/flags','mock-bin','repo') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1','identity.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\dispatcher.md" "---`nname: dispatcher`nmodel: sonnet`neffort: low`n---`nRole body for dispatcher."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  # The mock CLI lists no sessions and creates none: a launch that passes every gate ends at exit 5.
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  # The mock gh answers `api user` with MOCK_GH_LOGIN, or fails like an expired token when it is unset.
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'if "%MOCK_GH_LOGIN%"=="" (echo HTTP 401: Bad credentials 1>&2 & exit /b 1)' + "`r`n" + 'echo %MOCK_GH_LOGIN%' + "`r`n" + 'exit /b 0' + "`r`n")
  [IO.Directory]::CreateDirectory("$testRoot\profile") | Out-Null
  Write-Utf8 "$testRoot\profile\.claude.json" ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}')
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:FLEET_IDENTITY_DIR = "$testRoot\identity"
  $env:FLEET_NO_TOAST = '1'
  $settingsFile = "$testRoot\state\sessions\dispatcher.settings.json"

  # Case 1 (today, before #152 is run): the tenant still names the owner as the fleet and
  # no identity directory exists. The launch keeps the keyring: no GH_CONFIG_DIR, no refusal.
  Set-Tenant 'cory-owner'; Set-Identity $null
  $r1 = Run-Launch ($dispatch + '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r1.dryRun -eq $true) "pre-flip with no identity must launch as before: $lastOut"
  $env1 = (Get-Content $settingsFile -Raw | ConvertFrom-Json).env
  Assert-True (-not $env1.PSObject.Properties['GH_CONFIG_DIR']) 'with no identity directory the session carries no GH_CONFIG_DIR'

  # Case 2: the directory exists before the flip: the session already acts as the fleet
  # (the premise check reports expected-until-154), and no token is in the settings file.
  Set-Identity 'fleet-bot'
  $r2 = Run-Launch ($dispatch + '-DryRun')
  Assert-True ($lastExit -eq 0 -and $r2.dryRun -eq $true) "pre-flip with the identity present must launch: $lastOut"
  $raw2 = Get-Content $settingsFile -Raw
  $env2 = ($raw2 | ConvertFrom-Json).env
  Assert-True ($env2.GH_CONFIG_DIR -eq "$testRoot\identity") "the session must read the fleet's gh config dir: $raw2"
  Assert-True ($env2.GIT_CONFIG_SYSTEM -eq "$testRoot\identity\gitconfig" -and (Test-Path "$testRoot\identity\gitconfig")) 'git must read the fleet system gitconfig'
  Assert-True ((Get-Content "$testRoot\identity\gitconfig" -Raw) -match '(?m)^\s*helper =\s*$' -and (Get-Content "$testRoot\identity\gitconfig" -Raw) -match 'auth git-credential') 'git pushes must authenticate through gh, not the credential manager'
  Assert-True ($raw2 -notmatch 'ghp_launch_fixture') 'the token must never be written into state/'
  Assert-True (-not $env2.PSObject.Properties['GIT_AUTHOR_NAME'] -and -not $env2.PSObject.Properties['GIT_AUTHOR_EMAIL']) 'ADR 0015: the commit author is unchanged'

  # Case 3: after the flip, a missing directory refuses: named code, no settings, no
  # roster row, one high page; a second refused launch does not page again.
  Set-Tenant 'fleet-bot'; Set-Identity $null
  Remove-Item $settingsFile -ErrorAction SilentlyContinue
  $r3 = Run-Launch $dispatch
  Assert-True ($lastExit -eq 3 -and $r3.launched -eq $false -and $r3.code -eq 'FLEET_IDENTITY_MISSING') "a required but missing identity must refuse with its code: $lastOut"
  Assert-True ("$($r3.reason)" -match 'no fallback') 'the refusal must say there is no keyring fallback'
  Assert-True (-not (Test-Path $settingsFile)) 'a refused launch writes no session settings'
  Assert-True (@((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions).Count -eq 0) 'a refused launch writes no roster row'
  $pages3 = @(Get-PageLines)
  Assert-True ($pages3.Count -eq 1 -and $pages3[0].priority -eq 'high' -and "$($pages3[0].title)" -match 'FLEET_IDENTITY_MISSING') "the refusal must page once at high priority: $($pages3 | ConvertTo-Json -Compress)"
  $r3b = Run-Launch $dispatch
  Assert-True ($lastExit -eq 3 -and $r3b.paged -eq $false -and @(Get-PageLines).Count -eq 1) 'a repeated refusal must not page again'
  $r3c = Run-Launch ($dispatch + '-DryRun')
  Assert-True ($lastExit -eq 3 -and $r3c.code -eq 'FLEET_IDENTITY_MISSING' -and $r3c.dryRun -eq $true) 'a dry run reports the refusal too'

  # Case 4: the directory names another login: FLEET_IDENTITY_MISMATCH, paged (a new code).
  Set-Identity 'someone-else'
  $r4 = Run-Launch $dispatch
  Assert-True ($lastExit -eq 3 -and $r4.code -eq 'FLEET_IDENTITY_MISMATCH' -and "$($r4.reason)" -match 'someone-else') "a directory for the wrong login must refuse: $lastOut"
  Assert-True (@(Get-PageLines).Count -eq 2) 'a different refusal code pages once more'

  # Case 4b: the right login on disk, but GitHub refuses the token (expired or revoked).
  Set-Identity 'fleet-bot'; $env:MOCK_GH_LOGIN = ''
  $r4b = Run-Launch $dispatch
  Assert-True ($lastExit -eq 3 -and $r4b.code -eq 'FLEET_IDENTITY_INVALID' -and "$($r4b.reason)" -match 'expired or revoked') "a token GitHub refuses must refuse the launch: $lastOut"
  $env:MOCK_GH_LOGIN = 'fleet-bot'

  # Case 5: the right login: the launch passes the identity gate (and reaches the mock CLI,
  # which makes no session: exit 5), the settings carry the env, and the page marker clears.
  Set-Identity 'fleet-bot'
  $r5 = Run-Launch $dispatch
  Assert-True ($lastExit -eq 5) "the right identity must pass the gate and reach the CLI: $lastOut"
  Assert-True (((Get-Content $settingsFile -Raw | ConvertFrom-Json).env.GH_CONFIG_DIR) -eq "$testRoot\identity") 'the launched session must carry GH_CONFIG_DIR'
  Assert-True (-not (Test-Path "$testRoot\state\identity\paged.json")) 'a clean plan clears the page marker so the next failure pages again'

  Write-Output 'launch identity tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $env:FLEET_IDENTITY_DIR = $oldIdentity
  $env:FLEET_NO_TOAST = $oldNoToast
  $env:MOCK_GH_LOGIN = $null
  Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue
}
