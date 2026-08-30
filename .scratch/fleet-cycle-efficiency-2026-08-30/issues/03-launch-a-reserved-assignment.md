# Turn one ready issue into a reserved, acknowledged assignment

Status: needs-triage
Blocked by: 02

## Outcome

A deterministic, collision-aware frontier selects one ready GitHub issue,
creates a compact manifest, launches through the single door, and receives an
acknowledgment without duplicating the issue body in messages.

## Requirements

- Query GitHub for current labels, issue state, assignees, dependencies,
  sub-issues, and body hash before selection.
- Exclude non-ready, assigned, dependency-blocked, spec-parent,
  ready-for-human, reserved, colliding, and structured Frontier-exclusion
  units. Prefer a GitHub signal over a local exclusion whenever possible.
- Sort eligible issues by `createdAt` ascending and issue number ascending.
- Reserve declared components, shared test resources, schema areas, and
  migration prefixes through the state command before launch. Conflicts fail
  closed with the owning Work record pointer.
- Fetch the intended remote base and resolve the manifest base SHA from that
  remote ref before worktree creation. Never infer the base from a potentially
  stale shared checkout.
- Write an immutable manifest containing issue URL and body hash, base SHA,
  branch, tenant, model and risk, token budget, relevant `CONTEXT.md` headings
  and ADR paths, targeted test plan, expected CI gates, and reservations.
- Pass only the manifest pointer and Work record identity to `launch.ps1`.
  The IC emits `assignment-started` in its first useful turn.
- Invalidate an unacknowledged manifest if the GitHub body hash or base
  precondition changes; release its reservations and recompute.
- Launch at most two ICs normally. Permit a third only when a machine-readable
  independence check proves no component, schema, migration-prefix, or heavy
  test-resource overlap with active work.

## Acceptance criteria

- [ ] A shuffled GitHub fixture produces the same ordered frontier on every run.
- [ ] Assignees, unresolved dependencies, spec parents, collisions, and each
  Frontier-exclusion reason have explicit exclusion evidence.
- [ ] Two simultaneous reservation attempts for the same component or migration
  prefix result in one owner and one conflict.
- [ ] The prompt, manifest, messages, and IC acknowledgment contain only one
  copy of the acceptance criteria: the GitHub issue remains authoritative.
- [ ] A changed issue body before acknowledgment invalidates the manifest and
  prevents work against stale criteria.
- [ ] A fixture with a stale local base creates the worktree from the fetched
  remote base SHA recorded in the manifest.
- [ ] No path launches a session outside `launch.ps1` or bypasses fleet and
  per-tenant capacity gates.

## Answer

Not implemented. Runtime work requires separate authorization.
