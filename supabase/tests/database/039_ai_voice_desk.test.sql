begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(23);

-- P5.12 voice desk: per-call agent tokens (call_sid, expires_at,
-- issue_voice_call_token()), the log_call_summary tool (call tokens only),
-- calls.ai_summary via record_ai_call_summary(), ai_front_desk_voice_ready()
-- (hand-off plus the minutes allowance), and list_agent_tokens() hiding
-- per-call tokens.
--
-- Garages: P on paid Pro (owner Pia) with the front desk on, E on Essentials.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17390000-0000-4000-8000-0000000000a1', 'avd-owner-p@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen, timezone) values
  ('a1739000-0000-4000-8000-000000000001', 'pgtap-avd-p', 'AVD Pro', 'AVP', 'active', 'pro', null, 'pro', 'Europe/London'),
  ('a1739000-0000-4000-8000-000000000002', 'pgtap-avd-e', 'AVD Essentials', 'AVE', 'active', 'essentials', null, 'essentials', 'Europe/London');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1739000-0000-4000-8000-000000000001', '17390000-0000-4000-8000-0000000000a1', 'owner');
insert into public.ai_front_desk_settings (garage_id, enabled, enabled_at) values
  ('a1739000-0000-4000-8000-000000000001', true, now()),
  ('a1739000-0000-4000-8000-000000000002', true, now());
insert into public.calls (garage_id, provider_call_sid, from_number, to_number, status, missed) values
  ('a1739000-0000-4000-8000-000000000001', 'CA39000000000000000000000000000001', '+447700900111', '+447700100201', 'in-progress', true),
  ('a1739000-0000-4000-8000-000000000002', 'CA39000000000000000000000000000002', '+447700900112', '+447700100202', 'in-progress', true);
insert into public.calls (garage_id, provider_call_sid, to_number, status, missed, created_at) values
  ('a1739000-0000-4000-8000-000000000001', 'CA39000000000000000000000000000003', '+447700100201', 'completed', true, now() - interval '2 hours');

create function pg_temp.p() returns uuid language sql as $$ select 'a1739000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a1739000-0000-4000-8000-000000000002'::uuid $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.issue_voice_call_token(uuid,text,text,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.issue_voice_call_token(uuid,text,text,timestamptz)', 'execute'), 'only the service role mints call tokens');
select ok(not has_function_privilege('authenticated', 'public.record_ai_call_summary(uuid,text,text,text)', 'execute'), 'only the service role writes call summaries');
select ok(not has_function_privilege('authenticated', 'public.ai_front_desk_voice_ready(uuid,numeric)', 'execute'), 'the voice-ready check is service role only');
select is((select count(*)::integer from pg_proc
           where oid in ('public.issue_voice_call_token(uuid,text,text,timestamptz)'::regprocedure, 'public.record_ai_call_summary(uuid,text,text,text)'::regprocedure,
                         'public.ai_front_desk_voice_ready(uuid,numeric)'::regprocedure, 'public.list_agent_tokens()'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 4, 'the functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Minting call tokens
-- ---------------------------------------------------------------------------

set local role service_role;
select ok((public.issue_voice_call_token(pg_temp.p(), 'CA39000000000000000000000000000001', repeat('a', 64), now() + interval '30 minutes')) ? 'id',
  'a recent call of a Pro garage with the front desk on gets a token');
select throws_ok($$select public.issue_voice_call_token(pg_temp.p(), 'CA39000000000000000000000000000001', repeat('b', 64), now() + interval '30 minutes')$$,
  '23505', 'ALREADY_ISSUED', 'one token per call');
select throws_ok($$select public.issue_voice_call_token(pg_temp.e(), 'CA39000000000000000000000000000002', repeat('c', 64), now() + interval '30 minutes')$$,
  '42501', 'FRONT_DESK_OFF', 'Essentials gets no call token even with the switch row on');
select throws_ok($$select public.issue_voice_call_token(pg_temp.p(), 'CA39000000000000000000000000000002', repeat('c', 64), now() + interval '30 minutes')$$,
  'P0002', 'CALL_NOT_FOUND', 'another garage''s call is not found');
select throws_ok($$select public.issue_voice_call_token(pg_temp.p(), 'CA39000000000000000000000000000003', repeat('c', 64), now() + interval '30 minutes')$$,
  'P0002', 'CALL_NOT_FOUND', 'a call older than 30 minutes is not found');
select throws_ok($$select public.issue_voice_call_token(pg_temp.p(), 'CA39000000000000000000000000000003', repeat('c', 64), now() + interval '2 hours')$$,
  '22023', null, 'a token cannot outlive the hour');
select is((select array[audience, name] from public.agent_tokens where call_sid = 'CA39000000000000000000000000000001'),
  array['workforce', 'AI front desk call'], 'call tokens are workforce tokens named for staff');
select ok((select scopes @> array['log_call_summary', 'report_usage', 'create_booking']::text[] from public.agent_tokens where call_sid = 'CA39000000000000000000000000000001'),
  'call tokens can book, report minutes and log the summary');
select throws_ok($$insert into public.agent_tokens (garage_id, name, token_hash, scopes) values (pg_temp.p(), 'Staff', repeat('d', 64), array['log_call_summary'])$$,
  '23514', null, 'tokens staff issue never hold log_call_summary');
select throws_ok($$insert into public.agent_tokens (garage_id, name, token_hash, call_sid) values (pg_temp.p(), 'Half', repeat('e', 64), 'CA39000000000000000000000000000009')$$,
  '23514', null, 'call_sid needs expires_at');

-- ---------------------------------------------------------------------------
-- Summaries
-- ---------------------------------------------------------------------------

select is(public.record_ai_call_summary(pg_temp.p(), 'CA39000000000000000000000000000001', 'Wants a service on Tuesday; booking request made.', 'booked'), true, 'the summary is stored');
select is(public.record_ai_call_summary(pg_temp.p(), 'CA39000000000000000000000000000001', 'Second go', 'message'), false, 'once per call');
select is(public.record_ai_call_summary(pg_temp.e(), 'CA39000000000000000000000000000001', 'Wrong garage', 'message'), false, 'never on another garage''s call');
select throws_ok($$select public.record_ai_call_summary(pg_temp.p(), 'CA39000000000000000000000000000003', 'x', 'sold')$$, '23514', null, 'only known outcomes');
select is((select array[ai_summary, ai_outcome] from public.calls where provider_call_sid = 'CA39000000000000000000000000000001'),
  array['Wants a service on Tuesday; booking request made.', 'booked'], 'staff see what the AI wrote');

-- ---------------------------------------------------------------------------
-- Minutes allowance
-- ---------------------------------------------------------------------------

select lives_ok($$select public.record_usage(pg_temp.p(), 'ai_minutes', 150, 'ai:CA39000000000000000000000000000001', now())$$, '150 minutes used this month');
select is(array[public.ai_front_desk_voice_ready(pg_temp.p(), 200), public.ai_front_desk_voice_ready(pg_temp.p(), null), public.ai_front_desk_voice_ready(pg_temp.p(), 150)],
  array[true, true, false], 'ready under the allowance or with no cap set; not at it');
select is(public.ai_front_desk_voice_ready(pg_temp.e(), 200), false, 'Essentials is never ready');
reset role;

-- ---------------------------------------------------------------------------
-- Staff never see call tokens
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', jsonb_build_object('sub', '17390000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true),
       set_config('request.headers', jsonb_build_object('x-garage-id', pg_temp.p())::text, true);
set local role authenticated;
select is((select count(*)::integer from public.list_agent_tokens()), 0, 'list_agent_tokens() leaves per-call tokens out');
reset role;

select * from finish();
rollback;
