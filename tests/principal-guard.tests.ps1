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
  # fleet#70 case 1: a body on stdin cannot be inspected. Still refused, but the refusal
  # says WHY and names the fix; it must not claim the body begins with "Approved".
  $stdinRefusal = Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1474 --repo owner/repo --body-file -')
  Assert-Denied $stdinRefusal 'a comment body passed on stdin' 'stdin'
  Assert-True ("$($stdinRefusal.permissionDecisionReason)" -match '--body-file <path>') 'the stdin refusal must name the fix (write the body to a file and pass its path)'
  Assert-True ("$($stdinRefusal.permissionDecisionReason)" -notmatch "begins 'Approved'") 'the stdin refusal must not claim the body begins with Approved'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/1474/comments -F body=@-') -AgentId 'w4') 'a gh api comment body from stdin' 'stdin'
  # fleet#70 case 2: the rule applies to the command being INVOKED, not to prose that
  # quotes one. A heredoc that documents a `gh issue comment ... --body-file -` line,
  # written by cat, then a `gh issue create` from that file, is not a comment.
  $ticketCmd = "cat > $testRoot/ticket.md <<'EOF'`n## Repro`nRun gh issue comment 1 --repo owner/repo --body-file - and watch it refuse.`nEOF`ngh issue create --repo owner/repo --title x --body-file $testRoot/ticket.md"
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash $ticketCmd)) 'a heredoc quoting a gh comment invocation, followed by gh issue create'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue create --repo owner/repo --title x -b "Never run gh issue comment 1 --body-file - from a session"')) 'prose naming a gh comment invocation inside another command''s body'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash "cat > $testRoot/note.md <<'EOF'`nApproved with: nothing, this is a note`nEOF`necho done")) 'a heredoc whose text begins Approved but which is not a comment'
  # ...and the real command still counts wherever it sits in the call.
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash "cat > $testRoot/x.md <<'EOF'`nsome prose`nEOF`ngh issue comment 1 -b `"Approved`"")) 'an Approved comment after a heredoc in the same call' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'cd /e/repo && gh issue comment 1 -b "Approved"')) 'an Approved comment after cd &&' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'GH_PAGER= gh pr comment 2 --body "Approved, ship it"')) 'an Approved comment behind an env assignment' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 1276 --body-file $testRoot\approved-body.md; echo posted")) 'an Approved body file followed by another command' 'owner'
  # ...and a shell metacharacter INSIDE a quoted body never cuts the body short.
  foreach ($body in @('Approved; ship it', 'Approved | ship', 'Approved && merged', 'Approved (batch 41)', "Approved`nsecond line", 'Re-propose; smaller')) {
    Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 -b `"$body`"")) "an Approved-shaped body containing a metacharacter ($body)" 'owner'
  }
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 --body 'Approved (see #3); thanks'")) 'a single-quoted Approved body with metacharacters' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/5/comments -f body="Approved; batch 41"')) 'a gh api Approved body with a semicolon' 'owner'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 5 -b "never use --body-file - from a session; write a file"')) 'prose naming --body-file - inside a real, inspectable body'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 --body-file `"$testRoot\proposal-body.md`"")) 'a double-quoted body-file path'
  # The PowerShell tool goes through the same block: a here-string is a quoted body
  # (inspected as one) and prose inside one is not a command.
  Assert-Denied (Run-Guard -Role ic -Tool PowerShell -ToolInput (Bash "gh issue comment 5 --body @'`nApproved with: tier sonnet`n'@")) 'an Approved here-string body from the PowerShell tool' 'owner'
  Assert-Allowed (Run-Guard -Role ic -Tool PowerShell -ToolInput (Bash "`$b = @'`nRun gh issue comment 1 --body-file - and it refuses`n'@; gh issue create --title x --body `$b")) 'a here-string quoting a gh comment invocation, then gh issue create'
  Assert-Allowed (Run-Guard -Role ic -Tool PowerShell -ToolInput (Bash "gh issue comment 5 --body @'`n## Triage proposal (advisory)`n'@")) 'a proposal here-string body from the PowerShell tool'
  # Pre-existing: a proposal body with parentheses passes because of the RULE, not because the parens cut the body.
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 5 -b "Approved (advisory) proposal"')) 'an Approved body whose parentheses must not hide it' 'owner'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'npm test')) 'the bare suite for an IC (not the Principal''s rule)'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Write -ToolInput (WriteTo "$repo\src\x.js")) 'a lead Write (the door denies it, not this hook)'

  # --- spec fleet #193: the Bounded-authority flags and the triage ledger are not a session's to write (every role) ---
  Assert-Denied (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$testRoot\state\triage\test.jsonl")) 'a Principal Write of the triage ledger' 'bin/triage.js'
  Assert-Denied (Run-Guard -Role principal -Tool Edit -ToolInput @{ file_path = "$testRoot\state\triage\test.jsonl"; old_string = 'a'; new_string = 'b' }) 'a Principal Edit of the triage ledger'
  Assert-Denied (Run-Guard -Role ic -Tool Write -ToolInput (WriteTo "$testRoot\state\flags\bounded-authority-test")) 'an IC Write of the tenant flag' 'Cory'
  Assert-Denied (Run-Guard -Role project-lead -Tool Write -ToolInput (WriteTo "$testRoot\state\flags\bounded-authority-suspended-test")) 'a lead Write of the suspension flag'
  Assert-Denied (Run-Guard -Role dispatcher -Tool NotebookEdit -ToolInput @{ notebook_path = "$testRoot\state\triage\x.ipynb" }) 'a NotebookEdit under state/triage'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'rm state/flags/bounded-authority-test')) 'an IC rm of the tenant flag' 'Cory'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'echo ''{"kind":"suspended"}'' >> state/triage/test.jsonl')) 'an IC echo appended to the ledger' 'bin/triage.js'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'cat notes.txt > state/triage/test.jsonl')) 'a read-only command word redirected into the ledger'
  Assert-Denied (Run-Guard -Role project-lead -Tool PowerShell -ToolInput (Bash "Remove-Item $testRoot\state\flags\bounded-authority-suspended-test")) 'a PowerShell Remove-Item of the suspension flag'
  Assert-Denied (Run-Guard -Role project-lead -Tool PowerShell -ToolInput (Bash "Set-Content $testRoot\state\triage\test.jsonl 'x'")) 'a PowerShell Set-Content of the ledger'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'node -e "require(''fs'').writeFileSync(''state/flags/bounded-authority-test'','''')"')) 'node -e writing a flag'
  Assert-Denied (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'touch state/flags/bounded-authority-test') -AgentId 'w9') 'a Principal worker touching the flag'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'cat state/flags/bounded-authority-suspended-test')) 'reading the suspension flag'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'ls state/triage/')) 'listing the ledger directory'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'tail -n 5 state/triage/test.jsonl')) 'tailing the ledger'
  Assert-Allowed (Run-Guard -Role dispatcher -Tool PowerShell -ToolInput (Bash "Get-Content $testRoot\state\triage\test.jsonl")) 'Get-Content of the ledger'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'node C:/Users/Cory/fleet/bin/triage.js bounded-scan --tenant test')) 'the scan door, which names neither the flag nor the ledger path'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'node C:/Users/Cory/fleet/bin/triage.js bounded-ready --tenant test --issue 7')) 'the bounded-ready door'
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'New-Item state/flags/notifier-live')) 'any flag under state/flags belongs to Cory, not only the bounded ones' 'Cory'
  Assert-Allowed (Run-Guard -Role principal -Tool Write -ToolInput (WriteTo "$testRoot\state\status\pe-test.md")) 'the Principal''s own status file still writes'

  # --- re-QA (M-B): the bypasses of the first cut of rule 2b, each refused ---
  foreach ($case in @(
    @('ic', 'Bash', 'rm -rf state/flags'),
    @('ic', 'Bash', 'rm state/flags/*'),
    @('ic', 'Bash', 'rm state/flags/bounded-a*'),
    @('ic', 'Bash', 'rm -r state/triage'),
    @('ic', 'Bash', 'mv state/triage state/triage.bak'),
    @('ic', 'Bash', 'git clean -fdx state/'),
    @('ic', 'Bash', 'git checkout -- state/flags'),
    @('ic', 'Bash', 'git checkout -- state/triage/test.jsonl'),
    @('ic', 'Bash', 'git restore state/flags'),
    @('ic', 'Bash', 'ls state/flags/bounded-authority-* | xargs rm'),
    @('ic', 'Bash', 'cat x.jsonl | tee -a state/triage/test.jsonl'),
    @('ic', 'Bash', 'find state/flags -name "bounded-authority-*" -delete'),
    @('ic', 'Bash', 'cp /tmp/empty state/flags/bounded-authority-test'),
    @('ic', 'Bash', 'node C:/tmp/rm.js state/flags/bounded-authority-test'),
    @('ic', 'Bash', 'node C:/tmp/cleanup.js state/triage'),
    @('project-lead', 'PowerShell', 'Remove-Item state\flags\*'),
    @('project-lead', 'PowerShell', 'Remove-Item state\flags\bounded-auth*'),
    @('project-lead', 'PowerShell', 'Get-ChildItem state\flags\bounded-authority-* | Remove-Item'),
    @('project-lead', 'PowerShell', 'Copy-Item C:\tmp\x state\flags\bounded-authority-test'),
    @('project-lead', 'PowerShell', 'type nul > state\flags\bounded-authority-test'),
    @('project-lead', 'PowerShell', '"x" | Out-File -Append state\triage\test.jsonl')
  )) {
    Assert-Denied (Run-Guard -Role $case[0] -Tool $case[1] -ToolInput (Bash $case[2])) "the bypass: $($case[2])" 'Cory'
  }
  # A pipeline is one unit: read-only stages all the way through are still allowed.
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'cat state/triage/test.jsonl | tail -n 3')) 'a read-only pipeline over the ledger'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'ls state/flags | grep bounded')) 'ls piped to grep'
  Assert-Allowed (Run-Guard -Role project-lead -Tool PowerShell -ToolInput (Bash 'Get-ChildItem state\flags | Select-Object -First 3')) 'Get-ChildItem piped to Select-Object'
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash 'node C:/Users/Cory/fleet/bin/triage.js state --tenant test')) 'a triage door that names neither'
  # The accepted residue (named in the hook): a path built by string concatenation, or a script written to a file and run,
  # is not seen by a rule that reads the command line. The hook's own comment says so.
  # --- final QA: units, subexpressions, interpreters, spellings, git options, the node pin ---
  $F = 'state/flags/bounded-authority-suspended-test'
  $L = 'state/triage/test.jsonl'
  foreach ($case in @(
    @('ic', 'Bash', "cat $F & rm $F"),
    @('ic', 'Bash', "ls `$(rm $F)"),
    @('ic', 'Bash', "cat ``rm $F``"),
    @('ic', 'Bash', "sort -o $L C:/tmp/forged.jsonl"),
    @('ic', 'Bash', "uniq C:/tmp/forged.jsonl $L"),
    @('ic', 'Bash', 'uniq /dev/null state/flags/bounded-authority-test'),
    @('ic', 'Bash', 'rg --pre C:/tmp/evil.sh x state/triage/test.jsonl'),
    @('project-lead', 'PowerShell', "Get-Content (Remove-Item $F)"),
    @('project-lead', 'PowerShell', "Test-Path $F -or (Remove-Item $F)"),
    @('project-lead', 'PowerShell', 'Get-ChildItem state\flags | Where-Object { $_.Delete() }'),
    @('project-lead', 'PowerShell', 'Get-ChildItem state\flags | Select-Object @{e={Remove-Item $_.FullName}}'),
    @('ic', 'Bash', "bash <<'EOF'`nrm -f $F`nEOF"),
    @('ic', 'Bash', "node <<'EOF'`nrequire('fs').unlinkSync('$F')`nEOF"),
    @('ic', 'Bash', 'sh -c "rm state/flags/x"'),
    @('ic', 'Bash', 'rm -rf state/"flags"'),
    @('ic', 'Bash', "rm -rf 'state'/flags"),
    @('ic', 'Bash', 'rm -rf state//flags'),
    @('ic', 'Bash', 'rm -rf state/./flags'),
    @('ic', 'Bash', 'rm -rf state\flags'),
    @('ic', 'Bash', 'rm -rf state/f*s'),
    @('ic', 'Bash', 'rm state/*/bounded-*'),
    @('ic', 'Bash', 'cd C:/Users/Cory/fleet/state && rm -rf flags'),
    @('project-lead', 'PowerShell', 'Push-Location C:\Users\Cory\fleet\state; Remove-Item flags -Recurse'),
    @('ic', 'Bash', 'git -C C:/Users/Cory/fleet clean -fdx state/'),
    @('ic', 'Bash', 'git -c core.x=y checkout -- state/flags'),
    @('ic', 'Bash', 'git --no-pager restore state/triage'),
    @('principal', 'Bash', "node C:/tmp/x/bin/triage.js $F"),
    @('principal', 'Bash', "node $testRoot/bin/triage.js.evil $F"),
    @('principal', 'Bash', "node -r C:/tmp/evil.js $testRoot/bin/triage.js $F"),
    @('principal', 'Bash', "NODE_OPTIONS='--require C:/tmp/evil.js' node $testRoot/bin/triage.js $F")
  )) {
    Assert-Denied (Run-Guard -Role $case[0] -Tool $case[1] -ToolInput (Bash $case[2])) "the bypass: $($case[2])" 'Cory'
  }
  Assert-Allowed (Run-Guard -Role principal -Tool Bash -ToolInput (Bash "node $testRoot/bin/triage.js hash --tenant test --issue 1 # notes on state/flags")) 'the pinned triage door, whatever its arguments name'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "cat > note.md <<'EOF'`nthe flag lives in state/flags/bounded-authority-test`nEOF`necho done")) 'a heredoc that documents the path for a non-interpreter'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "cat $F 2>&1 | head -n 3")) 'a read-only pipeline with a stderr redirect'
  # The path spellings the Edit/Write rule sees through.
  $drive = $testRoot.Substring(0, 1).ToLowerInvariant()
  foreach ($p in @("\\?\$testRoot\state\flags\bounded-authority-test", ("\\localhost\$drive" + [char]36 + $testRoot.Substring(2) + '\state\flags\bounded-authority-test'), "$testRoot\state\flags.\bounded-authority-test", "$testRoot\state\triage \x.jsonl")) {
    Assert-Denied (Run-Guard -Role ic -Tool Write -ToolInput (WriteTo $p)) "a Write through the spelling $p" 'Cory'
  }

  # Names that only look like the flag stay allowed: a branch or prose that says bounded-authority.
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'git push origin fleet/212-bounded-authority-go-live')) 'a push of a branch named for Bounded authority'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 5 -b "the bounded-authority flag stands until Cory removes it"')) 'prose about the flag'
  Assert-Denied (Run-Guard -Role ic -Tool Write -ToolInput (WriteTo "$testRoot\state\triage::$([char]36)DATA")) 'a Write through an alternate data stream of the ledger directory' 'Cory'

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
