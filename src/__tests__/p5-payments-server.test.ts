import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, filterValue, type FakeQuery, type FakeResult, type FakeRpc } from "./support/fake-supabase";

const notifyBooking = vi.hoisted(() => vi.fn());
const adminClient = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/booking-engine/notify", () => ({ notifyBooking }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => adminClient.current }));

import { createSupabaseBookingEngine } from "@/lib/booking-engine/repository";
import { clearSlotCache } from "@/lib/booking-engine/slots";
import { clearMockOutbox, createMockChannel, getMockOutbox } from "@/lib/messaging/mock";
import { applyPaymentsEvent, depositQuote, markPaymentPaid, releaseExpiredDeposits, sendPaymentLink, startDeposit } from "@/lib/payments/server";
import { paymentsExpireDepositsHandler } from "@/lib/payments/jobs";
import type { JobContext } from "@/lib/jobs/types";

// P5.4 server side, with a fake service-role client: deposits are only quoted for a Pro garage with an
// active account for this deployment's provider; a deposit paid in time sends the confirmation the
// booking flow held back; webhooks apply once and only for the garage's own account; pay links go to
// the customer's channel and honour STOP; the engine holds back "created" when asked.

const GARAGE = "11111111-1111-4111-8111-111111111111";
const BOOKING = "55555555-5555-4555-8555-555555555555";
const PAYMENT = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "66666666-6666-4666-8666-666666666666";
const pro = { id: GARAGE, plan: "pro", trialEndsAt: null, planChosen: "pro" };
const essentials = { id: GARAGE, plan: "essentials", trialEndsAt: null, planChosen: "essentials" };

type World = {
  account: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
  rpc: (call: FakeRpc) => FakeResult;
};

function fakeFor(world: Partial<World>) {
  const state: World = {
    account: { provider: "mock", account_ref: "mock_acct_1", status: "active", charges_enabled: true, connected_at: null, disconnected_at: null },
    settings: { deposits_enabled: true, default_deposit_mode: "fixed", default_deposit_value: 2000, deposit_hold_min: 30, no_show_fee_pence: 2500 },
    customer: { name: "Sam", phone: "+447700900123", email: "sam@example.com", channel: "sms", opted_out_at: null, anonymised_at: null },
    rpc: () => ({ data: null }),
    ...world,
  };
  const fake = createFakeSupabase({
    from: (query: FakeQuery) => {
      if (query.table === "payment_accounts") return { data: state.account };
      if (query.table === "payment_settings") return { data: state.settings };
      if (query.table === "customers") return { data: state.customer };
      if (query.table === "messages" && query.operation === "insert") return { data: { id: "77777777-7777-4777-8777-777777777777" } };
      return { data: null };
    },
    rpc: (call) => state.rpc(call),
  });
  adminClient.current = fake.client;
  return fake;
}

beforeEach(() => {
  notifyBooking.mockReset();
  clearMockOutbox();
  clearSlotCache();
  vi.unstubAllEnvs();
});

describe("deposit quote", () => {
  it("quotes the deposit for a Pro garage with an active mock account", async () => {
    const fake = fakeFor({ rpc: (call) => (call.fn === "payment_deposit_amount" ? { data: 2000 } : { data: null }) });
    expect(await depositQuote(pro, SERVICE)).toEqual({ amountPence: 2000, holdMin: 30, provider: "mock" });
    expect(fake.rpcs[0]).toEqual({ fn: "payment_deposit_amount", args: { p_garage_id: GARAGE, p_service_id: SERVICE } });
  });

  it("takes no deposit on Essentials: the booking works as before", async () => {
    const fake = fakeFor({ rpc: () => ({ data: 2000 }) });
    expect(await depositQuote(essentials, SERVICE)).toBeNull();
    expect(fake.rpcs).toEqual([]);
  });

  it("takes no deposit without an active account for this provider, or with deposits off", async () => {
    fakeFor({ account: { provider: "stripe", account_ref: "acct_1", status: "active", charges_enabled: true }, rpc: () => ({ data: 2000 }) });
    expect(await depositQuote(pro, SERVICE)).toBeNull();
    fakeFor({ account: { provider: "mock", account_ref: "mock_acct_1", status: "disconnected", charges_enabled: false }, rpc: () => ({ data: 2000 }) });
    expect(await depositQuote(pro, SERVICE)).toBeNull();
    fakeFor({ settings: { deposits_enabled: false, deposit_hold_min: 30 }, rpc: () => ({ data: 2000 }) });
    expect(await depositQuote(pro, SERVICE)).toBeNull();
  });

  it("takes no deposit where payments cannot run (production without Stripe)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    fakeFor({ rpc: () => ({ data: 2000 }) });
    expect(await depositQuote(pro, SERVICE)).toBeNull();
  });
});

describe("starting a deposit", () => {
  it("stores only the token's hash and hands the token back", async () => {
    const fake = fakeFor({ rpc: () => ({ data: { id: PAYMENT, status: "pending" } }) });
    const started = await startDeposit({ id: GARAGE }, BOOKING, "mock");
    expect(started?.status).toBe("pending");
    const args = fake.rpcs[0]!.args;
    expect(fake.rpcs[0]!.fn).toBe("create_deposit_payment");
    expect(args).toMatchObject({ p_garage_id: GARAGE, p_booking_id: BOOKING, p_provider: "mock" });
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain(started!.token);
  });

  it("is null when the database says no deposit applies", async () => {
    fakeFor({ rpc: () => ({ data: { id: null } }) });
    expect(await startDeposit({ id: GARAGE }, BOOKING, "mock")).toBeNull();
  });
});

describe("paid", () => {
  it("a deposit paid in time sends the held-back confirmation, once", async () => {
    let already = false;
    fakeFor({ rpc: (call) => {
      if (call.fn !== "apply_payment_paid") return { data: null };
      const result = { kind: "deposit", already, attention: null, booking_id: BOOKING };
      already = true;
      return { data: result };
    } });
    await markPaymentPaid({ garageId: GARAGE, paymentId: PAYMENT, provider: "mock", providerPaymentRef: "mock_pi_1", amountPence: 2000 });
    await markPaymentPaid({ garageId: GARAGE, paymentId: PAYMENT, provider: "mock", providerPaymentRef: "mock_pi_1", amountPence: 2000 });
    expect(notifyBooking).toHaveBeenCalledTimes(1);
    expect(notifyBooking).toHaveBeenCalledWith({ type: "created", garageId: GARAGE, bookingId: BOOKING });
  });

  it("a deposit paid after its slot was released sends nothing", async () => {
    fakeFor({ rpc: () => ({ data: { kind: "deposit", already: false, attention: "paid_after_release", booking_id: BOOKING } }) });
    expect(await markPaymentPaid({ garageId: GARAGE, paymentId: PAYMENT, provider: "mock", providerPaymentRef: null, amountPence: 2000 })).toMatchObject({ ok: true, attention: "paid_after_release" });
    expect(notifyBooking).not.toHaveBeenCalled();
  });
});

describe("webhooks", () => {
  const paid = { kind: "paid" as const, eventId: "evt_1", type: "checkout.session.completed", accountRef: "acct_1Garage", garageId: GARAGE, paymentId: PAYMENT, amountPence: 2000, providerPaymentRef: "pi_1" };

  it("applies a paid event once, for the garage's own account only", async () => {
    let claimed = false;
    const fake = fakeFor({
      account: { provider: "stripe", account_ref: "acct_1Garage", status: "active", charges_enabled: true },
      rpc: (call) => {
        if (call.fn === "claim_payment_webhook_event") {
          const first = !claimed;
          claimed = true;
          return { data: first };
        }
        if (call.fn === "apply_payment_paid") return { data: { kind: "invoice", already: false, attention: null, booking_id: null } };
        return { data: null };
      },
    });
    expect(await applyPaymentsEvent(paid, "stripe")).toBe("applied");
    expect(await applyPaymentsEvent(paid, "stripe")).toBe("duplicate");
    expect(fake.rpcs.filter((call) => call.fn === "apply_payment_paid")).toHaveLength(1);
  });

  it("ignores money that landed on another account", async () => {
    const fake = fakeFor({
      account: { provider: "stripe", account_ref: "acct_1Someone", status: "active", charges_enabled: true },
      rpc: (call) => (call.fn === "claim_payment_webhook_event" ? { data: true } : { data: null }),
    });
    expect(await applyPaymentsEvent(paid, "stripe")).toBe("ignored");
    expect(fake.rpcs.some((call) => call.fn === "apply_payment_paid")).toBe(false);
  });
});

describe("expiry", () => {
  it("releases expired deposits for every garage from the job", async () => {
    const fake = fakeFor({ rpc: (call) => (call.fn === "expire_pending_deposits"
      ? { data: [{ payment_id: PAYMENT, garage_id: GARAGE, booking_id: BOOKING, kind: "deposit", provider: "mock", checkout_ref: null, booking_released: true }] }
      : { data: null }) });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await paymentsExpireDepositsHandler({}, { db: fake.client, now: () => new Date("2026-10-28T12:00:00Z"), log } as unknown as JobContext);
    expect(result).toEqual({ outcome: "expired", counts: { expired: 1 } });
    expect(fake.rpcs[0]).toEqual({ fn: "expire_pending_deposits", args: { p_now: "2026-10-28T12:00:00.000Z", p_garage_id: null } });
  });

  it("never throws when the database is down", async () => {
    fakeFor({ rpc: () => ({ error: { code: "57P01" } }) });
    expect(await releaseExpiredDeposits(GARAGE)).toBe(0);
  });
});

describe("pay links", () => {
  const payment = { id: PAYMENT, kind: "invoice" as const, amount_pence: 6000, customer_id: CUSTOMER, booking_id: null };
  const garage = { id: GARAGE, name: "Hartley Road Garage", slug: "hartley-road", customDomain: null };

  it("texts the link on the customer's channel and logs it in messages", async () => {
    const fake = fakeFor({});
    const result = await sendPaymentLink({ garage, payment, token: "t".repeat(43), what: "invoice INV-1", channelFor: (kind) => createMockChannel(kind) });
    expect(result).toEqual({ channel: "sms", outcome: "sent" });
    const outbox = getMockOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.body).toContain("/pay/tttt");
    expect(outbox[0]!.body).toMatch(/Reply STOP to opt out\.$/);
    const inserted = fake.queries.find((query) => query.table === "messages" && query.operation === "insert");
    expect(inserted?.values).toMatchObject({ garage_id: GARAGE, channel: "sms", direction: "outbound", status: "sending", provider: "mock" });
    const recorded = fake.queries.find((query) => query.table === "payments" && query.operation === "update");
    expect(recorded?.values).toMatchObject({ notify_channel: "sms", notify_outcome: "sent" });
    expect(filterValue(recorded!, "eq", "garage_id")).toBe(GARAGE);
  });

  it("sends nothing to a customer who sent STOP and has no email", async () => {
    const fake = fakeFor({ customer: { name: "Sam", phone: "+447700900123", email: null, channel: "sms", opted_out_at: "2026-10-01T00:00:00Z", anonymised_at: null } });
    expect(await sendPaymentLink({ garage, payment, token: "t".repeat(43), what: "invoice INV-1", channelFor: (kind) => createMockChannel(kind) })).toEqual({ channel: "none", outcome: "opted_out" });
    expect(getMockOutbox()).toHaveLength(0);
    expect(fake.queries.some((query) => query.table === "messages")).toBe(false);
  });
});

describe("booking engine", () => {
  it("holds back the created notice when a deposit is due", async () => {
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.table === "garages") return { data: { id: GARAGE, timezone: "Europe/London", mot_enabled: false, status: "active" } };
        if (query.table === "services") return { data: { id: SERVICE, name: "MOT", description: "", duration_min: 60, buffer_min: 0, price_pence: 5000, price_mode: "fixed", location_mode: "workshop", is_mot: false, needs_approval: false, min_notice_h: 2, max_days_ahead: 60, sort: 1, online_enabled: true, deleted_at: null } };
        return { data: null };
      },
      rpc: () => ({ data: { booking_id: BOOKING, reference: "HRM-4821", status: "confirmed", starts_at: "2026-11-20T10:00:00+00:00", ends_at: "2026-11-20T11:00:00+00:00", customer_id: CUSTOMER, vehicle_id: "77777777-7777-4777-8777-777777777777" } }),
    });
    const engine = createSupabaseBookingEngine({ client: () => fake.client, now: () => new Date("2026-11-18T09:00:00Z") });
    const input = {
      serviceId: SERVICE,
      startsAt: "2026-11-20T10:00:00.000Z",
      locationMode: "workshop" as const,
      symptoms: [],
      customer: { name: "Sam Patel", phone: "07700 900123", channel: "sms" as const, reminderConsent: false },
      vehicle: { registration: "AB12CDE" },
      idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
      source: "online" as const,
    };
    expect(await engine.createBooking(GARAGE, input, { deferCreatedNotice: true })).toMatchObject({ ok: true });
    expect(notifyBooking).not.toHaveBeenCalled();
    expect(fake.rpcs.filter((call) => call.fn === "create_booking")).toHaveLength(1);
    await engine.createBooking(GARAGE, { ...input, idempotencyKey: "a5898238-32a1-4764-b57b-529fa953c942" });
    expect(notifyBooking).toHaveBeenCalledTimes(1);
  });
});
