# Review one settled PR once, with risk-triggered escalation

Status: ready-for-agent
Blocked by: 03, 04
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.

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

Implemented 2026-09-01.

**One formal review, risk-tiered (amendment 5).** `bin/review-policy.js` is
the deterministic half: `classify` maps a change (paths plus added diff lines)
onto the configured triggers - the tenant's `carveOuts` plus a new
`riskTriggers` block in `tenants/endzone.json` (auth, security,
data-integrity, concurrency, destructive, accessibility; path globs and
case-insensitive added-line patterns; patterns never fire on removed lines) -
and answers the tier (`trivial`/`normal` on `config/cycle.json` review
thresholds, `high-risk` on any trigger), the merge authority (`cory-only` on a
carve-out), and the review plan: every PR gets the project lead's one formal
Standards+Spec review; only `riskReview: true` books the risk reviewer, named
explicitly as `{host: 'ic', role: 'qa-reviewer', model: 'opus', readOnly:
true, timing: 'pre-pr-ready'}` - Opus is reserved for that path. Patterns fire
on added lines only, attributed per file from the unified diff, and never from
files under `review.patternExcludePaths` (markdown/docs), so prose about a
risky thing books no Opus.
`classifyFromGit` reads the range with `--name-only`, never `--stat`
(2026-09-01 ruling). Bare-name carve-out globs (`.env*`) deliberately match by
basename anywhere: a protective class over-matches rather than under-matches.

**Findings recorded once.** `bin/work-state.js` gained a `review` door
(`recordReview`): revision-CAS and idempotent like `observe`; a formal review
records only in the `review` state, a risk review also from `implementing`
(the IC hosts it pre-PR-ready); event type `review-recorded` carries the
artifact path. `review-policy.js record` writes the single findings artifact
under `state/reviews/<record>/<kind>-NNN.json` and commits the reference
through that door. The RECORD, not the artifact directory, is the guard
authority (an orphan file from a crash window is harmless): a second formal
review at the same head is `ALREADY_REVIEWED`, a risk review without a trigger
is `RISK_REVIEW_NOT_TRIGGERED` - the "exactly one" criteria are machine facts,
not instructions.

**Revision re-review.** `plan-rereview` hands the lead the changed range
(prior head..new head) and the unresolved findings from the latest formal
artifact; recording the re-review requires linking that artifact
(`REREVIEW_REQUIRES_PRIOR`) and resolving every open finding as resolved /
still-open / not-real (`UNRESOLVED_FINDINGS_UNACCOUNTED`); still-open findings
carry forward into the new artifact with `carriedFrom`, so the latest artifact
is always the complete unresolved set and settled material never re-litigates.

**Hold pages once.** `review-policy.js hold` parks a reviewed-clean PR in the
PR-only `hold` state through the state door (evidence carries the pr-watch
`wake:decision-needed; ` containment prefix) and appends one wake-outbox line;
the state-hold event is the authoritative record, so an idempotent replay
never pages twice. `hold` leaves only through work-state's merged transition,
which demands a reconciled GitHub state=MERGED observation - no automated or
project-lead path can complete a carve-out; observing Cory's own merge is the
whole of the exit. The legacy skip-file entry stays authoritative during
shadow.

**Heavy-suite semaphore.** `bin/suite-lock.js`: a host-wide wx-file semaphore
under `state/suite/` keyed by suite name, owner = the Work record. A blocked
attempt names the owner in its error, its stderr wait line, and `status`;
`--wait` blocks inside the script, so serialization costs no polling model
turn; `run -- <command...>` wraps acquire-exec-release so the lock cannot leak
on a failing suite. Liveness is owning-pid, never age (a legitimate sweep runs
~35-42 minutes); corrupt lock files are broken, not crashed on.
`tenants/endzone.json` gained `heavySuites` (unit at maxWorkers=50%,
test:server:sweep, test:server:all).

**Role moves.** `agents/ic.md`: /implement's `/code-review` step is explicitly
skipped; step 5 is a targeted self-check (own diff vs criteria, affected test
files, lint/build; CI stays the full-suite authority) plus pre-PR-ready
classification and the one IC-hosted `qa-reviewer` spawn on a trigger, with
the artifact linked from the PR body under `Risk review:`; heavy suites run
through suite-lock. `agents/project-lead.md`: the lead's `/code-review` is the
PR's single formal review, recorded as the artifact and referenced, never
restated; the UI-diff `qa-reviewer` spawn is removed (moved to the IC per
amendment 5) - the lead verifies the IC's risk artifact instead, and a
triggered diff missing it goes back to the IC; Back-to-the-IC scopes
re-reviews via `plan-rereview`; Hold also parks the Work record and pages
once. `agents/qa-reviewer.md` re-scoped as the risk reviewer (IC-spawned,
trigger-only, read-only). `CONTEXT.md` gained **Risk reviewer**; README
diagram and skills paragraph updated.

**Same-day review round** (Standards + Spec sub-agents plus an adversarial
crash/race QA worker with executed repros; every acted-on claim verified).
Fixed: `spawnSync('npm')` is ENOENT on Windows (no PATHEXT resolution), so the
documented heavy-suite command could not run at all - spawnSuite now falls
back to the shell with conservative quoting; the suite-lock wx-open zero-byte
window let a second record read `{corrupt:true}` and break an in-progress
lock (double-hold of a 40-minute suite) - lock files are now created
atomically with their full payload via temp-write + linkSync, and an
unreadable (foreign) lock gets a 5s grace window before breaking; EPERM from
`process.kill(pid, 0)` now reads as alive, not dead; the dead-lock retry path
is bounded by the timeout and sleeps; `run` has no default timeout (the fixed
hour was shorter than two queued sweeps); a release refusal in run's cleanup
warns instead of masking the suite's exit code. In review-policy: a routine
concurrent revision bump (pr-watch observing the PR mid-review) no longer
destroys the just-written findings artifact - `record` retries past
STALE_REVISION when no revision was pinned, artifact filenames are allocated
with exclusive creates so concurrent writers can never share (or delete each
other's) files, and an identical retry replays instead of raising
ALREADY_REVIEWED (the default idempotency key is now stable:
`kind:record:head`); a caller-supplied `status` can no longer smuggle a
finding past the unresolved-findings guard (status is forced open; duplicate
finding ids are refused); a missing prior artifact degrades to an honest
re-review (`priorArtifactMissing`) instead of wedging the record; a crash
between the hold transition and the page is repaired by any retry, which
finds the committed transition but no outbox line and delivers the missing
page. Risk reviews narrowed to the pre-PR-ready states exactly
(implementing, revision, pr-open) - ci-wait/review are refused, keeping the
lead-hosted risk path closed while covering the revision cycle. Glossary
fixes: `role:` not `agent:` in the review plan, "worker" not "subagent" in
ic.md; README Layout gained the new rows; `.transaction(` dropped from the
concurrency triggers (routine knex noise).

**Deliberate deviations, to classify at ticket 09** (the pr-watch
absent-gate precedent): the "exactly one formal review" criteria are enforced
as an upper bound by machinery (duplicate refused) but the lower bound - no
merge without a recorded formal review - is role-instruction only during
shadow, because the shadow record must follow observed GitHub reality even
for units nobody recorded a review on; enforcement belongs at the 02/03
cutover. The risk-reviewer spawn itself is a session action the scripts
cannot intercept - `classify` is the deterministic pre-spawn gate and
`record` refuses an untriggered result, but the spawn decision is bound by
ic.md, not code. `heavySuites` is configuration the IC instruction cites; the
lock cannot detect a suite run outside it. Criterion 6's "cannot merge
through a project-lead path" is machinery on the shadow record (merged
demands a reconciled GitHub MERGED) but the live guard on the lead's own
`gh pr merge` remains the role file plus the skip-file hold, as during all of
shadow. The `trivial` tier is classification-only (amendment 5's mapping
gives trivial and normal the same plan); it exists for status/artifact
legibility and the 09 collector, not to change behavior.

Tests: `tests/review-policy.tests.js` (17 node cases: glob semantics, tiers,
path/pattern triggers with per-file attribution and prose excludes, diff
parsing, exactly-one-formal, risk-only-on-trigger, stable-retry replay,
stale-revision resilience, forced-open findings, duplicate-id refusal,
re-review linking and carry-forward, missing-prior degradation, hold
pages-once plus crash repair plus no-merge-path, PR-only hold),
`tests/suite-lock.tests.js` (12 node cases including cross-process
serialization, npm-on-Windows, fresh-vs-aged corrupt locks, and release
masking), and 4 new work-state cases for the review door. Full run at
landing: node suite 99/99, all 12 PowerShell suites pass unchanged.
