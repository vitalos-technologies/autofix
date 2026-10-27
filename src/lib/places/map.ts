/**
 * Maps Places API (New) responses to what sign-up pre-fills. Pure, client-safe, unit tested
 * against the recorded fixtures in `./fixtures.ts`.
 */
import { normaliseUkPostcode } from "@/lib/booking-flow/copy";
import { isE164, toE164UK } from "@/lib/messaging/phone";
import type { PlaceDetails, PlaceOpeningWindow, PlaceSummary, RawAddressComponent, RawPeriodPoint, RawPlace } from "./types";

const MAX_WINDOWS_PER_DAY = 4;

function text(value: string | undefined | null) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function component(components: RawAddressComponent[], type: string) {
  return text(components.find((entry) => entry.types?.includes(type))?.longText);
}

/** `+44 1632 960123` / `01632 960123` → `+441632960123`; null for anything we cannot store. */
export function placePhone(place: Pick<RawPlace, "internationalPhoneNumber" | "nationalPhoneNumber">): string | null {
  const international = (place.internationalPhoneNumber ?? "").replace(/[\s().-]/g, "");
  if (international.startsWith("+44")) return toE164UK(international, { allowLandline: true });
  if (isE164(international)) return international;
  return toE164UK(place.nationalPhoneNumber, { allowLandline: true });
}

/** Only http(s) websites, without tracking parameters Google adds (`utm_*`). */
export function placeWebsite(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    const result = url.toString();
    return result.length <= 300 ? result : null;
  } catch {
    return null;
  }
}

/** Street address from address components: premise/subpremise, then number + street; the locality goes to line 2 when it is not the town. */
export function placeAddress(components: RawAddressComponent[] = [], formatted = ""): PlaceDetails["address"] {
  const street = [component(components, "street_number"), component(components, "route")].filter(Boolean).join(" ");
  const building = [component(components, "subpremise"), component(components, "premise")].filter(Boolean).join(", ");
  const town = component(components, "postal_town") || component(components, "locality");
  const locality = component(components, "sublocality") || component(components, "neighborhood")
    || (component(components, "locality") !== town ? component(components, "locality") : "");
  const postcode = normaliseUkPostcode(component(components, "postal_code")) ?? component(components, "postal_code");
  let line1 = [building, street].filter(Boolean).join(", ");
  if (!line1) line1 = text(formatted.split(",")[0]);
  return { line1: line1.slice(0, 120), line2: locality.slice(0, 120), town: town.slice(0, 120), postcode: postcode.slice(0, 12) };
}

function hhmm(point: RawPeriodPoint) {
  const hour = point.hour ?? 0;
  const minute = point.minute ?? 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Regular opening hours as same-day windows. Google's days are 0 = Sunday … 6 = Saturday; ours are
 * ISO (7 = Sunday). Periods without a close (open 24 hours) or closing on a later day are left out,
 * as are overlapping windows and more than four a day: the owner sets those by hand in Setup.
 */
export function placeOpeningHours(place: Pick<RawPlace, "regularOpeningHours">): PlaceOpeningWindow[] {
  const windows: PlaceOpeningWindow[] = [];
  for (const period of place.regularOpeningHours?.periods ?? []) {
    const { open, close } = period;
    if (!open || !close || open.day === undefined || close.day !== open.day || open.day < 0 || open.day > 6) continue;
    const opens = hhmm(open);
    const closes = hhmm(close);
    if (!opens || !closes || closes <= opens) continue;
    const weekday = open.day === 0 ? 7 : open.day;
    const sameDay = windows.filter((window) => window.weekday === weekday);
    if (sameDay.length >= MAX_WINDOWS_PER_DAY) continue;
    if (sameDay.some((window) => opens < window.closes && window.opens < closes)) continue;
    windows.push({ weekday, opens, closes });
  }
  return windows.sort((a, b) => a.weekday - b.weekday || a.opens.localeCompare(b.opens));
}

export function mapPlaceSummary(place: RawPlace): PlaceSummary | null {
  const id = text(place.id);
  const name = text(place.displayName?.text);
  if (!id || !name) return null;
  return { id, name: name.slice(0, 120), address: text(place.formattedAddress ?? place.shortFormattedAddress).slice(0, 200) };
}

export function mapPlaceDetails(place: RawPlace): PlaceDetails | null {
  const summary = mapPlaceSummary(place);
  if (!summary) return null;
  return {
    id: summary.id,
    name: summary.name,
    phone: placePhone(place),
    website: placeWebsite(place.websiteUri),
    address: placeAddress(place.addressComponents, place.formattedAddress),
    openingHours: placeOpeningHours(place),
    formattedAddress: summary.address,
  };
}

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Mon–Fri 08:00–17:30 · Sat 08:30–13:00" for the wizard's summary; days with the same windows are grouped. */
export function describeOpeningHours(windows: PlaceOpeningWindow[]): string {
  const byDay = new Map<number, string>();
  for (const window of windows) {
    const label = `${window.opens}–${window.closes}`;
    byDay.set(window.weekday, byDay.has(window.weekday) ? `${byDay.get(window.weekday)}, ${label}` : label);
  }
  const groups: Array<{ from: number; to: number; label: string }> = [];
  for (let day = 1; day <= 7; day += 1) {
    const label = byDay.get(day);
    if (!label) continue;
    const last = groups[groups.length - 1];
    if (last && last.label === label && last.to === day - 1) last.to = day;
    else groups.push({ from: day, to: day, label });
  }
  return groups
    .map((group) => `${group.from === group.to ? DAY_SHORT[group.from] : `${DAY_SHORT[group.from]}–${DAY_SHORT[group.to]}`} ${group.label}`)
    .join(" · ");
}
