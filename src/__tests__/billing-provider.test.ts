import { describe, expect, it, vi } from "vitest";
import { checkoutAddsVat, getBillingProvider, getBillingReadiness } from "@/lib/billing";
import { createStripeBillingProvider, signStripePayload, subscriptionState, verifyStripeSignature } from "@/lib/billing/stripe";
import { meterSmsChannel } from "@/lib/messaging/metering";
import type { MessageChannel } from "@/lib/messaging/channel";

const GARAGE = "0b9a7c4e-1d2f-4a3b-8c5d-6e7f8a9b0c1d";
const config = { secretKey: "sk_test_abc", webhookSecret: "whsec_test", proPriceId: "price_pro", extraSitePriceId: "price_site", vatTaxRateId: null };

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

describe("billing provider selection (test mode only)", () => {
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

  it("marks a deleted subscription cancelled and ignores live-mode and garage-less events", () => {
    const provider = createStripeBillingProvider(config);
    const deleted = subscriptionEvent("customer.subscription.deleted", { status: "canceled" });
    expect(provider.parseWebhook(deleted, signStripePayload(deleted, "whsec_test", t), now)).toMatchObject({ kind: "subscription", state: { status: "cancelled" } });
    const live = JSON.stringify({ ...JSON.parse(subscriptionEvent("customer.subscription.updated")), livemode: true });
    expect(provider.parseWebhook(live, signStripePayload(live, "whsec_test", t), now)).toEqual({ kind: "ignored", eventId: "evt_123", type: "customer.subscription.updated" });
    const noGarage = subscriptionEvent("customer.subscription.updated", { metadata: {} });
    expect(provider.parseWebhook(noGarage, signStripePayload(noGarage, "whsec_test", t), now)).toMatchObject({ kind: "ignored" });
    expect(subscriptionState({ id: "sub", metadata: { garage_id: "not-a-uuid" } }, config)).toBeNull();
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
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_abc");
  });

  it("adds VAT only where the garage pays, and only when a tax rate is set (D25)", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 }));
    const plain = createStripeBillingProvider(config, fetcher as unknown as typeof fetch);
    await plain.startUpgrade({ garage: { id: GARAGE, name: "G", email: null }, customerRef: null, successUrl: "https://a", cancelUrl: "https://a" });
    expect(new URLSearchParams(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).has("line_items[0][tax_rates][0]")).toBe(false);

    const withVat = createStripeBillingProvider({ ...config, vatTaxRateId: "txr_vat20" }, fetcher as unknown as typeof fetch);
    await withVat.startUpgrade({ garage: { id: GARAGE, name: "G", email: null }, customerRef: null, successUrl: "https://a", cancelUrl: "https://a" });
    expect(new URLSearchParams(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body)).get("line_items[0][tax_rates][0]")).toBe("txr_vat20");
    await withVat.setExtraSites({ garageId: GARAGE, subscriptionRef: "sub_1", count: 2 });
    expect(new URLSearchParams(String((fetcher.mock.calls[2] as unknown as [string, RequestInit])[1].body)).get("tax_rates[0]")).toBe("txr_vat20");
  });

  it("reads STRIPE_VAT_TAX_RATE, ignoring anything that is not a tax rate id", () => {
    const env = { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO: "price_pro" };
    expect(checkoutAddsVat(env)).toBe(false);
    expect(checkoutAddsVat({ ...env, STRIPE_VAT_TAX_RATE: "20%" })).toBe(false);
    expect(checkoutAddsVat({ ...env, STRIPE_VAT_TAX_RATE: " txr_vat20 " })).toBe(true);
    expect(checkoutAddsVat({ STRIPE_VAT_TAX_RATE: "txr_vat20" })).toBe(false);
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
