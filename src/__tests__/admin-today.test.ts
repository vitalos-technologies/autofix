import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toAdminBooking, type AdminBooking, type AdminBookingRow } from "@/lib/admin/bookings";
import { addDays, isoWeekday, localDateKey, localDayRange, localMinutes, localWeekRange, parseDateKey, startOfLocalDay, weekStart } from "@/lib/admin/dates";
import { diaryHours, formatWholePounds, shapeToday, todayChips, todayHeadline } from "@/lib/admin/today";

const NOW = new Date("2026-10-27T09:40:00Z"); // Tue 27 Oct 2026, 09:40 GMT

let counter = 0;
function row(overrides: Partial<AdminBookingRow> = {}): AdminBookingRow {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    reference: `HRM-${1000 + counter}`,
    status: "confirmed",
    source: "online",
    starts_at: "2026-10-27T10:00:00Z",
    ends_at: "2026-10-27T11:00:00Z",
    created_at: "2026-10-20T12:00:00Z",
    resource_id: "bay-1",
    symptoms: [],
    services: { name: "Diagnostics" },
    customers: { name: "Sarah Okafor", phone: "+447700900101" },
    vehicles: { registration: "AB12CDE", make: "Ford", model: "Focus" },
    resources: { name: "Bay 1" },
    ...overrides,
  };
}

function booking(overrides: Partial<AdminBookingRow> = {}): AdminBooking {
  return toAdminBooking(row(overrides));
}

describe("garage-local dates", () => {
  it("validates calendar dates", () => {
    expect(parseDateKey("2026-10-27")).toBe("2026-10-27");
    expect(parseDateKey("2026-02-30")).toBeNull();
    expect(parseDateKey("27/10/2026")).toBeNull();
    expect(parseDateKey(undefined)).toBeNull();
  });

  it("finds Mondays and moves by calendar days", () => {
    expect(isoWeekday("2026-10-25")).toBe(7);
    expect(isoWeekday("2026-10-26")).toBe(1);
    expect(weekStart("2026-10-25")).toBe("2026-10-19");
    expect(weekStart("2026-10-27")).toBe("2026-10-26");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("starts local days at local midnight on both sides of a clock change", () => {
    // BST (UTC+1) until Sun 25 Oct 2026 02:00, then GMT.
    expect(startOfLocalDay("2026-10-24").toISOString()).toBe("2026-10-23T23:00:00.000Z");
    expect(startOfLocalDay("2026-10-25").toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(startOfLocalDay("2026-10-26").toISOString()).toBe("2026-10-26T00:00:00.000Z");
    // The 25-hour day.
    const autumn = localDayRange("2026-10-25");
    expect((Date.parse(autumn.to) - Date.parse(autumn.from)) / 3_600_000).toBe(25);
    // The 23-hour day: GMT until Sun 29 Mar 2026 01:00, then BST.
    const spring = localDayRange("2026-03-29");
    expect(spring.from).toBe("2026-03-29T00:00:00.000Z");
    expect((Date.parse(spring.to) - Date.parse(spring.from)) / 3_600_000).toBe(23);
  });

  it("reads wall-clock time and dates in the garage's zone", () => {
    expect(localDateKey(new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25");
    expect(localMinutes("2026-10-24T08:15:00Z")).toBe(9 * 60 + 15); // BST
    expect(localMinutes("2026-10-26T09:15:00Z")).toBe(9 * 60 + 15); // GMT
    const week = localWeekRange("2026-10-28");
    expect(week).toEqual({ monday: "2026-10-26", from: "2026-10-26T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" });
  });
});

describe("Today", () => {
  it("counts cars, the workshop, ready and collected, leaving out requests and released bookings", () => {
    const today = [
      booking({ status: "confirmed" }),
      booking({ status: "confirmed", starts_at: "2026-10-27T14:00:00Z", ends_at: "2026-10-27T15:00:00Z" }),
      booking({ status: "arrived" }),
      booking({ status: "in_progress" }),
      booking({ status: "waiting_parts" }),
      booking({ status: "ready" }),
      booking({ status: "collected" }),
      booking({ status: "requested" }),
      booking({ status: "cancelled" }),
      booking({ status: "no_show" }),
      // Tomorrow (outside the day): ignored even if passed in.
      booking({ status: "confirmed", starts_at: "2026-10-28T10:00:00Z", ends_at: "2026-10-28T11:00:00Z" }),
    ];
    const view = shapeToday({ today, requests: [], requestCount: 3, opening: [], now: NOW, firstName: "Dan" });
    expect(view.dateKey).toBe("2026-10-27");
    expect(view.figures).toEqual({ carsToday: 7, stillToArrive: 2, inWorkshop: 3, waitingParts: 1, ready: 1, collected: 1, toApprove: 3 });
    expect(view.headline).toBe("Morning, Dan. 7 cars in today.");
    expect(view.jobs.map((job) => job.status)).toEqual(["confirmed", "arrived", "in_progress", "waiting_parts", "ready", "collected", "confirmed"]);
    // The diary keeps the requested one (dashed) but not cancelled or no-show bookings.
    expect(view.diary.map((item) => item.status).sort()).toEqual(["arrived", "collected", "confirmed", "confirmed", "in_progress", "ready", "requested", "waiting_parts"]);
    expect(view.diary.find((item) => item.status === "waiting_parts")?.detail).toBe("waiting on parts");
    expect(view.diary[0]?.href).toMatch(/^\/app\/bookings\/[0-9a-f-]{36}$/);
  });

  it("lists requests soonest first and words the headline for any count", () => {
    const later = booking({ status: "requested", starts_at: "2026-10-29T09:00:00Z", ends_at: "2026-10-29T10:00:00Z" });
    const sooner = booking({ status: "requested", starts_at: "2026-10-28T09:15:00Z", ends_at: "2026-10-28T10:15:00Z" });
    const view = shapeToday({ today: [], requests: [later, sooner], opening: [], now: NOW });
    expect(view.approvals.map((item) => item.id)).toEqual([sooner.id, later.id]);
    expect(view.figures.toApprove).toBe(2);
    expect(view.headline).toBe("Morning. No cars in today.");
    expect(todayHeadline(1, new Date("2026-10-27T13:00:00Z"), "Europe/London", "Sam")).toBe("Afternoon, Sam. 1 car in today.");
    expect(todayHeadline(2, new Date("2026-10-27T19:00:00Z"))).toBe("Evening. 2 cars in today.");
  });

  it("makes the phone chips from the figures", () => {
    expect(todayChips({ carsToday: 9, stillToArrive: 2, inWorkshop: 3, waitingParts: 1, ready: 3, collected: 0, toApprove: 2 })).toEqual([
      { label: "9 cars", tone: "navy" },
      { label: "2 to approve", tone: "neutral", href: "#needs-ok-phone" },
      { label: "1 waiting parts", tone: "warning" },
      { label: "3 ready", tone: "success" },
    ]);
    expect(todayChips({ carsToday: 1, stillToArrive: 1, inWorkshop: 0, waitingParts: 0, ready: 0, collected: 0, toApprove: 0 })).toEqual([{ label: "1 car", tone: "navy" }]);
  });

  it("sizes the diary to the opening hours and widens it for bookings outside them", () => {
    expect(diaryHours([{ opens: "08:00:00", closes: "17:30:00" }], [])).toEqual({ startHour: 8, endHour: 18 });
    expect(diaryHours([{ opens: "08:30:00", closes: "13:00:00" }], [])).toEqual({ startHour: 8, endHour: 13 });
    expect(diaryHours([], [])).toEqual({ startHour: 8, endHour: 17 });
    // A split day, and a booking at 07:30 GMT that ends at 18:10.
    expect(
      diaryHours([{ opens: "08:00", closes: "12:00" }, { opens: "13:00", closes: "17:00" }], [{ startsAt: "2026-10-27T07:30:00Z", endsAt: "2026-10-27T18:10:00Z" }]),
    ).toEqual({ startHour: 7, endHour: 19 });
  });

  it("puts a 09:15 booking at 09:15 on the clock-change Sunday", () => {
    const sunday = new Date("2026-10-25T12:00:00Z");
    const item = booking({ status: "confirmed", starts_at: "2026-10-25T09:15:00Z", ends_at: "2026-10-25T10:15:00Z" });
    const view = shapeToday({ today: [item], requests: [], opening: [], now: sunday });
    expect(view.dateKey).toBe("2026-10-25");
    expect(view.figures.carsToday).toBe(1);
    expect(localMinutes(view.diary[0]!.startsAt)).toBe(9 * 60 + 15);
  });

  it("formats the won-back figure in whole pounds", () => {
    expect(formatWholePounds(194_000)).toBe("£1,940");
    expect(formatWholePounds(0)).toBe("£0");
    expect(formatWholePounds(9_999)).toBe("£99");
  });

  it("maps PostgREST rows defensively", () => {
    const mapped = toAdminBooking(row({ status: "mystery", source: "fax", vehicles: [{ registration: "ab12 cde", make: null, model: null }], customers: null, services: null, symptoms: ["Warning light", 3, ""] }));
    expect(mapped).toMatchObject({ status: "confirmed", source: "online", registration: "AB12CDE", customerName: "Customer", serviceName: "Booking", symptoms: ["Warning light"] });
  });
});

describe("Today page", () => {
  const page = readFileSync("src/app/app/(protected)/page.tsx", "utf8");

  it("reads through the garage's RLS client and offers the design's actions", () => {
    expect(page).toContain("getAdminContext({ allowTrustedDevice: true })");
    expect(page).not.toContain("createAdminClient");
    expect(page).toContain("loadBookingsStarting(admin.client");
    expect(page).toContain("acceptAction={acceptBookingAction}");
    expect(page).toContain('label: tone === "navy" ? "Other time" : "Offer another time"');
    expect(page).toContain('label: "Call back"');
    expect(page).toContain('title="Needs your OK"');
    expect(page).toContain('title="Reminders this week"');
    expect(page).toContain('label="Won back by reminders"');
    expect(page).toContain('label="Copy booking link"');
  });

  it("guards the P3.6 tables so Today works before they exist", () => {
    const data = readFileSync("src/lib/admin/data.ts", "utf8");
    expect(data).toContain('from("reminder_sends")');
    expect(data).toContain('from("calls")');
    expect(data).toContain("TODO(P3.6): switch to `reminder_won_back(");
  });
});
