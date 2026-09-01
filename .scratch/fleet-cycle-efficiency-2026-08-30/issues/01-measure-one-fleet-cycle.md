# Measure one Fleet cycle without changing its behavior

Status: ready-for-human
Blocked by: none

## Outcome

Every completed Unit of work produces a reproducible efficiency record, and a
seven-day report establishes the baseline that later tickets must beat. This
ticket observes the legacy workflow only; it does not change assignment,
review, supervision, or session lifetime.

## Requirements

- Add a read-only collector that identifies a completed unit by tenant, issue,
  pull request, merge event, and IC retirement.
- Record per role and per unit: input, output, cache-creation, and cache-read
  tokens as separate fields; first useful turn cache creation; cumulative job
  tokens; tool-call counts by command class; messages; polling-only turns;
  forced continuation turns; formal review passes; wall time; and outcome.
- Treat transcript content as evidence, not as authority for issue or pull
  request state. When a tenant configuration is available, verify every
  candidate merge with one bounded read-only `gh pr list --state all` query per
  tenant and exclude unknown or non-merged PRs. Record verification errors.
- Report every observed role session under a role-specific aggregate. The
  control plane is the Dispatcher, project lead, Sentinel, and notifier; IC
  delivery metrics remain separate.
- Define control-plane fresh tokens as Dispatcher, project-lead, Sentinel, and
  exceptional-notifier input, output, and cache-creation fields. Report
  cache-read tokens alongside them without combining the fields.
- Classify a turn as polling-only when it produces no new GitHub fact, Fleet
  event, review finding, decision, artifact, or state transition.
- Preserve raw evidence pointers and report excluded or incomplete samples.
- Produce a machine-readable daily artifact and a compact seven-day Markdown
  summary. Do not inject either into session startup context.

## Acceptance criteria

- [x] A fixture representing one merged and retired unit yields one record with
  each required metric and no double-counted model usage.
- [x] Command-class counts include GitHub reads, GitHub mutations, tests/builds,
  scripts, skills, workers, messages, and an explicit fallback class.
- [x] A startup acknowledgement before the first tool/artifact turn does not
  become the first useful-turn cache-creation measurement.
- [x] A supplied GitHub state map accepts only a PR with `state=MERGED` and a
  non-empty `mergedAt`; an open, missing, or failed lookup is excluded with a
  verification error.
- [x] Re-running the collector against the same evidence is byte-stable.
- [x] Cache-read tokens cannot be mistaken for fresh tokens in JSON or Markdown.
- [x] Polling-only classification has fixtures for a repeated PR view, a changed
  check state, a new review finding, a Fleet event, a state transition, and an
  artifact-producing turn.
- [x] Exclusions with a known launch or retirement timestamp are filtered by the
  requested period; unknown timestamps remain visible as incomplete evidence.
- [x] Role-specific aggregates include at least one control-plane session and
  keep its cache-read tokens separate from IC delivery tokens.
- [ ] The collector runs for seven calendar days before ticket 09 enforces a
  budget, and the report records sample size and missing evidence.
- [x] No fleet actor, prompt, status, or scheduling behavior changes.

## Answer

Implemented as a standalone read-only collector in `bin/measure-cycle.js` with
Node test coverage in `tests/measure-cycle.tests.js`. The collector writes a
rolling daily JSON artifact and a seven-day Markdown summary, verifies merged PR
state with one bounded GitHub query per configured tenant, preserves evidence and
exclusions, and does not alter fleet actors or scheduling. The seven-calendar-day
observation period remains operational work before ticket 09 enforces a budget.
