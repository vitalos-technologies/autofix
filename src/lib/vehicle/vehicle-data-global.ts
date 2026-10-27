// Vehicle Data Global (UK) lookup client: SOB's original provider, now the
// paid fallback in the composite provider (called only when make or model is
// still missing after DVLA and DVSA).
//
// Docs: Vehicle Data Global's API reference sits behind the customer portal
// (https://portal.vehicledataglobal.com/). https://vehicledataglobal.com/ was
// checked on 26 Oct 2026 and publishes no public reference, so this client keeps
// SOB's production integration: GET {base}/r2/lookup with ApiKey, PackageName
// and Vrm query parameters; envelope ResponseInformation.{StatusCode,
// StatusMessage, IsSuccessStatusCode}; data in Results.VehicleDetails and
// Results.ModelDetails. The upstream URL carries the key and plate, so it is
// never logged and fetch errors are replaced, not rethrown.

import { titleCase } from "@/lib/utils";
import type { VehicleDetails } from "@/types/domain";
import { toIsoDate } from "./mot";
import { vehicleLookupError, VehicleLookupError, type VehicleLookupProvider } from "./provider";

type VehicleDataGlobalResponse = {
  ResponseInformation?: {
    StatusCode?: number;
    StatusMessage?: string;
    IsSuccessStatusCode?: boolean;
  };
  Results?: {
    VehicleDetails?: {
      VehicleIdentification?: {
        Vrm?: string;
        DvlaMake?: string;
        DvlaModel?: string;
        YearOfManufacture?: number;
        DvlaBodyType?: string;
        DvlaFuelType?: string;
      };
      VehicleHistory?: { ColourDetails?: { CurrentColour?: string } };
      DvlaTechnicalDetails?: { EngineCapacityCc?: number };
      StatusCode?: number;
      StatusMessage?: string;
    };
    ModelDetails?: {
      ModelIdentification?: { Make?: string; Model?: string; ModelVariant?: string };
      BodyDetails?: { BodyStyle?: string; BodyShape?: string };
      Powertrain?: {
        FuelType?: string;
        Transmission?: { TransmissionType?: string };
      };
    };
    // Present when the configured package includes MOT history
    // (e.g. "VehicleAndMotHistory"). Confirm the shape against a recorded
    // fixture when the composite provider lands (P3.5).
    MotHistoryDetails?: {
      MotDueDate?: string;
    };
  };
};

export function normalizeVehicleDataGlobal(response: VehicleDataGlobalResponse, registration: string): VehicleDetails {
  const identity = response.Results?.VehicleDetails?.VehicleIdentification;
  const history = response.Results?.VehicleDetails?.VehicleHistory;
  const technical = response.Results?.VehicleDetails?.DvlaTechnicalDetails;
  const model = response.Results?.ModelDetails?.ModelIdentification;
  const body = response.Results?.ModelDetails?.BodyDetails;
  const powertrain = response.Results?.ModelDetails?.Powertrain;
  const motHistory = response.Results?.MotHistoryDetails;

  return {
    registration: identity?.Vrm || registration,
    make: titleCase(model?.Make || identity?.DvlaMake),
    model: titleCase(model?.Model || identity?.DvlaModel),
    derivative: titleCase(model?.ModelVariant),
    year: identity?.YearOfManufacture,
    colour: titleCase(history?.ColourDetails?.CurrentColour),
    fuelType: titleCase(powertrain?.FuelType || identity?.DvlaFuelType),
    transmission: titleCase(powertrain?.Transmission?.TransmissionType),
    engineCapacityCc: technical?.EngineCapacityCc,
    bodyType: titleCase(body?.BodyStyle || body?.BodyShape || identity?.DvlaBodyType),
    motExpiry: toIsoDate(motHistory?.MotDueDate),
  };
}

export class VehicleDataGlobalProvider implements VehicleLookupProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly packageName: string,
    private readonly timeoutMs = 6500,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async lookup(registration: string): Promise<VehicleDetails> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = new URL("/r2/lookup", this.baseUrl);
      url.searchParams.set("ApiKey", this.apiKey);
      url.searchParams.set("PackageName", this.packageName);
      url.searchParams.set("Vrm", registration);

      const response = await this.fetchImpl(url, { method: "GET", signal: controller.signal, cache: "no-store" });
      const httpStatus = response.status;
      if (httpStatus === 404) throw vehicleLookupError("not_found", { source: "vdg", status: httpStatus });
      if (httpStatus === 400) throw vehicleLookupError("invalid", { source: "vdg", status: httpStatus });
      if (httpStatus === 429) throw vehicleLookupError("rate_limited", { source: "vdg", status: httpStatus });
      if (!response.ok) throw vehicleLookupError("unavailable", { source: "vdg", status: httpStatus });

      const payload = await response.json() as VehicleDataGlobalResponse;
      const status = payload.ResponseInformation;
      const vehicleStatus = payload.Results?.VehicleDetails;
      if (!status?.IsSuccessStatusCode || status.StatusCode !== 0 || !vehicleStatus || vehicleStatus.StatusCode !== 0) {
        const message = `${status?.StatusMessage || ""} ${vehicleStatus?.StatusMessage || ""}`.toLowerCase();
        if (message.includes("not found") || message.includes("notfound")) throw vehicleLookupError("not_found", { source: "vdg" });
        if (message.includes("invalid")) throw vehicleLookupError("invalid", { source: "vdg" });
        throw vehicleLookupError("unavailable", { source: "vdg" });
      }

      return normalizeVehicleDataGlobal(payload, registration);
    } catch (error) {
      if (error instanceof VehicleLookupError) throw error;
      throw vehicleLookupError("unavailable", { source: "vdg" });
    } finally {
      clearTimeout(timeout);
    }
  }
}
