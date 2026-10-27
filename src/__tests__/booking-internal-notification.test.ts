import { beforeEach, describe, expect, it, vi } from "vitest";
import { testGarage } from "./support/garage";

const harness = vi.hoisted(() => {
  const events: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const sends: Array<Record<string, unknown>> = [];
  const updateFilters: Array<[string, unknown]> = [];
  let failSend = false;
  const from = vi.fn((table: string) => ({
    async insert(value: Record<string, unknown>) {
      if (table === "booking_notification_events") events.push(value);
      if (table === "booking_audit_log") audits.push(value);
      return { error: null };
    },
    update() {
      const chain = {
        eq(field: string, value: unknown) {
          updateFilters.push([field, value]);
          return chain;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return chain;
    },
  }));
  return {
    events,
    audits,
    sends,
    updateFilters,
    from,
    setFailSend(value: boolean) { failSend = value; },
    get failSend() { return failSend; },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({ from: harness.from }) }));
vi.mock("@/lib/email/resend", () => ({
  sendTransactionalEmail: vi.fn(async (message: Record<string, unknown>) => {
    if (harness.failSend) throw new Error("provider down");
    harness.sends.push(message);
    return { data: { id: "provider-id" }, error: null };
  }),
}));

import { sendBookingNotification, type BookingNotificationDetails } from "@/lib/bookings/notifications";

const garage = testGarage();

const booking: BookingNotificationDetails = {
  id: "70ca0b0b-1df7-42f4-8fe1-329c54ace42d",
  reference: "HRM-4821",
  customerName: "Test Customer",
  customerEmail: "customer@example.com",
  customerPhone: "07700 900123",
  registration: "AB12CDE",
  vehicleName: "Vauxhall Astra",
  service: "Vehicle Diagnostic Assessment",
  appointmentStart: "2026-08-20T09:30:00.000Z",
  appointmentEnd: "2026-08-20T10:30:00.000Z",
  timezone: "Europe/London",
  location: "Hartley Road Motors workshop",
  calendarSequence: 0,
  calendarTimestamp: "2026-08-13T09:00:00.000Z",
  notes: "Intermittent warning light",
};

describe("garage booking email delivery", () => {
  beforeEach(() => {
    harness.events.length = 0;
    harness.audits.length = 0;
    harness.sends.length = 0;
    harness.updateFilters.length = 0;
    harness.setFailSend(false);
    harness.from.mockClear();
  });

  it("sends the customer email and the staff alert under the garage's name, each reserved per garage", async () => {
    await expect(sendBookingNotification(garage, booking, "confirmed")).resolves.toBe(true);
    expect(harness.sends).toHaveLength(2);
    expect(harness.sends).toEqual(expect.arrayContaining([
      expect.objectContaining({ senderName: "Hartley Road Motors", to: "customer@example.com", replyTo: "bookings@hartleyroad.example", subject: "Your Hartley Road Motors booking HRM-4821" }),
      expect.objectContaining({ senderName: "Hartley Road Motors", to: "bookings@hartleyroad.example", replyTo: "customer@example.com", subject: "New booking HRM-4821" }),
    ]));
    for (const message of harness.sends) expect(message).not.toHaveProperty("from");
    expect(harness.events.map((event) => event.notification_key)).toEqual(expect.arrayContaining([
      `${garage.id}:HRM-4821:confirmed:once`,
      `${garage.id}:HRM-4821:confirmed:once:internal`,
    ]));
    for (const event of harness.events) expect(event).toMatchObject({ garage_id: garage.id });
    expect(harness.updateFilters).toContainEqual(["garage_id", garage.id]);
    const customer = harness.sends.find((message) => message.to === "customer@example.com") as { attachments: Array<{ filename: string; content: Buffer }> };
    expect(customer.attachments[0]?.filename).toBe("HRM-4821.ics");
    expect(customer.attachments[0]?.content.toString("utf8")).toContain("UID:HRM-4821.hartley-road@");
  });

  it("sends no staff alert when the garage has no email address", async () => {
    await expect(sendBookingNotification(testGarage({ email: null }), booking, "confirmed")).resolves.toBe(true);
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]).toMatchObject({ to: "customer@example.com" });
    expect(harness.sends[0]).not.toHaveProperty("replyTo", expect.any(String));
  });

  it("records a failed delivery against the booking's garage", async () => {
    harness.setFailSend(true);
    await expect(sendBookingNotification(garage, booking, "cancelled")).resolves.toBe(false);
    expect(harness.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ garage_id: garage.id, booking_id: booking.id, action: "cancelled_email_failed" }),
    ]));
  });
});
