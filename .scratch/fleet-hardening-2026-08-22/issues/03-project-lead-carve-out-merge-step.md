# Carve-out PRs containing DDL or row-deleting SQL are merged from Cory's own session, and the role files must say so

Status: ready-for-agent
Blocked by: none

## Problem

`agents/project-lead.md`'s Merge step reads as if the project lead merges every approved PR. On 2026-08-22 both pl-endzone and Cory's own session were refused `gh pr merge 150` by the auto-mode classifier; the diff carried `ALTER TABLE` / `ADD CONSTRAINT` / `DROP CONSTRAINT` in a migration and `DELETE FROM` in a disposable-database test. PRs #136 and #137 (carve-outs with an `UPDATE` backfill and no DDL) merged fine from the project lead's session. The fleet's carve-out flow therefore ends at "Cory merges by hand" for this class, and nothing in the role files says so, so the lead retries, escalates, and the IC idles.

## Ruling (Cory, 2026-08-22, amended same day)

A PR whose diff contains schema DDL or row-deleting SQL is reviewed by the project lead exactly as any other, then held for Cory. Cory's own Endzone sessions carry a `permissions.allow` rule for `gh pr merge` (in `.claude/settings.local.json`, untracked), so the merge is executed by Cory's session on Cory's instruction; fleet sessions stay classifier-bound and never retry, try another strategy, or use the web UI. The fleet glossary term for this state is **Hold** (CONTEXT.md).

## Acceptance criteria

- [ ] `agents/project-lead.md` Merge step: after the existing conditions, one paragraph saying that a PR whose diff contains `CREATE|ALTER|DROP TABLE`, `ADD|DROP CONSTRAINT`, `DELETE FROM` or `TRUNCATE` is held for Cory after review: post one comment "Reviewed clean; on hold for Cory's merge (DDL/DELETE in diff)", add it under `prs` in `state/skip/<tenant>.json` with that reason, message the dispatcher once, and stop. No retry, no alternate merge path.
- [ ] `README.md`'s carve-out paragraph states the same rule and points at `01-sentinel-idle-ic-respawn.md` as what keeps the waiting IC from being respawned.
- [ ] `agents/ic.md` tells an IC whose PR is held this way to stop cleanly and wait; the lead retires it once Cory merges.
- [ ] No change to `fleet-settings.json` or to the classifier: the rule documents the behavior, it loosens nothing.
