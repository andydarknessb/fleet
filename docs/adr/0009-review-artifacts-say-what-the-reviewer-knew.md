---
status: accepted
---

# Review artifacts say what the reviewer knew

A findings artifact under `state/reviews/` is the canonical record of one
review; the PR comment, the lead's status file and the session transcript are
not. Three gaps found on endzone PR #1168 and #1189 (fleet#18, #19, #20) had
the same shape: the tool accepted or refused something in a way that left the
canonical record saying less than the reviewer knew, and the honest record
ended up somewhere non-canonical. The rulings below close them at write time,
because the window in which an artifact can be corrected is exactly the
window in which it is writable.

## 1. A review is recorded only where the record can hold it (fleet#20)

`record --kind formal` stays closed in `ci-wait`. Ticket 05's title is the
rule: review one *settled* PR once. A review read before the gates settle can
be invalidated by a red gate minutes later, and a second read at the next
head is then a re-review of a review that was never recorded, which
`plan-rereview` cannot scope (`NO_PRIOR_REVIEW`). The lead role file already
said a PR whose gates are running "is not yet reviewable"; the sentence was
ambiguous enough to be read as license, and is reworded.

The refusal is a refused invocation, not a failed one: `INVALID_REVIEW_STATE`
exits 2 (the fleet#2 rule for a call the tool declined to act on), and its
message names the door that opens the state (the PR watcher's checks-settled
observation moves the record to `review`). The "exits 0" in the report could
not be reproduced in bash or PowerShell; the exit was 1, which a formatted
summary or a `$?`-free pipeline can hide. Exit 2 with nothing on stdout is
the shape a caller reading only the status cannot mistake for an answer.

Not chosen: opening the formal door in `ci-wait`. It would let a review land
before the material it reviews is settled, and the watcher's `ci-wait ->
review` transition would stop meaning "now reviewable".

## 2. An artifact is never silent about its own result (fleet#18)

`record` refuses an empty `findings` list for both kinds (`EMPTY_FINDINGS`,
exit 2), as the last guard before the write so the earlier refusals keep
their precedence. "The reviewer looked and found nothing" is a real and
common outcome, so the refusal is satisfiable without lying: `--no-findings
"<what was examined and what was concluded>"` writes that sentence into the
artifact as `noFindings`, with `findings: []`. The guard reads what the
artifact will hold, not only what the caller typed: a statement beside new
findings, or beside a still-open prior finding carried forward, is a usage
error, and a re-review that carries a still-open finding needs no statement
because it is not silent. A blank statement or a bare flag is a usage error.
A re-review whose prior findings are all resolved and that found nothing new
still says so; the resolutions map records what closed, the statement
records what was looked at.

The alternative, a single `info`-severity finding standing in for "nothing",
was rejected: it would make `openFindings` count a non-finding as open and
force the next re-review to resolve it.

## 3. The replay key identifies the review, not the head (fleet#19)

The default idempotency key was `kind:record:head`, which encoded the
assumption that a revision worth re-reviewing always moves the head SHA. A
PR body is part of what the lead reviews (measurement claims, the risk
artifact pointer, and under squash-merge the permanent commit message) and it
changes without a commit. A formal re-review that links its prior artifact
(`--prior-artifact`) is therefore a new review even at an unchanged head:
the link joins the key (`formal:record:head:rereview:<prior>`), the
`ALREADY_REVIEWED` guard yields to the re-review path, and that path's own
preconditions still bind (the link must name the recorded prior, every open
prior finding needs a resolution). A retry of that same re-review still
replays. The artifact marks `sameHead: true` and its `range` is honest
(`X..X`). An unlinked second pass at the same head is still refused, and a
risk review at the same head is still one review. A linked pass at the same
head whose prior has nothing open (or no readable prior) is refused too: a
re-review at an unchanged head exists to resolve prior findings, so once the
chain is clean at a head it is one review at that head, never a pileup.

A replay says what it did not write: the result carries `ignored:
{findings, resolutions}` when the caller supplied either, and the CLI prints
that on stderr while still exiting 0, so a formatted summary cannot present a
retry as a record.

Not chosen: hashing the PR body into the key. It would make the key depend on
data the tool does not otherwise read, and a retry after any body edit would
silently become a second review with no prior link.

## 4. A re-readied PR re-enters ci-wait (fleet#34)

Section 1's guard held on the first round only. A lead that sends a PR back
to its IC leaves the Work record in `review`; when the IC pushes fixes and
re-readies the PR the head moves and every gate goes pending, but the watcher
took the change-within-review branch and recorded an observe with no wake.
The only producer of `checks-settled` is the `ci-wait -> review` transition,
and the record could never re-enter `ci-wait`, so an open, non-draft, fully
green PR sat with nobody woken (endzone PR #1258, 2026-09-11, rev 15: state
`review` while its own observation reported six pending gates). Worse,
`record --kind formal` could not refuse a review of pending gates, because
the state field said `review`.

Now a head SHA observed while in `review` that differs from the record's last
observed head walks the store's own path back to `ci-wait` (`revision`,
`pr-open`, `ci-wait`), which is also the truth of what happened: the lead
returned it, the IC re-opened it, CI is waiting. That restores the existing
transition, its `checks-settled` wake, and the section 1 guard in one stroke,
so the stale-review-with-pending-gates condition stops existing rather than
being worked around. Gates already green at the new head take the last hop
to `review` in the same tick with the wake, so no wake is a tick late; a red
gate at the new head wakes `checks-failed` from `ci-wait` as any first round
would. `hold` is untouched: a held PR is parked for Cory's merge, not being
reworked, and a head change there remains an observe.

Not chosen: emitting `checks-settled` from the change-within-review branch
when the evaluation flips settled at a new head. It would wake the lead but
leave the state field saying `review` over pending gates, and the guard in
section 1 would still be absent on every round after the first.

## 5. A risk artifact is read, not only written (fleet#43)

Endzone PR #1280 (issue #1240) tripped the `accessibility` trigger; the IC
hosted the reviewer, fixed five of six findings, and recorded a well-formed
artifact that reported coverage better than it was in three silent ways.

**A supplied finding never carries its own resolution.** Every finding was
written with `outcome: "fixed"` beside the forced `status: "open"`, on the
precedent of `ReportFindings`' documented `outcome` field; nothing in the
policy read `outcome`, so the human read five resolved and the machine read
six open. `record` now refuses a finding carrying `outcome` or `resolution`
(`FINDING_CARRIES_OUTCOME`, exit 2, before any file exists). The artifact
says what the reviewer found; what closed a finding is recorded by the
review that verified the close, through `--resolutions`. Not chosen: letting
`outcome` drive `status`. It would let the reviewed party close its own
findings in the artifact that opened them, with nobody's verification on
record.

**The formal review walks the risk chain.** `prior` was scoped per kind, so
a formal review never saw risk findings; no path produced a second risk
artifact; risk findings were write-only and could not go stale. The lead
already verifies every risk finding by hand (project-lead.md, Merge), so
the formal review that does so now records it: the risk artifact's open
findings need a resolution like any linked prior
(`UNRESOLVED_FINDINGS_UNACCOUNTED` names the artifact), still-open ones are
carried into the formal artifact with `carriedFrom`, and the formal
artifact names the `riskArtifact` it consumed so a later re-review binds to
the formal chain alone. `--no-findings` beside a still-open risk finding is
refused as before; a chain whose risk findings all resolved can say so. A
missing risk file degrades to `riskArtifactMissing: true`, as a missing
formal prior does. The two kinds stay separate reviews; what is coupled is
the resolution ledger, which was the open question in fleet#43. Not chosen:
a linked risk re-review path. It would have the IC verify its own fixes at
its own angle, which is the coverage hole the third ruling names.

**`reviewedSha` is the tree the reviewer read.** The qa-reviewer read
`000c07b9`; the IC recorded at `17fa3c48`, the post-fix head, and `headSha`
could not say which. Five focus and aria-state fixes landed after the
accessibility read and were reviewed by nobody at that angle, while the
artifact answered "covered". `record` now writes `reviewedSha` (from
`--reviewed-sha`, defaulting to the head) beside `headSha`, and a risk
artifact whose two differ carries `range: <reviewed>..<head>`, the delta no
reviewer at that angle has read, visible instead of implied. A formal
review is the lead's own read at the head it records, so there the two
must agree (`REVIEWED_SHA_MISMATCH`, exit 2): a moved head is a re-review,
never a record of a tree nobody read.

## 6. The reviewer is the session (fleet#46)

`record` wrote `reviewer: "unknown"` whenever `--actor` was omitted, the
documented invocation omitted it, and a replay cannot repair it (ruling 3),
so one record's chain carried `pl-endzone` on two artifacts and `unknown` on
the third. `record` and `hold` now default the actor to `FLEET_NAME`, which
every fleet session carries, before falling back to `unknown`; `--actor`
still wins. The documented lines carry `--actor` too, so a build without the
fallback still records provenance.

## 7. The hook and the review gate share one clock (fleet#51)

The lead's Stop hook read "CI settled" from live GitHub while `record
--kind formal` reads the Work record, which the PR watcher advances on a
five-minute tick. In the window between a green check and the next tick the
hook said "review #1285" and the gate refused #1285
(`INVALID_REVIEW_STATE`), and nine minutes later it named one reviewable and
one unreviewable PR in the same sentence. The lead had no sanctioned way to
close the gap: forging an observation and polling in a loop are both
forbidden for good reasons.

Now a PR awaits review only when its Work record is in `review`, the state
that opens the formal door (ruling 1). A PR green on GitHub whose record is
still `ci-wait` is named as lagging ("record still ci-wait", the watcher's
next tick moves it), never offered. Under `state/flags/pr-watch-off` the
records do not advance, so the live verdict decides again; a PR with no
Work record keeps the live verdict, labelled, so nothing goes invisible.
The hook's advice to schedule a `CronCreate` re-check for a PR waiting on
CI is gone: the watcher records `checks-settled` and the watchdog wakes the
lead. Not chosen: a lead-invoked "observe this PR now" command. It would be
a second writer of watcher evidence, and the lag it removes is at most one
tick.

## 6. A triggered head needs its risk review before the formal (fleet#64)

**Observed.** `record --kind formal` took the classification from the caller
and read `triggers: []` when none was passed, so every trigger guard was
walked past. Endzone PR #1380 formal-002 at `c4e31d2c` was recorded with
`tier: null`, `triggers: []` and no risk artifact while `classify` at that
head said `riskReview: true`. The lead's own finding in that artifact was the
only place the gap was written down.

**Ruled.** A formal record carries the head's classification
(`--classification`, from the lead's own `classify` run; `CLASSIFICATION_REQUIRED`
refuses without it). When that classification carries a trigger, the record
needs a risk artifact at that head, or it refuses with `RISK_REVIEW_MISSING`
(exit 2, nothing written, no state touched). Two doors stay open on purpose:

- `--risk-ruling "<why>"` is the lead ruling the trigger on record (a false
  positive, or covered by something it names). The ruling is written into the
  artifact as `riskRuling`, so the record says what the lead knew. A risk
  review never takes a ruling; the IC hosts it, the lead rules.
- A linked re-review (`--prior-artifact`) at a later head stands on the prior
  formal's walk of the risk chain (ruling 5): the delta is what the lead reads,
  and an earlier-head risk artifact is not refused there. A fresh formal at a
  new head is.

The guard sits in the record, not in a doc line, because the doc line already
said "a triggered diff missing that artifact goes back to the IC" and the
record accepted it anyway.

## 8. A recorded head is a commit (fleet#67)

**Observed.** `record --kind risk` on endzone #1382 accepted `headSha`
`0f2fb0064a7d4a0b5c1e2f3a4b5c6d7e8f9a0b1c`: the branch head's real 8-character
prefix followed by a padded pattern. The artifact landed, the record bumped a
revision and kept an idempotency key for the invented head. A corrected
`risk-002.json` followed 25 seconds later, so the chain self-healed; nothing
had stopped the first one. Every reader of these SHAs (the risk chain, ruling
5; `plan-rereview` ranges; the merge-time head check in project-lead.md) had
been keyed off a head nobody could have read.

**Ruled.** `record` resolves every SHA it is given (`--head-sha`, and
`--reviewed-sha` when it differs) against the tenant repo before it writes:
a fetch of the record's PR branch, then `git cat-file -e <sha>^{commit}`. An
object git does not hold is refused `UNKNOWN_COMMIT` (exit 2, nothing
written, no state touched, no key kept). The repo is `--repo-path`, or the
tenant file's `repo`; with neither the record is refused
`TENANT_REPO_UNKNOWN` rather than skipping the check. Three edges, on
purpose:

- The check is the last guard before the write, after every cheaper refusal
  (state, kind, findings, classification, the risk chain), because it runs
  git and a fetch; the refusal a caller sees first is the one that costs
  nothing to compute.
- A fetch that fails (offline, a branch not pushed yet) is tolerated: the
  object may be local. A missing object never is.
- An abbreviated SHA that names one commit is accepted as git accepts it. The
  artifact stores what was given; the guard asks only whether it exists.

A legacy artifact recorded before this section stands as written; a
re-review or a later record at a real head supersedes it in the chain the way
#1382's `risk-002.json` did. Two things stay as they were, on purpose: a
replay (an idempotency key the record already holds) returns the artifact it
recorded and writes nothing, so it is not re-resolved; and `plan-rereview`
resolves nothing itself, because it is a reader of these SHAs and the formal
record at that head is where the guard sits.
