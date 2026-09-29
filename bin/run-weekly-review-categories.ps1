# Task Scheduler entry point for the #218 weekly review-category notice
# (bin/review-categories.js). Writes one dated paragraph to state/notices/ic.md for the
# previous Monday-to-Sunday week's top three finding categories; session start injects it
# for every IC until its own [until] date. Output and exit code go to
# state/metrics/review-categories.log.
. "$PSScriptRoot\_common.ps1"

$outDir = "$FleetHome\state\metrics"
New-Item -ItemType Directory -Force $outDir | Out-Null
$logPath = "$outDir\review-categories.log"

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
$output = & $nodeExecutable "$FleetHome\bin\review-categories.js" --root $FleetHome 2>&1 | Out-String
$exitCode = $LASTEXITCODE
$level = if ($exitCode -eq 0) { 'INFO' } else { 'ERROR' }
[IO.File]::AppendAllText($logPath, "$(Now-Iso) $level exit=$exitCode`r`n$output`r`n", $Utf8)
if ($exitCode -ne 0) { exit $exitCode }
