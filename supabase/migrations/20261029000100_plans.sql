-- P5.2: plans, entitlements, usage metering and billing state (D17, D19;
-- DECISIONS A300-A309).
--
--   1. garages.plan is now 'essentials' or 'pro'. trial_ends_at marks a Pro
--      trial (new garages get 14 days by default); plan_chosen records what
--      the garage chose (or what billing says it pays for). Existing rows map
--      growth -> essentials, front_desk -> pro (chosen), trial -> pro on a
--      fresh 14-day trial.
--   2. garage_effective_plan(), plan_feature_plan() and garage_has_feature():
--      the SQL side of src/lib/plans/features.ts. A Pro trial that has run out
--      counts as Essentials straight away, even before expire_plan_trials()
--      runs, unless the garage chose Pro. require_garage_feature() raises
--      PLAN_REQUIRED for SQL functions and RLS write policies of Pro tables.
--   3. expire_plan_trials(): the daily job (plans.expire_trials) moves expired
--      trials to what the garage chose, else Essentials. Nothing is deleted:
--      Pro tables keep their rows, readable, but their write policies need
--      garage_has_feature(), so the data is read-only on Essentials.
--   4. garage_subscriptions (one row per garage, billing provider state),
--      apply_billing_subscription() (service role, from the signed billing
--      webhook or the mock provider), billing_webhook_events (platform).
--   5. plan_requests: "Request Pro" (and "Move to Essentials") from the Plan
--      page; Vitalos sees open requests in /admin. request_plan_change() and
--      choose_essentials() for owners of the selected garage.
--   6. usage_events + record_usage() (service role): SMS segments and AI
--      minutes per garage per garage-local month, idempotent by source key.
--      Never blocks a send. garage_usage_month() for members.
--      billing_usage_reports: what close_usage_month() recorded per month and
--      metric (used, allowance, overage) for billing at cost.
--   7. platform_garages() / platform_update_garage() / platform_garage()
--      accept the new plans; a plan set by Vitalos counts as chosen, ends the
--      trial and closes open plan requests.

-- ---------------------------------------------------------------------------
-- 1. garages
-- ---------------------------------------------------------------------------

alter table public.garages drop constraint garages_plan_check;

alter table public.garages
  add column trial_ends_at timestamptz,
  add column plan_chosen text,
  add column plan_changed_at timestamptz;

update public.garages
set plan = case plan when 'growth' then 'essentials' else 'pro' end,
    plan_chosen = case plan when 'growth' then 'essentials' when 'front_desk' then 'pro' else null end,
    trial_ends_at = case when plan = 'trial' then now() + interval '14 days' else null end,
    plan_changed_at = now();

alter table public.garages
  alter column plan set default 'pro',
  alter column trial_ends_at set default (now() + interval '14 days'),
  add constraint garages_plan_check check (plan in ('essentials', 'pro')),
  add constraint garages_plan_chosen_check check (plan_chosen is null or plan_chosen in ('essentials', 'pro'));

comment on column public.garages.plan is
  'essentials or pro (D17). pro with trial_ends_at set is the 14-day Pro trial. Use garage_effective_plan() for what the garage may use now.';
comment on column public.garages.trial_ends_at is
  'End of the Pro trial; null when not on trial. New garages get now() + 14 days.';
comment on column public.garages.plan_chosen is
  'What the garage chose or pays for (billing webhook, Vitalos, or the owner choosing Essentials). null = not chosen yet; an expired trial then becomes essentials.';

create index garages_trial_ends_at_idx on public.garages (trial_ends_at) where trial_ends_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Entitlements
-- ---------------------------------------------------------------------------

-- The plan a feature needs. Mirrors FEATURES in src/lib/plans/features.ts
-- (a unit test compares the two). Unknown features raise 22023.
create function public.plan_feature_plan(p_feature text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  case p_feature
    when 'booking_page', 'custom_domain', 'vehicle_lookup', 'approvals', 'diary', 'customers', 'import',
         'reminders', 'review_requests', 'missed_calls', 'inbox', 'invoices', 'team', 'askbridge',
         'basic_reports', 'sms_allowance' then
      return 'essentials';
    when 'health_checks', 'payments', 'service_plans', 'campaigns', 'ai_front_desk', 'accounting_sync',
         'advanced_reports', 'fleet_accounts', 'courtesy_cars', 'multi_site', 'priority_support' then
      return 'pro';
    else
      raise exception 'UNKNOWN_FEATURE: %', p_feature using errcode = '22023';
  end case;
end
$$;

comment on function public.plan_feature_plan(text) is
  'P5.2: the plan a feature needs (essentials or pro). Mirrors src/lib/plans/features.ts.';

-- The plan the garage may use right now: an expired, unchosen trial is
-- already Essentials. null for an unknown garage.
create function public.garage_effective_plan(p_garage_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when garage.plan = 'pro'
      and garage.trial_ends_at is not null
      and garage.trial_ends_at <= now()
      and garage.plan_chosen is distinct from 'pro'
    then 'essentials'
    else garage.plan
  end
  from public.garages garage
  where garage.id = p_garage_id
$$;

comment on function public.garage_effective_plan(uuid) is
  'P5.2: essentials or pro for the garage right now (an expired trial the garage did not convert is essentials). Service role, or members of that garage.';

-- Whether the garage may use a feature now. Authenticated callers get false
-- for garages they are not a member of (no plan probing across garages).
create function public.garage_has_feature(p_garage_id uuid, p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  needed text := public.plan_feature_plan(p_feature);
begin
  if p_garage_id is null then
    return false;
  end if;
  if auth.role() is distinct from 'service_role'
     and current_setting('role', true) is distinct from 'service_role'
     and public.garage_role(p_garage_id) is null then
    return false;
  end if;
  return needed = 'essentials' or public.garage_effective_plan(p_garage_id) = 'pro';
end
$$;

comment on function public.garage_has_feature(uuid, text) is
  'P5.2: true when the garage''s effective plan includes the feature. Used by RLS write policies of Pro tables and by SQL functions. Mirrors hasFeature() in src/lib/plans/entitlements.ts.';

-- For SQL functions that do Pro-only work: raises PLAN_REQUIRED (P0001).
create function public.require_garage_feature(p_garage_id uuid, p_feature text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.garage_has_feature(p_garage_id, p_feature) then
    raise exception 'PLAN_REQUIRED: %', p_feature using errcode = 'P0001', hint = 'pro';
  end if;
end
$$;

comment on function public.require_garage_feature(uuid, text) is
  'P5.2: raises PLAN_REQUIRED: <feature> (P0001) unless garage_has_feature(). For Pro-only SQL functions.';

-- ---------------------------------------------------------------------------
-- 3. Trial expiry
-- ---------------------------------------------------------------------------

create function public.expire_plan_trials(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer := 0;
  garage record;
begin
  for garage in
    select candidate.id, candidate.plan, coalesce(candidate.plan_chosen, 'essentials') as next_plan
    from public.garages candidate
    where candidate.trial_ends_at is not null and candidate.trial_ends_at <= p_now
    order by candidate.trial_ends_at, candidate.id
    for update
  loop
    update public.garages
    set plan = garage.next_plan,
        trial_ends_at = null,
        plan_changed_at = p_now
    where id = garage.id;
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (garage.id, null, 'plan.trial_ended', 'garage', garage.id::text,
            jsonb_build_object('from', garage.plan, 'to', garage.next_plan));
    changed := changed + 1;
  end loop;
  return changed;
end
$$;

comment on function public.expire_plan_trials(timestamptz) is
  'P5.2 job plans.expire_trials: ends every Pro trial past trial_ends_at, moving the garage to plan_chosen (else essentials). Audited plan.trial_ended. Deletes nothing. Service role only.';

-- ---------------------------------------------------------------------------
-- 4. Billing state
-- ---------------------------------------------------------------------------

create table public.garage_subscriptions (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  provider text not null,
  customer_ref text,
  subscription_ref text,
  status text not null default 'none',
  plan text,
  extra_sites integer not null default 0,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint garage_subscriptions_garage_key unique (garage_id),
  constraint garage_subscriptions_provider_check check (provider in ('mock', 'stripe')),
  constraint garage_subscriptions_status_check
    check (status in ('none', 'incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'cancelled')),
  constraint garage_subscriptions_plan_check check (plan is null or plan in ('essentials', 'pro')),
  constraint garage_subscriptions_extra_sites_check check (extra_sites between 0 and 100),
  constraint garage_subscriptions_refs_check
    check (char_length(coalesce(customer_ref, '')) <= 255 and char_length(coalesce(subscription_ref, '')) <= 255)
);

comment on table public.garage_subscriptions is
  'P5.2: the garage''s subscription at the billing provider (Stripe test mode, or the mock provider). Written only by apply_billing_subscription() (service role).';

create index garage_subscriptions_subscription_ref_idx on public.garage_subscriptions (provider, subscription_ref)
  where subscription_ref is not null;

alter table public.garage_subscriptions enable row level security;

-- garage_subscriptions
--   "owners read the subscription"  select  owners of the selected garage
--   (no write policies: apply_billing_subscription() writes with the service role)
create policy "owners read the subscription" on public.garage_subscriptions
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');

revoke all on public.garage_subscriptions from anon, authenticated;
grant select on public.garage_subscriptions to authenticated;
grant select, insert, update on public.garage_subscriptions to service_role;

-- Platform table: billing webhook events already handled (idempotency).
-- Ids and types only, never payloads.
create table public.billing_webhook_events (
  event_id text primary key,
  provider text not null,
  type text not null,
  target_garage_id uuid references public.garages(id) on delete set null,
  outcome text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint billing_webhook_events_provider_check check (provider in ('mock', 'stripe')),
  constraint billing_webhook_events_event_id_check check (char_length(event_id) between 1 and 255),
  constraint billing_webhook_events_type_check check (char_length(type) between 1 and 120)
);

comment on table public.billing_webhook_events is
  'P5.2 platform table: billing webhook events claimed by claim_billing_webhook_event(). Ids, types and outcomes only. Service role only.';

alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_webhook_events from anon, authenticated;
grant select, insert, update on public.billing_webhook_events to service_role;

-- true for a new event (claimed), false for one already processed.
create function public.claim_billing_webhook_event(p_event_id text, p_provider text, p_type text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inserted text;
begin
  insert into public.billing_webhook_events (event_id, provider, type)
  values (p_event_id, p_provider, left(p_type, 120))
  on conflict (event_id) do update
    set received_at = now()
    where public.billing_webhook_events.processed_at is null
      and public.billing_webhook_events.received_at < now() - interval '5 minutes'
  returning event_id into inserted;
  return inserted is not null;
end
$$;

create function public.finish_billing_webhook_event(p_event_id text, p_garage_id uuid, p_outcome text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.billing_webhook_events
  set processed_at = now(), target_garage_id = p_garage_id, outcome = left(p_outcome, 120)
  where event_id = p_event_id
$$;

-- Applies the provider's view of the garage's subscription and moves the
-- garage's plan to match. Active or trialing Pro = Pro (chosen, trial over).
-- Cancelled/unpaid = Essentials chosen; the plan drops to Essentials unless a
-- trial is still running. past_due keeps Pro (the provider retries payment).
create function public.apply_billing_subscription(
  p_garage_id uuid,
  p_provider text,
  p_customer_ref text,
  p_subscription_ref text,
  p_status text,
  p_plan text,
  p_current_period_end timestamptz default null,
  p_extra_sites integer default 0,
  p_cancel_at_period_end boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  before_row public.garages%rowtype;
  after_row public.garages%rowtype;
begin
  select * into before_row from public.garages where id = p_garage_id for update;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  insert into public.garage_subscriptions as existing
    (garage_id, provider, customer_ref, subscription_ref, status, plan, extra_sites, current_period_end, cancel_at_period_end)
  values (p_garage_id, p_provider, p_customer_ref, p_subscription_ref, p_status, p_plan, coalesce(p_extra_sites, 0),
          p_current_period_end, coalesce(p_cancel_at_period_end, false))
  on conflict (garage_id) do update
    set provider = excluded.provider,
        customer_ref = coalesce(excluded.customer_ref, existing.customer_ref),
        subscription_ref = coalesce(excluded.subscription_ref, existing.subscription_ref),
        status = excluded.status,
        plan = excluded.plan,
        extra_sites = excluded.extra_sites,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at = now();

  if p_plan = 'pro' and p_status in ('active', 'trialing', 'past_due') then
    update public.garages
    set plan = 'pro', plan_chosen = 'pro', trial_ends_at = null, plan_changed_at = now()
    where id = p_garage_id;
  elsif p_status in ('cancelled', 'unpaid') or p_plan = 'essentials' then
    update public.garages
    set plan_chosen = 'essentials',
        plan = case when trial_ends_at is not null and trial_ends_at > now() then plan else 'essentials' end,
        plan_changed_at = now()
    where id = p_garage_id;
  end if;

  select * into after_row from public.garages where id = p_garage_id;
  if after_row.plan is distinct from before_row.plan or after_row.plan_chosen is distinct from before_row.plan_chosen then
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (p_garage_id, null, 'plan.billing_changed', 'garage', p_garage_id::text,
            jsonb_build_object('from', before_row.plan, 'to', after_row.plan, 'status', p_status, 'provider', p_provider));
    update public.plan_requests
    set status = 'done', handled_at = now()
    where garage_id = p_garage_id and status = 'open' and requested_plan = after_row.plan;
  end if;

  return jsonb_build_object('plan', after_row.plan, 'plan_chosen', after_row.plan_chosen, 'trial_ends_at', after_row.trial_ends_at);
end
$$;

comment on function public.apply_billing_subscription(uuid, text, text, text, text, text, timestamptz, integer, boolean) is
  'P5.2: stores the provider''s subscription state for a garage and moves garages.plan to match (audited plan.billing_changed). Service role only (signed billing webhook, mock provider).';

-- ---------------------------------------------------------------------------
-- 5. Plan requests
-- ---------------------------------------------------------------------------

create table public.plan_requests (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  requested_plan text not null,
  requested_by uuid references auth.users(id) on delete set null,
  note text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid references auth.users(id) on delete set null,
  constraint plan_requests_plan_check check (requested_plan in ('essentials', 'pro')),
  constraint plan_requests_status_check check (status in ('open', 'done', 'withdrawn')),
  constraint plan_requests_note_check check (note is null or char_length(note) <= 500)
);

comment on table public.plan_requests is
  'P5.2: a garage owner asked Vitalos to change plan (the "Request Pro" flow while billing runs on the mock provider). Shown to platform admins in /admin; closed when the plan changes.';

create unique index plan_requests_one_open_idx on public.plan_requests (garage_id) where status = 'open';
create index plan_requests_garage_idx on public.plan_requests (garage_id, created_at desc);
create index plan_requests_open_idx on public.plan_requests (created_at) where status = 'open';

alter table public.plan_requests enable row level security;

-- plan_requests
--   "owners read plan requests"  select  owners of the selected garage
--   (writes through request_plan_change() and the service role)
create policy "owners read plan requests" on public.plan_requests
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');

revoke all on public.plan_requests from anon, authenticated;
grant select on public.plan_requests to authenticated;
grant select, insert, update on public.plan_requests to service_role;

-- Owner of the selected garage (MFA as other owner actions) asks for a plan.
-- One open request per garage: a new one replaces the open one.
create function public.request_plan_change(p_plan text, p_note text default null)
returns public.plan_requests
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  request public.plan_requests;
begin
  if not public.garage_actor_allowed() or public.current_garage_role() is distinct from 'owner' then
    raise exception 'PLAN_FORBIDDEN: only the garage owner can change the plan' using errcode = '42501';
  end if;
  if p_plan is null or p_plan not in ('essentials', 'pro') then
    raise exception 'INVALID_PLAN' using errcode = '22023';
  end if;

  update public.plan_requests existing
  set status = 'withdrawn', handled_at = now(), handled_by = auth.uid()
  where existing.garage_id = target_garage and existing.status = 'open';

  insert into public.plan_requests (garage_id, requested_plan, requested_by, note)
  values (target_garage, p_plan, auth.uid(), nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning * into request;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (request.garage_id, auth.uid(), 'plan.requested', 'plan_request', request.id::text,
          jsonb_build_object('plan', p_plan));
  return request;
end
$$;

comment on function public.request_plan_change(text, text) is
  'P5.2: the owner of the selected garage asks Vitalos for a plan (Request Pro). Withdraws any open request first; audited plan.requested.';

-- The owner moves the garage to Essentials now (ends a trial early). Refused
-- while a paid provider subscription is live: that goes through the provider's
-- portal, and the webhook applies it.
create function public.choose_essentials()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  previous text;
begin
  if not public.garage_actor_allowed() or public.current_garage_role() is distinct from 'owner' then
    raise exception 'PLAN_FORBIDDEN: only the garage owner can change the plan' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.garage_subscriptions subscription
    where subscription.garage_id = target_garage
      and subscription.provider = 'stripe'
      and subscription.status in ('active', 'trialing', 'past_due')
  ) then
    raise exception 'BILLING_PORTAL_REQUIRED' using errcode = 'P0001';
  end if;

  select plan into previous from public.garages where id = target_garage for update;
  update public.garages
  set plan = 'essentials', plan_chosen = 'essentials', trial_ends_at = null, plan_changed_at = now()
  where id = target_garage;
  update public.plan_requests existing
  set status = 'withdrawn', handled_at = now(), handled_by = auth.uid()
  where existing.garage_id = target_garage and existing.status = 'open' and existing.requested_plan = 'pro';
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'plan.chose_essentials', 'garage', target_garage::text,
          jsonb_build_object('from', previous));
  return jsonb_build_object('plan', 'essentials');
end
$$;

comment on function public.choose_essentials() is
  'P5.2: the owner of the selected garage moves to Essentials now (ends the trial). BILLING_PORTAL_REQUIRED while a Stripe subscription is live. Audited.';

-- ---------------------------------------------------------------------------
-- 6. Usage metering
-- ---------------------------------------------------------------------------

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  metric text not null,
  quantity numeric(12, 2) not null,
  period_month date not null,
  occurred_at timestamptz not null default now(),
  source_key text not null,
  created_at timestamptz not null default now(),
  constraint usage_events_metric_check check (metric in ('sms_segments', 'ai_minutes')),
  constraint usage_events_quantity_check check (quantity > 0 and quantity <= 100000),
  constraint usage_events_period_check check (period_month = date_trunc('month', period_month)::date),
  constraint usage_events_source_key_check check (char_length(source_key) between 1 and 200),
  constraint usage_events_source_key_unique unique (garage_id, metric, source_key)
);

comment on table public.usage_events is
  'P5.2: metered usage (SMS segments sent, AI front desk minutes) per garage, counted in the garage''s local month. One row per source (message idempotency key, call id). Written by record_usage() (service role).';

create index usage_events_garage_month_idx on public.usage_events (garage_id, period_month, metric);

alter table public.usage_events enable row level security;

-- usage_events
--   "owners and managers read usage"  select  owners/managers of the selected garage
--   (no write policies: record_usage() writes with the service role)
create policy "owners and managers read usage" on public.usage_events
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

revoke all on public.usage_events from anon, authenticated;
grant select on public.usage_events to authenticated;
grant select, insert on public.usage_events to service_role;

-- Records usage once per source key; true when it was new. Never raises for
-- an unknown or cancelled garage (metering must not break a send): false.
create function public.record_usage(
  p_garage_id uuid,
  p_metric text,
  p_quantity numeric,
  p_source_key text,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  zone text;
  inserted uuid;
begin
  if p_metric not in ('sms_segments', 'ai_minutes') or p_quantity is null or p_quantity <= 0
     or p_source_key is null or char_length(p_source_key) not between 1 and 200 then
    raise exception 'INVALID_USAGE' using errcode = '22023';
  end if;
  select garage.timezone into zone from public.garages garage where garage.id = p_garage_id;
  if zone is null then
    return false;
  end if;
  insert into public.usage_events (garage_id, metric, quantity, period_month, occurred_at, source_key)
  values (p_garage_id, p_metric, least(p_quantity, 100000), date_trunc('month', (coalesce(p_at, now()) at time zone zone))::date,
          coalesce(p_at, now()), p_source_key)
  on conflict (garage_id, metric, source_key) do nothing
  returning id into inserted;
  return inserted is not null;
end
$$;

comment on function public.record_usage(uuid, text, numeric, text, timestamptz) is
  'P5.2: meters SMS segments or AI minutes for a garage in its local month, once per source key. Service role only.';

-- Totals for the selected garage in a month (first of the month, garage-local).
create function public.garage_usage_month(p_month date)
returns table (metric text, quantity numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select event.metric, sum(event.quantity)
  from public.usage_events event
  where event.garage_id = public.current_garage_id()
    and public.current_garage_role() in ('owner', 'manager')
    and event.period_month = date_trunc('month', p_month)::date
  group by event.metric
$$;

comment on function public.garage_usage_month(date) is
  'P5.2: usage totals per metric for the selected garage in a month. Owners and managers.';

create table public.billing_usage_reports (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  period_month date not null,
  metric text not null,
  plan text not null,
  used numeric(12, 2) not null,
  allowance numeric(12, 2),
  overage numeric(12, 2),
  status text not null default 'recorded',
  provider_ref text,
  created_at timestamptz not null default now(),
  reported_at timestamptz,
  constraint billing_usage_reports_metric_check check (metric in ('sms_segments', 'ai_minutes')),
  constraint billing_usage_reports_plan_check check (plan in ('essentials', 'pro')),
  constraint billing_usage_reports_status_check check (status in ('recorded', 'reported', 'not_billable')),
  constraint billing_usage_reports_period_check check (period_month = date_trunc('month', period_month)::date),
  constraint billing_usage_reports_amounts_check
    check (used >= 0 and (allowance is null or allowance >= 0) and (overage is null or overage >= 0)),
  constraint billing_usage_reports_key unique (garage_id, period_month, metric)
);

comment on table public.billing_usage_reports is
  'P5.2: usage per closed month and metric with the allowance then in force and the overage to bill at cost. allowance/overage null while Temitope has not set the allowance (status not_billable). Written by close_usage_month() (service role).';

alter table public.billing_usage_reports enable row level security;

-- billing_usage_reports
--   "owners read usage reports"  select  owners of the selected garage
--   (no write policies: close_usage_month() writes with the service role)
create policy "owners read usage reports" on public.billing_usage_reports
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');

revoke all on public.billing_usage_reports from anon, authenticated;
grant select on public.billing_usage_reports to authenticated;
grant select, insert, update on public.billing_usage_reports to service_role;

-- Records one garage's month for a metric with the allowance the app passes
-- (src/lib/plans/config.ts; null = not set yet). Idempotent: a second close of
-- the same month updates the figures until the report has been sent to billing.
create function public.close_usage_month(p_garage_id uuid, p_month date, p_metric text, p_allowance numeric)
returns public.billing_usage_reports
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  total numeric(12, 2);
  current_plan text;
  report public.billing_usage_reports;
begin
  if p_metric not in ('sms_segments', 'ai_minutes') or (p_allowance is not null and p_allowance < 0) then
    raise exception 'INVALID_USAGE' using errcode = '22023';
  end if;
  current_plan := public.garage_effective_plan(p_garage_id);
  if current_plan is null then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  select coalesce(sum(event.quantity), 0) into total
  from public.usage_events event
  where event.garage_id = p_garage_id and event.metric = p_metric and event.period_month = month_start;

  insert into public.billing_usage_reports as existing (garage_id, period_month, metric, plan, used, allowance, overage, status)
  values (p_garage_id, month_start, p_metric, current_plan, total, p_allowance,
          case when p_allowance is null then null else greatest(total - p_allowance, 0) end,
          case when p_allowance is null then 'not_billable' else 'recorded' end)
  on conflict (garage_id, period_month, metric) do update
    set used = excluded.used, allowance = excluded.allowance, overage = excluded.overage,
        plan = excluded.plan, status = excluded.status
    where existing.status <> 'reported'
  returning * into report;

  if report.id is null then
    select * into report from public.billing_usage_reports existing
    where existing.garage_id = p_garage_id and existing.period_month = month_start and existing.metric = p_metric;
  end if;
  return report;
end
$$;

comment on function public.close_usage_month(uuid, date, text, numeric) is
  'P5.2 job billing.close_usage: records a garage''s month of usage with the allowance and the overage to bill at cost. Service role only.';

-- ---------------------------------------------------------------------------
-- 7. Super admin
-- ---------------------------------------------------------------------------

create or replace function public.platform_garages(
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
  if p_plan is not null and p_plan not in ('essentials', 'pro', 'trial') then
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
    and (
      p_plan is null
      or (p_plan = 'trial' and garage.trial_ends_at is not null)
      or (p_plan <> 'trial' and garage.plan = p_plan)
    )
  order by garage.created_at desc, garage.id
  limit least(greatest(coalesce(p_limit, 25), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

-- platform_garage() gains the plan details and open plan request.
create or replace function public.platform_garage(p_garage_id uuid)
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
    'effective_plan', public.garage_effective_plan(garage.id),
    'trial_ends_at', garage.trial_ends_at,
    'plan_chosen', garage.plan_chosen,
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
    'plan_request', (
      select jsonb_build_object('id', request.id, 'plan', request.requested_plan, 'note', request.note,
                                'created_at', request.created_at,
                                'requested_by', coalesce(profile.display_name, 'Garage owner'))
      from public.plan_requests request
      left join public.admin_profiles profile on profile.user_id = request.requested_by
      where request.garage_id = garage.id and request.status = 'open'
      limit 1
    ),
    'subscription', (
      select jsonb_build_object('provider', subscription.provider, 'status', subscription.status,
                                'plan', subscription.plan, 'extra_sites', subscription.extra_sites,
                                'current_period_end', subscription.current_period_end)
      from public.garage_subscriptions subscription
      where subscription.garage_id = garage.id
    ),
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

-- A plan set by Vitalos counts as chosen: the trial ends and open requests
-- for that plan are done.
create or replace function public.platform_update_garage(p_garage_id uuid, p_plan text, p_status text, p_reason text)
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
  if p_plan is not null and p_plan not in ('essentials', 'pro') then
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
      plan_chosen = coalesce(p_plan, garage.plan_chosen),
      trial_ends_at = case when p_plan is null then garage.trial_ends_at else null end,
      plan_changed_at = case when p_plan is null then garage.plan_changed_at else now() end,
      status = coalesce(p_status, garage.status),
      cancelled_at = case
        when coalesce(p_status, garage.status) = 'cancelled' then coalesce(garage.cancelled_at, now())
        else null
      end
  where garage.id = p_garage_id
  returning * into after_row;

  if p_plan is not null then
    update public.plan_requests request
    set status = 'done', handled_at = now(), handled_by = auth.uid()
    where request.garage_id = p_garage_id and request.status = 'open' and request.requested_plan = p_plan;
  end if;
  if after_row.plan is distinct from before_row.plan or before_row.trial_ends_at is distinct from after_row.trial_ends_at then
    perform public.record_platform_action('platform.garage_plan_changed', p_garage_id, 'garage', p_garage_id::text, reason,
      jsonb_build_object('from', before_row.plan, 'to', after_row.plan, 'trial_ended', before_row.trial_ends_at is not null));
  end if;
  if after_row.status is distinct from before_row.status then
    perform public.record_platform_action('platform.garage_status_changed', p_garage_id, 'garage', p_garage_id::text, reason,
      jsonb_build_object('from', before_row.status, 'to', after_row.status));
  end if;

  return jsonb_build_object('id', after_row.id, 'plan', after_row.plan, 'status', after_row.status,
                            'cancelled_at', after_row.cancelled_at, 'trial_ends_at', after_row.trial_ends_at);
end
$$;

-- Open plan requests for the /admin list (platform admins at AAL2).
create function public.platform_plan_requests(p_limit integer default 50)
returns table (id uuid, garage_id uuid, garage_name text, garage_slug text, requested_plan text, note text,
               requested_by text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_platform_admin();
  return query
  select request.id, request.garage_id, garage.name, garage.slug, request.requested_plan, request.note,
         coalesce(profile.display_name, 'Garage owner'), request.created_at
  from public.plan_requests request
  join public.garages garage on garage.id = request.garage_id
  left join public.admin_profiles profile on profile.user_id = request.requested_by
  where request.status = 'open'
  order by request.created_at
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end
$$;

comment on function public.platform_plan_requests(integer) is
  'P5.2: open plan requests across garages for Vitalos (platform admins at AAL2).';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.plan_feature_plan(text) from public, anon;
revoke all on function public.garage_effective_plan(uuid) from public, anon, authenticated;
revoke all on function public.garage_has_feature(uuid, text) from public, anon;
revoke all on function public.require_garage_feature(uuid, text) from public, anon;
revoke all on function public.expire_plan_trials(timestamptz) from public, anon, authenticated;
revoke all on function public.claim_billing_webhook_event(text, text, text) from public, anon, authenticated;
revoke all on function public.finish_billing_webhook_event(text, uuid, text) from public, anon, authenticated;
revoke all on function public.apply_billing_subscription(uuid, text, text, text, text, text, timestamptz, integer, boolean) from public, anon, authenticated;
revoke all on function public.request_plan_change(text, text) from public, anon;
revoke all on function public.choose_essentials() from public, anon;
revoke all on function public.record_usage(uuid, text, numeric, text, timestamptz) from public, anon, authenticated;
revoke all on function public.garage_usage_month(date) from public, anon;
revoke all on function public.close_usage_month(uuid, date, text, numeric) from public, anon, authenticated;
revoke all on function public.platform_plan_requests(integer) from public, anon;

grant execute on function public.plan_feature_plan(text) to authenticated, service_role;
grant execute on function public.garage_effective_plan(uuid) to service_role;
grant execute on function public.garage_has_feature(uuid, text) to authenticated, service_role;
grant execute on function public.require_garage_feature(uuid, text) to authenticated, service_role;
grant execute on function public.expire_plan_trials(timestamptz) to service_role;
grant execute on function public.claim_billing_webhook_event(text, text, text) to service_role;
grant execute on function public.finish_billing_webhook_event(text, uuid, text) to service_role;
grant execute on function public.apply_billing_subscription(uuid, text, text, text, text, text, timestamptz, integer, boolean) to service_role;
grant execute on function public.request_plan_change(text, text) to authenticated;
grant execute on function public.choose_essentials() to authenticated;
grant execute on function public.record_usage(uuid, text, numeric, text, timestamptz) to service_role;
grant execute on function public.garage_usage_month(date) to authenticated;
grant execute on function public.close_usage_month(uuid, date, text, numeric) to service_role;
grant execute on function public.platform_plan_requests(integer) to authenticated;
