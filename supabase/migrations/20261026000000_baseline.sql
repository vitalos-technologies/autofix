-- Autofix baseline: SOB Autofix's schema, squashed.
--
-- This file replaces the 30 SOB Autofix migrations (202608080001_initial_schema
-- through 202610100001_show_recently_sold_vehicles) as they stood at commit
-- 35496ff. The SOB history stays in git; a new Autofix database starts here.
--
-- What it contains: SOB's final public schema (types, tables, constraints,
-- indexes, triggers, functions, row-level security and policies), the explicit
-- grants and revokes SOB's migrations made, the storage buckets and storage
-- policies, and the platform MFA policy row.
--
-- What it leaves out (SOB-only surfaces removed in P1.1): content_entries,
-- content_revisions, navigation_items, sale_vehicles, sale_vehicle_images,
-- import_article_drafts(), the content_kind, publication_status and
-- sale_vehicle_status enums, the vehicle-sales bucket and its policies, and the
-- inventory/news branches of manage_admin_trash(). SOB business rows (site
-- settings, the seeded service catalogue, audit history) are not carried over.
--
-- SOB's single-business rules (is_admin(), the admin email allowlist, SOB
-- issuer defaults and SOB- reference formats) are still here on purpose: they
-- are replaced by the garage tenancy model in 20261026000100_tenancy.sql.
--
-- Like SOB's migrations, this file grants only what SOB granted explicitly and
-- otherwise relies on the environment's default privileges. The tenancy
-- migration makes every grant explicit.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.booking_status as enum ('pending', 'confirmed', 'rescheduled', 'cancelled', 'completed');
create type public.enquiry_type as enum ('repair', 'diagnostic', 'mobile', 'inspection', 'fleet', 'recovery', 'vehicle_sales', 'general');
create type public.enquiry_status as enum ('new', 'contacted', 'booked', 'closed');
create type public.notification_status as enum ('pending', 'sent', 'failed');
create type public.invoice_status as enum ('draft', 'issued', 'paid', 'void');

-- ---------------------------------------------------------------------------
-- Shared trigger function
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Administrators, MFA and audit
-- ---------------------------------------------------------------------------

create table public.admin_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.admin_mfa_policy (
  singleton boolean primary key default true,
  mandatory_mfa_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint admin_mfa_policy_singleton_check check (singleton)
);

comment on table public.admin_mfa_policy is
  'Server-only rollout switch. Enable mandatory MFA only after the sole administrator has verified TOTP and saved recovery codes.';

create table public.admin_mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  set_id uuid not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  revoked_at timestamptz,
  constraint admin_mfa_recovery_codes_code_hash_check check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint admin_mfa_recovery_codes_check check (used_at is null or used_at >= created_at),
  constraint admin_mfa_recovery_codes_check1 check (revoked_at is null or revoked_at >= created_at),
  constraint admin_mfa_recovery_codes_user_id_code_hash_key unique (user_id, code_hash)
);

comment on table public.admin_mfa_recovery_codes is
  'Server-only hashes of high-entropy, single-use administrator MFA recovery codes. Plaintext codes are never persisted.';

create table public.admin_mfa_recovery_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recovery_code_id uuid not null unique references public.admin_mfa_recovery_codes(id) on delete cascade,
  token_hash text not null unique,
  old_factor_ids uuid[] not null,
  new_factor_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz,
  completed_at timestamptz,
  revoked_at timestamptz,
  constraint admin_mfa_recovery_sessions_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint admin_mfa_recovery_sessions_old_factor_ids_check check (cardinality(old_factor_ids) > 0),
  constraint admin_mfa_recovery_sessions_check check (expires_at > created_at),
  constraint admin_mfa_recovery_sessions_check1 check (completed_at is null or (verified_at is not null and new_factor_id is not null))
);

comment on table public.admin_mfa_recovery_sessions is
  'Short-lived server-only capabilities limited to replacing a lost verified TOTP factor.';

create table public.admin_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  device_label text not null,
  user_agent_summary text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint admin_trusted_devices_token_hash_check check (length(token_hash) = 64),
  constraint admin_trusted_devices_device_label_check check (char_length(device_label) between 1 and 160),
  constraint admin_trusted_devices_expiry check (expires_at > created_at)
);

comment on table public.admin_trusted_devices is
  'Server-only, hashed browser credentials that may suppress the ordinary admin TOTP prompt for seven days. They never confer Supabase AAL2.';

create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.site_settings (
  id boolean primary key default true,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint site_settings_id_check check (id)
);

-- ---------------------------------------------------------------------------
-- Abuse limits and webhook idempotency
-- ---------------------------------------------------------------------------

create table public.rate_limit_buckets (
  identifier_hash text not null,
  scope text not null,
  request_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  constraint rate_limit_buckets_pkey primary key (identifier_hash, scope)
);

create table public.resend_webhook_events (
  svix_id text primary key,
  event_type text not null,
  provider_email_id text,
  processing_status text not null default 'processing',
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint resend_webhook_events_processing_status_check
    check (processing_status in ('processing', 'processed', 'ignored', 'failed'))
);

create table public.inbound_email_events (
  transport text not null,
  event_id text not null,
  raw_digest text not null,
  processing_status text not null default 'processing',
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint inbound_email_events_pkey primary key (transport, event_id),
  constraint inbound_email_events_transport_check check (transport = 'cloudflare'),
  constraint inbound_email_events_raw_digest_check check (raw_digest ~ '^[a-f0-9]{64}$'),
  constraint inbound_email_events_processing_status_check
    check (processing_status in ('processing', 'processed', 'ignored', 'failed'))
);

create table public.provider_webhook_events (
  event_key text not null,
  event_type text not null,
  processed_at timestamptz not null default now(),
  provider text not null default 'calcom',
  provider_booking_uid text,
  occurred_at timestamptz,
  outcome text not null default 'processed',
  constraint provider_webhook_events_pkey primary key (event_key)
);

-- ---------------------------------------------------------------------------
-- Customers and vehicles
-- ---------------------------------------------------------------------------

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text not null,
  preferred_contact text not null,
  anonymised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_preferred_contact_check check (preferred_contact in ('phone', 'whatsapp', 'email'))
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  registration text,
  make text,
  model text,
  derivative text,
  year integer,
  colour text,
  fuel_type text,
  transmission text,
  engine_capacity_cc integer,
  body_type text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Service catalogue and bookings
-- ---------------------------------------------------------------------------

create table public.service_catalogue_systems (
  id uuid primary key default gen_random_uuid(),
  system_key text not null unique,
  display_name text not null,
  description text not null default '',
  sort_order integer not null default 0,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_catalogue_systems_system_key_check check (system_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint service_catalogue_systems_display_name_check check (char_length(trim(display_name)) between 2 and 120),
  constraint service_catalogue_systems_description_check check (char_length(description) <= 600)
);

create table public.booking_service_types (
  id uuid primary key default gen_random_uuid(),
  service_key text not null unique,
  display_name text not null,
  description text not null default '',
  provider text not null default 'calcom',
  provider_event_type_id bigint,
  online_booking_enabled boolean not null default false,
  location_mode text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  system_id uuid references public.service_catalogue_systems(id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint booking_service_types_service_key_check check (service_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint booking_service_types_location_mode_check check (location_mode in ('workshop', 'mobile', 'both')),
  constraint booking_service_types_provider_event_type_id_check check (provider_event_type_id is null or provider_event_type_id > 0),
  constraint booking_service_types_check check (not online_booking_enabled or provider_event_type_id is not null),
  constraint booking_service_types_online_provider_check
    check (not online_booking_enabled or (provider = 'calcom' and provider_event_type_id is not null))
);

-- The bookings.booking_reference default needs this before the table exists.
create function public.generate_booking_reference()
returns text
language plpgsql
set search_path = public
as $$
declare
  candidate text;
begin
  -- Serialize the short reference allocation window so the existence check and
  -- the following INSERT cannot race another generated booking reference.
  perform pg_advisory_xact_lock(hashtextextended('public.bookings.booking_reference', 0));

  loop
    candidate := 'SOB-' || lpad((floor(random() * 1000000))::integer::text, 6, '0');
    exit when not exists (select 1 from public.bookings where booking_reference = candidate);
  end loop;
  return candidate;
end;
$$;

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_reference text not null unique default public.generate_booking_reference(),
  customer_id uuid not null references public.customers(id),
  vehicle_id uuid not null references public.vehicles(id),
  status public.booking_status not null default 'pending',
  service_name text not null,
  appointment_start timestamptz not null,
  appointment_end timestamptz,
  original_appointment_start timestamptz not null,
  timezone text not null default 'Europe/London',
  location text,
  notes text,
  provider_legacy_event_uri text,
  provider_legacy_attendee_uri text,
  provider_legacy_event_type_uri text,
  provider_legacy_cancel_url text,
  provider_legacy_reschedule_url text,
  cancellation_reason text,
  last_modified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  service_type_id uuid references public.booking_service_types(id),
  idempotency_key uuid,
  provider text not null default 'calcom',
  provider_booking_uid text,
  provider_event_type_id bigint,
  provider_sync_state text not null default 'pending',
  provider_event_updated_at timestamptz,
  provider_error_code text,
  service_key text,
  problem_description text,
  symptoms jsonb not null default '[]'::jsonb,
  conditional_answers jsonb not null default '{}'::jsonb,
  location_mode text,
  service_address text,
  service_postcode text,
  original_appointment_end timestamptz,
  cancelled_at timestamptz,
  admin_seen_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint bookings_booking_reference_check check (booking_reference ~ '^SOB-[0-9]{6}$'),
  constraint bookings_location_mode_check check (location_mode is null or location_mode in ('workshop', 'mobile')),
  constraint bookings_provider_sync_state_check check (provider_sync_state in ('pending', 'synced', 'failed'))
);

comment on column public.bookings.admin_seen_at is
  'When an administrator first opened this booking in the CMS; null means the new booking still needs review.';

create table public.booking_audit_log (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  action text not null,
  actor_type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint booking_audit_log_actor_type_check check (actor_type in ('customer', 'provider', 'admin', 'system'))
);

create table public.booking_notification_events (
  notification_key text primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  notification_type text not null,
  status text not null default 'pending',
  last_error_code text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint booking_notification_events_notification_type_check
    check (notification_type in ('confirmed', 'rescheduled', 'cancelled')),
  constraint booking_notification_events_status_check check (status in ('pending', 'sent', 'failed'))
);

-- ---------------------------------------------------------------------------
-- Enquiries and email threads
-- ---------------------------------------------------------------------------

create table public.enquiries (
  id uuid primary key default gen_random_uuid(),
  type public.enquiry_type not null,
  customer_id uuid not null references public.customers(id),
  vehicle_id uuid references public.vehicles(id),
  service_slug text,
  description text,
  location_postcode text,
  driveable boolean,
  status public.enquiry_status not null default 'new',
  notification_status public.notification_status not null default 'pending',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  booking_id uuid references public.bookings(id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null
);

comment on column public.enquiries.booking_id is
  'Booking that originated this admin-created enquiry email thread.';

create table public.enquiry_messages (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  direction text not null,
  message_type text not null,
  sender_name text,
  sender_email text,
  recipient_email text,
  subject text not null,
  text_body text not null,
  provider text,
  provider_email_id text,
  message_id text,
  in_reply_to text,
  reference_ids text[] not null default '{}'::text[],
  delivery_status text not null default 'received',
  is_read boolean not null default true,
  client_request_id uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint enquiry_messages_direction_check check (direction in ('inbound', 'outbound', 'internal')),
  constraint enquiry_messages_message_type_check
    check (message_type in ('website_enquiry', 'email', 'internal_note', 'automatic_confirmation')),
  constraint enquiry_messages_subject_check check (char_length(subject) between 3 and 180),
  constraint enquiry_messages_text_body_check check (char_length(text_body) between 1 and 50000),
  constraint enquiry_messages_provider_check check (provider is null or provider in ('resend', 'cloudflare')),
  constraint enquiry_messages_delivery_status_check
    check (delivery_status in ('sending', 'sent', 'delivered', 'failed', 'bounced', 'received', 'note'))
);

create table public.enquiry_attachments (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  object_path text not null unique,
  file_name text not null,
  content_type text not null,
  size_bytes integer not null,
  finalised boolean not null default false,
  created_at timestamptz not null default now(),
  enquiry_message_id uuid references public.enquiry_messages(id) on delete set null,
  constraint enquiry_attachments_content_type_check check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint enquiry_attachments_size_bytes_check check (size_bytes > 0 and size_bytes <= 8388608)
);

create table public.enquiry_conversations (
  enquiry_id uuid primary key references public.enquiries(id) on delete cascade,
  reply_token uuid not null unique default gen_random_uuid(),
  subject text not null,
  unread_count integer not null default 0,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint enquiry_conversations_subject_check check (char_length(subject) between 3 and 180),
  constraint enquiry_conversations_unread_count_check check (unread_count >= 0)
);

create table public.notification_attempts (
  id bigint generated always as identity primary key,
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  recipient_type text not null,
  status public.notification_status not null default 'pending',
  provider_id text,
  error_code text,
  attempted_at timestamptz not null default now(),
  constraint notification_attempts_recipient_type_check check (recipient_type in ('business', 'customer'))
);

create table public.unmatched_inbound_emails (
  id uuid primary key default gen_random_uuid(),
  provider_email_id text not null unique,
  message_id text,
  sender_email text not null,
  recipient_emails text[] not null default '{}'::text[],
  subject text not null,
  text_body text not null,
  in_reply_to text,
  reference_ids text[] not null default '{}'::text[],
  reason text not null,
  linked_enquiry_id uuid references public.enquiries(id) on delete set null,
  created_at timestamptz not null default now(),
  linked_at timestamptz,
  provider text not null default 'resend',
  ignored_at timestamptz,
  ignored_by uuid references auth.users(id),
  constraint unmatched_inbound_emails_text_body_check check (char_length(text_body) between 1 and 50000),
  constraint unmatched_inbound_emails_provider_check check (provider in ('resend', 'cloudflare')),
  constraint unmatched_inbound_ignore_coherence
    check ((ignored_at is null and ignored_by is null) or (ignored_at is not null and ignored_by is not null))
);

-- ---------------------------------------------------------------------------
-- Invoicing
-- ---------------------------------------------------------------------------

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text unique,
  invoice_year integer,
  invoice_sequence bigint,
  revision bigint not null default 1,
  replaces_invoice_id uuid references public.invoices(id),
  status public.invoice_status not null default 'draft',
  source_type text not null default 'manual',
  booking_id uuid references public.bookings(id),
  enquiry_id uuid references public.enquiries(id),
  customer_id uuid references public.customers(id),
  vehicle_id uuid references public.vehicles(id),
  currency text not null default 'GBP',
  customer_name text not null,
  customer_email text,
  customer_phone text,
  customer_address text,
  vehicle_registration text,
  vehicle_make text,
  vehicle_model text,
  service_name text,
  appointment_start timestamptz,
  issuer_legal_name text not null default 'SOB Autofix Limited',
  issuer_trading_name text not null default 'SOB Autofix',
  issuer_tagline text not null default 'Professional Diagnostics. Not Guesswork.',
  issuer_address text not null default E'Cumbrae\nStation Road\nNorton\nDoncaster\nDN6 9HF\nUnited Kingdom',
  issuer_email text not null default 'info@sobautofix.com',
  issuer_phone text not null default '07469273483',
  issuer_company_number text not null default '16182532',
  issue_date date,
  due_date date,
  subtotal_pence bigint not null default 0,
  discount_pence bigint not null default 0,
  tax_pence bigint not null default 0,
  total_pence bigint not null default 0,
  notes text,
  payment_terms text,
  issued_at timestamptz,
  paid_at timestamptz,
  payment_method text,
  payment_reference text,
  voided_at timestamptz,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint invoices_invoice_year_invoice_sequence_key unique (invoice_year, invoice_sequence),
  constraint invoices_invoice_year_check check (invoice_year is null or invoice_year between 2020 and 9999),
  constraint invoices_invoice_sequence_check check (invoice_sequence is null or invoice_sequence between 1 and 999999),
  constraint invoices_revision_check check (revision > 0),
  constraint invoices_source_type_check check (source_type in ('booking', 'enquiry', 'manual')),
  constraint invoices_currency_check check (currency = 'GBP'),
  constraint invoices_subtotal_pence_check check (subtotal_pence between 0 and 9007199254740991),
  constraint invoices_discount_pence_check check (discount_pence between 0 and 9007199254740991),
  constraint invoices_tax_pence_check check (tax_pence = 0),
  constraint invoices_total_pence_check check (total_pence between 0 and 9007199254740991),
  constraint invoices_payment_method_check
    check (payment_method is null or payment_method in ('cash', 'card', 'bank_transfer', 'other')),
  constraint invoices_replacement_not_self check (replaces_invoice_id is null or replaces_invoice_id <> id),
  constraint invoices_dates_coherent check (due_date is null or issue_date is null or due_date >= issue_date),
  constraint invoices_discount_valid check (discount_pence <= subtotal_pence),
  constraint invoices_total_coherent check (total_pence = subtotal_pence - discount_pence + tax_pence),
  constraint invoices_numbering_coherence check (
    (status = 'draft' and invoice_number is null and invoice_year is null and invoice_sequence is null)
    or (
      status <> 'draft'
      and invoice_number is not null
      and invoice_year is not null
      and invoice_sequence is not null
      and issue_date is not null
      and invoice_year = extract(year from issue_date)::integer
      and invoice_number = 'SOB-' || invoice_year::text || '-' || lpad(invoice_sequence::text, 6, '0')
    )
  ),
  constraint invoices_lifecycle_metadata check (
    (status = 'draft' and issued_at is null and paid_at is null and payment_method is null and payment_reference is null and voided_at is null)
    or (status = 'issued' and issued_at is not null and paid_at is null and payment_method is null and payment_reference is null and voided_at is null)
    or (status = 'paid' and issued_at is not null and paid_at is not null and payment_method is not null and voided_at is null)
    or (status = 'void' and issued_at is not null and paid_at is null and payment_method is null and payment_reference is null and voided_at is not null)
  ),
  constraint invoices_source_coherence check (
    (source_type = 'manual' and booking_id is null and enquiry_id is null and (vehicle_id is null or customer_id is not null))
    or (source_type = 'booking' and booking_id is not null and enquiry_id is null and customer_id is not null and vehicle_id is not null)
    or (source_type = 'enquiry' and booking_id is null and enquiry_id is not null and customer_id is not null)
  )
);

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity numeric(12,3) not null,
  unit_price_pence bigint not null,
  line_total_pence bigint not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint invoice_items_invoice_id_position_key unique (invoice_id, position),
  constraint invoice_items_description_check check (length(trim(description)) between 1 and 500),
  constraint invoice_items_quantity_check check (quantity > 0),
  constraint invoice_items_unit_price_pence_check check (unit_price_pence between 0 and 9007199254740991),
  constraint invoice_items_line_total_pence_check check (line_total_pence between 0 and 9007199254740991),
  constraint invoice_items_position_check check (position between 0 and 99)
);

create table public.invoice_number_sequences (
  invoice_year integer primary key,
  last_value bigint not null,
  constraint invoice_number_sequences_invoice_year_check check (invoice_year between 2020 and 9999),
  constraint invoice_number_sequences_last_value_check check (last_value between 1 and 999999)
);

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  amount_pence bigint not null,
  paid_at timestamptz not null,
  payment_method text not null,
  payment_reference text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint invoice_payments_amount_pence_check check (amount_pence between 1 and 9007199254740991),
  constraint invoice_payments_payment_method_check check (payment_method in ('cash', 'card', 'bank_transfer', 'other'))
);

-- A logical send represents one deliberate customer-facing send operation.
-- Physical attempts retain every retry while reusing the logical provider key.
create table public.invoice_email_sends (
  id uuid primary key,
  invoice_id uuid not null references public.invoices(id),
  recipient text not null,
  invoice_revision bigint not null,
  document_status public.invoice_status not null,
  document_number text not null,
  payload_sha256 text not null,
  provider_idempotency_key text not null unique,
  status text not null,
  provider_id text,
  last_error_code text,
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint invoice_email_sends_invoice_revision_check check (invoice_revision > 0),
  constraint invoice_email_sends_document_status_check check (document_status in ('issued', 'paid')),
  constraint invoice_email_sends_payload_sha256_check check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint invoice_email_sends_status_check check (status in ('pending', 'sent', 'failed', 'ambiguous')),
  constraint invoice_email_sends_sent_state
    check ((status = 'sent' and sent_at is not null) or (status <> 'sent' and sent_at is null))
);

create table public.invoice_email_attempts (
  id bigint generated always as identity primary key,
  logical_send_id uuid not null references public.invoice_email_sends(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id),
  attempt_number integer not null,
  status text not null,
  claim_token uuid not null unique,
  lease_expires_at timestamptz not null,
  provider_id text,
  error_code text,
  attempted_by uuid not null references auth.users(id),
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint invoice_email_attempts_logical_send_id_attempt_number_key unique (logical_send_id, attempt_number),
  constraint invoice_email_attempts_attempt_number_check check (attempt_number > 0),
  constraint invoice_email_attempts_status_check check (status in ('pending', 'sent', 'failed', 'ambiguous'))
);

-- ---------------------------------------------------------------------------
-- Public site content kept for the platform: media, offers, reviews, prices
-- ---------------------------------------------------------------------------

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'public-media',
  object_path text not null unique,
  alt_text text not null,
  caption text,
  category text,
  published boolean not null default false,
  width integer,
  height integer,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null
);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null,
  active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'google',
  provider_review_id text unique,
  author_name text not null,
  author_uri text,
  rating smallint not null,
  text text not null,
  published_at timestamptz,
  source_uri text not null,
  visible boolean not null default false,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint reviews_rating_check check (rating between 1 and 5)
);

create table public.service_prices (
  service_slug text primary key,
  minimum integer,
  maximum integer,
  label text,
  notes text,
  published boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint service_prices_service_slug_check check (service_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint service_prices_minimum_check check (minimum is null or minimum >= 0),
  constraint service_prices_check check (maximum is null or maximum >= minimum)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index admin_mfa_recovery_codes_active_idx on public.admin_mfa_recovery_codes (user_id, created_at)
  where used_at is null and revoked_at is null;
create index admin_mfa_recovery_sessions_active_idx on public.admin_mfa_recovery_sessions (user_id, expires_at)
  where completed_at is null and revoked_at is null;
create index admin_trusted_devices_user_active_idx on public.admin_trusted_devices (user_id, expires_at)
  where revoked_at is null;

create index service_catalogue_systems_active_sort_idx on public.service_catalogue_systems (sort_order, display_name)
  where deleted_at is null;
create index booking_service_types_catalogue_sort_idx on public.booking_service_types (system_id, sort_order, display_name)
  where deleted_at is null;

create index bookings_active_created_idx on public.bookings (created_at desc) where deleted_at is null;
create index bookings_admin_unseen_idx on public.bookings (created_at desc) where admin_seen_at is null;
create index bookings_appointment_start_idx on public.bookings (appointment_start desc);
create unique index bookings_idempotency_idx on public.bookings (idempotency_key) where idempotency_key is not null;
create unique index bookings_provider_uid_idx on public.bookings (provider, provider_booking_uid)
  where provider_booking_uid is not null;
create index bookings_service_type_idx on public.bookings (service_type_id);
create index bookings_sync_state_idx on public.bookings (provider_sync_state, appointment_start);

create index enquiries_active_created_idx on public.enquiries (created_at desc) where deleted_at is null;
create unique index enquiries_booking_thread_unique on public.enquiries (booking_id) where booking_id is not null;
create index enquiry_attachments_message on public.enquiry_attachments (enquiry_message_id)
  where enquiry_message_id is not null;
create unique index enquiry_messages_client_request_unique on public.enquiry_messages (enquiry_id, client_request_id)
  where client_request_id is not null;
create unique index enquiry_messages_message_id_unique on public.enquiry_messages (message_id) where message_id is not null;
create unique index enquiry_messages_provider_email_id_unique on public.enquiry_messages (provider_email_id)
  where provider_email_id is not null;
create index enquiry_messages_thread_order on public.enquiry_messages (enquiry_id, created_at, id);
create index unmatched_inbound_email_review_queue_idx on public.unmatched_inbound_emails (created_at desc)
  where linked_enquiry_id is null and ignored_at is null;

create index invoices_active_created_idx on public.invoices (created_at desc) where deleted_at is null;
create index invoices_booking_idx on public.invoices (booking_id) where booking_id is not null;
create index invoices_created_at_idx on public.invoices (created_at desc);
create index invoices_enquiry_idx on public.invoices (enquiry_id) where enquiry_id is not null;
create index invoices_registration_search_idx
  on public.invoices (upper(regexp_replace(coalesce(vehicle_registration, ''), '[^A-Za-z0-9]', '', 'g')));
create index invoices_replaces_idx on public.invoices (replaces_invoice_id) where replaces_invoice_id is not null;
create index invoices_status_due_idx on public.invoices (status, due_date);
create index invoice_items_invoice_position_idx on public.invoice_items (invoice_id, position);
create index invoice_payments_created_by_idx on public.invoice_payments (created_by);
create index invoice_payments_invoice_paid_idx on public.invoice_payments (invoice_id, paid_at, created_at);
create index invoice_email_sends_invoice_idx on public.invoice_email_sends (invoice_id, requested_at desc);
create index invoice_email_attempts_invoice_idx on public.invoice_email_attempts (invoice_id, attempted_at desc);
create index invoice_email_attempts_logical_idx on public.invoice_email_attempts (logical_send_id, attempt_number desc);

create index media_assets_active_created_idx on public.media_assets (created_at desc) where deleted_at is null;
create index offers_active_updated_idx on public.offers (updated_at desc) where deleted_at is null;
create index reviews_active_fetched_idx on public.reviews (fetched_at desc) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Authorisation (SOB single-business rule; replaced in the tenancy migration).
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_profiles profile
    join auth.users auth_user on auth_user.id = profile.user_id
    where profile.user_id = auth.uid()
      and lower(coalesce(auth_user.email, '')) in (
        'sobautofix@gmail.com',
        'temitopeagbola@gmail.com'
      )
      and (
        (
          exists (
            select 1
            from auth.mfa_factors factor
            where factor.user_id = auth.uid()
              and factor.status = 'verified'
              and factor.factor_type = 'totp'
          )
          and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
        )
        or (
          not exists (
            select 1
            from auth.mfa_factors factor
            where factor.user_id = auth.uid()
              and factor.status = 'verified'
              and factor.factor_type = 'totp'
          )
          and not coalesce((
            select mandatory_mfa_enabled
            from public.admin_mfa_policy
            where singleton
          ), false)
        )
      )
  );
$$;

create function public.enforce_allowed_admin_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = new.user_id
      and lower(coalesce(auth_user.email, '')) in (
        'sobautofix@gmail.com',
        'temitopeagbola@gmail.com'
      )
  ) then
    raise exception 'Only an authorised SOB Autofix email can be granted administrator access.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- Rate limits and retention.
create function public.consume_rate_limit(identifier_hash text, limit_scope text, request_limit integer, window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  bucket public.rate_limit_buckets;
begin
  insert into public.rate_limit_buckets as buckets (identifier_hash, scope, request_count, window_started_at)
  values (consume_rate_limit.identifier_hash, limit_scope, 1, now())
  on conflict on constraint rate_limit_buckets_pkey do update
  set request_count = case
        when buckets.window_started_at < now() - make_interval(secs => window_seconds) then 1
        else buckets.request_count + 1
      end,
      window_started_at = case
        when buckets.window_started_at < now() - make_interval(secs => window_seconds) then now()
        else buckets.window_started_at
      end
  returning * into bucket;
  return bucket.request_count <= request_limit;
end;
$$;

create function public.apply_enquiry_retention()
returns integer
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  affected integer;
begin
  delete from storage.objects
  where bucket_id = 'enquiry-attachments'
    and name in (
      select ea.object_path
      from public.enquiry_attachments ea
      join public.enquiries e on e.id = ea.enquiry_id
      where e.status = 'closed' and e.closed_at < now() - interval '12 months'
    );

  delete from public.enquiry_attachments
  where enquiry_id in (
    select id from public.enquiries
    where status = 'closed' and closed_at < now() - interval '12 months'
  );

  update public.customers c
  set name = 'Anonymised', email = null, phone = 'REDACTED', anonymised_at = now()
  where anonymised_at is null
    and not exists (
      select 1 from public.enquiries e
      where e.customer_id = c.id
        and (e.status <> 'closed' or e.closed_at >= now() - interval '12 months')
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Bookings and enquiry threads.
create function public.create_booking_intent(p_idempotency_key uuid, p_customer_name text, p_customer_email text, p_customer_phone text, p_registration text, p_vehicle_make text, p_vehicle_model text, p_vehicle_year integer, p_vehicle_colour text, p_vehicle_fuel_type text, p_vehicle_transmission text, p_service_type_id uuid, p_service_key text, p_service_name text, p_problem_description text, p_symptoms jsonb, p_conditional_answers jsonb, p_location_mode text, p_location text, p_service_address text, p_service_postcode text, p_appointment_start timestamptz, p_timezone text)
returns table (booking_id uuid, booking_reference text, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_booking public.bookings%rowtype;
  new_customer_id uuid;
  new_vehicle_id uuid;
  new_booking public.bookings%rowtype;
begin
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into existing_booking from public.bookings where idempotency_key = p_idempotency_key;
  if found then
    return query select existing_booking.id, existing_booking.booking_reference, false;
    return;
  end if;

  insert into public.customers (name, email, phone, preferred_contact)
  values (trim(p_customer_name), lower(trim(p_customer_email)), trim(p_customer_phone), 'email')
  returning id into new_customer_id;

  insert into public.vehicles (customer_id, registration, make, model, year, colour, fuel_type, transmission)
  values (
    new_customer_id,
    upper(regexp_replace(p_registration, '[^A-Za-z0-9]', '', 'g')),
    nullif(trim(p_vehicle_make), ''),
    nullif(trim(p_vehicle_model), ''),
    p_vehicle_year,
    nullif(trim(p_vehicle_colour), ''),
    nullif(trim(p_vehicle_fuel_type), ''),
    nullif(trim(p_vehicle_transmission), '')
  )
  returning id into new_vehicle_id;

  insert into public.bookings (
    customer_id,
    vehicle_id,
    service_type_id,
    idempotency_key,
    provider,
    provider_event_type_id,
    provider_sync_state,
    status,
    service_key,
    service_name,
    problem_description,
    symptoms,
    conditional_answers,
    location_mode,
    location,
    service_address,
    service_postcode,
    appointment_start,
    original_appointment_start,
    timezone
  )
  select
    new_customer_id,
    new_vehicle_id,
    p_service_type_id,
    p_idempotency_key,
    service.provider,
    service.provider_event_type_id,
    'pending',
    'pending',
    service.service_key,
    service.display_name,
    p_problem_description,
    coalesce(p_symptoms, '[]'::jsonb),
    coalesce(p_conditional_answers, '{}'::jsonb),
    p_location_mode,
    p_location,
    nullif(trim(p_service_address), ''),
    nullif(trim(p_service_postcode), ''),
    p_appointment_start,
    p_appointment_start,
    p_timezone
  from public.booking_service_types service
  where service.id = p_service_type_id
    and service.service_key = p_service_key
    and service.display_name = p_service_name
    and service.online_booking_enabled
    and service.provider_event_type_id is not null
    and (service.location_mode = 'both' or service.location_mode = p_location_mode)
  returning * into new_booking;

  if new_booking.id is null then
    raise exception 'BOOKING_SERVICE_NOT_AVAILABLE';
  end if;

  insert into public.booking_audit_log (booking_id, action, actor_type, detail)
  values (new_booking.id, 'created', 'system', jsonb_build_object('state', 'intent'));

  return query select new_booking.id, new_booking.booking_reference, true;
exception
  when unique_violation then
    select * into existing_booking from public.bookings where idempotency_key = p_idempotency_key;
    if existing_booking.id is null then raise; end if;
    return query select existing_booking.id, existing_booking.booking_reference, false;
end;
$$;

create function public.create_booking_enquiry_thread(target_booking_id uuid, actor_id_value uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  selected_booking record;
  selected_enquiry_id uuid;
  was_created boolean := false;
  initial_message text;
begin
  select
    booking.id,
    booking.booking_reference,
    booking.customer_id,
    booking.vehicle_id,
    booking.service_key,
    booking.service_name,
    booking.problem_description,
    booking.notes,
    booking.service_postcode,
    booking.appointment_start
  into selected_booking
  from public.bookings as booking
  where booking.id = target_booking_id;

  if not found then
    raise exception 'Booking not found';
  end if;

  select enquiry.id
  into selected_enquiry_id
  from public.enquiries as enquiry
  where enquiry.booking_id = target_booking_id;

  if selected_enquiry_id is null then
    initial_message := concat_ws(
      E'\n',
      'Booking ' || selected_booking.booking_reference,
      'Service: ' || selected_booking.service_name,
      'Appointment: ' || to_char(selected_booking.appointment_start at time zone 'Europe/London', 'FMDay, FMDD FMMonth YYYY at HH24:MI') || ' (UK time)',
      case
        when nullif(trim(coalesce(selected_booking.problem_description, '')), '') is not null
          then 'Customer description: ' || trim(selected_booking.problem_description)
      end,
      case
        when nullif(trim(coalesce(selected_booking.notes, '')), '') is not null
          then 'Booking notes: ' || trim(selected_booking.notes)
      end
    );

    begin
      insert into public.enquiries (
        type,
        customer_id,
        vehicle_id,
        booking_id,
        service_slug,
        description,
        location_postcode,
        status,
        notification_status
      )
      values (
        'general',
        selected_booking.customer_id,
        selected_booking.vehicle_id,
        target_booking_id,
        selected_booking.service_key,
        initial_message,
        selected_booking.service_postcode,
        'booked',
        'sent'
      )
      returning id into selected_enquiry_id;
      was_created := true;
    exception
      when unique_violation then
        select enquiry.id
        into selected_enquiry_id
        from public.enquiries as enquiry
        where enquiry.booking_id = target_booking_id;
    end;
  end if;

  if selected_enquiry_id is null then
    raise exception 'Booking enquiry thread could not be created';
  end if;

  insert into public.enquiry_conversations (enquiry_id, subject)
  values (
    selected_enquiry_id,
    left('Your SOB Autofix booking ' || selected_booking.booking_reference, 180)
  )
  on conflict (enquiry_id) do nothing;

  if was_created then
    insert into public.admin_audit_log (
      actor_id,
      action,
      entity_type,
      entity_id,
      detail
    )
    values (
      actor_id_value,
      'booking.enquiry_thread_created',
      'enquiry',
      selected_enquiry_id,
      jsonb_build_object(
        'bookingId', target_booking_id,
        'bookingReference', selected_booking.booking_reference
      )
    );
  end if;

  return selected_enquiry_id;
end;
$$;

create function public.increment_enquiry_unread(target_enquiry_id uuid, activity_at timestamptz)
returns void
language sql
security definer
set search_path = public
as $$
  update public.enquiry_conversations
  set unread_count = unread_count + 1,
      last_activity_at = greatest(last_activity_at, activity_at)
  where enquiry_id = target_enquiry_id;
$$;

-- Inbound email.
create function public.claim_inbound_email_event(transport_name text, transport_event_id text, mime_digest text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_rows integer;
begin
  if transport_name <> 'cloudflare' or mime_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid inbound email event';
  end if;

  insert into public.inbound_email_events (transport, event_id, raw_digest)
  values (transport_name, transport_event_id, mime_digest)
  on conflict (transport, event_id) do update
  set processing_status = 'processing',
      raw_digest = excluded.raw_digest,
      error_code = null,
      received_at = now(),
      processed_at = null
  where public.inbound_email_events.processing_status = 'failed'
     or (
       public.inbound_email_events.processing_status = 'processing'
       and public.inbound_email_events.received_at < now() - interval '15 minutes'
     );

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create function public.finish_inbound_email_event(transport_name text, transport_event_id text, final_status text, final_error_code text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if final_status not in ('processed', 'ignored', 'failed') then
    raise exception 'Invalid inbound email event status';
  end if;

  update public.inbound_email_events
  set processing_status = final_status,
      error_code = final_error_code,
      processed_at = now()
  where transport = transport_name
    and event_id = transport_event_id;
end;
$$;

create function public.store_inbound_email_message(target_enquiry_id uuid, transport_name text, transport_event_id text, sender_name_value text, sender_email_value text, recipient_email_value text, subject_value text, text_body_value text, rfc_message_id text, reply_to_message_id text, reference_id_values text[], message_created_at timestamptz, match_reason text)
returns table (stored_message_id uuid, was_inserted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_message_id uuid;
begin
  if transport_name not in ('resend', 'cloudflare') then
    raise exception 'Invalid inbound email transport';
  end if;

  insert into public.enquiry_messages (
    enquiry_id,
    direction,
    message_type,
    sender_name,
    sender_email,
    recipient_email,
    subject,
    text_body,
    provider,
    provider_email_id,
    message_id,
    in_reply_to,
    reference_ids,
    delivery_status,
    is_read,
    created_at
  ) values (
    target_enquiry_id,
    'inbound',
    'email',
    sender_name_value,
    sender_email_value,
    recipient_email_value,
    subject_value,
    text_body_value,
    transport_name,
    transport_event_id,
    rfc_message_id,
    reply_to_message_id,
    coalesce(reference_id_values, '{}'),
    'received',
    false,
    message_created_at
  )
  on conflict do nothing
  returning id into new_message_id;

  if new_message_id is null then
    select id into new_message_id
    from public.enquiry_messages
    where provider_email_id = transport_event_id
       or (rfc_message_id is not null and message_id = rfc_message_id)
    order by created_at
    limit 1;

    return query select new_message_id, false;
    return;
  end if;

  update public.enquiry_conversations
  set unread_count = unread_count + 1,
      last_activity_at = greatest(last_activity_at, message_created_at)
  where enquiry_id = target_enquiry_id;

  update public.enquiries
  set status = 'contacted'
  where id = target_enquiry_id
    and status <> 'closed';

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    null,
    'enquiry.reply_received',
    'enquiry_message',
    new_message_id::text,
    jsonb_build_object('enquiryId', target_enquiry_id, 'match', match_reason, 'transport', transport_name)
  );

  return query select new_message_id, true;
end;
$$;

-- Administrator MFA recovery.
create function public.replace_admin_mfa_recovery_codes(p_user_id uuid, p_code_hashes text[], p_event_action text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  l_set_id uuid := gen_random_uuid();
  l_inserted integer;
  l_revoked_devices integer;
begin
  if p_event_action not in ('mfa_recovery_codes_created', 'mfa_recovery_codes_regenerated') then
    raise exception 'INVALID_RECOVERY_CODE_EVENT';
  end if;
  if cardinality(p_code_hashes) <> 10
     or (select count(distinct value) from unnest(p_code_hashes) as hashes(value)) <> 10
     or exists (select 1 from unnest(p_code_hashes) as hashes(value) where value !~ '^[0-9a-f]{64}$') then
    raise exception 'INVALID_RECOVERY_CODE_SET';
  end if;
  if not exists (select 1 from public.admin_profiles where user_id = p_user_id)
     or not exists (select 1 from auth.mfa_factors where user_id = p_user_id and status = 'verified' and factor_type = 'totp') then
    raise exception 'RECOVERY_CODES_REQUIRE_VERIFIED_ADMIN_TOTP';
  end if;

  update public.admin_mfa_recovery_codes
  set revoked_at = now()
  where user_id = p_user_id and used_at is null and revoked_at is null;

  update public.admin_mfa_recovery_sessions
  set revoked_at = now()
  where user_id = p_user_id and completed_at is null and revoked_at is null;

  update public.admin_trusted_devices
  set revoked_at = now()
  where user_id = p_user_id and revoked_at is null;
  get diagnostics l_revoked_devices = row_count;

  insert into public.admin_mfa_recovery_codes (user_id, set_id, code_hash)
  select p_user_id, l_set_id, value
  from unnest(p_code_hashes) with ordinality as hashes(value, position)
  order by position;
  get diagnostics l_inserted = row_count;

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    p_user_id,
    p_event_action,
    'admin_security',
    p_user_id::text,
    jsonb_build_object('count', l_inserted, 'setId', l_set_id)
  );
  if l_revoked_devices > 0 then
    insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
    values (p_user_id, 'trusted_devices_revoked', 'admin_security', p_user_id::text, jsonb_build_object('reason', p_event_action, 'count', l_revoked_devices));
  end if;
  return l_inserted;
end;
$$;

-- One guarded update is the atomic single-use boundary for recovery codes.
create function public.consume_admin_mfa_recovery_code(p_user_id uuid, p_code_hash text, p_session_token_hash text, p_expires_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  l_code_id uuid;
  l_factor_ids uuid[];
  l_revoked_devices integer;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$'
     or p_session_token_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at <= now()
     or p_expires_at > now() + interval '20 minutes' then
    return false;
  end if;
  if not exists (select 1 from public.admin_profiles where user_id = p_user_id) then
    return false;
  end if;

  select array_agg(id order by created_at)
  into l_factor_ids
  from auth.mfa_factors
  where user_id = p_user_id and status = 'verified' and factor_type = 'totp';
  if coalesce(cardinality(l_factor_ids), 0) = 0 then
    return false;
  end if;

  -- One guarded UPDATE is the atomic single-use boundary. Concurrent callers
  -- cannot both satisfy used_at/revoked_at IS NULL for the same row.
  update public.admin_mfa_recovery_codes
  set used_at = now()
  where user_id = p_user_id
    and code_hash = p_code_hash
    and used_at is null
    and revoked_at is null
  returning id into l_code_id;
  if l_code_id is null then
    return false;
  end if;

  update public.admin_mfa_recovery_sessions
  set revoked_at = now()
  where user_id = p_user_id and completed_at is null and revoked_at is null;

  update public.admin_trusted_devices
  set revoked_at = now()
  where user_id = p_user_id and revoked_at is null;
  get diagnostics l_revoked_devices = row_count;

  insert into public.admin_mfa_recovery_sessions (
    user_id, recovery_code_id, token_hash, old_factor_ids, expires_at
  ) values (
    p_user_id, l_code_id, p_session_token_hash, l_factor_ids, p_expires_at
  );

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (p_user_id, 'mfa_recovery_code_used', 'admin_security', p_user_id::text, jsonb_build_object('recoveryCodeId', l_code_id));
  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (p_user_id, 'trusted_devices_revoked', 'admin_security', p_user_id::text, jsonb_build_object('reason', 'mfa_recovery_code_used', 'count', l_revoked_devices));
  return true;
end;
$$;

-- Invoicing: helpers and triggers.
create function public.invoice_line_total(p_quantity numeric, p_unit_price_pence bigint)
returns bigint
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  calculated numeric;
begin
  calculated := round(p_quantity * p_unit_price_pence);
  if calculated < 0 or calculated > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  return calculated::bigint;
end
$$;

create function public.require_invoice_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if auth.role() is distinct from 'authenticated'
     or actor_id is null
     or not public.is_admin() then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  return actor_id;
end
$$;

create function public.prepare_invoice_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_id uuid;
  parent_status public.invoice_status;
begin
  if tg_op = 'UPDATE' and new.invoice_id is distinct from old.invoice_id then
    raise exception 'INVOICE_ITEM_PARENT_IS_IMMUTABLE';
  end if;

  if tg_op = 'INSERT' then
    parent_id := new.invoice_id;
  else
    parent_id := old.invoice_id;
  end if;

  select invoice.status
  into parent_status
  from public.invoices invoice
  where invoice.id = parent_id
  for update;

  if not found then
    if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'INVOICE_NOT_FOUND';
  end if;

  if parent_status <> 'draft'::public.invoice_status then
    raise exception 'INVOICE_ITEMS_ARE_IMMUTABLE';
  end if;

  if tg_op <> 'DELETE' then
    new.description := trim(new.description);
    if new.quantity <= 0 or new.quantity <> round(new.quantity, 3) then
      raise exception 'INVALID_ITEM_QUANTITY';
    end if;
    new.line_total_pence := public.invoice_line_total(new.quantity, new.unit_price_pence);
    return new;
  end if;

  return old;
end
$$;

create function public.refresh_invoice_totals()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_id uuid;
  calculated_subtotal numeric;
  current_discount bigint;
begin
  if tg_op = 'INSERT' then
    target_id := new.invoice_id;
  else
    target_id := old.invoice_id;
  end if;

  select coalesce(sum(item.line_total_pence), 0), invoice.discount_pence
  into calculated_subtotal, current_discount
  from public.invoices invoice
  left join public.invoice_items item on item.invoice_id = invoice.id
  where invoice.id = target_id
    and invoice.status = 'draft'
  group by invoice.discount_pence;

  if not found then
    return null;
  end if;
  if calculated_subtotal > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  if current_discount > calculated_subtotal then
    raise exception 'INVALID_INVOICE_TOTAL';
  end if;

  update public.invoices
  set subtotal_pence = calculated_subtotal::bigint,
      total_pence = calculated_subtotal::bigint - current_discount
  where id = target_id
    and status = 'draft';
  return null;
end
$$;

-- Moving an invoice to or from the trash only changes deleted_at/deleted_by;
-- every other change to issued history is rejected.
create function public.protect_invoice_history()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  calculated_subtotal numeric;
  calculated_item_count integer;
  stored_lines_valid boolean;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft'::public.invoice_status then
      raise exception 'ONLY_DRAFT_INVOICES_CAN_BE_DELETED';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft'::public.invoice_status
       or new.invoice_number is not null
       or new.invoice_year is not null
       or new.invoice_sequence is not null
       or new.issued_at is not null
       or new.paid_at is not null
       or new.payment_method is not null
       or new.payment_reference is not null
       or new.voided_at is not null
       or new.revision <> 1
       or new.subtotal_pence <> 0
       or new.discount_pence <> 0
       or new.tax_pence <> 0
       or new.total_pence <> 0 then
      raise exception 'VALID_DRAFT_INSERT_REQUIRED';
    end if;
    new.customer_name := trim(new.customer_name);
    new.customer_email := nullif(lower(trim(new.customer_email)), '');
    new.customer_phone := nullif(trim(new.customer_phone), '');
    new.customer_address := nullif(trim(new.customer_address), '');
    new.vehicle_registration := nullif(upper(regexp_replace(coalesce(new.vehicle_registration, ''), '[^A-Za-z0-9]', '', 'g')), '');
    new.vehicle_make := nullif(trim(new.vehicle_make), '');
    new.vehicle_model := nullif(trim(new.vehicle_model), '');
    new.service_name := nullif(trim(new.service_name), '');
    new.notes := nullif(trim(new.notes), '');
    new.payment_terms := nullif(trim(new.payment_terms), '');
    return new;
  end if;


  if (
    new.deleted_at is distinct from old.deleted_at
    or new.deleted_by is distinct from old.deleted_by
  ) and (
    to_jsonb(new) - array['deleted_at', 'deleted_by']
  ) is not distinct from (
    to_jsonb(old) - array['deleted_at', 'deleted_by']
  ) then
    if (new.deleted_at is null) is distinct from (new.deleted_by is null) then
      raise exception 'INVALID_INVOICE_TRASH_STATE';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.replaces_invoice_id is distinct from old.replaces_invoice_id
     or new.issuer_legal_name is distinct from old.issuer_legal_name
     or new.issuer_trading_name is distinct from old.issuer_trading_name
     or new.issuer_tagline is distinct from old.issuer_tagline
     or new.issuer_address is distinct from old.issuer_address
     or new.issuer_email is distinct from old.issuer_email
     or new.issuer_phone is distinct from old.issuer_phone
     or new.issuer_company_number is distinct from old.issuer_company_number then
    raise exception 'INVOICE_IDENTITY_IS_IMMUTABLE';
  end if;
  if new.revision is distinct from old.revision then
    raise exception 'INVOICE_REVISION_IS_DATABASE_MANAGED';
  end if;

  if old.status <> new.status
     and not (
       (old.status = 'draft'::public.invoice_status and new.status = 'issued'::public.invoice_status)
       or (old.status = 'issued'::public.invoice_status and new.status in ('paid'::public.invoice_status, 'void'::public.invoice_status))
     ) then
    raise exception 'INVALID_INVOICE_STATUS_TRANSITION';
  end if;

  if old.status <> 'draft'::public.invoice_status then
    if old.status = new.status then
      raise exception 'ISSUED_INVOICE_IS_IMMUTABLE';
    end if;

    if (
      to_jsonb(old) - array['status', 'revision', 'updated_by', 'updated_at', 'paid_at', 'payment_method', 'payment_reference', 'voided_at']
    ) is distinct from (
      to_jsonb(new) - array['status', 'revision', 'updated_by', 'updated_at', 'paid_at', 'payment_method', 'payment_reference', 'voided_at']
    ) then
      raise exception 'ISSUED_INVOICE_IS_IMMUTABLE';
    end if;

    if new.status = 'paid'::public.invoice_status then
      if new.paid_at is null
         or new.payment_method is null
         or new.payment_method not in ('cash', 'card', 'bank_transfer', 'other')
         or new.voided_at is distinct from old.voided_at then
        raise exception 'INVALID_PAID_TRANSITION';
      end if;
    elsif new.status = 'void'::public.invoice_status then
      if new.voided_at is null
         or new.paid_at is distinct from old.paid_at
         or new.payment_method is distinct from old.payment_method
         or new.payment_reference is distinct from old.payment_reference then
        raise exception 'INVALID_VOID_TRANSITION';
      end if;
    end if;
  elsif new.status = 'issued'::public.invoice_status then
    if (
      to_jsonb(old) - array['status', 'revision', 'updated_by', 'updated_at', 'invoice_number', 'invoice_year', 'invoice_sequence', 'issue_date', 'due_date', 'subtotal_pence', 'tax_pence', 'total_pence', 'issued_at']
    ) is distinct from (
      to_jsonb(new) - array['status', 'revision', 'updated_by', 'updated_at', 'invoice_number', 'invoice_year', 'invoice_sequence', 'issue_date', 'due_date', 'subtotal_pence', 'tax_pence', 'total_pence', 'issued_at']
    ) then
      raise exception 'ISSUE_MAY_NOT_REWRITE_INVOICE_HISTORY';
    end if;

    select
      count(*)::integer,
      coalesce(sum(public.invoice_line_total(item.quantity, item.unit_price_pence)), 0),
      coalesce(bool_and(item.line_total_pence = public.invoice_line_total(item.quantity, item.unit_price_pence)), false)
    into calculated_item_count, calculated_subtotal, stored_lines_valid
    from public.invoice_items item
    where item.invoice_id = old.id;

    if calculated_item_count = 0
       or not stored_lines_valid
       or calculated_subtotal > 9007199254740991
       or new.subtotal_pence is distinct from calculated_subtotal::bigint
       or new.discount_pence < 0
       or new.discount_pence > calculated_subtotal
       or new.tax_pence <> 0
       or new.total_pence is distinct from calculated_subtotal::bigint - new.discount_pence then
      raise exception 'INVALID_INVOICE_TOTAL';
    end if;
  else
    new.customer_name := trim(new.customer_name);
    new.customer_email := nullif(lower(trim(new.customer_email)), '');
    new.customer_phone := nullif(trim(new.customer_phone), '');
    new.customer_address := nullif(trim(new.customer_address), '');
    new.vehicle_registration := nullif(upper(regexp_replace(coalesce(new.vehicle_registration, ''), '[^A-Za-z0-9]', '', 'g')), '');
    new.vehicle_make := nullif(trim(new.vehicle_make), '');
    new.vehicle_model := nullif(trim(new.vehicle_model), '');
    new.service_name := nullif(trim(new.service_name), '');
    new.notes := nullif(trim(new.notes), '');
    new.payment_terms := nullif(trim(new.payment_terms), '');
    if new.tax_pence <> 0 then
      raise exception 'VAT_NOT_CONFIGURED';
    end if;
    if new.discount_pence > new.subtotal_pence then
      raise exception 'INVALID_INVOICE_TOTAL';
    end if;
    new.total_pence := new.subtotal_pence - new.discount_pence;
  end if;

  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end
$$;

-- Invoicing: guarded RPCs. Browsers never write invoice tables directly.
create function public.save_invoice_draft(p_invoice_id uuid, p_payload jsonb, p_confirm_duplicate_source boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  target_id uuid;
  existing_invoice public.invoices%rowtype;
  source_kind text := p_payload->>'source_type';
  selected_booking_id uuid;
  selected_enquiry_id uuid;
  selected_customer_id uuid;
  selected_vehicle_id uuid;
  snapshot_customer_name text;
  snapshot_customer_email text;
  snapshot_customer_phone text;
  snapshot_customer_address text := nullif(trim(p_payload->>'customer_address'), '');
  snapshot_registration text;
  snapshot_make text;
  snapshot_model text;
  snapshot_service text;
  snapshot_appointment timestamptz;
  requested_discount_numeric numeric;
  requested_discount bigint;
  requested_tax_numeric numeric;
  requested_issue_date date := nullif(p_payload->>'issue_date', '')::date;
  requested_due_date date := nullif(p_payload->>'due_date', '')::date;
  item jsonb;
  item_count integer := 0;
  item_quantity numeric;
  item_unit_numeric numeric;
  item_unit_price bigint;
  calculated_subtotal numeric;
  source_changed boolean := false;
  duplicate_exists boolean;
  payload_customer_id uuid := nullif(trim(coalesce(p_payload->>'customer_id', '')), '')::uuid;
  payload_vehicle_id uuid := nullif(trim(coalesce(p_payload->>'vehicle_id', '')), '')::uuid;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID_INVOICE_PAYLOAD';
  end if;
  if source_kind not in ('booking', 'enquiry', 'manual') then
    raise exception 'INVALID_SOURCE';
  end if;
  if jsonb_typeof(p_payload->'items') <> 'array'
     or jsonb_array_length(p_payload->'items') = 0
     or jsonb_array_length(p_payload->'items') > 100 then
    raise exception 'INVOICE_ITEM_COUNT_INVALID';
  end if;

  requested_discount_numeric := coalesce(nullif(p_payload->>'discount_pence', ''), '0')::numeric;
  requested_tax_numeric := coalesce(nullif(p_payload->>'tax_pence', ''), '0')::numeric;
  if requested_discount_numeric <> trunc(requested_discount_numeric)
     or requested_discount_numeric < 0
     or requested_discount_numeric > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  if requested_tax_numeric <> 0 then
    raise exception 'VAT_NOT_CONFIGURED';
  end if;
  requested_discount := requested_discount_numeric::bigint;

  if p_invoice_id is not null then
    select invoice.*
    into existing_invoice
    from public.invoices invoice
    where invoice.id = p_invoice_id
      and invoice.status = 'draft'
    for update;
    if not found then
      raise exception 'DRAFT_INVOICE_NOT_FOUND';
    end if;
    target_id := existing_invoice.id;
  end if;

  if source_kind = 'booking' then
    selected_booking_id := nullif(trim(coalesce(p_payload->>'booking_id', '')), '')::uuid;
    if selected_booking_id is null
       or nullif(trim(coalesce(p_payload->>'enquiry_id', '')), '') is not null then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;

    select
      booking.customer_id,
      booking.vehicle_id,
      customer.name,
      customer.email,
      customer.phone,
      vehicle.registration,
      vehicle.make,
      vehicle.model,
      booking.service_name,
      booking.appointment_start
    into
      selected_customer_id,
      selected_vehicle_id,
      snapshot_customer_name,
      snapshot_customer_email,
      snapshot_customer_phone,
      snapshot_registration,
      snapshot_make,
      snapshot_model,
      snapshot_service,
      snapshot_appointment
    from public.bookings booking
    join public.customers customer on customer.id = booking.customer_id
    join public.vehicles vehicle
      on vehicle.id = booking.vehicle_id
     and vehicle.customer_id = booking.customer_id
    where booking.id = selected_booking_id;

    if not found
       or (payload_customer_id is not null and payload_customer_id <> selected_customer_id)
       or (payload_vehicle_id is not null and payload_vehicle_id <> selected_vehicle_id) then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;
  elsif source_kind = 'enquiry' then
    selected_enquiry_id := nullif(trim(coalesce(p_payload->>'enquiry_id', '')), '')::uuid;
    if selected_enquiry_id is null
       or nullif(trim(coalesce(p_payload->>'booking_id', '')), '') is not null then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;

    select
      enquiry.customer_id,
      enquiry.vehicle_id,
      customer.name,
      customer.email,
      customer.phone,
      vehicle.registration,
      vehicle.make,
      vehicle.model,
      replace(coalesce(nullif(trim(enquiry.service_slug), ''), enquiry.type::text), '-', ' '),
      null::timestamptz
    into
      selected_customer_id,
      selected_vehicle_id,
      snapshot_customer_name,
      snapshot_customer_email,
      snapshot_customer_phone,
      snapshot_registration,
      snapshot_make,
      snapshot_model,
      snapshot_service,
      snapshot_appointment
    from public.enquiries enquiry
    join public.customers customer on customer.id = enquiry.customer_id
    left join public.vehicles vehicle
      on vehicle.id = enquiry.vehicle_id
     and vehicle.customer_id = enquiry.customer_id
    where enquiry.id = selected_enquiry_id
      and (enquiry.vehicle_id is null or vehicle.id is not null);

    if not found
       or (payload_customer_id is not null and payload_customer_id <> selected_customer_id)
       or (payload_vehicle_id is not null and payload_vehicle_id is distinct from selected_vehicle_id) then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;
  else
    if nullif(trim(coalesce(p_payload->>'booking_id', '')), '') is not null
       or nullif(trim(coalesce(p_payload->>'enquiry_id', '')), '') is not null then
      raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
    end if;

    selected_customer_id := payload_customer_id;
    selected_vehicle_id := payload_vehicle_id;
    snapshot_customer_name := trim(p_payload->>'customer_name');
    snapshot_customer_email := nullif(lower(trim(p_payload->>'customer_email')), '');
    snapshot_customer_phone := nullif(trim(p_payload->>'customer_phone'), '');
    snapshot_registration := nullif(p_payload->>'vehicle_registration', '');
    snapshot_make := nullif(trim(p_payload->>'vehicle_make'), '');
    snapshot_model := nullif(trim(p_payload->>'vehicle_model'), '');
    snapshot_service := nullif(trim(p_payload->>'service_name'), '');
    snapshot_appointment := nullif(p_payload->>'appointment_start', '')::timestamptz;

    if selected_vehicle_id is not null then
      select vehicle.customer_id, vehicle.registration, vehicle.make, vehicle.model
      into selected_customer_id, snapshot_registration, snapshot_make, snapshot_model
      from public.vehicles vehicle
      where vehicle.id = selected_vehicle_id
        and vehicle.customer_id is not null
        and (payload_customer_id is null or vehicle.customer_id = payload_customer_id);
      if not found then
        raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
      end if;
    end if;

    if selected_customer_id is not null then
      select customer.name, customer.email, customer.phone
      into snapshot_customer_name, snapshot_customer_email, snapshot_customer_phone
      from public.customers customer
      where customer.id = selected_customer_id;
      if not found then
        raise exception 'SOURCE_RELATIONSHIP_MISMATCH';
      end if;
    end if;
  end if;

  if length(trim(coalesce(snapshot_customer_name, ''))) < 2 then
    raise exception 'CUSTOMER_NAME_REQUIRED';
  end if;

  if p_invoice_id is null then
    source_changed := true;
  else
    source_changed := existing_invoice.source_type is distinct from source_kind
      or existing_invoice.booking_id is distinct from selected_booking_id
      or existing_invoice.enquiry_id is distinct from selected_enquiry_id;
  end if;

  if source_changed and source_kind in ('booking', 'enquiry') then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'public.invoices.source:' || source_kind || ':' || coalesce(selected_booking_id, selected_enquiry_id)::text,
        0
      )
    );
    select exists (
      select 1
      from public.invoices invoice
      where invoice.id is distinct from p_invoice_id
        and (
          (source_kind = 'booking' and invoice.booking_id = selected_booking_id)
          or (source_kind = 'enquiry' and invoice.enquiry_id = selected_enquiry_id)
        )
    ) into duplicate_exists;
    if duplicate_exists and coalesce(p_confirm_duplicate_source, false) is not true then
      raise exception 'DUPLICATE_SOURCE_CONFIRMATION_REQUIRED';
    end if;
  end if;

  if p_invoice_id is null then
    insert into public.invoices (
      source_type,
      booking_id,
      enquiry_id,
      customer_id,
      vehicle_id,
      customer_name,
      customer_email,
      customer_phone,
      customer_address,
      vehicle_registration,
      vehicle_make,
      vehicle_model,
      service_name,
      appointment_start,
      issue_date,
      due_date,
      notes,
      payment_terms,
      created_by,
      updated_by
    ) values (
      source_kind,
      selected_booking_id,
      selected_enquiry_id,
      selected_customer_id,
      selected_vehicle_id,
      snapshot_customer_name,
      snapshot_customer_email,
      snapshot_customer_phone,
      snapshot_customer_address,
      snapshot_registration,
      snapshot_make,
      snapshot_model,
      snapshot_service,
      snapshot_appointment,
      requested_issue_date,
      requested_due_date,
      nullif(trim(p_payload->>'notes'), ''),
      nullif(trim(p_payload->>'payment_terms'), ''),
      actor_id,
      actor_id
    ) returning id into target_id;
  else
    update public.invoices
    set source_type = source_kind,
        booking_id = selected_booking_id,
        enquiry_id = selected_enquiry_id,
        customer_id = selected_customer_id,
        vehicle_id = selected_vehicle_id,
        customer_name = snapshot_customer_name,
        customer_email = snapshot_customer_email,
        customer_phone = snapshot_customer_phone,
        customer_address = snapshot_customer_address,
        vehicle_registration = snapshot_registration,
        vehicle_make = snapshot_make,
        vehicle_model = snapshot_model,
        service_name = snapshot_service,
        appointment_start = snapshot_appointment,
        issue_date = requested_issue_date,
        due_date = requested_due_date,
        discount_pence = 0,
        tax_pence = 0,
        notes = nullif(trim(p_payload->>'notes'), ''),
        payment_terms = nullif(trim(p_payload->>'payment_terms'), ''),
        updated_by = actor_id
    where id = target_id;

    delete from public.invoice_items where invoice_id = target_id;
  end if;

  for item in select value from jsonb_array_elements(p_payload->'items') loop
    item_count := item_count + 1;
    if length(trim(coalesce(item->>'description', ''))) = 0 then
      raise exception 'ITEM_DESCRIPTION_REQUIRED';
    end if;
    item_quantity := (item->>'quantity')::numeric;
    item_unit_numeric := (item->>'unit_price_pence')::numeric;
    if item_quantity <= 0
       or item_quantity > 999999999.999
       or item_quantity <> round(item_quantity, 3) then
      raise exception 'INVALID_ITEM_QUANTITY';
    end if;
    if item_unit_numeric <> trunc(item_unit_numeric)
       or item_unit_numeric < 0
       or item_unit_numeric > 9007199254740991 then
      raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
    end if;
    item_unit_price := item_unit_numeric::bigint;
    perform public.invoice_line_total(item_quantity, item_unit_price);

    insert into public.invoice_items (
      invoice_id,
      description,
      quantity,
      unit_price_pence,
      line_total_pence,
      position
    ) values (
      target_id,
      trim(item->>'description'),
      item_quantity,
      item_unit_price,
      0,
      item_count - 1
    );
  end loop;

  select coalesce(sum(item.line_total_pence), 0)
  into calculated_subtotal
  from public.invoice_items item
  where item.invoice_id = target_id;

  if calculated_subtotal > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  if requested_discount > calculated_subtotal then
    raise exception 'INVALID_INVOICE_TOTAL';
  end if;

  update public.invoices
  set subtotal_pence = calculated_subtotal::bigint,
      discount_pence = requested_discount,
      tax_pence = 0,
      total_pence = calculated_subtotal::bigint - requested_discount,
      updated_by = actor_id
  where id = target_id;

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    actor_id,
    case when p_invoice_id is null then 'invoice.created' else 'invoice.updated' end,
    'invoice',
    target_id::text,
    jsonb_build_object(
      'sourceType', source_kind,
      'itemCount', item_count,
      'duplicateSourceConfirmed',
        coalesce(duplicate_exists, false) and coalesce(p_confirm_duplicate_source, false)
    )
  );
  return target_id;
end
$$;

create function public.issue_invoice(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  current_invoice public.invoices%rowtype;
  allocated_sequence bigint;
  allocated_year integer;
  effective_issue_date date;
  calculated_subtotal numeric;
  calculated_item_count integer;
begin
  select invoice.*
  into current_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
  for update;
  if not found or current_invoice.status <> 'draft'::public.invoice_status then
    raise exception 'DRAFT_INVOICE_NOT_FOUND';
  end if;

  if current_invoice.source_type = 'booking' and not exists (
    select 1
    from public.bookings booking
    join public.vehicles vehicle
      on vehicle.id = booking.vehicle_id
     and vehicle.customer_id = booking.customer_id
    where booking.id = current_invoice.booking_id
      and booking.customer_id = current_invoice.customer_id
      and booking.vehicle_id = current_invoice.vehicle_id
  ) then
    raise exception 'SOURCE_RELATIONSHIP_CHANGED';
  elsif current_invoice.source_type = 'enquiry' and not exists (
    select 1
    from public.enquiries enquiry
    left join public.vehicles vehicle
      on vehicle.id = enquiry.vehicle_id
     and vehicle.customer_id = enquiry.customer_id
    where enquiry.id = current_invoice.enquiry_id
      and enquiry.customer_id = current_invoice.customer_id
      and enquiry.vehicle_id is not distinct from current_invoice.vehicle_id
      and (enquiry.vehicle_id is null or vehicle.id is not null)
  ) then
    raise exception 'SOURCE_RELATIONSHIP_CHANGED';
  elsif current_invoice.source_type = 'manual'
        and current_invoice.vehicle_id is not null
        and not exists (
          select 1
          from public.vehicles vehicle
          where vehicle.id = current_invoice.vehicle_id
            and vehicle.customer_id = current_invoice.customer_id
        ) then
    raise exception 'SOURCE_RELATIONSHIP_CHANGED';
  end if;

  perform 1
  from public.invoice_items item
  where item.invoice_id = p_invoice_id
  order by item.id
  for update;

  update public.invoice_items item
  set line_total_pence = public.invoice_line_total(item.quantity, item.unit_price_pence)
  where item.invoice_id = p_invoice_id;

  select count(*)::integer, coalesce(sum(item.line_total_pence), 0)
  into calculated_item_count, calculated_subtotal
  from public.invoice_items item
  where item.invoice_id = p_invoice_id;

  if calculated_item_count = 0 then
    raise exception 'INVOICE_ITEM_REQUIRED';
  end if;
  if calculated_subtotal > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;

  select invoice.*
  into current_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id;

  if current_invoice.tax_pence <> 0 then
    raise exception 'VAT_NOT_CONFIGURED';
  end if;
  if current_invoice.discount_pence < 0 or current_invoice.discount_pence > calculated_subtotal then
    raise exception 'INVALID_INVOICE_TOTAL';
  end if;

  effective_issue_date := coalesce(
    current_invoice.issue_date,
    (clock_timestamp() at time zone 'Europe/London')::date
  );
  allocated_year := extract(year from effective_issue_date)::integer;
  if allocated_year not between 2020 and 9999 then
    raise exception 'INVALID_INVOICE_YEAR';
  end if;

  insert into public.invoice_number_sequences (invoice_year, last_value)
  values (allocated_year, 1)
  on conflict (invoice_year) do update
    set last_value = public.invoice_number_sequences.last_value + 1
    where public.invoice_number_sequences.last_value < 999999
  returning last_value into allocated_sequence;

  if allocated_sequence is null then
    raise exception 'INVOICE_YEAR_SEQUENCE_EXHAUSTED';
  end if;

  update public.invoices
  set invoice_year = allocated_year,
      invoice_sequence = allocated_sequence,
      invoice_number = 'SOB-' || allocated_year::text || '-' || lpad(allocated_sequence::text, 6, '0'),
      status = 'issued',
      issue_date = effective_issue_date,
      due_date = coalesce(due_date, effective_issue_date + 7),
      subtotal_pence = calculated_subtotal::bigint,
      tax_pence = 0,
      total_pence = calculated_subtotal::bigint - current_invoice.discount_pence,
      issued_at = now(),
      updated_by = actor_id
  where id = p_invoice_id
  returning * into current_invoice;

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    actor_id,
    'invoice.issued',
    'invoice',
    p_invoice_id::text,
    jsonb_build_object(
      'invoiceNumber', current_invoice.invoice_number,
      'revision', current_invoice.revision
    )
  );
  return current_invoice;
end
$$;

create function public.record_invoice_payment(p_invoice_id uuid, p_amount_pence bigint, p_paid_at timestamptz, p_method text, p_reference text)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  current_invoice public.invoices%rowtype;
  normalized_method text;
  already_paid bigint;
  outstanding bigint;
begin
  if p_paid_at is null then
    raise exception 'PAYMENT_DATE_REQUIRED';
  end if;
  normalized_method := lower(trim(p_method));
  if p_method is null or normalized_method not in ('cash', 'card', 'bank_transfer', 'other') then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;
  if p_amount_pence is null or p_amount_pence <= 0 then
    raise exception 'INVALID_PAYMENT_AMOUNT';
  end if;

  select invoice.*
  into current_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.status = 'issued'
  for update;
  if not found then
    raise exception 'ISSUED_INVOICE_NOT_FOUND';
  end if;
  if exists (
    select 1
    from public.invoice_email_sends email_send
    where email_send.invoice_id = p_invoice_id
      and email_send.status = 'pending'
  ) then
    raise exception 'INVOICE_EMAIL_SEND_IN_PROGRESS';
  end if;

  select coalesce(sum(payment.amount_pence), 0)
  into already_paid
  from public.invoice_payments payment
  where payment.invoice_id = p_invoice_id;
  outstanding := current_invoice.total_pence - already_paid;
  if p_amount_pence > outstanding then
    raise exception 'PAYMENT_EXCEEDS_BALANCE';
  end if;

  insert into public.invoice_payments (
    invoice_id,
    amount_pence,
    paid_at,
    payment_method,
    payment_reference,
    created_by
  ) values (
    p_invoice_id,
    p_amount_pence,
    p_paid_at,
    normalized_method,
    nullif(trim(p_reference), ''),
    actor_id
  );

  if p_amount_pence = outstanding then
    update public.invoices
    set status = 'paid',
        paid_at = p_paid_at,
        payment_method = normalized_method,
        payment_reference = nullif(trim(p_reference), ''),
        updated_by = actor_id
    where id = p_invoice_id
      and status = 'issued'
    returning * into current_invoice;
  end if;

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    actor_id,
    case when p_amount_pence = outstanding then 'invoice.marked_paid' else 'invoice.part_payment_recorded' end,
    'invoice',
    p_invoice_id::text,
    jsonb_build_object(
      'amountPence', p_amount_pence,
      'amountPaidPence', already_paid + p_amount_pence,
      'balancePence', outstanding - p_amount_pence,
      'method', normalized_method,
      'paidAt', p_paid_at,
      'revision', current_invoice.revision
    )
  );
  return current_invoice;
end
$$;

create function public.mark_invoice_paid(p_invoice_id uuid, p_paid_at timestamptz, p_method text, p_reference text)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_invoice public.invoices%rowtype;
  already_paid bigint;
begin
  perform public.require_invoice_actor();
  select invoice.*
  into current_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.status = 'issued';
  if not found then
    raise exception 'ISSUED_INVOICE_NOT_FOUND';
  end if;
  select coalesce(sum(payment.amount_pence), 0)
  into already_paid
  from public.invoice_payments payment
  where payment.invoice_id = p_invoice_id;
  return public.record_invoice_payment(
    p_invoice_id,
    current_invoice.total_pence - already_paid,
    p_paid_at,
    p_method,
    p_reference
  );
end
$$;

create function public.void_invoice(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  result public.invoices%rowtype;
begin
  select invoice.*
  into result
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.status = 'issued'
  for update;
  if not found then
    raise exception 'ISSUED_INVOICE_NOT_FOUND';
  end if;
  if exists (
    select 1
    from public.invoice_email_sends email_send
    where email_send.invoice_id = p_invoice_id
      and email_send.status = 'pending'
  ) then
    raise exception 'INVOICE_EMAIL_SEND_IN_PROGRESS';
  end if;

  update public.invoices
  set status = 'void',
      voided_at = now(),
      updated_by = actor_id
  where id = p_invoice_id
    and status = 'issued'
  returning * into result;

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    actor_id,
    'invoice.voided',
    'invoice',
    p_invoice_id::text,
    jsonb_build_object('revision', result.revision)
  );
  return result;
end
$$;

create function public.delete_invoice_draft(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  deleted_id uuid;
begin
  delete from public.invoices
  where id = p_invoice_id
    and status = 'draft'
  returning id into deleted_id;

  if deleted_id is null then
    raise exception 'DRAFT_INVOICE_NOT_FOUND';
  end if;
  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (actor_id, 'invoice.deleted_draft', 'invoice', p_invoice_id::text, '{}'::jsonb);
  return deleted_id;
end
$$;

create function public.duplicate_invoice_to_draft(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  source_invoice public.invoices%rowtype;
  target_id uuid;
  calculated_subtotal numeric;
  business_date date := (clock_timestamp() at time zone 'Europe/London')::date;
begin
  select invoice.*
  into source_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
  for share;

  if not found then
    raise exception 'INVOICE_NOT_FOUND';
  end if;
  if source_invoice.status not in ('paid'::public.invoice_status, 'void'::public.invoice_status) then
    raise exception 'INVOICE_MUST_BE_PAID_OR_VOID_TO_DUPLICATE';
  end if;

  insert into public.invoices (
    replaces_invoice_id,
    source_type,
    customer_id,
    vehicle_id,
    customer_name,
    customer_email,
    customer_phone,
    customer_address,
    vehicle_registration,
    vehicle_make,
    vehicle_model,
    service_name,
    appointment_start,
    issue_date,
    due_date,
    notes,
    payment_terms,
    created_by,
    updated_by
  ) values (
    source_invoice.id,
    'manual',
    source_invoice.customer_id,
    source_invoice.vehicle_id,
    source_invoice.customer_name,
    source_invoice.customer_email,
    source_invoice.customer_phone,
    source_invoice.customer_address,
    source_invoice.vehicle_registration,
    source_invoice.vehicle_make,
    source_invoice.vehicle_model,
    source_invoice.service_name,
    source_invoice.appointment_start,
    business_date,
    business_date + 7,
    source_invoice.notes,
    source_invoice.payment_terms,
    actor_id,
    actor_id
  ) returning id into target_id;

  insert into public.invoice_items (
    invoice_id,
    description,
    quantity,
    unit_price_pence,
    line_total_pence,
    position
  )
  select
    target_id,
    item.description,
    item.quantity,
    item.unit_price_pence,
    0,
    item.position
  from public.invoice_items item
  where item.invoice_id = source_invoice.id
  order by item.position;

  select coalesce(sum(item.line_total_pence), 0)
  into calculated_subtotal
  from public.invoice_items item
  where item.invoice_id = target_id;

  if calculated_subtotal > 9007199254740991 then
    raise exception 'INVOICE_AMOUNT_EXCEEDS_SAFE_INTEGER' using errcode = '22003';
  end if;
  if source_invoice.discount_pence > calculated_subtotal then
    raise exception 'INVALID_INVOICE_TOTAL';
  end if;

  update public.invoices
  set subtotal_pence = calculated_subtotal::bigint,
      discount_pence = source_invoice.discount_pence,
      tax_pence = 0,
      total_pence = calculated_subtotal::bigint - source_invoice.discount_pence,
      updated_by = actor_id
  where id = target_id;

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    actor_id,
    'invoice.created',
    'invoice',
    target_id::text,
    jsonb_build_object('replacesInvoiceId', source_invoice.id, 'sourceInvoiceNumber', source_invoice.invoice_number)
  );
  return target_id;
end
$$;

create function public.create_invoice_correction(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  draft_id uuid;
begin
  perform 1
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.status = 'issued'
  for update;
  if not found then
    raise exception 'ISSUED_INVOICE_NOT_FOUND';
  end if;

  perform public.void_invoice(p_invoice_id);
  draft_id := public.duplicate_invoice_to_draft(p_invoice_id);

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (actor_id, 'invoice.correction_created', 'invoice', p_invoice_id::text, jsonb_build_object('draftId', draft_id));
  return draft_id;
end
$$;

create function public.claim_invoice_email_send(p_invoice_id uuid, p_recipient text, p_logical_send_id uuid, p_invoice_revision bigint, p_payload_sha256 text)
returns table (logical_send_id uuid, attempt_id bigint, provider_idempotency_key text, claim_token uuid, disposition text, should_send boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  invoice_record public.invoices%rowtype;
  send_record public.invoice_email_sends%rowtype;
  attempt_record public.invoice_email_attempts%rowtype;
  normalized_recipient text := lower(trim(p_recipient));
  normalized_hash text := lower(trim(p_payload_sha256));
  generated_key text;
  generated_claim uuid;
  next_attempt integer;
  result_disposition text;
begin
  if p_logical_send_id is null then
    raise exception 'LOGICAL_SEND_ID_REQUIRED';
  end if;
  if p_invoice_revision is null or p_invoice_revision <= 0 then
    raise exception 'INVOICE_REVISION_REQUIRED';
  end if;
  if normalized_recipient is null
     or length(normalized_recipient) > 320
     or normalized_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'INVALID_EMAIL_RECIPIENT';
  end if;
  if normalized_hash is null or normalized_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_EMAIL_PAYLOAD_HASH';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('public.invoice_email_sends:' || p_logical_send_id::text, 0)
  );

  select invoice.*
  into invoice_record
  from public.invoices invoice
  where invoice.id = p_invoice_id
  for share;

  if not found or invoice_record.status not in ('issued'::public.invoice_status, 'paid'::public.invoice_status) then
    raise exception 'ONLY_ISSUED_INVOICES_CAN_BE_EMAILED';
  end if;
  if invoice_record.revision <> p_invoice_revision then
    raise exception 'INVOICE_REVISION_MISMATCH';
  end if;

  select email_send.*
  into send_record
  from public.invoice_email_sends email_send
  where email_send.id = p_logical_send_id
  for update;

  if found then
    if send_record.invoice_id <> p_invoice_id
       or send_record.recipient <> normalized_recipient
       or send_record.invoice_revision <> p_invoice_revision
       or send_record.payload_sha256 <> normalized_hash
       or send_record.document_status <> invoice_record.status
       or send_record.document_number <> invoice_record.invoice_number then
      raise exception 'LOGICAL_SEND_REUSE_MISMATCH';
    end if;

    select attempt.*
    into attempt_record
    from public.invoice_email_attempts attempt
    where attempt.logical_send_id = send_record.id
    order by attempt.attempt_number desc
    limit 1
    for update;

    if send_record.status = 'sent' then
      return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
        null::uuid, 'already_sent'::text, false;
      return;
    end if;

    if attempt_record.status = 'pending' and attempt_record.lease_expires_at > now() then
      return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
        null::uuid, 'in_progress'::text, false;
      return;
    end if;

    if attempt_record.status = 'pending' then
      update public.invoice_email_attempts
      set status = 'ambiguous',
          error_code = 'claim_expired',
          completed_at = now()
      where id = attempt_record.id;
      update public.invoice_email_sends
      set status = 'ambiguous',
          last_error_code = 'claim_expired',
          updated_at = now()
      where id = send_record.id;
      return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
        null::uuid, 'reconciliation_required'::text, false;
      return;
    end if;

    if send_record.status = 'ambiguous' then
      return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
        null::uuid, 'reconciliation_required'::text, false;
      return;
    end if;

    result_disposition := 'failed_retry';

    select coalesce(max(attempt.attempt_number), 0) + 1
    into next_attempt
    from public.invoice_email_attempts attempt
    where attempt.logical_send_id = send_record.id;

    generated_claim := gen_random_uuid();
    insert into public.invoice_email_attempts (
      logical_send_id,
      invoice_id,
      attempt_number,
      status,
      claim_token,
      lease_expires_at,
      attempted_by
    ) values (
      send_record.id,
      p_invoice_id,
      next_attempt,
      'pending',
      generated_claim,
      now() + interval '15 minutes',
      actor_id
    ) returning * into attempt_record;

    update public.invoice_email_sends
    set status = 'pending',
        last_error_code = null,
        updated_at = now()
    where id = send_record.id;

    return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
      generated_claim, result_disposition, true;
    return;
  end if;

  generated_key := 'invoice-' || md5(
    p_invoice_id::text || ':' || p_invoice_revision::text || ':' || normalized_recipient || ':' || normalized_hash || ':' || p_logical_send_id::text
  );
  insert into public.invoice_email_sends (
    id,
    invoice_id,
    recipient,
    invoice_revision,
    document_status,
    document_number,
    payload_sha256,
    provider_idempotency_key,
    status,
    requested_by
  ) values (
    p_logical_send_id,
    p_invoice_id,
    normalized_recipient,
    p_invoice_revision,
    invoice_record.status,
    invoice_record.invoice_number,
    normalized_hash,
    generated_key,
    'pending',
    actor_id
  ) returning * into send_record;

  generated_claim := gen_random_uuid();
  insert into public.invoice_email_attempts (
    logical_send_id,
    invoice_id,
    attempt_number,
    status,
    claim_token,
    lease_expires_at,
    attempted_by
  ) values (
    send_record.id,
    p_invoice_id,
    1,
    'pending',
    generated_claim,
    now() + interval '15 minutes',
    actor_id
  ) returning * into attempt_record;

  return query select send_record.id, attempt_record.id, send_record.provider_idempotency_key,
    generated_claim, 'should_send'::text, true;
end
$$;

create function public.finalize_invoice_email_send(p_attempt_id bigint, p_claim_token uuid, p_provider_id text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  logical_id uuid;
  send_record public.invoice_email_sends%rowtype;
  attempt_record public.invoice_email_attempts%rowtype;
  normalized_provider_id text := nullif(trim(p_provider_id), '');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  if p_claim_token is null
     or normalized_provider_id is null
     or length(normalized_provider_id) > 255 then
    raise exception 'EMAIL_PROVIDER_CONFIRMATION_REQUIRED';
  end if;

  select attempt.logical_send_id
  into logical_id
  from public.invoice_email_attempts attempt
  where attempt.id = p_attempt_id;
  if logical_id is null then
    raise exception 'EMAIL_ATTEMPT_NOT_FOUND';
  end if;

  select email_send.*
  into send_record
  from public.invoice_email_sends email_send
  where email_send.id = logical_id
  for update;

  select attempt.*
  into attempt_record
  from public.invoice_email_attempts attempt
  where attempt.id = p_attempt_id
  for update;

  if attempt_record.claim_token <> p_claim_token then
    raise exception 'EMAIL_CLAIM_TOKEN_MISMATCH';
  end if;
  if send_record.status = 'sent' then
    if send_record.provider_id is distinct from normalized_provider_id then
      raise exception 'EMAIL_PROVIDER_CONFIRMATION_MISMATCH';
    end if;
    return p_attempt_id;
  end if;
  if attempt_record.status not in ('pending', 'ambiguous') then
    raise exception 'EMAIL_ATTEMPT_NOT_FINALISABLE';
  end if;
  if (attempt_record.provider_id is not null and attempt_record.provider_id <> normalized_provider_id)
     or (send_record.provider_id is not null and send_record.provider_id <> normalized_provider_id) then
    raise exception 'EMAIL_PROVIDER_CONFIRMATION_MISMATCH';
  end if;

  update public.invoice_email_attempts
  set status = 'sent',
      provider_id = normalized_provider_id,
      error_code = null,
      completed_at = now()
  where id = p_attempt_id;

  update public.invoice_email_attempts
  set status = 'ambiguous',
      error_code = 'superseded_by_sent_attempt',
      completed_at = now()
  where logical_send_id = logical_id
    and id <> p_attempt_id
    and status = 'pending';

  update public.invoice_email_sends
  set status = 'sent',
      provider_id = normalized_provider_id,
      last_error_code = null,
      sent_at = now(),
      updated_at = now()
  where id = logical_id;

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    attempt_record.attempted_by,
    'invoice.sent',
    'invoice',
    send_record.invoice_id::text,
    jsonb_build_object(
      'logicalSendId', logical_id,
      'attemptId', p_attempt_id,
      'invoiceRevision', send_record.invoice_revision
    )
  );
  return p_attempt_id;
end
$$;

create function public.fail_invoice_email_send(p_attempt_id bigint, p_claim_token uuid, p_error_code text, p_ambiguous boolean, p_provider_id text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  logical_id uuid;
  send_record public.invoice_email_sends%rowtype;
  attempt_record public.invoice_email_attempts%rowtype;
  normalized_error text := lower(trim(p_error_code));
  normalized_provider_id text := nullif(trim(p_provider_id), '');
  target_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  if p_claim_token is null or p_ambiguous is null then
    raise exception 'INVALID_EMAIL_FAILURE_STATE';
  end if;
  if normalized_error is null
     or length(normalized_error) > 100
     or normalized_error !~ '^[a-z0-9_.-]+$' then
    raise exception 'INVALID_EMAIL_ERROR_CODE';
  end if;
  if normalized_provider_id is not null and length(normalized_provider_id) > 255 then
    raise exception 'INVALID_EMAIL_PROVIDER_ID';
  end if;
  if not p_ambiguous and normalized_provider_id is not null then
    raise exception 'EMAIL_PROVIDER_ID_NOT_ALLOWED_FOR_FAILED_ATTEMPT';
  end if;
  target_status := case when p_ambiguous then 'ambiguous' else 'failed' end;

  select attempt.logical_send_id
  into logical_id
  from public.invoice_email_attempts attempt
  where attempt.id = p_attempt_id;
  if logical_id is null then
    raise exception 'EMAIL_ATTEMPT_NOT_FOUND';
  end if;

  select email_send.*
  into send_record
  from public.invoice_email_sends email_send
  where email_send.id = logical_id
  for update;

  select attempt.*
  into attempt_record
  from public.invoice_email_attempts attempt
  where attempt.id = p_attempt_id
  for update;

  if attempt_record.claim_token <> p_claim_token then
    raise exception 'EMAIL_CLAIM_TOKEN_MISMATCH';
  end if;
  if send_record.status = 'sent' then
    return p_attempt_id;
  end if;
  if attempt_record.status = target_status
     and attempt_record.error_code = normalized_error
     and attempt_record.provider_id is not distinct from normalized_provider_id then
    return p_attempt_id;
  end if;
  if attempt_record.status <> 'pending' then
    raise exception 'EMAIL_ATTEMPT_NOT_FAILABLE';
  end if;

  update public.invoice_email_attempts
  set status = target_status,
      provider_id = case when p_ambiguous then normalized_provider_id else null end,
      error_code = normalized_error,
      completed_at = now()
  where id = p_attempt_id;

  update public.invoice_email_sends
  set status = target_status,
      provider_id = case when p_ambiguous then normalized_provider_id else null end,
      last_error_code = normalized_error,
      updated_at = now()
  where id = logical_id;
  return p_attempt_id;
end
$$;

create function public.get_invoice_dashboard_without_payments(p_query text, p_status text, p_date date, p_page integer, p_page_size integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_query text := lower(trim(coalesce(p_query, '')));
  normalized_registration text := upper(regexp_replace(coalesce(p_query, ''), '[^A-Za-z0-9]', '', 'g'));
  matching_count bigint;
  page_count integer;
  effective_page integer;
  page_rows jsonb;
  draft_count bigint;
  outstanding_count bigint;
  paid_count bigint;
  outstanding_total numeric;
begin
  perform public.require_invoice_actor();
  if length(normalized_query) > 200 then raise exception 'INVALID_INVOICE_SEARCH_QUERY'; end if;
  if p_status is not null and p_status not in ('draft', 'issued', 'paid', 'void') then raise exception 'INVALID_INVOICE_STATUS'; end if;
  if p_page is null or p_page < 1 or p_page_size is null or p_page_size not between 1 and 100 then raise exception 'INVALID_INVOICE_PAGE'; end if;

  select count(*) into matching_count
  from public.invoices invoice
  where invoice.deleted_at is null
    and (p_status is null or invoice.status::text = p_status)
    and (p_date is null or invoice.issue_date = p_date or (invoice.created_at at time zone 'UTC')::date = p_date)
    and (
      normalized_query = ''
      or position(normalized_query in lower(concat_ws(' ', invoice.invoice_number, invoice.customer_name, invoice.customer_email, invoice.customer_phone, invoice.vehicle_registration, invoice.vehicle_make, invoice.vehicle_model))) > 0
      or (length(normalized_registration) >= 2 and position(normalized_registration in coalesce(invoice.vehicle_registration, '')) > 0)
    );

  page_count := greatest(1, ceil(matching_count::numeric / p_page_size)::integer);
  effective_page := least(p_page, page_count);
  select coalesce(jsonb_agg(to_jsonb(invoice_page) order by invoice_page.created_at desc, invoice_page.id desc), '[]'::jsonb)
  into page_rows
  from (
    select invoice.id, invoice.invoice_number, invoice.status, invoice.source_type, invoice.customer_name, invoice.customer_email, invoice.customer_phone, invoice.vehicle_registration, invoice.vehicle_make, invoice.vehicle_model, invoice.issue_date, invoice.due_date, invoice.total_pence, invoice.created_at
    from public.invoices invoice
    where invoice.deleted_at is null
      and (p_status is null or invoice.status::text = p_status)
      and (p_date is null or invoice.issue_date = p_date or (invoice.created_at at time zone 'UTC')::date = p_date)
      and (
        normalized_query = ''
        or position(normalized_query in lower(concat_ws(' ', invoice.invoice_number, invoice.customer_name, invoice.customer_email, invoice.customer_phone, invoice.vehicle_registration, invoice.vehicle_make, invoice.vehicle_model))) > 0
        or (length(normalized_registration) >= 2 and position(normalized_registration in coalesce(invoice.vehicle_registration, '')) > 0)
      )
    order by invoice.created_at desc, invoice.id desc
    offset (effective_page - 1) * p_page_size
    limit p_page_size
  ) invoice_page;

  select
    count(*) filter (where invoice.status = 'draft'),
    count(*) filter (where invoice.status = 'issued'),
    count(*) filter (where invoice.status = 'paid'),
    coalesce(sum(invoice.total_pence) filter (where invoice.status = 'issued'), 0)
  into draft_count, outstanding_count, paid_count, outstanding_total
  from public.invoices invoice
  where invoice.deleted_at is null;

  return jsonb_build_object(
    'invoices', page_rows,
    'matching_count', matching_count::text,
    'page', effective_page,
    'pages', page_count,
    'draft_count', draft_count::text,
    'outstanding_count', outstanding_count::text,
    'paid_count', paid_count::text,
    'outstanding_total_pence', outstanding_total::text
  );
end
$$;

create function public.get_invoice_dashboard(p_query text, p_status text, p_date date, p_page integer, p_page_size integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  outstanding_total numeric;
  current_week_paid_total numeric;
  week_start timestamptz := date_trunc('week', timezone('Europe/London', statement_timestamp())) at time zone 'Europe/London';
  week_end timestamptz := (date_trunc('week', timezone('Europe/London', statement_timestamp())) + interval '1 week') at time zone 'Europe/London';
begin
  perform public.require_invoice_actor();
  result := public.get_invoice_dashboard_without_payments(p_query, p_status, p_date, p_page, p_page_size);
  select coalesce(sum(invoice.total_pence - coalesce(payment.amount_paid_pence, 0)), 0)
  into outstanding_total
  from public.invoices invoice
  left join lateral (select sum(invoice_payment.amount_pence) as amount_paid_pence from public.invoice_payments invoice_payment where invoice_payment.invoice_id = invoice.id) payment on true
  where invoice.status = 'issued' and invoice.deleted_at is null;

  select
    coalesce((select sum(payment.amount_pence) from public.invoice_payments payment join public.invoices invoice on invoice.id = payment.invoice_id where invoice.deleted_at is null and payment.paid_at >= week_start and payment.paid_at < week_end), 0)
    + coalesce((select sum(invoice.total_pence) from public.invoices invoice where invoice.deleted_at is null and invoice.status = 'paid' and invoice.paid_at >= week_start and invoice.paid_at < week_end and not exists (select 1 from public.invoice_payments payment where payment.invoice_id = invoice.id)), 0)
  into current_week_paid_total;

  return result || jsonb_build_object('outstanding_total_pence', outstanding_total::text, 'current_week_paid_total_pence', current_week_paid_total::text);
end
$$;

-- Admin trash: soft delete, restore and permanent delete.
create function public.manage_admin_trash(p_entity text, p_ids uuid[], p_action text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_table text;
  entity_filter text := '';
  affected integer := 0;
  target_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 100 then
    raise exception 'INVALID_TRASH_SELECTION';
  end if;
  if p_action not in ('trash', 'restore', 'delete') then
    raise exception 'INVALID_TRASH_ACTION';
  end if;

  target_table := case p_entity
    when 'enquiries' then 'enquiries'
    when 'bookings' then 'bookings'
    when 'invoices' then 'invoices'
    when 'media' then 'media_assets'
    when 'reviews' then 'reviews'
    when 'offers' then 'offers'
    when 'catalogue_systems' then 'service_catalogue_systems'
    when 'catalogue_services' then 'booking_service_types'
    else null
  end;
  if target_table is null then raise exception 'INVALID_TRASH_ENTITY'; end if;
  if p_entity = 'catalogue_services' then entity_filter := ' and system_id is not null'; end if;

  if p_action = 'trash' then
    execute format('update public.%I set deleted_at = statement_timestamp(), deleted_by = $1 where id = any($2) and deleted_at is null%s', target_table, entity_filter)
      using auth.uid(), p_ids;
    get diagnostics affected = row_count;
  elsif p_action = 'restore' then
    execute format('update public.%I set deleted_at = null, deleted_by = null where id = any($1) and deleted_at is not null%s', target_table, entity_filter)
      using p_ids;
    get diagnostics affected = row_count;
  elsif p_entity = 'invoices' then
    foreach target_id in array p_ids loop
      if exists (select 1 from public.invoices where id = target_id and deleted_at is not null and status = 'draft') then
        perform public.delete_invoice_draft(target_id);
        affected := affected + 1;
      end if;
    end loop;
  elsif p_entity = 'bookings' then
    delete from public.bookings booking
    where booking.id = any(p_ids) and booking.deleted_at is not null
      and not exists (select 1 from public.invoices invoice where invoice.booking_id = booking.id);
    get diagnostics affected = row_count;
  elsif p_entity = 'enquiries' then
    delete from public.enquiries enquiry
    where enquiry.id = any(p_ids) and enquiry.deleted_at is not null
      and not exists (select 1 from public.invoices invoice where invoice.enquiry_id = enquiry.id);
    get diagnostics affected = row_count;
  elsif p_entity = 'catalogue_services' then
    delete from public.booking_service_types service
    where service.id = any(p_ids) and service.deleted_at is not null and service.system_id is not null
      and not exists (select 1 from public.bookings booking where booking.service_type_id = service.id);
    get diagnostics affected = row_count;
  elsif p_entity = 'catalogue_systems' then
    delete from public.service_catalogue_systems system
    where system.id = any(p_ids) and system.deleted_at is not null
      and not exists (select 1 from public.booking_service_types service where service.system_id = system.id);
    get diagnostics affected = row_count;
  else
    execute format('delete from public.%I where id = any($1) and deleted_at is not null%s', target_table, entity_filter) using p_ids;
    get diagnostics affected = row_count;
  end if;

  insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (auth.uid(), 'trash.' || p_action, p_entity, coalesce(p_ids[1]::text, 'bulk'), jsonb_build_object('ids', to_jsonb(p_ids), 'affected', affected));
  return affected;
end
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger customers_updated before update on public.customers
  for each row execute function public.set_updated_at();
create trigger enquiries_updated before update on public.enquiries
  for each row execute function public.set_updated_at();
create trigger reviews_updated before update on public.reviews
  for each row execute function public.set_updated_at();
create trigger bookings_updated before update on public.bookings
  for each row execute function public.set_updated_at();
create trigger booking_notification_events_updated before update on public.booking_notification_events
  for each row execute function public.set_updated_at();
create trigger booking_service_types_updated before update on public.booking_service_types
  for each row execute function public.set_updated_at();
create trigger service_catalogue_systems_updated before update on public.service_catalogue_systems
  for each row execute function public.set_updated_at();

create trigger enforce_allowed_admin_email before insert or update of user_id on public.admin_profiles
  for each row execute function public.enforce_allowed_admin_email();

create trigger invoices_protect_history before insert or update or delete on public.invoices
  for each row execute function public.protect_invoice_history();
create trigger invoice_items_prepare before insert or update or delete on public.invoice_items
  for each row execute function public.prepare_invoice_item();
create trigger invoice_items_refresh_totals after insert or update or delete on public.invoice_items
  for each row execute function public.refresh_invoice_totals();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.admin_profiles enable row level security;
alter table public.admin_mfa_policy enable row level security;
alter table public.admin_mfa_recovery_codes enable row level security;
alter table public.admin_mfa_recovery_sessions enable row level security;
alter table public.admin_trusted_devices enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.site_settings enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.resend_webhook_events enable row level security;
alter table public.inbound_email_events enable row level security;
alter table public.provider_webhook_events enable row level security;
alter table public.customers enable row level security;
alter table public.vehicles enable row level security;
alter table public.service_catalogue_systems enable row level security;
alter table public.booking_service_types enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_audit_log enable row level security;
alter table public.booking_notification_events enable row level security;
alter table public.enquiries enable row level security;
alter table public.enquiry_messages enable row level security;
alter table public.enquiry_attachments enable row level security;
alter table public.enquiry_conversations enable row level security;
alter table public.notification_attempts enable row level security;
alter table public.unmatched_inbound_emails enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.invoice_number_sequences enable row level security;
alter table public.invoice_payments enable row level security;
alter table public.invoice_email_sends enable row level security;
alter table public.invoice_email_attempts enable row level security;
alter table public.media_assets enable row level security;
alter table public.offers enable row level security;
alter table public.reviews enable row level security;
alter table public.service_prices enable row level security;

create policy "admins manage profiles" on public.admin_profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins read audit log" on public.admin_audit_log
  for select to authenticated using (public.is_admin());
create policy "admins manage settings" on public.site_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admins read resend webhook events" on public.resend_webhook_events
  for select to authenticated using (public.is_admin());
create policy "admins read inbound email events" on public.inbound_email_events
  for select to authenticated using (public.is_admin());
create policy "admins read provider webhook events" on public.provider_webhook_events
  for select to authenticated using (public.is_admin());

create policy "admins manage customers" on public.customers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage vehicles" on public.vehicles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage service catalogue systems" on public.service_catalogue_systems
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage booking service types" on public.booking_service_types
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admins read bookings" on public.bookings
  for select to authenticated using (public.is_admin());
create policy "admins update bookings" on public.bookings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins read booking audit" on public.booking_audit_log
  for select to authenticated using (public.is_admin());
create policy "admins read booking notification events" on public.booking_notification_events
  for select to authenticated using (public.is_admin());

create policy "admins manage enquiries" on public.enquiries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage enquiry messages" on public.enquiry_messages
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage attachments" on public.enquiry_attachments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage enquiry conversations" on public.enquiry_conversations
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage notifications" on public.notification_attempts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage unmatched inbound" on public.unmatched_inbound_emails
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admins read invoices" on public.invoices
  for select to authenticated using (public.is_admin());
create policy "admins read invoice items" on public.invoice_items
  for select to authenticated using (public.is_admin());
create policy "admins read invoice payments" on public.invoice_payments
  for select to authenticated using ((select public.is_admin()));
create policy "admins read invoice email sends" on public.invoice_email_sends
  for select to authenticated using (public.is_admin());
create policy "admins read invoice email attempts" on public.invoice_email_attempts
  for select to authenticated using (public.is_admin());

create policy "admins manage media" on public.media_assets
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "published media metadata is public" on public.media_assets
  for select to anon, authenticated using (public.is_admin() or (deleted_at is null and published));
create policy "admins manage offers" on public.offers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "active offers are public" on public.offers
  for select to anon, authenticated using (public.is_admin() or (deleted_at is null and active));
create policy "admins manage reviews" on public.reviews
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "visible reviews are public" on public.reviews
  for select to anon, authenticated using (public.is_admin() or (deleted_at is null and visible));
create policy "admins manage prices" on public.service_prices
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "published prices are public" on public.service_prices
  for select to anon, authenticated using (published or public.is_admin());

-- ---------------------------------------------------------------------------
-- Grants (only those SOB's migrations made explicitly)
-- ---------------------------------------------------------------------------

revoke all on table public.admin_mfa_policy from public, anon, authenticated;
revoke all on table public.admin_mfa_recovery_codes from public, anon, authenticated;
revoke all on table public.admin_mfa_recovery_sessions from public, anon, authenticated;
revoke all on table public.admin_trusted_devices from public, anon, authenticated;
grant select, update on table public.admin_mfa_policy to service_role;
grant select, insert, update, delete on table public.admin_mfa_recovery_codes to service_role;
grant select, insert, update, delete on table public.admin_mfa_recovery_sessions to service_role;
grant select, insert, update, delete on table public.admin_trusted_devices to service_role;
grant select on table public.admin_profiles to authenticated;
grant select on table public.admin_audit_log to authenticated;

grant select, insert, update, delete on table public.service_catalogue_systems to authenticated, service_role;

revoke all on table public.invoices from public, anon, authenticated, service_role;
revoke all on table public.invoice_items from public, anon, authenticated, service_role;
revoke all on table public.invoice_number_sequences from public, anon, authenticated, service_role;
revoke all on table public.invoice_payments from public, anon, authenticated, service_role;
revoke all on table public.invoice_email_sends from public, anon, authenticated, service_role;
revoke all on table public.invoice_email_attempts from public, anon, authenticated, service_role;
revoke all on sequence public.invoice_email_attempts_id_seq from public, anon, authenticated, service_role;
grant select on table public.invoices to authenticated, service_role;
grant select on table public.invoice_items to authenticated, service_role;
grant select on table public.invoice_payments to authenticated, service_role;
grant select on table public.invoice_email_sends to authenticated, service_role;
grant select on table public.invoice_email_attempts to authenticated, service_role;

revoke all on function public.enforce_allowed_admin_email() from public, anon, authenticated;

revoke all on function public.consume_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, text, integer, integer) to service_role;
revoke all on function public.apply_enquiry_retention() from public, anon, authenticated;
grant execute on function public.apply_enquiry_retention() to service_role;

revoke all on function public.generate_booking_reference() from public, anon, authenticated;
grant execute on function public.generate_booking_reference() to service_role;
revoke all on function public.create_booking_intent(uuid, text, text, text, text, text, text, integer, text, text, text, uuid, text, text, text, jsonb, jsonb, text, text, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.create_booking_intent(uuid, text, text, text, text, text, text, integer, text, text, text, uuid, text, text, text, jsonb, jsonb, text, text, text, text, timestamptz, text)
  to service_role;
revoke all on function public.create_booking_enquiry_thread(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_booking_enquiry_thread(uuid, uuid) to service_role;
revoke all on function public.increment_enquiry_unread(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.increment_enquiry_unread(uuid, timestamptz) to service_role;

revoke all on function public.claim_inbound_email_event(text, text, text) from public, anon, authenticated;
revoke all on function public.finish_inbound_email_event(text, text, text, text) from public, anon, authenticated;
revoke all on function public.store_inbound_email_message(uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.claim_inbound_email_event(text, text, text) to service_role;
grant execute on function public.finish_inbound_email_event(text, text, text, text) to service_role;
grant execute on function public.store_inbound_email_message(uuid, text, text, text, text, text, text, text, text, text, text[], timestamptz, text)
  to service_role;

revoke all on function public.replace_admin_mfa_recovery_codes(uuid, text[], text) from public, anon, authenticated;
revoke all on function public.consume_admin_mfa_recovery_code(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.replace_admin_mfa_recovery_codes(uuid, text[], text) to service_role;
grant execute on function public.consume_admin_mfa_recovery_code(uuid, text, text, timestamptz) to service_role;

revoke all on function public.require_invoice_actor() from public, anon, authenticated, service_role;
revoke all on function public.invoice_line_total(numeric, bigint) from public, anon, authenticated, service_role;
revoke all on function public.prepare_invoice_item() from public, anon, authenticated, service_role;
revoke all on function public.refresh_invoice_totals() from public, anon, authenticated, service_role;
revoke all on function public.protect_invoice_history() from public, anon, authenticated, service_role;
revoke all on function public.save_invoice_draft(uuid, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.issue_invoice(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_invoice_payment(uuid, bigint, timestamptz, text, text) from public, anon, authenticated, service_role;
revoke all on function public.mark_invoice_paid(uuid, timestamptz, text, text) from public, anon, authenticated, service_role;
revoke all on function public.void_invoice(uuid) from public, anon, authenticated, service_role;
revoke all on function public.delete_invoice_draft(uuid) from public, anon, authenticated, service_role;
revoke all on function public.duplicate_invoice_to_draft(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_invoice_correction(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_invoice_email_send(uuid, text, uuid, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.finalize_invoice_email_send(bigint, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.fail_invoice_email_send(bigint, uuid, text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.get_invoice_dashboard_without_payments(text, text, date, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_invoice_dashboard(text, text, date, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.manage_admin_trash(text, uuid[], text) from public, anon, authenticated, service_role;
grant execute on function public.save_invoice_draft(uuid, jsonb, boolean) to authenticated;
grant execute on function public.issue_invoice(uuid) to authenticated;
grant execute on function public.record_invoice_payment(uuid, bigint, timestamptz, text, text) to authenticated;
grant execute on function public.mark_invoice_paid(uuid, timestamptz, text, text) to authenticated;
grant execute on function public.void_invoice(uuid) to authenticated;
grant execute on function public.delete_invoice_draft(uuid) to authenticated;
grant execute on function public.duplicate_invoice_to_draft(uuid) to authenticated;
grant execute on function public.create_invoice_correction(uuid) to authenticated;
grant execute on function public.claim_invoice_email_send(uuid, text, uuid, bigint, text) to authenticated;
grant execute on function public.finalize_invoice_email_send(bigint, uuid, text) to service_role;
grant execute on function public.fail_invoice_email_send(bigint, uuid, text, boolean, text) to service_role;
grant execute on function public.get_invoice_dashboard(text, text, date, integer, integer) to authenticated;
grant execute on function public.manage_admin_trash(text, uuid[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('public-media', 'public-media', true, 12582912, array['image/jpeg', 'image/png', 'image/webp']),
  ('enquiry-attachments', 'enquiry-attachments', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "admins upload public media" on storage.objects
  for insert to authenticated with check (bucket_id = 'public-media' and public.is_admin());
create policy "admins update public media" on storage.objects
  for update to authenticated using (bucket_id = 'public-media' and public.is_admin());
create policy "admins delete public media" on storage.objects
  for delete to authenticated using (bucket_id = 'public-media' and public.is_admin());
create policy "admins read private attachments" on storage.objects
  for select to authenticated using (bucket_id = 'enquiry-attachments' and public.is_admin());

-- ---------------------------------------------------------------------------
-- Platform rows
-- ---------------------------------------------------------------------------

-- SOB's final state: mandatory MFA switched on.
insert into public.admin_mfa_policy (singleton, mandatory_mfa_enabled)
values (true, true)
on conflict (singleton) do nothing;
