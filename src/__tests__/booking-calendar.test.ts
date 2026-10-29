import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bookingCalendarDownloadUrl,
  bookingCalendarUid,
  buildBookingCalendar,
  buildGoogleCalendarUrl,
  verifyBookingCalendarSignature,
  type BookingCalendarDetails,
} from "@/lib/bookings/calendar";
import { otherTestGarage, testGarage } from "./support/garage";

const garage = testGarage();
const other = otherTestGarage();

const booking: BookingCalendarDetails = {
  garage,
  reference: "HRM-4821",
  customerName: "Test Customer",
  customerEmail: "customer@example.com",
  service: "Vehicle Diagnostics",
  vehicle: "AB12 CDE · Vauxhall Astra",
  appointmentStart: "2026-08-20T08:30:00.000Z",
  appointmentEnd: "2026-08-20T09:30:00.000Z",
  timezone: "Europe/London",
  location: "Hartley Road Motors workshop",
  sequence: 0,
  status: "confirmed",
  timestamp: "2026-08-13T09:00:00.000Z",
};

describe("garage booking calendars", () => {
  beforeEach(() => {
    process.env.BOOKING_MANAGEMENT_SECRET = "calendar-test-secret-with-high-entropy";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TENANT_ROOT_DOMAIN", "pitline.co.uk");
  });

  afterEach(() => {
    delete process.env.BOOKING_MANAGEMENT_SECRET;
    vi.unstubAllEnvs();
  });

  it("uses one stable, garage-unique UID for booking, reschedule and cancellation", () => {
    expect(bookingCalendarUid(garage, booking.reference)).toBe("HRM-4821.hartley-road@pitline.co.uk");
    expect(bookingCalendarUid(other, booking.reference)).not.toBe(bookingCalendarUid(garage, booking.reference));
    expect(buildBookingCalendar(booking)).toContain("UID:HRM-4821.hartley-road@pitline.co.uk");
    expect(buildBookingCalendar({ ...booking, status: "rescheduled", sequence: 1 })).toContain("UID:HRM-4821.hartley-road@pitline.co.uk");
    expect(buildBookingCalendar({ ...booking, status: "cancelled", sequence: 2 })).toContain("UID:HRM-4821.hartley-road@pitline.co.uk");
  });

  it("generates valid CRLF calendar data with correct BST instants and the garage as organiser", () => {
    const calendar = buildBookingCalendar(booking);
    expect(calendar).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(calendar).toContain("PRODID:-//Pitline//Booking Calendar//EN\r\n");
    expect(calendar).toContain("METHOD:REQUEST\r\n");
    expect(calendar).toContain("X-WR-TIMEZONE:Europe/London\r\n");
    expect(calendar).toContain("DTSTART:20260820T083000Z\r\n");
    expect(calendar).toContain("DTEND:20260820T093000Z\r\n");
    expect(calendar).toContain("SUMMARY:Vehicle Diagnostics — Hartley Road Motors\r\n");
    expect(calendar).toContain("ORGANIZER;CN=Hartley Road Motors:mailto:bookings@hartleyroad.example\r\n");
    expect(calendar).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:customer@example.com\r\n");
    expect(calendar).toContain("URL:https://hartley-road.pitline.co.uk/manage\r\n");
    expect(calendar).not.toContain("Cal.com");
    expect(calendar).not.toMatch(/SOB|sobautofix/i);
  });

  it("marks bookings waiting for the garage's OK as tentative and never puts a link token in the file", () => {
    const calendar = buildBookingCalendar({ ...booking, status: "requested" });
    expect(calendar).toContain("STATUS:TENTATIVE\r\n");
    expect(calendar).toContain("METHOD:REQUEST\r\n");
    expect(calendar).not.toContain("token=");
  });

  it("omits the attendee line when the customer gave no email address", () => {
    expect(buildBookingCalendar({ ...booking, customerEmail: null })).not.toContain("ATTENDEE");
  });

  it("omits the organiser line for a garage with no email address", () => {
    expect(buildBookingCalendar({ ...booking, garage: { ...garage, email: null } })).not.toContain("ORGANIZER");
  });

  it("uses cancellation semantics for the same calendar event", () => {
    const calendar = buildBookingCalendar({ ...booking, status: "cancelled", sequence: 2 });
    expect(calendar).toContain("METHOD:CANCEL\r\n");
    expect(calendar).toContain("SEQUENCE:2\r\n");
    expect(calendar).toContain("STATUS:CANCELLED\r\n");
  });

  it("builds a direct Google Calendar action from authoritative booking data", () => {
    const url = new URL(buildGoogleCalendarUrl(booking));
    expect(url.origin).toBe("https://calendar.google.com");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20260820T083000Z/20260820T093000Z");
    expect(url.searchParams.get("ctz")).toBe("Europe/London");
    expect(url.searchParams.get("details")).toContain("HRM-4821");
    expect(url.searchParams.get("details")).toContain("https://hartley-road.pitline.co.uk/manage");
    expect(url.toString()).not.toContain("cal.com");
  });

  it("signs calendar downloads on the garage's own host, bound to that garage", () => {
    const url = new URL(bookingCalendarDownloadUrl(garage, booking.reference)!);
    const signature = url.searchParams.get("signature");
    expect(url.origin).toBe("https://hartley-road.pitline.co.uk");
    expect(url.pathname).toBe("/api/bookings/calendar/HRM-4821");
    expect(verifyBookingCalendarSignature(garage.id, booking.reference, signature)).toBe(true);
    expect(verifyBookingCalendarSignature(garage.id, "HRM-1234", signature)).toBe(false);
    // The same reference in another garage is a different booking.
    expect(verifyBookingCalendarSignature(other.id, booking.reference, signature)).toBe(false);
    expect(url.toString()).not.toContain("bookingId");
  });

  it("links to a verified custom domain when the garage has one", () => {
    const url = new URL(bookingCalendarDownloadUrl({ ...garage, customDomain: "book.hartleyroad.co.uk" }, booking.reference)!);
    expect(url.origin).toBe("https://book.hartleyroad.co.uk");
  });
});
