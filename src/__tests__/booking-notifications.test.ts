import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Garage } from "@/lib/tenancy/garage";
import { createFakeSupabase, filterValue, type FakeQuery, type FakeResult } from "./support/fake-supabase";
import { otherTestGarage, testGarage } from "./support/garage";

const harness = vi.hoisted(() => ({
  sendTransactionalEmail: vi.fn(async (message: Record<string, unknown>) => {
    void message;
    return { data: { id: "re_123" }, error: null };
  }),
  hostGarage: null as Garage | null,
  adminClient: null as unknown,
}));
vi.mock("@/lib/email/resend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/resend")>()),
  sendTransactionalEmail: harness.sendTransactionalEmail,
}));
vi.mock("@/lib/tenancy/garage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenancy/garage")>()),
  getHostGarage: vi.fn(async () => harness.hostGarage),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => harness.adminClient }));

import { GET as calendarRoute } from "@/app/api/bookings/calendar/[reference]/route";
import { deriveManageToken, hashManageToken } from "@/lib/booking-engine/manage";
import { bookingCalendarDownloadUrl } from "@/lib/bookings/calendar";
import { loadBookingNotificationContext, type BookingNotificationContext } from "@/lib/bookings/notification-context";
import { bookingNotificationKey, composeBookingNotifications, sendBookingNotifications } from "@/lib/bookings/notifications";
import { previewBookingContext } from "@/lib/email/preview-fixtures";
import { clearMockOutbox, getMockOutbox } from "@/lib/messaging/mock";
import { NextRequest } from "next/server";

const garage = testGarage();
const BOOKING = "55555555-5555-4555-8555-555555555555";
const KEY = "f5898238-32a1-4764-b57b-529fa953c941";
const TOKEN_PATTERN = /manage\?token=[A-Za-z0-9_-]{43}/;

function context(overrides: { booking?: Partial<BookingNotificationContext["booking"]>; customer?: Partial<BookingNotificationContext["customer"]>; garage?: Partial<Garage> } = {}): BookingNotificationContext {
  const base = previewBookingContext(testGarage(overrides.garage));
  return {
    ...base,
    booking: { ...base.booking, ...overrides.booking },
    customer: { ...base.customer, ...overrides.customer },
    manageToken: deriveManageToken(garage.id, KEY),
  };
}

describe("composeBookingNotifications", () => {
  it("confirmed: customer email with a signed manage link and .ics, staff alert, and the booking_confirmed text", () => {
    const composed = composeBookingNotifications(context(), "created");
    expect(composed.kind).toBe("confirmed");
    expect(composed.customerEmail).toMatchObject({ to: "alexandra@example.com", subject: "Your Hartley Road Motors booking HRM-4821", replyTo: "bookings@hartleyroad.example" });
    expect(composed.customerEmail?.html).toMatch(TOKEN_PATTERN);
    expect(composed.customerEmail?.html).toContain("Hartley Road Motors");
    const [attachment] = composed.customerEmail?.attachments ?? [];
    expect(attachment?.filename).toBe("HRM-4821.ics");
    const ics = attachment?.content.toString("utf8") ?? "";
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("ORGANIZER;CN=Hartley Road Motors:mailto:bookings@hartleyroad.example");
    expect(ics).not.toContain("token=");

    expect(composed.staffEmail).toMatchObject({ to: "bookings@hartleyroad.example", subject: "New booking HRM-4821", replyTo: "alexandra@example.com" });
    expect(composed.staffEmail?.html).toContain("+447700900123");

    expect(composed.textMessage?.channel).toBe("sms");
    expect(composed.textMessage?.to).toBe("+447700900123");
    expect(composed.textMessage?.body).toMatch(/^Hartley Road Motors: you're booked in for Vehicle diagnostics and intermittent electrical fault investigation on Thu 20 Aug at 10:30\. Ref HRM-4821\. Change or cancel: http:\/\/hartley-road\.localhost:3000\/manage\?token=[A-Za-z0-9_-]{43}\nReply STOP to opt out\.$/);
    expect(composed.textMessage?.body).not.toContain("AB12");
  });

  it("requested: says the garage will confirm, and the calendar entry is tentative", () => {
    const composed = composeBookingNotifications(context({ booking: { status: "requested" } }), "created");
    expect(composed.kind).toBe("requested");
    expect(composed.customerEmail?.subject).toBe("Your Hartley Road Motors booking request HRM-4821");
    expect(composed.customerEmail?.html).toContain("We&#39;ve got your booking request.");
    expect(composed.calendar).toContain("STATUS:TENTATIVE");
    expect(composed.staffEmail?.subject).toBe("Booking request HRM-4821 needs your OK");
    expect(composed.staffEmail?.html).toContain("NEEDS YOUR OK");
    expect(composed.textMessage?.body).toContain("we've got your request");
  });

  it("rescheduled: shows the previous time and versions the key by the new start", () => {
    const moved = composeBookingNotifications(context(), "rescheduled", { previousStartsAt: "2026-08-18T08:00:00.000Z" });
    expect(moved.kind).toBe("rescheduled");
    expect(moved.customerEmail?.html).toContain("Previous appointment");
    expect(moved.customerEmail?.html).toContain("Tuesday, 18 August 2026 at 09:00");
    expect(moved.textMessage?.body).toContain("has moved to Thu 20 Aug at 10:30");
    const again = composeBookingNotifications(context({ booking: { startsAt: "2026-08-21T09:30:00.000Z", endsAt: "2026-08-21T11:00:00.000Z" } }), "rescheduled");
    expect(again.key).not.toBe(moved.key);
  });

  it("cancelled: cancels the calendar event and links back to booking, not to manage", () => {
    const composed = composeBookingNotifications(context({ booking: { status: "cancelled" } }), "cancelled");
    expect(composed.calendar).toContain("METHOD:CANCEL");
    expect(composed.customerEmail?.html).toContain("Book another appointment");
    expect(composed.customerEmail?.html).not.toContain("Add to Google Calendar");
    expect(composed.textMessage?.body).toContain("is cancelled. Book again: http://hartley-road.localhost:3000");
    expect(composed.textMessage?.body).not.toContain("token=");
  });

  it("texts only on the customer's chosen channel and never after an opt-out", () => {
    expect(composeBookingNotifications(context({ customer: { channel: "whatsapp" } }), "created").textMessage?.channel).toBe("whatsapp");
    const email = composeBookingNotifications(context({ customer: { channel: "email" } }), "created");
    expect(email.textMessage).toBeNull();
    expect(email.textSkipReason).toBe("channel_email");
    const optedOut = composeBookingNotifications(context({ customer: { optedOutAt: "2026-08-01T10:00:00Z" } }), "created");
    expect(optedOut.textMessage).toBeNull();
    expect(optedOut.textSkipReason).toBe("opted_out");
    expect(optedOut.customerEmail).not.toBeNull();
    expect(composeBookingNotifications(context({ customer: { phone: null } }), "created").textSkipReason).toBe("no_mobile");
  });

  it("skips the customer email without an address and the staff alert without a garage email", () => {
    expect(composeBookingNotifications(context({ customer: { email: null } }), "created").customerEmail).toBeNull();
    expect(composeBookingNotifications(context({ garage: { email: null } }), "created").staffEmail).toBeNull();
  });

  it("brands each garage's messages with that garage only", () => {
    const composed = composeBookingNotifications(previewBookingContext(otherTestGarage()), "created");
    expect(composed.customerEmail?.html).toContain("Demo Garage B");
    expect(composed.customerEmail?.html).not.toContain("Hartley Road");
    expect(composed.textMessage?.body).toMatch(/^Demo Garage B:/);
  });

  it("keys notifications per garage and booking event", () => {
    const booking = { reference: "HRM-4821", startsAt: "2026-08-20T09:30:00.000Z" };
    expect(bookingNotificationKey(garage.id, booking, "confirmed")).toBe(bookingNotificationKey(garage.id, { ...booking }, "confirmed"));
    expect(bookingNotificationKey(garage.id, booking, "confirmed")).not.toBe(bookingNotificationKey(otherTestGarage().id, booking, "confirmed"));
    expect(bookingNotificationKey(garage.id, booking, "cancelled")).toBe(bookingNotificationKey(garage.id, { ...booking, startsAt: "2026-08-21T09:30:00.000Z" }, "cancelled"));
  });
});

// ---------------------------------------------------------------------------

function garageRow() {
  return {
    id: garage.id, slug: garage.slug, name: garage.name, legal_name: garage.legalName, company_number: garage.companyNumber,
    phone: garage.phone, whatsapp: garage.whatsapp, email: garage.email, address: garage.address, timezone: "Europe/London",
    logo_url: null, accent: garage.accent, plan: "growth", mot_enabled: false, booking_prefix: "HRM", status: "active", settings: {}, garage_domains: [],
  };
}

function bookingRow(overrides: Record<string, unknown> = {}, customer: Record<string, unknown> = {}) {
  return {
    id: BOOKING, reference: "HRM-4821", status: "confirmed", starts_at: "2026-11-20T10:00:00+00:00", ends_at: "2026-11-20T11:00:00+00:00",
    location_mode: "workshop", postcode: null, address: null, notes: "Rattle", symptoms: ["Noise"], created_at: "2026-11-18T09:00:00+00:00",
    updated_at: "2026-11-18T09:00:00+00:00", cancellation_reason: null, idempotency_key: KEY,
    manage_token_hash: hashManageToken(deriveManageToken(garage.id, KEY)),
    services: { name: "Full service" },
    customers: { id: "66666666-6666-4666-8666-666666666666", name: "Sam Patel", email: "sam@example.com", phone: "+447700900123", channel: "sms", opted_out_at: null, ...customer },
    vehicles: { registration: "AB12CDE", make: "Vauxhall", model: "Astra" },
    ...overrides,
  };
}

function database(options: { booking?: Record<string, unknown> | null; reservationError?: FakeResult["error"] } = {}) {
  return createFakeSupabase({
    from: (query: FakeQuery): FakeResult => {
      if (query.table === "garages") return { data: garageRow() };
      if (query.table === "bookings") return { data: options.booking === undefined ? bookingRow() : options.booking };
      if (query.table === "booking_events") return query.operation === "select" ? { count: 1 } : { data: null };
      if (query.table === "booking_notification_events") return query.operation === "insert" ? { error: options.reservationError ?? null } : { data: null };
      return { data: null };
    },
  });
}

describe("sendBookingNotifications", () => {
  beforeEach(() => {
    clearMockOutbox();
    harness.sendTransactionalEmail.mockClear();
  });

  it("mock mode (the default): records customer email, staff alert and SMS in the mock outbox, sends nothing", async () => {
    const fake = database();
    const outcomes = await sendBookingNotifications({ type: "created", garageId: garage.id, bookingId: BOOKING }, { client: fake.client, env: {} });
    expect(outcomes.map((outcome) => `${outcome.kind}:${outcome.status}`).sort()).toEqual(["customer_email:sent", "sms:sent", "staff_email:sent"]);
    expect(harness.sendTransactionalEmail).not.toHaveBeenCalled();
    const outbox = getMockOutbox();
    expect(outbox.map((entry) => `${entry.kind}:${entry.to}`).sort()).toEqual(["email:bookings@hartleyroad.example", "email:sam@example.com", "sms:+447700900123"]);
    expect(outbox.every((entry) => entry.garageId === garage.id)).toBe(true);
    expect(outbox.find((entry) => entry.kind === "sms")?.senderId).toBeUndefined();

    const reservations = fake.queries.filter((query) => query.table === "booking_notification_events" && query.operation === "insert");
    expect(reservations.map((query) => (query.values as { notification_key: string }).notification_key).sort()).toEqual([
      `${garage.id}:HRM-4821:confirmed:once`,
      `${garage.id}:HRM-4821:confirmed:once:internal`,
      `${garage.id}:HRM-4821:confirmed:once:sms`,
    ]);
    const events = fake.queries.filter((query) => query.table === "booking_events" && query.operation === "insert");
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.values).toMatchObject({ garage_id: garage.id, booking_id: BOOKING, type: "notification_sent", actor: "system" });
      const text = JSON.stringify(event.values);
      expect(text).not.toMatch(/sam@example\.com|\+447700900123|AB12CDE|Rattle/);
    }
    const contextQuery = fake.queries.find((query) => query.table === "bookings")!;
    expect(filterValue(contextQuery, "eq", "garage_id")).toBe(garage.id);
  });

  it("live mode: sends email through Resend with the .ics attached, under the garage's name", async () => {
    const outcomes = await sendBookingNotifications({ type: "created", garageId: garage.id, bookingId: BOOKING }, { client: database().client, env: { MESSAGING_MODE: "live" } });
    expect(harness.sendTransactionalEmail).toHaveBeenCalledTimes(2);
    const customer = harness.sendTransactionalEmail.mock.calls.map(([message]) => message).find((message) => message.to === "sam@example.com")!;
    expect(customer).toMatchObject({ senderName: "Hartley Road Motors", replyTo: "bookings@hartleyroad.example", subject: "Your Hartley Road Motors booking HRM-4821" });
    expect((customer.attachments as Array<{ filename: string }>)[0]?.filename).toBe("HRM-4821.ics");
    expect(String(customer.idempotencyKey)).toContain(garage.id);
    // Without Twilio credentials the live SMS channel fails closed.
    expect(outcomes.find((outcome) => outcome.kind === "sms")).toEqual({ kind: "sms", status: "failed", code: "configuration_required" });
    expect(getMockOutbox()).toEqual([]);
  });

  it("re-checks the opt-out at send time: no text, email still goes", async () => {
    const outcomes = await sendBookingNotifications({ type: "created", garageId: garage.id, bookingId: BOOKING }, { client: database({ booking: bookingRow({}, { opted_out_at: "2026-11-18T08:00:00Z" }) }).client, env: {} });
    expect(outcomes).toContainEqual({ kind: "sms", status: "skipped", code: "opted_out" });
    expect(getMockOutbox().some((entry) => entry.kind === "sms")).toBe(false);
    expect(getMockOutbox().some((entry) => entry.to === "sam@example.com")).toBe(true);
  });

  it("uses WhatsApp only when the customer chose it", async () => {
    await sendBookingNotifications({ type: "created", garageId: garage.id, bookingId: BOOKING }, { client: database({ booking: bookingRow({}, { channel: "whatsapp" }) }).client, env: {} });
    expect(getMockOutbox().map((entry) => entry.kind).sort()).toEqual(["email", "email", "whatsapp"]);
  });

  it("never sends a reserved notification twice", async () => {
    const outcomes = await sendBookingNotifications({ type: "created", garageId: garage.id, bookingId: BOOKING }, { client: database({ reservationError: { code: "23505", message: "duplicate" } }).client, env: {} });
    expect(outcomes.every((outcome) => outcome.status === "duplicate")).toBe(true);
    expect(getMockOutbox()).toEqual([]);
  });

  it("does nothing for an unknown booking or without a database", async () => {
    expect(await sendBookingNotifications({ type: "created", garageId: garage.id, bookingId: BOOKING }, { client: database({ booking: null }).client, env: {} })).toEqual([]);
    expect(await sendBookingNotifications({ type: "created", garageId: garage.id, bookingId: BOOKING }, { client: null, env: {} })).toEqual([]);
  });
});

describe("booking notification context", () => {
  it("loads one garage's booking with the re-derivable manage token and calendar sequence", async () => {
    const fake = database();
    const loaded = await loadBookingNotificationContext(fake.client, garage.id, { reference: "HRM-4821" });
    expect(loaded).toMatchObject({
      booking: { id: BOOKING, startsAt: "2026-11-20T10:00:00.000Z", location: "Hartley Road Motors workshop, 4 Hartley Road, Doncaster, DN1 2AB", symptoms: ["Noise"] },
      customer: { channel: "sms", optedOutAt: null },
      manageToken: deriveManageToken(garage.id, KEY),
      calendarSequence: 1,
    });
    const bookingQuery = fake.queries.find((query) => query.table === "bookings")!;
    expect(filterValue(bookingQuery, "eq", "garage_id")).toBe(garage.id);
    expect(filterValue(bookingQuery, "eq", "reference")).toBe("HRM-4821");
  });
});

describe("GET /api/bookings/calendar/[reference]", () => {
  beforeEach(() => {
    vi.stubEnv("BOOKING_MANAGEMENT_SECRET", "calendar-route-test-secret-with-entropy");
    harness.hostGarage = garage;
    harness.adminClient = database().client;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("serves the signed .ics for the host garage's booking", async () => {
    const url = new URL(bookingCalendarDownloadUrl(garage, "HRM-4821")!);
    const response = await calendarRoute(new NextRequest(`https://hartley-road.autofix.vitalos.co.uk${url.pathname}${url.search}`), { params: Promise.resolve({ reference: "HRM-4821" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    const body = await response.text();
    expect(body).toContain("UID:HRM-4821.hartley-road@");
    expect(body).toContain("SEQUENCE:1");
  });

  it("404s a signature made for another garage", async () => {
    const url = new URL(bookingCalendarDownloadUrl(otherTestGarage(), "HRM-4821")!);
    const response = await calendarRoute(new NextRequest(`https://hartley-road.autofix.vitalos.co.uk${url.pathname}${url.search}`), { params: Promise.resolve({ reference: "HRM-4821" }) });
    expect(response.status).toBe(404);
  });
});
