# Launch checklist: first garage live

For Temitope. Work top to bottom; each step says who does it, where it stands, and how to check it. Anything that spends money, changes DNS or billing, or messages a real person is yours (CLAUDE.md "Stop and ask Temitope"); agents prepare and verify. This list mirrors "Waiting on Temitope" in [DECISIONS.md](DECISIONS.md); tick both when an item is done.

Status key: **Todo** (not started) · **Ready** (agent work done, waiting on you) · **Done**. State as of 27 Oct 2026.

## 0. Before you start

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 0.1 | `main` is green: CI (lint, typecheck, unit, pgTAP, integration incl. tenancy, Playwright booking + legal) on the commit you deploy | Agent | Todo | GitHub Actions run for that commit is green |
| 0.2 | Gates 1 to 4 ticked in [BUILD-PLAN.md](BUILD-PLAN.md) (`/gate 4`) | Agent | Todo | `/status` shows every phase gate ticked |

## 1. Vercel project and plan

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 1.1 | **Decide Vercel Pro** (D13). Hobby is non-commercial, 50 custom domains, crons once a day. Pro is needed before the first *paying* garage | Temitope (spend) | Todo | Team → Settings → Billing shows Pro, or the decision is written in DECISIONS.md |
| 1.2 | Create project `autofix` in the Vitalos team, linked to `vitalos-technologies/autofix`, framework Next.js, Node 22, production branch `main` | Temitope | Todo | Project → Settings → Git shows the repo; a preview deploy builds |
| 1.3 | Set every production env var in section 2 (Production scope; Preview gets its own non-production values) | Temitope, agent can fill non-secret values | Todo | `GET https://autofix.vitalos.co.uk/api/health` reports `configuration: true` (it lists missing names, never values) |

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

From `.env.example`, `src/lib/env.ts` (`requiredProductionVariables`, `requiredBookingVariables`, readiness flags) and every `process.env` read in `src/`. **Sensitive** = mark as Sensitive in Vercel, never put in a `NEXT_PUBLIC_` name, never paste in chat or commit. "Required" = production refuses or degrades without it.

### Core

| Variable | Value / source | Secret | Required |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | `https://autofix.vitalos.co.uk` (must be https, not localhost) | No | Yes (readiness) |
| `NEXT_PUBLIC_ADMIN_HOST` | `autofix.vitalos.co.uk` | No | Yes |
| `NEXT_PUBLIC_TENANT_ROOT_DOMAIN` | `autofix.vitalos.co.uk` (free links `<slug>.autofix.vitalos.co.uk`) | No | Yes |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → URL | No | Yes (readiness) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase → API keys → publishable key | No (public by design) | Yes (readiness) |
| `SUPABASE_SECRET_KEY` | Supabase → API keys → secret key | **Sensitive** | Yes (readiness) |
| `CRON_SECRET` | 32+ random chars (`openssl rand -base64 48`); Vercel Cron sends it as `Authorization: Bearer` | **Sensitive** | Yes (readiness) |
| `LEGAL_COPY_APPROVED` | `true` **only after** step 8.1 (solicitor sign-off) | No | Yes (readiness) |
| `COOKIE_CONFIGURATION_APPROVED` | `true` once the cookie set is confirmed (only strictly necessary cookies today: `af_garage`, `af_booking`, `af_booked`, `af_manage`, Supabase auth, trusted device) | No | Yes (readiness) |

### Booking, consent and unsubscribe links

| Variable | Value / source | Secret | Required |
| --- | --- | --- | --- |
| `BOOKING_MANAGEMENT_SECRET` | 32+ random chars. Signs manage links, manage sessions, calendar downloads **and unsubscribe links** (`/unsubscribe/<token>`). Without it production booking answers `UNAVAILABLE` and emails carry no unsubscribe link. Rotating it retires every unsubscribe link already sent (the `/unsubscribe` form still works) | **Sensitive** | Yes (booking readiness) |
| `BOOKING_STATE_SECRET` | 32+ random chars; seals the booking-flow cookies (falls back to `BOOKING_MANAGEMENT_SECRET`) | **Sensitive** | Recommended |
| `BOOKING_ENGINE` | leave **unset** in production (`fake` is ignored in production builds anyway) | No | No |
| `AGENT_TOKEN_PEPPER` | 32+ random chars, for the agent tool API (P4.2) | **Sensitive** | When the AI front desk goes live |

### Email (Resend, Cloudflare Email Routing)

| Variable | Value / source | Secret | Required |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | Resend → API Keys (sending access, the verified domain only) | **Sensitive** | Yes (readiness) |
| `RESEND_FROM_EMAIL` | `Autofix <notifications@autofix.vitalos.co.uk>` (domain verified in step 5.1) | No | Yes (readiness) |
| `RESEND_REPLY_TO` | optional fallback reply-to for a garage with no email | No | No |
| `RESEND_WEBHOOK_SECRET` | Resend → Webhooks → signing secret for `https://autofix.vitalos.co.uk/api/webhooks/resend` | **Sensitive** | Yes (readiness) |
| `ENQUIRY_REPLY_DOMAIN` | `reply.autofix.vitalos.co.uk` | No | Yes (readiness) |
| `RESEND_INBOUND_DOMAIN` | leave unset (rollout fallback only) | No | No |
| `CLOUDFLARE_EMAIL_WEBHOOK_SECRET` | 32+ random chars; the same value in the Cloudflare email worker (`workers/enquiry-email/`) | **Sensitive** | Yes (readiness) |

### Messaging (Twilio)

| Variable | Value / source | Secret | Required |
| --- | --- | --- | --- |
| `MESSAGING_MODE` | `mock` until step 6 is done, then `live`. `mock` sends nothing (in-memory outbox) | No | Yes for real messages |
| `TWILIO_ACCOUNT_SID` | Twilio console | No (identifier) | With live |
| `TWILIO_AUTH_TOKEN` | Twilio console (also verifies inbound webhooks) | **Sensitive** | With live |
| `TWILIO_MESSAGING_SERVICE_SID` | Messaging Service holding the two-way UK number(s) | No | With live |
| `TWILIO_WHATSAPP_FROM` | approved WhatsApp sender, E.164 | No | With WhatsApp |
| `TWILIO_STATUS_CALLBACK_BASE_URL` | `https://autofix.vitalos.co.uk` (delivery receipts) | No | Recommended |
| `TWILIO_WEBHOOK_BASE_URL` | `https://autofix.vitalos.co.uk`: the origin Twilio calls `/api/webhooks/twilio/*` on; signatures are checked against it (else rebuilt from `X-Forwarded-*`) | No | Recommended |

### Vehicle data

| Variable | Value / source | Secret | Required |
| --- | --- | --- | --- |
| `VEHICLE_LOOKUP_PROVIDER` | `composite` (DVSA + DVLA when keys exist, Vehicle Data Global fallback) | No | Yes |
| `DVLA_VES_API_KEY` | DVLA VES (portal paused new registrations on 26 Oct 2026) | **Sensitive** | When issued |
| `DVLA_VES_ENVIRONMENT` | `live` | No | With DVLA |
| `DVSA_MOT_CLIENT_ID`, `DVSA_MOT_CLIENT_SECRET`, `DVSA_MOT_API_KEY`, `DVSA_MOT_TOKEN_URL`, `DVSA_MOT_SCOPE` | DVSA MOT History credentials email (secret and API key **Sensitive**) | Partly | When issued |
| `VEHICLE_DATA_GLOBAL_API_KEY` | Vehicle Data Global account | **Sensitive** | Yes until DVLA/DVSA keys exist |
| `VEHICLE_DATA_GLOBAL_BASE_URL`, `VEHICLE_DATA_GLOBAL_PACKAGE` | `https://uk.api.vehicledataglobal.com`, `VehicleDetails` | No | With VDG |
| `VEHICLE_FACTS_PEPPER` | 32+ random chars (cache key for registration lookups) | **Sensitive** | Recommended |

### Domains, bot protection, monitoring

| Variable | Value / source | Secret | Required |
| --- | --- | --- | --- |
| `VERCEL_DOMAINS_MODE` | `live` once the token exists | No | Yes for custom domains |
| `VERCEL_API_TOKEN` | team-scoped token, domains only | **Sensitive** | With live domains |
| `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | Project → Settings → General | No | With live domains |
| `VERCEL_DOMAIN_CNAME_TARGET` | `cname.vercel-dns-0.com` | No | Yes |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare Turnstile widget for `*.autofix.vitalos.co.uk` plus each custom domain | No | Yes (readiness) |
| `TURNSTILE_SECRET_KEY` | the same widget's secret | **Sensitive** | Yes (readiness) |
| `SENTRY_DSN` | Sentry project `autofix` → Client Keys | No (DSN is not a secret, keep it out of git anyway) | Recommended |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | source-map upload at build (token **Sensitive**) | Partly | Recommended |
| `GOOGLE_PLACES_API_KEY` | Google Cloud, Places API, restricted to the server | **Sensitive** | For sign-up autofill (P4.4) |
| `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL` | Askbridge widget script (https), from Askbridge | No | When the Askbridge chat goes live (P4.6) |
| `ASKBRIDGE_SYNC_URL` | Askbridge knowledge endpoint (https) | **Sensitive** | When the Askbridge chat goes live |
| `ASKBRIDGE_WEBHOOK_SECRET` | 32+ random chars, shared with Askbridge (signs knowledge syncs) | **Sensitive** | When the Askbridge chat goes live |

Never set in production: a `http://127.0.0.1` `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL` (local stub), `DEV_TENANT_ROOT_DOMAIN`, `PLAYWRIGHT_TEST`, `ENABLE_DEV_COMPONENTS`, `SEED_*`, `VERCEL_DOMAINS_LIVE_TEST`, `EMAIL_PREVIEW_DIR`, `INVOICE_PDF_QA_DIR`. `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`, `NODE_ENV`, `NEXT_RUNTIME` are set by the platform.

## 3. Domains

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 3.1 | Cloudflare records exist: `autofix` and `*.autofix` CNAME → `cname.vercel-dns-0.com`, `_acme-challenge.autofix` NS → Vercel (INFRA.md) | Done (25 Oct) | Done | `dig +short autofix.vitalos.co.uk` returns the Vercel CNAME |
| 3.2 | Attach `autofix.vitalos.co.uk` and `*.autofix.vitalos.co.uk` to the project (wildcard: team Domains → `vitalos.co.uk` → Enable Vercel DNS, keep Cloudflare nameservers) | Temitope (DNS/domain) | Todo | Project → Domains shows both "Valid Configuration"; `https://hartley-road.autofix.vitalos.co.uk` gives a TLS-valid 404 page until a garage exists |
| 3.3 | Garage's own domain: the garage adds a CNAME `book` → `cname.vercel-dns-0.com` at their DNS host (shown in `/app` booking page settings, P4.3); Autofix attaches it via the domains API | Garage + Temitope approves | Todo | Admin domain status reaches "Live"; `https://book.<garage>.co.uk` serves the booking page with a valid certificate |
| 3.4 | Turnstile widget hostnames include the garage's custom domain | Temitope | Todo | Book 4 shows the check on the custom domain without an error |

## 4. Supabase

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 4.1 | Create project `autofix`, region **London (eu-west-2)**, Free plan (Pro needs your OK) | Temitope | Todo | Dashboard shows the project in eu-west-2 |
| 4.2 | Backups: Free has **daily backups only, no point-in-time recovery**, and pauses after 7 days idle. Before the first paying garage, decide Pro (+ PITR add-on if you want minute-level restore) | Temitope (spend) | Todo | Database → Backups lists a daily backup; decision noted in DECISIONS.md |
| 4.3 | Apply migrations: `supabase link --project-ref <ref>` then `supabase db push` (runs every file in `supabase/migrations/`, incl. `20261028000300_dpa_acceptance.sql`). Do **not** run `supabase/seed*` or `pnpm db:seed` against production (the seed refuses non-local URLs) | Agent with your login, or Temitope | Todo | `supabase migration list` shows local = remote; `/api/health` reports the database ready |
| 4.4 | Auth: Site URL `https://autofix.vitalos.co.uk`, redirect URLs `https://autofix.vitalos.co.uk/auth/confirm`; SMTP through Resend (domain from 5.1) so password emails come from Autofix | Temitope | Todo | A password reset email arrives from the Autofix address |
| 4.5 | `btree_gist` is enabled by the scheduling migration; confirm no migration errors | Agent | Todo | `select extname from pg_extension` lists `btree_gist` |

## 5. Email

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 5.1 | Resend: verify the sending domain (`autofix.vitalos.co.uk` or `mail.autofix.vitalos.co.uk`): add its SPF/DKIM/return-path records in Cloudflare | Temitope (DNS) | Todo | Resend → Domains shows "Verified" |
| 5.2 | Resend webhook → `https://autofix.vitalos.co.uk/api/webhooks/resend`, copy its signing secret to `RESEND_WEBHOOK_SECRET` | Temitope | Todo | Resend shows 2xx deliveries |
| 5.3 | Cloudflare Email Routing for `reply.autofix.vitalos.co.uk` → the enquiry email worker; update `workers/enquiry-email/` (still points at SOB's `reply.sobautofix.com`) and deploy with `pnpm deploy:email-worker` | Agent prepares, Temitope (DNS) | Todo | Replying to an enquiry email shows the reply in `/app/enquiries` |

## 6. Twilio (SMS, WhatsApp, voice)

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 6.1 | Account, UK two-way number(s) in a Messaging Service, alphanumeric sender (one-way, booking updates only, DECISIONS A13), WhatsApp sender + templates | Temitope (spend) | Todo | Twilio console lists the senders; WhatsApp templates approved |
| 6.2 | Webhooks (P3.8): Messaging Service inbound → `https://autofix.vitalos.co.uk/api/webhooks/twilio/sms`, WhatsApp sender inbound → `…/twilio/whatsapp`, voice number → `…/twilio/voice` (logs calls; text-back with P4.1). Delivery receipts go to `…/twilio/status` via `TWILIO_STATUS_CALLBACK_BASE_URL`. Each garage number needs a `garage_phone_numbers` row with `provider_sid` (platform provisioning) or nothing routes to it | Agent configures with your login | Todo | Replying STOP to a test text sets `opted_out_at` and shows "Customer stopped reminders" in the garage's Recent activity |
| 6.3 | Switch `MESSAGING_MODE=live` only after 5.1 and 6.1, and after a mock-mode smoke test (9.4) | Temitope | Todo | A test booking with your own mobile receives the confirmation text |

## 7. Vehicle data, Turnstile, Sentry, crons

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 7.1 | DVLA VES and DVSA MOT History keys (applications in progress; DVLA registrations paused 26 Oct). Until then `composite` uses DVSA + Vehicle Data Global | Temitope | Todo | Book 1 finds a real car (your own registration) on the free link |
| 7.2 | Turnstile widget (managed mode) for `*.autofix.vitalos.co.uk` + custom domains; set both keys | Temitope | Todo | Book 4 shows the check; a submission without it is refused |
| 7.3 | Sentry project `autofix` (EU region if offered), DSN + source-map token in Vercel. Scrubbing: registrations and phone numbers never logged (CLAUDE.md rule 3) | Temitope | Todo | Trigger a test error from a preview deploy; the event appears with readable stack traces and no personal data |
| 7.4 | Crons (P3.7): `vercel.json` has one Hobby job, `/api/cron/daily` at 11:00 UTC (queues reminders.schedule, reminders.send, domains.check, retention, customers.enrich, mot.refresh and drains for 20 s). On Pro add the per-kind crons in INFRA.md ("Jobs and crons"), e.g. `reminders.send` every 10 minutes and `domains.check` every 5 | Agent | Ready (daily) | Vercel → Project → Cron Jobs lists the job; its last run returns 200 with `drain.ok: true` (401 means `CRON_SECRET` is wrong or shorter than 16 characters) |

## 8. Legal (P4.9)

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 8.1 | **Solicitor review** of `docs/autofix/legal/` (privacy notice v0.1, consent and messaging wording v0.2, DPA v0.1). Apply their changes to the Markdown, bump each version, run `node scripts/sync-legal-copy.mjs`, commit. Removing "Draft for solicitor review…" and "(draft …)" from a file removes the draft flag from its page | Temitope (external) | Todo | Unit test `legal-copy` passes; `/privacy` no longer shows the draft flag |
| 8.2 | Set `LEGAL_COPY_APPROVED=true` after 8.1 | Temitope | Todo | `/api/health` no longer lists `LEGAL_COPY_APPROVED` |
| 8.3 | Wired copy (agent, done in P4.9): `/privacy` on every garage host (garage details filled from Settings, Vitalos as processor), linked from Book 4 and every booking page footer; Book 4 consent wording (MOT on/off) stored word for word in `customers.consent_text`; `/unsubscribe` (form) and `/unsubscribe/<token>` (signed link in every customer email) set `opted_out_at` at once and write "Customer stopped reminders" to the garage's audit log | Agent | Done | `pnpm test:e2e:legal`; open `https://<slug>.autofix.vitalos.co.uk/privacy` and check every detail |
| 8.4 | The first garage's owner reads and accepts the DPA at `/app/settings/agreements` (stored in `garage_agreements` with version, text hash, name and time). Sign-up (P4.4) reuses the same component | Garage owner | Todo | The page shows "Accepted on <date> by <name>"; Recent activity shows "Accepted agreement DPA v0.1" |
| 8.5 | The garage's Settings has legal name, company number (if a company), address, email and phone; otherwise the privacy notice shows "[… not provided]" | Garage owner | Todo | `/privacy` has no "not provided" markers |
| 8.6 | Vitalos's own items: ICO registration (data protection fee) for Vitalos Technologies Ltd as processor/controller of staff data; sub-processor DPAs in place (Supabase, Vercel, Cloudflare, Resend, Twilio, Sentry, Vehicle Data Global, Anthropic, Stripe) | Temitope | Todo | ICO register entry; signed or accepted DPAs filed |

## 9. First garage onboarding and smoke tests

| # | Step | Owner | Status | How to verify |
| --- | --- | --- | --- | --- |
| 9.1 | Create the garage (sign-up P4.4 when shipped; until then an agent inserts it with `seed_garage_defaults()` from a reviewed script, never the demo seed). Owner enrols MFA on first sign-in | Agent + garage owner | Todo | Owner signs in at `/app` with TOTP; the free link `https://<slug>.autofix.vitalos.co.uk` loads |
| 9.2 | Set up services, prices, opening hours, closures, resources (bays/van), MOT on or off, accent colour, logo | Garage owner with agent help | Todo | Book 2 lists the right services; Book 3 shows the right hours |
| 9.3 | **Customer CSV import** (P3.11 when shipped): the owner ticks the import declaration (consent wording draft); check retention will not anonymise imported customers (DECISIONS A37) before importing | Agent + garage owner | Todo | Imported count matches the file; a sample customer has the right consent source |
| 9.4 | **Smoke test in mock mode** (`MESSAGING_MODE=mock`): book a car end to end on the free link with your own details; check the booking in `/app/bookings`, the manage link, cancel, and that no text/email left Twilio/Resend | Agent | Todo | Booking visible in admin; Twilio and Resend logs show nothing sent |
| 9.5 | **Smoke test live** (after 6.3): repeat 9.4 with your own mobile and email only; open the email's "Stop reminders" link, then "Turn reminders back on" | Temitope | Todo | Confirmation text and email arrive; unsubscribe and resubscribe show in Recent activity |
| 9.6 | Reminder test send (P3, when shipped): send one reminder to your own number in mock, then live, inside 09:00–19:00 Mon–Sat | Agent then Temitope | Todo | Mock outbox shows the message; live text arrives with "Reply STOP to opt out." |
| 9.7 | Custom domain (3.3), Lighthouse ≥ 90 perf / 100 a11y on the live booking page (P4.7) | Agent | Todo | Lighthouse report in `output/` |

## 10. Rollback

| Situation | Action | Owner |
| --- | --- | --- |
| Bad deploy | Vercel → Deployments → previous production deployment → **Promote to Production** (instant; no rebuild) | Temitope or agent with access |
| Messages going wrong | Set `MESSAGING_MODE=mock` and redeploy: every booking message goes to the mock outbox; nothing reaches customers | Temitope |
| Bad migration | Migrations are forward-only. Write a corrective migration, test it with `supabase db reset` + pgTAP locally, push. On Free, restoring the daily backup loses everything since it was taken; on Pro with PITR restore to a point in time | Agent, your OK for any restore |
| Domain problem | Remove the custom domain in `/app` (free link keeps working) | Garage owner |
| Leaked secret | Rotate it at the provider, update Vercel, redeploy. Rotating `BOOKING_MANAGEMENT_SECRET` also retires sent manage and unsubscribe links (the `/unsubscribe` form still works) | Temitope |
