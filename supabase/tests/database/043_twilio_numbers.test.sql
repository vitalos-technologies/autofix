begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(54);

-- D22 Twilio numbers (20261029003400_twilio_numbers.sql): garage_phone_numbers.ring_garage_first,
-- ai_front_desk_numbers (tenant), twilio_number_provisioning (platform, one row) and the five
-- service-role functions behind the numbers.provision job.
--
-- Garages: P on paid Pro with the AI front desk on (owner Pia), E on Essentials with the switch on,
-- O on Pro with the switch off (owner Otto), S on Pro, switched on but suspended.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17430000-0000-4000-8000-0000000000a1', 'num-owner-p@pgtap.test', '{}'::jsonb),
  ('17430000-0000-4000-8000-0000000000b1', 'num-owner-o@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen, phone) values
  ('a1743000-0000-4000-8000-000000000001', 'pgtap-num-p', 'NUM Pro', 'NMP', 'active', 'pro', null, 'pro', '+441144960001'),
  ('a1743000-0000-4000-8000-000000000002', 'pgtap-num-e', 'NUM Essentials', 'NME', 'active', 'essentials', null, 'essentials', null),
  ('a1743000-0000-4000-8000-000000000003', 'pgtap-num-o', 'NUM Off', 'NMO', 'active', 'pro', null, 'pro', null),
  ('a1743000-0000-4000-8000-000000000004', 'pgtap-num-s', 'NUM Suspended', 'NMS', 'suspended', 'pro', null, 'pro', null);
insert into public.garage_members (garage_id, user_id, role) values
  ('a1743000-0000-4000-8000-000000000001', '17430000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1743000-0000-4000-8000-000000000003', '17430000-0000-4000-8000-0000000000b1', 'owner');
insert into public.ai_front_desk_settings (garage_id, enabled, enabled_at) values
  ('a1743000-0000-4000-8000-000000000001', true, now()),
  ('a1743000-0000-4000-8000-000000000002', true, now()),
  ('a1743000-0000-4000-8000-000000000003', false, null),
  ('a1743000-0000-4000-8000-000000000004', true, now());

create function pg_temp.p() returns uuid language sql as $$ select 'a1743000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.o() returns uuid language sql as $$ select 'a1743000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.mine() returns uuid[] language sql as $$
  select array['a1743000-0000-4000-8000-000000000001', 'a1743000-0000-4000-8000-000000000002',
               'a1743000-0000-4000-8000-000000000003', 'a1743000-0000-4000-8000-000000000004']::uuid[]
$$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.ai_front_desk_numbers'::regclass), 'ai_front_desk_numbers has RLS on');
select ok(not has_table_privilege('authenticated', 'public.ai_front_desk_numbers', 'insert,update,delete'), 'staff never write the AI desk number');
select ok(not has_table_privilege('anon', 'public.ai_front_desk_numbers', 'select,insert,update,delete'), 'anon has nothing on the AI desk number');
select ok(has_table_privilege('service_role', 'public.ai_front_desk_numbers', 'select,insert,update'), 'the job (service role) writes it');
select ok(not has_table_privilege('service_role', 'public.ai_front_desk_numbers', 'delete'), 'nothing deletes a number record (A436)');
select is((select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'ai_front_desk_numbers'), 1, 'one policy: members read');

select hasnt_column('public', 'twilio_number_provisioning', 'garage_id', 'twilio_number_provisioning belongs to no garage');
select ok((select relrowsecurity from pg_class where oid = 'public.twilio_number_provisioning'::regclass), 'twilio_number_provisioning has RLS on');
select is((select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'twilio_number_provisioning'), 0, 'and no policies: service role only');
select ok(not has_table_privilege('authenticated', 'public.twilio_number_provisioning', 'select,insert,update,delete')
  and not has_table_privilege('anon', 'public.twilio_number_provisioning', 'select,insert,update,delete'), 'staff and anon get nothing on the platform row');
select is((select count(*)::integer from public.twilio_number_provisioning), 1, 'it has its one row');

select col_not_null('public', 'garage_phone_numbers', 'ring_garage_first', 'ring_garage_first is not null');
select col_default_is('public', 'garage_phone_numbers', 'ring_garage_first', 'true', 'existing and new numbers ring the garage first by default');
select ok(not has_column_privilege('authenticated', 'public.garage_phone_numbers', 'ring_garage_first', 'update')
  and not has_column_privilege('authenticated', 'public.garage_phone_numbers', 'ring_garage_first', 'insert'), 'only the service role sets ring_garage_first');

select ok(not has_function_privilege('authenticated', 'public.claim_number_provisioning(uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.claim_number_provisioning(uuid,integer)', 'execute'), 'the lease is service role only');
select ok(not has_function_privilege('authenticated', 'public.release_number_provisioning(uuid)', 'execute'), 'releasing the lease is service role only');
select ok(not has_function_privilege('authenticated', 'public.ai_front_desk_numbers_due(uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.ai_front_desk_numbers_due(uuid,integer)', 'execute'), 'the due list is service role only');
select ok(not has_function_privilege('authenticated', 'public.attach_ai_front_desk_number(uuid,text,text,boolean)', 'execute')
  and not has_function_privilege('anon', 'public.attach_ai_front_desk_number(uuid,text,text,boolean)', 'execute'), 'routing a number is service role only');
select ok(not has_function_privilege('authenticated', 'public.set_ai_front_desk_number_status(uuid[],text,text)', 'execute'), 'recording a state is service role only');
select is((select count(*)::integer from pg_proc
           where oid in ('public.claim_number_provisioning(uuid,integer)'::regprocedure, 'public.release_number_provisioning(uuid)'::regprocedure,
                         'public.ai_front_desk_numbers_due(uuid,integer)'::regprocedure, 'public.attach_ai_front_desk_number(uuid,text,text,boolean)'::regprocedure,
                         'public.set_ai_front_desk_number_status(uuid[],text,text)'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 5, 'the functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Who is due a number
-- ---------------------------------------------------------------------------

set local role service_role;
select results_eq(
  $$select garage_id, garage_phone, status from public.ai_front_desk_numbers_due(null, 200) where garage_id = any (pg_temp.mine())$$,
  $$values ('a1743000-0000-4000-8000-000000000001'::uuid, '+441144960001'::text, null::text)$$,
  'only the Pro garage that takes bookings with the desk on is due (not Essentials, switched off or suspended)'
);
select is((select count(*)::integer from public.ai_front_desk_numbers_due(pg_temp.o(), 50)), 0, 'a garage with the desk off is never due');

-- ---------------------------------------------------------------------------
-- Recording states
-- ---------------------------------------------------------------------------

select is(public.set_ai_front_desk_number_status(array[pg_temp.p()], 'waiting_upgrade', null), 1, 'records waiting for the upgrade');
select is((select status from public.ai_front_desk_numbers where garage_id = pg_temp.p()), 'waiting_upgrade', 'the garage waits for the upgrade');
select is(public.set_ai_front_desk_number_status(array['a1743000-0000-4000-8000-0000000000ff'::uuid], 'failed', null), 0, 'an unknown garage gets no row');
select throws_ok($$select public.set_ai_front_desk_number_status(array['a1743000-0000-4000-8000-000000000001'::uuid], 'ready', null)$$, '22023', 'INVALID_STATUS', 'ready only comes from attaching a number');
select throws_ok($$select public.set_ai_front_desk_number_status(array['a1743000-0000-4000-8000-000000000001'::uuid], 'failed', 'Twilio said +44 7700 900123')$$, '22023', 'INVALID_REASON', 'reasons are safe codes, never provider text or numbers');
select throws_ok($$insert into public.ai_front_desk_numbers (garage_id, status) values ('a1743000-0000-4000-8000-000000000003', 'ready')$$, '23514', null, 'ready needs a number, its SID and when');

-- ---------------------------------------------------------------------------
-- Attaching a number
-- ---------------------------------------------------------------------------

select is(public.attach_ai_front_desk_number(pg_temp.p(), '+441144960101', 'PN00000000000000000000000000000101', false) ->> 'newly_ready', 'true', 'a bought number becomes the garage''s AI desk number');
select results_eq(
  $$select purpose, provider_sid, ring_garage_first from public.garage_phone_numbers where number = '+441144960101'$$,
  $$values ('forwarding'::text, 'PN00000000000000000000000000000101'::text, false)$$,
  'it routes to the garage and never rings the garage first (A432)'
);
select results_eq(
  $$select status, number, provider_sid, reason, ready_at is not null from public.ai_front_desk_numbers where garage_id = 'a1743000-0000-4000-8000-000000000001'$$,
  $$values ('ready'::text, '+441144960101'::text, 'PN00000000000000000000000000000101'::text, null::text, true)$$,
  'the state is ready with the number'
);
select is((select count(*)::integer from public.admin_audit_log where garage_id = pg_temp.p() and action = 'ai_front_desk.number_ready'), 1, 'audited once');
select is((select count(*)::integer from public.ai_front_desk_numbers_due(pg_temp.p(), 50)), 0, 'a ready, routed garage is no longer due');
select is(public.attach_ai_front_desk_number(pg_temp.p(), '+441144960101', 'PN00000000000000000000000000000101', false) ->> 'newly_ready', 'false', 'attaching it again changes nothing');
select is((select count(*)::integer from public.admin_audit_log where garage_id = pg_temp.p() and action = 'ai_front_desk.number_ready'), 1, 'and is not audited twice');
select throws_ok($$select public.attach_ai_front_desk_number('a1743000-0000-4000-8000-000000000001', '+441632960101', 'PN00000000000000000000000000000102', false)$$,
                 'P0001', 'ALREADY_PROVISIONED', 'a garage never gets a second number');
select throws_ok($$select public.attach_ai_front_desk_number('a1743000-0000-4000-8000-000000000003', '+441144960101', 'PN00000000000000000000000000000101', false)$$,
                 'P0001', 'NUMBER_TAKEN', 'another garage''s number is refused');
select throws_ok($$select public.attach_ai_front_desk_number('a1743000-0000-4000-8000-000000000003', '+441632960102', 'not-a-sid', false)$$,
                 '22023', 'INVALID_NUMBER', 'a SID must look like Twilio''s');

select is(public.set_ai_front_desk_number_status(array[pg_temp.p()], 'failed', 'twilio:21631'), 1, 'a later failure can be recorded');
select results_eq(
  $$select number, provider_sid from public.ai_front_desk_numbers where garage_id = 'a1743000-0000-4000-8000-000000000001'$$,
  $$values ('+441144960101'::text, 'PN00000000000000000000000000000101'::text)$$,
  'but the number and SID stay recorded, so nothing is bought twice'
);
delete from public.garage_phone_numbers where number = '+441144960101';
select results_eq(
  $$select provider_sid, number, routed_sid from public.ai_front_desk_numbers_due(pg_temp.p(), 50)$$,
  $$values ('PN00000000000000000000000000000101'::text, '+441144960101'::text, null::text)$$,
  'with its routing gone the garage is due again, with the number it already has'
);
select lives_ok($$select public.attach_ai_front_desk_number('a1743000-0000-4000-8000-000000000001', '+441144960101', 'PN00000000000000000000000000000101', false)$$,
                'and the same number is routed again');

-- A number routed by hand (Launch ops twilio-number) keeps how it rings.
insert into public.garage_phone_numbers (garage_id, number, purpose, provider_sid) values
  ('a1743000-0000-4000-8000-000000000003', '+447700900311', 'messaging', 'PN00000000000000000000000000000311');
select lives_ok($$select public.attach_ai_front_desk_number('a1743000-0000-4000-8000-000000000003', '+447700900311', 'PN00000000000000000000000000000311', null)$$,
                'an existing routed number can be marked ready as it is');
select is((select ring_garage_first from public.garage_phone_numbers where number = '+447700900311'), true, 'still ringing the garage first');

-- ---------------------------------------------------------------------------
-- The lease
-- ---------------------------------------------------------------------------

select is(public.claim_number_provisioning('00000000-0000-4000-8000-0000000000c1', 60), true, 'a run takes the lease');
select is(public.claim_number_provisioning('00000000-0000-4000-8000-0000000000c2', 60), false, 'a second run waits while it runs');
select is(public.release_number_provisioning('00000000-0000-4000-8000-0000000000c2'), false, 'only the holder gives it back');
select is(public.release_number_provisioning('00000000-0000-4000-8000-0000000000c1'), true, 'the holder gives it back');
select is(public.claim_number_provisioning('00000000-0000-4000-8000-0000000000c2', 60), true, 'then the next run takes it');
reset role;
update public.twilio_number_provisioning set lease_until = now() - interval '1 second' where singleton;
set local role service_role;
select is(public.claim_number_provisioning('00000000-0000-4000-8000-0000000000c3', 60), true, 'a lease that ran out is taken over');
select throws_ok($$select public.claim_number_provisioning('00000000-0000-4000-8000-0000000000c4', 0)$$, '22023', 'INVALID_LEASE', 'a lease lasts 1 to 600 seconds');
reset role;

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17430000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.ai_front_desk_numbers), 1, 'the owner reads the garage''s own AI desk number only');
select throws_ok($$update public.ai_front_desk_numbers set status = 'ready'$$, '42501', null, 'and cannot change it');
reset role;
select pg_temp.as_member('17430000-0000-4000-8000-0000000000b1', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.ai_front_desk_numbers), 0, 'another garage''s owner forging x-garage-id reads nothing');
reset role;

select * from finish();
rollback;
