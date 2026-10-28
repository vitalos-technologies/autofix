"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { notifyBooking } from "@/lib/booking-engine/notify";
import { requireStaffWriter } from "@/lib/admin/staff";
import { featureProblem } from "@/lib/plans/server";
import { auditSetupChange, requireSetupContext } from "@/lib/settings/server";
import { adminUrl } from "@/lib/tenancy/urls";
import { createAdminClient } from "@/lib/supabase/server";
import { parseDepositRule, parsePoundsToPence, MAX_HOLD_MIN, MAX_NO_SHOW_FEE_PENCE, MIN_HOLD_MIN, MIN_PAYMENT_PENCE } from "./amounts";
import { getPaymentsProvider } from "./index";
import { loadPaymentsSetup, sendPaymentLink, type PaymentRow } from "./server";
import { createPayToken } from "./tokens";

// Admin server actions for payments (P5.4). The garage is always the member's selected garage; forms
// carry only the record ids they act on, which the SQL functions check belong to that garage.
// Who may do what (the SQL functions enforce the same):
//   connect / disconnect the account          owners
//   deposit defaults, hold, no-show fee        owners and managers
//   per-service deposits                       owners and managers
//   send pay links, charge no-show fees,
//   cancel a link or waive a deposit           owners, managers and front desk
// Every action needs Pro (`payments`) except disconnecting.

const SETTINGS_PATH = "/app/payments/settings";
const uuid = z.string().uuid();

export type PaymentsFormState = { seq: number; status: "idle" | "saved" | "error"; message?: string; fieldErrors?: Record<string, string> };

function next(previous: PaymentsFormState, state: Omit<PaymentsFormState, "seq">): PaymentsFormState {
  return { seq: previous.seq + 1, ...state };
}

function idFrom(formData: FormData, field: string): string | null {
  const parsed = uuid.safeParse(formData.get(field));
  return parsed.success ? parsed.data.toLowerCase() : null;
}

/** Only our own admin paths are redirect targets. */
function safeReturn(value: FormDataEntryValue | null, fallback: string): string {
  return typeof value === "string" && /^\/app\/[A-Za-z0-9/_#-]*$/.test(value) ? value : fallback;
}

function codeOf(error: { message?: string | null; code?: string | null } | null): string {
  if (!error) return "failed";
  if (error.code === "42501") return "not_allowed";
  const head = (error.message ?? "").split(":")[0]?.trim() ?? "";
  return /^[A-Z_]{3,40}$/.test(head) ? head.toLowerCase() : "failed";
}

const LINK_ROLES = new Set(["owner", "manager", "front_desk"]);

// ---------------------------------------------------------------------------------------------
// Account (owners)

export async function connectPaymentsAction(): Promise<void> {
  const admin = await requireSetupContext(SETTINGS_PATH);
  if (admin.role !== "owner") redirect(`${SETTINGS_PATH}?error=owner_only`);
  if (featureProblem(admin, "payments")) redirect(`${SETTINGS_PATH}?error=plan_required`);
  const provider = getPaymentsProvider();
  if (!provider) redirect(`${SETTINGS_PATH}?error=unavailable`);
  const db = createAdminClient();
  if (!db) redirect(`${SETTINGS_PATH}?error=unavailable`);
  const setup = await loadPaymentsSetup(admin.garage, db);
  const existingRef = setup.account?.provider === provider.kind ? setup.account.account_ref : null;

  const result = await provider.startConnect({
    garage: { id: admin.garage.id, name: admin.garage.name, email: admin.garage.email },
    accountRef: existingRef,
    returnUrl: adminUrl(`${SETTINGS_PATH}/return`),
    refreshUrl: adminUrl(`${SETTINGS_PATH}/return?refresh=1`),
  });
  if (result.kind === "error") redirect(`${SETTINGS_PATH}?error=provider`);
  const account = result.kind === "connected" ? result.account : { accountRef: result.accountRef, status: "pending" as const, chargesEnabled: false };
  const applied = await db.rpc("apply_payment_account", {
    p_garage_id: admin.garage.id,
    p_provider: provider.kind,
    p_account_ref: account.accountRef,
    p_status: account.status,
    p_charges_enabled: account.chargesEnabled,
    p_actor: admin.user.id,
  });
  if (applied.error) redirect(`${SETTINGS_PATH}?error=${codeOf(applied.error) === "plan_required" ? "plan_required" : "save_failed"}`);
  revalidatePath(SETTINGS_PATH);
  if (result.kind === "redirect") redirect(result.url);
  redirect(`${SETTINGS_PATH}?done=connected`);
}

export async function disconnectPaymentsAction(formData: FormData): Promise<void> {
  const admin = await requireSetupContext(SETTINGS_PATH);
  if (admin.role !== "owner") redirect(`${SETTINGS_PATH}?error=owner_only`);
  if (formData.get("confirm") !== "yes") redirect(`${SETTINGS_PATH}?confirm=disconnect`);
  const { error } = await admin.client.rpc("disconnect_payment_account");
  if (error) redirect(`${SETTINGS_PATH}?error=save_failed`);
  revalidatePath(SETTINGS_PATH);
  redirect(`${SETTINGS_PATH}?done=disconnected`);
}

// ---------------------------------------------------------------------------------------------
// Settings (owners and managers)

export async function savePaymentSettingsAction(previous: PaymentsFormState, formData: FormData): Promise<PaymentsFormState> {
  const admin = await requireSetupContext(SETTINGS_PATH);
  if (admin.role !== "owner" && admin.role !== "manager") return next(previous, { status: "error", message: "Only the garage's owners and managers can change this." });
  const locked = featureProblem(admin, "payments");
  if (locked) return next(previous, { status: "error", message: locked });

  const fieldErrors: Record<string, string> = {};
  const depositsEnabled = formData.get("depositsEnabled") === "on";
  const rule = parseDepositRule({ mode: String(formData.get("defaultMode") ?? "none"), amount: String(formData.get("defaultAmount") ?? ""), percent: String(formData.get("defaultPercent") ?? "") }, false);
  if (!rule.ok) fieldErrors[rule.field === "mode" ? "defaultMode" : rule.field === "amount" ? "defaultAmount" : "defaultPercent"] = rule.message;
  const hold = Number(String(formData.get("holdMin") ?? "").trim());
  if (!Number.isInteger(hold) || hold < MIN_HOLD_MIN || hold > MAX_HOLD_MIN) fieldErrors.holdMin = `Enter whole minutes from ${MIN_HOLD_MIN} to ${MAX_HOLD_MIN}.`;
  const feeRaw = String(formData.get("noShowFee") ?? "").trim();
  const fee = feeRaw ? parsePoundsToPence(feeRaw) : null;
  if (feeRaw && (fee === null || fee < MIN_PAYMENT_PENCE || fee > MAX_NO_SHOW_FEE_PENCE)) fieldErrors.noShowFee = "Enter a fee from £1 to £1,000, or leave it empty for no fee.";
  if (depositsEnabled && rule.ok && rule.mode === "none" && formData.get("anyServiceDeposit") !== "yes") {
    fieldErrors.defaultMode = "Choose a default deposit, or set a deposit on a service below.";
  }
  if (Object.keys(fieldErrors).length || !rule.ok) return next(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors });

  const values = {
    garage_id: admin.garage.id,
    deposits_enabled: depositsEnabled,
    default_deposit_mode: rule.mode,
    default_deposit_value: rule.value,
    deposit_hold_min: hold,
    no_show_fee_pence: fee,
    updated_by: admin.user.id,
  };
  const { error } = await admin.client.from("payment_settings").upsert(values, { onConflict: "garage_id" });
  if (error) return next(previous, { status: "error", message: error.code === "42501" ? "You don't have permission to change this." : "The settings could not be saved. Try again." });
  await auditSetupChange(admin, "payments.settings_changed", "payment_settings", admin.garage.id, { deposits_enabled: depositsEnabled, default_deposit_mode: rule.mode, no_show_fee_pence: fee });
  revalidatePath(SETTINGS_PATH);
  revalidatePath("/_site/[garageId]", "layout");
  return next(previous, { status: "saved", message: "Payment settings saved." });
}

export async function saveServiceDepositAction(previous: PaymentsFormState, formData: FormData): Promise<PaymentsFormState> {
  const serviceId = idFrom(formData, "serviceId");
  const admin = await requireSetupContext(serviceId ? `/app/settings/services/${serviceId}` : SETTINGS_PATH);
  if (!serviceId) return next(previous, { status: "error", message: "That service could not be found." });
  if (admin.role !== "owner" && admin.role !== "manager") return next(previous, { status: "error", message: "Only the garage's owners and managers can change this." });
  const locked = featureProblem(admin, "payments");
  if (locked) return next(previous, { status: "error", message: locked });
  const rule = parseDepositRule({ mode: String(formData.get("mode") ?? ""), amount: String(formData.get("amount") ?? ""), percent: String(formData.get("percent") ?? "") }, true);
  if (!rule.ok) return next(previous, { status: "error", message: "Check the deposit.", fieldErrors: { [rule.field]: rule.message } });
  const { error } = await admin.client.rpc("set_service_deposit", { p_service_id: serviceId, p_mode: rule.mode, p_value: rule.value });
  if (error) return next(previous, { status: "error", message: codeOf(error) === "service_not_found" ? "That service has been archived or removed." : "The deposit could not be saved. Try again." });
  revalidatePath(`/app/settings/services/${serviceId}`);
  revalidatePath(SETTINGS_PATH);
  return next(previous, { status: "saved", message: "Deposit saved." });
}

// ---------------------------------------------------------------------------------------------
// Links (owners, managers, front desk)

async function linkWriter(returnTo: string) {
  const admin = await requireStaffWriter(returnTo);
  if (!LINK_ROLES.has(admin.role)) redirect(`${returnTo}?payments=not_allowed#payments`);
  if (featureProblem(admin, "payments")) redirect(`${returnTo}?payments=plan_required#payments`);
  const provider = getPaymentsProvider();
  if (!provider) redirect(`${returnTo}?payments=unavailable#payments`);
  return { admin, provider };
}

/** "Send payment link" on an issued invoice: a link for the balance, sent on the customer's channel. */
export async function sendInvoicePaymentLinkAction(formData: FormData): Promise<void> {
  const invoiceId = idFrom(formData, "invoiceId");
  if (!invoiceId) redirect("/app/invoices");
  const back = `/app/invoices/${invoiceId}`;
  const { admin, provider } = await linkWriter(back);
  const { token, hash } = createPayToken();
  const { data, error } = await admin.client.rpc("create_payment_request", { p_kind: "invoice", p_target_id: invoiceId, p_provider: provider.kind, p_token_hash: hash });
  if (error || !data) redirect(`${back}?payments=${codeOf(error)}#payments`);
  const payment = data as PaymentRow;
  const invoice = await admin.client.from("invoices").select("invoice_number").eq("garage_id", admin.garage.id).eq("id", invoiceId).maybeSingle();
  const number = (invoice.data as { invoice_number?: string | null } | null)?.invoice_number;
  const sent = await sendPaymentLink({ garage: admin.garage, payment, token, what: number ? `invoice ${number}` : "your invoice" });
  revalidatePath(back);
  revalidatePath("/app/payments");
  redirect(`${back}?payments=link_${sent.outcome}#payments`);
}

/** "Charge no-show fee" on a no-show booking. */
export async function chargeNoShowFeeAction(formData: FormData): Promise<void> {
  const bookingId = idFrom(formData, "bookingId");
  if (!bookingId) redirect("/app/bookings");
  const back = `/app/bookings/${bookingId}`;
  const { admin, provider } = await linkWriter(back);
  const { token, hash } = createPayToken();
  const { data, error } = await admin.client.rpc("create_payment_request", { p_kind: "no_show_fee", p_target_id: bookingId, p_provider: provider.kind, p_token_hash: hash });
  if (error || !data) redirect(`${back}?payments=${codeOf(error)}#payments`);
  const payment = data as PaymentRow;
  const booking = await admin.client.from("bookings").select("reference").eq("garage_id", admin.garage.id).eq("id", bookingId).maybeSingle();
  const reference = (booking.data as { reference?: string } | null)?.reference;
  const sent = await sendPaymentLink({ garage: admin.garage, payment, token, what: reference ? `booking ${reference}` : "your booking" });
  revalidatePath(back);
  revalidatePath("/app/payments");
  redirect(`${back}?payments=link_${sent.outcome}#payments`);
}

/** Cancels a pending link, or waives a pending deposit (the booking stands and its confirmation goes now). */
export async function cancelPaymentAction(formData: FormData): Promise<void> {
  const paymentId = idFrom(formData, "paymentId");
  const back = safeReturn(formData.get("returnTo"), "/app/payments");
  const admin = await requireStaffWriter(back);
  if (!LINK_ROLES.has(admin.role)) redirect(`${back}?payments=not_allowed#payments`);
  if (featureProblem(admin, "payments")) redirect(`${back}?payments=plan_required#payments`);
  if (!paymentId) redirect(`${back}?payments=failed#payments`);
  const { data, error } = await admin.client.rpc("cancel_payment_request", { p_payment_id: paymentId });
  if (error || !data) redirect(`${back}?payments=${codeOf(error)}#payments`);
  const payment = data as PaymentRow;
  if (payment.kind === "deposit" && payment.booking_id) {
    await notifyBooking({ type: "created", garageId: admin.garage.id, bookingId: payment.booking_id });
  }
  revalidatePath(back);
  revalidatePath("/app/payments");
  redirect(`${back}?payments=${payment.kind === "deposit" ? "waived" : "cancelled"}#payments`);
}
