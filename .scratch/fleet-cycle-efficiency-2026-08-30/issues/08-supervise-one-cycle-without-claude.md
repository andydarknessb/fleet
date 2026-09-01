# Supervise one fleet cycle without a Claude Sentinel turn

Status: ready-for-agent
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

- [ ] Fixture and live-shadow evidence cover missing sessions, stale
  heartbeats, slow/busy sessions, open PR waits, Holds, pause, GitHub failure,
  capacity, and post-login recovery.
- [ ] Scheduled supervision completes with zero Claude turns in normal and
  recovery cases.
- [ ] Forty-eight continuous shadow hours show identical actions and
  escalations, or each difference is documented and approved as intentional.
- [ ] Sentinel remains active until parity is accepted and is not double-acting
  during shadow.
- [ ] Cutover removes the live Sentinel session and its recurring model turns.
- [ ] Rollback within one release restores the old actor without losing event
  offsets or bypassing `launch.ps1`.

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

08b (Sentinel removal) remains blocked by 07 and the 48-hour action/escalation
parity gate; the shadow log accruing from the scheduled task is its evidence.
