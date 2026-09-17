# Fleet performance audit, 2026-09-10 to 2026-09-17

Status: FINAL. Research by five Sonnet agents, adversarial QA by one Opus reviewer, disputed items re-checked against primary files by the authoring session. Sources: state/events, state/metrics/seven-day-2026-09-17, state/reviews, state/sentinel/shadow, state/alerts, state/escalations, state/rotation/rotation.log, state/verify/last.json, config/cycle.json, fleet git log, gh (andydarknessb/fleet, andydarknessb/Endzone-Empire).

Denominators used throughout: 159 reserved, 143 implementing, 142 merged, 135 retired, 134 collector-completed units.

## Scorecard

| Area | Result | Verdict |
|---|---|---|
| Throughput | 142 units merged (`fleet/*` PRs to integration), about 20 a day; 1 never merged (#1498, false premise, issue still open) | Strong |
| Cycle time (reserve to merge, n=141) | median 1.21 h, p90 2.98 h, max 17.6 h (#1312) | Strong |
| Issue-to-merge tail | 5 tickets took 12 to 51 h end to end while the fleet held work for only 0.5 to 2 h; #1312/#1309/#1509/#1507 waited on a Cory ruling after a pre-launch premise escalation; #1308 was abandoned and simply sat 47 h with no ruling event | Human-gated |
| Sent back at least once | 65 of 134 units (49 percent); #1240 took 7 formal rounds, 569k tokens, 353 min | Weak |
| Review gate | 234 formal + 69 risk reviews; but #1241 (PR #1287, +692) and #1263 (PR #1288, +616) merged 09-12 with NO review on record or on GitHub, 4 and 0.1 min after their gates went green. CORRECTED after follow-up: not caused by that day's fleet commits. pr-watch detected both ("merged without a recorded formal review") and raised `decision-needed`; the Notifier ran shadow (`notifier-live` absent) and delivered nothing; one toast went out. GitHub cannot say whether the lead or Cory ran the merge (one shared login). Detection worked, delivery did not, and no retro review happened | Unreviewed merges |
| Escaped defects | 4 to 6 traced to fleet PRs (#1543, #1144, #1480, #1537), about 3 to 4 percent, likely undercounted; 0 reverts; 134 of 134 issues closed on merge | Acceptable |
| Availability | watchdog recorded `fleet-dead` on 128 of 690 ticks (about 32 h, 19 percent of the week); longest run 09-13 23:17Z to 09-14 ~12:35Z, ended by a manual wake; 25 pages, all local toast only | Weak |
| Host uptime | watchdog itself missed ~45 ticks (09-10, 09-15, 09-17 short days) matching 8 h ledger gaps: the PC was asleep or off | Unmanaged |
| Escalations | 25 files: 15 auto-respawns, 10 needing Cory (4 branch-diverged, 5 permission-wait, 1 loop-guard at 30 continues); 36 files never archived | Mixed |
| Control-plane cost | fresh per unit 13,742 (93.2 percent under baseline); lead fresh per merged PR 2,109 (limit 25,000); both understated, see finding 5 | PASS with caveat |
| IC cost | median 125,151 job tokens vs budget 60,000; p90 340,714; ICs are ~99.7 percent of measured fresh tokens | FAIL |
| Ledger integrity | `verify/last.json` pass:false (endzone:issue-1136 abandoned vs retired); blocks 30-day rotation of event partitions only | Minor FAIL |
| Fleet repo | 33 issues, 37 PRs opened and closed in the week, median 2.5 h to close, 0 open; no CI | Fast, unguarded |

## Findings

1. **The fleet is fast; the waits are human.** Median 1.2 h reserve to merge. Every long ticket was a pre-launch premise or scope escalation (18 abandon and reissue cycles) or a Scope amendment wait. Premises are checked after assignment, when the cost is a burned launch and a ruling round-trip.

2. **`fleet-dead` cannot tell idle from dead, and its page goes nowhere.** Heartbeats are written on turns, so an idle lead with an empty frontier goes "stale" too. Result: 25 `fleet-dead` pages in a week, each a local toast, so the real one (09-13/14, all standing sessions `blocked`, ~13 h, manual wake; same class as the 22.5 h outage 09-05/06) looked like the rest. `sentinel-check.ps1:133-139` still refuses to respawn `blocked`; the recovery task is still unregistered; ADR 0003's named remedy (a cloud routine that pages on stale heartbeats) was never built.

3. **The alert webhook would not carry the urgent pages.** `Send-FleetAlert` (the only webhook and `alerts.jsonl` writer) is called only for `frontier-wake` and `triage-wake`. `fleet-dead`, `permission-wait`, `respawned`, `launch-retry` go to banner + toast only, and `notifier-live` only ungates another toast. Setting the webhook today delivers the two least urgent kinds.

4. **The IC budget is unenforced and the written line is wrong for today's mix.** `ic.escalateTokens` is still null; `soakUntil` passed 09-16 and nothing reads it. 108 warnings, 0 escalations possible. 75,000 would escalate 92 of 134 units (69 percent). Why sonnet went 52k to 133k median: composition. On 09-09 the heavy tickets ran on opus (n=79, median 217k); amendment 14 retired opus ICs and those tickets moved to sonnet. Overall median did not move (125,644 to 125,151). Haiku (median 37,724) has been refused since 09-11 by the CLI's per-model auto-mode gate (fleet #28). Also: `budget.js` stops measuring once a record leaves `BUDGET_STATES`.

5. **The cost report undercounts.** `measure-cycle.js:681-685` only reads sessions still in `roster.json`; rotation replaces the row, so every rotated-out dispatcher, lead and principal incarnation is invisible, and the opus `qa-reviewer` (69 runs) is a subagent that never reaches the roster: zero tokens counted. Model keys are raw strings (`sonnet` and `claude-sonnet-5` were separate tiers on 09-09).

6. **Review data cannot be learned from.** 485 findings, severity free text (12+ spellings, 41 blank). About 23 percent of multi-formal review dirs are re-reads at a new head, not revisions, so "rounds" is not derivable from file counts. Nothing feeds recurring findings back to the IC self-check, which is the main lever on the 49 percent send-back rate and on IC tokens (the top-cost units show 77 to 140 shell calls each).

7. **The fleet repo deploys to production on merge with no net.** 37 PRs in a week, no CI, no aggregate test runner, running sessions read master live. The 09-12 review-gate bypass is the concrete cost. Two classes made 14 of 33 defects: reservation/assignment matching (8) and review-policy state machine (6).

8. **Decisions are already listed, just not delivered.** `state/STATUS.md` and `state/status/DIGEST.md` carry the live "Needs Cory" list (today: #1535 ruling parts undone after auto-close, #1498 open and blocking the #1505 chain, risk-001-f4 offered 3x unanswered, #1484, two unconfirmed migration batches, fleet #55/#56/#58/#70 rulings). It only exists on the PC.

9. **Hygiene.** ADR 0006 "after one release" cleanup 8 days overdue; ADR 0005 already rules the dispatcher retires and it is still standing; 54 worktree dirs on E:; ~25 `state/tmp-*` files; 36 unarchived escalations; untracked junk at the fleet root; "Fleet weekly-limit recheck" task dead since 09-08 (result 1).

## Recommendations

### Today, by hand
1. Set `ic.escalateTokens` to 350,000 (pages 11 of 134 units, a runaway guard). Keep 60k as a tracked median, and re-baseline it after the haiku tier returns. Do not restore 75,000.
2. Register the recovery logon task (`bin/install-recovery-task.ps1`, ADR 0003 compliant).
3. Reconcile the #1136 record so `verify-events` passes.
4. Rule on #1241/#1263: get both diffs a retroactive formal review.
5. File the supervisor defects below as fleet issues; the repo shows 0 open while the known gaps live only in memory notes.

### Automate, in order
| # | Automation | Removes |
|---|---|---|
| A | Route watchdog `$conditions` through `Send-FleetAlert`, THEN set `state/alerts/webhook.url` to a phone channel. | Pages nobody sees |
| B | Make `fleet-dead` mean dead: only when heartbeat is stale AND (frontier non-empty OR a record is in flight OR a wake is unconsumed). Idle with nothing to do is healthy. | ~24 false pages a week |
| C | Off-host dead-man switch (ADR 0003): the watchdog pings a cloud routine each tick; silence for 45 min pages the phone. Covers the host asleep and the watchdog dead, which nothing on the PC can. Add a power plan or wake timer so the host does not sleep while the frontier is non-empty. | 8 h silent gaps |
| D | Stale-and-`blocked` self-heal with a guard: if `blocked`, no pending permission prompt, heartbeat older than 45 min and real work waiting, `claude respawn`, verify the pid changed, cap 2, then page. Permission prompts stay with the existing fleet #28 handler. | The 13 h and 22.5 h outages, the manual wake recipe |
| E | Premise check at triage: the principal verifies each code-state premise before proposing `ready-for-agent` and records the verified SHA; `assign` re-checks only if the named files moved. | 18 abandon/reissue cycles and the issue-to-merge tail |
| F | Deliver the existing DIGEST "Needs Cory" section to the phone on change (through A), with the options stated per item. | Multi-hour ruling waits |
| G | Fleet repo CI on windows-latest plus `bin/test-all.ps1`; deploy marker so sessions and `git pull --ff-only` only advance to a SHA that passed; a canary assertion that no record goes `state-review` to `state-merged` without a `review-recorded` event (verify-events can own it). | Live-master breakage, the 09-12 bypass |
| H | Collector fixes before any tuning: read retired roster rows (`state/archive/roster-retired-full.jsonl`) for rotated sessions, attribute subagent transcripts to the hosting IC, normalize model keys, keep a verify-verdict history. | Six numbers in this audit rest on it |
| I | Auto-open the main to integration reconciliation PR as a merge commit when `branch-diverged` fires with content; long term, refuse non-release merges to main. | 4 hand reconciliations |
| J | Dated-config check in the watchdog: any passed `*Until` in config or notices raises one condition. | The missed 09-16 restore |
| K | Weekly janitor scheduled task (a script, so no classifier in the loop): orphan worktrees, `state/tmp-*`, stale heartbeats, escalation archiving, `%TEMP%/fleet-work-state-*`; remove the dead weekly-limit task. | The 09-10 hand sweep |
| L | Weekly scorecard from the collector: this table as `state/metrics/scorecard-<date>.md`. | This audit |

### Quality and cost levers
- M. Severity enum enforced at `review-policy record` (blocker, major, minor, nit) plus a `category` field; weekly `review-report.js` feeds the top categories into the `agents/ic.md` self-check. Target send-back 49 percent to under 35.
- N. Revision-loop breaker: at the third send-back the lead escalates with a restated criterion instead of a fourth round.
- O. Cheap tier: haiku is blocked by the CLI, not fleet config; re-test on each CLI update, or give haiku ICs an explicit permission allowlist so default mode does not block. About 3.5x cheaper on fitting tickets.
- P. Reviewer audit: one zero-finding review on a diff over 150 lines per week gets an independent opus second read (17 such this week, none checked).
- Q. Bug template gains "escaped from PR #"; the collector counts it.
- R. Paperwork: execute ADR 0005 (retire the standing dispatcher once A and F are live) and the ADR 0006 cleanup.

## Not determined
CI first-push failure and flake cost (sample all green); whether each of 234 watchdog wakes produced an assignment; usage-limit hits after 09-10 (job state is overwritten); why #1240 needed 7 rounds; how much of the 32 h `fleet-dead` was idle rather than dead (finding 2 is why).
