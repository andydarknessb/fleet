# Deny production-database MCP tools to fleet sessions

Status: ready-for-agent
Blocked by: none

## Problem

The Supabase MCP server is connected at account level, so every fleet session holds `execute_sql`, `apply_migration`, `deploy_edge_function` and the project-level operations against the production project. `fleet-settings.json`'s `soft_deny` and every session's settings say nothing about Supabase, SQL or MCP; the tenant note forbidding migrations was written for the repo credential path. ic-142 ran a read-only query against production on 2026-08-22; it was reported plainly and harmless, and its "needed to see real data" justification turned out to be orientation rather than necessity, which is how the exception will be read every time.

## Ruling (recorded by Cory's session, 2026-08-22, so the ticket stands alone; Cory amends it here if the line should sit elsewhere)

- Write-capable Supabase tools are denied for every fleet role: `execute_sql`, `apply_migration`, `deploy_edge_function`, `pause_project`, `restore_project`, `create_project`, `create_branch`, `merge_branch`, `reset_branch`, `rebase_branch`, `delete_branch`.
- ICs, the dispatcher and the Sentinel have no production access at all: `execute_sql` (and any tool returning row or log data) is denied to them outright, reads included. Verification data an IC needs is expressed as a test or supplied by the project lead.
- The project lead alone may run read-only queries, only when a ticket's criterion cannot be expressed as a test, and every such query is quoted in the PR review comment.

## Acceptance criteria

- [ ] Research first, cited in `## Answer`: the exact tool names the MCP server exposes inside a fleet session (ToolSearch in a fleet session, or a session transcript; the observed prefix was `mcp__claude_ai_Supabase__`), and the Claude Code permission-rule syntax for MCP tools (`mcp__<server>__<tool>` under `permissions.deny`), from the official docs.
- [ ] `fleet-settings.json` gains `permissions.deny` entries for the write-capable tools listed above, using the exact observed names, applied to every role.
- [ ] `bin/launch.ps1` adds `execute_sql` (plus `get_logs` / `query_logs` / `get_advisors` if present) to `permissions.deny` in the generated per-session settings for roles `ic`, `dispatcher` and `sentinel`; `project-lead` keeps `execute_sql`. The `soft_deny` prose gains one matching line so the classifier and the hard deny agree.
- [ ] Verified and pasted into `## Answer`: a one-off `claude -p --settings <an ic settings file> "<ask for a Supabase query>"` is refused; the same with a project-lead settings file shows `execute_sql` still callable. Do not run a write in either check.
- [ ] `agents/ic.md`, `agents/project-lead.md` and `README.md` each carry the rule in one sentence; `tenants/endzone.json`'s database note says the restriction is enforced by settings, not only by instruction.
- [ ] `## Answer` lists which running sessions still carry old settings and whether `claude respawn` (which re-reads the regenerated per-session settings file) or a stop + `launch.ps1 -FromRoster` relaunch is needed for each, once verified.
