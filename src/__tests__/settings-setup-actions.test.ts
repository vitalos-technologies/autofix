import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookingAccent } from "@/lib/branding/accent";
import { initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { createFakeSupabase, filterValue, hasFilter, type FakeQuery, type FakeResult } from "./support/fake-supabase";
import { otherTestGarage, testGarage } from "./support/garage";

// Setup server actions (P3.4): the role split matches the RLS policies
// (owners and managers: services, hours, closures, resources; owners only:
// garage columns, branding, MOT), validation happens before any write, and
// every write names the context's garage, never one from the form.

const harness = vi.hoisted(() => ({
  strict: null as null | Record<string, unknown>,
  loose: null as null | Record<string, unknown>,
  revalidated: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  slotCacheCleared: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => harness.revalidated.push(path) }));
vi.mock("@/lib/tenancy/admin", () => ({
  getAdminContext: vi.fn(async (options?: { requireMfa?: boolean }) => (options?.requireMfa === false ? harness.loose : harness.strict)),
}));
vi.mock("@/lib/admin/audit", () => ({
  recordAdminAudit: vi.fn(async (garageId: string, entry: Record<string, unknown>) => {
    harness.audits.push({ garageId, ...entry });
    return true;
  }),
}));
vi.mock("@/lib/booking-engine/slots", () => ({ clearSlotCache: (garageId: string) => harness.slotCacheCleared.push(garageId) }));

import { archiveServiceAction, moveServiceAction, saveServiceAction } from "@/app/app/(protected)/settings/services/actions";
import { addClosureAction, removeClosureAction, saveBookingRulesAction, saveOpeningHoursAction } from "@/app/app/(protected)/settings/hours/actions";
import { addResourceAction, deleteResourceAction, setResourceActiveAction } from "@/app/app/(protected)/settings/resources/actions";
import { saveAccentAction, setMotEnabledAction, uploadLogoAction } from "@/app/app/(protected)/settings/branding/actions";

const garage = testGarage();
const other = otherTestGarage();
const USER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";
const RESOURCE_ID = "44444444-4444-4444-8444-444444444444";
const CLOSURE_ID = "55555555-5555-4555-8555-555555555555";

type Role = "owner" | "manager" | "technician";
type Handler = (query: FakeQuery) => FakeResult | undefined;

function signIn(role: Role, handler: Handler = () => undefined, garageOverrides: Partial<typeof garage> = {}) {
  const fake = createFakeSupabase({ from: (query) => handler(query) ?? {} });
  harness.strict = { user: { id: USER_ID }, garage: { ...garage, ...garageOverrides }, role, client: fake.client, mfaState: "verified" };
  harness.loose = harness.strict;
  return fake;
}

function form(values: Record<string, string | string[] | File>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

const writes = (queries: FakeQuery[]) => queries.filter((query) => query.operation !== "select");

const validService = {
  name: "Diagnostics",
  description: "Warning lights traced.",
  priceMode: "fixed",
  price: "49.50",
  durationMin: "60",
  bufferMin: "15",
  locationMode: "both",
  resourceKind: "bay",
  onlineEnabled: "on",
  minNoticeH: "2",
  maxDaysAhead: "60",
};

beforeEach(() => {
  harness.strict = null;
  harness.loose = null;
  harness.revalidated = [];
  harness.audits = [];
  harness.slotCacheCleared = [];
});

describe("who may run a setup action", () => {
  it("sends signed-out users to login and members who still owe MFA to the challenge, before any query", async () => {
    await expect(saveServiceAction(initialSetupFormState, form(validService))).rejects.toThrow("REDIRECT:/app/login");
    harness.loose = { mfaState: "challenge_required" };
    await expect(saveServiceAction(initialSetupFormState, form(validService))).rejects.toThrow(
      "REDIRECT:/app/mfa?returnTo=%2Fapp%2Fsettings%2Fservices%2Fnew&stepUp=1",
    );
    harness.loose = { mfaState: "enrollment_required" };
    await expect(setMotEnabledAction(form({ enabled: "false" }))).rejects.toThrow("REDIRECT:/app/mfa/enroll");
  });

  it("refuses technicians everything, without a query", async () => {
    const fake = signIn("technician");
    const refused: SetupFormState = await saveServiceAction(initialSetupFormState, form(validService));
    expect(refused).toMatchObject({ status: "error", message: "Only the garage's owners and managers can change this." });
    expect(await saveOpeningHoursAction(initialSetupFormState, form({ "opens-1": "08:00", "closes-1": "17:00" }))).toMatchObject({ status: "error" });
    expect(await addClosureAction(initialSetupFormState, form({ startsOn: "2099-01-01" }))).toMatchObject({ status: "error" });
    expect(await addResourceAction(initialSetupFormState, form({ name: "Bay 9", kind: "bay" }))).toMatchObject({ status: "error" });
    await expect(setResourceActiveAction(form({ resourceId: RESOURCE_ID, active: "false" }))).rejects.toThrow("REDIRECT:/app/settings/resources?error=not_allowed");
    await expect(archiveServiceAction(form({ serviceId: SERVICE_ID }))).rejects.toThrow("REDIRECT:/app/settings/services?error=not_allowed");
    await expect(removeClosureAction(form({ closureId: CLOSURE_ID }))).rejects.toThrow("REDIRECT:/app/settings/hours?error=not_allowed");
    expect(fake.queries).toHaveLength(0);
  });

  it("lets managers change services and hours but not the garage's own settings", async () => {
    const fake = signIn("manager");
    expect(await saveBookingRulesAction(initialSetupFormState, form({ slotStepMin: "15", cancellationCutoffH: "24", mobileTravelMin: "30", serviceArea: "" }))).toMatchObject({
      status: "error",
      message: "Only the garage owner can change this.",
    });
    expect(await saveAccentAction(initialSetupFormState, form({ accent: "#0f766e" }))).toMatchObject({ status: "error", message: "Only the garage owner can change this." });
    expect(await uploadLogoAction(initialSetupFormState, form({ logo: new File([new Uint8Array([1])], "logo.png") }))).toMatchObject({ status: "error" });
    await expect(setMotEnabledAction(form({ enabled: "false" }))).rejects.toThrow("REDIRECT:/app/settings/branding?error=not_allowed");
    expect(fake.queries).toHaveLength(0);
  });
});

describe("services", () => {
  it("adds a manager's service last, in the selected garage, whatever garage the form names", async () => {
    const fake = signIn("manager", (query) => {
      if (query.operation === "select") return { data: { sort: 60 } };
      if (query.operation === "insert") return { data: { id: SERVICE_ID } };
      return undefined;
    });
    await expect(saveServiceAction(initialSetupFormState, form({ ...validService, garage_id: other.id, garageId: other.id }))).rejects.toThrow(
      "REDIRECT:/app/settings/services?done=created",
    );
    const [insert] = writes(fake.queries);
    expect(insert).toMatchObject({ table: "services", operation: "insert" });
    expect(insert?.values).toEqual({
      name: "Diagnostics",
      description: "Warning lights traced.",
      price_mode: "fixed",
      price_pence: 4950,
      duration_min: 60,
      buffer_min: 15,
      location_mode: "both",
      resource_kind: "bay",
      online_enabled: true,
      needs_approval: false,
      min_notice_h: 2,
      max_days_ahead: 60,
      is_mot: false,
      garage_id: garage.id,
      sort: 70,
    });
    expect(hasFilter(fake.queries[0]!, "eq", "garage_id", garage.id)).toBe(true);
    expect(harness.slotCacheCleared).toEqual([garage.id]);
    expect(harness.audits).toEqual([expect.objectContaining({ garageId: garage.id, action: "service.created", entityId: SERVICE_ID })]);
  });

  it("returns field errors and writes nothing when the form is wrong", async () => {
    const fake = signIn("owner");
    const state = await saveServiceAction(initialSetupFormState, form({ ...validService, price: "forty", durationMin: "1" }));
    expect(state).toMatchObject({ seq: 1, status: "error", fieldErrors: { price: expect.any(String), durationMin: expect.any(String) } });
    expect(fake.queries).toHaveLength(0);
  });

  it("edits only a live service of the selected garage, and keeps its MOT flag while MOT is off", async () => {
    const fake = signIn("owner", (query) => {
      if (query.operation === "select") return { data: { id: SERVICE_ID, is_mot: true } };
      if (query.operation === "update") return { data: { id: SERVICE_ID } };
      return undefined;
    });
    await expect(saveServiceAction(initialSetupFormState, form({ ...validService, serviceId: SERVICE_ID, priceMode: "quote", price: "10" }))).rejects.toThrow(
      "REDIRECT:/app/settings/services?done=updated",
    );
    const update = fake.queries.find((query) => query.operation === "update")!;
    expect(update.values).toMatchObject({ is_mot: true, price_mode: "quote", price_pence: null });
    expect(filterValue(update, "eq", "garage_id")).toBe(garage.id);
    expect(filterValue(update, "eq", "id")).toBe(SERVICE_ID);
    expect(hasFilter(update, "is", "deleted_at", null)).toBe(true);
  });

  it("says so when the service is not the garage's (RLS gives no row)", async () => {
    const fake = signIn("owner", () => ({ data: null }));
    expect(await saveServiceAction(initialSetupFormState, form({ ...validService, serviceId: SERVICE_ID }))).toMatchObject({ status: "error", message: expect.stringMatching(/archived or removed/) });
    expect(writes(fake.queries)).toHaveLength(0);
    expect(await saveServiceAction(initialSetupFormState, form({ ...validService, serviceId: "not-a-uuid" }))).toMatchObject({ status: "error" });
  });

  it("archives with deleted_at and deleted_by, filtered by garage", async () => {
    const fake = signIn("manager", (query) => (query.operation === "update" ? { data: { id: SERVICE_ID } } : undefined));
    await expect(archiveServiceAction(form({ serviceId: SERVICE_ID }))).rejects.toThrow("REDIRECT:/app/settings/services?done=archived");
    const [update] = writes(fake.queries);
    expect(update?.values).toEqual({ deleted_at: expect.any(String), deleted_by: USER_ID });
    expect(filterValue(update!, "eq", "garage_id")).toBe(garage.id);
  });

  it("moves a service by rewriting only the sorts that change", async () => {
    const fake = signIn("owner", (query) =>
      query.operation === "select" ? { data: [{ id: "a", sort: 10 }, { id: "b", sort: 20 }, { id: SERVICE_ID, sort: 30 }] } : undefined,
    );
    await expect(moveServiceAction(form({ serviceId: SERVICE_ID, direction: "up" }))).rejects.toThrow("REDIRECT:/app/settings/services");
    expect(writes(fake.queries).map((query) => [filterValue(query, "eq", "id"), query.values, filterValue(query, "eq", "garage_id")])).toEqual([
      [SERVICE_ID, { sort: 20 }, garage.id],
      ["b", { sort: 30 }, garage.id],
    ]);
  });
});

describe("opening hours and closures", () => {
  const stored = [
    { id: "mon", weekday: 1, opens: "08:00:00", closes: "17:30:00" },
    { id: "tue", weekday: 2, opens: "08:00:00", closes: "17:30:00" },
  ];
  const week = { "opens-1": ["08:00", "13:00"], "closes-1": ["12:00", "17:30"], "opens-2": "08:00", "closes-2": "17:30" };

  it("replaces only the changed windows, removed ones first", async () => {
    const fake = signIn("manager", (query) => (query.operation === "select" ? { data: stored } : undefined));
    expect(await saveOpeningHoursAction(initialSetupFormState, form(week))).toMatchObject({ status: "saved" });
    const [remove, insert] = writes(fake.queries);
    expect(remove).toMatchObject({ table: "opening_hours", operation: "delete" });
    expect(filterValue(remove!, "eq", "garage_id")).toBe(garage.id);
    expect(filterValue(remove!, "in", "id")).toEqual(["mon"]);
    expect(insert?.values).toEqual([
      { garage_id: garage.id, weekday: 1, opens: "08:00", closes: "12:00" },
      { garage_id: garage.id, weekday: 1, opens: "13:00", closes: "17:30" },
    ]);
    expect(harness.slotCacheCleared).toEqual([garage.id]);
  });

  it("refuses overlapping windows before touching the database", async () => {
    const fake = signIn("owner");
    const state = await saveOpeningHoursAction(initialSetupFormState, form({ "opens-1": ["08:00", "12:00"], "closes-1": ["17:30", "18:00"] }));
    expect(state).toMatchObject({ status: "error", fieldErrors: { "day-1": expect.stringMatching(/overlap/) } });
    expect(fake.queries).toHaveLength(0);
  });

  it("puts removed windows back when the new ones can't be saved", async () => {
    let inserts = 0;
    const fake = signIn("owner", (query) => {
      if (query.operation === "select") return { data: stored };
      if (query.operation === "insert") return (inserts += 1) === 1 ? { error: { code: "23P01" } } : {};
      return undefined;
    });
    expect(await saveOpeningHoursAction(initialSetupFormState, form(week))).toMatchObject({ status: "error", message: expect.stringMatching(/overlap/) });
    expect(writes(fake.queries).at(-1)?.values).toEqual([{ garage_id: garage.id, weekday: 1, opens: "08:00", closes: "17:30" }]);
  });

  it("adds a closure for today or later in the garage's own time zone", async () => {
    const fake = signIn("manager", (query) => (query.operation === "insert" ? { data: { id: CLOSURE_ID } } : undefined));
    expect(await addClosureAction(initialSetupFormState, form({ startsOn: "2000-01-01" }))).toMatchObject({ status: "error", fieldErrors: { startsOn: expect.any(String) } });
    expect(fake.queries).toHaveLength(0);
    expect(await addClosureAction(initialSetupFormState, form({ startsOn: "2099-12-25", endsOn: "2099-12-26", reason: "Christmas", garage_id: other.id }))).toMatchObject({ status: "saved" });
    expect(writes(fake.queries)[0]?.values).toEqual({ starts_on: "2099-12-25", ends_on: "2099-12-26", reason: "Christmas", garage_id: garage.id });
  });

  it("removes a closure of the selected garage only", async () => {
    const fake = signIn("manager", (query) => (query.operation === "delete" ? { data: [{ id: CLOSURE_ID }] } : undefined));
    await expect(removeClosureAction(form({ closureId: CLOSURE_ID }))).rejects.toThrow("REDIRECT:/app/settings/hours?done=closure_removed");
    expect(filterValue(fake.queries[0]!, "eq", "garage_id")).toBe(garage.id);
    signIn("manager", () => ({ data: [] }));
    await expect(removeClosureAction(form({ closureId: CLOSURE_ID }))).rejects.toThrow("REDIRECT:/app/settings/hours?error=not_found");
  });

  it("saves the owner's booking rules on the selected garage", async () => {
    const fake = signIn("owner", (query) => (query.operation === "update" ? { data: { id: garage.id } } : undefined));
    const state = await saveBookingRulesAction(initialSetupFormState, form({ slotStepMin: "30", approveOnline: "on", cancellationCutoffH: "48", mobileTravelMin: "20", serviceArea: "dn1, dn4" }));
    expect(state).toMatchObject({ status: "saved" });
    const [update] = writes(fake.queries);
    expect(update).toMatchObject({ table: "garages", values: { slot_step_min: 30, approve_online: true, cancellation_cutoff_h: 48, mobile_travel_min: 20, service_area: ["DN1", "DN4"] } });
    expect(filterValue(update!, "eq", "id")).toBe(garage.id);
  });
});

describe("resources", () => {
  it("adds a resource switched on at the end of the list", async () => {
    const fake = signIn("manager", (query) => {
      if (query.operation === "select") return { data: { sort: 40 } };
      if (query.operation === "insert") return { data: { id: RESOURCE_ID } };
      return undefined;
    });
    expect(await addResourceAction(initialSetupFormState, form({ name: "Bay 4", kind: "bay" }))).toMatchObject({ status: "saved", message: expect.stringContaining("Bay 4 added") });
    expect(writes(fake.queries)[0]?.values).toEqual({ garage_id: garage.id, name: "Bay 4", kind: "bay", active: true, sort: 50 });
  });

  it("asks to switch off a resource that has bookings instead of deleting it", async () => {
    signIn("owner", (query) => (query.operation === "delete" ? { error: { code: "23503", message: "violates foreign key" } } : undefined));
    await expect(deleteResourceAction(form({ resourceId: RESOURCE_ID }))).rejects.toThrow("REDIRECT:/app/settings/resources?error=in_use");
  });

  it("switches a resource on or off in the selected garage", async () => {
    const fake = signIn("manager", (query) => (query.operation === "update" ? { data: { id: RESOURCE_ID } } : undefined));
    await expect(setResourceActiveAction(form({ resourceId: RESOURCE_ID, active: "false" }))).rejects.toThrow("REDIRECT:/app/settings/resources");
    expect(writes(fake.queries)[0]).toMatchObject({ table: "resources", values: { active: false } });
    expect(filterValue(writes(fake.queries)[0]!, "eq", "garage_id")).toBe(garage.id);
  });
});

describe("branding and MOT", () => {
  function storageFor(fake: ReturnType<typeof createFakeSupabase>, uploadError: unknown = null) {
    const calls: unknown[][] = [];
    const bucket = {
      upload: async (path: string, _body: unknown, options: unknown) => {
        calls.push(["upload", path, options]);
        return { data: uploadError ? null : { path }, error: uploadError };
      },
      remove: async (paths: string[]) => {
        calls.push(["remove", paths]);
        return { data: [], error: null };
      },
      getPublicUrl: (path: string) => ({ data: { publicUrl: `http://storage.test/storage/v1/object/public/public-media/${path}` } }),
    };
    Object.assign(fake.client, { storage: { from: (name: string) => (calls.push(["bucket", name]), bucket) } });
    return calls;
  }

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  it("darkens #ffcc00 on save and says what it saved", async () => {
    const fake = signIn("owner", (query) => (query.operation === "update" ? { data: { id: garage.id } } : undefined));
    const state = await saveAccentAction(initialSetupFormState, form({ accent: "#FFCC00" }));
    const saved = bookingAccent("#ffcc00");
    expect(saved).not.toBe("#ffcc00");
    expect(state).toMatchObject({ status: "saved", message: expect.stringContaining(`Saved as ${saved}.`) });
    expect(writes(fake.queries)[0]).toMatchObject({ table: "garages", values: { accent: saved } });
    expect(filterValue(writes(fake.queries)[0]!, "eq", "id")).toBe(garage.id);
    expect(await saveAccentAction(initialSetupFormState, form({ accent: "gold" }))).toMatchObject({ status: "error", fieldErrors: { accent: expect.any(String) } });
  });

  it("refuses logos that are not PNG, JPEG or WebP, or are over 1.5 MB, before uploading", async () => {
    const fake = signIn("owner");
    const calls = storageFor(fake);
    expect(await uploadLogoAction(initialSetupFormState, form({ logo: new File(["<svg/>"], "logo.png", { type: "image/png" }) }))).toMatchObject({ fieldErrors: { logo: "Upload a PNG, JPEG or WebP image." } });
    const big = new Uint8Array(1_572_865);
    big.set(PNG);
    expect(await uploadLogoAction(initialSetupFormState, form({ logo: new File([big], "logo.png", { type: "image/png" }) }))).toMatchObject({ fieldErrors: { logo: expect.stringMatching(/1\.5 MB/) } });
    expect(await uploadLogoAction(initialSetupFormState, new FormData())).toMatchObject({ fieldErrors: { logo: "Choose a logo file to upload." } });
    expect(calls).toHaveLength(0);
    expect(fake.queries).toHaveLength(0);
  });

  it("uploads the logo into the garage's own public-media folder through the RLS client", async () => {
    const fake = signIn("owner", (query) => (query.operation === "update" ? { data: { id: garage.id } } : undefined));
    const calls = storageFor(fake);
    const state = await uploadLogoAction(initialSetupFormState, form({ logo: new File([PNG], "anything.jpg", { type: "image/jpeg" }) }));
    expect(state).toMatchObject({ status: "saved" });
    expect(calls).toContainEqual(["bucket", "public-media"]);
    expect(calls).toContainEqual(["upload", `${garage.id}/logo.png`, { contentType: "image/png", upsert: true, cacheControl: "3600" }]);
    expect(calls).toContainEqual(["remove", [`${garage.id}/logo.jpg`, `${garage.id}/logo.webp`]]);
    const [update] = writes(fake.queries);
    expect(update?.values).toEqual({ logo_url: expect.stringMatching(new RegExp(`/public-media/${garage.id}/logo\\.png\\?v=\\d+$`)) });
    expect(filterValue(update!, "eq", "id")).toBe(garage.id);
  });

  it("switches MOT for the selected garage", async () => {
    const fake = signIn("owner", (query) => (query.operation === "update" ? { data: { id: garage.id } } : undefined), { motEnabled: true });
    await expect(setMotEnabledAction(form({ enabled: "false", garage_id: other.id }))).rejects.toThrow("REDIRECT:/app/settings/branding?done=mot_off#mot");
    expect(writes(fake.queries)[0]).toMatchObject({ table: "garages", values: { mot_enabled: false } });
    expect(filterValue(writes(fake.queries)[0]!, "eq", "id")).toBe(garage.id);
    expect(harness.slotCacheCleared).toEqual([garage.id]);
    expect(harness.revalidated).toContain("/_site/[garageId]");
  });
});
