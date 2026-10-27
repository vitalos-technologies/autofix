begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

-- Agent tool API tokens and call log (P4.2): hashes only, staff never read
-- hashes, owners/managers list and revoke their own garage's tokens, the call
-- log stays inside its garage.

insert into auth.users (id, email, raw_user_meta_data) values
  ('1a000000-0000-4000-8000-0000000000a1', 'agent-owner-a@pgtap.test', '{}'::jsonb),
  ('1a000000-0000-4000-8000-0000000000a2', 'agent-manager-a@pgtap.test', '{}'::jsonb),
  ('1a000000-0000-4000-8000-0000000000a3', 'agent-tech-a@pgtap.test', '{}'::jsonb),
  ('1a000000-0000-4000-8000-0000000000b1', 'agent-owner-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix) values
  ('aa000000-0000-4000-8000-000000000001', 'pgtap-agent-a', 'Agent Garage A', 'AGA'),
  ('ba000000-0000-4000-8000-000000000001', 'pgtap-agent-b', 'Agent Garage B', 'AGB');

insert into public.garage_members (garage_id, user_id, role) values
  ('aa000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-0000000000a1', 'owner'),
  ('aa000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-0000000000a2', 'manager'),
  ('aa000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-0000000000a3', 'technician'),
  ('ba000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-0000000000b1', 'owner');

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
-- Structure and privileges
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.agent_tokens'::regclass), 'agent_tokens has RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.agent_call_log'::regclass), 'agent_call_log has RLS on');
select ok(not has_table_privilege('authenticated', 'public.agent_tokens', 'select'), 'staff cannot select agent_tokens (hashes stay server side)');
select ok(not has_table_privilege('authenticated', 'public.agent_tokens', 'insert,update,delete'), 'staff cannot write agent_tokens directly');
select ok(not has_table_privilege('anon', 'public.agent_tokens', 'select,insert,update,delete'), 'anon has nothing on agent_tokens');
select ok(not has_table_privilege('anon', 'public.agent_call_log', 'select,insert,update,delete'), 'anon has nothing on agent_call_log');
select ok(has_table_privilege('authenticated', 'public.agent_call_log', 'select'), 'staff may read the call log (RLS scopes it)');
select ok(not has_table_privilege('authenticated', 'public.agent_call_log', 'insert,update,delete'), 'staff cannot write the call log');
select ok(not has_function_privilege('authenticated', 'public.issue_agent_token(uuid,text,text[],text)', 'execute'), 'only the service role issues tokens');
select ok(not has_function_privilege('anon', 'public.list_agent_tokens()', 'execute')
  and not has_function_privilege('anon', 'public.revoke_agent_token(uuid)', 'execute'), 'anon cannot list or revoke tokens');

-- ---------------------------------------------------------------------------
-- Issuing (service role)
-- ---------------------------------------------------------------------------

set local role service_role;

select is(
  (public.issue_agent_token('aa000000-0000-4000-8000-000000000001', '  Workforce voice  ', null, repeat('a', 64)) ->> 'name'),
  'Workforce voice', 'issue_agent_token trims the name'
);
select is(
  (select scopes from public.agent_tokens where token_hash = repeat('a', 64)),
  array['lookup_vehicle', 'list_services', 'available_slots', 'create_booking', 'get_booking', 'garage_profile']::text[],
  'a token gets every tool by default'
);
select ok(
  not (public.issue_agent_token('aa000000-0000-4000-8000-000000000001', 'Askbridge', array['list_services', 'garage_profile'], repeat('b', 64)) ? 'token_hash'),
  'issue_agent_token never returns the hash'
);
select lives_ok(
  $$select public.issue_agent_token('ba000000-0000-4000-8000-000000000001', 'Workforce B', array['get_booking'], repeat('c', 64))$$,
  'garage B gets its own token'
);
select throws_ok(
  $$select public.issue_agent_token('aa000000-0000-4000-8000-000000000001', 'Raw', null, 'not-a-hash')$$,
  'P0001', 'INVALID_TOKEN: token_hash must be 64 hex characters', 'only 64-hex hashes are stored'
);
select throws_ok(
  $$select public.issue_agent_token('aa000000-0000-4000-8000-000000000001', 'Copy', null, repeat('a', 64))$$,
  '23505', null, 'token hashes are unique'
);
select throws_ok(
  $$select public.issue_agent_token('aa000000-0000-4000-8000-000000000001', 'Admin', array['cancel_booking'], repeat('d', 64))$$,
  '23514', null, 'scopes are limited to the six tools (no cancel or confirm)'
);
select throws_ok(
  $$select public.issue_agent_token('ca000000-0000-4000-8000-000000000001', 'Ghost', null, repeat('e', 64))$$,
  'P0001', 'INVALID_TOKEN: unknown garage', 'tokens belong to a real garage'
);

-- Call log rows for both garages.
insert into public.agent_call_log (garage_id, token_id, tool, outcome, http_status, latency_ms)
select garage_id, id, 'list_services', 'OK', 200, 12 from public.agent_tokens;

select throws_ok(
  $$insert into public.agent_call_log (garage_id, token_id, tool, outcome, http_status, latency_ms)
    select 'aa000000-0000-4000-8000-000000000001', id, 'get_booking', 'OK', 200, 5 from public.agent_tokens where token_hash = repeat('c', 64)$$,
  '23503', null, 'a call log row cannot name another garage''s token'
);
select throws_ok(
  $$insert into public.agent_call_log (garage_id, tool, outcome, http_status, latency_ms)
    values ('aa000000-0000-4000-8000-000000000001', 'cancel_booking', 'OK', 200, 5)$$,
  '23514', null, 'the call log only names the six tools'
);

select id as token_a_id from public.agent_tokens where token_hash = repeat('a', 64) \gset
select id as token_b_id from public.agent_tokens where token_hash = repeat('c', 64) \gset
reset role;

-- ---------------------------------------------------------------------------
-- Listing and revoking (staff)
-- ---------------------------------------------------------------------------

select pg_temp.act_as('1a000000-0000-4000-8000-0000000000a1', 'aa000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select name from public.list_agent_tokens() order by name', array['Askbridge', 'Workforce voice'], 'owner A lists garage A''s tokens only');
select throws_ok('select token_hash from public.agent_tokens', '42501', null, 'owner A cannot read hashes directly');
select results_eq('select count(*) from public.agent_call_log', array[2::bigint], 'owner A reads garage A''s call log');
reset role;

select pg_temp.act_as('1a000000-0000-4000-8000-0000000000a3', 'aa000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select count(*) from public.list_agent_tokens()', array[0::bigint], 'a technician lists no tokens');
select throws_ok(
  format('select public.revoke_agent_token(%L)', :'token_a_id'),
  '42501', null, 'a technician cannot revoke tokens'
);
select results_eq('select count(*) from public.agent_call_log', array[2::bigint], 'a technician reads the garage''s call log');
reset role;

-- Owner B forging garage A's header resolves no garage.
select pg_temp.act_as('1a000000-0000-4000-8000-0000000000b1', 'aa000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq('select count(*) from public.list_agent_tokens()', array[0::bigint], 'owner B forging x-garage-id A lists nothing');
select results_eq('select count(*) from public.agent_call_log', array[0::bigint], 'owner B forging x-garage-id A reads no call log');
reset role;

select pg_temp.act_as('1a000000-0000-4000-8000-0000000000a2', 'aa000000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  public.revoke_agent_token((select t.id from public.list_agent_tokens() t where t.name = 'Askbridge')),
  true, 'a manager revokes a garage A token'
);
reset role;
select is(
  (select count(*) from public.agent_tokens where garage_id = 'aa000000-0000-4000-8000-000000000001' and revoked_at is not null),
  1::bigint, 'exactly that token is revoked'
);

select pg_temp.act_as('1a000000-0000-4000-8000-0000000000a2', 'aa000000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  public.revoke_agent_token(:'token_b_id'),
  false, 'garage A staff cannot revoke garage B''s token'
);
reset role;

select * from finish();
rollback;
