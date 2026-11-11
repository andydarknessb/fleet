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

## Amendment 2026-11-11 - a code reviewer worker reads the diff for the formal review (fleet #425, owner ruling)

Cory asked for a code reviewer role, 2026-11-11. The owner session ruled its
shape:

1. The role is a worker, not a session: `agents/code-reviewer.md`,
   `claude-sonnet-5-5` at xhigh, read-only. It has no roster row and the launch
   door does not change.
2. The project lead spawns exactly one per PR in `review`, and one per
   re-review round. It replaces the two `/code-review` finders.
3. The reviewer's read is the exhaustive one, at the lead's two angles,
   Standards and Spec. The lead reads what each finding cites, enough to verify
   it, and does not read the whole diff a second time.
4. The formal artifact, its actor (`pl-<tenant>`), the review status and every
   gate in `bin/review-policy.js` stay as they are.
5. The `qa-reviewer` keeps its model, effort and trigger (ADR 0017, amendment
   of 2026-11-06).
6. The scorecard's escaped-defects line and the weekly second read are the
   watch. If escaped defects rise after this lands, the lead goes back to
   reading the diff.

In the two weeks to 2026-11-11 the lead's formal reviews recorded no blocker
and 25 majors over 288 artifacts, while the risk reviewer, a focused worker at
xhigh, recorded 7 blockers and 26 majors over 135. In the week to 2026-11-10
a statelite project lead session spent a median of 198K fresh tokens, and most
sessions held one review.
