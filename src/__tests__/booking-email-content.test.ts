import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { garageEmailBrand } from "@/lib/email/brand";
import { renderBookingEmail, renderInternalBookingEmail } from "@/lib/email/templates/bookings";
import { otherTestGarage, testGarage } from "./support/garage";

function bookingFor(garage = testGarage()) {
  return {
    brand: garageEmailBrand(garage),
    customerName: "Test Customer",
    reference: `${garage.bookingPrefix}-4821`,
    service: "Vehicle Diagnostics",
    vehicle: "AB12 CDE · Vauxhall Astra",
    date: "Thursday, 20 August 2026",
    startTime: "09:30",
    endTime: "10:30",
    duration: "60 minutes",
    timezone: "Europe/London (UK time)",
    location: `${garage.name} workshop`,
    previousAppointment: "Tuesday, 18 August 2026 at 09:30–10:30",
    googleCalendarUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE",
    calendarUrl: `https://${garage.slug}.autofix.vitalos.co.uk/api/bookings/calendar/${garage.bookingPrefix}-4821?signature=test`,
  };
}

describe("garage-branded booking email content", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TENANT_ROOT_DOMAIN", "autofix.vitalos.co.uk");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://autofix.vitalos.co.uk");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("includes complete appointment details and garage calendar actions", () => {
    const rendered = renderBookingEmail({ ...bookingFor(), type: "confirmed" });
    for (const value of ["Test Customer", "AB12 CDE", "Vehicle Diagnostics", "Thursday, 20 August 2026", "09:30", "10:30", "60 minutes", "Europe/London", "HRM-4821"]) {
      expect(rendered.html).toContain(value);
    }
    expect(rendered.html).toContain("Your Hartley Road Motors appointment is confirmed.");
    expect(rendered.html).toContain("Manage booking");
    expect(rendered.html).toContain('href="https://hartley-road.autofix.vitalos.co.uk/manage"');
    expect(rendered.html).toContain("Add to Google Calendar");
    expect(rendered.html).toContain("Add to Calendar");
    expect(rendered.html).not.toContain("Cal.com");
  });

  it("carries the garage's name, colour and contact details, sent on its behalf", () => {
    const rendered = renderBookingEmail({ ...bookingFor(), type: "confirmed" });
    expect(rendered.html).toContain("Hartley Road Motors Ltd");
    expect(rendered.html).toContain("01302 000101");
    expect(rendered.html).toContain("bookings@hartleyroad.example");
    expect(rendered.html).toContain("4 Hartley Road, Doncaster, DN1 2AB");
    expect(rendered.html).toContain("background:#0f766e");
    expect(rendered.html).toContain("Sent by Autofix on behalf of Hartley Road Motors");
    expect(rendered.text.split("\n")[0]).toBe("HARTLEY ROAD MOTORS");
    expect(rendered.text).toContain("Sent by Autofix on behalf of Hartley Road Motors");
    expect(`${rendered.html}${rendered.text}`).not.toMatch(/SOB|sobautofix/i);
  });

  it("never mixes another garage's facts into the email", () => {
    const rendered = renderBookingEmail({ ...bookingFor(otherTestGarage()), type: "confirmed" });
    expect(rendered.html).toContain("Demo Garage B");
    expect(rendered.html).toContain("https://demo-b.autofix.vitalos.co.uk/manage");
    expect(rendered.html).not.toContain("Hartley Road");
  });

  it("makes the new appointment dominant and shows the previous time secondarily", () => {
    const booking = bookingFor();
    const rendered = renderBookingEmail({ ...booking, type: "rescheduled" });
    expect(rendered.html).toContain("Your appointment has been rescheduled.");
    expect(rendered.html).toContain("Previous appointment");
    expect(rendered.html).toContain(booking.previousAppointment);
    expect(rendered.html).toContain("Add to Google Calendar");
  });

  it("removes active calendar actions from the cancellation message", () => {
    const rendered = renderBookingEmail({ ...bookingFor(), type: "cancelled" });
    expect(rendered.html).toContain("BOOKING CANCELLED");
    expect(rendered.html).toContain("Book another appointment");
    expect(rendered.html).toContain('href="https://hartley-road.autofix.vitalos.co.uk/"');
    expect(rendered.html).not.toContain(">Manage booking<");
    expect(rendered.html).not.toContain("Add to Google Calendar");
    expect(rendered.html).not.toContain(">Add to Calendar<");
  });

  it("renders the staff booking alert with customer contact, notes and an admin link", () => {
    const rendered = renderInternalBookingEmail({ ...bookingFor(), type: "confirmed", customerEmail: "customer@example.com", customerPhone: "07700 900123", notes: "Intermittent warning light" });
    for (const value of ["NEW BOOKING", "customer@example.com", "07700 900123", "Intermittent warning light", "HRM-4821"]) expect(rendered.text).toContain(value);
    expect(rendered.html).toContain("View bookings");
    expect(rendered.html).toContain('href="https://autofix.vitalos.co.uk/app/bookings"');
  });
});
