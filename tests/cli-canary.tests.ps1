# #337 (ADR 0016 Amendment 8): bin/cli-canary.ps1 against a fixture: a bare origin, a fleet
# checkout with the tier configs, and fake npm / gh / install-cli / claude (no network, no real CLI).
# Red-tell: all open tiers pass -> a PR branch bumps cli.json and the passing tiers (a closed
# passing tier reopens); an open tier fails -> an issue, no branch, no PR; a closed tier that
# fails gets the issue and stays closed beside the PR; an open PR/issue for the version stops
# the run before the install; -DryRun and an unchanged version write nothing.
$ErrorActionPreference = 'Stop'
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }
$sourceRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $sourceRoot (Join-Path 'bin' 'cli-canary.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('fleet-cli-canary-test-' + [guid]::NewGuid().ToString('N'))

function G { param([string]$Dir)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & git -C $Dir @args 2>&1 } finally { $ErrorActionPreference = $eap }
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') in ${Dir}: $out" }
  (@($out | ForEach-Object { "$_" }) -join "`n").Trim()
}

$ds = '{"baseUrl":"https://example.invalid","keyFile":"k","verifiedCliVersion":__V__}'
$hk = '{"profile":"allowlist","defaultMode":"acceptEdits","verifiedCliVersion":__V__,"additionalDirectories":[{"dir":"<fleet>","for":"x"},{"dir":"<repo>","for":"x"}],"allow":[{"rule":"Bash(git:*)","for":"x"}],"deny":[{"rule":"Bash(gh pr merge:*)","for":"x"}]}'
$ghPs1 = @'
# Fake gh: logs argv, copies any --body-file it receives, answers lists from prs.json / issues.json,
# and fails a subcommand named in fail.txt (e.g. "pr create").
$d = $env:FAKE_DIR
Add-Content -LiteralPath "$d\calls.log" -Value ($args -join ' ')
$sub = "$($args[0]) $($args[1])"
$i = [array]::IndexOf($args, '--body-file')
if ($i -ge 0) {
  New-Item -ItemType Directory -Force "$d\bodies" | Out-Null
  $n = @(Get-ChildItem "$d\bodies").Count
  Copy-Item -LiteralPath $args[$i + 1] -Destination "$d\bodies\$n-$($args[0]).txt"
}
if ((Test-Path "$d\fail.txt") -and ((Get-Content "$d\fail.txt" -Raw).Trim() -eq $sub)) { [Console]::Error.WriteLine("fake gh: $sub failed"); exit 1 }
if ($args[1] -eq 'list') { $f = "$d\$($args[0])s.json"; if (Test-Path $f) { Get-Content $f -Raw } else { '[]' } ; exit 0 }
"https://example.invalid/$($args[0])/1"
'@
$claudeJs = @'
// Fake claude: asserts on its argv, stdin and the settings file it is given, then plays a canned transcript.
const fs = require('fs'), path = require('path'), d = process.env.FAKE_DIR, a = process.argv.slice(2);
const bad = [];
const flag = (n) => a[a.indexOf(n) + 1];
const model = flag('--model');
const tier = model === 'haiku' ? 'haiku' : model === 'deepseek-flash' ? 'deepseek' : null;
if (!tier) bad.push('unexpected --model ' + model);
for (const f of ['--include-hook-events', '-p', '--strict-mcp-config', '--no-session-persistence', '--verbose']) if (!a.includes(f)) bad.push('missing ' + f);
if (flag('--output-format') !== 'stream-json') bad.push('output-format is not stream-json');
if (!process.env.FLEET_CLAUDE_CLI) bad.push('FLEET_CLAUDE_CLI is not set');
let s = {};
try { s = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8')); } catch (e) { bad.push('settings unreadable: ' + e.message); }
const env = s.env || {};
const fleet = process.env.FAKE_FLEET.split(String.fromCharCode(92)).join('/');
if (env.FLEET_ROLE !== 'ic') bad.push('FLEET_ROLE is not ic');
if (!env.FLEET_HOME || env.FLEET_HOME === fleet) bad.push('FLEET_HOME must be a scratch home, not the fleet root');
if (path.resolve(flag('--settings')) !== path.resolve(env.FLEET_HOME, 'state', 'sessions', env.FLEET_NAME + '.settings.json')) bad.push('settings are not at FLEET_HOME/state/sessions/<name>.settings.json');
if (!JSON.stringify(s.hooks || {}).includes(fleet + '/hooks/')) bad.push('hooks do not point at the fleet checkout');
if (tier === 'haiku') {
  if (!s.permissions || s.permissions.defaultMode !== 'acceptEdits') bad.push('haiku defaultMode is not acceptEdits');
  if (!(s.permissions.allow || []).includes('Bash(git:*)')) bad.push('haiku allow rules missing');
  if (!(s.permissions.additionalDirectories || []).includes(fleet)) bad.push('<fleet> token not resolved in additionalDirectories');
  if (env.FLEET_PERMISSIONS !== 'allowlist') bad.push('haiku FLEET_PERMISSIONS is not allowlist');
  if (env.ANTHROPIC_BASE_URL) bad.push('haiku must not carry the deepseek base URL');
}
if (tier === 'deepseek') {
  if (env.ANTHROPIC_BASE_URL !== 'https://example.invalid') bad.push('deepseek base URL missing');
  if (!/deepseek-key\.js$/.test(s.apiKeyHelper || '')) bad.push('deepseek apiKeyHelper missing');
  if (!s.permissions || s.permissions.defaultMode !== 'auto') bad.push('deepseek defaultMode is not auto');
}
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch (e) {}
if (stdin.length < 20) bad.push('no prompt on stdin');
if (bad.length) { fs.appendFileSync(d + '/assert-fail.log', tier + ': ' + bad.join('; ') + '\n'); process.exit(3); }
if (fs.existsSync(d + '/hang.txt')) setTimeout(() => {}, 60000);
else process.stdout.write(fs.readFileSync(d + '/' + tier + '.jsonl', 'utf8'));
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
  $fwd = $fleet.Replace('\', '/')
  Write-Utf8 "$fleet\fleet-settings.json" ('{"permissions":{"defaultMode":"auto"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -File C:/Users/Cory/fleet/hooks/stop.ps1"}]}]}}')
  G $fleet add -A; G $fleet commit --quiet -m seed --no-gpg-sign
  G $fleet remote add origin $origin; G $fleet push --quiet origin master
  Write-Utf8 "$fake\latest.txt" $Latest
  Write-Utf8 "$fake\npm.cmd" "@type `"$fake\latest.txt`"`r`n"
  Write-Utf8 "$fake\gh.ps1" $ghPs1
  Write-Utf8 "$fake\claude.js" $claudeJs
  Write-Utf8 "$fake\claude.cmd" "@node `"$fake\claude.js`" %*`r`n"
  Write-Utf8 "$fake\install.ps1" ('param([string]$Version,[switch]$Global)' + "`r`n" + 'Add-Content "' + $fake + '\installs.log" "$Version global=$Global"' + "`r`n" + 'Write-Output (@{ ok = $true; version = $Version; path = "' + $fake + '\claude.cmd" } | ConvertTo-Json -Compress)' + "`r`n")
  [pscustomobject]@{ root = $root; fleet = $fleet; origin = $origin; fake = $fake }
}

# One transcript: init, N Bash calls + results, one Read + result, then the result line.
function Set-Probe { param($F, [string]$Tier, [bool]$Pass = $true, [bool]$MsgId = $false, [string]$Mode = '', [bool]$IsError = $false, [bool]$NoDenialsField = $false, [bool]$NoResult = $false, [bool]$ReadFails = $false, [bool]$NoPre = $false, [bool]$NoIsError = $false)
  if (-not $Mode) { $Mode = if ($Tier -eq 'haiku') { 'acceptEdits' } else { 'auto' } }
  $want = if ($Tier -eq 'haiku') { 4 } else { 1 }
  $lines = @('{"type":"system","subtype":"init","permissionMode":"' + $Mode + '","model":"m"}')
  $id = if ($MsgId) { 'msg_01abc' } else { 'resp-1' }
  $calls = @(1..$want | ForEach-Object { @{ name = 'Bash'; id = "b$_"; err = $false } }) + @(@{ name = 'Read'; id = 'r1'; err = $ReadFails })
  foreach ($c in $calls) {
    if (-not $NoPre) { $lines += '{"type":"system","subtype":"hook_response","hook_event":"PreToolUse","hook_name":"PreToolUse:' + $c.name + '","outcome":"success"}' }
    $lines += '{"type":"assistant","message":{"id":"' + $id + '","content":[{"type":"tool_use","id":"' + $c.id + '","name":"' + $c.name + '","input":{}}]}}'
    $lines += '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"' + $c.id + '","is_error":' + ([string]$c.err).ToLower() + ',"content":"x"}]}}'
  }
  $den = if ($Pass) { '[]' } else { '[{"tool_name":"Bash","tool_input":{"command":"grep sk-abcdefghijklmnop \"C:/x\"}]"}}]' }
  $field = if ($NoDenialsField) { '' } else { ',"permission_denials":' + $den }
  if (-not $NoResult) { $lines += '{"type":"system","subtype":"hook_response","hook_event":"Stop","hook_name":"Stop","outcome":"success"}'; $lines += '{"type":"result"' + $(if ($NoIsError) { '' } else { ',"is_error":' + ([string]$IsError).ToLower() }) + $field + ',"total_cost_usd":0.01}' }
  Write-Utf8 "$($F.fake)\$Tier.jsonl" ($lines -join "`n")
}

function Run { param($F, [switch]$DryRun, [int]$Timeout = 60)
  $env:FAKE_DIR = $F.fake; $env:FAKE_FLEET = $F.fleet
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-FleetHome', $F.fleet, '-NpmExe', "$($F.fake)\npm.cmd", '-GhExe', "$($F.fake)\gh.ps1", '-InstallCli', "$($F.fake)\install.ps1", '-ProbeTimeoutSec', "$Timeout")
  if ($DryRun) { $a += '-DryRun' }
  $out = & powershell @a | Out-String
  $code = $LASTEXITCODE
  $r = ($out.Trim() -split "`n")[-1] | ConvertFrom-Json
  $r | Add-Member -NotePropertyName exit -NotePropertyValue $code
  $r
}
function Calls { param($F) if (Test-Path "$($F.fake)\calls.log") { Get-Content "$($F.fake)\calls.log" -Raw } else { '' } }
function Bodies { param($F) if (Test-Path "$($F.fake)\bodies") { (Get-ChildItem "$($F.fake)\bodies" | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n" } else { '' } }
function Branch-Exists { param($F) (G $F.origin branch --list 'fleet/cli-1.1.0') -ne '' }
function Show { param($F, [string]$Path) G $F.origin show "fleet/cli-1.1.0:$Path" }
function Assert-Fake-Happy { param($F, [string]$Where) Assert-True (-not (Test-Path "$($F.fake)\assert-fail.log")) "$Where : the fake claude's argument or settings assertions failed: $(if (Test-Path "$($F.fake)\assert-fail.log") { Get-Content "$($F.fake)\assert-fail.log" -Raw })" }
function Probe { param($R, [string]$Tier) $R.probes | Where-Object { $_.tier -eq $Tier } }

try {
  # all pass, both tiers open -> a PR bumping cli.json and both tiers
  $f = New-Fixture 'allpass'; Set-Probe $f haiku; Set-Probe $f deepseek
  $r = Run $f
  Assert-True ($r.outcome -eq "pr-opened" -and $r.exit -eq 0) "all pass: expected pr-opened, got $($r.outcome) $($r.detail) $(($r.probes | ForEach-Object { $_.why }) -join "; ") $(if (Test-Path ($f.fake + [char]92 + "assert-fail.log")) { Get-Content ($f.fake + [char]92 + "assert-fail.log") -Raw })"
  Assert-Fake-Happy $f 'all pass'
  Assert-True (Branch-Exists $f) 'all pass: the branch fleet/cli-1.1.0 must be pushed'
  Assert-True ((Show $f 'config/cli.json') -match '"1.1.0"') 'all pass: cli.json must name 1.1.0'
  Assert-True ((Show $f 'config/deepseek.json') -match '"verifiedCliVersion":"1.1.0"') 'all pass: deepseek bumped'
  Assert-True ((Show $f 'config/permissions-allowlist.json') -match '"verifiedCliVersion":"1.1.0"') 'all pass: haiku bumped'
  Assert-True ((Calls $f) -match 'pr create' -and (Calls $f) -notmatch 'issue create') 'all pass: one PR, no issue'
  Assert-True ((Calls $f) -match '--body-file' -and (Calls $f) -notmatch '--body ') 'all pass: the body goes through --body-file'
  Assert-True ((Bodies $f) -match 'haiku \(open\): PASS' -and (Bodies $f) -match 'deepseek \(open\): PASS') 'all pass: the PR body carries the probe output'
  Assert-True ((Get-Content "$($f.fake)\installs.log" -Raw).Trim() -eq '1.1.0 global=False') 'all pass: installs 1.1.0 once, without -Global'
  Assert-True ((G $f.fleet status --porcelain) -eq '') 'all pass: the checkout stays untouched'
  Assert-True ((G $f.fleet branch --list 'fleet/cli-*') -eq '') 'all pass: no local fleet/cli-<v> branch is left behind'
  Assert-True ((G $f.fleet worktree list) -notmatch 'fleet-cli-pr') 'all pass: the temp worktree is gone'

  # an open tier fails -> issue, no branch, no PR; the body (denial JSON, quotes and newlines) arrives whole
  $f = New-Fixture 'openfail'; Set-Probe $f haiku; Set-Probe $f deepseek -Pass $false
  $r = Run $f
  Assert-True ($r.outcome -eq 'issue-filed' -and $r.exit -eq 0) "open fail: expected issue-filed, got $($r.outcome)"
  Assert-True (-not (Branch-Exists $f)) 'open fail: no branch'
  Assert-True ((Calls $f) -match 'issue create' -and (Calls $f) -notmatch 'pr create') 'open fail: an issue, no PR'
  Assert-True ((Bodies $f) -match 'C:/x' -and (Bodies $f) -match 'REDACTED' -and (Bodies $f) -notmatch 'sk-abcdefghijklmnop') 'open fail: the issue body holds the denial, redacted, in one piece'
  Assert-True ((Bodies $f) -match 'no PR' -and (Bodies $f) -notmatch 'PR above') 'open fail: the issue never claims a PR'

  # deepseek answered with an Anthropic msg_ id -> fails
  $f = New-Fixture 'msgid'; Set-Probe $f haiku; Set-Probe $f deepseek -MsgId $true
  $r = Run $f
  Assert-True ($r.outcome -eq 'issue-filed' -and (Probe $r deepseek).why -match 'msg_') 'msg_ id: deepseek must fail on an Anthropic id'

  # positive evidence: each of these fails the open deepseek tier
  $cases = @(
    @{ n = 'mode'; a = @{ Mode = 'default' }; m = 'permissionMode' }
    @{ n = 'iserror'; a = @{ IsError = $true }; m = 'is_error' }
    @{ n = 'nodenials'; a = @{ NoDenialsField = $true }; m = 'permission_denials' }
    @{ n = 'noresult'; a = @{ NoResult = $true }; m = 'no result line' }
    @{ n = 'nopre'; a = @{ NoPre = $true }; m = 'hook evidence' }
    @{ n = 'noiserror'; a = @{ NoIsError = $true }; m = 'is_error' }
    @{ n = 'readfails'; a = @{ ReadFails = $true }; m = 'Read' }
  )
  foreach ($c in $cases) {
    $f = New-Fixture "ev-$($c.n)"; Set-Probe $f haiku; $pa = $c.a; Set-Probe $f deepseek @pa
    $r = Run $f
    Assert-True ($r.outcome -eq 'issue-filed' -and -not (Probe $r deepseek).pass -and (Probe $r deepseek).why -match $c.m) "evidence $($c.n): deepseek must fail on '$($c.m)', got '$((Probe $r deepseek).why)'"
    Assert-True ((Probe $r haiku).pass) "evidence $($c.n): haiku is unaffected"
  }

  # a hung CLI times out and fails
  $f = New-Fixture 'timeout'; Set-Probe $f haiku; Set-Probe $f deepseek; Write-Utf8 "$($f.fake)\hang.txt" 'x'
  $r = Run $f -Timeout 3
  Assert-True ($r.outcome -eq 'issue-filed' -and (Probe $r deepseek).why -match 'timed out') "timeout: expected a timeout failure, got '$((Probe $r deepseek).why)'"

  # a pr-create failure leaves no remote branch, so the next run opens the PR
  $f = New-Fixture 'stale-branch'; Set-Probe $f haiku; Set-Probe $f deepseek; Write-Utf8 "$($f.fake)\fail.txt" 'pr create'
  $r = Run $f
  Assert-True ($r.outcome -eq 'pr-failed' -and -not (Branch-Exists $f)) 'pr create failure: the pushed remote branch is deleted'
  Remove-Item "$($f.fake)\fail.txt"
  Assert-True ((Run $f).outcome -eq 'pr-opened') 'after a pr-create failure the next run opens the PR'
  # a stale remote branch from an older run is replaced
  $f = New-Fixture 'stale-remote'; Set-Probe $f haiku; Set-Probe $f deepseek; G $f.fleet push --quiet origin master:refs/heads/fleet/cli-1.1.0
  Assert-True ((Run $f).outcome -eq 'pr-opened') 'a stale remote branch with no open PR does not block the push'

  # a closed tier (null) that passes reopens in the same PR
  $f = New-Fixture 'reopen' -HaikuV 'null'; Set-Probe $f haiku; Set-Probe $f deepseek
  $r = Run $f
  Assert-True ($r.outcome -eq 'pr-opened') "reopen: expected pr-opened, got $($r.outcome) $($r.detail)"
  Assert-True ((Show $f 'config/permissions-allowlist.json') -match '"verifiedCliVersion":"1.1.0"') 'reopen: the closed tier is bumped'

  # a closed tier that fails stays closed: PR for the open one, plus an issue naming that PR
  $f = New-Fixture 'closedfail' -HaikuV '"0.9.0"'; Set-Probe $f haiku -Pass $false; Set-Probe $f deepseek
  $r = Run $f
  Assert-True ($r.outcome -eq 'pr-opened' -and $r.issue) 'closed fail: PR and an issue'
  Assert-True ((Show $f 'config/permissions-allowlist.json') -match '"verifiedCliVersion":"0.9.0"') 'closed fail: the tier stays closed on its old pin'
  Assert-True ((Show $f 'config/deepseek.json') -match '"1.1.0"') 'closed fail: the open tier is bumped'
  Assert-True ((Bodies $f) -match 'PR https://example.invalid/pr/1') 'closed fail: the issue names the PR that opened'

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
  Assert-True ($r.outcome -eq 'current' -and $r.exit -eq 0 -and -not (Test-Path "$($f.fake)\installs.log")) 'current: nothing runs'

  # exit-2 paths: each one exits 2 with its own outcome and never reports pr-opened / issue-filed
  $f = New-Fixture 'gh-pr-create'; Set-Probe $f haiku; Set-Probe $f deepseek; Write-Utf8 "$($f.fake)\fail.txt" 'pr create'
  $r = Run $f
  Assert-True ($r.outcome -eq 'pr-failed' -and $r.exit -eq 2 -and -not $r.pr) "gh pr create failure: got $($r.outcome) exit $($r.exit)"
  $f = New-Fixture 'gh-issue-create'; Set-Probe $f haiku; Set-Probe $f deepseek -Pass $false; Write-Utf8 "$($f.fake)\fail.txt" 'issue create'
  $r = Run $f
  Assert-True ($r.outcome -eq 'issue-failed' -and $r.exit -eq 2) "gh issue create failure: got $($r.outcome) exit $($r.exit)"
  $f = New-Fixture 'gh-list'; Write-Utf8 "$($f.fake)\fail.txt" 'pr list'
  $r = Run $f
  Assert-True ($r.outcome -eq 'gh-failed' -and $r.exit -eq 2 -and -not (Test-Path "$($f.fake)\installs.log")) "gh list failure: got $($r.outcome) exit $($r.exit)"
  $f = New-Fixture 'push-fail'; Set-Probe $f haiku; Set-Probe $f deepseek; G $f.fleet remote set-url --push origin (Join-Path $f.root 'nowhere.git')
  $r = Run $f
  Assert-True ($r.outcome -eq 'push-failed' -and $r.exit -eq 2) "push failure: got $($r.outcome) exit $($r.exit)"
  Assert-True ((Calls $f) -notmatch 'create' -and (G $f.fleet branch --list 'fleet/cli-*') -eq '') 'push failure: no PR and no local branch left'
  $f = New-Fixture 'npm-fail'; Write-Utf8 "$($f.fake)\latest.txt" 'not a version'
  $r = Run $f
  Assert-True ($r.outcome -eq 'npm-failed' -and $r.exit -eq 2) "npm failure: got $($r.outcome) exit $($r.exit)"
  $f = New-Fixture 'install-fail'; Write-Utf8 "$($f.fake)\install.ps1" 'Write-Output (@{ ok = $false; reason = "no" } | ConvertTo-Json -Compress); exit 2'
  $r = Run $f
  Assert-True ($r.outcome -eq 'install-failed' -and $r.exit -eq 2) "install failure: got $($r.outcome) exit $($r.exit)"
  $f = New-Fixture 'stderr-notice'; Set-Probe $f haiku; Set-Probe $f deepseek
  Write-Utf8 "$($f.fake)\npm.cmd" "@echo npm notice new major available 1>&2`r`n@type `"$($f.fake)\latest.txt`"`r`n"
  $r = Run $f
  Assert-True ($r.latest -eq '1.1.0') "npm stderr notice must not read as the version, got '$($r.latest)'"

  # the wrapper pages on every non-zero exit, and on a clean run it does not
  $w = Join-Path $testRoot 'wrapper'; [IO.Directory]::CreateDirectory("$w\bin") | Out-Null
  Copy-Item "$sourceRoot\bin\run-cli-canary.ps1", "$sourceRoot\bin\_common.ps1" "$w\bin"
  Write-Utf8 "$w\bin\fake-canary.ps1" 'Write-Output (@{ outcome = "pr-failed"; detail = "gh pr create failed" } | ConvertTo-Json -Compress); exit 2'
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$w\bin\run-cli-canary.ps1" -Canary "$w\bin\fake-canary.ps1" -NoToast | Out-Null
  Assert-True ($LASTEXITCODE -eq 2) 'wrapper: exit 2 is passed through'
  $pages = Get-Content "$w\state\pages\pages.jsonl" -Raw
  Assert-True ($pages -match 'cli-canary' -and $pages -match 'pr-failed' -and $pages -match 'high') 'wrapper: a non-zero exit pages at high priority with the outcome'
  Remove-Item "$w\state\pages\pages.jsonl"
  Write-Utf8 "$w\bin\fake-canary.ps1" 'Write-Output (@{ outcome = "current" } | ConvertTo-Json -Compress); exit 0'
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$w\bin\run-cli-canary.ps1" -Canary "$w\bin\fake-canary.ps1" -NoToast | Out-Null
  Assert-True ($LASTEXITCODE -eq 0 -and -not (Test-Path "$w\state\pages\pages.jsonl")) 'wrapper: a clean run does not page'
  # end to end through the real canary: a gh failure pages
  $f = New-Fixture 'wrapper-e2e'; Write-Utf8 "$($f.fake)\fail.txt" 'pr list'; $env:FAKE_DIR = $f.fake
  Copy-Item $script "$w\bin\cli-canary.ps1"
  Remove-Item "$w\state\pages\pages.jsonl" -ErrorAction SilentlyContinue
  $cmd = "& '$w\bin\run-cli-canary.ps1' -NoToast -CanaryArgs '-FleetHome','$($f.fleet)','-NpmExe','$($f.fake)\npm.cmd','-GhExe','$($f.fake)\gh.ps1'; exit `$LASTEXITCODE"
  & powershell -NoProfile -ExecutionPolicy Bypass -Command $cmd | Out-Null
  Assert-True ($LASTEXITCODE -eq 2 -and (Get-Content "$w\state\pages\pages.jsonl" -Raw) -match 'gh-failed') 'wrapper end to end: a gh failure exits 2 and pages'
} finally {
  Remove-Item Env:\FAKE_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\FAKE_FLEET -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'cli-canary tests passed'
