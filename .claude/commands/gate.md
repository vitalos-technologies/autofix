---
description: Check a phase gate and the definition of done. Read-only except for ticking the gate in BUILD-PLAN.md.
argument-hint: "<phase number 1-4>"
---

Check Gate $ARGUMENTS from `docs/autofix/BUILD-PLAN.md`.

1. Run `pnpm verify`.
2. Run the gate's test(s):
   - Gate 1: tenancy suite (`tests/integration/tenancy.test.ts`).
   - Gate 2: `tests/integration/booking-concurrency.test.ts` + Playwright booking journey at 390px with axe.
   - Gate 3: `tests/integration/reminder-attribution.test.ts` + admin Playwright journeys.
   - Gate 4: Lighthouse on booking routes, full Playwright suite, and the `docs/autofix/LAUNCH.md` checklist (items needing Temitope are listed, not done).
3. Check the definition of done at the bottom of BUILD-PLAN.md for every task in the phase.
4. Output a table: check · command · result · evidence. Tick the gate only if every check passes. Never weaken or skip a test to pass a gate.
