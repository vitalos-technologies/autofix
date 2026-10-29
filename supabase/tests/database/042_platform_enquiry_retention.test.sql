begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

-- Contact enquiries are deleted 24 months after their last change
-- (20261029003200_platform_enquiry_retention.sql, A430).

insert into public.platform_enquiries (id, name, email, topic, message, status, received_at, updated_at) values
  ('4e100000-0000-4000-8000-000000000001', 'Old Enquirer', 'old@pgtap.test', 'general', 'An enquiry from long ago.', 'closed',
   now() - interval '30 months', now() - interval '25 months'),
  ('4e100000-0000-4000-8000-000000000002', 'Recent Notes', 'notes@pgtap.test', 'general', 'Received long ago, changed lately.', 'in_progress',
   now() - interval '30 months', now() - interval '23 months'),
  ('4e100000-0000-4000-8000-000000000003', 'New Enquirer', 'new@pgtap.test', 'sales', 'A recent enquiry about prices.', 'new',
   now(), now());

select ok(
  not has_function_privilege('anon', 'public.apply_platform_enquiry_retention()', 'execute')
  and not has_function_privilege('authenticated', 'public.apply_platform_enquiry_retention()', 'execute'),
  'anon and signed-in users cannot run enquiry retention'
);
select ok(has_function_privilege('service_role', 'public.apply_platform_enquiry_retention()', 'execute'), 'the service role runs it');
select ok(not has_table_privilege('service_role', 'public.platform_enquiries', 'delete'), 'the service role still cannot delete enquiries directly');

select is(public.apply_platform_enquiry_retention(), 1, 'one enquiry last changed over 24 months ago is deleted');
select is(
  (select array_agg(name order by name) from public.platform_enquiries where id::text like '4e100000-%'),
  array['New Enquirer', 'Recent Notes'], 'enquiries changed within 24 months stay, whenever they were received'
);
select is(public.apply_platform_enquiry_retention(), 0, 'a second run deletes nothing');

select * from finish();
rollback;
