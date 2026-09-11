---
status: accepted
---

# The haiku researcher is the official fact-finder

The 2026-09-10 ruling put a `researcher` worker (haiku, read-only) in the IC
and project-lead role files for documentation research and every non-coding
lookup. A transcript audit on 2026-09-11 showed the rule was written but not
followed: of 74 sub-agent dispatches by ICs and the project lead since the
ruling, 8 were researchers and none set haiku explicitly; ic-1200 read two
ADRs, six modules and ran four repo-wide `grep -r` call-site sweeps in its own
sonnet session before its one dispatch, an opus risk review. A rule that only
lives in prose competes with the session's habit of looking for itself, and
the habit wins.

## Decision

1. **The haiku `researcher` worker is the fleet's official researcher.** Any
   fact a session goes and finds comes back through it: documentation, how a
   thing works in the repo, where a thing is called or required, whether any
   reference to a name remains after a change, what a CI log, git history or
   comment thread says, anything on the web. Reading what was handed to the
   session (its issue, manifest, PR comments, wake message, the files it is
   editing) stays the session's own job. Authoring and judgment never delegate.
2. **The gate is mechanical.** `hooks/research-gate.ps1` runs as a PreToolUse
   hook in every fleet session (registered in `fleet-settings.json`, so it
   reaches every session through the one launch door) and refuses, for the
   `ic`, `project-lead` and `dispatcher` roles, a main-session `rg`, recursive
   `grep`, recursive `Select-String`, `git log`/`blame`/`shortlog`, `gh run
   view`/`list` or Actions log read, `curl`/`wget`/`Invoke-WebRequest`, and
   the WebFetch and WebSearch tools. The refusal text names the researcher and
   the shape of the question to hand it. Targeted reads and greps of the files
   a session is editing are not gated: the Grep, Glob and Read tools pass, and
   so does a non-recursive `grep` on a named file.
3. **Sub-agents are never gated.** The hook input carries `agent_id` only when
   the call comes from inside a sub-agent; the hook exits silently then. The
   researcher's own sweeps, the risk reviewer's reads and any future worker are
   untouched. The sentinel is not gated either: it runs scripts, never research.
4. **One sonnet re-dispatch, never opus.** A thin haiku answer is re-asked once
   with `model: sonnet` and the reason is written down (PR body for an IC,
   status file for a lead). A haiku researcher that wanders burns its 30 turns
   with nothing to report, so a large sweep is handed to it as one script to
   run, not as an open question.
5. **Rollback is a flag.** `state/flags/research-gate-off` disables the gate
   for every session at once; the session-start line reports whether the gate
   is on or off so a session never guesses. The role-file text stands either
   way.

## Consequences

- Fact-finding cost drops to the haiku tier and the session's own context
  stops filling with sweep output; the audit table in fleet #28's thread is the
  baseline to measure against.
- A session that hits the gate mid-flow loses one turn to the refusal. That is
  the price of making the rule real; the refusal text is written to make the
  next action obvious.
- The gate matches command text, so a sweep spelled in a way the patterns do
  not cover passes. The role-file rule still applies; the hook is the floor,
  not the whole rule. Extend the pattern list when a new spelling shows up in a
  transcript, and add a case to `tests/research-gate.tests.ps1`.
