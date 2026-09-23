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
writes one immutable manifest that points at the issue, pins the issue body
and ordered comment thread, and carries the base
SHA resolved from the fetched remote ref, branch, model, risk, token budget,
the CONTEXT.md headings and ADR paths to read, the test plan, CI gates, and
reservations; and launches it through `launch.ps1 -Manifest`, the one door
(ADR 0002). The IC acknowledges the manifest in its first useful turn
(`assignment-started`, record to `implementing`). The GitHub issue body and
comments remain the only copy of the acceptance criteria: the manifest, the
prompt, and every message point at them and never restate them.

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
launch (body-and-comments criteria hash, base SHA) means no IC works against
stale criteria.

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
- The planner derives component, schema, migration-prefix, and test-resource
  reservations from paths and table names in the issue body and comments. It
  pins that complete criteria snapshot in the manifest, rehydrates older active
  records only when their stored hash still matches, and refuses a third
  assignment when any subject has no reservation evidence. Review-artifact
  paths under `state/reviews/` are provenance, not work reservations. Component
  and test-resource paths overlap when either names the other or one contains
  the other on a path-segment boundary; directory/file granularity cannot make
  an overlapping assignment appear independent.

## Criteria-integrity amendment (2026-09-09)

Issue comments are part of the assignment criteria because project leads may
post corrections and rulings there and ICs read the issue with `--comments`.
The planner hashes the body plus every comment's identity, creation time, and
body in chronological order. Both launch paths re-fetch and compare that hash
before acknowledgment; a missing legacy hash or any body/comment drift
invalidates the manifest and releases its reservation. Issues whose complete
comment thread cannot be fetched in the bounded query fail closed.

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

## Status note - CUT OVER 2026-09-09 10:17Z

`bin/cutover-assignment.ps1` ran on Cory's approval with every gate holding
and nothing overridden: parity PASS on 35 evaluations spanning 47.7 h across
12 distinct frontiers, the only two differences the approved #966/#989 ledger
exclusions, zero `planner-includes` in the 64 hours since the reservation lag
closed. The moment was clean: no IC running, no active Work record, no pending
manifest, no PAUSE. `state/flags/assignment-live` stands; the record is
`state/assignment/cutover.json`.

Verified immediately after: `status.ps1` reads "assignment: planner
authoritative"; the launch door refuses a legacy IC prompt launch naming the
flag and the rollback; the planner's frontier is what the lead's next
Stop-hook evaluation will decide from. The full cycle had already run live
once before the flip (#943, PR #971).

Paperwork after one release (a release = one merged unit through the planner
path under the flag): retire the legacy launch block from
`agents/project-lead.md`, the legacy frontier and its parity observation from
`hooks/stop.ps1`, and the `-Prompt` IC path from `launch.ps1`; then delete the
rollback script and the flag reader. Until then `bin/rollback-assignment.ps1`
is the way back.

## Status note - ticket 89, after one release, 2026-09-17

Done: the legacy launch block is gone from `agents/project-lead.md`, the
legacy frontier and its parity observation are gone from `hooks/stop.ps1`
(the hook now decides from `bin/assignment.js frontier` unconditionally), and
`launch.ps1` refuses a `-Prompt` IC launch outright, with no flag and no
`-Force` to bring it back. `bin/rollback-assignment.ps1` is deleted.

QA review, same day: the door's own `-Recover` switch (`bin/recover.ps1`'s
reboot-recovery relaunch of an IC) was an unconditional exemption, so any
name at all restarted a `-Prompt` IC launch through it - the retirement
above was not actually unconditional. Fixed: `-Recover` now lifts the
no-manifest refusal only when the live roster already holds an active `ic`
row of that exact name carrying a manifest path (the credential proving a
genuine prior reservation); `recover.ps1` never passes `-Manifest` itself,
only the row's own original `-Prompt`, so a validated recovery restarts
exactly as it always did (no worktree, no manifest reconciliation) and an
unvalidated `-Recover` gets no exemption at all.
`bin/assignment-parity.js` was left in place (out of this ticket's named
scope) since `bin/cutover-assignment.ps1` still runs its `report` gate; its
`observe` command has no caller left. `_common.ps1`'s `Test-AssignmentLive`
flag reader was also left in place, still read by `cutover-assignment.ps1`
for its idempotency check, which is likewise out of this ticket's named
scope; `launch.ps1` and `status.ps1` no longer call it.

## Status note - the reservation lag is closed, 2026-09-06

`planner-includes` was not a set of historical differences waiting to age out of
the window: it was being manufactured, roughly one per legacy IC launch. The
count went from 10 to 11 during the review when ic-928 launched. The cause is
the ordering, not the planner: a legacy launch writes the roster entry, so the
Stop hook stops offering the issue immediately, while the Work record only
appeared when the next `Fleet PR watch` tick projected the roster, up to five
minutes later. In that gap the planner still offered an issue an IC was already
working. So the gate could never converge while the legacy path ran, and the
gap was itself the double-launch window the reservation exists to close.

`launch.ps1` now runs the projection itself, immediately after it writes the
roster entry, for an IC launch. The record therefore exists before the hook's
next evaluation and the two frontiers agree. It is never fatal: a failed
projection leaves the unit launched and the next tick still picks it up, and
the result line reports `projected`. A manifest launch is already reserved by
`assignment.js assign`, and the projection leaves that record alone.

With this in place the remaining `planner-includes` differences (#863, #864,
#865, #872, #874, #883, #904, #928) are genuinely historical and age out of the
trailing window on their own, as do the two `planner-excludes` on #891 and #892
that the `fleetIdentity` ruling already settled.

## Status note - rehearsal against the live tenant, 2026-09-06

The assignment path was run end to end against real GitHub and the real
`origin/integration`, in a scratch fleet root (its own `state/`, tenant file
and roster) so the live fleet's records, frontier and roster were untouched -
verified after: no manifests directory, no `932`/`933` events, active records
unchanged, working tree clean. It stopped short of `claude --bg`, because the
frontier was empty and the tenant was at 3 of 3 ICs, so no real session could
be started without displacing live work.

What ran, on real issue #932 (`bug`, open, unassigned):

- `assign` selected it, fetched `origin/integration` and resolved the base to
  `3836f221`, matching the real remote exactly; wrote a **1,186-byte**
  manifest (branch, base, model, risk, token budget, the tenant's two checks
  as the test plan, its three CI gates, one ADR path, one context heading) and
  reserved `endzone:issue-932` at revision 1 with an `assignment-reserved`
  event.
- `launch.ps1 -Manifest -DryRun` derived the identity, accepted the record
  state, applied the tool contract (21 deny rules), and estimated the IC's
  first turn at **4,596 tokens against the 25,000 ceiling, of which the prompt
  is 144** - the manifest pointer replacing a brief that used to carry the
  whole acceptance criteria. The env block carried all four assignment
  variables.
- `assignment.js launch --dry-run` re-queried live GitHub, re-resolved the
  base, and found both unchanged.
- `ack` moved the record to `implementing` at revision 2 with a
  `state-implementing` event and wrote the `.acknowledged.json` sidecar; a
  replay returned the same revision and wrote nothing; a second launch of an
  acknowledged manifest refused with `ASSIGNMENT_ALREADY_ACKNOWLEDGED`.

Both guards were then exercised against live GitHub rather than a fixture:

- **Stale criteria.** A manifest built from a deliberately altered body for
  real issue #933 was refused at launch with `MANIFEST_PRECONDITION_CHANGED`,
  its reservation released (record `retired`) and an `.invalidated.json`
  sidecar written. No IC can be started against criteria that have moved.
- **Rollback.** With the flag set, `rollback-assignment.ps1` removed it,
  released nothing that was already acknowledged, and left #932 at
  `implementing` revision 2, as documented.

Still unrehearsed, and the only remaining unknown: `claude --bg` actually
starting from a manifest, the assignment worktree being created on the real
repo at the recorded base, and an IC session performing the acknowledgment
itself from its SessionStart context. That needs one free IC slot and one
ready issue.

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

## Reservation-polarity amendment (2026-09-11, fleet#32 and fleet#33)

A path is reserved for the polarity of the sentence that names it. The
derivation used to reserve every path the criteria mentioned, so a criterion
of the form "lists no file under `server/db/migrations/`" reserved the
directory and collided the ticket with the directory's real owner (endzone
#1242 against #1233, a frontier that sat empty with a free IC slot). The
planner reports such a conflict with a real owner, so the exclusion looked
legitimate and the only way out was a ruling to reword an approved criterion.

Now, per sentence (a line, split again at `. `, `; `, `! ` and `? `):

1. An allowlist sentence ("lists exactly A and B", "touches only A") is the
   whole reservation; nothing named outside it is reserved. This is the shape
   Cory's #1242 reword produced and it is strictly more precise than any
   prohibition, so it is the recommended way to write criterion-level scope.
2. A sentence carrying a negation (no, not, never, nothing, without,
   unchanged, unedited, out of scope, carve-out, stays outside, does not,
   must not, and the contractions) reserves nothing. A section headed "Out of
   scope" or "Non-goals" is negated throughout. A path also named in a
   positive sentence is still reserved from that sentence.
3. A path under `docs/` is a citation unless its sentence carries an edit
   verb; criteria cite ADRs far more often than they change them.
4. A line-numbered path introduced by a copula ("`LOCK` is
   `server/modules/advisoryLock.js:53`") in a sentence with no edit verb is a
   premise citation, not a surface.

Measured against the five instances fleet#32 named, every prohibition-sourced
reservation is gone and every edited path is still reserved. Two residuals
are known and accepted: a lead premise that names a path first
("`scripts/run-pg-tests.js:82` picks up every pg test") still reserves it,
and a file cited only as "the existing test is `path:172`" is not reserved
even when the ticket goes on to edit it. The allowlist criterion is the
precise tool for both.

The opposite failure is refused at assign time. Endzone #1234's six criteria
named seams and fixtures in prose and no path, so the derivation produced an
empty set, the record carried no reservation, and the next third assignment
failed closed on `missingReservations` with the cause invisible. An
assignment that ends with no reservation evidence is a derivation failure
far more often than a file-less ticket, so `assign` now refuses it
(`EMPTY_RESERVATIONS`, no manifest written, no record reserved) and the lead
answers with `--reservations '{"components":[...],"testResources":[...]}'`,
the Work record's own shape; an unknown field is a usage error. An explicit
set replaces the derived one entirely, is pinned in the manifest like any
other, and is subject to the same conflict check and third-assignment proof.

## Citation-cue amendment (2026-09-12, fleet#52)

Endzone #1264's first criterion read "Import-boundary test **like**
`entities/matchup/entityImportBoundary.test.js` passes for both slices". The
path is a template the two new slices copy; the ticket must never edit it.
The derivation reserved it, and nothing else, so the record would have
claimed one file the ticket never touches and none of the sixteen it writes,
and `proof` would have called a genuinely colliding ticket independent. Same
family as the prohibition (rule 2), opposite polarity: named as an example
to imitate rather than named in order to forbid.

5. A path introduced by a citation cue ("like", "unlike", "similar to",
   "modelled on/after", "patterned on/after", "as in", "see", "per", "cf.",
   "e.g.", "such as", "mirroring", "akin to", "in the shape/style of")
   reserves nothing from that sentence. The cue must stand immediately
   before the path, with at most an article or "existing" between, so the
   written path earlier in the same sentence ("Add `A` modelled on `B`") is
   still reserved, and a path cited in one sentence is still reserved from
   another sentence that edits it. An abbreviation's period ("cf.", "e.g.",
   "i.e.") no longer ends a sentence, so the cue stays beside its path.

The refuse-rather-than-guess half is already in place: with the citation
gone, #1264 derives nothing and `assign` fails closed on
`EMPTY_RESERVATIONS`, so the lead declares the sixteen-file set by hand, as
was done at the time. Not chosen: refusing a lone reservation under a
directory the ticket does not otherwise name. It is a useful tell for a
reader and a poor rule for a tool; a one-file ticket is exactly that shape.

One residual is known and accepted, in the same family as rule 4's: "per"
and "see" are ordinary prepositions as well as cues, so an edit sentence of
the shape "store the failure per `server/x.js`" loses that path silently,
and nothing fails closed unless it was the only path. The allowlist
criterion is the precise tool there too.

## Root-file amendment (2026-09-12, fleet#54)

Endzone #1294's approved Ruling carried an allowlist Scope line naming four
files. The recognizer needed one of a fixed list of directory names followed
by a separator, so the root file `CONTEXT.md` matched nothing and the derived
set was three of four. Every guard was satisfied: the set was non-empty, it
conflicted with nothing, and the third-assignment proof answered
`independent: true` over a missing file. Partial derivation fails open and
silently, which is worse than the empty case fleet#33 closed.

6. A repo-root file is a path in its own right. A bare token that is a known
   root name (the repo documents `README.md`, `CONTEXT.md`, `CLAUDE.md`;
   `package.json` and its lock; tool configs such as `jest.config.js` and
   `tsconfig.json`; deploy files such as `netlify.toml`, `render.yaml`,
   `Dockerfile`, `Procfile`; the dotfiles `.env`, `.eslintrc`, `.gitignore`
   and their kin) is reserved when it is fenced in backticks or sits in an
   allowlist sentence. A bare basename that is not a known root name is never
   guessed to be at the root: `assignment.js` lives in `bin/`, and a root
   reservation of it would overlap nothing and read as independent of the
   ticket that edits the real file. In an allowlist sentence such a token is
   unrecognized (rule 7); elsewhere it is prose. The recognizer never matches
   inside a longer path.
7. An allowlist sentence states its own cardinality. Each single-token item it
   enumerates that neither recognizer saw is reported on the normalized issue
   as `unrecognizedPaths` (the frontier answer carries it), and `assign`
   refuses a short derived set (`PARTIAL_RESERVATIONS`, no manifest, no
   record) until the lead declares the whole set with `--reservations`, the
   fleet#33 answer. An explicit set is never checked against the sentence.

Not chosen: lengthening the directory-prefix list. It would still miss the
next root file, and the failure would still be silent. Not chosen: reserving
every dotted token by extension. `e.g.`, `v2.0` and a library name in prose
are not files, and a bare basename reserved at the root is a collision with
nobody: it lets a ticket that edits the real file under `bin/` or `src/`
prove itself independent of this one.
