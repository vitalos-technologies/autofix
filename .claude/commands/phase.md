---
description: Execute one build phase from docs/autofix/BUILD-PLAN.md using the lane subagents in parallel, then run its gate.
argument-hint: "<phase number 1-4>"
---

Run Phase $ARGUMENTS of `docs/autofix/BUILD-PLAN.md`.

1. Read `CLAUDE.md`, `docs/autofix/SPEC.md`, `docs/autofix/DECISIONS.md` and the Phase $ARGUMENTS table. List the open tasks with their lane and any dependency between them (e.g. migrations before routes before UI).
2. Check prerequisites: the previous phase's gate is ticked; anything this phase needs from "Waiting on Temitope" is either done or can be mocked. If a task truly can't proceed, mark it blocked in BUILD-PLAN.md and carry on with the rest.
3. Dispatch tasks to the lane subagents (`data-agent`, `api-agent`, `ui-agent`, `integrations-agent`, `qa-agent`). Run independent lanes in parallel; give each subagent its task IDs, the files to read, and the "done when" criteria verbatim. Each task: branch `phase-$ARGUMENTS/<task-id>-<slug>`, tests, `pnpm verify`, commit, merge to `main` when green.
4. After each task merges, tick it in BUILD-PLAN.md with the commit hash.
5. When all tasks are ticked, run `/gate $ARGUMENTS`.
6. Report in this shape: Done (task IDs + commits) / Needs approval (items added to DECISIONS.md) / Blockers.
