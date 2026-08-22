---
status: accepted
---

# The daemon is the supervisor; the Sentinel only respawns

Claude Code's background-session daemon already hosts sessions, survives the
terminal closing, and restarts them on `claude respawn`. We therefore make the
daemon the thing that keeps processes alive and give the Sentinel one job:
compare the roster and heartbeats against `claude agents --json`, respawn what
is missing or stuck, and escalate what is `blocked`. The Sentinel never assigns
work, reviews code, or decides what a respawned session should do next; that
belongs to the session's parent on the reporting line.

## Considered options

A symmetric pair of leads that each own half the tenants and restart each other
was the model we started from. With one tenant it leaves a lead idle, and a
lead that both reasons about work and restarts its peer will eventually restart
a peer for disagreeing with it. A watchdog that is a plain script, not a
session, was also considered; it is kept as the reboot-recovery path but cannot
read a transcript to tell "stuck" from "slow".

## Consequences

Future readers will be tempted to give the Sentinel more to do because it is
the session that sees everything. Don't: its value is that a respawn is never a
judgement call.
