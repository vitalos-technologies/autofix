-- Reminder wording that fits one text (DECISIONS A169, A184-A185).
--
-- The drafted MOT and service reminders came to about 225 and 200 characters
-- with a reminder link and "Reply STOP to opt out.": two SMS each, so every
-- reminder cost double. The new defaults (DEFAULT_TEMPLATES in
-- src/lib/messaging/templates.ts, checked by
-- src/__tests__/reminder-rule-defaults.test.ts and
-- src/__tests__/reminder-sms-length.test.ts) fit one GSM-7 text with a
-- 20-character slug on the free link host, a 20-character garage name, a
-- 12-character first name, the date as "24 Nov" and the 22-character link
-- tokens (src/lib/reminders/link-token.ts).
--
--   1. seed_default_reminder_rules() seeds the new wording, so garages created
--      from now on (seed_garage_defaults(), create_garage()) get it.
--   2. apply_one_text_reminder_wording() (owner only, run once below): existing
--      reminder_rules rows whose template is still exactly the old default
--      for their kind get the new wording. Rows a garage has edited (any
--      difference at all) are left as they are, and so are the rule's
--      switch, timing and channel. pgTAP 026 runs it again on fixtures.
--
-- Rollback notes (manual): re-create public.seed_default_reminder_rules(uuid)
-- from 20261028001000_reminders.sql, run the update in
-- apply_one_text_reminder_wording() with the old and new wording swapped, and
-- drop function public.apply_one_text_reminder_wording().

-- ---------------------------------------------------------------------------
-- 1. Defaults for new garages
-- ---------------------------------------------------------------------------

-- The four default rules (wording: DEFAULT_TEMPLATES in
-- src/lib/messaging/templates.ts). Kinds the garage already has are left
-- alone. Review requests start switched off (design: Admin-Reminders).
create or replace function public.seed_default_reminder_rules(p_garage_id uuid)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  added integer;
begin
  insert into public.reminder_rules (garage_id, kind, enabled, offset_days, channel, template) values
    (p_garage_id, 'mot', true, '{28,7}', 'customer',
     E'{garage}: Hi {first_name}, MOT due {due_date}. Book: {link}'),
    (p_garage_id, 'service', true, '{335}', 'customer',
     E'{garage}: Hi {first_name}, service due. Book: {link}'),
    (p_garage_id, 'review', false, '{1}', 'customer',
     E'{garage}: thanks {first_name}! Please review us: {link}'),
    (p_garage_id, 'missed_call', true, '{0}', 'customer',
     E'{garage}: sorry we missed your call. Book at {link} or we''ll call you back.')
  on conflict on constraint reminder_rules_garage_id_kind_key do nothing;
  get diagnostics added = row_count;
  return added;
end
$$;

revoke all on function public.seed_default_reminder_rules(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Garages still on the old default wording
-- ---------------------------------------------------------------------------

create function public.apply_one_text_reminder_wording()
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  moved integer;
begin
  update public.reminder_rules existing
  set template = wording.new_template
  from (values
    ('mot',
     E'Hi {first_name}, the MOT on your {vehicle} ({reg}) is due on {due_date}. Book a time: {link}\n{garage}.',
     E'{garage}: Hi {first_name}, MOT due {due_date}. Book: {link}'),
    ('service',
     E'Hi {first_name}, your {vehicle} ({reg}) is due a service. Book a time: {link}\n{garage}.',
     E'{garage}: Hi {first_name}, service due. Book: {link}'),
    ('review',
     E'Hi {first_name}, thanks for bringing your {vehicle} to us. Could you leave a quick review? {link}\n{garage}.',
     E'{garage}: thanks {first_name}! Please review us: {link}'),
    ('missed_call',
     E'Sorry we missed your call. Book online in about a minute: {link} or we''ll call you back soon. {garage}',
     E'{garage}: sorry we missed your call. Book at {link} or we''ll call you back.')
  ) as wording (kind, old_template, new_template)
  where existing.kind = wording.kind
    and existing.template = wording.old_template;
  get diagnostics moved = row_count;
  return moved;
end
$$;

revoke all on function public.apply_one_text_reminder_wording() from public, anon, authenticated, service_role;

select public.apply_one_text_reminder_wording();
