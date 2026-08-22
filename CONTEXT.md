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

### Work

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
