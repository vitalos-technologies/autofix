import { describe, expect, it, vi } from "vitest";
import { signStripePayload } from "@/lib/billing/stripe";
import { openValue, sealValue } from "@/lib/booking-engine/state";
import { GROW_NAV_ITEMS } from "@/components/admin-ui/admin-nav";
import { createMockPaymentsProvider } from "@/lib/payments/mock";
import { createStripePaymentsProvider, mapStripePaymentsEvent } from "@/lib/payments/stripe";
import { mapStripePlanEvent, planStatusFromStripe } from "@/lib/payments/stripe-direct-debit";
import { FEATURES, proFeatureForPath } from "@/lib/plans/features";
import { composePlanNotice } from "@/lib/service-plans/messages";
import {
  guaranteeParagraphs,
  monthlyPrice,
  parsePlanForm,
  planBenefitLines,
  planErrorCode,
  planFlash,
  planPayload,
  planYearStart,
  poundsToPence,
  safePlanReturn,
  withPlanFlash,
} from "@/lib/service-plans/view";

// P5.11 customer service plans: the plan-year rule (mirrors service_plan_year_start(), pgTAP 037,
// including the clock-change days), the plan form, notices (STOP line, no registration), the sealed
// sign-up cookie and the Stripe Bacs Direct Debit adapter against a fake fetch.

const GARAGE = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION = "33333333-3333-4333-8333-333333333333";
const PAYMENT = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "acct_1TestGarage01";
const WHSEC = "whsec_testsecret";
const SERVICE_A = "44444444-4444-4444-8444-444444444444";
const SERVICE_B = "55555555-5555-4555-8555-555555555555";

describe("feature and nav", () => {
  it("is a Pro feature at /app/service-plans with one Grow nav entry", () => {
    expect(FEATURES.service_plans).toMatchObject({ plan: "pro", href: "/app/service-plans" });
    expect(proFeatureForPath("/app/service-plans")).toBe("service_plans");
    expect(GROW_NAV_ITEMS.filter((item) => item.feature === "service_plans")).toEqual([
      expect.objectContaining({ label: "Service plans", href: "/app/service-plans" }),
    ]);
  });
});

describe("plan year (service_plan_year_start)", () => {
  const at = (iso: string) => new Date(iso);
  it("counts whole years from the start, in the garage's local time", () => {
    expect(planYearStart(at("2026-11-02T09:00:00Z"), at("2027-03-10T09:00:00Z")).toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(planYearStart(at("2026-11-02T09:00:00Z"), at("2027-11-01T08:00:00Z")).toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(planYearStart(at("2026-11-02T09:00:00Z"), at("2027-11-02T10:00:00Z")).toISOString()).toBe("2027-11-02T09:00:00.000Z");
  });
  it("keeps the local time across the clock change (BST starts 28 Mar 2027)", () => {
    // 10:00 GMT on 28 Mar 2026 → 10:00 BST on 28 Mar 2027 = 09:00Z.
    expect(planYearStart(at("2026-03-28T10:00:00Z"), at("2027-03-28T12:00:00Z")).toISOString()).toBe("2027-03-28T09:00:00.000Z");
    expect(planYearStart(at("2026-03-28T10:00:00Z"), at("2027-03-28T09:30:00Z")).toISOString()).toBe("2027-03-28T09:00:00.000Z");
    expect(planYearStart(at("2026-03-28T10:00:00Z"), at("2027-03-28T08:30:00Z")).toISOString()).toBe("2026-03-28T10:00:00.000Z");
  });
  it("starts on the day the clocks went back, and before the start is year one", () => {
    expect(planYearStart(at("2026-10-25T09:00:00Z"), at("2026-12-01T12:00:00Z")).toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(planYearStart(at("2026-10-25T09:00:00Z"), at("2026-01-01T12:00:00Z")).toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });
  it("moves 29 February to 28 February in other years", () => {
    expect(planYearStart(at("2028-02-29T10:00:00Z"), at("2029-03-01T10:00:00Z")).toISOString()).toBe("2029-02-28T10:00:00.000Z");
  });
});

describe("plan form", () => {
  function form(values: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  }
  const services = [SERVICE_A, SERVICE_B];

  it("reads the plan with its included services", () => {
    const parsed = parsePlanForm(form({ name: "  Gold   care ", price: "£19.99", discount: "10", priority: "on", [`include_${SERVICE_A}`]: "on", [`uses_${SERVICE_A}`]: "2" }), services);
    expect(parsed).toEqual({
      ok: true,
      value: { name: "Gold care", description: null, pricePence: 1999, discountPercent: 10, priorityBooking: true, inclusions: [{ serviceId: SERVICE_A, usesPerYear: 2 }] },
    });
    expect(parsed.ok && planPayload(parsed.value)).toEqual({
      name: "Gold care", description: null, price_pence: 1999, discount_percent: 10, priority_booking: true, inclusions: [{ service_id: SERVICE_A, uses_per_year: 2 }],
    });
  });
  it("refuses a bad price, discount, uses, or a plan that includes nothing", () => {
    expect(parsePlanForm(form({ name: "Gold", price: "0.50", discount: "10" }), services)).toMatchObject({ ok: false, field: "price" });
    expect(parsePlanForm(form({ name: "Gold", price: "1000.01", discount: "10" }), services)).toMatchObject({ ok: false, field: "price" });
    expect(parsePlanForm(form({ name: "Gold", price: "10", discount: "51" }), services)).toMatchObject({ ok: false, field: "discount" });
    expect(parsePlanForm(form({ name: "Gold", price: "10", discount: "0" }), services)).toMatchObject({ ok: false, field: "inclusions" });
    expect(parsePlanForm(form({ name: "Gold", price: "10", [`include_${SERVICE_A}`]: "on", [`uses_${SERVICE_A}`]: "13" }), services)).toMatchObject({ ok: false, field: "inclusions" });
    expect(parsePlanForm(form({ name: "G", price: "10", discount: "5" }), services)).toMatchObject({ ok: false, field: "name" });
  });
  it("ignores services that aren't the garage's", () => {
    const parsed = parsePlanForm(form({ name: "Gold", price: "10", discount: "5", "include_not-a-service": "on" }), services);
    expect(parsed.ok && parsed.value.inclusions).toEqual([]);
  });
  it("turns pounds into pence", () => {
    expect(poundsToPence("19.99")).toBe(1999);
    expect(poundsToPence("£1,000")).toBe(100000);
    expect(poundsToPence("abc")).toBeNull();
  });
  it("describes the benefits as a customer would read them", () => {
    expect(planBenefitLines({
      inclusions: [{ serviceId: SERVICE_A, serviceName: "Full service", usesPerYear: 1 }, { serviceId: SERVICE_B, serviceName: "MOT", usesPerYear: 2 }],
      discountPercent: 10,
      priorityBooking: true,
    })).toEqual(["Full service included once a year", "MOT included 2 times a year", "10% off parts and labour", "Priority booking: call us and we fit you in first"]);
    expect(monthlyPrice(1999)).toBe("£19.99 a month");
  });
});

describe("flash and return paths", () => {
  it("only returns to plan pages and detail pages", () => {
    expect(safePlanReturn(`/app/bookings/${PAYMENT}`)).toBe(`/app/bookings/${PAYMENT}`);
    expect(safePlanReturn("https://evil.example/")).toBe("/app/service-plans");
    expect(safePlanReturn("/app/bookings/../settings")).toBe("/app/service-plans");
    expect(withPlanFlash(`/app/customers/${PAYMENT}`, "done", "cancelled")).toBe(`/app/customers/${PAYMENT}?plans=cancelled#service-plan`);
    expect(withPlanFlash("/app/service-plans", "error", "PLAN_REQUIRED")).toBe("/app/service-plans?plansError=PLAN_REQUIRED");
  });
  it("maps SQL errors to messages", () => {
    expect(planErrorCode({ message: "PLAN_REQUIRED: service_plans" })).toBe("PLAN_REQUIRED");
    expect(planErrorCode({ message: "SERVICE_PLANS_FORBIDDEN", code: "42501" })).toBe("SERVICE_PLANS_FORBIDDEN");
    expect(planErrorCode({ message: "new row violates row-level security policy", code: "42501" })).toBe("SERVICE_PLANS_FORBIDDEN");
    expect(planErrorCode({ message: "something odd" })).toBe("failed");
    expect(planFlash(undefined, "PLAN_PAST_DUE")?.tone).toBe("error");
    expect(planFlash("plan_added", undefined)?.text).toMatch(/Plan added/);
  });
});

describe("notices", () => {
  const input = { kind: "confirmation" as const, garageName: "Hartley Road Garage", garagePhone: "01302 555123", planName: "Gold care", pricePence: 1999, carName: "Ford Fiesta" };
  it("texts end with the opt-out line and never carry a registration", () => {
    const sms = composePlanNotice(input, "sms");
    expect(sms.body).toMatch(/^Hartley Road Garage: you're on our Gold care plan for your Ford Fiesta\. Your Direct Debit of £19\.99 a month is set up/);
    expect(sms.body).toMatch(/Reply STOP to opt out\.$/);
    const failed = composePlanNotice({ ...input, kind: "payment_failed" }, "whatsapp");
    expect(failed.body).toMatch(/payment of £19\.99 didn't go through/);
    expect(failed.body).toMatch(/01302 555123/);
    expect(failed.subject).toBe("Your Gold care plan payment didn't go through");
  });
  it("emails escape the garage name and say how to cancel", () => {
    const email = composePlanNotice({ ...input, garageName: "A&B <Motors>" }, "email");
    expect(email.html).toContain("A&amp;B &lt;Motors&gt;");
    expect(email.body).toMatch(/cancel your Direct Debit at any time/);
    expect(email.body).not.toMatch(/STOP/);
  });
  it("shows the Direct Debit Guarantee with the garage as payee", () => {
    const paragraphs = guaranteeParagraphs("Hartley Road Garage");
    expect(paragraphs).toHaveLength(5);
    expect(paragraphs[1]).toMatch(/Hartley Road Garage will notify you/);
    expect(paragraphs.join(" ")).toMatch(/full and immediate refund/);
  });
});

describe("sign-up cookie (af_plan)", () => {
  it("is sealed for one garage and expires", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    const sealed = sealValue("af_plan", GARAGE, { subscriptionId: SUBSCRIPTION }, { now, maxAgeS: 7200 });
    expect(sealed).not.toContain(SUBSCRIPTION);
    expect(openValue("af_plan", GARAGE, sealed, { now })).toEqual({ subscriptionId: SUBSCRIPTION });
    expect(openValue("af_plan", PAYMENT, sealed, { now })).toBeNull();
    expect(openValue("af_booking", GARAGE, sealed, { now })).toBeNull();
    expect(openValue("af_plan", GARAGE, sealed, { now: new Date(now.getTime() + 7201_000) })).toBeNull();
  });
});

describe("mock provider", () => {
  it("sets up the mandate on the garage host and cancels at once", async () => {
    const mock = createMockPaymentsProvider();
    expect(await mock.startMandate({ accountRef: "mock_acct_1", subscriptionId: SUBSCRIPTION, garageId: GARAGE, amountPence: 1999, description: "Gold", customerEmail: null, successUrl: "s", cancelUrl: "c" })).toEqual({ kind: "local" });
    expect(await mock.cancelMandate({ accountRef: "mock_acct_1", subscriptionRef: "mock_sub_1" })).toBe(true);
    expect(await mock.getMandate({ accountRef: "mock_acct_1", checkoutRef: "x" })).toBeNull();
  });
});

describe("Stripe Bacs Direct Debit (test mode)", () => {
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

  it("starts a subscription checkout with bacs_debit on the garage's account, ids only", async () => {
    const { calls, fetcher } = fakeFetch([{ json: { id: "cs_test_dd1234567", url: "https://checkout.stripe.com/c/pay/cs_test_dd1234567" } }]);
    const result = await createStripePaymentsProvider(config, fetcher).startMandate({
      accountRef: ACCOUNT,
      subscriptionId: SUBSCRIPTION,
      garageId: GARAGE,
      amountPence: 1999,
      description: "Gold care, Hartley Road Garage",
      customerEmail: "sally@example.test",
      successUrl: "https://hartley.example/plans/confirm?done=1",
      cancelUrl: "https://hartley.example/plans/confirm?cancelled=1",
    });
    expect(result).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_dd1234567", checkoutRef: "cs_test_dd1234567" });
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Stripe-Account"]).toBe(ACCOUNT);
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("payment_method_types[0]")).toBe("bacs_debit");
    expect(body.get("line_items[0][price_data][currency]")).toBe("gbp");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("1999");
    expect(body.get("line_items[0][price_data][recurring][interval]")).toBe("month");
    expect(body.get("subscription_data[metadata][plan_subscription_id]")).toBe(SUBSCRIPTION);
    expect(body.get("subscription_data[metadata][garage_id]")).toBe(GARAGE);
    expect(body.get("metadata[plan_subscription_id]")).toBe(SUBSCRIPTION);
  });

  it("refuses a malformed account and reports provider errors", async () => {
    const { fetcher } = fakeFetch([{ ok: false, json: { error: { code: "parameter_invalid" } } }]);
    const provider = createStripePaymentsProvider(config, fetcher);
    const base = { subscriptionId: SUBSCRIPTION, garageId: GARAGE, amountPence: 1999, description: "Gold", customerEmail: null, successUrl: "s", cancelUrl: "c" };
    expect(await provider.startMandate({ ...base, accountRef: "not-an-account" })).toEqual({ kind: "error", code: "provider_error" });
    expect(await provider.startMandate({ ...base, accountRef: ACCOUNT })).toEqual({ kind: "error", code: "provider_error" });
  });

  it("reads a finished checkout back, and cancels with DELETE", async () => {
    const { calls, fetcher } = fakeFetch([
      { json: { status: "complete", subscription: { id: "sub_test_12345678", status: "active", current_period_end: 1796112000, default_payment_method: "pm_test_bacs1" } } },
      { json: { id: "sub_test_12345678", status: "canceled" } },
      { ok: false, json: { error: { code: "resource_missing" } } },
    ]);
    const provider = createStripePaymentsProvider(config, fetcher);
    expect(await provider.getMandate({ accountRef: ACCOUNT, checkoutRef: "cs_test_dd1234567" })).toEqual({
      status: "active", subscriptionRef: "sub_test_12345678", mandateRef: "pm_test_bacs1", renewsAt: new Date(1796112000 * 1000).toISOString(),
    });
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_dd1234567?expand[]=subscription");
    expect(await provider.cancelMandate({ accountRef: ACCOUNT, subscriptionRef: "sub_test_12345678" })).toBe(true);
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(calls[1]!.url).toBe("https://api.stripe.com/v1/subscriptions/sub_test_12345678");
    expect(await provider.cancelMandate({ accountRef: ACCOUNT, subscriptionRef: "sub_test_12345678" })).toBe(true);
    expect(await provider.cancelMandate({ accountRef: ACCOUNT, subscriptionRef: "not-a-sub" })).toBe(false);
  });

  it("maps Stripe's subscription statuses", () => {
    expect(["active", "trialing", "past_due", "unpaid", "canceled", "incomplete_expired", "incomplete", "paused", "x"].map(planStatusFromStripe))
      .toEqual(["active", "active", "past_due", "past_due", "cancelled", "cancelled", null, null, null]);
  });

  const event = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id: `evt_${type.replace(/\W/g, "_")}`, type, account: ACCOUNT, livemode: false, data: { object }, ...extra });
  const metadata = { plan_subscription_id: SUBSCRIPTION, garage_id: GARAGE };

  it("maps the plan events", () => {
    expect(mapStripePaymentsEvent(event("checkout.session.completed", { mode: "subscription", subscription: "sub_test_12345678", metadata }))).toMatchObject({
      kind: "plan_subscription", subscriptionId: SUBSCRIPTION, garageId: GARAGE, accountRef: ACCOUNT, status: null, subscriptionRef: "sub_test_12345678",
    });
    expect(mapStripePaymentsEvent(event("customer.subscription.updated", { id: "sub_test_12345678", status: "past_due", items: { data: [{ current_period_end: 1796112000 }] }, metadata }))).toMatchObject({
      kind: "plan_subscription", status: "past_due", renewsAt: new Date(1796112000 * 1000).toISOString(),
    });
    expect(mapStripePaymentsEvent(event("customer.subscription.deleted", { id: "sub_test_12345678", status: "canceled", metadata }))).toMatchObject({ status: "cancelled" });
    expect(mapStripePaymentsEvent(event("invoice.payment_failed", { parent: { subscription_details: { metadata, subscription: "sub_test_12345678" } } }))).toMatchObject({
      kind: "plan_subscription", status: "past_due", subscriptionRef: "sub_test_12345678",
    });
    expect(mapStripePaymentsEvent(event("invoice.paid", { subscription: "sub_test_12345678", subscription_details: { metadata } }))).toMatchObject({ status: "active" });
  });

  it("ignores live events, events without the garage's account, and leaves P5.4 payments alone", () => {
    expect(mapStripePaymentsEvent(event("customer.subscription.updated", { id: "sub_test_12345678", status: "active", metadata }, { livemode: true }))).toMatchObject({ kind: "ignored" });
    expect(mapStripePlanEvent({ id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_test_12345678", status: "active", metadata } } })).toMatchObject({ kind: "ignored" });
    expect(mapStripePlanEvent({ id: "evt_2", type: "customer.subscription.updated", account: ACCOUNT, data: { object: { id: "sub_test_12345678", status: "active", metadata: {} } } })).toBeNull();
    expect(mapStripePaymentsEvent(event("checkout.session.completed", { mode: "payment", payment_status: "paid", amount_total: 2000, metadata: { payment_id: PAYMENT, garage_id: GARAGE } }))).toMatchObject({ kind: "paid", paymentId: PAYMENT });
  });

  it("verifies the signature before mapping", () => {
    const raw = event("customer.subscription.created", { id: "sub_test_12345678", status: "active", metadata });
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const provider = createStripePaymentsProvider(config);
    expect(provider.parseWebhook(raw, signStripePayload(raw, WHSEC, timestamp), now)).toMatchObject({ kind: "plan_subscription", status: "active" });
    expect(provider.parseWebhook(raw, signStripePayload(raw, "whsec_other", timestamp), now)).toBeNull();
  });
});
