import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlanRequiredDatabaseError, planRequiredMessage } from "@/lib/plans/entitlements";

// P5.6: who did a booking's job (booking_assignments), for revenue and hours by technician.
// Reads through the RLS client (members of the selected garage); writes only through
// assign_booking_technician() (owners/managers, Pro, two-step sign-in as for other writes).

export type BookingAssignment = { technicianId: string | null; technicianName: string };
export type TeamOption = { userId: string; name: string; role: string };

export async function loadBookingAssignment(client: SupabaseClient, bookingId: string): Promise<BookingAssignment | null> {
  const { data, error } = await client.from("booking_assignments").select("technician_id, technician_name").eq("booking_id", bookingId).maybeSingle();
  if (error || !data) return null;
  return { technicianId: (data.technician_id as string | null) ?? null, technicianName: String(data.technician_name) };
}

export async function loadTeamOptions(client: SupabaseClient): Promise<TeamOption[]> {
  const { data, error } = await client.rpc("list_garage_team");
  if (error || !Array.isArray(data)) return [];
  return (data as { user_id: string; display_name: string | null; role: string }[]).map((member) => ({
    userId: member.user_id,
    name: member.display_name || "Team member",
    role: member.role,
  }));
}

export type AssignResult = { ok: true; name: string | null } | { ok: false; message: string };

export const ASSIGN_MESSAGES = {
  not_allowed: "Only the garage's owners and managers can choose who did the job.",
  not_member: "Choose someone from your team.",
  not_found: "This booking could not be found. Reload the page and try again.",
  failed: "That could not be saved. Try again.",
} as const;

export async function assignTechnician(client: SupabaseClient, bookingId: string, technicianId: string | null): Promise<AssignResult> {
  const { data, error } = await client.rpc("assign_booking_technician", { p_booking_id: bookingId, p_technician_id: technicianId });
  if (!error) return { ok: true, name: ((data as { technician_name?: string | null } | null)?.technician_name ?? null) || null };
  if (isPlanRequiredDatabaseError(error)) return { ok: false, message: planRequiredMessage("advanced_reports") };
  if (error.code === "42501") return { ok: false, message: ASSIGN_MESSAGES.not_allowed };
  if (error.code === "22023") return { ok: false, message: ASSIGN_MESSAGES.not_member };
  if (error.message?.startsWith("BOOKING_NOT_FOUND")) return { ok: false, message: ASSIGN_MESSAGES.not_found };
  return { ok: false, message: ASSIGN_MESSAGES.failed };
}
