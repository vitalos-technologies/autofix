import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyBooking } from "@/lib/booking-engine/notify";
import { clearSlotCache } from "@/lib/booking-engine/slots";
import { getChannel, type ChannelKind, type MessageChannel } from "@/lib/messaging/channel";
import { garageHasFeature } from "@/lib/plans/server";
import { applyPlanEvent } from "@/lib/service-plans/server";
import { createAdminClient } from "@/lib/supabase/server";
import type { Garage } from "@/lib/tenancy/garage";
import { garageUrl } from "@/lib/tenancy/urls";
import type { DefaultDepositMode, PaymentAttention, PaymentKind, PaymentStatus } from "./amounts";
import { getPaymentsProvider, getPaymentsReadiness, type PaymentsReadiness } from "./index";
import { chooseLinkChannel, composeLinkMessage, type LinkCustomer } from "./messages";
import type { PaymentsEvent, PaymentsProvider, PaymentsProviderKind } from "./provider";
import { createPayToken, hashPayToken } from "./tokens";

// Payments on the server (P5.4). Everything here uses the service role and names the garage
// explicitly: the garage always comes from the request host (public pages) or the member's selected
// garage (admin), never from a form or query string. Logs carry ids, kinds and outcomes only.

type PlanGarage = Pick<Garage, "id" | "plan" | "trialEndsAt" | "planChosen">;

export type PaymentAccountRow = {
  provider: PaymentsProviderKind;
  account_ref: string;
  status: "pending" | "active" | "restricted" | "disconnected";
  charges_enabled: boolean;
  connected_at: string | null;
  disconnected_at: string | null;
};

export type PaymentSettingsRow = {
  deposits_enabled: boolean;
  default_deposit_mode: DefaultDepositMode;
  default_deposit_value: number | null;
  deposit_hold_min: number;
  no_show_fee_pence: number | null;
};

export const PAYMENT_COLUMNS =
  "id,kind,status,amount_pence,amount_paid_pence,description,booking_id,invoice_id,customer_id,expires_at,provider,checkout_ref,paid_at,attention,cancelled_reason,notified_at,notify_channel,notify_outcome,created_at";

export type PaymentRow = {
  id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount_pence: number;
  amount_paid_pence: number | null;
  description: string;
  booking_id: string | null;
  invoice_id: string | null;
  customer_id: string | null;
  expires_at: string;
  provider: PaymentsProviderKind;
  checkout_ref: string | null;
  paid_at: string | null;
  attention: PaymentAttention | null;
  cancelled_reason: string | null;
  notified_at: string | null;
  notify_channel: "sms" | "whatsapp" | "email" | "none" | null;
  notify_outcome: string | null;
  created_at: string;
};

export type PaymentsSetup = {
  readiness: PaymentsReadiness;
  provider: PaymentsProvider | null;
  account: PaymentAccountRow | null;
  settings: PaymentSettingsRow | null;
  hasFeature: boolean;
  /** Pro, a provider on this deployment, and an active account for that provider. */
  active: boolean;
};

function log(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}) {
  console.info(JSON.stringify({ scope: "payments", event, ...fields }));
}

export function accountUsable(account: PaymentAccountRow | null, provider: PaymentsProvider | null): boolean {
  return Boolean(account && provider && account.provider === provider.kind && account.status === "active" && account.charges_enabled);
}

/** The garage's account and settings, the provider and whether payments can be taken now. */
export async function loadPaymentsSetup(garage: PlanGarage, db: SupabaseClient | null = createAdminClient()): Promise<PaymentsSetup> {
  const readiness = getPaymentsReadiness();
  const provider = getPaymentsProvider();
  const hasFeature = garageHasFeature(garage, "payments");
  if (!db) return { readiness, provider, account: null, settings: null, hasFeature, active: false };
  const [account, settings] = await Promise.all([
    db.from("payment_accounts").select("provider,account_ref,status,charges_enabled,connected_at,disconnected_at").eq("garage_id", garage.id).maybeSingle(),
    db.from("payment_settings").select("deposits_enabled,default_deposit_mode,default_deposit_value,deposit_hold_min,no_show_fee_pence").eq("garage_id", garage.id).maybeSingle(),
  ]);
  const accountRow = (account.data ?? null) as PaymentAccountRow | null;
  const settingsRow = (settings.data ?? null) as PaymentSettingsRow | null;
  return { readiness, provider, account: accountRow, settings: settingsRow, hasFeature, active: hasFeature && accountUsable(accountRow, provider) };
}

/**
 * After the provider's onboarding: reads the garage's stored account from the provider and stores its
 * state (the owner is the actor, so it needs Pro). Returns the settings page's flash query.
 */
export async function refreshConnectedAccount(garage: PlanGarage, ownerId: string): Promise<string> {
  const provider = getPaymentsProvider();
  const db = createAdminClient();
  if (!provider || !db) return "?error=unavailable";
  const setup = await loadPaymentsSetup(garage, db);
  if (!setup.hasFeature) return "?error=plan_required";
  const account = setup.account;
  if (!account || account.provider !== provider.kind || account.status === "disconnected") return "";
  const state = await provider.getAccount(account.account_ref);
  if (!state) return "?error=provider";
  const applied = await db.rpc("apply_payment_account", {
    p_garage_id: garage.id,
    p_provider: provider.kind,
    p_account_ref: state.accountRef,
    p_status: state.status,
    p_charges_enabled: state.chargesEnabled,
    p_actor: ownerId,
  });
  if (applied.error) return "?error=save_failed";
  return state.status === "active" ? "?done=connected" : "?done=pending";
}

// ---------------------------------------------------------------------------------------------
// Deposits (public booking flow on the garage host)

export type DepositQuote = { amountPence: number; holdMin: number; provider: PaymentsProviderKind };

/** The deposit this service needs at this garage now, or null (Essentials, not connected, none set). */
export async function depositQuote(garage: PlanGarage, serviceId: string): Promise<DepositQuote | null> {
  try {
    const db = createAdminClient();
    if (!db) return null;
    const setup = await loadPaymentsSetup(garage, db);
    if (!setup.active || !setup.provider || !setup.settings?.deposits_enabled) return null;
    const { data, error } = await db.rpc("payment_deposit_amount", { p_garage_id: garage.id, p_service_id: serviceId });
    if (error || typeof data !== "number") return null;
    return { amountPence: data, holdMin: setup.settings.deposit_hold_min, provider: setup.provider.kind };
  } catch {
    return null;
  }
}

/**
 * The pending deposit for a booking create_booking() just made, with a new pay token (a replay
 * rotates the token of the same deposit). Null when no deposit applies after all.
 */
export async function startDeposit(garage: Pick<Garage, "id">, bookingId: string, provider: PaymentsProviderKind): Promise<{ token: string; paymentId: string; status: PaymentStatus } | null> {
  const db = createAdminClient();
  if (!db) return null;
  const { token, hash } = createPayToken();
  const { data, error } = await db.rpc("create_deposit_payment", { p_garage_id: garage.id, p_booking_id: bookingId, p_provider: provider, p_token_hash: hash });
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string | null; status?: string } | null;
  if (error || !row?.id) {
    log("deposit_not_started", { outcome: error ? "error" : "none" });
    return null;
  }
  log("deposit_started", { payment: row.id });
  return { token, paymentId: row.id, status: (row.status ?? "pending") as PaymentStatus };
}

type ExpiredRow = { payment_id: string; garage_id: string; booking_id: string | null; kind: string; provider: string; checkout_ref: string | null; booking_released: boolean };

/**
 * Expires pending payments past their time (unpaid deposits release their bookings). For one garage
 * (the booking flow and admin pages call this before showing times) or all (the job). Closes the
 * provider's open checkout for each. Never throws; returns how many expired.
 */
export async function releaseExpiredDeposits(garageId: string | null = null, now: Date = new Date(), db: SupabaseClient | null = createAdminClient()): Promise<number> {
  if (!db) return 0;
  try {
    const { data, error } = await db.rpc("expire_pending_deposits", { p_now: now.toISOString(), p_garage_id: garageId });
    if (error || !Array.isArray(data)) return 0;
    const rows = data as ExpiredRow[];
    const provider = getPaymentsProvider();
    const accounts = new Map<string, string | null>();
    for (const row of rows) {
      if (row.booking_released) clearSlotCache(row.garage_id);
      if (!row.checkout_ref || !provider || provider.kind !== row.provider) continue;
      if (!accounts.has(row.garage_id)) {
        const account = await db.from("payment_accounts").select("account_ref,provider").eq("garage_id", row.garage_id).maybeSingle();
        const ref = (account.data as { account_ref?: string; provider?: string } | null);
        accounts.set(row.garage_id, ref?.provider === provider.kind ? (ref.account_ref ?? null) : null);
      }
      const accountRef = accounts.get(row.garage_id);
      if (accountRef) await provider.cancelCheckout({ accountRef, checkoutRef: row.checkout_ref });
    }
    if (rows.length) log("expired", { count: rows.length, released: rows.filter((row) => row.booking_released).length });
    return rows.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// The pay page

export type PayPagePayment = PaymentRow & {
  booking: { reference: string; startsAt: string; serviceName: string | null; status: string } | null;
  invoiceNumber: string | null;
};

/** The payment behind a pay token, for the host's garage only. */
export async function loadPaymentByToken(garageId: string, token: string): Promise<PayPagePayment | null> {
  const db = createAdminClient();
  if (!db) return null;
  const { data, error } = await db.from("payments").select(PAYMENT_COLUMNS).eq("garage_id", garageId).eq("token_hash", hashPayToken(token)).maybeSingle();
  if (error || !data) return null;
  const payment = data as PaymentRow;
  let booking: PayPagePayment["booking"] = null;
  let invoiceNumber: string | null = null;
  if (payment.booking_id) {
    const result = await db.from("bookings").select("reference,starts_at,status,service:services(name)").eq("garage_id", garageId).eq("id", payment.booking_id).maybeSingle();
    const row = result.data as { reference: string; starts_at: string; status: string; service: { name?: string } | { name?: string }[] | null } | null;
    if (row) {
      const service = Array.isArray(row.service) ? row.service[0] : row.service;
      booking = { reference: row.reference, startsAt: row.starts_at, status: row.status, serviceName: service?.name ?? null };
    }
  }
  if (payment.invoice_id) {
    const result = await db.from("invoices").select("invoice_number").eq("garage_id", garageId).eq("id", payment.invoice_id).maybeSingle();
    invoiceNumber = (result.data as { invoice_number?: string | null } | null)?.invoice_number ?? null;
  }
  return { ...payment, booking, invoiceNumber };
}

export type PaidOutcome = { ok: true; already: boolean; attention: string | null; kind: PaymentKind } | { ok: false; code: string };

/**
 * Marks a payment paid (once) and does what follows: a deposit paid in time sends the booking
 * confirmation the booking flow held back. Called by the signed webhook, the customer's return from
 * the provider and the mock pay page.
 */
export async function markPaymentPaid(input: {
  garageId: string;
  paymentId: string;
  provider: PaymentsProviderKind;
  providerPaymentRef: string | null;
  amountPence: number | null;
  db?: SupabaseClient | null;
}): Promise<PaidOutcome> {
  const db = input.db === undefined ? createAdminClient() : input.db;
  if (!db) return { ok: false, code: "unavailable" };
  const { data, error } = await db.rpc("apply_payment_paid", {
    p_garage_id: input.garageId,
    p_payment_id: input.paymentId,
    p_provider: input.provider,
    p_provider_payment_ref: input.providerPaymentRef,
    p_amount_pence: input.amountPence,
    p_paid_at: new Date().toISOString(),
  });
  if (error || !data) {
    log("paid_failed", { payment: input.paymentId, code: error?.message?.split(":")[0] ?? "unknown" });
    return { ok: false, code: error?.message?.split(":")[0] ?? "failed" };
  }
  const result = data as { kind: PaymentKind; already: boolean; attention: string | null; booking_id: string | null };
  if (!result.already && result.kind === "deposit" && !result.attention && result.booking_id) {
    await notifyBooking({ type: "created", garageId: input.garageId, bookingId: result.booking_id });
  }
  log("paid", { payment: input.paymentId, kind: result.kind, already: result.already, attention: result.attention });
  return { ok: true, already: result.already, attention: result.attention, kind: result.kind };
}

/** The customer is back from the provider: if the checkout is paid, apply it now (the webhook may lag). */
export async function syncCheckout(garageId: string, payment: Pick<PaymentRow, "id" | "status" | "provider" | "checkout_ref">): Promise<boolean> {
  if (payment.status !== "pending" || !payment.checkout_ref) return false;
  const provider = getPaymentsProvider();
  if (!provider || provider.kind !== payment.provider) return false;
  const db = createAdminClient();
  if (!db) return false;
  const account = await db.from("payment_accounts").select("account_ref,provider").eq("garage_id", garageId).maybeSingle();
  const row = account.data as { account_ref?: string; provider?: string } | null;
  if (!row?.account_ref || row.provider !== provider.kind) return false;
  const state = await provider.getCheckout({ accountRef: row.account_ref, checkoutRef: payment.checkout_ref });
  if (!state?.paid) return false;
  const outcome = await markPaymentPaid({ garageId, paymentId: payment.id, provider: provider.kind, providerPaymentRef: state.providerPaymentRef, amountPence: state.amountPence, db });
  return outcome.ok;
}

// ---------------------------------------------------------------------------------------------
// Webhooks

export type WebhookOutcome = "applied" | "duplicate" | "ignored" | "unavailable" | "failed";

/** Applies a verified provider event once (payment_webhook_events). */
export async function applyPaymentsEvent(event: PaymentsEvent, provider: PaymentsProviderKind): Promise<WebhookOutcome> {
  const db = createAdminClient();
  if (!db) return "unavailable";
  const claimed = await db.rpc("claim_payment_webhook_event", { p_event_id: event.eventId, p_provider: provider, p_type: event.type });
  if (claimed.error) return "failed";
  if (claimed.data !== true) return "duplicate";
  const finish = (garageId: string | null, outcome: WebhookOutcome) =>
    db.rpc("finish_payment_webhook_event", { p_event_id: event.eventId, p_garage_id: garageId, p_outcome: outcome });

  let outcome: WebhookOutcome = "ignored";
  let garageId: string | null = null;
  if (event.kind === "paid") {
    // The money must have landed on this garage's own account.
    const account = await db.from("payment_accounts").select("account_ref,provider").eq("garage_id", event.garageId).maybeSingle();
    const row = account.data as { account_ref?: string; provider?: string } | null;
    if (row?.provider === provider && row.account_ref === event.accountRef) {
      const paid = await markPaymentPaid({ garageId: event.garageId, paymentId: event.paymentId, provider, providerPaymentRef: event.providerPaymentRef, amountPence: event.amountPence, db });
      outcome = paid.ok ? "applied" : paid.code === "PAYMENT_NOT_FOUND" ? "ignored" : "failed";
      garageId = paid.ok ? event.garageId : null;
    }
  } else if (event.kind === "account") {
    const applied = await db.rpc("apply_payment_account", {
      p_garage_id: event.garageId,
      p_provider: provider,
      p_account_ref: event.account.accountRef,
      p_status: event.account.status,
      p_charges_enabled: event.account.chargesEnabled,
      p_actor: null,
    });
    outcome = applied.error ? (/ACCOUNT_NOT_FOUND|GARAGE_NOT_FOUND/.test(applied.error.message ?? "") ? "ignored" : "failed") : "applied";
    garageId = outcome === "applied" ? event.garageId : null;
  } else if (event.kind === "plan_subscription") {
    // P5.11: a service plan's Direct Debit (src/lib/service-plans/server.ts).
    ({ outcome, garageId } = await applyPlanEvent(event, provider, db));
  }
  if (outcome !== "failed") await finish(garageId, outcome);
  log("webhook", { provider, type: event.type, outcome });
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Payment links (staff)

export type LinkSendOutcome = { channel: ChannelKind | "none"; outcome: "sent" | "failed" | "opted_out" | "no_contact" };

function providerName(channel: MessageChannel) {
  if (channel.mode === "mock") return "mock";
  return channel.kind === "email" ? "resend" : "twilio";
}

/**
 * Sends a pay link to the customer on their own channel (texts honour STOP; email is the fallback)
 * and records the outcome on the payment (and texts in `messages`, so they show in the inbox).
 */
export async function sendPaymentLink(input: {
  garage: Pick<Garage, "id" | "name" | "slug" | "customDomain">;
  payment: Pick<PaymentRow, "id" | "kind" | "amount_pence" | "customer_id" | "booking_id">;
  token: string;
  what: string;
  channelFor?: (kind: ChannelKind) => MessageChannel;
}): Promise<LinkSendOutcome> {
  const db = createAdminClient();
  if (!db) return { channel: "none", outcome: "failed" };
  const record = (channel: string, outcome: string) =>
    db.from("payments").update({ notified_at: new Date().toISOString(), notify_channel: channel, notify_outcome: outcome })
      .eq("garage_id", input.garage.id).eq("id", input.payment.id);

  let customer: LinkCustomer | null = null;
  if (input.payment.customer_id) {
    const { data } = await db.from("customers").select("name,phone,email,channel,opted_out_at,anonymised_at").eq("garage_id", input.garage.id).eq("id", input.payment.customer_id).maybeSingle();
    const row = data as { name: string | null; phone: string | null; email: string | null; channel: string | null; opted_out_at: string | null; anonymised_at: string | null } | null;
    if (row && !row.anonymised_at) customer = { name: row.name, phone: row.phone, email: row.email, channel: row.channel, optedOutAt: row.opted_out_at };
  }
  const choice = chooseLinkChannel(customer);
  if (choice.channel === "none") {
    await record("none", choice.reason);
    return { channel: "none", outcome: choice.reason };
  }

  const link = garageUrl(input.garage, `/pay/${input.token}`);
  const message = composeLinkMessage({ kind: input.payment.kind, garageName: input.garage.name, amountPence: input.payment.amount_pence, what: input.what, link }, choice.channel);
  const sender = (input.channelFor ?? ((kind: ChannelKind) => getChannel(kind)))(choice.channel);

  let messageId: string | null = null;
  const inserted = await db.from("messages").insert({
    garage_id: input.garage.id,
    customer_id: input.payment.customer_id,
    booking_id: input.payment.booking_id,
    channel: choice.channel,
    direction: "outbound",
    to_address: choice.to,
    body: message.body,
    provider: providerName(sender),
    status: "sending",
  }).select("id").maybeSingle();
  messageId = (inserted.data as { id?: string } | null)?.id ?? null;

  let ok = false;
  try {
    const result = await sender.send({
      garageId: input.garage.id,
      to: choice.to,
      body: message.body,
      ...(choice.channel === "email" ? { subject: message.subject, ...(message.html ? { html: message.html } : {}) } : {}),
      idempotencyKey: `payment_link:${input.payment.id}:${hashPayToken(input.token).slice(0, 12)}`,
    });
    ok = result.ok;
    if (messageId) {
      await db.from("messages").update(result.ok
        ? { status: result.status, provider_msg_id: result.providerMessageId }
        : { status: "failed", error_code: String(result.providerCode ?? result.code).slice(0, 60) }).eq("garage_id", input.garage.id).eq("id", messageId);
    }
  } catch {
    if (messageId) await db.from("messages").update({ status: "failed", error_code: "exception" }).eq("garage_id", input.garage.id).eq("id", messageId);
  }
  await record(choice.channel, ok ? "sent" : "failed");
  log("link_sent", { payment: input.payment.id, channel: choice.channel, outcome: ok ? "sent" : "failed" });
  return { channel: choice.channel, outcome: ok ? "sent" : "failed" };
}
