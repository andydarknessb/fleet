# ADR 0011 decision 6 (fleet #39): hooks/principal-guard.ps1 keeps the Principal inside
# docs/adr, CONTEXT.md, its status file, the triage ledger and its memory; refuses the
# bare suite, sync-* scripts, closes, merges, wontfix/duplicate, non-docs pushes and the
# production MCP tools; and refuses EVERY fleet role an issue comment beginning
# "Approved", "Re-propose" or "Veto" (shapes only the owner may write). Never exits nonzero.
$ErrorActionPreference = 'Stop'

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Utf8 { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false)) }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$hook = "$sourceRoot\hooks\principal-guard.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("fleet-principal-guard-test-" + [guid]::NewGuid().ToString('N'))
$saved = @{}
# Claude Code writes the payload as UTF-8; the harness must too (the default pipe encoding is ASCII, which turns
# a BOM or an accented letter into a ?).
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
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
  # fleet#208: a Veto (CONTEXT.md **Veto**, the tenant owner's withdrawal of a Bounded-authority
  # ready) is a shape only the owner may write, on every channel and role Approved is refused on.
  Write-Utf8 "$testRoot\veto-body.md" "Veto: not this one`nSecond line."
  foreach ($r in 'project-lead','ic','dispatcher','principal','sentinel') {
    $vetoRefusal = Run-Guard -Role $r -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -R owner/repo -b "Veto"')
    Assert-Denied $vetoRefusal "a Veto comment from $r" 'owner'
    Assert-True ("$($vetoRefusal.permissionDecisionReason)" -match 'Bounded-authority') "the Veto refusal from $r must name it as the withdrawal of a Bounded-authority ready"
    Assert-True ("$($vetoRefusal.permissionDecisionReason)" -match '\*\*Veto\*\*') "the Veto refusal from $r must cite CONTEXT.md **Veto**"
    Assert-Denied (Run-Guard -Role $r -Tool Bash -ToolInput (Bash 'gh pr comment 42 -b "Veto: wrong tier"')) "a Veto PR comment from $r" 'owner'
    Assert-Denied (Run-Guard -Role $r -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Veto"') -AgentId 'w5') "a Veto comment from a sub-agent of $r" 'owner'
  }
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash "gh issue comment 1276 --body 'veto, not now'")) 'a lower-case veto comment' 'Veto'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 1276 --body "  VETO"')) 'a Veto with leading whitespace and upper case' 'Veto'
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash "gh issue comment 1276 --body-file $testRoot\veto-body.md")) 'a Veto body from a file' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 1276 --body-file `"$testRoot\veto-body.md`"")) 'a Veto body from a double-quoted file path' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/1276/comments -f body="Veto."')) 'a Veto comment through gh api' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/1276/comments --raw-field body="Veto this"')) 'a Veto comment through gh api --raw-field' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "\nVeto"')) 'a Veto behind a literal backslash-n prefix' 'owner'
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash "cat > $testRoot/x.md <<'EOF'`nsome prose`nEOF`ngh issue comment 1 -b `"Veto`"")) 'a Veto comment after a heredoc in the same call' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'cd /e/repo && gh issue comment 1 -b "Veto"')) 'a Veto comment after cd &&' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'GH_PAGER= gh pr comment 2 --body "Veto, wrong scope"')) 'a Veto comment behind an env assignment' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 1276 --body-file $testRoot\veto-body.md; echo posted")) 'a Veto body file followed by another command' 'owner'
  foreach ($body in @('Veto; not now', 'Veto | no', 'Veto && reopen', 'Veto (wrong tier)', "Veto`nsecond line")) {
    Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 -b `"$body`"")) "a Veto-shaped body containing a metacharacter ($body)" 'owner'
  }
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 --body 'Veto (see #3); thanks'")) 'a single-quoted Veto body with metacharacters' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/5/comments -f body="Veto; batch 41"')) 'a gh api Veto body with a semicolon' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool PowerShell -ToolInput (Bash "gh issue comment 5 --body @'`nVeto: wrong tier`n'@")) 'a Veto here-string body from the PowerShell tool' 'owner'
  Assert-Denied (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1474 --repo owner/repo --body-file -')) 'a stdin body, whose refusal now also names Veto' 'Veto'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "The owner may Veto this ready inside its window"')) 'the word Veto later in a body'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Vetoed by the owner at 10:04, back to awaiting Approval"')) 'a body beginning Vetoed (not the word Veto)'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash "cat > $testRoot/note.md <<'EOF'`nVeto: nothing, this is a note`nEOF`necho done")) 'a heredoc whose text begins Veto but which is not a comment'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue create --repo owner/repo --title x -b "Veto: a ticket about the guard"')) 'an issue body beginning Veto (not a comment)'
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
  # fleet#229: every spelling of a channel the rule already reads resolves to the same body.
  # Quote concatenation and escaped quotes (one shell word made of several quoted pieces),
  # =-joined flags, a quoted -f "body=...", a quoted api endpoint, gh.exe, a timeout wrapper
  # and a U+FEFF prefix (JS \s admits it, .NET \s does not: the two locks must agree) are
  # each the plain call in other clothes, on the Bash tool and on the PowerShell tool.
  foreach ($case in @(
    @('Bash',       "gh issue comment 5 -b 'Approved: it'\''s fine'",                                     'bash single-quote concatenation with an escaped quote'),
    @('Bash',       "gh issue comment 5 -b `"Veto: it`"'s wrong'",                                         'bash double-then-single quote concatenation'),
    @('PowerShell', "gh issue comment 5 -b `"Approved: ```"x```"`"",                                       'a PowerShell backtick-escaped quote inside the body'),
    @('PowerShell', "gh issue comment 5 -b `"Veto: `"`"x`"`"`"",                                           'a PowerShell doubled double quote inside the body'),
    @('PowerShell', "gh issue comment 5 -b 'Re-propose: it''s'",                                           'a PowerShell doubled single quote inside the body'),
    @('Bash',       'gh issue comment 5 --body="Approved"',                                                '--body="..." (=-joined, quoted)'),
    @('Bash',       'gh issue comment 5 --body=Re-propose',                                                '--body=... (=-joined, bare)'),
    @('Bash',       'gh issue comment 5 -b="Veto"',                                                        '-b="..." (=-joined short flag)'),
    @('PowerShell', 'gh issue comment 5 --body="Approved"',                                                '--body="..." from the PowerShell tool'),
    @('Bash',       "gh issue comment 5 --body-file=$testRoot\approved-body.md",                           '--body-file=<path> (=-joined)'),
    @('Bash',       "gh pr comment 42 -F $testRoot\approved-body.md",                                      '-F <path>, the short spelling of --body-file on issue/pr comment (found during #229)'),
    @('Bash',       'gh api repos/owner/repo/issues/5/comments -f "body=Approved"',                        'a quoted -f "body=..." through gh api'),
    @('Bash',       'gh api repos/owner/repo/issues/5/comments --field "body=Veto"',                       'a quoted --field "body=..." through gh api'),
    @('Bash',       "gh api repos/owner/repo/issues/5/comments --field body=@$testRoot\approved-body.md",  '--field body=@<file> (the long spelling of -F body=@<file>)'),
    @('Bash',       'gh api "repos/$R/issues/5/comments" -f body="Veto"',                                  'a double-quoted api endpoint'),
    @('Bash',       "gh api 'repos/owner/repo/issues/5/comments' -f body=`"Approved`"",                    'a single-quoted api endpoint'),
    @('PowerShell', 'gh api "repos/$R/issues/5/comments" -f body="Approved"',                              'a double-quoted api endpoint from the PowerShell tool'),
    @('Bash',       'gh.exe issue comment 5 -b "Approved"',                                                'gh.exe as the command word'),
    @('PowerShell', 'gh.exe issue comment 5 -b "Veto"',                                                    'gh.exe from the PowerShell tool'),
    @('Bash',       'timeout 30 gh issue comment 5 -b "Re-propose: smaller"',                              'a timeout wrapper before gh'),
    @('Bash',       'GH_PAGER= timeout 30 gh issue comment 5 -b "Approved"',                               'an env assignment and a timeout wrapper before gh'),
    @('Bash',       ('gh issue comment 5 -b "' + [char]0xFEFF + 'Approved"'),                              'a U+FEFF (BOM) prefix before Approved'),
    @('PowerShell', ('gh issue comment 5 -b "' + [char]0xFEFF + 'Veto"'),                                  'a U+FEFF (BOM) prefix before Veto from the PowerShell tool')
  )) {
    Assert-Denied (Run-Guard -Role ic -Tool $case[0] -ToolInput (Bash $case[1])) "fleet#229 equivalent spelling: $($case[2])" 'owner'
  }
  # fleet#229: a body the guard cannot read is refused on its own terms, like --body-file -
  # (fleet #70): the reason names the cause (the body is not readable from the command) and
  # the one-step fix (write the body to a file and pass --body-file <path>), and never
  # asserts a first word the guard did not see.
  foreach ($case in @(
    @('Bash',       "gh issue comment 5 --body `"`$(cat $testRoot/approved-body.md)`"",                    'a double-quoted command substitution as the body'),
    @('Bash',       "gh issue comment 5 -b `$(cat $testRoot/approved-body.md)",                            'a bare command substitution as the body'),
    @('Bash',       'gh issue comment 5 -b "$b"',                                                          'a double-quoted shell variable as the body'),
    @('Bash',       'gh issue comment 5 -b $b',                                                            'a bare shell variable as the body'),
    @('PowerShell', 'gh issue comment 5 -b ("Approved")',                                                  'a parenthesised expression as the body'),
    @('PowerShell', '$b = "Approved"; gh issue comment 5 -b $b',                                           'a PowerShell variable as the body'),
    @('PowerShell', '$a = "issue","comment","5","-b","Approved"; gh @a',                                   'a splat carrying the whole gh call'),
    @('PowerShell', 'gh issue comment 5 @rest',                                                            'a splat carrying the body flag'),
    @('Bash',       "gh api repos/owner/repo/issues/5/comments --field body=@$testRoot\missing-body.md",   '--field body=@<file> naming a file the guard cannot open'),
    @('Bash',       "gh issue comment 5 --body-file $testRoot\missing-body.md",                            '--body-file naming a file the guard cannot open'),
    @('Bash',       'gh api repos/owner/repo/issues/5/comments --method POST --input body.json',           'a JSON body through --input'),
    @('Bash',       'gh issue comment 5 -F -',                                                             '-F -, the short spelling of --body-file - (stdin; found during #229)'),
    @('Bash',       "gh api graphql -f query='mutation { addComment(input: {subjectId: `"I_x`", body: `"Approved`"}) { clientMutationId } }'", 'a GraphQL addComment mutation')
  )) {
    $refusal = Run-Guard -Role ic -Tool $case[0] -ToolInput (Bash $case[1])
    Assert-Denied $refusal "fleet#229 uninspectable body: $($case[2])" 'cannot inspect'
    Assert-True ("$($refusal.permissionDecisionReason)" -match '--body-file <path>') "fleet#229 uninspectable body: $($case[2]): the refusal must name the fix (write the body to a file and pass --body-file <path>)"
    Assert-True ("$($refusal.permissionDecisionReason)" -notmatch "begins '") "fleet#229 uninspectable body: $($case[2]): the refusal must not assert a first word the guard did not see"
  }
  # ...and the plain spellings, a subcommand that is not a comment, and a PowerShell variable
  # handed to gh issue create keep passing: the rule reads comments, not every gh call.
  Assert-Allowed (Run-Guard -Role ic -Tool PowerShell -ToolInput (Bash '$b = "Approved: not a comment"; gh issue create --title x --body $b')) 'a PowerShell variable body on gh issue create (not a comment)'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 5 --body="Not approved: the scope misses the caption"')) 'an =-joined body that does not begin with the words'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api graphql -f query=''mutation { addSubIssue(input: {issueId: "I_x", subIssueId: "I_y"}) { clientMutationId } }''')) 'a GraphQL mutation that adds no comment'
  # fleet#229, Opus QA round. The hook must stay pure ASCII: Windows PowerShell 5.1 reads a BOM-less script in the
  # ANSI code page, so a literal U+FEFF in a regex would silently become three other characters (the BOM cases
  # above then pass only because the harness degraded the BOM to a ?).
  Assert-True (@([IO.File]::ReadAllBytes($hook) | Where-Object { $_ -gt 127 }).Count -eq 0) 'hooks/principal-guard.ps1 must be pure ASCII (use the regex escape for the BOM, never the character)'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 5 -b "?Approved: a literal question mark is not an Approval"')) 'a literal ? before Approved is not an Approval'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 -b `"$([char]0xE9)t$([char]0xE9): Approved later`"")) 'an accented body that does not begin with the words'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 -b `"Approved $([char]0x2014) caf$([char]0xE9)`"")) 'a non-ASCII body that begins with Approved' 'owner'
  # A comment call nested in a substitution, subshell, backticks or an assignment is still a comment (the old
  # splitter cut at parentheses; the tokenizer opens a nested unit instead).
  $bt = [string][char]96
  foreach ($case in @(
    @('Bash',       'out=$(gh issue comment 5 -b "Approved")',                       'a command substitution'),
    @('Bash',       'echo $(gh issue comment 5 -b "Approved")',                      'a command substitution as an argument'),
    @('Bash',       ('url=' + $bt + 'gh issue comment 5 -b "Approved"' + $bt),       'backticks'),
    @('Bash',       'echo x; (gh issue comment 5 -b "Approved")',                    'a subshell'),
    @('PowerShell', '[void](gh issue comment 5 -b "Approved")',                      'a [void] cast'),
    @('PowerShell', 'Write-Output (gh issue comment 5 -b "Approved")',               'a parenthesised argument'),
    @('PowerShell', '$url = gh issue comment 5 -b "Approved"',                       'an assignment'),
    @('PowerShell', '$null = gh issue comment 5 -b "Approved"',                      'a $null assignment'),
    @('PowerShell', 'gh issue comment 5 --title (Get-Date) -b "Approved"',           'a parenthesised argument before the body flag'),
    @('Bash',       "ls # it's fine`ngh issue comment 5 -b `"Approved`"",            'an apostrophe inside a Bash # comment'),
    @('Bash',       "# don't forget`ngh issue comment 5 -b `"Approved`"",            'an apostrophe in a leading # comment'),
    @('PowerShell', "# don't forget`ngh issue comment 5 -b `"Approved`"",            'an apostrophe in a PowerShell # comment'),
    @('PowerShell', "<# it's a block #> gh issue comment 5 -b `"Approved`"",         'an apostrophe in a PowerShell block comment'),
    @('Bash',       "gh issue comment 5 -b \`n  `"Approved`"",                       'a Bash backslash-newline between the flag and the value'),
    @('Bash',       "gh issue comment 5 \`n  --body `"Approved`"",                   'a Bash backslash-newline between arguments'),
    @('Bash',       "gh issue comm\`nent 5 -b `"Approved`"",                         'a Bash backslash-newline inside the subcommand'),
    @('Bash',       "gh issue comment 5 \`r`n  -b `"Approved`"",                     'a Bash backslash-CRLF'),
    @('PowerShell', "gh issue comment 5 $bt`n  -b `"Approved`"",                     'a PowerShell backtick continuation'),
    @('PowerShell', 'gh issue comment 5 -b "`nApproved"',                            'a PowerShell `n escape before the word'),
    @('PowerShell', 'gh issue comment 5 -b "`t`rVeto"',                              'PowerShell `t and `r escapes before the word'),
    @('Bash',       'time gh issue comment 5 -b "Approved"',                         'a time wrapper'),
    @('Bash',       'nice -n 5 gh issue comment 5 -b "Approved"',                    'a nice wrapper'),
    @('Bash',       'winpty gh issue comment 5 -b "Approved"',                       'a winpty wrapper'),
    @('Bash',       'echo 5 | xargs gh issue comment 5 -b "Approved"',               'an xargs wrapper'),
    @('Bash',       'env -S "gh issue comment 5 -b Approved"',                       'env -S with a command line'),
    @('Bash',       'env FOO=1 -S ''gh issue comment 5 -b Veto''',                   'env -S after an assignment')
  )) {
    Assert-Denied (Run-Guard -Role ic -Tool $case[0] -ToolInput (Bash $case[1])) "fleet#229 QA: $($case[2])" 'owner'
  }
  # A body file the Bash tool names the way Bash does (/tmp/x, /c/Users/x) is opened; a body with a lone $ is inspectable.
  $tmpName = "fleet229-$([guid]::NewGuid().ToString('N')).md"
  $tmpFile = Join-Path ([IO.Path]::GetTempPath()) $tmpName
  $posix = '/' + $tmpFile.Substring(0, 1).ToLower() + ($tmpFile.Substring(2) -replace '\\', '/')
  Write-Utf8 $tmpFile "Approved: from the temp directory`n"
  foreach ($spelling in @("--body-file /tmp/$tmpName", "--body-file=/tmp/$tmpName", "-F /tmp/$tmpName", "--body-file $posix")) {
    Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 $spelling")) "fleet#229 QA: a Bash-style path is read: $spelling" 'owner'
  }
  Write-Utf8 $tmpFile "Ruling: the lead agrees`n"
  foreach ($spelling in @("--body-file /tmp/$tmpName", "--body-file=/tmp/$tmpName", "--body-file $posix")) {
    Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 $spelling")) "fleet#229 QA: a readable Bash-style path that is not an Approval passes: $spelling"
  }
  Remove-Item -LiteralPath $tmpFile -Force
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 5 -b "Price is 5$ flat"')) 'a lone $ is not an expansion'
  # A BOM-less UTF-8 body file that starts with NBSP or U+3000 is read as UTF-8 and matched.
  Write-Utf8 "$testRoot\nbsp-body.md" ([string][char]0xA0 + "Approved: x`n")
  Write-Utf8 "$testRoot\ideo-body.md" ([string][char]0x3000 + "Veto: x`n")
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 --body-file $testRoot\nbsp-body.md")) 'fleet#229 QA: an NBSP-prefixed body file' 'owner'
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 --body-file $testRoot\ideo-body.md")) 'fleet#229 QA: a U+3000-prefixed body file' 'owner'
  # More uninspectable shapes, and the cosmetic: the could-not-open refusal shows the path as written.
  Write-Utf8 "$testRoot\query-add.graphql" 'mutation { addComment(input: {subjectId: "I_x", body: "Approved"}) { clientMutationId } }'
  Write-Utf8 "$testRoot\query-read.graphql" 'query { viewer { login } }'
  foreach ($case in @(
    @('Bash',       'gh api "$EP" -f body=Approved',                                                      'a body field on an api call whose endpoint is a variable'),
    @('Bash',       'gh api $(printf repos/o/r/issues/5/comm; echo ents) -f body=Approved',               'a body field on an api call whose endpoint is a substitution'),
    @('Bash',       'gh api graphql -f query="$Q"',                                                       'a GraphQL query held in a variable'),
    @('Bash',       "gh api graphql -F query=@$testRoot\query-add.graphql",                               'a GraphQL query file that adds a comment'),
    @('Bash',       "gh api graphql -F query=@$testRoot\missing.graphql",                                 'a GraphQL query file the guard cannot open'),
    @('Bash',       'gh api graphql -f query=''mutation { updateIssueComment(input: {id: "x", body: "Approved"}) { clientMutationId } }''', 'a GraphQL updateIssueComment mutation'),
    @('Bash',       'gh api graphql -f query=''mutation { addPullRequestReview(input: {pullRequestId: "x", body: "Approved"}) { clientMutationId } }''', 'a GraphQL addPullRequestReview mutation'),
    @('PowerShell', 'gh --% issue comment 5 -b Approved',                                                 'the PowerShell stop-parsing token')
  )) {
    $refusal = Run-Guard -Role ic -Tool $case[0] -ToolInput (Bash $case[1])
    Assert-Denied $refusal "fleet#229 QA uninspectable: $($case[2])" 'cannot inspect'
    Assert-True ("$($refusal.permissionDecisionReason)" -match '--body-file <path>') "fleet#229 QA uninspectable: $($case[2]): the refusal must name the fix"
  }
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh api graphql -F query=@$testRoot\query-read.graphql")) 'a GraphQL query file that reads only'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api graphql -f query=''query { viewer { login } }''')) 'a single-quoted GraphQL read query'
  $missing = Run-Guard -Role ic -Tool Bash -ToolInput (Bash "gh issue comment 5 --body-file $testRoot\missing-body.md")
  Assert-True ("$($missing.permissionDecisionReason)".Contains("$testRoot\missing-body.md")) 'fleet#229 QA: the could-not-open refusal shows the path with its backslashes'
  # fleet#229 re-QA: script blocks and function bodies, gh inside a double-quoted substitution, Bash expansions in a body.
  foreach ($case in @(
    @('PowerShell', 'foreach ($n in 12,13) { gh issue comment $n -b "Approved" }',                'a foreach body'),
    @('PowerShell', '12,13 | ForEach-Object { gh issue comment $_ -b "Approved" }',               'a ForEach-Object script block'),
    @('PowerShell', '12 | % { gh issue comment $_ -b "Veto" }',                                   'a % script block'),
    @('PowerShell', 'if ($true) { gh issue comment 5 -b "Approved" }',                            'an if body'),
    @('PowerShell', 'try { gh issue comment 5 -b "Approved" } catch {}',                          'a try body'),
    @('PowerShell', 'Invoke-Command -ScriptBlock { gh issue comment 5 -b "Approved" }',           'an Invoke-Command script block'),
    @('Bash',       'f() { gh issue comment 5 -b Approved; }; f',                                 'a Bash function body'),
    @('Bash',       'url="$(gh issue comment 5 --body "Approved")"',                              'gh inside a double-quoted substitution'),
    @('PowerShell', '$u = "$(gh issue comment 5 --body "Approved")"',                             'gh inside a double-quoted PowerShell subexpression'),
    @('Bash',       'gh issue comment 5 -b {Approved,}',                                          'a Bash brace list body'),
    @('Bash',       'gh issue comment 5 -b <(echo Approved)',                                     'a Bash process substitution body'),
    @('Bash',       'gh issue comment 5 -F <(echo Approved)',                                     'a Bash process substitution body file')
  )) {
    Assert-Denied (Run-Guard -Role ic -Tool $case[0] -ToolInput (Bash $case[1])) "fleet#229 re-QA: $($case[2])"
  }
  foreach ($cmdText in @('gh issue comment 5 -b App?oved', 'gh issue comment 5 -b *', 'gh issue comment 5 -b ~')) {
    Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash $cmdText)) "fleet#229 re-QA: an unquoted expansion in a body: $cmdText" 'cannot inspect'
  }
  Assert-Allowed (Run-Guard -Role ic -Tool PowerShell -ToolInput (Bash 'foreach ($n in 12,13) { gh issue comment $n -b "Ruling: the lead agrees" }')) 'a foreach body that is not an Approval'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'url="$(gh issue comment 5 --body "Ruling: fine")"')) 'a quoted substitution comment that is not an Approval'
  Assert-Allowed (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh issue comment 5 -b "Ruling: 2 * 3 [ok] {a,b} ~ fine?"')) 'a quoted body with glob characters'
  Assert-Allowed (Run-Guard -Role ic -Tool PowerShell -ToolInput (Bash 'gh issue comment 5 -b "Ruling: *ok*"; $h = @{ a = 1 }')) 'a PowerShell hashtable after a comment'
  $unreadable = Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api graphql -f query="$Q"')
  Assert-True ("$($unreadable.permissionDecisionReason)" -match 'a GraphQL query this guard cannot read') 'fleet#229 re-QA: an unreadable GraphQL query says so'
  Assert-True ("$($unreadable.permissionDecisionReason)" -notmatch 'is a GraphQL mutation') 'fleet#229 re-QA: an unreadable GraphQL query is not called a mutation'
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

  # --- ADR 0017: a Verdict is the Arbiter's alone; the Arbiter itself posts only through the door ---
  foreach ($r in 'project-lead','ic','dispatcher','principal','sentinel') {
    foreach ($body in @('Endorsed', 'Endorsed with: tier haiku', 'Returned', 'Escalated: money - who pays', '## Verdict', '  endorsed')) {
      Assert-Denied (Run-Guard -Role $r -Tool Bash -ToolInput (Bash "gh issue comment 1276 -b `"$body`"")) "a Verdict-shaped comment ($body) from $r" 'Verdict'
    }
    Assert-Denied (Run-Guard -Role $r -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Endorsed"') -AgentId 'w9') "an Endorsed comment from a sub-agent of $r" 'Verdict'
  }
  Assert-Denied (Run-Guard -Role ic -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/1276/comments -f body="Returned: premise false"')) 'a Returned comment through gh api' 'Verdict'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "The Arbiter endorsed #1276 yesterday; assigning"')) 'the word endorsed later in a body'
  Assert-Allowed (Run-Guard -Role project-lead -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Escalation: red CI twice"')) 'a body beginning Escalation (not Escalated:)'
  # The Arbiter: every hand-posted comment is refused (the door posts), the owner's words stay refused, writes stay in its lane.
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Endorsed"')) 'an Endorsed comment posted by the Arbiter by hand' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh pr comment 42 -b "thanks"')) 'any PR comment from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/1276/comments -f body="hello"')) 'a gh api comment from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Approved"')) 'an Approved comment from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Veto"')) 'a Veto comment from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh issue comment 1276 -b "Re-propose"')) 'a Re-propose comment from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh issue edit 1276 --add-label ready-for-agent')) 'a label edit by the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh issue close 1276')) 'a close by the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh pr merge 42')) 'a merge by the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'git push origin docs/adr-0040')) 'a push by the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'npm test')) 'the bare suite from the Arbiter' 'ONE named test file'
  Assert-Denied (Run-Guard -Role arbiter -Tool 'mcp__claude_ai_Supabase__execute_sql' -ToolInput @{ query = 'select 1' }) 'a Supabase query from the Arbiter' 'triage.js verdict'
  # The review's bypass payloads: wrappers, full paths, -R before the subcommand, api writes, nested interpreters.
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'bash -c "gh issue comment 1276 -b hello"')) 'a nested bash -c from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash '"/c/Program Files/GitHub CLI/gh.exe" issue comment 1276 -b hello')) 'a full-path gh.exe comment from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool PowerShell -ToolInput (Bash "& 'C:\Program Files\GitHub CLI\gh.exe' issue comment 1276 -b hello")) 'a PowerShell call-operator gh.exe comment from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh issue -R owner/repo comment 1276 -b hello')) 'a -R before comment from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh api "repos/owner/repo/issues/1276/comment""s" -f body=hello')) 'a pieced comments endpoint from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh api -X PATCH repos/owner/repo/issues/1276 -f state=closed')) 'a PATCH api close from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/1276/labels -f "labels[]=ready-for-agent"')) 'an api label add from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh api -X PUT repos/owner/repo/pulls/42/merge')) 'an api merge from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'timeout 30 gh pr merge 42')) 'a wrapped merge from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'git -C /e/Endzone-Empire push origin main')) 'a git -C push from the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh api graphql -f query=''mutation { addComment(input:{subjectId:"x", body:"Endorsed"}) { clientMutationId } }''')) 'a graphql mutation from the Arbiter' 'ADR 0011'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh issue view 1276 -R owner/repo --comments')) 'an issue read from the Arbiter'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh pr diff 42')) 'a PR diff read from the Arbiter'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh api repos/owner/repo/issues/1276/comments --paginate')) 'a GET api read of comments from the Arbiter'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'gh api -X GET repos/owner/repo/contents/src/x.js')) 'an explicit GET api read from the Arbiter'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash 'node --test tests/triage.tests.js')) 'one named test file from the Arbiter'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash "node $testRoot/bin/triage.js verdict --root $testRoot --tenant test --issue 1276 --kind endorsed")) 'the verdict door from the Arbiter'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Bash -ToolInput (Bash "node $testRoot/bin/triage.js frontier --root $testRoot --tenant test --role arbiter")) 'the arbiter frontier'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Write -ToolInput (WriteTo "$testRoot\state\status\ar-test.md")) 'the Arbiter''s own status file'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Write -ToolInput (WriteTo "$testRoot\profile\.claude\projects\x\memory\note.md")) 'the Arbiter''s memory'
  Assert-Denied (Run-Guard -Role arbiter -Tool Write -ToolInput (WriteTo "$testRoot\state\status\pe-test.md")) 'the Principal''s status file written by the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Write -ToolInput (WriteTo "$repo\docs\adr\0040-x.md")) 'a tenant ADR written by the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Write -ToolInput (WriteTo "$testRoot\docs\adr\0040-x.md")) 'a fleet ADR written by the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Write -ToolInput (WriteTo "$repo\src\lib\thing.js")) 'product code written by the Arbiter' 'triage.js verdict'
  Assert-Denied (Run-Guard -Role arbiter -Tool Write -ToolInput (WriteTo "$testRoot\state\triage\test.jsonl")) 'the ledger written by the Arbiter' 'Cory'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Read -ToolInput @{ file_path = "$repo\src\lib\thing.js" }) 'the Arbiter reading product code'
  Assert-Allowed (Run-Guard -Role arbiter -Tool Agent -ToolInput @{ subagent_type = 'researcher'; prompt = 'x' }) 'the Arbiter spawning the researcher'

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
