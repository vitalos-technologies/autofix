begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(46);

-- Offers consent (20261029001400_offers_consent.sql; consent wording v1.0):
-- the customers columns, create_booking_at() taking offers consent from the
-- customer's own booking only, opt-outs ending it (STOP, unsubscribe, staff)
-- and never giving it back (START, "Turn reminders back on"), staff unable to
-- write it, imports never granting it, and campaigns gated on
-- campaign_consent_basis() (offers consent or soft opt-in) at preview,
-- scheduling, cancellation and claim time.
--
-- Garage G (Pro, MOTs on; owner Oona, manager Max). Customers by phone:
-- Olly (offers + reminders, then STOP and START), Rita (reminders only, then
-- ticks offers on a later booking), Ozzy (offers only, unsubscribes, turns
-- reminders back on, then ticks offers again), Rex (offers from a reminder
-- link booking), Una (offers, then opted out by staff), Sam (soft opt-in,
-- then STOP and START), Tia (soft opt-in), Ivy (imported with the
-- declaration), Cal (no consent).

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('39000000-0000-4000-8000-0000000000a1', 'offers-owner@pgtap.test', '{}'::jsonb),
  ('39000000-0000-4000-8000-0000000000a2', 'offers-manager@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen, mot_enabled) values
  ('a3900000-0000-4000-8000-000000000001', 'pgtap-offers', 'Offers Garage', 'OFG', 'active', 'pro', null, 'pro', true);
insert into public.garage_members (garage_id, user_id, role) values
  ('a3900000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a3900000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-0000000000a2', 'manager');
select public.seed_garage_defaults('a3900000-0000-4000-8000-000000000001');

create function pg_temp.g() returns uuid language sql as $$ select 'a3900000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.manager_id() returns uuid language sql as $$ select '39000000-0000-4000-8000-0000000000a2'::uuid $$;
create function pg_temp.manager() returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '39000000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', 'a3900000-0000-4000-8000-000000000001')::text, true);
$$;
create function pg_temp.offers_text() returns text language sql as $$
  select 'Send me occasional offers from Offers Garage. You can stop these any time.'
$$;
create function pg_temp.reminder_text() returns text language sql as $$
  select 'Remind me when the MOT and service are due. You can stop these any time.'
$$;

-- A Diagnostics booking for p_phone/p_reg at p_start (a free weekday hour in
-- November 2026); p_customer is merged into the customer object.
create function pg_temp.payload(p_start text, p_key integer, p_phone text, p_reg text, p_customer jsonb default '{}', p_source text default 'online')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'service_id', (select id from public.services where garage_id = 'a3900000-0000-4000-8000-000000000001' and name = 'Diagnostics'),
    'starts_at', p_start,
    'location_mode', 'workshop',
    'source', p_source,
    'idempotency_key', 'c3900000-0000-4000-8000-' || lpad(p_key::text, 12, '0'),
    'customer', jsonb_build_object('name', 'Pat Booker', 'phone', p_phone, 'channel', 'sms') || p_customer,
    'vehicle', jsonb_build_object('registration', p_reg, 'year', 2018)
  )
$$;
create function pg_temp.offers() returns jsonb language sql as $$
  select jsonb_build_object('offers_consent', true, 'offers_consent_text', pg_temp.offers_text())
$$;
create function pg_temp.reminders() returns jsonb language sql as $$
  select jsonb_build_object('reminder_consent', true, 'consent_text', pg_temp.reminder_text())
$$;
create function pg_temp.book(p_payload jsonb, p_now timestamptz default '2026-10-28 12:00+00') returns jsonb language sql as $$
  select public.create_booking_at('a3900000-0000-4000-8000-000000000001', p_payload, p_now)
$$;
create function pg_temp.book_error(p_payload jsonb) returns text language plpgsql as $$
begin
  perform public.create_booking_at('a3900000-0000-4000-8000-000000000001', p_payload, '2026-10-28 12:00+00');
  return 'no error';
exception
  when others then
    return sqlstate || ' ' || sqlerrm;
end
$$;
-- given|source|at|wording of a customer's offers consent ("-" for null).
create function pg_temp.offers_of(p_phone text) returns text language sql as $$
  select concat_ws('|', customer.offers_consent, coalesce(customer.offers_consent_source, '-'),
                   coalesce(to_char(customer.offers_consent_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), '-'), coalesce(customer.offers_consent_text, '-'))
  from public.customers customer where customer.garage_id = 'a3900000-0000-4000-8000-000000000001' and customer.phone = p_phone
$$;
create function pg_temp.customer_id(p_phone text) returns uuid language sql as $$
  select id from public.customers where garage_id = 'a3900000-0000-4000-8000-000000000001' and phone = p_phone
$$;

-- ---------------------------------------------------------------------------
-- Schema, constraints and grants
-- ---------------------------------------------------------------------------

select is((select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ', ' order by column_name)
           from information_schema.columns
           where table_schema = 'public' and table_name = 'customers' and column_name like 'offers%'),
          'offers_consent:boolean:NO:false, offers_consent_at:timestamp with time zone:YES:-, offers_consent_source:text:YES:-, '
          'offers_consent_text:text:YES:-, offers_opted_out_at:timestamp with time zone:YES:-',
          'customers carry offers consent apart from reminder consent (default: not given)');
select throws_ok($$insert into public.customers (garage_id, name, phone, preferred_contact, offers_consent) values ('a3900000-0000-4000-8000-000000000001', 'No record', '+447700939090', 'phone', true)$$,
                 '23514', null, 'offers consent needs its time, source and wording');
select throws_ok($$insert into public.customers (garage_id, name, phone, preferred_contact, offers_consent, offers_consent_at, offers_consent_source, offers_consent_text)
                   values ('a3900000-0000-4000-8000-000000000001', 'Staff source', '+447700939091', 'phone', true, now(), 'staff', 'Offers')$$,
                 '23514', null, 'offers consent is only ever recorded from a booking');
select is((select count(*)::integer from pg_proc where proname in ('create_booking', 'create_booking_at') and pronamespace = 'public'::regnamespace), 2,
          'create_booking() and create_booking_at() have one signature each (no overload)');
select ok(has_function_privilege('service_role', 'public.create_booking(uuid, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.create_booking(uuid, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.create_booking(uuid, jsonb)', 'execute')
          and not has_function_privilege('service_role', 'public.create_booking_at(uuid, jsonb, timestamptz)', 'execute'),
          'create_booking() keeps its grants: the service role only');
select ok(has_function_privilege('authenticated', 'public.preview_campaign_audience(jsonb, integer)', 'execute')
          and not has_function_privilege('anon', 'public.preview_campaign_audience(jsonb, integer)', 'execute')
          and not has_function_privilege('authenticated', 'public.campaign_audience(uuid, jsonb, timestamptz)', 'execute')
          and not has_function_privilege('service_role', 'public.campaign_audience(uuid, jsonb, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.campaign_consent_basis(boolean, boolean, text, timestamptz)', 'execute'),
          'the re-created audience functions keep their grants');
select is((select count(*)::integer from pg_proc
           where oid in ('public.campaign_audience(uuid, jsonb, timestamptz)'::regprocedure, 'public.preview_campaign_audience(jsonb, integer)'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 2, 'and stay security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- The campaign consent rule
-- ---------------------------------------------------------------------------

select is(
  array(select public.campaign_consent_basis(o, r, s, x) from (values
    (1, true, false, null, null::timestamptz),
    (2, true, true, 'soft_opt_in', now()),
    (3, false, true, 'soft_opt_in', null),
    (4, false, true, 'soft_opt_in', now()),
    (5, false, false, 'soft_opt_in', null),
    (6, false, true, 'booking', null),
    (7, false, true, 'import', null),
    (8, false, true, 'staff', null),
    (9, false, true, 'unsubscribe_page', null),
    (10, false, false, null, null)) rule(n, o, r, s, x) order by n),
  array['offers', 'offers', 'soft_opt_in', null, null, null, null, null, null, null]::text[],
  'offers consent, or reminder consent by soft opt-in never opted out since; reminder consent from a booking, import, staff or the unsubscribe page is not enough'
);

-- ---------------------------------------------------------------------------
-- create_booking(): offers consent from the customer's own booking
-- ---------------------------------------------------------------------------

select pg_temp.book(pg_temp.payload('2026-11-03T09:00:00Z', 1, '+447700939001', 'OF01OLY', pg_temp.offers() || pg_temp.reminders()));
select is(pg_temp.offers_of('+447700939001'), 't|booking|2026-10-28 12:00|' || pg_temp.offers_text(),
          'a ticked offers box is stored with its source, time and exact wording');
select is((select concat_ws('|', reminder_consent, consent_source, consent_text) from public.customers where phone = '+447700939001'),
          't|booking|' || pg_temp.reminder_text(), 'reminder consent is stored apart, with its own wording');

select pg_temp.book(pg_temp.payload('2026-11-03T10:00:00Z', 2, '+447700939002', 'OF02RIT', pg_temp.reminders()));
select is(pg_temp.offers_of('+447700939002'), 'f|-|-|-', 'reminders ticked alone give no offers consent');

select pg_temp.book(pg_temp.payload('2026-11-03T11:00:00Z', 3, '+447700939003', 'OF03OZY', pg_temp.offers()));
select is((select concat_ws('|', reminder_consent, offers_consent) from public.customers where phone = '+447700939003'), 'f|t',
          'offers ticked alone give no reminder consent');

select pg_temp.book(pg_temp.payload('2026-11-04T09:00:00Z', 4, '+447700939001', 'OF01OLY', '{"offers_consent": false}'), '2026-10-29 12:00+00');
select is(pg_temp.offers_of('+447700939001'), 't|booking|2026-10-28 12:00|' || pg_temp.offers_text(), 'unticking on a later booking does not turn offers off');
select pg_temp.book(pg_temp.payload('2026-11-04T10:00:00Z', 5, '+447700939001', 'OF01OLY', pg_temp.offers()), '2026-10-30 12:00+00');
select is(pg_temp.offers_of('+447700939001'), 't|booking|2026-10-28 12:00|' || pg_temp.offers_text(), 'ticking again keeps the original consent record');
select pg_temp.book(pg_temp.payload('2026-11-04T11:00:00Z', 6, '+447700939002', 'OF02RIT', pg_temp.offers()), '2026-10-30 12:00+00');
select is(pg_temp.offers_of('+447700939002'), 't|booking|2026-10-30 12:00|' || pg_temp.offers_text(), 'ticking it on a later booking turns offers on');

select pg_temp.book(pg_temp.payload('2026-11-05T09:00:00Z', 7, '+447700939004', 'OF04REX', pg_temp.offers(), 'reminder'));
select is(pg_temp.offers_of('+447700939004'), 't|booking|2026-10-28 12:00|' || pg_temp.offers_text(), 'a booking from a reminder link records offers consent too');
select pg_temp.book(pg_temp.payload('2026-11-05T10:00:00Z', 8, '+447700939005', 'OF05UNA', pg_temp.offers()));

select is(pg_temp.book_error(pg_temp.payload('2026-11-05T11:00:00Z', 9, '+447700939099', 'OF99BAD', '{"offers_consent": true}')),
          'P0001 INVALID_BOOKING: customer.offers_consent_text is required with offers consent', 'offers consent needs the wording shown');
select is(pg_temp.book_error(pg_temp.payload('2026-11-05T11:00:00Z', 10, '+447700939099', 'OF99BAD', jsonb_build_object('offers_consent', 'yes', 'offers_consent_text', 'x'))),
          'P0001 INVALID_BOOKING: customer.offers_consent must be true or false', 'offers consent is a boolean');
select is(pg_temp.book_error(pg_temp.payload('2026-11-05T11:00:00Z', 11, '+447700939099', 'OF99BAD', pg_temp.offers(), 'ai_agent')),
          'P0001 INVALID_BOOKING: offers consent is given only by the customer on the booking page', 'the AI front desk cannot record offers consent');
select is(pg_temp.book_error(pg_temp.payload('2026-11-05T11:00:00Z', 12, '+447700939099', 'OF99BAD', pg_temp.offers(), 'phone')),
          'P0001 INVALID_BOOKING: offers consent is given only by the customer on the booking page', 'nor a phone booking');
select is(pg_temp.book_error(pg_temp.payload('2026-11-05T11:00:00Z', 13, '+447700939099', 'OF99BAD', pg_temp.offers(), 'walk_in')
                             || jsonb_build_object('staff', jsonb_build_object('member_id', pg_temp.manager_id(), 'override_hours', false))),
          'P0001 INVALID_BOOKING: offers consent is given only by the customer on the booking page', 'nor staff booking a walk-in');
select is(pg_temp.book_error(pg_temp.payload('2026-11-05T11:00:00Z', 14, '+447700939003', 'OF03OZY', '{"offers_consent": false}', 'walk_in')
                             || jsonb_build_object('staff', jsonb_build_object('member_id', pg_temp.manager_id(), 'override_hours', false))),
          'no error', 'a staff booking without offers consent still books');
select is((select count(*)::integer from public.customers where phone = '+447700939099'), 0, 'refused bookings store nobody');

-- ---------------------------------------------------------------------------
-- Opt-outs end offers consent and never give it back
-- ---------------------------------------------------------------------------

select public.apply_messaging_keyword(pg_temp.g(), '+447700939001', 'stop');
select is((select concat_ws('|', offers_consent, offers_opted_out_at = opted_out_at, offers_consent_text is not null) from public.customers where phone = '+447700939001'),
          'f|t|t', 'STOP turns offers consent off (the record of what they agreed to stays)');
select public.apply_messaging_keyword(pg_temp.g(), '+447700939001', 'start');
select is((select concat_ws('|', opted_out_at is null, reminder_consent, offers_consent) from public.customers where phone = '+447700939001'),
          't|t|f', 'START restarts reminders but not offers');

select public.opt_out_customer(pg_temp.g(), pg_temp.customer_id('+447700939003'), null, 'unsubscribe_link');
select is((select offers_consent from public.customers where phone = '+447700939003'), false, 'the unsubscribe link turns offers off');
select public.resume_customer_reminders(pg_temp.g(), pg_temp.customer_id('+447700939003'),
                                        'Reminders are back on. Offers Garage will send you reminders again. You can stop them any time.');
select is((select concat_ws('|', opted_out_at is null, reminder_consent, consent_source, offers_consent) from public.customers where phone = '+447700939003'),
          't|t|unsubscribe_page|f', '"Turn reminders back on" gives reminder consent, never offers consent');
select pg_temp.book(pg_temp.payload('2026-11-06T09:00:00Z', 15, '+447700939003', 'OF03OZY', pg_temp.offers()), '2026-10-31 12:00+00');
select is(pg_temp.offers_of('+447700939003'), 't|booking|2026-10-31 12:00|' || pg_temp.offers_text(), 'only a fresh tick on a booking turns offers back on');

-- Soft opt-in customers (consent_source soft_opt_in), with a car each.
insert into public.customers (id, garage_id, name, phone, preferred_contact, channel, reminder_consent, consent_at, consent_source) values
  ('a3900000-0000-4000-8000-000000000106', pg_temp.g(), 'Sam Soft', '+447700939006', 'phone', 'sms', true, '2026-01-01 09:00+00', 'soft_opt_in'),
  ('a3900000-0000-4000-8000-000000000107', pg_temp.g(), 'Tia Soft', '+447700939007', 'phone', 'sms', true, '2026-01-01 09:00+00', 'soft_opt_in'),
  ('a3900000-0000-4000-8000-000000000109', pg_temp.g(), 'Cal None', '+447700939009', 'phone', 'sms', false, null, null);
insert into public.vehicles (garage_id, customer_id, registration, year) values
  (pg_temp.g(), 'a3900000-0000-4000-8000-000000000106', 'OF06SAM', 2017),
  (pg_temp.g(), 'a3900000-0000-4000-8000-000000000107', 'OF07TIA', 2016),
  (pg_temp.g(), 'a3900000-0000-4000-8000-000000000109', 'OF09CAL', 2015);
select public.apply_messaging_keyword(pg_temp.g(), '+447700939006', 'stop');
select public.apply_messaging_keyword(pg_temp.g(), '+447700939006', 'start');
select is((select concat_ws('|', opted_out_at is null, reminder_consent, consent_source, offers_opted_out_at is not null) from public.customers where phone = '+447700939006'),
          't|t|soft_opt_in|t', 'after STOP and START a soft opt-in customer keeps reminders, and the opt-out is remembered for offers');

-- ---------------------------------------------------------------------------
-- Staff cannot write offers consent
-- ---------------------------------------------------------------------------

select pg_temp.manager();
set local role authenticated;
select throws_ok($$update public.customers set offers_consent = true, offers_consent_at = now(), offers_consent_source = 'booking', offers_consent_text = 'Offers'
                   where phone = '+447700939009'$$, '42501', null, 'staff cannot tick offers consent for a customer');
select throws_ok($$update public.customers set offers_consent = false where phone = '+447700939002'$$, '42501', null,
                 'nor untick it (opting the customer out does that)');
select throws_ok($$update public.customers set offers_opted_out_at = null where phone = '+447700939006'$$, '42501', null,
                 'nor clear a remembered opt-out');
select throws_ok($$insert into public.customers (garage_id, name, phone, preferred_contact, offers_consent, offers_consent_at, offers_consent_source, offers_consent_text)
                   values ('a3900000-0000-4000-8000-000000000001', 'Typed in', '+447700939092', 'phone', true, now(), 'booking', 'Offers')$$,
                 '42501', null, 'nor add a customer with offers consent');
select lives_ok($$update public.customers set name = 'Rita Renamed' where phone = '+447700939002'$$, 'staff still edit other details');
select is(pg_temp.offers_of('+447700939002'), 't|booking|2026-10-30 12:00|' || pg_temp.offers_text(), 'and the offers consent is untouched');
-- The admin's "Opt out of reminders" button (customers/actions.ts) writes opted_out_at directly.
update public.customers set opted_out_at = now() where phone = '+447700939005';
select is((select concat_ws('|', offers_consent, offers_opted_out_at is not null) from public.customers where phone = '+447700939005'), 'f|t',
          'a staff opt-out turns offers off');
reset role;

-- ---------------------------------------------------------------------------
-- Imports never grant offers consent
-- ---------------------------------------------------------------------------

create temp table import_ids (id uuid);
grant all on import_ids to authenticated;
select pg_temp.manager();
set local role authenticated;
insert into import_ids values (public.start_customer_import('customers.csv', '{"total_rows": 2, "valid_rows": 2}',
  'I confirm these customers gave their details to Offers Garage when buying or booking a service, were told they could opt out of reminders, and have not opted out, or have given consent to receive reminders.'));
select public.import_customer_rows((select id from import_ids), '[
  {"name": "Ivy Import", "phone": "+447700939008", "email": null, "registration": "OF08IVY", "consent": true},
  {"name": "Rita Import", "phone": "+447700939002", "email": null, "registration": "OF02RIT", "consent": false}
]'::jsonb);
reset role;
select is((select concat_ws('|', reminder_consent, consent_source, offers_consent, coalesce(offers_consent_text, '-')) from public.customers where phone = '+447700939008'),
          't|import|f|-', 'an import with the declaration records reminder consent, never offers consent');
select is(pg_temp.offers_of('+447700939002'), 't|booking|2026-10-30 12:00|' || pg_temp.offers_text(), 'and leaves existing offers consent as it is');

-- ---------------------------------------------------------------------------
-- The campaign audience
-- ---------------------------------------------------------------------------

select pg_temp.manager();
set local role authenticated;
select is((select array_agg(phone || ':' || consent_basis order by phone) from public.preview_campaign_audience('{}', 50)),
          array['+447700939002:offers', '+447700939003:offers', '+447700939004:offers', '+447700939007:soft_opt_in'],
          'campaigns go to offers consent (Rita, Ozzy, Rex) and soft opt-in (Tia) only');
select is((select row(total, offers_total)::text from public.preview_campaign_audience('{}', 1) limit 1), '(4,3)', 'the count says how many ticked offers');
select is((select count(*)::integer from public.preview_campaign_audience('{}', 50)
           where phone in ('+447700939001', '+447700939005', '+447700939006', '+447700939008', '+447700939009')), 0,
          'left out: offers ended by STOP (Olly) and by staff (Una), soft opt-in after an opt-out (Sam), imported (Ivy), no consent (Cal)');

insert into public.campaigns (id, garage_id, name, segment, template, email_subject)
values ('a3900000-0000-4000-8000-000000000801', pg_temp.g(), 'Winter', '{}', '{garage}: Hi {first_name}, winter check? Book: {link}', 'Winter check');
select is((public.schedule_campaign('a3900000-0000-4000-8000-000000000801', null)).recipients, 4, 'scheduling freezes the same four');
reset role;

-- Losing the soft opt-in route (reminder consent withdrawn) cancels the pending send.
update public.customers set reminder_consent = false where phone = '+447700939007';
select is((select status || ':' || skip_reason from public.campaign_sends where customer_id = pg_temp.customer_id('+447700939007')),
          'cancelled:no_consent', 'a soft opt-in customer who withdraws reminder consent gets no campaign');
-- STOP cancels it too, and the offers consent goes with it.
select public.apply_messaging_keyword(pg_temp.g(), '+447700939004', 'stop');
select is((select status || ':' || skip_reason from public.campaign_sends where customer_id = pg_temp.customer_id('+447700939004')),
          'cancelled:opted_out', 'STOP cancels a pending campaign send');

-- The claim re-checks the rule: a send frozen for someone without it is skipped.
insert into public.campaign_sends (garage_id, campaign_id, customer_id, vehicle_id, channel, send_at)
select pg_temp.g(), 'a3900000-0000-4000-8000-000000000801', customer.id, vehicle.id, 'sms', now()
from public.customers customer join public.vehicles vehicle on vehicle.customer_id = customer.id
where customer.phone = '+447700939008';
set local role service_role;
select is((select array_agg(phone order by phone) from public.claim_campaign_sends(pg_temp.g(), now() + interval '1 minute', 10)),
          array['+447700939002', '+447700939003'], 'the claim sends to offers consent only');
reset role;
select is((select skip_reason from public.campaign_sends where customer_id = pg_temp.customer_id('+447700939008')), 'no_consent',
          'reminder consent from an import is skipped at claim time');

select * from finish();
rollback;
