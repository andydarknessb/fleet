$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$dry = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$sourceRoot\bin\install-pr-watch-task.ps1" -DryRun | Out-String) | ConvertFrom-Json

Assert-True ($dry.taskName -eq 'Fleet PR watch') 'the task must be named Fleet PR watch'
Assert-True ($dry.schedule -match '5 minutes') 'the schedule must run every 5 minutes'
Assert-True ($dry.logonDelay -eq 'PT6M') 'the logon trigger must wait behind recovery (PT2M) and the watchdog (PT4M)'
Assert-True ($dry.arguments -match 'run-pr-watch\.ps1') 'the action must run the wrapper'
Assert-True (Test-Path $dry.script) 'the wrapper path must exist'

$src = Get-Content "$sourceRoot\bin\install-pr-watch-task.ps1" -Raw
Assert-True ($src -match 'MultipleInstances IgnoreNew') 'overlapping runs must be ignored, not queued'
Assert-True ($src -match 'AllowStartIfOnBatteries') 'the watcher must run on battery'

$wrapper = Get-Content "$sourceRoot\bin\run-pr-watch.ps1" -Raw
Assert-True ($wrapper -match 'FLEET_NODE_PATH') 'the wrapper must honor FLEET_NODE_PATH like the collector'
Assert-True ($wrapper -match 'pr-watch\.js') 'the wrapper must invoke pr-watch.js'
Assert-True ($wrapper -match 'digest\.js') 'the wrapper must rebuild the ticket-07 projections after the tick'
Assert-True ($wrapper -notmatch 'notify\.js') 'the wrapper never runs the notifier: a decision event launches it'

# Ticket 443: over 10 MB the wrapper keeps the log's newest 5 MB, cut at a line boundary, before this
# tick writes. It runs in a temp root with a stub node, so no real watcher, digest or budget runs.
$capRoot = Join-Path ([IO.Path]::GetTempPath()) ('pr-watch-cap-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$capLog = "$capRoot\state\watch\watch.log"
$pad = 'x' * 89
try {
  New-Item -ItemType Directory -Force "$capRoot\bin", "$capRoot\state\watch" | Out-Null
  Copy-Item "$sourceRoot\bin\_common.ps1", "$sourceRoot\bin\run-pr-watch.ps1" -Destination "$capRoot\bin"
  [IO.File]::WriteAllText("$capRoot\bin\node-stub.cmd", "@echo off`r`necho stub-node`r`nexit /b 0`r`n", (New-Object Text.UTF8Encoding $false))
  $env:FLEET_NODE_PATH = "$capRoot\bin\node-stub.cmd"

  # 105000 lines of 100 bytes: 10,500,000 bytes, a little over the 10 MB cap.
  $writer = New-Object IO.StreamWriter($capLog, $false, (New-Object Text.UTF8Encoding $false))
  try { for ($line = 1; $line -le 105000; $line++) { $writer.Write(('L{0:D7} ' -f $line) + $pad + "`r`n") } } finally { $writer.Dispose() }
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$capRoot\bin\run-pr-watch.ps1" | Out-Null
  Assert-True ($LASTEXITCODE -eq 0) 'the wrapper must exit 0 when it trims the log'
  $capped = (Get-Item -LiteralPath $capLog).Length
  Assert-True ($capped -gt (5MB - 100) -and $capped -lt (5MB + 4KB)) "an over-cap log must keep its newest 5 MB (got $capped bytes)"
  Assert-True ([IO.File]::ReadAllText($capLog) -match "L0105000 x{89}\r\n") 'the last line written before the trim must survive it'
  Assert-True ((Get-Content -LiteralPath $capLog -TotalCount 1) -match '^L\d{7} x{89}$') 'the first line of the trimmed log must be a whole line'

  # A log under the cap is left alone.
  [IO.File]::WriteAllText($capLog, ((1..10 | ForEach-Object { ('L{0:D7} ' -f $_) + $pad + "`r`n" }) -join ''), (New-Object Text.UTF8Encoding $false))
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$capRoot\bin\run-pr-watch.ps1" | Out-Null
  Assert-True ((Get-Content -LiteralPath $capLog -TotalCount 1) -match '^L0000001 ') 'a log under the cap must not be trimmed'
} finally {
  Remove-Item Env:FLEET_NODE_PATH -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $capRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'pr-watch task tests passed'
