import "server-only";

import { createHash } from "node:crypto";
import { garageEmailBrand } from "@/lib/email/brand";
import { isValidEmailAddress } from "@/lib/email/identity";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { renderBookingEmail, renderInternalBookingEmail } from "@/lib/email/templates/bookings";
import { createAdminClient } from "@/lib/supabase/server";
import type { Garage } from "@/lib/tenancy/garage";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import { bookingCalendarDownloadUrl, buildBookingCalendar, buildGoogleCalendarUrl } from "./calendar";

export type BookingNotificationType = "confirmed" | "rescheduled" | "cancelled";

export type BookingNotificationDetails = {
  id: string;
  reference: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  registration: string;
  vehicleName?: string;
  service: string;
  appointmentStart: string;
  appointmentEnd?: string;
  timezone: string;
  location: string;
  previousAppointmentStart?: string;
  previousAppointmentEnd?: string;
  calendarSequence: number;
  calendarTimestamp: string;
  notes?: string;
};

function appointmentParts(startValue: string, endValue: string | undefined, timeZone: string) {
  const start = new Date(startValue);
  const end = endValue ? new Date(endValue) : null;
  const time = (instant: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(instant);
  const date = (instant: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone }).format(instant);
  const durationMinutes = end ? Math.round((end.getTime() - start.getTime()) / 60_000) : null;
  return {
    date: date(start),
    startTime: time(start),
    endTime: end ? `${date(end) === date(start) ? "" : `${date(end)} at `}${time(end)}` : undefined,
    duration: durationMinutes && durationMinutes > 0 ? `${durationMinutes} minutes` : undefined,
  };
}

function previousAppointmentLabel(timeZone: string, startValue?: string, endValue?: string) {
  if (!startValue) return undefined;
  const previous = appointmentParts(startValue, endValue, timeZone);
  return `${previous.date} at ${previous.startTime}${previous.endTime ? `–${previous.endTime}` : ""}`;
}

function safeTimeZone(value: string | undefined) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value || "Europe/London" }).format(new Date());
    return value || "Europe/London";
  } catch {
    return "Europe/London";
  }
}

/** Unique per garage (references repeat across garages). */
export function bookingNotificationKey(garageId: string, booking: BookingNotificationDetails, type: BookingNotificationType) {
  const appointmentInstant = new Date(booking.appointmentStart).toISOString();
  const version = type === "rescheduled" ? createHash("sha256").update(appointmentInstant).digest("hex").slice(0, 16) : "once";
  return `${garageId}:${booking.reference}:${type}:${version}`;
}

function subjectFor(type: BookingNotificationType, garageName: string, reference: string) {
  if (type === "rescheduled") return `Your ${garageName} booking ${reference} has been rescheduled`;
  if (type === "cancelled") return `Your ${garageName} booking ${reference} has been cancelled`;
  return `Your ${garageName} booking ${reference}`;
}

/**
 * Customer email (with `.ics`) plus a staff alert to the garage's own address.
 * Both go out under the garage's name from the platform sender; each send is
 * reserved in `booking_notification_events` first so a retry never duplicates it.
 */
export async function sendBookingNotification(garage: Garage, booking: BookingNotificationDetails, type: BookingNotificationType) {
  const admin = createAdminClient();
  if (!admin) return false;
  const brand = garageEmailBrand(garage);
  const timeZone = safeTimeZone(booking.timezone || garage.timezone);
  const key = bookingNotificationKey(garage.id, booking, type);
  const appointment = appointmentParts(booking.appointmentStart, booking.appointmentEnd, timeZone);
  const vehicle = [formatRegistration(booking.registration), booking.vehicleName].filter(Boolean).join(" · ");
  const calendarDetails = booking.appointmentEnd ? {
    garage,
    reference: booking.reference,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    service: booking.service,
    vehicle,
    appointmentStart: booking.appointmentStart,
    appointmentEnd: booking.appointmentEnd,
    timezone: timeZone,
    location: booking.location,
    sequence: booking.calendarSequence,
    status: type,
    timestamp: booking.calendarTimestamp,
  } : null;
  const calendarUrl = type === "cancelled" ? null : bookingCalendarDownloadUrl(garage, booking.reference);
  const timezoneLabel = timeZone === "Europe/London" ? `${timeZone} (UK time)` : timeZone;
  const rendered = renderBookingEmail({
    brand,
    type,
    customerName: booking.customerName,
    reference: booking.reference,
    service: booking.service,
    vehicle,
    date: appointment.date,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    duration: appointment.duration,
    timezone: timezoneLabel,
    location: booking.location,
    previousAppointment: previousAppointmentLabel(timeZone, booking.previousAppointmentStart, booking.previousAppointmentEnd),
    googleCalendarUrl: calendarDetails && type !== "cancelled" ? buildGoogleCalendarUrl(calendarDetails) : undefined,
    calendarUrl: calendarUrl || undefined,
  });
  const internalRendered = renderInternalBookingEmail({
    brand,
    type,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    notes: booking.notes,
    reference: booking.reference,
    service: booking.service,
    vehicle,
    date: appointment.date,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    duration: appointment.duration,
    timezone: timezoneLabel,
    location: booking.location,
  });
  const garageReplyTo = isValidEmailAddress(garage.email) ? garage.email! : undefined;

  const sends = [
    reserveAndSend(admin, garage.id, booking, type, key, {
      senderName: garage.name,
      to: booking.customerEmail,
      subject: subjectFor(type, garage.name, booking.reference),
      text: rendered.text,
      html: rendered.html,
      replyTo: garageReplyTo,
      idempotencyKey: `booking-${createHash("sha256").update(key).digest("hex")}`,
      attachments: calendarDetails ? [{ filename: `${booking.reference}.ics`, content: Buffer.from(buildBookingCalendar(calendarDetails), "utf8") }] : undefined,
    }, `${type}_email_failed`),
  ];
  // Staff alerts go to the garage's own inbox; a garage without one simply gets none.
  if (garageReplyTo) {
    sends.push(reserveAndSend(admin, garage.id, booking, type, `${key}:internal`, {
      senderName: garage.name,
      to: garageReplyTo,
      subject: `${type === "confirmed" ? "New" : type === "rescheduled" ? "Updated" : "Cancelled"} booking ${booking.reference}`,
      text: internalRendered.text,
      html: internalRendered.html,
      replyTo: booking.customerEmail,
      idempotencyKey: `booking-internal-${createHash("sha256").update(key).digest("hex")}`,
    }, `${type}_internal_email_failed`));
  }
  const results = await Promise.all(sends);
  return results.every(Boolean);
}

type BookingAdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

async function reserveAndSend(admin: BookingAdminClient, garageId: string, booking: BookingNotificationDetails, type: BookingNotificationType, notificationKey: string, message: Parameters<typeof sendTransactionalEmail>[0], failureAction: string) {
  const { error: reservationError } = await admin.from("booking_notification_events").insert({ garage_id: garageId, notification_key: notificationKey, booking_id: booking.id, notification_type: type, status: "pending" });
  if (reservationError?.code === "23505") return true;
  if (reservationError) return false;
  try {
    await sendTransactionalEmail(message);
    await admin.from("booking_notification_events").update({ status: "sent", sent_at: new Date().toISOString(), last_error_code: null }).eq("garage_id", garageId).eq("notification_key", notificationKey);
    return true;
  } catch {
    await Promise.all([
      admin.from("booking_notification_events").update({ status: "failed", last_error_code: "delivery_failed" }).eq("garage_id", garageId).eq("notification_key", notificationKey),
      admin.from("booking_audit_log").insert({ garage_id: garageId, booking_id: booking.id, action: failureAction, actor_type: "system", detail: { channel: notificationKey.endsWith(":internal") ? "internal" : "customer" } }),
    ]);
    return false;
  }
}
