"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { recordAdminAudit } from "@/lib/admin/audit";
import { getBillingProvider } from "@/lib/billing";
import { loadSubscription } from "@/lib/billing/server";
import { requireSetupContext, roleAllows } from "@/lib/settings/server";
import { clearHostCache } from "@/lib/tenancy/resolve";
import { adminUrl } from "@/lib/tenancy/urls";

// Settings · Plan (P5.2). Owners only, with MFA verified in this session. The garage is the member's
// selected garage; nothing about the plan comes from the form except the optional note.

const PATH = "/app/settings/plan";

async function ownerContext() {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) redirect(`${PATH}?error=owner_only`);
  return admin;
}

function note(formData: FormData) {
  const value = formData.get("note");
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

/**
 * Upgrade to Pro: Stripe Checkout (test mode) when billing is configured, otherwise a plan request
 * Vitalos sees in /admin ("Request Pro").
 */
export async function upgradeToProAction(formData: FormData) {
  const admin = await ownerContext();
  const provider = getBillingProvider();
  const subscription = await loadSubscription(admin.garage.id);
  const result = await provider.startUpgrade({
    garage: { id: admin.garage.id, name: admin.garage.name, email: admin.user.email ?? admin.garage.email },
    customerRef: subscription?.customer_ref ?? null,
    successUrl: adminUrl(`${PATH}?done=checkout`),
    cancelUrl: adminUrl(`${PATH}?done=checkout_cancelled`),
  });
  if (result.kind === "redirect") {
    await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "plan.checkout_started", entityType: "garage", entityId: admin.garage.id, detail: { provider: provider.kind } });
    redirect(result.url);
  }
  if (result.kind === "error") redirect(`${PATH}?error=billing_unavailable`);

  const { error } = await admin.client.rpc("request_plan_change", { p_plan: "pro", p_note: note(formData) || null });
  if (error) redirect(`${PATH}?error=${error.code === "42501" ? "owner_only" : "request_failed"}`);
  revalidatePath(PATH);
  redirect(`${PATH}?done=requested`);
}

/** The provider's billing page (card, invoices, cancel). Stripe only. */
export async function openBillingPortalAction() {
  const admin = await ownerContext();
  const subscription = await loadSubscription(admin.garage.id);
  const portal = await getBillingProvider().openPortal({ customerRef: subscription?.customer_ref ?? null, returnUrl: adminUrl(PATH) });
  if (!portal) redirect(`${PATH}?error=billing_unavailable`);
  redirect(portal.url);
}

/** Move to Essentials now (ends a trial early). A paid Stripe subscription changes in the billing portal. */
export async function chooseEssentialsAction(formData: FormData) {
  const admin = await ownerContext();
  if (formData.get("confirm") !== "yes") redirect(`${PATH}?confirm=essentials#current-plan`);
  const { error } = await admin.client.rpc("choose_essentials");
  if (error?.message?.startsWith("BILLING_PORTAL_REQUIRED")) redirect(`${PATH}?error=use_portal`);
  if (error) redirect(`${PATH}?error=${error.code === "42501" ? "owner_only" : "change_failed"}`);
  clearHostCache();
  revalidatePath("/app", "layout");
  redirect(`${PATH}?done=essentials`);
}
