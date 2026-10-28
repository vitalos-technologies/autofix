-- P5.10: accounting sync with Xero, QuickBooks and Sage (D17, Pro feature
-- 'accounting_sync'; DECISIONS A366-A373 in docs/autofix/phase-5/P5.10-accounting-sync.md).
--
--   1. accounting_connections: one active connection per garage (provider,
--      status, chosen organisation, who connected it, last sync and last
--      error code). Owners and managers read it; nobody on the staff side
--      writes it directly (accounting_save_connection() and
--      accounting_disconnect() run with the service role from the OAuth
--      route handlers, after the app's owner, MFA and plan checks).
--   2. accounting_connection_secrets: the OAuth tokens, AES-256-GCM
--      ciphertext only (src/lib/accounting/crypto.ts, key ACCOUNTING_TOKEN_KEY,
--      never in the database). Service role only: no grant to anon or
--      authenticated, no policies. Deleted on disconnect.
--   3. accounting_sync_items: what has been (or is to be) sent per connection:
--      contact / invoice / payment, local id, remote id, status
--      pending/synced/failed, attempts, next attempt, last error code. Members
--      read; the service role writes. Kept on disconnect (history).
--   4. Triggers on invoices (draft -> issued) and invoice_payments (insert)
--      queue an item and an `accounting.sync` job through enqueue_job() for
--      Pro garages with a connection. Additive: no invoice function changes,
--      and a failure here never blocks issuing an invoice or recording a
--      payment.
--   5. accounting_request_sync() ("Sync now") and accounting_retry_item()
--      ("Retry") for owners/managers of the selected garage, gated with
--      require_garage_feature(..., 'accounting_sync').

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.accounting_connections (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  provider text not null,
  status text not null default 'pending',
  tenant_id text,
  tenant_name text,
  scopes text[] not null default '{}',
  settings jsonb not null default '{}'::jsonb,
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error_code text,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_connections_garage_id_id_key unique (garage_id, id),
  constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'sage', 'fake')),
  constraint accounting_connections_status_check check (status in ('pending', 'connected', 'needs_reconnect', 'disconnected')),
  constraint accounting_connections_tenant_check check (status <> 'connected' or tenant_id is not null),
  constraint accounting_connections_tenant_id_check check (tenant_id is null or char_length(tenant_id) between 1 and 200),
  constraint accounting_connections_tenant_name_check check (tenant_name is null or char_length(tenant_name) <= 200),
  constraint accounting_connections_settings_check check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 4096),
  constraint accounting_connections_error_check check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  constraint accounting_connections_disconnected_check check ((status = 'disconnected') = (disconnected_at is not null))
);

comment on table public.accounting_connections is
  'P5.10: a garage''s link to Xero, QuickBooks or Sage (Pro, accounting_sync). One active (not disconnected) row per garage; disconnected rows stay as history. Tokens live in accounting_connection_secrets.';
comment on column public.accounting_connections.status is
  'pending (organisation not chosen yet), connected, needs_reconnect (the provider refused our tokens), disconnected.';
comment on column public.accounting_connections.settings is
  'Provider mapping (sales account code, bank account, item id). Defaults in src/lib/accounting; no secrets.';

create unique index accounting_connections_one_active_idx
  on public.accounting_connections (garage_id) where status <> 'disconnected';

create table public.accounting_connection_secrets (
  connection_id uuid primary key,
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  access_token_ct text not null,
  refresh_token_ct text,
  expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint accounting_connection_secrets_connection_fkey foreign key (garage_id, connection_id)
    references public.accounting_connections (garage_id, id) on delete cascade,
  constraint accounting_connection_secrets_access_check check (access_token_ct ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  constraint accounting_connection_secrets_refresh_check check (refresh_token_ct is null or refresh_token_ct ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
);

comment on table public.accounting_connection_secrets is
  'P5.10: OAuth tokens of an accounting connection as AES-256-GCM ciphertext (v1.<iv>.<tag>.<data>, key ACCOUNTING_TOKEN_KEY outside the database, the garage id as associated data). Service role only.';

create table public.accounting_sync_items (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  connection_id uuid not null,
  entity text not null,
  local_id uuid not null,
  remote_id text,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_sync_items_garage_id_id_key unique (garage_id, id),
  constraint accounting_sync_items_entity_key unique (connection_id, entity, local_id),
  constraint accounting_sync_items_connection_fkey foreign key (garage_id, connection_id)
    references public.accounting_connections (garage_id, id) on delete cascade,
  constraint accounting_sync_items_entity_check check (entity in ('contact', 'invoice', 'payment')),
  constraint accounting_sync_items_status_check check (status in ('pending', 'synced', 'failed')),
  constraint accounting_sync_items_attempts_check check (attempts between 0 and 100),
  constraint accounting_sync_items_remote_check check (remote_id is null or char_length(remote_id) between 1 and 200),
  constraint accounting_sync_items_synced_check check ((status = 'synced') = (synced_at is not null and remote_id is not null)),
  constraint accounting_sync_items_error_check check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,59}$')
);

comment on table public.accounting_sync_items is
  'P5.10: one row per contact, invoice or payment to send to the connected accounting provider (idempotent per connection + entity + local id). Written by the service role (accounting.sync) and the queueing triggers.';

create index accounting_sync_items_due_idx on public.accounting_sync_items (garage_id, status, next_attempt_at);
create index accounting_sync_items_recent_idx on public.accounting_sync_items (garage_id, updated_at desc);

create trigger accounting_connections_updated before update on public.accounting_connections
  for each row execute function public.set_updated_at();
create trigger accounting_connection_secrets_updated before update on public.accounting_connection_secrets
  for each row execute function public.set_updated_at();
create trigger accounting_sync_items_updated before update on public.accounting_sync_items
  for each row execute function public.set_updated_at();

alter table public.accounting_connections enable row level security;
alter table public.accounting_connection_secrets enable row level security;
alter table public.accounting_sync_items enable row level security;

-- accounting_connections
--   "owners and managers read the accounting connection"  select  owners/managers of the selected garage
--   (no write policies: accounting_save_connection(), accounting_disconnect() and the sync job write
--   with the service role after the app's owner + MFA + plan checks. Select does not check the plan,
--   so the history stays readable after a move to Essentials.)
create policy "owners and managers read the accounting connection" on public.accounting_connections
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

-- accounting_connection_secrets
--   (no policies and no grants for anon or authenticated: tokens are service role only)

-- accounting_sync_items
--   "owners and managers read sync status"  select  owners/managers of the selected garage
--   (no write policies: the accounting.sync job and the triggers write with definer rights;
--   staff change items only through accounting_request_sync() / accounting_retry_item(), which
--   check the role and require_garage_feature(..., 'accounting_sync'))
create policy "owners and managers read sync status" on public.accounting_sync_items
  for select to authenticated
  using (garage_id = (select public.current_garage_id()) and (select public.current_garage_role()) in ('owner', 'manager'));

revoke all on public.accounting_connections from anon, authenticated;
revoke all on public.accounting_connection_secrets from anon, authenticated;
revoke all on public.accounting_sync_items from anon, authenticated;
grant select on public.accounting_connections to authenticated;
grant select on public.accounting_sync_items to authenticated;
grant select, insert, update, delete on public.accounting_connections to service_role;
grant select, insert, update, delete on public.accounting_connection_secrets to service_role;
grant select, insert, update, delete on public.accounting_sync_items to service_role;

-- ---------------------------------------------------------------------------
-- 2. Connect and disconnect (service role, from the OAuth route handlers)
-- ---------------------------------------------------------------------------

-- Stores a new connection after the OAuth callback (replacing a
-- needs_reconnect/pending one of the same garage, which keeps its id and so
-- its sync history). p_tenant_id null = the owner still has to choose the
-- organisation (status pending). Ciphertext only; the app encrypts.
create function public.accounting_save_connection(
  p_garage_id uuid,
  p_provider text,
  p_tenant_id text,
  p_tenant_name text,
  p_scopes text[],
  p_connected_by uuid,
  p_access_token_ct text,
  p_refresh_token_ct text,
  p_expires_at timestamptz,
  p_refresh_expires_at timestamptz default null
)
returns public.accounting_connections
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing public.accounting_connections%rowtype;
  saved public.accounting_connections%rowtype;
  reuse boolean;
begin
  perform public.require_garage_feature(p_garage_id, 'accounting_sync');
  if p_provider is null or p_provider not in ('xero', 'quickbooks', 'sage', 'fake') then
    raise exception 'INVALID_PROVIDER' using errcode = '22023';
  end if;

  perform 1 from public.garages where id = p_garage_id for update;
  select * into existing
  from public.accounting_connections connection
  where connection.garage_id = p_garage_id and connection.status <> 'disconnected';
  reuse := found;

  if reuse and (existing.provider <> p_provider or (existing.tenant_id is not null and p_tenant_id is not null and existing.tenant_id <> p_tenant_id)) then
    -- Another provider or organisation: the old one ends here (its history stays).
    update public.accounting_connections
    set status = 'disconnected', disconnected_at = now()
    where id = existing.id;
    delete from public.accounting_connection_secrets where connection_id = existing.id;
    reuse := false;
  end if;

  if reuse then
    update public.accounting_connections
    set status = case when coalesce(p_tenant_id, existing.tenant_id) is null then 'pending' else 'connected' end,
        tenant_id = coalesce(p_tenant_id, existing.tenant_id),
        tenant_name = coalesce(p_tenant_name, existing.tenant_name),
        scopes = coalesce(p_scopes, '{}'),
        connected_by = p_connected_by,
        connected_at = now(),
        last_error_code = null
    where id = existing.id
    returning * into saved;
  else
    insert into public.accounting_connections (garage_id, provider, status, tenant_id, tenant_name, scopes, connected_by)
    values (p_garage_id, p_provider, case when p_tenant_id is null then 'pending' else 'connected' end,
            p_tenant_id, p_tenant_name, coalesce(p_scopes, '{}'), p_connected_by)
    returning * into saved;
  end if;

  insert into public.accounting_connection_secrets (connection_id, garage_id, access_token_ct, refresh_token_ct, expires_at, refresh_expires_at)
  values (saved.id, p_garage_id, p_access_token_ct, p_refresh_token_ct, p_expires_at, p_refresh_expires_at)
  on conflict (connection_id) do update
    set access_token_ct = excluded.access_token_ct,
        refresh_token_ct = excluded.refresh_token_ct,
        expires_at = excluded.expires_at,
        refresh_expires_at = excluded.refresh_expires_at;

  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (p_garage_id, p_connected_by, 'accounting.connected', 'accounting_connection', saved.id::text,
          jsonb_build_object('provider', p_provider, 'status', saved.status));
  return saved;
end
$$;

comment on function public.accounting_save_connection(uuid, text, text, text, text[], uuid, text, text, timestamptz, timestamptz) is
  'P5.10: stores a connection and its encrypted tokens after the OAuth callback (Pro only). Service role.';

-- The owner picked the organisation of a pending connection.
create function public.accounting_choose_tenant(p_garage_id uuid, p_connection_id uuid, p_tenant_id text, p_tenant_name text, p_actor uuid)
returns public.accounting_connections
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  saved public.accounting_connections%rowtype;
begin
  perform public.require_garage_feature(p_garage_id, 'accounting_sync');
  if p_tenant_id is null or char_length(p_tenant_id) not between 1 and 200 then
    raise exception 'INVALID_TENANT' using errcode = '22023';
  end if;
  update public.accounting_connections connection
  set tenant_id = p_tenant_id, tenant_name = left(p_tenant_name, 200), status = 'connected', last_error_code = null
  where connection.garage_id = p_garage_id and connection.id = p_connection_id and connection.status in ('pending', 'connected')
  returning * into saved;
  if not found then
    raise exception 'CONNECTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (p_garage_id, p_actor, 'accounting.organisation_chosen', 'accounting_connection', saved.id::text,
          jsonb_build_object('provider', saved.provider));
  return saved;
end
$$;

-- Ends the garage's active connection: tokens deleted, history kept. The app
-- revokes the token at the provider first (best effort). Allowed on
-- Essentials too (a garage can always cut the link).
create function public.accounting_disconnect(p_garage_id uuid, p_actor uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  ended uuid;
begin
  update public.accounting_connections connection
  set status = 'disconnected', disconnected_at = now()
  where connection.garage_id = p_garage_id and connection.status <> 'disconnected'
  returning connection.id into ended;
  if ended is null then
    return false;
  end if;
  delete from public.accounting_connection_secrets where connection_id = ended;
  update public.accounting_sync_items item
  set status = 'failed', last_error_code = 'DISCONNECTED'
  where item.garage_id = p_garage_id and item.connection_id = ended and item.status = 'pending';
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (p_garage_id, p_actor, 'accounting.disconnected', 'accounting_connection', ended::text, '{}'::jsonb);
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Queueing (triggers, "Sync now", "Retry")
-- ---------------------------------------------------------------------------

-- Queues accounting.sync for a garage unless one is already queued to run
-- by then (the job works through every due item of the garage). Not a
-- dedupe key: a key is unique for ever, so an item queued in the same minute
-- after a run finished would wait for the daily cron. A job that is already
-- running may have read its items, so a new one is queued behind it. Two
-- racing callers can queue two jobs; items are idempotent, so that only
-- costs a run. Internal.
create function public.enqueue_accounting_sync(p_garage_id uuid, p_run_at timestamptz default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  due timestamptz := greatest(coalesce(p_run_at, now()), now());
begin
  if exists (
    select 1 from public.jobs job
    where job.kind = 'accounting.sync' and job.garage_id = p_garage_id and job.status = 'queued' and job.run_at <= due
  ) then
    return;
  end if;
  perform public.enqueue_job('accounting.sync', jsonb_build_object('garageId', p_garage_id), due, null, p_garage_id);
end
$$;

comment on function public.enqueue_accounting_sync(uuid, timestamptz) is
  'P5.10: queue accounting.sync for a garage unless one is already queued by then. Service role and triggers only.';

-- Queues one entity for the garage's active connection, when the garage has
-- the feature. Returns whether an item is now pending. Internal.
create function public.accounting_queue_entity(p_garage_id uuid, p_entity text, p_local_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  active_connection uuid;
begin
  if public.garage_effective_plan(p_garage_id) <> 'pro' and public.plan_feature_plan('accounting_sync') = 'pro' then
    return false;
  end if;
  select connection.id into active_connection
  from public.accounting_connections connection
  where connection.garage_id = p_garage_id and connection.status in ('pending', 'connected', 'needs_reconnect');
  if active_connection is null then
    return false;
  end if;
  insert into public.accounting_sync_items (garage_id, connection_id, entity, local_id)
  values (p_garage_id, active_connection, p_entity, p_local_id)
  on conflict (connection_id, entity, local_id) do nothing;
  perform public.enqueue_accounting_sync(p_garage_id, null);
  return true;
end
$$;

-- Trigger: an invoice was issued (draft -> issued) or a payment recorded.
-- Never blocks the invoice change: any error here is only a warning.
create function public.accounting_queue_after_invoice_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if tg_table_name = 'invoices' then
      perform public.accounting_queue_entity(new.garage_id, 'invoice', new.id);
    else
      perform public.accounting_queue_entity(new.garage_id, 'payment', new.id);
    end if;
  exception when others then
    raise warning 'accounting sync not queued (%)', sqlstate;
  end;
  return null;
end
$$;

create trigger invoices_accounting_sync
  after update of status on public.invoices
  for each row
  when (old.status = 'draft' and new.status = 'issued')
  execute function public.accounting_queue_after_invoice_change();

create trigger invoice_payments_accounting_sync
  after insert on public.invoice_payments
  for each row
  execute function public.accounting_queue_after_invoice_change();

-- Owners/managers check (AAL2 when enrolled) + the plan, for the staff RPCs.
create function public.accounting_staff_garage()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  garage_scope uuid := public.current_garage_id();
begin
  if not public.garage_actor_allowed() or public.current_garage_role() not in ('owner', 'manager') then
    raise exception 'ACCOUNTING_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.require_garage_feature(garage_scope, 'accounting_sync');
  return garage_scope;
end
$$;

-- "Sync now": failed items of the active connection go back to pending (with
-- fresh attempts), invoices issued and payments recorded since the
-- connection was made that have no item yet are queued, and a job is queued.
-- Returns how many items are pending.
create function public.accounting_request_sync()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  garage_scope uuid := public.accounting_staff_garage();
  active public.accounting_connections%rowtype;
  pending integer;
begin
  select * into active
  from public.accounting_connections connection
  where connection.garage_id = garage_scope and connection.status = 'connected';
  if not found then
    raise exception 'ACCOUNTING_NOT_CONNECTED' using errcode = 'P0001';
  end if;

  update public.accounting_sync_items item
  set status = 'pending', attempts = 0, next_attempt_at = now(), last_error_code = null
  where item.garage_id = garage_scope and item.connection_id = active.id and item.status = 'failed';

  insert into public.accounting_sync_items (garage_id, connection_id, entity, local_id)
  select garage_scope, active.id, 'invoice', invoice.id
  from public.invoices invoice
  where invoice.garage_id = garage_scope
    and invoice.status in ('issued', 'paid')
    and invoice.deleted_at is null
    and invoice.issued_at >= active.connected_at
  on conflict (connection_id, entity, local_id) do nothing;

  insert into public.accounting_sync_items (garage_id, connection_id, entity, local_id)
  select garage_scope, active.id, 'payment', payment.id
  from public.invoice_payments payment
  join public.accounting_sync_items invoice_item
    on invoice_item.garage_id = payment.garage_id
   and invoice_item.connection_id = active.id
   and invoice_item.entity = 'invoice'
   and invoice_item.local_id = payment.invoice_id
  where payment.garage_id = garage_scope
  on conflict (connection_id, entity, local_id) do nothing;

  select count(*)::integer into pending
  from public.accounting_sync_items item
  where item.garage_id = garage_scope and item.connection_id = active.id and item.status = 'pending';

  perform public.enqueue_accounting_sync(garage_scope, null);
  insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
  values (garage_scope, auth.uid(), 'accounting.sync_requested', 'accounting_connection', active.id::text,
          jsonb_build_object('pending', pending));
  return pending;
end
$$;

comment on function public.accounting_request_sync() is
  'P5.10: "Sync now" for owners/managers of the selected garage (Pro): retries failed items, queues invoices/payments since connecting, queues accounting.sync.';

-- "Retry" one failed item.
create function public.accounting_retry_item(p_item_id uuid)
returns public.accounting_sync_items
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  garage_scope uuid := public.accounting_staff_garage();
  retried public.accounting_sync_items%rowtype;
begin
  update public.accounting_sync_items item
  set status = 'pending', attempts = 0, next_attempt_at = now(), last_error_code = null
  where item.garage_id = garage_scope
    and item.id = p_item_id
    and item.status = 'failed'
    and exists (
      select 1 from public.accounting_connections connection
      where connection.garage_id = garage_scope and connection.id = item.connection_id and connection.status = 'connected'
    )
  returning * into retried;
  if not found then
    raise exception 'SYNC_ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public.enqueue_accounting_sync(garage_scope, null);
  return retried;
end
$$;

comment on function public.accounting_retry_item(uuid) is
  'P5.10: "Retry" a failed sync item of the selected garage''s active connection (owners/managers, Pro).';

-- Garages with due items (the daily accounting.sync fan-out).
create function public.accounting_due_garages(p_limit integer default 200)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct item.garage_id
  from public.accounting_sync_items item
  join public.accounting_connections connection
    on connection.garage_id = item.garage_id and connection.id = item.connection_id and connection.status = 'connected'
  where item.status = 'pending' and item.next_attempt_at <= now()
  limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.accounting_save_connection(uuid, text, text, text, text[], uuid, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.accounting_choose_tenant(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.accounting_disconnect(uuid, uuid) from public, anon, authenticated;
revoke all on function public.enqueue_accounting_sync(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.accounting_queue_entity(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.accounting_queue_after_invoice_change() from public, anon, authenticated;
revoke all on function public.accounting_staff_garage() from public, anon, authenticated;
revoke all on function public.accounting_request_sync() from public, anon;
revoke all on function public.accounting_retry_item(uuid) from public, anon;
revoke all on function public.accounting_due_garages(integer) from public, anon, authenticated;

grant execute on function public.accounting_save_connection(uuid, text, text, text, text[], uuid, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.accounting_choose_tenant(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.accounting_disconnect(uuid, uuid) to service_role;
grant execute on function public.enqueue_accounting_sync(uuid, timestamptz) to service_role;
grant execute on function public.accounting_queue_entity(uuid, text, uuid) to service_role;
grant execute on function public.accounting_request_sync() to authenticated;
grant execute on function public.accounting_retry_item(uuid) to authenticated;
grant execute on function public.accounting_due_garages(integer) to service_role;
