begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(48);

-- P5.6 advanced reports: booking_assignments, assign_booking_technician(),
-- report_revenue_by_service(), report_revenue_by_technician(),
-- report_bay_utilisation() (incl. both clock-change Sundays of 2026),
-- report_hours(), report_reminder_roi(), report_campaign_roi().
--
-- Garage R (Pro, chosen): owner Olu, manager Mo, technician Tia. Garage E
-- (Essentials): owner Eve. Garage Z (Pro): owner Zed. The report week is
-- Mon 19 - Sun 25 Oct 2026 (Europe/London; clocks go back on Sun 25 Oct).
-- R opens Mon-Sat 08:00-17:00 and Sun 00:00-04:00 (a window across the
-- clock change), is closed Wed 21 Oct.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('56000000-0000-4000-8000-0000000000a1', 'reports-owner@pgtap.test', '{"display_name": "Olu Owner"}'::jsonb),
  ('56000000-0000-4000-8000-0000000000a2', 'reports-manager@pgtap.test', '{"display_name": "Mo Manager"}'::jsonb),
  ('56000000-0000-4000-8000-0000000000a3', 'reports-tech@pgtap.test', '{"display_name": "Tia Tech"}'::jsonb),
  ('56000000-0000-4000-8000-0000000000b1', 'reports-ess@pgtap.test', '{}'::jsonb),
  ('56000000-0000-4000-8000-0000000000c1', 'reports-zed@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status, plan, trial_ends_at, plan_chosen) values
  ('a5600000-0000-4000-8000-000000000001', 'pgtap-reports-r', 'Reports Pro', 'RPR', 'active', 'pro', null, 'pro'),
  ('a5600000-0000-4000-8000-000000000002', 'pgtap-reports-e', 'Reports Essentials', 'RPE', 'active', 'essentials', null, 'essentials'),
  ('a5600000-0000-4000-8000-000000000003', 'pgtap-reports-z', 'Reports Other', 'RPZ', 'active', 'pro', null, 'pro');
insert into public.garage_members (garage_id, user_id, role) values
  ('a5600000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a5600000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-0000000000a2', 'manager'),
  ('a5600000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-0000000000a3', 'technician'),
  ('a5600000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-0000000000b1', 'owner'),
  ('a5600000-0000-4000-8000-000000000003', '56000000-0000-4000-8000-0000000000c1', 'owner');

create function pg_temp.r() returns uuid language sql as $$ select 'a5600000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.e() returns uuid language sql as $$ select 'a5600000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.z() returns uuid language sql as $$ select 'a5600000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.as_member(p_user uuid, p_garage uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
         set_config('request.headers', jsonb_build_object('x-garage-id', p_garage)::text, true);
$$;
create function pg_temp.olu() returns void language sql as $$ select pg_temp.as_member('56000000-0000-4000-8000-0000000000a1', 'a5600000-0000-4000-8000-000000000001') $$;
create function pg_temp.b(p_n integer) returns uuid language sql as $$ select ('a5600000-0000-4000-8000-0000000001' || lpad(p_n::text, 2, '0'))::uuid $$;

-- Setup for R (and one booking in Z).
insert into public.resources (id, garage_id, name, kind, active, sort) values
  ('a5600000-0000-4000-8000-000000000201', pg_temp.r(), 'Bay A', 'bay', true, 1),
  ('a5600000-0000-4000-8000-000000000202', pg_temp.r(), 'Bay B', 'bay', true, 2),
  ('a5600000-0000-4000-8000-000000000203', pg_temp.r(), 'Old bay', 'bay', false, 3),
  ('a5600000-0000-4000-8000-000000000204', pg_temp.z(), 'Z bay', 'bay', true, 1);
insert into public.opening_hours (garage_id, weekday, opens, closes)
select pg_temp.r(), day, '08:00', '17:00' from generate_series(1, 6) day;
insert into public.opening_hours (garage_id, weekday, opens, closes) values (pg_temp.r(), 7, '00:00', '04:00');
insert into public.closures (garage_id, starts_on, ends_on, reason) values (pg_temp.r(), '2026-10-21', '2026-10-21', 'Training');
insert into public.services (id, garage_id, name, duration_min, buffer_min, price_pence, price_mode) values
  ('a5600000-0000-4000-8000-000000000301', pg_temp.r(), 'Diagnostics', 60, 15, 5000, 'fixed'),
  ('a5600000-0000-4000-8000-000000000302', pg_temp.r(), 'Full service', 120, 15, 15000, 'fixed'),
  ('a5600000-0000-4000-8000-000000000303', pg_temp.z(), 'Z service', 60, 0, 9900, 'fixed');
insert into public.customers (id, garage_id, name, phone, preferred_contact) values
  ('a5600000-0000-4000-8000-000000000401', pg_temp.r(), 'Report Customer', '+447700956401', 'phone'),
  ('a5600000-0000-4000-8000-000000000402', pg_temp.z(), 'Z Customer', '+447700956402', 'phone');
insert into public.vehicles (id, garage_id, customer_id, registration) values
  ('a5600000-0000-4000-8000-000000000501', pg_temp.r(), 'a5600000-0000-4000-8000-000000000401', 'RP56AAA'),
  ('a5600000-0000-4000-8000-000000000502', pg_temp.z(), 'a5600000-0000-4000-8000-000000000402', 'RP56ZZZ');

-- B1 Diagnostics Bay A Mon 19 09:00 BST, collected (invoiced). B2 Full service
-- Bay B Tue 20 10:00, ready. B3 cancelled. B4 requested Thu 22. B5 Full
-- service Bay A Sun 25 00:30 BST until 03:30 GMT (4 real hours), confirmed.
-- B6 trashed. B7 November. B9 Diagnostics Fri 23, in_progress. B10 credited
-- to a reminder (starts in November). B8 in garage Z.
insert into public.bookings (id, garage_id, customer_id, vehicle_id, service_id, resource_id, starts_at, ends_at, during, status, source, price_pence, created_at, deleted_at)
select pg_temp.b(n), coalesce(g, pg_temp.r()), coalesce(c, 'a5600000-0000-4000-8000-000000000401'::uuid), coalesce(v, 'a5600000-0000-4000-8000-000000000501'::uuid),
       s, res, s_at, e_at, tstzrange(s_at, d_end, '[)'), st, 'phone', price, coalesce(created, '2026-10-01 09:00+00'), deleted
from (values
  (1, null::uuid, null::uuid, null::uuid, 'a5600000-0000-4000-8000-000000000301'::uuid, 'a5600000-0000-4000-8000-000000000201'::uuid,
   '2026-10-19 08:00+00'::timestamptz, '2026-10-19 09:00+00'::timestamptz, '2026-10-19 09:15+00'::timestamptz, 'collected', 5000, null::timestamptz, null::timestamptz),
  (2, null, null, null, 'a5600000-0000-4000-8000-000000000302', 'a5600000-0000-4000-8000-000000000202',
   '2026-10-20 09:00+00', '2026-10-20 11:00+00', '2026-10-20 11:15+00', 'ready', 15000, null, null),
  (3, null, null, null, 'a5600000-0000-4000-8000-000000000301', 'a5600000-0000-4000-8000-000000000201',
   '2026-10-20 12:00+00', '2026-10-20 13:00+00', '2026-10-20 13:15+00', 'cancelled', 5000, null, null),
  (4, null, null, null, 'a5600000-0000-4000-8000-000000000301', 'a5600000-0000-4000-8000-000000000201',
   '2026-10-22 08:00+00', '2026-10-22 09:00+00', '2026-10-22 09:15+00', 'requested', 5000, null, null),
  (5, null, null, null, 'a5600000-0000-4000-8000-000000000302', 'a5600000-0000-4000-8000-000000000201',
   '2026-10-24 23:30+00', '2026-10-25 03:15+00', '2026-10-25 03:30+00', 'confirmed', 15000, null, null),
  (6, null, null, null, 'a5600000-0000-4000-8000-000000000301', 'a5600000-0000-4000-8000-000000000202',
   '2026-10-23 12:00+00', '2026-10-23 13:00+00', '2026-10-23 13:15+00', 'collected', 5000, null, '2026-10-24 09:00+00'),
  (7, null, null, null, 'a5600000-0000-4000-8000-000000000301', 'a5600000-0000-4000-8000-000000000201',
   '2026-11-02 09:00+00', '2026-11-02 10:00+00', '2026-11-02 10:15+00', 'confirmed', 5000, null, null),
  (8, pg_temp.z(), 'a5600000-0000-4000-8000-000000000402', 'a5600000-0000-4000-8000-000000000502', 'a5600000-0000-4000-8000-000000000303', 'a5600000-0000-4000-8000-000000000204',
   '2026-10-20 09:00+00', '2026-10-20 10:00+00', '2026-10-20 10:00+00', 'collected', 9900, null, null),
  (9, null, null, null, 'a5600000-0000-4000-8000-000000000301', 'a5600000-0000-4000-8000-000000000201',
   '2026-10-23 08:00+00', '2026-10-23 09:00+00', '2026-10-23 09:15+00', 'in_progress', 5000, null, null),
  (10, null, null, null, 'a5600000-0000-4000-8000-000000000301', 'a5600000-0000-4000-8000-000000000202',
   '2026-11-03 09:00+00', '2026-11-03 10:00+00', '2026-11-03 10:15+00', 'confirmed', 5000, '2026-10-21 10:00+00', null)
) row_(n, g, c, v, s, res, s_at, e_at, d_end, st, price, created, deleted);

-- Status timelines (the trigger only fires on updates; these are set by hand).
insert into public.booking_events (garage_id, booking_id, type, actor, at, data)
select pg_temp.r(), pg_temp.b(n), 'status_changed', 'staff', at_, jsonb_build_object('from', f, 'to', t)
from (values
  (1, '2026-10-19 07:55+00'::timestamptz, 'confirmed', 'arrived'),
  (1, '2026-10-19 08:00+00', 'arrived', 'in_progress'),
  (1, '2026-10-19 08:20+00', 'in_progress', 'waiting_parts'),
  (1, '2026-10-19 08:50+00', 'waiting_parts', 'in_progress'),
  (1, '2026-10-19 09:30+00', 'in_progress', 'ready'),
  (1, '2026-10-19 10:00+00', 'ready', 'collected'),
  (2, '2026-10-20 09:00+00', 'confirmed', 'arrived'),
  (2, '2026-10-20 11:30+00', 'arrived', 'ready'),
  (9, '2026-10-23 08:00+00', 'confirmed', 'arrived'),
  (9, '2026-10-23 08:10+00', 'arrived', 'in_progress')
) row_(n, at_, f, t);

insert into public.booking_assignments (garage_id, booking_id, technician_id, technician_name) values
  (pg_temp.r(), pg_temp.b(2), '56000000-0000-4000-8000-0000000000a3', 'Tia Tech'),
  (pg_temp.r(), pg_temp.b(9), '56000000-0000-4000-8000-0000000000a3', 'Tia Tech'),
  (pg_temp.r(), pg_temp.b(5), '56000000-0000-4000-8000-0000000000a2', 'Mo Manager');

-- B1's issued invoice; a draft for B2 does not count.
insert into public.invoices (id, garage_id, status, source_type, booking_id, customer_id, vehicle_id, customer_name, created_by, updated_by) values
  ('a5600000-0000-4000-8000-000000000601', pg_temp.r(), 'draft', 'booking', pg_temp.b(1), 'a5600000-0000-4000-8000-000000000401',
   'a5600000-0000-4000-8000-000000000501', 'Report Customer', '56000000-0000-4000-8000-0000000000a1', '56000000-0000-4000-8000-0000000000a1'),
  ('a5600000-0000-4000-8000-000000000602', pg_temp.r(), 'draft', 'booking', pg_temp.b(2), 'a5600000-0000-4000-8000-000000000401',
   'a5600000-0000-4000-8000-000000000501', 'Report Customer', '56000000-0000-4000-8000-0000000000a1', '56000000-0000-4000-8000-0000000000a1');
insert into public.invoice_items (garage_id, invoice_id, description, quantity, unit_price_pence, line_total_pence) values
  (pg_temp.r(), 'a5600000-0000-4000-8000-000000000601', 'Diagnostics and repair', 1, 8000, 0),
  (pg_temp.r(), 'a5600000-0000-4000-8000-000000000602', 'Full service', 1, 99999, 0);
select pg_temp.olu();
set local role authenticated;
select lives_ok($$select public.issue_invoice('a5600000-0000-4000-8000-000000000601')$$, 'the owner issues B1''s invoice');
reset role;
create temp table b1_invoice as select total_pence from public.invoices where id = 'a5600000-0000-4000-8000-000000000601';
grant select on b1_invoice to authenticated;

-- Reminders: two MOT sends and a service send in the week, one MOT send in
-- September; B10 was booked from S1. Metered segments for S1 and S2.
insert into public.reminder_rules (id, garage_id, kind, enabled, offset_days, channel, template) values
  ('a5600000-0000-4000-8000-000000000701', pg_temp.r(), 'mot', true, '{28,7}', 'sms', 'MOT due {due_date}. {link}'),
  ('a5600000-0000-4000-8000-000000000702', pg_temp.r(), 'service', true, '{335}', 'sms', 'Service due. {link}');
insert into public.reminder_sends (id, garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel, status, claimed_at, sent_at)
select id_, pg_temp.r(), rule_, 'a5600000-0000-4000-8000-000000000501', 'a5600000-0000-4000-8000-000000000401', kind_, due_, off_, at_, 'sms', 'sent', at_, at_
from (values
  ('a5600000-0000-4000-8000-000000000801'::uuid, 'a5600000-0000-4000-8000-000000000701'::uuid, 'mot', '2026-11-17'::date, 28, '2026-10-20 09:00+00'::timestamptz),
  ('a5600000-0000-4000-8000-000000000802', 'a5600000-0000-4000-8000-000000000701', 'mot', '2026-11-17', 7, '2026-10-21 09:00+00'),
  ('a5600000-0000-4000-8000-000000000803', 'a5600000-0000-4000-8000-000000000702', 'service', '2027-09-22', 335, '2026-10-22 09:00+00'),
  ('a5600000-0000-4000-8000-000000000804', 'a5600000-0000-4000-8000-000000000701', 'mot', '2026-09-29', 28, '2026-09-01 09:00+00')
) row_(id_, rule_, kind_, due_, off_, at_);
update public.bookings set source = 'reminder', reminder_send_id = 'a5600000-0000-4000-8000-000000000801' where id = pg_temp.b(10);
insert into public.usage_events (garage_id, metric, quantity, period_month, occurred_at, source_key) values
  (pg_temp.r(), 'sms_segments', 2, '2026-10-01', '2026-10-20 09:00+00', 'sms:reminder_send:a5600000-0000-4000-8000-000000000801'),
  (pg_temp.r(), 'sms_segments', 1, '2026-10-01', '2026-10-21 09:00+00', 'sms:reminder_send:a5600000-0000-4000-8000-000000000802'),
  (pg_temp.r(), 'sms_segments', 5, '2026-10-01', '2026-10-21 09:00+00', 'sms:booking:unrelated');

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------

select is((select relrowsecurity from pg_class where oid = 'public.booking_assignments'::regclass), true, 'booking_assignments has RLS on');
select is(has_table_privilege('authenticated', 'public.booking_assignments', 'insert')
          or has_table_privilege('authenticated', 'public.booking_assignments', 'update')
          or has_table_privilege('authenticated', 'public.booking_assignments', 'delete'), false,
          'staff write booking_assignments only through assign_booking_technician()');
select is(has_table_privilege('anon', 'public.booking_assignments', 'select'), false, 'anon reads no assignments');
select is((select count(*)::integer from unnest(array[
             'public.report_revenue_by_service(date, date)', 'public.report_revenue_by_technician(date, date)',
             'public.report_bay_utilisation(date, date)', 'public.report_hours(date, date)',
             'public.report_reminder_roi(date, date)', 'public.report_campaign_roi(date, date)',
             'public.assign_booking_technician(uuid, uuid)']) f(name)
           where has_function_privilege('anon', f.name, 'execute')), 0, 'anon executes no report function');
select is((select count(*)::integer from unnest(array[
             'public.report_window(date, date)', 'public.report_minutes(tstzmultirange)',
             'public.report_jobs(uuid, timestamptz, timestamptz)']) f(name)
           where has_function_privilege('authenticated', f.name, 'execute') or has_function_privilege('service_role', f.name, 'execute')),
          0, 'report internals are granted to no API role');
select is((select count(*)::integer from pg_proc
           where pronamespace = 'public'::regnamespace and proname like 'report\_%' and proname <> 'report_minutes'
             and prosecdef and proconfig = array['search_path=""']), 8, 'report functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Plan and role gating
-- ---------------------------------------------------------------------------

select pg_temp.as_member('56000000-0000-4000-8000-0000000000b1', pg_temp.e());
set local role authenticated;
select throws_ok($$select * from public.report_revenue_by_service('2026-10-19', '2026-10-25')$$,
                 'P0001', 'PLAN_REQUIRED: advanced_reports', 'an Essentials owner is refused revenue by service');
select throws_ok($$select * from public.report_bay_utilisation('2026-10-19', '2026-10-25')$$,
                 'P0001', 'PLAN_REQUIRED: advanced_reports', 'and bay utilisation');
select throws_ok($$select public.assign_booking_technician(gen_random_uuid(), null)$$,
                 'P0001', 'PLAN_REQUIRED: advanced_reports', 'and assigning technicians');
reset role;
select pg_temp.as_member('56000000-0000-4000-8000-0000000000a3', pg_temp.r());
set local role authenticated;
select throws_ok($$select * from public.report_hours('2026-10-19', '2026-10-25')$$, '42501', 'NOT_ALLOWED', 'a technician cannot read reports');
select throws_ok($$select public.assign_booking_technician('a5600000-0000-4000-8000-000000000101', '56000000-0000-4000-8000-0000000000a3')$$,
                 '42501', 'NOT_ALLOWED', 'a technician cannot assign jobs');
select is((select count(*)::integer from public.booking_assignments), 3, 'a technician reads the garage''s assignments');
reset role;
select pg_temp.as_member('56000000-0000-4000-8000-0000000000c1', pg_temp.r());
set local role authenticated;
select throws_ok($$select * from public.report_revenue_by_service('2026-10-19', '2026-10-25')$$, '42501', 'NOT_ALLOWED',
                 'another garage''s owner naming this garage is refused');
select is((select count(*)::integer from public.booking_assignments), 0, 'and reads none of its assignments');
reset role;
select pg_temp.olu();
set local role authenticated;
select throws_ok($$select * from public.report_reminder_roi('2026-10-25', '2026-10-19')$$, '22023', null, 'the range must not end before it starts');
select throws_ok($$select * from public.report_reminder_roi('2025-01-01', '2026-10-19')$$, '22023', null, 'and is at most 366 days');

-- ---------------------------------------------------------------------------
-- Revenue
-- ---------------------------------------------------------------------------

select is(
  (select jsonb_agg(jsonb_build_object('name', service_name, 'n', bookings, 'inv', invoiced_pence, 'est', estimated_pence, 'total', total_pence) order by service_name)
   from public.report_revenue_by_service('2026-10-19', '2026-10-25')),
  jsonb_build_array(
    jsonb_build_object('name', 'Diagnostics', 'n', 2, 'inv', (select total_pence from b1_invoice), 'est', 5000, 'total', (select total_pence from b1_invoice) + 5000),
    jsonb_build_object('name', 'Full service', 'n', 2, 'inv', 0, 'est', 30000, 'total', 30000)
  ),
  'revenue by service: B1 at its issued invoice, B9 at its price; B2 and B5 at their prices (the draft is ignored); cancelled, requested, trashed, November and garage Z left out'
);
select is((select total_pence from b1_invoice) > 0, true, 'the issued invoice has a total');
select is(
  (select jsonb_agg(jsonb_build_object('name', coalesce(technician_name, 'Unassigned'), 'n', bookings, 'total', total_pence)
                    order by technician_name nulls last)
   from public.report_revenue_by_technician('2026-10-19', '2026-10-25')),
  jsonb_build_array(
    jsonb_build_object('name', 'Mo Manager', 'n', 1, 'total', 15000),
    jsonb_build_object('name', 'Tia Tech', 'n', 2, 'total', 20000),
    jsonb_build_object('name', 'Unassigned', 'n', 1, 'total', (select total_pence from b1_invoice))
  ),
  'revenue by technician, unassigned as its own row'
);
select is((select count(*)::integer from public.report_revenue_by_service('2026-10-19', '2026-10-24')), 2,
          'Saturday 24 Oct (local) ends before B5, which starts at 00:30 BST on Sunday');
select is((select sum(bookings)::integer from public.report_revenue_by_service('2026-10-25', '2026-10-25')), 1,
          'B5 (23:30 UTC on Saturday) is on Sunday 25 Oct in the garage''s time zone');

-- ---------------------------------------------------------------------------
-- Bay utilisation
-- ---------------------------------------------------------------------------

select is((select count(*)::integer from public.report_bay_utilisation('2026-10-19', '2026-10-25')), 14,
          'one row per active resource per day (the unused inactive bay is left out)');
select is(
  (select jsonb_object_agg(to_char(day, 'Dy DD'), jsonb_build_array(open_minutes, booked_minutes))
   from public.report_bay_utilisation('2026-10-19', '2026-10-25') where resource_name = 'Bay A'),
  '{"Mon 19": [540, 75], "Tue 20": [540, 0], "Wed 21": [0, 0], "Thu 22": [540, 75], "Fri 23": [540, 75], "Sat 24": [540, 0], "Sun 25": [300, 240]}'::jsonb,
  'Bay A: 9-hour days, the closure is 0, the cancelled booking is free, the requested one holds the bay, and Sun 25 Oct (clocks back) opens 5 real hours with 4 booked'
);
select is(
  (select jsonb_object_agg(to_char(day, 'Dy DD'), booked_minutes) filter (where booked_minutes > 0)
   from public.report_bay_utilisation('2026-10-19', '2026-10-25') where resource_name = 'Bay B'),
  '{"Tue 20": 135}'::jsonb,
  'Bay B: the full service with its buffer; the trashed booking is not counted'
);
select is((select open_minutes from public.report_bay_utilisation('2026-03-29', '2026-03-29') where resource_name = 'Bay A'), 180,
          'Sun 29 Mar 2026 (clocks forward): 00:00-04:00 is 3 real hours');
select is((select open_minutes from public.report_bay_utilisation('2026-11-01', '2026-11-01') where resource_name = 'Bay A'), 240,
          'an ordinary Sunday: 4 hours');
select is((select open_minutes from public.report_bay_utilisation('2026-03-30', '2026-03-30') where resource_name = 'Bay A'), 540,
          'the Monday after the change is an ordinary 9-hour day');

-- ---------------------------------------------------------------------------
-- Hours sold vs worked
-- ---------------------------------------------------------------------------

select is(
  (select jsonb_agg(jsonb_build_object('name', coalesce(technician_name, 'Unassigned'), 'jobs', jobs, 'measured', measured_jobs,
                                       'sold', sold_minutes, 'worked', worked_minutes) order by technician_name nulls last)
   from public.report_hours('2026-10-19', '2026-10-25')),
  '[{"name": "Tia Tech", "jobs": 2, "sold": 120, "worked": 150, "measured": 1},
    {"name": "Unassigned", "jobs": 1, "sold": 60, "worked": 60, "measured": 1}]'::jsonb,
  'hours: B1 worked 20 + 40 min in progress (parts wait excluded); B2 had no in-progress step so arrived to ready counts; B9 is not finished; B5 has not arrived'
);

-- ---------------------------------------------------------------------------
-- Reminder and campaign ROI
-- ---------------------------------------------------------------------------

select is(
  (select jsonb_agg(jsonb_build_object('kind', kind, 'sent', sent, 'booked', booked, 'pence', pence, 'segments', sms_segments::integer))
   from public.report_reminder_roi('2026-10-19', '2026-10-25')),
  '[{"kind": "mot", "sent": 2, "booked": 1, "pence": 5000, "segments": 3},
    {"kind": "service", "sent": 1, "booked": 0, "pence": 0, "segments": 0}]'::jsonb,
  'reminder ROI per kind: September''s send is out of range, unrelated SMS segments are not counted'
);
select is((select jsonb_agg(to_jsonb(roi)) from public.report_reminder_roi('2026-10-19', '2026-10-25') roi
           where kind = 'mot') -> 0 ->> 'pence', '5000', 'the reminder booking is credited at its price');
select is((select count(*)::integer from public.report_reminder_roi('2026-08-01', '2026-08-31')), 0, 'nothing in August');
select is((select to_jsonb(roi) from public.report_campaign_roi('2026-10-19', '2026-10-25') roi),
          case when to_regclass('public.campaign_sends') is null
               then '{"available": false, "sent": 0, "booked": 0, "pence": 0}'::jsonb
               else (select to_jsonb(roi) from public.report_campaign_roi('2026-10-19', '2026-10-25') roi) end,
          'campaign ROI is unavailable until campaigns are installed');
select is((select available from public.report_campaign_roi('2026-10-19', '2026-10-25')),
          to_regclass('public.campaign_sends') is not null, 'available follows the campaign_sends table');

-- ---------------------------------------------------------------------------
-- The manager reads reports too; garage Z sees only its own
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.as_member('56000000-0000-4000-8000-0000000000a2', pg_temp.r());
set local role authenticated;
select is((select sum(bookings)::integer from public.report_revenue_by_service('2026-10-19', '2026-10-25')), 4, 'a manager reads revenue');
reset role;
select pg_temp.as_member('56000000-0000-4000-8000-0000000000c1', pg_temp.z());
set local role authenticated;
select is((select jsonb_agg(jsonb_build_array(service_name, total_pence)) from public.report_revenue_by_service('2026-10-19', '2026-10-25')),
          '[["Z service", 9900]]'::jsonb, 'garage Z sees only its own revenue');
select is((select count(*)::integer from public.report_bay_utilisation('2026-10-19', '2026-10-25')), 7, 'and only its own bay');
reset role;

-- ---------------------------------------------------------------------------
-- Assigning technicians
-- ---------------------------------------------------------------------------

select pg_temp.as_member('56000000-0000-4000-8000-0000000000a2', pg_temp.r());
set local role authenticated;
select is((public.assign_booking_technician('a5600000-0000-4000-8000-000000000101', '56000000-0000-4000-8000-0000000000a3')) ->> 'technician_name',
          'Tia Tech', 'a manager assigns Tia to B1 (name snapshot from the account)');
select is((select technician_name from public.booking_assignments where booking_id = 'a5600000-0000-4000-8000-000000000101'), 'Tia Tech',
          'the assignment is stored');
select is((select total_pence from public.report_revenue_by_technician('2026-10-19', '2026-10-25') where technician_name = 'Tia Tech'),
          20000 + (select total_pence from b1_invoice), 'B1 now counts for Tia');
select is((public.assign_booking_technician('a5600000-0000-4000-8000-000000000101', '56000000-0000-4000-8000-0000000000a1')) ->> 'technician_name',
          'Olu Owner', 'reassigning replaces the row (owners can do jobs too)');
select is((select count(*)::integer from public.booking_assignments where booking_id = 'a5600000-0000-4000-8000-000000000101'), 1, 'one row per booking');
select throws_ok($$select public.assign_booking_technician('a5600000-0000-4000-8000-000000000101', '56000000-0000-4000-8000-0000000000c1')$$,
                 '22023', 'NOT_A_MEMBER', 'only members of the garage can be assigned');
select throws_ok($$select public.assign_booking_technician('a5600000-0000-4000-8000-000000000108', '56000000-0000-4000-8000-0000000000a3')$$,
                 'P0001', 'BOOKING_NOT_FOUND', 'another garage''s booking is not found');
select throws_ok($$select public.assign_booking_technician('a5600000-0000-4000-8000-000000000106', '56000000-0000-4000-8000-0000000000a3')$$,
                 'P0001', 'BOOKING_NOT_FOUND', 'a trashed booking is not found');
select lives_ok($$select public.assign_booking_technician('a5600000-0000-4000-8000-000000000101', null)$$, 'unassigning');
select is((select count(*)::integer from public.booking_assignments where booking_id = 'a5600000-0000-4000-8000-000000000101'), 0, 'removes the row');
reset role;
select is((select count(*)::integer from public.admin_audit_log where action = 'booking.technician_assigned' and entity_id = 'a5600000-0000-4000-8000-000000000101'),
          3, 'every change is audited');

select * from finish();
rollback;
