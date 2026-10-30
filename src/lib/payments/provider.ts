// Payments provider interface (P5.4): how a garage takes money from its own customers on its own
// payment account (deposits at booking, pay-by-link invoices, no-show fees). Two implementations:
// Stripe Connect in TEST MODE ONLY (./stripe.ts: connected accounts onboarded with Account Links,
// Checkout Sessions created on the connected account, signed Connect webhooks) and a mock (./mock.ts,
// the default) that "connects" at once and is paid on the garage host's /pay page.
//
// The interface is deliberately general so other Pro features can reuse it (customer service plans
// by Direct Debit, P5.5): an account belongs to a garage, a checkout is "collect this amount for this
// reference on that account", and events come back verified and mapped to our ids. A recurring
// product adds its own methods (e.g. `startMandate`) next to these rather than changing them.
//
// Live keys are refused (./index.ts): agents work in test mode; live payments need Temitope.

export type PaymentsProviderKind = "mock" | "stripe";

export type PaymentAccountStatus = "pending" | "active" | "restricted" | "disconnected";

/** The provider's view of a connected account. */
export type AccountState = {
  accountRef: string;
  status: Exclude<PaymentAccountStatus, "disconnected">;
  chargesEnabled: boolean;
};

export type ConnectGarage = { id: string; name: string; email: string | null };

export type ConnectResult =
  /** Send the owner to the provider's onboarding; `accountRef` is stored as pending first. */
  | { kind: "redirect"; url: string; accountRef: string }
  /** Connected without leaving Pitline (the mock). */
  | { kind: "connected"; account: AccountState }
  | { kind: "error"; code: "provider_error" };

/** What to collect: one amount, in pence, for one of our payments. */
export type CheckoutRequest = {
  accountRef: string;
  paymentId: string;
  garageId: string;
  amountPence: number;
  /** Shown on the provider's page and the customer's statement description: never a registration. */
  description: string;
  successUrl: string;
  cancelUrl: string;
  /** When the checkout must stop accepting payment (Stripe needs 30 minutes to 24 hours ahead). */
  expiresAt: Date;
};

export type CheckoutResult =
  /** Send the customer to the provider's hosted page. */
  | { kind: "redirect"; url: string; checkoutRef: string }
  /** The mock: the garage host's /pay page takes the (test) payment itself. */
  | { kind: "local" }
  | { kind: "error"; code: "provider_error" };

/** A checkout's state, for the customer's return before the webhook lands. */
export type CheckoutState = { paid: boolean; amountPence: number | null; providerPaymentRef: string | null };

// ---------------------------------------------------------------------------------------------
// Direct Debit for customer service plans (P5.11). A mandate is set up once on the garage's account
// and the provider then collects the plan's monthly price itself (Stripe: a Checkout Session in
// subscription mode with Bacs Direct Debit). Our side only follows the subscription's status.
// GoCardless would be a third implementation of these three methods (A381); not built.

/** What our subscription row becomes when the provider reports on it. */
export type PlanSubscriptionStatus = "active" | "past_due" | "cancelled";

/** Set up a monthly Direct Debit of `amountPence` for one of our plan subscriptions. */
export type MandateRequest = {
  accountRef: string;
  subscriptionId: string;
  garageId: string;
  amountPence: number;
  /** "Gold plan, Hartley Road Garage": never a registration. */
  description: string;
  /** Prefills the provider's form; the provider collects the bank details, never us. */
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
};

export type MandateResult =
  /** Send the customer to the provider's hosted Direct Debit form. */
  | { kind: "redirect"; url: string; checkoutRef: string }
  /** The mock: the garage host's confirm page sets up a test mandate itself. */
  | { kind: "local" }
  | { kind: "error"; code: "provider_error" };

/** A mandate checkout read back (the customer returned before the webhook). */
export type MandateState = {
  status: PlanSubscriptionStatus | null;
  subscriptionRef: string | null;
  mandateRef: string | null;
  renewsAt: string | null;
};

export type PaymentsEvent =
  | {
    kind: "paid";
    eventId: string;
    type: string;
    accountRef: string;
    garageId: string;
    paymentId: string;
    amountPence: number | null;
    providerPaymentRef: string | null;
  }
  | { kind: "account"; eventId: string; type: string; garageId: string; account: AccountState }
  | {
    /** P5.11: news about a plan's Direct Debit subscription. `status` null = refs only. */
    kind: "plan_subscription";
    eventId: string;
    type: string;
    accountRef: string;
    garageId: string;
    subscriptionId: string;
    status: PlanSubscriptionStatus | null;
    subscriptionRef: string | null;
    mandateRef: string | null;
    renewsAt: string | null;
  }
  | { kind: "ignored"; eventId: string; type: string };

export interface PaymentsProvider {
  readonly kind: PaymentsProviderKind;
  /** Onboards (or resumes onboarding of) the garage's account. `accountRef` reuses an existing one. */
  startConnect(input: { garage: ConnectGarage; accountRef: string | null; returnUrl: string; refreshUrl: string }): Promise<ConnectResult>;
  /** The account's current state, or null when the provider cannot say. */
  getAccount(accountRef: string): Promise<AccountState | null>;
  /** A checkout for one payment on the garage's account. */
  createCheckout(input: CheckoutRequest): Promise<CheckoutResult>;
  /** Reads a checkout back (the customer returned before the webhook). */
  getCheckout(input: { accountRef: string; checkoutRef: string }): Promise<CheckoutState | null>;
  /** Stops a checkout taking payment (the deposit's hold ran out). True when closed or already closed. */
  cancelCheckout(input: { accountRef: string; checkoutRef: string }): Promise<boolean>;
  /** P5.11: starts a monthly Direct Debit mandate for a service plan subscription. */
  startMandate(input: MandateRequest): Promise<MandateResult>;
  /** P5.11: reads a mandate checkout back; null when the provider cannot say. */
  getMandate(input: { accountRef: string; checkoutRef: string }): Promise<MandateState | null>;
  /** P5.11: stops the provider collecting (staff cancelled the plan). True when stopped or already stopped. */
  cancelMandate(input: { accountRef: string; subscriptionRef: string }): Promise<boolean>;
  /** Verifies a webhook's signature on the raw body and maps it; null when the signature is wrong. */
  parseWebhook(rawBody: string, signatureHeader: string | null, now?: Date): PaymentsEvent | null;
}
