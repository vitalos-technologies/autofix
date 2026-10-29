begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

-- Super admin calls (20261029002200_superadmin_calls.sql): the masked caller
-- and voicemail length on superadmin.calls, platform-line calls alongside
-- garage calls, recording links only in superadmin.call_voicemails, and
-- nothing raw anywhere else.

select is(superadmin.mask_caller('+447700900123'), '07••• •••123', 'UK mobiles are masked as the garage app shows them');
select is(superadmin.mask_caller('+12025550123'), '12••• •••123', 'other countries keep two leading and three trailing digits');
select is(superadmin.mask_caller('+4412'), '•••', 'short numbers are fully masked');
select is(superadmin.mask_caller(null), null, 'withheld stays null');

select has_column('superadmin', 'calls', 'caller_masked', 'calls carry the masked caller');
select has_column('superadmin', 'calls', 'has_voicemail', 'calls say whether there is a voicemail');
select hasnt_column('superadmin', 'calls', 'from_number', 'calls never carry the raw caller');
select hasnt_column('superadmin', 'calls', 'voicemail_url', 'calls never carry the recording link');
select ok(has_table_privilege('autofix_superadmin', 'superadmin.call_voicemails', 'select'), 'the super admin reads recording links');
select ok(not has_table_privilege('authenticated', 'superadmin.call_voicemails', 'select'), 'staff cannot read the view');
select ok(not has_table_privilege('anon', 'superadmin.call_voicemails', 'select'), 'anon cannot read the view');

insert into public.garages (id, slug, name, booking_prefix) values ('2d000000-0000-4000-8000-000000000001', 'pgtap-sa-calls', 'SA Calls', 'PSC');
insert into public.calls (id, garage_id, provider_call_sid, from_number, to_number, status, missed, voicemail_url, voicemail_duration_s) values
  ('2d000000-0000-4000-8000-000000000101', '2d000000-0000-4000-8000-000000000001', 'CA-pgtap-sa-1', '+447700900123', '+447700100200', 'completed', true,
   'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE00000000000000000000000000000000', 42),
  ('2d000000-0000-4000-8000-000000000102', '2d000000-0000-4000-8000-000000000001', 'CA-pgtap-sa-2', null, '+447700100200', 'completed', false, null, null);

select is(
  (select array_agg(caller_masked || '|' || has_voicemail || '|' || coalesce(voicemail_duration_s::text, '-') order by id)
   from superadmin.calls where garage_id = '2d000000-0000-4000-8000-000000000001' and caller_masked is not null),
  array['07••• •••123|true|42'],
  'a missed call with a voicemail: masked caller and its length'
);
select is(
  (select has_voicemail from superadmin.calls where id = '2d000000-0000-4000-8000-000000000102'),
  false, 'an answered withheld call has no voicemail'
);
select is(
  (select count(*)::integer from superadmin.call_voicemails where garage_id = '2d000000-0000-4000-8000-000000000001'),
  1, 'only calls with a recording are in call_voicemails'
);

insert into public.platform_calls (id, provider_call_sid, from_number, to_number, status, voicemail_url, voicemail_duration_s) values
  ('2d000000-0000-4000-8000-000000000201', 'CA-pgtap-sa-platform', '+447700900789', '+441146974393', 'completed',
   'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE00000000000000000000000000000009', 21);

select is(
  (select garage_id::text || '|' || is_platform || '|' || caller_masked || '|' || voicemail_duration_s
   from superadmin.calls where id = '2d000000-0000-4000-8000-000000000201'),
  null, 'a platform-line call has no garage (so the concatenation is null)'
);
select is(
  (select is_platform::text || '|' || caller_masked || '|' || has_voicemail || '|' || missed
   from superadmin.calls where id = '2d000000-0000-4000-8000-000000000201'),
  'true|07••• •••789|true|true', 'platform-line calls come through masked, flagged and with their voicemail'
);
select is(
  (select count(*)::integer from superadmin.call_voicemails where id = '2d000000-0000-4000-8000-000000000201' and garage_id is null),
  1, 'the platform-line recording is in call_voicemails, with no garage'
);

select * from finish();
rollback;
