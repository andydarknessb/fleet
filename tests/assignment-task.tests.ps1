$ErrorActionPreference = 'Stop'
$fleetHome = Split-Path -Parent $PSScriptRoot
$launcher = Get-Content "$fleetHome\bin\launch.ps1" -Raw
$assignment = Get-Content "$fleetHome\bin\assignment.js" -Raw

if ($launcher -notmatch '\[string\]\$Manifest') { throw 'launch.ps1 must accept a manifest pointer' }
if ($launcher -notmatch '\[string\]\$WorkRecordId') { throw 'launch.ps1 must accept a Work record identity' }
if ($launcher -notmatch 'git -C \$cwd fetch') { throw 'manifest launches must fetch the intended remote base' }
if ($launcher -notmatch 'independenceProof') { throw 'manifest launches must enforce third-assignment independence proof' }
if ($launcher -notmatch 'missingReservationIssues') { throw 'manifest launches must fail closed when reservation evidence is missing' }
if ($launcher -notmatch 'state,body,comments') { throw 'manifest launches must reconcile the issue body and comments' }
if ($launcher -notmatch 'issue body and comments') { throw 'manifest launch prompts must tell the IC to read the issue body and comments' }
if ($assignment -notmatch 'launchScript.*Manifest') { throw 'assignment launcher must route through launch.ps1 with a manifest' }
if ($assignment -notmatch 'reservation-conflict') { throw 'frontier must expose reservation conflict evidence' }

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-third-launch-" + [guid]::NewGuid().ToString('N'))
try {
  foreach ($dir in 'bin','tenants','repo','state','state/work') { [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null }
  [IO.File]::Copy("$fleetHome\bin\_common.ps1", "$testRoot\bin\_common.ps1")
  [IO.File]::Copy("$fleetHome\bin\launch.ps1", "$testRoot\bin\launch.ps1")
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $repo = (Join-Path $testRoot 'repo')
  [IO.File]::WriteAllText("$testRoot\roster.json", '{"cap":6,"sessions":[]}', $utf8)
  [IO.File]::WriteAllText("$testRoot\fleet-settings.json", '{}', $utf8)
  [IO.File]::WriteAllText("$testRoot\tenants\test.json", (@{ name = 'test'; repo = $repo; maxIcs = 3 } | ConvertTo-Json), $utf8)
  $proof = @{ independent = $true; candidates = @(40, 41, 42); checkedFields = @('components', 'migrationPrefixes', 'schemaAreas', 'testResources'); conflicts = @() }
  $manifest = @{ status = 'pending-ack'; workRecordId = 'test:issue-42'; issue = @{ number = 42 }; tenant = 'test'; parent = 'pl-test'; model = 'sonnet'; independenceProof = $proof }
  $manifestPath = "$testRoot\assignment-42.json"
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), $utf8)
  $records = @{
    'test:issue-40' = @{ id = 'test:issue-40'; issue = 40; state = 'implementing'; manifestPath = 'm40'; reservations = @{} }
    'test:issue-41' = @{ id = 'test:issue-41'; issue = 41; state = 'implementing'; manifestPath = 'm41'; reservations = @{} }
    'test:issue-42' = @{ id = 'test:issue-42'; issue = 42; state = 'assigned'; manifestPath = $manifestPath; reservations = @{} }
  }
  [IO.File]::WriteAllText("$testRoot\state\work\active.json", (@{ records = $records } | ConvertTo-Json -Depth 8), $utf8)
  $oldEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $output = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" -Manifest $manifestPath -DryRun 2>&1 | Out-String }
  finally { $exitCode = $LASTEXITCODE; $ErrorActionPreference = $oldEap }
  if ($exitCode -ne 4 -or $output -notmatch 'verified independent machine-readable proof') { throw "launch.ps1 accepted a third assignment without reservation evidence: $output" }
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'assignment task tests passed'
