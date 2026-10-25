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

## Waiting on Temitope

Agents: add items here instead of doing them. Each needs his explicit OK.

- [ ] Vercel Pro decision before the first paying garage (D13) (Hobby is non-commercial, 50 custom domains, daily crons only).
- [ ] Create Vercel project `autofix` (link `vitalos-technologies/autofix`) and attach `autofix.vitalos.co.uk` + `*.autofix.vitalos.co.uk` (see INFRA.md), plus a team-scoped `VERCEL_API_TOKEN` as a Sensitive env var.
- [ ] Supabase Free project `autofix` in London (no spend). Pro later, with approval.
- [ ] Twilio account, UK numbers, alphanumeric sender, WhatsApp sender (Temitope is creating these).
- [ ] DVLA VES and DVSA MOT History API keys (Temitope is applying).
- [ ] Stripe: Autofix product line and prices in the live account (Temitope); agents use test mode only.
- [ ] Solicitor review of `docs/autofix/legal/` before the first paying garage.
- [ ] First founding garage and its domain.
