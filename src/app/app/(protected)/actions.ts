"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { recordAdminAudit } from "@/lib/admin/audit";
import { retryEnquiryNotifications } from "@/lib/enquiries/repository";
import { addInternalNote, markEnquiryThreadRead, sendEnquiryReply, type ReplyState } from "@/lib/enquiries/thread-repository";
import { safeAdminReturnTo } from "@/lib/auth/mfa";
import { toE164UK } from "@/lib/messaging/phone";
import { getAdminContext } from "@/lib/tenancy/admin";

async function requireAdmin() {
  const auth = await getAdminContext({ requireMfa: false });
  if (auth?.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (auth?.mfaRequired && !auth.mfaVerified) {
    const referer = (await headers()).get("referer");
    let returnTo = "/app";
    try {
      const url = referer ? new URL(referer) : null;
      returnTo = safeAdminReturnTo(url ? `${url.pathname}${url.search}` : null);
    } catch {
      returnTo = "/app";
    }
    redirect(`/app/mfa?returnTo=${encodeURIComponent(returnTo)}&stepUp=1`);
  }
  if (!auth) throw new Error("Unauthorised");
  // `client` is the RLS client for the selected garage (x-garage-id).
  return { auth, client: auth.client };
}

type AdminAuth = Awaited<ReturnType<typeof requireAdmin>>["auth"];

async function audit(auth: AdminAuth, action: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}) {
  if (!(await recordAdminAudit(auth.garage.id, { actorId: auth.user.id, action, entityType, entityId, detail }))) {
    throw new Error("The change was saved, but its required audit entry could not be recorded.");
  }
}

export async function updateEnquiryStatus(formData: FormData) {
  const { auth, client } = await requireAdmin();
  const id = z.string().uuid().parse(formData.get("id")); const status = z.enum(["new", "contacted", "booked", "closed"]).parse(formData.get("status"));
  const { data, error } = await client.from("enquiries").update({ status, closed_at: status === "closed" ? new Date().toISOString() : null }).eq("garage_id", auth.garage.id).eq("id", id).select("id").maybeSingle();
  if (error || !data) throw new Error("The enquiry could not be updated.");
  await audit(auth, "status_change", "enquiry", id, { status });
  revalidatePath("/app/enquiries");
  revalidatePath(`/app/enquiries/${id}`);
  revalidatePath("/app/notifications");
  revalidatePath("/app", "layout");
}

export async function sendEnquiryReplyAction(previous: ReplyState, formData: FormData): Promise<ReplyState> {
  const { auth } = await requireAdmin();
  const enquiryId = String(formData.get("enquiryId") || "");
  const draft = String(formData.get("body") || "");
  const clientRequestId = String(formData.get("clientRequestId") || previous.clientRequestId || "");
  try {
    await sendEnquiryReply(auth.garage, { enquiryId, body: draft, clientRequestId, actorId: auth.user.id, actorName: auth.profile.display_name });
    revalidateEnquiryThread(enquiryId);
    return { status: "sent", message: "Reply sent to the customer.", draft: "", clientRequestId: crypto.randomUUID() };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "The reply could not be sent.", draft, clientRequestId };
  }
}

export async function saveInternalNoteAction(previous: ReplyState, formData: FormData): Promise<ReplyState> {
  const { auth } = await requireAdmin();
  const enquiryId = String(formData.get("enquiryId") || "");
  const draft = String(formData.get("body") || "");
  try {
    await addInternalNote(auth.garage, { enquiryId, body: draft, actorId: auth.user.id, actorName: auth.profile.display_name });
    revalidateEnquiryThread(enquiryId);
    return { status: "sent", message: "Internal note saved. It was not emailed.", draft: "", clientRequestId: crypto.randomUUID() };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "The note could not be saved.", draft, clientRequestId: previous.clientRequestId };
  }
}

export async function markEnquiryThreadReadAction(enquiryId: string) {
  const { auth } = await requireAdmin();
  await markEnquiryThreadRead(auth.garage.id, enquiryId);
  revalidateEnquiryThread(enquiryId);
}

function revalidateEnquiryThread(enquiryId: string) {
  revalidatePath(`/app/enquiries/${enquiryId}`);
  revalidatePath("/app/enquiries");
  revalidatePath("/app/notifications");
  revalidatePath("/app", "layout");
}

export async function resendEnquiryNotifications(formData: FormData) {
  const { auth } = await requireAdmin();
  const id = z.string().uuid().parse(formData.get("id"));
  const status = await retryEnquiryNotifications(auth.garage, id);
  await audit(auth, "notification_retry", "enquiry", id, { status });
  revalidatePath("/app/enquiries");
  revalidatePath("/app/notifications");
}

const optionalText = (max: number) => z.string().trim().max(max).transform((value) => value || null);
const settingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  legalName: optionalText(160),
  companyNumber: optionalText(20),
  phone: z.string().trim().max(30),
  whatsapp: z.string().trim().max(30),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().pipe(z.email().max(254))]),
  line1: optionalText(120),
  line2: optionalText(120),
  town: optionalText(80),
  postcode: optionalText(12).transform((value) => value?.toUpperCase() ?? null),
  googleMapsUrl: z.union([z.literal(""), z.url().max(500)]),
});

/**
 * Saves the selected garage's profile (owners only, enforced by RLS) and its
 * map link. Opening hours live in `opening_hours` (Setup → Opening hours, P3.4).
 * The garage is the admin's selected garage, never a form field.
 */
export async function saveSettings(formData: FormData) {
  const { auth, client } = await requireAdmin();
  if (auth.role !== "owner") redirect("/app/settings?error=owner_only");
  const parsed = settingsSchema.safeParse({
    name: formData.get("name") ?? "",
    legalName: formData.get("legalName") ?? "",
    companyNumber: formData.get("companyNumber") ?? "",
    phone: formData.get("phone") ?? "",
    whatsapp: formData.get("whatsapp") ?? "",
    email: formData.get("email") ?? "",
    line1: formData.get("line1") ?? "",
    line2: formData.get("line2") ?? "",
    town: formData.get("town") ?? "",
    postcode: formData.get("postcode") ?? "",
    googleMapsUrl: formData.get("googleMapsUrl") ?? "",
  });
  if (!parsed.success) redirect("/app/settings?error=invalid");
  const phone = parsed.data.phone ? toE164UK(parsed.data.phone, { allowLandline: true }) : null;
  const whatsapp = parsed.data.whatsapp ? toE164UK(parsed.data.whatsapp) : null;
  if ((parsed.data.phone && !phone) || (parsed.data.whatsapp && !whatsapp)) redirect("/app/settings?error=phone");

  const address = Object.fromEntries(
    Object.entries({ line1: parsed.data.line1, line2: parsed.data.line2, town: parsed.data.town, postcode: parsed.data.postcode }).filter(([, value]) => value),
  );

  const { data: updated, error: garageError } = await client.from("garages").update({
    name: parsed.data.name,
    legal_name: parsed.data.legalName,
    company_number: parsed.data.companyNumber,
    phone,
    whatsapp,
    email: parsed.data.email || null,
    address,
  }).eq("id", auth.garage.id).select("id").maybeSingle();
  if (garageError || !updated) redirect("/app/settings?error=save_failed");

  const { error: settingsError } = await client.from("site_settings").upsert(
    { garage_id: auth.garage.id, value: { googleMapsUrl: parsed.data.googleMapsUrl || "" }, updated_by: auth.user.id },
    { onConflict: "garage_id" },
  );
  if (settingsError) redirect("/app/settings?error=save_failed");
  await audit(auth, "update", "garage_settings", auth.garage.id);
  revalidatePath("/app", "layout");
  revalidatePath("/_site/[garageId]", "layout");
  redirect("/app/settings?saved=1");
}
