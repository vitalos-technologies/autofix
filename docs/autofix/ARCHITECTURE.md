# Autofix architecture contract

Shared contract for the lane agents. SPEC.md says *what*; this file pins the names every lane codes against. Change it only together with the code.

## Tenancy in the database (P1.4, P1.5)

Core tables (migration `<ts>_tenancy.sql`):

| Table | Columns (beyond `id uuid pk`, `created_at`, `updated_at`) |
| --- | --- |
| `garages` | `slug` (unique, `^[a-z0-9](-?[a-z0-9])*$`, 3–40), `name`, `legal_name`, `company_number`, `phone` (E.164), `whatsapp` (E.164), `email`, `address jsonb` (`line1`, `line2`, `town`, `postcode`), `timezone` default `Europe/London`, `logo_url`, `accent` default `#155fba` (`^#[0-9a-f]{6}$`), `plan` (`trial`/`growth`/`front_desk`), `mot_enabled` bool default false, `booking_prefix` (`^[A-Z]{2,4}$`), `slot_step_min` default 15, `approve_online` bool default false, `service_area text[]`, `cancellation_cutoff_h` default 24, `sms_sender` (≤ 11 chars), `status` (`onboarding`/`active`/`suspended`/`cancelled`), `settings jsonb`, `cancelled_at` |
| `garage_domains` | `garage_id`, `hostname` (unique, lower case), `kind` (`subdomain`/`custom`), `status` (`pending_dns`/`verifying`/`active`/`failed`), `verification jsonb`, `last_checked_at`, `error`, `deleted_at` |
| `garage_members` | `garage_id`, `user_id → auth.users`, `role` (`owner`/`manager`/`technician`), unique (`garage_id`, `user_id`) |
| `platform_admins` | `user_id` pk → `auth.users` |

SQL helpers (all `stable`, `security definer`, `search_path = ''`):

- `public.request_garage_id() → uuid`: the `x-garage-id` request header (PostgREST `request.headers`), or `null` if absent/invalid.
- `public.garage_role(p_garage_id uuid) → text`: `auth.uid()`'s role in that garage, or `null`.
- `public.current_garage_id() → uuid`: `request_garage_id()` when the caller is `service_role` or a member of it; otherwise `null`.
- `public.current_garage_role() → text`: role in `current_garage_id()`.
- `public.is_platform_admin() → boolean`.

Every tenant table: `garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade`, an index leading with `garage_id`, RLS on, and policies of the form `using (garage_id = (select public.current_garage_id()))` (+ `with check` on writes, + `(select public.current_garage_role()) = 'owner'` for owner-only actions). Child tables carry `garage_id` too and reference the parent through a composite FK `(garage_id, parent_id) → parent(garage_id, id)`. `anon` has no grants on tenant tables. Security-definer functions filter every statement by garage explicitly; they never trust a garage id that the caller could choose without checking membership.

## Tenancy in the app (P1.3, P1.7)

| Module | Exports |
| --- | --- |
| `src/lib/tenancy/hosts.ts` | `classifyHost(host, env?)` → `{ kind: "admin" } \| { kind: "subdomain", slug } \| { kind: "custom", hostname } \| { kind: "dev-garage", slug } \| { kind: "unknown" }` (pure, unit tested) |
| `src/lib/tenancy/resolve.ts` | `resolveGarageByHost(host)` → `GarageRecord \| null` (service role, 60 s in-memory cache) |
| `src/lib/tenancy/garage.ts` | `type Garage`, `getGarage()` (server: host → garage for public pages/routes, throws `notFound()` when unknown), `requireSiteGarage(garageId)` (checks the `/_site/[garageId]` param equals the host's garage) |
| `src/lib/tenancy/admin.ts` | `getAdminContext()` → `{ user, garage, role, memberships, client }` where `client` is the RLS client carrying `x-garage-id`; selected garage from the `af_garage` cookie validated against `garage_members`, defaulting to the first membership |
| `src/components/garage/garage-provider.tsx` | `GarageProvider` + `useGarage()` for client components (public fields only) |

Env: `NEXT_PUBLIC_ADMIN_HOST` (`autofix.vitalos.co.uk`), `NEXT_PUBLIC_TENANT_ROOT_DOMAIN` (`autofix.vitalos.co.uk`), `DEV_TENANT_ROOT_DOMAIN` (`localhost:3000`).

## Routes

| Host | Internal route |
| --- | --- |
| admin host (`autofix.vitalos.co.uk`, `localhost:3000`) | `/app/…` garage admin (was SOB `/admin`), `/admin/…` super admin (P4.5), `/signup`, `/api/…` |
| `<slug>.autofix.vitalos.co.uk`, verified custom host, `<slug>.localhost:3000`, `localhost:3000/?__garage=<slug>` (dev only) | `/_site/<garageId>/…` (folder `src/app/%5Fsite/[garageId]`); `/api/…` is not rewritten and resolves the garage from the host |
| unknown | 404 |

Booking flow on the garage host: `/` (vehicle), `/service`, `/time`, `/details`, `/confirmed/[reference]`, `/manage`, `/r/[token]`, `/privacy`, `/unsubscribe` (form), `/unsubscribe/[token]` (signed link, opts out on open) and `/unsubscribe/[token]/resumed`. Legal (P4.9): `src/lib/legal/*` (drafts embedded from `docs/autofix/legal/`, `renderPrivacyNotice`, `renderDpa`, `dpaTextHash`, `acceptDpaAction`), `src/lib/consent/*` (`unsubscribeUrl(garage, customerId)`, `optOutWithToken`, `optOutByPhone`, `resumeWithToken`), `src/components/legal/*` (`LegalDocumentBody`, `DraftFlag`, `DpaAcceptance`); admin `/app/settings/agreements`; SQL `garage_agreements`, `accept_garage_agreement()`, `opt_out_customer()`, `resume_customer_reminders()` (`20261028000300_dpa_acceptance.sql`).

Manage booking (P2.9): `/manage` shows the reference + registration form (server action, POST only) or, with an `af_manage` session, the booking; `/manage?token=…` (the email link) hands the token to the `/manage/link` route handler, which opens the session and answers 303 to `/manage`, so the token never stays in the address; `/manage/reschedule` (`?date=` only) and `/manage/cancel` change the session's booking through `rescheduleBooking()`/`cancelBooking()`; SOB's `/manage-booking` is a 308 to `/manage`. The only other query strings are `?link=invalid|limited|unavailable` and `?done=moved|cancelled`. Server code: `src/lib/booking-flow/manage-actions.ts` (server actions), `manage-server.ts` (session read/write, customer view, reschedule slots), `manage-view.ts` (client-safe states and wording). These pages always read the database (`BOOKING_ENGINE=fake` does not apply to them).

## Migrations

`supabase/migrations/20261026000000_baseline.sql` (SOB squash) then `20261026000100_tenancy.sql`, `20261026000200_tenancy_test_support.sql` (service-role-only, read-only catalogue helpers `tenancy_tables()`, `tenancy_policies()`, `tenancy_function_grants()`, `tenancy_fingerprint()`, `tenancy_sample_row()`, `tenancy_storage_fingerprint()` for the tenancy suite), `…_scheduling.sql` (P2.1), `…_reminders.sql` (P3.6), and later ones. Never edit a migration after it has shipped to a shared database.

**Every new table with `garage_id` needs an entry in `FIXTURES` in `tests/integration/tenancy.test.ts`** (how to create a row in a garage, and a harmless update probe); until it has one the Gate 1 suite fails with "no fixture for table <name>".

## Booking engine (Phase 2)

### Schema (`<ts>_scheduling.sql`, P2.1)

| Table | Columns (all tenant tables: `garage_id` as above) |
| --- | --- |
| `resources` | `name`, `kind` (`bay`/`mobile`/`technician`), `active` bool, `sort` int |
| `opening_hours` | `weekday` smallint (ISO 1 = Mon … 7 = Sun), `opens` time, `closes` time (`closes > opens`); several rows per weekday allowed (split day) |
| `closures` | `starts_on` date, `ends_on` date (inclusive, `>= starts_on`), `reason` |
| `services` | `name`, `description`, `duration_min`, `buffer_min`, `price_pence` (null for quote), `price_mode` (`fixed`/`from`/`quote`), `location_mode` (`workshop`/`mobile`/`both`), `resource_kind` (`bay`/`mobile`/`technician`), `online_enabled`, `needs_approval`, `min_notice_h` (default 2), `max_days_ahead` (default 60), `is_mot`, `sort`, `deleted_at`, `deleted_by`. `resource_kind` is the workshop resource; a mobile visit always takes a `mobile` resource, so `resource_kind = 'mobile'` exactly when `location_mode = 'mobile'` |
| `bookings` (reshaped) | `reference` (unique per garage), `customer_id`, `vehicle_id`, `service_id`, `resource_id`, `starts_at`, `ends_at` (customer-facing appointment), `during tstzrange` (what the resource is blocked for: travel before + duration + buffer + travel after), `status` (`requested`/`confirmed`/`arrived`/`in_progress`/`waiting_parts`/`ready`/`collected`/`cancelled`/`no_show`), `source` (`online`/`phone`/`walk_in`/`reminder`/`missed_call`/`ai_agent`), `location_mode` (`workshop`/`mobile`), `postcode`, `address`, `symptoms text[]`, `notes`, `idempotency_key` (unique per garage), `manage_token_hash`, `reminder_send_id` (FK added in P3.6), `price_pence` (snapshot), `cancelled_at` (kept in step with `status` by a trigger), `cancellation_reason`, `admin_seen_at`, `deleted_at`/`deleted_by` (admin trash). Constraint `no_overlap exclude using gist (resource_id with =, during with &&) where (status not in ('cancelled','no_show'))` |
| `booking_events` | `booking_id` (composite FK), `type` (`created`/`status_changed`/`rescheduled`/`cancelled`/`note`/`notification_sent`…), `actor` (`customer`/`staff`/`system`/`agent`), `actor_id`, `at`, `data jsonb` |
| `garages` (+) | `mobile_travel_min` int default 30 |
| `customers` (+) | `channel` (`sms`/`whatsapp`/`email`, default `sms`), `reminder_consent` bool default false, `consent_at`, `consent_source` (`booking`/`import`/`soft_opt_in`/`staff`), `consent_text` (exact wording agreed to, PECR record), `opted_out_at`; unique (`garage_id`, `phone`); `phone` is E.164 (checked), and null only for anonymised customers (retention no longer writes `'REDACTED'`) |
| `vehicles` (+) | `registration` normalised (upper case, no spaces), unique (`garage_id`, `registration`); `fuel` (SOB's `fuel_type`, renamed), `year`, `mot_expiry` date, `mot_checked_at`, `last_mileage`, `last_service_at`, `updated_at` |

Cal.com leftovers dropped: `provider_*` booking columns, `booking_service_types`, `service_catalogue_systems`, `provider_webhook_events`, `create_booking_intent()`, the `booking_status` enum (status is text with a check). SOB's `booking_audit_log` and `booking_notification_events` stay, re-pointed at the new `bookings`; `booking_events` supersedes `booking_audit_log` (drop it once nothing writes it).

Staff grants (RLS on top): setup tables (`resources`, `opening_hours`, `closures`, `services`) are read by every member and written by owners/managers; `bookings` select plus `update (status, notes, admin_seen_at, cancellation_reason)` only (moving or re-assigning a booking needs a server-side function); `booking_events` select plus inserting `type = 'note'`, `actor = 'staff'`, `actor_id = auth.uid()`. A trigger writes a `status_changed` (or `cancelled`) event for every status change, naming the member (`staff`) or `system`, so app code must not insert those itself.

### SQL (service-role only; `revoke … from public, anon, authenticated`)

- `available_slots(p_garage_id uuid, p_service_id uuid, p_from date, p_to date, p_location_mode text default null) returns table (starts_at timestamptz, ends_at timestamptz, free_count int)`. Dates are local dates in the garage's time zone (inclusive). Every candidate start is returned, `free_count = 0` means taken (the UI strikes it through). Starts are generated every `garages.slot_step_min` from each opening window's `opens` while `start + duration <= closes`, built as `(date + time) at time zone garages.timezone`; closures removed; starts before `now() + min_notice_h` or after `now() + max_days_ahead` dropped; `free_count` = active resources of `services.resource_kind` with no live booking overlapping the would-be `during`.
- `create_booking(p_garage_id uuid, p_booking jsonb) returns jsonb`. Input keys: `service_id`, `starts_at`, `location_mode`, `postcode`, `address`, `symptoms`, `notes`, `source`, `idempotency_key`, `manage_token_hash`, `reminder_send_id`, `customer {name, phone (E.164), email, channel (sms/whatsapp/email), reminder_consent bool, consent_source, consent_text}`, `vehicle {registration (normalised), make, model, colour, fuel, year, mot_expiry, last_mileage}`. One transaction: upsert customer by `(garage_id, phone)`, vehicle by `(garage_id, registration)`, pick the least-busy free resource of the kind for that day, insert, `booking_events` row, return `{booking_id, reference, status, starts_at, ends_at, customer_id, vehicle_id, replayed}`. Same idempotency key → the existing booking. Status `requested` if `services.needs_approval` or `garages.approve_online`, otherwise `confirmed` (`source = ai_agent` is always `requested`). Errors are raised with `errcode 'P0001'` and a message starting with a code: `SLOT_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `OUTSIDE_SERVICE_AREA`, `INVALID_BOOKING`. Reference: `booking_prefix || '-' || 4 random digits` (5–6 digits once a garage has used most 4-digit numbers), unique per garage.
- `seed_garage_defaults(p_garage_id uuid) returns jsonb` (service role): Mon–Fri 08:00–17:30 and Sat 08:30–13:00, Bays 1–3 + Mobile van, six services (MOT, Diagnostics, Full service, Interim service, Brakes, Something else; the MOT row is always created and stays unbookable until `mot_enabled`). Each group only when the garage has none; returns `{opening_hours, resources, services}` counts added. Reminder rules join in P3.6.

As built (P2.1–P2.3), in addition to the above:

- `available_slots` raises instead of returning nothing when the request cannot be served: `SERVICE_UNAVAILABLE` (unknown, deleted or offline service, another garage's service, MOT while `mot_enabled` is off, a location mode the service does not offer, garage not `onboarding`/`active`) and `INVALID_BOOKING` (missing dates, `p_from > p_to`, unknown location mode). `p_location_mode` null means mobile for mobile-only services and workshop otherwise. The date range is clamped to today .. `now() + max_days_ahead`. Starts step from each window's opening in real (UTC) time; for windows that do not span 01:00–02:00 local time this is the same as wall-clock steps on clock-change days.
- `create_booking` rules: `starts_at` must carry a UTC offset; `idempotency_key` is optional in SQL (the API always sends one) and is checked before anything else, so a retry gets its booking even after the slot has closed. Error precedence: `INVALID_BOOKING` for malformed input, then `SERVICE_UNAVAILABLE`, then `OUTSIDE_SERVICE_AREA` (outward code of the normalised postcode against `garages.service_area`), then `INVALID_BOOKING` for a start that is not an opening-window start on the slot step, then `SLOT_UNAVAILABLE` for a closure day, notice/max window, or no free resource. Consent: only when `reminder_consent` is true and the customer has no consent on record are `consent_at`, `consent_source` (default `booking`) and `consent_text` written together; an existing consent record and `opted_out_at` are never changed. A matched vehicle moves to the booking's customer. Created events: `actor` is `agent` for `ai_agent`, `staff` for `phone`/`walk_in`, otherwise `customer`. Allocation per garage is serialised by a transaction-level advisory lock; the `no_overlap` retry still covers other writers. `reminder_send_id` is stored only once `reminder_sends` exists and the row belongs to the garage (P3.6).
- Clock-injectable internals for tests, granted to no API role: `available_slots_at(…, p_now timestamptz)` and `create_booking_at(p_garage_id, p_booking, p_now timestamptz)`; the public functions call them with `now()`.
- `manage_admin_trash` entities are now `enquiries`, `bookings`, `invoices`, `services` (`catalogue_systems`/`catalogue_services` are gone). Only `cancelled`, `no_show` or `collected` bookings can be trashed, because a live booking keeps its resource.

### App

| Module | Exports |
| --- | --- |
| `src/lib/booking-engine/repository.ts` | `listOnlineServices(garageId)`, `getAvailableSlots({garageId, serviceId, from, to, locationMode})` (30 s in-memory cache keyed by all args, cleared on create), `createBooking(garageId, input)` → `{ok: true, booking} \| {ok: false, code, alternatives?}` (on `SLOT_UNAVAILABLE` returns the 3 nearest free slots) |
| `src/lib/booking-engine/state.ts` | Booking flow cookie `af_booking`: AES-256-GCM sealed (key from `BOOKING_STATE_SECRET`, falls back to `BOOKING_MANAGEMENT_SECRET`), httpOnly, `SameSite=Lax`, `Secure` in production, 2 h, bound to the garage id. Holds vehicle, service, location mode, postcode, symptoms, note, chosen start |
| `src/lib/booking-engine/manage.ts` | Manage tokens (HMAC, stored hashed), lookup by reference + registration (POST body, never the URL), reschedule/cancel with the garage's cancellation cutoff. Token = `HMAC-SHA-256(BOOKING_MANAGEMENT_SECRET, "booking-manage-link:v1:<garage_id>:<idempotency_key>")` base64url (43 chars), stored as hex SHA-256 in `manage_token_hash`, link `/manage?token=…`; `af_manage` session cookie (signed, httpOnly, 30 min, garage + booking id). Reschedule shifts `during` by the move (keeps travel/buffer), keeps the resource when free else another active one of its kind, writes `booking_events` |
| `src/lib/booking-engine/notify.ts`, `src/lib/bookings/notifications.ts` | `notifyBooking({type: created/rescheduled/cancelled, garageId, bookingId})` after each change (`after()`; a `notifications.booking` job once P3.7 lands): customer email + `.ics`, staff alert, SMS/WhatsApp on the customer's channel (opt-out re-checked), reserved in `booking_notification_events`, logged as `booking_events` `notification_sent` |

Routes (garage from host): `GET /api/services`, `GET /api/slots?service=&from=&to=&mode=` (no registration in the query), `POST /api/bookings` (JSON body; Turnstile; rate limit per IP and per garage; idempotency key; 409 `{code: "SLOT_UNAVAILABLE", alternatives: [...]}`), `GET /api/bookings/manage?token=` (signed link), `POST /api/bookings/manage` (reference + registration → sets a 30-minute manage cookie), `PATCH /api/bookings/manage` (`{action: "cancel"} \| {action: "reschedule", startsAt}`). The 5 booking pages use server actions that read/write `af_booking` and call the same repository. Bodies are strict JSON (a `garageId`, `source` or `reminderSendId` in the body is a 422); errors are `{code, message, alternatives?, issues?}`. Statuses: services 200/404/503; slots 200/404/422/429/503 (max 14 local days); bookings 201 created/200 replay/400/403 Turnstile/404/409/415/422/429/503; manage GET 200/401/404/429/503, POST 200/404/422/429/503, PATCH 200/401/404/409/422/429/503.

## Admin, reminders and jobs (Phase 3)

### Schema (`<ts>_reminders.sql`, P3.6)

| Table | Columns |
| --- | --- |
| `reminder_rules` (tenant) | `kind` (`mot`/`service`/`review`/`missed_call`), `enabled`, `offset_days int[]` (MOT `{28,7}` before expiry; service `{335}` after last service; review `{1}` after collection), `channel` (`sms`/`whatsapp`/`email`/`customer` = the customer's preferred channel), `template` text, unique (`garage_id`, `kind`). Defaults inserted by `seed_garage_defaults(p_garage_id)` (also seeds opening hours, services, resources at sign-up) |
| `reminder_sends` (tenant) | `rule_id`, `vehicle_id`, `customer_id`, `kind`, `due_date`, `offset_days`, `send_at`, `channel`, `status` (`scheduled`/`sending`/`sent`/`delivered`/`failed`/`cancelled`/`skipped`), `skip_reason`, `provider_msg_id`, `link_token_hash`, `link_expires_at`, `opened_at`, `booking_id`, `body` (rendered), `sent_at`; unique (`garage_id`, `vehicle_id`, `kind`, `due_date`, `offset_days`) so scheduling is idempotent |
| `messages` (tenant) | `customer_id`, `channel`, `direction` (`inbound`/`outbound`), `to_address`, `from_address`, `body`, `provider`, `provider_msg_id` (unique when set), `status`, `reminder_send_id`, `booking_id`, `call_id`, `error_code` |
| `calls` (tenant) | `provider_call_sid` (unique), `from_number`, `to_number`, `status`, `missed` bool, `voicemail_url`, `duration_s`, `text_back_message_id`, `handled_at`, `handled_by` |
| `garage_phone_numbers` (tenant) | `number` E.164 unique, `purpose` (`forwarding`), `provider_sid` — maps Twilio's called number → garage |
| `jobs` (platform, service role only) | `kind`, `garage_id` (nullable), `payload jsonb`, `dedupe_key` (unique when set), `run_at`, `status` (`queued`/`running`/`done`/`failed`), `attempts`, `max_attempts` default 5, `locked_until`, `last_error` |
| `vehicle_facts` (platform, service role only) | `reg_hash` pk (HMAC-SHA-256 of the normalised reg with `VEHICLE_FACTS_PEPPER`), `facts jsonb`, `fetched_at` — no customer data |

SQL: `claim_jobs(p_kind text, p_limit int) returns setof jobs` (`for update skip locked`; sets `status = running`, `locked_until = now() + interval '5 minutes'`, `attempts + 1`; re-claims rows whose lock expired), `finish_job(p_id uuid)`, `fail_job(p_id uuid, p_error text)` (exponential backoff `2^attempts` minutes, `failed` after `max_attempts`). `create_booking` gains attribution: when `reminder_send_id` is given and belongs to the garage, `source = reminder` and `reminder_sends.booking_id` is set in the same transaction. `reminder_won_back(p_garage_id, p_from, p_to)` → bookings + pence credited (invoice total when an invoice links to the booking, else `bookings.price_pence`).

### App

| Module | Exports |
| --- | --- |
| `src/lib/messaging/channel.ts` | `interface MessageChannel { kind; send(message): Promise<SendResult> }`, `getChannel(kind)` (mock unless `MESSAGING_MODE=live`), `renderTemplate(template, vars)` (`{first_name}`, `{vehicle}`, `{reg}`, `{due_date}`, `{link}`, `{garage}`; always ends "Reply STOP to opt out" for SMS/WhatsApp), `smsSegments(body)` |
| `src/lib/messaging/twilio.ts` | SMS + WhatsApp adapters, `verifyTwilioSignature(url, params, signature, authToken)` |
| `src/lib/messaging/quiet-hours.ts` | `isWithinSendWindow(at, timezone)` (09:00–19:00 Mon–Sat), `nextSendWindow(at, timezone)` |
| `src/lib/jobs/*` | `enqueueJob(kind, payload, {runAt, dedupeKey, garageId})`, `drainJobs({kinds, budgetMs})`, handler registry: `reminders.schedule`, `reminders.send`, `mot.refresh`, `domains.check`, `retention`, `notifications.booking` |
| `src/lib/reminders/*` | scheduling (rules × vehicles → `reminder_sends`), sending (consent + opt-out re-check, quiet hours, render, token), link tokens (`/r/{token}`: 32 random bytes base64url, SHA-256 hash stored, 30-day expiry) |

Routes: `GET /api/cron/[job]` (`Authorization: Bearer CRON_SECRET`; enqueues then drains for up to 20 s — Vercel Hobby only runs daily crons), `POST /api/jobs/drain` (same secret), `POST /api/webhooks/twilio/{sms,whatsapp,status,voice}` (signature on the raw body, `webhook_events` first), `GET /r/[token]` on the garage host. Admin pages on the admin host under `/app`: `/app` (Today), `/app/diary`, `/app/bookings`, `/app/bookings/[id]`, `/app/customers`, `/app/customers/[id]`, `/app/customers/import`, `/app/reminders`, `/app/messages`, `/app/settings/{services,hours,resources,branding,booking-page,team}`.
