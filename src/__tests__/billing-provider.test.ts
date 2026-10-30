import { describe, expect, it, vi } from "vitest";
import { billingSelfServe, checkoutAddsVat, getBillingProvider, getBillingReadiness } from "@/lib/billing";
import { subscriptionKeepsAdminOpen } from "@/lib/billing/gate";
import { createStripeBillingProvider, signStripePayload, subscriptionState, verifyStripeSignature } from "@/lib/billing/stripe";
import { meterSmsChannel } from "@/lib/messaging/metering";
import type { MessageChannel } from "@/lib/messaging/channel";

const GARAGE = "0b9a7c4e-1d2f-4a3b-8c5d-6e7f8a9b0c1d";
const config = { secretKey: "sk_test_abc", webhookSecret: "whsec_test", proPriceId: "price_pro", essentialsPriceId: "price_ess", extraSitePriceId: "price_site", liveMode: false, collectVat: false };

function subscriptionEvent(type: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_123",
    type,
    livemode: false,
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: "active",
        current_period_end: 1795000000,
        cancel_at_period_end: false,
        metadata: { garage_id: GARAGE },
        items: { data: [{ price: { id: "price_pro" }, quantity: 1 }, { price: { id: "price_site" }, quantity: 2 }] },
        ...overrides,
      },
    },
  });
}

describe("billing provider selection (test mode unless STRIPE_LIVE_MODE, D26)", () => {
  it("uses the mock unless Stripe is fully configured with a test key", () => {
    expect(getBillingReadiness({})).toBe("mock");
    expect(getBillingProvider({}).kind).toBe("mock");
    expect(getBillingReadiness({ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_abc" })).toBe("configuration_required");
    expect(
      getBillingReadiness({ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO: "price_1" }),
    ).toBe("stripe_test");
  });

  it("refuses live keys and falls back to the mock", () => {
    const env = { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO: "price_1" };
    expect(getBillingReadiness(env)).toBe("live_key_refused");
    expect(getBillingProvider(env).kind).toBe("mock");
    expect(getBillingReadiness({ ...env, STRIPE_LIVE_MODE: "yes" })).toBe("live_key_refused");
  });

  it("accepts only live keys with STRIPE_LIVE_MODE=true", () => {
    const env = { BILLING_PROVIDER: "stripe", STRIPE_LIVE_MODE: "true", STRIPE_SECRET_KEY: "rk_live_abc", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO: "price_1" };
    expect(getBillingReadiness(env)).toBe("stripe_live");
    expect(getBillingProvider(env).kind).toBe("stripe");
    expect(getBillingReadiness({ ...env, STRIPE_SECRET_KEY: "sk_test_abc" })).toBe("test_key_refused");
    expect(getBillingProvider({ ...env, STRIPE_SECRET_KEY: "sk_test_abc" }).kind).toBe("mock");
    expect(billingSelfServe("stripe_live") && billingSelfServe("stripe_test")).toBe(true);
    expect(billingSelfServe("mock") || billingSelfServe("live_key_refused") || billingSelfServe("test_key_refused")).toBe(false);
  });

  it("collects VAT only with BILLING_COLLECT_VAT=true on a working Stripe setup", () => {
    const env = { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO: "price_pro" };
    expect(checkoutAddsVat(env)).toBe(false);
    expect(checkoutAddsVat({ ...env, BILLING_COLLECT_VAT: "false" })).toBe(false);
    expect(checkoutAddsVat({ ...env, BILLING_COLLECT_VAT: "TRUE" })).toBe(true);
    expect(checkoutAddsVat({ BILLING_COLLECT_VAT: "true" })).toBe(false);
  });

  it("keeps the admin open only while a subscription is trialing, active or past due", () => {
    for (const status of ["trialing", "active", "past_due"]) expect(subscriptionKeepsAdminOpen(status)).toBe(true);
    for (const status of ["incomplete", "cancelled", "unpaid", "none", null, undefined]) expect(subscriptionKeepsAdminOpen(status)).toBe(false);
  });

  it("turns an upgrade into a request to Vitalos on the mock", async () => {
    const provider = getBillingProvider({});
    await expect(provider.startUpgrade({ garage: { id: GARAGE, name: "G", email: null }, customerRef: null, successUrl: "https://x", cancelUrl: "https://x" })).resolves.toEqual({ kind: "request" });
    await expect(provider.openPortal({ customerRef: "cus_1", returnUrl: "https://x" })).resolves.toBeNull();
    expect(provider.parseWebhook("{}", "t=1,v1=x")).toBeNull();
  });
});

describe("Stripe webhooks", () => {
  const now = new Date(1_800_000_000_000);
  const t = Math.floor(now.getTime() / 1000);

  it("accepts a correct signature within five minutes and nothing else", () => {
    const body = subscriptionEvent("customer.subscription.updated");
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_test", t), "whsec_test", now)).toBe(true);
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_other", t), "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(`${body} `, signStripePayload(body, "whsec_test", t), "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_test", t - 301), "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body, null, "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body, "garbage", "whsec_test", now)).toBe(false);
  });

  it("maps a subscription to the garage from its metadata", () => {
    const provider = createStripeBillingProvider(config);
    const body = subscriptionEvent("customer.subscription.updated");
    expect(provider.parseWebhook(body, signStripePayload(body, "whsec_test", t), now)).toEqual({
      kind: "subscription",
      eventId: "evt_123",
      type: "customer.subscription.updated",
      state: {
        garageId: GARAGE,
        customerRef: "cus_123",
        subscriptionRef: "sub_123",
        status: "active",
        plan: "pro",
        currentPeriodEnd: new Date(1795000000 * 1000).toISOString(),
        extraSites: 2,
        cancelAtPeriodEnd: false,
      },
    });
  });

  it("marks a deleted subscription cancelled and ignores other-mode and garage-less events", () => {
    const provider = createStripeBillingProvider(config);
    const deleted = subscriptionEvent("customer.subscription.deleted", { status: "canceled" });
    expect(provider.parseWebhook(deleted, signStripePayload(deleted, "whsec_test", t), now)).toMatchObject({ kind: "subscription", state: { status: "cancelled" } });
    const live = JSON.stringify({ ...JSON.parse(subscriptionEvent("customer.subscription.updated")), livemode: true });
    expect(provider.parseWebhook(live, signStripePayload(live, "whsec_test", t), now)).toEqual({ kind: "ignored", eventId: "evt_123", type: "customer.subscription.updated" });
    const noGarage = subscriptionEvent("customer.subscription.updated", { metadata: {} });
    expect(provider.parseWebhook(noGarage, signStripePayload(noGarage, "whsec_test", t), now)).toMatchObject({ kind: "ignored" });
    expect(subscriptionState({ id: "sub", metadata: { garage_id: "not-a-uuid" } }, config)).toBeNull();
    // In live mode, a live event applies and a test event is ignored.
    const liveProvider = createStripeBillingProvider({ ...config, liveMode: true });
    expect(liveProvider.parseWebhook(live, signStripePayload(live, "whsec_test", t), now)).toMatchObject({ kind: "subscription" });
    const test = subscriptionEvent("customer.subscription.updated");
    expect(liveProvider.parseWebhook(test, signStripePayload(test, "whsec_test", t), now)).toMatchObject({ kind: "ignored" });
  });

  it("maps an Essentials subscription in its free month", () => {
    const body = subscriptionEvent("customer.subscription.created", { status: "trialing", items: { data: [{ price: { id: "price_ess" }, quantity: 1 }] } });
    expect(createStripeBillingProvider(config).parseWebhook(body, signStripePayload(body, "whsec_test", t), now)).toMatchObject({
      kind: "subscription",
      state: { status: "trialing", plan: "essentials", extraSites: 0 },
    });
  });

  it("starts Checkout for the Pro price with the garage id, never a registration", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 }));
    const provider = createStripeBillingProvider(config, fetcher as unknown as typeof fetch);
    const result = await provider.startUpgrade({ garage: { id: GARAGE, name: "Hartley Road", email: "owner@example.test" }, customerRef: null, successUrl: "https://a/ok", cancelUrl: "https://a/no" });
    expect(result).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("line_items[0][price]")).toBe("price_pro");
    expect(body.get("client_reference_id")).toBe(GARAGE);
    expect(body.get("subscription_data[metadata][garage_id]")).toBe(GARAGE);
    expect(body.get("payment_method_collection")).toBe("always");
    expect(body.get("subscription_data[description]")).toBe("Pitline Pro");
    expect(body.has("subscription_data[trial_end]")).toBe(false);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_abc");
  });

  it("card first (D26): the chosen plan, the free month as the Stripe trial, £0 today", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_2" }), { status: 200 }));
    const provider = createStripeBillingProvider(config, fetcher as unknown as typeof fetch);
    const now = new Date("2026-10-30T12:00:00Z");
    const trialEndsAt = "2026-11-30T12:00:00Z";
    await provider.startUpgrade({ garage: { id: GARAGE, name: "G", email: "o@example.test" }, customerRef: null, successUrl: "https://a", cancelUrl: "https://a", plan: "essentials", trialEndsAt, now });
    const body = new URLSearchParams(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.get("line_items[0][price]")).toBe("price_ess");
    expect(body.get("payment_method_collection")).toBe("always");
    expect(body.get("subscription_data[trial_end]")).toBe(String(Date.parse(trialEndsAt) / 1000));
    expect(body.get("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBe("cancel");
    expect(body.get("subscription_data[description]")).toBe("Pitline Essentials");
    expect(body.has("automatic_tax[enabled]")).toBe(false);

    // Under 48 hours left: no trial (Stripe's minimum), so billing starts at Checkout.
    await provider.startUpgrade({ garage: { id: GARAGE, name: "G", email: null }, customerRef: "cus_1", successUrl: "https://a", cancelUrl: "https://a", plan: "pro", trialEndsAt: "2026-10-31T12:00:00Z", now });
    expect(new URLSearchParams(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body)).has("subscription_data[trial_end]")).toBe(false);

    // No Essentials price yet: refused before calling Stripe.
    const noEssentials = createStripeBillingProvider({ ...config, essentialsPriceId: null }, fetcher as unknown as typeof fetch);
    await expect(noEssentials.startUpgrade({ garage: { id: GARAGE, name: "G", email: null }, customerRef: null, successUrl: "https://a", cancelUrl: "https://a", plan: "essentials" })).resolves.toEqual({ kind: "error", code: "configuration_required" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses Stripe Tax at Checkout only when VAT is collected (D26)", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 }));
    const withVat = createStripeBillingProvider({ ...config, collectVat: true }, fetcher as unknown as typeof fetch);
    await withVat.startUpgrade({ garage: { id: GARAGE, name: "G", email: null }, customerRef: "cus_1", successUrl: "https://a", cancelUrl: "https://a" });
    const body = new URLSearchParams(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.get("automatic_tax[enabled]")).toBe("true");
    expect(body.get("tax_id_collection[enabled]")).toBe("true");
    expect(body.get("customer_update[address]")).toBe("auto");
    // A new customer has no record to update: Checkout collects the address itself.
    await withVat.startUpgrade({ garage: { id: GARAGE, name: "G", email: null }, customerRef: null, successUrl: "https://a", cancelUrl: "https://a" });
    expect(new URLSearchParams(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body)).has("customer_update[address]")).toBe(false);
  });

  it("switches the plan on an existing subscription and schedules or undoes a cancellation", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ items: { data: [{ id: "si_plan", price: { id: "price_ess" } }, { id: "si_site", price: { id: "price_site" } }] } }), { status: 200 });
      return new Response(JSON.stringify({ id: "sub_1", url }), { status: 200 });
    });
    const provider = createStripeBillingProvider(config, fetcher as unknown as typeof fetch);
    await expect(provider.changePlan({ subscriptionRef: "sub_1", plan: "pro" })).resolves.toEqual({ ok: true });
    const [changeUrl, changeInit] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(changeUrl).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
    const change = new URLSearchParams(String(changeInit.body));
    expect(change.get("items[0][id]")).toBe("si_plan");
    expect(change.get("items[0][price]")).toBe("price_pro");
    expect(change.get("proration_behavior")).toBe("create_prorations");
    // Already on that plan: nothing to post.
    await expect(provider.changePlan({ subscriptionRef: "sub_1", plan: "essentials" })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(3);

    await expect(provider.setCancelAtPeriodEnd({ subscriptionRef: "sub_1", cancel: true })).resolves.toEqual({ ok: true });
    expect(new URLSearchParams(String((fetcher.mock.calls[3] as unknown as [string, RequestInit])[1].body)).get("cancel_at_period_end")).toBe("true");
    await provider.setCancelAtPeriodEnd({ subscriptionRef: "sub_1", cancel: false });
    expect(new URLSearchParams(String((fetcher.mock.calls[4] as unknown as [string, RequestInit])[1].body)).get("cancel_at_period_end")).toBe("false");
  });

  it("reports a provider error instead of throwing", async () => {
    const provider = createStripeBillingProvider(config, (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
    await expect(provider.startUpgrade({ garage: { id: GARAGE, name: "G", email: null }, customerRef: null, successUrl: "https://a", cancelUrl: "https://a" })).resolves.toEqual({ kind: "error", code: "provider_error" });
  });
});

describe("SMS metering", () => {
  const base: MessageChannel = { kind: "sms", mode: "mock", send: vi.fn(async () => ({ ok: true as const, providerMessageId: "SM1", status: "queued" as const })) };
  const message = { garageId: GARAGE, to: "+447700900123", body: "x".repeat(161), idempotencyKey: "reminder_send:1" };

  it("counts the segments of a sent text once the send has succeeded", async () => {
    const meter = vi.fn(async () => true);
    const result = await meterSmsChannel(base, {}, meter, true).send(message);
    expect(result.ok).toBe(true);
    expect(meter).toHaveBeenCalledWith(message, 2);
  });

  it("never blocks or changes a send, even when metering fails", async () => {
    const meter = vi.fn(async () => { throw new Error("db down"); });
    await expect(meterSmsChannel(base, {}, meter, true).send(message)).resolves.toMatchObject({ ok: true });
    const failing: MessageChannel = { ...base, send: async () => ({ ok: false, code: "provider_error", retryable: true }) };
    const quiet = vi.fn();
    await meterSmsChannel(failing, {}, quiet, true).send(message);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("leaves WhatsApp and email alone and can be switched off", () => {
    const whatsapp: MessageChannel = { ...base, kind: "whatsapp" };
    expect(meterSmsChannel(whatsapp, {}, vi.fn(), true)).toBe(whatsapp);
    expect(meterSmsChannel(base, { USAGE_METERING: "off" })).toBe(base);
  });
});
