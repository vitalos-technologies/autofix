begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(36);

-- P5.12 AI front desk on Pro: agent_tokens.audience (workforce needs Pro,
-- askbridge read-only on Essentials), report_usage in the tool lists,
-- issue_agent_token(…, audience), list_agent_tokens() audience,
-- ai_front_desk_settings + set_ai_front_desk() + ai_front_desk_hand_off().
--
-- Garages: P on paid Pro (owner Pia, manager Max, technician Ted), E on
-- Essentials (owner Eve), X on an expired, unchosen trial.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17380000-0000-4000-8000-0000000000a1', 'afd-owner-p@pgtap.test', '{}'::jsonb),
  ('17380000-0000-4000-8000-0000000000a2', 'afd-manager-p@pgtap.test', '{}'::jsonb),
  ('17380000-0000-4000-8000-0000000000a3', 'afd-tech-p@pgtap.test', '{}'::jsonb),
  ('17380000-0000-4000-8000-0000000000b1', 'afd-owner-e@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen) values
  ('a1738000-0000-4000-8000-000000000001', 'pgtap-afd-p', 'AFD Pro', 'AFP', 'active', 'pro', null, 'pro'),
  ('a1738000-0000-4000-8000-000000000002', 'pgtap-afd-e', 'AFD Essentials', 'AFE', 'active', 'essentials', null, 'essentials'),
  ('a1738000-0000-4000-8000-000000000003', 'pgtap-afd-x', 'AFD Expired', 'AFX', 'active', 'pro', now() - interval '1 day', null);
insert into public.garage_members (garage_id, user_id, role) values
  ('a1738000-0000-4000-8000-000000000001', '17380000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1738000-0000-4000-8000-000000000001', '17380000-0000-4000-8000-0000000000a2', 'manager'),
  ('a1738000-0000-4000-8000-000000000001', '17380000-0000-4000-8000-0000000000a3', 'technician'),
  ('a1738000-0000-4000-8000-000000000002', '17380000-0000-4000-8000-0000000000b1', 'owner');

create function pg_temp.p() returns uuid language sql as $$ select 'a1738000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a1738000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.x() returns uuid language sql as $$ select 'a1738000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.ai_front_desk_settings'::regclass), 'ai_front_desk_settings has RLS on');
select ok(not has_table_privilege('authenticated', 'public.ai_front_desk_settings', 'insert,update,delete'), 'staff write the switch only through set_ai_front_desk()');
select ok(not has_table_privilege('anon', 'public.ai_front_desk_settings', 'select,insert,update,delete'), 'anon has nothing on the switch');
select ok(not has_function_privilege('authenticated', 'public.issue_agent_token(uuid,text,text[],text,text)', 'execute'), 'only the service role issues tokens');
select ok(not has_function_privilege('authenticated', 'public.ai_front_desk_hand_off(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.ai_front_desk_hand_off(uuid)', 'execute'), 'the hand-off check is service role only');
select ok(not has_function_privilege('anon', 'public.set_ai_front_desk(boolean)', 'execute'), 'anon cannot switch the front desk');
select is((select count(*)::integer from pg_proc
           where oid in ('public.set_ai_front_desk(boolean)'::regprocedure, 'public.ai_front_desk_hand_off(uuid)'::regprocedure,
                         'public.issue_agent_token(uuid,text,text[],text,text)'::regprocedure, 'public.list_agent_tokens()'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 4, 'the functions are security definer with an empty search_path');
select is((select column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'agent_tokens' and column_name = 'audience'), '''workforce''::text',
          'tokens are workforce unless said otherwise');

-- ---------------------------------------------------------------------------
-- Issuing tokens (service role): workforce needs Pro, askbridge does not
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.issue_agent_token(pg_temp.p(), 'Workforce', null, repeat('1', 64), 'workforce') ->> 'audience', 'workforce',
          'a Pro garage gets a workforce token');
select is((select scopes from public.agent_tokens where token_hash = repeat('1', 64)),
          array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile']::text[],
          'the default workforce scopes are unchanged');
select lives_ok($$select public.issue_agent_token('a1738000-0000-4000-8000-000000000001', 'Workforce full',
                  array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile', 'report_usage'],
                  repeat('2', 64), 'workforce')$$, 'report_usage is a tool a token may hold');
select throws_ok($$select public.issue_agent_token('a1738000-0000-4000-8000-000000000002', 'Workforce', null, repeat('3', 64), 'workforce')$$,
                 'P0001', 'PLAN_REQUIRED: ai_front_desk', 'an Essentials garage gets no workforce token');
select throws_ok($$select public.issue_agent_token('a1738000-0000-4000-8000-000000000002', 'Workforce', null, repeat('3', 64))$$,
                 'P0001', 'PLAN_REQUIRED: ai_front_desk', 'the four-argument form issues workforce tokens too');
select throws_ok($$select public.issue_agent_token('a1738000-0000-4000-8000-000000000003', 'Workforce', null, repeat('3', 64), 'workforce')$$,
                 'P0001', 'PLAN_REQUIRED: ai_front_desk', 'an expired trial gets no workforce token');
select is(public.issue_agent_token(pg_temp.e(), 'Askbridge', null, repeat('4', 64), 'askbridge') -> 'scopes',
          '["list_services", "available_slots", "garage_profile"]'::jsonb, 'an Essentials garage gets an askbridge token with the read-only tools');
select throws_ok($$select public.issue_agent_token('a1738000-0000-4000-8000-000000000002', 'Askbridge', array['create_booking'], repeat('5', 64), 'askbridge')$$,
                 '23514', null, 'an askbridge token cannot book');
select throws_ok($$select public.issue_agent_token('a1738000-0000-4000-8000-000000000002', 'Askbridge', array['report_usage'], repeat('5', 64), 'askbridge')$$,
                 '23514', null, 'an askbridge token cannot report minutes');
select throws_ok($$select public.issue_agent_token('a1738000-0000-4000-8000-000000000001', 'Other', null, repeat('5', 64), 'robot')$$,
                 '22023', 'INVALID_TOKEN: audience must be workforce or askbridge', 'unknown audiences are refused');
select lives_ok($$insert into public.agent_call_log (garage_id, token_id, tool, outcome, http_status, latency_ms)
                  select garage_id, id, 'report_usage', 'PLAN_REQUIRED', 403, 3 from public.agent_tokens where token_hash = repeat('2', 64)$$,
                'the call log names report_usage and PLAN_REQUIRED');
reset role;

-- ---------------------------------------------------------------------------
-- Listing tokens
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17380000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select results_eq('select name || '':'' || audience from public.list_agent_tokens() order by name',
                  array['Workforce:workforce', 'Workforce full:workforce'], 'a manager lists the garage''s tokens with their audience');
reset role;
select pg_temp.as_member('17380000-0000-4000-8000-0000000000b1', pg_temp.p());
set local role authenticated;
select results_eq('select count(*) from public.list_agent_tokens()', array[0::bigint], 'another garage''s owner forging x-garage-id lists nothing');
reset role;

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17380000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select throws_ok($$select public.set_ai_front_desk(true)$$, '42501', null, 'a manager cannot switch the front desk');
reset role;
select pg_temp.as_member('17380000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select is(public.set_ai_front_desk(true) ->> 'enabled', 'true', 'the Pro owner switches the front desk on');
select is((select enabled from public.ai_front_desk_settings), true, 'and reads the switch');
select throws_ok($$select public.set_ai_front_desk(null)$$, '22023', 'INVALID_SETTING', 'null is not a setting');
select throws_ok($$insert into public.ai_front_desk_settings (garage_id, enabled) values ('a1738000-0000-4000-8000-000000000002', true)$$,
                 '42501', null, 'no direct writes, not even for another garage');
reset role;
select pg_temp.as_member('17380000-0000-4000-8000-0000000000a3', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.ai_front_desk_settings), 1, 'a technician reads the switch');
reset role;

select pg_temp.as_member('17380000-0000-4000-8000-0000000000b1', pg_temp.e());
set local role authenticated;
select throws_ok($$select public.set_ai_front_desk(true)$$, 'P0001', 'PLAN_REQUIRED: ai_front_desk', 'an Essentials owner cannot switch it on');
select is(public.set_ai_front_desk(false) ->> 'enabled', 'false', 'but can switch it off');
select is((select count(*)::integer from public.ai_front_desk_settings where garage_id = pg_temp.p()), 0, 'another garage''s switch is invisible');
reset role;

select is((select count(*)::integer from public.admin_audit_log where garage_id in (pg_temp.p(), pg_temp.e()) and action like 'ai_front_desk.%'), 2,
          'each change is audited');

-- ---------------------------------------------------------------------------
-- Hand-off check (service role)
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.ai_front_desk_hand_off(pg_temp.p()), true, 'Pro, switched on: hand off');
select is(public.ai_front_desk_hand_off(pg_temp.e()), false, 'Essentials: missed-call text-back as before');
select is(public.ai_front_desk_hand_off('a1738000-0000-4000-8000-0000000000ff'), false, 'an unknown garage: no hand-off');
reset role;
update public.garages set plan = 'essentials', plan_chosen = 'essentials' where id = pg_temp.p();
set local role service_role;
select is(public.ai_front_desk_hand_off(pg_temp.p()), false, 'a downgrade stops the hand-off even with the switch on');
reset role;
update public.garages set plan = 'pro', plan_chosen = 'pro', status = 'suspended' where id = pg_temp.p();
set local role service_role;
select is(public.ai_front_desk_hand_off(pg_temp.p()), false, 'a suspended garage hands nothing off');
reset role;

select * from finish();
rollback;
