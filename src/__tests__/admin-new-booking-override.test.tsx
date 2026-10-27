// @vitest-environment jsdom

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { zonedInstant } from "@/lib/admin/dates";
import { checkOverrideTime, OVERRIDE_HOURS_HINT } from "@/lib/admin/staff-times";
import { createFakeSupabase, filterValue, hasFilter } from "./support/fake-supabase";
import { testGarage } from "./support/garage";

// /app/bookings/new after the staff rules (A177-A183): every service that isn't deleted is listed,
// offered online or not (MOT only when the garage does MOTs), and "Outside opening hours" adds a
// free date and time in the garage's zone, on the 5 minutes, posted with `overrideHours=on`.

const harness = vi.hoisted(() => ({ context: null as null | Record<string, unknown> }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/tenancy/admin", () => ({ getAdminContext: vi.fn(async () => harness.context) }));
vi.mock("@/lib/admin/data", () => ({ loadOpeningHours: vi.fn(async () => new Map([[1, [{ opens: "08:00", closes: "17:30" }]]])) }));
vi.mock("@/app/app/(protected)/bookings/new/actions", () => ({
  createStaffBookingAction: vi.fn(async () => ({ status: "idle", message: "" })),
  getStaffSlotsAction: vi.fn(async () => ({ ok: true, slots: [] })),
}));
vi.mock("@/app/app/(protected)/bookings/_components/slot-picker", () => ({
  SlotPicker: ({ onChange, value }: { onChange: (value: string) => void; value: string | null }) => (
    <button type="button" aria-pressed={value === "2026-10-28T09:00:00.000Z"} onClick={() => onChange("2026-10-28T09:00:00.000Z")}>
      Grid 09:00
    </button>
  ),
}));

const { default: NewBookingPage } = await import("@/app/app/(protected)/bookings/new/page");
const { NewBookingForm } = await import("@/app/app/(protected)/bookings/new/new-booking-form");

const garage = testGarage();

/** The first element of `type` in a rendered server component's tree. */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return find((node.props as { children?: ReactNode }).children, type);
}

describe("services staff can book", () => {
  const rows = [
    { id: "s1", name: "Diagnostics", duration_min: 60, price_pence: 4950, price_mode: "fixed", location_mode: "both", is_mot: false, online_enabled: true },
    { id: "s2", name: "Fleet inspection", duration_min: 45, price_pence: null, price_mode: "quote", location_mode: "workshop", is_mot: false, online_enabled: false },
    { id: "s3", name: "MOT", duration_min: 45, price_pence: 5485, price_mode: "fixed", location_mode: "workshop", is_mot: true, online_enabled: true },
  ];

  async function services(motEnabled: boolean) {
    const fake = createFakeSupabase({ from: () => ({ data: rows }) });
    harness.context = { garage: { ...garage, motEnabled }, client: fake.client, role: "technician" };
    const tree = await NewBookingPage();
    const form = find(tree, NewBookingForm);
    return { fake, form: form?.props as { services: Array<{ id: string; onlineEnabled: boolean }>; today: string } };
  }

  it("lists services that aren't offered online, never deleted ones, for the session's garage", async () => {
    const { fake, form } = await services(true);
    const query = fake.queries.find((item) => item.table === "services")!;
    expect(hasFilter(query, "is", "deleted_at", null)).toBe(true);
    expect(filterValue(query, "eq", "garage_id")).toBe(garage.id);
    expect(hasFilter(query, "eq", "online_enabled")).toBe(false);
    expect(form.services.map((service) => [service.id, service.onlineEnabled])).toEqual([
      ["s1", true],
      ["s2", false],
      ["s3", true],
    ]);
    expect(form.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("leaves MOT services out when the garage doesn't do MOTs", async () => {
    const { form } = await services(false);
    expect(form.services.map((service) => service.id)).toEqual(["s1", "s2"]);
  });
});

describe("outside opening hours", () => {
  it("turns a garage wall-clock time into the right instant, clock changes included", () => {
    expect(zonedInstant("2026-10-27T07:30", "Europe/London")?.toISOString()).toBe("2026-10-27T07:30:00.000Z");
    expect(zonedInstant("2026-10-24T07:30", "Europe/London")?.toISOString()).toBe("2026-10-24T06:30:00.000Z");
    // 25 Oct 2026: 01:30 happens twice; the first (BST) is taken.
    expect(zonedInstant("2026-10-25T01:30", "Europe/London")?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    // 29 Mar 2026: 01:30 never happens.
    expect(zonedInstant("2026-03-29T01:30", "Europe/London")).toBeNull();
    expect(zonedInstant("2026-03-29T02:30", "Europe/London")?.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(zonedInstant("2026-02-30T09:00", "Europe/London")).toBeNull();
  });

  it("checks the typed time before it is posted", () => {
    const today = "2026-10-27";
    expect(checkOverrideTime("2026-10-27T07:30", { today })).toEqual({ ok: true, startsAt: "2026-10-27T07:30:00.000Z" });
    expect(checkOverrideTime("", { today })).toEqual({ ok: false, error: "Enter the date and time." });
    expect(checkOverrideTime("2026-10-27T07:32", { today })).toMatchObject({ ok: false, error: expect.stringMatching(/5-minute mark/) });
    expect(checkOverrideTime("2026-10-26T19:00", { today })).toMatchObject({ ok: false, error: "Pick today or a later day." });
    expect(checkOverrideTime("2028-10-27T09:00", { today })).toMatchObject({ ok: false, error: "Pick a day within the next two years." });
    expect(checkOverrideTime("2027-03-28T01:30", { today })).toMatchObject({ ok: false, error: expect.stringMatching(/clocks go forward/) });
    expect(checkOverrideTime("2026-13-01T09:00", { today })).toMatchObject({ ok: false, error: expect.stringMatching(/^Enter a date and a time/) });
  });

  function form() {
    const services = [{ id: "6f1c2b9e-1d3a-4c5b-8e7f-90a1b2c3d4e5", name: "Diagnostics", durationMin: 60, pricePence: 4950, priceMode: "fixed" as const, locationMode: "workshop" as const, onlineEnabled: false }];
    const view = render(<NewBookingForm services={services} days={["2026-10-27"]} closedDays={[]} timeZone="Europe/London" today="2026-10-27" idempotencyKey="3b2f8c1e-0a4d-4e6f-9b7a-1c2d3e4f5a6b" />);
    const hidden = () => (view.container.querySelector('input[name="startsAt"]') as HTMLInputElement).value;
    return { view, hidden };
  }

  it("adds a free date and time when ticked, and posts overrideHours=on with it", async () => {
    const user = userEvent.setup();
    const { view, hidden } = form();
    expect(screen.getByRole("option", { name: /Diagnostics .* not offered online/ })).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: "Outside opening hours" });
    expect(box).toHaveAccessibleDescription(OVERRIDE_HOURS_HINT);
    expect(screen.queryByLabelText("Date and time")).toBeNull();

    await user.click(box);
    const field = screen.getByLabelText<HTMLInputElement>("Date and time");
    expect(field).toHaveAttribute("type", "datetime-local");
    expect(field).toHaveAttribute("step", "300");
    expect(field).toHaveAttribute("min", "2026-10-27T00:00");

    // A typed time wins over the grid...
    await user.click(screen.getByRole("button", { name: "Grid 09:00" }));
    expect(hidden()).toBe("2026-10-28T09:00:00.000Z");
    // A change event: datetime-local only reports complete values.
    fireEvent.change(field, { target: { value: "2026-10-27T18:45" } });
    expect(hidden()).toBe("2026-10-27T18:45:00.000Z");
    expect(screen.getByRole("button", { name: "Grid 09:00" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Book in for Tue 27 Oct, 18:45$/ })).toBeInTheDocument();
    const data = new FormData(view.container.querySelector("form")!);
    expect(data.get("overrideHours")).toBe("on");
    expect(data.get("startsAt")).toBe("2026-10-27T18:45:00.000Z");

    // ...until a grid time is picked again.
    await user.click(screen.getByRole("button", { name: "Grid 09:00" }));
    expect(hidden()).toBe("2026-10-28T09:00:00.000Z");
    expect(field.value).toBe("");
  });

  it("explains a time that can't be booked and posts no time", async () => {
    const user = userEvent.setup();
    const { hidden } = form();
    await user.click(screen.getByRole("checkbox", { name: "Outside opening hours" }));
    const field = screen.getByLabelText("Date and time");
    fireEvent.change(field, { target: { value: "2026-10-27T18:47" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/5-minute mark/);
    expect(hidden()).toBe("");
    // Unticking goes back to the grid and the box isn't posted.
    await user.click(screen.getByRole("checkbox", { name: "Outside opening hours" }));
    expect(screen.queryByLabelText("Date and time")).toBeNull();
  });
});
