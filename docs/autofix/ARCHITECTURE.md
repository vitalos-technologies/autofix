# Autofix architecture contract

Shared contract for the lane agents. SPEC.md says *what*; this file pins the names every lane codes against. Change it only together with the code.

## Tenancy in the database (P1.4, P1.5)

Core tables (migration `<ts>_tenancy.sql`):

| Table | Columns (beyond `id uuid pk`, `created_at`, `updated_at`) |
| --- | --- |
| `garages` | `slug` (unique, `^[a-z0-9](-?[a-z0-9])*$`, 3–40), `name`, `legal_name`, `company_number`, `phone` (E.164), `whatsapp` (E.164), `email`, `address jsonb` (`line1`, `line2`, `town`, `postcode`), `timezone` default `Europe/London`, `logo_url`, `accent` default `#155fba` (`^#[0-9a-f]{6}$`), `plan` (`essentials`/`pro` since P5.2, default `pro`; **changed in Phase 5, see "Plans and entitlements"**), `trial_ends_at` (default now + 14 days), `plan_chosen` (`essentials`/`pro`/null), `plan_changed_at`, `mot_enabled` bool default false, `booking_prefix` (`^[A-Z]{2,4}$`), `slot_step_min` default 15, `approve_online` bool default false, `service_area text[]`, `cancellation_cutoff_h` default 24, `sms_sender` (≤ 11 chars), `status` (`onboarding`/`active`/`suspended`/`cancelled`), `settings jsonb`, `cancelled_at` |
| `garage_domains` | `garage_id`, `hostname` (unique, lower case), `kind` (`subdomain`/`custom`), `status` (`pending_dns`/`verifying`/`active`/`failed`), `verification jsonb`, `last_checked_at`, `error`, `deleted_at` |
| `garage_members` | `garage_id`, `user_id → auth.users`, `role` (`owner`/`manager`/`technician`), unique (`garage_id`, `user_id`) |
| `platform_admins` | `user_id` pk → `auth.users` |

SQL helpers (all `stable`, `security definer`, `search_path = ''`):

- `public.request_garage_id() → uuid`: the `x-garage-id` request header (PostgREST `request.headers`), or `null` if absent/invalid.
- `public.garage_role(p_garage_id uuid) → text`: `auth.uid()`'s role in that garage, or `null`. Since P4.5 also `'owner'` for the garage of the caller's open super-admin impersonation, in read-only transactions only (see "Super admin").
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
- `seed_garage_defaults(p_garage_id uuid) returns jsonb` (service role): Mon–Fri 08:00–17:30 and Sat 08:30–13:00, Bays 1–3 + Mobile van, six services (MOT, Diagnostics, Full service, Interim service, Brakes, Something else; the MOT row is always created and stays unbookable until `mot_enabled`). Each group only when the garage has none; returns `{opening_hours, resources, services, reminder_rules}` counts added (the four default reminder rules since P3.6, each kind only when missing).

As built (P2.1–P2.3), in addition to the above:

- `available_slots` raises instead of returning nothing when the request cannot be served: `SERVICE_UNAVAILABLE` (unknown, deleted or offline service, another garage's service, MOT while `mot_enabled` is off, a location mode the service does not offer, garage not `onboarding`/`active`) and `INVALID_BOOKING` (missing dates, `p_from > p_to`, unknown location mode). `p_location_mode` null means mobile for mobile-only services and workshop otherwise. The date range is clamped to today .. `now() + max_days_ahead`. Starts step from each window's opening in real (UTC) time; for windows that do not span 01:00–02:00 local time this is the same as wall-clock steps on clock-change days.
- `create_booking` rules: `starts_at` must carry a UTC offset; `idempotency_key` is optional in SQL (the API always sends one) and is checked before anything else, so a retry gets its booking even after the slot has closed. Error precedence: `INVALID_BOOKING` for malformed input, then `SERVICE_UNAVAILABLE`, then `OUTSIDE_SERVICE_AREA` (outward code of the normalised postcode against `garages.service_area`), then `INVALID_BOOKING` for a start that is not an opening-window start on the slot step, then `SLOT_UNAVAILABLE` for a closure day, notice/max window, or no free resource. Consent: only when `reminder_consent` is true and the customer has no consent on record are `consent_at`, `consent_source` (default `booking`) and `consent_text` written together; an existing consent record and `opted_out_at` are never changed. A matched vehicle moves to the booking's customer. Created events: `actor` is `agent` for `ai_agent`, `staff` for `phone`/`walk_in`, otherwise `customer`. Allocation per garage is serialised by a transaction-level advisory lock; the `no_overlap` retry still covers other writers. `reminder_send_id` is credited only under the P3.6 attribution rules ("Admin, reminders and jobs" below); otherwise it is ignored.
- Clock-injectable internals for tests, granted to no API role: `available_slots_at(…, p_now timestamptz)` and `create_booking_at(p_garage_id, p_booking, p_now timestamptz)`; the public functions call them with `now()`.
- Staff bookings (`20261028002200_staff_bookings.sql`, pgTAP 025, DECISIONS A177-A181): `p_booking` may carry `staff {member_id uuid, override_hours bool}`, only with `source` `phone`/`walk_in` and only when `member_id` is an owner, manager, technician or front-desk member of `p_garage_id` (else `INVALID_BOOKING`). Then services with `online_enabled = false` are bookable, the notice period and `max_days_ahead` are replaced by "from the start of today (garage time) up to 730 days ahead", and the status is always `confirmed`. Opening hours and closures still apply unless `override_hours` (then any whole minute); deleted services, MOT, garage status, location mode, service area, the free-resource check and `no_overlap` always apply. The created event gets `actor_id` = the member and `data.staff_rules` (+ `hours_override`). `booking_service_context(garage, service, mode, include_offline boolean)` is the shared check; the three-argument form (online) calls it with `false`.
- `staff_available_slots(p_garage_id, p_service_id, p_from, p_to, p_location_mode, p_member_id)` (service role; internal `staff_available_slots_at(…, p_now)`): `available_slots` with the staff relaxations for that member (opening hours and closures apply), at most 31 days per call.
- `manage_admin_trash` entities are now `enquiries`, `bookings`, `invoices`, `services` (`catalogue_systems`/`catalogue_services` are gone). Only `cancelled`, `no_show` or `collected` bookings can be trashed, because a live booking keeps its resource.

### App

| Module | Exports |
| --- | --- |
| `src/lib/booking-engine/repository.ts` | `listOnlineServices(garageId)`, `getAvailableSlots({garageId, serviceId, from, to, locationMode})` (30 s in-memory cache keyed by all args, cleared on create), `getStaffSlots({…, memberId})` (`staff_available_slots`, uncached, ≤ 31 days), `createBooking(garageId, input, options?)` → `{ok: true, booking} \| {ok: false, code, alternatives?}` (on `SLOT_UNAVAILABLE` returns the 3 nearest free slots, from the staff grid for a staff booking). `options.staff = {memberId, overrideHours?}` (`staffBookingContextSchema`) is server-set from the admin session only and sent as `create_booking`'s `staff` object (A177) |
| `src/lib/booking-engine/state.ts` | Booking flow cookie `af_booking`: AES-256-GCM sealed (key from `BOOKING_STATE_SECRET`, falls back to `BOOKING_MANAGEMENT_SECRET`), httpOnly, `SameSite=Lax`, `Secure` in production, 2 h, bound to the garage id. Holds vehicle, service, location mode, postcode, symptoms, note, chosen start |
| `src/lib/booking-engine/manage.ts` | Manage tokens (HMAC, stored hashed), lookup by reference + registration (POST body, never the URL), reschedule/cancel with the garage's cancellation cutoff. Token = `HMAC-SHA-256(BOOKING_MANAGEMENT_SECRET, "booking-manage-link:v1:<garage_id>:<idempotency_key>")` base64url (43 chars), stored as hex SHA-256 in `manage_token_hash`, link `/manage?token=…`; `af_manage` session cookie (signed, httpOnly, 30 min, garage + booking id). Reschedule shifts `during` by the move (keeps travel/buffer), keeps the resource when free else another active one of its kind, writes `booking_events` |
| `src/lib/booking-engine/notify.ts`, `src/lib/bookings/notifications.ts` | `notifyBooking({type: created/confirmed/rescheduled/cancelled, garageId, bookingId})` (`confirmed`: staff accepted a request, A176: customer email + text only, skipped if no longer confirmed) after each change (queues a `notifications.booking` job, deduped per booking event, and drains it with `after()`; sends directly when the queue is unreachable): customer email + `.ics`, staff alert, SMS/WhatsApp on the customer's channel (opt-out re-checked), reserved in `booking_notification_events`, logged as `booking_events` `notification_sent` |

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

As built (P3.6, `20261028001000_reminders.sql`; DECISIONS A49–A58). Every function below is `security definer`, `search_path = ''`, executable by `service_role` only; errors are `22023` (bad arguments) or `P0001 GARAGE_NOT_FOUND`.

| Function | Returns | Notes |
| --- | --- | --- |
| `enqueue_job(p_kind text, p_payload jsonb default '{}', p_run_at timestamptz default null, p_dedupe_key text default null, p_garage_id uuid default null)` | `jobs` (the row) | `p_run_at` null = now. Same (non-blank) `dedupe_key` → the existing job whatever its state; keys are unique for ever, so put the day in keys of recurring work. Kinds are dotted lower case (`reminders.send`) |
| `claim_jobs(p_kind text, p_limit int)` | `setof jobs` | One kind (required), `p_limit` ≥ 1 (capped at 100), oldest `run_at` first. A running job whose lock expired is claimed again (attempts + 1) unless it had used its last attempt: then it is `failed` with `LOCK_EXPIRED…` |
| `finish_job(p_id uuid)` | `boolean` | `true` when a running job became `done` (`finished_at` set); `false` otherwise |
| `fail_job(p_id uuid, p_error text, p_retry boolean default true)` | `text` | New status: `queued` (retry at now + 2^attempts min: 2, 4, 8, 16…) or `failed` (attempts = `max_attempts`, or `p_retry => false`); `null` when the job was not running. `last_error` ≤ 2000 chars |
| `schedule_reminders(p_garage_id uuid, p_today date)` | `jsonb` `{mot, service, review, cancelled}` (rows added/re-armed per kind, pending rows cancelled) | `p_today` is the garage-local date. Idempotent. See below |
| `claim_reminder_sends(p_garage_id uuid, p_now timestamptz, p_limit int)` | `table (id uuid, rule_id uuid, kind text, due_date date, offset_days int, send_at timestamptz, channel text, template text, customer_id uuid, customer_name text, phone text, email text, vehicle_id uuid, registration text, make text, model text)` | Due rows (`scheduled`, `send_at <= p_now`) → `sending` (returned) or `skipped` (`skip_reason`); `p_limit` ≥ 1 (capped at 200) counts claimed rows only. No quiet hours here: call it only inside the send window |
| `reminder_won_back(p_garage_id uuid, p_from date, p_to date)` | `table (sent int, bookings int, pence bigint)`, one row | Garage-local dates, inclusive, `p_from <= p_to` |
| `apply_message_retention(p_garage_id uuid)` | `integer` (rows changed) | Clears `messages.body` (sets `redacted_at`), `reminder_sends.body` and `calls.voicemail_url` older than 12 months; run per garage from the retention job |
| `seed_garage_defaults(p_garage_id uuid)` | `jsonb` `{opening_hours, resources, services, reminder_rules}` | Now also adds the 4 default rules (each kind only if missing) |

- **Default rules** (also added to every garage that existed when the migration ran): `mot` on `{28,7}`, `service` on `{335}`, `review` **off** `{1}`, `missed_call` on `{0}`, all `channel = customer`, templates = `DEFAULT_TEMPLATES` bodies (no opt-out line: `renderTemplate(…, {channel})` adds it). Since `20261028002300_reminder_wording.sql` (A184) these are the one-text wording; that migration's `apply_one_text_reminder_wording()` (owner only) moved rules still exactly on the old default. `reminder_rules` columns staff may write: insert `kind, enabled, offset_days, channel, template`; update `enabled, offset_days, channel, template`.
- **Scheduling** (`schedule_reminders`): per enabled rule and offset, a row when its send day is between `p_today − 3` and `p_today + 30`, for customers with `reminder_consent`, no `opted_out_at`, not anonymised, with an address for the channel (rule channel, or `customers.channel` for `customer`). `mot`: `due_date = vehicles.mot_expiry` (≥ today, only while `garages.mot_enabled`), send day = due − offset. `service`: anchor = local date of `vehicles.last_service_at`, else of the last collected non-MOT booking; `due_date` = anchor + 1 year; send day = anchor + offset. `review`: `due_date` = local day the booking was collected (its `status_changed → collected` event, else `ends_at`); send day = due + offset; the booking's customer. `send_at` = send day 10:00 in `garages.timezone` (09:00 UTC on 29 Mar 2026, 10:00 UTC on 25 Oct 2026). Pending MOT/service rows whose due date no longer matches the vehicle are `cancelled` (`due_date_changed`) and re-armed if it comes back. Suspended/cancelled garages get nothing new.
- **Claim re-checks** (`skip_reason`, first that applies): `no_customer`, `rule_missing`, `rule_disabled`, `rule_changed` (offset no longer in the rule), `mot_disabled`, `anonymised`, `opted_out`, `no_consent`, `no_address`, `due_date_changed`, `expired` (MOT/service due date passed, or > 7 days late), `already_booked` (a sibling send for the same due date has a live booking; an MOT booked from 60 days before the due date; a future service visit). A claimed row is re-pointed at the vehicle's current owner and its channel re-resolved. After the claim the sender (service role) writes `link_token_hash` + `link_expires_at`, `body`, then `status` (`sent`/`failed`), `provider_msg_id`, `sent_at`, `error_code`; webhooks move it to `delivered`/`failed`. Constraints: `sent`/`delivered` need `sent_at`; `skipped`/`cancelled` need `skip_reason`; the link hash is 64 hex and comes with its expiry.
- **Attribution** (`create_booking`): `reminder_send_id` counts when the send is the garage's, has gone out (`sending`, `sent`, `delivered`, `failed`), and its `vehicle_id` and `customer_id` are the booking's (matched by registration and phone). Then `bookings.source = 'reminder'`, `bookings.reminder_send_id` set, the send's `booking_id` = this booking (the latest wins), and the `created` event's data carries `reminder_send_id`. Otherwise the id is ignored and a requested `source: 'reminder'` is stored as `online`. Status and event actor follow the requested source (an `ai_agent` booking stays `requested`). FK `bookings (garage_id, reminder_send_id) → reminder_sends` on delete set null.
- **Won back**: `sent` = sends with `sent_at` in range; `bookings`/`pence` = bookings with `reminder_send_id`, created in range, not `cancelled`/`no_show`/trashed; pence = sum of the booking's `issued`/`paid` invoices if any, else `bookings.price_pence`, else 0.
- **Other tables**: `messages.status` is `queued`/`sending`/`sent`/`delivered`/`failed` (outbound) or `received` (inbound); the customer's side of a text is E.164 (`to_address` outbound, `from_address` inbound; strip `whatsapp:`); `provider_msg_id` unique when set; `body` null only after retention. `calls.status` uses Twilio's CallStatus values (`no-answer`, `in-progress`, …); `from_number` null when withheld; staff may only set `handled_at` and `handled_by` (= themselves). `garage_phone_numbers.purpose` is `forwarding` or `messaging`; owners add (`number`, `purpose`), change `purpose`, remove; only the service role sets `provider_sid`, and webhooks route only numbers with `provider_sid`. Staff read `reminder_rules`, `reminder_sends`, `messages`, `calls`, `garage_phone_numbers`; `jobs` and `vehicle_facts` have RLS on and no API-role grants.

### App

| Module | Exports |
| --- | --- |
| `src/lib/messaging/channel.ts` | `interface MessageChannel { kind; send(message): Promise<SendResult> }`, `getChannel(kind)` (mock unless `MESSAGING_MODE=live`), `renderTemplate(template, vars)` (`{first_name}`, `{vehicle}`, `{reg}`, `{due_date}`, `{link}`, `{garage}`; always ends "Reply STOP to opt out" for SMS/WhatsApp), `smsSegments(body)` |
| `src/lib/messaging/twilio.ts` | SMS + WhatsApp adapters, `verifyTwilioSignature(url, params, signature, authToken)` |
| `src/lib/messaging/quiet-hours.ts` | `isWithinSendWindow(at, timezone)` (09:00–19:00 Mon–Sat), `nextSendWindow(at, timezone)` |
| `src/lib/jobs/*` | `enqueueJob(kind, payload, {runAt, dedupeKey, garageId})` (`queue.ts`), `drainJobs({kinds?, budgetMs})` (`runner.ts`), `JOB_DEFINITIONS` (`registry.ts`: kind, handler, timeout), `CRON_JOBS`/`isCronAuthorized`/`cronDedupeKey` (`cron.ts`), `handleCronRequest`/`handleDrainRequest` (`http.ts`), handlers in `handlers/*` (see "As built (P3.7–P3.9)") |
| `src/lib/reminders/*` | `sendGarageReminders()` + `sendWindow()` (`send.ts`), `composeReminder()` (`compose.ts`), `createReminderLinkToken()`/`hashReminderLinkToken()` (`link-token.ts`: 16 random bytes base64url, 22 characters, A185; 43-character tokens from before still open; SHA-256 hex stored, 30-day expiry), `formatReminderDate(iso, sendAt)` (`compose.ts`: `{due_date}` as "24 Nov", with the year beyond 180 days), `openReminderLink()`/`reminderService()` (`open-link.ts`), `handleReminderLinkRequest()` (`link-route.ts`). Scheduling stays in SQL (`schedule_reminders`) |
| `src/lib/messaging/twilio-webhooks.ts` | `handleTwilioWebhook(request, kind, {repo})` with `TwilioWebhookRepo` (Supabase: `twilio-webhook-repository.ts`); `webhook-request.ts`: `twilioWebhookUrl()`, `readVerifiedTwilioRequest()`, `twimlResponse()` |

### As built (P3.7–P3.9; DECISIONS A93–A99)

Migration `20261028002000_twilio_webhooks.sql` (service role only, `security definer`, `search_path = ''`; pgTAP 023):

| Object | Notes |
| --- | --- |
| `twilio_webhook_events` (platform, A10) | `event_key` pk (`inbound:<MessageSid>`, `status:<MessageSid>:<status>`, `voice:<CallSid>:<CallStatus>`), `kind` (`sms`/`whatsapp`/`status`/`voice`), `provider_sid`, `processing_status` (`processing`/`processed`/`ignored`/`failed`), `outcome`, `error_code`, `attempts`, `received_at`, `processed_at`. Ids and codes only, never numbers or bodies |
| `claim_twilio_webhook_event(p_event_key, p_kind, p_provider_sid) → boolean` | true for a new event, a failed one, or one stuck in `processing` > 5 min; false for a duplicate |
| `finish_twilio_webhook_event(p_event_key, p_status, p_outcome, p_error_code) → boolean` | |
| `apply_messaging_keyword(p_garage_id, p_phone, p_intent) → jsonb {customers, cancelled, unchanged}` | `stop`: `opt_out_customer(garage, null, phone, 'sms_stop')` (audited once) and cancels the customer's `scheduled` reminders (`skip_reason = opted_out`); `start`: clears `opted_out_at` only with `reminder_consent`, audited `customer.opted_in` (`sms_start`) |

Job kinds (`JOB_KINDS`, drained in this order; payloads are ids and dates only, zod-strict; a payload without `garageId` is the platform "fan-out" job that queues one job per garage):

| Kind | Payload | Does |
| --- | --- | --- |
| `reminders.schedule` | `{garageId?, today?}` | fan-out: active garages, key `reminders.schedule:<garage>:<local day>`; per garage: `schedule_reminders(garage, local today)` |
| `reminders.send` | `{garageId?}` | fan-out: active garages, key `reminders.send:<garage>:<10-min UTC slot>`; per garage: outside the send window re-queues itself at `nextSendWindow()` (key `…:window:<instant>`); else `claim_reminder_sends()` in batches of 10, per row a new link token, the rule template (`renderTemplate`, refused with `failed`/`template_placeholders` when a placeholder has no value), a `messages` row in `sending`, the send (`getChannel`, two-way number, no alphanumeric sender), then `sent` + provider id + `sent_at`. Ambiguous results: `failed` (`ambiguous:…`), never resent. Rate limit / 5xx / missing configuration: rows back to `scheduled`, batch stops (retry after Retry-After, backoff, or next run). Twilio 21610: mirrored as a STOP. Email reminders end with the signed `unsubscribeUrl()` (fallback: the `/unsubscribe` form) |
| `notifications.booking` | `{type, garageId, bookingId, previousStartsAt?}` | `sendBookingNotifications()`; key `notifications.booking:<garage>:<booking>:<type>:<once or hash of previous start>` |
| `calls.text_back` | `{garageId, callId}` | P4.1: the missed-call text-back (see "Missed calls"); key `calls.text_back:<call id>`, drained after the voice webhook's response |
| `messages.reply` | `{garageId, inboundMessageId, kind: "help"}` | the HELP answer (garage name, phone, email + opt-out line) to the sender on the inbound channel; key `messages.reply:help:<message id>`; not repeated to the same number within 10 min |
| `domains.check` | `{}` | `runDomainsCheck()` over `garage_domains` (custom, `pending_dns`/`verifying`; `verification.pending_since` restarts the 48 h window); Vercel rate limit → re-queued after Retry-After; no Vercel configuration → logged, done |
| `retention` | `{garageId?}` | fan-out: every garage (A24), then deletes `vehicle_facts` older than 30 days and `done`/`failed` jobs finished more than 14 days ago; per garage: `apply_enquiry_retention` + `apply_message_retention` |
| `customers.enrich` | `{garageId?, importId?}` | fan-out: garages with `vehicles.enrichment_status = pending`; per garage: `enrichImportedVehicles()` within the attempt, re-queued while `remaining` (now; after Retry-After; 15 min when only failed lookups remain). The import action queues it for the rest of an import |
| `mot.refresh` | `{garageId?, after?}` | fan-out: active garages with MOT on; per garage: vehicles of consenting, not opted-out, not anonymised owners where `mot_checked_at` is null or > 30 days old, or > 20 h old with expiry unknown or ≤ 60 days ahead, 25 at a time in id order (`after` cursor), via `getConfiguredMotHistoryLookup()` (DVSA; mock outside production); a different expiry updates the vehicle and cancels its `scheduled` MOT reminders for other dates (`due_date_changed`), then `schedule_reminders()`; rate limit → continuation after Retry-After |

Runner: one claim at a time per kind; attempt timeout per kind (12–18 s; handlers get `deadline` 3 s earlier to stop starting work); success `finish_job`; `JobError(retry: false)` → `fail_job(…, false)`; anything else → `fail_job` with backoff; `jobs.last_error` and logs carry safe codes only (`db_<code>`, our codes, class names). Logs: one JSON line per job (`scope: jobs`, `event`, `job_id`, `kind`, `garage_id`, `ms`, `outcome`, counts).

Routes and auth:

| Route | Auth | Does |
| --- | --- | --- |
| `GET /api/cron/[job]` (`daily`, `reminders.schedule`, `reminders.send`, `mot.refresh`, `domains.check`, `retention`, `platform.close_impersonations`, `customers.enrich`) | `Authorization: Bearer $CRON_SECRET`, constant-time (SHA-256 digests), secret ≥ 16 chars | queues the fan-out kinds with key `cron:<kind>:<UTC day or slot>`, drains every kind for ≤ 20 s; 401/404/503/500 (drain failed); counts only |
| `POST /api/jobs/drain` | same | optional strict JSON `{kinds?, budgetMs? (1000–50000)}`; 401/400/415/422/503 |
| `POST /api/webhooks/twilio/{sms,whatsapp,status,voice}` | `X-Twilio-Signature` on the raw body against `TWILIO_WEBHOOK_BASE_URL` (else forwarded proto/host) + path + query; no `TWILIO_AUTH_TOKEN` → 503; form-encoded only (415), ≤ 64 KB (413) | claim the event, then: inbound text → `messages` (garage only from `garage_phone_numbers` with `provider_sid`), STOP/START via `apply_messaging_keyword`, HELP → `messages.reply` job drained after the response (skipped when `OptOutType` is set); a STOP to an unrouted number opts out the number at every garage that texted it in 12 months; status → `messages` / `reminder_sends` forward only (`isLaterStatus`; reminders only `sent` → `delivered`/`failed`, error `twilio:<code>`); voice → `calls` row and P4.1's dial-through / voicemail / text-back flow ("Missed calls" below; `<Reject/>` when unrouted). Always TwiML 200 except 403/415/413/503 above and 500 when the work failed (the event is `failed`, so Twilio's retry runs it again) |
| `GET /r/[token]` (garage host → `/_site/[garageId]/r/[token]`) | the token; rate limit 30 / 10 min per garage + IP (`reminder_link`) | 303 to `/time` (service with a workshop mode) or `/service` (no matching service, mobile-only service, review), sealed `af_booking` draft `{vehicle {registration, make, model, motExpiry only with MOT on}, serviceId, locationMode, reminderSendId, idempotencyKey}`, first `opened_at`; problems → 303 `/r?link=expired\|invalid\|limited\|unavailable` (`/r` page). `Referrer-Policy: no-referrer`, `no-store` |

The booking flow sends `draft.reminderSendId` to `createBooking` (attribution in `create_booking`, A52) and drops it when the customer changes the car.

Response headers: a header set in `next.config.ts` `headers()` replaces the same header set by a route handler, so the stricter `Referrer-Policy` of the token links (`/r/:token`, `/manage/link`, `/manage-booking`, `/signup/invite/:token`: `no-referrer`; `/auth/confirm`: `strict-origin`) is also restated there (A188, checked by `tests/e2e/smoke.spec.ts`). A new route that needs its own `Referrer-Policy` needs a rule there too.

Gate 3 (P3.12, A186, A187): `tests/e2e/gate3.spec.ts` (`pnpm test:e2e:gate3`) runs schedule (server, `POST /api/jobs/drain` with `CRON_SECRET`; playwright.garage.config.ts gives the server `PLAYWRIGHT_CRON_SECRET` from `tests/helpers/jobs.ts` and `MESSAGING_MODE=mock`) → send (`drainJobs()` in the test process with the clock pinned inside the send window, mock outbox) → `/r/{token}` in the browser → the five steps → attribution → Today's won back. App modules are loaded into Playwright with `importAppModule()` (`tests/helpers/app-modules.ts`, jiti with the `@/` and `server-only` aliases of vitest.config.ts).

### Missed calls (P4.1, `20261028002100_missed_calls.sql`; DECISIONS A160–A165)

| Object | Notes |
| --- | --- |
| `calls` (+) | `dial_status` (Twilio DialCallStatus `completed`/`answered`/`busy`/`no-answer`/`failed`/`canceled`, null when the call went straight to voicemail), `voicemail_duration_s`. `voicemail_url` holds the Twilio recording link (`https://api.twilio.com/2010-04-01/Accounts/AC…/Recordings/RE…` only); `text_back_message_id` the text-back's `messages` row. Staff still update only `handled_at`, `handled_by` |
| `claim_call_text_back(p_garage_id, p_call_id, p_channel, p_body, p_provider) → jsonb` | service role. `{status: claimed, message_id, customer_id, to}` after inserting the outbound `messages` row (`sending`, `call_id`) and linking it on the call, or `{status: skipped, reason}`: `not_found`, `not_missed`, `withheld`, `already_sent`, `opted_out`, `recent_text_back` (this garage texted this number about a call in the last 24 h; checked under an advisory lock per garage and number). pgTAP 024 |

Voice flow (`POST /api/webhooks/twilio/voice`, one URL; `?step=` is part of the signed URL):

| Request | Event key | Writes | Answer |
| --- | --- | --- | --- |
| incoming call (`CallStatus` ringing/queued/in-progress), number provisioned (`provider_sid`) | `voice:<CallSid>:<status>` | `calls` row; `missed = false` when the garage's own phone is rung first, else `missed = true` and `calls.text_back` queued (key `calls.text_back:<call id>`) and drained after the response | `<Dial timeout=20 answerOnBridge action=?step=dial><Number>own phone</Number></Dial>`, else greeting + voicemail: `<Say>` "Sorry, <garage> can't take your call right now. Please leave a message after the tone and we'll get back to you." + `<Record maxLength=120 timeout=5 trim action=?step=recorded recordingStatusCallback=?step=recording>` + goodbye. Unprovisioned number: `<Reject/>` |
| `?step=dial` (`DialCallStatus`) | `voice:<CallSid>:dial` | `dial_status`; `busy`/`no-answer`/`failed`/`canceled` → `missed = true` + text-back queued | missed: the voicemail TwiML; answered: `<Hangup/>` |
| `?step=recorded` | none | none | "Thanks for your message. Goodbye." `<Hangup/>` |
| `?step=recording` (`RecordingStatus` completed) | `voice:<CallSid>:recording` | `voicemail_url`, `voicemail_duration_s` (by CallSid) | empty |
| status callbacks (completed, no-answer, …) | `voice:<CallSid>:<status>` | status forward only, `duration_s` | empty |

The garage's own phone is a `garage_phone_numbers` row with `purpose = forwarding` and **no** `provider_sid` (entered by the owner), UK geographic, 03 or mobile only, never the called number; it is skipped when `ForwardedFrom` is that number or the caller rang this garage on another call in the last 2 minutes (our forward coming back). A repeated incoming request gets the same TwiML without writes.

Job `calls.text_back` (`{garageId, callId}`, `src/lib/calls/text-back.ts`): skips answered, withheld, already-texted calls, non-UK-mobile numbers and calls older than 10 minutes; needs the garage's `missed_call` rule enabled; skips opted-out customers and numbers whose latest STOP/START to the garage was STOP; renders the rule template (`{garage}`, `{link}` = booking page, `{first_name}` for a known customer; a missing value sends nothing) with the opt-out line; channel WhatsApp when the rule (or, for `customer`, the caller's customer record) says so, else SMS; claims through `claim_call_text_back`, sends from the two-way number (no quiet hours: a reply to a live caller), records the result on the message, never retries after the claim.

| Module | Exports |
| --- | --- |
| `src/lib/calls/missed-calls.ts` | `listMissedCallsNeedingOk(rlsClient, garageId, {limit?})` → `MissedCallCard[]` `{id, at, callerName, maskedNumber ("07••• •••123", null when withheld), callBackHref ("tel:+44…"), voicemailHref ("/api/admin/calls/{id}/voicemail"), voicemailSeconds, textedBack}` (unhandled missed calls, newest first; [] on error); `countMissedCallsNeedingOk(rlsClient, garageId)` |
| `src/lib/calls/actions.ts` ("use server") | `markMissedCallHandled(callId)` → `{ok, changed}` / `{ok: false, code}`; `markMissedCallHandledAction(formData)` (hidden `callId`) for the card's "Mark handled" button. Sets `handled_at`/`handled_by` = the member through the RLS client, audits `call.handled`, revalidates `/app` |
| `src/lib/calls/voicemail.ts` + `GET /api/admin/calls/[id]/voicemail` | Admin session (trusted device allowed); reads the call through the RLS client, accepts only this Twilio account's recording link, streams `<link>.mp3` with the account's credentials (`private, no-store`), audits `call.voicemail_played` |
| `src/lib/calls/twiml.ts` | `dialTwiml`, `voicemailTwiml`, `afterRecordingTwiml`, `voiceStepUrl`, `isTwilioRecordingUrl` |

### Customers & cars (P3.11, `20261028000200_customer_imports.sql`)

| Table / column | |
| --- | --- |
| `customer_imports` (tenant) | `created_by`, `file_name`, `status` (`importing`/`completed`/`failed`), `total_rows`, `valid_rows`, `invalid_rows`, `duplicate_rows`, `imported_rows`, `customers_created`, `customers_updated`, `vehicles_created`, `vehicles_updated`, `consent_recorded`, `declaration_text`, `declaration_accepted_at`, `errors jsonb` (≤ 500 `{row, field, message}`), `completed_at`. Staff select only |
| `customers` (+) | `import_id` (composite FK, set null) |
| `vehicles` (+) | `import_id`, `enrichment_status` (`pending`/`done`/`not_found`/`failed`, null = never queued), `enrichment_attempts` |

SQL (authenticated owners/managers of the selected garage, MFA rule as invoices): `start_customer_import(p_file_name, p_summary jsonb, p_declaration_text) → uuid`, `import_customer_rows(p_import_id, p_rows jsonb) → jsonb counts` (rows `{name, phone E.164, email, registration normalised|null, consent}`, ≤ 1,000), `finish_customer_import(p_import_id, p_status) → customer_imports`. `apply_enquiry_retention` keeps live-consent customers and anonymises never-enquired customers only after 24 months without change (DECISIONS A46).

| Module | Exports |
| --- | --- |
| `src/lib/customers/csv.ts` (client-safe) | `parseCustomerCsv(text)` → `{fatal, columns, hasConsentColumn, totalRows, rows, errors, warnings, duplicates}`, `importBatches(rows, 500)`, `detectColumns`, `isUkRegistration`, `normaliseImportMobile`, `formatUkMobile` |
| `src/lib/customers/import.ts` | `runCustomerImport(rlsClient, {fileName, parsed, declarationText})` |
| `src/lib/customers/queries.ts` | `listCustomers(rlsClient, {query, page})`, `getCustomerDetail(rlsClient, id)`, `listRecentImports(rlsClient)` |
| `src/lib/customers/enrichment.ts` | `enrichImportedVehicles({garageId, importId?, limit?, concurrency?, pauseMs?, budgetMs?}) → {checked, enriched, notFound, failed, remaining, stoppedReason, retryAfterMs?}` (service role, explicit garage filter, idempotent). registered as job `customers.enrich` (payload `{garageId, importId?}`), re-enqueued while `remaining` (P3.7) |
| `src/lib/vehicle/configured-provider.ts` (+) | `getConfiguredEnrichmentLookup(env)`: DVSA, else DVLA, else mock in mock mode; never VDG |

Routes: `GET /api/cron/[job]` (`Authorization: Bearer CRON_SECRET`; enqueues then drains for up to 20 s — Vercel Hobby only runs daily crons), `POST /api/jobs/drain` (same secret), `POST /api/webhooks/twilio/{sms,whatsapp,status,voice}` (signature on the raw body, `twilio_webhook_events` first), `GET /r/[token]` on the garage host. Admin pages on the admin host under `/app`: `/app` (Today), `/app/diary`, `/app/bookings`, `/app/bookings/[id]`, `/app/customers`, `/app/customers/[id]`, `/app/customers/import`, `/app/reminders`, `/app/messages`, `/app/settings/{services,hours,resources,branding,booking-page,team}`.

### Admin shell, Today, Diary and Bookings (as built, P3.1–P3.3)

Also on the admin host: `/app/more` (phone "More" tab: every section, the garage switcher, account actions), `/app/bookings/new` (staff phone / walk-in booking), `/app/diary?week=YYYY-MM-DD` (any date in the week; Monday-first) and `/app/diary?day=YYYY-MM-DD` (one day on the DiaryGrid), `/app/bookings?status=&from=&to=&page=&search=1`. `(protected)/not-found.tsx` keeps the shell for `notFound()` in the admin; `src/app/not-found.tsx` is the root one. The root layout renders no `<main>`: the admin shell, the booking site layout (`/_site/[garageId]/layout.tsx`), the sign-in/MFA pages, the dev galleries and the root not-found each render their own.

| Module | Exports |
| --- | --- |
| `src/app/app/(protected)/layout.tsx` | `AdminShell` (`src/components/admin-ui`) with `defaultAdminNav({ newBookings })` (Workshop / Customers / Setup incl. Agreements; Bookings badge = open requests), garage switcher → `switchGarage`, search → `searchAdmin`, booking page link `garageBaseUrl(garage)`, bell = `getAdminNotificationSummary(client).count` kept live by `NotificationRefresher` (polls `/api/admin/notifications/count`, `router.refresh()` on change), account menu with `signOut`. Nav links mark the current page on the client (`NavLink` + `usePathname`): the layout does not re-render on client navigation |
| `src/lib/admin/data.ts` (server) | Reads through the RLS client passed in: `loadResources`, `loadBookingsStarting(from, to)`, `loadOpenRequests`, `countOpenRequests`, `loadOpeningHours`, `loadRecentActivity` (`admin_audit_log`, labelled by `src/lib/admin/dashboard.ts`), `loadReminderWeek` (`null` when `reminder_sends` can't be read; booked = bookings with a `reminder_send_id`), `listBookings(filters)`, `countBookingsByStatus`, `loadBookingDetail` (+ `booking_events`), `cleanSearch` |
| `src/lib/admin/booking-status.ts` | `STAFF_STATUS_TRANSITIONS` (requested → confirmed/cancelled; confirmed → arrived/in_progress/no_show/cancelled; arrived → in_progress/cancelled; in_progress → waiting_parts/ready/cancelled; waiting_parts → in_progress/ready/cancelled; ready → collected/in_progress; collected, cancelled, no_show final), `canChangeStatus`, labels |
| `src/lib/admin/booking-changes.ts` (server) | `changeBookingStatus(actor, id, to, { reason })`: RLS update of `status` (+ `cancellation_reason`) conditional on the status just read (`stale` otherwise); accept also sets `admin_seen_at`; cancel → `notifyBooking({ type: "cancelled" })`; accept (`requested` → `confirmed`) → `notifyBooking({ type: "confirmed" })` (A176); releasing a bay → `clearSlotCache`. The trigger writes the timeline event. `addBookingNote(actor, id, text)`: `booking_events` `note`, actor `staff`, `actor_id` = member |
| `src/app/app/(protected)/bookings/status-actions.ts` | `acceptBookingAction`, `quickStatusAction` (cards; problems → `/app/bookings/[id]?notice=<code>`), `changeBookingStatusFormAction`, `addBookingNoteAction` (useActionState). All via `requireStaffWriter()` (`src/lib/admin/staff.ts`: AAL2 session; a trusted device reads only) |
| `src/lib/admin/search.ts`, `search-actions.ts` | `searchAdmin(formData)` (POST only): exact reference → the booking; otherwise the term goes in the `af_admin_search` cookie (httpOnly, SameSite strict, path `/app`, 15 min) and the browser goes to `/app/bookings?search=1`. Matching: reference `ilike`, customer name `ilike`, mobile → E.164 `eq`, registration normalised `eq` (as the manage lookup) |
| `src/lib/admin/staff-booking.ts` (server) | `staffBookingSchema` (incl. `overrideHours`), `createStaffBooking(garageId, memberId, input)` → `getBookingEngine().createBooking(…, {staff: {memberId, overrideHours}})` with `source` `phone`/`walk_in` (staff rules, A177-A179); ticked consent → `consent_source = staff` with `STAFF_CONSENT_WORDING`. `/app/bookings/new/actions.ts`: `getStaffSlotsAction` (`getStaffSlots` for the signed-in member), `createStaffBookingAction` (member = `admin.user.id`; form field `overrideHours=on`) |
| `src/lib/admin/{dates,today,diary,timeline,bookings}.ts` | Pure: garage-local day/week ranges (clock-change safe), Today shaping (`shapeToday`, `diaryHours`, `todayChips`), week grid (`shapeWeek`), `booking_events` in words, row mapping |

### Reminders page and missed calls on Today (as built, P3.10; DECISIONS A166–A175)

`/app/reminders` (`?edit=<kind>#rule-editor` opens the rule editor in the aside, `?confirm=review#review-confirm` the review-request consent note; `?done=` / `?error=` flash keys). Neither query ever holds a registration or booking state. Today's "Needs your OK" shows missed calls from the P4.1 library. `/app/bookings/new` lists every service that isn't deleted (offline ones labelled) and has "Outside opening hours" (`overrideHours=on` + a free `datetime-local`, A175).

| Module | Exports |
| --- | --- |
| `src/lib/reminders/rules.ts` (pure, client-safe) | `RULE_KINDS` (`mot`, `service`, `missed_call`, `review`), `RULE_CHANNELS`, `RULE_NAMES`, `RULE_SWITCH_LABELS`, `CHANNEL_OPTIONS`, `allowedPlaceholders(kind)` (the six reminder placeholders; `first_name`, `link`, `garage` for the text-back), `checkTemplate(kind, text)` → `{ ok, errors, warnings, unknown }` (unknown placeholders refused as the senders refuse them, `{garage}` required, 1000 characters), `describeRule(kind, offsets)`, `parseOffsets("28, 7")`, `OFFSET_LABELS`, `defaultTemplate(kind)`, `REVIEW_CONSENT_NOTE` (A54), `SAMPLE_LINK_TOKEN` (22 characters, as a real token), `sampleTemplateValues({ kind, garageName, bookingBaseUrl, dueDate })` (pass `formatReminderDate(…)` as `dueDate`) |
| `src/lib/admin/reminders.ts` (server, RLS client + explicit `garage_id`) | `loadReminderRules(client, garageId)`, `loadReminderMonth(client, garageId, monthFirst, tz)` → `{ sent, booked, pence, optedOut }` (A53's definition without the service-role `reminder_won_back()`; Today's "Won back by reminders" uses it too), `loadDueSoon(client, garageId, { today, timeZone, motEnabled, motRuleOn })` (`reminder_sends` due in 30 days + MOT cars from `vehicles` when `mot_enabled`), `nextMonthStart` |
| `src/lib/admin/reminder-view.ts` (pure) | `shapeDueSoon` (one row per car, kind and due date: booked > sent > scheduled > failed > skipped; MOT cars without a send say why), `sendStatus`, `bookedShare`, `KIND_LABELS` |
| `src/lib/reminders/test-send.ts` (server) | `sendReminderTest({ garage, user, rule, sampleDueDate })` (own sign-in mobile, else own email; `getChannel` = mock unless `MESSAGING_MODE=live`; `consumeRateLimit(user, "reminder_test", 5, 600)`; audit `reminder.test_sent` with kind/channel/outcome only), `testRecipient`, `composeTest` |
| `src/lib/reminders/replan.ts` (server) | `replanReminders(garageId)`: best-effort `reminders.schedule` job after a rule change |
| `src/app/app/(protected)/reminders/actions.ts` | `toggleRuleAction` (form: `kind`, `enabled`, `confirmed=yes` for review requests), `saveRuleAction` (useActionState: `kind`, `template`, `offsets`, `channel`), `sendTestAction` (`kind`). All `requireSetupContext` (AAL2 in this session) + `roleAllows(admin, "manage")`; a missing rule is inserted with the defaults |
| `src/lib/admin/staff-times.ts` (pure) | `checkOverrideTime(value, { today, timeZone })` (5-minute marks, today to +730 days, the spring-forward gap refused), `OVERRIDE_HOURS_HINT`; `zonedInstant()` in `src/lib/admin/dates.ts` |
| `src/components/admin-ui` | `MissedCallCard` (`listMissedCallsNeedingOk` rows; Call back `tel:`, Mark handled → `markMissedCallHandledAction`, Texted back badge), `VoicemailPlayer` (fetches `/api/admin/calls/[id]/voicemail` only when pressed), `TemplateEditor` `errors` / `warnings` props, `AutomationRow` `fields` / `editLabel` props |

### Messages & calls (as built; DECISIONS A196–A205)

Routes: `/app/messages` (conversations), `/app/messages/[customerId]` (thread + reply), `/app/messages/calls` (calls). Migration `20261028003000_messages_inbox.sql`: `messages.read_at` / `read_by` (staff column grant + policy "garage members mark inbound messages read"), `claim_staff_reply(uuid, uuid, uuid, text, text)` (service role). pgTAP `027_messages_inbox`.

| Module | Exports |
| --- | --- |
| `src/lib/messages/view.ts` (pure) | `shapeConversations`, `countUnread`, `threadItems` (day lines, labels, delivery, STOP/START system lines), `messageLabel`, `deliveryStatus`, `replyBlock` (the reply box's reason, mirroring `claim_staff_reply()`), `maskedAddress`, `shortWhen`, `CHANNEL_NAMES` |
| `src/lib/messages/inbox.ts` (server, RLS client + explicit `garage_id`) | `loadInbox(client, garageId)` → `{ conversations, unknown, unreadTotal }`, `loadThread(client, garageId, customerId)`, `hasMessagingNumber`, `countUnreadMessages`, `markThreadRead(client, garageId, customerId, userId)` |
| `src/lib/messages/reply.ts` (server; service role for the claim and the record only) | `sendStaffReply({ garage, member, customerId, body })`, `canReply(role)` (owner, manager, front desk), `REPLY_MAX_LENGTH` (1000), `REPLY_RATE_LIMIT` (20 / 10 min) |
| `src/lib/calls/recent-calls.ts` (server, RLS) | `listRecentCalls(client, garageId, { limit })` → `RecentCall` (the `MissedCallCard` shape + missed, handled, duration) |
| `src/app/app/(protected)/messages/actions.ts` | `replyAction` (useActionState; `requireStaffWriter`, form `customerId`, `body`), `markThreadReadAction(customerId)` (any member, from the thread page once shown), `markCallHandledAction` (P4.1's `markMissedCallHandled`, then refreshes the Calls tab) |

Setup pages (P3.4, as built): `/app/settings/services` (+ `/new`, `/[id]`), `/app/settings/hours`, `/app/settings/resources`, `/app/settings/branding`. Rules shared by forms and actions: `src/lib/settings/setup.ts` (client-safe: `canManageSetup(role)` owner/manager, `canChangeGarage(role)` owner, `parseServiceForm`, `parseOpeningHoursForm` + `diffOpeningWindows`, `parseClosureForm`, `parseBookingRulesForm`, `parseServiceArea`, `parseResourceForm`, `chooseAccent`, `sniffLogoType`, `logoPath`). Server plumbing: `src/lib/settings/server.ts` (`requireSetupContext(returnTo)` = `getAdminContext()` with MFA, `roleAllows`, `databaseProblem`, `afterSetupChange(garageId, paths)` clears the slot cache and revalidates). Server actions sit next to each page (`settings/*/actions.ts`), write only through `admin.client` with `garage_id`/`id = admin.garage.id`, and return `SetupFormState` (`useActionState`) or redirect with `?done=`/`?error=` codes. The logo goes to `public-media/<garage_id>/logo.<ext>` through the RLS client's storage API.

## Agent tool API (Phase 4, P4.2)

Contract: `docs/autofix/agent-api.yaml` (OpenAPI 3.1) for Workforce and Askbridge. `POST /api/agent/v1/{lookup_vehicle,list_services,available_slots,create_booking,get_booking,garage_profile}` on the admin host, `Authorization: Bearer afat_…`, strict JSON bodies (no garage id, no `source`, registrations only in bodies). Errors `{code, message, issues?, alternatives?}`: 401 `UNAUTHORIZED`, 403 `FORBIDDEN`/`GARAGE_INACTIVE`, 404 `NOT_FOUND`/`VEHICLE_NOT_FOUND`, 409 `SLOT_UNAVAILABLE` (+ up to 3 `alternatives`), 422 `INVALID_REQUEST`/`INVALID_BOOKING`/`SERVICE_UNAVAILABLE`/`OUTSIDE_SERVICE_AREA`, 429 `RATE_LIMITED`, 503 `UNAVAILABLE` (+ 400/413/415 for bad bodies).

### Schema (`20261028000100_agent_tokens.sql`)

| Table | Columns |
| --- | --- |
| `agent_tokens` (tenant) | `name`, `token_hash` (hex HMAC-SHA-256 with `AGENT_TOKEN_PEPPER`, unique), `scopes text[]` (tool names, default all six), `last_used_at`, `revoked_at`. No staff grants; select policy for owners/managers as a backstop |
| `agent_call_log` (tenant) | `token_id` (composite FK, set null), `tool`, `outcome` (`OK` or the error code), `http_status`, `latency_ms`, `booking_id` (composite FK, set null). Staff read; service role writes. Never phone numbers, registrations or tokens |

SQL: `issue_agent_token(p_garage_id, p_name, p_scopes, p_token_hash) → jsonb` (service role; never returns the hash), `list_agent_tokens()` and `revoke_agent_token(p_token_id) → boolean` (authenticated owners/managers of the selected garage, security definer).

### App

| Module | Exports |
| --- | --- |
| `src/lib/agent-api/schemas.ts` | `agentTools`, `agentInputSchemas` (zod, one per tool), error codes/status/messages, response types matching the OpenAPI components |
| `src/lib/agent-api/tokens.ts` | `generateAgentToken()`, `hashAgentToken(token)`, `bearerToken(header)`, `agentTokenHashesMatch()` (constant time), `tokenAllows(scopes, tool)` |
| `src/lib/agent-api/store.ts` | `AgentApiStore` (`findToken`, `recordCall`, `garageProfile`, `findBooking`), `getAgentApiStore()` / `setAgentApiStoreForTests()`, `issueAgentToken({garageId, name, scopes})` → raw token once |
| `src/lib/agent-api/handler.ts` | `handleAgentToolRequest(tool, request)`: token → garage status → scope → rate limits → body → tool (booking engine, vehicle provider with MOT only when `mot_enabled`, `findBookingForManage`) → `agent_call_log` row + `agent_api.call` log line |

## Super admin (Phase 4, P4.5)

### As built (DECISIONS A120–A129)

Migration `20261028000500_platform_admin.sql`; pgTAP `021_platform_admin.test.sql`; integration `tests/integration/platform-admin.test.ts`; Playwright `tests/e2e/super-admin.spec.ts` (project `super-admin` in `playwright.garage.config.ts`, `pnpm test:e2e:super-admin`).

| Table | Columns | Access |
| --- | --- | --- |
| `platform_impersonations` | `garage_id` (not null, cascade), `admin_user_id → auth.users`, `reason` (5–500), `started_at`, `expires_at` (≤ 2 h after start), `ended_at`, `end_reason` (`ended`/`replaced`/`expired`); one open row per admin | service role only (RLS on, no policies); exempt from the 007 default/select-policy rules like `jobs` |
| `platform_audit_log` | `actor_id`, `action` (`platform.*`), `target_garage_id` (set null on delete), `entity_type`, `entity_id`, `reason`, `detail jsonb`, `created_at` | append-only, service role select/insert only |

SQL (security definer, `search_path = ''`):

- Internal (no API grant): `platform_admin_allowed()` (platform admin + `aal2`), `require_platform_admin()` (42501 `PLATFORM_ADMIN_REQUIRED`), `impersonated_garage_id()` (open, unexpired session; read-only transaction; AAL2), `record_platform_action()` (platform log + the garage's `admin_audit_log`), `clean_platform_reason()`, `close_expired_impersonations_for(uuid)`.
- `garage_role(uuid)` replaced: member role, else `'owner'` for `impersonated_garage_id()`.
- `authenticated` (each checks platform admin + AAL2): `platform_garages(p_search, p_status, p_plan, p_limit, p_offset)` (members, bookings in 30 days, last booking, custom domain + status, `total_count`), `platform_garage(id) → jsonb`, `platform_update_garage(id, plan, status, reason)`, `platform_audit_entries(garage_id?, limit)`, `platform_start_impersonation(garage_id, reason, minutes)`, `platform_end_impersonation()` (platform admin, no AAL2 needed), `current_impersonation()`, `log_impersonation_event(action, path)`, `platform_job_health() → jsonb`, `platform_retry_job(id, reason)`.
- `service_role`: `close_expired_impersonations() → integer`.

App:

| Module / route | What |
| --- | --- |
| `src/lib/platform/policy.ts` | Pure rules: `platformAccess()`, `isReadRequest()` / `isPrefetch()`, `toImpersonation()`, `cleanReason()`, `redactJobError()`, plan/status lists, `IMPERSONATION_COOKIE` (`af_impersonation`) |
| `src/lib/platform/access.ts` | `getPlatformAdmin()` (cached; `is_platform_admin()` + assurance on the user's own client), `requirePlatformAdmin()` (pages: `notFound()` / redirect `/admin/verify`), `getAllowedPlatformAdmin()` |
| `src/lib/platform/store.ts` | Typed RPC wrappers (`listGarages`, `getGarage`, `updateGarage`, `listAuditEntries`, `startImpersonation`, `endImpersonation`, `currentImpersonation`, `getJobHealth` (redacts), `retryJob`), `PlatformError` |
| `src/lib/platform/actions.ts` | Server actions: `updateGarageAction`, `startImpersonationAction` (sets the hint cookie, redirects to `/app`), `endImpersonationAction`, `retryJobAction`, `verifyPlatformMfaAction`, `startPlatformEnrolmentAction`, `signOutPlatformAction` |
| `src/lib/platform/api.ts` | `withPlatformAdmin()` (404 for non-admins, same-origin JSON for mutations, error mapping) |
| `src/lib/platform/jobs.ts` | `platformCloseImpersonationsHandler` for job kind `platform.close_impersonations` (registered in `src/lib/jobs`: hourly period, also in the `daily` cron) |
| `src/components/platform/impersonation-banner.tsx` | `ImpersonationBanner({ impersonation, surface })`: "Viewing <garage> as Vitalos support. Read-only … Ends at HH:MM" + End impersonation |
| `src/lib/tenancy/request-headers.ts` | `x-autofix-method`, `x-autofix-path`, set by `src/proxy.ts` on every admin-host request (client values overwritten) |
| `src/lib/tenancy/admin.ts` | `AdminContext.impersonation`; with the hint cookie and an open session the impersonated garage is the only membership (role `owner`); server actions and non-GET requests get `null` and are logged as blocked writes; GETs are logged as page views (not prefetches) |
| `/admin` | Garages list: search name/slug, filter status/plan, 25 a page (GET form; `?q=&status=&plan=&page=`) |
| `/admin/garages/[garageId]` | Counts, plan + status with reason, "View as support" (reason, minutes), domains, support sessions, platform history |
| `/admin/jobs` | Job health: counts by kind/status, oldest queued, expired locks, recent failures (redacted) with Retry, reminder sends skipped/failed per garage in 7 days |
| `/admin/verify` | TOTP challenge or enrolment for platform admins |
| `/api/platform/garages` (GET), `/api/platform/garages/[garageId]` (GET, PATCH), `/api/platform/impersonation` (GET, POST, DELETE), `/api/platform/health` (GET), `/api/platform/jobs/[jobId]/retry` (POST) | JSON mirrors of the pages; 404 for everyone but platform admins at AAL2 |

`/admin` has its own layout (navy platform bar, no garage shell) and shows the banner while the admin has an open session. **The garage admin layout must mount the banner**: in `src/app/app/(protected)/layout.tsx`, render `{admin.impersonation ? <ImpersonationBanner impersonation={admin.impersonation} /> : null}` above the shell content (lead / UI lane). `/app/login` sends platform admins with no garage to `/admin`.


## Booking page, domains and Askbridge (P4.3, P4.6), as built

Migrations `20261028000600_domains_askbridge.sql` (no new tables; DECISIONS A140–A153) and `20261029001300_askbridge_site_key.sql` (29 Oct 2026: Askbridge site key; the knowledge sync, its triggers, `enqueue_askbridge_sync` and `askbridge_sync_after_change` dropped; job kind `askbridge.sync` unused). pgTAP `022_domains_askbridge.test.sql`.

| SQL | Who | What |
| --- | --- | --- |
| `set_booking_page_settings(p_embed_origins jsonb default null, p_askbridge jsonb default null) → jsonb` | authenticated, **owner** of the selected garage (else `42501`) | Atomic merge into `garages.settings`: `embedOrigins` (≤ 10 `https://host[:port]`) and/or `askbridge` `{enabled bool, siteKey ^pk_[0-9a-f]{32}$}` (`enabled` needs a key); null leaves a key alone; `22023` on bad input. Returns `{embedOrigins, askbridge}` |

`garage_domains.verification` (service role only) now holds `{records: [{type: CNAME\|TXT, name, host, value, purpose}], pending_since}`.

| Module | Exports |
| --- | --- |
| `src/lib/booking-page/embed-origins.ts` (client-safe) | `normaliseEmbedOrigin`, `parseEmbedOrigins(text)`, `embedOriginsFromSettings(settings)`, `MAX_EMBED_ORIGINS` |
| `src/lib/booking-page/security-headers.ts` (pure) | `bookingSiteCsp({embedOrigins, widgetOrigin, dev})`, `bookingSiteHeaders()`, `ADMIN_SECURITY_HEADERS`; applied by `src/proxy.ts` to every response (admin/unknown: `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`; garage hosts: CSP, no `X-Frame-Options`; the Askbridge loader's origin in `script-src` and `connect-src` only, for garages with the chat on). `next.config.ts` no longer sets `X-Frame-Options` |
| `src/lib/booking-page/domain-view.ts` (client-safe) | `parseStoredVerification`, `dnsRecordsForDisplay` (→ `DnsRecordTable`), `failedStepFor` (→ `DomainStatusSteps`), `checkAvailableInMs`, `isDomainInProgress` |
| `src/lib/booking-page/domains-server.ts` | `getCustomDomain(client, garageId)`, `connectCustomDomain(garageId, hostname, {rls, service, domains?})`, `checkCustomDomainNow` / `retryCustomDomain(garageId, {service, domains?, now?})`, `removeCustomDomain(garageId, {rls, service})`, `createSupabaseDomainsCheckRepo(client, {garageId?, id?, limit?})` (scoped to one garage/row for "Check now"; clears the host cache on each status write; the `domains.check` job keeps its own repo in `src/lib/jobs/handlers/domains-check.ts`) |
| `src/lib/booking-page/qr.ts` | `qrMatrix`, `qrSvg(text, {title})`, `qrPng(text, scale)` (`uqr` + zlib; no external service) |
| `src/lib/tenancy/resolve.ts` (+) | `HostGarage` gains `embedOrigins`, `widgetEnabled` (from `settings`); cache on `globalThis`; `clearHostCache({hostnames?, slugs?})` |
| `src/lib/tenancy/garage.ts` (+) | `Garage.askbridgeSiteKey` (set only while the chat is on) |
| `src/lib/askbridge/config.ts` (client-safe) | `ASKBRIDGE_DEFAULT_SCRIPT_URL`, `ASKBRIDGE_SITE_KEY`, `parseAskbridgeSiteKey`, `askbridgeFromSettings`, `askbridgeScriptUrl(env)` (default when unset, `null` when set but invalid), `askbridgeWidgetFor(settings, env)`, `askbridgeAllowedOrigins(freeLinkOrigin, customHostname)` |
| `src/lib/agent-api/handler.ts` (+) | `agentGarageProfile(record)` (the `garage_profile` body) |
| `src/components/askbridge/askbridge-widget.tsx` | `AskbridgeWidget({src, siteKey})`: `next/script` `lazyOnload`, `async`, `data-site` (Askbridge's install snippet), rendered by the garage layout only when the chat is on and the loader URL is valid |

Routes: `/app/settings/booking-page` (free link + copy + QR, own address: connect / DNS records / status steps / Check now / Try again / remove, embed snippets + allowed sites, branding summary, Askbridge chat; owners edit, others read; in `SetupNav`), `GET /app/settings/booking-page/qr?format=png|svg` (signed-in members, attachment). Server actions in `settings/booking-page/actions.ts` (`connectDomainAction`, `checkDomainAction`, `removeDomainAction`, `saveEmbedOriginsAction`, `saveAskbridgeAction`), each audited (`booking_page.*`, `askbridge.*`) and clearing the host cache. `/api/health` reports `checks.askbridge`.

Askbridge as it ships: [askbridge.md](askbridge.md). Local stub `scripts/askbridge-widget-stub.mjs`; `pnpm test:lighthouse:askbridge` (`lighthouserc.askbridge.cjs`, reports in `output/lighthouse-askbridge/`); `pnpm test:e2e:booking-page` (Playwright project `booking-page-settings`).

## Sign-up and onboarding (Phase 4, P4.4)

As built (`20261028000400_signup.sql`; DECISIONS A100–A112). Done when a new garage is live on its free link in under 15 minutes: `tests/e2e/signup.spec.ts` records about 45 s locally.

### Routes (admin host)

| Route | What |
| --- | --- |
| `/signup` | Step 0: account (name, email, password ≥ 12). `signUpAction` (`src/app/signup/actions.ts`): Turnstile when both keys are set, 5 sign-ups per IP and 3 per email per hour, `supabase.auth.signUp` with `emailRedirectTo` `/auth/confirm?next=/signup/garage` and `user_metadata.display_name` |
| `/signup/check-email` | "Check your email" (no address in the page or URL) |
| `/auth/confirm?token_hash=…&type=email&next=/signup/garage` | GET shows a click-through page; POST (same origin) verifies the token and answers 303 to `/signup/garage` (`?link=invalid` on failure) |
| `/signup/garage` | Steps 1–2 (signed in, email confirmed; otherwise "Sign in to continue"): `GarageWizard` with `searchPlacesAction`, `placeDetailsAction`, `checkSlugAction`, `createGarageAction` (`src/app/signup/garage/actions.ts`) |
| `/app/onboarding` | Redirects to the next step. Outside the admin shell; `requireOnboardingOwner(path, {mfa})` (`src/app/app/onboarding/context.ts`) = owner of the selected garage, MFA verified for steps 4–6 and Done |
| `/app/onboarding/security` | Step 3: link to `/app/mfa/enroll?returnTo=/app/onboarding/security` |
| `/app/onboarding/services` | Step 4: MOT yes/no (`garages.mot_enabled`) and the seeded services to keep (others archived) — `saveOnboardingServicesAction` |
| `/app/onboarding/agreement` | Step 5: `DpaAcceptance` + `acceptDpaAction` (P4.9) |
| `/app/onboarding/team` | Step 6: `InviteForm`, pending invites, "Finish and go live" (`finishOnboardingAction` → `complete_garage_onboarding()`) |
| `/app/onboarding/done` | Booking link (copy), "Book a test", next steps |
| `/signup/invite/[token]` | Route handler: token → httpOnly `af_invite` cookie (path `/signup/invite`, 1 h), 303 to `/signup/invite` |
| `/signup/invite` | Accept: join (right account), sign out (wrong account), password (existing account) or name + password (new account, created confirmed with the service role) — `src/app/signup/invite/actions.ts` |
| `/app/settings/team` | Members (owners: change role, remove), invite form and pending invites (owners/managers: send again, withdraw) |

Proxy: `/signup/*` gets the session refresh `/app` gets (no MFA rules there); the mandatory-enrolment redirect skips `/app/onboarding/*`, which enforces MFA itself. `/app/mfa/enroll` honours `returnTo` and stays (with Continue) for 5 minutes after a factor is verified, so the recovery codes are shown.

### Schema and SQL

| Object | |
| --- | --- |
| `garage_members.role` | + `front_desk` (technician's rights for now) |
| `garage_invites` (tenant) | `email` (lower case), `role` (`manager`/`technician`/`front_desk`), `token_hash` (hex SHA-256, unique), `invited_by`, `expires_at` (7 days from the last send), `accepted_at`, `accepted_by`, `revoked_at`, `sent_count`, `last_sent_at`. One open invite per (`garage_id`, `email`). RLS select policy for owners/managers as a backstop; no staff grants |
| `create_garage(p_user_id uuid, p_garage jsonb) → jsonb` | Service role. Keys `name`, `slug`, `phone` (E.164), `email`, `website`, `google_place_id`, `address {line1, line2, town, postcode}`, `opening_hours [{weekday, opens, closes}]`. Returns `{garage_id, slug, status, opening_hours_from_places, seeded}`. Errors `P0001`: `USER_NOT_FOUND`, `EMAIL_NOT_CONFIRMED`, `INVALID_GARAGE: <field>`, `SLUG_RESERVED`, `SLUG_TAKEN`, `GARAGE_LIMIT_REACHED` (3 per user per 24 h) |
| `complete_garage_onboarding() → text` | Owner of the selected garage (`garage_actor_allowed()`); `DPA_NOT_ACCEPTED` until a DPA row exists; sets `active` and `settings.onboarding.completed_at`; idempotent |
| `create_garage_invite(p_email, p_role, p_token_hash) → jsonb`, `resend_garage_invite(p_invite_id, p_token_hash) → jsonb`, `revoke_garage_invite(p_invite_id) → boolean`, `list_garage_invites() → table` | Owners/managers of the selected garage (`garage_actor_allowed()`); `INVITE_ALREADY_MEMBER`, `INVALID_INVITE: <field>`, `INVITE_NOT_FOUND`; audited `invite.created/resent/revoked` |
| `accept_garage_invite(p_token_hash) → jsonb` | Any signed-in user whose email is the invited one: `{garage_id, role, already_member}`; `INVITE_NOT_FOUND`, `INVITE_EXPIRED`, `INVITE_EMAIL_MISMATCH`, `GARAGE_UNAVAILABLE`; audited `invite.accepted` |
| `list_garage_team() → table (user_id, email, display_name, role, joined_at, is_self)` | Members of the selected garage; emails only for owners/managers (and yourself) |
| `reserved_garage_slugs()`, `garage_booking_prefix(name)`, `auth_email_exists(email)`, `garage_invite_expiry()` | Helpers; service role only |

### App

| Module | Exports |
| --- | --- |
| `src/lib/signup/slug.ts` (client-safe) | `slugify`, `slugProblem`, `slugAlternatives`, `SLUG_PROBLEM_MESSAGES` |
| `src/lib/signup/schema.ts` (client-safe) | `parseAccountForm`, `parseGarageDetails`, `parseSlug`, `parseOpeningHours`, `parseGarageForm`, `createGaragePayload`, `parseInviteForm`, `INVITE_ROLES`, `ROLE_LABELS`, `ROLE_DESCRIPTIONS`, `PASSWORD_MIN_LENGTH` |
| `src/lib/signup/server.ts` | `getSignupSession`, `checkSlugAvailability`, `createGarageForUser` (RPC, admin profile, `af_garage` cookie, host cache cleared), `createGarageError`, `requestIp`, `passSignupHumanCheck`, `onboardingBookingUrl` |
| `src/lib/signup/invite-token.ts` | `generateInviteToken`, `hashInviteToken`, `isInviteToken`, `inviteUrl`, `INVITE_COOKIE` |
| `src/lib/places/*` | `types.ts` (`PlaceSummary`, `PlaceDetails`, `PlacesProvider`), `map.ts` (`mapPlaceDetails`, `placeOpeningHours`, `placeAddress`, `placePhone`, `describeOpeningHours`), `fixtures.ts`, `provider.ts` (`getPlacesProvider`, `resolvePlacesMode`, `createGooglePlacesProvider`, `createMockPlacesProvider`) |
| `src/lib/team/server.ts`, `src/lib/team/actions.ts` | `listTeam`, `listPendingInvites`, `createInvite`, `resendInvite`, `revokeInvite`, `previewInvite`, `composeInviteEmail`; actions `inviteStaffAction`, `resendInviteAction`, `revokeInviteAction`, `changeMemberRoleAction`, `removeMemberAction` |
| `src/components/onboarding/*`, `src/components/team/*` | `OnboardingFrame`, `OnboardingProgress`, `TextField`, `Notice`, `ONBOARDING_STEPS`/`ONBOARDING_PATHS`; `InviteForm`, `ResendInviteButton`, `MemberList`, `PendingInviteList` |

No background job kinds: invite emails are sent inline through `getChannel("email")`.

## Django super admin (Phase 5, P5.1)

`superadmin/` is a separate Django 5.2 service (its own container, sign-in, TOTP, roles and audit trail) that replicates the Vitalos platform Super Admin. ADR: DECISIONS D18; assumptions A400–A414; served at `autofix.vitalos.co.uk/superadmin` through `src/proxy.ts` (`src/lib/superadmin/proxy.ts`: shared-secret gate, only `afsa_*` cookies forwarded); full guide: [superadmin/README.md](../../superadmin/README.md). The Next.js `/admin` (P4.5) keeps working alongside it.

| Piece | Where | What |
| --- | --- | --- |
| Role and views | `supabase/migrations/20261028004000_superadmin_role.sql`, pgTAP 028 | Role `autofix_superadmin` (NOLOGIN in the migration; read-only sessions, `search_path = superadmin`, 10s statement timeout, 10 connections). Schema `superadmin`: one read-only view per table it reads (`garages`, `garage_members`, `garage_invites`, `admin_profiles`, `platform_admins`, `customers`, `vehicles`, `services`, `resources`, `bookings`, `garage_domains`, `jobs`, `reminder_sends`, `messages`, `calls`, `garage_agreements`, `platform_audit_log`, `platform_impersonations`), contact details and registrations masked by `superadmin.mask_phone/mask_email/mask_registration`, no bodies, payloads or token hashes. EXECUTE on `platform_update_garage`, `platform_retry_job`, `platform_request_domains_check` only |
| `platform_request_domains_check(uuid, text)` | same migration | Platform admin at AAL2, reason 5–500, pending/verifying custom domains only; queues `domains.check` with dedupe key `domains.check:platform:<5-minute bucket>`; audited `platform.domain_check_requested` |
| Data access | `superadmin/apps/autofix/models.py`, `router.py`, `db.py` | Unmanaged read-only models on alias `autofix`; `AutofixRouter` never migrates or writes it; `call_platform_function()` is the only write path (allowlisted function, `SET TRANSACTION READ WRITE`, `request.jwt.claims` = the user's linked platform admin with `aal2`) |
| Reads / writes | `apps/autofix/selectors.py`, `services.py` | Page data (Europe/London windows) / role + TOTP + link + reason checks, the platform call and our audit event |
| Status | `apps/autofix/status.py`, `GET /api/platform/v1/status` | ADR-044 product status for the Vitalos Product Pipeline (Bearer `AUTOFIX_STATUS_TOKEN`; counts only) |
| Path mode | `src/lib/superadmin/proxy.ts`, `superadmin/apps/core/wsgi.py`, `ProxyGateMiddleware`, `apps/accounts/stepup.py` | `/superadmin/*` on the admin host is forwarded to `SUPERADMIN_ORIGIN` with `x-autofix-superadmin-proxy`; the container 404s anything without it; cookies `__Secure-afsa_*` on `Path=/superadmin/`; a fresh TOTP code with each change, personal-data view, user change and API token (D18) |
| View as support | `POST /garages/<id>/view-as-support/` | Audited, then redirects to `AUTOFIX_APP_URL/admin/garages/<id>`; the read-only session starts in Autofix under the admin's own sign-in and MFA |

Pages: `/` Overview, `/garages/` (+ `/garages/<id>/?tab=overview|team|bookings|domains|messaging|plan|agreements|audit`), `/jobs/`, `/messaging/`, `/domains/`, `/signups/`, `/activity/`, `/audit/` and `/audit/autofix/`, `/team/`, `/notifications/`, `/settings/`, `/help/`, `/system/health/`, `/api/v1/` (+ `/api/schema/`, `/api/docs/`), `/django-admin/`, `/healthz/`.

## Plans and entitlements (Phase 5, P5.2; D17, D19; DECISIONS A300–A309)

> **For the Django super admin session (P5.1, D18):** `garages.plan` changed in migration `20261029000100_plans.sql`. The check is now `plan in ('essentials','pro')` (was `trial`/`growth`/`front_desk`); existing rows were mapped `growth → essentials`, `front_desk → pro` (chosen), `trial → pro` with a fresh 14-day `trial_ends_at`. New columns: `trial_ends_at timestamptz` (null = not on trial; default `now() + 14 days`, so every new garage starts on the Pro trial), `plan_chosen text` (`essentials`/`pro`/null: what the garage chose or pays for), `plan_changed_at timestamptz`. "On trial" = `plan = 'pro' and trial_ends_at > now()`. What a garage may use now is `public.garage_effective_plan(id)` (an expired, unconverted trial is already `essentials`). Change plans through `platform_update_garage(id, plan, status, reason)` (a plan set by Vitalos counts as chosen, ends the trial and closes open plan requests); open "Request Pro" requests are in `plan_requests` (`status = 'open'`) / `platform_plan_requests()`.

### Schema (`20261029000100_plans.sql`; pgTAP `028_plans`)

| Object | Notes |
| --- | --- |
| `garage_subscriptions` (tenant, one per garage) | `provider` (`mock`/`stripe`), `customer_ref`, `subscription_ref`, `status` (`none`/`incomplete`/`trialing`/`active`/`past_due`/`unpaid`/`cancelled`), `plan`, `extra_sites` (0–100), `current_period_end`, `cancel_at_period_end`. Owners read; service role writes (`apply_billing_subscription()`) |
| `plan_requests` (tenant) | `requested_plan`, `requested_by`, `note` (≤ 500), `status` (`open`/`done`/`withdrawn`), `handled_at`, `handled_by`; one open per garage. Owners read; written by `request_plan_change()`, `choose_essentials()`, the billing webhook and `platform_update_garage()` |
| `usage_events` (tenant) | `metric` (`sms_segments`/`ai_minutes`), `quantity`, `period_month` (garage-local month), `occurred_at`, `source_key` (unique per garage + metric: counts once). Owners/managers read; `record_usage()` writes |
| `billing_usage_reports` (tenant) | per `period_month` + `metric`: `plan`, `used`, `allowance`, `overage`, `status` (`recorded`/`reported`/`not_billable` while the allowance is a placeholder), `provider_ref`. Owners read; `close_usage_month()` writes |
| `billing_webhook_events` (platform) | `event_id` pk, `provider`, `type`, `target_garage_id`, `outcome`; ids only. Service role |

| SQL | Who | What |
| --- | --- | --- |
| `plan_feature_plan(feature) → text` | authenticated, service | `essentials`/`pro`; `22023 UNKNOWN_FEATURE` otherwise. Same list as `FEATURES` in `src/lib/plans/features.ts` (unit test compares) |
| `garage_effective_plan(garage) → text` | service (and inside definer functions) | `essentials` for an expired trial whose `plan_chosen` isn't `pro`, else `plan` |
| `garage_has_feature(garage, feature) → boolean` | authenticated (false for non-members), service | **Use in every Pro table's insert/update/delete policy**: `with check (garage_id = (select public.current_garage_id()) and public.garage_has_feature(garage_id, '<feature>'))`. Select policies do **not** check the plan, so Pro data stays readable (read-only) after a downgrade |
| `require_garage_feature(garage, feature)` | authenticated, service | raises `P0001 PLAN_REQUIRED: <feature>`; call first in Pro-only SQL functions |
| `expire_plan_trials(now) → int` | service | job `plans.expire_trials` (daily cron): `plan := coalesce(plan_chosen, 'essentials')`, trial cleared, audited `plan.trial_ended`. Deletes nothing |
| `request_plan_change(plan, note) → plan_requests`, `choose_essentials() → jsonb` | owner of the selected garage (`garage_actor_allowed()`, AAL2 when enrolled) | Request Pro; move to Essentials now (`BILLING_PORTAL_REQUIRED` while a Stripe subscription is live). Audited |
| `apply_billing_subscription(garage, provider, customer_ref, subscription_ref, status, plan, period_end, extra_sites, cancel_at_period_end) → jsonb` | service | active/trialing/past_due Pro → `plan = pro`, chosen, trial over; cancelled/unpaid → Essentials (after a running trial). Audited `plan.billing_changed` |
| `claim_billing_webhook_event(id, provider, type) → boolean`, `finish_billing_webhook_event(id, garage, outcome)` | service | once per event |
| `record_usage(garage, metric, quantity, source_key, at) → boolean` | service | idempotent by source key; never raises for an unknown garage |
| `garage_usage_month(month) → table(metric, quantity)` | owners/managers of the selected garage | |
| `close_usage_month(garage, month, metric, allowance) → billing_usage_reports` | service | job `billing.close_usage` (daily cron, closes last month) |
| `platform_plan_requests(limit)` | platform admins (AAL2) | open requests for `/admin` |

### App

| Module | Exports |
| --- | --- |
| `src/lib/plans/features.ts` (client-safe) | `PLANS`, `PLAN_NAMES`, `FEATURES` (key → `{plan, label, description, href?}`), `Feature`, `PRO_FEATURES`, `ESSENTIALS_FEATURES`, `isFeature`, `featurePlan`, `proFeatureForPath` |
| `src/lib/plans/entitlements.ts` (client-safe) | `effectivePlan(state, now)`, `hasFeature(state, feature, now)`, `isOnTrial`, `trialDaysLeft`, `planLabel`, `PlanRequiredError` (403 `PLAN_REQUIRED`), `planRequiredBody(feature)`, `planRequiredMessage`, `isPlanRequiredDatabaseError(error)` |
| `src/lib/plans/server.ts` | `garagePlan(garage)`, `garageHasFeature(garage, feature)`, `requireFeature(garage, feature)` (throws), `requireAdminFeature(admin, feature)`, `featureProblem(admin, feature)` (form-state message or null), `planRequiredResponse(feature)`, `featureGuard(garage, feature)` (route handlers: null or the 403) |
| `src/lib/plans/config.ts` (client-safe) | `getPlansConfig(env)` (**prices and allowances are placeholders, `null` until set by env**: `PLAN_*`), `allowanceFor`, `formatPlanPrice`, `PLAN_CONFIG_ENV` |
| `src/lib/plans/usage.ts` | `recordUsage({garageId, metric, quantity, sourceKey, at})` (service role, never throws), `loadUsageMonth(client, {plan, monthFirst})`, `usageLine` |
| `src/lib/plans/jobs.ts` | handlers `plans.expire_trials`, `billing.close_usage` (both in the `daily` cron) |
| `src/lib/messaging/metering.ts` | `meterSmsChannel()`: `getChannel("sms")` records `sms_segments` (source `sms:<idempotencyKey>`) after each successful send; never blocks. WhatsApp/email not metered (A303) |
| `src/lib/billing/*` | `BillingProvider` (`startUpgrade`, `openPortal`, `setExtraSites`, `parseWebhook`), `getBillingProvider(env)` (Stripe **test mode only** when `BILLING_PROVIDER=stripe` + `sk_test_` key + `whsec_` + `STRIPE_PRICE_PRO`; else the mock), `getBillingReadiness`, `createStripeBillingProvider`, `verifyStripeSignature`, `signStripePayload`, `applyBillingEvent`, `loadSubscription` |
| `src/components/plans/*` | `ProBadge`, `ProLockedCard({feature, canUpgrade, hasExistingData})`, `ProLockedPage({feature, title, canUpgrade})`, `PlanComparison`, `UsageMeter` |
| `src/components/admin-ui/admin-nav.tsx` | `defaultAdminNav({…, lockedFeatures})`; **`GROW_NAV_ITEMS`** (Grow group) and **`PRO_SETUP_NAV_ITEMS`** (Setup): each Pro feature adds `{feature, label, href, icon}` when its route exists; locked items keep their link with a "Pro" badge |

Routes: `/app/settings/plan` (current plan, trial days left, usage meters, Essentials vs Pro `#compare`, owners: Upgrade/Request Pro, Manage billing, Move to Essentials; actions in `settings/plan/actions.ts`), `POST /api/webhooks/billing/stripe` (signature on the raw body; 503 until configured). `/admin` lists open plan requests; `/admin/garages/[id]` shows trial, chosen plan, subscription and the open request.

**How every Pro feature gates (P5.3–P5.12):** (1) pages: `if (!garageHasFeature(admin.garage, f)) return <ProLockedPage feature={f} … canUpgrade={admin.role === "owner"} hasExistingData={…} />` (reads of existing rows may still render below it); (2) server actions: `featureProblem(admin, f)` / `requireAdminFeature`; (3) `/api/admin/*` and public garage-host routes: `featureGuard(garage, f)` → 403 `{code: "PLAN_REQUIRED", feature, plan: "pro", message}`; (4) SQL: `require_garage_feature()` in functions, `garage_has_feature()` in write policies; (5) the tenancy suite covers every new table (`FIXTURES`, and `ROLE_LIMITED_READS` for role-limited select policies).

## AI front desk on Pro (Phase 5, P5.12; DECISIONS A382–A389)

### Schema (`supabase/migrations/20261029001200_ai_front_desk.sql`; pgTAP `038_ai_front_desk`)

| Object | Notes |
| --- | --- |
| `agent_tokens.audience` (+) | `workforce` (default) or `askbridge`. Check: an `askbridge` token's scopes ⊆ `list_services`, `available_slots`, `garage_profile`. Existing rows: `askbridge` when their scopes were already a subset of those three, else `workforce` (A382) |
| `agent_tokens.scopes`, `agent_call_log.tool` (checks replaced) | add `report_usage`. Existing workforce tokens holding all six P4.2 tools gain `report_usage` (A383) |
| `ai_front_desk_settings` (tenant, one row per garage, pk `garage_id`) | `enabled`, `enabled_at`, `updated_by`, timestamps. Members of the selected garage read (no plan check, so it stays readable after a downgrade); no staff table grants: written only by `set_ai_front_desk()`; service role reads/writes |

| SQL | Who | What |
| --- | --- | --- |
| `issue_agent_token(p_garage_id, p_name, p_scopes, p_token_hash, p_audience) → jsonb` | service role | New overload. `workforce` needs Pro (`require_garage_feature(…, 'ai_front_desk')` → `P0001 PLAN_REQUIRED: ai_front_desk`). Null scopes: the six P4.2 tools for workforce (unchanged default), the three read-only tools for askbridge. Returns `audience`, never the hash. `22023` for an unknown audience |
| `issue_agent_token(p_garage_id, p_name, p_scopes, p_token_hash) → jsonb` | service role | P4.2 signature kept; now issues `workforce` tokens through the overload (so it also needs Pro) |
| `list_agent_tokens()` | owners/managers of the selected garage | Recreated with an extra `audience` column |
| `set_ai_front_desk(p_enabled boolean) → jsonb` | **owner** of the selected garage (`garage_actor_allowed()`, AAL2 when enrolled; else `42501`) | Switching on needs Pro (`PLAN_REQUIRED`); off is always allowed. Upserts the row; audited `ai_front_desk.enabled` / `ai_front_desk.disabled` |
| `ai_front_desk_hand_off(p_garage_id) → boolean` | service role | True when the garage is `active`/`onboarding`, on Pro (`garage_has_feature`) and switched on. Used by the voice webhook |

No booking function is replaced (`create_booking*`, `available_slots*`, `staff_available_slots*` untouched).

### App

| Module | Exports |
| --- | --- |
| `src/lib/agent-api/schemas.ts` (+) | `agentTools` gains `report_usage`; `agentTokenAudiences`, `AgentTokenAudience`, `isAgentTokenAudience`, `ASKBRIDGE_TOOLS`, `AGENT_PRO_FEATURE`; error code `PLAN_REQUIRED` (403, message = `planRequiredMessage("ai_front_desk")`); `AgentError.feature/plan`; `reportUsageInputSchema` (strict: `conversationId` `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, `channel` `call`/`whatsapp`, `minutes` 0 < m ≤ 600, `endedAt` ISO with offset), `AGENT_MAX_USAGE_MINUTES`, `AGENT_USAGE_MAX_AGE_DAYS` (31), `AgentUsageReport` |
| `src/lib/agent-api/store.ts` (+) | `AgentTokenRecord.audience` and `.garage.plan` (`PlanState`); `AgentApiStore.recordAiMinutes({garageId, conversationId, minutes, endedAt})` → `recorded`/`replayed` (with the stored minutes)/`failed` (calls `recordUsage()`, then reads `usage_events` to tell a repeat from a failure); `aiUsageSourceKey(id)` = `ai:<id>`; `issueAgentToken({…, audience})` (default `workforce` with all seven tools; `PlanRequiredError` for an Essentials garage); `AiMinutesResult` |
| `src/lib/agent-api/handler.ts` (+) | Pipeline: token → garage status → **plan** (workforce + not Pro → `PLAN_REQUIRED`, uses `hasFeature()` on the token's garage) → askbridge tool guard → scope → limits → body → tool. Tool `report_usage` (201 counted / 200 `replayed` / 422 `endedAt` outside the last 31 days or > 5 min ahead / 503 when it could not be stored). Rate limit 600 per 10 min per token |
| `src/app/api/agent/v1/report_usage/route.ts` | one line, like the other tools |
| `src/lib/ai-front-desk/hand-off.ts` (client-safe) | `AI_FRONT_DESK_ENV`, `parseWorkforceVoiceTarget`, `workforceVoiceTarget(env)` (`WORKFORCE_VOICE_SIP_URI`, `sip:`/`sips:` only), `workforceSipUri(target, {garageId, callSid})` (adds `X-Autofix-Garage`, `X-Autofix-Call-Sid` SIP headers), `WorkforceConnection`, `workforceConnectionStatus` |
| `src/lib/ai-front-desk/server.ts` | `usageMonthFirst(garage, now)`, `loadAiFrontDeskSettings`, `listAgentTokens` (RLS client → `AgentTokenRow[]`), `workforceConnection(tokens, env)`, `loadAiMinutesThisMonth(client, garage, now)` (`loadUsageMonth()` → `.ai`) |
| `src/lib/ai-front-desk/forms.ts` (client-safe) | `IssueTokenState`, `initialIssueTokenState`, `parseTokenName`, `TOKEN_NAME_MAX`, `AI_FRONT_DESK_MESSAGES` |
| `src/lib/calls/twiml.ts` (+) | `VoiceStep` gains `agent`; `agentDialTwiml({sipUri, actionUrl})` (`<Dial answerOnBridge action=?step=agent><Sip>…</Sip></Dial>`) |
| `src/lib/messaging/twilio-webhooks.ts` (+) | `TwilioWebhookRepo.aiFrontDeskHandOff?` and `.findCallId?` (optional: absent = never hand off); `TwilioWebhookDeps.workforceVoiceTarget?`; hook `aiFrontDeskTarget()`; new step handler for `?step=agent` |
| `src/lib/messaging/twilio-webhook-repository.ts` (+) | `aiFrontDeskHandOff` (rpc `ai_front_desk_hand_off`), `findCallId` |
| `src/components/admin-ui/admin-nav.tsx` (+) | `PRO_SETUP_NAV_ITEMS` entry `{feature: "ai_front_desk", label: "AI front desk", href: "/app/settings/ai-front-desk", icon: Headset}` |

Voice flow additions (`POST /api/webhooks/twilio/voice`):

| Request | Event key | Writes | Answer |
| --- | --- | --- | --- |
| incoming call, no own phone to ring (or our forward came back), **hand-off on** | `voice:<CallSid>:<status>` | `calls` row `missed = true`; **no** `calls.text_back` | `<Dial timeout=20 answerOnBridge action=?step=agent><Sip>$WORKFORCE_VOICE_SIP_URI?X-Autofix-Garage=<garage id>&X-Autofix-Call-Sid=<CallSid></Sip></Dial>`; outcome `call_ai_front_desk` |
| `?step=dial` missed (busy/no-answer/failed/canceled), **hand-off on** | `voice:<CallSid>:dial` | `dial_status`, `missed = true`; no text-back | the same `<Sip>` dial; outcome `dial_missed_ai_front_desk` |
| `?step=agent` (`DialCallStatus` of the Workforce leg) | `voice:<CallSid>:agent` | missed statuses: `calls.text_back` queued (by CallSid → call id) | missed: the voicemail TwiML (`agent_missed`); answered: `<Hangup/>` (`agent_answered`) |

"Hand-off on" = `WORKFORCE_VOICE_SIP_URI` valid **and** `ai_front_desk_hand_off(garage)`; if the check throws, the Essentials flow runs (a call is never lost to it). The garage's own phone is still rung first.

**WhatsApp**: no hand-off in code. The hook point is `inbound()` in `src/lib/messaging/twilio-webhooks.ts`, after the inbound WhatsApp message is stored: for a garage where `ai_front_desk_hand_off()` is true, queue a job that forwards the stored message to Workforce's WhatsApp endpoint (signed, like the Askbridge sync), and Workforce replies through the agent API / messages pipeline. Not built until Workforce publishes that endpoint (Waiting on Temitope). Until then WhatsApp behaves as today on every plan; Workforce still reports any WhatsApp minutes with `report_usage` (`channel: whatsapp`).

Routes:

| Route | Who | What |
| --- | --- | --- |
| `POST /api/agent/v1/report_usage` | Workforce (`workforce` token with the `report_usage` scope, garage on Pro) | `{conversationId, channel, minutes, endedAt}` → `{usage: {conversationId, channel, minutes, replayed}}` |
| `/app/settings/ai-front-desk` | members (read); owner (switch); owners/managers (tokens, minutes) | Pro: switch (`Switch` submits `setAiFrontDeskAction`), Workforce connection (`Calls` ready or waiting, token status, last used), Tokens for Workforce (`IssueTokenForm` → `issueWorkforceTokenAction`, raw token shown once with Copy; list with audience + Live/Revoked; `revokeAgentTokenAction`), This month (`UsageMeter` for `ai_minutes`, link to Plan). Essentials: `ProLockedPage` + "Missed calls still get a text back and can leave a voicemail on Essentials." |

Server actions (`settings/ai-front-desk/actions.ts`, all through `requireSetupContext()` so MFA is done this session; the garage is the selected garage):

| Action | Who | Gate | Audit |
| --- | --- | --- | --- |
| `setAiFrontDeskAction(formData)` | owner | on: `featureProblem(admin, "ai_front_desk")` then `set_ai_front_desk()` (Pro in SQL); off: always | in SQL |
| `issueWorkforceTokenAction(state, formData)` | owners, managers | `featureProblem` + SQL `PLAN_REQUIRED`; name 1–80 chars | `agent_token.issued` (id, name, audience; never the token) |
| `revokeAgentTokenAction(formData)` | owners, managers | none (revoking works on any plan) | `agent_token.revoked` |

No agent-token UI existed before (tokens were issued only by Vitalos with the service role), so this page is the token UI. Askbridge tokens, if any, are listed there too with an "Askbridge chat" badge; the page only issues Workforce tokens.

Jobs: none new (the existing `calls.text_back` is reused; `billing.close_usage` closes AI minutes as before).

Env: `WORKFORCE_VOICE_SIP_URI` (server only, `.env.example` under `# P5.12`). `playwright.garage.config.ts` passes a local-only `AGENT_TOKEN_PEPPER` to the production server so the e2e can issue tokens.

## Campaigns (Phase 5, P5.5; DECISIONS A326–A333)

### Schema (`supabase/migrations/20261029000500_campaigns.sql`; pgTAP `031_campaigns`)

| Object | Notes |
| --- | --- |
| `campaigns` (tenant, Pro) | `name` (1-80), `starter` (`winter_check`/`summer_aircon`/`win_back`/`mot_month`/null), `segment jsonb` (checked by `campaign_segment_problem()`), `template` (text/WhatsApp, 1-1000), `email_subject` (1-150), `email_template` (null = `template`, ≤ 2000), `service_id` (the service the link opens; composite FK, set null), `status` (`draft` → `scheduled` → `sending` → `sent`; `scheduled`/`sending` → `cancelled`), `send_at`, `recipients`, `scheduled_at`, `scheduled_by`, `finished_at`, `cancelled_at`, `created_by` (default `auth.uid()`). Members read (any plan); owners/managers insert, update and delete **drafts only**, with `garage_has_feature(garage_id, 'campaigns')` (column grants: name, starter, segment, template, email_subject, email_template, service_id; never status) |
| `campaign_sends` (tenant, child) | one row per recipient, unique (`garage_id`, `campaign_id`, `customer_id`): `vehicle_id` (the car the message is about), `channel` (the customer's, when claimed), `send_at`, `status` (`scheduled`/`sending`/`sent`/`delivered`/`failed`/`cancelled`/`skipped`), `skip_reason`, `claimed_at`, `message_id` (→ `messages`), `provider_msg_id`, `link_token_hash` (SHA-256 hex of the `/c/{token}` token) + `link_expires_at` (30 days), `opened_at`, `booking_id` (unique per garage: one send per booking), `body`, `sent_at`, `delivered_at`, `error_code`. Members read (any plan); no staff writes (service role and the definer functions below) |
| trigger `customers_cancel_campaign_sends` | after update of `opted_out_at`/`anonymised_at`/`reminder_consent` on `customers`: that customer's `scheduled` campaign sends become `cancelled` (`opted_out`/`anonymised`/`no_consent`) in the same transaction. Covers STOP (`apply_messaging_keyword` → `opt_out_customer`), the unsubscribe link/form and staff changes without touching their functions |
| trigger `messages_campaign_send_status` | after update of `messages.status` to `delivered`/`failed`: the campaign send linked by `message_id` follows (Twilio status webhook unchanged) |

| SQL | Who | What |
| --- | --- | --- |
| `campaign_segment_problem(segment) → text` | authenticated, service | null when valid, else the reason. Keys: `car_age_min`/`car_age_max` (0-60 years, by `vehicles.year` in the garage's year), `mot_months` (1-12, distinct), `not_seen_months` (1-120), `service_id` + `service_history` (`had`/`never`), `channels` (subset of sms/whatsapp/email). Mirrors `campaignSegmentSchema` |
| `campaign_audience(garage, segment, now)` | internal (no grants) | consent (`reminder_consent`, not opted out, not anonymised), an address for the customer's channel, a car matching the car filters (most recently booked first); last visit = latest past booking that went ahead or `last_service_at` (never seen counts as not seen; a booking coming up excludes from "not seen"); `MOT_DISABLED` when MOT months are used while `mot_enabled` is off |
| `preview_campaign_audience(segment, limit) → (total, customer…, registration, last_visit)` | owners/managers of the selected garage (`garage_actor_allowed()`), Pro (`require_garage_feature`) | live count and up to 50 rows; one row with total 0 when nobody matches |
| `schedule_campaign(campaign, send_at) → campaigns` | owners/managers, Pro | draft only; send time now-5 min … +366 days; freezes the audience into `campaign_sends` (idempotent per customer), `EMPTY_AUDIENCE` when none, queues `campaigns.send` for the send time (dedupe `campaigns.send:<garage>:<campaign>`), audited `campaign.scheduled` |
| `cancel_campaign(campaign) → campaigns` | owners/managers (any plan: stopping is always allowed) | scheduled sends → `cancelled` (`campaign_cancelled`); audited `campaign.cancelled` |
| `claim_campaign_sends(garage, now, limit) → rows` | service | like `claim_reminder_sends`: `for update skip locked` batches; re-checks at claim time (`campaign_cancelled`, `anonymised`, `opted_out`, `no_consent`, `no_address`, `vehicle_changed`, `mot_disabled`, `expired` > 7 days late); **an Essentials garage claims nothing and its due sends are skipped `plan_required`**; suspended/cancelled garages claim nothing; campaigns with nothing left scheduled become `sent` |
| `attribute_campaign_booking(garage, send, booking) → boolean` | service | credits a booking to a send that went out when the booking (not cancelled/no-show/trashed) is for the send's own customer and car (create_booking matched them by phone and registration, as A52); one send per booking; a later booking replaces a cancelled one. **`create_booking()` is not redefined**: the booking flow calls this right after a successful create |
| `campaign_results(campaign?) → (campaign_id, recipients, scheduled, sent, delivered, opened, failed, skipped, bookings, pence)` | members of the selected garage (any plan) | pence = issued/paid invoice totals of credited bookings, else `bookings.price_pence` (as `reminder_won_back()`) |

### App

| Module | Exports |
| --- | --- |
| `src/lib/campaigns/segment.ts` (client-safe) | `CampaignSegment`, `campaignSegmentSchema` (zod), `segmentFromForm(formData, {motEnabled})`, `parseStoredSegment`, `describeSegment`, `segmentUsesMot`, `CAMPAIGN_CHANNELS`, `CHANNEL_NAMES`, `MONTH_NAMES`, `NOT_SEEN_CHOICES` |
| `src/lib/campaigns/templates.ts` (client-safe) | `CAMPAIGN_PLACEHOLDERS` (`{first_name}` `{vehicle}` `{reg}` `{link}` `{garage}`), `checkCampaignTemplate`, `campaignSampleValues`, `STARTERS`/`CAMPAIGN_STARTERS`/`availableStarters`, `starterSegment`, `starterService`, `nextMonth` |
| `src/lib/campaigns/compose.ts` | `ClaimedCampaignSend`, `composeCampaign` (renderTemplate with the opt-out line on SMS/WhatsApp; email subject + "Stop reminders: <signed link>") |
| `src/lib/campaigns/send.ts` | `sendGarageCampaigns` (send window, claim, token, compose, `messages` row, `getChannel` send, result handling as reminders/A14), `campaignLinkPath`, `CampaignSendRepo` |
| `src/lib/campaigns/repository.ts` | `createSupabaseCampaignSendRepo` (service role) |
| `src/lib/campaigns/open-link.ts` | `openCampaignLink`, `handleCampaignLinkRequest` (GET `/c/{token}`), `createSupabaseCampaignLinkRepo`, `attributeCampaignBooking` |
| `src/lib/campaigns/admin.ts` | `loadCampaigns`, `loadCampaign`, `loadCampaignResults`, `totalResults`, `previewAudience` (masked contacts), `loadRecipients`, `loadCampaignServices` |
| `src/lib/campaigns/test-send.ts` | `sendCampaignTest` ("Send me a test": member's own mobile, else email; rate limit shared with reminder tests; audited `campaign.test_sent`) |
| `src/lib/campaigns/view.ts` (client-safe) | `campaignStatusPill`, `recipientPill`, `SKIP_REASON_LABELS`, `formatSendTime`, `localInputValue` |
| `src/lib/jobs/handlers/campaigns-send.ts` | `campaigns.send` handler (fan-out to garages with due sends, per-garage send, quiet-hours deferral to `nextSendWindow`, rate-limit/retry like `reminders.send`), `garagesWithDueCampaignSends` |

Shared files touched (one line or entry each): `JOB_KINDS` (`campaigns.send` after `reminders.send`), the registry, `campaignsSendPayload`, `cron.ts` (`campaigns.send` every 10 minutes and in `daily`), `GROW_NAV_ITEMS` (Campaigns, `Megaphone`), `BookingDraft.campaignSendId` + the sealed-draft schema, `booking-flow/actions.ts` (forget it with the car; call `attributeCampaignBooking` after a successful create), `next.config.ts` (`/c/:token` gets `Referrer-Policy: no-referrer`), `FIXTURES` (two entries), one Playwright project and one package.json script.

### Routes

| Route | What |
| --- | --- |
| `/app/campaigns` | results across campaigns (sent, links opened, bookings won, revenue won), ready-made starting points (Winter check, Summer air-con, Win-back, MOT month only with MOTs on), the list. Essentials: `ProLockedPage` with earlier campaigns listed read-only |
| `/app/campaigns/new?starter=…` | editor: name; segment builder (car age, MOT months, last visit, service history, channels) with a live count and preview (names, masked numbers, plate chips; registrations never in URLs); `TemplateEditor` with the 160-character counter and opt-out line; email subject and wording with preview; the service the link opens. Owners/managers with MFA (`requireSetupContext`) |
| `/app/campaigns/[id]` | draft: editor + "Send" (now, or a date/time in UK time; the hint explains 09:00-19:00 Mon-Sat), "Send me a test", delete. Scheduled/sent: results, recipients (masked, plate chip, status incl. skip reason and Booked), the message, the segment in words, "Stop sending" |
| Server actions (`campaigns/actions.ts`) | `saveCampaignAction`, `previewAudienceAction`, `scheduleCampaignAction` (send now drains `campaigns.send` after the response), `cancelCampaignAction`, `deleteCampaignAction`, `sendCampaignTestAction`. Each: role (owner/manager), `featureProblem(admin, "campaigns")` (cancel excepted), zod/explicit validation, garage from the session only |
| `GET /c/{token}` on the garage host (`src/app/%5Fsite/[garageId]/c/[token]/route.ts`) | hashed token lookup in the host garage's sends that went out, 30-day expiry, first open recorded, sealed `af_booking` draft with car (+ MOT date when MOT is on), service and `campaignSendId`; 303 to `/time` or `/service`; problems → `/r?link=…`; rate limited 30/10 min per IP; `no-store`, `no-referrer`, `noindex` |

### Job

`campaigns.send` (payload `{garageId?}`): queued by `schedule_campaign()` for the send time, and by cron (`/api/cron/campaigns.send` every 10 minutes on Vercel Pro; part of `daily` on Hobby). Without a garage it fans out to garages with due sends (dedupe per 10-minute slot); with a garage it sends inside the window or re-queues itself for `nextSendWindow` (dedupe per window). SMS are metered by P5.2 in `getChannel("sms")`.

## Digital health checks (Phase 5, P5.3; DECISIONS A310–A317)

### Schema (`supabase/migrations/20261029000300_health_checks.sql`; pgTAP `029_health_checks`)

| Object | Notes |
| --- | --- |
| `health_checks` (tenant) | One per booking (`unique (garage_id, booking_id)`, composite FK to `bookings`, cascade). `status` `draft` → `sent` → `responded`; `summary` (≤ 1000), `mileage`; link: `token_hash` (hex SHA-256, unique), `token_expires_at` (14 days), `sent_at`, `sent_by`, `sent_count`, `sent_channel`, `last_message_id` (→ `messages`); `first_viewed_at`, `responded_at`, `approved_total_pence`; `invoice_id` (→ `invoices`, set null), `invoiced_at`, `invoiced_by`. Policies: members of the selected garage read (no plan check); members on Pro update `summary`/`mileage` (column grants) while draft or sent. Inserts only through `start_health_check()` |
| `health_check_items` (tenant) | Checklist lines, composite FK to the check (cascade). `section` (`tyres`, `brakes`, `lights`, `wipers`, `fluids`, `suspension`, `exhaust`, `battery`, `mot`, `other`), `label`, `position`, `mot_related`, `rating` (`red`/`amber`/`green`/`not_checked`), `note`, `recommended_work` + `price_pence` (both or neither, ≤ £100,000), `decision` (`approved`/`declined`) + `decided_at`. Members read; members on Pro insert, update (`label`, `rating`, `note`, `recommended_work`, `price_pence`) and delete undecided lines while the check is draft or sent. The decision is written only by `record_health_check_decisions()`. Approved rows are the booking's extras record |
| `health_check_media` (tenant) | Photos (`image/jpeg`, `png`, `webp`, ≤ 10 MB) and videos (`video/mp4`, `video/quicktime`, ≤ 50 MB) for the check (`item_id` null) or a line. `object_path` must be `<garage_id>/health-checks/<check_id>/<uuid>.<ext>` (check constraint on the row's own garage and check). `uploaded` is set by the server (service role) once the object exists with the declared type and size. Members read; members on Pro insert (as themselves, `uploaded = false`) and delete while the check is editable; no staff update |
| Storage bucket `health-check-media` | **Private**, 50 MB limit, the five MIME types above. Policy "garage staff read health check media": select for staff of the selected garage in their own folder (`(storage.foldername(name))[1] = current_garage_id()`). No insert policy: uploads use signed upload URLs created by the server for one exact path after the RLS insert of the media row. Served only through signed URLs (10 minutes in the admin, signed with the member's own client; 15 minutes on the customer page, service role) |

| SQL | Who | What |
| --- | --- | --- |
| `start_health_check(booking) → uuid` | staff of the selected garage (`garage_actor_allowed()`), Pro | The booking's check, created the first time with the default checklist (`health_check_default_items(mot_enabled)`: 20 lines, 25 with MOT on). Idempotent. `PLAN_REQUIRED: health_checks`, `BOOKING_NOT_FOUND`, `BOOKING_CLOSED` (cancelled / no-show). Audited `health_check.started` |
| `claim_health_check_send(garage, check, member, token_hash, expires_at, body, provider) → jsonb` | service role | Before the server sends: member is owner/manager/front desk, garage has the feature, check not responded and has a rated line, customer not anonymised, texts/WhatsApp not opted out, address on their channel, a messaging number for texts. Stores the link hash and expiry (an earlier link stops working), marks the check `sent`, inserts the outbound `messages` row (`sending`, on the booking). Refuses a body that contains a `/hc/<token>`. `{status: claimed, message_id, channel, to}` or `{status: skipped, reason}`. Audited `health_check.sent` |
| `open_health_check_link(garage, token_hash, now) → jsonb` | service role | `{status: ok, check_id}` / `invalid` / `expired`; notes the first view. Works for an answered check (read-only) until expiry |
| `record_health_check_decisions(garage, check, decisions, now) → jsonb` | service role | The customer's approve/decline for **every** line with recommended work, at the price they saw (`changed` if a price moved). Marks the check `responded` with `approved_total_pence`, adds a `booking_events` note (actor `customer`, `data.source = 'health_check'`) and audits `health_check.responded`. Idempotent (`already`). `closed`, `expired`, `plan_required`, `invalid`, `not_found` |
| `add_health_check_to_invoice(check) → jsonb` | staff with invoice rights (through the existing `save_invoice_draft()`: `garage_actor_allowed()`, AAL2 when enrolled), Pro | Appends the approved lines ("Health check: <work> (<line>)", qty 1, the approved price) to the booking's newest draft invoice, or creates a booking draft with them (a further draft is allowed when an issued invoice exists). Once per check while that invoice exists. Adds a staff `booking_events` note. `{invoice_id, added, created, already}` |
| `health_check_editable(garage, check)`, `health_check_default_items(mot)` | helpers (members / service) | Used by the write policies and `start_health_check()` |

No existing function or migration was changed (`create_booking`, `available_slots*`, invoicing functions untouched).

### App

| Module | Exports |
| --- | --- |
| `src/lib/health-checks/checklist.ts` (client-safe) | `HEALTH_CHECK_SECTIONS`, `SECTION_LABELS`, `HEALTH_CHECK_RATINGS`, `RATING_LABELS`, `STATUS_LABELS`, `LIMITS`, `MEDIA_TYPES`, `mediaProblem`, `mediaObjectPath`, `DEFAULT_CHECKLIST` (unit test compares with the migration), `defaultChecklist`, `visibleItems`, `groupBySection`, `ratingCounts`, `recommendedItems`, `approvedTotalPence`, `formatPounds`, `parsePriceInput`, `penceToInput`, `HEALTH_CHECK_LINK_TTL_DAYS` |
| `src/lib/health-checks/forms.ts`, `decisions.ts` (client-safe) | `parseItemForm`, `parseNewItemForm`, `parseSummaryForm`; `parseDecisions`, `toDatabaseDecisions`, `undecidedItems`, `DECISION_MESSAGES` |
| `src/lib/health-checks/view.ts` (client-safe) | Row → view mappers (`toHealthCheckSummary`, `toChecklistItem`, `toHealthCheckMedia`, `mediaByItem`), `healthCheckStatusLine` |
| `src/lib/health-checks/token.ts` | `createHealthCheckToken` (16 random bytes, base64url, 22 chars), `hashHealthCheckToken`, `isHealthCheckToken`, `healthCheckLinkPath`, `redactHealthCheckLink`, `createHealthCheckSession` / `readHealthCheckSession` (`af_hc`, HMAC with `BOOKING_MANAGEMENT_SECRET` under its own context), `healthCheckCookieOptions` |
| `src/lib/health-checks/server.ts` | `listHealthChecks`, `loadHealthCheck` (RLS), `loadCustomerHealthCheck` (service role, host garage), `loadBookingHealthCheck`, `loadRecentApprovals`, `HEALTH_CHECK_BUCKET` |
| `src/lib/health-checks/send.ts` | `sendHealthCheck` (rate limit 20 / 10 min per member, claim, `getChannel()` on the customer's channel, record result, `booking_events` `notification_sent`), `composeHealthCheckMessage`, `canSendHealthCheck`, `SEND_ROLES` |
| `src/lib/health-checks/link-route.ts` | `handleHealthCheckLinkRequest` (`/hc/<token>`) |
| `src/components/health-checks/*` | `RatingChip`, `RatingSummary`, `RATING_TONES`, `MediaGallery`, `HealthCheckApprovalsPanel` |
| `src/app/app/(protected)/health-checks/actions.ts` | `startHealthCheckAction`, `saveItemAction`, `addItemAction`, `deleteItemAction`, `saveSummaryAction`, `prepareUploadAction`, `finishUploadAction`, `deleteMediaAction`, `sendHealthCheckAction`, `addToInvoiceAction`. Each: `requireStaffWriter` (MFA), `featureProblem(admin, "health_checks")` before any write |
| `src/app/%5Fsite/[garageId]/health-check/actions.ts` | `recordDecisionsAction` (host garage, `af_hc` session, feature check, rate limit 10 / 10 min per check + IP) |

### Routes

| Route | What |
| --- | --- |
| `/app/health-checks` | All checks, newest first (plate, customer, reference, car and time, status line, status badge). Essentials: `ProLockedPage` with existing checks listed below. Nav: Grow → Health checks (`GROW_NAV_ITEMS`) |
| `/app/health-checks/[id]` | Checklist by section as 52px+ disclosure rows (rating radios Red/Amber/Green/Not checked, note, recommended work, `£` price, Take photo / Record video with `capture="environment"`), Add a line, Summary (plate, ratings, note to the customer, mileage, whole-car media), Send to the customer / Send again with a new link, the customer's answer ("Customer approved £X", Add approved work to the invoice / Open the draft invoice). Refreshes every 15 s while sent. Read-only once answered, and for Essentials (with the Pro card) |
| `/app/bookings/[id]` | New "Health check" panel: Start health check (Pro), or the status line ("Customer approved £X") and Open health check |
| `/app` (Today) | "Approved on health checks" panel (phone and desktop) for checks answered today with work approved |
| `GET /hc/<token>` (garage host) | Token → `af_hc` httpOnly cookie (path `/health-check`, 60 min) and 303 to `/health-check`; problems → `/health-check?link=invalid|expired|limited|unavailable`. `Referrer-Policy: no-referrer` (handler and `next.config.ts`), `Cache-Control: no-store`, `X-Robots-Tag: noindex`; 30 opens / 10 min per garage + IP |
| `/health-check` (garage host) | Customer page in the Book/Manage language (garage header and accent): car card, ratings, note, each rated line with photos/video, recommended work and price; Approve / Decline per job, running total, 54px Confirm. After answering: their choices and "You approved £X". `noindex` |

CSP on garage hosts gains `media-src 'self' blob: https:` (and the Supabase origin when it is plain http, i.e. the local stack, also in `img-src`), so signed video URLs play (`src/lib/booking-page/security-headers.ts`, `storageOrigin` from `src/proxy.ts`).

No background jobs: sending is inline through `getChannel()` like staff replies.

## Advanced reports and exports (Phase 5, P5.6; DECISIONS A334–A341)

### Schema (`supabase/migrations/20261029000600_reports.sql`; pgTAP `032_reports`)

| Object | Notes |
| --- | --- |
| `booking_assignments` (tenant) | `garage_id` (default `current_garage_id()`), `booking_id` (composite FK → `bookings (garage_id, id)` on delete cascade, unique per garage), `technician_id → auth.users` (on delete set null), `technician_name` (snapshot, 1–120 chars, kept when the member leaves), `assigned_by`, `assigned_at`. RLS: members of the selected garage read (not plan checked, so readable after a downgrade); no staff write grants: written only by `assign_booking_technician()`. In `FIXTURES` of `tests/integration/tenancy.test.ts` |

No existing table, function or migration is changed. `create_booking*`, `available_slots*` and `staff_available_slots*` are not touched.

### SQL

All `security definer`, `search_path = ''`. Report dates are garage-local and inclusive; the window is `[from 00:00, to + 1 00:00)` in `garages.timezone`, so a clock-change day is 23 or 25 hours long. Errors: `42501 NOT_ALLOWED`, `P0001 PLAN_REQUIRED: advanced_reports`, `22023 INVALID_RANGE` (from > to, or more than 366 days).

| Function | Who | What |
| --- | --- | --- |
| `assign_booking_technician(booking uuid, technician uuid) → jsonb` | owners/managers of the selected garage (`garage_actor_allowed()`: AAL2 when enrolled), Pro | Sets (null: clears) who did the job. Technician must be a member of the garage (`22023 NOT_A_MEMBER`); booking must be the garage's and not trashed (`P0001 BOOKING_NOT_FOUND`). Name snapshot = profile display name, else account display name, else email local part. Audited `booking.technician_assigned` |
| `report_revenue_by_service(from date, to date)` → `(service_id, service_name, bookings, invoiced_pence, estimated_pence, total_pence)` | owners/managers (or service role with `x-garage-id`), Pro | See A334 |
| `report_revenue_by_technician(from, to)` → `(technician_id, technician_name, bookings, invoiced_pence, estimated_pence, total_pence)` | same | Same jobs grouped by `booking_assignments`; `technician_name` null = Unassigned (A335) |
| `report_bay_utilisation(from, to)` → `(resource_id, resource_name, resource_kind, day, open_minutes, booked_minutes)` | same | One row per resource per local day (A336) |
| `report_hours(from, to)` → `(technician_id, technician_name, jobs, measured_jobs, sold_minutes, worked_minutes)` | same | A337 |
| `report_reminder_roi(from, to)` → `(kind, sent, booked, pence, sms_segments)` | same | A338, A339 |
| `report_campaign_roi(from, to)` → `(available, sent, booked, pence)` | same | Feature-detected (A340) |
| `report_window(from, to)`, `report_jobs(garage, from_at, to_at)`, `report_minutes(tstzmultirange)` | no API role (internals) | Caller check + window; the jobs the revenue/hours reports count; minutes in a multirange |

### App

| Module | Exports |
| --- | --- |
| `src/lib/reports/range.ts` (client-safe) | `REPORT_PRESETS` (`this_month`, `last_month`, `last_90_days`, `custom`), `PRESET_LABELS`, `MAX_REPORT_DAYS`, `ReportRange`, `RANGE_PROBLEMS`, `presetRange`, `resolveReportRange({range, from, to}, today)`, `rangeQuery`, `dayCount`, `rangeLabel` |
| `src/lib/reports/csv.ts` (client-safe) | `safeCsvText` (prefixes `= + - @`, tab and CR with `'`), `csvCell`, `toCsv` (UTF-8 BOM, CRLF), `poundsCell` |
| `src/lib/reports/shape.ts` (client-safe) | `REPORT_KINDS` (`revenue-by-service`, `revenue-by-technician`, `bay-utilisation`, `hours`, `reminder-roi`), `isReportKind`, row types and mappers, `revenueTotals`, `utilisationByResource`, `utilisationByWeek`, `hoursTotals`, `efficiency`, `roiTotals`, `smsCost`, `formatMinutes`, `formatPounds`, `formatShare`, CSV builders (`revenueCsv`, `utilisationCsv`, `hoursCsv`, `reminderRoiCsv`), `reportFileName` |
| `src/lib/reports/config.ts` (client-safe) | `smsSegmentCostPence(env)` (`SMS_SEGMENT_COST_PENCE`, placeholder, null until set) |
| `src/lib/reports/server.ts` | `loadRevenueByService`, `loadRevenueByTechnician`, `loadUtilisation`, `loadHours`, `loadReminderRoi`, `loadCampaignRoi`, `loadAllReports`, `ReportLoadError` (`plan_required` / `not_allowed` / `invalid_range` / `failed`). All through the admin's RLS client; nothing takes a garage id |
| `src/lib/reports/export.ts` | `buildReportCsv(client, kind, range, costPerSegment)` |
| `src/lib/reports/assignments.ts` | `loadBookingAssignment`, `loadTeamOptions` (`list_garage_team()`), `assignTechnician`, `ASSIGN_MESSAGES` |
| `src/components/admin-ui/admin-nav.tsx` | `GROW_NAV_ITEMS` gains `{feature: "advanced_reports", label: "Reports", href: "/app/reports", icon: ChartColumn}` |

### Routes

| Route | Who | Notes |
| --- | --- | --- |
| `/app/reports?range=this_month\|last_month\|last_90_days` or `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` | owners/managers on Pro | Essentials: `ProLockedPage` (owner gets "See Pro and upgrade"). Technicians / front desk on Pro: "Reports are for owners and managers", ask the owner. Range picker (preset chips + custom dates), four summary figures, five report panels (tables at 390 first, simple CSS bars with the figure as text), a CSV link on each. Only dates in the query string |
| `GET /api/admin/reports/<kind>?range=…` | owners/managers on Pro | `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="autofix-<kind>-<from>-to-<to>.csv"`, `Cache-Control: private, no-store`. 401 signed out, 404 unknown kind, 403 `PLAN_REQUIRED` (Essentials, also when the database says so mid-session), 403 `NOT_ALLOWED` (other roles), 400 `INVALID_RANGE`. Audited `report.exported` (kind, dates, row count). No registrations in any report or file name |
| `/app/bookings/[id]` "Technician" panel | owners/managers on Pro: a select of the team + Save (`assignTechnicianAction` in `bookings/technician-actions.ts`, `requireStaffWriter`, `featureProblem`); others / Essentials: the assigned name read-only, if any | |

No jobs, no customer-facing pages, no messages.

## Courtesy cars and collection/delivery (Phase 5, P5.8; DECISIONS A350–A357)

### Schema (`supabase/migrations/20261029000800_courtesy_cars.sql`; pgTAP `034_courtesy_cars`)

| Table / column | Columns (all tenant tables: `garage_id uuid not null default current_garage_id() references garages on delete cascade`, RLS on, anon has no grants) |
| --- | --- |
| `courtesy_cars` | `name` (1-60), `registration` (normalised by the `normalise_vehicle_registration` trigger, unique per garage; shown only as a plate chip), `active`, `notes` (≤ 500), `mileage`, `fuel_eighths` (0-8, last reading), `sort`. Members read; owners/managers insert/update/delete through RLS **with `garage_has_feature(garage_id,'courtesy_cars')`**. A car with loans can't be deleted (FK, 23503): switch it off |
| `courtesy_car_loans` | `car_id`, `booking_id` (composite FK, cascade), `customer_id`, `during tstzrange` (`[)`, finite, ≤ 31 days), `status` (`reserved`/`out`/`returned`/`cancelled`), `notes`, `mileage_out`/`fuel_out`/`checked_out_at`/`checked_out_by`, `mileage_in` (≥ out)/`fuel_in`/`returned_at`/`returned_by`, `damage_notes` (≤ 1000), `cancelled_at`/`cancelled_by`/`cancellation_reason`, `created_by`. **`courtesy_car_loans_no_overlap exclude using gist (car_id with =, during with &&) where (status <> 'cancelled')`**. Members read; no staff write grants (functions only) |
| `courtesy_car_requests` | `booking_id`, `customer_id`, `status` (`open`/`confirmed`/`declined`/`withdrawn`), `free_at_request`, `loan_id`, `reason`, `handled_by`/`handled_at`. One live (open/confirmed) per booking. Members read; functions write |
| `collection_delivery_legs` | `booking_id`, `leg` (`collection`/`delivery`), `resource_id` (a `mobile` resource, null when unassigned), `during`, `postcode` (normalised), `address` (≤ 300), `status` (`held`/`unassigned`/`cancelled`), `source` (`customer`/`staff`/`system`), `created_by`, `cancelled_at`. **`collection_delivery_legs_no_overlap exclude using gist (resource_id with =, during with &&) where (status = 'held')`**; one live leg of each kind per booking. Members read; functions write |
| `services` (+) | `collection_delivery boolean default false`. Trigger `services_collection_delivery_guard`: a signed-in member switching it on needs Pro (`PLAN_REQUIRED`); switching off never does; server code/seeds (no `auth.uid()`) are not checked |
| trigger `bookings_courtesy_follow` (after update of `status`, `during` on `bookings`) | Cancelled / no-show: reserved loans → cancelled, live legs → cancelled, open requests → withdrawn. Moved: a reserved loan shifts by the same amount when the car is free then (else it stays and a system note says "choose another car"); live legs are held again for the new times (if that fails the legs are cancelled and noted). Never blocks the booking change |

Van windows (`collection_delivery_windows`): collection `[lower(during) − 2 × mobile_travel_min, lower(during))`, delivery `[upper(during), upper(during) + 2 × mobile_travel_min)` (out and back each way).

Default loan window (`courtesy_car_default_window`): from the booking's `starts_at` to the latest `opening_hours.closes` of that local day, built as `(local date + closes) at time zone garages.timezone` (right on clock-change days), or to `ends_at` if later.

### SQL functions

| Function | Who | What |
| --- | --- | --- |
| `courtesy_car_options(booking, starts?, ends?) → table(car_id, name, registration, free, window_starts, window_ends)` | any member of the selected garage (`garage_actor_allowed()`), Pro | Every active car and whether it is free for the window (default: the booking's day) |
| `reserve_courtesy_car(booking, car, starts?, ends?, notes?) → courtesy_car_loans` | any member, Pro | Per-car advisory lock, then insert; an exclusion violation becomes `COURTESY_CAR_UNAVAILABLE` (P0001). Confirms an open request; booking note; audited `courtesy_car.reserved`. Errors `BOOKING_NOT_FOUND`, `BOOKING_NOT_LIVE`, `COURTESY_CAR_NOT_FOUND`, `INVALID_LOAN: …` |
| `release_courtesy_car(loan, reason?)` | any member, Pro | reserved → cancelled (`LOAN_STATE` otherwise); a confirmed request goes back to open |
| `check_out_courtesy_car(loan, mileage, fuel_eighths, notes?)` | any member, Pro | reserved → out; `COURTESY_CAR_STILL_OUT` while the same car is out on another loan; car mileage/fuel updated |
| `check_in_courtesy_car(loan, mileage, fuel_eighths, damage_notes?)` | any member, Pro | out → returned; mileage can't go down; an early return shortens `during` so the car is free again |
| `decline_courtesy_car_request(request, reason?)` | any member, Pro | open → declined |
| `hold_collection_delivery(booking, postcode, address?) → jsonb` / `release_collection_delivery(booking) → int` | any member, Pro | (Re)hold the van for both legs / cancel them |
| `courtesy_car_free_count(garage, starts, ends) → int` | service role | Free cars for a would-be booking (default window); 0 for Essentials, so the option never appears |
| `request_courtesy_car(garage, booking) → jsonb` | service role, Pro | After `create_booking()`: open request, idempotent per booking, `free_at_request` recorded, booking note |
| `request_collection_delivery(garage, booking, postcode, address) → jsonb` | service role, Pro | After `create_booking()`: idempotent; `{status: held|partial|unassigned, legs, replayed}` |
| internals (no API role): `courtesy_actor_garage`, `courtesy_car_default_window`, `courtesy_cars_free_in`, `courtesy_booking_note`, `courtesy_postcode`, `collection_delivery_windows`, `collection_delivery_hold`, `courtesy_follow_booking`, `guard_service_collection_delivery` | | `collection_delivery_hold` takes the same per-garage advisory lock as `create_booking()` (`public.create_booking:<garage>`), checks `workshop` mode + `services.collection_delivery` (`COLLECTION_NOT_OFFERED`) + `garages.service_area` (`OUTSIDE_SERVICE_AREA`), then picks the first active mobile resource with no live booking and no held leg overlapping each window |

Nothing redefines `create_booking*`, `available_slots*` or `staff_available_slots*`.

**Failure handling for collection/delivery.** The booking is always created first by `create_booking()` and always stands. Legs are held straight after by `request_collection_delivery()` (customer) or `hold_collection_delivery()` (staff). A leg with no free van (or lost to a concurrent hold: the exclusion violation is caught) is stored `unassigned`, the booking gets a system note ("no van free … call the customer"), the garage gets a staff email (`courtesy-extras:<booking>` idempotency key, garage address only, no registration), the leg shows under "Needs your OK" on `/app/courtesy-cars` with "Try the van again" on the booking, and the customer's confirmation says the garage will call. If the attach call itself fails the same staff email and customer wording apply.

### App

| Module | Exports |
| --- | --- |
| `src/lib/courtesy/view.ts` (client-safe, pure) | types `CourtesyCar`, `CourtesyLoan`, `CollectionLeg`, `CourtesyRequest`; `parseCarForm`, `parseLoanReading`, `parseLoanWindow(formData, tz)` (datetime-local in garage time via `zonedInstant`), `parseCollectionForm`, `normaliseCollectionPostcode`, `courtesyErrorCode`/`courtesyErrorMessage`, `courtesyFlash`, `COURTESY_DONE_MESSAGES`, `shapeFleetWeek(cars, loans, monday, tz, now)`, `bookingsWithCourtesyCar`, `parseRange` (PostgREST tstzrange), `localInputValue`, `safeCourtesyReturn`, `withFlash`, `FUEL_OPTIONS`, `fuelLabel`, `formatMiles` |
| `src/lib/courtesy/server.ts` (RLS client) | `loadFleet`, `loadLoansBetween`, `loadLiveLoans`, `loadOpenRequests`, `loadUpcomingLegs`, `loadBookingCourtesy`, `loadCarOptions`, `courtesyBookingIds` (never throws; Today/Diary badge), `CourtesyDataError` |
| `src/lib/courtesy/booking-site.ts` (service role) | `getBookingExtrasOptions(garage, {serviceId, startsAt, durationMin, locationMode})` (never throws), `readBookingExtras(formData, offered, serviceArea, proEnabled)`, `attachBookingExtras(garage, booking, choice)` (never throws; staff email), `extrasSummary` |
| `src/app/app/(protected)/courtesy-cars/actions.ts` | `addCarAction`, `updateCarAction`, `setCarActiveAction`, `deleteCarAction` (owners/managers), `reserveCarAction`, `releaseLoanAction`, `checkOutAction`, `checkInAction`, `declineRequestAction`, `holdCollectionAction`, `releaseCollectionAction` (any member), `setServiceCollectionAction`. All `requireStaffWriter` (MFA), selected garage only, `garageHasFeature` → `?courtesyError=PLAN_REQUIRED`; redirects carry only a flash key (`?courtesy=` / `?courtesyError=`, `#courtesy` on bookings) |
| `src/components/courtesy/courtesy-ui.tsx` | `CourtesyNotice`, `CourtesyCarChip`, `LoanItem`, `LoanReadingForm`, `CarFields`, `LOAN_TONES` |
| `src/components/courtesy/collection-setting.tsx` | `CollectionDeliverySetting` (the switch on Setup · Services · Edit; Pro badge text for Essentials) |
| `src/app/app/(protected)/bookings/[id]/courtesy-panel.tsx` | `CourtesyBookingPanel` (request banner, free cars for the booking's day + "Different times", check out/in, release, collection form/legs/cancel/try again; read-only on Essentials when data exists) |
| `src/app/%5Fsite/[garageId]/_components/booking-extras.tsx` | `BookingExtrasFields` (details step "Extras": courtesy request, collect and deliver + address/postcode; defaults follow state so React's post-action form reset keeps them) |

Additive edits to shared files: `GROW_NAV_ITEMS` (one line, `CarFront`), `JobCard`/`DiaryBooking` optional `courtesyCar` (chip / car icon + accessible label), Today and Diary pages (badge ids), booking page (panel + two flash params), service edit page (setting panel), `DetailsFormState.fieldErrors` (+ `collectionPostcode`, `collectionAddress`), `JustBooked.extras?` (sealed cookie, ≤ 4 lines), `confirmBookingAction` (extras read before, attached after `createBooking()`), details and confirmed pages, `admin-shell.test.tsx` (expects `GROW_NAV_ITEMS` hrefs instead of a fixed list).

### Routes

| Route | What |
| --- | --- |
| `/app/courtesy-cars?week=YYYY-MM-DD` | Fleet: one card per car (state, mileage, fuel, Mon-Sun strip, the week's loans with check out / release / check in), "Needs your OK" (open requests, unassigned van legs), "Collections and deliveries" (from today), "Add a courtesy car" (owners/managers), Edit / on-off / delete per car. Essentials: `ProLockedPage` (+ read-only car list when there are cars) |
| `/app/bookings/[id]#courtesy` | Courtesy car and collection panel |
| `/app/settings/services/[id]#collection-delivery` | "Offer collection and delivery" switch (`?collection=on|off|plan|…`) |
| garage host `/details` | Extras fieldset (Pro and something offered only); `/confirmed/[ref]` lists what happened |

No new jobs, no customer messages (the only new message is a staff email to the garage's own address). No token links, so no `next.config.ts` header rule was needed.

## Payments: deposits, pay-by-link and no-show fees (Phase 5, P5.4; DECISIONS A318–A325)

### Schema (`20261029000400_payments.sql`; pgTAP `030_payments`)

| Object | Notes |
| --- | --- |
| `services.deposit_mode`, `services.deposit_value` (new columns) | `default` (follow the garage), `none`, `fixed` (pence, 100–100000) or `percent` (1–100 of `price_pence`). Trigger `services_deposit_plan_guard` raises `PLAN_REQUIRED: payments` when a member changes them without Pro; other service edits are untouched |
| `payment_accounts` (tenant, one per garage) | `provider` (`mock`/`stripe`), `account_ref`, `status` (`pending`/`active`/`restricted`/`disconnected`), `charges_enabled`, `connected_by`, `connected_at`, `disconnected_at`. **Owners and managers read** (`ROLE_LIMITED_READS`); written only by `apply_payment_account()` and `disconnect_payment_account()` |
| `payment_settings` (tenant, one per garage) | `deposits_enabled`, `default_deposit_mode` (`none`/`fixed`/`percent`), `default_deposit_value`, `deposit_hold_min` (30–180, default 30), `no_show_fee_pence` (null or 100–100000), `updated_by`. Members read; owners/managers insert/update with `garage_has_feature(garage_id, 'payments')` |
| `payments` (tenant) | `kind` (`deposit`/`invoice`/`no_show_fee`), `status` (`pending`/`paid`/`expired`/`cancelled`/`failed`), `amount_pence`, `amount_paid_pence`, `description`, `booking_id`/`invoice_id`/`customer_id` (composite FKs, `on delete set null`), `token_hash` (SHA-256 of the pay-link token, unique), `expires_at`, `provider`, `checkout_ref`, `provider_payment_ref`, `paid_at`, `attention` (`paid_after_release`/`invoice_not_open`/`overpaid`/`amount_mismatch`), `cancelled_reason`, `notified_at`/`notify_channel`/`notify_outcome`, `created_by`. One live (pending or paid) deposit and one live no-show fee per booking (partial unique index). Members read (no plan check); no direct writes |
| `payment_webhook_events` (platform) | `event_id` pk, `provider`, `type`, `target_garage_id`, `outcome`; ids only. Service role |
| Trigger `bookings_payments_follow_status` (on `bookings`, after update of status) | a booking cancelled by staff cancels its pending deposit (the customer's link stops working) |

| SQL | Who | What |
| --- | --- | --- |
| `payment_deposit_amount(garage, service) → int` | service | the deposit in pence or null (deposits off, none, percent of a quote, under £1); capped at £1,000. Mirrored by `depositAmountPence()` (unit test) |
| `create_deposit_payment(garage, booking, provider, token_hash) → payments` | service (the booking flow) | **after** `create_booking()`: the pending deposit, expiring after `deposit_hold_min`; null when none applies (not Pro, no active account for this provider, deposits off, booking not requested/confirmed). A replay rotates the token of the same deposit. Adds a "Waiting for the deposit" note to the booking |
| `expire_pending_deposits(now, garage?) → table` | service | expires pending payments past `expires_at` (500 a call, `skip locked`). An unpaid deposit cancels its booking if still `requested`/`confirmed` (`cancellation_reason = 'Deposit not paid in time'`) through an ordinary status update: the status trigger logs it as a system change and `no_overlap` no longer counts it, so the slot is free |
| `create_payment_request(kind, target, provider, token_hash) → payments` | owners, managers, front desk of the selected garage (`garage_actor_allowed()`, AAL2 when enrolled); Pro; active account | `invoice`: the issued invoice's balance (≥ £1), replacing any open link; `no_show_fee`: the garage's fee for a `no_show` booking (asking again re-issues the same request). Links last 14 days. Audited `payments.link_created` |
| `cancel_payment_request(payment)` | owners, managers, front desk; Pro | pending → cancelled ("Cancelled by the garage", or "Deposit waived by the garage"). Audited |
| `apply_payment_paid(garage, payment, provider, ref, amount, paid_at) → jsonb` | service | once (a repeat returns `already: true`). Invoice: inserts into `invoice_payments` (method `card`, `created_by` = the member who sent the link), invoice `paid` when the balance reaches zero, else part-paid; more than the balance is recorded up to it and flagged `overpaid`; a voided/settled invoice is flagged `invoice_not_open`. Deposit paid after release: `paid_after_release`. Audited `payments.paid` (+ `invoice.marked_paid`/`invoice.part_payment_recorded`) |
| `set_payment_checkout(garage, payment, ref)` | service | stores the Checkout Session id on a pending payment |
| `apply_payment_account(garage, provider, ref, status, charges_enabled, actor)` | service | the owner's connect (`actor` set: needs Pro) or a provider webhook (`actor` null: only the account the garage already holds, never reconnects a disconnected one). Audited `payments.account_<status>` |
| `disconnect_payment_account()` | owner of the selected garage (not plan gated, so Essentials can disconnect) | `disconnected`, charges off |
| `set_service_deposit(service, mode, value)` | owners, managers; Pro | a service's deposit rule. Audited `service.deposit_changed` |
| `claim_payment_webhook_event`, `finish_payment_webhook_event` | service | once per provider event |

`create_booking`, `create_booking_at`, `available_slots*` and `staff_available_slots*` are not replaced. **No double
booking:** the booking is created first by `create_booking()` and holds its resource like any other booking; an unpaid
deposit only ever *removes* a booking (cancelled), never adds one (pgTAP 030: a pending deposit refuses an overlapping
second booking, expiry frees it, the next customer books it).

### App

| Module | Exports |
| --- | --- |
| `src/lib/payments/provider.ts` | **`PaymentsProvider`** (`kind`, `startConnect`, `getAccount`, `createCheckout`, `getCheckout`, `cancelCheckout`, `parseWebhook`), `AccountState`, `ConnectResult`, `CheckoutRequest`, `CheckoutResult`, `CheckoutState`, `PaymentsEvent` |
| `src/lib/payments/index.ts` | `readPaymentsConfig(env)`, `getPaymentsReadiness()` (`mock`/`stripe_test`/`configuration_required`/`live_key_refused`/`mock_not_in_production`), `getPaymentsProvider()` (null when payments cannot run), `PAYMENTS_READINESS_MESSAGES` |
| `src/lib/payments/stripe.ts` | `createStripePaymentsProvider(config, fetch)` (REST + fetch, no SDK: Express accounts, Account Links, Checkout Sessions with `Stripe-Account`, expire, retrieve), `mapStripePaymentsEvent`, `accountState`, `checkoutExpiry`; signatures via `verifyStripeSignature` from `src/lib/billing/stripe.ts` with its own secret |
| `src/lib/payments/mock.ts` | `createMockPaymentsProvider()` |
| `src/lib/payments/amounts.ts` (client-safe) | kinds, statuses, labels, `formatPounds`, `parsePoundsToPence`, `depositAmountPence`, `parseDepositRule`, `depositRuleLabel`, `paymentTotals`, limits |
| `src/lib/payments/tokens.ts` | `createPayToken()` (32 random bytes, base64url; hash stored), `hashPayToken`, `isPayTokenShape`, `PAY_COOKIE` (`af_pay`, httpOnly, path `/pay`), `payCookieOptions` |
| `src/lib/payments/messages.ts` (pure) | `chooseLinkChannel(customer)` (own channel; STOP → email, else none), `composeLinkMessage()` (SMS/WhatsApp end with "Reply STOP to opt out.") |
| `src/lib/payments/server.ts` | `loadPaymentsSetup(garage)`, `accountUsable`, `depositQuote`, `startDeposit`, `releaseExpiredDeposits(garage?)` (never throws; closes Stripe checkouts; clears the slot cache), `loadPaymentByToken`, `markPaymentPaid` (a deposit paid in time sends the held-back booking confirmation), `syncCheckout`, `applyPaymentsEvent`, `refreshConnectedAccount`, `sendPaymentLink` (getChannel, `messages` row, outcome on the payment) |
| `src/lib/payments/admin-actions.ts` ("use server") | `connectPaymentsAction`, `disconnectPaymentsAction` (owners), `savePaymentSettingsAction`, `saveServiceDepositAction` (owners/managers), `sendInvoicePaymentLinkAction`, `chargeNoShowFeeAction`, `cancelPaymentAction` (owners/managers/front desk). All but disconnect check `featureProblem(admin, "payments")` |
| `src/lib/payments/pay-session.ts` | `writePayCookie`, `readPayCookie` |
| `src/lib/payments/jobs.ts` | handler `payments.expire_deposits` |
| `src/components/payments/*` | `PaymentStatusBadge`, `PAYMENT_FLASH`, `DepositRuleFields`, `PaymentSettingsForm`, `ServiceDepositForm`, `BookingPaymentsPanel`, `InvoicePaymentLinkPanel`, `ServiceDepositPanel`, `InvoicePayLinkBadge`/`loadInvoicePayLinks` |
| Booking engine (additive) | `CreateBookingOptions.deferCreatedNotice`: the booking flow holds back the "created" notification while a deposit is due |

Routes:

| Route | Host | What |
| --- | --- | --- |
| `/app/payments` | admin | Pro. Payments list (filter by kind), totals this month, cancel/waive pending; `ProLockedPage` (with existing rows below) on Essentials. Nav: one line in `GROW_NAV_ITEMS` |
| `/app/payments/settings` | admin | Pro. Connect/disconnect (owners), deposits, hold, no-show fee (owners/managers), deposit per service |
| `GET /app/payments/settings/return` | admin | Stripe onboarding return/refresh: reads the account, stores it |
| Panels on `/app/bookings/[id]` (`#payments`), `/app/invoices/[id]` (`#payments`), `/app/settings/services/[id]` (`#deposit`); badge on `/app/invoices` | admin | additive: one import + one element each |
| `/details` (booking step 4) | garage | "Confirm and pay deposit" and the hold time when a deposit applies |
| `/time` | garage | releases the garage's expired deposits before showing times |
| `GET /pay/[token]` | garage | moves the token into `af_pay` and 303s to `/pay` (`Referrer-Policy: no-referrer`, also in `next.config.ts`) |
| `/pay` | garage | the payment from `af_pay` only: pay (mock: test payment here; Stripe: Checkout Session on the garage's account), paid, expired ("Book again"), cancelled; `?paid=1` reads the checkout back if the webhook lags |
| `POST /api/webhooks/payments/stripe` | any | Stripe Connect webhook, `STRIPE_PAYMENTS_WEBHOOK_SECRET`, raw-body signature, once per event; 503 until configured |

Jobs: `payments.expire_deposits` (in `JOB_KINDS`, the registry, the `daily` cron and its own cron name
`/api/cron/payments.expire_deposits`, period 5 minutes). Because Vercel Hobby runs crons once a day, expired deposits
are also released by the booking flow (`/time`, Confirm), `/pay` and `/app/payments` for that garage.

The deposit journey: Confirm → `create_booking()` (holds the bay; confirmation held back) → `create_deposit_payment()`
→ `af_pay` cookie → `/pay` → paid: `apply_payment_paid()` + the booking confirmation (`notifyBooking created`); not
paid by `expires_at`: `expire_pending_deposits()` cancels the booking ("Deposit not paid in time") and the slot is free.
If the deposit cannot be added after the booking was made, the booking stands and its confirmation is sent at once.

**Reusing the provider (P5.5 service plans by Direct Debit):** `PaymentsProvider` is per garage account; add recurring
methods next to the existing ones (e.g. `startMandate`, `createSubscription`) and new `PaymentsEvent` kinds, keep
`parseWebhook` + `payment_webhook_events` for idempotency, and keep `getPaymentsProvider()` as the single test-mode/live
gate. Stripe Direct Debit (Bacs) would use the same connected account (`Stripe-Account`).

## Multi-site (Phase 5, P5.9; DECISIONS A358–A365)

### Model

A group belongs to a **home garage**. The home garage holds the group's plan and its subscription (and so the extra-site charge). Every garage in a group, the home garage included, has one row in `garage_group_sites`; a garage is in at most one group. A garage in no group is treated as a "group of one" by the read functions, so `/app/group` works before the first site is added.

Tenancy is unchanged: every garage-scoped read or write still uses the member's **selected** garage (`af_garage` → `getAdminContext` → `x-garage-id` → `current_garage_id()`). The group functions start from the selected garage, find its group in SQL, and aggregate **only** sites of that group where the caller is owner or manager (`garage_role()` per site). No group read takes a garage id from the request. The only id a form sends is the site to remove, and `group_remove_site()` refuses it unless it is a non-home site of the selected garage's own group and the caller owns the selected garage, that site and the home garage.

### Tables (`supabase/migrations/20261029000900_multi_site.sql`; pgTAP `035_multi_site`)

| Table | Notes |
| --- | --- |
| `garage_groups` (tenant) | `garage_id` = the **home** garage (unique: one group per home), `name` (home garage's name at creation), `created_by`, `created_at`; unique (`id`, `garage_id`) for the child FK. RLS select: owners/managers of the selected garage when it is the home. No write policies, no staff write grants: written only by `group_add_site()` |
| `garage_group_sites` (tenant) | `garage_id` = the **site** (unique), `group_id`, `home_garage_id` (composite FK (`group_id`, `home_garage_id`) → `garage_groups (id, garage_id)` on delete cascade), `added_by`, `added_at`. RLS select: owners/managers of the selected garage, its own row only. Written only by `group_add_site()` / `group_remove_site()` |

Both are ordinary tenant tables (`garage_id uuid not null default current_garage_id() references garages on delete cascade`, RLS, anon revoked), in the tenancy suite `FIXTURES` and `ROLE_LIMITED_READS` (owner, manager). Select policies don't check the plan.

### SQL functions (all `security definer`, `search_path = ''`)

| SQL | Who | What |
| --- | --- | --- |
| `garage_group_home(garage) → uuid` | internal (service role) | the home garage of the garage's group, or null |
| `group_visible_sites() → table(garage_id, home_garage_id, is_home)` | internal | sites of the selected garage's group (or the selected garage alone) where the caller is owner/manager; 42501 unless owner/manager of the selected garage |
| `group_summary() → table(group_id, group_name, home_garage_id, is_home, site_count, visible_sites, can_add_sites, multi_site)` | owners/managers of the selected garage | no plan check (the page needs it for the locked state) |
| `group_overview(now) → table(garage_id, name, slug, accent, is_home, is_selected, today_bookings, open_requests, revenue_month_pence, won_back_bookings, won_back_pence)` | owners/managers of the selected garage | per site, in **each site's own time zone**: bookings starting today (not requested/cancelled/no-show/trashed), open requests (`requested`, not ended, as the Bookings badge), revenue this month (issued or paid invoices issued this month, not trashed), reminder work won back this month (`reminder_won_back()`). `PLAN_REQUIRED: multi_site` (P0001) unless the home garage's effective plan is Pro |
| `group_report(from, to) → table(garage_id, name, is_home, bookings, revenue_pence)` | owners/managers of the selected garage | same definitions over local dates `from..to` (≤ 366 days, else 22023); `PLAN_REQUIRED` as above |
| `group_add_site(p_garage jsonb) → jsonb` | owner of the selected garage **and** of the home garage, MFA rules of `garage_actor_allowed()` | creates the group on first use (home = selected garage), calls `create_garage(auth.uid(), p_garage)` (wrapped, not replaced: defaults seeded, caller is owner, 3 per 24 h), copies the home garage's `plan`/`trial_ends_at`/`plan_chosen` to the new garage, adds the site; returns `{garage_id, slug, group_id, home_garage_id, site_count, extra_sites}`. `PLAN_REQUIRED: multi_site`, `GROUP_FORBIDDEN` (42501), `GROUP_FULL` (101 sites), and `create_garage()`'s codes. Audited `group.created`, `group.site_added` (home), `group.joined` (new site) |
| `group_remove_site(site) → jsonb` | owner of the selected garage, of that site and of the home garage | never the home garage (`GROUP_HOME_SITE`); deletes the site row only (garage and data stay), the site drops to Essentials (keeps a running group trial); returns `{home_garage_id, site_count, extra_sites}`. Allowed without Pro (it only lowers the charge). Audited `group.site_removed` / `group.left` |
| `record_group_extra_sites(home, provider) → integer` | service role | sets `garage_subscriptions.extra_sites` on the home garage to sites − 1 (upserts the row with the provider kind) |
| trigger `garages_group_plan_sync` → `garage_groups_sync_plan()` | — | after a change of `plan`, `trial_ends_at` or `plan_chosen` on a **home** garage, every other site of its group gets the same values. So trial expiry, billing webhooks, `choose_essentials()` and Vitalos plan changes on the home garage reach the whole group, and the app's checks (`garageHasFeature(admin.garage)`, which read the selected garage's own columns) agree with SQL |

Not touched: `create_booking*`, `available_slots*`, `staff_available_slots*`, `create_garage()`, any earlier migration.

### Modules

| Module | Exports |
| --- | --- |
| `src/lib/group/report.ts` (client-safe, pure) | `GroupSummary`, `GroupOverviewSite`, `GroupReportSite`, `toGroupSummary`, `toOverviewSite`, `toReportSite`, `overviewTotals`, `reportTotals`, `parseReportRange` (default this month to date, swapped when back to front, cut to 366 days), `GROUP_REPORT_MAX_DAYS`, `extraSites`, `extraSitesLabel`, `extraSitePriceLine` (placeholder "Price to be confirmed" until `PLAN_EXTRA_SITE_PRICE_PENCE`), `groupReportCsv` (BOM, CRLF, total row, formula-injection guard), `groupReportFileName` |
| `src/lib/group/server.ts` | `loadGroupSummary`, `selectedGarageInGroup` (RLS read of the selected garage's site row), `loadGroupOverview`, `loadGroupReport`, `GroupDataError` (`PLAN_REQUIRED`/`FORBIDDEN`/`UNAVAILABLE`), `syncExtraSites({homeGarageId, extraSites, actorId}, provider?)`: `getBillingProvider().setExtraSites({garageId, subscriptionRef, count})`, then `record_group_extra_sites()` with the service role; a provider failure is audited `group.billing_failed` and nothing is recorded |
| `src/lib/group/actions.ts` (server actions) | `addSiteAction` (form state; zod/wizard parsing from `src/lib/signup/schema.ts`, owner + MFA verified + `featureProblem(admin, "multi_site")`), `removeSiteAction` (confirm step, `?done=` / `?error=` codes) |
| `src/components/group/add-site-form.tsx` | `AddSiteForm` (client, `useActionState`) |
| `src/components/admin-ui/garage-switcher.tsx` | new prop `groupHref`: "Group overview" link under the garages; `AdminShell` passes `groupOverviewHref`; the protected layout and `/app/more` set it when the selected garage is in a group and the member is owner/manager |
| `src/components/admin-ui/admin-nav.tsx` | one `GROW_NAV_ITEMS` line: `{ feature: "multi_site", label: "Group overview", href: "/app/group", icon: Building2 }` |

### Routes

| Route | What |
| --- | --- |
| `/app/group` | Owners and managers. Essentials (selected garage or home garage) → `ProLockedPage` (`canUpgrade` for owners, `hasExistingData` when a group exists). Pro: totals (cars in today, waiting for OK, revenue this month, won back), a card per site (Open = switch garage, Remove for owners), "N more sites not shown" when the member doesn't manage every site, the report (date range GET form, table with total, Download CSV), Add a site (owners of the home garage, MFA verified; shows the extra-site price placeholder and current extra sites), the remove confirmation (`?confirm=<site>`). Technicians and front desk get a notice |
| `GET /api/admin/group/report?from&to` | CSV of `group_report()` through the RLS client; 401 signed out, 403 for other roles, 403 `PLAN_REQUIRED` (`featureGuard`, and the SQL error if the home garage is on Essentials); `Cache-Control: private, no-store`; audited `group.report_exported` |

No jobs, no customer-facing pages, no messages.

## Fleet and trade accounts (Phase 5, P5.7; DECISIONS A342–A349)

### Schema (`supabase/migrations/20261029000700_fleet_accounts.sql`; pgTAP `033_fleet_accounts`)

Every table: `garage_id uuid not null default current_garage_id() references garages on delete cascade`, RLS on, composite FKs to its parents, anon has no grants. Select policies do **not** check the plan (a downgraded garage keeps reading); write policies and functions check `garage_has_feature(garage_id, 'fleet_accounts')`.

| Table | Columns | Who |
| --- | --- | --- |
| `business_accounts` | `name` (2–120, unique among active per garage, case-insensitive), `kind` (`fleet`/`trade`), `company_number` (`^[A-Z0-9]{8}$`), `billing_email`, `billing_address` (≤ 500), `contact_name`, `contact_phone` (E.164), `contact_email`, `payment_terms_days` (0–120, default 30), `po_required`, `discount_percent` (0–100], `credit_limit_pence`, `billing` (`monthly`/`per_invoice`), `notes`, `archived_at`, `created_by` | all members read; owners/managers insert and update (column grants; archive = `archived_at`); no delete |
| `business_account_vehicles` | `account_id`, `vehicle_id` (unique per garage: a car is on one account), `added_by` | all read; owners/managers insert/delete |
| `business_account_customers` | `account_id`, `customer_id`, `role` (`driver`/`contact`), unique per account | all read; owners/managers insert/update role/delete |
| `business_account_bookings` | `booking_id` (unique), `account_id`, `po_number` (≤ 40), `set_by` | all read; written by `set_booking_account()` only |
| `business_account_invoices` | `invoice_id` (unique), `account_id`, `po_number`, `bill_to_name/email/address` (snapshot at link time), `statement_id` | all read; written by the invoice link trigger and account functions only |
| `account_statements` | `reference` (`<prefix>-ST-YYYYMM-NNN`), `period_start`/`period_end` (a calendar month), `status` (`draft`/`issued`/`paid`), `invoice_count`, `total_pence`, `issue_date`, `due_date` (issue + terms), `issued_at/by`, `paid_at`, `payment_method`, `payment_reference`, `emailed_at`, `emailed_to`, `email_status`, `email_provider_id`, `email_count`; unique (garage, account, period_start) | all read; written by the statement functions only |

| SQL (all `security definer`, `search_path = ''`) | Who | What |
| --- | --- | --- |
| `add_business_account_vehicle(account, registration, make, model) → jsonb {vehicle_id, created, linked}` | owners/managers, Pro (`require_account_manager()`: `garage_actor_allowed()` + role + `require_garage_feature`) | the garage's car by normalised reg, or a new one; `VEHICLE_ON_OTHER_ACCOUNT`, `ACCOUNT_NOT_FOUND`, `INVALID_REGISTRATION`; audited |
| `set_booking_account(booking, account \| null, po) → business_account_bookings` | any member (`garage_actor_allowed()`), Pro | charges a booking (made by `create_booking()`) to an account after the fact: `PO_REQUIRED`, `VEHICLE_ON_OTHER_ACCOUNT`, `BOOKING_NOT_FOUND`; adds the car to the account when on none, the customer as driver, links the booking's invoices not yet on a statement; null clears; audited. **Never redefines `create_booking`** |
| trigger `invoices_link_account` (`link_account_invoice()`, after insert / update of `booking_id` on `invoices`) | — | an invoice for an account booking gets a `business_account_invoices` row (bill-to + PO). Skipped when the garage isn't on Pro. Never changes the invoice row |
| `generate_account_statement(account, month_start) → account_statements` | owners/managers, Pro | make or refresh the draft for that month: issued/paid, not deleted account invoices with `issue_date <= month end` on no statement; `NOTHING_TO_BILL`, `INVALID_PERIOD`; issued statements come back unchanged |
| `issue_account_statement(statement)` | owners/managers, Pro | refresh, then issue: `issue_date` = garage-local today, `due_date` = + `payment_terms_days`; `STATEMENT_NOT_DRAFT` |
| `mark_account_statement_paid(statement, paid_at, method, reference)` | owners/managers, Pro | `record_invoice_payment()` for each unpaid invoice's balance, then `paid` |
| `record_account_statement_email(statement, recipient, outcome, provider_id)` | owners/managers, Pro | records a send (`sent`/`failed`) |
| `generate_monthly_account_statements(garage, month_start) → int` | service role | job: drafts for active monthly accounts; 0 for a garage not on Pro; idempotent per account and month |
| `build_account_statement(...)`, `link_invoice_to_account(...)`, `require_account_manager()` | internal (no grants) | |

### App

| Module | Exports |
| --- | --- |
| `src/lib/accounts/view.ts` (client-safe) | `parseAccountForm`, `accountFormValues`, `EMPTY_ACCOUNT_FORM`, `normaliseCompanyNumber`, `cleanPoNumber`, `previousStatementMonth`/`currentStatementMonth`/`recentStatementMonths` (Europe/London), `periodLabel`, `longDate`, `formatPounds`, `lineBalance`, `statementTotals`, `creditPosition`, `statementCsv` (formula-safe), `statementFileName`, `accountInvoiceTerms`, `accountErrorMessage`, labels |
| `src/lib/accounts/queries.ts` (server, RLS client + explicit garage) | `listAccounts`, `getAccountDetail`, `getStatementDetail`, `getBookingAccount`, `getInvoiceAccount` (both null on any error), `listBookingFormAccounts`, `searchVehicles`, `searchCustomers` |
| `src/lib/accounts/bookings.ts` | `checkBookingAccount` (before the booking), `chargeBookingToAccount` (`set_booking_account` after it) |
| `src/lib/accounts/statement-email.ts` | `renderStatementEmail`, `sendStatementEmail` (`getChannel("email")`, key `account_statement:<id>:<n>`) |
| `src/lib/accounts/statement-pdf.tsx` | `StatementDocument`, `renderStatementPdf` (@react-pdf, invoice style) |
| `src/lib/accounts/jobs.ts` | `accountsStatementsHandler` (job `accounts.statements`) |
| `src/app/app/(protected)/accounts/actions.ts` | `saveAccountAction`, `archiveAccountAction`, `searchAccountVehiclesAction`, `addAccountVehicleAction`, `removeAccountVehicleAction`, `searchAccountPeopleAction`, `addAccountPersonAction`, `removeAccountPersonAction`, `generateStatementAction`, `issueStatementAction`, `markStatementPaidAction`, `emailStatementAction`. All `requireSetupContext` (AAL2) + owner/manager + `featureProblem(admin, "fleet_accounts")` |

Routes: `/app/accounts` (list; locked card + read-only list on Essentials), `/app/accounts/new`, `/app/accounts/[id]` (money, cars with MOT due when `mot_enabled`, add car by search or registration, drivers/contacts, not yet billed, recent bookings, statements + "Make or refresh"), `/app/accounts/[id]/edit`, `/app/accounts/statements/[id]` (issue, email, mark paid, print), `GET /api/admin/accounts/statements/[id]/pdf`, `GET /api/admin/accounts/statements/[id]/csv`. Nav: one line in `GROW_NAV_ITEMS` ("Fleet accounts").

Changes to shared code (additive): `/app/bookings/new` gets an optional Account step (`account-chooser.tsx`; `?account=<id>` preselects) and the action checks the account before and calls `set_booking_account` after `createStaffBooking`; booking detail shows Account + PO (`?notice=account_not_set` if the link failed); invoice detail shows "Charged to account" and, for monthly accounts, "On the monthly statement" instead of the send panel; `sendInvoiceAction` refuses monthly-account invoices (`?notice=on_statement`); `renderInvoicePdf(invoice, garage, billTo?)` bills the account (invoice PDF route and email attachment); invoice-from-booking prefills payment terms / PO note.

Job: `accounts.statements` in `JOB_KINDS`, registry (18 s), `daily` cron and its own cron name. Platform job, no payload: for each non-cancelled garage with an active monthly account, `generate_monthly_account_statements(garage, previous month in the garage's time zone)`. Run daily, so the 1st makes last month's drafts and a missed day catches up. It never emails.

## Accounting sync (Phase 5, P5.10; DECISIONS A366–A373)

### Schema (`supabase/migrations/20261029001000_accounting_sync.sql`; pgTAP `036_accounting_sync`)

| Object | Notes |
| --- | --- |
| `accounting_connections` (tenant) | `provider` (`xero`/`quickbooks`/`sage`/`fake`), `status` (`pending` = organisation not chosen / `connected` / `needs_reconnect` / `disconnected`), `tenant_id`, `tenant_name`, `scopes text[]`, `settings jsonb` (account mapping, no secrets), `connected_by`, `connected_at`, `last_sync_at`, `last_error_code` (code only), `disconnected_at`. **One active (not disconnected) row per garage** (partial unique index). Owners and managers read; no staff writes. Disconnected rows stay as history |
| `accounting_connection_secrets` (tenant, **service role only**) | `connection_id` pk (composite FK to the connection, cascade), `access_token_ct`, `refresh_token_ct` (AES-256-GCM ciphertext `v1.<iv>.<tag>.<data>`, checked by a constraint), `expires_at`, `refresh_expires_at`. RLS on, no grants for anon/authenticated and a deny-all select policy (`... and false`, so the table meets the 007 tenancy rules). Deleted on disconnect |
| `accounting_sync_items` (tenant) | `connection_id`, `entity` (`contact`/`invoice`/`payment`), `local_id`, `remote_id`, `status` (`pending`/`synced`/`failed`), `attempts`, `next_attempt_at`, `last_error_code`, `synced_at`. Unique (`connection_id`, `entity`, `local_id`): idempotent per entity. Owners and managers read; written by definer functions and the job. Kept on disconnect |
| Triggers `invoices_accounting_sync` (after update of status, draft → issued), `invoice_payments_accounting_sync` (after insert) | `accounting_queue_after_invoice_change()` → `accounting_queue_entity()`: only for garages whose effective plan has `accounting_sync` and that have a pending/connected/needs_reconnect connection. Any error is a `WARNING`, never blocks issuing or recording. No invoice function was changed |

| SQL | Who | What |
| --- | --- | --- |
| `accounting_save_connection(garage, provider, tenant_id, tenant_name, scopes, connected_by, access_ct, refresh_ct, expires_at, refresh_expires_at)` | service (OAuth callback) | `require_garage_feature(…,'accounting_sync')`; reuses a pending/needs_reconnect row of the same provider + organisation (keeps its history), ends one of another provider/organisation; upserts the ciphertext; queues a sync when connected (items that waited during a `needs_reconnect` go out). Audited `accounting.connected` |
| `accounting_choose_tenant(garage, connection, tenant_id, tenant_name, actor)` | service (server action, after the owner + plan check and checking the id is one the provider listed) | pending → connected, queues a sync. Audited |
| `accounting_disconnect(garage, actor)` | service | ends the active connection, deletes its tokens, closes its pending items as `failed DISCONNECTED`, keeps history. Allowed on Essentials. Audited |
| `enqueue_accounting_sync(garage, run_at)` | service, triggers | queues `accounting.sync {garageId}` unless one is already **queued** to run by then (no dedupe key: keys are unique for ever) |
| `accounting_queue_entity(garage, entity, local_id)` | internal (triggers) | the plan + connection check, item insert (`on conflict do nothing`), job |
| `accounting_request_sync() → int` ("Sync now") | owners/managers of the selected garage (`garage_actor_allowed()`, AAL2 when enrolled), `require_garage_feature` | failed items → pending with fresh attempts; queues invoices issued and payments recorded since `connected_at` that have no item; queues the job. Audited |
| `accounting_retry_item(item) → accounting_sync_items` ("Retry") | owners/managers, Pro | one failed item of the active connected connection → pending |
| `accounting_due_garages(limit) → setof uuid` | service | garages with due pending items (daily fan-out) |

### App

| Module | Exports |
| --- | --- |
| `src/lib/accounting/types.ts` (client-safe) | `AccountingProvider` interface (`authorizeUrl`, `exchangeCode`, `refresh`, `revoke`, `listTenants`, `upsertContact`, `pushInvoice`, `pushPayment`), `TokenSet`, `ContactInput`/`InvoiceInput`/`PaymentInput`, `AccountingSettings`, `AccountingError` (`RATE_LIMITED` with `retryAfterSeconds`, `AUTH_EXPIRED`, `VALIDATION`, `NOT_FOUND`, `PROVIDER_UNAVAILABLE`, `NETWORK`, `CONFIGURATION_REQUIRED`, `UNEXPECTED_RESPONSE`; `.retryable`), `parseRetryAfter`, `penceToDecimal`, provider ids and names |
| `src/lib/accounting/http.ts` | `send` (fetch with a 12 s timeout), `mapHttpError` (429 → RATE_LIMITED + Retry-After, 401/403 → AUTH_EXPIRED, 400/409/422 → VALIDATION, 404, 5xx), `mapTokenResponse`, `mapTokenError` (`invalid_grant` → AUTH_EXPIRED) |
| `src/lib/accounting/providers/xero.ts` | `createXeroProvider`, pure `xeroRequests` / `xeroMappers`: OAuth + PKCE (login.xero.com, identity.xero.com), `GET /connections`, `Contacts` (find by `ContactNumber` `AF-<id>`, then by name, else create), `POST /Invoices` (ACCREC, AUTHORISED, `NoTax`, account `200`, discount as a negative line, `Idempotency-Key`), `PUT /Payments` (account `090`), revoke |
| `src/lib/accounting/providers/quickbooks.ts` | `createQuickBooksProvider`, `quickbooksRequests` / `quickbooksMappers`: Intuit OAuth (realmId from the callback), CompanyInfo, Customer query/create, Invoice (SalesItemLineDetail with item `1`, DiscountLineDetail), Payment (LinkedTxn), `requestid` idempotency, Fault mapping; sandbox unless `QUICKBOOKS_ENVIRONMENT=production` |
| `src/lib/accounting/providers/sage.ts` | `createSageProvider`, `sageRequests` / `sageMappers`: Sage OAuth, `/businesses` (`X-Business`), contacts (reference `AF…`), `sales_invoices` (looked up by number first; ledger account looked up), `contact_payments` (`CUSTOMER_RECEIPT`, allocated to the invoice; bank account looked up), `$dataCode` error mapping |
| `src/lib/accounting/providers/fake.ts` | `createFakeProvider`, `fakeAccountingStore`, `resetFakeAccountingStore`, `FAKE_TENANTS`: in-memory OAuth with PKCE (redirects straight back to the callback), two organisations, idempotent creates, balance checks; switches by customer name: "Fail Once", "Rate Limit", "Auth Expired" |
| `src/lib/accounting/providers/index.ts` | `getAccountingProvider(id, {env, fetch, now})`, `accountingMode` (`ACCOUNTING_PROVIDER_MODE`: `fake` default serves every choice with the fake, "(test mode)"; `live` = real adapters), `PROVIDER_ENV_VARS` |
| `src/lib/accounting/crypto.ts` | `sealText`/`openText` (AES-256-GCM, associated data), `accountingKey` (`ACCOUNTING_TOKEN_KEY`; a fixed development key outside production, refuses in production), `hasAccountingKey`, `tokenAad(garageId)` |
| `src/lib/accounting/oauth.ts` | `ACCOUNTING_OAUTH_COOKIE` (`af_accounting_oauth`: sealed {state, PKCE verifier, provider, garage, user, expiry}; httpOnly, SameSite=Lax, path `/api/admin/accounting`, 10 min), `createOAuthState`, `sealOAuthState`/`openOAuthState`, `pkceChallenge` (S256), `checkCallback` (state in constant time, expiry, provider, garage, user) |
| `src/lib/accounting/sync.ts` | `runAccountingSync(garageId, deps)` and the `AccountingSyncRepo` seam: plan + connected check; invoices before payments (a payment waits for its invoice, fails `INVOICE_NOT_SYNCED` if the invoice failed); contact found/created on the way; refresh 60 s before expiry and once on AUTH_EXPIRED, refused refresh → `needs_reconnect` (items stay pending); RATE_LIMITED stops the run and queues the next after Retry-After; retryable errors back off 2, 4, 8 … min, `failed` after 6 attempts; validation/not found fail at once; void invoices are not sent; batch of 25, respects the job deadline; codes only |
| `src/lib/accounting/repository.ts` | `createSupabaseAccountingRepo(db)`, `sealTokens`/`openTokens`, `loadConnectionTokens`, `saveConnectionTokens` (service role, every query names the garage) |
| `src/lib/accounting/server.ts` | `loadAccountingOverview(client, garageId)` (RLS client: counts, failed list, recent), `saveConnection`, `listConnectionTenants`, `chooseTenant`, `disconnect` (revoke at the provider best effort, then `accounting_disconnect`), `accountingCallbackUrl` |
| `src/lib/accounting/routes.ts` | `requireAccountingOwner(request)` (signed in, not impersonating, MFA done, `featureGuard` 403 `PLAN_REQUIRED`, owner), `settingsRedirect`, `isSameOrigin`, `routeProvider` |
| `src/lib/accounting/jobs.ts` | `accounting.sync` handler: with `garageId` runs the engine; without (daily cron) queues each garage from `accounting_due_garages()` |

Routes:

| Route | Who | What |
| --- | --- | --- |
| `/app/settings/accounting` | owners and managers (technicians see "owners and managers only"); Essentials → `ProLockedPage` (+ disconnect of an old connection) | choose Xero / QuickBooks / Sage (owners; "Configuration required" when the app's keys are missing), choose organisation, connection details, reconnect banner (`#reconnect-banner`) when `needs_reconnect`, Sync now (owners/managers), Needs attention list with Retry, sync status counts and recent items, Disconnect with confirmation (owners). Actions in `settings/accounting/actions.ts` (`requireSetupContext`, garage from the session) |
| `POST /api/admin/accounting/[provider]/connect` | owner, MFA, Pro, same origin | sets the state cookie, 303 to the provider's consent page; 403 `PLAN_REQUIRED` on Essentials; GET → 405 |
| `GET /api/admin/accounting/[provider]/callback` | owner, MFA, Pro | checks the cookie against the query state and the session's garage and user, exchanges the code (PKCE verifier), lists organisations, stores encrypted tokens, 303 back (`?choose=1` when several organisations). Never logs codes, tokens or provider text |

Jobs: `accounting.sync` added to `JOB_KINDS` (after `billing.close_usage`), the registry (18 s) and the `daily` cron plus its own `accounting.sync` cron name. Sync now and Retry drain `accounting.sync` straight after the response (`after()`).

Nav: one line in `PRO_SETUP_NAV_ITEMS` (`Accounting`, `Calculator` icon). Env (`.env.example`, `# P5.10`): `ACCOUNTING_PROVIDER_MODE`, `ACCOUNTING_TOKEN_KEY`, `XERO_CLIENT_ID/SECRET`, `QUICKBOOKS_CLIENT_ID/SECRET`, `QUICKBOOKS_ENVIRONMENT`, `SAGE_CLIENT_ID/SECRET`.

Shared files touched (additive): `src/lib/jobs/{types,registry,cron}.ts`, `src/components/admin-ui/admin-nav.tsx` (icon import + one nav line), `src/__tests__/jobs-routes.test.ts` and `src/__tests__/admin-shell.test.tsx` (now derive the daily kinds and the Pro nav items instead of hard-coding them), `tests/integration/tenancy.test.ts` (fixtures), `playwright.garage.config.ts` (project + a local-only `ACCOUNTING_TOKEN_KEY` for the production build), `tests/e2e/garage-specs.ts`, `package.json` (`test:e2e:p5-accounting`), `.env.example`.

## Customer service plans (Phase 5, P5.11; DECISIONS A374–A381)

### Schema (`supabase/migrations/20261029001100_service_plans.sql`; pgTAP `037_service_plans`)

| Object | Notes |
| --- | --- |
| `service_plans` (tenant) | `name` (2–60), `description` (≤ 500), `price_pence` (100–100000, monthly), `discount_percent` (0–50, off parts and labour on invoices), `priority_booking` (shown to staff; never changes slots), `status` (`active`/`archived`), `archived_at`, `sort`, `created_by`. Members read (any plan); owners/managers insert/update with `garage_has_feature(garage_id,'service_plans')`; no delete (archive) |
| `service_plan_inclusions` (tenant) | `plan_id`, `service_id` (composite FKs), `uses_per_year` (1–12); unique per plan + service. Members read; owners/managers write (Pro) |
| `customer_plan_subscriptions` (tenant) | `plan_id`, `customer_id`, `vehicle_id` (composite FKs), `status` (`pending_mandate`/`active`/`past_due`/`cancelled`), `price_pence` (snapshot at sign-up), `provider` (`mock`/`stripe`), `checkout_ref`, `mandate_ref`, `subscription_ref`, `started_at`, `renews_at`, `last_payment_failed_at`, `cancelled_at`/`cancelled_by`/`cancel_reason`, `last_notice_kind`/`_at`/`_channel`/`_outcome`. One live (not cancelled) per car. No bank details stored. Members read; no direct writes |
| `service_plan_uses` (tenant) | `subscription_id`, `booking_id`, `service_id`, `plan_year_start`, `status` (`used`/`released`), `source` (`online`/`staff`), `used_at`, `released_at`. One live use per booking. Members read; no direct writes |
| `service_plan_invoice_applications` (tenant) | `invoice_id` (unique), `subscription_id`, `included_pence`, `discount_pence`, `applied_by`. Members read; no direct writes |
| Trigger `bookings_service_plans_follow` (after update of status on `bookings`) | a cancelled booking releases its use (a no-show keeps it) |

| SQL | Who | What |
| --- | --- | --- |
| `save_service_plan(plan_id, payload) → service_plans` | owners/managers of the selected garage (`garage_actor_allowed()`); Pro | create (null id) or change a plan and its inclusions (≤ 5, active services of the garage). Audited `service_plan.created/updated` |
| `set_service_plan_status(plan_id, status)` | owners/managers; Pro | archive / restore. Audited |
| `cancel_plan_subscription(subscription_id, reason)` | owners, managers, front desk; **not** plan gated | records the cancellation after the server stopped the provider's subscription. Audited |
| `use_plan_benefit(booking_id) → jsonb`, `release_plan_benefit(booking_id) → int` | any member; Pro | record / give back the included use on a booking (staff bookings, corrections) |
| `apply_service_plan_to_invoice(invoice_id) → jsonb` | invoice rights (`require_invoice_actor()`, `save_invoice_draft()`'s own checks); Pro | draft invoice of a booking whose car is on an active plan: included service lines to £0.00 "(included in <plan>)", plan % added to the discount, through `save_invoice_draft()`. Once per invoice. `NOT_ON_PLAN`, `PLAN_PAST_DUE`, `INVOICE_NOT_DRAFT`, `NOTHING_TO_APPLY` |
| `start_plan_signup(garage, plan, customer, vehicle, provider)` | service (garage host) | Pro + active plan + active payment account for the provider; links the customer by phone and the car by registration (consent untouched); reuses a pending sign-up for the car; `ALREADY_ON_PLAN` otherwise |
| `set_plan_subscription_checkout(garage, subscription, ref)` | service | stores the provider checkout id |
| `apply_plan_subscription_status(garage, subscription, provider, status, mandate_ref, subscription_ref, renews_at, at) → jsonb` | service (webhook, return, mock confirm) | row-locked transitions; returns `notify` = `confirmation` (pending → active) or `payment_failed` (→ past_due, once per run of failures); `cancelled` is final; provider and subscription ref must match. Not plan gated. Audited `service_plan.subscription_<status>` |
| `record_plan_booking(garage, booking) → jsonb` | service (online flow, after `create_booking()`) | records the included use when the car is on an active plan including the service and the plan year has a use left; `{on_plan:false}` on Essentials |
| `service_plan_year_start(started_at, at, tz)` | authenticated, service | start of the plan year `at` falls in (whole local years) |

`create_booking`, `create_booking_at`, `available_slots*`, `staff_available_slots*` and every existing migration are unchanged.

### App

| Module | Exports |
| --- | --- |
| `src/lib/payments/provider.ts` (extended) | `PlanSubscriptionStatus`, `MandateRequest`, `MandateResult`, `MandateState`; `PaymentsProvider.startMandate`, `getMandate`, `cancelMandate`; `PaymentsEvent` kind `plan_subscription` |
| `src/lib/payments/stripe-direct-debit.ts` | `stripeMandateMethods(call)` (Checkout `mode=subscription`, `payment_method_types[0]=bacs_debit`, GBP monthly price, `subscription_data[metadata]` with our ids, on `Stripe-Account`; read back with `expand[]=subscription`; `DELETE /v1/subscriptions/{id}`), `mapStripePlanEvent` (`checkout.session.completed` (subscription mode), `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`), `planStatusFromStripe` |
| `src/lib/payments/mock.ts`, `stripe.ts`, `server.ts` (additive) | mock mandate is local; Stripe adapter spreads the mandate methods and maps plan events first; `applyPaymentsEvent()` dispatches `plan_subscription` events (same `payment_webhook_events` once-per-event claim, same endpoint `POST /api/webhooks/payments/stripe`) |
| `src/lib/service-plans/view.ts` (client-safe) | statuses/labels, `ServicePlan`, `PlanSubscription`, `monthlyPrice`, `planBenefitLines`, `planYearStart` (mirrors SQL), `parsePlanForm`, `planPayload`, flash/error helpers, `DIRECT_DEBIT_GUARANTEE`, `guaranteeParagraphs` |
| `src/lib/service-plans/messages.ts` (pure) | `composePlanNotice(kind, input, channel)` (texts end "Reply STOP to opt out."; no registration) |
| `src/lib/service-plans/signup-session.ts` | sealed httpOnly `af_plan` cookie (AES-256-GCM, bound to the garage, path `/plans`, 2 h): `writePlanSession`, `readPlanSession` |
| `src/lib/service-plans/server.ts` | `loadPlans`, `loadSubscriptions`, `loadUsage`, `loadBookingPlan`, `loadPublicPlans`, `signupReadiness`, `startSignup`, `loadSignup`, `applyPlanStatus` (sends the notice it asks for), `confirmMockMandate`, `syncMandate`, `applyPlanEvent`, `sendPlanNotice` (`getChannel`, `chooseLinkChannel`: own channel, STOP → email, else none; `messages` row; outcome on the subscription), `recordPlanBooking` (never throws), `cancelSubscription` |
| `src/lib/service-plans/admin-actions.ts` | `savePlanAction`, `setPlanStatusAction` (owners/managers, Pro), `cancelPlanSubscriptionAction` (owners/managers/front desk, any plan), `useBenefitAction`, `releaseBenefitAction`, `applyPlanToInvoiceAction` (Pro). `requireStaffWriter` (MFA) + `featureProblem` |
| `src/components/service-plans/*` | `SubscriptionStatusBadge`, `PlanNotice`, `PlanBenefits`, `PlanFields`; panels `BookingPlanPanel`, `CustomerPlansPanel`, `InvoicePlanPanel` |
| Booking flow (additive) | `confirmBookingAction` calls `recordPlanBooking()` after the booking exists |
| `src/lib/booking-engine/state.ts` (one line) | sealed-cookie purpose `af_plan` |

### Routes

| Route | Host | What |
| --- | --- | --- |
| `/app/service-plans` | admin | Pro: plans (add, edit, archive/restore), customers on plans, link to `/plans`, "connect payments first" notice. Essentials: `ProLockedPage`, existing subscriptions listed and the still-collecting Direct Debits flagged. Nav: one line in `GROW_NAV_ITEMS` |
| `#service-plan` panels on `/app/bookings/[id]`, `/app/customers/[id]`, `/app/invoices/[id]` | admin | "On <plan>", use / give back, this plan year's uses, cancel, apply plan benefits (one import + one element each) |
| `/plans` | garage | active plans of a Pro garage with payments connected; otherwise "Service plans aren't available" |
| `/plans/[planId]` | garage | sign-up form + Direct Debit Guarantee + account-holder authorisation; 404 when not on offer |
| `/plans/confirm` | garage | the sign-up from `af_plan` only: mock "Set up test Direct Debit", Stripe return (`?done=1` reads the mandate back), active / past due / cancelled |
| `POST /api/webhooks/payments/stripe` | any | existing P5.4 endpoint now also applies plan events |

No new job: Stripe collects each month and tells us by webhook. No new env vars.

GoCardless (future adapter, not built): implement `startMandate` (Redirect Flow / Billing Request Flow for a mandate),
`getMandate`, `cancelMandate` (cancel subscription) and map `mandates.*`/`subscriptions.*`/`payments.failed` webhook
events to the same `plan_subscription` event kind; nothing else changes.
