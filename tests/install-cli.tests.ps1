# #336 (ADR 0016 Amendment 7): bin/install-cli.ps1 and Set-ClaudeAutoUpdaterOff, against a fake npm.
# Red-tell: the side-by-side install runs `npm install --prefix <USERPROFILE>\.fleet-cli\<v>` and the global one
# `npm install -g`; a second run skips npm; the printed path passes Test-ClaudeCliCandidate; a bad version, a failing
# npm and an npm that leaves a stub each print {ok:false} and exit 2; the settings merge keeps the other keys.
$ErrorActionPreference = 'Stop'
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$bin = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin'
. "$bin\_common.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('fleet-installcli-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$home1 = Join-Path $testRoot 'home'; $appdata = Join-Path $testRoot 'appdata'
[IO.Directory]::CreateDirectory($home1) | Out-Null; [IO.Directory]::CreateDirectory($appdata) | Out-Null
$log = Join-Path $testRoot 'npm.log'

# The fake npm lays the package where the real one would, and logs its arguments.
Write-Utf8 "$testRoot\fakenpm.ps1" @'
param([Parameter(ValueFromRemainingArguments)]$a)
Add-Content $env:FAKE_NPM_LOG ($a -join ' ')
if ($env:FAKE_NPM_FAIL) { [Console]::Error.WriteLine('ERR! boom'); exit 1 }
$ver = ($a[-1] -split '@')[-1]
$root = if ($a -contains '-g') { Join-Path $env:APPDATA 'npm' } else { $a[[array]::IndexOf($a, '--prefix') + 1] }
$pkg = Join-Path $root 'node_modules\@anthropic-ai\claude-code'
New-Item -ItemType Directory -Force "$pkg\bin" | Out-Null
Set-Content "$pkg\package.json" ('{"version":"' + $ver + '"}')
$size = if ($env:FAKE_NPM_STUB) { 100 } else { 5000 }
[IO.File]::WriteAllBytes("$pkg\bin\claude.exe", (New-Object byte[] $size))
'@
Write-Utf8 "$testRoot\npm.cmd" ('@powershell -NoProfile -ExecutionPolicy Bypass -File "' + $testRoot + '\fakenpm.ps1" %*' + "`r`n")

function Install { param([string[]]$More = @())
  $env:USERPROFILE = $home1; $env:APPDATA = $appdata; $env:FAKE_NPM_LOG = $log
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$bin\install-cli.ps1" @More -NpmExe "$testRoot\npm.cmd" | Out-String
  [pscustomobject]@{ exit = $LASTEXITCODE; json = (($out.Trim() -split "`n")[-1] | ConvertFrom-Json); lines = @($out.Trim() -split "`n").Count }
}
$savedProfile = $env:USERPROFILE; $savedAppData = $env:APPDATA
try {
  # Side by side: --prefix under .fleet-cli\<v>, one JSON line, a path that is a usable CLI.
  $r = Install @('-Version', '2.1.400')
  Assert-True ($r.exit -eq 0 -and $r.json.ok -and $r.json.version -eq '2.1.400') "side-by-side must succeed: $($r.json | ConvertTo-Json -Compress)"
  Assert-True ($r.lines -eq 1) 'exactly one output line'
  Assert-True ($r.json.path -eq "$home1\.fleet-cli\2.1.400\node_modules\@anthropic-ai\claude-code\bin\claude.exe") "path: $($r.json.path)"
  Assert-True (Test-ClaudeCliCandidate $r.json.path) 'path must pass Test-ClaudeCliCandidate'
  Assert-True ((Get-Content $log -Raw) -match "install --prefix .*fleet-cli.2.1.400 @anthropic-ai/claude-code@2.1.400") 'npm install --prefix args'
  Assert-True (-not ((Get-Content $log -Raw) -match ' -g ')) 'the side-by-side install is not global'

  # Idempotent: the second run does not call npm.
  $before = @(Get-Content $log).Count
  $r = Install @('-Version', '2.1.400')
  Assert-True ($r.json.ok -and @(Get-Content $log).Count -eq $before) 'a present version must skip npm'

  # Global: npm install -g, package under %APPDATA%\npm.
  $r = Install @('-Version', '2.1.401', '-Global')
  Assert-True ($r.json.ok -and $r.json.path -eq "$appdata\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe") "global path: $($r.json.path)"
  Assert-True ((Get-Content $log -Raw) -match 'install -g @anthropic-ai/claude-code@2\.1\.401') 'npm install -g args'

  # A different version at the same place installs again.
  $before = @(Get-Content $log).Count
  $r = Install @('-Version', '2.1.402', '-Global')
  Assert-True ($r.json.ok -and @(Get-Content $log).Count -eq $before + 1 -and (Get-Content "$appdata\npm\node_modules\@anthropic-ai\claude-code\package.json" -Raw) -match '2\.1\.402') 'a new version must run npm'

  # Refusals: bad version, failing npm, npm that leaves the placeholder stub.
  $r = Install @('-Version', '2.1')
  Assert-True ($r.exit -eq 2 -and -not $r.json.ok -and $r.json.reason -match 'x\.y\.z') 'a bad version exits 2'
  $env:FAKE_NPM_FAIL = '1'
  $r = Install @('-Version', '2.1.403')
  Assert-True ($r.exit -eq 2 -and -not $r.json.ok -and $r.json.reason -match 'npm exited 1') "failing npm: $($r.json | ConvertTo-Json -Compress)"
  Remove-Item Env:\FAKE_NPM_FAIL
  $env:FAKE_NPM_STUB = '1'
  $r = Install @('-Version', '2.1.404')
  Assert-True ($r.exit -eq 2 -and -not $r.json.ok) 'a stub claude.exe is not an install'
  Remove-Item Env:\FAKE_NPM_STUB

  # Set-ClaudeAutoUpdaterOff merges and never clobbers.
  $sp = Join-Path $testRoot 'claude\settings.json'
  Set-ClaudeAutoUpdaterOff -SettingsPath $sp -SkipUserEnv
  Assert-True ((Get-Content $sp -Raw | ConvertFrom-Json).env.DISABLE_AUTOUPDATER -eq '1') 'created with the flag'
  Write-Utf8 $sp '{"model":"opus","env":{"KEEP":"yes","DISABLE_AUTOUPDATER":"0"}}'
  Set-ClaudeAutoUpdaterOff -SettingsPath $sp -SkipUserEnv
  $s = Get-Content $sp -Raw | ConvertFrom-Json
  Assert-True ($s.model -eq 'opus' -and $s.env.KEEP -eq 'yes' -and $s.env.DISABLE_AUTOUPDATER -eq '1') 'merge keeps other keys and fixes the flag'
  Write-Utf8 $sp '{"model":"opus"}'
  Set-ClaudeAutoUpdaterOff -SettingsPath $sp -SkipUserEnv
  $s = Get-Content $sp -Raw | ConvertFrom-Json
  Assert-True ($s.model -eq 'opus' -and $s.env.DISABLE_AUTOUPDATER -eq '1') 'adds env when absent'
  # An unparseable file is left untouched and reported, under the Continue preference setup.ps1 runs with.
  Write-Utf8 $sp '{not json'
  $ErrorActionPreference = 'Continue'
  $did = Set-ClaudeAutoUpdaterOff -SettingsPath $sp -SkipUserEnv
  $ErrorActionPreference = 'Stop'
  Assert-True (-not $did -and (Get-Content $sp -Raw) -eq '{not json') 'an unparseable file is left alone and reported'

  # -KillTree: a timeout takes the grandchild down too.
  Write-Utf8 "$testRoot\child.ps1" ('$p = Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList "-NoProfile","-Command","Start-Sleep 120"; Set-Content "' + $testRoot + '\grand.pid" $p.Id; Start-Sleep 120')
  $r = Invoke-BoundedExe -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-File', "$testRoot\child.ps1") -TimeoutSec 8 -Name 'tree' -KillTree
  Assert-True $r.timedOut 'the child timed out'
  Start-Sleep -Milliseconds 500
  $gp = [int](Get-Content "$testRoot\grand.pid")
  Assert-True (-not (Get-Process -Id $gp -ErrorAction SilentlyContinue)) 'KillTree must kill the grandchild'
  Write-Output 'install-cli tests passed'
} finally {
  $env:USERPROFILE = $savedProfile; $env:APPDATA = $savedAppData
  Remove-Item Env:\FAKE_NPM_FAIL, Env:\FAKE_NPM_STUB -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue
}
