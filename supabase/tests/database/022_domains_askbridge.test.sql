begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

-- P4.3/P4.6: set_booking_page_settings (owner only, validated, merges into
-- settings) with settings.askbridge = {enabled, siteKey}, and no knowledge
-- sync: 20261029001300_askbridge_site_key.sql dropped the askbridge.sync
-- triggers and functions, so garage changes queue nothing for Askbridge.

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

-- ---------------------------------------------------------------------------
-- Privileges, and the knowledge sync is gone
-- ---------------------------------------------------------------------------

select ok(has_function_privilege('authenticated', 'public.set_booking_page_settings(jsonb,jsonb,boolean)', 'execute'), 'staff can call set_booking_page_settings (owners only inside)');
select ok(not has_function_privilege('anon', 'public.set_booking_page_settings(jsonb,jsonb,boolean)', 'execute'), 'anon cannot change booking page settings');
select hasnt_function('public', 'enqueue_askbridge_sync', 'enqueue_askbridge_sync() is gone');
select hasnt_function('public', 'askbridge_sync_after_change', 'the askbridge sync trigger function is gone');
select is(
  (select count(*)::integer from pg_trigger where not tgisinternal and tgname like '%askbridge%'),
  0,
  'no askbridge triggers remain'
);

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
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": true}'::jsonb)$$, '22023', null, 'the chat cannot be on without a site key');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": "yes", "siteKey": "pk_0123456789abcdef0123456789abcdef"}'::jsonb)$$, '22023', null, 'enabled must be a boolean');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": false, "siteKey": "wid_1234"}'::jsonb)$$, '22023', null, 'a site key starts with pk_');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": false, "siteKey": "pk_0123456789ABCDEF0123456789ABCDEF"}'::jsonb)$$, '22023', null, 'a site key is lower-case hex');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": false, "siteKey": "pk_0123456789abcdef0123456789abcde"}'::jsonb)$$, '22023', null, 'a site key has exactly 32 hex characters');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": false, "widgetId": "pk_0123456789abcdef0123456789abcdef"}'::jsonb)$$, '22023', null, 'the old widgetId key is refused');
select throws_ok($$select public.set_booking_page_settings(null, '{"enabled": false, "siteKey": "pk_0123456789abcdef0123456789abcdef", "secret": "x"}'::jsonb)$$, '22023', null, 'no other askbridge keys');

select is(
  public.set_booking_page_settings('["https://www.page-a.example", "https://shop.page-a.example:8443"]'::jsonb, null),
  '{"embedOrigins": ["https://www.page-a.example", "https://shop.page-a.example:8443"], "askbridge": {"enabled": false, "siteKey": null}, "showPrices": true}'::jsonb,
  'the owner saves allowed sites'
);

select is(
  public.set_booking_page_settings(null, '{"enabled": true, "siteKey": "pk_0123456789abcdef0123456789abcdef"}'::jsonb) -> 'askbridge',
  '{"enabled": true, "siteKey": "pk_0123456789abcdef0123456789abcdef"}'::jsonb,
  'the owner turns the chat on with a site key'
);

reset role;

select is(
  (select settings - 'embedOrigins' - 'askbridge' from public.garages where id = 'ac000000-0000-4000-8000-000000000001'),
  '{"faqs": [{"question": "Parking?", "answer": "Yes"}], "tagline": "Kept"}'::jsonb,
  'other settings keys are untouched'
);

select is(
  (select settings from public.garages where id = 'bc000000-0000-4000-8000-000000000001'),
  '{}'::jsonb,
  'garage B is untouched'
);

-- ---------------------------------------------------------------------------
-- Nothing is queued for Askbridge any more (the chat is on for garage A)
-- ---------------------------------------------------------------------------

update public.garages set phone = '+441302000777', settings = settings || '{"faqs": []}'::jsonb where id = 'ac000000-0000-4000-8000-000000000001';
insert into public.services (garage_id, name, duration_min, price_pence, price_mode) values ('ac000000-0000-4000-8000-000000000001', 'Brakes', 60, 9000, 'fixed');
insert into public.opening_hours (garage_id, weekday, opens, closes) values ('ac000000-0000-4000-8000-000000000001', 1, '08:00', '17:00');
insert into public.closures (garage_id, starts_on, ends_on) values ('ac000000-0000-4000-8000-000000000001', current_date + 3, current_date + 3);
insert into public.garage_domains (garage_id, hostname, kind, status) values ('ac000000-0000-4000-8000-000000000001', 'book.page-a.example', 'custom', 'pending_dns');
update public.garage_domains set status = 'active' where hostname = 'book.page-a.example';

select is(
  (select count(*)::integer from public.jobs where kind = 'askbridge.sync'),
  0,
  'with the chat on, profile, FAQ, service, hours, closure and domain changes queue no askbridge.sync job'
);

set local role authenticated;
select pg_temp.act_as('1c000000-0000-4000-8000-0000000000a1', 'ac000000-0000-4000-8000-000000000001');
select is(
  public.set_booking_page_settings(null, '{"enabled": false, "siteKey": "pk_0123456789abcdef0123456789abcdef"}'::jsonb) -> 'askbridge',
  '{"enabled": false, "siteKey": "pk_0123456789abcdef0123456789abcdef"}'::jsonb,
  'turning the chat off keeps the key'
);
reset role;

select * from finish();
rollback;
