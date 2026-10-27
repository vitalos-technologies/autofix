import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { toE164UK } from "@/lib/messaging/phone";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/server";
import type { Garage } from "@/lib/tenancy/garage";
import { fillGarageName, UNSUBSCRIBE_COPY } from "./copy";
import { verifyUnsubscribeToken } from "./unsubscribe-token";

// The unsubscribe page (P4.9). The garage is always the request host's; the
// customer comes from a signed link or, on the form, from the number typed in.
// Writes go through opt_out_customer()/resume_customer_reminders() with the
// service role, scoped to that garage, and each change is written to the
// garage's admin_audit_log in the same transaction. Nothing here logs the
// number or the customer.

export type UnsubscribeGarage = Pick<Garage, "id" | "name">;

export type LinkOptOutResult = { status: "done"; changed: boolean } | { status: "invalid_link" } | { status: "unavailable" };
export type ResumeResult = { status: "resumed"; changed: boolean } | { status: "invalid_link" } | { status: "unavailable" };
export type FormOptOutResult = { status: "done" } | { status: "invalid_phone" } | { status: "rate_limited" } | { status: "unavailable" };

/** Per IP and per garage, for the form only (signed links need no limit). */
export const UNSUBSCRIBE_FORM_LIMITS = { perIp: { limit: 5, windowSeconds: 600 }, perGarage: { limit: 100, windowSeconds: 600 } } as const;

type OptOutRow = { matched?: boolean; changed?: boolean };

function client(override: SupabaseClient | null | undefined) {
  return override === undefined ? createAdminClient() : override;
}

/** Opens a signed link: records the opt-out straight away (idempotent). */
export async function optOutWithToken(garage: UnsubscribeGarage, token: string, options: { client?: SupabaseClient | null } = {}): Promise<LinkOptOutResult> {
  const customerId = verifyUnsubscribeToken(garage.id, token);
  if (!customerId) return { status: "invalid_link" };
  const admin = client(options.client);
  if (!admin) return { status: "unavailable" };
  const { data, error } = await admin.rpc("opt_out_customer", { p_garage_id: garage.id, p_customer_id: customerId, p_phone: null, p_source: "unsubscribe_link" });
  if (error) return { status: "unavailable" };
  // A customer removed since the link was sent gets no reminders either way.
  return { status: "done", changed: Boolean((data as OptOutRow | null)?.changed) };
}

/** "Turn reminders back on" from a signed link: clears the opt-out and stores the shown wording as consent. */
export async function resumeWithToken(garage: UnsubscribeGarage, token: string, options: { client?: SupabaseClient | null } = {}): Promise<ResumeResult> {
  const customerId = verifyUnsubscribeToken(garage.id, token);
  if (!customerId) return { status: "invalid_link" };
  const admin = client(options.client);
  if (!admin) return { status: "unavailable" };
  const { data, error } = await admin.rpc("resume_customer_reminders", {
    p_garage_id: garage.id,
    p_customer_id: customerId,
    p_consent_text: fillGarageName(UNSUBSCRIBE_COPY.resumed, garage.name),
  });
  if (error) return { status: "unavailable" };
  return { status: "resumed", changed: Boolean((data as OptOutRow | null)?.changed) };
}

/**
 * The form without a link. Rate limited per IP and per garage; the answer is
 * the same whether or not the number belongs to a customer.
 */
export async function optOutByPhone(
  garage: UnsubscribeGarage,
  rawPhone: string,
  ip: string,
  options: { client?: SupabaseClient | null; rateLimit?: typeof consumeRateLimit } = {},
): Promise<FormOptOutResult> {
  const limit = options.rateLimit ?? consumeRateLimit;
  const { perIp, perGarage } = UNSUBSCRIBE_FORM_LIMITS;
  if (!(await limit(ip, "unsubscribe_ip", perIp.limit, perIp.windowSeconds))) return { status: "rate_limited" };
  if (!(await limit(garage.id, "unsubscribe_garage", perGarage.limit, perGarage.windowSeconds))) return { status: "rate_limited" };
  const phone = toE164UK(rawPhone);
  if (!phone) return { status: "invalid_phone" };
  const admin = client(options.client);
  if (!admin) return { status: "unavailable" };
  const { error } = await admin.rpc("opt_out_customer", { p_garage_id: garage.id, p_customer_id: null, p_phone: phone, p_source: "unsubscribe_form" });
  return error ? { status: "unavailable" } : { status: "done" };
}
