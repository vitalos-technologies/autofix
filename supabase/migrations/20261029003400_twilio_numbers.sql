-- Twilio numbers that set themselves up once the account is upgraded (D22,
-- DECISIONS A431–A438): one UK mobile for texts in the "Autofix reminders"
-- Messaging Service, and one UK local number per Pro garage with the AI front
-- desk switched on, under a cap on the numbers the account holds.
--
--   1. garage_phone_numbers.ring_garage_first
--                           false on a number the platform bought for a
--                           garage's AI front desk: the garage's own phone
--                           forwards missed calls to it, so the voice webhook
--                           never rings that phone back (no call loop, A432).
--                           Default true keeps every existing number as it was.
--                           Service role only: staff column grants unchanged.
--   2. ai_front_desk_numbers (tenant, one row per garage)
--                           where the garage's AI desk number stands: pending,
--                           waiting_upgrade, waiting_bundle, cap_reached,
--                           not_configured, ready or failed (+ a safe reason
--                           code), the number and its Twilio SID once bought.
--                           Members of the garage read it; only the service
--                           role writes it. The SID stays for good, so a
--                           garage is never bought a second number (A434).
--   3. twilio_number_provisioning (platform, A10, one row)
--                           the texting number's state, the account type and
--                           count last seen, and the lease that lets one
--                           numbers.provision run buy at a time (so the cap
--                           holds). Service role only.
--   4. Functions (service role only, security definer, empty search_path):
--        claim_number_provisioning(holder, seconds) / release_number_provisioning(holder)
--        ai_front_desk_numbers_due(garage, limit)
--        attach_ai_front_desk_number(garage, number, sid, ring_garage_first)
--        set_ai_front_desk_number_status(garages[], status, reason)
--
-- Nothing here releases or deletes a Twilio number: switching the desk off,
-- a downgrade or a cancellation keeps the row and the number (A436).
--
-- Rollback (manual): drop function public.set_ai_front_desk_number_status(uuid[], text, text),
-- public.attach_ai_front_desk_number(uuid, text, text, boolean), public.ai_front_desk_numbers_due(uuid, integer),
-- public.release_number_provisioning(uuid), public.claim_number_provisioning(uuid, integer);
-- drop table public.twilio_number_provisioning, public.ai_front_desk_numbers;
-- alter table public.garage_phone_numbers drop column ring_garage_first.

-- ---------------------------------------------------------------------------
-- 1. garage_phone_numbers.ring_garage_first
-- ---------------------------------------------------------------------------

alter table public.garage_phone_numbers add column ring_garage_first boolean not null default true;

comment on column public.garage_phone_numbers.ring_garage_first is
  'true: a call to this provisioned number rings the garage''s own phone first (P4.1). false: the garage''s phone forwards missed calls here, so the call goes straight to the AI front desk or the voicemail (A432). Service role only.';

-- ---------------------------------------------------------------------------
-- 2. ai_front_desk_numbers
-- ---------------------------------------------------------------------------

create table public.ai_front_desk_numbers (
  garage_id uuid primary key default public.current_garage_id() references public.garages(id) on delete cascade,
  status text not null default 'pending',
  reason text,
  number text,
  provider_sid text,
  checked_at timestamptz,
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_front_desk_numbers_status_check check (status in (
    'pending', 'waiting_upgrade', 'waiting_bundle', 'cap_reached', 'not_configured', 'ready', 'failed'
  )),
  constraint ai_front_desk_numbers_reason_check check (reason is null or reason ~ '^[a-z0-9_.:-]{1,80}$'),
  constraint ai_front_desk_numbers_number_check check (number is null or number ~ '^\+[1-9][0-9]{6,14}$'),
  constraint ai_front_desk_numbers_provider_sid_check check (provider_sid is null or provider_sid ~ '^PN[0-9a-fA-F]{32}$'),
  constraint ai_front_desk_numbers_provider_sid_key unique (provider_sid),
  constraint ai_front_desk_numbers_ready_check check (status <> 'ready' or (number is not null and provider_sid is not null and ready_at is not null))
);

comment on table public.ai_front_desk_numbers is
  'D22: the AI front desk number of a Pro garage, bought by the numbers.provision job once the Twilio account is upgraded. One row per garage; the provider_sid is kept for good (never a second number). Service role writes; members read.';
comment on column public.ai_front_desk_numbers.reason is
  'Safe code for the state (twilio:<code>, no_numbers_available, account_suspended, ...). Never a number or provider text.';

create trigger ai_front_desk_numbers_set_updated_at
  before update on public.ai_front_desk_numbers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. twilio_number_provisioning (platform)
-- ---------------------------------------------------------------------------

create table public.twilio_number_provisioning (
  singleton boolean primary key default true,
  account_type text,
  numbers_held integer,
  number_cap integer,
  texting_status text not null default 'pending',
  texting_reason text,
  texting_number text,
  texting_sid text,
  checked_at timestamptz,
  lease_holder uuid,
  lease_until timestamptz,
  updated_at timestamptz not null default now(),
  constraint twilio_number_provisioning_singleton_check check (singleton),
  constraint twilio_number_provisioning_account_type_check check (account_type is null or account_type ~ '^[A-Za-z]{1,20}$'),
  constraint twilio_number_provisioning_numbers_held_check check (numbers_held is null or numbers_held >= 0),
  constraint twilio_number_provisioning_number_cap_check check (number_cap is null or number_cap >= 0),
  constraint twilio_number_provisioning_texting_status_check check (texting_status in (
    'pending', 'waiting_upgrade', 'waiting_bundle', 'cap_reached', 'not_configured', 'ready', 'failed'
  )),
  constraint twilio_number_provisioning_texting_reason_check check (texting_reason is null or texting_reason ~ '^[a-z0-9_.:-]{1,80}$'),
  constraint twilio_number_provisioning_texting_number_check check (texting_number is null or texting_number ~ '^\+[1-9][0-9]{6,14}$'),
  constraint twilio_number_provisioning_texting_sid_check check (texting_sid is null or texting_sid ~ '^PN[0-9a-fA-F]{32}$'),
  constraint twilio_number_provisioning_lease_check check ((lease_holder is null) = (lease_until is null))
);

comment on table public.twilio_number_provisioning is
  'D22: one row. The texting number''s state (UK mobile in the Messaging Service), the Twilio account type and number count last seen, the cap in force, and the lease of the numbers.provision run that may buy. Service role only (A10).';

insert into public.twilio_number_provisioning (singleton) values (true);

create trigger twilio_number_provisioning_set_updated_at
  before update on public.twilio_number_provisioning
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------------

-- One numbers.provision run at a time may count and buy (the cap holds even
-- when the daily run and a garage's own run overlap). The lease runs out by
-- itself, so a run that dies never blocks the next one for long.
create function public.claim_number_provisioning(p_holder uuid, p_seconds integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_holder is null or p_seconds is null or p_seconds < 1 or p_seconds > 600 then
    raise exception 'INVALID_LEASE' using errcode = '22023';
  end if;
  insert into public.twilio_number_provisioning (singleton) values (true) on conflict (singleton) do nothing;
  update public.twilio_number_provisioning provisioning
     set lease_holder = p_holder,
         lease_until = now() + make_interval(secs => p_seconds)
   where provisioning.singleton
     and (provisioning.lease_until is null or provisioning.lease_until <= now() or provisioning.lease_holder = p_holder);
  return found;
end
$$;

comment on function public.claim_number_provisioning(uuid, integer) is
  'D22, service role: takes (or renews) the numbers.provision lease for p_seconds (1-600). False while another holder''s lease runs.';

create function public.release_number_provisioning(p_holder uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.twilio_number_provisioning provisioning
     set lease_holder = null, lease_until = null
   where provisioning.singleton and provisioning.lease_holder = p_holder;
  return found;
end
$$;

comment on function public.release_number_provisioning(uuid) is
  'D22, service role: gives the numbers.provision lease back (only its holder can).';

-- Garages whose AI front desk needs a number, or whose recorded state no
-- longer matches the routing: the garage takes bookings, is on Pro, the owner
-- switched the desk on, and it is not already `ready` with a routed number
-- (garage_phone_numbers with provider_sid). Least recently checked first.
create function public.ai_front_desk_numbers_due(p_garage_id uuid default null, p_limit integer default 50)
returns table (
  garage_id uuid,
  garage_phone text,
  status text,
  provider_sid text,
  number text,
  routed_number text,
  routed_sid text
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.phone, n.status, n.provider_sid, n.number, routed.number, routed.provider_sid
  from public.garages g
  join public.ai_front_desk_settings s on s.garage_id = g.id and s.enabled
  left join public.ai_front_desk_numbers n on n.garage_id = g.id
  left join lateral (
    select p.number, p.provider_sid
    from public.garage_phone_numbers p
    where p.garage_id = g.id and p.provider_sid is not null
    order by (p.provider_sid = n.provider_sid) desc nulls last, p.created_at, p.id
    limit 1
  ) routed on true
  where g.status in ('active', 'onboarding')
    and public.garage_has_feature(g.id, 'ai_front_desk')
    and (p_garage_id is null or g.id = p_garage_id)
    and not (coalesce(n.status, '') = 'ready' and routed.provider_sid is not null)
  order by n.checked_at nulls first, g.created_at, g.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function public.ai_front_desk_numbers_due(uuid, integer) is
  'D22, service role: garages (one, or all) that are Pro, taking bookings, with the AI front desk on and not yet ready with a routed number, with what is known of their number.';

-- A number the platform bought (or found already routed) becomes the garage's
-- AI desk number, in one transaction: the routing row (purpose forwarding,
-- provider_sid) and the state `ready`. p_ring_garage_first: false for a number
-- bought for the desk (A432); null keeps an existing row's setting (true for
-- a new one). A number another garage holds is refused (NUMBER_TAKEN), and so
-- is a second number for a garage that already has one (ALREADY_PROVISIONED).
create function public.attach_ai_front_desk_number(p_garage_id uuid, p_number text, p_provider_sid text, p_ring_garage_first boolean default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing_state public.ai_front_desk_numbers;
  routing public.garage_phone_numbers;
  newly_ready boolean;
begin
  if p_garage_id is null
     or p_number is null or p_number !~ '^\+[1-9][0-9]{6,14}$'
     or p_provider_sid is null or p_provider_sid !~ '^PN[0-9a-fA-F]{32}$' then
    raise exception 'INVALID_NUMBER' using errcode = '22023';
  end if;
  if not exists (select 1 from public.garages g where g.id = p_garage_id) then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  select * into existing_state from public.ai_front_desk_numbers n where n.garage_id = p_garage_id for update;
  if existing_state.provider_sid is not null and existing_state.provider_sid <> p_provider_sid then
    raise exception 'ALREADY_PROVISIONED' using errcode = 'P0001';
  end if;

  select * into routing from public.garage_phone_numbers p where p.number = p_number for update;
  if found and routing.garage_id <> p_garage_id then
    raise exception 'NUMBER_TAKEN' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.garage_phone_numbers p where p.provider_sid = p_provider_sid and p.number <> p_number) then
    raise exception 'NUMBER_TAKEN' using errcode = 'P0001';
  end if;

  if routing.id is null then
    insert into public.garage_phone_numbers (garage_id, number, purpose, provider_sid, ring_garage_first)
    values (p_garage_id, p_number, 'forwarding', p_provider_sid, coalesce(p_ring_garage_first, true));
  else
    update public.garage_phone_numbers p
       set provider_sid = p_provider_sid,
           ring_garage_first = coalesce(p_ring_garage_first, p.ring_garage_first)
     where p.id = routing.id and p.garage_id = p_garage_id;
  end if;

  newly_ready := existing_state.garage_id is null or existing_state.status <> 'ready';

  insert into public.ai_front_desk_numbers as n (garage_id, status, reason, number, provider_sid, checked_at, ready_at)
  values (p_garage_id, 'ready', null, p_number, p_provider_sid, now(), now())
  on conflict (garage_id) do update
    set status = 'ready',
        reason = null,
        number = excluded.number,
        provider_sid = excluded.provider_sid,
        checked_at = now(),
        ready_at = coalesce(case when n.status = 'ready' then n.ready_at end, now());

  if newly_ready then
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (p_garage_id, null, 'ai_front_desk.number_ready', 'garage_phone_number', p_provider_sid,
            jsonb_build_object('rings_garage_first', coalesce(p_ring_garage_first, routing.ring_garage_first, true)));
  end if;

  return jsonb_build_object('status', 'ready', 'number', p_number, 'provider_sid', p_provider_sid, 'newly_ready', newly_ready);
end
$$;

comment on function public.attach_ai_front_desk_number(uuid, text, text, boolean) is
  'D22, service role: routes the number to the garage (garage_phone_numbers, purpose forwarding, provider_sid) and marks its AI desk number ready, in one transaction. NUMBER_TAKEN / ALREADY_PROVISIONED refuse anything else. Audited ai_front_desk.number_ready.';

-- Records why garages are still waiting (or what failed). Never `ready`
-- (that is attach_ai_front_desk_number()), and never clears a number or SID
-- already recorded, so a garage is never bought a second number.
create function public.set_ai_front_desk_number_status(p_garage_ids uuid[], p_status text, p_reason text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if p_status is null or p_status not in ('pending', 'waiting_upgrade', 'waiting_bundle', 'cap_reached', 'not_configured', 'failed') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;
  if p_reason is not null and p_reason !~ '^[a-z0-9_.:-]{1,80}$' then
    raise exception 'INVALID_REASON' using errcode = '22023';
  end if;
  if p_garage_ids is null or cardinality(p_garage_ids) = 0 then
    return 0;
  end if;

  insert into public.ai_front_desk_numbers as n (garage_id, status, reason, checked_at)
  select g.id, p_status, p_reason, now()
  from public.garages g
  where g.id = any (p_garage_ids)
  on conflict (garage_id) do update
    set status = excluded.status,
        reason = excluded.reason,
        checked_at = now();
  get diagnostics changed = row_count;
  return changed;
end
$$;

comment on function public.set_ai_front_desk_number_status(uuid[], text, text) is
  'D22, service role: records a waiting or failed state (with a safe reason code) for garages; keeps any number and SID already recorded.';

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on public.ai_front_desk_numbers from public, anon, authenticated;
grant select on public.ai_front_desk_numbers to authenticated;
grant select, insert, update on public.ai_front_desk_numbers to service_role;

revoke all on public.twilio_number_provisioning from public, anon, authenticated;
grant select, insert, update on public.twilio_number_provisioning to service_role;

revoke all on function public.claim_number_provisioning(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_number_provisioning(uuid, integer) to service_role;
revoke all on function public.release_number_provisioning(uuid) from public, anon, authenticated;
grant execute on function public.release_number_provisioning(uuid) to service_role;
revoke all on function public.ai_front_desk_numbers_due(uuid, integer) from public, anon, authenticated;
grant execute on function public.ai_front_desk_numbers_due(uuid, integer) to service_role;
revoke all on function public.attach_ai_front_desk_number(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.attach_ai_front_desk_number(uuid, text, text, boolean) to service_role;
revoke all on function public.set_ai_front_desk_number_status(uuid[], text, text) from public, anon, authenticated;
grant execute on function public.set_ai_front_desk_number_status(uuid[], text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Row-level security
-- ---------------------------------------------------------------------------

alter table public.ai_front_desk_numbers enable row level security;
alter table public.twilio_number_provisioning enable row level security;

-- ai_front_desk_numbers
--   "garage members read their AI desk number"  select  members of the selected garage (stays readable after a
--                                                         downgrade or with the desk off: the number is kept)
--   writes: no table grant to staff; the service role (numbers.provision) writes through
--   attach_ai_front_desk_number() and set_ai_front_desk_number_status().
create policy "garage members read their AI desk number" on public.ai_front_desk_numbers
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- twilio_number_provisioning
--   no policies and no grants to anon or authenticated: service role only (A10).
