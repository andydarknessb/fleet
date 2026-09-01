# Task Scheduler entry point for ticket-06 rotation (bin/rotate.ps1 -Auto).
# Resumes any rotation interrupted between stop and launch, then rotates every
# session past a config/cycle.json threshold. PAUSE and state/flags/rotation-off
# make it a no-op (exit 3 from rotate.ps1 is a refusal, not a failure).
. "$PSScriptRoot\_common.ps1"

$outDir = "$FleetHome\state\rotation"
New-Item -ItemType Directory -Force $outDir | Out-Null
$logPath = "$outDir\rotation.log"

$output = & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\rotate.ps1" -Auto 2>&1 | Out-String
$exitCode = $LASTEXITCODE
$level = if ($exitCode -eq 0 -or $exitCode -eq 3) { 'INFO' } else { 'ERROR' }
[IO.File]::AppendAllText($logPath, "$(Now-Iso) $level exit=$exitCode`r`n$output`r`n", $Utf8)
if ($exitCode -ne 0 -and $exitCode -ne 3) { exit $exitCode }
