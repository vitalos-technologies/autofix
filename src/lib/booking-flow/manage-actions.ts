"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { cancelBooking, findBookingForManage, rescheduleBooking, type ManageOutcome } from "@/lib/booking-engine/manage";
import { bookingReferenceSchema, manageErrorMessages } from "@/lib/booking-engine/manage-schema";
import type { ManageCancelFormState, ManageLookupFormState, ManageRescheduleFormState } from "@/lib/booking-flow/forms";
import { clearManageSession, readManagedBooking, writeManageSession } from "@/lib/booking-flow/manage-server";
import { clientIp, humanCheckConfigured } from "@/lib/booking-flow/server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getGarage } from "@/lib/tenancy/garage";
import { verifyTurnstile } from "@/lib/turnstile";
import { registrationSchema } from "@/lib/vehicle/registration";

// Server actions for the manage booking pages (src/app/%5Fsite/[garageId]/manage). The garage is
// the host's; the booking is the one the signed `af_manage` session opens. The reference and the
// registration arrive in the POST body only and are never echoed, logged or put in a URL.
// Redirects go to `/manage`, at most with `?done=moved|cancelled`.

const HUMAN_CHECK_MESSAGE = "Please complete the security check, then try again.";
const RESCHEDULE_TAKEN_MESSAGE = "Sorry, that time has just gone. Choose another time.";

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Reference + registration → opens a manage session and shows the booking. A booking that does
 * not exist and one whose registration does not match get the same answer, so the form never
 * reveals whether a reference is in use.
 */
export async function lookupBookingAction(previous: ManageLookupFormState, formData: FormData): Promise<ManageLookupFormState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();

  const reference = bookingReferenceSchema.safeParse(text(formData.get("reference")));
  const registration = registrationSchema.safeParse(text(formData.get("registration")));
  const fieldErrors: NonNullable<ManageLookupFormState["fieldErrors"]> = {};
  if (!reference.success) fieldErrors.reference = `Enter your booking reference, for example ${garage.bookingPrefix}-4821.`;
  if (!registration.success) fieldErrors.registration = "Enter the car's registration, for example AB12 CDE.";
  if (!reference.success || !registration.success) return { seq, fieldErrors };

  // The same buckets as POST /api/bookings/manage.
  const ip = await clientIp();
  if (!(await consumeRateLimit(`${garage.id}:${ip}`, "booking_lookup_ip", 5, 600))) return { seq, message: manageErrorMessages.RATE_LIMITED };
  if (humanCheckConfigured()) {
    const token = text(formData.get("turnstileToken"));
    if (!token || !(await verifyTurnstile(token, ip === "unknown" ? undefined : ip))) return { seq, message: HUMAN_CHECK_MESSAGE };
  }
  if (!(await consumeRateLimit(`${garage.id}:${ip}:${reference.data}:${registration.data}`, "booking_lookup_details", 5, 900))) {
    return { seq, message: manageErrorMessages.RATE_LIMITED };
  }

  let booking;
  try {
    booking = await findBookingForManage({ garageId: garage.id, reference: reference.data, registration: registration.data });
  } catch {
    return { seq, message: manageErrorMessages.UNAVAILABLE };
  }
  if (!booking) return { seq, message: manageErrorMessages.NOT_FOUND };

  await writeManageSession(booking);
  redirect("/manage");
}

/** "Look up another booking": forgets the open booking on this device. */
export async function forgetManagedBookingAction(): Promise<void> {
  await clearManageSession();
  redirect("/manage");
}

/** The page already explains these (closed online, too close, gone): send the customer back to it. */
function backToBooking(outcome: Extract<ManageOutcome, { ok: false }>) {
  if (outcome.code === "NOT_FOUND" || outcome.code === "NOT_MODIFIABLE" || outcome.code === "CUTOFF_PASSED") redirect("/manage");
}

/** Moves the session's booking to another free start (the customer's cutoff applies). */
export async function rescheduleBookingAction(previous: ManageRescheduleFormState, formData: FormData): Promise<ManageRescheduleFormState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();
  const session = await readManagedBooking(garage.id);
  if (session.kind === "unavailable") return { seq, message: manageErrorMessages.UNAVAILABLE };
  if (session.kind !== "open") redirect("/manage");
  const booking = session.booking;

  const startsAt = text(formData.get("startsAt"));
  const instant = Date.parse(startsAt);
  if (!startsAt || Number.isNaN(instant)) return { seq, message: "Choose a new time." };

  const ip = await clientIp();
  if (!(await consumeRateLimit(`${ip}:${booking.id}`, "booking_reschedule", 3, 600))) return { seq, message: manageErrorMessages.RATE_LIMITED };

  let outcome: ManageOutcome;
  try {
    outcome = await rescheduleBooking({ garageId: garage.id, bookingId: booking.id, startsAt: new Date(instant).toISOString(), actor: "customer" });
  } catch {
    return { seq, message: manageErrorMessages.UNAVAILABLE };
  }

  if (outcome.ok) {
    await writeManageSession(outcome.booking);
    redirect(outcome.changed ? "/manage?done=moved" : "/manage");
  }
  backToBooking(outcome);
  if (outcome.code === "SLOT_UNAVAILABLE") {
    refresh();
    const alternatives = (outcome.alternatives ?? [])
      .filter((slot) => slot.freeCount > 0)
      .slice(0, 3)
      .map((slot) => ({ startsAt: slot.startsAt, endsAt: slot.endsAt }));
    return { seq, message: RESCHEDULE_TAKEN_MESSAGE, alternatives };
  }
  return { seq, message: outcome.message };
}

/** Cancels the session's booking (before the garage's cutoff) and frees its slot. */
export async function cancelBookingAction(previous: ManageCancelFormState, formData: FormData): Promise<ManageCancelFormState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();
  const session = await readManagedBooking(garage.id);
  if (session.kind === "unavailable") return { seq, message: manageErrorMessages.UNAVAILABLE };
  if (session.kind !== "open") redirect("/manage");
  const booking = session.booking;
  const reason = text(formData.get("reason")).replace(/\s+/g, " ").slice(0, 300) || null;

  const ip = await clientIp();
  if (!(await consumeRateLimit(`${ip}:${booking.id}`, "booking_cancel", 3, 600))) return { seq, message: manageErrorMessages.RATE_LIMITED };

  let outcome: ManageOutcome;
  try {
    outcome = await cancelBooking({ garageId: garage.id, bookingId: booking.id, actor: "customer", reason });
  } catch {
    return { seq, message: manageErrorMessages.UNAVAILABLE };
  }

  if (outcome.ok) {
    await writeManageSession(outcome.booking);
    redirect(outcome.changed ? "/manage?done=cancelled" : "/manage");
  }
  backToBooking(outcome);
  return { seq, message: outcome.message };
}
