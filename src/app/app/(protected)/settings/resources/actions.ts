"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { parseResourceForm, parseResourceName, reorderIds, type ResourceField, type SetupFormState } from "@/lib/settings/setup";
import {
  afterSetupChange,
  auditSetupChange,
  databaseProblem,
  NOT_ALLOWED_MESSAGES,
  requireSetupContext,
  roleAllows,
  stateFor,
} from "@/lib/settings/server";

// Bays, vans and technicians (P3.4): `resources`, owners and managers.

const PATH = "/app/settings/resources";
const SORT_STEP = 10;
const resourceId = z.string().uuid();

function idFrom(formData: FormData) {
  const parsed = resourceId.safeParse(formData.get("resourceId"));
  return parsed.success ? parsed.data.toLowerCase() : null;
}

/** Adds a bay, mobile van or technician at the end of the list, switched on. */
export async function addResourceAction(previous: SetupFormState<ResourceField>, formData: FormData): Promise<SetupFormState<ResourceField>> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });
  const parsed = parseResourceForm(formData, { withKind: true });
  if (!parsed.ok) return stateFor(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors });

  const { data: last, error: lastError } = await admin.client
    .from("resources")
    .select("sort")
    .eq("garage_id", admin.garage.id)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) return stateFor(previous, { status: "error", message: databaseProblem(lastError) });
  const sort = (typeof last?.sort === "number" ? last.sort : 0) + SORT_STEP;
  const { data, error } = await admin.client
    .from("resources")
    .insert({ garage_id: admin.garage.id, name: parsed.value.name, kind: parsed.value.kind, active: true, sort })
    .select("id")
    .single();
  if (error || !data) return stateFor(previous, { status: "error", message: databaseProblem(error) });

  await auditSetupChange(admin, "resource.created", "resource", String(data.id), { kind: parsed.value.kind });
  afterSetupChange(admin.garage.id, [PATH]);
  return stateFor(previous, { status: "saved", message: `${parsed.value.name} added. It can take bookings straight away.` });
}

/** Renames a resource (its kind stays: bookings already on it depend on it). */
export async function renameResourceAction(formData: FormData) {
  const id = idFrom(formData);
  const name = parseResourceName(String(formData.get("name") ?? ""));
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) redirect(`${PATH}?error=not_allowed`);
  if (!id) redirect(`${PATH}?error=not_found`);
  if (!name) redirect(`${PATH}?error=bad_name`);
  const { data, error } = await admin.client.from("resources").update({ name }).eq("garage_id", admin.garage.id).eq("id", id).select("id").maybeSingle();
  if (error || !data) redirect(`${PATH}?error=${error ? "save_failed" : "not_found"}`);
  await auditSetupChange(admin, "resource.renamed", "resource", id);
  afterSetupChange(admin.garage.id, [PATH]);
  redirect(`${PATH}?done=renamed`);
}

/** Switches a resource on or off. Off: no new bookings; bookings already on it stay. */
export async function setResourceActiveAction(formData: FormData) {
  const id = idFrom(formData);
  const active = formData.get("active") === "true";
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) redirect(`${PATH}?error=not_allowed`);
  if (!id) redirect(`${PATH}?error=not_found`);
  const { data, error } = await admin.client.from("resources").update({ active }).eq("garage_id", admin.garage.id).eq("id", id).select("id").maybeSingle();
  if (error || !data) redirect(`${PATH}?error=${error ? "save_failed" : "not_found"}`);
  await auditSetupChange(admin, active ? "resource.activated" : "resource.deactivated", "resource", id);
  afterSetupChange(admin.garage.id, [PATH]);
  redirect(PATH);
}

/** Moves a resource one place up or down (the diary's row order). */
export async function moveResourceAction(formData: FormData) {
  const id = idFrom(formData);
  const direction = formData.get("direction") === "up" ? "up" : formData.get("direction") === "down" ? "down" : null;
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) redirect(`${PATH}?error=not_allowed`);
  if (!id || !direction) redirect(`${PATH}?error=not_found`);
  const { data, error } = await admin.client
    .from("resources")
    .select("id,sort")
    .eq("garage_id", admin.garage.id)
    .order("sort", { ascending: true })
    .order("name", { ascending: true });
  if (error || !data) redirect(`${PATH}?error=save_failed`);
  const rows = data as Array<{ id: string; sort: number }>;
  const order = reorderIds(rows.map((row) => row.id), id, direction);
  if (!order) redirect(PATH);
  const current = new Map(rows.map((row) => [row.id, row.sort]));
  for (const [index, rowId] of order.entries()) {
    const sort = (index + 1) * SORT_STEP;
    if (current.get(rowId) === sort) continue;
    const { error: updateError } = await admin.client.from("resources").update({ sort }).eq("garage_id", admin.garage.id).eq("id", rowId);
    if (updateError) redirect(`${PATH}?error=save_failed`);
  }
  afterSetupChange(admin.garage.id, [PATH]);
  redirect(PATH);
}

/** Deletes a resource that has never had a booking; one with bookings must be switched off instead. */
export async function deleteResourceAction(formData: FormData) {
  const id = idFrom(formData);
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) redirect(`${PATH}?error=not_allowed`);
  if (!id) redirect(`${PATH}?error=not_found`);
  const { data, error } = await admin.client.from("resources").delete().eq("garage_id", admin.garage.id).eq("id", id).select("id");
  if (error?.code === "23503") redirect(`${PATH}?error=in_use`);
  if (error) redirect(`${PATH}?error=save_failed`);
  if (!data?.length) redirect(`${PATH}?error=not_found`);
  await auditSetupChange(admin, "resource.deleted", "resource", id);
  afterSetupChange(admin.garage.id, [PATH]);
  redirect(`${PATH}?done=deleted`);
}
