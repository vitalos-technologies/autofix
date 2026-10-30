-- One-month free trial (DECISIONS D25: Pitline is a new company, so new garages
-- get Pro free for one calendar month instead of 14 days). This migration:
--
--   garages.trial_ends_at default
--                           now() + interval '1 month' (was 14 days). Sign-up
--                           relies on the default; group sites copy their home
--                           garage's trial (group_add_site, garage_groups_sync_plan).
--   running trials          a garage still on its Pro trial (plan 'pro', no plan
--                           chosen, trial_ends_at in the future) now ends one
--                           calendar month after it started. The start is
--                           created_at (the trial began at sign-up). A trial is
--                           never shortened, and a second run changes nothing.
--                           Only home and stand-alone garages are updated; the
--                           garages_group_plan_sync trigger then gives each
--                           group's other sites the same end, as it always does.
--
-- Rollback (manual): alter column trial_ends_at set default (now() + interval
-- '14 days'), and restore both comments from 20261029000100_plans.sql. Extended
-- trials are left as they are: shortening a trial a garage was told about is
-- not a rollback we would run.

alter table public.garages
  alter column trial_ends_at set default (now() + interval '1 month');

comment on column public.garages.plan is
  'essentials or pro (D17). pro with trial_ends_at set is the one-month Pro trial (D25). Use garage_effective_plan() for what the garage may use now.';
comment on column public.garages.trial_ends_at is
  'End of the Pro trial; null when not on trial. New garages get now() + 1 month (D25).';

update public.garages g
   set trial_ends_at = g.created_at + interval '1 month'
 where g.plan = 'pro'
   and g.plan_chosen is null
   and g.trial_ends_at > now()
   and g.created_at + interval '1 month' > g.trial_ends_at
   and not exists (
     select 1 from public.garage_group_sites site
      where site.garage_id = g.id
        and site.home_garage_id <> g.id);
