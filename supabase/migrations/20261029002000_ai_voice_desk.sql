-- AI front desk on calls, run by Autofix's own voice service (P5.12 voice desk;
-- DECISIONS D20, AV1–AV10, docs/autofix/voice-desk.md).
--
-- P5.12 assumed a Workforce SIP agent; Workforce has none. Autofix now answers
-- a Pro garage's missed calls itself: the Twilio voice webhook speaks the AI
-- disclosure and connects the call to the autofix-voice service (Twilio
-- ConversationRelay). That service books through the existing agent tool API
-- with a short-lived token minted for that one call. This migration:
--
--   agent_tokens.call_sid, .expires_at
--                           a per-call token: bound to one CallSid, expires
--                           (both set or neither). One token per call.
--   log_call_summary tool   the voice service writes what happened on the call
--                           (call tokens only).
--   calls.ai_summary, .ai_outcome, .ai_handled_at
--                           the summary staff see on the missed call.
--   issue_voice_call_token(…)
--                           service role: mints the call's token when the call
--                           is this garage's, recent, and the front desk is on.
--   record_ai_call_summary(…)
--                           service role: stores the summary once per call.
--   ai_front_desk_voice_ready(p_garage_id, p_allowance)
--                           service role: hand-off on AND this month's AI
--                           minutes under the allowance (null = no cap set).
--   list_agent_tokens()     no longer lists per-call tokens.
--
-- Nothing here touches create_booking(), available_slots() or their variants.
--
-- Rollback (manual): drop functions ai_front_desk_voice_ready(uuid, numeric),
-- record_ai_call_summary(uuid, text, text, text), issue_voice_call_token(uuid,
-- text, text, timestamptz); recreate list_agent_tokens() from
-- 20261029001200_ai_front_desk.sql; delete agent_tokens where call_sid is not
-- null and agent_call_log rows naming log_call_summary; restore the seven-tool
-- check constraints; drop the new calls and agent_tokens columns.

-- ---------------------------------------------------------------------------
-- 1. Per-call tokens and the log_call_summary tool
-- ---------------------------------------------------------------------------

alter table public.agent_tokens
  add column call_sid text,
  add column expires_at timestamptz;

alter table public.agent_tokens add constraint agent_tokens_call_sid_check
  check (call_sid is null or (char_length(call_sid) between 1 and 64 and call_sid ~ '^[A-Za-z0-9_.:-]+$'));
alter table public.agent_tokens add constraint agent_tokens_call_token_check
  check ((call_sid is null) = (expires_at is null) and (call_sid is null or audience = 'workforce'));
create unique index agent_tokens_call_sid_key on public.agent_tokens (call_sid) where call_sid is not null;

alter table public.agent_tokens drop constraint agent_tokens_scopes_check;
alter table public.agent_tokens add constraint agent_tokens_scopes_check check (
  cardinality(scopes) > 0
  and scopes <@ array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile', 'report_usage', 'log_call_summary']::text[]
  and (call_sid is not null or not scopes @> array['log_call_summary']::text[])
);

comment on column public.agent_tokens.call_sid is
  'Voice desk: the Twilio CallSid this token was minted for (null for tokens staff issue). One token per call.';
comment on column public.agent_tokens.expires_at is
  'Voice desk: the per-call token stops working after this (set with call_sid).';

alter table public.agent_call_log drop constraint agent_call_log_tool_check;
alter table public.agent_call_log add constraint agent_call_log_tool_check
  check (tool in ('lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile', 'report_usage', 'log_call_summary'));

-- ---------------------------------------------------------------------------
-- 2. The call summary staff see
-- ---------------------------------------------------------------------------

alter table public.calls
  add column ai_summary text,
  add column ai_outcome text,
  add column ai_handled_at timestamptz;

alter table public.calls add constraint calls_ai_summary_check
  check (ai_summary is null or char_length(ai_summary) between 1 and 1000);
alter table public.calls add constraint calls_ai_outcome_check
  check (ai_outcome is null or ai_outcome in ('booked', 'message', 'callback', 'answered', 'spam', 'dropped'));

comment on column public.calls.ai_summary is
  'Voice desk: what the AI front desk wrote about the call (no registrations). Shown on the missed call.';
comment on column public.calls.ai_outcome is
  'Voice desk: booked (a booking request was made), message, callback, answered, spam or dropped.';

-- ---------------------------------------------------------------------------
-- 3. Functions (service role)
-- ---------------------------------------------------------------------------

-- Mints the token for one AI front desk call. The call must be this garage's,
-- logged in the last 30 minutes, and the front desk must still be on (Pro).
-- A second request for the same call fails (ALREADY_ISSUED): one token a call.
create function public.issue_voice_call_token(p_garage_id uuid, p_call_sid text, p_token_hash text, p_expires_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  issued public.agent_tokens;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TOKEN: token_hash must be 64 hex characters' using errcode = 'P0001';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '1 hour' then
    raise exception 'INVALID_TOKEN: expires_at must be within the next hour' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.calls c
    where c.garage_id = p_garage_id and c.provider_call_sid = p_call_sid and c.created_at > now() - interval '30 minutes'
  ) then
    raise exception 'CALL_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.ai_front_desk_hand_off(p_garage_id) then
    raise exception 'FRONT_DESK_OFF' using errcode = '42501';
  end if;
  if exists (select 1 from public.agent_tokens t where t.call_sid = p_call_sid) then
    raise exception 'ALREADY_ISSUED' using errcode = '23505';
  end if;

  insert into public.agent_tokens (garage_id, name, token_hash, scopes, audience, call_sid, expires_at)
  values (
    p_garage_id,
    'AI front desk call',
    p_token_hash,
    array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile', 'report_usage', 'log_call_summary']::text[],
    'workforce',
    p_call_sid,
    p_expires_at
  )
  returning * into issued;

  return jsonb_build_object('id', issued.id, 'garage_id', issued.garage_id, 'expires_at', issued.expires_at);
end
$$;

comment on function public.issue_voice_call_token(uuid, text, text, timestamptz) is
  'Voice desk: service role. Mints the per-call agent token (expires within the hour) for a recent call of a garage with the AI front desk on. CALL_NOT_FOUND, FRONT_DESK_OFF, ALREADY_ISSUED.';

-- Stores the AI front desk's summary on the call, once.
create function public.record_ai_call_summary(p_garage_id uuid, p_call_sid text, p_summary text, p_outcome text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  updated integer;
begin
  update public.calls c
     set ai_summary = left(trim(p_summary), 1000),
         ai_outcome = p_outcome,
         ai_handled_at = now()
   where c.garage_id = p_garage_id
     and c.provider_call_sid = p_call_sid
     and c.ai_handled_at is null;
  get diagnostics updated = row_count;
  return updated > 0;
end
$$;

comment on function public.record_ai_call_summary(uuid, text, text, text) is
  'Voice desk: service role. The AI front desk''s summary and outcome on the call; once per call (false when already stored or no such call).';

-- Should this missed call go to the AI front desk? The hand-off check plus this
-- garage-local month's AI minutes under the allowance (null: no cap set yet).
create function public.ai_front_desk_voice_ready(p_garage_id uuid, p_allowance numeric)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.ai_front_desk_hand_off(p_garage_id)
     and (
       p_allowance is null
       or coalesce((
         select sum(e.quantity)
         from public.usage_events e
         join public.garages g on g.id = e.garage_id
         where e.garage_id = p_garage_id
           and e.metric = 'ai_minutes'
           and e.period_month = date_trunc('month', now() at time zone g.timezone)::date
       ), 0) < p_allowance
     );
$$;

comment on function public.ai_front_desk_voice_ready(uuid, numeric) is
  'Voice desk: service role. ai_front_desk_hand_off() and this month''s AI minutes below p_allowance (null: no cap).';

-- Per-call tokens are not something staff manage: keep them out of the list.
create or replace function public.list_agent_tokens()
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
    and t.call_sid is null
  order by t.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.issue_voice_call_token(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_voice_call_token(uuid, text, text, timestamptz) to service_role;
revoke all on function public.record_ai_call_summary(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_ai_call_summary(uuid, text, text, text) to service_role;
revoke all on function public.ai_front_desk_voice_ready(uuid, numeric) from public, anon, authenticated;
grant execute on function public.ai_front_desk_voice_ready(uuid, numeric) to service_role;
