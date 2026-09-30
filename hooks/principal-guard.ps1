# PreToolUse hook (ADR 0011 decision 6, fleet #39): the Principal's boundary is a hook,
# not prose. Two rule sets:
#
#   1. role principal (main session AND its sub-agents; a worker it spawns is still it):
#      - Edit/Write/NotebookEdit/MultiEdit only under: the tenant repo's docs/adr/ and
#        CONTEXT.md (also inside .claude/worktrees/<x>/ for a docs PR), the fleet's
#        docs/adr/ and CONTEXT.md, its own status file state/status/pe-<tenant>.md,
#        the user's ~/.claude (memory, plans) and the temp directory. The triage
#        ledger is NOT writable here: it is written only through node bin/triage.js,
#        whose doors check what they record (rule 2b below).
#      - Bash/PowerShell: no bare test suite (npm test / npx jest / node --test with no
#        file; test:server:all / :sweep ever), no sync-* script, no gh issue close,
#        no gh pr merge, no wontfix/duplicate label, no git push to a branch outside
#        docs/. One named test file passes.
#      - No Supabase or Netlify-writing MCP tool.
#   2. every fleet role: no comment whose body begins "Approved", "Re-propose" or "Veto"
#      on any issue. Until #154 the fleet's gh login was the tenant owner's (fleetIdentity ==
#      ownerLogin) and this rule alone made an Approval, and (fleet#55) a re-proposal
#      ask, Cory's; (fleet#208) a Veto, the owner's withdrawal of a Bounded-authority
#      ready (CONTEXT.md **Veto**), is his alone the same way. Since #154 the fleet
#      acts as its own login (ADR 0015) and the owner-login gate in bin/triage.js
#      does that; this rule stays as the second
#      lock (ADR 0011 amendment). The rule reads the command being invoked, not
#      prose or heredoc text that quotes one, and a body it cannot inspect (stdin,
#      --body-file -) is refused on its own terms with the fix named (fleet #70).
#      (fleet#229) It reads every spelling gh accepts, with the tool's own quoting (a
#      tokenizer, not a regex): -b/--body/--body=V/-b=V/-bV, --body-file/-F and their =
#      forms, gh api -f/-F/--field/--raw-field body=V and body=@file, quote pieces that
#      concatenate, gh.exe or a path, and a timeout/env/nice/time/xargs/winpty/command/
#      exec/nohup wrapper (env -S included); a call inside $( ), "$( )", ( ), { } (a
#      script block, a loop body, a Bash function), backticks or after a `$x =`
#      assignment is still read. A Bash body word with an unquoted brace list, glob or
#      leading ~ is refused (the shell would rewrite it).
#      Refused as uninspectable, never cleared: a body built by a command substitution,
#      a variable or expression, or a PowerShell splat or --% list; --input; a gh api
#      graphql mutation that adds or edits a comment, or a query it cannot read; a body
#      field on an api call whose endpoint it cannot read; a body file it cannot open
#      (/tmp/x and /c/x are tried as %TEMP% and c:/ on the Bash tool).
#      It reads tool_input.command of Bash/PowerShell only: a GitHub MCP tool is outside
#      it until one is configured (none is on this host), which must arrive with a
#      rule-set-2 extension. Named residue, not seen by a rule that reads the command
#      line: a nested interpreter (sh -c, bash -c, pwsh -c, powershell -Command, cmd //c,
#      iex, Start-Process), a gh alias (gh alias set ... then the alias), a pull-request
#      review or gh pr review -c / pulls/N/reviews
#      (triage reads issue comments only), and a command longer than the hook's 15 s
#      budget can tokenize (about 100 KB takes 2.5 s). This file stays pure ASCII: a
#      BOM-less script is read in the ANSI code page by Windows PowerShell 5.1.
#   2b. every fleet role (spec fleet #193, ruling on the QA of #209 to #211): the
#      Bounded-authority flags are Cory's to create and remove, and the triage ledger is
#      written by bin/triage.js, whose checks are the point. Edit/Write/NotebookEdit/
#      MultiEdit on any path under state/flags/ or state/triage/ is refused, and so is a
#      Bash/PowerShell unit (cut at newline, ; & && ||; a pipeline is one unit) that
#      names state/flags, state/triage, a wildcard component after state/ or a bounded-a*
#      glob is refused unless it is plain: no ( ) { } or backtick (no subexpression, no
#      script block, no interpreter body), no redirect into the name, and every pipeline
#      stage's command word is read-only (cat, ls, dir, type, head, tail, Get-Content,
#      Get-ChildItem, Test-Path, Get-Item, grep, wc, cut, findstr, Select-Object,
#      Where-Object, Sort-Object, Measure-Object, Select-String). sort, uniq and rg are
#      not on the list: they can write (sort -o, uniq in out, rg --pre). git clean/
#      checkout/restore/reset/rm/mv/stash on state/, and cd/Push-Location into state in a
#      call that also names flags or triage, are refused. node passes only as node
#      <FLEET_HOME>/bin/triage.js, the script resolved against cwd. A heredoc fed to an
#      interpreter (bash, sh, node, python, powershell, pwsh, cmd) is scanned as commands;
#      any other heredoc is stripped. Quotes are dropped and path separators collapsed
#      before matching. Over-refusal is accepted; the refusal names the cause. node
#      bin/triage.js bounded-scan (and the daily summary) never name the flag or the
#      ledger path in their command line, so the scan's own write is unaffected.
#      ACCEPTED RESIDUE: a path built by string concatenation, a variable (X=state; rm
#      $X/flags) or a script written to a file and run cannot be seen by a rule that reads
#      the command line; Edit/Write, the ledger's door checks and Cory's daily summary
#      are the rest.
#
# Rollback: state/flags/principal-guard-off. Output contract: a deny is JSON on stdout
# with permissionDecision "deny"; anything else is silence + exit 0. Never exit nonzero.
$ErrorActionPreference = 'SilentlyContinue'
# The payload is UTF-8 JSON: decode it as such (the console code page would turn a U+FEFF into
# three garbage characters before the body regexes below ever saw it).
try { $raw = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))).ReadToEnd() } catch { $raw = [Console]::In.ReadToEnd() }
$inp = $null
try { $inp = "$raw" | ConvertFrom-Json } catch {}
if (-not $inp) { exit 0 }
$home_ = $env:FLEET_HOME; $role = $env:FLEET_ROLE; $tenant = $env:FLEET_TENANT
if (-not $home_ -or -not $role) { exit 0 }                                   # not a fleet session
if (Test-Path "$home_\state\flags\principal-guard-off") { exit 0 }

$tool = "$($inp.tool_name)"
$reason = $null
$cite = "(ADR 0011; rollback flag state/flags/principal-guard-off)"

function Normalize-Path {
  param([string]$Path, [string]$Cwd)
  if (-not $Path) { return '' }
  $p = $Path
  if ($p -match '^\\\\\?\\') { $p = $p.Substring(4) }
  if ($p -match '^\\\\(?:localhost|127\.0\.0\.1)\\([A-Za-z])\$\\') { $p = $Matches[1] + ':\' + $p.Substring($Matches[0].Length) }
  if ($p -match '^~[\\/]') { $p = $env:USERPROFILE + $p.Substring(1) }
  if (-not [IO.Path]::IsPathRooted($p) -and $Cwd) { $p = Join-Path $Cwd $p }
  try { $p = [IO.Path]::GetFullPath($p) } catch {}
  return ($p -replace '\\', '/').ToLowerInvariant().TrimEnd('/')
}
function Escape-Rx { param([string]$Text) [regex]::Escape($Text) }

# One template for every body this guard cannot read (fleet#70 stdin, fleet#229 the rest): it names the
# cause and the one-step fix instead of asserting a first word the guard never saw.
function Get-UninspectableReason {
  param([string]$Cause)
  return "the comment body is $Cause, which this guard cannot inspect, so it cannot clear the comment: no fleet session may post an issue or PR comment beginning 'Approved' (the tenant owner's Approval of a Triage proposal, CONTEXT.md **Approval**), 'Re-propose' or 'Veto' (the tenant owner's withdrawal of a Bounded-authority ready, CONTEXT.md **Veto**): those shapes are the owner's alone, bin/triage.js recognises them by shape and author, and this guard is the second lock. Write the body to a file (in a separate call) and pass --body-file <path>; the guard reads the file's first line $cite"
}
function Get-WordCause {
  param($Word)
  if ($Word.Text -match '^@\w+$') { return 'a splat' }
  if ($Word.Text -match '\$\(|`|^[<>]\($') { return 'built by a command substitution or subshell' }
  return 'a shell variable or expression'
}
# A PowerShell backtick escape inside "..." or bare: `n `t `r `0 `a `b `f `v are control characters, any other is itself.
function Get-PsEscape {
  param([string]$Char)
  switch -CaseSensitive ($Char) {
    'n' { return "`n" }
    't' { return "`t" }
    'r' { return "`r" }
    '0' { return "`0" }
    'a' { return "`a" }
    'b' { return "`b" }
    'f' { return "`f" }
    'v' { return "`v" }
    default { return $Char }
  }
}
# A path the guard is asked to open. The Bash tool writes /tmp/x and /c/Users/x; on this host those are
# %TEMP%\x and c:/Users/x, so they are tried as well as the spelling as written.
function Read-GuardFile {
  param([string]$Val, $Word, [string]$Tool, [string]$Cwd)
  $pre = $Word.Text.Length - $Val.Length
  $altVal = $Val
  if ($pre -ge 0 -and $Word.Alt.Length -ge $pre) { $altVal = $Word.Alt.Substring($pre) }
  $cands = @($Val, $altVal)
  if ($Tool -eq 'Bash') {
    foreach ($v in @($Val, $altVal)) {
      if ($v -match '^/tmp(?:/(.*))?$') { $cands += (Join-Path ([IO.Path]::GetTempPath()) "$($Matches[1])") }
      elseif ($v -match '^/([A-Za-z])(?:/(.*))?$') { $cands += ($Matches[1] + ':/' + $Matches[2]) }
    }
  }
  foreach ($cand in $cands) {
    $fp = Normalize-Path $cand $Cwd
    if ($fp -and (Test-Path -LiteralPath $fp -PathType Leaf)) {
      try { $raw = Get-Content -LiteralPath $fp -Raw -Encoding UTF8; return [pscustomobject]@{ Opened = $true; Text = "$raw"; Shown = $altVal } } catch {}
    }
  }
  return [pscustomobject]@{ Opened = $false; Text = ''; Shown = $altVal }
}

# Quote-aware tokenizer (fleet#229). Returns the call as units (cut at an unquoted newline ; && || | &,
# never at a metacharacter inside a quote), each unit a list of words { Text; Alt; Inspectable; Sentinel }.
# Bash: '..' literal, ".." with \" \\ \$ \`, \x outside quotes, adjacent pieces concatenate.
# PowerShell: '..' with '', ".." with `x and "", here-strings @'..'@ / @".."@, ` outside quotes.
# Alt is Text with an unquoted Bash backslash kept (a Windows path written C:\dir\file).
# A word is Inspectable only when every piece that is not single-quoted is free of an expansion:
# a $ followed by a name, {, (, digit or special character (or a Bash backtick) anywhere outside '..',
# and a bare @name on PowerShell (a splat). An unquoted $( ( or Bash backtick opens a nested unit
# (so `out=$(gh ...)`, `[void](gh ...)` and `x=`gh ...`` are still read as gh calls) and leaves an
# uninspectable Sentinel word in the outer unit where the expansion stood; the outer unit goes on after
# the closing ). An unquoted # at the start of a word (and PowerShell <# #>) is a comment.
function Read-ShellUnits {
  param([string]$Text, [string]$Tool)
  $ps = ($Tool -eq 'PowerShell')
  $units = New-Object System.Collections.ArrayList
  $words = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.ArrayList
  $t = New-Object System.Text.StringBuilder
  $a = New-Object System.Text.StringBuilder
  $st = @{ has = $false; ok = $true; bare = $true; sent = ''; kind = ''; tilde = $false }
  $expRx = '^[A-Za-z0-9_{(@*#?!$-]$'
  $ghRx = '^\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:[^\s"''`|;&()]*[\\/])?gh(?:\.exe)?(?=\s|$)'
  $extra = New-Object System.Collections.ArrayList
  $endWord = {
    if ($st.has) {
      $tx = $t.ToString()
      if ($ps -and $st.bare -and $tx -match '^@\w+$') { $st.ok = $false }
      [void]$words.Add([pscustomobject]@{ Text = $tx; Alt = $a.ToString(); Inspectable = $st.ok; Sentinel = $false; Tilde = $st.tilde })
    }
    [void]$t.Clear(); [void]$a.Clear()
    $st.has = $false; $st.ok = $true; $st.bare = $true; $st.tilde = $false
  }
  $endUnit = {
    . $endWord
    if ($words.Count) { [void]$units.Add($words); $words = New-Object System.Collections.ArrayList }
  }
  $pushFrame = {
    . $endWord
    [void]$words.Add([pscustomobject]@{ Text = $st.sent; Alt = $st.sent; Inspectable = $false; Sentinel = $true })
    [void]$stack.Add([pscustomobject]@{ Words = $words; Kind = $st.kind })
    $words = New-Object System.Collections.ArrayList
  }
  $popFrame = {
    . $endUnit
    if ($stack.Count) { $top = $stack[$stack.Count - 1]; $stack.RemoveAt($stack.Count - 1); $words = $top.Words }
  }
  $n = $Text.Length
  $i = 0
  while ($i -lt $n) {
    $c = [string]$Text[$i]
    if ($c -eq '@' -and ($i + 2) -lt $n -and ($Text[$i + 1] -eq [char]39 -or $Text[$i + 1] -eq [char]34)) {
      $m = [regex]::Match($Text.Substring($i), '^@([''"])\r?\n([\s\S]*?)\r?\n\1@')
      if ($m.Success) {
        $hb = $m.Groups[2].Value
        [void]$t.Append($hb); [void]$a.Append($hb)
        $st.has = $true; $st.bare = $false
        if ($m.Groups[1].Value -eq '"' -and $hb -match '\$[A-Za-z0-9_{(@*#?!$-]|`') { $st.ok = $false }
        $i += $m.Length
        continue
      }
    }
    if ($c -eq ' ' -or $c -eq "`t" -or $c -eq "`r") { . $endWord; $i++ }
    elseif ($c -eq "`n" -or $c -eq ';') { . $endUnit; $i++ }
    elseif ($c -eq '&') { . $endUnit; if (($i + 1) -lt $n -and $Text[$i + 1] -eq [char]38) { $i += 2 } else { $i++ } }
    elseif ($c -eq '|') { . $endUnit; if (($i + 1) -lt $n -and $Text[$i + 1] -eq [char]124) { $i += 2 } else { $i++ } }
    elseif ($c -eq '#' -and -not $st.has) {
      while ($i -lt $n -and $Text[$i] -ne [char]10) { $i++ }
    }
    elseif ($c -eq '<' -and $ps -and -not $st.has -and ($i + 1) -lt $n -and $Text[$i + 1] -eq [char]35) {
      $close = $Text.IndexOf('#>', $i + 2)
      if ($close -lt 0) { $i = $n } else { $i = $close + 2 }
    }
    elseif ($c -eq '{' -and -not $st.has -and ($ps -or ($i + 1) -ge $n -or [char]::IsWhiteSpace($Text[$i + 1]))) {
      # A script block (PowerShell) or a group / function body (Bash): its commands are units of their own.
      $st.sent = '{'; $st.kind = 'brace'; . $pushFrame; $i++
    }
    elseif ($c -eq '}' -and -not $st.has) {
      if ($stack.Count -and $stack[$stack.Count - 1].Kind -eq 'brace') { . $popFrame } else { . $endUnit }
      $i++
    }
    elseif ($c -eq '(') {
      $st.sent = '('
      # Bash process substitution <( ) / >( ): the < or > is not a word of its own.
      if (-not $ps -and $st.has -and ($t.ToString() -eq '<' -or $t.ToString() -eq '>')) { $st.sent = $t.ToString() + '('; [void]$t.Clear(); [void]$a.Clear(); $st.has = $false }
      $st.kind = 'paren'; . $pushFrame; $i++
    }
    elseif ($c -eq ')') {
      if ($stack.Count -and $stack[$stack.Count - 1].Kind -eq 'paren') { . $popFrame } else { . $endUnit }
      $i++
    }
    elseif ($c -eq '`' -and -not $ps) {
      if ($stack.Count -and $stack[$stack.Count - 1].Kind -eq 'bt') { . $popFrame } else { $st.sent = '`'; $st.kind = 'bt'; . $pushFrame }
      $i++
    }
    elseif ($c -eq "'") {
      $i++
      while ($i -lt $n) {
        $d = [string]$Text[$i]
        if ($d -eq "'") {
          if ($ps -and ($i + 1) -lt $n -and $Text[$i + 1] -eq [char]39) { [void]$t.Append("'"); [void]$a.Append("'"); $i += 2; continue }
          break
        }
        [void]$t.Append($d); [void]$a.Append($d); $i++
      }
      $i++
      $st.has = $true; $st.bare = $false
    }
    elseif ($c -eq '"') {
      $i++
      while ($i -lt $n) {
        $d = [string]$Text[$i]
        if ($ps) {
          if ($d -eq '`') {
            if (($i + 1) -lt $n) { $e = Get-PsEscape ([string]$Text[$i + 1]); [void]$t.Append($e); [void]$a.Append($e) }
            $i += 2; continue
          }
          if ($d -eq '"') {
            if (($i + 1) -lt $n -and $Text[$i + 1] -eq [char]34) { [void]$t.Append('"'); [void]$a.Append('"'); $i += 2; continue }
            break
          }
        } else {
          if ($d -eq '\') {
            $nx = ''
            if (($i + 1) -lt $n) { $nx = [string]$Text[$i + 1] }
            if ($nx -ne '' -and '"\$`'.Contains($nx)) { [void]$t.Append($nx); [void]$a.Append($nx); $i += 2; continue }
            if ($nx -eq "`n") { $i += 2; continue }
            if ($nx -eq "`r" -and ($i + 2) -lt $n -and $Text[$i + 2] -eq [char]10) { $i += 3; continue }
          } elseif ($d -eq '"') { break }
          elseif ($d -eq '`') { $st.ok = $false }
        }
        if ($d -eq '$') {
          $nx = ''
          if (($i + 1) -lt $n) { $nx = [string]$Text[$i + 1] }
          if ($nx -match $expRx) { $st.ok = $false }
          # "$(gh ...)": a gh call inside a double-quoted substitution is a unit of its own (the tail after the
          # $( is over-read, which is harmless).
          if ($nx -eq '(') {
            $tail = $Text.Substring($i + 2)
            if ($tail -match $ghRx) { foreach ($su in (Read-ShellUnits $tail $Tool)) { [void]$extra.Add($su) } }
          }
        }
        [void]$t.Append($d); [void]$a.Append($d); $i++
      }
      $i++
      $st.has = $true; $st.bare = $false
    }
    elseif ($c -eq '\' -and -not $ps) {
      if (($i + 1) -lt $n) {
        $e = [string]$Text[$i + 1]
        if ($e -eq "`n") { $i += 2; continue }
        if ($e -eq "`r" -and ($i + 2) -lt $n -and $Text[$i + 2] -eq [char]10) { $i += 3; continue }
        [void]$t.Append($e)
        if ($e -match '[\s"''\\]') { [void]$a.Append($e) } else { [void]$a.Append('\' + $e) }
        $st.has = $true; $st.bare = $false
      }
      $i += 2
    }
    elseif ($c -eq '`' -and $ps) {
      if (($i + 1) -lt $n) {
        $e = [string]$Text[$i + 1]
        if ($e -eq "`n") { $i += 2; continue }
        if ($e -eq "`r") { $i += 2; if ($i -lt $n -and $Text[$i] -eq [char]10) { $i++ }; continue }
        $e = Get-PsEscape $e
        [void]$t.Append($e); [void]$a.Append($e); $st.has = $true; $st.bare = $false
      }
      $i += 2
    }
    elseif ($c -eq '$') {
      $nx = ''
      if (($i + 1) -lt $n) { $nx = [string]$Text[$i + 1] }
      if ($nx -eq '(') { $st.sent = '$('; $st.kind = 'paren'; . $pushFrame; $i += 2 }
      else {
        if ($nx -match $expRx -or (-not $ps -and ($nx -eq "'" -or $nx -eq '"'))) { $st.ok = $false }
        [void]$t.Append('$'); [void]$a.Append('$'); $st.has = $true
        $i++
      }
    }
    else {
      # Bash expands an unquoted brace list, glob or ~ before gh sees it: -b {Approved,} posts "Approved".
      if (-not $ps) {
        if ($c -eq '*' -or $c -eq '?' -or $c -eq '[' -or $c -eq '{') { $st.ok = $false }
        elseif ($c -eq '~' -and -not $st.has) { $st.tilde = $true }
      }
      [void]$t.Append($c); [void]$a.Append($c); $st.has = $true
      $i++
    }
  }
  while ($stack.Count) { . $popFrame }
  . $endUnit
  foreach ($su in $extra) { [void]$units.Add($su) }
  return , $units
}

# gh api field flags (-f -F --field --raw-field, = or attached or next word) and --input, as entries
# { Name; Value; Word; Typed; InputFlag }. Name is the part before = (null when the word has none).
function Get-ApiFields {
  param($ArgList, [int]$Start)
  $out = New-Object System.Collections.ArrayList
  for ($x = $Start; $x -lt $ArgList.Count; $x++) {
    $aw = $ArgList[$x]; $tx = $aw.Text
    if ($tx -ceq '--input' -or $tx -cmatch '^--input=') {
      [void]$out.Add([pscustomobject]@{ Name = $null; Value = ''; Word = $aw; Typed = $false; InputFlag = $true })
      continue
    }
    $typed = $false; $val = $null; $vw = $null
    if ($tx -cmatch '^(-f|-F|--raw-field|--field)$') {
      $typed = ($tx -ceq '-F' -or $tx -ceq '--field')
      if (($x + 1) -lt $ArgList.Count) { $x++; $vw = $ArgList[$x]; $val = $vw.Text }
    } elseif ($tx -cmatch '(?s)^(--raw-field|--field)=(.*)$') { $typed = ($Matches[1] -ceq '--field'); $val = $Matches[2]; $vw = $aw }
    elseif ($tx -cmatch '(?s)^(-f|-F)=?(.+)$') { $typed = ($Matches[1] -ceq '-F'); $val = $Matches[2]; $vw = $aw }
    if ($null -eq $vw) { continue }
    $name = $null; $v = $val
    if ($val -match '(?s)^([\w\[\].-]+)=(.*)$') { $name = $Matches[1]; $v = $Matches[2] }
    [void]$out.Add([pscustomobject]@{ Name = $name; Value = $v; Word = $vw; Typed = $typed; InputFlag = $false })
  }
  return , $out
}

# --- rule set 2: no session posts an Approval (every fleet role, sub-agents included) ---
if ($tool -in @('Bash', 'PowerShell')) {
  $cmd = "$($inp.tool_input.command)"
  # fleet#70: the rule reads the command being INVOKED, never prose that quotes one.
  # Bash heredoc bodies (a ticket written with cat, a fixture, documentation) are
  # dropped first. Then Read-ShellUnits (fleet#229, a quote-aware tokenizer for the
  # tool's own quoting) cuts the call into units on an unquoted newline ; & && | ||
  # and around ( ) $( and Bash backticks WITHOUT a metacharacter inside a quoted body
  # ever ending the body early, and reads each unit as words. Only a unit whose command
  # word is gh (after VAR=value, `$x =` and [type] prefixes and the timeout / env /
  # command / exec / nohup / time / nice / winpty / xargs wrappers, a path or .exe read
  # as gh) and whose subcommand is issue|pr comment, or api on a comments endpoint, is a
  # comment; its body and body-file arguments are read from the words in every spelling
  # gh accepts (-b, --body, --body=V, -b=V, -bV, --body-file, -F, = forms, gh api
  # -f/-F/--field/--raw-field body=V and body=@file). A `gh issue create -b "run gh
  # issue comment ..."` is not a comment, and neither is a heredoc line that says so,
  # while `-b "Approved (batch 41)"` is still the whole body it always was. A body the
  # guard cannot read (stdin, a command substitution, a variable, a splat, --input, a
  # GraphQL comment mutation or query it cannot read, a file it cannot open) is refused
  # on its own terms, never cleared.
  $stripped = [regex]::Replace($cmd, '<<-?\s*(["'']?)(\w+)\1[^\r\n]*\r?\n[\s\S]*?\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)', '#heredoc-stripped')
  $units = Read-ShellUnits $stripped $tool
  $mutationRx = '\b(?:add|update)\w*Comment|addPullRequestReview'
  for ($u = 0; $u -lt $units.Count; $u++) {
    if ($reason) { break }
    $w = @($units[$u])
    $k = 0
    while ($k -lt $w.Count -and ($w[$k].Sentinel -or $w[$k].Text -match '^[{!]+$')) { $k++ }
    if ($k -ge $w.Count) { continue }
    $w[$k] = [pscustomobject]@{ Text = ($w[$k].Text -replace '^[{!]+', ''); Alt = $w[$k].Alt; Inspectable = $w[$k].Inspectable; Sentinel = $false }
    $g = -1
    $j = $k
    while ($j -lt $w.Count) {
      $tx = $w[$j].Text
      if ($w[$j].Sentinel) { break }
      if ($tx -match '^[A-Za-z_]\w*=') { $j++; continue }
      if ($tool -eq 'PowerShell' -and $tx -match '^\$[\w:]+$' -and ($j + 1) -lt $w.Count -and $w[$j + 1].Text -match '^[+*/-]?=$') { $j += 2; continue }
      if ($tool -eq 'PowerShell' -and $tx -match '^\[[\w.,\[\]]+\]$') { $j++; continue }
      if ($tx -cmatch '^(if|then|else|elif|do|while|until)$') { $j++; continue }
      $nm = ($tx -replace '^.*[\\/]', '') -replace '\.exe$', ''
      if ($nm -eq 'timeout') {
        $j++
        while ($j -lt $w.Count -and $w[$j].Text -match '^-') { if ($w[$j].Text -cmatch '^(-k|-s|--kill-after|--signal)$') { $j++ }; $j++ }
        if ($j -lt $w.Count -and $w[$j].Text -match '^\d') { $j++ }
        continue
      }
      if ($nm -eq 'env') {
        $j++
        while ($j -lt $w.Count -and $w[$j].Text -match '^(-|[A-Za-z_]\w*=)') {
          $ot = $w[$j].Text
          if ($ot -ceq '-S' -or $ot -ceq '--split-string') {
            # env -S "gh issue comment ..." : the string is a command line of its own.
            if (($j + 1) -lt $w.Count) { foreach ($su in (Read-ShellUnits $w[$j + 1].Text $tool)) { [void]$units.Add($su) } }
            $j++
          } elseif ($ot -cmatch '^-S(.+)$') { foreach ($su in (Read-ShellUnits $Matches[1] $tool)) { [void]$units.Add($su) } }
          elseif ($ot -cmatch '^(-u|--unset|-C|--chdir)$') { $j++ }
          $j++
        }
        continue
      }
      if ($nm -eq 'nice') {
        $j++
        while ($j -lt $w.Count -and $w[$j].Text -match '^-') { if ($w[$j].Text -cmatch '^(-n|--adjustment)$') { $j++ }; $j++ }
        continue
      }
      if ($nm -eq 'xargs') {
        $j++
        while ($j -lt $w.Count -and $w[$j].Text -match '^-') { if ($w[$j].Text -cmatch '^(-I|-n|-P|-L|-s|-d|-E|-a|-l|-i)$') { $j++ }; $j++ }
        continue
      }
      if ($nm -eq 'time') {
        $j++
        while ($j -lt $w.Count -and $w[$j].Text -match '^-') { if ($w[$j].Text -cmatch '^(-f|-o|--format|--output)$') { $j++ }; $j++ }
        continue
      }
      if ($nm -eq 'command' -or $nm -eq 'exec' -or $nm -eq 'nohup' -or $nm -eq 'winpty') {
        $j++
        while ($j -lt $w.Count -and $w[$j].Text -match '^-') { $j++ }
        continue
      }
      if ($nm -eq 'gh') { $g = $j }
      break
    }
    if ($g -lt 0) { continue }
    $args_ = @()
    if (($g + 1) -lt $w.Count) { $args_ = @($w[($g + 1)..($w.Count - 1)]) }
    if ($args_.Count -eq 0) { continue }
    if ($tool -eq 'PowerShell') {
      foreach ($aw in $args_) { if ($aw.Text -ceq '--%') { $reason = Get-UninspectableReason 'a PowerShell stop-parsing (--%) argument list'; break } }
      if ($reason) { break }
    }
    if (-not $args_[0].Inspectable) { $reason = Get-UninspectableReason (Get-WordCause $args_[0]); break }
    $sub = $args_[0].Text
    $kind = ''
    $ai = 1
    $epUnins = $null
    if ($sub -eq 'issue' -or $sub -eq 'pr') {
      if ($args_.Count -ge 2 -and -not $args_[1].Inspectable) { $reason = Get-UninspectableReason (Get-WordCause $args_[1]); break }
      if ($args_.Count -ge 2 -and $args_[1].Text -eq 'comment') { $kind = 'cmt'; $ai = 2 }
    } elseif ($sub -eq 'api') {
      $graphql = $false; $endpoint = $false; $epWord = $null; $epSeen = $false
      $valueFlags = '^(-f|-F|-H|-X|-q|-t|-p|--field|--raw-field|--header|--method|--jq|--template|--hostname|--cache|--preview|--input)$'
      for ($x = 1; $x -lt $args_.Count; $x++) {
        $tx = $args_[$x].Text
        if ($tx -cmatch $valueFlags) { $x++; continue }
        if ($tx -match '^-') { continue }
        if ($tx -ceq 'graphql') { $graphql = $true; $epSeen = $true; continue }
        if (-not $epSeen) { $epSeen = $true; $epWord = $args_[$x] }
        if ($tx -notmatch '^\w+=' -and $tx -notmatch '\s' -and $tx -match '\bcomments\b') { $endpoint = $true }
      }
      $fields = Get-ApiFields $args_ 1
      if ($graphql) {
        # Only a mutation that adds or edits a comment is a comment; addSubIssue and the like pass.
        foreach ($aw in $args_) { if ($aw.Text -match $mutationRx) { $reason = Get-UninspectableReason 'a GraphQL mutation'; break } }
        if (-not $reason) {
          foreach ($f in $fields) {
            if ($f.InputFlag) { $reason = Get-UninspectableReason 'a JSON body passed through --input'; break }
            if ($f.Name -ceq 'query') {
              if (-not $f.Word.Inspectable) { $reason = Get-UninspectableReason 'a GraphQL query this guard cannot read'; break }
              if ($f.Typed -and $f.Value.StartsWith('@')) {
                $qf = Read-GuardFile $f.Value.Substring(1) $f.Word $tool "$($inp.cwd)"
                if (-not $qf.Opened) { $reason = Get-UninspectableReason "in a file this guard could not open ($($qf.Shown))"; break }
                if ($qf.Text -match $mutationRx) { $reason = Get-UninspectableReason 'a GraphQL mutation'; break }
              }
            }
          }
        }
        continue
      }
      if ($endpoint -or ($null -ne $epWord -and -not $epWord.Inspectable)) { $kind = 'api' }
      if ($null -ne $epWord -and -not $epWord.Inspectable) { $epUnins = $epWord }
    }
    if (-not $kind) { continue }
    for ($x = $ai; $x -lt $args_.Count; $x++) { if (-not $args_[$x].Inspectable -and $args_[$x].Text -match '^@\w+$') { $reason = Get-UninspectableReason 'a splat'; break } }
    if ($reason) { break }
    # Arg walk: each hit is a literal body or a body file, with the word that carries it.
    # A flag spelled inside a quoted body is that body's text: the value word is consumed whole.
    $bodies = @()
    $hits = @()
    if ($kind -eq 'cmt') {
      for ($x = $ai; $x -lt $args_.Count; $x++) {
        $aw = $args_[$x]; $tx = $aw.Text
        $val = $null; $valWord = $null; $isFile = $false
        if ($tx -ceq '-b' -or $tx -ceq '--body' -or $tx -ceq '-F' -or $tx -ceq '--body-file') {
          $isFile = ($tx -ceq '-F' -or $tx -ceq '--body-file')
          if (($x + 1) -lt $args_.Count) { $x++; $valWord = $args_[$x]; $val = $valWord.Text }
        } elseif ($tx -cmatch '(?s)^--body=(.*)$') { $val = $Matches[1]; $valWord = $aw }
        elseif ($tx -cmatch '(?s)^--body-file=(.*)$') { $val = $Matches[1]; $valWord = $aw; $isFile = $true }
        elseif ($tx -cmatch '(?s)^-b=?(.+)$') { $val = $Matches[1]; $valWord = $aw }
        elseif ($tx -cmatch '(?s)^-F=?(.+)$') { $val = $Matches[1]; $valWord = $aw; $isFile = $true }
        if ($null -ne $valWord) { $hits += , @($val, $valWord, $isFile) }
      }
    } else {
      foreach ($f in $fields) {
        if ($f.InputFlag) { $reason = Get-UninspectableReason 'a JSON body passed through --input'; break }
        if ($f.Name -ceq 'body') {
          if ($f.Typed -and $f.Value.StartsWith('@')) { $hits += , @($f.Value.Substring(1), $f.Word, $true) } else { $hits += , @($f.Value, $f.Word, $false) }
        } elseif (-not $f.Word.Inspectable -and $null -eq $f.Name) {
          $reason = Get-UninspectableReason (Get-WordCause $f.Word); break
        }
      }
      # A body field on a call whose endpoint the guard cannot read may be a comment's.
      if (-not $reason -and $hits.Count -gt 0 -and $null -ne $epUnins) { $reason = Get-UninspectableReason (Get-WordCause $epUnins) }
    }
    if ($reason) { break }
    foreach ($hit in $hits) {
      $val = $hit[0]; $valWord = $hit[1]
      if (-not $valWord.Inspectable) { $reason = Get-UninspectableReason (Get-WordCause $valWord); break }
      if (-not $hit[2]) {
        if ($valWord.Tilde) { $reason = Get-UninspectableReason 'a shell variable or expression'; break }
        $bodies += $val; continue
      }
      if ($val -eq '-') { $reason = Get-UninspectableReason 'passed on stdin (--body-file - / -F - / body=@-)'; break }
      $bf = Read-GuardFile $val $valWord $tool "$($inp.cwd)"
      if (-not $bf.Opened) { $reason = Get-UninspectableReason "in a file this guard could not open ($($bf.Shown))"; break }
      $bodies += ($bf.Text -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1)
    }
    if ($reason) { break }
    foreach ($body in $bodies) {
      # \uFEFF: JS \s admits a BOM and .NET \s does not, so the two locks must agree. The escape is a
      # regex escape on purpose: this file is BOM-less ASCII and Windows PowerShell 5.1 reads it in the
      # ANSI code page, so a literal U+FEFF here would become three other characters.
      if ("$body" -match '^(?:\s|\uFEFF|\\n)*approved\b') {
        $reason = "a comment that begins 'Approved' is the tenant owner's Approval of a Triage proposal (CONTEXT.md **Approval**) and no fleet session may post one under any role: an Approval is the owner's alone, bin/triage.js recognises it by shape and author, and this guard is the second lock. Say what you mean in other words ('the lead agrees', 'ruled: ...') or leave the decision to Cory $cite"
        break
      }
      if ("$body" -match '^(?:\s|\uFEFF|\\n)*re-?propose\b') {
        $reason = "a comment that begins 'Re-propose' is the tenant owner's ask for a new Triage proposal and no fleet session may post one under any role (fleet#55): a re-proposal ask is the owner's alone, bin/triage.js recognises it by shape and author, and this guard is the second lock. Say what you mean in other words ('the scope changed; the Principal should look again') or leave the ask to Cory $cite"
        break
      }
      # fleet#208: matched exactly like Approved (case-insensitive, leading whitespace or a literal \n skipped, first word only).
      if ("$body" -match '^(?:\s|\uFEFF|\\n)*veto\b') {
        $reason = "a comment that begins 'Veto' is the tenant owner's withdrawal of a Bounded-authority ready (CONTEXT.md **Veto**) and no fleet session may post one under any role: a Veto is the owner's alone, bin/triage.js recognises it by shape and author, and this guard is the second lock. Say what you mean in other words ('the lead is holding this ticket', 'this ready is wrong because ...') or leave the Veto to Cory $cite"
        break
      }
    }
  }
}

# --- rule 2b: the Bounded-authority flags and the triage ledger (every fleet role) ---
$flagsCause = "the Bounded-authority flags (state/flags/bounded-authority-*) are Cory's to create and remove, and the triage ledger (state/triage/) is written by node bin/triage.js, whose doors check what they record; say what you found in your status file instead $cite"
if (-not $reason -and $tool -in @('Edit', 'Write', 'NotebookEdit', 'MultiEdit')) {
  $t2 = "$($inp.tool_input.file_path)"; if (-not $t2) { $t2 = "$($inp.tool_input.notebook_path)" }
  $t2N = Normalize-Path $t2 "$($inp.cwd)"
  $homeN2 = Normalize-Path $home_ ''
  if ($t2N -match "^$(Escape-Rx $homeN2)/state/(flags|triage)[. ]*(:[^/]*)?(/|$)") { $reason = $flagsCause }
}
if (-not $reason -and $tool -in @('Bash', 'PowerShell')) {
  $cmd2 = "$($inp.tool_input.command)"
  # A heredoc fed to an interpreter is a script: its body is scanned as commands. Any other
  # heredoc (a ticket or a note written with cat) is text and is stripped.
  $scan = [regex]::Replace($cmd2, '(?m)^(?<pre>[^\r\n]*?)<<-?\s*(?<q>["'']?)(?<d>\w+)\k<q>(?<post>[^\r\n]*)\r?\n(?<body>[\s\S]*?)\r?\n[ \t]*\k<d>[ \t]*(?=\r?\n|$)',
    [System.Text.RegularExpressions.MatchEvaluator]{
      param($m)
      if ($m.Groups['pre'].Value -match '(?<![\w.-])(?:bash|sh|zsh|dash|node|nodejs|python\d*|powershell|pwsh|cmd)(?:\.exe)?(?![\w-])') { return $m.Groups['pre'].Value + ' ' + $m.Groups['post'].Value + "`n" + $m.Groups['body'].Value }
      return $m.Groups['pre'].Value + ' ' + $m.Groups['post'].Value + '#heredoc-stripped'
    })
  # Quotes are dropped and every run of separators (and ./ segments) becomes one /, so that
  # state//flags, state/./flags, state\flags, state/"flags" and 'state'/flags all read alike.
  $norm = (($scan -replace '\\\\\?\\', '') -replace '["'']', '') -replace '[\\/]+(\.[\\/]+)*', '/'
  $stateRx = '(?<![\w-])state/(?:flags|triage)(?![\w.-])|(?<![\w-])state/[^\s/]*[*?\[]|(?<![\w-])bounded-(?:authority-|a[\w-]*[*?\[])'
  $readOnlyWords = @('cat', 'ls', 'dir', 'type', 'head', 'tail', 'Get-Content', 'Get-ChildItem', 'Test-Path', 'Get-Item',
    'grep', 'wc', 'cut', 'findstr', 'Select-Object', 'Where-Object', 'Sort-Object', 'Measure-Object', 'Select-String')
  # cd/Push-Location into state, in a call that also names flags or triage: the relative rm that follows is unseen.
  if (($norm -match '(?:^|[\s;&|(])(?:cd|chdir|pushd|Push-Location|Set-Location|sl)\s+\S*(?<![\w-])state/?(?=\s|;|&|\||$)') -and ($norm -match '(?<![\w-])(?:flags|triage)(?![\w-])')) { $reason = $flagsCause }
  if (-not $reason) {
    $pinned = Normalize-Path "$home_/bin/triage.js" ''
    foreach ($unit in [regex]::Split($norm, '\r?\n|;|&&|\|\||&')) {
      $git = ($unit -match 'git(?:\s+-[Cc]\s+\S+|\s+--?\S+)*\s+(?:clean|checkout|restore|reset|rm|mv|stash)\b') -and ($unit -match '(?<![\w-])state(?:/|\s|$)')
      if (-not ($git -or ($unit -match $stateRx))) { continue }
      # Plain or refused: a subexpression, a script block or a backtick makes the unit something this rule cannot read.
      $bad = $git -or ($unit -match '[(){}`]') -or ($unit -match ('>\s*\S*(?:' + $stateRx + ')'))
      if (-not $bad) {
        foreach ($stage in ($unit -split '\|')) {
          if ($stage -match '^\s*$') { continue }
          $word = ''
          if ($stage -match '^\s*(?:\w+=\S*\s+)*(?<w>\S+)') { $word = ([IO.Path]::GetFileName("$($Matches['w'])")) -replace '\.exe$', '' }
          if ($word -eq 'node') {
            $script = ''
            if ($stage -match '^\s*\S+\s+(?<s>\S+)') { $script = $Matches['s'] }
            if ((Normalize-Path $script "$($inp.cwd)") -ne $pinned) { $bad = $true; break }
            continue
          }
          if ($readOnlyWords -notcontains $word) { $bad = $true; break }
        }
      }
      if ($bad) { $reason = $flagsCause; break }
    }
  }
}

# --- rule set 1: the Principal's write and action boundary ---
if (-not $reason -and $role -eq 'principal') {
  $repo = ''
  try { if ($tenant) { $repo = (Get-Content "$home_\tenants\$tenant.json" -Raw -Encoding UTF8 | ConvertFrom-Json).repo } } catch {}
  $repoN = Normalize-Path $repo ''
  $homeN = Normalize-Path $home_ ''
  $profileN = Normalize-Path $env:USERPROFILE ''
  $tempN = Normalize-Path ([IO.Path]::GetTempPath()) ''
  # Inside the tenant repo or the fleet only the named files are writable; the
  # memory and temp allowances apply only OUTSIDE both (a repo that happens to live
  # under the temp directory, as the test fixture does, gets no blanket pass).
  $insideRules = @()
  if ($repoN) {
    $insideRules += "^$(Escape-Rx $repoN)/(\.claude/worktrees/[^/]+/)?docs/adr/[^/]+\.md$"
    $insideRules += "^$(Escape-Rx $repoN)/(\.claude/worktrees/[^/]+/)?context\.md$"
  }
  $insideRules += "^$(Escape-Rx $homeN)/docs/adr/[^/]+\.md$"
  $insideRules += "^$(Escape-Rx $homeN)/context\.md$"
  if ($tenant) { $insideRules += "^$(Escape-Rx $homeN)/state/status/pe-$(Escape-Rx $tenant.ToLowerInvariant())\.md$" }
  $outsideRules = @()
  if ($profileN) { $outsideRules += "^$(Escape-Rx $profileN)/\.claude/" }
  if ($tempN) { $outsideRules += "^$(Escape-Rx $tempN)/" }

  if ($tool -in @('Edit', 'Write', 'NotebookEdit', 'MultiEdit')) {
    $target = "$($inp.tool_input.file_path)"; if (-not $target) { $target = "$($inp.tool_input.notebook_path)" }
    $targetN = Normalize-Path $target "$($inp.cwd)"
    $inside = ($repoN -and $targetN.StartsWith("$repoN/")) -or $targetN.StartsWith("$homeN/")
    $ok = $false
    # Its own memory first (user-scope, ~/.claude): never inside a repo or the fleet by layout.
    if ($profileN -and $targetN -match "^$(Escape-Rx $profileN)/\.claude/") { $ok = $true }
    $allowed = if ($inside) { $insideRules } else { $outsideRules }
    foreach ($rx in $allowed) { if ($ok) { break }; if ($targetN -match $rx) { $ok = $true; break } }
    if (-not $ok) {
      $reason = "the Principal writes only ADR and glossary proposals (docs/adr/*.md, CONTEXT.md in the tenant repo or the fleet), its own status file (state/status/pe-<tenant>.md) and its own memory (the triage ledger is written through bin/triage.js only); '$target' is none of those. Product code is an IC's: put the change in the proposal's Scope and Red-tell for the IC $cite"
    }
  } elseif ($tool -in @('Bash', 'PowerShell')) {
    $cmd = "$($inp.tool_input.command)"
    $flat = $cmd -replace '\s+', ' '
    # A test run is "bare" when no argument after the runner names a file (a path
    # separator or a .js/.ts extension); flags alone do not narrow a suite.
    $bareRunner = $null
    foreach ($runner in @(
      @{ re = '(^|[\s;&|(])npm\s+(test|t|run\s+test(:server)?)\b(?<rest>[^;&|]*)';  what = 'the bare test suite (npm test with no file)' },
      @{ re = '(^|[\s;&|(])npx\s+jest\b(?<rest>[^;&|]*)';                           what = 'the bare jest suite (npx jest with no path)' },
      @{ re = '(^|[\s;&|(])node\s+--test\b(?<rest>[^;&|]*)';                        what = 'the bare node test runner (node --test with no file)' }
    )) {
      if ($flat -match $runner.re) {
        $rest = "$($Matches['rest'])"
        $namesFile = $false
        foreach ($token in ($rest -split '\s+' | Where-Object { $_ -and $_ -ne '--' })) { if ($token -match '[/\\]' -or $token -match '\.[jt]sx?$') { $namesFile = $true; break } }
        if (-not $namesFile) { $bareRunner = $runner.what; break }
      }
    }
    $rules = @(
      @{ re = '(^|[\s;&|(])npm\s+(run\s+)?test:server:(all|sweep)\b';                                             what = 'the long server suite (test:server:all / :sweep, 35 to 42 minutes)' },
      @{ re = '(^|[\s;&|(])(node|npm\s+run|npx)\s+\S*sync-[a-z]';                                                what = 'a sync-* script (production data, API quota)' },
      @{ re = '(^|[\s;&|(])gh\s+issue\s+(close|delete|reopen)\b';                                                 what = 'closing, deleting or reopening an issue' },
      @{ re = '(^|[\s;&|(])gh\s+pr\s+(merge|close)\b';                                                            what = 'merging or closing a pull request' },
      @{ re = '(^|[\s;&|(])gh\s+(issue|pr)\s+edit\b.*--(add|remove)-label\s+\S*\b(wontfix|duplicate)\b';          what = 'the wontfix or duplicate label (a verdict, never the Principal''s)' },
      @{ re = '(^|[\s;&|(])gh\s+issue\s+edit\b.*--add-label\s+\S*\b(ready-for-agent|ready-for-human|needs-info)\b'; what = $null; approvalGated = $true },
      @{ re = '(^|[\s;&|(])git\s+push\b(?![^;&|]*\bdocs/)';                                                       what = 'a git push to a branch outside docs/ (the Principal opens docs PRs only)' }
    )
    if ($bareRunner) { $reason = "$bareRunner is outside the Principal's boundary: it may run ONE named test file (npm test -- <path>, node --test <file>) to confirm a red-tell and write everything else into the proposal's Repro: line for the IC; closing, merging, wontfix and duplicate are Cory's $cite" }
    foreach ($r in $rules) {
      if ($reason) { break }
      if ($r.approvalGated) { continue }   # routing labels are allowed here; the Approval that permits them is checked by the Principal against the ledger (triage.js record refuses a finalize with no approval)
      if ($flat -match $r.re) {
        $reason = "$($r.what) is outside the Principal's boundary: it may run ONE named test file (npm test -- <path>, node --test <file>) to confirm a red-tell and write everything else into the proposal's Repro: line for the IC; closing, merging, wontfix and duplicate are Cory's $cite"
        break
      }
    }
  } elseif ($tool -like 'mcp__claude_ai_Supabase__*' -or $tool -like 'mcp__claude_ai_Netlify__*updater*' -or $tool -like 'mcp__claude_ai_Netlify__*deploy*' -or $tool -like 'mcp__claude_ai_Netlify__import*') {
    $reason = "'$tool' reaches production data or a deploy; the Principal reads code and tickets, never the shared Supabase database or Netlify. Name the query or check in the proposal's Repro: line for the IC $cite"
  }
}

if (-not $reason) { exit 0 }
$out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } }
[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 4))
exit 0
