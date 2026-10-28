// Billing provider interface (P5.2): how a garage pays Vitalos for Pro and extra sites. Two
// implementations: Stripe Billing in TEST MODE only (./stripe.ts) and a mock (./mock.ts) used until
// Temitope supplies Stripe test keys. With the mock, "Upgrade" becomes "Request Pro": the request is
// recorded (plan_requests) and Vitalos sees it in /admin; a platform admin then sets the plan.
//
// Live Stripe keys are refused (DECISIONS: agents use test mode; live needs Temitope's approval).

export type BillingProviderKind = "mock" | "stripe";

export type BillingGarage = { id: string; name: string; email: string | null };

export type SubscriptionStatus = "none" | "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "cancelled";

/** The provider's view of a garage's subscription, applied by apply_billing_subscription(). */
export type SubscriptionState = {
  garageId: string;
  customerRef: string | null;
  subscriptionRef: string | null;
  status: SubscriptionStatus;
  plan: "essentials" | "pro";
  currentPeriodEnd: string | null;
  extraSites: number;
  cancelAtPeriodEnd: boolean;
};

export type BillingEvent =
  | { kind: "subscription"; eventId: string; type: string; state: SubscriptionState }
  | { kind: "ignored"; eventId: string; type: string };

export type UpgradeResult =
  /** Send the owner to the provider's checkout page. */
  | { kind: "redirect"; url: string }
  /** No self-serve checkout: record a plan request for Vitalos. */
  | { kind: "request" }
  | { kind: "error"; code: "configuration_required" | "provider_error" };

export interface BillingProvider {
  readonly kind: BillingProviderKind;
  /** Pro checkout for the garage. `customerRef` reuses an existing provider customer. */
  startUpgrade(input: { garage: BillingGarage; customerRef: string | null; successUrl: string; cancelUrl: string }): Promise<UpgradeResult>;
  /** The provider's self-serve page (change card, cancel, invoices), or null when there is none. */
  openPortal(input: { customerRef: string | null; returnUrl: string }): Promise<{ url: string } | null>;
  /** Sets how many sites beyond the first the garage pays for (multi-site, P5.9). */
  setExtraSites(input: { garageId: string; subscriptionRef: string | null; count: number }): Promise<{ ok: boolean; code?: string }>;
  /** Verifies a webhook's signature on the raw body and maps it; null when the signature is wrong. */
  parseWebhook(rawBody: string, signatureHeader: string | null, now?: Date): BillingEvent | null;
}
