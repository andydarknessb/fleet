# ADR 0011 decision 6 (fleet #39): hooks/principal-guard.ps1 keeps the Principal inside
# docs/adr, CONTEXT.md, its status file, the triage ledger and its memory; refuses the
# bare suite, sync-* scripts, closes, merges, wontfix/duplicate, non-docs pushes and the
# production MCP tools; and refuses EVERY fleet role an issue comment beginning
# "Approved" (the fleet shares the owner's GitHub login). Never exits nonzero.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$hook = "$sourceRoot\hooks\principal-guard.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-principal-guard-test-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($v in 'FLEET_HOME','FLEET_ROLE','FLEET_TENANT','USERPROFILE') { $saved[$v] = [Environment]::GetEnvironmentVariable($v) }

function Run-Guard {
  param([string]$Role, [string]$Tool, [hashtable]$ToolInput = @{}, [string]$AgentId = '', [string]$Cwd = '')
  $env:FLEET_HOME = $testRoot; $env:FLEET_ROLE = $Role; $env:FLEET_TENANT = 'test'
  $payload = @{ session_id = 's1'; hook_event_name = 'PreToolUse'; tool_name = $Tool; tool_input = $ToolInput }
  if ($AgentId) { $payload.agent_id = $AgentId }
  if ($Cwd) { $payload.cwd = $Cwd }
  $json = $payload | ConvertTo-Json -Compress -Depth 5
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = ($json | & powershell -NoProfile -ExecutionPolicy Bypass -File $hook 2>&1 | Out-String) }
  finally { $script:lastExit = $LASTEXITCODE; $ErrorActionPreference = $eap }
  Assert-True ($script:lastExit -eq 0) "the guard must never exit nonzero (role=$Role tool=$Tool exit=$script:lastExit)"
  $out = $out.Trim()
  if (-not $out) { return $null }
  return ($out | ConvertFrom-Json).hookSpecificOutput
}
function Assert-Denied { param($Result, [string]$What, [string]$Mentions = 'ADR 0011')
  Assert-True ($null -ne $Result -and $Result.permissionDecision -eq 'deny') "$What must be refused"
  Assert-True ("$($Result.permissionDecisionReason)" -match [regex]::Escape($Mentions)) "$What refusal must mention '$Mentions' (got: $($Result.permissionDecisionReason))"
}
function Assert-Allowed { param($Result, [string]$What) Assert-True ($null -eq $Result) "$What must pass silently (got: $($Result | ConvertTo-Json -Compress))" }
function Bash { param([string]$Command) @{ command = $Command } }
function WriteTo { param([string]$Path) @{ file_path = $Path; content = 'x' } }

try {
  foreach ($dir in 'state\flags','tenants','repo\src','repo\docs\adr','repo\.claude\worktrees\docs-adr-0040\docs\adr','state\status','state\triage','profile\.claude\projects','docs\adr') {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot $dir)) | Out-Null
  }
  $repo = "$testRoot\repo"
  Write-Utf8 "$testRoot\tenants\test.json" ('{"name":"test","github":"owner/repo","ownerLogin":"cory-owner","fleetIdentity":"cory-owner","repo":' + ($repo | ConvertTo-Json) + '}')
  $env:USERPROFILE = "$testRoot\profile"
  Write-Utf8 "$testRoot\approved-body.md" "Approved with: tier sonnet`nSecond line."
  Write-Utf8 "$testRoot\proposal-body.md" "## Triage proposal (advisory)`nClassification: bug"

  # --- writes: the allowlist ---
  Assert-Denied (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$repo\src\lib\thing.js")) 'a Write under src' 'Scope'
  Assert-Denied (Run-Guard -Role principal -Tool Edit -ToolInput @{ file_path = "$repo\server\routes\x.js"; old_string = 'a'; new_string = 'b' }) 'an Edit under server'
  Assert-Denied (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$repo\docs\agents\triage-labels.md")) 'a Write under docs/ that is not docs/adr'
  Assert-Denied (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$testRoot\state\work\active.json")) 'a Write into fleet state'
  Assert-Denied (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$testRoot\state\status\pl-test.md")) 'a Write to another session''s status file'
  Assert-Denied (Run-Guard -Role principal -Tool NotebookEdit -ToolInput @{ notebook_path = "$repo\notebooks\x.ipynb" }) 'a NotebookEdit in the repo'
  Assert-Denied (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo 'src/lib/thing.js') -Cwd $repo) 'a relative Write resolved against cwd'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$repo\docs\adr\0040-triage-proposals.md")) 'a Write under the tenant docs/adr'
  Assert-Allowed (Run-Guard -Role principal -Tool Edit -ToolInput @{ file_path = "$repo\CONTEXT.md"; old_string = 'a'; new_string = 'b' }) 'an Edit of the tenant CONTEXT.md'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$repo\.claude\worktrees\docs-adr-0040\docs\adr\0040-x.md")) 'a Write under docs/adr inside a worktree'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$testRoot\docs\adr\0012-x.md")) 'a Write under the fleet docs/adr'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$testRoot\CONTEXT.md")) 'a Write of the fleet CONTEXT.md'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$testRoot\state\status\pe-test.md")) 'a Write of its own status file'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$testRoot\profile\.claude\projects\x\memory\note.md")) 'a Write into its user-scope memory'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo (Join-Path ([IO.Path]::GetTempPath()) 'scratch.txt'))) 'a Write into the temp directory'
  Assert-Denied (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$repo\src\lib\thing.js") -AgentId 'w1') 'a Write under src from a worker the Principal spawned'

  # --- commands: one named test file, nothing wider ---
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'npm test')) 'the bare suite' 'ONE named test file'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'cd /e/repo && npm test -- --watchAll=false')) 'npm test with flags but no file'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'npm run test:server:all')) 'the 42-minute suite'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'npm run test:server:sweep 2>&1 | tail')) 'the sweep suite'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'npx jest')) 'bare jest'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'node --test')) 'bare node --test'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'node scripts/sync-players.js --season 2026')) 'a sync script'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'npm run sync-schedule')) 'a sync npm script'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh issue close 1276 -R owner/repo')) 'closing an issue' 'Cory'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh pr merge 42 --squash')) 'merging a PR'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh issue edit 5 --add-label wontfix')) 'the wontfix label'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh issue edit 5 -R owner/repo --add-label "bug,duplicate"')) 'the duplicate label'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'git push -u origin fleet/1234-thing')) 'a push to a fleet branch'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'git push origin HEAD')) 'a push with no docs branch named'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'npm test -- src/lib/thing.test.js')) 'one named jest file'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'npm test -- --watchAll=false src/lib/thing.test.js')) 'one named jest file with a flag first'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'node --test server/test/lineup.test.js')) 'one named node test file'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'npx jest src/lib/thing.test.js')) 'one named file through npx jest'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh issue view 1276 --comments')) 'reading a ticket'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "## Triage proposal (advisory)"')) 'posting a proposal'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh issue comment 1276 --body-file ' + "$testRoot\proposal-body.md")) 'posting a proposal from a file'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh issue edit 1276 --add-label triage-proposed')) 'the marker label'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh issue edit 1276 --add-label ready-for-agent --remove-label triage-proposed')) 'finalizing labels after an approval'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'git push -u origin docs/adr-0040-triage')) 'a push to a docs branch'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'node C:/Users/Cory/fleet/bin/triage.js record --root C:/Users/Cory/fleet --tenant test --kind proposed --issue 1')) 'recording in the ledger'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'gh pr create --base integration --head docs/adr-0040 --title x --body y')) 'opening a docs PR'

  # --- production tools ---
  Assert-Denied (Run-Guard -Role principal -Tool 'mcp__claude_ai_Supabase__execute_sql' -ToolInput @{ query = 'select 1' }) 'a Supabase query' 'Repro'
  Assert-Denied (Run-Guard -Role principal -Tool 'mcp__claude_ai_Netlify__netlify-deploy-services-updater' -ToolInput @{}) 'a Netlify deploy updater'
  Assert-Allowed (Run-Guard -Role principal -Tool 'mcp__claude_ai_Netlify__netlify-project-services-reader' -ToolInput @{}) 'a Netlify reader'
  Assert-Allowed (Run-Guard -Role principal -Tool Read -ToolInput @{ file_path = "$repo\src\lib\thing.js" }) 'reading product code'
  Assert-Allowed (Run-Guard -Role principal -Tool Agent -ToolInput @{ subagent_type = 'researcher'; prompt = 'x' }) 'spawning the researcher'

  # --- every role: no session writes an Approval ---
  foreach ($r in 'project-lead','ic','dispatcher','principal','sentinel') {
    Assert-Denied (Run-Guard -Role $r -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -R owner/repo -b "Approved"')) "an Approved comment from $r" 'owner'
  }
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash "gh issue comment 1276 --body 'approved with: tier sonnet'")) 'a lower-case approved-with-edits comment'
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash "gh issue comment 1276 --body-file $testRoot\approved-body.md")) 'an Approved body from a file'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/1276/comments -f body="Approved."')) 'an Approved comment through gh api'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh pr comment 42 -b "Approved, merging"')) 'an Approved PR comment'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Approved"') -AgentId 'w2') 'an Approved comment from a sub-agent'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Not approved: the scope misses the caption"')) 'a comment that does not begin with Approved'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Review: approved the PR shape, one nit"')) 'the word approved later in a body'
  # fleet#55: a re-proposal ask is a shape only the owner may write, like Approved.
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1298 -b "Re-propose: the scope changed"')) 'a Re-propose comment from the lead' 'fleet#55'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 1298 --body "repropose please"') -AgentId 'w3') 'a repropose comment from a sub-agent'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1298 -b "The lead will re-propose the scope once #3 lands"')) 'the word re-propose later in a body'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh pr review 42 --approve -b "LGTM"')) 'a PR review approval (not a comment body)'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'npm test')) 'the bare suite for an IC (not the Principal''s rule)'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Write -ToolInput (WriteTo "$repo\src\x.js")) 'a lead Write (the door denies it, not this hook)'

  # --- no fleet identity, rollback flag ---
  $env:FLEET_HOME = ''; $env:FLEET_ROLE = ''
  $payload = @{ tool_name = 'Bash'; tool_input = @{ command = 'gh issue comment 1 -b "Approved"' } } | ConvertTo-Json -Compress
  $bare = ($payload | & powershell -NoProfile -ExecutionPolicy Bypass -File $hook 2>&1 | Out-String).Trim()
  Assert-True (-not $bare) 'a non-fleet session must pass'
  Write-Utf8 "$testRoot\state\flags\principal-guard-off" 'rollback'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$repo\src\lib\thing.js")) 'the rollback flag disables the write rule'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1 -b "Approved"')) 'the rollback flag disables the Approved rule'
  Remove-Item "$testRoot\state\flags\principal-guard-off"

  Write-Output 'principal guard tests passed'
} finally {
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'fleet-principal-guard-test-'
  if ($resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($resolved)) {
    [IO.Directory]::Delete($resolved, $true)
  }
}
