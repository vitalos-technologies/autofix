"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { addBookingNote, changeBookingStatus, CHANGE_MESSAGES, NOTE_MAX_LENGTH } from "@/lib/admin/booking-changes";
import { statusChangedMessage } from "@/lib/admin/booking-status";
import { requireStaffWriter } from "@/lib/admin/staff";
import { bookingStatuses } from "@/lib/booking-engine/types";

// Status changes and notes from Today, the Diary and the booking page. Every
// write goes through the selected garage's RLS client (requireStaffWriter →
// getAdminContext().client); a booking id from another garage is "not found".

export type BookingActionState = { status: "idle" | "done" | "error"; message: string };

const bookingIdSchema = z.string().uuid();
const statusSchema = z.enum(bookingStatuses);

function revalidateBooking(bookingId: string) {
  // The layout's badges (requests, notifications) and every list that shows the booking.
  revalidatePath("/app", "layout");
  revalidatePath(`/app/bookings/${bookingId}`);
}

/** One-tap changes from a card (Accept, Mark ready…). Problems open the booking page with a notice. */
async function quickChange(formData: FormData, target: unknown) {
  const bookingId = bookingIdSchema.safeParse(formData.get("bookingId"));
  const to = statusSchema.safeParse(target);
  if (!bookingId.success) redirect("/app/bookings");
  const admin = await requireStaffWriter(`/app/bookings/${bookingId.data}`);
  if (!to.success) redirect(`/app/bookings/${bookingId.data}?notice=not_allowed`);
  const result = await changeBookingStatus(admin, bookingId.data, to.data);
  revalidateBooking(bookingId.data);
  if (!result.ok) redirect(`/app/bookings/${bookingId.data}?notice=${result.code}`);
}

/** "Accept" on a request: requested → confirmed. */
export async function acceptBookingAction(formData: FormData): Promise<void> {
  await quickChange(formData, "confirmed");
}

/** Job card buttons: posts `bookingId` and the target `status`. */
export async function quickStatusAction(formData: FormData): Promise<void> {
  await quickChange(formData, formData.get("status"));
}

/** Status buttons on the booking page (with a reason for cancelling). */
export async function changeBookingStatusFormAction(_previous: BookingActionState, formData: FormData): Promise<BookingActionState> {
  const bookingId = bookingIdSchema.safeParse(formData.get("bookingId"));
  const to = statusSchema.safeParse(formData.get("status"));
  if (!bookingId.success || !to.success) return { status: "error", message: CHANGE_MESSAGES.invalid };
  const admin = await requireStaffWriter(`/app/bookings/${bookingId.data}`);
  const reason = typeof formData.get("reason") === "string" ? String(formData.get("reason")) : null;
  const result = await changeBookingStatus(admin, bookingId.data, to.data, { reason });
  revalidateBooking(bookingId.data);
  return result.ok ? { status: "done", message: statusChangedMessage(result.to) } : { status: "error", message: CHANGE_MESSAGES[result.code] };
}

/** A staff note on the booking's timeline. */
export async function addBookingNoteAction(_previous: BookingActionState, formData: FormData): Promise<BookingActionState> {
  const bookingId = bookingIdSchema.safeParse(formData.get("bookingId"));
  const text = String(formData.get("note") ?? "");
  if (!bookingId.success) return { status: "error", message: CHANGE_MESSAGES.invalid };
  if (!text.trim()) return { status: "error", message: "Write the note first." };
  if (text.trim().length > NOTE_MAX_LENGTH) return { status: "error", message: `Keep the note under ${NOTE_MAX_LENGTH} characters.` };
  const admin = await requireStaffWriter(`/app/bookings/${bookingId.data}`);
  const result = await addBookingNote(admin, bookingId.data, text);
  revalidatePath(`/app/bookings/${bookingId.data}`);
  return result.ok ? { status: "done", message: "Note added." } : { status: "error", message: CHANGE_MESSAGES[result.code] };
}
