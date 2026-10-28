# Task Scheduler entry point for the fleet #337 CLI canary (bin/cli-canary.ps1; install-cli-canary-task.ps1
# registers it). One run a day: its JSON line goes to state/cli-canary/cli-canary.log, and a non-zero exit
# (npm, install or push failed) tells Task Scheduler the run itself failed. A probe fail is an issue, exit 0.
. "$PSScriptRoot\_common.ps1"

$outDir = "$FleetHome\state\cli-canary"
New-Item -ItemType Directory -Force $outDir | Out-Null
$logPath = "$outDir\cli-canary.log"

$output = & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\cli-canary.ps1" 2>&1 | Out-String
$exitCode = $LASTEXITCODE
$level = if ($exitCode -eq 0) { 'INFO' } else { 'ERROR' }
[IO.File]::AppendAllText($logPath, "$(Now-Iso) $level exit=$exitCode`r`n$output`r`n", $Utf8)
if ($exitCode -ne 0) { exit $exitCode }
