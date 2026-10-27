"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getBookingEngine } from "@/lib/booking-engine";
import { cancelBooking, findBookingForManage, rescheduleBooking } from "@/lib/booking-engine/manage";
import { createAdminClient } from "@/lib/supabase/server";
import { getAdminContext } from "@/lib/tenancy/admin";

// Staff booking actions. The garage is the signed-in member's selected garage
// (getAdminContext), never a value from the form; booking ids from another
// garage are simply "not found".

const uuidSchema = z.string().uuid();

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, "Enter a valid date");

const dateWindowSchema = z.object({
  bookingId: uuidSchema,
  start: dateOnlySchema,
  end: dateOnlySchema,
}).superRefine((value, context) => {
  const start = Date.parse(`${value.start}T00:00:00Z`);
  const end = Date.parse(`${value.end}T00:00:00Z`);
  const days = (end - start) / 86_400_000;
  if (!Number.isFinite(days) || days < 0 || days > 13) {
    context.addIssue({
      code: "custom",
      path: ["end"],
      message: "Choose a date window of no more than 14 days",
    });
  }
});

const appointmentSchema = z.object({
  bookingId: uuidSchema,
  appointmentStart: z.string().datetime({ offset: true }).refine(
    (value) => Date.parse(value) > Date.now(),
    "Choose a future appointment",
  ),
});

type SafeActionResult = {
  success: boolean;
  message: string;
};

async function getVerifiedAdmin() {
  const admin = await getAdminContext({ requireMfa: false });
  if (admin?.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (admin?.mfaRequired && !admin.mfaVerified) redirect("/app/mfa?returnTo=/app/bookings&stepUp=1");
  return admin;
}

export async function getAdminBookingSlotsAction(
  bookingId: string,
  start: string,
  end: string,
): Promise<SafeActionResult & { slots?: Array<{ start: string; end?: string }> }> {
  const admin = await getVerifiedAdmin();
  if (!admin) return { success: false, message: "Your admin session has expired. Refresh and sign in again." };

  const parsed = dateWindowSchema.safeParse({ bookingId, start, end });
  if (!parsed.success) return { success: false, message: "Choose a valid date range of up to 14 days." };

  try {
    const booking = await findBookingForManage({ garageId: admin.garage.id, bookingId: parsed.data.bookingId });
    if (!booking || !["requested", "confirmed"].includes(booking.status)) return { success: false, message: "This booking cannot be rescheduled." };
    const available = await getBookingEngine().getAvailableSlots({
      garageId: admin.garage.id,
      serviceId: booking.serviceId,
      from: parsed.data.start,
      to: parsed.data.end,
      locationMode: booking.locationMode,
    });
    const slots = available
      .filter((slot) => slot.freeCount > 0 && slot.startsAt !== booking.startsAt)
      .slice(0, 200)
      .map((slot) => ({ start: slot.startsAt, end: slot.endsAt }));
    return {
      success: true,
      message: slots.length ? "Available appointment times loaded." : "No appointment times are available in this date range.",
      slots,
    };
  } catch {
    return { success: false, message: "Appointment availability is temporarily unavailable. Please try again." };
  }
}

export async function rescheduleAdminBookingAction(
  bookingId: string,
  appointmentStart: string,
): Promise<SafeActionResult> {
  const admin = await getVerifiedAdmin();
  if (!admin) return { success: false, message: "Your admin session has expired. Refresh and sign in again." };

  const parsed = appointmentSchema.safeParse({ bookingId, appointmentStart });
  if (!parsed.success) return { success: false, message: "Choose a valid future appointment time." };

  try {
    const result = await rescheduleBooking({ garageId: admin.garage.id, bookingId: parsed.data.bookingId, startsAt: parsed.data.appointmentStart, actor: "staff", actorId: admin.user.id });
    if (!result.ok) {
      return { success: false, message: result.code === "SLOT_UNAVAILABLE" ? "That time has just been taken. Reload the available times and try again." : "This booking can no longer be rescheduled." };
    }
    revalidateBookingPaths(parsed.data.bookingId);
    return { success: true, message: "The booking has been moved and the customer will be told." };
  } catch {
    return { success: false, message: "The booking could not be rescheduled. Reload the available times and try again." };
  }
}

export async function cancelAdminBookingAction(bookingId: string): Promise<SafeActionResult> {
  const admin = await getVerifiedAdmin();
  if (!admin) return { success: false, message: "Your admin session has expired. Refresh and sign in again." };

  const parsed = uuidSchema.safeParse(bookingId);
  if (!parsed.success) return { success: false, message: "This booking could not be found." };

  try {
    const result = await cancelBooking({ garageId: admin.garage.id, bookingId: parsed.data, actor: "staff", actorId: admin.user.id });
    if (!result.ok && result.code === "NOT_FOUND") return { success: false, message: "This booking could not be found." };
    if (!result.ok) return { success: false, message: "This booking can no longer be cancelled." };
    revalidateBookingPaths(parsed.data);
    return { success: true, message: "The booking has been cancelled and the customer will be told." };
  } catch {
    return { success: false, message: "The booking could not be cancelled. Please try again." };
  }
}

export async function startBookingEnquiryThreadAction(formData: FormData) {
  const admin = await getVerifiedAdmin();
  if (!admin) redirect("/app/login?returnTo=%2Fapp%2Fbookings");

  const bookingId = uuidSchema.parse(formData.get("bookingId"));
  // Service-role-only RPC; it is scoped to the admin's selected garage, so a
  // booking id from another garage is "Booking not found".
  const client = createAdminClient();
  if (!client) throw new Error("Enquiry conversations are temporarily unavailable.");

  const { data, error } = await client.rpc("create_booking_enquiry_thread", {
    p_garage_id: admin.garage.id,
    target_booking_id: bookingId,
    actor_id_value: admin.user.id,
  });
  const enquiryId = uuidSchema.safeParse(data);
  if (error || !enquiryId.success) {
    throw new Error("The booking email thread could not be opened. Please try again.");
  }

  revalidatePath("/app/bookings");
  revalidatePath(`/app/bookings/${bookingId}`);
  revalidatePath("/app/enquiries");
  revalidatePath("/app/notifications");
  revalidatePath("/app", "layout");
  redirect(`/app/enquiries/${enquiryId.data}`);
}

export async function markBookingSeenAction(bookingId: string) {
  const admin = await getVerifiedAdmin();
  if (!admin) throw new Error("Your admin session has expired.");

  const parsed = uuidSchema.safeParse(bookingId);
  if (!parsed.success) throw new Error("This booking could not be found.");

  const { error } = await admin.client
    .from("bookings")
    .update({ admin_seen_at: new Date().toISOString() })
    .eq("garage_id", admin.garage.id)
    .eq("id", parsed.data)
    .is("admin_seen_at", null);
  if (error) throw new Error("The booking notification could not be acknowledged.");

  revalidatePath("/app", "layout");
  revalidatePath("/app/notifications");
  revalidatePath("/app/bookings");
}

function revalidateBookingPaths(bookingId: string) {
  revalidatePath("/app/bookings");
  revalidatePath(`/app/bookings/${bookingId}`);
}
