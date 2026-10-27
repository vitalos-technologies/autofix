import { createHash, randomBytes } from "node:crypto";
import { addDays, dateKeyInZone, isoWeekday, zonedTimeToInstant } from "@/lib/booking-flow/dates";
import {
  createBookingInputSchema,
  staffBookingContextSchema,
  type BookingEngine,
  type CreateBookingInput,
  type CreateBookingResult,
  type CreatedBooking,
  type OnlineService,
  type Slot,
  type SlotQuery,
} from "@/lib/booking-engine/types";

/**
 * In-memory booking engine for UI work and tests (`BOOKING_ENGINE=fake`, never in production).
 * Deterministic: the same services for every garage, and slots generated from fixed opening
 * hours with a fixed pattern of taken times. Bookings made through it block their slot until the
 * process restarts. It follows the contract in docs/autofix/ARCHITECTURE.md, not the SQL.
 */

export const FAKE_SERVICE_IDS = {
  diagnostics: "f0000000-0000-4000-8000-000000000001",
  fullService: "f0000000-0000-4000-8000-000000000002",
  mot: "f0000000-0000-4000-8000-000000000003",
  brakes: "f0000000-0000-4000-8000-000000000004",
  other: "f0000000-0000-4000-8000-000000000005",
} as const;

const base = { bufferMin: 0, needsApproval: false, minNoticeH: 2, maxDaysAhead: 60 } as const;

export const FAKE_SERVICES: readonly OnlineService[] = [
  { ...base, id: FAKE_SERVICE_IDS.diagnostics, name: "Diagnostics", description: "Warning lights, faults, electrical", durationMin: 60, pricePence: 6000, priceMode: "fixed", locationMode: "both", isMot: false, sort: 10 },
  { ...base, id: FAKE_SERVICE_IDS.fullService, name: "Full service", description: "Oil, filters, 60+ checks", durationMin: 150, pricePence: 14900, priceMode: "from", locationMode: "workshop", isMot: false, sort: 20 },
  { ...base, id: FAKE_SERVICE_IDS.mot, name: "MOT", description: "Class 4", durationMin: 45, pricePence: 5485, priceMode: "fixed", locationMode: "workshop", isMot: true, sort: 30 },
  { ...base, id: FAKE_SERVICE_IDS.brakes, name: "Brakes & suspension", description: "Inspected first, then quoted", durationMin: 60, pricePence: null, priceMode: "quote", locationMode: "workshop", isMot: false, needsApproval: true, sort: 40 },
  { ...base, id: FAKE_SERVICE_IDS.other, name: "Something else", description: "Tell us and we'll quote", durationMin: 30, pricePence: null, priceMode: "quote", locationMode: "both", isMot: false, needsApproval: true, sort: 50 },
];

/** Opening windows in minutes after midnight, by ISO weekday (Sunday closed). */
const OPENING: Record<number, Array<[number, number]>> = {
  1: [[510, 750], [780, 1020]],
  2: [[510, 750], [780, 1020]],
  3: [[510, 750], [780, 1020]],
  4: [[510, 750], [780, 1020]],
  5: [[510, 750], [780, 1020]],
  6: [[540, 750]],
  7: [],
};
const STEP_MIN = 45;
/** Staff bookings reach two years ahead (as `create_booking()`). */
const STAFF_HORIZON_MS = 730 * 86_400_000;

export type FakeBookingEngineOptions = {
  now?: () => Date;
  timeZone?: string;
  /** Booking reference prefix (the real engine uses `garages.booking_prefix`). */
  referencePrefix?: string;
  /** Share bookings across module instances (dev server). Tests keep their own. */
  shared?: boolean;
};

type StoredBooking = { garageId: string; startMs: number; endMs: number; booking: CreatedBooking; input: CreateBookingInput };
type Store = { bookings: StoredBooking[]; byKey: Map<string, StoredBooking>; counter: number };

const SHARED_STORE = Symbol.for("autofix.fakeBookingEngine.store");

function newStore(): Store {
  return { bookings: [], byKey: new Map(), counter: 0 };
}

function sharedStore(): Store {
  const holder = globalThis as typeof globalThis & { [SHARED_STORE]?: Store };
  holder[SHARED_STORE] ??= newStore();
  return holder[SHARED_STORE];
}

/** Deterministic "taken" pattern: about one start in five. */
function takenByPattern(serviceId: string, dateKey: string, minutes: number) {
  const digest = createHash("sha256").update(`${serviceId}|${dateKey}|${minutes}`).digest();
  return (digest[0] ?? 0) % 5 === 0;
}

function fakeUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type FakeBookingEngine = BookingEngine & {
  /** Bookings made so far (tests). */
  bookings(): CreatedBooking[];
  reset(): void;
};

export function createFakeBookingEngine(options: FakeBookingEngineOptions = {}): FakeBookingEngine {
  const now = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? "Europe/London";
  const prefix = options.referencePrefix ?? "AF";
  let store = options.shared ? sharedStore() : newStore();

  function service(serviceId: string) {
    return FAKE_SERVICES.find((item) => item.id === serviceId) ?? null;
  }

  function busy(garageId: string, startMs: number, endMs: number) {
    return store.bookings.some((item) => item.garageId === garageId && item.startMs < endMs && startMs < item.endMs);
  }

  /** `staff`: from the start of today and up to two years ahead, ignoring notice and the booking window. */
  function slotsFor(query: SlotQuery, staff = false): Slot[] {
    const chosen = service(query.serviceId);
    if (!chosen) return [];
    if (query.locationMode && chosen.locationMode !== "both" && chosen.locationMode !== query.locationMode) return [];
    const nowMs = now().getTime();
    const today = dateKeyInZone(now(), timeZone);
    const earliest = staff ? Number.NEGATIVE_INFINITY : nowMs + chosen.minNoticeH * 3_600_000;
    const latest = nowMs + (staff ? STAFF_HORIZON_MS : chosen.maxDaysAhead * 86_400_000);
    const slots: Slot[] = [];
    for (let date = staff && query.from < today ? today : query.from; date <= query.to; date = addDays(date, 1)) {
      for (const [opens, closes] of OPENING[isoWeekday(date)] ?? []) {
        for (let start = opens; start + chosen.durationMin <= closes; start += STEP_MIN) {
          const startsAt = zonedTimeToInstant(date, start, timeZone);
          const endsAt = new Date(startsAt.getTime() + chosen.durationMin * 60_000);
          if (startsAt.getTime() < earliest || startsAt.getTime() > latest) continue;
          const taken = takenByPattern(chosen.id, date, start) || busy(query.garageId, startsAt.getTime(), endsAt.getTime() + chosen.bufferMin * 60_000);
          slots.push({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), freeCount: taken ? 0 : 1 });
        }
      }
    }
    return slots;
  }

  /** A member's explicit override: any whole minute from today, opening hours aside (the bay still has to be free). */
  function overriddenSlot(garageId: string, chosen: OnlineService, startsAt: Date): Slot | null {
    const startMs = startsAt.getTime();
    if (startMs % 60_000 !== 0 || dateKeyInZone(startsAt, timeZone) < dateKeyInZone(now(), timeZone) || startMs > now().getTime() + STAFF_HORIZON_MS) return null;
    const endMs = startMs + chosen.durationMin * 60_000;
    return { startsAt: startsAt.toISOString(), endsAt: new Date(endMs).toISOString(), freeCount: busy(garageId, startMs, endMs + chosen.bufferMin * 60_000) ? 0 : 1 };
  }

  function nearestFree(garageId: string, serviceId: string, startsAt: Date, locationMode: CreateBookingInput["locationMode"]): Slot[] {
    const date = dateKeyInZone(startsAt, timeZone);
    const free = slotsFor({ garageId, serviceId, from: addDays(date, -7), to: addDays(date, 7), locationMode }).filter((slot) => slot.freeCount > 0);
    const target = startsAt.getTime();
    return free
      .sort((a, b) => Math.abs(Date.parse(a.startsAt) - target) - Math.abs(Date.parse(b.startsAt) - target))
      .slice(0, 3)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  }

  return {
    async listOnlineServices() {
      return FAKE_SERVICES.map((item) => ({ ...item }));
    },

    async getAvailableSlots(query) {
      return slotsFor(query);
    },

    async getStaffSlots(query) {
      return slotsFor(query, true);
    },

    async createBooking(garageId, rawInput, options = {}): Promise<CreateBookingResult> {
      const parsed = createBookingInputSchema.safeParse(rawInput);
      if (!parsed.success) return { ok: false, code: "INVALID_BOOKING", message: "The booking details are not valid." };
      const input = parsed.data;
      const staffRules = options.staff === undefined ? null : staffBookingContextSchema.safeParse(options.staff);
      if (staffRules && (!staffRules.success || (input.source !== "phone" && input.source !== "walk_in"))) {
        return { ok: false, code: "INVALID_BOOKING", message: "The booking details are not valid." };
      }
      const staff = staffRules?.success ? staffRules.data : null;

      const replay = store.byKey.get(`${garageId}:${input.idempotencyKey}`);
      if (replay) return { ok: true, booking: replay.booking, replayed: true };

      const chosen = service(input.serviceId);
      if (!chosen || (chosen.locationMode !== "both" && chosen.locationMode !== input.locationMode)) {
        return { ok: false, code: "SERVICE_UNAVAILABLE", message: "That service cannot be booked online." };
      }

      const startsAt = new Date(input.startsAt);
      const date = dateKeyInZone(startsAt, timeZone);
      const slot = staff?.overrideHours
        ? overriddenSlot(garageId, chosen, startsAt)
        : slotsFor({ garageId, serviceId: chosen.id, from: date, to: date, locationMode: input.locationMode }, Boolean(staff))
          .find((candidate) => Date.parse(candidate.startsAt) === startsAt.getTime());
      if (!slot || slot.freeCount <= 0) {
        return {
          ok: false,
          code: "SLOT_UNAVAILABLE",
          message: "That time is no longer available.",
          alternatives: nearestFree(garageId, chosen.id, startsAt, input.locationMode),
        };
      }

      store.counter += 1;
      const number = 1000 + ((4821 - 1000 + (store.counter - 1) * 1379) % 9000);
      const booking: CreatedBooking = {
        id: fakeUuid(`booking:${garageId}:${input.idempotencyKey}`),
        reference: `${prefix}-${number}`,
        // A member's booking needs no approval.
        status: chosen.needsApproval && !staff ? "requested" : "confirmed",
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        customerId: fakeUuid(`customer:${garageId}:${input.customer.phone}`),
        vehicleId: fakeUuid(`vehicle:${garageId}:${input.vehicle.registration}`),
        manageToken: randomBytes(24).toString("base64url"),
      };
      const stored: StoredBooking = {
        garageId,
        startMs: Date.parse(slot.startsAt),
        endMs: Date.parse(slot.endsAt) + chosen.bufferMin * 60_000,
        booking,
        input,
      };
      store.bookings.push(stored);
      store.byKey.set(`${garageId}:${input.idempotencyKey}`, stored);
      return { ok: true, booking, replayed: false };
    },

    bookings() {
      return store.bookings.map((item) => item.booking);
    },

    reset() {
      if (options.shared) {
        const fresh = newStore();
        (globalThis as typeof globalThis & { [SHARED_STORE]?: Store })[SHARED_STORE] = fresh;
        store = fresh;
      } else {
        store = newStore();
      }
    },
  };
}
