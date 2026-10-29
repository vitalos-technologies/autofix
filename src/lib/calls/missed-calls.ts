import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { maskMobile } from "@/lib/booking-flow/copy";
import { telHref } from "@/lib/tenancy/contact";

// Missed calls for the Today "Needs your OK" card (P4.1). Reads through the
// signed-in member's RLS garage client (getAdminContext().client), so a
// garage only ever sees its own calls; the explicit garage filter is a second
// guard. The caller's full number stays server-side except in the `tel:` link
// staff tap to call back; the card shows it masked.

export type MissedCallCard = {
  id: string;
  /** When the call came in (ISO). */
  at: string;
  /** The garage's customer with this number, if any. */
  callerName: string | null;
  /** `07••• •••123`, or null for a withheld number. */
  maskedNumber: string | null;
  /** `tel:+44…` for "Call back"; null when the number was withheld. */
  callBackHref: string | null;
  /** Same-origin link that plays the voicemail for staff (`/api/admin/calls/{id}/voicemail`); null without one. */
  voicemailHref: string | null;
  voicemailSeconds: number | null;
  /** The caller was texted back (the text's own delivery status is in `messages`). */
  textedBack: boolean;
  /** P5.12 voice desk: what the AI front desk wrote about the call (no registrations), else null. */
  aiSummary: string | null;
  aiOutcome: string | null;
};

type CallRow = {
  id: string;
  from_number: string | null;
  created_at: string;
  voicemail_url: string | null;
  voicemail_duration_s: number | null;
  text_back_message_id: string | null;
  ai_summary: string | null;
  ai_outcome: string | null;
};

export const MISSED_CALL_CARD_LIMIT = 20;

/** Unhandled missed calls, newest first. Returns [] when the read fails (the card simply stays empty). */
export async function listMissedCallsNeedingOk(client: SupabaseClient, garageId: string, options: { limit?: number } = {}): Promise<MissedCallCard[]> {
  const limit = Math.max(1, Math.min(MISSED_CALL_CARD_LIMIT, Math.trunc(options.limit ?? 10)));
  const { data, error } = await client
    .from("calls")
    .select("id,from_number,created_at,voicemail_url,voicemail_duration_s,text_back_message_id,ai_summary,ai_outcome")
    .eq("garage_id", garageId)
    .eq("missed", true)
    .is("handled_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const calls = data as CallRow[];

  const numbers = [...new Set(calls.map((call) => call.from_number).filter((number): number is string => Boolean(number)))];
  const names = new Map<string, string>();
  if (numbers.length > 0) {
    const customers = await client.from("customers").select("name,phone").eq("garage_id", garageId).in("phone", numbers).is("anonymised_at", null);
    for (const row of (customers.data ?? []) as Array<{ name: string | null; phone: string | null }>) {
      if (row.phone && row.name) names.set(row.phone, row.name);
    }
  }

  return calls.map((call) => ({
    id: call.id,
    at: call.created_at,
    callerName: call.from_number ? names.get(call.from_number) ?? null : null,
    maskedNumber: call.from_number ? maskMobile(call.from_number) : null,
    callBackHref: call.from_number ? telHref(call.from_number) : null,
    voicemailHref: call.voicemail_url ? `/api/admin/calls/${call.id}/voicemail` : null,
    voicemailSeconds: call.voicemail_url ? call.voicemail_duration_s : null,
    textedBack: Boolean(call.text_back_message_id),
    aiSummary: call.ai_summary ?? null,
    aiOutcome: call.ai_outcome ?? null,
  }));
}

/** How many unhandled missed calls the garage has (for a badge). 0 when the read fails. */
export async function countMissedCallsNeedingOk(client: SupabaseClient, garageId: string): Promise<number> {
  const { count, error } = await client
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("garage_id", garageId)
    .eq("missed", true)
    .is("handled_at", null);
  return error ? 0 : count ?? 0;
}
