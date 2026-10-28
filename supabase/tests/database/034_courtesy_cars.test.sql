begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(71);

-- P5.8 courtesy cars and collection/delivery (migration 20261029000800).
--
-- Garage P (CCP): paid Pro, Europe/London, open every day 08:00-17:30, one
-- bay and one van, 30 min travel, mobile area DN4. Owner Pam, technician
-- Tim. Garage E (CCE): Essentials, owner Eve. Garage O (CCO): Pro, owner
-- Oli, with its own car.
--
-- Bookings in P (inserted directly; create_booking() is covered by 012):
--   B1 Mon 2 Nov 2026 09:00-10:00Z (during to 10:15)   service with collection
--   B2 Mon 2 Nov 2026 11:00-12:00Z (during to 12:15)   service with collection
--   B3 Sun 31 Oct 2027 09:00 local = 09:00Z (GMT, the day the clocks go back)
--   B4 Sat 30 Oct 2027 09:00 local = 08:00Z (BST)
--   B5 Sun 28 Mar 2027 09:00 local = 08:00Z (BST, the day the clocks go forward)
--   B6 Sat 27 Mar 2027 09:00 local = 09:00Z (GMT)
--   B7 Tue 3 Nov 2026 09:00-10:00Z, service without collection

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('13400000-0000-4000-8000-0000000000a1', 'cc-owner-p@pgtap.test', '{}'::jsonb),
  ('13400000-0000-4000-8000-0000000000a2', 'cc-tech-p@pgtap.test', '{}'::jsonb),
  ('13400000-0000-4000-8000-0000000000b1', 'cc-owner-e@pgtap.test', '{}'::jsonb),
  ('13400000-0000-4000-8000-0000000000c1', 'cc-owner-o@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen, service_area, mobile_travel_min) values
  ('a3400000-0000-4000-8000-000000000001', 'pgtap-cc-p', 'Courtesy P', 'CCP', 'active', 'pro', null, 'pro', '{DN4}', 30),
  ('a3400000-0000-4000-8000-000000000002', 'pgtap-cc-e', 'Courtesy E', 'CCE', 'active', 'essentials', null, 'essentials', '{DN4}', 30),
  ('a3400000-0000-4000-8000-000000000003', 'pgtap-cc-o', 'Courtesy O', 'CCO', 'active', 'pro', null, 'pro', '{DN4}', 30);
insert into public.garage_members (garage_id, user_id, role) values
  ('a3400000-0000-4000-8000-000000000001', '13400000-0000-4000-8000-0000000000a1', 'owner'),
  ('a3400000-0000-4000-8000-000000000001', '13400000-0000-4000-8000-0000000000a2', 'technician'),
  ('a3400000-0000-4000-8000-000000000002', '13400000-0000-4000-8000-0000000000b1', 'owner'),
  ('a3400000-0000-4000-8000-000000000003', '13400000-0000-4000-8000-0000000000c1', 'owner');

insert into public.opening_hours (garage_id, weekday, opens, closes)
select 'a3400000-0000-4000-8000-000000000001'::uuid, weekday::smallint, time '08:00', time '17:30' from generate_series(1, 7) weekday;

insert into public.resources (id, garage_id, name, kind, sort) values
  ('a3400000-0000-4000-8000-000000000101', 'a3400000-0000-4000-8000-000000000001', 'Bay 1', 'bay', 1),
  ('a3400000-0000-4000-8000-000000000102', 'a3400000-0000-4000-8000-000000000001', 'Van', 'mobile', 2),
  ('a3400000-0000-4000-8000-000000000103', 'a3400000-0000-4000-8000-000000000002', 'Bay E', 'bay', 1);

insert into public.services (id, garage_id, name, duration_min, buffer_min, price_pence, price_mode, location_mode, resource_kind, collection_delivery) values
  ('a3400000-0000-4000-8000-000000000201', 'a3400000-0000-4000-8000-000000000001', 'Service with collection', 60, 15, 9000, 'fixed', 'workshop', 'bay', true),
  ('a3400000-0000-4000-8000-000000000202', 'a3400000-0000-4000-8000-000000000001', 'Plain service', 60, 15, 9000, 'fixed', 'workshop', 'bay', false),
  ('a3400000-0000-4000-8000-000000000203', 'a3400000-0000-4000-8000-000000000002', 'E service', 60, 0, 9000, 'fixed', 'workshop', 'bay', false);

insert into public.customers (id, garage_id, name, phone, preferred_contact) values
  ('a3400000-0000-4000-8000-000000000301', 'a3400000-0000-4000-8000-000000000001', 'Cara Customer', '+447700900341', 'phone'),
  ('a3400000-0000-4000-8000-000000000302', 'a3400000-0000-4000-8000-000000000002', 'Eli Customer', '+447700900342', 'phone');
insert into public.vehicles (id, garage_id, customer_id, registration, make, model) values
  ('a3400000-0000-4000-8000-000000000401', 'a3400000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000301', 'CC34PGT', 'Ford', 'Focus'),
  ('a3400000-0000-4000-8000-000000000402', 'a3400000-0000-4000-8000-000000000002', 'a3400000-0000-4000-8000-000000000302', 'CC34PGE', 'Ford', 'Ka');

create function pg_temp.book(p_id text, p_service text, p_start timestamptz, p_minutes integer, p_buffer integer default 15)
returns void language sql as $$
  insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source)
  values (p_id::uuid, 'a3400000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000301',
          'a3400000-0000-4000-8000-000000000401', p_service::uuid, 'a3400000-0000-4000-8000-000000000101',
          p_start, p_start + make_interval(mins => p_minutes),
          tstzrange(p_start, p_start + make_interval(mins => p_minutes + p_buffer), '[)'), 'confirmed', 'phone');
$$;
select pg_temp.book('a3400000-0000-4000-8000-000000000501', 'a3400000-0000-4000-8000-000000000201', '2026-11-02 09:00Z', 60);
select pg_temp.book('a3400000-0000-4000-8000-000000000502', 'a3400000-0000-4000-8000-000000000201', '2026-11-02 11:00Z', 60);
select pg_temp.book('a3400000-0000-4000-8000-000000000503', 'a3400000-0000-4000-8000-000000000202', '2027-10-31 09:00Z', 60);
select pg_temp.book('a3400000-0000-4000-8000-000000000504', 'a3400000-0000-4000-8000-000000000202', '2027-10-30 08:00Z', 60);
select pg_temp.book('a3400000-0000-4000-8000-000000000505', 'a3400000-0000-4000-8000-000000000202', '2027-03-28 08:00Z', 60);
select pg_temp.book('a3400000-0000-4000-8000-000000000506', 'a3400000-0000-4000-8000-000000000202', '2027-03-27 09:00Z', 60);
select pg_temp.book('a3400000-0000-4000-8000-000000000507', 'a3400000-0000-4000-8000-000000000202', '2026-11-03 09:00Z', 60);
insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  ('a3400000-0000-4000-8000-000000000508', 'a3400000-0000-4000-8000-000000000002', 'a3400000-0000-4000-8000-000000000302',
   'a3400000-0000-4000-8000-000000000402', 'a3400000-0000-4000-8000-000000000203', 'a3400000-0000-4000-8000-000000000103',
   '2026-11-02 09:00Z', '2026-11-02 10:00Z', '[2026-11-02 09:00Z,2026-11-02 10:00Z)', 'confirmed', 'phone');

insert into public.courtesy_cars (id, garage_id, name, registration, sort) values
  ('a3400000-0000-4000-8000-000000000601', 'a3400000-0000-4000-8000-000000000001', 'Fiesta', 'cc11 aaa', 1),
  ('a3400000-0000-4000-8000-000000000602', 'a3400000-0000-4000-8000-000000000001', 'Polo', 'CC22BBB', 2),
  ('a3400000-0000-4000-8000-000000000603', 'a3400000-0000-4000-8000-000000000003', 'O car', 'CC33CCC', 1);

create function pg_temp.as_member(p_user text, p_garage text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;
create function pg_temp.p() returns text language sql as $$ select 'a3400000-0000-4000-8000-000000000001' $$;
create function pg_temp.e() returns text language sql as $$ select 'a3400000-0000-4000-8000-000000000002' $$;
create function pg_temp.o() returns text language sql as $$ select 'a3400000-0000-4000-8000-000000000003' $$;
create function pg_temp.pam() returns text language sql as $$ select '13400000-0000-4000-8000-0000000000a1' $$;
create function pg_temp.tim() returns text language sql as $$ select '13400000-0000-4000-8000-0000000000a2' $$;
create function pg_temp.eve() returns text language sql as $$ select '13400000-0000-4000-8000-0000000000b1' $$;
create function pg_temp.oli() returns text language sql as $$ select '13400000-0000-4000-8000-0000000000c1' $$;
create temp table outcome (label text primary key, result jsonb not null);
grant all on outcome to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from unnest(array['courtesy_cars', 'courtesy_car_loans', 'courtesy_car_requests', 'collection_delivery_legs']) t(name)
           join pg_class rel on rel.relname = t.name and rel.relnamespace = 'public'::regnamespace
           where rel.relrowsecurity), 4, 'the four courtesy tables have RLS on');
select is((select count(*)::integer from unnest(array['courtesy_cars', 'courtesy_car_loans', 'courtesy_car_requests', 'collection_delivery_legs']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select')), 0, 'anon reads none of them');
select is((select count(*)::integer from unnest(array['courtesy_car_loans', 'courtesy_car_requests', 'collection_delivery_legs']) t(name)
           where has_table_privilege('authenticated', 'public.' || t.name, 'insert')
              or has_table_privilege('authenticated', 'public.' || t.name, 'update')
              or has_table_privilege('authenticated', 'public.' || t.name, 'delete')), 0, 'staff write loans, requests and legs only through functions');
select is((select contype::text from pg_constraint where conname = 'courtesy_car_loans_no_overlap'), 'x', 'loans have an exclusion constraint');
select is((select contype::text from pg_constraint where conname = 'collection_delivery_legs_no_overlap'), 'x', 'van legs have an exclusion constraint');
select is((select registration from public.courtesy_cars where id = 'a3400000-0000-4000-8000-000000000601'), 'CC11AAA', 'registrations are stored normalised');
select is((select count(*)::integer from unnest(array[
             'public.courtesy_car_free_count(uuid, timestamptz, timestamptz)', 'public.request_courtesy_car(uuid, uuid)',
             'public.request_collection_delivery(uuid, uuid, text, text)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')),
          0, 'booking-site functions are service role only');
select is((select count(*)::integer from unnest(array[
             'public.courtesy_actor_garage(text[])', 'public.courtesy_car_default_window(uuid, timestamptz, timestamptz)',
             'public.collection_delivery_hold(uuid, uuid, text, text, text, uuid)', 'public.courtesy_cars_free_in(uuid, tstzrange, uuid)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('service_role', f.name, 'execute')),
          0, 'internals are granted to no API role');
select is((select count(*)::integer from pg_proc
           where oid in ('public.reserve_courtesy_car(uuid, uuid, timestamptz, timestamptz, text)'::regprocedure,
                         'public.check_in_courtesy_car(uuid, integer, integer, text)'::regprocedure,
                         'public.request_courtesy_car(uuid, uuid)'::regprocedure,
                         'public.hold_collection_delivery(uuid, text, text)'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 4, 'functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Default loan window (to closing that local day), across clock changes
-- ---------------------------------------------------------------------------

select is(public.courtesy_car_default_window(pg_temp.p()::uuid, '2026-11-02 09:00Z', '2026-11-02 10:00Z'),
          tstzrange('2026-11-02 09:00Z', '2026-11-02 17:30Z', '[)'), 'a GMT weekday: to 17:30 GMT');
select is(upper(public.courtesy_car_default_window(pg_temp.p()::uuid, '2027-10-30 08:00Z', '2027-10-30 09:00Z')),
          '2027-10-30 16:30Z'::timestamptz, 'Sat 30 Oct 2027 (BST): closing 17:30 is 16:30 UTC');
select is(upper(public.courtesy_car_default_window(pg_temp.p()::uuid, '2027-10-31 09:00Z', '2027-10-31 10:00Z')),
          '2027-10-31 17:30Z'::timestamptz, 'Sun 31 Oct 2027 (clocks go back): closing 17:30 is 17:30 UTC');
select is(public.courtesy_car_default_window(pg_temp.p()::uuid, '2027-03-28 08:00Z', '2027-03-28 09:00Z'),
          tstzrange('2027-03-28 08:00Z', '2027-03-28 16:30Z', '[)'), 'Sun 28 Mar 2027 (clocks go forward): 09:00-17:30 BST');
select is(upper(public.courtesy_car_default_window(pg_temp.p()::uuid, '2027-03-27 09:00Z', '2027-03-27 10:00Z')),
          '2027-03-27 17:30Z'::timestamptz, 'Sat 27 Mar 2027 (GMT): to 17:30 UTC');
select is(upper(public.courtesy_car_default_window(pg_temp.p()::uuid, '2026-11-02 16:00Z', '2026-11-02 19:00Z')),
          '2026-11-02 19:00Z'::timestamptz, 'a booking that ends after closing keeps the car until it ends');

-- ---------------------------------------------------------------------------
-- Plan gating
-- ---------------------------------------------------------------------------

select pg_temp.as_member(pg_temp.eve(), pg_temp.e());
set local role authenticated;
select throws_ok($$insert into public.courtesy_cars (garage_id, name, registration) values ('a3400000-0000-4000-8000-000000000002', 'E car', 'EE11EEE')$$,
                 '42501', null, 'an Essentials garage cannot add a courtesy car');
select throws_ok($$select public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000508', 'a3400000-0000-4000-8000-000000000601')$$,
                 'P0001', 'PLAN_REQUIRED: courtesy_cars', 'an Essentials garage cannot reserve');
select throws_ok($$update public.services set collection_delivery = true where id = 'a3400000-0000-4000-8000-000000000203'$$,
                 'P0001', 'PLAN_REQUIRED: courtesy_cars', 'an Essentials garage cannot offer collection and delivery');
select is((select count(*)::integer from public.courtesy_cars), 0, 'Essentials members read no other garage''s cars');
reset role;

set local role service_role;
select is(public.courtesy_car_free_count(pg_temp.e()::uuid, '2026-11-02 09:00Z', '2026-11-02 10:00Z'), 0,
          'the booking site sees no free cars for an Essentials garage');
select throws_ok($$select public.request_courtesy_car('a3400000-0000-4000-8000-000000000002', 'a3400000-0000-4000-8000-000000000508')$$,
                 'P0001', 'PLAN_REQUIRED: courtesy_cars', 'an Essentials garage gets no customer requests');
select is(public.courtesy_car_free_count(pg_temp.p()::uuid, '2026-11-02 09:00Z', '2026-11-02 10:00Z'), 2,
          'both of P''s cars are free on Monday');
reset role;

select pg_temp.as_member(pg_temp.tim(), pg_temp.p());
set local role authenticated;
select throws_ok($$insert into public.courtesy_cars (garage_id, name, registration) values ('a3400000-0000-4000-8000-000000000001', 'Tech car', 'TT11TTT')$$,
                 '42501', null, 'a technician cannot add a car');
reset role;

select pg_temp.as_member(pg_temp.pam(), pg_temp.p());
set local role authenticated;
select lives_ok($$insert into public.courtesy_cars (garage_id, name, registration, active) values ('a3400000-0000-4000-8000-000000000001', 'Spare', 'pp11 ppp', false)$$,
                'a Pro owner adds a car');
select lives_ok($$update public.services set collection_delivery = true where id = 'a3400000-0000-4000-8000-000000000202'$$,
                'a Pro owner can switch collection and delivery on');
select lives_ok($$update public.services set collection_delivery = false where id = 'a3400000-0000-4000-8000-000000000202'$$,
                'and off again');
reset role;

-- ---------------------------------------------------------------------------
-- Reservations: no double booking of a car
-- ---------------------------------------------------------------------------

select pg_temp.as_member(pg_temp.tim(), pg_temp.p());
set local role authenticated;
insert into outcome select 'loan1', to_jsonb(public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000501', 'a3400000-0000-4000-8000-000000000601'));
select is((select result->>'status' from outcome where label = 'loan1'), 'reserved', 'a technician reserves the Fiesta for B1');
select is((select (result->>'during')::tstzrange from outcome where label = 'loan1'),
          tstzrange('2026-11-02 09:00Z', '2026-11-02 17:30Z', '[)'), 'by default until closing that day');
select throws_ok($$select public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000502', 'a3400000-0000-4000-8000-000000000601')$$,
                 'P0001', 'COURTESY_CAR_UNAVAILABLE', 'a second, overlapping reservation of the same car loses with a typed error');
select is((select count(*)::integer from public.courtesy_car_options('a3400000-0000-4000-8000-000000000502') where not free), 1,
          'options for B2: the Fiesta is taken');
select is((select name from public.courtesy_car_options('a3400000-0000-4000-8000-000000000502') where free), 'Polo',
          'options for B2: the Polo is free (switched-off cars are not offered)');
insert into outcome select 'loan2', to_jsonb(public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000502', 'a3400000-0000-4000-8000-000000000602',
                                                                           '2026-11-02 11:00Z', '2026-11-02 12:00Z', 'Short one'));
select is((select result->>'notes' from outcome where label = 'loan2'), 'Short one', 'an explicit window and notes are kept');
select throws_ok($$select public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000507', 'a3400000-0000-4000-8000-000000000602', '2026-11-03 12:00Z', '2026-11-03 11:00Z')$$,
                 'P0001', null, 'a loan that ends before it starts is refused');
select throws_ok($$select public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000501', 'a3400000-0000-4000-8000-000000000603')$$,
                 'P0001', 'COURTESY_CAR_NOT_FOUND', 'another garage''s car cannot be reserved');
select is((select count(*)::integer from public.courtesy_car_loans), 2, 'members read their garage''s loans');
reset role;

-- The constraint itself, whoever writes.
select throws_ok($$insert into public.courtesy_car_loans (garage_id, car_id, booking_id, customer_id, during)
                   values ('a3400000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000601', 'a3400000-0000-4000-8000-000000000502',
                           'a3400000-0000-4000-8000-000000000301', '[2026-11-02 17:00Z,2026-11-02 18:00Z)')$$,
                 '23P01', null, 'the exclusion constraint refuses an overlapping loan even for the service role');
select lives_ok($$insert into public.courtesy_car_loans (garage_id, car_id, booking_id, customer_id, during, status, cancelled_at)
                   values ('a3400000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000601', 'a3400000-0000-4000-8000-000000000502',
                           'a3400000-0000-4000-8000-000000000301', '[2026-11-02 12:00Z,2026-11-02 13:00Z)', 'cancelled', now())$$,
                'cancelled loans do not count');
select lives_ok($$insert into public.courtesy_car_loans (garage_id, car_id, booking_id, customer_id, during)
                   values ('a3400000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000601', 'a3400000-0000-4000-8000-000000000507',
                           'a3400000-0000-4000-8000-000000000301', '[2026-11-02 17:30Z,2026-11-02 19:00Z)')$$,
                'a loan may start exactly when the last one ends');

-- Cross-garage.
select pg_temp.as_member(pg_temp.oli(), pg_temp.o());
set local role authenticated;
select throws_ok($$select public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000501', 'a3400000-0000-4000-8000-000000000603')$$,
                 'P0001', 'BOOKING_NOT_FOUND', 'garage O cannot lend a car on P''s booking');
select is((select count(*)::integer from public.courtesy_car_loans), 0, 'garage O reads none of P''s loans');
reset role;
select pg_temp.as_member(pg_temp.oli(), pg_temp.p());
set local role authenticated;
select throws_ok($$select public.release_courtesy_car((select id from public.courtesy_car_loans limit 1))$$,
                 '42501', 'COURTESY_FORBIDDEN', 'a forged garage header is refused');
reset role;

-- Release, check out, check in.
select pg_temp.as_member(pg_temp.tim(), pg_temp.p());
set local role authenticated;
select is((public.release_courtesy_car((select (result->>'id')::uuid from outcome where label = 'loan2'), 'Customer has own car')).status,
          'cancelled', 'a reserved loan is released');
select is((public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000502', 'a3400000-0000-4000-8000-000000000602', '2026-11-02 11:00Z', '2026-11-02 12:00Z')).status,
          'reserved', 'the released car can be reserved again');
select is((public.check_out_courtesy_car((select (result->>'id')::uuid from outcome where label = 'loan1'), 1000, 6)).status,
          'out', 'the Fiesta is checked out');
select is((select mileage from public.courtesy_cars where id = 'a3400000-0000-4000-8000-000000000601'), 1000, 'the car''s mileage follows');
select throws_ok($$select public.check_out_courtesy_car((select id from public.courtesy_car_loans where booking_id = 'a3400000-0000-4000-8000-000000000507'), 1000, 6)$$,
                 'P0001', 'COURTESY_CAR_STILL_OUT', 'the next loan cannot hand over a car that has not come back');
select throws_ok($$select public.check_in_courtesy_car((select (result->>'id')::uuid from outcome where label = 'loan1'), 900, 4)$$,
                 'P0001', 'INVALID_LOAN: mileage in is below mileage out', 'mileage cannot go down');
select is((public.check_in_courtesy_car((select (result->>'id')::uuid from outcome where label = 'loan1'), 1040, 4, 'Scratch on rear bumper')).damage_notes,
          'Scratch on rear bumper', 'checked in with damage notes');
select throws_ok($$select public.release_courtesy_car((select (result->>'id')::uuid from outcome where label = 'loan1'))$$,
                 'P0001', 'LOAN_STATE: only a reserved loan can be released', 'a returned loan cannot be released');

-- Clock-change days: a Saturday BST loan and the Sunday the clocks go back
-- sit side by side; the Sunday window is 09:00-17:30 GMT.
select is(upper((public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000504', 'a3400000-0000-4000-8000-000000000602')).during),
          '2027-10-30 16:30Z'::timestamptz, 'Saturday (BST) loan ends 17:30 local');
select is(upper((public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000505', 'a3400000-0000-4000-8000-000000000602')).during),
          '2027-03-28 16:30Z'::timestamptz, 'loan on the day the clocks go forward ends 17:30 BST');
reset role;

-- ---------------------------------------------------------------------------
-- Customer requests
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.request_courtesy_car(pg_temp.p()::uuid, 'a3400000-0000-4000-8000-000000000503')->>'status', 'open',
          'a customer asks for a courtesy car on the day the clocks go back');
select is(public.request_courtesy_car(pg_temp.p()::uuid, 'a3400000-0000-4000-8000-000000000503')->>'replayed', 'true',
          'asking again returns the same request');
select is(public.request_courtesy_car(pg_temp.p()::uuid, 'a3400000-0000-4000-8000-000000000506')->>'free', 'true',
          'the request records that a car was free');
reset role;
select pg_temp.as_member(pg_temp.tim(), pg_temp.p());
set local role authenticated;
select is(upper((public.reserve_courtesy_car('a3400000-0000-4000-8000-000000000503', 'a3400000-0000-4000-8000-000000000601')).during),
          '2027-10-31 17:30Z'::timestamptz, 'Sunday the clocks go back: until 17:30 GMT');
select is((select status from public.courtesy_car_requests where booking_id = 'a3400000-0000-4000-8000-000000000503'), 'confirmed',
          'reserving a car confirms the open request');
select is((public.decline_courtesy_car_request((select id from public.courtesy_car_requests where booking_id = 'a3400000-0000-4000-8000-000000000506'))).status,
          'declined', 'staff can decline a request');
reset role;

-- ---------------------------------------------------------------------------
-- Collection and delivery
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.request_collection_delivery(pg_temp.p()::uuid, 'a3400000-0000-4000-8000-000000000501', 'dn4 5aa', '1 High Street')->>'status',
          'held', 'B1: the van is held for both legs');
select is((select during from public.collection_delivery_legs where booking_id = 'a3400000-0000-4000-8000-000000000501' and leg = 'collection' and status = 'held'),
          tstzrange('2026-11-02 08:00Z', '2026-11-02 09:00Z', '[)'), 'collection: out and back before the bay is taken');
select is((select during from public.collection_delivery_legs where booking_id = 'a3400000-0000-4000-8000-000000000501' and leg = 'delivery' and status = 'held'),
          tstzrange('2026-11-02 10:15Z', '2026-11-02 11:15Z', '[)'), 'delivery: after the job and its buffer');
select is(public.request_collection_delivery(pg_temp.p()::uuid, 'a3400000-0000-4000-8000-000000000501', 'DN4 5AA', null)->>'replayed', 'true',
          'asking again changes nothing');
select is(public.request_collection_delivery(pg_temp.p()::uuid, 'a3400000-0000-4000-8000-000000000502', 'DN4 6BB', '2 Low Road')->>'status',
          'partial', 'B2: the van is busy delivering B1 when B2 needs collecting');
select is((select status from public.collection_delivery_legs where booking_id = 'a3400000-0000-4000-8000-000000000502' and leg = 'collection' and status <> 'cancelled'),
          'unassigned', 'the collection leg waits for staff');
select ok(exists (select 1 from public.booking_events where booking_id = 'a3400000-0000-4000-8000-000000000502' and type = 'note'
                  and data->>'text' like 'Collection and delivery: no van free for the collection%'), 'and the booking says so');
select throws_ok($$select public.request_collection_delivery('a3400000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000507', 'DN4 5AA', null)$$,
                 'P0001', 'COLLECTION_NOT_OFFERED', 'a service without the option refuses it');
reset role;
select pg_temp.as_member(pg_temp.tim(), pg_temp.p());
set local role authenticated;
select throws_ok($$select public.hold_collection_delivery('a3400000-0000-4000-8000-000000000501', 'S1 1AA')$$,
                 'P0001', 'OUTSIDE_SERVICE_AREA', 'collection follows the mobile service area');
reset role;
select throws_ok($$insert into public.collection_delivery_legs (garage_id, booking_id, leg, resource_id, during, postcode)
                   values ('a3400000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000507', 'collection',
                           'a3400000-0000-4000-8000-000000000102', '[2026-11-02 08:30Z,2026-11-02 08:45Z)', 'DN4 5AA')$$,
                 '23P01', null, 'the van cannot be held twice at once');

-- ---------------------------------------------------------------------------
-- Following the booking
-- ---------------------------------------------------------------------------

update public.bookings set status = 'cancelled', cancellation_reason = 'pgTAP' where id = 'a3400000-0000-4000-8000-000000000502';
select is((select count(*)::integer from public.courtesy_car_loans where booking_id = 'a3400000-0000-4000-8000-000000000502' and status = 'reserved'), 0,
          'cancelling a booking releases its courtesy car');
select is((select count(*)::integer from public.collection_delivery_legs where booking_id = 'a3400000-0000-4000-8000-000000000502' and status <> 'cancelled'), 0,
          'and its van legs');

-- B4 moves from Sat 30 Oct 2027 09:00 BST to Sat 6 Nov 2027 09:00 GMT.
update public.bookings
set starts_at = '2027-11-06 09:00Z', ends_at = '2027-11-06 10:00Z', during = '[2027-11-06 09:00Z,2027-11-06 10:15Z)'
where id = 'a3400000-0000-4000-8000-000000000504';
select is((select during from public.courtesy_car_loans where booking_id = 'a3400000-0000-4000-8000-000000000504' and status = 'reserved'),
          tstzrange('2027-11-06 09:00Z', '2027-11-06 17:30Z', '[)'), 'a moved booking takes its reserved car along, across the clock change');

update public.bookings
set starts_at = starts_at + interval '2 hours', ends_at = ends_at + interval '2 hours',
    during = tstzrange(lower(during) + interval '2 hours', upper(during) + interval '2 hours', '[)')
where id = 'a3400000-0000-4000-8000-000000000501';
select is((select during from public.collection_delivery_legs where booking_id = 'a3400000-0000-4000-8000-000000000501' and leg = 'collection' and status = 'held'),
          tstzrange('2026-11-02 10:00Z', '2026-11-02 11:00Z', '[)'), 'its van legs are held again for the new time');

select * from finish();
rollback;
