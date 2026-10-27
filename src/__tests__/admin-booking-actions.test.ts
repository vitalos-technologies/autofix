import { beforeEach, describe, expect, it, vi } from "vitest";
import { canChangeStatus, nextStatuses, quickStatusActions, STAFF_STATUS_TRANSITIONS, statusActionLabel } from "@/lib/admin/booking-status";
import { bookingStatuses } from "@/lib/booking-engine/types";
import { createFakeSupabase, filterValue, hasFilter, type FakeQuery, type FakeResult } from "./support/fake-supabase";
import { otherTestGarage, testGarage } from "./support/garage";

// Staff booking actions (Today, Diary, booking page) write through the
// selected garage's RLS client only: getAdminContext().client, never the
// service role, and never a garage id from the form.

const garage = testGarage();
const other = otherTestGarage();
const BOOKING = "0f8fad5b-d9cb-469f-a165-70867728950e";
const USER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const harness = vi.hoisted(() => ({
  context: null as null | Record<string, unknown>,
  revalidated: [] as string[],
  notified: [] as unknown[],
  cleared: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => harness.revalidated.push(path) }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: vi.fn(async () => harness.context) }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    throw new Error("service role must not be used by staff booking actions");
  },
  createClient: () => {
    throw new Error("actions must use the context's RLS client");
  },
}));
vi.mock("@/lib/booking-engine/notify", () => ({ notifyBooking: (notice: unknown) => harness.notified.push(notice) }));
vi.mock("@/lib/booking-engine/slots", () => ({ clearSlotCache: (garageId: unknown) => harness.cleared.push(garageId) }));

import {
  acceptBookingAction,
  addBookingNoteAction,
  changeBookingStatusFormAction,
  quickStatusAction,
} from "@/app/app/(protected)/bookings/status-actions";

type Handler = (query: FakeQuery) => FakeResult;

function useClient(handler: Handler) {
  const fake = createFakeSupabase({ from: handler });
  harness.context = {
    user: { id: USER },
    garage,
    role: "manager",
    memberships: [{ garageId: garage.id, name: garage.name, role: "manager" }],
    client: fake.client,
    mfaRequired: true,
    mfaVerified: true,
    mfaState: "verified",
  };
  return fake;
}

/** A booking in `status` that accepts the conditional update. */
function bookingIn(status: string, { updated = true }: { updated?: boolean } = {}): Handler {
  return (query) => {
    if (query.table !== "bookings") return {};
    if (query.operation === "select") return { data: { id: BOOKING, status } };
    if (query.operation === "update") return { data: updated ? { id: BOOKING, status: (query.values as { status?: string }).status ?? status } : null };
    return {};
  };
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const idle = { status: "idle" as const, message: "" };

beforeEach(() => {
  harness.context = null;
  harness.revalidated = [];
  harness.notified = [];
  harness.cleared = [];
});

describe("status rules", () => {
  it("follows the workshop path and stops at finished bookings", () => {
    expect(nextStatuses("requested")).toEqual(["confirmed", "cancelled"]);
    expect(canChangeStatus("confirmed", "arrived")).toBe(true);
    expect(canChangeStatus("arrived", "in_progress")).toBe(true);
    expect(canChangeStatus("in_progress", "waiting_parts")).toBe(true);
    expect(canChangeStatus("waiting_parts", "in_progress")).toBe(true);
    expect(canChangeStatus("in_progress", "ready")).toBe(true);
    expect(canChangeStatus("ready", "collected")).toBe(true);
    expect(canChangeStatus("confirmed", "no_show")).toBe(true);
    for (const finished of ["collected", "cancelled", "no_show"] as const) {
      expect(nextStatuses(finished)).toEqual([]);
    }
    // No skipping back to a request, no reviving a cancelled booking, no self-transition.
    expect(canChangeStatus("confirmed", "requested")).toBe(false);
    expect(canChangeStatus("cancelled", "confirmed")).toBe(false);
    expect(canChangeStatus("ready", "ready")).toBe(false);
    expect(canChangeStatus("requested", "in_progress")).toBe(false);
    expect(canChangeStatus("ready", "no_show")).toBe(false);
  });

  it("covers every status, and quick actions are allowed transitions", () => {
    expect(Object.keys(STAFF_STATUS_TRANSITIONS).sort()).toEqual([...bookingStatuses].sort());
    for (const status of bookingStatuses) {
      for (const to of quickStatusActions(status)) expect(canChangeStatus(status, to), `${status} → ${to}`).toBe(true);
    }
    expect(statusActionLabel("confirmed")).toBe("Accept");
    expect(statusActionLabel("cancelled", "requested")).toBe("Decline");
    expect(statusActionLabel("in_progress", "waiting_parts")).toBe("Parts in, back in the bay");
  });
});

describe("accept and quick status changes", () => {
  it("accepts a request through the RLS client, conditional on the status it read", async () => {
    const fake = useClient(bookingIn("requested"));
    await acceptBookingAction(form({ bookingId: BOOKING, garageId: other.id }));

    const [read, update, seen] = fake.queries;
    expect(read).toMatchObject({ table: "bookings", operation: "select" });
    expect(filterValue(read!, "eq", "id")).toBe(BOOKING);
    expect(update).toMatchObject({ table: "bookings", operation: "update", values: { status: "confirmed" } });
    // The garage comes from the session, never from the form.
    expect(filterValue(update!, "eq", "garage_id")).toBe(garage.id);
    expect(hasFilter(update!, "eq", "status", "requested")).toBe(true);
    expect(seen).toMatchObject({ table: "bookings", operation: "update" });
    expect(Object.keys(seen!.values as object)).toEqual(["admin_seen_at"]);
    expect(hasFilter(seen!, "is", "admin_seen_at", null)).toBe(true);
    // The status trigger writes the timeline event; the action inserts none.
    expect(fake.queries.some((query) => query.table === "booking_events")).toBe(false);
    expect(harness.revalidated).toContain("/app");
    // A88: the customer is told the booking is confirmed (queued as notifications.booking).
    expect(harness.notified).toEqual([{ type: "confirmed", garageId: garage.id, bookingId: BOOKING }]);
  });

  it("sends no confirmation when someone else accepted it first, or for other changes", async () => {
    useClient(bookingIn("requested", { updated: false }));
    await expect(acceptBookingAction(form({ bookingId: BOOKING }))).rejects.toThrow(`REDIRECT:/app/bookings/${BOOKING}?notice=stale`);
    useClient(bookingIn("confirmed"));
    await quickStatusAction(form({ bookingId: BOOKING, status: "arrived" }));
    expect(harness.notified).toEqual([]);
  });

  it("refuses a change the status does not allow, without writing", async () => {
    const fake = useClient(bookingIn("collected"));
    await expect(quickStatusAction(form({ bookingId: BOOKING, status: "ready" }))).rejects.toThrow(`REDIRECT:/app/bookings/${BOOKING}?notice=not_allowed`);
    expect(fake.queries.filter((query) => query.operation !== "select")).toEqual([]);
  });

  it("reports a booking someone else just changed", async () => {
    useClient(bookingIn("in_progress", { updated: false }));
    await expect(quickStatusAction(form({ bookingId: BOOKING, status: "ready" }))).rejects.toThrow(`REDIRECT:/app/bookings/${BOOKING}?notice=stale`);
  });

  it("treats another garage's booking as not found", async () => {
    useClient((query) => (query.table === "bookings" ? { data: null } : {}));
    await expect(acceptBookingAction(form({ bookingId: BOOKING }))).rejects.toThrow(`REDIRECT:/app/bookings/${BOOKING}?notice=not_found`);
  });

  it("asks for MFA before any write", async () => {
    const fake = useClient(bookingIn("requested"));
    harness.context = { ...harness.context, mfaRequired: true, mfaVerified: false, mfaState: "trusted" };
    await expect(acceptBookingAction(form({ bookingId: BOOKING }))).rejects.toThrow(/^REDIRECT:\/app\/mfa\?returnTo=/);
    expect(fake.queries).toEqual([]);
    harness.context = null;
    await expect(acceptBookingAction(form({ bookingId: BOOKING }))).rejects.toThrow("REDIRECT:/app/login");
  });
});

describe("booking page status and notes", () => {
  it("cancels with a reason, tells the customer and frees the slot", async () => {
    const fake = useClient(bookingIn("confirmed"));
    const state = await changeBookingStatusFormAction(idle, form({ bookingId: BOOKING, status: "cancelled", reason: "  Customer rang to cancel " }));
    expect(state).toEqual({ status: "done", message: "Booking cancelled." });
    expect(fake.queries[1]).toMatchObject({ operation: "update", values: { status: "cancelled", cancellation_reason: "Customer rang to cancel" } });
    expect(harness.notified).toEqual([{ type: "cancelled", garageId: garage.id, bookingId: BOOKING }]);
    expect(harness.cleared).toEqual([garage.id]);
  });

  it("marks a car ready and answers with a message", async () => {
    useClient(bookingIn("in_progress"));
    await expect(changeBookingStatusFormAction(idle, form({ bookingId: BOOKING, status: "ready" }))).resolves.toEqual({ status: "done", message: "Marked ready to collect." });
    expect(harness.notified).toEqual([]);
    expect(harness.cleared).toEqual([]);
  });

  it("rejects unknown statuses and ids before touching the database", async () => {
    const fake = useClient(bookingIn("confirmed"));
    await expect(changeBookingStatusFormAction(idle, form({ bookingId: BOOKING, status: "deleted" }))).resolves.toMatchObject({ status: "error" });
    await expect(changeBookingStatusFormAction(idle, form({ bookingId: "nope", status: "ready" }))).resolves.toMatchObject({ status: "error" });
    expect(fake.queries).toEqual([]);
  });

  it("adds a note as the signed-in member in the selected garage", async () => {
    const fake = useClient((query) => (query.table === "bookings" ? { data: { id: BOOKING } } : {}));
    const state = await addBookingNoteAction(idle, form({ bookingId: BOOKING, note: "Customer will drop the keys off at 8.", garageId: other.id }));
    expect(state).toEqual({ status: "done", message: "Note added." });
    const insert = fake.queries.find((query) => query.operation === "insert");
    expect(insert).toMatchObject({
      table: "booking_events",
      values: { garage_id: garage.id, booking_id: BOOKING, type: "note", actor: "staff", actor_id: USER, data: { text: "Customer will drop the keys off at 8." } },
    });
  });

  it("does not save an empty or very long note", async () => {
    const fake = useClient(() => ({}));
    await expect(addBookingNoteAction(idle, form({ bookingId: BOOKING, note: "   " }))).resolves.toEqual({ status: "error", message: "Write the note first." });
    await expect(addBookingNoteAction(idle, form({ bookingId: BOOKING, note: "x".repeat(1001) }))).resolves.toMatchObject({ status: "error" });
    expect(fake.queries).toEqual([]);
  });
});
