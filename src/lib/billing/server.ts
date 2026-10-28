import "server-only";

import { createAdminClient } from "@/lib/supabase/server";
import { clearHostCache } from "@/lib/tenancy/resolve";
import type { BillingEvent } from "./provider";

// Applies billing webhooks (P5.2) with the service role: claim the event once
// (billing_webhook_events), apply the subscription to the garage, finish the event. Logs carry ids,
// types and outcomes only.

export type ApplyOutcome = "applied" | "duplicate" | "ignored" | "unavailable" | "failed";

export async function applyBillingEvent(event: BillingEvent, provider: "stripe" | "mock"): Promise<ApplyOutcome> {
  const client = createAdminClient();
  if (!client) return "unavailable";
  const claimed = await client.rpc("claim_billing_webhook_event", { p_event_id: event.eventId, p_provider: provider, p_type: event.type });
  if (claimed.error) return "failed";
  if (claimed.data !== true) return "duplicate";

  if (event.kind === "ignored") {
    await client.rpc("finish_billing_webhook_event", { p_event_id: event.eventId, p_garage_id: null, p_outcome: "ignored" });
    return "ignored";
  }

  const { state } = event;
  const applied = await client.rpc("apply_billing_subscription", {
    p_garage_id: state.garageId,
    p_provider: provider,
    p_customer_ref: state.customerRef,
    p_subscription_ref: state.subscriptionRef,
    p_status: state.status,
    p_plan: state.plan,
    p_current_period_end: state.currentPeriodEnd,
    p_extra_sites: state.extraSites,
    p_cancel_at_period_end: state.cancelAtPeriodEnd,
  });
  const outcome: ApplyOutcome = applied.error ? (applied.error.message?.startsWith("GARAGE_NOT_FOUND") ? "ignored" : "failed") : "applied";
  if (outcome !== "failed") {
    await client.rpc("finish_billing_webhook_event", { p_event_id: event.eventId, p_garage_id: outcome === "applied" ? state.garageId : null, p_outcome: outcome });
  }
  if (outcome === "applied") clearHostCache();
  console.info(JSON.stringify({ scope: "billing", event: "webhook", provider, type: event.type, outcome }));
  return outcome;
}

/** The garage's provider refs (service role; the garage comes from the admin session). */
export async function loadSubscription(garageId: string) {
  const client = createAdminClient();
  if (!client) return null;
  const { data } = await client
    .from("garage_subscriptions")
    .select("provider,customer_ref,subscription_ref,status,plan,extra_sites,current_period_end,cancel_at_period_end")
    .eq("garage_id", garageId)
    .maybeSingle();
  return (data ?? null) as {
    provider: string;
    customer_ref: string | null;
    subscription_ref: string | null;
    status: string;
    plan: string | null;
    extra_sites: number;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
}
