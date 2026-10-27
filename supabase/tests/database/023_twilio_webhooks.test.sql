begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(36);

-- Twilio webhooks (P3.8): the idempotency table and its claim/finish
-- functions, and STOP/START through apply_messaging_keyword().
--
-- Garage K (TWK) has two customers on +447700917001 (Kim, consent) and
-- +447700917002 (Lee, no consent) with scheduled reminders; garage L (TWL)
-- has its own customer on Kim's number, so a STOP to garage K must not touch
-- garage L.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17100000-0000-4000-8000-0000000000a1', 'twilio-owner@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, mot_enabled, status) values
  ('a1710000-0000-4000-8000-000000000001', 'pgtap-twilio-k', 'Twilio Garage K', 'TWK', true, 'active'),
  ('b1710000-0000-4000-8000-000000000001', 'pgtap-twilio-l', 'Twilio Garage L', 'TWL', true, 'active');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1710000-0000-4000-8000-000000000001', '17100000-0000-4000-8000-0000000000a1', 'owner');
select public.seed_garage_defaults(id) from public.garages where slug like 'pgtap-twilio-%';

create function pg_temp.k() returns uuid language sql as $$ select 'a1710000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.l() returns uuid language sql as $$ select 'b1710000-0000-4000-8000-000000000001'::uuid $$;

insert into public.customers (id, garage_id, name, phone, preferred_contact, reminder_consent, consent_at, consent_source) values
  ('a1710000-0000-4000-8000-000000000101', pg_temp.k(), 'Kim Consent', '+447700917001', 'phone', true, '2026-01-01 09:00+00', 'import'),
  ('a1710000-0000-4000-8000-000000000102', pg_temp.k(), 'Lee Noconsent', '+447700917002', 'phone', false, null, null),
  ('b1710000-0000-4000-8000-000000000101', pg_temp.l(), 'Kim Elsewhere', '+447700917001', 'phone', true, '2026-01-01 09:00+00', 'import');
insert into public.vehicles (id, garage_id, customer_id, registration, mot_expiry) values
  ('a1710000-0000-4000-8000-000000000201', pg_temp.k(), 'a1710000-0000-4000-8000-000000000101', 'TW17KIM', '2026-12-01'),
  ('b1710000-0000-4000-8000-000000000201', pg_temp.l(), 'b1710000-0000-4000-8000-000000000101', 'TW17KIM', '2026-12-01');

insert into public.reminder_sends (id, garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel, status, claimed_at, sent_at)
select plan.id, plan.garage_id, rule.id, plan.vehicle_id, plan.customer_id, 'mot', '2026-12-01', plan.offset_days, now() + interval '1 day', 'sms', plan.status,
       case when plan.status = 'sent' then now() end, case when plan.status = 'sent' then now() end
from (values
  ('a1710000-0000-4000-8000-000000000301'::uuid, pg_temp.k(), 'a1710000-0000-4000-8000-000000000201'::uuid, 'a1710000-0000-4000-8000-000000000101'::uuid, 28, 'scheduled'),
  ('a1710000-0000-4000-8000-000000000302'::uuid, pg_temp.k(), 'a1710000-0000-4000-8000-000000000201'::uuid, 'a1710000-0000-4000-8000-000000000101'::uuid, 7, 'sent'),
  ('b1710000-0000-4000-8000-000000000301'::uuid, pg_temp.l(), 'b1710000-0000-4000-8000-000000000201'::uuid, 'b1710000-0000-4000-8000-000000000101'::uuid, 28, 'scheduled')
) plan(id, garage_id, vehicle_id, customer_id, offset_days, status)
join public.reminder_rules rule on rule.garage_id = plan.garage_id and rule.kind = 'mot';

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'twilio_webhook_events', 'twilio_webhook_events exists');
select hasnt_column('public', 'twilio_webhook_events', 'garage_id', 'twilio_webhook_events is a platform table (no garage_id, A10)');
select columns_are('public', 'twilio_webhook_events',
  array['event_key', 'kind', 'provider_sid', 'processing_status', 'outcome', 'error_code', 'attempts', 'received_at', 'processed_at'],
  'twilio_webhook_events holds Twilio ids and outcome codes only (no numbers or bodies)');
select is(
  (select relrowsecurity from pg_class where oid = 'public.twilio_webhook_events'::regclass),
  true, 'twilio_webhook_events has RLS on'
);
select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'twilio_webhook_events'),
  0, 'twilio_webhook_events has no policies (service role only)'
);
select is(
  (select count(*)::integer
   from unnest(array['select', 'insert', 'update', 'delete']) privilege(name)
   cross join unnest(array['anon', 'authenticated']) api_role(name)
   where has_table_privilege(api_role.name, 'public.twilio_webhook_events', privilege.name)),
  0, 'anon and signed-in staff hold no privilege on twilio_webhook_events'
);
select is(
  (select count(*)::integer
   from unnest(array[
     'public.claim_twilio_webhook_event(text, text, text)',
     'public.finish_twilio_webhook_event(text, text, text, text)',
     'public.apply_messaging_keyword(uuid, text, text)'
   ]) fn(signature)
   cross join unnest(array['anon', 'authenticated']) api_role(name)
   where has_function_privilege(api_role.name, fn.signature, 'execute')),
  0, 'anon and signed-in staff cannot execute the webhook functions'
);
select is(
  (select count(*)::integer
   from unnest(array[
     'public.claim_twilio_webhook_event(text, text, text)',
     'public.finish_twilio_webhook_event(text, text, text, text)',
     'public.apply_messaging_keyword(uuid, text, text)'
   ]) fn(signature)
   where has_function_privilege('service_role', fn.signature, 'execute')),
  3, 'the service role executes the webhook functions'
);
select is(
  (select count(*)::integer from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('claim_twilio_webhook_event', 'finish_twilio_webhook_event', 'apply_messaging_keyword')
     and prosecdef and proconfig @> array['search_path=""']),
  3, 'the webhook functions are security definer with an empty search_path'
);

set local role service_role;

-- ---------------------------------------------------------------------------
-- claim / finish
-- ---------------------------------------------------------------------------

select is(public.claim_twilio_webhook_event('inbound:SMpgtap0001', 'sms', 'SMpgtap0001'), true, 'a new event is claimed');
select is(public.claim_twilio_webhook_event('inbound:SMpgtap0001', 'sms', 'SMpgtap0001'), false, 'the same event while it is processing is a duplicate');
select is(public.finish_twilio_webhook_event('inbound:SMpgtap0001', 'processed', 'stored'), true, 'a processing event can be finished');
select is(public.finish_twilio_webhook_event('inbound:SMpgtap0001', 'failed', 'stored'), false, 'a finished event cannot be finished again');
select is(public.claim_twilio_webhook_event('inbound:SMpgtap0001', 'sms', 'SMpgtap0001'), false, 'a processed event replayed is a duplicate');
select is(
  (select concat_ws('|', processing_status, outcome, attempts, processed_at is not null) from public.twilio_webhook_events where event_key = 'inbound:SMpgtap0001'),
  'processed|stored|1|t', 'the event records its outcome'
);

select is(public.claim_twilio_webhook_event('status:SMpgtap0002:delivered', 'status', 'SMpgtap0002'), true, 'a status event is claimed');
select is(public.finish_twilio_webhook_event('status:SMpgtap0002:delivered', 'failed', null, 'db_57014'), true, 'and can fail');
select is(public.claim_twilio_webhook_event('status:SMpgtap0002:delivered', 'status', 'SMpgtap0002'), true, 'a failed event is claimed again on the next delivery');
select is(
  (select concat_ws('|', processing_status, coalesce(error_code, 'none'), attempts) from public.twilio_webhook_events where event_key = 'status:SMpgtap0002:delivered'),
  'processing|none|2', 'the retry clears the error and counts the attempt'
);

reset role;
update public.twilio_webhook_events set received_at = now() - interval '6 minutes' where event_key = 'status:SMpgtap0002:delivered';
set local role service_role;
select is(public.claim_twilio_webhook_event('status:SMpgtap0002:delivered', 'status', 'SMpgtap0002'), true, 'an event stuck in processing for 5 minutes is claimed again');

select throws_ok(
  $$select public.claim_twilio_webhook_event('inbound:+447700917001', 'sms', 'SMpgtap0003')$$,
  '23514', null, 'an event key never holds a phone number'
);
select throws_ok(
  $$select public.claim_twilio_webhook_event('inbound:SMpgtap0004', 'fax', 'SMpgtap0004')$$,
  '23514', null, 'only the four webhook kinds are recorded'
);
select throws_ok(
  $$select public.finish_twilio_webhook_event('inbound:SMpgtap0001', 'done')$$,
  '22023', null, 'finish takes processed, ignored or failed'
);

-- ---------------------------------------------------------------------------
-- STOP / START
-- ---------------------------------------------------------------------------

select is(
  public.apply_messaging_keyword(pg_temp.k(), '+447700917001', 'stop'),
  '{"customers": 1, "cancelled": 1, "unchanged": 0}'::jsonb,
  'STOP opts the customer out and cancels their scheduled reminder'
);
select is(
  (select concat_ws('|', status, skip_reason) from public.reminder_sends where id = 'a1710000-0000-4000-8000-000000000301'),
  'cancelled|opted_out', 'the scheduled reminder is cancelled as opted_out'
);
select is(
  (select status from public.reminder_sends where id = 'a1710000-0000-4000-8000-000000000302'),
  'sent', 'a reminder that already went out keeps its status'
);
select is(
  (select concat_ws('|', (select opted_out_at is null from public.customers where id = 'b1710000-0000-4000-8000-000000000101'),
                         (select status from public.reminder_sends where id = 'b1710000-0000-4000-8000-000000000301'))),
  't|scheduled', 'the same number at another garage is untouched'
);

create temp table first_stop as select opted_out_at from public.customers where id = 'a1710000-0000-4000-8000-000000000101';
select is(
  public.apply_messaging_keyword(pg_temp.k(), '+447700917001', 'stop'),
  '{"customers": 0, "cancelled": 0, "unchanged": 1}'::jsonb,
  'a second STOP changes nothing (idempotent)'
);
select is(
  (select opted_out_at from public.customers where id = 'a1710000-0000-4000-8000-000000000101'),
  (select opted_out_at from first_stop), 'and keeps the first opt-out time'
);

select is(
  public.apply_messaging_keyword(pg_temp.k(), '+447700917001', 'start'),
  '{"customers": 1, "cancelled": 0, "unchanged": 0}'::jsonb,
  'START clears the opt-out of a customer with consent'
);
select is(
  public.apply_messaging_keyword(pg_temp.k(), '+447700917001', 'start'),
  '{"customers": 0, "cancelled": 0, "unchanged": 1}'::jsonb,
  'a second START changes nothing'
);

select public.apply_messaging_keyword(pg_temp.k(), '+447700917002', 'stop');
select is(
  public.apply_messaging_keyword(pg_temp.k(), '+447700917002', 'start'),
  '{"customers": 0, "cancelled": 0, "unchanged": 1}'::jsonb,
  'START never lifts the opt-out of a customer without consent'
);
select is(
  (select opted_out_at is not null from public.customers where id = 'a1710000-0000-4000-8000-000000000102'),
  true, 'so they stay opted out'
);

select is(
  public.apply_messaging_keyword(pg_temp.k(), '+447700917999', 'stop'),
  '{"customers": 0, "cancelled": 0, "unchanged": 0}'::jsonb,
  'a number with no customer changes nothing'
);
select throws_ok(
  $$select public.apply_messaging_keyword(pg_temp.k(), '07700917001', 'stop')$$,
  '22023', null, 'the number must be E.164'
);
select throws_ok(
  $$select public.apply_messaging_keyword('f1710000-0000-4000-8000-000000000001', '+447700917001', 'stop')$$,
  'P0001', 'GARAGE_NOT_FOUND', 'the garage must exist'
);

select * from finish();
rollback;
