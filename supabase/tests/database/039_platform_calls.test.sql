begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(12);

-- Autofix's own line (20261029001300_platform_calls.sql, A420): a platform
-- table no garage can read, written by the service role only, with the same
-- 12-month voicemail retention as garage calls.

select has_table('public', 'platform_calls', 'platform_calls exists');
select hasnt_column('public', 'platform_calls', 'garage_id', 'it belongs to no garage');
select ok((select relrowsecurity from pg_class where oid = 'public.platform_calls'::regclass), 'RLS is on');
select is((select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'platform_calls'), 0, 'no policies: nobody but the service role');
select ok(not has_table_privilege('authenticated', 'public.platform_calls', 'select,insert,update,delete'), 'garage staff get nothing');
select ok(not has_table_privilege('anon', 'public.platform_calls', 'select,insert,update,delete'), 'anon gets nothing');
select ok(has_table_privilege('service_role', 'public.platform_calls', 'select,insert,update'), 'the voice webhook (service role) writes it');
select ok(not has_function_privilege('authenticated', 'public.apply_platform_call_retention()', 'execute'), 'staff cannot run the retention');

select throws_ok(
  $$insert into public.platform_calls (provider_call_sid, to_number, voicemail_url) values ('CA-pgtap-pl-bad', '+441146974393', 'http://example.test/x')$$,
  '23514', null, 'voicemail links must be https'
);

insert into public.platform_calls (id, provider_call_sid, from_number, to_number, status, voicemail_url, voicemail_duration_s, created_at) values
  ('2e000000-0000-4000-8000-000000000101', 'CA-pgtap-pl-old', '+447700900123', '+441146974393', 'completed',
   'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE00000000000000000000000000000001', 30,
   now() - interval '13 months'),
  ('2e000000-0000-4000-8000-000000000102', 'CA-pgtap-pl-new', '+447700900456', '+441146974393', 'completed',
   'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE00000000000000000000000000000002', 12,
   now() - interval '2 days');

select is(public.apply_platform_call_retention() >= 1, true, 'retention clears old voicemail links');
select is((select voicemail_url from public.platform_calls where id = '2e000000-0000-4000-8000-000000000101'), null, 'the 13-month-old link is gone');
select isnt((select voicemail_url from public.platform_calls where id = '2e000000-0000-4000-8000-000000000102'), null, 'a recent link stays');

select * from finish();
rollback;
