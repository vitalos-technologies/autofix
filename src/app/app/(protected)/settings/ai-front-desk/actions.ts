"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { parseTokenName, type IssueTokenState } from "@/lib/ai-front-desk/forms";
import { issueAgentToken } from "@/lib/agent-api/store";
import { AgentTokenConfigError } from "@/lib/agent-api/tokens";
import { isPlanRequiredDatabaseError, PlanRequiredError } from "@/lib/plans/entitlements";
import { featureProblem } from "@/lib/plans/server";
import { auditSetupChange, NOT_ALLOWED_MESSAGES, requireSetupContext, roleAllows, stateFor } from "@/lib/settings/server";
import { createAdminClient } from "@/lib/supabase/server";

// Settings · AI front desk (P5.12). The garage is always the signed-in member's selected garage
// (MFA done this session). The switch is the owner's (set_ai_front_desk(), Pro to switch on);
// Workforce tokens are issued and revoked by owners and managers, like list_agent_tokens() and
// revoke_agent_token(). Issuing needs Pro (the database refuses it too); revoking never does.
// Switching on also queues the garage's AI desk number (D22); switching off keeps any number (A436).

const PATH = "/app/settings/ai-front-desk";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * D22: switching the desk on queues the garage's number check at once (numbers.provision for this garage) and
 * runs it straight after the response, so a garage on an upgraded account gets its number in seconds. On a
 * trial account it only records "waiting for the upgrade"; the daily run re-checks either way. Never blocks
 * or fails the switch.
 */
async function provisionNumberSoon(garageId: string) {
  try {
    const [{ enqueueJob }, { utcSlot }] = await Promise.all([import("@/lib/jobs/queue"), import("@/lib/jobs/periods")]);
    await enqueueJob("numbers.provision", { garageId }, { garageId, dedupeKey: `numbers.provision:${garageId}:${utcSlot(new Date(), 1)}` });
  } catch {
    // The daily run picks the garage up.
    return;
  }
  try {
    after(async () => {
      try {
        const { drainJobs } = await import("@/lib/jobs/runner");
        await drainJobs({ kinds: ["numbers.provision"], budgetMs: 20_000 });
      } catch {
        // The queued job stays for the next drain.
      }
    });
  } catch {
    // Outside a request.
  }
}

/** Switch the AI front desk on or off (form field `enabled` = "on" | "off"). */
export async function setAiFrontDeskAction(formData: FormData) {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) redirect(`${PATH}?error=owner_only`);
  const enabled = formData.get("enabled") === "on";
  if (enabled && featureProblem(admin, "ai_front_desk")) redirect(`${PATH}?error=plan_required`);

  const { error } = await admin.client.rpc("set_ai_front_desk", { p_enabled: enabled });
  if (error) redirect(`${PATH}?error=${isPlanRequiredDatabaseError(error) ? "plan_required" : error.code === "42501" ? "owner_only" : "save_failed"}`);
  if (enabled) await provisionNumberSoon(admin.garage.id);
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
    const message = error instanceof PlanRequiredError
      ? error.message
      : error instanceof AgentTokenConfigError
        ? "Tokens can't be created until Vitalos finishes setting up the AI front desk. Try again later."
        : "The token could not be created. Try again.";
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
