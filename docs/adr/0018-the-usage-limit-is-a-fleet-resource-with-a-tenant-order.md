---
status: accepted
---

# The Usage limit is a fleet resource with a Tenant order

Cory's subscription meters Claude use over a five-hour window and a weekly
window, shared by the fleet and his own sessions: the Usage limit (CONTEXT.md).
On 2026-10-25 the fleet reached it and sat rate-limited for about 36 hours,
with nothing deciding which work went first and no warning before the stop.

## Decisions (fleet #382, owner ruling, 2026-11-06)

- The fleet takes a Usage limit reading every hour: one minimal headless
  request whose rate-limit event carries the five-hour and weekly utilization
  and their reset times. Readings are fleet state.
- At 80% of the weekly window Cory gets one Page per window.
- Tenants have an order for when room runs short: statelite, then endzone, then
  nidus.
- At 85% the planner returns an empty Frontier, with the reason, to every
  Tenant but the first, and at 90% to every Tenant. The launch door refuses IC
  launches past the same lines as a backstop. Work in flight continues: project
  leads keep reviewing and merging. The last 10% stays free for Cory's own
  sessions.
- The throttle lifts at the weekly reset.
- The scorecard reports usage as weekly-limit points per Unit of work.

A Tenant whose Frontier is empty only because of the throttle, with nothing
else to do, is a Dormant tenant until the reset, so its control plane spends
nothing either; the reset brings it back by Wake.

## Why

- No weighting is published for subscription usage, but the audit fitted two
  limit hits and a live 32% reading: the weekly limit is about $950 to $1,150 of
  API-list-priced usage, with cache reads counted and no extra weight for Opus.
  API prices are a fair proxy to within about 15%; the reading is the
  measurement.
- A Pause stops everything, including the merge of finished work. The throttle
  stops new spending first and keeps finished work landing.
- Cory's own sessions share the limit, and a fleet that spends all of it leaves
  him none.

## Consequences

- Each reading costs one minimal headless request an hour.
- The Tenant order is configuration; changing it needs no code.
- The policy acts on the weekly window only. The five-hour window still raises
  the rate-limit signal that sets a Pause.
- Implemented by fleet #388 (reading, Page, scorecard) and fleet #389
  (throttle).
