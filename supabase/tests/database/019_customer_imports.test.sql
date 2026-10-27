begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

-- Customer import (P3.11): staff RPCs, consent rules, idempotency, garage
-- scoping, and the A37 retention rules.
--
-- Garage A: owner, manager, technician. Garage B: owner.

insert into auth.users (id, email, raw_user_meta_data) values
  ('11300000-0000-4000-8000-0000000000a1', 'import-owner-a@pgtap.test', '{}'::jsonb),
  ('11300000-0000-4000-8000-0000000000a2', 'import-manager-a@pgtap.test', '{}'::jsonb),
  ('11300000-0000-4000-8000-0000000000a3', 'import-technician-a@pgtap.test', '{}'::jsonb),
  ('11300000-0000-4000-8000-0000000000b1', 'import-owner-b@pgtap.test', '{}'::jsonb),
  ('11300000-0000-4000-8000-0000000000b2', 'import-manager-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix) values
  ('a1300000-0000-4000-8000-000000000001', 'pgtap-import-a', 'Import Garage A', 'IMA'),
  ('b1300000-0000-4000-8000-000000000001', 'pgtap-import-b', 'Import Garage B', 'IMB');

insert into public.garage_members (garage_id, user_id, role) values
  ('a1300000-0000-4000-8000-000000000001', '11300000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1300000-0000-4000-8000-000000000001', '11300000-0000-4000-8000-0000000000a2', 'manager'),
  ('a1300000-0000-4000-8000-000000000001', '11300000-0000-4000-8000-0000000000a3', 'technician'),
  ('b1300000-0000-4000-8000-000000000001', '11300000-0000-4000-8000-0000000000b1', 'owner'),
  ('b1300000-0000-4000-8000-000000000001', '11300000-0000-4000-8000-0000000000b2', 'manager');

-- Existing garage A customers: one opted out, one with booking consent, one
-- with no email; and an existing vehicle already checked against DVSA.
insert into public.customers (id, garage_id, name, email, phone, preferred_contact, reminder_consent, consent_at, consent_source, consent_text, opted_out_at) values
  ('a1300000-0000-4000-8000-000000000301', 'a1300000-0000-4000-8000-000000000001', 'Opted-out Olive', null, '+447700900311', 'phone', false, null, null, null, '2026-01-01 09:00+00'),
  ('a1300000-0000-4000-8000-000000000302', 'a1300000-0000-4000-8000-000000000001', 'Booked Ben', 'ben@example.test', '+447700900312', 'phone', true, '2026-01-02 09:00+00', 'booking', 'Remind me', null),
  ('a1300000-0000-4000-8000-000000000303', 'a1300000-0000-4000-8000-000000000001', 'No-email Nia', null, '+447700900313', 'phone', false, null, null, null, null),
  ('b1300000-0000-4000-8000-000000000301', 'b1300000-0000-4000-8000-000000000001', 'Garage B Bea', 'bea@example.test', '+447700900314', 'phone', false, null, null, null, null);
insert into public.vehicles (id, garage_id, customer_id, registration, mot_expiry, mot_checked_at) values
  ('a1300000-0000-4000-8000-000000000401', 'a1300000-0000-4000-8000-000000000001', 'a1300000-0000-4000-8000-000000000302', 'IM12OLD', '2027-05-01', now()),
  ('b1300000-0000-4000-8000-000000000401', 'b1300000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-000000000301', 'IM12BBB', null, null);

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

create temp table ids (label text primary key, id uuid not null);
grant all on ids to authenticated;

-- ---------------------------------------------------------------------------
-- Who may import
-- ---------------------------------------------------------------------------

select pg_temp.act_as('11300000-0000-4000-8000-0000000000a3', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$select public.start_customer_import('x.csv', '{}', null)$$,
  '42501', 'UNAUTHORISED', 'technicians cannot import customers'
);
reset role;

select pg_temp.act_as('11300000-0000-4000-8000-0000000000b1', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  $$select public.start_customer_import('x.csv', '{}', null)$$,
  '42501', 'UNAUTHORISED', 'garage B''s owner cannot import into garage A by forging x-garage-id'
);
reset role;

select pg_temp.act_as(null, 'a1300000-0000-4000-8000-000000000001');
set local role anon;
select throws_ok(
  $$select public.start_customer_import('x.csv', '{}', null)$$,
  '42501', null, 'anon cannot call the import RPCs'
);
reset role;

select ok(
  not has_function_privilege('authenticated', 'public.require_customer_import_actor()', 'execute'),
  'the actor check is internal'
);
select ok(
  not has_table_privilege('authenticated', 'public.customer_imports', 'insert')
  and not has_table_privilege('authenticated', 'public.customer_imports', 'update')
  and not has_table_privilege('authenticated', 'public.customer_imports', 'delete')
  and not has_table_privilege('anon', 'public.customer_imports', 'select'),
  'staff only read customer_imports; anon has nothing'
);

-- ---------------------------------------------------------------------------
-- An import with the declaration ticked (manager)
-- ---------------------------------------------------------------------------

select pg_temp.act_as('11300000-0000-4000-8000-0000000000a2', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;

insert into ids values ('declared', public.start_customer_import(
  'customers.csv',
  '{"total_rows": 8, "valid_rows": 7, "invalid_rows": 1, "duplicate_rows": 0, "errors": [{"row": 9, "field": "mobile", "message": "Not a UK mobile"}]}',
  'I confirm these customers gave their details to Import Garage A ...'
));

select is(
  (select status || '/' || total_rows || '/' || invalid_rows || '/' || jsonb_array_length(errors) from public.customer_imports where id = (select id from ids where label = 'declared')),
  'importing/8/1/1', 'start_customer_import() records the file summary and errors'
);
select ok(
  (select declaration_accepted_at is not null and created_by = '11300000-0000-4000-8000-0000000000a2' and garage_id = 'a1300000-0000-4000-8000-000000000001'
   from public.customer_imports where id = (select id from ids where label = 'declared')),
  'the import belongs to the selected garage, names its author and when the declaration was accepted'
);

select is(
  public.import_customer_rows((select id from ids where label = 'declared'), '[
    {"name": "New Nora", "phone": "+447700900321", "email": "Nora@Example.test", "registration": "IM21NEW", "consent": true},
    {"name": "New Nora again", "phone": "+447700900321", "email": null, "registration": "IM21TWO", "consent": false},
    {"name": "Quiet Quinn", "phone": "+447700900322", "email": null, "registration": null, "consent": false},
    {"name": "Olive Import", "phone": "+447700900311", "email": "olive@example.test", "registration": "IM21OPT", "consent": true},
    {"name": "Ben Import", "phone": "+447700900312", "email": "other@example.test", "registration": "IM12OLD", "consent": true},
    {"name": "Nia Import", "phone": "+447700900313", "email": "nia@example.test", "registration": "IM21NIA", "consent": true},
    {"name": "Bea Import", "phone": "+447700900314", "email": null, "registration": "IM12BBB", "consent": true}
  ]'::jsonb),
  '{"rows": 7, "customers_created": 3, "customers_updated": 3, "vehicles_created": 5, "vehicles_updated": 1, "consent_recorded": 3}'::jsonb,
  'a batch upserts customers by phone and vehicles by registration and reports the counts'
);
reset role;

select is(
  (select count(*)::integer from public.customers where garage_id = 'a1300000-0000-4000-8000-000000000001' and phone = '+447700900321'),
  1, 'two rows with one phone make one customer'
);
select is(
  (select name || '/' || email || '/' || consent_source from public.customers where phone = '+447700900321'),
  'New Nora/nora@example.test/import', 'the first row names the customer; email lower-cased; consent source import'
);
select is(
  (select consent_text from public.customers where phone = '+447700900321'),
  'I confirm these customers gave their details to Import Garage A ...', 'consent_text is the declaration'
);
select is(
  (select count(*)::integer from public.vehicles v join public.customers c on c.garage_id = v.garage_id and c.id = v.customer_id where c.phone = '+447700900321'),
  2, 'both of the customer''s cars are linked to them'
);
select is(
  (select reminder_consent from public.customers where phone = '+447700900322'),
  false, 'a row whose consent column says no records no consent'
);
select ok(
  (select opted_out_at = '2026-01-01 09:00+00' and not reminder_consent and consent_source is null
   from public.customers where id = 'a1300000-0000-4000-8000-000000000301'),
  'an opted-out customer stays opted out and gains no consent'
);
select ok(
  (select name = 'Booked Ben' and email = 'ben@example.test' and consent_source = 'booking' and consent_text = 'Remind me'
   from public.customers where id = 'a1300000-0000-4000-8000-000000000302'),
  'an existing customer keeps their name, email and earlier consent record'
);
select ok(
  (select email = 'nia@example.test' and reminder_consent and consent_source = 'import'
   from public.customers where id = 'a1300000-0000-4000-8000-000000000303'),
  'an existing customer without consent gains it and a missing email is filled in'
);
select ok(
  (select customer_id = (select id from public.customers where phone = '+447700900312' and garage_id = 'a1300000-0000-4000-8000-000000000001')
     and enrichment_status is null and mot_expiry = '2027-05-01'
   from public.vehicles where id = 'a1300000-0000-4000-8000-000000000401'),
  'an existing, already checked vehicle keeps its MOT data and is not queued again'
);
select is(
  (select count(*)::integer from public.vehicles where garage_id = 'a1300000-0000-4000-8000-000000000001' and enrichment_status = 'pending'
     and import_id = (select id from ids where label = 'declared')),
  5, 'new vehicles are queued for enrichment against the import'
);
select is(
  (select count(*)::integer from public.customers where garage_id = 'a1300000-0000-4000-8000-000000000001' and phone = '+447700900314'),
  1, 'a phone that exists only in garage B becomes a new garage A customer'
);
select ok(
  (select name = 'Garage B Bea' and not reminder_consent from public.customers where id = 'b1300000-0000-4000-8000-000000000301')
  and (select customer_id = 'b1300000-0000-4000-8000-000000000301' from public.vehicles where id = 'b1300000-0000-4000-8000-000000000401'),
  'garage B''s customer and vehicle are untouched'
);
select is(
  (select count(*)::integer from public.vehicles where registration = 'IM12BBB'),
  2, 'the same registration can exist once in each garage'
);

-- Running the same batch again is idempotent.
select pg_temp.act_as('11300000-0000-4000-8000-0000000000a2', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;
create temp table before_rerun as
  select (select count(*) from public.customers where garage_id = 'a1300000-0000-4000-8000-000000000001') as customers,
         (select count(*) from public.vehicles where garage_id = 'a1300000-0000-4000-8000-000000000001') as vehicles;
select is(
  public.import_customer_rows((select id from ids where label = 'declared'), '[
    {"name": "New Nora", "phone": "+447700900321", "email": "nora@example.test", "registration": "IM21NEW", "consent": true},
    {"name": "Quiet Quinn", "phone": "+447700900322", "email": null, "registration": null, "consent": false}
  ]'::jsonb) ->> 'customers_created',
  '0', 'a repeated batch creates nothing'
);
select is(
  (select customers || '/' || vehicles from before_rerun),
  (select (select count(*) from public.customers where garage_id = 'a1300000-0000-4000-8000-000000000001') || '/'
        || (select count(*) from public.vehicles where garage_id = 'a1300000-0000-4000-8000-000000000001')),
  'customer and vehicle counts are unchanged by the repeat'
);

select throws_ok(
  format($$select public.import_customer_rows(%L, '[{"name": "Bad", "phone": "07700900123", "registration": null}]')$$, (select id from ids where label = 'declared')),
  'P0001', 'INVALID_IMPORT_ROWS', 'rows must carry an E.164 phone'
);
select throws_ok(
  format($$select public.import_customer_rows(%L, '[{"name": "Bad", "phone": "+447700900399", "registration": "ab 12"}]')$$, (select id from ids where label = 'declared')),
  'P0001', 'INVALID_IMPORT_ROWS', 'rows must carry a normalised registration'
);
select throws_ok(
  format($$select public.import_customer_rows(%L, '[]')$$, (select id from ids where label = 'declared')),
  'P0001', 'INVALID_IMPORT_ROWS', 'an empty batch is refused'
);

select is(
  (public.finish_customer_import((select id from ids where label = 'declared'), 'completed')).status,
  'completed', 'finish_customer_import() closes the import'
);
select is(
  (public.finish_customer_import((select id from ids where label = 'declared'), 'failed')).status,
  'completed', 'closing twice keeps the first outcome'
);
select throws_ok(
  format($$select public.import_customer_rows(%L, '[{"name": "Late", "phone": "+447700900398", "registration": null}]')$$, (select id from ids where label = 'declared')),
  'P0001', 'IMPORT_CLOSED', 'a closed import takes no more rows'
);
select is(
  (select imported_rows || '/' || customers_created || '/' || consent_recorded from public.customer_imports where id = (select id from ids where label = 'declared')),
  '9/3/3', 'the import keeps running totals'
);

-- ---------------------------------------------------------------------------
-- An import without the declaration records no consent
-- ---------------------------------------------------------------------------

select pg_temp.act_as('11300000-0000-4000-8000-0000000000a2', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;
insert into ids values ('undeclared', public.start_customer_import('no-consent.csv', '{"total_rows": 1, "valid_rows": 1}', null));
select is(
  public.import_customer_rows((select id from ids where label = 'undeclared'), '[
    {"name": "Unticked Uma", "phone": "+447700900331", "email": null, "registration": "IM21UMA", "consent": true}
  ]'::jsonb) ->> 'consent_recorded',
  '0', 'without the declaration no consent is recorded'
);
reset role;
select ok(
  (select not reminder_consent and consent_at is null and consent_text is null from public.customers where phone = '+447700900331'),
  'the customer has no consent record'
);

-- Garage B's manager cannot add rows to garage A's import, even with its id.
select pg_temp.act_as('11300000-0000-4000-8000-0000000000b2', 'b1300000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  format($$select public.import_customer_rows(%L, '[{"name": "Planted", "phone": "+447700900397", "registration": null}]')$$, (select id from ids where label = 'undeclared')),
  'P0001', 'IMPORT_NOT_FOUND', 'another garage''s import is not found'
);
select is(
  (select count(*)::integer from public.customer_imports where garage_id = 'a1300000-0000-4000-8000-000000000001'),
  0, 'garage B''s manager reads none of garage A''s imports'
);
reset role;

-- ---------------------------------------------------------------------------
-- Retention (A37)
-- ---------------------------------------------------------------------------

-- A long-inactive imported customer without consent, a long-inactive one with
-- live consent, one whose consent was withdrawn, and a recent import.
insert into public.customers (id, garage_id, name, phone, preferred_contact, reminder_consent, consent_at, consent_source, opted_out_at, created_at, updated_at) values
  ('a1300000-0000-4000-8000-000000000351', 'a1300000-0000-4000-8000-000000000001', 'Old No-consent', '+447700900351', 'phone', false, null, null, null, now() - interval '25 months', now() - interval '25 months'),
  ('a1300000-0000-4000-8000-000000000352', 'a1300000-0000-4000-8000-000000000001', 'Old Consented', '+447700900352', 'phone', true, now() - interval '25 months', 'import', null, now() - interval '25 months', now() - interval '25 months'),
  ('a1300000-0000-4000-8000-000000000353', 'a1300000-0000-4000-8000-000000000001', 'Old Opted-out', '+447700900353', 'phone', true, now() - interval '25 months', 'import', now() - interval '25 months', now() - interval '25 months', now() - interval '25 months');

set local role service_role;
select is(
  public.apply_enquiry_retention('a1300000-0000-4000-8000-000000000001'),
  2, 'retention anonymises only the two long-inactive customers without live consent'
);
reset role;
select is(
  (select name from public.customers where id = 'a1300000-0000-4000-8000-000000000351'),
  'Anonymised', 'a customer inactive for 24 months with no consent is anonymised'
);
select is(
  (select name from public.customers where id = 'a1300000-0000-4000-8000-000000000353'),
  'Anonymised', 'an opted-out customer inactive for 24 months is anonymised'
);
select is(
  (select name from public.customers where id = 'a1300000-0000-4000-8000-000000000352'),
  'Old Consented', 'a customer with live reminder consent is kept'
);
select is(
  (select count(*)::integer from public.customers where garage_id = 'a1300000-0000-4000-8000-000000000001' and import_id is not null and anonymised_at is null),
  4, 'freshly imported customers survive retention'
);

select * from finish();
rollback;
