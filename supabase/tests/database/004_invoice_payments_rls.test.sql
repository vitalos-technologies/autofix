begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

update public.admin_mfa_policy
set mandatory_mfa_enabled = false
where singleton;

select ok((select relrowsecurity from pg_class where oid = 'public.invoice_payments'::regclass), 'invoice_payments has RLS enabled');
select ok(not has_table_privilege('anon', 'public.invoice_payments', 'select'), 'anon cannot read invoice payments');
select ok(has_table_privilege('authenticated', 'public.invoice_payments', 'select'), 'authenticated reads are subject to garage RLS');
select ok(not has_table_privilege('authenticated', 'public.invoice_payments', 'insert'), 'authenticated cannot insert payments directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_payments', 'update'), 'authenticated cannot update payments directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_payments', 'delete'), 'authenticated cannot delete payments directly');
select ok(has_table_privilege('service_role', 'public.invoice_payments', 'select'), 'service role can read payments for server rendering');
select ok(not has_table_privilege('service_role', 'public.invoice_payments', 'insert'), 'service role cannot insert payments directly');
select ok(not has_table_privilege('service_role', 'public.invoice_payments', 'update'), 'service role cannot update payments directly');
select ok(not has_table_privilege('service_role', 'public.invoice_payments', 'delete'), 'service role cannot delete payments directly');
select ok(has_function_privilege('authenticated', 'public.record_invoice_payment(uuid,bigint,timestamptz,text,text)', 'execute'), 'authenticated callers can enter the guarded payment RPC');
select ok(not has_function_privilege('anon', 'public.record_invoice_payment(uuid,bigint,timestamptz,text,text)', 'execute'), 'anonymous callers cannot record payments');
select ok(not has_function_privilege('service_role', 'public.record_invoice_payment(uuid,bigint,timestamptz,text,text)', 'execute'), 'service role cannot bypass the guarded payment RPC');
select ok(has_function_privilege('authenticated', 'public.create_invoice_correction(uuid)', 'execute'), 'authenticated callers can enter the guarded correction RPC');
select ok(not has_function_privilege('anon', 'public.create_invoice_correction(uuid)', 'execute'), 'anonymous callers cannot create corrections');
select ok(not has_function_privilege('service_role', 'public.create_invoice_correction(uuid)', 'execute'), 'service role cannot bypass the guarded correction RPC');

-- Part payments stay inside their garage.
insert into auth.users (id, email, raw_user_meta_data) values
  ('14000000-0000-4000-8000-00000000000a', 'payments-owner-a@pgtap.test', '{}'::jsonb),
  ('14000000-0000-4000-8000-00000000000b', 'payments-owner-b@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix) values
  ('a4000000-0000-4000-8000-000000000001', 'pgtap-pay-a', 'Payments Garage A', 'PYA'),
  ('b4000000-0000-4000-8000-000000000001', 'pgtap-pay-b', 'Payments Garage B', 'PYB');
insert into public.garage_members (garage_id, user_id, role) values
  ('a4000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-00000000000a', 'owner'),
  ('b4000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-00000000000b', 'technician');

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

insert into public.invoices (id, garage_id, status, source_type, customer_name, issue_date, created_by, updated_by) values
  ('24000000-0000-4000-8000-00000000000a', 'a4000000-0000-4000-8000-000000000001', 'draft', 'manual', 'Payments fixture', '2082-02-01',
   '14000000-0000-4000-8000-00000000000a', '14000000-0000-4000-8000-00000000000a');
insert into public.invoice_items (garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence) values
  ('a4000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-00000000000a', 'Work', 1, 1000, 0);

select pg_temp.act_as('14000000-0000-4000-8000-00000000000a', 'a4000000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok($$select public.issue_invoice('24000000-0000-4000-8000-00000000000a')$$, 'owner A issues the fixture');
select lives_ok(
  $$select public.record_invoice_payment('24000000-0000-4000-8000-00000000000a', 400, '2082-02-02T10:00:00Z', 'card', 'part')$$,
  'owner A records a part payment'
);
reset role;

select pg_temp.act_as('14000000-0000-4000-8000-00000000000b', 'b4000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$select public.record_invoice_payment('24000000-0000-4000-8000-00000000000a', 600, '2082-02-03T10:00:00Z', 'cash', 'hijack')$$,
  'P0001', 'ISSUED_INVOICE_NOT_FOUND', 'garage B staff cannot record a payment on garage A''s invoice'
);
select results_eq('select count(*) from public.invoice_payments', array[0::bigint], 'garage B staff see none of garage A''s payments');
reset role;

select results_eq(
  $$select sum(amount_pence)::bigint from public.invoice_payments where invoice_id = '24000000-0000-4000-8000-00000000000a'$$,
  array[400::bigint], 'only garage A''s payment was recorded'
);
select is(
  (select garage_id from public.invoice_payments where invoice_id = '24000000-0000-4000-8000-00000000000a'),
  'a4000000-0000-4000-8000-000000000001'::uuid, 'the payment carries garage A''s id'
);

select * from finish();
rollback;
