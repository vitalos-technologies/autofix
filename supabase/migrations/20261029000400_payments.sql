-- P5.4: payments (Pro feature `payments`; DECISIONS A318-A325 in
-- docs/autofix/phase-5/P5.4-payments.md). Deposits at booking, pay-by-link
-- invoices and no-show fees, taken on the garage's own payment account
-- (Stripe Connect in test mode, or the mock provider).
--
--   1. services.deposit_mode / deposit_value: per-service deposit ('default'
--      follows the garage's default; 'none'; 'fixed' pence; 'percent' of the
--      service price). Changing them needs Pro (services_deposit_plan_guard).
--   2. payment_accounts: the garage's connected payment account (one per
--      garage). Owners and managers read it; apply_payment_account() (service
--      role, after the owner connected in the admin or from the provider's
--      signed webhook) and disconnect_payment_account() (owners) write it.
--   3. payment_settings: deposits on/off, the default deposit, how long an
--      unpaid deposit holds the bay (30-180 min) and the no-show fee. Members
--      read; owners and managers write (RLS, needs Pro).
--   4. payments: every payment we asked a customer for: deposit, invoice,
--      no_show_fee; pending -> paid | expired | cancelled | failed. Only the
--      SHA-256 of the link token is stored. Members read; written only by the
--      functions below.
--   5. Deposits never bypass create_booking(): the booking is created first
--      through the engine (it holds the bay, so no_overlap applies as for any
--      booking), then create_deposit_payment() adds the pending deposit. If the
--      deposit is not paid by expires_at, expire_pending_deposits() cancels the
--      booking through an ordinary status update (reason "Deposit not paid in
--      time"), which takes it out of no_overlap and frees the slot.
--   6. apply_payment_paid() (service role): marks a payment paid once; an
--      invoice payment is recorded in invoice_payments (the existing model:
--      part-paid, or paid when the balance reaches zero).
--   7. payment_webhook_events (platform): provider events applied once.
--
-- Nothing here replaces create_booking*, available_slots* or
-- staff_available_slots*. Rollback (manual): drop the functions, triggers and
-- tables below and `alter table public.services drop column deposit_mode,
-- drop column deposit_value`.

-- ---------------------------------------------------------------------------
-- 1. Per-service deposit
-- ---------------------------------------------------------------------------

alter table public.services
  add column deposit_mode text not null default 'default',
  add column deposit_value integer,
  add constraint services_deposit_mode_check check (deposit_mode in ('default', 'none', 'fixed', 'percent')),
  add constraint services_deposit_value_check check (
    (deposit_mode in ('default', 'none') and deposit_value is null)
    or (deposit_mode = 'fixed' and deposit_value between 100 and 100000)
    or (deposit_mode = 'percent' and deposit_value between 1 and 100)
  );

comment on column public.services.deposit_mode is
  'P5.4: default (the garage default in payment_settings), none, fixed (deposit_value pence) or percent (deposit_value % of price_pence). Changing it needs Pro.';

-- Members may edit services on any plan; the deposit columns need Pro. The
-- service role (seeding, imports) is not checked.
create function public.services_deposit_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.deposit_mode = 'default' and new.deposit_value is null then
      return new;
    end if;
  elsif new.deposit_mode is not distinct from old.deposit_mode and new.deposit_value is not distinct from old.deposit_value then
    return new;
  end if;
  perform public.require_garage_feature(new.garage_id, 'payments');
  return new;
end
$$;

create trigger services_deposit_plan_guard before insert or update of deposit_mode, deposit_value on public.services
  for each row execute function public.services_deposit_plan_guard();

-- ---------------------------------------------------------------------------
-- 2. Payment accounts
-- ---------------------------------------------------------------------------

create table public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  provider text not null,
  account_ref text not null,
  status text not null default 'pending',
  charges_enabled boolean not null default false,
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_accounts_garage_key unique (garage_id),
  constraint payment_accounts_provider_check check (provider in ('mock', 'stripe')),
  constraint payment_accounts_status_check check (status in ('pending', 'active', 'restricted', 'disconnected')),
  constraint payment_accounts_account_ref_check check (char_length(account_ref) between 1 and 255),
  constraint payment_accounts_active_check check (status <> 'active' or charges_enabled)
);

comment on table public.payment_accounts is
  'P5.4: the garage''s own payment account (Stripe Connect test mode, or the mock). Written by apply_payment_account() (service role) and disconnect_payment_account() (owners).';

create index payment_accounts_ref_idx on public.payment_accounts (provider, account_ref);
create trigger payment_accounts_updated before update on public.payment_accounts
  for each row execute function public.set_updated_at();

alter table public.payment_accounts enable row level security;

-- payment_accounts
--   "owners and managers read the payment account"  select  owners/managers of the selected garage
--   (no write policies: apply_payment_account() with the service role; disconnect_payment_account() for owners)
create policy "owners and managers read the payment account" on public.payment_accounts
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

revoke all on public.payment_accounts from anon, authenticated;
grant select on public.payment_accounts to authenticated;
grant select, insert, update on public.payment_accounts to service_role;

-- ---------------------------------------------------------------------------
-- 3. Payment settings
-- ---------------------------------------------------------------------------

create table public.payment_settings (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  deposits_enabled boolean not null default false,
  default_deposit_mode text not null default 'none',
  default_deposit_value integer,
  deposit_hold_min integer not null default 30,
  no_show_fee_pence integer,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_settings_garage_key unique (garage_id),
  constraint payment_settings_default_mode_check check (default_deposit_mode in ('none', 'fixed', 'percent')),
  constraint payment_settings_default_value_check check (
    (default_deposit_mode = 'none' and default_deposit_value is null)
    or (default_deposit_mode = 'fixed' and default_deposit_value between 100 and 100000)
    or (default_deposit_mode = 'percent' and default_deposit_value between 1 and 100)
  ),
  constraint payment_settings_hold_check check (deposit_hold_min between 30 and 180),
  constraint payment_settings_no_show_fee_check check (no_show_fee_pence is null or no_show_fee_pence between 100 and 100000)
);

comment on table public.payment_settings is
  'P5.4: deposits on/off, the default deposit, how long an unpaid deposit holds the slot, and the no-show fee. Owners and managers change it on Pro.';

create trigger payment_settings_updated before update on public.payment_settings
  for each row execute function public.set_updated_at();

alter table public.payment_settings enable row level security;

-- payment_settings
--   "garage members read payment settings"            select  members of the selected garage
--   "owners and managers add payment settings"        insert  owners/managers of the selected garage, Pro (payments)
--   "owners and managers change payment settings"     update  owners/managers of the selected garage, Pro (payments)
--   no delete
create policy "garage members read payment settings" on public.payment_settings
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add payment settings" on public.payment_settings
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'payments')
  );
create policy "owners and managers change payment settings" on public.payment_settings
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (
    garage_id = (select public.current_garage_id())
    and (select public.current_garage_role()) in ('owner', 'manager')
    and public.garage_has_feature(garage_id, 'payments')
  );

revoke all on public.payment_settings from anon, authenticated;
grant select, insert, update on public.payment_settings to authenticated;
grant select, insert, update on public.payment_settings to service_role;

-- ---------------------------------------------------------------------------
-- 4. Payments
-- ---------------------------------------------------------------------------

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  kind text not null,
  status text not null default 'pending',
  amount_pence integer not null,
  currency text not null default 'GBP',
  description text not null,
  booking_id uuid,
  invoice_id uuid,
  customer_id uuid,
  token_hash text not null,
  expires_at timestamptz not null,
  provider text not null,
  checkout_ref text,
  provider_payment_ref text,
  amount_paid_pence integer,
  paid_at timestamptz,
  attention text,
  cancelled_reason text,
  notified_at timestamptz,
  notify_channel text,
  notify_outcome text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_garage_id_id_key unique (garage_id, id),
  constraint payments_token_hash_key unique (token_hash),
  constraint payments_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete set null (booking_id),
  constraint payments_invoice_id_fkey foreign key (garage_id, invoice_id)
    references public.invoices (garage_id, id) on delete set null (invoice_id),
  constraint payments_customer_id_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id) on delete set null (customer_id),
  constraint payments_kind_check check (kind in ('deposit', 'invoice', 'no_show_fee')),
  constraint payments_status_check check (status in ('pending', 'paid', 'expired', 'cancelled', 'failed')),
  constraint payments_amount_check check (amount_pence between 100 and 10000000),
  constraint payments_currency_check check (currency = 'GBP'),
  constraint payments_description_check check (char_length(description) between 1 and 200),
  constraint payments_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint payments_provider_check check (provider in ('mock', 'stripe')),
  constraint payments_refs_check check (
    char_length(coalesce(checkout_ref, '')) <= 255 and char_length(coalesce(provider_payment_ref, '')) <= 255
  ),
  constraint payments_paid_check check ((status = 'paid') = (paid_at is not null)),
  constraint payments_amount_paid_check check (amount_paid_pence is null or amount_paid_pence between 0 and 10000000),
  constraint payments_attention_check check (
    attention is null or attention in ('paid_after_release', 'invoice_not_open', 'overpaid', 'amount_mismatch')
  ),
  constraint payments_cancelled_reason_check check (cancelled_reason is null or char_length(cancelled_reason) <= 200),
  constraint payments_notify_channel_check check (notify_channel is null or notify_channel in ('sms', 'whatsapp', 'email', 'none')),
  constraint payments_notify_outcome_check check (notify_outcome is null or char_length(notify_outcome) <= 60)
);

comment on table public.payments is
  'P5.4: deposits, invoice payment links and no-show fees asked of customers. Only the SHA-256 of the pay-link token is stored. Written only by the payments functions.';

-- One live deposit and one live no-show fee per booking.
create unique index payments_one_live_per_booking on public.payments (garage_id, booking_id, kind)
  where status in ('pending', 'paid') and kind in ('deposit', 'no_show_fee') and booking_id is not null;
create index payments_garage_created_idx on public.payments (garage_id, created_at desc);
create index payments_garage_booking_idx on public.payments (garage_id, booking_id) where booking_id is not null;
create index payments_garage_invoice_idx on public.payments (garage_id, invoice_id) where invoice_id is not null;
create index payments_garage_customer_idx on public.payments (garage_id, customer_id) where customer_id is not null;
create index payments_pending_expiry_idx on public.payments (expires_at) where status = 'pending';
create index payments_checkout_ref_idx on public.payments (provider, checkout_ref) where checkout_ref is not null;
create index payments_created_by_idx on public.payments (created_by) where created_by is not null;

create trigger payments_updated before update on public.payments
  for each row execute function public.set_updated_at();

alter table public.payments enable row level security;

-- payments
--   "garage members read payments"  select  members of the selected garage (not plan-checked: readable after a downgrade)
--   (no write policies: create_payment_request(), create_deposit_payment(), apply_payment_paid(),
--    cancel_payment_request(), expire_pending_deposits() and the booking-status trigger write it)
create policy "garage members read payments" on public.payments
  for select to authenticated using (garage_id = (select public.current_garage_id()));

revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;
grant select, insert, update on public.payments to service_role;

-- ---------------------------------------------------------------------------
-- 5. Provider webhook events (platform table, ids only)
-- ---------------------------------------------------------------------------

create table public.payment_webhook_events (
  event_id text primary key,
  provider text not null,
  type text not null,
  target_garage_id uuid references public.garages(id) on delete set null,
  outcome text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint payment_webhook_events_provider_check check (provider in ('mock', 'stripe')),
  constraint payment_webhook_events_event_id_check check (char_length(event_id) between 1 and 255),
  constraint payment_webhook_events_type_check check (char_length(type) between 1 and 120)
);

comment on table public.payment_webhook_events is
  'P5.4 platform table: payment provider webhook events claimed by claim_payment_webhook_event(). Ids, types and outcomes only. Service role only.';

alter table public.payment_webhook_events enable row level security;
revoke all on public.payment_webhook_events from anon, authenticated;
grant select, insert, update on public.payment_webhook_events to service_role;

create function public.claim_payment_webhook_event(p_event_id text, p_provider text, p_type text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inserted text;
begin
  insert into public.payment_webhook_events (event_id, provider, type)
  values (p_event_id, p_provider, left(p_type, 120))
  on conflict (event_id) do update
    set received_at = now()
    where public.payment_webhook_events.processed_at is null
      and public.payment_webhook_events.received_at < now() - interval '5 minutes'
  returning event_id into inserted;
  return inserted is not null;
end
$$;

create function public.finish_payment_webhook_event(p_event_id text, p_garage_id uuid, p_outcome text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.payment_webhook_events
  set processed_at = now(), target_garage_id = p_garage_id, outcome = left(p_outcome, 120)
  where event_id = p_event_id
$$;

-- ---------------------------------------------------------------------------
-- 6. Accounts
-- ---------------------------------------------------------------------------

-- Stores the provider's view of the garage's account. p_actor is the owner
-- who connected it (null from a webhook); a connect by a member needs Pro, a
-- status update from the provider does not.
create function public.apply_payment_account(
  p_garage_id uuid,
  p_provider text,
  p_account_ref text,
  p_status text,
  p_charges_enabled boolean,
  p_actor uuid default null
)
returns public.payment_accounts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result public.payment_accounts;
begin
  if not exists (select 1 from public.garages where id = p_garage_id) then
    raise exception 'GARAGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_actor is not null then
    perform public.require_garage_feature(p_garage_id, 'payments');
  else
    -- A provider update applies only to the account the garage holds.
    if not exists (
      select 1 from public.payment_accounts account
      where account.garage_id = p_garage_id and account.provider = p_provider and account.account_ref = p_account_ref
    ) then
      raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001';
    end if;
  end if;

  insert into public.payment_accounts as existing
    (garage_id, provider, account_ref, status, charges_enabled, connected_by, connected_at, disconnected_at)
  values (p_garage_id, p_provider, p_account_ref, p_status, coalesce(p_charges_enabled, false), p_actor,
          case when p_status = 'active' then now() end, null)
  on conflict (garage_id) do update
    set provider = excluded.provider,
        account_ref = excluded.account_ref,
        status = case
          -- A webhook never reconnects an account the owner disconnected.
          when p_actor is null and existing.status = 'disconnected' then 'disconnected'
          else excluded.status
        end,
        charges_enabled = case when p_actor is null and existing.status = 'disconnected' then false else excluded.charges_enabled end,
        connected_by = coalesce(excluded.connected_by, existing.connected_by),
        connected_at = case when excluded.status = 'active' and existing.status <> 'active' then now() else existing.connected_at end,
        disconnected_at = case when p_actor is not null then null else existing.disconnected_at end
  returning * into result;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (p_garage_id, p_actor, 'payments.account_' || result.status, 'payment_account', result.id::text,
          jsonb_build_object('provider', p_provider, 'charges_enabled', result.charges_enabled));
  return result;
end
$$;

comment on function public.apply_payment_account(uuid, text, text, text, boolean, uuid) is
  'P5.4: stores the garage''s payment account state. Service role only: the owner''s connect (p_actor set, needs Pro) or the provider''s signed webhook (p_actor null, only for the account the garage holds; never reconnects a disconnected account).';

-- The owner disconnects the account: no new deposits or links. Not plan
-- gated, so an Essentials garage can still disconnect.
create function public.disconnect_payment_account()
returns public.payment_accounts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  result public.payment_accounts;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() is distinct from 'owner' then
    raise exception 'PAYMENTS_FORBIDDEN: only the garage owner can disconnect payments' using errcode = '42501';
  end if;
  update public.payment_accounts account
  set status = 'disconnected', charges_enabled = false, disconnected_at = now()
  where account.garage_id = target_garage
  returning * into result;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'payments.account_disconnected', 'payment_account', result.id::text, '{}'::jsonb);
  return result;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Deposits
-- ---------------------------------------------------------------------------

-- The deposit for a service at this garage, in pence, or null for none.
-- Percent of a quote-priced (or free) service is none.
create function public.payment_deposit_amount(p_garage_id uuid, p_service_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  settings public.payment_settings;
  service public.services;
  mode text;
  value integer;
  amount integer;
begin
  select * into settings from public.payment_settings where garage_id = p_garage_id;
  if not found or not settings.deposits_enabled then
    return null;
  end if;
  select * into service from public.services where garage_id = p_garage_id and id = p_service_id;
  if not found then
    return null;
  end if;
  if service.deposit_mode = 'default' then
    mode := settings.default_deposit_mode;
    value := settings.default_deposit_value;
  else
    mode := service.deposit_mode;
    value := service.deposit_value;
  end if;
  if mode = 'fixed' then
    amount := value;
  elsif mode = 'percent' and service.price_mode <> 'quote' and coalesce(service.price_pence, 0) > 0 then
    amount := round(service.price_pence * value / 100.0)::integer;
  else
    return null;
  end if;
  if amount is null or amount < 100 then
    return null;
  end if;
  return least(amount, 100000);
end
$$;

comment on function public.payment_deposit_amount(uuid, uuid) is
  'P5.4: the deposit (pence) for a service, from the service''s deposit_mode or the garage default; null when deposits are off, for percent of a quote, or under 100p. Service role.';

-- Adds the pending deposit for a booking create_booking() has just made.
-- Returns null when no deposit applies (no Pro, no active account for this
-- provider, deposits off, nothing for this service, booking not holding a
-- slot). A replay for the same booking rotates the link token and returns
-- the existing deposit.
create function public.create_deposit_payment(p_garage_id uuid, p_booking_id uuid, p_provider text, p_token_hash text)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  booking public.bookings;
  settings public.payment_settings;
  amount integer;
  service_name text;
  result public.payments;
begin
  if not public.garage_has_feature(p_garage_id, 'payments') then
    return null;
  end if;
  if not exists (
    select 1 from public.payment_accounts account
    where account.garage_id = p_garage_id and account.provider = p_provider and account.status = 'active'
  ) then
    return null;
  end if;
  select * into booking from public.bookings where garage_id = p_garage_id and id = p_booking_id for update;
  if not found or booking.status not in ('requested', 'confirmed') or booking.deleted_at is not null then
    return null;
  end if;

  select * into result from public.payments existing
  where existing.garage_id = p_garage_id and existing.booking_id = p_booking_id
    and existing.kind = 'deposit' and existing.status in ('pending', 'paid')
  for update;
  if found then
    if result.status = 'pending' then
      update public.payments set token_hash = p_token_hash where id = result.id returning * into result;
    end if;
    return result;
  end if;

  amount := public.payment_deposit_amount(p_garage_id, booking.service_id);
  if amount is null then
    return null;
  end if;
  select * into settings from public.payment_settings where garage_id = p_garage_id;
  select name into service_name from public.services where garage_id = p_garage_id and id = booking.service_id;

  insert into public.payments (garage_id, kind, amount_pence, description, booking_id, customer_id, token_hash, expires_at, provider)
  values (p_garage_id, 'deposit', amount, left('Deposit for ' || coalesce(service_name, 'your booking') || ', ' || booking.reference, 200),
          booking.id, booking.customer_id, p_token_hash, now() + make_interval(mins => settings.deposit_hold_min), p_provider)
  returning * into result;

  insert into public.booking_events (garage_id, booking_id, type, actor, data)
  values (p_garage_id, booking.id, 'note', 'system',
          jsonb_build_object('text', 'Waiting for the deposit', 'payment_id', result.id, 'amount_pence', amount));
  return result;
end
$$;

comment on function public.create_deposit_payment(uuid, uuid, text, text) is
  'P5.4: the pending deposit for a booking just made by create_booking(); null when none applies. Service role (the online booking flow on the garage host).';

-- Cancels unpaid deposits (and lapsed links) whose time is up. A deposit's
-- booking, while still requested or confirmed, is cancelled through the
-- normal status update, which frees the slot (no_overlap ignores cancelled
-- bookings) and logs a system status change. Returns what expired so the app
-- can close the provider's checkout.
create function public.expire_pending_deposits(p_now timestamptz default now(), p_garage_id uuid default null)
returns table (payment_id uuid, garage_id uuid, booking_id uuid, kind text, provider text, checkout_ref text, booking_released boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  payment record;
  released boolean;
begin
  for payment in
    select candidate.*
    from public.payments candidate
    where candidate.status = 'pending'
      and candidate.expires_at <= p_now
      and (p_garage_id is null or candidate.garage_id = p_garage_id)
    order by candidate.expires_at, candidate.id
    limit 500
    for update skip locked
  loop
    update public.payments
    set status = 'expired', cancelled_reason = case when payment.kind = 'deposit' then 'Deposit not paid in time' else 'Link expired' end
    where id = payment.id;
    released := false;
    if payment.kind = 'deposit' and payment.booking_id is not null then
      update public.bookings booking
      set status = 'cancelled', cancellation_reason = 'Deposit not paid in time'
      where booking.garage_id = payment.garage_id and booking.id = payment.booking_id
        and booking.status in ('requested', 'confirmed');
      released := found;
    end if;
    payment_id := payment.id;
    garage_id := payment.garage_id;
    booking_id := payment.booking_id;
    kind := payment.kind;
    provider := payment.provider;
    checkout_ref := payment.checkout_ref;
    booking_released := released;
    return next;
  end loop;
end
$$;

comment on function public.expire_pending_deposits(timestamptz, uuid) is
  'P5.4 job payments.expire_deposits (and the booking flow, per garage): expires pending payments past expires_at; an unpaid deposit cancels its still-open booking ("Deposit not paid in time"), freeing the slot. Service role.';

-- Staff cancel a booking that is waiting for its deposit: the deposit goes
-- with it, so the customer's link stops working.
create function public.payments_follow_booking_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update public.payments
    set status = 'cancelled', cancelled_reason = 'Booking cancelled'
    where garage_id = new.garage_id and booking_id = new.id and kind = 'deposit' and status = 'pending';
  end if;
  return null;
end
$$;

create trigger bookings_payments_follow_status after update of status on public.bookings
  for each row execute function public.payments_follow_booking_status();

-- ---------------------------------------------------------------------------
-- 8. Payment links (staff)
-- ---------------------------------------------------------------------------

-- Owners, managers and front desk of the selected garage ask a customer to
-- pay an issued invoice's balance or the garage's no-show fee for a no-show
-- booking. A new invoice link replaces the open one; asking again for a
-- no-show fee re-issues its link. Links last 14 days.
create function public.create_payment_request(p_kind text, p_target_id uuid, p_provider text, p_token_hash text)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  actor uuid := auth.uid();
  invoice public.invoices;
  booking public.bookings;
  settings public.payment_settings;
  already_paid bigint;
  balance bigint;
  result public.payments;
begin
  if not coalesce(public.garage_actor_allowed(), false)
     or coalesce(public.current_garage_role(), '') not in ('owner', 'manager', 'front_desk') then
    raise exception 'PAYMENTS_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'payments');
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TOKEN' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.payment_accounts account
    where account.garage_id = target_garage and account.provider = p_provider and account.status = 'active'
  ) then
    raise exception 'PAYMENTS_NOT_CONNECTED' using errcode = 'P0001';
  end if;

  if p_kind = 'invoice' then
    select * into invoice from public.invoices
    where garage_id = target_garage and id = p_target_id and status = 'issued' and deleted_at is null
    for update;
    if not found then
      raise exception 'ISSUED_INVOICE_NOT_FOUND' using errcode = 'P0001';
    end if;
    select coalesce(sum(payment.amount_pence), 0) into already_paid
    from public.invoice_payments payment
    where payment.garage_id = target_garage and payment.invoice_id = invoice.id;
    balance := invoice.total_pence - already_paid;
    if balance < 100 or balance > 10000000 then
      raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = 'P0001';
    end if;
    update public.payments existing
    set status = 'cancelled', cancelled_reason = 'Replaced by a new link'
    where existing.garage_id = target_garage and existing.invoice_id = invoice.id and existing.status = 'pending';
    insert into public.payments (garage_id, kind, amount_pence, description, invoice_id, customer_id, token_hash, expires_at, provider, created_by)
    values (target_garage, 'invoice', balance::integer, left('Invoice ' || invoice.invoice_number, 200), invoice.id, invoice.customer_id,
            p_token_hash, now() + interval '14 days', p_provider, actor)
    returning * into result;
  elsif p_kind = 'no_show_fee' then
    select * into booking from public.bookings
    where garage_id = target_garage and id = p_target_id and deleted_at is null
    for update;
    if not found then
      raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
    end if;
    if booking.status <> 'no_show' then
      raise exception 'BOOKING_NOT_NO_SHOW' using errcode = 'P0001';
    end if;
    select * into settings from public.payment_settings where garage_id = target_garage;
    if not found or settings.no_show_fee_pence is null then
      raise exception 'NO_SHOW_FEE_NOT_SET' using errcode = 'P0001';
    end if;
    select * into result from public.payments existing
    where existing.garage_id = target_garage and existing.booking_id = booking.id
      and existing.kind = 'no_show_fee' and existing.status in ('pending', 'paid')
    for update;
    if found then
      if result.status = 'paid' then
        raise exception 'ALREADY_PAID' using errcode = 'P0001';
      end if;
      update public.payments
      set token_hash = p_token_hash, expires_at = now() + interval '14 days', notified_at = null, notify_channel = null, notify_outcome = null
      where id = result.id
      returning * into result;
    else
      insert into public.payments (garage_id, kind, amount_pence, description, booking_id, customer_id, token_hash, expires_at, provider, created_by)
      values (target_garage, 'no_show_fee', settings.no_show_fee_pence, left('Missed appointment fee, booking ' || booking.reference, 200),
              booking.id, booking.customer_id, p_token_hash, now() + interval '14 days', p_provider, actor)
      returning * into result;
    end if;
  else
    raise exception 'INVALID_PAYMENT_KIND' using errcode = '22023';
  end if;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, actor, 'payments.link_created', 'payment', result.id::text,
          jsonb_build_object('kind', result.kind, 'amount_pence', result.amount_pence));
  return result;
end
$$;

comment on function public.create_payment_request(text, uuid, text, text) is
  'P5.4: owners, managers and front desk of the selected garage create a pay link for an issued invoice''s balance (p_kind invoice) or the no-show fee of a no-show booking (no_show_fee). Needs Pro and a connected account. Audited.';

-- Staff cancel a pending link (or waive a pending deposit: the booking then
-- stands without one).
create function public.cancel_payment_request(p_payment_id uuid)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  result public.payments;
begin
  if not coalesce(public.garage_actor_allowed(), false)
     or coalesce(public.current_garage_role(), '') not in ('owner', 'manager', 'front_desk') then
    raise exception 'PAYMENTS_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'payments');
  update public.payments payment
  set status = 'cancelled', cancelled_reason = case when payment.kind = 'deposit' then 'Deposit waived by the garage' else 'Cancelled by the garage' end
  where payment.garage_id = target_garage and payment.id = p_payment_id and payment.status = 'pending'
  returning * into result;
  if not found then
    raise exception 'PENDING_PAYMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'payments.link_cancelled', 'payment', result.id::text, jsonb_build_object('kind', result.kind));
  return result;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Paid
-- ---------------------------------------------------------------------------

-- Records the provider's checkout for a pending payment (service role).
create function public.set_payment_checkout(p_garage_id uuid, p_payment_id uuid, p_checkout_ref text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with changed as (
    update public.payments
    set checkout_ref = left(p_checkout_ref, 255)
    where garage_id = p_garage_id and id = p_payment_id and status = 'pending'
    returning 1
  )
  select exists (select 1 from changed)
$$;

-- Marks a payment paid, once. An invoice payment is recorded against the
-- invoice in invoice_payments (method card), making it paid when the
-- balance reaches zero; more than the balance is recorded up to the balance
-- and flagged overpaid. A deposit paid after its booking was released is
-- flagged paid_after_release. Returns {kind, status, already, attention,
-- booking_id, invoice_id, invoice_status}.
create function public.apply_payment_paid(
  p_garage_id uuid,
  p_payment_id uuid,
  p_provider text,
  p_provider_payment_ref text,
  p_amount_pence integer,
  p_paid_at timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  payment public.payments;
  invoice public.invoices;
  booking_status text;
  flag text;
  already_paid bigint;
  outstanding bigint;
  recorded bigint;
  actor uuid;
  v_paid_at timestamptz := coalesce(p_paid_at, now());
  invoice_status text;
begin
  select * into payment from public.payments where garage_id = p_garage_id and id = p_payment_id for update;
  if not found then
    raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if payment.provider is distinct from p_provider then
    raise exception 'PAYMENT_PROVIDER_MISMATCH' using errcode = 'P0001';
  end if;
  if payment.status = 'paid' then
    return jsonb_build_object('kind', payment.kind, 'status', 'paid', 'already', true, 'attention', payment.attention,
                              'booking_id', payment.booking_id, 'invoice_id', payment.invoice_id);
  end if;
  if p_amount_pence is not null and p_amount_pence <> payment.amount_pence then
    flag := 'amount_mismatch';
  end if;

  if payment.kind = 'deposit' and payment.booking_id is not null then
    select status into booking_status from public.bookings where garage_id = p_garage_id and id = payment.booking_id;
    if payment.status <> 'pending' or coalesce(booking_status, 'cancelled') not in ('requested', 'confirmed', 'arrived', 'in_progress', 'waiting_parts', 'ready', 'collected') then
      flag := 'paid_after_release';
    end if;
  elsif payment.kind = 'invoice' then
    select * into invoice from public.invoices where garage_id = p_garage_id and id = payment.invoice_id for update;
    if not found or invoice.status <> 'issued' then
      flag := 'invoice_not_open';
    else
      select coalesce(sum(earlier.amount_pence), 0) into already_paid
      from public.invoice_payments earlier where earlier.garage_id = p_garage_id and earlier.invoice_id = invoice.id;
      outstanding := invoice.total_pence - already_paid;
      recorded := least(coalesce(p_amount_pence, payment.amount_pence)::bigint, outstanding);
      if coalesce(p_amount_pence, payment.amount_pence) > outstanding then
        flag := 'overpaid';
      end if;
      actor := coalesce(payment.created_by, invoice.updated_by, invoice.created_by);
      if recorded > 0 then
        insert into public.invoice_payments (garage_id, invoice_id, amount_pence, paid_at, payment_method, payment_reference, created_by)
        values (p_garage_id, invoice.id, recorded, v_paid_at, 'card', left('Paid online (' || payment.provider || ') ' || payment.id::text, 200), actor);
        if recorded = outstanding then
          update public.invoices
          set status = 'paid', paid_at = v_paid_at, payment_method = 'card',
              payment_reference = left('Paid online ' || payment.id::text, 200), updated_by = actor
          where garage_id = p_garage_id and id = invoice.id and status = 'issued';
        end if;
        insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
        values (p_garage_id, null,
                case when recorded = outstanding then 'invoice.marked_paid' else 'invoice.part_payment_recorded' end,
                'invoice', invoice.id::text,
                jsonb_build_object('amountPence', recorded, 'amountPaidPence', already_paid + recorded,
                                   'balancePence', outstanding - recorded, 'method', 'card', 'paidAt', v_paid_at,
                                   'online', true, 'paymentId', payment.id));
      end if;
      select status::text into invoice_status from public.invoices where garage_id = p_garage_id and id = invoice.id;
    end if;
  end if;

  update public.payments
  set status = 'paid', paid_at = v_paid_at, amount_paid_pence = coalesce(p_amount_pence, payment.amount_pence),
      provider_payment_ref = left(coalesce(p_provider_payment_ref, provider_payment_ref), 255),
      attention = flag, cancelled_reason = null
  where id = payment.id
  returning * into payment;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (p_garage_id, null, 'payments.paid', 'payment', payment.id::text,
          jsonb_build_object('kind', payment.kind, 'amount_pence', payment.amount_paid_pence, 'attention', flag));
  if payment.kind = 'deposit' and payment.booking_id is not null then
    insert into public.booking_events (garage_id, booking_id, type, actor, data)
    values (p_garage_id, payment.booking_id, 'note', 'system',
            jsonb_build_object('text', case when flag = 'paid_after_release' then 'Deposit paid after the slot was released: refund or rebook' else 'Deposit paid' end,
                               'payment_id', payment.id, 'amount_pence', payment.amount_paid_pence));
  end if;

  return jsonb_build_object('kind', payment.kind, 'status', 'paid', 'already', false, 'attention', flag,
                            'booking_id', payment.booking_id, 'invoice_id', payment.invoice_id, 'invoice_status', invoice_status);
end
$$;

comment on function public.apply_payment_paid(uuid, uuid, text, text, integer, timestamptz) is
  'P5.4: marks a payment paid once (signed provider webhook, the provider''s return check, or the mock pay page). Invoice payments land in invoice_payments (card). Service role.';

-- ---------------------------------------------------------------------------
-- 10. Per-service deposits (owners and managers, Pro)
-- ---------------------------------------------------------------------------

create function public.set_service_deposit(p_service_id uuid, p_mode text, p_value integer)
returns public.services
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  result public.services;
begin
  if not coalesce(public.garage_actor_allowed(), false)
     or coalesce(public.current_garage_role(), '') not in ('owner', 'manager') then
    raise exception 'PAYMENTS_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'payments');
  if p_mode is null or p_mode not in ('default', 'none', 'fixed', 'percent') then
    raise exception 'INVALID_DEPOSIT' using errcode = '22023';
  end if;
  update public.services
  set deposit_mode = p_mode, deposit_value = case when p_mode in ('fixed', 'percent') then p_value end
  where garage_id = target_garage and id = p_service_id and deleted_at is null
  returning * into result;
  if not found then
    raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target_garage, auth.uid(), 'service.deposit_changed', 'service', result.id::text,
          jsonb_build_object('mode', result.deposit_mode, 'value', result.deposit_value));
  return result;
end
$$;

-- ---------------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.services_deposit_plan_guard() from public, anon, authenticated;
revoke all on function public.payments_follow_booking_status() from public, anon, authenticated;
revoke all on function public.claim_payment_webhook_event(text, text, text) from public, anon, authenticated;
revoke all on function public.finish_payment_webhook_event(text, uuid, text) from public, anon, authenticated;
revoke all on function public.apply_payment_account(uuid, text, text, text, boolean, uuid) from public, anon, authenticated;
revoke all on function public.disconnect_payment_account() from public, anon;
revoke all on function public.payment_deposit_amount(uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_deposit_payment(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.expire_pending_deposits(timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.create_payment_request(text, uuid, text, text) from public, anon;
revoke all on function public.cancel_payment_request(uuid) from public, anon;
revoke all on function public.set_payment_checkout(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.apply_payment_paid(uuid, uuid, text, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.set_service_deposit(uuid, text, integer) from public, anon;

grant execute on function public.claim_payment_webhook_event(text, text, text) to service_role;
grant execute on function public.finish_payment_webhook_event(text, uuid, text) to service_role;
grant execute on function public.apply_payment_account(uuid, text, text, text, boolean, uuid) to service_role;
grant execute on function public.disconnect_payment_account() to authenticated;
grant execute on function public.payment_deposit_amount(uuid, uuid) to service_role;
grant execute on function public.create_deposit_payment(uuid, uuid, text, text) to service_role;
grant execute on function public.expire_pending_deposits(timestamptz, uuid) to service_role;
grant execute on function public.create_payment_request(text, uuid, text, text) to authenticated;
grant execute on function public.cancel_payment_request(uuid) to authenticated;
grant execute on function public.set_payment_checkout(uuid, uuid, text) to service_role;
grant execute on function public.apply_payment_paid(uuid, uuid, text, text, integer, timestamptz) to service_role;
grant execute on function public.set_service_deposit(uuid, text, integer) to authenticated;
