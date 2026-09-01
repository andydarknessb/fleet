# Fleet

The standing crew of Claude Code sessions that runs Cory's projects between prompts. Vocabulary lives in [CONTEXT.md](CONTEXT.md); decisions in [docs/adr](docs/adr). This file is the operating guide. Every fleet session reads it at start.

## Shape

```
cory
 └─ dispatcher (opus)      your interface; relays escalations; daily digest; watches the sentinel
 └─ sentinel   (sonnet)    keeps the roster alive and under the cap; never reasons about work
     └─ pl-<tenant> (sonnet)   one per tenant; turns ready issues into ICs; reviews and merges
         └─ ic-<issue> (sonnet) one per issue, launched with /implement; opens a PR; talks only to its project lead
             └─ qa-reviewer (opus worker)   risk reviewer, spawned by the IC pre-PR-ready only on a configured risk trigger (ticket 05)
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
| `hooks/session-start.ps1` | Prints the session's identity, tenant, PAUSE state, scoped notices, any rotation handoff, and roster into its context. Notices come from `state/notices/{all,<role>,tenant-<tenant>}.md` only; each paragraph may carry `[until YYYY-MM-DD]` or `[cleared-by <work-record-id> <state>]` and drops out when its end arrives. |
| `hooks/stop.ps1` | Every session: writes a heartbeat. Project leads: exits 2 (keep going) while there is actionable work: a non-draft `fleet/*` PR, or a **frontier** issue (ready label, no open blockers per GitHub issue dependencies via GraphQL `blockedBy`, not in `state/skip/<tenant>.json`, free cap + IC slot). |
| `state/skip/<tenant>.json` | The project lead's "not launchable, and why" list (`{ "issues": { "<n>": "reason" } }`). The hook honours it; you triage it. |
| `bin/launch.ps1` | **The only door.** Enforces PAUSE, cap, `maxIcs`, naming; writes per-session settings with `FLEET_*` env and the role's tool contract (`permissions.deny`: no direct edits on `state/work|events|archive` for anyone, no tenant-repo edits for control-plane roles, no fleet-state edits for ICs); refuses a launch whose estimated first-turn context exceeds the role's `config/cycle.json` ceiling, with a per-source breakdown (`state/flags/launch-ceiling-off` or `-Force` bypasses); records the session in `state/roster.json`. |
| `config/cycle.json` | Ticket-06 budgets: first-turn ceilings per role and rotation thresholds (dispatcher daily; project lead at 5 merges / 24 h / 250K job tokens). `baselineTokens` is calibrated at ticket 09. |
| `bin/rotation-policy.js` | Read-only rotation policy: `evaluate` reports which standing sessions are past a threshold (roster age, `state-merged` events since launch, transcript job tokens); `offset` captures the event-ledger position. |
| `bin/rotate.ps1` | Rotation driver: only at a safe boundary (daemon `status` not busy, no work-state lock or pending journal) it saves the offset intent to `state/rotation/<name>.json`, retires the session, reconciles Work records (one pr-watch tick per tenant), and relaunches through `launch.ps1 -FromRoster`. A crash between stop and launch resumes from the intent (`-Resume`/`-Auto`). `-Name X -Force` is Cory's hand. |
| `bin/run-rotation.ps1` | Bounded rotation runner used by Task Scheduler (every 15 min); `install-rotation-task.ps1` registers it - run manually, the fleet never self-registers. |
| `state/flags/` | Rollback flags, one file each, independent of launch gates: `legacy-notice` (restore `state/NOTICE.md` injection and unfiltered boards), `rotation-off` (disable auto rotation), `launch-ceiling-off` (disable the first-turn gate), `tool-contract-off` (skip the per-role deny injection); and the ticket-07 delivery gate `notifier-live` (ABSENT by default: the notifier runs in shadow and the Dispatcher relay stays the pager; create the file to let decision events page Cory directly). |
| `bin/sentinel-check.ps1` | The Sentinel's mechanical check; `-Apply` performs respawns, retirements, worktree sweeps, and rate-limit PAUSE. An IC waiting on an open PR or skip-list hold is never stale-heartbeat respawned. |
| `bin/retire.ps1` | Mark a finished IC as retiring before stopping it, remove its job/worktrees, and report verified remaining worktree state. |
| `bin/work-state.js` | Canonical shadow Work-record/event command; validates transitions, revisions, idempotency, projections, and retirement archival. Ticket 07 added the `notify` door (`--phase claim|sent|failed|authorize-retry --decision-sequence <n>`): delivery state for one decision event lives on the record and in typed `notification-*` events; a failed page is inert until `authorize-retry` (evidence required), which re-arms exactly one attempt and launches it. A CLI `transition` to `escalated` or `hold` launches the notifier for its event (`--no-notifier` suppresses either). |
| `bin/review-policy.js` | Ticket-05 review policy: risk-tier classification from tenant `carveOuts` + `riskTriggers`, one findings artifact per review (recorded through the work-state `review` door), revision re-review scoping, and the hold-and-page-once path. |
| `bin/suite-lock.js` | Host-wide semaphore for the tenant's `heavySuites`; a blocked attempt names the owning Work record; `run -- <cmd>` wraps acquire-exec-release. |
| `state/reviews/` | One findings artifact per recorded review, per Work record; the event ledger references these paths. |
| `state/suite/` | Live heavy-suite locks (owner pid + Work record). |
| `bin/assignment.js` | Shadow frontier selector, reservation/manifest builder, base reconciliation, and single-door launch adapter. Frontier exclusions come from `bin/exclusions.js`'s projection (`source: exclusion-ledger`); the legacy prose skip file is still honoured during shadow (`source: legacy-skip`). |
| `bin/exclusions.js` | Ticket-07 structured Frontier exclusions: an append-only ledger per tenant (`state/exclusions/<tenant>.jsonl`) of `exclusion-added` / `exclusion-lifted` entries, each with reason, evidence pointer, owner, and a recheck (`--expires <iso>` or `--recheck-event <type> [--recheck-record <id>|--recheck-issue <n>]`). `project` folds it against the event ledger: an exclusion leaves the frontier by lift, expiry, or the named event, and its history stays. `exclusion-lifted` as the recheck event means "only the owner's lift releases it". |
| `bin/digest.js` | Ticket-07 projections: `state/status/DIGEST.md` (fleet) and `state/status/<tenant>-status.md` (`--tenant`), folded from the event ledger and the exclusion ledgers at an offset (`--offset <events> --exclusions-offset <n>`; the header names them, no clock is printed, so the same offset rebuilds byte-identically - only exclusion expiry consults `--now`). Sections: Needs Cory (one item per decision event with its delivery state), Active work, Merged, Frontier exclusions (active/discharged), Cory's authority (from tenant config; unchanged by delivery). Nothing model-authored is appended; the next projection overwrites (both files are in every role's Edit-family deny set). Rebuilt by `run-pr-watch.ps1` after every tick (a projection failure is logged there, never the watcher's exit code) and by the notifier after a delivery. Present-day state is consulted for one thing only: the PR number of a record whose creation event predates the ledger carrying `prNumber`. |
| `bin/notify.js` | Ticket-07 ephemeral notifier: a process launched for one decision event (by pr-watch on a `decision-needed` wake, by `review-policy.js hold`, or by a CLI `transition` to escalated/hold). It claims the event through the `notify` door BEFORE sending, sends one Windows toast (`bin/send-toast.ps1`), records `notification-sent`/`notification-failed`, and exits. Concurrent or repeated starts find the claim and send nothing; a failure - including a launch that never produced a process - stays visible in the digest and never re-pages without `authorize-retry` or a new decision event. The page is a typed pointer (record id, revision, sequence, artifact paths) validated against a fixture that rejects copied criteria. Shadow unless `state/flags/notifier-live` or `--live`: it then logs to `state/notify/shadow.jsonl` and touches no record. |
| `state/exclusions/`, `state/notify/` | Exclusion ledgers per tenant; notifier run log (`notify.log.jsonl`) and shadow log. |
| `bin/measure-cycle.js` | Read-only transcript/roster collector for daily JSON metrics and compact seven-day summaries; it never changes fleet decisions. |
| `bin/run-cycle-collector.ps1` | Bounded daily collector runner used by Task Scheduler. |
| `bin/install-cycle-collector-task.ps1` | Idempotently registers the daily collector task; run manually. |
| `bin/pause.ps1` | Fleet-wide kill switch. `-Off` clears. |
| `bin/status.ps1` | One-screen view. |
| `bin/recover.ps1` | Bring the roster back after a reboot. `install-recovery-task.ps1` registers it at logon. |
| `bin/pilot.ps1` | Launch sentinel, dispatcher, pl-endzone. `-DryRun` to check gates without starting anything. |
| `state/` | Runtime only, gitignored: live roster, heartbeats, escalations, per-session settings, status files, PAUSE. |
| `state/metrics/` | Generated measurement artifacts; cache-read tokens remain separate from fresh control-plane and IC tokens. |
| `state/work/` | Shadow Work records and crash-recovery journals; legacy actors remain authoritative until cutover. |
| `state/manifests/` | Immutable shadow assignment manifests and invalidation evidence. |
| `state/events/` | Date-partitioned shadow Fleet events; partitions older than 30 days move to `state/events/archive/`. |
| `state/archive/` | Compact retired Work-record evidence indexes. |

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

Status files: `state/STATUS.md` (dispatcher's digest), `state/status/<tenant>.md` (each project lead), `state/escalations/*.json` (anything that needs you). Ticket-07 projections, script-generated and never hand-edited: `state/status/DIGEST.md` (Needs Cory with delivery state, active work, merges, frontier exclusions, your authority) and `state/status/<tenant>-status.md`.

```powershell
# ticket 07: decisions, exclusions, delivery
node C:\Users\Cory\fleet\bin\digest.js --print                       # rebuild and show the fleet digest
node C:\Users\Cory\fleet\bin\exclusions.js project --tenant endzone   # active + discharged frontier exclusions
node C:\Users\Cory\fleet\bin\exclusions.js add --tenant endzone --issue <n> --owner cory --reason "..." --evidence "<path or url>" --recheck-event exclusion-lifted
node C:\Users\Cory\fleet\bin\exclusions.js lift --tenant endzone --id endzone:excl-<n>-1 --actor cory --evidence "..."
node C:\Users\Cory\fleet\bin\work-state.js notify --id <tenant>:issue-<n> --phase authorize-retry --decision-sequence <seq> --expected-revision <r> --actor cory --evidence "..."   # re-arm ONE more page after a failed delivery
New-Item C:\Users\Cory\fleet\state\flags\notifier-live               # cutover: decision events page you directly (toast)
```

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

The `mattpocock-skills` plugin is enabled at user scope, so every fleet session can invoke its model-invocable skills. The roles name the ones they rely on: ICs build with `/tdd`, start bugs with `/diagnosing-bugs`, and untangle stale branches with `/resolving-merge-conflicts`; project leads review PRs with `/code-review` (its Standards + Spec sub-agents are the two review angles - the PR's single formal review; the IC's own check is a targeted self-check, not `/code-review`, per ticket 05) and settle vocabulary with `/domain-modeling`; the dispatcher answers reading questions with `/research`. `/implement` is user-only, but a slash command at the head of a launch prompt counts as a user invocation in the new session (verified), so project leads launch ICs with `-Prompt "/mattpocock-skills:implement ..."` and the IC runs the real skill. `skills:` in a role file's frontmatter does **not** preload skill text into a `--agent` background session (verified, both spellings); skills are discovered from the listing and invoked on demand. `/triage`, `/to-spec`, `/to-tickets` and `/grill-with-docs` stay yours: they are scope decisions.

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
- **Worktree isolation is lazy for legacy launches.** A background session starts in the repo's main checkout (reads only) and is moved into `<repo>/.claude/worktrees/<name>-<slug>` on a `worktree-*` branch the first time it writes. The main checkout is never dirtied. ICs then create their `fleet/<issue>-<slug>` branch inside that worktree. Manifest-launched assignments are the exception: `launch.ps1` creates `<name>-assignment` directly from the manifest base SHA on the manifest branch, so the IC must not create a nested worktree or switch branches. `claude rm` removes the worktree and its branch. The fleet never touches worktrees it didn't create; your hand-made `Endzone-Empire-*` worktrees are yours.
- **Hook commands run through a POSIX shell, even on Windows.** Backslashes in `fleet-settings.json` hook paths get eaten (`C:UsersCory...`). Use forward slashes: `-File C:/Users/Cory/fleet/hooks/stop.ps1`. PowerShell accepts them.
- `--settings <file>` on `claude --bg` applies the file's `env` block and `hooks`; that is how a session learns who it is (`FLEET_*`). `respawnFlags` in the job's `state.json` records the settings path, so `claude respawn` keeps the identity.
- Cron jobs inside a session expire after 7 days; the SessionStart hook reminds the Sentinel and dispatcher to recreate theirs.
- Max 5x: rate limiting is a first-class state. The Sentinel sets a 60-minute PAUSE when a fleet job reports one and clears it after the window.
