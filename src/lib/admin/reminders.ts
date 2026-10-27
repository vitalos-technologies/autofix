import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, DEFAULT_TIME_ZONE, startOfLocalDay } from "@/lib/admin/dates";
import { shapeDueSoon, type DueRow, type DueSendRow, type DueVehicleRow } from "@/lib/admin/reminder-view";
import { RULE_CHANNELS, RULE_KINDS, type RuleChannel, type RuleKind } from "@/lib/reminders/rules";

// Reads for the Reminders page (P3.10) and Today's "Won back by reminders". Every function takes the
// member's RLS garage client (getAdminContext().client, x-garage-id) and also filters on the garage
// id, as a second guard. None of them uses the service role: `reminder_won_back()` is service-role
// only (A53), so `loadReminderMonth` works the same figures out from rows staff can read.

export type ReminderRule = {
  id: string;
  kind: RuleKind;
  enabled: boolean;
  offsetDays: number[];
  channel: RuleChannel;
  template: string;
  updatedAt: string | null;
};

type RuleRow = { id: string; kind: string; enabled: boolean; offset_days: number[] | null; channel: string; template: string; updated_at: string | null };

/** The garage's reminder rules, one per kind. `null` when they cannot be read. */
export async function loadReminderRules(client: SupabaseClient, garageId: string): Promise<ReminderRule[] | null> {
  const { data, error } = await client.from("reminder_rules").select("id,kind,enabled,offset_days,channel,template,updated_at").eq("garage_id", garageId);
  if (error || !data) return null;
  return (data as RuleRow[])
    .filter((row) => (RULE_KINDS as readonly string[]).includes(row.kind))
    .map((row) => ({
      id: row.id,
      kind: row.kind as RuleKind,
      enabled: row.enabled,
      offsetDays: Array.isArray(row.offset_days) ? row.offset_days : [],
      channel: (RULE_CHANNELS as readonly string[]).includes(row.channel) ? (row.channel as RuleChannel) : "customer",
      template: row.template,
      updatedAt: row.updated_at,
    }))
    .sort((a, b) => RULE_KINDS.indexOf(a.kind) - RULE_KINDS.indexOf(b.kind));
}

export type ReminderMonth = {
  /** Reminders sent in the month (`reminder_sends.sent_at`). */
  sent: number;
  /** Bookings made from a reminder link in the month, not cancelled or no-show. */
  booked: number;
  /** What those bookings bring: issued or paid invoice totals, else the booking's price. */
  pence: number;
  /** Customers who opted out in the month (STOP, unsubscribe link, staff). */
  optedOut: number;
};

/** "2026-10-01" → "2026-11-01". */
export function nextMonthStart(monthFirst: string): string {
  const [year = 0, month = 1] = monthFirst.split("-").map(Number);
  return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
}

async function headCount(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const { count, error } = await query;
  return error ? null : (count ?? 0);
}

type CreditedBooking = { id: string; price_pence: number | null; status: string };
type InvoiceRow = { booking_id: string | null; total_pence: number | null };

/**
 * This month's reminder figures, as `reminder_won_back()` defines them (A53): a booking counts when it
 * carries a `reminder_send_id`, was made in the month (garage time zone) and is not cancelled, a
 * no-show or deleted; it brings the total of its issued or paid invoices when it has any, else its
 * price. `null` when the figures cannot be read.
 */
export async function loadReminderMonth(client: SupabaseClient, garageId: string, monthFirst: string, timeZone = DEFAULT_TIME_ZONE): Promise<ReminderMonth | null> {
  const from = startOfLocalDay(monthFirst, timeZone).toISOString();
  const to = startOfLocalDay(nextMonthStart(monthFirst), timeZone).toISOString();
  const [sent, optedOut, bookings] = await Promise.all([
    headCount(client.from("reminder_sends").select("id", { count: "exact", head: true }).eq("garage_id", garageId).gte("sent_at", from).lt("sent_at", to)),
    headCount(client.from("customers").select("id", { count: "exact", head: true }).eq("garage_id", garageId).gte("opted_out_at", from).lt("opted_out_at", to)),
    client
      .from("bookings")
      .select("id,price_pence,status")
      .eq("garage_id", garageId)
      .not("reminder_send_id", "is", null)
      .is("deleted_at", null)
      .not("status", "in", "(cancelled,no_show)")
      .gte("created_at", from)
      .lt("created_at", to)
      .limit(5000),
  ]);
  if (sent === null || optedOut === null || bookings.error) return null;
  const credited = (bookings.data ?? []) as CreditedBooking[];

  const invoiced = new Map<string, number>();
  if (credited.length > 0) {
    const { data, error } = await client
      .from("invoices")
      .select("booking_id,total_pence")
      .eq("garage_id", garageId)
      .in("booking_id", credited.map((booking) => booking.id))
      .in("status", ["issued", "paid"])
      .is("deleted_at", null)
      .limit(10000);
    if (error) return null;
    for (const invoice of (data ?? []) as InvoiceRow[]) {
      if (!invoice.booking_id) continue;
      invoiced.set(invoice.booking_id, (invoiced.get(invoice.booking_id) ?? 0) + Number(invoice.total_pence ?? 0));
    }
  }

  const pence = credited.reduce((total, booking) => total + (invoiced.get(booking.id) ?? booking.price_pence ?? 0), 0);
  return { sent, booked: credited.length, pence, optedOut };
}

export const DUE_SOON_DAYS = 30;
const DUE_SOON_LIMIT = 500;

const SEND_SELECT =
  "id,kind,due_date,send_at,status,skip_reason,sent_at,booking_id,customer_id,vehicle_id,customers(name),vehicles(registration,make,model),bookings!reminder_sends_booking_id_fkey(created_at)";
const VEHICLE_SELECT = "id,registration,make,model,mot_expiry,customer_id,customers(name,reminder_consent,opted_out_at,anonymised_at)";

/**
 * MOTs and services falling due in the next 30 days and what is happening about each. MOT rows only
 * when the garage does MOTs (`garages.mot_enabled`). `null` when the reminders cannot be read.
 */
export async function loadDueSoon(
  client: SupabaseClient,
  garageId: string,
  input: { today: string; timeZone: string; motEnabled: boolean; motRuleOn: boolean; days?: number },
): Promise<DueRow[] | null> {
  const last = addDays(input.today, input.days ?? DUE_SOON_DAYS);
  const kinds = input.motEnabled ? ["mot", "service"] : ["service"];
  const [sends, vehicles] = await Promise.all([
    client
      .from("reminder_sends")
      .select(SEND_SELECT)
      .eq("garage_id", garageId)
      .in("kind", kinds)
      .gte("due_date", input.today)
      .lte("due_date", last)
      .order("due_date", { ascending: true })
      .limit(DUE_SOON_LIMIT),
    input.motEnabled
      ? client
          .from("vehicles")
          .select(VEHICLE_SELECT)
          .eq("garage_id", garageId)
          .not("customer_id", "is", null)
          .gte("mot_expiry", input.today)
          .lte("mot_expiry", last)
          .order("mot_expiry", { ascending: true })
          .limit(DUE_SOON_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sends.error || vehicles.error) return null;
  return shapeDueSoon({
    sends: (sends.data ?? []) as unknown as DueSendRow[],
    motVehicles: (vehicles.data ?? []) as unknown as DueVehicleRow[],
    motRuleOn: input.motRuleOn,
    today: input.today,
    timeZone: input.timeZone,
  });
}
