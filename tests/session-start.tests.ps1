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

  # Case 5b (fleet #230): the race. rotate.ps1 writes `phase: launching` + `launchingAt`
  # BEFORE calling launch.ps1, and launch.ps1 only learns the session id from the daemon
  # list after `claude --bg` returns; the replacement's SessionStart hook can run before
  # `launched` + `newSessionId` are written. The session the rotation launched (source
  # `startup`, name match, started inside the launching window) must get the handoff.
  $nowUtc = (Get-Date).ToUniversalTime()
  $launchingAt = $nowUtc.AddSeconds(-5).ToString('o')
  $launchingIntent = '{"schemaVersion":1,"name":"pl-endzone","phase":"launching","launchingAt":"' + $launchingAt + '","reasons":["age 25.0h >= 24h"],"savedAt":"' + $nowUtc.AddSeconds(-12).ToString('o') + '","oldSessionId":"sess-old","offset":{"totalEvents":41},"reconcile":{"at":"2026-09-02T10:01:00.000Z","ok":true}}'
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" $launchingIntent
  $out5b = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-replacement","source":"startup"}'
  Assert-True ($out5b -match 'ROTATION: you replace a predecessor') 'the session a rotation launched must get the handoff while the intent is still in the pre-launch (launching) phase'
  Assert-True ($out5b -match '41 events') 'the pre-launch handoff must carry the saved offset'
  # 5c: the window is scoped by the name inside the intent too: pl-endzone's file that
  # names another session is not pl-endzone's handoff, even inside the window.
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" ($launchingIntent.Replace('"name":"pl-endzone"', '"name":"pl-other"'))
  $out5c = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-replacement","source":"startup"}'
  Assert-True ($out5c -notmatch 'ROTATION:') 'an intent naming another session must not hand off inside the launching window'
  # 5c2: path scoping: a session with no intent file of its own gets nothing.
  $out5c2 = Run-Hook 'dispatcher' 'dispatcher' '' '{"session_id":"sess-dispatcher","source":"startup"}'
  Assert-True ($out5c2 -notmatch 'ROTATION:') 'another name starting inside the launching window must not see the handoff'
  # 5d: a launching intent whose window has long passed (rotate.ps1 died mid-launch) is stale:
  # a hand launch of the name minutes later must not inherit it.
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" ($launchingIntent.Replace($launchingAt, $nowUtc.AddMinutes(-10).ToString('o')))
  $out5d = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-hand-launch","source":"startup"}'
  Assert-True ($out5d -notmatch 'ROTATION:') 'a launching intent older than the window must not hand off to a later session of the name'
  # 5e: only a session START is the replacement; a resume, clear or compact of some other
  # session of the name inside the window is not.
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" $launchingIntent
  foreach ($source in @('resume', 'compact', 'clear')) {
    $out5e = Run-Hook 'pl-endzone' 'project-lead' 'endzone' ('{"session_id":"sess-other","source":"' + $source + '"}')
    Assert-True ($out5e -notmatch 'ROTATION:') "a SessionStart of source '$source' inside the launching window must not claim the handoff"
  }
  # 5f: a failed launch is written back as `stopped` with launchError; the launchingAt it
  # carries from the attempt must not make a later session of the name read it as its own.
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" ($launchingIntent.Replace('"phase":"launching"', '"phase":"stopped","launchError":{"at":"' + $nowUtc.ToString('o') + '","reason":"cap reached (6/6)"}'))
  $out5f = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-after-failure","source":"startup"}'
  Assert-True ($out5f -notmatch 'ROTATION:') 'a failed launch (phase stopped, launchError) must leave no handoff for a later session of the name'
  # 5g: once rotate.ps1 has written `launched` + newSessionId, the exact-id match governs
  # again: the launched session still gets it, a different id does not (as :75 and :86).
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" ($launchingIntent.Replace('"phase":"launching"', '"phase":"launched","newSessionId":"sess-replacement","newJobId":"job-new"'))
  $out5g = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-replacement","source":"startup"}'
  Assert-True ($out5g -match 'ROTATION: you replace a predecessor') 'after the launched write the exact id still gets the handoff'
  $out5g2 = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-later-respawn","source":"startup"}'
  Assert-True ($out5g2 -notmatch 'ROTATION:') 'after the launched write a different id inside the window must not get the handoff'

  # 5h (fleet #230 QA, residual 5a): launch.ps1 can accept a daemon row with an empty
  # sessionId, so rotate.ps1 writes `launched` with an empty newSessionId. That intent
  # matches no id, so the same window rules apply; outside them it hands off to nobody.
  $emptyIdIntent = $launchingIntent.Replace('"phase":"launching"', '"phase":"launched","newSessionId":"","newJobId":"job-new"')
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" $emptyIdIntent
  $out5h = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-replacement","source":"startup"}'
  Assert-True ($out5h -match 'ROTATION: you replace a predecessor') 'a launched intent with an empty newSessionId must still hand off inside the window'
  $out5h2 = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-replacement","source":"resume"}'
  Assert-True ($out5h2 -notmatch 'ROTATION:') 'an empty-id launched intent must not hand off to a resume'
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" ($emptyIdIntent.Replace($launchingAt, $nowUtc.AddMinutes(-10).ToString('o')))
  $out5h3 = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-hand-launch","source":"startup"}'
  Assert-True ($out5h3 -notmatch 'ROTATION:') 'an empty-id launched intent older than the window must not hand off'

  # Case 5i (#311): a lead the watchdog woke (a reason starting `frontier-wake:`) gets a wake brief, not a rebuild
  # from canonical state; any other rotation reason keeps the old reconstruct line. Both open the same way.
  $wakeReasons = '"reasons":["frontier-wake: outbox checks-settled x1 [records: checks-settled endzone:issue-30]"]'
  $wakeIntent = '{"schemaVersion":1,"name":"pl-endzone","phase":"launched",' + $wakeReasons + ',"savedAt":"2026-09-02T10:00:00.000Z","newSessionId":"sess-wake","offset":{"totalEvents":41},"reconcile":{"at":"2026-09-02T10:01:00.000Z","ok":true}}'
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" $wakeIntent
  $out5i = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-wake"}'
  Assert-True ($out5i -match 'ROTATION: you replace a predecessor') 'a wake rotation keeps the common opening'
  Assert-True ($out5i -match 'for a watchdog wake \(frontier-wake: outbox checks-settled x1 \[records: checks-settled endzone:issue-30\]\)') 'a wake rotation must name the wake reason, records included'
  Assert-True ($out5i -match 'Wake brief: act on exactly these items first') 'a wake rotation must print the wake brief'
  Assert-True ($out5i -match 'Do not re-read the status file, the tenant file, README\.md or CONTEXT\.md') 'the wake brief must tell the lead not to re-read the orientation files'
  Assert-True ($out5i -notmatch 'reconstruct from canonical state only') 'a wake rotation must not print the rebuild line'
  Write-Utf8 "$testRoot\state\rotation\pl-endzone.json" ($wakeIntent.Replace($wakeReasons, '"reasons":["age 25.0h >= 24h"]').Replace('sess-wake', 'sess-age'))
  $out5j = Run-Hook 'pl-endzone' 'project-lead' 'endzone' '{"session_id":"sess-age"}'
  Assert-True ($out5j -match 'ROTATION: you replace a predecessor') 'an age rotation keeps the common opening'
  Assert-True ($out5j -match 'reconstruct from canonical state only') 'a non-wake rotation must keep the rebuild line'
  Assert-True ($out5j -notmatch 'Wake brief') 'a non-wake rotation must not print a wake brief'
  # The brief is for a project-lead woken for work, not for any role whose reason happens to start `frontier-wake:`.
  # An arbiter and a principal are woken with `frontier-wake: endorsement #N` / verdict reasons; a heal is a
  # `frontier-wake: heal:` reason for a stuck lead. All three keep the rebuild line.
  foreach ($case in @(
      @{ label = 'an arbiter'; name = 'ar-endzone'; role = 'arbiter'; reason = 'frontier-wake: endorsement #2175' },
      @{ label = 'a principal'; name = 'pe-endzone'; role = 'principal'; reason = 'frontier-wake: endorsement #2175' },
      @{ label = 'a project-lead healed for a blocked prompt'; name = 'pl-endzone'; role = 'project-lead'; reason = 'frontier-wake: heal: blocked on a permission prompt' })) {
    $sid = 'sess-' + $case.name + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    Write-Utf8 "$testRoot\state\rotation\$($case.name).json" ($wakeIntent.Replace($wakeReasons, '"reasons":["' + $case.reason + '"]').Replace('"name":"pl-endzone"', '"name":"' + $case.name + '"').Replace('sess-wake', $sid))
    $outK = Run-Hook $case.name $case.role 'endzone' ('{"session_id":"' + $sid + '"}')
    Assert-True ($outK -match 'ROTATION: you replace a predecessor') "$($case.label) keeps the common opening"
    Assert-True ($outK -match 'reconstruct from canonical state only') "$($case.label) must keep the rebuild line"
    Assert-True ($outK -notmatch 'Wake brief') "$($case.label) must not get a wake brief"
  }

  # Case 6 (#218): the weekly review-category notice (bin/review-categories.js) is an
  # ordinary IC-board paragraph. A newly launched IC sees it; a lead does not; and it
  # drops out once the week it carries has passed. The notice is rendered by the script's
  # own renderNotice at a run time N days ago, so its [until] is that run + 7 days.
  $node = (Get-Command node -ErrorAction Stop).Source
  function New-CategoryNotice {
    param([int]$DaysAgo)
    $script = "const { renderNotice } = require(process.argv[1]); const { previousWeek } = require(process.argv[2]); const now = new Date(Date.now() - $DaysAgo * 86400000).toISOString(); process.stdout.write(renderNotice(previousWeek(now), [{ category: 'zz-first-category', count: 4 }, { category: 'zz-second-category', count: 2 }], now));"
    return (& $node -e $script "$sourceRoot/bin/review-categories.js" "$sourceRoot/bin/report-week.js" | Out-String).Trim()
  }
  $icBoard = "$testRoot\state\notices\ic.md"
  Write-Utf8 $icBoard ("IC-BOARD-KEEPER stands.`n`n" + (New-CategoryNotice 0))
  $out6 = Run-Hook 'ic-218' 'ic' 'endzone'
  Assert-True ($out6 -match 'zz-first-category \(4\), zz-second-category \(2\)') 'a newly launched IC must see the week''s top categories'
  Assert-True ($out6 -match 'IC-BOARD-KEEPER') 'the notice must not displace the rest of the IC board'
  $out6lead = Run-Hook 'pl-endzone' 'project-lead' 'endzone'
  Assert-True ($out6lead -notmatch 'zz-first-category') 'the categories notice is scoped to the IC role'
  Write-Utf8 $icBoard ("IC-BOARD-KEEPER stands.`n`n" + (New-CategoryNotice 7))
  $out6b = Run-Hook 'ic-218' 'ic' 'endzone'
  Assert-True ($out6b -match 'zz-first-category') 'a notice written a week ago still shows on its last day'
  Write-Utf8 $icBoard ("IC-BOARD-KEEPER stands.`n`n" + (New-CategoryNotice 8))
  $out6c = Run-Hook 'ic-218' 'ic' 'endzone'
  Assert-True ($out6c -notmatch 'zz-first-category') 'a notice older than a week must be gone at session start'
  Assert-True ($out6c -match 'IC-BOARD-KEEPER') 'expiry drops only the categories paragraph'

  Write-Output 'session-start tests passed'
} finally {
  foreach ($v in $saved.Keys) { [Environment]::SetEnvironmentVariable($v, $saved[$v]) }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-session-start-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
