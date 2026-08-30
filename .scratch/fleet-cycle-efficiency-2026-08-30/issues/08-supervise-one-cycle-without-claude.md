# Supervise one fleet cycle without a Claude Sentinel turn

Status: needs-triage
Blocked by: 07

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

Not implemented. Runtime work requires separate authorization.
