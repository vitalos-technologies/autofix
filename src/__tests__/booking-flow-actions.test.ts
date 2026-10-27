import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDER_CONSENT_COPY, REMINDER_CONSENT_COPY_NO_MOT } from "@/components/book";
import { createFakeBookingEngine, FAKE_SERVICE_IDS, type FakeBookingEngine } from "@/lib/booking-engine/fake";
import type { BookingEngine, CreateBookingInput } from "@/lib/booking-engine/types";
import type { Garage } from "@/lib/tenancy/garage";
import { testGarage } from "./support/garage";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const jar = new Map<string, { value: string; options: Record<string, unknown> }>();
const harness = {
  garage: testGarage({ motEnabled: true }) as Garage,
  redirects: [] as string[],
  refreshes: 0,
  rateLimitOk: true,
  turnstileOk: (token: string | undefined) => token === "passed",
};

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, { value, options });
    },
  }),
  headers: async () => new Headers({ host: "hartley-road.localhost:3000", "x-forwarded-for": "203.0.113.9" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    harness.redirects.push(url);
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ refresh: () => (harness.refreshes += 1) }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: async () => harness.rateLimitOk }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async (token: string | undefined) => harness.turnstileOk(token) }));
vi.mock("@/lib/tenancy/garage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenancy/garage")>()),
  getGarage: async () => harness.garage,
}));

const { setBookingEngineForTests } = await import("@/lib/booking-engine");
const { readBookingSession, readJustBooked, BOOKING_STATE_COOKIE, JUST_BOOKED_COOKIE } = await import("@/lib/booking-engine/state");
const { confirmBookingAction, serviceStepAction, timeStepAction, vehicleStepAction } = await import("@/lib/booking-flow/actions");
const { initialDetailsFormState, initialServiceFormState, initialTimeFormState, initialVehicleFormState } = await import("@/lib/booking-flow/forms");

const REGISTRATION = "AB12CDE";
let engine: FakeBookingEngine;
let created: CreateBookingInput[];

function form(fields: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

/** Runs an action and returns its state, or the redirect URL it threw. */
async function run<S>(action: (state: S, data: FormData) => Promise<S>, state: S, fields: Record<string, string | string[]>) {
  try {
    return { state: await action(state, form(fields)), redirect: null as string | null };
  } catch (error) {
    if (error instanceof RedirectSignal) return { state: null, redirect: error.url };
    throw error;
  }
}

async function session() {
  return readBookingSession(harness.garage.id);
}

async function freeSlot(serviceId: string = FAKE_SERVICE_IDS.diagnostics, index = 0) {
  const slots = await engine.getAvailableSlots({ garageId: harness.garage.id, serviceId, from: "2026-10-28", to: "2026-10-30" });
  return slots.filter((slot) => slot.freeCount > 0)[index]!;
}

async function toDetails(options: { serviceId?: string; mode?: "workshop" | "mobile"; postcode?: string } = {}) {
  await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "ab12 cde", mode: "lookup" });
  await run(serviceStepAction, initialServiceFormState, {
    serviceId: options.serviceId ?? FAKE_SERVICE_IDS.diagnostics,
    locationMode: options.mode ?? "workshop",
    postcode: options.postcode ?? "",
    symptom: ["Warning light", "Made up symptom"],
    note: "Light came on yesterday",
  });
  const slot = await freeSlot(options.serviceId);
  await run(timeStepAction, initialTimeFormState, { startsAt: slot.startsAt });
  return slot;
}

const details = { name: "Sam Tester", phone: "07700 900412", email: "", channel: "sms" };

beforeEach(() => {
  jar.clear();
  harness.garage = testGarage({ motEnabled: true });
  harness.redirects = [];
  harness.refreshes = 0;
  harness.rateLimitOk = true;
  created = [];
  engine = createFakeBookingEngine({ now: () => new Date("2026-10-27T07:00:00.000Z"), referencePrefix: "HRM" });
  const recording: BookingEngine = {
    listOnlineServices: (garageId) => engine.listOnlineServices(garageId),
    getAvailableSlots: (query) => engine.getAvailableSlots(query),
    createBooking: async (garageId, input) => {
      created.push(input);
      return engine.createBooking(garageId, input);
    },
  };
  setBookingEngineForTests(recording);
});

afterEach(() => {
  // Rule 3: no redirect a step makes ever carries the registration (or anything but a step and a date).
  for (const url of harness.redirects) {
    expect(url.toUpperCase().replace(/[^A-Z0-9]/g, "")).not.toContain(REGISTRATION);
    expect(url).toMatch(/^\/(service|time(\?date=\d{4}-\d{2}-\d{2})?|details|confirmed\/[A-Z0-9-]+)?$/);
  }
  vi.unstubAllEnvs();
});

afterAll(() => setBookingEngineForTests(null));

describe("step 1 · vehicle", () => {
  it("finds the car, keeps it in the sealed draft and stays on the page", async () => {
    const { state, redirect } = await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "ab12 cde", mode: "lookup" });
    expect(redirect).toBeNull();
    expect(state).toMatchObject({ status: "found", seq: 1, vehicle: { registration: REGISTRATION, make: "Vauxhall", model: "Astra", motExpiry: "2027-03-31" } });
    expect((await session()).draft.vehicle?.registration).toBe(REGISTRATION);
    expect(jar.get(BOOKING_STATE_COOKIE)!.value).not.toMatch(/AB12/i);
  });

  it("drops MOT facts when the garage has MOT switched off", async () => {
    harness.garage = testGarage({ motEnabled: false });
    const { state } = await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    expect(state?.vehicle?.motExpiry).toBeUndefined();
    expect((await session()).draft.vehicle?.motExpiry).toBeUndefined();
  });

  it("continues to the service step once the car is found", async () => {
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    const { redirect } = await run(vehicleStepAction, initialVehicleFormState, { registration: "AB12 CDE", mode: "lookup" });
    expect(redirect).toBe("/service");
  });

  it("looks a new registration up on Continue instead of moving on with the old car", async () => {
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    const { state, redirect } = await run(vehicleStepAction, initialVehicleFormState, { registration: "CD34EFG", mode: "lookup" });
    expect(redirect).toBeNull();
    expect(state?.vehicle?.registration).toBe("CD34EFG");
  });

  it("validates the registration and the manual make and model", async () => {
    expect((await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "!", mode: "lookup" })).state?.fieldErrors?.registration).toMatch(/registration/);
    const manual = await run(vehicleStepAction, initialVehicleFormState, { registration: "AB12CDE", mode: "manual", make: "", model: "" });
    expect(manual.state?.fieldErrors).toEqual({ make: expect.any(String), model: expect.any(String) });
  });

  it("saves a manually entered car and moves on", async () => {
    const { redirect } = await run(vehicleStepAction, initialVehicleFormState, { registration: "AB12CDE", mode: "manual", make: "Ford", model: "Focus" });
    expect(redirect).toBe("/service");
    expect((await session()).draft.vehicle).toEqual({ registration: REGISTRATION, make: "Ford", model: "Focus", manual: true });
  });

  it("forgets the car on Not your car?", async () => {
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    const { state } = await run(vehicleStepAction, initialVehicleFormState, { intent: "reset" });
    expect(state).toMatchObject({ status: "idle", vehicle: null });
    expect((await session()).draft.vehicle).toBeUndefined();
  });

  it("rate-limits lookups", async () => {
    harness.rateLimitOk = false;
    const { state } = await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    expect(state).toMatchObject({ status: "error", suggestManual: true });
  });

  it("asks for Turnstile once per draft when it is configured", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site");
    const blocked = await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    expect(blocked.state?.message).toMatch(/security check/);
    const passed = await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup", turnstileToken: "passed" });
    expect(passed.state?.status).toBe("found");
    expect((await session()).meta.humanCheckedAt).toEqual(expect.any(Number));
    const again = await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "CD34EFG", mode: "lookup" });
    expect(again.state?.status).toBe("found");
  });
});

describe("step 2 · service", () => {
  it("sends a customer without a car back to step 1", async () => {
    expect((await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.diagnostics })).redirect).toBe("/");
  });

  it("saves the service, location, known symptoms and note, then moves to the time step", async () => {
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    const { redirect } = await run(serviceStepAction, initialServiceFormState, {
      serviceId: FAKE_SERVICE_IDS.diagnostics,
      locationMode: "workshop",
      symptom: ["Warning light", "<script>"],
      note: "  Light   came on  ",
    });
    expect(redirect).toBe("/time");
    expect((await session()).draft).toMatchObject({ serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop", symptoms: ["Warning light"], note: "Light came on" });
  });

  it("requires a choice, a postcode for mobile visits and a postcode inside the service area", async () => {
    harness.garage = testGarage({ motEnabled: true, serviceArea: ["DN1", "DN2"] });
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    expect((await run(serviceStepAction, initialServiceFormState, { serviceId: "" })).state?.fieldErrors?.serviceId).toBeTruthy();
    expect((await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "mobile", postcode: "nope" })).state?.fieldErrors?.postcode).toMatch(/postcode/);
    expect((await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "mobile", postcode: "S6 1AA" })).state?.fieldErrors?.postcode).toMatch(/don't cover S6/);
    const ok = await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "mobile", postcode: "dn11aa" });
    expect(ok.redirect).toBe("/time");
    expect((await session()).draft).toMatchObject({ locationMode: "mobile", postcode: "DN1 1AA" });
  });

  it("uses the only mode a service offers, whatever the form says", async () => {
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.fullService, locationMode: "mobile", postcode: "DN1 1AA" });
    expect((await session()).draft).toMatchObject({ locationMode: "workshop" });
    expect((await session()).draft.postcode).toBeUndefined();
  });

  it("does not offer MOT when the garage has MOT switched off", async () => {
    harness.garage = testGarage({ motEnabled: false });
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    expect((await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.mot })).state?.fieldErrors?.serviceId).toBeTruthy();
  });

  it("drops the chosen time when the service changes", async () => {
    await toDetails();
    expect((await session()).draft.startsAt).toBeTruthy();
    await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.fullService, locationMode: "workshop" });
    expect((await session()).draft.startsAt).toBeUndefined();
  });
});

describe("step 3 · time", () => {
  it("sends a customer without a service back to step 2", async () => {
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    expect((await run(timeStepAction, initialTimeFormState, { startsAt: "2026-10-28T09:15:00.000Z" })).redirect).toBe("/service");
  });

  it("saves a free time and refuses a taken one", async () => {
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop" });
    const slots = await engine.getAvailableSlots({ garageId: harness.garage.id, serviceId: FAKE_SERVICE_IDS.diagnostics, from: "2026-10-28", to: "2026-10-30" });
    const taken = slots.find((slot) => slot.freeCount === 0)!;
    const refused = await run(timeStepAction, initialTimeFormState, { startsAt: taken.startsAt });
    expect(refused.state?.message).toMatch(/just gone/);
    expect(harness.refreshes).toBe(1);
    const free = slots.find((slot) => slot.freeCount > 0)!;
    expect((await run(timeStepAction, initialTimeFormState, { startsAt: free.startsAt })).redirect).toBe("/details");
    expect((await session()).draft.startsAt).toBe(free.startsAt);
  });
});

describe("step 4 · details and confirm", () => {
  it("sends an incomplete draft back to the first missing step", async () => {
    expect((await run(confirmBookingAction, initialDetailsFormState, details)).redirect).toBe("/");
    await run(vehicleStepAction, initialVehicleFormState, { intent: "find", registration: "AB12CDE", mode: "lookup" });
    await run(serviceStepAction, initialServiceFormState, { serviceId: FAKE_SERVICE_IDS.diagnostics, locationMode: "workshop" });
    expect((await run(confirmBookingAction, initialDetailsFormState, details)).redirect).toBe("/time");
    expect(created).toHaveLength(0);
  });

  it("validates name, UK mobile and email without creating anything", async () => {
    await toDetails();
    const { state } = await run(confirmBookingAction, initialDetailsFormState, { name: "S", phone: "01302 000101", email: "not-an-email", channel: "sms" });
    expect(Object.keys(state?.fieldErrors ?? {}).sort()).toEqual(["email", "name", "phone"]);
    const emailUpdates = await run(confirmBookingAction, initialDetailsFormState, { ...details, channel: "email" });
    expect(emailUpdates.state?.fieldErrors?.email).toMatch(/updates by email/);
    expect(created).toHaveLength(0);
  });

  it("creates the booking with the draft's key, clears the draft and shows the confirmation", async () => {
    const slot = await toDetails();
    const key = (await session()).draft.idempotencyKey;
    const { redirect } = await run(confirmBookingAction, initialDetailsFormState, details);
    expect(redirect).toMatch(/^\/confirmed\/HRM-\d{4}$/);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      serviceId: FAKE_SERVICE_IDS.diagnostics,
      startsAt: slot.startsAt,
      locationMode: "workshop",
      symptoms: ["Warning light"],
      notes: "Light came on yesterday",
      idempotencyKey: key,
      source: "online",
      customer: { name: "Sam Tester", phone: "+447700900412", channel: "sms", reminderConsent: false },
      vehicle: { registration: REGISTRATION, make: "Vauxhall", model: "Astra", motExpiry: "2027-03-31" },
    });
    expect(jar.has(BOOKING_STATE_COOKIE)).toBe(false);
    const reference = redirect!.split("/").pop()!;
    expect(jar.get(JUST_BOOKED_COOKIE)!.options).toMatchObject({ path: "/confirmed", httpOnly: true });
    expect(await readJustBooked(harness.garage.id, reference)).toMatchObject({
      reference,
      status: "confirmed",
      serviceName: "Diagnostics",
      where: "Workshop, DN1",
      vehicleName: "Vauxhall Astra",
      registration: REGISTRATION,
      contactHint: "07••• •••412",
    });
  });

  it("stores consent only when the box is ticked, with the exact wording shown", async () => {
    await toDetails();
    await run(confirmBookingAction, initialDetailsFormState, details);
    expect(created[0]!.customer.reminderConsent).toBe(false);
    expect(created[0]!.customer).not.toHaveProperty("consentSource");

    await toDetails();
    await run(confirmBookingAction, initialDetailsFormState, { ...details, reminderConsent: "yes" });
    expect(created[1]!.customer).toMatchObject({ reminderConsent: true, consentSource: REMINDER_CONSENT_COPY });

    harness.garage = testGarage({ motEnabled: false });
    await toDetails();
    await run(confirmBookingAction, initialDetailsFormState, { ...details, reminderConsent: "yes" });
    expect(created[2]!.customer).toMatchObject({ reminderConsent: true, consentSource: REMINDER_CONSENT_COPY_NO_MOT });
    expect(created[2]!.vehicle.motExpiry).toBeUndefined();
  });

  it("sends the customer back to the time step with alternatives when the slot has gone", async () => {
    const slot = await toDetails();
    // Someone else takes the same time first.
    await engine.createBooking(harness.garage.id, { ...(await validInput(slot.startsAt)), idempotencyKey: "0f9619ff-8b86-4011-b42d-00c04fc964ff" });
    const { redirect } = await run(confirmBookingAction, initialDetailsFormState, details);
    expect(redirect).toMatch(/^\/time\?date=2026-10-\d{2}$/);
    const after = await session();
    expect(after.draft.startsAt).toBeUndefined();
    expect(after.draft.vehicle?.registration).toBe(REGISTRATION);
    expect(after.meta.slotTaken?.startsAt).toBe(slot.startsAt);
    expect(after.meta.slotTaken?.alternatives.length).toBe(3);
    expect(after.meta.slotTaken?.alternatives.every((alternative) => alternative.freeCount > 0)).toBe(true);
  });

  it("creates one booking when Confirm is pressed twice", async () => {
    await toDetails();
    const draftCookie = jar.get(BOOKING_STATE_COOKIE)!;
    const first = await run(confirmBookingAction, initialDetailsFormState, details);
    // The second press still carries the old draft cookie (the first response never arrived).
    jar.set(BOOKING_STATE_COOKIE, draftCookie);
    const second = await run(confirmBookingAction, initialDetailsFormState, details);
    expect(second.redirect).toBe(first.redirect);
    expect(engine.bookings()).toHaveLength(1);
  });

  it("explains engine refusals without losing the draft", async () => {
    await toDetails({ mode: "mobile", postcode: "DN1 1AA" });
    setBookingEngineForTests({
      listOnlineServices: (garageId) => engine.listOnlineServices(garageId),
      getAvailableSlots: (query) => engine.getAvailableSlots(query),
      createBooking: async () => ({ ok: false, code: "OUTSIDE_SERVICE_AREA", message: "outside" }),
    });
    const { state } = await run(confirmBookingAction, initialDetailsFormState, details);
    expect(state).toMatchObject({ message: expect.stringMatching(/don't cover/), editHref: "/service" });
    expect((await session()).draft.startsAt).toBeTruthy();
  });

  it("rate-limits booking attempts", async () => {
    await toDetails();
    harness.rateLimitOk = false;
    expect((await run(confirmBookingAction, initialDetailsFormState, details)).state?.message).toMatch(/Too many/);
    expect(created).toHaveLength(0);
  });
});

async function validInput(startsAt: string): Promise<CreateBookingInput> {
  return {
    serviceId: FAKE_SERVICE_IDS.diagnostics,
    startsAt,
    locationMode: "workshop",
    symptoms: [],
    customer: { name: "Someone Else", phone: "+447700900999", channel: "sms", reminderConsent: false },
    vehicle: { registration: "ZZ99ZZZ" },
    idempotencyKey: "1f9619ff-8b86-4011-b42d-00c04fc964ff",
    source: "online",
  };
}
