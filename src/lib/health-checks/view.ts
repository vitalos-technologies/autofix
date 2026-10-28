// Row shapes from Supabase → health check views (P5.3). Pure, so it is unit tested and shared by
// the admin pages and the customer page.

import {
  HEALTH_CHECK_RATINGS,
  HEALTH_CHECK_SECTIONS,
  HEALTH_CHECK_STATUSES,
  DECISIONS,
  type ChecklistItem,
  type HealthCheckDecision,
  type HealthCheckRating,
  type HealthCheckSection,
  type HealthCheckStatus,
  type MediaKind,
} from "./checklist";

export const HEALTH_CHECK_SELECT =
  "id,booking_id,status,summary,mileage,sent_at,sent_count,sent_channel,first_viewed_at,responded_at,approved_total_pence,invoice_id,invoiced_at,token_expires_at,created_at,updated_at," +
  "bookings(reference,starts_at,status,customers(name,channel,opted_out_at),vehicles(registration,make,model),services(name))";
export const HEALTH_CHECK_ITEM_SELECT = "id,section,label,position,mot_related,rating,note,recommended_work,price_pence,decision";
export const HEALTH_CHECK_MEDIA_SELECT = "id,item_id,object_path,content_type,size_bytes,kind,created_at";

type One<T> = T | T[] | null | undefined;
function one<T>(value: One<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export type HealthCheckRow = {
  id: string;
  booking_id: string;
  status: string;
  summary: string | null;
  mileage: number | null;
  sent_at: string | null;
  sent_count: number | null;
  sent_channel: string | null;
  first_viewed_at: string | null;
  responded_at: string | null;
  approved_total_pence: number | string | null;
  invoice_id: string | null;
  invoiced_at: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
  bookings?: One<{
    reference: string;
    starts_at: string;
    status: string;
    customers?: One<{ name: string | null; channel: string | null; opted_out_at: string | null }>;
    vehicles?: One<{ registration: string | null; make: string | null; model: string | null }>;
    services?: One<{ name: string | null }>;
  }>;
};

export type HealthCheckItemRow = {
  id: string;
  section: string;
  label: string;
  position: number;
  mot_related: boolean;
  rating: string;
  note: string | null;
  recommended_work: string | null;
  price_pence: number | string | null;
  decision: string | null;
};

export type HealthCheckMediaRow = {
  id: string;
  item_id: string | null;
  object_path: string;
  content_type: string;
  size_bytes: number | string;
  kind: string;
  created_at: string;
};

export type HealthCheckSummary = {
  id: string;
  bookingId: string;
  status: HealthCheckStatus;
  summary: string | null;
  mileage: number | null;
  sentAt: string | null;
  sentCount: number;
  sentChannel: string | null;
  firstViewedAt: string | null;
  respondedAt: string | null;
  approvedTotalPence: number;
  invoiceId: string | null;
  invoicedAt: string | null;
  linkExpiresAt: string | null;
  updatedAt: string;
  reference: string | null;
  startsAt: string | null;
  bookingStatus: string | null;
  customerName: string | null;
  customerChannel: string | null;
  customerOptedOut: boolean;
  registration: string | null;
  vehicleName: string | null;
  serviceName: string | null;
};

export type HealthCheckMedia = {
  id: string;
  itemId: string | null;
  kind: MediaKind;
  contentType: string;
  sizeBytes: number;
  objectPath: string;
  /** Short-lived signed URL, when one could be made. */
  url: string | null;
};

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function toHealthCheckSummary(row: HealthCheckRow): HealthCheckSummary {
  const booking = one(row.bookings);
  const customer = one(booking?.customers);
  const vehicle = one(booking?.vehicles);
  const service = one(booking?.services);
  const vehicleName = [vehicle?.make, vehicle?.model].filter((part) => part && part.trim()).join(" ") || null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    status: oneOf(HEALTH_CHECK_STATUSES, row.status, "draft"),
    summary: row.summary,
    mileage: row.mileage,
    sentAt: row.sent_at,
    sentCount: row.sent_count ?? 0,
    sentChannel: row.sent_channel,
    firstViewedAt: row.first_viewed_at,
    respondedAt: row.responded_at,
    approvedTotalPence: toNumber(row.approved_total_pence) ?? 0,
    invoiceId: row.invoice_id,
    invoicedAt: row.invoiced_at,
    linkExpiresAt: row.token_expires_at,
    updatedAt: row.updated_at,
    reference: booking?.reference ?? null,
    startsAt: booking?.starts_at ?? null,
    bookingStatus: booking?.status ?? null,
    customerName: customer?.name ?? null,
    customerChannel: customer?.channel ?? null,
    customerOptedOut: Boolean(customer?.opted_out_at),
    registration: vehicle?.registration ?? null,
    vehicleName,
    serviceName: service?.name ?? null,
  };
}

export function toChecklistItem(row: HealthCheckItemRow): ChecklistItem {
  return {
    id: row.id,
    section: oneOf<HealthCheckSection>(HEALTH_CHECK_SECTIONS, row.section, "other"),
    label: row.label,
    position: row.position,
    motRelated: row.mot_related,
    rating: oneOf<HealthCheckRating>(HEALTH_CHECK_RATINGS, row.rating, "not_checked"),
    note: row.note,
    recommendedWork: row.recommended_work,
    pricePence: toNumber(row.price_pence),
    decision: row.decision === null ? null : oneOf<HealthCheckDecision>(DECISIONS, row.decision, "declined"),
  };
}

export function toHealthCheckMedia(row: HealthCheckMediaRow, url: string | null): HealthCheckMedia {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind === "video" ? "video" : "image",
    contentType: row.content_type,
    sizeBytes: toNumber(row.size_bytes) ?? 0,
    objectPath: row.object_path,
    url,
  };
}

/** Media keyed by item ("check" for media on the whole check). */
export function mediaByItem(media: readonly HealthCheckMedia[]): Map<string, HealthCheckMedia[]> {
  const map = new Map<string, HealthCheckMedia[]>();
  for (const entry of media) {
    const key = entry.itemId ?? "check";
    map.set(key, [...(map.get(key) ?? []), entry]);
  }
  return map;
}

/** One line for the admin list and the booking page: where the check stands. */
export function healthCheckStatusLine(check: Pick<HealthCheckSummary, "status" | "approvedTotalPence" | "firstViewedAt">, formatPounds: (pence: number) => string): string {
  if (check.status === "responded") return check.approvedTotalPence > 0 ? `Customer approved ${formatPounds(check.approvedTotalPence)}` : "Customer answered: no extra work approved";
  if (check.status === "sent") return check.firstViewedAt ? "Customer has opened it" : "Sent, not opened yet";
  return "Being checked";
}
