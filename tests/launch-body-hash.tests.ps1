# Regression: launch.ps1 must hash GitHub issue bodies as UTF-8 even when a
# Windows PowerShell child inherits an OEM console output encoding.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-launch-body-hash-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Run-Launch {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & "$testRoot\run-launch.cmd" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}

try {
  foreach ($dir in 'bin','agents','tenants','config','state','state/sessions','state/work','state/flags','state/manifests','mock-bin','repo') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1','identity.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: sonnet`neffort: low`n---`nRole body."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $repoPath = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","maxIcs":2,"repo":' + ($repoPath | ConvertTo-Json) + '}')
  Write-Utf8 "$testRoot\mock-bin\mock-gh.js" @'
'use strict';
process.stdout.write(JSON.stringify({ state: 'OPEN', body: 'criteria \u2014 non-ASCII' }));
'@
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" @'
@echo off
node "%~dp0mock-gh.js"
exit /b %errorlevel%
'@
  Write-Utf8 "$testRoot\run-launch.cmd" @'
@echo off
chcp 437 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\launch.ps1" %*
exit /b %errorlevel%
'@

  $body = 'criteria ' + [char]0x2014 + ' non-ASCII'
  $bodyHash = [BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($body))).Replace('-', '').ToLowerInvariant()
  $manifestPath = "$testRoot\state\manifests\assignment-test-1098.json"
  $manifest = [ordered]@{
    schemaVersion = 1; status = 'pending-ack'; id = 'assignment-test-1098'; workRecordId = 'test:issue-1098'; workRecordRevision = 1
    issue = [ordered]@{ number = 1098; bodyHash = $bodyHash; criteriaHash = $bodyHash; commentCount = 0 }; base = [ordered]@{ remote = 'origin'; ref = 'integration'; sha = ('a' * 40) }
    branch = 'fleet/1098-test'; tenant = 'test'; parent = 'pl-test'; model = 'sonnet'
  }
  Write-Utf8 $manifestPath ($manifest | ConvertTo-Json -Depth 8)
  $active = @{ records = @{ 'test:issue-1098' = @{ id = 'test:issue-1098'; issue = 1098; state = 'assigned'; manifestPath = $manifestPath } } }
  Write-Utf8 "$testRoot\state\work\active.json" ($active | ConvertTo-Json -Depth 8)
  Write-Utf8 "$testRoot\state\PAUSE" 'hash test'

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  # Claude Code 2.1.281 trust pre-flight (launch.ps1 Test-WorkspaceTrusted): trust the test root so every path under it launches.
  [IO.Directory]::CreateDirectory("$testRoot\profile") | Out-Null
  [IO.File]::WriteAllText("$testRoot\profile\.claude.json", ('{"projects":{' + ($testRoot | ConvertTo-Json) + ':{"hasTrustDialogAccepted":true}}}'), (New-Object Text.UTF8Encoding $false))
  $result = Run-Launch @('-Manifest', $manifestPath)
  Assert-True ($lastExit -eq 3 -and $result.launched -eq $false -and "$($result.reason)" -match 'PAUSE') "non-ASCII body must pass reconciliation and reach PAUSE: $lastOut"
  Assert-True (-not (Test-Path "$manifestPath.invalidated.json")) 'a matching non-ASCII body must not invalidate the manifest'
  Write-Output 'launch body hash tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-body-hash-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
