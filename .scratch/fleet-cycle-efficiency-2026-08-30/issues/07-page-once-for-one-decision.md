# Turn one decision event into one digest entry and at most one page

Status: implemented 2026-09-01 (shadow delivery; `state/flags/notifier-live` is the cutover)
Blocked by: 02, 04, 06
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.

## Outcome

A new human decision appears in status and the digest, creates at most one push
notification, and never keeps a model session alive to repeat unchanged state.

## Requirements

- Generate tenant status and fleet digest projections from Work records and the
  event ledger. Do not append model-authored prose to status artifacts.
- Replace free-form exclusion prose with structured Frontier exclusions whose
  reason, evidence, recheck event or expiry, and owner are machine readable.
- Launch a minimal ephemeral notifier only for a new `decision-needed` event.
  It receives the event and evidence pointers, sends one push, records
  `notification-sent` through the state command, and exits.
- A failed notification remains visible as delivery state. Do not retry by
  repeatedly paging or keeping a session alive; a new retry authorization or
  materially new decision event may create a new notification attempt.
- Pointer messages contain Work record id, revision, event sequence, and
  artifact locations. They do not copy issue bodies, criteria, findings, or
  prior messages.
- Preserve the hierarchy IC to project lead to Dispatcher to Cory. Do not add
  free lateral coordination; collisions are resolved through reservations and
  typed events.

## Acceptance criteria

- [x] Rebuilding status and digest from the same event offset is byte-stable.
  (`tests/digest.tests.js`: same offset after the ledger grew; mutation check
  that printing a clock turns it red.)
- [x] One decision event produces one digest item and at most one successful
  notification event across concurrent and repeated notifier starts.
  (`tests/work-state.tests.js`: twenty concurrent claims, one wins;
  `tests/notify.tests.js`: five repeated starts and a reentrant start send once;
  `tests/digest.tests.js`: the item count stays one after delivery.)
- [x] Notification failure is visible but produces no automatic repeated page
  without a new event or explicit retry authorization.
- [x] Expiry or a named recheck event removes a Frontier exclusion from the
  projection without deleting its history. (`tests/exclusions.tests.js`.)
- [x] Message fixtures reject copied acceptance criteria and accept typed
  pointers. (`validatePointerMessage`; a rejected message is recorded as a
  failed delivery and never sent.)
- [x] Cory's authority boundaries are stated in the generated digest and are
  unchanged by notification delivery. (Section compared byte-for-byte before
  and after a `notification-sent`.)

## Answer

Implemented 2026-09-01.

**Projections** (`bin/digest.js`). `state/status/DIGEST.md` (fleet) and
`state/status/<tenant>-status.md` are a pure fold of the event ledger and the
exclusion ledgers at an offset (`--offset`, `--exclusions-offset`; the header
names them and the last event, no clock is printed), rendered as Needs Cory
(one item per decision event: record id, revision, sequence, PR, evidence
pointers, and the delivery line), Active work, Merged, Frontier exclusions
(active and discharged), and Cory's authority (from tenant config: ready label,
carve-out globs, promotion). The clock is consulted only for exclusion expiry.
`run-pr-watch.ps1` rebuilds them after every tick; the notifier rebuilds after
a delivery. Nothing appends to them; the next projection overwrites. The
legacy `state/STATUS.md` and `state/status/<tenant>.md` prose files are
untouched (the Dispatcher is told to read DIGEST.md before writing Needs Cory).
Transition events now carry `changes.prNumber`; older events fall back to the
active/archived record for the PR number.

**Structured Frontier exclusions** (`bin/exclusions.js`). An append-only
ledger per tenant, `state/exclusions/<tenant>.jsonl`, of `exclusion-added`
(issue, one-sentence reason, evidence pointer, owner, recheck = `expiresAt` or
a named event `{type, recordId? | issue?}`) and `exclusion-lifted` entries.
`projectExclusions` folds it against the Fleet event ledger: an exclusion is
discharged by lift, expiry, or the first matching event after it was recorded
(`exclusion-lifted` as the recheck type means only the owner's lift releases
it); nothing is ever rewritten. `assignment.js` reads the projection
(`source: exclusion-ledger`) and still honours the prose skip file during
shadow (`source: legacy-skip`, because `hooks/stop.ps1` reads that file and it
is classifier-locked). The two standing human holds, #125 and #240, were
recorded live as `endzone:excl-125-1` and `endzone:excl-240-1` (owner cory,
recheck `exclusion-lifted`, evidence pointing at the skip-file keys and the
issue material). `state/exclusions/**` joined the Edit-family deny set in
`launch.ps1` and the soft-deny in `fleet-settings.json`; the CLI is the door.

**Notification door** (`work-state.js notify`). Delivery state for one decision
event (`state-escalated` or `state-hold`; `DECISION_EVENT_TYPES`) is keyed by
that event's sequence on the record and written as typed events:
`notification-attempted` (claim), `notification-sent` / `notification-failed`,
`notification-retry-authorized`. The claim is taken under the store lock and
the record revision BEFORE anything is sent, so concurrent starts cannot both
page; a claim is refused when the record has left the decision state
(`DECISION_RESOLVED`), when a claim or a sent delivery stands, or when the
prior attempt failed and no `authorize-retry` (evidence required) has re-armed
exactly one more attempt.

**Notifier** (`bin/notify.js` + `bin/send-toast.ps1`). A process, not a
session: launched detached for one decision event by the three producers that
write such events - `pr-watch.js` on a `decision-needed` wake,
`review-policy.js hold`, and a CLI `work-state.js transition` to escalated or
hold (`--no-notifier` suppresses; a replay launches nothing). It finds the
pending decision (an active record in a decision state whose entering event has
no delivery entry, or a failed one re-armed), claims, composes a pointer message
(title `Fleet decision: <tenant> #<issue>`; body = state, record id, revision,
sequence, PR number, evidence path, digest path), validates it against the
fixture (rejects checklists, "acceptance criteria", headings, code fences,
over-length; a rejected message is recorded as a failed delivery and never
sent), sends one Windows toast through `Send-FleetToast` (extracted from the
watchdog into `_common.ps1`), records the result, and exits. It never waits,
polls, or re-pages. Delivery is gated: without `state/flags/notifier-live` (or
`--live`) it runs in shadow, appending the would-be page to
`state/notify/shadow.jsonl` (deduped per decision and attempt) and touching no
record - the same shadow discipline as the ticket-04 wakes and the 08a
supervisor, because the Dispatcher relay is still the live pager and two pages
per decision would be the opposite of this ticket. Cutover is Cory creating the
flag (README, Day to day). `PushNotification` is a session tool, not a script
one, so the page channel is the toast the 08a path already proved.

**Hierarchy.** The notifier is the script projection of the Dispatcher's relay
duty (amendment 6): IC to project lead to Dispatcher to Cory is unchanged for
messages; the notifier adds no lateral path, it reads decision events and
addresses only Cory. The digest states Cory's authority from tenant config and
the notification path cannot change it (tested).

**Live verification.** Against the real fleet state: the fleet digest folded 67
events into three active records (#633 ci-wait / PR #646, #636 and #637
implementing), five merges with PR numbers recovered from the archive, the two
new exclusions active, none discharged, and no pending decision; a shadow
notifier run handled nothing; the toast script dry-run answers JSON. The
watchdog suite still passes with the shared toast function.

**Same-day review round (Standards + Spec sub-agents; every finding verified,
the two wrong-implementation ones with executed repros) and what changed.**
(1) Byte-stability was false: the fold read present-day `active.json`/archive
for PR numbers, so replaying an offset after a record gained its PR printed a
line the slice never held. Now every creation and observation event carries
`prNumber` (null when unknown) and the supplement is consulted only for a
record whose creation event lacks the key - a pre-07 ledger shape, itself a
fact of the slice. Test: create without PR, project, attach PR, replay the old
offset, identical bytes; plus a stripped-ledger case proving legacy archived
records still show their PR. (2) `--recheck-issue` matched any tenant's
`issue-N`; an `other:issue-40` merge discharged an endzone hold. Scoped to
the exclusion's tenant. (3) A notifier launch that never produced a process was
silence: `spawn` reports a missing executable asynchronously, so the producer
now records claim + `notification-failed` ("notifier launch failed: ...") for
the event, visible in the digest and re-armable. (4) `authorize-retry`
re-armed an attempt nothing launched: the state CLI now launches the notifier
after a non-replayed authorization. (5) One torn line in an exclusion ledger
blocked all frontier selection: a torn trailing line is skipped as the event
ledger does; interior corruption still stops the reader. (6) A recheck event
type is validated against the ledger's event types (a typo can no longer make
an exclusion undischargeable by accident). (7) The notifier now rebuilds the
tenant status projection too, as the README claimed. Smells taken: shared
`readTenantConfigs` / `enteringEvent` / `DECISION_STATES` live in
work-state.js; `RECHECK_EVENT_TYPES` renamed to what it is
(`LIFT_ONLY_RECHECK_EVENTS`); the watchdog's `Show-Toast` middle man inlined;
`send-toast.ps1`'s callerless `-DryRun` removed. Spec-side: the projection
files joined the Edit-family deny set (`state/status/DIGEST.md`,
`state/status/*-status.md`); a projection failure no longer turns the ticket-04
watcher task red. Left as is: the project lead's dual write (skip file + ledger)
stands because the Stop hook reads the skip file and the classifier locks it -
deviation (3) below; `changes.prNumber` on every transition stays, it is what
makes the fold self-sufficient.

**Deliberate deviations, to classify at ticket 09.** (1) `hold` counts as a
decision event alongside `escalated`: the spec's "clean PRs requiring Cory
enter hold, page once" is honoured through the same door rather than a second
mechanism. (2) The exclusion ledger is JSONL with a fold, not a mutable
structured file, so "without deleting its history" is a property of the store
rather than a discipline. (3) The prose skip file is not removed: the Stop
hook reads it and the classifier denies writes to it; the parity comparison can
tell the two sources apart by `source`. (4) Expiry is evaluated against the
clock (`--now`), so a rebuild that crosses an expiry boundary differs by that
one discharge line - the offsets pin everything else.

Tests: `tests/exclusions.tests.js` (8), `tests/notify.tests.js` (10, including
a real detached spawn, the CLI launch, and an unlaunchable notifier),
`tests/digest.tests.js` (7),
`tests/work-state.tests.js` (+4 notification-door cases),
`tests/pr-watch.tests.js` and `tests/review-policy.tests.js` (launch hooks),
`tests/launch-settings.tests.ps1` (exclusion deny rule),
`tests/pr-watch-task.tests.ps1` (digest ride-along, no notifier in the wrapper).
