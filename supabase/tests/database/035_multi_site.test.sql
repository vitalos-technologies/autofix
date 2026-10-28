begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(54);

-- P5.9 multi-site: garage_groups, garage_group_sites, group_summary(),
-- group_overview(), group_report(), group_add_site(), group_remove_site(),
-- record_group_extra_sites() and the plan sync trigger.
--
-- Garages: H (home of Olu's group, paid Pro; manager Mia, technician Tom),
-- Z (home of Zara's group, paid Pro), E (Essentials, owner Eve).

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('17350000-0000-4000-8000-0000000000a1', 'group-owner@pgtap.test', now(), '{}'::jsonb),
  ('17350000-0000-4000-8000-0000000000a2', 'group-manager@pgtap.test', now(), '{}'::jsonb),
  ('17350000-0000-4000-8000-0000000000a3', 'group-tech@pgtap.test', now(), '{}'::jsonb),
  ('17350000-0000-4000-8000-0000000000b1', 'group-other@pgtap.test', now(), '{}'::jsonb),
  ('17350000-0000-4000-8000-0000000000c1', 'group-essentials@pgtap.test', now(), '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen) values
  ('a1735000-0000-4000-8000-000000000001', 'pgtap-group-h', 'Group Home', 'GRH', 'active', 'pro', null, 'pro'),
  ('a1735000-0000-4000-8000-000000000002', 'pgtap-group-z', 'Zara Motors', 'GRZ', 'active', 'pro', null, 'pro'),
  ('a1735000-0000-4000-8000-000000000003', 'pgtap-group-e', 'Eve Essentials', 'GRE', 'active', 'essentials', null, 'essentials');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1735000-0000-4000-8000-000000000001', '17350000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1735000-0000-4000-8000-000000000001', '17350000-0000-4000-8000-0000000000a2', 'manager'),
  ('a1735000-0000-4000-8000-000000000001', '17350000-0000-4000-8000-0000000000a3', 'technician'),
  ('a1735000-0000-4000-8000-000000000002', '17350000-0000-4000-8000-0000000000b1', 'owner'),
  ('a1735000-0000-4000-8000-000000000003', '17350000-0000-4000-8000-0000000000c1', 'owner');

create function pg_temp.h() returns uuid language sql as $$ select 'a1735000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.z() returns uuid language sql as $$ select 'a1735000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a1735000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.olu() returns uuid language sql as $$ select '17350000-0000-4000-8000-0000000000a1'::uuid $$;
create function pg_temp.mia() returns uuid language sql as $$ select '17350000-0000-4000-8000-0000000000a2'::uuid $$;
create function pg_temp.tom() returns uuid language sql as $$ select '17350000-0000-4000-8000-0000000000a3'::uuid $$;
create function pg_temp.zara() returns uuid language sql as $$ select '17350000-0000-4000-8000-0000000000b1'::uuid $$;
create function pg_temp.eve() returns uuid language sql as $$ select '17350000-0000-4000-8000-0000000000c1'::uuid $$;
create function pg_temp.slug_id(p_slug text) returns uuid language sql security definer as $$ select id from public.garages where slug = p_slug $$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;
create function pg_temp.site(p_name text, p_slug text) returns jsonb language sql as $$
  select jsonb_build_object('name', p_name, 'slug', p_slug, 'phone', '+441302123456', 'address',
                            jsonb_build_object('line1', '1 Test Street', 'town', 'Doncaster', 'postcode', 'DN1 1AA'))
$$;

-- Fixtures written past triggers and foreign keys (create_booking() and the
-- invoicing flow are covered elsewhere): at H, one confirmed booking today,
-- one open request, one cancelled booking, and an issued invoice this month.
set local session_replication_role = replica;
insert into public.bookings (garage_id, reference, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, cancelled_at) values
  (pg_temp.h(), 'GRH-0001', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
   '2096-06-15 09:00+00', '2096-06-15 10:00+00', tstzrange('2096-06-15 09:00+00', '2096-06-15 10:00+00', '[)'), 'confirmed', null),
  (pg_temp.h(), 'GRH-0002', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
   '2096-06-16 09:00+00', '2096-06-16 10:00+00', tstzrange('2096-06-16 09:00+00', '2096-06-16 10:00+00', '[)'), 'requested', null),
  (pg_temp.h(), 'GRH-0003', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
   '2096-06-15 11:00+00', '2096-06-15 12:00+00', tstzrange('2096-06-15 11:00+00', '2096-06-15 12:00+00', '[)'), 'cancelled', now()),
  (pg_temp.z(), 'GRZ-0001', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
   '2096-06-15 09:00+00', '2096-06-15 10:00+00', tstzrange('2096-06-15 09:00+00', '2096-06-15 10:00+00', '[)'), 'confirmed', null);
insert into public.invoices (garage_id, status, source_type, customer_name, subtotal_pence, total_pence, issue_date, issued_at, paid_at,
  payment_method, voided_at, invoice_number, invoice_year, invoice_sequence, created_by, updated_by,
  issuer_legal_name, issuer_trading_name, issuer_tagline, issuer_address, issuer_email, issuer_phone, issuer_company_number) values
  (pg_temp.h(), 'issued', 'manual', 'Group revenue', 12000, 12000, '2096-06-10', '2096-06-10 12:00+00', null, null, null, 'GRH-2096-000001', 2096, 1,
   pg_temp.olu(), pg_temp.olu(), 'L', 'T', '', 'A', 'e@x.test', '0', '1'),
  (pg_temp.h(), 'void', 'manual', 'Voided', 99900, 99900, '2096-06-11', '2096-06-11 12:00+00', null, null, '2096-06-12 12:00+00', 'GRH-2096-000002', 2096, 2,
   pg_temp.olu(), pg_temp.olu(), 'L', 'T', '', 'A', 'e@x.test', '0', '1'),
  (pg_temp.z(), 'paid', 'manual', 'Other group', 50000, 50000, '2096-06-10', '2096-06-10 12:00+00', '2096-06-11 12:00+00', 'card', null, 'GRZ-2096-000001', 2096, 1,
   pg_temp.zara(), pg_temp.zara(), 'L', 'T', '', 'A', 'e@x.test', '0', '1');
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from pg_class
           where relnamespace = 'public'::regnamespace and relname in ('garage_groups', 'garage_group_sites') and relrowsecurity),
          2, 'both group tables have RLS on');
select is((select count(*)::integer from unnest(array['garage_groups', 'garage_group_sites']) t(name)
           where has_table_privilege('authenticated', 'public.' || t.name, 'insert')
              or has_table_privilege('authenticated', 'public.' || t.name, 'update')
              or has_table_privilege('authenticated', 'public.' || t.name, 'delete')), 0, 'staff write neither directly');
select is((select count(*)::integer from unnest(array['garage_groups', 'garage_group_sites']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select')), 0, 'anon reads neither');
select is((select count(*)::integer from unnest(array['public.record_group_extra_sites(uuid, text)', 'public.garage_group_home(uuid)',
                                                       'public.group_visible_sites()']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')),
          0, 'internal and billing helpers are not callable by staff');
select is((select count(*)::integer from unnest(array['public.group_summary()', 'public.group_overview(timestamptz)', 'public.group_report(date, date)',
                                                       'public.group_add_site(jsonb)', 'public.group_remove_site(uuid)']) f(name)
           where has_function_privilege('anon', f.name, 'execute')), 0, 'anon calls no group function');
select is((select count(*)::integer from pg_proc
           where oid in ('public.group_summary()'::regprocedure, 'public.group_overview(timestamptz)'::regprocedure,
                         'public.group_report(date, date)'::regprocedure, 'public.group_add_site(jsonb)'::regprocedure,
                         'public.group_remove_site(uuid)'::regprocedure, 'public.record_group_extra_sites(uuid, text)'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 6, 'group functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Plan gating: Essentials is refused
-- ---------------------------------------------------------------------------

select pg_temp.as_member(pg_temp.eve(), pg_temp.e());
set local role authenticated;
select throws_ok($$select public.group_add_site(pg_temp.site('Eve Two', 'pgtap-group-e2'))$$, 'P0001', 'PLAN_REQUIRED: multi_site',
                 'an Essentials owner cannot add a site');
select throws_ok($$select * from public.group_overview()$$, 'P0001', 'PLAN_REQUIRED: multi_site', 'an Essentials owner gets no group overview');
select throws_ok($$select * from public.group_report('2096-06-01', '2096-06-30')$$, 'P0001', 'PLAN_REQUIRED: multi_site',
                 'an Essentials owner gets no group report');
select is((select multi_site::text || ':' || can_add_sites::text || ':' || (group_id is null)::text from public.group_summary()),
          'false:false:true', 'the summary still works on Essentials (for the locked page)');
reset role;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

select pg_temp.as_member(pg_temp.tom(), pg_temp.h());
set local role authenticated;
select throws_ok($$select public.group_add_site(pg_temp.site('Tom Site', 'pgtap-group-tom'))$$, '42501', null, 'a technician cannot add a site');
select throws_ok($$select * from public.group_overview()$$, '42501', null, 'a technician gets no group overview');
reset role;
select pg_temp.as_member(pg_temp.mia(), pg_temp.h());
set local role authenticated;
select throws_ok($$select public.group_add_site(pg_temp.site('Mia Site', 'pgtap-group-mia'))$$, '42501', null, 'a manager cannot add a site');
reset role;

-- ---------------------------------------------------------------------------
-- Adding sites
-- ---------------------------------------------------------------------------

select pg_temp.as_member(pg_temp.olu(), pg_temp.h());
set local role authenticated;
select is((select (public.group_add_site(pg_temp.site('Group North', 'pgtap-group-north'))) ->> 'extra_sites'), '1',
          'the owner adds a site: one extra site');
reset role;
select is((select count(*)::integer from public.garage_groups where garage_id = pg_temp.h()), 1, 'the group is created on the home garage');
select is((select count(*)::integer from public.garage_group_sites where home_garage_id = pg_temp.h()), 2, 'home and new site are in the group');
select is((select plan || ':' || coalesce(plan_chosen, '-') || ':' || (trial_ends_at is null)::text from public.garages where slug = 'pgtap-group-north'),
          'pro:pro:true', 'the new site takes the group''s plan, not a trial');
select is((select role from public.garage_members where garage_id = pg_temp.slug_id('pgtap-group-north') and user_id = pg_temp.olu()),
          'owner', 'the owner owns the new site');
select ok((select count(*) from public.services where garage_id = pg_temp.slug_id('pgtap-group-north')) > 0, 'the new site has default services');
select is((select count(*)::integer from public.admin_audit_log where garage_id = pg_temp.h() and action = 'group.site_added'), 1,
          'adding a site is audited on the home garage');

-- From a non-home site the new garage still joins the home garage's group.
select pg_temp.as_member(pg_temp.olu(), pg_temp.slug_id('pgtap-group-north'));
set local role authenticated;
select is((select (public.group_add_site(pg_temp.site('Group South', 'pgtap-group-south'))) ->> 'home_garage_id'),
          'a1735000-0000-4000-8000-000000000001', 'a site added from another site joins the same group');
select is((select site_count::text || ':' || is_home::text from public.group_summary()), '3:false', 'the summary from a site counts the group');
select is((select count(*)::integer from public.garage_group_sites), 1, 'RLS: a member reads only the selected garage''s site row');
reset role;

-- The other group.
select pg_temp.as_member(pg_temp.zara(), pg_temp.z());
set local role authenticated;
select is((select (public.group_add_site(pg_temp.site('Zara Two', 'pgtap-group-z2'))) ->> 'site_count'), '2', 'another owner starts their own group');
select is((select count(*)::integer from public.group_overview('2096-06-15 12:00+00')
           where garage_id in (pg_temp.h(), pg_temp.slug_id('pgtap-group-north'), pg_temp.slug_id('pgtap-group-south'))),
          0, 'cross-group: the other owner sees none of our sites');
select is((select count(*)::integer from public.group_overview('2096-06-15 12:00+00')), 2, 'they see their own two sites');
reset role;

-- ---------------------------------------------------------------------------
-- Overview and report
-- ---------------------------------------------------------------------------

select pg_temp.as_member(pg_temp.olu(), pg_temp.h());
set local role authenticated;
select is((select count(*)::integer from public.group_overview('2096-06-15 12:00+00')), 3, 'the owner sees all three sites');
select is((select count(*)::integer from public.group_overview('2096-06-15 12:00+00') where garage_id in (pg_temp.z(), pg_temp.slug_id('pgtap-group-z2'))),
          0, 'cross-group: none of the other group''s sites');
select is((select today_bookings || ':' || open_requests || ':' || revenue_month_pence || ':' || is_home::text || ':' || is_selected::text
           from public.group_overview('2096-06-15 12:00+00') where garage_id = pg_temp.h()),
          '1:1:12000:true:true', 'home: one car today, one request, £120 this month (void and cancelled left out)');
select is((select today_bookings + open_requests + revenue_month_pence + won_back_bookings
           from public.group_overview('2096-06-15 12:00+00') where garage_id = pg_temp.slug_id('pgtap-group-north')),
          0::bigint, 'a new site starts at zero');
select is((select bookings || ':' || revenue_pence from public.group_report('2096-06-01', '2096-06-30') where garage_id = pg_temp.h()),
          '1:12000', 'report: bookings and revenue for the home garage');
select is((select count(*)::integer from public.group_report('2096-06-01', '2096-06-30')), 3, 'report: one row per site');
select throws_ok($$select * from public.group_report('2096-06-30', '2096-06-01')$$, '22023', null, 'report: from after to is refused');
select throws_ok($$select * from public.group_report('2095-01-01', '2096-06-30')$$, '22023', null, 'report: more than 366 days is refused');
select is((select count(*)::integer from public.garage_groups where garage_id = pg_temp.z()), 0, 'RLS: the other group''s row is not readable');
reset role;

-- Forged header: the selected garage must be one the caller belongs to.
select pg_temp.as_member(pg_temp.olu(), pg_temp.z());
set local role authenticated;
select throws_ok($$select * from public.group_overview()$$, '42501', null, 'forging x-garage-id of another group is refused');
select throws_ok($$select public.group_remove_site('a1735000-0000-4000-8000-000000000001')$$, '42501', null,
                 'forging x-garage-id cannot remove sites');
reset role;

-- A manager of the home garage only: aggregates only the garages they manage.
select pg_temp.as_member(pg_temp.mia(), pg_temp.h());
set local role authenticated;
select is((select count(*)::integer from public.group_overview('2096-06-15 12:00+00')), 1, 'a manager of one site sees only that site');
select is((select site_count::text || ':' || visible_sites::text || ':' || can_add_sites::text from public.group_summary()),
          '3:1:false', 'the summary tells them the group is bigger');
reset role;

-- ---------------------------------------------------------------------------
-- Plan follows the home garage
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.apply_billing_subscription(pg_temp.h(), 'mock', null, null, 'cancelled', 'essentials') ->> 'plan', 'essentials',
          'the home garage drops to Essentials');
reset role;
select is((select count(*)::integer from public.garages where slug in ('pgtap-group-north', 'pgtap-group-south') and plan = 'essentials'
             and plan_chosen = 'essentials'), 2, 'every site follows the home garage');
select pg_temp.as_member(pg_temp.olu(), pg_temp.slug_id('pgtap-group-north'));
set local role authenticated;
select throws_ok($$select * from public.group_overview()$$, 'P0001', 'PLAN_REQUIRED: multi_site', 'no overview once the group is on Essentials');
reset role;
set local role service_role;
select is(public.apply_billing_subscription(pg_temp.h(), 'mock', null, null, 'active', 'pro') ->> 'plan', 'pro', 'back on Pro');
reset role;
select is((select count(*)::integer from public.garages where slug in ('pgtap-group-north', 'pgtap-group-south') and plan = 'pro'), 2,
          'the sites follow back to Pro');

-- ---------------------------------------------------------------------------
-- Extra sites and removal
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.record_group_extra_sites(pg_temp.h(), 'mock'), 2, 'two sites beyond the first');
reset role;
select is((select extra_sites from public.garage_subscriptions where garage_id = pg_temp.h()), 2, 'recorded on the home subscription');

select pg_temp.as_member(pg_temp.olu(), pg_temp.h());
set local role authenticated;
select throws_ok($$select public.group_remove_site('a1735000-0000-4000-8000-000000000001')$$, 'P0001', 'GROUP_HOME_SITE',
                 'the home garage cannot leave its group');
select throws_ok($$select public.group_remove_site('a1735000-0000-4000-8000-000000000002')$$, '42501', null,
                 'cross-group: another group''s garage cannot be removed');
select is((select (public.group_remove_site(pg_temp.slug_id('pgtap-group-south'))) ->> 'extra_sites'), '1', 'removing a site lowers the count');
reset role;
select is((select plan || ':' || coalesce(plan_chosen, '-') from public.garages where slug = 'pgtap-group-south'), 'essentials:essentials',
          'the removed site drops to Essentials');
select is((select role from public.garage_members where garage_id = pg_temp.slug_id('pgtap-group-south') and user_id = pg_temp.olu()),
          'owner', 'the removed site and its owner stay');
set local role service_role;
select is(public.record_group_extra_sites(pg_temp.h(), 'mock'), 1, 'the recorded count goes down');
reset role;
update public.garages set trial_ends_at = now() + interval '5 days' where id = pg_temp.h();
select is((select (trial_ends_at is null)::text from public.garages where slug = 'pgtap-group-north'),
          'false', 'the remaining site follows the home garage');
select is((select (trial_ends_at is null)::text || ':' || plan from public.garages where slug = 'pgtap-group-south'), 'true:essentials',
          'a removed site no longer follows the group plan');

select * from finish();
rollback;
