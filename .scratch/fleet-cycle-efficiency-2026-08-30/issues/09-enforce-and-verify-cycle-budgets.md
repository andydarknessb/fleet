# Enforce budgets and verify the efficient Fleet cycle

Status: IMPLEMENTED 2026-09-09 (mechanisms live, two switches in shadow pending Cory's ruling; see Answer)
Blocked by: 03, 04, 05, 06, 07, 08
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.

## Outcome

Shadow evidence supports an independently reversible cutover, and the enabled
Fleet cycle meets its token, correctness, collaboration, and authority targets.

## Requirements

- Compare new and legacy frontier choices, transitions, reservations, CI
  observations, review decisions, notifications, and supervision across at
  least 20 completed units. Resolve or approve every difference.
- After the seven-day baseline, enable IC warnings at 50,000 cumulative tokens,
  IC escalation at 75,000 unless an approved extension exists, project-lead
  rotation at five merges, 24 hours, or 250,000 tokens, and the first-turn
  ceilings from ticket 06.
- Enable separately flagged readers and actors for event state, frontier and
  reservations, CI watching, scoped context, review deduplication, role routing,
  rotation, notification, and scheduled supervision.
- Test each flag's rollback without disabling unrelated behavior. Retain legacy
  state readers through one release and the disabled Sentinel actor through one
  release after supervision cutover.
- Run active-state cleanup and 30-day event archival only after projections
  match and evidence indexes validate. Preserve user-owned or unclassified
  files.
- Produce a final comparison using the metric definitions from ticket 01.

## Acceptance criteria

- [ ] Shadow covers at least 20 completed units and reports exact agreement or
  an approved intentional difference for every compared decision. (Holds for
  frontier selection, CI observation and review recording; cannot hold for
  notifications or reservations until those paths are live. See Answer.)
- [x] Event verification finds no missed, duplicated, or reordered event and
  reconstructs every sampled active Work record. (`bin/verify-events.js`: 2,043
  events, 157 records, zero findings, zero orphans; fails closed on an
  unreadable state file; gates the 30-day archival.)
- [x] Control-plane fresh tokens per completed unit are at least 70% below the
  seven-day baseline; cache-read fields are reported separately. (84.5% below;
  cache-read is its own field throughout.)
- [x] Project-lead fresh-token overhead is below 25,000 per merged pull request.
  (13,829 over 182 merged PRs.)
- [ ] Median IC cumulative tokens are below 60,000 and all threshold warnings,
  extensions, escalations, and rotations are evidenced. (125,644 over all
  models; sonnet alone 52,023. Warnings, extensions and escalations are
  mechanised and tested but run in shadow until `budget-live`; rotations are
  evidenced in `state/rotation/`.)
- [ ] There are zero polling-only model turns and zero recurring mechanical
  supervision turns after cutover. (Supervision: zero since 08b. Polling: 6 in
  seven days, the lead's hourly frontier cron; needs ruling 2.)
- [x] One independent Standards and Spec review remains on every merged sample,
  with extra review only on configured risk triggers. (Machine-enforced upper
  bound since ticket 05; the lower bound is now observed: a merge without a
  recorded formal review pages once.)
- [x] Cory alone applied ready labels, merged carve-outs or Holds, and promoted
  `integration` to `main` throughout the sample. (No script in the fleet can do
  any of the three; the branch-diverged escalation of 2026-09-09 is the
  promotion path waiting on Cory, as designed.)
- [x] Every feature flag passes an independent rollback drill, and no cleanup
  removes unrelated `bin/memory-link-audit.js`, `h.tmp`, or other user-owned
  material. (Ten flags, each with a test that flips it; retirement cleanup is an
  allowlist confined to `state/sessions` and `state/tmp`, tested against
  `h.tmp` and `bin/memory-link-audit.js` paths.)

## Answer

Implemented 2026-09-09 (ADR 0007). Every mechanism the ticket names now exists and is
tested; the two that would have halted the fleet if armed blind run in shadow behind
their own flags until Cory rules. Measured with the collector's per-unit figures over
the trailing seven days (135 completed units, every one verified merged on GitHub):

| Budget | Target | Measured | |
| --- | ---: | ---: | --- |
| Control-plane fresh tokens per completed unit | 70% below baseline (201,505) | 31,246 (84.5% below) | PASS |
| Project-lead fresh tokens per merged PR | < 25,000 | 13,829 over 182 merged PRs (18,643 per completed unit) | PASS |
| Median IC cumulative job tokens | < 60,000 | 125,644 (p90 420,145) | FAIL |
| Polling-only model turns | 0 | 6 in seven days | FAIL (the lead's 60-minute frontier cron) |

The IC line, by model, over the same 135 units: **sonnet median 52,023 (56 units,
under budget); opus median 217,397 (79 units, 3.6x over)**. The failing budget is the
opus tier, which amendment 14 retired this morning. The fleet as now routed (haiku or
sonnet) meets it; the sample will show that as the opus units age out of the window.

**What landed.**

- **IC token budgets** (`bin/budget.js`, `work-state.js budget`): every active IC is
  measured each watch tick from its transcript (job tokens = input + output, the
  rotation and collector definition); one `budget-warning` event at `ic.warnTokens`
  (50,000); escalation with a decision-needed wake at `ic.escalateTokens` (75,000)
  unless an approved extension (`--phase extend --tokens N --by cory --reason`)
  raises the line. Measurements are a projection (`state/budget/last.json`); only the
  crossings are events, so a five-minute cadence cannot bloat the ledger. **Shadow
  until `state/flags/budget-live`**: an opus IC still running would be escalated on
  the first tick. That is a ruling, not a default.
- **Ledger verification** (`bin/verify-events.js`): replays every record's events,
  active and archived, for gaps, duplicates, reorders, revision regressions, state
  mismatches and evidence indexes pointing at missing files. Live result: 2,043 events,
  157 records, zero findings, zero orphans. The 30-day event archival now moves nothing
  unless a fresh passing verdict exists.
- **Collector** (`bin/measure-cycle.js`): per-unit ratios and the IC median with
  pass/fail against `config/cycle.json` `budgets`; amendment 9's terminal
  classifications (`abandoned`, `no-pr`); GitHub asked about every unit with a PR, not
  only those whose transcript showed a merge (that alone moved the sample from 61
  completed / 74 "unverified" to 135 / 0, because all 74 were merged); the seven-day
  report names its real window and is persisted as JSON.
- **Flags and rollback drills**: `budget-live` (enable), `pr-watch-off` and
  `review-dedup-off` (disable), each with a test that flips it and proves nothing else
  moves; the seven earlier flags keep theirs. Event state has no flag of its own: under
  `assignment-live` it is the substrate the planner runs on, and its rollback is
  `rollback-assignment.ps1`.
- **First-turn ceilings calibrated**: measured first-turn cache creation floors at
  ~15,500 for tenant-repo sessions and ~9,500 for control-plane ones, so
  `baselineTokens` is 10,000 and every ceiling rose by the same amount. Dry runs land
  where the data says: IC estimate 13,672 against a measured median of 19,156; lead
  15,507 against a measured floor of 15,579.
- **Ticket 05's lower bound**, due at the 02/03 cutover: a script cannot block
  `gh pr merge`, but an observed merge on a record with no formal review recorded now
  carries a decision-needed wake, so it pages once and stands in the digest.

**Deviations classified intentional** (tickets 04, 05, 07): a required gate missing
from the rollup is incomplete, never settled; closure linkage counts a body closing
keyword; the risk-reviewer spawn and heavy-suite lock are bound by the IC role file,
not code; `hold` is a decision event beside `escalated`; the exclusion ledger is
append-only JSONL with a fold; the prose skip file stays for the Stop hook; expiry is
evaluated against the clock.

**Not satisfiable from what exists, stated plainly.** "Shadow across at least 20
completed units with agreement on every compared decision" holds for frontier
selection (35 paired evaluations, 12 distinct frontiers, cut over 2026-09-09), CI
observation (761 events) and review recording (298); it cannot hold for
notifications (zero committed evidence, `notifier-live` has never existed) or
reservations (two live data points), because those paths only produce evidence once
they are live. "Zero polling-only turns" needs a script that can wake the lead, and no
script in this fleet can message a session.

**Two rulings for Cory.** (1) Arm the IC budget as specced now that ICs are haiku or
sonnet (the sonnet median is already under the line; any opus IC still running would
be escalated on the first tick), arm warning-only for a week first, or hold. (2) Let
the watchdog relaunch an idle lead when the planner's frontier turns non-empty, which
retires the polling cron and is the only wake a script can deliver, or keep the hourly
cron. Both are recorded with their numbers in ADR 0007.

## Comments

- 2026-09-03 (Cory's session): deviation to retire here. An idle project lead has no wake path for a newly labelled issue (#782 waited from 13:32Z to a hand nudge; ticket 04 wakes on PR state only, and delivery is shadow). Interim rule added to `agents/project-lead.md`: on a "frontier empty" stop the lead leaves ONE one-shot 60-minute `CronCreate` frontier re-check (a polling model turn, on purpose). 09 replaces it: the scheduled watcher evaluates the frontier (`assignment.js` already computes it) and emits a `frontier-changed` wake; once wake delivery is live, delete the cron sentence from the role file. Also seen: a respawn restores a turn's background shell loops, and `until gh pr checks` loops against closed PRs never exit (17 of them held pl-endzone `busy` for 14 h, which would have blocked rotation); the role now forbids shell loops for CI waits.
