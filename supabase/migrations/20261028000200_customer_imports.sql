-- P3.11: customer import, vehicle enrichment state and the A37 retention fix.
--
--   1. customer_imports: one row per CSV import (who, when, file, counts, the
--      consent declaration and when it was accepted, per-row errors).
--   2. customers.import_id / vehicles.import_id, vehicles.enrichment_status and
--      enrichment_attempts for background DVSA enrichment.
--   3. Staff RPCs start_customer_import(), import_customer_rows() and
--      finish_customer_import(): owners and managers of the selected garage;
--      rows are upserted by (garage_id, phone) and (garage_id, registration) in
--      one statement per batch, idempotently. Consent is recorded only when the
--      declaration was accepted; an existing opt-out is never cleared.
--   4. apply_enquiry_retention(): customers holding live reminder consent are
--      kept; customers who never made an enquiry (imported or added by staff)
--      are anonymised only after 24 months with no activity, and still never
--      while they have a booking or invoice (DECISIONS.md A37).

-- ---------------------------------------------------------------------------
-- 1. customer_imports
-- ---------------------------------------------------------------------------

create table public.customer_imports (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  file_name text not null,
  status text not null default 'importing',
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  invalid_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  imported_rows integer not null default 0,
  customers_created integer not null default 0,
  customers_updated integer not null default 0,
  vehicles_created integer not null default 0,
  vehicles_updated integer not null default 0,
  consent_recorded integer not null default 0,
  declaration_text text,
  declaration_accepted_at timestamptz,
  errors jsonb not null default '[]'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_imports_garage_id_id_key unique (garage_id, id),
  constraint customer_imports_file_name_check check (char_length(trim(file_name)) between 1 and 200),
  constraint customer_imports_status_check check (status in ('importing', 'completed', 'failed')),
  constraint customer_imports_counts_check check (
    least(total_rows, valid_rows, invalid_rows, duplicate_rows, imported_rows,
      customers_created, customers_updated, vehicles_created, vehicles_updated, consent_recorded) >= 0
    and total_rows <= 100000
  ),
  constraint customer_imports_declaration_check check (
    (declaration_text is null and declaration_accepted_at is null)
    or (declaration_accepted_at is not null and char_length(declaration_text) between 1 and 2000)
  ),
  constraint customer_imports_errors_check check (jsonb_typeof(errors) = 'array' and jsonb_array_length(errors) <= 500),
  constraint customer_imports_completed_check check ((status = 'importing') = (completed_at is null))
);

create index customer_imports_garage_created_idx on public.customer_imports (garage_id, created_at desc);

create trigger customer_imports_updated before update on public.customer_imports
  for each row execute function public.set_updated_at();

comment on table public.customer_imports is
  'One row per customer CSV import. Members of the garage read it; rows are written only by start_customer_import(), import_customer_rows() and finish_customer_import() (owners and managers). The service role manages everything.';
comment on column public.customer_imports.declaration_text is
  'The consent declaration the garage ticked, word for word (PECR record). Null when it was not ticked: no consent is recorded for that import.';
comment on column public.customer_imports.errors is
  'Per-row problems found while validating the file: [{row, field, message}], at most 500. Never holds phone numbers or registrations.';

-- ---------------------------------------------------------------------------
-- 2. Customers and vehicles
-- ---------------------------------------------------------------------------

alter table public.customers
  add column import_id uuid,
  add constraint customers_import_id_fkey foreign key (garage_id, import_id)
    references public.customer_imports (garage_id, id) on delete set null (import_id);
create index customers_garage_import_idx on public.customers (garage_id, import_id) where import_id is not null;
create index customers_garage_name_idx on public.customers (garage_id, lower(name));

comment on column public.customers.import_id is 'The import that created this customer, if any.';

alter table public.vehicles
  add column import_id uuid,
  add column enrichment_status text,
  add column enrichment_attempts smallint not null default 0,
  add constraint vehicles_import_id_fkey foreign key (garage_id, import_id)
    references public.customer_imports (garage_id, id) on delete set null (import_id),
  add constraint vehicles_enrichment_status_check
    check (enrichment_status is null or enrichment_status in ('pending', 'done', 'not_found', 'failed')),
  add constraint vehicles_enrichment_attempts_check check (enrichment_attempts between 0 and 100);
create index vehicles_garage_enrichment_idx on public.vehicles (garage_id, import_id, created_at)
  where enrichment_status = 'pending';

comment on column public.vehicles.import_id is 'The latest import that listed this vehicle.';
comment on column public.vehicles.enrichment_status is
  'Background DVSA enrichment after an import: pending, done, not_found or failed (after repeated errors). Null when never queued. mot_checked_at records the last successful check.';

-- ---------------------------------------------------------------------------
-- 3. Import RPCs (staff: owners and managers of the selected garage)
-- ---------------------------------------------------------------------------

-- Owners and managers of the selected garage, under the same MFA rule as the
-- invoice and trash RPCs. Returns the garage.
create function public.require_customer_import_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.garage_actor_allowed(), false)
     or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  return public.current_garage_id();
end
$$;

-- Opens an import. p_summary: {total_rows, valid_rows, invalid_rows,
-- duplicate_rows, errors: [{row, field, message}]} from the app's validation.
-- p_declaration_text is the declaration the user ticked, or null.
create function public.start_customer_import(p_file_name text, p_summary jsonb, p_declaration_text text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid := public.require_customer_import_actor();
  summary jsonb := coalesce(p_summary, '{}'::jsonb);
  declaration text := nullif(trim(coalesce(p_declaration_text, '')), '');
  import_id uuid;
begin
  if jsonb_typeof(summary) <> 'object'
     or (summary ? 'errors' and jsonb_typeof(summary -> 'errors') <> 'array') then
    raise exception 'INVALID_IMPORT' using errcode = 'P0001';
  end if;

  insert into public.customer_imports (
    garage_id, created_by, file_name, total_rows, valid_rows, invalid_rows, duplicate_rows,
    declaration_text, declaration_accepted_at, errors
  ) values (
    garage_scope,
    auth.uid(),
    left(trim(coalesce(p_file_name, '')), 200),
    coalesce((summary ->> 'total_rows')::integer, 0),
    coalesce((summary ->> 'valid_rows')::integer, 0),
    coalesce((summary ->> 'invalid_rows')::integer, 0),
    coalesce((summary ->> 'duplicate_rows')::integer, 0),
    declaration,
    case when declaration is null then null else now() end,
    coalesce((
      select jsonb_agg(item)
      from (select item from jsonb_array_elements(summary -> 'errors') item limit 500) limited
    ), '[]'::jsonb)
  )
  returning id into import_id;
  return import_id;
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'INVALID_IMPORT' using errcode = 'P0001';
end
$$;

-- Upserts one batch (at most 1,000 rows) of validated rows:
-- [{name, phone (E.164), email, registration (normalised or null), consent bool}].
-- Customers match on (garage_id, phone), vehicles on (garage_id, registration);
-- running the same batch again changes nothing but the counters it returns.
-- Existing customers keep their name and email (a blank email is filled in);
-- a matched vehicle moves to the imported customer (A31). Consent is written
-- only when the import's declaration was accepted, the row says yes, the
-- customer has no consent on record and has not opted out. opted_out_at is
-- never touched.
create function public.import_customer_rows(p_import_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid := public.require_customer_import_actor();
  target public.customer_imports;
  row_count integer;
  result jsonb;
begin
  select * into target
  from public.customer_imports import
  where import.garage_id = garage_scope and import.id = p_import_id
  for update;
  if not found then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0001'; end if;
  if target.status <> 'importing' then raise exception 'IMPORT_CLOSED' using errcode = 'P0001'; end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_IMPORT_ROWS' using errcode = 'P0001';
  end if;
  row_count := jsonb_array_length(p_rows);
  if row_count = 0 or row_count > 1000 then
    raise exception 'INVALID_IMPORT_ROWS' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as input(name text, phone text, email text, registration text, consent boolean)
    where input.phone is null or input.phone !~ '^\+[1-9][0-9]{6,14}$'
       or char_length(trim(coalesce(input.name, ''))) not between 1 and 120
       or (input.email is not null and (char_length(input.email) > 254 or input.email !~ '^[^@[:space:]]+@[^@[:space:]]+$'))
       or (input.registration is not null and input.registration !~ '^[A-Z0-9]{2,8}$')
  ) then
    raise exception 'INVALID_IMPORT_ROWS' using errcode = 'P0001';
  end if;

  with input as (
    select
      ordinality as position,
      trim(item.name) as name,
      item.phone,
      nullif(lower(trim(item.email)), '') as email,
      nullif(item.registration, '') as registration,
      coalesce(item.consent, false) and target.declaration_accepted_at is not null as consent
    from jsonb_array_elements(p_rows) with ordinality element
    cross join lateral jsonb_to_record(element.value) as item(name text, phone text, email text, registration text, consent boolean)
  ),
  people as (
    -- One customer per phone: the first row's name, the first email given, and
    -- consent when any of that customer's rows says yes.
    select distinct on (input.phone)
      input.phone,
      input.name,
      (select other.email from input other where other.phone = input.phone and other.email is not null order by other.position limit 1) as email,
      bool_or(input.consent) over (partition by input.phone) as consent
    from input
    order by input.phone, input.position
  ),
  existing as (
    -- The statement's snapshot: consent state before this batch.
    select customer.phone, customer.reminder_consent, customer.opted_out_at
    from public.customers customer
    where customer.garage_id = garage_scope and customer.phone in (select people.phone from people)
  ),
  saved_customers as (
    insert into public.customers as customer (
      garage_id, name, email, phone, preferred_contact, channel, import_id,
      reminder_consent, consent_at, consent_source, consent_text
    )
    select
      garage_scope, people.name, people.email, people.phone, 'phone', 'sms', target.id,
      people.consent,
      case when people.consent then now() end,
      case when people.consent then 'import' end,
      case when people.consent then target.declaration_text end
    from people
    on conflict (garage_id, phone) do update set
      email = coalesce(customer.email, excluded.email),
      reminder_consent = customer.reminder_consent or (excluded.reminder_consent and customer.opted_out_at is null),
      consent_at = case when not customer.reminder_consent and excluded.reminder_consent and customer.opted_out_at is null
        then excluded.consent_at else customer.consent_at end,
      consent_source = case when not customer.reminder_consent and excluded.reminder_consent and customer.opted_out_at is null
        then excluded.consent_source else customer.consent_source end,
      consent_text = case when not customer.reminder_consent and excluded.reminder_consent and customer.opted_out_at is null
        then excluded.consent_text else customer.consent_text end
    returning
      customer.id,
      customer.phone,
      (customer.xmax = 0) as created
  ),
  consented as (
    select people.phone
    from people
    left join existing on existing.phone = people.phone
    where people.consent
      and (existing.phone is null or (not existing.reminder_consent and existing.opted_out_at is null))
  ),
  cars as (
    select distinct on (input.registration) input.registration, input.phone
    from input
    where input.registration is not null
    order by input.registration, input.position
  ),
  saved_vehicles as (
    insert into public.vehicles as vehicle (garage_id, customer_id, registration, import_id, enrichment_status)
    select garage_scope, saved_customers.id, cars.registration, target.id, 'pending'
    from cars
    join saved_customers on saved_customers.phone = cars.phone
    on conflict (garage_id, registration) do update set
      customer_id = excluded.customer_id,
      import_id = excluded.import_id,
      enrichment_status = coalesce(vehicle.enrichment_status, case when vehicle.mot_checked_at is null then 'pending' end)
    returning (vehicle.xmax = 0) as created
  )
  select jsonb_build_object(
    'rows', row_count,
    'customers_created', (select count(*) from saved_customers where created),
    'customers_updated', (select count(*) from saved_customers where not created),
    'vehicles_created', (select count(*) from saved_vehicles where created),
    'vehicles_updated', (select count(*) from saved_vehicles where not created),
    'consent_recorded', (select count(*) from consented)
  ) into result;

  update public.customer_imports import set
    imported_rows = import.imported_rows + row_count,
    customers_created = import.customers_created + (result ->> 'customers_created')::integer,
    customers_updated = import.customers_updated + (result ->> 'customers_updated')::integer,
    vehicles_created = import.vehicles_created + (result ->> 'vehicles_created')::integer,
    vehicles_updated = import.vehicles_updated + (result ->> 'vehicles_updated')::integer,
    consent_recorded = import.consent_recorded + (result ->> 'consent_recorded')::integer
  where import.garage_id = garage_scope and import.id = target.id;

  return result;
end
$$;

-- Closes an import as completed or failed. Closing twice is a no-op.
create function public.finish_customer_import(p_import_id uuid, p_status text)
returns public.customer_imports
language plpgsql
security definer
set search_path = ''
as $$
declare
  garage_scope uuid := public.require_customer_import_actor();
  target public.customer_imports;
begin
  if p_status not in ('completed', 'failed') then
    raise exception 'INVALID_IMPORT' using errcode = 'P0001';
  end if;
  update public.customer_imports import
  set status = p_status, completed_at = now()
  where import.garage_id = garage_scope and import.id = p_import_id and import.status = 'importing'
  returning * into target;
  if not found then
    select * into target from public.customer_imports import
    where import.garage_id = garage_scope and import.id = p_import_id;
    if not found then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  return target;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Retention (A37)
-- ---------------------------------------------------------------------------

-- Closed enquiries older than 12 months lose their attachments. A customer is
-- anonymised when nothing keeps them:
--   * no open enquiry and none closed in the last 12 months,
--   * no booking and no invoice (A17),
--   * no live reminder consent (consent on record and not opted out),
--   * and, for a customer who never made an enquiry (imported or added by
--     staff), no change to their record for 24 months.
-- The phone is cleared (not 'REDACTED') so one number stays one customer per
-- garage.
create or replace function public.apply_enquiry_retention(p_garage_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_garage_id is null then
    raise exception 'GARAGE_REQUIRED' using errcode = '22004';
  end if;

  -- Newer Storage versions block direct deletes unless this is set.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects object
  where object.bucket_id = 'enquiry-attachments'
    and object.name in (
      select attachment.object_path
      from public.enquiry_attachments attachment
      join public.enquiries enquiry
        on enquiry.garage_id = attachment.garage_id
       and enquiry.id = attachment.enquiry_id
      where attachment.garage_id = p_garage_id
        and enquiry.status = 'closed'
        and enquiry.closed_at < now() - interval '12 months'
    );

  delete from public.enquiry_attachments attachment
  where attachment.garage_id = p_garage_id
    and attachment.enquiry_id in (
      select enquiry.id
      from public.enquiries enquiry
      where enquiry.garage_id = p_garage_id
        and enquiry.status = 'closed'
        and enquiry.closed_at < now() - interval '12 months'
    );

  update public.customers customer
  set name = 'Anonymised', email = null, phone = null, anonymised_at = now()
  where customer.garage_id = p_garage_id
    and customer.anonymised_at is null
    and not (customer.reminder_consent and customer.opted_out_at is null)
    and (
      greatest(customer.created_at, customer.updated_at) < now() - interval '24 months'
      or exists (
        select 1
        from public.enquiries enquiry
        where enquiry.garage_id = customer.garage_id
          and enquiry.customer_id = customer.id
      )
    )
    and not exists (
      select 1
      from public.enquiries enquiry
      where enquiry.garage_id = customer.garage_id
        and enquiry.customer_id = customer.id
        and (enquiry.status <> 'closed' or enquiry.closed_at >= now() - interval '12 months')
    )
    and not exists (
      select 1
      from public.bookings booking
      where booking.garage_id = customer.garage_id
        and booking.customer_id = customer.id
    )
    and not exists (
      select 1
      from public.invoices invoice
      where invoice.garage_id = customer.garage_id
        and invoice.customer_id = customer.id
    );
  get diagnostics affected = row_count;
  return affected;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS, grants
-- ---------------------------------------------------------------------------

alter table public.customer_imports enable row level security;

-- customer_imports
--   "garage members read customer imports"  select  members of the selected garage
--   no insert/update/delete for staff: start_customer_import(), import_customer_rows()
--   and finish_customer_import() write it (owners and managers); the service role manages all
create policy "garage members read customer imports" on public.customer_imports
  for select to authenticated using (garage_id = (select public.current_garage_id()));

grant select on public.customer_imports to authenticated;
grant select, insert, update, delete on public.customer_imports to service_role;

revoke all on function public.require_customer_import_actor() from public, anon, authenticated, service_role;
revoke all on function public.start_customer_import(text, jsonb, text) from public, anon;
revoke all on function public.import_customer_rows(uuid, jsonb) from public, anon;
revoke all on function public.finish_customer_import(uuid, text) from public, anon;
grant execute on function public.start_customer_import(text, jsonb, text) to authenticated;
grant execute on function public.import_customer_rows(uuid, jsonb) to authenticated;
grant execute on function public.finish_customer_import(uuid, text) to authenticated;
