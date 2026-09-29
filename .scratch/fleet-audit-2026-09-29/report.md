# Fleet audit, 2026-09-22 to 2026-09-29

Rulings: see `decisions.md` beside this file. R1 to R6 were ruled 2026-09-29 by this session at Cory's request; none are applied yet.

Status: FINAL, ruled. Question: how to make the fleet quicker, cheaper and more automated without losing much quality. Research by seven haiku researchers and two sonnet re-dispatches (ADR 0010 tiering). Three QA passes checked the draft: numbers against primary files (sonnet), adversarial review of the recommendations (opus), and stale premises against fleet master 89f083e (sonnet). Their corrections are folded in; the claims they changed were re-checked against the files by this session. Raw notes: this session's scratchpad `r1`..`r7`, `r5b`, `r6b`, `qa1`..`qa3`.

Sources: `state/metrics/seven-day-2026-09-29.json`, `scorecard-2026-09-21.md`, `state/events/*.jsonl`, `state/pages/pages.jsonl`, `state/watchdog/*`, `state/triage/*.jsonl`, `state/verify/*`, `state/exclusions/*`, `state/archive/roster-retired-full.jsonl`, 178 control-plane and 70 IC transcripts under `~/.claude/projects`, `~/.claude/jobs/*/state.json`, gh (`--limit 500`, rulesets API), Claude Code 2.1.284 docs (prompt caching, hooks, cross-session messaging, model config, agent view), and the claude-api pricing table cached 2026-09-25.

Denominators: 67 completed units in the collector week (endzone 60, nidus 7); 52 merged in the scorecard week (09-21..27); 69 merged units in the ledger 09-22 to 09-29T14Z.

## Bottom line

1. **Inside a unit the fleet is quick; the time goes to waiting on you.** Reserve to merge is about 1 h at the median and merged code reaches production in a median 3.4 h. But at least one lead or Principal sat waiting on Cory for 57% of the measured 137 hours (71% counting the dispatcher's repeats of the same asks).
2. **Throughput follows intake.** Merges fell from 142 to 52 a week. No IC was running for 35% of hours fleet-wide (55% on Endzone), and all three IC slots were busy only 16.5% of hours.
3. **Management costs about 3.5 times the work.** Of about $700 a week (API-equivalent), about 77% is the control plane: leads on Opus 5.5, Principals on Fable 5.1, and the dispatcher. That is about $8 of control plane per completed unit against about $2.30 of IC work.
4. **The fleet's own meters read about 2x high.** The collector, the rotation policy and the IC budget all sum token usage on every transcript row. Claude Code writes one row per content block, so each API call is counted about twice. Rotations and budget warnings fire at about half their configured lines.
5. **Pages started reaching you at 14:15Z today.** Three gaps remain. The dead-man switch has never pinged. The notifier flag is off. And `fleet-dead` goes out at emergency priority, which repeats every 2 minutes until acknowledged. Its recent episodes coincided with every session waiting on you.
6. **Quality shows no damage, but it is under-measured.** No escaped defect has been traced to a fleet PR, but 8 of the 9 bugs opened that week were never classified. Send-back ran at 36.5% (watch level). One PR (#1599) was merged without a formal review at its merged head.

## Scorecard

| Area | Result | Verdict |
|---|---|---|
| Throughput | 52 merged (09-21..27), 67 completed (09-22..29); 142 in the 09-17 audit week | Intake-bound |
| Capacity use | 0 ICs running 34.6% of hours (Endzone 54.9%); all 3 IC slots busy 16.5% | Mostly idle |
| Cycle time | reserve to merge median 1.0 h, p90 3.8 h | Strong |
| Where unit-time goes | review 66.5 of 230 unit-hours, holds 55.7 (one Nidus unit 55 h) | Review tail, holds |
| Time to production | 17 releases, all by hand; merge to first containing release median 3.4 h, p90 13.9 h | Strong |
| Waiting on Cory | 57% of 137 h (leads and Principals); 71% counting the dispatcher's repeats | Weak |
| Pages | 1,882 rows since 09-23T21:17Z, none delivered until 14:15Z today; dead-man and notifier still off | Fixed in part |
| Escalations | 38 events on 27 units; 20 were pr-watch closing linkage, 11 of those a deliberate `Refs` | Noisy |
| Cost | about $700/wk API-equivalent, 77% control plane; the fleet's meters read 2x | Top-heavy |
| Ledger check | failed all 1,345 runs; now only #1599 is left | Signal lost |
| Merge guards | only Endzone `integration` has a ruleset; Endzone `main` and Nidus `master` have none | Gap |
| Quality | no escape traced to a fleet PR; 8 of 9 bugs unclassified; send-back 36.5%; one review-gate miss | Under-measured |

## Findings

### F1. Units are quick; review and holds carry the time

- Median implement, CI and review are about 10 minutes each. Summed over units, review is the largest bucket (66.5 of 230 unit-hours), so its tail is long. Holds come next (55.7 h), almost all of them one Nidus unit (55 h).
- Merged code reaches production quickly: across 88 PRs, the first release that contained each one merged a median 3.4 h later (p90 13.9 h, max 25 h). There were 17 release PRs in the week, all merged by hand.
- The pickup latency from checks-settled to the start of review was not measured (see Not determined). Of everything inside a unit, it is the one thing likely to speed it up.

### F2. The fleet waits on Cory more than half the time

Measured from the `pages.jsonl` human-wait rows, 09-23T21:17Z to 09-29 (136.8 h; no earlier rows exist). An episode is a run of consecutive ticks with the same ask.

| Waiting for | Episodes | Session-hours, all standing sessions |
|---|---|---|
| Merge refused by the auto-mode classifier | 15 | 47.3 (19.5 of them the dispatcher repeating a lead) |
| Carve-out PR merge | 8 | 44.2 (43.3 of them Nidus #16: `config.toml` plus OAuth setup) |
| `Approved` on a Principal proposal | 17 | 28.3 |
| Ruling or decision | 22 | 23.3 |
| Release or promotion | 10 | 9.5 |
| Other | 10 | 8.5 |
| Permission prompt | 8 | 5.0 |
| Merge of a non-fleet PR | 2 | 2.0 |

- Without the dispatcher's repeats, the order is: carve-out 37.0 h, classifier-refused merges 27.8 h, `Approved` 26.0 h. At least one lead or Principal was waiting 57% of the time.
- ICs waited another 80.8 h in 17 episodes.
- Classifier-refused merges waited a median 3.9 h from the first page to the merge (max 13.5 h). The #173 fix, in effect from 09-28T05:01Z, cut these refusals but did not end them: Endzone #1727 and #1735 and Nidus #26 were refused after it, while 13 merges under the fleet identity went through. Nidus #26 was refused under the classifier's generic migrations rule, and here the classifier was right: Nidus does not treat migrations as carve-outs (F6).
- After the fleet-identity cutover (09-25T20:22Z), Cory hand-merged six fleet PRs, none of them carve-outs (#1690, #1691, #1695, #1696, #1698, #1734), plus the carve-out #1771.
- Nothing wakes a session when its ask is answered. The watchdog wakes a Principal on `Approved`, and that is the only case. 26.8 of the merge-wait hours came after the PR had merged. A blocked session that loses its process while `needs` is set is healed by nothing: that follows the fleet #84 ruling that such an ask must outlive its session. pl-nidus sat in that state from about 12:30Z today until it was force-rotated at 14:12:53Z.
- At 14:32Z today, pl-endzone was waiting on carve-out PR #1783 (merge it and apply migration 20260929000002 in the same batch).

### F3. Pages reached no one until today

- 1,882 page rows since 09-23T21:17Z. A page counts as sent once per standing condition, keyed by session. The rows repeat every tick only because an unconfigured page counts as not attempted. That comes to about 115 distinct pages in six days.
- Fixed at 14:15Z today: `state/pages/pushover.json` now holds the `token`/`user` keys the sender reads. The first delivered page went out at 14:32:48Z. The copy in `state/secrets/pushover.json` uses different key names (`apiToken`/`userKey`), which is why it never worked.
- Still off:
  - **Dead-man switch.** The watchdog reads `state/pages/deadman.url`, but the URL sits in `state/secrets/deadman.json` as `pingUrl`, so every tick reports `deadMan.configured: false`.
  - **Notifier.** `state/flags/notifier-live` is absent, so hold, escalation and merge-without-review pages stay in shadow (112 rows).
- `fleet-dead` pages at emergency priority. Pushover repeats these every 2 minutes for up to 2 hours until acknowledged (`_common.ps1:110`).
  - 41 of the 92 `fleet-dead` rows (all on 09-23 and 09-24) list fresh heartbeats (`-1m`), so they were false. That class has not recurred since.
  - The rest form about 12 episodes of real stale heartbeats. The recent ones, such as 09-29 05:17Z, came while every session was waiting on you.
- Until today, the dispatcher's PushNotification relay was the only path to your phone: 44 mobile pushes were requested from 09-21 to 09-29, and 5 of them failed because Remote Control was inactive.
- The 8am daily summary exists (`bin/daily-summary.js`) and failed as unconfigured from 09-26 to 09-28. It lists only Work records in hold or escalated, plus the scorecard headline. It does not list proposals waiting for `Approved`.

### F4. The control plane is about 77% of spend, and the meters double-count

Figures are API-equivalent at list prices, counting each API call once. Main sessions write the cache at the 1-hour TTL (2x input); that held for 99.7% of main-session writes. Subagents write at 5 minutes (1.25x); that held for 100%. On the Max plan these figures are a share of the usage limits, not a bill.

| Role (model) | Sessions/wk | About $/wk |
|---|---|---|
| Leads pl-* (Opus 5.5) | 111 (endzone 93, nidus 18) | 300 |
| Principals pe-* (Fable 5.1) | 61 (49, 12) | 205 |
| Dispatcher (Sonnet 5.5) | 6 | 30 |
| ICs (Sonnet 5.5) | 70 | 155 |
| Total | 248 | 695 |

- **Double count.** `bin/measure-cycle.js` (the usage loop near line 189) and `sumTranscriptTokens` in `bin/rotation-policy.js` (lines 116-134, which `budget.js` also uses) add up `usage` on every assistant row.
  - Claude Code writes one row per content block of a response, and each row repeats the same usage. One transcript checked by this session has 86 usage rows for 49 API calls, and every repeated row matches its first.
  - Across all 496 transcripts, fresh tokens are overstated about 2.1x and cache reads about 1.8x.
  - Consequences: the lead and Principal token rotation (`maxJobTokens` 250,000) and the IC budget lines (warn 50,000, escalate 350,000) trigger at roughly half the usage they name. Every token figure in the scorecard and in `budget/summary.md` is about 2x.
- **Lead sessions** live 13 minutes at the median (p90 134). Each is a fresh session built by wake-by-rotation, about 1.7 per completed unit, and each reads 100K to 260K tokens of context (median final context 141K). Cold start itself is about 23K; the cost is what each new lead reads.
- **Principals.** About 46 proposals in the week, so about $4 of Fable per proposal. An unchanged `Approved` still costs a Fable session to finalize.
- **Dispatcher.** Almost all of its cost is re-writing its long, idle context after gaps. Across all control-plane transcripts, 25% of cache writes followed a gap of over an hour.
- **Review finders.** The `/code-review` finder subagents already run on sonnet: 90 of 94 in the collector week, and 102 of 106 calls since 09-23. The user-level CLAUDE.md sets this, not the skill or the role file.
- **ICs.** Median about 23K real job tokens per unit, about $2.30 each.

### F5. Escalations: premises and deliberate `Refs`

- 38 escalation events on 27 units:
  - 20 were pr-watch closing linkage (median 6 minutes). 9 of these were fixed by adding a closing keyword; the last such fix was 09-26T01:15Z. 11 were ruled deliberate `Refs` by the lead (5 of those were carve-outs), and that covers all 7 since 09-26.
  - About 10 were premise failures at assign time. The WS4 check is catching them early, as designed.
  - 2 carve-out, 1 budget, and a few other.
- `pr-ready-check` already accepts a closing keyword or an explained `Refs #n`, but pr-watch uses a stricter, keyword-only parser (`pr-watch.js:81-92`). The two regexes also disagree on code spans and line breaks.
- When a `Refs` PR merges, its issue goes back on the frontier once the IC retires, because only unretired records reserve an issue. Today the lead excludes such issues by hand (#1725, #1748).

### F6. Guards: Principal ready for graduation, merge rulesets missing, ledger check stuck

- **Principal.** ADR 0011 decision 3 sets the graduation bar. Endzone has passed it:
  - 133 proposals over 17 days (117 distinct issues).
  - 120 of 124 decided proposals approved unchanged (96.8%), 4 with edits. The other 9 are 5 pending and 4 superseded.
  - Approval latency median 30 minutes, p90 5.4 h.
  - Graduation covers only "a bug with a reproducible red-tell, outside every carve-out path, needing no product decision". There have been no rejections in 124 decisions, which is weak evidence on quality either way.
  - Nidus: 8 of 8 approved over 3.3 days, not yet eligible.
- **Merge rulesets.**
  - The only ruleset on the Endzone repo covers `refs/heads/integration`. `main` has no protection, and the fleet identity has write access. ADR 0015 says that "the release ruleset is what enforces" Cory-only merges to `main`, but no such ruleset exists.
  - Nidus `master` has no ruleset and no protection. It is also Nidus's release branch, and `fleet-review` is not required there.
  - Nidus lists `supabase/migrations/**` as a risk trigger, not a carve-out.
- **Ledger check.**
  - `verify-events.js` runs after every 5-minute pr-watch tick and replays the whole ledger. It has failed all 1,345 recorded runs, so it hides new failures and blocks the 30-day archival.
  - `nidus:issue-4` was repaired at about 14:11Z. Only `endzone:issue-1599` (merged without a formal review) is left. A retired record cannot take a formal review, so the acknowledgment belongs in `config/review-exceptions.json`.

### F7. Platform facts (Claude Code 2.1.284) that decided options

- **Cache TTL.** A main session on a subscription caches for 1 hour; `promptCacheTtl` or `CLAUDE_CODE_PROMPT_CACHE_TTL` can set 5 minutes instead. Measured over all 178 control-plane transcripts, a 5-minute TTL saves nothing net: the dispatcher gets worse, leads are flat, and Principals change a little either way.
- **Idle sessions.** An unattached background session idle for about an hour has its process stopped by the Claude Code supervisor, and by then its cache has expired too. So rotate-to-wake is the right wake for long gaps; the lever is a smaller woken session.
- **In-session wakes.** Two now exist: an `asyncRewake` hook exiting 2, and a cross-session message to an idle session's inbox. Both are bounded by the hook timeout (600 s by default) and by that one-hour stop.

## Recommendations

They are ordered by value per hour of your time. Savings are API-equivalent at last week's volume and are estimates.

### A. Today, by hand

1. **Finish the pages.**
   - Merge fleet PR #188 (open), which reads both the Pushover and dead-man credentials from `state/secrets/` where you wrote them. Then confirm the next tick reports `deadMan.configured: true`. Until it merges, the dead-man switch never pings.
   - Create `state/flags/notifier-live`.
   - Decide whether `fleet-dead` stays at emergency priority (`config/cycle.json`). Its recent episodes meant "every session is waiting on you", and a high-priority page covers that without a 2-minute repeating alarm.
2. **Clear what is waiting:** carve-out #1783 (merge and apply in the same batch), then the pending proposals.
3. **Unstick the ledger check.** Read #1599's merged diff and record the acknowledgment in `config/review-exceptions.json`, so the check can go green and archival can run.
4. **Rulings.**
   - Should Nidus migrations be carve-outs, as on Endzone?
   - Add the Endzone `main` ruleset that ADR 0015 assumes (restrict updates to you).
   - Add a Nidus `master` ruleset requiring `ci` and `fleet-review`.

### B. Automate this week (fleet changes, built in your sessions per ADR 0008)

5. **Count each API call once.**
   - Dedupe by `message.id` in `measure-cycle.js` and `sumTranscriptTokens`.
   - Rule on the thresholds: keep them, so rotation and warnings happen about half as often; or halve them, which keeps today's behavior but names it honestly.
   - Re-baseline the scorecard budgets.
6. **No session ends blocked on you, and answered asks wake their session.**
   - A lead or Principal that needs Cory records the ask on the Work record, as a hold or escalation that pages, and ends idle.
   - pr-watch appends an "ask answered" wake when the record's exit event lands: merge observed, exclusion lifted, approval. The wake is not triggered by parsing `needs` text, which respects the fleet #84 ruling and the 09-28 lesson.
   - The daily summary gains the proposals waiting for `Approved`.
7. **One closing-linkage parser.** pr-watch accepts the explained-`Refs` shape that `pr-ready-check` already accepts, with a single shared parser. When a `Refs` PR merges, its issue gets an exclusion that closing the issue releases, so no hand step is needed. This removes about 11 escalations and lead wakes a week (about $60) and the #1748-style reassignment risk.
8. **Finalize exact approvals by script.**
   - `triage.js` gains a finalize step for a comment matching `^Approved\s*$`. Today `APPROVAL_RE` also matches "Approved, but skip X".
   - It runs only when the issue body hash is unchanged since the proposal, and never on an escalation ruling.
   - It posts the Ruling (the proposal verbatim), applies the ready label, clears the marker and records the ledger.
   - `Approved with:` still wakes the Principal.
9. **Graduate the Principal, on ADR 0011's own terms.** It may apply `ready-for-agent` itself only when all of these hold:
   - the issue is a bug, with a reproducible red-tell and `Ruling: none needed`;
   - no carve-out path and no risk-trigger path is involved;
   - it is within a daily cap.

   Launch waits 2 hours in the planner, which is your veto window, and the pending list is paged. The authority suspends itself on the first escalation traced to bad criteria. Everything else still waits for `Approved`. Of these items, only this one raises intake (F1).
10. **Merge fallback after a "Merge Without Review" refusal.** Build it only after the item 4 rulesets and the Nidus ruling.
    - When the lead's `gh pr merge` is refused under that one category, pr-watch merges only if all of these hold:
      - the record is in `review`;
      - the lead recorded an explicit merge verdict at the PR head;
      - there are no open blocking findings;
      - `fleet-review` and every `ciGates` check are green;
      - `git diff --name-only` shows no carve-out or sealed path;
      - the base is the tenant's `defaultBranch`.
    - The merge runs under the fleet identity with `--match-head-commit`. `run-pr-watch.ps1` does not set that identity today.
    - Every other refusal category still goes to you.
    - Run it in shadow for one week first.
    - This takes most of the 27.8 h a week of classifier-merge waits off you, while the classifier keeps catching what it caught this week.
11. **Retire the dispatcher, with its prerequisites.**
    - The dead-man switch has sent a test silence page. The dispatcher is the watchdog's only watcher today.
    - Pages have been delivered for 7 days (fleet #82).
    - Its 07:57 status digest and escalation relay have a replacement (`daily-summary.js` covers part).
    - Its remaining references are removed: roster `parent`, `sentinel-check.ps1:466`, the role texts, `launch.ps1:74`, `research-gate.ps1:15`.

    It frees one of the six session slots, so ICs get a fourth slot, 33% more IC capacity in the 16.5% of hours when the cap binds. It also saves about $30 a week.

### C. Measure, then decide

12. **Review pickup latency.** Measure checks-settled to the start of review per unit. If the 15-minute watchdog tick dominates, deliver checks-settled wakes on pr-watch's 5-minute tick. Review is the largest time bucket inside a unit (F1).
13. **Lean wake.** Measure what a freshly rotated lead reads before its first action. Keep README (83 KB) and CONTEXT.md (21 KB) off the default path, and inject a one-screen digest of the record it was woken for.
14. **Pin the finder model in `agents/project-lead.md`** (`model: sonnet`), so it no longer depends on the user-level CLAUDE.md. This costs nothing; the saving is already realized.

### D. Consider later: split the formal review out of the lead

15. A one-shot reviewer per settled PR, on the same model with the same rubric and the same record door, would remove the review queue behind a busy or blocked lead.
    - The lead would keep the judgment it holds today: of 87 manifests since 09-22, 72 carry lead-chosen context headings, 46 carry ADR paths, 32 are risk high, and 13 had premises re-read. It would also keep the IC's peer role, exclusions and spec-parent closes.
    - This needs an ADR superseding ADR 0004's lead-as-session and a parity check per duty. Decide after items 6, 12 and 13 show where review time actually goes.

### Quality guardrails that do not move

- Every PR gets a formal review at the merged head.
- `fleet-review` stays a required check on Endzone `integration`, and is added on Nidus `master`.
- The risk reviewer runs on triggers.
- Carve-outs stay human-merged.
- The weekly second read continues.
- Each automation above ships in shadow first. The scorecard's quality rows gate each cutover, and a worse week rolls it back.
- Classify the bugs opened each week: the escape rate cannot be measured while 8 of 9 are unclassified.
- Send-back is 36.5%. Feed the week's top review categories into the IC self-check (09-17 item M). Severity and `category` are enforced now; the feed does not exist yet.

### Not worth your time now

- **5-minute cache TTL:** no net saving over all transcripts (F7).
- **Principal on Opus 5.5:** ADR 0011 pins the Principal to Fable, and switching would void the graduation evidence. The saving is about $100 a week.
- **Release train:** releases already reach production in a median 3.4 h, and automating Render promotion has known traps (SHA fixed at dispatch, client-only releases, #421 migration lockstep).
- **Haiku IC tier (WS7):** ICs cost about $2.30 a unit.
- **Raising `maxIcs`:** the binding limit is the global six-session cap, and item 11 adds a slot for free.
- **Wake-without-restart plumbing (F7).**

## Expected effect

| Measure | Now | After A and B |
|---|---|---|
| Waits you hear about | since 14:15Z today; the dead-man switch and notifier still off | all of them, including silence |
| Classifier-refused merge wait | 27.8 h/wk, median 3.9 h per PR | mostly gone (item 10) |
| Approval wait, bounded class | p90 5.4 h | 2 h veto window (item 9) |
| Escalations per week | 38 | about 27 |
| IC slots under the cap | 3 | 4 (item 11) |
| Control plane per unit | about $8 | about $6.50 |
| Token meters | about 2x | 1x (item 5) |

## Not determined

- Waits before 09-23T21:17Z: no human-wait rows exist for that period.
- Pickup latency from checks-settled to the start of review (item 12).
- How much of a woken lead's context is orientation and how much is review reading (item 13).
- How many rotations the token line triggered, rather than wakes or merge counts, and so what item 5 changes in cost.
- What caused the `-1m` heartbeat readings behind the 41 false `fleet-dead` pages on 09-23 and 09-24, and whether a later change fixed it or it is dormant.
