import { NextRequest } from "next/server";
import { buildBookingCalendar, verifyBookingCalendarSignature } from "@/lib/bookings/calendar";
import { getBookingCalendarNotification } from "@/lib/bookings/repository";
import { bookingReferenceSchema } from "@/lib/bookings/schema";
import { getHostGarage } from "@/lib/tenancy/garage";
import { formatRegistration } from "@/lib/vehicle/registration-format";

function notFound() {
  return new Response("Calendar not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest, context: { params: Promise<{ reference: string }> }) {
  const { reference: rawReference } = await context.params;
  const parsedReference = bookingReferenceSchema.safeParse(rawReference);
  // The link is served from the garage's own host; the signature binds garage and reference.
  const garage = await getHostGarage().catch(() => null);
  const signature = request.nextUrl.searchParams.get("signature");
  if (!garage || !parsedReference.success || !verifyBookingCalendarSignature(garage.id, parsedReference.data, signature)) return notFound();
  const reference = parsedReference.data;

  const booking = await getBookingCalendarNotification(garage, reference);
  if (!booking) return notFound();
  const details = booking.details;
  const calendar = buildBookingCalendar({
    garage,
    reference: details.reference,
    customerName: details.customerName,
    customerEmail: details.customerEmail,
    service: details.service,
    vehicle: [formatRegistration(details.registration), details.vehicleName].filter(Boolean).join(" · "),
    appointmentStart: details.appointmentStart,
    appointmentEnd: details.appointmentEnd!,
    timezone: details.timezone,
    location: details.location,
    sequence: details.calendarSequence,
    status: booking.type,
    timestamp: details.calendarTimestamp,
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
