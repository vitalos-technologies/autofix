begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

-- The catalogue helpers behind tests/integration/tenancy.test.ts are
-- service-role only and read-only.

select is(
  (select count(*)::integer
   from unnest(array[
     'public.tenancy_tables()', 'public.tenancy_policies()', 'public.tenancy_function_grants()',
     'public.tenancy_fingerprint(text,uuid)', 'public.tenancy_sample_row(text,uuid)',
     'public.tenancy_storage_fingerprint(uuid)', 'public.tenancy_assert_garage_table(text)'
   ]) as helper(signature)
   where has_function_privilege('anon', helper.signature, 'execute')
      or has_function_privilege('authenticated', helper.signature, 'execute')),
  0, 'anon and authenticated cannot execute the tenancy test helpers'
);
select ok(has_function_privilege('service_role', 'public.tenancy_tables()', 'execute'), 'service_role lists tables');
select ok(has_function_privilege('service_role', 'public.tenancy_policies()', 'execute'), 'service_role lists policies');
select ok(has_function_privilege('service_role', 'public.tenancy_fingerprint(text,uuid)', 'execute'), 'service_role fingerprints garage rows');
select ok(not has_function_privilege('service_role', 'public.tenancy_assert_garage_table(text)', 'execute'), 'the table guard is internal');

select is(
  (select array_agg(table_name order by table_name collate "C") from public.tenancy_tables() where has_garage_id and table_kind = 'table'),
  (select array_agg(column_info.table_name::text order by column_info.table_name::text collate "C")
   from information_schema.columns column_info
   join information_schema.tables table_info using (table_schema, table_name)
   where column_info.table_schema = 'public' and column_info.column_name = 'garage_id' and table_info.table_type = 'BASE TABLE'),
  'tenancy_tables() reports exactly the information_schema garage tables'
);
select ok(
  (select has_garage_id from public.tenancy_tables() where table_name = 'invoice_number_sequences'),
  'tables without API grants are still discovered'
);
select is(
  (select authenticated_privileges from public.tenancy_tables() where table_name = 'garage_domains'),
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  'column-level grants count as privileges'
);

insert into public.garages (id, slug, name, booking_prefix) values
  ('a9000000-0000-4000-8000-000000000001', 'pgtap-support-a', 'Support Garage A', 'SPA'),
  ('b9000000-0000-4000-8000-000000000001', 'pgtap-support-b', 'Support Garage B', 'SPB');
insert into public.customers (garage_id, name, phone, preferred_contact) values
  ('a9000000-0000-4000-8000-000000000001', 'Support A', '+447700900991', 'phone'),
  ('a9000000-0000-4000-8000-000000000001', 'Support A2', '+447700900992', 'phone');

select is(
  (select row_count from public.tenancy_fingerprint('customers', 'a9000000-0000-4000-8000-000000000001')),
  2::bigint, 'fingerprints count one garage''s rows'
);
select is(
  (select row_count from public.tenancy_fingerprint('customers', 'b9000000-0000-4000-8000-000000000001')),
  0::bigint, 'and only that garage''s rows'
);

create temporary table support_before as
  select checksum from public.tenancy_fingerprint('customers', 'a9000000-0000-4000-8000-000000000001');
update public.customers set name = 'Support A changed' where name = 'Support A';
select isnt(
  (select checksum from public.tenancy_fingerprint('customers', 'a9000000-0000-4000-8000-000000000001')),
  (select checksum from support_before),
  'any change to a row changes the checksum'
);

select is(
  (select tenancy_sample_row ->> 'garage_id' from public.tenancy_sample_row('customers', 'a9000000-0000-4000-8000-000000000001')),
  'a9000000-0000-4000-8000-000000000001', 'sample rows come from the requested garage'
);
select throws_ok(
  $$select public.tenancy_fingerprint('admin_mfa_policy', 'a9000000-0000-4000-8000-000000000001')$$,
  '22023', null, 'tables without garage_id are refused'
);
select throws_ok(
  $$select public.tenancy_sample_row('customers; drop table public.customers', 'a9000000-0000-4000-8000-000000000001')$$,
  '22023', null, 'arbitrary SQL in the table name is refused'
);

select * from finish();
rollback;
