---
description: Summarise where the Autofix build is — phase, ticked tasks, failing checks, and what is waiting on Temitope.
---

Read `docs/autofix/BUILD-PLAN.md` and `docs/autofix/DECISIONS.md`, run `git log --oneline -15` and `git status`, and reply with:

- Current phase and % of tasks ticked per phase.
- Last 5 commits.
- Anything failing (`pnpm verify` result if run in the last commit's CI, else run `pnpm typecheck` quickly).
- "Waiting on Temitope" items still open.
- The next 3 tasks to run.

Keep it under 15 lines.
