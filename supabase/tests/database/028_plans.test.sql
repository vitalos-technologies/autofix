begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(51);

-- P5.2 plans: garage_effective_plan(), plan_feature_plan(), garage_has_feature(),
-- require_garage_feature(), expire_plan_trials(), request_plan_change(),
-- choose_essentials(), apply_billing_subscription(), record_usage(),
-- garage_usage_month(), close_usage_month().
--
-- Garages: T on a running Pro trial (owner Tia, technician Tom), X on an
-- expired, unchosen trial, E on Essentials, P on paid Pro (chose Pro with an
-- expired trial date), C on an expired trial that chose Pro.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17280000-0000-4000-8000-0000000000a1', 'plans-owner@pgtap.test', '{}'::jsonb),
  ('17280000-0000-4000-8000-0000000000a2', 'plans-tech@pgtap.test', '{}'::jsonb),
  ('17280000-0000-4000-8000-0000000000b1', 'plans-other@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status) values
  ('a1728000-0000-4000-8000-000000000001', 'pgtap-plans-t', 'Plans Trial', 'PLT', 'active');
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen) values
  ('a1728000-0000-4000-8000-000000000002', 'pgtap-plans-x', 'Plans Expired', 'PLX', 'active', 'pro', now() - interval '1 day', null),
  ('a1728000-0000-4000-8000-000000000003', 'pgtap-plans-e', 'Plans Essentials', 'PLE', 'active', 'essentials', null, 'essentials'),
  ('a1728000-0000-4000-8000-000000000004', 'pgtap-plans-p', 'Plans Pro', 'PLP', 'active', 'pro', null, 'pro'),
  ('a1728000-0000-4000-8000-000000000005', 'pgtap-plans-c', 'Plans Chosen', 'PLC', 'active', 'pro', now() - interval '1 hour', 'pro');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1728000-0000-4000-8000-000000000001', '17280000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1728000-0000-4000-8000-000000000001', '17280000-0000-4000-8000-0000000000a2', 'technician'),
  ('a1728000-0000-4000-8000-000000000003', '17280000-0000-4000-8000-0000000000b1', 'owner');

create function pg_temp.t() returns uuid language sql as $$ select 'a1728000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.x() returns uuid language sql as $$ select 'a1728000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a1728000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.p() returns uuid language sql as $$ select 'a1728000-0000-4000-8000-000000000004'::uuid $$;
create function pg_temp.c() returns uuid language sql as $$ select 'a1728000-0000-4000-8000-000000000005'::uuid $$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

select is((select column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'garages' and column_name = 'plan'),
          '''pro''::text', 'new garages start on Pro');
select ok((select trial_ends_at between now() + interval '1 month' - interval '1 minute' and now() + interval '1 month' + interval '1 minute'
           from public.garages where id = pg_temp.t()), 'new garages get a one-month trial (D25)');
select throws_ok($$update public.garages set plan = 'growth' where id = 'a1728000-0000-4000-8000-000000000001'$$,
                 '23514', null, 'old plan names are refused');
select throws_ok($$update public.garages set plan = 'trial' where id = 'a1728000-0000-4000-8000-000000000001'$$,
                 '23514', null, 'trial is not a plan any more');
select is((select count(*)::integer from unnest(array['garage_subscriptions', 'plan_requests', 'usage_events', 'billing_usage_reports']) t(name)
           join pg_class rel on rel.relname = t.name and rel.relnamespace = 'public'::regnamespace
           where rel.relrowsecurity), 4, 'the tenant plan tables have RLS on');
select is((select count(*)::integer from unnest(array['garage_subscriptions', 'plan_requests', 'usage_events', 'billing_usage_reports']) t(name)
           where has_table_privilege('authenticated', 'public.' || t.name, 'insert')
              or has_table_privilege('authenticated', 'public.' || t.name, 'update')
              or has_table_privilege('authenticated', 'public.' || t.name, 'delete')), 0, 'staff write none of them directly');
select is((select count(*)::integer from unnest(array['garage_subscriptions', 'plan_requests', 'usage_events', 'billing_usage_reports', 'billing_webhook_events']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select')), 0, 'anon reads none of them');
select is(has_table_privilege('authenticated', 'public.billing_webhook_events', 'select'), false, 'billing webhook events are service role only');
select is((select count(*)::integer from unnest(array[
             'public.garage_effective_plan(uuid)', 'public.expire_plan_trials(timestamptz)',
             'public.apply_billing_subscription(uuid, text, text, text, text, text, timestamptz, integer, boolean)',
             'public.record_usage(uuid, text, numeric, text, timestamptz)', 'public.close_usage_month(uuid, date, text, numeric)',
             'public.claim_billing_webhook_event(text, text, text)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')),
          0, 'billing, metering and expiry functions are service role only');
select is((select count(*)::integer from pg_proc
           where oid in ('public.garage_has_feature(uuid, text)'::regprocedure, 'public.garage_effective_plan(uuid)'::regprocedure,
                         'public.request_plan_change(text, text)'::regprocedure, 'public.record_usage(uuid, text, numeric, text, timestamptz)'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 4, 'helpers are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Entitlements
-- ---------------------------------------------------------------------------

select is(public.plan_feature_plan('reminders'), 'essentials', 'reminders are Essentials');
select is(public.plan_feature_plan('missed_calls'), 'essentials', 'missed-call text-back is Essentials');
select is(public.plan_feature_plan('invoices'), 'essentials', 'invoices and quotes are Essentials');
select is(public.plan_feature_plan('ai_front_desk'), 'pro', 'the AI front desk is Pro');
select is(public.plan_feature_plan('health_checks'), 'pro', 'health checks are Pro');
select throws_ok($$select public.plan_feature_plan('teleport')$$, '22023', 'UNKNOWN_FEATURE: teleport', 'unknown features raise');

select is(public.garage_effective_plan(pg_temp.t()), 'pro', 'a running trial is Pro');
select is(public.garage_effective_plan(pg_temp.x()), 'essentials', 'an expired, unchosen trial is Essentials at once');
select is(public.garage_effective_plan(pg_temp.c()), 'pro', 'an expired trial that chose Pro stays Pro');
select is(public.garage_effective_plan(pg_temp.e()), 'essentials', 'Essentials is Essentials');

set local role service_role;
select is(public.garage_has_feature(pg_temp.p(), 'campaigns'), true, 'paid Pro has campaigns');
select is(public.garage_has_feature(pg_temp.e(), 'campaigns'), false, 'Essentials has no campaigns');
select is(public.garage_has_feature(pg_temp.e(), 'reminders'), true, 'Essentials has reminders');
select is(public.garage_has_feature(pg_temp.x(), 'payments'), false, 'an expired trial has no payments');
select throws_ok($$select public.require_garage_feature('a1728000-0000-4000-8000-000000000003', 'payments')$$,
                 'P0001', 'PLAN_REQUIRED: payments', 'require_garage_feature raises PLAN_REQUIRED');
reset role;

select pg_temp.as_member('17280000-0000-4000-8000-0000000000a2', pg_temp.t());
set local role authenticated;
select is(public.garage_has_feature(pg_temp.t(), 'health_checks'), true, 'a member sees their trial garage has Pro');
select is(public.garage_has_feature(pg_temp.p(), 'health_checks'), false, 'members cannot probe other garages');

-- ---------------------------------------------------------------------------
-- Plan requests (owners only)
-- ---------------------------------------------------------------------------

select throws_ok($$select public.request_plan_change('pro', 'please')$$, '42501', null, 'a technician cannot request a plan');
reset role;
select pg_temp.as_member('17280000-0000-4000-8000-0000000000a1', pg_temp.t());
set local role authenticated;
select is((public.request_plan_change('pro', 'Want health checks')).status, 'open', 'the owner requests Pro');
select is((public.request_plan_change('pro', null)).note, null, 'a second request replaces the first');
select is((select count(*)::integer from public.plan_requests where status = 'open'), 1, 'one open request per garage');
select throws_ok($$select public.request_plan_change('gold', null)$$, '22023', 'INVALID_PLAN', 'unknown plans are refused');
select is((public.choose_essentials()) ->> 'plan', 'essentials', 'the owner moves to Essentials');
reset role;
select is((select plan || ':' || coalesce(plan_chosen, '-') || ':' || (trial_ends_at is null)::text from public.garages where id = pg_temp.t()),
          'essentials:essentials:true', 'choosing Essentials ends the trial');
select is((select count(*)::integer from public.plan_requests where garage_id = pg_temp.t() and status = 'open'), 0,
          'choosing Essentials withdraws the Pro request');

-- ---------------------------------------------------------------------------
-- Billing webhook state
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.apply_billing_subscription(pg_temp.t(), 'stripe', 'cus_test', 'sub_test', 'active', 'pro') ->> 'plan', 'pro',
          'an active Pro subscription makes the garage Pro');
select is((select plan_chosen from public.garages where id = pg_temp.t()), 'pro', 'and records Pro as chosen');
reset role;
select pg_temp.as_member('17280000-0000-4000-8000-0000000000a1', pg_temp.t());
set local role authenticated;
select throws_ok($$select public.choose_essentials()$$, 'P0001', 'BILLING_PORTAL_REQUIRED', 'a live subscription changes through the portal');
select is((select status from public.garage_subscriptions), 'active', 'the owner reads the subscription');
reset role;
set local role service_role;
select is(public.apply_billing_subscription(pg_temp.t(), 'stripe', null, 'sub_test', 'cancelled', 'pro') ->> 'plan', 'essentials',
          'a cancelled subscription drops to Essentials');
select is(public.claim_billing_webhook_event('evt_1', 'stripe', 'customer.subscription.updated'), true, 'a new event is claimed');
select is(public.claim_billing_webhook_event('evt_1', 'stripe', 'customer.subscription.updated'), false, 'a duplicate is not');

-- ---------------------------------------------------------------------------
-- Trial expiry
-- ---------------------------------------------------------------------------

select is(public.expire_plan_trials(now()), 2, 'expiry moves the two expired trials');
select is((select string_agg(plan, ',' order by slug) from public.garages where id in (pg_temp.x(), pg_temp.c())), 'pro,essentials',
          'the unchosen trial becomes Essentials, the chosen one stays Pro');
select is((select count(*)::integer from public.admin_audit_log where action = 'plan.trial_ended' and garage_id in (pg_temp.x(), pg_temp.c())), 2,
          'each expiry is audited');

-- ---------------------------------------------------------------------------
-- Usage
-- ---------------------------------------------------------------------------

select is(public.record_usage(pg_temp.e(), 'sms_segments', 2, 'msg:1', '2026-10-31T23:30:00Z'), true, 'usage is recorded');
select is(public.record_usage(pg_temp.e(), 'sms_segments', 2, 'msg:1', '2026-10-31T23:30:00Z'), false, 'the same source counts once');
select is((select period_month::text from public.usage_events where garage_id = pg_temp.e() and source_key = 'msg:1'), '2026-10-01',
          '23:30 UTC on 31 Oct is still October in London (GMT)');
select public.record_usage(pg_temp.e(), 'sms_segments', 3, 'msg:2', '2026-10-15T12:00:00Z');
select is((public.close_usage_month(pg_temp.e(), '2026-10-01', 'sms_segments', 4)).overage, 1.00::numeric(12, 2),
          'the month closes with the overage over the allowance');
select is((public.close_usage_month(pg_temp.e(), '2026-10-01', 'sms_segments', null)).status, 'not_billable',
          'no allowance set yet means not billable');
reset role;
select pg_temp.as_member('17280000-0000-4000-8000-0000000000b1', pg_temp.e());
set local role authenticated;
select is((select quantity from public.garage_usage_month('2026-10-01') where metric = 'sms_segments'), 5.00::numeric,
          'the owner reads the month''s usage');
reset role;

select * from finish();
rollback;
