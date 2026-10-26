begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(47);

-- The fixture owners have no Auth-managed TOTP factor; isolate invoice
-- state-machine coverage from MFA enrollment.
update public.admin_mfa_policy
set mandatory_mfa_enabled = false
where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('11000000-0000-4000-8000-00000000000a', 'state-owner-a@pgtap.test', '{}'::jsonb),
  ('11000000-0000-4000-8000-00000000000b', 'state-owner-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, legal_name, company_number, phone, email, address, booking_prefix, settings) values
  ('a1000000-0000-4000-8000-000000000001', 'pgtap-state-a', 'State Garage A', 'State Garage A Limited', '01234567',
   '+441302000001', 'hello@state-a.example', '{"line1": "1 Test Street", "town": "Doncaster", "postcode": "DN1 1AA"}'::jsonb,
   'STA', '{"tagline": "Fixed right first time"}'::jsonb),
  ('b1000000-0000-4000-8000-000000000001', 'pgtap-state-b', 'State Garage B', null, null,
   null, null, null, 'STB', '{}'::jsonb);

insert into public.garage_members (garage_id, user_id, role) values
  ('a1000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-00000000000a', 'owner'),
  ('b1000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-00000000000b', 'owner');

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

insert into public.invoices (
  id, garage_id, status, source_type, customer_name, customer_email, vehicle_registration,
  service_name, appointment_start, issue_date, due_date, created_by, updated_by,
  issuer_legal_name, issuer_trading_name, issuer_tagline, issuer_address, issuer_email, issuer_phone, issuer_company_number
)
values
  (
    '21000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'draft', 'manual', 'Issued fixture',
    'issued@example.test', 'ST12ONE', 'Original service', '2080-03-01T09:00:00Z', '2080-03-01', '2080-03-08',
    '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-00000000000a',
    'Forged issuer', 'Forged', 'Forged', 'Forged', 'forged@example.test', '0', '0'
  ),
  (
    '21000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'draft', 'manual', 'Editable draft',
    'draft@example.test', 'ST12TWO', 'Draft service', '2080-03-02T09:00:00Z', '2080-03-02', '2080-03-09',
    '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-00000000000a',
    'x', 'x', 'x', 'x', 'x', 'x', 'x'
  ),
  (
    '21000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', 'draft', 'manual', 'Void fixture',
    'void@example.test', 'ST12THR', 'Void service', '2080-03-03T09:00:00Z', '2080-03-03', '2080-03-10',
    '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-00000000000a',
    'x', 'x', 'x', 'x', 'x', 'x', 'x'
  ),
  (
    '21000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000001', 'draft', 'manual', 'Empty invalid draft',
    'empty@example.test', 'ST12EMP', 'No lines', '2099-04-01T09:00:00Z', '2099-04-01', '2099-04-08',
    '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-00000000000a',
    'x', 'x', 'x', 'x', 'x', 'x', 'x'
  ),
  (
    '21000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-000000000001', 'draft', 'manual', 'Garage B draft',
    'b@example.test', 'ST12BBB', 'B service', '2080-05-01T09:00:00Z', '2080-05-01', '2080-05-08',
    '11000000-0000-4000-8000-00000000000b', '11000000-0000-4000-8000-00000000000b',
    'x', 'x', 'x', 'x', 'x', 'x', 'x'
  );

insert into public.invoice_items (id, garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence)
values
  ('31000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'Issued line', 1, 10000, 0),
  ('31000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002', 'Draft line', 1, 20000, 0),
  ('31000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000003', 'Void line', 1, 30000, 0),
  ('31000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-00000000000b', 'B line', 1, 5000, 0);

-- Issuer details come from the garage, not from the caller.
select is(
  (select issuer_legal_name from public.invoices where id = '21000000-0000-4000-8000-000000000001'),
  'State Garage A Limited', 'a draft takes its legal issuer name from the garage'
);
select is(
  (select issuer_address from public.invoices where id = '21000000-0000-4000-8000-000000000001'),
  E'1 Test Street\nDoncaster\nDN1 1AA', 'a draft takes its issuer address from the garage'
);
select is(
  (select issuer_tagline || ' / ' || issuer_email || ' / ' || issuer_phone || ' / ' || issuer_company_number
   from public.invoices where id = '21000000-0000-4000-8000-000000000001'),
  'Fixed right first time / hello@state-a.example / +441302000001 / 01234567', 'a draft takes its issuer contact details from the garage'
);
select is(
  (select issuer_legal_name || ' / ' || issuer_trading_name || ' / ' || issuer_address
   from public.invoices where id = '21000000-0000-4000-8000-00000000000b'),
  'State Garage B / State Garage B / ', 'a garage without a legal name issues under its trading name'
);

select pg_temp.act_as('11000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001');
set local role authenticated;

select lives_ok(
  $$select public.issue_invoice('21000000-0000-4000-8000-000000000001')$$,
  'owner can issue a valid draft through the guarded RPC'
);
select is(
  (select status::text from public.invoices where id = '21000000-0000-4000-8000-000000000001'),
  'issued',
  'issue RPC changes draft to issued'
);
select is(
  (select invoice_number from public.invoices where id = '21000000-0000-4000-8000-000000000001'),
  'STA-2080-000001',
  'issue RPC numbers the invoice <garage prefix>-YYYY-NNNNNN'
);
select throws_ok(
  $$select public.issue_invoice('21000000-0000-4000-8000-000000000004')$$,
  'P0001', 'INVOICE_ITEM_REQUIRED', 'an empty invalid draft is rejected before number allocation'
);
select throws_ok(
  $$select public.issue_invoice('21000000-0000-4000-8000-00000000000b')$$,
  'P0001', 'DRAFT_INVOICE_NOT_FOUND', 'owner A cannot issue garage B''s draft'
);

reset role;
select results_eq(
  $$select count(*) from public.invoice_number_sequences where invoice_year = 2099$$,
  array[0::bigint],
  'a rejected issue attempt does not consume or create a number sequence'
);

-- Issued history is frozen even when the garage's details change later.
update public.garages set legal_name = 'Renamed Garage A Limited' where id = 'a1000000-0000-4000-8000-000000000001';
select is(
  (select issuer_legal_name from public.invoices where id = '21000000-0000-4000-8000-000000000001'),
  'State Garage A Limited', 'an issued invoice keeps the issuer snapshot taken at issue'
);
update public.invoices set notes = 'Touch draft' where id = '21000000-0000-4000-8000-000000000002';
select is(
  (select issuer_legal_name from public.invoices where id = '21000000-0000-4000-8000-000000000002'),
  'Renamed Garage A Limited', 'a draft picks up the garage''s current issuer details when saved'
);

select throws_ok(
  $$update public.invoices set status = 'paid' where id = '21000000-0000-4000-8000-000000000002'$$,
  'P0001', 'INVALID_INVOICE_STATUS_TRANSITION', 'draft cannot transition directly to paid'
);
select throws_ok(
  $$insert into public.invoices (garage_id, status, invoice_number, invoice_year, invoice_sequence, source_type, customer_name, created_by, updated_by) values ('a1000000-0000-4000-8000-000000000001', 'paid', 'STA-2080-999999', 2080, 999999, 'manual', 'Invalid paid insert', '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-00000000000a')$$,
  'P0001', 'VALID_DRAFT_INSERT_REQUIRED', 'a non-draft invoice cannot be inserted directly'
);
select throws_ok(
  $$update public.invoices set invoice_number = 'STA-2080-999998' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'ISSUED_INVOICE_IS_IMMUTABLE', 'issued invoice number is immutable'
);
select throws_ok(
  $$update public.invoices set total_pence = 1 where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'ISSUED_INVOICE_IS_IMMUTABLE', 'issued invoice total is immutable'
);
select throws_ok(
  $$update public.invoices set tax_pence = 1 where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'ISSUED_INVOICE_IS_IMMUTABLE', 'issued invoice tax is immutable'
);
select throws_ok(
  $$update public.invoices set issuer_legal_name = 'Rewritten issuer' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'INVOICE_IDENTITY_IS_IMMUTABLE', 'issued legal issuer snapshot is immutable'
);
select throws_ok(
  $$update public.invoices set garage_id = 'b1000000-0000-4000-8000-000000000001' where id = '21000000-0000-4000-8000-000000000002'$$,
  'P0001', 'INVOICE_IDENTITY_IS_IMMUTABLE', 'an invoice cannot move to another garage'
);
select throws_ok(
  $$update public.invoices set customer_name = 'Rewritten customer' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'ISSUED_INVOICE_IS_IMMUTABLE', 'issued customer snapshot is immutable'
);
select throws_ok(
  $$update public.invoices set service_name = 'Rewritten service' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'ISSUED_INVOICE_IS_IMMUTABLE', 'issued service snapshot is immutable'
);
select throws_ok(
  $$update public.invoices set appointment_start = '2080-04-01T09:00:00Z' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'ISSUED_INVOICE_IS_IMMUTABLE', 'issued appointment snapshot is immutable'
);
select throws_ok(
  $$update public.invoices set issue_date = '2080-04-01' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'ISSUED_INVOICE_IS_IMMUTABLE', 'issued date is immutable'
);
select throws_ok(
  $$update public.invoice_items set quantity = 2 where id = '31000000-0000-4000-8000-000000000001'$$,
  'P0001', 'INVOICE_ITEMS_ARE_IMMUTABLE', 'issued item quantity is immutable'
);
select throws_ok(
  $$update public.invoice_items set invoice_id = '21000000-0000-4000-8000-000000000002' where id = '31000000-0000-4000-8000-000000000001'$$,
  'P0001', 'INVOICE_ITEM_PARENT_IS_IMMUTABLE', 'issued item cannot be re-parented to a draft'
);
select throws_ok(
  $$delete from public.invoice_items where id = '31000000-0000-4000-8000-000000000001'$$,
  'P0001', 'INVOICE_ITEMS_ARE_IMMUTABLE', 'issued item cannot be deleted'
);
select throws_ok(
  $$delete from public.invoices where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'ONLY_DRAFT_INVOICES_CAN_BE_DELETED', 'issued invoice cannot be deleted'
);

-- Garage B cannot move garage A's invoices through the state machine.
select pg_temp.act_as('11000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$select public.mark_invoice_paid('21000000-0000-4000-8000-000000000001', '2080-03-05T12:00:00Z', 'card', 'HIJACK')$$,
  'P0001', 'ISSUED_INVOICE_NOT_FOUND', 'owner B cannot mark garage A''s invoice paid'
);
select throws_ok(
  $$select public.void_invoice('21000000-0000-4000-8000-000000000001')$$,
  'P0001', 'ISSUED_INVOICE_NOT_FOUND', 'owner B cannot void garage A''s invoice'
);
select throws_ok(
  $$select public.create_invoice_correction('21000000-0000-4000-8000-000000000001')$$,
  'P0001', 'ISSUED_INVOICE_NOT_FOUND', 'owner B cannot correct garage A''s invoice'
);
select lives_ok(
  $$select public.issue_invoice('21000000-0000-4000-8000-00000000000b')$$,
  'owner B can issue garage B''s own draft'
);
select is(
  (select invoice_number from public.invoices where id = '21000000-0000-4000-8000-00000000000b'),
  'STB-2080-000001',
  'each garage numbers its invoices independently'
);
reset role;

select is(
  (select status::text from public.invoices where id = '21000000-0000-4000-8000-000000000001'),
  'issued', 'garage A''s invoice is unchanged by garage B''s attempts'
);

select pg_temp.act_as('11000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok(
  $$select public.mark_invoice_paid('21000000-0000-4000-8000-000000000001', '2080-03-05T12:00:00Z', 'card', 'LOCAL-TEST')$$,
  'issued invoice can transition to paid through the guarded RPC'
);
reset role;

select throws_ok(
  $$update public.invoices set status = 'draft' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'INVALID_INVOICE_STATUS_TRANSITION', 'paid invoice cannot return to draft'
);
select throws_ok(
  $$update public.invoices set status = 'issued' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'INVALID_INVOICE_STATUS_TRANSITION', 'paid invoice cannot return to issued'
);
select throws_ok(
  $$update public.invoices set status = 'void' where id = '21000000-0000-4000-8000-000000000001'$$,
  'P0001', 'INVALID_INVOICE_STATUS_TRANSITION', 'paid invoice cannot transition to void'
);

select pg_temp.act_as('11000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok(
  $$select public.issue_invoice('21000000-0000-4000-8000-000000000003')$$,
  'second valid draft can be issued'
);
select is(
  (select invoice_number from public.invoices where id = '21000000-0000-4000-8000-000000000003'),
  'STA-2080-000002',
  'garage A''s second invoice continues its own sequence'
);
select lives_ok(
  $$select public.void_invoice('21000000-0000-4000-8000-000000000003')$$,
  'issued invoice can transition to void through the guarded RPC'
);
reset role;

select throws_ok(
  $$update public.invoices set status = 'paid' where id = '21000000-0000-4000-8000-000000000003'$$,
  'P0001', 'INVALID_INVOICE_STATUS_TRANSITION', 'void invoice cannot transition to paid'
);
select throws_ok(
  $$update public.invoices set status = 'draft' where id = '21000000-0000-4000-8000-000000000003'$$,
  'P0001', 'INVALID_INVOICE_STATUS_TRANSITION', 'void invoice cannot return to draft'
);

select pg_temp.act_as('11000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok(
  $$select public.duplicate_invoice_to_draft('21000000-0000-4000-8000-000000000001')$$,
  'paid invoice can be duplicated into a correction draft'
);
select results_eq(
  $$select count(*) from public.invoices where replaces_invoice_id = '21000000-0000-4000-8000-000000000001' and status = 'draft'$$,
  array[1::bigint],
  'correction workflow creates one linked draft'
);
reset role;

select lives_ok(
  $$delete from public.invoices where id = '21000000-0000-4000-8000-000000000002'$$,
  'draft invoice can be deleted'
);
select results_eq(
  $$select count(*) from public.invoices where id = '21000000-0000-4000-8000-000000000002'$$,
  array[0::bigint],
  'deleted draft is removed'
);

-- Deleting a garage removes its whole invoice history, issued or not.
delete from public.garages where id = 'b1000000-0000-4000-8000-000000000001';
select results_eq(
  $$select count(*) from public.invoices where garage_id = 'b1000000-0000-4000-8000-000000000001'$$,
  array[0::bigint],
  'deleting a garage cascades through its issued invoices'
);

select * from finish();
rollback;
