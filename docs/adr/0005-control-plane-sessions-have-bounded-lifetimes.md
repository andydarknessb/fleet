---
status: accepted
---

# Control-plane sessions have bounded lifetimes

A standing Claude session re-reads its whole accumulated context on every tool
call. Measured on the 2026-08-25..09-01 project lead: about 530,000 cache-read
tokens per assistant message across 9,667 messages - 5.12 billion cache-read
tokens on one incarnation, and all project-lead jobs together are about 81% of
the fleet's cache-read volume. The transcript had become the coordination
state, and the fleet paid rent on all of it, every turn.

Control-plane sessions therefore rotate: the project lead retires at the first
of five merges, 24 hours, or 250,000 cumulative job tokens; the Dispatcher
rotates daily until its standing session retires entirely (amendments
2026-09-01). Rotation happens only at a turn boundary with no active mutation,
through `launch.ps1`, and the replacement reconstructs its position from
canonical state - roster, Work records, issues, skip file - never from its
predecessor's transcript. A respawn is not a rotation: it re-pins the old
flags and keeps the old transcript.

We accept a cold-start cost per rotation (roughly 50K tokens of first-turn
cache creation at today's context weight, falling as ticket 06's scoped
context lands) in exchange for capping the growth term. The 2026-09-01
relaunch already proved the model: a project lead cold-started from external
state alone and ran the day correctly.

The alternative - a context diet inside one immortal session - was rejected:
discipline erodes, and the 2026-08-30 baseline shows it (226 forced
continuation turns, 350 check polls). ICs had bounded lifetimes by design;
this ADR extends the property to the control plane.
