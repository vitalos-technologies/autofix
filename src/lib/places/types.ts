/**
 * Google Places (New) shapes used by sign-up (P4.4), and what sign-up keeps from them.
 * Client-safe types only: the API key and the HTTP client stay in `./provider.ts`.
 */

/** One search result the owner can pick. */
export type PlaceSummary = {
  id: string;
  name: string;
  address: string;
};

export type PlaceOpeningWindow = {
  /** ISO weekday, 1 = Monday … 7 = Sunday (as `opening_hours.weekday`). */
  weekday: number;
  /** `HH:MM` */
  opens: string;
  /** `HH:MM`, after `opens` on the same day. */
  closes: string;
};

/** What the wizard pre-fills from a picked place. Every field may be missing. */
export type PlaceDetails = {
  id: string;
  name: string;
  /** E.164, e.g. `+441632960123`. */
  phone: string | null;
  website: string | null;
  address: { line1: string; line2: string; town: string; postcode: string };
  /** Same-day windows only; overnight and 24-hour periods are left out. */
  openingHours: PlaceOpeningWindow[];
  /** The place's own one-line address, for display. */
  formattedAddress: string;
};

// --- Raw Places API (New) JSON (only the fields we ask for in the field masks) ---

export type RawLocalizedText = { text?: string; languageCode?: string };

export type RawAddressComponent = { longText?: string; shortText?: string; types?: string[] };

export type RawPeriodPoint = { day?: number; hour?: number; minute?: number };

export type RawPlace = {
  id?: string;
  displayName?: RawLocalizedText;
  formattedAddress?: string;
  shortFormattedAddress?: string;
  addressComponents?: RawAddressComponent[];
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { periods?: Array<{ open?: RawPeriodPoint; close?: RawPeriodPoint }> };
  businessStatus?: string;
};

export type RawSearchTextResponse = { places?: RawPlace[] };

export type PlacesErrorCode = "not_configured" | "invalid_request" | "not_found" | "rate_limited" | "unavailable";

export class PlacesLookupError extends Error {
  constructor(readonly code: PlacesErrorCode) {
    super(`places_${code}`);
    this.name = "PlacesLookupError";
  }
}

export interface PlacesProvider {
  readonly mode: "live" | "mock";
  search(query: string): Promise<PlaceSummary[]>;
  details(placeId: string): Promise<PlaceDetails>;
}

/** Google place ids are URL-safe base64-like strings. */
export function isPlaceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,300}$/.test(value);
}
