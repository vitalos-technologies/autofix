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
| SOB Autofix | Vercel project `sobautofix` (separate team), Supabase, Cal.com | Source of the fork; keep running unchanged |

## To create (needs Temitope's OK where marked)

1. **Vercel project `autofix`** in the Vitalos team, linked to the GitHub repo. Framework Next.js, Node 22.
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

Removed: `CALCOM_*`, `NEXT_PUBLIC_TAWK_*`, `NEXT_PUBLIC_GOOGLE_MAPS_URL`, `GOOGLE_PLACE_ID`, `ENQUIRY_*` single-business values, `LEGAL_COPY_APPROVED`/`COOKIE_CONFIGURATION_APPROVED` (become per-platform flags).

Added: see `.autofix/env.autofix.example` (appended to `.env.example` by `/bootstrap`).

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
