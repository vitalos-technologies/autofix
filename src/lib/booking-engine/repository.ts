import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { BookingEngineError, bookingErrorCodeFromDatabase, bookingErrorMessages } from "@/lib/booking-engine/errors";
import { deriveManageToken, hashManageToken } from "@/lib/booking-engine/manage";
import { notifyBooking } from "@/lib/booking-engine/notify";
import { isoInstant } from "@/lib/booking-engine/range";
import { clearSlotCache, fetchAvailableSlots, findAlternativeSlots } from "@/lib/booking-engine/slots";
import {
  bookingStatuses,
  createBookingInputSchema,
  type BookingEngine,
  type BookingErrorCode,
  type CreateBookingInput,
  type CreateBookingResult,
  type CreatedBooking,
  type LocationMode,
  type OnlineService,
  type PriceMode,
  type ServiceLocationMode,
  type Slot,
} from "@/lib/booking-engine/types";
import { toE164UK } from "@/lib/messaging/phone";
import { createAdminClient } from "@/lib/supabase/server";

// Supabase-backed engine over `available_slots()` and `create_booking()`
// (docs/autofix/ARCHITECTURE.md → Booking engine). Service role only: every
// query names the garage explicitly, and the garage always comes from the
// caller (the request host, an admin session or an agent token), never from
// booking input.

export type SupabaseBookingEngineOptions = {
  /** Defaults to the service-role client. Integration tests pass a local one. */
  client?: () => SupabaseClient | null;
  now?: () => Date;
};

type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  buffer_min: number | null;
  price_pence: number | null;
  price_mode: PriceMode;
  location_mode: ServiceLocationMode;
  is_mot: boolean | null;
  needs_approval: boolean | null;
  min_notice_h: number | null;
  max_days_ahead: number | null;
  sort: number | null;
  online_enabled?: boolean | null;
  deleted_at?: string | null;
};

type GarageRow = { id: string; timezone: string | null; mot_enabled: boolean | null; status: string };

type BookingResultRow = {
  id: string;
  reference: string;
  status: (typeof bookingStatuses)[number];
  starts_at: string;
  ends_at: string;
  customer_id: string;
  vehicle_id: string;
};

const SERVICE_COLUMNS = "id,name,description,duration_min,buffer_min,price_pence,price_mode,location_mode,is_mot,needs_approval,min_notice_h,max_days_ahead,sort";
const RESULT_COLUMNS = "id,reference,status,starts_at,ends_at,customer_id,vehicle_id";
/** Garage statuses that take bookings (the same ones whose booking site is served). */
const BOOKABLE_GARAGE_STATUSES = new Set(["active", "onboarding"]);
/** Sources recorded by staff may use services that are not offered online. */
const STAFF_SOURCES = new Set(["phone", "walk_in"]);

const createBookingResultSchema = z.object({
  booking_id: z.string().uuid(),
  reference: z.string().min(1),
  status: z.enum(bookingStatuses),
  starts_at: z.string(),
  ends_at: z.string(),
  customer_id: z.string().uuid(),
  vehicle_id: z.string().uuid(),
  /** Optional: lets `create_booking()` say it returned an existing booking for the idempotency key. */
  replayed: z.boolean().optional(),
  created: z.boolean().optional(),
});

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;

/** `dn12ab` / `DN1 2AB` → `DN1 2AB`; null when it is not a UK postcode. */
export function normalisePostcode(value: string | null | undefined): string | null {
  const compact = (value ?? "").toUpperCase().replace(/\s+/g, "");
  if (!UK_POSTCODE.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function failure(code: BookingErrorCode, message = bookingErrorMessages[code], alternatives?: Slot[]): CreateBookingResult {
  return alternatives ? { ok: false, code, message, alternatives } : { ok: false, code, message };
}

function toOnlineService(row: ServiceRow): OnlineService {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    durationMin: row.duration_min,
    bufferMin: row.buffer_min ?? 0,
    pricePence: row.price_mode === "quote" ? null : row.price_pence,
    priceMode: row.price_mode,
    locationMode: row.location_mode,
    isMot: Boolean(row.is_mot),
    needsApproval: Boolean(row.needs_approval),
    minNoticeH: row.min_notice_h ?? 2,
    maxDaysAhead: row.max_days_ahead ?? 60,
    sort: row.sort ?? 0,
  };
}

function serviceAllowsLocation(service: ServiceLocationMode, requested: LocationMode) {
  return service === "both" || service === requested;
}

/** The booking `create_booking()` receives (docs/autofix/ARCHITECTURE.md lists every key). */
export function createBookingPayload(input: CreateBookingInput, normalised: { phone: string; postcode: string | null }, manageTokenHash: string) {
  const blank = (value: string | undefined) => (value && value.trim() ? value.trim() : null);
  return {
    service_id: input.serviceId,
    starts_at: new Date(input.startsAt).toISOString(),
    location_mode: input.locationMode,
    postcode: normalised.postcode,
    address: input.locationMode === "mobile" ? blank(input.address) : null,
    symptoms: input.symptoms,
    notes: blank(input.notes),
    source: input.source,
    idempotency_key: input.idempotencyKey,
    manage_token_hash: manageTokenHash,
    reminder_send_id: input.reminderSendId ?? null,
    customer: {
      name: input.customer.name,
      phone: normalised.phone,
      email: input.customer.email ?? null,
      channel: input.customer.channel,
      reminder_consent: input.customer.reminderConsent,
      consent_source: input.customer.reminderConsent ? "booking" : null,
    },
    vehicle: {
      registration: input.vehicle.registration,
      make: blank(input.vehicle.make),
      model: blank(input.vehicle.model),
      colour: blank(input.vehicle.colour),
      fuel: blank(input.vehicle.fuel),
      year: input.vehicle.year ?? null,
      mot_expiry: input.vehicle.motExpiry ?? null,
    },
  };
}

export function createSupabaseBookingEngine(options: SupabaseBookingEngineOptions = {}): BookingEngine {
  const getClient = options.client ?? createAdminClient;
  const now = options.now ?? (() => new Date());

  function client(): SupabaseClient {
    const value = getClient();
    if (!value) throw new BookingEngineError("UNAVAILABLE");
    return value;
  }

  async function loadGarage(db: SupabaseClient, garageId: string) {
    const { data, error } = await db.from("garages").select("id,timezone,mot_enabled,status").eq("id", garageId).maybeSingle();
    if (error) throw new BookingEngineError("UNAVAILABLE");
    return (data as GarageRow | null) ?? null;
  }

  async function findByIdempotencyKey(db: SupabaseClient, garageId: string, idempotencyKey: string) {
    const { data, error } = await db.from("bookings").select(RESULT_COLUMNS).eq("garage_id", garageId).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (error) throw new BookingEngineError("UNAVAILABLE");
    return (data as BookingResultRow | null) ?? null;
  }

  function created(row: BookingResultRow, manageToken: string): CreatedBooking {
    return {
      id: row.id,
      reference: row.reference,
      status: row.status,
      startsAt: isoInstant(row.starts_at) ?? row.starts_at,
      endsAt: isoInstant(row.ends_at) ?? row.ends_at,
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      manageToken,
    };
  }

  return {
    async listOnlineServices(garageId) {
      const db = client();
      const [garage, services] = await Promise.all([
        loadGarage(db, garageId),
        db
          .from("services")
          .select(SERVICE_COLUMNS)
          .eq("garage_id", garageId)
          .eq("online_enabled", true)
          .is("deleted_at", null)
          .order("sort", { ascending: true })
          .order("name", { ascending: true }),
      ]);
      if (services.error) throw new BookingEngineError("UNAVAILABLE");
      if (!garage) return [];
      return ((services.data ?? []) as ServiceRow[])
        // MOT services exist only for garages with MOT switched on.
        .filter((row) => garage.mot_enabled || !row.is_mot)
        .map(toOnlineService);
    },

    async getAvailableSlots(query) {
      return fetchAvailableSlots(client(), query, now().getTime());
    },

    async createBooking(garageId, rawInput) {
      const parsed = createBookingInputSchema.safeParse(rawInput);
      if (!parsed.success) return failure("INVALID_BOOKING");
      const input = parsed.data;

      const phone = toE164UK(input.customer.phone);
      if (!phone) return failure("INVALID_BOOKING", "Enter a UK mobile number so the garage can reach you.");
      if (input.customer.channel === "email" && !input.customer.email) return failure("INVALID_BOOKING", "Enter an email address to get updates by email.");
      const postcode = input.postcode ? normalisePostcode(input.postcode) : null;
      if (input.postcode && !postcode) return failure("INVALID_BOOKING", "Enter a valid UK postcode.");
      if (input.locationMode === "mobile" && (!postcode || !input.address || input.address.trim().length < 5)) {
        return failure("INVALID_BOOKING", "Enter the address and postcode where the car will be.");
      }

      try {
        const db = client();
        const manageToken = deriveManageToken(garageId, input.idempotencyKey);
        const [garage, serviceResult, existing] = await Promise.all([
          loadGarage(db, garageId),
          db.from("services").select(`${SERVICE_COLUMNS},online_enabled,deleted_at`).eq("garage_id", garageId).eq("id", input.serviceId).maybeSingle(),
          findByIdempotencyKey(db, garageId, input.idempotencyKey),
        ]);
        // Same key, same booking: a double-submitted Confirm never books twice.
        if (existing) return { ok: true, booking: created(existing, manageToken), replayed: true };
        if (serviceResult.error) return failure("UNAVAILABLE");
        const service = serviceResult.data as ServiceRow | null;
        if (!garage || !BOOKABLE_GARAGE_STATUSES.has(garage.status)) return failure("SERVICE_UNAVAILABLE");
        if (
          !service
          || service.deleted_at
          || (!STAFF_SOURCES.has(input.source) && !service.online_enabled)
          || (service.is_mot && !garage.mot_enabled)
          || !serviceAllowsLocation(service.location_mode, input.locationMode)
        ) {
          return failure("SERVICE_UNAVAILABLE");
        }

        const { data, error } = await db.rpc("create_booking", {
          p_garage_id: garageId,
          p_booking: createBookingPayload(input, { phone, postcode }, hashManageToken(manageToken)),
        });

        if (error) {
          if (error.code === "23505") {
            // A concurrent request with the same idempotency key won the insert.
            const winner = await findByIdempotencyKey(db, garageId, input.idempotencyKey);
            if (winner) return { ok: true, booking: created(winner, manageToken), replayed: true };
          }
          const code = bookingErrorCodeFromDatabase(error);
          if (code === "SLOT_UNAVAILABLE") {
            const alternatives = await findAlternativeSlots(db, {
              garageId,
              serviceId: input.serviceId,
              locationMode: input.locationMode,
              requestedStart: input.startsAt,
              timeZone: garage.timezone || "Europe/London",
              now: now(),
            });
            return failure(code, bookingErrorMessages[code], alternatives);
          }
          return failure(code);
        }

        const result = createBookingResultSchema.safeParse(Array.isArray(data) ? data[0] : data);
        if (!result.success) return failure("UNAVAILABLE");
        const row = result.data;
        const replayed = row.replayed === true || row.created === false;
        clearSlotCache(garageId);
        if (!replayed) notifyBooking({ type: "created", garageId, bookingId: row.booking_id });
        return {
          ok: true,
          replayed,
          booking: created({
            id: row.booking_id,
            reference: row.reference,
            status: row.status,
            starts_at: row.starts_at,
            ends_at: row.ends_at,
            customer_id: row.customer_id,
            vehicle_id: row.vehicle_id,
          }, manageToken),
        };
      } catch (error) {
        return failure(error instanceof BookingEngineError ? error.code : "UNAVAILABLE");
      }
    },
  };
}
