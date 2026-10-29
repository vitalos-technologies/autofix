-- Autofix's own phone line (DECISIONS A420): calls to a number in
-- AUTOFIX_PLATFORM_VOICE_NUMBERS, which belongs to Autofix, not to a garage.
--
--   1. platform_calls: one row per call to the platform line, with its
--      voicemail. A platform table (A10), not a tenant table: it has no
--      garage_id, RLS is on and signed-in staff and anon get nothing, so no
--      garage can ever read it. Only the service role (the voice webhook)
--      writes it; the Django super admin reads it through superadmin.calls
--      (20261029002200_superadmin_calls.sql). There is no text-back and no
--      ring-through on this line, so it has no dial or text-back columns.
--   2. apply_platform_call_retention(): clears voicemail links after 12
--      months, as apply_message_retention() does for garage calls (A57).
--      Run by the daily `retention` job's platform step.
--
-- Rollback (manual): drop function public.apply_platform_call_retention();
-- drop table public.platform_calls (after 20261029002200 is rolled back).

-- ---------------------------------------------------------------------------
-- 1. platform_calls
-- ---------------------------------------------------------------------------

create table public.platform_calls (
  id uuid primary key default gen_random_uuid(),
  provider_call_sid text not null,
  from_number text,
  to_number text not null,
  status text not null default 'ringing',
  -- Nobody answers this line: every call goes to the voicemail.
  missed boolean not null default true,
  duration_s integer,
  voicemail_url text,
  voicemail_duration_s integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_calls_provider_call_sid_key unique (provider_call_sid),
  constraint platform_calls_provider_call_sid_check check (char_length(provider_call_sid) between 1 and 64 and provider_call_sid ~ '^[A-Za-z0-9_.:-]+$'),
  constraint platform_calls_from_number_check check (from_number is null or from_number ~ '^\+[1-9][0-9]{6,14}$'),
  constraint platform_calls_to_number_check check (to_number ~ '^\+[1-9][0-9]{6,14}$'),
  constraint platform_calls_status_check check (status in (
    'queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'failed', 'no-answer', 'canceled'
  )),
  constraint platform_calls_duration_s_check check (duration_s is null or duration_s between 0 and 86400),
  constraint platform_calls_voicemail_url_check check (voicemail_url is null or (voicemail_url ~ '^https://' and char_length(voicemail_url) <= 500)),
  constraint platform_calls_voicemail_duration_s_check check (voicemail_duration_s is null or voicemail_duration_s between 0 and 3600)
);

comment on table public.platform_calls is
  'Calls to Autofix''s own line (AUTOFIX_PLATFORM_VOICE_NUMBERS), not a garage''s. Service role only; read by the super admin through superadmin.calls.';
comment on column public.platform_calls.voicemail_url is
  'Twilio recording URL (https://api.twilio.com/...); played through the super admin''s proxy. Cleared after 12 months by apply_platform_call_retention().';

create index platform_calls_created_idx on public.platform_calls (created_at desc);

create trigger platform_calls_updated before update on public.platform_calls
  for each row execute function public.set_updated_at();

alter table public.platform_calls enable row level security;
-- No policies: nobody but the service role (which bypasses RLS) reads or writes it.
revoke all on public.platform_calls from public, anon, authenticated;
grant select, insert, update, delete on public.platform_calls to service_role;

-- ---------------------------------------------------------------------------
-- 2. Retention
-- ---------------------------------------------------------------------------

create function public.apply_platform_call_retention()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cleared integer;
begin
  update public.platform_calls platform_call
  set voicemail_url = null
  where platform_call.voicemail_url is not null
    and platform_call.created_at < now() - interval '12 months';
  get diagnostics cleared = row_count;
  return cleared;
end
$$;

comment on function public.apply_platform_call_retention() is
  'Service role only. Clears platform-line voicemail links older than 12 months (A57, A420). Returns how many.';

revoke all on function public.apply_platform_call_retention() from public, anon, authenticated;
grant execute on function public.apply_platform_call_retention() to service_role;
