---
description: Run the whole Autofix build, Phases 1 to 4, back to back without stopping between phases. Reports only at the end or when truly blocked.
argument-hint: "[start phase, default: first phase with open tasks]"
---

Build Autofix end to end from `docs/autofix/BUILD-PLAN.md`. Start at Phase $ARGUMENTS if given, otherwise at the first phase that still has open tasks (run `/bootstrap` first if `src/` does not exist).

Loop over the phases in order. For each phase:

1. Do everything `/phase <n>` describes: plan the tasks, dispatch them to the lane subagents in parallel where independent, tests first for engine code, `pnpm verify`, commit, merge, tick tasks with commit hashes.
2. Run `/gate <n>`.
3. If the gate passes, **go straight on to the next phase**. Do not stop, summarise or wait for confirmation between phases.
4. If the gate fails, fix the cause and re-run the gate, up to 3 attempts. Never weaken or skip a test to pass. If it still fails, mark the failing checks as blocked in BUILD-PLAN.md with the evidence and carry on with every task in later phases that doesn't depend on them.
5. Anything that needs Temitope (money, DNS, accounts, real keys, legal sign-off, a real garage): add it to "Waiting on Temitope" in `docs/autofix/DECISIONS.md`, use mocks or test mode, and keep going. Phase 4's gate ("first garage live") can't fully pass without him: prepare everything, finish the `docs/autofix/LAUNCH.md` checklist and treat the remaining items as waiting on him.

Keeping a long run healthy:

- After each phase, commit and push, then update a short "Build log" section at the top of BUILD-PLAN.md (phase, gate result, date, last commit) so progress survives context compaction or a session restart.
- If the context gets heavy, `/compact` with "keep the build log, open tasks and current phase" and continue.
- If the session restarts, re-read the build log and resume from the first open task.

Stop only when all 4 phases are done, or when nothing more can be done without Temitope. Then report once: Done (phases, gates, key commits) / Needs approval (the "Waiting on Temitope" list) / Blockers.
