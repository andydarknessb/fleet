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
