begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(47);

-- ---------------------------------------------------------------------------
-- Structure: every table with garage_id is a tenant table
-- ---------------------------------------------------------------------------

-- jobs (P3.6) is the platform job queue: service role only, and its garage_id
-- is optional (platform-wide jobs have none), so it is exempt from the
-- not-null/default and select-policy rules but not from RLS.
select is(
  (select count(*)::integer
   from information_schema.columns column_info
   join pg_class class on class.relname = column_info.table_name and class.relnamespace = 'public'::regnamespace
   where column_info.table_schema = 'public'
     and column_info.column_name = 'garage_id'
     and ((column_info.table_name <> 'jobs'
           and (column_info.is_nullable <> 'NO' or column_info.column_default is distinct from 'current_garage_id()'))
          or not class.relrowsecurity)),
  0, 'every garage_id column is not null, defaults to current_garage_id() and sits on an RLS table (jobs: RLS only)'
);
select is(
  (select count(*)::integer
   from pg_class class
   join pg_attribute attribute on attribute.attrelid = class.oid and attribute.attname = 'garage_id'
   where class.relnamespace = 'public'::regnamespace and class.relkind = 'r'
     and not exists (select 1 from pg_index index_info where index_info.indrelid = class.oid and index_info.indkey[0] = attribute.attnum)),
  0, 'every tenant table has an index leading with garage_id'
);
select is(
  (select count(*)::integer
   from pg_class class
   join pg_attribute attribute on attribute.attrelid = class.oid and attribute.attname = 'garage_id'
   where class.relnamespace = 'public'::regnamespace and class.relkind = 'r'
     and not exists (
       select 1 from pg_constraint constraint_info
       where constraint_info.conrelid = class.oid
         and constraint_info.contype = 'f'
         and constraint_info.confrelid = 'public.garages'::regclass
         and constraint_info.confdeltype = 'c'
     )),
  0, 'every tenant table references garages with on delete cascade'
);
select is(
  (select count(*)::integer
   from pg_policies policy
   where policy.schemaname = 'public'
     and policy.tablename in (select table_name from information_schema.columns where table_schema = 'public' and column_name = 'garage_id')
     and policy.tablename <> 'garage_members'
     and coalesce(policy.qual, '') || coalesce(policy.with_check, '') !~ 'current_garage_id\(\)'),
  0, 'every tenant policy is scoped to the selected garage'
);
select is(
  (select count(*)::integer
   from information_schema.columns column_info
   where column_info.table_schema = 'public'
     and column_info.column_name = 'garage_id'
     and column_info.table_name not in ('invoice_number_sequences', 'jobs')
     and not exists (select 1 from pg_policies policy where policy.schemaname = 'public' and policy.tablename = column_info.table_name and policy.cmd in ('SELECT', 'ALL'))),
  0, 'every tenant table except invoice_number_sequences and jobs (service role only) has a select policy'
);
select is(
  (select count(*)::integer from pg_policies where schemaname in ('public', 'storage') and roles && array['anon', 'public']::name[]),
  0, 'no policy applies to anon or public'
);
select is(
  (select count(*)::integer
   from unnest(array['rate_limit_buckets', 'resend_webhook_events', 'inbound_email_events',
                     'admin_mfa_policy', 'admin_mfa_recovery_codes', 'admin_mfa_recovery_sessions', 'admin_trusted_devices',
                     'platform_admins', 'jobs', 'vehicle_facts']) as platform_table(name)
   where has_table_privilege('authenticated', 'public.' || platform_table.name, 'select')),
  0, 'service-role-only platform tables are not readable by signed-in users'
);

-- ---------------------------------------------------------------------------
-- Fixtures: garages A and B; A has an owner, a manager and a technician; one
-- user belongs to both garages.
-- ---------------------------------------------------------------------------

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17000000-0000-4000-8000-0000000000a1', 'core-owner-a@pgtap.test', '{}'::jsonb),
  ('17000000-0000-4000-8000-0000000000a2', 'core-manager-a@pgtap.test', '{}'::jsonb),
  ('17000000-0000-4000-8000-0000000000a3', 'core-tech-a@pgtap.test', '{}'::jsonb),
  ('17000000-0000-4000-8000-0000000000b1', 'core-owner-b@pgtap.test', '{}'::jsonb),
  ('17000000-0000-4000-8000-0000000000ab', 'core-both@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix, plan) values
  ('a7000000-0000-4000-8000-000000000001', 'pgtap-core-a', 'Core Garage A', 'CGA', 'growth'),
  ('b7000000-0000-4000-8000-000000000001', 'pgtap-core-b', 'Core Garage B', 'CGB', 'trial');

insert into public.garage_members (garage_id, user_id, role) values
  ('a7000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a7000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000a2', 'manager'),
  ('a7000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000a3', 'technician'),
  ('b7000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b1', 'owner'),
  ('a7000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000ab', 'technician'),
  ('b7000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000ab', 'manager');

insert into public.customers (id, garage_id, name, phone, preferred_contact) values
  ('67000000-0000-4000-8000-00000000000a', 'a7000000-0000-4000-8000-000000000001', 'Customer of A', '+447700900101', 'phone'),
  ('67000000-0000-4000-8000-00000000000b', 'b7000000-0000-4000-8000-000000000001', 'Customer of B', '+447700900102', 'phone');

create function pg_temp.act_as(p_user uuid, p_garage uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else jsonb_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
  perform set_config('request.headers',
    case when p_garage is null then '{}' else jsonb_build_object('x-garage-id', p_garage)::text end, true);
end
$$;

-- ---------------------------------------------------------------------------
-- Garages
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.garages (slug, name, booking_prefix) values ('Bad Slug', 'Bad', 'BAD')$$,
  '23514', null, 'garage slugs are lower-case kebab case'
);
select throws_ok(
  $$insert into public.garages (slug, name, booking_prefix, timezone) values ('bad-zone', 'Bad zone', 'BZ', 'Mars/Olympus')$$,
  '22023', 'INVALID_GARAGE_TIMEZONE', 'garage time zones must be real'
);

select pg_temp.act_as('17000000-0000-4000-8000-0000000000ab', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select count(*) from public.garages', array[2::bigint], 'a user in two garages can list both for the switcher');
select results_eq(
  'select garage_id from public.garage_members where user_id = auth.uid() order by garage_id',
  array['a7000000-0000-4000-8000-000000000001'::uuid, 'b7000000-0000-4000-8000-000000000001'::uuid],
  'a user can read their own memberships in every garage'
);
select results_eq('select name from public.customers', array['Customer of A'], 'but only the selected garage''s rows');
reset role;

select pg_temp.act_as('17000000-0000-4000-8000-0000000000b1', 'b7000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select slug from public.garages', array['pgtap-core-b'], 'owner B sees only garage B');
select results_eq('select count(*) from public.garage_members where garage_id = ''a7000000-0000-4000-8000-000000000001''', array[0::bigint], 'owner B cannot list garage A''s staff');
select results_eq(
  $$with changed as (update public.garages set name = 'Hijacked' where id = 'a7000000-0000-4000-8000-000000000001' returning 1) select count(*) from changed$$,
  array[0::bigint], 'owner B cannot rename garage A'
);
select throws_ok(
  $$update public.garages set plan = 'front_desk' where id = 'b7000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'owners cannot change their own plan'
);
select throws_ok(
  $$insert into public.garages (slug, name, booking_prefix) values ('self-made', 'Self made', 'SMG')$$,
  '42501', null, 'staff cannot create garages directly'
);
reset role;

select pg_temp.act_as('17000000-0000-4000-8000-0000000000a2', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq(
  $$with changed as (update public.garages set name = 'Manager rename' where id = 'a7000000-0000-4000-8000-000000000001' returning 1) select count(*) from changed$$,
  array[0::bigint], 'managers cannot update garage settings'
);
reset role;

select pg_temp.act_as('17000000-0000-4000-8000-0000000000a1', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq(
  $$with changed as (update public.garages set name = 'Core Garage A Renamed', accent = '#0a7a3d' where id = 'a7000000-0000-4000-8000-000000000001' returning 1) select count(*) from changed$$,
  array[1::bigint], 'owners update their garage''s settings'
);
reset role;

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------

select pg_temp.act_as('17000000-0000-4000-8000-0000000000a2', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$insert into public.garage_members (user_id, role) values ('17000000-0000-4000-8000-0000000000b1', 'technician')$$,
  '42501', null, 'managers cannot add members'
);
reset role;

select pg_temp.act_as('17000000-0000-4000-8000-0000000000b1', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$insert into public.garage_members (garage_id, user_id, role) values ('a7000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b1', 'owner')$$,
  '42501', null, 'owner B cannot make themselves an owner of garage A'
);
reset role;

select pg_temp.act_as('17000000-0000-4000-8000-0000000000a1', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok(
  $$update public.garage_members set role = 'manager' where user_id = '17000000-0000-4000-8000-0000000000a3' and garage_id = 'a7000000-0000-4000-8000-000000000001'$$,
  'owners change staff roles'
);
select throws_ok(
  $$update public.garage_members set role = 'manager' where user_id = '17000000-0000-4000-8000-0000000000a1'$$,
  '23514', 'GARAGE_NEEDS_AN_OWNER', 'the last owner cannot step down'
);
select throws_ok(
  $$delete from public.garage_members where user_id = '17000000-0000-4000-8000-0000000000a1'$$,
  '23514', 'GARAGE_NEEDS_AN_OWNER', 'the last owner cannot be removed'
);
select throws_ok(
  $$update public.garage_members set garage_id = 'b7000000-0000-4000-8000-000000000001' where user_id = '17000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'a membership cannot be moved to another garage'
);
reset role;

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------

select pg_temp.act_as('17000000-0000-4000-8000-0000000000a2', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok(
  $$insert into public.garage_domains (hostname) values ('book.core-a.example')$$,
  'managers add a custom domain'
);
select results_eq(
  $$select kind || '/' || status || '/' || garage_id::text from public.garage_domains$$,
  array['custom/pending_dns/a7000000-0000-4000-8000-000000000001'],
  'a new domain is custom, pending DNS and belongs to the selected garage'
);
select throws_ok(
  $$insert into public.garage_domains (hostname, status) values ('book2.core-a.example', 'active')$$,
  '42501', null, 'staff cannot mark a domain active'
);
reset role;

select pg_temp.act_as('17000000-0000-4000-8000-0000000000ab', 'b7000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$insert into public.garage_domains (hostname) values ('book.core-a.example')$$,
  '23505', null, 'a hostname belongs to one garage at a time'
);
reset role;

select pg_temp.act_as('17000000-0000-4000-8000-0000000000ab', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$insert into public.garage_domains (hostname) values ('book.tech-a.example')$$,
  '42501', null, 'technicians cannot add domains'
);
reset role;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

select pg_temp.act_as('17000000-0000-4000-8000-0000000000a2', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$insert into public.site_settings (value) values ('{"bookingNotice": "Manager"}')$$,
  '42501', null, 'managers cannot write garage settings'
);
reset role;

select pg_temp.act_as('17000000-0000-4000-8000-0000000000a1', 'a7000000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok(
  $$insert into public.site_settings (value) values ('{"bookingNotice": "Owner"}')$$,
  'owners write garage settings'
);
reset role;

-- ---------------------------------------------------------------------------
-- Cross-garage reads and writes on an ordinary tenant table
-- ---------------------------------------------------------------------------

select pg_temp.act_as('17000000-0000-4000-8000-0000000000b1', 'b7000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select name from public.customers', array['Customer of B'], 'owner B reads only garage B customers');
select throws_ok(
  $$insert into public.customers (garage_id, name, phone, preferred_contact) values ('a7000000-0000-4000-8000-000000000001', 'Planted', '+447700900999', 'phone')$$,
  '42501', null, 'owner B cannot insert into garage A'
);
select lives_ok(
  $$insert into public.customers (name, phone, preferred_contact) values ('Defaulted', '+447700900998', 'phone')$$,
  'a row without garage_id lands in the selected garage'
);
select results_eq(
  $$with changed as (update public.customers set name = 'Hijacked' where id = '67000000-0000-4000-8000-00000000000a' returning 1) select count(*) from changed$$,
  array[0::bigint], 'owner B cannot update garage A customers'
);
select results_eq(
  $$with removed as (delete from public.customers where id = '67000000-0000-4000-8000-00000000000a' returning 1) select count(*) from removed$$,
  array[0::bigint], 'owner B cannot delete garage A customers'
);
select throws_ok(
  $$update public.customers set garage_id = 'a7000000-0000-4000-8000-000000000001' where id = '67000000-0000-4000-8000-00000000000b'$$,
  '42501', null, 'owner B cannot move a row into garage A'
);
select throws_ok(
  $$insert into public.vehicles (customer_id, registration) values ('67000000-0000-4000-8000-00000000000a', 'XG12ABC')$$,
  '23503', null, 'a garage B vehicle cannot belong to a garage A customer'
);
reset role;

select is(
  (select garage_id from public.customers where name = 'Defaulted'),
  'b7000000-0000-4000-8000-000000000001'::uuid, 'the defaulted row belongs to garage B'
);
select is(
  (select name from public.customers where id = '67000000-0000-4000-8000-00000000000a'),
  'Customer of A', 'garage A''s customer is untouched'
);

-- ---------------------------------------------------------------------------
-- Platform tables: own row or platform admin only
-- ---------------------------------------------------------------------------

insert into public.admin_profiles (user_id, display_name) values
  ('17000000-0000-4000-8000-0000000000a1', 'Owner A'),
  ('17000000-0000-4000-8000-0000000000b1', 'Owner B');
insert into public.unmatched_inbound_emails (provider_email_id, sender_email, subject, text_body, reason)
values ('pgtap-unmatched-1', 'someone@example.test', 'Unmatched', 'Body', 'no_thread');

select pg_temp.act_as('17000000-0000-4000-8000-0000000000b1', 'b7000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select display_name from public.admin_profiles', array['Owner B'], 'staff read only their own profile');
select results_eq('select count(*) from public.unmatched_inbound_emails', array[0::bigint], 'garage staff cannot read unmatched inbound email');
select is(public.is_platform_admin(), false, 'garage owners are not platform admins');
reset role;

insert into public.platform_admins (user_id) values ('17000000-0000-4000-8000-0000000000b1');
select pg_temp.act_as('17000000-0000-4000-8000-0000000000b1', null);
set local role authenticated;
select results_eq('select count(*) from public.unmatched_inbound_emails', array[1::bigint], 'platform admins triage unmatched inbound email');
select results_eq('select count(*) from public.customers', array[0::bigint], 'platform admins get no tenant rows without a selected garage');
reset role;

-- ---------------------------------------------------------------------------
-- Deleting a garage removes everything it owns
-- ---------------------------------------------------------------------------

delete from public.garages where id = 'a7000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from public.customers where garage_id = 'a7000000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.garage_members where garage_id = 'a7000000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.garage_domains where garage_id = 'a7000000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.site_settings where garage_id = 'a7000000-0000-4000-8000-000000000001'),
  0, 'garage deletion cascades to customers, members, domains and settings'
);

select * from finish();
rollback;
