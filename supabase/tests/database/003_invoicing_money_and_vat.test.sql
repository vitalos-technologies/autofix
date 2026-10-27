begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(23);

-- The fixture owners have no Auth-managed TOTP factor; isolate monetary
-- calculations from MFA enrollment.
update public.admin_mfa_policy
set mandatory_mfa_enabled = false
where singleton;

select col_type_is('public', 'invoice_items', 'unit_price_pence', 'bigint', 'unit prices are stored as integer pence');
select col_type_is('public', 'invoice_items', 'line_total_pence', 'bigint', 'line totals are stored as integer pence');
select col_type_is('public', 'invoices', 'subtotal_pence', 'bigint', 'subtotals are stored as integer pence');
select col_type_is('public', 'invoices', 'discount_pence', 'bigint', 'discounts are stored as integer pence');
select col_type_is('public', 'invoices', 'tax_pence', 'bigint', 'tax is stored as integer pence');
select col_type_is('public', 'invoices', 'total_pence', 'bigint', 'totals are stored as integer pence');

select is(public.invoice_line_total(1.250, 799), 999::bigint, 'fractional quantities use exact numeric pence arithmetic');
select is(public.invoice_line_total(1.500, 1), 2::bigint, 'half-penny values round deterministically');

insert into auth.users (id, email, raw_user_meta_data) values
  ('12000000-0000-4000-8000-00000000000a', 'money-owner-a@pgtap.test', '{}'::jsonb),
  ('12000000-0000-4000-8000-00000000000b', 'money-owner-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix) values
  ('a2000000-0000-4000-8000-000000000001', 'pgtap-money-a', 'Money Garage A', 'MNA'),
  ('b2000000-0000-4000-8000-000000000001', 'pgtap-money-b', 'Money Garage B', 'MNB');

insert into public.garage_members (garage_id, user_id, role) values
  ('a2000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-00000000000a', 'owner'),
  ('b2000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-00000000000b', 'manager');

create function pg_temp.act_as(p_user uuid, p_garage uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else jsonb_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
  perform set_config('request.headers',
    case when p_garage is null then '{}' else jsonb_build_object('x-garage-id', p_garage)::text end, true);
end
$$;

-- Garage A has a customer, a vehicle, a booking and a draft invoice.
insert into public.customers (id, garage_id, name, email, phone, preferred_contact) values
  ('62000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', 'Garage A customer', 'a-customer@example.test', '+447700900001', 'email');
insert into public.vehicles (id, garage_id, customer_id, registration, make, model) values
  ('72000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-00000000000a', 'mn12 aaa', 'Test', 'A');
insert into public.services (id, garage_id, name, duration_min, price_pence, price_mode) values
  ('92000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', 'Garage A service', 60, 5000, 'fixed');
insert into public.resources (id, garage_id, name) values
  ('93000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', 'Bay 1');
insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  ('82000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-00000000000a',
   '72000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-00000000000a', '93000000-0000-4000-8000-00000000000a',
   '2081-01-01T09:00:00Z', '2081-01-01T10:00:00Z', '[2081-01-01T09:00:00Z,2081-01-01T10:00:00Z)', 'confirmed', 'phone');

insert into public.invoices (id, garage_id, status, source_type, customer_name, created_by, updated_by)
values (
  '22000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'draft',
  'manual',
  'Money fixture',
  '12000000-0000-4000-8000-00000000000a',
  '12000000-0000-4000-8000-00000000000a'
);

select is(
  (select registration from public.vehicles where id = '72000000-0000-4000-8000-00000000000a'),
  'MN12AAA', 'registrations are stored upper case without spaces'
);

select pg_temp.act_as('12000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001');
set local role authenticated;

select lives_ok(
  $test$
    select public.save_invoice_draft(
      '22000000-0000-4000-8000-000000000001',
      jsonb_build_object(
        'source_type', 'manual',
        'booking_id', '',
        'enquiry_id', '',
        'customer_id', '',
        'vehicle_id', '',
        'customer_name', 'Money fixture',
        'customer_email', 'money@example.test',
        'customer_phone', '',
        'customer_address', '',
        'vehicle_registration', 'MN12TST',
        'vehicle_make', 'Test',
        'vehicle_model', 'Money',
        'service_name', 'Exact arithmetic',
        'appointment_start', '',
        'issue_date', '2081-01-01',
        'due_date', '2081-01-08',
        'discount_pence', '100',
        'tax_pence', '0',
        'subtotal_pence', '999999999',
        'total_pence', '999999999',
        'notes', '',
        'payment_terms', '',
        'items', jsonb_build_array(jsonb_build_object(
          'description', 'Fractional labour',
          'quantity', '1.250',
          'unit_price_pence', '799',
          'line_total_pence', '999999999'
        ))
      ),
      false
    )
  $test$,
  'guarded draft save accepts valid integer-pence inputs'
);

select is(
  (select line_total_pence from public.invoice_items where invoice_id = '22000000-0000-4000-8000-000000000001'),
  999::bigint,
  'browser-submitted line total cannot override database calculation'
);
select is(
  (select subtotal_pence from public.invoices where id = '22000000-0000-4000-8000-000000000001'),
  999::bigint,
  'browser-submitted subtotal cannot override item sum'
);
select is(
  (select discount_pence from public.invoices where id = '22000000-0000-4000-8000-000000000001'),
  100::bigint,
  'validated discount remains integer pence'
);
select is(
  (select tax_pence from public.invoices where id = '22000000-0000-4000-8000-000000000001'),
  0::bigint,
  'tax remains zero while VAT is not configured'
);
select is(
  (select total_pence from public.invoices where id = '22000000-0000-4000-8000-000000000001'),
  899::bigint,
  'authoritative total is subtotal minus discount plus tax'
);

select throws_ok(
  $test$
    select public.save_invoice_draft(
      null,
      '{"source_type":"manual","customer_name":"VAT attempt","discount_pence":"0","tax_pence":"1","items":[{"description":"Work","quantity":"1","unit_price_pence":"100"}]}'::jsonb,
      false
    )
  $test$,
  'P0001', 'VAT_NOT_CONFIGURED', 'nonzero tax is rejected by the database RPC'
);
select throws_ok(
  $test$
    select public.save_invoice_draft(
      null,
      '{"source_type":"manual","customer_name":"Discount attempt","discount_pence":"101","tax_pence":"0","items":[{"description":"Work","quantity":"1","unit_price_pence":"100"}]}'::jsonb,
      false
    )
  $test$,
  'P0001', 'INVALID_INVOICE_TOTAL', 'discount cannot exceed the authoritative subtotal'
);
select throws_ok(
  $test$
    select public.save_invoice_draft(
      null,
      '{"source_type":"manual","customer_name":"Unsafe amount","discount_pence":"0","tax_pence":"0","items":[{"description":"Work","quantity":"1","unit_price_pence":"9007199254740992"}]}'::jsonb,
      false
    )
  $test$,
  '22003', 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER', 'amounts beyond the JavaScript-safe pence range are rejected'
);

reset role;

-- A manager of garage B cannot reach garage A's records through the payload.
select pg_temp.act_as('12000000-0000-4000-8000-00000000000b', 'b2000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $test$
    select public.save_invoice_draft(
      null,
      jsonb_build_object('source_type', 'booking', 'booking_id', '82000000-0000-4000-8000-00000000000a',
        'items', jsonb_build_array(jsonb_build_object('description', 'Work', 'quantity', '1', 'unit_price_pence', '100'))),
      false
    )
  $test$,
  'P0001', 'SOURCE_RELATIONSHIP_MISMATCH', 'garage B cannot invoice garage A''s booking'
);
select throws_ok(
  $test$
    select public.save_invoice_draft(
      null,
      jsonb_build_object('source_type', 'manual', 'customer_id', '62000000-0000-4000-8000-00000000000a', 'customer_name', 'Stolen customer',
        'items', jsonb_build_array(jsonb_build_object('description', 'Work', 'quantity', '1', 'unit_price_pence', '100'))),
      false
    )
  $test$,
  'P0001', 'SOURCE_RELATIONSHIP_MISMATCH', 'garage B cannot attach garage A''s customer'
);
select throws_ok(
  $test$
    select public.save_invoice_draft(
      null,
      jsonb_build_object('source_type', 'manual', 'vehicle_id', '72000000-0000-4000-8000-00000000000a', 'customer_name', 'Stolen vehicle',
        'items', jsonb_build_array(jsonb_build_object('description', 'Work', 'quantity', '1', 'unit_price_pence', '100'))),
      false
    )
  $test$,
  'P0001', 'SOURCE_RELATIONSHIP_MISMATCH', 'garage B cannot attach garage A''s vehicle'
);
reset role;

select is(
  (select count(*)::integer from public.invoices where garage_id = 'b2000000-0000-4000-8000-000000000001'),
  0, 'none of garage B''s attempts created an invoice'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ 'tax_pence = 0'
  ),
  'a database constraint keeps VAT tax at zero until configured'
);

select * from finish();
rollback;
