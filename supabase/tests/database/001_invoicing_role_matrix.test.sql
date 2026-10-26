begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(87);

-- These tests exercise invoice authorization, not MFA enrollment. The fixture
-- owners have no TOTP factor, so switch off mandatory owner MFA inside this
-- transaction only.
update public.admin_mfa_policy
set mandatory_mfa_enabled = false
where singleton;

-- ---------------------------------------------------------------------------
-- Privilege matrix
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.invoices'::regclass), 'invoices has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.invoice_items'::regclass), 'invoice_items has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.invoice_email_sends'::regclass), 'invoice_email_sends has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.invoice_email_attempts'::regclass), 'invoice_email_attempts has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.invoice_number_sequences'::regclass), 'invoice_number_sequences has RLS enabled');

select ok(not has_table_privilege('anon', 'public.invoices', 'select'), 'anon cannot read invoices');
select ok(not has_table_privilege('anon', 'public.invoice_items', 'select'), 'anon cannot read invoice items');
select ok(not has_table_privilege('anon', 'public.invoice_email_sends', 'select'), 'anon cannot read email sends');
select ok(not has_table_privilege('anon', 'public.invoice_email_attempts', 'select'), 'anon cannot read email attempts');
select ok(not has_table_privilege('anon', 'public.invoice_number_sequences', 'select'), 'anon cannot read invoice sequences');

select ok(has_table_privilege('authenticated', 'public.invoices', 'select'), 'authenticated receives invoice read privilege subject to RLS');
select ok(has_table_privilege('authenticated', 'public.invoice_items', 'select'), 'authenticated receives item read privilege subject to RLS');
select ok(has_table_privilege('authenticated', 'public.invoice_email_sends', 'select'), 'authenticated receives email-send read privilege subject to RLS');
select ok(has_table_privilege('authenticated', 'public.invoice_email_attempts', 'select'), 'authenticated receives email-attempt read privilege subject to RLS');
select ok(not has_table_privilege('authenticated', 'public.invoice_number_sequences', 'select'), 'authenticated cannot inspect number sequences');

select ok(not has_table_privilege('authenticated', 'public.invoices', 'insert'), 'authenticated cannot insert invoices directly');
select ok(not has_table_privilege('authenticated', 'public.invoices', 'update'), 'authenticated cannot update invoices directly');
select ok(not has_table_privilege('authenticated', 'public.invoices', 'delete'), 'authenticated cannot delete invoices directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_items', 'insert'), 'authenticated cannot insert invoice items directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_items', 'update'), 'authenticated cannot update invoice items directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_items', 'delete'), 'authenticated cannot delete invoice items directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_email_sends', 'insert'), 'authenticated cannot insert email sends directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_email_sends', 'update'), 'authenticated cannot update email sends directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_email_sends', 'delete'), 'authenticated cannot delete email sends directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_email_attempts', 'insert'), 'authenticated cannot insert email attempts directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_email_attempts', 'update'), 'authenticated cannot update email attempts directly');
select ok(not has_table_privilege('authenticated', 'public.invoice_email_attempts', 'delete'), 'authenticated cannot delete email attempts directly');

select ok(has_table_privilege('service_role', 'public.invoices', 'select'), 'service role can read invoices for server workflows');
select ok(has_table_privilege('service_role', 'public.invoice_items', 'select'), 'service role can read invoice items for server workflows');
select ok(has_table_privilege('service_role', 'public.invoice_email_sends', 'select'), 'service role can read email sends');
select ok(has_table_privilege('service_role', 'public.invoice_email_attempts', 'select'), 'service role can read email attempts');
select ok(not has_table_privilege('service_role', 'public.invoice_number_sequences', 'select'), 'service role cannot inspect number sequences');
select ok(not has_table_privilege('service_role', 'public.invoices', 'insert'), 'service role cannot insert invoices directly');
select ok(not has_table_privilege('service_role', 'public.invoices', 'update'), 'service role cannot update invoices directly');
select ok(not has_table_privilege('service_role', 'public.invoices', 'delete'), 'service role cannot delete invoices directly');
select ok(not has_table_privilege('service_role', 'public.invoice_items', 'insert'), 'service role cannot insert invoice items directly');
select ok(not has_table_privilege('service_role', 'public.invoice_items', 'update'), 'service role cannot update invoice items directly');
select ok(not has_table_privilege('service_role', 'public.invoice_items', 'delete'), 'service role cannot delete invoice items directly');
select ok(not has_table_privilege('service_role', 'public.invoice_email_sends', 'insert'), 'service role cannot insert email sends directly');
select ok(not has_table_privilege('service_role', 'public.invoice_email_sends', 'update'), 'service role cannot update email sends directly');
select ok(not has_table_privilege('service_role', 'public.invoice_email_sends', 'delete'), 'service role cannot delete email sends directly');
select ok(not has_table_privilege('service_role', 'public.invoice_email_attempts', 'insert'), 'service role cannot insert email attempts directly');
select ok(not has_table_privilege('service_role', 'public.invoice_email_attempts', 'update'), 'service role cannot update email attempts directly');
select ok(not has_table_privilege('service_role', 'public.invoice_email_attempts', 'delete'), 'service role cannot delete email attempts directly');
select ok(not has_sequence_privilege('anon', 'public.invoice_email_attempts_id_seq', 'usage'), 'anon cannot allocate email-attempt identities');
select ok(not has_sequence_privilege('authenticated', 'public.invoice_email_attempts_id_seq', 'usage'), 'authenticated cannot allocate email-attempt identities');
select ok(not has_sequence_privilege('service_role', 'public.invoice_email_attempts_id_seq', 'usage'), 'service role cannot allocate email-attempt identities directly');
select ok(has_table_privilege('authenticated', 'public.admin_audit_log', 'select'), 'authenticated staff can read audit evidence through RLS');
select ok(has_function_privilege('authenticated', 'public.save_invoice_draft(uuid,jsonb,boolean)', 'execute'), 'authenticated callers can enter the guarded draft RPC');
select ok(has_function_privilege('authenticated', 'public.get_invoice_dashboard(text,text,date,integer,integer)', 'execute'), 'authenticated callers can enter the guarded dashboard RPC');
select ok(not has_function_privilege('anon', 'public.get_invoice_dashboard(text,text,date,integer,integer)', 'execute'), 'anonymous callers cannot query the invoice dashboard RPC');
select ok(not has_function_privilege('service_role', 'public.get_invoice_dashboard(text,text,date,integer,integer)', 'execute'), 'service role cannot bypass the authenticated dashboard RPC');
select ok(not has_function_privilege('authenticated', 'public.finalize_invoice_email_send(uuid,bigint,uuid,text)', 'execute'), 'authenticated callers cannot finalize provider delivery');
select ok(not has_function_privilege('service_role', 'public.save_invoice_draft(uuid,jsonb,boolean)', 'execute'), 'service role cannot bypass the authenticated draft RPC');
select ok(has_function_privilege('service_role', 'public.finalize_invoice_email_send(uuid,bigint,uuid,text)', 'execute'), 'service role can finalize provider delivery');
select ok(has_function_privilege('service_role', 'public.fail_invoice_email_send(uuid,bigint,uuid,text,boolean,text)', 'execute'), 'service role can persist provider failure outcomes');

-- ---------------------------------------------------------------------------
-- Two garages, an owner of each, and a signed-in user who belongs to neither
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('10000000-0000-4000-8000-00000000000a', 'owner-a@pgtap.test', '{}'::jsonb),
  ('10000000-0000-4000-8000-00000000000b', 'owner-b@pgtap.test', '{}'::jsonb),
  ('10000000-0000-4000-8000-00000000000c', 'outsider@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix) values
  ('a0000000-0000-4000-8000-000000000001', 'pgtap-role-a', 'Role Matrix Garage A', 'RMA'),
  ('b0000000-0000-4000-8000-000000000001', 'pgtap-role-b', 'Role Matrix Garage B', 'RMB');

insert into public.garage_members (garage_id, user_id, role) values
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000000a', 'owner'),
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000000b', 'owner');

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

-- One draft with an item, an email send and an attempt in each garage.
insert into public.invoices (id, garage_id, status, source_type, customer_name, created_by, updated_by) values
  ('20000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', 'draft', 'manual', 'RLS fixture A',
   '10000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a'),
  ('20000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000001', 'draft', 'manual', 'RLS fixture B',
   '10000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b');

insert into public.invoice_items (id, garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence) values
  ('30000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-00000000000a', 'RLS item A', 1, 100, 0),
  ('30000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-00000000000b', 'RLS item B', 1, 100, 0);

insert into public.invoice_email_sends (
  id, garage_id, invoice_id, recipient, invoice_revision, document_status, document_number,
  payload_sha256, provider_idempotency_key, status, requested_by
) values
  ('40000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-00000000000a',
   'rls-a@example.test', 2, 'issued', 'RMA-2080-000001', repeat('a', 64), 'invoice-role-matrix-a', 'pending',
   '10000000-0000-4000-8000-00000000000a'),
  ('40000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-00000000000b',
   'rls-b@example.test', 2, 'issued', 'RMB-2080-000001', repeat('b', 64), 'invoice-role-matrix-b', 'pending',
   '10000000-0000-4000-8000-00000000000b');

insert into public.invoice_email_attempts (
  garage_id, logical_send_id, invoice_id, attempt_number, status, claim_token, lease_expires_at, attempted_by
) values
  ('a0000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a',
   1, 'pending', '50000000-0000-4000-8000-00000000000a', now() + interval '15 minutes', '10000000-0000-4000-8000-00000000000a'),
  ('b0000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-00000000000b',
   1, 'pending', '50000000-0000-4000-8000-00000000000b', now() + interval '15 minutes', '10000000-0000-4000-8000-00000000000b');

select throws_ok(
  $$insert into public.invoice_items (garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence)
    values ('b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-00000000000a', 'Cross-garage child', 1, 1, 0)$$,
  'P0001', 'INVOICE_NOT_FOUND', 'an invoice item cannot point at another garage''s invoice'
);

-- ---------------------------------------------------------------------------
-- Reads: a user who belongs to neither garage sees nothing, even with a header
-- ---------------------------------------------------------------------------

select pg_temp.act_as('10000000-0000-4000-8000-00000000000c', 'a0000000-0000-4000-8000-000000000001');
set local role authenticated;
select is(public.current_garage_id(), null::uuid, 'a forged garage header gives a non-member no garage');
select results_eq('select count(*) from public.invoices', array[0::bigint], 'non-member cannot see invoices');
select results_eq('select count(*) from public.invoice_items', array[0::bigint], 'non-member cannot see invoice items');
select results_eq('select count(*) from public.invoice_email_sends', array[0::bigint], 'non-member cannot see email sends');
select results_eq('select count(*) from public.invoice_email_attempts', array[0::bigint], 'non-member cannot see email attempts');
reset role;

-- ---------------------------------------------------------------------------
-- Reads: garage A's owner sees exactly garage A
-- ---------------------------------------------------------------------------

select pg_temp.act_as('10000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select id from public.invoices', array['20000000-0000-4000-8000-00000000000a'::uuid], 'owner A sees only garage A invoices');
select results_eq('select id from public.invoice_items', array['30000000-0000-4000-8000-00000000000a'::uuid], 'owner A sees only garage A items');
select results_eq('select id from public.invoice_email_sends', array['40000000-0000-4000-8000-00000000000a'::uuid], 'owner A sees only garage A email sends');
select results_eq('select logical_send_id from public.invoice_email_attempts', array['40000000-0000-4000-8000-00000000000a'::uuid], 'owner A sees only garage A email attempts');
reset role;

select pg_temp.act_as('10000000-0000-4000-8000-00000000000a', null);
set local role authenticated;
select results_eq('select count(*) from public.invoices', array[0::bigint], 'without a selected garage owner A sees no invoices');
reset role;

-- ---------------------------------------------------------------------------
-- Garage B's owner: zero rows from A whichever header is sent
-- ---------------------------------------------------------------------------

select pg_temp.act_as('10000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select count(*) from public.invoices', array[0::bigint], 'owner B sending garage A''s id sees no invoices');
select results_eq('select count(*) from public.invoice_items', array[0::bigint], 'owner B sending garage A''s id sees no items');
select results_eq('select count(*) from public.invoice_email_sends', array[0::bigint], 'owner B sending garage A''s id sees no email sends');
select results_eq('select count(*) from public.invoice_email_attempts', array[0::bigint], 'owner B sending garage A''s id sees no email attempts');
select throws_ok(
  $$select public.save_invoice_draft(null, '{"source_type":"manual","customer_name":"Forged header","items":[{"description":"Work","quantity":"1","unit_price_pence":"100"}]}'::jsonb, false)$$,
  '42501', 'UNAUTHORISED', 'owner B cannot act in garage A by sending its id'
);
reset role;

select pg_temp.act_as('10000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq(
  $$select count(*) from public.invoices where id = '20000000-0000-4000-8000-00000000000a'$$,
  array[0::bigint], 'owner B cannot read garage A''s invoice by id'
);
select results_eq('select id from public.invoices', array['20000000-0000-4000-8000-00000000000b'::uuid], 'owner B sees only garage B invoices');
select throws_ok(
  $$select public.issue_invoice('20000000-0000-4000-8000-00000000000a')$$,
  'P0001', 'DRAFT_INVOICE_NOT_FOUND', 'owner B cannot issue garage A''s draft'
);
select throws_ok(
  $$select public.save_invoice_draft('20000000-0000-4000-8000-00000000000a', '{"source_type":"manual","customer_name":"Hijack","items":[{"description":"Work","quantity":"1","unit_price_pence":"100"}]}'::jsonb, false)$$,
  'P0001', 'DRAFT_INVOICE_NOT_FOUND', 'owner B cannot rewrite garage A''s draft'
);
select throws_ok(
  $$select public.delete_invoice_draft('20000000-0000-4000-8000-00000000000a')$$,
  'P0001', 'DRAFT_INVOICE_NOT_FOUND', 'owner B cannot delete garage A''s draft'
);
select throws_ok(
  $$select public.duplicate_invoice_to_draft('20000000-0000-4000-8000-00000000000a')$$,
  'P0001', 'INVOICE_NOT_FOUND', 'owner B cannot duplicate garage A''s invoice'
);
select throws_ok(
  $$select public.claim_invoice_email_send('20000000-0000-4000-8000-00000000000a', 'hijack@example.test', gen_random_uuid(), 1, repeat('c', 64))$$,
  'P0001', 'ONLY_ISSUED_INVOICES_CAN_BE_EMAILED', 'owner B cannot email garage A''s invoice'
);
select is(
  public.manage_admin_trash('invoices', array['20000000-0000-4000-8000-00000000000a'::uuid], 'trash'),
  0, 'owner B cannot trash garage A''s invoice'
);
select is(
  (public.get_invoice_dashboard(null, null, null, 1, 25) ->> 'draft_count'),
  '1', 'owner B''s dashboard counts only garage B'
);
reset role;

select is(
  (select deleted_at from public.invoices where id = '20000000-0000-4000-8000-00000000000a'),
  null::timestamptz, 'garage A''s invoice is untouched'
);
select is(
  (select count(*)::integer from public.invoices where garage_id = 'a0000000-0000-4000-8000-000000000001'),
  1, 'garage A still has exactly its own invoice'
);

-- ---------------------------------------------------------------------------
-- Service-role delivery outcomes are scoped by the explicit garage argument
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
select throws_ok(
  $$select public.fail_invoice_email_send('b0000000-0000-4000-8000-000000000001',
      (select id from public.invoice_email_attempts where logical_send_id = '40000000-0000-4000-8000-00000000000a'),
      '50000000-0000-4000-8000-00000000000a', 'provider_rejected', false, null)$$,
  'P0001', 'EMAIL_ATTEMPT_NOT_FOUND', 'a delivery outcome for garage A cannot be recorded under garage B'
);
reset role;

-- ---------------------------------------------------------------------------
-- Garage context helpers
-- ---------------------------------------------------------------------------

select pg_temp.act_as('10000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001');
set local role authenticated;
select is(public.current_garage_id(), 'a0000000-0000-4000-8000-000000000001'::uuid, 'a member''s header selects the garage');
select is(public.current_garage_role(), 'owner', 'the member''s role is reported');
select is(public.garage_role('b0000000-0000-4000-8000-000000000001'), null, 'no role in a garage the user does not belong to');
reset role;

select * from finish();
rollback;
