begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

-- Django super admin (P5.1): role autofix_superadmin reads schema superadmin
-- only, starts read-only, and can call exactly three platform functions.

select has_role('autofix_superadmin', 'the super admin role exists');
select is((select rolconnlimit from pg_roles where rolname = 'autofix_superadmin'), 10, 'at most 10 connections');
select ok(not (select rolsuper or rolbypassrls or rolcreaterole or rolcreatedb from pg_roles where rolname = 'autofix_superadmin'),
          'no superuser, bypassrls, createrole or createdb');
select ok(exists (
  select 1 from pg_db_role_setting setting join pg_roles role on role.oid = setting.setrole
  where role.rolname = 'autofix_superadmin' and 'default_transaction_read_only=on' = any(setting.setconfig)
), 'sessions start read-only');
select ok(exists (
  select 1 from pg_db_role_setting setting join pg_roles role on role.oid = setting.setrole
  where role.rolname = 'autofix_superadmin' and 'search_path=superadmin' = any(setting.setconfig)
), 'search_path is the superadmin schema');

select has_schema('superadmin', 'schema superadmin exists');
select ok(has_table_privilege('autofix_superadmin', 'superadmin.garages', 'select'), 'reads superadmin.garages');
select ok(has_table_privilege('autofix_superadmin', 'superadmin.bookings', 'select'), 'reads superadmin.bookings');
select ok(not has_table_privilege('autofix_superadmin', 'superadmin.garages', 'insert,update,delete'), 'cannot write the views');
select ok(not has_table_privilege('autofix_superadmin', 'public.garages', 'select,insert,update,delete'), 'nothing on public.garages');
select ok(not has_table_privilege('autofix_superadmin', 'public.customers', 'select'), 'nothing on public.customers');
select ok(not has_table_privilege('autofix_superadmin', 'public.messages', 'select'), 'nothing on public.messages');
select ok(not has_table_privilege('anon', 'superadmin.garages', 'select'), 'anon cannot read the views');
select ok(not has_table_privilege('authenticated', 'superadmin.customers', 'select'), 'staff cannot read the views');

select ok(has_function_privilege('autofix_superadmin', 'public.platform_update_garage(uuid, text, text, text)', 'execute'), 'may change plan and status');
select ok(has_function_privilege('autofix_superadmin', 'public.platform_retry_job(uuid, text)', 'execute'), 'may retry a job');
select ok(has_function_privilege('autofix_superadmin', 'public.platform_request_domains_check(uuid, text)', 'execute'), 'may request a domain check');
select ok(not has_function_privilege('autofix_superadmin', 'public.enqueue_job(text, jsonb, timestamptz, text, uuid)', 'execute'), 'may not enqueue jobs');
select ok(not has_function_privilege('autofix_superadmin', 'public.create_booking(uuid, jsonb)', 'execute'), 'may not create bookings');
select ok(not has_function_privilege('authenticated', 'public.platform_request_domains_check(uuid, text)', 'execute'), 'staff cannot call the domain check');

-- Masking and the domain check itself.
select is(superadmin.mask_phone('+44 7700 900123'), '•••123', 'phones keep only the last three digits');
select is(superadmin.mask_registration('ab12 cde'), 'AB•••', 'registrations keep only two characters');

insert into auth.users (id, email, raw_user_meta_data) values ('2c000000-0000-4000-8000-0000000000f1', 'sa-pgtap@pgtap.test', '{}');
insert into public.platform_admins (user_id) values ('2c000000-0000-4000-8000-0000000000f1');
insert into public.garages (id, slug, name, booking_prefix) values ('2c000000-0000-4000-8000-000000000001', 'pgtap-sa', 'SA Garage', 'PSA');
insert into public.garage_domains (id, garage_id, hostname, kind, status) values
  ('2c000000-0000-4000-8000-000000000101', '2c000000-0000-4000-8000-000000000001', 'book.pgtap-sa.example', 'custom', 'verifying');

-- As the platform admin the super admin links to (the role's own grants are covered in the integration tests).
select set_config('request.jwt.claims', '{"sub":"2c000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', true);
select is(
  (public.platform_request_domains_check('2c000000-0000-4000-8000-000000000101', 'pgTAP re-check')->>'job_status'),
  'queued', 'a pending custom domain queues domains.check'
);
select is(
  (select count(*)::integer from public.platform_audit_log where action = 'platform.domain_check_requested' and target_garage_id = '2c000000-0000-4000-8000-000000000001'),
  1, 'the request is in the platform audit log'
);

select * from finish();
rollback;
