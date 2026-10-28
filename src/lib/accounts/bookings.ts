import "server-only";

import { z } from "zod";
import { featureProblem } from "@/lib/plans/server";
import type { AdminContext } from "@/lib/tenancy/admin";
import { accountErrorMessage, cleanPoNumber } from "./view";

// P5.7: fleet bookings. The staff booking form may name a business account (and PO number). The
// booking itself is still made by create_booking() through the staff path; these two steps sit
// either side of it: checkBookingAccount() before (so a missing PO or a car on another account
// stops the booking), chargeBookingToAccount() after (set_booking_account(), which never touches
// create_booking()).

export type BookingAccountChoice = { accountId: string; poNumber: string | null };

export type BookingAccountCheck =
  | { ok: true; value: BookingAccountChoice | null }
  | { ok: false; message: string; fieldErrors: Record<string, string> };

/** Reads `accountId` and `poNumber` from the staff booking form and checks them against the selected garage. */
export async function checkBookingAccount(
  admin: Pick<AdminContext, "client" | "garage">,
  input: { accountId: unknown; poNumber: unknown; registration: string },
): Promise<BookingAccountCheck> {
  if (!input.accountId) return { ok: true, value: null };
  const id = z.string().uuid().safeParse(input.accountId);
  if (!id.success) return { ok: false, message: "Choose an account from the list.", fieldErrors: { accountId: "Choose an account from the list" } };
  const plan = featureProblem(admin, "fleet_accounts");
  if (plan) return { ok: false, message: plan, fieldErrors: { accountId: "Accounts are on Pro" } };
  const po = cleanPoNumber(input.poNumber);
  if (!po.ok) return { ok: false, message: po.message, fieldErrors: { poNumber: po.message } };

  const { data: account, error } = await admin.client
    .from("business_accounts")
    .select("id,po_required")
    .eq("garage_id", admin.garage.id)
    .eq("id", id.data)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !account) return { ok: false, message: "That account could not be found.", fieldErrors: { accountId: "Choose an account from the list" } };
  if (account.po_required && !po.value) {
    return { ok: false, message: "This account needs a PO number on every booking.", fieldErrors: { poNumber: "Enter the PO number" } };
  }

  // A car already on another account can't be booked against this one.
  const { data: vehicle } = await admin.client
    .from("vehicles")
    .select("id,business_account_vehicles(account_id)")
    .eq("garage_id", admin.garage.id)
    .eq("registration", input.registration)
    .maybeSingle();
  const links = (vehicle as { business_account_vehicles?: { account_id: string } | Array<{ account_id: string }> | null } | null)?.business_account_vehicles;
  const linked = Array.isArray(links) ? links[0] : links;
  if (linked && linked.account_id !== id.data) {
    const message = accountErrorMessage({ message: "VEHICLE_ON_OTHER_ACCOUNT" });
    return { ok: false, message, fieldErrors: { registration: "This car is on another account" } };
  }
  return { ok: true, value: { accountId: id.data, poNumber: po.value } };
}

/** Charges a booking just made to the account (set_booking_account()). False when that failed: the booking stands. */
export async function chargeBookingToAccount(admin: Pick<AdminContext, "client">, bookingId: string, choice: BookingAccountChoice): Promise<boolean> {
  const { error } = await admin.client.rpc("set_booking_account", { p_booking_id: bookingId, p_account_id: choice.accountId, p_po_number: choice.poNumber });
  return !error;
}
