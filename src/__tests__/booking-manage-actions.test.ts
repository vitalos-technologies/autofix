import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedBooking, ManageOutcome } from "@/lib/booking-engine/manage";
import type { Garage } from "@/lib/tenancy/garage";
import { getRequest } from "./support/booking-routes";
import { otherTestGarage, testGarage } from "./support/garage";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const harness = vi.hoisted(() => ({
  jar: new Map<string, { value: string; options: Record<string, unknown> }>(),
  garage: null as unknown as Garage,
  hostGarage: null as unknown as Garage | null,
  blockedScopes: new Set<string>(),
  rateLimitCalls: [] as Array<[string, string]>,
  refreshes: 0,
  turnstile: vi.fn(async (token: string | undefined) => token === "passed"),
  findBookingForManage: vi.fn(),
  rescheduleBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (harness.jar.has(name) ? { name, value: harness.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      if (options?.maxAge === 0) harness.jar.delete(name);
      else harness.jar.set(name, { value, options });
    },
  }),
  headers: async () => new Headers({ host: "hartley-road.localhost:3000", "x-forwarded-for": "203.0.113.9" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ refresh: () => (harness.refreshes += 1) }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async (identifier: string, scope: string) => {
    harness.rateLimitCalls.push([identifier, scope]);
    return !harness.blockedScopes.has(scope);
  }),
}));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: harness.turnstile }));
vi.mock("@/lib/tenancy/garage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenancy/garage")>()),
  getGarage: async () => harness.garage,
  getHostGarage: async () => harness.hostGarage,
}));
vi.mock("@/lib/booking-engine/manage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-engine/manage")>()),
  findBookingForManage: harness.findBookingForManage,
  rescheduleBooking: harness.rescheduleBooking,
  cancelBooking: harness.cancelBooking,
}));

const { createManageSession, MANAGE_COOKIE, readManageSession } = await import("@/lib/booking-engine/manage");
const { manageErrorMessages } = await import("@/lib/booking-engine/manage-schema");
const { cancelBookingAction, forgetManagedBookingAction, lookupBookingAction, rescheduleBookingAction } = await import("@/lib/booking-flow/manage-actions");
const { initialManageCancelFormState, initialManageLookupFormState, initialManageRescheduleFormState } = await import("@/lib/booking-flow/forms");
const { GET: openLink } = await import("@/app/%5Fsite/[garageId]/manage/link/route");
const { GET: oldManagePage } = await import("@/app/%5Fsite/[garageId]/manage-booking/route");

const garage = testGarage();
const other = otherTestGarage();
const BOOKING = "55555555-5555-4555-8555-555555555555";
const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx";
const REGISTRATION = "AB12CDE";

function managed(overrides: Partial<ManagedBooking> = {}): ManagedBooking {
  return {
    id: BOOKING,
    garageId: garage.id,
    customerName: "Sam Patel",
    customerPhone: "+447700900412",
    postcode: null,
    reference: "HRM-4821",
    status: "confirmed",
    startsAt: "2026-11-20T10:00:00.000Z",
    endsAt: "2026-11-20T11:00:00.000Z",
    locationMode: "workshop",
    service: { id: "33333333-3333-4333-8333-333333333333", name: "Full service" },
    vehicle: { registration: "AB12 CDE", make: "Vauxhall", model: "Astra" },
    customerFirstName: "Sam",
    canChange: true,
    changeDeadline: "2026-11-19T10:00:00.000Z",
    blockedReason: null,
    serviceId: "33333333-3333-4333-8333-333333333333",
    resourceId: "88888888-8888-4888-8888-888888888881",
    resourceKind: "bay",
    during: null,
    timeZone: "Europe/London",
    idempotencyKey: "f5898238-32a1-4764-b57b-529fa953c941",
    manageTokenHash: "a".repeat(64),
    ...overrides,
  };
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function redirectOf(action: Promise<unknown>) {
  try {
    const state = await action;
    return { state, redirect: null as string | null };
  } catch (error) {
    if (error instanceof RedirectSignal) return { state: null, redirect: error.url };
    throw error;
  }
}

function openSession(garageId = garage.id, bookingId = BOOKING) {
  harness.jar.set(MANAGE_COOKIE, { value: createManageSession(garageId, bookingId), options: {} });
}

function setCookieHeader(response: Response, name: string) {
  return (response.headers.get("set-cookie") ?? "").split(/,(?=\s*\w+=)/).find((part) => part.trim().startsWith(`${name}=`)) ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  harness.jar.clear();
  harness.garage = garage;
  harness.hostGarage = garage;
  harness.blockedScopes = new Set();
  harness.rateLimitCalls = [];
  harness.refreshes = 0;
  harness.findBookingForManage.mockResolvedValue(managed());
});

describe("lookupBookingAction (reference + registration)", () => {
  it("opens a 30-minute httpOnly session for the host's garage and shows the booking without anything in the URL", async () => {
    const { redirect } = await redirectOf(lookupBookingAction(initialManageLookupFormState, form({ reference: " hrm-4821 ", registration: "ab12 cde", garageId: other.id })));
    expect(redirect).toBe("/manage");
    expect(harness.findBookingForManage).toHaveBeenCalledWith({ garageId: garage.id, reference: "HRM-4821", registration: REGISTRATION });
    const cookie = harness.jar.get(MANAGE_COOKIE)!;
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 1800 });
    expect(readManageSession(cookie.value, garage.id)).toEqual({ bookingId: BOOKING });
    expect(readManageSession(cookie.value, other.id)).toBeNull();
    expect(cookie.value.toUpperCase()).not.toContain(REGISTRATION);
  });

  it("answers a wrong registration and an unknown reference the same way, without a session", async () => {
    harness.findBookingForManage.mockResolvedValue(null);
    const wrongRegistration = await lookupBookingAction(initialManageLookupFormState, form({ reference: "HRM-4821", registration: "ZZ99ZZZ" }));
    const unknownReference = await lookupBookingAction(initialManageLookupFormState, form({ reference: "HRM-9999", registration: REGISTRATION }));
    expect(wrongRegistration).toEqual({ seq: 1, message: manageErrorMessages.NOT_FOUND });
    expect(unknownReference).toEqual(wrongRegistration);
    expect(harness.jar.has(MANAGE_COOKIE)).toBe(false);
    // Nothing the customer typed comes back.
    expect(JSON.stringify([wrongRegistration, unknownReference])).not.toMatch(/ZZ99ZZZ|AB12CDE|HRM-/);
  });

  it("checks the format first, without touching the database or the rate limits", async () => {
    const state = await lookupBookingAction(initialManageLookupFormState, form({ reference: "4821", registration: "" }));
    expect(state.fieldErrors).toEqual({
      reference: "Enter your booking reference, for example HRM-4821.",
      registration: "Enter the car's registration, for example AB12 CDE.",
    });
    expect(harness.findBookingForManage).not.toHaveBeenCalled();
    expect(harness.rateLimitCalls).toEqual([]);
  });

  it("uses the API's rate-limit buckets and stops before the lookup when they are spent", async () => {
    harness.blockedScopes.add("booking_lookup_ip");
    expect(await lookupBookingAction(initialManageLookupFormState, form({ reference: "HRM-4821", registration: REGISTRATION }))).toEqual({ seq: 1, message: manageErrorMessages.RATE_LIMITED });
    expect(harness.rateLimitCalls).toEqual([[`${garage.id}:203.0.113.9`, "booking_lookup_ip"]]);

    harness.blockedScopes = new Set(["booking_lookup_details"]);
    harness.rateLimitCalls = [];
    await lookupBookingAction(initialManageLookupFormState, form({ reference: "HRM-4821", registration: REGISTRATION }));
    expect(harness.rateLimitCalls[1]).toEqual([`${garage.id}:203.0.113.9:HRM-4821:${REGISTRATION}`, "booking_lookup_details"]);
    expect(harness.findBookingForManage).not.toHaveBeenCalled();
  });

  it("asks for Turnstile when it is configured", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site");
    expect(await lookupBookingAction(initialManageLookupFormState, form({ reference: "HRM-4821", registration: REGISTRATION }))).toEqual({
      seq: 1,
      message: "Please complete the security check, then try again.",
    });
    expect(harness.findBookingForManage).not.toHaveBeenCalled();
    const { redirect } = await redirectOf(lookupBookingAction(initialManageLookupFormState, form({ reference: "HRM-4821", registration: REGISTRATION, turnstileToken: "passed" })));
    expect(redirect).toBe("/manage");
  });

  it("says so when bookings cannot be read", async () => {
    harness.findBookingForManage.mockRejectedValue(new Error("db down"));
    expect(await lookupBookingAction(initialManageLookupFormState, form({ reference: "HRM-4821", registration: REGISTRATION }))).toEqual({ seq: 1, message: manageErrorMessages.UNAVAILABLE });
    expect(harness.jar.has(MANAGE_COOKIE)).toBe(false);
  });
});

describe("rescheduleBookingAction", () => {
  it("needs an open session for this garage", async () => {
    expect((await redirectOf(rescheduleBookingAction(initialManageRescheduleFormState, form({ startsAt: "2026-11-20T14:00:00.000Z" })))).redirect).toBe("/manage");
    openSession(other.id);
    expect((await redirectOf(rescheduleBookingAction(initialManageRescheduleFormState, form({ startsAt: "2026-11-20T14:00:00.000Z" })))).redirect).toBe("/manage");
    expect(harness.rescheduleBooking).not.toHaveBeenCalled();
  });

  it("moves the session's booking (never one named in the form) as the customer and says so", async () => {
    openSession();
    harness.rescheduleBooking.mockResolvedValue({ ok: true, changed: true, booking: managed({ startsAt: "2026-11-20T14:00:00.000Z" }) } satisfies ManageOutcome);
    const { redirect } = await redirectOf(
      rescheduleBookingAction(initialManageRescheduleFormState, form({ startsAt: "2026-11-20T14:00:00+00:00", bookingId: "99999999-9999-4999-8999-999999999999", garageId: other.id })),
    );
    expect(redirect).toBe("/manage?done=moved");
    expect(harness.findBookingForManage).toHaveBeenCalledWith({ garageId: garage.id, bookingId: BOOKING }, expect.any(Date));
    expect(harness.rescheduleBooking).toHaveBeenCalledWith({ garageId: garage.id, bookingId: BOOKING, startsAt: "2026-11-20T14:00:00.000Z", actor: "customer" });
    expect(harness.rateLimitCalls).toContainEqual([`203.0.113.9:${BOOKING}`, "booking_reschedule"]);
    // The session is renewed for the moved booking.
    expect(readManageSession(harness.jar.get(MANAGE_COOKIE)!.value, garage.id)).toEqual({ bookingId: BOOKING });
  });

  it("offers up to three free alternatives when the time has just gone", async () => {
    openSession();
    harness.rescheduleBooking.mockResolvedValue({
      ok: false,
      code: "SLOT_UNAVAILABLE",
      message: manageErrorMessages.SLOT_UNAVAILABLE,
      alternatives: [
        { startsAt: "2026-11-20T13:00:00.000Z", endsAt: "2026-11-20T14:00:00.000Z", freeCount: 1 },
        { startsAt: "2026-11-20T15:00:00.000Z", endsAt: "2026-11-20T16:00:00.000Z", freeCount: 0 },
        { startsAt: "2026-11-21T09:00:00.000Z", endsAt: "2026-11-21T10:00:00.000Z", freeCount: 2 },
        { startsAt: "2026-11-21T10:00:00.000Z", endsAt: "2026-11-21T11:00:00.000Z", freeCount: 2 },
        { startsAt: "2026-11-21T11:00:00.000Z", endsAt: "2026-11-21T12:00:00.000Z", freeCount: 2 },
      ],
    } satisfies ManageOutcome);
    const state = await rescheduleBookingAction(initialManageRescheduleFormState, form({ startsAt: "2026-11-20T14:00:00.000Z" }));
    expect(state.message).toBe("Sorry, that time has just gone. Choose another time.");
    expect(state.alternatives?.map((slot) => slot.startsAt)).toEqual(["2026-11-20T13:00:00.000Z", "2026-11-21T09:00:00.000Z", "2026-11-21T10:00:00.000Z"]);
    expect(harness.refreshes).toBe(1);
  });

  it("sends a booking inside the cutoff (or no longer changeable) back to the booking page", async () => {
    openSession();
    for (const code of ["CUTOFF_PASSED", "NOT_MODIFIABLE", "NOT_FOUND"] as const) {
      harness.rescheduleBooking.mockResolvedValueOnce({ ok: false, code, message: manageErrorMessages[code] } satisfies ManageOutcome);
      expect((await redirectOf(rescheduleBookingAction(initialManageRescheduleFormState, form({ startsAt: "2026-11-20T14:00:00.000Z" })))).redirect).toBe("/manage");
    }
  });

  it("asks for a time and respects the change rate limit", async () => {
    openSession();
    expect(await rescheduleBookingAction(initialManageRescheduleFormState, form({ startsAt: "soon" }))).toEqual({ seq: 1, message: "Choose a new time." });
    harness.blockedScopes.add("booking_reschedule");
    expect(await rescheduleBookingAction(initialManageRescheduleFormState, form({ startsAt: "2026-11-20T14:00:00.000Z" }))).toEqual({ seq: 1, message: manageErrorMessages.RATE_LIMITED });
    expect(harness.rescheduleBooking).not.toHaveBeenCalled();
  });
});

describe("cancelBookingAction", () => {
  it("cancels the session's booking with the customer's reason and says so", async () => {
    openSession();
    harness.cancelBooking.mockResolvedValue({ ok: true, changed: true, booking: managed({ status: "cancelled", canChange: false, blockedReason: "status" }) } satisfies ManageOutcome);
    const { redirect } = await redirectOf(cancelBookingAction(initialManageCancelFormState, form({ reason: "  Car   sold  " })));
    expect(redirect).toBe("/manage?done=cancelled");
    expect(harness.cancelBooking).toHaveBeenCalledWith({ garageId: garage.id, bookingId: BOOKING, actor: "customer", reason: "Car sold" });
    expect(harness.rateLimitCalls).toContainEqual([`203.0.113.9:${BOOKING}`, "booking_cancel"]);
  });

  it("passes no reason when none was given and honours the cutoff", async () => {
    openSession();
    harness.cancelBooking.mockResolvedValue({ ok: false, code: "CUTOFF_PASSED", message: manageErrorMessages.CUTOFF_PASSED } satisfies ManageOutcome);
    expect((await redirectOf(cancelBookingAction(initialManageCancelFormState, form({ reason: "   " })))).redirect).toBe("/manage");
    expect(harness.cancelBooking).toHaveBeenCalledWith(expect.objectContaining({ reason: null }));
  });

  it("needs a session and shows other failures on the form", async () => {
    expect((await redirectOf(cancelBookingAction(initialManageCancelFormState, form({})))).redirect).toBe("/manage");
    openSession();
    harness.cancelBooking.mockResolvedValue({ ok: false, code: "UNAVAILABLE", message: manageErrorMessages.UNAVAILABLE } satisfies ManageOutcome);
    expect(await cancelBookingAction(initialManageCancelFormState, form({}))).toEqual({ seq: 1, message: manageErrorMessages.UNAVAILABLE });
  });
});

describe("forgetManagedBookingAction", () => {
  it("closes the session on this device", async () => {
    openSession();
    expect((await redirectOf(forgetManagedBookingAction())).redirect).toBe("/manage");
    expect(harness.jar.has(MANAGE_COOKIE)).toBe(false);
  });
});

describe("GET /manage/link (the signed link from the email)", () => {
  const context = (garageId = garage.id) => ({ params: Promise.resolve({ garageId }) });

  it("opens the booking, sets the session and sends the browser to /manage without the token", async () => {
    const response = await openLink(getRequest(`/manage/link?token=${TOKEN}`), context());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/manage");
    expect(response.headers.get("location")).not.toContain(TOKEN);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(harness.findBookingForManage).toHaveBeenCalledWith({ garageId: garage.id, token: TOKEN });
    const cookie = setCookieHeader(response, MANAGE_COOKIE);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=1800/i);
    const value = decodeURIComponent(cookie.split(";")[0]!.split("=").slice(1).join("="));
    expect(readManageSession(value, garage.id)).toEqual({ bookingId: BOOKING });
    expect(cookie).not.toContain(TOKEN);
  });

  it("sends a link that opens nothing to the lookup form and drops any earlier session", async () => {
    harness.findBookingForManage.mockResolvedValue(null);
    const unknown = await openLink(getRequest(`/manage/link?token=${TOKEN}`, { cookie: `${MANAGE_COOKIE}=${createManageSession(garage.id, BOOKING)}` }), context());
    expect(unknown.status).toBe(303);
    expect(unknown.headers.get("location")).toBe("/manage?link=invalid");
    expect(setCookieHeader(unknown, MANAGE_COOKIE)).toMatch(/Max-Age=0/i);

    harness.findBookingForManage.mockClear();
    const malformed = await openLink(getRequest("/manage/link?token=nope"), context());
    expect(malformed.headers.get("location")).toBe("/manage?link=invalid");
    expect(harness.findBookingForManage).not.toHaveBeenCalled();
  });

  it("rate-limits links like the API and refuses a garage that is not the host's", async () => {
    harness.blockedScopes.add("booking_manage_link");
    const limited = await openLink(getRequest(`/manage/link?token=${TOKEN}`), context());
    expect(limited.headers.get("location")).toBe("/manage?link=limited");
    expect(harness.rateLimitCalls).toEqual([[`${garage.id}:198.51.100.7`, "booking_manage_link"]]);

    harness.blockedScopes = new Set();
    const crossed = await openLink(getRequest(`/manage/link?token=${TOKEN}`), context(other.id));
    expect(crossed.status).toBe(404);
    expect(setCookieHeader(crossed, MANAGE_COOKIE)).toBe("");
  });

  it("reports a database failure without opening anything", async () => {
    harness.findBookingForManage.mockRejectedValue(new Error("db down"));
    const response = await openLink(getRequest(`/manage/link?token=${TOKEN}`), context());
    expect(response.headers.get("location")).toBe("/manage?link=unavailable");
  });
});

describe("GET /manage-booking (SOB's old address)", () => {
  it("redirects permanently to /manage, passing on a well-formed link token only", () => {
    const plain = oldManagePage(getRequest("/manage-booking?reference=HRM-4821&registration=AB12CDE"));
    expect(plain.status).toBe(308);
    expect(plain.headers.get("location")).toBe("/manage");
    const linked = oldManagePage(getRequest(`/manage-booking?token=${TOKEN}`));
    expect(linked.headers.get("location")).toBe(`/manage?token=${TOKEN}`);
    expect(oldManagePage(getRequest("/manage-booking?token=<script>")).headers.get("location")).toBe("/manage");
  });
});
