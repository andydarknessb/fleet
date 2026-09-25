---
status: accepted
---

# The fleet acts under its own login

The fleet acts on GitHub as a machine user, a second GitHub account that
exists only for it. Every session the fleet launches and the Watchdog's
scheduled task push, open pull requests, post the `fleet-review` status,
comment and merge as that account. Cory's own terminal keeps acting as
`andydarknessb`. The tenant files record the split: `ownerLogin` stays Cory,
and `fleetIdentity` becomes the machine user (fleet #154).

Until now both fields named `andydarknessb`. Three things followed. Approval
("only the tenant owner's login approves", ADR 0011) rested on a hook
refusing the word to fleet roles rather than on who wrote it. `mergedBy`
could not say who merged, so the two unreviewed merges of 2026-09-12 cannot
be attributed. And the planner's foreign-assignee rule and the triage
"owner has the newest comment" rule were inert or removed (fleet #55),
because a fleet comment and an owner comment were the same login. The audit
of 2026-09-17 chose a machine user after workstream 3, with its own ADR
(spec fleet #93). This is that ADR.

## Rights boundary

The machine user is a collaborator with write permission on three
repositories: `andydarknessb/Endzone-Empire`, `andydarknessb/Nidus` and
`andydarknessb/fleet`. It is not an admin on any of them, and it is not a
bypass actor on any ruleset. It can push branches, open pull requests,
post commit statuses, comment, label, and merge into a tenant's default
branch once that branch's ruleset is satisfied. It cannot merge into
`main`: nothing merges there except a release pull request, by Cory
(workstream 2), and the release ruleset is what enforces it, not this ADR.

ADR 0011's amendment stands. `ownerLogin` and the `Approved` guard in
`hooks/principal-guard.ps1` do not change; only `fleetIdentity` does. With
two logins the guard becomes a second lock rather than the only one.

## Token

A classic personal access token on the machine user, with the scopes
`repo`, `workflow` and `read:org`. `repo` covers pushing, pull requests,
statuses, comments and merges on private repositories. `workflow` is needed
because the Watchdog fast-forwards the fleet's `live` branch and a push that
carries a change to `.github/workflows/` is refused without it. `read:org`
is the minimum `gh auth login` accepts. A fine-grained token cannot be used:
it only reaches repositories its own account or an organization owns, and
these three belong to Cory's personal account. The token expires after one
year; rotating it is re-running the wizard.

## Where the token lives

`%USERPROFILE%\.fleet-identity\gh\` is a gh config directory, outside the
repo and outside `state/`. `bin/wizard-fleet-identity.sh` writes it with
`gh auth login --with-token --insecure-storage`, so the token sits in that
directory's `hosts.yml` and never in the Windows credential store Cory's
login uses. `FLEET_IDENTITY_DIR` overrides the path (tests use it). The
directory's ACL is Cory's user account, the same account the scheduled
tasks run as, so `launch.ps1` and the Watchdog both read it.

## How a session acts as the fleet

`bin/identity.js` is the one reader of that directory. `launch.ps1` puts its
answer into the session's settings `env` block, which the session, every
Bash call, every hook and every one of the thirteen binaries that shell out
to `gh` inherit. `watchdog.ps1` sets the same variables in its own process
at the top of each tick. The variables are:

- `GH_CONFIG_DIR`, so `gh` reads the fleet's `hosts.yml`.
- `GIT_CONFIG_SYSTEM`, naming `gitconfig` in the same directory. That file
  includes the machine's real system gitconfig and then resets git's
  credential helper list to `gh auth git-credential` alone, so an https
  push from a fleet worktree authenticates with the fleet token and not
  with the credential manager's stored login. The reset lives in a file
  because Windows drops an environment variable whose value is empty, and
  git's reset is an empty value.
- `GH_PROMPT_DISABLED` and `GIT_TERMINAL_PROMPT`, so a missing credential
  fails instead of waiting for an answer nobody will give.

No token is ever written to `state/`, and no binary names a token or a
login. The user's global gitconfig is untouched.

## Commit authorship

Ruled by Cory on 2026-09-25 (fleet #152): Cory stays the git author of
fleet commits, with the existing `Co-Authored-By` trailer. The machine user
is the pusher, pull-request opener, status poster and merger, never the
commit author. No worktree sets `user.name` or `user.email`.

## Rollout and failure

The directory can exist before the tenant files change. While every tenant
still names `andydarknessb` as `fleetIdentity`, a launch without the
directory keeps the keyring login, which is then the fleet identity; a
launch with it already acts as the machine user, and the premise check
`fleet-identity-matches-session` reports `expected-until-154`. Once any
tenant names a `fleetIdentity` distinct from its `ownerLogin`, the directory
is required. A launch without it refuses with `FLEET_IDENTITY_MISSING`, and a
launch whose directory names another login refuses with
`FLEET_IDENTITY_MISMATCH`. Either refusal writes no session, releases a
manifest's reservation, and pages once at high priority. There is no
fallback to the keyring login. The Watchdog pages the same refusal once and
keeps supervising under the task's own login, because a tick that stopped
supervising over an identity fault would hide every other fault.

## Consequences

Approval, the foreign-assignee rule and the owner-comment rule can rest on
authorship again (fleet #154). Merges and review statuses name the login
that acted (fleet #155). The wizard checks what it can with the stored
token: the login, write-not-admin on each repository, and no ruleset bypass
for the account. Accepting the collaborator invitations is done with the
machine user's own token by the wizard; creating the account and minting
the token are the two steps only Cory can do in a browser.

A second account is a second thing to keep alive. If the token expires the
fleet stops launching, loudly, and the fix is the wizard's token stage.
