---
status: accepted
---

# Budgets are measured crossings; the ledger is verified before it is archived

A unit's token budget is enforced from its session transcript, not from anything
a session reports about itself, and it is enforced as two crossings, not a
running meter. `bin/budget.js` measures every active IC on the watch tick (job
tokens = input + output, the definition rotation and the collector already use;
cache fields are never folded in). At the warning threshold the Work record gets
one `budget-warning` event carrying the measured count. At the escalation
threshold the record is escalated with decision evidence and a decision-needed
wake, unless an approved extension raises the line; an extension is granted only
by Cory, through the state command, with an amount and a reason, and is itself
one event. Between crossings nothing is written: the live figure is a projection
in `state/budget/last.json`. A unit with no roster session or no transcript is
`unmeasured` and is never escalated, because an unknown spend is not evidence of
an overspend.

The event ledger is verified before it is trusted. `bin/verify-events.js`
replays every record's events, active and archived, and reports sequence gaps,
duplicates, reorders, revision regressions, a reconstructed state that differs
from the claimed one, and an archived evidence index pointing at a file that
does not exist or does not hold that record. Its verdict is the gate on the
30-day event archival in `work-state.js`: no fresh passing verdict, no file
moves. Moving a file the verifier has not blessed is how a gap becomes
permanent.

Every behaviour the cycle spec lists is independently reversible behind its own
flag, with a test that flips the flag and proves nothing else moves. Event
state is the one exception, on purpose: once `assignment-live` stands it is the
substrate the planner runs on, and its rollback is `rollback-assignment.ps1`,
which hands authority back to the roster.

## Why

The spec's budgets are stated per completed unit and per merged pull request,
and as a median over ICs; the collector reported only sums, so none of them had
ever been computed. Computing them (and asking GitHub about every unit rather
than only those whose transcript showed a merge, which reclassified 74
"unverified" units as the merged units they were) gave the first honest reading:

| Budget | Target | Seven days to 2026-09-09 (135 units) |
| --- | ---: | ---: |
| Control-plane fresh per completed unit | 70% below 201,505 | 31,246, 84.5% below |
| Project-lead fresh per merged PR | under 25,000 | 13,829 over 182 merged PRs (18,643 per completed unit) |
| Median IC job tokens | under 60,000 | 125,644 (p90 420,145) |

By model, the IC line splits cleanly: sonnet median 52,023 over 56 units, under
the budget; opus median 217,397 over 79 units. The failing budget is the opus
tier, retired by amendment 14 the same morning. Arming a 75,000 escalation
against that sample blind would have escalated most running ICs on the first
tick, which is why the actor ships in shadow and the arming is a ruling.

The ledger had 2,043 events over 157 records and had never been checked. The
30-day archival ran unconditionally on every lock acquisition; it had not bitten
only because the oldest file was eight days old. The verifier's first live run
found zero findings and zero orphans.

## Consequences

- `config/cycle.json` gains `ic.warnTokens` (50,000) and `ic.escalateTokens`
  (75,000), and `budgets` (the spec's targets plus the 08-25..09-01 baseline of
  201,505 control-plane fresh tokens per completed unit) which the collector's
  seven-day report is scored against.
- The first-turn ceilings are calibrated: measured first-turn cache creation
  floors at ~15,500 for tenant-repo sessions and ~9,500 for control-plane ones,
  so `baselineTokens` is 10,000 and every ceiling rose by that amount. The
  gate therefore refuses exactly what it refused before (the spec's headroom is
  preserved); what changed is that the estimate now approximates measured
  cache creation at the floor (lead 15,507 against a 15,579 floor) instead of
  counting only what the door injects. The residual undercount (IC 13,672
  against a 19,156 median) is what a session reads in its first turn, which no
  launch-time estimate can see.
- Ticket 05's lower bound is observed rather than blocked: a merge on a record
  with no formal review recorded completes as a fact (GitHub is authoritative)
  and carries a decision-needed wake. Its flag is `merge-review-wake-off`.
- An extension is the new absolute escalation line, never an increment; a
  grant at or below the configured line is recorded, reported ineffective, and
  does not stop the escalation.
- The project lead resolves a budget escalation only after Cory has granted an
  extension, or winds the unit down; a warning is information for its status
  file, never an action.
- Two rulings remain Cory's and are not defaulted here. (1) When to create
  `state/flags/budget-live`: as specced, now that ICs are haiku or sonnet; or
  warning-only for a week first; or hold. (2) Whether the watchdog may relaunch
  an idle project lead when the planner's frontier turns non-empty. No script in
  this fleet can message a session, so that relaunch is the only wake a script
  can deliver, and it is the only way the lead's hourly frontier cron (six
  polling turns in seven days, against a target of zero) retires. It is also the
  largest new authority any script here would hold.

## Status note - 2026-09-09

Landed with tests: `tests/budget.tests.js` (10), `tests/verify-events.tests.js`
(8, including the archival gate, fail-closed reads and `--sample`), the
collector's per-unit metrics (a true median, merged PRs counted from merge
events), amendment 9 classifications and window labels, the `pr-watch-off`,
`review-dedup-off` and `merge-review-wake-off` drills, and the retirement
cleanup allowlist against user-owned paths. A review round (Standards + Spec)
found and fixed: the extension line ignoring a grant below the threshold, the
archival gate comparing against a date instead of the newest write, the
verifier failing open on an unreadable state file, `--sample` being inert,
orphaned records not failing the verdict, `review-dedup-off` defeated by the
default replay key, and the per-model split quoted from a hand computation. `bin/run-pr-watch.ps1` runs
the budget actor and the verifier after every watch tick; `bin/status.ps1`
prints a `budget:` and a `ledger:` line. Not done, and stated in the ticket:
shadow parity for notifications and reservations (no evidence can exist before
those paths are live), zero polling turns (needs ruling 2), and the IC budget
armed (ruling 1).
