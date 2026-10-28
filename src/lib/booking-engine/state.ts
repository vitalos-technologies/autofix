import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  bookingStatuses,
  locationModes,
  messageChannels,
  type BookingDraft,
  type BookingStatus,
  type CustomerChannel,
  type LocationMode,
  type Slot,
} from "@/lib/booking-engine/types";

/**
 * Booking flow state between the five booking steps (docs/autofix/ARCHITECTURE.md → Booking engine).
 *
 * `af_booking` holds the draft (vehicle, service, location, symptoms, note, chosen start) and
 * `af_booked` holds the short "just booked" summary the confirmation page shows. Both are sealed
 * with AES-256-GCM, so the registration and contact details inside are neither readable nor
 * changeable by the browser, and are bound to one garage: the garage id is the additional
 * authenticated data, so a cookie sealed for one garage never opens for another.
 *
 * Cookie value: `v1.<iv>.<ciphertext>.<tag>` (base64url; 12-byte IV, 16-byte tag). The plaintext is
 * JSON `{ "p": <payload>, "exp": <unix seconds> }`. The key is HKDF-SHA-256 of
 * `BOOKING_STATE_SECRET` (falls back to `BOOKING_MANAGEMENT_SECRET`) with a per-cookie `info`.
 * Outside production a fixed development key is used when neither is set.
 */

export const BOOKING_STATE_COOKIE = "af_booking";
export const JUST_BOOKED_COOKIE = "af_booked";
export const BOOKING_STATE_VERSION = "v1";
/** The draft lives for 2 hours after the last step was saved. */
export const BOOKING_STATE_MAX_AGE_S = 2 * 60 * 60;
/** The confirmation page can show the booking for 30 minutes after it was made. */
export const JUST_BOOKED_MAX_AGE_S = 30 * 60;

type Purpose = typeof BOOKING_STATE_COOKIE | typeof JUST_BOOKED_COOKIE;

const DEV_SECRET = "autofix-development-booking-state-key-not-for-production";
let warnedAboutDevKey = false;

export type SealEnv = Readonly<Record<string, string | undefined>>;

function stateSecret(env: SealEnv): string {
  const secret = env.BOOKING_STATE_SECRET?.trim() || env.BOOKING_MANAGEMENT_SECRET?.trim();
  if (secret) return secret;
  if (env.NODE_ENV === "production") throw new Error("BOOKING_STATE_SECRET is not set");
  if (!warnedAboutDevKey && env.NODE_ENV === "development") {
    warnedAboutDevKey = true;
    console.warn("[booking-state] BOOKING_STATE_SECRET is not set; using the fixed development key.");
  }
  return DEV_SECRET;
}

const keyCache = new Map<string, Buffer>();

function sealingKey(purpose: Purpose, env: SealEnv): Buffer {
  const secret = stateSecret(env);
  const cacheKey = `${purpose}\u0000${secret}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "autofix:booking-state", `${purpose}:${BOOKING_STATE_VERSION}`, 32));
    keyCache.set(cacheKey, key);
  }
  return key;
}

function additionalData(purpose: Purpose, garageId: string) {
  return Buffer.from(`${purpose}|${BOOKING_STATE_VERSION}|${garageId}`, "utf8");
}

export type SealOptions = { now?: Date; maxAgeS?: number; env?: SealEnv };

/** Seals a JSON payload for one garage. Exported for tests; pages use the read/write helpers. */
export function sealValue(purpose: Purpose, garageId: string, payload: unknown, options: SealOptions = {}): string {
  const now = options.now ?? new Date();
  const exp = Math.floor(now.getTime() / 1000) + (options.maxAgeS ?? BOOKING_STATE_MAX_AGE_S);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(purpose, options.env ?? process.env), iv);
  cipher.setAAD(additionalData(purpose, garageId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ p: payload, exp }), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [BOOKING_STATE_VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

/** Opens a sealed value. `null` for anything missing, tampered, expired, from another garage or another version. */
export function openValue(purpose: Purpose, garageId: string, sealed: string | null | undefined, options: SealOptions = {}): unknown {
  if (!sealed || sealed.length > 4096) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== BOOKING_STATE_VERSION) return null;
  try {
    const [, iv, ciphertext, tag] = parts as [string, string, string, string];
    const ivBytes = Buffer.from(iv, "base64url");
    const tagBytes = Buffer.from(tag, "base64url");
    if (ivBytes.length !== 12 || tagBytes.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(purpose, options.env ?? process.env), ivBytes);
    decipher.setAAD(additionalData(purpose, garageId));
    decipher.setAuthTag(tagBytes);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    const envelope = JSON.parse(plaintext) as { p?: unknown; exp?: unknown };
    const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (typeof envelope.exp !== "number" || envelope.exp <= now) return null;
    return envelope.p ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Draft (`af_booking`)

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slotSchema = z.object({ startsAt: z.string(), endsAt: z.string(), freeCount: z.number() });

const draftVehicleSchema = z.object({
  registration: z.string().regex(/^[A-Z0-9]{2,8}$/),
  make: z.string().max(80).optional(),
  model: z.string().max(120).optional(),
  colour: z.string().max(50).optional(),
  fuel: z.string().max(50).optional(),
  year: z.number().int().optional(),
  engine: z.string().max(80).optional(),
  motExpiry: isoDate.optional(),
  lastMileage: z.number().int().optional(),
  manual: z.boolean().optional(),
});

const draftSchema = z.object({
  v: z.literal(1),
  garageId: z.string(),
  vehicle: draftVehicleSchema.optional(),
  serviceId: z.string().optional(),
  locationMode: z.enum(locationModes).optional(),
  postcode: z.string().max(10).optional(),
  address: z.string().max(300).optional(),
  symptoms: z.array(z.string().max(80)).max(10).optional(),
  note: z.string().max(2000).optional(),
  startsAt: z.string().optional(),
  reminderSendId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

/** Flow bookkeeping kept next to the draft (never sent to the engine). */
export type BookingFlowMeta = {
  /** Set when Turnstile was passed for this draft, so later steps do not ask again. */
  humanCheckedAt?: number;
  /** The engine said the chosen time had gone; the time step shows these instead. */
  slotTaken?: { startsAt: string; alternatives: Slot[] };
};

const metaSchema = z.object({
  humanCheckedAt: z.number().optional(),
  slotTaken: z.object({ startsAt: z.string(), alternatives: z.array(slotSchema).max(10) }).optional(),
});

const sessionSchema = z.object({ d: draftSchema, m: metaSchema.optional() });

export type BookingFlowSession = { draft: BookingDraft; meta: BookingFlowMeta };

/** A new, empty draft for the garage, with its own idempotency key. */
export function emptyBookingDraft(garageId: string): BookingDraft {
  return { v: 1, garageId, idempotencyKey: randomUUID() };
}

/** Opens a sealed `af_booking` value for this garage, or an empty draft. */
export function openBookingSession(garageId: string, sealed: string | null | undefined, options: SealOptions = {}): BookingFlowSession {
  const parsed = sessionSchema.safeParse(openValue(BOOKING_STATE_COOKIE, garageId, sealed, options));
  if (!parsed.success || parsed.data.d.garageId !== garageId) return { draft: emptyBookingDraft(garageId), meta: {} };
  return { draft: parsed.data.d as BookingDraft, meta: (parsed.data.m ?? {}) as BookingFlowMeta };
}

export function sealBookingSession(draft: BookingDraft, meta: BookingFlowMeta = {}, options: SealOptions = {}): string {
  return sealValue(BOOKING_STATE_COOKIE, draft.garageId, { d: draft, m: meta }, { ...options, maxAgeS: BOOKING_STATE_MAX_AGE_S });
}

function cookieOptions(maxAge: number, path = "/") {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path,
    maxAge,
  };
}

/** `af_booking` cookie options, for route handlers that set the draft on their own response (`/r/{token}`). */
export function bookingStateCookieOptions() {
  return cookieOptions(BOOKING_STATE_MAX_AGE_S);
}

/** The draft and flow bookkeeping for the host's garage. Empty when absent or not readable. */
export async function readBookingSession(garageId: string): Promise<BookingFlowSession> {
  const store = await cookies();
  return openBookingSession(garageId, store.get(BOOKING_STATE_COOKIE)?.value);
}

/** The booking draft for the host's garage. A cookie from another garage reads as an empty draft. */
export async function readBookingDraft(garageId: string): Promise<BookingDraft> {
  return (await readBookingSession(garageId)).draft;
}

/** Saves the draft (server actions and route handlers only). Every write restarts the 2-hour life. */
export async function writeBookingDraft(draft: BookingDraft, meta: BookingFlowMeta = {}): Promise<void> {
  const store = await cookies();
  store.set(BOOKING_STATE_COOKIE, sealBookingSession(draft, meta), cookieOptions(BOOKING_STATE_MAX_AGE_S));
}

export async function clearBookingDraft(): Promise<void> {
  const store = await cookies();
  store.set(BOOKING_STATE_COOKIE, "", cookieOptions(0));
}

// ---------------------------------------------------------------------------------------------
// Just booked (`af_booked`)

/** What the confirmation page shows. Sealed: it holds the registration and a masked contact. */
export type JustBooked = {
  reference: string;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  locationMode: LocationMode;
  /** "Workshop, DN4" or "Mobile visit, DN1". */
  where: string;
  /** "Ford Focus" (may be empty for a manual entry without a model). */
  vehicleName: string;
  registration: string;
  channel: CustomerChannel;
  /** Masked mobile (`07••• •••412`) or email (`s•••@example.com`). */
  contactHint: string;
  /** P5.8: one line per extra (courtesy car request, collection and delivery) for the confirmation. */
  extras?: string[];
};

const justBookedSchema = z.object({
  reference: z.string().min(1).max(40),
  status: z.enum(bookingStatuses),
  startsAt: z.string(),
  endsAt: z.string(),
  serviceName: z.string(),
  locationMode: z.enum(locationModes),
  where: z.string(),
  vehicleName: z.string(),
  registration: z.string(),
  channel: z.enum(messageChannels),
  contactHint: z.string(),
  extras: z.array(z.string().max(200)).max(4).optional(),
});

/** Cookie path: only the confirmation page receives it. */
export const JUST_BOOKED_PATH = "/confirmed";

export function sealJustBooked(garageId: string, booked: JustBooked, options: SealOptions = {}): string {
  return sealValue(JUST_BOOKED_COOKIE, garageId, booked, { ...options, maxAgeS: JUST_BOOKED_MAX_AGE_S });
}

/** The summary when the sealed value is for this garage and this reference; otherwise null. */
export function openJustBooked(garageId: string, reference: string, sealed: string | null | undefined, options: SealOptions = {}): JustBooked | null {
  const parsed = justBookedSchema.safeParse(openValue(JUST_BOOKED_COOKIE, garageId, sealed, options));
  if (!parsed.success) return null;
  return parsed.data.reference.toUpperCase() === reference.trim().toUpperCase() ? parsed.data : null;
}

export async function writeJustBooked(garageId: string, booked: JustBooked): Promise<void> {
  const store = await cookies();
  store.set(JUST_BOOKED_COOKIE, sealJustBooked(garageId, booked), cookieOptions(JUST_BOOKED_MAX_AGE_S, JUST_BOOKED_PATH));
}

export async function readJustBooked(garageId: string, reference: string): Promise<JustBooked | null> {
  const store = await cookies();
  return openJustBooked(garageId, reference, store.get(JUST_BOOKED_COOKIE)?.value);
}
