<#
.SYNOPSIS  Fleet #337 (ADR 0016 Amendment 9): the daily Claude Code CLI canary.
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
                 command list; passes when allowlist-gate refused the backtick grep (a PreToolUse deny, #335),
                 every other command succeeded, and no denial came from the CLI itself.
  4. A tier is OPEN when its verifiedCliVersion equals cli.json's version. Every open tier
     passes -> a PR on a temp worktree off origin/master, branch fleet/cli-<v>, bumping
     cli.json and every passing tier's verifiedCliVersion (a closed tier that passes reopens).
     Any open tier fails -> nothing moves; an issue carries the probe output. A closed tier
     that fails stays closed and gets the issue too.
  No newer release (latest equals cli.json): the closed tiers are re-probed on that version; a pass
  opens a PR on fleet/cli-<v>-<tier> bumping only that tier, a fail files one issue per tier.
  -DryRun probes and prints; no PR, issue, worktree or commit. Never merges, never touches
  the live checkout's files or state/. Prints one JSON line {outcome, ...}; exit 0 whatever the
  verdict, 2 when the candidate cannot be installed.
  Probe settings are the smallest equivalent of launch.ps1's composition (launch.ps1 needs a
  roster, tenant and manifest for even a -DryRun): fleet-settings.json with its hooks, plus the
  tier's profile and the IC env; the tool-contract denies and repoDeny rules only deny and are omitted.
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
# No newer release: the closed tiers are re-probed on the current CLI (reprobe mode).
$reprobe = ($latest -eq $current)
$target = $latest

function Read-Cfg { param([string]$Rel) Get-Content -LiteralPath (Join-Path $FleetHome $Rel) -Raw -Encoding UTF8 | ConvertFrom-Json }
$tiers = @(
  [ordered]@{ tier = 'haiku'; file = 'config\permissions-allowlist.json'; cfg = (Read-Cfg 'config\permissions-allowlist.json') }
  [ordered]@{ tier = 'deepseek'; file = 'config\deepseek.json'; cfg = (Read-Cfg 'config\deepseek.json') }
)
foreach ($t in $tiers) { $t.open = ("$($t.cfg.verifiedCliVersion)" -eq $current) }
$branchName = "fleet/cli-$latest"
function Get-TierBranch { param([string]$Tier) "fleet/cli-$current-$Tier" }

# --- 2. duplicate guard (cheap, before the install and the probes)
$ghRepo = if ($Repo) { @('--repo', $Repo) } else { @() }
function Get-OpenPrs { param([string]$Head)
  $o = Exe $GhExe (@('pr', 'list', '--state', 'open', '--head', $Head, '--json', 'number') + $ghRepo)
  if ($script:exeExit -ne 0) { Finish 'gh-failed' "gh pr list failed: $script:exeErr" 2 }
  @(@(try { $o | ConvertFrom-Json } catch {}) | Where-Object { $_ })
}
$issues = Exe $GhExe (@('issue', 'list', '--state', 'open', '--search', "cli-canary $target in:title", '--json', 'number,title') + $ghRepo)
if ($script:exeExit -ne 0) { Finish 'gh-failed' "gh issue list failed: $script:exeErr" 2 }
$openIssues = @(@(try { $issues | ConvertFrom-Json } catch {}) | Where-Object { $_ -and $_.title -match 'cli-canary' -and $_.title.Contains($target) })
if ($reprobe) {
  # one PR branch and one issue per closed tier and version
  $closed = @($tiers | Where-Object { -not $_.open })
  if (-not $closed.Count) { Finish 'current' }
  $probeTiers = @($closed | Where-Object {
    $t = $_
    -not (Get-OpenPrs (Get-TierBranch $t.tier)).Count -and -not @($openIssues | Where-Object { $_.title.Contains($t.tier) }).Count
  })
  if (-not $probeTiers.Count) { Finish 'duplicate' "open PRs or issues already cover the closed tier(s) on $current" }
} else {
  $dupPr = Get-OpenPrs $branchName
  if ($dupPr.Count -or $openIssues.Count) { Finish 'duplicate' "open $(if ($dupPr.Count) { "PR #$($dupPr[0].number)" } else { "issue #$($openIssues[0].number)" }) already covers $latest" }
  $probeTiers = $tiers
}

# --- 3. the candidate
$candidatePath = $Candidate
if (-not $candidatePath) {
  $install = Exe 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $InstallCli, '-Version', $target)
  $installJson = Last-Json $install
  if (-not $installJson -or -not $installJson.ok -or -not $installJson.path) { Finish 'install-failed' "install-cli.ps1 -Version $target : $install $script:exeErr" 2 }
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
  $open = [bool]$T.open
  $p = [ordered]@{ tier = $name; open = $open; pass = $false; permissionMode = $null; expectedMode = $expect[$name].mode; denials = @(); bash = 0; read = 0; anthropicMsgId = $false; hooks = 0; hookErrors = 0; preBash = 0; preRead = 0; stopHooks = 0; hasIsError = $false; gateRefused = 0; cliDenials = 0; denyHooks = 0; backtickRefused = $false; backtickRan = $false; otherBashFail = 0; bashResults = 0; bashOk = 0; readOk = 0; resultLine = $false; hasDenialsField = $false; model = $null; costUsd = $null; error = $null }
  $dir = Join-Path $scratch "cwd-$name"; [IO.Directory]::CreateDirectory($dir) | Out-Null
  $settingsPath = Join-Path $probeHome "state\sessions\ic-canary-$name.settings.json"   # where allowlist-gate.js looks
  [IO.File]::WriteAllText($settingsPath, ((New-ProbeSettings $T) | ConvertTo-Json -Depth 8), $utf8)
  $promptPath = Join-Path $scratch "$name.prompt.txt"; [IO.File]::WriteAllText($promptPath, $prompts[$name], $utf8)
  $outPath = Join-Path $scratch "$name.out.jsonl"; $errPath = Join-Path $scratch "$name.err.txt"
  $model = if ($name -eq 'deepseek') { $deepseekPin } else { 'haiku' }
  $argString = "-p --model $model --settings `"$settingsPath`" --setting-sources project --strict-mcp-config --no-session-persistence --output-format stream-json --verbose --include-hook-events --max-budget-usd 1"
  $saved = $env:FLEET_CLAUDE_CLI
  try {
    $env:FLEET_CLAUDE_CLI = $candidatePath
    $proc = Start-Process -FilePath $candidatePath -ArgumentList $argString -WorkingDirectory $dir -RedirectStandardInput $promptPath -RedirectStandardOutput $outPath -RedirectStandardError $errPath -NoNewWindow -PassThru
    if (-not $proc.WaitForExit($ProbeTimeoutSec * 1000)) { try { & taskkill /T /F /PID $proc.Id 2>$null | Out-Null } catch {}; $p.error = "timed out after ${ProbeTimeoutSec}s" }
  } catch { $p.error = "$($_.Exception.Message)" } finally { $env:FLEET_CLAUDE_CLI = $saved }
  $sawResult = $false; $toolNames = @{}; $toolCmds = @{}; $hookRefused = @{}; $denialIds = @()
  foreach ($line in @(Get-Content -LiteralPath $outPath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
    $e = try { $line | ConvertFrom-Json } catch { $null }
    if (-not $e) { continue }
    if ($e.type -eq 'system' -and $e.subtype -eq 'hook_response') { $p.hooks++; if ("$($e.outcome)" -eq 'error') { $p.hookErrors++ }; if ($e.hook_event -eq 'PreToolUse' -and "$($e.output)" -match '"permissionDecision"\s*:\s*"deny"') { $p.denyHooks++ }; switch -Regex ("$($e.hook_name)") { '^PreToolUse:Bash' { $p.preBash++ } '^PreToolUse:Read' { $p.preRead++ } '^Stop' { $p.stopHooks++ } } }
    elseif ($e.type -eq 'system' -and $e.subtype -eq 'init') { $p.permissionMode = "$($e.permissionMode)"; if ($e.model) { $p.model = "$($e.model)" } }
    elseif ($e.type -eq 'assistant' -and $e.message) {
      if ("$($e.message.id)" -match '^msg_') { $p.anthropicMsgId = $true }
      foreach ($c in @($e.message.content)) { if ($c.type -eq 'tool_use') { $toolNames["$($c.id)"] = "$($c.name)"; $toolCmds["$($c.id)"] = "$($c.input.command)"; if ($c.name -eq 'Bash') { $p.bash++ } elseif ($c.name -eq 'Read') { $p.read++ } } }
    }
    elseif ($e.type -eq 'user' -and $e.message) {
      foreach ($c in @($e.message.content)) {
        if ($c.type -ne 'tool_result') { continue }
        $tn = $toolNames["$($c.tool_use_id)"]; $ok = -not $c.is_error
        $isBacktick = "$($toolCmds["$($c.tool_use_id)"])".Contains('`')
        # the gate's refusal comes back as that call's own tool result carrying its reason text; another hook's refusal does not count
        if ($tn -eq 'Bash' -and "$($c.content)" -match 'the allowlist profile refuses a backtick') { $hookRefused["$($c.tool_use_id)"] = $true }
        if ($tn -eq 'Bash' -and $isBacktick) { if ($hookRefused["$($c.tool_use_id)"]) { $p.backtickRefused = $true } elseif ($ok) { $p.backtickRan = $true } }
        elseif ($tn -eq 'Bash' -and -not $ok) { $p.otherBashFail++ }
        if ($tn -eq 'Bash') { $p.bashResults++; if ($ok) { $p.bashOk++ } } elseif ($tn -eq 'Read' -and $ok) { $p.readOk++ }
      }
    }
    elseif ($e.type -eq 'result') {
      $sawResult = $true; $p.hasIsError = [bool]$e.PSObject.Properties['is_error']; $p.hasDenialsField = [bool]$e.PSObject.Properties['permission_denials']
      $denialIds = @($e.permission_denials | Where-Object { $_ } | ForEach-Object { "$($_.tool_use_id)" })
      foreach ($d in $denialIds) { if ($hookRefused[$d]) { $p.gateRefused++ } else { $p.cliDenials++ } }
      $p.denials = @($e.permission_denials | Where-Object { $_ } | ForEach-Object { Remove-Secret ("$($_.tool_name) " + ($_.tool_input | ConvertTo-Json -Compress -Depth 4)) })
      $p.costUsd = $e.total_cost_usd
      if ($e.is_error) { $p.error = Remove-Secret "result is_error: $($e.result)" }
    }
  }
  if (-not $sawResult -and -not $p.error) { $tail = (Get-Content -LiteralPath $errPath -Raw -ErrorAction SilentlyContinue); $p.error = Remove-Secret "no result line; stderr: $("$tail".Trim())" }
  $why = @()
  if ($p.error) { $why += $p.error }
  if ($sawResult -and -not $p.hasIsError) { $why += 'the result line carries no is_error field' }
  if ($p.preBash -lt $p.bash -or $p.preRead -lt $p.read -or $p.stopHooks -lt 1) { $why += "hook evidence missing: PreToolUse responses Bash $($p.preBash)/$($p.bash), Read $($p.preRead)/$($p.read), Stop $($p.stopHooks)" }
  if ($p.hookErrors) { $why += "$($p.hookErrors) hook(s) errored" }
  if ($sawResult -and -not $p.hasDenialsField) { $why += 'the result line carries no permission_denials field' }
  if ($p.permissionMode -ne $p.expectedMode) { $why += "permissionMode '$($p.permissionMode)', expected '$($p.expectedMode)'" }
  if ($name -eq 'deepseek' -and @($p.denials).Count) { $why += "$(@($p.denials).Count) permission denial(s)" }
  if ($name -eq 'haiku') {
    # #335: the gate refuses the backtick grep (a PreToolUse deny); any other denial is the CLI's own approval request
    if ($p.cliDenials) { $why += "$($p.cliDenials) permission denial(s) raised by the CLI, not by a hook" }
    if ($p.backtickRan) { $why += 'the backtick command ran: allowlist-gate did not refuse it' }
    elseif (-not $p.backtickRefused) { $why += 'the backtick command was not refused by allowlist-gate (its reason text is missing from that call tool result)' }
    if ($p.otherBashFail) { $why += "$($p.otherBashFail) other Bash command(s) did not succeed" }
  }
  if ($p.bashResults -lt $expect[$name].bash -or $p.readOk -lt $expect[$name].read) { $why += "got $($p.bashResults) Bash results and $($p.readOk) successful Read results, expected $($expect[$name].bash) and $($expect[$name].read)" }
  if ($name -eq 'deepseek' -and $p.bashOk -lt 1) { $why += 'the out-of-cwd Bash did not return a successful result' }
  if ($name -eq 'deepseek' -and $p.anthropicMsgId) { $why += 'an Anthropic msg_ id appears: DeepSeek did not serve the reply' }
  $p.pass = ($why.Count -eq 0)
  $p.why = $why -join '; '
  return [pscustomobject]$p
}

try { $probes = @($probeTiers | ForEach-Object { Invoke-Probe $_ }) } finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
$result.probes = $probes

# --- 5. verdict
$report = (($probes | ForEach-Object { "- $($_.tier) ($(if ($_.open) { 'open' } else { 'closed' })): $(if ($_.pass) { 'PASS' } else { "FAIL: $($_.why)" }); permissionMode=$($_.permissionMode); permission_denials=[$((@($_.denials) -join ' | '))] (gate-refused $($_.gateRefused), CLI-raised $($_.cliDenials)); Bash ok=$($_.bashOk)/$($_.bashResults) Read ok=$($_.readOk); hooks: PreToolUse Bash $($_.preBash) Read $($_.preRead), Stop $($_.stopHooks); anthropic msg_ id=$($_.anthropicMsgId); cost=`$$($_.costUsd)" }) -join "`n")

# Opens PR $Branch from a detached worktree off the fetched Remote/Branch, applying $Edits ({rel; pattern; with}).
function Open-Pr { param([string]$PrBranch, $Edits, [string]$Title, [string]$Body)
  $wt = Join-Path ([IO.Path]::GetTempPath()) ('fleet-cli-pr-' + [guid]::NewGuid().ToString('N'))
  $null = Exe $GitExe @('fetch', '--quiet', $Remote, $Branch) $FleetHome
  if ($script:exeExit -ne 0) { Finish 'worktree-failed' "git fetch $Remote $Branch failed: $script:exeErr" 2 }
  $script:wt = $wt
  # --detach: no local fleet/cli-* branch is left behind to block the next day's run
  $null = Exe $GitExe @('worktree', 'add', '--quiet', '--detach', $wt, "$Remote/$Branch") $FleetHome
  if ($script:exeExit -ne 0) { Finish 'worktree-failed' "git worktree add failed: $script:exeErr" 2 }
  try {
    foreach ($ed in $Edits) {
      $f = Join-Path $wt $ed.rel; $t = [IO.File]::ReadAllText($f); $n = [regex]::Replace($t, $ed.pattern, $ed.with)
      if ($n -eq $t) { throw "no change in $($ed.rel)" }
      [IO.File]::WriteAllText($f, $n, $utf8)
    }
  } catch { Finish 'edit-failed' "$($_.Exception.Message)" 2 }
  $null = Exe $GitExe @('add', '-A') $wt
  if ($script:exeExit -ne 0) { Finish 'worktree-failed' "git add failed: $script:exeErr" 2 }
  $null = Exe $GitExe @('-c', 'user.email=fleet@example.invalid', '-c', 'user.name=fleet cli-canary', 'commit', '--quiet', '--no-gpg-sign', '-m', $Title) $wt
  if ($script:exeExit -ne 0) { Finish 'worktree-failed' "git commit failed: $script:exeErr" 2 }
  # a stale remote branch (an earlier run that failed after its push) would reject this push; the guard above saw no open PR for it
  if (Exe $GitExe @('ls-remote', '--heads', $Remote, "refs/heads/$PrBranch") $FleetHome) { $null = Exe $GitExe @('push', '--quiet', $Remote, '--delete', $PrBranch) $FleetHome }
  $null = Exe $GitExe @('push', '--quiet', $Remote, "HEAD:refs/heads/$PrBranch") $wt
  if ($script:exeExit -ne 0) { Finish 'push-failed' "git push $PrBranch failed: $script:exeErr" 2 }
  $bodyPath = Join-Path $scratchOut 'pr-body.txt'; [IO.File]::WriteAllText($bodyPath, $Body, $utf8)
  $prOut = Exe $GhExe (@('pr', 'create', '--base', $Branch, '--head', $PrBranch, '--title', $Title, '--body-file', $bodyPath) + $ghRepo)
  if ($script:exeExit -ne 0) { $ghErr = "$script:exeErr $prOut"; $null = Exe $GitExe @('push', '--quiet', $Remote, '--delete', $PrBranch) $FleetHome; Finish 'pr-failed' "gh pr create failed: $ghErr" 2 }
  & $GitExe -C $FleetHome worktree remove --force $wt 2>$null | Out-Null; $script:wt = $null
  return ($prOut -split "`n")[-1]
}
function Open-Issue { param([string]$Title, [string]$Body)
  $bodyPath = Join-Path $scratchOut 'issue-body.txt'; [IO.File]::WriteAllText($bodyPath, $Body, $utf8)
  $out = Exe $GhExe (@('issue', 'create', '--title', $Title, '--body-file', $bodyPath) + $ghRepo)
  if ($script:exeExit -ne 0) { Finish 'issue-failed' "gh issue create failed: $script:exeErr $out" 2 }
  return ($out -split "`n")[-1]
}
function Bump-Tier { param($Tier) @{ rel = $Tier.file; pattern = '("verifiedCliVersion"\s*:\s*)(null|"[^"]*")'; with = "`${1}`"$target`"" } }

if ($reprobe) {
  # --- closed tiers on the current CLI: a PR per passing tier, an issue per failing tier
  $prs = @(); $iss = @()
  if ($DryRun) { Finish 'dry-run:reprobe' $null }
  foreach ($p in $probes) {
    $t = $tiers | Where-Object { $_.tier -eq $p.tier }
    $oneReport = ($report -split "`n" | Where-Object { $_ -like "- $($p.tier) *" }) -join "`n"
    if ($p.pass) {
      $body = "Fleet #337 canary (closed-tier reprobe): the $($p.tier) tier passed its probe under ``claude -p`` on Claude Code $target, the version config/cli.json already names. Merging bumps only $($t.file) verifiedCliVersion to $target. This body is the attest.`n`nProbe output:`n$oneReport"
      $prs += Open-Pr (Get-TierBranch $p.tier) @(Bump-Tier $t) "cli: $($p.tier) tier verified on Claude Code $target (canary probe passed)" $body
    } else {
      $iss += Open-Issue "cli-canary: Claude Code $target failed the probe for $($p.tier)" "Fleet #337 canary (closed-tier reprobe): the $($p.tier) tier stays closed on Claude Code $target.`n`nProbe output:`n$oneReport"
    }
  }
  $result.pr = $prs -join ','; $result.issue = $iss -join ','
  Finish ("reprobe:" + ((@($(if ($prs.Count) { 'pr-opened' }), $(if ($iss.Count) { 'issue-filed' })) | Where-Object { $_ }) -join ','))
}

$openFail = @($probes | Where-Object { $_.open -and -not $_.pass })
$passing = @($probes | Where-Object { $_.pass })
$closedFail = @($probes | Where-Object { -not $_.open -and -not $_.pass })
$willPr = (-not $openFail.Count) -and $passing.Count
if ($DryRun) { Finish $(if ($willPr) { 'dry-run:would-open-pr' } else { 'dry-run:would-file-issue' }) $null }

if ($willPr) {
  $edits = @(@{ rel = ((Resolve-Path -LiteralPath $CliConfig).Path.Substring((Resolve-Path -LiteralPath $FleetHome).Path.Length).TrimStart('\')); pattern = '("version"\s*:\s*")[^"]*(")'; with = "`${1}$latest`${2}" })
  foreach ($p in $passing) { $edits += Bump-Tier ($tiers | Where-Object { $_.tier -eq $p.tier }) }
  $body = "Fleet #337 canary: Claude Code $latest passed every open tier's probe under ``claude -p`` (candidate installed side by side, FLEET_CLAUDE_CLI set to it). Merging bumps config/cli.json from $current and verifiedCliVersion for: $((@($passing | ForEach-Object { $_.tier })) -join ', '). The next deploy moves the CLI (#336). This body is the attest.`n`nProbe output:`n$report"
  if ($closedFail.Count) { $body += "`n`nA closed tier failed and stays closed: $((@($closedFail | ForEach-Object { $_.tier })) -join ', '); an issue carries the detail." }
  $result.pr = Open-Pr $branchName $edits "cli: move the fleet to Claude Code $latest (canary probes passed)" $body
}
if ($openFail.Count -or $closedFail.Count) {
  $failed = @($openFail + $closedFail)
  $lead = if ($openFail.Count) { "An open tier failed, so nothing moves: no PR, and the fleet stays on $current." } else { "Every open tier passed (PR $($result.pr)); the closed tier below failed and stays closed." }
  $result.issue = Open-Issue "cli-canary: Claude Code $latest failed the probe for $((@($failed | ForEach-Object { $_.tier })) -join ', ')" "Fleet #337 canary: Claude Code $latest (fleet is on $current).`n$lead`n`nProbe output:`n$report"
}
Finish $(if ($willPr) { 'pr-opened' } else { 'issue-filed' })
