---
status: accepted
---

# Triage authority is earned by parity

Triage, rulings and bug diagnosis were the last work in the fleet done only in
Cory's own sessions: the founding grill (2026-08-22) ruled that only Cory
applies the tenant's ready label, and `agents/project-lead.md` still says so. A
lead blocked on a `decision-needed` escalation waited for Cory, sometimes half a
day. The 2026-09-11 grill (Q1 to Q28, all recommendations approved) adds a
Principal role to do that reading and proposing on the top model tier, and
decides that the role starts with no authority and earns it the way the
assignment planner did: shadow, count, cut over.

## Decision

1. **The Principal is advisory until a measured parity window passes.** It
   posts a Triage proposal on the ticket and a `triage-proposed` marker; it
   applies no routing label on its own judgment. A proposal becomes a Ruling
   only through an Approval: a comment from the tenant owner's GitHub login
   (never the fleet identity) reading `Approved` or `Approved with: <edits>`.
   On approval the Principal finalizes: it posts the final `## Ruling` comment,
   applies `ready-for-agent`, `ready-for-human` or `needs-info` as ruled, and
   removes the marker. Closing an issue, `wontfix` and `duplicate` stay Cory's
   hands in every mode.
2. **Leads wait.** A project lead does not act on an unapproved proposal. The
   dispatcher's page for a `decision-needed` escalation carries the proposal,
   so Cory answers with one word instead of a ruling written from scratch.
3. **The graduation criterion is objective.** Bounded authority (applying
   `ready-for-agent` itself for a bug with a reproducible red-tell, outside
   every carve-out path, needing no product decision) is a later ticket, filed
   only after at least 30 proposals over at least 14 days with 90% approved
   unchanged, read from the triage ledger by the digest. Full authority is not
   on the table.
4. **The Principal is the fleet's one Fable seat.** Model tiers are now:
   ICs haiku or sonnet at effort high, never opus (amendment 14, 2026-09-09);
   the IC-hosted risk reviewer the one opus worker; the Principal the one
   Fable session (`claude-fable-5-1`, pinned in the launch door so a default
   bump cannot move it). The Principal spawns no opus worker: it verifies its
   own proposal by re-reading code, and its fact-finding goes through the haiku
   researcher under the research gate (ADR 0010) like every other main session.
5. **Its scope is a frontier, computed by a script.** `bin/triage.js` computes
   the triage frontier from GitHub facts: open issues that are unrouted or
   carry `needs-triage` or `question`, not carrying the marker, not `spec`
   parents, not assigned to Cory, not `held`, not threads where Cory's comment
   is newest; plus `decision-needed` wake records newer than the ledger's
   consumed-up-to marker; plus proposals with an Approval newer than their
   record. Oldest first, at most five proposals per session turn. The watchdog
   wakes the Principal on a non-empty frontier behind `state/flags/principal-live`
   under the same one-per-tenant-per-tick and cooldown guards as the lead's
   frontier wake; absent the flag it logs the frontier and launches nothing.
6. **The write boundary is a hook, not prose.** A PreToolUse guard keyed on the
   `principal` role refuses writes outside `docs/adr/`, `CONTEXT.md` and
   `state/triage/`, the bare test suite, `sync-*` scripts and the Supabase
   tools. One named test file may be run to confirm a red-tell; anything more
   is written into the proposal as a repro step for the IC.

## Why

Three alternatives were weighed. Full authority (Cory reviews after the fact)
puts a machine-written ruling in front of an IC with no human read, and a wrong
ruling sends an IC in circles for a whole unit. Bounded authority from day one
needs a definition of "safe to label" that nobody has measured yet. Advisory
first costs one comment from Cory per ticket, which is what Cory already writes,
and produces the very numbers the bounded definition needs. The fleet already
ran this pattern once, for assignment: the planner shadowed the lead's Stop
hook for 47.7 hours and 35 evaluations before it was cut over, and the only
differences were the approved ledger exclusions. A role that starts with the
label in its hand can never produce that evidence.

Approval by comment rather than by label edit was chosen because it works from
a phone, because an edit is carried in the same comment, and because every
outcome (approved unchanged, approved with edits, rejected) is then a fact the
ledger can count. Gating on the owner login and not the fleet identity is what
stops a lead or an IC from approving a proposal on the fleet's behalf.

The Principal is standing rather than per-ticket because triage is where
cross-ticket memory pays (duplicates, a strand already ruled on another issue),
and a per-issue Fable session would re-read the glossary and ADRs every time.
It counts outside the IC cap because that cap bounds concurrent worktrees and
PR churn, and the Principal opens no code PRs; the account-wide five-hour
usage limit is its real ceiling, and the five-per-turn cap plus the lead's
rotation policy are the mitigations until the first budget summary shows a
`fable` family row.

## Consequences

- `agents/principal.md` (model `fable`, effort high, `maxTurns` and rotation
  as the project lead, user-scope memory); `launch.ps1` admits `principal` to
  the standing-role list and pins `fable`; `config/cycle.json` gains
  `firstTurnCeilings.principal` (30,000) and its rotation entry, noted as
  control plane beside the dispatcher.
- Precedent is cited from GitHub, never from memory: the `Precedent:` line of a
  proposal links Cory's prior ruling comment or says none. Re-proposing a
  ticket is allowed only when its body changed after the proposal (body hash in
  the ledger record) or Cory asks in a comment.
- `state/triage/<tenant>.jsonl` is append-only, written only by
  `bin/triage.js record`: `proposed`, `approved`, `approved-with-edits`,
  `rejected`, `superseded`, `finalized`, and the consumed-up-to marker for
  wake records, so the 22 historical `decision-needed` lines do not wake the
  Principal on its first day. The digest gains a Triage section with the
  approved-unchanged ratio over 14 days.
- The tenant repository gains the `triage-proposed` label, a row in
  `docs/agents/triage-labels.md`, and one sentence in `project-lead.md`'s
  "Triage is Cory's" line pointing at the Principal. The research-gate hook and
  the Stop hook gain a `principal` branch (the Stop hook continues the
  Principal while its frontier is non-empty).
- Delivery is by hand per ADR 0008: fleet PRs A (role, door, config, glossary,
  this ADR, hook role lists), B (`triage.js`, watchdog wake, digest, Stop hook),
  C (write guard), and one tenant PR; two shadow days, read once, before the
  flag.
- When the graduation ticket is filed, this ADR is amended with the measured
  window and the bounded-authority definition, not superseded.

## Status note - 2026-09-11

Docs landed in fleet PR #36. Delivery issues: PR A fleet #37 (role file, door,
config, hook lists), PR B fleet #38 (`triage.js`, watchdog wake, Stop hook,
digest; blocked by #37), PR C fleet #39 (write guard; blocked by #37), fleet
#40 (project-lead and dispatcher role text, README; blocked by #38), and
Endzone-Empire #1276 (label, `triage-labels.md`, `issue-tracker.md`; blocked
by #37). Nothing is built yet; no flag exists.
