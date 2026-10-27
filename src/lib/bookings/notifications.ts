import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { manageBookingUrl } from "@/lib/booking-engine/manage";
import type { BookingNotice } from "@/lib/booking-engine/notify";
import { unsubscribeUrl } from "@/lib/consent/unsubscribe-token";
import { garageEmailBrand } from "@/lib/email/brand";
import { isValidEmailAddress } from "@/lib/email/identity";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { renderBookingEmail, renderInternalBookingEmail, type BookingEmailType } from "@/lib/email/templates/bookings";
import { getChannel } from "@/lib/messaging/channel";
import { getMessagingMode, type MessagingEnv } from "@/lib/messaging/config";
import { resendIdempotencyKey } from "@/lib/messaging/email";
import { isE164 } from "@/lib/messaging/phone";
import { isValidAlphanumericSenderId } from "@/lib/messaging/results";
import { DEFAULT_TEMPLATES, renderTemplate } from "@/lib/messaging/templates";
import { createAdminClient } from "@/lib/supabase/server";
import { garageBaseUrl } from "@/lib/tenancy/urls";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import { bookingCalendarDownloadUrl, buildBookingCalendar, buildGoogleCalendarUrl } from "./calendar";
import { loadBookingNotificationContext, type BookingNotificationContext } from "./notification-context";

// Booking notifications (P2.10): customer email with an .ics file, a staff
// alert to the garage's own address, and a text message on the channel the
// customer chose (SMS or WhatsApp), re-checking `customers.opted_out_at` at
// send time. Everything goes through mock channels unless MESSAGING_MODE=live,
// so development and tests never message a real person. Each send is reserved
// in `booking_notification_events` first so a repeat never sends twice.
// Nothing here logs addresses, numbers, registrations or message bodies.

export type BookingNotificationEvent = BookingNotice["type"];
export type NotificationChannelKind = "customer_email" | "staff_email" | "sms" | "whatsapp";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
};

/** `senderId`: an alphanumeric SMS sender; the body then ends with the unsubscribe link instead of "Reply STOP" (A13). */
export type TextMessage = { channel: "sms" | "whatsapp"; to: string; body: string; senderId?: string };

export type ComposedBookingNotifications = {
  kind: BookingEmailType;
  /** Stable per garage, booking and event (moves are versioned by the new start). */
  key: string;
  customerEmail: EmailMessage | null;
  staffEmail: EmailMessage | null;
  textMessage: TextMessage | null;
  /** Why no text message is sent, when none is. */
  textSkipReason: "channel_email" | "opted_out" | "no_mobile" | null;
  calendar: string | null;
};

export type DeliveryOutcome = {
  kind: NotificationChannelKind;
  status: "sent" | "failed" | "duplicate" | "skipped";
  /** Safe to log: provider or local code, never an address or body. */
  code?: string;
};

/** Text wording for booking updates (service messages, sent straight away). `{manage_link}` is the signed link. */
export const BOOKING_TEXT_TEMPLATES: Record<BookingEmailType, string> = {
  confirmed: DEFAULT_TEMPLATES.booking_confirmed.body,
  requested: "{garage}: we've got your request for {service} on {date} at {time}. We'll confirm soon. Ref {reference}. Change or cancel: {manage_link}",
  rescheduled: "{garage}: your booking {reference} has moved to {date} at {time} for {service}. Change or cancel: {manage_link}",
  cancelled: "{garage}: your booking {reference} for {service} on {date} at {time} is cancelled. Book again: {link}",
};

function safeTimeZone(value: string | undefined) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value || "Europe/London" }).format(new Date());
    return value || "Europe/London";
  } catch {
    return "Europe/London";
  }
}

function appointmentParts(startValue: string, endValue: string | undefined, timeZone: string) {
  const start = new Date(startValue);
  const end = endValue ? new Date(endValue) : null;
  const time = (instant: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(instant);
  const date = (instant: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone }).format(instant);
  const durationMinutes = end ? Math.round((end.getTime() - start.getTime()) / 60_000) : null;
  return {
    date: date(start),
    shortDate: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(start),
    startTime: time(start),
    endTime: end ? `${date(end) === date(start) ? "" : `${date(end)} at `}${time(end)}` : undefined,
    duration: durationMinutes && durationMinutes > 0 ? `${durationMinutes} minutes` : undefined,
  };
}

/** What the customer is told: a new booking is either confirmed or waiting for the garage's OK. */
export function bookingEmailKind(status: string, event: BookingNotificationEvent): BookingEmailType {
  if (event === "rescheduled" || event === "cancelled") return event;
  return status === "requested" ? "requested" : "confirmed";
}

/** Unique per garage (references repeat across garages); moves are versioned by the new start. */
export function bookingNotificationKey(garageId: string, booking: { reference: string; startsAt: string }, kind: BookingEmailType) {
  const version = kind === "rescheduled" ? createHash("sha256").update(new Date(booking.startsAt).toISOString()).digest("hex").slice(0, 16) : "once";
  return `${garageId}:${booking.reference}:${kind}:${version}`;
}

function subjectFor(kind: BookingEmailType, garageName: string, reference: string) {
  if (kind === "requested") return `Your ${garageName} booking request ${reference}`;
  if (kind === "rescheduled") return `Your ${garageName} booking ${reference} has been rescheduled`;
  if (kind === "cancelled") return `Your ${garageName} booking ${reference} has been cancelled`;
  return `Your ${garageName} booking ${reference}`;
}

function staffSubjectFor(kind: BookingEmailType, reference: string) {
  return { confirmed: `New booking ${reference}`, requested: `Booking request ${reference} needs your OK`, rescheduled: `Updated booking ${reference}`, cancelled: `Cancelled booking ${reference}` }[kind];
}

/** Builds every message for a booking event. Pure: the email previews use it too. */
export function composeBookingNotifications(
  context: BookingNotificationContext,
  event: BookingNotificationEvent,
  options: {
    previousStartsAt?: string;
    now?: Date;
    /**
     * Send the SMS from this alphanumeric sender (DECISIONS A13: booking updates
     * only). Unset today (A41: booking texts use the two-way number); without a
     * signed unsubscribe link the two-way number is used instead.
     */
    smsSenderId?: string | null;
  } = {},
): ComposedBookingNotifications {
  const { garage, booking, customer, service } = context;
  const kind = bookingEmailKind(booking.status, event);
  const key = bookingNotificationKey(garage.id, booking, kind);
  const timeZone = safeTimeZone(garage.timezone);
  const brand = garageEmailBrand(garage);
  const appointment = appointmentParts(booking.startsAt, booking.endsAt, timeZone);
  const vehicle = [formatRegistration(context.vehicle.registration), [context.vehicle.make, context.vehicle.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  const manageUrl = manageBookingUrl(garage, context.manageToken);
  const optOutUrl = unsubscribeUrl(garage, customer.id) ?? undefined;
  const cancelled = kind === "cancelled";
  const durationMs = Date.parse(booking.endsAt) - Date.parse(booking.startsAt);
  const previous = options.previousStartsAt && kind === "rescheduled" ? appointmentParts(options.previousStartsAt, new Date(Date.parse(options.previousStartsAt) + durationMs).toISOString(), timeZone) : null;
  const timezoneLabel = timeZone === "Europe/London" ? `${timeZone} (UK time)` : timeZone;
  const calendarDetails = {
    garage,
    reference: booking.reference,
    customerName: customer.name,
    customerEmail: customer.email,
    service: service.name,
    vehicle,
    appointmentStart: booking.startsAt,
    appointmentEnd: booking.endsAt,
    timezone: timeZone,
    location: booking.location,
    sequence: context.calendarSequence,
    status: kind,
    timestamp: (options.now ?? new Date()).toISOString(),
  };
  const calendar = buildBookingCalendar(calendarDetails);
  const emailInput = {
    brand,
    type: kind,
    customerName: customer.name,
    reference: booking.reference,
    service: service.name,
    vehicle,
    date: appointment.date,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    duration: appointment.duration,
    timezone: timezoneLabel,
    location: booking.location,
    previousAppointment: previous ? `${previous.date} at ${previous.startTime}${previous.endTime ? `–${previous.endTime}` : ""}` : undefined,
    googleCalendarUrl: cancelled ? undefined : buildGoogleCalendarUrl(calendarDetails),
    calendarUrl: cancelled ? undefined : bookingCalendarDownloadUrl(garage, booking.reference) ?? undefined,
    manageUrl,
    unsubscribeUrl: optOutUrl,
  };

  const customerEmailAddress = isValidEmailAddress(customer.email) ? customer.email! : null;
  const garageEmail = isValidEmailAddress(garage.email) ? garage.email! : null;
  const rendered = renderBookingEmail(emailInput);
  const internal = renderInternalBookingEmail({
    ...emailInput,
    customerEmail: customerEmailAddress ?? "",
    customerPhone: customer.phone ?? undefined,
    notes: [booking.symptoms.join(", "), booking.notes].filter(Boolean).join("\n") || undefined,
  });

  let textMessage: TextMessage | null = null;
  let textSkipReason: ComposedBookingNotifications["textSkipReason"] = null;
  if (customer.channel === "email") textSkipReason = "channel_email";
  else if (customer.optedOutAt) textSkipReason = "opted_out";
  else if (!isE164(customer.phone)) textSkipReason = "no_mobile";
  else {
    const channel = customer.channel;
    const senderId = channel === "sms" && optOutUrl && options.smsSenderId && isValidAlphanumericSenderId(options.smsSenderId) ? options.smsSenderId : undefined;
    const { text } = renderTemplate(BOOKING_TEXT_TEMPLATES[kind], {
      garage: garage.name,
      service: service.name,
      date: appointment.shortDate,
      time: appointment.startTime,
      reference: booking.reference,
      manage_link: manageUrl,
      link: garageBaseUrl(garage),
    }, { channel, optOutLink: senderId ? optOutUrl : undefined });
    textMessage = { channel, to: customer.phone!, body: text, ...(senderId ? { senderId } : {}) };
  }

  return {
    kind,
    key,
    customerEmail: customerEmailAddress ? {
      to: customerEmailAddress,
      subject: subjectFor(kind, garage.name, booking.reference),
      text: rendered.text,
      html: rendered.html,
      replyTo: garageEmail ?? undefined,
      attachments: [{ filename: `${booking.reference}.ics`, content: Buffer.from(calendar, "utf8") }],
    } : null,
    staffEmail: garageEmail ? {
      to: garageEmail,
      subject: staffSubjectFor(kind, booking.reference),
      text: internal.text,
      html: internal.html,
      replyTo: customerEmailAddress ?? undefined,
    } : null,
    textMessage,
    textSkipReason,
    calendar,
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type Reservation = "reserved" | "duplicate" | "unreserved";

async function reserve(client: SupabaseClient, context: BookingNotificationContext, kind: BookingEmailType, notificationKey: string): Promise<Reservation> {
  const { error } = await client.from("booking_notification_events").insert({
    garage_id: context.garage.id,
    notification_key: notificationKey,
    booking_id: context.booking.id,
    // The table's check allows confirmed/rescheduled/cancelled; a request is the "created" notice.
    notification_type: kind === "requested" ? "confirmed" : kind,
    status: "pending",
  });
  if (error?.code === "23505") return "duplicate";
  // Without the reservation table the send still goes ahead: email carries a
  // provider idempotency key and the mock outbox de-duplicates by key.
  return error ? "unreserved" : "reserved";
}

async function settle(client: SupabaseClient, context: BookingNotificationContext, notificationKey: string, reservation: Reservation, outcome: DeliveryOutcome) {
  const writes: PromiseLike<unknown>[] = [
    client.from("booking_events").insert({
      garage_id: context.garage.id,
      booking_id: context.booking.id,
      type: "notification_sent",
      actor: "system",
      data: { kind: outcome.kind, status: outcome.status, ...(outcome.code ? { code: outcome.code } : {}) },
    }),
  ];
  if (reservation === "reserved") {
    writes.push(client
      .from("booking_notification_events")
      .update(outcome.status === "sent" ? { status: "sent", sent_at: new Date().toISOString(), last_error_code: null } : { status: "failed", last_error_code: outcome.code ?? "delivery_failed" })
      .eq("garage_id", context.garage.id)
      .eq("notification_key", notificationKey));
  }
  await Promise.all(writes);
}

async function deliverEmail(garageName: string, garageId: string, message: EmailMessage, notificationKey: string, env: MessagingEnv): Promise<{ ok: boolean; code?: string }> {
  if (getMessagingMode(env) !== "live") {
    // Mock mode: recorded in the in-memory outbox, never sent.
    const result = await getChannel("email", env).send({ garageId, to: message.to, subject: message.subject, body: message.text, html: message.html, idempotencyKey: notificationKey });
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  }
  try {
    await sendTransactionalEmail({
      senderName: garageName,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo,
      attachments: message.attachments,
      idempotencyKey: resendIdempotencyKey(garageId, notificationKey),
    });
    return { ok: true };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "delivery_failed";
    return { ok: false, code };
  }
}

export type SendBookingNotificationsOptions = {
  client?: SupabaseClient | null;
  now?: Date;
  env?: MessagingEnv;
};

/** Loads the booking, composes and sends every notification for one booking event. Never throws. */
export async function sendBookingNotifications(notice: BookingNotice, options: SendBookingNotificationsOptions = {}): Promise<DeliveryOutcome[]> {
  const client = options.client === undefined ? createAdminClient() : options.client;
  const env = options.env ?? process.env;
  if (!client) return [];
  let loaded: BookingNotificationContext | null;
  try {
    loaded = await loadBookingNotificationContext(client, notice.garageId, { bookingId: notice.bookingId });
  } catch {
    return [];
  }
  if (!loaded) return [];
  const context = loaded;
  const composed = composeBookingNotifications(context, notice.type, { previousStartsAt: notice.previousStartsAt, now: options.now });
  const outcomes: DeliveryOutcome[] = [];

  const run = async (kind: NotificationChannelKind, suffix: string, send: (key: string) => Promise<{ ok: boolean; code?: string }>) => {
    const notificationKey = `${composed.key}${suffix}`;
    try {
      const reservation = await reserve(client, context, composed.kind, notificationKey);
      if (reservation === "duplicate") {
        outcomes.push({ kind, status: "duplicate" });
        return;
      }
      const result = await send(notificationKey);
      const outcome: DeliveryOutcome = result.ok ? { kind, status: "sent" } : { kind, status: "failed", code: result.code };
      outcomes.push(outcome);
      await settle(client, context, notificationKey, reservation, outcome);
    } catch {
      outcomes.push({ kind, status: "failed", code: "unexpected" });
    }
  };

  const tasks: Promise<void>[] = [];
  if (composed.customerEmail) {
    const message = composed.customerEmail;
    tasks.push(run("customer_email", "", (key) => deliverEmail(context.garage.name, context.garage.id, message, key, env)));
  }
  if (composed.staffEmail) {
    const message = composed.staffEmail;
    tasks.push(run("staff_email", ":internal", (key) => deliverEmail(context.garage.name, context.garage.id, message, key, env)));
  }
  if (composed.textMessage) {
    const message = composed.textMessage;
    tasks.push(run(message.channel, `:${message.channel}`, async (key) => {
      // Two-way number unless compose chose an alphanumeric sender, whose body then carries the unsubscribe link (DECISIONS A13).
      const result = await getChannel(message.channel, env).send({
        garageId: context.garage.id,
        to: message.to,
        body: message.body,
        idempotencyKey: key,
        ...(message.senderId ? { senderId: message.senderId } : {}),
      });
      return result.ok ? { ok: true } : { ok: false, code: result.code };
    }));
  } else if (composed.textSkipReason === "opted_out") {
    outcomes.push({ kind: context.customer.channel === "whatsapp" ? "whatsapp" : "sms", status: "skipped", code: "opted_out" });
  }
  await Promise.all(tasks);
  return outcomes;
}
