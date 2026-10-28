"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaffWriter } from "@/lib/admin/staff";
import { featureProblem } from "@/lib/plans/server";
import type { AdminContext } from "@/lib/tenancy/admin";
import { cancelSubscription } from "./server";
import { parsePlanForm, planErrorCode, planPayload, safePlanReturn, withPlanFlash } from "./view";

// Admin server actions for customer service plans (P5.11). The garage is always the member's
// selected garage; forms carry only the ids they act on, which the SQL functions check belong to that
// garage. MFA as other staff writes (`requireStaffWriter`). Who may do what (SQL enforces the same):
//   create, edit, archive and restore plans          owners and managers (Pro)
//   cancel a customer's plan                         owners, managers and front desk (any plan, A380)
//   use / give back an included service on a booking any member (Pro)
//   apply plan benefits to a draft invoice           members with invoice rights (Pro)
// Redirects carry a flash key only: never a registration or customer detail.

const uuid = z.string().uuid();
const PAGE = "/app/service-plans";

function idFrom(formData: FormData, field: string): string | null {
  const parsed = uuid.safeParse(formData.get(field));
  return parsed.success ? parsed.data.toLowerCase() : null;
}

function done(returnTo: string, key: string): never {
  redirect(withPlanFlash(returnTo, "done", key));
}

function fail(returnTo: string, key: string): never {
  redirect(withPlanFlash(returnTo, "error", key));
}

async function staff(formData: FormData, { pro = true }: { pro?: boolean } = {}): Promise<{ admin: AdminContext; returnTo: string }> {
  const returnTo = safePlanReturn(formData.get("returnTo"));
  const admin = await requireStaffWriter(returnTo);
  if (pro && featureProblem(admin, "service_plans")) fail(returnTo, "PLAN_REQUIRED");
  return { admin, returnTo };
}

function refresh(returnTo: string) {
  revalidatePath(PAGE);
  if (returnTo !== PAGE) revalidatePath(returnTo);
}

// ---------------------------------------------------------------------------------------------
// Plans (owners and managers)

export async function savePlanAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  if (admin.role !== "owner" && admin.role !== "manager") fail(returnTo, "SERVICE_PLANS_FORBIDDEN");
  const planId = formData.get("planId") ? idFrom(formData, "planId") : null;
  if (formData.get("planId") && !planId) fail(returnTo, "SERVICE_PLAN_NOT_FOUND");
  const { data: services } = await admin.client.from("services").select("id").eq("garage_id", admin.garage.id).is("deleted_at", null);
  const parsed = parsePlanForm(formData, ((services ?? []) as { id: string }[]).map((service) => service.id));
  if (!parsed.ok) fail(returnTo, "bad_plan");
  const { error } = await admin.client.rpc("save_service_plan", { p_plan_id: planId, p_payload: planPayload(parsed.value) });
  if (error) fail(returnTo, planErrorCode(error));
  refresh(returnTo);
  done(returnTo, planId ? "plan_saved" : "plan_added");
}

export async function setPlanStatusAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const planId = idFrom(formData, "planId");
  const status = formData.get("status") === "archived" ? "archived" : "active";
  if (!planId) fail(returnTo, "SERVICE_PLAN_NOT_FOUND");
  const { error } = await admin.client.rpc("set_service_plan_status", { p_plan_id: planId, p_status: status });
  if (error) fail(returnTo, planErrorCode(error));
  refresh(returnTo);
  done(returnTo, status === "archived" ? "plan_archived" : "plan_restored");
}

// ---------------------------------------------------------------------------------------------
// Customers' plans

/** Cancels a car's plan and stops its Direct Debit. Not plan gated: a downgraded garage can stop collecting. */
export async function cancelPlanSubscriptionAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData, { pro: false });
  const subscriptionId = idFrom(formData, "subscriptionId");
  if (!subscriptionId) fail(returnTo, "SUBSCRIPTION_NOT_FOUND");
  const reason = typeof formData.get("reason") === "string" ? String(formData.get("reason")).trim().slice(0, 300) || null : null;
  const problem = await cancelSubscription(admin.client, admin.garage.id, subscriptionId, reason);
  if (problem) fail(returnTo, problem);
  refresh(returnTo);
  done(returnTo, "cancelled");
}

export async function useBenefitAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const bookingId = idFrom(formData, "bookingId");
  if (!bookingId) fail(returnTo, "BOOKING_NOT_FOUND");
  const { data, error } = await admin.client.rpc("use_plan_benefit", { p_booking_id: bookingId });
  if (error) fail(returnTo, planErrorCode(error));
  const result = data as { recorded?: boolean; already?: boolean } | null;
  refresh(returnTo);
  done(returnTo, result?.recorded || result?.already ? "benefit_used" : "benefit_none");
}

export async function releaseBenefitAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const bookingId = idFrom(formData, "bookingId");
  if (!bookingId) fail(returnTo, "BOOKING_NOT_FOUND");
  const { error } = await admin.client.rpc("release_plan_benefit", { p_booking_id: bookingId });
  if (error) fail(returnTo, planErrorCode(error));
  refresh(returnTo);
  done(returnTo, "benefit_released");
}

/** Puts the plan's benefits on a draft invoice through save_invoice_draft() (apply_service_plan_to_invoice()). */
export async function applyPlanToInvoiceAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const invoiceId = idFrom(formData, "invoiceId");
  if (!invoiceId) fail(returnTo, "INVOICE_NOT_FOUND");
  const { error } = await admin.client.rpc("apply_service_plan_to_invoice", { p_invoice_id: invoiceId });
  if (error) fail(returnTo, planErrorCode(error));
  revalidatePath("/app/invoices");
  refresh(returnTo);
  done(returnTo, "invoice_applied");
}
