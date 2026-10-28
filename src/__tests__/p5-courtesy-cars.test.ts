import { describe, expect, it } from "vitest";
import { extrasSummary, readBookingExtras } from "@/lib/courtesy/booking-site";
import {
  bookingsWithCourtesyCar,
  courtesyErrorCode,
  courtesyErrorMessage,
  courtesyFlash,
  fuelLabel,
  localInputValue,
  normaliseCollectionPostcode,
  parseCarForm,
  parseCollectionForm,
  parseLoanReading,
  parseLoanWindow,
  parseRange,
  safeCourtesyReturn,
  shapeFleetWeek,
  withFlash,
  type CourtesyCar,
  type CourtesyLoan,
} from "@/lib/courtesy/view";

const TZ = "Europe/London";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const car = (id: string, extra: Partial<CourtesyCar> = {}): CourtesyCar => ({
  id,
  name: `Car ${id}`,
  registration: "AB12CDE",
  active: true,
  notes: null,
  mileage: null,
  fuelEighths: null,
  sort: 1,
  ...extra,
});

const loan = (id: string, carId: string, startsAt: string, endsAt: string, status: CourtesyLoan["status"] = "reserved"): CourtesyLoan => ({
  id,
  carId,
  bookingId: `booking-${id}`,
  startsAt,
  endsAt,
  status,
  notes: null,
  mileageOut: null,
  fuelOut: null,
  mileageIn: null,
  fuelIn: null,
  damageNotes: null,
});

describe("courtesy car forms", () => {
  it("normalises the registration and keeps optional readings", () => {
    const parsed = parseCarForm(form({ name: "  Fiesta  ", registration: "ab12 cde", mileage: "42,180", fuel: "6", notes: "" }));
    expect(parsed).toEqual({ ok: true, value: { name: "Fiesta", registration: "AB12CDE", notes: null, mileage: 42180, fuelEighths: 6 } });
  });

  it("refuses a missing name, a bad registration and a silly mileage", () => {
    const parsed = parseCarForm(form({ name: "", registration: "!", mileage: "lots", fuel: "9" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(Object.keys(parsed.fieldErrors).sort()).toEqual(["fuel", "mileage", "name", "registration"]);
  });

  it("needs mileage and fuel to check a car out or in", () => {
    expect(parseLoanReading(form({ mileage: "1,040 miles", fuel: "4", notes: "Scratch" }))).toEqual({
      ok: true,
      value: { mileage: 1040, fuelEighths: 4, notes: "Scratch" },
    });
    const missing = parseLoanReading(form({ mileage: "", fuel: "" }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.fieldErrors).toMatchObject({ mileage: expect.any(String), fuel: expect.any(String) });
  });

  it("labels fuel in eighths", () => {
    expect(fuelLabel(8)).toBe("Full");
    expect(fuelLabel(4)).toBe("Half");
    expect(fuelLabel(null)).toBe("Not recorded");
  });
});

describe("loan window in garage time", () => {
  it("defaults to the SQL window when both fields are empty", () => {
    expect(parseLoanWindow(form({}), TZ)).toEqual({ ok: true, startsAt: null, endsAt: null });
  });

  it("reads datetime-local values in Europe/London across the spring clock change", () => {
    // Sun 28 Mar 2027: 09:00 BST is 08:00 UTC; Sat 27 Mar 17:30 GMT is 17:30 UTC.
    expect(parseLoanWindow(form({ from: "2027-03-27T17:30", until: "2027-03-28T09:00" }), TZ)).toEqual({
      ok: true,
      startsAt: "2027-03-27T17:30:00.000Z",
      endsAt: "2027-03-28T08:00:00.000Z",
    });
  });

  it("takes the first 01:30 on the autumn day the clocks go back", () => {
    const window = parseLoanWindow(form({ from: "2027-10-31T01:30", until: "2027-10-31T09:00" }), TZ);
    expect(window).toEqual({ ok: true, startsAt: "2027-10-31T00:30:00.000Z", endsAt: "2027-10-31T09:00:00.000Z" });
  });

  it("refuses half a window, a backwards one and one over 31 days", () => {
    expect(parseLoanWindow(form({ from: "2026-11-02T09:00" }), TZ).ok).toBe(false);
    expect(parseLoanWindow(form({ from: "2026-11-02T09:00", until: "2026-11-02T08:00" }), TZ).ok).toBe(false);
    expect(parseLoanWindow(form({ from: "2026-11-02T09:00", until: "2026-12-10T08:00" }), TZ).ok).toBe(false);
    // 01:30 on Sun 28 Mar 2027 never happens in London.
    expect(parseLoanWindow(form({ from: "2027-03-28T01:30", until: "2027-03-28T09:00" }), TZ).ok).toBe(false);
  });

  it("formats an instant back for the datetime-local input", () => {
    expect(localInputValue("2027-03-28T08:00:00.000Z", TZ)).toBe("2027-03-28T09:00");
    expect(localInputValue("2026-11-02T17:30:00.000Z", TZ)).toBe("2026-11-02T17:30");
  });
});

describe("collection address", () => {
  it("normalises UK postcodes", () => {
    expect(normaliseCollectionPostcode("dn45aa")).toBe("DN4 5AA");
    expect(normaliseCollectionPostcode("SW1A 1AA")).toBe("SW1A 1AA");
    expect(normaliseCollectionPostcode("nonsense")).toBeNull();
  });

  it("needs a postcode and an address line", () => {
    expect(parseCollectionForm(form({ collectionPostcode: "dn4 5aa", collectionAddress: " 1  High Street " }))).toEqual({
      ok: true,
      value: { postcode: "DN4 5AA", address: "1 High Street" },
    });
    const bad = parseCollectionForm(form({ collectionPostcode: "x", collectionAddress: "" }));
    expect(bad.ok).toBe(false);
  });
});

describe("SQL errors in plain English", () => {
  it("maps the typed codes", () => {
    expect(courtesyErrorCode({ message: "COURTESY_CAR_UNAVAILABLE", code: "P0001" })).toBe("COURTESY_CAR_UNAVAILABLE");
    expect(courtesyErrorCode({ message: "PLAN_REQUIRED: courtesy_cars", code: "P0001" })).toBe("PLAN_REQUIRED");
    expect(courtesyErrorCode({ message: "INVALID_LOAN: mileage in is below mileage out", code: "P0001" })).toBe("INVALID_LOAN");
    expect(courtesyErrorCode({ message: "permission denied", code: "42501" })).toBe("COURTESY_FORBIDDEN");
    expect(courtesyErrorCode({ message: "something else", code: "XX000" })).toBeNull();
    expect(courtesyErrorMessage("COURTESY_CAR_UNAVAILABLE")).toMatch(/just been taken/);
    expect(courtesyErrorMessage("nope")).toBe("That could not be saved. Try again.");
  });

  it("turns flash keys into notices, errors first", () => {
    expect(courtesyFlash("reserved", undefined)).toEqual({ tone: "success", text: "Courtesy car reserved." });
    expect(courtesyFlash("reserved", "in_use")?.tone).toBe("error");
    expect(courtesyFlash("not-a-key", undefined)).toBeNull();
    expect(courtesyFlash(undefined, "PLAN_REQUIRED")?.text).toMatch(/Pro/);
  });
});

describe("redirects never carry anything but a flash", () => {
  it("only returns to the courtesy page or one booking", () => {
    expect(safeCourtesyReturn("/app/courtesy-cars?week=2026-11-02")).toBe("/app/courtesy-cars?week=2026-11-02");
    expect(safeCourtesyReturn("/app/bookings/0b8f3f8e-4b3a-4c1e-9b8a-2b1c3d4e5f60")).toBe("/app/bookings/0b8f3f8e-4b3a-4c1e-9b8a-2b1c3d4e5f60");
    expect(safeCourtesyReturn("https://evil.example/")).toBe("/app/courtesy-cars");
    expect(safeCourtesyReturn("/app/courtesy-cars?reg=AB12CDE")).toBe("/app/courtesy-cars");
    expect(safeCourtesyReturn(null)).toBe("/app/courtesy-cars");
  });

  it("adds the flash and keeps the week; booking pages jump to the panel", () => {
    expect(withFlash("/app/courtesy-cars?week=2026-11-02", "done", "reserved")).toBe("/app/courtesy-cars?week=2026-11-02&courtesy=reserved");
    expect(withFlash("/app/bookings/abc", "error", "bad_window")).toBe("/app/bookings/abc?courtesyError=bad_window#courtesy");
  });
});

describe("ranges from PostgREST", () => {
  it("parses tstzrange text", () => {
    expect(parseRange('["2026-11-02 09:00:00+00","2026-11-02 17:30:00+00")')).toEqual({
      startsAt: "2026-11-02T09:00:00.000Z",
      endsAt: "2026-11-02T17:30:00.000Z",
    });
    expect(parseRange('["2027-03-28 08:00:00.5+00:00","2027-03-28 16:30:00+00")').startsAt).toBe("2027-03-28T08:00:00.500Z");
    expect(() => parseRange("nonsense")).toThrow();
  });
});

describe("fleet week", () => {
  it("puts each loan on every local day it touches, across the autumn clock change", () => {
    // Week of Mon 25 Oct 2027; the clocks go back on Sun 31 Oct (a 25-hour day).
    const cars = [car("a"), car("b", { active: false })];
    const loans = [
      loan("1", "a", "2027-10-29T08:00:00.000Z", "2027-10-30T16:30:00.000Z"), // Fri 09:00 BST to Sat 17:30 BST
      loan("2", "a", "2027-10-31T09:00:00.000Z", "2027-10-31T17:30:00.000Z", "out"), // Sun 09:00 to 17:30 GMT
      loan("3", "a", "2027-10-27T08:00:00.000Z", "2027-10-27T16:30:00.000Z", "cancelled"),
    ];
    const [rowA, rowB] = shapeFleetWeek(cars, loans, "2027-10-25", TZ, new Date("2027-10-31T12:00:00Z"));
    expect(rowA!.days.map((day) => day.loans.map((item) => item.id))).toEqual([[], [], [], [], ["1"], ["1"], ["2"]]);
    expect(rowA!.days[4]!.loans[0]).toMatchObject({ continuesBefore: false, continuesAfter: true });
    expect(rowA!.days[5]!.loans[0]).toMatchObject({ continuesBefore: true, continuesAfter: false });
    expect(rowA!.busyDays).toBe(3);
    expect(rowA!.state).toBe("out");
    expect(rowB!.state).toBe("off");
  });

  it("a loan ending at local midnight does not spill into the next day", () => {
    const [row] = shapeFleetWeek([car("a")], [loan("1", "a", "2026-11-02T09:00:00.000Z", "2026-11-03T00:00:00.000Z")], "2026-11-02", TZ, new Date("2026-11-02T10:00:00Z"));
    expect(row!.days[0]!.loans).toHaveLength(1);
    expect(row!.days[1]!.loans).toHaveLength(0);
    expect(row!.state).toBe("reserved_today");
  });

  it("badges only bookings with a live loan", () => {
    const ids = bookingsWithCourtesyCar([
      { bookingId: "x", status: "reserved" },
      { bookingId: "y", status: "out" },
      { bookingId: "z", status: "returned" },
      { bookingId: "w", status: "cancelled" },
    ]);
    expect([...ids].sort()).toEqual(["x", "y"]);
  });
});

describe("booking site extras", () => {
  const offered = { courtesy: true, collection: true };

  it("ignores extras that were not offered", () => {
    const result = readBookingExtras(form({ courtesyCar: "yes", collectionDelivery: "yes" }), { courtesy: false, collection: false }, ["DN4"], false);
    expect(result).toEqual({ ok: true, value: { courtesy: false, collection: null } });
  });

  it("keeps a courtesy request on Pro even if the last car went since the page loaded", () => {
    const result = readBookingExtras(form({ courtesyCar: "yes" }), { courtesy: false, collection: false }, ["DN4"], true);
    expect(result).toEqual({ ok: true, value: { courtesy: true, collection: null } });
  });

  it("checks the collection postcode against the mobile area", () => {
    const outside = readBookingExtras(form({ collectionDelivery: "yes", collectionPostcode: "S1 1AA", collectionAddress: "1 High St" }), offered, ["DN4"]);
    expect(outside).toMatchObject({ ok: false, fieldErrors: { collectionPostcode: expect.stringMatching(/S1/) } });
    const missing = readBookingExtras(form({ collectionDelivery: "yes", collectionPostcode: "", collectionAddress: "" }), offered, ["DN4"]);
    expect(missing).toMatchObject({ ok: false, fieldErrors: { collectionPostcode: expect.any(String), collectionAddress: expect.any(String) } });
    const inside = readBookingExtras(form({ collectionDelivery: "yes", collectionPostcode: "dn4 5aa", collectionAddress: "1 High St" }), offered, ["DN4"]);
    expect(inside).toEqual({ ok: true, value: { courtesy: false, collection: { postcode: "DN4 5AA", address: "1 High St" } } });
  });

  it("tells the customer what happened, never that a request is a promise", () => {
    expect(extrasSummary({ courtesy: "requested", collection: "held" })).toEqual([
      "Courtesy car asked for: the garage will confirm it.",
      "Collection and delivery booked: we'll collect the car before the job and bring it back after.",
    ]);
    expect(extrasSummary({ courtesy: null, collection: "unassigned" })).toEqual(["Collection and delivery: the garage will call you to arrange the times."]);
    expect(extrasSummary({ courtesy: null, collection: null })).toEqual([]);
  });
});
