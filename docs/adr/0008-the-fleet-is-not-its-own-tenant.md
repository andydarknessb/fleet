---
status: accepted
---

# The fleet is not its own tenant

The fleet does not run itself as a tenant. There is no `tenants/fleet.json`,
no project lead for this repository, and no IC is ever launched against it.
A change to the control plane (`bin/`, `hooks/`, `agents/`, `config/`,
`tenants/`) is made by Cory, from his own session or by hand, on a branch off
`master` that he merges; the dispatcher may file the ticket and relay the
ruling, and nothing else.

The reason is that the control plane runs live from this checkout. Every
role's session, the watchdog's scheduled task and the daemon execute `bin/*.js`
and the hooks straight from the working tree; there is no build, no
`package.json`, no CI workflow and no deploy step between a merge into
`master` and the next tick executing what was merged. A fleet-on-fleet IC
would therefore be modifying the supervisor that launches it, the ledger
(`work-state.js`) that every role writes, and the launch door its own next
turn passes through, with the only gate being a lead reading the diff. One
bad `work-state.js` merge stops every tenant at once, and the mechanism that
would notice (the watchdog) runs the same code. That is a different risk
class from a tenant repository, where a bad merge breaks one product behind
its own CI, and it is not one the fleet's review policy was designed to
carry.

Decided 2026-09-10 on fleet#2 (the `review-policy.js classify` fail-open),
when pl-endzone found it had no mechanism to assign a fleet ticket and asked
for one. The alternative was to create `tenants/fleet.json` and let the
planner treat this repository like any other; it was rejected for the reason
above, not for lack of a tenant config, so adding the config later does not
by itself reopen this decision. What would reopen it: a build step and a CI
gate between `master` and the running tree (a checked-out release ref the
roles execute, distinct from the branch ICs merge into), so that a merge is
not an execution. Until then, fleet tickets go to Cory.

## Consequences

- A fleet ticket that a lead cannot assign is escalated as "needs Cory",
  not held as a planner defect. The dispatcher files it here and relays the
  ruling; it does not wait for a tenant that will not exist.
- `parseArgs` in `bin/work-state.js` takes an optional flag schema (fleet#2).
  Adoption is one binary per change, by Cory, `assignment.js` first because
  it shares the confusable flag names; a binary without a schema is unchanged.
  A big-bang schema across all fifteen binaries under a live fleet was
  rejected as the wrong blast radius.
- The interim rule for `classify` (never read a result whose `files` is empty
  or `changedLines` is null) lapses once this fix is on `master`; a refused
  invocation now exits 2 with no answer on stdout.
