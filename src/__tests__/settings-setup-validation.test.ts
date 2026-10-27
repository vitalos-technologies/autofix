import { describe, expect, it } from "vitest";
import { BOOKING_BACKGROUND, contrastRatio } from "@/lib/branding/accent";
import {
  ACCENT_NAMES,
  canChangeGarage,
  canManageSetup,
  checkDayWindows,
  chooseAccent,
  diffOpeningWindows,
  formatClock,
  logoPath,
  normaliseTime,
  parseBookingRulesForm,
  parseClosureForm,
  parseOpeningHoursForm,
  parsePounds,
  parseResourceForm,
  parseServiceArea,
  parseServiceForm,
  penceToPoundsInput,
  reorderIds,
  sniffLogoType,
} from "@/lib/settings/setup";

// Setup (P3.4) validation: the same rules as the scheduling migration's checks.

function form(values: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

const validService = {
  name: "  Full   service ",
  description: "Oil, filters and checks.",
  priceMode: "from",
  price: "£179",
  durationMin: "180",
  bufferMin: "15",
  locationMode: "workshop",
  resourceKind: "bay",
  onlineEnabled: "on",
  minNoticeH: "2",
  maxDaysAhead: "60",
};

describe("roles", () => {
  it("lets owners and managers manage services, hours, closures and resources; only owners change the garage", () => {
    expect([canManageSetup("owner"), canManageSetup("manager"), canManageSetup("technician"), canManageSetup(null)]).toEqual([true, true, false, false]);
    expect([canChangeGarage("owner"), canChangeGarage("manager"), canChangeGarage("technician"), canChangeGarage(undefined)]).toEqual([true, false, false, false]);
  });
});

describe("prices", () => {
  it("turns pounds into pence", () => {
    expect(parsePounds("54.85")).toBe(5485);
    expect(parsePounds("£54.85")).toBe(5485);
    expect(parsePounds("£ 49")).toBe(4900);
    expect(parsePounds("49.5")).toBe(4950);
    expect(parsePounds("1,200.50")).toBe(120050);
    expect(parsePounds("0")).toBe(0);
    expect(parsePounds("100000")).toBe(10_000_000);
  });

  it("refuses anything that is not pounds and pence up to £100,000", () => {
    for (const value of ["", "forty", "54.855", "-5", "1,20", "54,85", "100000.01", "1e3", "£", ". 5"]) expect(parsePounds(value), value).toBeNull();
  });

  it("shows stored pence back in the price box", () => {
    expect(penceToPoundsInput(5485)).toBe("54.85");
    expect(penceToPoundsInput(4500)).toBe("45");
    expect(penceToPoundsInput(4950)).toBe("49.50");
    expect(penceToPoundsInput(null)).toBe("");
  });
});

describe("parseServiceForm", () => {
  it("reads a service into the columns the database checks", () => {
    const parsed = parseServiceForm(form(validService), { motEnabled: false });
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "Full service",
        description: "Oil, filters and checks.",
        price_mode: "from",
        price_pence: 17900,
        duration_min: 180,
        buffer_min: 15,
        location_mode: "workshop",
        resource_kind: "bay",
        online_enabled: true,
        needs_approval: false,
        min_notice_h: 2,
        max_days_ahead: 60,
        is_mot: false,
      },
    });
  });

  it("gives quote services no price, whatever was typed", () => {
    const parsed = parseServiceForm(form({ ...validService, priceMode: "quote", price: "not a price" }), { motEnabled: false });
    expect(parsed.ok && parsed.value).toMatchObject({ price_mode: "quote", price_pence: null });
  });

  it("needs a price for fixed and from prices", () => {
    const missing = parseServiceForm(form({ ...validService, priceMode: "fixed", price: "" }), { motEnabled: false });
    expect(missing).toMatchObject({ ok: false, fieldErrors: { price: expect.stringContaining("Enter the price") } });
    const invalid = parseServiceForm(form({ ...validService, price: "forty" }), { motEnabled: false });
    expect(invalid).toMatchObject({ ok: false, fieldErrors: { price: expect.stringContaining("pounds and pence") } });
  });

  it("gives mobile-only services a mobile resource and lets workshop services use a bay or a technician", () => {
    const mobile = parseServiceForm(form({ ...validService, locationMode: "mobile", resourceKind: "technician" }), { motEnabled: false });
    expect(mobile.ok && mobile.value).toMatchObject({ location_mode: "mobile", resource_kind: "mobile" });
    const both = parseServiceForm(form({ ...validService, locationMode: "both", resourceKind: "technician" }), { motEnabled: false });
    expect(both.ok && both.value).toMatchObject({ location_mode: "both", resource_kind: "technician" });
    const mobileKind = parseServiceForm(form({ ...validService, locationMode: "workshop", resourceKind: "mobile" }), { motEnabled: false });
    expect(mobileKind).toMatchObject({ ok: false, fieldErrors: { resourceKind: expect.any(String) } });
  });

  it("checks every number against the table's limits", () => {
    const parsed = parseServiceForm(
      form({ ...validService, name: " ", description: "x".repeat(601), durationMin: "4", bufferMin: "241", minNoticeH: "721", maxDaysAhead: "0", priceMode: "cheap", locationMode: "moon" }),
      { motEnabled: false },
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(Object.keys(parsed.fieldErrors).sort()).toEqual(["bufferMin", "description", "durationMin", "locationMode", "maxDaysAhead", "minNoticeH", "name", "priceMode"]);
    }
    const edges = parseServiceForm(form({ ...validService, durationMin: "720", bufferMin: "", minNoticeH: "0", maxDaysAhead: "365" }), { motEnabled: false });
    expect(edges.ok && edges.value).toMatchObject({ duration_min: 720, buffer_min: 0, min_notice_h: 0, max_days_ahead: 365 });
  });

  it("reads the MOT flag only while the garage has MOT on, and otherwise keeps what the service had", () => {
    expect(parseServiceForm(form({ ...validService, isMot: "on" }), { motEnabled: true })).toMatchObject({ value: { is_mot: true } });
    expect(parseServiceForm(form({ ...validService }), { motEnabled: true, currentIsMot: true })).toMatchObject({ value: { is_mot: false } });
    expect(parseServiceForm(form({ ...validService, isMot: "on" }), { motEnabled: false })).toMatchObject({ value: { is_mot: false } });
    expect(parseServiceForm(form({ ...validService }), { motEnabled: false, currentIsMot: true })).toMatchObject({ value: { is_mot: true } });
  });
});

describe("reorderIds", () => {
  it("swaps a row with its neighbour and refuses to move past either end", () => {
    expect(reorderIds(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(reorderIds(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
    expect(reorderIds(["a", "b", "c"], "a", "up")).toBeNull();
    expect(reorderIds(["a", "b", "c"], "c", "down")).toBeNull();
    expect(reorderIds(["a", "b"], "z", "up")).toBeNull();
  });
});

describe("opening hours", () => {
  it("normalises times and formats them for people", () => {
    expect(normaliseTime("08:00")).toBe("08:00");
    expect(normaliseTime("17:30:00")).toBe("17:30");
    expect(normaliseTime("24:00")).toBeNull();
    expect(normaliseTime("8:00")).toBeNull();
    expect(normaliseTime("08:00:30")).toBeNull();
    expect([formatClock("08:00"), formatClock("17:30"), formatClock("12:00"), formatClock("00:15")]).toEqual(["8am", "5:30pm", "12pm", "12:15am"]);
  });

  it("allows split days whose windows touch, but not overlapping or reversed windows", () => {
    expect(checkDayWindows("Monday", [{ opens: "08:00", closes: "12:00" }, { opens: "12:00", closes: "17:00" }])).toBeNull();
    expect(checkDayWindows("Monday", [{ opens: "13:00", closes: "17:00" }, { opens: "08:00", closes: "13:30" }])).toMatch(/overlap/);
    expect(checkDayWindows("Monday", [{ opens: "12:00", closes: "12:00" }])).toMatch(/after the opening time/);
    expect(checkDayWindows("Monday", Array.from({ length: 5 }, (_, index) => ({ opens: `0${index}:00`, closes: `0${index}:30` })))).toMatch(/up to 4/);
  });

  it("reads the week: repeated pairs for a split day, no pairs for closed, blank rows ignored", () => {
    const parsed = parseOpeningHoursForm(
      form({
        "opens-1": ["13:00", "08:00"],
        "closes-1": ["17:30", "12:00:00"],
        "opens-6": ["08:30", ""],
        "closes-6": ["13:00", ""],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: [
        { weekday: 1, opens: "08:00", closes: "12:00" },
        { weekday: 1, opens: "13:00", closes: "17:30" },
        { weekday: 6, opens: "08:30", closes: "13:00" },
      ],
    });
  });

  it("names each day with a problem", () => {
    const parsed = parseOpeningHoursForm(form({ "opens-1": ["08:00", "12:00"], "closes-1": ["17:30", "18:00"], "opens-2": "09:00", "closes-2": "", "opens-3": "18:00", "closes-3": "09:00" }));
    expect(parsed).toMatchObject({
      ok: false,
      message: "Check the highlighted days.",
      fieldErrors: {
        "day-1": expect.stringMatching(/hours on Monday overlap/),
        "day-2": expect.stringMatching(/both an opening and a closing time for Tuesday/),
        "day-3": expect.stringMatching(/closing time must be after/),
      },
    });
  });

  it("works out what to delete and insert, leaving unchanged windows alone", () => {
    const stored = [
      { id: "mon", weekday: 1, opens: "08:00", closes: "17:30" },
      { id: "tue", weekday: 2, opens: "08:00", closes: "17:30" },
    ];
    const wanted = [
      { weekday: 1, opens: "08:00", closes: "12:00" },
      { weekday: 1, opens: "13:00", closes: "17:30" },
      { weekday: 2, opens: "08:00", closes: "17:30" },
    ];
    expect(diffOpeningWindows(stored, wanted)).toEqual({ remove: [stored[0]], add: [wanted[0], wanted[1]] });
    expect(diffOpeningWindows(stored, stored)).toEqual({ remove: [], add: [] });
  });
});

describe("closures", () => {
  const today = "2026-10-27";

  it("reads a single day or a range, inclusive", () => {
    expect(parseClosureForm(form({ startsOn: "2026-12-25", endsOn: "", reason: "  Christmas  " }), today)).toEqual({ ok: true, value: { starts_on: "2026-12-25", ends_on: "2026-12-25", reason: "Christmas" } });
    expect(parseClosureForm(form({ startsOn: "2026-10-27", endsOn: "2026-10-28", reason: "" }), today)).toEqual({ ok: true, value: { starts_on: "2026-10-27", ends_on: "2026-10-28", reason: null } });
  });

  it("refuses past days, reversed or over-long ranges, impossible dates and long reasons", () => {
    expect(parseClosureForm(form({ startsOn: "2026-10-26" }), today)).toMatchObject({ ok: false, fieldErrors: { startsOn: "Choose today or a later date." } });
    expect(parseClosureForm(form({ startsOn: "2026-11-02", endsOn: "2026-11-01" }), today)).toMatchObject({ ok: false, fieldErrors: { endsOn: expect.stringMatching(/on or after/) } });
    expect(parseClosureForm(form({ startsOn: "2026-11-02", endsOn: "2027-11-03" }), today)).toMatchObject({ ok: false, fieldErrors: { endsOn: expect.stringMatching(/up to a year/) } });
    expect(parseClosureForm(form({ startsOn: "2026-02-30" }), today)).toMatchObject({ ok: false, fieldErrors: { startsOn: expect.any(String) } });
    expect(parseClosureForm(form({ startsOn: "2026-11-02", reason: "x".repeat(201) }), today)).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
  });
});

describe("booking rules", () => {
  it("parses postcode districts as create_booking() compares them: upper case, exact outward codes", () => {
    expect(parseServiceArea("dn1, DN2  dn4;s60 DN1")).toEqual({ districts: ["DN1", "DN2", "DN4", "S60"], invalid: [] });
    // A whole postcode splits into its district (kept) and inward code (refused).
    expect(parseServiceArea("DN, DN1 2AB, W1A, EC1A")).toEqual({ districts: ["DN1", "W1A", "EC1A"], invalid: ["DN", "2AB"] });
    expect(parseServiceArea("")).toEqual({ districts: [], invalid: [] });
  });

  it("reads the garage columns within their checks", () => {
    expect(parseBookingRulesForm(form({ slotStepMin: "30", approveOnline: "on", cancellationCutoffH: "48", mobileTravelMin: "20", serviceArea: "dn1 dn2" }))).toEqual({
      ok: true,
      value: { slot_step_min: 30, approve_online: true, cancellation_cutoff_h: 48, mobile_travel_min: 20, service_area: ["DN1", "DN2"] },
    });
    const bad = parseBookingRulesForm(form({ slotStepMin: "7", cancellationCutoffH: "721", mobileTravelMin: "-1", serviceArea: "Doncaster" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fieldErrors).sort()).toEqual(["cancellationCutoffH", "mobileTravelMin", "serviceArea", "slotStepMin"]);
  });
});

describe("resources", () => {
  it("needs a name of up to 60 characters and a known kind", () => {
    expect(parseResourceForm(form({ name: "  Bay   4 ", kind: "bay" }), { withKind: true })).toEqual({ ok: true, value: { name: "Bay 4", kind: "bay" } });
    expect(parseResourceForm(form({ name: "", kind: "lift" }), { withKind: true })).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String), kind: expect.any(String) } });
    expect(parseResourceForm(form({ name: "x".repeat(61) }), { withKind: false })).toMatchObject({ ok: false, fieldErrors: { name: expect.stringMatching(/60 characters/) } });
  });
});

describe("branding", () => {
  it("keeps the four palette colours as they are", () => {
    for (const colour of Object.keys(ACCENT_NAMES)) expect(chooseAccent(colour)).toEqual({ requested: colour, saved: colour, adjusted: false });
  });

  it("darkens a colour white text can't be read on until it passes 4.5:1 on white and the booking background", () => {
    const choice = chooseAccent("#FFCC00");
    expect(choice?.requested).toBe("#ffcc00");
    expect(choice?.adjusted).toBe(true);
    expect(contrastRatio(choice!.saved, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(choice!.saved, BOOKING_BACKGROUND)).toBeGreaterThanOrEqual(4.5);
    expect(chooseAccent("#fc0")?.requested).toBe("#ffcc00");
    expect(chooseAccent("yellow")).toBeNull();
    expect(chooseAccent("#12345")).toBeNull();
  });

  it("knows a logo by its first bytes, not its name", () => {
    expect(sniffLogoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(sniffLogoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffLogoType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("webp");
    expect(sniffLogoType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffLogoType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it("stores the logo in the garage's own public-media folder", () => {
    expect(logoPath("11111111-1111-4111-8111-111111111111", "jpeg")).toBe("11111111-1111-4111-8111-111111111111/logo.jpg");
  });
});
