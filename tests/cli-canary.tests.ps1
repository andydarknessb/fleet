# #337 (ADR 0016 Amendment 8): bin/cli-canary.ps1 against a fixture: a bare origin, a fleet
# checkout with the tier configs, and fake npm / gh / install-cli / claude (no network, no real CLI).
# Red-tell: all open tiers pass -> a PR branch bumps cli.json and the passing tiers (a closed
# passing tier reopens); an open tier fails -> an issue, no branch, no PR; a closed tier that
# fails gets the issue and stays closed beside the PR; an open PR/issue for the version stops
# the run before the install; -DryRun and an unchanged version write nothing.
$ErrorActionPreference = 'Stop'
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\cli-canary.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('fleet-cli-canary-test-' + [guid]::NewGuid().ToString('N'))

function G { param([string]$Dir)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & git -C $Dir @args 2>&1 } finally { $ErrorActionPreference = $eap }
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') in ${Dir}: $out" }
  (@($out | ForEach-Object { "$_" }) -join "`n").Trim()
}

$ds = '{"baseUrl":"https://example.invalid","keyFile":"k","verifiedCliVersion":__V__}'
$hk = '{"profile":"allowlist","defaultMode":"acceptEdits","verifiedCliVersion":__V__,"additionalDirectories":[{"dir":"<fleet>","for":"x"},{"dir":"<repo>","for":"x"}],"allow":[{"rule":"Bash(git:*)","for":"x"}],"deny":[{"rule":"Bash(gh pr merge:*)","for":"x"}]}'
$ghJs = @'
const fs = require('fs'), d = process.env.FAKE_DIR, a = process.argv.slice(2);
fs.appendFileSync(d + '/calls.log', a.join(' ') + '\n');
const f = d + '/' + a[0] + 's.json';
if (a[1] === 'list') console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '[]');
else console.log('https://example.invalid/' + a[0] + '/1');
'@
$claudeJs = @'
const fs = require('fs'), d = process.env.FAKE_DIR, a = process.argv.slice(2);
const model = a[a.indexOf('--model') + 1];
process.stdout.write(fs.readFileSync(d + '/' + (model === 'haiku' ? 'haiku' : 'deepseek') + '.jsonl', 'utf8'));
'@

# $HaikuV / $DeepV are JSON literals: '"1.0.0"' or 'null'.
function New-Fixture { param([string]$Name, [string]$Current = '1.0.0', [string]$Latest = '1.1.0', [string]$HaikuV = '"1.0.0"', [string]$DeepV = '"1.0.0"')
  $root = Join-Path $testRoot $Name
  $origin = Join-Path $root 'origin.git'; $fleet = Join-Path $root 'fleet'; $fake = Join-Path $root 'fake'
  [IO.Directory]::CreateDirectory("$fleet\config") | Out-Null; [IO.Directory]::CreateDirectory($fake) | Out-Null
  G $root init --quiet --bare $origin
  G $fleet init --quiet; G $fleet config user.email 'f@example.invalid'; G $fleet config user.name f; G $fleet checkout --quiet -b master
  Write-Utf8 "$fleet\config\cli.json" ('{ "version": "' + $Current + '" }')
  Write-Utf8 "$fleet\config\deepseek.json" ($ds.Replace('__V__', $DeepV))
  Write-Utf8 "$fleet\config\permissions-allowlist.json" ($hk.Replace('__V__', $HaikuV))
  Write-Utf8 "$fleet\fleet-settings.json" '{"permissions":{"defaultMode":"auto"},"hooks":{"Stop":[]}}'
  G $fleet add -A; G $fleet commit --quiet -m seed --no-gpg-sign
  G $fleet remote add origin $origin; G $fleet push --quiet origin master
  Write-Utf8 "$fake\latest.txt" $Latest
  Write-Utf8 "$fake\npm.cmd" "@type `"$fake\latest.txt`"`r`n"
  Write-Utf8 "$fake\gh.js" $ghJs
  Write-Utf8 "$fake\gh.cmd" "@node `"$fake\gh.js`" %*`r`n"
  Write-Utf8 "$fake\claude.js" $claudeJs
  Write-Utf8 "$fake\claude.cmd" "@node `"$fake\claude.js`" %*`r`n"
  Write-Utf8 "$fake\install.ps1" ('param([string]$Version,[switch]$Global)' + "`r`n" + 'Add-Content "' + $fake + '\installs.log" "$Version global=$Global"' + "`r`n" + 'Write-Output (@{ ok = $true; version = $Version; path = "' + $fake + '\claude.cmd" } | ConvertTo-Json -Compress)' + "`r`n")
  [pscustomobject]@{ root = $root; fleet = $fleet; origin = $origin; fake = $fake }
}

function Set-Probe { param($F, [string]$Tier, [bool]$Pass = $true, [bool]$MsgId = $false)
  $mode = if ($Tier -eq 'haiku') { 'acceptEdits' } else { 'auto' }
  $want = if ($Tier -eq 'haiku') { 4 } else { 1 }
  $lines = @('{"type":"system","subtype":"init","permissionMode":"' + $mode + '","model":"m"}')
  $id = if ($MsgId) { 'msg_01abc' } else { 'resp-1' }
  1..$want | ForEach-Object { $lines += '{"type":"assistant","message":{"id":"' + $id + '","content":[{"type":"tool_use","name":"Bash","input":{}}]}}' }
  $lines += '{"type":"assistant","message":{"id":"' + $id + '","content":[{"type":"tool_use","name":"Read","input":{}}]}}'
  $den = if ($Pass) { '[]' } else { '[{"tool_name":"Bash","tool_input":{"command":"sk-abcdefghijklmnop"}}]' }
  $lines += '{"type":"result","is_error":false,"permission_denials":' + $den + ',"total_cost_usd":0.01}'
  Write-Utf8 "$($F.fake)\$Tier.jsonl" ($lines -join "`n")
}

function Run { param($F, [switch]$DryRun)
  $env:FAKE_DIR = $F.fake
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-FleetHome', $F.fleet, '-NpmExe', "$($F.fake)\npm.cmd", '-GhExe', "$($F.fake)\gh.cmd", '-InstallCli', "$($F.fake)\install.ps1", '-ProbeTimeoutSec', '60')
  if ($DryRun) { $a += '-DryRun' }
  $out = & powershell @a | Out-String
  ($out.Trim() -split "`n")[-1] | ConvertFrom-Json
}
function Calls { param($F) if (Test-Path "$($F.fake)\calls.log") { Get-Content "$($F.fake)\calls.log" -Raw } else { '' } }
function Branch-Exists { param($F) (G $F.origin branch --list 'fleet/cli-1.1.0') -ne '' }
function Show { param($F, [string]$Path) G $F.origin show "fleet/cli-1.1.0:$Path" }

try {
  # all pass, both tiers open -> a PR bumping cli.json and both tiers
  $f = New-Fixture 'allpass'; Set-Probe $f haiku; Set-Probe $f deepseek
  $r = Run $f
  Assert-True ($r.outcome -eq 'pr-opened') "all pass: expected pr-opened, got $($r.outcome) $($r.detail)"
  Assert-True (Branch-Exists $f) 'all pass: the branch fleet/cli-1.1.0 must be pushed'
  Assert-True ((Show $f 'config/cli.json') -match '"1.1.0"') 'all pass: cli.json must name 1.1.0'
  Assert-True ((Show $f 'config/deepseek.json') -match '"verifiedCliVersion":"1.1.0"') 'all pass: deepseek bumped'
  Assert-True ((Show $f 'config/permissions-allowlist.json') -match '"verifiedCliVersion":"1.1.0"') 'all pass: haiku bumped'
  Assert-True ((Calls $f) -match 'pr create' -and (Calls $f) -notmatch 'issue create') 'all pass: one PR, no issue'
  Assert-True ((Get-Content "$($f.fake)\installs.log" -Raw).Trim() -eq '1.1.0 global=False') 'all pass: installs 1.1.0 once, without -Global'
  Assert-True ((G $f.fleet status --porcelain) -eq '') 'all pass: the checkout stays untouched'

  # an open tier fails -> issue, no branch, no PR; the other tier's pass moves nothing
  $f = New-Fixture 'openfail'; Set-Probe $f haiku; Set-Probe $f deepseek -Pass $false
  $r = Run $f
  Assert-True ($r.outcome -eq 'issue-filed') "open fail: expected issue-filed, got $($r.outcome)"
  Assert-True (-not (Branch-Exists $f)) 'open fail: no branch'
  Assert-True ((Calls $f) -match 'issue create' -and (Calls $f) -notmatch 'pr create') 'open fail: an issue, no PR'
  Assert-True (($r.probes[1].denials -join ' ') -notmatch 'sk-abcdefghijklmnop' -and ($r.probes[1].denials -join ' ') -match 'REDACTED') 'open fail: the key shape is redacted'

  # deepseek answered with an Anthropic msg_ id -> fails
  $f = New-Fixture 'msgid'; Set-Probe $f haiku; Set-Probe $f deepseek -MsgId $true
  $r = Run $f
  Assert-True ($r.outcome -eq 'issue-filed' -and $r.probes[1].why -match 'msg_') 'msg_ id: deepseek must fail on an Anthropic id'

  # a closed tier (null) that passes reopens in the same PR
  $f = New-Fixture 'reopen' -HaikuV 'null'; Set-Probe $f haiku; Set-Probe $f deepseek
  $r = Run $f
  Assert-True ($r.outcome -eq 'pr-opened') "reopen: expected pr-opened, got $($r.outcome) $($r.detail)"
  Assert-True ((Show $f 'config/permissions-allowlist.json') -match '"verifiedCliVersion":"1.1.0"') 'reopen: the closed tier is bumped'

  # a closed tier that fails stays closed: PR for the open one, plus an issue
  $f = New-Fixture 'closedfail' -HaikuV '"0.9.0"'; Set-Probe $f haiku -Pass $false; Set-Probe $f deepseek
  $r = Run $f
  Assert-True ($r.outcome -eq 'pr-opened' -and $r.issue) 'closed fail: PR and an issue'
  Assert-True ((Show $f 'config/permissions-allowlist.json') -match '"verifiedCliVersion":"0.9.0"') 'closed fail: the tier stays closed on its old pin'
  Assert-True ((Show $f 'config/deepseek.json') -match '"1.1.0"') 'closed fail: the open tier is bumped'

  # duplicate guard: an open PR stops the run before the install; so does an open issue
  $f = New-Fixture 'duppr'; Write-Utf8 "$($f.fake)\prs.json" '[{"number":7}]'
  $r = Run $f
  Assert-True ($r.outcome -eq 'duplicate' -and -not (Test-Path "$($f.fake)\installs.log")) 'dup PR: nothing installed'
  $f = New-Fixture 'dupissue'; Write-Utf8 "$($f.fake)\issues.json" '[{"number":8,"title":"cli-canary: Claude Code 1.1.0 failed the probe for deepseek"}]'
  Assert-True ((Run $f).outcome -eq 'duplicate') 'dup issue: nothing runs'
  $f = New-Fixture 'otherissue'; Set-Probe $f haiku; Set-Probe $f deepseek; Write-Utf8 "$($f.fake)\issues.json" '[{"number":8,"title":"cli-canary: Claude Code 1.0.9 failed"}]'
  Assert-True ((Run $f).outcome -eq 'pr-opened') 'an issue for another version is no duplicate'

  # dry run: probes, prints, writes nothing
  $f = New-Fixture 'dry'; Set-Probe $f haiku; Set-Probe $f deepseek
  $r = Run $f -DryRun
  Assert-True ($r.outcome -eq 'dry-run:would-open-pr' -and $r.probes.Count -eq 2) "dry run: expected would-open-pr, got $($r.outcome)"
  Assert-True (-not (Branch-Exists $f) -and (Calls $f) -notmatch 'create') 'dry run: no branch, PR or issue'
  $f = New-Fixture 'dryfail'; Set-Probe $f haiku; Set-Probe $f deepseek -Pass $false
  Assert-True ((Run $f -DryRun).outcome -eq 'dry-run:would-file-issue') 'dry run: a failing open tier would file an issue'

  # nothing newer
  $f = New-Fixture 'current' -Latest '1.0.0'
  $r = Run $f
  Assert-True ($r.outcome -eq 'current' -and -not (Test-Path "$($f.fake)\installs.log")) 'current: nothing runs'
} finally {
  Remove-Item Env:\FAKE_DIR -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'cli-canary tests passed'
