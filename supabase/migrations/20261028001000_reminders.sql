-- Autofix reminders, messages, calls and the job queue (P3.6).
--
-- Follows docs/autofix/ARCHITECTURE.md ("Admin, reminders and jobs"):
--
--   1. Tenant tables reminder_rules, reminder_sends, messages, calls and
--      garage_phone_numbers (garage_id, RLS on current_garage_id(), a policy
--      comment above each table's policies). Platform tables jobs (service
--      role only; garage_id optional, for jobs that belong to one garage) and
--      vehicle_facts (service role only; a registration HMAC and vehicle facts,
--      no customer data).
--   2. bookings.reminder_send_id gains its foreign key, and create_booking()
--      credits a booking to the reminder it came from: source = reminder and
--      reminder_sends.booking_id, in the same transaction.
--   3. Job queue: enqueue_job(), claim_jobs() (for update skip locked),
--      finish_job(), fail_job() (exponential backoff).
--   4. Reminders: schedule_reminders(), claim_reminder_sends(),
--      reminder_won_back(). seed_garage_defaults() adds the default rules, and
--      every garage that already exists gets them here.
--   5. Retention: apply_message_retention() clears message bodies, rendered
--      reminder bodies and voicemail links after 12 months (SPEC "Security,
--      privacy and compliance").
--
-- Rollback notes (manual; nothing here runs automatically). Prefer restoring
-- the database to before this migration (supabase db reset to
-- 20261027000100_scheduling.sql locally, a backup elsewhere). By hand, in one
-- transaction:
--   1. re-create public.create_booking_at(uuid, jsonb, timestamptz) and
--      public.seed_garage_defaults(uuid) from 20261027000100_scheduling.sql;
--   2. alter table public.bookings drop constraint bookings_reminder_send_id_fkey;
--      update public.bookings set source = 'online' where source = 'reminder';
--   3. drop function public.apply_message_retention(uuid),
--      public.reminder_won_back(uuid, date, date),
--      public.claim_reminder_sends(uuid, timestamptz, integer),
--      public.schedule_reminders(uuid, date), public.reminder_service_anchor(uuid, uuid),
--      public.seed_default_reminder_rules(uuid), public.fail_job(uuid, text, boolean),
--      public.finish_job(uuid), public.claim_jobs(text, integer),
--      public.enqueue_job(text, jsonb, timestamptz, text, uuid);
--   4. alter table public.calls drop constraint calls_text_back_message_id_fkey;
--      drop table public.messages, public.calls, public.reminder_sends,
--      public.reminder_rules, public.garage_phone_numbers, public.jobs,
--      public.vehicle_facts (their rows are lost).

-- ---------------------------------------------------------------------------
-- 1. Tenant tables
-- ---------------------------------------------------------------------------

-- One rule per kind per garage. offset_days: MOT days before expiry, service
-- days after the last service, review days after collection, missed_call
-- delay (0 = at once; the text-back is sent by the voice webhook, P4.1).
-- channel 'customer' means the customer's own channel (customers.channel).
create table public.reminder_rules (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  kind text not null,
  enabled boolean not null default true,
  offset_days integer[] not null,
  channel text not null default 'customer',
  template text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reminder_rules_garage_id_id_key unique (garage_id, id),
  constraint reminder_rules_garage_id_kind_key unique (garage_id, kind),
  constraint reminder_rules_kind_check check (kind in ('mot', 'service', 'review', 'missed_call')),
  constraint reminder_rules_channel_check check (channel in ('sms', 'whatsapp', 'email', 'customer')),
  constraint reminder_rules_offset_days_check check (
    array_ndims(offset_days) = 1
    and cardinality(offset_days) between 1 and 6
    and array_position(offset_days, null) is null
    and 0 <= all (offset_days)
    and 730 >= all (offset_days)
  ),
  constraint reminder_rules_template_check check (char_length(btrim(template)) between 1 and 1000)
);

comment on table public.reminder_rules is
  'Reminder automations per garage. Defaults come from seed_garage_defaults(); wording mirrors DEFAULT_TEMPLATES in src/lib/messaging/templates.ts.';

-- One row per reminder a vehicle gets: scheduled by schedule_reminders(),
-- claimed by claim_reminder_sends() (scheduled -> sending, or skipped with a
-- reason), then updated by the sender and delivery webhooks (sent, delivered,
-- failed). due_date is what the reminder is about: the MOT expiry, the date
-- the service is due (a year after the last one) or the collection date for
-- a review request. customer_id is the vehicle's owner when last checked;
-- channel the resolved channel (never 'customer').
create table public.reminder_sends (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  rule_id uuid,
  vehicle_id uuid not null,
  customer_id uuid not null,
  kind text not null,
  due_date date not null,
  offset_days integer not null,
  send_at timestamptz not null,
  channel text not null,
  status text not null default 'scheduled',
  skip_reason text,
  claimed_at timestamptz,
  provider_msg_id text,
  link_token_hash text,
  link_expires_at timestamptz,
  opened_at timestamptz,
  booking_id uuid,
  body text,
  sent_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reminder_sends_garage_id_id_key unique (garage_id, id),
  constraint reminder_sends_schedule_key unique (garage_id, vehicle_id, kind, due_date, offset_days),
  constraint reminder_sends_rule_id_fkey foreign key (garage_id, rule_id)
    references public.reminder_rules (garage_id, id) on delete set null (rule_id),
  constraint reminder_sends_vehicle_id_fkey foreign key (garage_id, vehicle_id)
    references public.vehicles (garage_id, id) on delete cascade,
  constraint reminder_sends_customer_id_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id) on delete cascade,
  constraint reminder_sends_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete set null (booking_id),
  constraint reminder_sends_kind_check check (kind in ('mot', 'service', 'review')),
  constraint reminder_sends_offset_days_check check (offset_days between 0 and 730),
  constraint reminder_sends_channel_check check (channel in ('sms', 'whatsapp', 'email')),
  constraint reminder_sends_status_check check (status in (
    'scheduled', 'sending', 'sent', 'delivered', 'failed', 'cancelled', 'skipped'
  )),
  constraint reminder_sends_skip_reason_check check (
    (status in ('skipped', 'cancelled')) = (skip_reason is not null)
    and (skip_reason is null or skip_reason ~ '^[a-z][a-z_]{1,39}$')
  ),
  constraint reminder_sends_claimed_check check (status not in ('sending', 'sent', 'delivered', 'failed') or claimed_at is not null),
  constraint reminder_sends_sent_check check (status not in ('sent', 'delivered') or sent_at is not null),
  constraint reminder_sends_link_check check (
    (link_token_hash is null) = (link_expires_at is null)
    and (link_token_hash is null or link_token_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint reminder_sends_provider_msg_id_check check (provider_msg_id is null or char_length(provider_msg_id) between 1 and 64),
  constraint reminder_sends_body_check check (body is null or char_length(body) <= 2000),
  constraint reminder_sends_error_code_check check (error_code is null or char_length(error_code) <= 64)
);

create index reminder_sends_due_idx on public.reminder_sends (garage_id, send_at) where status = 'scheduled';
create index reminder_sends_garage_customer_idx on public.reminder_sends (garage_id, customer_id);
create index reminder_sends_garage_rule_idx on public.reminder_sends (garage_id, rule_id);
create index reminder_sends_garage_booking_idx on public.reminder_sends (garage_id, booking_id) where booking_id is not null;
create index reminder_sends_garage_sent_idx on public.reminder_sends (garage_id, sent_at) where sent_at is not null;
create unique index reminder_sends_link_token_hash_key on public.reminder_sends (garage_id, link_token_hash)
  where link_token_hash is not null;
create index reminder_sends_provider_msg_idx on public.reminder_sends (provider_msg_id) where provider_msg_id is not null;

comment on column public.reminder_sends.due_date is
  'MOT expiry (mot), the date the service is due, a year after the last one (service), or the collection date (review).';
comment on column public.reminder_sends.link_token_hash is
  'SHA-256 hex of the /r/{token} link token (32 random bytes). The token itself is never stored.';
comment on column public.reminder_sends.booking_id is
  'The latest booking made through this reminder (create_booking attribution). Won-back figures count bookings.reminder_send_id.';

-- Calls to the garage's Autofix number (Twilio voice webhook). from_number is
-- null for withheld numbers; status uses Twilio's CallStatus values.
create table public.calls (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  provider_call_sid text not null,
  from_number text,
  to_number text not null,
  status text not null default 'ringing',
  missed boolean not null default false,
  voicemail_url text,
  duration_s integer,
  text_back_message_id uuid,
  handled_at timestamptz,
  handled_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calls_garage_id_id_key unique (garage_id, id),
  constraint calls_provider_call_sid_key unique (provider_call_sid),
  constraint calls_provider_call_sid_check check (char_length(provider_call_sid) between 1 and 64 and provider_call_sid ~ '^[A-Za-z0-9_.:-]+$'),
  constraint calls_from_number_check check (from_number is null or from_number ~ '^\+[1-9][0-9]{6,14}$'),
  constraint calls_to_number_check check (to_number ~ '^\+[1-9][0-9]{6,14}$'),
  constraint calls_status_check check (status in (
    'queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'failed', 'no-answer', 'canceled'
  )),
  constraint calls_voicemail_url_check check (voicemail_url is null or (voicemail_url ~ '^https://' and char_length(voicemail_url) <= 500)),
  constraint calls_duration_s_check check (duration_s is null or duration_s between 0 and 86400)
);

create index calls_garage_created_idx on public.calls (garage_id, created_at desc);
create index calls_garage_unhandled_idx on public.calls (garage_id, created_at desc) where missed and handled_at is null;

-- Inbound and outbound SMS, WhatsApp and email. status is the normalised
-- DeliveryStatus (src/lib/messaging/channel.ts) plus 'sending' (claimed before
-- send, DECISIONS A14) and 'received' for inbound. Addresses are E.164 on the
-- customer's side of a text; body is cleared after 12 months by retention.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  customer_id uuid,
  channel text not null,
  direction text not null,
  to_address text,
  from_address text,
  body text,
  provider text not null,
  provider_msg_id text,
  status text not null default 'queued',
  reminder_send_id uuid,
  booking_id uuid,
  call_id uuid,
  error_code text,
  redacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messages_garage_id_id_key unique (garage_id, id),
  constraint messages_customer_id_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id) on delete set null (customer_id),
  constraint messages_reminder_send_id_fkey foreign key (garage_id, reminder_send_id)
    references public.reminder_sends (garage_id, id) on delete set null (reminder_send_id),
  constraint messages_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete set null (booking_id),
  constraint messages_call_id_fkey foreign key (garage_id, call_id)
    references public.calls (garage_id, id) on delete set null (call_id),
  constraint messages_channel_check check (channel in ('sms', 'whatsapp', 'email')),
  constraint messages_direction_check check (direction in ('inbound', 'outbound')),
  constraint messages_status_check check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'received')),
  constraint messages_direction_status_check check ((direction = 'inbound') = (status = 'received')),
  constraint messages_address_length_check check (
    (to_address is null or char_length(to_address) between 1 and 320)
    and (from_address is null or char_length(from_address) between 1 and 320)
  ),
  constraint messages_customer_number_check check (
    channel = 'email'
    or (direction = 'outbound' and to_address ~ '^\+[1-9][0-9]{6,14}$')
    or (direction = 'inbound' and from_address ~ '^\+[1-9][0-9]{6,14}$')
  ),
  constraint messages_email_address_check check (
    channel <> 'email' or direction <> 'outbound' or to_address ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  ),
  constraint messages_body_check check (
    (body is not null and char_length(body) <= 10000) or (body is null and redacted_at is not null)
  ),
  constraint messages_provider_check check (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  constraint messages_provider_msg_id_check check (provider_msg_id is null or char_length(provider_msg_id) between 1 and 64),
  constraint messages_error_code_check check (error_code is null or char_length(error_code) <= 64)
);

create index messages_garage_created_idx on public.messages (garage_id, created_at desc);
create index messages_garage_customer_idx on public.messages (garage_id, customer_id, created_at desc);
create index messages_garage_reminder_send_idx on public.messages (garage_id, reminder_send_id) where reminder_send_id is not null;
create index messages_garage_booking_idx on public.messages (garage_id, booking_id) where booking_id is not null;
create index messages_garage_call_idx on public.messages (garage_id, call_id) where call_id is not null;
create unique index messages_provider_msg_id_key on public.messages (provider_msg_id) where provider_msg_id is not null;

alter table public.calls
  add constraint calls_text_back_message_id_fkey foreign key (garage_id, text_back_message_id)
    references public.messages (garage_id, id) on delete set null (text_back_message_id);

-- Twilio numbers -> garage. Webhooks resolve the garage from the called
-- number, and must only honour rows with provider_sid set: staff can list,
-- add and remove numbers, but only the platform (service role) provisions
-- them (sets provider_sid), so a number typed in by a garage routes nothing.
create table public.garage_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  number text not null,
  purpose text not null default 'forwarding',
  provider_sid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint garage_phone_numbers_number_key unique (number),
  constraint garage_phone_numbers_provider_sid_key unique (provider_sid),
  constraint garage_phone_numbers_number_check check (number ~ '^\+[1-9][0-9]{6,14}$'),
  constraint garage_phone_numbers_purpose_check check (purpose in ('forwarding', 'messaging')),
  constraint garage_phone_numbers_provider_sid_check check (provider_sid is null or provider_sid ~ '^[A-Za-z0-9]{2,64}$')
);

create index garage_phone_numbers_garage_idx on public.garage_phone_numbers (garage_id, purpose);

comment on column public.garage_phone_numbers.purpose is
  'forwarding: the garage forwards missed calls here and text-backs come from it; messaging: the two-way SMS/WhatsApp sender (DECISIONS A13).';

-- ---------------------------------------------------------------------------
-- 2. Platform tables (service role only, DECISIONS A10)
-- ---------------------------------------------------------------------------

-- Postgres job queue. garage_id is set for jobs that belong to one garage
-- (reminders.send for garage X) and null for platform jobs. dedupe_key is
-- unique for ever: enqueueing the same key again returns the existing job, so
-- recurring work puts its date in the key (reminders.schedule:<garage>:<day>).
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  garage_id uuid references public.garages(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  run_at timestamptz not null default now(),
  status text not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  locked_until timestamptz,
  last_error text,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_kind_check check (char_length(kind) <= 60 and kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint jobs_payload_check check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  constraint jobs_dedupe_key_check check (dedupe_key is null or char_length(dedupe_key) between 1 and 200),
  constraint jobs_status_check check (status in ('queued', 'running', 'done', 'failed')),
  constraint jobs_attempts_check check (attempts >= 0),
  constraint jobs_max_attempts_check check (max_attempts between 1 and 25),
  constraint jobs_lock_check check ((status = 'running') = (locked_until is not null)),
  constraint jobs_finished_check check ((status in ('done', 'failed')) = (finished_at is not null)),
  constraint jobs_last_error_check check (last_error is null or char_length(last_error) <= 2000)
);

create unique index jobs_dedupe_key_key on public.jobs (dedupe_key) where dedupe_key is not null;
create index jobs_claim_idx on public.jobs (status, kind, run_at);
create index jobs_garage_idx on public.jobs (garage_id, status) where garage_id is not null;

comment on table public.jobs is
  'Platform job queue (service role only). claim_jobs() uses FOR UPDATE SKIP LOCKED; handlers must be idempotent (at-least-once).';

-- 24-hour vehicle lookup cache (src/lib/vehicle/facts-cache.ts). reg_hash is
-- the hex HMAC-SHA-256 of the normalised registration with
-- VEHICLE_FACTS_PEPPER; facts hold vehicle facts only.
create table public.vehicle_facts (
  reg_hash text primary key,
  facts jsonb not null,
  fetched_at timestamptz not null default now(),
  constraint vehicle_facts_reg_hash_check check (reg_hash ~ '^[0-9a-f]{64}$'),
  constraint vehicle_facts_facts_check check (jsonb_typeof(facts) = 'object')
);

create index vehicle_facts_fetched_idx on public.vehicle_facts (fetched_at);

-- bookings.reminder_send_id (P2.1) now references the garage's reminders. No
-- reminder can exist before this migration, so any stored id is dropped.
update public.bookings set reminder_send_id = null where reminder_send_id is not null;
alter table public.bookings
  add constraint bookings_reminder_send_id_fkey foreign key (garage_id, reminder_send_id)
    references public.reminder_sends (garage_id, id) on delete set null (reminder_send_id);

comment on column public.bookings.reminder_send_id is
  'The reminder that produced this booking (create_booking attribution, P3.6). source is reminder exactly when it was credited.';

create trigger reminder_rules_updated before update on public.reminder_rules
  for each row execute function public.set_updated_at();
create trigger reminder_sends_updated before update on public.reminder_sends
  for each row execute function public.set_updated_at();
create trigger calls_updated before update on public.calls
  for each row execute function public.set_updated_at();
create trigger messages_updated before update on public.messages
  for each row execute function public.set_updated_at();
create trigger garage_phone_numbers_updated before update on public.garage_phone_numbers
  for each row execute function public.set_updated_at();
create trigger jobs_updated before update on public.jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Job queue
-- ---------------------------------------------------------------------------

-- Queue a job, or return the job already queued under the same dedupe key
-- (whatever its state). p_payload null means {}; p_run_at null means now.
create function public.enqueue_job(
  p_kind text,
  p_payload jsonb default '{}'::jsonb,
  p_run_at timestamptz default null,
  p_dedupe_key text default null,
  p_garage_id uuid default null
)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  dedupe text := nullif(btrim(p_dedupe_key), '');
  job public.jobs%rowtype;
begin
  if p_kind is null then
    raise exception 'INVALID_JOB: kind is required' using errcode = '22023';
  end if;
  if p_payload is not null and jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID_JOB: payload must be a JSON object' using errcode = '22023';
  end if;

  insert into public.jobs (kind, garage_id, payload, dedupe_key, run_at)
  values (p_kind, p_garage_id, coalesce(p_payload, '{}'::jsonb), dedupe, coalesce(p_run_at, now()))
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning * into job;

  if not found then
    select existing.* into job from public.jobs existing where existing.dedupe_key = dedupe;
  end if;
  return job;
end
$$;

-- Claim up to p_limit (max 100) due jobs of one kind: queued jobs whose
-- run_at has passed, and running jobs whose lock has expired (the worker
-- died). Each becomes running, locked for 5 minutes, attempts + 1. Rows other
-- workers hold are skipped (for update skip locked), so concurrent workers
-- never claim the same job or wait for each other. An expired job that had
-- already used its last attempt is failed (LOCK_EXPIRED) instead.
create function public.claim_jobs(p_kind text, p_limit integer)
returns setof public.jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_kind is null then
    raise exception 'INVALID_JOB_CLAIM: kind is required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'INVALID_JOB_CLAIM: limit must be at least 1' using errcode = '22023';
  end if;

  update public.jobs job
  set status = 'failed',
      locked_until = null,
      finished_at = now(),
      last_error = left('LOCK_EXPIRED: the worker neither finished nor failed attempt ' || job.attempts
                        || coalesce(E'\n' || job.last_error, ''), 2000)
  where job.id in (
    select stale.id
    from public.jobs stale
    where stale.kind = p_kind
      and stale.status = 'running'
      and stale.locked_until < now()
      and stale.attempts >= stale.max_attempts
    for update skip locked
  );

  return query
  update public.jobs job
  set status = 'running',
      locked_until = now() + interval '5 minutes',
      attempts = job.attempts + 1
  where job.id in (
    select candidate.id
    from public.jobs candidate
    where candidate.kind = p_kind
      and candidate.run_at <= now()
      and (candidate.status = 'queued' or (candidate.status = 'running' and candidate.locked_until < now()))
    order by candidate.run_at, candidate.id
    limit least(p_limit, 100)
    for update skip locked
  )
  returning job.*;
end
$$;

-- Mark a running job done. False when the job is not running (unknown,
-- already finished, or failed).
create function public.finish_job(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.jobs job
  set status = 'done', locked_until = null, finished_at = now()
  where job.id = p_id and job.status = 'running';
  return found;
end
$$;

-- Record a failed attempt of a running job. While attempts < max_attempts
-- (and p_retry) the job is queued again 2^attempts minutes later (2, 4, 8,
-- 16 ...; capped at 2^20); otherwise it is failed. Returns the new status
-- ('queued' or 'failed'), or null when the job was not running. p_retry =>
-- false fails it at once (permanent errors; A14 ambiguous sends).
create function public.fail_job(p_id uuid, p_error text, p_retry boolean default true)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  new_status text;
begin
  update public.jobs job
  set status = case when coalesce(p_retry, true) and job.attempts < job.max_attempts then 'queued' else 'failed' end,
      run_at = case
        when coalesce(p_retry, true) and job.attempts < job.max_attempts
          then now() + make_interval(mins => power(2, least(job.attempts, 20))::integer)
        else job.run_at
      end,
      locked_until = null,
      finished_at = case when coalesce(p_retry, true) and job.attempts < job.max_attempts then null else now() end,
      last_error = left(coalesce(nullif(btrim(p_error), ''), 'UNKNOWN_ERROR'), 2000)
  where job.id = p_id and job.status = 'running'
  returning job.status into new_status;
  return new_status;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Reminders
-- ---------------------------------------------------------------------------

-- The local date (garage time zone) of a vehicle's last service: its
-- last_service_at, else its last collected booking of a non-MOT service.
-- Null when neither is known. Internal; the service is due a year later.
create function public.reminder_service_anchor(p_garage_id uuid, p_vehicle_id uuid)
returns date
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (vehicle.last_service_at at time zone garage.timezone)::date,
    (
      select max((booking.starts_at at time zone garage.timezone)::date)
      from public.bookings booking
      join public.services service
        on service.garage_id = booking.garage_id
       and service.id = booking.service_id
      where booking.garage_id = vehicle.garage_id
        and booking.vehicle_id = vehicle.id
        and booking.status = 'collected'
        and booking.deleted_at is null
        and not service.is_mot
    )
  )
  from public.vehicles vehicle
  join public.garages garage on garage.id = vehicle.garage_id
  where vehicle.garage_id = p_garage_id
    and vehicle.id = p_vehicle_id
$$;

-- The four default rules (wording: DEFAULT_TEMPLATES in
-- src/lib/messaging/templates.ts, checked by
-- src/__tests__/reminder-rule-defaults.test.ts). Kinds the garage already has
-- are left alone. Review requests start switched off (design: Admin-Reminders).
create function public.seed_default_reminder_rules(p_garage_id uuid)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  added integer;
begin
  insert into public.reminder_rules (garage_id, kind, enabled, offset_days, channel, template) values
    (p_garage_id, 'mot', true, '{28,7}', 'customer',
     E'Hi {first_name}, the MOT on your {vehicle} ({reg}) is due on {due_date}. Book a time: {link}\n{garage}.'),
    (p_garage_id, 'service', true, '{335}', 'customer',
     E'Hi {first_name}, your {vehicle} ({reg}) is due a service. Book a time: {link}\n{garage}.'),
    (p_garage_id, 'review', false, '{1}', 'customer',
     E'Hi {first_name}, thanks for bringing your {vehicle} to us. Could you leave a quick review? {link}\n{garage}.'),
    (p_garage_id, 'missed_call', true, '{0}', 'customer',
     E'Sorry we missed your call. Book online in about a minute: {link} or we''ll call you back soon. {garage}')
  on conflict on constraint reminder_rules_garage_id_kind_key do nothing;
  get diagnostics added = row_count;
  return added;
end
$$;

-- Garage defaults for sign-up (P2.1) plus the default reminder rules (P3.6).
-- Each group of hours, resources and services only when the garage has none;
-- rules for each kind the garage does not have yet. Returns the counts added.
create or replace function public.seed_garage_defaults(p_garage_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  hours_added integer := 0;
  resources_added integer := 0;
  services_added integer := 0;
  rules_added integer := 0;
begin
  perform 1 from public.garages garage where garage.id = p_garage_id for update;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.opening_hours hours where hours.garage_id = p_garage_id) then
    insert into public.opening_hours (garage_id, weekday, opens, closes)
    select p_garage_id, weekday, time '08:00', time '17:30' from generate_series(1, 5) weekday
    union all
    select p_garage_id, 6, time '08:30', time '13:00';
    get diagnostics hours_added = row_count;
  end if;

  if not exists (select 1 from public.resources resource where resource.garage_id = p_garage_id) then
    insert into public.resources (garage_id, name, kind, sort) values
      (p_garage_id, 'Bay 1', 'bay', 1),
      (p_garage_id, 'Bay 2', 'bay', 2),
      (p_garage_id, 'Bay 3', 'bay', 3),
      (p_garage_id, 'Mobile van', 'mobile', 4);
    get diagnostics resources_added = row_count;
  end if;

  if not exists (select 1 from public.services service where service.garage_id = p_garage_id) then
    insert into public.services (
      garage_id, name, description, duration_min, buffer_min, price_pence, price_mode, location_mode, resource_kind,
      needs_approval, is_mot, sort
    ) values
      (p_garage_id, 'MOT', 'MOT test for cars and light vans (class 4).',
       60, 0, 5485, 'fixed', 'workshop', 'bay', false, true, 1),
      (p_garage_id, 'Diagnostics', 'Warning lights, running faults and electrical problems traced and explained.',
       60, 15, 4500, 'from', 'both', 'bay', false, false, 2),
      (p_garage_id, 'Full service', 'Annual service: oil and filters, fluids, brakes, steering and suspension checks.',
       180, 15, 17900, 'from', 'workshop', 'bay', false, false, 3),
      (p_garage_id, 'Interim service', 'Six-monthly oil and filter change with safety checks.',
       90, 15, 11900, 'from', 'workshop', 'bay', false, false, 4),
      (p_garage_id, 'Brakes', 'Pads, discs and brake fluid. We inspect first and quote before any work.',
       90, 15, null, 'quote', 'workshop', 'bay', true, false, 5),
      (p_garage_id, 'Something else', 'Tell us what is wrong and we will call you with a quote.',
       60, 0, null, 'quote', 'both', 'bay', true, false, 6);
    get diagnostics services_added = row_count;
  end if;

  rules_added := public.seed_default_reminder_rules(p_garage_id);

  return jsonb_build_object(
    'opening_hours', hours_added,
    'resources', resources_added,
    'services', services_added,
    'reminder_rules', rules_added
  );
end
$$;

-- Create the garage's reminder_sends for one day (p_today, a local date in
-- the garage's time zone; the reminders.schedule job passes today). For each
-- enabled rule and each of its offsets:
--   mot      due = vehicles.mot_expiry (not passed), send day = due - offset;
--            only while garages.mot_enabled
--   service  anchor = reminder_service_anchor(), due = anchor + 1 year,
--            send day = anchor + offset
--   review   due = the day the booking was collected (its status change to
--            collected, else its end), send day = due + offset; the booking's
--            customer
-- A row is created when its send day is between p_today - 3 (catch-up after a
-- missed run) and p_today + 30, for customers with reminder_consent, no
-- opted_out_at, not anonymised, and an address for the channel (rule channel,
-- or the customer's own for 'customer'). send_at = send day 10:00 in the
-- garage's time zone (the app's send window decides when it actually goes).
-- Idempotent through reminder_sends_schedule_key. Pending MOT and service
-- sends whose due date no longer matches the vehicle (MOT done elsewhere, a
-- newer service) are cancelled first, and re-armed if the date comes back.
-- Suspended and cancelled garages get nothing new. Returns the rows added
-- per kind and the rows cancelled.
create function public.schedule_reminders(p_garage_id uuid, p_today date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  catch_up_days constant integer := 3;
  horizon_days constant integer := 30;
  garage_zone text;
  garage_mot boolean;
  garage_status text;
  mot_added integer := 0;
  service_added integer := 0;
  review_added integer := 0;
  cancelled integer := 0;
begin
  if p_garage_id is null or p_today is null then
    raise exception 'INVALID_ARGUMENT: garage and day are required' using errcode = '22023';
  end if;
  select garage.timezone, garage.mot_enabled, garage.status
  into garage_zone, garage_mot, garage_status
  from public.garages garage
  where garage.id = p_garage_id;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- One scheduler per garage at a time.
  perform pg_advisory_xact_lock(hashtextextended('public.schedule_reminders:' || p_garage_id::text, 0));

  update public.reminder_sends send
  set status = 'cancelled', skip_reason = 'due_date_changed'
  from public.vehicles vehicle
  where send.garage_id = p_garage_id
    and send.status = 'scheduled'
    and send.kind in ('mot', 'service')
    and vehicle.garage_id = send.garage_id
    and vehicle.id = send.vehicle_id
    and send.due_date is distinct from case send.kind
      when 'mot' then vehicle.mot_expiry
      else (public.reminder_service_anchor(send.garage_id, send.vehicle_id) + interval '1 year')::date
    end;
  get diagnostics cancelled = row_count;

  if garage_status not in ('onboarding', 'active') then
    return jsonb_build_object('mot', 0, 'service', 0, 'review', 0, 'cancelled', cancelled);
  end if;

  if garage_mot then
    insert into public.reminder_sends as send (
      garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel
    )
    select
      p_garage_id, rule.id, vehicle.id, customer.id, 'mot', vehicle.mot_expiry, step.offset_days,
      ((vehicle.mot_expiry - step.offset_days) + time '10:00') at time zone garage_zone,
      route.channel
    from public.reminder_rules rule
    cross join lateral (select distinct unnest(rule.offset_days) as offset_days) step
    join public.vehicles vehicle on vehicle.garage_id = rule.garage_id
    join public.customers customer on customer.garage_id = vehicle.garage_id and customer.id = vehicle.customer_id
    cross join lateral (
      select case when rule.channel = 'customer' then customer.channel else rule.channel end as channel
    ) route
    where rule.garage_id = p_garage_id
      and rule.kind = 'mot'
      and rule.enabled
      and vehicle.mot_expiry >= p_today
      and vehicle.mot_expiry - step.offset_days between p_today - catch_up_days and p_today + horizon_days
      and customer.reminder_consent
      and customer.opted_out_at is null
      and customer.anonymised_at is null
      and case when route.channel = 'email' then customer.email is not null else customer.phone is not null end
    on conflict on constraint reminder_sends_schedule_key do update
      set status = 'scheduled', skip_reason = null, rule_id = excluded.rule_id, customer_id = excluded.customer_id,
          send_at = excluded.send_at, channel = excluded.channel
      where send.status = 'cancelled' and send.skip_reason = 'due_date_changed';
    get diagnostics mot_added = row_count;
  end if;

  insert into public.reminder_sends as send (
    garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel
  )
  select
    p_garage_id, rule.id, vehicle.id, customer.id, 'service', (anchor.serviced_on + interval '1 year')::date, step.offset_days,
    ((anchor.serviced_on + step.offset_days) + time '10:00') at time zone garage_zone,
    route.channel
  from public.reminder_rules rule
  cross join lateral (select distinct unnest(rule.offset_days) as offset_days) step
  join public.vehicles vehicle on vehicle.garage_id = rule.garage_id
  join public.customers customer on customer.garage_id = vehicle.garage_id and customer.id = vehicle.customer_id
  cross join lateral (select public.reminder_service_anchor(p_garage_id, vehicle.id) as serviced_on) anchor
  cross join lateral (
    select case when rule.channel = 'customer' then customer.channel else rule.channel end as channel
  ) route
  where rule.garage_id = p_garage_id
    and rule.kind = 'service'
    and rule.enabled
    and anchor.serviced_on is not null
    and anchor.serviced_on + step.offset_days between p_today - catch_up_days and p_today + horizon_days
    and customer.reminder_consent
    and customer.opted_out_at is null
    and customer.anonymised_at is null
    and case when route.channel = 'email' then customer.email is not null else customer.phone is not null end
  on conflict on constraint reminder_sends_schedule_key do update
    set status = 'scheduled', skip_reason = null, rule_id = excluded.rule_id, customer_id = excluded.customer_id,
        send_at = excluded.send_at, channel = excluded.channel
    where send.status = 'cancelled' and send.skip_reason = 'due_date_changed';
  get diagnostics service_added = row_count;

  insert into public.reminder_sends (
    garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel
  )
  select
    p_garage_id, rule.id, booking.vehicle_id, customer.id, 'review', collection.collected_on, step.offset_days,
    ((collection.collected_on + step.offset_days) + time '10:00') at time zone garage_zone,
    route.channel
  from public.reminder_rules rule
  cross join lateral (select distinct unnest(rule.offset_days) as offset_days) step
  join public.bookings booking
    on booking.garage_id = rule.garage_id
   and booking.status = 'collected'
   and booking.deleted_at is null
  join public.customers customer on customer.garage_id = booking.garage_id and customer.id = booking.customer_id
  cross join lateral (
    select (coalesce(
      (
        select max(event.at)
        from public.booking_events event
        where event.garage_id = booking.garage_id
          and event.booking_id = booking.id
          and event.type = 'status_changed'
          and event.data->>'to' = 'collected'
      ),
      booking.ends_at
    ) at time zone garage_zone)::date as collected_on
  ) collection
  cross join lateral (
    select case when rule.channel = 'customer' then customer.channel else rule.channel end as channel
  ) route
  where rule.garage_id = p_garage_id
    and rule.kind = 'review'
    and rule.enabled
    and collection.collected_on + step.offset_days between p_today - catch_up_days and p_today + horizon_days
    and customer.reminder_consent
    and customer.opted_out_at is null
    and customer.anonymised_at is null
    and case when route.channel = 'email' then customer.email is not null else customer.phone is not null end
  on conflict on constraint reminder_sends_schedule_key do nothing;
  get diagnostics review_added = row_count;

  return jsonb_build_object('mot', mot_added, 'service', service_added, 'review', review_added, 'cancelled', cancelled);
end
$$;

-- Claim up to p_limit (max 200) of the garage's due reminders (status
-- scheduled, send_at <= p_now), oldest first, for sending. Rows other senders
-- hold are skipped (for update skip locked). Each due row is re-checked and
-- either becomes 'sending' (returned, claimed_at = p_now, customer_id
-- re-pointed at the vehicle's current owner, channel resolved again) or
-- 'skipped' with one of these reasons, in this order:
--   no_customer, rule_missing, rule_disabled, rule_changed (offset no longer
--   in the rule), mot_disabled, anonymised, opted_out, no_consent, no_address,
--   due_date_changed, expired (MOT/service due date passed, or more than 7
--   days late), already_booked (another send for the same due date produced
--   a live booking; an MOT booked since 60 days before the due date; a
--   service visit booked ahead).
-- Skipped rows do not count towards p_limit. Quiet hours are NOT applied
-- here: the app calls this only inside the send window
-- (src/lib/messaging/quiet-hours.ts). Suspended and cancelled garages claim
-- nothing (their rows stay scheduled). The caller then stores the link token
-- hash and expiry, sends, and sets status/provider_msg_id/sent_at/body.
create function public.claim_reminder_sends(p_garage_id uuid, p_now timestamptz, p_limit integer)
returns table (
  id uuid,
  rule_id uuid,
  kind text,
  due_date date,
  offset_days integer,
  send_at timestamptz,
  channel text,
  template text,
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
  garage_zone text;
  garage_mot boolean;
  garage_status text;
  wanted integer;
  claimed integer := 0;
  batch_claimed integer;
  batch uuid[];
  local_today date;
begin
  if p_garage_id is null or p_now is null then
    raise exception 'INVALID_ARGUMENT: garage and clock are required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'INVALID_ARGUMENT: limit must be at least 1' using errcode = '22023';
  end if;
  select garage.timezone, garage.mot_enabled, garage.status
  into garage_zone, garage_mot, garage_status
  from public.garages garage
  where garage.id = p_garage_id;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if garage_status not in ('onboarding', 'active') then
    return;
  end if;

  wanted := least(p_limit, 200);
  local_today := (p_now at time zone garage_zone)::date;

  loop
    exit when claimed >= wanted;

    select array_agg(due.id)
    into batch
    from (
      select send.id
      from public.reminder_sends send
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
        vehicle.customer_id as owner_id,
        route.channel as route_channel,
        checked.reason
      from public.reminder_sends send
      join public.vehicles vehicle on vehicle.garage_id = send.garage_id and vehicle.id = send.vehicle_id
      left join public.customers customer on customer.garage_id = vehicle.garage_id and customer.id = vehicle.customer_id
      left join public.reminder_rules rule on rule.garage_id = send.garage_id and rule.id = send.rule_id
      cross join lateral (
        select case
          when rule.id is null or rule.channel = 'customer' then coalesce(customer.channel, send.channel)
          else rule.channel
        end as channel
      ) route
      cross join lateral (
        select case
          when customer.id is null then 'no_customer'
          when rule.id is null then 'rule_missing'
          when not rule.enabled then 'rule_disabled'
          when not (send.offset_days = any (rule.offset_days)) then 'rule_changed'
          when send.kind = 'mot' and not garage_mot then 'mot_disabled'
          when customer.anonymised_at is not null then 'anonymised'
          when customer.opted_out_at is not null then 'opted_out'
          when not customer.reminder_consent then 'no_consent'
          when (route.channel = 'email' and customer.email is null)
            or (route.channel <> 'email' and customer.phone is null) then 'no_address'
          when send.kind = 'mot' and vehicle.mot_expiry is distinct from send.due_date then 'due_date_changed'
          when send.kind = 'service'
            and (public.reminder_service_anchor(send.garage_id, send.vehicle_id) + interval '1 year')::date is distinct from send.due_date
            then 'due_date_changed'
          when send.kind in ('mot', 'service') and send.due_date < local_today then 'expired'
          when p_now > send.send_at + interval '7 days' then 'expired'
          when exists (
            select 1
            from public.reminder_sends sibling
            join public.bookings booking on booking.garage_id = sibling.garage_id and booking.id = sibling.booking_id
            where sibling.garage_id = send.garage_id
              and sibling.vehicle_id = send.vehicle_id
              and sibling.kind = send.kind
              and sibling.due_date = send.due_date
              and sibling.id <> send.id
              and booking.status not in ('cancelled', 'no_show')
          ) then 'already_booked'
          when send.kind = 'mot' and exists (
            select 1
            from public.bookings booking
            join public.services service on service.garage_id = booking.garage_id and service.id = booking.service_id
            where booking.garage_id = send.garage_id
              and booking.vehicle_id = send.vehicle_id
              and service.is_mot
              and booking.status not in ('cancelled', 'no_show')
              and booking.starts_at >= ((send.due_date - 60)::timestamp at time zone garage_zone)
          ) then 'already_booked'
          when send.kind = 'service' and exists (
            select 1
            from public.bookings booking
            join public.services service on service.garage_id = booking.garage_id and service.id = booking.service_id
            where booking.garage_id = send.garage_id
              and booking.vehicle_id = send.vehicle_id
              and not service.is_mot
              and booking.status in ('requested', 'confirmed')
              and booking.starts_at > p_now
          ) then 'already_booked'
        end as reason
      ) checked
      where send.garage_id = p_garage_id
        and send.id = any (batch)
    ),
    skipped as (
      update public.reminder_sends send
      set status = 'skipped', skip_reason = verdict.reason, claimed_at = p_now
      from verdict
      where send.garage_id = p_garage_id
        and send.id = verdict.send_id
        and verdict.reason is not null
      returning send.id
    ),
    taken as (
      update public.reminder_sends send
      set status = 'sending', claimed_at = p_now, customer_id = verdict.owner_id, channel = verdict.route_channel
      from verdict
      where send.garage_id = p_garage_id
        and send.id = verdict.send_id
        and verdict.reason is null
      returning send.*
    )
    select
      taken.id, taken.rule_id, taken.kind, taken.due_date, taken.offset_days, taken.send_at, taken.channel,
      rule.template,
      customer.id, customer.name, customer.phone, customer.email,
      vehicle.id, vehicle.registration, vehicle.make, vehicle.model
    from taken
    join public.reminder_rules rule on rule.garage_id = taken.garage_id and rule.id = taken.rule_id
    join public.customers customer on customer.garage_id = taken.garage_id and customer.id = taken.customer_id
    join public.vehicles vehicle on vehicle.garage_id = taken.garage_id and vehicle.id = taken.vehicle_id
    order by taken.send_at, taken.id;

    get diagnostics batch_claimed = row_count;
    claimed := claimed + batch_claimed;
  end loop;
end
$$;

-- Reminder figures for the dashboard over local dates p_from..p_to
-- (inclusive, garage time zone): reminders sent (sent_at in range), bookings
-- credited to a reminder (created in range, not cancelled/no-show/trashed)
-- and the pence they bring: the total of the booking's issued or paid
-- invoices when it has any, else bookings.price_pence (0 for quotes).
create function public.reminder_won_back(p_garage_id uuid, p_from date, p_to date)
returns table (sent integer, bookings integer, pence bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  garage_zone text;
  from_at timestamptz;
  to_at timestamptz;
begin
  if p_garage_id is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_ARGUMENT: garage and a date range (from <= to) are required' using errcode = '22023';
  end if;
  select garage.timezone into garage_zone from public.garages garage where garage.id = p_garage_id;
  if not found then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  from_at := p_from::timestamp at time zone garage_zone;
  to_at := (p_to + 1)::timestamp at time zone garage_zone;

  return query
  select
    (
      select count(*)::integer
      from public.reminder_sends send
      where send.garage_id = p_garage_id
        and send.sent_at >= from_at
        and send.sent_at < to_at
    ),
    count(credited.booking_id)::integer,
    coalesce(sum(credited.pence), 0)::bigint
  from (
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
    where booking.garage_id = p_garage_id
      and booking.reminder_send_id is not null
      and booking.status not in ('cancelled', 'no_show')
      and booking.deleted_at is null
      and booking.created_at >= from_at
      and booking.created_at < to_at
  ) credited;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. create_booking(): reminder attribution
-- ---------------------------------------------------------------------------
-- create_booking_at() from 20261027000100_scheduling.sql with the attribution
-- step; everything else is unchanged. create_booking() calls it as before.

-- create_booking() with an explicit clock (p_now). One transaction:
--   1. same (garage, idempotency_key) -> the existing booking, replayed;
--   2. validate the input (INVALID_BOOKING), the service (SERVICE_UNAVAILABLE),
--      the mobile postcode district (OUTSIDE_SERVICE_AREA) and the start:
--      an opening-window start on the slot step (else INVALID_BOOKING), not
--      on a closure day and inside the notice window (else SLOT_UNAVAILABLE);
--   3. upsert the customer by (garage, phone) and the vehicle by (garage,
--      registration); consent is only ever added, never withdrawn: when the
--      customer ticks the box and has no consent on record, consent_at,
--      consent_source and consent_text are written together; an existing
--      consent record and opted_out_at are never changed or cleared;
--   4. take the least-busy free resource of the kind that day (booked minutes,
--      then sort, then id) and insert; on no_overlap try the next free one,
--      then SLOT_UNAVAILABLE;
--   5. write the created event and return the booking.
-- Reminder attribution (P3.6): a reminder_send_id is credited only when the
-- send belongs to this garage, went out (status sending, sent, delivered or
-- failed: it carried a link) and is for the booking's own vehicle and
-- customer (matched by registration and phone above). Then the booking is
-- stored with source = reminder and reminder_send_id, and the send's
-- booking_id points at it, in this transaction. Otherwise the id is ignored,
-- and a requested source of reminder is stored as online, so source =
-- reminder exactly when a reminder is credited. Status and the created
-- event's actor still follow the requested source (an agent booking through
-- a reminder stays requested).
create or replace function public.create_booking_at(p_garage_id uuid, p_booking jsonb, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  idempotency uuid;
  existing public.bookings%rowtype;
  context record;
  service_id uuid;
  visit_mode text;
  booking_source text;
  booking_status text;
  starts_text text;
  booking_starts timestamptz;
  booking_ends timestamptz;
  booking_during tstzrange;
  local_day date;
  local_day_range tstzrange;
  customer_input jsonb;
  vehicle_input jsonb;
  customer_name text;
  customer_phone text;
  customer_email text;
  customer_channel text;
  consent_given boolean;
  consent_from text;
  consent_wording text;
  vehicle_registration text;
  vehicle_make text;
  vehicle_model text;
  vehicle_colour text;
  vehicle_fuel text;
  vehicle_year integer;
  vehicle_mot_expiry date;
  vehicle_mileage integer;
  mot_text text;
  booking_postcode text;
  compact_postcode text;
  booking_address text;
  booking_notes text;
  booking_symptoms text[] := '{}'::text[];
  manage_hash text;
  reminder_send uuid;
  reminder_vehicle uuid;
  reminder_customer uuid;
  stored_source text;
  matched_customer uuid;
  matched_vehicle uuid;
  tried uuid[] := '{}'::uuid[];
  chosen_resource uuid;
  created public.bookings%rowtype;
begin
  if p_garage_id is null or p_now is null then
    raise exception 'INVALID_BOOKING: garage is required' using errcode = 'P0001';
  end if;
  if p_booking is null or jsonb_typeof(p_booking) <> 'object' then
    raise exception 'INVALID_BOOKING: the booking must be a JSON object' using errcode = 'P0001';
  end if;

  -- 1. Idempotency
  idempotency := public.booking_input_uuid(p_booking->'idempotency_key', 'idempotency_key');
  if idempotency is not null then
    perform pg_advisory_xact_lock(hashtextextended('public.create_booking:' || p_garage_id::text || ':' || idempotency::text, 0));
    select booking.* into existing
    from public.bookings booking
    where booking.garage_id = p_garage_id
      and booking.idempotency_key = idempotency;
    if found then
      return public.booking_result(existing, true);
    end if;
  end if;

  -- 2. Validation
  service_id := public.booking_input_uuid(p_booking->'service_id', 'service_id');
  if service_id is null then
    raise exception 'INVALID_BOOKING: service_id is required' using errcode = 'P0001';
  end if;
  visit_mode := public.booking_input_text(p_booking->'location_mode', 'location_mode', 20);
  if visit_mode is not null and visit_mode not in ('workshop', 'mobile') then
    raise exception 'INVALID_BOOKING: location_mode must be workshop or mobile' using errcode = 'P0001';
  end if;
  booking_source := coalesce(public.booking_input_text(p_booking->'source', 'source', 20), 'online');
  if booking_source not in ('online', 'phone', 'walk_in', 'reminder', 'missed_call', 'ai_agent') then
    raise exception 'INVALID_BOOKING: unknown source' using errcode = 'P0001';
  end if;

  starts_text := public.booking_input_text(p_booking->'starts_at', 'starts_at', 40);
  if starts_text is null then
    raise exception 'INVALID_BOOKING: starts_at is required' using errcode = 'P0001';
  end if;
  if starts_text !~* '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    raise exception 'INVALID_BOOKING: starts_at must be an ISO 8601 timestamp with a UTC offset' using errcode = 'P0001';
  end if;
  begin
    booking_starts := starts_text::timestamptz;
  exception
    when others then
      raise exception 'INVALID_BOOKING: starts_at is not a valid timestamp' using errcode = 'P0001';
  end;

  customer_input := p_booking->'customer';
  if customer_input is null or jsonb_typeof(customer_input) <> 'object' then
    raise exception 'INVALID_BOOKING: customer is required' using errcode = 'P0001';
  end if;
  customer_name := public.booking_input_text(customer_input->'name', 'customer.name', 120);
  if customer_name is null or char_length(customer_name) < 2 then
    raise exception 'INVALID_BOOKING: customer.name is required' using errcode = 'P0001';
  end if;
  customer_phone := public.booking_input_text(customer_input->'phone', 'customer.phone', 16);
  if customer_phone is null or customer_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'INVALID_BOOKING: customer.phone must be E.164' using errcode = 'P0001';
  end if;
  customer_email := lower(public.booking_input_text(customer_input->'email', 'customer.email', 254));
  if customer_email is not null and customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'INVALID_BOOKING: customer.email is not an email address' using errcode = 'P0001';
  end if;
  customer_channel := public.booking_input_text(customer_input->'channel', 'customer.channel', 10);
  if customer_channel is not null and customer_channel not in ('sms', 'whatsapp', 'email') then
    raise exception 'INVALID_BOOKING: customer.channel must be sms, whatsapp or email' using errcode = 'P0001';
  end if;
  if customer_channel = 'email' and customer_email is null then
    raise exception 'INVALID_BOOKING: customer.email is required for the email channel' using errcode = 'P0001';
  end if;
  if customer_input->'reminder_consent' is not null and jsonb_typeof(customer_input->'reminder_consent') <> 'null' then
    if jsonb_typeof(customer_input->'reminder_consent') <> 'boolean' then
      raise exception 'INVALID_BOOKING: customer.reminder_consent must be true or false' using errcode = 'P0001';
    end if;
    consent_given := (customer_input->>'reminder_consent')::boolean;
  end if;
  consent_from := coalesce(public.booking_input_text(customer_input->'consent_source', 'customer.consent_source', 20), 'booking');
  if consent_from not in ('booking', 'import', 'soft_opt_in', 'staff') then
    raise exception 'INVALID_BOOKING: unknown customer.consent_source' using errcode = 'P0001';
  end if;
  consent_wording := public.booking_input_text(customer_input->'consent_text', 'customer.consent_text', 2000);

  vehicle_input := p_booking->'vehicle';
  if vehicle_input is null or jsonb_typeof(vehicle_input) <> 'object' then
    raise exception 'INVALID_BOOKING: vehicle is required' using errcode = 'P0001';
  end if;
  vehicle_registration := upper(regexp_replace(
    coalesce(public.booking_input_text(vehicle_input->'registration', 'vehicle.registration', 20), ''), '[^A-Za-z0-9]', '', 'g'));
  if vehicle_registration !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'INVALID_BOOKING: vehicle.registration is not a registration' using errcode = 'P0001';
  end if;
  vehicle_make := public.booking_input_text(vehicle_input->'make', 'vehicle.make', 80);
  vehicle_model := public.booking_input_text(vehicle_input->'model', 'vehicle.model', 120);
  vehicle_colour := public.booking_input_text(vehicle_input->'colour', 'vehicle.colour', 50);
  vehicle_fuel := public.booking_input_text(vehicle_input->'fuel', 'vehicle.fuel', 50);
  if vehicle_input->'year' is not null and jsonb_typeof(vehicle_input->'year') <> 'null' then
    if jsonb_typeof(vehicle_input->'year') <> 'number'
       or (vehicle_input->>'year')::numeric <> trunc((vehicle_input->>'year')::numeric)
       or (vehicle_input->>'year')::numeric not between 1900 and 2100 then
      raise exception 'INVALID_BOOKING: vehicle.year must be a year' using errcode = 'P0001';
    end if;
    vehicle_year := (vehicle_input->>'year')::integer;
  end if;
  mot_text := public.booking_input_text(vehicle_input->'mot_expiry', 'vehicle.mot_expiry', 10);
  if mot_text is not null then
    if mot_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'INVALID_BOOKING: vehicle.mot_expiry must be a date (YYYY-MM-DD)' using errcode = 'P0001';
    end if;
    begin
      vehicle_mot_expiry := mot_text::date;
    exception
      when others then
        raise exception 'INVALID_BOOKING: vehicle.mot_expiry must be a date (YYYY-MM-DD)' using errcode = 'P0001';
    end;
  end if;
  if vehicle_input->'last_mileage' is not null and jsonb_typeof(vehicle_input->'last_mileage') <> 'null' then
    if jsonb_typeof(vehicle_input->'last_mileage') <> 'number'
       or (vehicle_input->>'last_mileage')::numeric <> trunc((vehicle_input->>'last_mileage')::numeric)
       or (vehicle_input->>'last_mileage')::numeric not between 0 and 2000000 then
      raise exception 'INVALID_BOOKING: vehicle.last_mileage must be a whole number of miles' using errcode = 'P0001';
    end if;
    vehicle_mileage := (vehicle_input->>'last_mileage')::integer;
  end if;

  booking_postcode := public.booking_input_text(p_booking->'postcode', 'postcode', 10);
  if booking_postcode is not null then
    compact_postcode := upper(regexp_replace(booking_postcode, '[[:space:]]', '', 'g'));
    if compact_postcode !~ '^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$' then
      raise exception 'INVALID_BOOKING: postcode is not a UK postcode' using errcode = 'P0001';
    end if;
    booking_postcode := left(compact_postcode, -3) || ' ' || right(compact_postcode, 3);
  end if;
  booking_address := public.booking_input_text(p_booking->'address', 'address', 300);
  booking_notes := public.booking_input_text(p_booking->'notes', 'notes', 2000);
  if p_booking->'symptoms' is not null and jsonb_typeof(p_booking->'symptoms') <> 'null' then
    if jsonb_typeof(p_booking->'symptoms') <> 'array' or jsonb_array_length(p_booking->'symptoms') > 10 then
      raise exception 'INVALID_BOOKING: symptoms must be a list of at most 10' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_booking->'symptoms') symptom
      where jsonb_typeof(symptom) <> 'string' or char_length(btrim(symptom #>> '{}')) not between 1 and 80
    ) then
      raise exception 'INVALID_BOOKING: each symptom must be 1-80 characters' using errcode = 'P0001';
    end if;
    booking_symptoms := array(
      select btrim(symptom.value #>> '{}')
      from jsonb_array_elements(p_booking->'symptoms') with ordinality symptom(value, position)
      order by symptom.position
    );
  end if;
  manage_hash := public.booking_input_text(p_booking->'manage_token_hash', 'manage_token_hash', 64);
  if manage_hash is not null and manage_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_BOOKING: manage_token_hash must be 64 hex characters' using errcode = 'P0001';
  end if;

  -- The reminder this booking may be credited to (checked against the
  -- customer and vehicle once they are matched below).
  reminder_send := public.booking_input_uuid(p_booking->'reminder_send_id', 'reminder_send_id');
  if reminder_send is not null then
    select send.vehicle_id, send.customer_id
    into reminder_vehicle, reminder_customer
    from public.reminder_sends send
    where send.garage_id = p_garage_id
      and send.id = reminder_send
      and send.status in ('sending', 'sent', 'delivered', 'failed');
    if not found then
      reminder_send := null;
    end if;
  end if;

  -- The service, in this garage, bookable online in this mode.
  select * into context from public.booking_service_context(p_garage_id, service_id, visit_mode);
  visit_mode := context.location_mode;

  if visit_mode = 'mobile' then
    if booking_postcode is null then
      raise exception 'INVALID_BOOKING: postcode is required for mobile visits' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from unnest(context.service_area) area
      where upper(btrim(area)) = split_part(booking_postcode, ' ', 1)
    ) then
      raise exception 'OUTSIDE_SERVICE_AREA' using errcode = 'P0001';
    end if;
  end if;

  -- The start must be one the garage offers.
  local_day := (booking_starts at time zone context.timezone)::date;
  if not exists (
    select 1
    from public.opening_window_starts(p_garage_id, local_day, local_day, context.duration_min) window_start
    where window_start.starts_at = booking_starts
  ) then
    raise exception 'INVALID_BOOKING: starts_at is not a bookable time for this service' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.closures closure
    where closure.garage_id = p_garage_id
      and local_day between closure.starts_on and closure.ends_on
  )
  or booking_starts < p_now + make_interval(hours => context.min_notice_h)
  or booking_starts > p_now + make_interval(hours => context.max_days_ahead * 24) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- 3. Customer and vehicle
  insert into public.customers as customer (
    garage_id, name, phone, email, preferred_contact, channel, reminder_consent, consent_at, consent_source, consent_text
  )
  values (
    p_garage_id,
    customer_name,
    customer_phone,
    customer_email,
    case coalesce(customer_channel, 'sms') when 'sms' then 'phone' else coalesce(customer_channel, 'sms') end,
    coalesce(customer_channel, 'sms'),
    coalesce(consent_given, false),
    case when consent_given then p_now end,
    case when consent_given then consent_from end,
    case when consent_given then consent_wording end
  )
  on conflict (garage_id, phone) do update
  set name = excluded.name,
      email = coalesce(excluded.email, customer.email),
      channel = case when customer_channel is null then customer.channel else excluded.channel end,
      preferred_contact = case when customer_channel is null then customer.preferred_contact else excluded.preferred_contact end,
      reminder_consent = customer.reminder_consent or coalesce(consent_given, false),
      consent_at = case when not customer.reminder_consent and consent_given then p_now else customer.consent_at end,
      consent_source = case when not customer.reminder_consent and consent_given then consent_from else customer.consent_source end,
      consent_text = case when not customer.reminder_consent and consent_given then consent_wording else customer.consent_text end
  returning customer.id into matched_customer;

  insert into public.vehicles as vehicle (
    garage_id, customer_id, registration, make, model, colour, fuel, year, mot_expiry, mot_checked_at, last_mileage
  )
  values (
    p_garage_id,
    matched_customer,
    vehicle_registration,
    vehicle_make,
    vehicle_model,
    vehicle_colour,
    vehicle_fuel,
    vehicle_year,
    vehicle_mot_expiry,
    case when vehicle_mot_expiry is not null then p_now end,
    vehicle_mileage
  )
  on conflict (garage_id, registration) do update
  set customer_id = excluded.customer_id,
      make = coalesce(excluded.make, vehicle.make),
      model = coalesce(excluded.model, vehicle.model),
      colour = coalesce(excluded.colour, vehicle.colour),
      fuel = coalesce(excluded.fuel, vehicle.fuel),
      year = coalesce(excluded.year, vehicle.year),
      mot_expiry = coalesce(excluded.mot_expiry, vehicle.mot_expiry),
      mot_checked_at = coalesce(excluded.mot_checked_at, vehicle.mot_checked_at),
      last_mileage = greatest(excluded.last_mileage, vehicle.last_mileage)
  returning vehicle.id into matched_vehicle;

  if reminder_send is not null
     and (reminder_vehicle is distinct from matched_vehicle or reminder_customer is distinct from matched_customer) then
    reminder_send := null;
  end if;
  stored_source := case
    when reminder_send is not null then 'reminder'
    when booking_source = 'reminder' then 'online'
    else booking_source
  end;

  -- 4. Resource. Bookings for one garage are allocated one at a time; the
  -- exclusion constraint still guards every other writer.
  perform pg_advisory_xact_lock(hashtextextended('public.create_booking:' || p_garage_id::text, 0));

  booking_ends := booking_starts + make_interval(mins => context.duration_min);
  booking_during := tstzrange(
    booking_starts - make_interval(mins => context.travel_min),
    booking_ends + make_interval(mins => context.buffer_min + context.travel_min),
    '[)'
  );
  local_day_range := tstzrange(
    local_day::timestamp at time zone context.timezone,
    (local_day + 1)::timestamp at time zone context.timezone,
    '[)'
  );
  booking_status := case
    when context.needs_approval or context.approve_online or booking_source = 'ai_agent' then 'requested'
    else 'confirmed'
  end;

  loop
    select resource.id
    into chosen_resource
    from public.resources resource
    where resource.garage_id = p_garage_id
      and resource.active
      and resource.kind = context.resource_kind
      and resource.id <> all(tried)
      and not exists (
        select 1
        from public.bookings booking
        where booking.garage_id = p_garage_id
          and booking.resource_id = resource.id
          and booking.status not in ('cancelled', 'no_show')
          and booking.during && booking_during
      )
    order by
      (
        select coalesce(sum(extract(epoch from upper(booking.during * local_day_range) - lower(booking.during * local_day_range))), 0)
        from public.bookings booking
        where booking.garage_id = p_garage_id
          and booking.resource_id = resource.id
          and booking.status not in ('cancelled', 'no_show')
          and booking.during && local_day_range
      ),
      resource.sort,
      resource.id
    limit 1;

    if chosen_resource is null then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    begin
      insert into public.bookings (
        garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during,
        status, source, location_mode, postcode, address, symptoms, notes,
        idempotency_key, manage_token_hash, reminder_send_id, price_pence
      )
      values (
        p_garage_id, matched_customer, matched_vehicle, service_id, chosen_resource, booking_starts, booking_ends, booking_during,
        booking_status, stored_source, visit_mode, booking_postcode, booking_address, booking_symptoms, booking_notes,
        idempotency, manage_hash, reminder_send, context.price_pence
      )
      returning * into created;
      exit;
    exception
      when exclusion_violation then
        tried := tried || chosen_resource;
        chosen_resource := null;
    end;
  end loop;

  if reminder_send is not null then
    update public.reminder_sends send
    set booking_id = created.id
    where send.garage_id = p_garage_id
      and send.id = reminder_send;
  end if;

  -- 5. Timeline
  insert into public.booking_events (garage_id, booking_id, type, actor, data)
  values (
    p_garage_id,
    created.id,
    'created',
    case booking_source
      when 'ai_agent' then 'agent'
      when 'phone' then 'staff'
      when 'walk_in' then 'staff'
      else 'customer'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'source', stored_source,
      'status', booking_status,
      'service_id', service_id,
      'resource_id', created.resource_id,
      'location_mode', visit_mode,
      'starts_at', booking_starts,
      'reminder_send_id', reminder_send
    ))
  );

  return public.booking_result(created, false);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Retention: message bodies after 12 months
-- ---------------------------------------------------------------------------
-- For the retention job, once per garage like apply_enquiry_retention().
-- Message rows stay (direction, addresses, status, provider ids: the record
-- of what was sent and of STOP replies); their bodies, rendered reminder
-- bodies and voicemail links older than 12 months are cleared. Returns the
-- number of rows changed.
create function public.apply_message_retention(p_garage_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  messages_cleared integer;
  sends_cleared integer;
  calls_cleared integer;
begin
  if p_garage_id is null then
    raise exception 'GARAGE_REQUIRED' using errcode = '22004';
  end if;

  update public.messages message
  set body = null, redacted_at = now()
  where message.garage_id = p_garage_id
    and message.body is not null
    and message.created_at < now() - interval '12 months';
  get diagnostics messages_cleared = row_count;

  update public.reminder_sends send
  set body = null
  where send.garage_id = p_garage_id
    and send.body is not null
    and coalesce(send.sent_at, send.created_at) < now() - interval '12 months';
  get diagnostics sends_cleared = row_count;

  update public.calls phone_call
  set voicemail_url = null
  where phone_call.garage_id = p_garage_id
    and phone_call.voicemail_url is not null
    and phone_call.created_at < now() - interval '12 months';
  get diagnostics calls_cleared = row_count;

  return messages_cleared + sends_cleared + calls_cleared;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Default rules for the garages that already exist
-- ---------------------------------------------------------------------------

do $$
declare
  existing_garage uuid;
begin
  for existing_garage in select garage.id from public.garages garage loop
    perform public.seed_default_reminder_rules(existing_garage);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
-- anon gets nothing. Staff read rules, sends, messages, calls and numbers;
-- owners and managers manage rules (RLS), owners manage numbers except
-- provider_sid, staff mark calls handled. Sends, messages and calls are
-- written by service-role jobs and webhooks. jobs and vehicle_facts are
-- service role only.

grant select, insert, update, delete on
  public.reminder_rules,
  public.reminder_sends,
  public.messages,
  public.calls,
  public.garage_phone_numbers,
  public.jobs,
  public.vehicle_facts
to service_role;

grant select, delete on public.reminder_rules to authenticated;
grant insert (garage_id, kind, enabled, offset_days, channel, template) on public.reminder_rules to authenticated;
grant update (enabled, offset_days, channel, template) on public.reminder_rules to authenticated;

grant select on public.reminder_sends to authenticated;
grant select on public.messages to authenticated;
grant select on public.calls to authenticated;
grant update (handled_at, handled_by) on public.calls to authenticated;

grant select, delete on public.garage_phone_numbers to authenticated;
grant insert (garage_id, number, purpose) on public.garage_phone_numbers to authenticated;
grant update (purpose) on public.garage_phone_numbers to authenticated;

revoke all on function public.enqueue_job(text, jsonb, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function public.claim_jobs(text, integer) from public, anon, authenticated;
revoke all on function public.finish_job(uuid) from public, anon, authenticated;
revoke all on function public.fail_job(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.schedule_reminders(uuid, date) from public, anon, authenticated;
revoke all on function public.claim_reminder_sends(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.reminder_won_back(uuid, date, date) from public, anon, authenticated;
revoke all on function public.apply_message_retention(uuid) from public, anon, authenticated;
revoke all on function public.seed_garage_defaults(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_job(text, jsonb, timestamptz, text, uuid) to service_role;
grant execute on function public.claim_jobs(text, integer) to service_role;
grant execute on function public.finish_job(uuid) to service_role;
grant execute on function public.fail_job(uuid, text, boolean) to service_role;
grant execute on function public.schedule_reminders(uuid, date) to service_role;
grant execute on function public.claim_reminder_sends(uuid, timestamptz, integer) to service_role;
grant execute on function public.reminder_won_back(uuid, date, date) to service_role;
grant execute on function public.apply_message_retention(uuid) to service_role;
grant execute on function public.seed_garage_defaults(uuid) to service_role;

-- Internals: owner only.
revoke all on function public.reminder_service_anchor(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.seed_default_reminder_rules(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_booking_at(uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Row-level security
-- ---------------------------------------------------------------------------
-- "Selected garage" is public.current_garage_id() (DECISIONS.md A6). The
-- service role bypasses RLS and filters by garage itself.

alter table public.reminder_rules enable row level security;
alter table public.reminder_sends enable row level security;
alter table public.messages enable row level security;
alter table public.calls enable row level security;
alter table public.garage_phone_numbers enable row level security;
alter table public.jobs enable row level security;
alter table public.vehicle_facts enable row level security;

-- reminder_rules
--   "garage members read reminder rules"         select  members of the selected garage
--   "owners and managers add reminder rules"     insert  owners/managers of the selected garage
--   "owners and managers change reminder rules"  update  owners/managers of the selected garage (column grants: enabled, offset_days, channel, template)
--   "owners and managers remove reminder rules"  delete  owners/managers of the selected garage (its sends keep rule_id null)
create policy "garage members read reminder rules" on public.reminder_rules
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add reminder rules" on public.reminder_rules
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers change reminder rules" on public.reminder_rules
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));
create policy "owners and managers remove reminder rules" on public.reminder_rules
  for delete to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

-- reminder_sends
--   "garage members read reminder sends"  select  members of the selected garage
--   no insert/update/delete for staff: schedule_reminders(), claim_reminder_sends(), the sender and webhooks (service role) write them
create policy "garage members read reminder sends" on public.reminder_sends
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- messages
--   "garage members read messages"  select  members of the selected garage
--   no insert/update/delete for staff: sends, inbound webhooks and retention (service role) write them
create policy "garage members read messages" on public.messages
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- calls
--   "garage members read calls"          select  members of the selected garage
--   "garage members mark calls handled"  update  members of the selected garage, as themselves (column grants: handled_at, handled_by)
--   no insert/delete for staff: the voice webhook (service role) logs calls
create policy "garage members read calls" on public.calls
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "garage members mark calls handled" on public.calls
  for update to authenticated
  using (garage_id = (select public.current_garage_id()))
  with check (garage_id = (select public.current_garage_id()) and (handled_by is null or handled_by = (select auth.uid())));

-- garage_phone_numbers
--   "garage members read phone numbers"  select  members of the selected garage
--   "owners add phone numbers"           insert  owners of the selected garage (column grants: number, purpose; never provider_sid)
--   "owners change phone numbers"        update  owners of the selected garage (column grant: purpose)
--   "owners remove phone numbers"        delete  owners of the selected garage
create policy "garage members read phone numbers" on public.garage_phone_numbers
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners add phone numbers" on public.garage_phone_numbers
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');
create policy "owners change phone numbers" on public.garage_phone_numbers
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner')
  with check (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');
create policy "owners remove phone numbers" on public.garage_phone_numbers
  for delete to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) = 'owner');

-- jobs, vehicle_facts
--   no policies and no grants to anon or authenticated: service role only (DECISIONS A10)
