<#
.SYNOPSIS  #336 (ADR 0016 Amendment 7): install one pinned claude CLI version.
  -Version x.y.z, no -Global: npm install --prefix %USERPROFILE%\.fleet-cli\<x.y.z> @anthropic-ai/claude-code@<x.y.z>
                              (a side-by-side copy for `claude -p` probes; it never touches the global CLI)
  -Version x.y.z -Global:     npm install -g @anthropic-ai/claude-code@<x.y.z> (what bin/deploy-live.ps1 runs)
  Idempotent: when the target package already holds that version and its claude.exe passes
  Test-ClaudeCliCandidate, npm does not run. Prints one JSON line {ok, version, path} (path is the
  package's bin\claude.exe), or {ok:false, reason} with exit 2. -NpmExe lets a test stand in for npm.
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [switch]$Global,
  [string]$NpmExe = 'npm'
)
$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\_common.ps1"

function Fail { param([string]$Reason) Write-Output ([pscustomobject]@{ ok = $false; reason = $Reason } | ConvertTo-Json -Compress); exit 2 }

if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "-Version must be x.y.z, got '$Version'" }
$pkgRel = 'node_modules\@anthropic-ai\claude-code'
if ($Global) {
  if (-not $env:APPDATA) { Fail 'APPDATA is not set; cannot place the global package' }
  $pkgDir = Join-Path $env:APPDATA "npm\$pkgRel"
  $npmArgs = @('install', '-g', "@anthropic-ai/claude-code@$Version")
} else {
  if (-not $env:USERPROFILE) { Fail 'USERPROFILE is not set; cannot place the side-by-side copy' }
  $prefix = Join-Path $env:USERPROFILE ".fleet-cli\$Version"
  $pkgDir = Join-Path $prefix $pkgRel
  $npmArgs = @('install', '--prefix', $prefix, "@anthropic-ai/claude-code@$Version")
}
$exe = Join-Path $pkgDir 'bin\claude.exe'

function Test-Installed {
  if (-not (Test-ClaudeCliCandidate $exe)) { return $false }
  try { return ("$((Get-Content (Join-Path $pkgDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version)" -eq $Version) } catch { return $false }
}

if (-not (Test-Installed)) {
  $out = & $NpmExe @npmArgs 2>&1
  $npmExit = $LASTEXITCODE
  if ($npmExit -ne 0) {
    $text = ((@($out | ForEach-Object { "$_" }) -join ' ') -replace '\s+', ' ').Trim()
    if ($text.Length -gt 300) { $text = $text.Substring(0, 300) }
    Fail "npm exited ${npmExit}: $text"
  }
  if (-not (Test-Installed)) { Fail "npm succeeded but $exe is not claude-code $Version" }
}
Write-Output ([pscustomobject]@{ ok = $true; version = $Version; path = $exe } | ConvertTo-Json -Compress)
exit 0
