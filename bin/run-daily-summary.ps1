# Task Scheduler entry point for ticket-80 daily summary (bin/daily-summary.js).
# One page a day (08:00 Central; install-daily-summary-task.ps1 registers it):
# every decision row still waiting on Cory - hold or escalated - oldest first,
# with how long it has waited. Nothing waiting sends nothing, so a quiet day
# never pages; the script's own exit code still tells Task Scheduler whether
# the run itself succeeded.
. "$PSScriptRoot\_common.ps1"

$outDir = "$FleetHome\state\notify"
New-Item -ItemType Directory -Force $outDir | Out-Null
$logPath = "$outDir\daily-summary.log"

$nodePath = $env:FLEET_NODE_PATH
if ($nodePath -and -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  $message = "FLEET_NODE_PATH does not point to a Node executable: $nodePath"
  [IO.File]::AppendAllText($logPath, "$(Now-Iso) ERROR $message`r`n", $Utf8)
  Write-Error $message
  exit 1
}
$node = if ($nodePath) { Get-Item -LiteralPath $nodePath } else { Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) {
  $message = "Node was not found. Set FLEET_NODE_PATH to the node.exe used by the fleet."
  [IO.File]::AppendAllText($logPath, "$(Now-Iso) ERROR $message`r`n", $Utf8)
  Write-Error $message
  exit 1
}

$nodeExecutable = if ($nodePath) { $node.FullName } else { $node.Source }
$output = & $nodeExecutable "$FleetHome\bin\daily-summary.js" --root $FleetHome 2>&1 | Out-String
$exitCode = $LASTEXITCODE
$level = if ($exitCode -eq 0) { 'INFO' } else { 'ERROR' }
[IO.File]::AppendAllText($logPath, "$(Now-Iso) $level exit=$exitCode`r`n$output`r`n", $Utf8)
if ($exitCode -ne 0) { exit $exitCode }
