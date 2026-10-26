import type { VehicleDetails } from "@/types/domain";

export interface VehicleLookupProvider {
  lookup(registration: string): Promise<VehicleDetails>;
}

export type VehicleLookupErrorCode = "not_found" | "invalid" | "rate_limited" | "unavailable";

/** The upstream sources the composite provider combines. */
export type VehicleSourceName = "dvla" | "dvsa" | "vdg";

export type VehicleLookupErrorOptions = {
  /** Which source raised the error. */
  source?: VehicleSourceName | "composite";
  /** Upstream HTTP status, when there was one. */
  status?: number;
  /** A documented provider code such as `MOTH-RL-02` or `404`. Never free text from the provider. */
  upstreamCode?: string;
  /** Backoff hint for `rate_limited`: wait at least this long before calling the source again. */
  retryAfterMs?: number;
  /** Composite only: how each source failed. */
  sourceErrors?: Partial<Record<VehicleSourceName, VehicleLookupErrorCode>>;
};

/**
 * A lookup failure. `message` is safe to show a customer and never contains the
 * registration; options carry codes only, never provider free text (which can echo it).
 */
export class VehicleLookupError extends Error {
  readonly source?: VehicleLookupErrorOptions["source"];
  readonly status?: number;
  readonly upstreamCode?: string;
  readonly retryAfterMs?: number;
  readonly sourceErrors?: VehicleLookupErrorOptions["sourceErrors"];

  constructor(
    message: string,
    public readonly code: VehicleLookupErrorCode,
    options: VehicleLookupErrorOptions = {},
  ) {
    super(message);
    this.name = "VehicleLookupError";
    this.source = options.source;
    this.status = options.status;
    this.upstreamCode = options.upstreamCode;
    this.retryAfterMs = options.retryAfterMs;
    this.sourceErrors = options.sourceErrors;
  }
}

export const VEHICLE_LOOKUP_MESSAGES = {
  not_found: "Vehicle not found",
  invalid: "Invalid registration",
  rate_limited: "Too many lookups",
  unavailable: "Vehicle service unavailable",
} as const satisfies Record<VehicleLookupErrorCode, string>;

export function vehicleLookupError(code: VehicleLookupErrorCode, options: VehicleLookupErrorOptions = {}) {
  return new VehicleLookupError(VEHICLE_LOOKUP_MESSAGES[code], code, options);
}
