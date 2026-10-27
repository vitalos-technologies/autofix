-- Vitalos super admin (P4.5): garages, plans, status, logged impersonation
-- and job queue health for platform admins (public.platform_admins).
--
-- Follows docs/autofix/SPEC.md ("Vitalos staff use a separate platform_admins
-- table and super-admin routes, with every action logged") and DECISIONS.md
-- A120-A129:
--
--   1. platform_audit_log: append-only log of every platform action (service
--      role only; no garage_id column, the garage it concerns is
--      target_garage_id, kept as null when the garage is deleted).
--   2. platform_impersonations: one row per impersonation session (service
--      role only; garage_id not null, cascade with the garage).
--   3. Access: every platform function requires a platform admin whose JWT
--      is AAL2 (MFA verified this session) and raises 42501 otherwise.
--   4. Impersonation in SQL: garage_role() (and so current_garage_id(),
--      current_garage_role() and every RLS policy built on them) also answers
--      'owner' for the garage of the caller's active, unexpired impersonation,
--      but only inside a READ ONLY transaction (PostgREST runs GET/HEAD and
--      stable RPCs read-only) and only for a platform admin at AAL2. Writes
--      always run read-write, so an impersonating admin can never write
--      through RLS: impersonation is read-only in the database itself.
--   5. Platform RPCs for the /admin pages and /api/platform/*: garages list
--      and detail, plan/status changes (reason required, audited in the
--      garage's admin_audit_log and platform_audit_log), impersonation start
--      and end, page-view/write-block logging, job queue health and retry.
--
-- Rollback (manual): restore public.garage_role(uuid) from
-- 20261026000100_tenancy.sql; drop the functions below; drop table
-- public.platform_impersonations, public.platform_audit_log.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.platform_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_garage_id uuid references public.garages(id) on delete set null,
  entity_type text not null,
  entity_id text not null,
  reason text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint platform_audit_log_action_check check (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' and char_length(action) <= 80),
  constraint platform_audit_log_entity_type_check check (char_length(entity_type) between 1 and 40),
  constraint platform_audit_log_entity_id_check check (char_length(entity_id) between 1 and 200),
  constraint platform_audit_log_reason_check check (reason is null or char_length(reason) <= 500),
  constraint platform_audit_log_detail_check check (jsonb_typeof(detail) = 'object')
);

create index platform_audit_log_created_idx on public.platform_audit_log (created_at desc);
create index platform_audit_log_garage_idx on public.platform_audit_log (target_garage_id, created_at desc) where target_garage_id is not null;

comment on table public.platform_audit_log is
  'Every super-admin action (P4.5). Append-only, service role only; read through platform_audit_entries().';

create table public.platform_impersonations (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  constraint platform_impersonations_reason_check check (char_length(btrim(reason)) between 5 and 500),
  constraint platform_impersonations_expiry_check check (expires_at > started_at and expires_at <= started_at + interval '2 hours'),
  constraint platform_impersonations_end_check check (
    (ended_at is null) = (end_reason is null)
    and (end_reason is null or end_reason in ('ended', 'expired', 'replaced'))
  )
);

-- One open session per admin at a time.
create unique index platform_impersonations_open_key on public.platform_impersonations (admin_user_id) where ended_at is null;
create index platform_impersonations_garage_idx on public.platform_impersonations (garage_id, started_at desc);

comment on table public.platform_impersonations is
  'Super-admin impersonation sessions (P4.5): time-limited, reason required, read-only. Service role only; '
  'garage_role() honours an open, unexpired row for auth.uid() in read-only transactions.';

-- ---------------------------------------------------------------------------
-- 2. Access helpers (internal: not granted to API roles)
-- ---------------------------------------------------------------------------

-- A platform admin whose session passed MFA (AAL2).
create function public.platform_admin_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    and exists (select 1 from public.platform_admins platform_admin where platform_admin.user_id = auth.uid())
$$;

create function public.require_platform_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.platform_admin_allowed() then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return auth.uid();
end
$$;

-- The garage the caller is impersonating right now, or null. Only in a read
-- only transaction, so no write can ever use it.
create function public.impersonated_garage_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select session.garage_id
  from public.platform_impersonations session
  where session.admin_user_id = auth.uid()
    and session.ended_at is null
    and session.expires_at > now()
    and current_setting('transaction_read_only', true) = 'on'
    and public.platform_admin_allowed()
  limit 1
$$;

-- garage_role() as in 20261026000100_tenancy.sql, plus impersonation: a
-- member's own role wins; otherwise the impersonated garage reads as 'owner'
-- (read-only, see impersonated_garage_id()). current_garage_id(),
-- current_garage_role() and every policy built on them follow.
create or replace function public.garage_role(p_garage_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select member.role
     from public.garage_members member
     where member.garage_id = p_garage_id
       and member.user_id = auth.uid()),
    (select 'owner'::text where p_garage_id is not null and p_garage_id = public.impersonated_garage_id())
  )
$$;

-- Records a platform action, and a copy in the garage's own audit log when it
-- concerns one garage (owners see what Vitalos did in their garage).
create function public.record_platform_action(
  p_action text,
  p_garage_id uuid,
  p_entity_type text,
  p_entity_id text,
  p_reason text,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.platform_audit_log (actor_id, action, target_garage_id, entity_type, entity_id, reason, detail)
  values (auth.uid(), p_action, p_garage_id, p_entity_type, p_entity_id, p_reason, coalesce(p_detail, '{}'::jsonb));
  if p_garage_id is not null then
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (
      p_garage_id, auth.uid(), p_action, p_entity_type, p_entity_id,
      coalesce(p_detail, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('reason', p_reason, 'by', 'Vitalos support'))
    );
  end if;
end
$$;

create function public.clean_platform_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  cleaned text := btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]+', ' ', 'g'));
begin
  if char_length(cleaned) < 5 or char_length(cleaned) > 500 then
    raise exception 'INVALID_REASON: give a reason of 5 to 500 characters' using errcode = '22023';
  end if;
  return cleaned;
end
$$;

-- Closes the caller's expired sessions (audited as expired).
create function public.close_expired_impersonations_for(p_admin_user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  closed record;
  closed_count integer := 0;
begin
  for closed in
    update public.platform_impersonations session
    set ended_at = session.expires_at, end_reason = 'expired'
    where session.ended_at is null
      and session.expires_at <= now()
      and (p_admin_user_id is null or session.admin_user_id = p_admin_user_id)
    returning session.id, session.garage_id, session.admin_user_id, session.expires_at
  loop
    insert into public.platform_audit_log (actor_id, action, target_garage_id, entity_type, entity_id, detail)
    values (closed.admin_user_id, 'platform.impersonation_expired', closed.garage_id, 'impersonation', closed.id::text,
            jsonb_build_object('expired_at', closed.expires_at));
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (closed.garage_id, closed.admin_user_id, 'platform.impersonation_expired', 'impersonation', closed.id::text,
            jsonb_build_object('expired_at', closed.expires_at, 'by', 'Vitalos support'));
    closed_count := closed_count + 1;
  end loop;
  return closed_count;
end
$$;

-- For a job or cron: closes every expired session. Service role only.
create function public.close_expired_impersonations()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  select public.close_expired_impersonations_for(null)
$$;

-- ---------------------------------------------------------------------------
-- 3. Garages
-- ---------------------------------------------------------------------------

create function public.platform_garages(
  p_search text default null,
  p_status text default null,
  p_plan text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  slug text,
  name text,
  plan text,
  status text,
  created_at timestamptz,
  cancelled_at timestamptz,
  member_count integer,
  bookings_30d integer,
  last_booking_at timestamptz,
  domain_hostname text,
  domain_status text,
  total_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pattern text;
begin
  perform public.require_platform_admin();
  if p_status is not null and p_status not in ('onboarding', 'active', 'suspended', 'cancelled') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;
  if p_plan is not null and p_plan not in ('trial', 'growth', 'front_desk') then
    raise exception 'INVALID_PLAN' using errcode = '22023';
  end if;
  pattern := nullif(btrim(left(coalesce(p_search, ''), 80)), '');
  if pattern is not null then
    pattern := '%' || replace(replace(replace(lower(pattern), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select
    garage.id,
    garage.slug,
    garage.name,
    garage.plan,
    garage.status,
    garage.created_at,
    garage.cancelled_at,
    (select count(*)::integer from public.garage_members member where member.garage_id = garage.id),
    (select count(*)::integer from public.bookings booking
     where booking.garage_id = garage.id and booking.created_at >= now() - interval '30 days'),
    (select max(booking.created_at) from public.bookings booking where booking.garage_id = garage.id),
    domain.hostname,
    domain.status,
    (count(*) over ())::integer
  from public.garages garage
  left join lateral (
    select candidate.hostname, candidate.status
    from public.garage_domains candidate
    where candidate.garage_id = garage.id and candidate.kind = 'custom' and candidate.deleted_at is null
    order by (candidate.status = 'active') desc, candidate.created_at desc
    limit 1
  ) domain on true
  where (pattern is null or lower(garage.name) like pattern or garage.slug like pattern)
    and (p_status is null or garage.status = p_status)
    and (p_plan is null or garage.plan = p_plan)
  order by garage.created_at desc, garage.id
  limit least(greatest(coalesce(p_limit, 25), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

create function public.platform_garage(p_garage_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform public.require_platform_admin();
  select jsonb_build_object(
    'id', garage.id,
    'slug', garage.slug,
    'name', garage.name,
    'plan', garage.plan,
    'status', garage.status,
    'timezone', garage.timezone,
    'mot_enabled', garage.mot_enabled,
    'created_at', garage.created_at,
    'cancelled_at', garage.cancelled_at,
    'members', jsonb_build_object(
      'owner', (select count(*) from public.garage_members member where member.garage_id = garage.id and member.role = 'owner'),
      'manager', (select count(*) from public.garage_members member where member.garage_id = garage.id and member.role = 'manager'),
      'technician', (select count(*) from public.garage_members member where member.garage_id = garage.id and member.role = 'technician')
    ),
    'bookings_30d', (select count(*) from public.bookings booking
                     where booking.garage_id = garage.id and booking.created_at >= now() - interval '30 days'),
    'last_booking_at', (select max(booking.created_at) from public.bookings booking where booking.garage_id = garage.id),
    'domains', coalesce((
      select jsonb_agg(jsonb_build_object('hostname', domain.hostname, 'kind', domain.kind, 'status', domain.status,
                                          'last_checked_at', domain.last_checked_at) order by domain.kind, domain.created_at)
      from public.garage_domains domain
      where domain.garage_id = garage.id and domain.deleted_at is null
    ), '[]'::jsonb),
    'impersonations', coalesce((
      select jsonb_agg(entry order by entry ->> 'started_at' desc)
      from (
        select jsonb_build_object('id', session.id, 'reason', session.reason, 'started_at', session.started_at,
                                  'expires_at', session.expires_at, 'ended_at', session.ended_at, 'end_reason', session.end_reason,
                                  'admin', coalesce(profile.display_name, 'Vitalos support')) as entry
        from public.platform_impersonations session
        left join public.admin_profiles profile on profile.user_id = session.admin_user_id
        where session.garage_id = garage.id
        order by session.started_at desc
        limit 10
      ) recent
    ), '[]'::jsonb)
  )
  into result
  from public.garages garage
  where garage.id = p_garage_id;
  return result;
end
$$;

-- Changes plan and/or status with a reason. Status 'cancelled' sets
-- cancelled_at; leaving it clears it. Each change is one audit entry.
create function public.platform_update_garage(p_garage_id uuid, p_plan text, p_status text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reason text;
  before_row public.garages%rowtype;
  after_row public.garages%rowtype;
begin
  perform public.require_platform_admin();
  reason := public.clean_platform_reason(p_reason);
  if p_plan is null and p_status is null then
    raise exception 'NOTHING_TO_CHANGE' using errcode = '22023';
  end if;
  if p_plan is not null and p_plan not in ('trial', 'growth', 'front_desk') then
    raise exception 'INVALID_PLAN' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('onboarding', 'active', 'suspended', 'cancelled') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  select * into before_row from public.garages garage where garage.id = p_garage_id for update;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.garages garage
  set plan = coalesce(p_plan, garage.plan),
      status = coalesce(p_status, garage.status),
      cancelled_at = case
        when coalesce(p_status, garage.status) = 'cancelled' then coalesce(garage.cancelled_at, now())
        else null
      end
  where garage.id = p_garage_id
  returning * into after_row;

  if after_row.plan is distinct from before_row.plan then
    perform public.record_platform_action('platform.garage_plan_changed', p_garage_id, 'garage', p_garage_id::text, reason,
      jsonb_build_object('from', before_row.plan, 'to', after_row.plan));
  end if;
  if after_row.status is distinct from before_row.status then
    perform public.record_platform_action('platform.garage_status_changed', p_garage_id, 'garage', p_garage_id::text, reason,
      jsonb_build_object('from', before_row.status, 'to', after_row.status));
  end if;

  return jsonb_build_object('id', after_row.id, 'plan', after_row.plan, 'status', after_row.status, 'cancelled_at', after_row.cancelled_at);
end
$$;

create function public.platform_audit_entries(p_garage_id uuid default null, p_limit integer default 20)
returns table (
  id bigint,
  created_at timestamptz,
  action text,
  target_garage_id uuid,
  garage_name text,
  entity_type text,
  entity_id text,
  reason text,
  detail jsonb,
  actor_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_platform_admin();
  return query
  select entry.id, entry.created_at, entry.action, entry.target_garage_id, garage.name, entry.entity_type, entry.entity_id,
         entry.reason, entry.detail, coalesce(profile.display_name, 'Vitalos support')
  from public.platform_audit_log entry
  left join public.garages garage on garage.id = entry.target_garage_id
  left join public.admin_profiles profile on profile.user_id = entry.actor_id
  where p_garage_id is null or entry.target_garage_id = p_garage_id
  order by entry.created_at desc, entry.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Impersonation
-- ---------------------------------------------------------------------------

-- Starts a session for one garage (5-60 minutes, default 30), ending the
-- caller's open one first.
create function public.platform_start_impersonation(p_garage_id uuid, p_reason text, p_minutes integer default 30)
returns table (id uuid, garage_id uuid, garage_name text, reason text, started_at timestamptz, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  admin_id uuid;
  cleaned text;
  previous record;
  garage_row record;
  session_row public.platform_impersonations%rowtype;
begin
  admin_id := public.require_platform_admin();
  cleaned := public.clean_platform_reason(p_reason);
  if p_minutes is null or p_minutes < 5 or p_minutes > 60 then
    raise exception 'INVALID_DURATION: 5 to 60 minutes' using errcode = '22023';
  end if;
  select garage.id, garage.name into garage_row from public.garages garage where garage.id = p_garage_id;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform public.close_expired_impersonations_for(admin_id);
  for previous in
    update public.platform_impersonations session
    set ended_at = now(), end_reason = 'replaced'
    where session.admin_user_id = admin_id and session.ended_at is null
    returning session.id, session.garage_id
  loop
    perform public.record_platform_action('platform.impersonation_ended', previous.garage_id, 'impersonation', previous.id::text, null,
      jsonb_build_object('end_reason', 'replaced'));
  end loop;

  insert into public.platform_impersonations (garage_id, admin_user_id, reason, expires_at)
  values (p_garage_id, admin_id, cleaned, now() + make_interval(mins => p_minutes))
  returning * into session_row;

  perform public.record_platform_action('platform.impersonation_started', p_garage_id, 'impersonation', session_row.id::text, cleaned,
    jsonb_build_object('expires_at', session_row.expires_at, 'read_only', true));

  return query select session_row.id, session_row.garage_id, garage_row.name::text, session_row.reason, session_row.started_at, session_row.expires_at;
end
$$;

-- Ends the caller's open session (any platform admin, no AAL2 needed: ending
-- is always safe). True when one was open.
create function public.platform_end_impersonation()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  ended record;
  any_ended boolean := false;
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  perform public.close_expired_impersonations_for(auth.uid());
  for ended in
    update public.platform_impersonations session
    set ended_at = now(), end_reason = 'ended'
    where session.admin_user_id = auth.uid() and session.ended_at is null
    returning session.id, session.garage_id
  loop
    perform public.record_platform_action('platform.impersonation_ended', ended.garage_id, 'impersonation', ended.id::text, null,
      jsonb_build_object('end_reason', 'ended'));
    any_ended := true;
  end loop;
  return any_ended;
end
$$;

-- The caller's open, unexpired session (platform admin at AAL2), or no row.
create function public.current_impersonation()
returns table (id uuid, garage_id uuid, garage_name text, reason text, started_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select session.id, session.garage_id, garage.name, session.reason, session.started_at, session.expires_at
  from public.platform_impersonations session
  join public.garages garage on garage.id = session.garage_id
  where session.admin_user_id = auth.uid()
    and session.ended_at is null
    and session.expires_at > now()
    and public.platform_admin_allowed()
$$;

-- Logs a page view or a blocked write during the caller's open session, in
-- the garage's audit log and the platform log. Paths only (no query string).
create function public.log_impersonation_event(p_action text, p_path text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  session_row record;
  safe_path text;
begin
  if p_action not in ('platform.impersonation_page_view', 'platform.impersonation_write_blocked') then
    raise exception 'INVALID_IMPERSONATION_EVENT' using errcode = '22023';
  end if;
  select session.id, session.garage_id into session_row
  from public.platform_impersonations session
  where session.admin_user_id = auth.uid() and session.ended_at is null and session.expires_at > now()
    and public.is_platform_admin();
  if not found then
    return false;
  end if;
  safe_path := left(split_part(split_part(coalesce(p_path, ''), '?', 1), '#', 1), 200);
  if safe_path !~ '^/[A-Za-z0-9/_.%~-]*$' then
    safe_path := null;
  end if;
  perform public.record_platform_action(p_action, session_row.garage_id, 'impersonation', session_row.id::text, null,
    jsonb_strip_nulls(jsonb_build_object('path', safe_path)));
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Job queue health
-- ---------------------------------------------------------------------------

-- Queue counts, oldest queued job, running jobs whose lock expired, the 20
-- latest failures (last_error is shown after redaction in the app; payloads
-- are never returned) and reminder sends skipped/failed per garage in the
-- last 7 days.
create function public.platform_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_platform_admin();
  return jsonb_build_object(
    'generated_at', now(),
    'by_kind', coalesce((
      select jsonb_agg(jsonb_build_object('kind', grouped.kind, 'status', grouped.status, 'count', grouped.total) order by grouped.kind, grouped.status)
      from (select job.kind, job.status, count(*) as total from public.jobs job group by job.kind, job.status) grouped
    ), '[]'::jsonb),
    'oldest_queued_at', (select min(job.run_at) from public.jobs job where job.status = 'queued' and job.run_at <= now()),
    'expired_locks', coalesce((
      select jsonb_agg(jsonb_build_object('id', job.id, 'kind', job.kind, 'attempts', job.attempts, 'max_attempts', job.max_attempts,
                                          'locked_until', job.locked_until) order by job.locked_until)
      from public.jobs job
      where job.status = 'running' and job.locked_until < now()
    ), '[]'::jsonb),
    'recent_failures', coalesce((
      select jsonb_agg(failure order by failure ->> 'finished_at' desc)
      from (
        select jsonb_build_object('id', job.id, 'kind', job.kind, 'garage_id', job.garage_id, 'garage_name', garage.name,
                                  'attempts', job.attempts, 'max_attempts', job.max_attempts, 'finished_at', job.finished_at,
                                  'last_error', job.last_error) as failure
        from public.jobs job
        left join public.garages garage on garage.id = job.garage_id
        where job.status = 'failed'
        order by job.finished_at desc
        limit 20
      ) latest
    ), '[]'::jsonb),
    'reminder_sends_7d', coalesce((
      select jsonb_agg(jsonb_build_object('garage_id', grouped.garage_id, 'garage_name', garage.name,
                                          'skipped', grouped.skipped, 'failed', grouped.failed) order by grouped.failed desc, grouped.skipped desc, garage.name)
      from (
        select send.garage_id,
               count(*) filter (where send.status = 'skipped') as skipped,
               count(*) filter (where send.status = 'failed') as failed
        from public.reminder_sends send
        where send.status in ('skipped', 'failed') and send.updated_at >= now() - interval '7 days'
        group by send.garage_id
      ) grouped
      join public.garages garage on garage.id = grouped.garage_id
    ), '[]'::jsonb)
  );
end
$$;

-- Puts a failed job back in the queue now with fresh attempts. Audited.
create function public.platform_retry_job(p_job_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cleaned text;
  job_row record;
begin
  perform public.require_platform_admin();
  cleaned := public.clean_platform_reason(p_reason);
  update public.jobs job
  set status = 'queued', run_at = now(), attempts = 0, locked_until = null, finished_at = null
  where job.id = p_job_id and job.status = 'failed'
  returning job.id, job.kind, job.garage_id into job_row;
  if not found then
    return false;
  end if;
  insert into public.platform_audit_log (actor_id, action, target_garage_id, entity_type, entity_id, reason, detail)
  values (auth.uid(), 'platform.job_retried', job_row.garage_id, 'job', job_row.id::text, cleaned, jsonb_build_object('kind', job_row.kind));
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants and row-level security
-- ---------------------------------------------------------------------------

alter table public.platform_audit_log enable row level security;
alter table public.platform_impersonations enable row level security;

-- platform_audit_log, platform_impersonations
--   no policies: service role only; staff and platform admins read them
--   through the security-definer functions above.
revoke all on public.platform_audit_log, public.platform_impersonations from public, anon, authenticated;
grant select, insert on public.platform_audit_log to service_role;
grant select, insert, update on public.platform_impersonations to service_role;

revoke all on function
  public.platform_admin_allowed(),
  public.require_platform_admin(),
  public.impersonated_garage_id(),
  public.record_platform_action(text, uuid, text, text, text, jsonb),
  public.clean_platform_reason(text),
  public.close_expired_impersonations_for(uuid),
  public.close_expired_impersonations(),
  public.platform_garages(text, text, text, integer, integer),
  public.platform_garage(uuid),
  public.platform_update_garage(uuid, text, text, text),
  public.platform_audit_entries(uuid, integer),
  public.platform_start_impersonation(uuid, text, integer),
  public.platform_end_impersonation(),
  public.current_impersonation(),
  public.log_impersonation_event(text, text),
  public.platform_job_health(),
  public.platform_retry_job(uuid, text)
from public, anon, authenticated;

-- Platform RPCs: signed-in users may call them; each one checks
-- platform_admins and AAL2 itself.
grant execute on function
  public.platform_garages(text, text, text, integer, integer),
  public.platform_garage(uuid),
  public.platform_update_garage(uuid, text, text, text),
  public.platform_audit_entries(uuid, integer),
  public.platform_start_impersonation(uuid, text, integer),
  public.platform_end_impersonation(),
  public.current_impersonation(),
  public.log_impersonation_event(text, text),
  public.platform_job_health(),
  public.platform_retry_job(uuid, text)
to authenticated;

grant execute on function public.close_expired_impersonations() to service_role;
