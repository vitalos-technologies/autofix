-- Autofix is now Pitline (DECISIONS D23): free links move from
-- <slug>.autofix.vitalos.co.uk to <slug>.pitline.co.uk. The app resolves free
-- links from the slug and the tenant root, so the only stored full hostnames
-- are garage_domains rows of kind 'subdomain'. This migration:
--
--   garage_domains.hostname  'subdomain' rows ending .autofix.vitalos.co.uk
--                           now end .pitline.co.uk. Custom domains (kind
--                           'custom') are never touched. A row whose new name
--                           is already held by a live row is left as it is.
--                           Idempotent: a second run matches nothing.
--   garages (comment)       names the new free link.
--
-- Old free links keep working: the proxy redirects them (src/lib/tenancy/legacy-hosts.ts).
--
-- Rollback (manual, the same statement the other way round):
--   update public.garage_domains d
--      set hostname = left(d.hostname, -char_length('.pitline.co.uk')) || '.autofix.vitalos.co.uk'
--    where d.kind = 'subdomain'
--      and right(d.hostname, char_length('.pitline.co.uk')) = '.pitline.co.uk'
--      and char_length(d.hostname) - char_length('.pitline.co.uk') + char_length('.autofix.vitalos.co.uk') <= 253
--      and not exists (
--        select 1 from public.garage_domains other
--         where other.deleted_at is null
--           and other.hostname = left(d.hostname, -char_length('.pitline.co.uk')) || '.autofix.vitalos.co.uk');
--   and the garages comment from 20261026000100_tenancy.sql.

update public.garage_domains d
   set hostname = left(d.hostname, -char_length('.autofix.vitalos.co.uk')) || '.pitline.co.uk'
 where d.kind = 'subdomain'
   and right(d.hostname, char_length('.autofix.vitalos.co.uk')) = '.autofix.vitalos.co.uk'
   and not exists (
     select 1 from public.garage_domains other
      where other.deleted_at is null
        and other.hostname = left(d.hostname, -char_length('.autofix.vitalos.co.uk')) || '.pitline.co.uk');

comment on table public.garages is 'One row per tenant. The slug gives the free link <slug>.pitline.co.uk.';
