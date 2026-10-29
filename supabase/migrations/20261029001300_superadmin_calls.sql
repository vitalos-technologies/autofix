-- Django super admin: calls and voicemails across every garage (Calls page,
-- garage Calls tab, voicemail playback). Builds on 20261028004000_superadmin_role.sql.
--
--   1. superadmin.mask_caller(): the caller's number masked as the garage app
--      shows it (maskMobile in src/lib/booking-flow/copy.ts): 07••• •••123.
--   2. superadmin.calls gains caller_masked, voicemail_duration_s and
--      has_voicemail. Columns are appended, so the view is replaced in place.
--      The raw caller number and the recording link stay out of it.
--   3. superadmin.call_voicemails: only the recording link of calls that have
--      one, read by the super admin's voicemail proxy and nothing else. The
--      proxy fetches the recording with the Twilio account's credentials
--      (held by the super admin, never this database), accepts only links
--      that pass the same check as isTwilioRecordingUrl in
--      src/lib/calls/twiml.ts, and audits every playback. Retention
--      (apply_message_retention) clears calls.voicemail_url after 12 months,
--      and the row leaves this view with it.
--
-- Rollback (manual): drop view superadmin.call_voicemails; recreate
-- superadmin.calls as in 20261028004000_superadmin_role.sql (drop and create,
-- since columns are removed); drop function superadmin.mask_caller(text).

-- ---------------------------------------------------------------------------
-- 1. Caller masking (immutable, no table access)
-- ---------------------------------------------------------------------------

create function superadmin.mask_caller(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  with digits as (
    select regexp_replace(coalesce(p_value, ''), '\D', '', 'g') as value
  ), national as (
    select case when value like '44%' then '0' || substr(value, 3) else value end as value from digits
  )
  select case
    when p_value is null or btrim(p_value) = '' then null
    when char_length(national.value) < 6 then '•••'
    else left(national.value, 2) || '••• •••' || right(national.value, 3)
  end
  from national
$$;

comment on function superadmin.mask_caller(text) is
  'A caller''s number as the garage app masks it (maskMobile): +447700900123 -> 07••• •••123. Null when withheld.';

-- ---------------------------------------------------------------------------
-- 2. Calls, with the masked caller and the voicemail's length
-- ---------------------------------------------------------------------------

create or replace view superadmin.calls with (security_barrier = true) as
  select call.id, call.garage_id, call.status, call.dial_status, call.missed, call.duration_s, call.text_back_message_id,
         call.handled_at, call.created_at,
         superadmin.mask_caller(call.from_number) as caller_masked,
         call.voicemail_duration_s,
         (call.voicemail_url is not null) as has_voicemail
  from public.calls call;

-- ---------------------------------------------------------------------------
-- 3. Recording links, for the playback proxy only
-- ---------------------------------------------------------------------------

create view superadmin.call_voicemails with (security_barrier = true) as
  select call.id, call.garage_id, call.voicemail_url
  from public.calls call
  where call.voicemail_url is not null;

comment on view superadmin.call_voicemails is
  'Twilio recording links for the super admin''s audited voicemail proxy. Never rendered: the proxy fetches the MP3 server-side.';

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

revoke all on superadmin.call_voicemails from public, anon, authenticated;
revoke all on function superadmin.mask_caller(text) from public, anon, authenticated;
grant select on superadmin.calls, superadmin.call_voicemails to autofix_superadmin;
grant execute on function superadmin.mask_caller(text) to autofix_superadmin;
