# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring it.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the fleet's glossary (Session, Worker, Role, Lead, Dispatcher, Sentinel, Project lead, IC, Roster, Heartbeat, Cap, Escalation, Reporting line, Pause, Tenant, Unit of work, Carve-out).
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. 0001 (the daemon is the supervisor) and 0002 (one launch door) constrain almost every change.

If any of these files don't exist, proceed silently. The `/domain-modeling` skill (reached via `/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
└── agents/, bin/, hooks/, tenants/
```

## Use the glossary's vocabulary

When your output names a fleet concept (in a ticket title, a role file, a script comment), use the term as defined in `CONTEXT.md`. Don't drift to the synonyms the glossary explicitly avoids ("agent", "watchdog", "kill switch", "task").

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the fleet doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (the Sentinel only respawns), but worth reopening because…_
