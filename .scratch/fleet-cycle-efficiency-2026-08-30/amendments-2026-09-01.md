# Amendments and authorization - 2026-09-01

Ruled by Cory 2026-09-01 in a /grill-with-docs session run from his own
Claude session (rounds Q1-Q22; every recommendation approved). This file
amends `spec.md` and its tickets; where they disagree, this file wins.
Runtime implementation is AUTHORIZED. (If `spec.md`'s Status line still says
"not authorized", that single line is waiting on `apply-stage1-pending.js` -
the implementing session's edit to it was classifier-denied.)

## Independent verification of the baseline

A second measurement (Cory's session, 2026-09-01, aggregating every fleet
job's transcript usage fields directly) corroborates the spec's 2026-08-30
baseline and sharpens the diagnosis:

- The project lead is the sink, and it is context volume, not model price
  alone: the 08-25..09-01 incarnation held ~530K tokens of context re-read on
  every one of its 9,667 assistant messages (5.12B cache-read tokens, 11.9M
  output). All project-lead jobs together: ~81% of fleet cache-read volume,
  ~70% of output tokens.
- ICs are cheap: all 22 completed ICs combined are roughly one-twelfth of the
  project-lead line (68.4M vs 147.9M fresh tokens on the 7-day collector
  view).
- Launch retry storms exist and are invisible: ic-284 failed five launches in
  nine minutes (08-25), ic-502 twice (08-27); no transcript, no page.
- The 7-day collector window ending 09-01 contains the 08-28..09-01 outage,
  so its per-unit figures undercount steady state; the spec's 08-30 baseline
  table remains the honest reference.

## Sequencing (one change per relaunch cycle)

- Stage 1 - executed 2026-09-01 (this commit): context diet and paperwork;
  see "Stage 1" below.
- Stage 2: 08a -> 04 -> 06. (08a implemented 2026-09-01 - see ticket 08's
  Answer; its scheduled shadow log accrues toward 08b's 48-hour parity gate.)
- Stage 3: 05 -> 07 -> 08b -> 02/03 cutover (the shadow assignment path
  becomes authoritative) -> 09 last, as the verification gate. Ticket 01's
  seven-day observation window (collector running since 09-01) must have
  elapsed before 09 enforces budgets.

## Amendments

1. **Ticket 08 splits into 08a and 08b.** 08a: the scheduled supervisor runs
   in shadow, plus the external page path - a Task Scheduler check that pages
   on daemon-dead / stale-heartbeat (Windows toast) and writes a red banner
   `status.ps1` prints first. 08a does not depend on ticket 07 (a toast is
   not the notifier) and leads Stage 2 because it is the only piece that
   fixes down-detection - the 08-28..09-01 silent-outage class. 08b: Sentinel
   removal; keeps `Blocked by: 07` and the 48-hour parity gate (ADR 0004).
2. **Launch retry cap (new, lands in 08a).** Two consecutive failed launches
   of one name put its issue on skip-hold (`launch-failed: <detail>`) and
   page once. The third identical attempt never finds the cause.
3. **Project-lead model: staged descent, not Sonnet-now** (amends "Context,
   tools, and session lifetime" and ticket 06). Effort dropped xhigh -> high
   in the role file (Stage 1; applies at next relaunch); model stays Opus 5
   until rotation (06) and wake-on-change (04) have soaked; then a one-week
   Sonnet trial gated on the collector's review-quality signals (formal
   review passes, reopened PRs). Rationale: 08-22 already proved a Sonnet
   lead under-reviews; rotation kills the volume term first.
4. **IC tiering stays as-is.** Sonnet default, `-Model opus` (pinned Opus
   4.8) at the lead's judgment. Measured ICs are ~1/12 of the burn; the
   optimization effort belongs elsewhere. Revisit only if IC volume grows an
   order of magnitude.
5. **The risk reviewer is spawned by the IC, pre-PR-ready** (amends ticket
   05). A worker's traffic bills to its spawner's context, and the project
   lead is the context under budget. Risk-tier mapping: every PR gets the
   lead's one independent Standards+Spec review; a configured trigger adds
   the IC-hosted risk reviewer (findings recorded once, on the PR); trivial
   diffs get the lead's review only. The lead's UI `qa-reviewer` spawn moves
   to the IC at ticket 05, not before.
6. **Dispatcher endpoint** (amends "fresh daily"). Interim: Sonnet/low at its
   next launch (role-file change in `apply-stage1-pending.js`). After 07+08
   land: the standing Dispatcher retires; digests and paging are script
   projections; Cory launches or attaches a dispatcher on demand. Escalation
   delivery moves to escalation files + the 08a page path before the
   standing session goes.
7. **The payload lives on the issue** (new rule; role docs updated in Stage
   1). Briefs, doc payloads, and anything an IC must follow are an issue
   comment or a committed file the issue links; a message nudges and points,
   never carries the only copy; non-public material goes in the fleet repo,
   linked by path from the issue.
8. **Metrics.** The spec's budgets are the token metrics. Two collaboration
   metrics join 08a/09 verification: a dead fleet pages Cory within one
   supervisor interval; false escalations are zero over a rolling week (the
   08-27 daemon "blocked"-mislabel class counts as false). Precisely: a page
   lands within one 15-minute supervisor interval of the 45-minute staleness
   threshold being crossed - worst case ~60 minutes from death - and PAUSE or
   a fresh relaunch suppresses staleness paging by design. False-page
   measurement reads the shadow log's `newlyPaged` entries;
   `state/watchdog/paged.json` holds only current conditions, not history.
9. **Collector verification errors become terminal classifications** (ticket
   01 follow-through; code change deferred to the ticket): `CLOSED without
   mergedAt` -> `abandoned`; `PR not returned` -> `no-pr`. Excluded from
   budget denominators, not re-reported daily as errors.
10. **h.tmp stays.** Q20 ordered deletion, but ticket 09's acceptance
    criteria name `h.tmp` and `bin/memory-link-audit.js` as user-owned
    material cleanup must not remove. The stricter rule wins; deletion is
    Cory's hand if the file is truly stray.
11. **Glossary and ADRs.** `CONTEXT.md` gains **Rotation**; the **Sentinel**
    entry is rewritten at 08b cutover, not before; "dynamic workflow" was
    already an avoided synonym under **Fleet cycle**. ADR 0005 records the
    bounded-lifetime decision. Post-QA 2026-09-01: **Watchdog** added as its
    own term, and **Escalation**'s only-pager sentence scoped to the
    reporting line (the Watchdog's out-of-band page is the exception).
12. **Skip-file BOM handled reader-side only.** `state/skip/endzone.json`
    keeps its BOM (the classifier denies even Cory's session writes to that
    file); `bin/assignment.js` strips a leading BOM before `JSON.parse`
    (in `apply-stage1-pending.js`). PowerShell readers already tolerate it.
13. **Tenant-side note (Endzone, not fleet):** `docs/adr/` numbering
    collides - two files prefixed 0010, and 0012 duplicates a 0010 title.
    The fix travels as an ordinary tenant PR.

## Stage 1 - landed by the implementing session

- `agents/project-lead.md`: effort xhigh -> high; the one-carve-out-cycle
  rule; the payload-lives-on-the-issue rule.
- `agents/ic.md`: a message-only instruction is a stop condition until it
  lands on the issue.
- `CONTEXT.md`: **Rotation** added.
- `docs/adr/0005-control-plane-sessions-have-bounded-lifetimes.md`.
- `bin/retire.ps1`: archives the full roster row to
  `state/archive/roster-retired-full.jsonl`, then strips `prompt`, at every
  retirement.
- `state/archive/NOTICE-2026-09-01.md`: the full 33,036-byte notice ledger,
  archived byte-for-byte. `state/notices/{all,ic,project-lead}.md`: staged
  scoped boards carrying the still-operative content.
- `spec.md` inline amendment annotations; tickets 04-09 -> `ready-for-agent`
  with pointers here.

## Pending Cory's hand (classifier-denied to the session)

One command applies all six, idempotently, with asserted anchors (hardened
after same-day adversarial QA: steps are isolated, the NOTICE trim archives
whatever it replaces to a timestamped file every time, and the roster step
refuses to run without `state/PAUSE`):

    powershell -File C:\Users\Cory\fleet\bin\pause.ps1 -Reason "stage-1 roster diet"
    node C:\Users\Cory\fleet\.scratch\fleet-cycle-efficiency-2026-08-30\apply-stage1-pending.js
    powershell -File C:\Users\Cory\fleet\bin\pause.ps1 -Off

1. `spec.md` Status line -> AUTHORIZED (removes the internal contradiction).
2. `agents/dispatcher.md` -> model sonnet, effort low (takes effect at the
   next stop + `launch.ps1 -FromRoster dispatcher`; respawn re-pins).
3. `hooks/session-start.ps1` -> inject `state/notices/{all,<role>}.md`;
   a legacy `state/NOTICE.md` still prints, flagged as the retired path.
4. `bin/assignment.js` -> BOM-tolerant `readFixture`.
5. `state/NOTICE.md` -> trimmed board (33,036 -> ~1K bytes; ~8.3K tokens off
   every session start).
6. `state/roster.json` -> one-time diet: 172 retired entries archived in
   full, `prompt` stripped (~1.0MB -> ~76KB read at every launch and hook).
