# Run the read-only cycle collector with a bounded daily window.
# This script is the Task Scheduler entry point; it never changes fleet decisions.
. "$PSScriptRoot\_common.ps1"

$until = (Get-Date).ToUniversalTime()
$since = $until.AddDays(-1)
$untilText = $until.ToString('o')
$sinceText = $since.ToString('o')
$outDir = "$FleetHome\state\metrics"
$logPath = "$outDir\collector.log"
New-Item -ItemType Directory -Force $outDir | Out-Null

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
$nodeArgs = @(
  "$FleetHome\bin\measure-cycle.js",
  '--roster', "$FleetHome\state\roster.json",
  '--out', $outDir,
  '--since', $sinceText,
  '--until', $untilText,
  '--now', $untilText
)
$output = & $nodeExecutable @nodeArgs 2>&1 | Out-String
$exitCode = $LASTEXITCODE
$level = if ($exitCode -eq 0) { 'INFO' } else { 'ERROR' }
$entry = "$(Now-Iso) $level exit=$exitCode`r`n$output"
[IO.File]::AppendAllText($logPath, "$entry`r`n", $Utf8)
if ($exitCode -ne 0) { exit $exitCode }
