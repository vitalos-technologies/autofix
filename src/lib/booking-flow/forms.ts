/**
 * What the booking step server actions return to their forms. Client-safe.
 * Nothing here is ever put in a URL.
 */
import type { DraftVehicle } from "@/lib/booking-flow/vehicle";

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

type Base = {
  /** Increments on every response, so the form can move focus to a new error. */
  seq: number;
  /** Form-level message (shown in an alert above the action bar). */
  message?: string;
};

export type VehicleFormState = Base & {
  status: "idle" | "found" | "error";
  /** The car found for the registration (shown in the vehicle card). */
  vehicle: DraftVehicle | null;
  fieldErrors?: FieldErrors<"registration" | "make" | "model">;
  /** Offer manual entry (lookup failed or is not configured). */
  suggestManual?: boolean;
};

export type ServiceFormState = Base & {
  fieldErrors?: FieldErrors<"serviceId" | "postcode">;
};

export type TimeFormState = Base;

export type DetailsFormState = Base & {
  fieldErrors?: FieldErrors<"name" | "phone" | "email">;
  /** Step to go back to when the problem is an earlier choice (service or area). */
  editHref?: string;
  editLabel?: string;
};

export const initialVehicleFormState: VehicleFormState = { seq: 0, status: "idle", vehicle: null };
export const initialServiceFormState: ServiceFormState = { seq: 0 };
export const initialTimeFormState: TimeFormState = { seq: 0 };
export const initialDetailsFormState: DetailsFormState = { seq: 0 };
