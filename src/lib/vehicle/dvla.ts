import "server-only";

// DVLA Vehicle Enquiry Service (VES) client.
//
// Docs read 26 Oct 2026:
// - Guide: https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/vehicle-enquiry-service-description.html
// - OpenAPI v1.2.0: https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/v1.2.0-vehicle-enquiry-service.json
// - Test VRNs: https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/mock-responses.html
// - Common errors: https://developer-portal.driver-vehicle-licensing.api.gov.uk/commonerrors.html
//
// POST {base}/v1/vehicles with `x-api-key` (the only auth), optional
// `X-Correlation-Id`, JSON body {"registrationNumber": "AB12CDE"} (no spaces or
// other non-alphanumerics). Live base https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry,
// test base https://uat.driver-vehicle-licensing.api.gov.uk/vehicle-enquiry (UAT access on request;
// test VRNs such as AA19AAA, ER19NFD = 404, ER19THR = 429).
// 200: Vehicle (registrationNumber, make, colour, fuelType, yearOfManufacture,
// engineCapacity, taxStatus, taxDueDate, motStatus, motExpiryDate, ...).
// motStatus is one of "No details held by DVLA" | "No results returned" | "Not valid" | "Valid";
// taxStatus is one of "Not Taxed for on Road Use" | "SORN" | "Taxed" | "Untaxed".
// Dates may be "" (seen in UAT), which we treat as absent.
// Errors: 400 / 404 / 500 {errors: [{status, code, title, detail}]}, 503 a bare array,
// 403 {message} for a bad key, 429 {message: "Too Many Requests"} (client usage
// plan) or {message: "null"} (collective limit), 502 / 504 from the gateway.
// Throttling is per second by usage plan; no numbers or Retry-After are published,
// so a 429 cools this client down for one second unless Retry-After says otherwise.
// Note (26 Oct 2026): the guide says DVLA is "currently not accepting new VES API
// registrations while we make some system upgrades".
//
// Only identity, MOT and tax fields are kept. Keeper, V5C, export and emissions
// details are discarded at normalisation.

import { titleCase } from "@/lib/utils";
import type { VehicleDetails } from "@/types/domain";
import { Cooldown, isRecord, parseRetryAfterMs, requestJson, stringField, type FetchLike } from "./http";
import { toIsoDate, toStatusLabel } from "./mot";
import { vehicleLookupError, type VehicleLookupProvider } from "./provider";
import { normalizeRegistration } from "./registration-format";

export const DVLA_VES_BASE_URLS = {
  live: "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry",
  uat: "https://uat.driver-vehicle-licensing.api.gov.uk/vehicle-enquiry",
} as const;

export type DvlaEnvironment = keyof typeof DVLA_VES_BASE_URLS;

type DvlaResponse = {
  registrationNumber?: string;
  make?: string;
  yearOfManufacture?: number;
  colour?: string;
  fuelType?: string;
  engineCapacity?: number;
  taxStatus?: string;
  taxDueDate?: string;
  motStatus?: string;
  motExpiryDate?: string;
  [key: string]: unknown;
};

export function normalizeDvlaVehicle(response: DvlaResponse, registration: string): VehicleDetails {
  // Select vehicle identity, MOT and tax fields only. Other upstream data
  // (keeper, V5C, export and emissions details) is discarded here.
  return {
    registration,
    make: titleCase(stringField(response.make)),
    year: positiveInteger(response.yearOfManufacture),
    colour: titleCase(stringField(response.colour)),
    fuelType: titleCase(stringField(response.fuelType)),
    engineCapacityCc: positiveInteger(response.engineCapacity),
    motStatus: toStatusLabel(response.motStatus),
    motExpiry: toIsoDate(response.motExpiryDate),
    taxStatus: toStatusLabel(response.taxStatus),
    taxDueDate: toIsoDate(response.taxDueDate),
  };
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** DVLA reference codes are short numbers ("105", "404"); anything else is dropped. */
function dvlaErrorCode(body: unknown): string | undefined {
  const errors = isRecord(body) ? body.errors : Array.isArray(body) ? body : undefined;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  const code = isRecord(first) ? first.code : undefined;
  const text = typeof code === "number" ? String(code) : typeof code === "string" ? code.trim() : "";
  return /^\d{1,4}$/.test(text) ? text : undefined;
}

const REGISTRATION = /^[A-Z0-9]{2,8}$/;
const RATE_LIMIT_COOLDOWN_MS = 1000;

export type DvlaClientOptions = {
  apiKey: string;
  /** `live` (default) or `uat` (DVLA's test environment with test VRNs). */
  environment?: DvlaEnvironment;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  correlationId?: () => string;
};

export class DvlaProvider implements VehicleLookupProvider {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly correlationId: () => string;
  private readonly cooldown: Cooldown;

  constructor(options: DvlaClientOptions) {
    if (!options.apiKey) throw new Error("DVLA VES configuration required: DVLA_VES_API_KEY is not set.");
    this.apiKey = options.apiKey;
    this.endpoint = `${DVLA_VES_BASE_URLS[options.environment ?? "live"]}/v1/vehicles`;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 6500;
    this.now = options.now ?? Date.now;
    this.correlationId = options.correlationId ?? (() => crypto.randomUUID());
    this.cooldown = new Cooldown(this.now);
  }

  async lookup(input: string): Promise<VehicleDetails> {
    const registration = normalizeRegistration(input);
    if (!REGISTRATION.test(registration)) throw vehicleLookupError("invalid", { source: "dvla" });

    const waitMs = this.cooldown.remainingMs();
    if (waitMs > 0) throw vehicleLookupError("rate_limited", { source: "dvla", retryAfterMs: waitMs });

    let response;
    try {
      response = await requestJson(this.fetchImpl, this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "X-Correlation-Id": this.correlationId(),
        },
        body: JSON.stringify({ registrationNumber: registration }),
      }, this.timeoutMs);
    } catch {
      // Timeout or network failure. The original error is dropped on purpose.
      throw vehicleLookupError("unavailable", { source: "dvla" });
    }

    const { status, body } = response;
    const upstreamCode = dvlaErrorCode(body);
    if (status === 200) {
      if (!isRecord(body)) throw vehicleLookupError("unavailable", { source: "dvla", status });
      return normalizeDvlaVehicle(body as DvlaResponse, registration);
    }
    if (status === 404) throw vehicleLookupError("not_found", { source: "dvla", status, upstreamCode });
    if (status === 400) throw vehicleLookupError("invalid", { source: "dvla", status, upstreamCode });
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), this.now()) ?? RATE_LIMIT_COOLDOWN_MS;
      this.cooldown.extend(retryAfterMs);
      throw vehicleLookupError("rate_limited", { source: "dvla", status, retryAfterMs });
    }
    // 403 is a rejected key; 5xx and anything else is an upstream problem.
    throw vehicleLookupError("unavailable", { source: "dvla", status, upstreamCode });
  }
}
