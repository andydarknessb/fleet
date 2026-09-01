# Fleet

The standing crew of Claude Code sessions that runs Cory's projects between prompts. Vocabulary lives in [CONTEXT.md](CONTEXT.md); decisions in [docs/adr](docs/adr). This file is the operating guide. Every fleet session reads it at start.

## Shape

```
cory
 └─ dispatcher (opus)      your interface; relays escalations; daily digest; watches the sentinel
 └─ sentinel   (sonnet)    keeps the roster alive and under the cap; never reasons about work
     └─ pl-<tenant> (sonnet)   one per tenant; turns ready issues into ICs; reviews and merges
         └─ ic-<issue> (sonnet) one per issue, launched with /implement; opens a PR; talks only to its project lead
             └─ qa-reviewer (opus worker)   optional third review angle (UI, house style), spawned by the project lead
```

- **Sessions** are background Claude Code sessions hosted by the daemon (`claude agents`). **Workers** are subagents inside a session. Cap counts sessions only.
- Reporting line: IC → project lead → dispatcher → Cory. The Sentinel reports to the dispatcher. Nobody skips a level.
- Work is a GitHub Issue carrying the tenant's `readyLabel`. Only Cory applies that label (that is your 35% interaction: you approve scope, not code).
- Carve-outs (migrations, deploy hooks, env, CI secrets; per tenant file) never merge without you.
- **Deploy gate.** A tenant may name a `releaseBranch` distinct from its `defaultBranch` (endzone: `integration` / `main`). The fleet branches from, targets, and merges into the default branch only. Promotion to the release branch (which auto-deploys the client) is yours: `git push origin integration:main` when you want a release. The Sentinel keeps the default branch fast-forwarded to the release branch after anything you merge directly (`bin/sync-integration.ps1`, pure fast-forward only; divergence escalates).

## Layout

| Path | What |
|---|---|
| `roster.json` | Static roster: the sessions that must always exist, the cap, their launch prompts. Cory edits. |
| `tenants/<name>.json` | One per tenant: repo, GitHub slug, labels, branch prefix, `maxIcs`, carve-outs, checks, notes ICs must obey. |
| `agents/*.md` | Role files. `~/.claude/agents` is a junction to this directory (`setup.ps1`), so `claude --agent <role>` finds them. Remove with `rmdir`, never `rm -r`. |
| `fleet-settings.json` | Applied to every fleet session via `--settings`: inbound messaging accepted, auto mode, fleet soft-denies, the two hooks. |
| `hooks/session-start.ps1` | Prints the session's identity, tenant, PAUSE state, and roster into its context. |
| `hooks/stop.ps1` | Every session: writes a heartbeat. Project leads: exits 2 (keep going) while there is actionable work: a non-draft `fleet/*` PR, or a **frontier** issue (ready label, no open blockers per GitHub issue dependencies via GraphQL `blockedBy`, not in `state/skip/<tenant>.json`, free cap + IC slot). |
| `state/skip/<tenant>.json` | The project lead's "not launchable, and why" list (`{ "issues": { "<n>": "reason" } }`). The hook honours it; you triage it. |
| `bin/launch.ps1` | **The only door.** Enforces PAUSE, cap, `maxIcs`, naming; writes per-session settings with `FLEET_*` env; records the session in `state/roster.json`. |
| `bin/sentinel-check.ps1` | The Sentinel's mechanical check; `-Apply` performs respawns, retirements, worktree sweeps, and rate-limit PAUSE. An IC waiting on an open PR or skip-list hold is never stale-heartbeat respawned. |
| `bin/retire.ps1` | Mark a finished IC as retiring before stopping it, remove its job/worktrees, and report verified remaining worktree state. |
| `bin/measure-cycle.js` | Read-only transcript/roster collector for daily JSON metrics and compact seven-day summaries; it never changes fleet decisions. |
| `bin/pause.ps1` | Fleet-wide kill switch. `-Off` clears. |
| `bin/status.ps1` | One-screen view. |
| `bin/recover.ps1` | Bring the roster back after a reboot. `install-recovery-task.ps1` registers it at logon. |
| `bin/pilot.ps1` | Launch sentinel, dispatcher, pl-endzone. `-DryRun` to check gates without starting anything. |
| `state/` | Runtime only, gitignored: live roster, heartbeats, escalations, per-session settings, status files, PAUSE. |
| `state/metrics/` | Generated measurement artifacts; cache-read tokens remain separate from fresh control-plane and IC tokens. |

The collector verifies candidate merges against GitHub by default. `--no-verify-github`
is reserved for deterministic fixture runs and must not be used for production baselines.

## Day to day

```powershell
# watch
powershell -File C:\Users\Cory\fleet\bin\status.ps1
claude agents                      # TUI: attach, peek, reply, pin (Ctrl+T pins a session so it is never idle-reaped)

# talk to the dispatcher
claude attach <job id>             # or from claude.ai/code / the mobile app: fleet sessions auto-connect to Remote Control

# stop everything launching (sessions finish their turn and idle)
powershell -File C:\Users\Cory\fleet\bin\pause.ps1 -Reason "going on holiday"
powershell -File C:\Users\Cory\fleet\bin\pause.ps1 -Off

# approve work
gh issue edit <n> --add-label ready-for-agent
```

Status files: `state/STATUS.md` (dispatcher's digest), `state/status/<tenant>.md` (each project lead), `state/escalations/*.json` (anything that needs you).

### Tenant check policy

Each tenant classifies known CI checks in exactly one list:

- `ciGates`: required checks whose pending state delays review and whose failure blocks merge.
- `watchedChecks`: non-gating checks. An executed failure is surfaced to the project lead as a finding; passing, pending, skipped, or missing watched checks never satisfy or block a gate.
- `ignoredChecks`: checks that have no fleet policy effect.

The lists must be disjoint. `setup.ps1` and the stop hook reject an overlapping policy. A check absent from all three lists is unclassified, not implicitly watched.

## Starting the pilot

1. `powershell -File C:\Users\Cory\fleet\bin\setup.ps1` (junction, state dirs, version and label checks). Idempotent.
2. `powershell -File C:\Users\Cory\fleet\bin\pilot.ps1 -DryRun`, then without `-DryRun`.
3. `claude agents`, pin dispatcher, sentinel, and pl-endzone with Ctrl+T.
4. Optional, survives reboot: `powershell -File C:\Users\Cory\fleet\bin\install-recovery-task.ps1`.

## Skills the roles use

The `mattpocock-skills` plugin is enabled at user scope, so every fleet session can invoke its model-invocable skills. The roles name the ones they rely on: ICs build with `/tdd`, review with `/code-review`, start bugs with `/diagnosing-bugs`, and untangle stale branches with `/resolving-merge-conflicts`; project leads review PRs with `/code-review` (its Standards + Spec sub-agents are the two review angles) and settle vocabulary with `/domain-modeling`; the dispatcher answers reading questions with `/research`. `/implement` is user-only, but a slash command at the head of a launch prompt counts as a user invocation in the new session (verified), so project leads launch ICs with `-Prompt "/mattpocock-skills:implement ..."` and the IC runs the real skill. `skills:` in a role file's frontmatter does **not** preload skill text into a `--agent` background session (verified, both spellings); skills are discovered from the listing and invoked on demand. `/triage`, `/to-spec`, `/to-tickets` and `/grill-with-docs` stay yours: they are scope decisions.

## Onboarding a tenant

0. In the tenant repo, run `/setup-matt-pocock-skills` yourself first (it is user-only). The skills read `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`; without them `/code-review` and friends have no tracker to talk to.
1. Copy `tenants/endzone.json` to `tenants/<name>.json` and fill it in. The repo needs the ready label and an escalation label.
2. Add a `pl-<name>` entry to `roster.json` (copy `pl-endzone`, change tenant, cwd, prompt).
3. `launch.ps1 -FromRoster pl-<name>` (or just wait: the Sentinel's next check reports it as `launchNeeded` and launches it).

## Things learned the hard way (verified 2026-08-22, Claude Code 2.1.239, Windows 11)

- **`claude --bg --resume <sessionId>` forks a new session id and drops the name.** Recovery uses `claude respawn <job id>`, which keeps both. `launch.ps1` refuses to start a name that is already running for this reason.
- **Background sessions see every peer in `ListAgents`; a desktop-app interactive session may not see them** (their inbox pipes live under `\\.\pipe\LOCAL\`). The fleet's internal messaging is unaffected. To reach a fleet session from your own session, use `claude attach`, the `claude agents` reply box, or Remote Control.
- **A background-to-background `SendMessage` wakes an idle recipient into a new turn.** That is how an IC's "PR ready" reaches a sleeping project lead.
- `claude rm <id>` also removes the session's worktree. `claude stop` does not.
- **Worktree isolation is lazy.** A background session starts in the repo's main checkout (reads only) and is moved into `<repo>/.claude/worktrees/<name>-<slug>` on a `worktree-*` branch the first time it writes. The main checkout is never dirtied. ICs then create their `fleet/<issue>-<slug>` branch inside that worktree. `claude rm` removes the worktree and its branch. The fleet never touches worktrees it didn't create; your hand-made `Endzone-Empire-*` worktrees are yours.
- **Hook commands run through a POSIX shell, even on Windows.** Backslashes in `fleet-settings.json` hook paths get eaten (`C:UsersCory...`). Use forward slashes: `-File C:/Users/Cory/fleet/hooks/stop.ps1`. PowerShell accepts them.
- `--settings <file>` on `claude --bg` applies the file's `env` block and `hooks`; that is how a session learns who it is (`FLEET_*`). `respawnFlags` in the job's `state.json` records the settings path, so `claude respawn` keeps the identity.
- Cron jobs inside a session expire after 7 days; the SessionStart hook reminds the Sentinel and dispatcher to recreate theirs.
- Max 5x: rate limiting is a first-class state. The Sentinel sets a 60-minute PAUSE when a fleet job reports one and clears it after the window.
