# One-time setup. Idempotent. Run: powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Cory\fleet\bin\setup.ps1
. "$PSScriptRoot\_common.ps1"
. "$PSScriptRoot\check-policy.ps1"
$v = (& claude --version 2>$null | Out-String).Trim()
Write-Output "claude: $v"
if ($v -notmatch '(\d+)\.(\d+)\.(\d+)') { Write-Error 'claude not found'; exit 1 }
$ver = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
if ($ver -lt [version]'2.1.234') { Write-Error "cross-session messaging on native Windows needs >= 2.1.234 (have $ver)"; exit 1 }
foreach ($d in 'heartbeats','status','escalations','sessions','sentinel','continue') { New-Item -ItemType Directory -Force "$FleetHome\state\$d" | Out-Null }
if (-not (Test-Path "$FleetHome\state\roster.json")) { Write-Json "$FleetHome\state\roster.json" ([pscustomobject]@{ sessions = @() }) }
$agentsLink = "$env:USERPROFILE\.claude\agents"
if (Test-Path $agentsLink) {
  $item = Get-Item $agentsLink -Force
  if ($item.LinkType -eq 'Junction' -and ("$($item.Target)" -like '*fleet*agents*')) { Write-Output "agents junction already in place" }
  else { Write-Warning "$agentsLink exists and is not the fleet junction; move it aside (rmdir if it is an empty dir) and rerun" }
} else {
  New-Item -ItemType Junction -Path $agentsLink -Target "$FleetHome\agents" | Out-Null
  Write-Output "junction: $agentsLink -> $FleetHome\agents  (remove with rmdir, never rm -r)"
}
foreach ($tf in (Get-ChildItem "$FleetHome\tenants" -Filter *.json)) {
  $tj = Read-Json $tf.FullName
  try { $null = Get-TenantCheckPolicy $tj } catch { Write-Error "tenant $($tf.Name): invalid check policy: $($_.Exception.Message)"; exit 1 }
  $labels = (& gh label list -R $tj.github --limit 100 2>$null | Out-String)
  $ok = $labels -match [regex]::Escape($tj.readyLabel)
  $repoOk = 'MISSING'; if (Test-Path $tj.repo) { $repoOk = 'ok' }
  $labelOk = 'MISSING'; if ($ok) { $labelOk = 'ok' }
  Write-Output "tenant $($tj.name): repo $repoOk, label '$($tj.readyLabel)' $labelOk"
}
Write-Output "setup complete. Next: bin\pilot.ps1 to start the pilot, bin\status.ps1 to watch."
