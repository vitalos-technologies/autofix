/**
 * Vehicle facts for the booking draft. Pure and client-safe.
 * MOT facts reach the draft only when the garage has MOT switched on.
 */
import type { BookingDraft } from "@/lib/booking-engine/types";
import type { VehicleDetails } from "@/types/domain";

export type DraftVehicle = NonNullable<BookingDraft["vehicle"]>;

function clean(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : undefined;
}

/** `BLUE` → `Blue`, `GREY METALLIC` → `Grey metallic`; mixed case is kept. */
function sentenceCase(value: string | undefined) {
  if (!value) return undefined;
  if (value !== value.toUpperCase()) return value;
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Provider names are often upper case (`FORD`); `BMW` and other short acronyms stay as they are. */
function nameCase(value: string | undefined) {
  if (!value || value !== value.toUpperCase()) return value;
  return value
    .split(" ")
    .map((word) => (word.length <= 3 || /\d/.test(word) ? word : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(" ");
}

/** `999` cc + `PETROL` → `1.0 petrol`; fuel alone → `Petrol`. */
export function engineDescription(engineCapacityCc: number | undefined, fuelType: string | undefined): string | undefined {
  const fuel = clean(fuelType, 40)?.toLowerCase();
  const litres = typeof engineCapacityCc === "number" && engineCapacityCc > 0 ? (Math.round(engineCapacityCc / 100) / 10).toFixed(1) : undefined;
  if (litres && fuel) return `${litres} ${fuel}`;
  if (litres) return `${litres} litre`;
  return fuel ? fuel.charAt(0).toUpperCase() + fuel.slice(1) : undefined;
}

/** The draft's vehicle from a lookup result. `motEnabled` is the garage's switch. */
export function draftVehicleFromLookup(details: VehicleDetails, registration: string, motEnabled: boolean): DraftVehicle {
  const vehicle: DraftVehicle = { registration };
  const make = nameCase(clean(details.make, 80));
  const model = nameCase(clean(details.model, 120));
  const colour = sentenceCase(clean(details.colour, 50));
  const fuel = sentenceCase(clean(details.fuelType, 50));
  const engine = engineDescription(details.engineCapacityCc, details.fuelType);
  if (make) vehicle.make = make;
  if (model) vehicle.model = model;
  if (colour) vehicle.colour = colour;
  if (fuel) vehicle.fuel = fuel;
  if (engine) vehicle.engine = engine.slice(0, 80);
  if (typeof details.year === "number" && details.year >= 1900 && details.year <= 2100) vehicle.year = Math.trunc(details.year);
  if (motEnabled && details.motExpiry && /^\d{4}-\d{2}-\d{2}$/.test(details.motExpiry)) vehicle.motExpiry = details.motExpiry;
  return vehicle;
}

/** "Ford Focus" (make and model), or "" when neither is known. */
export function vehicleName(vehicle: Pick<DraftVehicle, "make" | "model"> | undefined): string {
  return [vehicle?.make, vehicle?.model].filter((part) => part && part.trim()).join(" ");
}
