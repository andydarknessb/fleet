# The launch door's assignment count is per tenant (fleet: nidus #2 blocked 2026-09-25).
# launch.ps1 counted every tenant's active assignments, so two endzone ICs made a nidus
# manifest look like a third assignment (proof required) and three made it a fourth
# (refused outright). work-state.js already scopes by tenant (isForeignRecord); the door
# must agree. A same-tenant third assignment still needs the independence proof.
$ErrorActionPreference = 'Stop'
$fleetHome = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false

function Invoke-ManifestDryRun {
  param([string]$Label, [hashtable[]]$ActiveRecords, [string]$ManifestTenant)
  $testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-tenant-scope-" + [guid]::NewGuid().ToString('N'))
  try {
    foreach ($dir in 'bin','tenants','repo','state','state/work') { [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null }
    [IO.File]::Copy("$fleetHome\bin\_common.ps1", "$testRoot\bin\_common.ps1")
    [IO.File]::Copy("$fleetHome\bin\launch.ps1", "$testRoot\bin\launch.ps1")
    $repo = (Join-Path $testRoot 'repo')
    [IO.File]::WriteAllText("$testRoot\roster.json", '{"cap":6,"sessions":[]}', $utf8)
    [IO.File]::WriteAllText("$testRoot\fleet-settings.json", '{}', $utf8)
    foreach ($tenant in 'endzone','nidus') {
      [IO.File]::WriteAllText("$testRoot\tenants\$tenant.json", (@{ name = $tenant; repo = $repo; maxIcs = 3 } | ConvertTo-Json), $utf8)
    }
    $manifest = @{ status = 'pending-ack'; workRecordId = "${ManifestTenant}:issue-2"; issue = @{ number = 2 }; tenant = $ManifestTenant; parent = "pl-$ManifestTenant"; model = 'sonnet' }
    $manifestPath = "$testRoot\assignment-2.json"
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), $utf8)
    $records = @{}
    foreach ($record in $ActiveRecords) {
      $records[$record.id] = @{ id = $record.id; tenant = $record.tenant; issue = $record.issue; state = 'implementing'; manifestPath = "m$($record.issue)"; reservations = @{} }
    }
    $records["${ManifestTenant}:issue-2"] = @{ id = "${ManifestTenant}:issue-2"; tenant = $ManifestTenant; issue = 2; state = 'assigned'; manifestPath = $manifestPath; reservations = @{} }
    [IO.File]::WriteAllText("$testRoot\state\work\active.json", (@{ records = $records } | ConvertTo-Json -Depth 8), $utf8)
    $oldEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $output = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" -Manifest $manifestPath -DryRun 2>&1 | Out-String }
    finally { $exitCode = $LASTEXITCODE; $ErrorActionPreference = $oldEap }
    return [pscustomobject]@{ label = $Label; exitCode = $exitCode; output = $output }
  } finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$endzoneTwo = @(
  @{ id = 'endzone:issue-1671'; tenant = 'endzone'; issue = 1671 },
  @{ id = 'endzone:issue-1673'; tenant = 'endzone'; issue = 1673 }
)
$endzoneThree = $endzoneTwo + @(@{ id = 'endzone:issue-1680'; tenant = 'endzone'; issue = 1680 })
$nidusTwo = @(
  @{ id = 'nidus:issue-3'; tenant = 'nidus'; issue = 3 },
  @{ id = 'nidus:issue-4'; tenant = 'nidus'; issue = 4 }
)

# 1. Two endzone ICs active: a nidus manifest is nidus's FIRST assignment, no proof needed.
$r = Invoke-ManifestDryRun -Label 'two foreign' -ActiveRecords $endzoneTwo -ManifestTenant 'nidus'
# PS 5.1 wraps Write-Error text at console width, so match a fragment that survives the wrap.
if ($r.output -match 'machine-readable proof') { throw "launch.ps1 counted endzone's assignments against nidus (proof demanded): $($r.output)" }

# 2. Three endzone ICs active: still not a fourth assignment for nidus.
$r = Invoke-ManifestDryRun -Label 'three foreign' -ActiveRecords $endzoneThree -ManifestTenant 'nidus'
if ($r.output -match 'fourth') { throw "launch.ps1 refused nidus as a fourth assignment on endzone's count: $($r.output)" }

# 3. Control: two nidus ICs active, a third nidus manifest without a proof is still refused.
$r = Invoke-ManifestDryRun -Label 'same tenant third' -ActiveRecords $nidusTwo -ManifestTenant 'nidus'
if ($r.exitCode -ne 4 -or $r.output -notmatch 'verified independent machine-readable proof') { throw "launch.ps1 stopped enforcing the same-tenant third-assignment proof: exit $($r.exitCode) $($r.output)" }

Write-Output 'launch tenant-scope tests passed'
