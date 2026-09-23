# fleet #104: Claude Code 2.1.281 refuses `claude --bg` in an untrusted workspace and
# creates no session. launch.ps1 now checks ~/.claude.json trust (inherited from an
# ancestor, either slash, any case) before the assignment worktree and branch exist,
# deletes both when a launch produces no session, and puts the CLI's own output into the
# invalidation reason. Uses a real git repo for the tenant, manifests reserved through the
# real assignment.js, a mock `gh` for the issue read and a mock `claude` whose --bg either
# records a session or prints the refusal.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-launch-trust-test-" + [guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
$oldProfile = $env:USERPROFILE

function Run-Launch {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $testRoot
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\bin\launch.ps1" @Arguments 2>&1 | Out-String }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap; Pop-Location }
  $script:lastOut = $out
  try { return ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { return $null }
}
function Invoke-Git {
  param([string[]]$Arguments)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $o = & git.exe -C "$testRoot\repo" @Arguments 2>&1 | Out-String; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
  if ($code -ne 0) { throw "git $($Arguments -join ' ') failed: $o" }
  return $o.Trim()
}
# Reserve a manifest for issue N through the planner, exactly as the project lead does.
function Reserve-Manifest {
  param([int]$Issue, [string]$Sha)
  $fixture = "$testRoot\issues-$Issue.json"
  # Each issue names its own component, or the planner refuses the second as a reservation conflict.
  Write-Utf8 $fixture ('[{"number":' + $Issue + ',"title":"Trust fixture","url":"https://github.com/owner/repo/issues/' + $Issue + '","body":' + ("Change ``src/fixture-$Issue.js``." | ConvertTo-Json) + ',"createdAt":"2026-09-01T00:00:00.000Z","state":"OPEN","labels":["ready-for-agent"],"assignees":[]}]')
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & node "$testRoot\bin\assignment.js" assign --root $testRoot --tenant test --tenant-config "$testRoot\tenants\test.json" --fixture $fixture --base-sha $Sha --parent pl-test --model sonnet 2>&1 | Out-String; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $eap }
  $r = $null; try { $r = ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch {}
  if ($code -ne 0 -or -not $r -or -not $r.manifestPath) { throw "assign for issue $Issue failed: $out" }
  return $r.manifestPath
}
function Get-Manifest { param([string]$Path) (Get-Content $Path -Raw) | ConvertFrom-Json }
function Set-Trust { param($Projects) if ($null -eq $Projects) { Remove-Item "$testRoot\profile\.claude.json" -ErrorAction SilentlyContinue; return }; Write-Utf8 "$testRoot\profile\.claude.json" (@{ projects = $Projects } | ConvertTo-Json -Depth 4) }
# The branch tip sha, or $null when the branch does not exist.
function Test-Branch { param([string]$Name) $o = & git.exe -C "$testRoot\repo" rev-parse --verify --quiet "refs/heads/$Name" 2>$null | Out-String; if ($LASTEXITCODE -eq 0 -and $o.Trim()) { return $o.Trim() }; return $null }
function Set-MockSession { param([string]$Name) Write-Utf8 "$testRoot\mock-agents.json" '[]'; Write-Utf8 "$testRoot\mock-agents-after-launch.json" ('[{"id":"job-' + $Name + '","name":"' + $Name + '","state":"working","status":"idle","pid":21,"sessionId":"sess-' + $Name + '","startedAt":1756000000000}]') }

try {
  foreach ($dir in 'bin','hooks','agents','tenants','config','state','state/sessions','state/notices','state/work','state/events','state/flags','state/manifests','mock-bin','profile','profile/.claude/jobs','repo') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  foreach ($f in '_common.ps1','launch.ps1','work-state.js','assignment.js','assignment-parity.js','exclusions.js','notify.js') { [IO.File]::Copy("$sourceRoot\bin\$f", "$testRoot\bin\$f") }
  [IO.File]::Copy("$sourceRoot\hooks\session-start.ps1", "$testRoot\hooks\session-start.ps1")
  [IO.File]::Copy("$sourceRoot\config\cycle.json", "$testRoot\config\cycle.json")
  Write-Utf8 "$testRoot\agents\ic.md" "---`nname: ic`nmodel: sonnet`neffort: low`n---`nRole body for ic."
  Write-Utf8 "$testRoot\fleet-settings.json" '{"crossSessionInbound":"accept","permissions":{"defaultMode":"auto"}}'
  Write-Utf8 "$testRoot\roster.json" '{"cap":6,"sessions":[]}'
  Write-Utf8 "$testRoot\state\roster.json" '{"sessions":[]}'
  $repoPath = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","readyLabel":"ready-for-agent","defaultBranch":"integration","branchPrefix":"fleet/","maxIcs":2,"repo":' + ($repoPath | ConvertTo-Json) + '}')

  # A real tenant repo whose origin is itself, so `fetch origin integration` resolves.
  Invoke-Git @('init', '-q', '-b', 'integration')
  Invoke-Git @('config', 'user.email', 'fleet-test@example.invalid')
  Invoke-Git @('config', 'user.name', 'fleet test')
  Write-Utf8 "$repoPath\README.md" 'fixture'
  Invoke-Git @('add', 'README.md')
  Invoke-Git @('commit', '-q', '-m', 'base')
  $baseSha = Invoke-Git @('rev-parse', 'HEAD')
  Invoke-Git @('remote', 'add', 'origin', $repoPath)
  Invoke-Git @('fetch', '-q', 'origin', 'integration')

  # The issue read must return the body the planner hashed for that issue number.
  Write-Utf8 "$testRoot\mock-bin\mock-gh.js" ("'use strict';`nconst n = process.argv.find((a) => /^\d+$/.test(a)) || '0';`nprocess.stdout.write(JSON.stringify({ state: 'OPEN', body: 'Change ``src/fixture-' + n + '.js``.' }));`n")
  Write-Utf8 "$testRoot\mock-bin\gh.cmd" ("@echo off`r`nnode `"%~dp0mock-gh.js`" %*`r`nexit /b %errorlevel%`r`n")

  # The mock CLI: `agents` lists mock-agents.json; `--bg` records a session only when
  # MOCK_SESSION=1, otherwise it prints the 2.1.281 refusal and creates nothing.
  Write-Utf8 "$testRoot\mock-bin\claude.cmd" ('@echo off' + "`r`n" +
    'if "%1"=="agents" type "' + $testRoot + '\mock-agents.json"' + "`r`n" +
    'if "%1"=="--bg" if "%MOCK_SESSION%"=="1" copy /y "' + $testRoot + '\mock-agents-after-launch.json" "' + $testRoot + '\mock-agents.json" >nul' + "`r`n" +
    'if "%1"=="--bg" if not "%MOCK_SESSION%"=="1" echo Workspace not trusted. Run claude in %CD% once and accept the trust prompt, then retry.' + "`r`n" +
    'exit /b 0' + "`r`n")
  $env:PATH = "$testRoot\mock-bin;$oldPath"
  $env:USERPROFILE = "$testRoot\profile"
  $env:MOCK_SESSION = '0'

  # Case 1: no ~/.claude.json at all: refused before any worktree or branch exists, and
  # the reservation is released with the trust reason.
  Set-MockSession 'ic-7'
  $m = Reserve-Manifest 7 $baseSha; $branch7 = (Get-Manifest $m).branch
  $r1 = Run-Launch @('-Manifest', $m, '-WorkRecordId', 'test:issue-7')
  Assert-True ($lastExit -eq 7 -and $r1.launched -eq $false -and "$($r1.reason)" -match 'not trusted' -and "$($r1.reason)" -match [regex]::Escape($repoPath)) "an untrusted tenant must be refused naming the path: $lastOut"
  Assert-True (-not (Test-Path "$repoPath\.claude\worktrees\ic-7-assignment")) 'a refused launch must create no worktree'
  Assert-True (-not (Test-Branch $branch7)) 'a refused launch must create no branch'
  Assert-True ($r1.reservationReleased -eq $true -and (Test-Path "$m.invalidated.json") -and ((Get-Content "$m.invalidated.json" -Raw) -match 'launch refused: workspace not trusted')) "the manifest must be invalidated with the trust reason: $lastOut"

  # Case 2: trust on an unrelated path does not count, nor does a stale false flag on the repo.
  Set-Trust @{ 'C:\somewhere\else' = @{ hasTrustDialogAccepted = $true }; ($repoPath.Replace('\', '/')) = @{ hasTrustDialogAccepted = $false } }
  $m = Reserve-Manifest 7 $baseSha
  $r2 = Run-Launch @('-Manifest', $m, '-WorkRecordId', 'test:issue-7')
  Assert-True ($lastExit -eq 7 -and "$($r2.reason)" -match 'not trusted' -and $r2.reservationReleased -eq $true) "trust elsewhere must not admit the tenant: $lastOut"

  # Case 3: trusted through an ancestor written with backslashes in another case; the CLI
  # then refuses (no session): exit 5, worktree AND branch gone, CLI text in the reason.
  Set-Trust @{ ($testRoot.ToUpperInvariant()) = @{ hasTrustDialogAccepted = $true } }
  $m = Reserve-Manifest 7 $baseSha
  $r3 = Run-Launch @('-Manifest', $m, '-WorkRecordId', 'test:issue-7')
  Assert-True ($lastExit -eq 5 -and $r3.launched -eq $false -and "$($r3.reason)" -match 'did not produce a session') "a trusted tenant must reach the CLI and report its no-session failure: $lastOut"
  Assert-True (-not (Test-Path "$repoPath\.claude\worktrees\ic-7-assignment")) 'a failed launch must remove the assignment worktree'
  Assert-True (-not (Test-Branch $branch7)) 'a failed launch must delete the orphan assignment branch'
  Assert-True ($r3.reservationReleased -eq $true -and ((Get-Content "$m.invalidated.json" -Raw) -match 'produced no session \(Workspace not trusted')) "the CLI's own output must reach the invalidation reason: $(Get-Content "$m.invalidated.json" -Raw)"

  # Case 4: trusted through a forward-slash ancestor and the CLI produces a session:
  # launched, and the worktree and branch stay at the base.
  Set-Trust @{ ($testRoot.Replace('\', '/')) = @{ hasTrustDialogAccepted = $true } }
  Set-MockSession 'ic-8'
  $m = Reserve-Manifest 8 $baseSha; $branch8 = (Get-Manifest $m).branch
  $env:MOCK_SESSION = '1'
  $r4 = Run-Launch @('-Manifest', $m, '-WorkRecordId', 'test:issue-8')
  Assert-True ($lastExit -eq 0 -and $r4.launched -eq $true) "a trusted tenant must launch: $lastOut"
  Assert-True (Test-Path "$repoPath\.claude\worktrees\ic-8-assignment") 'a launched assignment keeps its worktree'
  Assert-True ((Test-Branch $branch8) -eq $baseSha) 'a launched assignment keeps its branch at the base'

  # Case 5: a pre-existing branch that gained a commit is never deleted by the cleanup.
  Set-MockSession 'ic-9'
  $env:MOCK_SESSION = '0'
  $m = Reserve-Manifest 9 $baseSha; $branch9 = (Get-Manifest $m).branch
  # One commit past the base, built with plumbing so no second worktree is involved.
  $tree = Invoke-Git @('rev-parse', 'HEAD^{tree}')
  $aheadCommit = Invoke-Git @('commit-tree', $tree, '-p', $baseSha, '-m', 'work')
  Invoke-Git @('branch', $branch9, $aheadCommit)
  $ahead = Test-Branch $branch9
  Assert-True ($ahead -and $ahead -ne $baseSha) 'fixture: the branch is ahead of the base'
  $r5 = Run-Launch @('-Manifest', $m, '-WorkRecordId', 'test:issue-9')
  Assert-True ($lastExit -ne 0 -and (-not $r5 -or $r5.launched -ne $true)) "a launch onto an existing branch must fail: $lastOut"
  Assert-True ((Test-Branch $branch9) -eq $ahead) 'the cleanup must never delete a branch with commits'
  Assert-True (-not (Test-Path "$repoPath\.claude\worktrees\ic-9-assignment")) 'the failed worktree add leaves no worktree'

  # Case 6: the rollback flag skips the trust check.
  Set-Trust $null
  Write-Utf8 "$testRoot\state\flags\launch-trust-check-off" 'rollback'
  Set-MockSession 'ic-10'
  $m = Reserve-Manifest 10 $baseSha
  $env:MOCK_SESSION = '1'
  $r6 = Run-Launch @('-Manifest', $m, '-WorkRecordId', 'test:issue-10')
  Assert-True ($lastExit -eq 0 -and $r6.launched -eq $true) "the flag must skip the trust check: $lastOut"

  Write-Output 'launch trust tests passed'
} finally {
  $env:PATH = $oldPath
  $env:USERPROFILE = $oldProfile
  Remove-Item Env:MOCK_SESSION -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-launch-trust-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    # git objects are read-only, which [IO.Directory]::Delete refuses; -Force clears them.
    try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500; try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
  }
}
