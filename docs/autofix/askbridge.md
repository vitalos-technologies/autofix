# Askbridge ↔ Autofix contract (P4.6)

Askbridge is Vitalos's AI front desk (hosted on Vercel). On a garage's booking pages it shows a chat that answers questions about the garage and sends customers to book. There is no Askbridge API document in this repo, so this file **defines the contract Autofix implements**. Until Askbridge confirms it (DECISIONS "Waiting on Temitope"), Autofix runs against a local stub and the mock outbox.

Two parts:

1. **Widget**: a script Autofix loads on garage booking pages when the garage owner turns the chat on.
2. **Knowledge sync**: Autofix pushes each garage's profile and services to Askbridge by signed webhook whenever they change.

Bookings themselves never go through Askbridge: the chat links to the booking flow, and agents that book on a caller's behalf use the agent tool API (`docs/autofix/agent-api.yaml`, `create_booking` → always `requested`).

## Configuration

| Where | Name | What |
| --- | --- | --- |
| Vercel env (public) | `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL` | Widget script URL, `https://…/widget.js`. Unset = no garage shows the chat. `http://127.0.0.1:<port>/…` is accepted everywhere except a Vercel production deployment (local stub). |
| Vercel env (server, Sensitive) | `ASKBRIDGE_SYNC_URL` | Where knowledge syncs are `POST`ed (https in production). |
| Vercel env (server, Sensitive) | `ASKBRIDGE_WEBHOOK_SECRET` | HMAC-SHA-256 key for the signature header (32+ random characters, shared with Askbridge). |
| Per garage | `garages.settings.askbridge` | `{ "enabled": boolean, "widgetId": string \| null }`. Set by the owner at `/app/settings/booking-page` through `set_booking_page_settings(p_embed_origins, p_askbridge)`. `widgetId` matches `^[A-Za-z0-9_-]{4,64}$`; `enabled` needs an id. |

Readiness: `getAskbridgeEnvironmentReadiness()` (`src/lib/env.ts`) and `/api/health` → `checks.askbridge` (`configured`/`not_configured`). Askbridge is optional: missing values never block launch.

## 1. Widget

Rendered by `src/app/%5Fsite/[garageId]/layout.tsx` → `AskbridgeWidget` (`src/components/askbridge/askbridge-widget.tsx`) only when the garage has `askbridge.enabled` with a widget id **and** the platform has a valid script URL. Admin pages never load it.

```html
<script id="askbridge-widget" src="$NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL"
  data-widget-id="wid_…" data-garage-name="Hartley Road Motors" data-accent="#155fba" data-booking-url="/"></script>
```

- Loaded with `next/script` `strategy="lazyOnload"`: after the page's `load` event, when the browser is idle. Nothing on the critical path.
- The widget must read its configuration from that tag's `data-*` attributes (`document.getElementById("askbridge-widget").dataset`), draw only `position: fixed` UI (so nothing on the page moves, CLS 0), and keep its launcher at least 44 px with 4.5:1 contrast and a text label.
- **Booking hand-off**: a chat that ends in a booking sends the customer to `data-booking-url` (`/`, the first booking step on the same garage host). Askbridge must **never put a registration, phone number or name in that URL** (CLAUDE.md rule 3). Prefill through the URL is not supported; the customer enters their registration on the booking page.
- **CSP**: the booking host's `Content-Security-Policy` (set in `src/proxy.ts`, built by `bookingSiteCsp()` in `src/lib/booking-page/security-headers.ts`) adds the widget script's origin to `script-src`, `connect-src` and `frame-src` only for garages with the chat on. The widget may load further scripts, frames and API calls **from that same origin only**; images may come from any https origin. Anything else is blocked.

Local stub: `node scripts/askbridge-widget-stub.mjs` serves a contract-following `widget.js` on `http://127.0.0.1:4100` (no network calls). Lighthouse with the widget on: `pnpm test:lighthouse:askbridge` (reports in `output/lighthouse-askbridge/`).

## 2. Knowledge sync

### When

Database triggers (`supabase/migrations/20261028000600_domains_askbridge.sql`) call `enqueue_askbridge_sync(garage_id)` after a change to:

- `garages`: name, slug, phone, WhatsApp, email, address, time zone, MOT on/off, approve-online, service area, cancellation cut-off, status, `settings.faqs`, `settings.askbridge`;
- `services`, `opening_hours`, `closures` (insert, update, delete);
- `garage_domains` status or retirement (the booking link changes when a custom domain goes live or is removed; `domains.check`'s 5-minute `last_checked_at` bumps do not count).

Only for garages that are `active`/`onboarding` with the chat on. Each call runs `enqueue_job('askbridge.sync', {"garageId": "<uuid>"}, <next minute>, 'askbridge.sync:<garage id>:<UTC minute>', <garage id>)`, so all changes inside one minute share one job that runs the minute after (debounce). Turning the chat on queues the first sync.

### Runner

The job runner (P3.7, `src/lib/jobs/*`) must register kind **`askbridge.sync`** with:

```ts
import { AskbridgeSyncError, runAskbridgeSync } from "@/lib/askbridge/sync";
// handler(job): await runAskbridgeSync(job.payload)
//   resolves → finish_job(id)
//   throws AskbridgeSyncError → fail_job(id, error.message, error.retryable)
```

Result: `{status: "sent", httpStatus, contentHash, idempotencyKey}`, `{status: "mocked", …}` (no `ASKBRIDGE_SYNC_URL`/secret outside production: the payload goes to an in-memory outbox, `askbridgeOutbox()`), or `{status: "skipped", reason: "garage_not_found" | "garage_inactive" | "askbridge_disabled"}`. In production without configuration it throws a retryable error (the job backs off 2, 4, 8, 16 min, then fails).

### Request

```
POST $ASKBRIDGE_SYNC_URL
Content-Type: application/json
Idempotency-Key: askbridge-sync:<garage id>:<first 32 hex of contentHash>
Autofix-Signature: t=<unix seconds>,v1=<hex HMAC-SHA-256(ASKBRIDGE_WEBHOOK_SECRET, "<t>.<raw body>")>
User-Agent: Autofix-Askbridge-Sync/1
```

```jsonc
{
  "schema": "autofix.askbridge.knowledge.v1",
  "event": "knowledge.sync",
  "garageId": "uuid",             // Autofix garage id (stable)
  "widgetId": "wid_…",            // the owner's Askbridge widget id
  "contentHash": "64 hex",        // SHA-256 of {widgetId, profile, services}; same content → same hash
  "generatedAt": "2026-10-27T10:00:00.000Z",
  "profile": { … },               // exactly the agent API's garage_profile response (agent-api.yaml: GarageProfile)
  "services": [ … ]               // exactly the agent API's list_services items (agent-api.yaml: Service), bookable online only
}
```

`profile` is built by `agentGarageProfile()` and `services` by `agentService()` (`src/lib/agent-api/handler.ts`), the same builders the agent tool API uses: garage name, contact details, address, time zone, booking URL, MOT on/off, opening hours, upcoming closures, policies, FAQs; services with duration and price text. **No customer, vehicle or booking data is ever sent.**

### What Askbridge must do

- Verify the signature (reject if `|now − t| > 300 s` or the HMAC differs; constant-time compare). Reference: `verifyAskbridgeSignature()` in `src/lib/askbridge/sync.ts`.
- Treat the request as a full replacement of that widget's knowledge (not a patch).
- Answer `2xx` when stored; `409` when it already has that `Idempotency-Key` (Autofix treats it as sent).
- `408`, `425`, `429`, `5xx` or no answer within 10 s → Autofix retries with backoff. Any other `4xx` → no retry (the job fails and shows in job queue health).
- Redirects are not followed.

## Open questions for Askbridge (Waiting on Temitope)

- Confirm or change: widget script URL and `data-*` attributes, sync endpoint, header names, signature scheme, payload (`autofix.askbridge.knowledge.v1`).
- How a garage gets its widget id (Askbridge account per garage, or provisioned by Autofix via an API).
- Whether Askbridge wants a delete/disable event when a garage turns the chat off or is cancelled (today Autofix just stops syncing and stops loading the widget).
