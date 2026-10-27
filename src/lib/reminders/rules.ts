/**
 * Reminder rules as the Reminders page (P3.10) shows and edits them: names, the rule in words, the
 * placeholders each kind's sender fills in, template validation and the review-request consent
 * note (DECISIONS A54). Pure and client-safe: the editor runs the same checks live, the server
 * action runs them again before saving.
 */
import { DEFAULT_TEMPLATES, REMINDER_PLACEHOLDERS, type TemplatePlaceholder, type TemplateVariables } from "@/lib/messaging/templates";

export const RULE_KINDS = ["mot", "service", "missed_call", "review"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const RULE_CHANNELS = ["customer", "sms", "whatsapp", "email"] as const;
export type RuleChannel = (typeof RULE_CHANNELS)[number];

export const RULE_NAMES: Record<RuleKind, string> = {
  mot: "MOT due",
  service: "Service due",
  missed_call: "Missed-call text-back",
  review: "Review request",
};

/** Switch names, as drawn ("MOT due reminders"). */
export const RULE_SWITCH_LABELS: Record<RuleKind, string> = {
  mot: "MOT due reminders",
  service: "Service due reminders",
  missed_call: "Missed-call text-back",
  review: "Review requests",
};

export const CHANNEL_OPTIONS: Record<RuleChannel, string> = {
  customer: "The customer's choice",
  sms: "Text message",
  whatsapp: "WhatsApp",
  email: "Email",
};

/**
 * What each sender fills in. Reminders (src/lib/reminders/compose.ts) supply the six reminder
 * placeholders; the missed-call text-back (src/lib/calls/text-back.ts) supplies `{garage}`, `{link}`
 * and, only for a known customer, `{first_name}` (A161). Anything else is refused, as the senders
 * refuse it.
 */
export function allowedPlaceholders(kind: RuleKind): readonly TemplatePlaceholder[] {
  return kind === "missed_call" ? (["first_name", "link", "garage"] as const) : REMINDER_PLACEHOLDERS;
}

export const TEMPLATE_MAX_LENGTH = 1000;
export const MAX_OFFSETS = 6;

const PLACEHOLDER = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

export type TemplateCheck = {
  ok: boolean;
  /** Blocking problems, in plain English. */
  errors: string[];
  /** Worth knowing, not blocking. */
  warnings: string[];
  /** Placeholders this kind's sender does not fill in, as written (`{frist_name}`). */
  unknown: string[];
};

/** Checks a template the way the sender will treat it, plus the wording rules (the garage is named). */
export function checkTemplate(kind: RuleKind, template: string): TemplateCheck {
  const text = template.trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowed = new Set<string>(allowedPlaceholders(kind));
  const used = new Set<string>();
  const unknown: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? "").toLowerCase();
    if (allowed.has(name)) used.add(name);
    else if (!unknown.includes(match[0])) unknown.push(match[0]);
  }
  if (!text) errors.push("Write the message first.");
  if (text.length > TEMPLATE_MAX_LENGTH) errors.push(`Keep the message under ${TEMPLATE_MAX_LENGTH} characters.`);
  if (unknown.length > 0) {
    errors.push(
      `${unknown.join(", ")} ${unknown.length === 1 ? "isn't a placeholder" : "aren't placeholders"} this message can fill in. Use ${allowedPlaceholders(kind)
        .map((name) => `{${name}}`)
        .join(", ")}.`,
    );
  }
  if (text && !used.has("garage")) errors.push("Include {garage}: every message must say who it is from.");
  if (text && !used.has("link")) warnings.push("There is no {link}, so customers can't book straight from the message.");
  if (kind === "missed_call" && used.has("first_name")) {
    warnings.push("{first_name} is only known when the caller is already a customer: callers we don't know get no text.");
  }
  return { ok: errors.length === 0, errors, warnings, unknown };
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function listWords(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** 335 → "11 months"; 30 → "30 days" (a whole number of months only when it is close to one). */
function daysOrMonths(days: number) {
  const months = Math.round(days / 30.4375);
  if (months >= 2 && Math.abs(days - months * 30.4375) <= 3) return plural(months, "month");
  return plural(days, "day");
}

/** The rule in words, as on the Automations list. */
export function describeRule(kind: RuleKind, offsets: readonly number[]): string {
  const sorted = [...new Set(offsets)].sort((a, b) => b - a);
  switch (kind) {
    case "mot":
      return `${listWords(sorted.map((days) => plural(days, "day")))} before the MOT runs out`;
    case "service":
      return `${listWords([...sorted].reverse().map(daysOrMonths))} after the last service`;
    case "review": {
      const words = [...sorted].reverse().map((days) => (days === 1 ? "The day" : days === 0 ? "The same day" : plural(days, "day")));
      return `${listWords(words)} after collection, asks for a review`;
    }
    case "missed_call":
      return "Texts a booking link within a minute of an unanswered call";
  }
}

/** What the offsets mean, for the editor's field label. */
export const OFFSET_LABELS: Partial<Record<RuleKind, string>> = {
  mot: "Days before the MOT runs out",
  service: "Days after the last service",
  review: "Days after collection",
};

/** "28, 7" → [28, 7]: whole days 0–730, at most six, no repeats. */
export function parseOffsets(raw: string): { ok: true; value: number[] } | { ok: false; error: string } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: "Enter at least one number of days." };
  if (parts.length > MAX_OFFSETS) return { ok: false, error: `Use at most ${MAX_OFFSETS} reminders.` };
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return { ok: false, error: "Use whole numbers of days, like 28, 7." };
    const value = Number(part);
    if (value > 730) return { ok: false, error: "Use at most 730 days." };
    if (!values.includes(value)) values.push(value);
  }
  return { ok: true, value: values.sort((a, b) => b - a) };
}

/** The default wording for a kind (DEFAULT_TEMPLATES, the drafted copy). */
export function defaultTemplate(kind: RuleKind): string {
  return DEFAULT_TEMPLATES[kind].body;
}

/**
 * Review requests are off by default (A54): customers agreed to "Remind me when the MOT and service
 * are due", which says nothing about reviews, so the wording has to be checked before they go out.
 */
export const REVIEW_CONSENT_NOTE =
  "Customers agreed to reminders when their MOT and service are due. That wording doesn't mention review requests, so check with your solicitor that it covers them before you switch this on.";

/**
 * A stand-in for a reminder link token: as long as a real one (16 random bytes, base64url, 22
 * characters; src/lib/reminders/link-token.ts) so the character count matches what is sent.
 */
export const SAMPLE_LINK_TOKEN = "7KQ2hT9mWc4pXv8RbN3sLq";

/**
 * Sample values for the preview, the counter and the test: plausible, never a real customer, and
 * as long as the real thing (the full `https://…/r/{token}` link, the date as the reminder writes
 * it, "24 Nov": pass `formatReminderDate()` from src/lib/reminders/compose.ts),
 * so the counter is honest about how many texts a message takes. The missed-call text links to the
 * booking page itself, as src/lib/calls/text-back.ts does, and only knows `{first_name}` for callers
 * who are already customers.
 */
export function sampleTemplateValues(input: { kind: RuleKind; garageName: string; bookingBaseUrl: string; dueDate: string }): TemplateVariables {
  const base = input.bookingBaseUrl.replace(/\/+$/, "");
  if (input.kind === "missed_call") return { first_name: "Priya", link: `${base}/`, garage: input.garageName };
  return {
    first_name: "Priya",
    vehicle: "Toyota Yaris",
    reg: "BC23 DEF",
    due_date: input.dueDate,
    link: `${base}/r/${SAMPLE_LINK_TOKEN}`,
    garage: input.garageName,
  };
}
