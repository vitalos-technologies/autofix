import { describe, expect, it } from "vitest";
import type { BookingDraft, OnlineService } from "@/lib/booking-engine/types";
import { FAKE_SERVICES, FAKE_SERVICE_IDS } from "@/lib/booking-engine/fake";
import { fakeEngineRequested } from "@/lib/booking-engine";
import { inServiceArea, maskEmail, maskMobile, normaliseUkPostcode, reminderConsentCopy, whereLabel } from "@/lib/booking-flow/copy";
import { addDays, dateKeyInZone, isDateKey, isoWeekday, zonedTimeToInstant } from "@/lib/booking-flow/dates";
import { firstIncompleteStep, redirectForStep, serviceLocationModes, visibleServices } from "@/lib/booking-flow/steps";
import { draftVehicleFromLookup, engineDescription, vehicleName } from "@/lib/booking-flow/vehicle";
import { REMINDER_CONSENT_COPY, REMINDER_CONSENT_COPY_NO_MOT } from "@/components/book";

const GARAGE = "11111111-1111-4111-8111-111111111111";
const services: OnlineService[] = [...FAKE_SERVICES];
const vehicle = { registration: "AB12CDE", make: "Ford", model: "Focus" };
const complete: BookingDraft = {
  v: 1,
  garageId: GARAGE,
  vehicle,
  serviceId: FAKE_SERVICE_IDS.diagnostics,
  locationMode: "workshop",
  startsAt: "2026-10-28T09:15:00.000Z",
};

describe("booking step guards", () => {
  it("finds the first incomplete step", () => {
    expect(firstIncompleteStep({ v: 1, garageId: GARAGE }, services)).toBe("vehicle");
    expect(firstIncompleteStep({ v: 1, garageId: GARAGE, vehicle }, services)).toBe("service");
    expect(firstIncompleteStep({ ...complete, locationMode: undefined }, services)).toBe("service");
    expect(firstIncompleteStep({ ...complete, startsAt: undefined }, services)).toBe("time");
    expect(firstIncompleteStep(complete, services)).toBeNull();
  });

  it("sends a draft for a service that is no longer online back to the service step", () => {
    expect(firstIncompleteStep({ ...complete, serviceId: "f0000000-0000-4000-8000-0000000000ff" }, services)).toBe("service");
  });

  it("rejects a location the service does not offer, and a mobile visit without a postcode", () => {
    expect(firstIncompleteStep({ ...complete, serviceId: FAKE_SERVICE_IDS.fullService, locationMode: "mobile", postcode: "DN1 2AB" }, services)).toBe("service");
    expect(firstIncompleteStep({ ...complete, locationMode: "mobile" }, services)).toBe("service");
    expect(firstIncompleteStep({ ...complete, locationMode: "mobile", postcode: "DN1 2AB" }, services)).toBeNull();
  });

  it("redirects a page only back to an earlier step, never forward", () => {
    const empty: BookingDraft = { v: 1, garageId: GARAGE };
    expect(redirectForStep("vehicle", empty, services)).toBeNull();
    expect(redirectForStep("service", empty, null)).toBe("/");
    expect(redirectForStep("time", empty, services)).toBe("/");
    expect(redirectForStep("details", empty, services)).toBe("/");
    expect(redirectForStep("service", { v: 1, garageId: GARAGE, vehicle }, null)).toBeNull();
    expect(redirectForStep("time", { v: 1, garageId: GARAGE, vehicle }, services)).toBe("/service");
    expect(redirectForStep("details", { ...complete, startsAt: undefined }, services)).toBe("/time");
    expect(redirectForStep("details", complete, services)).toBeNull();
    // An incomplete later step never redirects an earlier page.
    expect(redirectForStep("service", { ...complete, startsAt: undefined }, services)).toBeNull();
  });

  it("offers workshop and mobile only for `both` services", () => {
    expect(serviceLocationModes({ locationMode: "both" })).toEqual(["workshop", "mobile"]);
    expect(serviceLocationModes({ locationMode: "workshop" })).toEqual(["workshop"]);
    expect(serviceLocationModes({ locationMode: "mobile" })).toEqual(["mobile"]);
  });

  it("shows MOT services only when the garage has MOT switched on", () => {
    expect(visibleServices(services, false).some((service) => service.isMot)).toBe(false);
    expect(visibleServices(services, true).some((service) => service.isMot)).toBe(true);
    expect(visibleServices(services, true).map((service) => service.sort)).toEqual([10, 20, 30, 40, 50]);
  });
});

describe("booking flow dates", () => {
  it("validates and adds calendar days", () => {
    expect(isDateKey("2026-10-27")).toBe(true);
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("27/10/2026")).toBe(false);
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(isoWeekday("2026-10-25")).toBe(7);
    expect(isoWeekday("2026-10-26")).toBe(1);
  });

  it("turns London wall-clock times into instants across both clock changes", () => {
    const tz = "Europe/London";
    // BST (UTC+1) before 25 Oct 2026, GMT after.
    expect(zonedTimeToInstant("2026-10-24", 9 * 60, tz).toISOString()).toBe("2026-10-24T08:00:00.000Z");
    expect(zonedTimeToInstant("2026-10-25", 9 * 60, tz).toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(zonedTimeToInstant("2026-10-26", 8 * 60 + 30, tz).toISOString()).toBe("2026-10-26T08:30:00.000Z");
    // GMT before 29 Mar 2026, BST after; 01:30 does not exist that day and moves to 02:30 BST.
    expect(zonedTimeToInstant("2026-03-28", 9 * 60, tz).toISOString()).toBe("2026-03-28T09:00:00.000Z");
    expect(zonedTimeToInstant("2026-03-29", 9 * 60, tz).toISOString()).toBe("2026-03-29T08:00:00.000Z");
    expect(zonedTimeToInstant("2026-03-29", 90, tz).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("reads the local date of an instant in the garage's time zone", () => {
    expect(dateKeyInZone("2026-07-01T23:30:00.000Z", "Europe/London")).toBe("2026-07-02");
    expect(dateKeyInZone("2026-12-01T23:30:00.000Z", "Europe/London")).toBe("2026-12-01");
  });
});

describe("booking flow wording", () => {
  it("normalises UK postcodes and checks the mobile service area", () => {
    expect(normaliseUkPostcode("dn12ab")).toBe("DN1 2AB");
    expect(normaliseUkPostcode(" s6 1aa ")).toBe("S6 1AA");
    expect(normaliseUkPostcode("not a postcode")).toBeNull();
    expect(inServiceArea("DN1 2AB", [])).toBe(true);
    expect(inServiceArea("DN1 2AB", ["DN1", "DN2"])).toBe(true);
    expect(inServiceArea("DN11 2AB", ["DN1"])).toBe(false);
    expect(inServiceArea("DN11 2AB", ["DN"])).toBe(true);
    expect(inServiceArea("S6 1AA", ["DN1"])).toBe(false);
  });

  it("masks contact details on the confirmation page", () => {
    expect(maskMobile("+447700900412")).toBe("07••• •••412");
    expect(maskEmail("sarah@example.com")).toBe("s•••@example.com");
    expect(whereLabel("workshop", "DN1 1AA", "DN4 8AB")).toBe("Workshop, DN4");
    expect(whereLabel("mobile", "DN1 1AA", "DN4 8AB")).toBe("Mobile visit, DN1");
  });

  it("uses the consent wording that matches the garage's MOT switch", () => {
    expect(reminderConsentCopy(true)).toBe(REMINDER_CONSENT_COPY);
    expect(reminderConsentCopy(false)).toBe(REMINDER_CONSENT_COPY_NO_MOT);
  });
});

describe("vehicle facts for the draft", () => {
  it("keeps MOT expiry only when the garage shows MOT", () => {
    const details = { registration: "AB12CDE", make: "FORD", model: "FOCUS", colour: "BLUE", fuelType: "PETROL", engineCapacityCc: 999, year: 2018, motExpiry: "2027-03-14" };
    expect(draftVehicleFromLookup(details, "AB12CDE", true)).toEqual({
      registration: "AB12CDE",
      make: "Ford",
      model: "Focus",
      colour: "Blue",
      fuel: "Petrol",
      engine: "1.0 petrol",
      year: 2018,
      motExpiry: "2027-03-14",
    });
    expect(draftVehicleFromLookup(details, "AB12CDE", false).motExpiry).toBeUndefined();
  });

  it("describes the engine and names the car", () => {
    expect(engineDescription(1598, "Diesel")).toBe("1.6 diesel");
    expect(engineDescription(undefined, "ELECTRICITY")).toBe("Electricity");
    expect(engineDescription(undefined, undefined)).toBeUndefined();
    expect(vehicleName({ make: "BMW", model: "320d" })).toBe("BMW 320d");
    expect(vehicleName(undefined)).toBe("");
  });
});

describe("fake engine switch", () => {
  it("is only used when asked for, and never in a production deployment", () => {
    expect(fakeEngineRequested({ BOOKING_ENGINE: "fake", NODE_ENV: "development" })).toBe(true);
    expect(fakeEngineRequested({ BOOKING_ENGINE: "fake", NODE_ENV: "test" })).toBe(true);
    expect(fakeEngineRequested({ NODE_ENV: "development" })).toBe(false);
    expect(fakeEngineRequested({ BOOKING_ENGINE: "fake", NODE_ENV: "production" })).toBe(false);
    // Local Playwright runs of the production build may use it; Vercel production never does.
    expect(fakeEngineRequested({ BOOKING_ENGINE: "fake", NODE_ENV: "production", PLAYWRIGHT_TEST: "true" })).toBe(true);
    expect(fakeEngineRequested({ BOOKING_ENGINE: "fake", NODE_ENV: "production", PLAYWRIGHT_TEST: "true", VERCEL_ENV: "production" })).toBe(false);
  });
});
