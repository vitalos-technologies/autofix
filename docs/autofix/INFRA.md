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

Removed: `CALCOM_*`, `NEXT_PUBLIC_TAWK_*`, `NEXT_PUBLIC_GOOGLE_MAPS_URL`, `GOOGLE_PLACE_ID`, `ENQUIRY_*` single-business values (incl. `ENQUIRY_NOTIFICATION_EMAIL`), `ADMIN_EMAILS` (access is `garage_members`), `LEGAL_COPY_APPROVED`/`COOKIE_CONFIGURATION_APPROVED` (become per-platform flags).

Email (P1.3): `RESEND_FROM_EMAIL` is the platform sender address (the display name is replaced by the garage's name per message); `RESEND_REPLY_TO` is optional and only a fallback when a garage has no email; `ENQUIRY_REPLY_DOMAIN` (e.g. `reply.autofix.vitalos.co.uk`) carries enquiry reply tokens.

Added: see `.autofix/env.autofix.example` (appended to `.env.example` by `/bootstrap`).
