import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { GARAGE_SELECT, garageFromRow, type Garage, type GarageRow } from "@/lib/tenancy/garage";
import { databaseError, permanentJobError } from "./types";

// Garages as the jobs see them (service role). Fan-out jobs list garages and
// queue one job per garage; per-garage jobs load the full profile for links.

/** Garages whose booking site is served and whose reminders go out. */
export const ACTIVE_GARAGE_STATUSES = ["onboarding", "active"] as const;

export type JobGarage = { id: string; timezone: string; mot_enabled: boolean; status: string };

export async function listGarages(
  db: SupabaseClient,
  filter: { statuses?: readonly string[]; motEnabled?: boolean } = {},
): Promise<JobGarage[]> {
  let query = db.from("garages").select("id,timezone,mot_enabled,status");
  if (filter.statuses) query = query.in("status", [...filter.statuses]);
  if (filter.motEnabled !== undefined) query = query.eq("mot_enabled", filter.motEnabled);
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) throw databaseError("garages.list", error);
  return ((data ?? []) as Array<Partial<JobGarage> & { id: string }>).map((row) => ({
    id: row.id,
    timezone: row.timezone || "Europe/London",
    mot_enabled: row.mot_enabled ?? false,
    status: row.status ?? "onboarding",
  }));
}

/** The garage's profile, or a permanent error when it no longer exists (the job can never succeed). */
export async function loadJobGarage(db: SupabaseClient, garageId: string): Promise<Garage> {
  const { data, error } = await db.from("garages").select(GARAGE_SELECT).eq("id", garageId).maybeSingle();
  if (error) throw databaseError("garages.load", error);
  if (!data) throw permanentJobError("GARAGE_NOT_FOUND");
  return garageFromRow(data as GarageRow);
}
