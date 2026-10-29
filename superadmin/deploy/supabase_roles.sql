-- Pitline Super Admin: logins for its two database roles (DECISIONS D18, A415-A418). Run once in the
-- Supabase SQL editor of Pitline's production project, AFTER the production migrations (the role
-- autofix_superadmin and schema superadmin come from 20261028004000_superadmin_role.sql).
--
-- Only needed when the deploy has no SUPABASE_ACCESS_TOKEN (with one, the deploy does this itself).
-- Before running: replace POOLER_HOST (twice, near the end) with your project's session pooler host (Supabase,
-- Connect, "Session pooler": aws-0-<region>.pooler.supabase.com). The result shows two rows; add each
-- value as the GitHub repository secret named in the "secret" column. Do not paste them anywhere else.
--
-- Passwords are made inside the database, never written in a statement, so no log line carries them.
-- Running it again gives both roles new passwords: then update both secrets and re-run the deploy.

create temporary table superadmin_new_passwords as
select encode(extensions.gen_random_bytes(24), 'hex') as app_password,
       encode(extensions.gen_random_bytes(24), 'hex') as autofix_password;

do $$
declare
  generated record;
begin
  if not exists (select from pg_roles where rolname = 'autofix_superadmin') then
    raise exception 'Role autofix_superadmin is missing: apply the production migrations first.';
  end if;
  if not exists (select from pg_roles where rolname = 'superadmin_app') then
    create role superadmin_app login noinherit connection limit 10;
  end if;
  select * into generated from superadmin_new_passwords;
  execute format('alter role superadmin_app with login password %L', generated.app_password);
  execute format('alter role autofix_superadmin with login password %L', generated.autofix_password);
end
$$;

-- The super admin's own data (its users, sessions, audit trail) lives in schema superadmin_app; the role
-- has no grant anywhere else, and the Data API does not serve this schema.
create schema if not exists superadmin_app;
revoke all on schema superadmin_app from public;
grant usage, create on schema superadmin_app to superadmin_app;
alter role superadmin_app set search_path = superadmin_app;
alter role superadmin_app set statement_timeout = '30s';
revoke all on schema superadmin from superadmin_app;

select 'SUPERADMIN_DATABASE_URL' as secret,
       format('postgres://superadmin_app.%s:%s@%s:5432/postgres?sslmode=require',
              'yzekrreqhggwcdzxsmcc', app_password, 'POOLER_HOST') as value
from superadmin_new_passwords
union all
select 'SUPERADMIN_AUTOFIX_DATABASE_URL',
       format('postgres://autofix_superadmin.%s:%s@%s:5432/postgres?sslmode=require',
              'yzekrreqhggwcdzxsmcc', autofix_password, 'POOLER_HOST')
from superadmin_new_passwords;
