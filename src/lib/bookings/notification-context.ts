import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { manageTokenForBooking } from "@/lib/booking-engine/manage";
import { isoInstant } from "@/lib/booking-engine/range";
import type { BookingStatus, CustomerChannel, LocationMode } from "@/lib/booking-engine/types";
import { addressLine } from "@/lib/tenancy/contact";
import { GARAGE_SELECT, garageFromRow, type Garage, type GarageRow } from "@/lib/tenancy/garage";

// Everything a booking email, text message or calendar file needs, loaded
// with the service role for one garage. Never logged.

type Related<T> = T | T[] | null;

type ContextRow = {
  id: string;
  reference: string;
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  location_mode: LocationMode | null;
  postcode: string | null;
  address: string | null;
  notes: string | null;
  symptoms: unknown;
  created_at: string;
  updated_at: string | null;
  cancellation_reason: string | null;
  idempotency_key: string | null;
  manage_token_hash: string | null;
  services: Related<{ name: string }>;
  customers: Related<{ id: string; name: string; email: string | null; phone: string | null; channel: CustomerChannel | null; opted_out_at: string | null }>;
  vehicles: Related<{ registration: string | null; make: string | null; model: string | null }>;
};

export type BookingNotificationContext = {
  garage: Garage;
  booking: {
    id: string;
    reference: string;
    status: BookingStatus;
    startsAt: string;
    endsAt: string;
    locationMode: LocationMode;
    /** Where the customer should be: the workshop address, or the mobile visit address. */
    location: string;
    notes: string | null;
    symptoms: string[];
    cancellationReason: string | null;
    updatedAt: string;
  };
  service: { name: string };
  customer: { id: string; name: string; email: string | null; phone: string | null; channel: CustomerChannel; optedOutAt: string | null };
  vehicle: { registration: string; make: string | null; model: string | null };
  /** Raw manage-link token when it can be re-derived (see manageTokenForBooking). */
  manageToken: string | null;
  /** Moves and cancellations so far: the calendar SEQUENCE. */
  calendarSequence: number;
};

const CONTEXT_SELECT = "id,reference,status,starts_at,ends_at,location_mode,postcode,address,notes,symptoms,created_at,updated_at,cancellation_reason,idempotency_key,manage_token_hash,services(name),customers(id,name,email,phone,channel,opted_out_at),vehicles(registration,make,model)";

function relation<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function bookingLocation(garage: Pick<Garage, "name" | "address">, booking: { locationMode: LocationMode; address: string | null; postcode: string | null }) {
  if (booking.locationMode === "mobile") return [booking.address, booking.postcode].filter(Boolean).join(", ") || "Mobile visit";
  return [`${garage.name} workshop`, addressLine(garage.address)].filter(Boolean).join(", ");
}

export async function loadBookingNotificationContext(
  client: SupabaseClient,
  garageId: string,
  by: { bookingId: string } | { reference: string },
): Promise<BookingNotificationContext | null> {
  const bookingQuery = client.from("bookings").select(CONTEXT_SELECT).eq("garage_id", garageId);
  const [garageResult, bookingResult] = await Promise.all([
    client.from("garages").select(GARAGE_SELECT).eq("id", garageId).maybeSingle(),
    ("bookingId" in by ? bookingQuery.eq("id", by.bookingId) : bookingQuery.eq("reference", by.reference)).is("deleted_at", null).maybeSingle(),
  ]);
  if (garageResult.error || bookingResult.error) throw new Error("booking notification context unavailable");
  if (!garageResult.data || !bookingResult.data) return null;

  const garage = garageFromRow(garageResult.data as GarageRow);
  const row = bookingResult.data as unknown as ContextRow;
  const customer = relation(row.customers);
  const vehicle = relation(row.vehicles);
  const startsAt = isoInstant(row.starts_at);
  const endsAt = isoInstant(row.ends_at);
  if (!customer || !startsAt || !endsAt) return null;

  const { count } = await client
    .from("booking_events")
    .select("id", { count: "exact", head: true })
    .eq("garage_id", garageId)
    .eq("booking_id", row.id)
    .in("type", ["rescheduled", "cancelled"]);

  const locationMode: LocationMode = row.location_mode === "mobile" ? "mobile" : "workshop";
  return {
    garage,
    booking: {
      id: row.id,
      reference: row.reference,
      status: row.status,
      startsAt,
      endsAt,
      locationMode,
      location: bookingLocation(garage, { locationMode, address: row.address, postcode: row.postcode }),
      notes: row.notes,
      symptoms: Array.isArray(row.symptoms) ? row.symptoms.filter((item): item is string => typeof item === "string").slice(0, 10) : [],
      cancellationReason: row.cancellation_reason,
      updatedAt: isoInstant(row.updated_at ?? "") ?? isoInstant(row.created_at) ?? new Date().toISOString(),
    },
    service: { name: relation(row.services)?.name ?? "Booking" },
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      channel: customer.channel ?? "sms",
      optedOutAt: customer.opted_out_at,
    },
    vehicle: { registration: vehicle?.registration ?? "", make: vehicle?.make ?? null, model: vehicle?.model ?? null },
    manageToken: manageTokenForBooking(garageId, { idempotencyKey: row.idempotency_key, manageTokenHash: row.manage_token_hash }),
    calendarSequence: count ?? 0,
  };
}
