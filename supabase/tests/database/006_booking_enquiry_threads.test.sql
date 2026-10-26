begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

select has_column('public', 'enquiries', 'booking_id', 'enquiries record their source booking');
select has_index('public', 'enquiries', 'enquiries_booking_thread_unique', 'one enquiry thread is allowed per booking');
select ok(
  has_function_privilege('service_role', 'public.create_booking_enquiry_thread(uuid,uuid,uuid)', 'execute'),
  'service role can create a booking enquiry thread'
);
select ok(
  not has_function_privilege('anon', 'public.create_booking_enquiry_thread(uuid,uuid,uuid)', 'execute'),
  'anonymous callers cannot create booking enquiry threads'
);
select ok(
  not has_function_privilege('authenticated', 'public.create_booking_enquiry_thread(uuid,uuid,uuid)', 'execute'),
  'authenticated clients cannot bypass the guarded admin action'
);

insert into public.garages (id, slug, name, booking_prefix) values
  ('a6000000-0000-4000-8000-000000000001', 'pgtap-thread-a', 'Thread Garage A', 'THA'),
  ('b6000000-0000-4000-8000-000000000001', 'pgtap-thread-b', 'Thread Garage B', 'THB');

insert into public.customers (id, garage_id, name, email, phone, preferred_contact)
values (
  '10000000-0000-4000-8000-000000000001',
  'a6000000-0000-4000-8000-000000000001',
  'Booking Thread Test Customer',
  'booking-thread@example.test',
  '07000000000',
  'email'
);

insert into public.vehicles (id, garage_id, customer_id, registration, make, model)
values (
  '10000000-0000-4000-8000-000000000002',
  'a6000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'THREAD1',
  'Test',
  'Vehicle'
);

insert into public.bookings (
  id,
  garage_id,
  customer_id,
  vehicle_id,
  service_name,
  service_key,
  problem_description,
  appointment_start,
  original_appointment_start
)
values (
  '10000000-0000-4000-8000-000000000003',
  'a6000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'Vehicle diagnostics',
  'vehicle-diagnostics',
  'Intermittent warning light',
  '2026-10-05 09:00:00+01',
  '2026-10-05 09:00:00+01'
);

select matches(
  (select booking_reference from public.bookings where id = '10000000-0000-4000-8000-000000000003'),
  '^THA-[0-9]{4}$',
  'a new booking gets a reference with its garage''s prefix'
);
select throws_ok(
  $$insert into public.bookings (garage_id, customer_id, vehicle_id, service_name, appointment_start, original_appointment_start)
    values ('b6000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
            'Cross-garage booking', now(), now())$$,
  '23503', null, 'a booking cannot use another garage''s customer and vehicle'
);

set local role service_role;

select is(
  public.create_booking_enquiry_thread('a6000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', null),
  public.create_booking_enquiry_thread('a6000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', null),
  'opening the same booking twice returns the same enquiry thread'
);
select is(
  (select count(*)::integer from public.enquiries where booking_id = '10000000-0000-4000-8000-000000000003'),
  1,
  'only one enquiry is created for the booking'
);
select is(
  (select status::text from public.enquiries where booking_id = '10000000-0000-4000-8000-000000000003'),
  'booked',
  'the enquiry reflects that the customer already has a booking'
);
select matches(
  (select description from public.enquiries where booking_id = '10000000-0000-4000-8000-000000000003'),
  'Intermittent warning light',
  'the booking context is copied into the conversation'
);
select matches(
  (
    select conversation.subject
    from public.enquiry_conversations as conversation
    join public.enquiries as enquiry on enquiry.id = conversation.enquiry_id
    where enquiry.booking_id = '10000000-0000-4000-8000-000000000003'
  ),
  '^Your Thread Garage A booking THA-[0-9]{4}$',
  'the conversation has a booking-specific subject in the garage''s name'
);
select throws_ok(
  $$select public.create_booking_enquiry_thread('b6000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', null)$$,
  'P0001', 'Booking not found', 'a thread cannot be opened for another garage''s booking'
);
select is(
  (select count(*)::integer from public.enquiries where garage_id = 'b6000000-0000-4000-8000-000000000001'),
  0,
  'garage B gained no enquiry'
);

reset role;
select * from finish();
rollback;
