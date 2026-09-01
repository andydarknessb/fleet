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
_Avoid_: orchestrator, manager, supervisor (the supervisor is the daemon)

**Dispatcher**:
The lead that is Cory's interface to the fleet: it assigns tenants to project
leads, relays escalations upward, and produces the daily digest.
_Avoid_: lead A, main agent, coordinator

**Sentinel**:
The lead that keeps the fleet alive and within its cap: it reads heartbeats,
respawns sessions, sweeps stale worktrees, and never reasons about work.
_Avoid_: lead B, watchdog, monitor, health checker

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
events that page Cory.
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

### Work

**Fleet cycle**:
The path one ready unit of work takes through assignment, implementation,
review, merge or hold, and IC retirement. It excludes keeping sessions alive,
respawning them, and reboot recovery.
_Avoid_: dynamic workflow, workflow (unqualified)

**Work record**:
The active fleet-owned coordination state for one unit of work: its current
state in the Fleet cycle, owning session, reservations, review progress, token
budget and pending decisions. GitHub remains authoritative for the issue and
pull request; the Work record is archived after IC retirement.
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

**Frontier exclusion**:
A ready Unit of work the fleet must not launch because an exceptional fleet
fact that GitHub cannot express keeps it outside the assignment frontier. The
exclusion is structured and names a reason, evidence pointer, and recheck event
or expiry. GitHub labels, assignees, dependencies, and sub-issue structure take
precedence whenever they can express the condition.
_Avoid_: hold (a reviewed PR waiting for Cory), skip, blocked

**Hold**:
A pull request reviewed clean and parked for Cory's merge, recorded under
`prs` in `state/skip/<tenant>.json` with its reason. A hold pages Cory once,
through an escalation, and then waits; the IC that opened it waits with it
and is neither retried nor respawned for being idle. Lifting the hold is
Cory's merge, or Cory's instruction to the project lead.
_Avoid_: blocked (a GitHub issue dependency), escalation (the page, not the
state), parked
