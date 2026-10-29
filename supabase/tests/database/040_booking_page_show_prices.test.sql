begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

-- 29 Oct 2026: "Show prices on my booking page" is settings.showPrices,
-- written only by set_booking_page_settings(p_embed_origins, p_askbridge,
-- p_show_prices) (owner of the selected garage). Absent means true.

insert into auth.users (id, email, raw_user_meta_data) values
  ('1d000000-0000-4000-8000-0000000000a1', 'prices-owner-a@pgtap.test', '{}'::jsonb),
  ('1d000000-0000-4000-8000-0000000000a2', 'prices-manager-a@pgtap.test', '{}'::jsonb),
  ('1d000000-0000-4000-8000-0000000000b1', 'prices-owner-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix, settings) values
  ('ad000000-0000-4000-8000-000000000001', 'pgtap-prices-a', 'Prices Garage A', 'PPA', '{"embedOrigins": ["https://www.prices-a.example"], "tagline": "Kept"}'::jsonb),
  ('bd000000-0000-4000-8000-000000000001', 'pgtap-prices-b', 'Prices Garage B', 'PPB', '{}'::jsonb);

insert into public.garage_members (garage_id, user_id, role) values
  ('ad000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000a1', 'owner'),
  ('ad000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000a2', 'manager'),
  ('bd000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b1', 'owner');

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

select hasnt_function('public', 'set_booking_page_settings', array['jsonb', 'jsonb'], 'the 2-argument set_booking_page_settings is gone (no ambiguous overload)');
select ok(has_function_privilege('authenticated', 'public.set_booking_page_settings(jsonb,jsonb,boolean)', 'execute'), 'staff can call it (owners only inside)');
select ok(not has_function_privilege('anon', 'public.set_booking_page_settings(jsonb,jsonb,boolean)', 'execute'), 'anon cannot');

set local role authenticated;

select pg_temp.act_as('1d000000-0000-4000-8000-0000000000a2', 'ad000000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.set_booking_page_settings(p_show_prices => false)$$,
  '42501', null, 'a manager cannot hide prices'
);

select pg_temp.act_as('1d000000-0000-4000-8000-0000000000b1', 'ad000000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.set_booking_page_settings(p_show_prices => false)$$,
  '42501', null, 'an owner of another garage cannot hide this garage''s prices'
);

select pg_temp.act_as('1d000000-0000-4000-8000-0000000000a1', 'ad000000-0000-4000-8000-000000000001');
select is(
  public.set_booking_page_settings(null, null) -> 'showPrices',
  'true'::jsonb,
  'prices show by default (no showPrices key yet)'
);
select is(
  public.set_booking_page_settings(p_show_prices => false),
  '{"embedOrigins": ["https://www.prices-a.example"], "askbridge": {"enabled": false, "siteKey": null}, "showPrices": false}'::jsonb,
  'the owner hides prices; the other booking-page settings are unchanged'
);
select is(
  public.set_booking_page_settings('["https://shop.prices-a.example"]'::jsonb, null) -> 'showPrices',
  'false'::jsonb,
  'saving embed origins leaves showPrices as it is'
);

reset role;

select is(
  (select settings from public.garages where id = 'ad000000-0000-4000-8000-000000000001'),
  '{"embedOrigins": ["https://shop.prices-a.example"], "tagline": "Kept", "showPrices": false}'::jsonb,
  'stored as settings.showPrices next to the other keys'
);
select is(
  (select settings from public.garages where id = 'bd000000-0000-4000-8000-000000000001'),
  '{}'::jsonb,
  'garage B is untouched'
);

select * from finish();
rollback;
