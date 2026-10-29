# Askbridge on Autofix booking pages (P4.6)

Askbridge by Vitalos is an AI chat that a business adds to its website with one script tag. Autofix lets a garage show its own Askbridge chat on its booking pages. This file describes what Askbridge actually ships, checked against the Askbridge repo (`apps/widget/src/loader.ts`, `docs/architecture/widget.md`, `packages/db/migrations/0002_core.sql`) and approved by Temitope on 29 Oct 2026.

Two facts shape the whole integration:

1. **Each garage brings its own Askbridge workspace.** The garage signs up at askbridge.vitalos.co.uk, adds its booking page addresses as allowed websites, and copies its site key into Autofix. Autofix holds no Askbridge account, token or secret.
2. **Askbridge learns by crawling the business's website** (and from files and FAQs added in its dashboard). There is no partner API to push knowledge, so Autofix sends Askbridge nothing. What the chat knows, how it looks and what it says first are all set in the garage's Askbridge workspace.

Bookings never go through Askbridge: customers book on the booking page as usual. Agents that book on a caller's behalf use the agent tool API (`docs/autofix/agent-api.yaml`), which Askbridge does not call.

## The embed

Askbridge's install snippet:

```html
<script src="https://askbridge.vitalos.co.uk/widget/v1/askbridge.js" data-site="pk_…" async></script>
```

- `data-site` (required): the site key. The loader sends it on every call as `x-askbridge-site`.
- `data-api` (optional): base URL of Askbridge's API. Autofix does not set it, so the loader calls the API on the script's own origin.
- Nothing else is read from the tag. Theme, launcher label, logo, greeting, suggested questions, team status and the bot check all come from `GET /api/v1/visitor/config?site=pk_…` on Askbridge's side.
- The loader draws a 56 px launcher in a shadow root on a zero-size host element, `position: fixed`, so nothing on the page moves. The panel (`panel.js`, same directory) loads on first intent. The only global is `window.Askbridge`.
- If the config call fails (unknown or retired key, page origin not in the workspace's allowed websites, API down), nothing is shown and a warning goes to the console.

### How Autofix renders it

`src/app/%5Fsite/[garageId]/layout.tsx` renders `AskbridgeWidget` (`src/components/askbridge/askbridge-widget.tsx`) on every page of a garage host when the garage has the chat on with a valid site key and the loader URL is valid. Admin pages never load it.

```tsx
<Script id="askbridge-widget" src={loaderUrl} strategy="lazyOnload" async data-site={siteKey} />
```

`next/script` with `lazyOnload` adds the tag after the page's `load` event, when the browser is idle, so the chat is never on the critical path. The resulting element is the install snippet plus `id="askbridge-widget"` and Next's own `data-nscript` marker, which Askbridge ignores. The loader finds its tag through `document.currentScript`.

### Loader URL

| Where | Name | What |
| --- | --- | --- |
| Vercel env (public, optional) | `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL` | Overrides the loader URL. Unset or empty: `https://askbridge.vitalos.co.uk/widget/v1/askbridge.js`. Must be https, except an `http://127.0.0.1`/`localhost` stub anywhere but a Vercel production deployment. A value that is set but invalid hides the chat (it never falls back) and shows a notice on the settings page. |

There are no Askbridge secrets. `getAskbridgeEnvironmentReadiness()` (`src/lib/env.ts`) is ready unless the override is invalid; `/api/health` reports `checks.askbridge` as `configured` or `not_configured`. Askbridge never blocks launch.

## The garage setting

Stored in `garages.settings.askbridge` as `{ "enabled": boolean, "siteKey": string | null }`. Only the owner changes it, at `/app/settings/booking-page` (panel "Askbridge chat"), through `set_booking_page_settings(p_embed_origins, p_askbridge)`, which refuses anything else with `22023`:

- `siteKey` matches `^pk_[0-9a-f]{32}$` exactly (Askbridge generates `'pk_' || replace(gen_random_uuid()::text, '-', '')`). The form trims spaces and refuses anything else, including the whole snippet.
- `enabled: true` needs a key. Turning the chat off keeps the key.
- No other keys. The old `widgetId` shape is refused.

`askbridgeFromSettings()` (`src/lib/askbridge/config.ts`) re-validates on read: the chat is on only with `enabled === true` and a valid key. The site key is public (it is in every booking page's HTML), so the audit entries `askbridge.enabled` and `askbridge.disabled` record it.

The settings panel walks the owner through it:

1. Create a workspace at askbridge.vitalos.co.uk.
2. Add the booking page addresses as allowed websites. The panel lists the garage's own: the free link (`https://<slug>.autofix.vitalos.co.uk`) and, once one is connected, its own address (`https://book.theirgarage.co.uk`). Askbridge matches exact origins and has no wildcards, so each address goes in separately.
3. Paste the site key.

Plans: the chat is part of Essentials (D17), so every plan can turn it on. The garage's Askbridge subscription is between the garage and Askbridge.

## Content-Security-Policy

The booking host's CSP is set per garage in `src/proxy.ts`, built by `bookingSiteCsp()` in `src/lib/booking-page/security-headers.ts`. For a garage with the chat on, the loader URL's origin is added to:

- `script-src`: the loader and its panel, same directory;
- `connect-src`: the visitor API (config, conversations, streamed answers, polling), on the same origin because Autofix sets no `data-api`.

Everything else the widget needs is already allowed on every booking page:

- Cloudflare Turnstile (`https://challenges.cloudflare.com`) in `script-src`, `connect-src` and `frame-src`, which Askbridge loads when its bot check is on. Its challenge is the widget's only frame;
- `img-src https:` for the workspace logo on the launcher;
- `style-src 'unsafe-inline'` for the `<style>` elements and inline styles the widget creates.

`frame-src` does not get the Askbridge origin: the widget draws in a shadow root, not a frame. A garage with the chat off gets no Askbridge origin at all.

## Local stub and checks

- `node scripts/askbridge-widget-stub.mjs` serves `/widget/v1/askbridge.js` and `/api/v1/visitor/config` on `http://127.0.0.1:4100` with the real loader's shape (reads `data-site`, fetches the config from its own origin, draws a launcher in a shadow root). Build with `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL=http://127.0.0.1:4100/widget/v1/askbridge.js` to use it.
- `pnpm test:lighthouse:askbridge` turns the chat on for hartley-road, runs the stub and Lighthouse (reports in `output/lighthouse-askbridge/`).
- `pnpm test:e2e:booking-page` saves a site key, then loads the booking page with the loader and its config call answered by the test (never the real Askbridge) and checks `data-site`, `async`, the CSP and that the loader could run and call its API.
- Unit: `src/__tests__/askbridge.test.ts` (key format, setting, loader URL, allowed addresses, readiness), `askbridge-widget.test.tsx` (the tag), `booking-page-embed.test.ts` (CSP). pgTAP: `supabase/tests/database/022_domains_askbridge.test.sql`.

## What was removed (29 Oct 2026)

The first version of this file defined a contract Askbridge never had: a `data-widget-id`/`data-garage-name`/`data-accent`/`data-booking-url` tag and a knowledge sync (job `askbridge.sync`, payload `autofix.askbridge.knowledge.v1`, `Autofix-Signature` HMAC, `ASKBRIDGE_SYNC_URL`, `ASKBRIDGE_WEBHOOK_SECRET`). Migration `20261029001300_askbridge_site_key.sql` dropped the triggers and functions that queued the sync, closed any sync job still queued or running as failed, and moved a stored `widgetId` that was already a valid site key to `siteKey`. The `jobs` table has no list of kinds, so `askbridge.sync` is simply unused. Remove `ASKBRIDGE_SYNC_URL` and `ASKBRIDGE_WEBHOOK_SECRET` from Vercel and the GitHub repository settings if they were ever set; nothing reads them.

## Open with Askbridge

- When a garage turns the chat off or leaves Autofix, its Askbridge workspace carries on (Autofix just stops loading the loader). Whether to tell the garage to cancel Askbridge separately is a product decision.
- If Askbridge later offers a partner API (provisioning a workspace, or pushing services and opening hours), this integration can grow into it. Until then the booking page should be crawlable for Askbridge to learn from it.
