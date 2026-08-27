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

Write-Output 'check-policy tests passed'
