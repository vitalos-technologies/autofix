/**
 * The booking page's history: `booking_events` rows in words. Pure.
 */
import { statusLabel } from "@/components/admin-ui/status-pill";
import { formatSlotLabel } from "@/components/book/format";
import { SOURCE_LABELS } from "@/components/admin-ui/approval-card";
import { bookingSources, bookingStatuses, type BookingSource, type BookingStatus } from "@/lib/booking-engine/types";

export type TimelineEvent = { id: string; type: string; actor: string; actorId: string | null; at: string; data: Record<string, unknown> };

export type TimelineKind = "created" | "status" | "cancelled" | "moved" | "note" | "message" | "other";

export type TimelineEntry = {
  id: string;
  kind: TimelineKind;
  title: string;
  /** Second line: the note, the reason, the new time. */
  detail: string | null;
  /** Who: "You", "Staff", "Customer", "System", "AI agent". */
  actor: string;
  at: string;
};

const MESSAGE_KINDS: Record<string, string> = {
  customer_email: "Email to the customer",
  staff_email: "Email to the garage",
  sms: "Text to the customer",
  whatsapp: "WhatsApp to the customer",
};

function isStatus(value: unknown): value is BookingStatus {
  return typeof value === "string" && (bookingStatuses as readonly string[]).includes(value);
}

function isSource(value: unknown): value is BookingSource {
  return typeof value === "string" && (bookingSources as readonly string[]).includes(value);
}

function text(value: unknown, max = 1000): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function instant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function actorLabel(event: Pick<TimelineEvent, "actor" | "actorId">, currentUserId?: string | null): string {
  if (event.actor === "staff") return event.actorId && currentUserId && event.actorId === currentUserId ? "You" : "Staff";
  if (event.actor === "customer") return "Customer";
  if (event.actor === "agent") return "AI agent";
  return "System";
}

export function timelineEntry(event: TimelineEvent, options: { currentUserId?: string | null; timeZone?: string } = {}): TimelineEntry {
  const timeZone = options.timeZone ?? "Europe/London";
  const base = { id: event.id, actor: actorLabel(event, options.currentUserId), at: event.at };
  const data = event.data ?? {};
  switch (event.type) {
    case "created": {
      const source = isSource(data.source) ? SOURCE_LABELS[data.source] : null;
      const status = isStatus(data.status) && data.status === "requested" ? "waiting for your OK" : null;
      return { ...base, kind: "created", title: "Booking made", detail: [source, status].filter(Boolean).join(", ") || null };
    }
    case "status_changed": {
      const from = isStatus(data.from) ? statusLabel(data.from) : null;
      const to = isStatus(data.to) ? statusLabel(data.to) : null;
      return { ...base, kind: "status", title: to ? `Status: ${to}` : "Status changed", detail: from && to ? `${from} → ${to}` : null };
    }
    case "cancelled":
      return { ...base, kind: "cancelled", title: "Booking cancelled", detail: text(data.reason, 300) };
    case "rescheduled": {
      const from = instant(data.from);
      const to = instant(data.to);
      return { ...base, kind: "moved", title: "Booking moved", detail: from && to ? `${formatSlotLabel(from, timeZone)} → ${formatSlotLabel(to, timeZone)}` : null };
    }
    case "note":
      return { ...base, kind: "note", title: "Note", detail: text(data.text) };
    case "notification_sent": {
      const kind = typeof data.kind === "string" ? (MESSAGE_KINDS[data.kind] ?? "Message") : "Message";
      const failed = data.status === "failed";
      return { ...base, kind: "message", title: failed ? `${kind} failed` : `${kind} sent`, detail: null };
    }
    default:
      return { ...base, kind: "other", title: "Booking updated", detail: null };
  }
}
