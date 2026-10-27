begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(71);

-- Staff bookings (A90 follow-up, migration 20261028002200, DECISIONS
-- A176-A185). Online bookings keep every rule. Phone and walk-in bookings
-- made by a member of the garage (owner, manager, technician or front desk;
-- create_booking_at's `staff` object) may
-- ignore online_enabled, the notice period, the booking window and approval,
-- but never opening hours or closures unless the member overrides them, and
-- never the service area, the MOT switch, another garage or a bay that is
-- already taken.
--
-- "Now" is Wed 28 Oct 2026 12:00 UTC (12:00 London, after the clock change)
-- unless a test says otherwise.
-- Garage S (STF): Mon-Fri 08:00-17:30, Sat 08:30-13:00, Sunday closed,
-- closed Fri 6 Nov, 15-minute step, MOT off, mobile area DN4. One bay and a
-- van. Every service has 24 h notice and a 30-day window.
-- Garage O (STO): one bay, every day 08:00-17:30, its own owner.

insert into auth.users (id, email, raw_user_meta_data) values
  ('12500000-0000-4000-8000-0000000000a1', 'staff-owner-s@pgtap.test', '{}'::jsonb),
  ('12500000-0000-4000-8000-0000000000a2', 'staff-technician-s@pgtap.test', '{}'::jsonb),
  ('12500000-0000-4000-8000-0000000000a3', 'staff-front-desk-s@pgtap.test', '{}'::jsonb),
  ('12500000-0000-4000-8000-0000000000b1', 'staff-owner-o@pgtap.test', '{}'::jsonb),
  ('12500000-0000-4000-8000-0000000000c1', 'not-a-member@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix, mot_enabled, service_area, mobile_travel_min, status) values
  ('a2500000-0000-4000-8000-000000000001', 'pgtap-staff-s', 'Staff Garage S', 'STF', false, '{DN4}', 30, 'active'),
  ('b2500000-0000-4000-8000-000000000001', 'pgtap-staff-o', 'Staff Garage O', 'STO', false, '{}', 30, 'active');

insert into public.garage_members (garage_id, user_id, role) values
  ('a2500000-0000-4000-8000-000000000001', '12500000-0000-4000-8000-0000000000a1', 'owner'),
  ('a2500000-0000-4000-8000-000000000001', '12500000-0000-4000-8000-0000000000a2', 'technician'),
  ('a2500000-0000-4000-8000-000000000001', '12500000-0000-4000-8000-0000000000a3', 'front_desk'),
  ('b2500000-0000-4000-8000-000000000001', '12500000-0000-4000-8000-0000000000b1', 'owner');

insert into public.opening_hours (garage_id, weekday, opens, closes)
select 'a2500000-0000-4000-8000-000000000001'::uuid, weekday::smallint, time '08:00', time '17:30' from generate_series(1, 5) weekday
union all select 'a2500000-0000-4000-8000-000000000001', 6, '08:30', '13:00'
union all select 'b2500000-0000-4000-8000-000000000001', weekday, '08:00', '17:30' from generate_series(1, 7) weekday;
insert into public.closures (garage_id, starts_on, ends_on, reason) values
  ('a2500000-0000-4000-8000-000000000001', '2026-11-06', '2026-11-06', 'Training day');

insert into public.resources (id, garage_id, name, kind, sort) values
  ('a2500000-0000-4000-8000-000000000101', 'a2500000-0000-4000-8000-000000000001', 'Bay 1', 'bay', 1),
  ('a2500000-0000-4000-8000-000000000102', 'a2500000-0000-4000-8000-000000000001', 'Van', 'mobile', 2),
  ('b2500000-0000-4000-8000-000000000101', 'b2500000-0000-4000-8000-000000000001', 'Bay O1', 'bay', 1);

insert into public.services (id, garage_id, name, duration_min, buffer_min, price_pence, price_mode, location_mode, resource_kind,
                             online_enabled, needs_approval, is_mot, min_notice_h, max_days_ahead, deleted_at) values
  ('a2500000-0000-4000-8000-000000000201', 'a2500000-0000-4000-8000-000000000001', 'Diagnostics', 60, 15, 4500, 'from', 'both', 'bay', true, false, false, 24, 30, null),
  ('a2500000-0000-4000-8000-000000000202', 'a2500000-0000-4000-8000-000000000001', 'Clutch (phone only)', 60, 0, null, 'quote', 'workshop', 'bay', false, false, false, 24, 30, null),
  ('a2500000-0000-4000-8000-000000000203', 'a2500000-0000-4000-8000-000000000001', 'Brakes', 90, 15, null, 'quote', 'workshop', 'bay', true, true, false, 24, 30, null),
  ('a2500000-0000-4000-8000-000000000204', 'a2500000-0000-4000-8000-000000000001', 'MOT', 60, 0, 5485, 'fixed', 'workshop', 'bay', false, false, true, 24, 30, null),
  ('a2500000-0000-4000-8000-000000000205', 'a2500000-0000-4000-8000-000000000001', 'Deleted', 60, 0, null, 'quote', 'workshop', 'bay', false, false, false, 24, 30, now()),
  ('b2500000-0000-4000-8000-000000000201', 'b2500000-0000-4000-8000-000000000001', 'O Diagnostics', 60, 0, 4000, 'fixed', 'workshop', 'bay', false, false, false, 24, 30, null);

create temp table outcome (label text primary key, result jsonb not null);

-- Garages, members and services, for readability.
create function pg_temp.s() returns text language sql as $$ select 'a2500000-0000-4000-8000-000000000001' $$;
create function pg_temp.o() returns text language sql as $$ select 'b2500000-0000-4000-8000-000000000001' $$;
create function pg_temp.owner() returns text language sql as $$ select '12500000-0000-4000-8000-0000000000a1' $$;
create function pg_temp.tech() returns text language sql as $$ select '12500000-0000-4000-8000-0000000000a2' $$;
create function pg_temp.front_desk() returns text language sql as $$ select '12500000-0000-4000-8000-0000000000a3' $$;
create function pg_temp.o_owner() returns text language sql as $$ select '12500000-0000-4000-8000-0000000000b1' $$;
create function pg_temp.stranger() returns text language sql as $$ select '12500000-0000-4000-8000-0000000000c1' $$;
create function pg_temp.diag() returns text language sql as $$ select 'a2500000-0000-4000-8000-000000000201' $$;
create function pg_temp.offline() returns text language sql as $$ select 'a2500000-0000-4000-8000-000000000202' $$;
create function pg_temp.brakes() returns text language sql as $$ select 'a2500000-0000-4000-8000-000000000203' $$;
create function pg_temp.mot() returns text language sql as $$ select 'a2500000-0000-4000-8000-000000000204' $$;
create function pg_temp.deleted() returns text language sql as $$ select 'a2500000-0000-4000-8000-000000000205' $$;
create function pg_temp.o_diag() returns text language sql as $$ select 'b2500000-0000-4000-8000-000000000201' $$;

create function pg_temp.payload(p_service text, p_start text, p_key integer, p_source text default 'online')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'service_id', p_service,
    'starts_at', p_start,
    'location_mode', 'workshop',
    'source', p_source,
    'idempotency_key', 'c2500000-0000-4000-8000-' || lpad(p_key::text, 12, '0'),
    'customer', jsonb_build_object('name', 'Sam Caller', 'phone', '+447700900' || (700 + p_key)::text, 'channel', 'sms'),
    'vehicle', jsonb_build_object('registration', 'ST' || lpad(p_key::text, 2, '0') || 'AAA')
  )
$$;

-- The `staff` object the admin's staff booking action sends.
create function pg_temp.staff(p_member text, p_override boolean default null)
returns jsonb
language sql
as $$ select jsonb_build_object('staff', jsonb_strip_nulls(jsonb_build_object('member_id', p_member, 'override_hours', p_override))) $$;

create function pg_temp.book(p_label text, p_garage text, p_payload jsonb, p_now timestamptz default '2026-10-28 12:00+00')
returns jsonb
language sql
as $$
  insert into outcome (label, result) values (p_label, public.create_booking_at(p_garage::uuid, p_payload, p_now))
  returning result
$$;

create function pg_temp.book_error(p_garage text, p_payload jsonb, p_now timestamptz default '2026-10-28 12:00+00')
returns text
language plpgsql
as $$
begin
  perform public.create_booking_at(p_garage::uuid, p_payload, p_now);
  return 'no error';
exception
  when others then
    return sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end
$$;

create function pg_temp.status_of(p_label text)
returns text
language sql
as $$ select result->>'status' from outcome where label = p_label $$;

create function pg_temp.event_of(p_label text)
returns public.booking_events
language sql
as $$
  select event.* from public.booking_events event
  join outcome on (outcome.result->>'booking_id')::uuid = event.booking_id
  where outcome.label = p_label and event.type = 'created'
$$;

create function pg_temp.grid(p_service text, p_from date, p_to date, p_member text default '12500000-0000-4000-8000-0000000000a1',
                             p_garage text default 'a2500000-0000-4000-8000-000000000001')
returns table (starts_at timestamptz, ends_at timestamptz, free_count integer)
language sql
as $$
  select * from public.staff_available_slots_at(p_garage::uuid, p_service::uuid, p_from, p_to, null, p_member::uuid, '2026-10-28 12:00+00')
$$;

create function pg_temp.grid_error(p_service text, p_from date, p_to date, p_member text, p_garage text default 'a2500000-0000-4000-8000-000000000001')
returns text
language plpgsql
as $$
begin
  perform * from public.staff_available_slots_at(p_garage::uuid, p_service::uuid, p_from, p_to, null, p_member::uuid, '2026-10-28 12:00+00');
  return 'no error';
exception
  when others then
    return sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end
$$;

-- ---------------------------------------------------------------------------
-- Online bookings (and phone bookings without a member) keep every rule
-- ---------------------------------------------------------------------------

select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-03T10:00:00Z', 1)),
  'P0001 SERVICE_UNAVAILABLE', 'online: a service not offered online is unavailable');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-10-29T10:00:00Z', 1)),
  'P0001 SLOT_UNAVAILABLE', 'online: a start inside the notice period is unavailable');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-12-01T10:00:00Z', 1)),
  'P0001 SLOT_UNAVAILABLE', 'online: a start beyond max_days_ahead is unavailable');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-01T10:00:00Z', 1)),
  'P0001 INVALID_BOOKING', 'online: nothing can be booked on a day without opening hours');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-03T10:05:00Z', 1)),
  'P0001 INVALID_BOOKING', 'online: the start must be on the slot step');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-06T10:00:00Z', 1)),
  'P0001 SLOT_UNAVAILABLE', 'online: a start on a closure day is unavailable');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-03T10:00:00Z', 1, 'phone')),
  'P0001 SERVICE_UNAVAILABLE', 'phone without a member: a service not offered online is still unavailable');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-10-29T10:00:00Z', 1, 'walk_in')),
  'P0001 SLOT_UNAVAILABLE', 'walk-in without a member: the notice period still applies');

select pg_temp.book('online-brakes', pg_temp.s(), pg_temp.payload(pg_temp.brakes(), '2026-11-03T08:00:00Z', 2));
select pg_temp.book('phone-brakes', pg_temp.s(), pg_temp.payload(pg_temp.brakes(), '2026-11-03T10:00:00Z', 3, 'phone'));
update public.garages set approve_online = true where id = pg_temp.s()::uuid;
select pg_temp.book('online-approve', pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-03T13:00:00Z', 4));
update public.garages set approve_online = false where id = pg_temp.s()::uuid;
select is(
  array[pg_temp.status_of('online-brakes'), pg_temp.status_of('phone-brakes'), pg_temp.status_of('online-approve')],
  array['requested', 'requested', 'requested'],
  'without a member, needs_approval and approve_online still make a request'
);

-- ---------------------------------------------------------------------------
-- The staff object: phone or walk-in, and a member of this garage
-- ---------------------------------------------------------------------------

select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5) || pg_temp.staff(pg_temp.owner())),
  'P0001 INVALID_BOOKING', 'an online booking cannot carry staff rules');
select is(
  array(select pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5, source) || pg_temp.staff(pg_temp.owner()))
        from unnest(array['reminder', 'missed_call', 'ai_agent']) source),
  array['P0001 INVALID_BOOKING', 'P0001 INVALID_BOOKING', 'P0001 INVALID_BOOKING'],
  'nor can reminder, missed-call or AI agent bookings'
);
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5, 'phone') || pg_temp.staff(pg_temp.o_owner())),
  'P0001 INVALID_BOOKING', 'another garage''s member cannot book with staff rules here');
select is(pg_temp.book_error(pg_temp.o(), pg_temp.payload(pg_temp.o_diag(), '2026-11-04T10:00:00Z', 5, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 INVALID_BOOKING', 'and this garage''s member cannot book with staff rules in another garage');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5, 'phone') || pg_temp.staff(pg_temp.stranger())),
  'P0001 INVALID_BOOKING', 'a user who is not a member is refused');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5, 'phone') || pg_temp.staff(gen_random_uuid()::text)),
  'P0001 INVALID_BOOKING', 'an unknown user id is refused');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5, 'phone') || '{"staff": {}}'),
  'P0001 INVALID_BOOKING', 'staff.member_id is required');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5, 'phone') || '{"staff": {"member_id": "owner"}}'),
  'P0001 INVALID_BOOKING', 'staff.member_id must be a uuid');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5, 'phone') || '{"staff": "owner"}'),
  'P0001 INVALID_BOOKING', 'staff must be an object');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 5, 'phone')
    || jsonb_build_object('staff', jsonb_build_object('member_id', pg_temp.owner(), 'override_hours', 'yes'))),
  'P0001 INVALID_BOOKING', 'staff.override_hours must be true or false');
select is(
  (select count(*)::integer from public.bookings where garage_id = pg_temp.s()::uuid)
  || '/' || (select count(*)::integer from public.bookings where garage_id = pg_temp.o()::uuid)
  || '/' || (select count(*)::integer from public.customers where garage_id in (pg_temp.s()::uuid, pg_temp.o()::uuid) and phone = '+447700900705'),
  '3/0/0', 'refused staff attempts leave no booking or customer behind'
);

-- ---------------------------------------------------------------------------
-- Members may ignore online_enabled, notice, the booking window and approval
-- ---------------------------------------------------------------------------

select pg_temp.book('staff-offline', pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 10, 'phone') || pg_temp.staff(pg_temp.owner()));
select is(pg_temp.status_of('staff-offline'), 'confirmed', 'a member can book a service that is not offered online');
select pg_temp.book('staff-today', pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-10-28T14:00:00Z', 11, 'walk_in') || pg_temp.staff(pg_temp.tech()));
select is(pg_temp.status_of('staff-today'), 'confirmed', 'a technician can book a walk-in later today, inside the notice period');
select pg_temp.book('staff-earlier', pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-10-28T09:00:00Z', 12, 'walk_in') || pg_temp.staff(pg_temp.tech()));
select is(pg_temp.status_of('staff-earlier'), 'confirmed', 'a walk-in that came in earlier today can still be recorded');
select pg_temp.book('staff-front-desk', pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-05T11:00:00Z', 18, 'walk_in') || pg_temp.staff(pg_temp.front_desk()));
select is(
  (select pg_temp.status_of('staff-front-desk') || '|' || event.actor_id::text from pg_temp.event_of('staff-front-desk') event),
  'confirmed|12500000-0000-4000-8000-0000000000a3', 'a front-desk member takes phone and walk-in bookings with the staff rules'
);
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-10-27T10:00:00Z', 13, 'walk_in') || pg_temp.staff(pg_temp.tech())),
  'P0001 SLOT_UNAVAILABLE', 'but not on a day that has gone');
select pg_temp.book('staff-far', pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-12-01T10:00:00Z', 14, 'phone') || pg_temp.staff(pg_temp.owner()));
select is(pg_temp.status_of('staff-far'), 'confirmed', 'a member can book beyond the online booking window');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2028-11-07T10:00:00Z', 15, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 SLOT_UNAVAILABLE', 'but not more than two years ahead');
select pg_temp.book('staff-brakes', pg_temp.s(), pg_temp.payload(pg_temp.brakes(), '2026-11-05T09:00:00Z', 16, 'phone') || pg_temp.staff(pg_temp.owner()));
update public.garages set approve_online = true where id = pg_temp.s()::uuid;
select pg_temp.book('staff-approve', pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-05T13:00:00Z', 17, 'walk_in') || pg_temp.staff(pg_temp.owner()));
update public.garages set approve_online = false where id = pg_temp.s()::uuid;
select is(
  array[pg_temp.status_of('staff-brakes'), pg_temp.status_of('staff-approve')],
  array['confirmed', 'confirmed'],
  'a member''s booking is confirmed straight away, whatever needs_approval and approve_online say'
);
select is(
  (select concat_ws('|', booking.source, booking.status, resource.name, booking.during = tstzrange('2026-11-04 10:00+00', '2026-11-04 11:00+00', '[)'))
   from public.bookings booking join public.resources resource on resource.id = booking.resource_id
   join outcome on (outcome.result->>'booking_id')::uuid = booking.id where outcome.label = 'staff-offline'),
  'phone|confirmed|Bay 1|t', 'the staff booking keeps its source and holds the bay for the job'
);

-- ---------------------------------------------------------------------------
-- Opening hours and closures apply unless the member overrides them
-- ---------------------------------------------------------------------------

select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-01T10:00:00Z', 20, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 INVALID_BOOKING', 'staff: nothing on a day without opening hours');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-01T10:00:00Z', 20, 'phone') || pg_temp.staff(pg_temp.owner(), false)),
  'P0001 INVALID_BOOKING', 'staff: override_hours false changes nothing');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-03T17:00:00Z', 20, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 INVALID_BOOKING', 'staff: the job must end by closing time');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-04T12:05:00Z', 20, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 INVALID_BOOKING', 'staff: the start must be on the slot step');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-06T10:00:00Z', 20, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 SLOT_UNAVAILABLE', 'staff: a closure day is unavailable');
select pg_temp.book('override-sunday', pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-01T10:00:00Z', 21, 'phone') || pg_temp.staff(pg_temp.owner(), true));
select pg_temp.book('override-closure', pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-06T10:00:00Z', 22, 'phone') || pg_temp.staff(pg_temp.owner(), true));
select pg_temp.book('override-late', pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-04T17:07:00Z', 23, 'walk_in') || pg_temp.staff(pg_temp.tech(), true));
select is(
  array[pg_temp.status_of('override-sunday'), pg_temp.status_of('override-closure'), pg_temp.status_of('override-late')],
  array['confirmed', 'confirmed', 'confirmed'],
  'an explicit override books a closed day, a closure day, or any minute after hours'
);
select is(
  (select array[(result->>'starts_at')::timestamptz, (result->>'ends_at')::timestamptz] from outcome where label = 'override-late'),
  array['2026-11-04 17:07+00', '2026-11-04 18:07+00']::timestamptz[], 'an overridden start keeps the service''s length'
);
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-04T18:30:30Z', 24, 'walk_in') || pg_temp.staff(pg_temp.owner(), true)),
  'P0001 INVALID_BOOKING', 'an overridden start is still a whole minute');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-10-27T10:00:00Z', 24, 'walk_in') || pg_temp.staff(pg_temp.owner(), true)),
  'P0001 SLOT_UNAVAILABLE', 'an override cannot book a day that has gone');

-- ---------------------------------------------------------------------------
-- Never a taken bay, the service area, the MOT switch or another garage
-- ---------------------------------------------------------------------------

select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-03T10:00:00Z', 30, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 SLOT_UNAVAILABLE', 'staff cannot double-book the only bay');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-03T10:31:00Z', 30, 'phone') || pg_temp.staff(pg_temp.owner(), true)),
  'P0001 SLOT_UNAVAILABLE', 'nor with an override');
select throws_ok(
  format($$insert into public.bookings (garage_id, reference, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source)
           select garage_id, 'STF-99999', customer_id, vehicle_id, service_id, resource_id, starts_at + interval '30 minutes', ends_at + interval '30 minutes',
                  tstzrange(lower(during) + interval '30 minutes', upper(during) + interval '30 minutes'), 'confirmed', 'phone'
           from public.bookings where id = %L$$, (select result->>'booking_id' from outcome where label = 'phone-brakes')),
  '23P01', null, 'the no_overlap constraint still refuses an overlapping row'
);
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.mot(), '2026-11-04T13:00:00Z', 31, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 SERVICE_UNAVAILABLE', 'staff cannot book MOT where MOT is off');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.deleted(), '2026-11-04T13:00:00Z', 31, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 SERVICE_UNAVAILABLE', 'staff cannot book a deleted service');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.o_diag(), '2026-11-04T13:00:00Z', 31, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 SERVICE_UNAVAILABLE', 'staff cannot book another garage''s service');
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.diag(), '2026-11-04T13:00:00Z', 31, 'phone')
    || '{"location_mode": "mobile", "postcode": "S60 1AA", "address": "1 Far Street"}' || pg_temp.staff(pg_temp.owner(), true)),
  'P0001 OUTSIDE_SERVICE_AREA', 'staff cannot send the van outside the service area');
update public.garages set status = 'suspended' where id = pg_temp.s()::uuid;
select is(pg_temp.book_error(pg_temp.s(), pg_temp.payload(pg_temp.offline(), '2026-11-04T13:00:00Z', 31, 'phone') || pg_temp.staff(pg_temp.owner())),
  'P0001 SERVICE_UNAVAILABLE', 'staff cannot book while the garage is suspended');
update public.garages set status = 'active' where id = pg_temp.s()::uuid;
select is(
  (select count(*)::integer from public.bookings where garage_id = pg_temp.o()::uuid),
  0, 'nothing was booked in garage O'
);

-- ---------------------------------------------------------------------------
-- The timeline names the member; replays still return the booking
-- ---------------------------------------------------------------------------

select is(
  (select concat_ws('|', event.actor, event.actor_id::text, event.data->>'staff_rules', event.data ? 'hours_override', event.data->>'status')
   from pg_temp.event_of('staff-offline') event),
  'staff|12500000-0000-4000-8000-0000000000a1|true|f|confirmed', 'the created event records the member and the staff rules'
);
select is(
  (select concat_ws('|', event.actor_id::text, event.data->>'hours_override') from pg_temp.event_of('override-late') event),
  '12500000-0000-4000-8000-0000000000a2|true', 'an override is recorded on the event'
);
select is(
  (select concat_ws('|', a.actor, coalesce(a.actor_id::text, '-'), a.data ? 'staff_rules', b.actor, coalesce(b.actor_id::text, '-'), b.data ? 'staff_rules')
   from pg_temp.event_of('online-brakes') a, pg_temp.event_of('phone-brakes') b),
  'customer|-|f|staff|-|f', 'bookings without a member record no member and no staff rules'
);
select is(
  (public.create_booking_at(pg_temp.s()::uuid, pg_temp.payload(pg_temp.offline(), '2026-11-04T10:00:00Z', 10, 'phone') || pg_temp.staff(pg_temp.owner()), '2026-10-28 12:00+00')
     - 'replayed'),
  (select result - 'replayed' from outcome where label = 'staff-offline'),
  'the same idempotency key returns the same staff booking'
);

-- ---------------------------------------------------------------------------
-- The staff time grid
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from pg_temp.grid(pg_temp.offline(), '2026-10-28', '2026-10-28')),
  35, 'the staff grid lists every start today (08:00-16:30), notice or not, for a service not offered online');
select is(
  (select array_agg(free_count order by starts_at) from pg_temp.grid(pg_temp.offline(), '2026-10-28', '2026-10-28')
   where starts_at in ('2026-10-28 09:00+00', '2026-10-28 14:00+00', '2026-10-28 16:30+00')),
  array[0, 0, 1], 'starts the bay is busy for are taken'
);
select is(
  (select count(*)::integer from pg_temp.grid(pg_temp.diag(), '2026-11-01', '2026-11-01'))
  + (select count(*)::integer from pg_temp.grid(pg_temp.diag(), '2026-11-06', '2026-11-06')),
  0, 'the staff grid offers nothing on a closed day or a closure'
);
select is((select count(*)::integer from pg_temp.grid(pg_temp.diag(), '2026-12-01', '2026-12-01')),
  35, 'the staff grid reaches beyond the online booking window');
select is((select count(*)::integer from pg_temp.grid(pg_temp.offline(), '2026-10-28', '2026-10-28', pg_temp.front_desk())),
  35, 'front desk sees the staff grid too');
select is((select count(*)::integer from pg_temp.grid(pg_temp.diag(), '2026-10-20', '2026-10-27')),
  0, 'the staff grid starts today');
select is(
  (select count(*)::integer from public.available_slots_at(pg_temp.s()::uuid, pg_temp.diag()::uuid, '2026-10-28', '2026-10-29', null, '2026-10-28 12:00+00')
   where starts_at < '2026-10-29 12:00+00'),
  0, 'the online grid still keeps the notice period'
);
select throws_ok(
  $$select * from public.available_slots_at('a2500000-0000-4000-8000-000000000001', 'a2500000-0000-4000-8000-000000000202', '2026-11-03', '2026-11-03', null, '2026-10-28 12:00+00')$$,
  'P0001', 'SERVICE_UNAVAILABLE', 'the online grid still refuses a service not offered online'
);
select throws_ok(
  $$select * from public.booking_service_context('a2500000-0000-4000-8000-000000000001', 'a2500000-0000-4000-8000-000000000202', null)$$,
  'P0001', 'SERVICE_UNAVAILABLE', 'the three-argument service context keeps the online rule'
);
select is(
  (select duration_min from public.booking_service_context('a2500000-0000-4000-8000-000000000001', 'a2500000-0000-4000-8000-000000000202', null, true)),
  60, 'the staff service context includes services not offered online'
);
select is(
  array[pg_temp.grid_error(pg_temp.offline(), '2026-10-28', '2026-10-28', pg_temp.o_owner()),
        pg_temp.grid_error(pg_temp.offline(), '2026-10-28', '2026-10-28', pg_temp.stranger()),
        pg_temp.grid_error(pg_temp.o_diag(), '2026-10-28', '2026-10-28', pg_temp.owner(), pg_temp.o())],
  array['P0001 INVALID_BOOKING', 'P0001 INVALID_BOOKING', 'P0001 INVALID_BOOKING'],
  'the staff grid is only for members of the garage'
);
select is(pg_temp.grid_error(pg_temp.o_diag(), '2026-10-28', '2026-10-28', pg_temp.owner()),
  'P0001 SERVICE_UNAVAILABLE', 'the staff grid cannot list another garage''s service');
select is(pg_temp.grid_error(pg_temp.offline(), '2026-10-28', '2026-12-01', pg_temp.owner()),
  'P0001 INVALID_BOOKING', 'the staff grid covers at most 31 days per call');

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

select is(
  array[has_function_privilege('anon', 'public.staff_available_slots(uuid, uuid, date, date, text, uuid)', 'execute'),
        has_function_privilege('authenticated', 'public.staff_available_slots(uuid, uuid, date, date, text, uuid)', 'execute'),
        has_function_privilege('service_role', 'public.staff_available_slots(uuid, uuid, date, date, text, uuid)', 'execute')],
  array[false, false, true], 'only the service role can read the staff grid'
);
select is(
  array(select has_function_privilege(api_role, function_name, 'execute')
        from unnest(array['anon', 'authenticated', 'service_role']) api_role,
             unnest(array['public.staff_available_slots_at(uuid, uuid, date, date, text, uuid, timestamptz)',
                          'public.booking_service_context(uuid, uuid, text, boolean)',
                          'public.booking_service_context(uuid, uuid, text)',
                          'public.create_booking_at(uuid, jsonb, timestamptz)']) function_name),
  array_fill(false, array[12]), 'no API role can call the internals directly'
);

-- ---------------------------------------------------------------------------
-- create_booking() and staff_available_slots() themselves (real clock)
-- ---------------------------------------------------------------------------

create function pg_temp.in_400_days()
returns text
language sql
as $$ select to_char(date_trunc('minute', now() + interval '400 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;

set local role service_role;
select is(
  (public.create_booking(pg_temp.s()::uuid, pg_temp.payload(pg_temp.offline(), pg_temp.in_400_days(), 60, 'phone') || pg_temp.staff(pg_temp.owner(), true))->>'status'),
  'confirmed', 'the service role books a staff booking through create_booking()'
);
select throws_ok(
  format($$select public.create_booking(%L, %L)$$, pg_temp.s(), pg_temp.payload(pg_temp.offline(), pg_temp.in_400_days(), 61, 'phone')),
  'P0001', 'SERVICE_UNAVAILABLE', 'without a member, create_booking() still refuses a service not offered online'
);
select lives_ok(
  $$select * from public.staff_available_slots('a2500000-0000-4000-8000-000000000001', 'a2500000-0000-4000-8000-000000000202',
                                               current_date, current_date, null, '12500000-0000-4000-8000-0000000000a1')$$,
  'the service role reads the staff grid'
);
reset role;
set local role authenticated;
select throws_ok(
  $$select * from public.staff_available_slots('a2500000-0000-4000-8000-000000000001', 'a2500000-0000-4000-8000-000000000202',
                                               current_date, current_date, null, '12500000-0000-4000-8000-0000000000a1')$$,
  '42501', null, 'signed-in staff cannot read the staff grid directly'
);
reset role;
set local role anon;
select throws_ok(
  $$select * from public.staff_available_slots('a2500000-0000-4000-8000-000000000001', 'a2500000-0000-4000-8000-000000000202',
                                               current_date, current_date, null, '12500000-0000-4000-8000-0000000000a1')$$,
  '42501', null, 'anon cannot read the staff grid'
);
reset role;

select * from finish();
rollback;
