# Decisions

## Made

| # | Date | Decision | Notes |
| --- | --- | --- | --- |
| D1 | 25 Oct 2026 | Build a multi-tenant garage booking product by replicating SOB Autofix, keeping its design language with tweaks | Booking frontend, garage admin, backend engine |
| D2 | 25 Oct 2026 | Garages manage everything at `autofix.vitalos.co.uk`; customer pages are phone-first | |
| D3 | 25 Oct 2026 | Garages point a subdomain of their own domain (e.g. `book.theirgarage.co.uk`) at the platform; free fallback `<slug>.autofix.vitalos.co.uk` | DNS for `autofix` + wildcard approved and live |
| D4 | 25 Oct 2026 | Customer domains handled by Vercel's custom-domain API (Vercel for Platforms), not Cloudflare for SaaS | Apps already on Vercel; Cloudflare is DNS-only |
| D5 | 25 Oct 2026 | Native scheduling engine replaces Cal.com | See SPEC |
| D6 | 25 Oct 2026 | 5-step booking flow; design canvas is the UI reference | https://claude.ai/artifact/UYRN7ayr8LpWS5U59221mP |
| D7 | 25 Oct 2026 | Backend home: fork SOB onto Supabase (not the Workforce backend) | Confirmed by Temitope |
| D8 | 25 Oct 2026 | Repo: `vitalos-technologies/autofix` (private), the org that holds `workforce` | Created 25 Oct 2026, empty, default branch set by first push |
| D9 | 25 Oct 2026 | No spend on Supabase for now: Free plan project in London (no point-in-time recovery; pauses after 7 days idle) | Upgrade later with approval |
| D10 | 25 Oct 2026 | Temitope creates the Twilio account and senders, applies for DVLA VES and DVSA MOT History keys, and creates the Autofix product line in the live Stripe account | Agents build against mocks until keys are bound |
| D12 | 25 Oct 2026 | Keep "Autofix" as the working name for now | Revisit before public launch |
| D13 | 25 Oct 2026 | Stay on Vercel Hobby during the build; decide on Vercel Pro before the first paying garage | Spend; needs Temitope's OK at that point |
| D11 | 25 Oct 2026 | Legal drafts (DPA template, customer privacy notice, PECR reminder wording) are written in `docs/autofix/legal/` for review | Drafts, not legal advice |

## Assumed (proceed on these unless Temitope changes them)

| # | Assumption | Change cost |
| --- | --- | --- |
| A4 | Twilio for SMS, WhatsApp and voice | Medium (behind `MessageChannel`) |
| A5 | Node 22, pnpm 10.12.1, Next 16, React 19, Tailwind 4 as in SOB | |
| A6 | **Garage context in the database.** Admin requests send the member's selected garage to PostgREST as the `x-garage-id` header. `public.current_garage_id()` returns it only if `auth.uid()` is a member of that garage (or the caller is `service_role`), else `null`. Tenant RLS policies are `garage_id = (select public.current_garage_id())`, so a multi-garage user only ever sees the selected garage and a forged header yields zero rows. Tenant `garage_id` columns default to `current_garage_id()` | Low; one helper |
| A7 | Garage admin moves from SOB's `/admin` to `/app` on the admin host; `/admin` is reserved for the Vitalos super admin (P4.5) | Low |
| A8 | Garage booking sites render from `src/app/%5Fsite/[garageId]/…` (URL `/_site/<garageId>/…`, `%5F` because `_folders` are private in the App Router). Only reachable through the proxy rewrite; direct requests to `/_site` return 404 | Low |
| A9 | Migrations: one squashed SOB baseline (SOB-only surfaces removed in P1.1 are left out) plus timestamped Autofix migrations (`<ts>_tenancy.sql`, `<ts>_scheduling.sql`, …). SOB's 30 migrations stay in git history only | Low |
| A10 | Platform-level tables with no garage owner at write time (`rate_limit_buckets`, inbound/Resend webhook idempotency tables, `unmatched_inbound_emails`, MFA/trusted-device tables keyed by user) have no `garage_id`; they are service-role or own-user only, and the tenancy suite asserts staff cannot read them | Low |
| A11 | Customer phone keeps SOB's column name `customers.phone` (E.164) rather than the SPEC's `mobile` to avoid churn; same meaning | Low |
| A12 | Work is committed on the session branch `claude/modest-mayer-9yzmr0` (task commits prefixed with the task ID) rather than merged straight to `main`, because `main` changes need a reviewed PR | Low |
| A13 | **Opt-out and sender IDs.** UK alphanumeric senders (e.g. `HartleyRd`) are one-way, so a customer cannot reply STOP to them. Reminders and other messages that promise "Reply STOP" go from the garage's two-way Twilio number (Messaging Service). A garage may use its alphanumeric sender for booking updates only, and those messages end with an opt-out link (`/unsubscribe`) instead of "Reply STOP" | Low; needs the PECR wording review already on the list |
| A14 | Twilio has no idempotency key: the engine claims the `reminder_sends`/`messages` row before calling `send()` and treats timeouts as ambiguous (not retried automatically) | Low |
| A15 | MFA stays enforced in the database for invoice and trash RPCs (AAL2 when the user has TOTP; owners must enrol while mandatory MFA is on, the shipped default). Plain table reads follow membership only, so the app keeps its MFA gate before handing out the RLS client. Trusted-device sessions can read but not call invoice RPCs (as SOB) | Low |
| A16 | `garage_domains.hostname` is unique among non-deleted rows, so a removed domain can be connected again later | Low |
| A17 | Retention no longer anonymises customers who still have bookings or invoices (SOB's job did on its next run). Retention removes storage rows directly; switch to the Storage API in P3.7 so files are deleted too | Low |
| A18 | Invoice numbers are `<booking_prefix>-YYYY-NNNNNN` per garage; invoice issuer details are copied from the garage when a draft is saved/issued | Low |

## Waiting on Temitope

Agents: add items here instead of doing them. Each needs his explicit OK.

- [ ] Vercel Pro decision before the first paying garage (D13) (Hobby is non-commercial, 50 custom domains, daily crons only).
- [ ] Create Vercel project `autofix` (link `vitalos-technologies/autofix`) and attach `autofix.vitalos.co.uk` + `*.autofix.vitalos.co.uk` (see INFRA.md), plus a team-scoped `VERCEL_API_TOKEN` as a Sensitive env var. With it, set `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` and `VERCEL_DOMAINS_MODE=live` (P1.8); until then production reports the domains integration as "configuration required" instead of using the mock.
- [ ] Supabase Free project `autofix` in London (no spend). Pro later, with approval.
- [ ] Twilio account, UK numbers, alphanumeric sender, WhatsApp sender (Temitope is creating these).
- [ ] DVLA VES and DVSA MOT History API keys (Temitope is applying).
- [ ] Stripe: Autofix product line and prices in the live account (Temitope); agents use test mode only.
- [ ] Solicitor review of `docs/autofix/legal/` before the first paying garage.
- [ ] First founding garage and its domain.
- [ ] **GitHub Actions never starts a runner on this repo.** Every CI run since the bootstrap PR (runs 1–9, 26 Oct 2026) fails in ~3 s with no runner assigned and no logs, which points to an org-level Actions setting or billing/spending limit for private repos in `vitalos-technologies`. Please check Organization settings → Billing (Actions minutes / spending limit / payment method) and Settings → Actions → General (Actions enabled for this repo). Until then, gates are proven with the same commands run locally against Docker Supabase (evidence in the build log).
