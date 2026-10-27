-- P4.3 Booking page & domain settings, P4.6 Askbridge.
--
-- No new tables. Two things live in the database:
--
--   1. public.set_booking_page_settings(p_embed_origins, p_askbridge): the owner's
--      only way to change garages.settings.embedOrigins (sites allowed to frame the
--      booking pages; the proxy turns them into CSP frame-ancestors) and
--      garages.settings.askbridge ({enabled, widgetId}). One atomic jsonb merge, so
--      it never overwrites other settings keys (faqs, invoicePayment, tagline).
--
--   2. askbridge.sync jobs: after a change to what Askbridge knows about a garage
--      (profile, services, opening hours, closures, FAQs, the widget setting, the
--      live custom domain), one job per garage per minute is queued for the minute
--      after, through public.enqueue_job (dedupe key
--      'askbridge.sync:<garage id>:<UTC minute>'). Only for garages with the widget
--      on that are active or onboarding. The runner calls runAskbridgeSync()
--      (src/lib/askbridge/sync.ts).
--
-- enqueue_job is created by 20261028001000_reminders.sql, which sorts after this
-- file: the trigger function looks it up at run time and does nothing until it
-- exists.

-- ---------------------------------------------------------------------------
-- 1. Booking page settings (owner only)
-- ---------------------------------------------------------------------------

create function public.set_booking_page_settings(
  p_embed_origins jsonb default null,
  p_askbridge jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  garage uuid := public.current_garage_id();
  patch jsonb := '{}'::jsonb;
  origin jsonb;
  widget text;
  result jsonb;
begin
  if garage is null or auth.uid() is null or public.current_garage_role() is distinct from 'owner' then
    raise exception 'FORBIDDEN: only the garage owner can change the booking page' using errcode = '42501';
  end if;

  if p_embed_origins is not null then
    if jsonb_typeof(p_embed_origins) <> 'array' or jsonb_array_length(p_embed_origins) > 10 then
      raise exception 'INVALID_SETTINGS: embed origins must be a list of up to 10' using errcode = '22023';
    end if;
    for origin in select value from jsonb_array_elements(p_embed_origins) loop
      if jsonb_typeof(origin) <> 'string'
        or char_length(origin #>> '{}') > 270
        or (origin #>> '{}') !~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:[0-9]{1,5})?$' then
        raise exception 'INVALID_SETTINGS: embed origins must be https origins' using errcode = '22023';
      end if;
    end loop;
    patch := patch || jsonb_build_object('embedOrigins', p_embed_origins);
  end if;

  if p_askbridge is not null then
    if jsonb_typeof(p_askbridge) <> 'object' or jsonb_typeof(p_askbridge -> 'enabled') is distinct from 'boolean' then
      raise exception 'INVALID_SETTINGS: askbridge must be {enabled, widgetId}' using errcode = '22023';
    end if;
    widget := p_askbridge ->> 'widgetId';
    if (widget is not null and widget !~ '^[A-Za-z0-9_-]{4,64}$')
      or ((p_askbridge ->> 'enabled')::boolean and widget is null)
      or exists (select 1 from jsonb_object_keys(p_askbridge) key where key not in ('enabled', 'widgetId')) then
      raise exception 'INVALID_SETTINGS: askbridge must be {enabled, widgetId}' using errcode = '22023';
    end if;
    patch := patch || jsonb_build_object('askbridge', jsonb_build_object('enabled', (p_askbridge ->> 'enabled')::boolean, 'widgetId', widget));
  end if;

  update public.garages g
     set settings = coalesce(g.settings, '{}'::jsonb) || patch
   where g.id = garage
  returning jsonb_build_object(
    'embedOrigins', coalesce(g.settings -> 'embedOrigins', '[]'::jsonb),
    'askbridge', coalesce(g.settings -> 'askbridge', '{"enabled": false, "widgetId": null}'::jsonb)
  ) into result;
  return result;
end
$$;

comment on function public.set_booking_page_settings(jsonb, jsonb) is
  'P4.3/P4.6: owner of the selected garage sets settings.embedOrigins (https origins, <= 10) and/or settings.askbridge {enabled, widgetId}. Null leaves a key unchanged.';

revoke all on function public.set_booking_page_settings(jsonb, jsonb) from public, anon;
grant execute on function public.set_booking_page_settings(jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. askbridge.sync jobs
-- ---------------------------------------------------------------------------

create function public.enqueue_askbridge_sync(p_garage_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  minute timestamptz := date_trunc('minute', now());
begin
  if p_garage_id is null then
    return;
  end if;
  -- A garage that is being deleted (cascades) is no longer visible here.
  if not exists (
    select 1 from public.garages g
     where g.id = p_garage_id
       and g.status in ('active', 'onboarding')
       and coalesce(g.settings -> 'askbridge' ->> 'enabled', 'false') = 'true'
  ) then
    return;
  end if;
  if to_regprocedure('public.enqueue_job(text,jsonb,timestamptz,text,uuid)') is null then
    return;
  end if;
  perform public.enqueue_job(
    'askbridge.sync',
    jsonb_build_object('garageId', p_garage_id),
    minute + interval '1 minute',
    'askbridge.sync:' || p_garage_id::text || ':' || to_char(minute at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
    p_garage_id
  );
end
$$;

comment on function public.enqueue_askbridge_sync(uuid) is
  'P4.6: queue askbridge.sync for a garage with the widget on (one job per garage per UTC minute, run the minute after). Service role and triggers only.';

revoke all on function public.enqueue_askbridge_sync(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_askbridge_sync(uuid) to service_role;

create function public.askbridge_sync_after_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'garages' then
    perform public.enqueue_askbridge_sync(new.id);
  elsif tg_op = 'DELETE' then
    perform public.enqueue_askbridge_sync(old.garage_id);
  else
    perform public.enqueue_askbridge_sync(new.garage_id);
  end if;
  return null;
end
$$;

revoke all on function public.askbridge_sync_after_change() from public, anon, authenticated, service_role;

-- What garage_profile shows (plus status, so a reactivated garage syncs, and the widget setting).
create trigger garages_askbridge_sync
  after update on public.garages
  for each row
  when (
    old.name is distinct from new.name
    or old.slug is distinct from new.slug
    or old.phone is distinct from new.phone
    or old.whatsapp is distinct from new.whatsapp
    or old.email is distinct from new.email
    or old.address is distinct from new.address
    or old.timezone is distinct from new.timezone
    or old.mot_enabled is distinct from new.mot_enabled
    or old.approve_online is distinct from new.approve_online
    or old.service_area is distinct from new.service_area
    or old.cancellation_cutoff_h is distinct from new.cancellation_cutoff_h
    or old.status is distinct from new.status
    or (old.settings -> 'faqs') is distinct from (new.settings -> 'faqs')
    or (old.settings -> 'askbridge') is distinct from (new.settings -> 'askbridge')
  )
  execute function public.askbridge_sync_after_change();

create trigger services_askbridge_sync
  after insert or update or delete on public.services
  for each row execute function public.askbridge_sync_after_change();

create trigger opening_hours_askbridge_sync
  after insert or update or delete on public.opening_hours
  for each row execute function public.askbridge_sync_after_change();

create trigger closures_askbridge_sync
  after insert or update or delete on public.closures
  for each row execute function public.askbridge_sync_after_change();

-- The booking link changes when a custom domain goes live or is retired; the
-- 5-minute last_checked_at bumps of domains.check do not queue anything.
create trigger garage_domains_askbridge_sync
  after update of status, deleted_at on public.garage_domains
  for each row
  when (old.status is distinct from new.status or old.deleted_at is distinct from new.deleted_at)
  execute function public.askbridge_sync_after_change();
