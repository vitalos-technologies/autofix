begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(75);

-- create_booking() (P2.3). As in 011, the tests call create_booking_at(), the
-- same transaction with an injectable clock ("now" = Wed 28 Oct 2026 12:00
-- UTC unless a test says otherwise); the last section exercises
-- create_booking() itself.
--
-- Garage A (CBA): Mon-Fri 08:00-17:30, Sat 08:30-13:00, Sunday closed, closed
-- 25 Dec, 15-minute step, MOT on, mobile area DN4/DN5, 30 min travel.
-- Bays 1-3 and a mobile van. Garage B (CBB): one bay, MOT off.
-- Garage D (CBD): reference-space tests.

insert into public.garages (id, slug, name, booking_prefix, mot_enabled, service_area, mobile_travel_min, status) values
  ('a1200000-0000-4000-8000-000000000001', 'pgtap-book-a', 'Booking Garage A', 'CBA', true, '{DN4,DN5}', 30, 'active'),
  ('b1200000-0000-4000-8000-000000000001', 'pgtap-book-b', 'Booking Garage B', 'CBB', false, '{S60}', 30, 'active'),
  ('d1200000-0000-4000-8000-000000000001', 'pgtap-book-d', 'Booking Garage D', 'CBD', false, '{}', 30, 'active');

insert into public.opening_hours (garage_id, weekday, opens, closes)
select 'a1200000-0000-4000-8000-000000000001'::uuid, weekday::smallint, time '08:00', time '17:30' from generate_series(1, 5) weekday
union all select 'a1200000-0000-4000-8000-000000000001', 6, '08:30', '13:00'
union all select 'b1200000-0000-4000-8000-000000000001', weekday, '08:00', '17:30' from generate_series(1, 7) weekday;
insert into public.closures (garage_id, starts_on, ends_on, reason) values
  ('a1200000-0000-4000-8000-000000000001', '2026-12-25', '2026-12-25', 'Christmas Day');

insert into public.resources (id, garage_id, name, kind, sort) values
  ('a1200000-0000-4000-8000-000000000101', 'a1200000-0000-4000-8000-000000000001', 'Bay 1', 'bay', 1),
  ('a1200000-0000-4000-8000-000000000102', 'a1200000-0000-4000-8000-000000000001', 'Bay 2', 'bay', 2),
  ('a1200000-0000-4000-8000-000000000103', 'a1200000-0000-4000-8000-000000000001', 'Bay 3', 'bay', 3),
  ('a1200000-0000-4000-8000-000000000104', 'a1200000-0000-4000-8000-000000000001', 'Mobile van', 'mobile', 4),
  ('b1200000-0000-4000-8000-000000000101', 'b1200000-0000-4000-8000-000000000001', 'Bay B1', 'bay', 1),
  ('d1200000-0000-4000-8000-000000000101', 'd1200000-0000-4000-8000-000000000001', 'Bay D1', 'bay', 1);

insert into public.services (id, garage_id, name, duration_min, buffer_min, price_pence, price_mode, location_mode, resource_kind, online_enabled, needs_approval, is_mot, deleted_at) values
  ('a1200000-0000-4000-8000-000000000201', 'a1200000-0000-4000-8000-000000000001', 'Diagnostics', 60, 15, 4500, 'from', 'both', 'bay', true, false, false, null),
  ('a1200000-0000-4000-8000-000000000202', 'a1200000-0000-4000-8000-000000000001', 'Full service', 180, 15, 17900, 'from', 'workshop', 'bay', true, false, false, null),
  ('a1200000-0000-4000-8000-000000000203', 'a1200000-0000-4000-8000-000000000001', 'Brakes', 90, 15, null, 'quote', 'workshop', 'bay', true, true, false, null),
  ('a1200000-0000-4000-8000-000000000204', 'a1200000-0000-4000-8000-000000000001', 'MOT', 60, 0, 5485, 'fixed', 'workshop', 'bay', true, false, true, null),
  ('a1200000-0000-4000-8000-000000000205', 'a1200000-0000-4000-8000-000000000001', 'Offline', 60, 0, null, 'quote', 'workshop', 'bay', false, false, false, null),
  ('a1200000-0000-4000-8000-000000000206', 'a1200000-0000-4000-8000-000000000001', 'Deleted', 60, 0, null, 'quote', 'workshop', 'bay', true, false, false, now()),
  ('b1200000-0000-4000-8000-000000000201', 'b1200000-0000-4000-8000-000000000001', 'B Diagnostics', 60, 0, 4000, 'fixed', 'workshop', 'bay', true, false, false, null),
  ('b1200000-0000-4000-8000-000000000202', 'b1200000-0000-4000-8000-000000000001', 'B MOT', 60, 0, 5485, 'fixed', 'workshop', 'bay', true, false, true, null),
  ('d1200000-0000-4000-8000-000000000201', 'd1200000-0000-4000-8000-000000000001', 'D Diagnostics', 60, 0, 4000, 'fixed', 'workshop', 'bay', true, false, false, null);

-- Existing garage A customers with consent history.
insert into public.customers (id, garage_id, name, phone, preferred_contact, reminder_consent, consent_at, consent_source, opted_out_at) values
  ('a1200000-0000-4000-8000-000000000601', 'a1200000-0000-4000-8000-000000000001', 'Consented Carol', '+447700900601', 'phone', true, '2026-01-01 09:00+00', 'import', null),
  ('a1200000-0000-4000-8000-000000000602', 'a1200000-0000-4000-8000-000000000001', 'Opted-out Owen', '+447700900602', 'phone', false, null, null, '2026-02-02 09:00+00'),
  ('d1200000-0000-4000-8000-000000000601', 'd1200000-0000-4000-8000-000000000001', 'Reference Rita', '+447700900699', 'phone', false, null, null, null);
insert into public.vehicles (id, garage_id, customer_id, registration) values
  ('d1200000-0000-4000-8000-000000000701', 'd1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-000000000601', 'CBD1');

create temp table outcome (label text primary key, result jsonb not null);

create function pg_temp.key(p_number integer)
returns text
language sql
as $$ select 'c1200000-0000-4000-8000-' || lpad(p_number::text, 12, '0') $$;

create function pg_temp.payload(p_service text, p_start text, p_key integer, p_phone text default '+447700900501', p_reg text default 'CB12 AAA')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'service_id', p_service,
    'starts_at', p_start,
    'location_mode', 'workshop',
    'source', 'online',
    'idempotency_key', pg_temp.key(p_key),
    'symptoms', jsonb_build_array('Warning light'),
    'notes', 'Please call first',
    'customer', jsonb_build_object('name', 'Pat Booker', 'phone', p_phone, 'email', 'Pat@Example.test', 'channel', 'sms',
                                   'reminder_consent', true, 'consent_source', 'booking',
                                   'consent_text', 'Text me MOT and service reminders. Reply STOP to opt out.'),
    'vehicle', jsonb_build_object('registration', p_reg, 'make', 'Ford', 'model', 'Focus', 'colour', 'Blue', 'fuel', 'Petrol',
                                  'year', 2019, 'mot_expiry', '2027-03-01')
  )
$$;

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

create function pg_temp.booking_of(p_label text)
returns public.bookings
language sql
as $$
  select booking.* from public.bookings booking
  join outcome on (outcome.result->>'booking_id')::uuid = booking.id
  where outcome.label = p_label
$$;

create function pg_temp.resource_of(p_label text)
returns text
language sql
as $$ select resource.name from public.resources resource where resource.id = (pg_temp.booking_of(p_label)).resource_id $$;

-- Garage and service ids, for readability.
create function pg_temp.a() returns text language sql as $$ select 'a1200000-0000-4000-8000-000000000001' $$;
create function pg_temp.b() returns text language sql as $$ select 'b1200000-0000-4000-8000-000000000001' $$;
create function pg_temp.diag() returns text language sql as $$ select 'a1200000-0000-4000-8000-000000000201' $$;

-- ---------------------------------------------------------------------------
-- Happy path: Diagnostics, Tuesday 3 Nov 2026 10:00 UTC (10:00 London)
-- ---------------------------------------------------------------------------

select pg_temp.book('first', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T10:00:00Z', 1));

select is(
  array(select jsonb_object_keys(result) from outcome where label = 'first' order by 1),
  array['booking_id', 'customer_id', 'ends_at', 'reference', 'replayed', 'starts_at', 'status', 'vehicle_id'],
  'create_booking returns the contract keys'
);
select is(
  (select result->>'status' || '/' || (result->>'replayed') from outcome where label = 'first'),
  'confirmed/false', 'a new booking for a service without approval is confirmed'
);
select matches(
  (select result->>'reference' from outcome where label = 'first'),
  '^CBA-[0-9]{4}$', 'the reference is the garage prefix and four digits'
);
select is(
  (select array[(result->>'starts_at')::timestamptz, (result->>'ends_at')::timestamptz] from outcome where label = 'first'),
  array['2026-11-03 10:00+00', '2026-11-03 11:00+00']::timestamptz[],
  'starts_at and ends_at are the customer-facing appointment'
);
select is(
  (select concat_ws('|', pg_temp.resource_of('first'), booking.status, booking.source, booking.location_mode, booking.price_pence,
                    array_to_string(booking.symptoms, ','), booking.notes, booking.reference = outcome.result->>'reference',
                    booking.during = tstzrange('2026-11-03 10:00+00', '2026-11-03 11:15+00', '[)'))
   from pg_temp.booking_of('first') booking, outcome where outcome.label = 'first'),
  'Bay 1|confirmed|online|workshop|4500|Warning light|Please call first|t|t',
  'the booking holds Bay 1 for the job and its buffer, with a price snapshot'
);
select is(
  (select concat_ws('|', customer.name, customer.phone, customer.email, customer.channel, customer.preferred_contact,
                    customer.reminder_consent, customer.consent_source, customer.consent_at = '2026-10-28 12:00+00', customer.consent_text)
   from public.customers customer join outcome on (outcome.result->>'customer_id')::uuid = customer.id where outcome.label = 'first'),
  'Pat Booker|+447700900501|pat@example.test|sms|phone|t|booking|t|Text me MOT and service reminders. Reply STOP to opt out.',
  'the customer is created with their channel, the consent they gave and its exact wording'
);
select is(
  (select concat_ws('|', vehicle.registration, vehicle.make, vehicle.model, vehicle.colour, vehicle.fuel, vehicle.year, vehicle.mot_expiry,
                    vehicle.customer_id = (outcome.result->>'customer_id')::uuid, vehicle.mot_checked_at = '2026-10-28 12:00+00')
   from public.vehicles vehicle join outcome on (outcome.result->>'vehicle_id')::uuid = vehicle.id where outcome.label = 'first'),
  'CB12AAA|Ford|Focus|Blue|Petrol|2019|2027-03-01|t|t',
  'the vehicle is stored with its normalised registration and MOT expiry'
);
select is(
  (select string_agg(event.type || '/' || event.actor, ',') from public.booking_events event
   join outcome on (outcome.result->>'booking_id')::uuid = event.booking_id where outcome.label = 'first'),
  'created/customer', 'a created event is written for an online booking'
);

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------

select pg_temp.book('replay', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T10:00:00Z', 1));
select is(
  (select result from outcome where label = 'replay') - 'replayed',
  (select result from outcome where label = 'first') - 'replayed',
  'the same idempotency key returns the same booking'
);
select is((select result->>'replayed' from outcome where label = 'replay'), 'true', 'a replay says so');
select is(
  (select count(*)::integer from public.bookings where garage_id = pg_temp.a()::uuid)
  || '/' || (select count(*)::integer from public.booking_events where garage_id = pg_temp.a()::uuid),
  '1/1', 'a replay creates no booking and no event'
);
select is(
  (public.create_booking_at(pg_temp.a()::uuid, pg_temp.payload('a1200000-0000-4000-8000-000000000202', '2026-11-05T09:00:00Z', 1), '2026-10-28 12:00+00')->>'booking_id'),
  (select result->>'booking_id' from outcome where label = 'first'),
  'a reused key returns the original booking whatever the new payload says'
);
select is(
  (public.create_booking_at(pg_temp.a()::uuid, pg_temp.payload(pg_temp.diag(), '2026-11-03T10:00:00Z', 1), '2026-11-03 09:30+00')->>'replayed'),
  'true', 'a retry after the slot has closed still returns the booking'
);

-- ---------------------------------------------------------------------------
-- The resource pool: 3 bays, least busy first
-- ---------------------------------------------------------------------------

select pg_temp.book('second', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T10:00:00Z', 2, '+447700900502', 'CB12 BBB'));
select pg_temp.book('third', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T10:00:00Z', 3, '+447700900503', 'CB12 CCC'));
select is(
  array[pg_temp.resource_of('second'), pg_temp.resource_of('third')],
  array['Bay 2', 'Bay 3'], 'the second and third bookings at 10:00 take the other bays'
);
select is(
  pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T10:00:00Z', 4, '+447700900504', 'CB12 DDD')),
  'P0001 SLOT_UNAVAILABLE', 'a fourth booking at 10:00 is refused with SLOT_UNAVAILABLE'
);
select is(
  (select count(*)::integer from public.customers where garage_id = pg_temp.a()::uuid and phone = '+447700900504')
  + (select count(*)::integer from public.vehicles where garage_id = pg_temp.a()::uuid and registration = 'CB12DDD'),
  0, 'a refused booking leaves no customer or vehicle behind'
);
select pg_temp.book('busy-1', pg_temp.a(), pg_temp.payload('a1200000-0000-4000-8000-000000000202', '2026-11-03T13:00:00Z', 5));
select pg_temp.book('busy-2', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T15:00:00Z', 6));
select pg_temp.book('busy-3', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T08:00:00Z', 7));
select is(
  array[pg_temp.resource_of('busy-1'), pg_temp.resource_of('busy-2'), pg_temp.resource_of('busy-3')],
  array['Bay 1', 'Bay 2', 'Bay 3'],
  'the free bay with the fewest booked minutes that day wins, ties going to the lowest sort order'
);

-- ---------------------------------------------------------------------------
-- Status: requested when the service or garage needs approval, or for agents
-- ---------------------------------------------------------------------------

select pg_temp.book('brakes', pg_temp.a(), pg_temp.payload('a1200000-0000-4000-8000-000000000203', '2026-11-05T09:00:00Z', 8));
select pg_temp.book('agent', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-05T11:00:00Z', 9) || '{"source": "ai_agent"}');
update public.garages set approve_online = true where id = pg_temp.a()::uuid;
select pg_temp.book('approve', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-05T13:00:00Z', 10));
update public.garages set approve_online = false where id = pg_temp.a()::uuid;
select pg_temp.book('phone', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-05T15:00:00Z', 11) || '{"source": "phone"}');
select is(
  (select array_agg(result->>'status' order by label) from outcome where label in ('agent', 'approve', 'brakes', 'phone')),
  array['requested', 'requested', 'requested', 'confirmed'],
  'requested for ai_agent, approve_online and needs_approval; confirmed otherwise'
);
select is(
  array[(select actor from public.booking_events where booking_id = (pg_temp.booking_of('agent')).id),
        (select actor from public.booking_events where booking_id = (pg_temp.booking_of('phone')).id)],
  array['agent', 'staff'], 'the created event names the actor behind the source'
);
select is((pg_temp.booking_of('brakes')).price_pence, null::integer, 'quote services snapshot no price');

-- ---------------------------------------------------------------------------
-- Mobile visits
-- ---------------------------------------------------------------------------

select pg_temp.book('mobile', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-04T10:00:00Z', 12)
  || '{"location_mode": "mobile", "postcode": "dn48ab", "address": "1 Test Street"}');
select is(
  (select concat_ws('|', pg_temp.resource_of('mobile'), booking.postcode, booking.address, booking.location_mode,
                    booking.during = tstzrange('2026-11-04 09:30+00', '2026-11-04 11:45+00', '[)'))
   from pg_temp.booking_of('mobile') booking),
  'Mobile van|DN4 8AB|1 Test Street|mobile|t',
  'a mobile visit takes the van for travel + job + buffer + travel, with a normalised postcode'
);
select is(
  pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-04T14:00:00Z', 13) || '{"location_mode": "mobile", "postcode": "S60 1AA"}'),
  'P0001 OUTSIDE_SERVICE_AREA', 'a postcode district outside the service area is refused'
);
select is(
  pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-04T14:00:00Z', 13) || '{"location_mode": "mobile"}'),
  'P0001 INVALID_BOOKING', 'a mobile visit needs a postcode'
);
select is(
  pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-04T14:00:00Z', 13) || '{"location_mode": "mobile", "postcode": "NOTAPOSTCODE"}'),
  'P0001 INVALID_BOOKING', 'the postcode must look like a UK postcode'
);
select is(
  pg_temp.book_error(pg_temp.a(), pg_temp.payload('a1200000-0000-4000-8000-000000000202', '2026-11-04T14:00:00Z', 13) || '{"location_mode": "mobile", "postcode": "DN4 8AB"}'),
  'P0001 SERVICE_UNAVAILABLE', 'a workshop-only service cannot be booked as a mobile visit'
);
select is(
  pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-04T11:00:00Z', 13) || '{"location_mode": "mobile", "postcode": "DN5 1AA"}'),
  'P0001 SLOT_UNAVAILABLE', 'the van is not free during the first visit''s travel time'
);

-- ---------------------------------------------------------------------------
-- Error codes
-- ---------------------------------------------------------------------------

select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload('a1200000-0000-4000-8000-000000000205', '2026-11-03T12:00:00Z', 20)),
  'P0001 SERVICE_UNAVAILABLE', 'a service that is not online is unavailable');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload('a1200000-0000-4000-8000-000000000206', '2026-11-03T12:00:00Z', 20)),
  'P0001 SERVICE_UNAVAILABLE', 'a deleted service is unavailable');
select is(pg_temp.book_error(pg_temp.b(), pg_temp.payload('b1200000-0000-4000-8000-000000000202', '2026-11-03T12:00:00Z', 20)),
  'P0001 SERVICE_UNAVAILABLE', 'MOT cannot be booked where MOT is off');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(gen_random_uuid()::text, '2026-11-03T12:00:00Z', 20)),
  'P0001 SERVICE_UNAVAILABLE', 'an unknown service is unavailable');
select is(pg_temp.book_error(pg_temp.b(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20)),
  'P0001 SERVICE_UNAVAILABLE', 'garage B cannot book garage A''s service');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20) - 'service_id'),
  'P0001 INVALID_BOOKING', 'service_id is required');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), 'tomorrow at ten', 20)),
  'P0001 INVALID_BOOKING', 'starts_at must be a timestamp');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00', 20)),
  'P0001 INVALID_BOOKING', 'starts_at must carry its UTC offset');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:05:00Z', 20)),
  'P0001 INVALID_BOOKING', 'starts_at must be on the slot step');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T17:00:00Z', 20)),
  'P0001 INVALID_BOOKING', 'the job must end by closing time');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-08T10:00:00Z', 20)),
  'P0001 INVALID_BOOKING', 'nothing can be booked on a day without opening hours');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20, '07700900123')),
  'P0001 INVALID_BOOKING', 'the phone number must be E.164');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20) #- '{customer,name}'),
  'P0001 INVALID_BOOKING', 'the customer''s name is required');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20, '+447700900520', '!!')),
  'P0001 INVALID_BOOKING', 'the registration must have letters or digits');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20) || '{"source": "carrier_pigeon"}'),
  'P0001 INVALID_BOOKING', 'the source must be a known one');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20) || '{"location_mode": "boat"}'),
  'P0001 INVALID_BOOKING', 'the location mode must be workshop or mobile');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20) || '{"idempotency_key": "abc"}'),
  'P0001 INVALID_BOOKING', 'the idempotency key must be a uuid');
select is(pg_temp.book_error(pg_temp.a(), jsonb_set(pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20), '{customer}',
    '{"name": "No Email", "phone": "+447700900521", "channel": "email"}')),
  'P0001 INVALID_BOOKING', 'the email channel needs an email address');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20)
    || jsonb_build_object('symptoms', (select jsonb_agg('Symptom ' || n) from generate_series(1, 11) n))),
  'P0001 INVALID_BOOKING', 'no more than 10 symptoms');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20) || '{"symptoms": "rattle"}'),
  'P0001 INVALID_BOOKING', 'symptoms must be a list');
select is(pg_temp.book_error(pg_temp.a(), '[]'::jsonb), 'P0001 INVALID_BOOKING', 'the booking must be an object');
select is(pg_temp.book_error(pg_temp.a(), jsonb_set(pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20), '{vehicle,mot_expiry}', '"soon"')),
  'P0001 INVALID_BOOKING', 'mot_expiry must be a date');
select is(pg_temp.book_error(pg_temp.a(), jsonb_set(pg_temp.payload(pg_temp.diag(), '2026-11-03T12:00:00Z', 20), '{vehicle,year}', '"old"')),
  'P0001 INVALID_BOOKING', 'year must be a number');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-03T12:30:00Z', 20), '2026-11-03 11:00+00'),
  'P0001 SLOT_UNAVAILABLE', 'a start inside the notice period is unavailable');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-12-25T10:00:00Z', 20)),
  'P0001 SLOT_UNAVAILABLE', 'a start on a closure day is unavailable');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2027-01-05T10:00:00Z', 20)),
  'P0001 SLOT_UNAVAILABLE', 'a start beyond max_days_ahead is unavailable');
select is(pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-10-27T10:00:00Z', 20)),
  'P0001 SLOT_UNAVAILABLE', 'a start in the past is unavailable');

-- ---------------------------------------------------------------------------
-- Customers, vehicles and consent (Friday 6 Nov)
-- ---------------------------------------------------------------------------

select pg_temp.book('carol', pg_temp.a(), jsonb_set(pg_temp.payload(pg_temp.diag(), '2026-11-06T09:00:00Z', 30, '+447700900601', 'CB30 CAR'), '{customer,reminder_consent}', 'false'));
select is(
  (select concat_ws('|', reminder_consent, consent_source, consent_at = '2026-01-01 09:00+00') from public.customers where id = 'a1200000-0000-4000-8000-000000000601'),
  't|import|t', 'an unticked box on a later booking does not withdraw earlier consent'
);
select pg_temp.book('carol-again', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-06T10:30:00Z', 31, '+447700900601', 'CB30 CAR'));
select is(
  (select concat_ws('|', reminder_consent, consent_source, consent_at = '2026-01-01 09:00+00', coalesce(consent_text, 'no wording')) from public.customers where id = 'a1200000-0000-4000-8000-000000000601'),
  't|import|t|no wording', 'consent given again keeps the original consent record, wording included'
);
select pg_temp.book('owen', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-06T12:00:00Z', 32, '+447700900602', 'CB32 OWN'));
select is(
  (select concat_ws('|', reminder_consent, consent_source, opted_out_at = '2026-02-02 09:00+00', consent_text) from public.customers where id = 'a1200000-0000-4000-8000-000000000602'),
  't|booking|t|Text me MOT and service reminders. Reply STOP to opt out.', 'new consent is recorded with its wording but an existing opt-out is never cleared'
);
select pg_temp.book('owen-again', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-06T13:30:00Z', 33, '+447700900602', 'CB32 OWN') #- '{customer,reminder_consent}');
select is(
  (select concat_ws('|', reminder_consent, opted_out_at = '2026-02-02 09:00+00') from public.customers where id = 'a1200000-0000-4000-8000-000000000602'),
  't|t', 'a booking without a consent answer changes nothing'
);
select pg_temp.book('pat-renamed', pg_temp.a(), jsonb_set(pg_temp.payload(pg_temp.diag(), '2026-11-06T15:00:00Z', 34, '+447700900501', 'cb12aaa'), '{customer}',
  '{"name": "Pat B. Renamed", "phone": "+447700900501"}'));
select is(
  (select concat_ws('|', (outcome.result->>'customer_id') = (first.result->>'customer_id'), customer.name, customer.email,
                    (outcome.result->>'vehicle_id') = (first.result->>'vehicle_id'))
   from outcome join outcome first on first.label = 'first'
   join public.customers customer on customer.id = (outcome.result->>'customer_id')::uuid
   where outcome.label = 'pat-renamed'),
  't|Pat B. Renamed|pat@example.test|t',
  'the customer is matched by phone (name updated, email kept) and the vehicle by registration'
);
select pg_temp.book('new-keeper', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-06T08:00:00Z', 35, '+447700900502', 'CB12 AAA'));
select is(
  (select vehicle.customer_id = (outcome.result->>'customer_id')::uuid and vehicle.id = (first.result->>'vehicle_id')::uuid
   from outcome join outcome first on first.label = 'first'
   join public.vehicles vehicle on vehicle.id = (outcome.result->>'vehicle_id')::uuid
   where outcome.label = 'new-keeper'),
  true, 'a vehicle booked by someone else moves to the latest customer'
);
select pg_temp.book('no-consent', pg_temp.a(), jsonb_set(pg_temp.payload(pg_temp.diag(), '2026-11-06T16:00:00Z', 37, '+447700900537', 'CB37 NOC'), '{customer,reminder_consent}', 'false'));
select is(
  (select concat_ws('|', customer.reminder_consent, coalesce(customer.consent_source, '-'), coalesce(customer.consent_at::text, '-'), coalesce(customer.consent_text, '-'))
   from public.customers customer join outcome on (outcome.result->>'customer_id')::uuid = customer.id where outcome.label = 'no-consent'),
  'f|-|-|-', 'without a ticked box no consent source, time or wording is stored'
);
select pg_temp.book('reminder', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-06T09:00:00Z', 36, '+447700900536', 'CB36 REM')
  || jsonb_build_object('reminder_send_id', gen_random_uuid()));
select is(
  (pg_temp.booking_of('reminder')).reminder_send_id, null::uuid,
  'a reminder_send_id that does not belong to the garage is not stored'
);

-- ---------------------------------------------------------------------------
-- Cross-garage
-- ---------------------------------------------------------------------------

select pg_temp.book('garage-b', pg_temp.b(), pg_temp.payload('b1200000-0000-4000-8000-000000000201', '2026-11-09T10:00:00Z', 40));
select is(
  (select concat_ws('|', pg_temp.resource_of('garage-b'), (outcome.result->>'customer_id') <> (first.result->>'customer_id'),
                    (select count(*) from public.customers where garage_id in (pg_temp.a()::uuid, pg_temp.b()::uuid) and phone = '+447700900501'))
   from outcome join outcome first on first.label = 'first' where outcome.label = 'garage-b'),
  'Bay B1|t|2', 'the same customer booking garage B gets a separate garage B customer and garage B''s bay'
);
select matches((select result->>'reference' from outcome where label = 'garage-b'), '^CBB-[0-9]{4}$', 'garage B''s reference uses its own prefix');
select is(
  (select count(*)::integer from public.bookings where garage_id = pg_temp.b()::uuid),
  1, 'garage A''s refused cross-garage attempts left nothing in garage B'
);

-- ---------------------------------------------------------------------------
-- References: random, unique per garage, wider once 80% of 4 digits are used
-- ---------------------------------------------------------------------------

select is(
  (select count(distinct reference) = count(*) from public.bookings where garage_id = pg_temp.a()::uuid),
  true, 'every garage A reference is unique'
);
select ok(
  (select max(split_part(reference, '-', 2)::integer) - min(split_part(reference, '-', 2)::integer) + 1 > count(*)
   from public.bookings where garage_id = pg_temp.a()::uuid),
  'references are not a consecutive sequence'
);
insert into public.bookings (garage_id, reference, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source)
select 'd1200000-0000-4000-8000-000000000001', 'CBD-' || lpad(n::text, 4, '0'), 'd1200000-0000-4000-8000-000000000601',
       'd1200000-0000-4000-8000-000000000701', 'd1200000-0000-4000-8000-000000000201', 'd1200000-0000-4000-8000-000000000101',
       timestamptz '2030-01-01 09:00+00' + make_interval(hours => n), timestamptz '2030-01-01 10:00+00' + make_interval(hours => n),
       tstzrange(timestamptz '2030-01-01 09:00+00' + make_interval(hours => n), timestamptz '2030-01-01 10:00+00' + make_interval(hours => n)),
       'cancelled', 'phone'
from generate_series(0, 7999) n;
select ok(
  (select public.generate_booking_reference('d1200000-0000-4000-8000-000000000001') ~ '^CBD-(8|9)[0-9]{3}$'),
  'with exactly 80% of 4-digit references used, a free 4-digit reference is found'
);
insert into public.bookings (garage_id, reference, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source)
values ('d1200000-0000-4000-8000-000000000001', 'CBD-8000', 'd1200000-0000-4000-8000-000000000601', 'd1200000-0000-4000-8000-000000000701',
        'd1200000-0000-4000-8000-000000000201', 'd1200000-0000-4000-8000-000000000101',
        '2031-01-01 09:00+00', '2031-01-01 10:00+00', '[2031-01-01 09:00+00,2031-01-01 10:00+00)', 'cancelled', 'phone');
select matches(
  public.generate_booking_reference('d1200000-0000-4000-8000-000000000001'),
  '^CBD-[0-9]{5}$', 'beyond 80% of the 4-digit space, references widen to 5 digits'
);
select throws_ok(
  $$insert into public.bookings (garage_id, reference, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source)
    values ('d1200000-0000-4000-8000-000000000001', 'CBD-0001', 'd1200000-0000-4000-8000-000000000601', 'd1200000-0000-4000-8000-000000000701',
            'd1200000-0000-4000-8000-000000000201', 'd1200000-0000-4000-8000-000000000101',
            '2032-01-01 09:00+00', '2032-01-01 10:00+00', '[2032-01-01 09:00+00,2032-01-01 10:00+00)', 'cancelled', 'phone')$$,
  '23505', null, 'a reference cannot repeat within a garage'
);

-- ---------------------------------------------------------------------------
-- A concurrent booking takes the chosen bay between the check and the insert
-- ---------------------------------------------------------------------------
-- The trigger plays the other transaction: before create_booking's insert it
-- books the same bay and time, so the insert hits no_overlap (23P01).

create sequence pg_temp.race_counter;
create function pg_temp.simulate_race()
returns trigger
language plpgsql
as $$
begin
  if new.notes is distinct from 'simulated race'
     and (current_setting('pgtap.race', true) = 'always' or nextval('pg_temp.race_counter') = 1) then
    insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source, notes)
    values (new.garage_id, new.customer_id, new.vehicle_id, new.service_id, new.resource_id, new.starts_at, new.ends_at, new.during, 'confirmed', 'phone', 'simulated race');
  end if;
  return new;
end
$$;
create trigger zz_simulate_race before insert on public.bookings for each row execute function pg_temp.simulate_race();

select pg_temp.book('raced', pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-10T10:00:00Z', 50));
select is(
  pg_temp.resource_of('raced') || '/' || (select count(*) from public.bookings where notes = 'simulated race'),
  'Bay 2/0', 'on a no_overlap conflict the booking retries the next free bay'
);
select set_config('pgtap.race', 'always', true);
select is(
  pg_temp.book_error(pg_temp.a(), pg_temp.payload(pg_temp.diag(), '2026-11-10T13:00:00Z', 51)),
  'P0001 SLOT_UNAVAILABLE', 'when every bay is taken under it, the booking fails with SLOT_UNAVAILABLE'
);
select set_config('pgtap.race', '', true);
drop trigger zz_simulate_race on public.bookings;

-- ---------------------------------------------------------------------------
-- create_booking() itself (real clock): next Monday 10:00 London
-- ---------------------------------------------------------------------------

create function pg_temp.next_monday_ten()
returns text
language sql
as $$
  select to_char(((date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date + time '10:00') at time zone 'Europe/London',
                 'YYYY-MM-DD"T"HH24:MI:SSOF')
$$;

set local role service_role;
select is(
  (public.create_booking(pg_temp.a()::uuid, pg_temp.payload(pg_temp.diag(), pg_temp.next_monday_ten(), 60, '+447700900560', 'CB60 NOW'))->>'status'),
  'confirmed', 'the service role books through create_booking()'
);
select is(
  (public.create_booking(pg_temp.a()::uuid, pg_temp.payload(pg_temp.diag(), pg_temp.next_monday_ten(), 60, '+447700900560', 'CB60 NOW'))->>'replayed'),
  'true', 'create_booking() replays by idempotency key'
);
reset role;
set local role authenticated;
select throws_ok(
  $$select public.create_booking('a1200000-0000-4000-8000-000000000001', '{}'::jsonb)$$,
  '42501', null, 'signed-in staff cannot call create_booking() directly'
);
reset role;
set local role anon;
select throws_ok(
  $$select public.create_booking('a1200000-0000-4000-8000-000000000001', '{}'::jsonb)$$,
  '42501', null, 'anon cannot call create_booking()'
);
reset role;

select * from finish();
rollback;
