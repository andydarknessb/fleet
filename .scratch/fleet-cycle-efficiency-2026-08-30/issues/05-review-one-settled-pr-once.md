# Review one settled PR once, with risk-triggered escalation

Status: needs-triage
Blocked by: 03, 04

## Outcome

A settled pull request receives one independent Standards and Spec review, with
an additional read-only reviewer only when configured risk evidence requires
it.

## Requirements

- Make the project lead the owner of the single independent Standards and Spec
  review after required gates settle.
- Keep TDD, targeted tests, and a focused self-check with the IC. Remove any
  instruction that makes the IC run the same formal review as the lead.
- Require the IC to run targeted or affected tests plus relevant lint/build
  checks. Keep CI as full-suite authority.
- Add a host-wide semaphore for configured heavy local suites. A waiting suite
  must report the owning Work record rather than oversubscribe the host.
- Configure explicit risk triggers for carve-outs, authentication or
  authorization, security, data integrity, concurrency, destructive behavior,
  and material accessibility risk. Only a trigger launches an ephemeral,
  read-only risk reviewer; Opus is reserved for that path.
- Store one finding artifact and reference it from events and messages. A
  revision re-review inspects the changed range and unresolved findings rather
  than repeating settled material.
- Clean carve-outs and other PRs requiring Cory's merge enter PR-only `hold`
  and page once. Cory's merge authority remains unchanged.

## Acceptance criteria

- [ ] A normal PR produces exactly one formal Standards and Spec review.
- [ ] A configured high-risk PR produces that review plus one risk review; a
  normal PR never launches the risk reviewer.
- [ ] The IC prompt contains targeted self-check instructions but no duplicate
  formal review requirement.
- [ ] Two heavy-suite attempts serialize through one host semaphore and expose
  the current owner without a polling model turn.
- [ ] A revision re-review links the prior findings and reports only unresolved
  or newly introduced findings.
- [ ] A clean carve-out reaches `hold` and cannot merge through an automated or
  project-lead path.

## Answer

Not implemented. Runtime work requires separate authorization.
