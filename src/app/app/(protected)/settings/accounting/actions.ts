"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { chooseTenant, disconnect } from "@/lib/accounting/server";
import { garageHasFeature } from "@/lib/plans/server";
import { auditSetupChange, requireSetupContext, roleAllows } from "@/lib/settings/server";

// Settings · Accounting (P5.10). The garage is the member's selected garage (never the form). Owners
// choose the organisation and disconnect; owners and managers press Sync now and Retry, which run
// through the plan-gated SQL functions with the member's own RLS client.

const PATH = "/app/settings/accounting";

/** Runs the queued accounting.sync job straight after the response (the cron would pick it up later otherwise). */
function syncAfterResponse() {
  try {
    after(async () => {
      try {
        const { drainJobs } = await import("@/lib/jobs/runner");
        await drainJobs({ kinds: ["accounting.sync"], budgetMs: 10_000 });
      } catch {
        // The job stays queued for the next drain.
      }
    });
  } catch {
    // Outside a request.
  }
}

async function context(level: "owner" | "manage", needsPlan = true) {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, level)) redirect(`${PATH}?error=${level === "owner" ? "owner_only" : "not_allowed"}`);
  if (needsPlan && !garageHasFeature(admin.garage, "accounting_sync")) redirect(`${PATH}?error=plan`);
  return admin;
}

const tenantSchema = z.object({ tenantId: z.string().min(1).max(200) });

export async function chooseOrganisationAction(formData: FormData) {
  const admin = await context("owner");
  const parsed = tenantSchema.safeParse({ tenantId: formData.get("tenantId") });
  if (!parsed.success) redirect(`${PATH}?choose=1&error=choose_one`);
  const ok = await chooseTenant({ garageId: admin.garage.id, tenantId: parsed.data.tenantId, userId: admin.user.id });
  if (!ok) redirect(`${PATH}?choose=1&error=choose_failed`);
  revalidatePath(PATH);
  redirect(`${PATH}?done=connected`);
}

export async function disconnectAction(formData: FormData) {
  // Allowed on Essentials too: a garage can always cut the link.
  const admin = await context("owner", false);
  if (formData.get("confirm") !== "yes") redirect(`${PATH}?confirm=disconnect#connection`);
  try {
    const result = await disconnect({ garageId: admin.garage.id, userId: admin.user.id });
    await auditSetupChange(admin, "accounting.disconnect_requested", "garage", admin.garage.id, { revoked: result.revoked });
  } catch {
    redirect(`${PATH}?error=disconnect_failed`);
  }
  revalidatePath(PATH);
  redirect(`${PATH}?done=disconnected`);
}

export async function syncNowAction() {
  const admin = await context("manage");
  const { error } = await admin.client.rpc("accounting_request_sync");
  if (error) redirect(`${PATH}?error=${error.message?.startsWith("PLAN_REQUIRED") ? "plan" : error.message?.startsWith("ACCOUNTING_NOT_CONNECTED") ? "not_connected" : "sync_failed"}`);
  syncAfterResponse();
  revalidatePath(PATH);
  redirect(`${PATH}?done=sync_started`);
}

const itemSchema = z.object({ itemId: z.string().uuid() });

export async function retryItemAction(formData: FormData) {
  const admin = await context("manage");
  const parsed = itemSchema.safeParse({ itemId: formData.get("itemId") });
  if (!parsed.success) redirect(`${PATH}?error=retry_failed`);
  const { error } = await admin.client.rpc("accounting_retry_item", { p_item_id: parsed.data.itemId });
  if (error) redirect(`${PATH}?error=retry_failed`);
  syncAfterResponse();
  revalidatePath(PATH);
  redirect(`${PATH}?done=retry_started`);
}
