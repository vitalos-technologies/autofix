/**
 * Messages & calls (`/app/messages`): conversations and threads in words. Pure and client-safe:
 * rows come from `messages` through the member's RLS client (src/lib/messages/inbox.ts).
 */
import { formatDayMonth, formatShortDateKey, localDateKey } from "@/lib/admin/dates";
import { maskEmail, maskMobile } from "@/lib/booking-flow/copy";
import { classifyInbound } from "@/lib/messaging/keywords";

type Related<T> = T | T[] | null | undefined;

function related<T>(value: Related<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export type MessageChannelName = "sms" | "whatsapp" | "email";
export type MessageDirection = "inbound" | "outbound";

export type MessageRow = {
  id: string;
  customer_id: string | null;
  channel: MessageChannelName;
  direction: MessageDirection;
  body: string | null;
  status: string;
  created_at: string;
  read_at?: string | null;
  error_code?: string | null;
  redacted_at?: string | null;
  from_address?: string | null;
  reminder_send_id?: string | null;
  booking_id?: string | null;
  call_id?: string | null;
  reminder_sends?: Related<{ kind: string | null }>;
  bookings?: Related<{ reference: string | null }>;
};

export type ConversationCustomer = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  channel: string | null;
  opted_out_at: string | null;
  anonymised_at: string | null;
};

export type Conversation = {
  customerId: string;
  name: string;
  /** The channel of the latest message. */
  channel: MessageChannelName;
  /** "You: See you Thursday" for the garage's own messages. */
  preview: string;
  at: string;
  direction: MessageDirection;
  unread: number;
  optedOut: boolean;
};

export const PREVIEW_LENGTH = 90;

function clip(text: string, length = PREVIEW_LENGTH) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat;
}

/** The text of a message as staff see it: the body, or a note when retention cleared it. */
export function messageText(row: Pick<MessageRow, "body" | "redacted_at">): string {
  if (row.body === null || row.body === undefined) return "Message removed after 12 months.";
  return row.body;
}

/**
 * One conversation per customer, newest first: the latest message as a preview and how many of the
 * customer's messages nobody at the garage has opened yet. Rows must be newest first.
 */
export function shapeConversations(rows: readonly MessageRow[], customers: readonly ConversationCustomer[], unread: ReadonlyMap<string, number>): Conversation[] {
  const people = new Map(customers.map((customer) => [customer.id, customer]));
  const latest = new Map<string, MessageRow>();
  for (const row of rows) {
    if (!row.customer_id || latest.has(row.customer_id)) continue;
    latest.set(row.customer_id, row);
  }
  const conversations: Conversation[] = [];
  for (const [customerId, row] of latest) {
    const customer = people.get(customerId);
    if (!customer || customer.anonymised_at) continue;
    const text = clip(messageText(row));
    conversations.push({
      customerId,
      name: customer.name?.trim() || "Customer",
      channel: row.channel,
      preview: row.direction === "outbound" ? `You: ${text}` : text,
      at: row.created_at,
      direction: row.direction,
      unread: unread.get(customerId) ?? 0,
      optedOut: Boolean(customer.opted_out_at),
    });
  }
  return conversations.sort((a, b) => b.at.localeCompare(a.at));
}

/** Counts unread inbound rows per customer (`read_at` null). */
export function countUnread(rows: ReadonlyArray<{ customer_id: string | null }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.customer_id) continue;
    counts.set(row.customer_id, (counts.get(row.customer_id) ?? 0) + 1);
  }
  return counts;
}

const REMINDER_LABELS: Record<string, string> = { mot: "MOT reminder", service: "Service reminder", review: "Review request" };

/** What sent an outbound message, when it wasn't a person: "MOT reminder", "Booking update HRM-1042", "Missed-call text-back". */
export function messageLabel(row: MessageRow): string | null {
  if (row.direction !== "outbound") return null;
  if (row.reminder_send_id) return REMINDER_LABELS[related(row.reminder_sends)?.kind ?? ""] ?? "Reminder";
  if (row.booking_id) {
    const reference = related(row.bookings)?.reference;
    return reference ? `Booking update ${reference}` : "Booking update";
  }
  if (row.call_id) return "Missed-call text-back";
  return null;
}

const STATUS_LABELS: Record<string, { label: string; tone: "neutral" | "success" | "danger" }> = {
  queued: { label: "Queued", tone: "neutral" },
  sending: { label: "Sending", tone: "neutral" },
  sent: { label: "Sent", tone: "neutral" },
  delivered: { label: "Delivered", tone: "success" },
  failed: { label: "Not delivered", tone: "danger" },
};

/** Delivery status of an outbound message in words; inbound messages have none. */
export function deliveryStatus(row: Pick<MessageRow, "direction" | "status">): { label: string; tone: "neutral" | "success" | "danger" } | null {
  if (row.direction !== "outbound") return null;
  return STATUS_LABELS[row.status] ?? { label: "Sent", tone: "neutral" };
}

export type ThreadItem =
  | { type: "day"; key: string; label: string }
  | {
      type: "message";
      key: string;
      id: string;
      direction: MessageDirection;
      channel: MessageChannelName;
      text: string;
      removed: boolean;
      at: string;
      label: string | null;
      status: { label: string; tone: "neutral" | "success" | "danger" } | null;
      unread: boolean;
    }
  | { type: "system"; key: string; text: string };

const SYSTEM_LINES = {
  stop: "Opted out by replying STOP. No more texts go to them until they send START.",
  start: "Opted back in by replying START.",
} as const;

/**
 * A conversation in time order (rows oldest first): a line for each new day, each message with
 * what sent it and its delivery status, and a system line after a STOP or START.
 */
export function threadItems(rows: readonly MessageRow[], options: { timeZone: string; today: string }): ThreadItem[] {
  const items: ThreadItem[] = [];
  let day = "";
  const year = Number(options.today.slice(0, 4));
  for (const row of rows) {
    const key = localDateKey(row.created_at, options.timeZone);
    if (key !== day) {
      day = key;
      items.push({ type: "day", key: `day-${key}`, label: key === options.today ? "Today" : `${formatShortDateKey(key)}${Number(key.slice(0, 4)) !== year ? ` ${key.slice(0, 4)}` : ""}` });
    }
    items.push({
      type: "message",
      key: row.id,
      id: row.id,
      direction: row.direction,
      channel: row.channel,
      text: messageText(row),
      removed: row.body === null || row.body === undefined,
      at: row.created_at,
      label: messageLabel(row),
      status: deliveryStatus(row),
      unread: row.direction === "inbound" && !row.read_at,
    });
    if (row.direction === "inbound" && row.channel !== "email" && row.body) {
      const intent = classifyInbound(row.body);
      if (intent === "stop" || intent === "start") items.push({ type: "system", key: `${row.id}-${intent}`, text: SYSTEM_LINES[intent] });
    }
  }
  return items;
}

export type ReplyBlockInput = {
  customer: Pick<ConversationCustomer, "name" | "phone" | "email" | "channel" | "opted_out_at" | "anonymised_at">;
  /** The member's role may send (owner, manager, front desk). */
  canReply: boolean;
  /** The garage has a provisioned messaging number (A55). */
  hasMessagingNumber: boolean;
};

/** Why the reply box is off, in plain words, or null when staff can reply. Mirrors claim_staff_reply(). */
export function replyBlock({ customer, canReply, hasMessagingNumber }: ReplyBlockInput): string | null {
  const name = customer.name?.trim().split(/\s+/)[0] || "This customer";
  if (!canReply) return "You can read messages. Owners, managers and front desk can reply.";
  if (customer.anonymised_at) return "This customer's details were removed, so they can't be messaged.";
  if (customer.opted_out_at) {
    return `${name} opted out on ${formatDayMonth(localDateKey(customer.opted_out_at))}, so you can't text them. They can text START to opt back in.`;
  }
  if (customer.channel === "email") {
    return customer.email ? null : `${name} asked for email but there's no email address on their record. Add one on their customer page.`;
  }
  if (!customer.phone) return `There's no mobile number for ${name}. Add one on their customer page.`;
  if (!hasMessagingNumber) return "Your garage doesn't have a texting number yet, so replies can't be sent. Ask Vitalos to set one up.";
  return null;
}

/** "07••• •••123" or "s•••@example.com": how a customer's address shows on screen. */
export function maskedAddress(customer: Pick<ConversationCustomer, "phone" | "email" | "channel">): string | null {
  if (customer.channel === "email" && customer.email) return maskEmail(customer.email);
  return customer.phone ? maskMobile(customer.phone) : customer.email ? maskEmail(customer.email) : null;
}

export const CHANNEL_NAMES: Record<MessageChannelName, string> = { sms: "SMS", whatsapp: "WhatsApp", email: "Email" };

/** "11:12" today, "Mon 26 Oct" before that: when a message came, in the garage's time. */
export function shortWhen(at: string, options: { timeZone: string; today: string }): string {
  const day = localDateKey(at, options.timeZone);
  if (day === options.today) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: options.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
  }
  return formatShortDateKey(day);
}
