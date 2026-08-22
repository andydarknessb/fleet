---
status: accepted
---

# Reboot recovery runs at logon, not at boot

The fleet is hosted by a per-user daemon that dies with the machine. Recovery could be fully unattended by enabling Windows auto-login so a logon-triggered task fires without anyone present. We chose not to: `recover.ps1` runs two minutes after Cory logs in, and until then the fleet is simply down.

Auto-login on a desktop that holds Claude credentials, GitHub auth, and a live connection to the shared Supabase database trades a real security property for an edge case. Unattended reboots are rare on this machine; the Sentinel's heartbeat check and `claude respawn` already cover everything short of a reboot.

## Consequences

"The fleet has been down since the last Windows update" is an accepted failure mode. If that becomes frequent, the fix is a cloud Routine that pages Cory when heartbeats go stale, not auto-login.
