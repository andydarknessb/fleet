---
status: accepted
---

# The running fleet follows a `live` ref that only a green `master` advances

The checkout the fleet executes from (`C:\Users\Cory\fleet`) sits on a `live`
ref, not on `master`. `master` gets a CI workflow on a Windows runner that
runs every `tests/*.tests.js` and `tests/*.tests.ps1` through one aggregate
runner. On each Watchdog tick, if `master`'s CI is green and `live` is behind
it, `live` fast-forwards to `master`. A flag (`state/flags/deploy-hold`)
freezes the advance, and rolling back is moving `live` back. Role-file changes
still take effect at a session's next launch or Rotation, as today.

ADR 0008 described the problem: every role, the Watchdog and the hooks execute
`bin/` straight from the working tree, so a merge into `master` is an
execution, with "no build, no `package.json`, no CI workflow and no deploy
step" in between. In the week of 2026-09-10 to 09-17, 37 pull requests merged
into that tree, fixing 33 defects, 14 of them in two state machines
(reservation matching and review policy) that every tenant's work passes
through. Nothing ran the test suite on any of them except the session that
wrote the change.

Alternatives rejected. CI alone does not help: the next `git pull` still moves
the running tree to a commit nobody has seen pass. A canary that holds
launches for a tick after each advance was rejected as more mechanism than the
risk needs while rollback is one ref move. Advancing `live` by hand was
rejected because the week's evidence is that by-hand steps are the ones that
get missed.

This does not reopen ADR 0008. That ADR names "a checked-out release ref the
roles execute" as what would reopen the question of the fleet being its own
tenant; this decision builds that ref and deliberately stops there. Fleet
tickets still go to Cory's sessions.

## Consequences

- Nobody commits in the live checkout. Fleet changes are made in a worktree on
  a branch off `master`, which was already the rule.
- A red `master` stops deploys and nothing else. The fleet keeps running the
  last commit that passed.
- The known contention flake (the work-state mutex test under a parallel run)
  means the aggregate runner runs suites one at a time.
- `state/` stays outside all of this: it is not in the repository and no ref
  move touches it. A change that needs a state migration ships the migration
  as a script Cory runs, never as a side effect of the advance.
- The ledger verifier gains one invariant the week showed was missing: a Work
  record that reaches `merged` with no `review-recorded` event for that head
  fails verification.
