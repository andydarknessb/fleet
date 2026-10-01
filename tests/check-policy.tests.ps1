$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\bin\check-policy.ps1"

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Count { param($Values, [int]$Expected, [string]$Message) if (@($Values).Count -ne $Expected) { throw "$Message (expected $Expected, got $(@($Values).Count))" } }

$tenant = [pscustomobject]@{
  ciGates = @('gate')
  watchedChecks = @('watch')
  ignoredChecks = @('ignore')
}
$policy = Get-TenantCheckPolicy $tenant

$endzone = Get-Content "$PSScriptRoot\..\tenants\endzone.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$endzonePolicy = Get-TenantCheckPolicy $endzone
Assert-True ($endzonePolicy.WatchedChecks -contains 'scan') 'Endzone scan must be explicitly watched'
Assert-True ($endzonePolicy.WatchedChecks -contains 'discover') 'Endzone discover must be explicitly watched'
Assert-True ($endzonePolicy.WatchedChecks -contains 'reproduce') 'Endzone reproduce must be explicitly watched'

$overlapThrew = $false
try {
  Get-TenantCheckPolicy ([pscustomobject]@{ ciGates = @('same'); watchedChecks = @('same'); ignoredChecks = @() }) | Out-Null
} catch { $overlapThrew = $true }
Assert-True $overlapThrew 'overlapping classifications must be rejected'

$passing = Get-CheckPolicyEvaluation $policy @([pscustomobject]@{ name = 'watch'; status = 'COMPLETED'; conclusion = 'SUCCESS' })
Assert-Count $passing.WatchedPassing 1 'a passing watched check must be classified as passing'
Assert-Count $passing.WatchedFindings 0 'a passing watched check must not be a finding'

$failing = Get-CheckPolicyEvaluation $policy @([pscustomobject]@{ name = 'watch'; status = 'COMPLETED'; conclusion = 'FAILURE' })
Assert-Count $failing.WatchedFindings 1 'a failing watched check must surface as a finding'
Assert-Count $failing.GatePending 0 'a failing watched check must not make a gate pending'
Assert-Count $failing.GateFailures 0 'a failing watched check must not become a gate failure'

$pending = Get-CheckPolicyEvaluation $policy @([pscustomobject]@{ name = 'watch'; status = 'IN_PROGRESS'; conclusion = '' })
Assert-Count $pending.WatchedPending 1 'a pending watched check must be classified as pending'
Assert-Count $pending.GatePending 0 'a pending watched check must not block gates'

$skipped = Get-CheckPolicyEvaluation $policy @([pscustomobject]@{ name = 'watch'; status = 'COMPLETED'; conclusion = 'SKIPPED' })
Assert-Count $skipped.WatchedSkipped 1 'a skipped watched check must be classified as skipped'
Assert-Count $skipped.WatchedFindings 0 'a skipped watched check must not be a finding'

$missing = Get-CheckPolicyEvaluation $policy @()
Assert-Count $missing.WatchedMissing 1 'an absent watched check must be classified as missing'
Assert-Count $missing.WatchedFindings 0 'an absent watched check must not be fabricated into a failure'

$unclassified = Get-CheckPolicyEvaluation $policy @([pscustomobject]@{ name = 'new-check'; status = 'COMPLETED'; conclusion = 'SUCCESS' })
Assert-True ($unclassified.Unclassified -contains 'new-check') 'an unknown check must remain unclassified'
Assert-True (-not ($unclassified.WatchedPassing -contains 'new-check')) 'an unclassified check must not silently become watched'

$gatePending = Get-CheckPolicyEvaluation $policy @([pscustomobject]@{ name = 'gate'; status = 'IN_PROGRESS'; conclusion = '' })
Assert-True ($gatePending.GatePending -contains 'gate') 'existing pending-gate behavior must remain active'

$gateFailure = Get-CheckPolicyEvaluation $policy @([pscustomobject]@{ name = 'gate'; status = 'COMPLETED'; conclusion = 'FAILURE' })
Assert-Count $gateFailure.GateFailures 1 'existing gate failures must remain gate failures'

# fleet #232: config/cycle.json pages.priority.<kind> and pages.defaultPriority must
# each be one of emergency|high|normal. Get-PagesPriorityFindings reports every value
# that is not, by dotted key and value, so bin/setup.ps1 can name the typo before the
# Watchdog ever meets it (the Watchdog itself falls back and pages; it never throws).
$pagesFindings = @(Get-PagesPriorityFindings ([pscustomobject]@{
  priority = [pscustomobject]@{ 'permission-wait' = 'hgih'; 'fleet-dead' = 'high'; 'dated' = 'normal' }
  defaultPriority = 'loud'
}))
Assert-Count $pagesFindings 2 'one finding per invalid page priority value'
Assert-True (@($pagesFindings | Where-Object { $_.Key -eq 'pages.priority.permission-wait' -and $_.Value -eq 'hgih' }).Count -eq 1) 'an invalid pages.priority.<kind> is reported by dotted key and value'
Assert-True (@($pagesFindings | Where-Object { $_.Key -eq 'pages.defaultPriority' -and $_.Value -eq 'loud' }).Count -eq 1) 'an invalid pages.defaultPriority is reported by key and value'
Assert-Count @(Get-PagesPriorityFindings $null) 0 'an absent pages block is not a finding'
Assert-Count @(Get-PagesPriorityFindings ([pscustomobject]@{ priority = [pscustomobject]@{ 'fleet-dead' = 'high' } })) 0 'a valid value is not a finding'
$shippedPages = (Get-Content "$PSScriptRoot\..\config\cycle.json" -Raw -Encoding UTF8 | ConvertFrom-Json).pages
Assert-Count @(Get-PagesPriorityFindings $shippedPages) 0 'the shipped config/cycle.json carries no invalid page priority'
$strPri = @(Get-PagesPriorityFindings ([pscustomobject]@{ priority = 'high' }))
Assert-True ($strPri.Count -eq 1 -and $strPri[0].Key -eq 'pages.priority' -and $strPri[0].Value -eq 'high') 'a pages.priority that is not a map is reported as pages.priority itself'

# fleet #274: pages.minAgeMinutes.<kind> must be a number of minutes, 0 or more.
Assert-Count @(Get-PagesPriorityFindings ([pscustomobject]@{ minAgeMinutes = [pscustomobject]@{ 'sync-unattested' = [decimal]60.5 } })) 0 'a decimal number of minutes is not a finding'
Assert-Count @(Get-PagesPriorityFindings ([pscustomobject]@{ minAgeMinutes = [pscustomobject]@{ 'sync-unattested' = 60; 'x' = 0 } })) 0 'a non-negative number of minutes is not a finding'
$badAge = @(Get-PagesPriorityFindings ([pscustomobject]@{ minAgeMinutes = [pscustomobject]@{ 'sync-unattested' = 'soon'; 'sync-blocked' = -5 } }))
Assert-Count $badAge 2 'a string and a negative number are each a finding'
Assert-True (@($badAge | Where-Object { $_.Key -eq 'pages.minAgeMinutes.sync-unattested' -and $_.Value -eq 'soon' }).Count -eq 1) 'an invalid minAgeMinutes value is reported by dotted key and value'
$strAge = @(Get-PagesPriorityFindings ([pscustomobject]@{ minAgeMinutes = 60 }))
Assert-True ($strAge.Count -eq 1 -and $strAge[0].Key -eq 'pages.minAgeMinutes') 'a pages.minAgeMinutes that is not a map is reported as itself'

# fleet #274 QA: watchdog.syncStallMinutes must be a number of minutes above 0 (Get-SyncStallMinutes
# falls back to 120 on anything else, so a typo would otherwise be silent).
Assert-Count @(Get-WatchdogSyncStallFindings $null) 0 'an absent watchdog block is not a finding'
Assert-Count @(Get-WatchdogSyncStallFindings ([pscustomobject]@{ staleMinutes = 45 })) 0 'an absent syncStallMinutes is not a finding'
Assert-Count @(Get-WatchdogSyncStallFindings ([pscustomobject]@{ syncStallMinutes = 120 })) 0 'a positive number is not a finding'
Assert-Count @(Get-WatchdogSyncStallFindings ([pscustomobject]@{ syncStallMinutes = [decimal]90.5 })) 0 'a decimal number of minutes is not a finding'
Assert-Count @(Get-WatchdogSyncStallFindings (Get-Content "$PSScriptRoot\..\config\cycle.json" -Raw -Encoding UTF8 | ConvertFrom-Json).watchdog) 0 'the shipped config/cycle.json carries a valid syncStallMinutes'
foreach ($bad in 'soon', 0, -5, $true) {
  $f = @(Get-WatchdogSyncStallFindings ([pscustomobject]@{ syncStallMinutes = $bad }))
  Assert-True ($f.Count -eq 1 -and $f[0].Key -eq 'watchdog.syncStallMinutes' -and $f[0].Value -eq "$bad") "syncStallMinutes '$bad' is reported by dotted key and value"
}

Write-Output 'check-policy tests passed'
