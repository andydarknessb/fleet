# PreToolUse hook for fleet sessions (ADR 0010): the haiku `researcher` worker is the
# fleet's official fact-finder. A main-session Bash/PowerShell repo sweep, git history
# read, CI log read, or web fetch is refused with a pointer to the researcher; the same
# call from inside any sub-agent (hook input carries agent_id) passes, so the researcher
# itself and the risk reviewer are never gated. Rollback: state/flags/research-gate-off.
# Output contract: a deny is JSON on stdout with permissionDecision "deny"; anything
# else is silence + exit 0 (allow). Never exit nonzero: a broken gate must not block work.
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
$inp = $null
try { $inp = "$raw" | ConvertFrom-Json } catch {}
if (-not $inp) { exit 0 }
$home_ = $env:FLEET_HOME; $role = $env:FLEET_ROLE
if (-not $home_ -or -not $role) { exit 0 }                                   # not a fleet session
if ($role -notin @('ic', 'project-lead', 'dispatcher', 'principal')) { exit 0 } # sentinel runs scripts only; principal gated per ADR 0011
if (Test-Path "$home_\state\flags\research-gate-off") { exit 0 }
if ($inp.PSObject.Properties['agent_id'] -and "$($inp.agent_id)") { exit 0 } # inside a sub-agent: the researcher's own reads

$tool = "$($inp.tool_name)"
$reason = $null
if ($tool -in @('WebFetch', 'WebSearch')) {
  $reason = "web lookups are research: spawn the researcher (Agent tool, subagent_type: researcher, haiku) with the one question and the URL or search terms (ADR 0010; rollback flag state/flags/research-gate-off)"
} elseif ($tool -in @('Bash', 'PowerShell')) {
  $cmd = "$($inp.tool_input.command)" -replace '\s+', ' '
  $patterns = @(
    @{ re = '(^|[\s;&|(])rg\s';                                                            what = 'a ripgrep sweep' },
    @{ re = '(^|[\s;&|(])grep\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s|(\S+\s+)*--recursive\b)';       what = 'a recursive grep sweep' },
    @{ re = 'Select-String\b.*-Recurse|Get-ChildItem\b.*-Recurse\b.*Select-String';        what = 'a recursive Select-String sweep' },
    @{ re = '(^|[\s;&|(])git\s+(log|blame|shortlog)\b';                                    what = 'a git history read' },
    @{ re = '(^|[\s;&|(])gh\s+run\s+(view|list)\b|gh\s+api\s+\S*actions\S*(jobs|runs)';   what = 'a CI run or log read' },
    @{ re = '(^|[\s;&|(])(curl|wget)\s|Invoke-WebRequest\b|Invoke-RestMethod\b';           what = 'a web fetch' }
  )
  foreach ($p in $patterns) {
    if ($cmd -match $p.re) {
      $reason = "$($p.what) is research, not authoring: spawn the researcher (Agent tool, subagent_type: researcher, haiku) with the one question, e.g. 'where is X called' or 'what does CI job Y say', and act on its answer. Reading what was handed to you (your issue, manifest, PR, the files you are editing) stays yours (ADR 0010; rollback flag state/flags/research-gate-off)."
      break
    }
  }
}
if (-not $reason) { exit 0 }
$out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } }
[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 4))
exit 0
