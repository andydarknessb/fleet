---
status: accepted
---

# The review gate is a required status check, not an instruction

A pull request into a tenant's default branch merges only when a
`fleet-review` commit status is green on its head commit. Recording a formal
review through `review-policy.js record --kind formal` posts that status for
the head it reviewed. A pull request with no Work record (Cory's own
interactive work, Dependabot) gets the same status through
`review-policy.js attest`, which takes the pull request, the head commit and
the path of a findings artifact. The tenant's branch ruleset requires the
check. A new push moves the head, so the status does not carry over and the
new head needs its own review, which is the rule the review artifact already
keys on.

Until now "no merge without a recorded formal review" lived in the project
lead's role file, and `pr-watch.js` said why: a script "cannot block" the
merge, "the lead merges through gh", so it can only be seen. On 2026-09-12 it
was seen and nothing else happened. Work records #1241 and #1263 (1,308 added
lines between them) merged four minutes and seventeen milliseconds after their
gates went green, with no review on the record or on GitHub; the watcher
raised `decision-needed` for both and the page reached nobody. A retroactive
review on 2026-09-17 found three major defects in one of them, live in
production. GitHub can block what a script cannot.

Alternatives rejected. Detection plus a working page (ADR 0012) shortens the
time to notice and still lets the merge happen. A separate GitHub identity for
the fleet is the deeper fix for a different problem, that the fleet and the
owner share one login so `mergedBy`, Approval and assignment say nothing about
who acted; it is ruled as later work and gets its own ADR when built. It would
not by itself stop an unreviewed merge.

## Consequences

- Cory's sessions go through the same door as the fleet: a review, an
  artifact, a status. Fifty-four interactive pull requests merged into
  `integration` in the audited week; each now needs an attestation.
- Release pull requests into the release branch are unaffected; the ruleset
  that gains the check is the default branch's.
- The status is evidence that a review was recorded for that commit, not that
  the review was good. Review quality is a separate concern: an enforced
  severity and category on every finding, a first review that is exhaustive so
  a re-review reads only the changed range and what is unresolved, and an
  escalation for a Ruling when the same finding is raised a second time, with
  a hard stop at the third send-back.
- The tenant file names the check, so `ciGates` and the ruleset stay the one
  list they are today.

## Amendment 2026-11-06 - Reconcile PRs pass through a standing exception (fleet #382, owner ruling)

Cory ruled, 2026-11-06: a Reconcile PR (CONTEXT.md) passes the review gate
through a standing exception instead of a formal review, because its content
already landed on main under Cory's own merge. The PR watcher, a script,
merges one as a merge commit when it has no conflicts and its checks are
green; one with conflicts follows the branch-diverged escalation to Cory as
before. Only tenants with a separate integration branch have Reconcile PRs
(endzone and statelite).

The audit behind it: Reconcile PRs were the slowest pull requests of the two
weeks to 2026-11-06 (191, 91 and 22 hours on endzone, 34 on statelite), and
endzone's pipeline stopped for a week behind one. Implemented by fleet #390.
