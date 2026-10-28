-- P5.11: customer service plans paid by monthly Direct Debit (Pro feature
-- `service_plans`, D17; DECISIONS A374-A381 in
-- docs/autofix/phase-5/P5.11-service-plans.md).
--
--   1. service_plans: what a garage sells (name, monthly price, a % off parts
--      and labour, priority booking) and service_plan_inclusions: which
--      services are included and how many times per plan year.
--   2. customer_plan_subscriptions: one car on one plan for one customer,
--      paid by Direct Debit through the garage's own payment account (P5.4).
--      pending_mandate -> active <-> past_due -> cancelled (final). Written by
--      start_plan_signup() and apply_plan_subscription_status() (service role:
--      the sign-up flow and the signed webhook) and cancel_plan_subscription()
--      (staff).
--   3. service_plan_uses: an included service used by a booking, counted per
--      plan year. Recorded AFTER create_booking() by record_plan_booking()
--      (online flow) or use_plan_benefit() (staff); a cancelled booking gives
--      the use back (trigger).
--   4. service_plan_invoice_applications: the plan's benefits put on a draft
--      invoice once, through save_invoice_draft() (apply_service_plan_to_invoice()).
--
-- Nothing here redefines create_booking*, available_slots* or
-- staff_available_slots*, and no existing table changes shape.

-- ---------------------------------------------------------------------------
-- 1. Plans
-- ---------------------------------------------------------------------------

create table public.service_plans (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  name text not null,
  description text,
  price_pence integer not null,
  discount_percent smallint not null default 0,
  priority_booking boolean not null default false,
  status text not null default 'active',
  archived_at timestamptz,
  sort integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_plans_garage_id_id_key unique (garage_id, id),
  constraint service_plans_name_check check (char_length(btrim(name)) between 2 and 60),
  constraint service_plans_description_check check (description is null or char_length(description) <= 500),
  constraint service_plans_price_check check (price_pence between 100 and 100000),
  constraint service_plans_discount_check check (discount_percent between 0 and 50),
  constraint service_plans_status_check check (status in ('active', 'archived')),
  constraint service_plans_archived_check check ((status = 'archived') = (archived_at is not null))
);

comment on table public.service_plans is
  'P5.11: a garage''s customer service plan, paid monthly by Direct Debit. discount_percent comes off parts and labour on the plan car''s invoices; priority_booking is a promise the garage keeps by hand (shown to staff, never changes slots). Archived plans take no new sign-ups; existing subscriptions carry on.';

create index service_plans_garage_idx on public.service_plans (garage_id, status, sort, name);

create trigger service_plans_updated before update on public.service_plans
  for each row execute function public.set_updated_at();

create table public.service_plan_inclusions (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  plan_id uuid not null,
  service_id uuid not null,
  uses_per_year smallint not null default 1,
  created_at timestamptz not null default now(),
  constraint service_plan_inclusions_garage_id_id_key unique (garage_id, id),
  constraint service_plan_inclusions_plan_service_key unique (garage_id, plan_id, service_id),
  constraint service_plan_inclusions_plan_id_fkey foreign key (garage_id, plan_id)
    references public.service_plans (garage_id, id) on delete cascade,
  constraint service_plan_inclusions_service_id_fkey foreign key (garage_id, service_id)
    references public.services (garage_id, id) on delete cascade,
  constraint service_plan_inclusions_uses_check check (uses_per_year between 1 and 12)
);

comment on table public.service_plan_inclusions is
  'P5.11: a service included in a plan, uses_per_year times in each plan year (the year runs from the subscription''s started_at, in the garage''s time zone).';

create index service_plan_inclusions_plan_idx on public.service_plan_inclusions (garage_id, plan_id);
create index service_plan_inclusions_service_idx on public.service_plan_inclusions (garage_id, service_id);

-- ---------------------------------------------------------------------------
-- 2. Subscriptions
-- ---------------------------------------------------------------------------

create table public.customer_plan_subscriptions (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  plan_id uuid not null,
  customer_id uuid not null,
  vehicle_id uuid not null,
  status text not null default 'pending_mandate',
  price_pence integer not null,
  provider text not null,
  checkout_ref text,
  mandate_ref text,
  subscription_ref text,
  started_at timestamptz,
  renews_at timestamptz,
  last_payment_failed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancel_reason text,
  last_notice_kind text,
  last_notice_at timestamptz,
  last_notice_channel text,
  last_notice_outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_plan_subscriptions_garage_id_id_key unique (garage_id, id),
  constraint customer_plan_subscriptions_plan_id_fkey foreign key (garage_id, plan_id) references public.service_plans (garage_id, id),
  constraint customer_plan_subscriptions_customer_id_fkey foreign key (garage_id, customer_id) references public.customers (garage_id, id),
  constraint customer_plan_subscriptions_vehicle_id_fkey foreign key (garage_id, vehicle_id) references public.vehicles (garage_id, id),
  constraint customer_plan_subscriptions_status_check check (status in ('pending_mandate', 'active', 'past_due', 'cancelled')),
  constraint customer_plan_subscriptions_price_check check (price_pence between 100 and 100000),
  constraint customer_plan_subscriptions_provider_check check (provider in ('mock', 'stripe')),
  constraint customer_plan_subscriptions_started_check check (status in ('pending_mandate', 'cancelled') or started_at is not null),
  constraint customer_plan_subscriptions_cancelled_check check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint customer_plan_subscriptions_refs_check check (
    (checkout_ref is null or char_length(checkout_ref) <= 255)
    and (mandate_ref is null or char_length(mandate_ref) <= 255)
    and (subscription_ref is null or char_length(subscription_ref) <= 255)
  ),
  constraint customer_plan_subscriptions_reason_check check (cancel_reason is null or char_length(cancel_reason) <= 300),
  constraint customer_plan_subscriptions_notice_check check (
    (last_notice_kind is null or last_notice_kind in ('confirmation', 'payment_failed'))
    and (last_notice_channel is null or last_notice_channel in ('sms', 'whatsapp', 'email', 'none'))
    and (last_notice_outcome is null or last_notice_outcome in ('sent', 'failed', 'opted_out', 'no_contact'))
  )
);

comment on table public.customer_plan_subscriptions is
  'P5.11: a car on a service plan, paid by Direct Debit on the garage''s payment account. price_pence is the price signed up for (a later plan price change applies to new sign-ups only). Ids and refs only: no bank details are ever stored. Written only by start_plan_signup(), set_plan_subscription_checkout(), apply_plan_subscription_status() (service role), cancel_plan_subscription() (staff) and the notice columns by the server after a send.';

-- One live subscription per car.
create unique index customer_plan_subscriptions_one_live_idx on public.customer_plan_subscriptions (garage_id, vehicle_id)
  where status <> 'cancelled';
create index customer_plan_subscriptions_customer_idx on public.customer_plan_subscriptions (garage_id, customer_id);
create index customer_plan_subscriptions_plan_idx on public.customer_plan_subscriptions (garage_id, plan_id, status);
create index customer_plan_subscriptions_subscription_ref_idx on public.customer_plan_subscriptions (subscription_ref) where subscription_ref is not null;

create trigger customer_plan_subscriptions_updated before update on public.customer_plan_subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Uses and invoice applications
-- ---------------------------------------------------------------------------

create table public.service_plan_uses (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  subscription_id uuid not null,
  booking_id uuid not null,
  service_id uuid not null,
  plan_year_start timestamptz not null,
  status text not null default 'used',
  source text not null,
  created_by uuid references auth.users(id) on delete set null,
  used_at timestamptz not null default now(),
  released_at timestamptz,
  constraint service_plan_uses_garage_id_id_key unique (garage_id, id),
  constraint service_plan_uses_subscription_id_fkey foreign key (garage_id, subscription_id)
    references public.customer_plan_subscriptions (garage_id, id) on delete cascade,
  constraint service_plan_uses_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade,
  constraint service_plan_uses_service_id_fkey foreign key (garage_id, service_id)
    references public.services (garage_id, id) on delete cascade,
  constraint service_plan_uses_status_check check (status in ('used', 'released')),
  constraint service_plan_uses_source_check check (source in ('online', 'staff')),
  constraint service_plan_uses_released_check check ((status = 'released') = (released_at is not null))
);

comment on table public.service_plan_uses is
  'P5.11: one included service used by one booking, in the plan year starting plan_year_start. released = the booking was cancelled or staff gave the use back. Written only by record_plan_booking(), use_plan_benefit(), release_plan_benefit() and the booking trigger.';

create unique index service_plan_uses_one_live_idx on public.service_plan_uses (garage_id, booking_id) where status = 'used';
create index service_plan_uses_subscription_idx on public.service_plan_uses (garage_id, subscription_id, plan_year_start);

create table public.service_plan_invoice_applications (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  invoice_id uuid not null,
  subscription_id uuid not null,
  included_pence bigint not null default 0,
  discount_pence bigint not null default 0,
  applied_by uuid references auth.users(id) on delete set null,
  applied_at timestamptz not null default now(),
  constraint service_plan_invoice_applications_garage_id_id_key unique (garage_id, id),
  constraint service_plan_invoice_applications_invoice_key unique (garage_id, invoice_id),
  constraint service_plan_invoice_applications_invoice_id_fkey foreign key (garage_id, invoice_id)
    references public.invoices (garage_id, id) on delete cascade,
  constraint service_plan_invoice_applications_subscription_id_fkey foreign key (garage_id, subscription_id)
    references public.customer_plan_subscriptions (garage_id, id) on delete cascade,
  constraint service_plan_invoice_applications_amounts_check check (included_pence >= 0 and discount_pence >= 0)
);

comment on table public.service_plan_invoice_applications is
  'P5.11: a plan''s benefits applied to a draft invoice (once per invoice): included_pence = included service lines set to £0, discount_pence = the plan''s % added to the invoice discount. Written only by apply_service_plan_to_invoice().';

create index service_plan_invoice_applications_subscription_idx on public.service_plan_invoice_applications (garage_id, subscription_id);

-- ---------------------------------------------------------------------------
-- 4. Internals (owner only; no API role may call them)
-- ---------------------------------------------------------------------------

-- The selected garage for a plan action by a signed-in member whose role is
-- one of p_roles (MFA as other staff RPCs). p_feature: also require Pro.
-- Raises 42501 SERVICE_PLANS_FORBIDDEN or P0001 PLAN_REQUIRED.
create function public.service_plan_actor_garage(p_roles text[], p_feature boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
begin
  if not coalesce(public.garage_actor_allowed(), false) or coalesce(public.current_garage_role() = any (p_roles), false) is false then
    raise exception 'SERVICE_PLANS_FORBIDDEN' using errcode = '42501';
  end if;
  if p_feature then
    perform public.require_garage_feature(target_garage, 'service_plans');
  end if;
  return target_garage;
end
$$;

-- The start of the plan year that p_at falls in: started_at plus whole years,
-- counted on the garage's local calendar (so a plan started at 09:00 BST
-- renews its year at 09:00 local, GMT or BST). Before started_at: year one.
create function public.service_plan_year_start(p_started_at timestamptz, p_at timestamptz, p_timezone text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select ((p_started_at at time zone p_timezone)
          + make_interval(years => greatest(0, extract(year from age(p_at at time zone p_timezone, p_started_at at time zone p_timezone))::integer)))
         at time zone p_timezone
$$;

-- A note on the booking's timeline (booking_events type note).
create function public.service_plan_booking_note(p_garage_id uuid, p_booking_id uuid, p_text text, p_actor_id uuid default null)
returns void
language sql
volatile
set search_path = ''
as $$
  insert into public.booking_events (garage_id, booking_id, type, actor, actor_id, data)
  values (p_garage_id, p_booking_id, 'note', case when p_actor_id is null then 'system' else 'staff' end, p_actor_id,
          jsonb_build_object('text', left(p_text, 1000), 'servicePlan', true));
$$;

-- Records one included use for a booking when its car is on an active plan
-- that includes the booking's service and the plan year has a use left.
-- Idempotent: a booking holds at most one live use. Returns
-- {on_plan, plan_name, subscription_id, included, recorded, already, uses_left, reason}.
create function public.service_plan_record_use(p_garage_id uuid, p_booking_id uuid, p_source text, p_actor_id uuid)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  booking record;
  subscription record;
  allowance integer;
  year_start timestamptz;
  used integer;
  existing uuid;
  garage_tz text;
begin
  select b.id, b.vehicle_id, b.service_id, b.starts_at, b.status, service.name as service_name
  into booking
  from public.bookings b
  join public.services service on service.garage_id = b.garage_id and service.id = b.service_id
  where b.garage_id = p_garage_id and b.id = p_booking_id and b.deleted_at is null
  for update of b;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;

  select s.id, s.status, s.started_at, plan.name as plan_name, plan.id as plan_id
  into subscription
  from public.customer_plan_subscriptions s
  join public.service_plans plan on plan.garage_id = s.garage_id and plan.id = s.plan_id
  where s.garage_id = p_garage_id and s.vehicle_id = booking.vehicle_id and s.status <> 'cancelled'
  for update of s;
  if not found or subscription.status = 'pending_mandate' then
    return jsonb_build_object('on_plan', false);
  end if;
  select plan_use.id into existing
  from public.service_plan_uses plan_use
  where plan_use.garage_id = p_garage_id and plan_use.booking_id = p_booking_id and plan_use.status = 'used';
  if found then -- recorded before: it stands whatever happens to payments since
    return jsonb_build_object('on_plan', true, 'plan_name', subscription.plan_name, 'subscription_id', subscription.id,
                              'included', true, 'recorded', false, 'already', true);
  end if;
  if subscription.status <> 'active' then
    return jsonb_build_object('on_plan', true, 'plan_name', subscription.plan_name, 'subscription_id', subscription.id,
                              'included', false, 'recorded', false, 'reason', 'past_due');
  end if;

  select inclusion.uses_per_year into allowance
  from public.service_plan_inclusions inclusion
  where inclusion.garage_id = p_garage_id and inclusion.plan_id = subscription.plan_id and inclusion.service_id = booking.service_id;
  if not found then
    return jsonb_build_object('on_plan', true, 'plan_name', subscription.plan_name, 'subscription_id', subscription.id,
                              'included', false, 'recorded', false, 'reason', 'not_included');
  end if;
  if booking.status in ('cancelled', 'no_show') then
    return jsonb_build_object('on_plan', true, 'plan_name', subscription.plan_name, 'subscription_id', subscription.id,
                              'included', true, 'recorded', false, 'reason', 'booking_not_live');
  end if;

  select garage.timezone into garage_tz from public.garages garage where garage.id = p_garage_id;
  year_start := public.service_plan_year_start(subscription.started_at, booking.starts_at, coalesce(garage_tz, 'Europe/London'));
  select count(*) into used
  from public.service_plan_uses plan_use
  where plan_use.garage_id = p_garage_id and plan_use.subscription_id = subscription.id and plan_use.service_id = booking.service_id
    and plan_use.plan_year_start = year_start and plan_use.status = 'used';
  if used >= allowance then
    perform public.service_plan_booking_note(p_garage_id, p_booking_id,
      'On ' || subscription.plan_name || ': ' || booking.service_name || ' already used ' || used || ' of ' || allowance
      || ' times this plan year, so it is charged as normal.', p_actor_id);
    return jsonb_build_object('on_plan', true, 'plan_name', subscription.plan_name, 'subscription_id', subscription.id,
                              'included', true, 'recorded', false, 'uses_left', 0, 'reason', 'limit_reached');
  end if;

  insert into public.service_plan_uses (garage_id, subscription_id, booking_id, service_id, plan_year_start, status, source, created_by)
  values (p_garage_id, subscription.id, p_booking_id, booking.service_id, year_start, 'used', p_source, p_actor_id);
  perform public.service_plan_booking_note(p_garage_id, p_booking_id,
    'On ' || subscription.plan_name || ': ' || booking.service_name || ' is included (use ' || (used + 1) || ' of ' || allowance
    || ' this plan year).', p_actor_id);
  return jsonb_build_object('on_plan', true, 'plan_name', subscription.plan_name, 'subscription_id', subscription.id,
                            'included', true, 'recorded', true, 'uses_left', allowance - used - 1);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Staff functions (authenticated; selected garage)
-- ---------------------------------------------------------------------------

-- Creates (p_plan_id null) or changes a plan and its inclusions in one go.
-- Owners and managers; Pro. Payload: {name, description, price_pence,
-- discount_percent, priority_booking, inclusions: [{service_id, uses_per_year}]}
-- (at most 5 inclusions, each an active service of this garage). A price
-- change applies to new sign-ups only. Audited service_plan.created/updated.
create function public.save_service_plan(p_plan_id uuid, p_payload jsonb)
returns public.service_plans
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.service_plan_actor_garage(array['owner', 'manager']);
  plan public.service_plans;
  plan_name text := btrim(regexp_replace(coalesce(p_payload->>'name', ''), '[[:space:]]+', ' ', 'g'));
  plan_description text := nullif(btrim(coalesce(p_payload->>'description', '')), '');
  plan_price integer;
  plan_discount integer;
  plan_priority boolean := coalesce((p_payload->>'priority_booking')::boolean, false);
  inclusions jsonb := coalesce(p_payload->'inclusions', '[]'::jsonb);
  item jsonb;
  item_service uuid;
  item_uses integer;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID_PLAN: payload must be an object' using errcode = 'P0001';
  end if;
  begin
    plan_price := (p_payload->>'price_pence')::integer;
    plan_discount := coalesce((p_payload->>'discount_percent')::integer, 0);
  exception when others then
    raise exception 'INVALID_PLAN: price and discount must be whole numbers' using errcode = 'P0001';
  end;
  if char_length(plan_name) not between 2 and 60 then
    raise exception 'INVALID_PLAN: name' using errcode = 'P0001';
  end if;
  if plan_description is not null and char_length(plan_description) > 500 then
    raise exception 'INVALID_PLAN: description' using errcode = 'P0001';
  end if;
  if plan_price is null or plan_price not between 100 and 100000 then
    raise exception 'INVALID_PLAN: price' using errcode = 'P0001';
  end if;
  if plan_discount not between 0 and 50 then
    raise exception 'INVALID_PLAN: discount' using errcode = 'P0001';
  end if;
  if jsonb_typeof(inclusions) <> 'array' or jsonb_array_length(inclusions) > 5 then
    raise exception 'INVALID_PLAN: inclusions' using errcode = 'P0001';
  end if;
  if jsonb_array_length(inclusions) = 0 and plan_discount = 0 and not plan_priority then
    raise exception 'INVALID_PLAN: a plan must include something' using errcode = 'P0001';
  end if;

  if p_plan_id is null then
    insert into public.service_plans (garage_id, name, description, price_pence, discount_percent, priority_booking, created_by, sort)
    values (target_garage, plan_name, plan_description, plan_price, plan_discount, plan_priority, auth.uid(),
            coalesce((select max(existing.sort) + 10 from public.service_plans existing where existing.garage_id = target_garage), 10))
    returning * into plan;
  else
    update public.service_plans existing
    set name = plan_name, description = plan_description, price_pence = plan_price,
        discount_percent = plan_discount, priority_booking = plan_priority
    where existing.garage_id = target_garage and existing.id = p_plan_id
    returning * into plan;
    if not found then
      raise exception 'SERVICE_PLAN_NOT_FOUND' using errcode = 'P0001';
    end if;
    delete from public.service_plan_inclusions existing
    where existing.garage_id = target_garage and existing.plan_id = plan.id;
  end if;

  for item in select value from jsonb_array_elements(inclusions) loop
    begin
      item_service := (item->>'service_id')::uuid;
      item_uses := coalesce((item->>'uses_per_year')::integer, 1);
    exception when others then
      raise exception 'INVALID_PLAN: inclusion' using errcode = 'P0001';
    end;
    if item_uses not between 1 and 12 then
      raise exception 'INVALID_PLAN: uses per year' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.services service
      where service.garage_id = target_garage and service.id = item_service and service.deleted_at is null
    ) then
      raise exception 'INVALID_PLAN: unknown service' using errcode = 'P0001';
    end if;
    insert into public.service_plan_inclusions (garage_id, plan_id, service_id, uses_per_year)
    values (target_garage, plan.id, item_service, item_uses)
    on conflict (garage_id, plan_id, service_id) do update set uses_per_year = excluded.uses_per_year;
  end loop;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), case when p_plan_id is null then 'service_plan.created' else 'service_plan.updated' end,
          'service_plan', plan.id::text,
          jsonb_build_object('pricePence', plan_price, 'discountPercent', plan_discount, 'inclusions', jsonb_array_length(inclusions)));
  return plan;
end
$$;

-- Archives (no new sign-ups; existing subscriptions carry on) or restores a
-- plan. Owners and managers; Pro.
create function public.set_service_plan_status(p_plan_id uuid, p_status text)
returns public.service_plans
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.service_plan_actor_garage(array['owner', 'manager']);
  plan public.service_plans;
begin
  if p_status not in ('active', 'archived') then
    raise exception 'INVALID_PLAN: status' using errcode = 'P0001';
  end if;
  update public.service_plans existing
  set status = p_status, archived_at = case when p_status = 'archived' then coalesce(existing.archived_at, now()) end
  where existing.garage_id = target_garage and existing.id = p_plan_id
  returning * into plan;
  if not found then
    raise exception 'SERVICE_PLAN_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'service_plan.' || case when p_status = 'archived' then 'archived' else 'restored' end,
          'service_plan', plan.id::text, '{}'::jsonb);
  return plan;
end
$$;

-- Staff cancel a car's plan. Owners, managers and front desk. NOT plan gated:
-- a garage that moved to Essentials must still be able to stop collecting.
-- The server stops the provider's subscription first; this records it.
-- Audited service_plan.subscription_cancelled.
create function public.cancel_plan_subscription(p_subscription_id uuid, p_reason text default null)
returns public.customer_plan_subscriptions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.service_plan_actor_garage(array['owner', 'manager', 'front_desk'], false);
  subscription public.customer_plan_subscriptions;
  reason text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
begin
  select * into subscription from public.customer_plan_subscriptions s
  where s.garage_id = target_garage and s.id = p_subscription_id
  for update;
  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if subscription.status = 'cancelled' then
    return subscription;
  end if;
  update public.customer_plan_subscriptions s
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
      cancel_reason = coalesce(reason, 'Cancelled by the garage')
  where s.id = subscription.id
  returning * into subscription;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'service_plan.subscription_cancelled', 'customer_plan_subscription', subscription.id::text,
          jsonb_build_object('provider', subscription.provider));
  return subscription;
end
$$;

-- Staff record that a booking used its car's included service (staff
-- bookings, or an online booking made before the car joined). Any member; Pro.
create function public.use_plan_benefit(p_booking_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.service_plan_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
begin
  return public.service_plan_record_use(target_garage, p_booking_id, 'staff', auth.uid());
end
$$;

-- Staff give a booking's included use back (it was charged after all). Any
-- member; Pro.
create function public.release_plan_benefit(p_booking_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.service_plan_actor_garage(array['owner', 'manager', 'technician', 'front_desk']);
  released integer;
begin
  update public.service_plan_uses plan_use
  set status = 'released', released_at = now()
  where plan_use.garage_id = target_garage and plan_use.booking_id = p_booking_id and plan_use.status = 'used';
  get diagnostics released = row_count;
  if released > 0 then
    perform public.service_plan_booking_note(target_garage, p_booking_id, 'Service plan use given back.', auth.uid());
  end if;
  return released;
end
$$;

-- Puts the plan's benefits on a draft invoice for a booking whose car is on
-- an active plan, through save_invoice_draft() (its own checks: invoice
-- rights, AAL2 when enrolled). Once per invoice. Rules (A378):
--   * the booking used an included service: every line whose description is
--     the service's name (any case) goes to £0.00 and gets "(included in
--     <plan>)"; with no such line, a £0.00 line "<service> (included in
--     <plan>)" is added. included_pence = what those lines were worth.
--   * discount_percent: floor(% x the subtotal after that) is added to the
--     invoice's discount (never above the subtotal).
-- Returns {invoice_id, included_pence, discount_pence, already}. Errors:
-- UNAUTHORISED (42501), PLAN_REQUIRED, INVOICE_NOT_FOUND, INVOICE_NOT_DRAFT,
-- NOT_ON_PLAN, PLAN_PAST_DUE, NOTHING_TO_APPLY.
create function public.apply_service_plan_to_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  draft public.invoices%rowtype;
  booking record;
  subscription record;
  service_name text;
  included boolean;
  items jsonb;
  new_items jsonb := '[]'::jsonb;
  item jsonb;
  matched boolean := false;
  included_value bigint := 0;
  subtotal_after bigint := 0;
  plan_discount bigint := 0;
  new_discount bigint;
  payload jsonb;
begin
  perform public.require_garage_feature(garage_scope, 'service_plans');

  select * into draft from public.invoices invoice
  where invoice.garage_id = garage_scope and invoice.id = p_invoice_id and invoice.deleted_at is null
  for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.service_plan_invoice_applications application
             where application.garage_id = garage_scope and application.invoice_id = p_invoice_id) then
    return jsonb_build_object('invoice_id', p_invoice_id, 'included_pence', 0, 'discount_pence', 0, 'already', true);
  end if;
  if draft.status <> 'draft' then
    raise exception 'INVOICE_NOT_DRAFT' using errcode = 'P0001';
  end if;
  if draft.booking_id is null then
    raise exception 'NOT_ON_PLAN' using errcode = 'P0001';
  end if;

  select b.id, b.vehicle_id, b.service_id into booking
  from public.bookings b where b.garage_id = garage_scope and b.id = draft.booking_id;
  if not found then
    raise exception 'NOT_ON_PLAN' using errcode = 'P0001';
  end if;
  select s.id, s.status, plan.name as plan_name, plan.discount_percent
  into subscription
  from public.customer_plan_subscriptions s
  join public.service_plans plan on plan.garage_id = s.garage_id and plan.id = s.plan_id
  where s.garage_id = garage_scope and s.vehicle_id = booking.vehicle_id and s.status in ('active', 'past_due');
  if not found then
    raise exception 'NOT_ON_PLAN' using errcode = 'P0001';
  end if;
  if subscription.status = 'past_due' then
    raise exception 'PLAN_PAST_DUE' using errcode = 'P0001';
  end if;

  select service.name into service_name from public.services service
  where service.garage_id = garage_scope and service.id = booking.service_id;
  included := exists (
    select 1 from public.service_plan_uses plan_use
    where plan_use.garage_id = garage_scope and plan_use.booking_id = booking.id and plan_use.subscription_id = subscription.id and plan_use.status = 'used'
  );

  select coalesce(jsonb_agg(jsonb_build_object(
           'description', invoice_item.description,
           'quantity', invoice_item.quantity,
           'unit_price_pence', invoice_item.unit_price_pence,
           'line_total_pence', invoice_item.line_total_pence
         ) order by invoice_item.position), '[]'::jsonb)
  into items
  from public.invoice_items invoice_item
  where invoice_item.garage_id = garage_scope and invoice_item.invoice_id = draft.id;

  for item in select value from jsonb_array_elements(items) loop
    if included and service_name is not null and lower(btrim(item->>'description')) = lower(btrim(service_name)) then
      matched := true;
      included_value := included_value + (item->>'line_total_pence')::bigint;
      new_items := new_items || jsonb_build_object(
        'description', left(item->>'description' || ' (included in ' || subscription.plan_name || ')', 500),
        'quantity', item->'quantity', 'unit_price_pence', 0);
    else
      subtotal_after := subtotal_after + (item->>'line_total_pence')::bigint;
      new_items := new_items || jsonb_build_object(
        'description', item->>'description', 'quantity', item->'quantity', 'unit_price_pence', item->'unit_price_pence');
    end if;
  end loop;
  if included and not matched and service_name is not null then
    new_items := new_items || jsonb_build_object(
      'description', left(service_name || ' (included in ' || subscription.plan_name || ')', 500),
      'quantity', 1, 'unit_price_pence', 0);
  end if;
  if jsonb_array_length(new_items) > 100 then
    raise exception 'INVOICE_ITEM_COUNT_INVALID' using errcode = 'P0001';
  end if;

  plan_discount := floor(subtotal_after * subscription.discount_percent / 100.0)::bigint;
  new_discount := least(draft.discount_pence + plan_discount, subtotal_after);
  plan_discount := greatest(new_discount - least(draft.discount_pence, subtotal_after), 0);
  if not included and plan_discount = 0 then
    raise exception 'NOTHING_TO_APPLY' using errcode = 'P0001';
  end if;

  payload := jsonb_build_object(
    'source_type', draft.source_type,
    'booking_id', draft.booking_id,
    'enquiry_id', draft.enquiry_id,
    'customer_id', draft.customer_id,
    'vehicle_id', draft.vehicle_id,
    'customer_name', draft.customer_name,
    'customer_email', draft.customer_email,
    'customer_phone', draft.customer_phone,
    'customer_address', draft.customer_address,
    'vehicle_registration', draft.vehicle_registration,
    'vehicle_make', draft.vehicle_make,
    'vehicle_model', draft.vehicle_model,
    'service_name', draft.service_name,
    'appointment_start', draft.appointment_start,
    'issue_date', draft.issue_date,
    'due_date', draft.due_date,
    'notes', draft.notes,
    'payment_terms', draft.payment_terms,
    'discount_pence', new_discount,
    'tax_pence', draft.tax_pence,
    'items', new_items
  );
  perform public.save_invoice_draft(draft.id, payload, false);

  insert into public.service_plan_invoice_applications (garage_id, invoice_id, subscription_id, included_pence, discount_pence, applied_by)
  values (garage_scope, draft.id, subscription.id, included_value, plan_discount, actor_id);

  return jsonb_build_object('invoice_id', draft.id, 'included_pence', included_value, 'discount_pence', plan_discount, 'already', false);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Service-role functions (garage host sign-up, webhooks, booking flow)
-- ---------------------------------------------------------------------------

-- Starts a sign-up on the garage host: links the customer by phone and the
-- car by registration (as create_booking() does; consent is never changed
-- here) and returns the pending_mandate subscription. A pending sign-up for
-- the same car is reused (new plan/price/provider, checkout cleared). The
-- garage must have Pro, the plan must be active and the garage's payment
-- account active for p_provider. Errors: PLAN_REQUIRED, PLAN_NOT_AVAILABLE,
-- PAYMENTS_NOT_READY, ALREADY_ON_PLAN, INVALID_SIGNUP.
create function public.start_plan_signup(p_garage_id uuid, p_plan_id uuid, p_customer jsonb, p_vehicle jsonb, p_provider text)
returns public.customer_plan_subscriptions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  plan public.service_plans;
  customer_name text := btrim(regexp_replace(coalesce(p_customer->>'name', ''), '[[:space:]]+', ' ', 'g'));
  customer_phone text := btrim(coalesce(p_customer->>'phone', ''));
  customer_email text := lower(nullif(btrim(coalesce(p_customer->>'email', '')), ''));
  customer_channel text := coalesce(nullif(btrim(coalesce(p_customer->>'channel', '')), ''), 'sms');
  vehicle_registration text := upper(regexp_replace(coalesce(p_vehicle->>'registration', ''), '[^A-Za-z0-9]', '', 'g'));
  vehicle_make text := nullif(left(btrim(coalesce(p_vehicle->>'make', '')), 80), '');
  vehicle_model text := nullif(left(btrim(coalesce(p_vehicle->>'model', '')), 120), '');
  matched_customer uuid;
  matched_vehicle uuid;
  existing public.customer_plan_subscriptions;
  subscription public.customer_plan_subscriptions;
begin
  perform public.require_garage_feature(p_garage_id, 'service_plans');
  if p_provider not in ('mock', 'stripe') then
    raise exception 'INVALID_SIGNUP: provider' using errcode = 'P0001';
  end if;
  select * into plan from public.service_plans existing_plan
  where existing_plan.garage_id = p_garage_id and existing_plan.id = p_plan_id;
  if not found or plan.status <> 'active' then
    raise exception 'PLAN_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.payment_accounts account
    where account.garage_id = p_garage_id and account.provider = p_provider and account.status = 'active' and account.charges_enabled
  ) then
    raise exception 'PAYMENTS_NOT_READY' using errcode = 'P0001';
  end if;

  if char_length(customer_name) not between 2 and 120 then
    raise exception 'INVALID_SIGNUP: name' using errcode = 'P0001';
  end if;
  if customer_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'INVALID_SIGNUP: phone' using errcode = 'P0001';
  end if;
  if customer_email is not null and (char_length(customer_email) > 254 or customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'INVALID_SIGNUP: email' using errcode = 'P0001';
  end if;
  if customer_channel not in ('sms', 'whatsapp', 'email') or (customer_channel = 'email' and customer_email is null) then
    raise exception 'INVALID_SIGNUP: channel' using errcode = 'P0001';
  end if;
  if vehicle_registration !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'INVALID_SIGNUP: registration' using errcode = 'P0001';
  end if;

  insert into public.customers as customer (garage_id, name, phone, email, preferred_contact, channel)
  values (p_garage_id, customer_name, customer_phone, customer_email,
          case customer_channel when 'sms' then 'phone' else customer_channel end, customer_channel)
  on conflict (garage_id, phone) do update
  set name = excluded.name,
      email = coalesce(excluded.email, customer.email),
      channel = excluded.channel,
      preferred_contact = excluded.preferred_contact
  returning customer.id into matched_customer;

  insert into public.vehicles as vehicle (garage_id, customer_id, registration, make, model)
  values (p_garage_id, matched_customer, vehicle_registration, vehicle_make, vehicle_model)
  on conflict (garage_id, registration) do update
  set customer_id = excluded.customer_id,
      make = coalesce(excluded.make, vehicle.make),
      model = coalesce(excluded.model, vehicle.model)
  returning vehicle.id into matched_vehicle;

  select * into existing from public.customer_plan_subscriptions s
  where s.garage_id = p_garage_id and s.vehicle_id = matched_vehicle and s.status <> 'cancelled'
  for update;
  if found and existing.status <> 'pending_mandate' then
    raise exception 'ALREADY_ON_PLAN' using errcode = 'P0001';
  end if;

  if found then
    update public.customer_plan_subscriptions s
    set plan_id = plan.id, customer_id = matched_customer, price_pence = plan.price_pence, provider = p_provider,
        checkout_ref = null
    where s.id = existing.id
    returning * into subscription;
  else
    insert into public.customer_plan_subscriptions (garage_id, plan_id, customer_id, vehicle_id, status, price_pence, provider)
    values (p_garage_id, plan.id, matched_customer, matched_vehicle, 'pending_mandate', plan.price_pence, p_provider)
    returning * into subscription;
  end if;
  return subscription;
end
$$;

-- Stores the provider's checkout id on a pending sign-up.
create function public.set_plan_subscription_checkout(p_garage_id uuid, p_subscription_id uuid, p_checkout_ref text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.customer_plan_subscriptions s
  set checkout_ref = left(p_checkout_ref, 255)
  where s.garage_id = p_garage_id and s.id = p_subscription_id and s.status = 'pending_mandate'
$$;

-- Applies the provider's view of a subscription (the signed webhook, the
-- customer's return from the provider, or the mock confirm page). Never plan
-- gated: Direct Debits set up on Pro keep being tracked after a downgrade
-- (A380). p_status null only stores refs/renewal. Transitions:
--   pending_mandate -> active      started_at set, notify 'confirmation'
--   pending/active -> past_due     last_payment_failed_at, notify 'payment_failed' (once per run of failures)
--   past_due -> active             no message
--   any -> cancelled               final; a cancelled subscription never comes back
-- Row locked, so two deliveries of the same news notify once. Returns
-- {changed, previous, status, notify, subscription_id}. Audited.
create function public.apply_plan_subscription_status(
  p_garage_id uuid,
  p_subscription_id uuid,
  p_provider text,
  p_status text,
  p_mandate_ref text,
  p_subscription_ref text,
  p_renews_at timestamptz,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  subscription public.customer_plan_subscriptions;
  previous text;
  next_status text;
  notify text;
begin
  if p_status is not null and p_status not in ('active', 'past_due', 'cancelled') then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;
  select * into subscription from public.customer_plan_subscriptions s
  where s.garage_id = p_garage_id and s.id = p_subscription_id
  for update;
  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if subscription.provider is distinct from p_provider then
    raise exception 'PROVIDER_MISMATCH' using errcode = 'P0001';
  end if;
  if p_subscription_ref is not null and subscription.subscription_ref is not null and subscription.subscription_ref <> p_subscription_ref then
    raise exception 'PROVIDER_MISMATCH' using errcode = 'P0001';
  end if;

  previous := subscription.status;
  next_status := coalesce(p_status, previous);
  if previous = 'cancelled' then
    next_status := 'cancelled';
  end if;
  notify := case
    when previous = 'pending_mandate' and next_status = 'active' then 'confirmation'
    when previous <> 'past_due' and previous <> 'cancelled' and next_status = 'past_due' then 'payment_failed'
  end;

  update public.customer_plan_subscriptions s
  set status = next_status,
      mandate_ref = coalesce(left(p_mandate_ref, 255), s.mandate_ref),
      subscription_ref = coalesce(left(p_subscription_ref, 255), s.subscription_ref),
      started_at = case when next_status in ('active', 'past_due') then coalesce(s.started_at, p_at) else s.started_at end,
      renews_at = coalesce(p_renews_at, s.renews_at),
      last_payment_failed_at = case when next_status = 'past_due' and previous <> 'past_due' then p_at else s.last_payment_failed_at end,
      cancelled_at = case when next_status = 'cancelled' then coalesce(s.cancelled_at, p_at) end,
      cancel_reason = case when next_status = 'cancelled' then coalesce(s.cancel_reason, 'Direct Debit cancelled') end
  where s.id = subscription.id
  returning * into subscription;

  if next_status <> previous then
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (p_garage_id, null, 'service_plan.subscription_' || next_status, 'customer_plan_subscription', subscription.id::text,
            jsonb_build_object('previous', previous, 'provider', p_provider));
  end if;
  return jsonb_build_object('changed', next_status <> previous, 'previous', previous, 'status', next_status,
                            'notify', notify, 'subscription_id', subscription.id);
end
$$;

-- After create_booking() in the online flow: records the included use when
-- the booking's car is on an active plan (see service_plan_record_use()).
-- Quietly {on_plan:false} for a garage without Pro (A380): benefits are a
-- Pro feature; a downgraded garage honours them by hand.
create function public.record_plan_booking(p_garage_id uuid, p_booking_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.garage_has_feature(p_garage_id, 'service_plans') then
    return jsonb_build_object('on_plan', false, 'reason', 'plan_required');
  end if;
  return public.service_plan_record_use(p_garage_id, p_booking_id, 'online', null);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Bookings: a cancelled booking gives its included use back. A no-show
--    keeps it (the slot was held; A377).
-- ---------------------------------------------------------------------------

create function public.service_plans_follow_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.service_plan_uses plan_use
    set status = 'released', released_at = now()
    where plan_use.garage_id = new.garage_id and plan_use.booking_id = new.id and plan_use.status = 'used';
  end if;
  return new;
end
$$;

create trigger bookings_service_plans_follow after update of status on public.bookings
  for each row execute function public.service_plans_follow_booking();

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
-- anon: nothing. Members read every table; owners/managers write plans and
-- inclusions through RLS (Pro) or save_service_plan(); subscriptions, uses
-- and invoice applications are written only by the functions above.

revoke all on public.service_plans, public.service_plan_inclusions, public.customer_plan_subscriptions,
  public.service_plan_uses, public.service_plan_invoice_applications from anon, authenticated;
grant select, insert, update on public.service_plans to authenticated;
grant select, insert, update, delete on public.service_plan_inclusions to authenticated;
grant select on public.customer_plan_subscriptions, public.service_plan_uses, public.service_plan_invoice_applications to authenticated;
grant select, insert, update, delete on public.service_plans, public.service_plan_inclusions, public.customer_plan_subscriptions,
  public.service_plan_uses, public.service_plan_invoice_applications to service_role;

revoke all on function public.service_plan_actor_garage(text[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.service_plan_booking_note(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.service_plan_record_use(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.service_plans_follow_booking() from public, anon, authenticated, service_role;
revoke all on function public.service_plan_year_start(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.service_plan_year_start(timestamptz, timestamptz, text) to authenticated, service_role;

revoke all on function public.save_service_plan(uuid, jsonb) from public, anon;
revoke all on function public.set_service_plan_status(uuid, text) from public, anon;
revoke all on function public.cancel_plan_subscription(uuid, text) from public, anon;
revoke all on function public.use_plan_benefit(uuid) from public, anon;
revoke all on function public.release_plan_benefit(uuid) from public, anon;
revoke all on function public.apply_service_plan_to_invoice(uuid) from public, anon;
grant execute on function public.save_service_plan(uuid, jsonb) to authenticated;
grant execute on function public.set_service_plan_status(uuid, text) to authenticated;
grant execute on function public.cancel_plan_subscription(uuid, text) to authenticated;
grant execute on function public.use_plan_benefit(uuid) to authenticated;
grant execute on function public.release_plan_benefit(uuid) to authenticated;
grant execute on function public.apply_service_plan_to_invoice(uuid) to authenticated;

revoke all on function public.start_plan_signup(uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.set_plan_subscription_checkout(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.apply_plan_subscription_status(uuid, uuid, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.record_plan_booking(uuid, uuid) from public, anon, authenticated;
grant execute on function public.start_plan_signup(uuid, uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.set_plan_subscription_checkout(uuid, uuid, text) to service_role;
grant execute on function public.apply_plan_subscription_status(uuid, uuid, text, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.record_plan_booking(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Row-level security
-- ---------------------------------------------------------------------------

alter table public.service_plans enable row level security;
alter table public.service_plan_inclusions enable row level security;
alter table public.customer_plan_subscriptions enable row level security;
alter table public.service_plan_uses enable row level security;
alter table public.service_plan_invoice_applications enable row level security;

-- service_plans
--   "garage members read service plans"          select  members of the selected garage (any plan: readable after a downgrade)
--   "owners and managers add service plans"      insert  owners/managers of the selected garage, Pro (service_plans)
--   "owners and managers change service plans"   update  owners/managers of the selected garage, Pro
--   (no delete: plans are archived, so subscriptions keep their plan)
create policy "garage members read service plans" on public.service_plans
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add service plans" on public.service_plans
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'service_plans')
  );
create policy "owners and managers change service plans" on public.service_plans
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'service_plans')
  );

-- service_plan_inclusions
--   "garage members read plan inclusions"          select  members of the selected garage
--   "owners and managers add plan inclusions"      insert  owners/managers of the selected garage, Pro
--   "owners and managers change plan inclusions"   update  owners/managers of the selected garage, Pro
--   "owners and managers remove plan inclusions"   delete  owners/managers of the selected garage, Pro
create policy "garage members read plan inclusions" on public.service_plan_inclusions
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add plan inclusions" on public.service_plan_inclusions
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'service_plans')
  );
create policy "owners and managers change plan inclusions" on public.service_plan_inclusions
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'service_plans')
  );
create policy "owners and managers remove plan inclusions" on public.service_plan_inclusions
  for delete to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'service_plans')
  );

-- customer_plan_subscriptions
--   "garage members read plan subscriptions"  select  members of the selected garage
--   (no write grants: start_plan_signup(), set_plan_subscription_checkout(), apply_plan_subscription_status() (service role), cancel_plan_subscription())
create policy "garage members read plan subscriptions" on public.customer_plan_subscriptions
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- service_plan_uses
--   "garage members read plan uses"  select  members of the selected garage
--   (no write grants: record_plan_booking() (service role), use_plan_benefit(), release_plan_benefit(), the booking trigger)
create policy "garage members read plan uses" on public.service_plan_uses
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- service_plan_invoice_applications
--   "garage members read plan invoice applications"  select  members of the selected garage
--   (no write grants: apply_service_plan_to_invoice())
create policy "garage members read plan invoice applications" on public.service_plan_invoice_applications
  for select to authenticated using (garage_id = (select public.current_garage_id()));
