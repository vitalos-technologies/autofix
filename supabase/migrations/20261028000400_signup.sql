-- Autofix sign-up and onboarding (P4.4).
--
-- docs/autofix/ARCHITECTURE.md "Sign-up and onboarding" and DECISIONS.md
-- A100-A111:
--
--   1. garage_members.role gains 'front_desk' (same rights as a technician
--      for now: reads, booking status and notes).
--   2. reserved_garage_slugs(): the labels that can never be a garage slug,
--      kept equal to RESERVED_SLUGS in src/lib/tenancy/hosts.ts (a unit test
--      compares the two).
--   3. create_garage(p_user_id, p_garage) (service role): one transaction that
--      creates the garage (status 'onboarding'), its owner, opening hours from
--      Google Places when given, seed_garage_defaults() and an audit row.
--   4. complete_garage_onboarding() (owner of the selected garage, MFA done):
--      'onboarding' -> 'active' once the DPA has been accepted.
--   5. garage_invites (tenant): staff invitations by email and role, the
--      token stored only as a SHA-256 hash. Owners and managers create,
--      resend and revoke them through security definer functions; the
--      invited person accepts with accept_garage_invite(token_hash).
--   6. list_garage_team(): members of the selected garage with their email
--      and display name (auth.users is not readable by staff), and
--      auth_email_exists() (service role) for the invite accept page.

-- ---------------------------------------------------------------------------
-- 1. Front desk role
-- ---------------------------------------------------------------------------

alter table public.garage_members
  drop constraint garage_members_role_check,
  add constraint garage_members_role_check check (role in ('owner', 'manager', 'technician', 'front_desk'));

-- ---------------------------------------------------------------------------
-- 2. Reserved slugs
-- ---------------------------------------------------------------------------

create function public.reserved_garage_slugs()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'admin', 'api', 'app', 'assets', 'auth', 'billing', 'book', 'cdn', 'dashboard', 'dev', 'docs', 'help',
    'mail', 'ns1', 'ns2', 'platform', 'smtp', 'staging', 'static', 'status', 'support', 'test', 'www'
  ]::text[]
$$;

comment on function public.reserved_garage_slugs() is
  'Subdomain labels that can never be a garage slug. Must equal RESERVED_SLUGS in src/lib/tenancy/hosts.ts.';

-- A 2-4 letter booking prefix from the garage name: the initials of its words
-- ("Hartley Road Motors" -> HRM), else its first letters, padded with G.
create function public.garage_booking_prefix(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  words text[];
  initials text := '';
  letters text;
  word text;
begin
  words := regexp_split_to_array(upper(coalesce(p_name, '')), '[^A-Z0-9]+');
  foreach word in array words loop
    if word ~ '^[A-Z]' then
      initials := initials || left(word, 1);
    end if;
  end loop;
  if char_length(initials) >= 2 then
    return left(initials, 4);
  end if;
  letters := regexp_replace(upper(coalesce(p_name, '')), '[^A-Z]', '', 'g');
  return rpad(left(letters, 3), greatest(2, least(3, char_length(letters))), 'G');
end
$$;

-- ---------------------------------------------------------------------------
-- 3. create_garage
-- ---------------------------------------------------------------------------

-- p_garage keys: name (required), slug (required), phone (E.164), email,
-- website (https URL), google_place_id, address {line1, line2, town,
-- postcode}, opening_hours [{weekday 1-7, opens 'HH:MM', closes 'HH:MM'}]
-- (from Google Places; when empty the default hours are seeded).
-- Errors (P0001): USER_NOT_FOUND, EMAIL_NOT_CONFIRMED, INVALID_GARAGE: <field>,
-- SLUG_RESERVED, SLUG_TAKEN, GARAGE_LIMIT_REACHED.
create function public.create_garage(p_user_id uuid, p_garage jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  new_garage_id uuid;
  garage_name text := btrim(coalesce(p_garage ->> 'name', ''));
  garage_slug text := lower(btrim(coalesce(p_garage ->> 'slug', '')));
  garage_phone text := nullif(btrim(coalesce(p_garage ->> 'phone', '')), '');
  garage_email text := nullif(lower(btrim(coalesce(p_garage ->> 'email', ''))), '');
  garage_website text := nullif(btrim(coalesce(p_garage ->> 'website', '')), '');
  place_id text := nullif(btrim(coalesce(p_garage ->> 'google_place_id', '')), '');
  raw_address jsonb := p_garage -> 'address';
  clean_address jsonb := null;
  hours jsonb := coalesce(p_garage -> 'opening_hours', '[]'::jsonb);
  hour_row jsonb;
  hours_added integer := 0;
  confirmed_at timestamptz;
  recent_count integer;
  seeded jsonb;
  address_key text;
begin
  if p_user_id is null or p_garage is null or jsonb_typeof(p_garage) <> 'object' then
    raise exception 'INVALID_GARAGE: payload' using errcode = 'P0001';
  end if;

  select coalesce(account.email_confirmed_at, account.confirmed_at) into confirmed_at
  from auth.users account
  where account.id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if confirmed_at is null then
    raise exception 'EMAIL_NOT_CONFIRMED' using errcode = 'P0001';
  end if;

  -- Serialise sign-ups per user so the limit below cannot be raced.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('create_garage:' || p_user_id::text, 0));
  select count(*) into recent_count
  from public.admin_audit_log entry
  where entry.actor_id = p_user_id
    and entry.action = 'garage.created'
    and entry.created_at > now() - interval '24 hours';
  if recent_count >= 3 then
    raise exception 'GARAGE_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  if char_length(garage_name) not between 2 and 120 then
    raise exception 'INVALID_GARAGE: name' using errcode = 'P0001';
  end if;
  if char_length(garage_slug) not between 3 and 40 or garage_slug !~ '^[a-z0-9](-?[a-z0-9])*$' then
    raise exception 'INVALID_GARAGE: slug' using errcode = 'P0001';
  end if;
  if garage_slug = any (public.reserved_garage_slugs()) then
    raise exception 'SLUG_RESERVED' using errcode = 'P0001';
  end if;
  if garage_phone is not null and garage_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'INVALID_GARAGE: phone' using errcode = 'P0001';
  end if;
  if garage_email is not null and (char_length(garage_email) > 254 or garage_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'INVALID_GARAGE: email' using errcode = 'P0001';
  end if;
  if garage_website is not null and (char_length(garage_website) > 300 or garage_website !~ '^https?://[^[:space:]]+$') then
    raise exception 'INVALID_GARAGE: website' using errcode = 'P0001';
  end if;
  if place_id is not null and (char_length(place_id) > 300 or place_id !~ '^[A-Za-z0-9_-]+$') then
    raise exception 'INVALID_GARAGE: google_place_id' using errcode = 'P0001';
  end if;

  if raw_address is not null and jsonb_typeof(raw_address) <> 'null' then
    if jsonb_typeof(raw_address) <> 'object' then
      raise exception 'INVALID_GARAGE: address' using errcode = 'P0001';
    end if;
    clean_address := '{}'::jsonb;
    foreach address_key in array array['line1', 'line2', 'town', 'postcode'] loop
      if raw_address ? address_key and jsonb_typeof(raw_address -> address_key) not in ('string', 'null') then
        raise exception 'INVALID_GARAGE: address' using errcode = 'P0001';
      end if;
      if nullif(btrim(coalesce(raw_address ->> address_key, '')), '') is not null then
        if char_length(btrim(raw_address ->> address_key)) > 120 then
          raise exception 'INVALID_GARAGE: address' using errcode = 'P0001';
        end if;
        clean_address := clean_address || jsonb_build_object(address_key, btrim(raw_address ->> address_key));
      end if;
    end loop;
    if clean_address = '{}'::jsonb then
      clean_address := null;
    end if;
  end if;

  if jsonb_typeof(hours) <> 'array' or jsonb_array_length(hours) > 28 then
    raise exception 'INVALID_GARAGE: opening_hours' using errcode = 'P0001';
  end if;

  begin
    insert into public.garages (slug, name, phone, email, address, booking_prefix, status, settings)
    values (
      garage_slug,
      garage_name,
      garage_phone,
      garage_email,
      clean_address,
      public.garage_booking_prefix(garage_name),
      'onboarding',
      jsonb_strip_nulls(jsonb_build_object(
        'website', garage_website,
        'google_place_id', place_id,
        'onboarding', jsonb_build_object('started_at', now())
      ))
    )
    returning id into new_garage_id;
  exception
    when unique_violation then
      raise exception 'SLUG_TAKEN' using errcode = 'P0001';
  end;

  insert into public.garage_members (garage_id, user_id, role) values (new_garage_id, p_user_id, 'owner');

  for hour_row in select value from jsonb_array_elements(hours) loop
    begin
      insert into public.opening_hours (garage_id, weekday, opens, closes)
      values (
        new_garage_id,
        (hour_row ->> 'weekday')::smallint,
        (hour_row ->> 'opens')::time,
        (hour_row ->> 'closes')::time
      );
      hours_added := hours_added + 1;
    exception
      when check_violation or invalid_text_representation or invalid_datetime_format
        or datetime_field_overflow or not_null_violation or exclusion_violation or numeric_value_out_of_range then
        raise exception 'INVALID_GARAGE: opening_hours' using errcode = 'P0001';
    end;
  end loop;

  seeded := public.seed_garage_defaults(new_garage_id);

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    new_garage_id, p_user_id, 'garage.created', 'garage', new_garage_id::text,
    jsonb_build_object('slug', garage_slug, 'from_places', place_id is not null, 'opening_hours_from_places', hours_added)
  );

  return jsonb_build_object(
    'garage_id', new_garage_id,
    'slug', garage_slug,
    'status', 'onboarding',
    'opening_hours_from_places', hours_added,
    'seeded', seeded
  );
end
$$;

comment on function public.create_garage(uuid, jsonb) is
  'Service role only (sign-up). Creates a garage in onboarding with its owner, Places opening hours, seed_garage_defaults() and an audit row, in one transaction. At most 3 per user per 24 hours.';

-- ---------------------------------------------------------------------------
-- 4. complete_garage_onboarding
-- ---------------------------------------------------------------------------

-- The selected garage's owner (MFA as garage_actor_allowed()) finishes the
-- wizard: the DPA must be accepted. Idempotent for an already active garage.
create function public.complete_garage_onboarding()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target uuid := public.current_garage_id();
  current_status text;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() is distinct from 'owner' then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;

  select garage.status into current_status from public.garages garage where garage.id = target for update;
  if current_status = 'active' then
    return 'active';
  end if;
  if current_status is distinct from 'onboarding' then
    raise exception 'GARAGE_NOT_ONBOARDING' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.garage_agreements agreement
    where agreement.garage_id = target and agreement.kind = 'dpa'
  ) then
    raise exception 'DPA_NOT_ACCEPTED' using errcode = 'P0001';
  end if;

  update public.garages garage
  set status = 'active',
      settings = jsonb_set(
        garage.settings,
        '{onboarding}',
        coalesce(garage.settings -> 'onboarding', '{}'::jsonb) || jsonb_build_object('completed_at', now())
      )
  where garage.id = target;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target, auth.uid(), 'garage.onboarding_completed', 'garage', target::text, '{}'::jsonb);
  return 'active';
end
$$;

comment on function public.complete_garage_onboarding() is
  'Owner of the selected garage (MFA rules of garage_actor_allowed()). onboarding -> active once a DPA is accepted.';

-- ---------------------------------------------------------------------------
-- 5. Staff invites
-- ---------------------------------------------------------------------------

create table public.garage_invites (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  email text not null,
  role text not null,
  token_hash text not null,
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  sent_count integer not null default 1,
  last_sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint garage_invites_garage_id_id_key unique (garage_id, id),
  constraint garage_invites_token_hash_key unique (token_hash),
  constraint garage_invites_email_check check (
    email = lower(email) and char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint garage_invites_role_check check (role in ('manager', 'technician', 'front_desk')),
  constraint garage_invites_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint garage_invites_state_check check (not (accepted_at is not null and revoked_at is not null))
);

comment on table public.garage_invites is
  'Staff invitations (P4.4). The link token is stored only as hex SHA-256; rows change only through the invite functions.';

-- One open invite per email per garage; accepted and revoked rows stay as history.
create unique index garage_invites_open_email_key on public.garage_invites (garage_id, email)
  where accepted_at is null and revoked_at is null;
create index garage_invites_garage_created_idx on public.garage_invites (garage_id, created_at desc);

create trigger garage_invites_updated before update on public.garage_invites
  for each row execute function public.set_updated_at();

alter table public.garage_invites enable row level security;

-- garage_invites
--   "owners and managers read invites"  select  owners/managers of the selected garage; a backstop only:
--                                        staff hold no grant, they list through list_garage_invites()
--   no insert/update/delete for staff: create_garage_invite(), resend_garage_invite(),
--   revoke_garage_invite() and accept_garage_invite() write them
create policy "owners and managers read invites" on public.garage_invites
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

grant select, insert, update, delete on public.garage_invites to service_role;

-- Invites last 7 days from the last send.
create function public.garage_invite_expiry()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select now() + interval '7 days'
$$;

-- Creates an invite (or re-sends the open one for that email with the new
-- token and role). Owners and managers of the selected garage, MFA as
-- garage_actor_allowed(). Errors: UNAUTHORISED (42501), INVALID_INVITE,
-- INVITE_ALREADY_MEMBER (P0001).
create function public.create_garage_invite(p_email text, p_role text, p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target uuid := public.current_garage_id();
  clean_email text := lower(btrim(coalesce(p_email, '')));
  invite public.garage_invites;
  resent boolean := false;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  if char_length(clean_email) > 254 or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'INVALID_INVITE: email' using errcode = 'P0001';
  end if;
  if p_role is null or p_role not in ('manager', 'technician', 'front_desk') then
    raise exception 'INVALID_INVITE: role' using errcode = 'P0001';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INVITE: token' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.garage_members member
    join auth.users account on account.id = member.user_id
    where member.garage_id = target and lower(account.email) = clean_email
  ) then
    raise exception 'INVITE_ALREADY_MEMBER' using errcode = 'P0001';
  end if;

  update public.garage_invites existing
  set role = p_role,
      token_hash = p_token_hash,
      expires_at = public.garage_invite_expiry(),
      invited_by = auth.uid(),
      sent_count = existing.sent_count + 1,
      last_sent_at = now()
  where existing.garage_id = target
    and existing.email = clean_email
    and existing.accepted_at is null
    and existing.revoked_at is null
  returning * into invite;

  if invite.id is null then
    insert into public.garage_invites (garage_id, email, role, token_hash, invited_by, expires_at)
    values (target, clean_email, p_role, p_token_hash, auth.uid(), public.garage_invite_expiry())
    returning * into invite;
  else
    resent := true;
  end if;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    target, auth.uid(), case when resent then 'invite.resent' else 'invite.created' end, 'garage_invite', invite.id::text,
    jsonb_build_object('role', invite.role)
  );

  return jsonb_build_object('id', invite.id, 'email', invite.email, 'role', invite.role, 'expires_at', invite.expires_at, 'resent', resent);
end
$$;

-- New token and expiry for an open invite of the selected garage.
create function public.resend_garage_invite(p_invite_id uuid, p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target uuid := public.current_garage_id();
  invite public.garage_invites;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INVITE: token' using errcode = 'P0001';
  end if;

  update public.garage_invites existing
  set token_hash = p_token_hash,
      expires_at = public.garage_invite_expiry(),
      sent_count = existing.sent_count + 1,
      last_sent_at = now()
  where existing.garage_id = target
    and existing.id = p_invite_id
    and existing.accepted_at is null
    and existing.revoked_at is null
  returning * into invite;
  if invite.id is null then
    raise exception 'INVITE_NOT_FOUND' using errcode = 'P0001';
  end if;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target, auth.uid(), 'invite.resent', 'garage_invite', invite.id::text, jsonb_build_object('role', invite.role));
  return jsonb_build_object('id', invite.id, 'email', invite.email, 'role', invite.role, 'expires_at', invite.expires_at, 'resent', true);
end
$$;

create function public.revoke_garage_invite(p_invite_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target uuid := public.current_garage_id();
  revoked_id uuid;
begin
  if not coalesce(public.garage_actor_allowed(), false) or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;

  update public.garage_invites existing
  set revoked_at = now()
  where existing.garage_id = target
    and existing.id = p_invite_id
    and existing.accepted_at is null
    and existing.revoked_at is null
  returning existing.id into revoked_id;
  if revoked_id is null then
    return false;
  end if;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (target, auth.uid(), 'invite.revoked', 'garage_invite', revoked_id::text, '{}'::jsonb);
  return true;
end
$$;

-- The signed-in user accepts the invite the token belongs to. The account's
-- email must be the invited one. A user who is already a member keeps their
-- role. Errors (P0001): INVITE_NOT_FOUND (unknown, revoked or accepted),
-- INVITE_EXPIRED, INVITE_EMAIL_MISMATCH, GARAGE_UNAVAILABLE.
create function public.accept_garage_invite(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  invite public.garage_invites;
  account_email text;
  existing_role text;
  garage_status text;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'UNAUTHORISED' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVITE_NOT_FOUND' using errcode = 'P0001';
  end if;

  select * into invite
  from public.garage_invites candidate
  where candidate.token_hash = p_token_hash
    and candidate.accepted_at is null
    and candidate.revoked_at is null
  for update;
  if invite.id is null then
    raise exception 'INVITE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if invite.expires_at <= now() then
    raise exception 'INVITE_EXPIRED' using errcode = 'P0001';
  end if;

  select garage.status into garage_status from public.garages garage where garage.id = invite.garage_id;
  if garage_status is null or garage_status not in ('onboarding', 'active') then
    raise exception 'GARAGE_UNAVAILABLE' using errcode = 'P0001';
  end if;

  select lower(account.email) into account_email from auth.users account where account.id = auth.uid();
  if account_email is distinct from invite.email then
    raise exception 'INVITE_EMAIL_MISMATCH' using errcode = 'P0001';
  end if;

  select member.role into existing_role
  from public.garage_members member
  where member.garage_id = invite.garage_id and member.user_id = auth.uid();
  if existing_role is null then
    insert into public.garage_members (garage_id, user_id, role) values (invite.garage_id, auth.uid(), invite.role);
  end if;

  update public.garage_invites accepted
  set accepted_at = now(), accepted_by = auth.uid()
  where accepted.id = invite.id;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (
    invite.garage_id, auth.uid(), 'invite.accepted', 'garage_invite', invite.id::text,
    jsonb_build_object('role', coalesce(existing_role, invite.role), 'already_member', existing_role is not null)
  );

  return jsonb_build_object(
    'garage_id', invite.garage_id,
    'role', coalesce(existing_role, invite.role),
    'already_member', existing_role is not null
  );
end
$$;

-- Open invites of the selected garage, for owners and managers (never the token hash).
create function public.list_garage_invites()
returns table (id uuid, email text, role text, expires_at timestamptz, last_sent_at timestamptz, sent_count integer, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select invite.id, invite.email, invite.role, invite.expires_at, invite.last_sent_at, invite.sent_count, invite.created_at
  from public.garage_invites invite
  where invite.garage_id = public.current_garage_id()
    and public.current_garage_role() in ('owner', 'manager')
    and invite.accepted_at is null
    and invite.revoked_at is null
  order by invite.created_at desc
$$;

-- ---------------------------------------------------------------------------
-- 6. Team list
-- ---------------------------------------------------------------------------

-- Members of the selected garage. Every member sees names and roles; only
-- owners and managers see email addresses.
create function public.list_garage_team()
returns table (user_id uuid, email text, display_name text, role text, joined_at timestamptz, is_self boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    member.user_id,
    case when public.current_garage_role() in ('owner', 'manager') or member.user_id = auth.uid() then account.email end,
    coalesce(
      nullif(btrim(profile.display_name), ''),
      nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
      split_part(account.email, '@', 1)
    ),
    member.role,
    member.created_at,
    member.user_id = auth.uid()
  from public.garage_members member
  join auth.users account on account.id = member.user_id
  left join public.admin_profiles profile on profile.user_id = member.user_id
  where member.garage_id = public.current_garage_id()
    and auth.uid() is not null
  order by case member.role when 'owner' then 0 when 'manager' then 1 when 'front_desk' then 2 else 3 end, member.created_at
$$;

-- Whether an account exists for an invited email, so the accept page offers
-- "sign in" or "create your account". Service role only.
create function public.auth_email_exists(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.users account where lower(account.email) = lower(btrim(coalesce(p_email, ''))))
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.reserved_garage_slugs() from public, anon, authenticated;
revoke all on function public.garage_booking_prefix(text) from public, anon, authenticated;
revoke all on function public.create_garage(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.complete_garage_onboarding() from public, anon;
revoke all on function public.garage_invite_expiry() from public, anon, authenticated;
revoke all on function public.create_garage_invite(text, text, text) from public, anon;
revoke all on function public.resend_garage_invite(uuid, text) from public, anon;
revoke all on function public.revoke_garage_invite(uuid) from public, anon;
revoke all on function public.accept_garage_invite(text) from public, anon;
revoke all on function public.list_garage_team() from public, anon;
revoke all on function public.list_garage_invites() from public, anon;
revoke all on function public.auth_email_exists(text) from public, anon, authenticated;

grant execute on function public.reserved_garage_slugs() to service_role;
grant execute on function public.garage_booking_prefix(text) to service_role;
grant execute on function public.create_garage(uuid, jsonb) to service_role;
grant execute on function public.garage_invite_expiry() to service_role;
grant execute on function public.complete_garage_onboarding() to authenticated;
grant execute on function public.create_garage_invite(text, text, text) to authenticated;
grant execute on function public.resend_garage_invite(uuid, text) to authenticated;
grant execute on function public.revoke_garage_invite(uuid) to authenticated;
grant execute on function public.accept_garage_invite(text) to authenticated;
grant execute on function public.list_garage_team() to authenticated;
grant execute on function public.list_garage_invites() to authenticated;
grant execute on function public.auth_email_exists(text) to service_role;
