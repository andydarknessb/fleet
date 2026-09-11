# Fleet

The standing crew of Claude Code processes that runs Cory's projects between
prompts: a small hierarchy of long-lived sessions that hand work down, report
up, and restart one another. The fleet spans projects; each project is a tenant
with its own repository and issue tracker, never the other way round.

## Language

### Running things

**Session**:
One running Claude Code process, interactive or background, with a name. The
thing that can be listed, messaged, attached to, and respawned. A session
outlives any single task it is given.
_Avoid_: agent, instance, process

**Worker**:
A subagent spawned inside a session for a bounded job. It has no name on the
fleet roster, is not listed or respawned, and is resumable only by the session
that spawned it. A worker's work is attributed to its parent session.
_Avoid_: agent, subagent, helper

**Role**:
A definition file that gives a session or worker its model, tool set, and
standing instructions. Roles are templates; sessions are the things running
them. Several sessions may run one role.
_Avoid_: agent, persona, profile

### Job titles

**Lead**:
A session with no tenant of its own. There are exactly two, with different
jobs, and each watches the other's liveness: the Dispatcher and the Sentinel.
_Avoid_: orchestrator, manager, supervisor (the supervisor is the daemon
until the 08b cutover, then the Watchdog task; a lead is never one)

**Dispatcher**:
The lead that is Cory's interface to the fleet: it assigns tenants to project
leads, relays escalations upward, and produces the daily digest.
_Avoid_: lead A, main agent, coordinator

**Sentinel**:
The retired lead that kept the fleet alive and within its cap as a rostered
session until the 08b cutover (2026-09-04); the Watchdog task now does that
work. Its roster entry and role file remain for one release as the rollback
path and are then deleted.
_Avoid_: watchdog (the task), monitor, health checker

**Project lead**:
A session that owns exactly one project: it turns the project's issues into
work for ICs, reviews what comes back, and reports to a lead. One role covers
both the "tech lead" and "PM" emphases; the difference is prompt, not
machinery.
_Avoid_: PM, tech lead, agent

**IC**:
A session that does one unit of work for one project and reports to that
project's project lead. It never talks to a lead or to Cory directly.
_Avoid_: agent, worker (a worker is a subagent; an IC is a session)

### Keeping it alive

**Roster**:
The fleet's list of sessions that are supposed to exist: name, role, tenant,
and who each reports to. The Sentinel compares the roster against what is
actually running; anything on the roster and not running is a fault.
_Avoid_: fleet config, session list, org chart

**Heartbeat**:
A timestamp a session records every time it finishes a turn. A stale heartbeat
on a session that claims to be working is the signal for "alive but stuck".
_Avoid_: ping, keepalive, health check

**Cap**:
The maximum number of fleet sessions allowed to exist at once. Workers do not
count. Launching past the cap is refused, never queued.
_Avoid_: limit, quota, concurrency

**Escalation**:
A condition an IC or project lead may not resolve on its own, handed one level
up the reporting line until it reaches Cory: a permission prompt, red CI twice
on one PR, scope drift, or a day without a commit. Escalations are the only
events that page Cory through the reporting line. While the rostered Sentinel
is enabled the Watchdog's out-of-band page exists solely for when that line
itself is down; after the 08b cutover the Watchdog is the top of the
mechanical line and files the check's escalations itself, one page per new
one, never a repeat.
_Avoid_: alert, error, blocker, "off the rails"

**Reporting line**:
The fixed path a message takes: IC to project lead, project lead to
dispatcher, dispatcher to Cory; the Sentinel reports to the dispatcher. A
respawned session is told what it was doing by its parent on this line, never
by the Sentinel. Nobody skips a level.
_Avoid_: chain of command, hierarchy, org chart

**Pause**:
The fleet-wide switch that stops every launch and every project lead's loop
until it is cleared. Set by Cory by hand or by the Sentinel on a rate-limit
signal; sessions finish their current turn and go idle. It is the only way to
stop the fleet without hunting sessions.
_Avoid_: kill switch, freeze, stop-the-world, maintenance mode

**Notice**:
One paragraph of operator instruction on a scoped board -
`state/notices/all.md`, `<role>.md`, or `tenant-<tenant>.md` - injected at
session start only for the sessions its scope names. A notice carries its own
end: `[until YYYY-MM-DD]`, `[cleared-by <work-record-id> <state>]`, or Cory's
hand. The retired global board `state/NOTICE.md` is injected only under the
rollback flag `state/flags/legacy-notice`; a standing rule belongs in a role
file, not on a board.
_Avoid_: broadcast, announcement, memo

**Rotation**:
The bounded lifetime of a control-plane session: at a set boundary (merges
delivered, hours alive, or cumulative job tokens) it retires and a replacement
launches through the one door, reconstructing its position from canonical
state - the roster, Work records, issues, and the skip file - never from its
predecessor's transcript. A respawn is not a rotation: it re-pins the old
flags and keeps the old transcript.
_Avoid_: restart, refresh, recycle

**Watchdog**:
The scheduled task, never a session, that runs the mechanical check every
fifteen minutes. While the rostered Sentinel is enabled it shadows: it keeps
the parity log and pages Cory out of band - a toast and a red banner in the
status view - only when self-healing is the casualty (the check cannot run,
the Sentinel is stale, every static heartbeat is stale, or launches of one
name keep failing), and acts on nothing. After cutover
(`state/flags/sentinel-off`) it is the supervisor: the check applies, a
missing static session launches through the one door, and a respawn or a
new escalation of a paging kind leaves one escalation file and pages once;
`blocked` is recorded, never paged. Two actors never run: a Sentinel session
alive under the flag is the double-actor condition, and the Watchdog stays in
shadow until it is gone.
_Avoid_: sentinel (a session), monitor, health checker

### Work

**Fleet cycle**:
The path one ready unit of work takes through assignment, implementation,
review, merge or hold, and IC retirement. It excludes keeping sessions alive,
respawning them, and reboot recovery.
_Avoid_: dynamic workflow, workflow (unqualified)

**Work record**:
The fleet-owned coordination state for one unit of work: its current state in
the Fleet cycle, owning session, reservations, review progress, token budget
and pending decisions. GitHub remains authoritative for the issue and pull
request. A Work record is terminally archived after IC retirement; an
assignment returned before implementation is stored as a reusable release. A
touched attempt that cannot continue is stored as a reusable abandonment with
its reason. The next reservation continues the record's revision and event
sequence in either reusable case.
_Avoid_: status file, task record, issue record

**Fleet event**:
An immutable statement that one Work record changed, naming the event type,
actor, time and evidence pointer. Messages announce Fleet events but never
replace them as state.
_Avoid_: update, message, log entry

**Control plane**:
The Dispatcher, project lead, Sentinel, and exceptional notifier work that
routes, observes, or reports Fleet cycles rather than implementing a Unit of
work. Its token usage is measured separately from IC delivery work.
_Avoid_: management work, overhead (when the measured category is meant)

**Tenant**:
A project the fleet runs: one repository, one issue tracker, one project lead.
_Avoid_: project (when the distinction from the fleet itself matters), workspace

**Unit of work**:
A GitHub Issue carrying the tenant's ready-for-agent label. The only thing an
IC may be assigned. Project leads may file and spec issues; only Cory applies
the label.
_Avoid_: task, ticket, job

**Carve-out**:
A change that may never merge without Cory, however green it is: migrations,
deploy hooks, environment and secrets. The list lives in the project lead's
role, not in its judgement.
_Avoid_: protected change, sensitive PR, exception

**Watched check**:
A tenant CI check whose executed failure the project lead must inspect and
report as a finding, but which never satisfies or blocks a merge gate. Passing,
pending, skipped, and missing watched checks have no gate effect. A check not
listed as a gate, watched check, or ignored check is unclassified, not watched.
_Avoid_: optional gate, ignored check, non-required check

**Risk reviewer**:
An ephemeral, read-only `qa-reviewer` worker added to a Unit of work only when
a configured risk trigger fires (carve-out, auth, security, data integrity,
concurrency, destructive behavior, material accessibility). The IC hosts it
pre-PR-ready; its findings land once, in the unit's review artifact, and the
spawning session verifies every claim. Every PR still gets the project lead's
one formal Standards and Spec review; a diff without a trigger never gets a
risk reviewer.
_Avoid_: second reviewer, QA pass, extra review angle

**Researcher**:
A Worker spawned to find facts and report them: documentation, how a thing
works, where it is called, what a log or thread says. It edits nothing and
decides nothing, and it runs on the cheapest tier that can read. Reading what
was handed to a session is that session's own job; going to find something out
is a Researcher's. Authoring and judgment never delegate to one.
_Avoid_: explorer, lookup agent, research sub-agent

**Budget**:
The token line a Unit of work is measured against: job tokens (input plus
output, never cache fields) summed over the IC session's transcript. The
Work record gets one warning event at the warning threshold and is escalated
at the escalation threshold unless an approved extension, granted by Cory
through the state command with an amount and a reason, raises the line. The
measurement is a projection (`state/budget/last.json`); only the crossings are
Fleet events. Live behind `state/flags/budget-live`; with the escalation
threshold set to null it is warning-only (the soak ruled 2026-09-09), and
`state/budget/summary.md` is the one place to read it.
_Avoid_: quota, allowance, token limit (unqualified), cost

**Frontier**:
The ordered set of ready Units of work the fleet may launch next: open,
carrying the tenant's ready label, unassigned, with no open blockers, not a
spec parent, not marked ready for human work, not reserved by an active Work
record, and not under a Frontier exclusion; oldest first. The assignment
planner (`bin/assignment.js`) computes it from GitHub facts; the project
lead's Stop hook records its own legacy computation beside it for parity
(`bin/assignment-parity.js`) and, once `state/flags/assignment-live` stands,
decides from the planner's answer.
_Avoid_: queue, backlog, ready list

**Assignment manifest**:
The immutable, compact record of one reserved assignment: issue URL and body
hash, base SHA resolved from the fetched remote ref, branch, tenant, model,
risk class, token budget, the CONTEXT.md headings and ADR paths the IC must
read, the test plan and CI gates, and the reservations. Its Work record starts
`assigned` and becomes `implementing` when the IC acknowledges it; a changed
issue body or base before acknowledgment invalidates it. It points at the
issue and never restates the acceptance criteria.
_Avoid_: brief (the legacy prompt payload), assignment prompt, ticket copy

**Frontier exclusion**:
A ready Unit of work the fleet must not launch because an exceptional fleet
fact that GitHub cannot express keeps it outside the assignment frontier. The
exclusion is structured and names a reason, evidence pointer, owner, and
recheck event or expiry; it lives in the tenant's exclusion ledger
(`state/exclusions/<tenant>.jsonl`, append-only) and leaves the frontier by
its owner's lift, its expiry, or the named Fleet event, keeping its history.
GitHub labels, assignees, dependencies, and sub-issue structure take
precedence whenever they can express the condition.
_Avoid_: hold (a reviewed PR waiting for Cory), skip, blocked

**Notifier**:
The ephemeral process launched for one decision event (a Work record entering
`escalated` or `hold`). It claims the event through the state command, sends
one push, records the delivery as a Fleet event, and exits. A failed delivery
is visible delivery state, not a reason to page again: only a retry
authorization or a materially new decision event creates another attempt. Its
message is a typed pointer (record id, revision, event sequence, artifact
locations), never a copy of the issue, criteria, or findings.
_Avoid_: pager, alerter, notification session, reminder

**Digest**:
The script projection of Work records, the event ledger, and the exclusion
ledgers at a named offset: decisions needing Cory with their delivery state,
active work, merges, frontier exclusions, and Cory's authority. Rebuilding the
same offset gives the same bytes; nothing model-authored is appended to it.
_Avoid_: status report (when the projection is meant), summary, board

**Hold**:
A pull request reviewed clean and parked for Cory's merge, recorded under
`prs` in `state/skip/<tenant>.json` with its reason. A hold pages Cory once,
through an escalation, and then waits; the IC that opened it waits with it
and is neither retried nor respawned for being idle. Lifting the hold is
Cory's merge, or Cory's instruction to the project lead.
_Avoid_: blocked (a GitHub issue dependency), escalation (the page, not the
state), parked
