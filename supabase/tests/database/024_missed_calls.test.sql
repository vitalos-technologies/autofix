begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(26);

-- Missed calls (P4.1): calls.dial_status / voicemail_duration_s and
-- claim_call_text_back(): one text-back per missed call, at most one per
-- garage and number in 24 hours, never to opted-out or withheld callers.
--
-- Garage M (MCM) and garage N (MCN). Kim (+447700918001) is a customer of
-- M; Ola (+447700918002) is a customer of M who opted out; Una
-- (+447700918003) is unknown to M; garage N also knows Kim's number.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17200000-0000-4000-8000-0000000000a1', 'missed-owner@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status) values
  ('a1720000-0000-4000-8000-000000000001', 'pgtap-missed-m', 'Missed Garage M', 'MCM', 'active'),
  ('b1720000-0000-4000-8000-000000000001', 'pgtap-missed-n', 'Missed Garage N', 'MCN', 'active');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1720000-0000-4000-8000-000000000001', '17200000-0000-4000-8000-0000000000a1', 'owner');

create function pg_temp.m() returns uuid language sql as $$ select 'a1720000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.n() returns uuid language sql as $$ select 'b1720000-0000-4000-8000-000000000001'::uuid $$;

insert into public.customers (id, garage_id, name, phone, preferred_contact, opted_out_at) values
  ('a1720000-0000-4000-8000-000000000101', pg_temp.m(), 'Kim Caller', '+447700918001', 'phone', null),
  ('a1720000-0000-4000-8000-000000000102', pg_temp.m(), 'Ola Optout', '+447700918002', 'phone', now()),
  ('b1720000-0000-4000-8000-000000000101', pg_temp.n(), 'Kim Elsewhere', '+447700918001', 'phone', null);

insert into public.calls (id, garage_id, provider_call_sid, from_number, to_number, status, missed) values
  ('a1720000-0000-4000-8000-000000000201', pg_temp.m(), 'CApgtap024000000000000000000001', '+447700918001', '+441134960001', 'ringing', true),
  ('a1720000-0000-4000-8000-000000000202', pg_temp.m(), 'CApgtap024000000000000000000002', '+447700918001', '+441134960001', 'ringing', true),
  ('a1720000-0000-4000-8000-000000000203', pg_temp.m(), 'CApgtap024000000000000000000003', '+447700918002', '+441134960001', 'ringing', true),
  ('a1720000-0000-4000-8000-000000000204', pg_temp.m(), 'CApgtap024000000000000000000004', null, '+441134960001', 'ringing', true),
  ('a1720000-0000-4000-8000-000000000205', pg_temp.m(), 'CApgtap024000000000000000000005', '+447700918003', '+441134960001', 'completed', false),
  ('a1720000-0000-4000-8000-000000000206', pg_temp.m(), 'CApgtap024000000000000000000006', '+447700918003', '+441134960001', 'ringing', true),
  ('b1720000-0000-4000-8000-000000000201', pg_temp.n(), 'CApgtap024000000000000000000007', '+447700918001', '+441134960002', 'ringing', true);

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_column('public', 'calls', 'dial_status', 'calls has dial_status');
select has_column('public', 'calls', 'voicemail_duration_s', 'calls has voicemail_duration_s');
select throws_ok(
  $$update public.calls set dial_status = 'ringing' where id = 'a1720000-0000-4000-8000-000000000201'$$,
  '23514', null, 'dial_status takes Twilio DialCallStatus values only'
);
select lives_ok(
  $$update public.calls set dial_status = 'no-answer' where id = 'a1720000-0000-4000-8000-000000000201'$$,
  'dial_status records no-answer'
);
select is(
  (select count(*)::integer from unnest(array['anon', 'authenticated']) api_role(name)
   where has_function_privilege(api_role.name, 'public.claim_call_text_back(uuid, uuid, text, text, text)', 'execute')),
  0, 'anon and staff cannot claim text-backs'
);
select is(
  has_function_privilege('service_role', 'public.claim_call_text_back(uuid, uuid, text, text, text)', 'execute'),
  true, 'the service role claims text-backs'
);
select is(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'public.claim_call_text_back(uuid, uuid, text, text, text)'::regprocedure),
  true, 'claim_call_text_back is security definer with an empty search_path'
);
select is(
  (select array_agg(attname::text order by attname::text) from pg_attribute
   where attrelid = 'public.calls'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', 'public.calls', attname, 'update')),
  array['handled_at', 'handled_by'], 'staff may still only set handled_at and handled_by on calls'
);

set local role service_role;

-- ---------------------------------------------------------------------------
-- claim_call_text_back
-- ---------------------------------------------------------------------------

create temp table claims (label text primary key, result jsonb not null);
grant all on claims to service_role;

insert into claims values ('kim-1', public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000201', 'sms', 'Sorry we missed your call.', 'mock'));
select is(
  (select concat_ws('|', result->>'status', result->>'customer_id', result->>'to') from claims where label = 'kim-1'),
  'claimed|a1720000-0000-4000-8000-000000000101|+447700918001',
  'a missed call from a known customer is claimed for a text-back'
);
select is(
  (select concat_ws('|', garage_id, customer_id, channel, direction, to_address, status, provider, call_id, body)
   from public.messages where id = (select (result->>'message_id')::uuid from claims where label = 'kim-1')),
  concat_ws('|', pg_temp.m(), 'a1720000-0000-4000-8000-000000000101', 'sms', 'outbound', '+447700918001', 'sending', 'mock', 'a1720000-0000-4000-8000-000000000201', 'Sorry we missed your call.'),
  'the outbound message is written before the send, linked to the call'
);
select is(
  (select text_back_message_id from public.calls where id = 'a1720000-0000-4000-8000-000000000201'),
  (select (result->>'message_id')::uuid from claims where label = 'kim-1'),
  'the call points at its text-back'
);
select is(
  public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000201', 'sms', 'Again', 'mock'),
  '{"status": "skipped", "reason": "already_sent"}'::jsonb,
  'the same call never gets a second text-back'
);
select is(
  public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000202', 'sms', 'Second call', 'mock'),
  '{"status": "skipped", "reason": "recent_text_back"}'::jsonb,
  'another missed call from the same number within 24 hours gets none'
);
select is(
  (select result->>'status' from (select public.claim_call_text_back(pg_temp.n(), 'b1720000-0000-4000-8000-000000000201', 'sms', 'Garage N', 'mock') as result) claimed),
  'claimed', 'another garage may still text the same number back'
);
select is(
  public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000203', 'sms', 'Opted out', 'mock'),
  '{"status": "skipped", "reason": "opted_out"}'::jsonb,
  'an opted-out customer gets no text-back'
);
select is(
  public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000204', 'sms', 'Withheld', 'mock'),
  '{"status": "skipped", "reason": "withheld"}'::jsonb,
  'a withheld number cannot be texted'
);
select is(
  public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000205', 'sms', 'Answered', 'mock'),
  '{"status": "skipped", "reason": "not_missed"}'::jsonb,
  'an answered call gets no text-back'
);
select is(
  public.claim_call_text_back(pg_temp.n(), 'a1720000-0000-4000-8000-000000000206', 'sms', 'Wrong garage', 'mock'),
  '{"status": "skipped", "reason": "not_found"}'::jsonb,
  'a garage cannot claim another garage''s call'
);
select is(
  (select result->>'status' || '|' || coalesce(result->>'customer_id', 'unknown') from (select public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000206', 'whatsapp', 'Unknown caller', 'mock') as result) claimed),
  'claimed|unknown', 'an unknown caller is texted back with no customer link'
);

reset role;
-- 25 hours later the 24-hour window has passed.
update public.messages set created_at = now() - interval '25 hours'
where garage_id = pg_temp.m() and to_address = '+447700918001' and call_id is not null;
set local role service_role;
select is(
  (select result->>'status' from (select public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000202', 'sms', 'A day later', 'mock') as result) claimed),
  'claimed', 'after 24 hours the same number can be texted back again'
);

select throws_ok(
  $$select public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000203', 'email', 'x', 'mock')$$,
  '22023', null, 'a text-back is SMS or WhatsApp'
);
select throws_ok(
  $$select public.claim_call_text_back(pg_temp.m(), 'a1720000-0000-4000-8000-000000000203', 'sms', '   ', 'mock')$$,
  '22023', null, 'a text-back needs a body'
);
select throws_ok(
  $$select public.claim_call_text_back(null, 'a1720000-0000-4000-8000-000000000203', 'sms', 'x', 'mock')$$,
  '22023', null, 'a text-back needs the garage'
);

-- Staff read calls through RLS as before (only their garage).
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', '17200000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
select set_config('request.headers', jsonb_build_object('x-garage-id', pg_temp.m())::text, true);
set local role authenticated;
select is(
  (select count(*)::integer from public.calls),
  6, 'the owner sees their garage''s calls only'
);
select lives_ok(
  $$update public.calls set handled_at = now(), handled_by = '17200000-0000-4000-8000-0000000000a1' where id = 'a1720000-0000-4000-8000-000000000201'$$,
  'staff mark a call handled as themselves'
);
select throws_ok(
  $$update public.calls set dial_status = 'completed' where id = 'a1720000-0000-4000-8000-000000000201'$$,
  '42501', null, 'staff cannot change the dial outcome'
);

select * from finish();
rollback;
