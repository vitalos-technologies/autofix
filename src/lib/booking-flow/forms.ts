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
  /** P5.8 adds the collection address fields (collection and delivery, Pro). */
  fieldErrors?: FieldErrors<"name" | "phone" | "email" | "collectionPostcode" | "collectionAddress">;
  /** Step to go back to when the problem is an earlier choice (service or area). */
  editHref?: string;
  editLabel?: string;
};

export const initialVehicleFormState: VehicleFormState = { seq: 0, status: "idle", vehicle: null };
export const initialServiceFormState: ServiceFormState = { seq: 0 };
export const initialTimeFormState: TimeFormState = { seq: 0 };
export const initialDetailsFormState: DetailsFormState = { seq: 0 };

// Manage booking (`/manage`, `/manage/reschedule`, `/manage/cancel`).

export type ManageLookupFormState = Base & {
  fieldErrors?: FieldErrors<"reference" | "registration">;
};

export type ManageRescheduleFormState = Base & {
  /** The time picked had just gone: the nearest free times to offer instead. */
  alternatives?: ReadonlyArray<{ startsAt: string; endsAt: string }>;
};

export type ManageCancelFormState = Base;

export const initialManageLookupFormState: ManageLookupFormState = { seq: 0 };
export const initialManageRescheduleFormState: ManageRescheduleFormState = { seq: 0 };
export const initialManageCancelFormState: ManageCancelFormState = { seq: 0 };
