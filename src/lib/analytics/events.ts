// Booking and enquiry events. No analytics script is loaded since SOB's GA
// marketing tracking was removed in P1.1, so track() is a no-op unless a
// consented analytics integration defines window.gtag again.
export const analyticsEvents = [
  "vehicle_lookup_started", "vehicle_lookup_success", "vehicle_lookup_failed",
  "booking_started", "booking_vehicle_confirmed", "booking_service_selected", "booking_slot_viewed", "booking_completed",
  "quote_submitted", "mobile_mechanic_submitted",
  "inspection_enquiry_submitted", "recovery_enquiry_submitted",
  "phone_clicked", "vehicle_sales_enquiry", "fleet_enquiry_submitted",
] as const;

export type AnalyticsEvent = (typeof analyticsEvents)[number];
type SafeValue = string | number | boolean;

const forbiddenKeys = new Set(["registration", "vehicle", "email", "phone", "postcode", "description", "problem"]);

export function sanitizeAnalyticsProperties(properties: Record<string, SafeValue> = {}) {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !forbiddenKeys.has(key.toLowerCase())));
}

export function track(event: AnalyticsEvent, properties?: Record<string, SafeValue>) {
  if (typeof window === "undefined") return;
  const gtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag;
  gtag?.("event", event, sanitizeAnalyticsProperties(properties));
}
