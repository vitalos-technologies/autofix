begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(73);

-- P5.11 customer service plans (migration 20261029001100).
--
-- Garage P (SPP): paid Pro, Europe/London, mock payment account active. Owner
-- Pam, technician Tim, front desk Fay. Garage E (SPE): Essentials, owner Eve.
-- Garage O (SPO): Pro, owner Oli, its own plan.
--
-- Plans in P: "Gold" £19.99/month, 10% off, Full service included once a
-- plan year, MOT twice.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('13700000-0000-4000-8000-0000000000a1', 'sp-owner-p@pgtap.test', '{}'::jsonb),
  ('13700000-0000-4000-8000-0000000000a2', 'sp-tech-p@pgtap.test', '{}'::jsonb),
  ('13700000-0000-4000-8000-0000000000a3', 'sp-desk-p@pgtap.test', '{}'::jsonb),
  ('13700000-0000-4000-8000-0000000000b1', 'sp-owner-e@pgtap.test', '{}'::jsonb),
  ('13700000-0000-4000-8000-0000000000c1', 'sp-owner-o@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen) values
  ('a3700000-0000-4000-8000-000000000001', 'pgtap-sp-p', 'Plans P', 'SPP', 'active', 'pro', null, 'pro'),
  ('a3700000-0000-4000-8000-000000000002', 'pgtap-sp-e', 'Plans E', 'SPE', 'active', 'essentials', null, 'essentials'),
  ('a3700000-0000-4000-8000-000000000003', 'pgtap-sp-o', 'Plans O', 'SPO', 'active', 'pro', null, 'pro');
insert into public.garage_members (garage_id, user_id, role) values
  ('a3700000-0000-4000-8000-000000000001', '13700000-0000-4000-8000-0000000000a1', 'owner'),
  ('a3700000-0000-4000-8000-000000000001', '13700000-0000-4000-8000-0000000000a2', 'technician'),
  ('a3700000-0000-4000-8000-000000000001', '13700000-0000-4000-8000-0000000000a3', 'front_desk'),
  ('a3700000-0000-4000-8000-000000000002', '13700000-0000-4000-8000-0000000000b1', 'owner'),
  ('a3700000-0000-4000-8000-000000000003', '13700000-0000-4000-8000-0000000000c1', 'owner');

insert into public.payment_accounts (garage_id, provider, account_ref, status, charges_enabled) values
  ('a3700000-0000-4000-8000-000000000001', 'mock', 'mock_acct_pgtap037p', 'active', true),
  ('a3700000-0000-4000-8000-000000000002', 'mock', 'mock_acct_pgtap037e', 'active', true);

insert into public.resources (id, garage_id, name, kind, sort) values
  ('a3700000-0000-4000-8000-000000000101', 'a3700000-0000-4000-8000-000000000001', 'Bay 1', 'bay', 1);
insert into public.services (id, garage_id, name, duration_min, buffer_min, price_pence, price_mode, location_mode, resource_kind) values
  ('a3700000-0000-4000-8000-000000000201', 'a3700000-0000-4000-8000-000000000001', 'Full service', 60, 0, 15000, 'fixed', 'workshop', 'bay'),
  ('a3700000-0000-4000-8000-000000000202', 'a3700000-0000-4000-8000-000000000001', 'MOT test', 60, 0, 5485, 'fixed', 'workshop', 'bay'),
  ('a3700000-0000-4000-8000-000000000203', 'a3700000-0000-4000-8000-000000000001', 'Brake check', 30, 0, 4000, 'fixed', 'workshop', 'bay'),
  ('a3700000-0000-4000-8000-000000000204', 'a3700000-0000-4000-8000-000000000002', 'E service', 60, 0, 9000, 'fixed', 'workshop', 'bay'),
  ('a3700000-0000-4000-8000-000000000205', 'a3700000-0000-4000-8000-000000000003', 'O service', 60, 0, 9000, 'fixed', 'workshop', 'bay');

create function pg_temp.as_member(p_user text, p_garage text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true),
         set_config('request.headers', '{}', true);
$$;
create function pg_temp.p() returns text language sql as $$ select 'a3700000-0000-4000-8000-000000000001' $$;
create function pg_temp.e() returns text language sql as $$ select 'a3700000-0000-4000-8000-000000000002' $$;
create function pg_temp.o() returns text language sql as $$ select 'a3700000-0000-4000-8000-000000000003' $$;
create function pg_temp.pam() returns text language sql as $$ select '13700000-0000-4000-8000-0000000000a1' $$;
create function pg_temp.tim() returns text language sql as $$ select '13700000-0000-4000-8000-0000000000a2' $$;
create function pg_temp.fay() returns text language sql as $$ select '13700000-0000-4000-8000-0000000000a3' $$;
create function pg_temp.eve() returns text language sql as $$ select '13700000-0000-4000-8000-0000000000b1' $$;
create function pg_temp.oli() returns text language sql as $$ select '13700000-0000-4000-8000-0000000000c1' $$;
create temp table ids (label text primary key, id uuid not null);
create temp table outcome (label text primary key, result jsonb not null);
grant all on ids, outcome to authenticated, service_role;

-- A booking of service p_service for the car of subscription p_sub, inserted directly (create_booking() is covered by 012).
create function pg_temp.book(p_label text, p_service text, p_start timestamptz) returns uuid language sql as $$
  insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source)
  select s.garage_id, s.customer_id, s.vehicle_id, p_service::uuid, 'a3700000-0000-4000-8000-000000000101',
         p_start, p_start + interval '1 hour', tstzrange(p_start, p_start + interval '1 hour', '[)'), 'confirmed', 'phone'
  from public.customer_plan_subscriptions s where s.id = (select id from ids where label = 'sub')
  returning id;
$$;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from unnest(array['service_plans', 'service_plan_inclusions', 'customer_plan_subscriptions', 'service_plan_uses', 'service_plan_invoice_applications']) t(name)
           join pg_class rel on rel.relname = t.name and rel.relnamespace = 'public'::regnamespace
           where rel.relrowsecurity), 5, 'the five service plan tables have RLS on');
select is((select count(*)::integer from unnest(array['service_plans', 'service_plan_inclusions', 'customer_plan_subscriptions', 'service_plan_uses', 'service_plan_invoice_applications']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select')), 0, 'anon reads none of them');
select is((select count(*)::integer from unnest(array['customer_plan_subscriptions', 'service_plan_uses', 'service_plan_invoice_applications']) t(name)
           where has_table_privilege('authenticated', 'public.' || t.name, 'insert')
              or has_table_privilege('authenticated', 'public.' || t.name, 'update')
              or has_table_privilege('authenticated', 'public.' || t.name, 'delete')), 0, 'staff write subscriptions, uses and applications only through functions');
select is((select count(*)::integer from unnest(array[
             'public.start_plan_signup(uuid, uuid, jsonb, jsonb, text)', 'public.apply_plan_subscription_status(uuid, uuid, text, text, text, text, timestamptz, timestamptz)',
             'public.record_plan_booking(uuid, uuid)', 'public.set_plan_subscription_checkout(uuid, uuid, text)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')), 0,
          'the sign-up, webhook and booking-flow functions are service role only');
select is((select count(*)::integer from pg_trigger where tgname = 'bookings_service_plans_follow'), 1, 'a trigger follows booking cancellations');

-- ---------------------------------------------------------------------------
-- Plans: Pro owners and managers only
-- ---------------------------------------------------------------------------

select pg_temp.as_member(pg_temp.pam(), pg_temp.p());
set local role authenticated;
insert into ids values ('gold', (public.save_service_plan(null, jsonb_build_object(
  'name', '  Gold   plan ', 'description', 'Everything for one car', 'price_pence', 1999, 'discount_percent', 10, 'priority_booking', true,
  'inclusions', jsonb_build_array(
    jsonb_build_object('service_id', 'a3700000-0000-4000-8000-000000000201', 'uses_per_year', 1),
    jsonb_build_object('service_id', 'a3700000-0000-4000-8000-000000000202', 'uses_per_year', 2))))).id);
select is((select name || ':' || price_pence || ':' || discount_percent || ':' || priority_booking || ':' || status from public.service_plans where id = (select id from ids where label = 'gold')),
          'Gold plan:1999:10:true:active', 'the owner creates a plan (name tidied)');
select is((select count(*)::integer from public.service_plan_inclusions where plan_id = (select id from ids where label = 'gold')), 2, 'with its two included services');
select throws_ok($$select public.save_service_plan(null, '{"name":"Free","price_pence":50,"inclusions":[]}'::jsonb)$$,
                 'P0001', 'INVALID_PLAN: price', 'a plan costs at least £1');
select throws_ok($$select public.save_service_plan(null, '{"name":"Empty","price_pence":500,"inclusions":[]}'::jsonb)$$,
                 'P0001', 'INVALID_PLAN: a plan must include something', 'a plan must include something');
select throws_ok($$select public.save_service_plan(null, '{"name":"Other","price_pence":500,"inclusions":[{"service_id":"a3700000-0000-4000-8000-000000000205"}]}'::jsonb)$$,
                 'P0001', 'INVALID_PLAN: unknown service', 'another garage''s service cannot be included');
select lives_ok(format($$select public.save_service_plan(%L, '{"name":"Gold plan","price_pence":2499,"discount_percent":10,"priority_booking":true,"inclusions":[{"service_id":"a3700000-0000-4000-8000-000000000201","uses_per_year":1},{"service_id":"a3700000-0000-4000-8000-000000000202","uses_per_year":2}]}'::jsonb)$$,
                        (select id from ids where label = 'gold')), 'the owner changes the price');
select is((select price_pence from public.service_plans where id = (select id from ids where label = 'gold')), 2499, 'the new price is stored');
select lives_ok($$insert into public.service_plans (name, price_pence) values ('Direct insert', 900)$$, 'owners may also write plans through RLS on Pro');
reset role;

select pg_temp.as_member(pg_temp.tim(), pg_temp.p());
set local role authenticated;
select throws_ok($$select public.save_service_plan(null, '{"name":"Tech plan","price_pence":500,"discount_percent":5}'::jsonb)$$,
                 '42501', 'SERVICE_PLANS_FORBIDDEN', 'a technician cannot create plans');
select throws_ok($$insert into public.service_plans (name, price_pence) values ('Tech insert', 900)$$, '42501', null, 'nor through RLS');
select is((select count(*)::integer from public.service_plans where garage_id = pg_temp.p()::uuid), 2, 'but reads them');
reset role;

select pg_temp.as_member(pg_temp.eve(), pg_temp.e());
set local role authenticated;
select throws_ok($$select public.save_service_plan(null, '{"name":"E plan","price_pence":500,"discount_percent":5}'::jsonb)$$,
                 'P0001', 'PLAN_REQUIRED: service_plans', 'an Essentials owner cannot create plans');
select throws_ok($$insert into public.service_plans (name, price_pence) values ('E insert', 900)$$, '42501', null, 'nor through RLS');
reset role;

select pg_temp.as_member(pg_temp.oli(), pg_temp.o());
set local role authenticated;
insert into ids values ('oplan', (public.save_service_plan(null, '{"name":"O plan","price_pence":900,"discount_percent":5}'::jsonb)).id);
select throws_ok(format($$select public.save_service_plan(%L, '{"name":"Hijack","price_pence":100,"discount_percent":5}'::jsonb)$$, (select id from ids where label = 'gold')),
                 'P0001', 'SERVICE_PLAN_NOT_FOUND', 'another garage''s owner cannot change P''s plan');
select is((select count(*)::integer from public.service_plans where id = (select id from ids where label = 'gold')), 0, 'nor see it');
select throws_ok(format($$select public.set_service_plan_status(%L, 'archived')$$, (select id from ids where label = 'gold')),
                 'P0001', 'SERVICE_PLAN_NOT_FOUND', 'nor archive it');
reset role;

-- ---------------------------------------------------------------------------
-- Sign-up (service role, the garage host)
-- ---------------------------------------------------------------------------

insert into public.customers (id, garage_id, name, phone, preferred_contact, channel, reminder_consent, consent_at, consent_source, consent_text)
values ('a3700000-0000-4000-8000-000000000301', pg_temp.p()::uuid, 'Old Name', '+447700903701', 'phone', 'sms', true, now(), 'booking', 'Yes please');

select pg_temp.as_service();
set local role service_role;
insert into ids values ('sub', (public.start_plan_signup(pg_temp.p()::uuid, (select id from ids where label = 'gold'),
  '{"name":"Sally Signup","phone":"+447700903701","email":"Sally@Example.test","channel":"sms"}'::jsonb,
  '{"registration":"sp37 abc","make":"Ford","model":"Fiesta"}'::jsonb, 'mock')).id);
select is((select status || ':' || price_pence || ':' || provider from public.customer_plan_subscriptions where id = (select id from ids where label = 'sub')),
          'pending_mandate:2499:mock', 'a sign-up starts as pending_mandate at the plan''s price');
select is((select name || ':' || email || ':' || reminder_consent from public.customers where id = 'a3700000-0000-4000-8000-000000000301'),
          'Sally Signup:sally@example.test:true', 'the customer is linked by phone; consent is untouched');
select is((select registration || ':' || make from public.vehicles where id = (select vehicle_id from public.customer_plan_subscriptions where id = (select id from ids where label = 'sub'))),
          'SP37ABC:Ford', 'the car is stored normalised');
select is((public.start_plan_signup(pg_temp.p()::uuid, (select id from ids where label = 'gold'),
  '{"name":"Sally Signup","phone":"+447700903701","channel":"sms"}'::jsonb, '{"registration":"SP37ABC"}'::jsonb, 'mock')).id,
  (select id from ids where label = 'sub'), 'signing up again before the mandate reuses the pending sign-up');
select throws_ok(format($$select public.start_plan_signup(%L, %L, '{"name":"Eli","phone":"+447700903702","channel":"sms"}'::jsonb, '{"registration":"SP37EEE"}'::jsonb, 'mock')$$,
                        pg_temp.e(), (select id from ids where label = 'gold')),
                 'P0001', 'PLAN_REQUIRED: service_plans', 'an Essentials garage takes no sign-ups');
select throws_ok(format($$select public.start_plan_signup(%L, %L, '{"name":"Ola","phone":"+447700903703","channel":"sms"}'::jsonb, '{"registration":"SP37OOO"}'::jsonb, 'mock')$$,
                        pg_temp.p(), (select id from ids where label = 'oplan')),
                 'P0001', 'PLAN_NOT_AVAILABLE', 'another garage''s plan cannot be signed up to on this host');
select throws_ok(format($$select public.start_plan_signup(%L, %L, '{"name":"Ola","phone":"+447700903703","channel":"sms"}'::jsonb, '{"registration":"SP37OOO"}'::jsonb, 'mock')$$,
                        pg_temp.o(), (select id from ids where label = 'oplan')),
                 'P0001', 'PAYMENTS_NOT_READY', 'a garage without an active payment account takes no sign-ups');
select throws_ok(format($$select public.start_plan_signup(%L, %L, '{"name":"Ola","phone":"07700","channel":"sms"}'::jsonb, '{"registration":"SP37OOO"}'::jsonb, 'mock')$$,
                        pg_temp.p(), (select id from ids where label = 'gold')),
                 'P0001', 'INVALID_SIGNUP: phone', 'the phone must be E.164');

-- Mandate confirmed: active once, confirmation once.
insert into outcome values ('active1', public.apply_plan_subscription_status(pg_temp.p()::uuid, (select id from ids where label = 'sub'), 'mock', 'active',
  'mock_mandate_1', 'mock_sub_1', '2026-12-02 09:00Z', '2026-11-02 09:00Z'));
insert into outcome values ('active2', public.apply_plan_subscription_status(pg_temp.p()::uuid, (select id from ids where label = 'sub'), 'mock', 'active',
  'mock_mandate_1', 'mock_sub_1', null, '2026-11-02 09:05Z'));
select is((select result ->> 'notify' from outcome where label = 'active1'), 'confirmation', 'pending -> active asks for the sign-up confirmation');
select is((select coalesce(result ->> 'notify', 'none') || ':' || (result ->> 'changed') from outcome where label = 'active2'), 'none:false', 'the same news again sends nothing');
select is((select status || ':' || started_at::text || ':' || renews_at::text from public.customer_plan_subscriptions where id = (select id from ids where label = 'sub')),
          'active:2026-11-02 09:00:00+00:2026-12-02 09:00:00+00', 'started_at and renews_at are stored');
select throws_ok(format($$select public.apply_plan_subscription_status(%L, %L, 'stripe', 'past_due', null, null, null)$$, pg_temp.p(), (select id from ids where label = 'sub')),
                 'P0001', 'PROVIDER_MISMATCH', 'another provider cannot change it');
select throws_ok(format($$select public.apply_plan_subscription_status(%L, %L, 'mock', 'past_due', null, 'mock_sub_other', null)$$, pg_temp.p(), (select id from ids where label = 'sub')),
                 'P0001', 'PROVIDER_MISMATCH', 'nor another subscription''s event');
select throws_ok(format($$select public.apply_plan_subscription_status(%L, %L, 'mock', 'past_due', null, null, null)$$, pg_temp.o(), (select id from ids where label = 'sub')),
                 'P0001', 'SUBSCRIPTION_NOT_FOUND', 'nor an event naming another garage');
select throws_ok(format($$select public.start_plan_signup(%L, %L, '{"name":"Sally Signup","phone":"+447700903701","channel":"sms"}'::jsonb, '{"registration":"SP37ABC"}'::jsonb, 'mock')$$,
                        pg_temp.p(), (select id from ids where label = 'gold')),
                 'P0001', 'ALREADY_ON_PLAN', 'a car on a plan cannot sign up twice');
reset role;

-- ---------------------------------------------------------------------------
-- Benefits at booking (after create_booking(); plan years)
-- ---------------------------------------------------------------------------

insert into ids values ('b1', pg_temp.book('1', 'a3700000-0000-4000-8000-000000000201', '2026-11-10 09:00Z'));
insert into ids values ('b2', pg_temp.book('2', 'a3700000-0000-4000-8000-000000000201', '2027-03-10 09:00Z'));
insert into ids values ('b3', pg_temp.book('3', 'a3700000-0000-4000-8000-000000000201', '2027-11-02 10:00Z'));
insert into ids values ('b4', pg_temp.book('4', 'a3700000-0000-4000-8000-000000000203', '2026-11-11 09:00Z'));
insert into ids values ('b5', pg_temp.book('5', 'a3700000-0000-4000-8000-000000000201', '2027-11-01 08:00Z'));

select pg_temp.as_service();
set local role service_role;
insert into outcome values ('use1', public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b1')));
select is((select (result ->> 'recorded') || ':' || (result ->> 'uses_left') || ':' || (result ->> 'plan_name') from outcome where label = 'use1'),
          'true:0:Gold plan', 'an included Full service uses the plan''s one use this year');
select is((public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b1'))) ->> 'already', 'true', 'recording again is a no-op');
insert into outcome values ('use2', public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b2')));
select is((select (result ->> 'recorded') || ':' || (result ->> 'reason') from outcome where label = 'use2'), 'false:limit_reached',
          'a second Full service in the same plan year is not included');
select is((select count(*)::integer from public.booking_events where booking_id = (select id from ids where label = 'b2') and data ->> 'servicePlan' = 'true'
             and data ->> 'text' like '%already used 1 of 1 times this plan year%'), 1, 'and staff see why on the booking');
-- Plan year two starts 2 Nov 2027 09:00 local = 09:00Z (GMT). 1 Nov 2027 08:00Z is still year one.
insert into outcome values ('use5', public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b5')));
select is((select result ->> 'reason' from outcome where label = 'use5'), 'limit_reached', 'the day before the plan''s anniversary is still year one');
insert into outcome values ('use3', public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b3')));
select is((select result ->> 'recorded' from outcome where label = 'use3'), 'true', 'a new plan year has a new use');
select is((select plan_year_start::text from public.service_plan_uses where booking_id = (select id from ids where label = 'b3')),
          '2027-11-02 09:00:00+00', 'year two starts at the same local time a year on');
select is((public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b4'))) ->> 'reason', 'not_included', 'a service not in the plan is not included');
select is(public.service_plan_year_start('2026-03-28 10:00Z', '2027-03-28 12:00Z', 'Europe/London')::text, '2027-03-28 09:00:00+00',
          'a plan started at 10:00 GMT renews at 10:00 local on the day the clocks go forward (10:00 BST = 09:00Z)');
select is(public.service_plan_year_start('2026-10-25 09:00Z', '2026-12-01 12:00Z', 'Europe/London')::text, '2026-10-25 09:00:00+00',
          'year one starts on the day the clocks went back');
reset role;

-- A cancelled booking gives the use back; a released use can be used again.
update public.bookings set status = 'cancelled', cancellation_reason = 'test' where id = (select id from ids where label = 'b1');
select is((select status from public.service_plan_uses where booking_id = (select id from ids where label = 'b1')), 'released', 'cancelling the booking gives the use back');

select pg_temp.as_member(pg_temp.fay(), pg_temp.p());
set local role authenticated;
select is((public.use_plan_benefit((select id from ids where label = 'b2'))) ->> 'recorded', 'true', 'front desk records the freed use on the other booking');
select is(public.release_plan_benefit((select id from ids where label = 'b2')), 1, 'and can give it back');
select is((public.use_plan_benefit((select id from ids where label = 'b2'))) ->> 'recorded', 'true', 'and use it again');
reset role;

select pg_temp.as_member(pg_temp.oli(), pg_temp.o());
set local role authenticated;
select throws_ok(format($$select public.use_plan_benefit(%L)$$, (select id from ids where label = 'b3')), 'P0001', 'BOOKING_NOT_FOUND', 'another garage cannot use P''s plan');
select is((select count(*)::integer from public.customer_plan_subscriptions), 0, 'nor read P''s subscriptions');
select is((select count(*)::integer from public.service_plan_uses), 0, 'nor its uses');
reset role;

-- ---------------------------------------------------------------------------
-- Invoices (save_invoice_draft())
-- ---------------------------------------------------------------------------

select pg_temp.as_member(pg_temp.pam(), pg_temp.p());
set local role authenticated;
insert into ids values ('inv', public.save_invoice_draft(null, jsonb_build_object(
  'source_type', 'booking', 'booking_id', (select id from ids where label = 'b2'),
  'items', jsonb_build_array(
    jsonb_build_object('description', 'Full service', 'quantity', 1, 'unit_price_pence', 15000),
    jsonb_build_object('description', 'Brake pads', 'quantity', 1, 'unit_price_pence', 8000),
    jsonb_build_object('description', 'Labour', 'quantity', 1.5, 'unit_price_pence', 6000))), false));
insert into outcome values ('inv1', public.apply_service_plan_to_invoice((select id from ids where label = 'inv')));
select is((select (result ->> 'included_pence') || ':' || (result ->> 'discount_pence') from outcome where label = 'inv1'), '15000:1700',
          'the included service comes off and 10% of the rest (£170.00)');
select is((select subtotal_pence || ':' || discount_pence || ':' || total_pence from public.invoices where id = (select id from ids where label = 'inv')), '17000:1700:15300',
          'the invoice totals follow');
select is((select string_agg(description || '=' || line_total_pence, ', ' order by position) from public.invoice_items where invoice_id = (select id from ids where label = 'inv')),
          'Full service (included in Gold plan)=0, Brake pads=8000, Labour=9000', 'the included line is £0.00 and says so');
select is((public.apply_service_plan_to_invoice((select id from ids where label = 'inv'))) ->> 'already', 'true', 'applying again is a no-op');
select is((select count(*)::integer from public.service_plan_invoice_applications where invoice_id = (select id from ids where label = 'inv')), 1, 'recorded once');
insert into ids values ('inv4', public.save_invoice_draft(null, jsonb_build_object(
  'source_type', 'booking', 'booking_id', (select id from ids where label = 'b4'),
  'items', jsonb_build_array(jsonb_build_object('description', 'Brake check', 'quantity', 1, 'unit_price_pence', 4000))), false));
select is((public.apply_service_plan_to_invoice((select id from ids where label = 'inv4'))) ->> 'discount_pence', '400', 'a service not included still gets the discount');
reset role;

select pg_temp.as_member(pg_temp.eve(), pg_temp.e());
set local role authenticated;
select throws_ok(format($$select public.apply_service_plan_to_invoice(%L)$$, (select id from ids where label = 'inv')),
                 'P0001', 'PLAN_REQUIRED: service_plans', 'an Essentials garage cannot apply plan benefits');
reset role;

-- ---------------------------------------------------------------------------
-- Payment failed, recovered, cancelled
-- ---------------------------------------------------------------------------

select pg_temp.as_service();
set local role service_role;
insert into outcome values ('fail1', public.apply_plan_subscription_status(pg_temp.p()::uuid, (select id from ids where label = 'sub'), 'mock', 'past_due', null, null, null, '2026-12-02 10:00Z'));
insert into outcome values ('fail2', public.apply_plan_subscription_status(pg_temp.p()::uuid, (select id from ids where label = 'sub'), 'mock', 'past_due', null, null, null, '2026-12-05 10:00Z'));
select is((select result ->> 'notify' from outcome where label = 'fail1'), 'payment_failed', 'a failed payment asks for the payment-failed notice');
select is((select coalesce(result ->> 'notify', 'none') from outcome where label = 'fail2'), 'none', 'a retry failing again sends nothing more');
select is((public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b3'))) ->> 'already', 'true', 'uses already recorded stand');
insert into ids values ('b6', pg_temp.book('6', 'a3700000-0000-4000-8000-000000000202', '2027-12-01 09:00Z'));
select is((public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b6'))) ->> 'reason', 'past_due', 'no new uses while payments are failing');
select is(coalesce((public.apply_plan_subscription_status(pg_temp.p()::uuid, (select id from ids where label = 'sub'), 'mock', 'active', null, null, null)) ->> 'notify', 'none'), 'none',
          'payment recovered: active again, no message');
reset role;

-- Staff cancel. Not plan gated, so first downgrade P to Essentials.
update public.garages set plan = 'essentials', plan_chosen = 'essentials' where id = pg_temp.p()::uuid;
select pg_temp.as_member(pg_temp.tim(), pg_temp.p());
set local role authenticated;
select throws_ok(format($$select public.cancel_plan_subscription(%L, null)$$, (select id from ids where label = 'sub')),
                 '42501', 'SERVICE_PLANS_FORBIDDEN', 'a technician cannot cancel a plan');
reset role;
select pg_temp.as_member(pg_temp.pam(), pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.customer_plan_subscriptions where garage_id = pg_temp.p()::uuid), 1, 'after a downgrade subscriptions stay readable');
select throws_ok($$select public.save_service_plan(null, '{"name":"Late plan","price_pence":500,"discount_percent":5}'::jsonb)$$,
                 'P0001', 'PLAN_REQUIRED: service_plans', 'but no new plans');
select throws_ok(format($$update public.service_plans set name = 'Renamed' where id = %L$$, (select id from ids where label = 'gold')), '42501', null,
                 'nor plan edits through RLS');
select is((public.cancel_plan_subscription((select id from ids where label = 'sub'), 'Customer asked')).status, 'cancelled', 'the owner can still cancel a Direct Debit plan');
reset role;
select pg_temp.as_service();
set local role service_role;
select is((public.apply_plan_subscription_status(pg_temp.p()::uuid, (select id from ids where label = 'sub'), 'mock', 'active', null, null, null)) ->> 'status', 'cancelled',
          'a cancelled plan never comes back from a late event');
select is((public.record_plan_booking(pg_temp.p()::uuid, (select id from ids where label = 'b6'))) ->> 'reason', 'plan_required', 'an Essentials garage records no uses');
reset role;
select is((select count(*)::integer from public.admin_audit_log where entity_id = (select id::text from ids where label = 'sub')
             and action in ('service_plan.subscription_active', 'service_plan.subscription_past_due', 'service_plan.subscription_cancelled')), 4,
          'status changes are audited (active, past due, active, cancelled)');

select * from finish();
rollback;
