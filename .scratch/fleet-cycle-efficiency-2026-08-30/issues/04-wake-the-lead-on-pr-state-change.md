# Wake the project lead only when an active PR changes state

Status: ready-for-agent
Blocked by: 02
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.

## Outcome

One open pull request moves from `pr-open` through `ci-wait` without model
polling, and the project lead wakes only when checks settle, fail, or require a
decision.

## Requirements

- Add a deterministic watcher for pull requests referenced by active Work
  records. It runs mechanically and invokes no model.
- Reconcile PR state, head SHA, required gates, watched checks, ignored checks,
  review state, merge state, and closing-keyword linkage from GitHub.
- Treat a missing required gate as incomplete, never settled. Preserve the
  existing semantics of watched and ignored checks.
- Write an event only when an observed value changes. Repeated identical polls
  update no record, append no event, and wake no session.
- Emit a project-lead wake only for `checks-settled`, `checks-failed`, or
  `decision-needed`, with Work record revision and evidence pointers.
- Move a merged PR to `merged`. Do not close its issue manually; verify GitHub's
  closing keyword owns issue closure and escalate a missing linkage before
  merge.
- Fail safe when GitHub is unavailable: retain the prior observation, expose
  watcher health, and do not infer success or absence.

## Acceptance criteria

- [ ] Fixtures cover pending, success, failure, skipped, cancelled, missing,
  watched, ignored, and unclassified checks.
- [ ] One hundred identical watcher runs append no event after the initial
  observation and create no model turn.
- [ ] A changed gate state appends exactly one ordered event and one eligible
  wake; an idempotent retry appends neither.
- [ ] Missing required gates cannot produce `checks-settled`.
- [ ] GitHub failure produces visible watcher health evidence without changing
  the Work record to a successful state.
- [ ] A PR without the required closing linkage reaches `decision-needed`; the
  project lead has no unconditional issue-close path.

## Answer

Implemented 2026-09-01 as `bin/pr-watch.js` (a deterministic watcher driving
the ticket-02 state command in-process) with `bin/run-pr-watch.ps1` +
`bin/install-pr-watch-task.ps1` (every 5 minutes while logged on; logon PT6M,
behind recovery and the watchdog) and 18 node cases in
`tests/pr-watch.tests.js` plus the installer test. `bin/work-state.js` gained
`observe` (a PR observation event without a state change; the caller compares
digests first, so identical polls never touch the store) and a
`reconciledObservation` path so an observed merge satisfies the merged guard.

Each run shadow-projects the roster, then per active record: discovers an
implementing record's PR by branch prefix (-> pr-open), moves pr-open ->
ci-wait on first observation, and on a changed digest appends exactly one
event - settle with verified closing linkage -> review with wake
`checks-settled`; a gate failure -> `pr-observed` with wake `checks-failed`;
a settled PR without linkage -> escalated with wake `decision-needed` (the
watcher has no issue-close path of any kind). A missing required gate is
incomplete, never settled - a deliberate divergence from the legacy stop
hook, which skips absent gates; classify it intentional at ticket 09.
Closure linkage counts `closingIssuesReferences` OR a body closing keyword,
because this tenant closes issues through the #330 close-merged-issues
workflow, which parses the body (live PR #613 proved the native field stays
empty while `Closes #601` sits in the body). Escalated records self-heal:
linkage appearing resolves back to the prior state, and an observed human
merge resolves through review -> merged. A GitHub failure retains every
prior observation and lands in `state/watch/health.json`.

Wakes are eligibility records only: one line each in
`state/watch/wake-outbox.jsonl` plus a marker on the event. Nothing messages
a session - delivery is ticket 07's notifier at cutover, and the legacy
Stop-hook loop stays authoritative during shadow.

Live verification (2026-09-01): across four scheduled-shape runs, the real
record for #601 / PR #613 walked implementing -> pr-open -> ci-wait ->
escalated (a true positive on the empty native linkage) -> review -> merged
when the project lead merged it mid-verification, then steady-state runs
with zero actions and zero events.

Same-day /code-review (15 verified findings, all with executed repros)
forced a redesign at the two altitudes it named. Idempotency keys are
retry-dedupe only: every key is scoped to the revision it acts on, so
novelty stays digest-vs-stored, recurrences re-wake, and nothing replays
into a permanent wedge. Every multi-hop path (merged fast-forwards,
escalation resolutions) is computed by BFS over the store's exported
TRANSITIONS, never a hand-coded table. Further fixes: the watcher resolves
only escalations carrying its own `[pr-watch]` mark (a human's hold is
never touched; note the evidence string carries a `wake:<kind>; ` prefix,
so provenance is containment, not prefix); linkage uses the tenant
parser's grammar (colon, URL, and owner/repo forms; code stripped;
same-line whitespace) and is re-verified every tick during review/hold;
draft conversions and beyond-the-list open PRs are watched through the
view, never mistaken for closed; `revision` joined the watch set; a
per-record failure marks watcher health not-ok; the open list fetches
headRefOid so a force-push changes the digest; merged chains refresh the
final observation to match the merged reality; and the shadow projection
runs at the END of a tick, so an advance is always recorded before a
roster-dropped record is archived (a freshly launched IC is therefore
watched from its second tick). The event ledger is the authoritative wake
record; the outbox is a post-commit convenience cache whose crash window
the ledger covers. 26 node cases.
