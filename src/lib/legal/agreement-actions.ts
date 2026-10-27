"use server";

import { refresh } from "next/cache";
import { createAdminClient } from "@/lib/supabase/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import type { AcceptAgreementState } from "./agreement-forms";
import { DPA_KIND, DPA_VERSION, dpaTextHash } from "./documents";

/**
 * Accepts the current DPA for the signed-in owner's selected garage. The
 * garage, user, version and text hash all come from the server; the form only
 * confirms. Reused by the sign-up flow (P4.4) once the new garage is selected.
 */
export async function acceptDpaAction(previous: AcceptAgreementState, formData: FormData): Promise<AcceptAgreementState> {
  const next = (status: AcceptAgreementState["status"]): AcceptAgreementState => ({ status, seq: previous.seq + 1 });
  const admin = await getAdminContext();
  if (!admin || admin.role !== "owner") return next("forbidden");
  if (formData.get("version") !== DPA_VERSION) return next("stale");
  if (formData.get("confirm") !== "yes") return next("unconfirmed");
  const service = createAdminClient();
  if (!service) return next("failed");
  const { error } = await service.rpc("accept_garage_agreement", {
    p_garage_id: admin.garage.id,
    p_user_id: admin.user.id,
    p_kind: DPA_KIND,
    p_version: DPA_VERSION,
    p_text_hash: dpaTextHash(admin.garage),
    p_accepted_by_name: admin.profile.display_name?.trim() || admin.user.email || "Owner",
  });
  if (error) return next(error.message.includes("AGREEMENT_FORBIDDEN") ? "forbidden" : "failed");
  refresh();
  return next("accepted");
}
