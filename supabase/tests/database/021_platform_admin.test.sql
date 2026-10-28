begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

-- Super admin (P4.5): platform functions need a platform admin at AAL2;
-- impersonation admits exactly one garage, read-only, until it expires or
-- ends; every action lands in platform_audit_log and the garage's own
-- admin_audit_log.

insert into auth.users (id, email, raw_user_meta_data) values
  ('1c000000-0000-4000-8000-0000000000f1', 'platform-admin@pgtap.test', '{}'::jsonb),
  ('1c000000-0000-4000-8000-0000000000f2', 'platform-admin-two@pgtap.test', '{}'::jsonb),
  ('1c000000-0000-4000-8000-0000000000a1', 'platform-owner-a@pgtap.test', '{}'::jsonb),
  ('1c000000-0000-4000-8000-0000000000b1', 'platform-owner-b@pgtap.test', '{}'::jsonb);

insert into public.platform_admins (user_id) values
  ('1c000000-0000-4000-8000-0000000000f1'),
  ('1c000000-0000-4000-8000-0000000000f2');

insert into public.garages (id, slug, name, booking_prefix, plan, status) values
  ('ac000000-0000-4000-8000-000000000001', 'pgtap-platform-a', 'Platform Garage A', 'PGA', 'pro', 'active'),
  ('bc000000-0000-4000-8000-000000000001', 'pgtap-platform-b', 'Platform Garage B', 'PGB', 'essentials', 'onboarding');

insert into public.garage_members (garage_id, user_id, role) values
  ('ac000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000a1', 'owner'),
  ('bc000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000b1', 'owner');

insert into public.customers (id, garage_id, name, phone, preferred_contact) values
  ('6c000000-0000-4000-8000-00000000000a', 'ac000000-0000-4000-8000-000000000001', 'Customer of A', '+447700900301', 'phone'),
  ('6c000000-0000-4000-8000-00000000000b', 'bc000000-0000-4000-8000-000000000001', 'Customer of B', '+447700900302', 'phone');

insert into public.jobs (id, kind, garage_id, status, attempts, max_attempts, finished_at, last_error) values
  ('3c000000-0000-4000-8000-000000000001', 'pgtap.platform', 'ac000000-0000-4000-8000-000000000001', 'failed', 5, 5, now(), 'PROVIDER_DOWN');
insert into public.jobs (id, kind, status, attempts, locked_until) values
  ('3c000000-0000-4000-8000-000000000002', 'pgtap.platform', 'running', 1, now() - interval '1 minute');

create function pg_temp.act_as(p_user uuid, p_garage uuid, p_aal text default 'aal2')
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text end, true);
  perform set_config('request.headers',
    case when p_garage is null then '{}' else jsonb_build_object('x-garage-id', p_garage)::text end, true);
end
$$;

-- ---------------------------------------------------------------------------
-- Structure and privileges
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.platform_audit_log'::regclass), 'platform_audit_log has RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.platform_impersonations'::regclass), 'platform_impersonations has RLS on');
select ok(not has_table_privilege('authenticated', 'public.platform_audit_log', 'select,insert,update,delete'), 'staff hold nothing on platform_audit_log');
select ok(not has_table_privilege('authenticated', 'public.platform_impersonations', 'select,insert,update,delete'), 'staff hold nothing on platform_impersonations');
select ok(not has_table_privilege('anon', 'public.platform_impersonations', 'select,insert,update,delete'), 'anon holds nothing on platform_impersonations');
select ok(not has_table_privilege('service_role', 'public.platform_audit_log', 'update,delete'), 'the platform audit log is append-only, even for the service role');
select ok(not has_function_privilege('anon', 'public.platform_garages(text,text,text,integer,integer)', 'execute'), 'anon cannot call platform functions');
select ok(not has_function_privilege('authenticated', 'public.impersonated_garage_id()', 'execute')
  and not has_function_privilege('authenticated', 'public.record_platform_action(text,uuid,text,text,text,jsonb)', 'execute'),
  'internal helpers are not callable through the API');
select ok(not has_function_privilege('authenticated', 'public.close_expired_impersonations()', 'execute'), 'closing expired sessions is service role only');

-- ---------------------------------------------------------------------------
-- Access: platform admins at AAL2 only
-- ---------------------------------------------------------------------------

set local role authenticated;

select pg_temp.act_as('1c000000-0000-4000-8000-0000000000a1', 'ac000000-0000-4000-8000-000000000001');
select throws_ok($$select * from public.platform_garages()$$, '42501', 'PLATFORM_ADMIN_REQUIRED', 'a garage owner cannot list garages');
select throws_ok($$select public.platform_job_health()$$, '42501', 'PLATFORM_ADMIN_REQUIRED', 'a garage owner cannot read job health');
select throws_ok($$select * from public.platform_start_impersonation('bc000000-0000-4000-8000-000000000001', 'Looking around', 30)$$,
  '42501', 'PLATFORM_ADMIN_REQUIRED', 'a garage owner cannot impersonate another garage');
select throws_ok($$select public.platform_end_impersonation()$$, '42501', 'PLATFORM_ADMIN_REQUIRED', 'a garage owner has nothing to end');
select is((select count(*)::integer from public.current_impersonation()), 0, 'a garage owner has no impersonation');

select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', null, 'aal1');
select throws_ok($$select * from public.platform_garages()$$, '42501', 'PLATFORM_ADMIN_REQUIRED', 'a platform admin without MFA this session is refused');

select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', null);
select ok((select count(*) from public.platform_garages(p_search => 'pgtap-platform')) = 2, 'a platform admin at AAL2 sees every garage');
select is((select array_agg(slug order by slug) from public.platform_garages(p_search => 'PLATFORM GARAGE', p_status => 'onboarding')),
  array['pgtap-platform-b'], 'search is case-insensitive and filters by status');
select is((select count(*)::integer from public.platform_garages(p_search => '%')), 0, 'search wildcards are literal');
select is((select member_count from public.platform_garages(p_search => 'pgtap-platform-a')), 1, 'the list counts members');
select throws_ok($$select * from public.platform_garages(p_plan => 'gold')$$, '22023', 'INVALID_PLAN', 'unknown plans are refused');
select is(public.platform_garage('ac000000-0000-4000-8000-000000000001') ->> 'slug', 'pgtap-platform-a', 'garage detail');

-- ---------------------------------------------------------------------------
-- Plan and status changes
-- ---------------------------------------------------------------------------

select throws_ok($$select public.platform_update_garage('ac000000-0000-4000-8000-000000000001', 'essentials', null, ' ')$$,
  '22023', null, 'a reason is required');
select is(public.platform_update_garage('ac000000-0000-4000-8000-000000000001', 'essentials', 'cancelled', 'Customer asked to close the account') ->> 'status',
  'cancelled', 'plan and status change together');

reset role;
select ok((select cancelled_at is not null and plan = 'essentials' from public.garages where id = 'ac000000-0000-4000-8000-000000000001'),
  'cancelling sets cancelled_at');
select is(
  (select array_agg(action order by action) from public.admin_audit_log where garage_id = 'ac000000-0000-4000-8000-000000000001' and action like 'platform.garage_%'),
  array['platform.garage_plan_changed', 'platform.garage_status_changed'], 'each change is in the garage''s own audit log');
select is(
  (select detail ->> 'reason' from public.admin_audit_log where garage_id = 'ac000000-0000-4000-8000-000000000001' and action = 'platform.garage_status_changed'),
  'Customer asked to close the account', 'the garage''s log carries the reason');
select is((select count(*)::integer from public.platform_audit_log where target_garage_id = 'ac000000-0000-4000-8000-000000000001'), 2,
  'and the platform log has both');

set local role authenticated;
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', null);
select is(public.platform_update_garage('ac000000-0000-4000-8000-000000000001', null, 'active', 'Reopened after call') ->> 'cancelled_at',
  null, 'leaving cancelled clears cancelled_at');

-- ---------------------------------------------------------------------------
-- Impersonation
-- ---------------------------------------------------------------------------

select throws_ok($$select * from public.platform_start_impersonation('ac000000-0000-4000-8000-000000000001', 'Help', 30)$$,
  '22023', null, 'impersonation needs a real reason');
select throws_ok($$select * from public.platform_start_impersonation('ac000000-0000-4000-8000-000000000001', 'Support ticket 42', 240)$$,
  '22023', null, 'sessions last at most 60 minutes');
select is((select garage_name from public.platform_start_impersonation('bc000000-0000-4000-8000-000000000001', 'Support ticket 41', 30)),
  'Platform Garage B', 'a session starts');
select is((select garage_name from public.platform_start_impersonation('ac000000-0000-4000-8000-000000000001', 'Support ticket 42', 30)),
  'Platform Garage A', 'a second start replaces the first');
select is((select garage_id from public.current_impersonation()), 'ac000000-0000-4000-8000-000000000001'::uuid, 'only the newest session is open');

-- Read-only transaction (PostgREST GET / stable RPC): the impersonated garage only.
savepoint read_only;
set local transaction_read_only = on;
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', 'ac000000-0000-4000-8000-000000000001');
select is(public.current_garage_id(), 'ac000000-0000-4000-8000-000000000001'::uuid, 'read-only: the impersonated garage is the selected garage');
select is(public.current_garage_role(), 'owner', 'read-only: it reads as owner');
select is((select array_agg(name) from public.customers), array['Customer of A'], 'read-only: RLS shows that garage''s rows');
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', 'bc000000-0000-4000-8000-000000000001');
select is(public.current_garage_id(), null::uuid, 'read-only: any other garage is refused');
select is((select count(*)::integer from public.customers), 0, 'read-only: no rows from another garage');
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', 'ac000000-0000-4000-8000-000000000001', 'aal1');
select is(public.current_garage_id(), null::uuid, 'read-only: without AAL2 the session is ignored');
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f2', 'ac000000-0000-4000-8000-000000000001');
select is(public.current_garage_id(), null::uuid, 'read-only: another platform admin gets nothing from this session');
rollback to savepoint read_only;

-- Read-write transaction: impersonation never applies, so writes are refused.
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', 'ac000000-0000-4000-8000-000000000001');
select is(public.current_garage_id(), null::uuid, 'read-write: impersonation does not apply');
select throws_ok($$insert into public.customers (garage_id, name, phone, preferred_contact)
  values ('ac000000-0000-4000-8000-000000000001', 'Written by support', '+447700900303', 'phone')$$,
  '42501', null, 'read-write: an impersonating admin cannot insert');
with changed as (update public.customers set name = 'Tampered' returning 1)
select is((select count(*)::integer from changed), 0, 'read-write: an impersonating admin updates nothing');

-- Logging.
select ok(public.log_impersonation_event('platform.impersonation_page_view', '/app/customers?q=AB12CDE'), 'a page view is logged');
select throws_ok($$select public.log_impersonation_event('platform.anything', '/app')$$, '22023', null, 'only known events are logged');

-- Expiry.
reset role;
update public.platform_impersonations set started_at = now() - interval '40 minutes', expires_at = now() - interval '1 minute'
where admin_user_id = '1c000000-0000-4000-8000-0000000000f1' and ended_at is null;
set local role authenticated;
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', 'ac000000-0000-4000-8000-000000000001');
savepoint expired;
set local transaction_read_only = on;
select is(public.current_garage_id(), null::uuid, 'an expired session admits nothing');
rollback to savepoint expired;
select is((select count(*)::integer from public.current_impersonation()), 0, 'an expired session is not current');
select ok(not public.platform_end_impersonation(), 'ending closes the expired session (nothing left open)');

reset role;
select is(
  (select array_agg(action order by id) from public.admin_audit_log
   where garage_id = 'ac000000-0000-4000-8000-000000000001' and action like 'platform.impersonation_%'),
  array['platform.impersonation_started', 'platform.impersonation_page_view', 'platform.impersonation_expired'],
  'garage A''s owners see start, page view and expiry'
);
select is(
  (select detail ->> 'path' from public.admin_audit_log where garage_id = 'ac000000-0000-4000-8000-000000000001' and action = 'platform.impersonation_page_view'),
  '/app/customers', 'page views keep the path only, never the query string'
);
select is(
  (select array_agg(end_reason order by end_reason desc) from public.platform_impersonations where admin_user_id = '1c000000-0000-4000-8000-0000000000f1'),
  array['replaced', 'expired'], 'sessions record how they ended'
);

-- ---------------------------------------------------------------------------
-- Job queue health
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000f1', null);
select ok(
  (select bool_or(failure ->> 'id' = '3c000000-0000-4000-8000-000000000001') from jsonb_array_elements(public.platform_job_health() -> 'recent_failures') failure),
  'job health lists failed jobs'
);
select ok(
  (select bool_or(job ->> 'id' = '3c000000-0000-4000-8000-000000000002') from jsonb_array_elements(public.platform_job_health() -> 'expired_locks') job),
  'job health lists running jobs with expired locks'
);
select ok(public.platform_retry_job('3c000000-0000-4000-8000-000000000001', 'Provider back up'), 'a failed job is retried');
select ok(not public.platform_retry_job('3c000000-0000-4000-8000-000000000002', 'Provider back up'), 'only failed jobs can be retried');

reset role;
select is((select status || ':' || attempts from public.jobs where id = '3c000000-0000-4000-8000-000000000001'), 'queued:0', 'the job is queued with fresh attempts');

select * from finish();
rollback;
