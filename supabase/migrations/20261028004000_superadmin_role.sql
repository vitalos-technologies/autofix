-- Django super admin (P5.1): a least-privilege database role and read-only
-- views for superadmin/ (docs/autofix/DECISIONS.md D18, A400-A410).
--
--   1. Schema superadmin: one view per table the super admin reads. The views
--      are owned by the migration role, so they read past RLS, but they carry
--      only the columns the super admin shows: no message bodies, no phone
--      numbers or addresses, no job payloads, no token hashes. Personal data
--      support needs (a customer's name on an audited booking view) is the
--      only exception; contact details and registrations are masked here, in
--      the database, so the raw values never reach the super admin.
--   2. Role autofix_superadmin: NOLOGIN here. Login and its password are set
--      out of band (INFRA.md), never in a migration. It holds USAGE and
--      SELECT on schema superadmin, EXECUTE on the three platform functions
--      the super admin calls, and nothing on public tables. Every session
--      starts read-only (default_transaction_read_only), with a statement
--      timeout and search_path = superadmin.
--   3. Writes go through the existing platform functions, which check that
--      auth.uid() is a platform admin at AAL2 and write the platform and
--      garage audit logs. The super admin opens a read-write transaction,
--      sets request.jwt.claims for the signed-in Vitalos user's linked
--      platform admin (verified with TOTP in Django) and calls:
--        platform_update_garage(uuid, text, text, text)   plan / status
--        platform_retry_job(uuid, text)                   failed job retry
--        platform_request_domains_check(uuid, text)       new, below
--   4. platform_request_domains_check(): queues the existing domains.check
--      job (one per 5 minutes at most, deduplicated) for a custom domain
--      still pending, and audits it. The job does the Vercel work, exactly as
--      the cron does.
--
-- Rollback (manual): drop schema superadmin cascade; drop function
-- public.platform_request_domains_check(uuid, text); revoke the grants below;
-- drop role autofix_superadmin (after revoking its remaining privileges).

-- ---------------------------------------------------------------------------
-- 1. Role (cluster-wide, so created only when missing)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'autofix_superadmin') then
    create role autofix_superadmin nologin noinherit nocreatedb nocreaterole noreplication connection limit 10;
  end if;
end
$$;

alter role autofix_superadmin set default_transaction_read_only = on;
alter role autofix_superadmin set statement_timeout = '10s';
alter role autofix_superadmin set idle_in_transaction_session_timeout = '30s';
alter role autofix_superadmin set search_path = superadmin;

comment on role autofix_superadmin is
  'Django super admin (P5.1). SELECT on schema superadmin views; EXECUTE on platform_update_garage, platform_retry_job, '
  'platform_request_domains_check. Read-only sessions by default. Login and password are set out of band.';

-- ---------------------------------------------------------------------------
-- 2. Read-only views
-- ---------------------------------------------------------------------------

create schema superadmin;
comment on schema superadmin is
  'Read-only views for the Django super admin (role autofix_superadmin). Not exposed through PostgREST.';
revoke all on schema superadmin from public;

-- Masking helpers (immutable, no table access).
create function superadmin.mask_phone(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or btrim(p_value) = '' then null
    else '•••' || right(regexp_replace(p_value, '\D', '', 'g'), 3)
  end
$$;

create function superadmin.mask_email(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or position('@' in p_value) = 0 then null
    else left(p_value, 1) || '•••@' || split_part(p_value, '@', 2)
  end
$$;

create function superadmin.mask_registration(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or btrim(p_value) = '' then null
    else left(upper(regexp_replace(p_value, '\s', '', 'g')), 2) || '•••'
  end
$$;

create view superadmin.garages with (security_barrier = true) as
  select
    garage.id,
    garage.slug,
    garage.name,
    garage.plan,
    garage.status,
    garage.timezone,
    garage.mot_enabled,
    garage.accent,
    garage.booking_prefix,
    garage.phone,
    garage.email,
    -- D17's Pro trial. Read from the row as JSON so this view works before and after the plans
    -- migration adds the column (null until then).
    nullif(to_jsonb(garage) ->> 'trial_ends_at', '')::timestamptz as trial_ends_at,
    nullif(garage.settings #>> '{onboarding,started_at}', '')::timestamptz as onboarding_started_at,
    nullif(garage.settings #>> '{onboarding,completed_at}', '')::timestamptz as onboarding_completed_at,
    garage.cancelled_at,
    garage.created_at,
    garage.updated_at
  from public.garages garage;

create view superadmin.garage_members with (security_barrier = true) as
  select member.id, member.garage_id, member.user_id, member.role, coalesce(profile.display_name, '') as display_name,
         member.created_at
  from public.garage_members member
  left join public.admin_profiles profile on profile.user_id = member.user_id;

create view superadmin.garage_invites with (security_barrier = true) as
  select invite.id, invite.garage_id, invite.role, superadmin.mask_email(invite.email) as email_masked,
         invite.expires_at, invite.accepted_at, invite.revoked_at, invite.sent_count, invite.created_at
  from public.garage_invites invite;

create view superadmin.admin_profiles with (security_barrier = true) as
  select profile.user_id, profile.display_name, profile.created_at
  from public.admin_profiles profile;

-- Vitalos staff only, so their sign-in email is shown (it links a Django user to a platform admin).
create view superadmin.platform_admins with (security_barrier = true) as
  select platform_admin.user_id, coalesce(profile.display_name, '') as display_name, account.email::text as email,
         platform_admin.created_at
  from public.platform_admins platform_admin
  left join public.admin_profiles profile on profile.user_id = platform_admin.user_id
  left join auth.users account on account.id = platform_admin.user_id;

create view superadmin.customers with (security_barrier = true) as
  select customer.id, customer.garage_id, customer.name, superadmin.mask_phone(customer.phone) as phone_masked,
         superadmin.mask_email(customer.email) as email_masked, customer.preferred_contact, customer.channel,
         customer.reminder_consent, customer.consent_at, customer.consent_source, customer.opted_out_at,
         customer.anonymised_at, customer.created_at
  from public.customers customer;

create view superadmin.vehicles with (security_barrier = true) as
  select vehicle.id, vehicle.garage_id, vehicle.customer_id, superadmin.mask_registration(vehicle.registration) as registration_masked,
         vehicle.make, vehicle.model, vehicle.year, vehicle.mot_expiry, vehicle.created_at
  from public.vehicles vehicle;

create view superadmin.services with (security_barrier = true) as
  select service.id, service.garage_id, service.name, service.duration_min, service.price_pence, service.online_enabled,
         service.is_mot, service.deleted_at, service.created_at
  from public.services service;

create view superadmin.resources with (security_barrier = true) as
  select resource.id, resource.garage_id, resource.name, resource.kind, resource.active, resource.created_at
  from public.resources resource;

create view superadmin.bookings with (security_barrier = true) as
  select booking.id, booking.garage_id, booking.reference, booking.customer_id, booking.vehicle_id, booking.service_id,
         booking.resource_id, booking.starts_at, booking.ends_at, booking.status, booking.source, booking.location_mode,
         booking.reminder_send_id, booking.price_pence, booking.cancelled_at, booking.deleted_at, booking.created_at
  from public.bookings booking;

create view superadmin.garage_domains with (security_barrier = true) as
  select domain.id, domain.garage_id, domain.hostname, domain.kind, domain.status, domain.last_checked_at, domain.error,
         domain.deleted_at, domain.created_at, domain.updated_at
  from public.garage_domains domain;

-- No payload or dedupe key. last_error is redacted again in the super admin before display.
create view superadmin.jobs with (security_barrier = true) as
  select job.id, job.kind, job.garage_id, job.status, job.attempts, job.max_attempts, job.run_at, job.locked_until,
         job.last_error, job.finished_at, job.created_at, job.updated_at
  from public.jobs job;

create view superadmin.reminder_sends with (security_barrier = true) as
  select send.id, send.garage_id, send.kind, send.channel, send.status, send.skip_reason, send.send_at, send.sent_at,
         send.opened_at, send.booking_id, send.error_code, send.created_at, send.updated_at
  from public.reminder_sends send;

-- No bodies and no addresses.
create view superadmin.messages with (security_barrier = true) as
  select message.id, message.garage_id, message.channel, message.direction, message.provider, message.status,
         message.reminder_send_id, message.booking_id, message.call_id, message.error_code, message.created_at,
         message.updated_at
  from public.messages message;

create view superadmin.calls with (security_barrier = true) as
  select call.id, call.garage_id, call.status, call.dial_status, call.missed, call.duration_s, call.text_back_message_id,
         call.handled_at, call.created_at
  from public.calls call;

create view superadmin.garage_agreements with (security_barrier = true) as
  select agreement.id, agreement.garage_id, agreement.kind, agreement.version, agreement.text_hash,
         agreement.accepted_by_name, agreement.accepted_by_role, agreement.accepted_at
  from public.garage_agreements agreement;

create view superadmin.platform_audit_log with (security_barrier = true) as
  select entry.id, entry.actor_id, coalesce(profile.display_name, 'Vitalos support') as actor_name, entry.action,
         entry.target_garage_id, entry.entity_type, entry.entity_id, entry.reason, entry.detail, entry.created_at
  from public.platform_audit_log entry
  left join public.admin_profiles profile on profile.user_id = entry.actor_id;

create view superadmin.platform_impersonations with (security_barrier = true) as
  select session.id, session.garage_id, session.admin_user_id, coalesce(profile.display_name, 'Vitalos support') as admin_name,
         session.reason, session.started_at, session.expires_at, session.ended_at, session.end_reason
  from public.platform_impersonations session
  left join public.admin_profiles profile on profile.user_id = session.admin_user_id;

-- ---------------------------------------------------------------------------
-- 3. Domain re-check (platform admin at AAL2, reason required, audited)
-- ---------------------------------------------------------------------------

create function public.platform_request_domains_check(p_domain_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cleaned text;
  domain_row record;
  bucket timestamptz;
  job public.jobs%rowtype;
begin
  perform public.require_platform_admin();
  cleaned := public.clean_platform_reason(p_reason);
  select domain.id, domain.garage_id, domain.hostname, domain.kind, domain.status into domain_row
  from public.garage_domains domain
  where domain.id = p_domain_id and domain.deleted_at is null;
  if not found then
    raise exception 'DOMAIN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if domain_row.kind <> 'custom' or domain_row.status not in ('pending_dns', 'verifying') then
    raise exception 'DOMAIN_NOT_CHECKABLE: only custom domains waiting for DNS or verification' using errcode = '22023';
  end if;

  -- One queued check per 5-minute window, however many domains or admins ask.
  bucket := date_trunc('hour', now()) + make_interval(mins => (extract(minute from now())::integer / 5) * 5);
  job := public.enqueue_job('domains.check', '{}'::jsonb, now(), 'domains.check:platform:' || to_char(bucket at time zone 'UTC', 'YYYYMMDDHH24MI'), null);

  perform public.record_platform_action('platform.domain_check_requested', domain_row.garage_id, 'garage_domain', domain_row.id::text,
    cleaned, jsonb_build_object('hostname', domain_row.hostname, 'job_id', job.id));
  return jsonb_build_object('job_id', job.id, 'job_status', job.status, 'run_at', job.run_at);
end
$$;

comment on function public.platform_request_domains_check(uuid, text) is
  'P5.1: platform admin at AAL2 queues the domains.check job (deduplicated per 5 minutes) for a pending custom domain, with a reason. Audited.';

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

revoke all on all tables in schema superadmin from public, anon, authenticated;
revoke all on all functions in schema superadmin from public, anon, authenticated;
revoke all on function public.platform_request_domains_check(uuid, text) from public, anon, authenticated;

grant usage on schema superadmin to autofix_superadmin;
grant select on all tables in schema superadmin to autofix_superadmin;
grant execute on all functions in schema superadmin to autofix_superadmin;

grant usage on schema public to autofix_superadmin;
grant execute on function
  public.platform_update_garage(uuid, text, text, text),
  public.platform_retry_job(uuid, text),
  public.platform_request_domains_check(uuid, text)
to autofix_superadmin;
