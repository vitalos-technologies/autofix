@AGENTS.md

# Pitline — project guide for Claude Code

Pitline (formerly Autofix; internal names such as `AUTOFIX_*`, `x-autofix-*` and `docs/autofix/` keep the old name, DECISIONS D22) is Vitalos's multi-tenant garage booking platform. Garages get a phone-first booking page on their own domain (`book.theirgarage.co.uk`, free fallback `<slug>.pitline.co.uk`) and manage bookings, customers and reminders at `pitline.co.uk`. The code is a fork of SOB Autofix (single garage, sobautofix.com). Repo: https://github.com/vitalos-technologies/pitline (private).

## Read before you build

| File | What |
| --- | --- |
| `docs/autofix/SPEC.md` | Backend engine spec: tenancy, data model, scheduling, vehicle/MOT, reminders, AI front desk, API, security |
| `docs/autofix/BUILD-PLAN.md` | Phases, tasks, lanes, gates. Tick tasks here as you finish them |
| `docs/autofix/DECISIONS.md` | Decisions, assumptions, and the "Waiting on Temitope" list |
| `docs/autofix/INFRA.md` | DNS, Vercel, Supabase, env vars |
| `design/DESIGN.md` | Design system, components, screen-to-route map |
| `design/screenshots/*.png` | What each screen must look like (2x). Look at these before UI work |
| `design/screens/*.dc.html` | Exact markup and inline styles per screen (`{{accent}}` = garage colour) |
| `docs/SOB_Autofix_Full_Codex_Architecture.md` | SOB's original spec. Context only; SOB-specific rules (no MOT, no tyres, Doncaster SEO) do NOT apply here |

## Stack and commands

Node 22, pnpm 10.12.1, Next.js 16 (App Router, read `node_modules/next/dist/docs/` before using an API), React 19, Tailwind 4, Supabase (Postgres, Auth, Storage), zod, react-hook-form, Resend, Sentry, Vitest, Playwright.

```bash
pnpm install
pnpm dev                 # http://localhost:3000 (admin); booking site: http://hartley-road.localhost:3000
pnpm verify              # lint + typecheck + test + build. Must pass before every commit
pnpm test:e2e            # Playwright
pnpm test:lighthouse
supabase start           # local DB; then supabase db reset && pnpm db:seed
```

## Rules that must never break

1. **Tenancy**: every tenant table has `garage_id uuid not null` and RLS. The garage comes from the request host (public) or the signed-in member's selected garage (admin), never from a request body or query string. Every new table is covered by `tests/integration/tenancy.test.ts`.
2. **No double bookings**: bookings go through `create_booking()`; the `no_overlap` exclusion constraint is the last line of defence. Don't bypass it.
3. **Registration privacy** (from SOB): registrations never go in URLs, analytics or ordinary logs. Booking state between steps lives in a signed httpOnly cookie.
4. **Secrets**: only in `.env.local` (gitignored) or Vercel env vars. Never `NEXT_PUBLIC_` for secrets. Never print secret values.
5. **Messaging consent**: no reminder or marketing message without stored consent; honour STOP immediately; quiet hours 09:00–19:00 Mon–Sat in the garage's time zone.
6. **MOT is per garage**: show MOT data and services only when `garages.mot_enabled`. SOB's MOT ban and its content-guard test are removed in P1.2.
7. **Design**: build from `design/`. Phone first (390px), 44px touch targets, real buttons/labels, contrast 4.5:1, `lucide-react` icons, no emoji.
8. **Times**: store `timestamptz`; compute slots in the garage's time zone (`Europe/London`), test the clock-change days.

## Stop and ask Temitope (add to DECISIONS.md "Waiting on Temitope")

Spending money or entering payment details; DNS or domain changes on vitalos.co.uk; sending messages or emails to real people outside Vitalos; publishing public content; deleting data or cloud resources; billing or account-security settings. For logins, 2FA or CAPTCHA, tell him exactly what to do and wait.

## How to work

- Use the lanes in `.claude/agents/` (data, api, ui, integrations, qa) and the commands `/phase <n>`, `/gate <n>`, `/status`.
- Tests first for engine code. Small commits on `phase-<n>/<task-id>-<slug>` branches.
- Commit message trailer:
  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```
- After each task: tick it in BUILD-PLAN.md with the commit hash. After each phase: run `/gate <n>` and report Done / Needs approval / Blockers.
