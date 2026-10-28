import { describe, expect, it, vi } from "vitest";
import { signStripePayload } from "@/lib/billing/stripe";
import { CRON_JOBS, cronDedupeKey } from "@/lib/jobs/cron";
import { JOB_KINDS } from "@/lib/jobs/types";
import { getPaymentsProvider, readPaymentsConfig } from "@/lib/payments";
import {
  depositAmountPence,
  depositRuleLabel,
  formatPounds,
  parseDepositRule,
  parsePoundsToPence,
  paymentTotals,
  type DepositService,
  type DepositSettings,
} from "@/lib/payments/amounts";
import { chooseLinkChannel, composeLinkMessage } from "@/lib/payments/messages";
import { createMockPaymentsProvider } from "@/lib/payments/mock";
import { accountState, checkoutExpiry, createStripePaymentsProvider, mapStripePaymentsEvent } from "@/lib/payments/stripe";
import { createPayToken, hashPayToken, isPayTokenShape } from "@/lib/payments/tokens";

// P5.4 payments: provider selection (test mode only), money and deposit rules (mirroring
// payment_deposit_amount(), pgTAP 030), pay tokens, link messages (STOP honoured) and the Stripe
// Connect adapter against a fake fetch.

const GARAGE = "11111111-1111-4111-8111-111111111111";
const PAYMENT = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "acct_1TestGarage01";
const WHSEC = "whsec_testsecret";

describe("provider selection", () => {
  it("defaults to the mock outside production", () => {
    expect(readPaymentsConfig({}).readiness).toBe("mock");
    expect(getPaymentsProvider({})?.kind).toBe("mock");
  });

  it("never runs the mock on Vercel production", () => {
    expect(readPaymentsConfig({ VERCEL_ENV: "production" }).readiness).toBe("mock_not_in_production");
    expect(getPaymentsProvider({ VERCEL_ENV: "production" })).toBeNull();
  });

  it("refuses live Stripe keys and falls back to nothing", () => {
    const env = { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_PAYMENTS_WEBHOOK_SECRET: WHSEC };
    expect(readPaymentsConfig(env).readiness).toBe("live_key_refused");
    expect(getPaymentsProvider(env)).toBeNull();
    expect(readPaymentsConfig({ ...env, STRIPE_SECRET_KEY: "rk_live_abc" }).readiness).toBe("live_key_refused");
  });

  it("needs a test key and the payments webhook secret for Stripe", () => {
    expect(readPaymentsConfig({ PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_abc" }).readiness).toBe("configuration_required");
    expect(readPaymentsConfig({ PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "nonsense", STRIPE_PAYMENTS_WEBHOOK_SECRET: WHSEC }).readiness).toBe("configuration_required");
    const env = { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_PAYMENTS_WEBHOOK_SECRET: WHSEC, VERCEL_ENV: "production" };
    expect(readPaymentsConfig(env).readiness).toBe("stripe_test");
    expect(getPaymentsProvider(env)?.kind).toBe("stripe");
  });
});

describe("money", () => {
  it("formats pence as pounds", () => {
    expect(formatPounds(2000)).toBe("£20.00");
    expect(formatPounds(123456)).toBe("£1,234.56");
    expect(formatPounds(null)).toBe("–");
  });

  it("parses what staff type", () => {
    expect(parsePoundsToPence("20")).toBe(2000);
    expect(parsePoundsToPence("£25.5")).toBe(2550);
    expect(parsePoundsToPence(" 1,250.00 ")).toBe(125000);
    expect(parsePoundsToPence("-5")).toBeNull();
    expect(parsePoundsToPence("2.555")).toBeNull();
    expect(parsePoundsToPence("")).toBeNull();
    expect(parsePoundsToPence("abc")).toBeNull();
  });
});

describe("deposits (mirror of payment_deposit_amount)", () => {
  const settings: DepositSettings = { depositsEnabled: true, defaultMode: "fixed", defaultValue: 2000 };
  const service = (overrides: Partial<DepositService> = {}): DepositService => ({ depositMode: "default", depositValue: null, pricePence: 5000, priceMode: "fixed", ...overrides });

  it("follows the garage default", () => {
    expect(depositAmountPence(settings, service())).toBe(2000);
    expect(depositAmountPence({ ...settings, defaultMode: "percent", defaultValue: 20 }, service())).toBe(1000);
  });

  it("takes nothing while deposits are off or not set up", () => {
    expect(depositAmountPence({ ...settings, depositsEnabled: false }, service())).toBeNull();
    expect(depositAmountPence(null, service())).toBeNull();
    expect(depositAmountPence({ ...settings, defaultMode: "none", defaultValue: null }, service())).toBeNull();
  });

  it("lets a service override the default", () => {
    expect(depositAmountPence(settings, service({ depositMode: "none" }))).toBeNull();
    expect(depositAmountPence(settings, service({ depositMode: "fixed", depositValue: 3500 }))).toBe(3500);
    expect(depositAmountPence(settings, service({ depositMode: "percent", depositValue: 25, pricePence: 17900 }))).toBe(4475);
  });

  it("takes no percentage of a quote or a free service, nor under £1", () => {
    expect(depositAmountPence(settings, service({ depositMode: "percent", depositValue: 20, priceMode: "quote", pricePence: null }))).toBeNull();
    expect(depositAmountPence(settings, service({ depositMode: "percent", depositValue: 20, pricePence: 0 }))).toBeNull();
    expect(depositAmountPence(settings, service({ depositMode: "percent", depositValue: 1, pricePence: 9900 }))).toBeNull();
  });

  it("validates a rule from a form", () => {
    expect(parseDepositRule({ mode: "fixed", amount: "20" }, false)).toEqual({ ok: true, mode: "fixed", value: 2000 });
    expect(parseDepositRule({ mode: "percent", percent: "15" }, true)).toEqual({ ok: true, mode: "percent", value: 15 });
    expect(parseDepositRule({ mode: "default" }, true)).toEqual({ ok: true, mode: "default", value: null });
    expect(parseDepositRule({ mode: "default" }, false)).toMatchObject({ ok: false, field: "mode" });
    expect(parseDepositRule({ mode: "fixed", amount: "0.50" }, false)).toMatchObject({ ok: false, field: "amount" });
    expect(parseDepositRule({ mode: "fixed", amount: "1000.01" }, false)).toMatchObject({ ok: false, field: "amount" });
    expect(parseDepositRule({ mode: "percent", percent: "12.5" }, false)).toMatchObject({ ok: false, field: "percent" });
    expect(parseDepositRule({ mode: "half" }, true)).toMatchObject({ ok: false, field: "mode" });
  });

  it("describes rules in words", () => {
    expect(depositRuleLabel("default", null)).toBe("Garage default");
    expect(depositRuleLabel("fixed", 2000)).toBe("£20.00");
    expect(depositRuleLabel("percent", 20)).toBe("20% of the price");
    expect(depositRuleLabel("none", null)).toBe("No deposit");
  });
});

describe("totals", () => {
  it("counts this month's money, what is waiting and what needs a look", () => {
    const month = new Date("2026-10-01T00:00:00+01:00");
    const totals = paymentTotals([
      { status: "paid", kind: "deposit", amountPence: 2000, amountPaidPence: 2000, paidAt: "2026-10-02T09:00:00Z", attention: null },
      { status: "paid", kind: "invoice", amountPence: 6000, amountPaidPence: 6000, paidAt: "2026-10-20T09:00:00Z", attention: null },
      { status: "paid", kind: "deposit", amountPence: 2000, amountPaidPence: 2000, paidAt: "2026-09-29T09:00:00Z", attention: "paid_after_release" },
      { status: "pending", kind: "no_show_fee", amountPence: 2500, amountPaidPence: null, paidAt: null, attention: null },
      { status: "expired", kind: "deposit", amountPence: 2000, amountPaidPence: null, paidAt: null, attention: null },
    ], month);
    expect(totals).toEqual({ paidThisMonthPence: 8000, paidThisMonthCount: 2, waitingPence: 2500, waitingCount: 1, depositsHeldPence: 2000, attentionCount: 1 });
  });
});

describe("pay tokens", () => {
  it("are 256-bit, URL-safe, and only their hash is kept", () => {
    const { token, hash } = createPayToken();
    expect(isPayTokenShape(token)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPayToken(token)).toBe(hash);
    expect(createPayToken().token).not.toBe(token);
    expect(isPayTokenShape("short")).toBe(false);
    expect(isPayTokenShape(`${token}/../x`)).toBe(false);
  });
});

describe("link messages", () => {
  const customer = { name: "Sam", phone: "+447700900123", email: "sam@example.com", channel: "sms", optedOutAt: null };

  it("uses the customer's own channel", () => {
    expect(chooseLinkChannel(customer)).toEqual({ channel: "sms", to: "+447700900123" });
    expect(chooseLinkChannel({ ...customer, channel: "whatsapp" })).toEqual({ channel: "whatsapp", to: "+447700900123" });
    expect(chooseLinkChannel({ ...customer, channel: "email" })).toEqual({ channel: "email", to: "sam@example.com" });
  });

  it("never texts a customer who sent STOP: email instead, or nothing", () => {
    expect(chooseLinkChannel({ ...customer, optedOutAt: "2026-10-01T00:00:00Z" })).toEqual({ channel: "email", to: "sam@example.com" });
    expect(chooseLinkChannel({ ...customer, email: null, optedOutAt: "2026-10-01T00:00:00Z" })).toEqual({ channel: "none", reason: "opted_out" });
    expect(chooseLinkChannel({ ...customer, phone: null, email: null })).toEqual({ channel: "none", reason: "no_contact" });
    expect(chooseLinkChannel(null)).toEqual({ channel: "none", reason: "no_contact" });
  });

  it("writes a text with the amount, the link and the opt-out line", () => {
    const { body } = composeLinkMessage({ kind: "invoice", garageName: "Hartley Road Garage", amountPence: 6000, what: "invoice INV-2026-000012", link: "https://hartley.example/pay/abc" }, "sms");
    expect(body).toBe("Hartley Road Garage: invoice INV-2026-000012 for £60.00 is ready to pay. Pay securely: https://hartley.example/pay/abc\nReply STOP to opt out.");
    const fee = composeLinkMessage({ kind: "no_show_fee", garageName: "Hartley", amountPence: 2500, what: "booking HRD-1042", link: "https://x/pay/t" }, "whatsapp");
    expect(fee.body).toContain("missed appointment fee for booking HRD-1042 is £25.00");
    expect(fee.body).toMatch(/Reply STOP to opt out\.$/);
  });

  it("writes an email with an escaped link and no opt-out line", () => {
    const email = composeLinkMessage({ kind: "invoice", garageName: "A & B <Motors>", amountPence: 100, what: "invoice X", link: "https://x/pay/t" }, "email");
    expect(email.subject).toBe("Payment request from A & B <Motors>");
    expect(email.html).toContain("A &amp; B &lt;Motors&gt;");
    expect(email.html).toContain('href="https://x/pay/t"');
    expect(email.body).not.toContain("STOP");
  });
});

describe("mock provider", () => {
  it("connects at once with a stable mock account and takes payment locally", async () => {
    const provider = createMockPaymentsProvider();
    const first = await provider.startConnect({ garage: { id: GARAGE, name: "G", email: null }, accountRef: null, returnUrl: "", refreshUrl: "" });
    const again = await provider.startConnect({ garage: { id: GARAGE, name: "G", email: null }, accountRef: null, returnUrl: "", refreshUrl: "" });
    expect(first).toMatchObject({ kind: "connected", account: { status: "active", chargesEnabled: true } });
    expect(first).toEqual(again);
    expect(await provider.createCheckout({ accountRef: "mock_acct_x", paymentId: PAYMENT, garageId: GARAGE, amountPence: 100, description: "d", successUrl: "", cancelUrl: "", expiresAt: new Date() })).toEqual({ kind: "local" });
    expect(provider.parseWebhook("{}", "sig")).toBeNull();
  });
});

describe("Stripe Connect adapter (test mode)", () => {
  type Call = { url: string; init: RequestInit };
  function fakeFetch(responses: Array<{ ok?: boolean; json: unknown }>) {
    const calls: Call[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift() ?? { ok: false, json: {} };
      return new Response(JSON.stringify(next.json), { status: next.ok === false ? 400 : 200 });
    });
    return { calls, fetcher: fetcher as unknown as typeof fetch };
  }
  const config = { secretKey: "sk_test_abc", webhookSecret: WHSEC };

  it("creates an Express account once, then an onboarding link", async () => {
    const { calls, fetcher } = fakeFetch([{ json: { id: ACCOUNT } }, { json: { url: "https://connect.stripe.com/setup/e/abc" } }]);
    const result = await createStripePaymentsProvider(config, fetcher).startConnect({
      garage: { id: GARAGE, name: "Hartley Road Garage", email: "desk@hartley.example" },
      accountRef: null,
      returnUrl: "https://autofix.example/app/payments/settings/return",
      refreshUrl: "https://autofix.example/app/payments/settings/return?refresh=1",
    });
    expect(result).toEqual({ kind: "redirect", url: "https://connect.stripe.com/setup/e/abc", accountRef: ACCOUNT });
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/accounts");
    const account = new URLSearchParams(String(calls[0]!.init.body));
    expect(account.get("type")).toBe("express");
    expect(account.get("country")).toBe("GB");
    expect(account.get("metadata[garage_id]")).toBe(GARAGE);
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(`connect-account:${GARAGE}`);
    expect(new URLSearchParams(String(calls[1]!.init.body)).get("type")).toBe("account_onboarding");
  });

  it("reuses an existing account", async () => {
    const { calls, fetcher } = fakeFetch([{ json: { url: "https://connect.stripe.com/setup/e/def" } }]);
    await createStripePaymentsProvider(config, fetcher).startConnect({ garage: { id: GARAGE, name: "G", email: null }, accountRef: ACCOUNT, returnUrl: "r", refreshUrl: "f" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.stripe.com/v1/account_links"]);
  });

  it("creates the checkout on the garage's own account with ids only", async () => {
    const { calls, fetcher } = fakeFetch([{ json: { id: "cs_test_a1b2c3d4e5", url: "https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5" } }]);
    const result = await createStripePaymentsProvider(config, fetcher).createCheckout({
      accountRef: ACCOUNT,
      paymentId: PAYMENT,
      garageId: GARAGE,
      amountPence: 2000,
      description: "Deposit for MOT, HRD-1042",
      successUrl: "https://hartley.example/pay?paid=1",
      cancelUrl: "https://hartley.example/pay?cancelled=1",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    expect(result).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5", checkoutRef: "cs_test_a1b2c3d4e5" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Stripe-Account"]).toBe(ACCOUNT);
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("mode")).toBe("payment");
    expect(body.get("line_items[0][price_data][currency]")).toBe("gbp");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("2000");
    expect(body.get("metadata[payment_id]")).toBe(PAYMENT);
    expect(body.get("metadata[garage_id]")).toBe(GARAGE);
    expect(body.has("application_fee_amount")).toBe(false);
    // Stripe needs at least 30 minutes: a 10-minute hold is stretched (the job closes it on expiry).
    expect(Number(body.get("expires_at")) - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
  });

  it("clamps checkout expiry to Stripe's 30 minutes to 24 hours", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    const nowS = now.getTime() / 1000;
    expect(checkoutExpiry(new Date(now.getTime() + 60_000), now)).toBe(nowS + 30 * 60 + 30);
    expect(checkoutExpiry(new Date(now.getTime() + 2 * 3600_000), now)).toBe(nowS + 7200);
    expect(checkoutExpiry(new Date(now.getTime() + 30 * 24 * 3600_000), now)).toBe(nowS + 24 * 3600 - 60);
  });

  it("closes an open checkout and reads one back", async () => {
    const { calls, fetcher } = fakeFetch([{ json: { id: "cs_test_a1b2c3d4e5" } }, { json: { payment_status: "paid", amount_total: 2000, payment_intent: "pi_test_123" } }]);
    const provider = createStripePaymentsProvider(config, fetcher);
    expect(await provider.cancelCheckout({ accountRef: ACCOUNT, checkoutRef: "cs_test_a1b2c3d4e5" })).toBe(true);
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_a1b2c3d4e5/expire");
    expect(await provider.getCheckout({ accountRef: ACCOUNT, checkoutRef: "cs_test_a1b2c3d4e5" })).toEqual({ paid: true, amountPence: 2000, providerPaymentRef: "pi_test_123" });
    expect(await provider.cancelCheckout({ accountRef: "acct_bad/../x", checkoutRef: "cs_test_a1b2c3d4e5" })).toBe(false);
  });

  it("maps account states", () => {
    expect(accountState({ id: ACCOUNT, charges_enabled: true })).toEqual({ accountRef: ACCOUNT, status: "active", chargesEnabled: true });
    expect(accountState({ id: ACCOUNT, details_submitted: true })).toMatchObject({ status: "restricted" });
    expect(accountState({ id: ACCOUNT })).toMatchObject({ status: "pending" });
    expect(accountState({ id: "nope" })).toBeNull();
  });

  const paidEvent = {
    id: "evt_test_1",
    type: "checkout.session.completed",
    livemode: false,
    account: ACCOUNT,
    data: { object: { id: "cs_test_a1b2c3d4e5", payment_status: "paid", amount_total: 2000, payment_intent: "pi_test_123", metadata: { payment_id: PAYMENT, garage_id: GARAGE } } },
  };

  it("maps a paid checkout to our payment, with the connected account", () => {
    expect(mapStripePaymentsEvent(JSON.stringify(paidEvent))).toEqual({
      kind: "paid", eventId: "evt_test_1", type: "checkout.session.completed", accountRef: ACCOUNT, garageId: GARAGE, paymentId: PAYMENT, amountPence: 2000, providerPaymentRef: "pi_test_123",
    });
  });

  it("ignores live events, unpaid sessions and events without our ids", () => {
    expect(mapStripePaymentsEvent(JSON.stringify({ ...paidEvent, livemode: true }))).toMatchObject({ kind: "ignored" });
    expect(mapStripePaymentsEvent(JSON.stringify({ ...paidEvent, data: { object: { ...paidEvent.data.object, payment_status: "unpaid" } } }))).toMatchObject({ kind: "ignored" });
    expect(mapStripePaymentsEvent(JSON.stringify({ ...paidEvent, account: undefined }))).toMatchObject({ kind: "ignored" });
    expect(mapStripePaymentsEvent(JSON.stringify({ ...paidEvent, data: { object: { ...paidEvent.data.object, metadata: {} } } }))).toMatchObject({ kind: "ignored" });
    expect(mapStripePaymentsEvent("not json")).toBeNull();
  });

  it("maps account.updated", () => {
    const event = { id: "evt_test_2", type: "account.updated", account: ACCOUNT, data: { object: { id: ACCOUNT, charges_enabled: true, metadata: { garage_id: GARAGE } } } };
    expect(mapStripePaymentsEvent(JSON.stringify(event))).toEqual({ kind: "account", eventId: "evt_test_2", type: "account.updated", garageId: GARAGE, account: { accountRef: ACCOUNT, status: "active", chargesEnabled: true } });
  });

  it("checks the webhook signature with its own secret", () => {
    const provider = createStripePaymentsProvider(config);
    const raw = JSON.stringify(paidEvent);
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    expect(provider.parseWebhook(raw, signStripePayload(raw, WHSEC, timestamp), now)).toMatchObject({ kind: "paid" });
    expect(provider.parseWebhook(raw, signStripePayload(raw, "whsec_billing_other", timestamp), now)).toBeNull();
    expect(provider.parseWebhook(raw, signStripePayload(raw, WHSEC, timestamp - 3600), now)).toBeNull();
    expect(provider.parseWebhook(raw, null, now)).toBeNull();
  });
});

describe("expiry job", () => {
  it("is a known job kind, in the daily cron and on its own 5-minute cron", () => {
    expect(JOB_KINDS).toContain("payments.expire_deposits");
    expect(CRON_JOBS.daily).toContain("payments.expire_deposits");
    expect(CRON_JOBS["payments.expire_deposits"]).toEqual(["payments.expire_deposits"]);
    expect(cronDedupeKey("payments.expire_deposits", new Date("2026-10-28T12:07:00Z"))).not.toBe(cronDedupeKey("payments.expire_deposits", new Date("2026-10-28T12:12:00Z")));
  });
});
