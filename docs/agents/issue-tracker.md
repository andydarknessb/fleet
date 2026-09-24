# Issue tracker: GitHub

Issues and specs for the fleet itself live as GitHub issues on `andydarknessb/fleet`. (Tenants keep their own trackers; this file is only about work on the fleet.) Use the `gh` CLI for all operations; run inside `C:\Users\Cory\fleet` or a fleet worktree, or pass `-R andydarknessb/fleet`.

Ruled 2026-09-24: this replaced the earlier `.scratch/` markdown tracker. Fleet tickets had been filed on GitHub in practice for weeks, and `bin/second-read.js` files its weekly `second-read` issue there (#132). Existing `.scratch/` notes stay where they are as history; file new work as issues.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>`. Write long bodies with a file, not a heredoc.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,labels` with `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body-file <file>`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`
- **Specs and their tickets**: a spec is an issue; its tickets are linked as native sub-issues, with native blocked-by edges between them (see Wayfinding below for the API calls).
- Labels in use: `enhancement`, `bug`, `documentation`, `second-read` (weekly reviewer audit, filed by `bin/second-read.js`), plus the triage roles in `triage-labels.md`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `andydarknessb/fleet`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments -R andydarknessb/fleet`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving session's login.
- **Blocking**: native issue dependencies: `gh api --method POST repos/andydarknessb/fleet/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is `gh api repos/andydarknessb/fleet/issues/<n> --jq .id`. A ticket is unblocked when every blocker is closed.
- **Frontier**: the map's open children with no open blocker and no assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` before any work.
- **Resolve**: `gh issue comment <n>` with the answer, `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
