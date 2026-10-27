begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

select ok(
  has_function_privilege('service_role', 'public.consume_rate_limit(text,text,integer,integer)', 'execute'),
  'service role can consume rate limits'
);
select ok(
  not has_function_privilege('anon', 'public.consume_rate_limit(text,text,integer,integer)', 'execute'),
  'anonymous callers cannot consume rate limits directly'
);
select ok(
  not has_function_privilege('authenticated', 'public.consume_rate_limit(text,text,integer,integer)', 'execute'),
  'authenticated callers cannot consume rate limits directly'
);

select is(public.consume_rate_limit('pgtap-lint-repair', 'pgtap', 2, 60), true, 'first request is allowed');
select is(public.consume_rate_limit('pgtap-lint-repair', 'pgtap', 2, 60), true, 'request at the limit is allowed');
select is(public.consume_rate_limit('pgtap-lint-repair', 'pgtap', 2, 60), false, 'request above the limit is rejected');

-- The online form calls the four-argument context without offline services
-- (staff bookings, 20261028002200, pass true; see 025).
select matches(
  pg_get_functiondef('public.booking_service_context(uuid,uuid,text)'::regprocedure)
  || pg_get_functiondef('public.booking_service_context(uuid,uuid,text,boolean)'::regprocedure),
  'booking_service_context\(p_garage_id, p_service_id, p_location_mode, false\).*and \(coalesce\(p_include_offline, false\) or service\.online_enabled\)',
  'bookings and slots only use services enabled for online booking'
);
select matches(
  pg_get_functiondef('public.booking_service_context(uuid,uuid,text,boolean)'::regprocedure),
  'on service\.garage_id = garage\.id\s+and service\.id = p_service_id\s+.*where garage\.id = p_garage_id',
  'bookings and slots only use the garage''s own services'
);
select matches(
  pg_get_functiondef('public.get_invoice_dashboard_without_payments(text,text,date,integer,integer)'::regprocedure),
  'perform public\.require_invoice_actor\(\)',
  'dashboard authorization is retained as an explicit check'
);

-- Garage context helpers: stable, security definer, empty search_path, never
-- executable by anon.
select is(
  (select count(*)::integer from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('request_garage_id', 'garage_role', 'current_garage_id', 'current_garage_role', 'is_platform_admin')
     and p.provolatile = 's'
     and p.prosecdef
     and p.proconfig = array['search_path=""']),
  5, 'the five garage helpers are stable security-definer functions with an empty search_path'
);
select ok(has_function_privilege('authenticated', 'public.current_garage_id()', 'execute'), 'authenticated can resolve the selected garage');
select ok(has_function_privilege('service_role', 'public.current_garage_id()', 'execute'), 'service role can resolve the selected garage');
select ok(not has_function_privilege('anon', 'public.current_garage_id()', 'execute'), 'anon cannot call garage helpers');
select ok(not has_function_privilege('anon', 'public.garage_role(uuid)', 'execute'), 'anon cannot call garage_role');
select is(
  (select count(*)::integer from pg_proc p
   where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')),
  0, 'anon cannot execute any public function'
);
select is(
  (select count(*)::integer from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'),
  0, 'anon has no privilege on any public table'
);
select is(
  (select count(*)::integer from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'is_admin'),
  0, 'SOB''s single-business is_admin() is gone'
);

-- request_garage_id() never raises on bad input.
select set_config('request.headers', '', true);
select is(public.request_garage_id(), null::uuid, 'no headers: null');
select set_config('request.headers', '{"x-garage-id": "not-a-uuid"}', true);
select is(public.request_garage_id(), null::uuid, 'malformed id: null');
select set_config('request.headers', '{not json', true);
select is(public.request_garage_id(), null::uuid, 'malformed header JSON: null');
select set_config('request.headers', '["x-garage-id"]', true);
select is(public.request_garage_id(), null::uuid, 'non-object header JSON: null');
select set_config('request.headers', '{"x-garage-id": "C0000000-0000-4000-8000-000000000001"}', true);
select is(public.request_garage_id(), 'c0000000-0000-4000-8000-000000000001'::uuid, 'a well-formed id is returned');

-- The service role may select any garage; it bypasses RLS and filters itself.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
select is(public.current_garage_id(), 'c0000000-0000-4000-8000-000000000001'::uuid, 'service role JWT: the header is honoured');
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', gen_random_uuid())::text, true);
select is(public.current_garage_id(), null::uuid, 'authenticated non-member: null');
select set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
select is(public.current_garage_id(), null::uuid, 'anon JWT: null');
select set_config('request.jwt.claims', '', true);
set local role service_role;
select is(public.current_garage_id(), 'c0000000-0000-4000-8000-000000000001'::uuid, 'service role session: the header is honoured');
reset role;

select * from finish();
rollback;
