"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { dateKeyInZone } from "@/lib/booking-flow/dates";
import {
  diffOpeningWindows,
  normaliseTime,
  parseBookingRulesForm,
  parseClosureForm,
  parseOpeningHoursForm,
  type BookingRulesField,
  type ClosureField,
  type HoursField,
  type OpeningWindow,
  type SetupFormState,
} from "@/lib/settings/setup";
import {
  afterSetupChange,
  auditSetupChange,
  databaseProblem,
  NOT_ALLOWED_MESSAGES,
  requireSetupContext,
  roleAllows,
  stateFor,
} from "@/lib/settings/server";

// Opening hours & closures (P3.4). Opening windows and closures: owners and
// managers (RLS on opening_hours / closures). Booking rules are garage
// columns: owners only ("owners update the selected garage").

const PATH = "/app/settings/hours";

type StoredWindow = OpeningWindow & { id: string };

/** Saves the week: unchanged windows stay, removed or changed ones are replaced. */
export async function saveOpeningHoursAction(previous: SetupFormState<HoursField>, formData: FormData): Promise<SetupFormState<HoursField>> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });
  const parsed = parseOpeningHoursForm(formData);
  if (!parsed.ok) return stateFor(previous, { status: "error", message: parsed.message, fieldErrors: parsed.fieldErrors });

  const { data, error } = await admin.client.from("opening_hours").select("id,weekday,opens,closes").eq("garage_id", admin.garage.id);
  if (error || !data) return stateFor(previous, { status: "error", message: databaseProblem(error) });
  const stored: StoredWindow[] = (data as Array<{ id: string; weekday: number; opens: string; closes: string }>).map((row) => ({
    id: row.id,
    weekday: row.weekday,
    opens: normaliseTime(row.opens) ?? row.opens,
    closes: normaliseTime(row.closes) ?? row.closes,
  }));
  const { remove, add } = diffOpeningWindows(stored, parsed.value);
  if (!remove.length && !add.length) return stateFor(previous, { status: "saved", message: "No changes to save." });

  // Removed and changed windows go first, so the new set never overlaps the old one
  // (opening_hours_no_overlap is checked row by row).
  if (remove.length) {
    const { error: deleteError } = await admin.client.from("opening_hours").delete().eq("garage_id", admin.garage.id).in("id", remove.map((row) => row.id));
    if (deleteError) return stateFor(previous, { status: "error", message: databaseProblem(deleteError) });
  }
  if (add.length) {
    const { error: insertError } = await admin.client
      .from("opening_hours")
      .insert(add.map((window) => ({ garage_id: admin.garage.id, weekday: window.weekday, opens: window.opens, closes: window.closes })));
    if (insertError) {
      // Put back what was removed, so a failed save does not leave days closed.
      if (remove.length) {
        await admin.client
          .from("opening_hours")
          .insert(remove.map((row) => ({ garage_id: admin.garage.id, weekday: row.weekday, opens: row.opens, closes: row.closes })));
      }
      return stateFor(previous, { status: "error", message: databaseProblem(insertError) });
    }
  }

  await auditSetupChange(admin, "opening_hours.updated", "garage", admin.garage.id, { removed: remove.length, added: add.length });
  afterSetupChange(admin.garage.id, [PATH]);
  return stateFor(previous, { status: "saved", message: "Opening hours saved. New bookings follow them straight away." });
}

/** Adds a closure (whole days, inclusive). Bookings already in those days are kept. */
export async function addClosureAction(previous: SetupFormState<ClosureField>, formData: FormData): Promise<SetupFormState<ClosureField>> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });
  const parsed = parseClosureForm(formData, dateKeyInZone(new Date(), admin.garage.timezone));
  if (!parsed.ok) return stateFor(previous, { status: "error", message: "Check the dates.", fieldErrors: parsed.fieldErrors });

  const { data, error } = await admin.client
    .from("closures")
    .insert({ ...parsed.value, garage_id: admin.garage.id })
    .select("id")
    .single();
  if (error || !data) return stateFor(previous, { status: "error", message: databaseProblem(error) });

  await auditSetupChange(admin, "closure.created", "closure", String(data.id), { starts_on: parsed.value.starts_on, ends_on: parsed.value.ends_on });
  afterSetupChange(admin.garage.id, [PATH]);
  return stateFor(previous, { status: "saved", message: "Closure added. Customers can't book those days." });
}

const closureId = z.string().uuid();

/** Removes a closure, so those days open for booking again. */
export async function removeClosureAction(formData: FormData) {
  const id = closureId.safeParse(formData.get("closureId"));
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) redirect(`${PATH}?error=not_allowed`);
  if (!id.success) redirect(`${PATH}?error=not_found`);
  const { data, error } = await admin.client.from("closures").delete().eq("garage_id", admin.garage.id).eq("id", id.data).select("id");
  if (error) redirect(`${PATH}?error=save_failed`);
  if (!data?.length) redirect(`${PATH}?error=not_found`);
  await auditSetupChange(admin, "closure.removed", "closure", id.data);
  afterSetupChange(admin.garage.id, [PATH]);
  redirect(`${PATH}?done=closure_removed`);
}

/** Slot step, approval, cancellation cutoff, mobile travel and service area (garage columns, owners only). */
export async function saveBookingRulesAction(previous: SetupFormState<BookingRulesField>, formData: FormData): Promise<SetupFormState<BookingRulesField>> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.owner });
  const parsed = parseBookingRulesForm(formData);
  if (!parsed.ok) return stateFor(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors });

  const { data, error } = await admin.client.from("garages").update(parsed.value).eq("id", admin.garage.id).select("id").maybeSingle();
  if (error || !data) return stateFor(previous, { status: "error", message: databaseProblem(error) });

  await auditSetupChange(admin, "booking_rules.updated", "garage", admin.garage.id, {
    slot_step_min: parsed.value.slot_step_min,
    approve_online: parsed.value.approve_online,
    cancellation_cutoff_h: parsed.value.cancellation_cutoff_h,
    mobile_travel_min: parsed.value.mobile_travel_min,
    service_area: parsed.value.service_area.length,
  });
  afterSetupChange(admin.garage.id, [PATH, "/app", "/app/settings/services"]);
  return stateFor(previous, { status: "saved", message: "Booking rules saved." });
}
