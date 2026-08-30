# Measure one Fleet cycle without changing its behavior

Status: needs-triage
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
- Define control-plane fresh tokens as Dispatcher, project-lead, Sentinel, and
  exceptional-notifier input, output, and cache-creation fields. Report
  cache-read tokens alongside them without combining the fields.
- Classify a turn as polling-only when it produces no new GitHub fact, Fleet
  event, review finding, decision, artifact, or state transition.
- Preserve raw evidence pointers and report excluded or incomplete samples.
- Produce a machine-readable daily artifact and a compact seven-day Markdown
  summary. Do not inject either into session startup context.

## Acceptance criteria

- [ ] A fixture representing one merged and retired unit yields one record with
  each required metric and no double-counted model usage.
- [ ] Re-running the collector against the same evidence is byte-stable.
- [ ] Cache-read tokens cannot be mistaken for fresh tokens in JSON or Markdown.
- [ ] Polling-only classification has fixtures for a repeated PR view, a changed
  check state, a new review finding, and a state transition.
- [ ] The collector runs for seven calendar days before ticket 09 enforces a
  budget, and the report records sample size and missing evidence.
- [ ] No fleet actor, prompt, status, or scheduling behavior changes.

## Answer

Not implemented. Runtime work requires separate authorization.
