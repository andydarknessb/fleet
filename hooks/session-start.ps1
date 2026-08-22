# SessionStart hook for fleet sessions. Prints context Claude can see.
$ErrorActionPreference = 'SilentlyContinue'
$null = [Console]::In.ReadToEnd()
$home_ = $env:FLEET_HOME; if (-not $home_) { exit 0 }
$name = $env:FLEET_NAME; $role = $env:FLEET_ROLE; $tenant = $env:FLEET_TENANT; $parent = $env:FLEET_PARENT
if (-not $name) { exit 0 }
$tenantLabel = if ($tenant) { $tenant } else { 'none' }
Write-Output "=== FLEET CONTEXT ==="
Write-Output "You are fleet session '$name' (role: $role, tenant: $tenantLabel, reports to: $parent)."
Write-Output "Fleet home: $home_  (README.md is the operating guide; CONTEXT.md is the vocabulary)."
if (Test-Path "$home_\state\PAUSE") {
  $p = Get-Content "$home_\state\PAUSE" -Raw
  Write-Output "PAUSE IS SET: $p. Do not launch sessions or continue work loops until it is cleared."
}
if ($tenant -and (Test-Path "$home_\tenants\$tenant.json")) {
  Write-Output "Tenant file: $home_\tenants\$tenant.json"
}
if ($env:FLEET_ISSUE) { Write-Output "Your unit of work: issue #$($env:FLEET_ISSUE). Nothing else." }
$roster = $null
try { $roster = Get-Content "$home_\state\roster.json" -Raw | ConvertFrom-Json } catch {}
if ($roster) {
  $active = @($roster.sessions | Where-Object { $_.status -eq 'active' })
  $names = @($active | ForEach-Object { "$($_.name)[$($_.role)]" }) -join ', '
  Write-Output "Roster (active): $names"
}
if ($role -eq 'sentinel') {
  Write-Output "Sentinel: if you have no pending 15-minute cron job, create one now with CronCreate (cron '*/15 * * * *', prompt: 'Run the sentinel check: powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Cory\fleet\bin\sentinel-check.ps1 -Apply, then act on its report per your role'). Recurring jobs expire after 7 days; recreate when this message appears."
}
if ($role -eq 'dispatcher') {
  Write-Output "Dispatcher: if you have no pending daily-digest cron job, create one with CronCreate (cron '57 7 * * *', prompt: 'Write the daily digest to C:\Users\Cory\fleet\state\STATUS.md and send it as a push notification'). Recreate when this message appears."
}
Write-Output "=== END FLEET CONTEXT ==="
exit 0
