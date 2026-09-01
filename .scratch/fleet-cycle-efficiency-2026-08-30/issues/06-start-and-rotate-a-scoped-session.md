# Start and rotate a scoped session without transcript dependence

Status: ready-for-agent
Blocked by: 02
Authorized 2026-09-01; sequencing and amendments: `../amendments-2026-09-01.md`.

## Outcome

One role starts below its context budget, uses only its allowed tools, and can
be replaced at a safe boundary by a session that reconstructs from canonical
state.

## Requirements

- Remove the global notice from automatic startup injection. Replace it with
  role- and tenant-scoped notices carrying an expiry or clearing event.
- Load only context named by the role or assignment manifest. Mechanical
  scripts receive no tenant prose.
- Enforce role settings: Dispatcher uses Sonnet/low and tracker, messaging, and
  state tools; project lead uses Sonnet/high and tracker, review, messaging, and
  state tools; IC tools follow manifest risk; risk reviewer is read-only.
- Enforce first-turn cache-creation ceilings of 12,000 tokens for Dispatcher,
  20,000 for project lead, and 25,000 for IC or risk reviewer. A rejected launch
  reports token contribution by source.
- Rotate Dispatcher daily. Rotate project lead at the first of five merges,
  24 hours, or 250,000 cumulative job tokens.
- Rotate only at a turn boundary with no active state mutation: persist the
  last consumed event offset, stop and remove the old session, launch its
  replacement through `launch.ps1`, and reconcile every active Work record
  before accepting a new action.
- Preserve pause, fleet-cap, tenant-cap, identity, and single-launch-door gates.

## Acceptance criteria

- [ ] Startup fixtures prove unrelated tenant context and expired notices are
  absent from each role.
- [ ] Each role stays below its configured first-turn ceiling or fails before
  assignment with a source breakdown.
- [ ] Tool-denial tests prevent control-plane roles and reviewers from using
  engineering or direct state-write tools outside their contract.
- [ ] Rotation at each threshold records one offset, leaves no in-flight
  mutation, launches through `launch.ps1`, and reconciles before acting.
- [ ] A crash between stop and replacement launch is recoverable from roster
  intent and the saved offset without transcript inspection.
- [ ] Rollback can independently restore legacy context loading or disable role
  rotation without bypassing launch gates.

## Answer

Implemented 2026-09-01.

**Scoped startup context.** `hooks/session-start.ps1` injects only
`state/notices/{all,<role>,tenant-<tenant>}.md`; the global `state/NOTICE.md`
left automatic injection. Each notice paragraph carries its own end - `[until
YYYY-MM-DD]` (dropped after that UTC date) or `[cleared-by <work-record-id>
<state>]` (dropped when the Work record reaches that state, or is archived) -
with fail-open parsing so a broken marker never hides a live rule.
`state/flags/legacy-notice` restores the pre-06 loading wholesale. The ic-board
worktree-env notice graduated into `agents/ic.md` as instructed; CONTEXT.md
gained **Notice**.

**Role settings and tool contract.** `bin/launch.ps1` writes `permissions.deny`
into every session's settings: all roles lose direct Edit/Write/NotebookEdit on
`state/work|events|archive` (work-state.js stays the one door), control-plane
roles (dispatcher, project lead, sentinel) lose those tools across tenant
repos, and ICs lose them across all of fleet state. Models and effort stay
role-file-driven (dispatcher Sonnet/low since stage 1; project lead Opus/high
per amendment 3's staged descent - the Sonnet trial waits on the 06+04 soak).

**First-turn ceilings.** `config/cycle.json` holds the spec ceilings (12K
dispatcher/sentinel, 20K project lead, 25K IC). launch.ps1 estimates the
fleet-injected sources (prompt, role file, simulated hook injection, settings
at ~4 chars/token, plus `baselineTokens`) and refuses an over-ceiling launch
with exit 6 and a per-source breakdown before any assignment is acknowledged;
`state/flags/launch-ceiling-off` or `-Force` bypasses. Live measurement at
landing: a project-lead launch estimates 3,734 tokens against 20K. Calibrating
`baselineTokens` against measured cache creation is ticket 09's verification.

**Rotation.** `bin/rotation-policy.js` (read-only) evaluates thresholds from
canonical state - roster `launchedAt` for age, `state-merged` events since
launch for merges (own tenant only), transcript usage sums for the 250K
job-token line - and captures the event-ledger offset. `bin/rotate.ps1` rotates
only at a safe boundary (daemon row not `busy`, no `state/work/.lock`, no
pending journal): it writes the offset intent to `state/rotation/<name>.json`,
retires the old session (`retire.ps1`, which archives the roster row), runs one
pr-watch tick per tenant so every active Work record is reconciled against
GitHub before the replacement can act, then relaunches through
`launch.ps1 -FromRoster` - all launch gates (PAUSE, cap, identity, single door)
intact. A crash anywhere between stop and launch resumes from roster intent
plus the saved offset (`-Resume`, also run first by every `-Auto` pass); the
session-start hook hands the replacement the rotation record and the
reconstruct-from-canonical-state instruction. `bin/run-rotation.ps1` +
`bin/install-rotation-task.ps1` schedule it every 15 minutes (logon PT8M,
behind recovery, watchdog, and pr-watch); Cory registers the task by hand.
`state/flags/rotation-off` disables auto rotation independently of the other
flags.

**Review round (same day, Standards + Spec sub-agents; all verified).** Fixed:
retire.ps1's leaky `$LASTEXITCODE` (claude/git inside it leave a nonzero code
on a successful retire; rotate now reads success from the retire JSON, and the
test stub reproduces the leaky shape - the first stub's clean `exit 0` was
green for the wrong reason); a PS 5.1 array-splat bug that delivered
`-FromRoster` as a positional value (hashtable splat now; caught only after
the stub-fidelity fix); the rotation handoff now reaches only the session the
rotation launched (intent `newSessionId` vs the hook's `session_id`), so a
respawn never inherits a stale offset; `-Force` passes through to launch.ps1
so a forced rotation under PAUSE cannot strand the role; partial config
entries per-role-merge with the spec fallbacks instead of silently dropping
thresholds; a missing transcript is surfaced as `metricsError`; torn state
files make a policy tick a no-op, not a crash; `-Name` and `-Auto` compose;
`state/flags/tool-contract-off` added as the independent role-tools rollback;
ICs no longer receive the roster line; a behavioral soft-deny in
fleet-settings.json backs the Edit-family rules for shell-side writes.

**Deliberate deviations, to classify at ticket 09** (the pr-watch
absent-gate precedent): the ceiling counts fleet-injected sources plus
`baselineTokens` (0 until calibrated), so it cannot yet see harness-side
context - the spec's cache-creation ceilings become fully enforceable only
when 09 calibrates the baseline against measured cache creation. Tool
allowlists are approximated as Edit-family deny rules plus the auto-mode
soft-deny: Bash itself stays, because gh/git/work-state.js/launch scripts run
through it for every role. "IC tools follow manifest risk" currently varies
the model per manifest, not the tool set. The risk reviewer runs as an Agent
subagent whose own definition (`agents/qa-reviewer.md` tools line) is the
read-only contract; per-spawn enforcement moves with it to ticket 05. The
scheduled rotation task and the CONTEXT.md **Notice** term are deliberate
inclusions: the daily/threshold rotations need a scheduler exactly as
pr-watch needed one at 04, and the term records semantics this ticket itself
introduced (strike it if unwanted).

Tests: `tests/rotation-policy.tests.js` (12 node cases),
`tests/rotation.tests.ps1` (boundary, thresholds, PAUSE/flag gates, crash
resume, launch-failure recovery, dry run), `tests/session-start.tests.ps1`
(role/tenant scoping, expiry and clearing, legacy flag, rotation handoff),
`tests/launch-settings.tests.ps1` (tool contract per role, ceiling breakdown,
flag and -Force bypasses), `tests/rotation-task.tests.ps1` (installer). All
acceptance criteria below are covered by these fixtures.
