---
status: accepted
---

# Pages leave the host, and a dead-man switch watches the Watchdog

A Page is one off-host push to Cory's phone. Every source that needs Cory, a
decision event through the Notifier or a Watchdog condition, goes through one
delivery function to one push service (Pushover), with a priority per kind:
emergency for a dead fleet and for dead-man silence, high for a permission
wait, a launch-retry trip, a merge without a recorded review and a diverged
release branch, normal for a Ruling or a Hold that is waiting. A respawn the
fleet healed by itself and a wake of a session are logged and never paged.
Off the host, a dead-man service receives a ping from the Watchdog on every
tick and pages Cory when the pings stop. The host stays awake on AC power.

The fleet is dead only when every static heartbeat is stale and work is
waiting: the frontier is non-empty with a free slot, a Work record sits in a
state the fleet owns, or a wake is unconsumed. Records waiting on Cory (`hold`,
`escalated`) are decisions, not work, and stale sessions with nothing waiting
are idle.

The audit of 2026-09-10 to 09-17 is the reason. The Watchdog recorded
`fleet-dead` on 128 of 690 ticks because a session with nothing to do takes no
turns, so its heartbeat goes stale; 25 pages went out that week, every one a
toast on a desktop nobody was sitting at, and the one that mattered (all three
standing sessions `blocked` for thirteen hours on 09-13/14, the same class as
the 22.5 hours on 09-05/06) looked like the other twenty-four. The webhook
that did exist carried only frontier and triage wakes, the two least urgent
kinds. The Watchdog itself missed about 45 ticks while the host slept, and
nothing on the host can report that the host is asleep. Two unreviewed merges
on 09-12 were detected by the watcher and delivered to nobody.

Alternatives rejected. A Slack or Discord webhook needs no code but cannot
tell "rule on this when you can" from "the fleet is dead at two in the
morning". The public ntfy server was rejected because the topic name is the
only secret and the messages name private issues. For the dead-man, ADR 0003
named "a cloud Routine that pages Cory when heartbeats go stale"; a
purpose-built dead-man service does the same job with no tokens, no model in
the loop, and only a ping leaving the host, so this ADR amends that sentence
of ADR 0003 and leaves its decision (recovery waits for login, no auto-login)
standing. Waking the host on demand from the Watchdog was rejected for a plain
never-sleep power plan: simpler, and the dead-man covers what is left.

## Consequences

- A page never repeats, with two exceptions: a dead fleet that self-healing
  could not revive pages once more at emergency priority two hours on, and
  one daily summary lists the decisions still waiting on Cory with their ages,
  sourced from the Digest.
- The Notifier's message keeps being a typed pointer and gains the one-line
  question and a link to where Cory rules. It still never copies criteria or
  findings.
- Self-healing comes first and paging second. A `blocked` session with a
  heartbeat stale for more than sixty minutes, no permission prompt pending
  and work waiting is healed by role: a
  control-plane session by a Rotation with a wake reason (it reconstructs from
  canonical state, ADR 0005), an IC by `claude respawn` with the pid verified
  and a cap of two attempts. Only then is the fleet dead. Rotation's boundary
  check learns the same "no permission prompt pending" condition.
- A date in config or on a Notice that has passed raises one normal page, and
  a dated ruling is written so the code reads the date and arms itself.
- The Dispatcher's last unique job, relaying escalations to Cory, ends when
  pages have been delivered for a week; ADR 0005 already rules that the
  standing session retires, and the Reporting line is rewritten then, not now.
- The Pushover token and the dead-man URL live under `state/`, never in the
  repository.
