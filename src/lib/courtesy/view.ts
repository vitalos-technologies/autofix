// P5.8 courtesy cars and collection/delivery: client-safe types, form parsing and the week view
// shaping. Pure and clock-free (the time zone and dates come in). Registrations are only ever
// rendered as plate chips; nothing here builds a URL from one.

import { addDays, localDateKey, startOfLocalDay, weekDates, zonedInstant } from "@/lib/admin/dates";

export const LOAN_STATUSES = ["reserved", "out", "returned", "cancelled"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];
export const LIVE_LOAN_STATUSES: readonly LoanStatus[] = ["reserved", "out"];

export const LEG_KINDS = ["collection", "delivery"] as const;
export type LegKind = (typeof LEG_KINDS)[number];
export type LegStatus = "held" | "unassigned" | "cancelled";

export type CourtesyCar = {
  id: string;
  name: string;
  registration: string;
  active: boolean;
  notes: string | null;
  mileage: number | null;
  fuelEighths: number | null;
  sort: number;
};

export type CourtesyLoan = {
  id: string;
  carId: string;
  bookingId: string;
  startsAt: string;
  endsAt: string;
  status: LoanStatus;
  notes: string | null;
  mileageOut: number | null;
  fuelOut: number | null;
  mileageIn: number | null;
  fuelIn: number | null;
  damageNotes: string | null;
  /** Booking reference and customer, when the booking could be read. */
  reference?: string | null;
  customerName?: string | null;
};

export type CollectionLeg = {
  id: string;
  bookingId: string;
  leg: LegKind;
  status: LegStatus;
  resourceId: string | null;
  resourceName?: string | null;
  startsAt: string;
  endsAt: string;
  postcode: string;
  address: string | null;
  reference?: string | null;
  customerName?: string | null;
};

export type CourtesyRequest = {
  id: string;
  bookingId: string;
  status: "open" | "confirmed" | "declined" | "withdrawn";
  freeAtRequest: boolean;
  createdAt: string;
  reference?: string | null;
  customerName?: string | null;
  startsAt?: string | null;
};

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  reserved: "Reserved",
  out: "Out with customer",
  returned: "Returned",
  cancelled: "Released",
};

export const LEG_LABELS: Record<LegKind, string> = { collection: "Collection", delivery: "Delivery" };

export const MAX_CAR_NAME = 60;
export const MAX_CAR_NOTES = 500;
export const MAX_DAMAGE_NOTES = 1000;
export const MAX_MILEAGE = 2_000_000;

/** Fuel gauge readings in eighths, fullest first, for the check-out / check-in selects. */
export const FUEL_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 8, label: "Full" },
  { value: 7, label: "7/8" },
  { value: 6, label: "3/4" },
  { value: 5, label: "5/8" },
  { value: 4, label: "Half" },
  { value: 3, label: "3/8" },
  { value: 2, label: "1/4" },
  { value: 1, label: "1/8" },
  { value: 0, label: "Empty" },
];

export function fuelLabel(eighths: number | null | undefined): string {
  if (eighths === null || eighths === undefined) return "Not recorded";
  return FUEL_OPTIONS.find((option) => option.value === eighths)?.label ?? "Not recorded";
}

export function formatMiles(miles: number | null | undefined): string {
  if (miles === null || miles === undefined) return "Not recorded";
  return `${new Intl.NumberFormat("en-GB").format(miles)} miles`;
}

// ---------------------------------------------------------------------------------------------
// Forms

type Parsed<Value, Field extends string> = { ok: true; value: Value } | { ok: false; fieldErrors: Partial<Record<Field, string>> };

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Upper case, letters and digits only (as the database stores it). */
export function normaliseCourtesyRegistration(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type CarField = "name" | "registration" | "notes" | "mileage" | "fuel";
export type CarInput = { name: string; registration: string; notes: string | null; mileage: number | null; fuelEighths: number | null };

function parseMileage(raw: string, required: boolean): { value: number | null; error?: string } {
  const cleaned = raw.replace(/[,\s]/g, "").replace(/miles?$/i, "");
  if (!cleaned) return required ? { value: null, error: "Enter the mileage, for example 42,180." } : { value: null };
  if (!/^\d{1,7}$/.test(cleaned) || Number(cleaned) > MAX_MILEAGE) return { value: null, error: "Enter the mileage in whole miles." };
  return { value: Number(cleaned) };
}

function parseFuel(raw: string, required: boolean): { value: number | null; error?: string } {
  if (!raw) return required ? { value: null, error: "Choose how much fuel is in the car." } : { value: null };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 8) return { value: null, error: "Choose how much fuel is in the car." };
  return { value };
}

/** Add / edit a courtesy car (owners and managers). Mileage and fuel are optional here. */
export function parseCarForm(formData: FormData): Parsed<CarInput, CarField> {
  const fieldErrors: Partial<Record<CarField, string>> = {};
  const name = text(formData, "name").replace(/\s+/g, " ");
  if (!name || name.length > MAX_CAR_NAME) fieldErrors.name = `Enter a name of up to ${MAX_CAR_NAME} characters, for example Fiesta.`;
  const registration = normaliseCourtesyRegistration(text(formData, "registration"));
  if (!/^[A-Z0-9]{2,8}$/.test(registration)) fieldErrors.registration = "Enter the car's registration, for example AB12 CDE.";
  const notes = text(formData, "notes");
  if (notes.length > MAX_CAR_NOTES) fieldErrors.notes = `Keep notes to ${MAX_CAR_NOTES} characters.`;
  const mileage = parseMileage(text(formData, "mileage"), false);
  if (mileage.error) fieldErrors.mileage = mileage.error;
  const fuel = parseFuel(text(formData, "fuel"), false);
  if (fuel.error) fieldErrors.fuel = fuel.error;
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, value: { name, registration, notes: notes || null, mileage: mileage.value, fuelEighths: fuel.value } };
}

export type ReadingField = "mileage" | "fuel" | "notes";
export type LoanReading = { mileage: number; fuelEighths: number; notes: string | null };

/** Check out / check in: mileage and fuel are required, notes (damage on return) optional. */
export function parseLoanReading(formData: FormData, maxNotes = MAX_DAMAGE_NOTES): Parsed<LoanReading, ReadingField> {
  const fieldErrors: Partial<Record<ReadingField, string>> = {};
  const mileage = parseMileage(text(formData, "mileage"), true);
  if (mileage.error) fieldErrors.mileage = mileage.error;
  const fuel = parseFuel(text(formData, "fuel"), true);
  if (fuel.error) fieldErrors.fuel = fuel.error;
  const notes = text(formData, "notes");
  if (notes.length > maxNotes) fieldErrors.notes = `Keep notes to ${maxNotes} characters.`;
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, value: { mileage: mileage.value!, fuelEighths: fuel.value!, notes: notes || null } };
}

/**
 * The loan window from the "Add courtesy car" form: both `datetime-local` fields (garage time) or
 * neither (the default: from drop-off to closing that day, worked out in SQL).
 */
export function parseLoanWindow(formData: FormData, timeZone: string): { ok: true; startsAt: string | null; endsAt: string | null } | { ok: false; error: string } {
  const from = text(formData, "from");
  const until = text(formData, "until");
  if (!from && !until) return { ok: true, startsAt: null, endsAt: null };
  const start = from ? zonedInstant(from, timeZone) : null;
  const end = until ? zonedInstant(until, timeZone) : null;
  if (!start || !end) return { ok: false, error: "Enter both the start and the end of the loan, or leave both empty." };
  if (end.getTime() <= start.getTime()) return { ok: false, error: "The loan must end after it starts." };
  if (end.getTime() - start.getTime() > 31 * 86_400_000) return { ok: false, error: "A loan can be at most 31 days." };
  return { ok: true, startsAt: start.toISOString(), endsAt: end.toISOString() };
}

const POSTCODE = /^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/;

/** "dn45aa" → "DN4 5AA", or null. */
export function normaliseCollectionPostcode(value: string): string | null {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  const match = POSTCODE.exec(compact);
  return match ? `${match[1]} ${match[2]}` : null;
}

export type CollectionField = "postcode" | "address";

export function parseCollectionForm(formData: FormData): Parsed<{ postcode: string; address: string | null }, CollectionField> {
  const fieldErrors: Partial<Record<CollectionField, string>> = {};
  const postcode = normaliseCollectionPostcode(text(formData, "collectionPostcode"));
  if (!postcode) fieldErrors.postcode = "Enter the postcode where we collect the car, for example DN4 5AA.";
  const address = text(formData, "collectionAddress").replace(/\s+/g, " ");
  if (!address) fieldErrors.address = "Enter the first line of the address.";
  else if (address.length > 300) fieldErrors.address = "Keep the address to 300 characters.";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, value: { postcode: postcode!, address } };
}

// ---------------------------------------------------------------------------------------------
// Errors from the SQL functions

const ERROR_MESSAGES: Record<string, string> = {
  COURTESY_CAR_UNAVAILABLE: "That car has just been taken for some of that time. Choose another car or another time.",
  COURTESY_CAR_NOT_FOUND: "That car could not be found. It may have been removed in another tab.",
  COURTESY_CAR_STILL_OUT: "That car is still out with another customer. Check it in first.",
  COURTESY_FORBIDDEN: "You don't have permission to do that.",
  BOOKING_NOT_FOUND: "That booking could not be found.",
  BOOKING_NOT_LIVE: "That booking is cancelled or finished, so it can't have a courtesy car or collection.",
  LOAN_NOT_FOUND: "That loan could not be found. It may have been changed in another tab.",
  LOAN_STATE: "That loan has already moved on. Refresh to see where it is.",
  REQUEST_NOT_FOUND: "That request has already been dealt with.",
  INVALID_LOAN: "Some of the values can't be saved. Check them and try again.",
  COLLECTION_NOT_OFFERED: "This service doesn't offer collection and delivery. Switch it on in Services first.",
  OUTSIDE_SERVICE_AREA: "That postcode is outside the area your van covers.",
  INVALID_BOOKING: "That postcode doesn't look right.",
  PLAN_REQUIRED: "Courtesy cars and collection are on Pro. Ask the garage owner to upgrade.",
};

/** The leading code of a database error message (`COURTESY_CAR_UNAVAILABLE`, `PLAN_REQUIRED: courtesy_cars`). */
export function courtesyErrorCode(error: { message?: string | null; code?: string | null } | null | undefined): string | null {
  const match = /^([A-Z][A-Z_]+)\b/.exec(error?.message ?? "");
  if (match && Object.hasOwn(ERROR_MESSAGES, match[1]!)) return match[1]!;
  if (error?.code === "42501") return "COURTESY_FORBIDDEN";
  return null;
}

export function courtesyErrorMessage(code: string | null | undefined): string {
  return (code && ERROR_MESSAGES[code]) || "That could not be saved. Try again.";
}

export const COURTESY_ERROR_KEYS = Object.keys(ERROR_MESSAGES);

/** Flash keys the courtesy actions add to the page they return to (`?courtesy=` / `?courtesyError=`). */
export const COURTESY_DONE_MESSAGES: Record<string, string> = {
  car_added: "Car added. It can be lent straight away.",
  car_saved: "Car saved.",
  car_deleted: "Car deleted.",
  reserved: "Courtesy car reserved.",
  released: "Courtesy car released. It is free again.",
  checked_out: "Checked out. Mileage and fuel are saved.",
  checked_in: "Checked in. The car is free again.",
  declined: "Request declined. Let the customer know.",
  collection_held: "Collection and delivery booked: the van is held for both.",
  collection_partial: "The van is only free for one leg. The other is marked for you to arrange.",
  collection_unassigned: "No van is free then. The legs are marked for you to arrange by phone.",
  collection_released: "Collection and delivery cancelled. The van is free again.",
};

const FORM_ERROR_MESSAGES: Record<string, string> = {
  bad_car: "Check the car's name and registration, then try again.",
  bad_reading: "Enter the mileage in whole miles and choose the fuel level.",
  bad_window: "Enter both the start and the end of the loan (the end after the start), or leave both empty.",
  bad_collection: "Enter the postcode and the first line of the address where we collect the car.",
  in_use: "That car has loans, so it can't be deleted. Switch it off instead: it keeps its history.",
  duplicate_registration: "You already have a courtesy car with that registration.",
  not_allowed: "Only the garage's owners and managers can change the courtesy car list.",
  failed: "That could not be saved. Try again.",
};

export function courtesyFlash(done: unknown, error: unknown): { tone: "success" | "error"; text: string } | null {
  if (typeof error === "string" && error) {
    return { tone: "error", text: FORM_ERROR_MESSAGES[error] ?? courtesyErrorMessage(error) };
  }
  if (typeof done === "string" && COURTESY_DONE_MESSAGES[done]) return { tone: "success", text: COURTESY_DONE_MESSAGES[done]! };
  return null;
}

/** A Postgres tstzrange as PostgREST returns it: `["2026-11-02 09:00:00+00","2026-11-02 17:30:00+00")` → ISO start and end. */
export function parseRange(value: string): { startsAt: string; endsAt: string } {
  const match = /^[[(]"?([^",]+)"?,"?([^")]+)"?[\])]$/.exec(value.trim());
  if (!match) throw new RangeError("Unexpected range");
  return { startsAt: rangeInstant(match[1]!), endsAt: rangeInstant(match[2]!) };
}

/** Postgres timestamptz text (`2026-11-02 09:00:00+00`) → ISO. */
function rangeInstant(value: string): string {
  const iso = value.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) throw new RangeError("Unexpected range bound");
  return instant.toISOString();
}

// ---------------------------------------------------------------------------------------------
// Week view

export type WeekLoan = CourtesyLoan & { continuesBefore: boolean; continuesAfter: boolean };
export type WeekDay = { dateKey: string; loans: WeekLoan[] };
export type CarWeek = { car: CourtesyCar; days: WeekDay[]; busyDays: number; state: "out" | "reserved_today" | "free" | "off" };

/**
 * Cars × the seven local days of the week from `monday`: each day lists the live (or returned) loans
 * that overlap it, in start order. A loan across several days appears on each, flagged as continuing.
 */
export function shapeFleetWeek(
  cars: CourtesyCar[],
  loans: CourtesyLoan[],
  monday: string,
  timeZone: string,
  now: Date,
): CarWeek[] {
  const days = weekDates(monday).map((dateKey) => ({
    dateKey,
    from: startOfLocalDay(dateKey, timeZone).getTime(),
    to: startOfLocalDay(addDays(dateKey, 1), timeZone).getTime(),
  }));
  const shown = loans.filter((loan) => loan.status !== "cancelled").sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const today = localDateKey(now, timeZone);
  return cars.map((car) => {
    const own = shown.filter((loan) => loan.carId === car.id);
    const week = days.map((day) => ({
      dateKey: day.dateKey,
      loans: own
        .filter((loan) => Date.parse(loan.startsAt) < day.to && Date.parse(loan.endsAt) > day.from)
        .map((loan) => ({ ...loan, continuesBefore: Date.parse(loan.startsAt) < day.from, continuesAfter: Date.parse(loan.endsAt) > day.to })),
    }));
    const out = own.some((loan) => loan.status === "out");
    const reservedToday = own.some(
      (loan) => loan.status === "reserved" && localDateKey(loan.startsAt, timeZone) <= today && localDateKey(new Date(Date.parse(loan.endsAt) - 1), timeZone) >= today,
    );
    return {
      car,
      days: week,
      busyDays: week.filter((day) => day.loans.some((loan) => loan.status !== "returned")).length,
      state: !car.active ? "off" : out ? "out" : reservedToday ? "reserved_today" : "free",
    };
  });
}

export const CAR_STATE_LABELS: Record<CarWeek["state"], string> = {
  out: "Out now",
  reserved_today: "Booked today",
  free: "Free today",
  off: "Switched off",
};

/** Booking ids with a live loan (reserved or out): the courtesy-car badge on Today and the Diary. */
export function bookingsWithCourtesyCar(loans: Array<Pick<CourtesyLoan, "bookingId" | "status">>): Set<string> {
  return new Set(loans.filter((loan) => LIVE_LOAN_STATUSES.includes(loan.status)).map((loan) => loan.bookingId));
}

/** The `datetime-local` value of an instant in the garage's zone (`YYYY-MM-DDTHH:MM`). */
export function localInputValue(value: string | Date, timeZone: string): string {
  const instant = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Where `returnTo` may send the browser after a courtesy action: the page itself or one booking. */
export function safeCourtesyReturn(value: FormDataEntryValue | null): string {
  const raw = typeof value === "string" ? value : "";
  if (/^\/app\/bookings\/[0-9a-f-]{36}$/i.test(raw)) return raw;
  if (/^\/app\/courtesy-cars(\?week=\d{4}-\d{2}-\d{2})?$/.test(raw)) return raw;
  return "/app/courtesy-cars";
}

/** `returnTo` with a flash (`done` or `error`) added, keeping `?week=`; booking pages get a `#courtesy` anchor. */
export function withFlash(returnTo: string, kind: "done" | "error", key: string): string {
  const [path, query = ""] = returnTo.split("?");
  const params = new URLSearchParams(query);
  params.set(kind === "done" ? "courtesy" : "courtesyError", key);
  const anchor = path!.startsWith("/app/bookings/") ? "#courtesy" : "";
  return `${path}?${params.toString()}${anchor}`;
}
