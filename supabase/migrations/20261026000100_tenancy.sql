-- Autofix tenancy (P1.4 + P1.5).
--
-- Turns SOB's single-business schema into a multi-tenant one, following
-- docs/autofix/ARCHITECTURE.md ("Tenancy in the database") and DECISIONS.md A6
-- and A10:
--
--   1. garages, garage_domains, garage_members, platform_admins.
--   2. Helpers request_garage_id(), garage_role(), current_garage_id(),
--      current_garage_role(), is_platform_admin(). The admin app sends the
--      selected garage as the x-garage-id request header; current_garage_id()
--      honours it only for members of that garage (or the service role).
--   3. garage_id on every tenant table, composite foreign keys between tenant
--      tables, uniqueness re-scoped per garage, indexes leading with garage_id.
--   4. SOB's single-business rules removed: is_admin(), the administrator email
--      allowlist, SOB issuer defaults on invoices, SOB- reference formats.
--   5. Row-level security on every tenant table, scoped to the selected garage.
--      Each table's policies are listed in a comment above them.
--   6. Every function that touches tenant tables filters each statement by
--      garage. Staff RPCs take the garage from current_garage_id(); service-role
--      functions take an explicit p_garage_id.
--   7. Explicit grants for every table and function (anon gets nothing), and
--      default privileges that keep future objects closed until granted.
--
-- Platform tables without garage_id (A10): rate_limit_buckets,
-- resend_webhook_events, inbound_email_events, provider_webhook_events,
-- unmatched_inbound_emails, admin_profiles, admin_mfa_policy,
-- admin_mfa_recovery_codes, admin_mfa_recovery_sessions, admin_trusted_devices,
-- platform_admins. They are service-role only, own-row only (admin_profiles) or
-- platform-admin only (unmatched_inbound_emails).
--
-- This migration expects the empty baseline: it adds not-null garage_id
-- columns without a backfill and refuses to run if SOB rows are present.

-- ---------------------------------------------------------------------------
-- 0. Guard
-- ---------------------------------------------------------------------------

do $$
declare
  tenant_table text;
  has_rows boolean;
begin
  foreach tenant_table in array array[
    'customers', 'vehicles', 'bookings', 'booking_service_types', 'service_catalogue_systems',
    'booking_audit_log', 'booking_notification_events', 'enquiries', 'enquiry_attachments',
    'enquiry_conversations', 'enquiry_messages', 'notification_attempts', 'invoices', 'invoice_items',
    'invoice_payments', 'invoice_email_sends', 'invoice_email_attempts', 'invoice_number_sequences',
    'media_assets', 'reviews', 'offers', 'service_prices', 'site_settings', 'admin_audit_log'
  ] loop
    execute format('select exists (select 1 from public.%I)', tenant_table) into has_rows;
    if has_rows then
      raise exception 'The tenancy migration expects an empty baseline, but public.% has rows', tenant_table;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Garages, domains, members, platform admins
-- ---------------------------------------------------------------------------

create table public.garages (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  legal_name text,
  company_number text,
  phone text,
  whatsapp text,
  email text,
  address jsonb,
  timezone text not null default 'Europe/London',
  logo_url text,
  accent text not null default '#155fba',
  plan text not null default 'trial',
  mot_enabled boolean not null default false,
  booking_prefix text not null,
  slot_step_min integer not null default 15,
  approve_online boolean not null default false,
  service_area text[] not null default '{}'::text[],
  cancellation_cutoff_h integer not null default 24,
  sms_sender text,
  status text not null default 'onboarding',
  settings jsonb not null default '{}'::jsonb,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint garages_slug_key unique (slug),
  constraint garages_slug_check check (char_length(slug) between 3 and 40 and slug ~ '^[a-z0-9](-?[a-z0-9])*$'),
  constraint garages_name_check check (char_length(trim(name)) between 1 and 120),
  constraint garages_phone_check check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint garages_whatsapp_check check (whatsapp is null or whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  constraint garages_email_check check (email is null or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint garages_address_check check (address is null or jsonb_typeof(address) = 'object'),
  constraint garages_accent_check check (accent ~ '^#[0-9a-f]{6}$'),
  constraint garages_plan_check check (plan in ('trial', 'growth', 'front_desk')),
  constraint garages_booking_prefix_check check (booking_prefix ~ '^[A-Z]{2,4}$'),
  constraint garages_slot_step_min_check check (slot_step_min between 5 and 120),
  constraint garages_cancellation_cutoff_h_check check (cancellation_cutoff_h between 0 and 720),
  constraint garages_sms_sender_check
    check (sms_sender is null or (sms_sender ~ '^[A-Za-z0-9 ]{1,11}$' and sms_sender ~ '[A-Za-z]')),
  constraint garages_status_check check (status in ('onboarding', 'active', 'suspended', 'cancelled')),
  constraint garages_settings_check check (jsonb_typeof(settings) = 'object')
);

comment on table public.garages is 'One row per tenant. The slug gives the free link <slug>.autofix.vitalos.co.uk.';
comment on column public.garages.booking_prefix is 'Prefix for booking references (HRM-4821) and invoice numbers (HRM-2026-000001).';

-- Slot maths depends on a valid IANA time zone, which a check constraint
-- cannot verify.
create function public.validate_garage()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.timezone(new.timezone, pg_catalog.now());
  return new;
exception
  when invalid_parameter_value then
    raise exception 'INVALID_GARAGE_TIMEZONE' using errcode = '22023';
end
$$;

create trigger garages_validate before insert or update of timezone on public.garages
  for each row execute function public.validate_garage();
create trigger garages_updated before update on public.garages
  for each row execute function public.set_updated_at();

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is 'Vitalos staff. Super-admin routes use the service role and log every action.';

create table public.garage_members (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint garage_members_garage_id_user_id_key unique (garage_id, user_id),
  constraint garage_members_role_check check (role in ('owner', 'manager', 'technician'))
);

create index garage_members_user_idx on public.garage_members (user_id);

create trigger garage_members_updated before update on public.garage_members
  for each row execute function public.set_updated_at();

create table public.garage_domains (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  hostname text not null,
  kind text not null default 'custom',
  status text not null default 'pending_dns',
  verification jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  error text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint garage_domains_hostname_check check (
    hostname = lower(hostname)
    and char_length(hostname) <= 253
    and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  ),
  constraint garage_domains_kind_check check (kind in ('subdomain', 'custom')),
  constraint garage_domains_status_check check (status in ('pending_dns', 'verifying', 'active', 'failed')),
  constraint garage_domains_verification_check check (jsonb_typeof(verification) = 'object')
);

-- A hostname belongs to one garage at a time. Soft-deleted rows keep their
-- history and free the hostname for a later claim.
create unique index garage_domains_hostname_key on public.garage_domains (hostname) where deleted_at is null;
create index garage_domains_garage_idx on public.garage_domains (garage_id, status) where deleted_at is null;

create trigger garage_domains_updated before update on public.garage_domains
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Garage context helpers (ARCHITECTURE.md; DECISIONS.md A6)
-- ---------------------------------------------------------------------------

-- The x-garage-id request header as PostgREST exposes it. Missing, malformed
-- or non-uuid values give null; this function never raises.
create function public.request_garage_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  raw_headers text := current_setting('request.headers', true);
  candidate text;
begin
  if raw_headers is null or raw_headers = '' then
    return null;
  end if;
  candidate := raw_headers::json ->> 'x-garage-id';
  if candidate is null
     or candidate !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return candidate::uuid;
exception
  when others then
    return null;
end
$$;

-- auth.uid()'s role in the garage, or null.
create function public.garage_role(p_garage_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select member.role
  from public.garage_members member
  where member.garage_id = p_garage_id
    and member.user_id = auth.uid()
$$;

-- The requested garage when the caller is the service role or a member of it,
-- otherwise null. A forged header therefore yields zero rows, never an error.
create function public.current_garage_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select requested.garage_id
  from (select public.request_garage_id() as garage_id) requested
  where requested.garage_id is not null
    and (
      auth.role() = 'service_role'
      or current_setting('role', true) = 'service_role'
      or public.garage_role(requested.garage_id) is not null
    )
$$;

create function public.current_garage_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.garage_role(public.current_garage_id())
$$;

create function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins platform_admin
    where platform_admin.user_id = auth.uid()
  )
$$;

-- garage_members and garage_domains are tenant rows like any other.
alter table public.garage_members alter column garage_id set default public.current_garage_id();
alter table public.garage_domains alter column garage_id set default public.current_garage_id();

-- A garage always keeps at least one owner. Deleting the garage itself
-- cascades past this check.
create function public.protect_last_garage_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner' and new.garage_id = old.garage_id) then
    return coalesce(new, old);
  end if;

  perform 1 from public.garages garage where garage.id = old.garage_id for update;
  if not found then
    return coalesce(new, old);
  end if;

  if not exists (
    select 1
    from public.garage_members member
    where member.garage_id = old.garage_id
      and member.role = 'owner'
      and member.id <> old.id
  ) then
    raise exception 'GARAGE_NEEDS_AN_OWNER' using errcode = '23514';
  end if;
  return coalesce(new, old);
end
$$;

create trigger garage_members_keep_owner before update or delete on public.garage_members
  for each row execute function public.protect_last_garage_owner();

-- ---------------------------------------------------------------------------
-- 3. Remove SOB's single-business authorisation
-- ---------------------------------------------------------------------------

drop trigger enforce_allowed_admin_email on public.admin_profiles;
drop function public.enforce_allowed_admin_email();

drop policy "admins manage profiles" on public.admin_profiles;
drop policy "admins read audit log" on public.admin_audit_log;
drop policy "admins manage settings" on public.site_settings;
drop policy "admins read resend webhook events" on public.resend_webhook_events;
drop policy "admins read inbound email events" on public.inbound_email_events;
drop policy "admins read provider webhook events" on public.provider_webhook_events;
drop policy "admins manage customers" on public.customers;
drop policy "admins manage vehicles" on public.vehicles;
drop policy "admins manage service catalogue systems" on public.service_catalogue_systems;
drop policy "admins manage booking service types" on public.booking_service_types;
drop policy "admins read bookings" on public.bookings;
drop policy "admins update bookings" on public.bookings;
drop policy "admins read booking audit" on public.booking_audit_log;
drop policy "admins read booking notification events" on public.booking_notification_events;
drop policy "admins manage enquiries" on public.enquiries;
drop policy "admins manage enquiry messages" on public.enquiry_messages;
drop policy "admins manage attachments" on public.enquiry_attachments;
drop policy "admins manage enquiry conversations" on public.enquiry_conversations;
drop policy "admins manage notifications" on public.notification_attempts;
drop policy "admins manage unmatched inbound" on public.unmatched_inbound_emails;
drop policy "admins read invoices" on public.invoices;
drop policy "admins read invoice items" on public.invoice_items;
drop policy "admins read invoice payments" on public.invoice_payments;
drop policy "admins read invoice email sends" on public.invoice_email_sends;
drop policy "admins read invoice email attempts" on public.invoice_email_attempts;
drop policy "admins manage media" on public.media_assets;
drop policy "published media metadata is public" on public.media_assets;
drop policy "admins manage offers" on public.offers;
drop policy "active offers are public" on public.offers;
drop policy "admins manage reviews" on public.reviews;
drop policy "visible reviews are public" on public.reviews;
drop policy "admins manage prices" on public.service_prices;
drop policy "published prices are public" on public.service_prices;

drop policy "admins upload public media" on storage.objects;
drop policy "admins update public media" on storage.objects;
drop policy "admins delete public media" on storage.objects;
drop policy "admins read private attachments" on storage.objects;

-- is_admin() itself is dropped at the end, once nothing refers to it.

-- ---------------------------------------------------------------------------
-- 4. garage_id on every tenant table
-- ---------------------------------------------------------------------------
-- Each table gets
--   garage_id uuid not null default public.current_garage_id()
--     references public.garages(id) on delete cascade
-- and child tables reference their parent through (garage_id, parent_id), so a
-- row can never point at another garage's row. Parents gain unique
-- (garage_id, id) for those foreign keys.

-- customers
alter table public.customers
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  add constraint customers_garage_id_id_key unique (garage_id, id);
create index customers_garage_created_idx on public.customers (garage_id, created_at desc);
create index customers_garage_phone_idx on public.customers (garage_id, phone);

-- vehicles
alter table public.vehicles
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  add constraint vehicles_garage_id_id_key unique (garage_id, id),
  drop constraint vehicles_customer_id_fkey,
  add constraint vehicles_customer_id_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id) on delete set null (customer_id);
create index vehicles_garage_customer_idx on public.vehicles (garage_id, customer_id);
create index vehicles_garage_registration_idx on public.vehicles (garage_id, registration);

-- Registrations are stored normalised: upper case, letters and digits only.
create function public.normalise_vehicle_registration()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.registration := nullif(upper(regexp_replace(coalesce(new.registration, ''), '[^A-Za-z0-9]', '', 'g')), '');
  return new;
end
$$;

create trigger vehicles_normalise_registration before insert or update of registration on public.vehicles
  for each row execute function public.normalise_vehicle_registration();

-- service_catalogue_systems (replaced by services in P2.1)
alter table public.service_catalogue_systems
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint service_catalogue_systems_system_key_key,
  add constraint service_catalogue_systems_garage_id_system_key_key unique (garage_id, system_key),
  add constraint service_catalogue_systems_garage_id_id_key unique (garage_id, id);
drop index public.service_catalogue_systems_active_sort_idx;
create index service_catalogue_systems_active_sort_idx
  on public.service_catalogue_systems (garage_id, sort_order, display_name) where deleted_at is null;

-- booking_service_types (replaced by services in P2.1). The system foreign key
-- is "no action" rather than SOB's "restrict" so deleting a garage can cascade
-- through both tables in one statement.
alter table public.booking_service_types
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint booking_service_types_service_key_key,
  drop constraint booking_service_types_system_id_fkey,
  add constraint booking_service_types_garage_id_service_key_key unique (garage_id, service_key),
  add constraint booking_service_types_garage_id_id_key unique (garage_id, id),
  add constraint booking_service_types_system_id_fkey foreign key (garage_id, system_id)
    references public.service_catalogue_systems (garage_id, id);
drop index public.booking_service_types_catalogue_sort_idx;
create index booking_service_types_catalogue_sort_idx
  on public.booking_service_types (garage_id, system_id, sort_order, display_name) where deleted_at is null;

-- bookings: references are unique per garage and use the garage's prefix.
alter table public.bookings
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  alter column booking_reference drop default,
  drop constraint bookings_booking_reference_key,
  drop constraint bookings_booking_reference_check,
  drop constraint bookings_customer_id_fkey,
  drop constraint bookings_vehicle_id_fkey,
  drop constraint bookings_service_type_id_fkey,
  add constraint bookings_booking_reference_check check (booking_reference ~ '^[A-Z]{2,4}-[0-9]{4,6}$'),
  add constraint bookings_garage_id_booking_reference_key unique (garage_id, booking_reference),
  add constraint bookings_garage_id_id_key unique (garage_id, id),
  add constraint bookings_customer_id_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id),
  add constraint bookings_vehicle_id_fkey foreign key (garage_id, vehicle_id)
    references public.vehicles (garage_id, id),
  add constraint bookings_service_type_id_fkey foreign key (garage_id, service_type_id)
    references public.booking_service_types (garage_id, id);
drop index public.bookings_active_created_idx;
drop index public.bookings_admin_unseen_idx;
drop index public.bookings_appointment_start_idx;
drop index public.bookings_idempotency_idx;
drop index public.bookings_service_type_idx;
drop index public.bookings_sync_state_idx;
create index bookings_active_created_idx on public.bookings (garage_id, created_at desc) where deleted_at is null;
create index bookings_admin_unseen_idx on public.bookings (garage_id, created_at desc) where admin_seen_at is null;
create index bookings_appointment_start_idx on public.bookings (garage_id, appointment_start desc);
create unique index bookings_idempotency_idx on public.bookings (garage_id, idempotency_key)
  where idempotency_key is not null;
create index bookings_service_type_idx on public.bookings (garage_id, service_type_id);
create index bookings_sync_state_idx on public.bookings (garage_id, provider_sync_state, appointment_start);
create index bookings_garage_customer_idx on public.bookings (garage_id, customer_id);
create index bookings_garage_vehicle_idx on public.bookings (garage_id, vehicle_id);
-- bookings_provider_uid_idx stays global: a Cal.com booking uid is unique at
-- the provider and its webhook looks bookings up before it knows the garage.
-- P2.1 drops it with the other provider_* columns.

-- booking_audit_log
alter table public.booking_audit_log
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint booking_audit_log_booking_id_fkey,
  add constraint booking_audit_log_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade;
create index booking_audit_log_garage_booking_idx on public.booking_audit_log (garage_id, booking_id, created_at);

-- booking_notification_events
alter table public.booking_notification_events
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint booking_notification_events_booking_id_fkey,
  add constraint booking_notification_events_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade;
create index booking_notification_events_garage_booking_idx
  on public.booking_notification_events (garage_id, booking_id);
create index booking_notification_events_garage_status_idx
  on public.booking_notification_events (garage_id, status);

-- enquiries
alter table public.enquiries
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  add constraint enquiries_garage_id_id_key unique (garage_id, id),
  drop constraint enquiries_customer_id_fkey,
  drop constraint enquiries_vehicle_id_fkey,
  drop constraint enquiries_booking_id_fkey,
  add constraint enquiries_customer_id_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id),
  add constraint enquiries_vehicle_id_fkey foreign key (garage_id, vehicle_id)
    references public.vehicles (garage_id, id),
  add constraint enquiries_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete set null (booking_id);
drop index public.enquiries_active_created_idx;
drop index public.enquiries_booking_thread_unique;
create index enquiries_active_created_idx on public.enquiries (garage_id, created_at desc) where deleted_at is null;
create unique index enquiries_booking_thread_unique on public.enquiries (garage_id, booking_id)
  where booking_id is not null;
create index enquiries_garage_customer_idx on public.enquiries (garage_id, customer_id);
create index enquiries_garage_vehicle_idx on public.enquiries (garage_id, vehicle_id);

-- enquiry_messages. message_id and provider_email_id stay globally unique:
-- inbound replies are matched to a thread before the garage is known.
alter table public.enquiry_messages
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  add constraint enquiry_messages_garage_id_id_key unique (garage_id, id),
  drop constraint enquiry_messages_enquiry_id_fkey,
  add constraint enquiry_messages_enquiry_id_fkey foreign key (garage_id, enquiry_id)
    references public.enquiries (garage_id, id) on delete cascade;
drop index public.enquiry_messages_thread_order;
create index enquiry_messages_thread_order on public.enquiry_messages (garage_id, enquiry_id, created_at, id);

-- enquiry_attachments. Storage paths start with the garage id.
alter table public.enquiry_attachments
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint enquiry_attachments_enquiry_id_fkey,
  drop constraint enquiry_attachments_enquiry_message_id_fkey,
  add constraint enquiry_attachments_enquiry_id_fkey foreign key (garage_id, enquiry_id)
    references public.enquiries (garage_id, id) on delete cascade,
  add constraint enquiry_attachments_enquiry_message_id_fkey foreign key (garage_id, enquiry_message_id)
    references public.enquiry_messages (garage_id, id) on delete set null (enquiry_message_id),
  add constraint enquiry_attachments_object_path_garage_check
    check (split_part(object_path, '/', 1) = garage_id::text);
drop index public.enquiry_attachments_message;
create index enquiry_attachments_message on public.enquiry_attachments (garage_id, enquiry_message_id)
  where enquiry_message_id is not null;
create index enquiry_attachments_garage_enquiry_idx on public.enquiry_attachments (garage_id, enquiry_id);

-- enquiry_conversations. reply_token stays globally unique (inbound routing).
alter table public.enquiry_conversations
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint enquiry_conversations_enquiry_id_fkey,
  add constraint enquiry_conversations_enquiry_id_fkey foreign key (garage_id, enquiry_id)
    references public.enquiries (garage_id, id) on delete cascade;
create index enquiry_conversations_garage_activity_idx
  on public.enquiry_conversations (garage_id, last_activity_at desc);

-- notification_attempts
alter table public.notification_attempts
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint notification_attempts_enquiry_id_fkey,
  add constraint notification_attempts_enquiry_id_fkey foreign key (garage_id, enquiry_id)
    references public.enquiries (garage_id, id) on delete cascade;
create index notification_attempts_garage_enquiry_idx
  on public.notification_attempts (garage_id, enquiry_id, attempted_at desc);

-- invoices. Issuer details come from the garage (see protect_invoice_history);
-- numbers are <booking_prefix>-YYYY-NNNNNN, sequenced per garage and year.
alter table public.invoices
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  alter column issuer_legal_name drop default,
  alter column issuer_trading_name drop default,
  alter column issuer_tagline drop default,
  alter column issuer_address drop default,
  alter column issuer_email drop default,
  alter column issuer_phone drop default,
  alter column issuer_company_number drop default,
  drop constraint invoices_invoice_number_key,
  drop constraint invoices_invoice_year_invoice_sequence_key,
  drop constraint invoices_numbering_coherence,
  drop constraint invoices_booking_id_fkey,
  drop constraint invoices_enquiry_id_fkey,
  drop constraint invoices_customer_id_fkey,
  drop constraint invoices_vehicle_id_fkey,
  drop constraint invoices_replaces_invoice_id_fkey,
  add constraint invoices_garage_id_id_key unique (garage_id, id),
  add constraint invoices_garage_id_invoice_number_key unique (garage_id, invoice_number),
  add constraint invoices_garage_id_invoice_year_invoice_sequence_key unique (garage_id, invoice_year, invoice_sequence),
  add constraint invoices_numbering_coherence check (
    (status = 'draft' and invoice_number is null and invoice_year is null and invoice_sequence is null)
    or (
      status <> 'draft'
      and invoice_number is not null
      and invoice_year is not null
      and invoice_sequence is not null
      and issue_date is not null
      and invoice_year = extract(year from issue_date)::integer
      and invoice_number ~ '^[A-Z]{2,4}-[0-9]{4}-[0-9]{6}$'
      and split_part(invoice_number, '-', 2) = invoice_year::text
      and split_part(invoice_number, '-', 3) = lpad(invoice_sequence::text, 6, '0')
    )
  );
alter table public.invoices
  add constraint invoices_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id),
  add constraint invoices_enquiry_id_fkey foreign key (garage_id, enquiry_id)
    references public.enquiries (garage_id, id),
  add constraint invoices_customer_id_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id),
  add constraint invoices_vehicle_id_fkey foreign key (garage_id, vehicle_id)
    references public.vehicles (garage_id, id),
  add constraint invoices_replaces_invoice_id_fkey foreign key (garage_id, replaces_invoice_id)
    references public.invoices (garage_id, id);
drop index public.invoices_active_created_idx;
drop index public.invoices_booking_idx;
drop index public.invoices_created_at_idx;
drop index public.invoices_enquiry_idx;
drop index public.invoices_registration_search_idx;
drop index public.invoices_replaces_idx;
drop index public.invoices_status_due_idx;
create index invoices_active_created_idx on public.invoices (garage_id, created_at desc) where deleted_at is null;
create index invoices_booking_idx on public.invoices (garage_id, booking_id) where booking_id is not null;
create index invoices_created_at_idx on public.invoices (garage_id, created_at desc);
create index invoices_enquiry_idx on public.invoices (garage_id, enquiry_id) where enquiry_id is not null;
create index invoices_registration_search_idx
  on public.invoices (garage_id, upper(regexp_replace(coalesce(vehicle_registration, ''), '[^A-Za-z0-9]', '', 'g')));
create index invoices_replaces_idx on public.invoices (garage_id, replaces_invoice_id) where replaces_invoice_id is not null;
create index invoices_status_due_idx on public.invoices (garage_id, status, due_date);
create index invoices_garage_customer_idx on public.invoices (garage_id, customer_id) where customer_id is not null;
create index invoices_garage_vehicle_idx on public.invoices (garage_id, vehicle_id) where vehicle_id is not null;

-- invoice_items
alter table public.invoice_items
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint invoice_items_invoice_id_fkey,
  add constraint invoice_items_invoice_id_fkey foreign key (garage_id, invoice_id)
    references public.invoices (garage_id, id) on delete cascade;
drop index public.invoice_items_invoice_position_idx;
create index invoice_items_invoice_position_idx on public.invoice_items (garage_id, invoice_id, position);

-- invoice_number_sequences: one sequence per garage and year.
alter table public.invoice_number_sequences
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint invoice_number_sequences_pkey,
  add constraint invoice_number_sequences_pkey primary key (garage_id, invoice_year);

-- invoice_payments
alter table public.invoice_payments
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint invoice_payments_invoice_id_fkey,
  add constraint invoice_payments_invoice_id_fkey foreign key (garage_id, invoice_id)
    references public.invoices (garage_id, id);
drop index public.invoice_payments_invoice_paid_idx;
create index invoice_payments_invoice_paid_idx on public.invoice_payments (garage_id, invoice_id, paid_at, created_at);
create index invoice_payments_garage_paid_idx on public.invoice_payments (garage_id, paid_at);

-- invoice_email_sends. provider_idempotency_key is derived from the invoice id
-- and stays globally unique.
alter table public.invoice_email_sends
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  add constraint invoice_email_sends_garage_id_id_key unique (garage_id, id),
  drop constraint invoice_email_sends_invoice_id_fkey,
  add constraint invoice_email_sends_invoice_id_fkey foreign key (garage_id, invoice_id)
    references public.invoices (garage_id, id);
drop index public.invoice_email_sends_invoice_idx;
create index invoice_email_sends_invoice_idx on public.invoice_email_sends (garage_id, invoice_id, requested_at desc);

-- invoice_email_attempts
alter table public.invoice_email_attempts
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint invoice_email_attempts_invoice_id_fkey,
  drop constraint invoice_email_attempts_logical_send_id_fkey,
  add constraint invoice_email_attempts_invoice_id_fkey foreign key (garage_id, invoice_id)
    references public.invoices (garage_id, id),
  add constraint invoice_email_attempts_logical_send_id_fkey foreign key (garage_id, logical_send_id)
    references public.invoice_email_sends (garage_id, id) on delete cascade;
drop index public.invoice_email_attempts_invoice_idx;
drop index public.invoice_email_attempts_logical_idx;
create index invoice_email_attempts_invoice_idx on public.invoice_email_attempts (garage_id, invoice_id, attempted_at desc);
create index invoice_email_attempts_logical_idx on public.invoice_email_attempts (garage_id, logical_send_id, attempt_number desc);

-- media_assets. Storage paths start with the garage id.
alter table public.media_assets
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  add constraint media_assets_object_path_garage_check check (split_part(object_path, '/', 1) = garage_id::text);
drop index public.media_assets_active_created_idx;
create index media_assets_active_created_idx on public.media_assets (garage_id, created_at desc) where deleted_at is null;

-- offers
alter table public.offers
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade;
drop index public.offers_active_updated_idx;
create index offers_active_updated_idx on public.offers (garage_id, updated_at desc) where deleted_at is null;

-- reviews
alter table public.reviews
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint reviews_provider_review_id_key,
  add constraint reviews_garage_id_provider_review_id_key unique (garage_id, provider_review_id);
drop index public.reviews_active_fetched_idx;
create index reviews_active_fetched_idx on public.reviews (garage_id, fetched_at desc) where deleted_at is null;

-- service_prices
alter table public.service_prices
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  drop constraint service_prices_pkey,
  add constraint service_prices_pkey primary key (garage_id, service_slug);

-- site_settings: one row per garage instead of SOB's boolean singleton.
alter table public.site_settings
  drop constraint site_settings_pkey,
  drop constraint site_settings_id_check,
  drop column id,
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  add constraint site_settings_pkey primary key (garage_id);

-- admin_audit_log: staff actions are recorded against the garage they acted in.
alter table public.admin_audit_log
  add column garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade;
create index admin_audit_log_garage_created_idx on public.admin_audit_log (garage_id, created_at desc);
create index admin_audit_log_garage_entity_idx on public.admin_audit_log (garage_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- 5. Internal helpers used by the rewritten functions
-- ---------------------------------------------------------------------------

-- SOB's database-level MFA rule, carried over for privileged staff RPCs
-- (invoicing and trash): a user with a verified TOTP factor must call with an
-- AAL2 session; a user without one is allowed unless they are an owner and
-- admin_mfa_policy makes MFA mandatory for owners. Table reads under RLS follow
-- membership only (ARCHITECTURE.md); the app enforces MFA before handing out
-- its RLS client.
create function public.garage_actor_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.role() = 'authenticated'
    and auth.uid() is not null
    and public.current_garage_id() is not null
    and case
      when exists (
        select 1
        from auth.mfa_factors factor
        where factor.user_id = auth.uid()
          and factor.status = 'verified'
          and factor.factor_type = 'totp'
      ) then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      else not (
        public.current_garage_role() = 'owner'
        and coalesce((select policy.mandatory_mfa_enabled from public.admin_mfa_policy policy where policy.singleton), false)
      )
    end
$$;

-- Users who may hold MFA recovery codes: garage staff, platform admins and
-- anyone with a profile.
create function public.is_staff_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.garage_members member where member.user_id = p_user_id)
    or exists (select 1 from public.platform_admins platform_admin where platform_admin.user_id = p_user_id)
    or exists (select 1 from public.admin_profiles profile where profile.user_id = p_user_id)
$$;

-- Account-level security events belong to the user, not one garage; every
-- garage the user works for gets a copy in its audit log.
create function public.audit_user_security_event(p_user_id uuid, p_action text, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  select member.garage_id, p_user_id, p_action, 'admin_security', p_user_id::text, p_detail
  from public.garage_members member
  where member.user_id = p_user_id
$$;

-- Invoice issuer details for a garage, formatted the way SOB stored them.
create function public.garage_invoice_issuer(p_garage_id uuid)
returns table (
  legal_name text,
  trading_name text,
  tagline text,
  address text,
  email text,
  phone text,
  company_number text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(nullif(trim(garage.legal_name), ''), garage.name),
    garage.name,
    coalesce(garage.settings ->> 'tagline', ''),
    concat_ws(
      E'\n',
      nullif(trim(garage.address ->> 'line1'), ''),
      nullif(trim(garage.address ->> 'line2'), ''),
      nullif(trim(garage.address ->> 'town'), ''),
      nullif(trim(garage.address ->> 'postcode'), '')
    ),
    coalesce(garage.email, ''),
    coalesce(garage.phone, ''),
    coalesce(garage.company_number, '')
  from public.garages garage
  where garage.id = p_garage_id
$$;

-- ---------------------------------------------------------------------------
-- 6. Garage-scoped functions
-- ---------------------------------------------------------------------------
-- Staff RPCs (granted to authenticated) take the garage from
-- current_garage_id() and filter every statement by it, so ids from another
-- garage behave exactly like ids that do not exist. Service-role functions
-- take an explicit p_garage_id and filter by that.

-- 6a. Booking references -----------------------------------------------------

drop function public.generate_booking_reference();

-- <booking_prefix>-NNNN, random and unique per garage; widens to 5 and then 6
-- digits once 4-digit candidates keep colliding.
create function public.generate_booking_reference(p_garage_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefix text;
  candidate text;
  attempt integer := 0;
  digits integer;
begin
  select garage.booking_prefix
  into prefix
  from public.garages garage
  where garage.id = p_garage_id;
  if prefix is null then
    raise exception 'GARAGE_NOT_FOUND';
  end if;

  -- Serialise allocation per garage so the existence check and the following
  -- insert cannot race another booking for the same garage.
  perform pg_advisory_xact_lock(hashtextextended('public.bookings.booking_reference:' || p_garage_id::text, 0));

  loop
    attempt := attempt + 1;
    if attempt > 1000 then
      raise exception 'BOOKING_REFERENCE_SPACE_EXHAUSTED';
    end if;
    digits := case when attempt <= 20 then 4 when attempt <= 40 then 5 else 6 end;
    candidate := prefix || '-' || lpad(floor(random() * (10 ^ digits))::integer::text, digits, '0');
    exit when not exists (
      select 1
      from public.bookings booking
      where booking.garage_id = p_garage_id
        and booking.booking_reference = candidate
    );
  end loop;
  return candidate;
end
$$;

create function public.assign_booking_reference()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.booking_reference is null then
    new.booking_reference := public.generate_booking_reference(new.garage_id);
  end if;
  return new;
end
$$;

create trigger bookings_assign_reference before insert on public.bookings
  for each row execute function public.assign_booking_reference();

-- 6b. Bookings and enquiry threads (service role) ----------------------------

drop function public.create_booking_intent(uuid, text, text, text, text, text, text, integer, text, text, text, uuid, text, text, text, jsonb, jsonb, text, text, text, text, timestamptz, text);

create function public.create_booking_intent(
  p_garage_id uuid,
  p_idempotency_key uuid,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_registration text,
  p_vehicle_make text,
  p_vehicle_model text,
  p_vehicle_year integer,
  p_vehicle_colour text,
  p_vehicle_fuel_type text,
  p_vehicle_transmission text,
  p_service_type_id uuid,
  p_service_key text,
  p_service_name text,
  p_problem_description text,
  p_symptoms jsonb,
  p_conditional_answers jsonb,
  p_location_mode text,
  p_location text,
  p_service_address text,
  p_service_postcode text,
  p_appointment_start timestamptz,
  p_timezone text
)
returns table (booking_id uuid, booking_reference text, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_booking public.bookings%rowtype;
  new_customer_id uuid;
  new_vehicle_id uuid;
  new_booking public.bookings%rowtype;
begin
  if p_garage_id is null then
    raise exception 'GARAGE_REQUIRED' using errcode = '22004';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_garage_id::text || ':' || p_idempotency_key::text, 0));

  select booking.* into existing_booking
  from public.bookings booking
  where booking.garage_id = p_garage_id
    and booking.idempotency_key = p_idempotency_key;
  if found then
    return query select existing_booking.id, existing_booking.booking_reference, false;
    return;
  end if;

  insert into public.customers (garage_id, name, email, phone, preferred_contact)
  values (p_garage_id, trim(p_customer_name), lower(trim(p_customer_email)), trim(p_customer_phone), 'email')
  returning id into new_customer_id;

  insert into public.vehicles (garage_id, customer_id, registration, make, model, year, colour, fuel_type, transmission)
  values (
    p_garage_id,
    new_customer_id,
    upper(regexp_replace(p_registration, '[^A-Za-z0-9]', '', 'g')),
    nullif(trim(p_vehicle_make), ''),
    nullif(trim(p_vehicle_model), ''),
    p_vehicle_year,
    nullif(trim(p_vehicle_colour), ''),
    nullif(trim(p_vehicle_fuel_type), ''),
    nullif(trim(p_vehicle_transmission), '')
  )
  returning id into new_vehicle_id;

  insert into public.bookings (
    garage_id,
    customer_id,
    vehicle_id,
    service_type_id,
    idempotency_key,
    provider,
    provider_event_type_id,
    provider_sync_state,
    status,
    service_key,
    service_name,
    problem_description,
    symptoms,
    conditional_answers,
    location_mode,
    location,
    service_address,
    service_postcode,
    appointment_start,
    original_appointment_start,
    timezone
  )
  select
    p_garage_id,
    new_customer_id,
    new_vehicle_id,
    p_service_type_id,
    p_idempotency_key,
    service.provider,
    service.provider_event_type_id,
    'pending',
    'pending',
    service.service_key,
    service.display_name,
    p_problem_description,
    coalesce(p_symptoms, '[]'::jsonb),
    coalesce(p_conditional_answers, '{}'::jsonb),
    p_location_mode,
    p_location,
    nullif(trim(p_service_address), ''),
    nullif(trim(p_service_postcode), ''),
    p_appointment_start,
    p_appointment_start,
    p_timezone
  from public.booking_service_types service
  where service.garage_id = p_garage_id
    and service.id = p_service_type_id
    and service.service_key = p_service_key
    and service.display_name = p_service_name
    and service.online_booking_enabled
    and service.provider_event_type_id is not null
    and (service.location_mode = 'both' or service.location_mode = p_location_mode)
  returning * into new_booking;

  if new_booking.id is null then
    raise exception 'BOOKING_SERVICE_NOT_AVAILABLE';
  end if;

  insert into public.booking_audit_log (garage_id, booking_id, action, actor_type, detail)
  values (p_garage_id, new_booking.id, 'created', 'system', jsonb_build_object('state', 'intent'));

  return query select new_booking.id, new_booking.booking_reference, true;
exception
  when unique_violation then
    select booking.* into existing_booking
    from public.bookings booking
    where booking.garage_id = p_garage_id
      and booking.idempotency_key = p_idempotency_key;
    if existing_booking.id is null then raise; end if;
    return query select existing_booking.id, existing_booking.booking_reference, false;
end
$$;

drop function public.create_booking_enquiry_thread(uuid, uuid);

-- Security invoker on purpose: it runs as the service role and needs nothing
-- the service role cannot already do.
create function public.create_booking_enquiry_thread(p_garage_id uuid, target_booking_id uuid, actor_id_value uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_booking record;
  selected_enquiry_id uuid;
  garage_name text;
  garage_timezone text;
  was_created boolean := false;
  initial_message text;
begin
  select garage.name, garage.timezone
  into garage_name, garage_timezone
  from public.garages garage
  where garage.id = p_garage_id;
  if not found then
    raise exception 'Booking not found';
  end if;

  select
    booking.id,
    booking.booking_reference,
    booking.customer_id,
    booking.vehicle_id,
    booking.service_key,
    booking.service_name,
    booking.problem_description,
    booking.notes,
    booking.service_postcode,
    booking.appointment_start
  into selected_booking
  from public.bookings as booking
  where booking.garage_id = p_garage_id
    and booking.id = target_booking_id;

  if not found then
    raise exception 'Booking not found';
  end if;

  select enquiry.id
  into selected_enquiry_id
  from public.enquiries as enquiry
  where enquiry.garage_id = p_garage_id
    and enquiry.booking_id = target_booking_id;

  if selected_enquiry_id is null then
    initial_message := concat_ws(
      E'\n',
      'Booking ' || selected_booking.booking_reference,
      'Service: ' || selected_booking.service_name,
      'Appointment: ' || to_char(selected_booking.appointment_start at time zone garage_timezone, 'FMDay, FMDD FMMonth YYYY at HH24:MI') || ' (local time)',
      case
        when nullif(trim(coalesce(selected_booking.problem_description, '')), '') is not null
          then 'Customer description: ' || trim(selected_booking.problem_description)
      end,
      case
        when nullif(trim(coalesce(selected_booking.notes, '')), '') is not null
          then 'Booking notes: ' || trim(selected_booking.notes)
      end
    );

    begin
      insert into public.enquiries (
        garage_id,
        type,
        customer_id,
        vehicle_id,
        booking_id,
        service_slug,
        description,
        location_postcode,
        status,
        notification_status
      )
      values (
        p_garage_id,
        'general',
        selected_booking.customer_id,
        selected_booking.vehicle_id,
        target_booking_id,
        selected_booking.service_key,
        initial_message,
        selected_booking.service_postcode,
        'booked',
        'sent'
      )
      returning id into selected_enquiry_id;
      was_created := true;
    exception
      when unique_violation then
        select enquiry.id
        into selected_enquiry_id
        from public.enquiries as enquiry
        where enquiry.garage_id = p_garage_id
          and enquiry.booking_id = target_booking_id;
    end;
  end if;

  if selected_enquiry_id is null then
    raise exception 'Booking enquiry thread could not be created';
  end if;

  insert into public.enquiry_conversations (garage_id, enquiry_id, subject)
  values (
    p_garage_id,
    selected_enquiry_id,
    left('Your ' || garage_name || ' booking ' || selected_booking.booking_reference, 180)
  )
  on conflict (enquiry_id) do nothing;

  if was_created then
    insert into public.admin_audit_log (
      garage_id,
      actor_id,
      action,
      entity_type,
      entity_id,
      detail
    )
    values (
      p_garage_id,
      actor_id_value,
      'booking.enquiry_thread_created',
      'enquiry',
      selected_enquiry_id,
      jsonb_build_object(
        'bookingId', target_booking_id,
        'bookingReference', selected_booking.booking_reference
      )
    );
  end if;

  return selected_enquiry_id;
end
$$;

drop function public.increment_enquiry_unread(uuid, timestamptz);

create function public.increment_enquiry_unread(p_garage_id uuid, target_enquiry_id uuid, activity_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.enquiry_conversations conversation
  set unread_count = conversation.unread_count + 1,
      last_activity_at = greatest(conversation.last_activity_at, activity_at)
  where conversation.garage_id = p_garage_id
    and conversation.enquiry_id = target_enquiry_id;
$$;

drop function public.store_inbound_email_message(uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz, text);

create function public.store_inbound_email_message(
  p_garage_id uuid,
  target_enquiry_id uuid,
  transport_name text,
  transport_event_id text,
  sender_name_value text,
  sender_email_value text,
  recipient_email_value text,
  subject_value text,
  text_body_value text,
  rfc_message_id text,
  reply_to_message_id text,
  reference_id_values text[],
  message_created_at timestamptz,
  match_reason text
)
returns table (stored_message_id uuid, was_inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_message_id uuid;
begin
  if transport_name not in ('resend', 'cloudflare') then
    raise exception 'Invalid inbound email transport';
  end if;
  if not exists (
    select 1
    from public.enquiries enquiry
    where enquiry.garage_id = p_garage_id
      and enquiry.id = target_enquiry_id
  ) then
    raise exception 'ENQUIRY_NOT_FOUND';
  end if;

  insert into public.enquiry_messages (
    garage_id,
    enquiry_id,
    direction,
    message_type,
    sender_name,
    sender_email,
    recipient_email,
    subject,
    text_body,
    provider,
    provider_email_id,
    message_id,
    in_reply_to,
    reference_ids,
    delivery_status,
    is_read,
    created_at
  ) values (
    p_garage_id,
    target_enquiry_id,
    'inbound',
    'email',
    sender_name_value,
    sender_email_value,
    recipient_email_value,
    subject_value,
    text_body_value,
    transport_name,
    transport_event_id,
    rfc_message_id,
    reply_to_message_id,
    coalesce(reference_id_values, '{}'),
    'received',
    false,
    message_created_at
  )
  on conflict do nothing
  returning id into new_message_id;

  if new_message_id is null then
    select message.id into new_message_id
    from public.enquiry_messages message
    where message.garage_id = p_garage_id
      and (
        message.provider_email_id = transport_event_id
        or (rfc_message_id is not null and message.message_id = rfc_message_id)
      )
    order by message.created_at
    limit 1;

    return query select new_message_id, false;
    return;
  end if;

  update public.enquiry_conversations conversation
  set unread_count = conversation.unread_count + 1,
      last_activity_at = greatest(conversation.last_activity_at, message_created_at)
  where conversation.garage_id = p_garage_id
    and conversation.enquiry_id = target_enquiry_id;

  update public.enquiries enquiry
  set status = 'contacted'
  where enquiry.garage_id = p_garage_id
    and enquiry.id = target_enquiry_id
    and enquiry.status <> 'closed';

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    p_garage_id,
    null,
    'enquiry.reply_received',
    'enquiry_message',
    new_message_id::text,
    jsonb_build_object('enquiryId', target_enquiry_id, 'match', match_reason, 'transport', transport_name)
  );

  return query select new_message_id, true;
end
$$;

drop function public.apply_enquiry_retention();

-- Closed enquiries older than 12 months lose their attachments, and customers
-- with no open or recent enquiry are anonymised. Customers with bookings or
-- invoices are never anonymised here (SOB's version anonymised booking-only
-- customers on the next run).
create function public.apply_enquiry_retention(p_garage_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_garage_id is null then
    raise exception 'GARAGE_REQUIRED' using errcode = '22004';
  end if;

  -- Newer Storage versions block direct deletes unless this is set.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects object
  where object.bucket_id = 'enquiry-attachments'
    and object.name in (
      select attachment.object_path
      from public.enquiry_attachments attachment
      join public.enquiries enquiry
        on enquiry.garage_id = attachment.garage_id
       and enquiry.id = attachment.enquiry_id
      where attachment.garage_id = p_garage_id
        and enquiry.status = 'closed'
        and enquiry.closed_at < now() - interval '12 months'
    );

  delete from public.enquiry_attachments attachment
  where attachment.garage_id = p_garage_id
    and attachment.enquiry_id in (
      select enquiry.id
      from public.enquiries enquiry
      where enquiry.garage_id = p_garage_id
        and enquiry.status = 'closed'
        and enquiry.closed_at < now() - interval '12 months'
    );

  update public.customers customer
  set name = 'Anonymised', email = null, phone = 'REDACTED', anonymised_at = now()
  where customer.garage_id = p_garage_id
    and customer.anonymised_at is null
    and not exists (
      select 1
      from public.enquiries enquiry
      where enquiry.garage_id = customer.garage_id
        and enquiry.customer_id = customer.id
        and (enquiry.status <> 'closed' or enquiry.closed_at >= now() - interval '12 months')
    )
    and not exists (
      select 1
      from public.bookings booking
      where booking.garage_id = customer.garage_id
        and booking.customer_id = customer.id
    )
    and not exists (
      select 1
      from public.invoices invoice
      where invoice.garage_id = customer.garage_id
        and invoice.customer_id = customer.id
    );
  get diagnostics affected = row_count;
  return affected;
end
$$;

-- 6c. Administrator MFA recovery (service role, platform tables) -------------

create or replace function public.replace_admin_mfa_recovery_codes(p_user_id uuid, p_code_hashes text[], p_event_action text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  l_set_id uuid := gen_random_uuid();
  l_inserted integer;
  l_revoked_devices integer;
begin
  if p_event_action not in ('mfa_recovery_codes_created', 'mfa_recovery_codes_regenerated') then
    raise exception 'INVALID_RECOVERY_CODE_EVENT';
  end if;
  if cardinality(p_code_hashes) <> 10
     or (select count(distinct value) from unnest(p_code_hashes) as hashes(value)) <> 10
     or exists (select 1 from unnest(p_code_hashes) as hashes(value) where value !~ '^[0-9a-f]{64}$') then
    raise exception 'INVALID_RECOVERY_CODE_SET';
  end if;
  if not public.is_staff_user(p_user_id)
     or not exists (select 1 from auth.mfa_factors where user_id = p_user_id and status = 'verified' and factor_type = 'totp') then
    raise exception 'RECOVERY_CODES_REQUIRE_VERIFIED_ADMIN_TOTP';
  end if;

  update public.admin_mfa_recovery_codes
  set revoked_at = now()
  where user_id = p_user_id and used_at is null and revoked_at is null;

  update public.admin_mfa_recovery_sessions
  set revoked_at = now()
  where user_id = p_user_id and completed_at is null and revoked_at is null;

  update public.admin_trusted_devices
  set revoked_at = now()
  where user_id = p_user_id and revoked_at is null;
  get diagnostics l_revoked_devices = row_count;

  insert into public.admin_mfa_recovery_codes (user_id, set_id, code_hash)
  select p_user_id, l_set_id, value
  from unnest(p_code_hashes) with ordinality as hashes(value, position)
  order by position;
  get diagnostics l_inserted = row_count;

  perform public.audit_user_security_event(
    p_user_id, p_event_action, jsonb_build_object('count', l_inserted, 'setId', l_set_id)
  );
  if l_revoked_devices > 0 then
    perform public.audit_user_security_event(
      p_user_id, 'trusted_devices_revoked', jsonb_build_object('reason', p_event_action, 'count', l_revoked_devices)
    );
  end if;
  return l_inserted;
end
$$;

create or replace function public.consume_admin_mfa_recovery_code(p_user_id uuid, p_code_hash text, p_session_token_hash text, p_expires_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  l_code_id uuid;
  l_factor_ids uuid[];
  l_revoked_devices integer;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$'
     or p_session_token_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at <= now()
     or p_expires_at > now() + interval '20 minutes' then
    return false;
  end if;
  if not public.is_staff_user(p_user_id) then
    return false;
  end if;

  select array_agg(id order by created_at)
  into l_factor_ids
  from auth.mfa_factors
  where user_id = p_user_id and status = 'verified' and factor_type = 'totp';
  if coalesce(cardinality(l_factor_ids), 0) = 0 then
    return false;
  end if;

  -- One guarded UPDATE is the atomic single-use boundary. Concurrent callers
  -- cannot both satisfy used_at/revoked_at IS NULL for the same row.
  update public.admin_mfa_recovery_codes
  set used_at = now()
  where user_id = p_user_id
    and code_hash = p_code_hash
    and used_at is null
    and revoked_at is null
  returning id into l_code_id;
  if l_code_id is null then
    return false;
  end if;

  update public.admin_mfa_recovery_sessions
  set revoked_at = now()
  where user_id = p_user_id and completed_at is null and revoked_at is null;

  update public.admin_trusted_devices
  set revoked_at = now()
  where user_id = p_user_id and revoked_at is null;
  get diagnostics l_revoked_devices = row_count;

  insert into public.admin_mfa_recovery_sessions (
    user_id, recovery_code_id, token_hash, old_factor_ids, expires_at
  ) values (
    p_user_id, l_code_id, p_session_token_hash, l_factor_ids, p_expires_at
  );

  perform public.audit_user_security_event(
    p_user_id, 'mfa_recovery_code_used', jsonb_build_object('recoveryCodeId', l_code_id)
  );
  perform public.audit_user_security_event(
    p_user_id, 'trusted_devices_revoked', jsonb_build_object('reason', 'mfa_recovery_code_used', 'count', l_revoked_devices)
  );
  return true;
end
$$;

-- 6d. Invoicing: actor check and triggers ------------------------------------

create or replace function public.require_invoice_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.garage_actor_allowed(), false) then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  return auth.uid();
end
$$;

create or replace function public.prepare_invoice_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_id uuid;
  parent_garage_id uuid;
  parent_status public.invoice_status;
begin
  if tg_op = 'UPDATE'
     and (new.invoice_id is distinct from old.invoice_id or new.garage_id is distinct from old.garage_id) then
    raise exception 'INVOICE_ITEM_PARENT_IS_IMMUTABLE';
  end if;

  if tg_op = 'INSERT' then
    parent_id := new.invoice_id;
    parent_garage_id := new.garage_id;
  else
    parent_id := old.invoice_id;
    parent_garage_id := old.garage_id;
  end if;

  -- Deleting a garage removes its whole invoice history.
  if tg_op = 'DELETE' and not exists (select 1 from public.garages garage where garage.id = parent_garage_id) then
    return old;
  end if;

  select invoice.status
  into parent_status
  from public.invoices invoice
  where invoice.garage_id = parent_garage_id
    and invoice.id = parent_id
  for update;

  if not found then
    if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'INVOICE_NOT_FOUND';
  end if;

  if parent_status <> 'draft'::public.invoice_status then
    raise exception 'INVOICE_ITEMS_ARE_IMMUTABLE';
  end if;

  if tg_op <> 'DELETE' then
    new.description := trim(new.description);
    if new.quantity <= 0 or new.quantity <> round(new.quantity, 3) then
      raise exception 'INVALID_ITEM_QUANTITY';
    end if;
    new.line_total_pence := public.invoice_line_total(new.quantity, new.unit_price_pence);
    return new;
  end if;

  return old;
end
$$;

create or replace function public.refresh_invoice_totals()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_id uuid;
  target_garage_id uuid;
  calculated_subtotal numeric;
  current_discount bigint;
begin
  if tg_op = 'INSERT' then
    target_id := new.invoice_id;
    target_garage_id := new.garage_id;
  else
    target_id := old.invoice_id;
    target_garage_id := old.garage_id;
  end if;

  select coalesce(sum(item.line_total_pence), 0), invoice.discount_pence
  into calculated_subtotal, current_discount
  from public.invoices invoice
  join public.garages garage on garage.id = invoice.garage_id
  left join public.invoice_items item
    on item.garage_id = invoice.garage_id
   and item.invoice_id = invoice.id
  where invoice.garage_id = target_garage_id
    and invoice.id = target_id
    and invoice.status = 'draft'
  group by invoice.discount_pence;

  if not found then
    return null;
  end if;
  if calculated_subtotal > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  if current_discount > calculated_subtotal then
    raise exception 'INVALID_INVOICE_TOTAL';
  end if;

  update public.invoices invoice
  set subtotal_pence = calculated_subtotal::bigint,
      total_pence = calculated_subtotal::bigint - current_discount
  where invoice.garage_id = target_garage_id
    and invoice.id = target_id
    and invoice.status = 'draft';
  return null;
end
$$;

-- Drafts always carry the garage's current issuer details; issuing freezes the
-- snapshot. Moving an invoice to or from the trash only changes
-- deleted_at/deleted_by; every other change to issued history is rejected.
create or replace function public.protect_invoice_history()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  calculated_subtotal numeric;
  calculated_item_count integer;
  stored_lines_valid boolean;
  issuer record;
begin
  if tg_op = 'DELETE' then
    -- Deleting a garage removes its whole invoice history.
    if old.status <> 'draft'::public.invoice_status
       and exists (select 1 from public.garages garage where garage.id = old.garage_id) then
      raise exception 'ONLY_DRAFT_INVOICES_CAN_BE_DELETED';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft'::public.invoice_status
       or new.invoice_number is not null
       or new.invoice_year is not null
       or new.invoice_sequence is not null
       or new.issued_at is not null
       or new.paid_at is not null
       or new.payment_method is not null
       or new.payment_reference is not null
       or new.voided_at is not null
       or new.revision <> 1
       or new.subtotal_pence <> 0
       or new.discount_pence <> 0
       or new.tax_pence <> 0
       or new.total_pence <> 0 then
      raise exception 'VALID_DRAFT_INSERT_REQUIRED';
    end if;
    select * into issuer from public.garage_invoice_issuer(new.garage_id);
    if not found then
      raise exception 'GARAGE_NOT_FOUND';
    end if;
    new.issuer_legal_name := issuer.legal_name;
    new.issuer_trading_name := issuer.trading_name;
    new.issuer_tagline := issuer.tagline;
    new.issuer_address := issuer.address;
    new.issuer_email := issuer.email;
    new.issuer_phone := issuer.phone;
    new.issuer_company_number := issuer.company_number;
    new.customer_name := trim(new.customer_name);
    new.customer_email := nullif(lower(trim(new.customer_email)), '');
    new.customer_phone := nullif(trim(new.customer_phone), '');
    new.customer_address := nullif(trim(new.customer_address), '');
    new.vehicle_registration := nullif(upper(regexp_replace(coalesce(new.vehicle_registration, ''), '[^A-Za-z0-9]', '', 'g')), '');
    new.vehicle_make := nullif(trim(new.vehicle_make), '');
    new.vehicle_model := nullif(trim(new.vehicle_model), '');
    new.service_name := nullif(trim(new.service_name), '');
    new.notes := nullif(trim(new.notes), '');
    new.payment_terms := nullif(trim(new.payment_terms), '');
    return new;
  end if;

  if (
    new.deleted_at is distinct from old.deleted_at
    or new.deleted_by is distinct from old.deleted_by
  ) and (
    to_jsonb(new) - array['deleted_at', 'deleted_by']
  ) is not distinct from (
    to_jsonb(old) - array['deleted_at', 'deleted_by']
  ) then
    if (new.deleted_at is null) is distinct from (new.deleted_by is null) then
      raise exception 'INVALID_INVOICE_TRASH_STATE';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.garage_id is distinct from old.garage_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.replaces_invoice_id is distinct from old.replaces_invoice_id then
    raise exception 'INVOICE_IDENTITY_IS_IMMUTABLE';
  end if;
  if old.status <> 'draft'::public.invoice_status and (
    new.issuer_legal_name is distinct from old.issuer_legal_name
    or new.issuer_trading_name is distinct from old.issuer_trading_name
    or new.issuer_tagline is distinct from old.issuer_tagline
    or new.issuer_address is distinct from old.issuer_address
    or new.issuer_email is distinct from old.issuer_email
    or new.issuer_phone is distinct from old.issuer_phone
    or new.issuer_company_number is distinct from old.issuer_company_number
  ) then
    raise exception 'INVOICE_IDENTITY_IS_IMMUTABLE';
  end if;
  if new.revision is distinct from old.revision then
    raise exception 'INVOICE_REVISION_IS_DATABASE_MANAGED';
  end if;

  if old.status = 'draft'::public.invoice_status then
    select * into issuer from public.garage_invoice_issuer(new.garage_id);
    if found then
      new.issuer_legal_name := issuer.legal_name;
      new.issuer_trading_name := issuer.trading_name;
      new.issuer_tagline := issuer.tagline;
      new.issuer_address := issuer.address;
      new.issuer_email := issuer.email;
      new.issuer_phone := issuer.phone;
      new.issuer_company_number := issuer.company_number;
    end if;
  end if;

  if old.status <> new.status
     and not (
       (old.status = 'draft'::public.invoice_status and new.status = 'issued'::public.invoice_status)
       or (old.status = 'issued'::public.invoice_status and new.status in ('paid'::public.invoice_status, 'void'::public.invoice_status))
     ) then
    raise exception 'INVALID_INVOICE_STATUS_TRANSITION';
  end if;

  if old.status <> 'draft'::public.invoice_status then
    if old.status = new.status then
      raise exception 'ISSUED_INVOICE_IS_IMMUTABLE';
    end if;

    if (
      to_jsonb(old) - array['status', 'revision', 'updated_by', 'updated_at', 'paid_at', 'payment_method', 'payment_reference', 'voided_at']
    ) is distinct from (
      to_jsonb(new) - array['status', 'revision', 'updated_by', 'updated_at', 'paid_at', 'payment_method', 'payment_reference', 'voided_at']
    ) then
      raise exception 'ISSUED_INVOICE_IS_IMMUTABLE';
    end if;

    if new.status = 'paid'::public.invoice_status then
      if new.paid_at is null
         or new.payment_method is null
         or new.payment_method not in ('cash', 'card', 'bank_transfer', 'other')
         or new.voided_at is distinct from old.voided_at then
        raise exception 'INVALID_PAID_TRANSITION';
      end if;
    elsif new.status = 'void'::public.invoice_status then
      if new.voided_at is null
         or new.paid_at is distinct from old.paid_at
         or new.payment_method is distinct from old.payment_method
         or new.payment_reference is distinct from old.payment_reference then
        raise exception 'INVALID_VOID_TRANSITION';
      end if;
    end if;
  elsif new.status = 'issued'::public.invoice_status then
    if (
      to_jsonb(old) - array['status', 'revision', 'updated_by', 'updated_at', 'invoice_number', 'invoice_year', 'invoice_sequence', 'issue_date', 'due_date', 'subtotal_pence', 'tax_pence', 'total_pence', 'issued_at',
                            'issuer_legal_name', 'issuer_trading_name', 'issuer_tagline', 'issuer_address', 'issuer_email', 'issuer_phone', 'issuer_company_number']
    ) is distinct from (
      to_jsonb(new) - array['status', 'revision', 'updated_by', 'updated_at', 'invoice_number', 'invoice_year', 'invoice_sequence', 'issue_date', 'due_date', 'subtotal_pence', 'tax_pence', 'total_pence', 'issued_at',
                            'issuer_legal_name', 'issuer_trading_name', 'issuer_tagline', 'issuer_address', 'issuer_email', 'issuer_phone', 'issuer_company_number']
    ) then
      raise exception 'ISSUE_MAY_NOT_REWRITE_INVOICE_HISTORY';
    end if;

    select
      count(*)::integer,
      coalesce(sum(public.invoice_line_total(item.quantity, item.unit_price_pence)), 0),
      coalesce(bool_and(item.line_total_pence = public.invoice_line_total(item.quantity, item.unit_price_pence)), false)
    into calculated_item_count, calculated_subtotal, stored_lines_valid
    from public.invoice_items item
    where item.garage_id = old.garage_id
      and item.invoice_id = old.id;

    if calculated_item_count = 0
       or not stored_lines_valid
       or calculated_subtotal > 9007199254740991
       or new.subtotal_pence is distinct from calculated_subtotal::bigint
       or new.discount_pence < 0
       or new.discount_pence > calculated_subtotal
       or new.tax_pence <> 0
       or new.total_pence is distinct from calculated_subtotal::bigint - new.discount_pence then
      raise exception 'INVALID_INVOICE_TOTAL';
    end if;
  else
    new.customer_name := trim(new.customer_name);
    new.customer_email := nullif(lower(trim(new.customer_email)), '');
    new.customer_phone := nullif(trim(new.customer_phone), '');
    new.customer_address := nullif(trim(new.customer_address), '');
    new.vehicle_registration := nullif(upper(regexp_replace(coalesce(new.vehicle_registration, ''), '[^A-Za-z0-9]', '', 'g')), '');
    new.vehicle_make := nullif(trim(new.vehicle_make), '');
    new.vehicle_model := nullif(trim(new.vehicle_model), '');
    new.service_name := nullif(trim(new.service_name), '');
    new.notes := nullif(trim(new.notes), '');
    new.payment_terms := nullif(trim(new.payment_terms), '');
    if new.tax_pence <> 0 then
      raise exception 'VAT_NOT_CONFIGURED';
    end if;
    if new.discount_pence > new.subtotal_pence then
      raise exception 'INVALID_INVOICE_TOTAL';
    end if;
    new.total_pence := new.subtotal_pence - new.discount_pence;
  end if;

  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end
$$;

-- 6e. Invoicing: staff RPCs ---------------------------------------------------

create or replace function public.save_invoice_draft(p_invoice_id uuid, p_payload jsonb, p_confirm_duplicate_source boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  target_id uuid;
  existing_invoice public.invoices%rowtype;
  source_kind text := p_payload->>'source_type';
  selected_booking_id uuid;
  selected_enquiry_id uuid;
  selected_customer_id uuid;
  selected_vehicle_id uuid;
  snapshot_customer_name text;
  snapshot_customer_email text;
  snapshot_customer_phone text;
  snapshot_customer_address text := nullif(trim(p_payload->>'customer_address'), '');
  snapshot_registration text;
  snapshot_make text;
  snapshot_model text;
  snapshot_service text;
  snapshot_appointment timestamptz;
  requested_discount_numeric numeric;
  requested_discount bigint;
  requested_tax_numeric numeric;
  requested_issue_date date := nullif(p_payload->>'issue_date', '')::date;
  requested_due_date date := nullif(p_payload->>'due_date', '')::date;
  item jsonb;
  item_count integer := 0;
  item_quantity numeric;
  item_unit_numeric numeric;
  item_unit_price bigint;
  calculated_subtotal numeric;
  source_changed boolean := false;
  duplicate_exists boolean;
  payload_customer_id uuid := nullif(trim(coalesce(p_payload->>'customer_id', '')), '')::uuid;
  payload_vehicle_id uuid := nullif(trim(coalesce(p_payload->>'vehicle_id', '')), '')::uuid;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID_INVOICE_PAYLOAD';
  end if;
  if source_kind not in ('booking', 'enquiry', 'manual') then
    raise exception 'INVALID_SOURCE';
  end if;
  if jsonb_typeof(p_payload->'items') <> 'array'
     or jsonb_array_length(p_payload->'items') = 0
     or jsonb_array_length(p_payload->'items') > 100 then
    raise exception 'INVOICE_ITEM_COUNT_INVALID';
  end if;

  requested_discount_numeric := coalesce(nullif(p_payload->>'discount_pence', ''), '0')::numeric;
  requested_tax_numeric := coalesce(nullif(p_payload->>'tax_pence', ''), '0')::numeric;
  if requested_discount_numeric <> trunc(requested_discount_numeric)
     or requested_discount_numeric < 0
     or requested_discount_numeric > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  if requested_tax_numeric <> 0 then
    raise exception 'VAT_NOT_CONFIGURED';
  end if;
  requested_discount := requested_discount_numeric::bigint;

  if p_invoice_id is not null then
    select invoice.*
    into existing_invoice
    from public.invoices invoice
    where invoice.garage_id = garage_scope
      and invoice.id = p_invoice_id
      and invoice.status = 'draft'
    for update;
    if not found then
      raise exception 'DRAFT_INVOICE_NOT_FOUND';
    end if;
    target_id := existing_invoice.id;
  end if;

  if source_kind = 'booking' then
    selected_booking_id := nullif(trim(coalesce(p_payload->>'booking_id', '')), '')::uuid;
    if selected_booking_id is null
       or nullif(trim(coalesce(p_payload->>'enquiry_id', '')), '') is not null then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;

    select
      booking.customer_id,
      booking.vehicle_id,
      customer.name,
      customer.email,
      customer.phone,
      vehicle.registration,
      vehicle.make,
      vehicle.model,
      booking.service_name,
      booking.appointment_start
    into
      selected_customer_id,
      selected_vehicle_id,
      snapshot_customer_name,
      snapshot_customer_email,
      snapshot_customer_phone,
      snapshot_registration,
      snapshot_make,
      snapshot_model,
      snapshot_service,
      snapshot_appointment
    from public.bookings booking
    join public.customers customer
      on customer.garage_id = booking.garage_id
     and customer.id = booking.customer_id
    join public.vehicles vehicle
      on vehicle.garage_id = booking.garage_id
     and vehicle.id = booking.vehicle_id
     and vehicle.customer_id = booking.customer_id
    where booking.garage_id = garage_scope
      and booking.id = selected_booking_id;

    if not found
       or (payload_customer_id is not null and payload_customer_id <> selected_customer_id)
       or (payload_vehicle_id is not null and payload_vehicle_id <> selected_vehicle_id) then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;
  elsif source_kind = 'enquiry' then
    selected_enquiry_id := nullif(trim(coalesce(p_payload->>'enquiry_id', '')), '')::uuid;
    if selected_enquiry_id is null
       or nullif(trim(coalesce(p_payload->>'booking_id', '')), '') is not null then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;

    select
      enquiry.customer_id,
      enquiry.vehicle_id,
      customer.name,
      customer.email,
      customer.phone,
      vehicle.registration,
      vehicle.make,
      vehicle.model,
      replace(coalesce(nullif(trim(enquiry.service_slug), ''), enquiry.type::text), '-', ' '),
      null::timestamptz
    into
      selected_customer_id,
      selected_vehicle_id,
      snapshot_customer_name,
      snapshot_customer_email,
      snapshot_customer_phone,
      snapshot_registration,
      snapshot_make,
      snapshot_model,
      snapshot_service,
      snapshot_appointment
    from public.enquiries enquiry
    join public.customers customer
      on customer.garage_id = enquiry.garage_id
     and customer.id = enquiry.customer_id
    left join public.vehicles vehicle
      on vehicle.garage_id = enquiry.garage_id
     and vehicle.id = enquiry.vehicle_id
     and vehicle.customer_id = enquiry.customer_id
    where enquiry.garage_id = garage_scope
      and enquiry.id = selected_enquiry_id
      and (enquiry.vehicle_id is null or vehicle.id is not null);

    if not found
       or (payload_customer_id is not null and payload_customer_id <> selected_customer_id)
       or (payload_vehicle_id is not null and payload_vehicle_id is distinct from selected_vehicle_id) then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;
  else
    if nullif(trim(coalesce(p_payload->>'booking_id', '')), '') is not null
       or nullif(trim(coalesce(p_payload->>'enquiry_id', '')), '') is not null then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;

    selected_customer_id := payload_customer_id;
    selected_vehicle_id := payload_vehicle_id;
    snapshot_customer_name := trim(p_payload->>'customer_name');
    snapshot_customer_email := nullif(lower(trim(p_payload->>'customer_email')), '');
    snapshot_customer_phone := nullif(trim(p_payload->>'customer_phone'), '');
    snapshot_registration := nullif(p_payload->>'vehicle_registration', '');
    snapshot_make := nullif(trim(p_payload->>'vehicle_make'), '');
    snapshot_model := nullif(trim(p_payload->>'vehicle_model'), '');
    snapshot_service := nullif(trim(p_payload->>'service_name'), '');
    snapshot_appointment := nullif(p_payload->>'appointment_start', '')::timestamptz;

    if selected_vehicle_id is not null then
      select vehicle.customer_id, vehicle.registration, vehicle.make, vehicle.model
      into selected_customer_id, snapshot_registration, snapshot_make, snapshot_model
      from public.vehicles vehicle
      where vehicle.garage_id = garage_scope
        and vehicle.id = selected_vehicle_id
        and vehicle.customer_id is not null
        and (payload_customer_id is null or vehicle.customer_id = payload_customer_id);
      if not found then
        raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
      end if;
    end if;

    if selected_customer_id is not null then
      select customer.name, customer.email, customer.phone
      into snapshot_customer_name, snapshot_customer_email, snapshot_customer_phone
      from public.customers customer
      where customer.garage_id = garage_scope
        and customer.id = selected_customer_id;
      if not found then
        raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
      end if;
    end if;
  end if;

  if length(trim(coalesce(snapshot_customer_name, ''))) < 2 then
    raise exception 'CUSTOMER_NAME_REQUIRED';
  end if;

  if p_invoice_id is null then
    source_changed := true;
  else
    source_changed := existing_invoice.source_type is distinct from source_kind
      or existing_invoice.booking_id is distinct from selected_booking_id
      or existing_invoice.enquiry_id is distinct from selected_enquiry_id;
  end if;

  if source_changed and source_kind in ('booking', 'enquiry') then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'public.invoices.source:' || source_kind || ':' || coalesce(selected_booking_id, selected_enquiry_id)::text,
        0
      )
    );
    select exists (
      select 1
      from public.invoices invoice
      where invoice.garage_id = garage_scope
        and invoice.id is distinct from p_invoice_id
        and (
          (source_kind = 'booking' and invoice.booking_id = selected_booking_id)
          or (source_kind = 'enquiry' and invoice.enquiry_id = selected_enquiry_id)
        )
    ) into duplicate_exists;
    if duplicate_exists and coalesce(p_confirm_duplicate_source, false) is not true then
      raise exception 'DUPLICATE_SOURCE_CONFIRMATION_REQUIRED';
    end if;
  end if;

  if p_invoice_id is null then
    insert into public.invoices (
      garage_id,
      source_type,
      booking_id,
      enquiry_id,
      customer_id,
      vehicle_id,
      customer_name,
      customer_email,
      customer_phone,
      customer_address,
      vehicle_registration,
      vehicle_make,
      vehicle_model,
      service_name,
      appointment_start,
      issue_date,
      due_date,
      notes,
      payment_terms,
      created_by,
      updated_by
    ) values (
      garage_scope,
      source_kind,
      selected_booking_id,
      selected_enquiry_id,
      selected_customer_id,
      selected_vehicle_id,
      snapshot_customer_name,
      snapshot_customer_email,
      snapshot_customer_phone,
      snapshot_customer_address,
      snapshot_registration,
      snapshot_make,
      snapshot_model,
      snapshot_service,
      snapshot_appointment,
      requested_issue_date,
      requested_due_date,
      nullif(trim(p_payload->>'notes'), ''),
      nullif(trim(p_payload->>'payment_terms'), ''),
      actor_id,
      actor_id
    ) returning id into target_id;
  else
    update public.invoices invoice
    set source_type = source_kind,
        booking_id = selected_booking_id,
        enquiry_id = selected_enquiry_id,
        customer_id = selected_customer_id,
        vehicle_id = selected_vehicle_id,
        customer_name = snapshot_customer_name,
        customer_email = snapshot_customer_email,
        customer_phone = snapshot_customer_phone,
        customer_address = snapshot_customer_address,
        vehicle_registration = snapshot_registration,
        vehicle_make = snapshot_make,
        vehicle_model = snapshot_model,
        service_name = snapshot_service,
        appointment_start = snapshot_appointment,
        issue_date = requested_issue_date,
        due_date = requested_due_date,
        discount_pence = 0,
        tax_pence = 0,
        notes = nullif(trim(p_payload->>'notes'), ''),
        payment_terms = nullif(trim(p_payload->>'payment_terms'), ''),
        updated_by = actor_id
    where invoice.garage_id = garage_scope
      and invoice.id = target_id;

    delete from public.invoice_items item
    where item.garage_id = garage_scope
      and item.invoice_id = target_id;
  end if;

  for item in select value from jsonb_array_elements(p_payload->'items') loop
    item_count := item_count + 1;
    if length(trim(coalesce(item->>'description', ''))) = 0 then
      raise exception 'ITEM_DESCRIPTION_REQUIRED';
    end if;
    item_quantity := (item->>'quantity')::numeric;
    item_unit_numeric := (item->>'unit_price_pence')::numeric;
    if item_quantity <= 0
       or item_quantity > 999999999.999
       or item_quantity <> round(item_quantity, 3) then
      raise exception 'INVALID_ITEM_QUANTITY';
    end if;
    if item_unit_numeric <> trunc(item_unit_numeric)
       or item_unit_numeric < 0
       or item_unit_numeric > 9007199254740991 then
      raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
    end if;
    item_unit_price := item_unit_numeric::bigint;
    perform public.invoice_line_total(item_quantity, item_unit_price);

    insert into public.invoice_items (
      garage_id,
      invoice_id,
      description,
      quantity,
      unit_price_pence,
      line_total_pence,
      position
    ) values (
      garage_scope,
      target_id,
      trim(item->>'description'),
      item_quantity,
      item_unit_price,
      0,
      item_count - 1
    );
  end loop;

  select coalesce(sum(invoice_item.line_total_pence), 0)
  into calculated_subtotal
  from public.invoice_items invoice_item
  where invoice_item.garage_id = garage_scope
    and invoice_item.invoice_id = target_id;

  if calculated_subtotal > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  if requested_discount > calculated_subtotal then
    raise exception 'INVALID_INVOICE_TOTAL';
  end if;

  update public.invoices invoice
  set subtotal_pence = calculated_subtotal::bigint,
      discount_pence = requested_discount,
      tax_pence = 0,
      total_pence = calculated_subtotal::bigint - requested_discount,
      updated_by = actor_id
  where invoice.garage_id = garage_scope
    and invoice.id = target_id;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    garage_scope,
    actor_id,
    case when p_invoice_id is null then 'invoice.created' else 'invoice.updated' end,
    'invoice',
    target_id::text,
    jsonb_build_object(
      'sourceType', source_kind,
      'itemCount', item_count,
      'duplicateSourceConfirmed',
        coalesce(duplicate_exists, false) and coalesce(p_confirm_duplicate_source, false)
    )
  );
  return target_id;
end
$$;

create or replace function public.issue_invoice(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  invoice_prefix text;
  garage_timezone text;
  current_invoice public.invoices%rowtype;
  allocated_sequence bigint;
  allocated_year integer;
  effective_issue_date date;
  calculated_subtotal numeric;
  calculated_item_count integer;
begin
  select invoice.*
  into current_invoice
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
  for update;
  if not found or current_invoice.status <> 'draft'::public.invoice_status then
    raise exception 'DRAFT_INVOICE_NOT_FOUND';
  end if;

  if current_invoice.source_type = 'booking' and not exists (
    select 1
    from public.bookings booking
    join public.vehicles vehicle
      on vehicle.garage_id = booking.garage_id
     and vehicle.id = booking.vehicle_id
     and vehicle.customer_id = booking.customer_id
    where booking.garage_id = garage_scope
      and booking.id = current_invoice.booking_id
      and booking.customer_id = current_invoice.customer_id
      and booking.vehicle_id = current_invoice.vehicle_id
  ) then
    raise exception 'SOURCE_RELATIONSHIP_CHANGED';
  elsif current_invoice.source_type = 'enquiry' and not exists (
    select 1
    from public.enquiries enquiry
    left join public.vehicles vehicle
      on vehicle.garage_id = enquiry.garage_id
     and vehicle.id = enquiry.vehicle_id
     and vehicle.customer_id = enquiry.customer_id
    where enquiry.garage_id = garage_scope
      and enquiry.id = current_invoice.enquiry_id
      and enquiry.customer_id = current_invoice.customer_id
      and enquiry.vehicle_id is not distinct from current_invoice.vehicle_id
      and (enquiry.vehicle_id is null or vehicle.id is not null)
  ) then
    raise exception 'SOURCE_RELATIONSHIP_CHANGED';
  elsif current_invoice.source_type = 'manual'
        and current_invoice.vehicle_id is not null
        and not exists (
          select 1
          from public.vehicles vehicle
          where vehicle.garage_id = garage_scope
            and vehicle.id = current_invoice.vehicle_id
            and vehicle.customer_id = current_invoice.customer_id
        ) then
    raise exception 'SOURCE_RELATIONSHIP_CHANGED';
  end if;

  perform 1
  from public.invoice_items item
  where item.garage_id = garage_scope
    and item.invoice_id = p_invoice_id
  order by item.id
  for update;

  update public.invoice_items item
  set line_total_pence = public.invoice_line_total(item.quantity, item.unit_price_pence)
  where item.garage_id = garage_scope
    and item.invoice_id = p_invoice_id;

  select count(*)::integer, coalesce(sum(item.line_total_pence), 0)
  into calculated_item_count, calculated_subtotal
  from public.invoice_items item
  where item.garage_id = garage_scope
    and item.invoice_id = p_invoice_id;

  if calculated_item_count = 0 then
    raise exception 'INVOICE_ITEM_REQUIRED';
  end if;
  if calculated_subtotal > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;

  select invoice.*
  into current_invoice
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id;

  if current_invoice.tax_pence <> 0 then
    raise exception 'VAT_NOT_CONFIGURED';
  end if;
  if current_invoice.discount_pence < 0 or current_invoice.discount_pence > calculated_subtotal then
    raise exception 'INVALID_INVOICE_TOTAL';
  end if;

  select garage.booking_prefix, garage.timezone
  into invoice_prefix, garage_timezone
  from public.garages garage
  where garage.id = garage_scope;

  effective_issue_date := coalesce(
    current_invoice.issue_date,
    (clock_timestamp() at time zone garage_timezone)::date
  );
  allocated_year := extract(year from effective_issue_date)::integer;
  if allocated_year not between 2020 and 9999 then
    raise exception 'INVALID_INVOICE_YEAR';
  end if;

  insert into public.invoice_number_sequences (garage_id, invoice_year, last_value)
  values (garage_scope, allocated_year, 1)
  on conflict (garage_id, invoice_year) do update
    set last_value = public.invoice_number_sequences.last_value + 1
    where public.invoice_number_sequences.last_value < 999999
  returning last_value into allocated_sequence;

  if allocated_sequence is null then
    raise exception 'INVOICE_YEAR_SEQUENCE_EXHAUSTED';
  end if;

  update public.invoices invoice
  set invoice_year = allocated_year,
      invoice_sequence = allocated_sequence,
      invoice_number = invoice_prefix || '-' || allocated_year::text || '-' || lpad(allocated_sequence::text, 6, '0'),
      status = 'issued',
      issue_date = effective_issue_date,
      due_date = coalesce(invoice.due_date, effective_issue_date + 7),
      subtotal_pence = calculated_subtotal::bigint,
      tax_pence = 0,
      total_pence = calculated_subtotal::bigint - current_invoice.discount_pence,
      issued_at = now(),
      updated_by = actor_id
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
  returning * into current_invoice;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    garage_scope,
    actor_id,
    'invoice.issued',
    'invoice',
    p_invoice_id::text,
    jsonb_build_object(
      'invoiceNumber', current_invoice.invoice_number,
      'revision', current_invoice.revision
    )
  );
  return current_invoice;
end
$$;

create or replace function public.record_invoice_payment(p_invoice_id uuid, p_amount_pence bigint, p_paid_at timestamptz, p_method text, p_reference text)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  current_invoice public.invoices%rowtype;
  normalized_method text;
  already_paid bigint;
  outstanding bigint;
begin
  if p_paid_at is null then
    raise exception 'PAYMENT_DATE_REQUIRED';
  end if;
  normalized_method := lower(trim(p_method));
  if p_method is null or normalized_method not in ('cash', 'card', 'bank_transfer', 'other') then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;
  if p_amount_pence is null or p_amount_pence <= 0 then
    raise exception 'INVALID_PAYMENT_AMOUNT';
  end if;

  select invoice.*
  into current_invoice
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
    and invoice.status = 'issued'
  for update;
  if not found then
    raise exception 'ISSUED_INVOICE_NOT_FOUND';
  end if;
  if exists (
    select 1
    from public.invoice_email_sends email_send
    where email_send.garage_id = garage_scope
      and email_send.invoice_id = p_invoice_id
      and email_send.status = 'pending'
  ) then
    raise exception 'INVOICE_EMAIL_SEND_IN_PROGRESS';
  end if;

  select coalesce(sum(payment.amount_pence), 0)
  into already_paid
  from public.invoice_payments payment
  where payment.garage_id = garage_scope
    and payment.invoice_id = p_invoice_id;
  outstanding := current_invoice.total_pence - already_paid;
  if p_amount_pence > outstanding then
    raise exception 'PAYMENT_EXCEEDS_BALANCE';
  end if;

  insert into public.invoice_payments (
    garage_id,
    invoice_id,
    amount_pence,
    paid_at,
    payment_method,
    payment_reference,
    created_by
  ) values (
    garage_scope,
    p_invoice_id,
    p_amount_pence,
    p_paid_at,
    normalized_method,
    nullif(trim(p_reference), ''),
    actor_id
  );

  if p_amount_pence = outstanding then
    update public.invoices invoice
    set status = 'paid',
        paid_at = p_paid_at,
        payment_method = normalized_method,
        payment_reference = nullif(trim(p_reference), ''),
        updated_by = actor_id
    where invoice.garage_id = garage_scope
      and invoice.id = p_invoice_id
      and invoice.status = 'issued'
    returning * into current_invoice;
  end if;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    garage_scope,
    actor_id,
    case when p_amount_pence = outstanding then 'invoice.marked_paid' else 'invoice.part_payment_recorded' end,
    'invoice',
    p_invoice_id::text,
    jsonb_build_object(
      'amountPence', p_amount_pence,
      'amountPaidPence', already_paid + p_amount_pence,
      'balancePence', outstanding - p_amount_pence,
      'method', normalized_method,
      'paidAt', p_paid_at,
      'revision', current_invoice.revision
    )
  );
  return current_invoice;
end
$$;

create or replace function public.mark_invoice_paid(p_invoice_id uuid, p_paid_at timestamptz, p_method text, p_reference text)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid;
  current_invoice public.invoices%rowtype;
  already_paid bigint;
begin
  perform public.require_invoice_actor();
  garage_scope := public.current_garage_id();
  select invoice.*
  into current_invoice
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
    and invoice.status = 'issued';
  if not found then
    raise exception 'ISSUED_INVOICE_NOT_FOUND';
  end if;
  select coalesce(sum(payment.amount_pence), 0)
  into already_paid
  from public.invoice_payments payment
  where payment.garage_id = garage_scope
    and payment.invoice_id = p_invoice_id;
  return public.record_invoice_payment(
    p_invoice_id,
    current_invoice.total_pence - already_paid,
    p_paid_at,
    p_method,
    p_reference
  );
end
$$;

create or replace function public.void_invoice(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  result public.invoices%rowtype;
begin
  select invoice.*
  into result
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
    and invoice.status = 'issued'
  for update;
  if not found then
    raise exception 'ISSUED_INVOICE_NOT_FOUND';
  end if;
  if exists (
    select 1
    from public.invoice_email_sends email_send
    where email_send.garage_id = garage_scope
      and email_send.invoice_id = p_invoice_id
      and email_send.status = 'pending'
  ) then
    raise exception 'INVOICE_EMAIL_SEND_IN_PROGRESS';
  end if;

  update public.invoices invoice
  set status = 'void',
      voided_at = now(),
      updated_by = actor_id
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
    and invoice.status = 'issued'
  returning * into result;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    garage_scope,
    actor_id,
    'invoice.voided',
    'invoice',
    p_invoice_id::text,
    jsonb_build_object('revision', result.revision)
  );
  return result;
end
$$;

create or replace function public.delete_invoice_draft(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  deleted_id uuid;
begin
  delete from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
    and invoice.status = 'draft'
  returning invoice.id into deleted_id;

  if deleted_id is null then
    raise exception 'DRAFT_INVOICE_NOT_FOUND';
  end if;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (garage_scope, actor_id, 'invoice.deleted_draft', 'invoice', p_invoice_id::text, '{}'::jsonb);
  return deleted_id;
end
$$;

create or replace function public.duplicate_invoice_to_draft(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  source_invoice public.invoices%rowtype;
  target_id uuid;
  calculated_subtotal numeric;
  business_date date;
begin
  select (clock_timestamp() at time zone garage.timezone)::date
  into business_date
  from public.garages garage
  where garage.id = garage_scope;

  select invoice.*
  into source_invoice
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
  for share;

  if not found then
    raise exception 'INVOICE_NOT_FOUND';
  end if;
  if source_invoice.status not in ('paid'::public.invoice_status, 'void'::public.invoice_status) then
    raise exception 'INVOICE_MUST_BE_PAID_OR_VOID_TO_DUPLICATE';
  end if;

  insert into public.invoices (
    garage_id,
    replaces_invoice_id,
    source_type,
    customer_id,
    vehicle_id,
    customer_name,
    customer_email,
    customer_phone,
    customer_address,
    vehicle_registration,
    vehicle_make,
    vehicle_model,
    service_name,
    appointment_start,
    issue_date,
    due_date,
    notes,
    payment_terms,
    created_by,
    updated_by
  ) values (
    garage_scope,
    source_invoice.id,
    'manual',
    source_invoice.customer_id,
    source_invoice.vehicle_id,
    source_invoice.customer_name,
    source_invoice.customer_email,
    source_invoice.customer_phone,
    source_invoice.customer_address,
    source_invoice.vehicle_registration,
    source_invoice.vehicle_make,
    source_invoice.vehicle_model,
    source_invoice.service_name,
    source_invoice.appointment_start,
    business_date,
    business_date + 7,
    source_invoice.notes,
    source_invoice.payment_terms,
    actor_id,
    actor_id
  ) returning id into target_id;

  insert into public.invoice_items (
    garage_id,
    invoice_id,
    description,
    quantity,
    unit_price_pence,
    line_total_pence,
    position
  )
  select
    garage_scope,
    target_id,
    item.description,
    item.quantity,
    item.unit_price_pence,
    0,
    item.position
  from public.invoice_items item
  where item.garage_id = garage_scope
    and item.invoice_id = source_invoice.id
  order by item.position;

  select coalesce(sum(item.line_total_pence), 0)
  into calculated_subtotal
  from public.invoice_items item
  where item.garage_id = garage_scope
    and item.invoice_id = target_id;

  if calculated_subtotal > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  if source_invoice.discount_pence > calculated_subtotal then
    raise exception 'INVALID_INVOICE_TOTAL';
  end if;

  update public.invoices invoice
  set subtotal_pence = calculated_subtotal::bigint,
      discount_pence = source_invoice.discount_pence,
      tax_pence = 0,
      total_pence = calculated_subtotal::bigint - source_invoice.discount_pence,
      updated_by = actor_id
  where invoice.garage_id = garage_scope
    and invoice.id = target_id;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    garage_scope,
    actor_id,
    'invoice.created',
    'invoice',
    target_id::text,
    jsonb_build_object('replacesInvoiceId', source_invoice.id, 'sourceInvoiceNumber', source_invoice.invoice_number)
  );
  return target_id;
end
$$;

create or replace function public.create_invoice_correction(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  draft_id uuid;
begin
  perform 1
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
    and invoice.status = 'issued'
  for update;
  if not found then
    raise exception 'ISSUED_INVOICE_NOT_FOUND';
  end if;

  perform public.void_invoice(p_invoice_id);
  draft_id := public.duplicate_invoice_to_draft(p_invoice_id);

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (garage_scope, actor_id, 'invoice.correction_created', 'invoice', p_invoice_id::text, jsonb_build_object('draftId', draft_id));
  return draft_id;
end
$$;

create or replace function public.claim_invoice_email_send(p_invoice_id uuid, p_recipient text, p_logical_send_id uuid, p_invoice_revision bigint, p_payload_sha256 text)
returns table (logical_send_id uuid, attempt_id bigint, provider_idempotency_key text, claim_token uuid, disposition text, should_send boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  invoice_record public.invoices%rowtype;
  send_record public.invoice_email_sends%rowtype;
  attempt_record public.invoice_email_attempts%rowtype;
  normalized_recipient text := lower(trim(p_recipient));
  normalized_hash text := lower(trim(p_payload_sha256));
  generated_key text;
  generated_claim uuid;
  next_attempt integer;
  result_disposition text;
begin
  if p_logical_send_id is null then
    raise exception 'LOGICAL_SEND_ID_REQUIRED';
  end if;
  if p_invoice_revision is null or p_invoice_revision <= 0 then
    raise exception 'INVOICE_REVISION_REQUIRED';
  end if;
  if normalized_recipient is null
     or length(normalized_recipient) > 320
     or normalized_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'INVALID_EMAIL_RECIPIENT';
  end if;
  if normalized_hash is null or normalized_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_EMAIL_PAYLOAD_HASH';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('public.invoice_email_sends:' || p_logical_send_id::text, 0)
  );

  select invoice.*
  into invoice_record
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.id = p_invoice_id
  for share;

  if not found or invoice_record.status not in ('issued'::public.invoice_status, 'paid'::public.invoice_status) then
    raise exception 'ONLY_ISSUED_INVOICES_CAN_BE_EMAILED';
  end if;
  if invoice_record.revision <> p_invoice_revision then
    raise exception 'INVOICE_REVISION_MISMATCH';
  end if;

  select email_send.*
  into send_record
  from public.invoice_email_sends email_send
  where email_send.garage_id = garage_scope
    and email_send.id = p_logical_send_id
  for update;

  if found then
    if send_record.invoice_id <> p_invoice_id
       or send_record.recipient <> normalized_recipient
       or send_record.invoice_revision <> p_invoice_revision
       or send_record.payload_sha256 <> normalized_hash
       or send_record.document_status <> invoice_record.status
       or send_record.document_number <> invoice_record.invoice_number then
      raise exception 'LOGICAL_SEND_REUSE_MISMATCH';
    end if;

    select attempt.*
    into attempt_record
    from public.invoice_email_attempts attempt
    where attempt.garage_id = garage_scope
      and attempt.logical_send_id = send_record.id
    order by attempt.attempt_number desc
    limit 1
    for update;

    if send_record.status = 'sent' then
      return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
        null::uuid, 'already_sent'::text, false;
      return;
    end if;

    if attempt_record.status = 'pending' and attempt_record.lease_expires_at > now() then
      return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
        null::uuid, 'in_progress'::text, false;
      return;
    end if;

    if attempt_record.status = 'pending' then
      update public.invoice_email_attempts attempt
      set status = 'ambiguous',
          error_code = 'claim_expired',
          completed_at = now()
      where attempt.garage_id = garage_scope
        and attempt.id = attempt_record.id;
      update public.invoice_email_sends email_send
      set status = 'ambiguous',
          last_error_code = 'claim_expired',
          updated_at = now()
      where email_send.garage_id = garage_scope
        and email_send.id = send_record.id;
      return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
        null::uuid, 'reconciliation_required'::text, false;
      return;
    end if;

    if send_record.status = 'ambiguous' then
      return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
        null::uuid, 'reconciliation_required'::text, false;
      return;
    end if;

    result_disposition := 'failed_retry';

    select coalesce(max(attempt.attempt_number), 0) + 1
    into next_attempt
    from public.invoice_email_attempts attempt
    where attempt.garage_id = garage_scope
      and attempt.logical_send_id = send_record.id;

    generated_claim := gen_random_uuid();
    insert into public.invoice_email_attempts (
      garage_id,
      logical_send_id,
      invoice_id,
      attempt_number,
      status,
      claim_token,
      lease_expires_at,
      attempted_by
    ) values (
      garage_scope,
      send_record.id,
      p_invoice_id,
      next_attempt,
      'pending',
      generated_claim,
      now() + interval '15 minutes',
      actor_id
    ) returning * into attempt_record;

    update public.invoice_email_sends email_send
    set status = 'pending',
        last_error_code = null,
        updated_at = now()
    where email_send.garage_id = garage_scope
      and email_send.id = send_record.id;

    return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
      generated_claim, result_disposition, true;
    return;
  end if;

  generated_key := 'invoice-' || md5(
    p_invoice_id::text || ':' || p_invoice_revision::text || ':' || normalized_recipient || ':' || normalized_hash || ':' || p_logical_send_id::text
  );
  insert into public.invoice_email_sends (
    garage_id,
    id,
    invoice_id,
    recipient,
    invoice_revision,
    document_status,
    document_number,
    payload_sha256,
    provider_idempotency_key,
    status,
    requested_by
  ) values (
    garage_scope,
    p_logical_send_id,
    p_invoice_id,
    normalized_recipient,
    p_invoice_revision,
    invoice_record.status,
    invoice_record.invoice_number,
    normalized_hash,
    generated_key,
    'pending',
    actor_id
  ) returning * into send_record;

  generated_claim := gen_random_uuid();
  insert into public.invoice_email_attempts (
    garage_id,
    logical_send_id,
    invoice_id,
    attempt_number,
    status,
    claim_token,
    lease_expires_at,
    attempted_by
  ) values (
    garage_scope,
    send_record.id,
    p_invoice_id,
    1,
    'pending',
    generated_claim,
    now() + interval '15 minutes',
    actor_id
  ) returning * into attempt_record;

  return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
    generated_claim, 'should_send'::text, true;
end
$$;

-- 6f. Invoicing: provider outcomes (service role) -----------------------------

drop function public.finalize_invoice_email_send(bigint, uuid, text);

create function public.finalize_invoice_email_send(p_garage_id uuid, p_attempt_id bigint, p_claim_token uuid, p_provider_id text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  logical_id uuid;
  send_record public.invoice_email_sends%rowtype;
  attempt_record public.invoice_email_attempts%rowtype;
  normalized_provider_id text := nullif(trim(p_provider_id), '');
begin
  if auth.role() is distinct from 'service_role' and current_setting('role', true) is distinct from 'service_role' then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  if p_claim_token is null
     or normalized_provider_id is null
     or length(normalized_provider_id) > 255 then
    raise exception 'EMAIL_PROVIDER_CONFIRMATION_REQUIRED';
  end if;

  select attempt.logical_send_id
  into logical_id
  from public.invoice_email_attempts attempt
  where attempt.garage_id = p_garage_id
    and attempt.id = p_attempt_id;
  if logical_id is null then
    raise exception 'EMAIL_ATTEMPT_NOT_FOUND';
  end if;

  select email_send.*
  into send_record
  from public.invoice_email_sends email_send
  where email_send.garage_id = p_garage_id
    and email_send.id = logical_id
  for update;

  select attempt.*
  into attempt_record
  from public.invoice_email_attempts attempt
  where attempt.garage_id = p_garage_id
    and attempt.id = p_attempt_id
  for update;

  if attempt_record.claim_token <> p_claim_token then
    raise exception 'EMAIL_CLAIM_TOKEN_MISMATCH';
  end if;
  if send_record.status = 'sent' then
    if send_record.provider_id is distinct from normalized_provider_id then
      raise exception 'EMAIL_PROVIDER_CONFIRMATION_MISMATCH';
    end if;
    return p_attempt_id;
  end if;
  if attempt_record.status not in ('pending', 'ambiguous') then
    raise exception 'EMAIL_ATTEMPT_NOT_FINALISABLE';
  end if;
  if (attempt_record.provider_id is not null and attempt_record.provider_id <> normalized_provider_id)
     or (send_record.provider_id is not null and send_record.provider_id <> normalized_provider_id) then
    raise exception 'EMAIL_PROVIDER_CONFIRMATION_MISMATCH';
  end if;

  update public.invoice_email_attempts attempt
  set status = 'sent',
      provider_id = normalized_provider_id,
      error_code = null,
      completed_at = now()
  where attempt.garage_id = p_garage_id
    and attempt.id = p_attempt_id;

  update public.invoice_email_attempts attempt
  set status = 'ambiguous',
      error_code = 'superseded_by_sent_attempt',
      completed_at = now()
  where attempt.garage_id = p_garage_id
    and attempt.logical_send_id = logical_id
    and attempt.id <> p_attempt_id
    and attempt.status = 'pending';

  update public.invoice_email_sends email_send
  set status = 'sent',
      provider_id = normalized_provider_id,
      last_error_code = null,
      sent_at = now(),
      updated_at = now()
  where email_send.garage_id = p_garage_id
    and email_send.id = logical_id;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    p_garage_id,
    attempt_record.attempted_by,
    'invoice.sent',
    'invoice',
    send_record.invoice_id::text,
    jsonb_build_object(
      'logicalSendId', logical_id,
      'attemptId', p_attempt_id,
      'invoiceRevision', send_record.invoice_revision
    )
  );
  return p_attempt_id;
end
$$;

drop function public.fail_invoice_email_send(bigint, uuid, text, boolean, text);

create function public.fail_invoice_email_send(p_garage_id uuid, p_attempt_id bigint, p_claim_token uuid, p_error_code text, p_ambiguous boolean, p_provider_id text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  logical_id uuid;
  send_record public.invoice_email_sends%rowtype;
  attempt_record public.invoice_email_attempts%rowtype;
  normalized_error text := lower(trim(p_error_code));
  normalized_provider_id text := nullif(trim(p_provider_id), '');
  target_status text;
begin
  if auth.role() is distinct from 'service_role' and current_setting('role', true) is distinct from 'service_role' then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  if p_claim_token is null or p_ambiguous is null then
    raise exception 'INVALID_EMAIL_FAILURE_STATE';
  end if;
  if normalized_error is null
     or length(normalized_error) > 100
     or normalized_error !~ '^[a-z0-9_.-]+$' then
    raise exception 'INVALID_EMAIL_ERROR_CODE';
  end if;
  if normalized_provider_id is not null and length(normalized_provider_id) > 255 then
    raise exception 'INVALID_EMAIL_PROVIDER_ID';
  end if;
  if not p_ambiguous and normalized_provider_id is not null then
    raise exception 'EMAIL_PROVIDER_ID_NOT_ALLOWED_FOR_FAILED_ATTEMPT';
  end if;
  target_status := case when p_ambiguous then 'ambiguous' else 'failed' end;

  select attempt.logical_send_id
  into logical_id
  from public.invoice_email_attempts attempt
  where attempt.garage_id = p_garage_id
    and attempt.id = p_attempt_id;
  if logical_id is null then
    raise exception 'EMAIL_ATTEMPT_NOT_FOUND';
  end if;

  select email_send.*
  into send_record
  from public.invoice_email_sends email_send
  where email_send.garage_id = p_garage_id
    and email_send.id = logical_id
  for update;

  select attempt.*
  into attempt_record
  from public.invoice_email_attempts attempt
  where attempt.garage_id = p_garage_id
    and attempt.id = p_attempt_id
  for update;

  if attempt_record.claim_token <> p_claim_token then
    raise exception 'EMAIL_CLAIM_TOKEN_MISMATCH';
  end if;
  if send_record.status = 'sent' then
    return p_attempt_id;
  end if;
  if attempt_record.status = target_status
     and attempt_record.error_code = normalized_error
     and attempt_record.provider_id is not distinct from normalized_provider_id then
    return p_attempt_id;
  end if;
  if attempt_record.status <> 'pending' then
    raise exception 'EMAIL_ATTEMPT_NOT_FAILABLE';
  end if;

  update public.invoice_email_attempts attempt
  set status = target_status,
      provider_id = case when p_ambiguous then normalized_provider_id else null end,
      error_code = normalized_error,
      completed_at = now()
  where attempt.garage_id = p_garage_id
    and attempt.id = p_attempt_id;

  update public.invoice_email_sends email_send
  set status = target_status,
      provider_id = case when p_ambiguous then normalized_provider_id else null end,
      last_error_code = normalized_error,
      updated_at = now()
  where email_send.garage_id = p_garage_id
    and email_send.id = logical_id;
  return p_attempt_id;
end
$$;

-- 6g. Invoice dashboard (staff) ----------------------------------------------

create or replace function public.get_invoice_dashboard_without_payments(p_query text, p_status text, p_date date, p_page integer, p_page_size integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid;
  garage_timezone text;
  normalized_query text := lower(trim(coalesce(p_query, '')));
  normalized_registration text := upper(regexp_replace(coalesce(p_query, ''), '[^A-Za-z0-9]', '', 'g'));
  matching_count bigint;
  page_count integer;
  effective_page integer;
  page_rows jsonb;
  draft_count bigint;
  outstanding_count bigint;
  paid_count bigint;
  outstanding_total numeric;
begin
  perform public.require_invoice_actor();
  garage_scope := public.current_garage_id();
  if length(normalized_query) > 200 then raise exception 'INVALID_INVOICE_SEARCH_QUERY'; end if;
  if p_status is not null and p_status not in ('draft', 'issued', 'paid', 'void') then raise exception 'INVALID_INVOICE_STATUS'; end if;
  if p_page is null or p_page < 1 or p_page_size is null or p_page_size not between 1 and 100 then raise exception 'INVALID_INVOICE_PAGE'; end if;

  select garage.timezone into garage_timezone from public.garages garage where garage.id = garage_scope;

  select count(*) into matching_count
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.deleted_at is null
    and (p_status is null or invoice.status::text = p_status)
    and (p_date is null or invoice.issue_date = p_date or (invoice.created_at at time zone garage_timezone)::date = p_date)
    and (
      normalized_query = ''
      or position(normalized_query in lower(concat_ws(' ', invoice.invoice_number, invoice.customer_name, invoice.customer_email, invoice.customer_phone, invoice.vehicle_registration, invoice.vehicle_make, invoice.vehicle_model))) > 0
      or (length(normalized_registration) >= 2 and position(normalized_registration in coalesce(invoice.vehicle_registration, '')) > 0)
    );

  page_count := greatest(1, ceil(matching_count::numeric / p_page_size)::integer);
  effective_page := least(p_page, page_count);
  select coalesce(jsonb_agg(to_jsonb(invoice_page) order by invoice_page.created_at desc, invoice_page.id desc), '[]'::jsonb)
  into page_rows
  from (
    select invoice.id, invoice.invoice_number, invoice.status, invoice.source_type, invoice.customer_name, invoice.customer_email, invoice.customer_phone, invoice.vehicle_registration, invoice.vehicle_make, invoice.vehicle_model, invoice.issue_date, invoice.due_date, invoice.total_pence, invoice.created_at
    from public.invoices invoice
    where invoice.garage_id = garage_scope
      and invoice.deleted_at is null
      and (p_status is null or invoice.status::text = p_status)
      and (p_date is null or invoice.issue_date = p_date or (invoice.created_at at time zone garage_timezone)::date = p_date)
      and (
        normalized_query = ''
        or position(normalized_query in lower(concat_ws(' ', invoice.invoice_number, invoice.customer_name, invoice.customer_email, invoice.customer_phone, invoice.vehicle_registration, invoice.vehicle_make, invoice.vehicle_model))) > 0
        or (length(normalized_registration) >= 2 and position(normalized_registration in coalesce(invoice.vehicle_registration, '')) > 0)
      )
    order by invoice.created_at desc, invoice.id desc
    offset (effective_page - 1) * p_page_size
    limit p_page_size
  ) invoice_page;

  select
    count(*) filter (where invoice.status = 'draft'),
    count(*) filter (where invoice.status = 'issued'),
    count(*) filter (where invoice.status = 'paid'),
    coalesce(sum(invoice.total_pence) filter (where invoice.status = 'issued'), 0)
  into draft_count, outstanding_count, paid_count, outstanding_total
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.deleted_at is null;

  return jsonb_build_object(
    'invoices', page_rows,
    'matching_count', matching_count::text,
    'page', effective_page,
    'pages', page_count,
    'draft_count', draft_count::text,
    'outstanding_count', outstanding_count::text,
    'paid_count', paid_count::text,
    'outstanding_total_pence', outstanding_total::text
  );
end
$$;

create or replace function public.get_invoice_dashboard(p_query text, p_status text, p_date date, p_page integer, p_page_size integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid;
  garage_timezone text;
  result jsonb;
  outstanding_total numeric;
  current_week_paid_total numeric;
  week_start timestamptz;
  week_end timestamptz;
begin
  perform public.require_invoice_actor();
  garage_scope := public.current_garage_id();
  select garage.timezone into garage_timezone from public.garages garage where garage.id = garage_scope;
  week_start := date_trunc('week', timezone(garage_timezone, statement_timestamp())) at time zone garage_timezone;
  week_end := (date_trunc('week', timezone(garage_timezone, statement_timestamp())) + interval '1 week') at time zone garage_timezone;

  result := public.get_invoice_dashboard_without_payments(p_query, p_status, p_date, p_page, p_page_size);
  select coalesce(sum(invoice.total_pence - coalesce(payment.amount_paid_pence, 0)), 0)
  into outstanding_total
  from public.invoices invoice
  left join lateral (
    select sum(invoice_payment.amount_pence) as amount_paid_pence
    from public.invoice_payments invoice_payment
    where invoice_payment.garage_id = invoice.garage_id
      and invoice_payment.invoice_id = invoice.id
  ) payment on true
  where invoice.garage_id = garage_scope
    and invoice.status = 'issued'
    and invoice.deleted_at is null;

  select
    coalesce((
      select sum(payment.amount_pence)
      from public.invoice_payments payment
      join public.invoices invoice
        on invoice.garage_id = payment.garage_id
       and invoice.id = payment.invoice_id
      where payment.garage_id = garage_scope
        and invoice.deleted_at is null
        and payment.paid_at >= week_start
        and payment.paid_at < week_end
    ), 0)
    + coalesce((
      select sum(invoice.total_pence)
      from public.invoices invoice
      where invoice.garage_id = garage_scope
        and invoice.deleted_at is null
        and invoice.status = 'paid'
        and invoice.paid_at >= week_start
        and invoice.paid_at < week_end
        and not exists (
          select 1
          from public.invoice_payments payment
          where payment.garage_id = invoice.garage_id
            and payment.invoice_id = invoice.id
        )
    ), 0)
  into current_week_paid_total;

  return result || jsonb_build_object('outstanding_total_pence', outstanding_total::text, 'current_week_paid_total_pence', current_week_paid_total::text);
end
$$;

-- 6h. Admin trash (staff) ------------------------------------------------------

-- Limited to the kinds the garage admin still trashes: enquiries, bookings,
-- invoices and the service catalogue. Media, reviews and offers are no longer
-- managed through the trash.
create or replace function public.manage_admin_trash(p_entity text, p_ids uuid[], p_action text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid;
  target_table text;
  entity_filter text := '';
  affected integer := 0;
  target_id uuid;
begin
  if not coalesce(public.garage_actor_allowed(), false) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  garage_scope := public.current_garage_id();
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 100 then
    raise exception 'INVALID_TRASH_SELECTION';
  end if;
  if p_action not in ('trash', 'restore', 'delete') then
    raise exception 'INVALID_TRASH_ACTION';
  end if;

  target_table := case p_entity
    when 'enquiries' then 'enquiries'
    when 'bookings' then 'bookings'
    when 'invoices' then 'invoices'
    when 'catalogue_systems' then 'service_catalogue_systems'
    when 'catalogue_services' then 'booking_service_types'
    else null
  end;
  if target_table is null then raise exception 'INVALID_TRASH_ENTITY'; end if;
  if p_entity = 'catalogue_services' then entity_filter := ' and system_id is not null'; end if;

  if p_action = 'trash' then
    execute format('update public.%I set deleted_at = statement_timestamp(), deleted_by = $1 where garage_id = $3 and id = any($2) and deleted_at is null%s', target_table, entity_filter)
      using auth.uid(), p_ids, garage_scope;
    get diagnostics affected = row_count;
  elsif p_action = 'restore' then
    execute format('update public.%I set deleted_at = null, deleted_by = null where garage_id = $2 and id = any($1) and deleted_at is not null%s', target_table, entity_filter)
      using p_ids, garage_scope;
    get diagnostics affected = row_count;
  elsif p_entity = 'invoices' then
    foreach target_id in array p_ids loop
      if exists (
        select 1
        from public.invoices invoice
        where invoice.garage_id = garage_scope
          and invoice.id = target_id
          and invoice.deleted_at is not null
          and invoice.status = 'draft'
      ) then
        perform public.delete_invoice_draft(target_id);
        affected := affected + 1;
      end if;
    end loop;
  elsif p_entity = 'bookings' then
    delete from public.bookings booking
    where booking.garage_id = garage_scope
      and booking.id = any(p_ids)
      and booking.deleted_at is not null
      and not exists (
        select 1 from public.invoices invoice
        where invoice.garage_id = booking.garage_id and invoice.booking_id = booking.id
      );
    get diagnostics affected = row_count;
  elsif p_entity = 'enquiries' then
    delete from public.enquiries enquiry
    where enquiry.garage_id = garage_scope
      and enquiry.id = any(p_ids)
      and enquiry.deleted_at is not null
      and not exists (
        select 1 from public.invoices invoice
        where invoice.garage_id = enquiry.garage_id and invoice.enquiry_id = enquiry.id
      );
    get diagnostics affected = row_count;
  elsif p_entity = 'catalogue_services' then
    delete from public.booking_service_types service
    where service.garage_id = garage_scope
      and service.id = any(p_ids)
      and service.deleted_at is not null
      and service.system_id is not null
      and not exists (
        select 1 from public.bookings booking
        where booking.garage_id = service.garage_id and booking.service_type_id = service.id
      );
    get diagnostics affected = row_count;
  elsif p_entity = 'catalogue_systems' then
    delete from public.service_catalogue_systems system
    where system.garage_id = garage_scope
      and system.id = any(p_ids)
      and system.deleted_at is not null
      and not exists (
        select 1 from public.booking_service_types service
        where service.garage_id = system.garage_id and service.system_id = system.id
      );
    get diagnostics affected = row_count;
  end if;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (garage_scope, auth.uid(), 'trash.' || p_action, p_entity, coalesce(p_ids[1]::text, 'bulk'), jsonb_build_object('ids', to_jsonb(p_ids), 'affected', affected));
  return affected;
end
$$;

-- SOB's single-business check is no longer referenced anywhere.
drop function public.is_admin();

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
-- Everything starts closed, in every environment (hosted Supabase grants
-- tables to anon by default; the local image does not). anon gets nothing on
-- any table or function: public pages read through server code with the
-- service role, scoped by host. Direct staff writes follow SOB's posture:
-- invoices and their children are written only through the RPCs above.

revoke all on all tables in schema public from public, anon, authenticated, service_role;
revoke all on all sequences in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;

-- Future objects stay closed until a migration grants them explicitly.
alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated, service_role;

-- Garage core
grant select, insert, update, delete on public.garages to service_role;
grant select on public.garages to authenticated;
grant update (
  name, legal_name, company_number, phone, whatsapp, email, address, timezone, logo_url, accent,
  mot_enabled, booking_prefix, slot_step_min, approve_online, service_area, cancellation_cutoff_h,
  sms_sender, settings
) on public.garages to authenticated;

grant select, insert, update, delete on public.garage_domains to service_role;
grant select, delete on public.garage_domains to authenticated;
grant insert (garage_id, hostname) on public.garage_domains to authenticated;
grant update (deleted_at) on public.garage_domains to authenticated;

grant select, insert, update, delete on public.garage_members to service_role;
grant select, delete on public.garage_members to authenticated;
grant insert (garage_id, user_id, role) on public.garage_members to authenticated;
grant update (role) on public.garage_members to authenticated;

grant select, insert, update, delete on public.platform_admins to service_role;

-- Tenant tables staff manage directly (RLS keeps them to the selected garage)
grant select, insert, update, delete on
  public.customers,
  public.vehicles,
  public.service_catalogue_systems,
  public.booking_service_types,
  public.enquiries,
  public.enquiry_messages,
  public.enquiry_attachments,
  public.enquiry_conversations,
  public.notification_attempts,
  public.media_assets,
  public.offers,
  public.reviews,
  public.service_prices
to authenticated, service_role;

-- Bookings: staff read and update; creation goes through server code.
grant select, update on public.bookings to authenticated;
grant select, insert, update, delete on public.bookings to service_role;

-- Garage settings: staff read, owners write.
grant select, insert, update on public.site_settings to authenticated;
grant select, insert, update, delete on public.site_settings to service_role;

-- Logs and outboxes: staff read, the server writes.
grant select on public.booking_audit_log, public.booking_notification_events, public.admin_audit_log to authenticated;
grant select, insert on public.booking_audit_log, public.admin_audit_log to service_role;
grant select, insert, update, delete on public.booking_notification_events to service_role;

-- Invoicing: read-only for staff and the server; writes only through the RPCs.
-- invoice_number_sequences is reachable only from issue_invoice().
grant select on
  public.invoices,
  public.invoice_items,
  public.invoice_payments,
  public.invoice_email_sends,
  public.invoice_email_attempts
to authenticated, service_role;

-- Platform tables (no garage_id)
grant select, insert, update, delete on
  public.rate_limit_buckets,
  public.resend_webhook_events,
  public.inbound_email_events,
  public.provider_webhook_events,
  public.unmatched_inbound_emails,
  public.admin_profiles,
  public.admin_mfa_recovery_codes,
  public.admin_mfa_recovery_sessions,
  public.admin_trusted_devices
to service_role;
grant select, update on public.admin_mfa_policy to service_role;
grant select on public.admin_profiles to authenticated;
grant update (display_name) on public.admin_profiles to authenticated;
grant select on public.unmatched_inbound_emails to authenticated;
grant update (linked_enquiry_id, linked_at, ignored_at, ignored_by) on public.unmatched_inbound_emails to authenticated;

-- Garage context helpers: used by RLS policies and column defaults.
grant execute on function public.request_garage_id() to authenticated, service_role;
grant execute on function public.garage_role(uuid) to authenticated, service_role;
grant execute on function public.current_garage_id() to authenticated, service_role;
grant execute on function public.current_garage_role() to authenticated, service_role;
grant execute on function public.is_platform_admin() to authenticated, service_role;

-- Staff RPCs (garage from current_garage_id()).
grant execute on function public.save_invoice_draft(uuid, jsonb, boolean) to authenticated;
grant execute on function public.issue_invoice(uuid) to authenticated;
grant execute on function public.record_invoice_payment(uuid, bigint, timestamptz, text, text) to authenticated;
grant execute on function public.mark_invoice_paid(uuid, timestamptz, text, text) to authenticated;
grant execute on function public.void_invoice(uuid) to authenticated;
grant execute on function public.delete_invoice_draft(uuid) to authenticated;
grant execute on function public.duplicate_invoice_to_draft(uuid) to authenticated;
grant execute on function public.create_invoice_correction(uuid) to authenticated;
grant execute on function public.claim_invoice_email_send(uuid, text, uuid, bigint, text) to authenticated;
grant execute on function public.get_invoice_dashboard(text, text, date, integer, integer) to authenticated;
grant execute on function public.manage_admin_trash(text, uuid[], text) to authenticated;

-- Service-role functions (explicit p_garage_id where they touch tenant rows).
grant execute on function public.consume_rate_limit(text, text, integer, integer) to service_role;
grant execute on function public.claim_inbound_email_event(text, text, text) to service_role;
grant execute on function public.finish_inbound_email_event(text, text, text, text) to service_role;
grant execute on function public.replace_admin_mfa_recovery_codes(uuid, text[], text) to service_role;
grant execute on function public.consume_admin_mfa_recovery_code(uuid, text, text, timestamptz) to service_role;
grant execute on function public.generate_booking_reference(uuid) to service_role;
grant execute on function public.create_booking_intent(uuid, uuid, text, text, text, text, text, text, integer, text, text, text, uuid, text, text, text, jsonb, jsonb, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.create_booking_enquiry_thread(uuid, uuid, uuid) to service_role;
grant execute on function public.increment_enquiry_unread(uuid, uuid, timestamptz) to service_role;
grant execute on function public.store_inbound_email_message(uuid, uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz, text) to service_role;
grant execute on function public.apply_enquiry_retention(uuid) to service_role;
grant execute on function public.finalize_invoice_email_send(uuid, bigint, uuid, text) to service_role;
grant execute on function public.fail_invoice_email_send(uuid, bigint, uuid, text, boolean, text) to service_role;

-- Not granted to anyone (owner-only): trigger functions, invoice_line_total,
-- require_invoice_actor, get_invoice_dashboard_without_payments,
-- garage_actor_allowed, is_staff_user, audit_user_security_event,
-- garage_invoice_issuer, set_updated_at.

-- ---------------------------------------------------------------------------
-- 8. Row-level security
-- ---------------------------------------------------------------------------
-- "Selected garage" below means public.current_garage_id(): the x-garage-id
-- header, honoured only for members of that garage. The service role bypasses
-- RLS and filters by garage itself. anon has no grants, so no policy applies to
-- it. Policies are evaluated as (select ...) so each helper runs once per
-- statement.

alter table public.garages enable row level security;
alter table public.garage_domains enable row level security;
alter table public.garage_members enable row level security;
alter table public.platform_admins enable row level security;

-- garages
--   "members read their garages"         select  any garage the user belongs to (garage switcher)
--   "owners update the selected garage"  update  owners of the selected garage (column grants exclude slug, plan, status, cancelled_at)
--   no insert/delete: sign-up and closure go through service-role code
create policy "members read their garages" on public.garages
  for select to authenticated
  using (public.garage_role(id) is not null);
create policy "owners update the selected garage" on public.garages
  for update to authenticated
  using (id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner')
  with check (id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');

-- garage_domains
--   "garage members read domains"         select  members of the selected garage
--   "owners and managers add domains"     insert  owners/managers; only custom hostnames, always pending_dns
--   "owners and managers retire domains"  update  owners/managers; custom rows only (column grant: deleted_at)
--   "owners and managers delete domains"  delete  owners/managers; custom rows only
--   status moves only through the service-role domains.check job
create policy "garage members read domains" on public.garage_domains
  for select to authenticated
  using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add domains" on public.garage_domains
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and kind = 'custom'
    and status = 'pending_dns'
  );
create policy "owners and managers retire domains" on public.garage_domains
  for update to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and kind = 'custom'
  )
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and kind = 'custom'
  );
create policy "owners and managers delete domains" on public.garage_domains
  for delete to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and kind = 'custom'
  );

-- garage_members
--   "members read memberships"  select  the user's own memberships (any garage) and everyone in the selected garage
--   "owners add members"        insert  owners of the selected garage
--   "owners change roles"       update  owners of the selected garage (column grant: role)
--   "owners remove members"     delete  owners of the selected garage
--   a trigger keeps at least one owner per garage
create policy "members read memberships" on public.garage_members
  for select to authenticated
  using (user_id = (select auth.uid()) or garage_id = (select public.current_garage_id()));
create policy "owners add members" on public.garage_members
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');
create policy "owners change roles" on public.garage_members
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner')
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');
create policy "owners remove members" on public.garage_members
  for delete to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');

-- platform_admins
--   no policies: service role only (is_platform_admin() reads it as owner)

-- customers
--   "garage members read customers"    select  members of the selected garage
--   "garage members add customers"     insert  members of the selected garage
--   "garage members update customers"  update  members of the selected garage
--   "garage members delete customers"  delete  members of the selected garage
create policy "garage members read customers" on public.customers
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add customers" on public.customers
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update customers" on public.customers
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete customers" on public.customers
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- vehicles
--   "garage members read vehicles"    select  members of the selected garage
--   "garage members add vehicles"     insert  members of the selected garage
--   "garage members update vehicles"  update  members of the selected garage
--   "garage members delete vehicles"  delete  members of the selected garage
create policy "garage members read vehicles" on public.vehicles
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add vehicles" on public.vehicles
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update vehicles" on public.vehicles
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete vehicles" on public.vehicles
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- service_catalogue_systems
--   "garage members read catalogue systems"    select  members of the selected garage
--   "garage members add catalogue systems"     insert  members of the selected garage
--   "garage members update catalogue systems"  update  members of the selected garage
--   "garage members delete catalogue systems"  delete  members of the selected garage
create policy "garage members read catalogue systems" on public.service_catalogue_systems
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add catalogue systems" on public.service_catalogue_systems
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update catalogue systems" on public.service_catalogue_systems
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete catalogue systems" on public.service_catalogue_systems
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- booking_service_types
--   "garage members read booking services"    select  members of the selected garage
--   "garage members add booking services"     insert  members of the selected garage
--   "garage members update booking services"  update  members of the selected garage
--   "garage members delete booking services"  delete  members of the selected garage
create policy "garage members read booking services" on public.booking_service_types
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add booking services" on public.booking_service_types
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update booking services" on public.booking_service_types
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete booking services" on public.booking_service_types
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- bookings
--   "garage members read bookings"    select  members of the selected garage
--   "garage members update bookings"  update  members of the selected garage
--   no insert/delete for staff: bookings are created by server code and
--   permanently deleted only through manage_admin_trash()
create policy "garage members read bookings" on public.bookings
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members update bookings" on public.bookings
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));

-- booking_audit_log
--   "garage members read booking history"  select  members of the selected garage
--   written by server code only
create policy "garage members read booking history" on public.booking_audit_log
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- booking_notification_events
--   "garage members read booking notifications"  select  members of the selected garage
--   written by server code only
create policy "garage members read booking notifications" on public.booking_notification_events
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- enquiries
--   "garage members read enquiries"    select  members of the selected garage
--   "garage members add enquiries"     insert  members of the selected garage
--   "garage members update enquiries"  update  members of the selected garage
--   "garage members delete enquiries"  delete  members of the selected garage
create policy "garage members read enquiries" on public.enquiries
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add enquiries" on public.enquiries
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update enquiries" on public.enquiries
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete enquiries" on public.enquiries
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- enquiry_messages
--   "garage members read enquiry messages"    select  members of the selected garage
--   "garage members add enquiry messages"     insert  members of the selected garage
--   "garage members update enquiry messages"  update  members of the selected garage
--   "garage members delete enquiry messages"  delete  members of the selected garage
create policy "garage members read enquiry messages" on public.enquiry_messages
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add enquiry messages" on public.enquiry_messages
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update enquiry messages" on public.enquiry_messages
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete enquiry messages" on public.enquiry_messages
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- enquiry_attachments
--   "garage members read attachments"    select  members of the selected garage
--   "garage members add attachments"     insert  members of the selected garage
--   "garage members update attachments"  update  members of the selected garage
--   "garage members delete attachments"  delete  members of the selected garage
create policy "garage members read attachments" on public.enquiry_attachments
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add attachments" on public.enquiry_attachments
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update attachments" on public.enquiry_attachments
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete attachments" on public.enquiry_attachments
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- enquiry_conversations
--   "garage members read conversations"    select  members of the selected garage
--   "garage members add conversations"     insert  members of the selected garage
--   "garage members update conversations"  update  members of the selected garage
--   "garage members delete conversations"  delete  members of the selected garage
create policy "garage members read conversations" on public.enquiry_conversations
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add conversations" on public.enquiry_conversations
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update conversations" on public.enquiry_conversations
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete conversations" on public.enquiry_conversations
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- notification_attempts
--   "garage members read notification attempts"    select  members of the selected garage
--   "garage members add notification attempts"     insert  members of the selected garage
--   "garage members update notification attempts"  update  members of the selected garage
--   "garage members delete notification attempts"  delete  members of the selected garage
create policy "garage members read notification attempts" on public.notification_attempts
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add notification attempts" on public.notification_attempts
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update notification attempts" on public.notification_attempts
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete notification attempts" on public.notification_attempts
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- invoices
--   "garage members read invoices"  select  members of the selected garage
--   no direct writes: save_invoice_draft(), issue_invoice() and the other RPCs only
create policy "garage members read invoices" on public.invoices
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- invoice_items
--   "garage members read invoice items"  select  members of the selected garage
--   no direct writes: save_invoice_draft() only
create policy "garage members read invoice items" on public.invoice_items
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- invoice_payments
--   "garage members read invoice payments"  select  members of the selected garage
--   no direct writes: record_invoice_payment() only
create policy "garage members read invoice payments" on public.invoice_payments
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- invoice_email_sends
--   "garage members read invoice email sends"  select  members of the selected garage
--   no direct writes: claim/finalize/fail_invoice_email_send() only
create policy "garage members read invoice email sends" on public.invoice_email_sends
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- invoice_email_attempts
--   "garage members read invoice email attempts"  select  members of the selected garage
--   no direct writes: claim/finalize/fail_invoice_email_send() only
create policy "garage members read invoice email attempts" on public.invoice_email_attempts
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- invoice_number_sequences
--   no policies and no grants: only issue_invoice() (security definer) touches it

-- media_assets
--   "garage members read media"    select  members of the selected garage
--   "garage members add media"     insert  members of the selected garage
--   "garage members update media"  update  members of the selected garage
--   "garage members delete media"  delete  members of the selected garage
create policy "garage members read media" on public.media_assets
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add media" on public.media_assets
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update media" on public.media_assets
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete media" on public.media_assets
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- offers
--   "garage members read offers"    select  members of the selected garage
--   "garage members add offers"     insert  members of the selected garage
--   "garage members update offers"  update  members of the selected garage
--   "garage members delete offers"  delete  members of the selected garage
create policy "garage members read offers" on public.offers
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add offers" on public.offers
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update offers" on public.offers
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete offers" on public.offers
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- reviews
--   "garage members read reviews"    select  members of the selected garage
--   "garage members add reviews"     insert  members of the selected garage
--   "garage members update reviews"  update  members of the selected garage
--   "garage members delete reviews"  delete  members of the selected garage
create policy "garage members read reviews" on public.reviews
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add reviews" on public.reviews
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update reviews" on public.reviews
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete reviews" on public.reviews
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- service_prices
--   "garage members read prices"    select  members of the selected garage
--   "garage members add prices"     insert  members of the selected garage
--   "garage members update prices"  update  members of the selected garage
--   "garage members delete prices"  delete  members of the selected garage
create policy "garage members read prices" on public.service_prices
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add prices" on public.service_prices
  for insert to authenticated with check (garage_id = (select public.current_garage_id()));
create policy "garage members update prices" on public.service_prices
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));
create policy "garage members delete prices" on public.service_prices
  for delete to authenticated using (garage_id = (select public.current_garage_id()));

-- site_settings
--   "garage members read settings"  select  members of the selected garage
--   "owners create settings"        insert  owners of the selected garage
--   "owners update settings"        update  owners of the selected garage
--   no delete for staff
create policy "garage members read settings" on public.site_settings
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners create settings" on public.site_settings
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');
create policy "owners update settings" on public.site_settings
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner')
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');

-- admin_audit_log
--   "garage members read audit log"  select  members of the selected garage
--   append-only, written by server code and security-definer functions
create policy "garage members read audit log" on public.admin_audit_log
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- admin_profiles (platform, one row per user)
--   "users read their own profile"    select  the profile's own user
--   "users update their own profile"  update  the profile's own user (column grant: display_name)
create policy "users read their own profile" on public.admin_profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy "users update their own profile" on public.admin_profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- unmatched_inbound_emails (platform)
--   "platform admins read unmatched email"    select  platform admins
--   "platform admins triage unmatched email"  update  platform admins (link or ignore)
create policy "platform admins read unmatched email" on public.unmatched_inbound_emails
  for select to authenticated using ((select public.is_platform_admin()));
create policy "platform admins triage unmatched email" on public.unmatched_inbound_emails
  for update to authenticated
  using ((select public.is_platform_admin()))
  with check ((select public.is_platform_admin()));

-- admin_mfa_policy, admin_mfa_recovery_codes, admin_mfa_recovery_sessions,
-- admin_trusted_devices, rate_limit_buckets, resend_webhook_events,
-- inbound_email_events, provider_webhook_events
--   no policies: service role only

comment on table public.admin_mfa_policy is
  'Platform switch (service role only). When mandatory_mfa_enabled is true, garage owners must use a verified TOTP factor at AAL2 for privileged RPCs.';

-- ---------------------------------------------------------------------------
-- 9. Storage
-- ---------------------------------------------------------------------------
-- Objects live under "<garage_id>/..." in both buckets; staff of the selected
-- garage may work only inside that folder. public-media is a public bucket, so
-- reads of its files do not go through these policies.

-- storage.objects (public-media)
--   "garage staff read garage media"    select  staff of the selected garage, own folder
--   "garage staff upload garage media"  insert  staff of the selected garage, own folder
--   "garage staff update garage media"  update  staff of the selected garage, own folder
--   "garage staff delete garage media"  delete  staff of the selected garage, own folder
create policy "garage staff read garage media" on storage.objects
  for select to authenticated
  using (bucket_id = 'public-media' and (storage.foldername(name))[1] = (select public.current_garage_id())::text);
create policy "garage staff upload garage media" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'public-media' and (storage.foldername(name))[1] = (select public.current_garage_id())::text);
create policy "garage staff update garage media" on storage.objects
  for update to authenticated
  using (bucket_id = 'public-media' and (storage.foldername(name))[1] = (select public.current_garage_id())::text)
  with check (bucket_id = 'public-media' and (storage.foldername(name))[1] = (select public.current_garage_id())::text);
create policy "garage staff delete garage media" on storage.objects
  for delete to authenticated
  using (bucket_id = 'public-media' and (storage.foldername(name))[1] = (select public.current_garage_id())::text);

-- storage.objects (enquiry-attachments, private)
--   "garage staff read garage attachments"  select  staff of the selected garage, own folder
--   uploads use signed upload URLs created by server code
create policy "garage staff read garage attachments" on storage.objects
  for select to authenticated
  using (bucket_id = 'enquiry-attachments' and (storage.foldername(name))[1] = (select public.current_garage_id())::text);
