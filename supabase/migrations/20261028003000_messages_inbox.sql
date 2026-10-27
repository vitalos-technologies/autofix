-- Autofix messages inbox (Messages & calls, `/app/messages`): unread inbound
-- messages and staff replies.
--
--   1. messages gains read_at / read_by: when a member opened the thread an
--      inbound message is in (null = unread). Staff may set only those two
--      columns, only on their garage's inbound messages and only as
--      themselves (column grant + policy), the way calls.handled_at works.
--   2. claim_staff_reply(): the claim before a staff reply is sent (DECISIONS
--      A14): checks the member may reply (owner, manager or front desk of the
--      garage), the customer is the garage's, not removed, not opted out, has
--      an address on their channel and, for texts, that the garage has a
--      provisioned messaging number (A55); then inserts the outbound messages
--      row (status sending). The app sends afterwards and records the result
--      on that row with the service role.
--
-- Rollback notes (manual): drop function
-- public.claim_staff_reply(uuid, uuid, uuid, text, text); drop policy "garage
-- members mark inbound messages read" on public.messages; revoke update
-- (read_at, read_by) on public.messages from authenticated; drop index
-- public.messages_garage_unread_idx; alter table public.messages drop
-- constraint messages_read_check, drop column read_at, drop column read_by.

-- ---------------------------------------------------------------------------
-- 1. Unread inbound messages
-- ---------------------------------------------------------------------------

alter table public.messages
  add column read_at timestamptz,
  add column read_by uuid references auth.users(id) on delete set null,
  add constraint messages_read_check check (direction = 'inbound' or (read_at is null and read_by is null));

comment on column public.messages.read_at is
  'Inbound only: when a member of the garage opened the conversation (null = unread). Set by staff through RLS (column grant read_at, read_by).';

create index messages_garage_unread_idx on public.messages (garage_id, customer_id)
  where direction = 'inbound' and read_at is null;

grant update (read_at, read_by) on public.messages to authenticated;

-- messages
--   "garage members mark inbound messages read"  update  members of the selected garage, inbound rows, as themselves (column grants: read_at, read_by)
create policy "garage members mark inbound messages read" on public.messages
  for update to authenticated
  using (garage_id = (select public.current_garage_id()) and direction = 'inbound')
  with check (
    garage_id = (select public.current_garage_id())
    and direction = 'inbound'
    and (read_by is null or read_by = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 2. claim_staff_reply
-- ---------------------------------------------------------------------------

-- Claims a staff reply to one customer. Returns
--   {status: 'claimed', message_id, channel, to}  the messages row exists (sending)
--   {status: 'skipped', reason}                    nothing written
-- Reasons, in this order: not_allowed (p_member_id is not an owner, manager
-- or front desk member of the garage), not_found (no such customer at the
-- garage), anonymised, opted_out, no_address (no mobile for SMS/WhatsApp, no
-- email for email), no_messaging_number (texts need a garage_phone_numbers
-- row with purpose messaging and provider_sid set). The channel is the
-- customer's own (customers.channel).
create function public.claim_staff_reply(
  p_garage_id uuid,
  p_customer_id uuid,
  p_member_id uuid,
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
  customer public.customers%rowtype;
  reply_channel text;
  reply_to text;
  sender text;
  message_id uuid;
begin
  if p_garage_id is null or p_customer_id is null or p_member_id is null then
    raise exception 'INVALID_ARGUMENT: garage, customer and member are required' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 1600 then
    raise exception 'INVALID_ARGUMENT: body must be 1 to 1600 characters' using errcode = '22023';
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

  select * into customer from public.customers
  where garage_id = p_garage_id and id = p_customer_id
  for share;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'not_found');
  end if;
  if customer.anonymised_at is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'anonymised');
  end if;
  if customer.opted_out_at is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'opted_out');
  end if;

  reply_channel := coalesce(customer.channel, 'sms');
  if reply_channel = 'email' then
    reply_to := nullif(btrim(coalesce(customer.email, '')), '');
    if reply_to is null or reply_to !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
      return jsonb_build_object('status', 'skipped', 'reason', 'no_address');
    end if;
  else
    reply_to := customer.phone;
    if reply_to is null or reply_to !~ '^\+[1-9][0-9]{6,14}$' then
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

  insert into public.messages (garage_id, customer_id, channel, direction, to_address, from_address, body, provider, status)
  values (p_garage_id, customer.id, reply_channel, 'outbound', reply_to, sender, p_body, p_provider, 'sending')
  returning id into message_id;

  return jsonb_build_object('status', 'claimed', 'message_id', message_id, 'channel', reply_channel, 'to', reply_to);
end
$$;

comment on function public.claim_staff_reply(uuid, uuid, uuid, text, text) is
  'Messages & calls: claims a staff reply (A14) after the role, opt-out, address and messaging-number checks; inserts the outbound messages row in sending. Service role only.';

revoke all on function public.claim_staff_reply(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_staff_reply(uuid, uuid, uuid, text, text) to service_role;
