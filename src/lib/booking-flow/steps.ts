/**
 * The five booking steps and their guards. Pure and client-safe.
 * Each step needs everything chosen on the steps before it; a page whose earlier data is missing
 * sends the customer back to the first incomplete step.
 */
import type { BookingDraft, LocationMode, OnlineService } from "@/lib/booking-engine/types";

export const BOOKING_STEP_PATHS = {
  vehicle: "/",
  service: "/service",
  time: "/time",
  details: "/details",
} as const;

export type BookingStep = keyof typeof BOOKING_STEP_PATHS;

const ORDER: readonly BookingStep[] = ["vehicle", "service", "time", "details"];

/** Where a service can be done: `both` offers the workshop and a mobile visit. */
export function serviceLocationModes(service: Pick<OnlineService, "locationMode">): LocationMode[] {
  if (service.locationMode === "both") return ["workshop", "mobile"];
  return [service.locationMode];
}

/**
 * Services shown on this garage's booking page: MOT services only when the garage has MOT on, and
 * mobile visits only when it lists the postcode districts it covers (`create_booking` rejects every
 * mobile booking otherwise), so a "both" service becomes workshop-only and a mobile-only one is hidden.
 */
export function visibleServices(services: readonly OnlineService[], motEnabled: boolean, mobileOffered = true): OnlineService[] {
  return services
    .filter((service) => motEnabled || !service.isMot)
    .filter((service) => mobileOffered || service.locationMode !== "mobile")
    .map((service) => (!mobileOffered && service.locationMode === "both" ? { ...service, locationMode: "workshop" as const } : service))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "en-GB"));
}

/**
 * The first step whose data is missing or no longer valid, or `null` when the draft is ready to
 * confirm. `services` is the garage's online list (pass `null` when it is not needed yet).
 */
export function firstIncompleteStep(draft: BookingDraft, services: readonly OnlineService[] | null): BookingStep | null {
  if (!draft.vehicle?.registration) return "vehicle";
  if (!draft.serviceId) return "service";
  if (services) {
    const service = services.find((item) => item.id === draft.serviceId);
    if (!service) return "service";
    if (!draft.locationMode || !serviceLocationModes(service).includes(draft.locationMode)) return "service";
  } else if (!draft.locationMode) {
    return "service";
  }
  if (draft.locationMode === "mobile" && !draft.postcode) return "service";
  if (!draft.startsAt) return "time";
  return null;
}

/** For the page of `step`: the path to send the customer to instead, or `null` to render the step. */
export function redirectForStep(step: BookingStep, draft: BookingDraft, services: readonly OnlineService[] | null): string | null {
  const missing = firstIncompleteStep(draft, services);
  if (missing && ORDER.indexOf(missing) < ORDER.indexOf(step)) return BOOKING_STEP_PATHS[missing];
  return null;
}
