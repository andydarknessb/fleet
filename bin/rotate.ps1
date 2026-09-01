<#
.SYNOPSIS  Ticket 06: rotate a control-plane session at a safe boundary (ADR 0005).
  A rotation retires the old session, reconciles active Work records against GitHub
  (the pr-watch tick), and relaunches the same roster name through launch.ps1 - the
  replacement reconstructs from canonical state, never from the old transcript.
  Thresholds live in config/cycle.json and are evaluated by bin/rotation-policy.js.
  The intent file state/rotation/<name>.json makes a crash between stop and launch
  recoverable: the next run (-Auto or -Resume) completes the launch from roster
  intent and the saved event offset. Registered by install-rotation-task.ps1.
.EXAMPLE   rotate.ps1 -Auto            # scheduled: resume incomplete, rotate the due
.EXAMPLE   rotate.ps1 -Name pl-endzone -Force   # Cory's hand: rotate now
#>
[CmdletBinding()]
param(
  [string]$Name,          # rotate this roster session (thresholds still apply unless -Force)
  [switch]$Auto,          # resume incomplete rotations, then rotate every due session
  [switch]$Resume,        # only resume incomplete rotations
  [switch]$Force,         # skip the threshold check and the rotation-off flag, and pass -Force to launch.ps1 (Cory's hand)
  [switch]$DryRun,        # evaluate and report; no stop, no launch, no writes
  [switch]$NoReconcile    # skip the pr-watch reconcile pass (tests)
)
. "$PSScriptRoot\_common.ps1"
# Entry point: never inherit a caller's Stop preference (PS 5.1 wraps native stderr).
$ErrorActionPreference = 'Continue'

$rotationDir = "$FleetHome\state\rotation"
[IO.Directory]::CreateDirectory($rotationDir) | Out-Null

function New-Outcome {
  # status: rotated | deferred | skipped | failed | dry-run. The exit code and the
  # summary read status, never free-text reasons.
  param([string]$SessionName, [string]$Status, [string]$Reason = $null)
  [pscustomobject]@{ name = $SessionName; status = $Status; reason = $Reason }
}

function Invoke-Policy {
  param([string]$Command)
  $raw = & (Get-NodeExe) "$FleetHome\bin\rotation-policy.js" $Command --root $FleetHome 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "rotation-policy $Command failed: $(($raw -replace '\s+', ' ').Trim())" }
  return $raw | ConvertFrom-Json
}

function Get-IntentPath { param([string]$SessionName) "$rotationDir\$SessionName.json" }

function Test-SafeBoundary {
  param([string]$SessionName)
  $row = Get-DaemonSessions | Where-Object { $_.name -eq $SessionName } | Select-Object -First 1
  if ($row -and "$($row.status)" -eq 'busy') { return [pscustomobject]@{ safe = $false; reason = 'session is mid-turn (status busy)' } }
  if (Test-Path "$FleetHome\state\work\.lock") { return [pscustomobject]@{ safe = $false; reason = 'work-state lock is held (mutation in flight)' } }
  $pending = @(Get-ChildItem "$FleetHome\state\work\pending" -Filter *.json -ErrorAction SilentlyContinue)
  if ($pending.Count -gt 0) { return [pscustomobject]@{ safe = $false; reason = "$($pending.Count) pending work-state journal(s) awaiting recovery" } }
  return [pscustomobject]@{ safe = $true; reason = $null }
}

function Invoke-RetireSession {
  # retire.ps1 reports success as a JSON line naming the retired session; its exit
  # code is not the signal (claude/git inside it leave theirs in $LASTEXITCODE).
  param([string]$SessionName, [string]$Reason)
  $out = & "$PSScriptRoot\retire.ps1" -Name $SessionName -Reason $Reason 2>&1 | Out-String
  $parsed = ConvertFrom-LastJsonLine $out
  return [pscustomobject]@{ ok = ($parsed -and "$($parsed.retired)" -eq $SessionName); detail = $parsed }
}

function Invoke-Reconcile {
  # Refresh GitHub facts into every active Work record before the replacement acts:
  # one pr-watch tick per tenant (shadow-safe; the 5-minute task keeps it fresh after).
  $results = @()
  foreach ($tenantFile in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)) {
    $tenant = [IO.Path]::GetFileNameWithoutExtension($tenantFile.Name)
    $raw = & (Get-NodeExe) "$FleetHome\bin\pr-watch.js" --root $FleetHome --tenant $tenant 2>&1 | Out-String
    $results += [pscustomobject]@{ tenant = $tenant; ok = ($LASTEXITCODE -eq 0); ticks = (ConvertFrom-LastJsonLine $raw) }
  }
  return [pscustomobject]@{ at = (Now-Iso); tenants = $results; ok = (@($results | Where-Object { -not $_.ok }).Count -eq 0) }
}

function Complete-Rotation {
  # From a written intent whose session is already stopped: reconcile, then relaunch.
  param([pscustomobject]$Intent)
  $intentPath = Get-IntentPath $Intent.name
  if (-not $NoReconcile) {
    $Intent | Add-Member -NotePropertyName reconcile -NotePropertyValue (Invoke-Reconcile) -Force
    Write-Json $intentPath $Intent
  }
  # Hashtable splat, not array: PS 5.1 array splatting delivered '-FromRoster' as a
  # positional VALUE to the script, silently launching nothing that was asked for.
  $launchArgs = @{ FromRoster = $Intent.name }
  if ($Force) { $launchArgs.Force = $true }   # a forced rotation must not strand the role behind launch gates it was told to pass
  $out = & "$PSScriptRoot\launch.ps1" @launchArgs 2>&1 | Out-String
  $launchExit = $LASTEXITCODE
  $launch = ConvertFrom-LastJsonLine $out
  if ($launch -and $launch.launched) {
    $Intent.phase = 'launched'
    $Intent | Add-Member -NotePropertyName newSessionId -NotePropertyValue $launch.sessionId -Force
    $Intent | Add-Member -NotePropertyName newJobId -NotePropertyValue $launch.jobId -Force
    $Intent | Add-Member -NotePropertyName completedAt -NotePropertyValue (Now-Iso) -Force
    Write-Json $intentPath $Intent
    return New-Outcome $Intent.name 'rotated'
  }
  if ($launch -and "$($launch.reason)" -match 'already running') {
    # Someone relaunched by hand between stop and resume; the goal state holds.
    $Intent.phase = 'launched'
    $Intent | Add-Member -NotePropertyName launchedBy -NotePropertyValue 'external' -Force
    $Intent | Add-Member -NotePropertyName completedAt -NotePropertyValue (Now-Iso) -Force
    Write-Json $intentPath $Intent
    return New-Outcome $Intent.name 'rotated' 'found live externally'
  }
  $reason = if ($launch) { "$($launch.reason)" } else { "launch.ps1 exit $launchExit : $(($out -replace '\s+', ' ').Trim())" }
  $Intent | Add-Member -NotePropertyName launchError -NotePropertyValue ([pscustomobject]@{ at = (Now-Iso); reason = $reason }) -Force
  Write-Json $intentPath $Intent
  return New-Outcome $Intent.name 'failed' "replacement launch failed: $reason"
}

function Start-Rotation {
  param([string]$SessionName, [string[]]$Reasons)
  $live = Get-LiveRoster
  $entry = $live.sessions | Where-Object { $_.name -eq $SessionName -and $_.status -eq 'active' } | Select-Object -First 1
  if (-not $entry) { return New-Outcome $SessionName 'failed' 'no active live-roster entry' }
  $boundary = Test-SafeBoundary $SessionName
  if (-not $boundary.safe) { return New-Outcome $SessionName 'deferred' $boundary.reason }
  if ($DryRun) {
    $dry = New-Outcome $SessionName 'dry-run'
    $dry | Add-Member -NotePropertyName wouldRotate -NotePropertyValue $true
    $dry | Add-Member -NotePropertyName reasons -NotePropertyValue @($Reasons)
    return $dry
  }
  $intent = [pscustomobject]@{
    schemaVersion = 1; name = $SessionName; phase = 'stopping'
    reasons = @($Reasons); savedAt = (Now-Iso)
    oldSessionId = $entry.sessionId; oldJobId = $entry.jobId
    offset = (Invoke-Policy offset)
  }
  Write-Json (Get-IntentPath $SessionName) $intent
  $retire = Invoke-RetireSession $SessionName "rotation: $($Reasons -join '; ')"
  if (-not $retire.ok) {
    $intent | Add-Member -NotePropertyName stopError -NotePropertyValue 'retire.ps1 did not confirm the retirement' -Force
    Write-Json (Get-IntentPath $SessionName) $intent
    return New-Outcome $SessionName 'failed' 'retire did not confirm; intent kept for resume'
  }
  $intent.phase = 'stopped'
  Write-Json (Get-IntentPath $SessionName) $intent
  return Complete-Rotation $intent
}

function Resume-Incomplete {
  $results = @()
  foreach ($file in @(Get-ChildItem $rotationDir -Filter *.json -ErrorAction SilentlyContinue)) {
    $intent = $null
    try { $intent = Read-Json $file.FullName } catch { continue }
    if (-not $intent -or "$($intent.phase)" -eq 'launched') { continue }
    if ($DryRun) {
      $dry = New-Outcome $intent.name 'dry-run'
      $dry | Add-Member -NotePropertyName wouldResume -NotePropertyValue $true
      $dry | Add-Member -NotePropertyName phase -NotePropertyValue $intent.phase
      $results += $dry
      continue
    }
    $liveRow = Get-DaemonSessions | Where-Object { $_.name -eq $intent.name } | Select-Object -First 1
    if ($liveRow -and "$($liveRow.sessionId)" -eq "$($intent.oldSessionId)") {
      # Crash mid-stop: the predecessor is still alive; finish retiring it first.
      $retire = Invoke-RetireSession $intent.name "rotation (resumed): $(@($intent.reasons) -join '; ')"
      if (-not $retire.ok) { $results += New-Outcome $intent.name 'failed' 'resume retire did not confirm'; continue }
    }
    $intent.phase = 'stopped'
    Write-Json $file.FullName $intent
    $results += Complete-Rotation $intent
  }
  return @($results)
}

try {
  if ((Test-Paused) -and -not $Force) {
    $p = Get-Content "$FleetHome\state\PAUSE" -Raw
    Write-Output (@{ rotated = @(); reason = "PAUSE set: $(($p -replace '\s+', ' ').Trim())" } | ConvertTo-Json -Compress); exit 3
  }
  if ((Test-Path "$FleetHome\state\flags\rotation-off") -and -not $Force) {
    Write-Output (@{ rotated = @(); reason = 'rotation disabled by state/flags/rotation-off' } | ConvertTo-Json -Compress); exit 3
  }
  if (-not $Name -and -not $Auto -and -not $Resume) { Write-Error 'pass -Name <session>, -Auto, or -Resume'; exit 4 }

  $outcomes = @()
  if ($Auto -or $Resume) { $outcomes += Resume-Incomplete }
  if ($Name) {
    $static = Get-StaticRoster
    if (-not ($static.sessions | Where-Object { $_.name -eq $Name })) { Write-Error "'$Name' is not a static roster session; rotation only replaces standing sessions"; exit 4 }
    if ($Force) {
      $outcomes += Start-Rotation $Name @('forced by operator')
    } else {
      $evaluation = Invoke-Policy evaluate
      $due = $evaluation.sessions | Where-Object { $_.name -eq $Name } | Select-Object -First 1
      if ($due -and $due.due) { $outcomes += Start-Rotation $Name @($due.reasons) }
      else { $outcomes += New-Outcome $Name 'skipped' 'no rotation threshold reached (use -Force to override)' }
    }
  }
  if ($Auto) {
    $handledNames = @($outcomes | ForEach-Object { $_.name })
    $evaluation = Invoke-Policy evaluate
    foreach ($session in @($evaluation.sessions | Where-Object { $_.due })) {
      if ($handledNames -contains $session.name) { continue }
      $outcomes += Start-Rotation $session.name @($session.reasons)
    }
  }

  Write-Output (@{
    at = (Now-Iso)
    rotated = @($outcomes | Where-Object { $_.status -eq 'rotated' } | ForEach-Object { $_.name })
    deferred = @($outcomes | Where-Object { $_.status -eq 'deferred' } | ForEach-Object { "$($_.name): $($_.reason)" })
    outcomes = $outcomes
  } | ConvertTo-Json -Compress -Depth 8)
  if (@($outcomes | Where-Object { $_.status -eq 'failed' }).Count -gt 0) { exit 5 }
  exit 0
} catch {
  Write-Error $_
  exit 1
}
