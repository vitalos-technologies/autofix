import { getBookingEngine } from "@/lib/booking-engine";
import { bookingErrorMessages } from "@/lib/booking-engine/errors";
import { errorResponse, jsonResponse } from "@/lib/booking-engine/http";
import { resolveRouteGarage } from "@/lib/tenancy/route";

/** Online-bookable services of the host's garage (MOT only when the garage has it switched on). */
export async function GET() {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;
  try {
    const services = await getBookingEngine().listOnlineServices(garage.id);
    return jsonResponse({ services });
  } catch {
    return errorResponse(503, "UNAVAILABLE", bookingErrorMessages.UNAVAILABLE);
  }
}
