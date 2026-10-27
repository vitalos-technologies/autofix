import { describe, expect, it } from "vitest";
import { bookingNotificationKey, type BookingNotificationDetails } from "@/lib/bookings/notifications";
import * as identity from "@/lib/email/identity";

const garageA = "11111111-1111-4111-8111-111111111111";
const garageB = "22222222-2222-4222-8222-222222222222";

const booking: BookingNotificationDetails = {
  id: "70ca0b0b-1df7-42f4-8fe1-329c54ace42d",
  reference: "HRM-4821",
  customerName: "Test Customer",
  customerEmail: "customer@example.com",
  registration: "AB12CDE",
  vehicleName: "Vauxhall Astra",
  service: "Vehicle Diagnostics",
  appointmentStart: "2026-08-20T09:30:00.000Z",
  appointmentEnd: "2026-08-20T10:30:00.000Z",
  timezone: "Europe/London",
  location: "Hartley Road Motors workshop",
  calendarSequence: 0,
  calendarTimestamp: "2026-08-13T09:00:00.000Z",
};

describe("booking email notification keys", () => {
  it("has no hard-coded business sender or recipient", () => {
    for (const name of ["approvedInternalBookingSender", "approvedInternalBookingRecipient", "approvedBookingReplyTo", "productionEmailSender"]) {
      expect(identity).not.toHaveProperty(name);
    }
  });

  it.each(["confirmed", "rescheduled", "cancelled"] as const)("is stable for %s retries", (type) => {
    expect(bookingNotificationKey(garageA, booking, type)).toBe(bookingNotificationKey(garageA, { ...booking }, type));
  });

  it("keeps the same reference in two garages apart", () => {
    expect(bookingNotificationKey(garageA, booking, "confirmed")).not.toBe(bookingNotificationKey(garageB, booking, "confirmed"));
  });

  it("versions reschedules by appointment while keeping one confirmation and cancellation event", () => {
    const changed = { ...booking, appointmentStart: "2026-08-21T09:30:00.000Z" };
    expect(bookingNotificationKey(garageA, booking, "rescheduled")).not.toBe(bookingNotificationKey(garageA, changed, "rescheduled"));
    expect(bookingNotificationKey(garageA, booking, "confirmed")).toBe(bookingNotificationKey(garageA, changed, "confirmed"));
    expect(bookingNotificationKey(garageA, booking, "cancelled")).toBe(bookingNotificationKey(garageA, changed, "cancelled"));
  });
});
