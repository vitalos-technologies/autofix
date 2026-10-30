import "server-only";

import { createAdminClient } from "@/lib/supabase/server";
import { billingSelfServe, getBillingReadiness } from "./index";

// Card first (D26): a garage that signed up under D26 (garages.card_required) uses the admin only
// while its subscription, or its group home garage's, is trialing, active or past_due. Until then it
// stays on /app/billing-setup. Nothing is gated while billing is the mock (Stripe not configured).

export const BILLING_SETUP_PATH = "/app/billing-setup";

/** Subscription states that keep the admin open: in the free month, paid up, or a payment being retried. */
export const OPEN_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

export type BillingGate =
  | { required: false }
  /** No card yet (Checkout never finished), or the subscription ended (cancelled, unpaid). */
  | { required: true; reason: "no_card" | "ended"; billingGarageId: string };

export function subscriptionKeepsAdminOpen(status: string | null | undefined): boolean {
  return (OPEN_SUBSCRIPTION_STATUSES as readonly string[]).includes(status ?? "");
}

/** Whether the garage must finish billing before using the admin. The garage comes from the admin session. */
export async function billingGate(garageId: string): Promise<BillingGate> {
  if (!billingSelfServe(getBillingReadiness())) return { required: false };
  const client = createAdminClient();
  if (!client) return { required: false };
  const { data: garage } = await client.from("garages").select("card_required").eq("id", garageId).maybeSingle();
  if (!garage?.card_required) return { required: false };
  // A group site is billed through its home garage (P5.9).
  const { data: site } = await client.from("garage_group_sites").select("home_garage_id").eq("garage_id", garageId).maybeSingle();
  const billingGarageId = (site?.home_garage_id as string | undefined) ?? garageId;
  const { data: subscription } = await client.from("garage_subscriptions").select("status").eq("garage_id", billingGarageId).maybeSingle();
  if (subscriptionKeepsAdminOpen(subscription?.status as string | undefined)) return { required: false };
  const ended = subscription?.status === "cancelled" || subscription?.status === "unpaid";
  return { required: true, reason: ended ? "ended" : "no_card", billingGarageId };
}
