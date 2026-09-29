# Rulings on the 2026-09-29 audit

Ruled 2026-09-29 by this session at Cory's request ("make a ruling"). Cory can overturn any of them. Nothing here is applied yet. Each item names what must change and in what order. The audit itself is `report.md` beside this file.

## R1. `fleet-dead` drops from emergency to high priority

- Set `config/cycle.json` `pages.priority["fleet-dead"]` to `high`. Keep the one repeat at 2 h (`fleetDeadRepeatMinutes`). `dead-man-silence` stays at emergency: when the PC or the watchdog is gone, nothing else can page.
- Why: emergency priority makes Pushover repeat every 2 minutes for up to 2 hours until acknowledged. That fits "production is down", not "the fleet stopped taking turns". fleet-dead costs throughput, never users. Since 09-25, its episodes mostly meant every session was waiting on Cory, and each of those waits already has its own page.
- The double page ends structurally with audit item 6. Once asks live on Work records as a hold or an escalation, the waiting work no longer counts toward `fleet-dead`, because ADR 0012 says hold and escalated never count.
- Paperwork: a one-line amendment to ADR 0012's priority table.

## R2. Nidus migrations become carve-outs

- Add `supabase/migrations/**` to `carveOuts` in `tenants/nidus.json`. Keep it in the `auth` risk trigger too, so a migration gets the opus risk review and then waits for Cory.
- Rule for both tenants: any path that changes production when merged is a carve-out. Check whether any Nidus workflow deploys `supabase/functions/**` on a merge to `master`. If one does, functions are carve-outs too.
- The one-carve-out-cycle rule (#421: merge and apply in the same sitting) applies to Nidus as it does to Endzone.
- Why: Nidus `master` is its release branch, and its migrations carry the household RLS policies, so a bad one exposes data. The classifier already refuses these merges some of the time. A carve-out makes the hold deliberate and paged instead of a refusal that happens only sometimes.
- Check now: whether Nidus #26's migration (`20260929000001_pairing_claim_limit.sql`, merged by Cory at 14:00Z) has been applied.

## R3. Add both rulesets

- **Endzone `main`, "release-only".**
  - Rules: restrict updates, block deletion, block force-push.
  - Bypass: the repository admin role (Cory) only. The fleet identity has write access but is not an admin, so it can no longer update `main`.
  - This makes ADR 0015's sentence true ("the release ruleset is what enforces it"); add a status note there.
  - Before creating it, check that no workflow pushes to `main` with `GITHUB_TOKEN`. If one does, it needs a bypass entry or a change.
- **Nidus `master`.**
  - Rules: require the `ci` and `fleet-review` status checks, block deletion, block force-push.
  - Bypass: Cory (admin) only; the fleet identity gets none (ADR 0015).
  - Cory's own Nidus PRs take `review-policy.js attest`, as on Endzone, or his bypass.
- **Endzone `integration`** gains block-deletion and block-force-push alongside its existing required checks.
- Why: the fleet account can write to the branch that auto-publishes the Endzone client, and Nidus merges straight into its release branch with nothing required. Both rulesets are prerequisites for R6.

## R4. Fix the double count, then halve the triggers in the same PR

- Dedupe usage by `message.id` in `bin/measure-cycle.js` and in `sumTranscriptTokens` (`bin/rotation-policy.js`), counting each API call once.
- In the same PR, halve the triggers that were calibrated on the inflated meter, so behavior does not change on the day the meter becomes honest:

  | Trigger | From | To |
  |---|---|---|
  | `rotation.project-lead.maxJobTokens` | 250,000 | 125,000 |
  | `rotation.principal.maxJobTokens` | 250,000 | 125,000 |
  | `ic.warnTokens` | 50,000 | 25,000 |
  | `ic.escalateTokens` | 350,000 | 175,000 |

- The references are not halved; they are re-baselined: `budgets.*` and the scorecard thresholds get re-set from the first two weeks of de-duplicated data at the 2026-10-19 scorecard, the point fleet #139 already scheduled.
- `baselineControlPlaneFreshPerCompletedUnit` (201,505) is void: it was measured on both the old undercount and the double count.
- Token figures published before the fix stay as they are, with one note in the scorecard that they read about 2x.
- Why: every threshold was tuned against the numbers the meter produced, so halving keeps the tuning, and the fleet changes one thing per cycle. Re-calibrating in honest units is a separate, measured step.

## R5. The Principal may mark bugs ready itself, on Endzone only

Amend ADR 0011; do not supersede it. The bar is met: 120 of 124 decided proposals approved unchanged (96.8%), over 17 days.

- **Class:** exactly what ADR 0011 decision 3 names. All of these must hold:
  - Classification `bug`, with a reproducible `Red-tell`.
  - `Ruling: none needed` and `Open for Cory: none`.
  - `Scope` outside every carve-out path and every risk-trigger path.
  - Tier haiku or sonnet.
  - Every premise verified at the proposal's SHA.

  Anything else waits for `Approved`, as today.
- **Veto window.** When the Principal applies `ready-for-agent` itself, it pages Cory once at normal priority, with a link. The planner will not assign the issue for 2 hours.
  - A comment from `ownerLogin` that begins with `Hold` withdraws it. The planner excludes the issue and the proposal goes back to waiting for `Approved`.
  - Since the 09-25 identity cutover, the owner's comments and the fleet's are distinguishable by author.
- **Cap and suspension.** At most 5 a day. Authority suspends itself, by writing a flag that only Cory lifts, on any of these:
  - the first escalation or send-back whose finding says the criteria were wrong or ambiguous;
  - the first escaped defect traced to such a ticket;
  - a veto.
- **Ledger.** These record as their own kind, so they never count toward the unchanged ratio that earned the authority. The weekly scorecard gains a row: self-approved, vetoed, suspended.
- **Nidus** stays on `Approved` until it meets the bar itself: 30 proposals over 14 days.
- **Model.** The Principal stays on Fable, per ADR 0011 decision 4.
- Why: throughput is set by intake, and approval waits were 26 session-hours a week (p90 5.4 h). The class is the narrowest one the ADR allows, and the veto is real now that pages deliver.

## R6. Yes to a merge fallback after a "Merge Without Review" refusal, built last and narrowly

Order:

1. Tighten `autoMode.environment` in `fleet-settings.json`: state that the owner authorized fleet merges into each tenant's default branch after a recorded formal review and the required checks (ADR 0014, ADR 0015). That is the documented remedy for classifier false positives, and it costs nothing.
2. Build the fallback only after R2 and R3 are live.

Conditions:

- **Trigger:** only a refusal in the "Merge Without Review" category. Every other category goes to Cory as today: Production Deploy, Self-Approval, Interfere With Workloads, migrations, and anything unrecognized.
- **Merge only when all of these hold:**
  - the Work record is in `review`;
  - the lead recorded an explicit merge verdict at the PR's current head, through a new field on `review-policy.js record`, since a green `fleet-review` is not a merge verdict;
  - there are no open blocking findings;
  - `fleet-review` and every `ciGates` check are green;
  - `git diff --name-only` shows no carve-out and no sealed path;
  - the base is the tenant's `defaultBranch`;
  - the head is unchanged, checked with `--match-head-commit`.
- **Identity:** runs as the fleet identity. `run-pr-watch.ps1` must call `Set-FleetIdentityProcessEnv`.
- **Rollout:** one week in shadow, logging what it would have merged. Cory reads the list, then flips a flag. A second flag turns it off.
- **Visibility:** every fallback merge pages Cory once at normal priority, so he sees each one after the fact.

Why: the classifier's "Merge Without Review" rule assumes no human has approved the merge. Here Cory approved the policy (ADR 0014, ADR 0015), and an Opus formal review plus required checks and rulesets stand behind every merge. The refusals in this category cost 27.8 session-hours a week and six hand merges. The things the classifier rightly caught this week (a sealed holdout, a migration) fall under other categories or under R2's carve-out, so they still reach Cory.

## Order of work

R1 (config) and R3 (rulesets) first, then R2 (tenant file), then R4 (one PR), then R5 (ADR 0011 amendment plus planner and Principal changes), then R6 (spec, shadow week, flag). Fleet changes are built in Cory's sessions per ADR 0008. Specs and tickets are cut on Cory's go.

## Grill, round 1 (2026-09-29): Cory approved all 14 recommendations

Where these differ from R1 to R6 above, the grill wins.

1. **Q1.** `fleet-dead` pages at high. The 2-hour repeat also goes at high until item 6 is live, then at emergency. The Watchdog hard-codes the repeat as emergency (`watchdog.ps1:1368`); it must read the configured priority. Recorded in the ADR 0012 amendment.
2. **Q2.** Carve-out now means "alters production when it merges" (CONTEXT.md updated). R2's "Nidus migrations now" is reopened in round 2: Nidus has no hosted database yet (`E:/Nidus/README.md:31`).
3. **Q3.** This session creates the rulesets with `gh api` after showing Cory the JSON, with an admin bypass.
4. **Q4.** Halve the triggers in the dedupe PR. The glossary's **Budget** now says "counted once per model response".
5. **Q5.** The veto is a comment beginning `Veto`, not `Hold`, because **Hold** already means a reviewed PR parked for Cory's merge. New glossary terms: **Bounded authority**, **Veto window**, **Veto**.
6. **Q6.** 2-hour veto window. A ready made between 22:00 and 07:00 Central waits until 09:00.
7. **Q7.** Cap of 5 per day per tenant. A Veto withdraws one ticket and suspends nothing; only criteria failures or an escape suspend. Cory lifts a suspension by deleting the flag. This replaces R5's "a veto" trigger. Recorded in the ADR 0011 amendment.
8. **Q8.** Ship the `autoMode.environment` text, measure one week, and build the merge fallback only if "Merge Without Review" refusals still cost more than about 5 h a week. If it is built, the refusal category must come from the harness's tool-result text in the transcript. The `PermissionDenied` hook payload carries no reason or category, and the lead's own report is not trusted.
9. **Q9.** A session that needs Cory escalates, or holds a PR, and ends idle. Human-wait detection from `needs` stays as a backstop page only. A new wake fires when a record leaves `escalated` or `hold`. The glossary's **Escalation** entry is updated.
10. **Q10.** One shared closing-link parser, and a merged `Refs` PR's issue gets a Frontier exclusion that the issue closing releases.
11. **Q11.** Exact `^Approved\s*$` from the owner, only with the body hash unchanged, never for escalation rulings, finalizes by script.
12. **Q12.** No standing dispatcher. `daily-summary.js`, extended with pending proposals and open waits, plus Pages with the Notifier live, take over its two duties. Cory attaches to `pl-*` to talk to the fleet. The freed slot becomes a fourth IC slot. Gate: a dead-man test page, then 7 days of delivered pages counted from 09-29.
13. **Q13.** Cut tickets now for pickup latency, the lean-wake measurement, and a finder-model pin in `project-lead.md`. Item 15 is deferred.
14. **Q14.** The Principal fills "Escaped from PR #" during triage of every new bug. A weekly review-category report feeds the top three categories into the IC self-check.

Facts found for round 2:
- Endzone's default branch is `main`, no workflow pushes to it, and Dependabot targets `integration`.
- Nidus CI only runs tests, and no production Supabase project exists yet (README:31, ticket #14).
- Cory pushed 36 non-merge commits directly to Nidus `master` in the last 30 days.
- Nidus checks are named `ci` and `fleet-review`.

## Grill, round 2 (2026-09-29): Cory approved all 7

1. **Q15.** Nidus migrations become carve-outs only once Nidus has a hosted project. Nidus #14 gains the criterion "add `supabase/migrations/**` to the Nidus carveOuts". Until then migrations stay under risk review, and the `autoMode.environment` text says Nidus migrations are local-only. This replaces R2's "now".
2. **Q16.** Nidus `master` ruleset: require `ci` and `fleet-review`, block deletion and force-push, with an always-on bypass for the admin role only. Cory's direct pushes are recorded bypasses, and the fleet identity gets no bypass.
3. **Q17.** Endzone `main` ruleset: restrict updates, block deletion and force-push, admin bypass. Release merges may need `gh pr merge --admin` or the web bypass checkbox; that friction is accepted as the release gesture. Endzone `integration` gains block-deletion and block-force-push, per R3.
4. **Q18.** One fleet spec per workstream, with child tickets:
   - WS1 Pages and guards (now);
   - WS2 Honest meters;
   - WS3 Asks and wakes;
   - WS4 Principal authority;
   - WS5 Retire the dispatcher (10-06 at the earliest);
   - WS6 Measure;
   - WS7 Merge-fallback decision (after one week of refusal data).

   WS2 to WS4 follow WS1 this week, and WS5 to WS7 go on their gates. Built in Cory's sessions (ADR 0008).
5. **Q19.** The scorecard gains three rows: "Waiting on Cory" (lead and Principal session-hours, without the dispatcher's repeats), "IC idle share" (with the at-cap share), and "Review pickup latency" (once WS6 measures it).
6. **Q20.** The next audit is 2026-10-13, then monthly, with the weekly scorecard in between.
7. **Q21.** One docs PR from `docs/audit-2026-09-29` carries CONTEXT.md, the ADR 0011 and 0012 amendments, and this report and decisions file. Cory merges it. ADR 0015's status note ships with the rulesets in WS1.

Known constraint for WS1: this session's own classifier has refused to loosen another session's auto-mode rules before, as "Auto-Mode Bypass" (fleet #173). So the `autoMode.environment` edit may need Cory's hand or a session outside auto mode.
