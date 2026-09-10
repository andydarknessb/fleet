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
risk review at the same head is still one review.

A replay says what it did not write: the result carries `ignored:
{findings, resolutions}` when the caller supplied either, and the CLI prints
that on stderr while still exiting 0, so a formatted summary cannot present a
retry as a record.

Not chosen: hashing the PR body into the key. It would make the key depend on
data the tool does not otherwise read, and a retry after any body edit would
silently become a second review with no prior link.
