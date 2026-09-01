$ErrorActionPreference = 'Stop'
$fleetHome = Split-Path -Parent $PSScriptRoot
$launcher = Get-Content "$fleetHome\bin\launch.ps1" -Raw
$assignment = Get-Content "$fleetHome\bin\assignment.js" -Raw

if ($launcher -notmatch '\[string\]\$Manifest') { throw 'launch.ps1 must accept a manifest pointer' }
if ($launcher -notmatch '\[string\]\$WorkRecordId') { throw 'launch.ps1 must accept a Work record identity' }
if ($launcher -notmatch 'git -C \$cwd fetch') { throw 'manifest launches must fetch the intended remote base' }
if ($launcher -notmatch 'independenceProof') { throw 'manifest launches must enforce third-assignment independence proof' }
if ($assignment -notmatch 'launchScript.*Manifest') { throw 'assignment launcher must route through launch.ps1 with a manifest' }
if ($assignment -notmatch 'reservation-conflict') { throw 'frontier must expose reservation conflict evidence' }
Write-Output 'assignment task tests passed'
