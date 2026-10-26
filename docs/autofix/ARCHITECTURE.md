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

Booking flow on the garage host: `/` (vehicle), `/service`, `/time`, `/details`, `/confirmed/[reference]`, `/manage`, `/r/[token]`, `/privacy`, `/unsubscribe`.

## Migrations

`supabase/migrations/20261026000000_baseline.sql` (SOB squash) then `20261026000100_tenancy.sql`, `…_scheduling.sql` (P2.1), `…_reminders.sql` (P3.6), and later ones. Never edit a migration after it has shipped to a shared database.
