-- P5.8: courtesy cars and collection/delivery slots (Pro feature
-- `courtesy_cars`, D17; DECISIONS A350-A357 in
-- docs/autofix/phase-5/P5.8-courtesy-cars.md).
--
--   1. courtesy_cars: the garage's fleet of loan cars (name, registration
--      stored normalised, on/off, notes, last known mileage and fuel).
--   2. courtesy_car_loans: a car lent with a booking for a time range. The
--      courtesy_car_loans_no_overlap exclusion constraint (btree_gist, same
--      idea as bookings.no_overlap) means a car can never be lent twice at
--      the same time; cancelled loans do not count. Staff reserve, release,
--      check out and check in through security-definer functions only.
--   3. courtesy_car_requests: a customer asked for a courtesy car while
--      booking online. Always a request: staff confirm it by reserving a car
--      (or decline it), so an availability race can never fail a booking.
--   4. Collection and delivery: services.collection_delivery (Pro) offers
--      "we collect your car and bring it back" on a workshop booking. The van
--      (a `mobile` resource) is held for each leg in collection_delivery_legs,
--      which has its own exclusion constraint. Legs are held right after the
--      booking exists (never inside create_booking(), which this migration
--      does not change); when no van is free the leg is kept as `unassigned`
--      and the booking gets a system note so staff arrange it by phone. The
--      booking itself always stands.
--   5. A trigger on bookings releases loans, legs and requests when the
--      booking is cancelled or a no-show, and follows a moved booking (the
--      loan shifts with it when the car is free; legs are held again).
--
-- Nothing here redefines create_booking*, available_slots* or
-- staff_available_slots*.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Fleet
-- ---------------------------------------------------------------------------

create table public.courtesy_cars (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  name text not null,
  registration text not null,
  active boolean not null default true,
  notes text,
  mileage integer,
  fuel_eighths smallint,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint courtesy_cars_garage_id_id_key unique (garage_id, id),
  constraint courtesy_cars_garage_id_registration_key unique (garage_id, registration),
  constraint courtesy_cars_name_check check (char_length(btrim(name)) between 1 and 60),
  constraint courtesy_cars_registration_check check (registration ~ '^[A-Z0-9]{2,8}$'),
  constraint courtesy_cars_notes_check check (notes is null or char_length(notes) <= 500),
  constraint courtesy_cars_mileage_check check (mileage is null or mileage between 0 and 2000000),
  constraint courtesy_cars_fuel_check check (fuel_eighths is null or fuel_eighths between 0 and 8)
);

comment on table public.courtesy_cars is
  'P5.8: the garage''s courtesy (loan) cars. registration is normalised (upper case, letters and digits) and only ever shown as a plate chip. mileage/fuel_eighths are the last values recorded at check-in or check-out.';

create index courtesy_cars_garage_sort_idx on public.courtesy_cars (garage_id, sort, name);

create trigger courtesy_cars_normalise_registration before insert or update of registration on public.courtesy_cars
  for each row execute function public.normalise_vehicle_registration();
create trigger courtesy_cars_updated before update on public.courtesy_cars
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Loans
-- ---------------------------------------------------------------------------

create table public.courtesy_car_loans (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  car_id uuid not null,
  booking_id uuid not null,
  customer_id uuid not null,
  during tstzrange not null,
  status text not null default 'reserved',
  notes text,
  mileage_out integer,
  fuel_out smallint,
  checked_out_at timestamptz,
  checked_out_by uuid references auth.users(id) on delete set null,
  mileage_in integer,
  fuel_in smallint,
  returned_at timestamptz,
  returned_by uuid references auth.users(id) on delete set null,
  damage_notes text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancellation_reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint courtesy_car_loans_garage_id_id_key unique (garage_id, id),
  constraint courtesy_car_loans_car_id_fkey foreign key (garage_id, car_id) references public.courtesy_cars (garage_id, id),
  constraint courtesy_car_loans_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade,
  constraint courtesy_car_loans_customer_id_fkey foreign key (garage_id, customer_id) references public.customers (garage_id, id),
  constraint courtesy_car_loans_status_check check (status in ('reserved', 'out', 'returned', 'cancelled')),
  constraint courtesy_car_loans_during_check check (
    not isempty(during) and lower_inc(during) and not upper_inc(during)
    and not lower_inf(during) and not upper_inf(during)
    and upper(during) - lower(during) <= interval '31 days'
  ),
  constraint courtesy_car_loans_out_check check ((status in ('out', 'returned')) = (checked_out_at is not null)),
  constraint courtesy_car_loans_returned_check check ((status = 'returned') = (returned_at is not null)),
  constraint courtesy_car_loans_cancelled_check check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint courtesy_car_loans_mileage_check check (
    (mileage_out is null or mileage_out between 0 and 2000000)
    and (mileage_in is null or mileage_in between 0 and 2000000)
    and (mileage_in is null or mileage_out is null or mileage_in >= mileage_out)
  ),
  constraint courtesy_car_loans_fuel_check check (
    (fuel_out is null or fuel_out between 0 and 8) and (fuel_in is null or fuel_in between 0 and 8)
  ),
  constraint courtesy_car_loans_text_check check (
    (notes is null or char_length(notes) <= 500)
    and (damage_notes is null or char_length(damage_notes) <= 1000)
    and (cancellation_reason is null or char_length(cancellation_reason) <= 300)
  ),
  -- A car is never lent twice at once. Cancelled loans give the car back.
  constraint courtesy_car_loans_no_overlap exclude using gist (car_id with =, during with &&)
    where (status <> 'cancelled')
);

comment on table public.courtesy_car_loans is
  'P5.8: a courtesy car lent with a booking for [lower, upper) of during. Guarded by courtesy_car_loans_no_overlap. Written only by reserve/release/check_out/check_in_courtesy_car() and the booking trigger.';
comment on column public.courtesy_car_loans.fuel_out is 'Fuel gauge in eighths (0 = empty, 8 = full).';

create index courtesy_car_loans_garage_during_idx on public.courtesy_car_loans using gist (garage_id, during);
create index courtesy_car_loans_garage_booking_idx on public.courtesy_car_loans (garage_id, booking_id);
create index courtesy_car_loans_garage_car_idx on public.courtesy_car_loans (garage_id, car_id);
create index courtesy_car_loans_garage_customer_idx on public.courtesy_car_loans (garage_id, customer_id);

create trigger courtesy_car_loans_updated before update on public.courtesy_car_loans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Customer requests
-- ---------------------------------------------------------------------------

create table public.courtesy_car_requests (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  booking_id uuid not null,
  customer_id uuid not null,
  status text not null default 'open',
  free_at_request boolean not null default false,
  loan_id uuid,
  reason text,
  handled_by uuid references auth.users(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint courtesy_car_requests_garage_id_id_key unique (garage_id, id),
  constraint courtesy_car_requests_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade,
  constraint courtesy_car_requests_customer_id_fkey foreign key (garage_id, customer_id) references public.customers (garage_id, id),
  constraint courtesy_car_requests_loan_id_fkey foreign key (garage_id, loan_id)
    references public.courtesy_car_loans (garage_id, id) on delete set null (loan_id),
  constraint courtesy_car_requests_status_check check (status in ('open', 'confirmed', 'declined', 'withdrawn')),
  constraint courtesy_car_requests_reason_check check (reason is null or char_length(reason) <= 300)
);

comment on table public.courtesy_car_requests is
  'P5.8: a customer asked for a courtesy car with an online booking. Staff confirm by reserving a car (status confirmed, loan_id set) or decline it. Written by request_courtesy_car() (service role), reserve_courtesy_car(), decline_courtesy_car_request() and the booking trigger.';

create unique index courtesy_car_requests_one_live_idx on public.courtesy_car_requests (garage_id, booking_id)
  where status in ('open', 'confirmed');
create index courtesy_car_requests_garage_open_idx on public.courtesy_car_requests (garage_id, created_at) where status = 'open';

create trigger courtesy_car_requests_updated before update on public.courtesy_car_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Collection and delivery
-- ---------------------------------------------------------------------------

alter table public.services add column collection_delivery boolean not null default false;

comment on column public.services.collection_delivery is
  'P5.8 (Pro, courtesy_cars): a workshop booking of this service may add collection and delivery; the van (a mobile resource) is held for each leg in collection_delivery_legs.';

-- Switching the option on needs Pro; switching it off never does. Staff
-- write services through RLS, so the plan is checked here for signed-in
-- members (A353).
create function public.guard_service_collection_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.collection_delivery
     and (tg_op = 'INSERT' or not old.collection_delivery)
     and auth.uid() is not null then
    -- A signed-in member (RLS write). Server code and seeds run without a
    -- user and decide for themselves.
    perform public.require_garage_feature(new.garage_id, 'courtesy_cars');
  end if;
  return new;
end
$$;

create trigger services_collection_delivery_guard before insert or update of collection_delivery on public.services
  for each row execute function public.guard_service_collection_delivery();

create table public.collection_delivery_legs (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  booking_id uuid not null,
  leg text not null,
  resource_id uuid,
  during tstzrange not null,
  postcode text not null,
  address text,
  status text not null default 'held',
  source text not null default 'customer',
  created_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collection_delivery_legs_garage_id_id_key unique (garage_id, id),
  constraint collection_delivery_legs_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade,
  constraint collection_delivery_legs_resource_id_fkey foreign key (garage_id, resource_id) references public.resources (garage_id, id),
  constraint collection_delivery_legs_leg_check check (leg in ('collection', 'delivery')),
  constraint collection_delivery_legs_status_check check (status in ('held', 'unassigned', 'cancelled')),
  constraint collection_delivery_legs_source_check check (source in ('customer', 'staff', 'system')),
  constraint collection_delivery_legs_held_check check (status <> 'held' or resource_id is not null),
  constraint collection_delivery_legs_cancelled_check check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint collection_delivery_legs_postcode_check check (postcode ~ '^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$'),
  constraint collection_delivery_legs_address_check check (address is null or char_length(address) <= 300),
  constraint collection_delivery_legs_during_check check (
    not isempty(during) and lower_inc(during) and not upper_inc(during) and not lower_inf(during) and not upper_inf(during)
  ),
  -- The van is never held for two legs at once.
  constraint collection_delivery_legs_no_overlap exclude using gist (resource_id with =, during with &&)
    where (status = 'held')
);

comment on table public.collection_delivery_legs is
  'P5.8: the van''s time to collect a car before a workshop booking and to deliver it after. held = a mobile resource is reserved (collection_delivery_legs_no_overlap); unassigned = no van was free, staff arrange it. Written only by the collection functions and the booking trigger.';

create unique index collection_delivery_legs_one_live_idx on public.collection_delivery_legs (garage_id, booking_id, leg)
  where status <> 'cancelled';
create index collection_delivery_legs_garage_during_idx on public.collection_delivery_legs using gist (garage_id, during);
create index collection_delivery_legs_garage_resource_idx on public.collection_delivery_legs (garage_id, resource_id);

create trigger collection_delivery_legs_updated before update on public.collection_delivery_legs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Internals (owner only; no API role may call them)
-- ---------------------------------------------------------------------------

-- The selected garage for a courtesy-car action by a signed-in member whose
-- role is one of p_roles (MFA as other staff RPCs), with Pro. Raises 42501
-- COURTESY_FORBIDDEN, or PLAN_REQUIRED (P0001).
create function public.courtesy_actor_garage(p_roles text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
begin
  if not public.garage_actor_allowed() or coalesce(public.current_garage_role() = any (p_roles), false) is false then
    raise exception 'COURTESY_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'courtesy_cars');
  return target_garage;
end
$$;

-- The default loan window for a booking that starts at p_starts_at: from the
-- drop-off until the garage closes that (local) day, or until the booking
-- ends if that is later. Built from the local date and the closing time in
-- the garage's time zone, so clock-change days give the right instants.
create function public.courtesy_car_default_window(p_garage_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
returns tstzrange
language sql
stable
set search_path = ''
as $$
  select tstzrange(
    p_starts_at,
    greatest(
      p_ends_at,
      coalesce((
        select max((((p_starts_at at time zone garage.timezone)::date) + hours.closes) at time zone garage.timezone)
        from public.opening_hours hours
        where hours.garage_id = garage.id
          and hours.weekday = extract(isodow from (p_starts_at at time zone garage.timezone)::date)
      ), p_ends_at)
    ),
    '[)'
  )
  from public.garages garage
  where garage.id = p_garage_id
$$;

-- Active cars of the garage with no live loan overlapping p_window.
create function public.courtesy_cars_free_in(p_garage_id uuid, p_window tstzrange, p_ignore_loan uuid default null)
returns setof public.courtesy_cars
language sql
stable
set search_path = ''
as $$
  select car.*
  from public.courtesy_cars car
  where car.garage_id = p_garage_id
    and car.active
    and not exists (
      select 1 from public.courtesy_car_loans loan
      where loan.garage_id = p_garage_id
        and loan.car_id = car.id
        and loan.status <> 'cancelled'
        and loan.during && p_window
        and loan.id is distinct from p_ignore_loan
    )
  order by car.sort, car.name, car.id
$$;

-- A system note on the booking's timeline (booking_events type note).
create function public.courtesy_booking_note(p_garage_id uuid, p_booking_id uuid, p_text text, p_actor_id uuid default null)
returns void
language sql
volatile
set search_path = ''
as $$
  insert into public.booking_events (garage_id, booking_id, type, actor, actor_id, data)
  values (p_garage_id, p_booking_id, 'note', case when p_actor_id is null then 'system' else 'staff' end, p_actor_id,
          jsonb_build_object('text', p_text, 'courtesy', true));
$$;

-- Normalised UK postcode ("DN1 2AB") or INVALID_BOOKING.
create function public.courtesy_postcode(p_postcode text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  compact text := upper(regexp_replace(coalesce(p_postcode, ''), '[[:space:]]', '', 'g'));
begin
  if compact !~ '^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$' then
    raise exception 'INVALID_BOOKING: postcode is not a UK postcode' using errcode = 'P0001';
  end if;
  return left(compact, -3) || ' ' || right(compact, 3);
end
$$;

-- The van's time for each leg of a workshop booking: the collection runs out
-- and back before the bay is taken, the delivery out and back after it.
-- travel = garages.mobile_travel_min each way.
create function public.collection_delivery_windows(p_garage_id uuid, p_booking_id uuid)
returns table (leg text, during tstzrange)
language sql
stable
set search_path = ''
as $$
  select 'collection'::text,
         tstzrange(lower(booking.during) - make_interval(mins => 2 * garage.mobile_travel_min), lower(booking.during), '[)')
  from public.bookings booking
  join public.garages garage on garage.id = booking.garage_id
  where booking.garage_id = p_garage_id and booking.id = p_booking_id
  union all
  select 'delivery'::text,
         tstzrange(upper(booking.during), upper(booking.during) + make_interval(mins => 2 * garage.mobile_travel_min), '[)')
  from public.bookings booking
  join public.garages garage on garage.id = booking.garage_id
  where booking.garage_id = p_garage_id and booking.id = p_booking_id
$$;

-- Holds the van for both legs of a booking (cancelling any live legs first).
-- Serialised with create_booking() by the same per-garage advisory lock, so
-- a van picked here is free of bookings and other legs at this moment. A leg
-- with no free van is stored as unassigned and noted on the booking; the
-- booking always stands. Returns {status: held|partial|unassigned, legs}.
create function public.collection_delivery_hold(
  p_garage_id uuid,
  p_booking_id uuid,
  p_postcode text,
  p_address text,
  p_source text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  booking record;
  postcode text;
  address text := nullif(left(btrim(regexp_replace(coalesce(p_address, ''), '[[:space:]]+', ' ', 'g')), 300), '');
  area text[];
  window_row record;
  van uuid;
  held integer := 0;
  missing text[] := '{}';
  legs jsonb := '[]'::jsonb;
  leg_row public.collection_delivery_legs;
begin
  perform pg_advisory_xact_lock(hashtextextended('public.create_booking:' || p_garage_id::text, 0));

  select b.id, b.status, b.location_mode, b.service_id, service.collection_delivery
  into booking
  from public.bookings b
  join public.services service on service.garage_id = b.garage_id and service.id = b.service_id
  where b.garage_id = p_garage_id and b.id = p_booking_id and b.deleted_at is null
  for update of b;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;
  if booking.status in ('cancelled', 'no_show', 'collected') then
    raise exception 'BOOKING_NOT_LIVE' using errcode = 'P0001';
  end if;
  if booking.location_mode <> 'workshop' or not booking.collection_delivery then
    raise exception 'COLLECTION_NOT_OFFERED' using errcode = 'P0001';
  end if;

  postcode := public.courtesy_postcode(p_postcode);
  select garage.service_area into area from public.garages garage where garage.id = p_garage_id;
  if not exists (select 1 from unnest(area) item where upper(btrim(item)) = split_part(postcode, ' ', 1)) then
    raise exception 'OUTSIDE_SERVICE_AREA' using errcode = 'P0001';
  end if;

  update public.collection_delivery_legs existing
  set status = 'cancelled', cancelled_at = now()
  where existing.garage_id = p_garage_id and existing.booking_id = p_booking_id and existing.status <> 'cancelled';

  for window_row in select * from public.collection_delivery_windows(p_garage_id, p_booking_id) order by 1 loop
    select resource.id into van
    from public.resources resource
    where resource.garage_id = p_garage_id
      and resource.kind = 'mobile'
      and resource.active
      and not exists (
        select 1 from public.bookings other
        where other.garage_id = p_garage_id
          and other.resource_id = resource.id
          and other.status not in ('cancelled', 'no_show')
          and other.during && window_row.during
      )
      and not exists (
        select 1 from public.collection_delivery_legs other_leg
        where other_leg.garage_id = p_garage_id
          and other_leg.resource_id = resource.id
          and other_leg.status = 'held'
          and other_leg.during && window_row.during
      )
    order by resource.sort, resource.name, resource.id
    limit 1;

    leg_row := null;
    if van is not null then
      begin
        insert into public.collection_delivery_legs (garage_id, booking_id, leg, resource_id, during, postcode, address, status, source, created_by)
        values (p_garage_id, p_booking_id, window_row.leg, van, window_row.during, postcode, address, 'held', p_source, p_actor_id)
        returning * into leg_row;
        held := held + 1;
      exception when exclusion_violation then
        leg_row := null;
      end;
    end if;
    if leg_row.id is null then
      insert into public.collection_delivery_legs (garage_id, booking_id, leg, resource_id, during, postcode, address, status, source, created_by)
      values (p_garage_id, p_booking_id, window_row.leg, null, window_row.during, postcode, address, 'unassigned', p_source, p_actor_id)
      returning * into leg_row;
      missing := missing || window_row.leg;
    end if;
    legs := legs || jsonb_build_object(
      'id', leg_row.id, 'leg', leg_row.leg, 'status', leg_row.status, 'resource_id', leg_row.resource_id,
      'starts_at', lower(leg_row.during), 'ends_at', upper(leg_row.during));
  end loop;

  if cardinality(missing) > 0 then
    perform public.courtesy_booking_note(
      p_garage_id, p_booking_id,
      'Collection and delivery: no van free for the ' || array_to_string(missing, ' and ') || '. Call the customer to arrange it.');
  end if;

  return jsonb_build_object(
    'status', case when held = 2 then 'held' when held = 0 then 'unassigned' else 'partial' end,
    'legs', legs);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Staff functions (authenticated; selected garage; Pro)
-- ---------------------------------------------------------------------------

-- Every active car with whether it is free for the window (default: the
-- booking's day, courtesy_car_default_window). Any member.
create function public.courtesy_car_options(
  p_booking_id uuid,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null
)
returns table (car_id uuid, name text, registration text, free boolean, window_starts timestamptz, window_ends timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  target_garage uuid := public.courtesy_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
  booking record;
  loan_window tstzrange;
begin
  select b.starts_at, b.ends_at into booking
  from public.bookings b where b.garage_id = target_garage and b.id = p_booking_id;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;
  loan_window := case
    when p_starts_at is not null and p_ends_at is not null then tstzrange(p_starts_at, p_ends_at, '[)')
    else public.courtesy_car_default_window(target_garage, booking.starts_at, booking.ends_at)
  end;
  if isempty(loan_window) then
    raise exception 'INVALID_LOAN: the loan must end after it starts' using errcode = 'P0001';
  end if;

  return query
  select car.id, car.name, car.registration,
         exists (select 1 from public.courtesy_cars_free_in(target_garage, loan_window) free_car where free_car.id = car.id),
         lower(loan_window), upper(loan_window)
  from public.courtesy_cars car
  where car.garage_id = target_garage and car.active
  order by car.sort, car.name, car.id;
end
$$;

-- Reserves a car for a booking. Any member. Two overlapping reservations of
-- one car: the first wins, the second gets COURTESY_CAR_UNAVAILABLE.
create function public.reserve_courtesy_car(
  p_booking_id uuid,
  p_car_id uuid,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_notes text default null
)
returns public.courtesy_car_loans
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.courtesy_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
  booking record;
  car public.courtesy_cars;
  loan_window tstzrange;
  loan public.courtesy_car_loans;
begin
  select b.id, b.customer_id, b.starts_at, b.ends_at, b.status into booking
  from public.bookings b
  where b.garage_id = target_garage and b.id = p_booking_id and b.deleted_at is null;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;
  if booking.status in ('cancelled', 'no_show', 'collected') then
    raise exception 'BOOKING_NOT_LIVE' using errcode = 'P0001';
  end if;

  -- One reservation per car at a time: concurrent calls queue here, then the
  -- exclusion constraint decides.
  perform pg_advisory_xact_lock(hashtextextended('public.courtesy_car:' || coalesce(p_car_id::text, ''), 0));
  select * into car from public.courtesy_cars c where c.garage_id = target_garage and c.id = p_car_id;
  if not found then
    raise exception 'COURTESY_CAR_NOT_FOUND' using errcode = 'P0001';
  end if;
  if not car.active then
    raise exception 'COURTESY_CAR_UNAVAILABLE: switched off' using errcode = 'P0001';
  end if;

  if (p_starts_at is null) <> (p_ends_at is null) then
    raise exception 'INVALID_LOAN: give both the start and the end, or neither' using errcode = 'P0001';
  end if;
  if p_starts_at is not null and p_ends_at <= p_starts_at then
    raise exception 'INVALID_LOAN: the loan must end after it starts' using errcode = 'P0001';
  end if;
  loan_window := case
    when p_starts_at is not null then tstzrange(p_starts_at, p_ends_at, '[)')
    else public.courtesy_car_default_window(target_garage, booking.starts_at, booking.ends_at)
  end;
  if upper(loan_window) - lower(loan_window) > interval '31 days' then
    raise exception 'INVALID_LOAN: a loan is at most 31 days' using errcode = 'P0001';
  end if;

  begin
    insert into public.courtesy_car_loans (garage_id, car_id, booking_id, customer_id, during, status, notes, created_by)
    values (target_garage, car.id, booking.id, booking.customer_id, loan_window, 'reserved',
            nullif(left(btrim(coalesce(p_notes, '')), 500), ''), auth.uid())
    returning * into loan;
  exception when exclusion_violation then
    raise exception 'COURTESY_CAR_UNAVAILABLE' using errcode = 'P0001';
  end;

  update public.courtesy_car_requests request
  set status = 'confirmed', loan_id = loan.id, handled_by = auth.uid(), handled_at = now()
  where request.garage_id = target_garage and request.booking_id = booking.id and request.status = 'open';

  perform public.courtesy_booking_note(target_garage, booking.id, 'Courtesy car reserved: ' || car.name || '.', auth.uid());
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'courtesy_car.reserved', 'courtesy_car_loan', loan.id::text,
          jsonb_build_object('booking_id', booking.id, 'car_id', car.id));
  return loan;
end
$$;

-- Releases a reserved loan (the car is free again). Any member.
create function public.release_courtesy_car(p_loan_id uuid, p_reason text default null)
returns public.courtesy_car_loans
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.courtesy_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
  loan public.courtesy_car_loans;
begin
  update public.courtesy_car_loans existing
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
      cancellation_reason = nullif(left(btrim(coalesce(p_reason, '')), 300), '')
  where existing.garage_id = target_garage and existing.id = p_loan_id and existing.status = 'reserved'
  returning * into loan;
  if not found then
    if exists (select 1 from public.courtesy_car_loans l where l.garage_id = target_garage and l.id = p_loan_id) then
      raise exception 'LOAN_STATE: only a reserved loan can be released' using errcode = 'P0001';
    end if;
    raise exception 'LOAN_NOT_FOUND' using errcode = 'P0001';
  end if;
  update public.courtesy_car_requests request
  set status = 'open', loan_id = null, handled_by = null, handled_at = null
  where request.garage_id = target_garage and request.loan_id = loan.id and request.status = 'confirmed';
  perform public.courtesy_booking_note(target_garage, loan.booking_id, 'Courtesy car released.', auth.uid());
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'courtesy_car.released', 'courtesy_car_loan', loan.id::text, '{}'::jsonb);
  return loan;
end
$$;

-- Hands the car over: mileage and fuel out. Refused while the same car is
-- still out on another loan (it has not come back yet). Any member.
create function public.check_out_courtesy_car(p_loan_id uuid, p_mileage integer, p_fuel_eighths integer, p_notes text default null)
returns public.courtesy_car_loans
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.courtesy_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
  loan public.courtesy_car_loans;
begin
  if p_mileage is null or p_mileage < 0 or p_mileage > 2000000 or p_fuel_eighths is null or p_fuel_eighths not between 0 and 8 then
    raise exception 'INVALID_LOAN: mileage and fuel are required' using errcode = 'P0001';
  end if;
  select * into loan from public.courtesy_car_loans l where l.garage_id = target_garage and l.id = p_loan_id for update;
  if not found then
    raise exception 'LOAN_NOT_FOUND' using errcode = 'P0001';
  end if;
  if loan.status <> 'reserved' then
    raise exception 'LOAN_STATE: only a reserved loan can be checked out' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.courtesy_car_loans other
    where other.garage_id = target_garage and other.car_id = loan.car_id and other.status = 'out' and other.id <> loan.id
  ) then
    raise exception 'COURTESY_CAR_STILL_OUT' using errcode = 'P0001';
  end if;

  update public.courtesy_car_loans existing
  set status = 'out', mileage_out = p_mileage, fuel_out = p_fuel_eighths, checked_out_at = now(), checked_out_by = auth.uid(),
      notes = coalesce(nullif(left(btrim(coalesce(p_notes, '')), 500), ''), existing.notes)
  where existing.id = loan.id
  returning * into loan;
  update public.courtesy_cars car set mileage = p_mileage, fuel_eighths = p_fuel_eighths
  where car.garage_id = target_garage and car.id = loan.car_id;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'courtesy_car.checked_out', 'courtesy_car_loan', loan.id::text,
          jsonb_build_object('mileage', p_mileage, 'fuel_eighths', p_fuel_eighths));
  return loan;
end
$$;

-- Takes the car back: mileage and fuel in, damage notes. An early return
-- frees the rest of the window. Any member.
create function public.check_in_courtesy_car(p_loan_id uuid, p_mileage integer, p_fuel_eighths integer, p_damage_notes text default null)
returns public.courtesy_car_loans
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.courtesy_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
  loan public.courtesy_car_loans;
  returned timestamptz := now();
begin
  if p_mileage is null or p_mileage < 0 or p_mileage > 2000000 or p_fuel_eighths is null or p_fuel_eighths not between 0 and 8 then
    raise exception 'INVALID_LOAN: mileage and fuel are required' using errcode = 'P0001';
  end if;
  select * into loan from public.courtesy_car_loans l where l.garage_id = target_garage and l.id = p_loan_id for update;
  if not found then
    raise exception 'LOAN_NOT_FOUND' using errcode = 'P0001';
  end if;
  if loan.status <> 'out' then
    raise exception 'LOAN_STATE: only a car that is out can be checked in' using errcode = 'P0001';
  end if;
  if loan.mileage_out is not null and p_mileage < loan.mileage_out then
    raise exception 'INVALID_LOAN: mileage in is below mileage out' using errcode = 'P0001';
  end if;

  update public.courtesy_car_loans existing
  set status = 'returned', mileage_in = p_mileage, fuel_in = p_fuel_eighths, returned_at = returned, returned_by = auth.uid(),
      damage_notes = nullif(left(btrim(coalesce(p_damage_notes, '')), 1000), ''),
      during = case
        when returned > lower(existing.during) and returned < upper(existing.during) then tstzrange(lower(existing.during), returned, '[)')
        else existing.during
      end
  where existing.id = loan.id
  returning * into loan;
  update public.courtesy_cars car set mileage = p_mileage, fuel_eighths = p_fuel_eighths
  where car.garage_id = target_garage and car.id = loan.car_id;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'courtesy_car.checked_in', 'courtesy_car_loan', loan.id::text,
          jsonb_build_object('mileage', p_mileage, 'fuel_eighths', p_fuel_eighths, 'damage', loan.damage_notes is not null));
  return loan;
end
$$;

-- Declines an open customer request. Any member.
create function public.decline_courtesy_car_request(p_request_id uuid, p_reason text default null)
returns public.courtesy_car_requests
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.courtesy_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
  request public.courtesy_car_requests;
begin
  update public.courtesy_car_requests existing
  set status = 'declined', handled_by = auth.uid(), handled_at = now(),
      reason = nullif(left(btrim(coalesce(p_reason, '')), 300), '')
  where existing.garage_id = target_garage and existing.id = p_request_id and existing.status = 'open'
  returning * into request;
  if not found then
    raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform public.courtesy_booking_note(target_garage, request.booking_id, 'Courtesy car request declined.', auth.uid());
  return request;
end
$$;

-- Staff add (or redo) collection and delivery for a booking. Any member.
create function public.hold_collection_delivery(p_booking_id uuid, p_postcode text, p_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.courtesy_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
begin
  return public.collection_delivery_hold(target_garage, p_booking_id, p_postcode, p_address, 'staff', auth.uid());
end
$$;

-- Staff cancel collection and delivery for a booking; the van is free again.
-- Returns the number of legs released. Any member.
create function public.release_collection_delivery(p_booking_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.courtesy_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
  released integer;
begin
  update public.collection_delivery_legs existing
  set status = 'cancelled', cancelled_at = now()
  where existing.garage_id = target_garage and existing.booking_id = p_booking_id and existing.status <> 'cancelled';
  get diagnostics released = row_count;
  if released > 0 then
    perform public.courtesy_booking_note(target_garage, p_booking_id, 'Collection and delivery cancelled.', auth.uid());
  end if;
  return released;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Booking-site functions (service role; garage from the request host)
-- ---------------------------------------------------------------------------

-- How many cars are free for a would-be booking [p_starts_at, p_ends_at)
-- (default window: to closing that day). 0 when the garage has no Pro, so the
-- option simply does not appear.
create function public.courtesy_car_free_count(p_garage_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_garage_id is null or p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then 0
    when not public.garage_has_feature(p_garage_id, 'courtesy_cars') then 0
    else (select count(*)::integer
          from public.courtesy_cars_free_in(p_garage_id, public.courtesy_car_default_window(p_garage_id, p_starts_at, p_ends_at)))
  end
$$;

-- The customer asked for a courtesy car with a booking that already exists.
-- Idempotent per booking. Returns {request_id, status, free, replayed}.
create function public.request_courtesy_car(p_garage_id uuid, p_booking_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  booking record;
  request public.courtesy_car_requests;
  is_free boolean;
begin
  perform public.require_garage_feature(p_garage_id, 'courtesy_cars');
  select b.id, b.customer_id, b.starts_at, b.ends_at, b.status into booking
  from public.bookings b where b.garage_id = p_garage_id and b.id = p_booking_id;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;
  if booking.status in ('cancelled', 'no_show', 'collected') then
    raise exception 'BOOKING_NOT_LIVE' using errcode = 'P0001';
  end if;

  select * into request from public.courtesy_car_requests existing
  where existing.garage_id = p_garage_id and existing.booking_id = p_booking_id and existing.status in ('open', 'confirmed');
  if found then
    return jsonb_build_object('request_id', request.id, 'status', request.status, 'free', request.free_at_request, 'replayed', true);
  end if;

  is_free := public.courtesy_car_free_count(p_garage_id, booking.starts_at, booking.ends_at) > 0;
  insert into public.courtesy_car_requests (garage_id, booking_id, customer_id, status, free_at_request)
  values (p_garage_id, booking.id, booking.customer_id, 'open', is_free)
  returning * into request;
  perform public.courtesy_booking_note(p_garage_id, booking.id, 'The customer asked for a courtesy car. Reserve one or decline the request.');
  return jsonb_build_object('request_id', request.id, 'status', request.status, 'free', is_free, 'replayed', false);
end
$$;

-- The customer chose collection and delivery for a booking that already
-- exists. Idempotent: live legs are returned as they are.
create function public.request_collection_delivery(p_garage_id uuid, p_booking_id uuid, p_postcode text, p_address text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing_legs jsonb;
begin
  perform public.require_garage_feature(p_garage_id, 'courtesy_cars');
  select jsonb_agg(jsonb_build_object('id', leg.id, 'leg', leg.leg, 'status', leg.status, 'resource_id', leg.resource_id,
                                      'starts_at', lower(leg.during), 'ends_at', upper(leg.during)) order by leg.leg)
  into existing_legs
  from public.collection_delivery_legs leg
  where leg.garage_id = p_garage_id and leg.booking_id = p_booking_id and leg.status <> 'cancelled';
  if existing_legs is not null then
    return jsonb_build_object(
      'status', case
        when not exists (select 1 from jsonb_array_elements(existing_legs) item where item->>'status' <> 'held') then 'held'
        when not exists (select 1 from jsonb_array_elements(existing_legs) item where item->>'status' = 'held') then 'unassigned'
        else 'partial' end,
      'legs', existing_legs, 'replayed', true);
  end if;
  return public.collection_delivery_hold(p_garage_id, p_booking_id, p_postcode, p_address, 'customer', null)
    || jsonb_build_object('replayed', false);
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Follow the booking
-- ---------------------------------------------------------------------------

-- Cancelled / no-show: reserved loans, live legs and open requests are
-- released. Moved (during changed): a reserved loan moves by the same amount
-- when the car is free then (else it stays and the booking gets a note);
-- live legs are held again for the new times.
create function public.courtesy_follow_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  loan record;
  shift interval;
  leg record;
begin
  if new.status in ('cancelled', 'no_show') and old.status not in ('cancelled', 'no_show') then
    update public.courtesy_car_loans existing
    set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Booking ' || replace(new.status, '_', '-')
    where existing.garage_id = new.garage_id and existing.booking_id = new.id and existing.status = 'reserved';
    update public.collection_delivery_legs existing
    set status = 'cancelled', cancelled_at = now()
    where existing.garage_id = new.garage_id and existing.booking_id = new.id and existing.status <> 'cancelled';
    update public.courtesy_car_requests existing
    set status = 'withdrawn', handled_at = now()
    where existing.garage_id = new.garage_id and existing.booking_id = new.id and existing.status = 'open';
    return new;
  end if;

  if new.during is distinct from old.during and new.status not in ('cancelled', 'no_show', 'collected') then
    shift := new.starts_at - old.starts_at;
    if shift <> interval '0' then
      for loan in
        select l.id, l.during, car.name
        from public.courtesy_car_loans l
        join public.courtesy_cars car on car.garage_id = l.garage_id and car.id = l.car_id
        where l.garage_id = new.garage_id and l.booking_id = new.id and l.status = 'reserved'
      loop
        begin
          update public.courtesy_car_loans existing
          set during = tstzrange(lower(loan.during) + shift, upper(loan.during) + shift, '[)')
          where existing.id = loan.id;
        exception when exclusion_violation then
          perform public.courtesy_booking_note(new.garage_id, new.id,
            'Booking moved: courtesy car ' || loan.name || ' is not free at the new time. Choose another car.');
        end;
      end loop;
    end if;

    select l.postcode, l.address into leg
    from public.collection_delivery_legs l
    where l.garage_id = new.garage_id and l.booking_id = new.id and l.status <> 'cancelled'
    limit 1;
    if found then
      -- Never block the move: if the legs cannot be held again (service no
      -- longer offers it, area changed), they are released and noted.
      begin
        perform public.collection_delivery_hold(new.garage_id, new.id, leg.postcode, leg.address, 'system', null);
      exception when others then
        update public.collection_delivery_legs existing
        set status = 'cancelled', cancelled_at = now()
        where existing.garage_id = new.garage_id and existing.booking_id = new.id and existing.status <> 'cancelled';
        perform public.courtesy_booking_note(new.garage_id, new.id,
          'Booking moved: collection and delivery could not be kept. Call the customer to arrange it.');
      end;
    end if;
  end if;
  return new;
end
$$;

create trigger bookings_courtesy_follow after update of status, during on public.bookings
  for each row execute function public.courtesy_follow_booking();

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
-- anon: nothing. Members read every table; owners/managers write the fleet
-- through RLS (Pro); loans, requests and legs are written only by the
-- functions above and the booking trigger.

revoke all on public.courtesy_cars, public.courtesy_car_loans, public.courtesy_car_requests, public.collection_delivery_legs
  from anon, authenticated;
grant select, insert, update, delete on public.courtesy_cars to authenticated;
grant select on public.courtesy_car_loans, public.courtesy_car_requests, public.collection_delivery_legs to authenticated;
grant select, insert, update, delete on public.courtesy_cars, public.courtesy_car_loans, public.courtesy_car_requests,
  public.collection_delivery_legs to service_role;

revoke all on function public.courtesy_actor_garage(text[]) from public, anon, authenticated, service_role;
revoke all on function public.courtesy_car_default_window(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.courtesy_cars_free_in(uuid, tstzrange, uuid) from public, anon, authenticated, service_role;
revoke all on function public.courtesy_booking_note(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.courtesy_postcode(text) from public, anon, authenticated, service_role;
revoke all on function public.collection_delivery_windows(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.collection_delivery_hold(uuid, uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.courtesy_follow_booking() from public, anon, authenticated, service_role;
revoke all on function public.guard_service_collection_delivery() from public, anon, authenticated, service_role;

revoke all on function public.courtesy_car_options(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.reserve_courtesy_car(uuid, uuid, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.release_courtesy_car(uuid, text) from public, anon;
revoke all on function public.check_out_courtesy_car(uuid, integer, integer, text) from public, anon;
revoke all on function public.check_in_courtesy_car(uuid, integer, integer, text) from public, anon;
revoke all on function public.decline_courtesy_car_request(uuid, text) from public, anon;
revoke all on function public.hold_collection_delivery(uuid, text, text) from public, anon;
revoke all on function public.release_collection_delivery(uuid) from public, anon;
grant execute on function public.courtesy_car_options(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.reserve_courtesy_car(uuid, uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.release_courtesy_car(uuid, text) to authenticated;
grant execute on function public.check_out_courtesy_car(uuid, integer, integer, text) to authenticated;
grant execute on function public.check_in_courtesy_car(uuid, integer, integer, text) to authenticated;
grant execute on function public.decline_courtesy_car_request(uuid, text) to authenticated;
grant execute on function public.hold_collection_delivery(uuid, text, text) to authenticated;
grant execute on function public.release_collection_delivery(uuid) to authenticated;

revoke all on function public.courtesy_car_free_count(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.request_courtesy_car(uuid, uuid) from public, anon, authenticated;
revoke all on function public.request_collection_delivery(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.courtesy_car_free_count(uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.request_courtesy_car(uuid, uuid) to service_role;
grant execute on function public.request_collection_delivery(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Row-level security
-- ---------------------------------------------------------------------------

alter table public.courtesy_cars enable row level security;
alter table public.courtesy_car_loans enable row level security;
alter table public.courtesy_car_requests enable row level security;
alter table public.collection_delivery_legs enable row level security;

-- courtesy_cars
--   "garage members read courtesy cars"         select  members of the selected garage (any plan: kept readable after a downgrade)
--   "owners and managers add courtesy cars"     insert  owners/managers of the selected garage, Pro (courtesy_cars)
--   "owners and managers change courtesy cars"  update  owners/managers of the selected garage, Pro
--   "owners and managers remove courtesy cars"  delete  owners/managers of the selected garage, Pro (a car with loans is switched off instead)
create policy "garage members read courtesy cars" on public.courtesy_cars
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add courtesy cars" on public.courtesy_cars
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'courtesy_cars')
  );
create policy "owners and managers change courtesy cars" on public.courtesy_cars
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'courtesy_cars')
  );
create policy "owners and managers remove courtesy cars" on public.courtesy_cars
  for delete to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'courtesy_cars')
  );

-- courtesy_car_loans
--   "garage members read courtesy car loans"  select  members of the selected garage
--   (no write grants: reserve/release/check_out/check_in_courtesy_car() and the booking trigger)
create policy "garage members read courtesy car loans" on public.courtesy_car_loans
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- courtesy_car_requests
--   "garage members read courtesy car requests"  select  members of the selected garage
--   (no write grants: request_courtesy_car() (service role), reserve_courtesy_car(), decline_courtesy_car_request(), the booking trigger)
create policy "garage members read courtesy car requests" on public.courtesy_car_requests
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- collection_delivery_legs
--   "garage members read collection legs"  select  members of the selected garage
--   (no write grants: hold/release_collection_delivery(), request_collection_delivery() (service role), the booking trigger)
create policy "garage members read collection legs" on public.collection_delivery_legs
  for select to authenticated using (garage_id = (select public.current_garage_id()));
