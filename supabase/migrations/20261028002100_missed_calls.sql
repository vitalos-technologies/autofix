-- Autofix missed calls (P4.1): what happened to a call, its voicemail, and
-- the one text-back a caller gets.
--
--   1. calls gains dial_status (the result of dialling the garage's own phone
--      first: Twilio's DialCallStatus) and voicemail_duration_s. voicemail_url
--      (P3.6) holds the Twilio recording link; retention clears it after 12
--      months (apply_message_retention).
--   2. claim_call_text_back(): the text-back's claim before send (DECISIONS
--      A14): under a per-garage, per-number lock it checks the call was
--      missed, has a caller number, has no text-back yet, the caller is not
--      opted out at this garage and got no text-back from it in the last 24
--      hours; then inserts the outbound messages row (status sending,
--      call_id set) and links it as calls.text_back_message_id. The job
--      sends afterwards and records the result on that row.
--
-- Rollback notes (manual): drop function
-- public.claim_call_text_back(uuid, uuid, text, text, text); alter table
-- public.calls drop column dial_status, drop column voicemail_duration_s.

-- ---------------------------------------------------------------------------
-- 1. calls
-- ---------------------------------------------------------------------------

alter table public.calls
  add column dial_status text,
  add column voicemail_duration_s integer,
  add constraint calls_dial_status_check check (
    dial_status is null or dial_status in ('completed', 'answered', 'busy', 'no-answer', 'failed', 'canceled')
  ),
  add constraint calls_voicemail_duration_s_check check (voicemail_duration_s is null or voicemail_duration_s between 0 and 3600);

comment on column public.calls.dial_status is
  'Twilio DialCallStatus when the call was first put through to the garage''s own phone (garage_phone_numbers purpose forwarding without provider_sid); null when it went straight to voicemail.';
comment on column public.calls.voicemail_url is
  'Twilio recording URL (https://api.twilio.com/...); fetched for staff through /api/admin/calls/{id}/voicemail. Cleared after 12 months by apply_message_retention().';

-- Text-backs for a number at a garage, newest first (the 24-hour rule).
create index messages_garage_text_back_idx on public.messages (garage_id, to_address, created_at desc)
  where direction = 'outbound' and call_id is not null;

-- ---------------------------------------------------------------------------
-- 2. claim_call_text_back
-- ---------------------------------------------------------------------------

-- Claims the text-back for one missed call. Returns
--   {status: 'claimed', message_id, customer_id, to}   the messages row exists
--                                                       (sending) and is linked
--   {status: 'skipped', reason}                          nothing written
-- Reasons, in this order: not_found, not_missed, withheld (no caller
-- number), already_sent (this call has a text-back), opted_out (a customer of
-- this garage with this number has opted_out_at), recent_text_back (this
-- garage texted this number about a call in the last 24 hours).
create function public.claim_call_text_back(
  p_garage_id uuid,
  p_call_id uuid,
  p_channel text,
  p_body text,
  p_provider text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  phone_call public.calls%rowtype;
  caller uuid;
  message_id uuid;
begin
  if p_garage_id is null or p_call_id is null then
    raise exception 'INVALID_ARGUMENT: garage and call are required' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('sms', 'whatsapp') then
    raise exception 'INVALID_ARGUMENT: a text-back goes by sms or whatsapp' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 1600 then
    raise exception 'INVALID_ARGUMENT: body must be 1 to 1600 characters' using errcode = '22023';
  end if;

  select * into phone_call
  from public.calls existing
  where existing.garage_id = p_garage_id and existing.id = p_call_id
  for update;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'not_found');
  end if;
  if not phone_call.missed then
    return jsonb_build_object('status', 'skipped', 'reason', 'not_missed');
  end if;
  if phone_call.from_number is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'withheld');
  end if;
  if phone_call.text_back_message_id is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'already_sent');
  end if;

  -- One text-back decision per garage and number at a time.
  perform pg_advisory_xact_lock(hashtextextended('public.claim_call_text_back:' || p_garage_id::text || ':' || phone_call.from_number, 0));

  if exists (
    select 1 from public.customers customer
    where customer.garage_id = p_garage_id
      and customer.phone = phone_call.from_number
      and customer.opted_out_at is not null
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'opted_out');
  end if;

  if exists (
    select 1 from public.messages message
    where message.garage_id = p_garage_id
      and message.direction = 'outbound'
      and message.call_id is not null
      and message.to_address = phone_call.from_number
      and message.created_at > now() - interval '24 hours'
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'recent_text_back');
  end if;

  select customer.id into caller
  from public.customers customer
  where customer.garage_id = p_garage_id
    and customer.phone = phone_call.from_number
    and customer.anonymised_at is null;

  insert into public.messages (garage_id, customer_id, channel, direction, to_address, body, provider, status, call_id)
  values (p_garage_id, caller, p_channel, 'outbound', phone_call.from_number, p_body, p_provider, 'sending', phone_call.id)
  returning id into message_id;

  update public.calls
  set text_back_message_id = message_id
  where garage_id = p_garage_id and id = phone_call.id;

  return jsonb_build_object('status', 'claimed', 'message_id', message_id, 'customer_id', caller, 'to', phone_call.from_number);
end
$$;

comment on function public.claim_call_text_back(uuid, uuid, text, text, text) is
  'Service role only. Claims the one text-back for a missed call (24-hour limit per garage and number, opt-outs honoured) by writing its messages row before the send.';

revoke all on function public.claim_call_text_back(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_call_text_back(uuid, uuid, text, text, text) to service_role;
