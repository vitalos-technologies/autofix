import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingDraft } from "@/lib/booking-engine/types";

const jar = new Map<string, { value: string; options: Record<string, unknown> }>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set(name, { value, options });
    },
  }),
}));

const {
  BOOKING_STATE_COOKIE,
  BOOKING_STATE_MAX_AGE_S,
  JUST_BOOKED_COOKIE,
  JUST_BOOKED_MAX_AGE_S,
  clearBookingDraft,
  openBookingSession,
  openJustBooked,
  openValue,
  readBookingDraft,
  readBookingSession,
  readJustBooked,
  sealBookingSession,
  sealJustBooked,
  sealValue,
  writeBookingDraft,
  writeJustBooked,
} = await import("@/lib/booking-engine/state");

const GARAGE_A = "11111111-1111-4111-8111-111111111111";
const GARAGE_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-27T09:00:00.000Z");

const draft: BookingDraft = {
  v: 1,
  garageId: GARAGE_A,
  vehicle: { registration: "AB12CDE", make: "Ford", model: "Focus", motExpiry: "2027-03-14" },
  serviceId: "f0000000-0000-4000-8000-000000000001",
  locationMode: "workshop",
  symptoms: ["Warning light"],
  note: "Light came on yesterday",
  startsAt: "2026-10-28T09:15:00.000Z",
  idempotencyKey: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
};

const booked = {
  reference: "HRM-4821",
  status: "confirmed" as const,
  startsAt: "2026-10-28T09:15:00.000Z",
  endsAt: "2026-10-28T10:15:00.000Z",
  serviceName: "Diagnostics",
  locationMode: "workshop" as const,
  where: "Workshop, DN4",
  vehicleName: "Ford Focus",
  registration: "AB12CDE",
  channel: "sms" as const,
  contactHint: "07••• •••412",
};

function tamper(sealed: string, part: 1 | 2 | 3) {
  const parts = sealed.split(".");
  const bytes = Buffer.from(parts[part]!, "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  parts[part] = bytes.toString("base64url");
  return parts.join(".");
}

beforeEach(() => {
  jar.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("booking draft sealing (af_booking)", () => {
  it("round-trips the draft and the flow bookkeeping", () => {
    const sealed = sealBookingSession(draft, { humanCheckedAt: 123 }, { now: NOW });
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed.split(".")).toHaveLength(4);
    expect(openBookingSession(GARAGE_A, sealed, { now: NOW })).toEqual({ draft, meta: { humanCheckedAt: 123 } });
  });

  it("keeps the registration and contact details unreadable in the cookie value", () => {
    const sealed = sealBookingSession(draft, {}, { now: NOW });
    const visible = sealed.split(".").map((part) => Buffer.from(part, "base64url").toString("latin1")).join(" ");
    expect(sealed).not.toMatch(/AB12/i);
    expect(visible).not.toContain("AB12CDE");
    expect(visible).not.toContain("Focus");
  });

  it("reads a tampered value as an empty draft", () => {
    const sealed = sealBookingSession(draft, {}, { now: NOW });
    for (const part of [1, 2, 3] as const) {
      const session = openBookingSession(GARAGE_A, tamper(sealed, part), { now: NOW });
      expect(session.draft.vehicle).toBeUndefined();
      expect(session.draft.garageId).toBe(GARAGE_A);
    }
    expect(openBookingSession(GARAGE_A, `${sealed}x`, { now: NOW }).draft.vehicle).toBeUndefined();
    expect(openBookingSession(GARAGE_A, "not-a-cookie", { now: NOW }).draft.vehicle).toBeUndefined();
  });

  it("reads another garage's draft as empty", () => {
    const sealed = sealBookingSession(draft, {}, { now: NOW });
    const session = openBookingSession(GARAGE_B, sealed, { now: NOW });
    expect(session.draft).toMatchObject({ v: 1, garageId: GARAGE_B });
    expect(session.draft.vehicle).toBeUndefined();
    expect(session.draft.serviceId).toBeUndefined();
  });

  it("rejects a draft whose payload names another garage even under the right key", () => {
    const sealed = sealValue(BOOKING_STATE_COOKIE, GARAGE_A, { d: { ...draft, garageId: GARAGE_B }, m: {} }, { now: NOW });
    expect(openBookingSession(GARAGE_A, sealed, { now: NOW }).draft.vehicle).toBeUndefined();
  });

  it("expires 2 hours after it was written", () => {
    const sealed = sealBookingSession(draft, {}, { now: NOW });
    const justBefore = new Date(NOW.getTime() + (BOOKING_STATE_MAX_AGE_S - 1) * 1000);
    const atExpiry = new Date(NOW.getTime() + BOOKING_STATE_MAX_AGE_S * 1000);
    expect(openBookingSession(GARAGE_A, sealed, { now: justBefore }).draft.vehicle?.registration).toBe("AB12CDE");
    expect(openBookingSession(GARAGE_A, sealed, { now: atExpiry }).draft.vehicle).toBeUndefined();
  });

  it("rejects other versions and values sealed for the other cookie", () => {
    const sealed = sealBookingSession(draft, {}, { now: NOW });
    expect(openBookingSession(GARAGE_A, sealed.replace(/^v1\./, "v2."), { now: NOW }).draft.vehicle).toBeUndefined();
    const justBooked = sealJustBooked(GARAGE_A, booked, { now: NOW });
    expect(openValue(BOOKING_STATE_COOKIE, GARAGE_A, justBooked, { now: NOW })).toBeNull();
  });

  it("gives each new empty draft its own idempotency key", () => {
    const first = openBookingSession(GARAGE_A, undefined).draft.idempotencyKey;
    const second = openBookingSession(GARAGE_A, undefined).draft.idempotencyKey;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });

  it("derives the key from BOOKING_STATE_SECRET, falling back to BOOKING_MANAGEMENT_SECRET", () => {
    vi.stubEnv("BOOKING_STATE_SECRET", "state-secret-for-tests-0123456789abcdef");
    const withState = sealBookingSession(draft, {}, { now: NOW });
    vi.stubEnv("BOOKING_STATE_SECRET", "");
    vi.stubEnv("BOOKING_MANAGEMENT_SECRET", "management-secret-for-tests-0123456789");
    expect(openBookingSession(GARAGE_A, withState, { now: NOW }).draft.vehicle).toBeUndefined();
    const withManagement = sealBookingSession(draft, {}, { now: NOW });
    expect(openBookingSession(GARAGE_A, withManagement, { now: NOW }).draft.vehicle?.registration).toBe("AB12CDE");
  });

  it("refuses to seal in production without a secret", () => {
    expect(() => sealValue(BOOKING_STATE_COOKIE, GARAGE_A, {}, { env: { NODE_ENV: "production" } })).toThrow(/BOOKING_STATE_SECRET/);
  });
});

describe("booking draft cookie", () => {
  it("writes an httpOnly, SameSite=Lax, 2-hour cookie on path / and reads it back for the same garage", async () => {
    await writeBookingDraft(draft, { humanCheckedAt: 1 });
    const stored = jar.get(BOOKING_STATE_COOKIE)!;
    expect(stored.options).toEqual({ httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: BOOKING_STATE_MAX_AGE_S });
    expect(await readBookingDraft(GARAGE_A)).toEqual(draft);
    expect((await readBookingSession(GARAGE_A)).meta).toEqual({ humanCheckedAt: 1 });
    expect((await readBookingDraft(GARAGE_B)).vehicle).toBeUndefined();
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BOOKING_STATE_SECRET", "state-secret-for-tests-0123456789abcdef");
    await writeBookingDraft(draft);
    expect(jar.get(BOOKING_STATE_COOKIE)!.options.secure).toBe(true);
  });

  it("clears the cookie", async () => {
    await writeBookingDraft(draft);
    await clearBookingDraft();
    expect(jar.get(BOOKING_STATE_COOKIE)).toMatchObject({ value: "", options: { maxAge: 0, path: "/" } });
    expect((await readBookingDraft(GARAGE_A)).vehicle).toBeUndefined();
  });
});

describe("just booked cookie (af_booked)", () => {
  it("opens only for the same garage and reference", () => {
    const sealed = sealJustBooked(GARAGE_A, booked, { now: NOW });
    expect(openJustBooked(GARAGE_A, "HRM-4821", sealed, { now: NOW })).toEqual(booked);
    expect(openJustBooked(GARAGE_A, "hrm-4821", sealed, { now: NOW })).toEqual(booked);
    expect(openJustBooked(GARAGE_A, "HRM-4822", sealed, { now: NOW })).toBeNull();
    expect(openJustBooked(GARAGE_B, "HRM-4821", sealed, { now: NOW })).toBeNull();
    expect(openJustBooked(GARAGE_A, "HRM-4821", tamper(sealed, 2), { now: NOW })).toBeNull();
  });

  it("expires after 30 minutes", () => {
    const sealed = sealJustBooked(GARAGE_A, booked, { now: NOW });
    expect(openJustBooked(GARAGE_A, "HRM-4821", sealed, { now: new Date(NOW.getTime() + JUST_BOOKED_MAX_AGE_S * 1000) })).toBeNull();
  });

  it("is only sent to the confirmation page", async () => {
    await writeJustBooked(GARAGE_A, booked);
    expect(jar.get(JUST_BOOKED_COOKIE)!.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/confirmed", maxAge: JUST_BOOKED_MAX_AGE_S });
    expect(await readJustBooked(GARAGE_A, "HRM-4821")).toEqual(booked);
    expect(await readJustBooked(GARAGE_A, "HRM-0000")).toBeNull();
  });
});
