$ErrorActionPreference = 'Stop'

# fleet #359 (part A): roster writes are read-modify-write under a lock. Overlapping launch and retire runs used to
# lose each other's rows. Covers: two concurrent writers keep every row (Update-LiveRoster in bin/_common.ps1);
# retire.ps1 driven end to end leaves a row that now holds a newer launch's job (or no row) untouched, because the
# mock CLI's `stop` swaps the roster in between retire's two writes; and launch.ps1 / retire.ps1 never call
# Save-LiveRoster directly. fleet #449: Write-Json renames a temporary file over roster.json, so a reader sees the old
# roster or the new one, never part of one, and a failed write leaves no temporary file behind. A reader holding the
# roster delays the rename, not the write; a hold past the 2 s bound makes the write throw, the old roster intact.

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

# fleet #449: rewrites roster.json with 1, 2, ... 60 rows through Write-Json, then one write onto a directory, which must throw.
$atomicWriterSource = @'
param([string]$Dir, [int]$Writes)
. "$PSScriptRoot\_common.ps1"
for ($i = 1; $i -le $Writes; $i++) {
  $sessions = @(1..$i | ForEach-Object { [pscustomobject]@{ name = "row-$_"; status = 'active'; prompt = ('p' * 12000) } })
  Write-Json "$Dir\roster.json" ([pscustomobject]@{ sessions = $sessions })
}
New-Item -ItemType Directory -Path "$Dir\blocked" | Out-Null
try { Write-Json "$Dir\blocked" ([pscustomobject]@{ a = 1 }); Write-Output 'no-throw' } catch { Write-Output 'threw' }
'@

# fleet #449: calls Write-Json once the parent holds roster.json, and reports its outcome, its duration and its finish time (UTC ticks).
$holderWriterSource = @'
param([string]$Path, [string]$GoFile, [string]$ReadyFile)
. "$PSScriptRoot\_common.ps1"
[IO.File]::WriteAllText($ReadyFile, '')
$goBy = (Get-Date).AddSeconds(20)
while (-not (Test-Path $GoFile) -and (Get-Date) -lt $goBy) { Start-Sleep -Milliseconds 5 }
$sw = [Diagnostics.Stopwatch]::StartNew()
try { Write-Json $Path ([pscustomobject]@{ sessions = @([pscustomobject]@{ name = 'fresh' }) }); $outcome = 'wrote' } catch { $outcome = 'threw' }
Write-Output "$outcome $($sw.ElapsedMilliseconds) $([DateTime]::UtcNow.Ticks)"
'@

# fleet #449: a child writes roster.json while this process holds it open without Delete sharing for $HoldMs.
function Invoke-WriteUnderHold {
  param([string]$Dir, [int]$HoldMs)
  [IO.Directory]::CreateDirectory($Dir) | Out-Null
  $file = "$Dir\roster.json"; $go = "$Dir\go"; $ready = "$Dir\ready"
  Write-Utf8 "$testRoot\bin\holder-writer.ps1" $holderWriterSource
  Write-Utf8 $file '{"sessions":[{"name":"old"}]}'
  $child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$testRoot\bin\holder-writer.ps1`" -Path `"$file`" -GoFile `"$go`" -ReadyFile `"$ready`"" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$Dir\child.out" -RedirectStandardError "$Dir\child.err"
  $null = $child.Handle
  $script:writers += [pscustomobject]@{ tag = $Dir; process = $child }
  $readyBy = (Get-Date).AddSeconds(20); while (-not (Test-Path $ready) -and (Get-Date) -lt $readyBy) { Start-Sleep -Milliseconds 20 }
  Assert-True (Test-Path $ready) "the holder writer did not start within 20 s: $(Get-Content "$Dir\child.err" -Raw)"
  $hold = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  Write-Utf8 $go ''
  Start-Sleep -Milliseconds $HoldMs
  $releasedAt = [DateTime]::UtcNow.Ticks
  $hold.Dispose()
  Assert-True ($child.WaitForExit(15000)) "the holder writer did not finish within 15 s"
  Assert-True ($child.ExitCode -eq 0) "the holder writer exited $($child.ExitCode): $(Get-Content "$Dir\child.err" -Raw)"
  $fields = (Get-Content "$Dir\child.out" -Raw).Trim() -split ' '
  return [pscustomobject]@{ outcome = $fields[0]; ms = [long]$fields[1]; finishedAt = [long]$fields[2]; releasedAt = $releasedAt; file = $file }
}

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

  # Case 1b (fleet #449): Write-Json replaces roster.json by rename. A child writer rewrites the roster while this process
  # reads it in a loop: every read that opens the file parses as one whole roster, and no temporary file is left behind.
  $atomicDir = Join-Path $testRoot 'atomic'
  $atomicFile = "$atomicDir\roster.json"
  [IO.Directory]::CreateDirectory($atomicDir) | Out-Null
  Write-Utf8 "$testRoot\bin\atomic-writer.ps1" $atomicWriterSource
  Write-Utf8 $atomicFile '{"sessions":[]}'
  $atomicWriter = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$testRoot\bin\atomic-writer.ps1`" -Dir `"$atomicDir`" -Writes 60" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$testRoot\atomic-writer.out" -RedirectStandardError "$testRoot\atomic-writer.err"
  $null = $atomicWriter.Handle
  $writers += [pscustomobject]@{ tag = 'atomic'; process = $atomicWriter }
  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $reads = 0; $partial = @(); $stopReadingBy = (Get-Date).AddSeconds(8)
  while (-not $atomicWriter.HasExited -and (Get-Date) -lt $stopReadingBy) {
    try {
      $stream = [IO.File]::Open($atomicFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
      try { $text = (New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $stream.Dispose() }
    } catch { continue }   # a read that cannot open the file says nothing about its content
    $reads++
    $roster = $null
    try { $roster = ConvertFrom-Json -InputObject $text } catch { }
    if ($null -eq $roster -or -not $roster.PSObject.Properties['sessions']) { $partial += $text; continue }
  }
  Assert-True ($atomicWriter.WaitForExit(8000)) "the atomic writer did not finish within 8 s"
  Assert-True ($atomicWriter.ExitCode -eq 0) "the atomic writer exited $($atomicWriter.ExitCode): $(Get-Content "$testRoot\atomic-writer.err" -Raw)"
  Assert-True ((Get-Content "$testRoot\atomic-writer.out" -Raw) -match 'threw') 'a Write-Json whose rename fails must throw, not swallow the failure'
  Assert-True ($reads -gt 0) 'the reader never read roster.json while it was written'
  Assert-True ($partial.Count -eq 0) "a reader saw $($partial.Count) of $reads reads as part of a roster (first one $($partial[0].Length) characters)"
  $finalRows = @((Get-Content $atomicFile -Raw | ConvertFrom-Json).sessions).Count
  Assert-True ($finalRows -eq 60) "the last write must be the roster that stands, got $finalRows rows"
  $temporaries = @(Get-ChildItem -LiteralPath $atomicDir -Force -Filter '*.tmp')
  Assert-True ($temporaries.Count -eq 0) "no temporary file may be left behind: $($temporaries.Name -join ', ')"

  # Case 1c (fleet #449): a reader holding roster.json without Delete sharing fails the rename for a moment, not the write.
  # Write-Json waits out a 300 ms hold, the new roster stands afterwards, and no temporary file is left.
  $held = Invoke-WriteUnderHold -Dir "$testRoot\held" -HoldMs 300
  Assert-True ($held.outcome -eq 'wrote') "Write-Json must wait out a reader's hold, not throw: outcome $($held.outcome) after $($held.ms) ms"
  Assert-True ($held.finishedAt -ge $held.releasedAt) 'the write must finish after the hold is released, so the hold really blocked the rename'
  Assert-True ((Get-Content $held.file -Raw | ConvertFrom-Json).sessions[0].name -eq 'fresh') 'the new roster must stand after the hold'
  Assert-True (@(Get-ChildItem -LiteralPath "$testRoot\held" -Force -Filter '*.tmp').Count -eq 0) 'no temporary file may be left behind after a held write'

  # Case 1d (fleet #449): a target held past the 2 s bound makes Write-Json throw; the old roster stands and no temporary file is left.
  $stuck = Invoke-WriteUnderHold -Dir "$testRoot\stuck" -HoldMs 2600
  Assert-True ($stuck.outcome -eq 'threw') "a target held past the bound must make Write-Json throw: outcome $($stuck.outcome)"
  Assert-True ($stuck.ms -ge 2000 -and $stuck.ms -lt 5000) "Write-Json must keep trying for about 2 s before it gives up, took $($stuck.ms) ms"
  Assert-True ((Get-Content $stuck.file -Raw | ConvertFrom-Json).sessions[0].name -eq 'old') 'the old roster must stand when the write gives up'
  Assert-True (@(Get-ChildItem -LiteralPath "$testRoot\stuck" -Force -Filter '*.tmp').Count -eq 0) 'no temporary file may be left behind after a write that gives up'

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
