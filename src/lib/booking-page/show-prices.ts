// "Show prices on my booking page" (Temitope, 29 Oct 2026): `garages.settings.showPrices`, written only by
// set_booking_page_settings(p_show_prices) (20261029003100_booking_page_show_prices.sql). Pure and client-safe.
//
// Off hides service prices wherever the booking site lists services (the service step and GET /api/services).
// Booking confirmations, the manage page and booking emails and texts carry no service price at all. Amounts the
// customer pays or agrees to always show: deposits (P5.4), payment links, service plan Direct Debits and health
// check approvals.

/** Absent (or anything but `false`) means prices show, so garages that never chose keep today's page. */
export function showPricesFromSettings(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return true;
  return (settings as Record<string, unknown>).showPrices !== false;
}

/** Whether this garage's booking site shows service prices. */
export function garageShowsPrices(garage: { showPrices?: boolean }): boolean {
  return garage.showPrices !== false;
}

/** A service as the public sees it: without `pricePence` and `priceMode` when the garage hides prices. */
export function publicServicePrice<Service extends { pricePence: number | null; priceMode: string }>(
  service: Service,
  showPrices: boolean,
): Service | Omit<Service, "pricePence" | "priceMode"> {
  if (showPrices) return service;
  const rest: Record<string, unknown> = { ...service };
  delete rest.pricePence;
  delete rest.priceMode;
  return rest as Omit<Service, "pricePence" | "priceMode">;
}
