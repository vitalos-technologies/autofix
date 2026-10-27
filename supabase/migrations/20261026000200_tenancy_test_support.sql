-- Tenancy test support (P1.10).
--
-- Read-only catalogue helpers for tests/integration/tenancy.test.ts, so the
-- suite discovers tenant tables, policies and grants through PostgREST and runs
-- the same way locally and in CI. Every function is security definer (the
-- service role cannot see the columns of tables it holds no grants on, such as
-- invoice_number_sequences), reads only, and is executable by service_role
-- alone. They expose nothing the service role could not already read.
--
--   tenancy_tables()                     every relation in public: kind, whether
--                                        it has garage_id (information_schema),
--                                        RLS flags, primary key, anon and
--                                        authenticated privileges, columns
--   tenancy_policies()                   policies on public tables and
--                                        storage.objects
--   tenancy_function_grants()            public functions not owned by an
--                                        extension, with execute grants
--   tenancy_fingerprint(table, garage)   row count and checksum of one garage's
--                                        rows in a garage table (or its garages row)
--   tenancy_sample_row(table, garage)    one of that garage's rows as jsonb
--   tenancy_storage_fingerprint(garage)  count and checksum of storage objects
--                                        under "<garage_id>/"

create function public.tenancy_tables()
returns table (
  table_name text,
  table_kind text,
  has_garage_id boolean,
  rls_enabled boolean,
  rls_forced boolean,
  security_invoker boolean,
  primary_key text[],
  anon_privileges text[],
  authenticated_privileges text[],
  columns jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    class.relname::text,
    case class.relkind
      when 'r' then 'table'
      when 'p' then 'partitioned_table'
      when 'v' then 'view'
      when 'm' then 'materialized_view'
      when 'f' then 'foreign_table'
    end,
    exists (
      select 1
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = class.relname
        and column_info.column_name = 'garage_id'
    ),
    class.relrowsecurity,
    class.relforcerowsecurity,
    coalesce(class.reloptions @> array['security_invoker=true'] or class.reloptions @> array['security_invoker=on'], false),
    coalesce(
      (
        select array_agg(attribute.attname::text order by key_column.position)
        from pg_catalog.pg_constraint primary_key
        cross join lateral unnest(primary_key.conkey) with ordinality as key_column(attnum, position)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = primary_key.conrelid and attribute.attnum = key_column.attnum
        where primary_key.conrelid = class.oid and primary_key.contype = 'p'
      ),
      '{}'::text[]
    ),
    array(
      select privilege.name
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as privilege(name)
      where case
        when privilege.name in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
          then pg_catalog.has_any_column_privilege('anon', class.oid, privilege.name)
        else pg_catalog.has_table_privilege('anon', class.oid, privilege.name)
      end
    ),
    array(
      select privilege.name
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as privilege(name)
      where case
        when privilege.name in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
          then pg_catalog.has_any_column_privilege('authenticated', class.oid, privilege.name)
        else pg_catalog.has_table_privilege('authenticated', class.oid, privilege.name)
      end
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'name', attribute.attname,
            'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
            'not_null', attribute.attnotnull,
            'has_default', attribute.atthasdef,
            'identity', attribute.attidentity <> '',
            'generated', attribute.attgenerated <> '',
            'authenticated_select', pg_catalog.has_column_privilege('authenticated', class.oid, attribute.attnum, 'SELECT'),
            'authenticated_insert', pg_catalog.has_column_privilege('authenticated', class.oid, attribute.attnum, 'INSERT'),
            'authenticated_update', pg_catalog.has_column_privilege('authenticated', class.oid, attribute.attnum, 'UPDATE')
          )
          order by attribute.attnum
        )
        from pg_catalog.pg_attribute attribute
        where attribute.attrelid = class.oid and attribute.attnum > 0 and not attribute.attisdropped
      ),
      '[]'::jsonb
    )
  from pg_catalog.pg_class class
  where class.relnamespace = 'public'::regnamespace
    and class.relkind in ('r', 'p', 'v', 'm', 'f')
    and not exists (
      select 1 from pg_catalog.pg_depend dependency
      where dependency.classid = 'pg_catalog.pg_class'::regclass
        and dependency.objid = class.oid
        and dependency.deptype = 'e'
    )
  order by class.relname
$$;

create function public.tenancy_policies()
returns table (
  schema_name text,
  table_name text,
  policy_name text,
  command text,
  permissive text,
  roles text[],
  using_expression text,
  check_expression text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    policy.schemaname::text,
    policy.tablename::text,
    policy.policyname::text,
    policy.cmd::text,
    policy.permissive::text,
    policy.roles::text[],
    policy.qual,
    policy.with_check
  from pg_catalog.pg_policies policy
  where policy.schemaname = 'public'
     or (policy.schemaname = 'storage' and policy.tablename = 'objects')
  order by policy.schemaname, policy.tablename, policy.policyname
$$;

create function public.tenancy_function_grants()
returns table (
  signature text,
  security_definer boolean,
  anon_execute boolean,
  authenticated_execute boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    function_info.oid::regprocedure::text,
    function_info.prosecdef,
    pg_catalog.has_function_privilege('anon', function_info.oid, 'EXECUTE'),
    pg_catalog.has_function_privilege('authenticated', function_info.oid, 'EXECUTE')
  from pg_catalog.pg_proc function_info
  where function_info.pronamespace = 'public'::regnamespace
    and not exists (
      select 1 from pg_catalog.pg_depend dependency
      where dependency.classid = 'pg_catalog.pg_proc'::regclass
        and dependency.objid = function_info.oid
        and dependency.deptype = 'e'
    )
  order by 1
$$;

-- p_table must be a public base table with garage_id, or 'garages' (matched
-- on id). Anything else raises, so the dynamic SQL below only ever names a
-- real garage table.
create function public.tenancy_assert_garage_table(p_table text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_table = 'garages' then
    return;
  end if;
  if not exists (
    select 1
    from information_schema.columns column_info
    join information_schema.tables table_info
      on table_info.table_schema = column_info.table_schema and table_info.table_name = column_info.table_name
    where column_info.table_schema = 'public'
      and column_info.table_name = p_table
      and column_info.column_name = 'garage_id'
      and table_info.table_type = 'BASE TABLE'
  ) then
    raise exception 'NOT_A_GARAGE_TABLE: %', p_table using errcode = '22023';
  end if;
end
$$;

create function public.tenancy_fingerprint(p_table text, p_garage_id uuid)
returns table (row_count bigint, checksum text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.tenancy_assert_garage_table(p_table);
  return query execute format(
    'select count(*)::bigint, md5(coalesce(string_agg(to_jsonb(row_data)::text, %L order by to_jsonb(row_data)::text), %L))
     from public.%I row_data
     where row_data.%I = $1',
    E'\n', '', p_table, case when p_table = 'garages' then 'id' else 'garage_id' end
  ) using p_garage_id;
end
$$;

create function public.tenancy_sample_row(p_table text, p_garage_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sample jsonb;
begin
  perform public.tenancy_assert_garage_table(p_table);
  execute format(
    'select to_jsonb(row_data) from public.%I row_data where row_data.%I = $1 order by to_jsonb(row_data)::text limit 1',
    p_table, case when p_table = 'garages' then 'id' else 'garage_id' end
  ) into sample using p_garage_id;
  return sample;
end
$$;

create function public.tenancy_storage_fingerprint(p_garage_id uuid)
returns table (row_count bigint, checksum text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*)::bigint,
    md5(coalesce(string_agg(
      concat_ws('|', object.bucket_id, object.name, object.owner_id, object.metadata::text, object.updated_at::text),
      E'\n' order by object.bucket_id, object.name
    ), ''))
  from storage.objects object
  where (storage.foldername(object.name))[1] = p_garage_id::text
$$;

revoke all on function public.tenancy_tables() from public, anon, authenticated;
revoke all on function public.tenancy_policies() from public, anon, authenticated;
revoke all on function public.tenancy_function_grants() from public, anon, authenticated;
revoke all on function public.tenancy_assert_garage_table(text) from public, anon, authenticated, service_role;
revoke all on function public.tenancy_fingerprint(text, uuid) from public, anon, authenticated;
revoke all on function public.tenancy_sample_row(text, uuid) from public, anon, authenticated;
revoke all on function public.tenancy_storage_fingerprint(uuid) from public, anon, authenticated;

grant execute on function public.tenancy_tables() to service_role;
grant execute on function public.tenancy_policies() to service_role;
grant execute on function public.tenancy_function_grants() to service_role;
grant execute on function public.tenancy_fingerprint(text, uuid) to service_role;
grant execute on function public.tenancy_sample_row(text, uuid) to service_role;
grant execute on function public.tenancy_storage_fingerprint(uuid) to service_role;
