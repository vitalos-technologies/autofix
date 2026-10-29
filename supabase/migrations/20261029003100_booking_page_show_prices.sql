-- Hide prices per garage (Temitope, 29 Oct 2026).
--
-- A garage can turn off "Show prices on my booking page". The setting lives
-- in garages.settings with the other booking-page settings, written only
-- through set_booking_page_settings() (owner of the selected garage):
--
--   garages.settings.showPrices  boolean. Absent means true, so every
--                                existing garage keeps showing prices.
--                                false hides service prices on the booking
--                                site (service list, GET /api/services).
--                                Deposits, payment links, service plan
--                                Direct Debits and health-check approvals
--                                always show their amounts: the customer
--                                pays or agrees to them.
--
--   set_booking_page_settings(p_embed_origins, p_askbridge, p_show_prices)
--                                the 2-argument function is replaced by a
--                                3-argument one (p_show_prices boolean
--                                default null; null leaves it unchanged).
--                                Same checks, same grants; calls that name
--                                only the first two keep working.
--
-- No new tables. Rollback (manual): drop function
-- public.set_booking_page_settings(jsonb, jsonb, boolean) and recreate the
-- 2-argument function from 20261029001300_askbridge_site_key.sql. A stored
-- showPrices key stays; `settings - 'showPrices'` shows prices again.

drop function if exists public.set_booking_page_settings(jsonb, jsonb);

create function public.set_booking_page_settings(
  p_embed_origins jsonb default null,
  p_askbridge jsonb default null,
  p_show_prices boolean default null
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

  if p_show_prices is not null then
    patch := patch || jsonb_build_object('showPrices', p_show_prices);
  end if;

  update public.garages g
     set settings = coalesce(g.settings, '{}'::jsonb) || patch
   where g.id = garage
  returning jsonb_build_object(
    'embedOrigins', coalesce(g.settings -> 'embedOrigins', '[]'::jsonb),
    'askbridge', coalesce(g.settings -> 'askbridge', '{"enabled": false, "siteKey": null}'::jsonb),
    'showPrices', coalesce(g.settings -> 'showPrices', 'true'::jsonb)
  ) into result;
  return result;
end
$$;

comment on function public.set_booking_page_settings(jsonb, jsonb, boolean) is
  'P4.3/P4.6 + 29 Oct 2026: owner of the selected garage sets settings.embedOrigins (https origins, <= 10), settings.askbridge {enabled, siteKey} (siteKey: the garage''s Askbridge site key, pk_ + 32 hex) and/or settings.showPrices (boolean; absent = true). Null leaves a key unchanged.';

revoke all on function public.set_booking_page_settings(jsonb, jsonb, boolean) from public, anon;
grant execute on function public.set_booking_page_settings(jsonb, jsonb, boolean) to authenticated;
