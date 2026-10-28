-- AI front desk on Pro (P5.12; D17, D19; DECISIONS A382–A389 in
-- docs/autofix/phase-5/P5.12-ai-front-desk.md).
--
-- D17 moves the AI front desk (the Workforce agent on calls and WhatsApp,
-- with a monthly minutes allowance) to Pro. Essentials keeps missed-call
-- text-back, voicemail and the Askbridge website chat. This migration:
--
--   agent_tokens.audience   'workforce' (the AI front desk: needs Pro, feature
--                           ai_front_desk) or 'askbridge' (website chat:
--                           Essentials). An askbridge token may only hold
--                           read-only tools (list_services, garage_profile,
--                           available_slots). Existing tokens: askbridge when
--                           their scopes are already a subset of those three,
--                           else workforce (A382).
--   report_usage tool       Workforce reports AI minutes per conversation
--                           (/api/agent/v1/report_usage); added to the scope
--                           and call-log tool lists. Existing workforce tokens
--                           that held every tool gain it (A383).
--   issue_agent_token(…, p_audience)
--                           service role; a workforce token needs Pro. The
--                           four-argument form now issues workforce tokens
--                           through it.
--   list_agent_tokens()     gains `audience`.
--   ai_front_desk_settings  (tenant, one row per garage) the owner's on/off
--                           switch for the hand-off to Workforce.
--   set_ai_front_desk(p_enabled)
--                           owner of the selected garage (AAL2 when enrolled);
--                           switching on needs Pro; audited.
--   ai_front_desk_hand_off(p_garage_id)
--                           service role: true when the Twilio voice webhook
--                           should hand a missed call to Workforce (garage
--                           taking bookings, Pro, switched on).
--
-- Nothing here touches create_booking(), available_slots() or their
-- variants.
--
-- Rollback (manual): drop function public.ai_front_desk_hand_off(uuid),
-- public.set_ai_front_desk(boolean), public.issue_agent_token(uuid, text,
-- text[], text, text); drop table public.ai_front_desk_settings; recreate
-- list_agent_tokens() and issue_agent_token(uuid, text, text[], text) from
-- 20261028000100_agent_tokens.sql; delete agent_tokens/agent_call_log rows
-- naming report_usage, restore the two six-tool check constraints; drop
-- column agent_tokens.audience.

-- ---------------------------------------------------------------------------
-- 1. agent_tokens: audience and the report_usage tool
-- ---------------------------------------------------------------------------

alter table public.agent_tokens add column audience text not null default 'workforce';

-- A382: a token that can only read services, the garage profile and free
-- times is what the Askbridge chat needs; anything that can look up a vehicle,
-- book or read a booking is the AI front desk.
update public.agent_tokens
   set audience = 'askbridge'
 where scopes <@ array['list_services', 'garage_profile', 'available_slots']::text[];

alter table public.agent_tokens drop constraint agent_tokens_scopes_check;
alter table public.agent_tokens add constraint agent_tokens_scopes_check check (
  cardinality(scopes) > 0
  and scopes <@ array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile', 'report_usage']::text[]
);
alter table public.agent_tokens add constraint agent_tokens_audience_check check (
  audience in ('workforce', 'askbridge')
  and (audience = 'workforce' or scopes <@ array['list_services', 'garage_profile', 'available_slots']::text[])
);

-- A383: workforce tokens that held every tool can report minutes too.
update public.agent_tokens
   set scopes = scopes || array['report_usage']::text[]
 where audience = 'workforce'
   and scopes @> array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile']::text[]
   and not scopes @> array['report_usage']::text[];

comment on column public.agent_tokens.audience is
  'P5.12: workforce (AI front desk on calls and WhatsApp; needs Pro, feature ai_front_desk) or askbridge (website chat, Essentials; read-only tools only).';
comment on column public.agent_tokens.scopes is
  'Agent tools this token may call (tool names). Askbridge tokens: list_services, garage_profile, available_slots only.';

alter table public.agent_call_log drop constraint agent_call_log_tool_check;
alter table public.agent_call_log add constraint agent_call_log_tool_check
  check (tool in ('lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile', 'report_usage'));

-- ---------------------------------------------------------------------------
-- 2. Issuing and listing tokens
-- ---------------------------------------------------------------------------

-- Service role: stores a token the app generated and hashed, for one audience.
-- A workforce token needs the AI front desk (Pro). Null scopes: every tool for
-- workforce except report_usage (unchanged default, A383), the three read-only
-- tools for askbridge.
create function public.issue_agent_token(p_garage_id uuid, p_name text, p_scopes text[], p_token_hash text, p_audience text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  issued public.agent_tokens;
  audience_value text := coalesce(p_audience, 'workforce');
begin
  if p_garage_id is null or not exists (select 1 from public.garages g where g.id = p_garage_id) then
    raise exception 'INVALID_TOKEN: unknown garage' using errcode = 'P0001';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TOKEN: token_hash must be 64 hex characters' using errcode = 'P0001';
  end if;
  if audience_value not in ('workforce', 'askbridge') then
    raise exception 'INVALID_TOKEN: audience must be workforce or askbridge' using errcode = '22023';
  end if;
  if audience_value = 'workforce' then
    perform public.require_garage_feature(p_garage_id, 'ai_front_desk');
  end if;

  insert into public.agent_tokens (garage_id, name, token_hash, scopes, audience)
  values (
    p_garage_id,
    trim(coalesce(p_name, '')),
    p_token_hash,
    coalesce(
      p_scopes,
      case when audience_value = 'askbridge'
        then array['list_services', 'available_slots', 'garage_profile']::text[]
        else array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile']::text[]
      end
    ),
    audience_value
  )
  returning * into issued;

  return jsonb_build_object(
    'id', issued.id,
    'garage_id', issued.garage_id,
    'name', issued.name,
    'scopes', to_jsonb(issued.scopes),
    'audience', issued.audience,
    'created_at', issued.created_at
  );
end
$$;

comment on function public.issue_agent_token(uuid, text, text[], text, text) is
  'P5.12: service role. Issues a workforce (needs Pro: PLAN_REQUIRED) or askbridge (read-only tools) token; never returns the hash.';

-- The P4.2 four-argument form issues workforce tokens.
create or replace function public.issue_agent_token(p_garage_id uuid, p_name text, p_scopes text[], p_token_hash text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.issue_agent_token(p_garage_id, p_name, p_scopes, p_token_hash, 'workforce');
$$;

-- list_agent_tokens() gains the audience (its result type changes, so it is recreated).
drop function public.list_agent_tokens();
create function public.list_agent_tokens()
returns table (id uuid, name text, scopes text[], last_used_at timestamptz, revoked_at timestamptz, created_at timestamptz, audience text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, t.scopes, t.last_used_at, t.revoked_at, t.created_at, t.audience
  from public.agent_tokens t
  where t.garage_id = public.current_garage_id()
    and public.current_garage_role() in ('owner', 'manager')
  order by t.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 3. The owner's switch
-- ---------------------------------------------------------------------------

create table public.ai_front_desk_settings (
  garage_id uuid primary key default public.current_garage_id() references public.garages(id) on delete cascade,
  enabled boolean not null default false,
  enabled_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_front_desk_settings is
  'P5.12: per-garage AI front desk switch. enabled = hand missed calls (and, once Workforce confirms, WhatsApp) to the Workforce agent. Only takes effect on Pro.';

create trigger ai_front_desk_settings_set_updated_at
  before update on public.ai_front_desk_settings
  for each row execute function public.set_updated_at();

-- Owner of the selected garage: switch the front desk on or off. Switching on
-- needs Pro; switching off is always allowed (also after a downgrade).
create function public.set_ai_front_desk(p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  saved public.ai_front_desk_settings;
begin
  if not public.garage_actor_allowed() or public.current_garage_role() is distinct from 'owner' then
    raise exception 'Only the garage owner can switch the AI front desk' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'INVALID_SETTING' using errcode = '22023';
  end if;
  if p_enabled then
    perform public.require_garage_feature(target_garage, 'ai_front_desk');
  end if;

  insert into public.ai_front_desk_settings as s (garage_id, enabled, enabled_at, updated_by)
  values (target_garage, p_enabled, case when p_enabled then now() end, auth.uid())
  on conflict (garage_id) do update
    set enabled = excluded.enabled,
        enabled_at = case when excluded.enabled and not s.enabled then now() when excluded.enabled then s.enabled_at end,
        updated_by = excluded.updated_by
  returning * into saved;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), case when p_enabled then 'ai_front_desk.enabled' else 'ai_front_desk.disabled' end,
          'garage', target_garage::text, '{}'::jsonb);

  return jsonb_build_object('enabled', saved.enabled, 'enabled_at', saved.enabled_at);
end
$$;

comment on function public.set_ai_front_desk(boolean) is
  'P5.12: the owner of the selected garage switches the AI front desk on (needs Pro: PLAN_REQUIRED) or off. Audited ai_front_desk.enabled / ai_front_desk.disabled.';

-- Service role (Twilio voice webhook): hand this garage's missed calls to Workforce?
create function public.ai_front_desk_hand_off(p_garage_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.enabled
       and g.status in ('active', 'onboarding')
       and public.garage_has_feature(g.id, 'ai_front_desk')
    from public.garages g
    join public.ai_front_desk_settings s on s.garage_id = g.id
    where g.id = p_garage_id
  ), false);
$$;

comment on function public.ai_front_desk_hand_off(uuid) is
  'P5.12: service role. True when the garage takes bookings, has the AI front desk (Pro) and the owner switched it on.';

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

revoke all on public.ai_front_desk_settings from public, anon, authenticated;
grant select on public.ai_front_desk_settings to authenticated;
grant select, insert, update, delete on public.ai_front_desk_settings to service_role;

revoke all on function public.issue_agent_token(uuid, text, text[], text, text) from public, anon, authenticated;
grant execute on function public.issue_agent_token(uuid, text, text[], text, text) to service_role;
revoke all on function public.issue_agent_token(uuid, text, text[], text) from public, anon, authenticated;
grant execute on function public.issue_agent_token(uuid, text, text[], text) to service_role;
revoke all on function public.list_agent_tokens() from public, anon;
grant execute on function public.list_agent_tokens() to authenticated, service_role;
revoke all on function public.set_ai_front_desk(boolean) from public, anon;
grant execute on function public.set_ai_front_desk(boolean) to authenticated;
revoke all on function public.ai_front_desk_hand_off(uuid) from public, anon, authenticated;
grant execute on function public.ai_front_desk_hand_off(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------

alter table public.ai_front_desk_settings enable row level security;

-- ai_front_desk_settings
--   "garage members read the AI front desk switch"  select  members of the selected garage (no plan check:
--                                                            the switch stays readable after a downgrade)
--   writes: no table grant to staff; the owner writes through set_ai_front_desk() (Pro to switch on),
--   the service role reads it through ai_front_desk_hand_off().
create policy "garage members read the AI front desk switch" on public.ai_front_desk_settings
  for select to authenticated using (garage_id = (select public.current_garage_id()));
