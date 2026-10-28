# Task Scheduler entry point for the fleet #337 CLI canary (bin/cli-canary.ps1; install-cli-canary-task.ps1
# registers it). One run a day: its JSON line goes to state/cli-canary/cli-canary.log. A non-zero exit
# (npm, gh, install, worktree or push failed) pages: nobody reads the log, and a silent canary freezes the
# fleet on its current CLI. A probe fail is an issue, exit 0, no page.
[CmdletBinding()]
param(
  [string]$Canary = "$PSScriptRoot\cli-canary.ps1",
  [string[]]$CanaryArgs = @(),
  [switch]$NoToast   # tests
)
. "$PSScriptRoot\_common.ps1"

$outDir = "$FleetHome\state\cli-canary"
New-Item -ItemType Directory -Force $outDir | Out-Null
$logPath = "$outDir\cli-canary.log"

$output = & powershell -NoProfile -ExecutionPolicy Bypass -File $Canary @CanaryArgs 2>&1 | Out-String
$exitCode = $LASTEXITCODE
$level = if ($exitCode -eq 0) { 'INFO' } else { 'ERROR' }
[IO.File]::AppendAllText($logPath, "$(Now-Iso) $level exit=$exitCode`r`n$output`r`n", $Utf8)
if ($exitCode -ne 0) {
  $last = $null
  foreach ($line in @($output -split "`n")) { try { $last = $line | ConvertFrom-Json } catch {} }
  $why = if ($last) { "$($last.outcome): $($last.detail)" } else { "exit $exitCode, no result line: $($output.Trim())" }
  Send-FleetPage -Kind 'cli-canary' -Title 'Fleet CLI canary failed' -Body "The daily CLI canary could not finish ($why). The fleet stays on its current CLI until it runs clean. Log: state/cli-canary/cli-canary.log" -Priority high -NoToast:$NoToast | Out-Null
  exit $exitCode
}
