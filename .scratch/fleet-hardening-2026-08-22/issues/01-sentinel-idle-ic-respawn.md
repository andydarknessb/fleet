# Sentinel must not respawn an IC that is idle because its PR is held

Status: ready-for-agent
Blocked by: none

## Problem

`bin/sentinel-check.ps1`, in the `working` branch (around line 74):

```powershell
if ($null -ne $age -and $age -gt 120 -and "$($row.status)" -ne 'busy') { Do-Respawn $row $x "heartbeat stale ($([int]$age) min) while state=working"; continue }
```

The only conditions are "heartbeat older than 120 minutes" and "not busy". An IC that has pushed its PR and is waiting on review or on Cory's carve-out ruling satisfies both: the Stop hook writes a heartbeat per turn and a session with nothing to do takes no turns. ic-111 was respawned at ~23:24Z on 2026-08-22 for exactly this while PR #150 was held, and would have been respawned every two hours until the PR landed. The worktree survives, but the IC's context is lost and the log reads as if a working session hung.

## Ruling (Cory, 2026-08-22)

An IC with an open pull request is waiting by definition and is never respawned for a stale heartbeat. The reason string must state the real state.

## Acceptance criteria

- [ ] In the `working` branch, before the stale-heartbeat respawn, the check looks up whether the IC has an open PR on its tenant's repo whose head branch starts with `<branchPrefix><issue>-` (`gh pr list -R <github> --state open --search "head:<branchPrefix><issue>-" --json number,headRefName`, filtered on the prefix), and if so records the session under `ok` with a note (`waiting on PR #n`) instead of respawning.
- [ ] The same exemption applies when the IC's issue number appears under `issues`, or its PR under `prs`, in `state/skip/<tenant>.json`.
- [ ] The respawn reason string reports the actual daemon state and status (for example `heartbeat stale (135 min), state=working status=idle, no open PR`), not a hard-coded `state=working`.
- [ ] A `gh` failure in the lookup fails safe: no respawn; the session is listed under `escalate` with the error, never silently treated as "no PR".
- [ ] Verified without `-Apply` against the live fleet and pasted into `## Answer`: an IC with an open PR and a heartbeat older than 120 minutes is listed under `ok` with the PR number; a session with no PR and a stale heartbeat still shows under `respawn`.
- [ ] `README.md`'s Sentinel row and `agents/sentinel.md` say in one sentence that an IC with an open PR is never respawned for a stale heartbeat.
