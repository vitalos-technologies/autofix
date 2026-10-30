"use server";

import { redirect } from "next/navigation";
import { recordAdminAudit } from "@/lib/admin/audit";
import { getBillingProvider } from "@/lib/billing";
import { BILLING_SETUP_PATH, billingGate } from "@/lib/billing/gate";
import { loadSubscription } from "@/lib/billing/server";
import { parseSignupPlan } from "@/lib/signup/schema";
import { createAdminClient } from "@/lib/supabase/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { adminUrl } from "@/lib/tenancy/urls";

// Finish setting up billing (D26): the owner, MFA verified, sends the garage through Stripe Checkout
// for the plan they pick here. The garage is the member's selected garage; the form carries only the plan.

export async function startBillingSetupAction(formData: FormData) {
  const admin = await getAdminContext({ requireMfa: false });
  if (!admin) redirect("/app/login");
  if (admin.mfaState === "challenge_required") redirect(`/app/mfa?returnTo=${encodeURIComponent(BILLING_SETUP_PATH)}`);
  if (admin.role !== "owner" || !admin.mfaVerified) redirect(`${BILLING_SETUP_PATH}?error=owner_only`);
  const gate = await billingGate(admin.garage.id);
  if (!gate.required) redirect("/app");

  const plan = parseSignupPlan(formData.get("plan"));
  if (plan !== admin.garage.plan) {
    const service = createAdminClient();
    const { error } = service ? await service.from("garages").update({ plan }).eq("id", admin.garage.id) : { error: true };
    if (error) redirect(`${BILLING_SETUP_PATH}?error=billing_unavailable`);
  }

  const subscription = await loadSubscription(gate.billingGarageId);
  const result = await getBillingProvider().startUpgrade({
    garage: { id: gate.billingGarageId, name: admin.garage.name, email: admin.user.email ?? admin.garage.email },
    customerRef: subscription?.customer_ref ?? null,
    successUrl: adminUrl(`${BILLING_SETUP_PATH}?done=checkout`),
    cancelUrl: adminUrl(`${BILLING_SETUP_PATH}?done=checkout_cancelled`),
    plan,
    // The rest of the free month carries into Stripe; once a subscription has ended there is none left.
    trialEndsAt: gate.reason === "no_card" ? admin.garage.trialEndsAt : null,
  });
  if (result.kind !== "redirect") redirect(`${BILLING_SETUP_PATH}?error=billing_unavailable`);
  await recordAdminAudit(admin.garage.id, { actorId: admin.user.id, action: "billing.checkout_started", entityType: "garage", entityId: admin.garage.id, detail: { plan } });
  redirect(result.url);
}
