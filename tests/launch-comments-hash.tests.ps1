$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Criteria-Hash { param([string]$Body, $Comments)
  $parts = @($Body)
  foreach ($comment in @($Comments | Sort-Object createdAt,id)) { $parts += @([string]$comment.id, [string]$comment.createdAt, [string]$comment.body) }
  $text = $parts -join [char]0
  [BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLowerInvariant()
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-launch-comments-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldComment = $env:FLEET_TEST_ISSUE_COMMENT

function Run-Launch {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" -Manifest $manifestPath 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}

try {
  foreach ($dir in 'bin','agents','tenants','config','state','state/sessions','state/work','state/events','state/flags','state/manifests','mock-bin','repo') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($file in '_common.ps1','launch.ps1','work-state.js') { [IO.File]::Copy("$sourceRoot\bin\$file", "$testRoot\bin\$file") }
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: sonnet`neffort: low`n---`nRole body."
  Write-Utf8 "$testRoot\fleet-settings.json" '{}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $repoPath = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","maxIcs":2,"repo":' + ($repoPath | ConvertTo-Json) + '}')
  Write-Utf8 "$testRoot\mock-bin\mock-gh.js" @'
'use strict';
const body = 'original criteria';
const comments = [{ id: 'comment-1', createdAt: '2026-09-01T01:00:00Z', body: process.env.FLEET_TEST_ISSUE_COMMENT }];
process.stdout.write(JSON.stringify({ state: 'OPEN', body, comments }));
'@
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" @'
@echo off
node "%~dp0mock-gh.js" %*
exit /b %errorlevel%
'@

  $body = 'original criteria'
  $comments = @([pscustomobject]@{ id = 'comment-1'; createdAt = '2026-09-01T01:00:00Z'; body = 'Use ruling A.' })
  $manifestPath = "$testRoot\state\manifests\assignment-test-1108.json"
  $manifest = [ordered]@{
    schemaVersion = 1; status = 'pending-ack'; id = 'assignment-test-1108'; workRecordId = 'test:issue-1108'; workRecordRevision = 1
    issue = [ordered]@{ number = 1108; bodyHash = (Criteria-Hash $body @()); criteriaHash = (Criteria-Hash $body $comments); commentCount = 1 }
    base = [ordered]@{ remote = 'origin'; ref = 'integration'; sha = ('a' * 40) }
    branch = 'fleet/1108-test'; tenant = 'test'; parent = 'pl-test'; model = 'sonnet'
  }
  Write-Utf8 $manifestPath ($manifest | ConvertTo-Json -Depth 8)
  $null = & node "$testRoot\bin\work-state.js" reserve --root $testRoot --id test:issue-1108 --tenant test --issue 1108 --manifest $manifestPath --idempotency-key reserve-1108
  if ($LASTEXITCODE -ne 0) { throw 'fixture reservation failed' }
  Write-Utf8 "$testRoot\state\PAUSE" 'comments test'
  $env:PATH = "$testRoot\mock-bin;$oldPath"

  $env:FLEET_TEST_ISSUE_COMMENT = 'Use ruling A.'
  $matching = Run-Launch
  Assert-True ($lastExit -eq 3 -and "$($matching.reason)" -match 'PAUSE') "matching comment criteria must reach PAUSE: $lastOut"

  $env:FLEET_TEST_ISSUE_COMMENT = 'CORRECTION: use ruling B.'
  $null = Run-Launch
  Assert-True ($lastExit -eq 4 -and $lastOut -match 'criteria changed') "a comment-only correction must invalidate launch: $lastOut"
  Assert-True (Test-Path "$manifestPath.invalidated.json") 'comment drift must invalidate the manifest and release its reservation'
  Write-Output 'launch comments hash tests passed'
} finally {
  $env:PATH = $oldPath
  $env:FLEET_TEST_ISSUE_COMMENT = $oldComment
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-comments-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) { [IO.Directory]::Delete($resolved, $true) }
}
