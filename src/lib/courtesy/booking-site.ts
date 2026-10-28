import "server-only";

import { inServiceArea, postcodeDistrict } from "@/lib/booking-flow/copy";
import { getChannel } from "@/lib/messaging/channel";
import { garageHasFeature } from "@/lib/plans/server";
import { createAdminClient } from "@/lib/supabase/server";
import type { Garage } from "@/lib/tenancy/garage";
import { parseCollectionForm, type CollectionField } from "./view";

// P5.8 on the garage's booking site (garage from the request host, never the form). The booking is
// always created first through create_booking(); the courtesy car request and the collection legs
// are attached afterwards by their own service-role functions, so an availability race or a busy
// van can never fail or change the booking. A failure to attach is noted on the booking (SQL) and
// emailed to the garage; the customer is told plainly on the confirmation page.

export type BookingExtrasOptions = {
  /** A courtesy car is free for the chosen slot (to closing that day): offer "I'd like a courtesy car". */
  courtesy: boolean;
  /** The service offers collection and delivery and this is a workshop visit. */
  collection: boolean;
};

export const NO_EXTRAS: BookingExtrasOptions = { courtesy: false, collection: false };

/** What the details step may offer. Never throws: on any problem nothing extra is offered. */
export async function getBookingExtrasOptions(
  garage: Garage,
  input: { serviceId: string; startsAt: string; durationMin: number; locationMode: string },
): Promise<BookingExtrasOptions> {
  if (!garageHasFeature(garage, "courtesy_cars")) return NO_EXTRAS;
  const client = createAdminClient();
  if (!client) return NO_EXTRAS;
  try {
    const start = new Date(input.startsAt);
    if (Number.isNaN(start.getTime())) return NO_EXTRAS;
    const end = new Date(start.getTime() + Math.max(1, input.durationMin) * 60_000);
    const [free, service] = await Promise.all([
      client.rpc("courtesy_car_free_count", { p_garage_id: garage.id, p_starts_at: start.toISOString(), p_ends_at: end.toISOString() }),
      client.from("services").select("collection_delivery").eq("garage_id", garage.id).eq("id", input.serviceId).maybeSingle(),
    ]);
    return {
      courtesy: !free.error && Number(free.data) > 0,
      collection:
        !service.error &&
        Boolean((service.data as { collection_delivery?: boolean } | null)?.collection_delivery) &&
        input.locationMode === "workshop" &&
        garage.serviceArea.length > 0,
    };
  } catch {
    return NO_EXTRAS;
  }
}

export type BookingExtrasChoice = { courtesy: boolean; collection: { postcode: string; address: string } | null };

/**
 * The customer's choices from the details form, checked against what was offered. Only the
 * collection address can be wrong (postcode format, outside the mobile area).
 */
export function readBookingExtras(
  formData: FormData,
  offered: BookingExtrasOptions,
  serviceArea: string[],
  proEnabled = offered.courtesy,
): { ok: true; value: BookingExtrasChoice } | { ok: false; fieldErrors: Partial<Record<"collectionPostcode" | "collectionAddress", string>> } {
  // A ticked courtesy box counts whenever the garage has Pro, even if the last free car went since
  // the page loaded: it is only a request, and staff see that no car was free.
  const courtesy = proEnabled && formData.get("courtesyCar") === "yes";
  if (!offered.collection || formData.get("collectionDelivery") !== "yes") return { ok: true, value: { courtesy, collection: null } };
  const parsed = parseCollectionForm(formData);
  if (!parsed.ok) {
    const map: Record<CollectionField, "collectionPostcode" | "collectionAddress"> = { postcode: "collectionPostcode", address: "collectionAddress" };
    return {
      ok: false,
      fieldErrors: Object.fromEntries(Object.entries(parsed.fieldErrors).map(([field, message]) => [map[field as CollectionField], message])),
    };
  }
  if (!inServiceArea(parsed.value.postcode, serviceArea)) {
    return {
      ok: false,
      fieldErrors: { collectionPostcode: `Sorry, we don't collect from ${postcodeDistrict(parsed.value.postcode)}. Untick collection and bring the car in, or call us.` },
    };
  }
  return { ok: true, value: { courtesy, collection: { postcode: parsed.value.postcode, address: parsed.value.address ?? "" } } };
}

export type AttachedExtras = {
  courtesy: "requested" | "failed" | null;
  collection: "held" | "partial" | "unassigned" | "failed" | null;
};

/** One line per extra for the confirmation page. */
export function extrasSummary(attached: AttachedExtras): string[] {
  const lines: string[] = [];
  if (attached.courtesy === "requested") lines.push("Courtesy car asked for: the garage will confirm it.");
  if (attached.courtesy === "failed") lines.push("We couldn't pass on your courtesy car request. Please mention it when the garage calls, or call them.");
  if (attached.collection === "held") lines.push("Collection and delivery booked: we'll collect the car before the job and bring it back after.");
  if (attached.collection === "partial" || attached.collection === "unassigned" || attached.collection === "failed") {
    lines.push("Collection and delivery: the garage will call you to arrange the times.");
  }
  return lines;
}

/**
 * Attaches the extras to a booking that create_booking() has just made. Never throws. Anything that
 * did not go through (or a van that was busy) is also emailed to the garage, once per booking.
 */
export async function attachBookingExtras(
  garage: Garage,
  booking: { id: string; reference: string },
  choice: BookingExtrasChoice,
): Promise<AttachedExtras> {
  const attached: AttachedExtras = { courtesy: null, collection: null };
  if (!choice.courtesy && !choice.collection) return attached;
  const client = createAdminClient();
  if (!client) return { courtesy: choice.courtesy ? "failed" : null, collection: choice.collection ? "failed" : null };

  if (choice.courtesy) {
    try {
      const { error } = await client.rpc("request_courtesy_car", { p_garage_id: garage.id, p_booking_id: booking.id });
      attached.courtesy = error ? "failed" : "requested";
    } catch {
      attached.courtesy = "failed";
    }
  }
  if (choice.collection) {
    try {
      const { data, error } = await client.rpc("request_collection_delivery", {
        p_garage_id: garage.id,
        p_booking_id: booking.id,
        p_postcode: choice.collection.postcode,
        p_address: choice.collection.address,
      });
      const status = (data as { status?: string } | null)?.status;
      attached.collection = error ? "failed" : status === "held" || status === "partial" || status === "unassigned" ? status : "failed";
    } catch {
      attached.collection = "failed";
    }
  }

  await alertGarage(garage, booking, attached);
  return attached;
}

/** Staff email (to the garage's own address; no customer is messaged here). No registration in it. */
async function alertGarage(garage: Garage, booking: { id: string; reference: string }, attached: AttachedExtras) {
  const lines: string[] = [];
  if (attached.courtesy === "requested") lines.push("The customer asked for a courtesy car. Reserve one on the booking, or decline the request.");
  if (attached.courtesy === "failed") lines.push("The customer asked for a courtesy car, but the request could not be saved. Call them to arrange it.");
  if (attached.collection === "partial" || attached.collection === "unassigned") lines.push("The customer chose collection and delivery, but no van was free for every run. Call them to arrange it.");
  if (attached.collection === "failed") lines.push("The customer chose collection and delivery, but it could not be saved. Call them to arrange it.");
  if (lines.length === 0 || !garage.email) return;
  const adminHost = process.env.NEXT_PUBLIC_ADMIN_HOST?.trim();
  const link = adminHost ? `\n\nOpen the booking: https://${adminHost}/app/bookings/${booking.id}` : "";
  try {
    await getChannel("email").send({
      garageId: garage.id,
      to: garage.email,
      subject: `Booking ${booking.reference}: courtesy car or collection to arrange`,
      body: `${lines.join("\n")}${link}`,
      idempotencyKey: `courtesy-extras:${booking.id}`,
    });
  } catch {
    // The booking already carries a system note; the email is a convenience.
  }
}
