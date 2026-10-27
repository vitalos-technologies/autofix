// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeBookingEngine, FAKE_SERVICE_IDS } from "@/lib/booking-engine/fake";
import type { BookingDraft } from "@/lib/booking-engine/types";
import type { Garage } from "@/lib/tenancy/garage";
import { testGarage } from "./support/garage";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const jar = new Map<string, string>();
const harness = { garage: testGarage({ motEnabled: true }) as Garage };

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }),
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
// The step forms post to server actions; the pages only need their identity here.
vi.mock("@/lib/booking-flow/actions", () => ({
  vehicleStepAction: vi.fn(async (state: unknown) => state),
  serviceStepAction: vi.fn(async (state: unknown) => state),
  timeStepAction: vi.fn(async (state: unknown) => state),
  confirmBookingAction: vi.fn(async (state: unknown) => state),
}));

const { setBookingEngineForTests } = await import("@/lib/booking-engine");
const { BOOKING_STATE_COOKIE, JUST_BOOKED_COOKIE, sealBookingSession, sealJustBooked } = await import("@/lib/booking-engine/state");
const { default: VehiclePage } = await import("@/app/%5Fsite/[garageId]/page");
const { default: ServicePage } = await import("@/app/%5Fsite/[garageId]/service/page");
const { default: TimePage } = await import("@/app/%5Fsite/[garageId]/time/page");
const { default: DetailsPage } = await import("@/app/%5Fsite/[garageId]/details/page");
const { default: ConfirmedPage } = await import("@/app/%5Fsite/[garageId]/confirmed/[reference]/page");

const engine = createFakeBookingEngine({ now: () => new Date("2026-10-27T07:00:00.000Z") });

function params(): Promise<{ garageId: string }>;
function params<T extends Record<string, string>>(extra: T): Promise<{ garageId: string } & T>;
function params(extra: Record<string, string> = {}) {
  return Promise.resolve({ garageId: harness.garage.id, ...extra });
}

function saveDraft(draft: Partial<BookingDraft>) {
  jar.set(BOOKING_STATE_COOKIE, sealBookingSession({ v: 1, garageId: harness.garage.id, ...draft }));
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

const vehicle = { registration: "AB12CDE", make: "Vauxhall", model: "Astra", motExpiry: "2027-03-31" };

beforeEach(() => {
  jar.clear();
  harness.garage = testGarage({ motEnabled: true });
  engine.reset();
  setBookingEngineForTests(engine);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T07:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

afterAll(() => setBookingEngineForTests(null));

describe("booking step guards", () => {
  it("sends each step back to the first incomplete one", async () => {
    expect(await redirectOf(ServicePage({ params: params() }))).toBe("/");
    expect(await redirectOf(TimePage({ params: params(), searchParams: Promise.resolve({}) }))).toBe("/");
    expect(await redirectOf(DetailsPage({ params: params() }))).toBe("/");

    saveDraft({ vehicle });
    expect(await redirectOf(ServicePage({ params: params() }))).toBeNull();
    expect(await redirectOf(TimePage({ params: params(), searchParams: Promise.resolve({}) }))).toBe("/service");
    expect(await redirectOf(DetailsPage({ params: params() }))).toBe("/service");

    saveDraft({ vehicle, serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop" });
    expect(await redirectOf(TimePage({ params: params(), searchParams: Promise.resolve({ date: "2026-10-28" }) }))).toBeNull();
    expect(await redirectOf(DetailsPage({ params: params() }))).toBe("/time");

    saveDraft({ vehicle, serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop", startsAt: "2026-10-28T09:15:00.000Z" });
    expect(await redirectOf(DetailsPage({ params: params() }))).toBeNull();
  });

  it("ignores a draft sealed for another garage", async () => {
    jar.set(BOOKING_STATE_COOKIE, sealBookingSession({ v: 1, garageId: "22222222-2222-4222-8222-222222222222", vehicle }));
    expect(await redirectOf(ServicePage({ params: params() }))).toBe("/");
  });
});

describe("step pages", () => {
  it("has one visible h1 on the vehicle step and shows the MOT chip only when the garage has MOT on", async () => {
    saveDraft({ vehicle });
    render((await VehiclePage({ params: params() })) as ReactElement);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "What are we booking in?" })).toBeVisible();
    expect(screen.getByText("Vauxhall Astra")).toBeInTheDocument();
    expect(screen.getByTestId("vehicle-mot")).toHaveTextContent("MOT due 31 Mar 2027");
    cleanup();

    harness.garage = testGarage({ motEnabled: false });
    saveDraft({ vehicle });
    render((await VehiclePage({ params: params() })) as ReactElement);
    expect(screen.getByText("Vauxhall Astra")).toBeInTheDocument();
    expect(screen.queryByTestId("vehicle-mot")).not.toBeInTheDocument();
  });

  it("lists MOT on the service step only when the garage has MOT on, and hides Where? for one-mode services", async () => {
    saveDraft({ vehicle, serviceId: FAKE_SERVICE_IDS.fullService, locationMode: "workshop" });
    render((await ServicePage({ params: params() })) as ReactElement);
    expect(screen.getByRole("radio", { name: /MOT/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Full service/ })).toBeChecked();
    expect(screen.queryByRole("group", { name: "Where?" })).not.toBeInTheDocument();
    cleanup();

    harness.garage = testGarage({ motEnabled: false, serviceArea: ["DN1"] });
    saveDraft({ vehicle, serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop" });
    render((await ServicePage({ params: params() })) as ReactElement);
    expect(screen.queryByRole("radio", { name: /MOT/ })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Where?" })).toBeInTheDocument();
    cleanup();

    // No districts listed: create_booking() refuses mobile visits, so the flow never offers one.
    harness.garage = testGarage({ motEnabled: false, serviceArea: [] });
    saveDraft({ vehicle, serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop" });
    render((await ServicePage({ params: params() })) as ReactElement);
    expect(screen.queryByRole("group", { name: "Where?" })).not.toBeInTheDocument();
  });

  it("offers two weeks of days and the chosen date's times", async () => {
    saveDraft({ vehicle, serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop" });
    render((await TimePage({ params: params(), searchParams: Promise.resolve({ date: "2026-10-28" }) })) as ReactElement);
    const days = screen.getByRole("group", { name: "Choose a day" }).querySelectorAll("button");
    expect(days).toHaveLength(14);
    expect(screen.getByRole("button", { name: "Wednesday 28 October" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Sunday 1 November/ })).toBeDisabled();
    expect(screen.getByText("Live from the diary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a time" })).toBeDisabled();
  });

  it("shows the booking summary and an unticked consent box on the details step", async () => {
    saveDraft({ vehicle, serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop", startsAt: "2026-10-28T09:15:00.000Z" });
    render((await DetailsPage({ params: params() })) as ReactElement);
    expect(screen.getByText("AB12 CDE")).toBeInTheDocument();
    expect(screen.getByText("Diagnostics · Workshop")).toBeInTheDocument();
    expect(screen.getByText("Wed 28 Oct · 09:15")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("link", { name: "How we use your details" })).toHaveAttribute("href", "/privacy");
  });
});

describe("confirmation page", () => {
  const booked = {
    reference: "HRM-4821",
    status: "confirmed" as const,
    startsAt: "2026-10-28T09:15:00.000Z",
    endsAt: "2026-10-28T10:15:00.000Z",
    serviceName: "Diagnostics",
    locationMode: "workshop" as const,
    where: "Workshop, DN1",
    vehicleName: "Vauxhall Astra",
    registration: "AB12CDE",
    channel: "sms" as const,
    contactHint: "07••• •••412",
  };

  it("shows the booking to the browser that just made it", async () => {
    jar.set(JUST_BOOKED_COOKIE, sealJustBooked(harness.garage.id, booked));
    render((await ConfirmedPage({ params: params({ reference: "HRM-4821" }) })) as ReactElement);
    expect(screen.getByRole("heading", { level: 1, name: "You're booked in" })).toBeInTheDocument();
    expect(screen.getByText("HRM-4821")).toBeInTheDocument();
    expect(screen.getByText("Vauxhall Astra · AB12 CDE")).toBeInTheDocument();
    expect(screen.getByText("Wed 28 Oct, 09:15")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change or cancel" })).toHaveAttribute("href", "/manage");
    expect(screen.getByRole("link", { name: "Message the garage on WhatsApp" })).toHaveAttribute("href", "https://wa.me/447700900101");
    expect(screen.getByRole("link", { name: /Add to calendar/ }).getAttribute("href")).toMatch(/^\/api\/bookings\/calendar\/HRM-4821\?signature=/);
  });

  it("reveals nothing for a reference alone, another reference or another garage", async () => {
    for (const setup of [
      () => jar.clear(),
      () => jar.set(JUST_BOOKED_COOKIE, sealJustBooked(harness.garage.id, { ...booked, reference: "HRM-1111" })),
      () => jar.set(JUST_BOOKED_COOKIE, sealJustBooked("22222222-2222-4222-8222-222222222222", booked)),
    ]) {
      setup();
      const { container } = render((await ConfirmedPage({ params: params({ reference: "HRM-4821" }) })) as ReactElement);
      expect(screen.getByRole("heading", { level: 1, name: "Find your booking" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Find your booking/ })).toHaveAttribute("href", "/manage");
      expect(container.textContent).not.toMatch(/AB12|Astra|412|Diagnostics/);
      cleanup();
    }
  });
});
