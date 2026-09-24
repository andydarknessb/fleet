# #113 (ADR 0013): bin/deploy-live.ps1 against a fixture: a bare origin, a live
# checkout on `live` one commit behind `master`, and a stub gh answering check-runs.
# Red-tell: a green check advances `live`; a red check, a pending check, a missing
# run or a present deploy-hold leaves it where it is with the matching outcome; a
# diverged `live`, a checkout off `live`, and a tracked change each refuse.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\deploy-live.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('fleet-deploy-test-' + [guid]::NewGuid().ToString('N'))

function G {
  param([string]$Dir)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & git -C $Dir @args 2>&1 } finally { $ErrorActionPreference = $eap }
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') in ${Dir}: $out" }
  return (@($out | ForEach-Object { "$_" }) -join "`n").Trim()
}

function New-Fixture {
  param([string]$Name)
  $root = Join-Path $testRoot $Name
  $origin = Join-Path $root 'origin.git'; $seed = Join-Path $root 'seed'; $live = Join-Path $root 'live'
  [IO.Directory]::CreateDirectory($seed) | Out-Null
  G $root init --quiet --bare $origin
  G $seed init --quiet
  G $seed config user.email 'fleet@example.invalid'; G $seed config user.name 'fleet'
  G $seed checkout --quiet -b master
  Write-Utf8 "$seed\a.txt" 'one'
  G $seed add a.txt; G $seed commit --quiet -m one --no-gpg-sign
  G $seed remote add origin $origin; G $seed push --quiet origin master
  G $root clone --quiet $origin $live
  G $live config user.email 'fleet@example.invalid'; G $live config user.name 'fleet'
  G $live switch --quiet -c live origin/master
  $from = G $live rev-parse HEAD
  Write-Utf8 "$seed\a.txt" 'two'
  G $seed commit --quiet -a -m two --no-gpg-sign; G $seed push --quiet origin master
  $to = G $seed rev-parse HEAD
  # A stub gh: prints whatever check-runs.json holds (the test writes it per case).
  Write-Utf8 "$root\gh.cmd" ('@type "' + $root + '\check-runs.json"' + "`r`n" + '@exit /b 0' + "`r`n")
  [pscustomobject]@{ root = $root; live = $live; seed = $seed; from = $from; to = $to; gh = "$root\gh.cmd" }
}

function Set-Check { param($F, [string]$Status, [string]$Conclusion, [int]$Id = 1)
  $run = if ($Status) { '{"id":' + $Id + ',"name":"fleet-ci","status":"' + $Status + '","conclusion":' + $(if ($Conclusion) { '"' + $Conclusion + '"' } else { 'null' }) + '}' } else { '' }
  Write-Utf8 "$($F.root)\check-runs.json" ('{"total_count":' + $(if ($run) { 1 } else { 0 }) + ',"check_runs":[' + $run + ']}')
}

function Deploy { param($F)
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -FleetHome $F.live -Repo 'owner/fleet' -GhExe $F.gh | Out-String
  Assert-True ($LASTEXITCODE -eq 0) "deploy-live exits 0 whatever the outcome, got $LASTEXITCODE"
  ($out.Trim() -split "`n")[-1] | ConvertFrom-Json
}

try {
  # A green check advances live by fast-forward.
  $f = New-Fixture 'green'
  Set-Check $f 'completed' 'success'
  $r = Deploy $f
  Assert-True ($r.outcome -eq 'advanced') "green must advance: $($r | ConvertTo-Json -Compress)"
  Assert-True ($r.from -eq $f.from -and $r.to -eq $f.to) 'from/to name the move'
  Assert-True ((G $f.live rev-parse HEAD) -eq $f.to) 'live is at master'
  Assert-True ((G $f.live symbolic-ref --short HEAD) -eq 'live') 'still on live'
  $again = Deploy $f
  Assert-True ($again.outcome -eq 'current') "a second tick is current: $($again.outcome)"

  # A red check, a pending check and no run at all leave live where it is.
  foreach ($case in @(@('completed', 'failure', 'master-red'), @('in_progress', '', 'master-pending'), @('', '', 'master-pending'))) {
    $f = New-Fixture ("hold-" + $case[2] + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
    Set-Check $f $case[0] $case[1]
    $r = Deploy $f
    Assert-True ($r.outcome -eq $case[2]) "status '$($case[0])' conclusion '$($case[1])' must be $($case[2]), got $($r.outcome)"
    Assert-True ((G $f.live rev-parse HEAD) -eq $f.from) "$($case[2]) must not move live"
  }

  # A re-run that went green supersedes the earlier failure (the newest run decides).
  $f = New-Fixture 'rerun'
  Write-Utf8 "$($f.root)\check-runs.json" '{"total_count":2,"check_runs":[{"id":7,"name":"fleet-ci","status":"completed","conclusion":"success"},{"id":3,"name":"fleet-ci","status":"completed","conclusion":"failure"}]}'
  Assert-True ((Deploy $f).outcome -eq 'advanced') 'the newest run decides'

  # deploy-hold freezes even a green master.
  $f = New-Fixture 'held'
  Set-Check $f 'completed' 'success'
  [IO.Directory]::CreateDirectory("$($f.live)\state\flags") | Out-Null
  Write-Utf8 "$($f.live)\state\flags\deploy-hold" 'rollback 2026-09-24'
  $r = Deploy $f
  Assert-True ($r.outcome -eq 'held') "deploy-hold must hold: $($r.outcome)"
  Assert-True ((G $f.live rev-parse HEAD) -eq $f.from) 'held must not move live'

  # A diverged live refuses; nothing is rewritten.
  $f = New-Fixture 'diverged'
  Set-Check $f 'completed' 'success'
  Write-Utf8 "$($f.live)\b.txt" 'local'
  G $f.live add b.txt; G $f.live commit --quiet -m local --no-gpg-sign
  $localHead = G $f.live rev-parse HEAD
  $r = Deploy $f
  Assert-True ($r.outcome -eq 'refused:diverged') "a diverged live must refuse: $($r.outcome)"
  Assert-True ((G $f.live rev-parse HEAD) -eq $localHead) 'a refusal never moves live'

  # A checkout that is not on live refuses, naming the cutover command.
  $f = New-Fixture 'offlive'
  Set-Check $f 'completed' 'success'
  G $f.live switch --quiet -c elsewhere
  $r = Deploy $f
  Assert-True ($r.outcome -eq 'refused:not-on-live') "off live must refuse: $($r.outcome)"
  Assert-True ("$($r.detail)" -match 'switch -c live') 'the refusal names the cutover'

  # A tracked change refuses; an untracked file does not block.
  $f = New-Fixture 'dirty'
  Set-Check $f 'completed' 'success'
  Write-Utf8 "$($f.live)\a.txt" 'edited in the live checkout'
  Assert-True ((Deploy $f).outcome -eq 'refused:dirty') 'a tracked change must refuse'
  G $f.live checkout --quiet -- a.txt
  Write-Utf8 "$($f.live)\scratch.md" 'untracked notes'
  Assert-True ((Deploy $f).outcome -eq 'advanced') 'an untracked file never blocks the fast-forward'

  # An unreadable CI answer refuses rather than guessing.
  $f = New-Fixture 'ci-unreadable'
  Write-Utf8 "$($f.root)\check-runs.json" 'not json'
  Assert-True ((Deploy $f).outcome -eq 'refused:ci-unreadable') 'unparseable check-runs must refuse'

  Write-Output 'deploy-live.tests.ps1: all assertions passed'
} finally {
  Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue
}
