# Supervise one fleet cycle without a Claude Sentinel turn

Status: 08a + 08b implemented 2026-09-01 (cutover is Cory's hand after the 48h parity gate: `bin/cutover-sentinel.ps1`)
Blocked by: 07
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.
Amendment: split into 08a (shadow supervisor + external page path + launch
retry cap; no 07 dependency, leads Stage 2) and 08b (Sentinel removal; keeps
this Blocked-by and the 48h parity gate).

## Outcome

A Windows Scheduled Task performs one deterministic supervision cycle with the
same correct actions and escalations as Sentinel, then Sentinel is removed only
after verified shadow parity.

## Requirements

- Run the mechanical supervisor as a Windows Scheduled Task after user logon,
  preserving ADR-0003's accepted reboot behavior and ADR-0002's single launch
  door.
- Reconcile roster intent, daemon liveness, heartbeat age, active Work records,
  open PRs, Holds, pause state, capacity, and recovery evidence without reading
  a transcript or invoking a model.
- Derive active IC capacity from verified daemon liveness and Work record state,
  not retained roster history.
- Respawn or recover only through existing validated commands. Ambiguous or
  failed external reads fail safe into visible decision evidence.
- Shadow every scheduled result beside Sentinel for 48 continuous hours. Log
  both proposed action sets and classify every difference.
- Cut over only after action and escalation parity. Disable and remove the
  rostered Sentinel session, but retain its old roster entry and actor as a
  disabled rollback path for one release.
- The exceptional notifier remains event-driven and ephemeral; scheduled
  supervision itself sends no unchanged page.

## Acceptance criteria

- [x] Fixture and live-shadow evidence cover missing sessions, stale
  heartbeats, slow/busy sessions, open PR waits, Holds, pause, GitHub failure,
  capacity, and post-login recovery. (Fixtures: `tests/watchdog.tests.ps1`
  cases 1-10i, `tests/sentinel-respawn.tests.ps1`, `tests/sentinel-cutover.tests.ps1`;
  live shadow: `state/sentinel/shadow/` since 2026-09-01 16:30Z.)
- [x] Scheduled supervision completes with zero Claude turns in normal and
  recovery cases. (`watchdog.ps1` live mode launches through `launch.ps1`
  and files escalations; no session is messaged or spawned.)
- [ ] Forty-eight continuous shadow hours show identical actions and
  escalations, or each difference is documented and approved as intentional.
  (Tooling landed: `bin/parity.js`; the paired clock started when the
  Sentinel's applied ledger began, 2026-09-01 21:01Z, so the gate can pass no
  earlier than 2026-09-03 21:01Z. Approvals go in
  `state/sentinel/parity-approved.json`.)
- [x] Sentinel remains active until parity is accepted and is not double-acting
  during shadow. (Shadow runs never `-Apply`; a Sentinel alive under the flag
  is the `double-actor` page and keeps the watchdog in shadow; the check
  refuses a Sentinel-actor `-Apply` under the flag.)
- [ ] Cutover removes the live Sentinel session and its recurring model turns.
  (`bin/cutover-sentinel.ps1`, Cory's hand after the gate; retires the
  session, whose cron dies with it.)
- [x] Rollback within one release restores the old actor without losing event
  offsets or bypassing `launch.ps1`. (`bin/rollback-sentinel.ps1`; the test
  hashes the event and applied ledgers across cutover and rollback.)

## Answer

08a implemented 2026-09-01: `bin/watchdog.ps1` (shadow supervisor + page path +
launch retry cap), `bin/install-watchdog-task.ps1` (every 15 minutes while
logged on, plus 4 min after logon, behind the recovery task), and
`tests/watchdog.tests.ps1`. `sentinel-check.ps1` gained `-ReportPath` so shadow
runs never touch the live Sentinel's `last-check.json`; `status.ps1` prints the
red banner first. Shadow supervision runs with zero Claude turns, logs every
proposed action set to `state/sentinel/shadow/` for the parity comparison, and
pages (Windows toast + banner) only when self-healing is the casualty:
check-failed, sentinel-stale or fleet-dead (45-minute heartbeat threshold), or
a launch retry storm (cap 2 -> skip-hold carrying the recorded failure detail;
a closed issue or an existing hold is logged as closed-stale/already-held, not
paged). Staleness paging is suppressed while PAUSE is set (paused sessions
idle by design; a rate-limit pause outlasts the threshold) and for a session
whose daemon job started within the threshold (post-logon recovery grace); the
shadowed check still performs its pre-existing read-only tenant `git fetch`.
First live verify: healthy fleet, zero conditions; the two historical storms
(ic-284 x5, ic-502 x2) root-caused to option-like tokens reaching `claude
--bg` argv before the stdin-piping launcher fix (`--ext` is verbatim in #284's
title; #502's `--jq` is the same failure class, but its carrying text was
never recorded - the launch died before the roster stored a prompt), both
classified closed-stale.

Same-day adversarial QA found three blockers, all fixed and test-covered
(20-case suite): a 24-hour retry window keeps immortal daemon history from
resurrecting lifted holds or re-paging dead storms (timestamps parse as
epoch-ms or ISO; a no-offset stamp reads as UTC, and a future-dated one as
stale); the check's report FILE is the parse source, so child stderr can
neither fake a check-failed page nor cost 08b its parity data, and a 180s
timeout turns a wedged child into a page instead of a silent no-op; corrupt
state (paged.json, heartbeats, rosters) quarantines or reads as stale rather
than crashing the pager, and a crash banner prepends to - never masks - a
standing condition banner; a human's unrelated skip-hold pages through as
`held-other-paged` and is never overwritten. Accepted with documentation: a
hold-write re-serializes the skip file BOM-less with PowerShell JSON escaping
(every reader tolerates both), and the shadowed check's read-only tenant
`git fetch` also runs under `-Verify`.

08b implemented 2026-09-01 (ticket 07 landed the same day; the parity gate is
the remaining condition and is Cory's to accept).

**Both sides logged.** `sentinel-check.ps1` gained `-Actor` (default
`sentinel`) and appends every `-Apply` tick to
`state/sentinel/applied/<day>.jsonl`: at, actor, applied, respawned,
launchNeeded, escalate, retired, worktrees, pause, okCount (and the
daemonReadError of a fail-closed tick). Read-only runs leave no line. The live
Sentinel picked the change up at its 21:01Z tick without a relaunch, which is
when the paired clock started: 08a's shadow log alone is one side of a
comparison, so the "48h parity clock started at 16:30Z" note in the 08a Answer
is superseded by the first applied line.

**Parity gate** (`bin/parity.js`, `tests/parity.tests.js`, 13 cases).
Pairs each shadow tick with the nearest Sentinel tick inside
`supervisor.pairWindowMinutes` (10), compares seven categories by identity
(respawned/launchNeeded/retired by name, escalate by name:kind, worktrees by
path, sync by tenant when a fast-forward was applied or would be, pause by
value), and classifies every difference. Expected by construction, because
the Sentinel's cron fires first and its script acts before the shadow runs
~90 s later: `applied-next-tick` (the shadow proposed it, the next Sentinel
tick applied it), `applied-before-shadow` (proposed by a shadow tick whose
own Sentinel partner was missing), `timing` (an escalation one side reported
one tick away). Gating unless approved: `unproposed-action` (the Sentinel
acted and no shadow tick before or at it proposed the action - the honest
cause is a condition that arose inside the ~13-minute gap between the two
observers, and Cory approves it as such), `proposed-not-applied`,
`report-drift`, `sentinel-tick-missing`, `shadow-tick-missing`,
`shadow-check-failed`, and `shadow-read-failed` / `sentinel-read-failed`
(a fail-closed daemon read proposed nothing because it saw nothing; it is not
clean evidence). The review round proved the first cut was unfalsifiable in
the applied direction (a silent shadow passed 49 h of Sentinel actions); the
`unproposed-action` class and its test close that.
Continuity is the most recent run of paired ticks with no gap over
`maxGapMinutes` (35 = two missed ticks); differences outside it are listed
but do not gate. Approvals (`state/sentinel/parity-approved.json`,
`{class, category?, name?, kind?, note, by, at}`) mark a difference
intentional; the report shows them as such. Verify lines, live-mode lines, and
non-Sentinel actors are never evidence. Exit 2 on fail; `--json` for scripts.

**Cutover** (`bin/cutover-sentinel.ps1`). Gates: parity pass, the
`Fleet watchdog` task registered and its `last-run.json` under 30 minutes
old, the Sentinel not `busy`. `-Force` overrides the first two and records
what it overrode; the turn boundary is never overridden. Order: write
`state/flags/sentinel-off` (from that instant every reader stops expecting
the Sentinel), then `retire.ps1 -Name sentinel` (roster marker, stop, rm,
heartbeat removed), then `state/sentinel/cutover.json` and the printed
paperwork checklist. Idempotent. Readers of the flag: the check
(`Get-ExpectedStaticSessions`; a running Sentinel is a `stray`; a
Sentinel-actor `-Apply` is refused), `launch.ps1` (refuses a Sentinel, dry
run still evaluates), `recover.ps1`, `pilot.ps1`, the watchdog's staleness
set, `status.ps1` (a supervisor line), `Get-FleetNames`.

**Live supervision** (`watchdog.ps1`). Under the flag with no Sentinel
session running the run is `live`: the check runs `-Apply -Actor watchdog`
and owns `state/sentinel/last-check.json`; `launchNeeded` goes through
`launch.ps1 -FromRoster` (skipped under PAUSE, each result recorded under
`launches`); a respawn files a `respawned` escalation naming the parent (a
respawned dispatcher also toasts); check escalations of
`supervisor.pageKinds` (stray, cap-exceeded, ic-vanished, pr-lookup-failed,
branch-diverged) become conditions `escalation:<name>:<kind>` that page once
on first sight, write one escalation file (`from: supervisor`, `name`,
`parent`), stand in the banner, and clear when the check stops reporting
them; other kinds (`blocked`) are recorded under `waiting`. The same job
respawned tick after tick is one condition: `state/watchdog/notified.json`
carries the previous tick's respawns, and a repeat is recorded as
`respawned-again` under `waiting`, never re-filed or re-toasted. A Sentinel
alive under the flag is `double-actor`: page, stay in shadow. The mode
decision reads the daemon list strictly (an unreadable list keeps the run in
shadow, since an empty read must not look like "no Sentinel running"), and a
live run re-reads the list after the check so the staleness grace sees the
sessions it just respawned. `-Verify` never applies. Every run writes
`state/watchdog/last-run.json`. Shadow lines now carry `mode`, `launches`,
`notified`, `waiting`, and the proposal carries `sync` and any
`daemonReadError`.

**Rollback** (`bin/rollback-sentinel.ps1`): remove the flag, launch through
the one door from the retained `roster.json` entry, append a rollback record;
a refused or failed launch restores the flag (a fleet with no supervisor is
worse than one supervised by the task). No ledger, offset, or Work record is
touched either way, and the test hashes the event and applied ledgers to
prove it.

**Deliberate differences from the Sentinel session**, recorded in ADR 0004's
status note so the parity ledger does not have to carry them: the parent
"re-send its assignment" nudge is an escalation file, not a message (scripts
never message sessions until ticket 09 authorizes wake delivery); `blocked`
is never paged (the daemon label is a summary of a session's last line, the
2026-08-27 mislabel class); a respawned dispatcher pages by toast. The
`sentinel` first-turn ceiling stays in `config/cycle.json` for the rollback
path; delete it with the roster entry after one release.

**Paperwork deferred to the cutover moment** (amendment 11): the CONTEXT.md
**Sentinel** entry is rewritten then (text in ADR 0004's note); the
**Watchdog** entry, README, and the dispatcher and sentinel role files already
describe both phases. Not run: `cutover-sentinel.ps1` itself (gate not
reachable before 2026-09-03 21:01Z); the dry run against the live fleet
reports the gates correctly (task Ready, last run 10 min, Sentinel idle,
parity 0 h).
