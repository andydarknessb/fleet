---
status: accepted
---

# Every fleet session starts through launch.ps1

`claude --bg` is one command away for any session, so the obvious design is to let project leads and the Sentinel call it directly. We don't: `bin/launch.ps1` is the only way a fleet session starts, and the Sentinel reports a fleet-named session it didn't see launched as a fault rather than adopting it.

The door is where the cap, the per-tenant IC limit, the PAUSE switch, and the naming scheme are enforced, and where the session's identity (`FLEET_*` env in its settings file) and its session id are recorded. Without a single door the roster would be an inference from `claude agents --json`, the cap would be advisory, and a session that bypassed the gates would be indistinguishable from one that didn't.

## Consequences

A session that needs to exist and isn't in the roster is a bug in the roster, never a reason to launch around the script. If the gates are wrong, change the gates.
