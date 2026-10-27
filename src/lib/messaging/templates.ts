// Message templates: placeholder rendering, the SMS/WhatsApp opt-out line,
// SMS segment counting and the default wording.
//
// Pure and client-safe, so the template editor (P3.10) can import it for the
// live 160-character counter. Default wording comes from
// docs/autofix/legal/consent-and-messaging-wording.md (draft, awaiting
// solicitor review). The reminder and missed-call defaults fit one GSM-7 text
// (160 characters with the opt-out line) for a garage name and free-link slug
// of up to 20 characters each and a first name of up to 12 (DECISIONS A184;
// src/__tests__/reminder-sms-length.test.ts).
//
// SMS segment rules: GSM 03.38 basic set is 1 septet a character and the
// extension table (^ { } \ [ ~ ] | € and form feed) is 2; one segment holds
// 160 septets, a concatenated segment 153 (an escape pair is never split).
// Any other character switches the whole message to UCS-2: 70 UTF-16 units
// in one segment, 67 when concatenated (a surrogate pair is never split).
// Twilio counts the same way: https://www.twilio.com/docs/messaging/api/message-resource
// and https://www.twilio.com/en-us/guidelines/gb/sms (read 26 Oct 2026).

import { UNSUBSCRIBE_LINK_LINE } from "@/lib/consent/copy";
import type { ChannelKind } from "./channel";

export const REMINDER_PLACEHOLDERS = ["first_name", "vehicle", "reg", "due_date", "link", "garage"] as const;
export const BOOKING_PLACEHOLDERS = ["service", "date", "time", "reference", "manage_link", "unsubscribe_link"] as const;
export const TEMPLATE_PLACEHOLDERS = [...REMINDER_PLACEHOLDERS, ...BOOKING_PLACEHOLDERS] as const;

export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];
export type TemplateVariables = Partial<Record<TemplatePlaceholder, string | null | undefined>>;

export type RenderedTemplate = {
  text: string;
  /** Placeholders that are not in TEMPLATE_PLACEHOLDERS (typos such as `{frist_name}`); left in the text as written. */
  unknownPlaceholders: string[];
  /** Known placeholders with no value supplied; left in the text as written. Do not send until this is empty. */
  missingPlaceholders: TemplatePlaceholder[];
};

export type RenderTemplateOptions = {
  /** When `sms` or `whatsapp`, the result always ends with the opt-out line (see withOptOut). */
  channel?: ChannelKind;
  /**
   * SMS from an alphanumeric sender, which cannot receive STOP (DECISIONS A13):
   * the signed unsubscribe link replaces "Reply STOP to opt out." (see withOptOutLink).
   */
  optOutLink?: string;
};

export const OPT_OUT_LINE = "Reply STOP to opt out.";
const OPT_OUT_PRESENT = /\breply\s+stop\b/i;
const PLACEHOLDER = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
const knownPlaceholders = new Set<string>(TEMPLATE_PLACEHOLDERS);

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

/**
 * Replaces `{first_name}`, `{vehicle}`, `{reg}`, `{due_date}`, `{link}` and
 * `{garage}` (plus the booking placeholders) in one pass, so a value that
 * itself contains `{link}` is never expanded again. Values have their
 * whitespace collapsed so a customer name cannot inject line breaks.
 */
export function renderTemplate(template: string, vars: TemplateVariables, options: RenderTemplateOptions = {}): RenderedTemplate {
  const unknownPlaceholders: string[] = [];
  const missingPlaceholders: TemplatePlaceholder[] = [];

  const text = template.replace(PLACEHOLDER, (match, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!knownPlaceholders.has(name)) {
      unknownPlaceholders.push(match);
      return match;
    }
    const value = vars[name as TemplatePlaceholder];
    const cleaned = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!cleaned) {
      missingPlaceholders.push(name as TemplatePlaceholder);
      return match;
    }
    return cleaned;
  });

  return {
    text: options.optOutLink && options.channel === "sms" ? withOptOutLink(text, options.optOutLink) : options.channel ? withOptOut(text, options.channel) : text,
    unknownPlaceholders: unique(unknownPlaceholders),
    missingPlaceholders: unique(missingPlaceholders),
  };
}

/** True when the text already tells the reader how to opt out by replying STOP. */
export function hasOptOut(body: string) {
  return OPT_OUT_PRESENT.test(body);
}

/**
 * Appends "Reply STOP to opt out." to SMS and WhatsApp bodies unless it is
 * already there. After a full stop it joins the last line
 * ("{garage}. Reply STOP to opt out."), otherwise it goes on a new line so it
 * never runs into a link. Email bodies are returned unchanged (email carries
 * an unsubscribe link instead).
 */
export function withOptOut(body: string, channel: ChannelKind): string {
  if (channel === "email") return body;
  const trimmed = body.trimEnd();
  if (hasOptOut(trimmed)) return trimmed;
  if (!trimmed) return OPT_OUT_LINE;
  const separator = /[.!?]$/.test(trimmed) ? " " : "\n";
  return `${trimmed}${separator}${OPT_OUT_LINE}`;
}

/**
 * Ends a text with "Stop reminders: <link>" (docs/autofix/legal/consent-and-messaging-wording.md),
 * for SMS sent from an alphanumeric sender: a reply STOP cannot reach the
 * garage, so any "Reply STOP" line is removed rather than promised.
 */
export function withOptOutLink(body: string, url: string): string {
  const line = UNSUBSCRIBE_LINK_LINE.replace("{unsubscribe_link}", url.trim());
  const trimmed = body.replace(/\s*\breply\s+stop\b[^\n]*$/i, "").trimEnd();
  if (trimmed.includes(url.trim())) return trimmed;
  return trimmed ? `${trimmed}\n${line}` : line;
}

// GSM 03.38 basic character set (127 printable entries; ESC excluded).
const GSM_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ),
);
// GSM 03.38 extension table: each costs an escape plus the character.
const GSM_EXTENSION = new Set(Array.from("\f^{}\\[~]|€"));

export const GSM_BASIC_CHARACTER_COUNT = GSM_BASIC.size;

export type SmsEncoding = "GSM-7" | "UCS-2";

export type SmsSegmentInfo = {
  encoding: SmsEncoding;
  /** Septets for GSM-7 (extension characters count 2), UTF-16 code units for UCS-2. */
  characters: number;
  segments: number;
  /** Capacity of each segment at this length: 160/153 (GSM-7) or 70/67 (UCS-2). */
  perSegment: number;
  /** Characters left before another segment is needed. */
  remaining: number;
  /** Characters that forced UCS-2 (for example curly quotes or emoji), in order of first use. */
  unicodeCharacters: string[];
};

function pack(units: number[], single: number, multi: number) {
  const total = units.reduce((sum, unit) => sum + unit, 0);
  if (total === 0) return { characters: 0, segments: 0, perSegment: single, remaining: single };
  if (total <= single) return { characters: total, segments: 1, perSegment: single, remaining: single - total };

  let segments = 1;
  let used = 0;
  for (const unit of units) {
    if (used + unit > multi) {
      segments += 1;
      used = 0;
    }
    used += unit;
  }
  return { characters: total, segments, perSegment: multi, remaining: multi - used };
}

/** Works out the encoding and how many SMS segments (billed messages) a body needs. */
export function smsSegments(body: string): SmsSegmentInfo {
  const characters = Array.from(body);
  const unicodeCharacters = unique(characters.filter((character) => !GSM_BASIC.has(character) && !GSM_EXTENSION.has(character)));

  if (unicodeCharacters.length === 0) {
    const units = characters.map((character) => (GSM_EXTENSION.has(character) ? 2 : 1));
    return { encoding: "GSM-7", ...pack(units, 160, 153), unicodeCharacters };
  }

  const units = characters.map((character) => character.length);
  return { encoding: "UCS-2", ...pack(units, 70, 67), unicodeCharacters };
}

export type TemplateKind = "mot" | "service" | "review" | "missed_call" | "booking_confirmed";

export type DefaultTemplate = {
  readonly kind: TemplateKind;
  /**
   * `reminder` messages need stored consent (or soft opt-in), the send window
   * and the opt-out line. `service` messages answer something the customer
   * did (a call, a booking) and are sent straight away.
   */
  readonly purpose: "reminder" | "service";
  /** Email subject (rendered with the same placeholders). */
  readonly subject: string;
  /**
   * Body without the opt-out line: renderTemplate(body, vars, { channel })
   * adds "Reply STOP to opt out." for SMS and WhatsApp.
   */
  readonly body: string;
};

export const DEFAULT_TEMPLATES: Readonly<Record<TemplateKind, DefaultTemplate>> = Object.freeze({
  mot: {
    kind: "mot",
    purpose: "reminder",
    subject: "Your MOT is due on {due_date}",
    body: "{garage}: Hi {first_name}, MOT due {due_date}. Book: {link}",
  },
  service: {
    kind: "service",
    purpose: "reminder",
    subject: "Your {vehicle} is due a service",
    body: "{garage}: Hi {first_name}, service due. Book: {link}",
  },
  review: {
    kind: "review",
    purpose: "reminder",
    subject: "How did we do?",
    body: "{garage}: thanks {first_name}! Please review us: {link}",
  },
  missed_call: {
    kind: "missed_call",
    purpose: "service",
    subject: "Sorry we missed your call",
    body: "{garage}: sorry we missed your call. Book at {link} or we'll call you back.",
  },
  booking_confirmed: {
    kind: "booking_confirmed",
    purpose: "service",
    subject: "You're booked in: {service} on {date}",
    body: "{garage}: you're booked in for {service} on {date} at {time}. Ref {reference}. Change or cancel: {manage_link}",
  },
});
