begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(108);

-- Scheduling schema (P2.1): tables, constraints, grants, RLS and the removal
-- of the Cal.com leftovers. Slot maths is in 011, create_booking in 012.

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

select has_extension('btree_gist', 'btree_gist is installed for the no_overlap constraint');
select has_table('public', 'resources', 'resources exists');
select has_table('public', 'opening_hours', 'opening_hours exists');
select has_table('public', 'closures', 'closures exists');
select has_table('public', 'services', 'services exists');
select has_table('public', 'bookings', 'bookings exists');
select has_table('public', 'booking_events', 'booking_events exists');

select hasnt_table('public', 'booking_service_types', 'booking_service_types (Cal.com) is gone');
select hasnt_table('public', 'service_catalogue_systems', 'service_catalogue_systems is gone');
select hasnt_table('public', 'provider_webhook_events', 'provider_webhook_events (Cal.com) is gone');
select hasnt_function('public', 'create_booking_intent', 'create_booking_intent() (Cal.com) is gone');
select is(
  (select count(*)::integer from pg_type where typnamespace = 'public'::regnamespace and typname = 'booking_status'),
  0, 'the SOB booking_status enum is gone'
);
select is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public' and table_name = 'bookings'
     and (column_name like 'provider%' or column_name in ('booking_reference', 'appointment_start', 'service_type_id', 'service_name'))),
  0, 'bookings has no provider_* or SOB-shaped columns'
);
select is(
  (select count(*)::integer from information_schema.tables where table_schema = 'public' and table_name like 'calendly%'),
  0, 'no calendly_* tables'
);

select is(
  (select count(*)::integer
   from unnest(array['resources', 'opening_hours', 'closures', 'services', 'bookings', 'booking_events']) tenant_table(name)
   join information_schema.columns column_info
     on column_info.table_schema = 'public' and column_info.table_name = tenant_table.name and column_info.column_name = 'garage_id'
   where column_info.is_nullable = 'NO' and column_info.column_default = 'current_garage_id()'),
  6, 'every scheduling table has garage_id not null default current_garage_id()'
);
select is(
  (select count(*)::integer from pg_class
   where relnamespace = 'public'::regnamespace
     and relname = any(array['resources', 'opening_hours', 'closures', 'services', 'bookings', 'booking_events'])
     and relrowsecurity),
  6, 'RLS is enabled on every scheduling table'
);
select is(
  (select count(*)::integer from pg_constraint
   where contype = 'f' and conrelid = 'public.bookings'::regclass
     and confrelid = any(array['public.customers', 'public.vehicles', 'public.services', 'public.resources']::regclass[])
     and cardinality(conkey) = 2),
  4, 'bookings reaches customers, vehicles, services and resources through (garage_id, id)'
);
select is(
  (select count(*)::integer from pg_constraint
   where contype = 'f' and confrelid = 'public.bookings'::regclass and cardinality(conkey) = 2
     and conrelid = any(array['public.booking_events', 'public.booking_audit_log', 'public.booking_notification_events', 'public.enquiries', 'public.invoices']::regclass[])),
  5, 'booking_events and the SOB booking children reference bookings through (garage_id, id)'
);

select col_type_is('public', 'bookings', 'during', 'tstzrange', 'bookings.during is a tstzrange');
select col_type_is('public', 'bookings', 'starts_at', 'timestamp with time zone', 'bookings.starts_at is timestamptz');
select col_type_is('public', 'bookings', 'symptoms', 'text[]', 'bookings.symptoms is text[]');
select col_type_is('public', 'bookings', 'price_pence', 'integer', 'bookings.price_pence is integer pence');
select col_type_is('public', 'services', 'price_pence', 'integer', 'services.price_pence is integer pence');
select col_type_is('public', 'opening_hours', 'weekday', 'smallint', 'opening_hours.weekday is smallint');
select col_type_is('public', 'opening_hours', 'opens', 'time without time zone', 'opening_hours.opens is time');
select col_type_is('public', 'closures', 'starts_on', 'date', 'closures.starts_on is a date');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.bookings'::regclass and conname = 'no_overlap'),
  'EXCLUDE USING gist (resource_id WITH =, during WITH &&) WHERE ((status <> ALL (ARRAY[''cancelled''::text, ''no_show''::text])))',
  'no_overlap is the exclusion constraint from the contract'
);
select col_default_is('public', 'garages', 'mobile_travel_min', '30', 'garages.mobile_travel_min defaults to 30');
select columns_are('public', 'booking_events',
  array['id', 'garage_id', 'booking_id', 'type', 'actor', 'actor_id', 'at', 'data', 'created_at'],
  'booking_events has the contract columns');
select has_column('public', 'bookings', 'reminder_send_id', 'bookings.reminder_send_id is ready for P3.6');

-- customers and vehicles
select col_default_is('public', 'customers', 'channel', 'sms', 'customers.channel defaults to sms');
select col_default_is('public', 'customers', 'reminder_consent', 'false', 'reminder consent defaults to false');
select has_column('public', 'customers', 'consent_at', 'customers.consent_at exists');
select has_column('public', 'customers', 'consent_source', 'customers.consent_source exists');
select col_type_is('public', 'customers', 'consent_text', 'text', 'customers.consent_text keeps the consent wording');
select throws_ok(
  $$insert into public.customers (garage_id, name, phone, preferred_contact, consent_text) values ('a1000000-0000-4000-8000-000000000001', 'Wording only', '+447700900304', 'phone', 'Text me reminders')$$,
  '23514', null, 'consent wording is only stored with a consent record'
);
select has_column('public', 'customers', 'opted_out_at', 'customers.opted_out_at exists');
select has_column('public', 'vehicles', 'fuel', 'vehicles.fuel exists');
select hasnt_column('public', 'vehicles', 'fuel_type', 'SOB''s vehicles.fuel_type became fuel');
select col_type_is('public', 'vehicles', 'mot_expiry', 'date', 'vehicles.mot_expiry is a date');
select has_column('public', 'vehicles', 'last_mileage', 'vehicles.last_mileage exists');
select is(
  (select array_agg(pg_get_constraintdef(oid) order by pg_get_constraintdef(oid)) from pg_constraint
   where contype = 'u' and conrelid = any(array['public.customers', 'public.vehicles', 'public.bookings']::regclass[])
     and pg_get_constraintdef(oid) in ('UNIQUE (garage_id, phone)', 'UNIQUE (garage_id, registration)', 'UNIQUE (garage_id, reference)', 'UNIQUE (garage_id, idempotency_key)')),
  array['UNIQUE (garage_id, idempotency_key)', 'UNIQUE (garage_id, phone)', 'UNIQUE (garage_id, reference)', 'UNIQUE (garage_id, registration)'],
  'phone, registration, reference and idempotency key are unique per garage'
);

-- ---------------------------------------------------------------------------
-- Grants and functions
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'
     and table_name = any(array['resources', 'opening_hours', 'closures', 'services', 'bookings', 'booking_events'])),
  0, 'anon has no privilege on the scheduling tables'
);
select ok(
  (select bool_and(
     has_table_privilege('authenticated', 'public.' || name, 'select')
     and has_table_privilege('authenticated', 'public.' || name, 'insert')
     and has_table_privilege('authenticated', 'public.' || name, 'update')
     and has_table_privilege('authenticated', 'public.' || name, 'delete'))
   from unnest(array['resources', 'opening_hours', 'closures', 'services']) setup_table(name)),
  'staff hold table privileges on the setup tables (RLS narrows writes to owners and managers)'
);
select ok(
  has_table_privilege('authenticated', 'public.bookings', 'select')
  and not has_table_privilege('authenticated', 'public.bookings', 'insert')
  and not has_table_privilege('authenticated', 'public.bookings', 'delete'),
  'staff read bookings but cannot insert or delete them'
);
select ok(
  has_column_privilege('authenticated', 'public.bookings', 'status', 'update')
  and has_column_privilege('authenticated', 'public.bookings', 'notes', 'update')
  and has_column_privilege('authenticated', 'public.bookings', 'admin_seen_at', 'update'),
  'staff may update booking status, notes and admin_seen_at'
);
select ok(
  not has_column_privilege('authenticated', 'public.bookings', 'starts_at', 'update')
  and not has_column_privilege('authenticated', 'public.bookings', 'during', 'update')
  and not has_column_privilege('authenticated', 'public.bookings', 'resource_id', 'update')
  and not has_column_privilege('authenticated', 'public.bookings', 'garage_id', 'update')
  and not has_column_privilege('authenticated', 'public.bookings', 'reference', 'update'),
  'staff cannot move a booking, change its resource, reference or garage directly'
);
select ok(
  has_table_privilege('authenticated', 'public.booking_events', 'select')
  and has_column_privilege('authenticated', 'public.booking_events', 'data', 'insert')
  and not has_table_privilege('authenticated', 'public.booking_events', 'update')
  and not has_table_privilege('authenticated', 'public.booking_events', 'delete'),
  'staff read booking events and may only add to them'
);

-- seed_garage_defaults() (P2.1)
select ok(
  has_function_privilege('service_role', 'public.seed_garage_defaults(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.seed_garage_defaults(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.seed_garage_defaults(uuid)', 'execute'),
  'seed_garage_defaults is service-role only'
);
select ok(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'public.seed_garage_defaults(uuid)'::regprocedure),
  'seed_garage_defaults is security definer with an empty search_path'
);

-- available_slots() (P2.2)
select ok(
  has_function_privilege('service_role', 'public.available_slots(uuid,uuid,date,date,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.available_slots(uuid,uuid,date,date,text)', 'execute')
  and not has_function_privilege('anon', 'public.available_slots(uuid,uuid,date,date,text)', 'execute'),
  'available_slots is service-role only'
);
select ok(
  (select bool_and(not has_function_privilege('service_role', signature, 'execute')
                   and not has_function_privilege('authenticated', signature, 'execute')
                   and not has_function_privilege('anon', signature, 'execute'))
   from unnest(array[
     'public.available_slots_at(uuid,uuid,date,date,text,timestamptz)',
     'public.opening_window_starts(uuid,date,date,integer)',
     'public.booking_service_context(uuid,uuid,text)'
   ]) internal_function(signature)),
  'the slot internals (clock-injectable available_slots_at) are not executable by any API role'
);
select is(
  (select count(*)::integer from pg_proc
   where oid = any(array['public.available_slots(uuid,uuid,date,date,text)'::regprocedure, 'public.available_slots_at(uuid,uuid,date,date,text,timestamptz)'::regprocedure])
     and prosecdef and proconfig = array['search_path=""']),
  2, 'available_slots and available_slots_at are security definer with an empty search_path'
);
select is(
  (select provolatile::text from pg_proc where oid = 'public.available_slots(uuid,uuid,date,date,text)'::regprocedure),
  's', 'available_slots is stable'
);
select is(
  pg_get_function_result('public.available_slots(uuid,uuid,date,date,text)'::regprocedure),
  'TABLE(starts_at timestamp with time zone, ends_at timestamp with time zone, free_count integer)',
  'available_slots returns (starts_at, ends_at, free_count)'
);
select is(
  pg_get_function_arguments('public.available_slots(uuid,uuid,date,date,text)'::regprocedure),
  'p_garage_id uuid, p_service_id uuid, p_from date, p_to date, p_location_mode text DEFAULT NULL::text',
  'available_slots takes the contract arguments'
);

select ok(
  has_function_privilege('service_role', 'public.generate_booking_reference(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.generate_booking_reference(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.create_booking_enquiry_thread(uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_booking_enquiry_thread(uuid,uuid,uuid)', 'execute'),
  'reference generation and booking enquiry threads stay service-role only'
);

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer from pg_policies
   where schemaname = 'public'
     and tablename = any(array['resources', 'opening_hours', 'closures', 'services', 'bookings', 'booking_events'])
     and (roles <> array['authenticated']::name[]
          or coalesce(qual, '') || coalesce(with_check, '') !~ 'current_garage_id\(\)')),
  0, 'every scheduling policy is for authenticated and scoped to the selected garage'
);
select policies_are('public', 'resources', array[
  'garage members read resources', 'owners and managers add resources',
  'owners and managers change resources', 'owners and managers remove resources'
], 'resources: staff read, owners and managers manage');
select policies_are('public', 'opening_hours', array[
  'garage members read opening hours', 'owners and managers add opening hours',
  'owners and managers change opening hours', 'owners and managers remove opening hours'
], 'opening_hours: staff read, owners and managers manage');
select policies_are('public', 'closures', array[
  'garage members read closures', 'owners and managers add closures',
  'owners and managers change closures', 'owners and managers remove closures'
], 'closures: staff read, owners and managers manage');
select policies_are('public', 'services', array[
  'garage members read services', 'owners and managers add services',
  'owners and managers change services', 'owners and managers remove services'
], 'services: staff read, owners and managers manage');
select policies_are('public', 'bookings', array['garage members read bookings', 'garage members update bookings'],
  'bookings: staff read and update status/notes; creation through create_booking');
select policies_are('public', 'booking_events', array['garage members read booking events', 'garage members add booking notes'],
  'booking_events: staff read and add notes');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('10100000-0000-4000-8000-0000000000a1', 'sched-owner-a@pgtap.test', '{}'::jsonb),
  ('10100000-0000-4000-8000-0000000000a2', 'sched-manager-a@pgtap.test', '{}'::jsonb),
  ('10100000-0000-4000-8000-0000000000a3', 'sched-tech-a@pgtap.test', '{}'::jsonb),
  ('10100000-0000-4000-8000-0000000000b1', 'sched-owner-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix) values
  ('a1000000-0000-4000-8000-000000000001', 'pgtap-sched-a', 'Schedule Garage A', 'SGA'),
  ('b1000000-0000-4000-8000-000000000001', 'pgtap-sched-b', 'Schedule Garage B', 'SGB');

insert into public.garage_members (garage_id, user_id, role) values
  ('a1000000-0000-4000-8000-000000000001', '10100000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1000000-0000-4000-8000-000000000001', '10100000-0000-4000-8000-0000000000a2', 'manager'),
  ('a1000000-0000-4000-8000-000000000001', '10100000-0000-4000-8000-0000000000a3', 'technician'),
  ('b1000000-0000-4000-8000-000000000001', '10100000-0000-4000-8000-0000000000b1', 'owner');

insert into public.resources (id, garage_id, name, kind, sort) values
  ('a1000000-0000-4000-8000-000000000101', 'a1000000-0000-4000-8000-000000000001', 'Bay 1', 'bay', 1),
  ('b1000000-0000-4000-8000-000000000101', 'b1000000-0000-4000-8000-000000000001', 'Bay B1', 'bay', 1);
insert into public.opening_hours (garage_id, weekday, opens, closes) values
  ('a1000000-0000-4000-8000-000000000001', 1, '08:00', '17:30');
insert into public.closures (garage_id, starts_on, ends_on, reason) values
  ('a1000000-0000-4000-8000-000000000001', '2026-12-25', '2026-12-26', 'Christmas');
insert into public.services (id, garage_id, name, duration_min, price_pence, price_mode) values
  ('a1000000-0000-4000-8000-000000000201', 'a1000000-0000-4000-8000-000000000001', 'Diagnostics', 60, 4500, 'from'),
  ('b1000000-0000-4000-8000-000000000201', 'b1000000-0000-4000-8000-000000000001', 'B Diagnostics', 60, 4000, 'fixed');
insert into public.customers (id, garage_id, name, phone, preferred_contact) values
  ('a1000000-0000-4000-8000-000000000301', 'a1000000-0000-4000-8000-000000000001', 'Schedule Customer', '+447700900301', 'phone'),
  ('a1000000-0000-4000-8000-000000000302', 'a1000000-0000-4000-8000-000000000001', 'Lonely Customer', '+447700900303', 'phone');
insert into public.vehicles (id, garage_id, customer_id, registration) values
  ('a1000000-0000-4000-8000-000000000401', 'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000301', 'sg12 abc');
insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  ('a1000000-0000-4000-8000-000000000501', 'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000301',
   'a1000000-0000-4000-8000-000000000401', 'a1000000-0000-4000-8000-000000000201', 'a1000000-0000-4000-8000-000000000101',
   '2026-11-02 10:00+00', '2026-11-02 11:00+00', '[2026-11-02 10:00+00,2026-11-02 11:00+00)', 'confirmed', 'phone');

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

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

select matches(
  (select reference from public.bookings where id = 'a1000000-0000-4000-8000-000000000501'),
  '^SGA-[0-9]{4}$', 'a booking inserted without a reference gets <prefix>-NNNN'
);
select is(
  (select registration from public.vehicles where id = 'a1000000-0000-4000-8000-000000000401'),
  'SG12ABC', 'registrations are normalised (upper case, no spaces)'
);
select throws_ok(
  $$insert into public.opening_hours (garage_id, weekday, opens, closes) values ('a1000000-0000-4000-8000-000000000001', 1, '17:00', '18:00')$$,
  '23P01', null, 'opening windows on the same weekday cannot overlap'
);
select lives_ok(
  $$insert into public.opening_hours (garage_id, weekday, opens, closes) values ('a1000000-0000-4000-8000-000000000001', 1, '17:30', '19:00')$$,
  'adjacent windows (split day) are allowed'
);
select throws_ok(
  $$insert into public.opening_hours (garage_id, weekday, opens, closes) values ('a1000000-0000-4000-8000-000000000001', 2, '17:00', '08:00')$$,
  '23514', null, 'a window must close after it opens'
);
select throws_ok(
  $$insert into public.opening_hours (garage_id, weekday, opens, closes) values ('a1000000-0000-4000-8000-000000000001', 8, '08:00', '17:00')$$,
  '23514', null, 'weekday is ISO 1-7'
);
select throws_ok(
  $$insert into public.closures (garage_id, starts_on, ends_on) values ('a1000000-0000-4000-8000-000000000001', '2026-12-31', '2026-12-30')$$,
  '23514', null, 'a closure cannot end before it starts'
);
select throws_ok(
  $$insert into public.services (garage_id, name, duration_min, price_pence, price_mode) values ('a1000000-0000-4000-8000-000000000001', 'Quoted', 60, 1000, 'quote')$$,
  '23514', null, 'quote services carry no price'
);
select throws_ok(
  $$insert into public.services (garage_id, name, duration_min, location_mode, resource_kind) values ('a1000000-0000-4000-8000-000000000001', 'Van job', 60, 'workshop', 'mobile')$$,
  '23514', null, 'only mobile services use mobile resources'
);
select throws_ok(
  $$insert into public.customers (garage_id, name, phone, preferred_contact) values ('a1000000-0000-4000-8000-000000000001', 'Local format', '07700900123', 'phone')$$,
  '23514', null, 'customer phones are E.164'
);
select throws_ok(
  $$insert into public.customers (garage_id, name, phone, preferred_contact) values ('a1000000-0000-4000-8000-000000000001', 'Same phone', '+447700900301', 'phone')$$,
  '23505', null, 'a phone number belongs to one customer per garage'
);
select lives_ok(
  $$insert into public.customers (garage_id, name, phone, preferred_contact) values ('b1000000-0000-4000-8000-000000000001', 'Same phone elsewhere', '+447700900301', 'phone')$$,
  'the same phone number can be a customer at another garage'
);
select throws_ok(
  $$insert into public.vehicles (garage_id, registration) values ('a1000000-0000-4000-8000-000000000001', 'SG12 ABC')$$,
  '23505', null, 'a registration belongs to one vehicle per garage (after normalising)'
);
select throws_ok(
  $$insert into public.customers (garage_id, name, phone, preferred_contact, reminder_consent) values ('a1000000-0000-4000-8000-000000000001', 'No evidence', '+447700900302', 'phone', true)$$,
  '23514', null, 'consent needs consent_at and consent_source'
);
select lives_ok(
  $$insert into public.customers (garage_id, name, phone, preferred_contact, anonymised_at) values
      ('a1000000-0000-4000-8000-000000000001', 'Anonymised', null, 'phone', now()),
      ('a1000000-0000-4000-8000-000000000001', 'Anonymised', null, 'phone', now())$$,
  'anonymised customers keep no phone, so several can exist per garage'
);
select throws_ok(
  $$insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
      ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000301', 'a1000000-0000-4000-8000-000000000401',
       'a1000000-0000-4000-8000-000000000201', 'a1000000-0000-4000-8000-000000000101',
       '2026-11-02 10:30+00', '2026-11-02 11:30+00', '[2026-11-02 10:30+00,2026-11-02 11:30+00)', 'requested', 'online')$$,
  '23P01', null, 'no_overlap rejects a second live booking on the same resource'
);
select lives_ok(
  $$insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
      ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000301', 'a1000000-0000-4000-8000-000000000401',
       'a1000000-0000-4000-8000-000000000201', 'a1000000-0000-4000-8000-000000000101',
       '2026-11-02 10:30+00', '2026-11-02 11:30+00', '[2026-11-02 10:30+00,2026-11-02 11:30+00)', 'cancelled', 'online')$$,
  'a cancelled booking does not hold the resource'
);
select throws_ok(
  $$update public.bookings set status = 'confirmed' where garage_id = 'a1000000-0000-4000-8000-000000000001' and status = 'cancelled'$$,
  '23P01', null, 'reinstating a cancelled booking into a taken slot is refused'
);
select is(
  (select cancelled_at is not null from public.bookings where garage_id = 'a1000000-0000-4000-8000-000000000001' and status = 'cancelled'),
  true, 'cancelled bookings get cancelled_at'
);
select throws_ok(
  $$insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
      ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000301', 'a1000000-0000-4000-8000-000000000401',
       'b1000000-0000-4000-8000-000000000201', 'b1000000-0000-4000-8000-000000000101',
       '2026-11-09 10:00+00', '2026-11-09 11:00+00', '[2026-11-09 10:00+00,2026-11-09 11:00+00)', 'confirmed', 'phone')$$,
  '23503', null, 'a booking cannot use another garage''s customer and vehicle'
);
select throws_ok(
  $$insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
      ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000301', 'a1000000-0000-4000-8000-000000000401',
       'a1000000-0000-4000-8000-000000000201', 'b1000000-0000-4000-8000-000000000101',
       '2026-11-09 10:00+00', '2026-11-09 11:00+00', '[2026-11-09 10:00+00,2026-11-09 11:00+00)', 'confirmed', 'phone')$$,
  '23503', null, 'a booking cannot use another garage''s resource'
);
select throws_ok(
  $$insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
      ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000301', 'a1000000-0000-4000-8000-000000000401',
       'a1000000-0000-4000-8000-000000000201', 'a1000000-0000-4000-8000-000000000101',
       '2026-11-09 10:00+00', '2026-11-09 11:00+00', '[2026-11-09 10:15+00,2026-11-09 11:00+00)', 'confirmed', 'phone')$$,
  '23514', null, 'during always covers the appointment'
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

select pg_temp.act_as('10100000-0000-4000-8000-0000000000a3', 'a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select count(*)::integer from public.resources),
  1, 'a technician reads the selected garage''s resources only'
);
select throws_ok(
  $$insert into public.resources (name, kind) values ('Tech bay', 'bay')$$,
  '42501', null, 'technicians cannot add resources'
);
update public.services set name = 'Technician rename' where id = 'a1000000-0000-4000-8000-000000000201';
update public.bookings set status = 'arrived', notes = 'Keys in the box' where id = 'a1000000-0000-4000-8000-000000000501';
select throws_ok(
  $$update public.bookings set starts_at = starts_at + interval '1 hour' where id = 'a1000000-0000-4000-8000-000000000501'$$,
  '42501', null, 'staff cannot move a booking by updating it directly'
);
select lives_ok(
  $$insert into public.booking_events (booking_id, type, actor, actor_id, data)
    values ('a1000000-0000-4000-8000-000000000501', 'note', 'staff', '10100000-0000-4000-8000-0000000000a3', '{"text": "Customer called"}')$$,
  'staff add notes to a booking''s timeline'
);
select throws_ok(
  $$insert into public.booking_events (booking_id, type, actor, actor_id, data)
    values ('a1000000-0000-4000-8000-000000000501', 'created', 'system', null, '{}')$$,
  '42501', null, 'staff cannot forge system events'
);
select throws_ok(
  $$insert into public.booking_events (booking_id, type, actor, actor_id, data)
    values ('a1000000-0000-4000-8000-000000000501', 'note', 'staff', '10100000-0000-4000-8000-0000000000a1', '{}')$$,
  '42501', null, 'staff cannot write notes as someone else'
);
select throws_ok(
  $$insert into public.bookings (customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source)
    select customer_id, vehicle_id, service_id, resource_id, starts_at + interval '1 day', ends_at + interval '1 day', tstzrange(starts_at + interval '1 day', ends_at + interval '1 day'), 'confirmed', 'phone'
    from public.bookings limit 1$$,
  '42501', null, 'staff cannot insert bookings directly'
);
reset role;
select is(
  (select name from public.services where id = 'a1000000-0000-4000-8000-000000000201'),
  'Diagnostics', 'technicians cannot change services'
);
select is(
  (select status || '/' || notes from public.bookings where id = 'a1000000-0000-4000-8000-000000000501'),
  'arrived/Keys in the box', 'staff update booking status and notes'
);
select is(
  (select type || '/' || actor || '/' || actor_id::text || '/' || (data->>'from') || '->' || (data->>'to')
   from public.booking_events where booking_id = 'a1000000-0000-4000-8000-000000000501' and type = 'status_changed'),
  'status_changed/staff/10100000-0000-4000-8000-0000000000a3/confirmed->arrived',
  'a status change writes a booking event naming the member'
);

select pg_temp.act_as('10100000-0000-4000-8000-0000000000a2', 'a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok(
  $$insert into public.resources (name, kind, sort) values ('Bay 2', 'bay', 2)$$,
  'managers add resources to the selected garage'
);
select throws_ok(
  $$insert into public.resources (garage_id, name, kind) values ('b1000000-0000-4000-8000-000000000001', 'Planted', 'bay')$$,
  '42501', null, 'managers cannot add resources to another garage'
);
update public.services set name = 'Diagnostics (manager)' where id = 'a1000000-0000-4000-8000-000000000201';
update public.bookings set status = 'cancelled' where id = 'a1000000-0000-4000-8000-000000000501';
reset role;
select is(
  (select name from public.services where id = 'a1000000-0000-4000-8000-000000000201'),
  'Diagnostics (manager)', 'managers change services'
);
select is(
  (select array_agg(type order by at, type) from public.booking_events where booking_id = 'a1000000-0000-4000-8000-000000000501'),
  array['cancelled', 'note', 'status_changed'], 'cancelling writes a cancelled event'
);
select is(
  (select garage_id from public.resources where name = 'Bay 2'),
  'a1000000-0000-4000-8000-000000000001'::uuid, 'garage_id defaults to the selected garage'
);

select pg_temp.act_as('10100000-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select count(*)::integer from public.resources where garage_id = 'a1000000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.services where garage_id = 'a1000000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.opening_hours where garage_id = 'a1000000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.closures where garage_id = 'a1000000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.bookings where garage_id = 'a1000000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.booking_events where garage_id = 'a1000000-0000-4000-8000-000000000001'),
  0, 'garage B''s owner sees none of garage A''s scheduling rows'
);
update public.bookings set notes = 'Tampered' where id = 'a1000000-0000-4000-8000-000000000501';
delete from public.resources where garage_id = 'a1000000-0000-4000-8000-000000000001';
reset role;
select pg_temp.act_as('10100000-0000-4000-8000-0000000000b1', 'a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select count(*)::integer from public.services),
  0, 'forging x-garage-id for garage A shows nothing'
);
reset role;
select is(
  (select notes from public.bookings where id = 'a1000000-0000-4000-8000-000000000501'),
  'Keys in the box', 'garage B''s owner cannot change garage A''s booking'
);
select is(
  (select count(*)::integer from public.resources where garage_id = 'a1000000-0000-4000-8000-000000000001'),
  2, 'garage B''s owner cannot delete garage A''s resources'
);

select pg_temp.act_as(null, 'a1000000-0000-4000-8000-000000000001');
set local role anon;
select throws_ok($$select count(*) from public.services$$, '42501', null, 'anon cannot read services');
reset role;

-- ---------------------------------------------------------------------------
-- Retention keeps the per-garage phone constraint
-- ---------------------------------------------------------------------------

set local role service_role;
select is(
  public.apply_enquiry_retention('a1000000-0000-4000-8000-000000000001'),
  1, 'retention anonymises the customer with no enquiry, booking or invoice'
);
reset role;
select is(
  (select name || '/' || coalesce(phone, 'no phone') from public.customers where id = 'a1000000-0000-4000-8000-000000000302'),
  'Anonymised/no phone', 'anonymised customers keep no phone number'
);

select * from finish();
rollback;
