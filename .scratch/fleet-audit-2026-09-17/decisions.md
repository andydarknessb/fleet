# Decisions from the 2026-09-17 audit grill

Cory approved every recommendation in three rounds (Q1 to Q33). This file is the source for the workstream specs. The audit itself is `report.md` beside it. ADRs 0012, 0013, 0014 carry the three hard-to-reverse decisions.

## Order of work

1. Pages reach Cory. 2. Self-heal. 3. Deploy guard. 5. Measurement. 4. Premise checks. 6. Separate fleet identity. 7. Haiku rehearsal. The fleet is not its own tenant (ADR 0008): all of it is built by Cory's interactive sessions, one spec issue per workstream with child tickets on andydarknessb/fleet.

## Workstream 1: pages reach Cory (ADR 0012)

- **Page** is a glossary term: one off-host push, once per condition. Its two in-fleet sources (Notifier decision events and Watchdog conditions) share one delivery function; the off-host dead-man pages when Watchdog pings stop. Rename the in-fleet function away from "alert". Frontier and triage wakes stop going to it and are logged only.
- Channel: Pushover. Emergency: `fleet-dead`, dead-man silence. High: permission-wait, launch-retry trip, merge without review, branch-diverged. Normal: a Ruling or Hold waiting, a passed date. Log only: `respawned`, wakes.
- `fleet-dead` fires only when every static heartbeat is stale AND work is waiting: frontier non-empty with a free slot, OR a record in a fleet-owned state (assigned, implementing, revision, settled ci-wait, review), OR an unconsumed wake. `hold` and `escalated` never count. Stale with nothing waiting is recorded as idle.
- A page never repeats, except: `fleet-dead` once more at emergency priority after 2 h; one daily summary at 8am Central of open "Needs Cory" items with ages, from the Digest.
- The Notifier message gains the one-line question and the link where Cory rules. Create `state/flags/notifier-live` as part of this work.
- Off-host dead-man service pinged by the Watchdog every tick. Host power plan: never sleep on AC (Cory, by hand).
- Dated config: any passed date field in config, or an expired `[until]` notice still injected, raises one normal page. Dated rulings arm themselves in code.
- Dispatcher retires after one week of delivered pages (ADR 0005 executes; Reporting line glossary entry rewritten then).

## Workstream 2: self-heal

- `blocked` + no permission prompt pending + heartbeat stale over 60 min + work waiting: control-plane session gets `rotate.ps1 -Wake`; IC gets `claude respawn`, pid verified, cap 2, then Page.
- `rotate.ps1` boundary check learns "no permission prompt pending".
- Register the recovery logon task (`bin/install-recovery-task.ps1`; Cory, by hand).
- `branch-diverged` with real content: the Watchdog opens the main into integration PR as a MERGE COMMIT and pages high; Cory merges. Rule for Cory's sessions: nothing merges to main except a release PR.
- Weekly janitor scheduled script: removes a worktree only when its record is merged or retired AND `git status` is clean AND the branch is merged, else lists it; deletes `state/tmp-*` and `%TEMP%/fleet-work-state-*` older than 7 days; archives settled escalation files; removes the dead "Fleet weekly-limit recheck" task. First run `-DryRun`, read by Cory.
- ADR 0006 "after one release" paperwork, overdue.

## Workstream 3: deploy guard and review gate (ADR 0013, ADR 0014)

- CI on master (Windows runner, aggregate runner, suites serial). Live checkout follows `live`; the Watchdog fast-forwards it when master is green; `state/flags/deploy-hold` freezes; rollback is a ref move.
- Required `fleet-review` status on integration: posted by `review-policy.js record --kind formal` for the reviewed head; `review-policy.js attest --pr --head --artifact` for PRs without a Work record (Cory's sessions, Dependabot).
- verify-events invariant: `merged` with no `review-recorded` for that head fails.
- Review quality: severity enum (blocker, major, minor, nit) and required `category` enforced at the record door; first review exhaustive, re-review reads changed range plus unresolved only, a new finding on unchanged code rides along and never sends back; the same finding raised a second time escalates for a Ruling; hard stop at the third send-back; both at the state door and in the role file.
- IC pre-ready mechanical check (`bin/pr-ready-check.js`): comments or docs naming an identifier the diff removed or renamed, closing-keyword and PR-body defects, lint. PR body carries a criteria evidence table, one row per acceptance criterion. Target send-back rate 49 percent to under 30.

## Workstream 5: measurement

- Collector reads retired roster rows, attributes Worker transcripts (risk reviewer as its own line AND inside the hosting unit's total), normalizes model keys, keeps a verify-verdict history.
- `ic.escalateTokens` 350,000 now, as a runaway guard. The 60k median is reported, not judged; per-model targets after two clean weeks.
- Weekly scorecard file each Monday; its headline rides the daily summary.
- Reviewer audit: one zero-finding review on a diff over 150 lines per week gets an independent opus second read. Bug template gains "escaped from PR #".

## Workstream 4: premise checks

- Glossary: **Premise**, **Stale premise**. Tickets carry a fixed `## Premises` section: path, claim, @sha per line, or "none".
- Cut time (tenant `docs/agents/agent-briefs.md`): a fourth lookup, every code premise quoted with its SHA; one ticket is one PR; siblings naming the same path get blocked-by edges in merge order.
- Triage: the Principal re-runs the premises and stamps the verified SHA in the proposal; backfills the open ready-for-agent tickets.
- Assign: the lead re-checks only premises whose named paths changed since that SHA (`git diff --name-only <sha>..origin/<default>`); the step is written into `agents/project-lead.md`.
- A stale-premise restatement still needs Approval (ADR 0011). Log each with Cory's verdict for a month, then rule.

## Workstream 6 and 7

- Separate machine-user identity for the fleet, after workstream 3; own ADR when built.
- One haiku IC rehearsal with an explicit permission allowlist instead of auto mode; reopen the tier for haiku-fit tickets if clean; re-test on CLI updates.

## Done the same day

- Retro reviews of PR #1287 and PR #1288 (opus): Endzone issues #1545 (live points double-count, major), #1546 (stale edge sentence, wrong-week deltas, major), #1547 (minors).

## Rulings 2026-09-18 (implementation questions on workstreams 1 and 2)

1. **Work-waiting states stay the ruled six.** `merged` and `retiring` need no session: `pr-watch`'s projection retires any merged or retiring record on its own tick once the IC leaves the roster (all of the last 30 merged records went straight to `assignment-retired` by `pr-watch`, median about 63 ms, max 5 min), and the supervisor's check retires a done IC once the issue reads closed. Counting them would re-create false `fleet-dead` pages.
2. **Heal when `needs` is absent; never when it carries text.** The daemon deletes the key rather than writing an empty string: `needs` is absent in 51 of 52 real job states including a working dispatcher, so "present and empty" is a rule that never fires in production. "Anything but `^approve `" would heal the one real blocked row on disk, a plain-English question to Cory ("reply go to merge PR #41"), which a rotation destroys. Rule: heal only when the job state read cleanly AND the `needs` key is absent or whitespace. Any non-empty `needs`, permission prompt or not, is a session asking a human something: not healed, and paged once at normal priority with the text, so the ask reaches Cory instead of dying with the session. Test fixtures that write `needs: ""` stay valid under this rule.
3. **Janitor: literal rule plus the merged-PR signal; no live-session clause.** The fleet squash-merges, so the ancestor check fails on every `ic-*` worktree; the literal rule removed 21 of 26 only because their remote branch had been pruned. A MERGED pull request for the head branch counts as merged (25 of 26). The live-session clause changes nothing (no candidate is owned by a live session) and the clean check already protects `ic-1308-assignment`, which is retired and merged yet dirty. Hand-made worktrees without an issue number in the name (27 today, docs and release branches) never satisfy the record clause: listed, never removed, by design.
4. **Emergency page: retry once on a 5xx, a failed connection or no reply, after 5 seconds; never on a 4xx.** That is Pushover's own guidance. A duplicate from a timed-out request that in fact delivered costs nothing on an emergency page, and Pushover already repeats emergency pages every `retry` seconds until acknowledged.
5. **The 48-hour window stands.** It is anchored on the ledger's `state-merged` timestamp, which is the right event, and it exists so a first live cutover cannot page merge history; #1241 and #1263 are six days past merge and already retired.
6. **Land one PR per lane, in a fixed order, each rebased onto the one before; never the combined branch as one PR.** Four local lanes exist (watchdog pages; notifier and summary; rotate, sync, janitor; rollback retire), three of them touch `bin/watchdog.ps1` and all four touch ADR 0012, so per-ticket PRs would be fifteen stacked conflicts and the combined branch is 5,456 added lines that no single review reads exhaustively (ADR 0014's own lesson). Order: watchdog pages, then notifier and summary, then rotate/sync/janitor, then rollback retire. Each PR body maps ticket number to commits, gets its own formal review, and the ADR 0012 edits are consolidated in the first lane so the later ones stop touching it.
