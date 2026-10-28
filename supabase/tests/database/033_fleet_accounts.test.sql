begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(66);

-- P5.7 fleet and trade accounts: business_accounts, business_account_vehicles,
-- business_account_customers, business_account_bookings, business_account_invoices,
-- account_statements; add_business_account_vehicle(), set_booking_account(), the
-- invoice link trigger, generate/issue/mark paid/email statements and the
-- accounts.statements job function.
--
-- Garages: P on paid Pro (owner Pia, technician Pete), E on Essentials (owner
-- Ed), Q another Pro garage (owner Quinn).

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17330000-0000-4000-8000-0000000000a1', 'fleet-owner@pgtap.test', '{}'::jsonb),
  ('17330000-0000-4000-8000-0000000000a2', 'fleet-tech@pgtap.test', '{}'::jsonb),
  ('17330000-0000-4000-8000-0000000000b1', 'fleet-essentials@pgtap.test', '{}'::jsonb),
  ('17330000-0000-4000-8000-0000000000c1', 'fleet-other@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen) values
  ('a1733000-0000-4000-8000-000000000001', 'pgtap-fleet-p', 'Fleet Pro', 'FLP', 'active', 'pro', null, 'pro'),
  ('a1733000-0000-4000-8000-000000000002', 'pgtap-fleet-e', 'Fleet Essentials', 'FLE', 'active', 'essentials', null, 'essentials'),
  ('a1733000-0000-4000-8000-000000000003', 'pgtap-fleet-q', 'Fleet Other', 'FLQ', 'active', 'pro', null, 'pro');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1733000-0000-4000-8000-000000000001', '17330000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1733000-0000-4000-8000-000000000001', '17330000-0000-4000-8000-0000000000a2', 'technician'),
  ('a1733000-0000-4000-8000-000000000002', '17330000-0000-4000-8000-0000000000b1', 'owner'),
  ('a1733000-0000-4000-8000-000000000003', '17330000-0000-4000-8000-0000000000c1', 'owner');

create function pg_temp.p() returns uuid language sql as $$ select 'a1733000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a1733000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.q() returns uuid language sql as $$ select 'a1733000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;

create temporary table fleet_ids (name text primary key, id uuid) on commit drop;
grant all on fleet_ids to authenticated, service_role;
create function pg_temp.acct1() returns uuid language sql as $$ select id from fleet_ids where name = 'acct1' $$;
create function pg_temp.acct2() returns uuid language sql as $$ select id from fleet_ids where name = 'acct2' $$;

-- A customer, car, service, bay and booking in each garage (service role writes, as the tenancy fixtures).
insert into public.customers (id, garage_id, name, phone, email, preferred_contact) values
  ('c1733000-0000-4000-8000-000000000001', pg_temp.p(), 'Dee Driver', '+447700900301', 'dee@example.test', 'phone'),
  ('c1733000-0000-4000-8000-000000000002', pg_temp.p(), 'Walk In', '+447700900302', null, 'phone'),
  ('c1733000-0000-4000-8000-000000000003', pg_temp.e(), 'Essie', '+447700900303', null, 'phone'),
  ('c1733000-0000-4000-8000-000000000004', pg_temp.q(), 'Quentin', '+447700900304', null, 'phone');
insert into public.vehicles (id, garage_id, customer_id, registration, make, model) values
  ('d1733000-0000-4000-8000-000000000001', pg_temp.p(), 'c1733000-0000-4000-8000-000000000001', 'FL12VAN', 'Ford', 'Transit'),
  ('d1733000-0000-4000-8000-000000000002', pg_temp.p(), 'c1733000-0000-4000-8000-000000000002', 'WK12INN', 'Kia', 'Ceed'),
  ('d1733000-0000-4000-8000-000000000003', pg_temp.e(), 'c1733000-0000-4000-8000-000000000003', 'ES12SIE', 'Fiat', '500'),
  ('d1733000-0000-4000-8000-000000000004', pg_temp.q(), 'c1733000-0000-4000-8000-000000000004', 'QU12INN', 'VW', 'Golf');
insert into public.services (id, garage_id, name, duration_min, buffer_min, price_pence, price_mode) values
  ('e1733000-0000-4000-8000-000000000001', pg_temp.p(), 'Fleet service', 60, 0, 12000, 'fixed'),
  ('e1733000-0000-4000-8000-000000000002', pg_temp.e(), 'Service', 60, 0, 12000, 'fixed'),
  ('e1733000-0000-4000-8000-000000000003', pg_temp.q(), 'Service', 60, 0, 12000, 'fixed');
insert into public.resources (id, garage_id, name, kind, sort) values
  ('f1733000-0000-4000-8000-000000000001', pg_temp.p(), 'Bay 1', 'bay', 1),
  ('f1733000-0000-4000-8000-000000000002', pg_temp.e(), 'Bay 1', 'bay', 1),
  ('f1733000-0000-4000-8000-000000000003', pg_temp.q(), 'Bay 1', 'bay', 1);
insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  ('b1733000-0000-4000-8000-000000000001', pg_temp.p(), 'c1733000-0000-4000-8000-000000000001', 'd1733000-0000-4000-8000-000000000001',
   'e1733000-0000-4000-8000-000000000001', 'f1733000-0000-4000-8000-000000000001',
   '2026-09-10 09:00+00', '2026-09-10 10:00+00', '[2026-09-10 09:00+00,2026-09-10 10:00+00)', 'collected', 'phone'),
  ('b1733000-0000-4000-8000-000000000002', pg_temp.p(), 'c1733000-0000-4000-8000-000000000002', 'd1733000-0000-4000-8000-000000000002',
   'e1733000-0000-4000-8000-000000000001', 'f1733000-0000-4000-8000-000000000001',
   '2026-09-11 09:00+00', '2026-09-11 10:00+00', '[2026-09-11 09:00+00,2026-09-11 10:00+00)', 'collected', 'phone'),
  ('b1733000-0000-4000-8000-000000000003', pg_temp.e(), 'c1733000-0000-4000-8000-000000000003', 'd1733000-0000-4000-8000-000000000003',
   'e1733000-0000-4000-8000-000000000002', 'f1733000-0000-4000-8000-000000000002',
   '2026-09-10 09:00+00', '2026-09-10 10:00+00', '[2026-09-10 09:00+00,2026-09-10 10:00+00)', 'collected', 'phone');

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from unnest(array['business_accounts', 'business_account_vehicles', 'business_account_customers',
             'business_account_bookings', 'business_account_invoices', 'account_statements']) t(name)
           join pg_class rel on rel.relname = t.name and rel.relnamespace = 'public'::regnamespace
           where rel.relrowsecurity), 6, 'every fleet table has RLS on');
select is((select count(*)::integer from unnest(array['business_accounts', 'business_account_vehicles', 'business_account_customers',
             'business_account_bookings', 'business_account_invoices', 'account_statements']) t(name)
           where has_table_privilege('anon', 'public.' || t.name, 'select')), 0, 'anon reads none of them');
select is((select count(*)::integer from unnest(array['business_account_bookings', 'business_account_invoices', 'account_statements']) t(name)
           where has_table_privilege('authenticated', 'public.' || t.name, 'insert')
              or has_table_privilege('authenticated', 'public.' || t.name, 'update')
              or has_table_privilege('authenticated', 'public.' || t.name, 'delete')), 0,
          'staff write bookings links, invoice links and statements only through functions');
select ok(not has_table_privilege('authenticated', 'public.business_accounts', 'delete'), 'accounts are archived, never deleted');
select ok(not has_column_privilege('authenticated', 'public.business_accounts', 'garage_id', 'update'), 'an account cannot be moved to another garage');
select is((select count(*)::integer from unnest(array[
             'public.generate_monthly_account_statements(uuid, date)', 'public.build_account_statement(uuid, uuid, date, uuid, boolean)',
             'public.link_invoice_to_account(uuid, uuid, uuid, text)', 'public.require_account_manager()']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('anon', f.name, 'execute')),
          0, 'the job and internal functions are not callable by staff');
select ok(has_function_privilege('service_role', 'public.generate_monthly_account_statements(uuid, date)', 'execute'), 'the job function is service role');
select is((select count(*)::integer from unnest(array[
             'public.add_business_account_vehicle(uuid, text, text, text)', 'public.set_booking_account(uuid, uuid, text)',
             'public.generate_account_statement(uuid, date)', 'public.issue_account_statement(uuid)',
             'public.mark_account_statement_paid(uuid, timestamptz, text, text)', 'public.record_account_statement_email(uuid, text, text, text)']) f(name)
           where has_function_privilege('anon', f.name, 'execute')), 0, 'anon calls none of the staff functions');
select is((select count(*)::integer from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname in ('add_business_account_vehicle', 'set_booking_account', 'generate_account_statement', 'issue_account_statement',
                             'mark_account_statement_paid', 'record_account_statement_email', 'generate_monthly_account_statements',
                             'build_account_statement', 'link_invoice_to_account', 'link_account_invoice', 'require_account_manager')
             and prosecdef and proconfig = array['search_path=""']), 11, 'fleet functions are security definer with an empty search_path');
select ok(exists (select 1 from pg_trigger where tgname = 'invoices_link_account' and tgrelid = 'public.invoices'::regclass),
          'invoices carry the account link trigger');

-- ---------------------------------------------------------------------------
-- Plan gating: Essentials refused
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17330000-0000-4000-8000-0000000000b1', pg_temp.e());
set local role authenticated;
select throws_ok($$insert into public.business_accounts (name) values ('Essentials Fleet Ltd')$$,
                 '42501', null, 'an Essentials garage cannot add an account');
select throws_ok($$select public.add_business_account_vehicle(gen_random_uuid(), 'AB12CDE')$$,
                 'P0001', 'PLAN_REQUIRED: fleet_accounts', 'an Essentials garage cannot add a car to an account');
select throws_ok($$select public.set_booking_account('b1733000-0000-4000-8000-000000000003', gen_random_uuid(), null)$$,
                 'P0001', 'PLAN_REQUIRED: fleet_accounts', 'an Essentials garage cannot charge a booking to an account');
select throws_ok($$select public.generate_account_statement(gen_random_uuid(), '2026-09-01')$$,
                 'P0001', 'PLAN_REQUIRED: fleet_accounts', 'an Essentials garage cannot make statements');
reset role;

-- ---------------------------------------------------------------------------
-- Accounts and cars on Pro
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17330000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select throws_ok($$insert into public.business_accounts (name) values ('Tech Fleet Ltd')$$,
                 '42501', null, 'a technician cannot add an account');
select throws_ok($$select public.add_business_account_vehicle(gen_random_uuid(), 'AB12CDE')$$,
                 '42501', null, 'a technician cannot add cars to an account');
reset role;

select pg_temp.as_member('17330000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select lives_ok($$with added as (insert into public.business_accounts (name, kind, billing_email, billing_address, payment_terms_days, po_required, discount_percent, credit_limit_pence)
                  values ('Northern Vans Ltd', 'fleet', 'accounts@northern.example',
                          E'1 Depot Road\nLeeds\nLS1 1AA', 14, true, 10, 500000) returning id)
                  insert into fleet_ids select 'acct1', id from added$$,
                'the owner adds a fleet account');
select lives_ok($$with added as (insert into public.business_accounts (name, kind, billing) values ('Trade Parts Co', 'trade', 'per_invoice') returning id)
                  insert into fleet_ids select 'acct2', id from added$$,
                'the owner adds a trade account');
select is((select garage_id from public.business_accounts where id = pg_temp.acct1()), pg_temp.p(),
          'the garage comes from the selected garage');
select throws_ok($$insert into public.business_accounts (name) values ('northern vans ltd ')$$, '23505', null,
                 'two active accounts cannot share a name');
select throws_ok($$insert into public.business_accounts (garage_id, name) values ('a1733000-0000-4000-8000-000000000003', 'Smuggled Ltd')$$,
                 '42501', null, 'an account cannot be written into another garage');
select throws_ok($$insert into public.business_accounts (name, payment_terms_days) values ('Bad Terms Ltd', 365)$$, '23514', null,
                 'payment terms are 0 to 120 days');

select is(public.add_business_account_vehicle(pg_temp.acct1(), 'ab12 cde', 'Ford', 'Transit') ->> 'created', 'true',
          'a new registration creates the car and adds it');
select is((select count(*)::integer from public.vehicles where garage_id = pg_temp.p() and registration = 'AB12CDE'), 1,
          'the registration is stored normalised');
select is(public.add_business_account_vehicle(pg_temp.acct1(), 'AB12CDE') ->> 'linked', 'false',
          'adding the same car again changes nothing');
select throws_ok($$select public.add_business_account_vehicle(pg_temp.acct2(), 'AB12CDE')$$,
                 'P0001', 'VEHICLE_ON_OTHER_ACCOUNT', 'a car is on one account at a time');
select throws_ok($$select public.add_business_account_vehicle(pg_temp.acct1(), '!!')$$,
                 '22023', 'INVALID_REGISTRATION', 'a registration must look like one');
select lives_ok($$insert into public.business_account_customers (account_id, customer_id, role)
                  values (pg_temp.acct2(), 'c1733000-0000-4000-8000-000000000002', 'contact')$$,
                'the owner links a customer as a contact');
select throws_ok($$insert into public.business_account_customers (account_id, customer_id)
                   values (pg_temp.acct2(), 'c1733000-0000-4000-8000-000000000004')$$,
                 '23503', null, 'another garage''s customer cannot be linked');
reset role;

-- Cross-garage
select pg_temp.as_member('17330000-0000-4000-8000-0000000000c1', pg_temp.q());
set local role authenticated;
select is((select count(*)::integer from public.business_accounts), 0, 'another garage sees no accounts');
select throws_ok($$select public.add_business_account_vehicle(pg_temp.acct1(), 'QU12INN')$$,
                 'P0001', 'ACCOUNT_NOT_FOUND', 'another garage cannot add cars to the account');
select throws_ok($$select public.set_booking_account('b1733000-0000-4000-8000-000000000001', pg_temp.acct1(), 'PO-9')$$,
                 'P0001', 'BOOKING_NOT_FOUND', 'another garage cannot charge the booking');
reset role;

-- ---------------------------------------------------------------------------
-- Bookings charged to an account
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17330000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.business_accounts), 2, 'a technician reads the accounts');
select throws_ok($$select public.set_booking_account('b1733000-0000-4000-8000-000000000001', pg_temp.acct1(), '  ')$$,
                 'P0001', 'PO_REQUIRED', 'an account that needs a PO refuses a booking without one');
select lives_ok($$select public.set_booking_account('b1733000-0000-4000-8000-000000000001', pg_temp.acct1(), 'PO-1001')$$,
                'a member who books charges the booking to the account with its PO');
select is((select po_number from public.business_account_bookings where booking_id = 'b1733000-0000-4000-8000-000000000001'), 'PO-1001',
          'the PO number is stored with the booking');
select is((select account_id from public.business_account_vehicles where vehicle_id = 'd1733000-0000-4000-8000-000000000001'),
          pg_temp.acct1(), 'the booking''s car joins the account');
select is((select role from public.business_account_customers where customer_id = 'c1733000-0000-4000-8000-000000000001'), 'driver',
          'the booking''s customer becomes a driver');
select throws_ok($$select public.set_booking_account('b1733000-0000-4000-8000-000000000001', pg_temp.acct2(), null)$$,
                 'P0001', 'VEHICLE_ON_OTHER_ACCOUNT', 'a booking cannot be charged to an account the car is not on');
select throws_ok($$insert into public.business_account_bookings (booking_id, account_id) values ('b1733000-0000-4000-8000-000000000002', pg_temp.acct1())$$,
                 '42501', null, 'staff cannot write booking links directly');
reset role;

-- ---------------------------------------------------------------------------
-- Invoices follow the booking's account
-- ---------------------------------------------------------------------------

select pg_temp.as_member('17330000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
insert into fleet_ids values ('account_invoice', public.save_invoice_draft(null,
  jsonb_build_object('source_type', 'booking', 'booking_id', 'b1733000-0000-4000-8000-000000000001', 'issue_date', '2026-09-10',
    'items', jsonb_build_array(jsonb_build_object('description', 'Fleet service', 'quantity', '1', 'unit_price_pence', '12000'))), false));
insert into fleet_ids values ('walk_in_invoice', public.save_invoice_draft(null,
  jsonb_build_object('source_type', 'booking', 'booking_id', 'b1733000-0000-4000-8000-000000000002', 'issue_date', '2026-09-11',
    'items', jsonb_build_array(jsonb_build_object('description', 'Service', 'quantity', '1', 'unit_price_pence', '9000'))), false));
select is((select bill_to_name || '|' || po_number from public.business_account_invoices
           where invoice_id = (select id from fleet_ids where name = 'account_invoice')), 'Northern Vans Ltd|PO-1001',
          'an invoice for an account booking is billed to the account with the PO');
select is((select count(*)::integer from public.business_account_invoices
           where invoice_id = (select id from fleet_ids where name = 'walk_in_invoice')), 0, 'other invoices are not linked');
select lives_ok($$select public.issue_invoice((select id from fleet_ids where name = 'account_invoice'))$$, 'the account invoice is issued');
select throws_ok($$select public.generate_account_statement(pg_temp.acct2(), '2026-09-01')$$,
                 'P0001', 'NOTHING_TO_BILL', 'an account with nothing to bill gets no statement');
select throws_ok($$select public.generate_account_statement(pg_temp.acct1(), '2026-09-02')$$,
                 '22023', 'INVALID_PERIOD', 'a statement period starts on the 1st');

-- ---------------------------------------------------------------------------
-- Statements
-- ---------------------------------------------------------------------------

insert into fleet_ids values ('statement', (public.generate_account_statement(pg_temp.acct1(), '2026-09-01')).id);
select is((select status || '|' || invoice_count || '|' || total_pence || '|' || reference || '|' || period_end
           from public.account_statements where id = (select id from fleet_ids where name = 'statement')),
          'draft|1|12000|FLP-ST-202609-001|2026-09-30', 'a draft statement holds the month''s issued invoices');
select is((select statement_id from public.business_account_invoices where invoice_id = (select id from fleet_ids where name = 'account_invoice')),
          (select id from fleet_ids where name = 'statement'), 'the invoice is on the statement');
reset role;

select pg_temp.as_member('17330000-0000-4000-8000-0000000000a2', pg_temp.p());
set local role authenticated;
select throws_ok($$select public.generate_account_statement(pg_temp.acct1(), '2026-09-01')$$,
                 '42501', null, 'a technician cannot make statements');
reset role;

set local role service_role;
select is(public.generate_monthly_account_statements(pg_temp.p(), '2026-09-01'), 1, 'the job refreshes the draft for the monthly account');
select is(public.generate_monthly_account_statements(pg_temp.p(), '2026-09-01'), 1, 'running the job again is idempotent');
select is((select count(*)::integer from public.account_statements where garage_id = pg_temp.p()), 1, 'one statement per account and month');
select is(public.generate_monthly_account_statements(pg_temp.e(), '2026-09-01'), 0, 'the job does nothing for an Essentials garage');
select throws_ok($$select public.generate_monthly_account_statements('a1733000-0000-4000-8000-000000000001', '2026-09-15')$$,
                 '22023', 'INVALID_PERIOD', 'the job takes the first of a month');
reset role;

select pg_temp.as_member('17330000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select is((select (status = 'issued' and due_date = issue_date + 14)::text
           from public.issue_account_statement((select id from fleet_ids where name = 'statement'))), 'true',
          'issuing sets the due date from the account terms');
select throws_ok($$select public.issue_account_statement((select id from fleet_ids where name = 'statement'))$$,
                 'P0001', 'STATEMENT_NOT_DRAFT', 'a statement is issued once');
select is((public.generate_account_statement(pg_temp.acct1(), '2026-09-01')).status, 'issued',
          'making the month again returns the issued statement unchanged');
select is((public.record_account_statement_email((select id from fleet_ids where name = 'statement'), 'Accounts@Northern.example', 'sent', 'mock_1')).email_count,
          1, 'an emailed statement is recorded');
select is((public.mark_account_statement_paid((select id from fleet_ids where name = 'statement'), now(), 'bank_transfer', 'BACS 77')).status, 'paid',
          'the statement is marked paid');
select is((select status::text from public.invoices where id = (select id from fleet_ids where name = 'account_invoice')), 'paid',
          'its invoices are paid with it');
reset role;

select pg_temp.as_member('17330000-0000-4000-8000-0000000000c1', pg_temp.q());
set local role authenticated;
select is((select count(*)::integer from public.account_statements), 0, 'another garage sees no statements');
select is((select count(*)::integer from public.business_account_invoices), 0, 'another garage sees no account invoices');
select throws_ok($$select public.issue_account_statement((select id from fleet_ids where name = 'statement'))$$,
                 'P0001', 'STATEMENT_NOT_FOUND', 'another garage cannot issue the statement');
reset role;

-- ---------------------------------------------------------------------------
-- Downgrade: readable, not writable
-- ---------------------------------------------------------------------------

update public.garages set plan = 'essentials', plan_chosen = 'essentials', trial_ends_at = null where id = pg_temp.p();
select pg_temp.as_member('17330000-0000-4000-8000-0000000000a1', pg_temp.p());
set local role authenticated;
select is((select count(*)::integer from public.business_accounts), 2, 'a downgraded garage still reads its accounts');
select is((select count(*)::integer from public.account_statements), 1, 'and its statements');
select throws_ok($$update public.business_accounts set notes = 'changed' where id = pg_temp.acct1()$$,
                 '42501', null, 'but cannot change them');
select throws_ok($$select public.generate_account_statement(pg_temp.acct1(), '2026-10-01')$$,
                 'P0001', 'PLAN_REQUIRED: fleet_accounts', 'or make statements');
reset role;

select * from finish();
rollback;
