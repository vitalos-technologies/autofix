"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaffWriter } from "@/lib/admin/staff";
import { courtesyErrorCode, parseCarForm, parseCollectionForm, parseLoanReading, parseLoanWindow, safeCourtesyReturn, withFlash } from "@/lib/courtesy/view";
import { garageHasFeature } from "@/lib/plans/server";
import { auditSetupChange, roleAllows } from "@/lib/settings/server";
import type { AdminContext } from "@/lib/tenancy/admin";

// P5.8 courtesy cars (Pro, `courtesy_cars`). Every action: a signed-in member with MFA done
// (`requireStaffWriter`), the selected garage only (never a garage id from the form), the plan
// checked here and again in SQL (RLS write policies, `courtesy_actor_garage()`). Loans, requests and
// van legs change only through the SQL functions. Redirects carry a flash key and nothing else:
// never a registration.

const PAGE = "/app/courtesy-cars";
const FEATURE = "courtesy_cars" as const;
const uuid = z.string().uuid();

function idFrom(formData: FormData, name: string): string | null {
  const parsed = uuid.safeParse(formData.get(name));
  return parsed.success ? parsed.data.toLowerCase() : null;
}

function done(returnTo: string, key: string): never {
  redirect(withFlash(returnTo, "done", key));
}

function fail(returnTo: string, key: string): never {
  redirect(withFlash(returnTo, "error", key));
}

async function staff(formData: FormData): Promise<{ admin: AdminContext; returnTo: string }> {
  const returnTo = safeCourtesyReturn(formData.get("returnTo"));
  const admin = await requireStaffWriter(returnTo);
  if (!garageHasFeature(admin.garage, FEATURE)) fail(returnTo, "PLAN_REQUIRED");
  return { admin, returnTo };
}

function refresh(returnTo: string) {
  revalidatePath(PAGE);
  if (returnTo.startsWith("/app/bookings/")) revalidatePath(returnTo);
  revalidatePath("/app");
  revalidatePath("/app/diary");
}

type RpcError = { message?: string | null; code?: string | null } | null;

function rpcFailure(returnTo: string, error: RpcError): never {
  fail(returnTo, courtesyErrorCode(error) ?? "failed");
}

// ---------------------------------------------------------------------------------------------
// Fleet (owners and managers)

export async function addCarAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  if (!roleAllows(admin, "manage")) fail(returnTo, "not_allowed");
  const parsed = parseCarForm(formData);
  if (!parsed.ok) fail(returnTo, "bad_car");
  const { data: last } = await admin.client
    .from("courtesy_cars")
    .select("sort")
    .eq("garage_id", admin.garage.id)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sort = (typeof last?.sort === "number" ? last.sort : 0) + 10;
  const { data, error } = await admin.client
    .from("courtesy_cars")
    .insert({
      garage_id: admin.garage.id,
      name: parsed.value.name,
      registration: parsed.value.registration,
      notes: parsed.value.notes,
      mileage: parsed.value.mileage,
      fuel_eighths: parsed.value.fuelEighths,
      sort,
    })
    .select("id")
    .single();
  if (error?.code === "23505") fail(returnTo, "duplicate_registration");
  if (error || !data) fail(returnTo, error?.code === "42501" ? "PLAN_REQUIRED" : "failed");
  await auditSetupChange(admin, "courtesy_car.created", "courtesy_car", String(data.id));
  refresh(returnTo);
  done(returnTo, "car_added");
}

export async function updateCarAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  if (!roleAllows(admin, "manage")) fail(returnTo, "not_allowed");
  const id = idFrom(formData, "carId");
  const parsed = parseCarForm(formData);
  if (!id) fail(returnTo, "COURTESY_CAR_NOT_FOUND");
  if (!parsed.ok) fail(returnTo, "bad_car");
  const { data, error } = await admin.client
    .from("courtesy_cars")
    .update({
      name: parsed.value.name,
      registration: parsed.value.registration,
      notes: parsed.value.notes,
      ...(parsed.value.mileage !== null ? { mileage: parsed.value.mileage } : {}),
      ...(parsed.value.fuelEighths !== null ? { fuel_eighths: parsed.value.fuelEighths } : {}),
    })
    .eq("garage_id", admin.garage.id)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error?.code === "23505") fail(returnTo, "duplicate_registration");
  if (error) fail(returnTo, "failed");
  if (!data) fail(returnTo, "COURTESY_CAR_NOT_FOUND");
  await auditSetupChange(admin, "courtesy_car.updated", "courtesy_car", id);
  refresh(returnTo);
  done(returnTo, "car_saved");
}

/** Switches a car on or off. Off: not offered for new loans; loans already made stay. */
export async function setCarActiveAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  if (!roleAllows(admin, "manage")) fail(returnTo, "not_allowed");
  const id = idFrom(formData, "carId");
  if (!id) fail(returnTo, "COURTESY_CAR_NOT_FOUND");
  const active = formData.get("active") === "true";
  const { data, error } = await admin.client.from("courtesy_cars").update({ active }).eq("garage_id", admin.garage.id).eq("id", id).select("id").maybeSingle();
  if (error) fail(returnTo, "failed");
  if (!data) fail(returnTo, "COURTESY_CAR_NOT_FOUND");
  await auditSetupChange(admin, active ? "courtesy_car.activated" : "courtesy_car.deactivated", "courtesy_car", id);
  refresh(returnTo);
  done(returnTo, "car_saved");
}

/** Deletes a car that has never been lent; one with loans must be switched off instead. */
export async function deleteCarAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  if (!roleAllows(admin, "manage")) fail(returnTo, "not_allowed");
  const id = idFrom(formData, "carId");
  if (!id) fail(returnTo, "COURTESY_CAR_NOT_FOUND");
  const { data, error } = await admin.client.from("courtesy_cars").delete().eq("garage_id", admin.garage.id).eq("id", id).select("id");
  if (error?.code === "23503") fail(returnTo, "in_use");
  if (error) fail(returnTo, "failed");
  if (!data?.length) fail(returnTo, "COURTESY_CAR_NOT_FOUND");
  await auditSetupChange(admin, "courtesy_car.deleted", "courtesy_car", id);
  refresh(returnTo);
  done(returnTo, "car_deleted");
}

// ---------------------------------------------------------------------------------------------
// Loans (every member)

export async function reserveCarAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const bookingId = idFrom(formData, "bookingId");
  const carId = idFrom(formData, "carId");
  if (!bookingId) fail(returnTo, "BOOKING_NOT_FOUND");
  if (!carId) fail(returnTo, "COURTESY_CAR_NOT_FOUND");
  const window = parseLoanWindow(formData, admin.garage.timezone || "Europe/London");
  if (!window.ok) fail(returnTo, "bad_window");
  const notes = typeof formData.get("notes") === "string" ? String(formData.get("notes")).trim().slice(0, 500) : "";
  const { error } = await admin.client.rpc("reserve_courtesy_car", {
    p_booking_id: bookingId,
    p_car_id: carId,
    p_starts_at: window.startsAt,
    p_ends_at: window.endsAt,
    p_notes: notes || null,
  });
  if (error) rpcFailure(returnTo, error);
  refresh(returnTo);
  done(returnTo, "reserved");
}

export async function releaseLoanAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const loanId = idFrom(formData, "loanId");
  if (!loanId) fail(returnTo, "LOAN_NOT_FOUND");
  const { error } = await admin.client.rpc("release_courtesy_car", { p_loan_id: loanId, p_reason: null });
  if (error) rpcFailure(returnTo, error);
  refresh(returnTo);
  done(returnTo, "released");
}

export async function checkOutAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const loanId = idFrom(formData, "loanId");
  if (!loanId) fail(returnTo, "LOAN_NOT_FOUND");
  const reading = parseLoanReading(formData, 500);
  if (!reading.ok) fail(returnTo, "bad_reading");
  const { error } = await admin.client.rpc("check_out_courtesy_car", {
    p_loan_id: loanId,
    p_mileage: reading.value.mileage,
    p_fuel_eighths: reading.value.fuelEighths,
    p_notes: reading.value.notes,
  });
  if (error) rpcFailure(returnTo, error);
  refresh(returnTo);
  done(returnTo, "checked_out");
}

export async function checkInAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const loanId = idFrom(formData, "loanId");
  if (!loanId) fail(returnTo, "LOAN_NOT_FOUND");
  const reading = parseLoanReading(formData);
  if (!reading.ok) fail(returnTo, "bad_reading");
  const { error } = await admin.client.rpc("check_in_courtesy_car", {
    p_loan_id: loanId,
    p_mileage: reading.value.mileage,
    p_fuel_eighths: reading.value.fuelEighths,
    p_damage_notes: reading.value.notes,
  });
  if (error) rpcFailure(returnTo, error);
  refresh(returnTo);
  done(returnTo, "checked_in");
}

export async function declineRequestAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const requestId = idFrom(formData, "requestId");
  if (!requestId) fail(returnTo, "REQUEST_NOT_FOUND");
  const { error } = await admin.client.rpc("decline_courtesy_car_request", { p_request_id: requestId, p_reason: null });
  if (error) rpcFailure(returnTo, error);
  refresh(returnTo);
  done(returnTo, "declined");
}

// ---------------------------------------------------------------------------------------------
// Collection and delivery (every member)

export async function holdCollectionAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const bookingId = idFrom(formData, "bookingId");
  if (!bookingId) fail(returnTo, "BOOKING_NOT_FOUND");
  const parsed = parseCollectionForm(formData);
  if (!parsed.ok) fail(returnTo, "bad_collection");
  const { data, error } = await admin.client.rpc("hold_collection_delivery", {
    p_booking_id: bookingId,
    p_postcode: parsed.value.postcode,
    p_address: parsed.value.address,
  });
  if (error) rpcFailure(returnTo, error);
  const status = (data as { status?: string } | null)?.status;
  refresh(returnTo);
  done(returnTo, status === "held" ? "collection_held" : status === "partial" ? "collection_partial" : "collection_unassigned");
}

export async function releaseCollectionAction(formData: FormData) {
  const { admin, returnTo } = await staff(formData);
  const bookingId = idFrom(formData, "bookingId");
  if (!bookingId) fail(returnTo, "BOOKING_NOT_FOUND");
  const { error } = await admin.client.rpc("release_collection_delivery", { p_booking_id: bookingId });
  if (error) rpcFailure(returnTo, error);
  refresh(returnTo);
  done(returnTo, "collection_released");
}

// ---------------------------------------------------------------------------------------------
// Services setting: "Collection and delivery" on a service (owners and managers)

export async function setServiceCollectionAction(formData: FormData) {
  const serviceId = idFrom(formData, "serviceId");
  const path = serviceId ? `/app/settings/services/${serviceId}` : "/app/settings/services";
  const admin = await requireStaffWriter(path);
  const enabled = formData.get("enabled") === "true";
  if (!serviceId) redirect(`${path}?collection=not_found#collection-delivery`);
  if (!roleAllows(admin, "manage")) redirect(`${path}?collection=not_allowed#collection-delivery`);
  // Switching on needs Pro (also checked by the services trigger); switching off never does.
  if (enabled && !garageHasFeature(admin.garage, FEATURE)) redirect(`${path}?collection=plan#collection-delivery`);
  const { data, error } = await admin.client
    .from("services")
    .update({ collection_delivery: enabled })
    .eq("garage_id", admin.garage.id)
    .eq("id", serviceId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) redirect(`${path}?collection=${courtesyErrorCode(error) === "PLAN_REQUIRED" ? "plan" : "failed"}#collection-delivery`);
  if (!data) redirect(`${path}?collection=not_found#collection-delivery`);
  await auditSetupChange(admin, enabled ? "service.collection_on" : "service.collection_off", "service", serviceId);
  revalidatePath(path);
  revalidatePath("/_site/[garageId]", "layout");
  redirect(`${path}?collection=${enabled ? "on" : "off"}#collection-delivery`);
}
