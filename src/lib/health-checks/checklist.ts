// Digital health checks (P5.3, Pro feature `health_checks`). Client-safe: the admin editor, the
// customer page and the server share these names, limits and sums. The SQL side
// (supabase/migrations/20261029000300_health_checks.sql) holds the same sections, ratings, media
// limits and default checklist; a unit test compares the default checklist with the migration.

export const HEALTH_CHECK_SECTIONS = ["tyres", "brakes", "lights", "wipers", "fluids", "suspension", "exhaust", "battery", "mot", "other"] as const;
export type HealthCheckSection = (typeof HEALTH_CHECK_SECTIONS)[number];

export const SECTION_LABELS: Record<HealthCheckSection, string> = {
  tyres: "Tyres",
  brakes: "Brakes",
  lights: "Lights",
  wipers: "Wipers and washers",
  fluids: "Fluids",
  suspension: "Suspension and steering",
  exhaust: "Exhaust",
  battery: "Battery",
  mot: "MOT items",
  other: "Other",
};

export const HEALTH_CHECK_RATINGS = ["red", "amber", "green", "not_checked"] as const;
export type HealthCheckRating = (typeof HEALTH_CHECK_RATINGS)[number];

/** What each rating means, in the garage's words and the customer's. */
export const RATING_LABELS: Record<HealthCheckRating, string> = {
  red: "Needs attention now",
  amber: "Needs attention soon",
  green: "OK",
  not_checked: "Not checked",
};

/** Short labels for the admin's rating buttons. */
export const RATING_SHORT_LABELS: Record<HealthCheckRating, string> = { red: "Red", amber: "Amber", green: "Green", not_checked: "Not checked" };

export const HEALTH_CHECK_STATUSES = ["draft", "sent", "responded"] as const;
export type HealthCheckStatus = (typeof HEALTH_CHECK_STATUSES)[number];

export const STATUS_LABELS: Record<HealthCheckStatus, string> = {
  draft: "Being checked",
  sent: "Sent to customer",
  responded: "Customer answered",
};

export const DECISIONS = ["approved", "declined"] as const;
export type HealthCheckDecision = (typeof DECISIONS)[number];

export const LIMITS = {
  note: 1000,
  summary: 1000,
  label: 120,
  work: 300,
  /** £100,000 in pence, as the database check. */
  maxPricePence: 10_000_000,
  maxMileage: 2_000_000,
  mediaPerItem: 6,
  mediaPerCheck: 40,
} as const;

/** Link lifetime: the customer has two weeks to look and decide (A312). */
export const HEALTH_CHECK_LINK_TTL_DAYS = 14;

export const MEDIA_TYPES = {
  "image/jpeg": { kind: "image", extension: "jpg", maxBytes: 10 * 1024 * 1024 },
  "image/png": { kind: "image", extension: "png", maxBytes: 10 * 1024 * 1024 },
  "image/webp": { kind: "image", extension: "webp", maxBytes: 10 * 1024 * 1024 },
  "video/mp4": { kind: "video", extension: "mp4", maxBytes: 50 * 1024 * 1024 },
  "video/quicktime": { kind: "video", extension: "mov", maxBytes: 50 * 1024 * 1024 },
} as const;
export type MediaContentType = keyof typeof MEDIA_TYPES;
export type MediaKind = "image" | "video";

/** The `accept` list for the phone's camera inputs. */
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
export const VIDEO_ACCEPT = "video/mp4,video/quicktime";

export function isMediaContentType(value: unknown): value is MediaContentType {
  return typeof value === "string" && Object.hasOwn(MEDIA_TYPES, value);
}

export type MediaProblem = "type" | "size" | "empty";

/** Why a file can't be added, or null. */
export function mediaProblem(file: { type: string; size: number }): MediaProblem | null {
  if (!isMediaContentType(file.type)) return "type";
  if (!Number.isFinite(file.size) || file.size <= 0) return "empty";
  if (file.size > MEDIA_TYPES[file.type].maxBytes) return "size";
  return null;
}

export const MEDIA_PROBLEM_MESSAGES: Record<MediaProblem, string> = {
  type: "Use a JPEG, PNG or WebP photo, or an MP4 or MOV video.",
  size: "Photos can be up to 10 MB and videos up to 50 MB.",
  empty: "That file is empty.",
};

/** `<garage_id>/health-checks/<check_id>/<uuid>.<ext>` (the storage policy and a table check rely on it). */
export function mediaObjectPath(garageId: string, checkId: string, fileId: string, contentType: MediaContentType): string {
  return `${garageId}/health-checks/${checkId}/${fileId}.${MEDIA_TYPES[contentType].extension}`;
}

/** The default checklist, in order (same as public.health_check_default_items()). MOT lines only with MOT on. */
export const DEFAULT_CHECKLIST: ReadonlyArray<{ section: HealthCheckSection; label: string }> = [
  { section: "tyres", label: "Front left tyre" },
  { section: "tyres", label: "Front right tyre" },
  { section: "tyres", label: "Rear left tyre" },
  { section: "tyres", label: "Rear right tyre" },
  { section: "tyres", label: "Spare wheel or repair kit" },
  { section: "brakes", label: "Front brake pads and discs" },
  { section: "brakes", label: "Rear brakes" },
  { section: "brakes", label: "Brake fluid" },
  { section: "lights", label: "Headlights and sidelights" },
  { section: "lights", label: "Brake lights, indicators and hazards" },
  { section: "wipers", label: "Wiper blades" },
  { section: "wipers", label: "Washer jets and screenwash" },
  { section: "fluids", label: "Engine oil level" },
  { section: "fluids", label: "Coolant level" },
  { section: "fluids", label: "Power steering fluid" },
  { section: "suspension", label: "Shock absorbers" },
  { section: "suspension", label: "Springs, arms and bushes" },
  { section: "suspension", label: "Steering joints and racks" },
  { section: "exhaust", label: "Exhaust system and mounts" },
  { section: "battery", label: "Battery condition" },
  { section: "mot", label: "Seat belts" },
  { section: "mot", label: "Horn" },
  { section: "mot", label: "Number plates" },
  { section: "mot", label: "Windscreen chips and cracks" },
  { section: "mot", label: "Mirrors" },
];

export function defaultChecklist(motEnabled: boolean) {
  return DEFAULT_CHECKLIST.filter((item) => motEnabled || item.section !== "mot");
}

export type ChecklistItem = {
  id: string;
  section: HealthCheckSection;
  label: string;
  position: number;
  motRelated: boolean;
  rating: HealthCheckRating;
  note: string | null;
  recommendedWork: string | null;
  pricePence: number | null;
  decision: HealthCheckDecision | null;
};

/** Lines the customer is asked about: those with priced recommended work. */
export function recommendedItems<T extends Pick<ChecklistItem, "recommendedWork" | "pricePence">>(items: readonly T[]): T[] {
  return items.filter((item) => item.recommendedWork !== null && item.pricePence !== null);
}

/**
 * Lines a garage that turned MOTs off should no longer show: MOT lines with nothing on them
 * (rule 6, MOT is per garage). Lines a technician already rated stay, as a record.
 */
export function visibleItems<T extends Pick<ChecklistItem, "motRelated" | "rating" | "recommendedWork">>(items: readonly T[], motEnabled: boolean): T[] {
  return items.filter((item) => motEnabled || !item.motRelated || item.rating !== "not_checked" || item.recommendedWork !== null);
}

/** Items grouped by section in checklist order (sections without lines left out). */
export function groupBySection<T extends Pick<ChecklistItem, "section" | "position">>(items: readonly T[]): Array<{ section: HealthCheckSection; label: string; items: T[] }> {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  return HEALTH_CHECK_SECTIONS.map((section) => ({ section, label: SECTION_LABELS[section], items: sorted.filter((item) => item.section === section) })).filter(
    (group) => group.items.length > 0,
  );
}

export type RatingCounts = Record<HealthCheckRating, number>;

export function ratingCounts(items: ReadonlyArray<Pick<ChecklistItem, "rating">>): RatingCounts {
  const counts: RatingCounts = { red: 0, amber: 0, green: 0, not_checked: 0 };
  for (const item of items) counts[item.rating] += 1;
  return counts;
}

/** Sum of the approved lines (pence). `choices` overrides stored decisions (the customer's form before confirming). */
export function approvedTotalPence(
  items: ReadonlyArray<Pick<ChecklistItem, "id" | "pricePence" | "decision" | "recommendedWork">>,
  choices?: Readonly<Record<string, HealthCheckDecision | undefined>>,
): number {
  let total = 0;
  for (const item of recommendedItems(items)) {
    const decision = choices ? choices[item.id] : item.decision;
    if (decision === "approved") total += item.pricePence ?? 0;
  }
  return total;
}

/** `£1,234.50` from pence. */
export function formatPounds(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(pence));
  const pounds = Math.floor(absolute / 100).toLocaleString("en-GB");
  return `${sign}£${pounds}.${String(absolute % 100).padStart(2, "0")}`;
}

/** Parses "£12.50" / "12.5" / "12" into pence; null when it isn't a price up to £100,000. */
export function parsePriceInput(input: string): number | null {
  const normalized = input.trim().replace(/^£/, "").replaceAll(",", "");
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const pence = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return pence <= LIMITS.maxPricePence ? pence : null;
}

export function penceToInput(pence: number | null): string {
  if (pence === null) return "";
  return `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, "0")}`;
}
