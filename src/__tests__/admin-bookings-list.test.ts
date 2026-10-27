import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanSearch, listBookings } from "@/lib/admin/data";
import { ADMIN_SEARCH_COOKIE, asBookingReference, bookingListHref, parseBookingListParams } from "@/lib/admin/search";
import { diaryParams, shapeWeek, UNASSIGNED_ROW } from "@/lib/admin/diary";
import { toAdminBooking, type AdminBookingRow } from "@/lib/admin/bookings";
import { timelineEntry } from "@/lib/admin/timeline";
import { createFakeSupabase, filterValue, hasFilter } from "./support/fake-supabase";
import { testGarage } from "./support/garage";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const garage = testGarage();

const harness = vi.hoisted(() => ({
  context: null as null | Record<string, unknown>,
  cookies: [] as Array<[string, string, Record<string, unknown>]>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: (name: string, value: string, options: Record<string, unknown>) => harness.cookies.push([name, value, options]) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: vi.fn(async () => harness.context) }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    throw new Error("search must use the RLS client");
  },
}));

import { searchAdmin } from "@/lib/admin/search-actions";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  harness.context = null;
  harness.cookies = [];
});

describe("bookings list query", () => {
  it("filters by status and local appointment dates, newest booked first, one page at a time", async () => {
    const fake = createFakeSupabase({ from: () => ({ data: [], count: 0 }) });
    await listBookings(fake.client, { status: "ready", from: "2026-10-24", to: "2026-10-25", page: 3, pageSize: 25 });
    const [query] = fake.queries;
    expect(query?.table).toBe("bookings");
    expect(hasFilter(query!, "is", "deleted_at", null)).toBe(true);
    expect(filterValue(query!, "eq", "status")).toBe("ready");
    // Local midnight on Sat 24 Oct (BST) to local midnight after Sun 25 Oct (GMT): the 25-hour day counts.
    expect(filterValue(query!, "gte", "starts_at")).toBe("2026-10-23T23:00:00.000Z");
    expect(filterValue(query!, "lt", "starts_at")).toBe("2026-10-26T00:00:00.000Z");
    expect(query!.filters.find((filter) => filter.method === "order")?.args).toEqual(["created_at", { ascending: false }]);
    expect(query!.filters.find((filter) => filter.method === "range")?.args).toEqual([50, 74]);
  });

  it("searches references, customer names, mobiles and registrations through the RLS client", async () => {
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.table === "customers") return { data: [{ id: "c-1" }] };
        if (query.table === "vehicles") return { data: [{ id: "v-1" }] };
        return { data: [], count: 0 };
      },
    });
    await listBookings(fake.client, { search: "ma12 bcd" });
    const vehicles = fake.queries.find((query) => query.table === "vehicles");
    // Registrations are matched exactly in their stored form, never as a URL of the admin.
    expect(filterValue(vehicles!, "eq", "registration")).toBe("MA12BCD");
    const customers = fake.queries.find((query) => query.table === "customers");
    expect(filterValue(customers!, "ilike", "name")).toBe("%ma12 bcd%");
    const bookings = fake.queries.find((query) => query.table === "bookings")!;
    expect(bookings.filters.find((filter) => filter.method === "or")?.args[0]).toBe("customer_id.in.(c-1),vehicle_id.in.(v-1)");

    const byPhone = createFakeSupabase({ from: (query) => (query.table === "customers" ? { data: [{ id: "c-2" }] } : { data: [] }) });
    await listBookings(byPhone.client, { search: "07700 900123" });
    expect(byPhone.queries.some((query) => query.table === "customers" && filterValue(query, "eq", "phone") === "+447700900123")).toBe(true);
  });

  it("answers no rows when nothing matches, without listing every booking", async () => {
    const fake = createFakeSupabase({ from: () => ({ data: [] }) });
    await expect(listBookings(fake.client, { search: "Nobody" })).resolves.toMatchObject({ rows: [], total: 0 });
    expect(fake.queries.some((query) => query.table === "bookings")).toBe(false);
  });

  it("strips PostgREST filter syntax from search terms", () => {
    expect(cleanSearch("  smith),status.eq.cancelled ")).toBe("smith status.eq.cancelled");
    expect(cleanSearch("O'Neil*%")).toBe("O'Neil");
    expect(cleanSearch("x".repeat(100))).toHaveLength(60);
  });
});

describe("bookings list URL", () => {
  it("keeps status, dates and page in the query string, never a search term", () => {
    expect(parseBookingListParams({ status: "ready", from: "2026-10-30", to: "2026-10-01", page: "2", search: "1" })).toEqual({
      status: "ready",
      from: "2026-10-30",
      to: "2026-10-30",
      page: 2,
      searched: true,
    });
    expect(parseBookingListParams({ status: "deleted", from: "2026-02-31", page: "-4" })).toEqual({ status: null, from: null, to: null, page: 1, searched: false });
    expect(bookingListHref({ status: "requested", from: "2026-10-01", searched: true, page: 2 })).toBe("/app/bookings?status=requested&from=2026-10-01&search=1&page=2");
    expect(bookingListHref({})).toBe("/app/bookings");
  });

  it("recognises booking references", () => {
    expect(asBookingReference("hrm-1234")).toBe("HRM-1234");
    expect(asBookingReference("HRM 1234")).toBeNull();
    expect(asBookingReference("MA12BCD")).toBeNull();
  });
});

describe("admin search action", () => {
  function signedIn(handler: Parameters<typeof createFakeSupabase>[0] = {}) {
    const fake = createFakeSupabase(handler);
    harness.context = { user: { id: "user-1" }, garage, client: fake.client, mfaState: "verified" };
    return fake;
  }

  it("keeps the term in an httpOnly cookie and sends the browser to the list with only a flag", async () => {
    signedIn();
    await expect(searchAdmin(form({ q: "MA12 BCD", status: "ready" }))).rejects.toThrow("REDIRECT:/app/bookings?status=ready&search=1");
    expect(harness.cookies).toEqual([[ADMIN_SEARCH_COOKIE, "MA12 BCD", expect.objectContaining({ httpOnly: true, path: "/app", sameSite: "strict" })]]);
  });

  it("opens a booking straight away for its exact reference", async () => {
    const fake = signedIn({ from: () => ({ data: { id: "0f8fad5b-d9cb-469f-a165-70867728950e" } }) });
    await expect(searchAdmin(form({ q: "hrm-1234" }))).rejects.toThrow("REDIRECT:/app/bookings/0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(filterValue(fake.queries[0]!, "eq", "reference")).toBe("HRM-1234");
    expect(harness.cookies).toEqual([]);
  });

  it("clears the search with an empty term, and sends signed-out users to sign in", async () => {
    signedIn();
    await expect(searchAdmin(form({ q: "  " }))).rejects.toThrow("REDIRECT:/app/bookings");
    expect(harness.cookies[0]?.[1]).toBe("");
    expect(harness.cookies[0]?.[2]).toMatchObject({ maxAge: 0 });
    harness.context = null;
    await expect(searchAdmin(form({ q: "x" }))).rejects.toThrow("REDIRECT:/app/login");
  });

  it("is posted from every search box", () => {
    expect(read("src/components/admin-ui/admin-search.tsx")).toContain('method={typeof action === "string" ? "post" : undefined}');
    expect(read("src/app/app/(protected)/layout.tsx")).toContain("searchAction={searchAdmin}");
    const list = read("src/app/app/(protected)/bookings/page.tsx");
    expect(list).toContain("<form action={searchAdmin}");
    expect(list).not.toMatch(/<form[^>]*method="get"[^>]*>[\s\S]{0,400}name=\{ADMIN_SEARCH_FIELD\}/);
  });
});

describe("bookings list page", () => {
  const source = read("src/app/app/(protected)/bookings/page.tsx");

  it("lists through the garage's RLS client with bulk trash and status filters", () => {
    expect(source).toContain("listBookings(admin.client");
    expect(source).not.toContain("createAdminClient");
    expect(source).toContain('<AdminBulkActions entity="bookings"');
    expect(source).toContain("Date booked");
    expect(source).toContain("Every booking, newest first.");
  });

  it("keeps the email-thread action on booking details instead of every list row", () => {
    const detail = read("src/app/app/(protected)/bookings/[id]/page.tsx");
    const actions = read("src/app/app/(protected)/bookings/actions.ts");
    const button = read("src/components/admin/booking-email-thread-button.tsx");
    expect(source).not.toContain("startBookingEnquiryThreadAction");
    expect(detail).toContain("startBookingEnquiryThreadAction");
    expect(detail).toContain("<BookingEmailThreadButton");
    expect(button).toContain("Email customer");
    expect(button).toContain("useFormStatus");
    expect(actions).toContain('.rpc("create_booking_enquiry_thread"');
    expect(actions).toContain("redirect(`/app/enquiries/${enquiryId.data}`)");
  });
});

describe("diary week", () => {
  let counter = 0;
  function booking(overrides: Partial<AdminBookingRow>) {
    counter += 1;
    return toAdminBooking({
      id: `b-${counter}`,
      reference: `HRM-${2000 + counter}`,
      status: "confirmed",
      source: "online",
      starts_at: "2026-10-27T10:00:00Z",
      ends_at: "2026-10-27T11:00:00Z",
      created_at: "2026-10-20T10:00:00Z",
      resource_id: "bay-1",
      ...overrides,
    });
  }

  it("takes the week from ?week= or ?day=, Monday first", () => {
    expect(diaryParams({ week: "2026-10-29" }, "2026-10-27")).toEqual({ day: null, monday: "2026-10-26" });
    expect(diaryParams({ day: "2026-11-01" }, "2026-10-27")).toEqual({ day: "2026-11-01", monday: "2026-10-26" });
    expect(diaryParams({ week: "nonsense" }, "2026-10-25")).toEqual({ day: null, monday: "2026-10-19" });
  });

  it("puts bookings in their bay and day, keeps unknown bays in an Unassigned row, and leaves out released ones", () => {
    const week = shapeWeek({
      monday: "2026-10-19",
      resources: [
        { id: "bay-1", name: "Bay 1" },
        { id: "bay-2", name: "Bay 2" },
      ],
      opening: new Map([[1, [{ opens: "08:00", closes: "17:30" }]], [7, []]]),
      now: new Date("2026-10-25T12:00:00Z"),
      bookings: [
        // Sun 25 Oct, 00:30 BST (23:30 UTC on the 24th) is Sunday locally.
        booking({ starts_at: "2026-10-24T23:30:00Z", ends_at: "2026-10-25T00:30:00Z" }),
        booking({ starts_at: "2026-10-19T09:00:00Z", resource_id: "bay-2" }),
        booking({ starts_at: "2026-10-19T08:00:00Z", resource_id: null }),
        booking({ starts_at: "2026-10-20T09:00:00Z", status: "cancelled" }),
        booking({ starts_at: "2026-10-27T09:00:00Z" }),
      ],
    });
    expect(week.rows.map((row) => row.id)).toEqual(["bay-1", "bay-2", UNASSIGNED_ROW]);
    expect(week.cells["bay-1"]!["2026-10-25"]).toHaveLength(1);
    expect(week.cells["bay-2"]!["2026-10-19"]).toHaveLength(1);
    expect(week.cells[UNASSIGNED_ROW]!["2026-10-19"]).toHaveLength(1);
    expect(week.total).toBe(3);
    expect(week.days.map((day) => [day.date, day.open, day.isToday])).toEqual([
      ["2026-10-19", true, false],
      ["2026-10-20", false, false],
      ["2026-10-21", false, false],
      ["2026-10-22", false, false],
      ["2026-10-23", false, false],
      ["2026-10-24", false, false],
      ["2026-10-25", false, true],
    ]);
  });
});

describe("booking timeline", () => {
  const base = { id: "e1", actorId: null, at: "2026-10-27T09:00:00Z" };

  it("words each event and who made it", () => {
    expect(timelineEntry({ ...base, type: "created", actor: "customer", data: { source: "online", status: "requested" } })).toMatchObject({
      kind: "created",
      title: "Booking made",
      detail: "Booked online, waiting for your OK",
      actor: "Customer",
    });
    expect(timelineEntry({ ...base, type: "status_changed", actor: "staff", actorId: "me", data: { from: "in_progress", to: "ready" } }, { currentUserId: "me" })).toMatchObject({
      title: "Status: Ready",
      detail: "In bay → Ready",
      actor: "You",
    });
    expect(timelineEntry({ ...base, type: "status_changed", actor: "staff", actorId: "someone-else", data: { from: "requested", to: "confirmed" } }, { currentUserId: "me" }).actor).toBe("Staff");
    expect(timelineEntry({ ...base, type: "cancelled", actor: "system", data: { reason: "Customer rang" } })).toMatchObject({ title: "Booking cancelled", detail: "Customer rang", actor: "System" });
    expect(timelineEntry({ ...base, type: "rescheduled", actor: "customer", data: { from: "2026-10-28T09:00:00Z", to: "2026-10-29T13:30:00Z" } }).detail).toBe("Wed 28 Oct, 09:00 → Thu 29 Oct, 13:30");
    expect(timelineEntry({ ...base, type: "note", actor: "staff", data: { text: "Keys in the box" } })).toMatchObject({ kind: "note", detail: "Keys in the box" });
    expect(timelineEntry({ ...base, type: "notification_sent", actor: "system", data: { kind: "sms", status: "sent" } }).title).toBe("Text to the customer sent");
    expect(timelineEntry({ ...base, type: "mystery", actor: "agent", data: {} })).toMatchObject({ kind: "other", actor: "AI agent" });
  });
});
