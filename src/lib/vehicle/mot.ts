import type { VehicleDetails } from "@/types/domain";

// MOT data is shown per garage (garages.mot_enabled, `Garage.motEnabled`).
// SOB's rule that discarded MOT data at the provider boundary does not apply
// to Autofix; customer-facing surfaces pass the host garage's switch.

export const MOT_FIELDS = ["motStatus", "motExpiry"] as const satisfies ReadonlyArray<keyof VehicleDetails>;

/** Normalise a provider date or datetime ("2026-07-01", "2026-07-01T00:00:00") to an ISO date. */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return undefined;
  return `${year}-${month}-${day}`;
}

/** Keep a short provider status label such as "Valid" or "SORN". */
export function toStatusLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 60) : undefined;
}

/** Drop MOT fields unless the garage shows MOT data. */
export function withMotVisibility(vehicle: VehicleDetails, motEnabled: boolean): VehicleDetails {
  if (motEnabled) return vehicle;
  const visible = { ...vehicle };
  for (const field of MOT_FIELDS) delete visible[field];
  return visible;
}

/** "2026-07-01" → "1 July 2026". Date-only values are formatted in UTC so they never shift a day. */
export function formatMotDate(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return isoDate;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
