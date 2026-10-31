$ErrorActionPreference = 'Stop'

# fleet #359 (part A): roster writes are read-modify-write under a lock. Overlapping launch and retire runs used to
# lose each other's rows. Covers: two concurrent writers keep every row (Update-LiveRoster in bin/_common.ps1);
# retire.ps1 driven end to end leaves a row that now holds a newer launch's job (or no row) untouched, because the
# mock CLI's `stop` swaps the roster in between retire's two writes; and launch.ps1 / retire.ps1 never call
# Save-LiveRoster directly.

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-roster-lock-" + [guid]::NewGuid().ToString('N'))
$retireRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-roster-retire-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($n in 'FLEET_CLAUDE_CLI', 'FLEET_CLAUDE_RESOLVE_TRIES', 'FLEET_CLAUDE_RESOLVE_POLL_MS') { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }

# Each child writer adds 15 distinct rows, one Update-LiveRoster per row, with the sleep held inside the lock.
$writerSource = @'
param([string]$Tag, [int]$Count, [string]$Dir)
. "$PSScriptRoot\_common.ps1"
[IO.File]::WriteAllText("$Dir\ready-$Tag", '')
# Start barrier: no write starts until the parent has seen both writers ready and written the go file.
$gateBy = (Get-Date).AddSeconds(30)
while (-not (Test-Path "$Dir\go") -and (Get-Date) -lt $gateBy) { Start-Sleep -Milliseconds 20 }
if (-not (Test-Path "$Dir\go")) { throw "go file $Dir\go not written within 30 s" }
for ($i = 1; $i -le $Count; $i++) {
  $rowName = "$Tag-$i"
  Update-LiveRoster {
    param($r)
    Start-Sleep -Milliseconds 50
    $r.sessions = @($r.sessions) + @([pscustomobject]@{ name = $rowName; status = 'active' })
  }
}
'@

$writers = @()
try {
  # Case 1: two overlapping writers on one FleetHome: all 30 rows survive.
  foreach ($dir in 'bin', 'state') { [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null }
  [IO.File]::Copy("$sourceRoot\bin\_common.ps1", "$testRoot\bin\_common.ps1")
  Write-Utf8 "$testRoot\bin\writer.ps1" $writerSource
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'

  # Each writer is recorded as soon as it starts, so a failed later spawn still leaves the earlier child for the finally to kill.
  foreach ($tag in 'a', 'b') {
    $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$testRoot\bin\writer.ps1`" -Tag $tag -Count 15 -Dir `"$testRoot`"" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$testRoot\writer-$tag.out" -RedirectStandardError "$testRoot\writer-$tag.err"
    $writers += [pscustomobject]@{ tag = $tag; process = $p }
    $null = $p.Handle # PS 5.1 keeps the exit code only when the handle is read before the child exits
  }
  # Start barrier: the go file is written only once both writers are ready, so their first writes overlap. Bounded at 30 s.
  $readyBy = (Get-Date).AddSeconds(30)
  foreach ($w in $writers) { while (-not (Test-Path "$testRoot\ready-$($w.tag)") -and (Get-Date) -lt $readyBy) { Start-Sleep -Milliseconds 20 } }
  foreach ($w in $writers) { Assert-True (Test-Path "$testRoot\ready-$($w.tag)") "writer $($w.tag) not ready within 30 s: $(Get-Content "$testRoot\writer-$($w.tag).err" -Raw)" }
  Write-Utf8 "$testRoot\go" ''
  foreach ($w in $writers) { Assert-True ($w.process.WaitForExit(120000)) "writer $($w.tag) still running after 120 s" }
  foreach ($w in $writers) { Assert-True ($w.process.ExitCode -eq 0) "writer $($w.tag) exited $($w.process.ExitCode): $(Get-Content "$testRoot\writer-$($w.tag).err" -Raw)" }
  $rows = @((Get-Content "$testRoot\state\roster.json" -Raw | ConvertFrom-Json).sessions)
  $distinct = @($rows | ForEach-Object { $_.name } | Sort-Object -Unique)
  Assert-True ($rows.Count -eq 30 -and $distinct.Count -eq 30) "two concurrent writers must keep all 30 rows, got $($rows.Count) rows and $($distinct.Count) distinct names"

  # Case 2-4: retire.ps1 end to end. The mock CLI's `stop` copies $retireRoot\swap.json over the roster, so retire's
  # second write (after stop) meets whatever a newer launch, or nothing, left in its place.
  foreach ($dir in 'bin', 'state', 'state/heartbeats', 'elsewhere') { [IO.Directory]::CreateDirectory((Join-Path $retireRoot $dir)) | Out-Null }
  foreach ($f in '_common.ps1', 'retire.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$retireRoot\bin\$f") }
  Write-Utf8 "$retireRoot\elsewhere\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="stop" copy /Y "' + $retireRoot + '\swap.json" "' + $retireRoot + '\state\roster.json" >nul' + "`r`n" + 'if "%1"=="agents" echo []' + "`r`n" + 'exit /b 0' + "`r`n")
  $env:FLEET_CLAUDE_CLI = "$retireRoot\elsewhere\claude.cmd"
  $env:FLEET_CLAUDE_RESOLVE_TRIES = '2'
  $env:FLEET_CLAUDE_RESOLVE_POLL_MS = '50'

  $cwdJson = ("$retireRoot\nowhere").Replace('\', '/')
  $ownRoster = '{"sessions":[{"name":"ic-9","role":"ic","tenant":"test","parent":"pl-test","issue":9,"cwd":"' + $cwdJson + '","status":"active","jobId":"job-1","prompt":"p1"}]}'
  function Invoke-RetireSwap {
    param([string]$SwapRoster)
    Write-Utf8 "$retireRoot\state\roster.json" $ownRoster
    Write-Utf8 "$retireRoot\swap.json" $SwapRoster
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$retireRoot\bin\retire.ps1" -Name ic-9 -Reason 'test' 2>&1 | Out-String) }
    finally { $script:retireExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
    Assert-True ($script:retireExit -eq 0) "retire.ps1 must exit 0, got $script:retireExit : $out"
    return (Get-Content "$retireRoot\state\roster.json" -Raw | ConvertFrom-Json)
  }

  # Case 2 (control): the roster still holds job-1, so the same row is retired and its prompt stripped.
  $rows = @((Invoke-RetireSwap $ownRoster).sessions)
  Assert-True ($rows.Count -eq 1 -and $rows[0].status -eq 'retired' -and $rows[0].jobId -eq 'job-1' -and $rows[0].retiredAt -and -not $rows[0].PSObject.Properties['prompt']) "a retire whose row still holds its job must retire it (retiredAt set) and strip the prompt: $($rows | ConvertTo-Json -Compress)"

  # Case 3: a newer launch took the name (job-2) between retire's two writes: its row is left exactly as launched.
  $newer = '{"sessions":[{"name":"ic-9","role":"ic","tenant":"test","parent":"pl-test","issue":9,"cwd":"' + $cwdJson + '","status":"active","jobId":"job-2","prompt":"p2"}]}'
  $rows = @((Invoke-RetireSwap $newer).sessions)
  Assert-True ($rows.Count -eq 1 -and $rows[0].jobId -eq 'job-2' -and $rows[0].status -eq 'active' -and $rows[0].prompt -eq 'p2' -and -not $rows[0].PSObject.Properties['retiringAt'] -and -not $rows[0].PSObject.Properties['retiredAt']) "retire must not touch a newer launch's row: $($rows | ConvertTo-Json -Compress)"

  # Case 4: the row is gone by retire's second write: nothing is revived.
  $rows = @((Invoke-RetireSwap '{"sessions":[]}').sessions)
  Assert-True ($rows.Count -eq 0) "retire must not revive a row that is gone: $($rows.Count) rows"

  # Case 5 (guard): the launch and retire doors write the roster only through Update-LiveRoster.
  foreach ($f in 'launch.ps1', 'retire.ps1') {
    $direct = @((Get-Content "$sourceRoot\bin\$f") | Where-Object { $_ -match 'Save-LiveRoster' -and $_ -notmatch '^\s*#' })
    Assert-True ($direct.Count -eq 0) "bin/$f must not call Save-LiveRoster directly (fleet #359): $($direct -join ' | ')"
    Assert-True ((Get-Content "$sourceRoot\bin\$f" -Raw) -match 'Update-LiveRoster') "bin/$f must write the roster through Update-LiveRoster"
  }

  Write-Output 'roster-lock tests passed'
} finally {
  foreach ($w in $writers) { if (-not $w.process.HasExited) { try { $w.process.Kill(); $w.process.WaitForExit(5000) | Out-Null } catch {} } }
  foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item $testRoot, $retireRoot -Recurse -Force -ErrorAction SilentlyContinue
}
