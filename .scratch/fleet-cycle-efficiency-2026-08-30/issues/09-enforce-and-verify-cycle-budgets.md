# Enforce budgets and verify the efficient Fleet cycle

Status: ready-for-agent
Blocked by: 03, 04, 05, 06, 07, 08
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.

## Outcome

Shadow evidence supports an independently reversible cutover, and the enabled
Fleet cycle meets its token, correctness, collaboration, and authority targets.

## Requirements

- Compare new and legacy frontier choices, transitions, reservations, CI
  observations, review decisions, notifications, and supervision across at
  least 20 completed units. Resolve or approve every difference.
- After the seven-day baseline, enable IC warnings at 50,000 cumulative tokens,
  IC escalation at 75,000 unless an approved extension exists, project-lead
  rotation at five merges, 24 hours, or 250,000 tokens, and the first-turn
  ceilings from ticket 06.
- Enable separately flagged readers and actors for event state, frontier and
  reservations, CI watching, scoped context, review deduplication, role routing,
  rotation, notification, and scheduled supervision.
- Test each flag's rollback without disabling unrelated behavior. Retain legacy
  state readers through one release and the disabled Sentinel actor through one
  release after supervision cutover.
- Run active-state cleanup and 30-day event archival only after projections
  match and evidence indexes validate. Preserve user-owned or unclassified
  files.
- Produce a final comparison using the metric definitions from ticket 01.

## Acceptance criteria

- [ ] Shadow covers at least 20 completed units and reports exact agreement or
  an approved intentional difference for every compared decision.
- [ ] Event verification finds no missed, duplicated, or reordered event and
  reconstructs every sampled active Work record.
- [ ] Control-plane fresh tokens per completed unit are at least 70% below the
  seven-day baseline; cache-read fields are reported separately.
- [ ] Project-lead fresh-token overhead is below 25,000 per merged pull request.
- [ ] Median IC cumulative tokens are below 60,000 and all threshold warnings,
  extensions, escalations, and rotations are evidenced.
- [ ] There are zero polling-only model turns and zero recurring mechanical
  supervision turns after cutover.
- [ ] One independent Standards and Spec review remains on every merged sample,
  with extra review only on configured risk triggers.
- [ ] Cory alone applied ready labels, merged carve-outs or Holds, and promoted
  `integration` to `main` throughout the sample.
- [ ] Every feature flag passes an independent rollback drill, and no cleanup
  removes unrelated `bin/memory-link-audit.js`, `h.tmp`, or other user-owned
  material.

## Answer

Not implemented. Runtime work requires separate authorization.

## Comments

- 2026-09-03 (Cory's session): deviation to retire here. An idle project lead has no wake path for a newly labelled issue (#782 waited from 13:32Z to a hand nudge; ticket 04 wakes on PR state only, and delivery is shadow). Interim rule added to `agents/project-lead.md`: on a "frontier empty" stop the lead leaves ONE one-shot 60-minute `CronCreate` frontier re-check (a polling model turn, on purpose). 09 replaces it: the scheduled watcher evaluates the frontier (`assignment.js` already computes it) and emits a `frontier-changed` wake; once wake delivery is live, delete the cron sentence from the role file. Also seen: a respawn restores a turn's background shell loops, and `until gh pr checks` loops against closed PRs never exit (17 of them held pl-endzone `busy` for 14 h, which would have blocked rotation); the role now forbids shell loops for CI waits.
