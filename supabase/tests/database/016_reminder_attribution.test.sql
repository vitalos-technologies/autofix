begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(24);

-- Reminder attribution in create_booking() and the won-back figures (P3.6).
-- As in 012, bookings go through create_booking_at() with "now" = Wed 28 Oct
-- 2026 12:00 UTC. A reminder_send_id credits the booking only when the send
-- belongs to the garage, went out, and is for the booking's own vehicle and
-- customer; otherwise it is ignored and the booking is an ordinary one.
--
-- Garage W (RWB): defaults from seed_garage_defaults(). Garage V (RWV): another garage.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('16000000-0000-4000-8000-0000000000a1', 'won-back-owner@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, mot_enabled, status) values
  ('a1600000-0000-4000-8000-000000000001', 'pgtap-won-back-w', 'Won Back Garage W', 'RWB', true, 'active'),
  ('b1600000-0000-4000-8000-000000000001', 'pgtap-won-back-v', 'Won Back Garage V', 'RWV', true, 'active');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1600000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-0000000000a1', 'owner');
select public.seed_garage_defaults(id) from public.garages where slug like 'pgtap-won-back-%';

create function pg_temp.w() returns uuid language sql as $$ select 'a1600000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.v() returns uuid language sql as $$ select 'b1600000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.diag(p_garage uuid) returns text language sql as $$
  select id::text from public.services where garage_id = p_garage and name = 'Diagnostics'
$$;

insert into public.customers (id, garage_id, name, phone, preferred_contact, reminder_consent, consent_at, consent_source) values
  ('a1600000-0000-4000-8000-000000000611', pg_temp.w(), 'Pat Reminded', '+447700916611', 'phone', true, '2026-01-01 09:00+00', 'import'),
  ('a1600000-0000-4000-8000-000000000612', pg_temp.w(), 'Quin Reminded', '+447700916612', 'phone', true, '2026-01-01 09:00+00', 'import'),
  ('b1600000-0000-4000-8000-000000000611', pg_temp.v(), 'Pat Elsewhere', '+447700916611', 'phone', true, '2026-01-01 09:00+00', 'import');
insert into public.vehicles (id, garage_id, customer_id, registration, mot_expiry) values
  ('a1600000-0000-4000-8000-000000000711', pg_temp.w(), 'a1600000-0000-4000-8000-000000000611', 'RW16PAT', '2026-11-25'),
  ('a1600000-0000-4000-8000-000000000712', pg_temp.w(), 'a1600000-0000-4000-8000-000000000611', 'RW16PA2', '2026-11-25'),
  ('a1600000-0000-4000-8000-000000000713', pg_temp.w(), 'a1600000-0000-4000-8000-000000000612', 'RW16QUN', '2026-11-25'),
  ('b1600000-0000-4000-8000-000000000711', pg_temp.v(), 'b1600000-0000-4000-8000-000000000611', 'RW16PAT', '2026-11-25');

-- S1: sent to Pat about RW16PAT. S2: scheduled, never sent (RW16PA2). S3: sent
-- to Quin about RW16QUN. SV: garage V's reminder to its own Pat.
insert into public.reminder_sends (id, garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel, status, claimed_at, sent_at)
select plan.id, plan.garage_id, rule.id, plan.vehicle_id, plan.customer_id, 'mot', '2026-11-25', 28, now(), 'sms', plan.status,
       case when plan.status = 'sent' then now() end, case when plan.status = 'sent' then now() end
from (values
  ('a1600000-0000-4000-8000-000000000501'::uuid, pg_temp.w(), 'a1600000-0000-4000-8000-000000000711'::uuid, 'a1600000-0000-4000-8000-000000000611'::uuid, 'sent'),
  ('a1600000-0000-4000-8000-000000000502'::uuid, pg_temp.w(), 'a1600000-0000-4000-8000-000000000712'::uuid, 'a1600000-0000-4000-8000-000000000611'::uuid, 'scheduled'),
  ('a1600000-0000-4000-8000-000000000503'::uuid, pg_temp.w(), 'a1600000-0000-4000-8000-000000000713'::uuid, 'a1600000-0000-4000-8000-000000000612'::uuid, 'sent'),
  ('b1600000-0000-4000-8000-000000000501'::uuid, pg_temp.v(), 'b1600000-0000-4000-8000-000000000711'::uuid, 'b1600000-0000-4000-8000-000000000611'::uuid, 'sent')
) plan(id, garage_id, vehicle_id, customer_id, status)
join public.reminder_rules rule on rule.garage_id = plan.garage_id and rule.kind = 'mot';

create temp table outcome (label text primary key, result jsonb not null);

create function pg_temp.payload(p_garage uuid, p_start text, p_key integer, p_phone text, p_reg text, p_send text, p_source text default 'online')
returns jsonb
language sql
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'service_id', pg_temp.diag(p_garage),
    'starts_at', p_start,
    'source', p_source,
    'idempotency_key', 'c1600000-0000-4000-8000-' || lpad(p_key::text, 12, '0'),
    'reminder_send_id', p_send,
    'customer', jsonb_build_object('name', 'Reminder Booker', 'phone', p_phone, 'channel', 'sms'),
    'vehicle', jsonb_build_object('registration', p_reg)
  ))
$$;

create function pg_temp.book(p_label text, p_garage uuid, p_payload jsonb)
returns jsonb
language sql
as $$
  insert into outcome (label, result) values (p_label, public.create_booking_at(p_garage, p_payload, '2026-10-28 12:00+00'))
  returning result
$$;

create function pg_temp.book_error(p_garage uuid, p_payload jsonb)
returns text
language plpgsql
as $$
begin
  perform public.create_booking_at(p_garage, p_payload, '2026-10-28 12:00+00');
  return 'no error';
exception
  when others then
    return sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end
$$;

create function pg_temp.booking_of(p_label text)
returns public.bookings
language sql
as $$
  select booking.* from public.bookings booking
  join outcome on (outcome.result->>'booking_id')::uuid = booking.id
  where outcome.label = p_label
$$;

create function pg_temp.credit(p_label text)
returns text
language sql
as $$
  select concat_ws('|', booking.source, coalesce(booking.reminder_send_id::text, 'no reminder'), booking.status)
  from pg_temp.booking_of(p_label) booking
$$;

create function pg_temp.send_booking(p_send uuid)
returns text
language sql
as $$
  select coalesce((select label from outcome where (result->>'booking_id')::uuid = send.booking_id), 'none')
  from public.reminder_sends send where send.id = p_send
$$;

-- ---------------------------------------------------------------------------
-- Attribution
-- ---------------------------------------------------------------------------

select pg_temp.book('credited', pg_temp.w(),
  pg_temp.payload(pg_temp.w(), '2026-11-03T09:00:00Z', 1, '+447700916611', 'rw16 pat', 'a1600000-0000-4000-8000-000000000501'));
select is(pg_temp.credit('credited'), 'reminder|a1600000-0000-4000-8000-000000000501|confirmed',
  'a booking through a reminder link is source reminder and stores the reminder');
select is(pg_temp.send_booking('a1600000-0000-4000-8000-000000000501'), 'credited',
  'the reminder points at the booking it produced (same transaction)');
select is(
  (select concat_ws('|', event.actor, event.data->>'source', event.data->>'reminder_send_id') from public.booking_events event
   where event.booking_id = (pg_temp.booking_of('credited')).id and event.type = 'created'),
  'customer|reminder|a1600000-0000-4000-8000-000000000501', 'the created event records the reminder'
);
select is(
  (public.create_booking_at(pg_temp.w(), pg_temp.payload(pg_temp.w(), '2026-11-03T09:00:00Z', 1, '+447700916611', 'RW16PAT', 'a1600000-0000-4000-8000-000000000501'),
     '2026-10-28 12:00+00'))->>'replayed',
  'true', 'a replay returns the same booking'
);
select is(
  (select count(*)::integer from public.bookings where reminder_send_id = 'a1600000-0000-4000-8000-000000000501'),
  1, 'and credits nothing twice'
);

select pg_temp.book('other-garage', pg_temp.w(),
  pg_temp.payload(pg_temp.w(), '2026-11-03T10:00:00Z', 2, '+447700916611', 'RW16PAT', 'b1600000-0000-4000-8000-000000000501'));
select is(pg_temp.credit('other-garage'), 'online|no reminder|confirmed', 'another garage''s reminder is ignored');
select is(pg_temp.send_booking('b1600000-0000-4000-8000-000000000501'), 'none', 'and that garage''s reminder is untouched');

select pg_temp.book('other-car', pg_temp.w(),
  pg_temp.payload(pg_temp.w(), '2026-11-03T11:00:00Z', 3, '+447700916611', 'RW16PAT', 'a1600000-0000-4000-8000-000000000503'));
select is(pg_temp.credit('other-car') || ' / ' || pg_temp.send_booking('a1600000-0000-4000-8000-000000000503'),
  'online|no reminder|confirmed / none', 'a reminder about another car is ignored');

select pg_temp.book('never-sent', pg_temp.w(),
  pg_temp.payload(pg_temp.w(), '2026-11-03T12:00:00Z', 4, '+447700916611', 'RW16PA2', 'a1600000-0000-4000-8000-000000000502'));
select is(pg_temp.credit('never-sent'), 'online|no reminder|confirmed', 'a reminder that was never sent is ignored');

select pg_temp.book('other-customer', pg_temp.w(),
  pg_temp.payload(pg_temp.w(), '2026-11-03T13:00:00Z', 5, '+447700916699', 'RW16QUN', 'a1600000-0000-4000-8000-000000000503'));
select is(pg_temp.credit('other-customer'), 'online|no reminder|confirmed',
  'a reminder is ignored when someone else books the car with another phone number');

select pg_temp.book('claimed-source', pg_temp.w(),
  pg_temp.payload(pg_temp.w(), '2026-11-03T14:00:00Z', 6, '+447700916611', 'RW16PA2', null, 'reminder'));
select is(pg_temp.credit('claimed-source'), 'online|no reminder|confirmed',
  'source reminder without a valid reminder is stored as online');

select pg_temp.book('agent', pg_temp.w(),
  pg_temp.payload(pg_temp.w(), '2026-11-04T09:00:00Z', 7, '+447700916612', 'RW16QUN', 'a1600000-0000-4000-8000-000000000503', 'ai_agent'));
select is(pg_temp.credit('agent'), 'reminder|a1600000-0000-4000-8000-000000000503|requested',
  'an agent booking through a reminder is credited and still waits for the garage''s OK');
select is(
  (select actor from public.booking_events where booking_id = (pg_temp.booking_of('agent')).id and type = 'created'),
  'agent', 'and its created event still names the agent'
);

select pg_temp.book('again', pg_temp.w(),
  pg_temp.payload(pg_temp.w(), '2026-11-04T10:00:00Z', 8, '+447700916611', 'RW16PAT', 'a1600000-0000-4000-8000-000000000501'));
select is(pg_temp.send_booking('a1600000-0000-4000-8000-000000000501'), 'again',
  'a later booking through the same reminder takes its booking_id');
select is(
  (select count(*)::integer from public.bookings where reminder_send_id = 'a1600000-0000-4000-8000-000000000501'),
  2, 'both bookings stay credited to the reminder'
);
select is(
  pg_temp.book_error(pg_temp.w(), pg_temp.payload(pg_temp.w(), '2026-11-04T11:00:00Z', 9, '+447700916611', 'RW16PAT', 'not-a-uuid')),
  'P0001 INVALID_BOOKING', 'a malformed reminder_send_id is refused like any malformed field'
);

-- ---------------------------------------------------------------------------
-- reminder_won_back
-- ---------------------------------------------------------------------------
-- credited: invoiced at 120.00 (the invoice total wins over the 45.00 price).
-- agent: no invoice, 45.00 service price. again: cancelled, not counted.

insert into public.invoices (id, garage_id, status, source_type, booking_id, customer_id, vehicle_id, customer_name, created_by, updated_by)
select 'a1600000-0000-4000-8000-000000000901', pg_temp.w(), 'draft', 'booking', booking.id, booking.customer_id, booking.vehicle_id,
       'Pat Reminded', '16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000000a1'
from pg_temp.booking_of('credited') booking;
insert into public.invoice_items (garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence)
values (pg_temp.w(), 'a1600000-0000-4000-8000-000000000901', 'Diagnostics and repair', 1, 12000, 0);
select set_config('request.jwt.claims', jsonb_build_object('sub', '16000000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
select set_config('request.headers', jsonb_build_object('x-garage-id', pg_temp.w())::text, true);
set local role authenticated;
select lives_ok($$select public.issue_invoice('a1600000-0000-4000-8000-000000000901')$$, 'the owner issues the invoice for the credited booking');
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', '{}', true);
update public.bookings set status = 'cancelled' where id = (pg_temp.booking_of('again')).id;

set local role service_role;
select is(
  (select to_jsonb(won) from public.reminder_won_back(pg_temp.w(), (now() at time zone 'Europe/London')::date, (now() at time zone 'Europe/London')::date) won),
  '{"sent": 2, "pence": 16500, "bookings": 2}'::jsonb,
  'won back today: 2 reminders sent, 2 live bookings credited, 120.00 invoiced + 45.00 at the service price'
);
select is(
  (select to_jsonb(won) from public.reminder_won_back(pg_temp.w(), (now() at time zone 'Europe/London')::date - 7, (now() at time zone 'Europe/London')::date - 1) won),
  '{"sent": 0, "pence": 0, "bookings": 0}'::jsonb,
  'last week: nothing'
);
select is(
  (select to_jsonb(won) from public.reminder_won_back(pg_temp.v(), (now() at time zone 'Europe/London')::date, (now() at time zone 'Europe/London')::date) won),
  '{"sent": 1, "pence": 0, "bookings": 0}'::jsonb,
  'garage V: its own reminder was sent, nothing was booked from it'
);
select throws_ok(
  $$select * from public.reminder_won_back('a1600000-0000-4000-8000-000000000001', current_date, current_date - 1)$$,
  '22023', null, 'the range must not end before it starts'
);
select throws_ok(
  $$select * from public.reminder_won_back(gen_random_uuid(), current_date, current_date)$$,
  'P0001', 'GARAGE_NOT_FOUND', 'an unknown garage is refused'
);
reset role;
set local role authenticated;
select throws_ok(
  $$select * from public.reminder_won_back('a1600000-0000-4000-8000-000000000001', current_date, current_date)$$,
  '42501', null, 'signed-in staff read won-back figures through the server, not directly'
);
reset role;

-- Removing a reminder keeps the booking but drops the credit.
delete from public.reminder_sends where id = 'a1600000-0000-4000-8000-000000000503';
select is(pg_temp.credit('agent'), 'reminder|no reminder|requested', 'deleting a reminder clears bookings.reminder_send_id (on delete set null)');

select * from finish();
rollback;
