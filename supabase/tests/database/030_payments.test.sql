begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(69);

-- P5.4 payments: payment_accounts, payment_settings, payments,
-- payment_webhook_events, services.deposit_*; apply_payment_account(),
-- disconnect_payment_account(), payment_deposit_amount(),
-- create_deposit_payment(), expire_pending_deposits(),
-- create_payment_request(), cancel_payment_request(), apply_payment_paid(),
-- set_service_deposit(), the services deposit plan guard and the booking
-- status trigger.
--
-- Garage P is on paid Pro with ONE bay (owner Polly, manager Max, technician
-- Tess, front desk Fran). Garage E is on Essentials (owner Ed). Garage Q is
-- another Pro garage (owner Quinn) for cross-garage checks. Bookings are made
-- through create_booking_at() with "now" = Wed 28 Oct 2026 12:00 UTC.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('13000000-0000-4000-8000-0000000000a1', 'pay-owner@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000a2', 'pay-manager@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000a3', 'pay-tech@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000a4', 'pay-desk@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000e1', 'pay-ess@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000c1', 'pay-other@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen) values
  ('a1300000-0000-4000-8000-000000000001', 'pgtap-pay-p', 'Pay Pro', 'PYP', 'active', 'pro', null, 'pro'),
  ('a1300000-0000-4000-8000-000000000002', 'pgtap-pay-e', 'Pay Essentials', 'PYE', 'active', 'essentials', null, 'essentials'),
  ('a1300000-0000-4000-8000-000000000003', 'pgtap-pay-q', 'Pay Other', 'PYQ', 'active', 'pro', null, 'pro');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a2', 'manager'),
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a3', 'technician'),
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a4', 'front_desk'),
  ('a1300000-0000-4000-8000-000000000002', '13000000-0000-4000-8000-0000000000e1', 'owner'),
  ('a1300000-0000-4000-8000-000000000003', '13000000-0000-4000-8000-0000000000c1', 'owner');

insert into public.opening_hours (garage_id, weekday, opens, closes)
select garage::uuid, weekday::smallint, time '08:00', time '17:30'
from unnest(array['a1300000-0000-4000-8000-000000000001', 'a1300000-0000-4000-8000-000000000002']) garage, generate_series(1, 7) weekday;
insert into public.resources (id, garage_id, name, kind, sort) values
  ('a1300000-0000-4000-8000-000000000101', 'a1300000-0000-4000-8000-000000000001', 'Only bay', 'bay', 1),
  ('a1300000-0000-4000-8000-000000000102', 'a1300000-0000-4000-8000-000000000002', 'E bay', 'bay', 1);
insert into public.services (id, garage_id, name, duration_min, buffer_min, price_pence, price_mode, location_mode, resource_kind) values
  ('a1300000-0000-4000-8000-000000000201', 'a1300000-0000-4000-8000-000000000001', 'Service', 60, 0, 5000, 'fixed', 'workshop', 'bay'),
  ('a1300000-0000-4000-8000-000000000202', 'a1300000-0000-4000-8000-000000000001', 'Quote job', 60, 0, null, 'quote', 'workshop', 'bay'),
  ('a1300000-0000-4000-8000-000000000203', 'a1300000-0000-4000-8000-000000000002', 'E service', 60, 0, 5000, 'fixed', 'workshop', 'bay');

create function pg_temp.p() returns uuid language sql as $$ select 'a1300000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a1300000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.q() returns uuid language sql as $$ select 'a1300000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.svc() returns uuid language sql as $$ select 'a1300000-0000-4000-8000-000000000201'::uuid $$;
create function pg_temp.hash(p_seed text) returns text language sql as $$ select encode(extensions.digest(p_seed, 'sha256'), 'hex') $$;
create function pg_temp.as_member(p_user text, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;
create function pg_temp.payload(p_service uuid, p_start text, p_key integer, p_phone text) returns jsonb language sql as $$
  select jsonb_build_object(
    'service_id', p_service, 'starts_at', p_start, 'location_mode', 'workshop', 'source', 'online',
    'idempotency_key', 'c1300000-0000-4000-8000-' || lpad(p_key::text, 12, '0'),
    'customer', jsonb_build_object('name', 'Deposit Dee', 'phone', p_phone, 'channel', 'sms'),
    'vehicle', jsonb_build_object('registration', 'PY' || p_key || 'AAA'))
$$;
create function pg_temp.book(p_garage uuid, p_service uuid, p_start text, p_key integer, p_phone text default '+447700900301') returns uuid language sql as $$
  select (public.create_booking_at(p_garage, pg_temp.payload(p_service, p_start, p_key, p_phone), '2026-10-28 12:00+00') ->> 'booking_id')::uuid
$$;
create function pg_temp.book_error(p_garage uuid, p_service uuid, p_start text, p_key integer) returns text language plpgsql as $$
begin
  perform public.create_booking_at(p_garage, pg_temp.payload(p_service, p_start, p_key, '+447700900302'), '2026-10-28 12:00+00');
  return 'no error';
exception when others then
  return sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end
$$;
-- Service role through the JWT (create_booking_at() is not granted to API roles, so the bookings are made as the test owner).
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true), set_config('request.headers', '{}', true);
$$;
create temp table ids (label text primary key, id uuid);
grant all on ids to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from unnest(array['payment_accounts', 'payment_settings', 'payments', 'payment_webhook_events']) t(name)
           join pg_class rel on rel.relname = t.name and rel.relnamespace = 'public'::regnamespace where rel.relrowsecurity),
          4, 'every payments table has RLS on');
select is((select count(*)::integer from unnest(array['payment_accounts', 'payments']) t(name)
           where has_table_privilege('authenticated', 'public.' || t.name, 'insert')
              or has_table_privilege('authenticated', 'public.' || t.name, 'update')
              or has_table_privilege('authenticated', 'public.' || t.name, 'delete')), 0, 'staff write accounts and payments only through functions');
select is((select count(*)::integer from unnest(array['payment_accounts', 'payment_settings', 'payments', 'payment_webhook_events']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select')), 0, 'anon reads none of them');
select is(has_table_privilege('authenticated', 'public.payment_webhook_events', 'select'), false, 'webhook events are service role only');
select is((select count(*)::integer from unnest(array[
             'public.apply_payment_account(uuid, text, text, text, boolean, uuid)', 'public.create_deposit_payment(uuid, uuid, text, text)',
             'public.expire_pending_deposits(timestamptz, uuid)', 'public.apply_payment_paid(uuid, uuid, text, text, integer, timestamptz)',
             'public.set_payment_checkout(uuid, uuid, text)', 'public.payment_deposit_amount(uuid, uuid)',
             'public.claim_payment_webhook_event(text, text, text)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')),
          0, 'provider, deposit and expiry functions are service role only');
select is((select count(*)::integer from unnest(array[
             'public.create_payment_request(text, uuid, text, text)', 'public.cancel_payment_request(uuid)',
             'public.disconnect_payment_account()', 'public.set_service_deposit(uuid, text, integer)']) f(name)
           where has_function_privilege('anon', f.name, 'execute')), 0, 'anon runs none of the staff functions');
select is((select count(*)::integer from pg_proc
           where oid in ('public.create_deposit_payment(uuid, uuid, text, text)'::regprocedure,
                         'public.apply_payment_paid(uuid, uuid, text, text, integer, timestamptz)'::regprocedure,
                         'public.create_payment_request(text, uuid, text, text)'::regprocedure,
                         'public.expire_pending_deposits(timestamptz, uuid)'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 4, 'functions are security definer with an empty search_path');
select is((select column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'services' and column_name = 'deposit_mode'), '''default''::text',
          'services follow the garage deposit by default');

-- ---------------------------------------------------------------------------
-- Settings (owners and managers, Pro)
-- ---------------------------------------------------------------------------

select pg_temp.as_member('13000000-0000-4000-8000-0000000000a3', pg_temp.p());
set local role authenticated;
select throws_ok($$insert into public.payment_settings (deposits_enabled) values (true)$$, '42501', null,
                 'a technician cannot add payment settings');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select lives_ok($$insert into public.payment_settings (deposits_enabled, default_deposit_mode, default_deposit_value, no_show_fee_pence)
                  values (true, 'fixed', 2000, 2500)$$, 'a manager turns deposits on with a £20 default and a £25 no-show fee');
select throws_ok($$update public.payment_settings set deposit_hold_min = 10$$, '23514', null, 'a hold under 30 minutes is refused');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000e1', pg_temp.e());
set local role authenticated;
select throws_ok($$insert into public.payment_settings (deposits_enabled) values (true)$$, '42501', null,
                 'an Essentials owner cannot turn payments on');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000c1', pg_temp.q());
set local role authenticated;
select is((select count(*)::integer from public.payment_settings), 0, 'another garage''s owner sees none of P''s settings');
update public.payment_settings set no_show_fee_pence = 9999 where garage_id = 'a1300000-0000-4000-8000-000000000001';
reset role;
select is((select no_show_fee_pence from public.payment_settings where garage_id = pg_temp.p()), 2500,
          'and cannot change them');

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

set local role service_role;
select is((public.apply_payment_account(pg_temp.p(), 'mock', 'mock_acct_p', 'active', true, '13000000-0000-4000-8000-0000000000a1')).status,
          'active', 'the owner''s connect stores an active account');
select throws_ok($$select public.apply_payment_account('a1300000-0000-4000-8000-000000000002', 'mock', 'mock_acct_e', 'active', true, '13000000-0000-4000-8000-0000000000e1')$$,
                 'P0001', 'PLAN_REQUIRED: payments', 'an Essentials garage cannot connect');
select throws_ok($$select public.apply_payment_account('a1300000-0000-4000-8000-000000000001', 'stripe', 'acct_forged', 'active', true, null)$$,
                 'P0001', 'ACCOUNT_NOT_FOUND', 'a provider update only applies to the account the garage holds');
-- E connected while it was on Pro, then moved to Essentials.
insert into public.payment_accounts (garage_id, provider, account_ref, status, charges_enabled)
values (pg_temp.e(), 'mock', 'mock_acct_e', 'active', true);
insert into public.payment_settings (garage_id, deposits_enabled, default_deposit_mode, default_deposit_value)
values (pg_temp.e(), true, 'fixed', 2000);
reset role;

select pg_temp.as_member('13000000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select is((select account_ref from public.payment_accounts), 'mock_acct_p', 'managers read the account');
select throws_ok($$select public.disconnect_payment_account()$$, '42501', null, 'a manager cannot disconnect');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000a4', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.payment_accounts), 0, 'front desk does not read the account');
reset role;

-- ---------------------------------------------------------------------------
-- Per-service deposits
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.payment_deposit_amount(pg_temp.p(), pg_temp.svc()), 2000, 'a service follows the garage default (£20)');
select is(public.payment_deposit_amount(pg_temp.p(), 'a1300000-0000-4000-8000-000000000202'), 2000, 'a fixed default applies to a quote job too');
reset role;

select pg_temp.as_member('13000000-0000-4000-8000-0000000000a3', pg_temp.p());
set local role authenticated;
select throws_ok($$select public.set_service_deposit('a1300000-0000-4000-8000-000000000201', 'percent', 20)$$, '42501', null,
                 'a technician cannot set a service deposit');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select is((public.set_service_deposit('a1300000-0000-4000-8000-000000000202', 'percent', 20)).deposit_mode, 'percent',
          'a manager sets 20% on the quote job');
reset role;
set local role service_role;
select is(public.payment_deposit_amount(pg_temp.p(), 'a1300000-0000-4000-8000-000000000202'), null, 'a percentage of a quote is no deposit');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000e1', pg_temp.e());
set local role authenticated;
select throws_ok($$select public.set_service_deposit('a1300000-0000-4000-8000-000000000203', 'fixed', 1000)$$, 'P0001', 'PLAN_REQUIRED: payments',
                 'an Essentials owner cannot set a service deposit');
select throws_ok($$update public.services set deposit_mode = 'fixed', deposit_value = 1000 where id = 'a1300000-0000-4000-8000-000000000203'$$,
                 'P0001', 'PLAN_REQUIRED: payments', 'nor by editing the service directly');
select lives_ok($$update public.services set name = 'E service renamed' where id = 'a1300000-0000-4000-8000-000000000203'$$,
                'other service edits still work on Essentials');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000c1', pg_temp.q());
set local role authenticated;
select throws_ok($$select public.set_service_deposit('a1300000-0000-4000-8000-000000000201', 'fixed', 1000)$$, 'P0001', 'SERVICE_NOT_FOUND',
                 'another garage cannot set P''s deposits');
reset role;

-- ---------------------------------------------------------------------------
-- Deposits never allow a double booking
-- ---------------------------------------------------------------------------

select pg_temp.as_service();
insert into ids values ('b1', pg_temp.book(pg_temp.p(), pg_temp.svc(), '2026-11-04T10:00:00Z', 1));
insert into ids select 'd1', (public.create_deposit_payment(pg_temp.p(), (select id from ids where label = 'b1'), 'mock', pg_temp.hash('d1'))).id;
select is((select status || ':' || amount_pence || ':' || kind from public.payments where id = (select id from ids where label = 'd1')),
          'pending:2000:deposit', 'the booking gets a pending £20 deposit');
select ok((select expires_at between now() + interval '29 minutes' and now() + interval '31 minutes' from public.payments where id = (select id from ids where label = 'd1')),
          'the deposit holds the slot for 30 minutes');
select is((select status from public.bookings where id = (select id from ids where label = 'b1')), 'confirmed',
          'the booking holds the bay while the deposit is pending');
select is(pg_temp.book_error(pg_temp.p(), pg_temp.svc(), '2026-11-04T10:00:00Z', 2), 'P0001 SLOT_UNAVAILABLE',
          'a pending deposit never lets a second booking overlap');
select is(pg_temp.book_error(pg_temp.p(), pg_temp.svc(), '2026-11-04T10:30:00Z', 3), 'P0001 SLOT_UNAVAILABLE',
          'not even a partly overlapping one');
select is((public.create_deposit_payment(pg_temp.p(), (select id from ids where label = 'b1'), 'stripe', pg_temp.hash('x'))).id, null,
          'no deposit on a provider the garage has not connected');
select is((public.create_deposit_payment(pg_temp.p(), (select id from ids where label = 'b1'), 'mock', pg_temp.hash('d1-again'))).id,
          (select id from ids where label = 'd1'), 'a replay returns the same deposit');
select is((select token_hash from public.payments where id = (select id from ids where label = 'd1')), pg_temp.hash('d1-again'),
          'with a fresh link token');
select is((select count(*)::integer from public.expire_pending_deposits(now() + interval '10 minutes', pg_temp.p())), 0,
          'nothing expires before the hold runs out');
select is((select booking_released from public.expire_pending_deposits(now() + interval '31 minutes', pg_temp.p())), true,
          'expiry releases the booking');
select is((select status || ':' || cancellation_reason from public.bookings where id = (select id from ids where label = 'b1')),
          'cancelled:Deposit not paid in time', 'the booking is cancelled with a clear reason');
select is((select status from public.payments where id = (select id from ids where label = 'd1')), 'expired', 'the deposit is expired');
select is((select count(*)::integer from public.booking_events where booking_id = (select id from ids where label = 'b1') and type = 'cancelled' and actor = 'system'),
          1, 'the cancellation is in the booking history as a system change');
insert into ids values ('b2', pg_temp.book(pg_temp.p(), pg_temp.svc(), '2026-11-04T10:00:00Z', 4, '+447700900303'));
select isnt((select id from ids where label = 'b2'), null, 'expiry freed the slot for the next customer');

-- Paid in time.
insert into ids select 'd2', (public.create_deposit_payment(pg_temp.p(), (select id from ids where label = 'b2'), 'mock', pg_temp.hash('d2'))).id;
select is(public.apply_payment_paid(pg_temp.p(), (select id from ids where label = 'd2'), 'mock', 'mock_pi_1', 2000) ->> 'attention', null,
          'paying the deposit marks it paid');
select is(public.apply_payment_paid(pg_temp.p(), (select id from ids where label = 'd2'), 'mock', 'mock_pi_1', 2000) ->> 'already', 'true',
          'a repeated paid event is applied once');
select throws_ok($$select public.apply_payment_paid('a1300000-0000-4000-8000-000000000003', (select id from ids where label = 'd2'), 'mock', 'x', 2000)$$,
                 'P0001', 'PAYMENT_NOT_FOUND', 'a payment is only found in its own garage');
select is((select count(*)::integer from public.expire_pending_deposits(now() + interval '2 hours', pg_temp.p())), 0, 'a paid deposit never expires');
select is((select status from public.bookings where id = (select id from ids where label = 'b2')), 'confirmed', 'and its booking stands');
select is(public.apply_payment_paid(pg_temp.p(), (select id from ids where label = 'd1'), 'mock', 'mock_pi_late', 2000) ->> 'attention',
          'paid_after_release', 'money for a released deposit is flagged for a refund or rebook');

-- Staff cancel a booking that is waiting for its deposit.
insert into ids values ('b3', pg_temp.book(pg_temp.p(), pg_temp.svc(), '2026-11-04T14:00:00Z', 5, '+447700900304'));
insert into ids select 'd3', (public.create_deposit_payment(pg_temp.p(), (select id from ids where label = 'b3'), 'mock', pg_temp.hash('d3'))).id;
update public.bookings set status = 'cancelled' where id = (select id from ids where label = 'b3');
select is((select status from public.payments where id = (select id from ids where label = 'd3')), 'cancelled',
          'cancelling the booking cancels its pending deposit');

-- Essentials: the booking works as before, no deposit.
insert into ids values ('be', pg_temp.book(pg_temp.e(), 'a1300000-0000-4000-8000-000000000203', '2026-11-04T10:00:00Z', 6));
select is((public.create_deposit_payment(pg_temp.e(), (select id from ids where label = 'be'), 'mock', pg_temp.hash('de'))).id, null,
          'an Essentials garage takes no deposit even with an old account and settings');
reset role;

-- ---------------------------------------------------------------------------
-- No-show fees
-- ---------------------------------------------------------------------------

select pg_temp.as_service();
insert into ids values ('b4', pg_temp.book(pg_temp.p(), pg_temp.svc(), '2026-11-05T09:00:00Z', 7, '+447700900305'));
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000a4', pg_temp.p());
set local role authenticated;
select throws_ok($$select public.create_payment_request('no_show_fee', (select id from ids where label = 'b4'), 'mock', repeat('a', 64))$$,
                 'P0001', 'BOOKING_NOT_NO_SHOW', 'a no-show fee needs a no-show booking');
update public.bookings set status = 'no_show' where id = (select id from ids where label = 'b4');
insert into ids select 'f1', (public.create_payment_request('no_show_fee', (select id from ids where label = 'b4'), 'mock', repeat('a', 64))).id;
select is((select amount_pence || ':' || status from public.payments where id = (select id from ids where label = 'f1')), '2500:pending',
          'front desk charges the £25 no-show fee by link');
select is((public.create_payment_request('no_show_fee', (select id from ids where label = 'b4'), 'mock', repeat('b', 64))).id,
          (select id from ids where label = 'f1'), 'asking again re-issues the same request');
select throws_ok($$select public.create_payment_request('no_show_fee', (select id from ids where label = 'b4'), 'mock', 'nothex')$$,
                 '22023', 'INVALID_TOKEN', 'a malformed token hash is refused');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000a3', pg_temp.p());
set local role authenticated;
select throws_ok($$select public.create_payment_request('no_show_fee', (select id from ids where label = 'b4'), 'mock', repeat('c', 64))$$,
                 '42501', null, 'a technician cannot charge customers');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000c1', pg_temp.q());
set local role authenticated;
select is((select count(*)::integer from public.payments), 0, 'another garage sees none of P''s payments');
select throws_ok($$select public.cancel_payment_request((select id from ids where label = 'f1'))$$, 'P0001', 'PENDING_PAYMENT_NOT_FOUND',
                 'and cannot cancel them');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000e1', pg_temp.e());
set local role authenticated;
select throws_ok($$select public.create_payment_request('no_show_fee', (select id from ids where label = 'be'), 'mock', repeat('d', 64))$$,
                 'P0001', 'PLAN_REQUIRED: payments', 'an Essentials garage cannot send payment links');
reset role;

-- ---------------------------------------------------------------------------
-- Pay-by-link invoices
-- ---------------------------------------------------------------------------

insert into public.invoices (id, garage_id, status, source_type, customer_name, issue_date, created_by, updated_by) values
  ('23000000-0000-4000-8000-00000000000a', pg_temp.p(), 'draft', 'manual', 'Link customer', '2026-10-28',
   '13000000-0000-4000-8000-0000000000a1', '13000000-0000-4000-8000-0000000000a1');
insert into public.invoice_items (garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence) values
  (pg_temp.p(), '23000000-0000-4000-8000-00000000000a', 'Work', 1, 10000, 0);
select pg_temp.as_member('13000000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select lives_ok($$select public.issue_invoice('23000000-0000-4000-8000-00000000000a')$$, 'the owner issues a £100 invoice');
select lives_ok($$select public.record_invoice_payment('23000000-0000-4000-8000-00000000000a', 4000, now(), 'cash', 'deposit in cash')$$,
                'and takes £40 in cash');
insert into ids select 'i1', (public.create_payment_request('invoice', '23000000-0000-4000-8000-00000000000a', 'mock', repeat('e', 64))).id;
select is((select amount_pence from public.payments where id = (select id from ids where label = 'i1')), 6000, 'the link asks for the £60 balance');
insert into ids select 'i2', (public.create_payment_request('invoice', '23000000-0000-4000-8000-00000000000a', 'mock', repeat('f', 64))).id;
select is((select status from public.payments where id = (select id from ids where label = 'i1')), 'cancelled', 'a new link replaces the open one');
reset role;
set local role service_role;
select is(public.apply_payment_paid(pg_temp.p(), (select id from ids where label = 'i2'), 'mock', 'mock_pi_inv', 6000) ->> 'invoice_status', 'paid',
          'paying the link settles the invoice');
select is((select sum(amount_pence)::integer || ':' || count(*) from public.invoice_payments where invoice_id = '23000000-0000-4000-8000-00000000000a'),
          '10000:2', 'the online payment is recorded in invoice_payments');
select is((select payment_method from public.invoice_payments where invoice_id = '23000000-0000-4000-8000-00000000000a' and amount_pence = 6000), 'card',
          'as a card payment');
reset role;
select pg_temp.as_member('13000000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select throws_ok($$select public.create_payment_request('invoice', '23000000-0000-4000-8000-00000000000a', 'mock', repeat('9', 64))$$,
                 'P0001', 'ISSUED_INVOICE_NOT_FOUND', 'a paid invoice needs no link');
select lives_ok($$select public.disconnect_payment_account()$$, 'the owner disconnects');
select throws_ok($$select public.create_payment_request('no_show_fee', (select id from ids where label = 'b4'), 'mock', repeat('7', 64))$$,
                 'P0001', 'PAYMENTS_NOT_CONNECTED', 'no links without a connected account');
reset role;

select * from finish();
rollback;
