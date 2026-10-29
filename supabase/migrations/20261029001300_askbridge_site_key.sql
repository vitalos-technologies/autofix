-- Askbridge as it really ships (P4.6 revisited; Temitope, 29 Oct 2026).
--
-- Askbridge has no partner knowledge API: it learns by crawling the business's
-- own website, and each garage installs it with its own workspace's site key
-- (`pk_` + 32 hex, Askbridge app.sites.site_key). See docs/autofix/askbridge.md.
-- No new tables. This migration:
--
--   askbridge.sync          removed. The triggers that queued it after profile,
--                           service, hours, closure, FAQ and domain changes and
--                           their functions (enqueue_askbridge_sync,
--                           askbridge_sync_after_change) are dropped. jobs.kind
--                           has no list of kinds, so the kind simply goes
--                           unused; any askbridge.sync job still queued or
--                           running is closed as failed (the runner no longer
--                           claims it, and it would hold the oldest-queued
--                           figure in job health for ever).
--   set_booking_page_settings(p_embed_origins, p_askbridge)
--                           same signature and grants; settings.askbridge is
--                           now {enabled, siteKey} with siteKey
--                           ^pk_[0-9a-f]{32}$ (enabled needs a key).
--   garages.settings.askbridge
--                           a stored widgetId that is already a valid site key
--                           becomes siteKey. Any other widgetId is left as it
--                           is: the app ignores it (the chat reads as off) and
--                           the owner's next save replaces the object.
--
-- Rollback (manual): recreate set_booking_page_settings, the functions and the
-- five triggers from 20261028000600_domains_askbridge.sql.

-- ---------------------------------------------------------------------------
-- 1. The knowledge sync
-- ---------------------------------------------------------------------------

drop trigger if exists garages_askbridge_sync on public.garages;
drop trigger if exists services_askbridge_sync on public.services;
drop trigger if exists opening_hours_askbridge_sync on public.opening_hours;
drop trigger if exists closures_askbridge_sync on public.closures;
drop trigger if exists garage_domains_askbridge_sync on public.garage_domains;

drop function if exists public.askbridge_sync_after_change();
drop function if exists public.enqueue_askbridge_sync(uuid);

update public.jobs
   set status = 'failed',
       locked_until = null,
       finished_at = now(),
       updated_at = now(),
       last_error = 'ASKBRIDGE_SYNC_RETIRED: Askbridge learns from the garage''s website; Autofix no longer sends it knowledge'
 where kind = 'askbridge.sync'
   and status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- 2. Booking page settings (owner only): {enabled, siteKey}
-- ---------------------------------------------------------------------------

create or replace function public.set_booking_page_settings(
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
  site_key text;
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
      raise exception 'INVALID_SETTINGS: askbridge must be {enabled, siteKey}' using errcode = '22023';
    end if;
    site_key := p_askbridge ->> 'siteKey';
    if (site_key is not null and site_key !~ '^pk_[0-9a-f]{32}$')
      or ((p_askbridge ->> 'enabled')::boolean and site_key is null)
      or exists (select 1 from jsonb_object_keys(p_askbridge) key where key not in ('enabled', 'siteKey')) then
      raise exception 'INVALID_SETTINGS: askbridge must be {enabled, siteKey}' using errcode = '22023';
    end if;
    patch := patch || jsonb_build_object('askbridge', jsonb_build_object('enabled', (p_askbridge ->> 'enabled')::boolean, 'siteKey', site_key));
  end if;

  update public.garages g
     set settings = coalesce(g.settings, '{}'::jsonb) || patch
   where g.id = garage
  returning jsonb_build_object(
    'embedOrigins', coalesce(g.settings -> 'embedOrigins', '[]'::jsonb),
    'askbridge', coalesce(g.settings -> 'askbridge', '{"enabled": false, "siteKey": null}'::jsonb)
  ) into result;
  return result;
end
$$;

comment on function public.set_booking_page_settings(jsonb, jsonb) is
  'P4.3/P4.6: owner of the selected garage sets settings.embedOrigins (https origins, <= 10) and/or settings.askbridge {enabled, siteKey} (siteKey: the garage''s Askbridge site key, pk_ + 32 hex). Null leaves a key unchanged.';

-- ---------------------------------------------------------------------------
-- 3. Stored widget ids that are already site keys
-- ---------------------------------------------------------------------------

update public.garages g
   set settings = jsonb_set(
         g.settings,
         '{askbridge}',
         jsonb_build_object(
           'enabled', coalesce(g.settings -> 'askbridge' -> 'enabled' = 'true'::jsonb, false),
           'siteKey', g.settings -> 'askbridge' ->> 'widgetId'
         )
       )
 where jsonb_typeof(g.settings -> 'askbridge') = 'object'
   and not (g.settings -> 'askbridge' ? 'siteKey')
   and (g.settings -> 'askbridge' ->> 'widgetId') ~ '^pk_[0-9a-f]{32}$';
