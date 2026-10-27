-- Autofix scheduling engine (P2.1, P2.2, P2.3).
--
-- Replaces Cal.com with Autofix's own diary, following docs/autofix/ARCHITECTURE.md
-- ("Booking engine"):
--
--   1. resources, opening_hours, closures, services and booking_events, and a
--      rebuilt bookings table whose during tstzrange is guarded by the
--      no_overlap exclusion constraint (btree_gist).
--   2. customers gain channel and consent fields and one row per phone per
--      garage; vehicles one row per registration per garage (fuel_type becomes
--      fuel; MOT and mileage columns); garages gain mobile_travel_min.
--   3. available_slots() and create_booking(), service-role only, on top of
--      clock-injectable internals (available_slots_at(), create_booking_at())
--      that the pgTAP tests drive with fixed dates. seed_garage_defaults() for
--      sign-up.
--   4. Cal.com leftovers removed: the provider_* booking columns,
--      booking_service_types, service_catalogue_systems, provider_webhook_events
--      and create_booking_intent(). (No calendly_* objects exist.)
--   5. Functions that read the old booking shape are rewritten:
--      generate_booking_reference(), assign_booking_reference(),
--      create_booking_enquiry_thread(), save_invoice_draft(), issue_invoice(),
--      manage_admin_trash() and apply_enquiry_retention().
--
-- There is no production data yet, so bookings is rebuilt rather than
-- migrated; the guard below refuses to run if any booking or Cal.com service
-- row exists.
--
-- Rollback notes (manual; nothing here runs automatically). Prefer restoring
-- the database to before this migration (supabase db reset to
-- 20261026000200_tenancy_test_support.sql locally, a backup elsewhere). To
-- undo by hand, in one transaction:
--   1. drop function public.create_booking(uuid, jsonb), public.create_booking_at(uuid, jsonb, timestamptz),
--      public.available_slots(uuid, uuid, date, date, text),
--      public.available_slots_at(uuid, uuid, date, date, text, timestamptz),
--      public.seed_garage_defaults(uuid), public.booking_service_context(uuid, uuid, text),
--      public.opening_window_starts(uuid, date, date, integer), public.booking_result(public.bookings, boolean),
--      public.booking_input_text(jsonb, text, integer), public.booking_input_uuid(jsonb, text),
--      public.maintain_booking_cancellation(), public.log_booking_status_change();
--   2. drop the foreign keys from booking_audit_log, booking_notification_events,
--      enquiries and invoices to bookings; drop table public.booking_events,
--      public.bookings, public.services, public.closures, public.opening_hours,
--      public.resources (booking rows are lost);
--   3. re-run the bookings, booking_service_types, service_catalogue_systems,
--      provider_webhook_events and booking_status definitions from
--      20261026000000_baseline.sql with their 20261026000100_tenancy.sql
--      changes (garage_id, composite keys, indexes, grants, policies), then
--      re-add the four foreign keys;
--   4. re-create create_booking_intent(), generate_booking_reference(),
--      assign_booking_reference(), create_booking_enquiry_thread(),
--      save_invoice_draft(), issue_invoice(), manage_admin_trash() and
--      apply_enquiry_retention() from 20261026000100_tenancy.sql;
--   5. customers: drop the phone and consent constraints and
--      customers_garage_id_phone_key, set phone = 'REDACTED' where
--      anonymised_at is not null, set phone not null, drop channel,
--      reminder_consent, consent_at, consent_source, consent_text, opted_out_at, and
--      re-create customers_garage_phone_idx; vehicles: drop
--      vehicles_garage_id_registration_key and the new columns, rename fuel to
--      fuel_type, re-create vehicles_garage_registration_idx; garages: drop
--      mobile_travel_min;
--   6. drop extension btree_gist if nothing else uses it.

-- ---------------------------------------------------------------------------
-- 0. Guard
-- ---------------------------------------------------------------------------

do $$
declare
  guarded_table text;
  has_rows boolean;
begin
  foreach guarded_table in array array['bookings', 'booking_service_types', 'service_catalogue_systems'] loop
    execute format('select exists (select 1 from public.%I)', guarded_table) into has_rows;
    if has_rows then
      raise exception 'The scheduling migration rebuilds public.bookings and drops the Cal.com service tables, but public.% has rows. There is no production data yet: reset the database instead of migrating them.', guarded_table;
    end if;
  end loop;
  if exists (
    select 1 from public.customers customer
    where customer.anonymised_at is null and customer.phone !~ '^\+[1-9][0-9]{6,14}$'
  ) then
    raise exception 'customers.phone must be E.164 (+447700900123) before the scheduling migration';
  end if;
  if exists (
    select 1 from public.customers customer
    where customer.anonymised_at is null
    group by customer.garage_id, customer.phone having count(*) > 1
  ) then
    raise exception 'Some garages have two customers with the same phone; merge them before the scheduling migration';
  end if;
  if exists (
    select 1 from public.vehicles vehicle
    where vehicle.registration is not null
    group by vehicle.garage_id, vehicle.registration having count(*) > 1
  ) then
    raise exception 'Some garages have two vehicles with the same registration; merge them before the scheduling migration';
  end if;
end
$$;

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Garages, customers and vehicles
-- ---------------------------------------------------------------------------

alter table public.garages
  add column mobile_travel_min integer not null default 30,
  add constraint garages_mobile_travel_min_check check (mobile_travel_min between 0 and 240);

comment on column public.garages.mobile_travel_min is
  'Minutes of travel blocked on the mobile resource before and after every mobile visit.';

-- customers: one row per phone number per garage (E.164). Anonymised
-- customers keep no phone, so any number of them can exist.
alter table public.customers alter column phone drop not null;
update public.customers set phone = null where anonymised_at is not null;
drop index public.customers_garage_phone_idx;
alter table public.customers
  add column channel text not null default 'sms',
  add column reminder_consent boolean not null default false,
  add column consent_at timestamptz,
  add column consent_source text,
  add column consent_text text,
  add column opted_out_at timestamptz,
  add constraint customers_garage_id_phone_key unique (garage_id, phone),
  add constraint customers_phone_check check (
    (anonymised_at is null and phone ~ '^\+[1-9][0-9]{6,14}$')
    or (anonymised_at is not null and phone is null)
  ),
  add constraint customers_channel_check check (channel in ('sms', 'whatsapp', 'email')),
  add constraint customers_consent_source_check
    check (consent_source is null or consent_source in ('booking', 'import', 'soft_opt_in', 'staff')),
  add constraint customers_consent_check
    check (not reminder_consent or (consent_at is not null and consent_source is not null)),
  add constraint customers_consent_text_check
    check (consent_text is null or (consent_at is not null and char_length(consent_text) between 1 and 2000));

comment on column public.customers.reminder_consent is
  'Stored consent to reminders. Sending also requires opted_out_at is null (STOP or unsubscribe wins).';
comment on column public.customers.consent_text is
  'The exact consent wording the customer agreed to (PECR record), stored with consent_at and consent_source.';
comment on column public.customers.opted_out_at is
  'Set by STOP or the unsubscribe page. create_booking() never clears it.';

-- vehicles: one row per registration per garage (registrations are stored
-- normalised by vehicles_normalise_registration).
drop index public.vehicles_garage_registration_idx;
alter table public.vehicles rename column fuel_type to fuel;
alter table public.vehicles
  add column mot_expiry date,
  add column mot_checked_at timestamptz,
  add column last_mileage integer,
  add column last_service_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint vehicles_garage_id_registration_key unique (garage_id, registration),
  add constraint vehicles_year_check check (year is null or year between 1885 and 2100),
  add constraint vehicles_last_mileage_check check (last_mileage is null or last_mileage between 0 and 2000000);

create trigger vehicles_updated before update on public.vehicles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Remove the Cal.com leftovers and SOB's bookings
-- ---------------------------------------------------------------------------

drop function public.create_booking_intent(uuid, uuid, text, text, text, text, text, text, integer, text, text, text, uuid, text, text, text, jsonb, jsonb, text, text, text, text, timestamptz, text);

alter table public.booking_audit_log drop constraint booking_audit_log_booking_id_fkey;
alter table public.booking_notification_events drop constraint booking_notification_events_booking_id_fkey;
alter table public.enquiries drop constraint enquiries_booking_id_fkey;
alter table public.invoices drop constraint invoices_booking_id_fkey;

drop table public.bookings;
drop table public.booking_service_types;
drop table public.service_catalogue_systems;
drop table public.provider_webhook_events;
drop type public.booking_status;

-- ---------------------------------------------------------------------------
-- 3. Scheduling tables
-- ---------------------------------------------------------------------------

-- What a booking takes up: a bay, the mobile van, or a technician.
create table public.resources (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  name text not null,
  kind text not null default 'bay',
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resources_garage_id_id_key unique (garage_id, id),
  constraint resources_name_check check (char_length(trim(name)) between 1 and 60),
  constraint resources_kind_check check (kind in ('bay', 'mobile', 'technician'))
);

create index resources_garage_kind_idx on public.resources (garage_id, kind, sort);

-- Opening windows in the garage's local time; several per weekday make a
-- split day. Windows on the same weekday may touch but not overlap.
create table public.opening_hours (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  weekday smallint not null,
  opens time not null,
  closes time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opening_hours_weekday_check check (weekday between 1 and 7),
  constraint opening_hours_window_check check (closes > opens),
  constraint opening_hours_whole_minutes_check check (extract(second from opens) = 0 and extract(second from closes) = 0),
  constraint opening_hours_no_overlap exclude using gist (
    garage_id with =,
    weekday with =,
    numrange(extract(epoch from opens), extract(epoch from closes), '[)') with &&
  )
);

comment on column public.opening_hours.weekday is 'ISO weekday: 1 = Monday ... 7 = Sunday.';

-- Whole days the garage is closed (inclusive).
create table public.closures (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint closures_dates_check check (ends_on >= starts_on),
  constraint closures_reason_check check (reason is null or char_length(reason) <= 200)
);

create index closures_garage_dates_idx on public.closures (garage_id, starts_on, ends_on);

-- What a customer can book. resource_kind is the workshop resource; mobile
-- visits always take a mobile resource, so only mobile-only services name
-- 'mobile' here.
create table public.services (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  name text not null,
  description text not null default '',
  duration_min integer not null,
  buffer_min integer not null default 0,
  price_pence integer,
  price_mode text not null default 'fixed',
  location_mode text not null default 'workshop',
  resource_kind text not null default 'bay',
  online_enabled boolean not null default true,
  needs_approval boolean not null default false,
  min_notice_h integer not null default 2,
  max_days_ahead integer not null default 60,
  is_mot boolean not null default false,
  sort integer not null default 0,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint services_garage_id_id_key unique (garage_id, id),
  constraint services_name_check check (char_length(trim(name)) between 1 and 120),
  constraint services_description_check check (char_length(description) <= 600),
  constraint services_duration_min_check check (duration_min between 5 and 720),
  constraint services_buffer_min_check check (buffer_min between 0 and 240),
  constraint services_price_mode_check check (price_mode in ('fixed', 'from', 'quote')),
  constraint services_price_check check (
    (price_mode = 'quote' and price_pence is null)
    or (price_mode <> 'quote' and price_pence is not null and price_pence >= 0)
  ),
  constraint services_location_mode_check check (location_mode in ('workshop', 'mobile', 'both')),
  constraint services_resource_kind_check check (resource_kind in ('bay', 'mobile', 'technician')),
  constraint services_mobile_resource_check check ((location_mode = 'mobile') = (resource_kind = 'mobile')),
  constraint services_min_notice_h_check check (min_notice_h between 0 and 720),
  constraint services_max_days_ahead_check check (max_days_ahead between 1 and 365)
);

create index services_garage_sort_idx on public.services (garage_id, sort, name) where deleted_at is null;

comment on column public.services.is_mot is 'MOT services are bookable and listed only while garages.mot_enabled is true.';

-- Bookings. starts_at/ends_at are the customer-facing appointment; during is
-- what the resource is blocked for: travel before + duration + buffer +
-- travel after. no_overlap is the last line of defence against double
-- bookings; create_booking() is the only intended writer.
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  reference text not null,
  customer_id uuid not null,
  vehicle_id uuid not null,
  service_id uuid not null,
  resource_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  during tstzrange not null,
  status text not null default 'requested',
  source text not null default 'online',
  location_mode text not null default 'workshop',
  postcode text,
  address text,
  symptoms text[] not null default '{}'::text[],
  notes text,
  idempotency_key uuid,
  manage_token_hash text,
  reminder_send_id uuid,
  price_pence integer,
  cancelled_at timestamptz,
  cancellation_reason text,
  admin_seen_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_garage_id_id_key unique (garage_id, id),
  constraint bookings_garage_id_reference_key unique (garage_id, reference),
  constraint bookings_garage_id_idempotency_key_key unique (garage_id, idempotency_key),
  constraint bookings_customer_id_fkey foreign key (garage_id, customer_id) references public.customers (garage_id, id),
  constraint bookings_vehicle_id_fkey foreign key (garage_id, vehicle_id) references public.vehicles (garage_id, id),
  constraint bookings_service_id_fkey foreign key (garage_id, service_id) references public.services (garage_id, id),
  constraint bookings_resource_id_fkey foreign key (garage_id, resource_id) references public.resources (garage_id, id),
  constraint bookings_reference_check check (reference ~ '^[A-Z]{2,4}-[0-9]{4,6}$'),
  constraint bookings_times_check check (ends_at > starts_at),
  constraint bookings_during_check check (
    not isempty(during)
    and lower_inc(during) and not upper_inc(during)
    and lower(during) <= starts_at and upper(during) >= ends_at
  ),
  constraint bookings_status_check check (status in (
    'requested', 'confirmed', 'arrived', 'in_progress', 'waiting_parts', 'ready', 'collected', 'cancelled', 'no_show'
  )),
  constraint bookings_source_check check (source in ('online', 'phone', 'walk_in', 'reminder', 'missed_call', 'ai_agent')),
  constraint bookings_location_mode_check check (location_mode in ('workshop', 'mobile')),
  constraint bookings_mobile_postcode_check check (location_mode = 'workshop' or postcode is not null),
  constraint bookings_postcode_check check (postcode is null or postcode ~ '^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$'),
  constraint bookings_address_check check (address is null or char_length(address) <= 300),
  constraint bookings_symptoms_check check (cardinality(symptoms) <= 10),
  constraint bookings_notes_check check (notes is null or char_length(notes) <= 2000),
  constraint bookings_manage_token_hash_check check (manage_token_hash is null or manage_token_hash ~ '^[0-9a-f]{64}$'),
  constraint bookings_price_pence_check check (price_pence is null or price_pence >= 0),
  constraint bookings_cancellation_check check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint no_overlap exclude using gist (resource_id with =, during with &&)
    where (status not in ('cancelled', 'no_show'))
);

create index bookings_garage_starts_idx on public.bookings (garage_id, starts_at);
create index bookings_garage_during_idx on public.bookings using gist (garage_id, during);
create index bookings_garage_customer_idx on public.bookings (garage_id, customer_id);
create index bookings_garage_vehicle_idx on public.bookings (garage_id, vehicle_id);
create index bookings_garage_service_idx on public.bookings (garage_id, service_id);
create index bookings_garage_resource_idx on public.bookings (garage_id, resource_id);
create index bookings_active_created_idx on public.bookings (garage_id, created_at desc) where deleted_at is null;
create index bookings_admin_unseen_idx on public.bookings (garage_id, created_at desc) where admin_seen_at is null;
create unique index bookings_manage_token_hash_key on public.bookings (garage_id, manage_token_hash)
  where manage_token_hash is not null;
create index bookings_reminder_send_idx on public.bookings (garage_id, reminder_send_id) where reminder_send_id is not null;

comment on column public.bookings.during is
  'What the resource is blocked for: [starts_at - travel, ends_at + buffer + travel). Guarded by no_overlap.';
comment on column public.bookings.reminder_send_id is
  'The reminder that produced this booking. Its foreign key to reminder_sends and the attribution land in P3.6.';
comment on column public.bookings.admin_seen_at is
  'When a member first opened this booking in the admin; null means it still needs review.';

-- Timeline and audit trail of a booking.
create table public.booking_events (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  booking_id uuid not null,
  type text not null,
  actor text not null,
  actor_id uuid,
  at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint booking_events_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade,
  constraint booking_events_type_check check (type in (
    'created', 'status_changed', 'rescheduled', 'cancelled', 'note', 'notification_sent'
  )),
  constraint booking_events_actor_check check (actor in ('customer', 'staff', 'system', 'agent')),
  constraint booking_events_data_check check (jsonb_typeof(data) = 'object')
);

create index booking_events_garage_booking_idx on public.booking_events (garage_id, booking_id, at);

comment on column public.booking_events.actor_id is
  'The member (auth.users id) for staff events; the agent token for agent events (P4.2); null otherwise.';

-- SOB's booking children point at the new table again.
alter table public.booking_audit_log
  add constraint booking_audit_log_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade;
alter table public.booking_notification_events
  add constraint booking_notification_events_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade;
alter table public.enquiries
  add constraint enquiries_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete set null (booking_id);
alter table public.invoices
  add constraint invoices_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id);

-- ---------------------------------------------------------------------------
-- 4. Triggers
-- ---------------------------------------------------------------------------

create trigger resources_updated before update on public.resources
  for each row execute function public.set_updated_at();
create trigger opening_hours_updated before update on public.opening_hours
  for each row execute function public.set_updated_at();
create trigger closures_updated before update on public.closures
  for each row execute function public.set_updated_at();
create trigger services_updated before update on public.services
  for each row execute function public.set_updated_at();
create trigger bookings_updated before update on public.bookings
  for each row execute function public.set_updated_at();

-- <booking_prefix>-NNNN, random and unique per garage. Once more than 80% of
-- the 4-digit references are used the garage moves to 5 digits, then 6.
create or replace function public.generate_booking_reference(p_garage_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefix text;
  digits integer := 4;
  used bigint;
  candidate text;
  attempt integer := 0;
begin
  select garage.booking_prefix
  into prefix
  from public.garages garage
  where garage.id = p_garage_id;
  if prefix is null then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Serialise allocation per garage so the existence check and the following
  -- insert cannot race another booking for the same garage.
  perform pg_advisory_xact_lock(hashtextextended('public.bookings.reference:' || p_garage_id::text, 0));

  loop
    select count(*)
    into used
    from public.bookings booking
    where booking.garage_id = p_garage_id
      and booking.reference like prefix || '-%'
      and char_length(booking.reference) = char_length(prefix) + 1 + digits;
    exit when digits = 6 or used <= 0.8 * (10 ^ digits);
    digits := digits + 1;
  end loop;

  loop
    attempt := attempt + 1;
    if attempt > 10000 then
      raise exception 'BOOKING_REFERENCE_SPACE_EXHAUSTED' using errcode = 'P0001';
    end if;
    candidate := prefix || '-' || lpad(floor(random() * (10 ^ digits))::bigint::text, digits, '0');
    exit when not exists (
      select 1
      from public.bookings booking
      where booking.garage_id = p_garage_id
        and booking.reference = candidate
    );
  end loop;
  return candidate;
end
$$;

create or replace function public.assign_booking_reference()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.reference is null then
    new.reference := public.generate_booking_reference(new.garage_id);
  end if;
  return new;
end
$$;

create trigger bookings_assign_reference before insert on public.bookings
  for each row execute function public.assign_booking_reference();

-- cancelled_at follows status, so bookings_cancellation_check always holds.
create function public.maintain_booking_cancellation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  else
    new.cancelled_at := null;
  end if;
  return new;
end
$$;

create trigger bookings_cancellation before insert or update on public.bookings
  for each row execute function public.maintain_booking_cancellation();

-- Every status change lands in the booking's timeline, whoever makes it:
-- staff through the RLS client (actor staff, their user id) or server code
-- (actor system). App code should not insert status_changed events itself.
create function public.log_booking_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public.booking_events (garage_id, booking_id, type, actor, actor_id, data)
    values (
      new.garage_id,
      new.id,
      case when new.status = 'cancelled' then 'cancelled' else 'status_changed' end,
      case when auth.uid() is null then 'system' else 'staff' end,
      auth.uid(),
      jsonb_build_object('from', old.status, 'to', new.status)
    );
  end if;
  return null;
end
$$;

create trigger bookings_log_status after update of status on public.bookings
  for each row execute function public.log_booking_status_change();

-- ---------------------------------------------------------------------------
-- 5. Availability (P2.2)
-- ---------------------------------------------------------------------------
-- Internals are not granted to any API role; available_slots() and
-- create_booking() (security definer) call them as the owner.

-- Every start on the given local dates (inclusive) that fits the service in
-- an opening window: from each window's opening, every slot_step_min, while
-- start + duration <= closing. Window bounds are built from the local date
-- and time in the garage's time zone, so clock changes give the right UTC
-- instants. Closures, notice and resources are applied by the callers.
create function public.opening_window_starts(p_garage_id uuid, p_from date, p_to date, p_duration_min integer)
returns table (local_date date, starts_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select day.local_date, slot.starts_at
  from public.garages garage
  cross join lateral (
    select series::date as local_date
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') series
  ) day
  join public.opening_hours hours
    on hours.garage_id = garage.id
   and hours.weekday = extract(isodow from day.local_date)
  cross join lateral (
    select
      (day.local_date + hours.opens) at time zone garage.timezone as opens_at,
      (day.local_date + hours.closes) at time zone garage.timezone as closes_at
  ) bounds
  cross join lateral generate_series(
    bounds.opens_at,
    bounds.closes_at - make_interval(mins => p_duration_min),
    make_interval(mins => garage.slot_step_min)
  ) slot(starts_at)
  where garage.id = p_garage_id
  order by slot.starts_at
$$;

-- The bookable shape of a service at a garage in a location mode, or
-- SERVICE_UNAVAILABLE: the garage must be onboarding or active, the service
-- live and online, MOT services need garages.mot_enabled, and the mode must
-- be one the service offers. Without a mode, mobile-only services are mobile
-- visits and everything else is a workshop visit. Mobile visits use mobile
-- resources and garages.mobile_travel_min each way.
create function public.booking_service_context(p_garage_id uuid, p_service_id uuid, p_location_mode text)
returns table (
  timezone text,
  slot_step_min integer,
  duration_min integer,
  buffer_min integer,
  min_notice_h integer,
  max_days_ahead integer,
  location_mode text,
  resource_kind text,
  travel_min integer,
  needs_approval boolean,
  approve_online boolean,
  price_pence integer,
  service_area text[]
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_location_mode is not null and p_location_mode not in ('workshop', 'mobile') then
    raise exception 'INVALID_BOOKING: location_mode must be workshop or mobile' using errcode = 'P0001';
  end if;

  return query
  select
    garage.timezone,
    garage.slot_step_min,
    service.duration_min,
    service.buffer_min,
    service.min_notice_h,
    service.max_days_ahead,
    visit.location_mode,
    case when visit.location_mode = 'mobile' then 'mobile' else service.resource_kind end,
    case when visit.location_mode = 'mobile' then garage.mobile_travel_min else 0 end,
    service.needs_approval,
    garage.approve_online,
    service.price_pence,
    garage.service_area
  from public.garages garage
  join public.services service
    on service.garage_id = garage.id
   and service.id = p_service_id
  cross join lateral (
    select coalesce(p_location_mode, case when service.location_mode = 'mobile' then 'mobile' else 'workshop' end) as location_mode
  ) visit
  where garage.id = p_garage_id
    and garage.status in ('onboarding', 'active')
    and service.deleted_at is null
    and service.online_enabled
    and (not service.is_mot or garage.mot_enabled)
    and service.location_mode in ('both', visit.location_mode);

  if not found then
    raise exception 'SERVICE_UNAVAILABLE' using errcode = 'P0001';
  end if;
end
$$;

-- available_slots() with an explicit clock (p_now). Every candidate start on
-- the local dates p_from..p_to (clamped to today .. now + max_days_ahead)
-- outside closures and inside the notice window, with free_count = active
-- resources of the kind with no live booking overlapping the would-be
-- during. free_count = 0 rows are returned too.
create function public.available_slots_at(
  p_garage_id uuid,
  p_service_id uuid,
  p_from date,
  p_to date,
  p_location_mode text,
  p_now timestamptz
)
returns table (starts_at timestamptz, ends_at timestamptz, free_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  context record;
  travel interval;
  duration interval;
  block interval;
  earliest timestamptz;
  latest timestamptz;
  first_day date;
  last_day date;
begin
  if p_garage_id is null or p_service_id is null or p_from is null or p_to is null or p_now is null then
    raise exception 'INVALID_BOOKING: garage, service, from and to are required' using errcode = 'P0001';
  end if;
  if p_to < p_from then
    raise exception 'INVALID_BOOKING: from must not be after to' using errcode = 'P0001';
  end if;

  select * into context from public.booking_service_context(p_garage_id, p_service_id, p_location_mode);

  travel := make_interval(mins => context.travel_min);
  duration := make_interval(mins => context.duration_min);
  block := duration + make_interval(mins => context.buffer_min) + travel;
  earliest := p_now + make_interval(hours => context.min_notice_h);
  latest := p_now + make_interval(hours => context.max_days_ahead * 24);
  first_day := greatest(p_from, (p_now at time zone context.timezone)::date);
  last_day := least(p_to, (latest at time zone context.timezone)::date);
  if first_day > last_day then
    return;
  end if;

  return query
  with candidate as (
    select window_start.starts_at as slot_start
    from public.opening_window_starts(p_garage_id, first_day, last_day, context.duration_min) window_start
    where window_start.starts_at >= earliest
      and window_start.starts_at <= latest
      and not exists (
        select 1
        from public.closures closure
        where closure.garage_id = p_garage_id
          and window_start.local_date between closure.starts_on and closure.ends_on
      )
  ),
  pool as (
    select resource.id as resource_id
    from public.resources resource
    where resource.garage_id = p_garage_id
      and resource.active
      and resource.kind = context.resource_kind
  )
  select
    candidate.slot_start,
    candidate.slot_start + duration,
    (
      select count(*)::integer
      from pool
      where not exists (
        select 1
        from public.bookings booking
        where booking.garage_id = p_garage_id
          and booking.resource_id = pool.resource_id
          and booking.status not in ('cancelled', 'no_show')
          and booking.during && tstzrange(candidate.slot_start - travel, candidate.slot_start + block, '[)')
      )
    )
  from candidate
  order by candidate.slot_start;
end
$$;

-- Contract (ARCHITECTURE.md): local dates in the garage's time zone,
-- inclusive; every candidate start, free_count = 0 meaning taken. Raises
-- SERVICE_UNAVAILABLE / INVALID_BOOKING (errcode P0001) like create_booking.
create function public.available_slots(
  p_garage_id uuid,
  p_service_id uuid,
  p_from date,
  p_to date,
  p_location_mode text default null
)
returns table (starts_at timestamptz, ends_at timestamptz, free_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select slot.starts_at, slot.ends_at, slot.free_count
  from public.available_slots_at(p_garage_id, p_service_id, p_from, p_to, p_location_mode, now()) slot
$$;

-- ---------------------------------------------------------------------------
-- 7. Garage defaults (sign-up, P4.4)
-- ---------------------------------------------------------------------------
-- Opening hours (Mon-Fri 08:00-17:30, Sat 08:30-13:00), 3 bays and a mobile
-- van, and six services. The MOT service is created for every garage and
-- stays unbookable until garages.mot_enabled. Each group is added only when
-- the garage has none, so running it again adds nothing. Reminder rules are
-- added here in P3.6.
create function public.seed_garage_defaults(p_garage_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  hours_added integer := 0;
  resources_added integer := 0;
  services_added integer := 0;
begin
  perform 1 from public.garages garage where garage.id = p_garage_id for update;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.opening_hours hours where hours.garage_id = p_garage_id) then
    insert into public.opening_hours (garage_id, weekday, opens, closes)
    select p_garage_id, weekday, time '08:00', time '17:30' from generate_series(1, 5) weekday
    union all
    select p_garage_id, 6, time '08:30', time '13:00';
    get diagnostics hours_added = row_count;
  end if;

  if not exists (select 1 from public.resources resource where resource.garage_id = p_garage_id) then
    insert into public.resources (garage_id, name, kind, sort) values
      (p_garage_id, 'Bay 1', 'bay', 1),
      (p_garage_id, 'Bay 2', 'bay', 2),
      (p_garage_id, 'Bay 3', 'bay', 3),
      (p_garage_id, 'Mobile van', 'mobile', 4);
    get diagnostics resources_added = row_count;
  end if;

  if not exists (select 1 from public.services service where service.garage_id = p_garage_id) then
    insert into public.services (
      garage_id, name, description, duration_min, buffer_min, price_pence, price_mode, location_mode, resource_kind,
      needs_approval, is_mot, sort
    ) values
      (p_garage_id, 'MOT', 'MOT test for cars and light vans (class 4).',
       60, 0, 5485, 'fixed', 'workshop', 'bay', false, true, 1),
      (p_garage_id, 'Diagnostics', 'Warning lights, running faults and electrical problems traced and explained.',
       60, 15, 4500, 'from', 'both', 'bay', false, false, 2),
      (p_garage_id, 'Full service', 'Annual service: oil and filters, fluids, brakes, steering and suspension checks.',
       180, 15, 17900, 'from', 'workshop', 'bay', false, false, 3),
      (p_garage_id, 'Interim service', 'Six-monthly oil and filter change with safety checks.',
       90, 15, 11900, 'from', 'workshop', 'bay', false, false, 4),
      (p_garage_id, 'Brakes', 'Pads, discs and brake fluid. We inspect first and quote before any work.',
       90, 15, null, 'quote', 'workshop', 'bay', true, false, 5),
      (p_garage_id, 'Something else', 'Tell us what is wrong and we will call you with a quote.',
       60, 0, null, 'quote', 'both', 'bay', true, false, 6);
    get diagnostics services_added = row_count;
  end if;

  -- TODO(P3.6): default reminder_rules (MOT {28,7}, service {335}, review {1}).

  return jsonb_build_object('opening_hours', hours_added, 'resources', resources_added, 'services', services_added);
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Functions that read bookings, rewritten for the new shape
-- ---------------------------------------------------------------------------

-- Security invoker on purpose: it runs as the service role and needs nothing
-- the service role cannot already do.
create or replace function public.create_booking_enquiry_thread(p_garage_id uuid, target_booking_id uuid, actor_id_value uuid)
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
    booking.reference,
    booking.customer_id,
    booking.vehicle_id,
    service.name as service_name,
    booking.symptoms,
    booking.notes,
    booking.postcode,
    booking.starts_at
  into selected_booking
  from public.bookings as booking
  join public.services as service
    on service.garage_id = booking.garage_id
   and service.id = booking.service_id
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
      'Booking ' || selected_booking.reference,
      'Service: ' || selected_booking.service_name,
      'Appointment: ' || to_char(selected_booking.starts_at at time zone garage_timezone, 'FMDay, FMDD FMMonth YYYY at HH24:MI') || ' (local time)',
      case
        when cardinality(selected_booking.symptoms) > 0
          then 'Symptoms: ' || array_to_string(selected_booking.symptoms, ', ')
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
        initial_message,
        selected_booking.postcode,
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
    left('Your ' || garage_name || ' booking ' || selected_booking.reference, 180)
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
        'bookingReference', selected_booking.reference
      )
    );
  end if;

  return selected_enquiry_id;
end
$$;

-- Closed enquiries older than 12 months lose their attachments, and customers
-- with no open or recent enquiry, booking or invoice are anonymised. The
-- phone is cleared (not 'REDACTED') so one number stays one customer per
-- garage.
create or replace function public.apply_enquiry_retention(p_garage_id uuid)
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
  set name = 'Anonymised', email = null, phone = null, anonymised_at = now()
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

-- Admin trash: enquiries, bookings, invoices and services (the Cal.com
-- service catalogue is gone). A live booking still holds its resource, so
-- only cancelled, no-show or collected bookings can be trashed; cancel a
-- booking to free its slot.
create or replace function public.manage_admin_trash(p_entity text, p_ids uuid[], p_action text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid;
  target_table text;
  trash_filter text := '';
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
    when 'services' then 'services'
    else null
  end;
  if target_table is null then raise exception 'INVALID_TRASH_ENTITY'; end if;
  if p_entity = 'bookings' then trash_filter := ' and status in (''cancelled'', ''no_show'', ''collected'')'; end if;

  if p_action = 'trash' then
    execute format('update public.%I set deleted_at = statement_timestamp(), deleted_by = $1 where garage_id = $3 and id = any($2) and deleted_at is null%s', target_table, trash_filter)
      using auth.uid(), p_ids, garage_scope;
    get diagnostics affected = row_count;
  elsif p_action = 'restore' then
    execute format('update public.%I set deleted_at = null, deleted_by = null where garage_id = $2 and id = any($1) and deleted_at is not null', target_table)
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
  elsif p_entity = 'services' then
    delete from public.services service
    where service.garage_id = garage_scope
      and service.id = any(p_ids)
      and service.deleted_at is not null
      and not exists (
        select 1 from public.bookings booking
        where booking.garage_id = service.garage_id and booking.service_id = service.id
      );
    get diagnostics affected = row_count;
  end if;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (garage_scope, auth.uid(), 'trash.' || p_action, p_entity, coalesce(p_ids[1]::text, 'bulk'), jsonb_build_object('ids', to_jsonb(p_ids), 'affected', affected));
  return affected;
end
$$;

-- Invoices from bookings snapshot the service name and appointment from the
-- new shape. A vehicle now has one row per registration and moves to its
-- latest customer, so a booking invoice no longer requires the vehicle's
-- current customer to be the booking's customer; the booking's own customer
-- and vehicle must still match the invoice.
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
      service.name,
      booking.starts_at
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
    join public.services service
      on service.garage_id = booking.garage_id
     and service.id = booking.service_id
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

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
-- anon gets nothing. Staff read every scheduling table; owners and managers
-- manage the setup tables through RLS; bookings are written by
-- create_booking() and server code, staff may change status, notes,
-- admin_seen_at and cancellation_reason; booking events are appended.

grant update (mobile_travel_min) on public.garages to authenticated;

grant select, insert, update, delete on
  public.resources,
  public.opening_hours,
  public.closures,
  public.services
to authenticated, service_role;

grant select on public.bookings to authenticated;
grant update (status, notes, admin_seen_at, cancellation_reason) on public.bookings to authenticated;
grant select, insert, update, delete on public.bookings to service_role;

grant select on public.booking_events to authenticated;
grant insert (garage_id, booking_id, type, actor, actor_id, data) on public.booking_events to authenticated;
grant select, insert, delete on public.booking_events to service_role;

revoke all on function public.available_slots(uuid, uuid, date, date, text) from public, anon, authenticated;
revoke all on function public.seed_garage_defaults(uuid) from public, anon, authenticated;
grant execute on function public.available_slots(uuid, uuid, date, date, text) to service_role;
grant execute on function public.seed_garage_defaults(uuid) to service_role;

-- Internals and trigger functions: owner only.
revoke all on function public.available_slots_at(uuid, uuid, date, date, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.opening_window_starts(uuid, date, date, integer) from public, anon, authenticated, service_role;
revoke all on function public.booking_service_context(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.maintain_booking_cancellation() from public, anon, authenticated, service_role;
revoke all on function public.log_booking_status_change() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. Row-level security
-- ---------------------------------------------------------------------------
-- "Selected garage" is public.current_garage_id() (DECISIONS.md A6). The
-- service role bypasses RLS and filters by garage itself.

alter table public.resources enable row level security;
alter table public.opening_hours enable row level security;
alter table public.closures enable row level security;
alter table public.services enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_events enable row level security;

-- resources
--   "garage members read resources"         select  members of the selected garage
--   "owners and managers add resources"     insert  owners/managers of the selected garage
--   "owners and managers change resources"  update  owners/managers of the selected garage
--   "owners and managers remove resources"  delete  owners/managers of the selected garage (a resource with bookings is deactivated instead)
create policy "garage members read resources" on public.resources
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add resources" on public.resources
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers change resources" on public.resources
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers remove resources" on public.resources
  for delete to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

-- opening_hours
--   "garage members read opening hours"         select  members of the selected garage
--   "owners and managers add opening hours"     insert  owners/managers of the selected garage
--   "owners and managers change opening hours"  update  owners/managers of the selected garage
--   "owners and managers remove opening hours"  delete  owners/managers of the selected garage
create policy "garage members read opening hours" on public.opening_hours
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add opening hours" on public.opening_hours
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers change opening hours" on public.opening_hours
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers remove opening hours" on public.opening_hours
  for delete to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

-- closures
--   "garage members read closures"         select  members of the selected garage
--   "owners and managers add closures"     insert  owners/managers of the selected garage
--   "owners and managers change closures"  update  owners/managers of the selected garage
--   "owners and managers remove closures"  delete  owners/managers of the selected garage
create policy "garage members read closures" on public.closures
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add closures" on public.closures
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers change closures" on public.closures
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers remove closures" on public.closures
  for delete to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

-- services
--   "garage members read services"         select  members of the selected garage
--   "owners and managers add services"     insert  owners/managers of the selected garage
--   "owners and managers change services"  update  owners/managers of the selected garage (trash with deleted_at)
--   "owners and managers remove services"  delete  owners/managers of the selected garage (a service with bookings cannot be deleted)
create policy "garage members read services" on public.services
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add services" on public.services
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers change services" on public.services
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers remove services" on public.services
  for delete to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

-- bookings
--   "garage members read bookings"    select  members of the selected garage
--   "garage members update bookings"  update  members of the selected garage (column grants: status, notes, admin_seen_at, cancellation_reason)
--   no insert/delete for staff: create_booking() and server code create bookings; permanent deletion only through manage_admin_trash()
create policy "garage members read bookings" on public.bookings
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members update bookings" on public.bookings
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()));

-- booking_events
--   "garage members read booking events"  select  members of the selected garage
--   "garage members add booking notes"    insert  members of the selected garage: type note, actor staff, as themselves
--   every other event is written by create_booking(), the status trigger and server code; no updates or deletes
create policy "garage members read booking events" on public.booking_events
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members add booking notes" on public.booking_events
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and type = 'note'
    and actor = 'staff'
    and actor_id = (select auth.uid())
  );
