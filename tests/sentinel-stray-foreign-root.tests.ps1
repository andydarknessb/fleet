# fleet stray ic-1686 (2026-09-26 03:46:57Z): the live watchdog escalated the haiku
# rehearsal's scratch-root IC (job cf1d0d8e) as a stray. `claude agents --all` lists every
# job on the machine, so a session another fleet root launched and rosters looks, from
# here, exactly like one launched outside launch.ps1. The job's frozen --settings path
# names the root that launched it; when that root's own live roster holds the job, it is
# that root's session, not a stray of this one.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
function Json-Path { param([string]$Path) $Path.Replace('\', '\\') }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$base = Join-Path ([IO.Path]::GetTempPath()) ("fleet-stray-test-" + [guid]::NewGuid().ToString('N'))
$testRoot = Join-Path $base 'live'
$foreignRoot = Join-Path $base 'scratch'
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

try {
  foreach ($dir in 'bin','tenants','state','state/heartbeats','state/sentinel','state/skip','profile/.claude/jobs','mock-bin') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  [IO.Directory]::CreateDirectory((Join-Path $foreignRoot 'state\sessions')) | Out-Null
  foreach ($f in '_common.ps1','sentinel-check.ps1','pause.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }

  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  # The scratch root's live roster: it launched ic-1686 as job-1686 and still holds it.
  Write-Utf8 "$foreignRoot\state\roster.json" ('{"sessions":[{"name":"ic-1686","role":"ic","tenant":"test","parent":"cory","issue":1686,"status":"active","jobId":"job-1686","settings":"' + (Json-Path "$foreignRoot\state\sessions\ic-1686.settings.json") + '"}]}')

  function Write-Job { param([string]$Id, [string]$Name, [string]$Settings)
    [IO.Directory]::CreateDirectory("$testRoot\profile\.claude\jobs\$Id") | Out-Null
    $flags = @('--name', $Name, '--agent', 'ic')
    if ($Settings) { $flags += @('--settings', $Settings) }
    Write-Utf8 "$testRoot\profile\.claude\jobs\$Id\state.json" (@{ name = $Name; detail = ''; waitingFor = ''; respawnFlags = $flags } | ConvertTo-Json -Compress)
  }
  Write-Job 'job-1686' 'ic-1686' "$foreignRoot\state\sessions\ic-1686.settings.json"
  Write-Job 'job-2000' 'ic-2000' ''                                                   # launched by hand: no fleet settings
  Write-Job 'job-3000' 'ic-3000' "$testRoot\state\sessions\ic-3000.settings.json"     # this root's, roster row lost
  Write-Job 'job-4000' 'ic-4000' "$foreignRoot\state\sessions\ic-4000.settings.json"  # names the scratch root, which does not roster it

  $rows = @(
    @{ id = 'job-1686'; name = 'ic-1686'; pid = 1686 },
    @{ id = 'job-2000'; name = 'ic-2000'; pid = 2000 },
    @{ id = 'job-3000'; name = 'ic-3000'; pid = 3000 },
    @{ id = 'job-4000'; name = 'ic-4000'; pid = 4000 }
  ) | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.name; state = 'working'; status = 'idle'; pid = $_.pid; startedAt = '2026-09-26T03:44:00Z' } }
  Write-Utf8 "$testRoot\mock-bin\agents.json" (ConvertTo-Json @($rows) -Compress)
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" + 'if "%1"=="agents" type "' + "$testRoot\mock-bin\agents.json" + '"' + "`r`n" + 'exit /b 0' + "`r`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ('@echo off' + "`r`n" + 'echo []' + "`r`n" + 'exit /b 0' + "`r`n")

  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"

  $report = (& "$testRoot\bin\sentinel-check.ps1" -ReportPath "$testRoot\state\sentinel\last-check.json" | Out-String) | ConvertFrom-Json
  $strays = @($report.escalate | Where-Object { $_.kind -eq 'stray' } | ForEach-Object { $_.name })

  Assert-True ($strays -notcontains 'ic-1686') "another fleet root's rostered session must not escalate as a stray here (strays: $($strays -join ', '))"
  $okRow = @($report.ok | Where-Object { $_.name -eq 'ic-1686' })
  Assert-True ($okRow.Count -eq 1 -and "$($okRow[0].detail)" -like "*$foreignRoot*") "the foreign-root session must be reported under ok, naming the root that rosters it (ok: $(($report.ok | ConvertTo-Json -Compress)))"
  Assert-True ($strays -contains 'ic-2000') 'a fleet-named session with no fleet settings must still escalate as a stray'
  Assert-True ($strays -contains 'ic-3000') "a session launched with this root's settings but off its roster must still escalate as a stray"
  Assert-True ($strays -contains 'ic-4000') 'a session naming another root that does not roster it must still escalate as a stray'
  Write-Output 'sentinel-stray-foreign-root tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}
