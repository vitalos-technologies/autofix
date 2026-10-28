import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeQuery, type FakeResult, type FakeRpc } from "./support/fake-supabase";

const adminClient = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => adminClient.current }));

import { clearMockOutbox, getMockOutbox } from "@/lib/messaging/mock";
import { applyPaymentsEvent } from "@/lib/payments/server";
import { applyPlanStatus, recordPlanBooking, signupReadiness, startSignup } from "@/lib/service-plans/server";

// P5.11 server side with a fake service-role client: webhook events apply once and only from the
// garage's own account; a status change that asks for a notice sends it on the customer's channel
// (STOP → email, else none) without the registration; the booking flow's hook never throws; sign-up
// needs Pro and an active account for this deployment's provider.

const GARAGE = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION = "33333333-3333-4333-8333-333333333333";
const PLAN = "44444444-4444-4444-8444-444444444444";
const BOOKING = "55555555-5555-4555-8555-555555555555";
const pro = { id: GARAGE, name: "Hartley Road Garage", slug: "hartley-road", customDomain: null, plan: "pro" as const, trialEndsAt: null, planChosen: "pro" as const };
const essentials = { ...pro, plan: "essentials" as const, planChosen: "essentials" as const };

type World = {
  account: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
  rpc: (call: FakeRpc) => FakeResult;
};

function fakeFor(world: Partial<World>) {
  const state: World = {
    account: { provider: "mock", account_ref: "mock_acct_1", status: "active", charges_enabled: true },
    customer: { name: "Sally", phone: "+447700900123", email: "sally@example.com", channel: "sms", opted_out_at: null, anonymised_at: null },
    rpc: () => ({ data: null }),
    ...world,
  };
  const fake = createFakeSupabase({
    from: (query: FakeQuery) => {
      if (query.table === "payment_accounts") return { data: state.account };
      if (query.table === "garages") return { data: { name: "Hartley Road Garage", phone: "01302 555123" } };
      if (query.table === "service_plans") return { data: { name: "Gold care" } };
      if (query.table === "customer_plan_subscriptions" && query.operation === "select") {
        return { data: { customer_id: "66666666-6666-4666-8666-666666666666", price_pence: 1999, service_plans: { name: "Gold care" }, vehicles: { make: "Ford", model: "Fiesta", registration: "AB12CDE" }, customers: state.customer } };
      }
      if (query.table === "messages" && query.operation === "insert") return { data: { id: "77777777-7777-4777-8777-777777777777" } };
      return { data: null };
    },
    rpc: (call) => state.rpc(call),
  });
  adminClient.current = fake.client;
  return fake;
}

beforeEach(() => {
  clearMockOutbox();
  vi.unstubAllEnvs();
});

describe("status changes and notices", () => {
  it("pending → active sends the sign-up confirmation by text, without the registration", async () => {
    fakeFor({ rpc: () => ({ data: { changed: true, status: "active", notify: "confirmation" } }) });
    const applied = await applyPlanStatus({ garageId: GARAGE, subscriptionId: SUBSCRIPTION, provider: "mock", status: "active", mandateRef: "m", subscriptionRef: "s", renewsAt: null });
    expect(applied).toEqual({ ok: true, changed: true, status: "active", notify: "confirmation" });
    const outbox = getMockOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.body).toMatch(/you're on our Gold care plan for your Ford Fiesta/);
    expect(outbox[0]!.body).toMatch(/Reply STOP to opt out\.$/);
    expect(outbox[0]!.body).not.toContain("AB12CDE");
  });

  it("a customer who sent STOP gets the payment-failed notice by email; with no email, nothing", async () => {
    fakeFor({
      customer: { name: "Sally", phone: "+447700900123", email: "sally@example.com", channel: "sms", opted_out_at: "2026-10-01T00:00:00Z", anonymised_at: null },
      rpc: () => ({ data: { changed: true, status: "past_due", notify: "payment_failed" } }),
    });
    await applyPlanStatus({ garageId: GARAGE, subscriptionId: SUBSCRIPTION, provider: "mock", status: "past_due", mandateRef: null, subscriptionRef: null, renewsAt: null });
    expect(getMockOutbox().map((entry) => entry.to)).toEqual(["sally@example.com"]);

    clearMockOutbox();
    const fake = fakeFor({
      customer: { name: "Sally", phone: "+447700900123", email: null, channel: "sms", opted_out_at: "2026-10-01T00:00:00Z", anonymised_at: null },
      rpc: () => ({ data: { changed: true, status: "past_due", notify: "payment_failed" } }),
    });
    await applyPlanStatus({ garageId: GARAGE, subscriptionId: SUBSCRIPTION, provider: "mock", status: "past_due", mandateRef: null, subscriptionRef: null, renewsAt: null });
    expect(getMockOutbox()).toHaveLength(0);
    const recorded = fake.queries.find((query) => query.table === "customer_plan_subscriptions" && query.operation === "update");
    expect(recorded?.values).toMatchObject({ last_notice_kind: "payment_failed", last_notice_channel: "none", last_notice_outcome: "opted_out" });
  });

  it("no notice when nothing changed", async () => {
    fakeFor({ rpc: () => ({ data: { changed: false, status: "active", notify: null } }) });
    await applyPlanStatus({ garageId: GARAGE, subscriptionId: SUBSCRIPTION, provider: "mock", status: "active", mandateRef: null, subscriptionRef: null, renewsAt: null });
    expect(getMockOutbox()).toHaveLength(0);
  });
});

describe("webhooks", () => {
  const event = {
    kind: "plan_subscription" as const, eventId: "evt_1", type: "customer.subscription.updated", accountRef: "acct_1Garage",
    garageId: GARAGE, subscriptionId: SUBSCRIPTION, status: "past_due" as const, subscriptionRef: "sub_1", mandateRef: null, renewsAt: null,
  };

  it("applies an event from the garage's own account, once", async () => {
    let claimed = false;
    const fake = fakeFor({
      account: { provider: "stripe", account_ref: "acct_1Garage" },
      rpc: (call) => {
        if (call.fn === "claim_payment_webhook_event") {
          const first = !claimed;
          claimed = true;
          return { data: first };
        }
        if (call.fn === "apply_plan_subscription_status") return { data: { changed: true, status: "past_due", notify: null } };
        return { data: null };
      },
    });
    expect(await applyPaymentsEvent(event, "stripe")).toBe("applied");
    expect(await applyPaymentsEvent(event, "stripe")).toBe("duplicate");
    expect(fake.rpcs.filter((call) => call.fn === "apply_plan_subscription_status")).toHaveLength(1);
    expect(fake.rpcs.find((call) => call.fn === "apply_plan_subscription_status")!.args).toMatchObject({ p_garage_id: GARAGE, p_subscription_id: SUBSCRIPTION, p_status: "past_due", p_provider: "stripe" });
  });

  it("ignores an event from another account", async () => {
    const fake = fakeFor({
      account: { provider: "stripe", account_ref: "acct_1Other" },
      rpc: (call) => ({ data: call.fn === "claim_payment_webhook_event" ? true : null }),
    });
    expect(await applyPaymentsEvent(event, "stripe")).toBe("ignored");
    expect(fake.rpcs.some((call) => call.fn === "apply_plan_subscription_status")).toBe(false);
  });
});

describe("booking flow and sign-up", () => {
  it("recording a plan booking never throws", async () => {
    fakeFor({ rpc: () => { throw new Error("boom"); } });
    expect(await recordPlanBooking(GARAGE, BOOKING)).toEqual({ onPlan: false, planName: null, recorded: false, reason: null });
    fakeFor({ rpc: () => ({ data: { on_plan: true, plan_name: "Gold care", recorded: true } }) });
    expect(await recordPlanBooking(GARAGE, BOOKING)).toEqual({ onPlan: true, planName: "Gold care", recorded: true, reason: null });
  });

  it("needs Pro and an active account for this deployment's provider", async () => {
    fakeFor({});
    expect(await signupReadiness(essentials)).toEqual({ ok: false, reason: "plan_required" });
    expect(await signupReadiness(pro)).toEqual({ ok: true, provider: "mock", accountRef: "mock_acct_1" });
    fakeFor({ account: { provider: "mock", account_ref: "mock_acct_1", status: "disconnected", charges_enabled: false } });
    expect(await signupReadiness(pro)).toEqual({ ok: false, reason: "unavailable" });
    vi.stubEnv("VERCEL_ENV", "production");
    fakeFor({});
    expect(await signupReadiness(pro)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("starts a mock mandate after linking the customer and car in SQL", async () => {
    const fake = fakeFor({ rpc: (call) => (call.fn === "start_plan_signup" ? { data: { id: SUBSCRIPTION, price_pence: 1999 } } : { data: null }) });
    const started = await startSignup(pro, {
      planId: PLAN,
      customer: { name: "Sally", phone: "+447700900123", email: null, channel: "sms" },
      vehicle: { registration: "AB12CDE", make: null, model: null },
    });
    expect(started).toEqual({ ok: true, subscriptionId: SUBSCRIPTION, next: { kind: "local" } });
    expect(fake.rpcs[0]).toMatchObject({ fn: "start_plan_signup", args: { p_garage_id: GARAGE, p_plan_id: PLAN, p_provider: "mock" } });
  });

  it("passes SQL refusals on as codes", async () => {
    fakeFor({ rpc: () => ({ data: null, error: { message: "ALREADY_ON_PLAN", code: "P0001" } }) });
    expect(await startSignup(pro, {
      planId: PLAN,
      customer: { name: "Sally", phone: "+447700900123", email: null, channel: "sms" },
      vehicle: { registration: "AB12CDE", make: null, model: null },
    })).toEqual({ ok: false, code: "ALREADY_ON_PLAN" });
  });
});
