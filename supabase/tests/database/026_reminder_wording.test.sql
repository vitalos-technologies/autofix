begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

-- One-text reminder wording (migration 20261028002300, DECISIONS A169,
-- A184-A185): new garages get the new defaults; rules still on the old
-- default wording move to the new one; rules a garage has edited stay as
-- they are, and so do every rule's switch, timing and channel.
--
-- Garage N: new, seeded by seed_garage_defaults(). Garage O: still on the old
-- defaults (with its own timing and channel). Garage E: edited wording.

insert into public.garages (id, slug, name, booking_prefix) values
  ('a2600000-0000-4000-8000-000000000001', 'pgtap-wording-new', 'Wording New', 'WDN'),
  ('b2600000-0000-4000-8000-000000000001', 'pgtap-wording-old', 'Wording Old', 'WDO'),
  ('c2600000-0000-4000-8000-000000000001', 'pgtap-wording-edit', 'Wording Edited', 'WDE');

create function pg_temp.old_default(p_kind text)
returns text
language sql
as $$
  select case p_kind
    when 'mot' then E'Hi {first_name}, the MOT on your {vehicle} ({reg}) is due on {due_date}. Book a time: {link}\n{garage}.'
    when 'service' then E'Hi {first_name}, your {vehicle} ({reg}) is due a service. Book a time: {link}\n{garage}.'
    when 'review' then E'Hi {first_name}, thanks for bringing your {vehicle} to us. Could you leave a quick review? {link}\n{garage}.'
    when 'missed_call' then E'Sorry we missed your call. Book online in about a minute: {link} or we''ll call you back soon. {garage}'
  end
$$;

create function pg_temp.new_default(p_kind text)
returns text
language sql
as $$
  select case p_kind
    when 'mot' then '{garage}: Hi {first_name}, MOT due {due_date}. Book: {link}'
    when 'service' then '{garage}: Hi {first_name}, service due. Book: {link}'
    when 'review' then '{garage}: thanks {first_name}! Please review us: {link}'
    when 'missed_call' then '{garage}: sorry we missed your call. Book at {link} or we''ll call you back.'
  end
$$;

create function pg_temp.template(p_garage text, p_kind text)
returns text
language sql
as $$ select template from public.reminder_rules where garage_id = p_garage::uuid and kind = p_kind $$;

-- ---------------------------------------------------------------------------
-- New garages
-- ---------------------------------------------------------------------------

select is(
  (public.seed_garage_defaults('a2600000-0000-4000-8000-000000000001')->>'reminder_rules')::integer,
  4, 'a new garage gets the four default rules'
);
select is(
  array(select template from public.reminder_rules where garage_id = 'a2600000-0000-4000-8000-000000000001' order by kind),
  array[pg_temp.new_default('missed_call'), pg_temp.new_default('mot'), pg_temp.new_default('review'), pg_temp.new_default('service')],
  'with the one-text wording'
);
select is(
  (select string_agg(kind || ':' || enabled || ':' || offset_days::text || ':' || channel, ' ' order by kind)
   from public.reminder_rules where garage_id = 'a2600000-0000-4000-8000-000000000001'),
  'missed_call:true:{0}:customer mot:true:{28,7}:customer review:false:{1}:customer service:true:{335}:customer',
  'and the same switches, timing and channel as before'
);
select matches(
  pg_get_functiondef('public.create_garage(uuid, jsonb)'::regprocedure),
  'public\.seed_garage_defaults\(',
  'sign-up (create_garage) seeds through seed_garage_defaults(), so it gets the new wording too'
);

-- ---------------------------------------------------------------------------
-- Existing garages
-- ---------------------------------------------------------------------------

insert into public.reminder_rules (garage_id, kind, enabled, offset_days, channel, template) values
  ('b2600000-0000-4000-8000-000000000001', 'mot', true, '{21,7}', 'sms', pg_temp.old_default('mot')),
  ('b2600000-0000-4000-8000-000000000001', 'service', false, '{330}', 'email', pg_temp.old_default('service')),
  ('b2600000-0000-4000-8000-000000000001', 'review', true, '{2}', 'whatsapp', pg_temp.old_default('review')),
  ('b2600000-0000-4000-8000-000000000001', 'missed_call', true, '{0}', 'sms', pg_temp.old_default('missed_call')),
  ('c2600000-0000-4000-8000-000000000001', 'mot', true, '{28,7}', 'customer', pg_temp.old_default('mot') || ' Thanks!'),
  ('c2600000-0000-4000-8000-000000000001', 'service', true, '{335}', 'customer', replace(pg_temp.old_default('service'), E'\n', ' ')),
  ('c2600000-0000-4000-8000-000000000001', 'review', false, '{1}', 'customer', pg_temp.old_default('mot')),
  ('c2600000-0000-4000-8000-000000000001', 'missed_call', true, '{0}', 'customer', 'Sorry, {garage} missed your call: {link}');

select is(public.apply_one_text_reminder_wording(), 4, 'the four rules still on the old default wording are moved');
select is(
  array[pg_temp.template('b2600000-0000-4000-8000-000000000001', 'mot'), pg_temp.template('b2600000-0000-4000-8000-000000000001', 'service'),
        pg_temp.template('b2600000-0000-4000-8000-000000000001', 'review'), pg_temp.template('b2600000-0000-4000-8000-000000000001', 'missed_call')],
  array[pg_temp.new_default('mot'), pg_temp.new_default('service'), pg_temp.new_default('review'), pg_temp.new_default('missed_call')],
  'a garage on the old defaults gets the new wording for every kind'
);
select is(
  (select string_agg(kind || ':' || enabled || ':' || offset_days::text || ':' || channel, ' ' order by kind)
   from public.reminder_rules where garage_id = 'b2600000-0000-4000-8000-000000000001'),
  'missed_call:true:{0}:sms mot:true:{21,7}:sms review:true:{2}:whatsapp service:false:{330}:email',
  'its switches, timing and channels are kept'
);
select is(
  array[pg_temp.template('c2600000-0000-4000-8000-000000000001', 'mot'), pg_temp.template('c2600000-0000-4000-8000-000000000001', 'service'),
        pg_temp.template('c2600000-0000-4000-8000-000000000001', 'review'), pg_temp.template('c2600000-0000-4000-8000-000000000001', 'missed_call')],
  array[pg_temp.old_default('mot') || ' Thanks!', replace(pg_temp.old_default('service'), E'\n', ' '), pg_temp.old_default('mot'), 'Sorry, {garage} missed your call: {link}'],
  'edited wording stays as the garage wrote it, even a one-character change or another kind''s default'
);
select is(public.apply_one_text_reminder_wording(), 0, 'running it again changes nothing');
select is(
  array(select template from public.reminder_rules where garage_id = 'a2600000-0000-4000-8000-000000000001' order by kind),
  array[pg_temp.new_default('missed_call'), pg_temp.new_default('mot'), pg_temp.new_default('review'), pg_temp.new_default('service')],
  'rules already on the new wording are untouched'
);
select is(
  (public.seed_garage_defaults('b2600000-0000-4000-8000-000000000001')->>'reminder_rules')::integer,
  0, 'seeding again adds nothing to a garage that has its rules'
);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

select is(
  array(select has_function_privilege(api_role, function_name, 'execute')
        from unnest(array['anon', 'authenticated', 'service_role']) api_role,
             unnest(array['public.apply_one_text_reminder_wording()', 'public.seed_default_reminder_rules(uuid)']) function_name),
  array_fill(false, array[6]), 'no API role can call the wording functions'
);
select is(
  array[has_function_privilege('anon', 'public.seed_garage_defaults(uuid)', 'execute'),
        has_function_privilege('authenticated', 'public.seed_garage_defaults(uuid)', 'execute'),
        has_function_privilege('service_role', 'public.seed_garage_defaults(uuid)', 'execute')],
  array[false, false, true], 'seed_garage_defaults() stays service-role only'
);

select * from finish();
rollback;
