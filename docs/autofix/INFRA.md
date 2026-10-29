# Infrastructure

State as of 25 Oct 2026.

## Exists

| What | Where | Detail |
| --- | --- | --- |
| DNS zone `vitalos.co.uk` | Cloudflare (Temitope's account), Free plan, all records DNS-only | Zone ID `99115a2bb8d6630faff3cb8151e1f35c` |
| `autofix` CNAME → `cname.vercel-dns-0.com` | Cloudflare, DNS only | Admin app |
| `*.autofix` CNAME → `cname.vercel-dns-0.com` | Cloudflare, DNS only | Per-garage free links |
| `_acme-challenge.autofix` NS → `ns1.vercel-dns.com`, `ns2.vercel-dns.com` | Cloudflare | Lets Vercel issue the `*.autofix.vitalos.co.uk` wildcard certificate |
| Vercel team "Vitalos' projects" | Vercel, **Hobby** plan | Hosts vitalos.co.uk, Askbridge, Fauward |
| GitHub repo `vitalos-technologies/autofix` | GitHub, private | Created 25 Oct 2026, empty until `/bootstrap` pushes |
| Vercel project `autofix` | Team `vitalos-projects-8e978de2` (team ID `team_5uDOAjR2l4XPYSxXtcUmWNMC`), project ID `prj_MyFtTDfjEtEh2lCMkD6PHJWqTh2V` | Created and linked to the repo by Temitope on 27 Oct 2026; previews deploy per PR (e.g. `autofix-theta.vercel.app`). Set `VERCEL_PROJECT_ID` and `VERCEL_TEAM_ID` to these. No env vars or domains yet |
| SOB Autofix | Vercel project `sobautofix` (separate team), Supabase, Cal.com | Source of the fork; keep running unchanged |

## To create (needs Temitope's OK where marked)

1. ~~**Vercel project `autofix`** in the Vitalos team, linked to the GitHub repo.~~ Done 27 Oct 2026 (see Exists). Check Settings → General: framework Next.js, Node 22, production branch `main`.
2. **Domains on the project**: add `autofix.vitalos.co.uk` and `*.autofix.vitalos.co.uk`. For the wildcard: on the team Domains page select `vitalos.co.uk` → DNS Records → *Enable Vercel DNS* (keep Cloudflare nameservers). The `_acme-challenge.autofix` NS records already delegate validation. Check status under Settings → Domains.
3. **`VERCEL_API_TOKEN`**: team-scoped token for the domains API, stored as a Sensitive env var on the project (never in git).
4. **Vercel Pro** (spend) before the first paying garage: commercial use, unlimited custom domains, sub-daily crons.
5. **Supabase project** `autofix`, region London (eu-west-2), **Free plan** (no spend decided 25 Oct). Enable `btree_gist`. Free projects pause after 7 days without activity and have no point-in-time recovery.
6. **Twilio** (spend): account, UK numbers for call forwarding, alphanumeric sender, WhatsApp sender + templates.
7. **DVLA VES** and **DVSA MOT History** API applications (free).
8. **Resend**: verify a sending domain for platform mail (e.g. `mail.autofix.vitalos.co.uk`, DNS change) and per-garage reply-to.
9. **Sentry** project `autofix`; **Turnstile** site key for `*.autofix.vitalos.co.uk` and custom domains.

## Environment variables

Kept from SOB: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`, `GOOGLE_PLACES_API_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `VEHICLE_LOOKUP_PROVIDER`, `VEHICLE_DATA_GLOBAL_API_KEY`, `VEHICLE_DATA_GLOBAL_BASE_URL`, `VEHICLE_DATA_GLOBAL_PACKAGE`, `BOOKING_MANAGEMENT_SECRET`, `CRON_SECRET`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`.

Removed: `CALCOM_*`, `NEXT_PUBLIC_TAWK_*`, `NEXT_PUBLIC_GOOGLE_MAPS_URL`, `GOOGLE_PLACE_ID`, `ENQUIRY_*` single-business values (incl. `ENQUIRY_NOTIFICATION_EMAIL`), `ADMIN_EMAILS` (access is `garage_members`), `LEGAL_COPY_APPROVED`/`COOKIE_CONFIGURATION_APPROVED` (become per-platform flags).

Email (P1.3): `RESEND_FROM_EMAIL` is the platform sender address (the display name is replaced by the garage's name per message); `RESEND_REPLY_TO` is optional and only a fallback when a garage has no email; `ENQUIRY_REPLY_DOMAIN` (e.g. `reply.autofix.vitalos.co.uk`) carries enquiry reply tokens.

Agent tool API (P4.2): `AGENT_TOKEN_PEPPER` (32+ random characters, Sensitive; keys the HMAC of agent tokens, so rotating it invalidates every issued token).

Jobs and webhooks (P3.7, P3.8): `CRON_SECRET` (Sensitive, at least 16 random characters; shorter or unset refuses every cron and drain call) and `TWILIO_WEBHOOK_BASE_URL` (the public origin Twilio calls the webhooks on, e.g. `https://autofix.vitalos.co.uk`; the webhooks also need `TWILIO_AUTH_TOKEN` and answer 503 without it). Reminder link tokens need no secret (random, stored hashed), so the bootstrap's `REMINDER_LINK_SECRET` is gone.

Askbridge (P4.6, [askbridge.md](askbridge.md)): no secrets; each garage pastes its own Askbridge site key in Setup. `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL` (optional, public, https; inlined at build) overrides the loader, which defaults to `https://askbridge.vitalos.co.uk/widget/v1/askbridge.js`. `ASKBRIDGE_SYNC_URL` and `ASKBRIDGE_WEBHOOK_SECRET` are no longer used (29 Oct 2026).

Security headers (P4.3): `X-Frame-Options` and `Content-Security-Policy` are set per host in `src/proxy.ts` (not `next.config.ts`): admin host `SAMEORIGIN` + `frame-ancestors 'self'`; garage booking hosts a CSP whose `frame-ancestors` lists the garage's allowed sites and whose script and connect sources add the Askbridge loader's origin only when that garage has the chat on.

Plans and billing (P5.2, D17, D19): `BILLING_PROVIDER` (`mock` default, or `stripe`), `STRIPE_SECRET_KEY` (**test mode only**: `sk_test_`/`rk_test_`; a live key is refused and the mock is used), `STRIPE_BILLING_WEBHOOK_SECRET` (`whsec_…` of the endpoint `https://autofix.vitalos.co.uk/api/webhooks/billing/stripe`, events `customer.subscription.created/updated/deleted`), `STRIPE_PRICE_PRO`, `STRIPE_PRICE_EXTRA_SITE` (all Sensitive, server only). Price and allowance placeholders until Temitope sets them: `PLAN_ESSENTIALS_PRICE_PENCE`, `PLAN_PRO_PRICE_PENCE`, `PLAN_ESSENTIALS_SMS_ALLOWANCE`, `PLAN_PRO_SMS_ALLOWANCE`, `PLAN_PRO_AI_MINUTES`, `PLAN_EXTRA_SITE_PRICE_PENCE` (empty = "to be confirmed"). `USAGE_METERING=off` stops recording usage. None of these exist in Vercel or the repo secrets yet (checked 28 Oct 2026).

Added: see `.autofix/env.autofix.example` (appended to `.env.example` by `/bootstrap`).

Django super admin (P5.1, `superadmin/`, its own container; see `superadmin/.env.example`): `DJANGO_SECRET_KEY`, `DATABASE_URL` (its own Postgres 17), `AUTOFIX_DATABASE_URL` (Autofix Supabase as `autofix_superadmin`: session pooler, user `autofix_superadmin.<project-ref>`, `sslmode=require`; the role's password is set out of band with `alter role autofix_superadmin with login password '…'`, never in a migration), `AUTOFIX_STATUS_TOKEN` (32+ characters, shared with the Vitalos platform's Product Pipeline), `AUTOFIX_APP_URL` (`https://autofix.vitalos.co.uk`), `AUTOFIX_SUPERADMIN_URL` (`https://autofix.vitalos.co.uk/superadmin`, not live), `SUPERADMIN_PATH_PREFIX` (`/superadmin`), `SUPERADMIN_PROXY_SECRET` (32+ characters, the same value as Vercel's), `ALLOWED_HOSTS` (`autofix.vitalos.co.uk`), `CSRF_TRUSTED_ORIGINS` (`https://autofix.vitalos.co.uk`), `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`, `PRIMARY_OWNER_EMAIL`, `SENTRY_DSN`. None of these are Vercel variables. Vercel (Autofix project) needs two for the `/superadmin` proxy (D18): `SUPERADMIN_ORIGIN` (the container's own https address) and `SUPERADMIN_PROXY_SECRET` (Sensitive); without them `/superadmin` is a 404.

Django super admin deploy (D18, A416, A417): `.github/workflows/superadmin-deploy.yml` (run by hand) builds `ghcr.io/vitalos-technologies/autofix-superadmin` (private), prepares Autofix's Supabase project (role and schema `superadmin_app`, `autofix_superadmin` login) over the Management API, deploys Azure Container Apps `autofix-superadmin` in `rg-autofix-superadmin` (UK South, consumption plan, scale to zero, jobs `autofix-superadmin-release` and `autofix-superadmin-notify`), then sets Vercel's `SUPERADMIN_ORIGIN` and `SUPERADMIN_PROXY_SECRET` (Production) and redeploys. Repository secrets: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `GHCR_PULL_TOKEN`, `VERCEL_API_TOKEN`, and either `SUPERADMIN_DATABASE_URL` + `SUPERADMIN_AUTOFIX_DATABASE_URL` (from `superadmin/deploy/supabase_roles.sql`, A418) or `SUPABASE_ACCESS_TOKEN`. The container's own secrets (Django key, connection strings, proxy secret, status token, bootstrap password) are generated by the deploy and kept in Azure. Steps: `superadmin/README.md`, "Deploy".

## Jobs and crons (P3.7)

The job queue is the `jobs` table (P3.6). `GET /api/cron/<name>` (`Authorization: Bearer $CRON_SECRET`, which Vercel Cron sends by itself) queues that name's platform job for the current period (dedupe key per UTC day, per 10-minute slot for `reminders.send`, per 5-minute slot for `domains.check`), then drains due jobs of every kind for up to 20 seconds. `POST /api/jobs/drain` (same header; optional JSON `{"kinds": [...], "budgetMs": 1000-50000}`) only drains. Booking notifications and HELP answers are also drained straight after the request that queued them (`after()`).

| Plan | `vercel.json` crons |
| --- | --- |
| **Hobby (now)**: daily crons only, started any time within the hour | one cron: `/api/cron/daily` at `0 11 * * *` (11:00–11:59 UTC = 11:00–12:59 London: after the 10:00 reminder time and inside the 09:00–19:00 send window in GMT and BST). Reminders therefore go out once a day around midday; Sunday's wait for Monday's run; a domain moves one step a day; jobs left over (budget spent, retries with backoff) wait for the next run or a manual `POST /api/jobs/drain` |
| **Pro** | `/api/cron/reminders.send` every 10 minutes (`*/10 * * * *`), `/api/cron/domains.check` every 5 (`*/5 * * * *`), `/api/cron/mot.refresh` at `0 2 * * *`, `/api/cron/reminders.schedule` at `0 6 * * *`, `/api/cron/retention` at `15 3 * * *`, `/api/cron/customers.enrich` hourly, `/api/cron/platform.close_impersonations` hourly (`20 * * * *`), and drop `daily` |

Without Pro an external scheduler can call `POST /api/jobs/drain` (or `GET /api/cron/reminders.send`) every 10 minutes with the bearer header instead. The send window is enforced inside the job (a run outside it re-queues itself for 09:00 on the next Monday–Saturday), so a scheduler never needs to know quiet hours.

Twilio webhooks (P3.8): `POST /api/webhooks/twilio/{sms,whatsapp,status,voice}` on the admin host. Behind a proxy that rewrites the host, set `TWILIO_WEBHOOK_BASE_URL`, otherwise the signature check rebuilds the URL from `X-Forwarded-Proto` and `X-Forwarded-Host` (first value), then `Host`. A number only routes once its `garage_phone_numbers` row has `provider_sid` (A55).

## Local development

Everything below runs against the local Supabase CLI stack in Docker (`supabase/config.toml`, project `sobautofix-local-tests`, API on `http://127.0.0.1:54321`). Nothing here touches a hosted project.

```bash
pnpm install
pnpm exec supabase start                       # local Postgres, Auth, Storage, PostgREST
pnpm exec supabase db reset --local --no-seed  # rebuild the schema from supabase/migrations
pnpm db:seed                                   # demo garages, staff, customers (safe to run again)
pnpm dev                                       # admin: http://localhost:3000/app
                                               # booking sites: http://hartley-road.localhost:3000/, http://demo-b.localhost:3000/
```

For `pnpm dev`, put the local values in `.env.local` (gitignored): `NEXT_PUBLIC_SUPABASE_URL` (`API_URL`), `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`PUBLISHABLE_KEY`) and `SUPABASE_SECRET_KEY` (`SECRET_KEY`) from `pnpm exec supabase status -o env`. Never print or commit them.

### Demo seed (`pnpm db:seed`, `scripts/seed-demo.mjs`)

- **Local only.** It refuses any Supabase URL that is not plain `http` on a loopback host (`127.0.0.1`, `localhost`, `[::1]`; any port, because CI runners shift ports), the same rule as the integration tests. It takes the URL and secret key from `INTEGRATION_SUPABASE_*`, `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SECRET_KEY` or `API_URL`/`SECRET_KEY`, and otherwise asks `supabase status -o env` itself.
- **Idempotent.** Fixed UUIDs (derived from stable names) and upserts; run it as often as you like.
- **Creates** garage A *Hartley Road Motors* (`hartley-road`, prefix `HRM`, accent `#155fba`, MOT on, Doncaster) and garage B *Demo Garage B* (`demo-b`, `DGB`, accent `#0f766e`, MOT off); `site_settings` for both; 10 + 8 fictional customers with UK mobiles in Ofcom's drama range (`07700 900xxx`) and their vehicles; five enquiries with their conversations. Resources (3 bays + 1 mobile van), opening hours (Mon–Fri 08:00–17:30, Sat 08:30–13:00), closures and services (MOT only at garage A, Diagnostics, Full service, Interim service, Brakes and Something else as quotes) are written by `seedResources`, `seedOpeningHours`, `seedClosures` and `seedServices`, which say "skipped" until the P2.1 scheduling tables exist.
- **Staff** (Auth admin API). The script prints the emails, never the password:

  | Email | Role |
  | --- | --- |
  | `owner@hartley-road.example` | owner, Hartley Road Motors |
  | `manager@hartley-road.example` | manager, Hartley Road Motors |
  | `technician@hartley-road.example` | technician, Hartley Road Motors |
  | `owner@demo-b.example` | owner, Demo Garage B |
  | `shared.manager@autofix-demo.example` | manager in both garages (garage switcher) |

  Password: `SEED_STAFF_PASSWORD`, default `Autofix-demo-local-1` (documented in the script; local only, never reuse it anywhere).
- **MFA.** Mandatory MFA for owners is the shipped default (DECISIONS.md A15), so owners enrol TOTP at `/app/mfa/enroll` on first sign-in. For local convenience only, `SEED_RELAX_MFA=1 pnpm db:seed` switches `admin_mfa_policy.mandatory_mfa_enabled` **off** in the local database and says so loudly; running the seed again without the flag switches it back on.

### Tests against local Supabase

```bash
eval "$(pnpm exec supabase status -o env)"
export INTEGRATION_SUPABASE_URL=$API_URL INTEGRATION_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY INTEGRATION_SUPABASE_SECRET_KEY=$SECRET_KEY
export NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY SUPABASE_SECRET_KEY=$SECRET_KEY
pnpm exec supabase test db --local supabase/tests/database   # pgTAP
pnpm db:seed                                                 # garage hosts for the browser tests and Lighthouse
pnpm exec vitest run --config vitest.integration.config.ts   # PostgREST suites, incl. tests/integration/tenancy.test.ts (Gate 1)
pnpm build                                                   # with the env above: NEXT_PUBLIC_* are inlined at build time
pnpm test:e2e:smoke                                          # host routing against `pnpm start` (port 3430)
pnpm test:e2e:booking                                        # SOB wizard on http://hartley-road.localhost:3430/
pnpm test:e2e:local-invoicing                                # invoice PDF access (`pnpm dev`, port 3100)
CHROME_PATH=/path/to/chrome pnpm test:lighthouse             # mobile Lighthouse on http://hartley-road.localhost:3420/ (lighthouserc.cjs)
```

`PLAYWRIGHT_PORT`, `PLAYWRIGHT_INVOICE_PORT` and `LIGHTHOUSE_PORT` override the ports; `PLAYWRIGHT_CHROMIUM_EXECUTABLE` uses an already installed Chromium instead of `playwright install`. Garage-host specs (`smoke.spec.ts`, `booking.spec.ts`) run through `playwright.garage.config.ts`; the default `pnpm test:e2e` covers the admin host only. The tenancy suite needs a fixture for every table with `garage_id` (`FIXTURES` in `tests/integration/tenancy.test.ts`).

### CI on shared runners

Several self-hosted runners share one machine and one user, one job per runner at a time. Every CI job that starts Supabase or serves the app first runs `scripts/ci/supabase-isolate.sh` (a no-op unless `CI=true`): with N the trailing number of `$RUNNER_NAME` (0 if none) it sets `project_id = "autofix-ci-N"` in `supabase/config.toml`, shifts every port Supabase binds on the host (api, db, shadow, pooler, studio, mail, analytics, edge inspector) by `N*100`, and exports `SUPABASE_PROJECT_ID`, `SUPABASE_API_PORT`, `SUPABASE_DB_PORT`, `INTEGRATION_SUPABASE_URL`, `PLAYWRIGHT_PORT` (3400 + N\*10 + 1), `LIGHTHOUSE_PORT` (+2), `PLAYWRIGHT_SMOKE_PORT` (+3) and `PLAYWRIGHT_INVOICE_PORT` (+4). `scripts/ci/supabase-env.sh` then exports the stack's URL and keys (masked). Each job ends with `supabase stop --no-backup`. The test helper finds the database container as `supabase_db_<project_id>`.
