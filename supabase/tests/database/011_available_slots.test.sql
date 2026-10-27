begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
-- Text renderings below are UTC; one test re-runs a clock-change day in
-- another session time zone to show the engine does not depend on it.
set local timezone to 'UTC';

select plan(56);

-- available_slots() (P2.2). The tests call available_slots_at(), the same
-- engine with an injectable clock, so fixed dates (including the 2026 clock
-- changes) stay testable after they have passed. available_slots() is
-- available_slots_at(..., now()); the last section checks that.
--
-- Garage A (Europe/London, 15-minute step, 30 minutes mobile travel):
--   Mon, Tue, Thu, Fri 08:00-17:30; Wed 08:00-12:00 and 13:00-17:30 (split);
--   Sat 08:30-13:00; Sun 08:00-17:30 (so both clock-change Sundays are open).
--   Closed 25-26 Dec 2026. Bays 1-3, a mobile van and an inactive bay.

insert into public.garages (id, slug, name, booking_prefix, timezone, slot_step_min, mobile_travel_min, mot_enabled, service_area, status) values
  ('a1100000-0000-4000-8000-000000000001', 'pgtap-slots-a', 'Slots Garage A', 'SLA', 'Europe/London', 15, 30, true, '{DN4,DN5}', 'active'),
  ('b1100000-0000-4000-8000-000000000001', 'pgtap-slots-b', 'Slots Garage B', 'SLB', 'Europe/London', 15, 30, false, '{S60}', 'active'),
  ('c1100000-0000-4000-8000-000000000001', 'pgtap-slots-c', 'Slots Garage C', 'SLC', 'Europe/London', 15, 30, false, '{}', 'onboarding');

insert into public.opening_hours (garage_id, weekday, opens, closes)
select 'a1100000-0000-4000-8000-000000000001'::uuid, weekday::smallint, time '08:00', time '17:30' from unnest(array[1, 2, 4, 5, 7]) weekday
union all select 'a1100000-0000-4000-8000-000000000001', 3, '08:00', '12:00'
union all select 'a1100000-0000-4000-8000-000000000001', 3, '13:00', '17:30'
union all select 'a1100000-0000-4000-8000-000000000001', 6, '08:30', '13:00'
union all select 'b1100000-0000-4000-8000-000000000001', weekday, '08:00', '17:30' from generate_series(1, 7) weekday;

insert into public.closures (garage_id, starts_on, ends_on, reason) values
  ('a1100000-0000-4000-8000-000000000001', '2026-12-25', '2026-12-26', 'Christmas');

insert into public.resources (id, garage_id, name, kind, active, sort) values
  ('a1100000-0000-4000-8000-000000000101', 'a1100000-0000-4000-8000-000000000001', 'Bay 1', 'bay', true, 1),
  ('a1100000-0000-4000-8000-000000000102', 'a1100000-0000-4000-8000-000000000001', 'Bay 2', 'bay', true, 2),
  ('a1100000-0000-4000-8000-000000000103', 'a1100000-0000-4000-8000-000000000001', 'Bay 3', 'bay', true, 3),
  ('a1100000-0000-4000-8000-000000000104', 'a1100000-0000-4000-8000-000000000001', 'Mobile van', 'mobile', true, 4),
  ('a1100000-0000-4000-8000-000000000105', 'a1100000-0000-4000-8000-000000000001', 'Old bay', 'bay', false, 5),
  ('b1100000-0000-4000-8000-000000000101', 'b1100000-0000-4000-8000-000000000001', 'Bay B1', 'bay', true, 1);

insert into public.services (id, garage_id, name, duration_min, buffer_min, price_pence, price_mode, location_mode, resource_kind, online_enabled, min_notice_h, max_days_ahead, is_mot, sort, deleted_at) values
  ('a1100000-0000-4000-8000-000000000201', 'a1100000-0000-4000-8000-000000000001', 'Diagnostics', 60, 15, 4500, 'from', 'both', 'bay', true, 2, 60, false, 1, null),
  ('a1100000-0000-4000-8000-000000000202', 'a1100000-0000-4000-8000-000000000001', 'Full service', 180, 15, 17900, 'from', 'workshop', 'bay', true, 2, 60, false, 2, null),
  ('a1100000-0000-4000-8000-000000000203', 'a1100000-0000-4000-8000-000000000001', 'MOT', 60, 0, 5485, 'fixed', 'workshop', 'bay', true, 2, 60, true, 3, null),
  ('a1100000-0000-4000-8000-000000000204', 'a1100000-0000-4000-8000-000000000001', 'Offline', 60, 0, null, 'quote', 'workshop', 'bay', false, 2, 60, false, 4, null),
  ('a1100000-0000-4000-8000-000000000205', 'a1100000-0000-4000-8000-000000000001', 'Deleted', 60, 0, null, 'quote', 'workshop', 'bay', true, 2, 60, false, 5, now()),
  ('a1100000-0000-4000-8000-000000000206', 'a1100000-0000-4000-8000-000000000001', 'Mobile battery', 45, 0, 9000, 'fixed', 'mobile', 'mobile', true, 2, 60, false, 6, null),
  ('b1100000-0000-4000-8000-000000000201', 'b1100000-0000-4000-8000-000000000001', 'B Diagnostics', 60, 0, 4000, 'fixed', 'workshop', 'bay', true, 2, 60, false, 1, null),
  ('b1100000-0000-4000-8000-000000000202', 'b1100000-0000-4000-8000-000000000001', 'B MOT', 60, 0, 5485, 'fixed', 'workshop', 'bay', true, 2, 60, true, 2, null);

insert into public.customers (id, garage_id, name, phone, preferred_contact) values
  ('a1100000-0000-4000-8000-000000000301', 'a1100000-0000-4000-8000-000000000001', 'Slots Customer', '+447700900311', 'phone');
insert into public.vehicles (id, garage_id, customer_id, registration) values
  ('a1100000-0000-4000-8000-000000000401', 'a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000301', 'SL12AAA');

-- The engine's first argument pair, for brevity.
create function pg_temp.starts(p_service uuid, p_from date, p_to date, p_now timestamptz, p_mode text default null)
returns setof timestamptz
language sql
as $$
  select slot.starts_at
  from public.available_slots_at('a1100000-0000-4000-8000-000000000001', p_service, p_from, p_to, p_mode, p_now) slot
  order by slot.starts_at
$$;

create function pg_temp.free_at(p_service uuid, p_day date, p_times text[], p_mode text default null, p_now timestamptz default '2026-10-28 12:00+00')
returns integer[]
language sql
as $$
  select array_agg(coalesce(slot.free_count, -1) order by wanted.position)
  from unnest(p_times) with ordinality wanted(local_time, position)
  left join public.available_slots_at('a1100000-0000-4000-8000-000000000001', p_service, p_day, p_day, p_mode, p_now) slot
    on slot.starts_at = (p_day + wanted.local_time::time) at time zone 'Europe/London'
$$;

create function pg_temp.slots_error(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'no error';
exception
  when others then
    return sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end
$$;

-- ---------------------------------------------------------------------------
-- A normal weekday: Monday 2 November 2026 (GMT)
-- ---------------------------------------------------------------------------

select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', '2026-10-28 12:00+00')$$,
  $$select generate_series('2026-11-02 08:00+00'::timestamptz, '2026-11-02 16:30+00', interval '15 minutes')$$,
  'a 60-minute service starts every 15 minutes from 08:00 while it ends by 17:30'
);
select is(
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', null, '2026-10-28 12:00+00')),
  35, '35 starts on a normal weekday'
);
select is(
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', null, '2026-10-28 12:00+00')
   where ends_at <> starts_at + interval '60 minutes' or free_count <> 3),
  0, 'each slot ends after the service duration and has all 3 bays free'
);
select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000202', '2026-11-02', '2026-11-02', '2026-10-28 12:00+00')$$,
  $$select generate_series('2026-11-02 08:00+00'::timestamptz, '2026-11-02 14:30+00', interval '15 minutes')$$,
  'a 180-minute service: the last start is 14:30'
);
update public.garages set slot_step_min = 30 where id = 'a1100000-0000-4000-8000-000000000001';
select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', '2026-10-28 12:00+00')$$,
  $$select generate_series('2026-11-02 08:00+00'::timestamptz, '2026-11-02 16:30+00', interval '30 minutes')$$,
  'starts follow the garage''s slot step (30 minutes)'
);
update public.garages set slot_step_min = 15 where id = 'a1100000-0000-4000-8000-000000000001';
select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000201', '2026-11-04', '2026-11-04', '2026-10-28 12:00+00')$$,
  $$select generate_series('2026-11-04 08:00+00'::timestamptz, '2026-11-04 11:00+00', interval '15 minutes')
    union all select generate_series('2026-11-04 13:00+00'::timestamptz, '2026-11-04 16:30+00', interval '15 minutes')$$,
  'a split day starts from each window''s opening and no job spans the break'
);
select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000201', '2026-11-07', '2026-11-07', '2026-10-28 12:00+00')$$,
  $$select generate_series('2026-11-07 08:30+00'::timestamptz, '2026-11-07 12:00+00', interval '15 minutes')$$,
  'Saturday 08:30-13:00: starts from 08:30'
);

-- ---------------------------------------------------------------------------
-- Clock changes: Sunday 29 March 2026 (GMT -> BST) and Sunday 25 October 2026
-- (BST -> GMT). Open 08:00-17:30 London both days.
-- ---------------------------------------------------------------------------

select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000201', '2026-03-29', '2026-03-29', '2026-03-20 12:00+00')$$,
  $$select generate_series('2026-03-29 07:00+00'::timestamptz, '2026-03-29 15:30+00', interval '15 minutes')$$,
  '29 Mar 2026 (BST from 01:00 UTC): 08:00-16:30 London is 07:00-15:30 UTC'
);
select is(
  (select count(*)::integer || ' ' || min(to_char(starts_at at time zone 'Europe/London', 'HH24:MI')) || '-' || max(to_char(starts_at at time zone 'Europe/London', 'HH24:MI'))
   from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-03-29', '2026-03-29', null, '2026-03-20 12:00+00')),
  '35 08:00-16:30', '29 Mar 2026: 35 starts from 08:00 to 16:30 local time'
);
select is(
  array(select min(starts_at) from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-03-27', '2026-03-30', null, '2026-03-20 12:00+00')
        group by (starts_at at time zone 'Europe/London')::date order by 1),
  array['2026-03-27 08:00+00', '2026-03-28 08:30+00', '2026-03-29 07:00+00', '2026-03-30 07:00+00']::timestamptz[],
  'the first start moves from 08:00 UTC to 07:00 UTC across the spring change'
);
select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000201', '2026-10-25', '2026-10-25', '2026-10-15 12:00+00')$$,
  $$select generate_series('2026-10-25 08:00+00'::timestamptz, '2026-10-25 16:30+00', interval '15 minutes')$$,
  '25 Oct 2026 (GMT from 01:00 UTC): 08:00-16:30 London is 08:00-16:30 UTC'
);
select is(
  (select count(*)::integer || ' ' || min(to_char(starts_at at time zone 'Europe/London', 'HH24:MI')) || '-' || max(to_char(starts_at at time zone 'Europe/London', 'HH24:MI'))
   from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-10-25', '2026-10-25', null, '2026-10-15 12:00+00')),
  '35 08:00-16:30', '25 Oct 2026: 35 starts from 08:00 to 16:30 local time'
);
select is(
  array(select min(starts_at) from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-10-23', '2026-10-26', null, '2026-10-15 12:00+00')
        group by (starts_at at time zone 'Europe/London')::date order by 1),
  array['2026-10-23 07:00+00', '2026-10-24 07:30+00', '2026-10-25 08:00+00', '2026-10-26 08:00+00']::timestamptz[],
  'the first start moves from 07:00 UTC to 08:00 UTC across the autumn change'
);
select is(
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000202', '2026-10-25', '2026-10-25', null, '2026-10-15 12:00+00')
   where ends_at <> starts_at + interval '180 minutes'),
  0, 'durations are real minutes on the change day'
);
set local timezone to 'Pacific/Auckland';
select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000201', '2026-03-29', '2026-03-29', '2026-03-20 12:00+00')$$,
  $$select generate_series('2026-03-29 07:00+00'::timestamptz, '2026-03-29 15:30+00', interval '15 minutes')$$,
  'the session time zone does not change the slots (garage time zone only)'
);
set local timezone to 'UTC';

-- ---------------------------------------------------------------------------
-- Notice, booking window, closures, past dates
-- ---------------------------------------------------------------------------

select results_eq(
  $$select * from pg_temp.starts('a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', '2026-11-02 09:10+00')$$,
  $$select generate_series('2026-11-02 11:15+00'::timestamptz, '2026-11-02 16:30+00', interval '15 minutes')$$,
  'starts sooner than min_notice_h (2 h) are dropped'
);
select is(
  (select min(starts_at) from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', null, '2026-11-02 09:00+00')),
  '2026-11-02 11:00+00'::timestamptz, 'a start exactly min_notice_h ahead is kept'
);
select is(
  (select count(*)::integer || ' ' || max(starts_at)::text from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-12-27', '2026-12-28', null, '2026-10-28 12:00+00')),
  '17 2026-12-27 12:00:00+00', 'starts after now + max_days_ahead (60 days) are dropped'
);
select is(
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-12-25', '2026-12-26', null, '2026-10-28 12:00+00')),
  0, 'no starts on closure days'
);
select is(
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-12-24', '2026-12-24', null, '2026-10-28 12:00+00')),
  35, 'the day before a closure is open as usual'
);
select is(
  (select count(*)::integer || ' ' || min(starts_at)::text from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-10-01', '2026-10-28', null, '2026-10-28 12:00+00')),
  '11 2026-10-28 14:00:00+00', 'past days are skipped and today starts after the notice period'
);

-- ---------------------------------------------------------------------------
-- free_count: 3 bays, buffers, cancelled bookings, other resources
-- ---------------------------------------------------------------------------

-- Bay 1: Diagnostics 10:00-11:00 (+15 min buffer) on Monday 2 Nov.
insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  ('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000301', 'a1100000-0000-4000-8000-000000000401', 'a1100000-0000-4000-8000-000000000201',
   'a1100000-0000-4000-8000-000000000101', '2026-11-02 10:00+00', '2026-11-02 11:00+00', '[2026-11-02 10:00+00,2026-11-02 11:15+00)', 'confirmed', 'online');

select is(
  pg_temp.free_at('a1100000-0000-4000-8000-000000000201', '2026-11-02', array['08:45', '09:00', '10:00', '11:00', '11:15']),
  array[3, 2, 2, 2, 3],
  'one booking takes one bay; its buffer blocks 11:00 and the candidate''s own buffer may touch 10:00'
);

insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  ('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000301', 'a1100000-0000-4000-8000-000000000401', 'a1100000-0000-4000-8000-000000000201',
   'a1100000-0000-4000-8000-000000000102', '2026-11-02 10:00+00', '2026-11-02 11:00+00', '[2026-11-02 10:00+00,2026-11-02 11:15+00)', 'requested', 'online'),
  ('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000301', 'a1100000-0000-4000-8000-000000000401', 'a1100000-0000-4000-8000-000000000201',
   'a1100000-0000-4000-8000-000000000103', '2026-11-02 10:00+00', '2026-11-02 11:00+00', '[2026-11-02 10:00+00,2026-11-02 11:15+00)', 'in_progress', 'phone'),
  ('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000301', 'a1100000-0000-4000-8000-000000000401', 'a1100000-0000-4000-8000-000000000201',
   'a1100000-0000-4000-8000-000000000101', '2026-11-02 14:00+00', '2026-11-02 15:00+00', '[2026-11-02 14:00+00,2026-11-02 15:15+00)', 'cancelled', 'online'),
  ('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000301', 'a1100000-0000-4000-8000-000000000401', 'a1100000-0000-4000-8000-000000000201',
   'a1100000-0000-4000-8000-000000000102', '2026-11-02 15:00+00', '2026-11-02 16:00+00', '[2026-11-02 15:00+00,2026-11-02 16:15+00)', 'no_show', 'online'),
  ('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000301', 'a1100000-0000-4000-8000-000000000401', 'a1100000-0000-4000-8000-000000000201',
   'a1100000-0000-4000-8000-000000000105', '2026-11-02 13:00+00', '2026-11-02 14:00+00', '[2026-11-02 13:00+00,2026-11-02 14:15+00)', 'confirmed', 'phone');
-- Mobile van: a mobile Diagnostics visit at 13:00 (30 min travel each way).
insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source, location_mode, postcode) values
  ('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000301', 'a1100000-0000-4000-8000-000000000401', 'a1100000-0000-4000-8000-000000000201',
   'a1100000-0000-4000-8000-000000000104', '2026-11-02 13:00+00', '2026-11-02 14:00+00', '[2026-11-02 12:30+00,2026-11-02 14:45+00)', 'confirmed', 'online', 'mobile', 'DN4 8AB');

select is(
  (select free_count from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', null, '2026-10-28 12:00+00')
   where starts_at = '2026-11-02 10:00+00'),
  0, 'with all 3 bays booked the start is still returned, with free_count 0'
);
select is(
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', null, '2026-10-28 12:00+00')),
  35, 'every candidate start is returned whatever its free count'
);
select is(
  pg_temp.free_at('a1100000-0000-4000-8000-000000000201', '2026-11-02', array['13:00', '14:00', '15:00']),
  array[3, 3, 3],
  'cancelled and no-show bookings, inactive bays and the van do not reduce the bays'' free count'
);
select is(
  pg_temp.free_at('a1100000-0000-4000-8000-000000000202', '2026-11-02', array['08:00', '11:00', '11:15']),
  array[0, 0, 3],
  'a 180-minute service with its 15-minute buffer needs the bay until the job and buffer end'
);
select is(
  pg_temp.free_at('a1100000-0000-4000-8000-000000000201', '2026-11-02', array['10:45', '11:00', '14:45', '15:15'], 'mobile'),
  array[1, 0, 0, 1],
  'mobile visits block the van for 30 minutes of travel before and after'
);
select is(
  (select count(*)::integer || ' ' || min(starts_at)::text || ' ' || max(starts_at)::text
   from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', 'mobile', '2026-10-28 12:00+00')),
  '35 2026-11-02 08:00:00+00 2026-11-02 16:30:00+00',
  'mobile appointments keep to opening hours; travel may fall outside them'
);
select is(
  pg_temp.free_at('a1100000-0000-4000-8000-000000000206', '2026-11-02', array['08:00', '13:00', '16:45']),
  array[1, 0, 1],
  'a mobile-only service defaults to a mobile visit and uses the van'
);
select is(
  pg_temp.free_at('a1100000-0000-4000-8000-000000000201', '2026-11-02', array['13:00'], 'workshop'),
  array[3],
  'a workshop visit of a both-ways service ignores the van'
);
select is(
  (select bool_and(free_count = 1) and count(*) = 35
   from public.available_slots_at('b1100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000201', '2026-11-02', '2026-11-02', null, '2026-10-28 12:00+00')),
  true, 'garage B''s one bay is free all day: garage A''s bookings never count'
);

-- ---------------------------------------------------------------------------
-- Services that cannot be booked, and bad arguments
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000203', '2026-11-03', '2026-11-03', null, '2026-10-28 12:00+00')),
  35, 'MOT services have slots where the garage has MOT switched on'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('b1100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000202', '2026-11-03', '2026-11-03', null, '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'MOT services are unavailable where MOT is off'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000204', '2026-11-03', '2026-11-03', null, '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'services not enabled online are unavailable'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000205', '2026-11-03', '2026-11-03', null, '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'deleted services are unavailable'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('b1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-03', '2026-11-03', null, '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'garage B cannot see slots for garage A''s service'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', gen_random_uuid(), '2026-11-03', '2026-11-03', null, '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'an unknown service is unavailable'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000202', '2026-11-03', '2026-11-03', 'mobile', '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'a workshop-only service has no mobile visits'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000206', '2026-11-03', '2026-11-03', 'workshop', '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'a mobile-only service has no workshop visits'
);
update public.garages set status = 'suspended' where id = 'a1100000-0000-4000-8000-000000000001';
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-03', '2026-11-03', null, '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'a suspended garage has no slots'
);
update public.garages set status = 'active' where id = 'a1100000-0000-4000-8000-000000000001';
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-04', '2026-11-03', null, '2026-10-28 12:00+00')$$),
  'P0001 INVALID_BOOKING', 'from after to is invalid'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', null, '2026-11-03', null, '2026-10-28 12:00+00')$$),
  'P0001 INVALID_BOOKING', 'a missing date is invalid'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-11-03', '2026-11-03', 'boat', '2026-10-28 12:00+00')$$),
  'P0001 INVALID_BOOKING', 'an unknown location mode is invalid'
);
select is(
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2020-01-01', '2099-12-31', null, '2026-10-28 12:00+00')),
  (select count(*)::integer from public.available_slots_at('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', '2026-10-28', '2026-12-27', null, '2026-10-28 12:00+00')),
  'a huge date range is clamped to today .. now + max_days_ahead'
);

-- ---------------------------------------------------------------------------
-- available_slots() is available_slots_at(..., now())
-- ---------------------------------------------------------------------------

select results_eq(
  $$select starts_at, ends_at, free_count from public.available_slots(
      'a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201',
      (date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date,
      (date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date + 6)$$,
  $$select starts_at, ends_at, free_count from public.available_slots_at(
      'a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201',
      (date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date,
      (date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date + 6, null, now())$$,
  'available_slots() returns the same rows as the engine at now()'
);
select ok(
  (select count(*) > 0 from public.available_slots(
     'a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201',
     (date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date,
     (date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date + 6, 'workshop')),
  'available_slots() takes an explicit location mode'
);
set local role service_role;
select lives_ok(
  $$select * from public.available_slots('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', current_date, current_date + 7)$$,
  'the service role can call available_slots()'
);
reset role;
set local role authenticated;
select throws_ok(
  $$select * from public.available_slots('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', current_date, current_date + 7)$$,
  '42501', null, 'signed-in staff cannot call available_slots() directly'
);
reset role;
set local role anon;
select throws_ok(
  $$select * from public.available_slots('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000201', current_date, current_date + 7)$$,
  '42501', null, 'anon cannot call available_slots()'
);
reset role;

-- ---------------------------------------------------------------------------
-- seed_garage_defaults(): hours, 3 bays + 1 van, 6 services, once
-- ---------------------------------------------------------------------------

set local role service_role;
select is(
  public.seed_garage_defaults('c1100000-0000-4000-8000-000000000001') - 'reminder_rules',
  '{"services": 6, "resources": 4, "opening_hours": 6}'::jsonb,
  'seed_garage_defaults creates opening hours, 3 bays and a van, and 6 services (reminder rules: 013)'
);
select is(
  public.seed_garage_defaults('c1100000-0000-4000-8000-000000000001') - 'reminder_rules',
  '{"services": 0, "resources": 0, "opening_hours": 0}'::jsonb,
  'running it again adds nothing'
);
select throws_ok(
  $$select public.seed_garage_defaults(gen_random_uuid())$$,
  'P0001', 'GARAGE_NOT_FOUND', 'an unknown garage is refused'
);
reset role;
select is(
  (select string_agg(kind || ':' || count, ',' order by kind) from (
     select kind, count(*) from public.resources where garage_id = 'c1100000-0000-4000-8000-000000000001' group by kind) resource_counts),
  'bay:3,mobile:1', 'the defaults are 3 bays and 1 mobile van'
);
select is(
  (select bool_and(free_count = 3) and count(*) = 35
   from public.available_slots_at('c1100000-0000-4000-8000-000000000001',
     (select id from public.services where garage_id = 'c1100000-0000-4000-8000-000000000001' and name = 'Diagnostics'),
     '2026-11-02', '2026-11-02', 'workshop', '2026-10-28 12:00+00')),
  true, 'a garage with default settings has 35 Monday starts across 3 bays'
);
select is(
  pg_temp.slots_error($$select * from public.available_slots_at('c1100000-0000-4000-8000-000000000001',
     (select id from public.services where garage_id = 'c1100000-0000-4000-8000-000000000001' and is_mot),
     '2026-11-02', '2026-11-02', null, '2026-10-28 12:00+00')$$),
  'P0001 SERVICE_UNAVAILABLE', 'the default MOT service stays unavailable until MOT is switched on'
);
update public.garages set mot_enabled = true where id = 'c1100000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from public.available_slots_at('c1100000-0000-4000-8000-000000000001',
     (select id from public.services where garage_id = 'c1100000-0000-4000-8000-000000000001' and is_mot),
     '2026-11-02', '2026-11-02', null, '2026-10-28 12:00+00')),
  35, 'switching MOT on makes the default MOT service bookable'
);

select * from finish();
rollback;
