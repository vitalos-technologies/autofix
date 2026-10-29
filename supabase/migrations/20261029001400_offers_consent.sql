-- Offers consent for campaigns (consent wording v1.0, approved by Temitope on
-- 29 Oct 2026, option A). Replaces DECISIONS A326: campaigns no longer go to
-- everyone with reminder consent.
--
--   1. customers: offers_consent (default false), offers_consent_at,
--      offers_consent_source ('booking'), offers_consent_text (the exact
--      wording shown) and offers_opted_out_at (the latest opt-out). Kept apart
--      from reminder consent (reminder_consent, consent_at, consent_source,
--      consent_text). offers_opted_out_at is backfilled from opted_out_at and
--      the audit log's customer.opted_out rows.
--   2. customers_offers_consent (before insert/update): an opt-out (STOP, the
--      unsubscribe link or form, staff) turns offers consent off and closes the
--      soft opt-in route for offers for good; "Turn reminders back on" and
--      START clear opted_out_at but never give offers consent back. Staff (the
--      authenticated role, through RLS) cannot write the offers columns at
--      all; only create_booking() and the opt-out above change them.
--   3. create_booking_at(): customer.offers_consent and
--      customer.offers_consent_text, only on the customer's own booking
--      (source online or reminder, no staff object), recorded with source
--      'booking'. Ticking it on a later booking turns it on; unticking never
--      turns it off. create_booking(uuid, jsonb) and create_booking_at(uuid,
--      jsonb, timestamptz) keep their signatures (the consent rides in the
--      jsonb), so no overload is added and create_booking() is unchanged.
--   4. campaign_consent_basis(): 'offers' (offers consent) or 'soft_opt_in'
--      (reminder consent with consent_source soft_opt_in and no opt-out
--      since), else null. campaign_audience() and claim_campaign_sends() gate
--      on it (with not opted out and not anonymised, as before) instead of
--      reminder_consent; campaign_sends_follow_customer() cancels scheduled
--      sends when it becomes null. campaign_audience() also returns the basis
--      and preview_campaign_audience() returns it with offers_total; their
--      result columns change, so both are dropped and re-created with the
--      same grants. schedule_campaign() is unchanged (it reads the audience by
--      column name).
--
-- Rollback notes (manual): drop trigger customers_offers_consent on
-- public.customers and its function; re-create create_booking_at() from
-- 20261028002200_staff_bookings.sql and campaign_audience(),
-- preview_campaign_audience() (drop first: result columns), claim_campaign_sends(),
-- campaign_sends_follow_customer() and the customers_cancel_campaign_sends
-- trigger from 20261029000500_campaigns.sql; drop function
-- public.campaign_consent_basis(boolean, boolean, text, timestamptz); drop the
-- five offers columns (the offers consent records are lost).

-- ---------------------------------------------------------------------------
-- 1. Offers consent on customers
-- ---------------------------------------------------------------------------

alter table public.customers
  add column offers_consent boolean not null default false,
  add column offers_consent_at timestamptz,
  add column offers_consent_source text,
  add column offers_consent_text text,
  add column offers_opted_out_at timestamptz,
  add constraint customers_offers_consent_source_check
    check (offers_consent_source is null or offers_consent_source in ('booking')),
  add constraint customers_offers_consent_check
    check (not offers_consent or (offers_consent_at is not null and offers_consent_source is not null and offers_consent_text is not null)),
  add constraint customers_offers_consent_text_check
    check (offers_consent_text is null or (offers_consent_at is not null and char_length(offers_consent_text) between 1 and 2000));

comment on column public.customers.offers_consent is
  'Stored consent to offers (campaigns), apart from reminder_consent. Given only by ticking the offers box on the booking page; an opt-out turns it off. Sending also requires opted_out_at is null.';
comment on column public.customers.offers_consent_text is
  'The exact offers wording the customer ticked (PECR record), stored with offers_consent_at and offers_consent_source.';
comment on column public.customers.offers_opted_out_at is
  'The latest opt-out (STOP, unsubscribe, staff). Once set, the soft opt-in route no longer covers offers; only a fresh offers tick on a booking does.';

-- Customers who opted out before today, including those whose opt-out was
-- since cleared (START or "Turn reminders back on"), lose the soft opt-in
-- route for offers.
update public.customers customer
set offers_opted_out_at = coalesce(customer.opted_out_at, opted_out.latest)
from (
  select candidate.id, (
    select max(entry.created_at)
    from public.admin_audit_log entry
    where entry.garage_id = candidate.garage_id
      and entry.action = 'customer.opted_out'
      and entry.entity_type = 'customer'
      and entry.entity_id = candidate.id::text
  ) as latest
  from public.customers candidate
) opted_out
where opted_out.id = customer.id
  and (customer.opted_out_at is not null or opted_out.latest is not null);

-- ---------------------------------------------------------------------------
-- 2. Opt-outs end offers consent; staff never write it
-- ---------------------------------------------------------------------------

-- Not security definer: current_user is the caller. Staff reach customers as
-- `authenticated` (RLS); create_booking_at(), opt_out_customer() and the other
-- definer functions run as their owner, and the server as service_role.
create function public.customers_offers_consent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.offers_consent or new.offers_consent_at is not null or new.offers_consent_source is not null
         or new.offers_consent_text is not null or new.offers_opted_out_at is not null then
        raise exception 'OFFERS_CONSENT_LOCKED: offers consent is given only by the customer when booking' using errcode = '42501';
      end if;
    elsif (new.offers_consent, new.offers_consent_at, new.offers_consent_source, new.offers_consent_text, new.offers_opted_out_at)
          is distinct from (old.offers_consent, old.offers_consent_at, old.offers_consent_source, old.offers_consent_text, old.offers_opted_out_at) then
      raise exception 'OFFERS_CONSENT_LOCKED: offers consent is given only by the customer when booking' using errcode = '42501';
    end if;
  end if;

  if new.opted_out_at is not null and (tg_op = 'INSERT' or old.opted_out_at is null) then
    new.offers_consent := false;
    new.offers_opted_out_at := new.opted_out_at;
  end if;
  return new;
end
$$;

comment on function public.customers_offers_consent() is
  'Trigger: an opt-out turns offers consent off and closes the soft opt-in route for offers; staff (authenticated) cannot write the offers columns.';

create trigger customers_offers_consent
  before insert or update of opted_out_at, offers_consent, offers_consent_at, offers_consent_source, offers_consent_text, offers_opted_out_at
  on public.customers
  for each row execute function public.customers_offers_consent();

-- ---------------------------------------------------------------------------
-- 3. create_booking_at with offers consent
-- ---------------------------------------------------------------------------

create or replace function public.create_booking_at(p_garage_id uuid, p_booking jsonb, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  idempotency uuid;
  existing public.bookings%rowtype;
  context record;
  service_id uuid;
  visit_mode text;
  booking_source text;
  staff_input jsonb;
  staff_member uuid;
  staff_rules boolean := false;
  staff_override boolean := false;
  local_today date;
  booking_status text;
  starts_text text;
  booking_starts timestamptz;
  booking_ends timestamptz;
  booking_during tstzrange;
  local_day date;
  local_day_range tstzrange;
  customer_input jsonb;
  vehicle_input jsonb;
  customer_name text;
  customer_phone text;
  customer_email text;
  customer_channel text;
  consent_given boolean;
  consent_from text;
  consent_wording text;
  offers_given boolean;
  offers_wording text;
  vehicle_registration text;
  vehicle_make text;
  vehicle_model text;
  vehicle_colour text;
  vehicle_fuel text;
  vehicle_year integer;
  vehicle_mot_expiry date;
  vehicle_mileage integer;
  mot_text text;
  booking_postcode text;
  compact_postcode text;
  booking_address text;
  booking_notes text;
  booking_symptoms text[] := '{}'::text[];
  manage_hash text;
  reminder_send uuid;
  reminder_vehicle uuid;
  reminder_customer uuid;
  stored_source text;
  matched_customer uuid;
  matched_vehicle uuid;
  tried uuid[] := '{}'::uuid[];
  chosen_resource uuid;
  created public.bookings%rowtype;
begin
  if p_garage_id is null or p_now is null then
    raise exception 'INVALID_BOOKING: garage is required' using errcode = 'P0001';
  end if;
  if p_booking is null or jsonb_typeof(p_booking) <> 'object' then
    raise exception 'INVALID_BOOKING: the booking must be a JSON object' using errcode = 'P0001';
  end if;

  -- 1. Idempotency
  idempotency := public.booking_input_uuid(p_booking->'idempotency_key', 'idempotency_key');
  if idempotency is not null then
    perform pg_advisory_xact_lock(hashtextextended('public.create_booking:' || p_garage_id::text || ':' || idempotency::text, 0));
    select booking.* into existing
    from public.bookings booking
    where booking.garage_id = p_garage_id
      and booking.idempotency_key = idempotency;
    if found then
      return public.booking_result(existing, true);
    end if;
  end if;

  -- 2. Validation
  service_id := public.booking_input_uuid(p_booking->'service_id', 'service_id');
  if service_id is null then
    raise exception 'INVALID_BOOKING: service_id is required' using errcode = 'P0001';
  end if;
  visit_mode := public.booking_input_text(p_booking->'location_mode', 'location_mode', 20);
  if visit_mode is not null and visit_mode not in ('workshop', 'mobile') then
    raise exception 'INVALID_BOOKING: location_mode must be workshop or mobile' using errcode = 'P0001';
  end if;
  booking_source := coalesce(public.booking_input_text(p_booking->'source', 'source', 20), 'online');
  if booking_source not in ('online', 'phone', 'walk_in', 'reminder', 'missed_call', 'ai_agent') then
    raise exception 'INVALID_BOOKING: unknown source' using errcode = 'P0001';
  end if;

  -- Staff bookings (P4 follow-up A90): a phone or walk-in booking made by a
  -- member of this garage, whose user id the server read from their verified
  -- admin session. Only the service role can call this function, so the
  -- object never comes from a customer; the membership check ties it to this
  -- garage.
  staff_input := p_booking->'staff';
  if staff_input is not null and jsonb_typeof(staff_input) <> 'null' then
    if jsonb_typeof(staff_input) <> 'object' then
      raise exception 'INVALID_BOOKING: staff must be an object' using errcode = 'P0001';
    end if;
    staff_member := public.booking_input_uuid(staff_input->'member_id', 'staff.member_id');
    if staff_member is null then
      raise exception 'INVALID_BOOKING: staff.member_id is required' using errcode = 'P0001';
    end if;
    if staff_input->'override_hours' is not null and jsonb_typeof(staff_input->'override_hours') not in ('boolean', 'null') then
      raise exception 'INVALID_BOOKING: staff.override_hours must be true or false' using errcode = 'P0001';
    end if;
    staff_override := coalesce((staff_input->>'override_hours')::boolean, false);
    if booking_source not in ('phone', 'walk_in') then
      raise exception 'INVALID_BOOKING: staff bookings are phone or walk-in bookings' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.garage_members member
      where member.garage_id = p_garage_id
        and member.user_id = staff_member
        and member.role in ('owner', 'manager', 'technician', 'front_desk')
    ) then
      raise exception 'INVALID_BOOKING: staff.member_id is not a member of this garage' using errcode = 'P0001';
    end if;
    staff_rules := true;
  end if;

  starts_text := public.booking_input_text(p_booking->'starts_at', 'starts_at', 40);
  if starts_text is null then
    raise exception 'INVALID_BOOKING: starts_at is required' using errcode = 'P0001';
  end if;
  if starts_text !~* '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    raise exception 'INVALID_BOOKING: starts_at must be an ISO 8601 timestamp with a UTC offset' using errcode = 'P0001';
  end if;
  begin
    booking_starts := starts_text::timestamptz;
  exception
    when others then
      raise exception 'INVALID_BOOKING: starts_at is not a valid timestamp' using errcode = 'P0001';
  end;

  customer_input := p_booking->'customer';
  if customer_input is null or jsonb_typeof(customer_input) <> 'object' then
    raise exception 'INVALID_BOOKING: customer is required' using errcode = 'P0001';
  end if;
  customer_name := public.booking_input_text(customer_input->'name', 'customer.name', 120);
  if customer_name is null or char_length(customer_name) < 2 then
    raise exception 'INVALID_BOOKING: customer.name is required' using errcode = 'P0001';
  end if;
  customer_phone := public.booking_input_text(customer_input->'phone', 'customer.phone', 16);
  if customer_phone is null or customer_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'INVALID_BOOKING: customer.phone must be E.164' using errcode = 'P0001';
  end if;
  customer_email := lower(public.booking_input_text(customer_input->'email', 'customer.email', 254));
  if customer_email is not null and customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'INVALID_BOOKING: customer.email is not an email address' using errcode = 'P0001';
  end if;
  customer_channel := public.booking_input_text(customer_input->'channel', 'customer.channel', 10);
  if customer_channel is not null and customer_channel not in ('sms', 'whatsapp', 'email') then
    raise exception 'INVALID_BOOKING: customer.channel must be sms, whatsapp or email' using errcode = 'P0001';
  end if;
  if customer_channel = 'email' and customer_email is null then
    raise exception 'INVALID_BOOKING: customer.email is required for the email channel' using errcode = 'P0001';
  end if;
  if customer_input->'reminder_consent' is not null and jsonb_typeof(customer_input->'reminder_consent') <> 'null' then
    if jsonb_typeof(customer_input->'reminder_consent') <> 'boolean' then
      raise exception 'INVALID_BOOKING: customer.reminder_consent must be true or false' using errcode = 'P0001';
    end if;
    consent_given := (customer_input->>'reminder_consent')::boolean;
  end if;
  consent_from := coalesce(public.booking_input_text(customer_input->'consent_source', 'customer.consent_source', 20), 'booking');
  if consent_from not in ('booking', 'import', 'soft_opt_in', 'staff') then
    raise exception 'INVALID_BOOKING: unknown customer.consent_source' using errcode = 'P0001';
  end if;
  consent_wording := public.booking_input_text(customer_input->'consent_text', 'customer.consent_text', 2000);
  -- Offers consent (consent wording v1.0): its own unticked box on the booking
  -- page, apart from reminders. Only the customer gives it, on their own
  -- booking (online, or online from a reminder link): never staff, never the
  -- AI front desk. The exact wording shown is required with it.
  if customer_input->'offers_consent' is not null and jsonb_typeof(customer_input->'offers_consent') <> 'null' then
    if jsonb_typeof(customer_input->'offers_consent') <> 'boolean' then
      raise exception 'INVALID_BOOKING: customer.offers_consent must be true or false' using errcode = 'P0001';
    end if;
    offers_given := (customer_input->>'offers_consent')::boolean;
  end if;
  offers_wording := public.booking_input_text(customer_input->'offers_consent_text', 'customer.offers_consent_text', 2000);
  if offers_given then
    if staff_rules or booking_source not in ('online', 'reminder') then
      raise exception 'INVALID_BOOKING: offers consent is given only by the customer on the booking page' using errcode = 'P0001';
    end if;
    if offers_wording is null then
      raise exception 'INVALID_BOOKING: customer.offers_consent_text is required with offers consent' using errcode = 'P0001';
    end if;
  end if;

  vehicle_input := p_booking->'vehicle';
  if vehicle_input is null or jsonb_typeof(vehicle_input) <> 'object' then
    raise exception 'INVALID_BOOKING: vehicle is required' using errcode = 'P0001';
  end if;
  vehicle_registration := upper(regexp_replace(
    coalesce(public.booking_input_text(vehicle_input->'registration', 'vehicle.registration', 20), ''), '[^A-Za-z0-9]', '', 'g'));
  if vehicle_registration !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'INVALID_BOOKING: vehicle.registration is not a registration' using errcode = 'P0001';
  end if;
  vehicle_make := public.booking_input_text(vehicle_input->'make', 'vehicle.make', 80);
  vehicle_model := public.booking_input_text(vehicle_input->'model', 'vehicle.model', 120);
  vehicle_colour := public.booking_input_text(vehicle_input->'colour', 'vehicle.colour', 50);
  vehicle_fuel := public.booking_input_text(vehicle_input->'fuel', 'vehicle.fuel', 50);
  if vehicle_input->'year' is not null and jsonb_typeof(vehicle_input->'year') <> 'null' then
    if jsonb_typeof(vehicle_input->'year') <> 'number'
       or (vehicle_input->>'year')::numeric <> trunc((vehicle_input->>'year')::numeric)
       or (vehicle_input->>'year')::numeric not between 1900 and 2100 then
      raise exception 'INVALID_BOOKING: vehicle.year must be a year' using errcode = 'P0001';
    end if;
    vehicle_year := (vehicle_input->>'year')::integer;
  end if;
  mot_text := public.booking_input_text(vehicle_input->'mot_expiry', 'vehicle.mot_expiry', 10);
  if mot_text is not null then
    if mot_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'INVALID_BOOKING: vehicle.mot_expiry must be a date (YYYY-MM-DD)' using errcode = 'P0001';
    end if;
    begin
      vehicle_mot_expiry := mot_text::date;
    exception
      when others then
        raise exception 'INVALID_BOOKING: vehicle.mot_expiry must be a date (YYYY-MM-DD)' using errcode = 'P0001';
    end;
  end if;
  if vehicle_input->'last_mileage' is not null and jsonb_typeof(vehicle_input->'last_mileage') <> 'null' then
    if jsonb_typeof(vehicle_input->'last_mileage') <> 'number'
       or (vehicle_input->>'last_mileage')::numeric <> trunc((vehicle_input->>'last_mileage')::numeric)
       or (vehicle_input->>'last_mileage')::numeric not between 0 and 2000000 then
      raise exception 'INVALID_BOOKING: vehicle.last_mileage must be a whole number of miles' using errcode = 'P0001';
    end if;
    vehicle_mileage := (vehicle_input->>'last_mileage')::integer;
  end if;

  booking_postcode := public.booking_input_text(p_booking->'postcode', 'postcode', 10);
  if booking_postcode is not null then
    compact_postcode := upper(regexp_replace(booking_postcode, '[[:space:]]', '', 'g'));
    if compact_postcode !~ '^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$' then
      raise exception 'INVALID_BOOKING: postcode is not a UK postcode' using errcode = 'P0001';
    end if;
    booking_postcode := left(compact_postcode, -3) || ' ' || right(compact_postcode, 3);
  end if;
  booking_address := public.booking_input_text(p_booking->'address', 'address', 300);
  booking_notes := public.booking_input_text(p_booking->'notes', 'notes', 2000);
  if p_booking->'symptoms' is not null and jsonb_typeof(p_booking->'symptoms') <> 'null' then
    if jsonb_typeof(p_booking->'symptoms') <> 'array' or jsonb_array_length(p_booking->'symptoms') > 10 then
      raise exception 'INVALID_BOOKING: symptoms must be a list of at most 10' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_booking->'symptoms') symptom
      where jsonb_typeof(symptom) <> 'string' or char_length(btrim(symptom #>> '{}')) not between 1 and 80
    ) then
      raise exception 'INVALID_BOOKING: each symptom must be 1-80 characters' using errcode = 'P0001';
    end if;
    booking_symptoms := array(
      select btrim(symptom.value #>> '{}')
      from jsonb_array_elements(p_booking->'symptoms') with ordinality symptom(value, position)
      order by symptom.position
    );
  end if;
  manage_hash := public.booking_input_text(p_booking->'manage_token_hash', 'manage_token_hash', 64);
  if manage_hash is not null and manage_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_BOOKING: manage_token_hash must be 64 hex characters' using errcode = 'P0001';
  end if;

  -- The reminder this booking may be credited to (checked against the
  -- customer and vehicle once they are matched below).
  reminder_send := public.booking_input_uuid(p_booking->'reminder_send_id', 'reminder_send_id');
  if reminder_send is not null then
    select send.vehicle_id, send.customer_id
    into reminder_vehicle, reminder_customer
    from public.reminder_sends send
    where send.garage_id = p_garage_id
      and send.id = reminder_send
      and send.status in ('sending', 'sent', 'delivered', 'failed');
    if not found then
      reminder_send := null;
    end if;
  end if;

  -- The service, in this garage, bookable online in this mode.
  -- Staff may also book services that are not offered online.
  select * into context from public.booking_service_context(p_garage_id, service_id, visit_mode, staff_rules);
  visit_mode := context.location_mode;

  if visit_mode = 'mobile' then
    if booking_postcode is null then
      raise exception 'INVALID_BOOKING: postcode is required for mobile visits' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from unnest(context.service_area) area
      where upper(btrim(area)) = split_part(booking_postcode, ' ', 1)
    ) then
      raise exception 'OUTSIDE_SERVICE_AREA' using errcode = 'P0001';
    end if;
  end if;

  -- The start must be one the garage offers. Staff who explicitly override
  -- the hours may book any whole minute (closures included); nobody else.
  local_day := (booking_starts at time zone context.timezone)::date;
  local_today := (p_now at time zone context.timezone)::date;
  if staff_override then
    if date_trunc('minute', booking_starts) <> booking_starts then
      raise exception 'INVALID_BOOKING: starts_at must be a whole minute' using errcode = 'P0001';
    end if;
  elsif not exists (
    select 1
    from public.opening_window_starts(p_garage_id, local_day, local_day, context.duration_min) window_start
    where window_start.starts_at = booking_starts
  ) then
    raise exception 'INVALID_BOOKING: starts_at is not a bookable time for this service' using errcode = 'P0001';
  end if;
  if (not staff_override and exists (
    select 1 from public.closures closure
    where closure.garage_id = p_garage_id
      and local_day between closure.starts_on and closure.ends_on
  ))
  -- Online: the service's notice and booking window. Staff: any time from
  -- the start of today (a walk-in "now") up to two years ahead.
  or (not staff_rules and booking_starts < p_now + make_interval(hours => context.min_notice_h))
  or (not staff_rules and booking_starts > p_now + make_interval(hours => context.max_days_ahead * 24))
  or (staff_rules and local_day < local_today)
  or (staff_rules and booking_starts > p_now + interval '730 days') then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- 3. Customer and vehicle
  insert into public.customers as customer (
    garage_id, name, phone, email, preferred_contact, channel, reminder_consent, consent_at, consent_source, consent_text,
    offers_consent, offers_consent_at, offers_consent_source, offers_consent_text
  )
  values (
    p_garage_id,
    customer_name,
    customer_phone,
    customer_email,
    case coalesce(customer_channel, 'sms') when 'sms' then 'phone' else coalesce(customer_channel, 'sms') end,
    coalesce(customer_channel, 'sms'),
    coalesce(consent_given, false),
    case when consent_given then p_now end,
    case when consent_given then consent_from end,
    case when consent_given then consent_wording end,
    coalesce(offers_given, false),
    case when offers_given then p_now end,
    case when offers_given then 'booking' end,
    case when offers_given then offers_wording end
  )
  on conflict (garage_id, phone) do update
  set name = excluded.name,
      email = coalesce(excluded.email, customer.email),
      channel = case when customer_channel is null then customer.channel else excluded.channel end,
      preferred_contact = case when customer_channel is null then customer.preferred_contact else excluded.preferred_contact end,
      reminder_consent = customer.reminder_consent or coalesce(consent_given, false),
      consent_at = case when not customer.reminder_consent and consent_given then p_now else customer.consent_at end,
      consent_source = case when not customer.reminder_consent and consent_given then consent_from else customer.consent_source end,
      consent_text = case when not customer.reminder_consent and consent_given then consent_wording else customer.consent_text end,
      -- Ticking offers on a later booking turns them on (with that booking's
      -- time and wording); unticking never turns them off: opting out does.
      offers_consent = customer.offers_consent or coalesce(offers_given, false),
      offers_consent_at = case when not customer.offers_consent and offers_given then p_now else customer.offers_consent_at end,
      offers_consent_source = case when not customer.offers_consent and offers_given then 'booking' else customer.offers_consent_source end,
      offers_consent_text = case when not customer.offers_consent and offers_given then offers_wording else customer.offers_consent_text end
  returning customer.id into matched_customer;

  insert into public.vehicles as vehicle (
    garage_id, customer_id, registration, make, model, colour, fuel, year, mot_expiry, mot_checked_at, last_mileage
  )
  values (
    p_garage_id,
    matched_customer,
    vehicle_registration,
    vehicle_make,
    vehicle_model,
    vehicle_colour,
    vehicle_fuel,
    vehicle_year,
    vehicle_mot_expiry,
    case when vehicle_mot_expiry is not null then p_now end,
    vehicle_mileage
  )
  on conflict (garage_id, registration) do update
  set customer_id = excluded.customer_id,
      make = coalesce(excluded.make, vehicle.make),
      model = coalesce(excluded.model, vehicle.model),
      colour = coalesce(excluded.colour, vehicle.colour),
      fuel = coalesce(excluded.fuel, vehicle.fuel),
      year = coalesce(excluded.year, vehicle.year),
      mot_expiry = coalesce(excluded.mot_expiry, vehicle.mot_expiry),
      mot_checked_at = coalesce(excluded.mot_checked_at, vehicle.mot_checked_at),
      last_mileage = greatest(excluded.last_mileage, vehicle.last_mileage)
  returning vehicle.id into matched_vehicle;

  if reminder_send is not null
     and (reminder_vehicle is distinct from matched_vehicle or reminder_customer is distinct from matched_customer) then
    reminder_send := null;
  end if;
  stored_source := case
    when reminder_send is not null then 'reminder'
    when booking_source = 'reminder' then 'online'
    else booking_source
  end;

  -- 4. Resource. Bookings for one garage are allocated one at a time; the
  -- exclusion constraint still guards every other writer.
  perform pg_advisory_xact_lock(hashtextextended('public.create_booking:' || p_garage_id::text, 0));

  booking_ends := booking_starts + make_interval(mins => context.duration_min);
  booking_during := tstzrange(
    booking_starts - make_interval(mins => context.travel_min),
    booking_ends + make_interval(mins => context.buffer_min + context.travel_min),
    '[)'
  );
  local_day_range := tstzrange(
    local_day::timestamp at time zone context.timezone,
    (local_day + 1)::timestamp at time zone context.timezone,
    '[)'
  );
  booking_status := case
    -- Staff booked it with the customer: nothing left to approve.
    when staff_rules then 'confirmed'
    when context.needs_approval or context.approve_online or booking_source = 'ai_agent' then 'requested'
    else 'confirmed'
  end;

  loop
    select resource.id
    into chosen_resource
    from public.resources resource
    where resource.garage_id = p_garage_id
      and resource.active
      and resource.kind = context.resource_kind
      and resource.id <> all(tried)
      and not exists (
        select 1
        from public.bookings booking
        where booking.garage_id = p_garage_id
          and booking.resource_id = resource.id
          and booking.status not in ('cancelled', 'no_show')
          and booking.during && booking_during
      )
    order by
      (
        select coalesce(sum(extract(epoch from upper(booking.during * local_day_range) - lower(booking.during * local_day_range))), 0)
        from public.bookings booking
        where booking.garage_id = p_garage_id
          and booking.resource_id = resource.id
          and booking.status not in ('cancelled', 'no_show')
          and booking.during && local_day_range
      ),
      resource.sort,
      resource.id
    limit 1;

    if chosen_resource is null then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    begin
      insert into public.bookings (
        garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during,
        status, source, location_mode, postcode, address, symptoms, notes,
        idempotency_key, manage_token_hash, reminder_send_id, price_pence
      )
      values (
        p_garage_id, matched_customer, matched_vehicle, service_id, chosen_resource, booking_starts, booking_ends, booking_during,
        booking_status, stored_source, visit_mode, booking_postcode, booking_address, booking_symptoms, booking_notes,
        idempotency, manage_hash, reminder_send, context.price_pence
      )
      returning * into created;
      exit;
    exception
      when exclusion_violation then
        tried := tried || chosen_resource;
        chosen_resource := null;
    end;
  end loop;

  if reminder_send is not null then
    update public.reminder_sends send
    set booking_id = created.id
    where send.garage_id = p_garage_id
      and send.id = reminder_send;
  end if;

  -- 5. Timeline
  insert into public.booking_events (garage_id, booking_id, type, actor, actor_id, data)
  values (
    p_garage_id,
    created.id,
    'created',
    case booking_source
      when 'ai_agent' then 'agent'
      when 'phone' then 'staff'
      when 'walk_in' then 'staff'
      else 'customer'
    end,
    staff_member,
    jsonb_strip_nulls(jsonb_build_object(
      'staff_rules', case when staff_rules then true end,
      'hours_override', case when staff_override then true end,
      'source', stored_source,
      'status', booking_status,
      'service_id', service_id,
      'resource_id', created.resource_id,
      'location_mode', visit_mode,
      'starts_at', booking_starts,
      'reminder_send_id', reminder_send
    ))
  );

  return public.booking_result(created, false);
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The campaign audience rule
-- ---------------------------------------------------------------------------

-- Why a campaign may go to a customer, or null: 'offers' when they ticked the
-- offers box; 'soft_opt_in' when their reminder consent is the soft opt-in
-- route (offers for the garage's own similar services) and they have not
-- opted out since. Callers also require opted_out_at is null and
-- anonymised_at is null. Mirrored by campaignConsentBasis() in
-- src/lib/consent/offers.ts.
create function public.campaign_consent_basis(
  p_offers_consent boolean,
  p_reminder_consent boolean,
  p_consent_source text,
  p_offers_opted_out_at timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_offers_consent, false) then 'offers'
    when coalesce(p_reminder_consent, false) and p_consent_source = 'soft_opt_in' and p_offers_opted_out_at is null then 'soft_opt_in'
  end
$$;

comment on function public.campaign_consent_basis(boolean, boolean, text, timestamptz) is
  'Campaign consent: offers (ticked the offers box) or soft_opt_in (reminder consent by soft opt-in, never opted out since); null otherwise.';

drop function public.preview_campaign_audience(jsonb, integer);
drop function public.campaign_audience(uuid, jsonb, timestamptz);

-- As 20261029000500_campaigns.sql, with consent = campaign_consent_basis()
-- (offers consent or soft opt-in) instead of reminder_consent, and the basis
-- returned for each customer.
create function public.campaign_audience(p_garage_id uuid, p_segment jsonb, p_now timestamptz)
returns table (
  customer_id uuid,
  customer_name text,
  phone text,
  email text,
  channel text,
  vehicle_id uuid,
  registration text,
  make text,
  model text,
  last_visit timestamptz,
  consent_basis text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  problem text := public.campaign_segment_problem(p_segment);
  garage_zone text;
  garage_mot boolean;
  age_min integer;
  age_max integer;
  months integer[];
  not_seen integer;
  history_service uuid;
  history text;
  wanted_channels text[];
  local_year integer;
begin
  if problem is not null then
    raise exception 'INVALID_SEGMENT: %', problem using errcode = '22023';
  end if;
  select garage.timezone, garage.mot_enabled into garage_zone, garage_mot
  from public.garages garage where garage.id = p_garage_id;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  age_min := (p_segment ->> 'car_age_min')::integer;
  age_max := (p_segment ->> 'car_age_max')::integer;
  not_seen := (p_segment ->> 'not_seen_months')::integer;
  history_service := (p_segment ->> 'service_id')::uuid;
  history := p_segment ->> 'service_history';
  if jsonb_typeof(p_segment -> 'mot_months') = 'array' and jsonb_array_length(p_segment -> 'mot_months') > 0 then
    months := array(select element::integer from jsonb_array_elements_text(p_segment -> 'mot_months') element);
  end if;
  if jsonb_typeof(p_segment -> 'channels') = 'array' then
    wanted_channels := array(select element from jsonb_array_elements_text(p_segment -> 'channels') element);
  end if;
  if months is not null and not garage_mot then
    raise exception 'MOT_DISABLED: MOT months need MOTs switched on' using errcode = 'P0001';
  end if;
  local_year := extract(year from (p_now at time zone garage_zone))::integer;

  return query
  with eligible as (
    select customer.id, customer.name, customer.phone, customer.email, customer.channel,
           public.campaign_consent_basis(customer.offers_consent, customer.reminder_consent, customer.consent_source, customer.offers_opted_out_at) as basis
    from public.customers customer
    where customer.garage_id = p_garage_id
      and customer.anonymised_at is null
      and customer.opted_out_at is null
      and public.campaign_consent_basis(customer.offers_consent, customer.reminder_consent, customer.consent_source, customer.offers_opted_out_at) is not null
      and case when customer.channel = 'email' then customer.email is not null else customer.phone is not null end
      and (wanted_channels is null or customer.channel = any (wanted_channels))
  ),
  visited as (
    select
      eligible.*,
      greatest(
        (
          select max(booking.starts_at)
          from public.bookings booking
          where booking.garage_id = p_garage_id
            and booking.customer_id = eligible.id
            and booking.status in ('confirmed', 'arrived', 'in_progress', 'waiting_parts', 'ready', 'collected')
            and booking.deleted_at is null
            and booking.starts_at <= p_now
        ),
        (
          select max(vehicle.last_service_at)
          from public.vehicles vehicle
          where vehicle.garage_id = p_garage_id
            and vehicle.customer_id = eligible.id
            and vehicle.last_service_at <= p_now
        )
      ) as last_seen
    from eligible
  )
  select
    visited.id, visited.name, visited.phone, visited.email, visited.channel,
    car.id, car.registration, car.make, car.model,
    visited.last_seen,
    visited.basis
  from visited
  cross join lateral (
    select vehicle.id, vehicle.registration, vehicle.make, vehicle.model
    from public.vehicles vehicle
    where vehicle.garage_id = p_garage_id
      and vehicle.customer_id = visited.id
      and vehicle.registration is not null
      and (age_min is null or (vehicle.year is not null and local_year - vehicle.year >= age_min))
      and (age_max is null or (vehicle.year is not null and local_year - vehicle.year <= age_max))
      and (months is null or (vehicle.mot_expiry is not null and extract(month from vehicle.mot_expiry)::integer = any (months)))
    order by (
      select max(booking.starts_at) from public.bookings booking
      where booking.garage_id = p_garage_id and booking.vehicle_id = vehicle.id and booking.deleted_at is null
    ) desc nulls last, vehicle.created_at desc, vehicle.id
    limit 1
  ) car
  where (
      not_seen is null
      or (
        (visited.last_seen is null or visited.last_seen < p_now - make_interval(months => not_seen))
        and not exists (
          select 1 from public.bookings booking
          where booking.garage_id = p_garage_id
            and booking.customer_id = visited.id
            and booking.status in ('requested', 'confirmed')
            and booking.deleted_at is null
            and booking.starts_at > p_now
        )
      )
    )
    and (
      history is null
      or (history = 'had') = exists (
        select 1 from public.bookings booking
        where booking.garage_id = p_garage_id
          and booking.customer_id = visited.id
          and booking.service_id = history_service
          and booking.status in ('confirmed', 'arrived', 'in_progress', 'waiting_parts', 'ready', 'collected')
          and booking.deleted_at is null
          and booking.starts_at <= p_now
      )
    )
  order by visited.name, visited.id;
end
$$;

comment on function public.campaign_audience(uuid, jsonb, timestamptz) is
  'P5.5 internal: customers (offers consent or soft opt-in, not opted out, not anonymised, with a car) a campaign segment matches, with the consent basis. Called by preview_campaign_audience() and schedule_campaign().';

-- As before, plus offers_total (how many of the total ticked the offers box;
-- the rest are soft opt-in) and each row's consent_basis.
create function public.preview_campaign_audience(p_segment jsonb, p_limit integer default 20)
returns table (
  total integer,
  offers_total integer,
  customer_id uuid,
  customer_name text,
  phone text,
  email text,
  channel text,
  vehicle_id uuid,
  registration text,
  make text,
  model text,
  last_visit timestamptz,
  consent_basis text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  target_garage uuid := public.current_garage_id();
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'CAMPAIGN_FORBIDDEN: owners and managers only' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'campaigns');

  return query
  with audience as (
    select * from public.campaign_audience(target_garage, p_segment, now())
  ),
  counted as (
    select count(*)::integer as n, (count(*) filter (where audience.consent_basis = 'offers'))::integer as offers from audience
  )
  select counted.n, counted.offers, shown.customer_id, shown.customer_name, shown.phone, shown.email, shown.channel,
         shown.vehicle_id, shown.registration, shown.make, shown.model, shown.last_visit,
         shown.consent_basis
  from counted
  left join lateral (
    select * from audience
    order by audience.customer_name, audience.customer_id
    limit least(greatest(coalesce(p_limit, 20), 0), 50)
  ) shown on true;
end
$$;

comment on function public.preview_campaign_audience(jsonb, integer) is
  'P5.5: owners/managers of the selected garage (Pro): live count (and how many by offers consent) and preview of a campaign segment.';

-- Consent is re-checked at claim time with the same rule.
create or replace function public.claim_campaign_sends(p_garage_id uuid, p_now timestamptz, p_limit integer)
returns table (
  id uuid,
  campaign_id uuid,
  channel text,
  send_at timestamptz,
  template text,
  email_subject text,
  email_template text,
  service_id uuid,
  customer_id uuid,
  customer_name text,
  phone text,
  email text,
  vehicle_id uuid,
  registration text,
  make text,
  model text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  garage_mot boolean;
  garage_status text;
  wanted integer;
  claimed integer := 0;
  batch_claimed integer;
  batch uuid[];
begin
  if p_garage_id is null or p_now is null then
    raise exception 'INVALID_ARGUMENT: garage and clock are required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'INVALID_ARGUMENT: limit must be at least 1' using errcode = '22023';
  end if;
  select garage.mot_enabled, garage.status into garage_mot, garage_status
  from public.garages garage where garage.id = p_garage_id;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if garage_status not in ('onboarding', 'active') then
    return;
  end if;

  -- The plan, as garage_has_feature() decides it for the service role.
  if public.garage_effective_plan(p_garage_id) is distinct from public.plan_feature_plan('campaigns') then
    update public.campaign_sends send
    set status = 'skipped', skip_reason = 'plan_required', claimed_at = p_now
    where send.garage_id = p_garage_id and send.status = 'scheduled' and send.send_at <= p_now;
  else
    wanted := least(p_limit, 200);
    loop
      exit when claimed >= wanted;

      select array_agg(due.id)
      into batch
      from (
        select send.id
        from public.campaign_sends send
        where send.garage_id = p_garage_id
          and send.status = 'scheduled'
          and send.send_at <= p_now
        order by send.send_at, send.id
        limit wanted - claimed
        for update skip locked
      ) due;
      exit when batch is null;

      return query
      with verdict as (
        select
          send.id as send_id,
          customer.channel as route_channel,
          checked.reason
        from public.campaign_sends send
        join public.campaigns campaign on campaign.garage_id = send.garage_id and campaign.id = send.campaign_id
        join public.customers customer on customer.garage_id = send.garage_id and customer.id = send.customer_id
        join public.vehicles vehicle on vehicle.garage_id = send.garage_id and vehicle.id = send.vehicle_id
        cross join lateral (
          select case
            when campaign.status = 'cancelled' then 'campaign_cancelled'
            when customer.anonymised_at is not null then 'anonymised'
            when customer.opted_out_at is not null then 'opted_out'
            when public.campaign_consent_basis(customer.offers_consent, customer.reminder_consent, customer.consent_source, customer.offers_opted_out_at) is null then 'no_consent'
            when (customer.channel = 'email' and customer.email is null)
              or (customer.channel <> 'email' and customer.phone is null) then 'no_address'
            when vehicle.customer_id is distinct from send.customer_id then 'vehicle_changed'
            when not garage_mot and jsonb_typeof(campaign.segment -> 'mot_months') = 'array'
              and jsonb_array_length(campaign.segment -> 'mot_months') > 0 then 'mot_disabled'
            when p_now > send.send_at + interval '7 days' then 'expired'
          end as reason
        ) checked
        where send.garage_id = p_garage_id
          and send.id = any (batch)
      ),
      skipped as (
        update public.campaign_sends send
        set status = 'skipped', skip_reason = verdict.reason, claimed_at = p_now
        from verdict
        where send.garage_id = p_garage_id
          and send.id = verdict.send_id
          and verdict.reason is not null
        returning send.id
      ),
      taken as (
        update public.campaign_sends send
        set status = 'sending', claimed_at = p_now, channel = verdict.route_channel
        from verdict
        where send.garage_id = p_garage_id
          and send.id = verdict.send_id
          and verdict.reason is null
        returning send.*
      )
      select
        taken.id, taken.campaign_id, taken.channel, taken.send_at,
        campaign.template, campaign.email_subject, campaign.email_template, campaign.service_id,
        customer.id, customer.name, customer.phone, customer.email,
        vehicle.id, vehicle.registration, vehicle.make, vehicle.model
      from taken
      join public.campaigns campaign on campaign.garage_id = taken.garage_id and campaign.id = taken.campaign_id
      join public.customers customer on customer.garage_id = taken.garage_id and customer.id = taken.customer_id
      join public.vehicles vehicle on vehicle.garage_id = taken.garage_id and vehicle.id = taken.vehicle_id
      order by taken.send_at, taken.id;

      get diagnostics batch_claimed = row_count;
      claimed := claimed + batch_claimed;
    end loop;

    update public.campaigns campaign
    set status = 'sending'
    where campaign.garage_id = p_garage_id
      and campaign.status = 'scheduled'
      and exists (
        select 1 from public.campaign_sends send
        where send.garage_id = campaign.garage_id and send.campaign_id = campaign.id and send.status <> 'scheduled'
      );
  end if;

  update public.campaigns campaign
  set status = 'sent', finished_at = p_now
  where campaign.garage_id = p_garage_id
    and campaign.status in ('scheduled', 'sending')
    and campaign.send_at <= p_now
    and not exists (
      select 1 from public.campaign_sends send
      where send.garage_id = campaign.garage_id and send.campaign_id = campaign.id and send.status = 'scheduled'
    );
end
$$;

comment on function public.claim_campaign_sends(uuid, timestamptz, integer) is
  'P5.5 service role: claim due campaign sends of one garage (offers consent or soft opt-in re-checked; Essentials garages skip with plan_required).';

-- Scheduled sends are cancelled when the customer opts out, is anonymised or
-- no longer has offers consent or the soft opt-in route.
create or replace function public.campaign_sends_follow_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reason text;
begin
  if new.anonymised_at is not null and old.anonymised_at is null then
    reason := 'anonymised';
  elsif new.opted_out_at is not null and old.opted_out_at is null then
    reason := 'opted_out';
  elsif public.campaign_consent_basis(new.offers_consent, new.reminder_consent, new.consent_source, new.offers_opted_out_at) is null then
    reason := 'no_consent';
  else
    return null;
  end if;
  update public.campaign_sends send
  set status = 'cancelled', skip_reason = reason
  where send.garage_id = new.garage_id and send.customer_id = new.id and send.status = 'scheduled';
  return null;
end
$$;

drop trigger customers_cancel_campaign_sends on public.customers;
create trigger customers_cancel_campaign_sends
  after update of opted_out_at, anonymised_at, reminder_consent, consent_source, offers_consent, offers_opted_out_at
  on public.customers
  for each row execute function public.campaign_sends_follow_customer();

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.customers_offers_consent() from public, anon, authenticated;
revoke all on function public.campaign_consent_basis(boolean, boolean, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.campaign_audience(uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.preview_campaign_audience(jsonb, integer) from public, anon;
grant execute on function public.preview_campaign_audience(jsonb, integer) to authenticated;
revoke all on function public.create_booking_at(uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;
