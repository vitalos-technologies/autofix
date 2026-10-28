import "server-only";

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getChannel, type ChannelKind, type MessageChannel } from "@/lib/messaging/channel";
import { getPaymentsProvider } from "@/lib/payments";
import { chooseLinkChannel, type LinkCustomer } from "@/lib/payments/messages";
import type { PaymentsEvent, PaymentsProviderKind, PlanSubscriptionStatus } from "@/lib/payments/provider";
import { garageHasFeature } from "@/lib/plans/server";
import { createAdminClient } from "@/lib/supabase/server";
import type { Garage } from "@/lib/tenancy/garage";
import { garageUrl } from "@/lib/tenancy/urls";
import { composePlanNotice, type PlanNoticeKind } from "./messages";
import { planYearStart, type PlanSubscription, type ServicePlan, type SubscriptionStatus } from "./view";

// Customer service plans on the server (P5.11). Admin reads go through the member's RLS client;
// the garage host (sign-up), webhooks and the booking flow use the service role and always name the
// garage, which comes from the request host or the member's selected garage, never from a form.
// Logs carry ids, kinds and outcomes only: never a registration, phone number or name.

type PlanGarage = Pick<Garage, "id" | "plan" | "trialEndsAt" | "planChosen">;

function log(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}) {
  console.info(JSON.stringify({ scope: "service_plans", event, ...fields }));
}

export class ServicePlansDataError extends Error {}

type One<T> = T | T[] | null | undefined;
function one<T>(value: One<T>): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export const PLAN_SELECT =
  "id,name,description,price_pence,discount_percent,priority_booking,status,service_plan_inclusions(service_id,uses_per_year,services(name))";

type PlanRow = {
  id: string;
  name: string;
  description: string | null;
  price_pence: number;
  discount_percent: number;
  priority_booking: boolean;
  status: "active" | "archived";
  service_plan_inclusions: Array<{ service_id: string; uses_per_year: number; services: One<{ name: string }> }> | null;
};

export function shapePlan(row: PlanRow): ServicePlan {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    pricePence: row.price_pence,
    discountPercent: row.discount_percent,
    priorityBooking: row.priority_booking,
    status: row.status,
    inclusions: (row.service_plan_inclusions ?? [])
      .map((inclusion) => ({ serviceId: inclusion.service_id, serviceName: one(inclusion.services)?.name ?? "Service", usesPerYear: inclusion.uses_per_year }))
      .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
  };
}

export const SUBSCRIPTION_SELECT =
  "id,plan_id,status,price_pence,provider,customer_id,vehicle_id,started_at,renews_at,last_payment_failed_at,cancelled_at,cancel_reason,last_notice_kind,last_notice_channel,last_notice_outcome,created_at,service_plans(name),customers(name),vehicles(registration,make,model)";

type SubscriptionRow = {
  id: string;
  plan_id: string;
  status: SubscriptionStatus;
  price_pence: number;
  provider: "mock" | "stripe";
  customer_id: string;
  vehicle_id: string;
  started_at: string | null;
  renews_at: string | null;
  last_payment_failed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  last_notice_kind: "confirmation" | "payment_failed" | null;
  last_notice_channel: string | null;
  last_notice_outcome: string | null;
  created_at: string;
  service_plans: One<{ name: string }>;
  customers: One<{ name: string | null }>;
  vehicles: One<{ registration: string | null; make: string | null; model: string | null }>;
};

export function shapeSubscription(row: SubscriptionRow): PlanSubscription {
  const vehicle = one(row.vehicles);
  return {
    id: row.id,
    planId: row.plan_id,
    planName: one(row.service_plans)?.name ?? "Plan",
    status: row.status,
    pricePence: row.price_pence,
    provider: row.provider,
    customerId: row.customer_id,
    customerName: one(row.customers)?.name ?? null,
    vehicleId: row.vehicle_id,
    registration: vehicle?.registration ?? null,
    vehicleName: [vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || null,
    startedAt: row.started_at,
    renewsAt: row.renews_at,
    lastPaymentFailedAt: row.last_payment_failed_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    lastNoticeKind: row.last_notice_kind,
    lastNoticeChannel: row.last_notice_channel,
    lastNoticeOutcome: row.last_notice_outcome,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------------------------
// Admin reads (member's RLS client; members read every plan table, any plan)

export async function loadPlans(client: SupabaseClient, garageId: string): Promise<ServicePlan[]> {
  const { data, error } = await client.from("service_plans").select(PLAN_SELECT).eq("garage_id", garageId).order("status").order("sort").order("name");
  if (error) throw new ServicePlansDataError(error.message);
  return ((data ?? []) as unknown as PlanRow[]).map(shapePlan);
}

export async function loadSubscriptions(
  client: SupabaseClient,
  garageId: string,
  filter: { customerId?: string; vehicleId?: string; live?: boolean; limit?: number } = {},
): Promise<PlanSubscription[]> {
  let query = client.from("customer_plan_subscriptions").select(SUBSCRIPTION_SELECT).eq("garage_id", garageId);
  if (filter.customerId) query = query.eq("customer_id", filter.customerId);
  if (filter.vehicleId) query = query.eq("vehicle_id", filter.vehicleId);
  if (filter.live) query = query.neq("status", "cancelled");
  const { data, error } = await query.order("created_at", { ascending: false }).limit(filter.limit ?? 200);
  if (error) throw new ServicePlansDataError(error.message);
  return ((data ?? []) as unknown as SubscriptionRow[]).map(shapeSubscription);
}

export type InclusionUsage = { serviceId: string; serviceName: string; usesPerYear: number; used: number };

/** This plan year's uses of each included service. */
export async function loadUsage(
  client: SupabaseClient,
  garageId: string,
  subscription: Pick<PlanSubscription, "id" | "startedAt">,
  plan: ServicePlan | null,
  timeZone: string,
  now: Date = new Date(),
): Promise<{ yearStart: string | null; usage: InclusionUsage[] }> {
  if (!plan) return { yearStart: null, usage: [] };
  if (!subscription.startedAt) return { yearStart: null, usage: plan.inclusions.map((inclusion) => ({ ...inclusion, used: 0 })) };
  const yearStart = planYearStart(new Date(subscription.startedAt), now, timeZone).toISOString();
  const { data } = await client
    .from("service_plan_uses")
    .select("service_id,plan_year_start")
    .eq("garage_id", garageId)
    .eq("subscription_id", subscription.id)
    .eq("status", "used");
  const rows = (data ?? []) as Array<{ service_id: string; plan_year_start: string }>;
  // Same instant, give or take the microseconds a Date cannot hold.
  const thisYear = rows.filter((row) => Math.abs(Date.parse(row.plan_year_start) - Date.parse(yearStart)) < 1000);
  return {
    yearStart,
    usage: plan.inclusions.map((inclusion) => ({ ...inclusion, used: thisYear.filter((row) => row.service_id === inclusion.serviceId).length })),
  };
}

/** The booking's plan use (if any) and the car's live plan, for the booking page. */
export async function loadBookingPlan(client: SupabaseClient, garageId: string, bookingId: string, vehicleId: string | null) {
  const [subscriptions, use] = await Promise.all([
    vehicleId ? loadSubscriptions(client, garageId, { vehicleId, live: true, limit: 1 }) : Promise.resolve([]),
    client.from("service_plan_uses").select("id,status,subscription_id").eq("garage_id", garageId).eq("booking_id", bookingId).eq("status", "used").maybeSingle(),
  ]);
  return { subscription: subscriptions[0] ?? null, used: Boolean(use.data) };
}

// ---------------------------------------------------------------------------------------------
// The garage host: plans on offer and sign-up (service role)

/** Active plans for the public /plans page; empty when the garage isn't on Pro. */
export async function loadPublicPlans(garage: PlanGarage): Promise<ServicePlan[]> {
  if (!garageHasFeature(garage, "service_plans")) return [];
  const db = createAdminClient();
  if (!db) return [];
  const { data, error } = await db.from("service_plans").select(PLAN_SELECT).eq("garage_id", garage.id).eq("status", "active").order("sort").order("name");
  if (error) return [];
  return ((data ?? []) as unknown as PlanRow[]).map(shapePlan);
}

/** Whether this deployment and garage can set up Direct Debits now (Pro, a provider, an active account). */
export async function signupReadiness(garage: PlanGarage): Promise<{ ok: true; provider: PaymentsProviderKind; accountRef: string } | { ok: false; reason: "plan_required" | "unavailable" }> {
  if (!garageHasFeature(garage, "service_plans")) return { ok: false, reason: "plan_required" };
  const provider = getPaymentsProvider();
  const db = createAdminClient();
  if (!provider || !db) return { ok: false, reason: "unavailable" };
  const { data } = await db.from("payment_accounts").select("provider,account_ref,status,charges_enabled").eq("garage_id", garage.id).maybeSingle();
  const account = data as { provider?: string; account_ref?: string; status?: string; charges_enabled?: boolean } | null;
  if (!account?.account_ref || account.provider !== provider.kind || account.status !== "active" || !account.charges_enabled) return { ok: false, reason: "unavailable" };
  return { ok: true, provider: provider.kind, accountRef: account.account_ref };
}

export type SignupInput = {
  planId: string;
  customer: { name: string; phone: string; email: string | null; channel: "sms" | "whatsapp" | "email" };
  vehicle: { registration: string; make: string | null; model: string | null };
};

export type SignupStart =
  | { ok: true; subscriptionId: string; next: { kind: "local" } | { kind: "redirect"; url: string } }
  | { ok: false; code: "PLAN_REQUIRED" | "PLAN_NOT_AVAILABLE" | "PAYMENTS_NOT_READY" | "ALREADY_ON_PLAN" | "INVALID_SIGNUP" | "provider" | "failed" };

/** Links the customer and car (start_plan_signup()) and starts the provider's Direct Debit mandate. */
export async function startSignup(garage: Pick<Garage, "id" | "name" | "slug" | "customDomain" | "plan" | "trialEndsAt" | "planChosen">, input: SignupInput): Promise<SignupStart> {
  const ready = await signupReadiness(garage);
  if (!ready.ok) return { ok: false, code: ready.reason === "plan_required" ? "PLAN_REQUIRED" : "PAYMENTS_NOT_READY" };
  const db = createAdminClient()!;
  const { data, error } = await db.rpc("start_plan_signup", {
    p_garage_id: garage.id,
    p_plan_id: input.planId,
    p_customer: { name: input.customer.name, phone: input.customer.phone, email: input.customer.email, channel: input.customer.channel },
    p_vehicle: { registration: input.vehicle.registration, make: input.vehicle.make, model: input.vehicle.model },
    p_provider: ready.provider,
  });
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string; price_pence?: number } | null;
  if (error || !row?.id) {
    const code = /^([A-Z_]+)/.exec(error?.message ?? "")?.[1] ?? "failed";
    log("signup_refused", { code });
    const known = ["PLAN_REQUIRED", "PLAN_NOT_AVAILABLE", "PAYMENTS_NOT_READY", "ALREADY_ON_PLAN", "INVALID_SIGNUP"] as const;
    return { ok: false, code: (known as readonly string[]).includes(code) ? (code as (typeof known)[number]) : "failed" };
  }
  const provider = getPaymentsProvider()!;
  const plan = await db.from("service_plans").select("name").eq("garage_id", garage.id).eq("id", input.planId).maybeSingle();
  const mandate = await provider.startMandate({
    accountRef: ready.accountRef,
    subscriptionId: row.id,
    garageId: garage.id,
    amountPence: row.price_pence ?? 0,
    description: `${(plan.data as { name?: string } | null)?.name ?? "Service plan"}, ${garage.name}`,
    customerEmail: input.customer.email,
    successUrl: garageUrl(garage, "/plans/confirm?done=1"),
    cancelUrl: garageUrl(garage, "/plans/confirm?cancelled=1"),
  });
  if (mandate.kind === "error") {
    log("mandate_not_started", { subscription: row.id });
    return { ok: false, code: "provider" };
  }
  if (mandate.kind === "redirect") {
    await db.rpc("set_plan_subscription_checkout", { p_garage_id: garage.id, p_subscription_id: row.id, p_checkout_ref: mandate.checkoutRef });
    log("mandate_started", { subscription: row.id, provider: provider.kind });
    return { ok: true, subscriptionId: row.id, next: { kind: "redirect", url: mandate.url } };
  }
  log("mandate_started", { subscription: row.id, provider: provider.kind });
  return { ok: true, subscriptionId: row.id, next: { kind: "local" } };
}

export type SignupView = {
  id: string;
  status: SubscriptionStatus;
  provider: "mock" | "stripe";
  checkoutRef: string | null;
  pricePence: number;
  planName: string;
  carName: string | null;
  renewsAt: string | null;
};

/** The sign-up behind the `af_plan` cookie, for the host's garage only. */
export async function loadSignup(garageId: string, subscriptionId: string): Promise<SignupView | null> {
  const db = createAdminClient();
  if (!db) return null;
  const { data } = await db
    .from("customer_plan_subscriptions")
    .select("id,status,provider,checkout_ref,price_pence,renews_at,service_plans(name),vehicles(make,model)")
    .eq("garage_id", garageId)
    .eq("id", subscriptionId)
    .maybeSingle();
  const row = data as { id: string; status: SubscriptionStatus; provider: "mock" | "stripe"; checkout_ref: string | null; price_pence: number; renews_at: string | null; service_plans: One<{ name: string }>; vehicles: One<{ make: string | null; model: string | null }> } | null;
  if (!row) return null;
  const vehicle = one(row.vehicles);
  return {
    id: row.id,
    status: row.status,
    provider: row.provider,
    checkoutRef: row.checkout_ref,
    pricePence: row.price_pence,
    planName: one(row.service_plans)?.name ?? "Service plan",
    carName: [vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || null,
    renewsAt: row.renews_at,
  };
}

// ---------------------------------------------------------------------------------------------
// Status changes (webhook, return from the provider, the mock confirm page)

export type StatusApplied = { ok: true; changed: boolean; status: SubscriptionStatus; notify: PlanNoticeKind | null } | { ok: false; code: string };

export async function applyPlanStatus(input: {
  garageId: string;
  subscriptionId: string;
  provider: PaymentsProviderKind;
  status: PlanSubscriptionStatus | null;
  mandateRef: string | null;
  subscriptionRef: string | null;
  renewsAt: string | null;
  db?: SupabaseClient | null;
  channelFor?: (kind: ChannelKind) => MessageChannel;
}): Promise<StatusApplied> {
  const db = input.db === undefined ? createAdminClient() : input.db;
  if (!db) return { ok: false, code: "unavailable" };
  const { data, error } = await db.rpc("apply_plan_subscription_status", {
    p_garage_id: input.garageId,
    p_subscription_id: input.subscriptionId,
    p_provider: input.provider,
    p_status: input.status,
    p_mandate_ref: input.mandateRef,
    p_subscription_ref: input.subscriptionRef,
    p_renews_at: input.renewsAt,
    p_at: new Date().toISOString(),
  });
  if (error || !data) {
    const code = /^([A-Z_]+)/.exec(error?.message ?? "")?.[1] ?? "failed";
    log("status_failed", { subscription: input.subscriptionId, code });
    return { ok: false, code };
  }
  const result = data as { changed: boolean; status: SubscriptionStatus; notify: PlanNoticeKind | null };
  if (result.notify) await sendPlanNotice({ garageId: input.garageId, subscriptionId: input.subscriptionId, kind: result.notify, db, channelFor: input.channelFor });
  log("status", { subscription: input.subscriptionId, status: result.status, changed: result.changed, notify: result.notify });
  return { ok: true, changed: result.changed, status: result.status, notify: result.notify };
}

/** The mock "sets up" the Direct Debit: active at once, renewing in a month. */
export async function confirmMockMandate(garageId: string, subscriptionId: string): Promise<StatusApplied> {
  const provider = getPaymentsProvider();
  if (provider?.kind !== "mock") return { ok: false, code: "unavailable" };
  const renews = new Date();
  renews.setUTCMonth(renews.getUTCMonth() + 1);
  return applyPlanStatus({
    garageId,
    subscriptionId,
    provider: "mock",
    status: "active",
    mandateRef: `mock_mandate_${randomBytes(8).toString("hex")}`,
    subscriptionRef: `mock_sub_${randomBytes(8).toString("hex")}`,
    renewsAt: renews.toISOString(),
  });
}

/** The customer is back from the provider: apply the mandate now if the webhook has not yet. */
export async function syncMandate(garageId: string, signup: Pick<SignupView, "id" | "status" | "provider" | "checkoutRef">): Promise<boolean> {
  if (signup.status !== "pending_mandate" || !signup.checkoutRef) return false;
  const provider = getPaymentsProvider();
  const db = createAdminClient();
  if (!provider || provider.kind !== signup.provider || !db) return false;
  const account = await db.from("payment_accounts").select("account_ref,provider").eq("garage_id", garageId).maybeSingle();
  const row = account.data as { account_ref?: string; provider?: string } | null;
  if (!row?.account_ref || row.provider !== provider.kind) return false;
  const state = await provider.getMandate({ accountRef: row.account_ref, checkoutRef: signup.checkoutRef });
  if (!state?.status) return false;
  const applied = await applyPlanStatus({ garageId, subscriptionId: signup.id, provider: provider.kind, status: state.status, mandateRef: state.mandateRef, subscriptionRef: state.subscriptionRef, renewsAt: state.renewsAt, db });
  return applied.ok && applied.status === "active";
}

/**
 * A verified provider event about a plan's Direct Debit (called by applyPaymentsEvent(), which has
 * already claimed the event once). The event must come from the garage's own account.
 */
export async function applyPlanEvent(
  event: Extract<PaymentsEvent, { kind: "plan_subscription" }>,
  provider: PaymentsProviderKind,
  db: SupabaseClient,
): Promise<{ outcome: "applied" | "ignored" | "failed"; garageId: string | null }> {
  const account = await db.from("payment_accounts").select("account_ref,provider").eq("garage_id", event.garageId).maybeSingle();
  const row = account.data as { account_ref?: string; provider?: string } | null;
  if (row?.provider !== provider || row.account_ref !== event.accountRef) return { outcome: "ignored", garageId: null };
  const applied = await applyPlanStatus({
    garageId: event.garageId,
    subscriptionId: event.subscriptionId,
    provider,
    status: event.status,
    mandateRef: event.mandateRef,
    subscriptionRef: event.subscriptionRef,
    renewsAt: event.renewsAt,
    db,
  });
  if (applied.ok) return { outcome: "applied", garageId: event.garageId };
  return { outcome: /SUBSCRIPTION_NOT_FOUND|PROVIDER_MISMATCH/.test(applied.code) ? "ignored" : "failed", garageId: null };
}

// ---------------------------------------------------------------------------------------------
// Notices (getChannel; the customer's own channel, STOP respected)

function providerName(channel: MessageChannel) {
  if (channel.mode === "mock") return "mock";
  return channel.kind === "email" ? "resend" : "twilio";
}

export async function sendPlanNotice(input: {
  garageId: string;
  subscriptionId: string;
  kind: PlanNoticeKind;
  db?: SupabaseClient | null;
  channelFor?: (kind: ChannelKind) => MessageChannel;
}): Promise<{ channel: ChannelKind | "none"; outcome: "sent" | "failed" | "opted_out" | "no_contact" }> {
  const db = input.db === undefined ? createAdminClient() : input.db;
  if (!db) return { channel: "none", outcome: "failed" };
  const record = (channel: string, outcome: string) =>
    db.from("customer_plan_subscriptions")
      .update({ last_notice_kind: input.kind, last_notice_at: new Date().toISOString(), last_notice_channel: channel, last_notice_outcome: outcome })
      .eq("garage_id", input.garageId).eq("id", input.subscriptionId);

  const [subscriptionResult, garageResult] = await Promise.all([
    db.from("customer_plan_subscriptions")
      .select("customer_id,price_pence,service_plans(name),vehicles(make,model),customers(name,phone,email,channel,opted_out_at,anonymised_at)")
      .eq("garage_id", input.garageId).eq("id", input.subscriptionId).maybeSingle(),
    db.from("garages").select("name,phone").eq("id", input.garageId).maybeSingle(),
  ]);
  const row = subscriptionResult.data as {
    customer_id: string;
    price_pence: number;
    service_plans: One<{ name: string }>;
    vehicles: One<{ make: string | null; model: string | null }>;
    customers: One<{ name: string | null; phone: string | null; email: string | null; channel: string | null; opted_out_at: string | null; anonymised_at: string | null }>;
  } | null;
  const garage = garageResult.data as { name: string; phone: string | null } | null;
  if (!row || !garage) return { channel: "none", outcome: "failed" };
  const person = one(row.customers);
  const customer: LinkCustomer | null = person && !person.anonymised_at
    ? { name: person.name, phone: person.phone, email: person.email, channel: person.channel, optedOutAt: person.opted_out_at }
    : null;
  const choice = chooseLinkChannel(customer);
  if (choice.channel === "none") {
    await record("none", choice.reason);
    log("notice", { subscription: input.subscriptionId, kind: input.kind, outcome: choice.reason });
    return { channel: "none", outcome: choice.reason };
  }

  const vehicle = one(row.vehicles);
  const message = composePlanNotice({
    kind: input.kind,
    garageName: garage.name,
    garagePhone: garage.phone,
    planName: one(row.service_plans)?.name ?? "service",
    pricePence: row.price_pence,
    carName: [vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || null,
  }, choice.channel);
  const sender = (input.channelFor ?? ((kind: ChannelKind) => getChannel(kind)))(choice.channel);

  const inserted = await db.from("messages").insert({
    garage_id: input.garageId,
    customer_id: row.customer_id,
    channel: choice.channel,
    direction: "outbound",
    to_address: choice.to,
    body: message.body,
    provider: providerName(sender),
    status: "sending",
  }).select("id").maybeSingle();
  const messageId = (inserted.data as { id?: string } | null)?.id ?? null;

  let ok = false;
  try {
    const result = await sender.send({
      garageId: input.garageId,
      to: choice.to,
      body: message.body,
      ...(choice.channel === "email" ? { subject: message.subject, ...(message.html ? { html: message.html } : {}) } : {}),
      idempotencyKey: `service_plan:${input.subscriptionId}:${input.kind}:${new Date().toISOString().slice(0, 10)}`,
    });
    ok = result.ok;
    if (messageId) {
      await db.from("messages").update(result.ok
        ? { status: result.status, provider_msg_id: result.providerMessageId }
        : { status: "failed", error_code: String(result.providerCode ?? result.code).slice(0, 60) }).eq("garage_id", input.garageId).eq("id", messageId);
    }
  } catch {
    if (messageId) await db.from("messages").update({ status: "failed", error_code: "exception" }).eq("garage_id", input.garageId).eq("id", messageId);
  }
  await record(choice.channel, ok ? "sent" : "failed");
  log("notice", { subscription: input.subscriptionId, kind: input.kind, channel: choice.channel, outcome: ok ? "sent" : "failed" });
  return { channel: choice.channel, outcome: ok ? "sent" : "failed" };
}

// ---------------------------------------------------------------------------------------------
// Bookings and staff

export type PlanBookingOutcome = { onPlan: boolean; planName: string | null; recorded: boolean; reason: string | null };

/** After create_booking() in the online flow: records the included use. Never throws, never fails the booking. */
export async function recordPlanBooking(garageId: string, bookingId: string): Promise<PlanBookingOutcome> {
  const none = { onPlan: false, planName: null, recorded: false, reason: null };
  try {
    const db = createAdminClient();
    if (!db) return none;
    const { data, error } = await db.rpc("record_plan_booking", { p_garage_id: garageId, p_booking_id: bookingId });
    if (error || !data) return none;
    const result = data as { on_plan?: boolean; plan_name?: string; recorded?: boolean; reason?: string };
    if (result.on_plan) log("booking", { booking: bookingId, recorded: Boolean(result.recorded), reason: result.reason ?? null });
    return { onPlan: Boolean(result.on_plan), planName: result.plan_name ?? null, recorded: Boolean(result.recorded), reason: result.reason ?? null };
  } catch {
    return none;
  }
}

/**
 * Stops the provider collecting, then records the cancellation (cancel_plan_subscription(), the
 * member's own client: role and garage checked in SQL). Returns an error key or null.
 */
export async function cancelSubscription(client: SupabaseClient, garageId: string, subscriptionId: string, reason: string | null): Promise<string | null> {
  const db = createAdminClient();
  const { data } = await client.from("customer_plan_subscriptions").select("id,status,provider,subscription_ref").eq("garage_id", garageId).eq("id", subscriptionId).maybeSingle();
  const row = data as { id: string; status: SubscriptionStatus; provider: PaymentsProviderKind; subscription_ref: string | null } | null;
  if (!row) return "SUBSCRIPTION_NOT_FOUND";
  if (row.status !== "cancelled" && row.provider === "stripe" && row.subscription_ref) {
    const provider = getPaymentsProvider();
    const account = db ? await db.from("payment_accounts").select("account_ref,provider").eq("garage_id", garageId).maybeSingle() : null;
    const accountRow = account?.data as { account_ref?: string; provider?: string } | null;
    if (!provider || provider.kind !== "stripe" || !accountRow?.account_ref || accountRow.provider !== "stripe") return "provider";
    if (!(await provider.cancelMandate({ accountRef: accountRow.account_ref, subscriptionRef: row.subscription_ref }))) return "provider";
  }
  const { error } = await client.rpc("cancel_plan_subscription", { p_subscription_id: subscriptionId, p_reason: reason });
  if (error) return /^([A-Z_]+)/.exec(error.message ?? "")?.[1] ?? (error.code === "42501" ? "SERVICE_PLANS_FORBIDDEN" : "failed");
  log("cancelled", { subscription: subscriptionId });
  return null;
}
