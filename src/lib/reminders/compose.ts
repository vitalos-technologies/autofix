// Reminder message composition: the rule's template with the customer's,
// car's and garage's details, the opt-out line for SMS/WhatsApp (DECISIONS
// A13: reminders go from the two-way number, so "Reply STOP" works) and the
// signed unsubscribe link for email ("Stop reminders: <link>", P4.9). Pure.

import { UNSUBSCRIBE_LINK_LINE } from "@/lib/consent/copy";
import type { ChannelKind } from "@/lib/messaging/channel";
import { DEFAULT_TEMPLATES, renderTemplate, type TemplatePlaceholder } from "@/lib/messaging/templates";
import { formatRegistration } from "@/lib/vehicle/registration-format";

export type ReminderKind = "mot" | "service" | "review";

/** One row of claim_reminder_sends() (ARCHITECTURE: "Admin, reminders and jobs"). */
export type ClaimedReminder = {
  id: string;
  rule_id: string;
  kind: ReminderKind;
  due_date: string;
  offset_days: number;
  send_at: string;
  channel: ChannelKind;
  template: string;
  customer_id: string;
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  vehicle_id: string;
  registration: string;
  make: string | null;
  model: string | null;
};

export type ComposedReminder =
  | { ok: true; body: string; subject?: string }
  | { ok: false; reason: "template_placeholders"; missing: TemplatePlaceholder[]; unknown: string[] };

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** Further from the send than this, the date carries its year. */
const DATE_WITHOUT_YEAR_DAYS = 180;

/**
 * `{due_date}` as reminders write it (DECISIONS A185): "24 Nov", short and GSM-7 so the default
 * wording fits one text; "24 Nov 2027" when it is more than 180 days from `from` (the send time),
 * so a reminder sent long before the date is never ambiguous. Fixed English month names (ICU's
 * en-GB "Sept" would cost a character). `""` for anything that is not a real `YYYY-MM-DD` date.
 */
export function formatReminderDate(isoDate: string, from?: string | Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return "";
  const [, year, month, day] = match;
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== isoDate) return "";
  const label = `${Number(day)} ${SHORT_MONTHS[Number(month) - 1]}`;
  const fromMs = from === undefined ? Number.NaN : typeof from === "string" ? Date.parse(from) : from.getTime();
  if (Number.isFinite(fromMs) && Math.abs(date.getTime() - fromMs) > DATE_WITHOUT_YEAR_DAYS * 86_400_000) return `${label} ${year}`;
  return label;
}

/** "Sam Driver" → "Sam". */
export function firstName(name: string | null | undefined) {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** "Ford Focus", or "car" when neither make nor model is known ("the MOT on your car (AB12 CDE)"). */
export function vehicleLabel(make: string | null | undefined, model: string | null | undefined) {
  return [make, model].map((part) => part?.trim()).filter(Boolean).join(" ") || "car";
}

export function composeReminder(input: {
  reminder: ClaimedReminder;
  garageName: string;
  /** Absolute `/r/{token}` link on the garage's booking host. */
  link: string;
  /** Email only: the customer's signed unsubscribe link (or the garage's unsubscribe form). */
  unsubscribeUrl?: string;
}): ComposedReminder {
  const { reminder } = input;
  const vars = {
    first_name: firstName(reminder.customer_name),
    vehicle: vehicleLabel(reminder.make, reminder.model),
    reg: formatRegistration(reminder.registration),
    due_date: formatReminderDate(reminder.due_date, reminder.send_at),
    link: input.link,
    garage: input.garageName,
  };
  const rendered = renderTemplate(reminder.template, vars, { channel: reminder.channel });
  if (rendered.missingPlaceholders.length > 0 || rendered.unknownPlaceholders.length > 0) {
    return { ok: false, reason: "template_placeholders", missing: rendered.missingPlaceholders, unknown: rendered.unknownPlaceholders };
  }
  if (reminder.channel !== "email") return { ok: true, body: rendered.text };

  const subject = renderTemplate(DEFAULT_TEMPLATES[reminder.kind].subject, vars).text;
  const footer = input.unsubscribeUrl ? `\n\n${UNSUBSCRIBE_LINK_LINE.replace("{unsubscribe_link}", input.unsubscribeUrl)}` : "";
  return { ok: true, body: `${rendered.text}${footer}`, subject };
}
