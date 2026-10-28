-- P5.7 Fleet and trade accounts (Pro feature `fleet_accounts`, D17; DECISIONS A342-A349).
--
-- Business customers with many cars and a monthly statement:
--
--   business_accounts           the business (fleet or trade): billing details, terms, PO rule
--   business_account_vehicles   cars that belong to an account (a car is on at most one account)
--   business_account_customers  drivers and contacts (ordinary customers) linked to an account
--   business_account_bookings   the account (and PO number) a booking is charged to
--   business_account_invoices   invoices charged to an account (bill-to snapshot, statement)
--   account_statements          one statement per account and month (draft, issued, paid)
--
-- Bookings still go through create_booking() (this migration never redefines it):
-- set_booking_account() links a booking made through the staff path afterwards.
-- Invoices keep their own tables and functions; an AFTER trigger links an
-- invoice made for an account booking, and nothing in the invoice rows changes.
--
-- Gating (P5.2): select policies don't check the plan (a downgraded garage keeps
-- reading its accounts); every write policy and function checks
-- garage_has_feature(garage_id, 'fleet_accounts').

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.business_accounts (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  name text not null,
  kind text not null default 'fleet',
  company_number text,
  billing_email text,
  billing_address text,
  contact_name text,
  contact_phone text,
  contact_email text,
  payment_terms_days integer not null default 30,
  po_required boolean not null default false,
  discount_percent numeric(5,2),
  credit_limit_pence bigint,
  billing text not null default 'monthly',
  notes text,
  archived_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_accounts_garage_id_id_key unique (garage_id, id),
  constraint business_accounts_name_check check (char_length(btrim(name)) between 2 and 120),
  constraint business_accounts_kind_check check (kind in ('fleet', 'trade')),
  constraint business_accounts_company_number_check check (company_number is null or company_number ~ '^[A-Z0-9]{8}$'),
  constraint business_accounts_billing_email_check
    check (billing_email is null or (char_length(billing_email) <= 254 and billing_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  constraint business_accounts_billing_address_check check (billing_address is null or char_length(billing_address) <= 500),
  constraint business_accounts_contact_name_check check (contact_name is null or char_length(contact_name) <= 120),
  constraint business_accounts_contact_phone_check check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint business_accounts_contact_email_check
    check (contact_email is null or (char_length(contact_email) <= 254 and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  constraint business_accounts_terms_check check (payment_terms_days between 0 and 120),
  constraint business_accounts_discount_check check (discount_percent is null or (discount_percent > 0 and discount_percent <= 100)),
  constraint business_accounts_credit_limit_check check (credit_limit_pence is null or credit_limit_pence between 0 and 9007199254740991),
  constraint business_accounts_billing_check check (billing in ('monthly', 'per_invoice')),
  constraint business_accounts_notes_check check (notes is null or char_length(notes) <= 2000)
);

comment on table public.business_accounts is
  'P5.7: a fleet or trade customer (a business). Owners and managers add and change it (archive, never delete); every member reads it. billing = monthly: its invoices go on a monthly statement and are not emailed one by one.';

create unique index business_accounts_active_name_idx on public.business_accounts (garage_id, lower(btrim(name))) where archived_at is null;
create index business_accounts_garage_idx on public.business_accounts (garage_id, archived_at, name);

create trigger business_accounts_updated before update on public.business_accounts
  for each row execute function public.set_updated_at();

create table public.business_account_vehicles (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  account_id uuid not null,
  vehicle_id uuid not null,
  added_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint business_account_vehicles_garage_id_id_key unique (garage_id, id),
  constraint business_account_vehicles_vehicle_key unique (garage_id, vehicle_id),
  constraint business_account_vehicles_account_fkey foreign key (garage_id, account_id)
    references public.business_accounts (garage_id, id) on delete cascade,
  constraint business_account_vehicles_vehicle_fkey foreign key (garage_id, vehicle_id)
    references public.vehicles (garage_id, id) on delete cascade
);

comment on table public.business_account_vehicles is
  'P5.7: a car that belongs to a business account (at most one account per car). Its driver can still be an ordinary customer.';

create index business_account_vehicles_account_idx on public.business_account_vehicles (garage_id, account_id);

create table public.business_account_customers (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  account_id uuid not null,
  customer_id uuid not null,
  role text not null default 'driver',
  added_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint business_account_customers_garage_id_id_key unique (garage_id, id),
  constraint business_account_customers_key unique (garage_id, account_id, customer_id),
  constraint business_account_customers_role_check check (role in ('driver', 'contact')),
  constraint business_account_customers_account_fkey foreign key (garage_id, account_id)
    references public.business_accounts (garage_id, id) on delete cascade,
  constraint business_account_customers_customer_fkey foreign key (garage_id, customer_id)
    references public.customers (garage_id, id) on delete cascade
);

comment on table public.business_account_customers is
  'P5.7: drivers and contacts of a business account (ordinary customers rows; a customer may drive for more than one account).';

create index business_account_customers_customer_idx on public.business_account_customers (garage_id, customer_id);

create table public.business_account_bookings (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  booking_id uuid not null,
  account_id uuid not null,
  po_number text,
  set_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_account_bookings_garage_id_id_key unique (garage_id, id),
  constraint business_account_bookings_booking_key unique (garage_id, booking_id),
  constraint business_account_bookings_po_check check (po_number is null or char_length(po_number) between 1 and 40),
  constraint business_account_bookings_booking_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade,
  constraint business_account_bookings_account_fkey foreign key (garage_id, account_id)
    references public.business_accounts (garage_id, id) on delete cascade
);

comment on table public.business_account_bookings is
  'P5.7: the business account (and purchase order number) a booking is charged to. Written only by set_booking_account(), after create_booking().';

create index business_account_bookings_account_idx on public.business_account_bookings (garage_id, account_id, created_at desc);

create trigger business_account_bookings_updated before update on public.business_account_bookings
  for each row execute function public.set_updated_at();

create table public.account_statements (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  account_id uuid not null,
  reference text not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft',
  invoice_count integer not null default 0,
  total_pence bigint not null default 0,
  issue_date date,
  due_date date,
  issued_at timestamptz,
  issued_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  payment_method text,
  payment_reference text,
  emailed_at timestamptz,
  emailed_to text,
  email_status text,
  email_provider_id text,
  email_count integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_statements_garage_id_id_key unique (garage_id, id),
  constraint account_statements_period_key unique (garage_id, account_id, period_start),
  constraint account_statements_reference_key unique (garage_id, reference),
  constraint account_statements_reference_check check (reference ~ '^[A-Z]{2,4}-ST-[0-9]{6}-[0-9]{3,}$'),
  constraint account_statements_period_check
    check (period_start = date_trunc('month', period_start)::date
           and period_end = (date_trunc('month', period_start) + interval '1 month' - interval '1 day')::date),
  constraint account_statements_status_check check (status in ('draft', 'issued', 'paid')),
  constraint account_statements_counts_check
    check (invoice_count >= 0 and total_pence between 0 and 9007199254740991 and email_count >= 0),
  constraint account_statements_lifecycle_check check (
    (status = 'draft' and issue_date is null and due_date is null and issued_at is null and paid_at is null)
    or (status = 'issued' and issue_date is not null and due_date >= issue_date and issued_at is not null and paid_at is null)
    or (status = 'paid' and issue_date is not null and due_date >= issue_date and issued_at is not null and paid_at is not null
        and payment_method in ('cash', 'card', 'bank_transfer', 'other'))
  ),
  constraint account_statements_payment_reference_check check (payment_reference is null or char_length(payment_reference) <= 120),
  constraint account_statements_email_check check (
    (email_status is null and emailed_at is null and emailed_to is null)
    or (email_status in ('sent', 'failed') and emailed_at is not null and emailed_to is not null and char_length(emailed_to) <= 254)
  ),
  constraint account_statements_email_provider_check check (email_provider_id is null or char_length(email_provider_id) <= 200),
  constraint account_statements_account_fkey foreign key (garage_id, account_id)
    references public.business_accounts (garage_id, id) on delete cascade
);

comment on table public.account_statements is
  'P5.7: the monthly statement of a business account: its issued and paid invoices up to the end of the month not on an earlier statement. Job accounts.statements makes drafts on the 1st (Europe/London); staff issue (due date from the account terms), email, mark paid. Written only by the statement functions.';

create index account_statements_account_idx on public.account_statements (garage_id, account_id, period_start desc);
create index account_statements_status_idx on public.account_statements (garage_id, status, due_date);

create trigger account_statements_updated before update on public.account_statements
  for each row execute function public.set_updated_at();

create table public.business_account_invoices (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  invoice_id uuid not null,
  account_id uuid not null,
  po_number text,
  bill_to_name text not null,
  bill_to_email text,
  bill_to_address text,
  statement_id uuid,
  created_at timestamptz not null default now(),
  constraint business_account_invoices_garage_id_id_key unique (garage_id, id),
  constraint business_account_invoices_invoice_key unique (garage_id, invoice_id),
  constraint business_account_invoices_po_check check (po_number is null or char_length(po_number) between 1 and 40),
  constraint business_account_invoices_invoice_fkey foreign key (garage_id, invoice_id)
    references public.invoices (garage_id, id) on delete cascade,
  constraint business_account_invoices_account_fkey foreign key (garage_id, account_id)
    references public.business_accounts (garage_id, id) on delete cascade,
  constraint business_account_invoices_statement_fkey foreign key (garage_id, statement_id)
    references public.account_statements (garage_id, id) on delete set null (statement_id)
);

comment on table public.business_account_invoices is
  'P5.7: an invoice charged to a business account, with the bill-to details and PO number taken when it was linked, and the statement it is on. Written by the link trigger on invoices and the account functions.';

create index business_account_invoices_account_idx on public.business_account_invoices (garage_id, account_id, statement_id);
create index business_account_invoices_statement_idx on public.business_account_invoices (garage_id, statement_id) where statement_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Row level security
-- ---------------------------------------------------------------------------

alter table public.business_accounts enable row level security;
alter table public.business_account_vehicles enable row level security;
alter table public.business_account_customers enable row level security;
alter table public.business_account_bookings enable row level security;
alter table public.account_statements enable row level security;
alter table public.business_account_invoices enable row level security;

-- business_accounts
--   "garage members read business accounts"         select  members of the selected garage (any plan)
--   "owners and managers add business accounts"     insert  owners/managers, garage on Pro (fleet_accounts)
--   "owners and managers change business accounts"  update  owners/managers, garage on Pro (archive = archived_at)
--   (no delete: accounts are archived)
create policy "garage members read business accounts" on public.business_accounts
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add business accounts" on public.business_accounts
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id())
              and (select public.current_garage_role()) in ('owner', 'manager')
              and public.garage_has_feature(garage_id, 'fleet_accounts'));
create policy "owners and managers change business accounts" on public.business_accounts
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (garage_id = (select public.current_garage_id())
              and (select public.current_garage_role()) in ('owner', 'manager')
              and public.garage_has_feature(garage_id, 'fleet_accounts'));

-- business_account_vehicles
--   "garage members read account vehicles"            select  members of the selected garage (any plan)
--   "owners and managers add account vehicles"        insert  owners/managers, garage on Pro
--   "owners and managers remove account vehicles"     delete  owners/managers, garage on Pro
create policy "garage members read account vehicles" on public.business_account_vehicles
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add account vehicles" on public.business_account_vehicles
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id())
              and (select public.current_garage_role()) in ('owner', 'manager')
              and public.garage_has_feature(garage_id, 'fleet_accounts'));
create policy "owners and managers remove account vehicles" on public.business_account_vehicles
  for delete to authenticated
  using (garage_id = (select public.current_garage_id())
         and (select public.current_garage_role()) in ('owner', 'manager')
         and public.garage_has_feature(garage_id, 'fleet_accounts'));

-- business_account_customers
--   "garage members read account people"              select  members of the selected garage (any plan)
--   "owners and managers add account people"          insert  owners/managers, garage on Pro
--   "owners and managers change account people"       update  owners/managers, garage on Pro (role)
--   "owners and managers remove account people"       delete  owners/managers, garage on Pro
create policy "garage members read account people" on public.business_account_customers
  for select to authenticated using (garage_id = (select public.current_garage_id()));
create policy "owners and managers add account people" on public.business_account_customers
  for insert to authenticated
  with check (garage_id = (select public.current_garage_id())
              and (select public.current_garage_role()) in ('owner', 'manager')
              and public.garage_has_feature(garage_id, 'fleet_accounts'));
create policy "owners and managers change account people" on public.business_account_customers
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'))
  with check (garage_id = (select public.current_garage_id())
              and (select public.current_garage_role()) in ('owner', 'manager')
              and public.garage_has_feature(garage_id, 'fleet_accounts'));
create policy "owners and managers remove account people" on public.business_account_customers
  for delete to authenticated
  using (garage_id = (select public.current_garage_id())
         and (select public.current_garage_role()) in ('owner', 'manager')
         and public.garage_has_feature(garage_id, 'fleet_accounts'));

-- business_account_bookings
--   "garage members read account bookings"  select  members of the selected garage (any plan)
--   (writes only through set_booking_account(): any member who books, garage on Pro)
create policy "garage members read account bookings" on public.business_account_bookings
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- account_statements
--   "garage members read account statements"  select  members of the selected garage (any plan)
--   (writes only through the statement functions: owners/managers, garage on Pro; the job as service role)
create policy "garage members read account statements" on public.account_statements
  for select to authenticated using (garage_id = (select public.current_garage_id()));

-- business_account_invoices
--   "garage members read account invoices"  select  members of the selected garage (any plan)
--   (writes only through the invoice link trigger and the account functions)
create policy "garage members read account invoices" on public.business_account_invoices
  for select to authenticated using (garage_id = (select public.current_garage_id()));

revoke all on public.business_accounts, public.business_account_vehicles, public.business_account_customers,
  public.business_account_bookings, public.account_statements, public.business_account_invoices
  from public, anon, authenticated;

grant select on public.business_accounts, public.business_account_vehicles, public.business_account_customers,
  public.business_account_bookings, public.account_statements, public.business_account_invoices
  to authenticated;
grant insert (name, kind, company_number, billing_email, billing_address, contact_name, contact_phone, contact_email,
              payment_terms_days, po_required, discount_percent, credit_limit_pence, billing, notes)
  on public.business_accounts to authenticated;
grant update (name, kind, company_number, billing_email, billing_address, contact_name, contact_phone, contact_email,
              payment_terms_days, po_required, discount_percent, credit_limit_pence, billing, notes, archived_at)
  on public.business_accounts to authenticated;
grant insert (account_id, vehicle_id), delete on public.business_account_vehicles to authenticated;
grant insert (account_id, customer_id, role), update (role), delete on public.business_account_customers to authenticated;

grant select, insert, update, delete on public.business_accounts, public.business_account_vehicles, public.business_account_customers,
  public.business_account_bookings, public.account_statements, public.business_account_invoices
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- Owners and managers of the selected garage (MFA as the invoice functions),
-- garage on Pro. Returns the garage id. Internal.
create function public.require_account_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  scope uuid := public.current_garage_id();
begin
  if not coalesce(public.garage_actor_allowed(), false)
     or public.current_garage_role() is distinct from 'owner' and public.current_garage_role() is distinct from 'manager' then
    raise exception 'ACCOUNT_FORBIDDEN: only owners and managers can change business accounts' using errcode = '42501';
  end if;
  perform public.require_garage_feature(scope, 'fleet_accounts');
  return scope;
end
$$;

-- The bill-to snapshot of an account, for business_account_invoices.
create function public.link_invoice_to_account(p_garage_id uuid, p_invoice_id uuid, p_account_id uuid, p_po_number text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.business_account_invoices as link (
    garage_id, invoice_id, account_id, po_number, bill_to_name, bill_to_email, bill_to_address
  )
  select account.garage_id, p_invoice_id, account.id, p_po_number, account.name, account.billing_email, account.billing_address
  from public.business_accounts account
  where account.garage_id = p_garage_id
    and account.id = p_account_id
  on conflict (garage_id, invoice_id) do update
    set account_id = excluded.account_id,
        po_number = excluded.po_number,
        bill_to_name = excluded.bill_to_name,
        bill_to_email = excluded.bill_to_email,
        bill_to_address = excluded.bill_to_address
    where link.statement_id is null;
end
$$;

-- AFTER INSERT / UPDATE OF booking_id on invoices: an invoice made for an
-- account booking is charged to that account. Additive: it never changes the
-- invoice row. Skipped while the garage is not on Pro.
create function public.link_account_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_booking record;
begin
  if new.booking_id is null or new.status = 'void' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.booking_id is not distinct from old.booking_id then
    return null;
  end if;
  select link.account_id, link.po_number
  into account_booking
  from public.business_account_bookings link
  where link.garage_id = new.garage_id
    and link.booking_id = new.booking_id;
  if not found or not public.garage_has_feature(new.garage_id, 'fleet_accounts') then
    return null;
  end if;
  perform public.link_invoice_to_account(new.garage_id, new.id, account_booking.account_id, account_booking.po_number);
  return null;
end
$$;

create trigger invoices_link_account
  after insert or update of booking_id on public.invoices
  for each row execute function public.link_account_invoice();

-- ---------------------------------------------------------------------------
-- 4. Staff functions
-- ---------------------------------------------------------------------------

-- Adds a car to an account by registration: the garage's car with that
-- registration, or a new one. Owners/managers, Pro.
create function public.add_business_account_vehicle(p_account_id uuid, p_registration text, p_make text default null, p_model text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope uuid := public.require_account_manager();
  reg text := upper(regexp_replace(coalesce(p_registration, ''), '[^A-Za-z0-9]', '', 'g'));
  target_vehicle uuid;
  created boolean := false;
  existing_account uuid;
begin
  if reg !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'INVALID_REGISTRATION' using errcode = '22023';
  end if;
  if not exists (select 1 from public.business_accounts account
                 where account.garage_id = scope and account.id = p_account_id and account.archived_at is null) then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;

  select vehicle.id into target_vehicle
  from public.vehicles vehicle
  where vehicle.garage_id = scope and vehicle.registration = reg;
  if not found then
    insert into public.vehicles (garage_id, registration, make, model)
    values (scope, reg, nullif(left(btrim(coalesce(p_make, '')), 80), ''), nullif(left(btrim(coalesce(p_model, '')), 120), ''))
    returning id into target_vehicle;
    created := true;
  end if;

  select link.account_id into existing_account
  from public.business_account_vehicles link
  where link.garage_id = scope and link.vehicle_id = target_vehicle;
  if found and existing_account <> p_account_id then
    raise exception 'VEHICLE_ON_OTHER_ACCOUNT' using errcode = 'P0001';
  end if;
  if not found then
    insert into public.business_account_vehicles (garage_id, account_id, vehicle_id, added_by)
    values (scope, p_account_id, target_vehicle, auth.uid());
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (scope, auth.uid(), 'account.vehicle_added', 'business_account', p_account_id::text,
            jsonb_build_object('vehicleId', target_vehicle, 'created', created));
  end if;
  return jsonb_build_object('vehicle_id', target_vehicle, 'created', created, 'linked', existing_account is null);
end
$$;

comment on function public.add_business_account_vehicle(uuid, text, text, text) is
  'P5.7: owners/managers (Pro) add a car to a business account by registration (the garage''s car, or a new one). VEHICLE_ON_OTHER_ACCOUNT when another account has it. Audited.';

-- Charges a booking to an account (after create_booking()), with its PO
-- number; null account removes the link. Any member who books (the staff
-- booking path), garage on Pro. The car joins the account when it is on none;
-- the booking's customer becomes one of its drivers; the booking's invoices
-- not yet on a statement follow.
create function public.set_booking_account(p_booking_id uuid, p_account_id uuid, p_po_number text default null)
returns public.business_account_bookings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope uuid := public.current_garage_id();
  booking_row record;
  account_row public.business_accounts%rowtype;
  po text := nullif(btrim(coalesce(p_po_number, '')), '');
  vehicle_account uuid;
  result public.business_account_bookings;
  invoice_row record;
begin
  if not coalesce(public.garage_actor_allowed(), false) then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  perform public.require_garage_feature(scope, 'fleet_accounts');

  select booking.id, booking.vehicle_id, booking.customer_id
  into booking_row
  from public.bookings booking
  where booking.garage_id = scope and booking.id = p_booking_id and booking.deleted_at is null
  for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;

  if p_account_id is null then
    delete from public.business_account_bookings link
    where link.garage_id = scope and link.booking_id = p_booking_id;
    delete from public.business_account_invoices link
    using public.invoices invoice
    where link.garage_id = scope
      and invoice.garage_id = scope
      and invoice.id = link.invoice_id
      and invoice.booking_id = p_booking_id
      and link.statement_id is null;
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (scope, auth.uid(), 'account.booking_unlinked', 'booking', p_booking_id::text, '{}'::jsonb);
    return null;
  end if;

  select * into account_row
  from public.business_accounts account
  where account.garage_id = scope and account.id = p_account_id and account.archived_at is null;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if po is not null and char_length(po) > 40 then
    raise exception 'INVALID_PO_NUMBER' using errcode = '22023';
  end if;
  if account_row.po_required and po is null then
    raise exception 'PO_REQUIRED' using errcode = 'P0001';
  end if;

  select link.account_id into vehicle_account
  from public.business_account_vehicles link
  where link.garage_id = scope and link.vehicle_id = booking_row.vehicle_id;
  if found and vehicle_account <> p_account_id then
    raise exception 'VEHICLE_ON_OTHER_ACCOUNT' using errcode = 'P0001';
  end if;
  if not found then
    insert into public.business_account_vehicles (garage_id, account_id, vehicle_id, added_by)
    values (scope, p_account_id, booking_row.vehicle_id, auth.uid());
  end if;
  insert into public.business_account_customers (garage_id, account_id, customer_id, role, added_by)
  values (scope, p_account_id, booking_row.customer_id, 'driver', auth.uid())
  on conflict (garage_id, account_id, customer_id) do nothing;

  insert into public.business_account_bookings as link (garage_id, booking_id, account_id, po_number, set_by)
  values (scope, p_booking_id, p_account_id, po, auth.uid())
  on conflict (garage_id, booking_id) do update
    set account_id = excluded.account_id, po_number = excluded.po_number, set_by = excluded.set_by
  returning * into result;

  for invoice_row in
    select invoice.id
    from public.invoices invoice
    where invoice.garage_id = scope
      and invoice.booking_id = p_booking_id
      and invoice.status <> 'void'
      and invoice.deleted_at is null
  loop
    perform public.link_invoice_to_account(scope, invoice_row.id, p_account_id, po);
  end loop;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (scope, auth.uid(), 'account.booking_linked', 'booking', p_booking_id::text,
          jsonb_build_object('accountId', p_account_id, 'po', po is not null));
  return result;
end
$$;

comment on function public.set_booking_account(uuid, uuid, text) is
  'P5.7: charge a booking of the selected garage to a business account (null clears it). Any member who books; Pro. PO_REQUIRED, VEHICLE_ON_OTHER_ACCOUNT, ACCOUNT_NOT_FOUND, BOOKING_NOT_FOUND. Never touches create_booking().';

-- Builds (or refreshes) the draft statement of an account for a month: its
-- issued and paid invoices with an issue date up to the month's end that are
-- on no other statement. An issued or paid statement is returned unchanged.
-- Internal (no grants): called by the staff and job functions below.
create function public.build_account_statement(p_garage_id uuid, p_account_id uuid, p_period_start date, p_actor uuid, p_require_invoices boolean)
returns public.account_statements
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_period_start date := date_trunc('month', p_period_start)::date;
  v_period_end date := (date_trunc('month', p_period_start) + interval '1 month' - interval '1 day')::date;
  statement_row public.account_statements%rowtype;
  eligible integer;
  eligible_total numeric;
  prefix text;
  next_number integer;
begin
  if p_period_start is null or p_period_start <> v_period_start then
    raise exception 'INVALID_PERIOD' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('account_statements:' || p_garage_id::text, 0));

  if not exists (select 1 from public.business_accounts account
                 where account.garage_id = p_garage_id and account.id = p_account_id) then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;

  select * into statement_row
  from public.account_statements statement
  where statement.garage_id = p_garage_id and statement.account_id = p_account_id and statement.period_start = v_period_start
  for update;
  if found and statement_row.status <> 'draft' then
    return statement_row;
  end if;
  if found then
    update public.business_account_invoices link
    set statement_id = null
    where link.garage_id = p_garage_id and link.statement_id = statement_row.id;
  end if;

  select count(*)::integer, coalesce(sum(invoice.total_pence), 0)
  into eligible, eligible_total
  from public.business_account_invoices link
  join public.invoices invoice on invoice.garage_id = link.garage_id and invoice.id = link.invoice_id
  where link.garage_id = p_garage_id
    and link.account_id = p_account_id
    and link.statement_id is null
    and invoice.status in ('issued', 'paid')
    and invoice.deleted_at is null
    and invoice.issue_date <= v_period_end;

  if eligible = 0 and statement_row.id is null then
    if p_require_invoices then
      raise exception 'NOTHING_TO_BILL' using errcode = 'P0001';
    end if;
    return null;
  end if;
  if eligible_total > 9007199254740991 then
    raise exception 'STATEMENT_TOTAL_TOO_LARGE' using errcode = '22003';
  end if;

  if statement_row.id is null then
    select garage.booking_prefix into prefix from public.garages garage where garage.id = p_garage_id;
    select count(*)::integer + 1 into next_number
    from public.account_statements statement
    where statement.garage_id = p_garage_id and statement.period_start = v_period_start;
    insert into public.account_statements (garage_id, account_id, reference, period_start, period_end, invoice_count, total_pence, created_by)
    values (p_garage_id, p_account_id,
            coalesce(prefix, 'AF') || '-ST-' || to_char(v_period_start, 'YYYYMM') || '-' || lpad(next_number::text, 3, '0'),
            v_period_start, v_period_end, eligible, eligible_total::bigint, p_actor)
    returning * into statement_row;
  else
    update public.account_statements statement
    set invoice_count = eligible, total_pence = eligible_total::bigint
    where statement.garage_id = p_garage_id and statement.id = statement_row.id
    returning * into statement_row;
  end if;

  update public.business_account_invoices link
  set statement_id = statement_row.id
  from public.invoices invoice
  where link.garage_id = p_garage_id
    and link.account_id = p_account_id
    and link.statement_id is null
    and invoice.garage_id = link.garage_id
    and invoice.id = link.invoice_id
    and invoice.status in ('issued', 'paid')
    and invoice.deleted_at is null
    and invoice.issue_date <= v_period_end;

  return statement_row;
end
$$;

-- Owners/managers make (or refresh) an account's statement for a month now.
create function public.generate_account_statement(p_account_id uuid, p_period_start date)
returns public.account_statements
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope uuid := public.require_account_manager();
  statement_row public.account_statements;
begin
  statement_row := public.build_account_statement(scope, p_account_id, p_period_start, auth.uid(), true);
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (scope, auth.uid(), 'account.statement_generated', 'account_statement', statement_row.id::text,
          jsonb_build_object('accountId', p_account_id, 'period', statement_row.period_start, 'invoices', statement_row.invoice_count));
  return statement_row;
end
$$;

comment on function public.generate_account_statement(uuid, date) is
  'P5.7: owners/managers (Pro) make or refresh the draft statement of an account for the month starting p_period_start. NOTHING_TO_BILL when there is nothing to put on it. Issued statements come back unchanged.';

-- Issues a draft statement (refreshed first): issue date = the garage's
-- today, due date = issue date + the account's payment terms.
create function public.issue_account_statement(p_statement_id uuid)
returns public.account_statements
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope uuid := public.require_account_manager();
  statement_row public.account_statements%rowtype;
  terms integer;
  today date;
begin
  select * into statement_row
  from public.account_statements statement
  where statement.garage_id = scope and statement.id = p_statement_id;
  if not found then
    raise exception 'STATEMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if statement_row.status <> 'draft' then
    raise exception 'STATEMENT_NOT_DRAFT' using errcode = 'P0001';
  end if;
  statement_row := public.build_account_statement(scope, statement_row.account_id, statement_row.period_start, auth.uid(), false);
  if statement_row.invoice_count = 0 then
    raise exception 'NOTHING_TO_BILL' using errcode = 'P0001';
  end if;

  select account.payment_terms_days into terms
  from public.business_accounts account
  where account.garage_id = scope and account.id = statement_row.account_id;
  select (now() at time zone coalesce(garage.timezone, 'Europe/London'))::date into today
  from public.garages garage where garage.id = scope;

  update public.account_statements statement
  set status = 'issued', issue_date = today, due_date = today + coalesce(terms, 30), issued_at = now(), issued_by = auth.uid()
  where statement.garage_id = scope and statement.id = statement_row.id
  returning * into statement_row;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (scope, auth.uid(), 'account.statement_issued', 'account_statement', statement_row.id::text,
          jsonb_build_object('accountId', statement_row.account_id, 'totalPence', statement_row.total_pence));
  return statement_row;
end
$$;

comment on function public.issue_account_statement(uuid) is
  'P5.7: owners/managers (Pro) issue a draft statement after refreshing it; due date from the account''s payment terms. Audited.';

-- Marks an issued statement paid: records the outstanding balance of each of
-- its unpaid invoices through record_invoice_payment() (so the invoices are
-- paid too).
create function public.mark_account_statement_paid(p_statement_id uuid, p_paid_at timestamptz, p_method text, p_reference text default null)
returns public.account_statements
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope uuid := public.require_account_manager();
  statement_row public.account_statements%rowtype;
  method text := lower(btrim(coalesce(p_method, '')));
  v_reference text := nullif(left(btrim(coalesce(p_reference, '')), 120), '');
  invoice_row record;
begin
  if p_paid_at is null then
    raise exception 'PAYMENT_DATE_REQUIRED' using errcode = '22023';
  end if;
  if method not in ('cash', 'card', 'bank_transfer', 'other') then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
  end if;
  select * into statement_row
  from public.account_statements statement
  where statement.garage_id = scope and statement.id = p_statement_id
  for update;
  if not found then
    raise exception 'STATEMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if statement_row.status <> 'issued' then
    raise exception 'STATEMENT_NOT_ISSUED' using errcode = 'P0001';
  end if;

  for invoice_row in
    select invoice.id,
           invoice.total_pence - coalesce((select sum(payment.amount_pence) from public.invoice_payments payment
                                           where payment.garage_id = invoice.garage_id and payment.invoice_id = invoice.id), 0) as outstanding
    from public.business_account_invoices link
    join public.invoices invoice on invoice.garage_id = link.garage_id and invoice.id = link.invoice_id
    where link.garage_id = scope and link.statement_id = statement_row.id and invoice.status = 'issued'
    order by invoice.issue_date, invoice.id
  loop
    if invoice_row.outstanding > 0 then
      perform public.record_invoice_payment(invoice_row.id, invoice_row.outstanding::bigint, p_paid_at, method,
                                            coalesce(v_reference, statement_row.reference));
    end if;
  end loop;

  update public.account_statements statement
  set status = 'paid', paid_at = p_paid_at, payment_method = method, payment_reference = v_reference
  where statement.garage_id = scope and statement.id = statement_row.id
  returning * into statement_row;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (scope, auth.uid(), 'account.statement_paid', 'account_statement', statement_row.id::text,
          jsonb_build_object('accountId', statement_row.account_id, 'method', method));
  return statement_row;
end
$$;

comment on function public.mark_account_statement_paid(uuid, timestamptz, text, text) is
  'P5.7: owners/managers (Pro) mark an issued statement paid; each unpaid invoice on it gets a payment for its balance (record_invoice_payment). Audited.';

-- Records the outcome of emailing an issued statement (the app sends it
-- through the email channel first).
create function public.record_account_statement_email(p_statement_id uuid, p_recipient text, p_outcome text, p_provider_id text default null)
returns public.account_statements
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope uuid := public.require_account_manager();
  statement_row public.account_statements%rowtype;
  recipient text := lower(btrim(coalesce(p_recipient, '')));
begin
  if p_outcome not in ('sent', 'failed') then
    raise exception 'INVALID_OUTCOME' using errcode = '22023';
  end if;
  if recipient !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(recipient) > 254 then
    raise exception 'INVALID_RECIPIENT' using errcode = '22023';
  end if;
  update public.account_statements statement
  set emailed_at = now(), emailed_to = recipient, email_status = p_outcome,
      email_provider_id = nullif(left(btrim(coalesce(p_provider_id, '')), 200), ''),
      email_count = statement.email_count + case when p_outcome = 'sent' then 1 else 0 end
  where statement.garage_id = scope and statement.id = p_statement_id and statement.status in ('issued', 'paid')
  returning * into statement_row;
  if not found then
    raise exception 'STATEMENT_NOT_ISSUED' using errcode = 'P0001';
  end if;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (scope, auth.uid(), 'account.statement_emailed', 'account_statement', statement_row.id::text,
          jsonb_build_object('outcome', p_outcome));
  return statement_row;
end
$$;

comment on function public.record_account_statement_email(uuid, text, text, text) is
  'P5.7: owners/managers (Pro) record that an issued statement was emailed (or failed). Audited (outcome only).';

-- ---------------------------------------------------------------------------
-- 5. Job: accounts.statements (service role)
-- ---------------------------------------------------------------------------

-- The draft statements of a garage's monthly-billed accounts for one month.
-- Idempotent per account and month (an existing draft is refreshed, an issued
-- one left alone); accounts with nothing to bill get none. 0 for a garage not
-- on Pro.
create function public.generate_monthly_account_statements(p_garage_id uuid, p_period_start date)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account_row record;
  statement_row public.account_statements;
  made integer := 0;
begin
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'INVALID_PERIOD' using errcode = '22023';
  end if;
  if not public.garage_has_feature(p_garage_id, 'fleet_accounts') then
    return 0;
  end if;
  for account_row in
    select account.id
    from public.business_accounts account
    where account.garage_id = p_garage_id and account.billing = 'monthly' and account.archived_at is null
    order by account.created_at, account.id
  loop
    statement_row := public.build_account_statement(p_garage_id, account_row.id, p_period_start, null, false);
    if statement_row.id is not null then
      made := made + 1;
    end if;
  end loop;
  return made;
end
$$;

comment on function public.generate_monthly_account_statements(uuid, date) is
  'P5.7 job accounts.statements: draft statements for the garage''s monthly-billed, active accounts for the month starting p_period_start (the month before, on the 1st in Europe/London). Idempotent per account and month. Service role only.';

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.require_account_manager() from public, anon, authenticated, service_role;
revoke all on function public.link_invoice_to_account(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.link_account_invoice() from public, anon, authenticated, service_role;
revoke all on function public.build_account_statement(uuid, uuid, date, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.add_business_account_vehicle(uuid, text, text, text) from public, anon;
revoke all on function public.set_booking_account(uuid, uuid, text) from public, anon;
revoke all on function public.generate_account_statement(uuid, date) from public, anon;
revoke all on function public.issue_account_statement(uuid) from public, anon;
revoke all on function public.mark_account_statement_paid(uuid, timestamptz, text, text) from public, anon;
revoke all on function public.record_account_statement_email(uuid, text, text, text) from public, anon;
revoke all on function public.generate_monthly_account_statements(uuid, date) from public, anon, authenticated;

grant execute on function public.add_business_account_vehicle(uuid, text, text, text) to authenticated;
grant execute on function public.set_booking_account(uuid, uuid, text) to authenticated;
grant execute on function public.generate_account_statement(uuid, date) to authenticated;
grant execute on function public.issue_account_statement(uuid) to authenticated;
grant execute on function public.mark_account_statement_paid(uuid, timestamptz, text, text) to authenticated;
grant execute on function public.record_account_statement_email(uuid, text, text, text) to authenticated;
grant execute on function public.generate_monthly_account_statements(uuid, date) to service_role;
