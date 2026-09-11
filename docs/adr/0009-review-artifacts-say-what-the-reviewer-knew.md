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
