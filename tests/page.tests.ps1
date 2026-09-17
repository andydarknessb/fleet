$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-page-test-" + [guid]::NewGuid().ToString('N'))
$oldPushoverUrl = $env:FLEET_PUSHOVER_URL
$mockJob = $null

function Start-MockPushover {
  # A tiny local HTTP server standing in for Pushover, run in a background job (a
  # separate process, so it can block on GetContext() while this script posts to
  # it): records every POST body as one line of $LogPath and always answers 200.
  # The port is randomized to avoid colliding with a leftover listener.
  param([string]$LogPath, [int]$Count = 10)
  $port = Get-Random -Minimum 20000 -Maximum 40000
  $prefix = "http://127.0.0.1:$port/"
  $job = Start-Job -ScriptBlock {
    param($Prefix, $LogPath, $RequestCount)
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add($Prefix)
    $listener.Start()
    for ($i = 0; $i -lt $RequestCount; $i++) {
      $context = $listener.GetContext()
      $reader = New-Object IO.StreamReader($context.Request.InputStream, $context.Request.ContentEncoding)
      $body = $reader.ReadToEnd()
      $reader.Close()
      Add-Content -Path $LogPath -Value $body
      $buffer = [Text.Encoding]::UTF8.GetBytes('{"status":1,"request":"test"}')
      $context.Response.ContentLength64 = $buffer.Length
      $context.Response.OutputStream.Write($buffer, 0, $buffer.Length)
      $context.Response.OutputStream.Close()
    }
    $listener.Stop()
  } -ArgumentList $prefix, $LogPath, $Count
  Start-Sleep -Milliseconds 400   # let the listener bind before the first post
  return [pscustomobject]@{ Job = $job; Prefix = $prefix }
}

function Get-PostedBodies { param([string]$LogPath) if (Test-Path $LogPath) { @(Get-Content $LogPath | Where-Object { $_ }) } else { @() } }

function ConvertFrom-FormBody {
  # Pushover wants form-urlencoded, which is what Invoke-RestMethod sends for a
  # hashtable -Body with no -ContentType; parse it back for assertions.
  param([string]$Body)
  $result = @{}
  foreach ($pair in ($Body -split '&')) {
    if (-not $pair) { continue }
    $parts = $pair -split '=', 2
    $key = [Uri]::UnescapeDataString($parts[0])
    $value = if ($parts.Count -gt 1) { [Uri]::UnescapeDataString($parts[1]) } else { '' }
    $result[$key] = $value
  }
  return $result
}

try {
  foreach ($dir in 'bin', 'state/pages') { [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null }
  foreach ($f in '_common.ps1', 'send-page.ps1') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-123","user":"usr-456"}'

  $logPath = Join-Path $testRoot 'pushover-requests.log'
  [IO.File]::WriteAllText($logPath, '')
  $mock = Start-MockPushover -LogPath $logPath
  $mockJob = $mock.Job
  $env:FLEET_PUSHOVER_URL = $mock.Prefix

  # Case 1 (red-tell): emergency priority maps to Pushover priority 2 with retry
  # and expire, and the delivery is recorded in state/pages/pages.jsonl. Remove
  # the priority mapping (or the retry/expire-only-at-2 rule) and this goes red.
  $r1 = & "$testRoot\bin\send-page.ps1" -Kind 'fleet-dead' -Title 'Fleet watchdog' -Body 'the fleet is not self-healing' -Priority 'emergency' -NoToast | ConvertFrom-Json
  Assert-True ($r1.pushover -eq $true) 'an emergency page must post to Pushover'
  $bodies = @(Get-PostedBodies $logPath)
  Assert-True ($bodies.Count -eq 1) 'exactly one POST must reach Pushover'
  $form1 = ConvertFrom-FormBody $bodies[0]
  Assert-True ($form1.priority -eq '2') 'emergency must map to Pushover priority 2'
  Assert-True ($form1.retry -eq '120' -and $form1.expire -eq '7200') 'emergency alone carries retry and expire'
  Assert-True ($form1.token -eq 'tok-123' -and $form1.user -eq 'usr-456') 'the credentials from state/pages/pushover.json must be sent'
  $pagesLines = @(Get-Content "$testRoot\state\pages\pages.jsonl" | Where-Object { $_ })
  Assert-True ($pagesLines.Count -eq 1) 'one audit line must be written'
  $paged1 = $pagesLines[0] | ConvertFrom-Json
  Assert-True ($paged1.kind -eq 'fleet-dead' -and $paged1.priority -eq 'emergency' -and $paged1.pushover -eq $true) 'the audit line must record the kind, priority and delivery result'

  # Case 2: high priority maps to 1, and carries no retry or expire.
  $r2 = & "$testRoot\bin\send-page.ps1" -Kind 'permission-wait' -Title 'Fleet watchdog' -Body 'ic-901 is stuck on a prompt' -Priority 'high' -NoToast | ConvertFrom-Json
  Assert-True ($r2.pushover -eq $true) 'a high page must post to Pushover'
  $form2 = ConvertFrom-FormBody (@(Get-PostedBodies $logPath)[1])
  Assert-True ($form2.priority -eq '1') 'high must map to Pushover priority 1'
  Assert-True ((-not $form2.ContainsKey('retry')) -and (-not $form2.ContainsKey('expire'))) 'high must not carry retry or expire'

  # Case 3: normal priority maps to 0, and carries no retry or expire.
  $r3 = & "$testRoot\bin\send-page.ps1" -Kind 'state-hold' -Title 'Fleet watchdog' -Body 'a PR is waiting on your merge' -Priority 'normal' -NoToast | ConvertFrom-Json
  Assert-True ($r3.pushover -eq $true) 'a normal page must post to Pushover'
  $form3 = ConvertFrom-FormBody (@(Get-PostedBodies $logPath)[2])
  Assert-True ($form3.priority -eq '0') 'normal must map to Pushover priority 0'
  Assert-True ((-not $form3.ContainsKey('retry')) -and (-not $form3.ContainsKey('expire'))) 'normal must not carry retry or expire'

  # Case 4: an unconfigured channel (no state/pages/pushover.json) is a recorded
  # result, never a throw.
  Remove-Item "$testRoot\state\pages\pushover.json"
  $r4 = & "$testRoot\bin\send-page.ps1" -Kind 'fleet-dead' -Title 'Fleet watchdog' -Body 'unconfigured test' -Priority 'emergency' -NoToast | ConvertFrom-Json
  Assert-True ($r4.pushover -eq 'unconfigured') 'a missing pushover.json must record "unconfigured", never throw'
  Assert-True (@(Get-PostedBodies $logPath).Count -eq 3) 'an unconfigured channel must not attempt a POST'
  $pagesLines4 = @(Get-Content "$testRoot\state\pages\pages.jsonl" | Where-Object { $_ })
  Assert-True ($pagesLines4.Count -eq 4) 'an unconfigured page still writes its audit line'
  Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-123","user":"usr-456"}'

  # Case 5: the toast is skipped under -NoToast, never attempted.
  Assert-True ($r1.toast -eq 'skipped') '-NoToast must skip the toast, never attempt it'

  Write-Output 'page tests passed'
} finally {
  if ($mockJob) { Stop-Job $mockJob -ErrorAction SilentlyContinue; Remove-Job $mockJob -Force -ErrorAction SilentlyContinue }
  if ($oldPushoverUrl) { $env:FLEET_PUSHOVER_URL = $oldPushoverUrl } else { Remove-Item Env:FLEET_PUSHOVER_URL -ErrorAction SilentlyContinue }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-page-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
