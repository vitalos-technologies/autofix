-- P5.9: multi-site (Pro feature `multi_site`; D17 "several sites under one
-- login with group reporting (each extra site charged)"; DECISIONS A358-A365,
-- docs/autofix/phase-5/P5.9-multi-site.md).
--
--   1. garage_groups: one group per HOME garage (garage_id = the home garage;
--      the group's plan and billing live there). garage_group_sites: one row
--      per member garage (garage_id = that site; a garage is in at most one
--      group; the home garage is a site of its own group). Both are ordinary
--      tenant tables: RLS, owners and managers of the selected garage read
--      their own garage's row, nobody writes directly (functions below).
--   2. Group reads (group_summary(), group_overview(), group_report()) are
--      security definer and start from the member's SELECTED garage
--      (current_garage_id(), x-garage-id). They aggregate only sites of that
--      garage's group where the caller is owner or manager, never a garage id
--      from the request. overview/report need multi_site on the home garage.
--   3. group_add_site(p_garage): the owner of the selected garage (and of the
--      home garage) creates another garage with create_garage() (wrapped, not
--      replaced): defaults seeded, the caller is its owner, it joins the group
--      and takes the home garage's plan (no separate trial).
--      group_remove_site(p_site): the owner of both takes a site out of the
--      group (the garage and its data stay; it drops to Essentials).
--   4. record_group_extra_sites(home, provider) (service role): writes the
--      number of sites beyond the first to garage_subscriptions.extra_sites
--      after the billing provider was told (setExtraSites()).
--   5. A trigger keeps every site's plan columns equal to the home garage's,
--      so trial expiry, billing webhooks and Vitalos plan changes on the home
--      garage reach the whole group, and the app's plan checks (which read the
--      selected garage's own columns) agree with the SQL ones.
--
-- Does not touch create_booking*, available_slots*, staff_available_slots* or
-- create_garage() itself.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.garage_groups (
  id uuid primary key default gen_random_uuid(),
  -- The home garage: the group's plan, subscription and extra-site charge live here.
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint garage_groups_garage_key unique (garage_id),
  constraint garage_groups_id_garage_key unique (id, garage_id),
  constraint garage_groups_name_check check (char_length(btrim(name)) between 1 and 120)
);

comment on table public.garage_groups is
  'P5.9: a group of garages (multi-site, Pro). garage_id is the HOME garage, whose plan and subscription cover the group. Written only by group_add_site().';

create table public.garage_group_sites (
  id uuid primary key default gen_random_uuid(),
  -- The member garage (site).
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  group_id uuid not null,
  home_garage_id uuid not null,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  constraint garage_group_sites_garage_key unique (garage_id),
  constraint garage_group_sites_group_fkey foreign key (group_id, home_garage_id)
    references public.garage_groups (id, garage_id) on delete cascade
);

comment on table public.garage_group_sites is
  'P5.9: one row per garage in a group (the home garage included). garage_id is the site; (group_id, home_garage_id) points at its group. A garage is in at most one group. Written only by group_add_site()/group_remove_site().';

create index garage_group_sites_group_idx on public.garage_group_sites (group_id, added_at);
create index garage_group_sites_home_idx on public.garage_group_sites (home_garage_id);

alter table public.garage_groups enable row level security;
alter table public.garage_group_sites enable row level security;

-- garage_groups
--   "owners and managers read their group"  select  owners/managers of the selected (home) garage
--   (no write policies: group_add_site() writes as security definer)
create policy "owners and managers read their group" on public.garage_groups
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

-- garage_group_sites
--   "owners and managers read their site row"  select  owners/managers of the selected garage, its own row only
--   (no write policies: group_add_site()/group_remove_site() write as security definer)
create policy "owners and managers read their site row" on public.garage_group_sites
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

revoke all on public.garage_groups from anon, authenticated;
revoke all on public.garage_group_sites from anon, authenticated;
grant select on public.garage_groups to authenticated;
grant select on public.garage_group_sites to authenticated;
grant select, insert, update, delete on public.garage_groups to service_role;
grant select, insert, update, delete on public.garage_group_sites to service_role;

-- ---------------------------------------------------------------------------
-- 2. Helpers (internal: no grants to authenticated)
-- ---------------------------------------------------------------------------

-- The home garage of the group a garage is in, or null when it is in none.
create function public.garage_group_home(p_garage_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select site.home_garage_id from public.garage_group_sites site where site.garage_id = p_garage_id
$$;

comment on function public.garage_group_home(uuid) is
  'P5.9 (internal): the home garage of the garage''s group, or null. Service role and other definer functions only.';

-- The garages a group read may aggregate for the caller: every site of the
-- selected garage's group (or the selected garage alone when it is in no
-- group) where the caller is owner or manager. Raises 42501 unless the caller
-- is owner or manager of the selected garage.
create function public.group_visible_sites()
returns table (garage_id uuid, home_garage_id uuid, is_home boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  selected uuid := public.current_garage_id();
  home uuid;
begin
  if auth.uid() is null or selected is null or coalesce(public.garage_role(selected), '') not in ('owner', 'manager') then
    raise exception 'GROUP_FORBIDDEN: owners and managers only' using errcode = '42501';
  end if;
  home := coalesce(public.garage_group_home(selected), selected);
  return query
  select site_id, home, site_id = home
  from (
    select site.garage_id as site_id from public.garage_group_sites site where site.home_garage_id = home
    union
    select selected
  ) sites
  join public.garages garage on garage.id = sites.site_id
  where public.garage_role(sites.site_id) in ('owner', 'manager')
    and garage.status <> 'cancelled';
end
$$;

comment on function public.group_visible_sites() is
  'P5.9 (internal): sites of the selected garage''s group the caller is owner/manager of. Used by group_overview() and group_report().';

-- ---------------------------------------------------------------------------
-- 3. Group reads
-- ---------------------------------------------------------------------------

-- What the caller's group looks like from the selected garage. No plan check
-- (the page shows the locked state with it). One row; group_id null when the
-- selected garage is in no group.
create function public.group_summary()
returns table (
  group_id uuid,
  group_name text,
  home_garage_id uuid,
  is_home boolean,
  site_count integer,
  visible_sites integer,
  can_add_sites boolean,
  multi_site boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  selected uuid := public.current_garage_id();
  home uuid;
  the_group public.garage_groups%rowtype;
begin
  if auth.uid() is null or selected is null or coalesce(public.garage_role(selected), '') not in ('owner', 'manager') then
    raise exception 'GROUP_FORBIDDEN: owners and managers only' using errcode = '42501';
  end if;
  home := coalesce(public.garage_group_home(selected), selected);
  select * into the_group from public.garage_groups g where g.garage_id = home;
  return query
  select
    the_group.id,
    the_group.name,
    home,
    home = selected,
    coalesce((select count(*)::integer from public.garage_group_sites site where site.home_garage_id = home), 1),
    (select count(*)::integer from public.group_visible_sites()),
    coalesce(public.garage_role(selected) = 'owner' and public.garage_role(home) = 'owner', false)
      and coalesce(public.garage_effective_plan(home) = 'pro', false),
    coalesce(public.garage_effective_plan(home) = 'pro', false);
end
$$;

comment on function public.group_summary() is
  'P5.9: the selected garage''s group (id, home, site count, whether the caller may add sites, whether the home garage has multi_site). Owners and managers of the selected garage.';

-- Per site: bookings today, open requests, revenue this month (issued or paid
-- invoices issued this month) and reminder work won back this month (as
-- reminder_won_back()), each in the site's own time zone.
create function public.group_overview(p_now timestamptz default now())
returns table (
  garage_id uuid,
  name text,
  slug text,
  accent text,
  is_home boolean,
  is_selected boolean,
  today_bookings integer,
  open_requests integer,
  revenue_month_pence bigint,
  won_back_bookings integer,
  won_back_pence bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  selected uuid := public.current_garage_id();
  home uuid;
begin
  if auth.uid() is null or selected is null or coalesce(public.garage_role(selected), '') not in ('owner', 'manager') then
    raise exception 'GROUP_FORBIDDEN: owners and managers only' using errcode = '42501';
  end if;
  home := coalesce(public.garage_group_home(selected), selected);
  if coalesce(public.garage_effective_plan(home), 'essentials') <> 'pro' then
    raise exception 'PLAN_REQUIRED: multi_site' using errcode = 'P0001', hint = 'pro';
  end if;
  p_now := coalesce(p_now, now());

  return query
  select
    garage.id,
    garage.name,
    garage.slug,
    garage.accent,
    visible.is_home,
    garage.id = selected,
    (
      select count(*)::integer from public.bookings booking
      where booking.garage_id = garage.id
        and booking.deleted_at is null
        and booking.status not in ('requested', 'cancelled', 'no_show')
        and booking.starts_at >= (lt.today::timestamp at time zone garage.timezone)
        and booking.starts_at < ((lt.today + 1)::timestamp at time zone garage.timezone)
    ),
    (
      select count(*)::integer from public.bookings booking
      where booking.garage_id = garage.id
        and booking.deleted_at is null
        and booking.status = 'requested'
        and booking.ends_at >= p_now
    ),
    (
      select coalesce(sum(invoice.total_pence), 0)::bigint from public.invoices invoice
      where invoice.garage_id = garage.id
        and invoice.deleted_at is null
        and invoice.status in ('issued', 'paid')
        and invoice.issued_at >= (lt.month_start::timestamp at time zone garage.timezone)
        and invoice.issued_at < ((lt.today + 1)::timestamp at time zone garage.timezone)
    ),
    won.bookings,
    won.pence
  from public.group_visible_sites() visible
  join public.garages garage on garage.id = visible.garage_id
  cross join lateral (
    select (p_now at time zone garage.timezone)::date as today,
           date_trunc('month', p_now at time zone garage.timezone)::date as month_start
  ) lt
  cross join lateral public.reminder_won_back(garage.id, lt.month_start, lt.today) won
  order by visible.is_home desc, garage.name, garage.id;
end
$$;

comment on function public.group_overview(timestamptz) is
  'P5.9: per-site figures for /app/group (today''s bookings, open requests, revenue this month, reminder work won back this month) for the sites of the selected garage''s group the caller is owner/manager of. PLAN_REQUIRED: multi_site unless the home garage has Pro.';

-- Bookings and revenue per site over local dates p_from..p_to (inclusive,
-- each site's time zone; at most 366 days). Bookings: starting in the range,
-- not requested/cancelled/no-show, not trashed. Revenue: issued or paid
-- invoices issued in the range.
create function public.group_report(p_from date, p_to date)
returns table (
  garage_id uuid,
  name text,
  is_home boolean,
  bookings integer,
  revenue_pence bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  selected uuid := public.current_garage_id();
  home uuid;
begin
  if auth.uid() is null or selected is null or coalesce(public.garage_role(selected), '') not in ('owner', 'manager') then
    raise exception 'GROUP_FORBIDDEN: owners and managers only' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'INVALID_RANGE: from <= to, at most 366 days' using errcode = '22023';
  end if;
  home := coalesce(public.garage_group_home(selected), selected);
  if coalesce(public.garage_effective_plan(home), 'essentials') <> 'pro' then
    raise exception 'PLAN_REQUIRED: multi_site' using errcode = 'P0001', hint = 'pro';
  end if;

  return query
  select
    garage.id,
    garage.name,
    visible.is_home,
    (
      select count(*)::integer from public.bookings booking
      where booking.garage_id = garage.id
        and booking.deleted_at is null
        and booking.status not in ('requested', 'cancelled', 'no_show')
        and booking.starts_at >= (p_from::timestamp at time zone garage.timezone)
        and booking.starts_at < ((p_to + 1)::timestamp at time zone garage.timezone)
    ),
    (
      select coalesce(sum(invoice.total_pence), 0)::bigint from public.invoices invoice
      where invoice.garage_id = garage.id
        and invoice.deleted_at is null
        and invoice.status in ('issued', 'paid')
        and invoice.issued_at >= (p_from::timestamp at time zone garage.timezone)
        and invoice.issued_at < ((p_to + 1)::timestamp at time zone garage.timezone)
    )
  from public.group_visible_sites() visible
  join public.garages garage on garage.id = visible.garage_id
  order by visible.is_home desc, garage.name, garage.id;
end
$$;

comment on function public.group_report(date, date) is
  'P5.9: bookings and revenue per site over a local date range (<= 366 days) for the sites of the selected garage''s group the caller is owner/manager of. PLAN_REQUIRED: multi_site unless the home garage has Pro.';

-- ---------------------------------------------------------------------------
-- 4. Adding and removing sites
-- ---------------------------------------------------------------------------

-- The owner of the selected garage (MFA as garage_actor_allowed()) who also
-- owns the home garage creates another garage in the group. p_garage is
-- create_garage()'s payload. The new garage takes the home garage's plan
-- (no trial of its own). Errors: GROUP_FORBIDDEN (42501), PLAN_REQUIRED:
-- multi_site (P0001), GROUP_FULL (P0001), and create_garage()'s own codes.
create function public.group_add_site(p_garage jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  selected uuid := public.current_garage_id();
  caller uuid := auth.uid();
  home uuid;
  home_row public.garages%rowtype;
  the_group public.garage_groups%rowtype;
  created jsonb;
  new_garage uuid;
  sites integer;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.garage_role(selected) is distinct from 'owner' then
    raise exception 'GROUP_FORBIDDEN: only the owner can add a site' using errcode = '42501';
  end if;
  home := coalesce(public.garage_group_home(selected), selected);
  if public.garage_role(home) is distinct from 'owner' then
    raise exception 'GROUP_FORBIDDEN: only the owner of the home garage can add a site' using errcode = '42501';
  end if;
  if coalesce(public.garage_effective_plan(home), 'essentials') <> 'pro' then
    raise exception 'PLAN_REQUIRED: multi_site' using errcode = 'P0001', hint = 'pro';
  end if;

  select * into home_row from public.garages where id = home for update;

  select * into the_group from public.garage_groups g where g.garage_id = home;
  if not found then
    insert into public.garage_groups (garage_id, name, created_by)
    values (home, home_row.name, caller)
    returning * into the_group;
    insert into public.garage_group_sites (garage_id, group_id, home_garage_id, added_by)
    values (home, the_group.id, home, caller);
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (home, caller, 'group.created', 'garage_group', the_group.id::text, '{}'::jsonb);
  end if;

  select count(*)::integer into sites from public.garage_group_sites site where site.home_garage_id = home;
  if sites >= 101 then
    raise exception 'GROUP_FULL' using errcode = 'P0001';
  end if;

  created := public.create_garage(caller, p_garage);
  new_garage := (created ->> 'garage_id')::uuid;

  -- The group's plan, not a separate trial.
  update public.garages
  set plan = home_row.plan,
      trial_ends_at = home_row.trial_ends_at,
      plan_chosen = home_row.plan_chosen,
      plan_changed_at = now()
  where id = new_garage;

  insert into public.garage_group_sites (garage_id, group_id, home_garage_id, added_by)
  values (new_garage, the_group.id, home, caller);
  sites := sites + 1;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values
    (home, caller, 'group.site_added', 'garage', new_garage::text, jsonb_build_object('sites', sites)),
    (new_garage, caller, 'group.joined', 'garage_group', the_group.id::text, jsonb_build_object('home_garage_id', home));

  return jsonb_build_object(
    'garage_id', new_garage,
    'slug', created ->> 'slug',
    'group_id', the_group.id,
    'home_garage_id', home,
    'site_count', sites,
    'extra_sites', greatest(sites - 1, 0)
  );
end
$$;

comment on function public.group_add_site(jsonb) is
  'P5.9: the owner of the selected garage and of its group''s home garage creates another garage (create_garage(), defaults seeded, caller is owner) in the group, on the group''s plan. Needs multi_site on the home garage. Audited group.site_added / group.joined.';

-- The owner of the selected garage (in its group) and of the site takes the
-- site out of the group. The home garage cannot leave. The garage and its data
-- stay; it drops to Essentials (keeps the group's trial if one is running).
-- Allowed without Pro: it only lowers the charge.
create function public.group_remove_site(p_site_garage_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  selected uuid := public.current_garage_id();
  caller uuid := auth.uid();
  home uuid;
  home_row public.garages%rowtype;
  sites integer;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.garage_role(selected) is distinct from 'owner' then
    raise exception 'GROUP_FORBIDDEN: only the owner can remove a site' using errcode = '42501';
  end if;
  home := public.garage_group_home(selected);
  if home is null or p_site_garage_id is null
     or public.garage_group_home(p_site_garage_id) is distinct from home
     or public.garage_role(p_site_garage_id) is distinct from 'owner'
     or public.garage_role(home) is distinct from 'owner' then
    raise exception 'GROUP_FORBIDDEN: not a site of your group' using errcode = '42501';
  end if;
  if p_site_garage_id = home then
    raise exception 'GROUP_HOME_SITE' using errcode = 'P0001';
  end if;

  select * into home_row from public.garages where id = home for update;
  delete from public.garage_group_sites site where site.garage_id = p_site_garage_id;

  update public.garages
  set plan = case when home_row.trial_ends_at is not null and home_row.trial_ends_at > now() then home_row.plan else 'essentials' end,
      trial_ends_at = case when home_row.trial_ends_at is not null and home_row.trial_ends_at > now() then home_row.trial_ends_at end,
      plan_chosen = case when home_row.trial_ends_at is not null and home_row.trial_ends_at > now() then null else 'essentials' end,
      plan_changed_at = now()
  where id = p_site_garage_id;

  select count(*)::integer into sites from public.garage_group_sites site where site.home_garage_id = home;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values
    (home, caller, 'group.site_removed', 'garage', p_site_garage_id::text, jsonb_build_object('sites', sites)),
    (p_site_garage_id, caller, 'group.left', 'garage', home::text, '{}'::jsonb);

  return jsonb_build_object('home_garage_id', home, 'site_count', sites, 'extra_sites', greatest(sites - 1, 0));
end
$$;

comment on function public.group_remove_site(uuid) is
  'P5.9: the owner of the selected garage, the site and the home garage takes a site out of the group (never the home garage). Nothing is deleted; the site drops to Essentials. Audited group.site_removed / group.left.';

-- Service role (after BillingProvider.setExtraSites()): stores the number of
-- sites beyond the first on the home garage's subscription row.
create function public.record_group_extra_sites(p_home_garage_id uuid, p_provider text default 'mock')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  extra integer;
begin
  if p_home_garage_id is null or not exists (select 1 from public.garages where id = p_home_garage_id) then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  select greatest(count(*)::integer - 1, 0) into extra
  from public.garage_group_sites site where site.home_garage_id = p_home_garage_id;
  extra := least(extra, 100);

  insert into public.garage_subscriptions as existing (garage_id, provider, extra_sites)
  values (p_home_garage_id, case when p_provider in ('mock', 'stripe') then p_provider else 'mock' end, extra)
  on conflict (garage_id) do update
    set extra_sites = excluded.extra_sites, updated_at = now();
  return extra;
end
$$;

comment on function public.record_group_extra_sites(uuid, text) is
  'P5.9: service role. Sets garage_subscriptions.extra_sites on the home garage to (sites in its group - 1), after the billing provider was told.';

-- ---------------------------------------------------------------------------
-- 5. Sites follow the home garage's plan
-- ---------------------------------------------------------------------------

create function public.garage_groups_sync_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.garages site_garage
  set plan = new.plan,
      trial_ends_at = new.trial_ends_at,
      plan_chosen = new.plan_chosen,
      plan_changed_at = coalesce(new.plan_changed_at, now())
  from public.garage_group_sites site
  where site.home_garage_id = new.id
    and site.garage_id <> new.id
    and site_garage.id = site.garage_id
    and (site_garage.plan is distinct from new.plan
         or site_garage.trial_ends_at is distinct from new.trial_ends_at
         or site_garage.plan_chosen is distinct from new.plan_chosen);
  return null;
end
$$;

comment on function public.garage_groups_sync_plan() is
  'P5.9 trigger: when a group''s home garage changes plan, trial or chosen plan, every other site of the group follows.';

create trigger garages_group_plan_sync
  after update of plan, trial_ends_at, plan_chosen on public.garages
  for each row
  when (old.plan is distinct from new.plan
        or old.trial_ends_at is distinct from new.trial_ends_at
        or old.plan_chosen is distinct from new.plan_chosen)
  execute function public.garage_groups_sync_plan();

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.garage_group_home(uuid) from public, anon, authenticated;
revoke all on function public.group_visible_sites() from public, anon, authenticated;
revoke all on function public.group_summary() from public, anon;
revoke all on function public.group_overview(timestamptz) from public, anon;
revoke all on function public.group_report(date, date) from public, anon;
revoke all on function public.group_add_site(jsonb) from public, anon;
revoke all on function public.group_remove_site(uuid) from public, anon;
revoke all on function public.record_group_extra_sites(uuid, text) from public, anon, authenticated;
revoke all on function public.garage_groups_sync_plan() from public, anon, authenticated;

grant execute on function public.garage_group_home(uuid) to service_role;
grant execute on function public.group_summary() to authenticated;
grant execute on function public.group_overview(timestamptz) to authenticated;
grant execute on function public.group_report(date, date) to authenticated;
grant execute on function public.group_add_site(jsonb) to authenticated;
grant execute on function public.group_remove_site(uuid) to authenticated;
grant execute on function public.record_group_extra_sites(uuid, text) to service_role;
