---
status: accepted
---

# Assignment manifests replace the brief; the planner is the frontier

A ready unit of work becomes an IC assignment through one deterministic
script, not through a project lead's judgment about which issue is next and a
hand-written brief in the launch prompt. `bin/assignment.js` computes the
frontier from GitHub facts (open, ready label, unassigned, no open blockers,
not a spec parent, not marked ready for human work) plus fleet facts (active
Work-record reservations, the structured Frontier exclusion ledger, the legacy
skip file), oldest first; reserves the head as a Work record in `assigned`;
writes one immutable manifest that points at the issue and carries the base
SHA resolved from the fetched remote ref, branch, model, risk, token budget,
the CONTEXT.md headings and ADR paths to read, the test plan, CI gates, and
reservations; and launches it through `launch.ps1 -Manifest`, the one door
(ADR 0002). The IC acknowledges the manifest in its first useful turn
(`assignment-started`, record to `implementing`). The GitHub issue remains the
only copy of the acceptance criteria: the manifest, the prompt, and every
message point at it and never restate it.

The project lead keeps the judgment that is genuinely its own, expressed as
manifest fields: which model, which risk class, which context headings and
ADRs the IC must read, and whether a third concurrent assignment carries an
independence proof. It no longer chooses the issue or writes the brief.

## Why

The 2026-08-30 baseline found the acceptance criteria copied four times
(issue, brief, launch prompt, IC acknowledgment) and the lead re-reading all
of it every turn; the lead line was 81% of fleet cache-read volume. The legacy
Stop-hook frontier also cannot see assignees, spec parents, the
`ready-for-human` label, or the exclusion ledger, so the lead had to carry
those exclusions by hand in the skip file. A script that reads GitHub once
per decision and reserves before launching removes both the duplication and
the blind spots, and a manifest whose preconditions are checked again at
launch (body hash, base SHA) means no IC works against stale criteria.

## Consequences

- Work records and manifests are authoritative for assignment and
  reservations while `state/flags/assignment-live` stands; the roster stays
  the session registry. Without the flag the legacy path is authoritative and
  the planner runs in shadow.
- The roster projection (`work-state.js shadow`) completes the retirement of a
  manifest-reserved record once its IC has left the roster with the unit
  merged (or already retiring), so the planner's active-assignment count
  cannot pin the frontier shut after two or three merges. An in-flight record
  without a roster row is never archived by a projector.
- Reservations are only as good as what issues declare. Today no issue carries
  component, schema, migration-prefix, or test-resource reservations, so the
  independence proof for a third assignment is vacuously true and the
  effective cap is the tenant's `maxIcs`, as on the legacy path. Teaching the
  planner to read declared reservations from the issue body is a follow-up.

## Status note - 02/03 cutover (2026-09-04)

Mechanism landed; the flag flip is Cory's hand after the gate, as for 08b.

- Evidence: `hooks/stop.ps1` calls `bin/assignment-parity.js observe` at every
  launch decision, recording the hook's legacy frontier beside the planner's
  frontier and exclusion codes in `state/assignment/shadow/<day>.jsonl`.
  `assignment-parity.js report` classifies the most recent
  `config/cycle.json` `assignment.parityEvaluations` (20) evaluations:
  `identical`, `planner-excludes` (with the planner's codes), `planner-includes`,
  `planner-failed`. Nothing is expected by construction: both observers read
  GitHub in the same hook run. The gate passes when the evaluations span
  `assignment.parityHours` (48, the 08b precedent: twenty stops on one idle
  hour prove nothing) and `assignment.parityDistinctFrontiers` (5) distinct
  frontiers with every difference approved in `state/assignment/parity-approved.json`
  (`{class, code?, issue?, note, by, at}`; a `planner-failed` line is only
  approvable as a class). The first live evaluation was recorded 2026-09-04
  04:19Z: both sides said #853.
- Cutover (`bin/cutover-assignment.ps1`): parity gate, Node reachable (never
  overridden); writes the flag and `state/assignment/cutover.json`. From that
  instant the Stop hook decides from the planner's frontier and tells the lead
  to `assignment.js assign` then `launch`; a planner failure launches nothing
  (fail closed) and files one `assignment-planner-failed` escalation;
  `launch.ps1` refuses an IC launch without `-Manifest` (`-Force` and
  `-DryRun` still pass) and releases a manifest's reservation when its launch
  produces no session, so a failed launch never pins the issue as `reserved`. The session-start hook prints the
  manifest, Work record, and the acknowledgment command with the record's
  current revision. Manifest launches prompt with
  `/mattpocock-skills:implement` so the IC runs the real `/implement`.
- Rollback (`bin/rollback-assignment.ps1`): removes the flag, releases every
  manifest still pending acknowledgment through `work-state.js release` (one
  `assignment-released` event each, manifest invalidated), appends its record.
  A release that fails puts the flag back (a standing reservation the legacy
  hook cannot see is worse than a fail-closed hook). Acknowledged assignments
  keep running. No ledger is rewritten.
- Known gap, both paths: `retire.ps1` removes the heartbeat and worktrees but
  not `state/sessions/<name>.settings.json`, and a reserved record carries no
  `settingsPath`, so the ticket 02 "no copied settings after retirement"
  criterion is not met by the projector's retirement either. Follow-up.
- Deliberate differences from the legacy path, so the parity ledger does not
  carry them: the planner excludes assignees, spec parents, `ready-for-human`
  issues, and ledger exclusions the hook cannot see (these surface as
  `planner-excludes` and are Cory's to approve as the improvements they are);
  the planner's normal batch is two assignments with a proof for a third,
  where the hook allowed `maxIcs` outright.
- Paperwork after one release: retire the legacy launch block from
  `agents/project-lead.md` and the legacy frontier from `hooks/stop.ps1`, and
  drop the `-Prompt` IC path from `launch.ps1`.
