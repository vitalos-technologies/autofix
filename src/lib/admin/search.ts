/**
 * Admin search ("Search reg, customer or booking ref"). Searches are often a registration, and
 * registrations never go in URLs (CLAUDE.md rule 3): the box posts to a server action, which keeps
 * the term in a short-lived httpOnly cookie on `/app` and sends the browser to `/app/bookings?search=1`.
 * Only the flag is in the address; the list reads the term from the cookie.
 */
import { bookingStatuses, type BookingStatus } from "@/lib/booking-engine/types";
import { parseDateKey } from "@/lib/admin/dates";

export const ADMIN_SEARCH_COOKIE = "af_admin_search";
/** Query flag: apply the search cookie to the bookings list. */
export const SEARCH_FLAG = "search";

export const ADMIN_SEARCH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/app",
  maxAge: 15 * 60,
};

/** A booking reference as `create_booking()` makes them: `HRM-1234` (prefix 2–4 letters, 4–6 digits). */
export function asBookingReference(value: string): string | null {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  return /^[A-Z]{2,4}-\d{4,6}$/.test(compact) ? compact : null;
}

export type BookingListParams = {
  status: BookingStatus | null;
  from: string | null;
  to: string | null;
  page: number;
  searched: boolean;
};

function first(value: string | string[] | undefined | null): string | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

/** The bookings list's query string (status, date range, page, search flag), validated. */
export function parseBookingListParams(params: Record<string, string | string[] | undefined>): BookingListParams {
  const status = first(params.status);
  const from = parseDateKey(first(params.from));
  let to = parseDateKey(first(params.to));
  if (from && to && to < from) to = from;
  const page = Number.parseInt(first(params.page) ?? "1", 10);
  return {
    status: bookingStatuses.includes(status as BookingStatus) ? (status as BookingStatus) : null,
    from,
    to,
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1,
    searched: first(params[SEARCH_FLAG]) === "1",
  };
}

/** `/app/bookings?…` for these filters (never a search term). */
export function bookingListHref(params: Partial<BookingListParams>): string {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.searched) query.set(SEARCH_FLAG, "1");
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const text = query.toString();
  return text ? `/app/bookings?${text}` : "/app/bookings";
}
