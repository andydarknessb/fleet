# Turn one decision event into one digest entry and at most one page

Status: needs-triage
Blocked by: 02, 04, 06

## Outcome

A new human decision appears in status and the digest, creates at most one push
notification, and never keeps a model session alive to repeat unchanged state.

## Requirements

- Generate tenant status and fleet digest projections from Work records and the
  event ledger. Do not append model-authored prose to status artifacts.
- Replace free-form exclusion prose with structured Frontier exclusions whose
  reason, evidence, recheck event or expiry, and owner are machine readable.
- Launch a minimal ephemeral notifier only for a new `decision-needed` event.
  It receives the event and evidence pointers, sends one push, records
  `notification-sent` through the state command, and exits.
- A failed notification remains visible as delivery state. Do not retry by
  repeatedly paging or keeping a session alive; a new retry authorization or
  materially new decision event may create a new notification attempt.
- Pointer messages contain Work record id, revision, event sequence, and
  artifact locations. They do not copy issue bodies, criteria, findings, or
  prior messages.
- Preserve the hierarchy IC to project lead to Dispatcher to Cory. Do not add
  free lateral coordination; collisions are resolved through reservations and
  typed events.

## Acceptance criteria

- [ ] Rebuilding status and digest from the same event offset is byte-stable.
- [ ] One decision event produces one digest item and at most one successful
  notification event across concurrent and repeated notifier starts.
- [ ] Notification failure is visible but produces no automatic repeated page
  without a new event or explicit retry authorization.
- [ ] Expiry or a named recheck event removes a Frontier exclusion from the
  projection without deleting its history.
- [ ] Message fixtures reject copied acceptance criteria and accept typed
  pointers.
- [ ] Cory's authority boundaries are stated in the generated digest and are
  unchanged by notification delivery.

## Answer

Not implemented. Runtime work requires separate authorization.
