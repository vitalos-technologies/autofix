-- Contact page enquiries (29 Oct 2026): what people send from
-- autofix.vitalos.co.uk/contact, and how Vitalos staff handle them in the
-- Django super admin's Enquiries page.
--
--   1. platform_enquiries: a platform table (DECISIONS A10). An enquiry is
--      sent to Vitalos, not to a garage, so there is no garage_id. RLS on,
--      no policies: only the service role reads and inserts, from the
--      /api/contact route after zod validation, Turnstile and the rate
--      limits. ip_hash is the rate limiter's own identifier hash
--      (SHA-256 of "<UTC day>:<ip>", src/lib/rate-limit.ts), so it links
--      submissions from one source on one day and nothing more.
--   2. superadmin.platform_enquiries: the super admin's read-only view
--      (role autofix_superadmin, 20261028004000_superadmin_role.sql). It
--      carries the contact details unmasked, because staff reply to them;
--      the Django app shows them only on the detail page, to SuperAdmin and
--      Support, and audits each view. No ip_hash.
--   3. platform_update_enquiry(): status and internal notes. Platform admin
--      at AAL2 (the super admin sets request.jwt.claims for the signed-in
--      person's linked platform admin), validated input, handled_by set to
--      the caller, one platform_audit_log row per change (notes by length
--      only). EXECUTE for autofix_superadmin only.
--
-- Rollback (manual): drop view superadmin.platform_enquiries; drop function
-- public.platform_update_enquiry(uuid, text, text); drop table
-- public.platform_enquiries.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table public.platform_enquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  garage_name text,
  topic text not null,
  message text not null,
  status text not null default 'new',
  received_at timestamptz not null default now(),
  handled_by uuid references auth.users(id) on delete set null,
  notes text,
  ip_hash text,
  updated_at timestamptz not null default now(),
  constraint platform_enquiries_name_check check (char_length(btrim(name)) between 2 and 100),
  constraint platform_enquiries_email_check check (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint platform_enquiries_phone_check check (phone is null or char_length(phone) between 7 and 30),
  constraint platform_enquiries_garage_name_check check (garage_name is null or char_length(btrim(garage_name)) between 1 and 120),
  constraint platform_enquiries_topic_check check (topic in ('general', 'sales', 'support', 'partnership')),
  constraint platform_enquiries_message_check check (char_length(btrim(message)) between 10 and 5000),
  constraint platform_enquiries_status_check check (status in ('new', 'in_progress', 'closed')),
  constraint platform_enquiries_notes_check check (notes is null or char_length(notes) between 1 and 5000),
  constraint platform_enquiries_ip_hash_check check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$')
);

create index platform_enquiries_received_idx on public.platform_enquiries (received_at desc);
create index platform_enquiries_status_idx on public.platform_enquiries (status, received_at desc);

comment on table public.platform_enquiries is
  'Contact page enquiries to Vitalos (platform table, no garage_id, A10). Service role inserts from /api/contact; '
  'staff read and update them in the Django super admin (superadmin.platform_enquiries, platform_update_enquiry).';

alter table public.platform_enquiries enable row level security;

-- platform_enquiries
--   no policies: service role only (select, insert). Staff change status and
--   notes only through platform_update_enquiry().
revoke all on public.platform_enquiries from public, anon, authenticated;
grant select, insert on public.platform_enquiries to service_role;

-- ---------------------------------------------------------------------------
-- 2. Status and notes (platform admin at AAL2, audited)
-- ---------------------------------------------------------------------------

-- p_status null keeps the status; p_notes null keeps the notes and '' (or
-- only spaces) clears them. Control characters other than tab and newline
-- are dropped. Each change is one platform_audit_log row.
create function public.platform_update_enquiry(p_enquiry_id uuid, p_status text, p_notes text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  admin_id uuid;
  cleaned_notes text;
  before_row public.platform_enquiries%rowtype;
  after_row public.platform_enquiries%rowtype;
begin
  admin_id := public.require_platform_admin();
  if p_status is null and p_notes is null then
    raise exception 'NOTHING_TO_CHANGE' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('new', 'in_progress', 'closed') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;
  if p_notes is not null then
    cleaned_notes := nullif(btrim(regexp_replace(replace(p_notes, E'\r\n', E'\n'), '[\x01-\x08\x0B-\x1F\x7F]', '', 'g')), '');
    if char_length(cleaned_notes) > 5000 then
      raise exception 'INVALID_NOTES: at most 5000 characters' using errcode = '22023';
    end if;
  end if;

  select * into before_row from public.platform_enquiries enquiry where enquiry.id = p_enquiry_id for update;
  if not found then
    raise exception 'ENQUIRY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if coalesce(p_status, before_row.status) = before_row.status
     and (p_notes is null or cleaned_notes is not distinct from before_row.notes) then
    raise exception 'NOTHING_TO_CHANGE' using errcode = '22023';
  end if;

  update public.platform_enquiries enquiry
  set status = coalesce(p_status, enquiry.status),
      notes = case when p_notes is null then enquiry.notes else cleaned_notes end,
      handled_by = admin_id,
      updated_at = now()
  where enquiry.id = p_enquiry_id
  returning * into after_row;

  if after_row.status is distinct from before_row.status then
    perform public.record_platform_action('platform.enquiry_status_changed', null, 'platform_enquiry', p_enquiry_id::text, null,
      jsonb_build_object('from', before_row.status, 'to', after_row.status));
  end if;
  if after_row.notes is distinct from before_row.notes then
    perform public.record_platform_action('platform.enquiry_notes_changed', null, 'platform_enquiry', p_enquiry_id::text, null,
      jsonb_build_object('length', coalesce(char_length(after_row.notes), 0)));
  end if;

  return jsonb_build_object('id', after_row.id, 'status', after_row.status, 'notes', after_row.notes,
                            'handled_by', after_row.handled_by, 'updated_at', after_row.updated_at);
end
$$;

comment on function public.platform_update_enquiry(uuid, text, text) is
  'Contact enquiries: platform admin at AAL2 sets status (new, in_progress, closed) and/or internal notes; handled_by is the caller. '
  'Audited in platform_audit_log (platform.enquiry_status_changed, platform.enquiry_notes_changed). Called by the Django super admin only.';

-- ---------------------------------------------------------------------------
-- 3. Super admin view
-- ---------------------------------------------------------------------------

create view superadmin.platform_enquiries with (security_barrier = true) as
  select enquiry.id, enquiry.name, enquiry.email, enquiry.phone, enquiry.garage_name, enquiry.topic, enquiry.message,
         enquiry.status, enquiry.received_at, enquiry.handled_by,
         case when enquiry.handled_by is null then null else coalesce(profile.display_name, 'Vitalos support') end as handled_by_name,
         enquiry.notes, enquiry.updated_at
  from public.platform_enquiries enquiry
  left join public.admin_profiles profile on profile.user_id = enquiry.handled_by;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

revoke all on superadmin.platform_enquiries from public, anon, authenticated;
grant select on superadmin.platform_enquiries to autofix_superadmin;

revoke all on function public.platform_update_enquiry(uuid, text, text) from public, anon, authenticated;
grant execute on function public.platform_update_enquiry(uuid, text, text) to autofix_superadmin;
