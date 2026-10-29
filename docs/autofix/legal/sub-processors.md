# Pitline sub-processors (internal list)

Kept by Vitalos and given to a garage on request (DPA v1.1 clause 7.1). Not shown in the DPA itself (Temitope, 29 Oct 2026). Update it, and give garages 30 days' notice, when a sub-processor is added or replaced.

| Sub-processor | Purpose | Location |
| --- | --- | --- |
| Supabase | Database, authentication, file storage | London, UK (provider is US-based) |
| Vercel | Application hosting and delivery | Global edge network (US-based) |
| Cloudflare | DNS | Global (US-based) |
| Resend | Transactional email | US / EU |
| Twilio | SMS, WhatsApp, voice | US / global |
| Sentry | Error monitoring (scrubbed) | US / EU |
| Vehicle Data Global | Vehicle details lookup | UK |
| Anthropic | AI processing for the optional AI front desk, only when the Garage turns it on | US |
| Stripe | Subscription billing, and the Garage's payments when it turns them on (deposits, invoices, Direct Debit) | US / EU |
| Microsoft Azure | Hosting of Vitalos's internal support tools (super admin) | UK South (provider is US-based) |
| Google | Business name and address lookup when a garage signs up (no customer data) | Global (US-based) |

DVLA and DVSA provide vehicle and MOT data as public bodies under their own terms; registrations are sent to them for lookups.
