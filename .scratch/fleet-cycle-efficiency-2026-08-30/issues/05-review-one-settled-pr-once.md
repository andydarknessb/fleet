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
explicitly as `{host: 'ic', agent: 'qa-reviewer', model: 'opus', readOnly:
true, timing: 'pre-pr-ready'}` - Opus is reserved for that path.
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

Tests: `tests/review-policy.tests.js` (11 node cases: glob semantics, tiers,
path/pattern triggers on added lines only, diff parsing, exactly-one-formal,
risk-only-on-trigger, re-review linking and carry-forward, hold pages-once
plus no-merge-path, PR-only hold), `tests/suite-lock.tests.js` (9 node cases
including cross-process serialization and wait timeout), and 3 new
work-state cases for the review door. Full run at landing: node suite 89/89,
all 12 PowerShell suites pass unchanged.
