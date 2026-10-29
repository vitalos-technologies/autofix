begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(71);

-- P5.5 campaigns: campaign_segment_problem(), campaign_audience() through
-- preview_campaign_audience(), schedule_campaign(), cancel_campaign(),
-- claim_campaign_sends(), the STOP and delivery triggers,
-- attribute_campaign_booking(), campaign_results(), RLS and plan gating.
--
-- Garages: P on paid Pro with MOTs (owner Pia, manager Max, technician Tim),
-- E on Essentials (owner Eli), O on paid Pro without MOTs (owner Ola).
-- P's customers: Ava (offers consent, text, 3-year-old car, MOT in March, last
-- seen 18 months ago for Diagnostics), Ben (offers consent, email, 10-year-old
-- car, MOT in July, seen 2 months ago), Cal (no consent), Dee (opted out), Eve
-- (email channel, no email), Fay (no car), Gus (soft opt-in reminder consent,
-- text, never seen, booking coming up), Hal (reminder consent only: not enough
-- for campaigns since consent wording v1.0).

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('31000000-0000-4000-8000-0000000000a1', 'camp-owner@pgtap.test', '{}'::jsonb),
  ('31000000-0000-4000-8000-0000000000a2', 'camp-manager@pgtap.test', '{}'::jsonb),
  ('31000000-0000-4000-8000-0000000000a3', 'camp-tech@pgtap.test', '{}'::jsonb),
  ('31000000-0000-4000-8000-0000000000b1', 'camp-ess@pgtap.test', '{}'::jsonb),
  ('31000000-0000-4000-8000-0000000000c1', 'camp-other@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen, mot_enabled) values
  ('a3100000-0000-4000-8000-000000000001', 'pgtap-camp-p', 'Campaign Pro', 'CMP', 'active', 'pro', null, 'pro', true),
  ('a3100000-0000-4000-8000-000000000002', 'pgtap-camp-e', 'Campaign Ess', 'CME', 'active', 'essentials', null, 'essentials', true),
  ('a3100000-0000-4000-8000-000000000003', 'pgtap-camp-o', 'Campaign Other', 'CMO', 'active', 'pro', null, 'pro', false);
insert into public.garage_members (garage_id, user_id, role) values
  ('a3100000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a3100000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-0000000000a2', 'manager'),
  ('a3100000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-0000000000a3', 'technician'),
  ('a3100000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-0000000000b1', 'owner'),
  ('a3100000-0000-4000-8000-000000000003', '31000000-0000-4000-8000-0000000000c1', 'owner');
select public.seed_garage_defaults(id) from public.garages where slug like 'pgtap-camp-%';

create function pg_temp.p() returns uuid language sql as $$ select 'a3100000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a3100000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.o() returns uuid language sql as $$ select 'a3100000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;
create function pg_temp.service_of(p_garage uuid, p_name text) returns uuid language sql as $$
  select id from public.services where garage_id = p_garage and name = p_name and deleted_at is null limit 1
$$;
create function pg_temp.bay_of(p_garage uuid) returns uuid language sql as $$
  select id from public.resources where garage_id = p_garage order by sort, name limit 1
$$;
create function pg_temp.year_ago(p_years integer) returns integer language sql as $$
  select extract(year from now())::integer - p_years
$$;
create function pg_temp.manager() returns void language sql as $$
  select pg_temp.as_member('31000000-0000-4000-8000-0000000000a2', 'a3100000-0000-4000-8000-000000000001');
$$;

insert into public.customers (id, garage_id, name, phone, email, preferred_contact, channel, reminder_consent, consent_at, consent_source, opted_out_at,
                              offers_consent, offers_consent_at, offers_consent_source, offers_consent_text) values
  ('a3100000-0000-4000-8000-000000000101', pg_temp.p(), 'Ava Able', '+447700931001', null, 'phone', 'sms', true, now() - interval '2 years', 'booking', null,
   true, now() - interval '2 years', 'booking', 'Send me occasional offers from Campaign Pro. You can stop these any time.'),
  ('a3100000-0000-4000-8000-000000000102', pg_temp.p(), 'Ben Baker', '+447700931002', 'ben@example.test', 'email', 'email', true, now() - interval '2 years', 'booking', null,
   true, now() - interval '2 years', 'booking', 'Send me occasional offers from Campaign Pro. You can stop these any time.'),
  ('a3100000-0000-4000-8000-000000000103', pg_temp.p(), 'Cal Cole', '+447700931003', null, 'phone', 'sms', false, null, null, null, false, null, null, null),
  ('a3100000-0000-4000-8000-000000000104', pg_temp.p(), 'Dee Dean', '+447700931004', null, 'phone', 'sms', true, now() - interval '1 year', 'booking', now() - interval '1 month',
   true, now() - interval '1 year', 'booking', 'Send me occasional offers from Campaign Pro. You can stop these any time.'),
  ('a3100000-0000-4000-8000-000000000105', pg_temp.p(), 'Eve Ennis', '+447700931005', null, 'email', 'email', true, now() - interval '1 year', 'booking', null,
   true, now() - interval '1 year', 'booking', 'Send me occasional offers from Campaign Pro. You can stop these any time.'),
  ('a3100000-0000-4000-8000-000000000106', pg_temp.p(), 'Fay Ford', '+447700931006', null, 'phone', 'sms', true, now() - interval '1 year', 'booking', null,
   true, now() - interval '1 year', 'booking', 'Send me occasional offers from Campaign Pro. You can stop these any time.'),
  ('a3100000-0000-4000-8000-000000000107', pg_temp.p(), 'Gus Grant', '+447700931007', null, 'phone', 'sms', true, now() - interval '1 year', 'soft_opt_in', null,
   false, null, null, null),
  ('a3100000-0000-4000-8000-000000000108', pg_temp.p(), 'Hal Hart', '+447700931008', null, 'phone', 'sms', true, now() - interval '1 year', 'booking', null,
   false, null, null, null),
  ('a3100000-0000-4000-8000-000000000201', pg_temp.e(), 'Eli Customer', '+447700931101', null, 'phone', 'sms', true, now() - interval '1 year', 'booking', null,
   true, now() - interval '1 year', 'booking', 'Send me occasional offers from Campaign Ess. You can stop these any time.'),
  ('a3100000-0000-4000-8000-000000000301', pg_temp.o(), 'Ola Customer', '+447700931201', null, 'phone', 'sms', true, now() - interval '1 year', 'booking', null,
   true, now() - interval '1 year', 'booking', 'Send me occasional offers from Campaign Other. You can stop these any time.');
insert into public.vehicles (id, garage_id, customer_id, registration, year, mot_expiry) values
  ('a3100000-0000-4000-8000-000000000401', pg_temp.p(), 'a3100000-0000-4000-8000-000000000101', 'CA31AVA', pg_temp.year_ago(3), make_date(extract(year from now())::integer + 1, 3, 15)),
  ('a3100000-0000-4000-8000-000000000402', pg_temp.p(), 'a3100000-0000-4000-8000-000000000102', 'CA31BEN', pg_temp.year_ago(10), make_date(extract(year from now())::integer + 1, 7, 1)),
  ('a3100000-0000-4000-8000-000000000403', pg_temp.p(), 'a3100000-0000-4000-8000-000000000103', 'CA31CAL', pg_temp.year_ago(4), null),
  ('a3100000-0000-4000-8000-000000000404', pg_temp.p(), 'a3100000-0000-4000-8000-000000000104', 'CA31DEE', pg_temp.year_ago(4), null),
  ('a3100000-0000-4000-8000-000000000405', pg_temp.p(), 'a3100000-0000-4000-8000-000000000105', 'CA31EVE', pg_temp.year_ago(4), null),
  ('a3100000-0000-4000-8000-000000000407', pg_temp.p(), 'a3100000-0000-4000-8000-000000000107', 'CA31GUS', null, null),
  ('a3100000-0000-4000-8000-000000000408', pg_temp.p(), 'a3100000-0000-4000-8000-000000000108', 'CA31HAL', pg_temp.year_ago(6), null),
  ('a3100000-0000-4000-8000-000000000501', pg_temp.e(), 'a3100000-0000-4000-8000-000000000201', 'CA31ELI', pg_temp.year_ago(2), null),
  ('a3100000-0000-4000-8000-000000000601', pg_temp.o(), 'a3100000-0000-4000-8000-000000000301', 'CA31OLA', pg_temp.year_ago(2), null);
insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source, price_pence) values
  ('a3100000-0000-4000-8000-000000000701', pg_temp.p(), 'a3100000-0000-4000-8000-000000000101', 'a3100000-0000-4000-8000-000000000401',
   pg_temp.service_of(pg_temp.p(), 'Diagnostics'), pg_temp.bay_of(pg_temp.p()),
   now() - interval '18 months', now() - interval '18 months' + interval '1 hour',
   tstzrange(now() - interval '18 months', now() - interval '18 months' + interval '1 hour'), 'collected', 'phone', 6000),
  ('a3100000-0000-4000-8000-000000000702', pg_temp.p(), 'a3100000-0000-4000-8000-000000000102', 'a3100000-0000-4000-8000-000000000402',
   pg_temp.service_of(pg_temp.p(), 'MOT'), pg_temp.bay_of(pg_temp.p()),
   now() - interval '2 months', now() - interval '2 months' + interval '1 hour',
   tstzrange(now() - interval '2 months', now() - interval '2 months' + interval '1 hour'), 'collected', 'phone', 5485),
  ('a3100000-0000-4000-8000-000000000703', pg_temp.p(), 'a3100000-0000-4000-8000-000000000107', 'a3100000-0000-4000-8000-000000000407',
   pg_temp.service_of(pg_temp.p(), 'Diagnostics'), pg_temp.bay_of(pg_temp.p()),
   now() + interval '10 days', now() + interval '10 days 1 hour',
   tstzrange(now() + interval '10 days', now() + interval '10 days 1 hour'), 'confirmed', 'phone', 6000);

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from pg_class where relname in ('campaigns', 'campaign_sends')
           and relnamespace = 'public'::regnamespace and relrowsecurity), 2, 'both campaign tables have RLS on');
select is((select count(*)::integer from unnest(array['campaigns', 'campaign_sends']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select')), 0, 'anon reads neither table');
select is((has_table_privilege('authenticated', 'public.campaign_sends', 'insert')
           or has_table_privilege('authenticated', 'public.campaign_sends', 'update')
           or has_table_privilege('authenticated', 'public.campaign_sends', 'delete')), false, 'staff never write campaign sends directly');
select is(has_column_privilege('authenticated', 'public.campaigns', 'status', 'update'), false, 'staff cannot set a campaign''s status');
select is((select count(*)::integer from unnest(array[
             'public.claim_campaign_sends(uuid, timestamptz, integer)', 'public.attribute_campaign_booking(uuid, uuid, uuid)',
             'public.campaign_audience(uuid, jsonb, timestamptz)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')),
          0, 'claiming, attribution and the raw audience are not for staff');
select is(has_function_privilege('service_role', 'public.campaign_audience(uuid, jsonb, timestamptz)', 'execute'), false,
          'the raw audience is internal');
select is((select count(*)::integer from pg_proc
           where oid in ('public.preview_campaign_audience(jsonb, integer)'::regprocedure, 'public.schedule_campaign(uuid, timestamptz)'::regprocedure,
                         'public.claim_campaign_sends(uuid, timestamptz, integer)'::regprocedure, 'public.campaign_results(uuid)'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 4, 'functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Segment validation
-- ---------------------------------------------------------------------------

select is(public.campaign_segment_problem('{}'), null, 'an empty segment is everyone');
select is(public.campaign_segment_problem('{"car_age_min": 3, "car_age_max": 8, "mot_months": [1, 2], "not_seen_months": 12, "channels": ["sms"]}'),
          null, 'a full segment is valid');
select is(public.campaign_segment_problem('{"postcode": "DN1"}'), 'unknown key postcode', 'unknown keys are refused');
select is(public.campaign_segment_problem('{"car_age_min": 9, "car_age_max": 2}'), 'car_age_min must not be above car_age_max', 'age range must be in order');
select is(public.campaign_segment_problem('{"mot_months": [13]}'), 'mot_months must be distinct months 1-12', 'months are 1-12');
select is(public.campaign_segment_problem('{"mot_months": [3, 3]}'), 'mot_months must be distinct months 1-12', 'months are distinct');
select is(public.campaign_segment_problem('{"channels": ["fax"]}'), 'channels must list sms, whatsapp or email', 'channels are known');
select is(public.campaign_segment_problem('{"service_history": "had"}'), 'service_id and service_history go together', 'history needs a service');
select throws_ok($$insert into public.campaigns (garage_id, name, template, email_subject, segment)
                   values ('a3100000-0000-4000-8000-000000000001', 'Bad', '{garage}', 'Hi', '{"car_age_min": -1}')$$,
                 '23514', null, 'a bad segment cannot be stored');

-- ---------------------------------------------------------------------------
-- Audience preview (owners and managers, Pro)
-- ---------------------------------------------------------------------------

select pg_temp.manager();
set local role authenticated;

select is((select total from public.preview_campaign_audience('{}', 20) limit 1), 3,
          'everyone = customers with offers consent or soft opt-in, an address and a car (Ava, Ben, Gus)');
select is((select array_agg(customer_name order by customer_name) from public.preview_campaign_audience('{}', 20)),
          array['Ava Able', 'Ben Baker', 'Gus Grant'], 'no consent, reminder consent alone, opted out, no address and no car are left out');
select is((select array_agg(customer_name || ':' || consent_basis order by customer_name) from public.preview_campaign_audience('{}', 20)),
          array['Ava Able:offers', 'Ben Baker:offers', 'Gus Grant:soft_opt_in'], 'each row says why it may go: offers consent or soft opt-in');
select is((select offers_total from public.preview_campaign_audience('{}', 1) limit 1), 2, 'and the count says how many ticked the offers box');
select is((select row(total, offers_total)::text from public.preview_campaign_audience('{"car_age_min": 6, "car_age_max": 6}', 20)), '(0,0)',
          'reminder consent alone (Hal) is not enough for a campaign');
select is((select array_agg(customer_name) from public.preview_campaign_audience('{}', 1)), array['Ava Able'], 'the preview is limited');
select is((select total from public.preview_campaign_audience('{}', 1) limit 1), 3, 'the count is not limited');
select is((select array_agg(customer_name) from public.preview_campaign_audience('{"car_age_min": 5}', 20)), array['Ben Baker'],
          'car age from 5 years');
select is((select array_agg(customer_name) from public.preview_campaign_audience('{"car_age_max": 4}', 20)), array['Ava Able'],
          'car age up to 4 years (unknown year is left out)');
select is((select array_agg(customer_name) from public.preview_campaign_audience('{"mot_months": [3]}', 20)), array['Ava Able'],
          'MOT month');
select is((select array_agg(customer_name) from public.preview_campaign_audience('{"not_seen_months": 12}', 20)), array['Ava Able'],
          'not seen for 12 months (a customer with a booking coming up is left out)');
select is((select array_agg(customer_name order by customer_name) from public.preview_campaign_audience(
             jsonb_build_object('service_id', pg_temp.service_of(pg_temp.p(), 'Diagnostics'), 'service_history', 'never'), 20)),
          array['Ben Baker', 'Gus Grant'], 'never had a service (a future booking does not count)');
select is((select array_agg(customer_name) from public.preview_campaign_audience(
             jsonb_build_object('service_id', pg_temp.service_of(pg_temp.p(), 'Diagnostics'), 'service_history', 'had'), 20)),
          array['Ava Able'], 'had a service');
select is((select array_agg(customer_name) from public.preview_campaign_audience('{"channels": ["email"]}', 20)), array['Ben Baker'],
          'by channel');
select is((select row(total, customer_id)::text from public.preview_campaign_audience('{"car_age_min": 60}', 20)), '(0,)',
          'nobody matching is one row with total 0');
select throws_ok($$select * from public.preview_campaign_audience('{"car_age_min": "old"}', 20)$$, '22023', null,
                 'a bad segment is refused');

-- ---------------------------------------------------------------------------
-- Writes and gating
-- ---------------------------------------------------------------------------

insert into public.campaigns (id, garage_id, name, starter, segment, template, email_subject)
values ('a3100000-0000-4000-8000-000000000801', pg_temp.p(), 'Winter check', 'winter_check', '{}',
        '{garage}: Hi {first_name}, winter check for your {vehicle}? Book: {link}', 'Get your car ready for winter');
select is((select count(*)::integer from public.campaigns where garage_id = pg_temp.p()), 1, 'a manager adds a draft');
select throws_ok($$insert into public.campaigns (garage_id, name, segment, template, email_subject, status)
                   values ('a3100000-0000-4000-8000-000000000001', 'Sneaky', '{}', '{garage}', 'Hi', 'sent')$$,
                 '42501', null, 'a campaign cannot be added already sent');
reset role;

select pg_temp.as_member('31000000-0000-4000-8000-0000000000a3', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.campaigns), 1, 'a technician reads the campaigns');
select throws_ok($$insert into public.campaigns (garage_id, name, segment, template, email_subject)
                   values ('a3100000-0000-4000-8000-000000000001', 'Tech', '{}', '{garage}', 'Hi')$$,
                 '42501', null, 'a technician cannot add one');
select throws_ok($$select * from public.preview_campaign_audience('{}', 5)$$, '42501', null, 'a technician cannot preview');
select throws_ok($$select public.schedule_campaign('a3100000-0000-4000-8000-000000000801', null)$$, '42501', null,
                 'a technician cannot schedule');
reset role;

select pg_temp.as_member('31000000-0000-4000-8000-0000000000b1', pg_temp.e());
set local role authenticated;
select throws_ok($$insert into public.campaigns (garage_id, name, segment, template, email_subject)
                   values ('a3100000-0000-4000-8000-000000000002', 'Ess', '{}', '{garage}', 'Hi')$$,
                 '42501', null, 'an Essentials garage cannot add a campaign');
select throws_ok($$select * from public.preview_campaign_audience('{}', 5)$$, 'P0001', 'PLAN_REQUIRED: campaigns',
                 'an Essentials garage cannot preview');
select is((select count(*)::integer from public.campaigns), 0, 'and sees no other garage''s campaigns');
reset role;

select pg_temp.as_member('31000000-0000-4000-8000-0000000000c1', pg_temp.o());
set local role authenticated;
select throws_ok($$select * from public.preview_campaign_audience('{"mot_months": [1]}', 5)$$, 'P0001', null,
                 'MOT months need MOTs switched on');
select throws_ok($$select public.schedule_campaign('a3100000-0000-4000-8000-000000000801', null)$$, 'P0001', 'CAMPAIGN_NOT_FOUND',
                 'another garage''s campaign cannot be scheduled');
select is((select count(*)::integer from public.campaign_results(null)), 0, 'nor its results read');
reset role;

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------

select pg_temp.manager();
set local role authenticated;
insert into public.campaigns (id, garage_id, name, segment, template, email_subject)
values ('a3100000-0000-4000-8000-000000000802', pg_temp.p(), 'Nobody', '{"car_age_min": 60}', '{garage}: hi {link}', 'Hi');
select throws_ok($$select public.schedule_campaign('a3100000-0000-4000-8000-000000000802', null)$$, 'P0001', null,
                 'an empty audience cannot be scheduled');
select throws_ok($$select public.schedule_campaign('a3100000-0000-4000-8000-000000000801', now() - interval '1 day')$$, '22023', null,
                 'a send time in the past is refused');
select is((public.schedule_campaign('a3100000-0000-4000-8000-000000000801', null)).recipients, 3, 'scheduling freezes three recipients');
select is((select status from public.campaigns where id = 'a3100000-0000-4000-8000-000000000801'), 'scheduled', 'the campaign is scheduled');
select throws_ok($$select public.schedule_campaign('a3100000-0000-4000-8000-000000000801', null)$$, 'P0001', 'CAMPAIGN_NOT_DRAFT',
                 'a campaign is scheduled once');
update public.campaigns set name = 'Changed' where id = 'a3100000-0000-4000-8000-000000000801';
select is((select name from public.campaigns where id = 'a3100000-0000-4000-8000-000000000801'), 'Winter check',
          'a scheduled campaign cannot be edited');
reset role;

select is((select count(*)::integer from public.campaign_sends where campaign_id = 'a3100000-0000-4000-8000-000000000801' and status = 'scheduled'), 3,
          'one scheduled send per recipient');
select is((select count(*)::integer from public.jobs where kind = 'campaigns.send' and garage_id = pg_temp.p()), 1, 'the send job is queued');

-- STOP (the same audited opt-out as the keyword webhook) cancels Ben's pending campaign send at once.
select public.opt_out_customer(pg_temp.p(), 'a3100000-0000-4000-8000-000000000102', null, 'sms_stop');
select is((select status || ':' || skip_reason from public.campaign_sends where customer_id = 'a3100000-0000-4000-8000-000000000102'),
          'cancelled:opted_out', 'STOP cancels pending campaign sends');

-- ---------------------------------------------------------------------------
-- Claiming (service role)
-- ---------------------------------------------------------------------------

set local role service_role;
-- Gus switched to WhatsApp after scheduling: the claim uses the customer's channel now.
update public.customers set channel = 'whatsapp' where id = 'a3100000-0000-4000-8000-000000000107';
select is((select array_agg(customer_name || ':' || channel order by customer_name) from public.claim_campaign_sends(pg_temp.p(), now() + interval '1 minute', 10)),
          array['Ava Able:sms', 'Gus Grant:whatsapp'], 'the claim returns the consented recipients on their channel now');
select is((select count(*)::integer from public.claim_campaign_sends(pg_temp.p(), now() + interval '1 minute', 10)), 0, 'a send is claimed once');
select is((select status from public.campaigns where id = 'a3100000-0000-4000-8000-000000000801'), 'sent', 'nothing left: the campaign is sent');

-- An Essentials garage's due sends are refused at claim time.
insert into public.campaigns (id, garage_id, name, segment, template, email_subject, status, send_at, recipients, scheduled_at)
values ('a3100000-0000-4000-8000-000000000803', pg_temp.e(), 'Old', '{}', '{garage}', 'Hi', 'scheduled', now(), 1, now());
insert into public.campaign_sends (garage_id, campaign_id, customer_id, vehicle_id, channel, send_at)
values (pg_temp.e(), 'a3100000-0000-4000-8000-000000000803', 'a3100000-0000-4000-8000-000000000201', 'a3100000-0000-4000-8000-000000000501', 'sms', now());
select is((select count(*)::integer from public.claim_campaign_sends(pg_temp.e(), now() + interval '1 minute', 10)), 0,
          'an Essentials garage claims nothing');
select is((select skip_reason from public.campaign_sends where garage_id = pg_temp.e()), 'plan_required', 'its sends are skipped as plan_required');

-- Delivery receipts follow the messages row.
insert into public.messages (id, garage_id, customer_id, channel, direction, to_address, body, provider, status)
values ('a3100000-0000-4000-8000-000000000901', pg_temp.p(), 'a3100000-0000-4000-8000-000000000101', 'sms', 'outbound', '+447700931001', 'hi', 'mock', 'sent');
update public.campaign_sends set status = 'sent', sent_at = now(), message_id = 'a3100000-0000-4000-8000-000000000901', opened_at = now()
where customer_id = 'a3100000-0000-4000-8000-000000000101';
update public.messages set status = 'delivered' where id = 'a3100000-0000-4000-8000-000000000901';
select is((select status from public.campaign_sends where customer_id = 'a3100000-0000-4000-8000-000000000101'), 'delivered',
          'a delivery receipt marks the send delivered');

-- ---------------------------------------------------------------------------
-- Attribution and results
-- ---------------------------------------------------------------------------

insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source, price_pence) values
  ('a3100000-0000-4000-8000-000000000711', pg_temp.p(), 'a3100000-0000-4000-8000-000000000101', 'a3100000-0000-4000-8000-000000000401',
   pg_temp.service_of(pg_temp.p(), 'Diagnostics'), pg_temp.bay_of(pg_temp.p()),
   now() + interval '20 days', now() + interval '20 days 1 hour', tstzrange(now() + interval '20 days', now() + interval '20 days 1 hour'),
   'confirmed', 'online', 7500);
create function pg_temp.send_of(p_customer uuid) returns uuid language sql as $$
  select id from public.campaign_sends where customer_id = p_customer limit 1
$$;
select is(public.attribute_campaign_booking(pg_temp.p(), pg_temp.send_of('a3100000-0000-4000-8000-000000000107'), 'a3100000-0000-4000-8000-000000000711'),
          false, 'a booking for another customer is not credited');
select is(public.attribute_campaign_booking(pg_temp.o(), pg_temp.send_of('a3100000-0000-4000-8000-000000000101'), 'a3100000-0000-4000-8000-000000000711'),
          false, 'nor through another garage');
select is(public.attribute_campaign_booking(pg_temp.p(), pg_temp.send_of('a3100000-0000-4000-8000-000000000102'), 'a3100000-0000-4000-8000-000000000711'),
          false, 'nor to a send that never went out');
select is(public.attribute_campaign_booking(pg_temp.p(), pg_temp.send_of('a3100000-0000-4000-8000-000000000101'), 'a3100000-0000-4000-8000-000000000711'),
          true, 'the booking is credited to the customer''s own send');
reset role;

select pg_temp.manager();
set local role authenticated;
select is((select row(recipients, sent, delivered, opened, skipped, bookings, pence)::text
           from public.campaign_results('a3100000-0000-4000-8000-000000000801')),
          '(3,1,1,1,1,1,7500)', 'results: recipients, sent, delivered, opened, skipped, bookings and pence');

-- Cancelling a scheduled campaign stops its pending sends.
insert into public.campaigns (id, garage_id, name, segment, template, email_subject)
values ('a3100000-0000-4000-8000-000000000804', pg_temp.p(), 'Later', '{"channels": ["sms", "whatsapp"]}', '{garage}: hi {link}', 'Hi');
select is((public.schedule_campaign('a3100000-0000-4000-8000-000000000804', now() + interval '3 days')).recipients, 2, 'scheduled for later');
select is((public.cancel_campaign('a3100000-0000-4000-8000-000000000804')).status, 'cancelled', 'a manager cancels it');
select is((select count(*)::integer from public.campaign_sends where campaign_id = 'a3100000-0000-4000-8000-000000000804' and skip_reason = 'campaign_cancelled'),
          2, 'its pending sends are cancelled');
delete from public.campaigns where id = 'a3100000-0000-4000-8000-000000000804';
select is((select count(*)::integer from public.campaigns where id = 'a3100000-0000-4000-8000-000000000804'), 1, 'a cancelled campaign is kept');
delete from public.campaigns where id = 'a3100000-0000-4000-8000-000000000802';
select is((select count(*)::integer from public.campaigns where id = 'a3100000-0000-4000-8000-000000000802'), 0, 'a draft can be deleted');
reset role;

-- After a downgrade the results stay readable, but nothing can be added or scheduled.
update public.garages set plan = 'essentials', plan_chosen = 'essentials' where id = pg_temp.p();
select pg_temp.manager();
set local role authenticated;
select is((select count(*)::integer from public.campaign_results(null)), 2, 'results stay readable after a downgrade');
select throws_ok($$insert into public.campaigns (garage_id, name, segment, template, email_subject)
                   values ('a3100000-0000-4000-8000-000000000001', 'After', '{}', '{garage}', 'Hi')$$,
                 '42501', null, 'no new campaigns after a downgrade');
reset role;

select * from finish();
rollback;
