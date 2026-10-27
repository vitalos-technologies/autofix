"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formatSlotLabel } from "@/components/book/format";
import type { TimeSlot } from "@/components/book/slot-grid";
import { parseDateKey } from "@/lib/admin/dates";
import { requireStaffWriter } from "@/lib/admin/staff";
import { createStaffBooking, staffBookingSchema } from "@/lib/admin/staff-booking";
import { getBookingEngine } from "@/lib/booking-engine";
import { bookingErrorMessages } from "@/lib/booking-engine/errors";
import { locationModes } from "@/lib/booking-engine/types";

// Staff phone / walk-in bookings. The garage is the member's selected garage
// and the member is the signed-in user; nothing here reads a garage or member
// id from the form. Both actions use the staff rules (src/lib/admin/staff-booking.ts).

export type StaffBookingState = {
  status: "idle" | "error";
  message: string;
  fieldErrors?: Record<string, string>;
};

/** Free times for one day of a service (Book 3's grid, for staff: no notice or booking window, services not offered online too). */
export async function getStaffSlotsAction(serviceId: string, date: string, locationMode: string): Promise<{ ok: boolean; message?: string; slots: TimeSlot[] }> {
  const admin = await requireStaffWriter("/app/bookings/new");
  const service = z.string().uuid().safeParse(serviceId);
  const day = parseDateKey(date);
  const mode = z.enum(locationModes).safeParse(locationMode);
  if (!service.success || !day || !mode.success) return { ok: false, message: "Choose a service and a day.", slots: [] };
  try {
    const slots = await getBookingEngine().getStaffSlots({
      garageId: admin.garage.id,
      serviceId: service.data,
      from: day,
      to: day,
      locationMode: mode.data,
      memberId: admin.user.id,
    });
    return { ok: true, slots: slots.map((slot) => ({ starts_at: slot.startsAt, ends_at: slot.endsAt, free_count: slot.freeCount })) };
  } catch {
    return { ok: false, message: "Times could not be loaded for this service. Try another service or day.", slots: [] };
  }
}

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function createStaffBookingAction(_previous: StaffBookingState, formData: FormData): Promise<StaffBookingState> {
  const admin = await requireStaffWriter("/app/bookings/new");
  const parsed = staffBookingSchema.safeParse({
    source: text(formData, "source"),
    serviceId: text(formData, "serviceId"),
    startsAt: text(formData, "startsAt"),
    locationMode: text(formData, "locationMode") || "workshop",
    postcode: text(formData, "postcode"),
    address: text(formData, "address"),
    registration: text(formData, "registration") ?? "",
    make: text(formData, "make"),
    model: text(formData, "model"),
    customerName: text(formData, "customerName") ?? "",
    customerPhone: text(formData, "customerPhone") ?? "",
    customerEmail: text(formData, "customerEmail") ?? "",
    reminderConsent: formData.get("reminderConsent") === "on",
    notes: text(formData, "notes"),
    overrideHours: formData.get("overrideHours") === "on",
    idempotencyKey: text(formData, "idempotencyKey"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "form");
      fieldErrors[field] ??= issue.message;
    }
    return { status: "error", message: "Check the highlighted details.", fieldErrors };
  }

  const result = await createStaffBooking(admin.garage.id, admin.user.id, parsed.data);
  if (!result.ok) {
    if (result.code === "SLOT_UNAVAILABLE") {
      const timeZone = admin.garage.timezone || "Europe/London";
      const nearest = (result.alternatives ?? []).slice(0, 3).map((slot) => formatSlotLabel(slot.startsAt, timeZone));
      return {
        status: "error",
        message: nearest.length ? `That time has just gone. Nearest free: ${nearest.join(", ")}.` : "That time has just gone. Pick another time.",
        fieldErrors: { startsAt: "Pick another time" },
      };
    }
    return { status: "error", message: result.message || bookingErrorMessages[result.code] };
  }

  revalidatePath("/app", "layout");
  redirect(`/app/bookings/${result.booking.id}?notice=created`);
}
