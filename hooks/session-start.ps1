# SessionStart hook for fleet sessions. Prints only the context scoped to this
# role and tenant (ticket 06): state/notices/{all,<role>,tenant-<tenant>}.md,
# each notice filtered by its expiry or clearing marker - [until YYYY-MM-DD]
# drops the paragraph after that UTC date; [cleared-by <workRecordId> <state>]
# drops it once the Work record reaches that state (or is archived). The global
# state/NOTICE.md is no longer injected; the rollback flag state/flags/legacy-notice
# restores the pre-06 loading (NOTICE.md plus unfiltered boards) without touching
# launch gates.
$ErrorActionPreference = 'SilentlyContinue'
$hookInputRaw = [Console]::In.ReadToEnd()
$hookSessionId = $null
try { $hookSessionId = ("$hookInputRaw" | ConvertFrom-Json).session_id } catch {}
$home_ = $env:FLEET_HOME; if (-not $home_) { exit 0 }
$name = $env:FLEET_NAME; $role = $env:FLEET_ROLE; $tenant = $env:FLEET_TENANT; $parent = $env:FLEET_PARENT
if (-not $name) { exit 0 }
$legacy = Test-Path "$home_\state\flags\legacy-notice"

$script:activeWork = $null
function Get-ActiveWork {
  if ($null -eq $script:activeWork) {
    $script:activeWork = @{ state = $null }
    try { $script:activeWork.state = Get-Content "$home_\state\work\active.json" -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
  }
  return $script:activeWork.state
}

function Test-NoticeCleared {
  # $true when the paragraph's own marker says it no longer applies. A paragraph
  # without a marker stays (Cory clears those by hand); an unparseable marker stays
  # (fail-open: a broken date must not silently hide a live rule).
  param([string]$Block)
  if ($Block -match '\[until (\d{4}-\d{2}-\d{2})\]') {
    $limit = [datetime]::MinValue
    if ([datetime]::TryParseExact($Matches[1], 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$limit)) {
      if ((Get-Date).ToUniversalTime().Date -gt $limit.Date) { return $true }
    }
  }
  if ($Block -match '\[cleared-by ([^\s\]]+) ([a-z-]+)\]') {
    $recordId = $Matches[1]; $clearState = $Matches[2]
    $active = Get-ActiveWork
    $record = $null
    if ($active -and $active.records) { $record = $active.records.PSObject.Properties[$recordId] }
    if ($record) { if ("$($record.Value.state)" -eq $clearState) { return $true } }
    else {
      # Off the active set: an archived record has finished; its clearing event is past.
      $safe = ($recordId -replace '[^a-zA-Z0-9_.-]', '_')
      if (Test-Path "$home_\state\archive\work-$safe.json") { return $true }
    }
  }
  return $false
}

function Write-NoticeBoard {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path $Path)) { return }
  $raw = Get-Content $Path -Raw -Encoding UTF8
  if (-not $raw -or -not $raw.Trim()) { return }
  $kept = @()
  if ($legacy) { $kept = @($raw.Trim()) }
  else {
    $kept = @((($raw -replace "`r`n", "`n") -split '\n\s*\n') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not (Test-NoticeCleared $_) })
  }
  if ($kept.Count -eq 0) { return }
  Write-Output "--- NOTICE from Cory ($Label) ---"
  Write-Output ($kept -join "`n`n")
  Write-Output "--- end notice ---"
}

$tenantLabel = if ($tenant) { $tenant } else { 'none' }
Write-Output "=== FLEET CONTEXT ==="
Write-Output "You are fleet session '$name' (role: $role, tenant: $tenantLabel, reports to: $parent)."
Write-Output "Fleet home: $home_  (README.md is the operating guide; CONTEXT.md is the vocabulary)."
if (Test-Path "$home_\state\PAUSE") {
  $p = Get-Content "$home_\state\PAUSE" -Raw
  Write-Output "PAUSE IS SET: $p. Do not launch sessions or continue work loops until it is cleared."
}
if ($tenant -and (Test-Path "$home_\tenants\$tenant.json")) {
  Write-Output "Tenant file: $home_\tenants\$tenant.json"
}
if ($env:FLEET_ISSUE) { Write-Output "Your unit of work: issue #$($env:FLEET_ISSUE). Nothing else." }
if ($role -in @('ic', 'project-lead', 'dispatcher')) {
  $gateState = if (Test-Path "$home_\state\flags\research-gate-off") { 'off (state/flags/research-gate-off stands)' } else { 'on' }
  Write-Output "Researcher: the haiku researcher worker (Agent tool, subagent_type: researcher) is your official researcher (ADR 0010). Repo sweeps, git log, CI logs and web fetches from this session are refused by the research-gate hook (gate $gateState); give the researcher the one question and a line cap. Reading what was handed to you stays yours."
}
# 02/03 cutover: a manifest-launched IC learns its manifest, Work record, and the
# acknowledgment command here, with the record's current revision read at hook time
# so the first useful turn can acknowledge without a lookup.
if ($env:FLEET_ASSIGNMENT_MANIFEST -and $env:FLEET_WORK_RECORD_ID) {
  $ackRevision = $null
  try {
    $activeWork = Get-Content "$home_\state\work\active.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $ackRecord = $activeWork.records.PSObject.Properties[$env:FLEET_WORK_RECORD_ID]
    if ($ackRecord) { $ackRevision = [int]$ackRecord.Value.revision }
  } catch {}
  $revisionText = if ($null -ne $ackRevision) { "$ackRevision" } else { '<revision from node ' + $home_ + '\bin\work-state.js get --root ' + $home_ + ' --id ' + $env:FLEET_WORK_RECORD_ID + '>' }
  Write-Output "Assignment manifest: $($env:FLEET_ASSIGNMENT_MANIFEST) (Work record $($env:FLEET_WORK_RECORD_ID); branch $($env:FLEET_ASSIGNMENT_BRANCH) at base $($env:FLEET_BASE_SHA), already checked out here). The GitHub issue body and comments stay the only copy of the criteria; the manifest carries pointers and pins both. In your first useful turn acknowledge it: node $home_\bin\assignment.js ack --root $home_ --work-record-id $($env:FLEET_WORK_RECORD_ID) --expected-revision $revisionText"
}
# The handoff goes only to the session the rotation itself launched: the intent's
# newSessionId must match this session's id, so a later respawn or manual launch of
# the same name never inherits a stale offset (the expired-context class).
$rotation = $null
try { $rotation = Get-Content "$home_\state\rotation\$name.json" -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
if ($rotation -and "$($rotation.phase)" -eq 'launched' -and $hookSessionId -and "$($rotation.newSessionId)" -eq "$hookSessionId") {
  $why = (@($rotation.reasons) -join '; ')
  $reconciledAt = if ($rotation.reconcile) { $rotation.reconcile.at } else { 'not run; the scheduled pr-watch tick covers it' }
  Write-Output "ROTATION: you replace a predecessor rotated at $($rotation.savedAt) ($why). Its transcript is gone by design; reconstruct from canonical state only - Work records (node $home_\bin\work-state.js get/project), state/status/, the roster, and the skip file. Active records were reconciled against GitHub at: $reconciledAt. Event offset at rotation: $($rotation.offset.totalEvents) events. Re-read live GitHub state before your first action."
}
if ($legacy -and (Test-Path "$home_\state\NOTICE.md")) {
  Write-Output "--- NOTICE from Cory (state/NOTICE.md; LEGACY PATH restored by state/flags/legacy-notice) ---"
  Get-Content "$home_\state\NOTICE.md" -Raw -Encoding UTF8
  Write-Output "--- end notice ---"
}
$noticeScopes = @('all', $role)
if ($tenant) { $noticeScopes += "tenant-$tenant" }
foreach ($noticeScope in $noticeScopes) {
  if (-not $noticeScope) { continue }
  Write-NoticeBoard "$home_\state\notices\$noticeScope.md" "state/notices/$noticeScope.md"
}
# Control-plane context only: an IC's whole world is its issue and its parent
# (FLEET_PARENT); the live roster is coordination context it does not need.
if ($role -ne 'ic') {
  $roster = $null
  try { $roster = Get-Content "$home_\state\roster.json" -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
  if ($roster) {
    $active = @($roster.sessions | Where-Object { $_.status -eq 'active' })
    $names = @($active | ForEach-Object { "$($_.name)[$($_.role)]" }) -join ', '
    Write-Output "Roster (active): $names"
  }
}
if ($role -eq 'sentinel') {
  Write-Output "Sentinel: if you have no pending 15-minute cron job, create one now with CronCreate (cron '*/15 * * * *', prompt: 'Run the sentinel check: powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Cory\fleet\bin\sentinel-check.ps1 -Apply, then act on its report per your role'). Recurring jobs expire after 7 days; recreate when this message appears."
}
if ($role -eq 'dispatcher') {
  Write-Output "Dispatcher: if you have no pending daily-digest cron job, create one with CronCreate (cron '57 7 * * *', prompt: 'Write the daily digest to C:\Users\Cory\fleet\state\STATUS.md and send it as a push notification'). Recreate when this message appears."
}
Write-Output "=== END FLEET CONTEXT ==="
exit 0
