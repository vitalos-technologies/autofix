begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

-- P4.9 legal records: garage_agreements (DPA acceptance), opt_out_customer()
-- and resume_customer_reminders().

insert into auth.users (id, email, raw_user_meta_data) values
  ('13000000-0000-4000-8000-0000000000a1', 'legal-owner-a@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000a2', 'legal-manager-a@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000b1', 'legal-owner-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix) values
  ('a1300000-0000-4000-8000-000000000001', 'pgtap-legal-a', 'Legal Garage A', 'LGA'),
  ('b1300000-0000-4000-8000-000000000001', 'pgtap-legal-b', 'Legal Garage B', 'LGB');

insert into public.garage_members (garage_id, user_id, role) values
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a2', 'manager'),
  ('b1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000b1', 'owner');

insert into public.customers (id, garage_id, name, preferred_contact, phone, reminder_consent, consent_at, consent_source, consent_text) values
  ('c1300000-0000-4000-8000-0000000000a1', 'a1300000-0000-4000-8000-000000000001', 'Customer A', 'phone', '+447700900131', true, now(), 'booking', 'Remind me'),
  ('c1300000-0000-4000-8000-0000000000b1', 'b1300000-0000-4000-8000-000000000001', 'Customer B', 'phone', '+447700900131', false, null, null, null);

-- ---------------------------------------------------------------------------
-- Structure and grants
-- ---------------------------------------------------------------------------

select has_table('public', 'garage_agreements', 'garage_agreements exists');
select ok((select relrowsecurity from pg_class where oid = 'public.garage_agreements'::regclass), 'garage_agreements has RLS on');
select ok(obj_description('public.garage_agreements'::regclass, 'pg_class') is not null, 'garage_agreements has a table comment');
select ok(not has_table_privilege('anon', 'public.garage_agreements', 'select'), 'anon cannot read agreements');
select ok(not has_table_privilege('authenticated', 'public.garage_agreements', 'insert'), 'staff cannot insert agreements directly');
select ok(not has_table_privilege('authenticated', 'public.garage_agreements', 'update'), 'staff cannot update agreements');
select ok(not has_table_privilege('authenticated', 'public.garage_agreements', 'delete'), 'staff cannot delete agreements');
select ok(
  not has_function_privilege('authenticated', 'public.accept_garage_agreement(uuid, uuid, text, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.accept_garage_agreement(uuid, uuid, text, text, text, text)', 'execute'),
  'accept_garage_agreement is service-role only'
);
select ok(
  not has_function_privilege('authenticated', 'public.opt_out_customer(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.opt_out_customer(uuid, uuid, text, text)', 'execute'),
  'opt_out_customer is service-role only'
);
select ok(
  not has_function_privilege('authenticated', 'public.resume_customer_reminders(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.resume_customer_reminders(uuid, uuid, text)', 'execute'),
  'resume_customer_reminders is service-role only'
);

-- ---------------------------------------------------------------------------
-- accept_garage_agreement
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.accept_garage_agreement('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a2', 'dpa', '0.1', repeat('a', 64), 'Manager')$$,
  'P0001', 'AGREEMENT_FORBIDDEN: only a garage owner can accept agreements', 'a manager cannot accept the DPA'
);
select throws_ok(
  $$select public.accept_garage_agreement('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000b1', 'dpa', '0.1', repeat('a', 64), 'Other owner')$$,
  'P0001', 'AGREEMENT_FORBIDDEN: only a garage owner can accept agreements', 'another garage''s owner cannot accept for this garage'
);
select throws_ok(
  $$select public.accept_garage_agreement('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a1', 'terms', '0.1', repeat('a', 64), 'Owner')$$,
  '23514', null, 'unknown agreement kinds are refused'
);
select throws_ok(
  $$select public.accept_garage_agreement('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a1', 'dpa', '0.1', 'not-a-hash', 'Owner')$$,
  '23514', null, 'the text hash must be hex SHA-256'
);

select is(
  (select (public.accept_garage_agreement('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a1', 'dpa', '0.1', repeat('A', 64), 'Ann Owner')).accepted_by_name),
  'Ann Owner',
  'the owner accepts the DPA'
);
select is(
  (select (public.accept_garage_agreement('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a1', 'dpa', '0.1', repeat('b', 64), 'Someone else')).text_hash),
  repeat('a', 64),
  'accepting the same version again returns the first record (hash stored lower case)'
);
select is(
  (select count(*)::int from public.garage_agreements where garage_id = 'a1300000-0000-4000-8000-000000000001'),
  1,
  'one row per garage, kind and version'
);
select is(
  (select count(*)::int from public.admin_audit_log where garage_id = 'a1300000-0000-4000-8000-000000000001' and action = 'agreement.accepted'),
  1,
  'acceptance is audited once'
);

-- Staff read only their own garage's agreements through RLS.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"13000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
select set_config('request.headers', '{"x-garage-id":"a1300000-0000-4000-8000-000000000001"}', true);
select is((select count(*)::int from public.garage_agreements), 0, 'garage B''s owner forging garage A sees no agreements');
select set_config('request.jwt.claims', '{"sub":"13000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
select is((select count(*)::int from public.garage_agreements), 1, 'garage A''s manager reads garage A''s agreement');
reset role;

-- ---------------------------------------------------------------------------
-- opt_out_customer / resume_customer_reminders
-- ---------------------------------------------------------------------------

select is(
  public.opt_out_customer('b1300000-0000-4000-8000-000000000001', 'c1300000-0000-4000-8000-0000000000a1', null, 'unsubscribe_link'),
  '{"matched": false, "changed": false}'::jsonb,
  'another garage''s customer id matches nothing'
);
select ok(
  (select opted_out_at is null from public.customers where id = 'c1300000-0000-4000-8000-0000000000a1'),
  'and garage A''s customer is untouched'
);
select is(
  public.opt_out_customer('a1300000-0000-4000-8000-000000000001', 'c1300000-0000-4000-8000-0000000000a1', null, 'unsubscribe_link'),
  '{"matched": true, "changed": true}'::jsonb,
  'the signed link opts the customer out'
);
select is(
  public.opt_out_customer('a1300000-0000-4000-8000-000000000001', 'c1300000-0000-4000-8000-0000000000a1', null, 'unsubscribe_link'),
  '{"matched": true, "changed": false}'::jsonb,
  'opting out again is a no-op'
);
select is(
  (select count(*)::int from public.admin_audit_log where entity_id = 'c1300000-0000-4000-8000-0000000000a1' and action = 'customer.opted_out'),
  1,
  'the opt-out is audited once, for the garage'
);
select is(
  public.opt_out_customer('b1300000-0000-4000-8000-000000000001', null, '+447700900131', 'unsubscribe_form'),
  '{"matched": true, "changed": true}'::jsonb,
  'the form opts out by phone within the host garage only'
);
select is(
  public.opt_out_customer('b1300000-0000-4000-8000-000000000001', null, '+447700900999', 'unsubscribe_form'),
  '{"matched": false, "changed": false}'::jsonb,
  'an unknown number matches nothing'
);
select throws_ok(
  $$select public.opt_out_customer('a1300000-0000-4000-8000-000000000001', 'c1300000-0000-4000-8000-0000000000a1', '+447700900131', 'unsubscribe_form')$$,
  'P0001', 'INVALID_OPT_OUT: give a customer id or a phone number', 'id and phone together are refused'
);

select is(
  public.resume_customer_reminders('a1300000-0000-4000-8000-000000000001', 'c1300000-0000-4000-8000-0000000000a1', 'Turn reminders back on'),
  '{"changed": true}'::jsonb,
  'the customer turns reminders back on'
);
select ok(
  (select opted_out_at is null and reminder_consent and consent_source = 'unsubscribe_page' and consent_text = 'Turn reminders back on'
   from public.customers where id = 'c1300000-0000-4000-8000-0000000000a1'),
  'resuming clears the opt-out and records consent with the shown wording'
);

select * from finish();
rollback;
