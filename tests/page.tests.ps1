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

  # Case 6 (2026-09-17 review): Pushover rejects title > 250 or message > 1024
  # chars with a 400; both are clamped with an ellipsis before the POST, the
  # toast, or the audit line ever see them, and the call never throws.
  $longTitle = 'T' * 300
  $longBody = 'B' * 1100
  $r6 = & "$testRoot\bin\send-page.ps1" -Kind 'fleet-dead' -Title $longTitle -Body $longBody -Priority 'normal' -NoToast | ConvertFrom-Json
  Assert-True ($r6.title.Length -eq 250 -and $r6.title.EndsWith('...')) 'an over-long title must clamp to 250 chars with an ellipsis'
  Assert-True ($r6.body.Length -eq 1024 -and $r6.body.EndsWith('...')) 'an over-long body must clamp to 1024 chars with an ellipsis'
  $form6 = ConvertFrom-FormBody (@(Get-PostedBodies $logPath) | Select-Object -Last 1)
  Assert-True ($form6.title.Length -eq 250 -and $form6.message.Length -eq 1024) 'the clamped title and message, not the originals, must be what is posted'
  $pagesLines6 = @(Get-Content "$testRoot\state\pages\pages.jsonl" | Where-Object { $_ })
  $lastAudit = $pagesLines6[-1] | ConvertFrom-Json
  Assert-True ($lastAudit.title.Length -eq 250 -and $lastAudit.body.Length -eq 1024) 'the audit line must record the clamped values'

  # ===== 2026-09-17 review (fleet #76-6/#76-9): creds granularity and delivery =====
  # ===== failure modes QA verified by hand, now guarded =====

  # Case 7 (red-tell): a malformed pushover.json (bad JSON) is distinguished from
  # a plain absent file - creds-unreadable, never a throw.
  $postsBeforeCase7 = @(Get-PostedBodies $logPath).Count
  Write-Utf8 "$testRoot\state\pages\pushover.json" '{oops'
  $r7 = & "$testRoot\bin\send-page.ps1" -Kind 'fleet-dead' -Title 'Fleet watchdog' -Body 'malformed creds test' -Priority 'normal' -NoToast | ConvertFrom-Json
  Assert-True ($r7.pushover -eq 'creds-unreadable') 'a malformed pushover.json must record creds-unreadable, never throw'
  Assert-True (@(Get-PostedBodies $logPath).Count -eq $postsBeforeCase7) 'malformed creds must not attempt a POST'

  # Case 8 (red-tell): a half-filled pushover.json (user missing) is
  # creds-incomplete, distinct from both unconfigured and creds-unreadable.
  Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-123"}'
  $r8 = & "$testRoot\bin\send-page.ps1" -Kind 'fleet-dead' -Title 'Fleet watchdog' -Body 'incomplete creds test' -Priority 'normal' -NoToast | ConvertFrom-Json
  Assert-True ($r8.pushover -eq 'creds-incomplete') 'a half-filled pushover.json must record creds-incomplete'
  Assert-True (@(Get-PostedBodies $logPath).Count -eq $postsBeforeCase7) 'incomplete creds must not attempt a POST'

  # Case 9: neither token nor user ever appears in the pages.jsonl audit trail,
  # for any of the deliveries already sent above (verified once here, over the
  # whole audit file so far, rather than duplicating per-case).
  Write-Utf8 "$testRoot\state\pages\pushover.json" '{"token":"tok-123","user":"usr-456"}'
  $fullAudit = Get-Content "$testRoot\state\pages\pages.jsonl" -Raw
  Assert-True ($fullAudit -notmatch 'tok-123') 'the Pushover token must never appear in pages.jsonl'
  Assert-True ($fullAudit -notmatch 'usr-456') 'the Pushover user key must never appear in pages.jsonl'

  # Cases 10-12: Pushover HTTP failure modes - a 4xx, a 5xx, and connection
  # refused all record pushover:$false with the error captured, never a throw,
  # and still write exactly one audit line each.
  function Start-MockPushoverStatus {
    # Answers exactly one request with the given HTTP status, then stops - for
    # asserting a single non-200 response rather than the always-200 listener above.
    param([int]$StatusCode)
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $prefix = "http://127.0.0.1:$port/"
    $job = Start-Job -ScriptBlock {
      param($Prefix, $Code)
      $listener = New-Object System.Net.HttpListener
      $listener.Prefixes.Add($Prefix)
      $listener.Start()
      $context = $listener.GetContext()
      $reader = New-Object IO.StreamReader($context.Request.InputStream, $context.Request.ContentEncoding)
      $null = $reader.ReadToEnd(); $reader.Close()
      $context.Response.StatusCode = $Code
      $buffer = [Text.Encoding]::UTF8.GetBytes('{"status":0,"errors":["denied"]}')
      $context.Response.ContentLength64 = $buffer.Length
      $context.Response.OutputStream.Write($buffer, 0, $buffer.Length)
      $context.Response.OutputStream.Close()
      $listener.Stop()
    } -ArgumentList $prefix, $StatusCode
    Start-Sleep -Milliseconds 400
    return [pscustomobject]@{ Job = $job; Prefix = $prefix }
  }

  $statusMock = $null
  try {
    # Case 10: HTTP 4xx (400, a rejected request) is a recorded failure, never a throw.
    $statusMock = Start-MockPushoverStatus -StatusCode 400
    $oldUrlForStatus = $env:FLEET_PUSHOVER_URL
    $env:FLEET_PUSHOVER_URL = $statusMock.Prefix
    $r10 = & "$testRoot\bin\send-page.ps1" -Kind 'fleet-dead' -Title 'Fleet watchdog' -Body '4xx test' -Priority 'normal' -NoToast | ConvertFrom-Json
    Assert-True ($r10.pushover -eq $false -and "$($r10.pushoverError)" -ne '') 'an HTTP 4xx must record pushover:false with an error, never throw'
    Stop-Job $statusMock.Job -ErrorAction SilentlyContinue; Remove-Job $statusMock.Job -Force -ErrorAction SilentlyContinue

    # Case 11: HTTP 5xx (503, Pushover down) is a recorded failure, never a throw.
    $statusMock = Start-MockPushoverStatus -StatusCode 503
    $env:FLEET_PUSHOVER_URL = $statusMock.Prefix
    $r11 = & "$testRoot\bin\send-page.ps1" -Kind 'fleet-dead' -Title 'Fleet watchdog' -Body '5xx test' -Priority 'normal' -NoToast | ConvertFrom-Json
    Assert-True ($r11.pushover -eq $false -and "$($r11.pushoverError)" -ne '') 'an HTTP 5xx must record pushover:false with an error, never throw'
    Stop-Job $statusMock.Job -ErrorAction SilentlyContinue; Remove-Job $statusMock.Job -Force -ErrorAction SilentlyContinue
    $statusMock = $null

    # Case 12: connection refused (nothing listening on the port) is a recorded
    # failure, never a throw.
    $refusedPort = Get-Random -Minimum 20000 -Maximum 40000
    $env:FLEET_PUSHOVER_URL = "http://127.0.0.1:$refusedPort/"
    $r12 = & "$testRoot\bin\send-page.ps1" -Kind 'fleet-dead' -Title 'Fleet watchdog' -Body 'connection refused test' -Priority 'normal' -NoToast | ConvertFrom-Json
    Assert-True ($r12.pushover -eq $false -and "$($r12.pushoverError)" -ne '') 'a refused connection must record pushover:false with an error, never throw'
  } finally {
    if ($statusMock -and $statusMock.Job) { Stop-Job $statusMock.Job -ErrorAction SilentlyContinue; Remove-Job $statusMock.Job -Force -ErrorAction SilentlyContinue }
    if ($oldUrlForStatus) { $env:FLEET_PUSHOVER_URL = $oldUrlForStatus } else { $env:FLEET_PUSHOVER_URL = $mock.Prefix }
  }

  # Case 13 (2026-09-17 QA, fleet #77 review #6): -Url reaches the actual POST.
  $r13 = & "$testRoot\bin\send-page.ps1" -Kind 'escalation:ic-1:stray' -Title 'Fleet watchdog' -Body 'a stray session' -Priority 'normal' -Url 'C:\fleet\state\escalations\20260917T000000Z-supervisor-ic-1-stray.json' -NoToast | ConvertFrom-Json
  Assert-True ($r13.pushover -eq $true) 'a page carrying -Url must still post to Pushover'
  $form13 = ConvertFrom-FormBody (@(Get-PostedBodies $logPath) | Select-Object -Last 1)
  Assert-True ($form13.url -eq 'C:\fleet\state\escalations\20260917T000000Z-supervisor-ic-1-stray.json') 'the -Url value must reach the actual Pushover POST'

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
