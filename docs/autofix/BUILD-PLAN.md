# Autofix build plan

## Build log

| Phase | Gate | Date | Last commit | Notes |
| --- | --- | --- | --- | --- |
| 1 | **passed** | 27 Oct 2026 | eb8dfd8 | All P1 tasks ticked; Gate 1 green in CI (run 40429708549: verify, database-tests incl. 1614 tenancy tests, browser-tests, lighthouse) on self-hosted runners `autofix-azure-*` |
| 2 | in progress | 27 Oct 2026 | 48f7b8a | P2.1–P2.8 and P2.10 merged; P2.9 (manage page) and P2.11 (Gate 2) running in this session |
| 3/4 (spun off) | n/a | 27 Oct 2026 | 48f7b8a | Separate cloud sessions, each on its own branch, merged by the lead when done: P4.2 agent tool API → `claude/autofix-p4-2-agent-api` (migration `20261028000100`), P3.11 customers + CSV import → `claude/autofix-p3-11-customers-import` (`20261028000200`), P4.8/P4.9 launch checklist + legal copy → `claude/autofix-p4-8-p4-9-launch-legal` (`20261028000300`). Later migrations (P3.6 reminders) start at `20261028001000` |

14 days, 4 phases, 5 agent lanes. A phase is done only when every task is ticked and its gate passes in CI (`pnpm verify` + the gate test). Run `/phase <n>` in Claude Code to execute a phase and `/gate <n>` to check it.

Lanes: **data** (migrations, RLS, SQL, DB tests) · **api** (route handlers, zod, jobs, webhooks) · **ui** (screens from `design/`) · **integrations** (DVLA, DVSA, VDG, Twilio, Resend, Vercel) · **qa** (Playwright, axe, Lighthouse, tenancy suite). Subagent definitions live in `.claude/agents/`.

Conventions for every task:

- Work on a branch `phase-<n>/<task-id>-<slug>`; one PR (or one squashed commit) per task.
- Tests first for engine code (slots, booking transaction, reminders, tenancy).
- Update this file: tick the box and add the commit hash.
- Anything that needs money, DNS, external messages or account settings: stop and add it to `docs/autofix/DECISIONS.md` under "Waiting on Temitope".

---

## Phase 0 · Bootstrap (done by `/bootstrap`)

- [x] P0.1 Import SOB history into this folder (`git fetch` from `../sobautofix` or GitHub) and check out `main`.
- [x] P0.2 Overlay Autofix files from `.autofix/` (CLAUDE.md, AGENTS.md, README.md) and append `.autofix/env.autofix.example` to `.env.example`.
- [x] P0.3 Rename package to `autofix`; first commit "chore: start Autofix from SOB Autofix".
- [x] P0.4 `pnpm install && pnpm verify` passes on the untouched fork (baseline). Baseline recorded; 2 known failures below, fixed in P1.
  - Baseline 26 Oct 2026 (Node 22.22.0, pnpm 10.12.1 via lockfile, no `.env.local`): `pnpm install` ✅ · `lint` ✅ · `typecheck` ✅ · `test` ❌ 458/459 · `build` ❌.
  - `test`: `src/__tests__/booking-management.test.ts` › "rejects reintroduced legacy scheduling integration" scans `docs/` and flags this file (`docs/autofix/BUILD-PLAN.md`), which names the legacy scheduler. Caused by the kit docs, not SOB code. Fixed in P1.1 (`667ba08`: the scan skips `docs/autofix/`).
  - `build`: prerendering `/sitemap.xml` throws "Sitemap inventory source is not configured" (`src/lib/sales/repository.ts:28`) because Supabase env is unset. Needs env in CI/Vercel or a non-throwing fallback; Fixed in P1.1 (sitemap removed).
- [ ] P0.5 Push to `https://github.com/vitalos-technologies/autofix` (created 25 Oct 2026) and protect `main`.
  - Pushed on branch `claude/bootstrap-kfesal` with a PR to `main`. Open: merge the PR, then protect `main` (require PR + passing CI, matching `vitalos-technologies/workforce`) — needs an org admin.

## Running in Claude Code cloud

After `/bootstrap` has pushed to GitHub, phases run in Claude Code cloud sessions on `vitalos-technologies/autofix`. Cloud VMs may not run Docker, so `supabase start` may be unavailable: tests use the hosted Supabase Free project (London) through `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY` and `SUPABASE_TEST_SERVICE_KEY` set as cloud environment variables. If those aren't set yet, run unit tests and mark DB-backed tests blocked in this file.

## Phase 1 · Fork + tenancy (days 1–3)

Gate 1: **cross-garage tests return zero rows** for every tenant table, for select, insert, update and delete, as anon, as garage A staff and as garage B staff. **Passed 27 Oct 2026**: tenancy suite 1614/1614 (26 tables × 9 callers × select/insert/update/delete/move, structure, storage, integrity) in CI run 40429708549 on `autofix-azure-1`, with pgTAP 304/304 and `pnpm verify` green.

| ID | Lane | Task | Done when |
| --- | --- | --- | --- |
| [x] P1.1 | api | Strip SOB-only surfaces: news/advice/articles, gallery, cars-for-sale (keep code under `src/legacy/` only if reused later; otherwise delete), SOB SEO landing pages (`/diagnostics/*`, `/areas/*`, `/services/*`), tawk.to, GA marketing pages. Keep: booking, manage booking, admin shell, MFA, invoicing, enquiries pipeline, email templates, vehicle lookup, rate limits, Sentry | Build passes; route list in PR description — done `667ba08`, `71844ef` (admin moved to `/app`). Routes after strip: `/` → `/app`, `/app/*` (dashboard, bookings, enquiries, invoices, service-catalogue, notifications, settings, trash, security, login/MFA), `/auth/confirm`, `/_site/[garageId]` (+ `/manage-booking`), `/api/*` (bookings, enquiries, vehicle/lookup, health, client-error, cron/retention, admin invoices/notifications, webhooks) |
| [x] P1.2 | api | Remove the SOB "no MOT" rule: drop MOT filtering in vehicle provider normalisation; delete or rewrite `src/__tests__/content-guard.test.ts` and `test:mot` script; MOT visibility becomes `garages.mot_enabled` | Tests green; MOT fields pass through providers — done `63b5f0a` |
| [x] P1.3 | api | Replace `src/config/site.ts` single-business config with a `GarageContext` loaded per request (`getGarage()` server helper, React context for client components) | No component imports business facts from `site.ts` — done `bd9bdb1`, `ba77265` (merge `6f5195a`). `src/config/site.ts`, `settings.ts`, `invoicing.ts` deleted; admin uses `getAdminContext()` (`src/lib/tenancy/admin.ts`, `af_garage` cookie, RLS client with `x-garage-id`) and the garage switcher; public routes use the host garage; emails and invoice PDFs are branded per garage; access is `garage_members` (no `ADMIN_EMAILS`) |
| [x] P1.4 | data | Migration `0001_tenancy`: `garages`, `garage_domains`, `garage_members`, `platform_admins`; add `garage_id uuid not null references garages` to every SOB tenant table (customers, vehicles, enquiries…, invoices, invoice_items, media_assets, reviews, offers, service_prices, notification_attempts, audit tables); composite indexes `(garage_id, …)` | `supabase db reset` applies cleanly from zero — done `9e43c3e` (`20261026000100_tenancy.sql`) |
| [x] P1.5 | data | RLS on every tenant table: members of the garage only (`garage_id in (select garage_id from garage_members where user_id = auth.uid())`); role checks for owner-only actions; anon has no direct table access (SOB pattern) | Policy per table listed in migration comments — done `9e43c3e` (policy comment above every table) |
| [x] P1.6 | data | Squash SOB's 30 migrations + tenancy into a clean `supabase/migrations` baseline for the new project (keep SOB's history in git, not in the new DB) | One baseline + numbered Autofix migrations — done `9e43c3e` (`20261026000000_baseline.sql` + tenancy; schema diff vs SOB checked) |
| [x] P1.7 | api | Host routing in middleware: admin host, `<slug>.autofix.vitalos.co.uk`, verified custom hosts, dev host overrides; rewrite to `/app/…` or `/_site/[garageId]/…`; 60 s edge cache of host → garage | Unit tests for every host shape incl. unknown → 404 — done `66647ba`, `c1159ce` |
| [x] P1.8 | integrations | `src/lib/vercel/domains.ts`: add, get config, verify, remove domain via Vercel REST API; typed errors; `domains.check` job | Mocked tests; real call behind env flag — done `775197b` |
| [x] P1.9 | data | Seed script: 2 demo garages ("Hartley Road Motors" `hartley-road`, "Demo Garage B" `demo-b`), 3 bays + 1 mobile van each, opening hours, 6 services, staff users, sample customers/vehicles | `pnpm db:seed` — done `e591a57` (idempotent, local only; `seedResources`/`seedOpeningHours`/`seedClosures`/`seedServices` hold the scheduling data and skip until P2.1 creates the tables) |
| [x] P1.10 | qa | Tenancy suite `tests/integration/tenancy.test.ts` against local Supabase: enumerates every table with `garage_id` from `information_schema` and asserts isolation (so new tables are covered automatically) | **Gate 1** green in CI — suite `b576df9`: 26 tables, 1614 tests, green locally on 27 Oct 2026 (also on a simulated CI runner slot); tick when the CI run is green — **green in CI**: run 40429708549 (27 Oct 2026, `autofix-azure-1`), 1614 tenancy tests |
| [x] P1.11 | qa | CI: add Supabase local service to GitHub Actions; run `pnpm verify`, tenancy suite, Playwright smoke | Workflow green on PR — workflow `2fd20e2` (per-runner Supabase and ports, seed, host smoke, browser and Lighthouse jobs on the seeded garage host); every job's commands green locally; tick when the first run on the runners is green — all four jobs green on the self-hosted runners in run 40429708549 (on push; no PR is open yet) |

## Phase 2 · Booking engine (days 4–7)

Gate 2: **100 parallel bookings for the same slot pool produce zero overlaps** (`tests/integration/booking-concurrency.test.ts`), and the 5-step flow passes Playwright on a 390px viewport with axe clean.

| ID | Lane | Task | Done when |
| --- | --- | --- | --- |
| [x] P2.1 | data | Migration `0002_scheduling`: `resources`, `opening_hours`, `closures`, `services` (replace `booking_service_types`), new `bookings` shape (`during tstzrange`, statuses, sources), `booking_events`, `btree_gist` + `no_overlap` exclusion constraint; drop Cal.com `provider_*` columns and `calendly_webhook_events` | Migration + rollback notes — done `9836851` (`20261027000100_scheduling.sql`; customers E.164 + consent incl. `consent_text`, vehicles unique per registration, `seed_garage_defaults()`, dependants rewritten; pgTAP 010, tenancy suite 29 tables / 1779 tests; no `calendly_*` objects existed) |
| [x] P2.2 | data | SQL `available_slots(garage_id, service_id, from, to)` per SPEC (time-zone correct, slot step, notice, max days, resource kind, buffers) | pgTAP or Vitest-against-DB tests incl. BST↔GMT change days (29 Mar 2026, 25 Oct 2026) — done `905f697` (pgTAP 011, 56 tests) |
| [x] P2.3 | data | SQL `create_booking(...)` transaction: upsert customer by mobile, vehicle by reg, pick least-busy resource, insert, return reference; per-garage reference sequence with `booking_prefix` (e.g. `HRM-4821`, non-sequential like SOB) | Conflict raises a typed error — done `01ca667` (pgTAP 012, 75 tests; `tests/integration/booking-engine-database.test.ts`) |
| [x] P2.4 | api | Replace `src/lib/calcom/*` and `src/lib/bookings/*` provider calls with the native engine; remove Cal.com webhook route and env | No `calcom` imports remain — done `98ebbd7` (`grep -rni calcom src` empty; SOB wizard, Cal.com mapping admin and catalogue editor removed; admin bookings/dashboard/notifications/trash/invoices read the new bookings shape; `/` and `/manage-booking` are placeholders until P2.8/P2.9) |
| [x] P2.5 | api | Routes: `GET /api/services`, `GET /api/slots`, `POST /api/bookings` (idempotency, Turnstile, rate limit, 409 + 3 nearest slots), `GET/PATCH /api/bookings/manage` | Route tests — done `7200a6c` (`src/__tests__/booking-api-*.test.ts`; DB-backed `tests/integration/booking-api.test.ts` waits for the P2.1–P2.3 SQL) |
| [x] P2.6 | ui | Tokens + fonts: copy `design/tokens.css` into `globals.css`; `next/font` for Barlow Condensed, Inter, JetBrains Mono; `--garage-accent` set from garage on `/_site` layout | Visual match with `design/screenshots/Book-*.png` — done `fffb702`, `4d44b5c` |
| [x] P2.7 | ui | Components from DESIGN.md: GarageHeader, StepProgress, PlateInput, VehicleCard, ServiceOption, SegmentedControl, SymptomChips, DateStrip, SlotGrid, StickyActionBar, BookingSummaryBar, ConsentCheckbox, ConfirmationCard | Storybook stories (SOB has Storybook deps) or a `/dev/components` page — done `fffb702` (gallery at `/dev/components`) |
| [x] P2.8 | ui | Booking flow pages `/`, `/service`, `/time`, `/details`, `/confirmed/[reference]` on the garage host; state in a signed httpOnly cookie; no registration in URLs | Matches the 5 booking screenshots at 390px — done `cf1bfec`, `613bbb3` (sealed `af_booking`/`af_booked` cookies in `src/lib/booking-engine/state.ts`, fake engine `BOOKING_ENGINE=fake`, `tests/e2e/booking.spec.ts` rewritten for the 5-step flow with no fixme/fail marks; the real repository must replace the fake before Gate 2) |
| P2.9 | ui | Manage booking page (reference + reg, or signed link) restyled to the new language | Playwright journey |
| [x] P2.10 | api | Notifications on booking events: customer email (+ `.ics`) via existing Resend templates, re-branded per garage; staff alert email; SMS hook stubbed until Twilio (P3) | Email preview script shows garage branding — done `229df27` (`pnpm email:preview` writes Hartley Road Motors booking emails, staff alerts, `.ics` and SMS previews to `.email-previews/`; mock channels unless `MESSAGING_MODE=live`) |
| [x] P2.11 | qa | Concurrency test (100 parallel `create_booking` calls on 3 bays) and Playwright booking journey + axe at 390px | **Gate 2** green — must also remove the three `test.fixme` SOB-wizard journeys and the `test.fail` mobile-h1 case in `tests/e2e/booking.spec.ts` (marked in P1.11 because P2.8 replaces that wizard); Gate 2 can't pass while they are skipped — done `9f0450e` (`tests/integration/booking-concurrency.test.ts`: same start 3 of 100 win, spread starts, zero overlapping `during` per resource read back as owner; with `no_overlap` and the allocation lock both removed on a scratch stack it reports 65 and 112 overlapping pairs, either guard alone passes. `booking.spec.ts` on the real engine at desktop, Pixel 5 and 390×844, axe on the 5 steps and "slot taken", no registration in any URL, 27/27 three runs in a row; no fixme/fail/skip left in the booking journeys. `htmlLimitedBots` fix for the vanishing `<title>`, A44/A45) |

## Phase 3 · Admin + reminders (days 8–11)

Gate 3: **a reminder link produces a booking credited to that reminder end to end** (scheduled → sent via mocked Twilio → link opened → booking created with `source = reminder` → `reminder_sends.booking_id` set → dashboard "won back" updates).

| ID | Lane | Task | Done when |
| --- | --- | --- | --- |
| P3.1 | ui | AdminShell (desktop sidebar + phone tab bar), garage switcher for multi-garage users | Matches `Admin-Dashboard.png` / `Admin-Today-Phone.png` — components ready `3dbf7ad` (`src/components/admin-ui`, gallery `/dev/admin-components`); wiring open: drop the root layout `<main>` (AdminShell has its own), delete SOB `src/components/admin/admin-shell.tsx`/`admin-navigation.tsx`, add `/app/more` and `/app/bookings/new` |
| P3.2 | ui | Today: KPI cards, DiaryGrid by resource, Needs your OK (accept / offer another time / call back), Reminders this week | Live data from seed |
| P3.3 | ui | Diary (week view, drag to move later), Bookings list + detail with status changes and booking_events timeline | Status changes write `booking_events` |
| P3.4 | ui | Setup: Services & prices, Opening hours & closures, Resources (bays/vans), Branding (logo, accent with contrast check), MOT on/off | CRUD + validation |
| [x] P3.5 | integrations | `CompositeProvider`: DVLA VES + DVSA MOT History (OAuth client credentials) + VDG fallback; `vehicle_facts` 24 h cache; mock provider for dev | Provider tests with recorded fixtures — done `f93b5b5` (`vehicle_facts` table lands with P3.6) |
| P3.6 | data | Migration `0003_reminders`: `reminder_rules` (seeded defaults on garage create), `reminder_sends`, `messages`, `calls`, `jobs` (+ `claim_jobs(kind, n)` using `for update skip locked`) | Migration |
| P3.7 | api | Job runner: `/api/cron/[job]` (CRON_SECRET) enqueues; worker route drains with retries + backoff; jobs `reminders.schedule`, `reminders.send`, `mot.refresh`, `domains.check`, `retention` | Unit tests per job |
| P3.8 | integrations | `MessageChannel` interface + Twilio SMS/WhatsApp adapters + status webhook + STOP handling; Resend email adapter; sandbox/mock mode by default | Signature verification tests — library layer done `693cfef` (channels, Twilio adapters, signatures, templates, quiet hours, STOP keywords); webhook routes open |
| P3.9 | api | Reminder link tokens `/r/{token}` → prefilled booking; attribution on booking create | Covered by gate test |
| P3.10 | ui | Reminders page: stats, automations with switches, due-in-30-days table, template editor with 160-char counter, message preview, "send me a test" | Matches `Admin-Reminders.png` |
| P3.11 | api | Customers & cars: list, detail, CSV import with consent declaration, background DVSA enrichment | Import of 1,000 rows < 60 s locally |
| P3.12 | qa | Gate 3 end-to-end test + admin Playwright journeys + axe | **Gate 3** green |

## Phase 4 · Front desk + launch (days 12–14)

Gate 4: **first garage live on its own domain**: `book.<garage>.co.uk` serves its booking page over HTTPS, a real booking lands in its admin, and a reminder can be sent. Needs Temitope (domain owner + spend approvals), so the agent prepares everything and stops at the checklist.

| ID | Lane | Task | Done when |
| --- | --- | --- | --- |
| P4.1 | api | Missed calls: `/api/webhooks/twilio/voice` (garage by called number), TwiML message + voicemail, text-back within 60 s, `calls` row, Needs your OK card | Webhook tests |
| P4.2 | api | Agent tool API `/api/agent/v1/*` (lookup_vehicle, list_services, available_slots, create_booking[requested], get_booking, garage_profile); `agent_tokens` hashed; per-call audit; OpenAPI file `docs/autofix/agent-api.yaml` for Workforce/Askbridge | Contract tests |
| P4.3 | ui | Booking page & domain settings: free link, connect domain (DNS table, status steps), embed snippets, QR code | Matches `Admin-Domain.png`; drives P1.8 — components ready `3dbf7ad` (DnsRecordTable, DomainStatusSteps, EmbedSnippet); the embed needs `frame-ancestors` per garage instead of the global `X-Frame-Options: SAMEORIGIN` |
| P4.4 | ui | Sign-up / onboarding: create garage (name, slug, phone, address), pull details from Google Places (SOB has `GOOGLE_PLACES_API_KEY`), seed services/hours/rules, invite staff, MFA enrolment | New garage live on its free link in < 15 min |
| P4.5 | ui | Super admin `/admin`: garages list, plan, status, impersonate (logged), job queue health | Platform admins only |
| P4.6 | integrations | Askbridge: embed widget on booking layout; knowledge sync webhook on profile/services/FAQ change | Widget loads without hurting Lighthouse |
| P4.7 | qa | Lighthouse mobile on booking routes ≥ 90 perf / 100 a11y; full Playwright suite; load test slots endpoint (50 rps for 60 s, p95 < 300 ms) | Reports in `output/` |
| P4.9 | api | Wire legal copy: privacy notice per garage (from `docs/autofix/legal/`), consent wording in Book 4, unsubscribe page, DPA acceptance at garage sign-up | Copy matches the reviewed drafts |
| P4.8 | api | Launch checklist in `docs/autofix/LAUNCH.md`: env vars set in Vercel, domains attached, crons, Supabase backups, Sentry, DPA/privacy copy, first garage data import | Checklist ready for Temitope |

---

## Definition of done (every task)

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass (`pnpm verify`).
- New tables have `garage_id`, RLS and are picked up by the tenancy suite.
- No secrets in code or logs; no registration in URLs or analytics.
- UI matches the screenshot at 390px and 1440px; axe has no violations.
- This file and `docs/autofix/DECISIONS.md` updated.
