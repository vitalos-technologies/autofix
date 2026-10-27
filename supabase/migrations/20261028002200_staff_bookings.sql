-- Staff bookings (DECISIONS A90 follow-up, A176-A185).
--
-- Phone and walk-in bookings that a member of the garage makes in the admin
-- (`/app/bookings/new`) may ignore what only protects online booking:
-- services' online_enabled, min_notice_h and max_days_ahead (any time from
-- the start of today, up to two years ahead), and needs_approval /
-- garages.approve_online (straight to confirmed). They still obey opening
-- hours and closures unless the member explicitly overrides them, the
-- service area for mobile visits, the garage's status and MOT switch, and,
-- always, the no_overlap constraint. Every other booking (online, reminder,
-- missed call, AI agent, and phone/walk-in without a member) keeps every rule.
--
--   1. booking_service_context(garage, service, mode, include_offline): the
--      3-argument form (online rules) now calls it with false.
--   2. create_booking_at(): an optional `staff: {member_id, override_hours}`
--      object. Honoured only for source phone / walk_in and only when
--      member_id is a member of p_garage_id (garage_members); anything else
--      is INVALID_BOOKING. The created event records the member as actor_id
--      and `staff_rules` / `hours_override` in its data. create_booking()
--      (service role only) is unchanged and passes p_booking through.
--   3. staff_available_slots(garage, service, from, to, mode, member): the
--      staff time grid, with the same relaxations (opening hours and
--      closures still apply; at most 31 days per call).
--
-- Rollback notes (manual): re-create public.create_booking_at(uuid, jsonb,
-- timestamptz) from 20261028001000_reminders.sql and
-- public.booking_service_context(uuid, uuid, text) from
-- 20261027000100_scheduling.sql; drop function
-- public.staff_available_slots(uuid, uuid, date, date, text, uuid),
-- public.staff_available_slots_at(uuid, uuid, date, date, text, uuid, timestamptz),
-- public.booking_service_context(uuid, uuid, text, boolean).

-- ---------------------------------------------------------------------------
-- 1. Service context with or without online_enabled
-- ---------------------------------------------------------------------------

create function public.booking_service_context(p_garage_id uuid, p_service_id uuid, p_location_mode text, p_include_offline boolean)
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
    and (coalesce(p_include_offline, false) or service.online_enabled)
    and (not service.is_mot or garage.mot_enabled)
    and service.location_mode in ('both', visit.location_mode);

  if not found then
    raise exception 'SERVICE_UNAVAILABLE' using errcode = 'P0001';
  end if;
end
$$;

-- The online form (available_slots, the agent API, online create_booking).
create or replace function public.booking_service_context(p_garage_id uuid, p_service_id uuid, p_location_mode text)
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
language sql
stable
set search_path = ''
as $$
  select * from public.booking_service_context(p_garage_id, p_service_id, p_location_mode, false)
$$;

-- ---------------------------------------------------------------------------
-- 2. create_booking_at with staff rules
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
        and member.role in ('owner', 'manager', 'technician')
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
    garage_id, name, phone, email, preferred_contact, channel, reminder_consent, consent_at, consent_source, consent_text
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
    case when consent_given then consent_wording end
  )
  on conflict (garage_id, phone) do update
  set name = excluded.name,
      email = coalesce(excluded.email, customer.email),
      channel = case when customer_channel is null then customer.channel else excluded.channel end,
      preferred_contact = case when customer_channel is null then customer.preferred_contact else excluded.preferred_contact end,
      reminder_consent = customer.reminder_consent or coalesce(consent_given, false),
      consent_at = case when not customer.reminder_consent and consent_given then p_now else customer.consent_at end,
      consent_source = case when not customer.reminder_consent and consent_given then consent_from else customer.consent_source end,
      consent_text = case when not customer.reminder_consent and consent_given then consent_wording else customer.consent_text end
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
-- 3. Staff time grid
-- ---------------------------------------------------------------------------

-- Like available_slots_at(), for a member booking by phone or for a walk-in:
-- services not offered online too, no notice or booking window (from the
-- start of today, garage time, up to two years ahead), opening hours and
-- closures still apply. free_count = 0 means taken. At most 31 days.
create function public.staff_available_slots_at(
  p_garage_id uuid,
  p_service_id uuid,
  p_from date,
  p_to date,
  p_location_mode text,
  p_member_id uuid,
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
  first_day date;
  last_day date;
begin
  if p_garage_id is null or p_service_id is null or p_from is null or p_to is null or p_member_id is null or p_now is null then
    raise exception 'INVALID_BOOKING: garage, service, from, to and member are required' using errcode = 'P0001';
  end if;
  if p_to < p_from then
    raise exception 'INVALID_BOOKING: from must not be after to' using errcode = 'P0001';
  end if;
  if p_to - p_from > 31 then
    raise exception 'INVALID_BOOKING: at most 31 days at a time' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.garage_members member
    where member.garage_id = p_garage_id
      and member.user_id = p_member_id
      and member.role in ('owner', 'manager', 'technician')
  ) then
    raise exception 'INVALID_BOOKING: staff.member_id is not a member of this garage' using errcode = 'P0001';
  end if;

  select * into context from public.booking_service_context(p_garage_id, p_service_id, p_location_mode, true);

  travel := make_interval(mins => context.travel_min);
  duration := make_interval(mins => context.duration_min);
  block := duration + make_interval(mins => context.buffer_min) + travel;
  first_day := greatest(p_from, (p_now at time zone context.timezone)::date);
  last_day := least(p_to, ((p_now + interval '730 days') at time zone context.timezone)::date);
  if first_day > last_day then
    return;
  end if;

  return query
  with candidate as (
    select window_start.starts_at as slot_start
    from public.opening_window_starts(p_garage_id, first_day, last_day, context.duration_min) window_start
    where not exists (
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

create function public.staff_available_slots(
  p_garage_id uuid,
  p_service_id uuid,
  p_from date,
  p_to date,
  p_location_mode text,
  p_member_id uuid
)
returns table (starts_at timestamptz, ends_at timestamptz, free_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select slot.starts_at, slot.ends_at, slot.free_count
  from public.staff_available_slots_at(p_garage_id, p_service_id, p_from, p_to, p_location_mode, p_member_id, now()) slot
$$;

comment on function public.staff_available_slots(uuid, uuid, date, date, text, uuid) is
  'Service role only. The staff time grid: offline services too, no notice or booking window; opening hours and closures apply (A90 follow-up).';

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.booking_service_context(uuid, uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.booking_service_context(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.staff_available_slots_at(uuid, uuid, date, date, text, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.create_booking_at(uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.staff_available_slots(uuid, uuid, date, date, text, uuid) from public, anon, authenticated;
grant execute on function public.staff_available_slots(uuid, uuid, date, date, text, uuid) to service_role;
