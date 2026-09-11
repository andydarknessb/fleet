# Ticket 06 startup fixtures: each role sees only its own scoped, unexpired notices;
# the global NOTICE.md is out of automatic injection unless the legacy flag restores it;
# a rotation replacement is told to reconstruct from canonical state.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-session-start-test-" + [guid]::NewGuid().ToString('N'))
$hook = "$sourceRoot\hooks\session-start.ps1"
$saved = @{}
foreach ($v in 'FLEET_HOME','FLEET_NAME','FLEET_ROLE','FLEET_TENANT','FLEET_PARENT','FLEET_ISSUE') { $saved[$v] = [Environment]::GetEnvironmentVariable($v) }

function Run-Hook {
  param([string]$Name, [string]$Role, [string]$Tenant, [string]$StdinJson = '')
  $env:FLEET_HOME = $testRoot; $env:FLEET_NAME = $Name; $env:FLEET_ROLE = $Role; $env:FLEET_TENANT = $Tenant; $env:FLEET_PARENT = 'test-parent'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { return ($StdinJson | & powershell -NoProfile -ExecutionPolicy Bypass -File $hook 2>&1 | Out-String) }
  finally { $ErrorActionPreference = $eap }
}

try {
  foreach ($dir in 'state','state/notices','state/work','state/archive','state/rotation','state/flags','tenants') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[{"name":"pl-endzone","role":"project-lead","status":"active"}]}'
  Write-Utf8 "$testRoot\state\NOTICE.md" 'GLOBAL-LEGACY-BOARD content.'
  Write-Utf8 "$testRoot\state\notices\all.md" ("EVERYONE-RULE stands.`n`nEXPIRED-ALL-RULE [until 2026-01-01] is over.")
  Write-Utf8 "$testRoot\state\notices\project-lead.md" ("LEAD-RULE stands.`n`nFUTURE-LEAD-RULE [until 2999-12-31] stands.`n`nCLEARED-LEAD-RULE [cleared-by endzone:issue-7 merged] waits on the merge.`n`nPENDING-LEAD-RULE [cleared-by endzone:issue-8 merged] waits on the merge.")
  Write-Utf8 "$testRoot\state\notices\ic.md" 'IC-ONLY-RULE stands.'
  Write-Utf8 "$testRoot\state\notices\tenant-endzone.md" 'ENDZONE-TENANT-RULE stands.'
  Write-Utf8 "$testRoot\state\notices\tenant-other.md" 'OTHER-TENANT-RULE stands.'
  Write-Utf8 "$testRoot\state\work\active.json" '{"schemaVersion":1,"records":{"endzone:issue-7":{"id":"endzone:issue-7","state":"merged"},"endzone:issue-8":{"id":"endzone:issue-8","state":"review"}}}'

  # Case 1: the project lead sees all + role + own-tenant boards, filtered.
  $out = Run-Hook 'pl-endzone' 'project-lead' 'endzone'
  Assert-True ($out -match 'EVERYONE-RULE') 'the all board must inject'
  Assert-True ($out -match 'LEAD-RULE') 'the role board must inject'
  Assert-True ($out -match 'FUTURE-LEAD-RULE') 'an unexpired dated notice must inject'
  Assert-True ($out -match 'ENDZONE-TENANT-RULE') 'the own-tenant board must inject'
  Assert-True ($out -notmatch 'EXPIRED-ALL-RULE') 'an expired notice must be absent'
  Assert-True ($out -notmatch 'CLEARED-LEAD-RULE') 'a notice whose clearing state was reached must be absent'
  Assert-True ($out -match 'PENDING-LEAD-RULE') 'a notice whose clearing state is not reached must stay'
  Assert-True ($out -notmatch 'IC-ONLY-RULE') 'another role board must be absent'
  Assert-True ($out -notmatch 'OTHER-TENANT-RULE') 'an unrelated tenant board must be absent'
  Assert-True ($out -notmatch 'GLOBAL-LEGACY-BOARD') 'the global NOTICE.md must be out of automatic injection'
  Assert-True ($out -match 'Roster \(active\)') 'a control-plane role keeps the roster line'

  # Case 2: an IC with no tenant env sees no tenant boards; an archived record clears.
  Write-Utf8 "$testRoot\state\archive\work-endzone_issue-9.json" '{"record":{"id":"endzone:issue-9","state":"retired"}}'
  Write-Utf8 "$testRoot\state\notices\ic.md" ("IC-ONLY-RULE stands.`n`nARCHIVED-CLEAR-RULE [cleared-by endzone:issue-9 merged] waits.")
  $out2 = Run-Hook 'ic-42' 'ic' ''
  Assert-True ($out2 -match 'IC-ONLY-RULE') 'the ic board must inject for an IC'
  Assert-True ($out2 -notmatch 'ARCHIVED-CLEAR-RULE') 'an archived record must clear its notice'
  Assert-True ($out2 -notmatch 'LEAD-RULE') 'the lead board must be absent for an IC'
  Assert-True ($out2 -notmatch 'ENDZONE-TENANT-RULE') 'a tenant board must be absent without a tenant'
  Assert-True ($out2 -notmatch 'Roster \(active\)') 'an IC must not receive the roster line'

  # Case 3: the legacy flag restores NOTICE.md and unfiltered boards.
  Write-Utf8 "$testRoot\state\flags\legacy-notice" 'rollback'
  $out3 = Run-Hook 'pl-endzone' 'project-lead' 'endzone'
  Assert-True ($out3 -match 'GLOBAL-LEGACY-BOARD') 'the legacy flag must restore NOTICE.md injection'
  Assert-True ($out3 -match 'LEGACY PATH') 'the restored path must be labeled'
  Assert-True ($out3 -match 'EXPIRED-ALL-RULE') 'the legacy flag must restore unfiltered boards'
  Remove-Item "$testRoot\state\flags\legacy-notice"

  # Case 4: the handoff reaches only the session the rotation launched (id match).
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" '{"schemaVersion":1,"name":"pl-endzone","phase":"launched","reasons":["age 25.0h >= 24h"],"savedAt":"2026-09-02T10:00:00.000Z","newSessionId":"sess-replacement","offset":{"totalEvents":41},"reconcile":{"at":"2026-09-02T10:01:00.000Z","ok":true}}'
  $out4 = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-replacement"}'
  Assert-True ($out4 -match 'ROTATION: you replace a predecessor') 'the rotation replacement must get the handoff'
  Assert-True ($out4 -match '41 events') 'the handoff must carry the saved offset'
  Assert-True ($out4 -match 'reconciled against GitHub at: 2026-09-02T10:01') 'the handoff must carry the reconcile time'
  $out4b = Run-Hook 'dispatcher' 'dispatcher' '' '{"session_id":"sess-dispatcher"}'
  Assert-True ($out4b -notmatch 'ROTATION:') 'another session must not see the handoff'
  # ADR 0010: gated roles are told the researcher is official and whether the gate stands.
  $outR1 = Run-Hook -Name 'ic-7' -Role 'ic' -Tenant 'test'
  Assert-True ($outR1 -match 'official researcher \(ADR 0010\)' -and $outR1 -match 'gate on') 'an IC must be told the researcher is official and the gate is on'
  $outR2 = Run-Hook -Name 'sentinel' -Role 'sentinel' -Tenant ''
  Assert-True ($outR2 -notmatch 'official researcher') 'the sentinel runs scripts only and is not gated'
  Write-Utf8 "$testRoot\state\flags\research-gate-off" ''
  $outR3 = Run-Hook -Name 'ic-7' -Role 'ic' -Tenant 'test'
  Assert-True ($outR3 -match 'gate off') 'the rollback flag must be reported'
  Remove-Item "$testRoot\state\flags\research-gate-off" -Force
  $out4c = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-later-respawn"}'
  Assert-True ($out4c -notmatch 'ROTATION:') 'a later respawn of the same name must not inherit the stale handoff'

  # Case 5: an incomplete intent (phase stopped) prints no handoff.
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" '{"schemaVersion":1,"name":"pl-endzone","phase":"stopped","reasons":["age"],"savedAt":"2026-09-02T10:00:00.000Z","newSessionId":"sess-replacement","offset":{"totalEvents":41}}'
  $out5 = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-replacement"}'
  Assert-True ($out5 -notmatch 'ROTATION:') 'an incomplete rotation must not claim a completed handoff'

  Write-Output 'session-start tests passed'
} finally {
  foreach ($v in $saved.Keys) { [Environment]::SetEnvironmentVariable($v, $saved[$v]) }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-session-start-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
