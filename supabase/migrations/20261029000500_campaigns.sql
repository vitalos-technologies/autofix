-- Autofix campaigns (Phase 5, P5.5; D17 "campaigns to opted-in customers
-- (seasonal, win-back, segmented by car age or MOT month)"). Pro feature
-- `campaigns`.
--
--   1. Tenant tables campaigns (one message to a segment of customers) and
--      campaign_sends (one row per recipient: idempotent, frozen when the
--      campaign is scheduled). RLS on current_garage_id(); select policies do
--      not check the plan (results stay readable after a downgrade); write
--      policies and every function that does campaign work check
--      garage_has_feature(garage_id, 'campaigns').
--   2. Segments, evaluated in SQL: campaign_segment_problem() validates the
--      jsonb, campaign_audience() (internal) lists matching customers who
--      have stored consent (reminder_consent, not opted out, not anonymised,
--      an address for their channel) and a car; preview_campaign_audience()
--      gives owners/managers the count and a preview.
--   3. schedule_campaign() freezes the audience into campaign_sends and
--      queues the `campaigns.send` job; cancel_campaign() stops the rest.
--   4. claim_campaign_sends() (service role, the send job) re-checks consent,
--      opt-out, address and the plan at claim time (Essentials garages send
--      nothing: their due rows are skipped with plan_required).
--   5. STOP and other withdrawals cancel scheduled campaign sends at once
--      (trigger on customers: opted_out_at, anonymised_at, reminder_consent),
--      delivery receipts follow the messages row (trigger on messages.status).
--   6. Results: attribute_campaign_booking() credits a booking made from a
--      campaign link to the send (service role, called right after a
--      successful create_booking(); create_booking() itself is unchanged),
--      campaign_results() reports sent, delivered, opened, bookings and pence.
--
-- Nothing here redefines create_booking(), create_booking_at(),
-- available_slots*(), schedule_reminders() or claim_reminder_sends().
--
-- Rollback notes (manual): drop trigger customers_cancel_campaign_sends on
-- public.customers; drop trigger messages_campaign_send_status on
-- public.messages; drop the functions below; drop table
-- public.campaign_sends, public.campaigns (their rows are lost). Queued
-- `campaigns.send` jobs then fail with an unknown kind until removed.

-- ---------------------------------------------------------------------------
-- 1. Segment validation
-- ---------------------------------------------------------------------------

-- Null when the segment is valid, else a short reason. A segment is a JSON
-- object with only these keys (all optional; absent or null = no filter):
--   car_age_min, car_age_max  whole years 0-60 (vehicles.year; min <= max)
--   mot_months                distinct months 1-12 (vehicles.mot_expiry)
--   not_seen_months           1-120: last visit longer ago than this (or never)
--   service_id + service_history ('had' | 'never'): bookings of that service
--   channels                  non-empty subset of sms, whatsapp, email
create function public.campaign_segment_problem(p_segment jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  key text;
  value jsonb;
  item jsonb;
  seen text[] := '{}';
begin
  if p_segment is null or jsonb_typeof(p_segment) <> 'object' then
    return 'segment must be an object';
  end if;
  for key, value in select entry.key, entry.value from jsonb_each(p_segment) entry loop
    if key not in ('car_age_min', 'car_age_max', 'mot_months', 'not_seen_months', 'service_id', 'service_history', 'channels') then
      return 'unknown key ' || key;
    end if;
    continue when jsonb_typeof(value) = 'null';
    if key in ('car_age_min', 'car_age_max') then
      if jsonb_typeof(value) <> 'number' or value::text !~ '^[0-9]{1,2}$' or value::text::integer > 60 then
        return key || ' must be 0-60';
      end if;
    elsif key = 'not_seen_months' then
      if jsonb_typeof(value) <> 'number' or value::text !~ '^[0-9]{1,3}$' or value::text::integer not between 1 and 120 then
        return 'not_seen_months must be 1-120';
      end if;
    elsif key = 'mot_months' then
      if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) > 12 then
        return 'mot_months must be a list of months';
      end if;
      for item in select element from jsonb_array_elements(value) element loop
        if jsonb_typeof(item) <> 'number' or item::text !~ '^[0-9]{1,2}$' or item::text::integer not between 1 and 12
           or item::text = any (seen) then
          return 'mot_months must be distinct months 1-12';
        end if;
        seen := seen || item::text;
      end loop;
    elsif key = 'service_id' then
      if jsonb_typeof(value) <> 'string'
         or (value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return 'service_id must be a uuid';
      end if;
    elsif key = 'service_history' then
      if jsonb_typeof(value) <> 'string' or (value #>> '{}') not in ('had', 'never') then
        return 'service_history must be had or never';
      end if;
    elsif key = 'channels' then
      if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) not between 1 and 3 then
        return 'channels must list sms, whatsapp or email';
      end if;
      seen := '{}';
      for item in select element from jsonb_array_elements(value) element loop
        if jsonb_typeof(item) <> 'string' or (item #>> '{}') not in ('sms', 'whatsapp', 'email') or (item #>> '{}') = any (seen) then
          return 'channels must list sms, whatsapp or email';
        end if;
        seen := seen || (item #>> '{}');
      end loop;
    end if;
  end loop;
  if (p_segment ->> 'car_age_min') is not null and (p_segment ->> 'car_age_max') is not null
     and (p_segment ->> 'car_age_min')::integer > (p_segment ->> 'car_age_max')::integer then
    return 'car_age_min must not be above car_age_max';
  end if;
  if ((p_segment ->> 'service_id') is null) <> ((p_segment ->> 'service_history') is null) then
    return 'service_id and service_history go together';
  end if;
  return null;
end
$$;

comment on function public.campaign_segment_problem(jsonb) is
  'P5.5: null when a campaign segment is valid, else the reason. Mirrors campaignSegmentSchema in src/lib/campaigns/segment.ts.';

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- One campaign: a message to a segment of the garage's opted-in customers.
-- draft -> scheduled (schedule_campaign(): recipients frozen into
-- campaign_sends) -> sending (first claim) -> sent (nothing left scheduled);
-- scheduled/sending -> cancelled (cancel_campaign()). Staff edit drafts only.
-- template is the SMS/WhatsApp wording ("Reply STOP to opt out." is added
-- when sent); email_template (null = template) and email_subject are the
-- email variant, which gets the unsubscribe link. service_id is the service
-- the campaign link opens on the booking page (null = the customer picks).
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  name text not null,
  starter text,
  segment jsonb not null default '{}'::jsonb,
  template text not null,
  email_subject text not null,
  email_template text,
  service_id uuid,
  status text not null default 'draft',
  send_at timestamptz,
  recipients integer,
  scheduled_at timestamptz,
  scheduled_by uuid references auth.users(id) on delete set null,
  finished_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_garage_id_id_key unique (garage_id, id),
  constraint campaigns_service_id_fkey foreign key (garage_id, service_id)
    references public.services (garage_id, id) on delete set null (service_id),
  constraint campaigns_name_check check (char_length(btrim(name)) between 1 and 80),
  constraint campaigns_starter_check check (starter is null or starter in ('winter_check', 'summer_aircon', 'win_back', 'mot_month')),
  constraint campaigns_segment_check check (public.campaign_segment_problem(segment) is null),
  constraint campaigns_template_check check (char_length(btrim(template)) between 1 and 1000),
  constraint campaigns_email_subject_check check (char_length(btrim(email_subject)) between 1 and 150),
  constraint campaigns_email_template_check check (email_template is null or char_length(btrim(email_template)) between 1 and 2000),
  constraint campaigns_status_check check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  constraint campaigns_schedule_check check (status = 'draft' or (send_at is not null and recipients is not null and scheduled_at is not null)),
  constraint campaigns_recipients_check check (recipients is null or recipients >= 0),
  constraint campaigns_cancelled_check check ((status = 'cancelled') = (cancelled_at is not null))
);

create index campaigns_garage_created_idx on public.campaigns (garage_id, created_at desc);
create index campaigns_garage_service_idx on public.campaigns (garage_id, service_id) where service_id is not null;

comment on table public.campaigns is
  'P5.5 (Pro): marketing campaigns to opted-in customers. Recipients are frozen in campaign_sends by schedule_campaign().';

-- One row per recipient of a campaign (unique per campaign and customer, so
-- scheduling and sending are idempotent). Claimed by claim_campaign_sends()
-- (scheduled -> sending, or skipped with a reason), then updated by the
-- sender (sent/failed) and by delivery receipts through the messages row
-- (delivered/failed). channel is the customer's channel when claimed.
-- link_token_hash: SHA-256 hex of the /c/{token} link token. booking_id: the
-- booking credited to this send (attribute_campaign_booking()).
create table public.campaign_sends (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  campaign_id uuid not null,
  customer_id uuid not null,
  vehicle_id uuid not null,
  channel text not null,
  send_at timestamptz not null,
  status text not null default 'scheduled',
  skip_reason text,
  claimed_at timestamptz,
  message_id uuid,
  provider_msg_id text,
  link_token_hash text,
  link_expires_at timestamptz,
  opened_at timestamptz,
  booking_id uuid,
  body text,
  sent_at timestamptz,
  delivered_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_sends_garage_id_id_key unique (garage_id, id),
  constraint campaign_sends_recipient_key unique (garage_id, campaign_id, customer_id),
  constraint campaign_sends_campaign_id_fkey foreign key (garage_id, campaign_id)
    references public.campaigns (garage_id, id) on delete cascade,
  constraint campaign_sends_customer_id_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id) on delete cascade,
  constraint campaign_sends_vehicle_id_fkey foreign key (garage_id, vehicle_id)
    references public.vehicles (garage_id, id) on delete cascade,
  constraint campaign_sends_message_id_fkey foreign key (garage_id, message_id)
    references public.messages (garage_id, id) on delete set null (message_id),
  constraint campaign_sends_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete set null (booking_id),
  constraint campaign_sends_channel_check check (channel in ('sms', 'whatsapp', 'email')),
  constraint campaign_sends_status_check check (status in (
    'scheduled', 'sending', 'sent', 'delivered', 'failed', 'cancelled', 'skipped'
  )),
  constraint campaign_sends_skip_reason_check check (
    (status in ('skipped', 'cancelled')) = (skip_reason is not null)
    and (skip_reason is null or skip_reason ~ '^[a-z][a-z_]{1,39}$')
  ),
  constraint campaign_sends_claimed_check check (status not in ('sending', 'sent', 'delivered', 'failed') or claimed_at is not null),
  constraint campaign_sends_sent_check check (status not in ('sent', 'delivered') or sent_at is not null),
  constraint campaign_sends_link_check check (
    (link_token_hash is null) = (link_expires_at is null)
    and (link_token_hash is null or link_token_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint campaign_sends_provider_msg_id_check check (provider_msg_id is null or char_length(provider_msg_id) between 1 and 64),
  constraint campaign_sends_body_check check (body is null or char_length(body) <= 4000),
  constraint campaign_sends_error_code_check check (error_code is null or char_length(error_code) <= 64)
);

create index campaign_sends_due_idx on public.campaign_sends (garage_id, send_at) where status = 'scheduled';
create index campaign_sends_garage_campaign_idx on public.campaign_sends (garage_id, campaign_id, status);
create index campaign_sends_garage_customer_idx on public.campaign_sends (garage_id, customer_id);
create index campaign_sends_garage_vehicle_idx on public.campaign_sends (garage_id, vehicle_id);
create index campaign_sends_garage_message_idx on public.campaign_sends (garage_id, message_id) where message_id is not null;
create unique index campaign_sends_booking_key on public.campaign_sends (garage_id, booking_id) where booking_id is not null;
create unique index campaign_sends_link_token_hash_key on public.campaign_sends (garage_id, link_token_hash)
  where link_token_hash is not null;

comment on column public.campaign_sends.link_token_hash is
  'SHA-256 hex of the /c/{token} campaign link token (16 random bytes). The token itself is never stored.';
comment on column public.campaign_sends.booking_id is
  'The booking credited to this send by attribute_campaign_booking() (same customer and car, made through the link). One send per booking.';

create trigger campaigns_updated before update on public.campaigns
  for each row execute function public.set_updated_at();
create trigger campaign_sends_updated before update on public.campaign_sends
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Segments
-- ---------------------------------------------------------------------------

-- The customers of p_garage_id a campaign with this segment goes to, as of
-- p_now, with one car each. Internal (no grants): definer functions call it.
--   consent   reminder_consent, not opted out, not anonymised, and an address
--             for their channel (email for email, else the mobile);
--   car       one of their cars matching the car filters (age by
--             vehicles.year in the garage's year; MOT month only while the
--             garage does MOTs: MOT_DISABLED otherwise); customers with no car
--             are left out (a campaign is about a car). Of several matching
--             cars the most recently booked, then the newest, is used;
--   last visit the latest past booking that went ahead (confirmed or later,
--             not cancelled/no-show/trashed) or recorded service; with
--             not_seen_months, customers seen in that time, or with a booking
--             coming up, are left out (never seen counts as not seen);
--   service   had: a past booking of that service went ahead; never: none did.
create function public.campaign_audience(p_garage_id uuid, p_segment jsonb, p_now timestamptz)
returns table (
  customer_id uuid,
  customer_name text,
  phone text,
  email text,
  channel text,
  vehicle_id uuid,
  registration text,
  make text,
  model text,
  last_visit timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  problem text := public.campaign_segment_problem(p_segment);
  garage_zone text;
  garage_mot boolean;
  age_min integer;
  age_max integer;
  months integer[];
  not_seen integer;
  history_service uuid;
  history text;
  wanted_channels text[];
  local_year integer;
begin
  if problem is not null then
    raise exception 'INVALID_SEGMENT: %', problem using errcode = '22023';
  end if;
  select garage.timezone, garage.mot_enabled into garage_zone, garage_mot
  from public.garages garage where garage.id = p_garage_id;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  age_min := (p_segment ->> 'car_age_min')::integer;
  age_max := (p_segment ->> 'car_age_max')::integer;
  not_seen := (p_segment ->> 'not_seen_months')::integer;
  history_service := (p_segment ->> 'service_id')::uuid;
  history := p_segment ->> 'service_history';
  if jsonb_typeof(p_segment -> 'mot_months') = 'array' and jsonb_array_length(p_segment -> 'mot_months') > 0 then
    months := array(select element::integer from jsonb_array_elements_text(p_segment -> 'mot_months') element);
  end if;
  if jsonb_typeof(p_segment -> 'channels') = 'array' then
    wanted_channels := array(select element from jsonb_array_elements_text(p_segment -> 'channels') element);
  end if;
  if months is not null and not garage_mot then
    raise exception 'MOT_DISABLED: MOT months need MOTs switched on' using errcode = 'P0001';
  end if;
  local_year := extract(year from (p_now at time zone garage_zone))::integer;

  return query
  with eligible as (
    select customer.id, customer.name, customer.phone, customer.email, customer.channel
    from public.customers customer
    where customer.garage_id = p_garage_id
      and customer.anonymised_at is null
      and customer.opted_out_at is null
      and customer.reminder_consent
      and case when customer.channel = 'email' then customer.email is not null else customer.phone is not null end
      and (wanted_channels is null or customer.channel = any (wanted_channels))
  ),
  visited as (
    select
      eligible.*,
      greatest(
        (
          select max(booking.starts_at)
          from public.bookings booking
          where booking.garage_id = p_garage_id
            and booking.customer_id = eligible.id
            and booking.status in ('confirmed', 'arrived', 'in_progress', 'waiting_parts', 'ready', 'collected')
            and booking.deleted_at is null
            and booking.starts_at <= p_now
        ),
        (
          select max(vehicle.last_service_at)
          from public.vehicles vehicle
          where vehicle.garage_id = p_garage_id
            and vehicle.customer_id = eligible.id
            and vehicle.last_service_at <= p_now
        )
      ) as last_seen
    from eligible
  )
  select
    visited.id, visited.name, visited.phone, visited.email, visited.channel,
    car.id, car.registration, car.make, car.model,
    visited.last_seen
  from visited
  cross join lateral (
    select vehicle.id, vehicle.registration, vehicle.make, vehicle.model
    from public.vehicles vehicle
    where vehicle.garage_id = p_garage_id
      and vehicle.customer_id = visited.id
      and vehicle.registration is not null
      and (age_min is null or (vehicle.year is not null and local_year - vehicle.year >= age_min))
      and (age_max is null or (vehicle.year is not null and local_year - vehicle.year <= age_max))
      and (months is null or (vehicle.mot_expiry is not null and extract(month from vehicle.mot_expiry)::integer = any (months)))
    order by (
      select max(booking.starts_at) from public.bookings booking
      where booking.garage_id = p_garage_id and booking.vehicle_id = vehicle.id and booking.deleted_at is null
    ) desc nulls last, vehicle.created_at desc, vehicle.id
    limit 1
  ) car
  where (
      not_seen is null
      or (
        (visited.last_seen is null or visited.last_seen < p_now - make_interval(months => not_seen))
        and not exists (
          select 1 from public.bookings booking
          where booking.garage_id = p_garage_id
            and booking.customer_id = visited.id
            and booking.status in ('requested', 'confirmed')
            and booking.deleted_at is null
            and booking.starts_at > p_now
        )
      )
    )
    and (
      history is null
      or (history = 'had') = exists (
        select 1 from public.bookings booking
        where booking.garage_id = p_garage_id
          and booking.customer_id = visited.id
          and booking.service_id = history_service
          and booking.status in ('confirmed', 'arrived', 'in_progress', 'waiting_parts', 'ready', 'collected')
          and booking.deleted_at is null
          and booking.starts_at <= p_now
      )
    )
  order by visited.name, visited.id;
end
$$;

comment on function public.campaign_audience(uuid, jsonb, timestamptz) is
  'P5.5 internal: customers (with stored consent and a car) a campaign segment matches. Called by preview_campaign_audience() and schedule_campaign().';

-- Owners and managers of the selected garage (garage_actor_allowed(), Pro):
-- how many customers the segment matches now, and the first p_limit (max 50)
-- of them by name. Always one row: total 0 and nulls when nobody matches.
create function public.preview_campaign_audience(p_segment jsonb, p_limit integer default 20)
returns table (
  total integer,
  customer_id uuid,
  customer_name text,
  phone text,
  email text,
  channel text,
  vehicle_id uuid,
  registration text,
  make text,
  model text,
  last_visit timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  target_garage uuid := public.current_garage_id();
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'CAMPAIGN_FORBIDDEN: owners and managers only' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'campaigns');

  return query
  with audience as (
    select * from public.campaign_audience(target_garage, p_segment, now())
  ),
  counted as (
    select count(*)::integer as n from audience
  )
  select counted.n, shown.customer_id, shown.customer_name, shown.phone, shown.email, shown.channel,
         shown.vehicle_id, shown.registration, shown.make, shown.model, shown.last_visit
  from counted
  left join lateral (
    select * from audience
    order by audience.customer_name, audience.customer_id
    limit least(greatest(coalesce(p_limit, 20), 0), 50)
  ) shown on true;
end
$$;

comment on function public.preview_campaign_audience(jsonb, integer) is
  'P5.5: owners/managers of the selected garage (Pro): live count and preview of a campaign segment.';

-- ---------------------------------------------------------------------------
-- 4. Scheduling and cancelling
-- ---------------------------------------------------------------------------

-- Owners and managers of the selected garage (Pro): freeze a draft's
-- audience into campaign_sends (one per customer), mark it scheduled for
-- p_send_at (null = now; not in the past, at most a year ahead) and queue the
-- `campaigns.send` job for then. EMPTY_AUDIENCE when nobody matches.
-- Audited campaign.scheduled (counts only).
create function public.schedule_campaign(p_campaign_id uuid, p_send_at timestamptz default null)
returns public.campaigns
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  campaign public.campaigns;
  send_time timestamptz := coalesce(p_send_at, now());
  added integer;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'CAMPAIGN_FORBIDDEN: owners and managers only' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'campaigns');

  select * into campaign from public.campaigns
  where garage_id = target_garage and id = p_campaign_id
  for update;
  if not found then
    raise exception 'CAMPAIGN_NOT_FOUND' using errcode = 'P0001';
  end if;
  if campaign.status <> 'draft' then
    raise exception 'CAMPAIGN_NOT_DRAFT' using errcode = 'P0001';
  end if;
  if send_time < now() - interval '5 minutes' or send_time > now() + interval '366 days' then
    raise exception 'INVALID_SEND_AT: from now to a year ahead' using errcode = '22023';
  end if;
  send_time := greatest(send_time, now());

  insert into public.campaign_sends (garage_id, campaign_id, customer_id, vehicle_id, channel, send_at)
  select target_garage, campaign.id, audience.customer_id, audience.vehicle_id, audience.channel, send_time
  from public.campaign_audience(target_garage, campaign.segment, now()) audience
  on conflict on constraint campaign_sends_recipient_key do nothing;
  get diagnostics added = row_count;
  if added = 0 then
    raise exception 'EMPTY_AUDIENCE: no customer matches this campaign' using errcode = 'P0001';
  end if;

  update public.campaigns
  set status = 'scheduled', send_at = send_time, recipients = added, scheduled_at = now(), scheduled_by = auth.uid()
  where garage_id = target_garage and id = campaign.id
  returning * into campaign;

  perform public.enqueue_job(
    'campaigns.send',
    jsonb_build_object('garageId', target_garage),
    send_time,
    'campaigns.send:' || target_garage || ':' || campaign.id,
    target_garage
  );

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'campaign.scheduled', 'campaign', campaign.id::text,
          jsonb_build_object('recipients', added, 'send_at', send_time));
  return campaign;
end
$$;

comment on function public.schedule_campaign(uuid, timestamptz) is
  'P5.5: owners/managers (Pro) schedule a draft campaign: recipients frozen into campaign_sends, campaigns.send queued for send_at. Audited.';

-- Owners and managers of the selected garage: stop a scheduled or sending
-- campaign; its scheduled sends are cancelled (campaign_cancelled). Not plan
-- gated: stopping messages is always allowed. Audited campaign.cancelled.
create function public.cancel_campaign(p_campaign_id uuid)
returns public.campaigns
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  campaign public.campaigns;
  stopped integer;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'CAMPAIGN_FORBIDDEN: owners and managers only' using errcode = '42501';
  end if;
  select * into campaign from public.campaigns
  where garage_id = target_garage and id = p_campaign_id
  for update;
  if not found then
    raise exception 'CAMPAIGN_NOT_FOUND' using errcode = 'P0001';
  end if;
  if campaign.status not in ('scheduled', 'sending') then
    raise exception 'CAMPAIGN_NOT_SCHEDULED' using errcode = 'P0001';
  end if;

  update public.campaign_sends
  set status = 'cancelled', skip_reason = 'campaign_cancelled'
  where garage_id = target_garage and campaign_id = campaign.id and status = 'scheduled';
  get diagnostics stopped = row_count;

  update public.campaigns
  set status = 'cancelled', cancelled_at = now(), finished_at = coalesce(finished_at, now())
  where garage_id = target_garage and id = campaign.id
  returning * into campaign;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'campaign.cancelled', 'campaign', campaign.id::text, jsonb_build_object('stopped', stopped));
  return campaign;
end
$$;

comment on function public.cancel_campaign(uuid) is
  'P5.5: owners/managers stop a scheduled or sending campaign; its scheduled sends are cancelled. Audited.';

-- ---------------------------------------------------------------------------
-- 5. Claiming sends (service role, the campaigns.send job)
-- ---------------------------------------------------------------------------

-- Claim up to p_limit (max 200) due campaign sends of one garage for sending:
-- each is re-checked and either marked sending (claimed_at = p_now, channel
-- = the customer's channel now) and returned, or skipped with a reason:
--   campaign_cancelled  the campaign was cancelled
--   anonymised, opted_out, no_consent, no_address  (consent re-checked now)
--   vehicle_changed     the car no longer belongs to the customer
--   mot_disabled        an MOT-month campaign after MOTs were switched off
--   expired             more than 7 days past its send time
-- An Essentials garage (no `campaigns`) claims nothing: every due send is
-- skipped with plan_required. Suspended and cancelled garages claim nothing
-- (rows stay scheduled). Quiet hours are not applied here: the app calls this
-- only inside the send window. Campaigns with nothing left scheduled become
-- sent. The caller stores the link hash, sends and records the result.
create function public.claim_campaign_sends(p_garage_id uuid, p_now timestamptz, p_limit integer)
returns table (
  id uuid,
  campaign_id uuid,
  channel text,
  send_at timestamptz,
  template text,
  email_subject text,
  email_template text,
  service_id uuid,
  customer_id uuid,
  customer_name text,
  phone text,
  email text,
  vehicle_id uuid,
  registration text,
  make text,
  model text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  garage_mot boolean;
  garage_status text;
  wanted integer;
  claimed integer := 0;
  batch_claimed integer;
  batch uuid[];
begin
  if p_garage_id is null or p_now is null then
    raise exception 'INVALID_ARGUMENT: garage and clock are required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'INVALID_ARGUMENT: limit must be at least 1' using errcode = '22023';
  end if;
  select garage.mot_enabled, garage.status into garage_mot, garage_status
  from public.garages garage where garage.id = p_garage_id;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if garage_status not in ('onboarding', 'active') then
    return;
  end if;

  -- The plan, as garage_has_feature() decides it for the service role.
  if public.garage_effective_plan(p_garage_id) is distinct from public.plan_feature_plan('campaigns') then
    update public.campaign_sends send
    set status = 'skipped', skip_reason = 'plan_required', claimed_at = p_now
    where send.garage_id = p_garage_id and send.status = 'scheduled' and send.send_at <= p_now;
  else
    wanted := least(p_limit, 200);
    loop
      exit when claimed >= wanted;

      select array_agg(due.id)
      into batch
      from (
        select send.id
        from public.campaign_sends send
        where send.garage_id = p_garage_id
          and send.status = 'scheduled'
          and send.send_at <= p_now
        order by send.send_at, send.id
        limit wanted - claimed
        for update skip locked
      ) due;
      exit when batch is null;

      return query
      with verdict as (
        select
          send.id as send_id,
          customer.channel as route_channel,
          checked.reason
        from public.campaign_sends send
        join public.campaigns campaign on campaign.garage_id = send.garage_id and campaign.id = send.campaign_id
        join public.customers customer on customer.garage_id = send.garage_id and customer.id = send.customer_id
        join public.vehicles vehicle on vehicle.garage_id = send.garage_id and vehicle.id = send.vehicle_id
        cross join lateral (
          select case
            when campaign.status = 'cancelled' then 'campaign_cancelled'
            when customer.anonymised_at is not null then 'anonymised'
            when customer.opted_out_at is not null then 'opted_out'
            when not customer.reminder_consent then 'no_consent'
            when (customer.channel = 'email' and customer.email is null)
              or (customer.channel <> 'email' and customer.phone is null) then 'no_address'
            when vehicle.customer_id is distinct from send.customer_id then 'vehicle_changed'
            when not garage_mot and jsonb_typeof(campaign.segment -> 'mot_months') = 'array'
              and jsonb_array_length(campaign.segment -> 'mot_months') > 0 then 'mot_disabled'
            when p_now > send.send_at + interval '7 days' then 'expired'
          end as reason
        ) checked
        where send.garage_id = p_garage_id
          and send.id = any (batch)
      ),
      skipped as (
        update public.campaign_sends send
        set status = 'skipped', skip_reason = verdict.reason, claimed_at = p_now
        from verdict
        where send.garage_id = p_garage_id
          and send.id = verdict.send_id
          and verdict.reason is not null
        returning send.id
      ),
      taken as (
        update public.campaign_sends send
        set status = 'sending', claimed_at = p_now, channel = verdict.route_channel
        from verdict
        where send.garage_id = p_garage_id
          and send.id = verdict.send_id
          and verdict.reason is null
        returning send.*
      )
      select
        taken.id, taken.campaign_id, taken.channel, taken.send_at,
        campaign.template, campaign.email_subject, campaign.email_template, campaign.service_id,
        customer.id, customer.name, customer.phone, customer.email,
        vehicle.id, vehicle.registration, vehicle.make, vehicle.model
      from taken
      join public.campaigns campaign on campaign.garage_id = taken.garage_id and campaign.id = taken.campaign_id
      join public.customers customer on customer.garage_id = taken.garage_id and customer.id = taken.customer_id
      join public.vehicles vehicle on vehicle.garage_id = taken.garage_id and vehicle.id = taken.vehicle_id
      order by taken.send_at, taken.id;

      get diagnostics batch_claimed = row_count;
      claimed := claimed + batch_claimed;
    end loop;

    update public.campaigns campaign
    set status = 'sending'
    where campaign.garage_id = p_garage_id
      and campaign.status = 'scheduled'
      and exists (
        select 1 from public.campaign_sends send
        where send.garage_id = campaign.garage_id and send.campaign_id = campaign.id and send.status <> 'scheduled'
      );
  end if;

  update public.campaigns campaign
  set status = 'sent', finished_at = p_now
  where campaign.garage_id = p_garage_id
    and campaign.status in ('scheduled', 'sending')
    and campaign.send_at <= p_now
    and not exists (
      select 1 from public.campaign_sends send
      where send.garage_id = campaign.garage_id and send.campaign_id = campaign.id and send.status = 'scheduled'
    );
end
$$;

comment on function public.claim_campaign_sends(uuid, timestamptz, integer) is
  'P5.5 service role: claim due campaign sends of one garage (consent re-checked; Essentials garages skip with plan_required).';

-- ---------------------------------------------------------------------------
-- 6. STOP and delivery receipts
-- ---------------------------------------------------------------------------

-- A customer who opts out (STOP, the unsubscribe page, staff), withdraws
-- consent or is anonymised gets no further campaign message: their scheduled
-- campaign sends are cancelled in the same transaction. Rows already claimed
-- were checked a moment before the send.
create function public.campaign_sends_follow_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reason text;
begin
  if new.anonymised_at is not null and old.anonymised_at is null then
    reason := 'anonymised';
  elsif new.opted_out_at is not null and old.opted_out_at is null then
    reason := 'opted_out';
  elsif not new.reminder_consent and old.reminder_consent then
    reason := 'no_consent';
  else
    return null;
  end if;
  update public.campaign_sends send
  set status = 'cancelled', skip_reason = reason
  where send.garage_id = new.garage_id and send.customer_id = new.id and send.status = 'scheduled';
  return null;
end
$$;

create trigger customers_cancel_campaign_sends
  after update of opted_out_at, anonymised_at, reminder_consent on public.customers
  for each row execute function public.campaign_sends_follow_customer();

-- Delivery receipts update the messages row (Twilio status webhook); a
-- campaign send that went out follows it to delivered or failed.
create function public.campaign_sends_follow_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.campaign_sends send
  set status = new.status,
      delivered_at = case when new.status = 'delivered' then coalesce(send.delivered_at, now()) else send.delivered_at end,
      error_code = case when new.status = 'failed' then coalesce(new.error_code, 'failed') else send.error_code end
  where send.garage_id = new.garage_id
    and send.message_id = new.id
    and send.status in ('sent', 'delivered')
    and send.status <> new.status;
  return null;
end
$$;

create trigger messages_campaign_send_status
  after update of status on public.messages
  for each row
  when (new.status in ('delivered', 'failed') and old.status is distinct from new.status)
  execute function public.campaign_sends_follow_message();

-- ---------------------------------------------------------------------------
-- 7. Results
-- ---------------------------------------------------------------------------

-- Service role, right after create_booking() succeeded for a draft that came
-- from a campaign link: credit the booking to the send when the send belongs
-- to this garage, went out (sending, sent, delivered or failed: it carried a
-- link) and the booking is for the send's own customer and car (create_booking
-- matched them by phone and registration), and is not cancelled. The send's
-- booking_id becomes the booking (a later booking through the same link
-- replaces a cancelled one); a booking is credited to one send at most.
-- Returns whether the booking is now credited to the send.
create function public.attribute_campaign_booking(p_garage_id uuid, p_campaign_send_id uuid, p_booking_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  send public.campaign_sends;
  booking_customer uuid;
  booking_vehicle uuid;
  booking_status text;
begin
  if p_garage_id is null or p_campaign_send_id is null or p_booking_id is null then
    return false;
  end if;
  select * into send from public.campaign_sends
  where garage_id = p_garage_id and id = p_campaign_send_id
  for update;
  if not found or send.status not in ('sending', 'sent', 'delivered', 'failed') then
    return false;
  end if;
  select booking.customer_id, booking.vehicle_id, booking.status
  into booking_customer, booking_vehicle, booking_status
  from public.bookings booking
  where booking.garage_id = p_garage_id and booking.id = p_booking_id and booking.deleted_at is null;
  if not found or booking_status in ('cancelled', 'no_show')
     or booking_customer is distinct from send.customer_id
     or booking_vehicle is distinct from send.vehicle_id then
    return false;
  end if;
  if send.booking_id = p_booking_id then
    return true;
  end if;
  if exists (select 1 from public.campaign_sends other where other.garage_id = p_garage_id and other.booking_id = p_booking_id) then
    return false;
  end if;
  if send.booking_id is not null and exists (
    select 1 from public.bookings previous
    where previous.garage_id = p_garage_id and previous.id = send.booking_id
      and previous.status not in ('cancelled', 'no_show') and previous.deleted_at is null
  ) then
    return false;
  end if;
  update public.campaign_sends set booking_id = p_booking_id where garage_id = p_garage_id and id = send.id;
  return true;
end
$$;

comment on function public.attribute_campaign_booking(uuid, uuid, uuid) is
  'P5.5 service role: credit a booking made through a campaign link to the send (same customer and car). create_booking() is unchanged.';

-- Members of the selected garage: per campaign, recipients, still scheduled,
-- sent (went to the provider), delivered (receipt), opened (link opened),
-- failed, skipped (incl. cancelled), bookings credited (not cancelled,
-- no-show or trashed) and the pence they bring: the total of the booking's
-- issued or paid invoices when it has any, else bookings.price_pence (as
-- reminder_won_back()). p_campaign_id null = every campaign. Not plan gated
-- (results stay readable after a downgrade).
create function public.campaign_results(p_campaign_id uuid default null)
returns table (
  campaign_id uuid,
  recipients integer,
  scheduled integer,
  sent integer,
  delivered integer,
  opened integer,
  failed integer,
  skipped integer,
  bookings integer,
  pence bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  target_garage uuid := public.current_garage_id();
begin
  if target_garage is null or public.current_garage_role() is null then
    raise exception 'CAMPAIGN_FORBIDDEN: members only' using errcode = '42501';
  end if;

  return query
  select
    campaign.id,
    count(send.id)::integer,
    count(send.id) filter (where send.status = 'scheduled')::integer,
    count(send.id) filter (where send.sent_at is not null)::integer,
    count(send.id) filter (where send.status = 'delivered')::integer,
    count(send.id) filter (where send.opened_at is not null)::integer,
    count(send.id) filter (where send.status = 'failed')::integer,
    count(send.id) filter (where send.status in ('skipped', 'cancelled'))::integer,
    count(won.booking_id)::integer,
    coalesce(sum(won.pence), 0)::bigint
  from public.campaigns campaign
  left join public.campaign_sends send on send.garage_id = campaign.garage_id and send.campaign_id = campaign.id
  left join lateral (
    select booking.id as booking_id, coalesce(invoiced.total, booking.price_pence, 0) as pence
    from public.bookings booking
    left join lateral (
      select sum(invoice.total_pence) as total
      from public.invoices invoice
      where invoice.garage_id = booking.garage_id
        and invoice.booking_id = booking.id
        and invoice.status in ('issued', 'paid')
        and invoice.deleted_at is null
    ) invoiced on true
    where booking.garage_id = send.garage_id
      and booking.id = send.booking_id
      and booking.status not in ('cancelled', 'no_show')
      and booking.deleted_at is null
  ) won on true
  where campaign.garage_id = target_garage
    and (p_campaign_id is null or campaign.id = p_campaign_id)
  group by campaign.id;
end
$$;

comment on function public.campaign_results(uuid) is
  'P5.5: members of the selected garage: per-campaign sent, delivered, opened, bookings and pence won (invoice totals, else booking price).';

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.campaign_segment_problem(jsonb) from public, anon;
revoke all on function public.campaign_audience(uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.preview_campaign_audience(jsonb, integer) from public, anon;
revoke all on function public.schedule_campaign(uuid, timestamptz) from public, anon;
revoke all on function public.cancel_campaign(uuid) from public, anon;
revoke all on function public.claim_campaign_sends(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.campaign_sends_follow_customer() from public, anon, authenticated;
revoke all on function public.campaign_sends_follow_message() from public, anon, authenticated;
revoke all on function public.attribute_campaign_booking(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.campaign_results(uuid) from public, anon;

grant execute on function public.campaign_segment_problem(jsonb) to authenticated, service_role;
grant execute on function public.preview_campaign_audience(jsonb, integer) to authenticated;
grant execute on function public.schedule_campaign(uuid, timestamptz) to authenticated;
grant execute on function public.cancel_campaign(uuid) to authenticated;
grant execute on function public.claim_campaign_sends(uuid, timestamptz, integer) to service_role;
grant execute on function public.attribute_campaign_booking(uuid, uuid, uuid) to service_role;
grant execute on function public.campaign_results(uuid) to authenticated;

revoke all on public.campaigns from anon, authenticated;
grant select on public.campaigns to authenticated;
grant insert (id, garage_id, name, starter, segment, template, email_subject, email_template, service_id) on public.campaigns to authenticated;
grant update (name, starter, segment, template, email_subject, email_template, service_id) on public.campaigns to authenticated;
grant delete on public.campaigns to authenticated;
grant select, insert, update, delete on public.campaigns to service_role;

revoke all on public.campaign_sends from anon, authenticated;
grant select on public.campaign_sends to authenticated;
grant select, insert, update, delete on public.campaign_sends to service_role;

-- ---------------------------------------------------------------------------
-- 9. Row-level security
-- ---------------------------------------------------------------------------

alter table public.campaigns enable row level security;
alter table public.campaign_sends enable row level security;

-- campaigns
--   "garage members read campaigns"              select  members of the selected garage (any plan: results stay readable)
--   "owners and managers add campaigns"          insert  owners/managers of the selected garage on a plan with campaigns, as a draft
--   "owners and managers change draft campaigns" update  owners/managers, Pro, drafts only (column grants: name, starter, segment, template, email_subject, email_template, service_id)
--   "owners and managers remove draft campaigns" delete  owners/managers, Pro, drafts only
--   scheduling and cancelling go through schedule_campaign() / cancel_campaign(); the sender (service role) moves the status on
create policy "garage members read campaigns" on public.campaigns
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add campaigns" on public.campaigns
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'campaigns')
    and status = 'draft'
  );
create policy "owners and managers change draft campaigns" on public.campaigns
  for update to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and status = 'draft'
  )
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'campaigns')
    and status = 'draft'
  );
create policy "owners and managers remove draft campaigns" on public.campaigns
  for delete to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'campaigns')
    and status = 'draft'
  );

-- campaign_sends
--   "garage members read campaign sends"  select  members of the selected garage (any plan)
--   no insert/update/delete for staff: schedule_campaign(), cancel_campaign(), claim_campaign_sends(),
--   the sender, the link route and attribute_campaign_booking() (service role) write them
create policy "garage members read campaign sends" on public.campaign_sends
  for select to authenticated using (garage_id = (select public.current_garage_id()));
