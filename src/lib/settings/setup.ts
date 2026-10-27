/**
 * Setup (P3.4): validation for Services & prices, Opening hours & closures, Bays & vans and Branding.
 * Client-safe: the forms use the same rules for hints, the server actions for the real check.
 * The rules mirror the checks in supabase/migrations/20261027000100_scheduling.sql and the
 * `garages` constraints, so a value that passes here is accepted by the database.
 */
import { bookingAccent, normaliseAccent } from "@/lib/branding/accent";
import type { GarageRole } from "@/lib/tenancy/admin";

// ---------------------------------------------------------------------------
// Roles (the same split as the RLS policies)
// ---------------------------------------------------------------------------

/** Services, opening hours, closures and resources: owners and managers (technicians read only). */
export function canManageSetup(role: GarageRole | null | undefined): boolean {
  return role === "owner" || role === "manager";
}

/** Garage-level settings (booking rules, branding, MOT): owners only ("owners update the selected garage"). */
export function canChangeGarage(role: GarageRole | null | undefined): boolean {
  return role === "owner";
}

// ---------------------------------------------------------------------------
// Form state shared by every setup form
// ---------------------------------------------------------------------------

export type SetupFormState<Field extends string = string> = {
  /** Increments on every response, so the form can move focus to a new error. */
  seq: number;
  status: "idle" | "saved" | "error";
  /** Form-level message: a success note or what went wrong. */
  message?: string;
  fieldErrors?: Partial<Record<Field, string>>;
};

export const initialSetupFormState: SetupFormState = { seq: 0, status: "idle" };

type Parsed<Value, Field extends string> =
  | { ok: true; value: Value }
  | { ok: false; fieldErrors: Partial<Record<Field, string>>; message?: string };

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function checked(formData: FormData, name: string): boolean {
  const value = formData.get(name);
  return value === "on" || value === "true" || value === "1";
}

/** A whole number in [min, max], or null. Accepts surrounding spaces only. */
export function parseWholeNumber(value: string, min: number, max: number): number | null {
  if (!/^\d{1,6}$/.test(value.trim())) return null;
  const number = Number.parseInt(value.trim(), 10);
  return number >= min && number <= max ? number : null;
}

// ---------------------------------------------------------------------------
// Services & prices
// ---------------------------------------------------------------------------

export const PRICE_MODES = ["fixed", "from", "quote"] as const;
export type PriceModeValue = (typeof PRICE_MODES)[number];
export const SERVICE_LOCATION_MODES = ["workshop", "mobile", "both"] as const;
export type ServiceLocationValue = (typeof SERVICE_LOCATION_MODES)[number];
/** What a workshop visit takes up. Mobile visits always take a mobile resource. */
export const WORKSHOP_RESOURCE_KINDS = ["bay", "technician"] as const;
export type WorkshopResourceKind = (typeof WORKSHOP_RESOURCE_KINDS)[number];

/** Highest price a service can carry: £100,000. */
export const MAX_PRICE_PENCE = 10_000_000;

export const SERVICE_LIMITS = {
  name: 120,
  description: 600,
  durationMin: [5, 720],
  bufferMin: [0, 240],
  minNoticeH: [0, 720],
  maxDaysAhead: [1, 365],
} as const;

/**
 * `"54.85"`, `"£54.85"`, `"1,200"` or `"£ 49"` → pence. Null when it is not an amount of pounds with
 * at most two decimal places, or is over `MAX_PRICE_PENCE`.
 */
export function parsePounds(input: string): number | null {
  const compact = input.trim().replace(/^£\s*/, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(compact)) return null;
  const [whole = "0", fraction = ""] = compact.replaceAll(",", "").split(".");
  const pence = Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction.padEnd(2, "0") || "0", 10);
  return Number.isSafeInteger(pence) && pence <= MAX_PRICE_PENCE ? pence : null;
}

/** `5485` → `"54.85"`, `4500` → `"45"` (for a price input). */
export function penceToPoundsInput(pence: number | null | undefined): string {
  if (pence === null || pence === undefined || !Number.isFinite(pence)) return "";
  return pence % 100 === 0 ? String(pence / 100) : (pence / 100).toFixed(2);
}

export type ServiceField =
  | "name"
  | "description"
  | "priceMode"
  | "price"
  | "durationMin"
  | "bufferMin"
  | "locationMode"
  | "resourceKind"
  | "minNoticeH"
  | "maxDaysAhead";

/** Columns written for a service (garage_id, sort and deleted_at are set by the action). */
export type ServiceWrite = {
  name: string;
  description: string;
  price_mode: PriceModeValue;
  price_pence: number | null;
  duration_min: number;
  buffer_min: number;
  location_mode: ServiceLocationValue;
  resource_kind: "bay" | "technician" | "mobile";
  online_enabled: boolean;
  needs_approval: boolean;
  min_notice_h: number;
  max_days_ahead: number;
  is_mot: boolean;
};

export type ServiceParseContext = {
  /** `garages.mot_enabled`: the MOT flag is offered (and read) only while MOT is on. */
  motEnabled: boolean;
  /** The service's current `is_mot` when editing; kept as it is while MOT is off. */
  currentIsMot?: boolean;
};

/** Reads and checks the service form. Quote services carry no price; mobile-only services take a mobile resource. */
export function parseServiceForm(formData: FormData, context: ServiceParseContext): Parsed<ServiceWrite, ServiceField> {
  const errors: Partial<Record<ServiceField, string>> = {};
  const name = text(formData, "name").replace(/\s+/g, " ");
  if (!name) errors.name = "Enter the service name.";
  else if (name.length > SERVICE_LIMITS.name) errors.name = `Keep the name to ${SERVICE_LIMITS.name} characters.`;

  const description = text(formData, "description");
  if (description.length > SERVICE_LIMITS.description) errors.description = `Keep the description to ${SERVICE_LIMITS.description} characters.`;

  const priceMode = text(formData, "priceMode") as PriceModeValue;
  let pricePence: number | null = null;
  if (!PRICE_MODES.includes(priceMode)) errors.priceMode = "Choose how the price is shown.";
  else if (priceMode !== "quote") {
    const rawPrice = text(formData, "price");
    pricePence = rawPrice ? parsePounds(rawPrice) : null;
    if (!rawPrice) errors.price = "Enter the price in pounds, for example 54.85.";
    else if (pricePence === null) errors.price = "Enter a price in pounds and pence, for example 54.85 (up to £100,000).";
  }

  const [minDuration, maxDuration] = SERVICE_LIMITS.durationMin;
  const durationMin = parseWholeNumber(text(formData, "durationMin"), minDuration, maxDuration);
  if (durationMin === null) errors.durationMin = `Enter the time it takes in minutes, ${minDuration} to ${maxDuration}.`;

  const [minBuffer, maxBuffer] = SERVICE_LIMITS.bufferMin;
  const rawBuffer = text(formData, "bufferMin");
  const bufferMin = rawBuffer ? parseWholeNumber(rawBuffer, minBuffer, maxBuffer) : 0;
  if (bufferMin === null) errors.bufferMin = `Enter clean-up time in minutes, ${minBuffer} to ${maxBuffer}.`;

  const locationMode = text(formData, "locationMode") as ServiceLocationValue;
  if (!SERVICE_LOCATION_MODES.includes(locationMode)) errors.locationMode = "Choose where the work is done.";

  let resourceKind: ServiceWrite["resource_kind"] = "mobile";
  if (locationMode !== "mobile") {
    const requested = text(formData, "resourceKind") || "bay";
    if (!WORKSHOP_RESOURCE_KINDS.includes(requested as WorkshopResourceKind)) errors.resourceKind = "Choose a bay or a technician.";
    else resourceKind = requested as WorkshopResourceKind;
  }

  const [minNotice, maxNotice] = SERVICE_LIMITS.minNoticeH;
  const minNoticeH = parseWholeNumber(text(formData, "minNoticeH"), minNotice, maxNotice);
  if (minNoticeH === null) errors.minNoticeH = `Enter the notice in hours, ${minNotice} to ${maxNotice}.`;

  const [minAhead, maxAhead] = SERVICE_LIMITS.maxDaysAhead;
  const maxDaysAhead = parseWholeNumber(text(formData, "maxDaysAhead"), minAhead, maxAhead);
  if (maxDaysAhead === null) errors.maxDaysAhead = `Enter how far ahead in days, ${minAhead} to ${maxAhead}.`;

  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: {
      name,
      description,
      price_mode: priceMode,
      price_pence: priceMode === "quote" ? null : pricePence,
      duration_min: durationMin!,
      buffer_min: bufferMin!,
      location_mode: locationMode,
      resource_kind: resourceKind,
      online_enabled: checked(formData, "onlineEnabled"),
      needs_approval: checked(formData, "needsApproval"),
      min_notice_h: minNoticeH!,
      max_days_ahead: maxDaysAhead!,
      is_mot: context.motEnabled ? checked(formData, "isMot") : Boolean(context.currentIsMot),
    },
  };
}

/** Order for a move: the ids with `id` swapped with its neighbour, or null when it cannot move that way. */
export function reorderIds(ids: readonly string[], id: string, direction: "up" | "down"): string[] | null {
  const index = ids.indexOf(id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

/** ISO weekdays, Monday first. */
export const WEEKDAYS = [
  { day: 1, name: "Monday", short: "Mon" },
  { day: 2, name: "Tuesday", short: "Tue" },
  { day: 3, name: "Wednesday", short: "Wed" },
  { day: 4, name: "Thursday", short: "Thu" },
  { day: 5, name: "Friday", short: "Fri" },
  { day: 6, name: "Saturday", short: "Sat" },
  { day: 7, name: "Sunday", short: "Sun" },
] as const;

/** Most opening windows one day can have (a split day is two). */
export const MAX_WINDOWS_PER_DAY = 4;

export type OpeningWindow = { weekday: number; opens: string; closes: string };
export type HoursField = `day-${number}`;

/** `"08:00"` or `"08:00:00"` → `"08:00"`; null for anything else. */
export function normaliseTime(value: string): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

function minutesOf(time: string) {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** `"08:00"` → `"8am"`, `"17:30"` → `"5:30pm"`, `"12:00"` → `"12pm"`. */
export function formatClock(time: string): string {
  const total = minutesOf(time);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const suffix = hours < 12 ? "am" : "pm";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return minutes ? `${twelve}:${String(minutes).padStart(2, "0")}${suffix}` : `${twelve}${suffix}`;
}

/**
 * Checks one weekday's windows: each closes after it opens, and none overlap (touching is fine,
 * as in the `opening_hours_no_overlap` constraint). Returns an error message or null.
 */
export function checkDayWindows(dayName: string, windows: ReadonlyArray<{ opens: string; closes: string }>): string | null {
  if (windows.length > MAX_WINDOWS_PER_DAY) return `${dayName} can have up to ${MAX_WINDOWS_PER_DAY} sets of hours.`;
  for (const window of windows) {
    if (minutesOf(window.closes) <= minutesOf(window.opens)) return `On ${dayName}, the closing time must be after the opening time.`;
  }
  const sorted = [...windows].sort((left, right) => minutesOf(left.opens) - minutesOf(right.opens));
  for (let index = 1; index < sorted.length; index += 1) {
    if (minutesOf(sorted[index]!.opens) < minutesOf(sorted[index - 1]!.closes)) {
      return `The hours on ${dayName} overlap. Make each set end before the next one starts.`;
    }
  }
  return null;
}

/**
 * Reads the weekly hours form: for each weekday `opens-<n>` / `closes-<n>` pairs (repeated for a
 * split day). A day with no pairs is closed. Blank pairs are ignored.
 */
export function parseOpeningHoursForm(formData: FormData): Parsed<OpeningWindow[], HoursField> {
  const errors: Partial<Record<HoursField, string>> = {};
  const windows: OpeningWindow[] = [];
  for (const { day, name } of WEEKDAYS) {
    const opens = formData.getAll(`opens-${day}`).map((value) => (typeof value === "string" ? value.trim() : ""));
    const closes = formData.getAll(`closes-${day}`).map((value) => (typeof value === "string" ? value.trim() : ""));
    const dayWindows: Array<{ opens: string; closes: string }> = [];
    for (let index = 0; index < Math.max(opens.length, closes.length); index += 1) {
      const rawOpens = opens[index] ?? "";
      const rawCloses = closes[index] ?? "";
      if (!rawOpens && !rawCloses) continue;
      const open = normaliseTime(rawOpens);
      const close = normaliseTime(rawCloses);
      if (!open || !close) {
        errors[`day-${day}`] = `Enter both an opening and a closing time for ${name}, or remove that row.`;
        break;
      }
      dayWindows.push({ opens: open, closes: close });
    }
    if (errors[`day-${day}`]) continue;
    const problem = checkDayWindows(name, dayWindows);
    if (problem) {
      errors[`day-${day}`] = problem;
      continue;
    }
    windows.push(...dayWindows.sort((left, right) => minutesOf(left.opens) - minutesOf(right.opens)).map((window) => ({ weekday: day, ...window })));
  }
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors, message: "Check the highlighted days." };
  return { ok: true, value: windows };
}

/** Identity of a window for diffing stored rows against the form. */
export function windowKey(window: OpeningWindow): string {
  return `${window.weekday}|${window.opens}|${window.closes}`;
}

/** What to delete and insert to turn `stored` into `wanted` (unchanged windows are left alone). */
export function diffOpeningWindows<Row extends OpeningWindow & { id: string }>(stored: readonly Row[], wanted: readonly OpeningWindow[]) {
  const wantedKeys = new Set(wanted.map(windowKey));
  const storedKeys = new Set(stored.map(windowKey));
  return {
    remove: stored.filter((row) => !wantedKeys.has(windowKey(row))),
    add: wanted.filter((window) => !storedKeys.has(windowKey(window))),
  };
}

// ---------------------------------------------------------------------------
// Closures
// ---------------------------------------------------------------------------

export type ClosureField = "startsOn" | "endsOn" | "reason";
export type ClosureWrite = { starts_on: string; ends_on: string; reason: string | null };
/** Longest closure that can be added in one go. */
export const MAX_CLOSURE_DAYS = 366;
export const MAX_CLOSURE_REASON = 200;

function isRealDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Reads a closure (whole days, inclusive). `today` is the garage's local date (`YYYY-MM-DD`). */
export function parseClosureForm(formData: FormData, today: string): Parsed<ClosureWrite, ClosureField> {
  const errors: Partial<Record<ClosureField, string>> = {};
  const startsOn = text(formData, "startsOn");
  const endsOn = text(formData, "endsOn") || startsOn;
  const reason = text(formData, "reason").replace(/\s+/g, " ");
  if (!isRealDate(startsOn)) errors.startsOn = "Enter the first day you are closed.";
  else if (startsOn < today) errors.startsOn = "Choose today or a later date.";
  if (!errors.startsOn) {
    if (!isRealDate(endsOn)) errors.endsOn = "Enter the last day you are closed.";
    else if (endsOn < startsOn) errors.endsOn = "The last day must be on or after the first day.";
    else if (daysBetween(startsOn, endsOn) >= MAX_CLOSURE_DAYS) errors.endsOn = "Add closures of up to a year at a time.";
  }
  if (reason.length > MAX_CLOSURE_REASON) errors.reason = `Keep the reason to ${MAX_CLOSURE_REASON} characters.`;
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { starts_on: startsOn, ends_on: endsOn, reason: reason || null } };
}

// ---------------------------------------------------------------------------
// Booking rules (garage columns, owners only)
// ---------------------------------------------------------------------------

/** Slot steps offered (the column allows 5 to 120 minutes). */
export const SLOT_STEP_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const;
export const MAX_SERVICE_AREA_DISTRICTS = 200;
const POSTCODE_DISTRICT = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;

export type BookingRulesField = "slotStepMin" | "cancellationCutoffH" | "mobileTravelMin" | "serviceArea";
export type BookingRulesWrite = {
  slot_step_min: number;
  approve_online: boolean;
  cancellation_cutoff_h: number;
  mobile_travel_min: number;
  service_area: string[];
};

/**
 * `"dn1, DN2  dn3"` → `["DN1", "DN2", "DN3"]` (upper case, de-duplicated, in the order given).
 * `invalid` lists entries that are not postcode districts (outward codes such as `DN4` or `S60`):
 * `create_booking()` compares a visit's outward code with this list exactly.
 */
export function parseServiceArea(input: string): { districts: string[]; invalid: string[] } {
  const tokens = input.toUpperCase().split(/[\s,;]+/).map((token) => token.trim()).filter(Boolean);
  const districts: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (!POSTCODE_DISTRICT.test(token)) {
      if (!invalid.includes(token)) invalid.push(token);
    } else if (!districts.includes(token)) districts.push(token);
  }
  return { districts, invalid };
}

export function parseBookingRulesForm(formData: FormData): Parsed<BookingRulesWrite, BookingRulesField> {
  const errors: Partial<Record<BookingRulesField, string>> = {};
  const slotStep = parseWholeNumber(text(formData, "slotStepMin"), 5, 120);
  if (slotStep === null || !SLOT_STEP_OPTIONS.includes(slotStep as (typeof SLOT_STEP_OPTIONS)[number])) {
    errors.slotStepMin = "Choose how often start times are offered.";
  }
  const cutoff = parseWholeNumber(text(formData, "cancellationCutoffH"), 0, 720);
  if (cutoff === null) errors.cancellationCutoffH = "Enter hours from 0 to 720.";
  const travel = parseWholeNumber(text(formData, "mobileTravelMin"), 0, 240);
  if (travel === null) errors.mobileTravelMin = "Enter minutes from 0 to 240.";
  const area = parseServiceArea(text(formData, "serviceArea"));
  if (area.invalid.length) {
    errors.serviceArea = `${area.invalid.slice(0, 5).join(", ")} ${area.invalid.length === 1 ? "is not a postcode district" : "are not postcode districts"}. Use the first half of a postcode, for example DN4.`;
  } else if (area.districts.length > MAX_SERVICE_AREA_DISTRICTS) {
    errors.serviceArea = `List up to ${MAX_SERVICE_AREA_DISTRICTS} districts.`;
  }
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: {
      slot_step_min: slotStep!,
      approve_online: checked(formData, "approveOnline"),
      cancellation_cutoff_h: cutoff!,
      mobile_travel_min: travel!,
      service_area: area.districts,
    },
  };
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const RESOURCE_KINDS = ["bay", "mobile", "technician"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = { bay: "Bay", mobile: "Mobile van", technician: "Technician" };
export const MAX_RESOURCE_NAME = 60;

export type ResourceField = "name" | "kind";

export function parseResourceName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= MAX_RESOURCE_NAME ? name : null;
}

export function parseResourceForm(formData: FormData, { withKind }: { withKind: boolean }): Parsed<{ name: string; kind?: ResourceKind }, ResourceField> {
  const errors: Partial<Record<ResourceField, string>> = {};
  const name = parseResourceName(text(formData, "name"));
  if (!name) errors.name = text(formData, "name") ? `Keep the name to ${MAX_RESOURCE_NAME} characters.` : "Enter a name, for example Bay 4.";
  const kind = text(formData, "kind") as ResourceKind;
  if (withKind && !RESOURCE_KINDS.includes(kind)) errors.kind = "Choose bay, mobile van or technician.";
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  return { ok: true, value: withKind ? { name: name!, kind } : { name: name! } };
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

/** Names for the four palette colours (design/DESIGN.md "Accent options shown in Branding"). */
export const ACCENT_NAMES: Record<string, string> = {
  "#155fba": "Blue",
  "#0f766e": "Teal",
  "#b9451a": "Orange",
  "#6d28d9": "Purple",
};

export type AccentChoice = {
  /** What the owner asked for, as `#rrggbb`. */
  requested: string;
  /** What is stored and used: darkened until white text (and the accent as text) reaches 4.5:1. */
  saved: string;
  adjusted: boolean;
};

/** Validates a hex colour and works out the readable version that is saved. */
export function chooseAccent(input: string): AccentChoice | null {
  const requested = normaliseAccent(input);
  if (!requested) return null;
  const saved = bookingAccent(requested);
  return { requested, saved, adjusted: saved !== requested };
}

/** Largest logo accepted: 1.5 MB. */
export const LOGO_MAX_BYTES = 1_572_864;
export const LOGO_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
export type LogoType = keyof typeof LOGO_TYPES;
export const LOGO_EXTENSIONS: Record<LogoType, string> = { png: "png", jpeg: "jpg", webp: "webp" };

/** The image type from the file's first bytes (not its name or declared type): PNG, JPEG or WebP. */
export function sniffLogoType(bytes: Uint8Array): LogoType | null {
  const starts = (signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpeg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** Storage path for a garage's logo in `public-media` (the folder the storage policies allow). */
export function logoPath(garageId: string, type: LogoType): string {
  return `${garageId}/logo.${LOGO_EXTENSIONS[type]}`;
}
