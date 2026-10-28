"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseTokenName, type IssueTokenState } from "@/lib/ai-front-desk/forms";
import { issueAgentToken } from "@/lib/agent-api/store";
import { isPlanRequiredDatabaseError, PlanRequiredError } from "@/lib/plans/entitlements";
import { featureProblem } from "@/lib/plans/server";
import { auditSetupChange, NOT_ALLOWED_MESSAGES, requireSetupContext, roleAllows, stateFor } from "@/lib/settings/server";
import { createAdminClient } from "@/lib/supabase/server";

// Settings · AI front desk (P5.12). The garage is always the signed-in member's selected garage
// (MFA done this session). The switch is the owner's (set_ai_front_desk(), Pro to switch on);
// Workforce tokens are issued and revoked by owners and managers, like list_agent_tokens() and
// revoke_agent_token(). Issuing needs Pro (the database refuses it too); revoking never does.

const PATH = "/app/settings/ai-front-desk";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Switch the AI front desk on or off (form field `enabled` = "on" | "off"). */
export async function setAiFrontDeskAction(formData: FormData) {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) redirect(`${PATH}?error=owner_only`);
  const enabled = formData.get("enabled") === "on";
  if (enabled && featureProblem(admin, "ai_front_desk")) redirect(`${PATH}?error=plan_required`);

  const { error } = await admin.client.rpc("set_ai_front_desk", { p_enabled: enabled });
  if (error) redirect(`${PATH}?error=${isPlanRequiredDatabaseError(error) ? "plan_required" : error.code === "42501" ? "owner_only" : "save_failed"}`);
  revalidatePath(PATH);
  redirect(`${PATH}?done=${enabled ? "enabled" : "disabled"}`);
}

export async function issueWorkforceTokenAction(previous: IssueTokenState, formData: FormData): Promise<IssueTokenState> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });
  const planProblem = featureProblem(admin, "ai_front_desk");
  if (planProblem) return stateFor(previous, { status: "error", message: planProblem });
  const parsed = parseTokenName(formData.get("name"));
  if (!parsed.ok) return stateFor(previous, { status: "error", message: parsed.message, fieldErrors: { name: parsed.message } });

  let issued;
  try {
    issued = await issueAgentToken({ garageId: admin.garage.id, name: parsed.name, audience: "workforce" }, createAdminClient());
  } catch (error) {
    const message = error instanceof PlanRequiredError ? error.message : "The token could not be created. Try again.";
    return stateFor(previous, { status: "error", message });
  }
  await auditSetupChange(admin, "agent_token.issued", "agent_token", issued.id, { name: issued.name, audience: issued.audience });
  revalidatePath(PATH);
  return {
    ...stateFor(previous, { status: "saved", message: "Token created. Copy it now: it won't be shown again." }),
    token: issued.token,
    tokenName: issued.name,
  };
}

export async function revokeAgentTokenAction(formData: FormData) {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) redirect(`${PATH}?error=manage_only`);
  const tokenId = String(formData.get("tokenId") ?? "");
  if (!UUID.test(tokenId)) redirect(`${PATH}?error=save_failed`);
  const { data, error } = await admin.client.rpc("revoke_agent_token", { p_token_id: tokenId });
  if (error) redirect(`${PATH}?error=${error.code === "42501" ? "manage_only" : "save_failed"}`);
  if (data === true) await auditSetupChange(admin, "agent_token.revoked", "agent_token", tokenId);
  revalidatePath(PATH);
  redirect(`${PATH}?done=${data === true ? "revoked" : "already_revoked"}#tokens`);
}
