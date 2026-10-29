import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { maskMobile } from "@/lib/booking-flow/copy";
import { telHref } from "@/lib/tenancy/contact";
import type { MissedCallCard } from "./missed-calls";

// The Calls tab of Messages & calls: the garage's latest calls, answered and missed, through the
// member's RLS garage client (the explicit garage filter is a second guard), shaped like the
// "Needs your OK" card (P4.1) so the same card, voicemail player and Mark handled work here.

export type RecentCall = MissedCallCard & {
  missed: boolean;
  /** The call has been dealt with (missed calls only). */
  handled: boolean;
  /** Seconds the call lasted, when Twilio said. */
  durationSeconds: number | null;
};

type CallRow = {
  id: string;
  from_number: string | null;
  created_at: string;
  missed: boolean;
  status: string;
  duration_s: number | null;
  voicemail_url: string | null;
  voicemail_duration_s: number | null;
  text_back_message_id: string | null;
  handled_at: string | null;
  ai_summary: string | null;
  ai_outcome: string | null;
};

export const RECENT_CALLS_LIMIT = 50;

/** The garage's latest calls, newest first. `null` when they can't be read. */
export async function listRecentCalls(client: SupabaseClient, garageId: string, options: { limit?: number } = {}): Promise<RecentCall[] | null> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? RECENT_CALLS_LIMIT)));
  const { data, error } = await client
    .from("calls")
    .select("id,from_number,created_at,missed,status,duration_s,voicemail_url,voicemail_duration_s,text_back_message_id,handled_at,ai_summary,ai_outcome")
    .eq("garage_id", garageId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return null;
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
    missed: call.missed,
    handled: Boolean(call.handled_at),
    durationSeconds: call.missed ? null : call.duration_s,
  }));
}
