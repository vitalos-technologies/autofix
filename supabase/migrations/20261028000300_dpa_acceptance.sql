-- P4.9: legal records. DPA acceptance per garage, and the customer opt-out
-- trail behind the unsubscribe page.
--
--   1. garage_agreements: one row per garage, agreement kind and version the
--      garage's owner accepted (who, when, and the SHA-256 of the exact text
--      shown). Rows are written only by accept_garage_agreement() (service
--      role, after the app has checked the signed-in owner); staff read their
--      own garage's rows. Rows are never updated or deleted by staff, so the
--      record stands even if the owner later leaves.
--   2. customers.consent_source gains 'unsubscribe_page' (the customer turned
--      reminders back on from the unsubscribe page).
--   3. opt_out_customer(): sets customers.opted_out_at for one customer of one
--      garage, found by id (signed unsubscribe link) or by E.164 phone (the
--      no-token form), and writes `customer.opted_out` to admin_audit_log the
--      first time only. resume_customer_reminders(): the "Turn reminders back
--      on" link; clears opted_out_at and records fresh consent with the shown
--      wording. Both are service-role only and take the garage from the
--      request host (the app), never from the customer.

-- ---------------------------------------------------------------------------
-- 1. garage_agreements
-- ---------------------------------------------------------------------------

create table public.garage_agreements (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  kind text not null,
  version text not null,
  text_hash text not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_by_name text not null,
  accepted_by_role text not null,
  accepted_at timestamptz not null default now(),
  constraint garage_agreements_kind_check check (kind in ('dpa')),
  constraint garage_agreements_version_check check (version ~ '^[0-9A-Za-z._-]{1,40}$'),
  constraint garage_agreements_text_hash_check check (text_hash ~ '^[0-9a-f]{64}$'),
  constraint garage_agreements_accepted_by_name_check check (char_length(accepted_by_name) between 1 and 200),
  constraint garage_agreements_accepted_by_role_check check (accepted_by_role in ('owner')),
  constraint garage_agreements_garage_kind_version_key unique (garage_id, kind, version)
);

comment on table public.garage_agreements is
  'Agreements a garage accepted (the DPA with Vitalos as processor): version, SHA-256 of the exact text shown, who accepted and when. Written only by accept_garage_agreement(); never updated.';
comment on column public.garage_agreements.text_hash is
  'Hex SHA-256 of the agreement text shown to the owner (docs/autofix/legal/DPA-template.md with the garage''s legal name filled; the acceptance line''s date and name are this row''s own columns). See dpaTextHash() in src/lib/legal/documents.ts.';
comment on column public.garage_agreements.accepted_by_name is
  'Name (or email) of the owner at acceptance, kept even if the account is later removed.';

create index garage_agreements_garage_kind_idx on public.garage_agreements (garage_id, kind, accepted_at desc);

alter table public.garage_agreements enable row level security;

-- garage_agreements
--   "garage members read agreements"  select  members of the selected garage
--   (no insert/update/delete policy: accept_garage_agreement() writes with the service role)
create policy "garage members read agreements" on public.garage_agreements
  for select to authenticated using (garage_id = (select public.current_garage_id()));

revoke all on public.garage_agreements from anon, authenticated;
grant select on public.garage_agreements to authenticated;
grant select, insert on public.garage_agreements to service_role;

-- Records that p_user_id, an owner of p_garage_id, accepted an agreement
-- version. Idempotent: accepting the same version again returns the first
-- record unchanged. Raises AGREEMENT_FORBIDDEN (P0001) for anyone who is not
-- an owner of the garage.
create function public.accept_garage_agreement(
  p_garage_id uuid,
  p_user_id uuid,
  p_kind text,
  p_version text,
  p_text_hash text,
  p_accepted_by_name text
)
returns public.garage_agreements
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_role text;
  agreement public.garage_agreements;
begin
  select member.role into member_role
  from public.garage_members member
  join public.garages garage on garage.id = member.garage_id
  where member.garage_id = p_garage_id
    and member.user_id = p_user_id
    and garage.status <> 'cancelled';
  if member_role is distinct from 'owner' then
    raise exception 'AGREEMENT_FORBIDDEN: only a garage owner can accept agreements' using errcode = 'P0001';
  end if;

  insert into public.garage_agreements (garage_id, kind, version, text_hash, accepted_by, accepted_by_name, accepted_by_role)
  values (p_garage_id, p_kind, p_version, lower(p_text_hash), p_user_id, left(coalesce(nullif(btrim(p_accepted_by_name), ''), 'Owner'), 200), 'owner')
  on conflict (garage_id, kind, version) do nothing
  returning * into agreement;

  if agreement.id is null then
    select * into agreement
    from public.garage_agreements existing
    where existing.garage_id = p_garage_id and existing.kind = p_kind and existing.version = p_version;
    return agreement;
  end if;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    p_garage_id, p_user_id, 'agreement.accepted', 'garage_agreement', agreement.id::text,
    jsonb_build_object('kind', agreement.kind, 'version', agreement.version, 'text_hash', agreement.text_hash)
  );
  return agreement;
end;
$$;

comment on function public.accept_garage_agreement(uuid, uuid, text, text, text, text) is
  'Service role only. Records an owner''s acceptance of an agreement version for a garage (idempotent) and audits it.';

-- ---------------------------------------------------------------------------
-- 2. Consent source for "Turn reminders back on"
-- ---------------------------------------------------------------------------

alter table public.customers
  drop constraint customers_consent_source_check,
  add constraint customers_consent_source_check
    check (consent_source is null or consent_source in ('booking', 'import', 'soft_opt_in', 'staff', 'unsubscribe_page'));

-- ---------------------------------------------------------------------------
-- 3. Opt-out and resume
-- ---------------------------------------------------------------------------

-- Opts one customer of one garage out of reminders, by id or by E.164 phone
-- (exactly one). Returns whether a customer matched and whether this call
-- changed anything; the app never shows either to the public form. Opting out
-- an already opted-out customer is a no-op (no second audit row).
create function public.opt_out_customer(p_garage_id uuid, p_customer_id uuid, p_phone text, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
  changed boolean := false;
begin
  if p_source not in ('unsubscribe_link', 'unsubscribe_form', 'sms_stop', 'staff') then
    raise exception 'INVALID_OPT_OUT: unknown source' using errcode = 'P0001';
  end if;
  if (p_customer_id is null) = (p_phone is null) then
    raise exception 'INVALID_OPT_OUT: give a customer id or a phone number' using errcode = 'P0001';
  end if;

  select customer.id into target
  from public.customers customer
  where customer.garage_id = p_garage_id
    and customer.anonymised_at is null
    and (customer.id = p_customer_id or customer.phone = p_phone)
  for update;

  if target is null then
    return jsonb_build_object('matched', false, 'changed', false);
  end if;

  update public.customers
  set opted_out_at = now()
  where id = target and garage_id = p_garage_id and opted_out_at is null;
  changed := found;

  if changed then
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (p_garage_id, null, 'customer.opted_out', 'customer', target::text, jsonb_build_object('source', p_source));
  end if;
  return jsonb_build_object('matched', true, 'changed', changed);
end;
$$;

comment on function public.opt_out_customer(uuid, uuid, text, text) is
  'Service role only. Sets customers.opted_out_at for one customer of one garage (by id or E.164 phone) and audits the first opt-out.';

-- "Turn reminders back on" from the unsubscribe page (signed link only).
-- Clears the opt-out and records consent with the wording the customer saw.
create function public.resume_customer_reminders(p_garage_id uuid, p_customer_id uuid, p_consent_text text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed boolean := false;
begin
  if p_consent_text is null or char_length(btrim(p_consent_text)) not between 1 and 2000 then
    raise exception 'INVALID_OPT_IN: consent wording is required' using errcode = 'P0001';
  end if;

  update public.customers
  set opted_out_at = null,
      reminder_consent = true,
      consent_at = now(),
      consent_source = 'unsubscribe_page',
      consent_text = btrim(p_consent_text)
  where id = p_customer_id and garage_id = p_garage_id and anonymised_at is null and opted_out_at is not null;
  changed := found;

  if changed then
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (p_garage_id, null, 'customer.opted_in', 'customer', p_customer_id::text, jsonb_build_object('source', 'unsubscribe_page'));
  end if;
  return jsonb_build_object('changed', changed);
end;
$$;

comment on function public.resume_customer_reminders(uuid, uuid, text) is
  'Service role only. Clears an opt-out from the unsubscribe page and records consent with the shown wording; audited.';

revoke all on function public.accept_garage_agreement(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.opt_out_customer(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.resume_customer_reminders(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_garage_agreement(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.opt_out_customer(uuid, uuid, text, text) to service_role;
grant execute on function public.resume_customer_reminders(uuid, uuid, text) to service_role;
