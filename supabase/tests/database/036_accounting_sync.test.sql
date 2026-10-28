begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(45);

-- P5.10 accounting sync: accounting_connections, accounting_connection_secrets,
-- accounting_sync_items, accounting_save_connection(), accounting_choose_tenant(),
-- accounting_disconnect(), the invoice/payment triggers, accounting_request_sync(),
-- accounting_retry_item(), accounting_due_garages().
--
-- Garages: P on paid Pro (owner Pia, manager Max, technician Tim), E on
-- Essentials (owner Eve), B on paid Pro (owner Bob).

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('13600000-0000-4000-8000-0000000000a1', 'acct-owner@pgtap.test', '{}'::jsonb),
  ('13600000-0000-4000-8000-0000000000a2', 'acct-manager@pgtap.test', '{}'::jsonb),
  ('13600000-0000-4000-8000-0000000000a3', 'acct-tech@pgtap.test', '{}'::jsonb),
  ('13600000-0000-4000-8000-0000000000e1', 'acct-ess@pgtap.test', '{}'::jsonb),
  ('13600000-0000-4000-8000-0000000000b1', 'acct-other@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen) values
  ('a1360000-0000-4000-8000-000000000001', 'pgtap-acct-p', 'Accounts Pro', 'ACP', 'active', 'pro', null, 'pro'),
  ('a1360000-0000-4000-8000-000000000002', 'pgtap-acct-e', 'Accounts Ess', 'ACE', 'active', 'essentials', null, 'essentials'),
  ('a1360000-0000-4000-8000-000000000003', 'pgtap-acct-b', 'Accounts Other', 'ACB', 'active', 'pro', null, 'pro');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1360000-0000-4000-8000-000000000001', '13600000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1360000-0000-4000-8000-000000000001', '13600000-0000-4000-8000-0000000000a2', 'manager'),
  ('a1360000-0000-4000-8000-000000000001', '13600000-0000-4000-8000-0000000000a3', 'technician'),
  ('a1360000-0000-4000-8000-000000000002', '13600000-0000-4000-8000-0000000000e1', 'owner'),
  ('a1360000-0000-4000-8000-000000000003', '13600000-0000-4000-8000-0000000000b1', 'owner');

create function pg_temp.p() returns uuid language sql as $$ select 'a1360000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a1360000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.b() returns uuid language sql as $$ select 'a1360000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;
-- A sealed-looking token (the app encrypts; SQL only checks the shape).
create function pg_temp.ct() returns text language sql as $$ select 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccc'::text $$;

-- Draft invoices (issued later through issue_invoice()).
insert into public.invoices (id, garage_id, status, source_type, customer_name, issue_date, created_by, updated_by) values
  ('21360000-0000-4000-8000-000000000001', pg_temp.p(), 'draft', 'manual', 'Sync fixture P', '2096-05-01',
   '13600000-0000-4000-8000-0000000000a1', '13600000-0000-4000-8000-0000000000a1'),
  ('21360000-0000-4000-8000-000000000002', pg_temp.e(), 'draft', 'manual', 'Sync fixture E', '2096-05-01',
   '13600000-0000-4000-8000-0000000000e1', '13600000-0000-4000-8000-0000000000e1'),
  ('21360000-0000-4000-8000-000000000003', pg_temp.p(), 'draft', 'manual', 'Before connecting', '2096-05-01',
   '13600000-0000-4000-8000-0000000000a1', '13600000-0000-4000-8000-0000000000a1');
insert into public.invoice_items (garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence) values
  (pg_temp.p(), '21360000-0000-4000-8000-000000000001', 'Brake pads', 1, 12000, 0),
  (pg_temp.e(), '21360000-0000-4000-8000-000000000002', 'Oil change', 1, 6000, 0),
  (pg_temp.p(), '21360000-0000-4000-8000-000000000003', 'Wipers', 1, 1500, 0);

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from unnest(array['accounting_connections', 'accounting_connection_secrets', 'accounting_sync_items']) t(name)
           join pg_class rel on rel.relname = t.name and rel.relnamespace = 'public'::regnamespace where rel.relrowsecurity),
          3, 'the accounting tables have RLS on');
select is((select count(*)::integer from unnest(array['accounting_connections', 'accounting_connection_secrets', 'accounting_sync_items']) t(name)
           where has_table_privilege('authenticated', 'public.' || t.name, 'insert')
              or has_table_privilege('authenticated', 'public.' || t.name, 'update')
              or has_table_privilege('authenticated', 'public.' || t.name, 'delete')), 0, 'staff write none of them directly');
select is((select count(*)::integer from unnest(array['accounting_connections', 'accounting_connection_secrets', 'accounting_sync_items']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select')), 0, 'anon reads none of them');
select is(has_table_privilege('authenticated', 'public.accounting_connection_secrets', 'select'), false, 'tokens are service role only');
select is((select count(*)::integer from unnest(array[
             'public.accounting_save_connection(uuid, text, text, text, text[], uuid, text, text, timestamptz, timestamptz)',
             'public.accounting_choose_tenant(uuid, uuid, text, text, uuid)', 'public.accounting_disconnect(uuid, uuid)',
             'public.enqueue_accounting_sync(uuid, timestamptz)', 'public.accounting_queue_entity(uuid, text, uuid)',
             'public.accounting_due_garages(integer)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')),
          0, 'connect, disconnect and queueing functions are service role only');
select is((select count(*)::integer from unnest(array['public.accounting_request_sync()', 'public.accounting_retry_item(uuid)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') and not has_function_privilege('anon', f.name, 'execute')),
          2, 'Sync now and Retry are for signed-in staff');
select is((select count(*)::integer from pg_proc
           where oid in ('public.accounting_save_connection(uuid, text, text, text, text[], uuid, text, text, timestamptz, timestamptz)'::regprocedure,
                         'public.accounting_request_sync()'::regprocedure, 'public.accounting_retry_item(uuid)'::regprocedure,
                         'public.accounting_queue_after_invoice_change()'::regprocedure)
             and prosecdef and proconfig = array['search_path=""']), 4, 'functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Connecting (plan gated)
-- ---------------------------------------------------------------------------

set local role service_role;
select throws_ok($$select public.accounting_save_connection('a1360000-0000-4000-8000-000000000002', 'xero', 'org-1', 'Org', '{}', null,
                   'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccc', null, now() + interval '30 minutes')$$,
                 'P0001', 'PLAN_REQUIRED: accounting_sync', 'an Essentials garage cannot connect');
select is((public.accounting_save_connection(pg_temp.p(), 'xero', null, null, array['accounting.transactions'], '13600000-0000-4000-8000-0000000000a1',
           pg_temp.ct(), pg_temp.ct(), now() + interval '30 minutes')).status, 'pending', 'without an organisation the connection is pending');
select throws_ok($$select public.accounting_save_connection('a1360000-0000-4000-8000-000000000001', 'teleport', 'x', 'x', '{}', null,
                   'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccc', null, now())$$, '22023', 'INVALID_PROVIDER', 'unknown providers are refused');
select throws_ok($$select public.accounting_save_connection('a1360000-0000-4000-8000-000000000001', 'xero', null, null, '{}', null,
                   'plaintext-token', null, now())$$, '23514', null, 'tokens must be ciphertext');
select is((public.accounting_choose_tenant(pg_temp.p(), (select id from public.accounting_connections where garage_id = pg_temp.p()),
           'org-1', 'Pro Garage Ltd', '13600000-0000-4000-8000-0000000000a1')).status, 'connected', 'choosing the organisation connects');
select is((select count(*)::integer from public.jobs where kind = 'accounting.sync' and garage_id = pg_temp.p() and status = 'queued'), 1,
          'and queues a sync for anything waiting');
select throws_ok($$select public.accounting_choose_tenant('a1360000-0000-4000-8000-000000000003',
                   (select id from public.accounting_connections where garage_id = 'a1360000-0000-4000-8000-000000000001'), 'x', 'x', null)$$,
                 'P0002', 'CONNECTION_NOT_FOUND', 'another garage''s connection cannot be chosen for');
select throws_ok($$insert into public.accounting_connections (garage_id, provider, status, tenant_id) values
                   ('a1360000-0000-4000-8000-000000000001', 'sage', 'connected', 'biz')$$, '23505', null, 'one active connection per garage');
select is((public.accounting_save_connection(pg_temp.b(), 'quickbooks', '1234', 'Other Co', '{}', null, pg_temp.ct(), pg_temp.ct(),
           now() + interval '1 hour')).status, 'connected', 'garage B connects QuickBooks with its company');
reset role;
-- Essentials garage E with a connection from its trial (written directly, as if before the downgrade).
insert into public.accounting_connections (garage_id, provider, status, tenant_id) values (pg_temp.e(), 'xero', 'connected', 'org-e');

-- ---------------------------------------------------------------------------
-- Queueing on issue and payment
-- ---------------------------------------------------------------------------

select pg_temp.as_member('13600000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select lives_ok($$select public.issue_invoice('21360000-0000-4000-8000-000000000001')$$, 'the owner issues an invoice');
reset role;
select is((select status from public.accounting_sync_items where local_id = '21360000-0000-4000-8000-000000000001' and entity = 'invoice'),
          'pending', 'issuing queues the invoice');
select is((select count(*)::integer from public.jobs where kind = 'accounting.sync' and garage_id = pg_temp.p() and payload ->> 'garageId' = pg_temp.p()::text),
          1, 'and an accounting.sync job for the garage');
select pg_temp.as_member('13600000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select lives_ok($$select public.record_invoice_payment('21360000-0000-4000-8000-000000000001', 5000, now(), 'card', 'part')$$, 'the owner records a part payment');
reset role;
select is((select count(*)::integer from public.accounting_sync_items item join public.invoice_payments payment on payment.id = item.local_id
           where item.entity = 'payment' and payment.invoice_id = '21360000-0000-4000-8000-000000000001'), 1, 'recording a payment queues it');
select is((select count(*)::integer from public.jobs where kind = 'accounting.sync' and garage_id = pg_temp.p()), 1,
          'one queued job per garage at a time');

select pg_temp.as_member('13600000-0000-4000-8000-0000000000e1', pg_temp.e());
set local role authenticated;
select lives_ok($$select public.issue_invoice('21360000-0000-4000-8000-000000000002')$$, 'Essentials still issues invoices');
reset role;
select is((select count(*)::integer from public.accounting_sync_items where garage_id = pg_temp.e()), 0, 'but nothing is queued on Essentials');

-- ---------------------------------------------------------------------------
-- Reads (owners and managers; never the tokens)
-- ---------------------------------------------------------------------------

select pg_temp.as_member('13600000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.accounting_sync_items), 2, 'a manager reads the sync status');
select is((select status from public.accounting_connections), 'connected', 'and the connection');
select throws_ok($$select * from public.accounting_connection_secrets$$, '42501', null, 'but never the tokens');
reset role;
select pg_temp.as_member('13600000-0000-4000-8000-0000000000a3', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.accounting_sync_items), 0, 'a technician reads no sync status');
reset role;
select pg_temp.as_member('13600000-0000-4000-8000-0000000000b1', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.accounting_sync_items where garage_id = 'a1360000-0000-4000-8000-000000000001'), 0,
          'another garage''s owner reads nothing, even with a forged header');

-- ---------------------------------------------------------------------------
-- Sync now and Retry
-- ---------------------------------------------------------------------------

select throws_ok($$select public.accounting_request_sync()$$, '42501', 'ACCOUNTING_FORBIDDEN', 'a non-member cannot sync another garage');
reset role;
select pg_temp.as_member('13600000-0000-4000-8000-0000000000a3', pg_temp.p());
set local role authenticated;
select throws_ok($$select public.accounting_request_sync()$$, '42501', 'ACCOUNTING_FORBIDDEN', 'a technician cannot sync');
reset role;
select pg_temp.as_member('13600000-0000-4000-8000-0000000000e1', pg_temp.e());
set local role authenticated;
select throws_ok($$select public.accounting_request_sync()$$, 'P0001', 'PLAN_REQUIRED: accounting_sync', 'Essentials cannot sync');
reset role;

update public.accounting_sync_items set status = 'failed', attempts = 6, last_error_code = 'VALIDATION'
where local_id = '21360000-0000-4000-8000-000000000001';
-- An invoice issued before the connection was made is not swept up.
update public.accounting_connections set connected_at = now() + interval '1 second' where garage_id = pg_temp.p() and status = 'connected';
select pg_temp.as_member('13600000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select is(public.accounting_request_sync(), 2, 'Sync now puts failed items back to pending');
reset role;
select is((select attempts from public.accounting_sync_items where local_id = '21360000-0000-4000-8000-000000000001'), 0, 'with fresh attempts');

update public.accounting_sync_items set status = 'failed', last_error_code = 'VALIDATION'
where local_id = '21360000-0000-4000-8000-000000000001';
select pg_temp.as_member('13600000-0000-4000-8000-0000000000b1', pg_temp.b());
set local role authenticated;
select throws_ok(format('select public.accounting_retry_item(%L)', (select id from public.accounting_sync_items where local_id = '21360000-0000-4000-8000-000000000001')),
                 'P0002', 'SYNC_ITEM_NOT_FOUND', 'another garage''s owner cannot retry the item');
reset role;
select pg_temp.as_member('13600000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select is((public.accounting_retry_item((select id from public.accounting_sync_items where local_id = '21360000-0000-4000-8000-000000000001'))).status,
          'pending', 'the owner retries a failed item');
reset role;

set local role service_role;
select ok(pg_temp.p() in (select public.accounting_due_garages(10)), 'the garage has due items for the daily fan-out');
reset role;

-- ---------------------------------------------------------------------------
-- Disconnect (tokens gone, history kept)
-- ---------------------------------------------------------------------------

set local role service_role;
select is(public.accounting_disconnect(pg_temp.p(), '13600000-0000-4000-8000-0000000000a1'), true, 'the connection ends');
select is(public.accounting_disconnect(pg_temp.p(), null), false, 'a second disconnect does nothing');
reset role;
select is((select count(*)::integer from public.accounting_connection_secrets where garage_id = pg_temp.p()), 0, 'its tokens are deleted');
select is((select count(*)::integer from public.accounting_sync_items where garage_id = pg_temp.p()), 2, 'its sync history stays');
select is((select count(*)::integer from public.accounting_sync_items where garage_id = pg_temp.p() and status = 'pending'), 0,
          'pending items are closed as failed');
select is((select count(*)::integer from public.accounting_connection_secrets where garage_id = pg_temp.b()), 1, 'garage B keeps its tokens');

-- Issuing after a disconnect queues nothing.
select pg_temp.as_member('13600000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select lives_ok($$select public.issue_invoice('21360000-0000-4000-8000-000000000003')$$, 'issuing still works without a connection');
reset role;
select is((select count(*)::integer from public.accounting_sync_items where local_id = '21360000-0000-4000-8000-000000000003'), 0,
          'and queues nothing');

select * from finish();
rollback;
