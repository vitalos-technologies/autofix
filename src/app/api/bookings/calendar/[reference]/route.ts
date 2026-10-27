import type { NextRequest } from "next/server";
import { bookingReferenceSchema } from "@/lib/booking-engine/manage-schema";
import { buildBookingCalendar, verifyBookingCalendarSignature, type BookingCalendarStatus } from "@/lib/bookings/calendar";
import { loadBookingNotificationContext } from "@/lib/bookings/notification-context";
import { createAdminClient } from "@/lib/supabase/server";
import { getHostGarage } from "@/lib/tenancy/garage";
import { formatRegistration } from "@/lib/vehicle/registration-format";

function notFound() {
  return new Response("Calendar not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

function calendarStatus(status: string): BookingCalendarStatus | null {
  if (status === "cancelled") return "cancelled";
  if (status === "requested") return "requested";
  if (status === "confirmed" || status === "arrived" || status === "in_progress" || status === "waiting_parts" || status === "ready") return "confirmed";
  return null;
}

/** `.ics` for a booking on the host's garage; the signature binds garage and reference. */
export async function GET(request: NextRequest, context: { params: Promise<{ reference: string }> }) {
  const { reference: rawReference } = await context.params;
  const parsedReference = bookingReferenceSchema.safeParse(rawReference);
  const garage = await getHostGarage().catch(() => null);
  const signature = request.nextUrl.searchParams.get("signature");
  if (!garage || !parsedReference.success || !verifyBookingCalendarSignature(garage.id, parsedReference.data, signature)) return notFound();
  const reference = parsedReference.data;

  const client = createAdminClient();
  const details = client ? await loadBookingNotificationContext(client, garage.id, { reference }).catch(() => null) : null;
  const status = details ? calendarStatus(details.booking.status) : null;
  if (!details || !status) return notFound();

  const calendar = buildBookingCalendar({
    garage,
    reference: details.booking.reference,
    customerName: details.customer.name,
    customerEmail: details.customer.email,
    service: details.service.name,
    vehicle: [formatRegistration(details.vehicle.registration), [details.vehicle.make, details.vehicle.model].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
    appointmentStart: details.booking.startsAt,
    appointmentEnd: details.booking.endsAt,
    timezone: garage.timezone,
    location: details.booking.location,
    sequence: details.calendarSequence,
    status,
    timestamp: details.booking.updatedAt,
  });

  return new Response(calendar, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${reference}.ics"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
