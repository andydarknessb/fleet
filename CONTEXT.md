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
A session with no project of its own. It is Cory's interface to the fleet,
assigns projects to project leads, and watches the other lead.
_Avoid_: orchestrator, manager, supervisor (the supervisor is the daemon)

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

### Work

**Tenant**:
A project the fleet runs: one repository, one issue tracker, one project lead.
_Avoid_: project (when the distinction from the fleet itself matters), workspace

**Unit of work**:
A GitHub Issue carrying the tenant's ready-for-agent label. The only thing an
IC may be assigned. Project leads may file and spec issues; only Cory applies
the label.
_Avoid_: task, ticket, job
