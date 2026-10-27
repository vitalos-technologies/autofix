begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(47);

-- schedule_reminders() and claim_reminder_sends() (P3.6), with fixed dates
-- (p_today, p_now). Defaults from seed_garage_defaults(): MOT {28,7} days
-- before expiry, service {335} days after the last service, review {1} day
-- after collection (switched off), all on the customer's own channel. Sends
-- go at 10:00 garage time on their day; rows are created for send days from
-- 3 days ago (catch-up) to 30 days ahead.
--
-- Garage S (RSS): MOT on, Europe/London. Garage M (RSM): MOT off. Garage X
-- (RSX): suspended. Garage C (RSC): claim tests, MOT on.

insert into public.garages (id, slug, name, booking_prefix, mot_enabled, status) values
  ('a1500000-0000-4000-8000-000000000001', 'pgtap-sched-rem-s', 'Schedule Garage S', 'RSS', true, 'active'),
  ('b1500000-0000-4000-8000-000000000001', 'pgtap-sched-rem-m', 'Schedule Garage M', 'RSM', false, 'active'),
  ('c1500000-0000-4000-8000-000000000001', 'pgtap-sched-rem-x', 'Schedule Garage X', 'RSX', true, 'suspended'),
  ('d1500000-0000-4000-8000-000000000001', 'pgtap-claim-rem-c', 'Claim Garage C', 'RSC', true, 'active');

select public.seed_garage_defaults(id) from public.garages where slug like 'pgtap-%-rem-%';

create function pg_temp.s() returns uuid language sql as $$ select 'a1500000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.m() returns uuid language sql as $$ select 'b1500000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.x() returns uuid language sql as $$ select 'c1500000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.c() returns uuid language sql as $$ select 'd1500000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.service_of(p_garage uuid, p_name text) returns uuid language sql as $$
  select id from public.services where garage_id = p_garage and name = p_name
$$;
create function pg_temp.bay_of(p_garage uuid) returns uuid language sql as $$
  select id from public.resources where garage_id = p_garage and name = 'Bay 1'
$$;
create function pg_temp.sends_of(p_registration text) returns text language sql as $$
  select coalesce(string_agg(concat_ws('|', send.kind, send.due_date, send.offset_days, to_char(send.send_at, 'YYYY-MM-DD"T"HH24:MI"Z"'), send.channel, send.status),
                             ' ' order by send.send_at), 'none')
  from public.reminder_sends send
  join public.vehicles vehicle on vehicle.garage_id = send.garage_id and vehicle.id = send.vehicle_id
  where vehicle.registration = p_registration
$$;

-- ---------------------------------------------------------------------------
-- Fixtures for scheduling (p_today = Friday 20 Mar 2026)
-- ---------------------------------------------------------------------------

insert into public.customers (id, garage_id, name, phone, email, preferred_contact, channel, reminder_consent, consent_at, consent_source, opted_out_at) values
  ('a1500000-0000-4000-8000-000000000601', pg_temp.s(), 'Carol Consent', '+447700915601', 'carol@example.test', 'phone', 'sms', true, '2026-01-01 09:00+00', 'import', null),
  ('a1500000-0000-4000-8000-000000000602', pg_temp.s(), 'Whit Whatsapp', '+447700915602', null, 'whatsapp', 'whatsapp', true, '2026-01-01 09:00+00', 'booking', null),
  ('a1500000-0000-4000-8000-000000000603', pg_temp.s(), 'Nora Noconsent', '+447700915603', null, 'phone', 'sms', false, null, null, null),
  ('a1500000-0000-4000-8000-000000000604', pg_temp.s(), 'Otto Optedout', '+447700915604', null, 'phone', 'sms', true, '2026-01-01 09:00+00', 'booking', '2026-02-01 09:00+00'),
  ('a1500000-0000-4000-8000-000000000605', pg_temp.s(), 'Emma Email', '+447700915605', 'emma@example.test', 'email', 'email', true, '2026-01-01 09:00+00', 'booking', null),
  ('a1500000-0000-4000-8000-000000000606', pg_temp.s(), 'Ivy Noemail', '+447700915606', null, 'email', 'email', true, '2026-01-01 09:00+00', 'booking', null),
  ('a1500000-0000-4000-8000-000000000607', pg_temp.s(), 'Sam Service', '+447700915607', null, 'phone', 'sms', true, '2026-01-01 09:00+00', 'booking', null),
  ('a1500000-0000-4000-8000-000000000608', pg_temp.s(), 'Bea Booked', '+447700915608', null, 'phone', 'sms', true, '2026-01-01 09:00+00', 'booking', null),
  ('b1500000-0000-4000-8000-000000000621', pg_temp.m(), 'Mo Motoff', '+447700915621', null, 'phone', 'sms', true, '2026-01-01 09:00+00', 'booking', null),
  ('c1500000-0000-4000-8000-000000000631', pg_temp.x(), 'Xena Suspended', '+447700915631', null, 'phone', 'sms', true, '2026-01-01 09:00+00', 'booking', null);

insert into public.vehicles (garage_id, customer_id, registration, mot_expiry, last_service_at) values
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000601', 'RS15CAR', '2026-04-26', null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000602', 'RS15WHT', '2026-03-25', null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000603', 'RS15NOR', '2026-04-10', null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000604', 'RS15OTT', '2026-04-10', null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000605', 'RS15EMM', '2026-04-10', null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000606', 'RS15IVY', '2026-04-10', null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000601', 'RS15FAR', '2026-09-01', null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000607', 'RS15SAM', null, '2025-04-25 09:30+00'),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000608', 'RS15BEA', null, null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000608', 'RS15REV', null, null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000601', 'RS15COL', null, null),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000602', 'RS15OCT', '2026-11-01', null),
  (pg_temp.m(), 'b1500000-0000-4000-8000-000000000621', 'RS15MOO', '2026-04-10', '2025-04-30 09:00+00'),
  (pg_temp.x(), 'c1500000-0000-4000-8000-000000000631', 'RS15XEN', '2026-04-10', '2025-04-30 09:00+00');

create function pg_temp.vehicle(p_registration text) returns uuid language sql as $$
  select id from public.vehicles where registration = p_registration
$$;

-- Collected bookings: RS15BEA's last non-MOT visit (20 Apr 2025) anchors its
-- service reminder; a later MOT-only visit does not. RS15REV was collected on
-- 19 Mar 2026 (status change event, a day after its appointment) and RS15COL
-- on 18 Mar 2026 (no event: its appointment end counts).
insert into public.bookings (garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000608', pg_temp.vehicle('RS15BEA'), pg_temp.service_of(pg_temp.s(), 'Diagnostics'), pg_temp.bay_of(pg_temp.s()),
   '2025-04-20 09:00+00', '2025-04-20 10:00+00', '[2025-04-20 09:00+00,2025-04-20 10:15+00)', 'collected', 'phone'),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000608', pg_temp.vehicle('RS15BEA'), pg_temp.service_of(pg_temp.s(), 'MOT'), pg_temp.bay_of(pg_temp.s()),
   '2025-06-01 09:00+00', '2025-06-01 10:00+00', '[2025-06-01 09:00+00,2025-06-01 10:00+00)', 'collected', 'phone'),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000608', pg_temp.vehicle('RS15REV'), pg_temp.service_of(pg_temp.s(), 'Diagnostics'), pg_temp.bay_of(pg_temp.s()),
   '2026-03-18 09:00+00', '2026-03-18 10:00+00', '[2026-03-18 09:00+00,2026-03-18 10:15+00)', 'confirmed', 'phone'),
  (pg_temp.s(), 'a1500000-0000-4000-8000-000000000601', pg_temp.vehicle('RS15COL'), pg_temp.service_of(pg_temp.s(), 'Diagnostics'), pg_temp.bay_of(pg_temp.s()),
   '2026-03-18 14:00+00', '2026-03-18 15:00+00', '[2026-03-18 14:00+00,2026-03-18 15:15+00)', 'collected', 'phone');
update public.bookings set status = 'collected' where vehicle_id = pg_temp.vehicle('RS15REV');
update public.booking_events set at = '2026-03-19 16:30+00'
where booking_id = (select id from public.bookings where vehicle_id = pg_temp.vehicle('RS15REV')) and type = 'status_changed';

-- ---------------------------------------------------------------------------
-- schedule_reminders
-- ---------------------------------------------------------------------------

set local role service_role;
select is(
  public.schedule_reminders(pg_temp.s(), '2026-03-20'),
  '{"mot": 4, "review": 0, "service": 2, "cancelled": 0}'::jsonb,
  'garage S: four MOT reminders and two service reminders are scheduled'
);
reset role;

select is(
  pg_temp.sends_of('RS15CAR'),
  'mot|2026-04-26|28|2026-03-29T09:00Z|sms|scheduled mot|2026-04-26|7|2026-04-19T09:00Z|sms|scheduled',
  'MOT 28 and 7 days before expiry at 10:00 London: 29 Mar 2026 (clocks go forward) is 09:00 UTC; the 30-day horizon is inclusive'
);
select is(
  pg_temp.sends_of('RS15WHT'),
  'mot|2026-03-25|7|2026-03-18T10:00Z|whatsapp|scheduled',
  'a send day up to 3 days ago is caught up (10:00 GMT); one further back is not; the customer''s channel is used'
);
select is(
  pg_temp.sends_of('RS15EMM'),
  'mot|2026-04-10|7|2026-04-03T09:00Z|email|scheduled',
  'email customers get email reminders'
);
select is(
  pg_temp.sends_of('RS15NOR') || ',' || pg_temp.sends_of('RS15OTT') || ',' || pg_temp.sends_of('RS15IVY') || ',' || pg_temp.sends_of('RS15FAR'),
  'none,none,none,none',
  'nothing for a customer without consent, one who opted out, an email customer with no address, or a send day beyond 30 days'
);
select is(
  pg_temp.sends_of('RS15SAM'),
  'service|2026-04-25|335|2026-03-26T10:00Z|sms|scheduled',
  'service reminder 335 days after last_service_at; due a year after it'
);
select is(
  pg_temp.sends_of('RS15BEA'),
  'service|2026-04-20|335|2026-03-21T10:00Z|sms|scheduled',
  'without last_service_at, the last collected non-MOT booking anchors the service reminder'
);
select is(
  (select count(*)::integer from public.reminder_sends send
   join public.reminder_rules rule on rule.garage_id = send.garage_id and rule.id = send.rule_id and rule.kind = send.kind
   join public.vehicles vehicle on vehicle.garage_id = send.garage_id and vehicle.id = send.vehicle_id and vehicle.customer_id = send.customer_id
   where send.garage_id = pg_temp.s()),
  6, 'every send points at its rule and at the vehicle''s customer'
);

set local role service_role;
select is(
  public.schedule_reminders(pg_temp.m(), '2026-03-20'),
  '{"mot": 0, "review": 0, "service": 1, "cancelled": 0}'::jsonb,
  'garage M (MOT off): no MOT reminder, but the service reminder is scheduled'
);
select is(
  public.schedule_reminders(pg_temp.x(), '2026-03-20'),
  '{"mot": 0, "review": 0, "service": 0, "cancelled": 0}'::jsonb,
  'a suspended garage schedules nothing'
);
select is(
  public.schedule_reminders(pg_temp.s(), '2026-03-20'),
  '{"mot": 0, "review": 0, "service": 0, "cancelled": 0}'::jsonb,
  'running it again for the same day adds nothing'
);
reset role;
select is((select count(*)::integer from public.reminder_sends where garage_id = pg_temp.s()), 6, 'and garage S still has six sends');

-- Review requests once the rule is switched on.
update public.reminder_rules set enabled = true where garage_id = pg_temp.s() and kind = 'review';
set local role service_role;
select is(
  public.schedule_reminders(pg_temp.s(), '2026-03-20'),
  '{"mot": 0, "review": 2, "service": 0, "cancelled": 0}'::jsonb,
  'with the review rule on, two review requests are scheduled'
);
reset role;
select is(
  pg_temp.sends_of('RS15REV') || ' ' || pg_temp.sends_of('RS15COL'),
  'review|2026-03-19|1|2026-03-20T10:00Z|sms|scheduled review|2026-03-18|1|2026-03-19T10:00Z|sms|scheduled',
  'reviews follow the day of collection (the status change, else the appointment end) by one day'
);

-- 25 Oct 2026, clocks go back: 10:00 London is 10:00 UTC again.
set local role service_role;
select is(
  public.schedule_reminders(pg_temp.s(), '2026-10-20'),
  '{"mot": 1, "review": 0, "service": 0, "cancelled": 0}'::jsonb,
  'on 20 Oct 2026 one MOT reminder falls in the window'
);
reset role;
select is(
  pg_temp.sends_of('RS15OCT'),
  'mot|2026-11-01|7|2026-10-25T10:00Z|whatsapp|scheduled',
  'a reminder on 25 Oct 2026 (clocks go back) is at 10:00 GMT = 10:00 UTC'
);

-- MOT done elsewhere and a new service recorded: pending sends are cancelled.
update public.vehicles set mot_expiry = '2027-04-26' where registration = 'RS15CAR';
update public.vehicles set last_service_at = '2026-03-01 10:00+00' where registration = 'RS15SAM';
set local role service_role;
select is(
  public.schedule_reminders(pg_temp.s(), '2026-03-20'),
  '{"mot": 0, "review": 0, "service": 0, "cancelled": 3}'::jsonb,
  'when the MOT expiry or last service moves, the pending sends for the old date are cancelled'
);
reset role;
select is(
  pg_temp.sends_of('RS15CAR') || ' ' || pg_temp.sends_of('RS15SAM'),
  'mot|2026-04-26|28|2026-03-29T09:00Z|sms|cancelled mot|2026-04-26|7|2026-04-19T09:00Z|sms|cancelled service|2026-04-25|335|2026-03-26T10:00Z|sms|cancelled',
  'the cancelled sends stay for the record'
);
select is(
  (select string_agg(distinct skip_reason, ',') from public.reminder_sends where status = 'cancelled' and garage_id = pg_temp.s()),
  'due_date_changed', 'with the reason due_date_changed'
);
update public.vehicles set mot_expiry = '2026-04-26' where registration = 'RS15CAR';
set local role service_role;
select is(
  public.schedule_reminders(pg_temp.s(), '2026-03-20'),
  '{"mot": 2, "review": 0, "service": 0, "cancelled": 0}'::jsonb,
  'a corrected expiry re-arms the cancelled sends'
);
reset role;
select is(
  pg_temp.sends_of('RS15CAR'),
  'mot|2026-04-26|28|2026-03-29T09:00Z|sms|scheduled mot|2026-04-26|7|2026-04-19T09:00Z|sms|scheduled',
  'the re-armed sends are scheduled again'
);

-- A rule that is off schedules nothing.
update public.reminder_rules set enabled = false where garage_id = pg_temp.m() and kind = 'service';
insert into public.vehicles (garage_id, customer_id, registration, last_service_at) values
  (pg_temp.m(), 'b1500000-0000-4000-8000-000000000621', 'RS15MO2', '2025-04-28 09:00+00');
set local role service_role;
select is(
  (public.schedule_reminders(pg_temp.m(), '2026-03-20'))->>'service',
  '0', 'a switched-off rule schedules nothing'
);
select throws_ok($$select public.schedule_reminders(null, '2026-03-20')$$, '22023', null, 'the garage is required');
select throws_ok($$select public.schedule_reminders('a1500000-0000-4000-8000-000000000001', null)$$, '22023', null, 'the day is required');
select throws_ok($$select public.schedule_reminders(gen_random_uuid(), '2026-03-20')$$, 'P0001', 'GARAGE_NOT_FOUND', 'an unknown garage is refused');
reset role;

-- ---------------------------------------------------------------------------
-- claim_reminder_sends (garage C; p_now = Monday 4 May 2026 03:00 UTC, 04:00
-- London: outside the 09:00-19:00 send window, which the app enforces)
-- ---------------------------------------------------------------------------

insert into public.customers (id, garage_id, name, phone, email, preferred_contact, channel, reminder_consent, consent_at, consent_source, opted_out_at) values
  ('d1500000-0000-4000-8000-000000000801', pg_temp.c(), 'Cara Claim', '+447700915801', null, 'phone', 'sms', true, '2026-01-01 09:00+00', 'import', null),
  ('d1500000-0000-4000-8000-000000000802', pg_temp.c(), 'Olly Optout', '+447700915802', null, 'phone', 'sms', true, '2026-01-01 09:00+00', 'booking', null),
  ('d1500000-0000-4000-8000-000000000803', pg_temp.c(), 'Nell Noconsent', '+447700915803', null, 'phone', 'sms', false, null, null, null),
  ('d1500000-0000-4000-8000-000000000804', pg_temp.c(), 'Dave Newowner', '+447700915804', null, 'whatsapp', 'whatsapp', true, '2026-01-01 09:00+00', 'booking', null),
  ('d1500000-0000-4000-8000-000000000805', pg_temp.c(), 'Earl Oldowner', '+447700915805', null, 'phone', 'sms', false, null, null, null),
  ('d1500000-0000-4000-8000-000000000806', pg_temp.c(), 'Emil Noaddress', '+447700915806', null, 'email', 'email', true, '2026-01-01 09:00+00', 'booking', null),
  ('d1500000-0000-4000-8000-000000000807', pg_temp.c(), 'Pia Prebooked', '+447700915807', null, 'phone', 'sms', true, '2026-01-01 09:00+00', 'booking', null);

insert into public.vehicles (garage_id, customer_id, registration, make, model, mot_expiry, last_service_at) values
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000801', 'RC15AAA', 'Toyota', 'Yaris', '2026-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000802', 'RC15OPT', 'Ford', 'Fiesta', '2026-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000803', 'RC15NOC', 'Ford', 'Ka', '2026-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000804', 'RC15MOV', 'Honda', 'Civic', '2026-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000801', 'RC15DUE', 'Kia', 'Ceed', '2027-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000807', 'RC15SIB', 'Mazda', '2', '2026-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000807', 'RC15MOT', 'Mazda', '3', '2026-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000806', 'RC15EML', 'Seat', 'Ibiza', '2026-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000801', 'RC15FUT', 'Skoda', 'Fabia', '2026-05-12', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000801', 'RC15OLD', 'Fiat', 'Panda', null, '2025-05-20 09:00+00'),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000801', 'RC15PST', 'Fiat', 'Tipo', '2026-05-01', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000801', 'RC15OFF', 'Opel', 'Astra', '2026-05-11', null),
  (pg_temp.c(), 'd1500000-0000-4000-8000-000000000807', 'RC15SVC', 'Volvo', 'V40', null, '2025-06-01 09:00+00');

-- Pia has already booked RC15SIB (through its 28-day reminder) and an MOT for RC15MOT.
insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source) values
  ('d1500000-0000-4000-8000-000000000b01', pg_temp.c(), 'd1500000-0000-4000-8000-000000000807', pg_temp.vehicle('RC15SIB'),
   pg_temp.service_of(pg_temp.c(), 'Diagnostics'), pg_temp.bay_of(pg_temp.c()),
   '2026-05-06 09:00+00', '2026-05-06 10:00+00', '[2026-05-06 09:00+00,2026-05-06 10:15+00)', 'confirmed', 'reminder'),
  ('d1500000-0000-4000-8000-000000000b02', pg_temp.c(), 'd1500000-0000-4000-8000-000000000807', pg_temp.vehicle('RC15MOT'),
   pg_temp.service_of(pg_temp.c(), 'MOT'), pg_temp.bay_of(pg_temp.c()),
   '2026-05-08 09:00+00', '2026-05-08 10:00+00', '[2026-05-08 09:00+00,2026-05-08 10:00+00)', 'confirmed', 'online');

create function pg_temp.c_rule(p_kind text) returns uuid language sql as $$
  select id from public.reminder_rules where garage_id = 'd1500000-0000-4000-8000-000000000001' and kind = p_kind
$$;

-- [registration, customer the send was scheduled for, kind, due, offset, send_at]
insert into public.reminder_sends (garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel)
select pg_temp.c(), pg_temp.c_rule(plan.kind), pg_temp.vehicle(plan.registration), plan.customer_id, plan.kind, plan.due_date, plan.offset_days, plan.send_at, 'sms'
from (values
  ('RC15OLD', 'd1500000-0000-4000-8000-000000000801'::uuid, 'service', date '2026-05-20', 335, timestamptz '2026-04-20 09:00+00'),
  ('RC15PST', 'd1500000-0000-4000-8000-000000000801'::uuid, 'mot', date '2026-05-01', 7, timestamptz '2026-04-24 09:00+00'),
  ('RC15SVC', 'd1500000-0000-4000-8000-000000000807'::uuid, 'service', date '2026-06-01', 335, timestamptz '2026-05-02 09:00+00'),
  ('RC15OPT', 'd1500000-0000-4000-8000-000000000802'::uuid, 'mot', date '2026-05-11', 7, timestamptz '2026-05-03 08:00+00'),
  ('RC15NOC', 'd1500000-0000-4000-8000-000000000803'::uuid, 'mot', date '2026-05-11', 7, timestamptz '2026-05-03 08:10+00'),
  ('RC15AAA', 'd1500000-0000-4000-8000-000000000801'::uuid, 'mot', date '2026-05-11', 7, timestamptz '2026-05-03 09:00+00'),
  ('RC15MOV', 'd1500000-0000-4000-8000-000000000805'::uuid, 'mot', date '2026-05-11', 7, timestamptz '2026-05-03 09:10+00'),
  ('RC15DUE', 'd1500000-0000-4000-8000-000000000801'::uuid, 'mot', date '2026-05-11', 7, timestamptz '2026-05-03 09:20+00'),
  ('RC15SIB', 'd1500000-0000-4000-8000-000000000807'::uuid, 'mot', date '2026-05-11', 7, timestamptz '2026-05-03 09:30+00'),
  ('RC15MOT', 'd1500000-0000-4000-8000-000000000807'::uuid, 'mot', date '2026-05-11', 7, timestamptz '2026-05-03 09:40+00'),
  ('RC15EML', 'd1500000-0000-4000-8000-000000000806'::uuid, 'mot', date '2026-05-11', 7, timestamptz '2026-05-03 09:50+00'),
  ('RC15OFF', 'd1500000-0000-4000-8000-000000000801'::uuid, 'mot', date '2026-05-11', 14, timestamptz '2026-05-03 10:00+00'),
  ('RC15FUT', 'd1500000-0000-4000-8000-000000000801'::uuid, 'mot', date '2026-05-12', 7, timestamptz '2026-05-05 09:00+00')
) plan(registration, customer_id, kind, due_date, offset_days, send_at);

-- RC15SIB's 28-day reminder was sent and booked.
insert into public.reminder_sends (garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel, status, claimed_at, sent_at, booking_id)
values (pg_temp.c(), pg_temp.c_rule('mot'), pg_temp.vehicle('RC15SIB'), 'd1500000-0000-4000-8000-000000000807', 'mot', '2026-05-11', 28,
        '2026-04-13 09:00+00', 'sms', 'sent', '2026-04-13 09:00+00', '2026-04-13 09:00+01', 'd1500000-0000-4000-8000-000000000b01');

-- Since scheduling: Olly replied STOP and RC15MOV changed hands (to Dave).
update public.customers set opted_out_at = '2026-05-01 12:00+00' where id = 'd1500000-0000-4000-8000-000000000802';
update public.vehicles set customer_id = 'd1500000-0000-4000-8000-000000000804' where registration = 'RC15MOV';

create temp table claim_round (round integer, claim jsonb not null);

insert into claim_round select 1, to_jsonb(claimed) from public.claim_reminder_sends(pg_temp.c(), '2026-05-04 03:00+00', 1) claimed;
select is(
  (select array_agg(claim->>'registration') from claim_round where round = 1),
  array['RC15SVC'],
  'with a limit of 1, the first sendable reminder is claimed; earlier ones that cannot be sent are skipped on the way'
);
select is(
  (select pg_temp.sends_of('RC15OLD') || ' ' || pg_temp.sends_of('RC15PST')),
  'service|2026-05-20|335|2026-04-20T09:00Z|sms|skipped mot|2026-05-01|7|2026-04-24T09:00Z|sms|skipped',
  'a reminder more than 7 days late, or past its due date, is skipped'
);
select is(
  (select count(*)::integer from public.reminder_sends where garage_id = pg_temp.c() and status = 'scheduled' and send_at <= '2026-05-04 03:00+00'),
  9, 'the other due sends wait for the next claim'
);

insert into claim_round select 2, to_jsonb(claimed) from public.claim_reminder_sends(pg_temp.c(), '2026-05-04 03:00+00', 10) claimed;
select is(
  (select array_agg(claim->>'registration' order by claim->>'send_at') from claim_round where round = 2),
  array['RC15AAA', 'RC15MOV'],
  'the next claim (outside quiet hours: the app enforces them) takes the two sendable reminders in send order'
);
select is(
  (select claim - 'id' - 'rule_id' - 'vehicle_id' from claim_round where round = 2 and claim->>'registration' = 'RC15AAA'),
  jsonb_build_object(
    'kind', 'mot', 'due_date', '2026-05-11', 'offset_days', 7, 'send_at', '2026-05-03T09:00:00+00:00', 'channel', 'sms',
    'template', '{garage}: Hi {first_name}, MOT due {due_date}. Book: {link}',
    'customer_id', 'd1500000-0000-4000-8000-000000000801', 'customer_name', 'Cara Claim', 'phone', '+447700915801', 'email', null,
    'registration', 'RC15AAA', 'make', 'Toyota', 'model', 'Yaris'),
  'a claimed reminder carries what the sender renders: template, customer, contact details and car'
);
select is(
  (select concat_ws('|', claim->>'customer_name', claim->>'channel') from claim_round where round = 2 and claim->>'registration' = 'RC15MOV'),
  'Dave Newowner|whatsapp',
  'a car that changed hands is reminded to its current owner, on their channel'
);
select is(
  (select concat_ws('|', send.status, send.customer_id, send.channel, send.claimed_at = '2026-05-04 03:00+00')
   from public.reminder_sends send where send.vehicle_id = pg_temp.vehicle('RC15MOV')),
  'sending|d1500000-0000-4000-8000-000000000804|whatsapp|t',
  'the claimed row is sending, re-pointed at the current owner, with its claim time'
);
select is(
  (select string_agg(vehicle.registration || ':' || send.skip_reason, ',' order by send.send_at)
   from public.reminder_sends send join public.vehicles vehicle on vehicle.id = send.vehicle_id
   where send.garage_id = pg_temp.c() and send.status = 'skipped'),
  'RC15OLD:expired,RC15PST:expired,RC15OPT:opted_out,RC15NOC:no_consent,RC15DUE:due_date_changed,RC15SIB:already_booked,RC15MOT:already_booked,RC15EML:no_address,RC15OFF:rule_changed',
  'consent, opt-out, address, due date, an existing booking and the rule''s offsets are re-checked at send time'
);
select is(pg_temp.sends_of('RC15FUT'), 'mot|2026-05-12|7|2026-05-05T09:00Z|sms|scheduled', 'a send that is not due yet is left alone');
select is(
  (select count(*)::integer from public.claim_reminder_sends(pg_temp.c(), '2026-05-04 03:00+00', 10)),
  0, 'nothing is claimed twice'
);
select is(
  (select string_agg(distinct status, ',') from public.reminder_sends where garage_id = pg_temp.s() and send_at <= '2026-05-04 03:00+00' and status <> 'cancelled'),
  'scheduled', 'claiming for garage C leaves garage S''s due sends alone'
);

-- A switched-off rule stops its pending sends.
update public.reminder_rules set enabled = false where garage_id = pg_temp.c() and kind = 'mot';
select is(
  (select count(*)::integer from public.claim_reminder_sends(pg_temp.c(), '2026-05-05 10:00+00', 10)),
  0, 'with the MOT rule off, the due MOT reminder is not claimed'
);
select is(
  (select status || ':' || skip_reason from public.reminder_sends where vehicle_id = pg_temp.vehicle('RC15FUT')),
  'skipped:rule_disabled', 'it is skipped as rule_disabled'
);

-- MOT reminders need MOT switched on at send time (garage M, service rule back on).
update public.reminder_rules set enabled = true where garage_id = pg_temp.m() and kind = 'service';
insert into public.reminder_sends (garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel)
values (pg_temp.m(), (select id from public.reminder_rules where garage_id = pg_temp.m() and kind = 'mot'), pg_temp.vehicle('RS15MOO'),
        'b1500000-0000-4000-8000-000000000621', 'mot', '2026-04-10', 7, '2026-04-03 09:00+00', 'sms');
select is(
  (select count(*)::integer from public.claim_reminder_sends(pg_temp.m(), '2026-04-03 12:00+00', 10)),
  1, 'garage M claims its due service reminder'
);
select is(
  (select skip_reason from public.reminder_sends where garage_id = pg_temp.m() and kind = 'mot'),
  'mot_disabled', 'but skips an MOT reminder while MOT is off'
);

-- A suspended garage sends nothing.
insert into public.reminder_sends (garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel)
values (pg_temp.x(), (select id from public.reminder_rules where garage_id = pg_temp.x() and kind = 'mot'), pg_temp.vehicle('RS15XEN'),
        'c1500000-0000-4000-8000-000000000631', 'mot', '2026-04-10', 7, '2026-04-03 09:00+00', 'sms');
select is(
  (select count(*)::integer from public.claim_reminder_sends(pg_temp.x(), '2026-04-03 12:00+00', 10)),
  0, 'a suspended garage claims nothing'
);
select is(
  (select status from public.reminder_sends where garage_id = pg_temp.x()),
  'scheduled', 'and its sends stay scheduled'
);

set local role service_role;
select throws_ok($$select * from public.claim_reminder_sends('d1500000-0000-4000-8000-000000000001', now(), 0)$$, '22023', null, 'the limit must be at least 1');
select throws_ok($$select * from public.claim_reminder_sends('d1500000-0000-4000-8000-000000000001', null, 5)$$, '22023', null, 'the clock is required');
select throws_ok($$select * from public.claim_reminder_sends(gen_random_uuid(), now(), 5)$$, 'P0001', 'GARAGE_NOT_FOUND', 'an unknown garage is refused');
reset role;
set local role authenticated;
select throws_ok($$select * from public.claim_reminder_sends('d1500000-0000-4000-8000-000000000001', now(), 5)$$, '42501', null, 'signed-in staff cannot claim reminders');
select throws_ok($$select public.schedule_reminders('d1500000-0000-4000-8000-000000000001', current_date)$$, '42501', null, 'signed-in staff cannot schedule reminders');
reset role;

select * from finish();
rollback;
