import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { databaseError } from "@/lib/jobs/types";
import type { AttachResult, DueGarage, NumbersRepo, PlatformPatch } from "./provision";
import { isNumberStatus, type AiDeskNumber } from "./state";

// The numbers store (D22). Service role for the job: the five SQL functions of
// 20261029003400_twilio_numbers.sql and the one-row platform table. The settings page reads the garage's own
// row through the member's RLS client (loadAiDeskNumber).

const DUE_LIMIT = 50;

type DueRow = {
  garage_id: string;
  garage_phone: string | null;
  status: string | null;
  provider_sid: string | null;
  number: string | null;
  routed_number: string | null;
  routed_sid: string | null;
};

export function createSupabaseNumbersRepo(db: SupabaseClient): NumbersRepo {
  return {
    async listDue(garageId) {
      const { data, error } = await db.rpc("ai_front_desk_numbers_due", { p_garage_id: garageId ?? null, p_limit: DUE_LIMIT });
      if (error) throw databaseError("ai_front_desk_numbers_due", error);
      return ((data ?? []) as DueRow[]).map((row): DueGarage => ({
        garageId: row.garage_id,
        garagePhone: row.garage_phone,
        status: isNumberStatus(row.status) ? row.status : null,
        providerSid: row.provider_sid,
        number: row.number,
        routedNumber: row.routed_number,
        routedSid: row.routed_sid,
      }));
    },

    async attach(garageId, number, providerSid, ringGarageFirst): Promise<AttachResult> {
      const { error } = await db.rpc("attach_ai_front_desk_number", {
        p_garage_id: garageId,
        p_number: number,
        p_provider_sid: providerSid,
        p_ring_garage_first: ringGarageFirst,
      });
      if (!error) return "ready";
      if (error.code === "P0001" && error.message?.includes("NUMBER_TAKEN")) return "number_taken";
      if (error.code === "P0001" && error.message?.includes("ALREADY_PROVISIONED")) return "already_provisioned";
      throw databaseError("attach_ai_front_desk_number", error);
    },

    async setStatus(garageIds, status, reason) {
      if (!garageIds.length) return;
      const { error } = await db.rpc("set_ai_front_desk_number_status", { p_garage_ids: garageIds, p_status: status, p_reason: reason });
      if (error) throw databaseError("set_ai_front_desk_number_status", error);
    },

    async recordPlatform(patch: PlatformPatch) {
      const row: Record<string, unknown> = { checked_at: new Date().toISOString() };
      if (patch.accountType !== undefined) row.account_type = patch.accountType && /^[A-Za-z]{1,20}$/.test(patch.accountType) ? patch.accountType : null;
      if (patch.numbersHeld !== undefined) row.numbers_held = patch.numbersHeld;
      if (patch.numberCap !== undefined) row.number_cap = patch.numberCap;
      if (patch.textingStatus !== undefined) row.texting_status = patch.textingStatus;
      if (patch.textingReason !== undefined) row.texting_reason = patch.textingReason;
      if (patch.textingNumber !== undefined) row.texting_number = patch.textingNumber;
      if (patch.textingSid !== undefined) row.texting_sid = patch.textingSid;
      const { error } = await db.from("twilio_number_provisioning").update(row).eq("singleton", true);
      if (error) throw databaseError("twilio_number_provisioning.update", error);
    },

    async claimLease(holder, seconds) {
      const { data, error } = await db.rpc("claim_number_provisioning", { p_holder: holder, p_seconds: seconds });
      if (error) throw databaseError("claim_number_provisioning", error);
      return data === true;
    },

    async releaseLease(holder) {
      const { error } = await db.rpc("release_number_provisioning", { p_holder: holder });
      if (error) throw databaseError("release_number_provisioning", error);
    },
  };
}

/** The selected garage's AI desk number for Settings · AI front desk (RLS client), or null (none yet, or unreadable). */
export async function loadAiDeskNumber(client: SupabaseClient, garageId: string): Promise<AiDeskNumber | null> {
  const { data, error } = await client
    .from("ai_front_desk_numbers")
    .select("status,reason,number,provider_sid,checked_at,ready_at")
    .eq("garage_id", garageId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { status: string; reason: string | null; number: string | null; provider_sid: string | null; checked_at: string | null; ready_at: string | null };
  if (!isNumberStatus(row.status)) return null;

  let ringsGarageFirst: boolean | null = null;
  if (row.provider_sid) {
    const routing = await client
      .from("garage_phone_numbers")
      .select("ring_garage_first")
      .eq("garage_id", garageId)
      .eq("provider_sid", row.provider_sid)
      .maybeSingle();
    if (!routing.error && routing.data) ringsGarageFirst = (routing.data as { ring_garage_first: boolean }).ring_garage_first;
  }
  return {
    status: row.status,
    reason: row.reason,
    number: row.number,
    checkedAt: row.checked_at,
    readyAt: row.ready_at,
    ringsGarageFirst,
  };
}
