-- Autofix Twilio webhooks (P3.8): idempotency for the SMS, WhatsApp, delivery
-- status and voice webhooks, and the STOP/START keyword handling.
--
-- Follows docs/autofix/ARCHITECTURE.md ("Admin, reminders and jobs"):
--
--   1. twilio_webhook_events: a platform table (no garage_id, DECISIONS A10;
--      service role only, RLS on, no policies). Every verified webhook claims
--      its row first (claim_twilio_webhook_event) and records how it ended
--      (finish_twilio_webhook_event), so a replayed or retried request never
--      does its work twice. Rows hold Twilio's ids and outcome codes only:
--      never phone numbers or message bodies.
--   2. apply_messaging_keyword(p_garage_id, p_phone, p_intent): STOP sets
--      customers.opted_out_at for that garage and number at once and cancels
--      the customer's scheduled reminders (skip_reason opted_out); START clears
--      the opt-out only for customers with reminder consent on record. Both
--      are idempotent.
--
-- Rollback notes (manual; nothing here runs automatically): in one
-- transaction drop function public.apply_messaging_keyword(uuid, text, text),
-- public.finish_twilio_webhook_event(text, text, text, text),
-- public.claim_twilio_webhook_event(text, text, text) and drop table
-- public.twilio_webhook_events (its rows are only an idempotency record).

-- ---------------------------------------------------------------------------
-- 1. Webhook idempotency (platform table, service role only)
-- ---------------------------------------------------------------------------

-- event_key is chosen by the app from Twilio's own ids:
--   inbound:<MessageSid>              inbound SMS / WhatsApp
--   status:<MessageSid>:<status>      one row per delivery state of a message
--   voice:<CallSid>:<CallStatus>      the incoming call and each call status
-- outcome is a short code of what the webhook did (stored, stop, unrouted ...).
create table public.twilio_webhook_events (
  event_key text primary key,
  kind text not null,
  provider_sid text not null,
  processing_status text not null default 'processing',
  outcome text,
  error_code text,
  attempts integer not null default 1,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint twilio_webhook_events_event_key_check check (
    char_length(event_key) between 3 and 160 and event_key ~ '^[a-z]+:[A-Za-z0-9_.:-]+$'
  ),
  constraint twilio_webhook_events_kind_check check (kind in ('sms', 'whatsapp', 'status', 'voice')),
  constraint twilio_webhook_events_provider_sid_check check (
    char_length(provider_sid) between 1 and 64 and provider_sid ~ '^[A-Za-z0-9_.:-]+$'
  ),
  constraint twilio_webhook_events_processing_status_check check (
    processing_status in ('processing', 'processed', 'ignored', 'failed')
  ),
  constraint twilio_webhook_events_outcome_check check (outcome is null or outcome ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint twilio_webhook_events_error_code_check check (error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  constraint twilio_webhook_events_processed_check check ((processing_status = 'processing') = (processed_at is null))
);

create index twilio_webhook_events_received_idx on public.twilio_webhook_events (received_at);
create index twilio_webhook_events_provider_sid_idx on public.twilio_webhook_events (provider_sid);

comment on table public.twilio_webhook_events is
  'Twilio webhook idempotency (P3.8). Service role only. Ids and outcome codes only: no phone numbers or message bodies.';

alter table public.twilio_webhook_events enable row level security;

-- twilio_webhook_events
--   no policies and no grants to anon or authenticated: service role only (DECISIONS A10)

-- Claim a webhook event before doing its work. True when this request should
-- process it: a new event, one whose earlier attempt failed, or one stuck in
-- processing for more than 5 minutes (the function died). False for a
-- duplicate (processed, ignored, or being processed right now).
create function public.claim_twilio_webhook_event(p_event_key text, p_kind text, p_provider_sid text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed integer;
begin
  if p_event_key is null or p_kind is null or p_provider_sid is null then
    raise exception 'INVALID_ARGUMENT: event key, kind and provider id are required' using errcode = '22023';
  end if;

  insert into public.twilio_webhook_events as event (event_key, kind, provider_sid)
  values (p_event_key, p_kind, p_provider_sid)
  on conflict (event_key) do update
    set processing_status = 'processing',
        outcome = null,
        error_code = null,
        attempts = event.attempts + 1,
        received_at = now(),
        processed_at = null
    where event.processing_status = 'failed'
       or (event.processing_status = 'processing' and event.received_at < now() - interval '5 minutes');
  get diagnostics claimed = row_count;
  return claimed = 1;
end
$$;

-- Record how a claimed event ended: processed, ignored (nothing to do, e.g.
-- an unprovisioned number) or failed (the next delivery of the same event may
-- try again). True when a processing row was updated.
create function public.finish_twilio_webhook_event(
  p_event_key text,
  p_status text,
  p_outcome text default null,
  p_error_code text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('processed', 'ignored', 'failed') then
    raise exception 'INVALID_ARGUMENT: status must be processed, ignored or failed' using errcode = '22023';
  end if;
  update public.twilio_webhook_events event
  set processing_status = p_status,
      outcome = p_outcome,
      error_code = left(p_error_code, 64),
      processed_at = now()
  where event.event_key = p_event_key
    and event.processing_status = 'processing';
  return found;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. STOP / START (CLAUDE.md rule 5: honour STOP immediately)
-- ---------------------------------------------------------------------------

-- p_intent 'stop': every customer of the garage with this number gets
-- opted_out_at (an earlier opt-out is kept), and their scheduled reminders
-- are cancelled with skip_reason opted_out. A row already claimed for sending
-- is re-checked by nobody, so it may still go out within seconds; every later
-- claim skips the customer (claim_reminder_sends: opted_out).
-- p_intent 'start': clears opted_out_at only for customers who have reminder
-- consent on record (a START never creates consent; a customer without it
-- stays as they are). Cancelled reminders are not re-armed: the next
-- schedule_reminders() run creates the ones still ahead.
-- Returns {customers, cancelled, unchanged}: rows changed, reminders
-- cancelled, and matching customers left as they were (already opted out for
-- STOP; not opted out or without consent for START).
create function public.apply_messaging_keyword(p_garage_id uuid, p_phone text, p_intent text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer := 0;
  cancelled integer := 0;
  matching integer := 0;
begin
  if p_garage_id is null or p_phone is null or p_intent is null then
    raise exception 'INVALID_ARGUMENT: garage, phone and intent are required' using errcode = '22023';
  end if;
  if p_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'INVALID_ARGUMENT: phone must be E.164' using errcode = '22023';
  end if;
  if p_intent not in ('stop', 'start') then
    raise exception 'INVALID_ARGUMENT: intent must be stop or start' using errcode = '22023';
  end if;
  if not exists (select 1 from public.garages garage where garage.id = p_garage_id) then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  select count(*)::integer into matching
  from public.customers customer
  where customer.garage_id = p_garage_id and customer.phone = p_phone;

  if p_intent = 'stop' then
    update public.customers customer
    set opted_out_at = now()
    where customer.garage_id = p_garage_id
      and customer.phone = p_phone
      and customer.opted_out_at is null;
    get diagnostics changed = row_count;

    update public.reminder_sends send
    set status = 'cancelled', skip_reason = 'opted_out'
    where send.garage_id = p_garage_id
      and send.status = 'scheduled'
      and send.customer_id in (
        select customer.id from public.customers customer
        where customer.garage_id = p_garage_id and customer.phone = p_phone
      );
    get diagnostics cancelled = row_count;
  else
    update public.customers customer
    set opted_out_at = null
    where customer.garage_id = p_garage_id
      and customer.phone = p_phone
      and customer.opted_out_at is not null
      and customer.reminder_consent;
    get diagnostics changed = row_count;
  end if;

  return jsonb_build_object('customers', changed, 'cancelled', cancelled, 'unchanged', matching - changed);
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on public.twilio_webhook_events to service_role;

revoke all on function public.claim_twilio_webhook_event(text, text, text) from public, anon, authenticated;
revoke all on function public.finish_twilio_webhook_event(text, text, text, text) from public, anon, authenticated;
revoke all on function public.apply_messaging_keyword(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_twilio_webhook_event(text, text, text) to service_role;
grant execute on function public.finish_twilio_webhook_event(text, text, text, text) to service_role;
grant execute on function public.apply_messaging_keyword(uuid, text, text) to service_role;
