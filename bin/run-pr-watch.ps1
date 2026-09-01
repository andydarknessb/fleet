# Task Scheduler entry point for the ticket-04 PR watcher (bin/pr-watch.js).
# Shadow-phase: maintains Work records and the wake outbox; it never messages a session.
# After each tick the ticket-07 projections (bin/digest.js: state/status/DIGEST.md and
# <tenant>-status.md) are rebuilt from the ledger, so the digest is never older than
# one watch interval. The notifier is NOT run here: a decision event launches it.
. "$PSScriptRoot\_common.ps1"

$outDir = "$FleetHome\state\watch"
$logPath = "$outDir\watch.log"
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
$output = & $nodeExecutable "$FleetHome\bin\pr-watch.js" 2>&1 | Out-String
$exitCode = $LASTEXITCODE
$level = if ($exitCode -eq 0) { 'INFO' } else { 'ERROR' }
[IO.File]::AppendAllText($logPath, "$(Now-Iso) $level exit=$exitCode`r`n$output`r`n", $Utf8)

# Ticket 07: the projections ride along regardless of the tick's exit code - a failed
# tick is itself something the digest should show, and the ledger is the source. A
# projection failure is logged here and never turns the watcher's own exit red: the
# watcher task reports the watcher.
$digestOutput = & $nodeExecutable "$FleetHome\bin\digest.js" 2>&1 | Out-String
$digestExit = $LASTEXITCODE
foreach ($tenantFile in @(Get-ChildItem "$FleetHome\tenants" -Filter *.json -ErrorAction SilentlyContinue)) {
  $digestOutput += & $nodeExecutable "$FleetHome\bin\digest.js" --tenant $tenantFile.BaseName 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { $digestExit = $LASTEXITCODE }
}
$digestLevel = if ($digestExit -eq 0) { 'INFO' } else { 'ERROR' }
[IO.File]::AppendAllText($logPath, "$(Now-Iso) $digestLevel digest exit=$digestExit`r`n$digestOutput`r`n", $Utf8)
if ($exitCode -ne 0) { exit $exitCode }
