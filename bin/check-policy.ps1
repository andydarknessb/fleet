# Tenant CI-check policy shared by setup validation and the project-lead stop hook.

function Get-CheckName {
  param($Check)
  $name = "$($Check.name)"
  if (-not $name) { $name = "$($Check.context)" }
  return $name
}

function Get-TenantCheckPolicy {
  param($Tenant)

  $lists = [ordered]@{
    ciGates = @($Tenant.ciGates)
    watchedChecks = @($Tenant.watchedChecks)
    ignoredChecks = @($Tenant.ignoredChecks)
  }
  $owners = @{}
  foreach ($field in $lists.Keys) {
    $seen = @{}
    foreach ($rawName in $lists[$field]) {
      $name = "$rawName".Trim()
      if (-not $name) { throw "$field contains an empty check name" }
      if ($seen.ContainsKey($name)) { throw "$field contains duplicate check '$name'" }
      $seen[$name] = $true
      if ($owners.ContainsKey($name)) {
        throw "check '$name' appears in both $($owners[$name]) and $field"
      }
      $owners[$name] = $field
    }
  }

  return [pscustomobject]@{
    CiGates = @($lists.ciGates)
    WatchedChecks = @($lists.watchedChecks)
    IgnoredChecks = @($lists.ignoredChecks)
    Owners = $owners
  }
}

function Get-CheckPolicyEvaluation {
  param(
    $Policy,
    [array]$CheckRollup
  )

  $observed = @{}
  foreach ($check in @($CheckRollup)) {
    $name = Get-CheckName $check
    if ($name) { $observed[$name] = $check }
  }

  $gatePending = @()
  $gateFailures = @()
  foreach ($name in $Policy.CiGates) {
    if (-not $observed.ContainsKey($name)) { continue }
    $check = $observed[$name]
    $status = "$($check.status)"
    $conclusion = "$($check.conclusion)"
    if (($status -and $status -ne 'COMPLETED') -or (-not $conclusion -and $status -ne 'COMPLETED')) {
      $gatePending += $name
    } elseif ($conclusion -ne 'SUCCESS') {
      $gateFailures += [pscustomobject]@{ Name = $name; Conclusion = $conclusion }
    }
  }

  $watchedPassing = @()
  $watchedFindings = @()
  $watchedPending = @()
  $watchedSkipped = @()
  $watchedMissing = @()
  foreach ($name in $Policy.WatchedChecks) {
    if (-not $observed.ContainsKey($name)) { $watchedMissing += $name; continue }
    $check = $observed[$name]
    $status = "$($check.status)"
    $conclusion = "$($check.conclusion)"
    if (($status -and $status -ne 'COMPLETED') -or (-not $conclusion -and $status -ne 'COMPLETED')) {
      $watchedPending += $name
    } elseif ($conclusion -eq 'SUCCESS') {
      $watchedPassing += $name
    } elseif ($conclusion -eq 'SKIPPED') {
      $watchedSkipped += $name
    } else {
      $watchedFindings += [pscustomobject]@{ Name = $name; Conclusion = $conclusion }
    }
  }

  $unclassified = @()
  foreach ($name in $observed.Keys) {
    if (-not $Policy.Owners.ContainsKey($name)) { $unclassified += $name }
  }

  return [pscustomobject]@{
    GatePending = @($gatePending)
    GateFailures = @($gateFailures)
    WatchedPassing = @($watchedPassing)
    WatchedFindings = @($watchedFindings)
    WatchedPending = @($watchedPending)
    WatchedSkipped = @($watchedSkipped)
    WatchedMissing = @($watchedMissing)
    Unclassified = @($unclassified | Sort-Object)
  }
}

# fleet #232: pages.priority.<kind> and pages.defaultPriority must be emergency|high|normal; the
# Watchdog falls back to a built-in for anything else, and setup.ps1 refuses it up front.
# Standalone on purpose (no _common.ps1): the set is repeated here.
function Get-PagesPriorityFindings {
  param($Pages)
  $valid = @('emergency', 'high', 'normal')
  if (-not $Pages) { return }
  $found = @()
  if ($Pages.PSObject.Properties['priority'] -and $Pages.priority) {
    if ($Pages.priority -isnot [pscustomobject]) {
      # not a map (a bare string, say): the block itself is the finding, not its .Length
      $found += [pscustomobject]@{ Key = 'pages.priority'; Value = "$($Pages.priority)" }
    } else {
      foreach ($p in $Pages.priority.PSObject.Properties) {
        if ($valid -notcontains "$($p.Value)") { $found += [pscustomobject]@{ Key = "pages.priority.$($p.Name)"; Value = "$($p.Value)" } }
      }
    }
  }
  if ($Pages.PSObject.Properties['defaultPriority'] -and $Pages.defaultPriority -and $valid -notcontains "$($Pages.defaultPriority)") {
    $found += [pscustomobject]@{ Key = 'pages.defaultPriority'; Value = "$($Pages.defaultPriority)" }
  }
  # fleet #274: pages.minAgeMinutes.<kind> must be a number of minutes, 0 or more (Expect names the rule).
  if ($Pages.PSObject.Properties['minAgeMinutes'] -and $null -ne $Pages.minAgeMinutes) {
    if ($Pages.minAgeMinutes -isnot [pscustomobject]) {
      $found += [pscustomobject]@{ Key = 'pages.minAgeMinutes'; Value = "$($Pages.minAgeMinutes)"; Expect = 'a map of kind to minutes' }
    } else {
      foreach ($p in $Pages.minAgeMinutes.PSObject.Properties) {
        $v = $p.Value
        if (-not (($v -is [int] -or $v -is [long] -or $v -is [double]) -and $v -ge 0)) { $found += [pscustomobject]@{ Key = "pages.minAgeMinutes.$($p.Name)"; Value = "$v"; Expect = 'a number of minutes, 0 or more' } }
      }
    }
  }
  $found
}
