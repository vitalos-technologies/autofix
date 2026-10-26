# Autofix

Multi-tenant garage booking platform by Vitalos (working name). Forked from SOB Autofix.

- Customers book on a phone-first page on the garage's own domain (`book.theirgarage.co.uk`) or the free link `<slug>.autofix.vitalos.co.uk`.
- Garages run their day at `autofix.vitalos.co.uk`: diary by bay, bookings, customers and cars, MOT and service reminders, missed-call text-back, booking page and domain setup.
- Vitalos Workforce and Askbridge plug in through a garage-scoped agent API.

## Docs

- Spec: [`docs/autofix/SPEC.md`](docs/autofix/SPEC.md)
- Build plan: [`docs/autofix/BUILD-PLAN.md`](docs/autofix/BUILD-PLAN.md)
- Decisions: [`docs/autofix/DECISIONS.md`](docs/autofix/DECISIONS.md)
- Infrastructure: [`docs/autofix/INFRA.md`](docs/autofix/INFRA.md)
- Design: [`design/DESIGN.md`](design/DESIGN.md) · canvas https://claude.ai/artifact/UYRN7ayr8LpWS5U59221mP

## Local setup

```bash
pnpm install
cp .env.example .env.local
supabase start && supabase db reset && pnpm db:seed
pnpm dev
```

Admin: http://localhost:3000 · Demo booking site: http://hartley-road.localhost:3000

## Verify

```bash
pnpm verify
pnpm test:e2e
pnpm test:lighthouse
```
