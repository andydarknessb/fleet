# Wake the project lead only when an active PR changes state

Status: ready-for-agent
Blocked by: 02
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.

## Outcome

One open pull request moves from `pr-open` through `ci-wait` without model
polling, and the project lead wakes only when checks settle, fail, or require a
decision.

## Requirements

- Add a deterministic watcher for pull requests referenced by active Work
  records. It runs mechanically and invokes no model.
- Reconcile PR state, head SHA, required gates, watched checks, ignored checks,
  review state, merge state, and closing-keyword linkage from GitHub.
- Treat a missing required gate as incomplete, never settled. Preserve the
  existing semantics of watched and ignored checks.
- Write an event only when an observed value changes. Repeated identical polls
  update no record, append no event, and wake no session.
- Emit a project-lead wake only for `checks-settled`, `checks-failed`, or
  `decision-needed`, with Work record revision and evidence pointers.
- Move a merged PR to `merged`. Do not close its issue manually; verify GitHub's
  closing keyword owns issue closure and escalate a missing linkage before
  merge.
- Fail safe when GitHub is unavailable: retain the prior observation, expose
  watcher health, and do not infer success or absence.

## Acceptance criteria

- [ ] Fixtures cover pending, success, failure, skipped, cancelled, missing,
  watched, ignored, and unclassified checks.
- [ ] One hundred identical watcher runs append no event after the initial
  observation and create no model turn.
- [ ] A changed gate state appends exactly one ordered event and one eligible
  wake; an idempotent retry appends neither.
- [ ] Missing required gates cannot produce `checks-settled`.
- [ ] GitHub failure produces visible watcher health evidence without changing
  the Work record to a successful state.
- [ ] A PR without the required closing linkage reaches `decision-needed`; the
  project lead has no unconditional issue-close path.

## Answer

Not implemented. Runtime work requires separate authorization.
