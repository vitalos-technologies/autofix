import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { normaliseHost } from "@/lib/tenancy/hosts";
import { garageUrl, type GarageUrlSubject } from "@/lib/tenancy/urls";

/** `requested` (waiting for the garage's OK) is a tentative event; the others are confirmed or cancelled. */
export type BookingCalendarStatus = "confirmed" | "requested" | "rescheduled" | "cancelled";

/** The garage facts a calendar file needs. */
export type CalendarGarage = GarageUrlSubject & { id: string; name: string; email: string | null };

/** Manage page on the garage's host. Calendar files carry the plain link (reference + registration), never a link token. */
const MANAGE_PATH = "/manage";

export type BookingCalendarDetails = {
  garage: CalendarGarage;
  reference: string;
  customerName: string;
  /** Becomes the ATTENDEE line when present. */
  customerEmail?: string | null;
  service: string;
  vehicle: string;
  appointmentStart: string;
  appointmentEnd: string;
  timezone: string;
  location: string;
  sequence: number;
  status: BookingCalendarStatus;
  timestamp: string;
};

function calendarSigningKey() {
  const key = process.env.BOOKING_MANAGEMENT_SECRET?.trim();
  if (key) return key;
  if (process.env.NODE_ENV !== "production") return "local-booking-calendar-only";
  return null;
}

/** References are unique per garage only, so the signature binds the garage too. */
function signCalendarReference(garageId: string, reference: string) {
  const key = calendarSigningKey();
  return key ? createHmac("sha256", key).update(`booking-calendar:${garageId}:${reference.toUpperCase()}`).digest("base64url") : null;
}

/** Signed `.ics` download link on the garage's own booking host. */
export function bookingCalendarDownloadUrl(garage: CalendarGarage, reference: string) {
  const signature = signCalendarReference(garage.id, reference);
  if (!signature) return null;
  return garageUrl(garage, `/api/bookings/calendar/${encodeURIComponent(reference)}?signature=${encodeURIComponent(signature)}`);
}

export function verifyBookingCalendarSignature(garageId: string, reference: string, supplied: string | null) {
  if (!supplied) return false;
  const expected = signCalendarReference(garageId, reference);
  if (!expected) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/** Globally unique event UID: references repeat across garages, slugs do not. */
export function bookingCalendarUid(garage: Pick<CalendarGarage, "slug">, reference: string) {
  const safeReference = reference.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const domain = normaliseHost(process.env.NEXT_PUBLIC_TENANT_ROOT_DOMAIN) ?? "autofix.vitalos.co.uk";
  return `${safeReference}.${garage.slug}@${domain}`;
}

function utcCalendarDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid booking calendar date");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeCalendarText(value: string) {
  return value.replaceAll("\\", "\\\\").replace(/\r?\n/g, "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
}

function escapeParameter(value: string) {
  return value.replace(/[\r\n";:,]/g, " ").trim();
}

function foldCalendarLine(line: string) {
  const folded: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    const limit = folded.length === 0 ? 75 : 74;
    if (current && currentBytes + characterBytes > limit) {
      folded.push(current);
      current = ` ${character}`;
      currentBytes = 1 + characterBytes;
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }
  if (current) folded.push(current);
  return folded.join("\r\n");
}

export function buildBookingCalendar(details: BookingCalendarDetails) {
  const cancelled = details.status === "cancelled";
  const eventStatus = cancelled ? "CANCELLED" : details.status === "requested" ? "TENTATIVE" : "CONFIRMED";
  const manageUrl = garageUrl(details.garage, MANAGE_PATH);
  const attendee = details.customerEmail?.trim() ? `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${details.customerEmail.trim().replace(/[\r\n]/g, "")}` : null;
  const description = [
    `${details.garage.name} booking`,
    `Reference: ${details.reference}`,
    `Vehicle: ${details.vehicle}`,
    `Service: ${details.service}`,
    "",
    `Manage booking: ${manageUrl}`,
  ].join("\n");
  const organizer = details.garage.email ? `ORGANIZER;CN=${escapeParameter(details.garage.name)}:mailto:${details.garage.email.replace(/[\r\n]/g, "")}` : null;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Autofix//Booking Calendar//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancelled ? "CANCEL" : "REQUEST"}`,
    `X-WR-TIMEZONE:${escapeCalendarText(details.timezone)}`,
    "BEGIN:VEVENT",
    `UID:${bookingCalendarUid(details.garage, details.reference)}`,
    `DTSTAMP:${utcCalendarDate(details.timestamp)}`,
    `DTSTART:${utcCalendarDate(details.appointmentStart)}`,
    `DTEND:${utcCalendarDate(details.appointmentEnd)}`,
    `SEQUENCE:${Math.max(0, Math.floor(details.sequence))}`,
    `STATUS:${eventStatus}`,
    `SUMMARY:${escapeCalendarText(`${details.service} — ${details.garage.name}`)}`,
    `LOCATION:${escapeCalendarText(details.location)}`,
    `DESCRIPTION:${escapeCalendarText(description)}`,
    ...(organizer ? [organizer] : []),
    ...(attendee ? [attendee] : []),
    `URL:${manageUrl}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`;
}

export function buildGoogleCalendarUrl(details: Pick<BookingCalendarDetails, "garage" | "reference" | "service" | "vehicle" | "appointmentStart" | "appointmentEnd" | "timezone" | "location">) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${details.service} — ${details.garage.name}`,
    dates: `${utcCalendarDate(details.appointmentStart)}/${utcCalendarDate(details.appointmentEnd)}`,
    details: `${details.garage.name} booking\nReference: ${details.reference}\nVehicle: ${details.vehicle}\n\nManage booking: ${garageUrl(details.garage, MANAGE_PATH)}`,
    location: details.location,
    ctz: details.timezone,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
