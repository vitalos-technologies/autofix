import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BookingEngineError } from "@/lib/booking-engine/errors";
import {
  bookingReferenceSchema,
  manageErrorMessages,
  manageTokenSchema,
  type ManageErrorCode,
  type PublicManagedBooking,
} from "@/lib/booking-engine/manage-schema";
import { notifyBooking } from "@/lib/booking-engine/notify";
import { formatTimeRange, isoInstant, parseTimeRange, shiftTimeRange, type TimeRange } from "@/lib/booking-engine/range";
import { clearSlotCache, fetchAvailableSlots, findAlternativeSlots } from "@/lib/booking-engine/slots";
import { releasedStatuses, type BookingStatus, type LocationMode, type Slot } from "@/lib/booking-engine/types";
import { calendarDateInTimeZone } from "@/lib/bookings/date";
import { createAdminClient } from "@/lib/supabase/server";
import { garageUrl, type GarageUrlSubject } from "@/lib/tenancy/urls";
import { formatRegistration, registrationSchema } from "@/lib/vehicle/registration";

// Manage booking (docs/autofix/ARCHITECTURE.md → Booking engine → App).
//
// Two ways in, both bound to the host's garage:
// - the signed link in the confirmation: a token derived with HMAC from the
//   garage id and the booking's idempotency key (so it can be re-issued in
//   later emails); only its SHA-256 hash is stored, in bookings.manage_token_hash;
// - reference + registration in a POST body.
// Either one opens a 30-minute signed httpOnly session cookie (`af_manage`)
// holding the garage id and booking id. Changes re-check the status, the
// garage's cancellation cutoff and the same slots the booking page offers.

const DEV_SECRET = "local-booking-management-only";
const TOKEN_CONTEXT = "booking-manage-link:v1";
const SESSION_CONTEXT = "booking-manage-session:v1";

export const MANAGE_COOKIE = "af_manage";
export const MANAGE_SESSION_SECONDS = 30 * 60;

/** Statuses a customer may still change online. */
export const customerChangeableStatuses: readonly BookingStatus[] = ["requested", "confirmed"];

function managementSecret() {
  const key = process.env.BOOKING_MANAGEMENT_SECRET?.trim();
  if (key) return key;
  if (process.env.NODE_ENV !== "production") return DEV_SECRET;
  throw new BookingEngineError("UNAVAILABLE", "Booking management signing is not configured");
}

/**
 * The manage-link token for a booking: HMAC-SHA-256 over the garage id and the
 * booking's idempotency key (unique per garage, fixed before the booking id
 * exists). Deterministic, so an idempotent replay and later emails carry the
 * same link; unforgeable without BOOKING_MANAGEMENT_SECRET.
 */
export function deriveManageToken(garageId: string, idempotencyKey: string) {
  return createHmac("sha256", managementSecret()).update(`${TOKEN_CONTEXT}:${garageId.toLowerCase()}:${idempotencyKey.toLowerCase()}`).digest("base64url");
}

/** What is stored in `bookings.manage_token_hash` (hex SHA-256 of the token). */
export function hashManageToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** `/manage?token=…` on the garage's booking host (or plain `/manage` for the reference + registration form). */
export function manageBookingUrl(garage: GarageUrlSubject, token?: string | null) {
  return garageUrl(garage, token ? `/manage?token=${encodeURIComponent(token)}` : "/manage");
}

/** The manage link for a stored booking, when its token can still be re-derived and matches the stored hash. */
export function manageTokenForBooking(garageId: string, booking: { idempotencyKey: string | null; manageTokenHash: string | null }) {
  if (!booking.idempotencyKey || !booking.manageTokenHash) return null;
  try {
    const token = deriveManageToken(garageId, booking.idempotencyKey);
    return safeEqual(hashManageToken(token), booking.manageTokenHash) ? token : null;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionSignature(encoded: string) {
  return createHmac("sha256", managementSecret()).update(`${SESSION_CONTEXT}:${encoded}`).digest("base64url");
}

/** Signed `af_manage` value: `{garage, booking, expiry}`. */
export function createManageSession(garageId: string, bookingId: string, now = Date.now()) {
  const payload = { g: garageId, b: bookingId, e: Math.floor(now / 1000) + MANAGE_SESSION_SECONDS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sessionSignature(encoded)}`;
}

/** The booking a manage session opens, only on the garage it was issued for and before it expires. */
export function readManageSession(value: string | null | undefined, garageId: string, now = Date.now()): { bookingId: string } | null {
  if (!value || value.length > 1_000) return null;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  let expected: string;
  try {
    expected = sessionSignature(encoded);
  } catch {
    return null;
  }
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { g?: unknown; b?: unknown; e?: unknown };
    if (payload.g !== garageId || typeof payload.b !== "string" || typeof payload.e !== "number") return null;
    if (!Number.isInteger(payload.e) || payload.e <= Math.floor(now / 1000)) return null;
    return { bookingId: payload.b };
  } catch {
    return null;
  }
}

export function manageCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MANAGE_SESSION_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

type Related<T> = T | T[] | null;

type ManageBookingRow = {
  id: string;
  garage_id: string;
  reference: string;
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  during: string | null;
  location_mode: LocationMode | null;
  postcode: string | null;
  resource_id: string | null;
  service_id: string;
  idempotency_key: string | null;
  manage_token_hash: string | null;
  services: Related<{ id: string; name: string; needs_approval: boolean | null }>;
  resources: Related<{ kind: string }>;
  customers: Related<{ name: string | null; phone: string | null }>;
  vehicles: Related<{ registration: string | null; make: string | null; model: string | null }>;
};

type GarageSettingsRow = { id: string; timezone: string | null; cancellation_cutoff_h: number | null };

/**
 * A booking as the manage flow and the admin see it. `id` never goes to a customer; the full phone
 * number and the customer's postcode stay on the server (the manage page shows them masked).
 */
export type ManagedBooking = PublicManagedBooking & {
  id: string;
  garageId: string;
  customerName: string;
  /** E.164, as stored on the customer. */
  customerPhone: string | null;
  /** The visit postcode (mobile bookings). */
  postcode: string | null;
  serviceId: string;
  resourceId: string | null;
  resourceKind: string | null;
  during: TimeRange | null;
  timeZone: string;
  idempotencyKey: string | null;
  manageTokenHash: string | null;
};

const bookingColumns = "id,garage_id,reference,status,starts_at,ends_at,during,location_mode,postcode,resource_id,service_id,idempotency_key,manage_token_hash,services(id,name,needs_approval),resources(kind),customers(name,phone)";
const MANAGE_SELECT = `${bookingColumns},vehicles(registration,make,model)`;
const MANAGE_SELECT_BY_REGISTRATION = `${bookingColumns},vehicles!inner(registration,make,model)`;

function relation<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function adminClient(): SupabaseClient {
  const client = createAdminClient();
  if (!client) throw new BookingEngineError("UNAVAILABLE");
  return client;
}

async function loadGarageSettings(client: SupabaseClient, garageId: string) {
  const { data, error } = await client.from("garages").select("id,timezone,cancellation_cutoff_h").eq("id", garageId).maybeSingle();
  if (error) throw new BookingEngineError("UNAVAILABLE");
  if (!data) return null;
  const row = data as GarageSettingsRow;
  return { timeZone: row.timezone || "Europe/London", cutoffHours: Math.max(0, row.cancellation_cutoff_h ?? 24) };
}

function firstName(name: string | null | undefined) {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

function toManagedBooking(row: ManageBookingRow, settings: { timeZone: string; cutoffHours: number }, now: Date): ManagedBooking | null {
  const startsAt = isoInstant(row.starts_at);
  const endsAt = isoInstant(row.ends_at);
  if (!startsAt || !endsAt) return null;
  const service = relation(row.services);
  const vehicle = relation(row.vehicles);
  const customer = relation(row.customers);
  const deadline = new Date(Date.parse(startsAt) - settings.cutoffHours * 3_600_000);
  const statusAllows = customerChangeableStatuses.includes(row.status);
  const beforeCutoff = now.getTime() < deadline.getTime();
  return {
    id: row.id,
    garageId: row.garage_id,
    customerName: (customer?.name ?? "").trim(),
    customerPhone: customer?.phone ?? null,
    postcode: row.postcode ?? null,
    reference: row.reference,
    status: row.status,
    startsAt,
    endsAt,
    locationMode: row.location_mode === "mobile" ? "mobile" : "workshop",
    service: { id: row.service_id, name: service?.name ?? "Booking" },
    vehicle: {
      registration: vehicle?.registration ? formatRegistration(vehicle.registration) : "",
      make: vehicle?.make ?? null,
      model: vehicle?.model ?? null,
    },
    customerFirstName: firstName(customer?.name),
    canChange: statusAllows && beforeCutoff,
    changeDeadline: deadline.toISOString(),
    blockedReason: !statusAllows ? "status" : !beforeCutoff ? "cutoff" : null,
    serviceId: row.service_id,
    resourceId: row.resource_id,
    resourceKind: relation(row.resources)?.kind ?? null,
    during: parseTimeRange(row.during),
    timeZone: settings.timeZone,
    idempotencyKey: row.idempotency_key,
    manageTokenHash: row.manage_token_hash,
  };
}

/** Strips everything a customer must not see. */
export function toPublicManagedBooking(booking: ManagedBooking): PublicManagedBooking {
  return {
    reference: booking.reference,
    status: booking.status,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    locationMode: booking.locationMode,
    service: booking.service,
    vehicle: booking.vehicle,
    customerFirstName: booking.customerFirstName,
    canChange: booking.canChange,
    changeDeadline: booking.changeDeadline,
    blockedReason: booking.blockedReason,
  };
}

export type FindBookingForManageInput =
  | { garageId: string; reference: string; registration: string }
  | { garageId: string; token: string }
  | { garageId: string; bookingId: string };

/**
 * Finds a booking in one garage by reference + registration, by signed-link
 * token, or by id (from a verified manage session). Null when there is no
 * match, so callers can answer with one generic "not found".
 */
export async function findBookingForManage(input: FindBookingForManageInput, now = new Date()): Promise<ManagedBooking | null> {
  const client = adminClient();
  const settings = await loadGarageSettings(client, input.garageId);
  if (!settings) return null;

  let query;
  if ("token" in input) {
    const token = manageTokenSchema.safeParse(input.token);
    if (!token.success) return null;
    query = client.from("bookings").select(MANAGE_SELECT).eq("garage_id", input.garageId).eq("manage_token_hash", hashManageToken(token.data));
  } else if ("reference" in input) {
    const reference = bookingReferenceSchema.safeParse(input.reference);
    const registration = registrationSchema.safeParse(input.registration);
    if (!reference.success || !registration.success) return null;
    query = client
      .from("bookings")
      .select(MANAGE_SELECT_BY_REGISTRATION)
      .eq("garage_id", input.garageId)
      .eq("reference", reference.data)
      .eq("vehicles.registration", registration.data);
  } else {
    query = client.from("bookings").select(MANAGE_SELECT).eq("garage_id", input.garageId).eq("id", input.bookingId);
  }

  const { data, error } = await query.is("deleted_at", null).maybeSingle();
  if (error) throw new BookingEngineError("UNAVAILABLE");
  return data ? toManagedBooking(data as unknown as ManageBookingRow, settings, now) : null;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export type ManageActor = "customer" | "staff";

export type ManageOutcome =
  | { ok: true; booking: ManagedBooking; changed: boolean }
  | { ok: false; code: ManageErrorCode; message: string; alternatives?: Slot[] };

function failure(code: ManageErrorCode, alternatives?: Slot[]): ManageOutcome {
  return alternatives ? { ok: false, code, message: manageErrorMessages[code], alternatives } : { ok: false, code, message: manageErrorMessages[code] };
}

async function recordEvent(client: SupabaseClient, garageId: string, bookingId: string, type: string, actor: ManageActor, actorId: string | null | undefined, data: Record<string, unknown>) {
  // The audit row is best effort: the change itself has already been made.
  await client.from("booking_events").insert({ garage_id: garageId, booking_id: bookingId, type, actor, actor_id: actorId ?? null, data });
}

function guardChange(booking: ManagedBooking, actor: ManageActor): ManageOutcome | null {
  if (!customerChangeableStatuses.includes(booking.status)) return failure("NOT_MODIFIABLE");
  if (actor === "customer" && booking.blockedReason === "cutoff") return failure("CUTOFF_PASSED");
  return null;
}

export type RescheduleInput = {
  garageId: string;
  bookingId: string;
  startsAt: string;
  actor: ManageActor;
  /** The staff member's user id (admin); never set from a customer request. */
  actorId?: string | null;
  now?: Date;
};

/**
 * Moves a booking to another start the booking page would offer. The blocked
 * window (`during`, which includes travel and buffer) moves by the same amount,
 * so it stays as `create_booking()` computed it. The current resource is kept
 * when free, otherwise another active resource of the same kind; `no_overlap`
 * still has the last word.
 */
export async function rescheduleBooking(input: RescheduleInput): Promise<ManageOutcome> {
  const now = input.now ?? new Date();
  const client = adminClient();
  const booking = await findBookingForManage({ garageId: input.garageId, bookingId: input.bookingId }, now);
  if (!booking) return failure("NOT_FOUND");
  const blocked = guardChange(booking, input.actor);
  if (blocked) return blocked;

  const newStart = isoInstant(input.startsAt);
  if (!newStart || Date.parse(newStart) <= now.getTime()) return failure("INVALID_BOOKING");
  if (newStart === booking.startsAt) return { ok: true, booking, changed: false };
  if (!booking.during || !booking.resourceKind) return failure("NOT_MODIFIABLE");

  const day = calendarDateInTimeZone(newStart, booking.timeZone);
  if (!day) return failure("INVALID_BOOKING");
  const alternatives = () => findAlternativeSlots(client, {
    garageId: input.garageId,
    serviceId: booking.serviceId,
    locationMode: booking.locationMode,
    requestedStart: newStart,
    timeZone: booking.timeZone,
    now,
    exclude: [booking.startsAt],
  });

  // The start must be one the booking page offers (opening hours, closures,
  // notice, max days ahead). Capacity is checked below without counting this
  // booking against itself.
  let candidates: Slot[];
  try {
    candidates = await fetchAvailableSlots(client, { garageId: input.garageId, serviceId: booking.serviceId, from: day, to: day, locationMode: booking.locationMode });
  } catch (error) {
    if (error instanceof BookingEngineError && error.code === "SERVICE_UNAVAILABLE") return failure("NOT_MODIFIABLE");
    return failure("UNAVAILABLE");
  }
  if (!candidates.some((slot) => slot.startsAt === newStart)) return failure("SLOT_UNAVAILABLE", await alternatives());

  const delta = Date.parse(newStart) - Date.parse(booking.startsAt);
  const during = shiftTimeRange(booking.during, delta);
  const duringLiteral = formatTimeRange(during);
  const endsAt = new Date(Date.parse(booking.endsAt) + delta).toISOString();

  const [resourcesResult, overlapsResult] = await Promise.all([
    client.from("resources").select("id,sort").eq("garage_id", input.garageId).eq("kind", booking.resourceKind).eq("active", true).order("sort", { ascending: true }).order("id", { ascending: true }),
    client
      .from("bookings")
      .select("resource_id")
      .eq("garage_id", input.garageId)
      .overlaps("during", duringLiteral)
      .not("status", "in", `(${releasedStatuses.join(",")})`)
      .neq("id", booking.id),
  ]);
  if (resourcesResult.error || overlapsResult.error) return failure("UNAVAILABLE");
  const busy = new Set(((overlapsResult.data ?? []) as Array<{ resource_id: string | null }>).map((row) => row.resource_id));
  const free = ((resourcesResult.data ?? []) as Array<{ id: string }>).map((row) => row.id).filter((id) => !busy.has(id));
  const resourceId = booking.resourceId && free.includes(booking.resourceId) ? booking.resourceId : free[0];
  if (!resourceId) return failure("SLOT_UNAVAILABLE", await alternatives());

  const { data: updated, error: updateError } = await client
    .from("bookings")
    .update({ starts_at: newStart, ends_at: endsAt, during: duringLiteral, resource_id: resourceId })
    .eq("garage_id", input.garageId)
    .eq("id", booking.id)
    .in("status", [...customerChangeableStatuses])
    .select("id")
    .maybeSingle();
  if (updateError?.code === "23P01") return failure("SLOT_UNAVAILABLE", await alternatives());
  if (updateError) return failure("UNAVAILABLE");
  if (!updated) return failure("NOT_MODIFIABLE");

  clearSlotCache(input.garageId);
  await recordEvent(client, input.garageId, booking.id, "rescheduled", input.actor, input.actorId, { from: booking.startsAt, to: newStart });
  notifyBooking({ type: "rescheduled", garageId: input.garageId, bookingId: booking.id, previousStartsAt: booking.startsAt });

  const fresh = await findBookingForManage({ garageId: input.garageId, bookingId: booking.id }, now).catch(() => null);
  return { ok: true, booking: fresh ?? { ...booking, startsAt: newStart, endsAt, during, resourceId }, changed: true };
}

export type CancelInput = {
  garageId: string;
  bookingId: string;
  actor: ManageActor;
  actorId?: string | null;
  reason?: string | null;
  now?: Date;
};

/** Cancels a booking (customers only before the garage's cutoff) and frees its slot. */
export async function cancelBooking(input: CancelInput): Promise<ManageOutcome> {
  const now = input.now ?? new Date();
  const client = adminClient();
  const booking = await findBookingForManage({ garageId: input.garageId, bookingId: input.bookingId }, now);
  if (!booking) return failure("NOT_FOUND");
  if (booking.status === "cancelled") return { ok: true, booking, changed: false };
  const blocked = guardChange(booking, input.actor);
  if (blocked) return blocked;

  const reason = input.reason?.trim().slice(0, 300) || (input.actor === "staff" ? "Cancelled by the garage" : "Cancelled by the customer online");
  const cancelledAt = now.toISOString();
  const { data: updated, error } = await client
    .from("bookings")
    .update({ status: "cancelled", cancelled_at: cancelledAt, cancellation_reason: reason })
    .eq("garage_id", input.garageId)
    .eq("id", booking.id)
    .in("status", [...customerChangeableStatuses])
    .select("id")
    .maybeSingle();
  if (error) return failure("UNAVAILABLE");
  if (!updated) return failure("NOT_MODIFIABLE");

  clearSlotCache(input.garageId);
  await recordEvent(client, input.garageId, booking.id, "cancelled", input.actor, input.actorId, { previous_status: booking.status, reason });
  notifyBooking({ type: "cancelled", garageId: input.garageId, bookingId: booking.id });

  const cancelled: ManagedBooking = { ...booking, status: "cancelled", canChange: false, blockedReason: "status" };
  return { ok: true, booking: cancelled, changed: true };
}
