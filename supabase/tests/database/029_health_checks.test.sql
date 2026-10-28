begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(70);

-- P5.3 digital health checks: health_checks, health_check_items,
-- health_check_media, the health-check-media bucket, start_health_check(),
-- claim_health_check_send(), open_health_check_link(),
-- record_health_check_decisions() and add_health_check_to_invoice().
--
-- Garage P (HCP) is on Pro (chosen) with MOT on and a messaging number; owner
-- Pia, technician Tod, front desk Fen. Garage E (HCE) is on Essentials; owner
-- Eve. Garage Q (HCQ) is on Pro with MOT off; owner Quin.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17290000-0000-4000-8000-0000000000a1', 'hc-owner@pgtap.test', '{}'::jsonb),
  ('17290000-0000-4000-8000-0000000000a2', 'hc-tech@pgtap.test', '{}'::jsonb),
  ('17290000-0000-4000-8000-0000000000a3', 'hc-desk@pgtap.test', '{}'::jsonb),
  ('17290000-0000-4000-8000-0000000000b1', 'hc-essentials@pgtap.test', '{}'::jsonb),
  ('17290000-0000-4000-8000-0000000000c1', 'hc-other@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen, mot_enabled) values
  ('a1729000-0000-4000-8000-000000000001', 'pgtap-hc-p', 'Health Pro', 'HCP', 'active', 'pro', null, 'pro', true),
  ('a1729000-0000-4000-8000-000000000002', 'pgtap-hc-e', 'Health Essentials', 'HCE', 'active', 'essentials', null, 'essentials', false),
  ('a1729000-0000-4000-8000-000000000003', 'pgtap-hc-q', 'Health Other', 'HCQ', 'active', 'pro', null, 'pro', false);
insert into public.garage_members (garage_id, user_id, role) values
  ('a1729000-0000-4000-8000-000000000001', '17290000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1729000-0000-4000-8000-000000000001', '17290000-0000-4000-8000-0000000000a2', 'technician'),
  ('a1729000-0000-4000-8000-000000000001', '17290000-0000-4000-8000-0000000000a3', 'front_desk'),
  ('a1729000-0000-4000-8000-000000000002', '17290000-0000-4000-8000-0000000000b1', 'owner'),
  ('a1729000-0000-4000-8000-000000000003', '17290000-0000-4000-8000-0000000000c1', 'owner');

create function pg_temp.p() returns uuid language sql as $$ select 'a1729000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a1729000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.q() returns uuid language sql as $$ select 'a1729000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true),
         set_config('request.headers', '{}', true);
$$;

insert into public.garage_phone_numbers (garage_id, number, purpose, provider_sid) values
  (pg_temp.p(), '+447700929000', 'messaging', 'PNpgtap029messaging');

insert into public.customers (id, garage_id, name, phone, email, preferred_contact, channel, opted_out_at) values
  ('a1729000-0000-4000-8000-000000000101', pg_temp.p(), 'Holly Check', '+447700929001', null, 'phone', 'sms', null),
  ('a1729000-0000-4000-8000-000000000102', pg_temp.p(), 'Otto Optout', '+447700929002', null, 'phone', 'sms', now()),
  ('a1729000-0000-4000-8000-000000000201', pg_temp.e(), 'Essie', '+447700929003', null, 'phone', 'sms', null),
  ('a1729000-0000-4000-8000-000000000301', pg_temp.q(), 'Quentin', '+447700929004', null, 'phone', 'sms', null);
insert into public.vehicles (id, garage_id, customer_id, registration) values
  ('a1729000-0000-4000-8000-000000000111', pg_temp.p(), 'a1729000-0000-4000-8000-000000000101', 'HC29AAA'),
  ('a1729000-0000-4000-8000-000000000112', pg_temp.p(), 'a1729000-0000-4000-8000-000000000102', 'HC29BBB'),
  ('a1729000-0000-4000-8000-000000000211', pg_temp.e(), 'a1729000-0000-4000-8000-000000000201', 'HC29EEE'),
  ('a1729000-0000-4000-8000-000000000311', pg_temp.q(), 'a1729000-0000-4000-8000-000000000301', 'HC29QQQ');
insert into public.resources (id, garage_id, name, kind, sort) values
  ('a1729000-0000-4000-8000-000000000121', pg_temp.p(), 'Bay 1', 'bay', 1),
  ('a1729000-0000-4000-8000-000000000221', pg_temp.e(), 'Bay 1', 'bay', 1),
  ('a1729000-0000-4000-8000-000000000321', pg_temp.q(), 'Bay 1', 'bay', 1);
insert into public.services (id, garage_id, name, duration_min, price_pence, price_mode) values
  ('a1729000-0000-4000-8000-000000000131', pg_temp.p(), 'Full service', 120, 18900, 'fixed'),
  ('a1729000-0000-4000-8000-000000000231', pg_temp.e(), 'Full service', 120, 18900, 'fixed'),
  ('a1729000-0000-4000-8000-000000000331', pg_temp.q(), 'Full service', 120, 18900, 'fixed');

create function pg_temp.booking(p_id uuid, p_garage uuid, p_ref text, p_customer uuid, p_vehicle uuid, p_resource uuid, p_service uuid, p_day integer, p_status text default 'confirmed')
returns void language sql as $$
  insert into public.bookings (id, garage_id, reference, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source)
  values (p_id, p_garage, p_ref, p_customer, p_vehicle, p_service, p_resource,
          '2096-03-01 09:00+00'::timestamptz + make_interval(days => p_day), '2096-03-01 11:00+00'::timestamptz + make_interval(days => p_day),
          tstzrange('2096-03-01 09:00+00'::timestamptz + make_interval(days => p_day), '2096-03-01 11:00+00'::timestamptz + make_interval(days => p_day)),
          p_status, 'phone');
$$;
select pg_temp.booking('a1729000-0000-4000-8000-000000000141', pg_temp.p(), 'HCP-0001', 'a1729000-0000-4000-8000-000000000101', 'a1729000-0000-4000-8000-000000000111', 'a1729000-0000-4000-8000-000000000121', 'a1729000-0000-4000-8000-000000000131', 0);
select pg_temp.booking('a1729000-0000-4000-8000-000000000142', pg_temp.p(), 'HCP-0002', 'a1729000-0000-4000-8000-000000000102', 'a1729000-0000-4000-8000-000000000112', 'a1729000-0000-4000-8000-000000000121', 'a1729000-0000-4000-8000-000000000131', 1);
select pg_temp.booking('a1729000-0000-4000-8000-000000000143', pg_temp.p(), 'HCP-0003', 'a1729000-0000-4000-8000-000000000101', 'a1729000-0000-4000-8000-000000000111', 'a1729000-0000-4000-8000-000000000121', 'a1729000-0000-4000-8000-000000000131', 2, 'cancelled');
select pg_temp.booking('a1729000-0000-4000-8000-000000000144', pg_temp.p(), 'HCP-0004', 'a1729000-0000-4000-8000-000000000101', 'a1729000-0000-4000-8000-000000000111', 'a1729000-0000-4000-8000-000000000121', 'a1729000-0000-4000-8000-000000000131', 3);
select pg_temp.booking('a1729000-0000-4000-8000-000000000241', pg_temp.e(), 'HCE-0001', 'a1729000-0000-4000-8000-000000000201', 'a1729000-0000-4000-8000-000000000211', 'a1729000-0000-4000-8000-000000000221', 'a1729000-0000-4000-8000-000000000231', 0);
select pg_temp.booking('a1729000-0000-4000-8000-000000000341', pg_temp.q(), 'HCQ-0001', 'a1729000-0000-4000-8000-000000000301', 'a1729000-0000-4000-8000-000000000311', 'a1729000-0000-4000-8000-000000000321', 'a1729000-0000-4000-8000-000000000331', 0);

-- ---------------------------------------------------------------------------
-- Schema, grants and storage
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from pg_class
           where relnamespace = 'public'::regnamespace and relname in ('health_checks', 'health_check_items', 'health_check_media') and relrowsecurity),
          3, 'the health check tables have RLS on');
select is((select count(*)::integer from unnest(array['health_checks', 'health_check_items', 'health_check_media']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select') or has_table_privilege('anon', 'public.' || t.name, 'insert')),
          0, 'anon has no access');
select is((select array_agg(attname::text order by attname::text) from pg_attribute
           where attrelid = 'public.health_checks'::regclass and attnum > 0 and not attisdropped
             and has_column_privilege('authenticated', 'public.health_checks', attname, 'update')),
          array['mileage', 'summary'], 'staff may only change the summary and mileage of a check');
select is((select array_agg(attname::text order by attname::text) from pg_attribute
           where attrelid = 'public.health_check_items'::regclass and attnum > 0 and not attisdropped
             and has_column_privilege('authenticated', 'public.health_check_items', attname, 'update')),
          array['label', 'note', 'price_pence', 'rating', 'recommended_work'], 'staff never write the customer''s decision');
select is(has_table_privilege('authenticated', 'public.health_checks', 'insert'), false, 'checks are created only by start_health_check()');
select is((select count(*)::integer from unnest(array[
             'public.claim_health_check_send(uuid, uuid, uuid, text, timestamptz, text, text)',
             'public.open_health_check_link(uuid, text, timestamptz)',
             'public.record_health_check_decisions(uuid, uuid, jsonb, timestamptz)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')),
          0, 'sending, the link and the customer''s decisions are service role only');
select is((select count(*)::integer from unnest(array['public.start_health_check(uuid)', 'public.add_health_check_to_invoice(uuid)']) f(name)
           where has_function_privilege('anon', f.name, 'execute')), 0, 'anon cannot start or invoice checks');
select is((select count(*)::integer from pg_proc
           where oid in ('public.start_health_check(uuid)'::regprocedure, 'public.add_health_check_to_invoice(uuid)'::regprocedure,
                         'public.record_health_check_decisions(uuid, uuid, jsonb, timestamptz)'::regprocedure,
                         'public.claim_health_check_send(uuid, uuid, uuid, text, timestamptz, text, text)'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 4, 'functions are security definer with an empty search_path');
select is((select public from storage.buckets where id = 'health-check-media'), false, 'the media bucket is private');
select is((select file_size_limit from storage.buckets where id = 'health-check-media'), 52428800::bigint, 'the bucket refuses files over 50 MB');
select ok((select allowed_mime_types @> array['image/jpeg', 'video/mp4', 'video/quicktime'] and not allowed_mime_types @> array['image/gif']
           from storage.buckets where id = 'health-check-media'), 'the bucket takes photos and MP4/MOV video only');
select is(public.plan_feature_plan('health_checks'), 'pro', 'health checks are a Pro feature');

-- ---------------------------------------------------------------------------
-- start_health_check: plan, garage and checklist
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17290000-0000-4000-8000-0000000000b1', pg_temp.e());
set local role authenticated;
select throws_ok($$select public.start_health_check('a1729000-0000-4000-8000-000000000241')$$,
                 'P0001', 'PLAN_REQUIRED: health_checks', 'an Essentials garage cannot start a health check');
reset role;

select pg_temp.as_member('17290000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select throws_ok($$select public.start_health_check('a1729000-0000-4000-8000-000000000341')$$,
                 'P0001', 'BOOKING_NOT_FOUND', 'another garage''s booking is not found');
select throws_ok($$select public.start_health_check('a1729000-0000-4000-8000-000000000143')$$,
                 'P0001', 'BOOKING_CLOSED', 'a cancelled booking gets no health check');
create temporary table hc_ids (label text primary key, id uuid) on commit drop;
grant all on hc_ids to authenticated, service_role;
insert into hc_ids values ('main', public.start_health_check('a1729000-0000-4000-8000-000000000141'));
select is(public.start_health_check('a1729000-0000-4000-8000-000000000141'), (select id from hc_ids where label = 'main'),
          'a technician on Pro starts a check; starting again returns the same one');
select is((select count(*)::integer from public.health_check_items where check_id = (select id from hc_ids where label = 'main')), 25,
          'the default checklist has 25 lines with MOT on');
select is((select count(*)::integer from public.health_check_items where check_id = (select id from hc_ids where label = 'main') and mot_related), 5,
          'including the MOT lines');
select is((select status from public.health_checks where id = (select id from hc_ids where label = 'main')), 'draft', 'a new check is a draft');
reset role;

select pg_temp.as_member('17290000-0000-4000-8000-0000000000c1', pg_temp.q());
set local role authenticated;
insert into hc_ids values ('q', public.start_health_check('a1729000-0000-4000-8000-000000000341'));
select is((select count(*)::integer from public.health_check_items where check_id = (select id from hc_ids where label = 'q')), 20,
          'without MOT the checklist leaves the MOT lines out');
select is((select count(*)::integer from public.health_checks where garage_id = pg_temp.p()), 0, 'garage Q reads none of garage P''s checks');
select is((select count(*)::integer from public.health_check_items where garage_id = pg_temp.p()), 0, 'or their lines');
with changed as (
  update public.health_check_items set rating = 'red' where garage_id = pg_temp.p() returning 1
)
select is((select count(*)::integer from changed), 0, 'garage Q cannot change garage P''s lines');
reset role;

-- ---------------------------------------------------------------------------
-- Staff edit lines and media (Pro, before the customer decides)
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17290000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
with changed as (
  update public.health_check_items
  set rating = 'red', note = 'Worn to 1.5 mm', recommended_work = 'Two front tyres', price_pence = 16000
  where check_id = (select id from hc_ids where label = 'main') and label = 'Front left tyre'
  returning 1
)
select is((select count(*)::integer from changed), 1, 'a technician rates a line and recommends priced work');
update public.health_check_items
set rating = 'amber', recommended_work = 'Front pads', price_pence = 8950
where check_id = (select id from hc_ids where label = 'main') and label = 'Front brake pads and discs';
update public.health_check_items set rating = 'green'
where check_id = (select id from hc_ids where label = 'main') and section = 'lights';
select throws_ok($$update public.health_check_items set recommended_work = 'Wipers' where label = 'Wiper blades'$$,
                 '23514', null, 'recommended work needs a price');
select throws_ok($$update public.health_check_items set decision = 'approved' where label = 'Wiper blades'$$,
                 '42501', null, 'staff cannot set the customer''s decision');
insert into public.health_check_items (check_id, section, label, position, rating, note)
values ((select id from hc_ids where label = 'main'), 'other', 'Rear wiper arm', 900, 'amber', 'Loose');
select is((select count(*)::integer from public.health_check_items where check_id = (select id from hc_ids where label = 'main')), 26,
          'staff add their own line');
select lives_ok(format($$insert into public.health_check_media (check_id, object_path, content_type, size_bytes, kind)
                         values (%L, %L, 'image/jpeg', 2048, 'image')$$,
                       (select id from hc_ids where label = 'main'),
                       pg_temp.p() || '/health-checks/' || (select id from hc_ids where label = 'main') || '/11111111-1111-4111-8111-111111111111.jpg'),
                'staff add a photo in their garage''s folder for this check');
select throws_ok(format($$insert into public.health_check_media (check_id, object_path, content_type, size_bytes, kind)
                          values (%L, %L, 'image/jpeg', 2048, 'image')$$,
                        (select id from hc_ids where label = 'main'),
                        pg_temp.q() || '/health-checks/' || (select id from hc_ids where label = 'main') || '/22222222-2222-4222-8222-222222222222.jpg'),
                 '23514', null, 'a path outside the garage''s folder is refused');
select throws_ok(format($$insert into public.health_check_media (check_id, object_path, content_type, size_bytes, kind)
                          values (%L, %L, 'video/mp4', 60000000, 'video')$$,
                        (select id from hc_ids where label = 'main'),
                        pg_temp.p() || '/health-checks/' || (select id from hc_ids where label = 'main') || '/33333333-3333-4333-8333-333333333333.mp4'),
                 '23514', null, 'videos over 50 MB are refused');
select throws_ok(format($$insert into public.health_check_media (check_id, object_path, content_type, size_bytes, kind)
                          values (%L, %L, 'image/gif', 2048, 'image')$$,
                        (select id from hc_ids where label = 'main'),
                        pg_temp.p() || '/health-checks/' || (select id from hc_ids where label = 'main') || '/44444444-4444-4444-8444-444444444444.jpg'),
                 '23514', null, 'other file types are refused');
reset role;

-- Storage: staff of the garage read its folder, nobody else does.
insert into storage.objects (bucket_id, name, metadata)
values ('health-check-media', pg_temp.p() || '/health-checks/' || (select id from hc_ids where label = 'main') || '/11111111-1111-4111-8111-111111111111.jpg',
        '{"size": 2048, "mimetype": "image/jpeg"}'::jsonb);
select pg_temp.as_member('17290000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from storage.objects where bucket_id = 'health-check-media'), 1, 'garage P staff see their media object');
reset role;
select pg_temp.as_member('17290000-0000-4000-8000-0000000000c1', pg_temp.q());
set local role authenticated;
select is((select count(*)::integer from storage.objects where bucket_id = 'health-check-media'), 0, 'garage Q staff do not');
reset role;
select pg_temp.as_member('17290000-0000-4000-8000-0000000000c1', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from storage.objects where bucket_id = 'health-check-media'), 0, 'not even by forging garage P');
reset role;

-- ---------------------------------------------------------------------------
-- Sending (service role claim)
-- ---------------------------------------------------------------------------

select pg_temp.as_service();
set local role service_role;
select is(public.claim_health_check_send(pg_temp.p(), (select id from hc_ids where label = 'main'), '17290000-0000-4000-8000-0000000000a2',
            repeat('a', 64), now() + interval '14 days', 'Your health check is ready', 'mock') ->> 'reason',
          'not_allowed', 'technicians fill checks but do not send them');
select throws_ok(format($$select public.claim_health_check_send(%L, %L, '17290000-0000-4000-8000-0000000000a3', %L, now() + interval '14 days', %L, 'mock')$$,
                        pg_temp.p(), (select id from hc_ids where label = 'main'), repeat('a', 64),
                        'Health check: https://book.example/hc/abcdefghijklmnopqrstuv'),
                 '22023', null, 'the stored body never holds the link token');
insert into hc_ids values ('optout', null);
reset role;
select pg_temp.as_member('17290000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
update hc_ids set id = public.start_health_check('a1729000-0000-4000-8000-000000000142') where label = 'optout';
select is(public.start_health_check('a1729000-0000-4000-8000-000000000144') is not null, true, 'the owner starts a second check');
insert into hc_ids values ('second', public.start_health_check('a1729000-0000-4000-8000-000000000144'));
update public.health_check_items set rating = 'green' where check_id in (select id from hc_ids where label in ('optout', 'second'));
update public.health_check_items set rating = 'amber', recommended_work = 'Wiper blades', price_pence = 2400
where check_id = (select id from hc_ids where label = 'second') and label = 'Wiper blades';
reset role;
select pg_temp.as_service();
set local role service_role;
select is(public.claim_health_check_send(pg_temp.p(), (select id from hc_ids where label = 'optout'), '17290000-0000-4000-8000-0000000000a3',
            repeat('b', 64), now() + interval '14 days', 'Your health check is ready', 'mock') ->> 'reason',
          'opted_out', 'a customer who texted STOP gets no text');
create temporary table hc_claim on commit drop as
  select public.claim_health_check_send(pg_temp.p(), (select id from hc_ids where label = 'main'), '17290000-0000-4000-8000-0000000000a3',
           encode(extensions.digest('main-token', 'sha256'), 'hex'), now() + interval '14 days',
           'Health Pro: your car''s health check is ready: https://book.example/hc/… Reply STOP to opt out', 'mock') as result;
select is((select result ->> 'status' from hc_claim), 'claimed', 'front desk sends the check');
select is((select result ->> 'to' from hc_claim), '+447700929001', 'to the customer''s mobile');
select is((select booking_id from public.messages where id = (select (result ->> 'message_id')::uuid from hc_claim)),
          'a1729000-0000-4000-8000-000000000141'::uuid, 'the outbound message row is recorded against the booking');
select is((select status || ':' || sent_count::text || ':' || sent_channel from public.health_checks where id = (select id from hc_ids where label = 'main')),
          'sent:1:sms', 'the check is sent');
select is(public.claim_health_check_send(pg_temp.p(), (select id from hc_ids where label = 'second'), '17290000-0000-4000-8000-0000000000a1',
            encode(extensions.digest('second-token', 'sha256'), 'hex'), now() + interval '14 days', 'Your health check is ready', 'mock') ->> 'status',
          'claimed', 'the owner sends the second check');

-- ---------------------------------------------------------------------------
-- The customer's link and decisions
-- ---------------------------------------------------------------------------

select is(public.open_health_check_link(pg_temp.p(), encode(extensions.digest('main-token', 'sha256'), 'hex')) ->> 'check_id',
          (select id::text from hc_ids where label = 'main'), 'the link opens the check on its own garage');
select is(public.open_health_check_link(pg_temp.q(), encode(extensions.digest('main-token', 'sha256'), 'hex')) ->> 'status',
          'invalid', 'and on no other garage''s host');
select is(public.open_health_check_link(pg_temp.p(), encode(extensions.digest('main-token', 'sha256'), 'hex'), now() + interval '15 days') ->> 'status',
          'expired', 'links expire');
select ok((select first_viewed_at is not null from public.health_checks where id = (select id from hc_ids where label = 'main')), 'the first view is noted');

create function pg_temp.decisions(p_tyres text, p_tyre_price integer, p_pads text) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('item_id', (select id from public.health_check_items where label = 'Front left tyre' and check_id = (select id from hc_ids where label = 'main')),
                       'decision', p_tyres, 'price_pence', p_tyre_price),
    jsonb_build_object('item_id', (select id from public.health_check_items where label = 'Front brake pads and discs' and check_id = (select id from hc_ids where label = 'main')),
                       'decision', p_pads, 'price_pence', 8950));
$$;
select is(public.record_health_check_decisions(pg_temp.p(), (select id from hc_ids where label = 'main'), pg_temp.decisions('approved', 15000, 'declined')) ->> 'status',
          'changed', 'a price that changed since the customer looked is refused');
select is(public.record_health_check_decisions(pg_temp.p(), (select id from hc_ids where label = 'main'), pg_temp.decisions('maybe', 16000, 'declined')) ->> 'status',
          'invalid', 'decisions are approve or decline');
select is(public.record_health_check_decisions(pg_temp.p(), (select id from hc_ids where label = 'main'), pg_temp.decisions('approved', 16000, null)) ->> 'status',
          'invalid', 'every recommended line needs a decision');
select is(public.record_health_check_decisions(pg_temp.q(), (select id from hc_ids where label = 'main'), pg_temp.decisions('approved', 16000, 'declined')) ->> 'status',
          'not_found', 'another garage cannot decide this check');
create temporary table hc_recorded on commit drop as
  select public.record_health_check_decisions(pg_temp.p(), (select id from hc_ids where label = 'main'), pg_temp.decisions('approved', 16000, 'declined')) as result;
select is((select result ->> 'status' || ':' || (result ->> 'approved_total_pence') from hc_recorded), 'recorded:16000', 'the customer approves the tyres and declines the pads');
select is((select status || ':' || approved_total_pence::text from public.health_checks where id = (select id from hc_ids where label = 'main')),
          'responded:16000', 'the check holds the approved total');
select is((select data ->> 'text' from public.booking_events
           where booking_id = 'a1729000-0000-4000-8000-000000000141' and type = 'note' and actor = 'customer'),
          'Health check: the customer approved £160.00 of extra work: Two front tyres. Declined 1 item.', 'the booking gets a note');
select is(public.record_health_check_decisions(pg_temp.p(), (select id from hc_ids where label = 'main'), pg_temp.decisions('declined', 16000, 'declined')) ->> 'status',
          'already', 'deciding again changes nothing');
select is((select count(*)::integer from public.booking_events where booking_id = 'a1729000-0000-4000-8000-000000000141' and type = 'note'), 1,
          'and adds no second note');
reset role;

select pg_temp.as_member('17290000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
with changed as (
  update public.health_check_items set note = 'Changed after' where check_id = (select id from hc_ids where label = 'main') returning 1
)
select is((select count(*)::integer from changed), 0, 'a decided check is locked for staff');
reset role;

-- ---------------------------------------------------------------------------
-- Invoicing (existing save_invoice_draft())
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17290000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select throws_ok(format($$select public.add_health_check_to_invoice(%L)$$, (select id from hc_ids where label = 'second')),
                 'P0001', 'HEALTH_CHECK_NOT_RESPONDED', 'nothing goes on the invoice before the customer decides');
create temporary table hc_invoice on commit drop as
  select public.add_health_check_to_invoice((select id from hc_ids where label = 'main')) as result;
grant all on hc_invoice to authenticated;
select is((select (result ->> 'created')::boolean from hc_invoice), true, 'a new draft invoice is created for the booking');
select is((select status::text || ':' || source_type || ':' || total_pence::text || ':' || tax_pence::text from public.invoices
           where id = (select (result ->> 'invoice_id')::uuid from hc_invoice)),
          'draft:booking:16000:0', 'with the approved work at the approved price and no VAT');
select is((select description from public.invoice_items where invoice_id = (select (result ->> 'invoice_id')::uuid from hc_invoice)),
          'Health check: Two front tyres (Front left tyre)', 'the line says what the work is');
select is(public.add_health_check_to_invoice((select id from hc_ids where label = 'main')) ->> 'already', 'true', 'adding again is a no-op');
select is((select count(*)::integer from public.invoice_items where invoice_id = (select (result ->> 'invoice_id')::uuid from hc_invoice)), 1,
          'so the line is there once');
reset role;

-- An existing draft for the booking is extended, not replaced.
select pg_temp.as_service();
set local role service_role;
select is(public.record_health_check_decisions(pg_temp.p(), (select id from hc_ids where label = 'second'),
            jsonb_build_array(jsonb_build_object('item_id', (select id from public.health_check_items where label = 'Wiper blades' and check_id = (select id from hc_ids where label = 'second')),
                                                 'decision', 'approved', 'price_pence', 2400))) ->> 'status',
          'recorded', 'the second customer approves the wipers');
reset role;
select pg_temp.as_member('17290000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
insert into hc_ids values ('draft', public.save_invoice_draft(null, jsonb_build_object(
  'source_type', 'booking', 'booking_id', 'a1729000-0000-4000-8000-000000000144',
  'items', jsonb_build_array(jsonb_build_object('description', 'Full service', 'quantity', 1, 'unit_price_pence', 18900))), false));
select is(public.add_health_check_to_invoice((select id from hc_ids where label = 'second')) ->> 'invoice_id',
          (select id::text from hc_ids where label = 'draft'), 'approved work goes on the booking''s existing draft');
select is((select string_agg(description || '=' || line_total_pence::text, ', ' order by position) from public.invoice_items
           where invoice_id = (select id from hc_ids where label = 'draft')),
          'Full service=18900, Health check: Wiper blades (Wiper blades)=2400', 'after the lines already on it');
reset role;

-- ---------------------------------------------------------------------------
-- After a downgrade to Essentials: readable, not writable
-- ---------------------------------------------------------------------------

update public.garages set plan = 'essentials', plan_chosen = 'essentials' where id = pg_temp.p();
select pg_temp.as_member('17290000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.health_checks where garage_id = pg_temp.p()), 3, 'an Essentials garage still reads its checks');
with changed as (
  update public.health_check_items set rating = 'red' where check_id = (select id from hc_ids where label = 'optout') returning 1
)
select is((select count(*)::integer from changed), 0, 'but cannot change them');
select throws_ok(format($$select public.start_health_check(%L)$$, 'a1729000-0000-4000-8000-000000000141'),
                 'P0001', 'PLAN_REQUIRED: health_checks', 'or open one');
reset role;
select pg_temp.as_service();
set local role service_role;
select is(public.claim_health_check_send(pg_temp.p(), (select id from hc_ids where label = 'optout'), '17290000-0000-4000-8000-0000000000a1',
            repeat('c', 64), now() + interval '14 days', 'Your health check is ready', 'mock') ->> 'reason',
          'plan_required', 'or send one');
reset role;

select * from finish();
rollback;
