begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(118);

-- Reminders schema (P3.6): tables, constraints, grants, RLS, the default
-- reminder rules, garage deletion and message retention. The job queue is in
-- 014, scheduling and claiming reminders in 015, booking attribution and the
-- won-back figures in 016.

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

select has_table('public', 'reminder_rules', 'reminder_rules exists');
select has_table('public', 'reminder_sends', 'reminder_sends exists');
select has_table('public', 'messages', 'messages exists');
select has_table('public', 'calls', 'calls exists');
select has_table('public', 'garage_phone_numbers', 'garage_phone_numbers exists');
select has_table('public', 'jobs', 'jobs exists');
select has_table('public', 'vehicle_facts', 'vehicle_facts exists');

select is(
  (select count(*)::integer
   from unnest(array['reminder_rules', 'reminder_sends', 'messages', 'calls', 'garage_phone_numbers']) tenant_table(name)
   join information_schema.columns column_info
     on column_info.table_schema = 'public' and column_info.table_name = tenant_table.name and column_info.column_name = 'garage_id'
   where column_info.is_nullable = 'NO' and column_info.column_default = 'current_garage_id()'),
  5, 'every new tenant table has garage_id not null default current_garage_id()'
);
select is(
  (select is_nullable || '/' || coalesce(column_default, 'no default')
   from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'garage_id'),
  'YES/no default', 'jobs.garage_id is optional: platform-wide jobs have no garage'
);
select is(
  (select confdeltype::text from pg_constraint where conrelid = 'public.jobs'::regclass and contype = 'f' and confrelid = 'public.garages'::regclass),
  'c', 'a garage''s jobs go with the garage'
);
select columns_are('public', 'vehicle_facts', array['reg_hash', 'facts', 'fetched_at'],
  'vehicle_facts holds a registration hash and vehicle facts only (no garage, customer or plate)');
select col_is_pk('public', 'vehicle_facts', 'reg_hash', 'vehicle_facts is keyed by the registration hash');
select is(
  (select count(*)::integer from pg_class
   where relnamespace = 'public'::regnamespace
     and relname = any(array['reminder_rules', 'reminder_sends', 'messages', 'calls', 'garage_phone_numbers', 'jobs', 'vehicle_facts'])
     and relrowsecurity),
  7, 'RLS is enabled on every new table'
);

select col_type_is('public', 'reminder_rules', 'offset_days', 'integer[]', 'reminder_rules.offset_days is integer[]');
select col_type_is('public', 'reminder_sends', 'due_date', 'date', 'reminder_sends.due_date is a date');
select col_type_is('public', 'reminder_sends', 'send_at', 'timestamp with time zone', 'reminder_sends.send_at is timestamptz');
select col_type_is('public', 'jobs', 'run_at', 'timestamp with time zone', 'jobs.run_at is timestamptz');
select col_type_is('public', 'jobs', 'payload', 'jsonb', 'jobs.payload is jsonb');
select col_default_is('public', 'jobs', 'max_attempts', '5', 'jobs retry up to 5 attempts by default');

select is(
  (select array_agg(pg_get_constraintdef(oid) order by pg_get_constraintdef(oid)) from pg_constraint
   where contype = 'u' and conrelid = any(array['public.reminder_rules', 'public.reminder_sends']::regclass[])
     and pg_get_constraintdef(oid) <> 'UNIQUE (garage_id, id)'),
  array['UNIQUE (garage_id, kind)', 'UNIQUE (garage_id, vehicle_id, kind, due_date, offset_days)'],
  'one rule per kind per garage; one send per vehicle, kind, due date and offset (scheduling is idempotent)'
);
select matches(
  (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.bookings'::regclass and conname = 'bookings_reminder_send_id_fkey'),
  '^FOREIGN KEY \(garage_id, reminder_send_id\) REFERENCES (public\.)?reminder_sends\(garage_id, id\) ON DELETE SET NULL \(reminder_send_id\)$',
  'bookings.reminder_send_id references the garage''s own reminder_sends (P3.6)'
);
select is(
  (select count(*)::integer from pg_constraint
   where contype = 'f' and conrelid = 'public.reminder_sends'::regclass and cardinality(conkey) = 2
     and confrelid = any(array['public.reminder_rules', 'public.vehicles', 'public.customers', 'public.bookings']::regclass[])),
  4, 'reminder_sends reaches its rule, vehicle, customer and booking through (garage_id, id)'
);
select is(
  (select count(*)::integer from pg_constraint
   where contype = 'f' and conrelid = 'public.messages'::regclass and cardinality(conkey) = 2
     and confrelid = any(array['public.customers', 'public.reminder_sends', 'public.bookings', 'public.calls']::regclass[])),
  4, 'messages reach their customer, reminder, booking and call through (garage_id, id)'
);
select is(
  (select count(*)::integer from pg_constraint
   where contype = 'f' and conrelid = 'public.calls'::regclass and cardinality(conkey) = 2 and confrelid = 'public.messages'::regclass),
  1, 'a call''s text-back message is one of the garage''s messages'
);
select matches(
  (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'jobs_dedupe_key_key'),
  'CREATE UNIQUE INDEX jobs_dedupe_key_key ON public.jobs USING btree \(dedupe_key\) WHERE \(dedupe_key IS NOT NULL\)',
  'jobs.dedupe_key is unique when set'
);
select matches(
  (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'jobs_claim_idx'),
  'USING btree \(status, kind, run_at\)$', 'jobs are claimed through an index on (status, kind, run_at)'
);
select matches(
  (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'messages_provider_msg_id_key'),
  'CREATE UNIQUE INDEX .* \(provider_msg_id\) WHERE \(provider_msg_id IS NOT NULL\)',
  'messages.provider_msg_id is unique when set'
);
select is(
  (select count(*)::integer from pg_constraint
   where contype = 'u'
     and pg_get_constraintdef(oid) in ('UNIQUE (provider_call_sid)', 'UNIQUE (number)')
     and conrelid = any(array['public.calls', 'public.garage_phone_numbers']::regclass[])),
  2, 'a Twilio call and a phone number each belong to one garage'
);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer
   from unnest(array['reminder_rules', 'reminder_sends', 'messages', 'calls', 'garage_phone_numbers', 'jobs', 'vehicle_facts']) new_table(name)
   where has_any_column_privilege('anon', 'public.' || name, 'select')
      or has_any_column_privilege('anon', 'public.' || name, 'insert')
      or has_any_column_privilege('anon', 'public.' || name, 'update')
      or has_table_privilege('anon', 'public.' || name, 'delete')),
  0, 'anon has no privilege on any new table'
);
select is(
  (select count(*)::integer
   from unnest(array['jobs', 'vehicle_facts']) platform_table(name)
   where has_any_column_privilege('authenticated', 'public.' || name, 'select')
      or has_any_column_privilege('authenticated', 'public.' || name, 'insert')
      or has_any_column_privilege('authenticated', 'public.' || name, 'update')
      or has_table_privilege('authenticated', 'public.' || name, 'delete')),
  0, 'signed-in staff hold no privilege on jobs or vehicle_facts (service role only)'
);
select ok(
  (select bool_and(has_table_privilege('service_role', 'public.' || name, privilege))
   from unnest(array['jobs', 'vehicle_facts', 'reminder_sends', 'messages', 'calls']) platform_table(name)
   cross join unnest(array['select', 'insert', 'update', 'delete']) privilege),
  'the service role reads and writes the queue, the facts cache, sends, messages and calls'
);
select ok(
  has_table_privilege('authenticated', 'public.reminder_rules', 'select')
  and has_table_privilege('authenticated', 'public.reminder_rules', 'delete')
  and has_column_privilege('authenticated', 'public.reminder_rules', 'template', 'insert')
  and has_column_privilege('authenticated', 'public.reminder_rules', 'enabled', 'update')
  and has_column_privilege('authenticated', 'public.reminder_rules', 'offset_days', 'update')
  and not has_column_privilege('authenticated', 'public.reminder_rules', 'kind', 'update')
  and not has_column_privilege('authenticated', 'public.reminder_rules', 'garage_id', 'update'),
  'staff hold rule privileges (RLS narrows writes to owners and managers); a rule''s kind and garage are fixed'
);
select ok(
  (select bool_and(has_table_privilege('authenticated', 'public.' || name, 'select')
                   and not has_any_column_privilege('authenticated', 'public.' || name, 'insert')
                   and not has_table_privilege('authenticated', 'public.' || name, 'delete'))
   from unnest(array['reminder_sends', 'messages', 'calls']) read_table(name))
  and not has_any_column_privilege('authenticated', 'public.reminder_sends', 'update')
  and not has_any_column_privilege('authenticated', 'public.messages', 'update'),
  'staff read reminder sends, messages and calls; jobs and webhooks write them'
);
select ok(
  has_column_privilege('authenticated', 'public.calls', 'handled_at', 'update')
  and has_column_privilege('authenticated', 'public.calls', 'handled_by', 'update')
  and not has_column_privilege('authenticated', 'public.calls', 'missed', 'update')
  and not has_column_privilege('authenticated', 'public.calls', 'garage_id', 'update'),
  'staff may only mark a call handled'
);
select ok(
  has_column_privilege('authenticated', 'public.garage_phone_numbers', 'number', 'insert')
  and has_column_privilege('authenticated', 'public.garage_phone_numbers', 'purpose', 'update')
  and not has_column_privilege('authenticated', 'public.garage_phone_numbers', 'provider_sid', 'insert')
  and not has_column_privilege('authenticated', 'public.garage_phone_numbers', 'provider_sid', 'update')
  and not has_column_privilege('authenticated', 'public.garage_phone_numbers', 'number', 'update'),
  'staff never set provider_sid: only the platform provisions a routable number'
);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(has_function_privilege('service_role', signature, 'execute')
                   and not has_function_privilege('authenticated', signature, 'execute')
                   and not has_function_privilege('anon', signature, 'execute'))
   from unnest(array[
     'public.enqueue_job(text,jsonb,timestamptz,text,uuid)',
     'public.claim_jobs(text,integer)',
     'public.finish_job(uuid)',
     'public.fail_job(uuid,text,boolean)',
     'public.schedule_reminders(uuid,date)',
     'public.claim_reminder_sends(uuid,timestamptz,integer)',
     'public.reminder_won_back(uuid,date,date)',
     'public.apply_message_retention(uuid)'
   ]) contract_function(signature)),
  'the queue and reminder functions are service-role only'
);
select is(
  (select count(*)::integer from pg_proc
   where oid = any(array[
     'public.enqueue_job(text,jsonb,timestamptz,text,uuid)'::regprocedure,
     'public.claim_jobs(text,integer)'::regprocedure,
     'public.finish_job(uuid)'::regprocedure,
     'public.fail_job(uuid,text,boolean)'::regprocedure,
     'public.schedule_reminders(uuid,date)'::regprocedure,
     'public.claim_reminder_sends(uuid,timestamptz,integer)'::regprocedure,
     'public.reminder_won_back(uuid,date,date)'::regprocedure,
     'public.apply_message_retention(uuid)'::regprocedure
   ])
     and prosecdef and proconfig = array['search_path=""']),
  8, 'every queue and reminder function is security definer with an empty search_path'
);
select ok(
  (select bool_and(not has_function_privilege('service_role', signature, 'execute')
                   and not has_function_privilege('authenticated', signature, 'execute')
                   and not has_function_privilege('anon', signature, 'execute'))
   from unnest(array[
     'public.reminder_service_anchor(uuid,uuid)',
     'public.seed_default_reminder_rules(uuid)'
   ]) internal_function(signature)),
  'the reminder internals are not executable by any API role'
);
select is(
  array[
    pg_get_function_result('public.claim_jobs(text,integer)'::regprocedure),
    pg_get_function_result('public.enqueue_job(text,jsonb,timestamptz,text,uuid)'::regprocedure),
    pg_get_function_result('public.finish_job(uuid)'::regprocedure),
    pg_get_function_result('public.fail_job(uuid,text,boolean)'::regprocedure),
    pg_get_function_result('public.schedule_reminders(uuid,date)'::regprocedure),
    pg_get_function_result('public.reminder_won_back(uuid,date,date)'::regprocedure)
  ],
  array['SETOF jobs', 'jobs', 'boolean', 'text', 'jsonb', 'TABLE(sent integer, bookings integer, pence bigint)'],
  'the queue and reminder functions return the contract shapes'
);
select is(
  pg_get_function_arguments('public.enqueue_job(text,jsonb,timestamptz,text,uuid)'::regprocedure),
  'p_kind text, p_payload jsonb DEFAULT ''{}''::jsonb, p_run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_dedupe_key text DEFAULT NULL::text, p_garage_id uuid DEFAULT NULL::uuid',
  'enqueue_job(p_kind, p_payload, p_run_at, p_dedupe_key, p_garage_id): everything but the kind is optional'
);
select is(
  pg_get_function_result('public.claim_reminder_sends(uuid,timestamptz,integer)'::regprocedure),
  'TABLE(id uuid, rule_id uuid, kind text, due_date date, offset_days integer, send_at timestamp with time zone, channel text, template text, customer_id uuid, customer_name text, phone text, email text, vehicle_id uuid, registration text, make text, model text)',
  'claim_reminder_sends returns what the sender needs to render'
);

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer from pg_policies
   where schemaname = 'public'
     and tablename = any(array['reminder_rules', 'reminder_sends', 'messages', 'calls', 'garage_phone_numbers'])
     and (roles <> array['authenticated']::name[]
          or coalesce(qual, '') || coalesce(with_check, '') !~ 'current_garage_id\(\)')),
  0, 'every reminders policy is for authenticated and scoped to the selected garage'
);
select policies_are('public', 'reminder_rules', array[
  'garage members read reminder rules', 'owners and managers add reminder rules',
  'owners and managers change reminder rules', 'owners and managers remove reminder rules'
], 'reminder_rules: staff read, owners and managers manage');
select policies_are('public', 'reminder_sends', array['garage members read reminder sends'],
  'reminder_sends: staff read; service-role jobs write');
select policies_are('public', 'messages', array['garage members read messages'],
  'messages: staff read; webhooks and jobs write');
select policies_are('public', 'calls', array['garage members read calls', 'garage members mark calls handled'],
  'calls: staff read and mark them handled');
select policies_are('public', 'garage_phone_numbers', array[
  'garage members read phone numbers', 'owners add phone numbers', 'owners change phone numbers', 'owners remove phone numbers'
], 'garage_phone_numbers: staff read, owners manage');
select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename in ('jobs', 'vehicle_facts')),
  0, 'jobs and vehicle_facts have no policies (service role only)'
);

-- ---------------------------------------------------------------------------
-- Fixtures: garage A (owner, manager, technician) and garage B (owner)
-- ---------------------------------------------------------------------------

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('13000000-0000-4000-8000-0000000000a1', 'rem-owner-a@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000a2', 'rem-manager-a@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000a3', 'rem-tech-a@pgtap.test', '{}'::jsonb),
  ('13000000-0000-4000-8000-0000000000b1', 'rem-owner-b@pgtap.test', '{}'::jsonb);

insert into public.garages (id, slug, name, booking_prefix, mot_enabled) values
  ('a1300000-0000-4000-8000-000000000001', 'pgtap-rem-a', 'Reminder Garage A', 'RMA', true),
  ('b1300000-0000-4000-8000-000000000001', 'pgtap-rem-b', 'Reminder Garage B', 'RMB', false);

insert into public.garage_members (garage_id, user_id, role) values
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a2', 'manager'),
  ('a1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a3', 'technician'),
  ('b1300000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000b1', 'owner');

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
-- Default reminder rules (seed_garage_defaults)
-- ---------------------------------------------------------------------------

set local role service_role;
select is(
  public.seed_garage_defaults('a1300000-0000-4000-8000-000000000001'),
  '{"services": 6, "resources": 4, "opening_hours": 6, "reminder_rules": 4}'::jsonb,
  'seed_garage_defaults adds the four default reminder rules with the hours, resources and services'
);
select is(
  public.seed_garage_defaults('a1300000-0000-4000-8000-000000000001'),
  '{"services": 0, "resources": 0, "opening_hours": 0, "reminder_rules": 0}'::jsonb,
  'running it again adds no rule'
);
select is(
  (public.seed_garage_defaults('b1300000-0000-4000-8000-000000000001'))->>'reminder_rules',
  '4', 'every garage gets its own rules'
);
reset role;

select is(
  (select string_agg(kind || ':' || enabled || ':' || offset_days::text || ':' || channel, ' ' order by kind)
   from public.reminder_rules where garage_id = 'a1300000-0000-4000-8000-000000000001'),
  'missed_call:true:{0}:customer mot:true:{28,7}:customer review:false:{1}:customer service:true:{335}:customer',
  'defaults: MOT 28 and 7 days before expiry, service 335 days after, review 1 day after collection (off), missed call at once; on the customer''s channel'
);
select is(
  (select template from public.reminder_rules where garage_id = 'a1300000-0000-4000-8000-000000000001' and kind = 'mot'),
  '{garage}: Hi {first_name}, MOT due {due_date}. Book: {link}',
  'the MOT template is the DEFAULT_TEMPLATES wording (one text since 20261028002300)'
);
select is(
  (select template from public.reminder_rules where garage_id = 'a1300000-0000-4000-8000-000000000001' and kind = 'missed_call'),
  '{garage}: sorry we missed your call. Book at {link} or we''ll call you back.',
  'the missed-call template is the DEFAULT_TEMPLATES wording'
);

-- Rows in both garages for the constraint and RLS checks.
insert into public.customers (id, garage_id, name, phone, email, preferred_contact) values
  ('a1300000-0000-4000-8000-000000000301', 'a1300000-0000-4000-8000-000000000001', 'Rem Customer A', '+447700913001', 'rem-a@example.test', 'phone'),
  ('b1300000-0000-4000-8000-000000000301', 'b1300000-0000-4000-8000-000000000001', 'Rem Customer B', '+447700913002', 'rem-b@example.test', 'phone');
insert into public.vehicles (id, garage_id, customer_id, registration, mot_expiry) values
  ('a1300000-0000-4000-8000-000000000401', 'a1300000-0000-4000-8000-000000000001', 'a1300000-0000-4000-8000-000000000301', 'RM13AAA', '2026-12-01'),
  ('b1300000-0000-4000-8000-000000000401', 'b1300000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-000000000301', 'RM13BBB', '2026-12-01');
insert into public.reminder_sends (id, garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel)
select 'a1300000-0000-4000-8000-000000000501'::uuid, rule.garage_id, rule.id,
       'a1300000-0000-4000-8000-000000000401'::uuid, 'a1300000-0000-4000-8000-000000000301'::uuid, 'mot', date '2026-12-01', 28, timestamptz '2026-11-03 10:00+00', 'sms'
from public.reminder_rules rule where rule.garage_id = 'a1300000-0000-4000-8000-000000000001' and rule.kind = 'mot'
union all
select 'b1300000-0000-4000-8000-000000000501'::uuid, rule.garage_id, rule.id,
       'b1300000-0000-4000-8000-000000000401'::uuid, 'b1300000-0000-4000-8000-000000000301'::uuid, 'mot', date '2026-12-01', 28, timestamptz '2026-11-03 10:00+00', 'sms'
from public.reminder_rules rule where rule.garage_id = 'b1300000-0000-4000-8000-000000000001' and rule.kind = 'mot';
insert into public.calls (id, garage_id, provider_call_sid, from_number, to_number, status, missed) values
  ('a1300000-0000-4000-8000-000000000701', 'a1300000-0000-4000-8000-000000000001', 'CApgtap13a', '+447700913001', '+447700913901', 'no-answer', true),
  ('b1300000-0000-4000-8000-000000000701', 'b1300000-0000-4000-8000-000000000001', 'CApgtap13b', '+447700913002', '+447700913902', 'no-answer', true);
insert into public.messages (id, garage_id, customer_id, channel, direction, to_address, from_address, body, provider, provider_msg_id, status, call_id) values
  ('a1300000-0000-4000-8000-000000000601', 'a1300000-0000-4000-8000-000000000001', 'a1300000-0000-4000-8000-000000000301', 'sms', 'outbound',
   '+447700913001', '+447700913901', 'Sorry we missed your call.', 'mock', 'SMpgtap13a', 'sent', 'a1300000-0000-4000-8000-000000000701'),
  ('b1300000-0000-4000-8000-000000000601', 'b1300000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-000000000301', 'sms', 'inbound',
   '+447700913902', '+447700913002', 'STOP', 'twilio', 'SMpgtap13b', 'received', null);
update public.calls set text_back_message_id = 'a1300000-0000-4000-8000-000000000601' where id = 'a1300000-0000-4000-8000-000000000701';
insert into public.garage_phone_numbers (id, garage_id, number, purpose, provider_sid) values
  ('a1300000-0000-4000-8000-000000000801', 'a1300000-0000-4000-8000-000000000001', '+447700913901', 'forwarding', 'PNpgtap13a'),
  ('b1300000-0000-4000-8000-000000000801', 'b1300000-0000-4000-8000-000000000001', '+447700913902', 'forwarding', 'PNpgtap13b');
insert into public.jobs (id, kind, garage_id, payload, dedupe_key) values
  ('a1300000-0000-4000-8000-000000000901', 'pgtap.schema', 'a1300000-0000-4000-8000-000000000001', '{"garage": "A"}', 'pgtap-013:a'),
  ('c1300000-0000-4000-8000-000000000901', 'pgtap.schema', null, '{}', 'pgtap-013:platform');
insert into public.vehicle_facts (reg_hash, facts) values (repeat('ab', 32), '{"version": 1, "vehicle": {"make": "Ford"}, "sources": ["dvla"]}');

select is(
  (select string_agg(send.status || ':' || rule.kind, ',' order by send.garage_id)
   from public.reminder_sends send
   join public.reminder_rules rule on rule.garage_id = send.garage_id and rule.id = send.rule_id
   where send.garage_id in ('a1300000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-000000000001')),
  'scheduled:mot,scheduled:mot', 'a new send is scheduled and points at its garage''s own rule'
);

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.reminder_rules (garage_id, kind, offset_days, template) values ('a1300000-0000-4000-8000-000000000001', 'birthday', '{1}', 'Happy birthday')$$,
  '23514', null, 'reminder kinds are mot, service, review and missed_call'
);
select throws_ok(
  $$update public.reminder_rules set channel = 'pigeon' where garage_id = 'a1300000-0000-4000-8000-000000000001' and kind = 'mot'$$,
  '23514', null, 'rule channels are sms, whatsapp, email or customer'
);
select throws_ok(
  $$update public.reminder_rules set offset_days = '{}' where garage_id = 'a1300000-0000-4000-8000-000000000001' and kind = 'mot'$$,
  '23514', null, 'a rule needs at least one offset'
);
select throws_ok(
  $$update public.reminder_rules set offset_days = '{28,-1}' where garage_id = 'a1300000-0000-4000-8000-000000000001' and kind = 'mot'$$,
  '23514', null, 'offsets are whole days from 0'
);
select throws_ok(
  $$update public.reminder_rules set offset_days = '{28,null}' where garage_id = 'a1300000-0000-4000-8000-000000000001' and kind = 'mot'$$,
  '23514', null, 'offsets cannot be null'
);
select throws_ok(
  $$insert into public.reminder_rules (garage_id, kind, offset_days, template) values ('a1300000-0000-4000-8000-000000000001', 'mot', '{14}', 'Second MOT rule')$$,
  '23505', null, 'a garage has one rule per kind'
);
select throws_ok(
  $$update public.reminder_sends set status = 'skipped' where garage_id = 'a1300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a skipped send says why'
);
select throws_ok(
  $$update public.reminder_sends set link_token_hash = 'not-a-hash', link_expires_at = now() where garage_id = 'a1300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'link tokens are stored as SHA-256 hex only'
);
select throws_ok(
  $$update public.reminder_sends set status = 'sent' where garage_id = 'a1300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a sent reminder records when it was claimed and sent'
);
select throws_ok(
  $$insert into public.reminder_sends (garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel)
    select garage_id, rule_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel
    from public.reminder_sends where garage_id = 'a1300000-0000-4000-8000-000000000001'$$,
  '23505', null, 'the same vehicle, kind, due date and offset cannot be scheduled twice'
);
select throws_ok(
  $$insert into public.reminder_sends (garage_id, vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel)
    values ('a1300000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-000000000401', 'a1300000-0000-4000-8000-000000000301', 'mot', '2026-12-01', 7, now(), 'sms')$$,
  '23503', null, 'a send cannot point at another garage''s vehicle'
);
select throws_ok(
  $$insert into public.messages (garage_id, channel, direction, to_address, body, provider, status) values
    ('a1300000-0000-4000-8000-000000000001', 'sms', 'outbound', '07700 913001', 'Hi', 'mock', 'queued')$$,
  '23514', null, 'outbound texts go to an E.164 number'
);
select throws_ok(
  $$insert into public.messages (garage_id, channel, direction, from_address, body, provider, status) values
    ('a1300000-0000-4000-8000-000000000001', 'sms', 'inbound', '+447700913001', 'Hi', 'twilio', 'sent')$$,
  '23514', null, 'inbound messages are received, outbound ones are not'
);
select throws_ok(
  $$insert into public.messages (garage_id, channel, direction, to_address, body, provider, provider_msg_id, status) values
    ('b1300000-0000-4000-8000-000000000001', 'sms', 'outbound', '+447700913002', 'Hi', 'mock', 'SMpgtap13a', 'sent')$$,
  '23505', null, 'a provider message id is recorded once'
);
select throws_ok(
  $$insert into public.messages (garage_id, channel, direction, to_address, body, provider, status) values
    ('a1300000-0000-4000-8000-000000000001', 'sms', 'outbound', '+447700913001', null, 'mock', 'queued')$$,
  '23514', null, 'only retention clears a message body'
);
select throws_ok(
  $$insert into public.calls (garage_id, provider_call_sid, to_number) values ('b1300000-0000-4000-8000-000000000001', 'CApgtap13a', '+447700913902')$$,
  '23505', null, 'a Twilio call is logged once'
);
select throws_ok(
  $$insert into public.calls (garage_id, provider_call_sid, to_number, voicemail_url) values ('a1300000-0000-4000-8000-000000000001', 'CApgtap13c', '+447700913901', 'http://example.test/vm')$$,
  '23514', null, 'voicemail links are https'
);
select throws_ok(
  $$insert into public.garage_phone_numbers (garage_id, number) values ('a1300000-0000-4000-8000-000000000001', '01302 000000')$$,
  '23514', null, 'garage numbers are E.164'
);
select throws_ok(
  $$insert into public.garage_phone_numbers (garage_id, number) values ('a1300000-0000-4000-8000-000000000001', '+447700913902')$$,
  '23505', null, 'a number maps to one garage'
);
select throws_ok(
  $$insert into public.jobs (kind) values ('Reminders Send')$$,
  '23514', null, 'job kinds are dotted lower-case names'
);
select throws_ok(
  $$insert into public.jobs (kind, payload) values ('pgtap.schema', '[1, 2]')$$,
  '23514', null, 'a job payload is a JSON object'
);
select throws_ok(
  $$insert into public.jobs (kind, dedupe_key) values ('pgtap.schema', 'pgtap-013:a')$$,
  '23505', null, 'a dedupe key is used once'
);
select lives_ok(
  $$insert into public.jobs (kind) values ('pgtap.schema'), ('pgtap.schema')$$,
  'jobs without a dedupe key can repeat'
);
select throws_ok(
  $$insert into public.vehicle_facts (reg_hash, facts) values ('AB12CDE', '{}')$$,
  '23514', null, 'vehicle_facts never holds a plate, only its 64-hex HMAC'
);
select throws_ok(
  $$insert into public.vehicle_facts (reg_hash, facts) values (repeat('cd', 32), '[]')$$,
  '23514', null, 'vehicle facts are a JSON object'
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

select pg_temp.act_as('13000000-0000-4000-8000-0000000000a3', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select count(*)::integer from public.reminder_rules)
  || '/' || (select count(*)::integer from public.reminder_sends)
  || '/' || (select count(*)::integer from public.messages)
  || '/' || (select count(*)::integer from public.calls)
  || '/' || (select count(*)::integer from public.garage_phone_numbers),
  '4/1/1/1/1', 'a technician reads the selected garage''s rules, sends, messages, calls and numbers'
);
select is(
  (select count(*)::integer from (select 1 from public.reminder_rules where garage_id = 'b1300000-0000-4000-8000-000000000001') other_rows),
  0, 'and nothing of garage B'
);
select results_eq(
  $$with changed as (update public.reminder_rules set enabled = false where kind = 'mot' returning 1) select count(*) from changed$$,
  array[0::bigint], 'technicians cannot switch rules off'
);
select throws_ok(
  $$insert into public.reminder_rules (kind, offset_days, template) values ('review', '{2}', 'Tech rule')$$,
  '42501', null, 'technicians cannot add rules'
);
select throws_ok(
  $$insert into public.reminder_sends (vehicle_id, customer_id, kind, due_date, offset_days, send_at, channel)
    values ('a1300000-0000-4000-8000-000000000401', 'a1300000-0000-4000-8000-000000000301', 'mot', '2026-12-01', 7, now(), 'sms')$$,
  '42501', null, 'staff cannot schedule reminders directly'
);
select throws_ok(
  $$insert into public.messages (channel, direction, to_address, body, provider, status) values ('sms', 'outbound', '+447700913001', 'Hi', 'mock', 'queued')$$,
  '42501', null, 'staff cannot write messages directly'
);
select throws_ok(
  $$update public.reminder_sends set status = 'cancelled', skip_reason = 'staff'$$,
  '42501', null, 'staff cannot change reminder sends'
);
select results_eq(
  $$with changed as (update public.calls set handled_at = now(), handled_by = auth.uid() returning 1) select count(*) from changed$$,
  array[1::bigint], 'staff mark a missed call handled as themselves'
);
select throws_ok(
  $$update public.calls set handled_by = '13000000-0000-4000-8000-0000000000a1'$$,
  '42501', null, 'but not as someone else'
);
select throws_ok(
  $$insert into public.garage_phone_numbers (number) values ('+447700913903')$$,
  '42501', null, 'technicians cannot add phone numbers'
);
select throws_ok($$select count(*) from public.jobs$$, '42501', null, 'staff cannot read the job queue');
select throws_ok($$select count(*) from public.vehicle_facts$$, '42501', null, 'staff cannot read the vehicle facts cache');
reset role;

select pg_temp.act_as('13000000-0000-4000-8000-0000000000a2', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq(
  $$with changed as (update public.reminder_rules set template = 'Hi {first_name}, MOT due {due_date}: {link}', offset_days = '{21,7}' where kind = 'mot' returning 1) select count(*) from changed$$,
  array[1::bigint], 'managers edit a rule''s template and offsets'
);
select throws_ok(
  $$update public.reminder_rules set kind = 'review' where kind = 'mot'$$,
  '42501', null, 'a rule''s kind is fixed'
);
select throws_ok(
  $$insert into public.garage_phone_numbers (number) values ('+447700913903')$$,
  '42501', null, 'managers cannot add phone numbers'
);
reset role;

select pg_temp.act_as('13000000-0000-4000-8000-0000000000a1', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok(
  $$insert into public.garage_phone_numbers (number, purpose) values ('+447700913903', 'messaging')$$,
  'owners add a phone number to the selected garage'
);
select throws_ok(
  $$insert into public.garage_phone_numbers (number, provider_sid) values ('+447700913904', 'PNforged')$$,
  '42501', null, 'owners cannot set provider_sid (the number is not routable until the platform provisions it)'
);
select throws_ok(
  $$insert into public.garage_phone_numbers (garage_id, number) values ('b1300000-0000-4000-8000-000000000001', '+447700913905')$$,
  '42501', null, 'owners cannot add numbers to another garage'
);
select results_eq(
  $$with removed as (delete from public.garage_phone_numbers where number = '+447700913903' returning 1) select count(*) from removed$$,
  array[1::bigint], 'owners remove a phone number'
);
reset role;

select is(
  (select garage_id::text || '/' || coalesce(provider_sid, 'unprovisioned') from public.garage_phone_numbers where number = '+447700913901'),
  'a1300000-0000-4000-8000-000000000001/PNpgtap13a', 'the provisioned number is untouched'
);
select is(
  (select template || '|' || offset_days::text from public.reminder_rules where garage_id = 'a1300000-0000-4000-8000-000000000001' and kind = 'mot'),
  'Hi {first_name}, MOT due {due_date}: {link}|{21,7}', 'the manager''s rule edit is stored'
);
select is(
  (select handled_by from public.calls where id = 'a1300000-0000-4000-8000-000000000701'),
  '13000000-0000-4000-8000-0000000000a3'::uuid, 'the call is marked handled by the technician'
);

select pg_temp.act_as('13000000-0000-4000-8000-0000000000b1', 'b1300000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select count(*)::integer from public.reminder_rules where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.reminder_sends where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.messages where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.calls where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.garage_phone_numbers where garage_id = 'a1300000-0000-4000-8000-000000000001'),
  0, 'garage B''s owner sees none of garage A''s reminder rows'
);
select results_eq(
  $$with changed as (update public.reminder_rules set enabled = false where garage_id = 'a1300000-0000-4000-8000-000000000001' returning 1) select count(*) from changed$$,
  array[0::bigint], 'garage B''s owner cannot switch off garage A''s rules'
);
select results_eq(
  $$with removed as (delete from public.garage_phone_numbers where garage_id = 'a1300000-0000-4000-8000-000000000001' returning 1) select count(*) from removed$$,
  array[0::bigint], 'garage B''s owner cannot remove garage A''s numbers'
);
select results_eq(
  $$with changed as (update public.calls set handled_at = now(), handled_by = auth.uid() where garage_id = 'a1300000-0000-4000-8000-000000000001' returning 1) select count(*) from changed$$,
  array[0::bigint], 'garage B''s owner cannot mark garage A''s calls handled'
);
reset role;

select pg_temp.act_as('13000000-0000-4000-8000-0000000000b1', 'a1300000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select count(*)::integer from public.reminder_rules) + (select count(*)::integer from public.messages),
  0, 'forging x-garage-id for garage A shows no rules or messages'
);
reset role;

select pg_temp.act_as(null, 'a1300000-0000-4000-8000-000000000001');
set local role anon;
select throws_ok($$select count(*) from public.reminder_rules$$, '42501', null, 'anon cannot read reminder rules');
select throws_ok($$select count(*) from public.messages$$, '42501', null, 'anon cannot read messages');
reset role;

-- ---------------------------------------------------------------------------
-- Message retention: bodies cleared after 12 months
-- ---------------------------------------------------------------------------

insert into public.messages (id, garage_id, customer_id, channel, direction, to_address, body, provider, status, created_at) values
  ('a1300000-0000-4000-8000-000000000611', 'a1300000-0000-4000-8000-000000000001', 'a1300000-0000-4000-8000-000000000301', 'sms', 'outbound',
   '+447700913001', 'Old reminder text', 'mock', 'delivered', now() - interval '13 months'),
  ('b1300000-0000-4000-8000-000000000611', 'b1300000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-000000000301', 'sms', 'outbound',
   '+447700913002', 'Old garage B text', 'mock', 'delivered', now() - interval '13 months');
update public.reminder_sends
set status = 'sent', claimed_at = now() - interval '13 months', sent_at = now() - interval '13 months', body = 'Old rendered reminder'
where garage_id = 'a1300000-0000-4000-8000-000000000001';
insert into public.calls (id, garage_id, provider_call_sid, from_number, to_number, status, missed, voicemail_url, created_at) values
  ('a1300000-0000-4000-8000-000000000711', 'a1300000-0000-4000-8000-000000000001', 'CApgtap13old', '+447700913001', '+447700913901',
   'no-answer', true, 'https://api.twilio.example/recordings/RE1', now() - interval '13 months');

set local role service_role;
select is(public.apply_message_retention('a1300000-0000-4000-8000-000000000001'), 3,
  'retention clears one old message body, one old rendered reminder and one old voicemail link in garage A');
select is(public.apply_message_retention('a1300000-0000-4000-8000-000000000001'), 0, 'running it again changes nothing');
reset role;
select is(
  (select coalesce(body, 'cleared') || '/' || (redacted_at is not null) from public.messages where id = 'a1300000-0000-4000-8000-000000000611'),
  'cleared/true', 'the old message keeps its row, without its body'
);
select is(
  (select body from public.messages where id = 'a1300000-0000-4000-8000-000000000601'),
  'Sorry we missed your call.', 'recent messages keep their body'
);
select is(
  (select coalesce(body, 'cleared') from public.reminder_sends where garage_id = 'a1300000-0000-4000-8000-000000000001'),
  'cleared', 'the old rendered reminder body is cleared'
);
select is(
  (select body from public.messages where id = 'b1300000-0000-4000-8000-000000000611'),
  'Old garage B text', 'garage B''s messages are untouched'
);
select throws_ok(
  $$select public.apply_message_retention(null)$$,
  '22004', 'GARAGE_REQUIRED', 'retention runs for one garage at a time'
);

-- ---------------------------------------------------------------------------
-- Deleting a garage removes its reminder rows and jobs
-- ---------------------------------------------------------------------------

delete from public.garages where id = 'a1300000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from public.reminder_rules where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.reminder_sends where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.messages where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.calls where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.garage_phone_numbers where garage_id = 'a1300000-0000-4000-8000-000000000001')
  + (select count(*)::integer from public.jobs where garage_id = 'a1300000-0000-4000-8000-000000000001'),
  0, 'garage deletion cascades to rules, sends, messages, calls, numbers and its jobs'
);
select is(
  (select count(*)::integer from public.jobs where id = 'c1300000-0000-4000-8000-000000000901')
  + (select count(*)::integer from public.reminder_rules where garage_id = 'b1300000-0000-4000-8000-000000000001'),
  5, 'platform jobs and garage B''s rules stay'
);

select * from finish();
rollback;
