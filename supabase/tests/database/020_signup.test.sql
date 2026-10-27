begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

-- P4.4 sign-up and onboarding: create_garage(), complete_garage_onboarding(),
-- garage_invites and the invite functions, list_garage_team(), the front_desk
-- role and the last-owner rule.

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('20000000-0000-4000-8000-0000000000a1', 'new-owner@pgtap.test', now(), '{"display_name":"New Owner"}'::jsonb),
  ('20000000-0000-4000-8000-0000000000a2', 'unconfirmed@pgtap.test', null, '{}'::jsonb),
  ('20000000-0000-4000-8000-0000000000a3', 'invited-tech@pgtap.test', now(), '{}'::jsonb),
  ('20000000-0000-4000-8000-0000000000a4', 'someone-else@pgtap.test', now(), '{}'::jsonb),
  ('20000000-0000-4000-8000-0000000000b1', 'other-owner@pgtap.test', now(), '{}'::jsonb);

-- Garage B exists already, with its own owner.
insert into public.garages (id, slug, name, booking_prefix, status) values
  ('b2000000-0000-4000-8000-000000000001', 'pgtap-signup-b', 'Signup Garage B', 'SGB', 'active');
insert into public.garage_members (garage_id, user_id, role) values
  ('b2000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b1', 'owner');

create function pg_temp.act_as(p_user uuid, p_garage uuid, p_aal text default 'aal1')
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text end, true);
  perform set_config('request.headers',
    case when p_garage is null then '{}' else jsonb_build_object('x-garage-id', p_garage)::text end, true);
end
$$;
grant execute on function pg_temp.act_as(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Structure and grants
-- ---------------------------------------------------------------------------

select has_table('public', 'garage_invites', 'garage_invites exists');
select ok((select relrowsecurity from pg_class where oid = 'public.garage_invites'::regclass), 'garage_invites has RLS on');
select col_not_null('public', 'garage_invites', 'garage_id', 'garage_invites.garage_id is not null');
select ok(not has_table_privilege('anon', 'public.garage_invites', 'select'), 'anon cannot read invites');
select ok(not has_table_privilege('authenticated', 'public.garage_invites', 'select'), 'staff cannot read invites directly (token hashes stay server side)');
select ok(
  not has_table_privilege('authenticated', 'public.garage_invites', 'insert')
  and not has_table_privilege('authenticated', 'public.garage_invites', 'update')
  and not has_table_privilege('authenticated', 'public.garage_invites', 'delete'),
  'staff change invites only through the invite functions'
);
select ok(
  not has_function_privilege('authenticated', 'public.create_garage(uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.create_garage(uuid, jsonb)', 'execute'),
  'create_garage is service-role only'
);
select ok(not has_function_privilege('authenticated', 'public.auth_email_exists(text)', 'execute'), 'auth_email_exists is service-role only');
select ok(
  has_function_privilege('authenticated', 'public.accept_garage_invite(text)', 'execute')
  and not has_function_privilege('anon', 'public.accept_garage_invite(text)', 'execute'),
  'signed-in users (not anon) can accept invites'
);
select ok(
  not has_function_privilege('anon', 'public.complete_garage_onboarding()', 'execute')
  and not has_function_privilege('anon', 'public.create_garage_invite(text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.list_garage_team()', 'execute'),
  'anon runs none of the staff functions'
);
select is(
  (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname in
    ('create_garage', 'complete_garage_onboarding', 'create_garage_invite', 'resend_garage_invite', 'revoke_garage_invite', 'accept_garage_invite', 'list_garage_team', 'list_garage_invites', 'auth_email_exists')
    and prosecdef and proconfig @> array['search_path=""']),
  9, 'the sign-up functions are security definer with an empty search_path'
);

-- ---------------------------------------------------------------------------
-- create_garage
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000a2', '{"name":"Unconfirmed","slug":"pgtap-unconfirmed"}')$$,
  'P0001', 'EMAIL_NOT_CONFIRMED', 'an unconfirmed account cannot create a garage'
);
select throws_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000ff', '{"name":"Ghost","slug":"pgtap-ghost"}')$$,
  'P0001', 'USER_NOT_FOUND', 'an unknown user cannot create a garage'
);
select throws_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000a1', '{"name":"Admin","slug":"admin"}')$$,
  'P0001', 'SLUG_RESERVED', 'reserved slugs are refused'
);
select throws_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000a1', '{"name":"Taken","slug":"pgtap-signup-b"}')$$,
  'P0001', 'SLUG_TAKEN', 'a slug another garage uses is refused'
);
select throws_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000a1', '{"name":"Bad","slug":"Bad Slug"}')$$,
  'P0001', 'INVALID_GARAGE: slug', 'malformed slugs are refused'
);
select throws_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000a1', '{"name":"Bad phone","slug":"pgtap-bad-phone","phone":"01302 123456"}')$$,
  'P0001', 'INVALID_GARAGE: phone', 'phones must be E.164'
);
select throws_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000a1', '{"name":"Bad hours","slug":"pgtap-bad-hours","opening_hours":[{"weekday":1,"opens":"17:00","closes":"09:00"}]}')$$,
  'P0001', 'INVALID_GARAGE: opening_hours', 'opening hours that close before they open are refused'
);
select is((select count(*)::int from public.garages where slug like 'pgtap-bad-%' or slug = 'pgtap-unconfirmed'), 0, 'refused sign-ups leave no garage behind');

select lives_ok(
  $$select set_config('pgtap.created', public.create_garage('20000000-0000-4000-8000-0000000000a1', jsonb_build_object(
    'name', 'Kingsway Autocare',
    'slug', 'PGTap-Kingsway',
    'phone', '+441632960123',
    'email', 'Bookings@Kingsway.example',
    'website', 'https://kingsway-autocare.example/',
    'google_place_id', 'ChIJmockKingswayAutocare01',
    'address', jsonb_build_object('line1', '12 Kingsway', 'line2', '', 'town', 'Doncaster', 'postcode', 'DN4 5AB'),
    'opening_hours', jsonb_build_array(
      jsonb_build_object('weekday', 1, 'opens', '08:00', 'closes', '17:30'),
      jsonb_build_object('weekday', 6, 'opens', '09:00', 'closes', '12:30')
    )
  ))::text, true)$$,
  'a confirmed user creates a garage'
);

create temporary table created_garage as
  select (current_setting('pgtap.created')::jsonb ->> 'garage_id')::uuid as id, current_setting('pgtap.created')::jsonb as result;
grant select on created_garage to authenticated;

select is(
  (select row(slug, name, phone, email, status, booking_prefix, mot_enabled)::text from public.garages where id = (select id from created_garage)),
  row('pgtap-kingsway', 'Kingsway Autocare', '+441632960123', 'bookings@kingsway.example', 'onboarding', 'KA', false)::text,
  'the garage is stored normalised, in onboarding, with a prefix from its name'
);
select is(
  (select address from public.garages where id = (select id from created_garage)),
  '{"line1":"12 Kingsway","town":"Doncaster","postcode":"DN4 5AB"}'::jsonb,
  'empty address lines are dropped'
);
select is(
  (select settings - 'onboarding' from public.garages where id = (select id from created_garage)),
  '{"website":"https://kingsway-autocare.example/","google_place_id":"ChIJmockKingswayAutocare01"}'::jsonb,
  'website and place id go in settings'
);
select is(
  (select role from public.garage_members where garage_id = (select id from created_garage) and user_id = '20000000-0000-4000-8000-0000000000a1'),
  'owner', 'the signed-up user owns the garage'
);
select is(
  (select array_agg(weekday::text || ' ' || opens::text || '-' || closes::text order by weekday) from public.opening_hours where garage_id = (select id from created_garage)),
  array['1 08:00:00-17:30:00', '6 09:00:00-12:30:00'],
  'opening hours from Google replace the default hours'
);
select is(
  (select row(
    (select count(*) from public.services where garage_id = (select id from created_garage)),
    (select count(*) from public.resources where garage_id = (select id from created_garage)),
    (select count(*) from public.reminder_rules where garage_id = (select id from created_garage))
  )::text),
  '(6,4,4)', 'seed_garage_defaults() adds services, bays and reminder rules'
);
select is((select result -> 'seeded' ->> 'opening_hours' from created_garage), '0', 'no default hours were added on top of Google''s');
select is(
  (select count(*)::int from public.admin_audit_log where garage_id = (select id from created_garage) and action = 'garage.created' and actor_id = '20000000-0000-4000-8000-0000000000a1'),
  1, 'the sign-up is audited'
);

-- Default hours when Places gave none; then the per-user daily limit (3).
select lives_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000a1', '{"name":"Second Site","slug":"pgtap-second-site"}')$$,
  'an owner can add a second garage'
);
select is(
  (select count(*)::int from public.opening_hours where garage_id = (select id from public.garages where slug = 'pgtap-second-site')),
  6, 'a garage without Google hours gets the default week'
);
select lives_ok($$select public.create_garage('20000000-0000-4000-8000-0000000000a1', '{"name":"Third Site","slug":"pgtap-third-site"}')$$, 'a third garage today is allowed');
select throws_ok(
  $$select public.create_garage('20000000-0000-4000-8000-0000000000a1', '{"name":"Fourth Site","slug":"pgtap-fourth-site"}')$$,
  'P0001', 'GARAGE_LIMIT_REACHED', 'a fourth garage in 24 hours is refused'
);

-- ---------------------------------------------------------------------------
-- complete_garage_onboarding
-- ---------------------------------------------------------------------------

select pg_temp.act_as('20000000-0000-4000-8000-0000000000b1', (select id from created_garage));
set local role authenticated;
select throws_ok($$select public.complete_garage_onboarding()$$, '42501', 'UNAUTHORISED', 'another garage''s owner cannot finish this garage''s onboarding');
reset role;

insert into public.admin_mfa_policy (singleton, mandatory_mfa_enabled) values (true, true)
  on conflict (singleton) do update set mandatory_mfa_enabled = true;
select pg_temp.act_as('20000000-0000-4000-8000-0000000000a1', (select id from created_garage));
set local role authenticated;
select throws_ok($$select public.complete_garage_onboarding()$$, '42501', 'UNAUTHORISED', 'an owner without MFA cannot finish while MFA is mandatory');
reset role;
-- The rest runs with the rollout switch off (an owner without a factor passes garage_actor_allowed()).
update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

select pg_temp.act_as('20000000-0000-4000-8000-0000000000a1', (select id from created_garage));
set local role authenticated;
select throws_ok($$select public.complete_garage_onboarding()$$, 'P0001', 'DPA_NOT_ACCEPTED', 'the garage cannot go live before the DPA is accepted');
reset role;

select public.accept_garage_agreement((select id from created_garage), '20000000-0000-4000-8000-0000000000a1', 'dpa', '0.1', repeat('a', 64), 'New Owner');

select pg_temp.act_as('20000000-0000-4000-8000-0000000000a1', (select id from created_garage));
set local role authenticated;
select is(public.complete_garage_onboarding(), 'active', 'the owner puts the garage live');
select is(public.complete_garage_onboarding(), 'active', 'finishing again is harmless');
reset role;
select ok((select settings -> 'onboarding' ? 'completed_at' from public.garages where id = (select id from created_garage)), 'completion is recorded');

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------

select pg_temp.act_as('20000000-0000-4000-8000-0000000000a1', (select id from created_garage));
set local role authenticated;
select throws_ok(
  $$select public.create_garage_invite('invited-tech@pgtap.test', 'owner', repeat('1', 64))$$,
  'P0001', 'INVALID_INVITE: role', 'invites cannot make owners'
);
select throws_ok(
  $$select public.create_garage_invite('new-owner@pgtap.test', 'manager', repeat('1', 64))$$,
  'P0001', 'INVITE_ALREADY_MEMBER', 'members cannot be invited again'
);
select is(
  (public.create_garage_invite(' Invited-Tech@PGTap.test ', 'technician', repeat('1', 64))) ->> 'resent',
  'false', 'the owner invites a technician'
);
select is(
  (public.create_garage_invite('invited-tech@pgtap.test', 'front_desk', repeat('2', 64))) ->> 'role',
  'front_desk', 'inviting the same email again re-sends the open invite with the new role'
);
select is((select count(*)::int from public.list_garage_invites()), 1, 'one open invite per email');
reset role;

-- A technician of the garage cannot invite.
insert into public.garage_members (garage_id, user_id, role) values ((select id from created_garage), '20000000-0000-4000-8000-0000000000a4', 'technician');
select pg_temp.act_as('20000000-0000-4000-8000-0000000000a4', (select id from created_garage));
set local role authenticated;
select throws_ok($$select public.create_garage_invite('x@pgtap.test', 'manager', repeat('3', 64))$$, '42501', 'UNAUTHORISED', 'technicians cannot invite');
select is((select count(*)::int from public.list_garage_invites()), 0, 'technicians cannot list invites');
select is(
  (select count(*)::int from public.list_garage_team() where email is not null and not is_self),
  0, 'technicians see the team without other people''s emails'
);
reset role;

-- Garage B's owner sees nothing of garage A's invites, even forging the header.
select pg_temp.act_as('20000000-0000-4000-8000-0000000000b1', (select id from created_garage));
set local role authenticated;
select is((select count(*)::int from public.list_garage_invites()), 0, 'another garage''s owner cannot list the invites');
select is((select count(*)::int from public.list_garage_team()), 0, 'or list the team');
select throws_ok($$select public.revoke_garage_invite('00000000-0000-4000-8000-000000000000')$$, '42501', 'UNAUTHORISED', 'or revoke an invite (the forged garage is not theirs)');
reset role;

-- Accepting.
select pg_temp.act_as('20000000-0000-4000-8000-0000000000a4', null);
set local role authenticated;
select throws_ok($$select public.accept_garage_invite(repeat('2', 64))$$, 'P0001', 'INVITE_EMAIL_MISMATCH', 'only the invited email can accept');
select throws_ok($$select public.accept_garage_invite(repeat('1', 64))$$, 'P0001', 'INVITE_NOT_FOUND', 'the re-sent invite''s old link no longer works');
reset role;

update public.garage_invites set expires_at = now() - interval '1 minute';
select pg_temp.act_as('20000000-0000-4000-8000-0000000000a3', null);
set local role authenticated;
select throws_ok($$select public.accept_garage_invite(repeat('2', 64))$$, 'P0001', 'INVITE_EXPIRED', 'expired invites are refused');
reset role;
update public.garage_invites set expires_at = now() + interval '7 days';

select pg_temp.act_as('20000000-0000-4000-8000-0000000000a3', null);
set local role authenticated;
select is(public.accept_garage_invite(repeat('2', 64)) ->> 'role', 'front_desk', 'the invited person joins with the invited role');
select throws_ok($$select public.accept_garage_invite(repeat('2', 64))$$, 'P0001', 'INVITE_NOT_FOUND', 'an invite works once');
reset role;
select is(
  (select role from public.garage_members where garage_id = (select id from created_garage) and user_id = '20000000-0000-4000-8000-0000000000a3'),
  'front_desk', 'front_desk is a member role'
);

-- ---------------------------------------------------------------------------
-- Last owner
-- ---------------------------------------------------------------------------

select throws_ok(
  $$delete from public.garage_members where garage_id = (select id from created_garage) and user_id = '20000000-0000-4000-8000-0000000000a1'$$,
  '23514', 'GARAGE_NEEDS_AN_OWNER', 'the only owner cannot be removed'
);

select * from finish();
rollback;
