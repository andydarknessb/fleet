# Reconstruct one active unit from validated Work record events

Status: needs-triage
Blocked by: 01

## Outcome

One Unit of work can move through its Fleet cycle and be reconstructed after a
process restart without reading a Claude transcript or model-authored status
prose.

## Requirements

- Provide one state command as the only writer for Work records and Fleet
  events. Claude role instructions must forbid direct file mutation.
- Validate the approved states and transitions, including `prior_state` for
  `escalated` and PR evidence for `hold`.
- Use a cross-process mutex, atomic replacement, monotonic record revisions,
  per-record event sequences, compare-and-swap expected revisions, and caller
  idempotency keys.
- Append typed events to date-partitioned JSONL only after the corresponding
  record mutation succeeds. A crash or write failure must be recoverable
  without a missing or duplicate logical transition.
- Treat GitHub as authoritative for issue and PR facts. Reconcile those facts
  before acting; store only their identifiers, last-observed values, hashes,
  and evidence pointers locally.
- Project existing active fleet work into shadow Work records without changing
  the legacy actor. Active state contains only active and retiring records.
- Generate the existing human status view from records and events so it can be
  compared with the legacy status file.
- On retirement, archive a compact evidence index and remove copied session
  settings and temporary briefs. Retain online JSONL for 30 days, then archive
  it. Do not copy Claude transcripts.

## Acceptance criteria

- [ ] Transition, invalid-transition, stale-revision, and escalation-resolution
  fixtures cover every approved state.
- [ ] Twenty concurrent attempts against one expected revision produce one
  winner, nineteen explicit conflicts, one event, and no corrupt JSON.
- [ ] Replaying one idempotency key returns the original revision and event.
- [ ] Kill-point tests between validation, record replacement, and event append
  recover to one logical transition with monotonic sequence.
- [ ] Deleting the generated status projection and rebuilding it produces the
  same content from canonical state.
- [ ] A retired fixture leaves no active record, copied settings, or temporary
  brief, while its evidence index and event history remain discoverable.

## Answer

Not implemented. Runtime work requires separate authorization.
