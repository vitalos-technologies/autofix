/**
 * The Reminders page's "Due in the next 30 days" table (P3.10): cars whose MOT or service falls due,
 * with what is happening about it. Pure: rows come from `reminder_sends` (the scheduler only makes
 * them for customers who agreed to reminders) and, for MOTs, from the cars themselves, so a car
 * whose owner never agreed still shows "No consent, won't send".
 */
import type { StatusPillStatus } from "@/components/admin-ui/types";
import { formatDayMonth, localDateKey } from "@/lib/admin/dates";
import type { RuleKind } from "@/lib/reminders/rules";

type Related<T> = T | T[] | null | undefined;

function related<T>(value: Related<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export type DueSendRow = {
  id: string;
  kind: string;
  due_date: string;
  send_at: string;
  status: string;
  skip_reason: string | null;
  sent_at: string | null;
  booking_id: string | null;
  customer_id: string | null;
  vehicle_id: string;
  customers?: Related<{ name: string | null }>;
  vehicles?: Related<{ registration: string | null; make: string | null; model: string | null }>;
  bookings?: Related<{ created_at: string | null }>;
};

export type DueVehicleRow = {
  id: string;
  registration: string | null;
  make?: string | null;
  model?: string | null;
  mot_expiry: string | null;
  customer_id: string | null;
  customers?: Related<{ name: string | null; reminder_consent: boolean | null; opted_out_at: string | null; anonymised_at: string | null }>;
};

export type DueRow = {
  key: string;
  customerId: string | null;
  customerName: string;
  /** Stored form (`BC23DEF`). Shown as a plate chip, never put in a link. */
  registration: string;
  kind: "mot" | "service";
  dueDate: string;
  status: StatusPillStatus;
  label: string;
  /** Nothing will be sent: the row is drawn muted. */
  muted: boolean;
};

const SKIP_LABELS: Record<string, { status: StatusPillStatus; label: string; muted: boolean }> = {
  no_consent: { status: "no_consent", label: "No consent, won't send", muted: true },
  opted_out: { status: "no_consent", label: "Opted out, won't send", muted: true },
  anonymised: { status: "skipped", label: "Customer removed", muted: true },
  no_address: { status: "skipped", label: "No mobile or email", muted: true },
  rule_disabled: { status: "skipped", label: "Reminders off", muted: true },
  rule_changed: { status: "skipped", label: "Rule changed", muted: true },
  rule_missing: { status: "skipped", label: "Reminders off", muted: true },
  mot_disabled: { status: "skipped", label: "MOT switched off", muted: true },
  already_booked: { status: "booked", label: "Already booked", muted: false },
  due_date_changed: { status: "cancelled", label: "Date changed", muted: true },
  expired: { status: "skipped", label: "Too late to send", muted: true },
  no_customer: { status: "skipped", label: "No customer", muted: true },
};

function day(value: string | null | undefined, timeZone: string, currentYear: number) {
  if (!value) return "";
  return formatDayMonth(localDateKey(value, timeZone), currentYear);
}

/** What one reminder send means for the car, in a few words. */
export function sendStatus(send: DueSendRow, timeZone: string, currentYear: number, today?: string): { status: StatusPillStatus; label: string; muted: boolean } {
  if (send.booking_id) {
    const at = related(send.bookings)?.created_at;
    return { status: "booked", label: at ? `Booked ${day(at, timeZone, currentYear)}` : "Booked", muted: false };
  }
  switch (send.status) {
    case "sent":
    case "delivered":
      return { status: send.status, label: send.sent_at ? `Sent ${day(send.sent_at, timeZone, currentYear)}` : "Sent", muted: false };
    case "sending":
      return { status: "sending", label: "Sending", muted: false };
    case "scheduled":
      // A send whose day has passed is still waiting for the send window (or the next run).
      if (today && localDateKey(send.send_at, timeZone) < today) return { status: "scheduled", label: "Waiting to send", muted: false };
      return { status: "scheduled", label: `Sends ${day(send.send_at, timeZone, currentYear)}`, muted: false };
    case "failed":
      return { status: "failed", label: "Didn't send", muted: false };
    default:
      return SKIP_LABELS[send.skip_reason ?? ""] ?? { status: "skipped", label: "Won't send", muted: true };
  }
}

/** Which of a car's sends (one per offset) speaks for it: booked, then sent, then the next one due. */
function rank(send: DueSendRow): number {
  if (send.booking_id) return 0;
  if (send.status === "sent" || send.status === "delivered" || send.status === "sending") return 1;
  if (send.status === "scheduled") return 2;
  if (send.status === "failed") return 3;
  return 4;
}

function better(a: DueSendRow, b: DueSendRow) {
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank < 0 ? a : b;
  // Two sent: the latest; two scheduled: the soonest.
  if (rank(a) === 1) return (a.sent_at ?? "") >= (b.sent_at ?? "") ? a : b;
  return a.send_at <= b.send_at ? a : b;
}

export type DueSoonInput = {
  sends: DueSendRow[];
  /** Cars with an MOT due in the window (only when the garage does MOTs). */
  motVehicles: DueVehicleRow[];
  /** The MOT rule is switched on. */
  motRuleOn: boolean;
  today: string;
  timeZone: string;
};

export function shapeDueSoon({ sends, motVehicles, motRuleOn, today, timeZone }: DueSoonInput): DueRow[] {
  const year = Number(today.slice(0, 4));
  const best = new Map<string, DueSendRow>();
  for (const send of sends) {
    if (send.kind !== "mot" && send.kind !== "service") continue;
    const key = `${send.vehicle_id}:${send.kind}:${send.due_date}`;
    const current = best.get(key);
    best.set(key, current ? better(current, send) : send);
  }

  const rows: DueRow[] = [...best.entries()].map(([key, send]) => {
    const vehicle = related(send.vehicles);
    return {
      key,
      customerId: send.customer_id,
      customerName: related(send.customers)?.name?.trim() || "Customer",
      registration: (vehicle?.registration ?? "").toUpperCase().replace(/\s+/g, ""),
      kind: send.kind as "mot" | "service",
      dueDate: send.due_date,
      ...sendStatus(send, timeZone, year, today),
    };
  });

  for (const vehicle of motVehicles) {
    if (!vehicle.mot_expiry) continue;
    const key = `${vehicle.id}:mot:${vehicle.mot_expiry}`;
    if (best.has(key)) continue;
    const customer = related(vehicle.customers);
    if (!customer || customer.anonymised_at) continue;
    const outcome = customer.opted_out_at
      ? SKIP_LABELS.opted_out!
      : !customer.reminder_consent
        ? SKIP_LABELS.no_consent!
        : !motRuleOn
          ? SKIP_LABELS.rule_disabled!
          : { status: "scheduled" as const, label: "Not planned yet", muted: true };
    rows.push({
      key,
      customerId: vehicle.customer_id,
      customerName: customer.name?.trim() || "Customer",
      registration: (vehicle.registration ?? "").toUpperCase().replace(/\s+/g, ""),
      kind: "mot",
      dueDate: vehicle.mot_expiry,
      ...outcome,
    });
  }

  return rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.customerName.localeCompare(b.customerName));
}

export const KIND_LABELS: Record<RuleKind, string> = { mot: "MOT", service: "Service", review: "Review", missed_call: "Missed call" };

/** "38 27%": the share of this month's sent reminders that led to a booking. */
export function bookedShare(booked: number, sent: number): string | null {
  if (sent <= 0 || booked <= 0) return null;
  return `${Math.round((booked / sent) * 100)}%`;
}
