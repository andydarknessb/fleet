# Start and rotate a scoped session without transcript dependence

Status: ready-for-agent
Blocked by: 02
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.

## Outcome

One role starts below its context budget, uses only its allowed tools, and can
be replaced at a safe boundary by a session that reconstructs from canonical
state.

## Requirements

- Remove the global notice from automatic startup injection. Replace it with
  role- and tenant-scoped notices carrying an expiry or clearing event.
- Load only context named by the role or assignment manifest. Mechanical
  scripts receive no tenant prose.
- Enforce role settings: Dispatcher uses Sonnet/low and tracker, messaging, and
  state tools; project lead uses Sonnet/high and tracker, review, messaging, and
  state tools; IC tools follow manifest risk; risk reviewer is read-only.
- Enforce first-turn cache-creation ceilings of 12,000 tokens for Dispatcher,
  20,000 for project lead, and 25,000 for IC or risk reviewer. A rejected launch
  reports token contribution by source.
- Rotate Dispatcher daily. Rotate project lead at the first of five merges,
  24 hours, or 250,000 cumulative job tokens.
- Rotate only at a turn boundary with no active state mutation: persist the
  last consumed event offset, stop and remove the old session, launch its
  replacement through `launch.ps1`, and reconcile every active Work record
  before accepting a new action.
- Preserve pause, fleet-cap, tenant-cap, identity, and single-launch-door gates.

## Acceptance criteria

- [ ] Startup fixtures prove unrelated tenant context and expired notices are
  absent from each role.
- [ ] Each role stays below its configured first-turn ceiling or fails before
  assignment with a source breakdown.
- [ ] Tool-denial tests prevent control-plane roles and reviewers from using
  engineering or direct state-write tools outside their contract.
- [ ] Rotation at each threshold records one offset, leaves no in-flight
  mutation, launches through `launch.ps1`, and reconciles before acting.
- [ ] A crash between stop and replacement launch is recoverable from roster
  intent and the saved offset without transcript inspection.
- [ ] Rollback can independently restore legacy context loading or disable role
  rotation without bypassing launch gates.

## Answer

Not implemented. Runtime work requires separate authorization.
