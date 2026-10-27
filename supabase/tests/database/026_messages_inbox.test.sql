begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local timezone to 'UTC';

select plan(24);

-- Messages inbox: messages.read_at / read_by (staff mark their garage's
-- inbound messages read, as themselves) and claim_staff_reply() (the claim
-- before a staff reply: role, opt-out, address and messaging-number checks).
--
-- Garage P (MIP) has a provisioned messaging number; garage Q (MIQ) has none.
-- Owner Pat and technician Tam work at P; front desk Fay at P; owner Quin at Q.

update public.admin_mfa_policy set mandatory_mfa_enabled = false where singleton;

insert into auth.users (id, email, raw_user_meta_data) values
  ('17260000-0000-4000-8000-0000000000a1', 'inbox-owner@pgtap.test', '{}'::jsonb),
  ('17260000-0000-4000-8000-0000000000a2', 'inbox-tech@pgtap.test', '{}'::jsonb),
  ('17260000-0000-4000-8000-0000000000a3', 'inbox-desk@pgtap.test', '{}'::jsonb),
  ('17260000-0000-4000-8000-0000000000b1', 'inbox-other@pgtap.test', '{}'::jsonb);
insert into public.garages (id, slug, name, booking_prefix, status) values
  ('a1726000-0000-4000-8000-000000000001', 'pgtap-inbox-p', 'Inbox Garage P', 'MIP', 'active'),
  ('b1726000-0000-4000-8000-000000000001', 'pgtap-inbox-q', 'Inbox Garage Q', 'MIQ', 'active');
insert into public.garage_members (garage_id, user_id, role) values
  ('a1726000-0000-4000-8000-000000000001', '17260000-0000-4000-8000-0000000000a1', 'owner'),
  ('a1726000-0000-4000-8000-000000000001', '17260000-0000-4000-8000-0000000000a2', 'technician'),
  ('a1726000-0000-4000-8000-000000000001', '17260000-0000-4000-8000-0000000000a3', 'front_desk'),
  ('b1726000-0000-4000-8000-000000000001', '17260000-0000-4000-8000-0000000000b1', 'owner');

create function pg_temp.p() returns uuid language sql as $$ select 'a1726000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.q() returns uuid language sql as $$ select 'b1726000-0000-4000-8000-000000000001'::uuid $$;

insert into public.garage_phone_numbers (garage_id, number, purpose, provider_sid) values
  (pg_temp.p(), '+447700926000', 'messaging', 'PNpgtap026messaging'),
  (pg_temp.q(), '+447700926009', 'forwarding', 'PNpgtap026forwarding');

insert into public.customers (id, garage_id, name, phone, email, preferred_contact, channel, opted_out_at, anonymised_at) values
  ('a1726000-0000-4000-8000-000000000101', pg_temp.p(), 'Rae Replies', '+447700926001', null, 'phone', 'sms', null, null),
  ('a1726000-0000-4000-8000-000000000102', pg_temp.p(), 'Otto Optout', '+447700926002', null, 'phone', 'sms', now(), null),
  ('a1726000-0000-4000-8000-000000000103', pg_temp.p(), 'Emma Email', '+447700926003', 'emma@pgtap.test', 'email', 'email', null, null),
  ('a1726000-0000-4000-8000-000000000104', pg_temp.p(), 'Nell Nomail', '+447700926004', null, 'email', 'email', null, null),
  ('a1726000-0000-4000-8000-000000000105', pg_temp.p(), 'Removed', null, null, 'phone', 'sms', null, now()),
  ('b1726000-0000-4000-8000-000000000101', pg_temp.q(), 'Quentin', '+447700926001', null, 'phone', 'sms', null, null);

insert into public.messages (id, garage_id, customer_id, channel, direction, from_address, to_address, body, provider, status) values
  ('a1726000-0000-4000-8000-000000000201', pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', 'sms', 'inbound', '+447700926001', '+447700926000', 'Can I come Thursday?', 'twilio', 'received'),
  ('b1726000-0000-4000-8000-000000000201', pg_temp.q(), 'b1726000-0000-4000-8000-000000000101', 'sms', 'inbound', '+447700926001', '+447700926009', 'Garage Q text', 'twilio', 'received');
insert into public.messages (id, garage_id, customer_id, channel, direction, to_address, body, provider, status) values
  ('a1726000-0000-4000-8000-000000000202', pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', 'sms', 'outbound', '+447700926001', 'Your MOT is due', 'mock', 'sent');

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_column('public', 'messages', 'read_at', 'messages has read_at');
select has_column('public', 'messages', 'read_by', 'messages has read_by');
select throws_ok(
  $$update public.messages set read_at = now() where id = 'a1726000-0000-4000-8000-000000000202'$$,
  '23514', null, 'only inbound messages can be read'
);
select is(
  (select array_agg(attname::text order by attname::text) from pg_attribute
   where attrelid = 'public.messages'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', 'public.messages', attname, 'update')),
  array['read_at', 'read_by'], 'staff may only set read_at and read_by on messages'
);
select is(
  (select count(*)::integer from unnest(array['anon', 'authenticated']) api_role(name)
   where has_function_privilege(api_role.name, 'public.claim_staff_reply(uuid, uuid, uuid, text, text)', 'execute')),
  0, 'anon and staff cannot claim replies directly'
);
select is(
  has_function_privilege('service_role', 'public.claim_staff_reply(uuid, uuid, uuid, text, text)', 'execute'),
  true, 'the service role claims replies'
);
select is(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'public.claim_staff_reply(uuid, uuid, uuid, text, text)'::regprocedure),
  true, 'claim_staff_reply is security definer with an empty search_path'
);

-- ---------------------------------------------------------------------------
-- Staff mark inbound messages read (RLS)
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', jsonb_build_object('sub', '17260000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
select set_config('request.headers', jsonb_build_object('x-garage-id', pg_temp.p())::text, true);
set local role authenticated;

select throws_ok(
  $$update public.messages set body = 'Tampered' where id = 'a1726000-0000-4000-8000-000000000201'$$,
  '42501', null, 'staff cannot change a message'
);
select throws_ok(
  $$update public.messages set read_at = now(), read_by = '17260000-0000-4000-8000-0000000000a1' where id = 'a1726000-0000-4000-8000-000000000201'$$,
  '42501', null, 'staff cannot mark a message read as someone else'
);
select lives_ok(
  $$update public.messages set read_at = now(), read_by = '17260000-0000-4000-8000-0000000000a2' where id = 'a1726000-0000-4000-8000-000000000201'$$,
  'any member (even a technician) marks their garage''s inbound message read as themselves'
);
update public.messages set read_at = now(), read_by = '17260000-0000-4000-8000-0000000000a2' where id = 'b1726000-0000-4000-8000-000000000201';
reset role;
select is(
  (select concat_ws('|', (select read_by from public.messages where id = 'a1726000-0000-4000-8000-000000000201'), (select coalesce(read_at::text, 'unread') from public.messages where id = 'b1726000-0000-4000-8000-000000000201'))),
  '17260000-0000-4000-8000-0000000000a2|unread',
  'the read lands on the own garage''s message only; another garage''s stays unread'
);

-- ---------------------------------------------------------------------------
-- claim_staff_reply
-- ---------------------------------------------------------------------------

set local role service_role;
create temp table claims (label text primary key, result jsonb not null);

insert into claims values ('owner', public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', '17260000-0000-4000-8000-0000000000a1', 'Thursday at 9 works.', 'mock'));
select is(
  (select concat_ws('|', result->>'status', result->>'channel', result->>'to') from claims where label = 'owner'),
  'claimed|sms|+447700926001', 'an owner''s reply to a customer is claimed on their channel'
);
select is(
  (select concat_ws('|', garage_id, customer_id, channel, direction, to_address, from_address, status, provider, body)
   from public.messages where id = (select (result->>'message_id')::uuid from claims where label = 'owner')),
  concat_ws('|', pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', 'sms', 'outbound', '+447700926001', '+447700926000', 'sending', 'mock', 'Thursday at 9 works.'),
  'the reply is written (sending) before the send, from the garage''s messaging number'
);
select is(
  (select result->>'status' from (select public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', '17260000-0000-4000-8000-0000000000a3', 'Front desk here.', 'mock') as result) claimed),
  'claimed', 'front desk may reply'
);
select is(
  public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', '17260000-0000-4000-8000-0000000000a2', 'Tech reply', 'mock'),
  '{"status": "skipped", "reason": "not_allowed"}'::jsonb, 'technicians cannot reply'
);
select is(
  public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', '17260000-0000-4000-8000-0000000000b1', 'Other garage', 'mock'),
  '{"status": "skipped", "reason": "not_allowed"}'::jsonb, 'a member of another garage cannot reply'
);
select is(
  public.claim_staff_reply(pg_temp.q(), 'a1726000-0000-4000-8000-000000000101', '17260000-0000-4000-8000-0000000000b1', 'Wrong garage', 'mock'),
  '{"status": "skipped", "reason": "not_found"}'::jsonb, 'a garage cannot reply to another garage''s customer'
);
select is(
  public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000102', '17260000-0000-4000-8000-0000000000a1', 'Opted out', 'mock'),
  '{"status": "skipped", "reason": "opted_out"}'::jsonb, 'an opted-out customer gets no reply'
);
select is(
  public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000105', '17260000-0000-4000-8000-0000000000a1', 'Removed', 'mock'),
  '{"status": "skipped", "reason": "anonymised"}'::jsonb, 'a removed customer gets no reply'
);
select is(
  (select concat_ws('|', result->>'status', result->>'channel', result->>'to') from (select public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000103', '17260000-0000-4000-8000-0000000000a1', 'By email', 'mock') as result) claimed),
  'claimed|email|emma@pgtap.test', 'an email customer is answered by email'
);
select is(
  public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000104', '17260000-0000-4000-8000-0000000000a1', 'No email', 'mock'),
  '{"status": "skipped", "reason": "no_address"}'::jsonb, 'an email customer without an email gets no reply'
);
select is(
  public.claim_staff_reply(pg_temp.q(), 'b1726000-0000-4000-8000-000000000101', '17260000-0000-4000-8000-0000000000b1', 'No number', 'mock'),
  '{"status": "skipped", "reason": "no_messaging_number"}'::jsonb, 'a garage without a provisioned messaging number cannot text'
);
select throws_ok(
  $$select public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', '17260000-0000-4000-8000-0000000000a1', '   ', 'mock')$$,
  '22023', null, 'a reply needs a body'
);
select throws_ok(
  $$select public.claim_staff_reply(pg_temp.p(), 'a1726000-0000-4000-8000-000000000101', null, 'x', 'mock')$$,
  '22023', null, 'a reply needs the member'
);

select * from finish();
rollback;
