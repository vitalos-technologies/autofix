begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

-- Service-role functions take the garage explicitly and never touch another
-- garage's rows, whatever ids they are given.

insert into auth.users (id, email, raw_user_meta_data) values
  ('18000000-0000-4000-8000-0000000000a1', 'service-owner-a@pgtap.test', '{}'::jsonb),
  ('18000000-0000-4000-8000-0000000000ab', 'service-both@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix) values
  ('a8000000-0000-4000-8000-000000000001', 'pgtap-service-a', 'Service Garage A', 'SVA'),
  ('b8000000-0000-4000-8000-000000000001', 'pgtap-service-b', 'Service Garage B', 'SVB');

insert into public.garage_members (garage_id, user_id, role) values
  ('a8000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a8000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000ab', 'manager'),
  ('b8000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000ab', 'owner');

insert into public.services (id, garage_id, name, duration_min, price_pence, price_mode) values
  ('98000000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000001', 'Diagnostics', 60, 4500, 'from');
insert into public.resources (id, garage_id, name) values
  ('99000000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000001', 'Bay 1');
insert into public.opening_hours (garage_id, weekday, opens, closes)
select 'a8000000-0000-4000-8000-000000000001'::uuid, weekday::smallint, time '08:00', time '17:30' from generate_series(1, 7) weekday;

-- Enquiries: an open one in each garage, and old closed ones with attachments.
insert into public.customers (id, garage_id, name, email, phone, preferred_contact) values
  ('68000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-000000000001', 'Open enquiry A', 'open-a@example.test', '+447700900201', 'email'),
  ('68000000-0000-4000-8000-0000000000a2', 'a8000000-0000-4000-8000-000000000001', 'Closed enquiry A', 'closed-a@example.test', '+447700900202', 'email'),
  ('68000000-0000-4000-8000-0000000000a3', 'a8000000-0000-4000-8000-000000000001', 'Booking-only A', 'booking-a@example.test', '+447700900203', 'email'),
  ('68000000-0000-4000-8000-0000000000b2', 'b8000000-0000-4000-8000-000000000001', 'Closed enquiry B', 'closed-b@example.test', '+447700900204', 'email');
insert into public.vehicles (id, garage_id, customer_id, registration) values
  ('78000000-0000-4000-8000-0000000000a3', 'a8000000-0000-4000-8000-000000000001', '68000000-0000-4000-8000-0000000000a3', 'SV12BKG');
insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  ('a8000000-0000-4000-8000-000000000001', '68000000-0000-4000-8000-0000000000a3', '78000000-0000-4000-8000-0000000000a3',
   '98000000-0000-4000-8000-00000000000a', '99000000-0000-4000-8000-00000000000a',
   '2020-01-01T09:00:00Z', '2020-01-01T10:00:00Z', '[2020-01-01T09:00:00Z,2020-01-01T10:00:00Z)', 'collected', 'phone');
insert into public.enquiries (id, garage_id, type, customer_id, status, closed_at) values
  ('58000000-0000-4000-8000-0000000000a1', 'a8000000-0000-4000-8000-000000000001', 'general', '68000000-0000-4000-8000-0000000000a1', 'new', null),
  ('58000000-0000-4000-8000-0000000000a2', 'a8000000-0000-4000-8000-000000000001', 'general', '68000000-0000-4000-8000-0000000000a2', 'closed', now() - interval '13 months'),
  ('58000000-0000-4000-8000-0000000000b2', 'b8000000-0000-4000-8000-000000000001', 'general', '68000000-0000-4000-8000-0000000000b2', 'closed', now() - interval '13 months');
insert into public.enquiry_conversations (garage_id, enquiry_id, subject) values
  ('a8000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a1', 'Open enquiry A');
insert into public.enquiry_attachments (garage_id, enquiry_id, object_path, file_name, content_type, size_bytes) values
  ('a8000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a2', 'a8000000-0000-4000-8000-000000000001/58000000-0000-4000-8000-0000000000a2/photo.jpg', 'photo.jpg', 'image/jpeg', 10),
  ('b8000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000b2', 'b8000000-0000-4000-8000-000000000001/58000000-0000-4000-8000-0000000000b2/photo.jpg', 'photo.jpg', 'image/jpeg', 10);

select throws_ok(
  $$insert into public.enquiry_attachments (garage_id, enquiry_id, object_path, file_name, content_type, size_bytes)
    values ('a8000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a1', '58000000-0000-4000-8000-0000000000a1/photo.jpg', 'photo.jpg', 'image/jpeg', 10)$$,
  '23514', null, 'attachment paths must start with the garage id'
);

set local role service_role;

-- create_booking (next Monday 10:00 London; garage A is open every day)
select is(
  (public.create_booking('a8000000-0000-4000-8000-000000000001', jsonb_build_object(
      'service_id', '98000000-0000-4000-8000-00000000000a',
      'starts_at', to_char(((date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date + time '10:00') at time zone 'Europe/London', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'idempotency_key', 'c8000000-0000-4000-8000-000000000001',
      'customer', jsonb_build_object('name', 'Intent Customer', 'phone', '+447700900300', 'email', 'Intent@Example.test'),
      'vehicle', jsonb_build_object('registration', 'sv12 int', 'make', 'Ford', 'model', 'Focus')))->>'replayed'),
  'false', 'a booking is created in the garage'
);
select is(
  (public.create_booking('a8000000-0000-4000-8000-000000000001', jsonb_build_object(
      'service_id', '98000000-0000-4000-8000-00000000000a',
      'starts_at', to_char(((date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date + time '10:00') at time zone 'Europe/London', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'idempotency_key', 'c8000000-0000-4000-8000-000000000001',
      'customer', jsonb_build_object('name', 'Intent Customer', 'phone', '+447700900300', 'email', 'Intent@Example.test'),
      'vehicle', jsonb_build_object('registration', 'sv12 int', 'make', 'Ford', 'model', 'Focus')))->>'replayed'),
  'true', 'the same idempotency key returns the existing booking'
);
select matches(
  (select reference from public.bookings where idempotency_key = 'c8000000-0000-4000-8000-000000000001'),
  '^SVA-[0-9]{4}$', 'the booking reference uses garage A''s prefix'
);
select is(
  (select count(*)::integer from public.customers where garage_id = 'a8000000-0000-4000-8000-000000000001' and email = 'intent@example.test'),
  1, 'the customer is created in garage A'
);
select throws_ok(
  $$select public.create_booking('b8000000-0000-4000-8000-000000000001', jsonb_build_object(
      'service_id', '98000000-0000-4000-8000-00000000000a',
      'starts_at', to_char(((date_trunc('week', (now() at time zone 'Europe/London')::date + 7))::date + time '10:00') at time zone 'Europe/London', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'idempotency_key', 'c8000000-0000-4000-8000-000000000002',
      'customer', jsonb_build_object('name', 'Cross Garage', 'phone', '+447700900301', 'email', 'cross@example.test'),
      'vehicle', jsonb_build_object('registration', 'sv12 crs', 'make', 'Ford', 'model', 'Focus')))$$,
  'P0001', 'SERVICE_UNAVAILABLE', 'garage B cannot book garage A''s service'
);
select is(
  (select count(*)::integer from public.bookings where garage_id = 'b8000000-0000-4000-8000-000000000001'),
  0, 'the failed cross-garage booking left nothing behind in garage B'
);

-- Inbound email and unread counts
select throws_ok(
  $$select * from public.store_inbound_email_message('b8000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a1',
      'resend', 'pgtap-inbound-1', 'Sender', 'sender@example.test', 'reply@example.test', 'Re: enquiry', 'Hello', '<pgtap-1@example.test>', null, '{}', now(), 'reply_token')$$,
  'P0001', 'ENQUIRY_NOT_FOUND', 'an inbound reply cannot be stored against another garage''s enquiry'
);
select is(
  (select was_inserted from public.store_inbound_email_message('a8000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a1',
      'resend', 'pgtap-inbound-2', 'Sender', 'sender@example.test', 'reply@example.test', 'Re: enquiry', 'Hello', '<pgtap-2@example.test>', null, '{}', now(), 'reply_token')),
  true, 'an inbound reply is stored on its own garage''s enquiry'
);
select is(
  (select garage_id from public.enquiry_messages where provider_email_id = 'pgtap-inbound-2'),
  'a8000000-0000-4000-8000-000000000001'::uuid, 'the stored message carries the garage'
);
select lives_ok(
  $$select public.increment_enquiry_unread('b8000000-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a1', now())$$,
  'incrementing with the wrong garage is a no-op'
);
select is(
  (select unread_count from public.enquiry_conversations where enquiry_id = '58000000-0000-4000-8000-0000000000a1'),
  1, 'only the stored reply counted as unread'
);

-- Retention
select is(public.apply_enquiry_retention('a8000000-0000-4000-8000-000000000001'), 1, 'retention anonymises one garage A customer');
select is(
  (select name from public.customers where id = '68000000-0000-4000-8000-0000000000a2'),
  'Anonymised', 'the customer whose only enquiry closed over a year ago is anonymised'
);
select is(
  (select name from public.customers where id = '68000000-0000-4000-8000-0000000000a3'),
  'Booking-only A', 'customers with bookings are not anonymised by enquiry retention'
);
select is(
  (select count(*)::integer from public.enquiry_attachments where garage_id = 'a8000000-0000-4000-8000-000000000001'),
  0, 'garage A''s expired attachments are removed'
);
select is(
  (select count(*)::integer from public.enquiry_attachments where garage_id = 'b8000000-0000-4000-8000-000000000001'),
  1, 'garage B''s attachments are untouched'
);
select is(
  (select name from public.customers where id = '68000000-0000-4000-8000-0000000000b2'),
  'Closed enquiry B', 'garage B''s customers are untouched'
);

reset role;

-- MFA recovery codes are per user; their audit trail reaches every garage the
-- user works for.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('88000000-0000-4000-8000-0000000000ab', '18000000-0000-4000-8000-0000000000ab', 'pgTAP', 'totp', 'verified', now(), now());

set local role service_role;
select is(
  public.replace_admin_mfa_recovery_codes(
    '18000000-0000-4000-8000-0000000000ab',
    array(select encode(extensions.digest('code-' || series, 'sha256'), 'hex') from generate_series(1, 10) series),
    'mfa_recovery_codes_created'
  ),
  10, 'recovery codes are created for a garage member with verified TOTP'
);
select results_eq(
  $$select garage_id from public.admin_audit_log where action = 'mfa_recovery_codes_created' and actor_id = '18000000-0000-4000-8000-0000000000ab' order by garage_id$$,
  array['a8000000-0000-4000-8000-000000000001'::uuid, 'b8000000-0000-4000-8000-000000000001'::uuid],
  'the security event is logged in both of the user''s garages'
);
select throws_ok(
  $$select public.replace_admin_mfa_recovery_codes(
      '18000000-0000-4000-8000-0000000000a1',
      array(select encode(extensions.digest('other-' || series, 'sha256'), 'hex') from generate_series(1, 10) series),
      'mfa_recovery_codes_created')$$,
  'P0001', 'RECOVERY_CODES_REQUIRE_VERIFIED_ADMIN_TOTP', 'recovery codes need a verified TOTP factor'
);
select is(
  public.consume_admin_mfa_recovery_code(
    '18000000-0000-4000-8000-0000000000ab',
    encode(extensions.digest('code-1', 'sha256'), 'hex'),
    repeat('e', 64),
    now() + interval '10 minutes'
  ),
  true, 'a recovery code can be consumed once'
);
select is(
  public.consume_admin_mfa_recovery_code(
    '18000000-0000-4000-8000-0000000000ab',
    encode(extensions.digest('code-1', 'sha256'), 'hex'),
    repeat('f', 64),
    now() + interval '10 minutes'
  ),
  false, 'the same recovery code cannot be consumed twice'
);
reset role;

select ok(
  not has_function_privilege('authenticated', 'public.apply_enquiry_retention(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_booking(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.store_inbound_email_message(uuid,uuid,text,text,text,text,text,text,text,text,text,text[],timestamptz,text)', 'execute'),
  'signed-in staff cannot call the service-role functions'
);

select * from finish();
rollback;
