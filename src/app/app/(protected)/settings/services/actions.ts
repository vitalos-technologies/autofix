"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  parseServiceForm,
  reorderIds,
  type ServiceField,
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

// Services & prices (P3.4). Owners and managers write `services` through
// the RLS client; technicians are refused here as they are by the policies.

const LIST_PATH = "/app/settings/services";
const serviceId = z.string().uuid();
/** Gap between sort values, so one move rewrites few rows. */
const SORT_STEP = 10;

function idFrom(formData: FormData) {
  const parsed = serviceId.safeParse(formData.get("serviceId"));
  return parsed.success ? parsed.data.toLowerCase() : null;
}

/** Creates or updates a service. `serviceId` in the form means edit; without it, a new service goes last. */
export async function saveServiceAction(previous: SetupFormState<ServiceField>, formData: FormData): Promise<SetupFormState<ServiceField>> {
  const rawId = formData.get("serviceId");
  const id = idFrom(formData);
  if (rawId && !id) return stateFor(previous, { status: "error", message: "That service could not be found." });
  const admin = await requireSetupContext(id ? `${LIST_PATH}/${id}` : `${LIST_PATH}/new`);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });

  let currentIsMot = false;
  if (id) {
    const { data, error } = await admin.client
      .from("services")
      .select("id,is_mot")
      .eq("garage_id", admin.garage.id)
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) return stateFor(previous, { status: "error", message: databaseProblem(error) });
    if (!data) return stateFor(previous, { status: "error", message: "That service has been archived or removed. Go back to the list." });
    currentIsMot = Boolean(data.is_mot);
  }

  const parsed = parseServiceForm(formData, { motEnabled: admin.garage.motEnabled, currentIsMot });
  if (!parsed.ok) return stateFor(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors });

  if (id) {
    const { data, error } = await admin.client
      .from("services")
      .update(parsed.value)
      .eq("garage_id", admin.garage.id)
      .eq("id", id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error || !data) return stateFor(previous, { status: "error", message: databaseProblem(error) });
    await auditSetupChange(admin, "service.updated", "service", id, { price_mode: parsed.value.price_mode, price_pence: parsed.value.price_pence });
  } else {
    const { data: last, error: lastError } = await admin.client
      .from("services")
      .select("sort")
      .eq("garage_id", admin.garage.id)
      .is("deleted_at", null)
      .order("sort", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) return stateFor(previous, { status: "error", message: databaseProblem(lastError) });
    const sort = (typeof last?.sort === "number" ? last.sort : 0) + SORT_STEP;
    const { data, error } = await admin.client
      .from("services")
      .insert({ ...parsed.value, garage_id: admin.garage.id, sort })
      .select("id")
      .single();
    if (error || !data) return stateFor(previous, { status: "error", message: databaseProblem(error) });
    await auditSetupChange(admin, "service.created", "service", String(data.id));
  }

  afterSetupChange(admin.garage.id, [LIST_PATH]);
  redirect(`${LIST_PATH}?done=${id ? "updated" : "created"}`);
}

/** Archives a service (soft delete: `deleted_at`). Its bookings keep it; customers no longer see it. */
export async function archiveServiceAction(formData: FormData) {
  const id = idFrom(formData);
  const admin = await requireSetupContext(LIST_PATH);
  if (!roleAllows(admin, "manage")) redirect(`${LIST_PATH}?error=not_allowed`);
  if (!id) redirect(`${LIST_PATH}?error=not_found`);
  const { data, error } = await admin.client
    .from("services")
    .update({ deleted_at: new Date().toISOString(), deleted_by: admin.user.id })
    .eq("garage_id", admin.garage.id)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error || !data) redirect(`${LIST_PATH}?error=${error ? "save_failed" : "not_found"}`);
  await auditSetupChange(admin, "service.archived", "service", id);
  afterSetupChange(admin.garage.id, [LIST_PATH]);
  redirect(`${LIST_PATH}?done=archived`);
}

/** Brings an archived service back, at the end of the list. */
export async function restoreServiceAction(formData: FormData) {
  const id = idFrom(formData);
  const admin = await requireSetupContext(LIST_PATH);
  if (!roleAllows(admin, "manage")) redirect(`${LIST_PATH}?error=not_allowed`);
  if (!id) redirect(`${LIST_PATH}?error=not_found`);
  const { data: last } = await admin.client
    .from("services")
    .select("sort")
    .eq("garage_id", admin.garage.id)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sort = (typeof last?.sort === "number" ? last.sort : 0) + SORT_STEP;
  const { data, error } = await admin.client
    .from("services")
    .update({ deleted_at: null, deleted_by: null, sort })
    .eq("garage_id", admin.garage.id)
    .eq("id", id)
    .not("deleted_at", "is", null)
    .select("id")
    .maybeSingle();
  if (error || !data) redirect(`${LIST_PATH}?error=${error ? "save_failed" : "not_found"}`);
  await auditSetupChange(admin, "service.restored", "service", id);
  afterSetupChange(admin.garage.id, [LIST_PATH]);
  redirect(`${LIST_PATH}?done=restored`);
}

/** Moves a service one place up or down in the booking page's list. */
export async function moveServiceAction(formData: FormData) {
  const id = idFrom(formData);
  const direction = formData.get("direction") === "up" ? "up" : formData.get("direction") === "down" ? "down" : null;
  const admin = await requireSetupContext(LIST_PATH);
  if (!roleAllows(admin, "manage")) redirect(`${LIST_PATH}?error=not_allowed`);
  if (!id || !direction) redirect(`${LIST_PATH}?error=not_found`);

  const { data, error } = await admin.client
    .from("services")
    .select("id,sort")
    .eq("garage_id", admin.garage.id)
    .is("deleted_at", null)
    .order("sort", { ascending: true })
    .order("name", { ascending: true });
  if (error || !data) redirect(`${LIST_PATH}?error=save_failed`);
  const rows = data as Array<{ id: string; sort: number }>;
  const order = reorderIds(rows.map((row) => row.id), id, direction);
  if (!order) redirect(LIST_PATH);

  const current = new Map(rows.map((row) => [row.id, row.sort]));
  for (const [index, rowId] of order.entries()) {
    const sort = (index + 1) * SORT_STEP;
    if (current.get(rowId) === sort) continue;
    const { error: updateError } = await admin.client.from("services").update({ sort }).eq("garage_id", admin.garage.id).eq("id", rowId);
    if (updateError) redirect(`${LIST_PATH}?error=save_failed`);
  }
  afterSetupChange(admin.garage.id, [LIST_PATH]);
  redirect(LIST_PATH);
}
