// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedBooking } from "@/lib/booking-engine/manage";
import type { Slot } from "@/lib/booking-engine/types";
import type { Garage } from "@/lib/tenancy/garage";
import { otherTestGarage, testGarage } from "./support/garage";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const harness = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  garage: null as unknown as Garage,
  booking: null as ManagedBooking | null,
  slots: [] as Slot[],
  slotQueries: [] as unknown[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (harness.jar.has(name) ? { name, value: harness.jar.get(name)! } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/tenancy/garage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenancy/garage")>()),
  requireSiteGarage: async (garageId: string) => {
    if (garageId !== harness.garage.id) throw new Error("NEXT_NOT_FOUND");
    return harness.garage;
  },
}));
vi.mock("@/lib/booking-flow/manage-actions", () => ({
  lookupBookingAction: vi.fn(async (state: unknown) => state),
  rescheduleBookingAction: vi.fn(async (state: unknown) => state),
  cancelBookingAction: vi.fn(async (state: unknown) => state),
  forgetManagedBookingAction: vi.fn(async () => undefined),
}));
vi.mock("@/lib/booking-engine/manage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-engine/manage")>()),
  findBookingForManage: vi.fn(async (input: { garageId: string; bookingId?: string }) =>
    harness.booking && input.garageId === harness.booking.garageId && input.bookingId === harness.booking.id ? harness.booking : null,
  ),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/booking-engine/slots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-engine/slots")>()),
  fetchAvailableSlots: vi.fn(async (_client: unknown, query: unknown) => {
    harness.slotQueries.push(query);
    return harness.slots;
  }),
}));

const { createManageSession, MANAGE_COOKIE } = await import("@/lib/booking-engine/manage");
const { cutoffWindow, manageBookingState } = await import("@/lib/booking-flow/manage-view");
const { default: ManagePage } = await import("@/app/%5Fsite/[garageId]/manage/page");
const { default: ReschedulePage } = await import("@/app/%5Fsite/[garageId]/manage/reschedule/page");
const { default: CancelPage } = await import("@/app/%5Fsite/[garageId]/manage/cancel/page");

const NOW = new Date("2026-11-18T09:00:00.000Z");
const BOOKING = "55555555-5555-4555-8555-555555555555";
const SERVICE = "33333333-3333-4333-8333-333333333333";

function managed(overrides: Partial<ManagedBooking> = {}): ManagedBooking {
  return {
    id: BOOKING,
    garageId: harness.garage.id,
    customerName: "Sam Patel",
    customerPhone: "+447700900412",
    postcode: null,
    reference: "HRM-4821",
    status: "confirmed",
    startsAt: "2026-11-20T10:00:00.000Z",
    endsAt: "2026-11-20T11:00:00.000Z",
    locationMode: "workshop",
    service: { id: SERVICE, name: "Full service" },
    vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
    customerFirstName: "Sam",
    canChange: true,
    changeDeadline: "2026-11-19T10:00:00.000Z",
    blockedReason: null,
    serviceId: SERVICE,
    resourceId: "88888888-8888-4888-8888-888888888881",
    resourceKind: "bay",
    during: null,
    timeZone: "Europe/London",
    idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
    manageTokenHash: "a".repeat(64),
    ...overrides,
  };
}

function params() {
  return Promise.resolve({ garageId: harness.garage.id });
}

function search(values: Record<string, string> = {}) {
  return Promise.resolve(values);
}

function openSession(booking: ManagedBooking) {
  harness.booking = booking;
  harness.jar.set(MANAGE_COOKIE, createManageSession(booking.garageId, booking.id));
}

async function redirectOf(page: Promise<unknown>) {
  try {
    await page;
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
}

async function renderManage(query: Record<string, string> = {}) {
  return render((await ManagePage({ params: params(), searchParams: search(query) })) as ReactElement);
}

beforeEach(() => {
  harness.jar.clear();
  harness.garage = testGarage({ motEnabled: true });
  harness.booking = null;
  harness.slots = [];
  harness.slotQueries = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("manage booking state", () => {
  it("maps statuses, the cutoff and the clock to what the customer can do", () => {
    const at = (overrides: Partial<ManagedBooking>) => manageBookingState(managed(overrides), NOW);
    expect(at({})).toBe("open");
    expect(at({ status: "requested" })).toBe("requested");
    expect(at({ canChange: false, blockedReason: "cutoff", startsAt: "2026-11-18T15:00:00.000Z" })).toBe("cutoff");
    expect(at({ canChange: false, blockedReason: "cutoff", startsAt: "2026-11-17T15:00:00.000Z" })).toBe("past");
    expect(at({ status: "arrived", canChange: false })).toBe("in_workshop");
    expect(at({ status: "ready", canChange: false })).toBe("in_workshop");
    expect(at({ status: "collected", canChange: false })).toBe("finished");
    expect(at({ status: "cancelled", canChange: false })).toBe("cancelled");
    expect(at({ status: "no_show", canChange: false })).toBe("no_show");
    expect(cutoffWindow(24)).toBe("24 hours");
    expect(cutoffWindow(48)).toBe("2 days");
    expect(cutoffWindow(1)).toBe("1 hour");
  });
});

describe("/manage", () => {
  it("hands a signed link to /manage/link (which drops it from the address)", async () => {
    expect(await redirectOf(ManagePage({ params: params(), searchParams: search({ token: "abc_DEF-123" }) }))).toBe("/manage/link?token=abc_DEF-123");
  });

  it("shows the lookup form without a session, with a note for a link that did not work or a closed session", async () => {
    await renderManage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Find your booking" })).toBeVisible();
    expect(screen.getByLabelText("Booking reference")).toHaveAttribute("placeholder", "HRM-1234");
    expect(screen.getByLabelText("Registration")).toHaveAttribute("autocomplete", "off");
    expect(screen.queryByText(/closes after 30 minutes/)).not.toBeInTheDocument();
    cleanup();

    await renderManage({ link: "invalid" });
    expect(screen.getByText("That link didn't open a booking")).toBeInTheDocument();
    cleanup();

    harness.jar.set(MANAGE_COOKIE, "expired.value");
    await renderManage();
    expect(screen.getByText(/closes after 30 minutes/)).toBeInTheDocument();
    cleanup();

    // A session issued on another garage's host opens nothing here.
    harness.booking = managed();
    harness.jar.set(MANAGE_COOKIE, createManageSession(otherTestGarage().id, BOOKING));
    await renderManage();
    expect(screen.getByRole("heading", { level: 1, name: "Find your booking" })).toBeVisible();
  });

  it("shows an open booking with the phone masked and the online changes", async () => {
    openSession(managed());
    const { container } = await renderManage();
    expect(screen.getByRole("heading", { level: 1, name: "Your booking" })).toBeVisible();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    const card = within(screen.getByRole("region", { name: "Booking details" }));
    expect(card.getByText("HRM-4821")).toBeInTheDocument();
    expect(card.getByText("Fri 20 Nov, 10:00")).toBeInTheDocument();
    expect(card.getByText("Ready around 11:00")).toBeInTheDocument();
    expect(card.getByText("AB12 CDE")).toBeInTheDocument();
    expect(card.getByText("Sam Patel")).toBeInTheDocument();
    expect(card.getByText("07••• •••412")).toHaveAttribute("aria-hidden", "true");
    expect(card.getByText("Mobile ending 412")).toHaveClass("sr-only");
    expect(card.getByText("4 Hartley Road, Doncaster, DN1 2AB")).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/\+447700900412|07700 ?900412|55555555/);
    expect(screen.getByRole("link", { name: "Change the time" })).toHaveAttribute("href", "/manage/reschedule");
    expect(screen.getByRole("link", { name: "Cancel booking" })).toHaveAttribute("href", "/manage/cancel");
    expect(screen.getByText("Free to change or cancel online until Thu 19 Nov, 10:00.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add to calendar" }).getAttribute("href")).toMatch(/^\/api\/bookings\/calendar\/HRM-4821\?signature=/);
    expect(screen.getByRole("link", { name: "Call the garage" })).toHaveAttribute("href", "tel:+441302000101");
    expect(screen.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("href", "https://wa.me/447700900101");
    expect(screen.getByRole("button", { name: "Look up another booking" })).toBeInTheDocument();
  });

  it("says it has moved straight after a change", async () => {
    openSession(managed());
    await renderManage({ done: "moved" });
    expect(screen.getByRole("status")).toHaveTextContent("Your booking has moved");
    expect(screen.getByRole("status")).toHaveTextContent("It's now on Fri 20 Nov, 10:00.");
  });

  it("asks the customer to call inside the cutoff", async () => {
    openSession(managed({ canChange: false, blockedReason: "cutoff", startsAt: "2026-11-18T15:00:00.000Z", endsAt: "2026-11-18T16:00:00.000Z" }));
    await renderManage();
    expect(screen.getByText("Too close to change online")).toBeInTheDocument();
    expect(screen.getByText(/in the last 24 hours before they start/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Change the time" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Cancel booking" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Call 01302 000101" })).toHaveAttribute("href", "tel:+441302000101");
  });

  it("shows a booking waiting for the garage's OK, still changeable, without a calendar file", async () => {
    openSession(managed({ status: "requested" }));
    await renderManage();
    expect(screen.getByText("Awaiting the garage's OK")).toBeInTheDocument();
    expect(screen.getByText("Hartley Road Motors will check the job and confirm the time with you.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change the time" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add to calendar" })).not.toBeInTheDocument();
  });

  it("offers a new booking once it is past, finished or cancelled", async () => {
    openSession(managed({ canChange: false, blockedReason: "cutoff", startsAt: "2026-11-17T10:00:00.000Z", endsAt: "2026-11-17T11:00:00.000Z" }));
    await renderManage();
    expect(screen.getByText("Time passed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book a car in" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: "Change the time" })).not.toBeInTheDocument();
    cleanup();

    openSession(managed({ status: "collected", canChange: false, blockedReason: "status" }));
    await renderManage();
    expect(screen.getByText("This booking is finished")).toBeInTheDocument();
    cleanup();

    openSession(managed({ status: "cancelled", canChange: false, blockedReason: "status" }));
    await renderManage({ done: "cancelled" });
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your booking is cancelled");
    expect(screen.queryByText("This booking was cancelled")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book a car in" })).toBeInTheDocument();
    cleanup();

    await renderManage();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("This booking was cancelled")).toBeInTheDocument();
  });

  it("shows a car that is already with the garage without online changes", async () => {
    openSession(managed({ status: "in_progress", canChange: false, blockedReason: "status" }));
    await renderManage();
    expect(screen.getByText("In the workshop")).toBeInTheDocument();
    expect(screen.getByText("Your car is with Hartley Road Motors")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Change the time" })).not.toBeInTheDocument();
  });
});

describe("/manage/reschedule and /manage/cancel", () => {
  it("need an open session and a booking that can still change online", async () => {
    const reschedule = () => ReschedulePage({ params: params(), searchParams: search() });
    const cancel = () => CancelPage({ params: params() });
    expect(await redirectOf(reschedule())).toBe("/manage");
    expect(await redirectOf(cancel())).toBe("/manage");
    openSession(managed({ canChange: false, blockedReason: "cutoff", startsAt: "2026-11-18T15:00:00.000Z" }));
    expect(await redirectOf(reschedule())).toBe("/manage");
    expect(await redirectOf(cancel())).toBe("/manage");
    openSession(managed({ status: "cancelled", canChange: false, blockedReason: "status" }));
    expect(await redirectOf(reschedule())).toBe("/manage");
  });

  it("offers two weeks of the booking's own service slots, with its current time taken", async () => {
    openSession(managed());
    harness.slots = [
      { startsAt: "2026-11-20T09:00:00.000Z", endsAt: "2026-11-20T10:00:00.000Z", freeCount: 2 },
      { startsAt: "2026-11-20T10:00:00.000Z", endsAt: "2026-11-20T11:00:00.000Z", freeCount: 2 },
      { startsAt: "2026-11-20T14:00:00.000Z", endsAt: "2026-11-20T15:00:00.000Z", freeCount: 0 },
    ];
    render((await ReschedulePage({ params: params(), searchParams: search() })) as ReactElement);
    expect(harness.slotQueries).toEqual([{ garageId: harness.garage.id, serviceId: SERVICE, from: "2026-11-18", to: "2026-12-01", locationMode: "workshop" }]);
    expect(screen.getByRole("heading", { level: 1, name: "Pick a new time" })).toBeVisible();
    expect(screen.getByText("Fri 20 Nov, 10:00")).toBeInTheDocument();
    // The strip opens on the booking's own day.
    expect(screen.getByRole("button", { name: "Friday 20 November" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "09:00" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "10:00 (taken)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "14:00 (taken)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose a new time" })).toBeDisabled();
  });

  it("asks for confirmation before cancelling", async () => {
    openSession(managed());
    render((await CancelPage({ params: params() })) as ReactElement);
    expect(screen.getByRole("heading", { level: 1, name: "Cancel this booking?" })).toBeVisible();
    expect(screen.getByText("Full service · Workshop")).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason/)).toHaveAttribute("maxlength", "300");
    expect(screen.getByRole("button", { name: "Cancel booking" })).toHaveAttribute("type", "submit");
    expect(screen.getByRole("link", { name: "Keep my booking" })).toHaveAttribute("href", "/manage");
  });
});
