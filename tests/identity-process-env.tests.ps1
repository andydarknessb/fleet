# Spec fleet #93 / #153 (ADR 0015): the Watchdog's own process carries the fleet
# identity. Set-FleetIdentityProcessEnv (bin/_common.ps1) puts the plan's env into
# the process, so a git child authenticates through gh with the fleet token; with a
# refusal it sets nothing and Send-FleetIdentityPageOnce pages once. watchdog.ps1
# calls both at the top of every tick.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-identity-env-test-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($k in 'FLEET_IDENTITY_DIR','FLEET_NO_TOAST','GH_CONFIG_DIR','GIT_CONFIG_SYSTEM','GH_TOKEN','GCM_INTERACTIVE','GIT_ASKPASS','GH_PROMPT_DISABLED','GIT_TERMINAL_PROMPT') { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }

# One child process per case: the env it ends with, and the credential git would send.
function Run-Case {
  param([string]$Tenant)
  Write-Utf8 "$testRoot\tenants\t.json" $Tenant
  $script = @"
. '$testRoot\bin\_common.ps1'
`$OutputEncoding = New-Object Text.UTF8Encoding `$false   # a BOM on stdin reads as a missing protocol field (CI runner)
Set-Location '$testRoot'
`$plan = Set-FleetIdentityProcessEnv
`$paged = Send-FleetIdentityPageOnce -Plan `$plan -Source 'watchdog.ps1'
[IO.File]::WriteAllText("$testRoot\cred-in.txt", "protocol=https``nhost=github.com``n``n", (New-Object Text.UTF8Encoding `$false))
# stdin from a file through cmd: PowerShell piping to a native exe mangles it on the CI runner
`$credProc = Start-Process -FilePath git -ArgumentList 'credential','fill' -RedirectStandardInput "$testRoot\cred-in.txt" -RedirectStandardOutput "$testRoot\cred-out.txt" -RedirectStandardError "$testRoot\cred-err.txt" -NoNewWindow -Wait -PassThru
`$cred = (Get-Content "$testRoot\cred-out.txt" -Raw) + (Get-Content "$testRoot\cred-err.txt" -Raw)
`$helpers = (& git config --show-origin --get-all credential.helper 2>&1 | Out-String)
[pscustomobject]@{ refusal = if (`$plan.refusal) { "`$(`$plan.refusal.code)" } else { `$null }; paged = `$paged; ghConfigDir = `$env:GH_CONFIG_DIR; ghToken = `$env:GH_TOKEN; cred = `$cred; helpers = `$helpers; gitconfig = (Get-Content `$env:GIT_CONFIG_SYSTEM -Raw -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress
"@
  Write-Utf8 "$testRoot\case.ps1" $script
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\case.ps1" 2>&1 | Out-String } finally { $ErrorActionPreference = $eap }
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { throw "case output unreadable: $out" }
}

try {
  foreach ($dir in 'bin','tenants','state','identity') { [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null }
  foreach ($f in '_common.ps1','identity.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\identity\hosts.yml" "github.com:`n    users:`n        fleet-bot:`n            oauth_token: ghp_watchdog_probe`n    git_protocol: https`n    oauth_token: ghp_watchdog_probe`n    user: fleet-bot`n"
  $env:FLEET_IDENTITY_DIR = "$testRoot\identity"
  $env:FLEET_NO_TOAST = '1'
  # GIT_TERMINAL_PROMPT=0 so a case that falls through to no helper fails fast instead of prompting.
  $env:GIT_TERMINAL_PROMPT = '0'

  # Present: the process env routes git through gh, which answers with the fleet token.
  $r1 = Run-Case '{"name":"t","fleetIdentity":"fleet-bot","ownerLogin":"cory-owner"}'
  Assert-True (-not $r1.refusal -and $r1.ghConfigDir -eq "$testRoot\identity") "the watchdog process must carry GH_CONFIG_DIR: $($r1 | ConvertTo-Json -Compress)"
  Assert-True ("$($r1.cred)" -match 'username=fleet-bot' -and "$($r1.cred)" -match 'password=ghp_watchdog_probe') ("a git push from the watchdog must authenticate as the fleet; credential (password redacted): " + (("$($r1.cred)") -replace 'password=\S+', 'password=REDACTED') + " helpers: $($r1.helpers) gitconfig: $($r1.gitconfig)")
  Assert-True ($r1.paged -eq $false) 'a clean plan pages nothing'

  # Required but missing: nothing is set, one high page, and a second tick does not page again.
  Remove-Item -Recurse -Force "$testRoot\identity"
  $r2 = Run-Case '{"name":"t","fleetIdentity":"fleet-bot","ownerLogin":"cory-owner"}'
  Assert-True ($r2.refusal -eq 'FLEET_IDENTITY_MISSING' -and -not $r2.ghConfigDir) "a refused plan must set no identity env: $($r2 | ConvertTo-Json -Compress)"
  Assert-True ("$($r2.cred)" -notmatch 'password=(gh[opsu]_|github_pat_)') 'a refused plan must leave git with no credentials, not the owner''s (credential not printed)'
  Assert-True ("$($r2.ghToken)" -like 'fleet-identity-refused-*') 'a refused plan must give gh a token that authenticates as nobody'
  Assert-True ($r2.paged -eq $true) 'a refused plan must page'
  $r3 = Run-Case '{"name":"t","fleetIdentity":"fleet-bot","ownerLogin":"cory-owner"}'
  Assert-True ($r3.paged -eq $false) 'the same refusal on the next tick must not page again'

  # watchdog.ps1 applies both at the top of every tick, right after the entry preamble.
  $wd = Get-Content "$sourceRoot\bin\watchdog.ps1" -Raw
  $common = $wd.IndexOf('. "$PSScriptRoot\_common.ps1"')
  $apply = $wd.IndexOf('$identityPlan = Set-FleetIdentityProcessEnv')
  $firstGit = $wd.IndexOf('& git')
  Assert-True ($common -ge 0 -and $apply -gt $common -and ($firstGit -lt 0 -or $apply -lt $firstGit)) 'watchdog.ps1 must set the identity env before any git call'
  Assert-True ($wd -match 'Send-FleetIdentityPageOnce -Plan \$identityPlan') 'watchdog.ps1 must page a refused identity'

  Write-Output 'identity process env tests passed'
} finally {
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue
}
