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

## Amendment 1 (2026-09-28, fleet #171): the tenant repo, the PR body file, one command per call

The rehearsal (#164, CLI 2.1.283, report in `.scratch/haiku-rehearsal-2026-09-26/`)
was not clean. It stopped on four permission waits, and it settled the open
premise: the settings' `acceptEdits` was in effect, so `permissionMode: auto` in
the `agents/ic.md` frontmatter does not override it.

- **`<repo>` is a token.** It resolves to the tenant file's `repo`, the main
  checkout. The profile allows `Read(<repo>/**)` and lists `<repo>` as an
  additional directory, because a haiku IC reads the issue's paths in the main
  checkout rather than its worktree, and a prefix rule such as `Bash(ls:*)`
  does not cover a path outside the allowed directories.
- **The main checkout stays unwritable.** An additional directory is editable
  under `acceptEdits`, and a deny list cannot say "everything but
  `.claude/worktrees`". So the profile's `repoDeny` names the tools and the
  kept path, and `launch.ps1` generates one deny rule per tool for every entry
  of the checkout beside each segment of that path. An entry created after the
  launch is not covered. A launch whose tenant repo does not exist is refused
  rather than written with no denies.
- **The PR body file is `.fleet-pr-body.md` in the worktree root**, written with
  the Write tool (`ic.md` step 6) instead of a heredoc into a temp directory
  outside the allowed directories. The launch adds it to the repo's
  `info/exclude` so it is never committed.
- **One command per Bash call** under this profile (`ic.md` Boundaries). A
  compound with `2>/dev/null` and `||` prompted although every command in it
  was allowed. No rule was probed to cover it; the role file rule avoids it.
- Every `additionalDirectories` entry is now `{ dir, for }`, like a rule.

Verification is the next rehearsal, a re-run of #164's procedure against this
profile. The fourth ticket's reopen and its `verifiedCliVersion` wait on its
verdict.

## Amendment 2 (2026-09-28, fleet #181): refuse, never prompt

The second rehearsal (Endzone #1730, PR #1734) cleared every wait Amendment 1
covered. It stopped once, on `gh issue view ... | python3 -c ... | head`, and it
skipped `ic.md` step 5. Its transcript corrected Amendment 1 on compound Bash.
Pipes, `&&`, `;` and `2>&1` between allowed commands ran with no prompt. What
prompts is a command the allow list does not cover, or a redirect to a path
outside the allowed directories.

- **Refuse, never prompt.** Under `acceptEdits` a call outside the allow list
  becomes a prompt, and a background IC has nobody there to answer it.
  `hooks/allowlist-gate.js` (PreToolUse, Bash and PowerShell) runs only for
  sessions launched with `FLEET_PERMISSIONS=allowlist`. It refuses such a call
  with a reason that names the allowed commands:
  - a command no `Bash(...)` rule of the session's resolved allow list covers,
    unless it is a listed read-only command;
  - a redirect to a file outside the working directory and the additional
    directories;
  - a drive or `/tmp` path argument outside them;
  - command substitution outside quotes;
  - any PowerShell call.

  The IC reads the reason and rewrites the call. The gate fails open and has a
  rollback flag, `state/flags/allowlist-gate-off`.
- **The role file states the real rule.** It is per command, not "one command per
  call". The gate enforces it, so a haiku IC that ignores the prose still meets it.
- **Step 5 is mechanical.** `pr-ready-check.js` classifies the diff with the
  tenant's risk triggers. When the classification reports `riskReview` and the
  Work record has no risk review at the head, it reports a `risk-review` DEFECT.
  A PR the IC opens without its risk review therefore fails its own pre-ready check.

Verification is the next rehearsal, a re-run of #164's procedure.

## Amendment 3 (2026-09-29, fleet #165): the tier reopens on the rehearsed CLI

Rehearsal (#164): 2026-09-29, Claude Code 2.1.284, Endzone #1773 -> PR #1801,
report in `.scratch/haiku-rehearsal-2026-09-29/`. **Clean.** There were zero
permission waits. Off-list calls came back as refusals from the Amendment 2
gate, and the IC rewrote them. The Amendment 2 `risk-review` DEFECT made the
IC run step 5. The PR went through the review gate (formal-001, docs nits
only, no send-back). Job tokens: 61,218, against a haiku median of 37,724 and
a sonnet median of 133,209.

- The haiku tier is open again for the ticket types the project-lead role
  file already names (copy changes, single-file fixes, test flakes, verbatim
  moves, exact-file tickets), and only under the allowlist profile.
- `config/permissions-allowlist.json` records `verifiedCliVersion`, the CLI
  the rehearsal passed on (2.1.284); it is null until a rehearsal passes.
  `launch.ps1` refuses a haiku launch while it is null and on any other
  `claude --version`, dry runs included, naming both versions and the
  rehearsal command. Sonnet launches never read the field.
- The re-test on a CLI update is the rehearsal again: `bin/scratch-root.ps1`
  marks its copy `rehearsalRoot: true`, the one place the guard stands aside,
  so the scratch launch runs on the new CLI. A clean verdict bumps the field;
  that is the whole re-test. Until then every haiku launch on the new CLI is
  refused, and the ticket launches on sonnet.
- `budgets.icJobTokensTargets.haiku` in `config/cycle.json` stays null. One
  rehearsal unit is not a median; the target is set from the weekly
  scorecards once haiku units accumulate (fleet #139's method).

## Amendment 4 (2026-10-26, owner ruling): the deepseek tier

Cory ruled, 2026-10-26, that the IC's default model is DeepSeek V4.1 Flash
(ADR 0017's amendment of the same date). Claude Code's auto mode covers Claude
models only, so a deepseek `--bg` session under auto would run in default mode
and block on its first out-of-cwd Read, fleet #28's failure.

- `deepseek` is the second allowlist-profile model. `assign` refuses it
  without `--permissions allowlist`, and `launch.ps1` refuses the pair at the
  door, dry runs included.
- The session reaches DeepSeek's Anthropic-format API through
  `ANTHROPIC_BASE_URL` in its settings env (`config/deepseek.json` `baseUrl`),
  on the model id `_common.ps1` pins (`deepseek-flash`). The key never enters
  the settings: the session's `apiKeyHelper`, `bin/deepseek-key.js`, reads it
  at call time from `keyFile` under `%USERPROFILE%`
  (`.fleet-secrets/deepseek-api-key`), outside the repo and `state/` like the
  fleet identity (ADR 0015). A missing key refuses the launch.
- The tier has its own rehearsal gate, `config/deepseek.json`
  `verifiedCliVersion`, null until a deepseek rehearsal passes
  (`bin/scratch-root.ps1 -Model deepseek`). Amendment 3's rules hold: a null
  field or another CLI refuses, the scratch root stands aside, a clean verdict
  writes the field. That rehearsal also proves what the fleet repo cannot: that
  a `--bg` session takes the settings' base URL and `apiKeyHelper` over Cory's
  login, that DeepSeek accepts the role's `--effort high`, and that the IC's
  workers reach DeepSeek's mapped models.
- `budgets.icJobTokensTargets.deepseek` in `config/cycle.json` is null, and
  `bin/measure-cycle.js` folds every `deepseek-*` id into a `deepseek` family.

## Amendment 5 (2026-10-27, owner ruling): the deepseek tier opens on 2.1.311

Rehearsal: 2026-10-27, Claude Code 2.1.311, Endzone #1440 -> PR #2522, from
a scratch root (`bin/scratch-root.ps1 -Model deepseek`). `assign` refused
`PREMISE_PATH_CHANGED` on three premises; each still held at base `1dd8b0f`
(moved lines only) and the assign re-ran with `--premises-rechecked`.

- The session ran `--model deepseek-flash --effort high` with the profile's
  settings; its own transcript records only `deepseek-flash`. Its researcher
  workers' transcripts name `claude-haiku-5-5`, the id their role file pins,
  but none of their responses carries an Anthropic `msg_` id (an
  Anthropic-served control transcript does), so DeepSeek's endpoint served
  them too, under its model mapping. Every call went to DeepSeek's API through
  the settings' base URL and `apiKeyHelper`, not Cory's login.
- Zero permission waits. The IC acknowledged, sent its lookups through the
  researcher worker, and opened PR #2522 with its tests green.
- #2522 passed its CI, was attested with no open findings (`fleet-review`,
  `state/reviews/endzone_pr-2522/attest-001.json`) and merged the same day,
  closing #1440.
- `config/deepseek.json` records `verifiedCliVersion` 2.1.311. The haiku tier
  stays on 2.1.296, so on this CLI a haiku launch is refused until its own
  rehearsal passes again; sonnet is the lead's fallback meanwhile.

## Amendment 6 (2026-10-27, owner ruling, fleet #332): the deepseek tier runs auto

Amendment 4's premise was wrong. Claude Code's auto mode is not limited to
Claude models: it runs against DeepSeek's endpoint. Cory asked that a deepseek
IC never wait on a permission prompt, and the evidence settles it.
- ic-2536 (endzone #2536, deepseek-flash, allowlist profile, CLI 2.1.311)
  waited 2,635 s (19:55:26Z to 20:39:21Z) on a grep whose pattern held
  backticks (on server/services/homeStatus.service.js).
  `allowlist-gate.js` let it through, so `acceptEdits` prompted with nobody
  there. Cory approved it and switched the session to auto; it had no waits
  after.
- Probe 1 (CLI 2.1.312, `claude -p --model deepseek-flash`, the fleet
  settings plus the deepseek base URL and `apiKeyHelper`): the transcript
  records `permissionMode: auto` from the start, an out-of-cwd Bash and Read
  ran with `permission_denials: []`, and the CLI reports that auto mode keeps
  working for api.deepseek.com.
- Probe 2 (CLI 2.1.312, `claude --bg --model deepseek-flash --effort high`,
  same settings): auto from the first turn. An out-of-cwd Bash, an out-of-cwd
  Read and a `researcher` worker ran with zero waits; the worker's transcript
  has no Anthropic `msg_` id, so DeepSeek served it, as in Amendment 5.

The rules:

- `assign --model deepseek` with no `--permissions` pins `permissions:
  "auto"`; `--permissions allowlist` stays accepted as the rollback. Haiku is
  unchanged: allowlist only. A manifest written before this amendment that pins
  `allowlist` on deepseek launches as written.
- `launch.ps1` no longer refuses deepseek under auto. The base URL and
  `apiKeyHelper` are written whatever the profile.
- The tier gate stays per tier and now covers every deepseek launch, whatever
  the profile: `config/deepseek.json` `verifiedCliVersion` guards the base URL
  and `apiKeyHelper` path, which the profile does not change. Probes 1 and 2
  count as its re-test, so the field moves to 2.1.312; the owner commits it and no code writes it. Haiku stays gated only
  under allowlist.
- Out of scope: the allowlist gate let the backtick grep through. Haiku still
  runs that profile, so that gap gets its own ticket.

## Amendment 7 (2026-10-27, fleet #333): a backtick anywhere is refused

ic-2536 waited 2,635 s on a prompt for ``grep -n "id: \`\|type:" ...``. The gate's
double-quote branch took `` \` `` as an escaped character, so it passed the call
while the CLI prompted on the backtick. `hooks/allowlist-gate.js` now refuses a
backtick anywhere in a Bash call, unquoted, double-quoted, escaped or
single-quoted, with a reason that names the rewrite: match it with `.` in the
pattern, or use the Grep tool. Heredoc bodies are exempt, so a commit message
written through a heredoc keeps its backticks. `$(` keeps its own reason. Only a quoted-delimiter heredoc
body is exempt: bash runs a backtick or `$(` in an unquoted `<<EOF` body, so the
gate refuses that too, and `<<<` is not a heredoc.

## Amendment 8 (2026-10-27, owner ruling, fleet #336): the CLI is frozen and the Watchdog moves it after a deploy

A per-tier CLI pin cannot hold. `claude --bg` sessions run under one per-user
supervisor (`claude.exe daemon run`, `~/.claude/daemon.json`), and after an
update the supervisor restarts itself onto the new version and moves idle
sessions over (code.claude.com/docs/en/agent-view). The job records on this
machine show `cliVersion` values from 2.1.233 to 2.1.312: whichever binary
starts a session, it ends up on the global one.

The rules:

- The global CLI is frozen. `bin/setup.ps1` writes `DISABLE_AUTOUPDATER=1`
  into `~/.claude/settings.json` `env` (merged; the other keys stay) and into
  the Windows user environment. Cory's interactive sessions move with the
  fleet, at most about a day behind, and only onto versions that passed the
  probes. A manual `claude update` still works and is Cory's call.
- `config/cli.json` `{ "version": "<x.y.z>" }` names the CLI the fleet runs. It
  starts at 2.1.312. The owner commits it; no code writes it.
- The Watchdog moves the CLI, as its own step on every tick, right after the
  deploy (a first draft put it inside `bin/deploy-live.ps1`; Opus QA found a
  failed install invisible there, `npm install -g` unbounded inside deploy's
  120 s budget with a kill orphaning npm, and no retry because the next tick
  returns `current` first, so `deploy-live.ps1` carries no CLI step and does
  not load `_common.ps1`). The step runs `bin/install-cli.ps1 -Version
  <config/cli.json version> -Global` (`npm install -g
  @anthropic-ai/claude-code@<v>`) bounded at no more than 300 s
  (`watchdog.cliTimeoutSec` may only lower it); a timeout kills the whole
  process tree, npm included. install-cli is idempotent, so a matching CLI
  costs a file read, and a mismatch retries every tick until it matches. The
  answer lands in `state/watchdog/cli.json`; `{ ok:false }` pages
  `cli-install` (normal) through the Watchdog's paging on the next tick,
  naming the reason, and the next ok clears it. Between a deploy and the end of
  that step the door may refuse a haiku or deepseek launch and the lead falls
  back to sonnet, as it does today; that lasts one tick, once per CLI move.
- `bin/install-cli.ps1 -Version <v>` without `-Global` installs side by side
  under `%USERPROFILE%\.fleet-cli\<v>` with `npm install --prefix`. It is
  idempotent and prints one JSON line `{ ok, version, path }`, where `path` is
  the package's `bin\claude.exe` and passes `Test-ClaudeCliCandidate`. The
  #337 canary probes that copy under `claude -p`, which does not use the
  supervisor.
- `bin/setup.ps1` leaves a `settings.json` that does not parse untouched and
  says so; the user environment is not set in that case either.
- The door (`launch.ps1`'s version gate) does not change.

## Amendment 8 (2026-10-27, owner ruling, fleet #337): a daily canary moves the CLI

Cory asked that CLI updates be automated so nothing gets interrupted. With the
global CLI frozen and `config/cli.json` naming the CLI the fleet runs (#336,
Amendment 7), the probes that Amendments 5 and 6 ran by hand run on a schedule.

- Probes count as the re-test for both tiers (Amendment 6 counted probes 1 and 2
  for deepseek; this extends it to haiku). A full rehearsal
  (`bin/scratch-root.ps1`) runs only after a probe fails.
- `bin/cli-canary.ps1`, registered by `bin/install-cli-canary-task.ps1` (daily,
  03:00; `bin/run-cli-canary.ps1` logs to `state/cli-canary/`), compares
  `npm view @anthropic-ai/claude-code version` with `config/cli.json` `version`.
  When they differ and no open PR or issue covers that version, it installs the
  candidate side by side (`bin/install-cli.ps1 -Version <v>`, no `-Global`) and
  probes every tier under `claude -p` with `FLEET_CLAUDE_CLI` set to it, in a
  scratch cwd. A prompt becomes a denial under `-p`, so a missing allow rule
  fails the probe.
  - deepseek: the deepseek `baseUrl`, `apiKeyHelper` and the auto profile. Passes
    on `permissionMode: auto`, an out-of-cwd Bash and Read with
    `permission_denials: []`, and no Anthropic `msg_` id.
  - haiku: the allowlist profile under `acceptEdits`, running a backtick `grep`,
    `gh pr view`, `node --test` and `git -C <repo> log`. Passes on
    `permissionMode: acceptEdits` and `permission_denials: []`.
- A tier is open when its `verifiedCliVersion` equals `config/cli.json`
  `version`. The PR (branch `fleet/cli-<v>`, temp worktree off `origin/master`)
  opens only when every open tier passes. It sets `config/cli.json` to the
  candidate and bumps `verifiedCliVersion` for every tier that passed, a closed
  tier that passes included. A closed tier that fails stays closed and gets an
  issue. If any open tier fails, nothing moves: an issue carries the probe
  output and the fleet stays on its CLI. An open tier never closes because a new
  CLI shipped.
- The PR body is the attest. Cory merges; the deploy ships `config/cli.json`, and the Watchdog's CLI step on that tick moves the CLI (Amendment 7).
  The canary never merges and never touches the live checkout or `state/`.
- The probe settings are the smallest equivalent of `launch.ps1`'s composition
  (even its `-DryRun` needs a roster, tenant and manifest): fleet-settings.json,
  hooks included, plus the tier profile and the IC env block. The hooks run as
  launch.ps1 writes them (SessionStart, the research and allowlist gates,
  principal-guard, Stop), from the checkout being canaried, with `FLEET_HOME`
  set to the probe's scratch home so the Stop heartbeat and notice reads never
  touch `state/`. No hook is left out. The tool-contract denies and the
  repoDeny rules only deny and are not written.
- A probe passes only on positive evidence: `permission_denials` present and
  empty, a result line with `is_error` false, the expected `permissionMode`, no
  hook error, and the out-of-cwd Bash and Read returned successful tool results
  (deepseek also needs no Anthropic `msg_` id). A timeout, a missing result line
  or a missing field fails the probe.
- Every failure path is loud. Bodies go through `--body-file`; every `gh` and
  `git push` exit is checked, and a failed create exits 2 instead of reporting
  `issue-filed` or `pr-opened`. The PR worktree is detached and pushed as
  `HEAD:refs/heads/fleet/cli-<v>`, so a failed run leaves no local branch.
  `run-cli-canary.ps1` sends a high-priority `Send-FleetPage` on any non-zero
  exit, because a silent canary freezes the fleet on its current CLI.
- The 2.1.312 dry run caught the gap Amendment 6 left out of scope: the haiku
  allowlist profile denies the backtick `grep` under `acceptEdits`, so haiku
  would stay closed on that CLI until the allowlist covers it.
