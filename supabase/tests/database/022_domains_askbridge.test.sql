begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(29);

-- P4.3/P4.6: set_booking_page_settings (owner only, validated, merges into
-- settings) and the askbridge.sync triggers (widget on only, one job per garage
-- per minute, no job for domains.check's last_checked_at bumps, never another
-- garage's).

insert into auth.users (id, email, raw_user_meta_data) values
  ('1c000000-0000-4000-8000-0000000000a1', 'page-owner-a@pgtap.test', '{}'::jsonb),
  ('1c000000-0000-4000-8000-0000000000a2', 'page-manager-a@pgtap.test', '{}'::jsonb),
  ('1c000000-0000-4000-8000-0000000000b1', 'page-owner-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix, settings) values
  ('ac000000-0000-4000-8000-000000000001', 'pgtap-page-a', 'Page Garage A', 'PGA', '{"faqs": [{"question": "Parking?", "answer": "Yes"}], "tagline": "Kept"}'::jsonb),
  ('bc000000-0000-4000-8000-000000000001', 'pgtap-page-b', 'Page Garage B', 'PGB', '{}'::jsonb);

insert into public.garage_members (garage_id, user_id, role) values
  ('ac000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000a1', 'owner'),
  ('ac000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000a2', 'manager'),
  ('bc000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000b1', 'owner');

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

create function pg_temp.sync_jobs(p_garage uuid)
returns integer
language sql
as $$ select count(*)::integer from public.jobs where kind = 'askbridge.sync' and garage_id = p_garage $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

select ok(has_function_privilege('authenticated', 'public.set_booking_page_settings(jsonb,jsonb)', 'execute'), 'staff can call set_booking_page_settings (owners only inside)');
select ok(not has_function_privilege('anon', 'public.set_booking_page_settings(jsonb,jsonb)', 'execute'), 'anon cannot change booking page settings');
select ok(not has_function_privilege('authenticated', 'public.enqueue_askbridge_sync(uuid)', 'execute'), 'staff cannot queue syncs directly');
select ok(not has_function_privilege('anon', 'public.enqueue_askbridge_sync(uuid)', 'execute'), 'anon cannot queue syncs');
select ok(has_function_privilege('service_role', 'public.enqueue_askbridge_sync(uuid)', 'execute'), 'the service role can queue a sync');
select ok(not has_function_privilege('authenticated', 'public.askbridge_sync_after_change()', 'execute'), 'the trigger function is not callable by staff');

-- ---------------------------------------------------------------------------
-- set_booking_page_settings
-- ---------------------------------------------------------------------------

set local role authenticated;

select pg_temp.act_as('1c000000-0000-4000-8000-0000000000a2', 'ac000000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.set_booking_page_settings('["https://www.page-a.example"]'::jsonb, null)$$,
  '42501', null, 'managers cannot change the booking page settings'
);

select pg_temp.act_as('1c000000-0000-4000-8000-0000000000b1', 'ac000000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.set_booking_page_settings('["https://www.page-a.example"]'::jsonb, null)$$,
  '42501', null, 'an owner of another garage cannot change this garage'
);

select pg_temp.act_as('1c000000-0000-4000-8000-0000000000a1', 'ac000000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_booking_page_settings('["http://www.page-a.example"]'::jsonb, null)$$, '22023', null, 'http origins are refused');
select throws_ok($$select public.set_booking_page_settings('["https://www.page-a.example/book"]'::jsonb, null)$$, '22023', null, 'origins with a path are refused');
select throws_ok($$select public.set_booking_page_settings('["https://*.page-a.example"]'::jsonb, null)$$, '22023', null, 'wildcards are refused');
select throws_ok($$select public.set_booking_page_settings('"https://www.page-a.example"'::jsonb, null)$$, '22023', null, 'origins must be a list');
select throws_ok(
  $$select public.set_booking_page_settings((select jsonb_agg('https://s' || n || '.page-a.example') from generate_series(1, 11) n), null)$$,
  '22023', null, 'at most 10 origins'
);
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": true}'::jsonb)$$, '22023', null, 'the widget cannot be on without an id');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": "yes", "widgetId": "wid_1234"}'::jsonb)$$, '22023', null, 'enabled must be a boolean');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": false, "widgetId": "<script>"}'::jsonb)$$, '22023', null, 'widget ids are letters, digits, _ and -');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": false, "widgetId": "wid_1234", "secret": "x"}'::jsonb)$$, '22023', null, 'no other askbridge keys');

select is(
  public.set_booking_page_settings('["https://www.page-a.example", "https://shop.page-a.example:8443"]'::jsonb, null),
  '{"embedOrigins": ["https://www.page-a.example", "https://shop.page-a.example:8443"], "askbridge": {"enabled": false, "widgetId": null}}'::jsonb,
  'the owner saves allowed sites'
);

reset role;
select is(
  (select settings - 'embedOrigins' from public.garages where id = 'ac000000-0000-4000-8000-000000000001'),
  '{"faqs": [{"question": "Parking?", "answer": "Yes"}], "tagline": "Kept"}'::jsonb,
  'other settings keys are untouched'
);
select is(pg_temp.sync_jobs('ac000000-0000-4000-8000-000000000001'), 0, 'no sync is queued while the widget is off');

-- ---------------------------------------------------------------------------
-- askbridge.sync triggers
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000a1', 'ac000000-0000-4000-8000-000000000001');
select is(
  public.set_booking_page_settings(null, '{"enabled": true, "widgetId": "wid_pageA"}'::jsonb) -> 'askbridge',
  '{"enabled": true, "widgetId": "wid_pageA"}'::jsonb,
  'the owner turns the widget on'
);
reset role;

select is(pg_temp.sync_jobs('ac000000-0000-4000-8000-000000000001'), 1, 'turning the widget on queues a sync');
select is(
  (select payload || jsonb_build_object('due_next_minute', run_at = date_trunc('minute', now()) + interval '1 minute', 'key', dedupe_key like 'askbridge.sync:ac000000-0000-4000-8000-000000000001:%')
     from public.jobs where kind = 'askbridge.sync' and garage_id = 'ac000000-0000-4000-8000-000000000001'),
  '{"garageId": "ac000000-0000-4000-8000-000000000001", "due_next_minute": true, "key": true}'::jsonb,
  'the job names the garage, runs the minute after and has a per-garage, per-minute key'
);

update public.garages set phone = '+441302000777' where id = 'ac000000-0000-4000-8000-000000000001';
insert into public.services (garage_id, name, duration_min, price_pence, price_mode) values ('ac000000-0000-4000-8000-000000000001', 'Brakes', 60, 9000, 'fixed');
insert into public.opening_hours (garage_id, weekday, opens, closes) values ('ac000000-0000-4000-8000-000000000001', 1, '08:00', '17:00');
select is(pg_temp.sync_jobs('ac000000-0000-4000-8000-000000000001'), 1, 'changes in the same minute share one job (debounced)');

delete from public.jobs where kind = 'askbridge.sync';
update public.garages set accent = '#0f766e' where id = 'ac000000-0000-4000-8000-000000000001';
select is(pg_temp.sync_jobs('ac000000-0000-4000-8000-000000000001'), 0, 'a change Askbridge does not see (brand colour) queues nothing');

insert into public.garage_domains (garage_id, hostname, kind, status) values ('ac000000-0000-4000-8000-000000000001', 'book.page-a.example', 'custom', 'pending_dns');
update public.garage_domains set last_checked_at = now() where hostname = 'book.page-a.example';
select is(pg_temp.sync_jobs('ac000000-0000-4000-8000-000000000001'), 0, 'domains.check bumps do not queue a sync');
update public.garage_domains set status = 'active' where hostname = 'book.page-a.example';
select is(pg_temp.sync_jobs('ac000000-0000-4000-8000-000000000001'), 1, 'a custom domain going live queues a sync (the booking link changed)');

delete from public.jobs where kind = 'askbridge.sync';
update public.garages set settings = settings || '{"faqs": []}'::jsonb where id = 'ac000000-0000-4000-8000-000000000001';
select is(pg_temp.sync_jobs('ac000000-0000-4000-8000-000000000001'), 1, 'an FAQ change queues a sync');

insert into public.closures (garage_id, starts_on, ends_on) values ('bc000000-0000-4000-8000-000000000001', current_date + 3, current_date + 3);
select is(pg_temp.sync_jobs('bc000000-0000-4000-8000-000000000001'), 0, 'a garage with the widget off gets nothing, and garage A''s changes never queue B');

select * from finish();
rollback;
