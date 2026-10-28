-- P5.3 Digital health checks and online approval of extra work (D17, Pro
-- feature `health_checks`). docs/autofix/phase-5/P5.3-health-checks.md.
--
--   1. health_checks, health_check_items, health_check_media (tenant tables,
--      RLS; select policies follow membership only, write policies need the
--      Pro feature through garage_has_feature()).
--   2. Private storage bucket health-check-media, objects at
--      <garage_id>/health-checks/<check_id>/<uuid>.<ext>; staff of the selected
--      garage read their own folder; uploads use signed upload URLs created by
--      server code (as enquiry-attachments).
--   3. start_health_check() (staff), claim_health_check_send() and
--      open_health_check_link() / record_health_check_decisions() (service
--      role, for the server and the customer's token link) and
--      add_health_check_to_invoice() (staff with invoice rights, through the
--      existing save_invoice_draft()).
--
-- Nothing here redefines create_booking(), available_slots() or any existing
-- function: approvals land on the booking as a booking_events note and as
-- decided rows in health_check_items (the extras record), and on the invoice
-- through save_invoice_draft().
--
-- Rollback notes (manual): drop function public.add_health_check_to_invoice(uuid),
-- public.record_health_check_decisions(uuid, uuid, jsonb, timestamptz),
-- public.open_health_check_link(uuid, text, timestamptz),
-- public.claim_health_check_send(uuid, uuid, uuid, text, timestamptz, text, text),
-- public.start_health_check(uuid), public.health_check_editable(uuid, uuid),
-- public.health_check_default_items(boolean); drop the storage policy
-- "garage staff read health check media"; delete the bucket
-- health-check-media (after its objects); drop table public.health_check_media,
-- public.health_check_items, public.health_checks.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.health_checks (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  booking_id uuid not null,
  status text not null default 'draft',
  summary text,
  mileage integer,
  created_by uuid references auth.users(id) on delete set null,
  sent_by uuid references auth.users(id) on delete set null,
  token_hash text,
  token_expires_at timestamptz,
  sent_at timestamptz,
  sent_count integer not null default 0,
  sent_channel text,
  last_message_id uuid,
  first_viewed_at timestamptz,
  responded_at timestamptz,
  approved_total_pence bigint not null default 0,
  invoice_id uuid,
  invoiced_at timestamptz,
  invoiced_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint health_checks_garage_id_id_key unique (garage_id, id),
  constraint health_checks_booking_key unique (garage_id, booking_id),
  constraint health_checks_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade,
  constraint health_checks_last_message_id_fkey foreign key (garage_id, last_message_id)
    references public.messages (garage_id, id) on delete set null (last_message_id),
  constraint health_checks_invoice_id_fkey foreign key (garage_id, invoice_id)
    references public.invoices (garage_id, id) on delete set null (invoice_id),
  constraint health_checks_status_check check (status in ('draft', 'sent', 'responded')),
  constraint health_checks_summary_check check (summary is null or char_length(summary) <= 1000),
  constraint health_checks_mileage_check check (mileage is null or mileage between 0 and 2000000),
  constraint health_checks_token_hash_check check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  constraint health_checks_token_coherent check ((token_hash is null) = (token_expires_at is null)),
  constraint health_checks_sent_coherent check (status = 'draft' or (sent_at is not null and token_hash is not null)),
  constraint health_checks_responded_coherent check ((status = 'responded') = (responded_at is not null)),
  constraint health_checks_sent_channel_check check (sent_channel is null or sent_channel in ('sms', 'whatsapp', 'email')),
  constraint health_checks_sent_count_check check (sent_count between 0 and 1000),
  constraint health_checks_approved_total_check check (approved_total_pence between 0 and 9007199254740991)
);

comment on table public.health_checks is
  'P5.3: one digital vehicle health check per booking. draft (technician filling) -> sent (customer link out) -> responded (customer decided). The customer link token is stored only as its SHA-256 hex (token_hash) with an expiry.';
comment on column public.health_checks.approved_total_pence is
  'Sum of the customer-approved recommended work (pence, the amount the customer pays; invoices carry no VAT, tax_pence = 0).';

create unique index health_checks_token_hash_idx on public.health_checks (token_hash) where token_hash is not null;
create index health_checks_garage_status_idx on public.health_checks (garage_id, status, updated_at desc);

create trigger health_checks_set_updated_at
  before update on public.health_checks
  for each row execute function public.set_updated_at();

create table public.health_check_items (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  check_id uuid not null,
  section text not null,
  label text not null,
  position integer not null default 0,
  mot_related boolean not null default false,
  rating text not null default 'not_checked',
  note text,
  recommended_work text,
  price_pence bigint,
  decision text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint health_check_items_garage_id_id_key unique (garage_id, id),
  constraint health_check_items_check_id_fkey foreign key (garage_id, check_id)
    references public.health_checks (garage_id, id) on delete cascade,
  constraint health_check_items_section_check check (section in (
    'tyres', 'brakes', 'lights', 'wipers', 'fluids', 'suspension', 'exhaust', 'battery', 'mot', 'other'
  )),
  constraint health_check_items_label_check check (char_length(btrim(label)) between 1 and 120),
  constraint health_check_items_position_check check (position between 0 and 999),
  constraint health_check_items_rating_check check (rating in ('red', 'amber', 'green', 'not_checked')),
  constraint health_check_items_note_check check (note is null or char_length(note) <= 1000),
  constraint health_check_items_work_check check (recommended_work is null or char_length(btrim(recommended_work)) between 1 and 300),
  constraint health_check_items_price_check check (price_pence is null or price_pence between 0 and 10000000),
  constraint health_check_items_work_priced check ((recommended_work is null) = (price_pence is null)),
  constraint health_check_items_decision_check check (decision is null or decision in ('approved', 'declined')),
  constraint health_check_items_decision_coherent check (
    (decision is null and decided_at is null)
    or (decision is not null and decided_at is not null and recommended_work is not null)
  )
);

comment on table public.health_check_items is
  'P5.3: one checklist line of a health check: red/amber/green/not checked, a note, optional recommended work with a price (pence) and the customer''s decision (approved/declined). Approved rows are the booking''s extras record.';

create index health_check_items_check_idx on public.health_check_items (garage_id, check_id, position);

create trigger health_check_items_set_updated_at
  before update on public.health_check_items
  for each row execute function public.set_updated_at();

create table public.health_check_media (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  check_id uuid not null,
  item_id uuid,
  object_path text not null,
  content_type text not null,
  size_bytes bigint not null,
  kind text not null,
  uploaded boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint health_check_media_garage_id_id_key unique (garage_id, id),
  constraint health_check_media_object_path_key unique (object_path),
  constraint health_check_media_check_id_fkey foreign key (garage_id, check_id)
    references public.health_checks (garage_id, id) on delete cascade,
  constraint health_check_media_item_id_fkey foreign key (garage_id, item_id)
    references public.health_check_items (garage_id, id) on delete cascade,
  -- The object sits in the garage's own folder, under this check.
  constraint health_check_media_path_check check (
    object_path ~ '^[0-9a-f-]{36}/health-checks/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov)$'
    and split_part(object_path, '/', 1) = garage_id::text
    and split_part(object_path, '/', 3) = check_id::text
  ),
  constraint health_check_media_type_check check (
    (kind = 'image' and content_type in ('image/jpeg', 'image/png', 'image/webp') and size_bytes between 1 and 10485760)
    or (kind = 'video' and content_type in ('video/mp4', 'video/quicktime') and size_bytes between 1 and 52428800)
  )
);

comment on table public.health_check_media is
  'P5.3: photos (JPEG/PNG/WebP, <= 10 MB) and videos (MP4/MOV, <= 50 MB) for a health check or one of its items, in the private health-check-media bucket. uploaded is set by the server once the object exists. Served only through short-lived signed URLs.';

create index health_check_media_check_idx on public.health_check_media (garage_id, check_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- Whether staff may still change the check's checklist and media: before the
-- customer has decided (draft or sent).
create function public.health_check_editable(p_garage_id uuid, p_check_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.health_checks health_check
    where health_check.garage_id = p_garage_id
      and health_check.id = p_check_id
      and health_check.status in ('draft', 'sent')
      and (
        auth.role() = 'service_role'
        or current_setting('role', true) = 'service_role'
        or public.garage_role(p_garage_id) is not null
      )
  )
$$;

comment on function public.health_check_editable(uuid, uuid) is
  'P5.3: true while a health check is draft or sent (the customer has not decided). Used by the write policies on health_check_items and health_check_media.';

-- The default checklist. MOT-related lines only for garages with MOT on.
-- The same list (labels and order) is DEFAULT_CHECKLIST in src/lib/health-checks/checklist.ts.
create function public.health_check_default_items(p_mot_enabled boolean)
returns table (section text, label text, item_position integer, mot_related boolean)
language sql
immutable
set search_path = ''
as $$
  select item.section, item.label, item.ord::integer * 10, item.section = 'mot'
  from (values
    ('tyres', 'Front left tyre', 1),
    ('tyres', 'Front right tyre', 2),
    ('tyres', 'Rear left tyre', 3),
    ('tyres', 'Rear right tyre', 4),
    ('tyres', 'Spare wheel or repair kit', 5),
    ('brakes', 'Front brake pads and discs', 6),
    ('brakes', 'Rear brakes', 7),
    ('brakes', 'Brake fluid', 8),
    ('lights', 'Headlights and sidelights', 9),
    ('lights', 'Brake lights, indicators and hazards', 10),
    ('wipers', 'Wiper blades', 11),
    ('wipers', 'Washer jets and screenwash', 12),
    ('fluids', 'Engine oil level', 13),
    ('fluids', 'Coolant level', 14),
    ('fluids', 'Power steering fluid', 15),
    ('suspension', 'Shock absorbers', 16),
    ('suspension', 'Springs, arms and bushes', 17),
    ('suspension', 'Steering joints and racks', 18),
    ('exhaust', 'Exhaust system and mounts', 19),
    ('battery', 'Battery condition', 20),
    ('mot', 'Seat belts', 21),
    ('mot', 'Horn', 22),
    ('mot', 'Number plates', 23),
    ('mot', 'Windscreen chips and cracks', 24),
    ('mot', 'Mirrors', 25)
  ) as item(section, label, ord)
  where item.section <> 'mot' or coalesce(p_mot_enabled, false)
$$;

comment on function public.health_check_default_items(boolean) is
  'P5.3: the default checklist (section, label, position, mot_related). MOT lines only when p_mot_enabled.';

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------

alter table public.health_checks enable row level security;
alter table public.health_check_items enable row level security;
alter table public.health_check_media enable row level security;

-- health_checks
--   "garage members read health checks"    select  members of the selected garage (any role; no plan check, so a downgraded garage keeps reading)
--   "garage members edit health checks"    update  members of the selected garage on Pro, before the customer decided (column grants: summary, mileage)
--   (insert through start_health_check(); sending, the customer's decisions and invoicing through the functions below)
create policy "garage members read health checks" on public.health_checks
  for select to authenticated
  using (garage_id = (select public.current_garage_id()));
create policy "garage members edit health checks" on public.health_checks
  for update to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and public.garage_has_feature(garage_id, 'health_checks')
    and status in ('draft', 'sent')
  )
  with check (
    garage_id = (select public.current_garage_id())
    and public.garage_has_feature(garage_id, 'health_checks')
    and status in ('draft', 'sent')
  );

-- health_check_items
--   "garage members read health check items"    select  members of the selected garage
--   "garage members add health check items"     insert  members of the selected garage on Pro, while the check is editable
--   "garage members edit health check items"    update  same, undecided lines only (column grants: rating, note, recommended_work, price_pence, label)
--   "garage members remove health check items"  delete  same, undecided lines only
create policy "garage members read health check items" on public.health_check_items
  for select to authenticated
  using (garage_id = (select public.current_garage_id()));
create policy "garage members add health check items" on public.health_check_items
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and public.garage_has_feature(garage_id, 'health_checks')
    and public.health_check_editable(garage_id, check_id)
    and decision is null
  );
create policy "garage members edit health check items" on public.health_check_items
  for update to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and public.garage_has_feature(garage_id, 'health_checks')
    and public.health_check_editable(garage_id, check_id)
    and decision is null
  )
  with check (
    garage_id = (select public.current_garage_id())
    and public.garage_has_feature(garage_id, 'health_checks')
    and public.health_check_editable(garage_id, check_id)
    and decision is null
  );
create policy "garage members remove health check items" on public.health_check_items
  for delete to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and public.garage_has_feature(garage_id, 'health_checks')
    and public.health_check_editable(garage_id, check_id)
    and decision is null
  );

-- health_check_media
--   "garage members read health check media"    select  members of the selected garage
--   "garage members add health check media"     insert  members of the selected garage on Pro, while the check is editable, as themselves
--   "garage members remove health check media"  delete  same
--   (uploaded is set by the server with the service role once the object exists)
create policy "garage members read health check media" on public.health_check_media
  for select to authenticated
  using (garage_id = (select public.current_garage_id()));
create policy "garage members add health check media" on public.health_check_media
  for insert to authenticated
  with check (
    garage_id = (select public.current_garage_id())
    and public.garage_has_feature(garage_id, 'health_checks')
    and public.health_check_editable(garage_id, check_id)
    and uploaded = false
    and created_by = (select auth.uid())
  );
create policy "garage members remove health check media" on public.health_check_media
  for delete to authenticated
  using (
    garage_id = (select public.current_garage_id())
    and public.garage_has_feature(garage_id, 'health_checks')
    and public.health_check_editable(garage_id, check_id)
  );

revoke all on public.health_checks from anon, authenticated;
revoke all on public.health_check_items from anon, authenticated;
revoke all on public.health_check_media from anon, authenticated;
grant select on public.health_checks to authenticated;
grant update (summary, mileage) on public.health_checks to authenticated;
grant select, delete on public.health_check_items to authenticated;
grant insert (check_id, section, label, position, rating, note, recommended_work, price_pence) on public.health_check_items to authenticated;
grant update (label, rating, note, recommended_work, price_pence) on public.health_check_items to authenticated;
grant select, delete on public.health_check_media to authenticated;
grant insert (check_id, item_id, object_path, content_type, size_bytes, kind) on public.health_check_media to authenticated;
grant select, insert, update, delete on public.health_checks, public.health_check_items, public.health_check_media to service_role;

-- ---------------------------------------------------------------------------
-- 4. Storage: private bucket, per-garage folders
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('health-check-media', 'health-check-media', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'])
on conflict (id) do nothing;

-- storage.objects (health-check-media, private)
--   "garage staff read health check media"  select  staff of the selected garage, own folder (signed URLs for the admin)
--   uploads use signed upload URLs created by server code after the RLS insert of the media row;
--   the customer page gets short-lived signed URLs from the server (service role)
create policy "garage staff read health check media" on storage.objects
  for select to authenticated
  using (bucket_id = 'health-check-media' and (storage.foldername(name))[1] = (select public.current_garage_id())::text);

-- ---------------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------------

-- Staff (any role, MFA rules of garage_actor_allowed()) open the health check
-- for a booking of the selected garage: the existing one, or a new draft with
-- the default checklist (MOT lines when the garage has MOT on). Idempotent.
-- Errors: UNAUTHORISED (42501), PLAN_REQUIRED: health_checks (P0001),
-- BOOKING_NOT_FOUND, BOOKING_CLOSED (cancelled or no-show).
create function public.start_health_check(p_booking_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  garage_scope uuid := public.current_garage_id();
  booking public.bookings%rowtype;
  check_id uuid;
  mot boolean;
begin
  if not coalesce(public.garage_actor_allowed(), false) then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  perform public.require_garage_feature(garage_scope, 'health_checks');

  select * into booking from public.bookings
  where garage_id = garage_scope and id = p_booking_id and deleted_at is null;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;

  select health_check.id into check_id from public.health_checks health_check
  where health_check.garage_id = garage_scope and health_check.booking_id = booking.id;
  if check_id is not null then
    return check_id;
  end if;
  if booking.status in ('cancelled', 'no_show') then
    raise exception 'BOOKING_CLOSED' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public.health_checks.booking:' || booking.id::text, 0));
  select health_check.id into check_id from public.health_checks health_check
  where health_check.garage_id = garage_scope and health_check.booking_id = booking.id;
  if check_id is not null then
    return check_id;
  end if;

  select garage.mot_enabled into mot from public.garages garage where garage.id = garage_scope;
  insert into public.health_checks (garage_id, booking_id, created_by)
  values (garage_scope, booking.id, auth.uid())
  returning id into check_id;
  insert into public.health_check_items (garage_id, check_id, section, label, position, mot_related)
  select garage_scope, check_id, item.section, item.label, item.item_position, item.mot_related
  from public.health_check_default_items(coalesce(mot, false)) item;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (garage_scope, auth.uid(), 'health_check.started', 'health_check', check_id::text,
          jsonb_build_object('bookingId', booking.id));
  return check_id;
end
$$;

comment on function public.start_health_check(uuid) is
  'P5.3: staff of the selected garage (garage_actor_allowed(), Pro) open the booking''s health check, creating it with the default checklist the first time. Returns the check id.';

-- Before the server sends the customer link (service role, as
-- claim_staff_reply()). Checks the member may send (owner, manager or front
-- desk), the garage has health checks, the check is not decided and has at
-- least one rated line, and the booking's customer can be reached on their
-- own channel: a service message about their own car, so no reminder consent,
-- but an opt-out (STOP) blocks texts and WhatsApp. Then stores the new link's
-- hash and expiry (an earlier link stops working), inserts the outbound
-- messages row (sending; the body never holds the token) and returns
--   {status: 'claimed', message_id, channel, to}
--   {status: 'skipped', reason}  not_allowed, plan_required, not_found, already_responded,
--                                nothing_checked, anonymised, opted_out, no_address, no_messaging_number
create function public.claim_health_check_send(
  p_garage_id uuid,
  p_check_id uuid,
  p_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_body text,
  p_provider text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  health_check public.health_checks%rowtype;
  customer public.customers%rowtype;
  send_channel text;
  send_to text;
  sender text;
  message_id uuid;
begin
  if p_garage_id is null or p_check_id is null or p_member_id is null then
    raise exception 'INVALID_ARGUMENT: garage, check and member are required' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_ARGUMENT: token hash' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '60 days' then
    raise exception 'INVALID_ARGUMENT: expiry' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 1600 then
    raise exception 'INVALID_ARGUMENT: body must be 1 to 1600 characters' using errcode = '22023';
  end if;
  if p_body ~ '/hc/[A-Za-z0-9_-]{20,}' then
    raise exception 'INVALID_ARGUMENT: the stored body must not hold the link token' using errcode = '22023';
  end if;
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_-]{0,39}$' then
    raise exception 'INVALID_ARGUMENT: provider is required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.garage_members member
    where member.garage_id = p_garage_id
      and member.user_id = p_member_id
      and member.role in ('owner', 'manager', 'front_desk')
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'not_allowed');
  end if;
  if not public.garage_has_feature(p_garage_id, 'health_checks') then
    return jsonb_build_object('status', 'skipped', 'reason', 'plan_required');
  end if;

  select * into health_check from public.health_checks
  where garage_id = p_garage_id and id = p_check_id
  for update;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'not_found');
  end if;
  if health_check.status = 'responded' then
    return jsonb_build_object('status', 'skipped', 'reason', 'already_responded');
  end if;
  if not exists (
    select 1 from public.health_check_items item
    where item.garage_id = p_garage_id and item.check_id = p_check_id and item.rating <> 'not_checked'
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'nothing_checked');
  end if;

  select customer_row.* into customer
  from public.bookings booking
  join public.customers customer_row on customer_row.garage_id = booking.garage_id and customer_row.id = booking.customer_id
  where booking.garage_id = p_garage_id and booking.id = health_check.booking_id
  for share of customer_row;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'not_found');
  end if;
  if customer.anonymised_at is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'anonymised');
  end if;

  send_channel := coalesce(customer.channel, 'sms');
  if send_channel = 'email' then
    send_to := nullif(btrim(coalesce(customer.email, '')), '');
    if send_to is null or send_to !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
      return jsonb_build_object('status', 'skipped', 'reason', 'no_address');
    end if;
  else
    if customer.opted_out_at is not null then
      return jsonb_build_object('status', 'skipped', 'reason', 'opted_out');
    end if;
    send_to := customer.phone;
    if send_to is null or send_to !~ '^\+[1-9][0-9]{6,14}$' then
      return jsonb_build_object('status', 'skipped', 'reason', 'no_address');
    end if;
    select phone_number.number into sender
    from public.garage_phone_numbers phone_number
    where phone_number.garage_id = p_garage_id
      and phone_number.purpose = 'messaging'
      and phone_number.provider_sid is not null
    order by phone_number.created_at
    limit 1;
    if sender is null then
      return jsonb_build_object('status', 'skipped', 'reason', 'no_messaging_number');
    end if;
  end if;

  insert into public.messages (garage_id, customer_id, booking_id, channel, direction, to_address, from_address, body, provider, status)
  values (p_garage_id, customer.id, health_check.booking_id, send_channel, 'outbound', send_to, sender, p_body, p_provider, 'sending')
  returning id into message_id;

  update public.health_checks
  set status = 'sent',
      token_hash = p_token_hash,
      token_expires_at = p_expires_at,
      sent_at = now(),
      sent_by = p_member_id,
      sent_count = least(sent_count + 1, 1000),
      sent_channel = send_channel,
      last_message_id = message_id
  where garage_id = p_garage_id and id = p_check_id;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (p_garage_id, p_member_id, 'health_check.sent', 'health_check', p_check_id::text,
          jsonb_build_object('channel', send_channel, 'sendCount', health_check.sent_count + 1));

  return jsonb_build_object('status', 'claimed', 'message_id', message_id, 'channel', send_channel, 'to', send_to);
end
$$;

comment on function public.claim_health_check_send(uuid, uuid, uuid, text, timestamptz, text, text) is
  'P5.3 (service role): claims sending a health check link to the booking''s customer. Stores the token hash and expiry, marks the check sent and inserts the outbound messages row (sending). Returns {status: claimed, message_id, channel, to} or {status: skipped, reason}.';

-- The customer's link (service role, from /hc/<token> on the garage host).
-- Returns {status: 'ok', check_id} or {status: 'invalid'} / {status: 'expired'}.
-- Notes the first view. Works for a decided check (read-only) until it expires.
create function public.open_health_check_link(p_garage_id uuid, p_token_hash text, p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  health_check public.health_checks%rowtype;
begin
  if p_garage_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into health_check from public.health_checks
  where garage_id = p_garage_id and token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  if health_check.token_expires_at <= p_now then
    return jsonb_build_object('status', 'expired');
  end if;
  if health_check.first_viewed_at is null then
    update public.health_checks set first_viewed_at = p_now
    where garage_id = p_garage_id and id = health_check.id;
  end if;
  return jsonb_build_object('status', 'ok', 'check_id', health_check.id);
end
$$;

comment on function public.open_health_check_link(uuid, text, timestamptz) is
  'P5.3 (service role): resolves a health check link token hash on the garage host. {status: ok, check_id} | {status: invalid} | {status: expired}.';

-- The customer's decisions (service role, from the /health-check page after
-- the signed session cookie was checked). p_decisions is
-- [{item_id, decision: approved|declined, price_pence}] and must name every
-- line with recommended work, at the price the customer saw. Idempotent: a
-- decided check returns {status: 'already', ...} unchanged. Returns
--   {status: 'recorded'|'already', approved_total_pence, approved_count, declined_count}
--   {status: 'not_found'|'closed'|'expired'|'plan_required'|'changed'|'invalid'}
create function public.record_health_check_decisions(
  p_garage_id uuid,
  p_check_id uuid,
  p_decisions jsonb,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  health_check public.health_checks%rowtype;
  item record;
  decision_row jsonb;
  wanted_ids uuid[];
  approved_total bigint := 0;
  approved_count integer := 0;
  declined_count integer := 0;
  approved_labels text[] := '{}';
  note_text text;
begin
  if p_garage_id is null or p_check_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_decisions is null or jsonb_typeof(p_decisions) <> 'array' or jsonb_array_length(p_decisions) > 200 then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into health_check from public.health_checks
  where garage_id = p_garage_id and id = p_check_id
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if health_check.status = 'responded' then
    return jsonb_build_object(
      'status', 'already',
      'approved_total_pence', health_check.approved_total_pence,
      'approved_count', (select count(*) from public.health_check_items i where i.garage_id = p_garage_id and i.check_id = p_check_id and i.decision = 'approved'),
      'declined_count', (select count(*) from public.health_check_items i where i.garage_id = p_garage_id and i.check_id = p_check_id and i.decision = 'declined')
    );
  end if;
  if health_check.status <> 'sent' then
    return jsonb_build_object('status', 'closed');
  end if;
  if health_check.token_expires_at is null or health_check.token_expires_at <= p_now then
    return jsonb_build_object('status', 'expired');
  end if;
  if not public.garage_has_feature(p_garage_id, 'health_checks') then
    return jsonb_build_object('status', 'plan_required');
  end if;

  -- Every decision names a distinct line with recommended work, at its current price.
  begin
    select array_agg((value ->> 'item_id')::uuid) into wanted_ids
    from jsonb_array_elements(p_decisions);
  exception
    when invalid_text_representation then
      return jsonb_build_object('status', 'invalid');
  end;
  wanted_ids := coalesce(wanted_ids, '{}');
  if cardinality(wanted_ids) <> (select count(distinct id) from unnest(wanted_ids) as ids(id)) then
    return jsonb_build_object('status', 'invalid');
  end if;
  for decision_row in select value from jsonb_array_elements(p_decisions) loop
    if coalesce(decision_row ->> 'decision', '') not in ('approved', 'declined') then
      return jsonb_build_object('status', 'invalid');
    end if;
  end loop;

  for item in
    select line.id, line.label, line.recommended_work, line.price_pence
    from public.health_check_items line
    where line.garage_id = p_garage_id and line.check_id = p_check_id and line.recommended_work is not null
    order by line.position, line.created_at
    for update
  loop
    select value into decision_row
    from jsonb_array_elements(p_decisions)
    where (value ->> 'item_id')::uuid = item.id;
    if decision_row is null
       or (decision_row ->> 'price_pence') is null
       or (decision_row ->> 'price_pence') !~ '^[0-9]{1,9}$'
       or (decision_row ->> 'price_pence')::bigint <> item.price_pence then
      return jsonb_build_object('status', 'changed');
    end if;
    if decision_row ->> 'decision' = 'approved' then
      approved_total := approved_total + item.price_pence;
      approved_count := approved_count + 1;
      approved_labels := approved_labels || item.recommended_work;
    else
      declined_count := declined_count + 1;
    end if;
  end loop;
  if cardinality(wanted_ids) <> approved_count + declined_count then
    -- A decision for a line that has no recommended work (or no longer exists).
    return jsonb_build_object('status', 'changed');
  end if;

  update public.health_check_items line
  set decision = decided.value ->> 'decision',
      decided_at = p_now
  from jsonb_array_elements(p_decisions) decided
  where line.garage_id = p_garage_id
    and line.check_id = p_check_id
    and line.id = (decided.value ->> 'item_id')::uuid;

  update public.health_checks
  set status = 'responded',
      responded_at = p_now,
      approved_total_pence = approved_total
  where garage_id = p_garage_id and id = p_check_id;

  note_text := case
    when approved_count + declined_count = 0 then 'Health check: the customer has seen it. No extra work was recommended.'
    when approved_count = 0 then format('Health check: the customer declined the recommended work (%s item%s).', declined_count, case when declined_count = 1 then '' else 's' end)
    else format('Health check: the customer approved £%s of extra work: %s.%s',
                to_char(approved_total / 100.0, 'FM999,999,990.00'),
                array_to_string(approved_labels, '; '),
                case when declined_count > 0 then format(' Declined %s item%s.', declined_count, case when declined_count = 1 then '' else 's' end) else '' end)
  end;
  insert into public.booking_events (garage_id, booking_id, type, actor, at, data)
  values (p_garage_id, health_check.booking_id, 'note', 'customer', p_now,
          jsonb_build_object('text', left(note_text, 1000), 'source', 'health_check', 'healthCheckId', p_check_id,
                             'approvedTotalPence', approved_total, 'approvedCount', approved_count, 'declinedCount', declined_count));

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (p_garage_id, null, 'health_check.responded', 'health_check', p_check_id::text,
          jsonb_build_object('approvedTotalPence', approved_total, 'approvedCount', approved_count, 'declinedCount', declined_count));

  return jsonb_build_object('status', 'recorded', 'approved_total_pence', approved_total,
                            'approved_count', approved_count, 'declined_count', declined_count);
end
$$;

comment on function public.record_health_check_decisions(uuid, uuid, jsonb, timestamptz) is
  'P5.3 (service role): records the customer''s approve/decline for every line with recommended work (prices must match what they saw), marks the check responded, adds a booking_events note and returns the approved total. Idempotent.';

-- Staff with invoice rights (save_invoice_draft()'s own checks: garage_actor_allowed()
-- and AAL2 when enrolled) put the approved work on the booking's draft invoice:
-- the newest draft for the booking gets the approved lines appended, otherwise a
-- new booking draft is created with them. Once per check (until that invoice is
-- deleted). Lines: "Health check: <work> (<line>)", quantity 1, the approved price;
-- no VAT (invoices carry tax_pence = 0). Returns {invoice_id, added, created, already}.
-- Errors: UNAUTHORISED (42501), PLAN_REQUIRED: health_checks, HEALTH_CHECK_NOT_FOUND,
-- HEALTH_CHECK_NOT_RESPONDED, NOTHING_APPROVED, INVOICE_ITEM_COUNT_INVALID and
-- save_invoice_draft()'s own errors.
create function public.add_health_check_to_invoice(p_check_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.require_invoice_actor();
  garage_scope uuid := public.current_garage_id();
  health_check public.health_checks%rowtype;
  draft public.invoices%rowtype;
  existing_items jsonb;
  new_items jsonb;
  payload jsonb;
  target_id uuid;
  added integer;
begin
  perform public.require_garage_feature(garage_scope, 'health_checks');

  select * into health_check from public.health_checks
  where garage_id = garage_scope and id = p_check_id
  for update;
  if not found then
    raise exception 'HEALTH_CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;
  if health_check.status <> 'responded' then
    raise exception 'HEALTH_CHECK_NOT_RESPONDED' using errcode = 'P0001';
  end if;
  if health_check.invoice_id is not null and exists (
    select 1 from public.invoices invoice
    where invoice.garage_id = garage_scope and invoice.id = health_check.invoice_id and invoice.deleted_at is null
  ) then
    return jsonb_build_object('invoice_id', health_check.invoice_id, 'added', 0, 'created', false, 'already', true);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'description', left('Health check: ' || item.recommended_work || ' (' || item.label || ')', 500),
           'quantity', 1,
           'unit_price_pence', item.price_pence
         ) order by item.position, item.created_at), '[]'::jsonb),
         count(*)
  into new_items, added
  from public.health_check_items item
  where item.garage_id = garage_scope and item.check_id = p_check_id and item.decision = 'approved';
  if added = 0 then
    raise exception 'NOTHING_APPROVED' using errcode = 'P0001';
  end if;

  select * into draft from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.booking_id = health_check.booking_id
    and invoice.status = 'draft'
    and invoice.deleted_at is null
  order by invoice.created_at desc
  limit 1
  for update;

  if found then
    select coalesce(jsonb_agg(jsonb_build_object(
             'description', item.description,
             'quantity', item.quantity,
             'unit_price_pence', item.unit_price_pence
           ) order by item.position), '[]'::jsonb)
    into existing_items
    from public.invoice_items item
    where item.garage_id = garage_scope and item.invoice_id = draft.id;
    if jsonb_array_length(existing_items) + added > 100 then
      raise exception 'INVOICE_ITEM_COUNT_INVALID' using errcode = 'P0001';
    end if;
    payload := jsonb_build_object(
      'source_type', draft.source_type,
      'booking_id', draft.booking_id,
      'enquiry_id', draft.enquiry_id,
      'customer_id', draft.customer_id,
      'vehicle_id', draft.vehicle_id,
      'customer_name', draft.customer_name,
      'customer_email', draft.customer_email,
      'customer_phone', draft.customer_phone,
      'customer_address', draft.customer_address,
      'vehicle_registration', draft.vehicle_registration,
      'vehicle_make', draft.vehicle_make,
      'vehicle_model', draft.vehicle_model,
      'service_name', draft.service_name,
      'appointment_start', draft.appointment_start,
      'issue_date', draft.issue_date,
      'due_date', draft.due_date,
      'notes', draft.notes,
      'payment_terms', draft.payment_terms,
      'discount_pence', draft.discount_pence,
      'tax_pence', 0,
      'items', existing_items || new_items
    );
    target_id := public.save_invoice_draft(draft.id, payload, false);
  else
    payload := jsonb_build_object(
      'source_type', 'booking',
      'booking_id', health_check.booking_id,
      'discount_pence', 0,
      'tax_pence', 0,
      'items', new_items
    );
    -- Extra work on a booking that may already have an issued invoice: a further draft is intended.
    target_id := public.save_invoice_draft(null, payload, true);
  end if;

  update public.health_checks
  set invoice_id = target_id, invoiced_at = now(), invoiced_by = actor_id
  where garage_id = garage_scope and id = p_check_id;

  insert into public.booking_events (garage_id, booking_id, type, actor, actor_id, data)
  values (garage_scope, health_check.booking_id, 'note', 'staff', actor_id,
          jsonb_build_object('text', format('Approved health check work (£%s) added to a draft invoice.',
                                            to_char(health_check.approved_total_pence / 100.0, 'FM999,999,990.00')),
                             'source', 'health_check', 'healthCheckId', p_check_id, 'invoiceId', target_id));

  return jsonb_build_object('invoice_id', target_id, 'added', added, 'created', draft.id is null, 'already', false);
end
$$;

comment on function public.add_health_check_to_invoice(uuid) is
  'P5.3: staff with invoice rights (save_invoice_draft()) add the customer-approved health check work to the booking''s newest draft invoice, or a new booking draft. Once per check. Returns {invoice_id, added, created, already}.';

revoke all on function public.health_check_editable(uuid, uuid) from public, anon;
revoke all on function public.health_check_default_items(boolean) from public, anon;
revoke all on function public.start_health_check(uuid) from public, anon;
revoke all on function public.claim_health_check_send(uuid, uuid, uuid, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.open_health_check_link(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_health_check_decisions(uuid, uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.add_health_check_to_invoice(uuid) from public, anon;

grant execute on function public.health_check_editable(uuid, uuid) to authenticated, service_role;
grant execute on function public.health_check_default_items(boolean) to authenticated, service_role;
grant execute on function public.start_health_check(uuid) to authenticated;
grant execute on function public.claim_health_check_send(uuid, uuid, uuid, text, timestamptz, text, text) to service_role;
grant execute on function public.open_health_check_link(uuid, text, timestamptz) to service_role;
grant execute on function public.record_health_check_decisions(uuid, uuid, jsonb, timestamptz) to service_role;
grant execute on function public.add_health_check_to_invoice(uuid) to authenticated;
