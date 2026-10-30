// Billing provider interface (P5.2): how a garage pays Vitalos for its plan and extra sites. Two
// implementations: Stripe Billing (./stripe.ts; test mode unless STRIPE_LIVE_MODE=true, D26) and a
// mock (./mock.ts) used while Stripe is not configured. With the mock, "Upgrade" becomes "Request Pro": the request is
// recorded (plan_requests) and Vitalos sees it in /admin; a platform admin then sets the plan.
//
// A live Stripe key is refused unless STRIPE_LIVE_MODE=true, and a test key is refused when it is (D26).

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
  /**
   * Checkout for a plan (default Pro), card always collected. `trialEndsAt` (the garage's free month,
   * D26) becomes the provider's trial, so nothing is charged until then. `customerRef` reuses a customer.
   */
  startUpgrade(input: {
    garage: BillingGarage;
    customerRef: string | null;
    successUrl: string;
    cancelUrl: string;
    plan?: "essentials" | "pro";
    trialEndsAt?: string | null;
    now?: Date;
  }): Promise<UpgradeResult>;
  /** Moves an existing subscription to another plan (prorated). */
  changePlan(input: { subscriptionRef: string; plan: "essentials" | "pro" }): Promise<{ ok: boolean; code?: string }>;
  /** Cancels at the end of the current period (or the free month), or undoes that. */
  setCancelAtPeriodEnd(input: { subscriptionRef: string; cancel: boolean }): Promise<{ ok: boolean; code?: string }>;
  /** The provider's self-serve page (change card, cancel, invoices), or null when there is none. */
  openPortal(input: { customerRef: string | null; returnUrl: string }): Promise<{ url: string } | null>;
  /** Sets how many sites beyond the first the garage pays for (multi-site, P5.9). */
  setExtraSites(input: { garageId: string; subscriptionRef: string | null; count: number }): Promise<{ ok: boolean; code?: string }>;
  /** Verifies a webhook's signature on the raw body and maps it; null when the signature is wrong. */
  parseWebhook(rawBody: string, signatureHeader: string | null, now?: Date): BillingEvent | null;
}
