<#
.SYNOPSIS  Fleet #337 (ADR 0016 Amendment 8): the daily Claude Code CLI canary.
  1. latest = `npm view @anthropic-ai/claude-code version`; current = config/cli.json `version`.
     Equal -> outcome "current", nothing else runs.
  2. Duplicate guard: an open PR on fleet/cli-<latest> or an open issue titled for that
     version -> outcome "duplicate", nothing else runs.
  3. Installs the candidate side by side (bin/install-cli.ps1 -Version <v>, no -Global; #336)
     and probes every tier under `claude -p` with FLEET_CLAUDE_CLI set to it, in a scratch cwd:
       deepseek: config/deepseek.json base URL + apiKeyHelper + the auto profile; passes on
                 permissionMode auto, permission_denials [] after an out-of-cwd Bash and Read,
                 and no Anthropic msg_ id in the transcript (DeepSeek served it).
       haiku:    config/permissions-allowlist.json under acceptEdits, running the IC's fixed
                 command list; passes on permissionMode acceptEdits and permission_denials [].
  4. A tier is OPEN when its verifiedCliVersion equals cli.json's version. Every open tier
     passes -> a PR on a temp worktree off origin/master, branch fleet/cli-<v>, bumping
     cli.json and every passing tier's verifiedCliVersion (a closed tier that passes reopens).
     Any open tier fails -> nothing moves; an issue carries the probe output. A closed tier
     that fails stays closed and gets the issue too.
  -DryRun probes and prints; no PR, issue, worktree or commit. Never merges, never touches
  the live checkout's files or state/. Prints one JSON line {outcome, ...}; exit 0 whatever the
  verdict, 2 when the candidate cannot be installed.
  Probe settings are the smallest equivalent of launch.ps1's composition (launch.ps1 needs a
  roster, tenant and manifest for even a -DryRun): fleet-settings.json minus hooks, plus the
  tier's profile. Hooks are dropped so the CLI's own rules decide; the tool-contract denies
  and the repoDeny rules are omitted (they only deny).
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$FleetHome = '',
  [string]$NpmExe = 'npm',
  [string]$GhExe = 'gh',
  [string]$GitExe = 'git',
  [string]$InstallCli = '',     # default bin\install-cli.ps1 (#336)
  [string]$Candidate = '',      # skip the install and probe this claude executable (acceptance runs, tests)
  [string]$CliConfig = '',      # default config\cli.json
  [string]$Remote = 'origin',
  [string]$Branch = 'master',
  [string]$Repo = '',           # owner/name for gh; derived from gh when empty
  [int]$ProbeTimeoutSec = 300
)
$ErrorActionPreference = 'Continue'
if (-not $FleetHome) { $FleetHome = Split-Path -Parent $PSScriptRoot }
if (-not $InstallCli) { $InstallCli = Join-Path $FleetHome 'bin\install-cli.ps1' }
if (-not $CliConfig) { $CliConfig = Join-Path $FleetHome 'config\cli.json' }
$utf8 = New-Object Text.UTF8Encoding $false
$result = [ordered]@{ outcome = $null; dryRun = [bool]$DryRun; latest = $null; current = $null; probes = @(); pr = $null; issue = $null; detail = $null; at = (Get-Date).ToUniversalTime().ToString('o') }

$scratchOut = Join-Path ([IO.Path]::GetTempPath()) ('fleet-cli-canary-out-' + [guid]::NewGuid().ToString('N'))   # issue and PR body files
[IO.Directory]::CreateDirectory($scratchOut) | Out-Null
function Finish { param([string]$Outcome, [string]$Detail = $null, [int]$Code = 0)
  if ($script:wt) { & $GitExe -C $FleetHome worktree remove --force $script:wt 2>$null | Out-Null; $script:wt = $null }
  Remove-Item -LiteralPath $scratchOut -Recurse -Force -ErrorAction SilentlyContinue
  $result.outcome = $Outcome
  if ($Detail) { $result.detail = ((Remove-Secret $Detail) -replace '\s+', ' ').Trim() }
  if ($result.detail -and $result.detail.Length -gt 300) { $result.detail = $result.detail.Substring(0, 300) }
  Write-Output ([pscustomobject]$result | ConvertTo-Json -Compress -Depth 6)
  exit $Code
}
function Remove-Secret { param([string]$Text) ($Text -replace 'sk-[A-Za-z0-9_\-]{8,}', '<REDACTED>' -replace '(?i)(bearer|token|key)(["'':= ]+)[A-Za-z0-9_\-\.]{16,}', '$1$2<REDACTED>') }
# stdout only is returned (a notice on stderr must not read as a version); stderr lands in $script:exeErr.
function Exe { param([string]$Exe, [string[]]$ArgList, [string]$Dir = $null)
  $errFile = Join-Path $scratchOut 'stderr.txt'
  $out = if ($Dir) { & $Exe -C $Dir @ArgList 2>$errFile } else { & $Exe @ArgList 2>$errFile }
  $script:exeExit = $LASTEXITCODE
  $script:exeErr = Remove-Secret ("$(Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)".Trim())
  return (@($out | ForEach-Object { "$_" }) -join "`n").Trim()
}
function Last-Json { param([string]$Text) $lines = @($Text -split "`n"); for ($i = $lines.Count - 1; $i -ge 0; $i--) { try { return ($lines[$i] | ConvertFrom-Json) } catch {} }; return $null }

# --- 1. versions
$latest = (Exe $NpmExe @('view', '@anthropic-ai/claude-code', 'version')).Trim()
if ($script:exeExit -ne 0 -or $latest -notmatch '^\d+\.\d+\.\d+$') { Finish 'npm-failed' "npm view gave: $latest" 2 }
$cliJson = Get-Content -LiteralPath $CliConfig -Raw -Encoding UTF8 -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
$current = "$($cliJson.version)"
if ($current -notmatch '^\d+\.\d+\.\d+$') { Finish 'no-cli-config' "$CliConfig names no version" 2 }
$result.latest = $latest; $result.current = $current
if ($latest -eq $current) { Finish 'current' }

# --- 2. duplicate guard (cheap, before the install and the probes)
$branchName = "fleet/cli-$latest"
$ghRepo = if ($Repo) { @('--repo', $Repo) } else { @() }
$prs = Exe $GhExe (@('pr', 'list', '--state', 'open', '--head', $branchName, '--json', 'number') + $ghRepo)
if ($script:exeExit -ne 0) { Finish 'gh-failed' "gh pr list failed: $script:exeErr" 2 }
$issues = Exe $GhExe (@('issue', 'list', '--state', 'open', '--search', "cli-canary $latest in:title", '--json', 'number,title') + $ghRepo)
if ($script:exeExit -ne 0) { Finish 'gh-failed' "gh issue list failed: $script:exeErr" 2 }
$dupPr = @(@(try { $prs | ConvertFrom-Json } catch {}) | Where-Object { $_ })
$dupIssue = @(@(try { $issues | ConvertFrom-Json } catch {}) | Where-Object { $_ -and $_.title -match "cli-canary" -and $_.title.Contains($latest) })
if ($dupPr.Count -or $dupIssue.Count) { Finish 'duplicate' "open $(if ($dupPr.Count) { "PR #$($dupPr[0].number)" } else { "issue #$($dupIssue[0].number)" }) already covers $latest" }

# --- 3. the candidate
$candidatePath = $Candidate
if (-not $candidatePath) {
  $install = Exe 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $InstallCli, '-Version', $latest)
  $installJson = Last-Json $install
  if (-not $installJson -or -not $installJson.ok -or -not $installJson.path) { Finish 'install-failed' "install-cli.ps1 -Version $latest : $install $script:exeErr" 2 }
  $candidatePath = "$($installJson.path)"
}
if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { Finish 'install-failed' "candidate $candidatePath does not exist" 2 }

# --- 4. the probes
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('fleet-cli-canary-' + [guid]::NewGuid().ToString('N'))
$tenant = Join-Path $scratch 'repo'      # stands in for the tenant's main checkout (<repo>)
[IO.Directory]::CreateDirectory($tenant) | Out-Null
[IO.File]::WriteAllText("$tenant\notes.txt", "alpha`na``b`nomega`n", $utf8)
[IO.File]::WriteAllText("$tenant\probe.test.js", "require('node:test')('probe', () => {});`n", $utf8)
$null = Exe $GitExe @('init', '--quiet') $tenant
$null = Exe $GitExe @('-c', 'user.email=canary@example.invalid', '-c', 'user.name=canary', 'add', '-A') $tenant
$null = Exe $GitExe @('-c', 'user.email=canary@example.invalid', '-c', 'user.name=canary', 'commit', '--quiet', '--no-gpg-sign', '-m', 'probe') $tenant
$fleetFwd = $FleetHome.Replace('\', '/').TrimEnd('/')
$repoFwd = $tenant.Replace('\', '/')
$probeHome = Join-Path $scratch 'home'   # FLEET_HOME for the hooks
foreach ($d in 'state\sessions', 'state\heartbeats') { [IO.Directory]::CreateDirectory((Join-Path $probeHome $d)) | Out-Null }
$probeHomeFwd = $probeHome.Replace('\', '/')

function Read-Cfg { param([string]$Rel) Get-Content -LiteralPath (Join-Path $FleetHome $Rel) -Raw -Encoding UTF8 | ConvertFrom-Json }
$tiers = @(
  [ordered]@{ tier = 'haiku'; file = 'config\permissions-allowlist.json'; cfg = (Read-Cfg 'config\permissions-allowlist.json') }
  [ordered]@{ tier = 'deepseek'; file = 'config\deepseek.json'; cfg = (Read-Cfg 'config\deepseek.json') }
)
$deepseekPin = if ((Get-Content (Join-Path $FleetHome 'bin\_common.ps1') -Raw -ErrorAction SilentlyContinue) -match "IcDeepseekPin\s*=\s*'([^']+)'") { $Matches[1] } else { 'deepseek-flash' }

function New-ProbeSettings { param($T)
  $s = Get-Content -LiteralPath (Join-Path $FleetHome 'fleet-settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  # The IC's hooks as launch.ps1 writes them (fleet-settings.json unchanged), run from this checkout
  # with FLEET_HOME at the scratch home so the Stop heartbeat and notice reads never touch state/.
  $envBlock = [ordered]@{ FLEET_HOME = $probeHomeFwd; FLEET_NAME = "ic-canary-$($T.tier)"; FLEET_ROLE = 'ic'; FLEET_TENANT = 'canary'; FLEET_PARENT = 'canary'; PONYTAIL_DEFAULT_MODE = 'off'; PONYTAIL_SUBAGENT_MATCHER = '(?!)' }
  if ($T.tier -eq 'haiku') { $envBlock.FLEET_PERMISSIONS = 'allowlist' }
  if ($s.PSObject.Properties['hooks']) { $s.hooks = ((ConvertTo-Json $s.hooks -Depth 10 -Compress).Replace('C:/Users/Cory/fleet/', "$fleetFwd/")) | ConvertFrom-Json }
  if ($T.tier -eq 'deepseek') {
    $envBlock.ANTHROPIC_BASE_URL = "$($T.cfg.baseUrl)"
    $s | Add-Member -NotePropertyName apiKeyHelper -NotePropertyValue "node $fleetFwd/bin/deepseek-key.js" -Force
  } else {
    $tokens = @{ '<fleet>' = $fleetFwd; '<repo>' = $repoFwd; '<defaultBranch>' = 'master'; '<releaseBranch>' = 'main' }
    $res = { param([string]$x) foreach ($k in $tokens.Keys) { $x = $x.Replace($k, $tokens[$k]) }; $x }
    $dirs = @($T.cfg.additionalDirectories | Where-Object { $_ } | ForEach-Object { & $res $(if ($_ -is [string]) { $_ } else { "$($_.dir)" }) })
    $perm = [pscustomobject]@{
      defaultMode = "$($T.cfg.defaultMode)"
      allow = @($T.cfg.allow | ForEach-Object { & $res "$($_.rule)" })
      additionalDirectories = $dirs
      deny = @($T.cfg.deny | Where-Object { $_ } | ForEach-Object { & $res "$($_.rule)" })
    }
    $s | Add-Member -NotePropertyName permissions -NotePropertyValue $perm -Force
  }
  $s | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]$envBlock) -Force
  return $s
}

$prompts = @{
  deepseek = "This is a permission probe. Use the Bash tool to run exactly: ls $fleetFwd/config`nThen use the Read tool on $fleetFwd/config/cycle.json (limit 1 line). Then reply with the single word done."
  haiku = "This is a permission probe. Use the Bash tool to run each of these commands exactly as written, one per call, then use the Read tool on $repoFwd/notes.txt. Reply with the single word done.`n1. grep -n 'a``b' $repoFwd/notes.txt`n2. gh pr view 1 --repo andydarknessb/fleet --json number`n3. node --test $repoFwd/probe.test.js`n4. git -C $repoFwd log --oneline -1"
}
$expect = @{ deepseek = @{ mode = 'auto'; bash = 1; read = 1 }; haiku = @{ mode = 'acceptEdits'; bash = 4; read = 1 } }

function Invoke-Probe { param($T)
  $name = $T.tier
  $open = ("$($T.cfg.verifiedCliVersion)" -eq $current)
  $p = [ordered]@{ tier = $name; open = $open; pass = $false; permissionMode = $null; expectedMode = $expect[$name].mode; denials = @(); bash = 0; read = 0; anthropicMsgId = $false; hooks = 0; hookErrors = 0; bashResults = 0; bashOk = 0; readOk = 0; resultLine = $false; hasDenialsField = $false; model = $null; costUsd = $null; error = $null }
  $dir = Join-Path $scratch "cwd-$name"; [IO.Directory]::CreateDirectory($dir) | Out-Null
  $settingsPath = Join-Path $probeHome "state\sessions\ic-canary-$name.settings.json"   # where allowlist-gate.js looks
  [IO.File]::WriteAllText($settingsPath, ((New-ProbeSettings $T) | ConvertTo-Json -Depth 8), $utf8)
  $promptPath = Join-Path $scratch "$name.prompt.txt"; [IO.File]::WriteAllText($promptPath, $prompts[$name], $utf8)
  $outPath = Join-Path $scratch "$name.out.jsonl"; $errPath = Join-Path $scratch "$name.err.txt"
  $model = if ($name -eq 'deepseek') { $deepseekPin } else { 'haiku' }
  $argString = "-p --model $model --settings `"$settingsPath`" --setting-sources project --strict-mcp-config --no-session-persistence --output-format stream-json --verbose --max-budget-usd 1"
  $saved = $env:FLEET_CLAUDE_CLI
  try {
    $env:FLEET_CLAUDE_CLI = $candidatePath
    $proc = Start-Process -FilePath $candidatePath -ArgumentList $argString -WorkingDirectory $dir -RedirectStandardInput $promptPath -RedirectStandardOutput $outPath -RedirectStandardError $errPath -NoNewWindow -PassThru
    if (-not $proc.WaitForExit($ProbeTimeoutSec * 1000)) { try { & taskkill /T /F /PID $proc.Id 2>$null | Out-Null } catch {}; $p.error = "timed out after ${ProbeTimeoutSec}s" }
  } catch { $p.error = "$($_.Exception.Message)" } finally { $env:FLEET_CLAUDE_CLI = $saved }
  $sawResult = $false; $toolNames = @{}
  foreach ($line in @(Get-Content -LiteralPath $outPath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
    $e = try { $line | ConvertFrom-Json } catch { $null }
    if (-not $e) { continue }
    if ($e.type -eq 'system' -and $e.subtype -eq 'hook_response') { $p.hooks++; if ("$($e.outcome)" -eq 'error') { $p.hookErrors++ } }
    elseif ($e.type -eq 'system' -and $e.subtype -eq 'init') { $p.permissionMode = "$($e.permissionMode)"; if ($e.model) { $p.model = "$($e.model)" } }
    elseif ($e.type -eq 'assistant' -and $e.message) {
      if ("$($e.message.id)" -match '^msg_') { $p.anthropicMsgId = $true }
      foreach ($c in @($e.message.content)) { if ($c.type -eq 'tool_use') { $toolNames["$($c.id)"] = "$($c.name)"; if ($c.name -eq 'Bash') { $p.bash++ } elseif ($c.name -eq 'Read') { $p.read++ } } }
    }
    elseif ($e.type -eq 'user' -and $e.message) {
      foreach ($c in @($e.message.content)) {
        if ($c.type -ne 'tool_result') { continue }
        $tn = $toolNames["$($c.tool_use_id)"]; $ok = -not $c.is_error
        if ($tn -eq 'Bash') { $p.bashResults++; if ($ok) { $p.bashOk++ } } elseif ($tn -eq 'Read' -and $ok) { $p.readOk++ }
      }
    }
    elseif ($e.type -eq 'result') {
      $sawResult = $true; $p.hasDenialsField = [bool]$e.PSObject.Properties['permission_denials']
      $p.denials = @($e.permission_denials | Where-Object { $_ } | ForEach-Object { Remove-Secret ("$($_.tool_name) " + ($_.tool_input | ConvertTo-Json -Compress -Depth 4)) })
      $p.costUsd = $e.total_cost_usd
      if ($e.is_error) { $p.error = Remove-Secret "result is_error: $($e.result)" }
    }
  }
  if (-not $sawResult -and -not $p.error) { $tail = (Get-Content -LiteralPath $errPath -Raw -ErrorAction SilentlyContinue); $p.error = Remove-Secret "no result line; stderr: $("$tail".Trim())" }
  $why = @()
  if ($p.error) { $why += $p.error }
  if ($p.hookErrors) { $why += "$($p.hookErrors) hook(s) errored" }
  if ($sawResult -and -not $p.hasDenialsField) { $why += 'the result line carries no permission_denials field' }
  if ($p.permissionMode -ne $p.expectedMode) { $why += "permissionMode '$($p.permissionMode)', expected '$($p.expectedMode)'" }
  if (@($p.denials).Count) { $why += "$(@($p.denials).Count) permission denial(s)" }
  if ($p.bashResults -lt $expect[$name].bash -or $p.readOk -lt $expect[$name].read) { $why += "got $($p.bashResults) Bash results and $($p.readOk) successful Read results, expected $($expect[$name].bash) and $($expect[$name].read)" }
  if ($name -eq 'deepseek' -and $p.bashOk -lt 1) { $why += 'the out-of-cwd Bash did not return a successful result' }
  if ($name -eq 'deepseek' -and $p.anthropicMsgId) { $why += 'an Anthropic msg_ id appears: DeepSeek did not serve the reply' }
  $p.pass = ($why.Count -eq 0)
  $p.why = $why -join '; '
  return [pscustomobject]$p
}

try { $probes = @($tiers | ForEach-Object { Invoke-Probe $_ }) } finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
$result.probes = $probes

# --- 5. verdict
$openFail = @($probes | Where-Object { $_.open -and -not $_.pass })
$passing = @($probes | Where-Object { $_.pass })
$closedFail = @($probes | Where-Object { -not $_.open -and -not $_.pass })
$report = (($probes | ForEach-Object { "- $($_.tier) ($(if ($_.open) { 'open' } else { 'closed' })): $(if ($_.pass) { 'PASS' } else { "FAIL: $($_.why)" }); permissionMode=$($_.permissionMode); permission_denials=[$((@($_.denials) -join ' | '))]; Bash ok=$($_.bashOk)/$($_.bashResults) Read ok=$($_.readOk); anthropic msg_ id=$($_.anthropicMsgId); cost=`$$($_.costUsd)" }) -join "`n")
$willPr = (-not $openFail.Count) -and $passing.Count
if ($DryRun) { Finish $(if ($willPr) { 'dry-run:would-open-pr' } else { 'dry-run:would-file-issue' }) $null }

if ($willPr) {
  $script:wt = $wt = Join-Path ([IO.Path]::GetTempPath()) ('fleet-cli-pr-' + [guid]::NewGuid().ToString('N'))
  $null = Exe $GitExe @('fetch', '--quiet', $Remote, $Branch) $FleetHome
  if ($script:exeExit -ne 0) { Finish 'worktree-failed' "git fetch $Remote $Branch failed: $script:exeErr" 2 }
  # --detach: no local fleet/cli-<v> branch is left behind to block the next day's run
  $null = Exe $GitExe @('worktree', 'add', '--quiet', '--detach', $wt, "$Remote/$Branch") $FleetHome
  if ($script:exeExit -ne 0) { Finish 'worktree-failed' "git worktree add failed: $script:exeErr" 2 }
  try {
    $cliRel = (Resolve-Path -LiteralPath $CliConfig).Path.Substring((Resolve-Path -LiteralPath $FleetHome).Path.Length).TrimStart('\')
    $edit = { param($rel, $pattern, $with) $f = Join-Path $wt $rel; $t = [IO.File]::ReadAllText($f); $n = [regex]::Replace($t, $pattern, $with); if ($n -eq $t) { throw "no change in $rel" }; [IO.File]::WriteAllText($f, $n, $utf8) }
    try {
      & $edit $cliRel '("version"\s*:\s*")[^"]*(")' "`${1}$latest`${2}"
      foreach ($p in $passing) { $t = $tiers | Where-Object { $_.tier -eq $p.tier }; & $edit $t.file '("verifiedCliVersion"\s*:\s*)(null|"[^"]*")' "`${1}`"$latest`"" }
    } catch { Finish 'edit-failed' "$($_.Exception.Message)" 2 }
    $null = Exe $GitExe @('add', '-A') $wt
    if ($script:exeExit -ne 0) { Finish 'worktree-failed' "git add failed: $script:exeErr" 2 }
    $null = Exe $GitExe @('-c', 'user.email=fleet@example.invalid', '-c', 'user.name=fleet cli-canary', 'commit', '--quiet', '--no-gpg-sign', '-m', "cli: move the fleet to Claude Code $latest (canary probes passed)") $wt
    if ($script:exeExit -ne 0) { Finish 'worktree-failed' "git commit failed: $script:exeErr" 2 }
    $null = Exe $GitExe @('push', '--quiet', $Remote, "HEAD:refs/heads/$branchName") $wt
    if ($script:exeExit -ne 0) { Finish 'push-failed' "git push $branchName failed: $script:exeErr" 2 }
    $body = "Fleet #337 canary: Claude Code $latest passed every open tier's probe under ``claude -p`` (candidate installed side by side, FLEET_CLAUDE_CLI set to it). Merging bumps config/cli.json from $current and verifiedCliVersion for: $((@($passing | ForEach-Object { $_.tier })) -join ', '). The next deploy moves the CLI (#336). This body is the attest.`n`nProbe output:`n$report"
    if ($closedFail.Count) { $body += "`n`nA closed tier failed and stays closed: $((@($closedFail | ForEach-Object { $_.tier })) -join ', '); an issue carries the detail." }
    $bodyPath = Join-Path $scratchOut 'pr-body.txt'; [IO.File]::WriteAllText($bodyPath, $body, $utf8)
    $prOut = Exe $GhExe (@('pr', 'create', '--base', $Branch, '--head', $branchName, '--title', "cli: Claude Code $latest passed the canary", '--body-file', $bodyPath) + $ghRepo)
    if ($script:exeExit -ne 0) { Finish 'pr-failed' "gh pr create failed: $script:exeErr $prOut" 2 }
    $result.pr = ($prOut -split "`n")[-1]
  } catch { Finish 'pr-failed' "$($_.Exception.Message)" 2 }
}
if ($openFail.Count -or $closedFail.Count) {
  $failed = @($openFail + $closedFail)
  $title = "cli-canary: Claude Code $latest failed the probe for $((@($failed | ForEach-Object { $_.tier })) -join ', ')"
  $lead = if ($openFail.Count) { "An open tier failed, so nothing moves: no PR, and the fleet stays on $current." } else { "Every open tier passed (PR $($result.pr)); the closed tier below failed and stays closed." }
  $issueBody = "Fleet #337 canary: Claude Code $latest (fleet is on $current).`n$lead`n`nProbe output:`n$report"
  $bodyPath = Join-Path $scratchOut 'issue-body.txt'; [IO.File]::WriteAllText($bodyPath, $issueBody, $utf8)
  $issueOut = Exe $GhExe (@('issue', 'create', '--title', $title, '--body-file', $bodyPath) + $ghRepo)
  if ($script:exeExit -ne 0) { Finish 'issue-failed' "gh issue create failed: $script:exeErr $issueOut" 2 }
  $result.issue = ($issueOut -split "`n")[-1]
}
Finish $(if ($willPr) { 'pr-opened' } else { 'issue-filed' })
