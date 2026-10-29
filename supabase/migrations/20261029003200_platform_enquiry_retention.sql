-- Contact enquiries are kept for 24 months after their last change
-- (Temitope, 29 Oct 2026; DECISIONS A430). They hold names, email addresses
-- and phone numbers sent to Vitalos from the contact page.
--
--   apply_platform_enquiry_retention()
--     deletes platform_enquiries rows whose updated_at is more than 24 months
--     ago and returns how many went. Run by the daily `retention` job's
--     platform step (src/lib/jobs/handlers/retention.ts) with the service
--     role, which still cannot delete from the table directly (A421).
--
-- Rollback (manual): drop function public.apply_platform_enquiry_retention().

create function public.apply_platform_enquiry_retention()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.platform_enquiries enquiry
  where enquiry.updated_at < now() - interval '24 months';
  get diagnostics removed = row_count;
  return removed;
end
$$;

comment on function public.apply_platform_enquiry_retention() is
  'Contact enquiries: deletes those last changed more than 24 months ago (A430) and returns the count. Service role only, from the daily retention job.';

revoke all on function public.apply_platform_enquiry_retention() from public, anon, authenticated;
grant execute on function public.apply_platform_enquiry_retention() to service_role;
