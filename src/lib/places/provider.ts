import "server-only";

// Google Places (New) for sign-up (P4.4): text search, then place details for the one the owner
// picks. Server only: GOOGLE_PLACES_API_KEY is sent as X-Goog-Api-Key from here and never reaches
// the browser, a log line or an error.
//
// PLACES_PROVIDER:
// - unset: `live` when GOOGLE_PLACES_API_KEY is set; otherwise `mock` outside production and
//   `off` on a Vercel production deployment (the wizard then offers manual entry only).
// - `mock`: the recorded fixtures in ./fixtures.ts, no network. Refused on Vercel production.
// - `live`, `off`.

import { requestJson, type FetchLike } from "@/lib/vehicle/http";
import { PLACE_FIXTURES } from "./fixtures";
import { mapPlaceDetails, mapPlaceSummary } from "./map";
import { isPlaceId, PlacesLookupError, type PlaceDetails, type PlaceSummary, type PlacesProvider, type RawPlace, type RawSearchTextResponse } from "./types";

export type PlacesEnv = Readonly<Record<string, string | undefined>>;
export type PlacesMode = "live" | "mock" | "off";

const API_ROOT = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 6_000;
const MAX_RESULTS = 5;
/** Text Search: id, name and address only (the cheapest fields that identify the garage). */
export const SEARCH_FIELD_MASK = "places.id,places.displayName,places.formattedAddress";
/** Place Details: what the wizard pre-fills. */
export const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "addressComponents",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "websiteUri",
  "regularOpeningHours",
].join(",");

function isProduction(env: PlacesEnv) {
  return env.VERCEL_ENV === "production" && env.PLAYWRIGHT_TEST !== "true";
}

export function resolvePlacesMode(env: PlacesEnv = process.env): PlacesMode {
  const raw = env.PLACES_PROVIDER?.trim().toLowerCase();
  const hasKey = Boolean(env.GOOGLE_PLACES_API_KEY?.trim());
  if (raw === "off") return "off";
  if (raw === "mock") return isProduction(env) ? "off" : "mock";
  if (raw === "live") return hasKey ? "live" : "off";
  if (hasKey) return "live";
  return isProduction(env) ? "off" : "mock";
}

/** Trims and bounds a search typed by the owner; null when there is nothing worth sending. */
export function cleanPlacesQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.replace(/\s+/g, " ").trim().slice(0, 120);
  return query.length >= 3 ? query : null;
}

function failureFor(status: number): PlacesLookupError {
  if (status === 400) return new PlacesLookupError("invalid_request");
  if (status === 404) return new PlacesLookupError("not_found");
  if (status === 429) return new PlacesLookupError("rate_limited");
  return new PlacesLookupError("unavailable");
}

export function createGooglePlacesProvider(apiKey: string, fetchImpl: FetchLike = fetch): PlacesProvider {
  const headers = (fieldMask: string) => ({
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask": fieldMask,
  });
  return {
    mode: "live",
    async search(query) {
      let response;
      try {
        response = await requestJson(fetchImpl, `${API_ROOT}/places:searchText`, {
          method: "POST",
          headers: headers(SEARCH_FIELD_MASK),
          body: JSON.stringify({ textQuery: query, regionCode: "GB", languageCode: "en-GB", pageSize: MAX_RESULTS }),
        }, TIMEOUT_MS);
      } catch {
        throw new PlacesLookupError("unavailable");
      }
      if (!response.ok) throw failureFor(response.status);
      const places = (response.body as RawSearchTextResponse | null)?.places ?? [];
      return places.map(mapPlaceSummary).filter((place): place is PlaceSummary => place !== null).slice(0, MAX_RESULTS);
    },
    async details(placeId) {
      if (!isPlaceId(placeId)) throw new PlacesLookupError("invalid_request");
      let response;
      try {
        response = await requestJson(fetchImpl, `${API_ROOT}/places/${encodeURIComponent(placeId)}?languageCode=en-GB&regionCode=GB`, {
          method: "GET",
          headers: headers(DETAILS_FIELD_MASK),
        }, TIMEOUT_MS);
      } catch {
        throw new PlacesLookupError("unavailable");
      }
      if (!response.ok) throw failureFor(response.status);
      const details = mapPlaceDetails((response.body ?? {}) as RawPlace);
      if (!details) throw new PlacesLookupError("not_found");
      return details;
    },
  };
}

function matches(place: RawPlace, query: string) {
  const haystack = `${place.displayName?.text ?? ""} ${place.formattedAddress ?? ""}`.toLowerCase();
  return query.toLowerCase().split(" ").filter((word) => word.length >= 3).some((word) => haystack.includes(word));
}

/** The recorded fixtures: a search matches any word of three letters or more in the name or address. */
export function createMockPlacesProvider(fixtures: RawPlace[] = PLACE_FIXTURES): PlacesProvider {
  return {
    mode: "mock",
    async search(query) {
      return fixtures
        .filter((place) => matches(place, query))
        .map(mapPlaceSummary)
        .filter((place): place is PlaceSummary => place !== null)
        .slice(0, MAX_RESULTS);
    },
    async details(placeId): Promise<PlaceDetails> {
      const place = fixtures.find((candidate) => candidate.id === placeId);
      const details = place ? mapPlaceDetails(place) : null;
      if (!details) throw new PlacesLookupError("not_found");
      return details;
    },
  };
}

/** The provider for this deployment, or null when lookups are off (manual entry only). */
export function getPlacesProvider(env: PlacesEnv = process.env): PlacesProvider | null {
  const mode = resolvePlacesMode(env);
  if (mode === "live") return createGooglePlacesProvider(env.GOOGLE_PLACES_API_KEY!.trim());
  if (mode === "mock") return createMockPlacesProvider();
  return null;
}
