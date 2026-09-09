# Turn one ready issue into a reserved, acknowledged assignment

Status: DONE and CUT OVER 2026-09-09 10:17Z (`state/flags/assignment-live`; the planner is the authoritative frontier and IC launch path; full cycle ran live on #943 / PR #971 before the flip; rollback path kept one release)
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

- [x] A shuffled GitHub fixture produces the same ordered frontier on every run.
- [x] Assignees, unresolved dependencies, spec parents, collisions, and each
  Frontier-exclusion reason have explicit exclusion evidence.
- [x] Two simultaneous reservation attempts for the same component or migration
  prefix result in one owner and one conflict.
- [x] The prompt, manifest, messages, and IC acknowledgment contain only one
  copy of the acceptance criteria: the GitHub issue remains authoritative.
- [x] A changed issue body before acknowledgment invalidates the manifest and
  prevents work against stale criteria.
- [x] A fixture with a stale local base creates the worktree from the fetched
  remote base SHA recorded in the manifest.
- [x] No path launches a session outside `launch.ps1` or bypasses fleet and
  per-tenant capacity gates.

## Answer

Implemented as an opt-in shadow assignment planner in `bin/assignment.js` with
state-command-owned reservations, deterministic frontier evidence, immutable
manifests, GitHub/base reconciliation, stale-manifest invalidation, and a
manifest-aware `launch.ps1` adapter. Legacy selection and launch remain
authoritative during shadow; no automatic cutover is enabled.
