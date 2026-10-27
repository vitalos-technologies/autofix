/**
 * Booking rows as the admin pages read them through the garage's RLS client, and their mapping
 * to plain objects. Pure (no server imports) so the shaping is unit tested.
 */
import { bookingSources, bookingStatuses, type BookingSource, type BookingStatus } from "@/lib/booking-engine/types";

type Related<T> = T | T[] | null | undefined;

/** Columns every admin booking view reads (PostgREST embeds the service, customer, vehicle and bay). */
export const ADMIN_BOOKING_SELECT =
  "id,reference,status,source,starts_at,ends_at,created_at,resource_id,location_mode,postcode,notes,symptoms,price_pence,admin_seen_at," +
  "services(name),customers(name,phone,email),vehicles(registration,make,model),resources(name)";

export type AdminBookingRow = {
  id: string;
  reference: string;
  status: string;
  source: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
  resource_id: string | null;
  location_mode?: string | null;
  postcode?: string | null;
  notes?: string | null;
  symptoms?: unknown;
  price_pence?: number | null;
  admin_seen_at?: string | null;
  services?: Related<{ name: string | null }>;
  customers?: Related<{ name: string | null; phone: string | null; email?: string | null }>;
  vehicles?: Related<{ registration: string | null; make: string | null; model: string | null }>;
  resources?: Related<{ name: string | null }>;
};

export type AdminBooking = {
  id: string;
  reference: string;
  status: BookingStatus;
  source: BookingSource;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  resourceId: string | null;
  resourceName: string | null;
  locationMode: "workshop" | "mobile";
  postcode: string | null;
  serviceName: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  /** Normalised (`AB12CDE`), or empty when the booking has no car. */
  registration: string;
  make: string | null;
  model: string | null;
  notes: string | null;
  symptoms: string[];
  pricePence: number | null;
  seen: boolean;
};

export function related<T>(value: Related<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function strings(value: unknown, max = 10): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, max);
}

export function toAdminBooking(row: AdminBookingRow): AdminBooking {
  const customer = related(row.customers);
  const vehicle = related(row.vehicles);
  return {
    id: row.id,
    reference: row.reference,
    status: oneOf(bookingStatuses, row.status, "confirmed"),
    source: oneOf(bookingSources, row.source, "online"),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    resourceId: row.resource_id ?? null,
    resourceName: related(row.resources)?.name ?? null,
    locationMode: row.location_mode === "mobile" ? "mobile" : "workshop",
    postcode: row.postcode ?? null,
    serviceName: related(row.services)?.name?.trim() || "Booking",
    customerName: customer?.name?.trim() || "Customer",
    customerPhone: customer?.phone ?? null,
    customerEmail: customer?.email ?? null,
    registration: (vehicle?.registration ?? "").toUpperCase().replace(/\s+/g, ""),
    make: vehicle?.make?.trim() || null,
    model: vehicle?.model?.trim() || null,
    notes: row.notes?.trim() || null,
    symptoms: strings(row.symptoms),
    pricePence: typeof row.price_pence === "number" ? row.price_pence : null,
    seen: Boolean(row.admin_seen_at),
  };
}

/** "Ford Focus", "Focus" or `null`. */
export function vehicleName(booking: Pick<AdminBooking, "make" | "model">, withMake = true): string | null {
  const parts = withMake ? [booking.make, booking.model] : [booking.model ?? booking.make];
  const name = parts.filter(Boolean).join(" ").trim();
  return name || null;
}

/** Symptoms as one short line after the service ("warning light"). */
export function bookingDetail(booking: Pick<AdminBooking, "symptoms">): string | undefined {
  if (booking.symptoms.length === 0) return undefined;
  return booking.symptoms.slice(0, 2).join(", ").toLowerCase();
}

export function bookingHref(id: string): string {
  return `/app/bookings/${id}`;
}

/** `tel:` link for a stored E.164 number, or `null`. */
export function telLink(phone: string | null | undefined): string | null {
  const compact = (phone ?? "").replace(/[^+\d]/g, "");
  return /^\+?\d{7,15}$/.test(compact) ? `tel:${compact}` : null;
}

/** `+447700900123` → `07700 900123`; other numbers unchanged. */
export function formatUkPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const match = /^\+44(\d{4})(\d{6})$/.exec(phone);
  return match ? `0${match[1]} ${match[2]}` : phone;
}
