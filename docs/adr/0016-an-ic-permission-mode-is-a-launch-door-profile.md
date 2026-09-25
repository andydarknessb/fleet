---
status: accepted
---

# An IC's permission mode is a launch-door profile

An IC's permission mode is a profile the launch door chooses per model. It
is not whatever the Claude Code CLI's auto-mode list happens to admit. There
are two profiles. **auto** is `fleet-settings.json` as written: permission
mode auto with the classifier and its `soft_deny` lines. It is the sonnet
profile. **allowlist** is permission mode `acceptEdits` plus the checked-in
`config/permissions-allowlist.json`: an explicit `permissions.allow` list, the
fleet root as an additional directory, and a deny list. It is the haiku
profile. The planner pins the profile in the manifest beside the model
(`assignment.js assign --model haiku --permissions allowlist`), and
`launch.ps1 -Manifest` writes it into the session's settings. The mode is
never passed as `--permission-mode` on the command line.

The deny contract is common to every profile. The tool-contract rules
`launch.ps1` injects for every IC (no Edit, Write or NotebookEdit under fleet
state) are written for both profiles, and deny beats allow, so no profile can
widen them.

## Context

Amendment 14 (2026-09-09) made an IC haiku or sonnet. Fleet #28 (2026-09-11)
found that the CLI keeps a per-model auto-mode list and `claude-haiku-4-5` is
not on it. A haiku `--bg` session asked for auto runs in permission mode
`default` and blocks on its first out-of-cwd Read with nobody to approve it.
The haiku tier was suspended on sonnet. That was re-verified on CLI 2.1.282
on 2026-09-25 by a live probe; a static read of the binary's model predicate
said otherwise and was wrong.

Spec #94 (audit workstream 7) goes around the list instead of waiting for it.
A mode that needs no classifier, with the IC role's needs written down as
rules, does not depend on which models the CLI admits to auto.

## Decisions

- **Haiku runs only under allowlist.** `assign --model haiku` without
  `--permissions allowlist`, or with `--permissions auto`, is refused with the
  fleet #28 code and message (`INVALID_IC_MODEL`), at the planner and again at
  the launch door. Reopening the old failure takes more than omitting a flag.
- **Sonnet is untouched.** A sonnet manifest pins `permissions: "auto"`. The
  allowlist profile on sonnet, or on any control-plane role, is refused: a
  lead or principal never trades its classifier for a fixed list.
- **One file, one line per need.** Every allow rule carries a note naming the
  `agents/ic.md` step that needs it. A permission wait in a rehearsal is a
  missing line, and the fix is that line.
- **The profile's deny list stands in for the classifier.** `acceptEdits`
  never consults `autoMode.soft_deny`, and the additional directory makes the
  fleet root editable. So the profile denies Edit, Write and NotebookEdit
  across the fleet root, force pushes, pushes to the tenant's default and
  release branches, `git stash`, `git worktree remove`, `gh pr merge` and the
  `claude` CLI. These are prefix rules. A flag placed after the refspec
  (`git push origin x --force`) is not caught; the review gate and the
  branch rulesets remain the backstop, as they are under auto.
- **Tokens, not paths.** Rules name `<fleet>`, `<defaultBranch>` and
  `<releaseBranch>`, which the launch resolves from the root it runs from and
  the tenant file. A scratch root (spec #94's second ticket) therefore gets
  rules for itself, not for the live fleet. A token the launch cannot resolve
  refuses the launch.

## Open premise

The IC role file declares `permissionMode: auto` in its frontmatter. Whether
the CLI lets that override the settings' `defaultMode: acceptEdits` for a
top-level `--agent ic` session is not established. The rehearsal (spec #94's
third ticket) observes the mode the session actually ran in. If the
frontmatter wins, the fix is to drop the field from `agents/ic.md` and let
the settings carry the mode for both profiles.

## Consequences

- The haiku tier can be tested without a CLI change. Whether it reopens is
  the rehearsal's verdict and the fourth ticket's decision, not this ADR's.
- `launch.ps1 -DryRun` reports the profile name and the allow rule count, and
  the live roster row records the profile.
- A manifest written before this ADR has no `permissions` field and launches
  under auto, as it always did.

## Amendment: the tier reopens on the rehearsed CLI (#165)

Rehearsal (#164): PENDING. Fill in the date, the `claude --version` and the
verdict line from `.scratch/haiku-rehearsal-<date>/` before this amendment
merges. A not-clean verdict means this amendment does not merge at all.

- The haiku tier is open again for the ticket types the project-lead role
  file already names (copy changes, single-file fixes, test flakes, verbatim
  moves, exact-file tickets), and only under the allowlist profile.
- `config/permissions-allowlist.json` records `verifiedCliVersion`, the CLI
  the rehearsal passed on. `launch.ps1` refuses a haiku launch on any other
  `claude --version`, dry runs included, naming both versions and the
  rehearsal command. Sonnet launches never read the field.
- The re-test on a CLI update is the rehearsal again: `bin/scratch-root.ps1`
  clears the field in its copy, so the scratch launch runs on the new CLI. A
  clean verdict bumps the field; that is the whole re-test.
- `budgets.icJobTokensTargets.haiku` in `config/cycle.json` stays null. One
  rehearsal unit is not a median; the target is set from the weekly
  scorecards once haiku units accumulate (fleet #139's method).
