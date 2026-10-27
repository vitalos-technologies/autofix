-- Agent tool API: service tokens and the per-call audit log (P4.2).
--
-- The Workforce agent (calls, WhatsApp) and Askbridge (website chat) call
-- /api/agent/v1/* with a bearer token issued to one garage
-- (docs/autofix/SPEC.md "AI front desk and missed calls"). The garage comes
-- from the token, never from a request body.
--
--   agent_tokens    one row per issued token. Only an HMAC-SHA-256 of the raw
--                   token is stored (keyed with AGENT_TOKEN_PEPPER, an app
--                   secret the database never sees), so the app hashes and
--                   issue_agent_token() stores; the raw token is shown once.
--                   No direct grants to staff: owners and managers list and
--                   revoke through list_agent_tokens() / revoke_agent_token(),
--                   which never return the hash.
--   agent_call_log  one row per authenticated call: garage, token, tool,
--                   outcome, HTTP status, latency, and the booking a
--                   create_booking call made. Never phone numbers,
--                   registrations or tokens. Staff of the garage read it.
--
-- Rollback (manual): drop function public.revoke_agent_token(uuid),
-- public.list_agent_tokens(), public.issue_agent_token(uuid, text, text[], text);
-- drop table public.agent_call_log, public.agent_tokens.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.agent_tokens (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  name text not null,
  token_hash text not null,
  scopes text[] not null default array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile']::text[],
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_tokens_garage_id_id_key unique (garage_id, id),
  constraint agent_tokens_token_hash_key unique (token_hash),
  constraint agent_tokens_name_check check (char_length(trim(name)) between 1 and 80),
  constraint agent_tokens_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint agent_tokens_scopes_check check (
    cardinality(scopes) > 0
    and scopes <@ array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile']::text[]
  )
);

create index agent_tokens_garage_created_idx on public.agent_tokens (garage_id, created_at desc);

comment on table public.agent_tokens is
  'Per-garage bearer tokens for /api/agent/v1/*. token_hash = hex HMAC-SHA-256(AGENT_TOKEN_PEPPER, raw token); the raw token is never stored.';
comment on column public.agent_tokens.scopes is
  'Agent tools this token may call (tool names). Defaults to all six.';

create table public.agent_call_log (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  token_id uuid,
  tool text not null,
  outcome text not null,
  http_status smallint not null,
  latency_ms integer not null,
  booking_id uuid,
  created_at timestamptz not null default now(),
  constraint agent_call_log_token_fkey foreign key (garage_id, token_id)
    references public.agent_tokens (garage_id, id) on delete set null (token_id),
  constraint agent_call_log_booking_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete set null (booking_id),
  constraint agent_call_log_tool_check check (tool in ('lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile')),
  constraint agent_call_log_outcome_check check (outcome ~ '^[A-Z][A-Z_]{1,39}$'),
  constraint agent_call_log_http_status_check check (http_status between 100 and 599),
  constraint agent_call_log_latency_check check (latency_ms >= 0)
);

create index agent_call_log_garage_created_idx on public.agent_call_log (garage_id, created_at desc);
create index agent_call_log_garage_token_idx on public.agent_call_log (garage_id, token_id) where token_id is not null;
create index agent_call_log_garage_booking_idx on public.agent_call_log (garage_id, booking_id) where booking_id is not null;

comment on table public.agent_call_log is
  'One row per authenticated agent API call. Never phone numbers, registrations or tokens.';
comment on column public.agent_call_log.outcome is
  'OK, or the error code returned (e.g. SLOT_UNAVAILABLE, FORBIDDEN, RATE_LIMITED).';

create trigger agent_tokens_set_updated_at
  before update on public.agent_tokens
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Functions
-- ---------------------------------------------------------------------------

-- Service role: stores a token the app generated and hashed. Returns the row
-- without its hash; the app hands the raw token to the caller once.
create function public.issue_agent_token(p_garage_id uuid, p_name text, p_scopes text[], p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  issued public.agent_tokens;
begin
  if p_garage_id is null or not exists (select 1 from public.garages g where g.id = p_garage_id) then
    raise exception 'INVALID_TOKEN: unknown garage' using errcode = 'P0001';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TOKEN: token_hash must be 64 hex characters' using errcode = 'P0001';
  end if;

  insert into public.agent_tokens (garage_id, name, token_hash, scopes)
  values (
    p_garage_id,
    trim(coalesce(p_name, '')),
    p_token_hash,
    coalesce(p_scopes, array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile']::text[])
  )
  returning * into issued;

  return jsonb_build_object(
    'id', issued.id,
    'garage_id', issued.garage_id,
    'name', issued.name,
    'scopes', to_jsonb(issued.scopes),
    'created_at', issued.created_at
  );
end
$$;

-- Owners and managers of the selected garage: the garage's tokens, never the hashes.
create function public.list_agent_tokens()
returns table (id uuid, name text, scopes text[], last_used_at timestamptz, revoked_at timestamptz, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, t.scopes, t.last_used_at, t.revoked_at, t.created_at
  from public.agent_tokens t
  where t.garage_id = public.current_garage_id()
    and public.current_garage_role() in ('owner', 'manager')
  order by t.created_at desc;
$$;

-- Owners and managers of the selected garage: revoke one of its tokens
-- (one way; a revoked token is never revived). True when a live token was revoked.
create function public.revoke_agent_token(p_token_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid := public.current_garage_id();
  revoked_count integer;
begin
  if garage_scope is null or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'Only owners and managers can revoke agent tokens' using errcode = '42501';
  end if;
  update public.agent_tokens t
     set revoked_at = now()
   where t.garage_id = garage_scope
     and t.id = p_token_id
     and t.revoked_at is null;
  get diagnostics revoked_count = row_count;
  return revoked_count > 0;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
-- anon gets nothing. Tokens: service role only (plus the two staff functions).
-- Call log: staff read; the service role writes.

revoke all on public.agent_tokens from public, anon, authenticated;
revoke all on public.agent_call_log from public, anon, authenticated;
grant select, insert, update, delete on public.agent_tokens to service_role;
grant select on public.agent_call_log to authenticated;
grant select, insert, delete on public.agent_call_log to service_role;

revoke all on function public.issue_agent_token(uuid, text, text[], text) from public, anon, authenticated;
revoke all on function public.list_agent_tokens() from public, anon;
revoke all on function public.revoke_agent_token(uuid) from public, anon;
grant execute on function public.issue_agent_token(uuid, text, text[], text) to service_role;
grant execute on function public.list_agent_tokens() to authenticated, service_role;
grant execute on function public.revoke_agent_token(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Row-level security
-- ---------------------------------------------------------------------------

alter table public.agent_tokens enable row level security;
alter table public.agent_call_log enable row level security;

-- agent_tokens
--   "owners and managers read agent tokens"  select  owners/managers of the selected garage
--   Staff hold no table grant, so this policy is a backstop only: tokens are
--   read and written by the service role (token checks, issue_agent_token())
--   and by the security-definer list_agent_tokens() / revoke_agent_token(),
--   which never return token_hash.
create policy "owners and managers read agent tokens" on public.agent_tokens
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

-- agent_call_log
--   "garage members read the agent call log"  select  members of the selected garage
--   writes: service role only
create policy "garage members read the agent call log" on public.agent_call_log
  for select to authenticated using (garage_id = (select public.current_garage_id()));
