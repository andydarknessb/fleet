---
status: accepted
supersedes: ADR-0001
---

# Scripts supervise the fleet; Claude sessions make judgments

Mechanical supervision and durable work state belong to scripts, not to
long-lived Claude transcripts. A Windows Scheduled Task will run the fleet's
mechanical check, maintain active Work records and an append-only event ledger,
and create an exceptional notification path only when a human decision is
needed. The Sentinel therefore stops being a rostered Claude session.

The Dispatcher and project lead remain Claude sessions because routing a real
escalation, assigning scoped work, and adjudicating review findings require
judgment. They rotate on bounded lifetimes and reconstruct their position from
canonical state rather than treating transcript history as state. ICs remain
one-session-per-unit-of-work. The single launch door from ADR-0002 and Cory's
approval boundaries do not change.

We previously kept the Sentinel as a session because a script was assumed
unable to distinguish a stuck session from a slow one. The implemented check
now makes that decision from daemon state, heartbeats, open PRs and explicit
holds without reading a transcript. Retaining a model turn around that script
adds scheduled token use without adding evidence or judgment.

Implementation must preserve escalation delivery and recovery before removing
the Sentinel from the roster. Until that cutover is verified, the existing
Sentinel remains the active mechanism.

## Status note - ticket 08b (2026-09-01)

Mechanism landed; the cutover itself is Cory's hand, after the gate.

Vocabulary: this ADR supersedes ADR-0001's title claim that "the daemon is the
supervisor". After cutover the Watchdog task is the supervisor (scripts
supervise; the daemon hosts), and the scripts, status line, and escalation
files say `supervisor` in that sense. CONTEXT.md's **Lead** avoid-note was
updated to match; ADR-0001 itself is left as history.

- Evidence: `sentinel-check.ps1 -Apply` appends every tick to
  `state/sentinel/applied/<day>.jsonl` (actor `sentinel` or `watchdog`);
  the watchdog's shadow ticks were already in `state/sentinel/shadow/`.
  `bin/parity.js` pairs them, classifies every difference, and passes only
  when the most recent continuous paired run covers 48 hours with every
  difference expected by construction (the two observers never see the same
  instant: the Sentinel acts first, the shadow sees the cured state) or
  approved by Cory in `state/sentinel/parity-approved.json`. The clock starts
  when both logs exist, not at the 08a shadow start.
- Cutover (`bin/cutover-sentinel.ps1`): parity gate, watchdog task registered
  and ticking, Sentinel at a turn boundary; then the flag
  `state/flags/sentinel-off`, then `retire.ps1 -Name sentinel`. Every reader
  (check, launch door, recovery, pilot, watchdog staleness, status) consults
  the flag; the launch door refuses a Sentinel under it, and the check refuses
  a Sentinel-actor `-Apply` under it. The roster entry, prompt, and role file
  are retained for one release as the rollback path.
- Live supervision: the watchdog runs the same check with `-Apply`, launches
  `launchNeeded` through `launch.ps1 -FromRoster`, and turns the report's
  actionable entries into escalation files plus one page per new
  `name:kind`. Intentional differences from the Sentinel session, recorded
  here so the parity ledger does not need to carry them: (1) the "re-send its
  assignment" nudge to a respawned session's parent is an escalation file, not
  a message - scripts never message sessions until ticket 09 authorizes wake
  delivery; (2) `blocked` is recorded as waiting and never paged, because the
  daemon's label summarizes a session's last line and the 2026-08-27 episodes
  showed it is not a measured wait (`supervisor.pageKinds` makes this
  configurable); (3) a respawned dispatcher pages by toast rather than by the
  PushNotification tool.
- Rollback (`bin/rollback-sentinel.ps1`): remove the flag, launch the Sentinel
  through the one door; a failed launch restores the flag. No ledger, offset,
  or Work record is touched in either direction.
- Paperwork at cutover (amendment 11 defers it to that moment): rewrite the
  CONTEXT.md **Sentinel** entry to "The retired lead that kept the fleet alive
  and within its cap as a rostered session until the 08b cutover; the Watchdog
  task now does that work. Its roster entry and role file remain for one
  release as the rollback path and are then deleted. _Avoid_: watchdog (the
  task), monitor, health checker"; update the README Shape diagram; after one
  release delete the roster entry and `agents/sentinel.md`, and retire the
  `sentinel` first-turn ceiling from `config/cycle.json`.

## Status note - ticket 89, after one release, 2026-09-17

Done: `roster.json`'s `sentinel` entry, `agents/sentinel.md`, and
`bin/rollback-sentinel.ps1` are deleted; `config/cycle.json`'s
`firstTurnCeilings.sentinel` is gone. `bin/status.ps1` no longer names the
rollback script. `bin/sentinel-check.ps1` (the script the Watchdog runs) is
untouched - it was never the rostered role, only the mechanical check the
Sentinel and now the Watchdog both call. `state/flags/sentinel-off`, the
launch door's Sentinel guard, and `bin/watchdog.ps1`/`bin/sentinel-check.ps1`'s
shadow/live branching on it are left as they were: out of this ticket's named
scope, and still the mechanism the Watchdog's live/shadow mode reads.
