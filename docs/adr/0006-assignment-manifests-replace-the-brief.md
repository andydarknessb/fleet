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

## Status note - approval review 2026-09-06 (NOT approved; cutover still blocked)

The first ten gating differences (four `planner-excludes` with code `assigned`
on #891/#892, six `planner-includes` on #872/#874/#883/#904) were reviewed for
approval and **refused**. Nine independent reviews agreed. What the review
found, and what it changed:

- **Approving by `code` approved far more than it said.** `approvalMatches`
  matched a difference whose code set merely CONTAINED the approved code, so
  `{class: "planner-excludes", code: "assigned"}` would also have blessed
  `["assigned","dependency-blocked"]` and `["assigned","reserved"]`. The
  dependency codes are the two frontiers reading blockers from two different
  GitHub APIs (the hook's REST `issue_dependencies_summary.blocked_by`, the
  planner's GraphQL `blockedBy`) with nothing else cross-checking them: the
  most valuable divergence this gate can catch, silently waived. A seeded
  divergence flipped the gate from FAIL to PASS to prove it. `approvalMatches`
  now also accepts `codes: [...]`, matching only when the difference's code set
  is EXACTLY that. Prefer `codes`; `code` remains for a deliberate "anything
  mentioning this code" approval.
- **`assigned` is a one-way ratchet, and it is the fleet's own habit.** The
  tenant's `docs/agents/issue-tracker.md` tells a session to claim its issue
  with `gh issue edit <n> --add-assignee @me` as its first write, and nothing
  ever removes an assignee. So once a record retires, `reserved` decays away
  and `assigned` remains forever: the issue is open, ready, unblocked, and
  permanently invisible to the authoritative frontier, with the gate reporting
  the difference as approved. On 2026-09-05 thirteen issues (#891-#903) were
  excluded for `assigned` at one evaluation, and for ~28 minutes nine of them
  were simultaneously open, ready, unblocked and assigned. **This needs Cory's
  ruling before any cutover**: either the planner ignores an assignee that is
  the fleet's own identity, or the release path clears the assignee it set, or
  the hook learns the same rule. It is not approvable as written.
- **`planner-includes` carries no codes by construction**, so the only approval
  shape that clears it is the bare class, which permanently blinds the gate to
  the planner proposing work the hook refuses - including a human's skip-file
  hold and the double-launch the reservation exists to prevent. Refused.
- Three live defects were found and fixed: `recover.ps1` relaunched a crashed
  IC through the legacy `-Prompt` path, which the new guard refused, so a
  reboot after cutover would have stranded every in-flight IC (`launch.ps1`
  gained `-Recover`, exempt from this guard only, and the guard now keys on the
  name as well as the role); `hooks/stop.ps1` read the ready list fail-OPEN, so
  a gh outage reported "frontier empty" and fed a false agreement to this
  ledger; and the roster projection skipped any record it had not created, so
  four merged records (#838, #799, #854, #853) sat in active state pinning
  their issues `reserved` in the planner's frontier. All four cleared on the
  next tick once the projection learned to finish a merged record whatever
  created it.
- **Nothing downstream of frontier selection has ever run.** No manifest has
  been reserved, launched, acknowledged or retired against the live tenant. The
  evidence to date compares two frontier computations and nothing else, which
  is why the "the cutover closes this window" argument for `planner-includes`
  is a claim, not a measurement. A rehearsal on one real issue should precede
  the flag.

## Status note - the two rulings, 2026-09-06

**The assignee rule is scoped to a foreign assignee.** `tenants/<tenant>.json`
gains `fleetIdentity`: the GitHub login the fleet acts as. `selectFrontier`
excludes on an assignee only when at least one assignee is not that login.
Endzone sets it to `andydarknessb`, which is the only assignee the repo has
ever had and the same account the fleet's own `gh` runs as, so in this tenant
an assignee carries no information about who owns the issue and the rule is
inert. A tenant whose issues are really owned by several accounts leaves
`fleetIdentity` unset and keeps the original behaviour. The rule stays in the
planner (ticket 03 requires it) instead of being deleted, and the observed
incident loses nothing: Cory's hold on those issues was the skip file, written
in parallel with the assignments, which both frontiers already honour.

**The parity window is a trailing time window, not the last N evaluations.**
It was "the most recent `parityEvaluations` must span `parityHours`", which a
working lead can never satisfy: every new evaluation pushes an older one out,
so the span stays near the lead's own cadence. Measured on the live ledger it
sat at ~8 h against a 48 h requirement, and only reached 30 h because the lead
idled for 23 hours. A gate that operating normally cannot pass is a defect in
the gate. It is now: every evaluation in the trailing `parityHours` (48), of
which there must be at least `parityEvaluations` (20), reaching back across at
least 75% of the window (36 h) over `parityDistinctFrontiers` (5) distinct
frontiers, with every difference approved. The coverage fraction is 75% rather
than 100% because the lead evaluates in bursts separated by long idle
stretches; its job is to reject a burst that looks like days of evidence, not
to demand a cadence the lead does not have. `parityHours: 0` disables the time
requirement (fixtures). On the live ledger the window immediately became 71
evaluations spanning 47.52 h over 11 distinct frontiers, so only real
differences gate now.
