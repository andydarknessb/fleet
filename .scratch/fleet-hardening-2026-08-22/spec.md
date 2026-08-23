# Fleet hardening, 2026-08-22

Status: tickets ready

Four infrastructure defects surfaced on the pilot's first day, each found only because someone tripped over it. The tickets under `issues/` close the three that remain open in this repo (the stop-hook quoting bug was fixed in 2302f58). Each ticket is self-contained; work them in number order, none blocks another.

An agent working one of these runs in `C:\Users\Cory\fleet` (not a tenant repo), edits this repo directly, and stops for Cory's review before anything is committed: role files, `fleet-settings.json`, `launch.ps1` and `bin/*` are Cory's, so the deliverable is a reviewed diff plus the ticket's `## Answer`, not a merge.
