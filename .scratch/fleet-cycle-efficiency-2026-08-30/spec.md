# Token-efficient Fleet cycle

Status: design approved; runtime implementation not authorized

## Goal

Reduce fleet control-plane token use by at least 70% per completed Unit of
work while preserving independent review, Cory's authority boundaries, and
reliable recovery. Claude sessions make judgments. Scripts observe, reconcile,
persist, schedule, and notify.

This specification covers one Fleet cycle: a ready Unit of work moving through
assignment, implementation, review, merge or Hold, and IC retirement. It also
covers the supervision needed to keep that cycle moving. It does not authorize
runtime changes, commits, or rollout.

## Measured baseline

The 2026-08-30 inventory found the following costs and failure modes:

| Signal | Observed baseline |
| --- | ---: |
| First-turn cache creation, project lead | 55,476 tokens |
| First-turn cache creation, Dispatcher | 53,003 tokens |
| First-turn cache creation, Sentinel | 50,221 tokens |
| First-turn cache creation, IC | 47,888-47,910 tokens |
| Project-lead job total | 4,433,652 tokens in about four days |
| Dispatcher job total | 1,110,666 tokens |
| Measured IC cumulative tokens | 76,076 median; 182,189 p90; 355,048 max |
| Global notice injected into every session | 33,036 characters |
| Roster | 1,083,740 bytes; 171 of 176 records retired |
| Project-lead polling activity | 350 check polls, 336 PR views, 226 forced continuation turns |
| Sentinel schedule | 96 Claude turns per day for mechanical checks |

The workflow also duplicates acceptance criteria across the issue, assignment
brief, launch prompt, and IC acknowledgement; repeats Standards and Spec review;
keeps copied session settings and temporary briefs after retirement; and stores
large prose status and exclusion files that models must reread.

## Outcomes and budgets

- Control-plane fresh tokens per completed Unit of work fall by at least 70%
  against the seven-day baseline. Fresh tokens are reported as input, output,
  and cache-creation fields; cache-read tokens remain a separate field and are
  never folded into a misleading aggregate.
- No Claude turn exists only to poll, keep a session alive, supervise another
  session, refresh status, or resend an unchanged notification.
- Project-lead fresh-token overhead is below 25,000 per merged pull request.
- Median IC cumulative tokens are below 60,000. An IC warns at 50,000 and moves
  to `escalated` at 75,000 unless its Work record contains an approved extension.
- The project lead rotates after five merges, 24 hours, or 250,000 cumulative
  job tokens, whichever occurs first.
- Initial first-turn cache-creation ceilings are 12,000 tokens for the
  Dispatcher, 20,000 for the project lead, and 25,000 for an IC or risk
  reviewer. A launch that exceeds its ceiling fails before assignment and
  reports the contributing context sources.
- Independent Standards and Spec review remains mandatory, but occurs once.
- Cory alone applies a tenant's ready label, merges carve-outs and Holds, and
  promotes `integration` to `main`.

## Authority and canonical state

GitHub is authoritative for issue and pull-request facts: state, body, labels,
assignees, dependencies, sub-issues, commits, reviews, and checks. Local state
contains only fleet facts: session ownership, Work record state, reservations,
token budgets, event offsets, review progress, notification delivery, and
exceptional Frontier exclusions. Reconciliation always refreshes GitHub facts
before a session acts.

A Claude session never edits durable coordination files directly. One state
command validates every transition and performs an atomic, mutex-protected,
idempotent compare-and-swap write against a monotonic Work record revision. It
then appends a typed Fleet event with a per-record sequence, actor, timestamp,
evidence pointer, and idempotency key. Messages contain the record id, revision,
event sequence, and artifact pointers; they do not restate issue bodies or
acceptance criteria.

Active Work records use these states:

| State | Meaning |
| --- | --- |
| `assigned` | Manifest and reservations exist; launch is pending acknowledgment. |
| `implementing` | The IC acknowledged the current manifest and is changing or testing the unit. |
| `pr-open` | The IC supplied the pull-request identity. |
| `ci-wait` | Required CI is incomplete and a script is watching for a state change. |
| `review` | Required gates settled and independent review is active. |
| `revision` | A review or CI finding was returned to the IC. |
| `hold` | The reviewed PR requires Cory's merge; this state is PR-only. |
| `merged` | GitHub reports the PR merged. |
| `retiring` | Evidence is being archived and ephemeral session material removed. |
| `retired` | Retirement completed; the record leaves active state. |
| `escalated` | A new human decision is required; `prior_state` and decision evidence are mandatory. |

Invalid transitions fail without mutation. Repeated commands with the same
idempotency key return the already-written revision and event. On resolution,
an escalated record returns to its recorded prior state or a validated successor.

Fleet events live in date-partitioned JSONL for 30 days, then move to archive.
Active state contains only active and retiring records. Retirement archives a
compact evidence index and removes copied per-session settings and temporary
briefs. Claude transcripts remain the transcript authority and are not copied
into fleet state.

## Assignment path

A deterministic script computes the frontier from ready GitHub issues. It
excludes assigned issues, unresolved dependencies, spec parents, issues marked
ready for human work, active reservations, collisions, and structured Frontier
exclusions. GitHub signals replace local exclusions whenever possible. Eligible
issues sort by `createdAt` ascending, then issue number ascending.

Before launch, the script reserves touched components and migration prefixes
and writes a compact immutable assignment manifest containing:

- issue URL and current body hash;
- base SHA, branch, tenant, model, risk class, and token budget;
- only the relevant `CONTEXT.md` headings and ADR paths;
- targeted test plan and expected CI gates;
- component and migration-prefix reservations.

The launcher fetches the intended remote base and resolves the manifest's base
SHA from that remote ref before creating the worktree. A stale shared checkout
must not select the assignment base.

The launch prompt points to the manifest. The IC emits `assignment-started`
during its first useful turn and does not repeat the criteria. A changed issue
body hash invalidates an unacknowledged manifest; the script releases its
reservations and recomputes it. The normal batch is at most two ICs. A third is
allowed only when its manifest proves no component, schema, migration-prefix,
or test-resource collision with active work.

## CI, review, and merge path

A script watches active pull requests and writes events only when observed CI
or PR state changes. Missing required gates never count as settled. The script
wakes the project lead only for `checks-settled`, `checks-failed`, or
`decision-needed`; the lead does not poll.

The IC runs targeted or affected tests plus relevant lint/build checks. CI is
the full-suite authority. Heavy local suites acquire a host-wide semaphore so
parallel ICs cannot each consume half the machine at once.

The project lead owns one independent Standards and Spec review after required
gates settle. The IC owns TDD and a targeted self-check, not a duplicate formal
review. An ephemeral risk reviewer is added only for a configured trigger such
as a carve-out, authentication or authorization, security, data integrity,
concurrency, destructive behavior, or material accessibility risk. Findings
are recorded once and referenced by event.

Complete issues close through the pull request's GitHub closing keyword. The
project lead never closes an issue unconditionally. Clean carve-outs and other
clean PRs requiring Cory enter `hold`, page once, and wait for Cory.

## Context, tools, and session lifetime

The global notice is removed from automatic injection. Notices are scoped by
role and tenant, carry an expiry or clearing event, and are included only when
relevant. Assignment manifests name the precise context headings and ADRs an IC
must read.

- Mechanical scripts receive no tenant prose and invoke no model.
- Dispatcher: Sonnet/low, tracker/messaging/state tools only, fresh daily.
- Project lead: Sonnet/high, tracker/review/messaging/state tools only.
- IC: engineering tools selected by manifest risk; no fleet-state write access.
- Risk reviewer: ephemeral, read-only review tools; Opus only for a configured
  high-risk trigger.

The Dispatcher reconstructs from state on its daily launch. The project lead
rotates only at a turn boundary with no active mutation: write the last consumed
event offset, stop and remove the old session, launch the replacement through
`launch.ps1`, then require it to reconcile all active records before acting.

## Status, notification, and supervision

Status views and digests are projections of Work records and the event ledger,
not model-authored prose. A minimal ephemeral notifier launches only for a new
`decision-needed` event, sends one push, records `notification-sent`, and exits.
A delivery failure remains visible in status but does not repeatedly page
without a new event.

A Windows Scheduled Task runs the mechanical supervisor after user logon,
consistent with ADR-0003. It compares roster intent, daemon liveness,
heartbeats, Work records, pull requests, Holds, and recovery facts, and applies
only deterministic actions. This supersedes the rostered Sentinel after a
48-hour shadow proves action and escalation parity. ADR-0002's single launch
door remains mandatory.

## Rollout and rollback

Each behavior has an independent feature flag and can return to its legacy
reader or actor without disabling the others:

1. Instrument token, tool, polling, review, wall-time, and completed-unit
   metrics for seven days; compact/archive state without changing decisions.
2. Shadow Work records, events, frontier selection, reservations, and CI state
   against the legacy workflow for at least 20 completed units. Every
   difference is either fixed or recorded as an intentional approved change.
3. Enable scoped context, review deduplication, two-IC batching, role tools and
   models, token gates, and bounded session rotation independently.
4. Run scheduled supervision beside Sentinel for 48 hours. Require action and
   escalation parity, then remove Sentinel. Retain the old roster entry and
   legacy actor as a disabled rollback path for one release.

Cutover requires no missed, duplicated, or reordered events; no polling-only
model turns; preserved independent review and authority; and independently
tested rollback for every flag.

## Delivery order

| Ticket | Vertical result | Blocked by |
| --- | --- | --- |
| 01 | One completed unit produces a trustworthy efficiency baseline | none |
| 02 | One unit can be reconstructed from validated Work record events | 01 |
| 03 | One ready issue becomes a reserved, acknowledged IC assignment | 02 |
| 04 | One open PR reaches the lead only when CI state changes | 02 |
| 05 | One settled PR receives exactly one risk-aware independent review | 03, 04 |
| 06 | One scoped session starts and rotates without transcript dependence | 02 |
| 07 | One decision event produces one digest entry and at most one page | 02, 04, 06 |
| 08 | One scheduled supervisor cycle matches Sentinel without a model turn | 07 |
| 09 | Shadow evidence enables bounded cutover and verifies the target budgets | 03-08 |

Tickets are self-contained under `issues/`. Their status is `needs-triage`
because the design is approved but runtime implementation has not been
authorized.
