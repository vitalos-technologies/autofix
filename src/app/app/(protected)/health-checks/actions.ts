"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaffWriter } from "@/lib/admin/staff";
import { isMediaContentType, LIMITS, MEDIA_PROBLEM_MESSAGES, MEDIA_TYPES, mediaObjectPath, mediaProblem, type MediaContentType } from "@/lib/health-checks/checklist";
import { parseItemForm, parseNewItemForm, parseSummaryForm } from "@/lib/health-checks/forms";
import { canSendHealthCheck, sendHealthCheck } from "@/lib/health-checks/send";
import { confirmMediaUpload, createMediaUploadUrl, removeMediaObjects } from "@/lib/health-checks/storage";
import { isPlanRequiredDatabaseError, planRequiredMessage } from "@/lib/plans/entitlements";
import { featureProblem } from "@/lib/plans/server";

// Health checks (P5.3, Pro `health_checks`): `/app/health-checks` and `/app/health-checks/[id]`.
// The garage is always the member's selected garage and the member the signed-in user (MFA done
// this session, `requireStaffWriter`); forms name only the booking, check, line or file by id.
// Every action refuses an Essentials garage (PLAN_REQUIRED) before touching data, and the RLS
// write policies and SQL functions refuse it again.

const FEATURE = "health_checks" as const;
const uuid = z.string().uuid();

export type HealthCheckFormState = {
  seq: number;
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
};

function next(previous: HealthCheckFormState, state: Omit<HealthCheckFormState, "seq">): HealthCheckFormState {
  return { seq: previous.seq + 1, ...state };
}

function checkPath(id: string) {
  return `/app/health-checks/${id}`;
}

const SAVE_FAILED = "That didn't save. Reload the page and try again.";
const LOCKED = "The customer has answered this health check, so it can't be changed.";

/** "Start health check" on a booking: opens the existing check or creates one with the default checklist. */
export async function startHealthCheckAction(formData: FormData): Promise<void> {
  const bookingId = uuid.safeParse(formData.get("bookingId"));
  const back = bookingId.success ? `/app/bookings/${bookingId.data}` : "/app/bookings";
  const admin = await requireStaffWriter(back);
  if (!bookingId.success) redirect("/app/health-checks?notice=not_found");
  if (featureProblem(admin, FEATURE)) redirect("/app/health-checks");
  const { data, error } = await admin.client.rpc("start_health_check", { p_booking_id: bookingId.data });
  if (error || typeof data !== "string") {
    const notice = isPlanRequiredDatabaseError(error) ? "plan" : error?.message?.includes("BOOKING_CLOSED") ? "booking_closed" : "not_found";
    redirect(`/app/health-checks?notice=${notice}`);
  }
  revalidatePath(back);
  redirect(checkPath(data));
}

/** Saves one checklist line (rating, note, recommended work and price). */
export async function saveItemAction(previous: HealthCheckFormState, formData: FormData): Promise<HealthCheckFormState> {
  const checkId = uuid.safeParse(formData.get("checkId"));
  const itemId = uuid.safeParse(formData.get("itemId"));
  const admin = await requireStaffWriter(checkId.success ? checkPath(checkId.data) : "/app/health-checks");
  const plan = featureProblem(admin, FEATURE);
  if (plan) return next(previous, { status: "error", message: plan });
  if (!checkId.success || !itemId.success) return next(previous, { status: "error", message: SAVE_FAILED });
  const parsed = parseItemForm(formData);
  if (!parsed.ok) return next(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors });
  const { data, error } = await admin.client
    .from("health_check_items")
    .update(parsed.value)
    .eq("check_id", checkId.data)
    .eq("id", itemId.data)
    .select("id");
  if (error) return next(previous, { status: "error", message: isPlanRequiredDatabaseError(error) ? planRequiredMessage(FEATURE) : SAVE_FAILED });
  if (!data?.length) return next(previous, { status: "error", message: LOCKED });
  revalidatePath(checkPath(checkId.data));
  return next(previous, { status: "saved", message: "Saved." });
}

/** Adds a line of the technician's own. */
export async function addItemAction(previous: HealthCheckFormState, formData: FormData): Promise<HealthCheckFormState> {
  const checkId = uuid.safeParse(formData.get("checkId"));
  const admin = await requireStaffWriter(checkId.success ? checkPath(checkId.data) : "/app/health-checks");
  const plan = featureProblem(admin, FEATURE);
  if (plan) return next(previous, { status: "error", message: plan });
  if (!checkId.success) return next(previous, { status: "error", message: SAVE_FAILED });
  const parsed = parseNewItemForm(formData);
  if (!parsed.ok) return next(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors });
  const { count } = await admin.client.from("health_check_items").select("id", { count: "exact", head: true }).eq("check_id", checkId.data);
  if ((count ?? 0) >= 200) return next(previous, { status: "error", message: "This check already has 200 lines." });
  const { error } = await admin.client.from("health_check_items").insert({ check_id: checkId.data, section: parsed.value.section, label: parsed.value.label, position: 900 + (count ?? 0) });
  if (error) return next(previous, { status: "error", message: isPlanRequiredDatabaseError(error) ? planRequiredMessage(FEATURE) : LOCKED });
  revalidatePath(checkPath(checkId.data));
  return next(previous, { status: "saved", message: `Added "${parsed.value.label}".` });
}

/** Removes a line (before the customer decides). */
export async function deleteItemAction(formData: FormData): Promise<void> {
  const checkId = uuid.safeParse(formData.get("checkId"));
  const itemId = uuid.safeParse(formData.get("itemId"));
  const admin = await requireStaffWriter(checkId.success ? checkPath(checkId.data) : "/app/health-checks");
  if (!checkId.success || !itemId.success || featureProblem(admin, FEATURE)) redirect("/app/health-checks");
  const { data: media } = await admin.client.from("health_check_media").select("object_path").eq("check_id", checkId.data).eq("item_id", itemId.data);
  const { data } = await admin.client.from("health_check_items").delete().eq("check_id", checkId.data).eq("id", itemId.data).select("id");
  if (data?.length && media?.length) await removeMediaObjects(admin.garage.id, media.map((row) => (row as { object_path: string }).object_path));
  revalidatePath(checkPath(checkId.data));
  redirect(`${checkPath(checkId.data)}?notice=${data?.length ? "item_removed" : "locked"}`);
}

/** The note to the customer and the mileage. */
export async function saveSummaryAction(previous: HealthCheckFormState, formData: FormData): Promise<HealthCheckFormState> {
  const checkId = uuid.safeParse(formData.get("checkId"));
  const admin = await requireStaffWriter(checkId.success ? checkPath(checkId.data) : "/app/health-checks");
  const plan = featureProblem(admin, FEATURE);
  if (plan) return next(previous, { status: "error", message: plan });
  if (!checkId.success) return next(previous, { status: "error", message: SAVE_FAILED });
  const parsed = parseSummaryForm(formData);
  if (!parsed.ok) return next(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors });
  const { data, error } = await admin.client.from("health_checks").update(parsed.value).eq("id", checkId.data).select("id");
  if (error) return next(previous, { status: "error", message: isPlanRequiredDatabaseError(error) ? planRequiredMessage(FEATURE) : SAVE_FAILED });
  if (!data?.length) return next(previous, { status: "error", message: LOCKED });
  revalidatePath(checkPath(checkId.data));
  return next(previous, { status: "saved", message: "Saved." });
}

export type PrepareUploadResult = { ok: true; mediaId: string; path: string; token: string } | { ok: false; message: string };

const uploadRequest = z.object({
  checkId: z.string().uuid(),
  itemId: z.string().uuid().nullable(),
  contentType: z.string().max(100),
  size: z.number().int().min(0).max(1024 * 1024 * 1024),
});

/**
 * Before a photo or video upload: records the media row through RLS (staff of the garage, Pro,
 * check still editable, the path in the garage's own folder) and returns a signed upload URL for
 * exactly that path. The browser then uploads straight to storage (no file passes through here).
 */
export async function prepareUploadAction(input: { checkId: string; itemId: string | null; contentType: string; size: number }): Promise<PrepareUploadResult> {
  const parsed = uploadRequest.safeParse(input);
  const admin = await requireStaffWriter(parsed.success ? checkPath(parsed.data.checkId) : "/app/health-checks");
  const plan = featureProblem(admin, FEATURE);
  if (plan) return { ok: false, message: plan };
  if (!parsed.success) return { ok: false, message: "That file couldn't be added." };
  const problem = mediaProblem({ type: parsed.data.contentType, size: parsed.data.size });
  if (problem || !isMediaContentType(parsed.data.contentType)) return { ok: false, message: MEDIA_PROBLEM_MESSAGES[problem ?? "type"] };
  const contentType: MediaContentType = parsed.data.contentType;

  const counts = await Promise.all([
    admin.client.from("health_check_media").select("id", { count: "exact", head: true }).eq("check_id", parsed.data.checkId),
    parsed.data.itemId
      ? admin.client.from("health_check_media").select("id", { count: "exact", head: true }).eq("check_id", parsed.data.checkId).eq("item_id", parsed.data.itemId)
      : Promise.resolve({ count: 0 }),
  ]);
  if ((counts[0].count ?? 0) >= LIMITS.mediaPerCheck) return { ok: false, message: `A health check can hold ${LIMITS.mediaPerCheck} photos and videos.` };
  if ((counts[1].count ?? 0) >= LIMITS.mediaPerItem) return { ok: false, message: `Each line can hold ${LIMITS.mediaPerItem} photos and videos.` };

  const path = mediaObjectPath(admin.garage.id, parsed.data.checkId, randomUUID(), contentType);
  const { data: row, error } = await admin.client.from("health_check_media").insert({
    check_id: parsed.data.checkId,
    item_id: parsed.data.itemId,
    object_path: path,
    content_type: contentType,
    size_bytes: parsed.data.size,
    kind: MEDIA_TYPES[contentType].kind,
  }).select("id").single();
  if (error || !row) return { ok: false, message: isPlanRequiredDatabaseError(error) ? planRequiredMessage(FEATURE) : LOCKED };
  const signed = await createMediaUploadUrl(admin.garage.id, path);
  if (!signed) return { ok: false, message: "Uploads aren't available right now." };
  return { ok: true, mediaId: (row as { id: string }).id, path: signed.path, token: signed.token };
}

/** After the upload: checks the object is there, of the declared type and within the size limit. */
export async function finishUploadAction(input: { checkId: string; mediaId: string }): Promise<{ ok: boolean; message?: string }> {
  const parsed = z.object({ checkId: z.string().uuid(), mediaId: z.string().uuid() }).safeParse(input);
  const admin = await requireStaffWriter(parsed.success ? checkPath(parsed.data.checkId) : "/app/health-checks");
  if (featureProblem(admin, FEATURE) || !parsed.success) return { ok: false, message: "That file couldn't be added." };
  const { data } = await admin.client
    .from("health_check_media")
    .select("id,object_path,content_type")
    .eq("check_id", parsed.data.checkId)
    .eq("id", parsed.data.mediaId)
    .maybeSingle();
  if (!data) return { ok: false, message: "That file couldn't be added." };
  const problem = await confirmMediaUpload(admin.garage.id, data as { id: string; object_path: string; content_type: string });
  if (problem) return { ok: false, message: problem === "unavailable" ? "Uploads aren't available right now." : MEDIA_PROBLEM_MESSAGES[problem] };
  revalidatePath(checkPath(parsed.data.checkId));
  return { ok: true };
}

/** Removes a photo or video (before the customer decides). */
export async function deleteMediaAction(formData: FormData): Promise<void> {
  const checkId = uuid.safeParse(formData.get("checkId"));
  const mediaId = uuid.safeParse(formData.get("mediaId"));
  const admin = await requireStaffWriter(checkId.success ? checkPath(checkId.data) : "/app/health-checks");
  if (!checkId.success || !mediaId.success || featureProblem(admin, FEATURE)) redirect("/app/health-checks");
  const { data } = await admin.client.from("health_check_media").delete().eq("check_id", checkId.data).eq("id", mediaId.data).select("object_path");
  if (data?.length) await removeMediaObjects(admin.garage.id, data.map((row) => (row as { object_path: string }).object_path));
  revalidatePath(checkPath(checkId.data));
  redirect(`${checkPath(checkId.data)}?notice=${data?.length ? "media_removed" : "locked"}`);
}

const SEND_MESSAGES: Record<string, string> = {
  rate_limited: "That's a lot of sends in a few minutes. Wait a moment and try again.",
  unavailable: "The health check couldn't be sent. Try again.",
  failed: "The message didn't go: the provider turned it down. It's marked Not delivered in Messages.",
  not_allowed: "Only owners, managers and front desk can send health checks to customers.",
  plan_required: planRequiredMessage(FEATURE),
  not_found: "This health check could not be found. Reload the page.",
  already_responded: "The customer has already answered this health check.",
  nothing_checked: "Rate at least one line before sending.",
  anonymised: "This customer's details were removed, so they can't be messaged.",
  opted_out: "This customer has opted out of texts, so the health check can't be texted.",
  no_address: "There's no mobile number or email for this customer on their channel.",
  no_messaging_number: "Your garage doesn't have a texting number yet. Ask Vitalos to set one up.",
};

/** Sends (or sends again, with a new link) the health check to the booking's customer. */
export async function sendHealthCheckAction(previous: HealthCheckFormState, formData: FormData): Promise<HealthCheckFormState> {
  const checkId = uuid.safeParse(formData.get("checkId"));
  const admin = await requireStaffWriter(checkId.success ? checkPath(checkId.data) : "/app/health-checks");
  const plan = featureProblem(admin, FEATURE);
  if (plan) return next(previous, { status: "error", message: plan });
  if (!canSendHealthCheck(admin.role)) return next(previous, { status: "error", message: SEND_MESSAGES.not_allowed });
  if (!checkId.success) return next(previous, { status: "error", message: SEND_MESSAGES.not_found });
  const { count } = await admin.client
    .from("health_check_items")
    .select("id", { count: "exact", head: true })
    .eq("check_id", checkId.data)
    .not("recommended_work", "is", null);
  const result = await sendHealthCheck({
    garage: { id: admin.garage.id, name: admin.garage.name, slug: admin.garage.slug, customDomain: admin.garage.customDomain },
    member: { id: admin.user.id },
    checkId: checkId.data,
    hasRecommendedWork: (count ?? 0) > 0,
  });
  revalidatePath(checkPath(checkId.data));
  revalidatePath("/app/health-checks");
  if (!result.ok) return next(previous, { status: "error", message: SEND_MESSAGES[result.code] ?? SEND_MESSAGES.unavailable });
  return next(previous, {
    status: "saved",
    message: result.mode === "mock"
      ? "Sent. Messaging is in test mode, so it went to the test outbox, not to the customer."
      : "Sent to the customer. You'll see their answer here.",
  });
}

/** Puts the approved work on the booking's draft invoice (the existing invoicing functions). */
export async function addToInvoiceAction(formData: FormData): Promise<void> {
  const checkId = uuid.safeParse(formData.get("checkId"));
  const admin = await requireStaffWriter(checkId.success ? checkPath(checkId.data) : "/app/health-checks");
  if (!checkId.success) redirect("/app/health-checks");
  if (featureProblem(admin, FEATURE)) redirect(`${checkPath(checkId.data)}?notice=plan`);
  const { data, error } = await admin.client.rpc("add_health_check_to_invoice", { p_check_id: checkId.data });
  const invoiceId = (data as { invoice_id?: string } | null)?.invoice_id;
  if (error || !invoiceId) {
    const message = error?.message ?? "";
    const notice = isPlanRequiredDatabaseError(error) ? "plan" : message.includes("NOTHING_APPROVED") ? "nothing_approved" : message.includes("UNAUTHORISED") ? "invoice_denied" : "invoice_failed";
    redirect(`${checkPath(checkId.data)}?notice=${notice}`);
  }
  revalidatePath(checkPath(checkId.data));
  revalidatePath("/app/invoices");
  redirect(`/app/invoices/${invoiceId}?notice=saved`);
}
