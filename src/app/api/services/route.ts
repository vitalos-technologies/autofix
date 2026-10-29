import { getBookingEngine } from "@/lib/booking-engine";
import { bookingErrorMessages } from "@/lib/booking-engine/errors";
import { errorResponse, jsonResponse } from "@/lib/booking-engine/http";
import { garageShowsPrices, publicServicePrice } from "@/lib/booking-page/show-prices";
import { resolveRouteGarage } from "@/lib/tenancy/route";

/**
 * Online-bookable services of the host's garage (MOT only when the garage has it switched on). When the
 * garage hides prices on its booking page, the services carry no `pricePence` or `priceMode` and the
 * answer says `pricesHidden: true`.
 */
export async function GET() {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;
  try {
    const services = await getBookingEngine().listOnlineServices(garage.id);
    if (garageShowsPrices(garage)) return jsonResponse({ services });
    return jsonResponse({ services: services.map((service) => publicServicePrice(service, false)), pricesHidden: true });
  } catch {
    return errorResponse(503, "UNAVAILABLE", bookingErrorMessages.UNAVAILABLE);
  }
}
