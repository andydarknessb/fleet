---
status: accepted
---

# Rulings are the Arbiter's, and the owner hears only high-level decisions

ADR 0011 made the Principal advisory: every Triage proposal waited for Cory's
`Approved`, and the Bounded-authority door of 2026-09-29 was the one way a
ticket could be routed without him. By 2026-10-08 the ledger held 236 Endzone
proposals (194 approved unchanged, 14 with edits, none rejected) and 43 Nidus
proposals (37 unchanged, 2 with edits, none rejected); the median wait for an
Approval was 0.5 hours on Endzone and 3.1 hours on Nidus, with 25 proposals
open. The Bounded-authority door had never been called once in seven days
behind its flag: the five newest proposals all carried prose under
`Open for Cory` and four said `Repro: none`, so nothing qualified. The owner
was approving nearly everything unchanged and still had to be there for each
one. The 2026-10-08 grill (two rounds, every recommendation approved) moves
the decision into the fleet.

## Decision

1. **A second seat decides.** The **Arbiter** (`ar-<tenant>`, one standing
   session per tenant, both tenants) reads each Triage proposal, re-reads
   every cited premise at the stamped sha through the haiku researcher, may
   run the one named test file, and posts one `## Verdict` comment. The
   Principal keeps proposing; the Arbiter decides; neither applies a label.
2. **An Endorsement is a Ruling the moment it is posted.** The verdict opens
   `Endorsed`, `Endorsed with: <edits or answer>` or `Returned`. There is no
   shadow window, no Veto window and no page per Endorsement. An exact
   `Endorsed` on a self-contained proposal is finalized by script within a
   tick, as an exact `Approved` is; `Endorsed with:` is finalized by the
   Principal, as `Approved with:` is. The ledger records `endorsed`,
   `endorsed-with-edits` and `returned` beside the owner's kinds, so machine
   and owner decisions stay countable.
3. **The Arbiter decides what is high-level.** The proposal's `Open for Cory:`
   field becomes `Open:`. The Arbiter answers the question itself inside
   `Endorsed with:` when the fleet can (naming an owner, confirming an option,
   a merge order, a scope cut) and escalates to the owner only when the answer
   needs product intent, money, a user-facing promise, or a rule change to the
   fleet or a tenant's `CLAUDE.md`. When in doubt it escalates. Every
   escalation is recorded with its reason and listed in the daily summary.
4. **What reaches the owner, and nothing else:** an escalation under
   decision 3; `wontfix`, `duplicate`, closing an issue and `spec` parents
   (his hands in every mode, ADR 0011); a ticket Returned twice; and an
   Arbiter suspension. Everything else, every Endorsement included, is in the
   daily summary only.
5. **A Return is one round.** `Returned` with numbered reasons makes the
   Principal supersede its proposal and post one new proposal answering each
   reason. A second `Returned` on the same body parks the ticket for the owner
   with both verdicts linked. The Arbiter never applies a label on a Return.
6. **The owner's words stay his.** `Approved`, `Re-propose` and `Veto` keep
   their shapes, their author lock and their guard-hook refusal to every fleet
   role, and still work: the ledger's first-writer claim decides when an
   Approval and an Endorsement both land. `Endorsed`, `Returned`,
   `Escalated:` and a `## Verdict` heading are refused by the guard hook to
   every role but `arbiter`, which is what makes a Verdict the Arbiter's; the
   Arbiter itself posts only through the door.
7. **The Arbiter suspends itself.** An escaped defect traced to an endorsed
   ticket, or a send-back or escalation on one marked `criteria-defect`,
   writes `state/flags/arbiter-suspended-<tenant>` and pages the owner once.
   While the flag stands the Arbiter posts no verdict and proposals wait for
   an Approval as before. Only Cory deletes the flag. There is no daily cap:
   `maxIcs` already bounds how much endorsed work can be in flight.
8. **Bounded authority is retired.** The door, its flag and its Veto window
   stay in the tree as history; the Principal's role no longer names them and
   the Arbiter decides the class they covered.
9. **Model seats.** The Arbiter is the fleet's one Fable seat
   (`claude-fable-5-1`, pinned in the launch door). The Principal moves to
   `claude-opus-5-5`, the project lead's tier. Both at effort high, both
   outside the IC cap, both rotated and ceilinged as the Principal is today.

## Why

A verdict with its own word, rather than the Arbiter writing `Approved`, was
chosen so that the ledger can always say which decisions were the owner's and
which the fleet's, and so that `Veto` and `Approved` keep meaning what ADR 0011
made them mean. Letting the Arbiter decide what is high-level, rather than the
Principal's `Open for Cory` line, was chosen because the Principal writes prose
there on nearly every ticket; under the old rule the owner would have heard
about everything, which is the state this ADR replaces. One Return round rather
than unbounded re-proposal was chosen because two top-tier sessions disagreeing
is exactly the case a human should see. Shadowing first, the pattern ADR 0011
used, was offered and declined: the owner ruled approved decisions final and
asked to hear only high-level decisions.

## Consequences

- `agents/arbiter.md` (model `fable`, effort high, user-scope memory);
  `agents/principal.md` moves to `claude-opus-5-5` and loses the Bounded
  door; `_common.ps1` defaults `arbiter` to `fable` and `principal` to
  `opus-5.5`; `launch.ps1` admits `arbiter` to the standing-role list with the
  `ar-<tenant>` name rule; `config/cycle.json` gains the Arbiter's first-turn
  ceiling, rotation entry and `ar-` cap exemption; the session-start,
  research-gate, stop and guard hooks gain an `arbiter` branch.
- `bin/triage.js` recognises the Verdict shapes, records the new kinds, gives
  the Arbiter a frontier (proposals carrying `triage-proposed` with no
  verdict) and the Principal a `returned` item, finalizes an exact `Endorsed`,
  and refuses a second `Returned` into an owner page. The watchdog wakes
  `ar-<tenant>` as it wakes `pe-<tenant>`. The daily summary gains an Arbiter
  section: endorsed, endorsed with edits, returned, escalated with reasons,
  suspended.
- `hooks/principal-guard.ps1` refuses `Endorsed` and `Returned` to every role
  but `arbiter`, and bounds the Arbiter's writes as it bounds the Principal's.
- Each tenant repository's `triage-labels.md` and `issue-tracker.md` describe
  the Verdict and the `Open:` field.
- ADR 0011 is amended, not superseded: its decisions 1, 3 and 4 and the
  2026-09-29 amendment are history; decision 2 stands with "an Endorsement or
  an Approval" in place of "an Approval"; decisions 5 and 6 and the two
  2026-09-12 amendments stand.
- Delivery is by hand per ADR 0008: fleet PR A (this ADR, glossary, role
  files, launch door, config, hook role lists), PR B (`triage.js`, watchdog,
  daily summary, Principal frontier), PR C (guard hook, suspension scan), and
  one docs PR per tenant.

## Amendment 2026-10-09 - an exact Endorsed on an escalation ruling is the script's (fleet #305)

Endzone #2139, an escalation ruling (the Principal's proposal answering
`pl-endzone`'s `decision-needed` wake), was Endorsed exactly at 15:06Z and
ruled only at 15:36Z, by the Principal's hand. Decision 2 says an exact
`Endorsed` is finalized by script within a tick; the finalize gate's clause 7
(#207) refused every escalation ruling, and the Principal's frontier treated
the refusal as a script that had died, returning the item only after the
30-minute claim expiry. Clause 7 guarded the one step the script cannot take
on the owner's `Approved`: waking the lead. On an Endorsement the Arbiter sends
that wake itself after its Verdict (`agents/arbiter.md`), so nothing is left to
judgment.

Decided:

- An exact `Endorsed` on an escalation ruling recorded against its wake
  (`--record-id`, the flag the Arbiter's frontier shows as `escalation: true`
  and sends the lead's line on) is finalized by script. For the `endorsed`
  branch alone, clause 7 does not refuse such a proposal, and clause 9 accepts
  the ready label and the escalation label on it (the ticket is mid-work by
  design); every other clause stands. An escalation ruling the wake checks
  flag without a record id still fails closed to the Principal, who wakes the
  lead. The owner's exact `Approved` on an escalation ruling is unchanged.
- An exact Endorsement the script declines (a gate clause fails, or the owner
  spoke after the Verdict) is the Principal's at once: the frontier serves the
  `endorsement` item naming the clause, unless the ticket is on hold, which
  waits on Cory. A Verdict not yet posted, a cap, and a Ruling already posted
  wait their tick or the 30-minute return as before. A Ruling newer than the
  Verdict that the script did not write is the Principal's: the script leaves
  it.
- A hold on a ticket after its Endorsement (`held`, `haiku-rehearsal`) is
  Cory's; the Principal does not finalize over it.
