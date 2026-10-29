begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(45);

-- Contact page enquiries (20261029003000_platform_enquiries.sql): a platform
-- table only the service role reads and inserts, a read-only view for the
-- super admin role, and platform_update_enquiry() for status and notes
-- (platform admin at AAL2, audited, callable by autofix_superadmin only).

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'platform_enquiries', 'platform_enquiries exists');
select hasnt_column('public', 'platform_enquiries', 'garage_id', 'platform_enquiries is a platform table (no garage_id, A10)');
select columns_are('public', 'platform_enquiries',
  array['id', 'name', 'email', 'phone', 'garage_name', 'topic', 'message', 'status', 'received_at', 'handled_by', 'notes',
        'ip_hash', 'updated_at'],
  'platform_enquiries holds the form, the handling state and an IP hash');
select is((select relrowsecurity from pg_class where oid = 'public.platform_enquiries'::regclass), true, 'platform_enquiries has RLS on');
select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'platform_enquiries'),
  0, 'platform_enquiries has no policies (service role only)'
);
select is(
  (select count(*)::integer
   from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) privilege(name)
   cross join unnest(array['anon', 'authenticated']) api_role(name)
   where has_table_privilege(api_role.name, 'public.platform_enquiries', privilege.name)),
  0, 'anon and signed-in users hold no privilege on platform_enquiries'
);
select ok(has_table_privilege('service_role', 'public.platform_enquiries', 'select,insert'), 'the service role reads and inserts');
select ok(not has_table_privilege('service_role', 'public.platform_enquiries', 'update')
  and not has_table_privilege('service_role', 'public.platform_enquiries', 'delete'),
  'the service role neither updates nor deletes (status and notes go through the function)');

select has_view('superadmin', 'platform_enquiries', 'superadmin.platform_enquiries exists');
select hasnt_column('superadmin', 'platform_enquiries', 'ip_hash', 'the view leaves the IP hash out');
select ok(has_table_privilege('autofix_superadmin', 'superadmin.platform_enquiries', 'select'), 'the super admin role reads the view');
select ok(not has_table_privilege('autofix_superadmin', 'superadmin.platform_enquiries', 'insert,update,delete'), 'the super admin role cannot write the view');
select ok(not has_table_privilege('autofix_superadmin', 'public.platform_enquiries', 'select,insert,update,delete'), 'the super admin role holds nothing on the table');
select ok(not has_table_privilege('anon', 'superadmin.platform_enquiries', 'select')
  and not has_table_privilege('authenticated', 'superadmin.platform_enquiries', 'select'),
  'anon and signed-in users cannot read the view');

select ok((select prosecdef from pg_proc where oid = 'public.platform_update_enquiry(uuid, text, text)'::regprocedure),
  'platform_update_enquiry is security definer');
select ok(has_function_privilege('autofix_superadmin', 'public.platform_update_enquiry(uuid, text, text)', 'execute'),
  'the super admin role may call platform_update_enquiry');
select ok(not has_function_privilege('anon', 'public.platform_update_enquiry(uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.platform_update_enquiry(uuid, text, text)', 'execute'),
  'anon and signed-in users may not call it (narrow grant)');

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

select lives_ok($$
  insert into public.platform_enquiries (id, name, email, phone, garage_name, topic, message, ip_hash) values
    ('4e000000-0000-4000-8000-000000000001', 'Priya Shah', 'priya@pgtap.test', '07700 900123', 'Shah Motors', 'sales',
     'We would like a demo for our two sites.', repeat('a', 64)),
    ('4e000000-0000-4000-8000-000000000002', 'Tom Reid', 'tom@pgtap.test', null, null, 'general', 'Do you work with MOT centres?', null)
$$, 'a valid enquiry is stored');
select is((select status from public.platform_enquiries where id = '4e000000-0000-4000-8000-000000000001'), 'new', 'a new enquiry starts as new');
select throws_ok($$insert into public.platform_enquiries (name, email, topic, message) values ('Ann Lee', 'ann@pgtap.test', 'billing', 'A question about this.')$$,
  '23514', null, 'topic is general, sales, support or partnership');
select throws_ok($$insert into public.platform_enquiries (name, email, topic, message) values ('Ann Lee', 'not-an-email', 'general', 'A question about this.')$$,
  '23514', null, 'email must look like an address');
select throws_ok($$insert into public.platform_enquiries (name, email, topic, message) values ('Ann Lee', 'ann@pgtap.test', 'general', 'Too short')$$,
  '23514', null, 'message is at least 10 characters');
select throws_ok($$insert into public.platform_enquiries (name, email, topic, message, status) values ('Ann Lee', 'ann@pgtap.test', 'general', 'A question about this.', 'spam')$$,
  '23514', null, 'status is new, in_progress or closed');
select throws_ok($$insert into public.platform_enquiries (name, email, topic, message, ip_hash) values ('Ann Lee', 'ann@pgtap.test', 'general', 'A question about this.', '203.0.113.9')$$,
  '23514', null, 'ip_hash is a SHA-256 hex digest, never an address');

-- ---------------------------------------------------------------------------
-- platform_update_enquiry(): who may call it
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('4e000000-0000-4000-8000-0000000000f1', 'enquiry-admin@pgtap.test', '{}'::jsonb),
  ('4e000000-0000-4000-8000-0000000000a1', 'enquiry-owner@pgtap.test', '{}'::jsonb);
insert into public.platform_admins (user_id) values ('4e000000-0000-4000-8000-0000000000f1');
insert into public.admin_profiles (user_id, display_name) values ('4e000000-0000-4000-8000-0000000000f1', 'Vitalos Admin');

select set_config('request.jwt.claims', '{"sub":"4e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
select throws_ok($$select public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', 'closed', null)$$,
  '42501', 'PLATFORM_ADMIN_REQUIRED', 'someone who is not a platform admin is refused');
select set_config('request.jwt.claims', '{"sub":"4e000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}', true);
select throws_ok($$select public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', 'closed', null)$$,
  '42501', 'PLATFORM_ADMIN_REQUIRED', 'a platform admin without MFA this session is refused');
select set_config('request.jwt.claims', '', true);
select throws_ok($$select public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', 'closed', null)$$,
  '42501', 'PLATFORM_ADMIN_REQUIRED', 'no caller is refused');

-- ---------------------------------------------------------------------------
-- platform_update_enquiry(): validation, changes and the audit log
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"sub":"4e000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', true);
select throws_ok($$select public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', 'spam', null)$$,
  '22023', 'INVALID_STATUS', 'an unknown status is refused');
select throws_ok($$select public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', null, null)$$,
  '22023', 'NOTHING_TO_CHANGE', 'a call that changes nothing is refused');
select throws_ok($$select public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', 'new', null)$$,
  '22023', 'NOTHING_TO_CHANGE', 'the same status is not a change');
select throws_ok($$select public.platform_update_enquiry('4e000000-0000-4000-8000-0000000000ff', 'closed', null)$$,
  'P0002', 'ENQUIRY_NOT_FOUND', 'an unknown enquiry is refused');
select throws_ok(format($$select public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', null, %L)$$, repeat('n', 5001)),
  '22023', 'INVALID_NOTES: at most 5000 characters', 'notes are at most 5000 characters');

select is(
  public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', 'in_progress', null) ->> 'status',
  'in_progress', 'a platform admin at AAL2 moves an enquiry to in progress'
);
select is(
  (select concat_ws('|', status, handled_by, notes is null, updated_at >= received_at) from public.platform_enquiries where id = '4e000000-0000-4000-8000-000000000001'),
  'in_progress|4e000000-0000-4000-8000-0000000000f1|t|t', 'the row records who handled it'
);
select is(
  (select concat_ws('|', actor_id, target_garage_id is null, entity_type, detail ->> 'from', detail ->> 'to')
   from public.platform_audit_log where action = 'platform.enquiry_status_changed' and entity_id = '4e000000-0000-4000-8000-000000000001'),
  '4e000000-0000-4000-8000-0000000000f1|t|platform_enquiry|new|in_progress', 'the status change is in the platform audit log'
);

select is(
  public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', null, E'  Called back.\r\nDemo booked for Monday.\u0007  ') ->> 'notes',
  E'Called back.\nDemo booked for Monday.', 'notes are trimmed, newlines kept and control characters dropped'
);
select is(
  (select detail ->> 'length' from public.platform_audit_log where action = 'platform.enquiry_notes_changed' and entity_id = '4e000000-0000-4000-8000-000000000001'),
  '36', 'the notes change is audited by length only'
);
select ok(
  not exists (select 1 from public.platform_audit_log where entity_id = '4e000000-0000-4000-8000-000000000001' and detail::text like '%Demo booked%'),
  'the audit log never copies the notes'
);
select throws_ok($$select public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', 'in_progress', E'Called back.\nDemo booked for Monday.')$$,
  '22023', 'NOTHING_TO_CHANGE', 'the same status and notes are not a change');

select is(
  public.platform_update_enquiry('4e000000-0000-4000-8000-000000000001', 'closed', '   ') ->> 'status',
  'closed', 'status and notes change together'
);
select is((select notes from public.platform_enquiries where id = '4e000000-0000-4000-8000-000000000001'), null, 'blank notes clear them');
select is(
  (select count(*)::integer from public.platform_audit_log where entity_type = 'platform_enquiry' and entity_id = '4e000000-0000-4000-8000-000000000001'),
  4, 'one audit row per change (two statuses, two notes changes)'
);
select is(
  (select count(*)::integer from public.admin_audit_log where entity_type = 'platform_enquiry'),
  0, 'nothing goes into a garage''s own audit log'
);

-- ---------------------------------------------------------------------------
-- The view
-- ---------------------------------------------------------------------------

select is(
  (select concat_ws('|', name, email, phone, garage_name, topic, status, handled_by_name)
   from superadmin.platform_enquiries where id = '4e000000-0000-4000-8000-000000000001'),
  'Priya Shah|priya@pgtap.test|07700 900123|Shah Motors|sales|closed|Vitalos Admin', 'the view carries the enquiry and who handled it'
);
select is(
  (select handled_by_name is null from superadmin.platform_enquiries where id = '4e000000-0000-4000-8000-000000000002'),
  true, 'an enquiry nobody has handled has no handler name'
);

select * from finish();
rollback;
